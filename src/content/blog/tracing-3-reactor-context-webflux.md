---
title: 'Tracing 이해하기 (3) – Reactor Context와 비동기 환경'
description: '서론 이전 글에서 ThreadLocal과 MDC가 어떻게 Tracing Context를 저장하고 전파하는지 살펴봤습니다. 동기 환경에서는 “한 요청 = 한 스레드”라는 단순한 모델 덕분에 ThreadLocal만으로도 충분했습니다. 하지만 Spring WebFlux로 넘어오면 상황이 완전히 달라집니다. WebFlux는 소수의 스레드가 수천 개의 요청을 동시에 처리하는 Event Loop 모델을 사용합니다. 하나의 요청이 처리되는 동안 스레드가 수시로 바뀔 수 있죠. 이 환경에서 ThreadLocal은 더 …'
pubDate: '2026-02-08'
updatedDate: '2026-02-19'
category: tech
tags: ['context-propagation', 'micrometer', 'reactor', 'tracing']
---

> **Tracing 시리즈**
> 
> 1.  [Observability의 역사부터 Spring 생태계까지 (feat. OTel)](/tracing-1-observability-spring-otel/)
> 2.  [ThreadLocal과 MDC의 이해](/tracing-2-threadlocal-mdc/)
> 3.  **[Reactor Context와 비동기 환경](/tracing-3-reactor-context-webflux/) ← 현재 글**
> 4.  [Kotlin Coroutine과 Context Propagation](/tracing-4-kotlin-coroutine-context-propagation/)
> 5.  [Java Agent vs Library Instrumentation](/tracing-5-java-agent-vs-library-instrumentation/)

## 서론

[이전 글](/tracing-2-threadlocal-mdc/)에서 ThreadLocal과 MDC가 어떻게 Tracing Context를 저장하고 전파하는지 살펴봤습니다. 동기 환경에서는 “한 요청 = 한 스레드”라는 단순한 모델 덕분에 ThreadLocal만으로도 충분했습니다.

하지만 **Spring WebFlux**로 넘어오면 상황이 완전히 달라집니다. WebFlux는 소수의 스레드가 수천 개의 요청을 동시에 처리하는 **Event Loop** 모델을 사용합니다. 하나의 요청이 처리되는 동안 스레드가 수시로 바뀔 수 있죠. 이 환경에서 ThreadLocal은 더 이상 신뢰할 수 없습니다.

그렇다면 WebFlux에서는 traceId를 어떻게 유지할까요? 이번 글에서는 **Reactor Context**가 이 문제를 어떻게 해결하는지, 그리고 Spring Boot 3에서 이를 어떻게 활용하는지 깊이 있게 살펴보겠습니다.

## MVC vs WebFlux: 스레딩 모델의 근본적 차이

### Spring MVC: Thread-per-Request

Spring MVC는 **Thread-per-Request** 모델을 사용합니다. 요청이 들어오면 스레드 풀에서 스레드 하나를 할당받고, 응답이 완료될 때까지 그 스레드가 요청을 전담합니다.

```
sequenceDiagram
    participant R as 요청
    participant T as Thread-1
    participant DB as Database
    
    R->>T: 요청 도착
    Note over T: 스레드 할당
    T->>DB: DB 쿼리 실행
    Note over T: ⏳ Blocking 대기<br/>(스레드가 아무것도 못 함)
    DB-->>T: 결과 반환
    Note over T: 처리 계속
    T->>R: 응답 반환
    Note over T: 스레드 반납
```

이 모델의 특징은 명확합니다:

-   요청당 스레드 하나가 **처음부터 끝까지** 담당
-   DB나 외부 API 호출 시 스레드가 **blocking 상태로 대기**
-   동시 요청 수 = 스레드 풀 크기에 제한됨 (보통 200개)

ThreadLocal이 완벽하게 동작하는 이유가 바로 이것입니다. 스레드가 바뀌지 않으니까요.

### Spring WebFlux: Event Loop

WebFlux는 완전히 다른 접근 방식을 취합니다. **Event Loop** 모델에서는 소수의 스레드(보통 CPU 코어 수)가 수천 개의 요청을 **비동기적으로** 처리합니다.

```
sequenceDiagram
    participant R1 as 요청 1
    participant R2 as 요청 2
    participant W as Worker Thread<br/>(단 1개)
    participant DB as Database
    
    R1->>W: 요청 1 도착
    W->>DB: DB 쿼리 (non-blocking)
    Note over W: 대기 안 함!<br/>바로 다른 작업 처리
    
    R2->>W: 요청 2 도착
    W->>DB: DB 쿼리 (non-blocking)
    
    DB-->>W: 요청 1 결과
    W->>R1: 응답 1
    
    DB-->>W: 요청 2 결과
    W->>R2: 응답 2
```

핵심 차이점:

| 특성 | Spring MVC | Spring WebFlux |
| --- | --- | --- |
| 스레드 모델 | Thread-per-Request | Event Loop |
| 기본 스레드 수 | ~200개 | CPU 코어 수 (4~8개) |
| I/O 대기 방식 | Blocking (스레드 점유) | Non-blocking (콜백) |
| 동시 처리 용량 | 스레드 풀 크기에 제한 | 수만 연결 가능 |
| 스레드 전환 | 거의 없음 | **수시로 발생** |

> **🤔 왜 WebFlux가 더 적은 스레드로 더 많은 요청을 처리할 수 있나요?**
> 
> 핵심은 **“대기 시간의 활용”**입니다. MVC에서 DB 응답을 기다리는 동안 스레드는 아무것도 못 하고 멈춰있습니다. 반면 WebFlux에서는 DB 호출을 시작한 후 “응답 오면 알려줘”라고 콜백을 등록하고, 스레드는 즉시 **다른 요청을 처리**하러 갑니다. 응답이 도착하면 그때 다시 처리를 이어갑니다.

### WebFlux에서 ThreadLocal이 실패하는 이유

문제를 코드로 확인해보겠습니다:

```php
@RestController
public class OrderController {
    
    private static final ThreadLocal<String> traceId = new ThreadLocal<>();
    
    @GetMapping("/order/{id}")
    public Mono<Order> getOrder(@PathVariable String id) {
        // 1. 요청 시작 - reactor-http-nio-1 스레드
        traceId.set(generateTraceId());
        log.info("[{}] 주문 조회 시작", traceId.get());  // ✅ 정상 출력
        
        return orderRepository.findById(id)  // Non-blocking DB 호출
            .map(order -> {
                // 2. DB 응답 후 - reactor-http-nio-3 스레드 (다른 스레드!)
                log.info("[{}] 주문 조회 완료", traceId.get());  // ❌ null!
                return order;
            });
    }
}
```

실행 결과:

```javascript
[abc123] 주문 조회 시작        // reactor-http-nio-1
[null] 주문 조회 완료          // reactor-http-nio-3 (ThreadLocal 값 없음!)
```

**스레드가 바뀌면 ThreadLocal 값은 사라집니다.** 이것이 WebFlux에서 ThreadLocal을 직접 사용할 수 없는 근본적인 이유입니다.

```
sequenceDiagram
    participant C as Client
    participant T1 as Thread-1
    participant T2 as Thread-2
    participant DB as Database
    
    C->>T1: GET /order/123
    Note over T1: ThreadLocal.set("abc123")
    T1->>DB: findById(123) [non-blocking]
    Note over T1: 스레드 반납 (다른 요청 처리)
    
    DB-->>T2: 결과 반환
    Note over T2: ThreadLocal.get() = null ❌
    T2->>C: 응답
```

## Reactor Context: 리액티브 세계의 ThreadLocal

### Context란 무엇인가

Project Reactor는 이 문제를 해결하기 위해 **Context**라는 개념을 도입했습니다. Context는 쉽게 말해 **Subscriber에 붙어있는 불변(immutable) Map**입니다.

```javascript
// ThreadLocal 방식 (❌ WebFlux에서 실패)
ThreadLocal<String> traceId = new ThreadLocal<>();
traceId.set("abc123");
String value = traceId.get();

// Reactor Context 방식 (✅ WebFlux에서 동작)
Mono.just("data")
    .contextWrite(ctx -> ctx.put("traceId", "abc123"))  // Context에 저장
    .flatMap(data -> 
        Mono.deferContextual(ctx -> {                    // Context에서 읽기
            String traceId = ctx.get("traceId");
            return Mono.just(data + " with " + traceId);
        })
    );
```

핵심 차이점:

| 특성 | ThreadLocal | Reactor Context |
| --- | --- | --- |
| 바인딩 대상 | Thread | Subscriber |
| 스레드 전환 시 | 값 유실 | **값 유지** ✅ |
| 데이터 구조 | 가변 (mutable) | 불변 (immutable) |
| 전파 방향 | 없음 | Bottom → Top (아래에서 위로) |

### Context의 전파 방향: Bottom-Up

Reactor Context에서 가장 중요하면서도 헷갈리는 개념이 **전파 방향**입니다. Context는 **아래에서 위로** 전파됩니다.

```javascript
Mono.deferContextual(ctx -> {
        // 3. 여기서 읽으면? → "World" (가장 가까운 contextWrite)
        log.info("message = {}", ctx.get("message"));
        return Mono.just("result");
    })
    .contextWrite(ctx -> ctx.put("message", "World"))   // 2. 두 번째 write
    .contextWrite(ctx -> ctx.put("message", "Hello"))   // 1. 첫 번째 write
    .subscribe();
```

출력: `message = World`

왜 “Hello”가 아니라 “World”일까요?

```
flowchart TB
    subgraph " "
        A["deferContextual (읽기)"]
        B["contextWrite('World')"]
        C["contextWrite('Hello')"]
        D["subscribe()"]
    end
    
    subgraph "Context 전파 방향 (아래→위)"
        D2["subscribe()"] -->|"Context 시작"| C2["contextWrite('Hello')"]
        C2 -->|"message=Hello"| B2["contextWrite('World')"]
        B2 -->|"message=World (덮어씀)"| A2["deferContextual"]
    end
    
    A --- A2
    B --- B2
    C --- C2
    D --- D2
```

**규칙**: `subscribe()`에서 시작해서 위로 올라가며, 각 `contextWrite`가 Context를 수정합니다. 읽기 연산자(`deferContextual`)는 자신의 **바로 아래에 있는** `contextWrite`의 값을 봅니다.

> **🤔 왜 이렇게 설계했나요?**
> 
> Reactive Streams의 구독(subscription) 흐름과 일치시키기 위해서입니다. `subscribe()`를 호출하면 구독 신호가 **아래에서 위로** 전파됩니다. Context도 이 흐름을 따라 함께 전파되므로, 스레드가 아무리 바뀌어도 Subscriber와 함께 Context가 유지됩니다.

### Context 읽기/쓰기 API

**쓰기: `contextWrite()`**

```javascript
// 방법 1: Function으로 수정
.contextWrite(ctx -> ctx.put("key", "value"))

// 방법 2: ContextView 병합
.contextWrite(Context.of("key1", "value1", "key2", "value2"))
```

**읽기: `deferContextual()` 또는 `transformDeferredContextual()`**

```javascript
// 방법 1: Mono.deferContextual (가장 일반적)
Mono.deferContextual(ctx -> {
    String traceId = ctx.get("traceId");
    return someAsyncOperation(traceId);
});

// 방법 2: Flux.deferContextual
Flux.deferContextual(ctx -> {
    return Flux.fromIterable(getItems(ctx.get("userId")));
});

// 방법 3: transformDeferredContextual (체인 중간에서)
flux.transformDeferredContextual((original, ctx) -> {
    String prefix = ctx.get("prefix");
    return original.map(item -> prefix + item);
});
```

### 실전 예제: WebFlux에서 traceId 전파

```php
@RestController
@RequiredArgsConstructor
public class OrderController {
    
    private final OrderRepository orderRepository;
    private final PaymentClient paymentClient;
    
    @GetMapping("/order/{id}")
    public Mono<OrderResponse> getOrder(@PathVariable String id) {
        String traceId = generateTraceId();
        
        return orderRepository.findById(id)
            .flatMap(order -> paymentClient.getPaymentStatus(order.getPaymentId())
                .map(payment -> new OrderResponse(order, payment))
            )
            .transformDeferredContextual((mono, ctx) -> 
                mono.doOnNext(response -> 
                    log.info("[{}] 주문 조회 완료: {}", ctx.get("traceId"), response)
                )
            )
            .contextWrite(ctx -> ctx.put("traceId", traceId));  // 맨 아래에서 Context 설정
    }
}
```

이제 스레드가 아무리 바뀌어도 traceId가 유지됩니다!

## Reactor Context 내부 동작 원리

입문자 수준을 넘어, Context가 **어떻게** 스레드 전환에도 살아남는지 내부를 들여다보겠습니다.

### Subscriber 체인과 Context

Reactor에서 연산자를 체이닝하면 내부적으로 **Subscriber 체인**이 만들어집니다. 각 연산자는 자신만의 Subscriber를 생성하고, 이 Subscriber들이 서로 연결됩니다.

```php
Flux.just(1, 2, 3)           // FluxArray
    .map(i -> i * 2)          // FluxMap (내부에 MapSubscriber)
    .filter(i -> i > 2)       // FluxFilter (내부에 FilterSubscriber)
    .subscribe(System.out::println);  // LambdaSubscriber
```

> **🤔 FluxMap, FluxFilter는 뭔가요?**
> 
> Reactor에서 **연산자를 호출할 때마다 새로운 Publisher가 생성**됩니다. `.map()`을 호출하면 원본 Flux를 감싸는 `FluxMap`이 만들어지고, `.filter()`를 호출하면 그걸 또 감싸는 `FluxFilter`가 만들어집니다.
> 
> ```
> FluxFilter ─감싸고 있음→ FluxMap ─감싸고 있음→ FluxArray
> ```
> 
> 그리고 `subscribe()`를 호출하면, 이 Publisher들이 각각 자신의 Subscriber를 생성합니다. Subscriber 체인은 **구독 시점에** 만들어지며, 데이터 흐름과 **반대 방향**으로 연결됩니다.

내부 구조:

```
flowchart TB
    subgraph CODE["코드 작성 순서"]
        C1["Flux.just(1,2,3)"]
        C2[".map(i -> i * 2)"]
        C3[".filter(i -> i > 2)"]
        C4[".subscribe(println)"]
    end
    
    subgraph PUB["생성되는 Publisher 구조"]
        P1["FluxArray [1,2,3]"]
        P2["FluxMap"]
        P3["FluxFilter"]
    end
    
    C1 --> C2 --> C3 --> C4
    P3 -->|"source"| P2 -->|"source"| P1
    
    CODE ~~~ PUB
```

```
sequenceDiagram
    participant USER as .subscribe(println)
    participant P3 as FluxFilter
    participant P2 as FluxMap
    participant P1 as FluxArray
    
    Note over USER: subscribe() 호출
    USER->>P3: ① LambdaSubscriber로 구독
    P3->>P2: ② FilterSubscriber 생성 후 구독
    P2->>P1: ③ MapSubscriber 생성 후 구독
    
    Note over P1,USER: 이제 데이터가 흐르기 시작
    P1-->>P2: onNext(1)
    P2-->>P3: onNext(2)
    P3-->>USER: onNext(2) → println
```

**핵심**: `subscribe()`를 호출하면 Subscriber가 **순차적으로 생성**되면서 체인이 구성됩니다. `LambdaSubscriber`가 가장 먼저 만들어지고, 그 다음 `FilterSubscriber`, `MapSubscriber` 순서로 만들어집니다.

### CoreSubscriber와 currentContext()

Reactor의 모든 Subscriber는 `CoreSubscriber` 인터페이스를 구현합니다. 이 인터페이스에 Context 관련 메서드가 있습니다:

```php
public interface CoreSubscriber<T> extends Subscriber<T> {
    
    // 현재 Subscriber의 Context 반환
    default Context currentContext() {
        return Context.empty();
    }
}
```

연산자의 Subscriber 구현을 보면:

```php
// FluxMap 내부의 MapSubscriber (간략화)
class MapSubscriber<T, R> implements CoreSubscriber<T> {
    
    final CoreSubscriber<? super R> actual;  // 다음 Subscriber (downstream)
    final Function<T, R> mapper;
    
    @Override
    public Context currentContext() {
        // downstream Subscriber의 Context를 그대로 반환
        return actual.currentContext();
    }
    
    @Override
    public void onNext(T t) {
        R result = mapper.apply(t);
        actual.onNext(result);  // 결과를 downstream으로 전달
    }
}
```

**Context는 Subscriber 체인을 따라 전파됩니다.** 각 Subscriber는 downstream의 Context를 참조하고, `contextWrite` 연산자만 Context를 수정합니다.

실제 코드에서 Context가 어떻게 전파되는지 봅시다:

```php
Flux.just(1, 2, 3)
    .map(i -> i * 2)
    .filter(i -> i > 2)
    .contextWrite(ctx -> ctx.put("traceId", "abc"))  // 보통 체인 맨 아래에 위치
    .subscribe(System.out::println);
```

```
flowchart BT
    subgraph TOP["Context 조회 가능 ✅"]
        S1["MapSubscriber"]
        S2["FilterSubscriber"]
    end
    
    S3["ContextWriteSubscriber<br/>🔑 Context 생성"]
    
    subgraph BOTTOM["Context 조회 불가 ❌"]
        S4["LambdaSubscriber<br/>(subscribe 람다)"]
    end
    
    S1 -->|"currentContext()"| S2
    S2 -->|"currentContext()"| S3
    S3 -->|"currentContext()"| S4
    S4 -.->|"Context.empty() 반환"| S3
    S3 -.->|"Context{traceId=abc} 반환"| S2
```

> **⚠️ 중요: subscribe 람다에서는 Context가 없습니다!**
> 
> ```javascript
> Flux.just(1, 2, 3)
>     .doOnNext(v -> {
>         // ✅ contextWrite 위 → Context 있음
>         log.info("[{}]", MDC.get("traceId"));
>     })
>     .contextWrite(ctx -> ctx.put("traceId", "abc"))
>     .subscribe(v -> {
>         // ❌ contextWrite 아래 → Context 없음!
>         log.info("[{}]", MDC.get("traceId"));  // null
>     });
> ```
> 
> `contextWrite()`는 항상 **로깅이나 Context가 필요한 연산자들보다 아래**에 배치해야 합니다.

> **🤔 왜 contextWrite가 체인 아래쪽에 있어야 하나요?**
> 
> Context는 **아래에서 위로** 전파됩니다. `currentContext()`를 호출하면 downstream(아래쪽) Subscriber에게 물어봅니다.
> 
> -   `MapSubscriber.currentContext()` → `FilterSubscriber`에게 물어봄
> -   `FilterSubscriber.currentContext()` → `ContextWriteSubscriber`에게 물어봄
> -   `ContextWriteSubscriber.currentContext()` → **여기서 Context 생성해서 반환!**
> 
> 그래서 `contextWrite()`보다 **위에 있는 연산자들만** Context를 읽을 수 있습니다. 아래에 있는 연산자들은 Context가 아직 생성되기 전이라 접근할 수 없습니다.

### Context 구현체: 최적화의 비밀

Reactor의 Context는 성능을 위해 **크기별로 다른 구현체**를 사용합니다:

| 크기 | 구현체 | 내부 구조 |
| --- | --- | --- |
| 0개 | `Context0` | 싱글톤 (INSTANCE) |
| 1개 | `Context1` | 단일 key-value 필드 |
| 2개 | `Context2` | 2쌍의 key-value 필드 |
| 3개 | `Context3` | 3쌍의 key-value 필드 |
| 4개 | `Context4` | 4쌍의 key-value 필드 |
| 5개 | `Context5` | 5쌍의 key-value 필드 |
| 6개+ | `ContextN` | `Map<Object, Object>` |

```javascript
// Context1 구현 (간략화)
final class Context1 implements CoreContext {
    final Object key;
    final Object value;
    
    @Override
    public <T> T get(Object key) {
        if (this.key.equals(key)) {
            return (T) this.value;
        }
        throw new NoSuchElementException();
    }
    
    @Override
    public Context put(Object key, Object value) {
        // 불변! 새 Context 반환
        if (this.key.equals(key)) {
            return new Context1(key, value);
        }
        return new Context2(this.key, this.value, key, value);
    }
}
```

> **🤔 왜 Map을 바로 안 쓰고 이렇게 복잡하게 했나요?**
> 
> **성능** 때문입니다. Tracing에서 주로 사용하는 키는 `traceId`, `spanId`, `baggage` 정도로 5개를 넘기 어렵습니다. 이 범위에서는 전용 필드를 사용하는 게 HashMap보다 훨씬 빠릅니다:
> 
> -   객체 할당 최소화
> -   equals() 호출 횟수 감소
> -   캐시 친화적 메모리 배치

### 스레드 전환에도 Context가 유지되는 이유

이제 핵심 질문에 답할 수 있습니다. **스레드가 바뀌어도 Context가 유지되는 이유**는 무엇일까요?

```
sequenceDiagram
    participant T1 as Thread-1
    participant T2 as Thread-2
    participant Sub as Subscriber
    participant Ctx as Context
    
    Note over Sub,Ctx: Subscriber가 Context를 참조
    
    T1->>Sub: onNext(data)
    Sub->>Ctx: currentContext()
    Ctx-->>Sub: Context{traceId=abc}
    Note over T1: 스레드 전환 발생
    
    T2->>Sub: onNext(data2)
    Sub->>Ctx: currentContext()
    Ctx-->>Sub: Context{traceId=abc}
    Note over T2: 같은 Context!
```

**답**: Context는 Thread가 아닌 **Subscriber 객체에 연결**되어 있기 때문입니다.

1.  `subscribe()` 시점에 Subscriber 체인이 생성됨
2.  각 Subscriber는 downstream Subscriber에 대한 참조를 가짐
3.  Context는 이 참조 체인을 따라 조회됨
4.  스레드가 바뀌어도 **Subscriber 객체는 동일** → Context도 동일

ThreadLocal이 “스레드에 데이터를 저장”한다면, Reactor Context는 “구독 체인에 데이터를 저장”합니다.

## Micrometer Context Propagation: 두 세계의 다리

Reactor Context는 완벽해 보이지만 한 가지 문제가 있습니다. **기존 라이브러리들은 여전히 ThreadLocal을 사용**한다는 것입니다.

-   SLF4J MDC → ThreadLocal
-   Micrometer Tracing → ThreadLocal
-   Spring Security → ThreadLocal

WebFlux에서 이들을 사용하려면 **Reactor Context ↔ ThreadLocal** 사이의 브릿지가 필요합니다. 이것이 바로 **Micrometer Context Propagation** 라이브러리입니다.

### 동작 원리

```
flowchart LR
    subgraph "Reactor 세계"
        RC["Reactor Context<br/>{traceId: 'abc123'}"]
    end
    
    subgraph "Context Propagation"
        RCA["ReactorContextAccessor"]
        TLA["ThreadLocalAccessor"]
    end
    
    subgraph "ThreadLocal 세계"
        TL["ThreadLocal<br/>MDC.get('traceId')"]
    end
    
    RC <-->|"읽기/쓰기"| RCA
    RCA <-->|"변환"| TLA
    TLA <-->|"읽기/쓰기"| TL
```

핵심 인터페이스:

```javascript
// ThreadLocal 값에 접근하는 인터페이스
public interface ThreadLocalAccessor<V> {
    Object key();                    // Context에서 사용할 키
    V getValue();                    // ThreadLocal에서 값 읽기
    void setValue(V value);          // ThreadLocal에 값 쓰기
    void setValue();                 // ThreadLocal 값 제거 (null로)
}

// Reactor Context 등 Map 형태 컨텍스트에 접근하는 인터페이스
public interface ContextAccessor<READ, WRITE> {
    Class<? extends READ> readableType();
    Class<? extends WRITE> writeableType();
    V readValue(READ container, Object key);
    WRITE writeValues(Map<Object, Object> values, WRITE container);
}
```

Micrometer는 `ObservationThreadLocalAccessor`를 제공하고, Reactor는 `ReactorContextAccessor`를 제공합니다. 이 둘이 협력하여 Context를 양방향으로 전파합니다.

### 두 가지 모드: Default vs Automatic

Reactor Core 3.5.0부터 Context Propagation을 지원하며, 두 가지 모드가 있습니다:

**1\. Default 모드 (제한적 복원)**

특정 연산자(`handle`, `tap`)에서만 ThreadLocal을 복원합니다:

```javascript
flux.handle((item, sink) -> {
    // 이 블록 안에서만 ThreadLocal 복원됨
    log.info("traceId = {}", MDC.get("traceId"));  // ✅ 동작
    sink.next(transform(item));
});
```

**2\. Automatic 모드 (전체 복원)**

모든 연산자에서 ThreadLocal을 자동 복원합니다:

```javascript
// 애플리케이션 시작 시 활성화
Hooks.enableAutomaticContextPropagation();

flux.map(item -> {
    // 모든 연산자에서 ThreadLocal 복원됨!
    log.info("traceId = {}", MDC.get("traceId"));  // ✅ 동작
    return transform(item);
});
```

> **🤔 Automatic 모드가 좋아 보이는데, 왜 Default가 기본값인가요?**
> 
> **성능 때문**입니다. Automatic 모드는 **모든 연산자 실행 전후에** ThreadLocal을 저장/복원합니다. 이 오버헤드가 무시할 수 없는 수준일 수 있습니다.
> 
> 공식 문서에서도 “최고의 확장성과 성능이 목표라면 ThreadLocal에 의존하지 않는 명시적 방식을 고려하라”고 권장합니다. Automatic 모드는 기존 코드 마이그레이션이나 편의성이 우선일 때 사용합니다.

### contextCapture()의 역할

`contextCapture()`는 **현재 스레드의 ThreadLocal 값들을 Reactor Context로 캡처**합니다:

```javascript
// ThreadLocal에 값이 있는 상태에서
MDC.put("traceId", "abc123");

Mono.just("data")
    .contextCapture()  // 현재 ThreadLocal 값들을 Context로 캡처
    .flatMap(data -> someAsyncOperation())
    .subscribe();
```

주로 **명령형 코드에서 리액티브 체인을 시작할 때** 사용합니다:

```php
@GetMapping("/order")
public Mono<Order> createOrder(@RequestBody OrderRequest request) {
    // Controller에서 ThreadLocal에 traceId가 설정된 상태
    
    return orderService.createOrder(request)
        .contextCapture();  // ThreadLocal → Reactor Context
}
```

> **⚠️ subscribe() vs block()의 차이**
> 
> ```javascript
> // block() - 현재 스레드에서 완료까지 대기
> Order result = orderService.createOrder(request)
>     .contextCapture()
>     .block();  // 같은 스레드에서 실행, Context 자연스럽게 유지
> 
> // subscribe() - 다른 스레드에서 비동기 실행
> orderService.createOrder(request)
>     .contextCapture()  // 필수! 없으면 Context 유실
>     .subscribe(result -> log.info("완료"));
> ```
> 
> `block()`은 현재 스레드를 점유하므로 Context 문제가 덜하지만, `subscribe()`는 다른 스레드에서 실행될 수 있어 `contextCapture()`가 중요합니다.
> 
> **🚨 중요**: WebFlux에서 `block()`을 사용하면 **Event Loop 스레드를 blocking**하게 됩니다. WebFlux의 핵심 장점은 소수의 스레드(보통 4~8개)로 수천 개의 요청을 처리하는 것인데, 이 스레드가 blocking되면 전체 처리량이 급격히 떨어집니다. 사실상 **WebFlux를 쓰는 의미가 없어지는 것**이죠.
> 
> ```javascript
> // ❌ 절대 금지: Event Loop 스레드에서 block()
> @GetMapping("/order/{id}")
> public Mono<Order> getOrder(@PathVariable String id) {
>     Order order = orderRepository.findById(id).block();  // Event Loop 스레드 blocking!
>     return Mono.just(order);
> }
> 
> // ✅ 올바른 방식: 리액티브 체인 유지
> @GetMapping("/order/{id}")
> public Mono<Order> getOrder(@PathVariable String id) {
>     return orderRepository.findById(id);  // Non-blocking
> }
> ```
> 
> `block()`은 테스트 코드나 명령형 코드에서 리액티브 체인을 마무리할 때만 사용하세요.

## Spring Boot 3 + WebFlux 실전 설정

이론은 충분합니다. 이제 실제로 Spring Boot 3에서 WebFlux + Tracing을 설정해보겠습니다.

### 의존성 설정

```xml
<!-- pom.xml -->
<dependencies>
    <!-- WebFlux -->
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-webflux</artifactId>
    </dependency>
    
    <!-- Actuator (Observability 자동 설정) -->
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-actuator</artifactId>
    </dependency>
    
    <!-- Micrometer Tracing + OpenTelemetry Bridge -->
    <dependency>
        <groupId>io.micrometer</groupId>
        <artifactId>micrometer-tracing-bridge-otel</artifactId>
    </dependency>
    
    <!-- OpenTelemetry OTLP Exporter (표준 프로토콜) -->
    <dependency>
        <groupId>io.opentelemetry</groupId>
        <artifactId>opentelemetry-exporter-otlp</artifactId>
    </dependency>
    
    <!-- Context Propagation (자동으로 포함되지만 명시적으로) -->
    <dependency>
        <groupId>io.micrometer</groupId>
        <artifactId>context-propagation</artifactId>
    </dependency>
</dependencies>
```

> **🤔 왜 OTLP Exporter인가요?**
> 
> OTLP(OpenTelemetry Protocol)는 OpenTelemetry의 **표준 전송 프로토콜**입니다. 예전에는 Zipkin, Jaeger 등 백엔드별로 다른 exporter를 사용했지만, 이제는 OTLP 하나로 통일되는 추세입니다.
> 
> -   **Jaeger**: OTLP 네이티브 지원 (4317/4318 포트)
> -   **Zipkin**: OTLP Collector를 통해 연동
> -   **Grafana Tempo**: OTLP 네이티브 지원
> -   **AWS X-Ray, Datadog 등**: OTLP Collector로 연동
> 
> OTLP를 사용하면 백엔드를 바꿔도 애플리케이션 코드를 수정할 필요가 없습니다.

### application.yml 설정

```php
# application.yml
spring:
  application:
    name: order-service

  # 🔑 핵심 설정: Automatic Context Propagation 활성화
  reactor:
    context-propagation: auto   # Spring Boot 3.2+

management:
  tracing:
    sampling:
      probability: 1.0  # 개발 환경에서는 100% 샘플링
    propagation:
      type: w3c         # W3C Trace Context 사용
    baggage:
      enabled: true
      correlation:
        enabled: true
        fields:
          - user-id
          - tenant-id

  # OTLP Exporter 설정 (Jaeger, Tempo, Collector 등으로 전송)
  otlp:
    tracing:
      endpoint: http://localhost:4318/v1/traces  # OTLP HTTP 엔드포인트
    metrics:
      export:
        enabled: true
        endpoint: http://localhost:4318/v1/metrics

logging:
  pattern:
    console: "%d{HH:mm:ss.SSS} [%X{traceId:-},%X{spanId:-}] [%thread] %-5level %logger{36} - %msg%n"
```

> **🤔 OTLP 포트 번호**
> 
> -   **4317**: gRPC 프로토콜
> -   **4318**: HTTP 프로토콜 (Spring Boot 기본)
> 
> 대부분의 OTLP 수신기(Jaeger, Tempo, OTel Collector)는 두 포트를 모두 지원합니다. Spring Boot는 기본적으로 HTTP를 사용하므로 4318 포트에 `/v1/traces` 경로를 붙입니다.

> **🤔 `spring.reactor.context-propagation=auto`가 하는 일**
> 
> Spring Boot 3.2에서 추가된 이 설정은 내부적으로 `Hooks.enableAutomaticContextPropagation()`을 호출합니다. 이전 버전에서는 직접 호출해야 했습니다:
> 
> ```php
> // Spring Boot 3.1 이하
> @SpringBootApplication
> public class MyApplication {
>     public static void main(String[] args) {
>         Hooks.enableAutomaticContextPropagation();  // 직접 호출
>         SpringApplication.run(MyApplication.class, args);
>     }
> }
> ```

### logback-spring.xml 설정

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
    <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
        <encoder>
            <pattern>%d{HH:mm:ss.SSS} [%X{traceId:-},%X{spanId:-}] [%thread] %-5level %logger{36} - %msg%n</pattern>
        </encoder>
    </appender>
    
    <root level="INFO">
        <appender-ref ref="CONSOLE"/>
    </root>
</configuration>
```

### 실제 코드 예시

```php
@RestController
@RequiredArgsConstructor
@Slf4j
public class OrderController {
    
    private final OrderRepository orderRepository;
    private final InventoryClient inventoryClient;
    private final PaymentClient paymentClient;
    
    @PostMapping("/orders")
    public Mono<OrderResponse> createOrder(@RequestBody OrderRequest request) {
        log.info("주문 생성 시작: {}", request.getProductId());
        
        return orderRepository.save(new Order(request))
            .flatMap(order -> {
                log.info("주문 저장 완료: {}", order.getId());
                
                // 병렬로 재고 차감 + 결제 처리
                return Mono.zip(
                    inventoryClient.decreaseStock(order.getProductId(), order.getQuantity())
                        .doOnSuccess(v -> log.info("재고 차감 완료")),
                    paymentClient.processPayment(order.getId(), order.getTotalAmount())
                        .doOnSuccess(v -> log.info("결제 처리 완료"))
                ).map(tuple -> new OrderResponse(order, tuple.getT1(), tuple.getT2()));
            })
            .doOnSuccess(response -> log.info("주문 생성 완료: {}", response.getOrderId()))
            .doOnError(e -> log.error("주문 생성 실패", e));
    }
}
```

출력 예시:

```css
14:23:45.123 [abc123def456,111aaa] [reactor-http-nio-1] INFO  c.e.OrderController - 주문 생성 시작: PROD-001
14:23:45.234 [abc123def456,222bbb] [reactor-http-nio-2] INFO  c.e.OrderController - 주문 저장 완료: ORD-123
14:23:45.345 [abc123def456,333ccc] [reactor-http-nio-3] INFO  c.e.OrderController - 재고 차감 완료
14:23:45.345 [abc123def456,444ddd] [reactor-http-nio-4] INFO  c.e.OrderController - 결제 처리 완료
14:23:45.456 [abc123def456,222bbb] [reactor-http-nio-2] INFO  c.e.OrderController - 주문 생성 완료: ORD-123
```

**스레드가 계속 바뀌지만 traceId(`abc123def456`)는 일관되게 유지**됩니다!

## 주의사항 및 트러블슈팅

### 1\. Context가 비어있는 경우

**증상**: `MDC.get("traceId")`가 null 반환

**원인과 해결**:

```javascript
// ❌ 문제: 리액티브 체인 밖에서 subscribe
new Thread(() -> {
    orderService.createOrder(request)
        .subscribe();  // 새 스레드에서 구독 → Context 없음
}).start();

// ✅ 해결: contextCapture() 사용
new Thread(() -> {
    orderService.createOrder(request)
        .contextCapture()
        .subscribe();
}).start();
```

### 2\. flatMap 내부에서 Context 유실

**증상**: `flatMap` 안에서 새로운 Publisher를 생성할 때 Context 유실

```javascript
// ❌ 문제: 외부 Publisher 직접 사용
.flatMap(data -> externalLibrary.getData())  // 외부 라이브러리가 Context 미지원

// ✅ 해결: Mono.defer + contextCapture
.flatMap(data -> Mono.defer(() -> externalLibrary.getData()).contextCapture())
```

### 3\. 성능 고려사항

Automatic Context Propagation은 편리하지만 성능 비용이 있습니다:

```json
// 모든 연산자에서 이런 일이 발생
// 1. 연산자 실행 전: Context → ThreadLocal 복원
// 2. 사용자 코드 실행
// 3. 연산자 실행 후: ThreadLocal → 이전 상태 복원
```

**Default 모드 + handle()/tap() 사용 예시**:

Automatic 모드 대신 Default 모드에서 `handle()`이나 `tap()`을 사용하면 **필요한 곳에서만** ThreadLocal을 복원할 수 있습니다. 두 연산자는 **각각 독립적으로** ThreadLocal을 복원합니다.

| 연산자 | 역할 | 데이터 변환 |
| --- | --- | --- |
| `handle()` | 변환 + 필터링 + 로깅 | ✅ `sink.next()`로 변환/필터 가능 |
| `tap()` | 사이드 이펙트만 (로깅, 메트릭) | ❌ 데이터 그대로 통과 |

```php
// Default 모드 (spring.reactor.context-propagation 설정 없음)

@GetMapping("/orders")
public Flux<Order> getOrders() {
    return orderRepository.findAll()
        // handle(): 변환 + 필터링 + 로깅이 모두 필요할 때
        .handle((order, sink) -> {
            // ✅ 이 블록 안에서 ThreadLocal 복원됨
            log.info("[{}] 주문 검증: {}", MDC.get("traceId"), order.getId());
            
            if (order.isValid()) {
                sink.next(order);  // 유효한 주문만 통과
            }
            // sink.next()를 호출하지 않으면 필터링됨
        })
        // tap(): 로깅만 하고 데이터는 그대로 통과시킬 때
        .tap(signal -> {
            if (signal.isOnNext()) {
                // ✅ 이 블록 안에서 ThreadLocal 복원됨
                Order order = (Order) signal.get();
                log.info("[{}] 주문 통과: {}", MDC.get("traceId"), order.getId());
            }
        })
        .doOnNext(order -> {
            // ❌ 여기서는 ThreadLocal 복원 안 됨! (Default 모드에서)
            log.info("처리 완료: {}", order.getId());  // traceId 없음
        });
}
```

> **🤔 sink와 signal은 뭔가요?**
> 
> | 매개변수 | 타입 | 역할 |
> | --- | --- | --- |
> | `sink` | `SynchronousSink<T>` | 데이터를 다음 연산자로 **내보내는** 출구 |
> | `signal` | `Signal<T>` | 현재 발생한 이벤트를 **읽는** 정보 객체 |
> 
> **sink** (handle에서 사용):
> 
> ```php
> sink.next(value);         // 값을 다음 연산자로 전달
> sink.error(exception);    // 에러 발생
> // sink.next()를 안 부르면 → 해당 항목 필터링
> ```
> 
> **signal** (tap에서 사용):
> 
> ```javascript
> signal.isOnNext()         // 데이터가 흘러왔는지 확인
> signal.isOnError()        // 에러가 발생했는지 확인
> signal.isOnComplete()     // 스트림이 완료됐는지 확인
> signal.get()              // onNext인 경우 실제 값 가져오기
> signal.getThrowable()     // onError인 경우 예외 가져오기
> ```

> **🤔 handle() vs tap() 언제 뭘 쓰나요?**
> 
> -   **handle()**: 데이터를 변환하거나 조건부로 필터링해야 할 때. `map()` + `filter()` + ThreadLocal 복원을 한번에.
> -   **tap()**: 데이터는 건드리지 않고 로깅/메트릭만 찍을 때. 데이터가 그대로 다음 연산자로 흘러감.
> 
> 둘 다 ThreadLocal을 복원하므로, 필요에 따라 선택하면 됩니다.

**권장사항**:

| 상황 | 권장 모드 | 이유 |
| --- | --- | --- |
| 일반적인 서비스 | Automatic | 편의성 우선, 성능 충분 |
| 고성능 서비스 (높은 TPS) | Default + handle()/tap() | 필요한 곳에서만 복원 |
| 마이그레이션 중 | Automatic | 빠른 전환, 이후 최적화 |
| 로깅이 적은 서비스 | Default | 오버헤드 최소화 |

### 4\. 라이브러리 내부 로깅에서 traceId 유실되는 경우 예시

**증상 예시**: 애플리케이션 코드의 로그에는 traceId가 잘 나오는데, Reactive Mongo Client, R2DBC 드라이버 등 **라이브러리의 DEBUG 로그**에서는 traceId가 비어있음

```javascript
14:23:45.123 [abc123,111aaa] INFO  c.e.OrderService - 주문 조회 시작          // ✅ 정상
14:23:45.124 [abc123,111aaa] DEBUG c.m.r.c.internal - Executing query       // ✅ 정상 (체인 안)
14:23:45.125 [,]             DEBUG c.m.r.c.internal - Socket connected      // ❌ 유실 (체인 밖)
14:23:45.126 [,]             DEBUG c.m.r.c.internal - Sending bytes         // ❌ 유실 (체인 밖)
14:23:45.234 [abc123,222bbb] INFO  c.e.OrderService - 주문 조회 완료          // ✅ 정상
```

같은 라이브러리인데 **어떤 로그는 traceId가 있고, 어떤 로그는 없는** 이유가 뭘까요?

**원인**: 라이브러리 내부 구현에 따라 **로그를 찍는 위치**가 다를 수 있기 때문입니다.

```
flowchart TB
    subgraph IN["체인 안 ✅ Context 있음"]
        A["repository.findById()"]
        B["라이브러리 연산자 내부<br/>log.debug('Executing query')"]
    end
    
    subgraph OUT["체인 밖 ❌ Context 없음"]
        C["네트워크 이벤트 핸들러<br/>log.debug('Socket connected')"]
        D["I/O 콜백<br/>log.debug('Sending bytes')"]
    end
    
    A --> B
    B -.->|"실제 I/O 작업"| C
    C --> D
    
    style B fill:#ccffcc,stroke:#00aa00
    style C fill:#ffcccc,stroke:#ff0000
    style D fill:#ffcccc,stroke:#ff0000
```

라이브러리 내부에서 로그를 찍을 때:

1.  리액티브 체인의 연산자가 아닌 **별도의 콜백이나 이벤트 핸들러**에서 실행
2.  해당 시점에는 Reactor Context와 연결되어 있지 않음
3.  Automatic Context Propagation도 **리액티브 연산자 경계에서만** 동작

**해결 방법**:

1.  **라이브러리 로그 레벨 조정** (임시 방편) `logging: level: com.mongodb.reactivestreams: WARN io.r2dbc: WARN`
2.  **Java Agent 사용** (근본적 해결) OpenTelemetry Java Agent는 **바이트코드 조작**을 통해 라이브러리 내부까지 계측(instrumentation)합니다. 라이브러리가 Context Propagation을 인식하지 못해도, Agent가 강제로 Context를 주입해줍니다. `java -javaagent:opentelemetry-javaagent.jar \ -Dotel.service.name=order-service \ -jar myapp.jar`

> **📌 Java Agent vs Library Instrumentation**
> 
> 이 문제는 **“계측 방식의 차이”**에서 비롯됩니다. Library 방식(Micrometer, Spring Boot Auto-configuration)은 리액티브 체인 경계에서만 동작하지만, Java Agent 방식은 바이트코드 레벨에서 모든 곳에 계측을 삽입합니다.
> 
> 이 주제는 시리즈의 후속 글 **“Instrumentation 방식 비교: Java Agent vs Library의 동작 원리”**에서 자세히 다루겠습니다. Agent가 어떻게 라이브러리 내부까지 traceId를 전파하는지, 그리고 각 방식의 장단점을 비교해보겠습니다.

### 5\. 테스트 시 Context 설정

```javascript
@Test
void testWithContext() {
    StepVerifier.create(
        orderService.createOrder(request)
            .contextWrite(ctx -> ctx.put("traceId", "test-trace-id"))
    )
    .expectNextMatches(response -> response.getOrderId() != null)
    .verifyComplete();
}
```

## MVC vs WebFlux Context 전파 비교

2편(MVC)과 3편(WebFlux)의 내용을 정리하면:

| 구분 | Spring MVC | Spring WebFlux |
| --- | --- | --- |
| 스레딩 모델 | Thread-per-Request | Event Loop |
| Context 저장소 | ThreadLocal | Reactor Context |
| 스레드 전환 시 | 별도 처리 필요 (`@Async` 등) | **자동 유지** |
| MDC 연동 | 직접 동작 | Context Propagation 필요 |
| 설정 복잡도 | 낮음 | 중간 |
| 성능 오버헤드 | 낮음 | 중간 (Automatic 모드) |

```
flowchart TB
    subgraph MVC["Spring MVC"]
        direction LR
        M1["ThreadLocal에<br/>직접 저장"] --> M2["스레드 유지 →<br/>자연스럽게 전파"] --> M3["@Async 사용 시<br/>별도 처리 필요"]
    end
    
    subgraph WebFlux["Spring WebFlux"]
        direction LR
        W1["Reactor Context에<br/>저장"] --> W2["Subscriber 체인<br/>따라 전파"] --> W3["Context Propagation<br/>으로 MDC 연동"]
    end
    
    MVC ~~~ WebFlux
```

## 결론

WebFlux의 Event Loop 모델에서는 ThreadLocal을 직접 사용할 수 없습니다. 대신 **Reactor Context**가 Subscriber 체인을 따라 데이터를 전파합니다.

핵심 포인트를 정리하면:

1.  **Reactor Context는 Subscriber에 바인딩**: 스레드가 바뀌어도 구독 체인은 유지되므로 Context도 유지됩니다.
2.  **Bottom-Up 전파**: Context는 `subscribe()`에서 시작해 위로 전파됩니다. `contextWrite()`는 항상 체인의 아래쪽에 배치하세요.
3.  **Context Propagation으로 브릿지**: MDC 등 ThreadLocal 기반 라이브러리와 연동하려면 Micrometer Context Propagation을 사용합니다.
4.  **Spring Boot 3.2+는 간단**: `spring.reactor.context-propagation=auto` 한 줄로 자동 설정됩니다.

다음 글에서는 **Kotlin Coroutine**에서의 Context Propagation을 다룹니다. `CoroutineContext`와 Reactor Context, ThreadLocal이 어떻게 협력하는지 살펴보겠습니다.

## 참고 자료

-   [Context Propagation with Project Reactor 1 – The Basics](https://spring.io/blog/2023/03/28/context-propagation-with-project-reactor-1-the-basics/)
-   [Context Propagation with Project Reactor 2 – The bumpy road of Spring Cloud Sleuth](https://spring.io/blog/2023/03/29/context-propagation-with-project-reactor-2-the-bumpy-road-of-spring-cloud/)
-   [Context Propagation with Project Reactor 3 – Unified Bridging](https://spring.io/blog/2023/03/30/context-propagation-with-project-reactor-3-unified-bridging-between-reactive/)
-   [Reactor Core Reference – Adding a Context to a Reactive Sequence](https://projectreactor.io/docs/core/release/reference/advancedFeatures/context.html)
-   [Reactor Core Reference – Context-Propagation Support](https://projectreactor.io/docs/core/release/reference/advanced-contextPropagation.html)
-   [Micrometer Context Propagation Documentation](https://docs.micrometer.io/context-propagation/reference/)
-   [Spring Boot 3.2 Release Notes](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-3.2-Release-Notes)

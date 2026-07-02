---
title: 'Tracing 이해하기 (5) – Java Agent vs Library Instrumentation'
description: '들어가며 3편에서 잠깐 언급했던 문제가 있습니다. 라이브러리 내부 로그에는 traceId가 없다는 것이었죠. Reactive Mongo Client, R2DBC 드라이버, Netty 같은 라이브러리의 DEBUG 로그에서 이런 현상이 발생합니다. 왜 이런 일이 발생할까요? 우리가 4편까지 설정한 Library Instrumentation 방식은 우리 애플리케이션 코드와 Spring이 지원하는 컴포넌트만 계측(instrument)합니다. 라이브러리가 자체적으로 Micrometer를 지원하지 않으면, 그 내부 코드는 계측되지 않습니다. 이 문제를 해결하는 …'
pubDate: '2026-02-19'
category: tech
tags: ['byte-buddy', 'java', 'micrometer', 'opentelemetry', 'spring', 'tracing']
---

> **Tracing 시리즈**
> 
> 1.  [Observability의 역사부터 Spring 생태계까지 (feat. OTel)](/tracing-1-observability-spring-otel/)
> 2.  [ThreadLocal과 MDC의 이해](/tracing-2-threadlocal-mdc/)
> 3.  [Reactor Context와 비동기 환경](/tracing-3-reactor-context-webflux/)
> 4.  [Kotlin Coroutine과 Context Propagation](/tracing-4-kotlin-coroutine-context-propagation/)
> 5.  **[Java Agent vs Library Instrumentation](/tracing-5-java-agent-vs-library-instrumentation/) ← 현재 글**

## 들어가며

[3편](/tracing-3-reactor-context-webflux/)에서 잠깐 언급했던 문제가 있습니다. **라이브러리 내부 로그에는 traceId가 없다**는 것이었죠. Reactive Mongo Client, R2DBC 드라이버, Netty 같은 라이브러리의 DEBUG 로그에서 이런 현상이 발생합니다.

```javascript
// 우리 애플리케이션 코드 - traceId 있음 ✅
14:23:45.123 [abc123] INFO  OrderService - 주문 조회 시작

// 라이브러리 내부 로그 - traceId 없음 ❌ (가상 예시)
14:23:45.150 DEBUG io.r2dbc.postgresql - Executing query: SELECT * FROM orders
14:23:45.160 DEBUG io.netty.handler.logging - [id: 0x...] WRITE: 256B

// 다시 우리 코드 - traceId 있음 ✅
14:23:45.200 [abc123] INFO  OrderService - 주문 조회 완료
```

왜 이런 일이 발생할까요? 우리가 4편까지 설정한 **Library Instrumentation** 방식은 **우리 애플리케이션 코드**와 **Spring이 지원하는 컴포넌트**만 계측(instrument)합니다. 라이브러리가 자체적으로 Micrometer를 지원하지 않으면, 그 내부 코드는 계측되지 않습니다.

이 문제를 해결하는 방법이 **Java Agent**입니다. 이번 글에서는 두 Instrumentation 방식을 비교하고, 어떤 상황에서 어떤 방식을 선택해야 하는지 알아보겠습니다.

## 두 가지 Instrumentation 방식

Java 애플리케이션에 Tracing을 적용하는 방법은 크게 두 가지입니다.

```
flowchart TB
    subgraph "Library Instrumentation"
        L1["의존성 추가<br/>(Micrometer, Spring Boot)"]
        L2["설정 파일 작성<br/>(application.yml)"]
        L3["필요시 코드 수정<br/>(@Observed 등)"]
        L1 --> L2 --> L3
    end
    
    subgraph "Java Agent Instrumentation"
        A1["Agent JAR 다운로드"]
        A2["JVM 옵션 추가<br/>(-javaagent:...)"]
        A3["코드 수정 불필요"]
        A1 --> A2 --> A3
    end
```

| 구분 | Library Instrumentation | Java Agent Instrumentation |
| --- | --- | --- |
| **적용 방식** | 의존성 추가 + 설정 | JVM 옵션 한 줄 |
| **코드 변경** | 필요할 수 있음 | 불필요 (Zero-code) |
| **계측 범위** | 우리 코드 + 연동된 라이브러리 | 150+ 라이브러리 자동 계측 |
| **동작 원리** | 명시적 API 호출 | 바이트코드 조작 |
| **대표 도구** | Micrometer Tracing | OpenTelemetry Java Agent |

## Library Instrumentation 동작 원리

### Micrometer + Spring Boot 방식

우리가 1~4편에서 사용한 방식입니다. Spring Boot가 제공하는 **자동 설정** (Auto-configuration) 과 **Micrometer Observation API**를 활용합니다.

```javascript
// build.gradle.kts
dependencies {
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("io.micrometer:micrometer-tracing-bridge-otel")
    implementation("io.opentelemetry:opentelemetry-exporter-otlp")
}
```
```php
# application.yml
spring:
  application:
    name: order-service
management:
  tracing:
    sampling:
      probability: 1.0
  otlp:
    tracing:
      endpoint: http://localhost:4318/v1/traces
```

이 설정만으로 Spring이 **WebFilter**, **RestClient**, **WebClient** 등에 Observation을 자동으로 추가합니다.

### 명시적인 Span 생성

자동 계측 범위를 벗어나는 코드에는 직접 Span을 추가해야 합니다.

**방법 1: @Observed 어노테이션**

```javascript
@Service
class OrderService {

    @Observed(name = "order.process")  // Span 자동 생성
    fun processOrder(orderId: String): Order {
        // 비즈니스 로직
        return order
    }
}
```

**방법 2: Observation API 직접 사용**

```
@Service
class OrderService(
    private val observationRegistry: ObservationRegistry
) {
    fun processOrder(orderId: String): Order {
        return Observation.createNotStarted("order.process", observationRegistry)
            .lowCardinalityKeyValue("order.type", "standard")
            .observe {
                // 비즈니스 로직
                order
            }
    }
}
```

**방법 3: OpenTelemetry API 직접 사용**

```javascript
@Service
class OrderService {
    private val tracer = GlobalOpenTelemetry.getTracer("order-service")
    
    fun processOrder(orderId: String): Order {
        val span = tracer.spanBuilder("order.process").startSpan()
        try {
            span.makeCurrent().use {
                span.setAttribute("order.id", orderId)
                // 비즈니스 로직
                return order
            }
        } finally {
            span.end()
        }
    }
}
```

### Library Instrumentation의 한계

이 방식의 **한계점**은 명확합니다:

1.  **라이브러리 내부는 계측 불가**: Netty, HikariCP 등 라이브러리 내부 동작은 추적할 수 없습니다.
2.  **수동 작업 필요**: 커스텀 비즈니스 로직에는 직접 Span을 추가해야 합니다.
3.  **라이브러리 지원 의존**: Spring이 지원하는 라이브러리만 자동 계측됩니다.

> **💡 왜 라이브러리 내부는 계측할 수 없을까?**
> 
> 라이브러리 코드는 이미 **컴파일된 JAR** 형태입니다. 소스 코드를 수정할 수 없으니, 라이브러리가 자체적으로 Micrometer를 지원하지 않는 한 계측이 불가능합니다.

## Java Agent Instrumentation 동작 원리

### 바이트코드 조작의 마법

Java Agent는 **JVM이 클래스를 로드하는 시점**에 바이트코드를 수정합니다. 컴파일된 `.class` 파일을 메모리에서 변경하는 것이죠.

```
sequenceDiagram
    participant JVM
    participant Agent as Java Agent
    participant BB as ByteBuddy
    participant Class as 타겟 클래스
    
    JVM->>JVM: 애플리케이션 시작
    JVM->>Agent: premain() 호출
    Agent->>BB: ClassFileTransformer 등록
    
    JVM->>JVM: 클래스 로드 시도 (예: Netty)
    JVM->>Agent: transform() 호출
    Agent->>BB: 바이트코드 변환 요청
    BB->>BB: tracing 코드 주입
    BB->>Agent: 변환된 바이트코드 반환
    Agent->>JVM: 변환된 클래스 로드
    
    Note over Class: 이제 Netty 내부에도<br/>tracing 코드가 있음!
```

### premain과 Instrumentation API

Java Agent의 진입점은 `premain` 메서드입니다. JVM이 `main` 메서드를 호출하기 **전에** 실행됩니다.

```javascript
// Java Agent의 진입점 (간략화된 예시)
public class OpenTelemetryAgent {
    public static void premain(String agentArgs, Instrumentation inst) {
        // ClassFileTransformer 등록
        inst.addTransformer(new TracingTransformer());
    }
}
```

`Instrumentation`과 `ClassFileTransformer`는 **JDK 표준 API**입니다 (`java.lang.instrument` 패키지). ByteBuddy는 이 API 위에 더 편리한 추상화를 제공하는 라이브러리입니다.

```javascript
// java.lang.instrument.ClassFileTransformer (JDK 표준 인터페이스)
public interface ClassFileTransformer {
    // JVM이 클래스를 로드할 때마다 이 메서드를 호출
    byte[] transform(
        ClassLoader loader,
        String className,
        Class<?> classBeingRedefined,
        ProtectionDomain protectionDomain,
        byte[] classfileBuffer  // 원본 바이트코드
    ) throws IllegalClassFormatException;
    // 반환값: 변환된 바이트코드 (null이면 변환 없음)
}
```

**동작 순서**:

1.  JVM 시작 시 `-javaagent` 옵션으로 Agent 로드
2.  Agent의 `premain()` 호출 → `ClassFileTransformer` 등록
3.  이후 **모든 클래스 로드 시** JVM이 `transform()` 호출
4.  Agent가 필요한 클래스의 바이트코드를 수정해서 반환

실제 OpenTelemetry Java Agent는 [ByteBuddy](https://bytebuddy.net/) 라이브러리를 사용해 바이트코드를 조작합니다. ByteBuddy의 `AgentBuilder`가 내부적으로 `ClassFileTransformer`를 구현합니다.

### ByteBuddy로 메서드에 코드 주입하기

ByteBuddy의 `@Advice` 어노테이션을 사용하면 기존 메서드의 시작과 끝에 코드를 주입할 수 있습니다.

```javascript
// OpenTelemetry Agent 내부 구조 (간략화)
public class HttpClientInstrumentation {

    @Advice.OnMethodEnter
    public static Scope onEnter(@Advice.Argument(0) HttpRequest request) {
        // 메서드 시작 시 실행
        Span span = tracer.spanBuilder("HTTP " + request.method())
            .startSpan();
        span.setAttribute("http.url", request.uri().toString());

        return span.makeCurrent();
    }
    
    @Advice.OnMethodExit(onThrowable = Throwable.class)
    public static void onExit(
        @Advice.Enter Scope scope,
        @Advice.Return HttpResponse response,
        @Advice.Thrown Throwable error
    ) {
        // 메서드 종료 시 실행
        Span span = Span.current();
        if (error != null) {
            span.setStatus(StatusCode.ERROR);
            span.recordException(error);
        } else {
            span.setAttribute("http.status_code", response.statusCode());
        }
        span.end();
        scope.close();
    }
}
```

이 코드가 ByteBuddy에 의해 **대상 클래스의 바이트코드에 직접 주입**됩니다. 원본 소스 코드 수정 없이요!

> **🔗 참고 자료**
> 
> -   [OpenTelemetry Java Instrumentation GitHub](https://github.com/open-telemetry/opentelemetry-java-instrumentation)
> -   [ByteBuddy – Runtime Code Generation](https://bytebuddy.net/)
> -   [Easily Create Java Agents with Byte Buddy (InfoQ)](https://www.infoq.com/articles/Easily-Create-Java-Agents-with-ByteBuddy/)

## OpenTelemetry Java Agent 사용하기

### 설치 및 실행

```php
# 1. Agent JAR 다운로드
curl -L -O https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar

# 2. JVM 옵션과 함께 실행
java -javaagent:opentelemetry-javaagent.jar \
     -Dotel.service.name=order-service \
     -Dotel.exporter.otlp.endpoint=http://localhost:4318 \
     -jar your-app.jar
```

Docker 환경에서는:

```php
FROM eclipse-temurin:17-jre-alpine

WORKDIR /app

# Agent 다운로드
ADD https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar /app/opentelemetry-javaagent.jar

COPY target/app.jar /app/app.jar

# 환경 변수로 설정
ENV JAVA_TOOL_OPTIONS="-javaagent:/app/opentelemetry-javaagent.jar"
ENV OTEL_SERVICE_NAME="order-service"
ENV OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-collector:4318"

ENTRYPOINT ["java", "-jar", "/app/app.jar"]
```

### 지원 라이브러리 목록

OpenTelemetry Java Agent는 **150개 이상의 라이브러리**를 자동으로 계측합니다.

| 카테고리 | 라이브러리 |
| --- | --- |
| **HTTP 서버** | Spring WebMVC, Spring WebFlux, Servlet, Netty, Undertow, Jetty |
| **HTTP 클라이언트** | RestTemplate, WebClient, Apache HttpClient, OkHttp |
| **데이터베이스** | JDBC, HikariCP, Hibernate, R2DBC, MongoDB, Redis |
| **메시징** | Kafka, RabbitMQ, AWS SQS, JMS |
| **비동기** | Reactor, RxJava, Kotlin Coroutines, CompletableFuture |
| **기타** | gRPC, GraphQL, AWS SDK, Elasticsearch |

전체 목록: [OpenTelemetry Supported Libraries](https://opentelemetry.io/docs/zero-code/java/agent/supported-libraries/)

### 주요 설정 옵션

```php
# 서비스 이름
-Dotel.service.name=order-service

# Exporter 설정
-Dotel.exporter.otlp.endpoint=http://localhost:4318
-Dotel.traces.exporter=otlp  # 또는 jaeger, zipkin, logging

# 샘플링 비율 (1.0 = 100%)
-Dotel.traces.sampler=parentbased_traceidratio
-Dotel.traces.sampler.arg=0.1

# 특정 라이브러리 계측 비활성화
-Dotel.instrumentation.jdbc.enabled=false
-Dotel.instrumentation.kafka.enabled=false

# 로그에 traceId 자동 주입
-Dotel.instrumentation.logback-appender.enabled=true
```

## 실전 비교 예시: 같은 요청, 다른 결과

같은 Spring Boot 애플리케이션에 두 방식을 적용했을 때 어떤 차이가 있는지 비교해봅시다.

### 테스트 시나리오

```xml
@RestController
class OrderController(
    private val webClient: WebClient,  // 외부 API 호출
    private val jdbcTemplate: JdbcTemplate  // DB 조회
) {
    @GetMapping("/orders/{id}")
    suspend fun getOrder(@PathVariable id: String): Order {
        // 1. 외부 API 호출
        val userInfo = webClient.get()
            .uri("http://user-service/users/{id}", id)
            .retrieve()
            .awaitBody<UserInfo>()
        
        // 2. DB 조회
        val order = jdbcTemplate.queryForObject(
            "SELECT * FROM orders WHERE id = ?", 
            orderRowMapper, id
        )
        
        return order.copy(user = userInfo)
    }
}
```

### Library Instrumentation 결과

Spring이 지원하는 컴포넌트들만 Span으로 나타납니다.

```
flowchart TB
    subgraph "Trace: abc123def456 (3 Spans)"
        A["GET /orders/123<br/>150ms - Spring WebFlux"]
        B["HTTP GET user-service<br/>80ms - WebClient"]
        C["SELECT orders<br/>40ms - Spring JDBC"]
    end
    
    A --> B
    A --> C
```

**로그 출력**:

```javascript
[abc123] INFO  OrderController - 주문 조회 시작
[abc123] DEBUG WebClient - HTTP GET http://user-service/users/123
[abc123] DEBUG JdbcTemplate - Executing SQL query
[abc123] INFO  OrderController - 주문 조회 완료
```

### Java Agent 결과

OpenTelemetry Java Agent는 **라이브러리 내부 동작까지 추적**합니다.

```
flowchart TB
    subgraph "Trace: abc123def456 (8 Spans)"
        A["GET /orders/123<br/>150ms - Spring WebFlux"]
        
        subgraph "WebClient 내부 (Agent 추가)"
            B["HTTP GET user-service<br/>80ms"]
            B1["DNS resolve<br/>5ms - Netty"]
            B2["TCP connect<br/>10ms - Netty"]
            B3["SSL handshake<br/>15ms - Netty"]
            B4["HTTP exchange<br/>50ms - Netty"]
        end
        
        subgraph "JDBC 내부 (Agent 추가)"
            C["SELECT orders<br/>40ms"]
            C1["getConnection<br/>5ms - HikariCP"]
            C2["executeQuery<br/>35ms - JDBC"]
        end
    end
    
    A --> B
    B --> B1 --> B2 --> B3 --> B4
    A --> C
    C --> C1 --> C2
```

**로그 출력** (Agent가 라이브러리 로그에도 traceId 주입):

```javascript
[abc123] INFO  OrderController - 주문 조회 시작
[abc123] DEBUG WebClient - HTTP GET http://user-service/users/123
[abc123] DEBUG io.netty.resolver - Resolving user-service
[abc123] DEBUG io.netty.channel - Connected to /10.0.0.5:8080
[abc123] DEBUG io.netty.handler.ssl - SSL handshake completed
[abc123] DEBUG HikariPool - Acquired connection
[abc123] DEBUG JdbcTemplate - Executing SQL query
[abc123] INFO  OrderController - 주문 조회 완료
```

### 핵심 차이점

| 구분 | Library Instrumentation | Java Agent |
| --- | --- | --- |
| **Span 개수** | 3개 | 8개 |
| **라이브러리 로그 traceId** | ❌ 없음 | ✅ 자동 주입 |
| **네트워크 상세 분석** | ❌ 불가 | ✅ DNS, TCP, SSL 분리 |
| **커넥션 풀 분석** | ❌ 불가 | ✅ getConnection 시간 확인 |

> **💡 언제 상세 분석이 필요할까?**
> 
> “외부 API 호출이 느린데, DNS 때문인지 SSL 때문인지 실제 응답 때문인지?” “DB 쿼리가 느린데, 커넥션 대기 때문인지 실제 쿼리 때문인지?”
> 
> 이런 질문에 답하려면 Java Agent의 상세 Span이 필요합니다.

### Timeline 비교

```
gantt
    title Library Instrumentation (3 Spans)
    dateFormat X
    axisFormat %L ms
    
    section Request
    GET /orders/123           :0, 150
    
    section External API
    HTTP GET user-service     :10, 90
    
    section Database
    SELECT orders             :95, 145
```

```
gantt
    title Java Agent Instrumentation (8 Spans)
    dateFormat X
    axisFormat %L ms
    
    section Request
    GET /orders/123           :0, 150
    
    section External API
    HTTP GET user-service     :10, 90
    
    section Netty 내부
    DNS resolve               :10, 15
    TCP connect               :15, 25
    SSL handshake             :25, 40
    HTTP exchange             :40, 90
    
    section Database
    SELECT orders             :95, 145
    
    section HikariCP 내부
    getConnection             :95, 100
    executeQuery              :100, 140
```

## 어떤 방식을 선택해야 할까?

### Library Instrumentation이 적합한 경우

**✅ 추천 상황:**

-   **GraalVM Native Image** 사용 (Java Agent 불가)
-   **가벼운 오버헤드** 필요 (최소한의 계측만)
-   **명시적 제어** 선호 (무엇이 계측되는지 정확히 알고 싶음)
-   **Spring 생태계** 내에서만 동작 (Spring Boot 자동 설정 활용)
-   **프로덕션 환경**에서 검증된 안정성 필요
-   **로컬 개발 환경**에서 간편한 설정 원함

**📦 사용 방법:**

```javascript
dependencies {
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("io.micrometer:micrometer-tracing-bridge-otel")
    implementation("io.opentelemetry:opentelemetry-exporter-otlp")
}
```

### Java Agent가 적합한 경우

**✅ 추천 상황:**

-   **레거시 애플리케이션**에 tracing 추가 (코드 수정 불가)
-   **라이브러리 내부 동작** 추적 필요 (Netty, HikariCP 등)
-   **빠른 도입** 필요 (코드 변경 없이 즉시 적용)
-   **다양한 기술 스택** 사용 (150+ 라이브러리 자동 지원)
-   **개발/테스트 환경**에서 상세 분석

**📦 사용 방법:**

```
java -javaagent:opentelemetry-javaagent.jar \
     -Dotel.service.name=order-service \
     -jar your-app.jar
```

### 로컬 개발 환경에서의 편의성

**IDE에서 개발할 때는 Library 방식이 설정이 더 간단합니다.**

| 구분 | Library Instrumentation | Java Agent |
| --- | --- | --- |
| **설정 방법** | `build.gradle`에 의존성 추가 | Run Configuration에 `-javaagent` 옵션 추가 |
| **IDE 실행** | 바로 실행 가능 | VM Options 수정 필요 |
| **Agent JAR 관리** | 불필요 | 별도 다운로드/경로 관리 필요 |
| **Hot Reload** | 정상 동작 | 일부 충돌 가능 |
| **디버깅** | Breakpoint 자연스럽게 동작 | 바이트코드 조작으로 인한 혼란 가능성 |

**IntelliJ에서 Java Agent 설정 방법:**

```javascript
Run > Edit Configurations > VM Options에 추가:
-javaagent:/path/to/opentelemetry-javaagent.jar
-Dotel.service.name=my-service
-Dotel.traces.exporter=logging
```

> **⚠️ 환경 일관성이 중요합니다**
> 
> 개발 환경과 프로덕션 환경은 **같은 방식**을 사용하는 것이 좋습니다. Java Agent는 바이트코드를 조작하기 때문에, 환경마다 다른 방식을 사용하면 “로컬에서는 되는데 프로덕션에서 안 된다” 같은 문제가 생길 수 있습니다.
> 
> -   Library 방식을 선택했다면 → 개발/스테이징/프로덕션 모두 Library
> -   Agent 방식을 선택했다면 → 개발/스테이징/프로덕션 모두 Agent

### 두 방식 병행 사용

실제로는 **두 방식을 함께 사용**하는 것도 가능합니다!

```javascript
// 1. Library Instrumentation: 비즈니스 로직에 커스텀 Span 추가
@Service
class OrderService {
    @Observed(name = "order.validate")
    fun validateOrder(order: Order): ValidationResult {
        // 비즈니스 로직 계측
    }
}
```
```php
# 2. Java Agent: 인프라 레벨 자동 계측
java -javaagent:opentelemetry-javaagent.jar \
     -Dotel.instrumentation.micrometer.enabled=true \  # Micrometer 브릿지 활성화
     -jar your-app.jar
```

> **⚠️ 주의사항**
> 
> 두 방식을 병행할 때 **중복 Span**이 생길 수 있습니다. OpenTelemetry Agent는 기본적으로 Micrometer와의 브릿지를 제공하지만, 일부 설정 조정이 필요할 수 있습니다.

### 선택 가이드 요약

```
flowchart TD
    A["Tracing 도입 결정"] --> B{"GraalVM<br/>Native Image?"}
    
    B -->|Yes| C["Library<br/>Instrumentation"]
    B -->|No| D{"라이브러리 내부<br/>추적 필요?"}
    
    D -->|Yes| E["Java Agent"]
    D -->|No| F{"내 애플리케이션<br/>코드 수정 가능?"}
    
    F -->|No| E
    F -->|Yes| G{"명시적 제어<br/>선호?"}
    
    G -->|Yes| C
    G -->|No| H{"빠른 도입<br/>필요?"}
    
    H -->|Yes| E
    H -->|No| C
    
    style C fill:#e1f5fe
    style E fill:#fff3e0
```

| 기준 | Library Instrumentation | Java Agent |
| --- | --- | --- |
| **도입 난이도** | 중간 (의존성 + 설정) | 쉬움 (JAR 한 줄) |
| **코드 변경** | 필요할 수 있음 | 불필요 |
| **계측 범위** | 제한적 | 광범위 |
| **오버헤드** | 낮음 | 중간 |
| **Native 지원** | ✅ | ❌ |
| **디버깅 용이성** | 높음 (명시적) | 낮음 (암시적) |
| **프로덕션 안정성** | 높음 | 중간 |
| **로컬 개발 편의성** | 높음 (IDE 바로 실행) | 낮음 (설정 필요) |

## 결론

이번 글에서 두 가지 Instrumentation 방식의 **동작 원리**와 **차이점**을 살펴봤습니다.

핵심 정리:

1.  **Library Instrumentation (Micrometer)**
    -   명시적이고 제어 가능
    -   코드 수정 필요
    -   GraalVM Native 지원
    -   라이브러리 내부는 계측 불가
2.  **Java Agent (OpenTelemetry)**
    -   Zero-code, 바이트코드 조작
    -   150+ 라이브러리 자동 계측
    -   라이브러리 내부까지 추적 가능
    -   Native 미지원, 오버헤드 있음
3.  **선택 기준**
    -   프로덕션 + Native → Library Instrumentation
    -   레거시 + 빠른 도입 + 상세 분석 → Java Agent
    -   둘 다 가능 → 상황에 맞게 병행

이것으로 **Tracing 시리즈**를 마무리합니다. 1편에서 Distributed Tracing의 개념부터 시작해서, ThreadLocal/MDC, Reactor Context, Kotlin Coroutine, 그리고 Instrumentation 방식까지 살펴봤습니다.

```
flowchart LR
    subgraph "Tracing 시리즈"
        P1["1편<br/>개념과 Spring 생태계"]
        P2["2편<br/>ThreadLocal과 MDC"]
        P3["3편<br/>Reactor Context"]
        P4["4편<br/>Kotlin Coroutine"]
        P5["5편<br/>Agent vs Library"]
    end
    
    P1 --> P2 --> P3 --> P4 --> P5
```

Tracing을 처음 접하거나, 기존 설정이 왜 그렇게 되어있는지 궁금했던 분들께 이 시리즈가 도움이 되었길 바랍니다. 감사합니다!

## 참고 자료

-   [OpenTelemetry Java Instrumentation – GitHub](https://github.com/open-telemetry/opentelemetry-java-instrumentation)
-   [OpenTelemetry Java Agent Documentation](https://opentelemetry.io/docs/zero-code/java/agent/)
-   [OpenTelemetry Supported Libraries](https://opentelemetry.io/docs/zero-code/java/agent/supported-libraries/)
-   [ByteBuddy – Runtime Code Generation](https://github.com/raphw/byte-buddy)
-   [Easily Create Java Agents with Byte Buddy – InfoQ](https://www.infoq.com/articles/Easily-Create-Java-Agents-with-ByteBuddy/)
-   [OpenTelemetry Tracing on Spring Boot: Java Agent vs. Micrometer Tracing](https://blog.frankel.ch/opentelemetry-tracing-spring-boot/)
-   [Micrometer Tracing Documentation](https://micrometer.io/docs/tracing)
-   [Spring Boot Observability Documentation](https://docs.spring.io/spring-boot/reference/actuator/observability.html)

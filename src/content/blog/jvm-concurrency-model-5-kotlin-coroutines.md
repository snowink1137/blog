---
title: 'JVM 동시성 모델 이해하기 (5) - Kotlin Coroutines'
description: 'Kotlin Coroutines로 Reactor의 깊은 flatMap 체이닝을 순차적 동기 코드처럼 작성하기. suspend, CPS 변환, 상태 머신, Flow, Channel, 구조화된 동시성까지.'
pubDate: '2026-03-21'
updatedDate: '2026-05-16'
category: tech
tags: ['jvm', 'kotlin', 'kotlin-coroutines', 'coroutines', 'flow', 'channel', '동시성']
---

## 동기 코드의 가독성으로 논블로킹을 — suspend 하나로 바뀌는 세상

이전 글에서 Reactor의 `flatMap` 체이닝이 깊어질 때 가독성이 떨어진다는 문제를 다뤘습니다. 같은 논블로킹 처리를 Kotlin Coroutines로 작성하면 일반 함수처럼 위에서 아래로 읽히는 순차적 코드가 됩니다.

```kotlin
// Reactor — 깊은 flatMap 체이닝
public Mono<UserDashboard> buildDashboard(Long userId) {
    return userRepository.findById(userId)
        .flatMap(user -> orderRepository.findByUserId(user.getId())
            .flatMap(order -> productRepository.findById(order.getProductId())
                .flatMap(product -> reviewRepository.findByProductId(product.getId())
                    .collectList()
                    .map(reviews -> new ProductWithReviews(product, reviews))))
            .collectList()
            .map(products -> new OrderDetail(user, products)))
        .flatMap(detail -> pointRepository.findByUserId(userId)
            .map(points -> new UserDashboard(detail, points)));
}

// Coroutine — 같은 논블로킹, 동기 코드 형태
suspend fun buildDashboard(userId: Long): UserDashboard {
    val user = userRepository.findById(userId)
    val orders = orderRepository.findByUserId(user.id)
    val products = orders.map { order ->
        val product = productRepository.findById(order.productId)
        val reviews = reviewRepository.findByProductId(product.id)
        ProductWithReviews(product, reviews)
    }
    val points = pointRepository.findByUserId(userId)
    return UserDashboard(OrderDetail(user, products), points)
}
```

두 코드 모두 논블로킹이지만, 코루틴 버전은 일반적인 명령형 스타일로 작성되어 흐름을 따라가기 훨씬 쉽습니다.

## 코루틴이란 — 중단 가능한 함수 실행

코루틴을 "경량 스레드"라 부르는 설명은 직관적이지만 정확하지 않습니다. 코루틴은 **중단 가능한 계산**이며, 스레드 모델 자체가 아닙니다.

경량 스레드(goroutine, Virtual Thread)는 "진짜 스레드처럼 보이지만 비용이 적은 실행 단위"로, 런타임이 중단/재개를 투명하게 처리합니다. 코루틴은 개발자가 `suspend`로 중단 지점을 직접 지정하고, Dispatcher로 실행 스레드도 결정합니다.

**용어 정리:**

- **루틴**: 호출 가능한 코드 단위의 총칭
- **서브루틴**: 호출자에 종속적, 처음부터 끝까지 실행 후 반환 (일반 함수)
- **코루틴**: 대등한 협력 관계, 중간에 양보 가능, 나중에 이어갈 수 있음

스레드와 코루틴의 근본 차이:

| 항목 | 스레드 | 코루틴 |
|------|--------|--------|
| **관리 주체** | OS 커널 | 코틀린 런타임 (라이브러리) |
| **중단/재개** | OS 스케줄러가 선점 | 프로그래머가 suspend로 명시 |
| **비용** | 스택 메모리 ~1MB | 힙의 객체 수백 바이트 |
| **수량** | 수백~수천 개 | 수십만 개도 가능 |

OS 스레드는 고정 크기 스택(보통 1MB)을 미리 예약하지만, 코루틴은 Continuation Passing Style(CPS) 변환 덕분에 스택을 사용하지 않습니다. 상태 머신 객체에 중간 변수만 저장하므로 메모리 효율이 극대화됩니다.

선점형(OS 스레드)과 협력형(코루틴)의 트레이드오프:

| 항목 | OS 스레드 | 코루틴 |
|------|----------|--------|
| **전환 방식** | OS가 강제로 멈추고 다른 스레드 실행 | 코루틴이 스스로 양보 |
| **CPU 독점 방지** | OS가 보장 | 보장 안 됨 — suspend 필수 |
| **비용** | 비쌈 | 저렴 |

코루틴의 약점은 CPU 집약 작업에 드러납니다. Suspend 없이 긴 연산을 하면 해당 스레드를 독점하여 같은 스레드의 다른 코루틴을 블로킹합니다.

## suspend 키워드 — 진입점

`suspend` 키워드는 "이 함수는 실행 중 중단될 수 있다"는 선언입니다:

```kotlin
suspend fun fetchUser(id: Long): User {
    delay(1000)  // 1초 대기 — 스레드를 블로킹하지 않음
    return User(id, "Alice")
}
```

**중요한 규칙**: Suspend 함수는 suspend 함수 안에서만, 또는 코루틴 빌더 안에서만 호출 가능합니다.

```kotlin
// 컴파일 에러
fun main() {
    fetchUser(1L)  // Error: Suspend function should be called only from a coroutine
}

// OK
fun main() = runBlocking {
    val user = fetchUser(1L)
    println(user)
}
```

`suspend`는 "무조건 중단"이 아니라 "중단할 수 있다"는 가능성의 선언입니다. 실제 중단은 `delay()`, `withContext()`, `await()` 같은 **중단점** (suspension point) 에서만 발생합니다.

## 코루틴 빌더 — 코루틴을 시작하는 방법

### launch — "실행하고 잊어라"

결과를 반환하지 않는 코루틴을 시작합니다:

```kotlin
val scope = CoroutineScope(Dispatchers.Default)

scope.launch {
    val user = fetchUser(1L)
    saveToCache(user)
    println("캐시 저장 완료")
}
// launch는 즉시 반환 — 코루틴은 백그라운드에서 실행
```

`launch`는 `Job` 객체를 반환하여 완료를 기다리거나 취소할 수 있습니다:

```kotlin
val job = scope.launch {
    delay(2000)
    println("작업 완료")
}

job.join()  // 코루틴이 끝날 때까지 기다림
println("job 완료 후 실행됨")

// 또는 취소
val longJob = scope.launch {
    repeat(1000) { i ->
        println("작업 $i")
        delay(500)
    }
}
delay(2000)
longJob.cancel()
```

### async — "결과를 나중에 받겠다"

결과를 반환하는 코루틴을 시작합니다:

```kotlin
val deferred: Deferred<User> = scope.async {
    fetchUser(1L)  // User를 반환
}

val user: User = deferred.await()  // 결과가 준비될 때까지 중단
```

`async`의 진정한 힘은 병렬 실행에 있습니다:

```kotlin
suspend fun getUserWithOrders(userId: Long): UserWithOrders = coroutineScope {
    // 두 작업을 동시에 시작
    val userDeferred = async { fetchUser(userId) }
    val ordersDeferred = async { fetchOrders(userId) }

    // 둘 다 완료되면 결합
    UserWithOrders(userDeferred.await(), ordersDeferred.await())
}
```

각 작업이 1초 걸린다면, 순차 실행은 2초, 위 코드는 1초입니다.

### runBlocking — 코루틴 세계로의 다리

현재 스레드를 블로킹하면서 코루틴을 실행합니다:

```kotlin
fun main() = runBlocking {
    // 여기서부터 코루틴 세계
    val user = fetchUser(1L)
    println(user)
}
```

프로덕션 코드에서는 사용을 지양해야 합니다. 스레드를 블로킹하므로 WebFlux의 이벤트 루프 스레드에서 호출하면 문제가 발생합니다.

### coroutineScope — "모든 자식이 끝날 때까지 기다림"

새로운 코루틴 스코프를 만들되, 현재 코루틴을 중단하고 모든 자식이 완료될 때까지 기다립니다:

```kotlin
suspend fun processAll() = coroutineScope {
    launch { task1() }
    launch { task2() }
    launch { task3() }
    // 세 작업이 모두 완료될 때까지 여기서 중단
}
// processAll() 이후 — 세 작업 모두 완료됨이 보장
```

### runBlocking vs coroutineScope — 둘 다 "기다리는" 건데 뭐가 다른가?

**runBlocking**: 호출한 스레드를 **물리적으로 점유**합니다. 내부 코루틴이 완료될 때까지 그 스레드는 아무것도 할 수 없습니다.

**coroutineScope**: 코루틴을 **중단** (suspend) 합니다. 스레드는 반환되어 다른 코루틴을 실행할 수 있으며, 자식이 완료되면 중단된 코루틴이 재개됩니다.

```kotlin
// runBlocking — 스레드 자체를 잡고 안 놓아줌
fun main() = runBlocking {  // main 스레드가 여기서 멈춤
    launch { delay(1000) }
    // main 스레드는 이 블록이 끝날 때까지 다른 일을 못 함
}

// coroutineScope — 코루틴만 중단, 스레드는 반환
suspend fun process() = coroutineScope {  // 코루틴이 중단됨
    launch { delay(1000) }
    // 스레드는 반환되어 다른 코루틴을 실행할 수 있음
}
```

`runBlocking`은 "일반 세계"에서 "코루틴 세계"로 진입하는 다리입니다. `main()` 함수나 테스트에서 사용하고, 프로덕션의 비즈니스 로직에서는 `coroutineScope`을 사용합니다.

## CoroutineScope과 구조화된 동시성

코루틴 빌더는 반드시 CoroutineScope 안에서 호출해야 합니다. CoroutineScope은 코루틴의 **생명주기를 관리하는 경계**입니다:

```kotlin
val scope = CoroutineScope(Dispatchers.Default)

scope.launch {           // 부모 코루틴
    launch { task1() }   // 자식 코루틴 1
    launch { task2() }   // 자식 코루틴 2
}
```

**구조화된 동시성의 규칙:**

1. **부모가 취소되면 자식도 모두 취소됩니다** — 사용자가 화면을 떠나 부모 스코프가 취소되면, 진행 중인 네트워크 요청도 자동 취소되어 리소스 누수가 구조적으로 방지됩니다.

2. **자식이 실패하면 부모에게 전파되고, 다른 자식도 취소됩니다** — task1()이 예외를 던지면 task2()도 취소됩니다.

3. **부모는 모든 자식이 완료될 때까지 완료되지 않습니다** — 자식이 아직 실행 중이면 부모도 완료되지 않습니다.

`GlobalScope.launch`는 구조화된 동시성을 포기하므로 권장되지 않습니다. GlobalScope의 자식이 실패해도 다른 자식에게 전파되지 않으며, 고아처럼 독립적으로 존재합니다.

## Dispatcher — 코루틴이 실행되는 스레드 결정

코루틴이 어떤 스레드에서 실행되는지를 결정하는 것이 Dispatcher입니다:

| Dispatcher | 스레드 풀 | 용도 | Reactor 대응 |
|------------|----------|------|------------|
| `Dispatchers.Default` | CPU 코어 수 | 연산 집약 작업 | `Schedulers.parallel()` |
| `Dispatchers.IO` | 최대 64개 | 블로킹 I/O | `Schedulers.boundedElastic()` |
| `Dispatchers.Main` | UI 스레드 1개 | Android UI 갱신 | — |
| `Dispatchers.Unconfined` | 디스패치 안 함 | 특수 목적 | `Schedulers.immediate()` |

`Dispatchers.IO`와 `Dispatchers.Default`는 같은 스레드 풀을 공유하지만 동시 사용 한계가 다릅니다. Default는 CPU 코어 수로 제한되고, IO는 최대 64개까지 확장됩니다.

```kotlin
// Reactor
fun readFile(): Mono<String> =
    Mono.fromCallable { File("data.txt").readText() }
        .subscribeOn(Schedulers.boundedElastic())

// Coroutine — 같은 의미
suspend fun readFile(): String = withContext(Dispatchers.IO) {
    File("data.txt").readText()  // 블로킹 I/O를 IO 스레드에서 실행
}
```

`withContext`는 실행 스레드를 전환하며, 블록이 완료되면 원래 Dispatcher로 복귀합니다:

```kotlin
suspend fun process() {
    // Default 스레드에서 실행 중
    val data = withContext(Dispatchers.IO) {
        // IO 스레드로 전환
        readFromDatabase()
    }
    // 다시 Default 스레드로 복귀
    transform(data)
}
```

## suspend의 내부 동작 — CPS 변환과 상태 머신

### 마법의 정체 — 컴파일러 변환

코루틴의 마법은 **코틀린 컴파일러**가 수행합니다. suspend 함수를 Continuation Passing Style(CPS)로 변환하고, 내부적으로 상태 머신을 만듭니다. 우리는 동기 코드를 작성하고, 컴파일러가 그것을 콜백 기반 코드로 변환해줍니다.

### 단계별로 살펴보기

다음 suspend 함수를 예시로 봅시다:

```kotlin
suspend fun fetchUserWithOrders(userId: Long): UserWithOrders {
    println("시작")                           // 중단점 없음
    val user = fetchUser(userId)              // 중단점 1
    println("유저 조회 완료: ${user.name}")
    val orders = fetchOrders(user.id)         // 중단점 2
    println("주문 조회 완료: ${orders.size}건")
    return UserWithOrders(user, orders)
}
```

이 함수에는 두 개의 **중단점**이 있습니다: `fetchUser()`와 `fetchOrders()` 호출 부분입니다.

### 1단계: CPS 변환 — 숨겨진 파라미터 추가

컴파일러는 모든 `suspend` 함수에 **Continuation** 파라미터를 추가합니다:

```kotlin
// 우리가 작성한 코드
suspend fun fetchUser(userId: Long): User

// 컴파일러가 변환한 코드 (개념적 예시)
fun fetchUser(userId: Long, continuation: Continuation<User>): Any?
```

`Continuation`은 "중단된 이후 어떻게 이어갈 것인가"를 담은 콜백입니다:

```kotlin
interface Continuation<in T> {
    val context: CoroutineContext
    fun resumeWith(result: Result<T>)
}
```

반환 타입이 `User`가 아닌 `Any?`로 바뀐 것에 주목합니다. 변환된 함수는 두 가지 중 하나를 반환합니다:

```kotlin
// fetchUser의 변환된 내부 (개념적 의사코드)
fun fetchUser(userId: Long, cont: Continuation<User>): Any? {
    // 네트워크 요청 시작
    val pending = networkClient.requestAsync("/users/$userId")

    if (pending.isCompleted) {
        // 이미 완료된 경우 (캐시 히트 등) → 결과를 직접 반환
        return pending.result  // User 객체
    } else {
        // 아직 응답 안 옴 → continuation을 콜백으로 등록하고 SUSPENDED 반환
        pending.onComplete { user ->
            cont.resumeWith(Result.success(user))  // 나중에 호출됨
        }
        return COROUTINE_SUSPENDED  // "지금은 결과 없음" 신호
    }
}
```

`COROUTINE_SUSPENDED`는 "결과가 아직 준비되지 않았으니, 나중에 continuation 콜백으로 알려줄게"라는 신호입니다. 호출자의 상태 머신은 이 값을 보고 "중단 → 스레드 반환"을 결정합니다. 결과가 즉시 사용 가능하면 `User` 객체가 직접 반환되고, 상태 머신은 중단 없이 다음 label로 바로 진행합니다.

### 2단계: 상태 머신 변환 — 함수를 쪼개기

컴파일러는 중단점을 기준으로 함수를 **상태 머신**으로 변환합니다. 각 중단점이 하나의 상태(label)가 됩니다:

```kotlin
// 컴파일러가 생성한 상태 머신 (의사코드)
fun fetchUserWithOrders(userId: Long, cont: Continuation<*>): Any? {
    // 상태를 저장하는 객체 (최초 호출 시 생성)
    val sm = cont as? FetchUserWithOrdersSM ?: FetchUserWithOrdersSM(cont)

    when (sm.label) {
        0 -> {
            // 상태 0: 시작 ~ 첫 번째 중단점
            println("시작")
            sm.label = 1              // 다음 상태 설정
            sm.userId = userId        // 지역 변수 저장
            val result = fetchUser(userId, sm)  // sm을 콜백으로 전달
            if (result == COROUTINE_SUSPENDED) return COROUTINE_SUSPENDED
            sm.result = Result.success(result)
        }
        1 -> {
            // 상태 1: fetchUser 완료 후 ~ 두 번째 중단점
            val user = sm.result!!.getOrThrow() as User
            sm.user = user
            println("유저 조회 완료: ${user.name}")
            sm.label = 2
            val result = fetchOrders(user.id, sm)
            if (result == COROUTINE_SUSPENDED) return COROUTINE_SUSPENDED
            sm.result = Result.success(result)
        }
        2 -> {
            // 상태 2: fetchOrders 완료 후 ~ 함수 끝
            val orders = sm.result!!.getOrThrow() as List<Order>
            val user = sm.user
            println("주문 조회 완료: ${orders.size}건")
            return UserWithOrders(user, orders)
        }
    }
}
```

**핵심 개념:**

- **label**: 현재 어디까지 실행했는지 기억하는 상태 번호. 중단점마다 1씩 증가합니다.
- **sm (상태 머신 객체)**: 중단 시점의 지역 변수를 저장. 일반 함수는 지역 변수를 스택에 저장하지만, 코루틴은 중단 시 스택이 사라지므로 **힙의 객체에 저장**합니다.
- **sm.result**: suspend 함수의 반환값. `COROUTINE_SUSPENDED`이거나 실제 값입니다.
- **COROUTINE_SUSPENDED**: "결과를 줄 수 없으니 나중에 콜백으로 알려줄게"라는 신호. 이 값이 반환되면 함수 실행이 멈추고 **스레드는 반환**됩니다.

### 전체 흐름을 시각화하면

1. 스레드 A가 `fetchUserWithOrders()` 호출
2. label=0, println("시작") 실행
3. `fetchUser()` 시작 → label=1로 설정, userId 저장
4. `SUSPENDED` 반환 → 스레드 A는 다른 코루틴 실행 가능
5. 네트워크에서 유저 데이터 도착
6. `resumeWith(user)` 호출 → label=1 실행
7. `fetchOrders()` 시작 → label=2로 설정, user 저장
8. `SUSPENDED`
9. 네트워크에서 주문 데이터 도착
10. `resumeWith(orders)` 호출 → label=2 실행
11. `UserWithOrders` 반환 → 완료

### 상태 머신을 좀 더 직관적으로 이해하기

책을 읽다가 누군가 부르면, 우리는 **페이지 번호**에 책갈피를 꽂고 자리를 뜹니다. 나중에 돌아와서 책갈피부터 이어서 읽습니다.

코루틴의 상태 머신도 같습니다. **label이 책갈피**(어디까지 읽었는지), **상태 머신 객체가 메모장**(읽다가 기억해둔 내용)입니다. 중단 시 책갈피를 꽂고 스레드를 반환하고, 재개 시 책갈피부터 이어서 실행합니다.

## Flow — 코루틴의 스트림 처리

지금까지 다룬 `suspend` 함수는 **단일 값**을 비동기로 반환합니다. 여러 값을 시간에 걸쳐 방출해야 한다면 코루틴의 **Flow**를 사용합니다. Reactor의 `Flux`에 대응됩니다.

대응 관계:

- **Mono ↔ suspend fun**
- **Flux ↔ Flow**

Reactor의 `Sinks`가 프로그래밍적으로 신호를 주입하던 역할은, 코루틴에서 **SharedFlow**와 **StateFlow**가 담당합니다.

### Cold Flow — 기본 Flow

```kotlin
fun numbers(): Flow<Int> = flow {
    for (i in 1..5) {
        delay(100)       // 논블로킹 대기
        emit(i)          // 값 방출
    }
}

// 사용
suspend fun main() {
    numbers().collect { value ->  // collect = subscribe
        println(value)
    }
}
```

`flow { }` 빌더 안에서 `emit()`으로 값을 방출합니다. 수신 측은 `collect()`로 값을 받습니다. Reactor의 `Flux`와 `subscribe()`에 대응됩니다.

기본 Flow는 **Cold 스트림**입니다. `collect()`를 호출하기 전에는 아무것도 실행되지 않습니다.

### Flow 연산자

Flow는 Flux처럼 중간 연산자를 제공합니다:

```kotlin
numbers()
    .filter { it % 2 == 0 }          // 짝수만
    .map { it * 10 }                  // 10배
    .collect { println(it) }          // 20, 40
```

`map`, `filter`, `transform`, `take`, `drop` 등 Flux에서 익숙한 연산자들이 대부분 있습니다.

스레드 전환은 `flowOn`으로 합니다 — Reactor의 `publishOn`에 대응됩니다:

```kotlin
flow {
    // IO 스레드에서 실행
    emit(readFromDatabase())
}
    .flowOn(Dispatchers.IO)        // 위쪽 flow의 실행 스레드를 지정
    .map { transform(it) }         // Default 스레드에서 실행
    .collect { println(it) }
```

### Flow의 Backpressure — suspend가 자연스럽게 해결

Reactor에서는 `request(n)`, `onBackpressureBuffer()`, `onBackpressureDrop()` 같은 전략을 명시적으로 설정해야 했습니다. Flow에서는 **별도의 Backpressure 전략이 필요 없습니다.** `emit()`과 `collect()`가 모두 `suspend` 함수이기 때문입니다:

```kotlin
// Coroutine — Backpressure 전략 없이 suspend가 자동 해결
flow {
    for (i in 1..1000) {
        emit(i)          // collect가 처리 중이면 여기서 자동 중단
    }
}.collect { value ->
    delay(1000)          // 느린 소비자
    println(value)
}
```

`collect`가 아직 이전 값을 처리 중이면 `emit()`은 자동으로 **중단** (suspend) 됩니다. Reactor에서는 개발자가 버퍼 크기와 오버플로 전략을 선택해야 하지만, Flow에서는 suspend가 Backpressure를 자연스럽게 해결합니다.

### Cold Flow vs Flux 비교

| 항목 | Flux (Reactor) | Flow (Coroutine) |
|------|----------------|-----------------|
| **단일 값** | `Mono<T>` | `suspend fun(): T` |
| **스트림** | `Flux<T>` | `Flow<T>` |
| **구독** | `subscribe()` | `collect()` |
| **스트림 타입** | Cold (기본) | Cold (기본) |
| **Backpressure** | `request(n)` 프로토콜 | `suspend`로 자동 |
| **스레드 전환** | `publishOn()` / `subscribeOn()` | `flowOn()` / `withContext()` |
| **에러 처리** | `onErrorResume()` 등 | `try-catch` |

### Hot Flow — SharedFlow와 StateFlow

기본 Flow는 Cold — `collect()`를 호출해야 생산이 시작되고, 각 collector가 독립적인 실행을 받습니다. 구독과 무관하게 데이터가 생산되는 Hot stream이 필요할 때, **SharedFlow**와 **StateFlow**를 사용합니다. 둘 다 `Flow` 인터페이스를 구현하므로, `collect()`로 값을 수신하고 `map`, `filter` 같은 Flow 연산자를 그대로 사용할 수 있습니다.

**SharedFlow**는 **이벤트 스트림**입니다. 값을 emit하면 그 시점의 **모든 collector에게 전달**되고 끝입니다. Reactor의 `Sinks.many().multicast()`에 대응됩니다.

**StateFlow**는 **상태 홀더**입니다. SharedFlow의 특수 형태로, 항상 "현재 값"을 하나 가지고 있고, 새 collector가 구독하면 **즉시 현재 값을 받습니다**. 같은 값을 다시 emit하면 무시됩니다. Reactor의 `Sinks.many().replay().latest()`에 대응됩니다:

```kotlin
// SharedFlow — 이벤트용. 초기값 없음.
val events = MutableSharedFlow<ClickEvent>()

// StateFlow — 상태용. 초기값 필수.
val uiState = MutableStateFlow(UiState.Loading)
```

| 비교 포인트 | SharedFlow | StateFlow |
|-----------|-----------|-----------|
| **현재 값** | 없음 | 항상 있음 (초기값 필수) |
| **새 구독자** | replay만큼 받음 (기본 0) | 현재 값 즉시 받음 |
| **같은 값 emit** | 매번 전달 | 무시 (distinctUntilChanged) |
| **구독자 없을 때** | 값 유실 (replay=0 일때) | 현재 값 유지 |
| **용도** | 이벤트 (클릭, 알림, 에러) | 상태 (UI 상태, 설정값) |

#### SharedFlow의 버퍼와 replay

SharedFlow는 두 가지 버퍼 설정을 제공합니다:

```kotlin
MutableSharedFlow<Int>(
    replay = 2,              // 새 collector에게 최근 2개 값을 재생
    extraBufferCapacity = 3  // emit이 suspend되지 않는 추가 버퍼
)
```

`replay`는 새 collector가 구독할 때 **과거 값을 몇 개까지 다시 보내줄지**입니다. `extraBufferCapacity`는 모든 collector가 아직 처리 못한 값을 얼마나 쌓아둘지입니다. 이 버퍼가 차면 `emit()`이 suspend됩니다.

### Flow 정리 — Cold vs Hot, 그리고 선택 기준

| 비교 포인트 | Cold Flow | Hot: SharedFlow | Hot: StateFlow |
|-----------|----------|-----------------|----------------|
| **생산 시점** | collect()할 때 시작 | 독립적 — 구독자와 무관 | 독립적 — 구독자와 무관 |
| **구독자 없을 때** | 생산 안 됨 | 값 유실 (replay=0 일때) | 현재 값 유지 |
| **구독 시** | 처음부터 새로 실행 | replay만큼 재생 | 현재 값 즉시 전달 |
| **Reactor 대응** | Flux | Sinks.multicast() | Sinks.replay().latest() |

"데이터가 언제 생산되느냐"가 핵심입니다. Cold stream은 소비자가 구독해야 생산이 시작되므로, DB 조회나 API 호출처럼 "요청할 때마다 새로 실행"하는 것에 적합합니다. Hot stream은 구독자와 무관하게 데이터가 생산되므로, 사용자 클릭이나 센서 데이터처럼 "이미 일어나고 있는 것"에 적합합니다.

## Channel — 코루틴 간 통신

Flow가 **데이터를 스트림으로 변환하고 처리하는 파이프라인**이라면, Channel은 **코루틴 간 메시지를 주고받는 통신 수단**입니다. Go의 channel과 같은 모델로, `send()`/`receive()`라는 명령형 API를 사용하며 `map`, `filter` 같은 연산자 체인이 없습니다.

**Channel은 언제 쓰는가:**

1. **작업 큐(생산자-소비자 패턴)**: 한쪽에서 작업을 만들고, 다른 쪽에서 처리합니다.
2. **Fan-out / Fan-in**: 하나의 Channel에서 여러 워커가 작업을 나눠 받아 병렬 처리하고, 결과를 다른 Channel로 모아서 합칩니다.
3. **코루틴 간 이벤트 전달**: 코루틴이 서로 협력하는 패턴에서 메시지를 주고받습니다.

```kotlin
// Fan-out 예시: 여러 워커가 작업을 나눠 처리
val tasks = Channel<Task>(capacity = 100)  // 작업 큐

// 생산자 — 작업을 Channel에 넣음
launch {
    for (task in fetchPendingTasks()) {
        tasks.send(task)
    }
    tasks.close()
}

// 워커 3개가 작업을 나눠 받아 처리 (fan-out)
repeat(3) { workerId ->
    launch {
        for (task in tasks) {  // 각 task는 하나의 워커만 받음
            println("워커 $workerId 처리: ${task.id}")
            process(task)
        }
    }
}
```

Channel은 하나의 메시지를 **하나의 수신자만** 가져가는 point-to-point 큐입니다:

```kotlin
val channel = Channel<Int>()

// 생산자 코루틴
launch {
    for (i in 1..5) {
        channel.send(i)       // 소비자가 받을 준비가 되면 전송
        println("보냄: $i")
    }
    channel.close()
}

// 소비자 코루틴
launch {
    for (value in channel) {  // 채널이 닫힐 때까지 반복
        println("받음: $value")
        delay(1000)           // 느린 소비자
    }
}
```

`send()`와 `receive()`가 모두 `suspend` 함수입니다. 소비자가 아직 이전 값을 처리 중이면 `send()`가 중단됩니다. Flow와 마찬가지로 suspend가 Backpressure를 자연스럽게 해결합니다.

### Channel 버퍼 전략

| 버퍼 전략 | 동작 |
|---------|------|
| RENDEZVOUS | 버퍼 없음, send와 receive가 만날 때까지 둘 다 중단 |
| BUFFERED | 고정 크기 버퍼, 버퍼가 차면 send 중단 |
| UNLIMITED | 무제한 버퍼, send가 중단되지 않음 (메모리 주의) |
| CONFLATED | 최신 값만 유지, 소비되지 않은 이전 값은 덮어씀 |

```kotlin
// 버퍼 없음 — send와 receive가 만날 때까지 둘 다 중단
val rendezvous = Channel<Int>(Channel.RENDEZVOUS)

// 고정 버퍼 — 버퍼가 차면 send 중단
val buffered = Channel<Int>(capacity = 10)

// 무제한 버퍼 — send가 중단되지 않음 (메모리 주의)
val unlimited = Channel<Int>(Channel.UNLIMITED)

// 최신 값만 유지 — 버퍼가 차면 오래된 값을 덮어씀
val conflated = Channel<Int>(Channel.CONFLATED)
```

## 예외 처리와 취소

### try-catch — 익숙한 방식 그대로

```kotlin
suspend fun getUser(id: Long): User {
    return try {
        fetchUser(id)
    } catch (e: NetworkException) {
        getCachedUser(id)  // 폴백
    }
}
```

Reactor에서 같은 로직은 `onErrorResume()`으로 작성해야 했지만, try-catch가 더 직관적입니다.

### CoroutineExceptionHandler — 전역 에러 핸들러

```kotlin
val handler = CoroutineExceptionHandler { _, exception ->
    println("처리되지 않은 예외: ${exception.message}")
}

val scope = CoroutineScope(Dispatchers.Default + handler)

scope.launch {
    throw RuntimeException("문제 발생!")
    // → handler가 잡아서 처리
}
```

`launch`에서 발생한 예외 중 try-catch로 잡히지 않은 것은 `CoroutineExceptionHandler`로 전달됩니다.

### supervisorScope — 자식 실패를 격리

기본적으로 자식 코루틴의 실패는 부모와 다른 자식에게 전파됩니다. 하지만 자식들이 서로 독립적이어서 하나가 실패해도 나머지는 계속 실행되어야 할 때, `supervisorScope`을 사용합니다:

```kotlin
suspend fun loadDashboard() = supervisorScope {
    val profile = async { fetchProfile() }       // 실패해도
    val notifications = async { fetchNotifications() }  // 이건 계속 실행
    val recommendations = async { fetchRecommendations() }

    DashboardData(
        profile = try { profile.await() } catch (e: Exception) { null },
        notifications = notifications.await(),
        recommendations = recommendations.await()
    )
}
```

`supervisorScope` 안에서는 자식의 실패가 다른 자식에게 전파되지 않습니다.

### CancellationException — 취소는 정상 흐름

코루틴의 취소는 예외가 아닌 **정상적인 흐름**으로 취급됩니다. `CancellationException`은 `CoroutineExceptionHandler`에 전달되지 않습니다:

```kotlin
val job = launch {
    try {
        repeat(1000) { i ->
            println("작업 $i")
            delay(500)  // 취소 가능한 중단점
        }
    } catch (e: CancellationException) {
        println("취소됨 — 정리 작업 수행")
        throw e  // 반드시 다시 던져야 취소가 전파됨
    }
}

delay(2000)
job.cancel()  // CancellationException 발생
```

`delay()`, `yield()` 같은 suspend 함수는 **취소를 확인**합니다. CPU 집약적인 작업에서 중단점이 없으면 취소가 동작하지 않으므로, `yield()`로 취소 확인 기회를 주거나 `isActive`를 확인해야 합니다:

```kotlin
// 방법 1: yield()로 취소 확인
suspend fun heavyComputation() = coroutineScope {
    var result = 0
    for (i in 1..1_000_000) {
        result += complexCalc(i)
        if (i % 1000 == 0) yield()  // 1000번마다 취소 확인
    }
    result
}

// 방법 2: isActive로 직접 확인
suspend fun heavyComputation2() = coroutineScope {
    var result = 0
    for (i in 1..1_000_000) {
        if (!isActive) break    // 취소되었으면 루프 탈출
        result += complexCalc(i)
    }
    result
}
```

## 마무리 — 코루틴이 바꾸는 것과 바꾸지 않는 것

| 개념 | 핵심 |
|------|------|
| **코루틴** | 중단/재개 가능한 함수 실행, 스레드보다 훨씬 가벼움 |
| **suspend** | "이 함수는 중단될 수 있다"는 선언 |
| **CPS + 상태 머신** | 컴파일러가 순차 코드를 콜백 기반으로 변환 |
| **Flow** | 여러 값의 비동기 스트림, suspend로 자연스러운 Backpressure |
| **구조화된 동시성** | 부모-자식 생명주기 관리, 리소스 누수 구조적 방지 |

코루틴이 **바꾸는 것**은 코드의 형태입니다. `flatMap` 체이닝 대신 순차 코드, `onErrorResume` 대신 try-catch를 사용합니다.

코루틴이 **바꾸지 않는 것**은 실행 원리입니다. 논블로킹 I/O, 콜백 기반 재개, 스레드 풀 격리 — 본질적인 메커니즘은 Reactor와 동일합니다. 컴파일러가 "보기 좋은 동기 코드"를 "실행 가능한 콜백 코드"로 변환해주는 것이 전부입니다.

다음 글에서는 코루틴을 **Spring 웹 프레임워크**에서 실제로 사용하는 방법을 다룹니다. WebFlux + Coroutines 조합, MVC + Coroutines 가능성, 그리고 Reactor와 코루틴의 상호 변환까지 살펴보겠습니다.

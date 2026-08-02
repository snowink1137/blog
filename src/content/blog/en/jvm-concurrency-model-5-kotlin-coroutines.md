---
title: 'Understanding JVM Concurrency Models (5) – Kotlin Coroutines'
description: 'Writing Reactor-style deep flatMap chains as sequential, synchronous-looking code with Kotlin Coroutines. Covers suspend, CPS transformation, state machines, Flow, Channel, and structured concurrency.'
pubDate: '2026-03-21T21:18:17+09:00'
updatedDate: '2026-03-21T21:18:17+09:00'
category: tech
subcategory: 'JVM'
tags: ['jvm', 'kotlin', 'kotlin-coroutines', 'coroutines', 'flow', 'channel', 'concurrency']
---

> **Understanding JVM Concurrency Models series**
> 
> 1.  [Concurrency and Parallelism Fundamentals](/en/jvm-concurrency-model-1-fundamentals/)
> 2.  [Java's Traditional Concurrency Model](/en/jvm-concurrency-model-2-java-traditional-concurrency/)
> 3.  [Reactive Streams and Project Reactor](/en/jvm-concurrency-model-3-reactive-streams-reactor/)
> 4.  [Spring WebFlux](/en/jvm-concurrency-model-4-spring-webflux/)
> 5.  **[Kotlin Coroutines](/en/jvm-concurrency-model-5-kotlin-coroutines/) ← current post**
> 6.  [Spring + Coroutines — WebFlux, MVC, and the Limits of AOP](/en/jvm-concurrency-model-6-spring-coroutines/)
> 7.  [Virtual Threads — The Synchronous World's Answer](/en/jvm-concurrency-model-7-virtual-thread/)
> 8.  [Wrap-up — When to Choose What](/en/jvm-concurrency-model-8-conclusion-decision-framework/)

## Non-blocking Code That Reads Like Synchronous Code — the World One `suspend` Changes

In the previous post we looked at how Reactor's `flatMap` chains become hard to read as they get deeper. Write the same non-blocking logic with Kotlin Coroutines, and you get sequential code that reads top to bottom like an ordinary function.

```kotlin
// Reactor — deep flatMap chaining
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

// Coroutine — same non-blocking behavior, written like synchronous code
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

Both versions are non-blocking, but the coroutine version is written in an ordinary imperative style, which makes the flow far easier to follow.

## What Is a Coroutine — a Suspendable Function Execution

Calling coroutines "lightweight threads" is intuitive but not accurate. A coroutine is a **suspendable computation**, not a threading model in itself.

Lightweight threads (goroutines, Virtual Threads) are "execution units that look like real threads but cost less", where the runtime handles suspension and resumption transparently. With coroutines, the developer explicitly marks suspension points with `suspend` and picks the execution thread via a Dispatcher.

**Terminology:**

- **Routine**: the umbrella term for any callable unit of code
- **Subroutine**: subordinate to its caller; runs from start to finish and then returns (an ordinary function)
- **Coroutine**: a peer in a cooperative relationship; can yield midway and pick up where it left off later

The fundamental difference between threads and coroutines:

| Aspect | Thread | Coroutine |
|------|--------|--------|
| **Managed by** | OS kernel | Kotlin runtime (a library) |
| **Suspend/resume** | Preempted by the OS scheduler | Programmer marks it explicitly with suspend |
| **Cost** | ~1MB of stack memory | A few hundred bytes as a heap object |
| **How many** | Hundreds to thousands | Hundreds of thousands are feasible |

An OS thread pre-reserves a fixed-size stack (usually 1MB), but coroutines use no stack at all thanks to the Continuation Passing Style (CPS) transformation. Only the intermediate variables are stored in a state machine object, so memory efficiency is maximized.

The trade-off between preemptive (OS threads) and cooperative (coroutines) scheduling:

| Aspect | OS thread | Coroutine |
|------|----------|--------|
| **Switching** | OS forcibly stops one thread and runs another | The coroutine yields voluntarily |
| **CPU monopoly prevention** | Guaranteed by the OS | Not guaranteed — suspend is required |
| **Cost** | Expensive | Cheap |

The weakness of coroutines shows up in CPU-intensive work. A long computation with no suspend monopolizes the thread and blocks the other coroutines sharing it.

## The suspend Keyword — the Entry Point

The `suspend` keyword declares "this function can be suspended while running":

```kotlin
suspend fun fetchUser(id: Long): User {
    delay(1000)  // wait 1 second — does not block the thread
    return User(id, "Alice")
}
```

**Important rule**: a suspend function can only be called from another suspend function, or from within a coroutine builder.

```kotlin
// Compile error
fun main() {
    fetchUser(1L)  // Error: Suspend function should be called only from a coroutine
}

// OK
fun main() = runBlocking {
    val user = fetchUser(1L)
    println(user)
}
```

`suspend` does not mean "will always suspend" — it declares the *possibility* of suspension. Actual suspension only happens at **suspension points** such as `delay()`, `withContext()`, and `await()`.

## Coroutine Builders — How to Start a Coroutine

### launch — "fire and forget"

Starts a coroutine that returns no result:

```kotlin
val scope = CoroutineScope(Dispatchers.Default)

scope.launch {
    val user = fetchUser(1L)
    saveToCache(user)
    println("Saved to cache")
}
// launch returns immediately — the coroutine runs in the background
```

`launch` returns a `Job` object you can use to wait for completion or to cancel:

```kotlin
val job = scope.launch {
    delay(2000)
    println("Work done")
}

job.join()  // wait until the coroutine finishes
println("Runs after job completes")

// Or cancel it
val longJob = scope.launch {
    repeat(1000) { i ->
        println("Task $i")
        delay(500)
    }
}
delay(2000)
longJob.cancel()
```

### async — "I'll take the result later"

Starts a coroutine that returns a result:

```kotlin
val deferred: Deferred<User> = scope.async {
    fetchUser(1L)  // returns a User
}

val user: User = deferred.await()  // suspends until the result is ready
```

The real power of `async` is parallel execution:

```kotlin
suspend fun getUserWithOrders(userId: Long): UserWithOrders = coroutineScope {
    // start both tasks at the same time
    val userDeferred = async { fetchUser(userId) }
    val ordersDeferred = async { fetchOrders(userId) }

    // combine once both are complete
    UserWithOrders(userDeferred.await(), ordersDeferred.await())
}
```

If each call takes 1 second, running them sequentially takes 2 seconds — the code above takes 1.

### runBlocking — the Bridge into the Coroutine World

Runs a coroutine while blocking the current thread:

```kotlin
fun main() = runBlocking {
    // the coroutine world starts here
    val user = fetchUser(1L)
    println(user)
}
```

Avoid it in production code. It blocks the thread, so calling it on a WebFlux event loop thread causes real trouble.

### coroutineScope — "wait until all children finish"

Creates a new coroutine scope, suspending the current coroutine until all its children complete:

```kotlin
suspend fun processAll() = coroutineScope {
    launch { task1() }
    launch { task2() }
    launch { task3() }
    // suspends here until all three tasks complete
}
// after processAll() — all three tasks are guaranteed to be done
```

### runBlocking vs coroutineScope — Both "Wait", So What's the Difference?

**runBlocking**: **physically occupies** the calling thread. Until the inner coroutines complete, that thread can do nothing else.

**coroutineScope**: **suspends** the coroutine. The thread is released to run other coroutines, and the suspended coroutine resumes once its children finish.

```kotlin
// runBlocking — grabs the thread and won't let go
fun main() = runBlocking {  // the main thread stops here
    launch { delay(1000) }
    // the main thread can do nothing else until this block ends
}

// coroutineScope — only the coroutine suspends, the thread is released
suspend fun process() = coroutineScope {  // the coroutine suspends
    launch { delay(1000) }
    // the thread is released and can run other coroutines
}
```

`runBlocking` is the bridge from the "ordinary world" into the "coroutine world". Use it in `main()` or in tests; in production business logic, use `coroutineScope`.

## CoroutineScope and Structured Concurrency

Coroutine builders must be called within a CoroutineScope. A CoroutineScope is the **boundary that manages coroutine lifecycles**:

```kotlin
val scope = CoroutineScope(Dispatchers.Default)

scope.launch {           // parent coroutine
    launch { task1() }   // child coroutine 1
    launch { task2() }   // child coroutine 2
}
```

**The rules of structured concurrency:**

1. **When the parent is cancelled, all children are cancelled too** — if the user leaves the screen and the parent scope is cancelled, in-flight network requests are automatically cancelled as well, structurally preventing resource leaks.

2. **When a child fails, the failure propagates to the parent and the other children are cancelled** — if task1() throws, task2() is cancelled too.

3. **A parent does not complete until all of its children have completed** — as long as a child is still running, the parent isn't done.

`GlobalScope.launch` abandons structured concurrency and is discouraged. If one child of GlobalScope fails, nothing propagates to the others — they exist independently, like orphans.

## Dispatcher — Deciding Which Thread a Coroutine Runs On

The Dispatcher determines which thread a coroutine executes on:

| Dispatcher | Thread pool | Purpose | Reactor equivalent |
|------------|----------|------|------------|
| `Dispatchers.Default` | Number of CPU cores | CPU-intensive work | `Schedulers.parallel()` |
| `Dispatchers.IO` | Up to 64 | Blocking I/O | `Schedulers.boundedElastic()` |
| `Dispatchers.Main` | 1 UI thread | Android UI updates | — |
| `Dispatchers.Unconfined` | No dispatching | Special purposes | `Schedulers.immediate()` |

`Dispatchers.IO` and `Dispatchers.Default` share the same thread pool but have different concurrency limits. Default is capped at the number of CPU cores, while IO can grow up to 64.

```kotlin
// Reactor
fun readFile(): Mono<String> =
    Mono.fromCallable { File("data.txt").readText() }
        .subscribeOn(Schedulers.boundedElastic())

// Coroutine — same meaning
suspend fun readFile(): String = withContext(Dispatchers.IO) {
    File("data.txt").readText()  // run blocking I/O on an IO thread
}
```

`withContext` switches the execution thread and returns to the original Dispatcher when the block completes:

```kotlin
suspend fun process() {
    // running on a Default thread
    val data = withContext(Dispatchers.IO) {
        // switched to an IO thread
        readFromDatabase()
    }
    // back on a Default thread
    transform(data)
}
```

## How suspend Works Internally — CPS Transformation and the State Machine

### The Magic Revealed — a Compiler Transformation

The magic of coroutines is performed by the **Kotlin compiler**. It converts suspend functions into Continuation Passing Style (CPS) and builds a state machine internally. We write synchronous code; the compiler turns it into callback-based code.

### Walking Through It Step by Step

Take this suspend function as an example:

```kotlin
suspend fun fetchUserWithOrders(userId: Long): UserWithOrders {
    println("Start")                          // no suspension point
    val user = fetchUser(userId)              // suspension point 1
    println("User fetched: ${user.name}")
    val orders = fetchOrders(user.id)         // suspension point 2
    println("Orders fetched: ${orders.size}")
    return UserWithOrders(user, orders)
}
```

This function has two **suspension points**: the calls to `fetchUser()` and `fetchOrders()`.

### Step 1: CPS Transformation — Adding a Hidden Parameter

The compiler adds a **Continuation** parameter to every `suspend` function:

```kotlin
// the code we wrote
suspend fun fetchUser(userId: Long): User

// the code the compiler produces (conceptual)
fun fetchUser(userId: Long, continuation: Continuation<User>): Any?
```

A `Continuation` is a callback holding "how to continue after suspension":

```kotlin
interface Continuation<in T> {
    val context: CoroutineContext
    fun resumeWith(result: Result<T>)
}
```

Note that the return type changed from `User` to `Any?`. The transformed function returns one of two things:

```kotlin
// the transformed internals of fetchUser (conceptual pseudocode)
fun fetchUser(userId: Long, cont: Continuation<User>): Any? {
    // kick off the network request
    val pending = networkClient.requestAsync("/users/$userId")

    if (pending.isCompleted) {
        // already complete (cache hit, etc.) → return the result directly
        return pending.result  // a User object
    } else {
        // no response yet → register the continuation as a callback and return SUSPENDED
        pending.onComplete { user ->
            cont.resumeWith(Result.success(user))  // called later
        }
        return COROUTINE_SUSPENDED  // signal: "no result right now"
    }
}
```

`COROUTINE_SUSPENDED` is the signal saying "the result isn't ready yet — I'll notify you later through the continuation callback". Seeing this value, the caller's state machine decides to "suspend → release the thread". If the result is immediately available, the `User` object is returned directly and the state machine proceeds to the next label without suspending.

### Step 2: State Machine Transformation — Splitting the Function

The compiler transforms the function into a **state machine**, split at the suspension points. Each suspension point becomes a state (label):

```kotlin
// the state machine generated by the compiler (pseudocode)
fun fetchUserWithOrders(userId: Long, cont: Continuation<*>): Any? {
    // the object that holds the state (created on the first call)
    val sm = cont as? FetchUserWithOrdersSM ?: FetchUserWithOrdersSM(cont)

    when (sm.label) {
        0 -> {
            // state 0: start ~ first suspension point
            println("Start")
            sm.label = 1              // set the next state
            sm.userId = userId        // save local variables
            val result = fetchUser(userId, sm)  // pass sm as the callback
            if (result == COROUTINE_SUSPENDED) return COROUTINE_SUSPENDED
            sm.result = Result.success(result)
        }
        1 -> {
            // state 1: after fetchUser completes ~ second suspension point
            val user = sm.result!!.getOrThrow() as User
            sm.user = user
            println("User fetched: ${user.name}")
            sm.label = 2
            val result = fetchOrders(user.id, sm)
            if (result == COROUTINE_SUSPENDED) return COROUTINE_SUSPENDED
            sm.result = Result.success(result)
        }
        2 -> {
            // state 2: after fetchOrders completes ~ end of function
            val orders = sm.result!!.getOrThrow() as List<Order>
            val user = sm.user
            println("Orders fetched: ${orders.size}")
            return UserWithOrders(user, orders)
        }
    }
}
```

**Key concepts:**

- **label**: the state number remembering how far execution has progressed. It increments by 1 at each suspension point.
- **sm (the state machine object)**: stores the local variables at the moment of suspension. An ordinary function keeps its locals on the stack, but a coroutine's stack disappears when it suspends, so they are **stored in a heap object** instead.
- **sm.result**: the return value of the suspend function. Either `COROUTINE_SUSPENDED` or the actual value.
- **COROUTINE_SUSPENDED**: the signal "I can't give you a result now — I'll notify you later via callback". When this value is returned, function execution stops and **the thread is released**.

### Visualizing the Whole Flow

1. Thread A calls `fetchUserWithOrders()`
2. label=0, `println("Start")` executes
3. `fetchUser()` starts → label is set to 1, userId is saved
4. `SUSPENDED` is returned → thread A is free to run other coroutines
5. User data arrives from the network
6. `resumeWith(user)` is called → label=1 executes
7. `fetchOrders()` starts → label is set to 2, user is saved
8. `SUSPENDED`
9. Order data arrives from the network
10. `resumeWith(orders)` is called → label=2 executes
11. `UserWithOrders` is returned → done

### A More Intuitive Way to Think About the State Machine

When someone calls you while you're reading a book, you put a bookmark at the **page number** and step away. Later you come back and continue from the bookmark.

A coroutine's state machine works the same way. The **label is the bookmark** (how far you've read), and the **state machine object is your notepad** (the things you jotted down while reading). On suspension, it places the bookmark and releases the thread; on resumption, it continues from the bookmark.

## Flow — Stream Processing with Coroutines

The `suspend` functions we've covered so far return a **single value** asynchronously. When you need to emit multiple values over time, you use a coroutine **Flow**. It corresponds to Reactor's `Flux`.

The correspondence:

- **Mono ↔ suspend fun**
- **Flux ↔ Flow**

The role Reactor's `Sinks` played — programmatically injecting signals — is handled in coroutines by **SharedFlow** and **StateFlow**.

### Cold Flow — the Default Flow

```kotlin
fun numbers(): Flow<Int> = flow {
    for (i in 1..5) {
        delay(100)       // non-blocking wait
        emit(i)          // emit a value
    }
}

// usage
suspend fun main() {
    numbers().collect { value ->  // collect = subscribe
        println(value)
    }
}
```

Inside the `flow { }` builder you emit values with `emit()`. The receiving side gets them with `collect()`. This corresponds to Reactor's `Flux` and `subscribe()`.

The default Flow is a **cold stream**. Nothing runs until you call `collect()`.

### Flow Operators

Flow provides intermediate operators, just like Flux:

```kotlin
numbers()
    .filter { it % 2 == 0 }          // even numbers only
    .map { it * 10 }                  // times 10
    .collect { println(it) }          // 20, 40
```

Most of the operators familiar from Flux are here: `map`, `filter`, `transform`, `take`, `drop`, and so on.

Thread switching is done with `flowOn` — the counterpart of Reactor's `publishOn`:

```kotlin
flow {
    // runs on an IO thread
    emit(readFromDatabase())
}
    .flowOn(Dispatchers.IO)        // sets the execution thread for the upstream flow
    .map { transform(it) }         // runs on a Default thread
    .collect { println(it) }
```

### Backpressure in Flow — suspend Solves It Naturally

In Reactor you had to configure explicit strategies like `request(n)`, `onBackpressureBuffer()`, and `onBackpressureDrop()`. Flow needs **no separate backpressure strategy at all**, because both `emit()` and `collect()` are `suspend` functions:

```kotlin
// Coroutine — no backpressure strategy needed; suspend handles it automatically
flow {
    for (i in 1..1000) {
        emit(i)          // automatically suspends here if collect is still busy
    }
}.collect { value ->
    delay(1000)          // slow consumer
    println(value)
}
```

If `collect` is still processing the previous value, `emit()` automatically **suspends**. In Reactor the developer must choose buffer sizes and overflow strategies; in Flow, suspend resolves backpressure naturally.

### Cold Flow vs Flux

| Aspect | Flux (Reactor) | Flow (Coroutine) |
|------|----------------|-----------------|
| **Single value** | `Mono<T>` | `suspend fun(): T` |
| **Stream** | `Flux<T>` | `Flow<T>` |
| **Subscribing** | `subscribe()` | `collect()` |
| **Stream type** | Cold (by default) | Cold (by default) |
| **Backpressure** | `request(n)` protocol | Automatic via `suspend` |
| **Thread switching** | `publishOn()` / `subscribeOn()` | `flowOn()` / `withContext()` |
| **Error handling** | `onErrorResume()` etc. | `try-catch` |

### Hot Flow — SharedFlow and StateFlow

The default Flow is cold — production starts only when `collect()` is called, and each collector gets its own independent execution. When you need a hot stream where data is produced regardless of subscriptions, use **SharedFlow** and **StateFlow**. Both implement the `Flow` interface, so you receive values with `collect()` and can use Flow operators like `map` and `filter` as usual.

**SharedFlow** is an **event stream**. When a value is emitted, it is **delivered to all collectors present at that moment**, and that's it. It corresponds to Reactor's `Sinks.many().multicast()`.

**StateFlow** is a **state holder**. It's a specialized SharedFlow that always holds exactly one "current value", and a new collector **immediately receives the current value** upon subscribing. Emitting the same value again is ignored. It corresponds to Reactor's `Sinks.many().replay().latest()`:

```kotlin
// SharedFlow — for events. No initial value.
val events = MutableSharedFlow<ClickEvent>()

// StateFlow — for state. Initial value required.
val uiState = MutableStateFlow(UiState.Loading)
```

| Comparison | SharedFlow | StateFlow |
|-----------|-----------|-----------|
| **Current value** | None | Always present (initial value required) |
| **New subscriber** | Receives up to replay values (default 0) | Receives the current value immediately |
| **Emitting the same value** | Delivered every time | Ignored (distinctUntilChanged) |
| **With no subscribers** | Values are lost (when replay=0) | Current value is retained |
| **Use for** | Events (clicks, notifications, errors) | State (UI state, settings) |

#### SharedFlow's Buffer and replay

SharedFlow offers two buffer settings:

```kotlin
MutableSharedFlow<Int>(
    replay = 2,              // replay the 2 most recent values to new collectors
    extraBufferCapacity = 3  // extra buffer that lets emit avoid suspending
)
```

`replay` controls **how many past values are re-sent** to a new collector when it subscribes. `extraBufferCapacity` controls how many values not yet processed by all collectors can pile up. When this buffer fills, `emit()` suspends.

### Flow Recap — Cold vs Hot, and How to Choose

| Comparison | Cold Flow | Hot: SharedFlow | Hot: StateFlow |
|-----------|----------|-----------------|----------------|
| **When production starts** | On collect() | Independent — regardless of subscribers | Independent — regardless of subscribers |
| **With no subscribers** | Nothing is produced | Values are lost (when replay=0) | Current value is retained |
| **On subscribing** | Runs fresh from the start | Replays up to replay values | Receives the current value immediately |
| **Reactor equivalent** | Flux | Sinks.multicast() | Sinks.replay().latest() |

The key question is "when is the data produced". A cold stream starts producing only when a consumer subscribes, making it a fit for things that "run fresh on every request" like DB queries or API calls. A hot stream produces data regardless of subscribers, making it a fit for things that are "already happening" like user clicks or sensor data.

## Channel — Communication Between Coroutines

If Flow is a **pipeline that transforms and processes data as a stream**, Channel is a **communication mechanism for passing messages between coroutines**. It follows the same model as Go's channels, uses an imperative `send()`/`receive()` API, and has no operator chains like `map` or `filter`.

**When to use a Channel:**

1. **Work queues (producer-consumer pattern)**: one side creates work, the other processes it.
2. **Fan-out / Fan-in**: multiple workers split work off a single Channel and process it in parallel, then funnel the results into another Channel to combine them.
3. **Passing events between coroutines**: exchanging messages in patterns where coroutines cooperate with each other.

```kotlin
// Fan-out example: multiple workers split the workload
val tasks = Channel<Task>(capacity = 100)  // work queue

// producer — puts work into the Channel
launch {
    for (task in fetchPendingTasks()) {
        tasks.send(task)
    }
    tasks.close()
}

// 3 workers split the work between them (fan-out)
repeat(3) { workerId ->
    launch {
        for (task in tasks) {  // each task goes to exactly one worker
            println("Worker $workerId processing: ${task.id}")
            process(task)
        }
    }
}
```

A Channel is a point-to-point queue where each message is taken by **exactly one receiver**:

```kotlin
val channel = Channel<Int>()

// producer coroutine
launch {
    for (i in 1..5) {
        channel.send(i)       // sends once the consumer is ready to receive
        println("Sent: $i")
    }
    channel.close()
}

// consumer coroutine
launch {
    for (value in channel) {  // loops until the channel is closed
        println("Received: $value")
        delay(1000)           // slow consumer
    }
}
```

Both `send()` and `receive()` are `suspend` functions. If the consumer is still processing the previous value, `send()` suspends. Just as with Flow, suspend resolves backpressure naturally.

### Channel Buffer Strategies

| Buffer strategy | Behavior |
|---------|------|
| RENDEZVOUS | No buffer; both send and receive suspend until they meet |
| BUFFERED | Fixed-size buffer; send suspends when the buffer is full |
| UNLIMITED | Unbounded buffer; send never suspends (watch your memory) |
| CONFLATED | Keeps only the latest value; unconsumed older values are overwritten |

```kotlin
// no buffer — both send and receive suspend until they meet
val rendezvous = Channel<Int>(Channel.RENDEZVOUS)

// fixed buffer — send suspends when the buffer is full
val buffered = Channel<Int>(capacity = 10)

// unbounded buffer — send never suspends (watch your memory)
val unlimited = Channel<Int>(Channel.UNLIMITED)

// keep only the latest value — overwrites older values when the buffer is full
val conflated = Channel<Int>(Channel.CONFLATED)
```

## Exception Handling and Cancellation

### try-catch — the Familiar Way, Unchanged

```kotlin
suspend fun getUser(id: Long): User {
    return try {
        fetchUser(id)
    } catch (e: NetworkException) {
        getCachedUser(id)  // fallback
    }
}
```

In Reactor the same logic required `onErrorResume()` — try-catch is simply more intuitive.

### CoroutineExceptionHandler — the Global Error Handler

```kotlin
val handler = CoroutineExceptionHandler { _, exception ->
    println("Unhandled exception: ${exception.message}")
}

val scope = CoroutineScope(Dispatchers.Default + handler)

scope.launch {
    throw RuntimeException("Something went wrong!")
    // → caught and handled by the handler
}
```

Exceptions thrown in `launch` that no try-catch catches are delivered to the `CoroutineExceptionHandler`.

### supervisorScope — Isolating Child Failures

By default, a child coroutine's failure propagates to the parent and its siblings. But when children are independent of each other — one failing shouldn't stop the rest — use `supervisorScope`:

```kotlin
suspend fun loadDashboard() = supervisorScope {
    val profile = async { fetchProfile() }       // even if this fails,
    val notifications = async { fetchNotifications() }  // this keeps running
    val recommendations = async { fetchRecommendations() }

    DashboardData(
        profile = try { profile.await() } catch (e: Exception) { null },
        notifications = notifications.await(),
        recommendations = recommendations.await()
    )
}
```

Inside `supervisorScope`, a child's failure does not propagate to the other children.

### CancellationException — Cancellation Is Normal Flow

Coroutine cancellation is treated as **normal flow**, not as an error. A `CancellationException` is never delivered to the `CoroutineExceptionHandler`:

```kotlin
val job = launch {
    try {
        repeat(1000) { i ->
            println("Task $i")
            delay(500)  // cancellable suspension point
        }
    } catch (e: CancellationException) {
        println("Cancelled — running cleanup")
        throw e  // must be rethrown so cancellation propagates
    }
}

delay(2000)
job.cancel()  // throws CancellationException
```

Suspend functions like `delay()` and `yield()` **check for cancellation**. In CPU-intensive work with no suspension points, cancellation simply doesn't take effect — give it a chance with `yield()` or check `isActive` yourself:

```kotlin
// option 1: check for cancellation with yield()
suspend fun heavyComputation() = coroutineScope {
    var result = 0
    for (i in 1..1_000_000) {
        result += complexCalc(i)
        if (i % 1000 == 0) yield()  // check for cancellation every 1000 iterations
    }
    result
}

// option 2: check isActive directly
suspend fun heavyComputation2() = coroutineScope {
    var result = 0
    for (i in 1..1_000_000) {
        if (!isActive) break    // exit the loop if cancelled
        result += complexCalc(i)
    }
    result
}
```

## Wrap-up — What Coroutines Change, and What They Don't

| Concept | Essence |
|------|------|
| **Coroutine** | A suspendable/resumable function execution, far lighter than a thread |
| **suspend** | The declaration "this function can be suspended" |
| **CPS + state machine** | The compiler transforms sequential code into callback-based code |
| **Flow** | An asynchronous stream of multiple values, with natural backpressure via suspend |
| **Structured concurrency** | Parent-child lifecycle management; structurally prevents resource leaks |

What coroutines **change** is the shape of the code. Sequential code instead of `flatMap` chains, try-catch instead of `onErrorResume`.

What coroutines **don't change** is the execution model. Non-blocking I/O, callback-based resumption, thread pool isolation — the essential mechanisms are identical to Reactor's. All the compiler does is transform "nice-looking synchronous code" into "executable callback code".

In the next post we'll look at using coroutines in a real **Spring web framework**: the WebFlux + Coroutines combination, the possibilities of MVC + Coroutines, and converting between Reactor and coroutines.

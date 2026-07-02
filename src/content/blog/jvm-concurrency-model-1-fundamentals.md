---
title: 'JVM 동시성 모델 이해하기 (1) – 동시성과 병렬성의 기초'
description: 'Process와 Thread의 차이, 동시성 vs 병렬성, 그리고 동기/비동기·블로킹/논블로킹이 서로 독립적인 두 축이라는 것까지 — JVM 동시성 시리즈의 기초 체력 편.'
pubDate: '2026-02-28'
updatedDate: '2026-05-16'
category: tech
tags: ['asynchronous', 'blocking', 'jvm', 'non-blocking', 'synchronous', '동시성', '병렬성']
---

> **JVM 동시성 모델 이해하기 시리즈**
> 
> 1.  **[동시성과 병렬성의 기초](/jvm-concurrency-model-1-fundamentals) ← 현재 글**
> 2.  [Java의 전통적인 동시성 모델](/jvm-concurrency-model-2-java-traditional-concurrency)
> 3.  [Reactive Streams와 Project Reactor](/jvm-concurrency-model-3-reactive-streams-reactor)
> 4.  [Spring WebFlux](/jvm-concurrency-model-4-spring-webflux)
> 5.  [Kotlin Coroutines](/jvm-concurrency-model-5-kotlin-coroutines)
> 6.  [Spring + Coroutines 통합 — WebFlux, MVC, 그리고 AOP의 한계](/jvm-concurrency-model-6-spring-coroutines)
> 7.  [Virtual Thread — 동기 세계의 해법](/jvm-concurrency-model-7-virtual-thread)
> 8.  [총정리 — 언제 무엇을 선택할 것인가](/jvm-concurrency-model-8-conclusion-decision-framework/)

## Spring 개발자가 꼭 정리해야 할 기초 체력

Spring MVC 으로 잘 개발하고 있다가도 성능에 대한 고민을 하게 되면 WebFlux, Coroutine, Virtual Thread라는 키워드를 자연스레 접하게 됩니다. 문서를 읽어보면 “비동기 논블로킹”, “리액티브”, “경량 스레드” 같은 표현이 난무하는데, 막상 **동시성과 병렬성의 차이가 뭔지**, **비동기면 논블로킹이랑 같은 건지** 물어보면 명확히 답하기 어렵습니다.

이 글은 **JVM 동시성 모델 이해하기 시리즈의 첫 번째 글**로, 이후 다룰 Java 동시성 모델, Reactor, WebFlux, Coroutine, Virtual Thread를 이해하기 위한 **공통 언어**를 정립합니다. 여기서 정리하는 개념들이 흔들리면 이후 기술들의 차이를 이해하기 어려우니, 이번 기회에 확실히 잡고 가겠습니다.

## Process와 Thread — 실행의 기본 단위

### 일반적인 정의

**Process** (프로세스) 는 운영체제로부터 독립된 메모리 공간을 할당받는 실행 단위입니다. 각 프로세스는 자신만의 가상 주소 공간, 파일 디스크립터, 시그널 핸들러 등을 가지고, 다른 프로세스의 메모리에 직접 접근할 수 없습니다.

**Thread** (스레드) 는 프로세스 내에서 실행되는 더 작은 단위입니다. 같은 프로세스 안의 스레드들은 **메모리를 공유**합니다. 힙 영역, 전역 변수, 파일 디스크립터 등을 함께 사용하되, 각 스레드는 자신만의 **스택**과 **프로그램 카운터**를 가집니다.

위 설명에서 등장한 OS 용어들이 오랜만이라 익숙하지 않을 수 있으니 간단히 정리하고 넘어가겠습니다.

| 용어 | 설명 |
| --- | --- |
| **가상 주소 공간 (Virtual Address Space)** | OS가 각 프로세스에게 부여하는 “나만의 메모리 영역”입니다. 실제 물리 메모리 주소와는 다르며, OS가 가상 주소 → 물리 주소 변환을 해줍니다. 덕분에 프로세스는 다른 프로세스의 메모리를 알 수도, 접근할 수도 없습니다. |
| **힙 (Heap)** | 프로그램 실행 중 **동적으로 할당**되는 메모리 영역입니다. Java에서 `new Object()`로 생성한 객체가 여기에 저장됩니다. 같은 프로세스의 스레드들은 힙을 공유하므로, 한 스레드가 만든 객체를 다른 스레드가 참조할 수 있습니다. |
| **스택 (Stack)** | 각 스레드가 **독립적으로 가지는** 메모리 영역입니다. 메서드 호출 시 지역 변수, 매개변수, 리턴 주소 등이 저장됩니다. 메서드가 끝나면 자동으로 정리됩니다. 스레드마다 별도로 존재하므로, 한 스레드의 지역 변수를 다른 스레드가 직접 볼 수 없습니다. |
| **프로그램 카운터 (Program Counter, PC)** | CPU가 **현재 실행 중인 명령어의 주소**를 가리키는 레지스터입니다. 스레드마다 별도로 존재합니다. 컨텍스트 스위칭 시 이 값을 저장/복원해야 스레드가 중단된 위치에서 다시 실행을 이어갈 수 있습니다. |
| **파일 디스크립터 (File Descriptor)** | OS가 파일, 소켓, 파이프 등 **I/O 자원을 식별하기 위해 부여하는 정수값**입니다. 예를 들어 파일을 열면 OS가 `3`이라는 번호를 주고, 이후 이 번호로 읽기/쓰기를 합니다. 같은 프로세스의 스레드들은 파일 디스크립터 테이블을 공유합니다. |
| **시그널 핸들러 (Signal Handler)** | OS나 다른 프로세스가 보내는 **이벤트** (시그널) 를 처리하는 함수입니다. `Ctrl+C`를 누르면 `SIGINT` 시그널이 프로세스에 전달되는데, 이때 실행되는 함수가 시그널 핸들러입니다. Java에서는 직접 다루는 경우가 많지 않지만, JVM이 내부적으로 사용합니다. |
| **IPC (Inter-Process Communication)** | 서로 다른 프로세스가 **데이터를 주고받기 위한 통신 방법**의 총칭입니다. 파이프, 소켓, 메시지 큐, 공유 메모리 등이 있습니다. 프로세스는 메모리가 격리되어 있으므로, 데이터를 주고받으려면 반드시 OS가 제공하는 IPC 메커니즘을 사용해야 합니다. 스레드는 메모리를 공유하므로 IPC 없이도 직접 통신할 수 있습니다. |

```
graph TB
    subgraph "Process A"
        direction TB
        A_MEM["공유 메모리 (Heap, 전역 변수)"]
        A_FD["파일 디스크립터 테이블"]
        subgraph "Thread 1"
            A_T1_STACK["Stack"]
            A_T1_PC["Program Counter"]
        end
        subgraph "Thread 2"
            A_T2_STACK["Stack"]
            A_T2_PC["Program Counter"]
        end
    end
    subgraph "Process B"
        direction TB
        B_MEM["자체 메모리 공간"]
        B_FD["자체 파일 디스크립터"]
        subgraph "Thread 3"
            B_T3_STACK["Stack"]
            B_T3_PC["Program Counter"]
        end
    end

    A_MEM -.->|"접근 불가"| B_MEM

    style A_MEM fill:#e1f5fe
    style B_MEM fill:#fce4ec
```

### Process와 Thread의 핵심 차이

| 구분 | Process | Thread |
| --- | --- | --- |
| **메모리** | 독립된 주소 공간 | 프로세스 내 메모리 공유 |
| **생성 비용** | 높음 (페이지 테이블, 메모리 할당 등) | 낮음 (스택 할당 정도) |
| **컨텍스트 스위칭** | 비용 큼 (TLB 플러시, 캐시 무효화) | 비용 작음 (레지스터, 스택 포인터 교체) |
| **통신** | IPC 필요 (파이프, 소켓, 메시지 큐) | 공유 메모리로 직접 통신 |
| **장애 격리** | 우수 (한 프로세스 crash → 다른 프로세스 무관) | 취약 (한 스레드 crash → 전체 프로세스 종료) |

**컨텍스트 스위칭 비용 차이**가 특히 중요합니다. 프로세스 간 전환은 페이지 테이블을 교체하고 TLB(Translation Lookaside Buffer)를 비워야 하므로 약 10,000~100,000 CPU 사이클이 소요됩니다. 반면 스레드 간 전환은 같은 주소 공간을 유지하므로 100~1,000 사이클 수준입니다. 이 차이가 멀티스레드 프로그래밍이 선호되는 핵심 이유입니다.

> **그러면 멀티프로세스 vs 멀티스레드는 언제 어떤 걸 쓰는 건가요?**
> 
> **장애 격리가 중요한 경우** 멀티프로세스가 적합합니다. 웹 브라우저(Chrome)가 탭마다 프로세스를 분리하는 이유가 이것입니다. 한 탭이 크래시 나더라도 다른 탭은 영향받지 않습니다. 반면 **성능과 자원 효율이 중요한 경우** 멀티스레드가 유리합니다. 웹 서버처럼 요청마다 새로운 실행 흐름을 만들어야 하는 상황에서 프로세스를 매번 생성하면 오버헤드가 너무 큽니다.

### 리눅스에서는 왜 Process와 Thread가 거의 같은 걸까?

교과서적인 구분과 달리, **리눅스 커널은 프로세스와 스레드를 내부적으로 구별하지 않습니다.** 둘 다 `task_struct`라는 동일한 자료구조로 표현하고, 스케줄러도 동일하게 처리합니다. 리눅스에서는 이 둘을 모두 **“태스크(task)”**라고 부릅니다.

이것이 가능한 이유는 `clone()` 시스템 콜의 설계 덕분입니다. `fork()`처럼 프로세스를 생성하는 것과 `pthread_create()`처럼 스레드를 생성하는 것 모두 내부적으로 **`clone()`을 호출**하는데, 어떤 자원을 공유할지를 플래그로 세밀하게 제어합니다.

```
graph LR
    FORK["fork()"] -->|"자원 복사"| CLONE["clone()"]
    PTHREAD["pthread_create()"] -->|"자원 공유"| CLONE
    CLONE --> TASK["task_struct 생성"]
    TASK --> SCHED["동일한 스케줄러에서 관리"]

    style CLONE fill:#fff3e0
    style TASK fill:#e8f5e9
```

핵심 플래그들을 살펴보면 이 구조가 더 명확해집니다.

| 플래그 | 설정 시 (스레드처럼) | 미설정 시 (프로세스처럼) |
| --- | --- | --- |
| **CLONE\_VM** | 부모와 같은 가상 메모리 공간 공유 | Copy-On-Write로 메모리 복사 |
| **CLONE\_FILES** | 파일 디스크립터 테이블 공유 | 파일 디스크립터 복사 |
| **CLONE\_SIGHAND** | 시그널 핸들러 공유 | 시그널 핸들러 복사 |
| **CLONE\_THREAD** | 같은 스레드 그룹에 소속 (외부에서 하나의 프로세스로 보임) | 별도 프로세스로 분리 |

즉, **프로세스 생성은 `clone()`에 공유 플래그를 끈 것**이고, **스레드 생성은 공유 플래그를 켠 것**입니다. 커널 입장에서는 그저 “어떤 자원을 공유하는 태스크”일 뿐, 본질적인 차이가 없습니다.

> **그러면 리눅스에서는 프로세스와 스레드 생성 비용이 거의 같은 건가요?**
> 
> 거의 비슷하지만 완전히 같지는 않습니다. 둘 다 `clone()`을 호출하고 `task_struct`를 생성하는 것까지는 동일하지만, **프로세스 생성 시에는 공유 플래그가 꺼져 있어서 메모리 공간, 파일 디스크립터 테이블 등의 복사 작업이 추가**됩니다.
> 
> 다만 리눅스는 메모리 복사에 **Copy-On-Write(COW)** 최적화를 적용합니다. COW란 `fork()`로 자식 프로세스를 만들 때 **부모의 메모리를 실제로 복사하지 않고, 같은 물리 메모리 페이지를 가리키게만 해두는 것**입니다. 부모든 자식이든 어느 한쪽이 메모리에 **쓰기를 시도하는 시점**에서야 비로소 해당 페이지만 복사합니다. 읽기만 한다면 메모리 복사는 전혀 일어나지 않습니다.
> 
> 이것이 특히 효과적인 패턴이 `fork()` + `exec()` 조합입니다. `exec()`는 **현재 프로세스의 메모리 공간을 완전히 새로운 프로그램의 것으로 교체**하는 시스템 콜입니다. `fork()`로 자식 프로세스를 만든 뒤 곧바로 `exec()`를 호출하면, 자식 프로세스가 부모와 COW로 공유하고 있던 메모리 페이지들은 새 프로그램의 메모리로 **통째로 교체**됩니다. 공유하던 부모의 메모리에 쓰기를 할 일 자체가 없어지는 것입니다. 결과적으로 **부모의 메모리를 한 번도 복사하지 않은 채 새 프로세스가 시작**됩니다.
> 
> 터미널에서 `ls`를 실행하는 과정이 바로 이 패턴입니다.
> 
> ```
> sequenceDiagram
>     participant Bash as bash (PID 100)
>     participant Child as 자식 (PID 101)
> 
>     Note over Bash: $ ls 입력
>     Bash->>Child: 1) fork()
>     Note over Child: bash의 메모리를 COW로 공유
>     Child->>Child: 2) exec("/bin/ls")
>     Note over Child: 메모리가 ls 프로그램으로 교체됨<br/>(bash 메모리는 복사 없이 버려짐)
>     Child->>Child: 3) ls 실행 → 결과 출력
>     Child-->>Bash: 종료
>     Note over Bash: 4) wait() 완료
>     Note over Bash: 5) 프롬프트 복귀 ($)
> ```
> 
> bash가 `fork()`로 자기 자신을 복제하고, 자식 프로세스가 `exec("/bin/ls")`를 호출해 ls 프로그램으로 교체되는 것입니다. `fork()` 시점에 bash의 메모리가 COW로 공유되지만, `exec()`가 즉시 메모리를 교체하므로 실제 복사는 일어나지 않습니다.
> 
> 정리하면, 스레드가 약간 더 빠르긴 하지만 “프로세스 = 무겁다”는 등식이 리눅스에서는 다른 OS만큼 극적이지 않습니다.

> **다른 OS에서도 이렇게 동작하나요?**
> 
> 아닙니다. Windows는 프로세스와 스레드를 명확히 다른 객체(`EPROCESS`, `ETHREAD`)로 관리합니다. 리눅스의 “모든 것은 태스크” 접근법은 리눅스만의 설계 철학입니다. 이 덕분에 리눅스에서는 프로세스(태스크) 생성 비용 자체가 다른 OS에 비해 상대적으로 낮습니다.

### Java Thread와 OS Thread의 관계

Java에서 `new Thread().start()`를 호출하면, JVM은 내부적으로 OS의 네이티브 스레드를 생성합니다. 리눅스에서는 `pthread_create()`를 호출하고, 이것은 다시 `clone()`으로 이어집니다. 즉, **Java Thread와 OS Thread는 1:1로 매핑**됩니다.

```
flowchart TB
    JAVA["new Thread().start()"] --> JVM[JVM 내부]
    JVM --> PTHREAD["pthread_create()"]
    PTHREAD --> CLONE_CALL["clone(CLONE_VM | CLONE_FILES | ...)"]
    CLONE_CALL --> TASK[task_struct 생성]
    TASK --> OS_SCHED[OS 스케줄러]

    style JAVA fill:#e3f2fd
    style TASK fill:#e8f5e9
    style OS_SCHED fill:#fff3e0
```

이 1:1 매핑은 두 가지 의미를 가집니다.

첫째, **OS의 스케줄링을 그대로 활용**할 수 있으므로 멀티코어를 자연스럽게 사용합니다. 둘째, **OS Thread의 비용이 곧 Java Thread의 비용**이 됩니다. OS Thread 하나당 기본 스택 메모리가 수백 KB~1MB 필요하므로, 수만 개의 스레드를 만드는 것은 현실적으로 어렵습니다.

이 한계가 바로 이 시리즈에서 다룰 Reactor, Coroutine, Virtual Thread가 등장하게 된 배경입니다. 각 기술이 이 문제를 어떻게 풀었는지는 이후 글에서 다루겠습니다.

## Concurrency(동시성) vs Parallelism(병렬성)

이 두 단어는 자주 혼용되지만, 전혀 다른 개념입니다.

**동시성** (Concurrency) 은 여러 작업을 **논리적으로 동시에 다루는 구조**입니다. 실제로 같은 순간에 실행되지 않더라도, 작업들이 겹치는 시간대에 진행되면 동시성이 있다고 합니다. 싱글코어 CPU에서도 시분할(time-slicing)로 동시성을 구현할 수 있습니다.

**병렬성** (Parallelism) 은 여러 작업이 **물리적으로 같은 순간에 실행되는 것**입니다. 멀티코어 CPU가 필요합니다.

```
gantt
    title 동시성 (싱글코어 — 시분할)
    dateFormat X
    axisFormat %s

    section CPU Core
    Task A :a1, 0, 2
    Task B :b1, 2, 4
    Task A :a2, 4, 6
    Task B :b2, 6, 8
    Task A :a3, 8, 10
```

```
gantt
    title 병렬성 (멀티코어 — 동시 실행)
    dateFormat X
    axisFormat %s

    section Core 1
    Task A :a1, 0, 10

    section Core 2
    Task B :b1, 0, 10
```

한 명의 바리스타가 아메리카노와 라떼 주문을 번갈아가며 만드는 것이 **동시성**입니다. 에스프레소를 내리는 동안 우유를 스팀하고, 다시 돌아와 샷을 받는 식으로 작업을 전환합니다. 두 명의 바리스타가 각자 한 잔씩 동시에 만드는 것이 **병렬성**입니다.

그렇다면 병렬성은 어떻게 구현될까요? 개발자가 특별히 “이 스레드는 코어 2에서 실행해줘”라고 지정할 필요는 없습니다. **OS 스케줄러**가 실행 가능한 스레드를 여러 코어에 자동으로 분배합니다. Java에서 `Thread`를 여러 개 생성하거나 `ExecutorService`로 스레드 풀을 만들면, OS가 알아서 이 스레드들을 가용한 코어에 나눠 실행합니다. 즉, **개발자는 동시성(여러 스레드를 만드는 것)에 집중하고, 병렬성(코어 분배)은 OS가 처리하는 구조**입니다. Part 2에서 `ExecutorService`, `ForkJoinPool` 등을 다루면서 이 부분을 더 자세히 살펴보겠습니다.

> **동시성과 병렬성은 서로 배타적인 개념인가요?**
> 
> 아닙니다. 오히려 대부분의 실제 시스템은 **둘 다 동시에** 사용합니다. 4코어 CPU에서 100개의 스레드가 돌아가는 상황을 생각해보면, 4개의 코어가 각각 스레드를 실행하는 것은 **병렬성**이고, 100개의 스레드를 4개 코어에서 시분할로 교대 실행하는 것은 **동시성**입니다. Spring MVC 애플리케이션이 200개의 스레드 풀로 요청을 처리하는 것도 동시성 + 병렬성이 결합된 예입니다.

## 동기/비동기, 블로킹/논블로킹 — 두 개의 독립된 축

여기서부터가 진짜 헷갈리는 구간입니다. 많은 글에서 “비동기 = 논블로킹”처럼 설명하는데, 이 둘은 **서로 다른 관점**을 말합니다.

### 동기(Synchronous) vs 비동기(Asynchronous) — “결과를 누가 챙기는가”

**동기**는 작업을 요청한 쪽이 **직접 결과를 기다리거나 확인**하는 방식입니다. 함수를 호출하면 결과가 리턴될 때까지 호출자가 관심을 유지합니다.

**비동기**는 작업을 요청한 뒤 **결과를 나중에 콜백이나 이벤트로 통보받는** 방식입니다. 호출자가 직접 결과를 확인하지 않고, 완료되면 알림이 옵니다.

```
sequenceDiagram
    participant Caller as 호출자
    participant Worker as 작업자

    Note over Caller, Worker: 동기 (Synchronous)
    Caller->>Worker: 작업 요청
    Note over Caller: 🔍 결과에 관심을 유지하며 대기
    Worker-->>Caller: 결과 반환
    Note over Caller: 호출자가 직접 결과를 받음
```

```
sequenceDiagram
    participant Caller as 호출자
    participant Worker as 작업자

    Note over Caller, Worker: 비동기 (Asynchronous)
    Caller->>Worker: 작업 요청 + 콜백 등록
    Caller->>Caller: 다른 일 수행 중...
    Caller->>Caller: 또 다른 일 수행 중...
    Worker-->>Caller: 완료! 콜백으로 결과 통보
    Note over Caller: 통보받은 시점에 결과 처리
```

핵심 차이를 다시 정리하면, **동기**에서는 호출자가 “결과가 올 때까지 관심을 유지”하고, **비동기**에서는 호출자가 “관심을 끊고 다른 일을 하다가 나중에 통보받습니다.” 여기서 주의할 점은, 동기에서 “관심을 유지한다”는 것이 반드시 “호출자 스레드가 멈춘다(블로킹)”는 뜻은 아니라는 것입니다. 호출자 스레드가 직접 반복해서 결과를 확인하는 폴링도 동기 방식입니다. 호출자 스레드가 멈추느냐의 문제는 블로킹/논블로킹의 영역이며, 바로 아래에서 다룹니다.

Java 코드로 비교하면 다음과 같습니다.

```javascript
// 동기 — 호출자가 직접 결과를 받음
ResultSet rs = statement.executeQuery("SELECT * FROM users");
// 이 줄에 도달했다면, 결과가 이미 존재

// 비동기 — 콜백으로 결과를 통보받음
CompletableFuture.supplyAsync(() -> fetchUserData())
    .thenAccept(result -> processResult(result));
// 이 줄에 도달해도, 결과는 아직 없을 수 있음
```

### 블로킹(Blocking) vs 논블로킹(Non-blocking) — “제어권이 언제 돌아오는가”

**블로킹**은 호출된 함수가 작업을 완료할 때까지 **호출자의 제어권을 돌려주지 않는** 것입니다. 호출자의 스레드는 그 자리에서 멈춥니다.

**논블로킹**은 호출된 함수가 **즉시 제어권을 반환**하는 것입니다. 작업이 완료되지 않았더라도 호출자는 바로 다음 코드를 실행할 수 있습니다.

```
sequenceDiagram
    participant Caller as 호출자
    participant IO as I/O 작업

    Note over Caller, IO: 블로킹 (Blocking)
    Caller->>IO: read() 호출
    Note over Caller: ⏸️ 제어권 없음 (대기 중)
    IO-->>Caller: 데이터 반환 + 제어권 돌려줌
    Note over Caller: ▶️ 이제야 다음 코드 실행

    Note over Caller, IO: 논블로킹 (Non-blocking)
    Caller->>IO: read() 호출
    IO-->>Caller: 즉시 반환 (데이터 없으면 빈 값)
    Note over Caller: ▶️ 바로 다음 코드 실행
    Caller->>IO: read() 다시 호출 (폴링)
    IO-->>Caller: 데이터 준비됨 → 반환
```

핵심 차이는 **제어권** (control) 입니다. 블로킹은 호출된 쪽이 제어권을 잡고 있고, 논블로킹은 즉시 제어권을 돌려줍니다.

## 4가지 조합 — 핵심 매트릭스

동기/비동기와 블로킹/논블로킹은 독립된 축이므로, 총 **4가지 조합**이 가능합니다. 이 매트릭스를 확실히 이해하면 이후 시리즈에서 다루는 기술들의 위치가 명확해집니다.

4가지 조합 예시에서 Java 동시성 관련 클래스들이 등장하는데, 아직 익숙하지 않다면 아래 표를 먼저 훑어두면 좋습니다. 각 클래스의 상세한 내용은 Part 2에서 다루므로 여기서는 “이런 게 있구나” 정도로 충분합니다.

| 클래스 | 역할 | 비유 |
| --- | --- | --- |
| **`Thread`** | 가장 기본적인 실행 단위. `start()`로 OS 스레드를 생성하고 `run()`을 실행 | 일을 하는 사람 |
| **`ExecutorService`** | 스레드 풀을 관리. 작업을 제출하면 풀의 스레드가 대신 실행해줌 | 인력 파견 회사 (일감을 접수하고 사람을 배정) |
| **`Future`** | 제출한 작업의 **결과를 나중에 받기 위한 영수증**. 결과를 꺼내려면 `get()`을 호출해야 하는데, **이때 스레드가 블로킹됨** | 세탁소 영수증 (찾으러 가면 아직 안 됐으면 기다려야 함) |
| **`CompletableFuture`** | Future의 확장. `get()`으로 직접 꺼낼 수도 있고, **콜백**(`thenApply`, `thenAccept`)을 등록하면 **결과가 준비될 때 자동으로 다음 작업이 실행됨** | 배달도 되는 세탁소 (직접 찾으러 갈 수도 있고, 완료되면 배달도 해줌) |

이 네 가지의 관계를 동기/비동기, 블로킹/논블로킹 관점에서 보면 핵심이 보입니다.

`Thread`와 `ExecutorService`는 **작업을 실행하는 도구**이므로 그 자체가 동기/비동기이거나 블로킹/논블로킹이 아닙니다. 진짜 중요한 것은 **결과를 어떻게 받느냐**인데, 이것을 결정하는 것이 `Future`와 `CompletableFuture`입니다.

**`Future`는 결과를 꺼내려면 `get()`을 호출해야 하고, 이때 스레드가 블로킹됩니다.** 반면 **`CompletableFuture`는 `thenApply()` 같은 콜백을 등록할 수 있어서, `get()`을 호출하지 않고도 결과를 처리할 수 있습니다.** 같은 “비동기 작업의 결과”를 나타내지만, 결과를 받는 방식이 블로킹이냐 논블로킹이냐의 차이인 것입니다.

```
flowchart LR
    subgraph 실행도구
        THREAD[Thread]
        EXEC[ExecutorService]
    end

    subgraph 결과수단
        FUTURE[Future]
        CF[CompletableFuture]
    end

    subgraph 결과받는방식
        BLOCK[블로킹 - 스레드 멈춤]
        NONBLOCK[논블로킹 - 스레드 안 멈춤]
    end

    EXEC --> FUTURE
    EXEC --> CF
    FUTURE -- ".get()" --> BLOCK
    CF -- ".thenApply()" --> NONBLOCK
    CF -. ".get()도 가능" .-> BLOCK

    style FUTURE fill:#ffcdd2
    style CF fill:#c8e6c9
    style BLOCK fill:#ffcdd2
    style NONBLOCK fill:#c8e6c9
```

```
quadrantChart
    title 동기/비동기 × 블로킹/논블로킹
    x-axis "블로킹" --> "논블로킹"
    y-axis "동기" --> "비동기"
    quadrant-1 "비동기 + 논블로킹"
    quadrant-2 "비동기 + 블로킹"
    quadrant-3 "동기 + 블로킹"
    quadrant-4 "동기 + 논블로킹"
    "JDBC": [0.2, 0.2]
    "Future.get()": [0.2, 0.8]
    "NIO Polling": [0.8, 0.2]
    "WebFlux/Netty": [0.8, 0.8]
```

### 동기 + 블로킹 — 가장 익숙한 조합

호출자가 직접 결과를 기다리며, 그동안 스레드는 멈춰 있습니다. **Spring MVC + JDBC** 조합이 대표적입니다.

```
sequenceDiagram
    participant Thread as 서블릿 스레드
    participant JDBC as DB (JDBC)

    Thread->>JDBC: executeQuery()
    Note over Thread: ⏸️ 스레드 블로킹
    Note over Thread: (다른 작업 불가)
    JDBC-->>Thread: ResultSet 반환
    Note over Thread: ▶️ 결과 직접 처리
```

```javascript
// 동기: 호출자가 직접 결과를 받음
// 블로킹: executeQuery()가 완료될 때까지 스레드 멈춤
ResultSet rs = statement.executeQuery("SELECT * FROM users");
process(rs); // 결과가 이미 존재
```

코드가 직관적이고 디버깅이 쉽습니다. 하지만 I/O 대기 중에 스레드가 아무것도 하지 못하므로, 동시에 많은 요청을 처리하려면 그만큼 많은 스레드가 필요합니다.

### 동기 + 논블로킹 — 폴링 방식

호출 자체는 즉시 반환되지만, 호출자가 **직접 반복적으로 결과를 확인** (폴링) 합니다. 이 조합을 설명하려면 **Java NIO**가 등장하는데, 먼저 Java의 I/O 모델을 간단히 짚고 넘어가겠습니다.

> **Java IO vs Java NIO**
> 
> **Java IO**(`java.io`)는 Java 초기부터 있던 I/O API입니다. `InputStream`, `OutputStream`, `Reader`, `Writer` 등의 클래스로 구성되며, 모든 I/O 작업이 **블로킹**으로 동작합니다. `inputStream.read()`를 호출하면 데이터가 올 때까지 스레드가 멈춥니다.
> 
> **Java NIO**(`java.nio`, New I/O)는 Java 1.4에서 추가된 I/O API입니다. 핵심 차이는 \*\*채널(Channel)\*\*과 **버퍼(Buffer)** 기반이라는 것, 그리고 **논블로킹 모드를 지원**한다는 것입니다. `channel.configureBlocking(false)`로 설정하면, `read()` 호출 시 데이터가 없어도 스레드가 멈추지 않고 즉시 반환됩니다.
> 
> **Channel**은 파일이나 소켓 같은 I/O 소스에 대한 **양방향 연결 통로**입니다. 큐처럼 데이터를 자체적으로 저장하는 것이 아니라, I/O 소스와 프로그램 사이를 연결하는 파이프에 가깝습니다. **Buffer**는 채널을 통해 읽거나 쓸 데이터를 **임시로 담아두는 메모리 블록**입니다. Java IO의 Stream은 `read()`를 호출하면 바이트가 하나씩 흘러오는 방식이지만, NIO는 “채널에서 버퍼로 데이터를 읽어와” (`channel.read(buffer)`) 또는 “버퍼의 데이터를 채널로 써” (`channel.write(buffer)`)처럼 **버퍼 단위로 데이터를 주고받습니다.**
> 
> ```
> flowchart LR
>     subgraph Java-IO
>         SOCK1[소켓] -->|단방향| IS[InputStream] -->|바이트 단위| PROG1[프로그램]
>     end
> ```
> 
> ```
> flowchart LR
>     subgraph Java-NIO
>         SOCK2[소켓] <-->|양방향| SC[SocketChannel] <-->|버퍼 단위| BUF[ByteBuffer] <--> PROG2[프로그램]
>     end
> ```
> 
> 그리고 **Selector**는 여러 채널을 하나의 스레드에서 감시하는 도구입니다. 각 채널을 Selector에 등록해두면, “지금 읽을 수 있는 채널이 있는지” 한 번의 호출로 확인할 수 있습니다. 이 덕분에 채널마다 스레드를 할당할 필요 없이, 하나의 스레드로 수천 개의 연결을 관리할 수 있습니다.
> 
> | 구분 | Java IO | Java NIO |
> | --- | --- | --- |
> | **핵심 추상화** | Stream (바이트 흐름) | Channel + Buffer |
> | **블로킹** | 항상 블로킹 | 블로킹/논블로킹 선택 가능 |
> | **방향** | 단방향 (Input 또는 Output) | 양방향 (읽기/쓰기 모두 가능) |
> | **멀티플렉싱** | 불가 (스레드당 하나의 연결) | Selector로 가능 (스레드 하나로 여러 연결) |
> 
> 참고로 **양방향**과 **논블로킹**은 별개의 개선입니다. 양방향은 “하나의 채널로 읽기/쓰기 모두 가능”이라는 자원 효율의 문제이고, 논블로킹은 “I/O 호출 시 스레드가 멈추지 않는다”는 대기 방식의 문제입니다. 이 두 가지가 NIO에서 함께 도입되었을 뿐, 양방향이기 때문에 논블로킹이 가능해진 것은 아닙니다.
> 
> **그러면 NIO에서 논블로킹이 가능해진 근본적인 이유는 뭘까요?**
> 
> 사실 리눅스 커널은 원래부터 소켓에 대한 논블로킹 모드를 지원하고 있었습니다. `fcntl()` 시스템 콜에 `O_NONBLOCK` 플래그를 설정하면, `read()` 호출 시 데이터가 없을 때 블로킹하지 않고 즉시 반환하도록 OS에 요청할 수 있습니다. 문제는 **Java IO의 Stream API가 이 기능을 활용할 수 없게 설계**되어 있었다는 점입니다. `InputStream.read()`의 반환값은 “읽은 바이트 수”, “-1 (EOF)”, 또는 “예외” 세 가지뿐입니다. **“아직 데이터가 없으니 나중에 다시 확인해”**를 표현할 방법이 API에 없었던 것입니다.
> 
> NIO의 Channel은 이 문제를 해결하기 위해 **API를 새로 설계**했습니다. `SocketChannel.read(buffer)`는 데이터가 없으면 **0을 반환**할 수 있고, 이것이 “데이터가 아직 없음”을 의미합니다. `configureBlocking(false)`로 논블로킹 모드를 설정하면, 내부적으로 OS의 논블로킹 플래그가 켜지고 이 동작이 활성화됩니다.
> 
> 정리하면, **논블로킹은 OS가 이미 지원하고 있었고, NIO는 그것을 Java에서 쓸 수 있도록 API를 새로 설계한 것**입니다. Buffer는 논블로킹을 가능하게 한 것이 아니라, 데이터를 효율적으로 주고받기 위한 개선입니다. Buffer 없이도 논블로킹 자체는 가능하지만, 버퍼 단위로 묶어서 처리하는 것이 성능 면에서 훨씬 유리합니다.

Java NIO에서 채널을 논블로킹 모드로 설정하고 직접 체크하는 패턴이 동기 + 논블로킹에 해당합니다.

논블로킹의 이점은 하나의 채널만 다룰 때보다 **여러 채널을 하나의 스레드에서 관리할 때** 명확해집니다. 블로킹이라면 채널마다 스레드가 필요하겠지만, 논블로킹이라면 하나의 루프에서 여러 채널을 순회할 수 있습니다.

```
sequenceDiagram
    participant Thread as 단일 스레드
    participant ChA as Channel A
    participant ChB as Channel B

    Note over Thread: 루프 1회차
    Thread->>ChA: read()
    ChA-->>Thread: 0 (데이터 없음)
    Thread->>ChB: read()
    ChB-->>Thread: 데이터 반환 ✓
    Note over Thread: B 처리

    Note over Thread: 루프 2회차
    Thread->>ChA: read()
    ChA-->>Thread: 데이터 반환 ✓
    Note over Thread: A 처리
    Thread->>ChB: read()
    ChB-->>Thread: 0 (데이터 없음)
```

```javascript
// 두 서버에 동시에 연결 (논블로킹)
SocketChannel channelA = SocketChannel.open();
channelA.configureBlocking(false);
channelA.connect(new InetSocketAddress("server-a.com", 80));

SocketChannel channelB = SocketChannel.open();
channelB.configureBlocking(false);
channelB.connect(new InetSocketAddress("server-b.com", 80));

ByteBuffer bufferA = ByteBuffer.allocate(1024);
ByteBuffer bufferB = ByteBuffer.allocate(1024);

boolean doneA = false, doneB = false;

// 하나의 스레드가 두 채널을 번갈아 확인 (폴링)
while (!doneA || !doneB) {
    if (!doneA) {
        int bytesRead = channelA.read(bufferA);  // 즉시 반환
        if (bytesRead > 0) {
            bufferA.flip();
            processA(bufferA);
            doneA = true;
        }
        // 데이터가 없어도 여기서 멈추지 않음 → 바로 channelB 확인으로 넘어감
    }
    if (!doneB) {
        int bytesRead = channelB.read(bufferB);  // 즉시 반환
        if (bytesRead > 0) {
            bufferB.flip();
            processB(bufferB);
            doneB = true;
        }
    }
}
```

이 코드의 핵심은 `read()`가 **블로킹하지 않고 즉시 반환**한다는 것입니다. `channelA`에 데이터가 없으면 0을 반환하고 바로 다음 줄로 넘어가므로, 곧이어 `channelB`도 확인할 수 있습니다. **블로킹 모드였다면 `channelA.read()`에서 데이터가 올 때까지 스레드가 멈춰서 `channelB`는 확인하지도 못했을 것입니다.** 이것이 논블로킹의 핵심 가치입니다 — 하나의 스레드가 여러 I/O를 동시에 관리할 수 있게 됩니다.

하지만 이렇게 직접 폴링하는 방식은 CPU를 낭비할 수 있습니다. 데이터가 없는 동안에도 계속 루프를 돌면서 확인해야 하기 때문입니다. 이 문제를 해결하기 위해 Java NIO는 **Selector**를 제공합니다.

#### Selector — 여러 채널을 하나의 스레드로 감시하기

Selector는 **여러 개의 논블로킹 채널을 하나의 스레드에서 효율적으로 감시**하는 도구입니다. 각 채널을 일일이 폴링하는 대신, Selector에 “이 채널에 데이터가 도착하면 알려줘”라고 등록해두면, `select()` 호출 한 번으로 준비된 채널만 골라서 처리할 수 있습니다.

```
graph TB
    SEL["Selector(하나의 스레드)"]
    CH1["Channel A(데이터 없음)"]
    CH2["Channel B(데이터 도착 ✓)"]
    CH3["Channel C(데이터 없음)"]
    CH4["Channel D(데이터 도착 ✓)"]

    CH1 ---|"등록"| SEL
    CH2 ---|"등록"| SEL
    CH3 ---|"등록"| SEL
    CH4 ---|"등록"| SEL

    SEL -->|"select() → 준비된 것만 반환"| RESULT["B, D만 처리"]

    style SEL fill:#fff3e0
    style CH2 fill:#c8e6c9
    style CH4 fill:#c8e6c9
    style RESULT fill:#e3f2fd
```

```javascript
Selector selector = Selector.open();

// 여러 채널을 Selector에 등록
channel1.register(selector, SelectionKey.OP_READ);
channel2.register(selector, SelectionKey.OP_READ);
channel3.register(selector, SelectionKey.OP_READ);

while (true) {
    // 등록된 채널 중 준비된 것이 생길 때까지 대기
    // (이 호출 자체는 블로킹이지만, 개별 I/O는 논블로킹)
    selector.select();

    Set<SelectionKey> readyKeys = selector.selectedKeys();
    for (SelectionKey key : readyKeys) {
        if (key.isReadable()) {
            SocketChannel ch = (SocketChannel) key.channel();
            ch.read(buffer);  // 논블로킹 read — 데이터가 준비된 채널이므로 즉시 반환
            process(buffer);
        }
    }
    readyKeys.clear();
}
```

`selector.select()` 자체는 블로킹 호출이지만, 이것은 “아무 채널이라도 준비될 때까지” 기다리는 것이지 특정 I/O 하나를 기다리는 것이 아닙니다. 수천 개의 채널을 하나의 스레드가 관리할 수 있게 되는 것이 핵심이고, 이 구조가 Netty와 WebFlux의 이벤트 루프 모델의 기반이 됩니다. Selector에 대해서는 Part 4(Spring WebFlux)에서 더 자세히 다루겠습니다.

> **동기 + 논블로킹 조합은 실제로 어디서 쓰이나요?**
> 
> **게임 루프** (Game Loop) 가 대표적입니다. 게임 루프는 게임 프로그래밍에서 널리 쓰이는 디자인 패턴으로, 게임이 실행되는 동안 **매 프레임마다 반복되는 메인 루프**를 말합니다. 이 루프 안에서 입력 확인 → 게임 상태 업데이트 → 화면 렌더링을 반복합니다.
> 
> ```javascript
> // 게임 루프 (동기 + 논블로킹 패턴)
> while (gameRunning) {
>     input = pollInput();    // 논블로킹: 입력이 없으면 null 반환, 멈추지 않음
>     updateGameState(input); // 동기: 루프가 직접 처리
>     render();               // 화면 렌더링
>     // → 이 전체가 약 16ms (60fps) 안에 끝나야 함
> }
> ```
> 
> 게임이 이 조합을 쓰는 이유는 **프레임 타이밍**과 **순서 의존성** 때문입니다.
> 
> **왜 논블로킹인가?** 60fps 게임은 한 프레임을 약 16ms 안에 처리해야 합니다. 만약 `pollInput()`이 블로킹이라면 — 플레이어가 키를 누를 때까지 스레드가 멈춘다면 — 그 동안 화면 렌더링도 멈추고 게임이 얼어버립니다. 그래서 입력이 없으면 null을 반환하고 즉시 다음 단계로 넘어가는 논블로킹이 필수입니다.
> 
> **왜 동기인가?** 각 단계 사이에 **순서 의존성**이 있기 때문입니다. 입력을 먼저 받아야 캐릭터의 이동 방향이 정해지고, 물리 연산이 끝나야 캐릭터의 최종 위치가 결정되며, 위치가 결정되어야 그 위치에 캐릭터를 렌더링할 수 있습니다. 이 순서가 뒤바뀌면 “아직 이동하지 않은 캐릭터를 렌더링한 뒤 뒤늦게 물리 연산을 적용”하는 식의 문제가 생깁니다. 콜백 기반 비동기로 만들면 이 순서를 보장하기가 훨씬 복잡해지므로, 루프가 직접 흐름을 제어하는 동기 방식이 자연스럽습니다.
> 
> 참고로, 게임이 고사양 PC를 요구하는 이유는 이 동기 구조 때문이라기보다는 **각 단계의 연산량 자체가 크기 때문**입니다. 특히 렌더링 단계에서 수백만 개의 폴리곤을 처리하는 작업은 비동기로 바꾼다고 해서 줄어들지 않습니다. 실제로 게임은 **단계 간의 흐름은 동기**이지만, **각 단계 안에서는 병렬화를 적극적으로 활용**합니다. GPU가 수천 개의 코어로 렌더링을 병렬 처리하는 것이 대표적인 예입니다.
> 
> 위에서 본 Java NIO의 `Selector.select()` + 논블로킹 채널 조합도 이 패턴의 변형입니다. 여러 채널의 이벤트를 하나의 스레드에서 폴링하는 구조로, 소수의 스레드로 대량의 연결을 처리할 수 있게 해줍니다.

### 비동기 + 블로킹 — 어중간한 조합

작업 자체는 비동기로 다른 스레드에 위임하지만, **결과를 받기 위해 호출자 스레드가 블로킹**되는 경우입니다.

```
sequenceDiagram
    participant Main as 메인 스레드
    participant Pool as 스레드 풀
    participant Worker as 워커 스레드

    Main->>Pool: submit(task)
    Pool->>Worker: task 실행 (비동기)
    Pool-->>Main: Future 반환
    Note over Main: Future.get() 호출
    Note over Main: ⏸️ 스레드 블로킹
    Note over Worker: 작업 수행 중...
    Worker-->>Main: 결과 전달
    Note over Main: ▶️ 결과 처리
```

```javascript
ExecutorService executor = Executors.newFixedThreadPool(4);

// 비동기: 작업을 다른 스레드에 위임
Future<String> future = executor.submit(() -> {
    return callExternalAPI();
});

// 블로킹: 결과를 기다리며 스레드가 멈춤
String result = future.get();  // ← 여기서 블로킹 발생
processResult(result);
```

작업을 비동기로 다른 스레드에 위임하는 데까지는 성공했지만, `Future.get()`을 호출하는 순간 **호출자 스레드의 제어권이 사라집니다.** 위임은 했는데 결과가 올 때까지 아무것도 할 수 없는 상태가 되는 것입니다. 사실상 동기 + 블로킹과 비슷한 결과를 낳으면서 코드만 더 복잡해집니다. **일반적으로 안티패턴**으로 간주됩니다.

> **그런데 왜 이 조합이 존재하나요?**
> 
> `Future.get()` 호출 전에 다른 유용한 작업을 할 수 있다면 의미가 있습니다. 예를 들어 A, B 두 작업을 병렬로 제출하고, 제출과 `get()` 사이에 다른 작업을 먼저 처리한 뒤 각각의 결과가 필요한 시점에 `get()`을 호출하면, 순차 실행보다 빠를 수 있습니다. 하지만 이런 경우에도 `CompletableFuture.allOf()`를 사용하는 것이 더 나은 선택인 경우가 많습니다.
> 
> ```javascript
> // 비동기+블로킹이 그나마 유용한 케이스
> Future<String> futureA = executor.submit(() -> callServiceA());
> Future<String> futureB = executor.submit(() -> callServiceB());
> // ↑ A, B가 동시에 실행 중
> 
> doSomethingElse(); // 이 시간 동안 A, B가 병렬로 진행됨
> 
> String resultA = futureA.get(); // 블로킹이지만, 이미 완료되었을 수 있음
> String resultB = futureB.get(); // 블로킹
> ```

### 비동기 + 논블로킹 — 이상적인 조합

작업을 위임하고 즉시 제어권을 반환받으며, 결과는 콜백이나 이벤트로 처리합니다. **WebFlux, Netty, CompletableFuture 체인**이 이 조합에 해당합니다.

```
sequenceDiagram
    participant Main as 메인 스레드
    participant EventLoop as 이벤트 루프
    participant IO as I/O

    Main->>EventLoop: 작업 요청 + 콜백 등록
    EventLoop-->>Main: 즉시 반환 ✓
    Note over Main: ▶️ 다른 작업 수행 가능
    EventLoop->>IO: I/O 요청
    IO-->>EventLoop: I/O 완료
    EventLoop->>EventLoop: 콜백 실행
    Note over EventLoop: 결과 처리 (콜백)
```

```javascript
// 비동기: 작업을 위임하고
// 논블로킹: 즉시 반환됨
CompletableFuture.supplyAsync(() -> fetchDataFromAPI())
    .thenApply(data -> parseData(data))          // 콜백 체인
    .thenAccept(result -> saveToDatabase(result)) // 결과 처리
    .exceptionally(ex -> {
        log.error("Error: {}", ex.getMessage());
        return null;
    });

// 이 줄은 위 작업이 완료되기 전에 즉시 실행됨
log.info("작업을 요청했고, 다른 일을 하고 있습니다.");
```

Spring WebFlux의 예도 이 조합입니다.

```javascript
// Reactor의 Mono/Flux — 비동기 + 논블로킹
webClient.get()
    .uri("/api/users")
    .retrieve()
    .bodyToMono(User.class)
    .subscribe(
        user -> log.info("받은 결과: {}", user),
        error -> log.error("에러 발생", error)
    );
// subscribe() 호출 즉시 반환, 결과는 나중에 콜백으로 도착
```

소수의 스레드로 대량의 동시 요청을 처리할 수 있어서 **처리량(throughput)이 높습니다.** 하지만 콜백 체인으로 인해 코드가 복잡해지고, 디버깅 시 스택 트레이스가 끊기는 문제가 있습니다. 이 단점을 해결하기 위해 등장한 것이 Kotlin Coroutine이며, 이는 시리즈의 Part 5에서 다루겠습니다.

### 4가지 조합 정리표

| 조합 | 핵심 | 대표 사례 | 특징 |
| --- | --- | --- | --- |
| **동기 + 블로킹** | 요청하고 기다림 | JDBC, Spring MVC | 직관적이지만 스레드 낭비 |
| **동기 + 논블로킹** | 요청하고 직접 폴링 | NIO 폴링, 게임 루프 | CPU 낭비 가능성 |
| **비동기 + 블로킹** | 위임하고 결국 기다림 | Future.get() | 대부분 안티패턴 |
| **비동기 + 논블로킹** | 위임하고 콜백으로 수신 | WebFlux, Netty, CompletableFuture | 높은 처리량, 코드 복잡도 ↑ |

> **비동기면 항상 논블로킹인가요?**
> 
> 아닙니다. 위에서 본 것처럼 비동기 + 블로킹 조합도 존재합니다. 비동기는 **“결과를 어떻게 받느냐”**의 문제이고, 논블로킹은 **“호출한 뒤 스레드가 멈추느냐”**의 문제입니다. 두 축은 독립적입니다. 다만 실무에서 비동기 기술을 쓸 때 논블로킹과 함께 사용하는 것이 자연스럽기 때문에 혼동되는 경우가 많습니다.

## 이 개념들은 시리즈에서 어떻게 연결되는가

지금까지 정리한 개념을 시리즈 전체의 맥락에서 보면 하나의 흐름이 보입니다.

Java의 전통적인 동시성 모델은 **동기 + 블로킹**이 기본이었습니다. Thread, ExecutorService, Spring MVC 모두 이 모델 위에 있습니다. 간단하고 직관적이지만, 동시 요청 수가 늘어나면 스레드 수도 함께 늘어야 해서 확장에 한계가 있습니다.

이 한계를 극복하기 위해 **비동기 + 논블로킹** 방향으로 Reactor와 WebFlux가 등장했고, Kotlin Coroutine은 비동기 + 논블로킹의 복잡한 코드를 동기 스타일로 작성할 수 있게 해줬습니다. 가장 최근에 등장한 Virtual Thread는 아예 관점을 바꿔서, **동기 + 블로킹 스타일의 코드를 유지하면서도 스레드 비용 문제를 해결**하는 접근을 택했습니다.

```
graph LR
    A["Thread(동기+블로킹)"] -->|"확장성 한계"| B["Reactor/WebFlux(비동기+논블로킹)"]
    B -->|"코드 복잡도"| C["Coroutine(비동기+논블로킹. but 동기 스타일로 코드 작성)"]
    A -->|"다른 접근"| D["Virtual Thread(동기+블로킹 스타일. 경량 스레드)"]

    style A fill:#ffcdd2
    style B fill:#c8e6c9
    style C fill:#bbdefb
    style D fill:#fff9c4
```

다음 글에서는 Java의 전통적인 동시성 모델(Thread부터 CompletableFuture까지)을 코드와 함께 살펴보겠습니다.

## 참고 자료

-   [Linux clone(2) man page](https://www.man7.org/linux/man-pages/man2/clone.2.html)
-   [Eli Bendersky — Launching Linux threads and processes with clone](https://eli.thegreenplace.net/2018/launching-linux-threads-and-processes-with-clone/)
-   [Java Thread와 OS Thread 매핑](https://medium.com/@unmeshvjoshi/how-java-thread-maps-to-os-thread-e280a9fb2e06)
-   [Baeldung — Process vs Thread](https://www.baeldung.com/cs/process-vs-thread)

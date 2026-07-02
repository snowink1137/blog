---
title: 'Apple Silicon Mac에서 Netty DNS 해석 실패 해결하기(feat. Gradle 의존성 Configuration 이해하기)'
description: 'Apple Silicon Mac에서 Spring Cloud Gateway만 DNS 해석에 실패하는 문제의 원인(Netty의 자체 DNS resolver)과 해결책. 네이티브 라이브러리 의존성과 Gradle Configuration 개념까지 함께 정리.'
pubDate: '2026-01-04'
category: tech
tags: ['apple-silicon', 'dns', 'gradle', 'netty', 'spring-cloud-gateway', 'spring-webflux']
---

## 서론

Apple silicon을 사용하는 Mac에서, 사내 VPN과 Spring Cloud Gateway 앱을 실행했을 때 Netty DNS 관련 오류를 겪었던 내용입니다. 더 나아가서 Spring WebFlux를 사용할 때 Netty가 시스템 DNS를 무시하는 이유와 해결법을 알아봅니다.

## VPN은 연결됐는데, Spring Cloud Gateway 앱에서만 DNS 오류가 난다?

사내 VPN에 연결한 상태에서 터미널로 `ping`이나 `traceroute`를 실행하면 시스템 DNS를 사용하여 내부 도메인이 잘 해석됩니다. 그런데 Spring Boot 애플리케이션을 로컬에서 실행하면 아래와 같은 오류가 발생합니다.

```text
io.netty.resolver.dns.DnsResolveContext$SearchDomainUnknownHostException: 
Failed to resolve 'api-legacy.internal.example.com' [A(1), AAAA(28)]
```

분명 같은 네트워크 환경인데 왜 애플리케이션에서만 DNS 해석에 실패할까요? 이 글에서는 Apple Silicon Mac 환경에서 발생하는 Netty DNS resolver 문제의 원인과 해결법을 정리합니다.

## 어떤 기술 스택이 영향을 받나요?

이 문제는 **Netty를 HTTP 클라이언트로 사용하는 모든 Spring 애플리케이션**에서 발생할 수 있습니다.

| 기술 스택 | Netty 사용 | 영향 |
| --- | --- | --- |
| Spring Cloud Gateway | ✅ | 영향받음 |
| Spring WebFlux + WebClient | ✅ | 영향받음 |
| R2DBC (Reactive DB 연결) | ✅ | 영향받음 |
| Spring MVC + RestTemplate | ❌ | 영향 없음 |

Spring WebFlux는 기본적으로 `reactor-netty`를 사용합니다. WebClient로 외부 API를 호출하거나, Spring Cloud Gateway에서 downstream 서비스로 라우팅할 때 모두 Netty의 DNS resolver를 거칩니다.

> **Spring MVC를 사용 중이라면?** RestTemplate이나 Apache HttpClient 기반이라면 이 문제가 발생하지 않습니다. 이들은 JDK의 기본 DNS resolver를 사용하기 때문입니다.

## 원인: Netty는 왜 시스템 DNS를 사용하지 않을까?

![](/images/spring-webflux-netty-dns-apple-silicon-fix/img-01-netty-dns-flowchart.png)

Netty는 자체 DNS resolver를 사용합니다. 그 이유는 **성능** 때문입니다.

JDK에 내장된 `InetAddress.getByName()`은 **블로킹(blocking)** 방식으로 동작합니다. DNS 응답을 기다리는 동안 스레드가 멈춥니다. 반면 Netty는 비동기 이벤트 루프 기반이므로, 스레드를 블로킹하지 않는 **논블로킹 DNS resolver**가 필요합니다.

문제는 macOS에서 시스템 DNS 설정(특히 VPN DNS)을 제대로 읽어오려면 **네이티브 라이브러리**가 필요하다는 점입니다. 이 라이브러리가 없으면 Netty는 `/etc/resolv.conf` 등 제한된 정보만 참조하게 되어 VPN DNS 서버를 인식하지 못합니다.

> **왜 Apple Silicon에서만 문제가 되나요?** `netty-resolver-dns-native-macos` 라이브러리는 CPU 아키텍처별로 분리되어 있습니다. Intel Mac용(`osx-x86_64`)과 Apple Silicon용(`osx-aarch_64`)이 별도로 존재합니다. 문제는 reactor-netty가 **항상 Intel용(`osx-x86_64`)만 의존성에 포함**시킨다는 점입니다. Intel Mac에서는 아키텍처가 일치하니 정상 동작하지만, Apple Silicon에서는 아키텍처가 맞지 않아 네이티브 라이브러리 로드에 실패합니다. 이 이슈는 [reactor-netty #2440](https://github.com/reactor/reactor-netty/issues/2440)에서 논의되었고, 향후 버전에서 개선될 예정이지만 현재는 수동으로 추가해야 합니다.

## 해결 방법: 네이티브 라이브러리 추가

`build.gradle.kts`에 다음 의존성을 추가합니다.

```kotlin
dependencies {
    // macOS Apple Silicon에서 Netty가 시스템 DNS resolver를 사용하도록 native 라이브러리 추가
    if (System.getProperty("os.name").lowercase().contains("mac") 
        && System.getProperty("os.arch") == "aarch64") {
        runtimeOnly("io.netty:netty-resolver-dns-native-macos::osx-aarch_64")
    }
    
    // 기존 의존성들...
}
```

버전을 명시하지 않으면 Spring Boot의 dependency management가 프로젝트에서 사용 중인 Netty 버전에 맞춰 자동으로 적용합니다.

> **Intel Mac에서는 왜 문제가 없나요?** reactor-netty가 기본으로 포함시키는 `osx-x86_64`가 Intel Mac의 아키텍처와 일치하기 때문입니다. 따라서 Intel Mac 사용자는 별도 설정 없이도 네이티브 DNS resolver가 정상 동작합니다.

## Gradle 의존성 Configuration 이해하기

위 코드에서 `runtimeOnly`를 사용한 이유가 궁금하실 수 있습니다. Gradle의 의존성 Configuration을 정리하면 다음과 같습니다.

| Configuration | 컴파일 시 사용 | JAR에 포함 | 용도 |
| --- | --- | --- | --- |
| `implementation` | ✅ | ✅ | 코드에서 직접 import하는 라이브러리 |
| `compileOnly` | ✅ | ❌ | 컴파일에만 필요, 런타임엔 외부 제공 (Lombok 등) |
| `runtimeOnly` | ❌ | ✅ | 코드에서 직접 참조 안 함, 런타임에 프레임워크가 감지 |

![](/images/spring-webflux-netty-dns-apple-silicon-fix/img-02-gradle-dependency-config.png)

`netty-resolver-dns-native-macos`는 코드에서 직접 import하지 않습니다. Netty가 런타임에 classpath를 스캔해서 자동으로 감지하고 사용합니다. 따라서 `runtimeOnly`가 적합합니다.

> **runtimeOnly의 진짜 장점은?** 컴파일 시간 단축이 아닙니다. “이 라이브러리는 직접 사용하지 않는다”는 **의도를 명확히 표현**하고, 실수로 코드에서 직접 참조하는 것을 **컴파일 에러로 방지**하는 것이 핵심입니다.

### bootJar 패키징 과정

Spring Boot의 `bootJar` 태스크가 실행되면 다음 과정을 거칩니다.

1.  **컴파일**: 소스 코드(.kt, .java) → 바이트코드(.class)
2.  **패키징**: .class 파일 + 의존성 JAR → 실행 가능한 fat JAR

최종 JAR 구조는 아래와 같습니다.

```text
app.jar
├── BOOT-INF/
│   ├── classes/          ← 컴파일된 .class 파일
│   └── lib/              ← implementation + runtimeOnly 의존성
├── META-INF/
└── org/springframework/boot/loader/
```

`runtimeOnly`로 추가한 라이브러리도 `BOOT-INF/lib/`에 포함되어 `java -jar app.jar`로 실행할 때 정상 동작합니다.

### 주의: 빌드 환경에 따른 차이

위 Gradle 설정의 `if` 조건은 **빌드 시점**에 평가됩니다.

| 빌드 환경 | JAR에 포함 여부 |
| --- | --- |
| macOS Apple Silicon에서 빌드 | ✅ 포함 |
| Linux/Docker에서 빌드 | ❌ 미포함 |

CI/CD 파이프라인이 Linux에서 실행된다면 빌드된 JAR에는 이 라이브러리가 포함되지 않습니다. 로컬 개발용으로는 문제없지만, CI에서 빌드한 JAR를 Mac에서 실행해야 하는 특수한 경우라면 `if` 조건 없이 항상 포함시키는 방법도 있습니다. Linux에서는 해당 라이브러리가 무시되므로 부작용은 없습니다.

## 대안: JVM 옵션으로 해결하기

의존성 추가 없이 JVM 옵션만으로 해결할 수도 있습니다.

```bash
# Gradle로 실행 시
./gradlew bootRun -Dio.netty.resolver.dns.macos.forceSyscall=true

# JAR로 직접 실행 시
java -Dio.netty.resolver.dns.macos.forceSyscall=true -jar app.jar
```

IntelliJ에서 실행한다면 Run Configuration > VM options에 추가하면 됩니다.

이 옵션은 Netty가 네이티브 라이브러리 대신 macOS 시스템 콜을 직접 사용하도록 강제합니다. 다만 프로젝트 설정에 명시되지 않아 팀원 간 공유가 어렵고, 매번 옵션을 지정해야 하는 불편함이 있습니다.

## 마무리

Apple Silicon Mac에서 Spring WebFlux 애플리케이션의 DNS 문제를 해결하려면:

1.  **원인 파악**: Netty는 성능을 위해 자체 비동기 DNS resolver를 사용하며, macOS 네이티브 라이브러리 없이는 VPN DNS를 인식하지 못함
2.  **해결책**: `netty-resolver-dns-native-macos` 의존성을 `runtimeOnly`로 추가
3.  **주의사항**: `if` 조건은 빌드 시점에 평가되므로 CI/CD 환경 고려 필요

Apple Silicon Mac을 개발 환경으로 사용하는 분들이 점점 많아지고 있습니다. VPN 환경에서 WebClient나 Spring Cloud Gateway를 사용한다면, 이 설정을 프로젝트에 미리 추가해두는 것을 권장합니다.

## 참고 자료

-   [Netty GitHub Issue #11020 – Apple Silicon DNS 문제 원본 이슈](https://github.com/netty/netty/issues/11020)
-   [reactor-netty Issue #2440 – Apple Silicon 관련 공식 논의](https://github.com/reactor/reactor-netty/issues/2440)
-   [Netty DNS Resolver API 문서](https://netty.io/4.1/api/io/netty/resolver/dns/package-summary.html)

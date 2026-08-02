---
title: 'Fixing Netty DNS Resolution Failures on Apple Silicon Macs (feat. Understanding Gradle Dependency Configurations)'
description: 'Why Spring Cloud Gateway alone fails DNS resolution on Apple Silicon Macs (Netty''s own DNS resolver) and how to fix it — plus a look at native library dependencies and Gradle Configuration concepts.'
pubDate: '2026-01-04T16:43:48+09:00'
updatedDate: '2026-08-03T02:05:00+09:00'
category: tech
subcategory: 'Spring'
tags: ['apple-silicon', 'dns', 'gradle', 'netty', 'spring-cloud-gateway', 'spring-webflux']
---

## Introduction

This is the story of a Netty DNS error I ran into on an Apple Silicon Mac while running our corporate VPN together with a Spring Cloud Gateway app. Going a step further, we'll look at why Netty ignores the system DNS when you use Spring WebFlux, and how to fix it.

## The VPN Is Connected, but Only the Spring Cloud Gateway App Gets DNS Errors?

With the corporate VPN connected, running `ping` or `traceroute` in a terminal resolves internal domains just fine using the system DNS. But run the Spring Boot application locally, and you get an error like this.

```text
io.netty.resolver.dns.DnsResolveContext$SearchDomainUnknownHostException: 
Failed to resolve 'api-legacy.internal.example.com' [A(1), AAAA(28)]
```

It's clearly the same network environment — so why does DNS resolution fail only inside the application? In this post I'll walk through the cause of the Netty DNS resolver problem on Apple Silicon Macs and how to solve it.

## Which Tech Stacks Are Affected?

This problem can occur in **any Spring application that uses Netty as its HTTP client**.

| Tech stack | Uses Netty | Affected |
| --- | --- | --- |
| Spring Cloud Gateway | ✅ | Affected |
| Spring WebFlux + WebClient | ✅ | Affected |
| R2DBC (reactive DB connections) | ✅ | Affected |
| Spring MVC + RestTemplate | ❌ | Not affected |

Spring WebFlux uses `reactor-netty` by default. Whether you're calling external APIs with WebClient or routing to downstream services in Spring Cloud Gateway, everything goes through Netty's DNS resolver.

> **Using Spring MVC?** If you're on RestTemplate or Apache HttpClient, this problem doesn't occur. Those use the JDK's default DNS resolver.

## The Cause: Why Doesn't Netty Use the System DNS?

```mermaid
flowchart TB
    subgraph SPRING["🖥️ Spring WebFlux"]
        A["WebClient / Gateway<br/>external API call"]
    end
    subgraph NETTY["⚡ Netty DNS Resolver"]
        B{"Native library<br/>present?"}
        C["✅ macOS Native DNS"]
        D["❌ Fallback DNS<br/>reads /etc/resolv.conf"]
    end
    subgraph MACOS["🍎 macOS system DNS"]
        E["VPN DNS server<br/>10.x.x.x"]
        F["Public DNS server<br/>8.8.8.8, etc."]
    end
    subgraph RESULT["Result"]
        G["✅ Internal domain resolved<br/>api.internal.example.com"]
        H["❌ DNS resolution fails<br/>SearchDomainUnknownHostException"]
    end
    A --> B
    B -->|"netty-resolver-dns-native-macos<br/>osx-aarch_64 present"| C
    B -->|"library missing"| D
    C --> E
    D --> F
    E --> G
    F --> H
    style A fill:#dbeafe,color:#0f172a
    style C fill:#c8e6c9,color:#0f172a
    style G fill:#c8e6c9,color:#0f172a
    style D fill:#ffcdd2,color:#0f172a
    style H fill:#ffcdd2,color:#0f172a
    style E fill:#fff9c4,color:#0f172a
    style F fill:#fff9c4,color:#0f172a
```

Netty uses its own DNS resolver. The reason is **performance**.

The JDK's built-in `InetAddress.getByName()` operates in a **blocking** fashion. The thread stalls while waiting for the DNS response. Netty, on the other hand, is built on an asynchronous event loop, so it needs a **non-blocking DNS resolver** that never blocks a thread.

The problem is that on macOS, properly reading the system DNS configuration (especially VPN DNS) requires a **native library**. Without it, Netty falls back to limited sources like `/etc/resolv.conf` and never learns about the VPN DNS server.

> **Why is this only a problem on Apple Silicon?** The `netty-resolver-dns-native-macos` library is split by CPU architecture: there's one build for Intel Macs (`osx-x86_64`) and a separate one for Apple Silicon (`osx-aarch_64`). The catch is that reactor-netty **always includes only the Intel build (`osx-x86_64`)** in its dependencies. On Intel Macs the architecture matches, so everything works — but on Apple Silicon the architecture mismatch makes the native library fail to load. This was discussed in [reactor-netty #2440](https://github.com/reactor/reactor-netty/issues/2440) and is slated to improve in a future version, but for now you have to add it manually.

## The Fix: Add the Native Library

Add the following dependency to `build.gradle.kts`.

```kotlin
dependencies {
    // Add the native library so Netty uses the system DNS resolver on macOS Apple Silicon
    if (System.getProperty("os.name").lowercase().contains("mac") 
        && System.getProperty("os.arch") == "aarch64") {
        runtimeOnly("io.netty:netty-resolver-dns-native-macos::osx-aarch_64")
    }
    
    // existing dependencies...
}
```

If you don't specify a version, Spring Boot's dependency management automatically picks the one matching the Netty version your project uses.

> **Why is there no problem on Intel Macs?** Because the `osx-x86_64` build that reactor-netty includes by default matches the Intel Mac's architecture. Intel Mac users therefore get a working native DNS resolver with no extra configuration.

## Understanding Gradle Dependency Configurations

You might wonder why the code above uses `runtimeOnly`. Here's a summary of Gradle's dependency Configurations.

| Configuration | Used at compile time | Included in JAR | Purpose |
| --- | --- | --- | --- |
| `implementation` | ✅ | ✅ | Libraries you import directly in code |
| `compileOnly` | ✅ | ❌ | Needed only for compilation, provided externally at runtime (Lombok, etc.) |
| `runtimeOnly` | ❌ | ✅ | Never referenced directly in code, detected by the framework at runtime |

```mermaid
flowchart LR
    subgraph SRC["📝 Source code"]
        S[".kt / .java files"]
    end
    subgraph CONF["Dependency Configuration"]
        IMPL["implementation<br/>Compile ✅ · JAR ✅<br/>Used directly in code"]
        CO["compileOnly<br/>Compile ✅ · JAR ❌<br/>Lombok, Servlet API"]
        RO["runtimeOnly<br/>Compile ❌ · JAR ✅<br/>JDBC drivers, Netty Native"]
    end
    subgraph COMPILE["🔨 Compile stage"]
        BC["Bytecode generation<br/>.class files"]
    end
    subgraph PKG["📦 Packaging stage"]
        CLS["BOOT-INF/classes/<br/>compiled classes"]
        LIB["BOOT-INF/lib/<br/>dependency JARs"]
    end
    subgraph RUN["🚀 Runtime"]
        JAR["java -jar app.jar"]
    end
    S --> BC
    BC --> CLS
    CLS --> JAR
    LIB --> JAR
    IMPL -.->|"compile + package"| BC
    IMPL -.->|"compile + package"| LIB
    CO -.->|"compile only"| BC
    RO -.->|"package only"| LIB
    style IMPL fill:#c8e6c9,color:#0f172a
    style CO fill:#fff9c4,color:#0f172a
    style RO fill:#bbdefb,color:#0f172a
```

`netty-resolver-dns-native-macos` is never imported directly in your code. Netty scans the classpath at runtime, detects it, and uses it automatically. That makes `runtimeOnly` the right fit.

> **What's the real benefit of runtimeOnly?** It isn't faster compile times. The point is that it **clearly expresses the intent** that "this library is not used directly," and **turns any accidental direct reference into a compile error**.

### How bootJar Packaging Works

When Spring Boot's `bootJar` task runs, it goes through these steps.

1.  **Compile**: source code (.kt, .java) → bytecode (.class)
2.  **Package**: .class files + dependency JARs → an executable fat JAR

The final JAR structure looks like this.

```text
app.jar
├── BOOT-INF/
│   ├── classes/          ← compiled .class files
│   └── lib/              ← implementation + runtimeOnly dependencies
├── META-INF/
└── org/springframework/boot/loader/
```

Libraries added with `runtimeOnly` also land in `BOOT-INF/lib/`, so they work fine when you run `java -jar app.jar`.

### Caveat: It Depends on the Build Environment

The `if` condition in the Gradle setup above is evaluated **at build time**.

| Build environment | Included in JAR |
| --- | --- |
| Built on macOS Apple Silicon | ✅ Included |
| Built on Linux/Docker | ❌ Not included |

If your CI/CD pipeline runs on Linux, the built JAR won't contain this library. That's fine for local development, but in the unusual case where a CI-built JAR must run on a Mac, you can also drop the `if` condition and always include it. On Linux the library is simply ignored, so there are no side effects.

## Alternative: Fixing It with a JVM Option

You can also solve this with a JVM option alone, without adding any dependency.

```bash
# When running via Gradle
./gradlew bootRun -Dio.netty.resolver.dns.macos.forceSyscall=true

# When running the JAR directly
java -Dio.netty.resolver.dns.macos.forceSyscall=true -jar app.jar
```

If you run from IntelliJ, add it under Run Configuration > VM options.

This option forces Netty to use macOS system calls directly instead of the native library. The downside is that it isn't recorded in the project configuration, making it hard to share across the team, and you have to pass the option every single time.

## Wrap-up

To fix the DNS problem in Spring WebFlux applications on Apple Silicon Macs:

1.  **Understand the cause**: Netty uses its own asynchronous DNS resolver for performance, and without the macOS native library it can't see the VPN DNS
2.  **The fix**: add the `netty-resolver-dns-native-macos` dependency as `runtimeOnly`
3.  **Watch out**: the `if` condition is evaluated at build time, so factor in your CI/CD environment

More and more developers are using Apple Silicon Macs as their development environment. If you use WebClient or Spring Cloud Gateway behind a VPN, I recommend adding this setting to your project ahead of time.

## References

-   [Netty GitHub Issue #11020 – the original Apple Silicon DNS issue](https://github.com/netty/netty/issues/11020)
-   [reactor-netty Issue #2440 – the official Apple Silicon discussion](https://github.com/reactor/reactor-netty/issues/2440)
-   [Netty DNS Resolver API documentation](https://netty.io/4.1/api/io/netty/resolver/dns/package-summary.html)

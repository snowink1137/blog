---
title: 'Spring Boot one-indexed-parameters 옵션의 함정: @PageableDefault는 왜 0으로 설정해야 할까?'
description: 'one-indexed-parameters를 켜면 @PageableDefault(page = 1)이 오히려 두 번째 페이지를 가리키는 함정 — Spring Data 소스 코드와 테스트로 원인을 검증하고 올바른 사용법을 정리한다.'
pubDate: '2026-01-03'
updatedDate: '2026-02-19'
category: tech
tags: ['one-indexed-parameters', 'pageable', 'pageable-default', 'pagination', 'spring-boot', 'spring-data']
---

## 서론

`spring.data.web.pageable.one-indexed-parameters=true` 옵션을 설정하면 페이지 번호가 1부터 시작합니다. 그렇다면 `@PageableDefault`의 page 값도 1로 설정해야 할까요? 결론부터 말씀드리면 **아닙니다**. 이 글에서는 Spring 소스 코드를 직접 분석하며 왜 그런지 정확히 알아보겠습니다.

## one-indexed-parameters 옵션이란?

Spring Data의 Pageable은 기본적으로 0-based 인덱스를 사용합니다. 첫 번째 페이지는 `page=0`입니다. 하지만 프론트엔드나 API 클라이언트 입장에서는 `page=1`이 첫 페이지인 것이 더 직관적일 수 있습니다.

이 문제를 해결하기 위해 Spring Boot는 다음 설정을 제공합니다:

```yaml
spring:
  data:
    web:
      pageable:
        one-indexed-parameters: true
```

이 옵션을 활성화하면 클라이언트가 `?page=1`로 요청했을 때 첫 번째 페이지를 반환합니다. 내부적으로 Spring이 요청 파라미터에서 1을 빼서 0-based 인덱스로 변환해주기 때문입니다.

> **그런데 여기서 흔한 착각이 발생합니다.** “1-indexed 옵션을 켰으니 `@PageableDefault(page = 1)`로 설정해야 첫 페이지가 기본값이 되겠지?”

이 생각은 틀렸습니다. 왜 그런지 [Spring Data Commons 소스 코드](https://github.com/spring-projects/spring-data-commons/blob/main/src/main/java/org/springframework/data/web/PageableHandlerMethodArgumentResolverSupport.java)로 확인해보겠습니다.

## 소스 코드로 보는 동작 원리

먼저 전체 흐름을 다이어그램으로 살펴보겠습니다.

![](/images/spring-one-indexed-parameters-pageable-default/img-01-image-16.png)

다이어그램에서 볼 수 있듯이, **`-1` 변환은 오직 요청 파라미터가 존재할 때만 적용**됩니다. `@PageableDefault`를 통한 기본값은 변환 없이 그대로 사용됩니다.

이제 실제 코드를 살펴보겠습니다. 핵심은 `PageableHandlerMethodArgumentResolverSupport` 클래스에 있습니다. 이 클래스가 HTTP 요청에서 Pageable 객체를 생성하는 역할을 담당합니다.

### 요청 파라미터 파싱: parseAndApplyBoundaries 메서드

```java
private Optional<Integer> parseAndApplyBoundaries(@Nullable String parameter, int upper, boolean shiftIndex) {
    if (!StringUtils.hasText(parameter)) {
        return Optional.empty();  // 파라미터가 없으면 빈 Optional 반환
    }
    try {
        int parsed = Integer.parseInt(parameter) - (oneIndexedParameters && shiftIndex ? 1 : 0);
        return Optional.of(parsed < 0 ? 0 : Math.min(parsed, upper));
    } catch (NumberFormatException e) {
        return Optional.of(0);
    }
}
```

핵심 로직은 이 한 줄입니다:

```java
int parsed = Integer.parseInt(parameter) - (oneIndexedParameters && shiftIndex ? 1 : 0);
```

`oneIndexedParameters`가 `true`이고 `shiftIndex`가 `true`일 때만 파싱된 값에서 1을 뺍니다. 즉, **URL 요청 파라미터(`?page=1`)를 파싱할 때만 `-1` 변환이 적용됩니다.**

### 기본값 처리: getPageable 메서드

```java
protected Pageable getPageable(MethodParameter methodParameter, @Nullable String pageString,
        @Nullable String pageSizeString) {
    
    Optional<Pageable> defaultOrFallback = getDefaultFromAnnotationOrFallback(methodParameter).toOptional();
    Optional<Integer> page = parseAndApplyBoundaries(pageString, Integer.MAX_VALUE, true);
    
    // ...
    
    int p = page
        .orElseGet(() -> defaultOrFallback.map(Pageable::getPageNumber).orElseThrow(IllegalStateException::new));
```

요청 파라미터가 없으면 `page`는 `Optional.empty()`가 됩니다. 이 경우 `defaultOrFallback`에서 페이지 번호를 가져오는데, 여기서 중요한 점은 **`defaultOrFallback.map(Pageable::getPageNumber)`에서 가져온 값은 변환 없이 그대로 사용된다는 것입니다.**

그렇다면 `defaultOrFallback`은 어디서 만들어질까요? `getDefaultFromAnnotationOrFallback(methodParameter)` 메서드 내부에서 `@PageableDefault` 어노테이션이 있는지 확인하고, 있으면 `getDefaultPageRequestFrom()`을 호출해서 Pageable 객체를 생성합니다.

### @PageableDefault 처리: getDefaultPageRequestFrom 메서드

```java
private static Pageable getDefaultPageRequestFrom(MethodParameter parameter,
        MergedAnnotation<PageableDefault> defaults) {
    
    int defaultPageNumber = defaults.getInt("page");  // 어노테이션 값 그대로 가져옴
    int defaultPageSize = defaults.getInt("size");
    
    // ...
    
    return PageRequest.of(defaultPageNumber, defaultPageSize, ...);  // 변환 없이 그대로 사용!
}
```

따라서 `@PageableDefault(page = 1)`로 설정하면 `defaultPageNumber`는 1이 되고, 이 값이 **변환 없이 그대로** `PageRequest.of(1, ...)`에 전달됩니다. 결과적으로 두 번째 페이지가 기본값이 되어버립니다.

> **핵심 정리**: `one-indexed-parameters` 옵션은 오직 `parseAndApplyBoundaries` 메서드에서 **요청 파라미터를 파싱할 때만** 적용됩니다. `@PageableDefault`나 `fallbackPageable` 설정값에는 전혀 영향을 주지 않습니다.

## 테스트 코드로 검증

[Spring Data Commons의 테스트 코드](https://github.com/spring-projects/spring-data-commons/blob/main/src/test/java/org/springframework/data/web/PageableHandlerMethodArgumentResolverUnitTests.java)에서도 이 동작을 확인할 수 있습니다.

### oneIndexedParametersDefaultsIndexOutOfRange 테스트

```java
@Test
void oneIndexedParametersDefaultsIndexOutOfRange() {
    var resolver = getResolver();
    resolver.setOneIndexedParameters(true);
    
    var request = new MockHttpServletRequest();
    request.addParameter("page", "0");  // 1-indexed 모드에서 page=0 요청
    
    var result = resolver.resolveArgument(supportedMethodParameter, null, 
            new ServletWebRequest(request), null);
    
    assertThat(result.getPageNumber()).isEqualTo(0);  // 결과는 0 (첫 페이지)
}
```

이 테스트는 `one-indexed-parameters: true` 상태에서 `page=0`을 요청하면 어떻게 되는지 검증합니다. 계산 결과는 `0 - 1 = -1`이지만, 음수는 0으로 보정되어 첫 페이지가 반환됩니다.

### 직접 검증해보기

다음 컨트롤러로 직접 테스트해볼 수 있습니다:

```java
@RestController
public class PageTestController {

    @GetMapping("/test")
    public Map<String, Object> test(
            @PageableDefault(page = 0, size = 10) Pageable pageable) {
        
        return Map.of(
            "pageNumber", pageable.getPageNumber(),
            "pageSize", pageable.getPageSize()
        );
    }
}
```

`one-indexed-parameters: true` 설정 후:

| 요청 | pageNumber 결과 |
| --- | --- |
| `/test` (파라미터 없음) | 0 (첫 페이지) ✅ |
| `/test?page=1` | 0 (첫 페이지) ✅ |
| `/test?page=2` | 1 (두 번째 페이지) ✅ |

만약 `@PageableDefault(page = 1)`로 설정했다면, 파라미터 없이 요청할 때 `pageNumber`가 1이 되어 **두 번째 페이지가 기본값**이 되어버립니다.

## 올바른 사용법 정리

### ✅ 올바른 설정

```java
@GetMapping("/items")
public Page<Item> getItems(
        @PageableDefault(page = 0, size = 20) Pageable pageable) {
    return itemRepository.findAll(pageable);
}
```

### ❌ 잘못된 설정

```java
@GetMapping("/items")
public Page<Item> getItems(
        @PageableDefault(page = 1, size = 20) Pageable pageable) {  // page=1은 두 번째 페이지!
    return itemRepository.findAll(pageable);
}
```

### 정리표

| 설정 위치 | one-indexed-parameters 영향 | 올바른 값 |
| --- | --- | --- |
| URL 파라미터 (`?page=1`) | ✅ 적용됨 (-1 변환) | 1 = 첫 페이지 |
| `@PageableDefault(page = X)` | ❌ 적용 안됨 | 0 = 첫 페이지 |
| `fallbackPageable` 설정 | ❌ 적용 안됨 | 0 = 첫 페이지 |

> **주의**: `Page` 객체의 `getNumber()` 메서드도 항상 0-based 값을 반환합니다. 클라이언트에게 1-based 페이지 번호를 응답하려면 `page.getNumber() + 1`로 변환해야 합니다.

## 결론

`one-indexed-parameters: true` 옵션은 **클라이언트와의 인터페이스** (요청 파라미터) 에만 영향을 줍니다. Spring 내부에서는 언제나 0-based 인덱스로 동작하며, `@PageableDefault`나 코드에서 직접 생성하는 `PageRequest`는 이 옵션과 무관하게 0부터 시작합니다.

이 동작이 의도된 것임은 Spring Data 메인테이너 Oliver Drotbohm의 [GitHub 코멘트](https://github.com/spring-projects/spring-data-commons/issues/1107)에서도 확인할 수 있습니다:

> “Internally we always work with zero-indexed Pageable instances.”

설정의 편의성을 위해 도입된 옵션이지만, 내부 동작 원리를 정확히 이해하지 않으면 예상치 못한 버그로 이어질 수 있습니다. 소스 코드를 직접 확인하는 습관이 이런 함정을 피하는 가장 확실한 방법입니다.

## 참고 자료

-   [Spring Data Commons – PageableHandlerMethodArgumentResolverSupport.java](https://github.com/spring-projects/spring-data-commons/blob/main/src/main/java/org/springframework/data/web/PageableHandlerMethodArgumentResolverSupport.java)
-   [Spring Data Commons – PageableHandlerMethodArgumentResolverUnitTests.java](https://github.com/spring-projects/spring-data-commons/blob/main/src/test/java/org/springframework/data/web/PageableHandlerMethodArgumentResolverUnitTests.java)
-   [GitHub Issue #1107 – setOneIndexedParameters and setFallbackPageable don’t work together](https://github.com/spring-projects/spring-data-commons/issues/1107)
-   [Spring Boot Application Properties – one-indexed-parameters](https://docs.spring.io/spring-boot/docs/current/reference/html/application-properties.html)

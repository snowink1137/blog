---
title: 'The one-indexed-parameters Trap in Spring Boot: Why @PageableDefault Should Still Be Set to 0'
description: 'Enable one-indexed-parameters and @PageableDefault(page = 1) suddenly points at the second page — tracing the cause through the Spring Data source code and tests, and pinning down the correct usage.'
pubDate: '2026-01-03T17:06:46+09:00'
updatedDate: '2026-01-03T17:06:46+09:00'
category: tech
subcategory: 'Spring'
tags: ['one-indexed-parameters', 'pageable', 'pageable-default', 'pagination', 'spring-boot', 'spring-data']
---

## Introduction

Set the `spring.data.web.pageable.one-indexed-parameters=true` option and page numbers start at 1. So should the `page` value in `@PageableDefault` be set to 1 as well? The short answer is **no**. In this post we'll dig into the Spring source code and figure out exactly why.

## What Is the one-indexed-parameters Option?

Spring Data's Pageable uses 0-based indexing by default: the first page is `page=0`. From the perspective of a frontend or an API client, though, `page=1` being the first page is often more intuitive.

To address this, Spring Boot provides the following setting:

```yaml
spring:
  data:
    web:
      pageable:
        one-indexed-parameters: true
```

With this option enabled, a client requesting `?page=1` gets the first page back. Internally, Spring subtracts 1 from the request parameter to convert it to a 0-based index.

> **And this is where a common misconception creeps in.** "I turned on 1-indexed mode, so I should set `@PageableDefault(page = 1)` to make the first page the default, right?"

That reasoning is wrong. Let's see why by looking at the [Spring Data Commons source code](https://github.com/spring-projects/spring-data-commons/blob/main/src/main/java/org/springframework/data/web/PageableHandlerMethodArgumentResolverSupport.java).

## How It Works, Straight from the Source Code

First, let's look at the overall flow as a diagram.

![Pageable creation flow — when a page parameter is present and one-indexed-parameters=true, page is converted from 1 to 0; when absent, @PageableDefault is used as-is, producing the final PageRequest.of(0, 10)](/images/spring-one-indexed-parameters-pageable-default/img-01-image-16.png)

*Diagram labels are in Korean — the flow reads: HTTP request → "page parameter present?" — if yes, parseAndApplyBoundaries() checks one-indexed-parameters and converts page 1 → 0; if no, @PageableDefault or fallbackPageable is used without conversion; both paths end at creating the Pageable via PageRequest.of(0, 10).*

As the diagram shows, **the `-1` conversion is applied only when the request parameter is present**. Defaults supplied via `@PageableDefault` are used as-is, with no conversion.

Now let's look at the actual code. The heart of it is the `PageableHandlerMethodArgumentResolverSupport` class, which is responsible for building the Pageable object from the HTTP request.

### Parsing the Request Parameter: the parseAndApplyBoundaries Method

```java
private Optional<Integer> parseAndApplyBoundaries(@Nullable String parameter, int upper, boolean shiftIndex) {
    if (!StringUtils.hasText(parameter)) {
        return Optional.empty();  // no parameter — return an empty Optional
    }
    try {
        int parsed = Integer.parseInt(parameter) - (oneIndexedParameters && shiftIndex ? 1 : 0);
        return Optional.of(parsed < 0 ? 0 : Math.min(parsed, upper));
    } catch (NumberFormatException e) {
        return Optional.of(0);
    }
}
```

The core logic is this single line:

```java
int parsed = Integer.parseInt(parameter) - (oneIndexedParameters && shiftIndex ? 1 : 0);
```

It subtracts 1 from the parsed value only when `oneIndexedParameters` is `true` and `shiftIndex` is `true`. In other words, **the `-1` conversion is applied only while parsing the URL request parameter (`?page=1`).**

### Handling Defaults: the getPageable Method

```java
protected Pageable getPageable(MethodParameter methodParameter, @Nullable String pageString,
        @Nullable String pageSizeString) {
    
    Optional<Pageable> defaultOrFallback = getDefaultFromAnnotationOrFallback(methodParameter).toOptional();
    Optional<Integer> page = parseAndApplyBoundaries(pageString, Integer.MAX_VALUE, true);
    
    // ...
    
    int p = page
        .orElseGet(() -> defaultOrFallback.map(Pageable::getPageNumber).orElseThrow(IllegalStateException::new));
```

When the request parameter is absent, `page` is `Optional.empty()`. In that case the page number comes from `defaultOrFallback`, and the crucial point is that **the value obtained via `defaultOrFallback.map(Pageable::getPageNumber)` is used as-is, with no conversion.**

So where does `defaultOrFallback` come from? Inside `getDefaultFromAnnotationOrFallback(methodParameter)`, Spring checks whether a `@PageableDefault` annotation is present, and if so calls `getDefaultPageRequestFrom()` to build the Pageable object.

### Processing @PageableDefault: the getDefaultPageRequestFrom Method

```java
private static Pageable getDefaultPageRequestFrom(MethodParameter parameter,
        MergedAnnotation<PageableDefault> defaults) {
    
    int defaultPageNumber = defaults.getInt("page");  // annotation value taken verbatim
    int defaultPageSize = defaults.getInt("size");
    
    // ...
    
    return PageRequest.of(defaultPageNumber, defaultPageSize, ...);  // used as-is, no conversion!
}
```

So with `@PageableDefault(page = 1)`, `defaultPageNumber` becomes 1, and that value is passed to `PageRequest.of(1, ...)` **verbatim, with no conversion**. The result: the second page becomes your default.

> **Key takeaway**: the `one-indexed-parameters` option applies only inside `parseAndApplyBoundaries`, **only when parsing request parameters**. It has no effect whatsoever on `@PageableDefault` or the `fallbackPageable` setting.

## Verifying with the Test Code

The [Spring Data Commons test code](https://github.com/spring-projects/spring-data-commons/blob/main/src/test/java/org/springframework/data/web/PageableHandlerMethodArgumentResolverUnitTests.java) confirms this behavior as well.

### The oneIndexedParametersDefaultsIndexOutOfRange Test

```java
@Test
void oneIndexedParametersDefaultsIndexOutOfRange() {
    var resolver = getResolver();
    resolver.setOneIndexedParameters(true);
    
    var request = new MockHttpServletRequest();
    request.addParameter("page", "0");  // requesting page=0 in 1-indexed mode
    
    var result = resolver.resolveArgument(supportedMethodParameter, null, 
            new ServletWebRequest(request), null);
    
    assertThat(result.getPageNumber()).isEqualTo(0);  // result is 0 (first page)
}
```

This test verifies what happens when you request `page=0` with `one-indexed-parameters: true`. The computed value is `0 - 1 = -1`, but negatives are clamped to 0, so the first page is returned.

### Trying It Yourself

You can test this directly with the following controller:

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

With `one-indexed-parameters: true` configured:

| Request | Resulting pageNumber |
| --- | --- |
| `/test` (no parameter) | 0 (first page) ✅ |
| `/test?page=1` | 0 (first page) ✅ |
| `/test?page=2` | 1 (second page) ✅ |

Had you set `@PageableDefault(page = 1)` instead, a request without any parameter would yield a `pageNumber` of 1 — making **the second page the default**.

## Correct Usage, Summarized

### ✅ Correct configuration

```java
@GetMapping("/items")
public Page<Item> getItems(
        @PageableDefault(page = 0, size = 20) Pageable pageable) {
    return itemRepository.findAll(pageable);
}
```

### ❌ Incorrect configuration

```java
@GetMapping("/items")
public Page<Item> getItems(
        @PageableDefault(page = 1, size = 20) Pageable pageable) {  // page=1 is the second page!
    return itemRepository.findAll(pageable);
}
```

### Summary Table

| Where it's set | Affected by one-indexed-parameters | Correct value |
| --- | --- | --- |
| URL parameter (`?page=1`) | ✅ Applied (-1 conversion) | 1 = first page |
| `@PageableDefault(page = X)` | ❌ Not applied | 0 = first page |
| `fallbackPageable` setting | ❌ Not applied | 0 = first page |

> **Watch out**: the `getNumber()` method on the `Page` object also always returns a 0-based value. To respond to clients with a 1-based page number, you need to convert it yourself with `page.getNumber() + 1`.

## Conclusion

The `one-indexed-parameters: true` option affects only **the interface with the client** (the request parameters). Internally, Spring always operates on 0-based indexes, and `@PageableDefault` — as well as any `PageRequest` you construct directly in code — starts at 0 regardless of this option.

That this behavior is intentional is confirmed by Spring Data maintainer Oliver Drotbohm in a [GitHub comment](https://github.com/spring-projects/spring-data-commons/issues/1107):

> "Internally we always work with zero-indexed Pageable instances."

The option was introduced as a convenience, but without a precise understanding of how it works internally, it can lead to unexpected bugs. Making a habit of checking the source code directly is the surest way to avoid traps like this one.

## References

-   [Spring Data Commons – PageableHandlerMethodArgumentResolverSupport.java](https://github.com/spring-projects/spring-data-commons/blob/main/src/main/java/org/springframework/data/web/PageableHandlerMethodArgumentResolverSupport.java)
-   [Spring Data Commons – PageableHandlerMethodArgumentResolverUnitTests.java](https://github.com/spring-projects/spring-data-commons/blob/main/src/test/java/org/springframework/data/web/PageableHandlerMethodArgumentResolverUnitTests.java)
-   [GitHub Issue #1107 – setOneIndexedParameters and setFallbackPageable don't work together](https://github.com/spring-projects/spring-data-commons/issues/1107)
-   [Spring Boot Application Properties – one-indexed-parameters](https://docs.spring.io/spring-boot/docs/current/reference/html/application-properties.html)

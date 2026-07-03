# hello world log

소스 코드 of [hello-world-log.com](https://hello-world-log.com). Astro + Cloudflare Workers.

## Stack

- [Astro](https://astro.build/) 6 — 정적 사이트 생성
- [Tailwind CSS](https://tailwindcss.com/) v4 — 스타일링 (+ typography 플러그인)
- [Pretendard](https://github.com/orioncactus/pretendard) — 한글 폰트
- [astro-expressive-code](https://expressive-code.com/) — 코드 블록 (github-light / github-dark 듀얼 테마)
- [Mermaid](https://mermaid.js.org/) — 다이어그램 (클라이언트 렌더, 다크모드 토글에 반응, 다이어그램 있는 글에서만 로드)
- [PhotoSwipe](https://photoswipe.com/) — 이미지·다이어그램 라이트박스 (갤러리 네비게이션 포함)
- [Pagefind](https://pagefind.app/) — 정적 사이트 검색 (빌드 시 인덱싱)

## 디렉토리

```
src/
  astro/              # Astro 전용 컴포넌트·레이아웃 (HIGH 락인)
    components/
    layouts/
  react/              # 포터블 React 컴포넌트 (LOW 락인)
  lib/                # 순수 TS/JS — 커스텀 rehype 플러그인, 클라이언트 스크립트
    rehype-gallery.js         # 연속 이미지 → 갤러리 그리드
    rehype-mermaid-client.js  # ```mermaid → <pre class="mermaid">
    mermaid-client.ts         # mermaid.js 지연 로드 + 테마 반응 렌더
    lightbox.ts               # PhotoSwipe 초기화 (이미지 + SVG)
  pages/              # 파일 = URL
  content/blog/       # 글 (.md / .mdx) — 슬러그가 곧 URL
  styles/             # global.css
  consts.ts           # 사이트 메타
  content.config.ts   # 콘텐츠 스키마 (category: tech|life, tags 필수)
public/
  images/<slug>/      # 글별 이미지
  _redirects          # 301 리다이렉트 (Cloudflare 네이티브 지원)
wrangler.jsonc        # Cloudflare Workers 정적 자산 배포 설정
```

## 명령어

```sh
npm run dev       # http://localhost:4321 (검색은 빌드 후에만 동작)
npm run build     # dist/ 생성 + pagefind 인덱싱
npm run preview   # 빌드 결과 미리보기
```

## 배포

`main` 에 push 하면 Cloudflare Workers Builds 가 자동으로 빌드·배포한다.
로컬에서 직접 배포하려면 `npx wrangler deploy` (wrangler 로그인 필요).

## 글 작성

`src/content/blog/<slug>.md` 파일을 추가하면 `/<slug>/` URL 로 발행된다.

```yaml
---
title: '제목'
description: '검색 결과에 표시될 1-2문장 요약'
pubDate: '2026-01-01'
category: tech   # tech | life
tags: ['kotlin', 'jvm']
---
```

- 연속된 이미지 단락은 자동으로 갤러리 그리드가 된다
- ` ```mermaid ` 코드 블록은 다이어그램으로 렌더된다
- 코드 블록에는 언어를 명시한다 (하이라이트 안 할 출력·로그는 ` ```text `)

## 라이선스

- **코드** (Astro 설정·컴포넌트·플러그인 등): [MIT](./LICENSE)
- **글·이미지** (`src/content/blog/`, `public/images/`): [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — 출처 표기 + 비상업적 사용 + 동일 조건 공유

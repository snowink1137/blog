# hello world log

소스 코드 of [hello-world-log.com](https://hello-world-log.com). Astro + Cloudflare Pages.

## Stack

- [Astro](https://astro.build/) 6 — 정적 사이트 생성
- [Tailwind CSS](https://tailwindcss.com/) v4 — 스타일링
- [Pretendard](https://github.com/orioncactus/pretendard) — 한글 폰트
- [astro-expressive-code](https://expressive-code.com/) — 코드 블록 (github-light / github-dark 듀얼 테마)
- [Mermaid](https://mermaid.js.org/) — 다이어그램 (빌드 타임 SVG, 라이트/다크 듀얼 변형)
- [PhotoSwipe](https://photoswipe.com/) — 이미지·다이어그램 라이트박스
- [Pagefind](https://pagefind.app/) — 정적 사이트 검색

## 디렉토리

```
src/
  astro/              # Astro 전용 컴포넌트·레이아웃 (HIGH 락인)
    components/
    layouts/
  react/              # 포터블 React 컴포넌트 (LOW 락인)
  lib/                # 순수 TS 유틸 + 커스텀 rehype 플러그인
  pages/              # 파일 = URL
  content/blog/       # 글 (.md / .mdx)
  styles/             # global.css
  consts.ts           # 사이트 메타
  content.config.ts   # 콘텐츠 스키마
public/               # 정적 자산
```

## 명령어

```sh
npm run dev       # http://localhost:4321
npm run build     # dist/ + pagefind 인덱스
npm run preview   # 빌드 결과 미리보기
```

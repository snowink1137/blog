// @ts-check

import { readFileSync, readdirSync } from 'node:fs';

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import expressiveCode from 'astro-expressive-code';
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

import rehypeGallery from './src/lib/rehype-gallery.js';
import rehypeMermaidClient from './src/lib/rehype-mermaid-client.js';

// 글 slug → 최종 수정일(updatedDate ?? pubDate) 매핑. sitemap <lastmod> 용.
// frontmatter 포맷이 단순(따옴표 감싼 ISO 문자열)해서 의존성 없이 정규식으로 파싱.
// 날짜 문자열 → sitemap lastmod(UTC ISO). 오프셋이 없으면 KST(+09:00)로 간주해
// 정확한 순간을 보존하면서 빌드 환경(로컬/UTC)에 무관하게 결정론적으로 만든다.
function toLastmod(raw) {
  let s = (raw || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00+09:00';
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) s += '+09:00';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const SITE_URL = 'https://hello-world-log.com';

const lastmodByPath = {};

// 번역된 슬러그 목록 — /en/ 폴백(미번역 원문 복제) URL 을 sitemap 에서 거르고,
// 번역 짝에 hreflang alternate 를 넣는 기준.
let translatedSlugs = new Set();
try {
  translatedSlugs = new Set(
    readdirSync(new URL('./src/content/blog/en/', import.meta.url))
      .filter((f) => /\.mdx?$/.test(f))
      .map((f) => f.replace(/\.mdx?$/, '')),
  );
} catch {
  // en/ 디렉토리가 없으면 번역 0개로 취급
}

// 글: frontmatter updatedDate(없으면 pubDate) 기준. en/ 하위(영어 번역본)도 포함 — /en/<slug>/ 로 매핑됨.
const blogDir = new URL('./src/content/blog/', import.meta.url);
for (const file of readdirSync(blogDir, { recursive: true })) {
  if (!/\.mdx?$/.test(file)) continue;
  const fm = readFileSync(new URL(file, blogDir), 'utf-8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) continue;
  const pub = fm[1].match(/^pubDate:\s*['"]?([^'"\n]+)['"]?\s*$/m);
  const upd = fm[1].match(/^updatedDate:\s*['"]?([^'"\n]+)['"]?\s*$/m);
  const lastmod = toLastmod(upd?.[1] || pub?.[1]);
  if (lastmod) lastmodByPath['/' + file.replace(/\.mdx?$/, '') + '/'] = lastmod;
}

// 정적 콘텐츠 페이지(about·privacy): 페이지 파일 안 `const updatedDate = '...'` 에서 읽음.
// 목록·홈은 자연스러운 수정일이 없어 제외.
const staticPages = {
  '/about/': './src/pages/about.astro',
  '/privacy-policy/': './src/pages/privacy-policy.astro',
};
for (const [urlPath, rel] of Object.entries(staticPages)) {
  const m = readFileSync(new URL(rel, import.meta.url), 'utf-8').match(
    /updatedDate\s*=\s*['"]([^'"]+)['"]/,
  );
  const lastmod = m ? toLastmod(m[1]) : null;
  if (lastmod) lastmodByPath[urlPath] = lastmod;
}

export default defineConfig({
  site: SITE_URL,

  integrations: [
    expressiveCode({
      themes: ['github-light', 'github-dark'],
      themeCssSelector: (theme) => `.${theme.type === 'dark' ? 'dark' : 'light'}`,
      defaultProps: {
        // Long lines scroll horizontally inside the code block instead of
        // wrapping — cleaner reading and no mid-identifier breaks.
        wrap: false,
        preserveIndent: true,
      },
      styleOverrides: {
        codeFontFamily: 'var(--font-mono)',
        borderRadius: '0.5rem',
      },
    }),
    mdx(),
    sitemap({
      // 얇은 아카이브는 사이트맵에서 제외 (해당 페이지는 noindex 처리도 함).
      //  - /tags/*  : 태그 74% 가 글 1개짜리라 색인 가치 없음 (서브카테고리가 주제 허브 역할)
      //  - /page/*  : 페이지네이션. 글은 이미 개별 URL 로 모두 포함됨
      filter: (page) => {
        const p = new URL(page).pathname;
        if (p.startsWith('/tags/') || p.startsWith('/page/')) return false;
        // /en/ 하위 글: 번역된 것만 포함. 폴백 페이지는 canonical 이 원문이라 제외
        const en = p.match(/^\/en\/([^/]+)\/$/);
        if (en) return translatedSlugs.has(en[1]);
        return true;
      },
      // 글 URL 에만 실제 수정일 기반 <lastmod> 부여. 목록·정적 페이지는
      // 정확한 수정일이 없으므로 생략(부정확한 lastmod 는 오히려 신뢰도 저하).
      // 번역 짝(홈 포함)에는 head 와 동일한 hreflang alternate 세트를 함께 기재.
      serialize(item) {
        const p = new URL(item.url).pathname;
        const lastmod = lastmodByPath[p];
        if (lastmod) item.lastmod = lastmod;
        let pair = null;
        if (p === '/' || p === '/en/') pair = { ko: '/', en: '/en/' };
        else {
          const m = p.match(/^\/(?:en\/)?([^/]+)\/$/);
          if (m && translatedSlugs.has(m[1])) pair = { ko: `/${m[1]}/`, en: `/en/${m[1]}/` };
        }
        if (pair) {
          item.links = [
            { lang: 'ko', url: SITE_URL + pair.ko },
            { lang: 'en', url: SITE_URL + pair.en },
            { lang: 'x-default', url: SITE_URL + pair.ko },
          ];
        }
        return item;
      },
    }),
  ],

  markdown: {
    syntaxHighlight: false,
    rehypePlugins: [
      [rehypeGallery, {}],
      [rehypeMermaidClient, {}],
    ],
  },

  vite: {
    plugins: [tailwindcss()],
  },
});

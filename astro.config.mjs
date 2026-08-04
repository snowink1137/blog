// @ts-check

import { readFileSync, readdirSync } from 'node:fs';

import { rehypeHeadingIds } from '@astrojs/markdown-remark';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import expressiveCode from 'astro-expressive-code';
import { defineConfig } from 'astro/config';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
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

// 글: frontmatter updatedDate(없으면 pubDate) 기준. en/ 하위(영어 번역본)도 포함 — /en/<slug>/ 로 매핑됨.
// 같은 순회에서 sitemap 처리용 목록도 수집:
//  - koSlugs / translatedSlugs → 미번역 폴백(/en/<slug>/) URL 판별과 hreflang 짝 기준
//  - enLifeCount → 번역된 life 글이 생기기 전까지 /en/life/ 는 빈 페이지(noindex)라 제외
const koSlugs = new Set();
const translatedSlugs = new Set();
let enLifeCount = 0;
const blogDir = new URL('./src/content/blog/', import.meta.url);
for (const file of readdirSync(blogDir, { recursive: true })) {
  if (!/\.mdx?$/.test(file)) continue;
  const fm = readFileSync(new URL(file, blogDir), 'utf-8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) continue;
  const slugPath = file.replace(/\.mdx?$/, '');
  if (slugPath.startsWith('en/')) {
    translatedSlugs.add(slugPath.slice(3));
    if (/^category:\s*['"]?life['"]?\s*$/m.test(fm[1])) enLifeCount += 1;
  } else {
    koSlugs.add(slugPath);
  }
  const pub = fm[1].match(/^pubDate:\s*['"]?([^'"\n]+)['"]?\s*$/m);
  const upd = fm[1].match(/^updatedDate:\s*['"]?([^'"\n]+)['"]?\s*$/m);
  const lastmod = toLastmod(upd?.[1] || pub?.[1]);
  if (lastmod) lastmodByPath['/' + slugPath + '/'] = lastmod;
}

// 한/영 짝이 있는 정적 페이지 — sitemap hreflang 대상 (head 의 alternates 와 동일하게 유지할 것)
const pairedStatics = new Set(['/about/', '/privacy-policy/', '/tech/', '/search/']);
if (enLifeCount > 0) pairedStatics.add('/life/');

// 정적 콘텐츠 페이지(about·privacy): 페이지 파일 안 `const updatedDate = '...'` 에서 읽음.
// 목록·홈은 자연스러운 수정일이 없어 제외.
const staticPages = {
  '/about/': './src/pages/about.astro',
  '/privacy-policy/': './src/pages/privacy-policy.astro',
  '/en/about/': './src/pages/en/about.astro',
  '/en/privacy-policy/': './src/pages/en/privacy-policy.astro',
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
        const base = p.startsWith('/en/') ? p.slice(3) : p;
        // 얇은 아카이브(태그·페이지네이션)와 디자인 미리보기는 한/영 모두 제외
        if (base.startsWith('/tags/') || base.startsWith('/page/') || base.startsWith('/preview/'))
          return false;
        // 미번역 글의 /en/ 폴백(원문 복제)은 canonical 이 원문이라 제외
        const m = p.match(/^\/en\/([^/]+)\/$/);
        if (m && koSlugs.has(m[1]) && !translatedSlugs.has(m[1])) return false;
        // 번역된 life 글이 없는 동안 /en/life/ 는 빈 페이지(noindex)라 제외
        if (p === '/en/life/' && enLifeCount === 0) return false;
        return true;
      },
      // 글 URL 에만 실제 수정일 기반 <lastmod> 부여. 목록·정적 페이지는
      // 정확한 수정일이 없으므로 생략(부정확한 lastmod 는 오히려 신뢰도 저하).
      // 번역 짝(홈·정적 페이지·번역 글)에는 head 와 동일한 hreflang 세트를 함께 기재.
      serialize(item) {
        const p = new URL(item.url).pathname;
        const lastmod = lastmodByPath[p];
        if (lastmod) item.lastmod = lastmod;
        let pair = null;
        if (p === '/' || p === '/en/') pair = { ko: '/', en: '/en/' };
        else {
          const base = p.startsWith('/en/') ? p.slice(3) : p;
          const m = base.match(/^\/([^/]+)\/$/);
          if (pairedStatics.has(base)) pair = { ko: base, en: `/en${base}` };
          else if (m && translatedSlugs.has(m[1])) pair = { ko: base, en: `/en${base}` };
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
      // Astro 는 유저 rehype 플러그인 "뒤에" 헤딩 id 를 붙이므로, 앵커 링크를 달려면
      // 여기서 먼저 id 를 만들어야 한다. Astro 의 후행 패스는 이미 id 가 있으면 건너뛴다.
      rehypeHeadingIds,
      [
        rehypeAutolinkHeadings,
        {
          behavior: 'append',
          // 제목 텍스트가 이미 링크 이름 역할을 하므로 보조기기에는 숨긴다
          properties: { className: ['heading-anchor'], ariaHidden: 'true', tabIndex: -1 },
          content: { type: 'text', value: '#' },
        },
      ],
      [rehypeGallery, {}],
      [rehypeMermaidClient, {}],
    ],
  },

  vite: {
    plugins: [tailwindcss()],
  },
});

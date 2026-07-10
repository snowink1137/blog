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
const blogDir = new URL('./src/content/blog/', import.meta.url);
const lastmodByPath = {};
for (const file of readdirSync(blogDir)) {
  if (!/\.mdx?$/.test(file)) continue;
  const fm = readFileSync(new URL(file, blogDir), 'utf-8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) continue;
  const pub = fm[1].match(/^pubDate:\s*['"]?([^'"\n]+)['"]?\s*$/m);
  const upd = fm[1].match(/^updatedDate:\s*['"]?([^'"\n]+)['"]?\s*$/m);
  // 워프 시절 날짜는 KST(한국) 벽시계 기준. 오프셋이 없으면 +09:00 을 명시해
  // 정확한 순간을 보존하면서 빌드 환경(로컬/UTC)에 무관하게 결정론적으로 만든다.
  let dateStr = (upd?.[1] || pub?.[1] || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) dateStr += 'T00:00:00+09:00';
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(dateStr)) dateStr += '+09:00';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) continue;
  lastmodByPath['/' + file.replace(/\.mdx?$/, '') + '/'] = d.toISOString();
}

export default defineConfig({
  site: 'https://hello-world-log.com',

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
        return !p.startsWith('/tags/') && !p.startsWith('/page/');
      },
      // 글 URL 에만 실제 수정일 기반 <lastmod> 부여. 목록·정적 페이지는
      // 정확한 수정일이 없으므로 생략(부정확한 lastmod 는 오히려 신뢰도 저하).
      serialize(item) {
        const lastmod = lastmodByPath[new URL(item.url).pathname];
        if (lastmod) item.lastmod = lastmod;
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

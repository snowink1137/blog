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
  // 날짜 부분(YYYY-MM-DD)만 잘라 W3C 날짜로 사용. Date 변환 시 타임존에 따라
  // 하루씩 밀려 빌드 환경마다 값이 달라지므로, 벽시계 날짜를 그대로 보존.
  const dateStr = (upd?.[1] || pub?.[1] || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
  lastmodByPath['/' + file.replace(/\.mdx?$/, '') + '/'] = dateStr;
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

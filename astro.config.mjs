// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import expressiveCode from 'astro-expressive-code';
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

import rehypeGallery from './src/lib/rehype-gallery.js';
import rehypeMermaidDual from './src/lib/rehype-mermaid-dual.js';

export default defineConfig({
  site: 'https://hello-world-log.com',

  integrations: [
    expressiveCode({
      themes: ['github-light', 'github-dark'],
      themeCssSelector: (theme) => `.${theme.type === 'dark' ? 'dark' : 'light'}`,
      defaultProps: {
        wrap: true,
        preserveIndent: true,
      },
      styleOverrides: {
        codeFontFamily: 'var(--font-mono)',
        borderRadius: '0.5rem',
      },
    }),
    mdx(),
    sitemap(),
  ],

  markdown: {
    syntaxHighlight: false,
    rehypePlugins: [
      [rehypeGallery, {}],
      [
        rehypeMermaidDual,
        {
          lightTheme: 'default',
          darkTheme: 'dark',
        },
      ],
    ],
  },

  vite: {
    plugins: [tailwindcss()],
  },
});

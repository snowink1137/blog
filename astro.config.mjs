// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import expressiveCode from 'astro-expressive-code';
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

import rehypeGallery from './src/lib/rehype-gallery.js';
import rehypeMermaidClient from './src/lib/rehype-mermaid-client.js';

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
    sitemap(),
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

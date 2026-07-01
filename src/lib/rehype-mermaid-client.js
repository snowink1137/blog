import { toText } from 'hast-util-to-text';
import { parse } from 'space-separated-tokens';
import { visitParents } from 'unist-util-visit-parents';

/**
 * Convert fenced ```mermaid code blocks into <pre class="mermaid">…</pre>
 * so that mermaid.js can find and render them at runtime in the browser.
 * This replaces the build-time rehype-mermaid-dual approach (which needed a
 * playwright chromium binary that Cloudflare's build container can't launch).
 */

function isMermaidCode(element) {
  if (element.type !== 'element' || element.tagName !== 'code') return false;
  let className = element.properties?.className;
  if (typeof className === 'string') className = parse(className);
  if (!Array.isArray(className)) return false;
  return className.includes('language-mermaid');
}

export default function rehypeMermaidClient() {
  return function transformer(tree) {
    visitParents(tree, 'element', (node, ancestors) => {
      if (!isMermaidCode(node)) return;
      const parent = ancestors.at(-1);
      if (parent.type !== 'element' || parent.tagName !== 'pre') return;
      const grand = ancestors.at(-2);
      if (!grand || !Array.isArray(grand.children)) return;

      const source = toText(node, { whitespace: 'pre' });
      const idx = grand.children.indexOf(parent);
      grand.children[idx] = {
        type: 'element',
        tagName: 'pre',
        properties: { className: ['mermaid'] },
        children: [{ type: 'text', value: source }],
      };
    });
  };
}

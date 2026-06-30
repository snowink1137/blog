import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic';
import { toText } from 'hast-util-to-text';
import { createMermaidRenderer } from 'mermaid-isomorphic';
import { parse } from 'space-separated-tokens';
import { visitParents } from 'unist-util-visit-parents';

function isMermaidCode(element) {
  if (element.tagName !== 'code') return false;
  let className = element.properties?.className;
  if (typeof className === 'string') className = parse(className);
  if (!Array.isArray(className)) return false;
  return className.includes('language-mermaid');
}

function svgToHast(svgString, themeClass) {
  const root = fromHtmlIsomorphic(svgString, { fragment: true });
  const svgNode = root.children.find((c) => c.tagName === 'svg');
  if (!svgNode) return null;
  svgNode.properties = svgNode.properties || {};
  const existing = Array.isArray(svgNode.properties.className) ? svgNode.properties.className : [];
  svgNode.properties.className = [...existing, themeClass];
  return svgNode;
}

export default function rehypeMermaidDual(options = {}) {
  const lightTheme = options.lightTheme ?? 'default';
  const darkTheme = options.darkTheme ?? 'dark';
  const renderDiagrams = createMermaidRenderer(options);

  return async function transformer(ast) {
    const instances = [];

    visitParents(ast, 'element', (node, ancestors) => {
      if (!isMermaidCode(node)) return;
      const parent = ancestors.at(-1);
      if (parent.type !== 'element' || parent.tagName !== 'pre') return;
      instances.push({
        diagram: toText(node, { whitespace: 'pre' }),
        preNode: parent,
        preParent: ancestors.at(-2),
      });
    });

    if (!instances.length) return;

    const diagrams = instances.map((i) => i.diagram);

    const [lightResults, darkResults] = await Promise.all([
      renderDiagrams(diagrams, {
        ...options,
        mermaidConfig: { ...(options.mermaidConfig ?? {}), theme: lightTheme },
        prefix: 'mermaid-light',
      }),
      renderDiagrams(diagrams, {
        ...options,
        mermaidConfig: { ...(options.mermaidConfig ?? {}), theme: darkTheme },
        prefix: 'mermaid-dark',
      }),
    ]);

    for (let i = 0; i < instances.length; i++) {
      const { preNode, preParent } = instances[i];
      const lightRes = lightResults[i];
      const darkRes = darkResults[i];
      if (lightRes.status !== 'fulfilled' || darkRes.status !== 'fulfilled') continue;

      const lightSvg = svgToHast(lightRes.value.svg, 'mermaid-light');
      const darkSvg = svgToHast(darkRes.value.svg, 'mermaid-dark');
      if (!lightSvg || !darkSvg) continue;

      const wrapper = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['mermaid-wrapper'] },
        children: [lightSvg, darkSvg],
      };

      const idx = preParent.children.indexOf(preNode);
      preParent.children[idx] = wrapper;
    }
  };
}

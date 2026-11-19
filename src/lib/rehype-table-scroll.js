import { visitParents } from 'unist-util-visit-parents';

/**
 * Wrap each body table in <div class="table-scroll"> so a wide table can scroll
 * horizontally on its own. html/body use `overflow-x: clip`, so without a
 * wrapper the overflowing columns are simply cut off and unreachable.
 *
 * Why a wrapper instead of `display: block; overflow-x: auto` on the table
 * itself: that switches the table's width from Typography's 100% to
 * content-based, which silently reflows every existing table on the blog.
 */
export default function rehypeTableScroll() {
  return function transformer(tree) {
    visitParents(tree, 'element', (node, ancestors) => {
      if (node.tagName !== 'table') return;
      const parent = ancestors.at(-1);
      if (!parent || !Array.isArray(parent.children)) return;
      // 이미 감싼 표는 건너뛴다 (중첩 방지)
      const cn = parent.properties?.className;
      if (Array.isArray(cn) && cn.includes('table-scroll')) return;
      const idx = parent.children.indexOf(node);
      if (idx === -1) return;
      parent.children[idx] = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['table-scroll'] },
        children: [node],
      };
    });
  };
}

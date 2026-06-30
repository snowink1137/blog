/**
 * Group consecutive paragraphs that contain only an image into a gallery container.
 * Whitespace text nodes between image paragraphs are transparent (preserved as separators
 * if no gallery forms, otherwise consumed into the gallery group).
 */
function isImageOnlyParagraph(node) {
  if (node?.type !== 'element' || node.tagName !== 'p') return false;
  const meaningful = (node.children || []).filter((c) => {
    if (c.type === 'text') return c.value.trim() !== '';
    return true;
  });
  if (meaningful.length !== 1) return false;
  return Boolean(findImage(meaningful[0]));
}

function findImage(node) {
  if (!node) return null;
  if (node.type === 'element' && node.tagName === 'img') return node;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const found = findImage(c);
      if (found) return found;
    }
  }
  return null;
}

function isWhitespaceText(node) {
  return node?.type === 'text' && node.value.trim() === '';
}

export default function rehypeGallery() {
  return function transformer(tree) {
    const visit = (node) => {
      if (!Array.isArray(node.children)) return;

      const children = node.children;
      const out = [];
      let i = 0;

      while (i < children.length) {
        if (isImageOnlyParagraph(children[i])) {
          const groupIndices = [i];
          let k = i + 1;
          while (k < children.length) {
            if (isImageOnlyParagraph(children[k])) {
              groupIndices.push(k);
              k++;
              continue;
            }
            if (isWhitespaceText(children[k])) {
              let m = k + 1;
              while (m < children.length && isWhitespaceText(children[m])) m++;
              if (m < children.length && isImageOnlyParagraph(children[m])) {
                k = m;
                continue;
              }
            }
            break;
          }

          if (groupIndices.length >= 2) {
            const imgs = groupIndices
              .map((idx) => findImage(children[idx]))
              .filter(Boolean);
            out.push({
              type: 'element',
              tagName: 'div',
              properties: { className: ['gallery'] },
              children: imgs,
            });
            i = k;
            continue;
          }
        }

        const child = children[i];
        out.push(child);
        if (child.type === 'element') visit(child);
        i++;
      }

      node.children = out;
    };

    visit(tree);
  };
}

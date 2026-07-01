import mermaid from 'mermaid';

const themeFor = (isDark: boolean) => (isDark ? 'dark' : 'default');

const initAndRun = () => {
  const isDark = document.documentElement.classList.contains('dark');
  mermaid.initialize({
    startOnLoad: false,
    theme: themeFor(isDark),
    securityLevel: 'strict',
    fontFamily: 'inherit',
  });
  void mermaid.run({ querySelector: 'pre.mermaid' });
};

const rerender = async () => {
  const isDark = document.documentElement.classList.contains('dark');
  const nodes = document.querySelectorAll<HTMLElement>('pre.mermaid');
  if (nodes.length === 0) return;

  nodes.forEach((node) => {
    const src = node.getAttribute('data-mermaid-source');
    if (src) {
      node.removeAttribute('data-processed');
      node.textContent = src;
    }
  });

  mermaid.initialize({
    startOnLoad: false,
    theme: themeFor(isDark),
    securityLevel: 'strict',
    fontFamily: 'inherit',
  });
  await mermaid.run({ nodes });
};

document.querySelectorAll<HTMLElement>('pre.mermaid').forEach((node) => {
  node.setAttribute('data-mermaid-source', node.textContent ?? '');
});

initAndRun();

const themeObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === 'attributes' && m.attributeName === 'class') {
      void rerender();
      return;
    }
  }
});

themeObserver.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['class'],
});

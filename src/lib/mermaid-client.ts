import mermaid from 'mermaid';

const themeFor = (isDark: boolean) => (isDark ? 'dark' : 'default');

const bodyFontFamily = () =>
  getComputedStyle(document.body).fontFamily || 'sans-serif';

const configFor = (isDark: boolean) => ({
  startOnLoad: false as const,
  theme: themeFor(isDark),
  securityLevel: 'strict' as const,
  fontFamily: bodyFontFamily(),
  // htmlLabels wrap flowchart labels in <foreignObject><div>… Chrome treats that
  // region as an interactive HTML block on mobile and hijacks the page's
  // pinch-zoom / scroll gesture. Plain SVG text labels stay out of the way.
  flowchart: { htmlLabels: false },
});

const initAndRun = () => {
  const isDark = document.documentElement.classList.contains('dark');
  mermaid.initialize(configFor(isDark));
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

  mermaid.initialize(configFor(isDark));
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

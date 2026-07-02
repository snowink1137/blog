// mermaid.js is ~600KB. Only load it if the current post actually has a
// diagram to render — most posts don't.
const diagrams = document.querySelectorAll<HTMLElement>('pre.mermaid');
if (diagrams.length > 0) {
  diagrams.forEach((node) => {
    node.setAttribute('data-mermaid-source', node.textContent ?? '');
  });

  const themeFor = (isDark: boolean) => (isDark ? 'dark' : 'default');

  const configFor = (isDark: boolean) => ({
    startOnLoad: false as const,
    theme: themeFor(isDark),
    securityLevel: 'strict' as const,
    fontFamily: getComputedStyle(document.body).fontFamily || 'sans-serif',
  });

  const { default: mermaid } = await import('mermaid');

  const render = async () => {
    const isDark = document.documentElement.classList.contains('dark');
    const nodes = document.querySelectorAll<HTMLElement>('pre.mermaid');
    nodes.forEach((node) => {
      const src = node.getAttribute('data-mermaid-source');
      if (!src) return;
      node.removeAttribute('data-processed');
      node.textContent = src;
    });
    mermaid.initialize(configFor(isDark));
    await mermaid.run({ nodes });
  };

  await render();

  new MutationObserver((mutations) => {
    if (mutations.some((m) => m.attributeName === 'class')) void render();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
}

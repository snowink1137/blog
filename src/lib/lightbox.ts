import PhotoSwipeLightbox from 'photoswipe/lightbox';
import 'photoswipe/style.css';

const lightbox = new PhotoSwipeLightbox({
  pswpModule: () => import('photoswipe'),
  wheelToZoom: true,
  initialZoomLevel: 'fit',
  secondaryZoomLevel: 2,
  maxZoomLevel: 4,
  bgOpacity: 0.9,
});

lightbox.init();

type SlideData = {
  src: string;
  width: number;
  height: number;
  alt: string;
  element?: HTMLElement;
  msrc?: string;
};

const imgToSlide = (img: HTMLImageElement): SlideData => ({
  src: img.currentSrc || img.src,
  width: img.naturalWidth || img.width,
  height: img.naturalHeight || img.height,
  alt: img.alt,
  element: img,
});

const center = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

const openImage = (img: HTMLImageElement) => {
  const gallery = img.closest('.gallery');
  if (gallery) {
    const imgs = Array.from(gallery.querySelectorAll('img'));
    const slides = imgs.map(imgToSlide);
    const index = imgs.indexOf(img);
    lightbox.loadAndOpen(index, slides, center(img));
  } else {
    lightbox.loadAndOpen(0, [imgToSlide(img)], center(img));
  }
};

const openSvg = (svg: SVGSVGElement) => {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.removeAttribute('style');
  const xml = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  const w = vb[2] || svg.clientWidth || 1280;
  const h = vb[3] || svg.clientHeight || 720;
  lightbox.on('close', () => URL.revokeObjectURL(url), { once: true });
  lightbox.loadAndOpen(
    0,
    [{ src: url, width: w, height: h, msrc: url, alt: 'diagram', element: svg }],
    center(svg),
  );
};

document
  .querySelectorAll<HTMLImageElement>('article .prose img, article .prose .gallery img')
  .forEach((img) => {
    img.style.cursor = 'zoom-in';
    img.addEventListener('click', () => openImage(img));
  });

const bindMermaidClicks = () => {
  document
    .querySelectorAll<SVGSVGElement>('article .prose pre.mermaid svg')
    .forEach((svg) => {
      if (svg.dataset.lightboxBound === '1') return;
      svg.dataset.lightboxBound = '1';
      svg.addEventListener('click', () => openSvg(svg));
    });
};

// Bind now (in case SSR already produced SVGs) and again after mermaid renders.
bindMermaidClicks();

const mermaidObserver = new MutationObserver(bindMermaidClicks);
document.querySelectorAll('article .prose pre.mermaid').forEach((el) => {
  mermaidObserver.observe(el, { childList: true, subtree: true });
});

/**
 * 프리뷰 전용 교정 모드 — 본문 블록에 ¶번호를 붙인다.
 *
 * 글을 다듬을 때 "어느 문장"인지 지목하는 비용을 없애는 게 목적이다.
 * 번호만 말하면 되고, 정확한 문장을 보내야 할 때는 번호를 탭하면
 * `¶17 ...` 형태로 클립보드에 들어간다.
 *
 * *.workers.dev 프리뷰와 로컬 dev 에서만 동작한다. 프로덕션 도메인에서는
 * 즉시 반환하므로 hello-world-log.com 에는 아무 영향이 없다.
 * 머지 전에 BlogPost.astro 의 import 와 이 파일을 함께 지운다.
 */

const host = location.hostname;
const enabled =
  host.endsWith('.workers.dev') || host === 'localhost' || host === '127.0.0.1';

if (enabled) {
  const CSS = `
  .pa-badge {
    display: inline-block;
    min-width: 2.1em;
    margin-right: .45em;
    padding: 0 .35em;
    border-radius: .3rem;
    font: 600 .72rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #b45309;
    background: #fef3c7;
    border: 1px solid #fcd34d;
    cursor: pointer;
    user-select: none;
    vertical-align: .12em;
    transition: background .12s, color .12s;
  }
  .pa-badge:hover { background: #fde68a; }
  .pa-badge.pa-done { color: #065f46; background: #d1fae5; border-color: #6ee7b7; }
  html.dark .pa-badge, .dark .pa-badge {
    color: #fcd34d; background: #422006; border-color: #92400e;
  }
  html.dark .pa-badge.pa-done, .dark .pa-badge.pa-done {
    color: #6ee7b7; background: #022c22; border-color: #065f46;
  }
  @media (min-width: 1100px) {
    .pa-block { position: relative; }
    .pa-block > .pa-badge:first-child {
      position: absolute;
      left: -3.1rem;
      margin-right: 0;
      text-align: right;
    }
  }
  .pa-sel {
    position: absolute;
    z-index: 60;
    padding: .3rem .55rem;
    border-radius: .4rem;
    font: 600 .75rem/1 system-ui, sans-serif;
    color: #fff;
    background: #0f766e;
    border: none;
    cursor: pointer;
    box-shadow: 0 2px 8px rgb(0 0 0 / .25);
  }
  .pa-hint {
    position: fixed;
    right: .75rem;
    bottom: .75rem;
    z-index: 60;
    max-width: 17rem;
    padding: .5rem .7rem;
    border-radius: .45rem;
    font: 500 .76rem/1.5 system-ui, sans-serif;
    color: #fff;
    background: rgb(15 23 42 / .92);
    box-shadow: 0 2px 10px rgb(0 0 0 / .3);
    transition: opacity .4s;
  }
  @media print { .pa-badge, .pa-sel, .pa-hint { display: none !important; } }
  `;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const prose = document.querySelector('.prose');
  if (prose) {
    // 번호를 붙일 블록. 표·코드블록은 교정 대상이 아니라 제외한다.
    const SEL = 'p, li, h2, h3, h4, blockquote';
    const blocks: HTMLElement[] = [];
    prose.querySelectorAll<HTMLElement>(SEL).forEach((el) => {
      if (el.closest('table, pre, figure, .expressive-code')) return;
      // 중첩 방지: 이미 번호가 붙은 블록 안이면 건너뛴다 (blockquote > p 등)
      if (blocks.some((b) => b.contains(el))) return;
      if (!el.textContent?.trim()) return;
      blocks.push(el);
    });

    const text = (el: HTMLElement) =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim();

    const copy = async (s: string, badge: HTMLElement) => {
      try {
        await navigator.clipboard.writeText(s);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = s;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      const was = badge.textContent;
      badge.classList.add('pa-done');
      badge.textContent = '복사됨';
      setTimeout(() => {
        badge.classList.remove('pa-done');
        badge.textContent = was;
      }, 900);
    };

    blocks.forEach((el, i) => {
      const n = i + 1;
      el.classList.add('pa-block');
      el.dataset.paNum = String(n);
      const badge = document.createElement('span');
      badge.className = 'pa-badge';
      badge.textContent = `¶${n}`;
      badge.title = '탭하면 이 단락이 번호와 함께 복사됩니다';
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        copy(`¶${n} ${text(el)}`, badge);
      });
      // blockquote 는 내부 첫 블록에 넣는다
      const target =
        el.tagName === 'BLOCKQUOTE'
          ? (el.querySelector('p') as HTMLElement | null) ?? el
          : el;
      target.insertBefore(badge, target.firstChild);
    });

    // 선택한 문장만 보내고 싶을 때: 선택 영역 옆에 복사 버튼
    let selBtn: HTMLButtonElement | null = null;
    const clearSel = () => {
      selBtn?.remove();
      selBtn = null;
    };
    document.addEventListener('selectionchange', () => {
      const sel = document.getSelection();
      const s = sel?.toString().trim();
      if (!sel || !s || s.length < 2) return clearSel();
      const anchor = sel.anchorNode;
      const host2 =
        anchor instanceof Element
          ? anchor
          : (anchor?.parentElement as Element | null);
      const block = host2?.closest<HTMLElement>('.pa-block');
      if (!block || !prose.contains(block)) return clearSel();
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) return clearSel();
      if (!selBtn) {
        selBtn = document.createElement('button');
        selBtn.className = 'pa-sel';
        document.body.appendChild(selBtn);
        selBtn.addEventListener('mousedown', (e) => e.preventDefault());
        selBtn.addEventListener('click', () => {
          const n = block.dataset.paNum;
          const picked = document.getSelection()?.toString().trim() ?? s;
          navigator.clipboard
            .writeText(`¶${n} "${picked}"`)
            .catch(() => undefined);
          selBtn!.textContent = '복사됨';
          setTimeout(clearSel, 700);
        });
      }
      selBtn.textContent = `¶${block.dataset.paNum} 선택 복사`;
      selBtn.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
      selBtn.style.top = `${rect.bottom + window.scrollY + 6}px`;
    });

    const hint = document.createElement('div');
    hint.className = 'pa-hint';
    hint.textContent = `교정 모드 — 본문 블록 ${blocks.length}개에 번호를 붙였습니다. 번호만 말해도 되고, ¶를 탭하면 그 단락이 복사됩니다.`;
    document.body.appendChild(hint);
    hint.addEventListener('click', () => hint.remove());
    setTimeout(() => {
      hint.style.opacity = '0';
      setTimeout(() => hint.remove(), 500);
    }, 6000);
  }
}

/**
 * 프리뷰 교정 모드 — 본문 블록에 ¶번호를 붙이고 그 자리에서 의견을 적는다.
 *
 * 글을 다듬을 때 "어느 부분"인지 지목하는 비용을 없애는 상시 도구다.
 * 흐름: ¶번호 탭 → 그 블록 밑에 메모칸 → 적고 저장 → 다 적었으면 한 번에
 * 복사하거나 텔레그램으로 보낸다. 저장은 브라우저 localStorage 라서
 * 새로고침해도 남고, 서버·바인딩·외부 요청은 하나도 없다.
 *
 * 번호 대상: 문단·목록·소제목·인용 + 표·코드블록·다이어그램·이미지.
 * 앞의 넷은 배지를 블록 안에 넣고, 뒤의 넷은 안에 넣을 수 없으니 래퍼를
 * 씌워 왼쪽 여백(좁은 화면에서는 위쪽)에 올린다.
 *
 * 로드 조건: BlogPost.astro 가 *.workers.dev · localhost 에서만 이 모듈을
 * 동적 import 한다. 프로덕션 도메인은 이 파일을 내려받지도 않는다.
 * 아래 게이트는 혹시 직접 import 되는 경우를 막는 이중 안전장치다.
 */

const host = location.hostname;
const enabled =
  host.endsWith('.workers.dev') || host === 'localhost' || host === '127.0.0.1';

type Note = { text: string; quote: string; excerpt: string };

if (enabled) {
  const KEY = `pa-notes:${location.pathname}`;

  const load = (): Record<string, Note> => {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? '{}');
    } catch {
      return {};
    }
  };
  const save = (n: Record<string, Note>) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(n));
    } catch {
      /* 사생활 보호 모드 등 — 저장만 안 되고 동작은 유지 */
    }
  };
  let notes = load();

  const CSS = `
  .pa-badge {
    display: inline-block; min-width: 2.1em; margin-right: .45em; padding: 0 .35em;
    border-radius: .3rem; font: 600 .72rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #b45309; background: #fef3c7; border: 1px solid #fcd34d;
    cursor: pointer; user-select: none; vertical-align: .12em;
    transition: background .12s, color .12s;
  }
  .pa-badge:hover { background: #fde68a; }
  .pa-badge.pa-has { color: #065f46; background: #d1fae5; border-color: #6ee7b7; }
  .dark .pa-badge { color: #fcd34d; background: #422006; border-color: #92400e; }
  .dark .pa-badge.pa-has { color: #6ee7b7; background: #022c22; border-color: #065f46; }
  .pa-wrap { position: relative; }
  .pa-wrap > .pa-badge:first-child { margin: 0 0 .3rem; }
  @media (min-width: 1100px) {
    .pa-block { position: relative; }
    .pa-block > .pa-badge:first-child,
    .pa-wrap > .pa-badge:first-child {
      position: absolute; left: -3.1rem; top: .1rem;
      margin: 0; text-align: right;
    }
  }
  .pa-box {
    margin: .6rem 0 1rem; padding: .7rem .8rem; border-radius: .5rem;
    border: 1px solid #fcd34d; background: #fffbeb;
    font: 400 .85rem/1.6 system-ui, sans-serif; color: #1f2937;
  }
  .dark .pa-box { border-color: #92400e; background: #1c1917; color: #e5e7eb; }
  .pa-box-quote {
    margin: 0 0 .45rem; padding-left: .55rem; border-left: 3px solid #fcd34d;
    font-size: .8rem; color: #78716c;
  }
  .dark .pa-box-quote { color: #a8a29e; }
  .pa-box textarea {
    width: 100%; min-height: 4.2rem; padding: .45rem .55rem; border-radius: .35rem;
    border: 1px solid #d6d3d1; background: #fff; color: inherit;
    font: inherit; resize: vertical;
  }
  .dark .pa-box textarea { background: #0c0a09; border-color: #44403c; }
  .pa-row { display: flex; gap: .4rem; align-items: center; margin-top: .45rem; flex-wrap: wrap; }
  .pa-btn {
    padding: .3rem .6rem; border-radius: .35rem; border: 1px solid transparent;
    font: 600 .78rem/1.3 system-ui, sans-serif; cursor: pointer;
  }
  .pa-btn-main { color: #fff; background: #0f766e; }
  .pa-btn-sub { color: #44403c; background: #e7e5e4; }
  .dark .pa-btn-sub { color: #e7e5e4; background: #3f3f46; }
  .pa-btn-del { color: #b91c1c; background: transparent; }
  .pa-hintkey { margin-left: auto; font: 400 .72rem/1.3 system-ui, sans-serif; color: #a8a29e; }
  .pa-sel {
    position: absolute; z-index: 60; padding: .3rem .55rem; border-radius: .4rem;
    font: 600 .75rem/1 system-ui, sans-serif; color: #fff; background: #0f766e;
    border: none; cursor: pointer; box-shadow: 0 2px 8px rgb(0 0 0 / .25);
  }
  .pa-dock {
    position: fixed; right: .75rem; bottom: .75rem; z-index: 70;
    width: min(21rem, calc(100vw - 1.5rem));
    border-radius: .5rem; overflow: hidden;
    background: rgb(15 23 42 / .96); color: #f8fafc;
    font: 500 .78rem/1.5 system-ui, sans-serif;
    box-shadow: 0 4px 16px rgb(0 0 0 / .35);
  }
  .pa-dock-head { display: flex; gap: .5rem; align-items: center; padding: .5rem .7rem; cursor: pointer; }
  .pa-dock-n { padding: 0 .4rem; border-radius: 999px; background: #0f766e; font-weight: 700; }
  .pa-dock-body { display: none; border-top: 1px solid rgb(255 255 255 / .12); }
  .pa-dock.pa-open .pa-dock-body { display: block; }
  .pa-list { max-height: 15rem; overflow: auto; padding: .35rem 0; }
  .pa-item {
    display: block; width: 100%; text-align: left; padding: .35rem .7rem;
    border: none; background: transparent; color: #e2e8f0; cursor: pointer;
    font: 400 .76rem/1.45 system-ui, sans-serif;
  }
  .pa-item:hover { background: rgb(255 255 255 / .08); }
  .pa-item b { color: #5eead4; }
  .pa-dock-row { display: flex; gap: .4rem; padding: .5rem .7rem; flex-wrap: wrap; }
  .pa-flash { outline: 2px solid #14b8a6; outline-offset: 3px; border-radius: .25rem; }
  @media print { .pa-badge, .pa-sel, .pa-dock, .pa-box { display: none !important; } }
  `;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const prose = document.querySelector('.prose');
  if (prose) {
    // 문단형 + 덩어리형을 한 번에, 문서 순서대로 모은다.
    const SEL =
      'p, li, h2, h3, h4, blockquote, table, pre.mermaid, .expressive-code, figure, .gallery';
    const blocks: HTMLElement[] = [];
    prose.querySelectorAll<HTMLElement>(SEL).forEach((el) => {
      if (blocks.some((b) => b.contains(el))) return; // 중첩 방지
      if (!el.textContent?.trim() && !el.querySelector('img, svg')) return;
      blocks.push(el);
    });

    /** 배지를 안에 넣을 수 없는 덩어리 — 래퍼를 씌운다 */
    const isBig = (el: HTMLElement) =>
      el.tagName === 'TABLE' ||
      el.tagName === 'FIGURE' ||
      el.classList.contains('expressive-code') ||
      el.classList.contains('mermaid') ||
      el.classList.contains('gallery');

    /** 배지·메모칸을 뺀 순수 본문 텍스트 */
    const blockText = (el: HTMLElement) => {
      const c = el.cloneNode(true) as HTMLElement;
      c.querySelectorAll('.pa-badge, .pa-box, script, style, link').forEach((x) =>
        x.remove(),
      );
      return (c.textContent ?? '').replace(/\s+/g, ' ').trim();
    };

    /** 목록·독에 쓸 짧은 꼬리표 — 덩어리는 종류를 먼저 밝힌다 */
    const label = (el: HTMLElement) => {
      if (el.tagName === 'TABLE') {
        const row = el.querySelector('thead tr, tr');
        const cells = row
          ? Array.from(row.children)
              .map((c) => (c.textContent ?? '').trim())
              .filter(Boolean)
              .join(' · ')
          : '';
        return `[표] ${cells}`.slice(0, 70);
      }
      if (el.classList.contains('mermaid')) return '[다이어그램]';
      if (el.classList.contains('expressive-code')) {
        const first = blockText(el).split('\n')[0];
        return `[코드] ${first}`.slice(0, 70);
      }
      if (el.tagName === 'FIGURE' || el.classList.contains('gallery')) {
        const img = el.querySelector('img');
        return `[이미지] ${img?.alt ?? ''}`.slice(0, 70);
      }
      return blockText(el).slice(0, 60);
    };

    const copyText = async (s: string) => {
      try {
        await navigator.clipboard.writeText(s);
        return true;
      } catch {
        try {
          const ta = document.createElement('textarea');
          ta.value = s;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          return true;
        } catch {
          return false;
        }
      }
    };

    const byNum = new Map<string, HTMLElement>();
    const badges = new Map<string, HTMLElement>();

    // ---- 모아 보기 패널 -----------------------------------------------
    const dock = document.createElement('div');
    dock.className = 'pa-dock';
    dock.innerHTML = `
      <div class="pa-dock-head"><span class="pa-dock-n">0</span><span class="pa-dock-t">교정 의견</span><span style="margin-left:auto;opacity:.6">▲</span></div>
      <div class="pa-dock-body">
        <div class="pa-list"></div>
        <div class="pa-dock-row">
          <button class="pa-btn pa-btn-main" data-act="copy">전체 복사</button>
          <button class="pa-btn pa-btn-sub" data-act="tg">텔레그램으로 보내기</button>
          <button class="pa-btn pa-btn-del" data-act="clear">전체 삭제</button>
        </div>
      </div>`;
    document.body.appendChild(dock);
    const dockN = dock.querySelector('.pa-dock-n') as HTMLElement;
    const dockT = dock.querySelector('.pa-dock-t') as HTMLElement;
    const dockList = dock.querySelector('.pa-list') as HTMLElement;
    dock.querySelector('.pa-dock-head')!.addEventListener('click', () =>
      dock.classList.toggle('pa-open'),
    );

    const exportText = () => {
      const keys = Object.keys(notes).sort((a, b) => +a - +b);
      return [
        `[교정 의견 ${keys.length}건] ${document.title}`,
        '',
        ...keys.flatMap((k) => {
          const n = notes[k];
          const head = n.quote ? `¶${k} "${n.quote}"` : `¶${k} ${n.excerpt}`;
          return [head, `→ ${n.text}`, ''];
        }),
      ]
        .join('\n')
        .trim();
    };

    const refreshDock = () => {
      const keys = Object.keys(notes).sort((a, b) => +a - +b);
      dockN.textContent = String(keys.length);
      dockT.textContent = keys.length ? '교정 의견' : '교정 의견 (아직 없음)';
      dockList.innerHTML = '';
      keys.forEach((k) => {
        const b = document.createElement('button');
        b.className = 'pa-item';
        b.innerHTML = `<b>¶${k}</b> ${notes[k].text.replace(/[<>&]/g, '')}`;
        b.addEventListener('click', () => {
          const el = byNum.get(k);
          if (!el) return;
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('pa-flash');
          setTimeout(() => el.classList.remove('pa-flash'), 1400);
        });
        dockList.appendChild(b);
      });
      badges.forEach((bd, k) => bd.classList.toggle('pa-has', !!notes[k]));
    };

    dock.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'clear') {
          if (!confirm('적어 둔 의견을 전부 지웁니다.')) return;
          notes = {};
          save(notes);
          refreshDock();
          return;
        }
        if (!Object.keys(notes).length) {
          btn.textContent = '적은 게 없어요';
          setTimeout(refreshDock, 1200);
          return;
        }
        const body = exportText();
        if (act === 'copy') {
          const ok = await copyText(body);
          const was = btn.textContent;
          btn.textContent = ok ? '복사됨' : '복사 실패';
          setTimeout(() => (btn.textContent = was), 1100);
        } else {
          const url = `https://t.me/share/url?url=${encodeURIComponent(
            location.href,
          )}&text=${encodeURIComponent(body)}`;
          if (url.length > 7500) {
            await copyText(body);
            alert('의견이 길어서 공유 링크 대신 클립보드에 복사했습니다.');
            return;
          }
          window.open(url, '_blank', 'noopener');
        }
      });
    });

    // ---- 메모칸 -------------------------------------------------------
    const placeBox = (el: HTMLElement, box: HTMLElement) => {
      // 래퍼가 있으면 그 안의 맨 끝 — 표는 .table-scroll 안에 있으므로
      // closest 로 올라가야 가로 스크롤 영역 바깥에 메모칸이 놓인다.
      const w = el.closest('.pa-wrap');
      if (w) w.appendChild(box);
      else if (el.tagName === 'LI') el.appendChild(box);
      else el.insertAdjacentElement('afterend', box);
    };

    const openBox = (el: HTMLElement, num: string, quote = '') => {
      const existing = (el.closest('.pa-wrap') ?? el.parentElement)?.querySelector<HTMLElement>(
        `.pa-box[data-for="${num}"]`,
      );
      if (existing) {
        const ta = existing.querySelector('textarea') as HTMLTextAreaElement;
        if (quote) {
          existing.dataset.quote = quote;
          const q = existing.querySelector('.pa-box-quote') as HTMLElement;
          q.textContent = `"${quote}"`;
          q.style.display = '';
        }
        ta.focus();
        return;
      }
      const prev = notes[num];
      const box = document.createElement('div');
      box.className = 'pa-box';
      box.dataset.for = num;
      box.dataset.quote = quote || prev?.quote || '';
      box.innerHTML = `
        <div class="pa-box-quote"></div>
        <textarea placeholder="¶${num} 에 대한 의견 — 어디가 어떻게 걸리는지 짧게"></textarea>
        <div class="pa-row">
          <button class="pa-btn pa-btn-main" data-b="save">저장</button>
          <button class="pa-btn pa-btn-sub" data-b="close">닫기</button>
          ${prev ? '<button class="pa-btn pa-btn-del" data-b="del">삭제</button>' : ''}
          <span class="pa-hintkey">⌘/Ctrl + Enter 저장 · Esc 닫기</span>
        </div>`;
      const q = box.querySelector('.pa-box-quote') as HTMLElement;
      const qv = box.dataset.quote;
      if (qv) q.textContent = `"${qv}"`;
      else q.style.display = 'none';

      const ta = box.querySelector('textarea') as HTMLTextAreaElement;
      ta.value = prev?.text ?? '';

      const close = () => box.remove();
      const commit = () => {
        const v = ta.value.trim();
        if (v) {
          notes[num] = {
            text: v,
            quote: box.dataset.quote ?? '',
            excerpt: label(el),
          };
        } else {
          delete notes[num];
        }
        save(notes);
        refreshDock();
        close();
      };
      box.querySelector('[data-b="save"]')!.addEventListener('click', commit);
      box.querySelector('[data-b="close"]')!.addEventListener('click', close);
      box.querySelector('[data-b="del"]')?.addEventListener('click', () => {
        delete notes[num];
        save(notes);
        refreshDock();
        close();
      });
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          close();
        }
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault();
          commit();
        }
      });

      placeBox(el, box);
      ta.focus();
    };

    blocks.forEach((el, i) => {
      const num = String(i + 1);
      el.classList.add('pa-block');
      el.dataset.paNum = num;
      byNum.set(num, el);

      const badge = document.createElement('span');
      badge.className = 'pa-badge';
      badge.textContent = `¶${num}`;
      badge.title = '탭하면 여기에 의견을 적습니다';
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openBox(el, num);
      });
      badges.set(num, badge);

      if (isBig(el)) {
        // 표·코드블록·다이어그램·이미지: 래퍼를 씌워 배지를 바깥에 둔다.
        // 표는 .table-scroll(가로 스크롤 컨테이너) 안에 있으니 그 컨테이너째로
        // 감싼다 — 안쪽에 두면 왼쪽 여백의 배지가 잘리고 스크롤 폭만 늘어난다.
        const outer = el.parentElement?.classList.contains('table-scroll')
          ? el.parentElement
          : el;
        const wrap = document.createElement('div');
        wrap.className = 'pa-wrap';
        outer.parentNode?.insertBefore(wrap, outer);
        wrap.appendChild(outer);
        wrap.insertBefore(badge, wrap.firstChild);
      } else {
        const target =
          el.tagName === 'BLOCKQUOTE'
            ? (el.querySelector('p') as HTMLElement | null) ?? el
            : el;
        target.insertBefore(badge, target.firstChild);
      }
    });

    // ---- 문장(또는 표 칸)을 집어서 바로 의견 적기 -----------------------
    let selBtn: HTMLButtonElement | null = null;
    const clearSel = () => {
      selBtn?.remove();
      selBtn = null;
    };
    document.addEventListener('selectionchange', () => {
      const sel = document.getSelection();
      const s = sel?.toString().replace(/\s+/g, ' ').trim();
      if (!sel || !s || s.length < 2) return clearSel();
      const a = sel.anchorNode;
      const el0 = a instanceof Element ? a : (a?.parentElement as Element | null);
      const block = el0?.closest<HTMLElement>('.pa-block');
      if (!block || !prose.contains(block) || el0?.closest('.pa-box'))
        return clearSel();
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) return clearSel();
      const num = block.dataset.paNum!;
      if (!selBtn) {
        selBtn = document.createElement('button');
        selBtn.className = 'pa-sel';
        document.body.appendChild(selBtn);
        selBtn.addEventListener('mousedown', (e) => e.preventDefault());
        selBtn.addEventListener('click', () => {
          const picked =
            document.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? s;
          const n = selBtn!.dataset.num!;
          clearSel();
          openBox(byNum.get(n)!, n, picked.slice(0, 120));
        });
      }
      selBtn.dataset.num = num;
      selBtn.textContent = `¶${num} 여기에 의견 적기`;
      selBtn.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
      selBtn.style.top = `${rect.bottom + window.scrollY + 6}px`;
    });

    refreshDock();
    if (Object.keys(notes).length) dock.classList.add('pa-open');
  }
}

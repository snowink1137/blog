import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';

// OG 카드는 빌드 타임에만 그린다. Cloudflare 빌드 컨테이너가 chromium 을 못 띄우므로
// 브라우저 없이 동작하는 satori(레이아웃→SVG) + resvg(SVG→PNG) 조합을 쓴다.
// 폰트 경로는 process.cwd()(=프로젝트 루트) 기준 — import.meta.url 은 빌드 후
// dist/.prerender/chunks 로 잡혀서 상대 경로가 깨진다.
const FONT_DIR = join(process.cwd(), 'fonts');
const bold = readFileSync(join(FONT_DIR, 'Pretendard-Bold.otf'));
const regular = readFileSync(join(FONT_DIR, 'Pretendard-Regular.otf'));

const BG = '#020617'; // slate-950 — 사이트 다크 배경
const ACCENT = '#0071df'; // --color-accent (oklch(0.55 0.20 250))
const TEXT = '#f8fafc';
const MUTED = '#94a3b8';

export const OG_SIZE = { width: 1200, height: 630 };

export interface OgCardInput {
  title: string;
  siteTitle: string;
  /** "Tech · AWS" 처럼 이미 조합된 문자열 */
  category?: string;
  /** 카드 하단 우측에 붙는 도메인 표기 */
  domain?: string;
}

/**
 * satori 는 JSX 대신 순수 객체 트리도 받는다 (이 프로젝트엔 JSX 런타임이 없어 객체로 구성).
 * 자식이 없으면 `children` 키 자체를 넣지 않는다 — 빈 배열을 주면 satori 가 "자식이 여럿인데
 * display 가 없다"고 오판해서 렌더가 실패한다.
 */
function h(type: string, props: Record<string, unknown>, ...children: unknown[]) {
  const child =
    children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
  return { type, props: child === undefined ? { ...props } : { ...props, children: child } };
}

function card({ title, siteTitle, category, domain }: OgCardInput) {
  return h(
    'div',
    {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: BG,
        padding: '64px 72px',
        // 좌측 액센트 바
        borderLeft: `16px solid ${ACCENT}`,
      },
    },
    // 상단: 사이트명
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '16px' } },
      h('div', {
        style: { width: '14px', height: '14px', borderRadius: '999px', background: ACCENT },
      }),
      h(
        'div',
        {
          style: { fontFamily: 'PretendardBold', fontSize: '30px', color: TEXT, letterSpacing: '-0.5px' },
        },
        siteTitle,
      ),
    ),
    // 중앙: 제목
    h(
      'div',
      {
        style: {
          display: 'flex',
          fontFamily: 'PretendardBold',
          fontSize: title.length > 46 ? '58px' : '70px',
          lineHeight: 1.28,
          color: TEXT,
          letterSpacing: '-1.5px',
          // 4줄 넘어가면 잘라냄
          maxHeight: '360px',
          overflow: 'hidden',
        },
      },
      title,
    ),
    // 하단: 카테고리 + 도메인
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
      category
        ? h(
            'div',
            {
              style: {
                display: 'flex',
                fontFamily: 'PretendardRegular',
                fontSize: '26px',
                color: ACCENT,
                border: `2px solid ${ACCENT}`,
                borderRadius: '999px',
                padding: '8px 22px',
              },
            },
            category,
          )
        : h('div', { style: { display: 'flex' } }, ''),
      h(
        'div',
        { style: { display: 'flex', fontFamily: 'PretendardRegular', fontSize: '26px', color: MUTED } },
        domain ?? '',
      ),
    ),
  );
}

export async function renderOgPng(input: OgCardInput): Promise<Uint8Array> {
  const svg = await satori(card(input) as Parameters<typeof satori>[0], {
    ...OG_SIZE,
    fonts: [
      { name: 'PretendardBold', data: bold, weight: 700, style: 'normal' },
      { name: 'PretendardRegular', data: regular, weight: 400, style: 'normal' },
    ],
  });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: OG_SIZE.width } })
    .render()
    .asPng();
  return new Uint8Array(png);
}

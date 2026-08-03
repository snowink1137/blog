import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { SITE_DESCRIPTION, SITE_TITLE } from '../../consts';
import { renderOgPng } from '../../lib/og';

// 글마다 OG 카드 PNG 를 빌드 타임에 하나씩 굽는다.
// 한국어 글은 /og/<slug>.png, 영어 번역본은 id 가 'en/<slug>' 라 /og/en/<slug>.png 가 된다.
// 목록·정적 페이지용으로는 /og/site.png · /og/en/site.png 를 함께 만든다.
export async function getStaticPaths() {
  const posts = await getCollection('blog');
  const postPaths = posts.map((post) => ({
    params: { slug: post.id },
    props: {
      title: post.data.title,
      category: [post.data.category === 'tech' ? 'Tech' : 'Life', post.data.subcategory]
        .filter(Boolean)
        .join(' · '),
    },
  }));
  return [
    ...postPaths,
    { params: { slug: 'site' }, props: { title: SITE_DESCRIPTION, category: '' } },
    {
      params: { slug: 'en/site' },
      props: {
        title: 'Dev notes on AWS, JVM, Kubernetes, Spring and more.',
        category: '',
      },
    },
  ];
}

export const GET: APIRoute = async ({ props }) => {
  const png = await renderOgPng({
    title: props.title as string,
    siteTitle: SITE_TITLE,
    category: props.category as string,
    domain: 'hello-world-log.com',
  });
  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};

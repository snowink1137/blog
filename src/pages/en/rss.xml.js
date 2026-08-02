import { getCollection } from 'astro:content';
import rss from '@astrojs/rss';
import { SITE_TITLE } from '../../consts';
import { isEnPost } from '../../lib/posts';

export async function GET(context) {
  const posts = (await getCollection('blog'))
    .filter((post) => isEnPost(post))
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
  return rss({
    title: `${SITE_TITLE} — English`,
    description: 'Dev notes on AWS, JVM, Kubernetes, Spring and more.',
    site: context.site,
    items: posts.map((post) => ({
      ...post.data,
      // id 가 'en/<slug>' 라 /en/<slug>/ 링크가 된다
      link: `/${post.id}/`,
    })),
  });
}

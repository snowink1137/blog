import { getCollection, type CollectionEntry } from 'astro:content';

export const POSTS_PER_PAGE = 10;

/** 영어 번역본(en/ 하위)인지 — 한국어 목록·태그·RSS 에서 제외할 때 사용 */
export function isEnPost(post: CollectionEntry<'blog'>): boolean {
  return post.id.startsWith('en/');
}

export async function getSortedPosts(): Promise<CollectionEntry<'blog'>[]> {
  const posts = await getCollection('blog');
  return posts
    .filter((post) => !isEnPost(post))
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/**
 * 영어 홈(/en/) 목록. koOnly(한국 특화) 글은 제외.
 * 번역이 있으면 영어 항목을, 없으면 한국어 항목을 KO 표시와 함께 — 링크는 항상 /en/ 프리픽스.
 */
export async function getEnListing(): Promise<
  { post: CollectionEntry<'blog'>; href: string; translated: boolean }[]
> {
  const posts = await getCollection('blog');
  const enById = new Map(posts.filter(isEnPost).map((p) => [p.id.slice(3), p]));
  return posts
    .filter((post) => !isEnPost(post) && !post.data.koOnly)
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf())
    .map((ko) => {
      const en = enById.get(ko.id);
      return { post: en ?? ko, href: `/en/${ko.id}/`, translated: Boolean(en) };
    });
}

/** tech 글의 서브카테고리 목록을 글 수 내림차순으로 반환 */
export async function getTechSubcategories(): Promise<{ name: string; count: number }[]> {
  const posts = await getSortedPosts();
  const counts = new Map<string, number>();
  for (const post of posts) {
    if (post.data.category !== 'tech' || !post.data.subcategory) continue;
    counts.set(post.data.subcategory, (counts.get(post.data.subcategory) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

import { getCollection, type CollectionEntry } from 'astro:content';

export const POSTS_PER_PAGE = 10;

export type Locale = 'ko' | 'en';

/** 영어 번역본(en/ 하위)인지 — 한국어 목록·태그·RSS 에서 제외할 때 사용 */
export function isEnPost(post: CollectionEntry<'blog'>): boolean {
  return post.id.startsWith('en/');
}

/** locale 별 글 목록 (최신순). ko = 한국어 원문만, en = 번역본만 */
export async function getSortedPosts(locale: Locale = 'ko'): Promise<CollectionEntry<'blog'>[]> {
  const posts = await getCollection('blog');
  return posts
    .filter((post) => (locale === 'en' ? isEnPost(post) : !isEnPost(post)))
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** tech 글의 서브카테고리 목록을 글 수 내림차순으로 반환 */
export async function getTechSubcategories(
  locale: Locale = 'ko',
): Promise<{ name: string; count: number }[]> {
  const posts = await getSortedPosts(locale);
  const counts = new Map<string, number>();
  for (const post of posts) {
    if (post.data.category !== 'tech' || !post.data.subcategory) continue;
    counts.set(post.data.subcategory, (counts.get(post.data.subcategory) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

import { getCollection, type CollectionEntry } from 'astro:content';

export const POSTS_PER_PAGE = 10;

export async function getSortedPosts(): Promise<CollectionEntry<'blog'>[]> {
  const posts = await getCollection('blog');
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

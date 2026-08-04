import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
  loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      pubDate: z.coerce.date(),
      updatedDate: z.coerce.date().optional(),
      heroImage: z.optional(image()),
      category: z.enum(['tech', 'life']),
      subcategory: z.string().optional(),
      tags: z.array(z.string()).default([]),
      // 한국 특화 글(연말정산·K패스 등) — 영어 목록(/en/)에 노출하지 않음. 폴백 URL 은 생성됨
      koOnly: z.boolean().default(false),
    }),
});

export const collections = { blog };

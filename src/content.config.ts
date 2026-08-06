import { glob } from 'astro/loaders'
import { defineCollection } from 'astro:content'
import { z } from 'astro/zod'

const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: ({ image }) =>
    z.object({
      title: z
        .string()
        .max(
          60,
          'Title should be 60 characters or less for optimal Open Graph display.',
        ),
      description: z
        .string()
        .max(
          155,
          'Description should be 155 characters or less for optimal Open Graph display.',
        ),
      date: z.coerce.date(),
      image: image().optional(),
      imageAlt: z
        .string()
        .min(
          1,
          'Authored alternative text is required when a hero image is used.',
        )
        .optional(),
      tags: z.array(z.string()).optional(),
      authors: z.array(z.string()).optional(),
      lang: z.enum(['en', 'zh', 'ko', 'ja']).optional(),
      translationKey: z.string().optional(),
      translationStatus: z.enum(['machine', 'edited', 'final']).optional(),
      translationSource: z
        .enum(['codex', 'human', 'imported-legacy'])
        .optional(),
      draft: z.boolean().optional(),
    }),
})

const authors = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/authors' }),
  schema: z.object({
    name: z.string(),
    pronouns: z.string().optional(),
    avatar: z.url(),
    bio: z.string().optional(),
    mail: z.email().optional(),
    website: z.url().optional(),
    twitter: z.url().optional(),
    github: z.url().optional(),
    linkedin: z.url().optional(),
    youtube: z.url().optional(),
    facebook: z.url().optional(),
    instagram: z.url().optional(),
    discord: z.url().optional(),
  }),
})

const projects = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/projects' }),
  schema: ({ image }) =>
    z.object({
      name: z.string(),
      description: z.string(),
      tags: z.array(z.string()),
      image: image(),
      link: z.url(),
    }),
})

export const collections = { blog, authors, projects }

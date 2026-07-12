import { z } from 'zod'

const textNode = z.object({
  id: z.string().min(1),
  type: z.enum(['heading', 'paragraph', 'quote']),
  text: z.string().min(1),
  level: z.number().int().min(1).max(3).optional(),
  source: z.string().min(1),
})

const figureNode = z.object({
  id: z.string().min(1),
  type: z.literal('figure'),
  title: z.string().min(1),
  caption: z.string().min(1),
  source: z.string().min(1),
  relationships: z.object({ caption: z.string().min(1) }),
})

export const researchPaperSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  status: z.enum(['working', 'review', 'published']),
  title: z.string().min(1),
  subtitle: z.string().min(1),
  authors: z.array(z.string().min(1)).min(1),
  updated: z.string().date(),
  abstract: z.string().min(1),
  nodes: z.array(z.discriminatedUnion('type', [textNode, figureNode])).min(1),
})

export type ResearchPaper = z.infer<typeof researchPaperSchema>
export type ResearchNode = ResearchPaper['nodes'][number]

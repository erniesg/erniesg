import { z } from 'zod'
import {
  canonicalContentHash,
  type ResearchNode,
  type ResearchPaper,
} from './schema'

export const layoutManifestSchemaVersion = '1.0.0' as const

const targetIdSchema = z.enum(['mobile', 'paperProMove', 'paperPro', 'print'])
const diagnosticCodeSchema = z.enum([
  'CONTENT_FRAGMENTED',
  'CONSTRAINT_VIOLATION',
  'VARIANT_FALLBACK',
])

const diagnosticSchema = z
  .object({
    code: diagnosticCodeSchema,
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string().min(1),
  })
  .strict()

const flowPlacementSchema = z
  .object({
    kind: z.literal('flow'),
    order: z.number().int().nonnegative(),
  })
  .strict()

const geometryPlacementSchema = z
  .object({
    kind: z.literal('geometry'),
    page: z.number().int().positive().optional(),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict()

const wholePlacementSchema = z.discriminatedUnion('kind', [
  flowPlacementSchema,
  geometryPlacementSchema,
])

const fragmentedPlacementSchema = z
  .object({
    kind: z.literal('fragments'),
    items: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            placement: wholePlacementSchema,
          })
          .strict(),
      )
      .min(2),
  })
  .strict()
  .superRefine((fragmented, context) => {
    const indices = fragmented.items.map((fragment) => fragment.index)
    const expected = fragmented.items.map((_, index) => index)
    if (indices.some((index, position) => index !== expected[position])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message:
          'Fragment indices must be unique, ordered, and contiguous from zero',
      })
    }
  })

const placementSchema = z.union([
  flowPlacementSchema,
  geometryPlacementSchema,
  fragmentedPlacementSchema,
])

const targetProfileSchema = z
  .object({
    id: targetIdSchema,
    label: z.string().min(1),
    medium: z.enum(['screen', 'e-ink', 'print']),
    flow: z.enum(['continuous', 'finite']),
    dimensions: z
      .object({
        unit: z.enum(['css-px', 'device-px', 'mm']),
        width: z.number().positive(),
        height: z.number().positive().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((target, context) => {
    if (target.flow === 'finite' && target.dimensions.height === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dimensions', 'height'],
        message: 'Finite targets require a height',
      })
    }
  })

const manifestEntrySchema = z
  .object({
    target: targetIdSchema,
    nodeId: z.string().min(1),
    nodeType: z.enum(['heading', 'paragraph', 'quote', 'figure', 'caption']),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.string().min(1),
    relationships: z.record(z.string(), z.string().min(1)),
    variant: z
      .object({
        name: z.string().min(1),
        selection: z.enum(['preferred', 'fallback']),
      })
      .strict(),
    placement: placementSchema,
    diagnostics: z.array(diagnosticSchema),
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      entry.variant.selection === 'fallback' &&
      !entry.diagnostics.some(
        (diagnostic) => diagnostic.code === 'VARIANT_FALLBACK',
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['diagnostics'],
        message: 'Fallback variants require a VARIANT_FALLBACK diagnostic',
      })
    }
    if (
      entry.placement.kind === 'fragments' &&
      !entry.diagnostics.some(
        (diagnostic) => diagnostic.code === 'CONTENT_FRAGMENTED',
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['diagnostics'],
        message: 'Fragmented entries require a CONTENT_FRAGMENTED diagnostic',
      })
    }
  })

const renditionSchema = z
  .object({
    target: targetProfileSchema,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    entries: z.array(manifestEntrySchema).min(1),
    diagnostics: z.array(diagnosticSchema),
  })
  .strict()
  .superRefine((rendition, context) => {
    const seen = new Set<string>()
    for (const [index, entry] of rendition.entries.entries()) {
      if (entry.target !== rendition.target.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entries', index, 'target'],
          message: `Entry target ${entry.target} does not match rendition target ${rendition.target.id}`,
        })
      }
      if (seen.has(entry.nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entries', index, 'nodeId'],
          message: `Duplicate rendition node: ${entry.nodeId}`,
        })
      }
      seen.add(entry.nodeId)
    }
  })

export const layoutManifestSchema = z
  .object({
    schemaVersion: z.literal(layoutManifestSchemaVersion),
    document: z.string().min(1),
    version: z.string().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    generatedAt: z.string().date(),
    renditions: z.array(renditionSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>()
    for (const [index, rendition] of manifest.renditions.entries()) {
      if (seen.has(rendition.target.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['renditions', index, 'target', 'id'],
          message: `Duplicate rendition target: ${rendition.target.id}`,
        })
      }
      seen.add(rendition.target.id)
    }
  })

export type LayoutManifest = z.infer<typeof layoutManifestSchema>
export type TargetId = z.infer<typeof targetIdSchema>

export const targetProfiles = [
  {
    id: 'mobile',
    label: 'Continuous mobile',
    medium: 'screen',
    flow: 'continuous',
    dimensions: { unit: 'css-px', width: 390 },
  },
  {
    id: 'paperProMove',
    label: 'reMarkable Paper Pro Move',
    medium: 'e-ink',
    flow: 'finite',
    dimensions: { unit: 'device-px', width: 954, height: 1696 },
  },
  {
    id: 'paperPro',
    label: 'reMarkable Paper Pro',
    medium: 'e-ink',
    flow: 'finite',
    dimensions: { unit: 'device-px', width: 1620, height: 2160 },
  },
  {
    id: 'print',
    label: 'A4 print',
    medium: 'print',
    flow: 'finite',
    dimensions: { unit: 'mm', width: 210, height: 297 },
  },
] as const

function relationshipsFor(node: ResearchNode): Record<string, string> {
  return node.type === 'figure' ? { caption: node.relationships.caption } : {}
}

function preferredVariant(node: ResearchNode) {
  switch (node.type) {
    case 'heading':
      return 'section-heading'
    case 'paragraph':
      return 'body'
    case 'quote':
      return 'blockquote'
    case 'figure':
      return 'inline'
    case 'caption':
      return 'figure-caption'
  }
}

export function buildLayoutManifest(paper: ResearchPaper): LayoutManifest {
  const contentHash = canonicalContentHash(paper)
  const manifest = {
    schemaVersion: layoutManifestSchemaVersion,
    document: paper.id,
    version: paper.version,
    contentHash,
    generatedAt: paper.updated,
    renditions: targetProfiles.map((target) => ({
      target,
      contentHash,
      entries: paper.nodes.map((node, order) => ({
        target: target.id,
        nodeId: node.id,
        nodeType: node.type,
        contentHash: canonicalContentHash(node),
        source: node.source,
        relationships: relationshipsFor(node),
        variant: {
          name: preferredVariant(node),
          selection: 'preferred' as const,
        },
        placement: { kind: 'flow' as const, order },
        diagnostics: [],
      })),
      diagnostics: [],
    })),
  }

  return validateLayoutManifest(paper, manifest)
}

export function validateLayoutManifest(
  paper: ResearchPaper,
  input: unknown,
): LayoutManifest {
  const manifest = layoutManifestSchema.parse(input)
  const errors: string[] = []
  const expectedDocumentHash = canonicalContentHash(paper)
  const expectedTargets = new Set<TargetId>(
    targetProfiles.map((target) => target.id),
  )

  if (manifest.document !== paper.id)
    errors.push(`Document id changed: ${manifest.document}`)
  if (manifest.version !== paper.version)
    errors.push(`Document version changed: ${manifest.version}`)
  if (manifest.contentHash !== expectedDocumentHash)
    errors.push('Manifest content hash does not match canonical content')
  if (manifest.generatedAt !== paper.updated)
    errors.push('Manifest generation date does not match canonical update date')

  for (const rendition of manifest.renditions) {
    expectedTargets.delete(rendition.target.id)
    if (rendition.contentHash !== expectedDocumentHash) {
      errors.push(
        `Rendition ${rendition.target.id} content hash does not match canonical content`,
      )
    }

    const entriesById = new Map(
      rendition.entries.map((entry) => [entry.nodeId, entry]),
    )
    for (const [order, node] of paper.nodes.entries()) {
      const entry = entriesById.get(node.id)
      if (!entry) {
        errors.push(
          `Rendition ${rendition.target.id} omitted canonical node ${node.id}`,
        )
        continue
      }
      if (entry.nodeType !== node.type) {
        errors.push(
          `Rendition ${rendition.target.id} changed type for ${node.id}`,
        )
      }
      if (entry.contentHash !== canonicalContentHash(node)) {
        errors.push(
          `Rendition ${rendition.target.id} changed content hash for ${node.id}`,
        )
      }
      if (entry.source !== node.source) {
        errors.push(
          `Rendition ${rendition.target.id} changed provenance for ${node.id}`,
        )
      }
      if (
        JSON.stringify(entry.relationships) !==
        JSON.stringify(relationshipsFor(node))
      ) {
        errors.push(
          `Rendition ${rendition.target.id} changed relationships for ${node.id}`,
        )
      }
      if (entry.placement.kind === 'flow' && entry.placement.order !== order) {
        errors.push(
          `Rendition ${rendition.target.id} changed flow order for ${node.id}`,
        )
      }
    }

    for (const entry of rendition.entries) {
      if (!paper.nodes.some((node) => node.id === entry.nodeId)) {
        errors.push(
          `Rendition ${rendition.target.id} contains unknown node ${entry.nodeId}`,
        )
      }
      for (const relatedId of Object.values(entry.relationships)) {
        if (!entriesById.has(relatedId)) {
          errors.push(
            `Rendition ${rendition.target.id} lost relationship target ${relatedId}`,
          )
        }
      }
    }
  }

  for (const target of expectedTargets)
    errors.push(`Missing rendition target: ${target}`)
  if (errors.length > 0) throw new Error(errors.join('\n'))

  return manifest
}

export function serializeLayoutManifest(manifest: LayoutManifest) {
  return `${JSON.stringify(layoutManifestSchema.parse(manifest), null, 2)}\n`
}

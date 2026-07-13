import { z } from 'zod'
import {
  canonicalContentHash,
  canonicalNodeContentHash,
  type ResearchNode,
  type ResearchPaper,
} from './schema'

export const LAYOUT_MANIFEST_VERSION = '1.0.0' as const
export const LAYOUT_TARGETS = [
  'mobile',
  'paperProMove',
  'paperPro',
  'print',
] as const

const canonicalId = z.string().min(1)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)

export const layoutDiagnosticCodeSchema = z.enum([
  'constraint-violation',
  'layout-overflow',
  'unsupported-content',
  'variant-unavailable',
])

const diagnosticSchema = z
  .object({
    code: layoutDiagnosticCodeSchema,
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string().min(1),
  })
  .strict()

const placementSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('flow'),
      order: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('geometry'),
      units: z.enum(['css-px', 'device-px', 'mm']),
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
      page: z.number().int().nonnegative().optional(),
    })
    .strict(),
])

const fragmentSchema = z
  .object({
    id: canonicalId,
    index: z.number().int().nonnegative(),
    placement: placementSchema,
  })
  .strict()

const representationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('whole'),
      placement: placementSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('fragments'),
      fragments: z.array(fragmentSchema).min(2),
    })
    .strict(),
])

const relationshipValueSchema = z.union([
  canonicalId,
  z.array(canonicalId).min(1),
])

const manifestEntrySchema = z
  .object({
    target: canonicalId,
    canonicalId,
    nodeType: z.enum(['heading', 'paragraph', 'quote', 'caption', 'figure']),
    contentHash: sha256,
    provenance: z
      .object({
        source: z.string().min(1),
      })
      .strict(),
    relationships: z.record(relationshipValueSchema),
    chosenVariant: z.string().min(1),
    representation: representationSchema,
    diagnostics: z.array(diagnosticSchema),
    fallback: z
      .object({
        fromVariant: z.string().min(1),
        diagnosticCode: layoutDiagnosticCodeSchema,
      })
      .strict()
      .optional(),
  })
  .strict()

const renditionSchema = z
  .object({
    target: canonicalId,
    contentHash: sha256,
    entries: z.array(manifestEntrySchema).min(1),
  })
  .strict()

export const layoutManifestSchema = z
  .object({
    schemaVersion: z.literal(LAYOUT_MANIFEST_VERSION),
    document: z
      .object({
        id: canonicalId,
        version: z.string().min(1),
        contentHash: sha256,
      })
      .strict(),
    renditions: z.array(renditionSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const targets = new Set<string>()

    for (const [renditionIndex, rendition] of manifest.renditions.entries()) {
      if (targets.has(rendition.target)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['renditions', renditionIndex, 'target'],
          message: `Duplicate rendition target: ${rendition.target}`,
        })
      }
      targets.add(rendition.target)

      const nodeIds = new Set<string>()
      for (const [entryIndex, entry] of rendition.entries.entries()) {
        const path = ['renditions', renditionIndex, 'entries', entryIndex]

        if (entry.target !== rendition.target) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'target'],
            message: `Entry target ${entry.target} does not match rendition target ${rendition.target}`,
          })
        }

        if (nodeIds.has(entry.canonicalId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'canonicalId'],
            message: `Duplicate manifest entry: ${entry.canonicalId}`,
          })
        }
        nodeIds.add(entry.canonicalId)

        if (
          entry.fallback &&
          !entry.diagnostics.some(
            (diagnostic) => diagnostic.code === entry.fallback?.diagnosticCode,
          )
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'fallback'],
            message: `Fallback from ${entry.fallback.fromVariant} lacks diagnostic ${entry.fallback.diagnosticCode}`,
          })
        }

        if (entry.representation.kind === 'fragments') {
          const fragmentIds = new Set<string>()
          for (const [
            fragmentIndex,
            fragment,
          ] of entry.representation.fragments.entries()) {
            if (fragmentIds.has(fragment.id)) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: [
                  ...path,
                  'representation',
                  'fragments',
                  fragmentIndex,
                  'id',
                ],
                message: `Duplicate fragment id: ${fragment.id}`,
              })
            }
            fragmentIds.add(fragment.id)
            if (fragment.index !== fragmentIndex) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: [
                  ...path,
                  'representation',
                  'fragments',
                  fragmentIndex,
                  'index',
                ],
                message: `Fragment indices must be contiguous from zero`,
              })
            }
          }
        }
      }
    }
  })

export type LayoutManifest = z.infer<typeof layoutManifestSchema>

export type ManifestInvariantIssue = {
  code:
    | 'DOCUMENT_ID_MISMATCH'
    | 'DOCUMENT_VERSION_MISMATCH'
    | 'DOCUMENT_HASH_MISMATCH'
    | 'MISSING_TARGET'
    | 'UNEXPECTED_TARGET'
    | 'RENDITION_HASH_MISMATCH'
    | 'MISSING_NODE'
    | 'UNEXPECTED_NODE'
    | 'NODE_TYPE_MISMATCH'
    | 'NODE_HASH_MISMATCH'
    | 'PROVENANCE_MISMATCH'
    | 'RELATIONSHIP_MISMATCH'
  target?: string
  canonicalId?: string
  message: string
}

export class ManifestInvariantError extends Error {
  constructor(public readonly issues: ManifestInvariantIssue[]) {
    super(issues.map((issue) => `${issue.code}: ${issue.message}`).join('\n'))
    this.name = 'ManifestInvariantError'
  }
}

function relationshipsFor(
  node: ResearchNode,
): Record<string, string | string[]> {
  return node.type === 'figure' ? { ...node.relationships } : {}
}

function chosenVariantFor(node: ResearchNode) {
  return node.type === 'figure' ? 'inline' : 'flow'
}

function comparableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(comparableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    )
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${comparableJson(nested)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function validateLayoutManifest(
  input: unknown,
  paper: ResearchPaper,
  expectedTargets: readonly string[] = LAYOUT_TARGETS,
): LayoutManifest {
  const manifest = layoutManifestSchema.parse(input)
  const issues: ManifestInvariantIssue[] = []
  const documentHash = canonicalContentHash(paper)

  if (manifest.document.id !== paper.id) {
    issues.push({
      code: 'DOCUMENT_ID_MISMATCH',
      message: `Expected ${paper.id}, received ${manifest.document.id}`,
    })
  }
  if (manifest.document.version !== paper.version) {
    issues.push({
      code: 'DOCUMENT_VERSION_MISMATCH',
      message: `Expected ${paper.version}, received ${manifest.document.version}`,
    })
  }
  if (manifest.document.contentHash !== documentHash) {
    issues.push({
      code: 'DOCUMENT_HASH_MISMATCH',
      message: `Document content hash does not match canonical source`,
    })
  }

  const expectedTargetSet = new Set(expectedTargets)
  const actualTargetSet = new Set(
    manifest.renditions.map((rendition) => rendition.target),
  )
  for (const target of expectedTargetSet) {
    if (!actualTargetSet.has(target))
      issues.push({
        code: 'MISSING_TARGET',
        target,
        message: `Missing rendition for ${target}`,
      })
  }
  for (const target of actualTargetSet) {
    if (!expectedTargetSet.has(target))
      issues.push({
        code: 'UNEXPECTED_TARGET',
        target,
        message: `Unexpected rendition for ${target}`,
      })
  }

  const canonicalNodes = new Map(paper.nodes.map((node) => [node.id, node]))
  for (const rendition of manifest.renditions) {
    if (rendition.contentHash !== documentHash) {
      issues.push({
        code: 'RENDITION_HASH_MISMATCH',
        target: rendition.target,
        message: `Rendition content hash does not match canonical source`,
      })
    }

    const renderedNodes = new Map(
      rendition.entries.map((entry) => [entry.canonicalId, entry]),
    )
    for (const node of paper.nodes) {
      const entry = renderedNodes.get(node.id)
      if (!entry) {
        issues.push({
          code: 'MISSING_NODE',
          target: rendition.target,
          canonicalId: node.id,
          message: `Node ${node.id} was omitted`,
        })
        continue
      }
      if (entry.nodeType !== node.type) {
        issues.push({
          code: 'NODE_TYPE_MISMATCH',
          target: rendition.target,
          canonicalId: node.id,
          message: `Node type changed for ${node.id}`,
        })
      }
      if (entry.contentHash !== canonicalNodeContentHash(node)) {
        issues.push({
          code: 'NODE_HASH_MISMATCH',
          target: rendition.target,
          canonicalId: node.id,
          message: `Node content hash changed for ${node.id}`,
        })
      }
      if (entry.provenance.source !== node.source) {
        issues.push({
          code: 'PROVENANCE_MISMATCH',
          target: rendition.target,
          canonicalId: node.id,
          message: `Provenance changed for ${node.id}`,
        })
      }
      if (
        comparableJson(entry.relationships) !==
        comparableJson(relationshipsFor(node))
      ) {
        issues.push({
          code: 'RELATIONSHIP_MISMATCH',
          target: rendition.target,
          canonicalId: node.id,
          message: `Relationships changed for ${node.id}`,
        })
      }
    }

    for (const entry of rendition.entries) {
      if (!canonicalNodes.has(entry.canonicalId)) {
        issues.push({
          code: 'UNEXPECTED_NODE',
          target: rendition.target,
          canonicalId: entry.canonicalId,
          message: `Unknown node ${entry.canonicalId} appears in rendition`,
        })
      }
    }
  }

  if (issues.length > 0) throw new ManifestInvariantError(issues)
  return manifest
}

export function buildLayoutManifest(
  paper: ResearchPaper,
  targets: readonly string[] = LAYOUT_TARGETS,
): LayoutManifest {
  const contentHash = canonicalContentHash(paper)
  const manifest = {
    schemaVersion: LAYOUT_MANIFEST_VERSION,
    document: {
      id: paper.id,
      version: paper.version,
      contentHash,
    },
    renditions: targets.map((target) => ({
      target,
      contentHash,
      entries: paper.nodes.map((node, order) => ({
        target,
        canonicalId: node.id,
        nodeType: node.type,
        contentHash: canonicalNodeContentHash(node),
        provenance: { source: node.source },
        relationships: relationshipsFor(node),
        chosenVariant: chosenVariantFor(node),
        representation: {
          kind: 'whole' as const,
          placement: { kind: 'flow' as const, order },
        },
        diagnostics: [],
      })),
    })),
  }

  return validateLayoutManifest(manifest, paper, targets)
}

export function serializeLayoutManifest(manifest: LayoutManifest) {
  return `${JSON.stringify(layoutManifestSchema.parse(manifest), null, 2)}\n`
}

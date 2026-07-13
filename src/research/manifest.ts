import { z } from 'zod'
import {
  canonicalContentHash,
  canonicalNodeContentHash,
  type ResearchNode,
  type ResearchPaper,
} from './schema'
import {
  COMPOSITION_DECISION_CODES,
  COMPOSITION_POLICY_VERSION,
  getCompositionPolicy,
  resolveNodeComposition,
} from './composition'
import {
  getTargetProfile,
  TARGET_PROFILE_IDS,
  type TargetProfileId,
} from './targets'
import { targetProfileIdSchema, targetProfileSchema } from './target-schema'
import {
  PAGINATION_POLICY_VERSION,
  PAGINATION_VIOLATION_CODES,
  paginateResearchPaper,
  type PaginatedNode,
  type PaginationResult,
} from './pagination'

export const LAYOUT_MANIFEST_VERSION = '1.2.0' as const
export const LAYOUT_TARGETS = TARGET_PROFILE_IDS

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
      page: z.number().int().positive().optional(),
      region: z.number().int().nonnegative().optional(),
      span: z.enum(['column', 'page']).optional(),
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
    lineage: z
      .object({
        canonicalId,
        previousFragmentId: canonicalId.nullable(),
        nextFragmentId: canonicalId.nullable(),
      })
      .strict(),
    textRange: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
      })
      .strict()
      .optional(),
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

const compositionDecisionSchema = z
  .object({
    code: z.enum(COMPOSITION_DECISION_CODES),
    outcome: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict()

const compositionPolicySchema = z
  .object({
    id: canonicalId,
    version: z.literal(COMPOSITION_POLICY_VERSION),
    flowMode: z.enum(['browser-flow', 'finite-sheet-preview']),
    decisions: z.array(compositionDecisionSchema).min(1),
  })
  .strict()

const paginationViolationSchema = z
  .object({
    code: z.enum(PAGINATION_VIOLATION_CODES),
    severity: z.enum(['warning', 'error']),
    message: z.string().min(1),
  })
  .strict()

const paginationFallbackSchema = z
  .object({
    code: z.literal('scale-atomic-object'),
    reason: z.string().min(1),
    scale: z.number().positive().max(1),
  })
  .strict()

const placementDecisionSchema = z
  .object({
    outcome: z.enum([
      'placed',
      'fragmented',
      'kept-with-next',
      'kept-with-related',
      'atomic-fallback',
    ]),
    reason: z.string().min(1),
  })
  .strict()

const nodePaginationPolicySchema = z
  .object({
    fragmentation: z.enum(['line', 'atomic']),
    keep: z.enum(['none', 'with-next', 'with-previous', 'with-related']),
    minimumStartLines: z.number().int().positive().optional(),
    minimumEndLines: z.number().int().positive().optional(),
  })
  .strict()

const paginationSummarySchema = z
  .object({
    policyVersion: z.literal(PAGINATION_POLICY_VERSION),
    mode: z.enum(['continuous', 'finite']),
    finalPageCount: z.number().int().positive().nullable(),
    pageCountStatus: z.enum(['final', 'not-applicable']),
    currentRegionStability: z
      .object({
        metric: z.literal('deterministic-fragment-prefix'),
        stable: z.boolean(),
        comparedFragmentCount: z.number().int().nonnegative(),
        stableFragmentCount: z.number().int().nonnegative(),
      })
      .strict(),
    violations: z.array(paginationViolationSchema),
  })
  .strict()

const manifestEntrySchema = z
  .object({
    target: targetProfileIdSchema,
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
    paginationPolicy: nodePaginationPolicySchema,
    representation: representationSchema,
    placementDecision: placementDecisionSchema,
    violations: z.array(paginationViolationSchema),
    paginationFallback: paginationFallbackSchema.optional(),
    diagnostics: z.array(diagnosticSchema),
    fallback: z
      .object({
        fromVariant: z.string().min(1),
        diagnosticCode: layoutDiagnosticCodeSchema,
        reason: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict()

const renditionSchema = z
  .object({
    target: targetProfileIdSchema,
    contentHash: sha256,
    profile: targetProfileSchema,
    policy: compositionPolicySchema,
    pagination: paginationSummarySchema,
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

      if (rendition.profile.id !== rendition.target) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['renditions', renditionIndex, 'profile', 'id'],
          message: `Profile ${rendition.profile.id} does not match rendition target ${rendition.target}`,
        })
      }

      if (
        (rendition.profile.finiteHeight &&
          (rendition.pagination.mode !== 'finite' ||
            rendition.pagination.pageCountStatus !== 'final' ||
            rendition.pagination.finalPageCount === null)) ||
        (!rendition.profile.finiteHeight &&
          (rendition.pagination.mode !== 'continuous' ||
            rendition.pagination.pageCountStatus !== 'not-applicable' ||
            rendition.pagination.finalPageCount !== null))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['renditions', renditionIndex, 'pagination'],
          message: `Pagination summary contradicts finite-height profile ${rendition.target}`,
        })
      }

      if (
        rendition.pagination.currentRegionStability.stableFragmentCount >
        rendition.pagination.currentRegionStability.comparedFragmentCount
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [
            'renditions',
            renditionIndex,
            'pagination',
            'currentRegionStability',
          ],
          message: `Stable fragment count cannot exceed compared fragment count`,
        })
      }

      const decisionCodes = new Set<string>()
      for (const [
        decisionIndex,
        decision,
      ] of rendition.policy.decisions.entries()) {
        if (decisionCodes.has(decision.code)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [
              'renditions',
              renditionIndex,
              'policy',
              'decisions',
              decisionIndex,
              'code',
            ],
            message: `Duplicate composition decision: ${decision.code}`,
          })
        }
        decisionCodes.add(decision.code)
      }

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
          const fragments = entry.representation.fragments
          for (const [fragmentIndex, fragment] of fragments.entries()) {
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
            if (fragment.lineage.canonicalId !== entry.canonicalId) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: [
                  ...path,
                  'representation',
                  'fragments',
                  fragmentIndex,
                  'lineage',
                  'canonicalId',
                ],
                message: `Fragment lineage must name canonical node ${entry.canonicalId}`,
              })
            }
            if (
              fragment.lineage.previousFragmentId !==
                (fragments[fragmentIndex - 1]?.id ?? null) ||
              fragment.lineage.nextFragmentId !==
                (fragments[fragmentIndex + 1]?.id ?? null)
            ) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: [
                  ...path,
                  'representation',
                  'fragments',
                  fragmentIndex,
                  'lineage',
                ],
                message: `Fragment lineage must follow contiguous fragment order`,
              })
            }
          }
        }

        const placements =
          entry.representation.kind === 'whole'
            ? [entry.representation.placement]
            : entry.representation.fragments.map(
                (fragment) => fragment.placement,
              )
        if (
          rendition.profile.finiteHeight &&
          placements.some((placement) => {
            if (
              placement.page === undefined ||
              placement.page > (rendition.pagination.finalPageCount ?? 0)
            ) {
              return true
            }
            return (
              placement.kind === 'flow' &&
              (placement.region === undefined || placement.span === undefined)
            )
          })
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'representation'],
            message: `Finite-height placements require a valid page, region, and span`,
          })
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
    | 'TARGET_PROFILE_MISMATCH'
    | 'COMPOSITION_POLICY_MISMATCH'
    | 'PAGINATION_POLICY_MISMATCH'
    | 'MISSING_NODE'
    | 'UNEXPECTED_NODE'
    | 'NODE_TYPE_MISMATCH'
    | 'NODE_HASH_MISMATCH'
    | 'PROVENANCE_MISMATCH'
    | 'RELATIONSHIP_MISMATCH'
    | 'NODE_COMPOSITION_MISMATCH'
    | 'NODE_PAGINATION_MISMATCH'
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

function paginationSummary(result: PaginationResult) {
  return {
    policyVersion: result.policyVersion,
    mode: result.mode,
    finalPageCount: result.finalPageCount,
    pageCountStatus: result.pageCountStatus,
    currentRegionStability: result.currentRegionStability,
    violations: result.violations,
  }
}

function representationForNode(
  node: PaginatedNode,
  orderByFragmentId: Map<string, number>,
) {
  const placementFor = (fragment: PaginatedNode['fragments'][number]) => ({
    kind: 'flow' as const,
    order: orderByFragmentId.get(fragment.id) ?? 0,
    ...(fragment.page > 0
      ? {
          page: fragment.page,
          region: fragment.region,
          span: fragment.span,
        }
      : {}),
  })

  if (node.fragments.length === 1) {
    return {
      kind: 'whole' as const,
      placement: placementFor(node.fragments[0]),
    }
  }

  return {
    kind: 'fragments' as const,
    fragments: node.fragments.map((fragment, index, fragments) => ({
      id: fragment.id,
      index,
      lineage: {
        canonicalId: node.canonicalId,
        previousFragmentId: fragments[index - 1]?.id ?? null,
        nextFragmentId: fragments[index + 1]?.id ?? null,
      },
      ...(fragment.textRange ? { textRange: fragment.textRange } : {}),
      placement: placementFor(fragment),
    })),
  }
}

function fragmentOrder(result: PaginationResult) {
  return new Map(
    result.pages
      .flatMap((page) =>
        page.spanningFragments.length > 0
          ? page.spanningFragments
          : page.regions.flatMap((region) => region.fragments),
      )
      .map((fragment, order) => [fragment.id, order]),
  )
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

  const expectedTargetSet = new Set<string>(expectedTargets)
  const actualTargetSet = new Set<string>(
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

    const parsedTarget = targetProfileIdSchema.safeParse(rendition.target)
    if (parsedTarget.success) {
      const expectedProfile = getTargetProfile(parsedTarget.data)
      const expectedPolicy = getCompositionPolicy(parsedTarget.data)
      const expectedPagination = paginateResearchPaper(paper, parsedTarget.data)

      if (
        comparableJson(rendition.profile) !== comparableJson(expectedProfile)
      ) {
        issues.push({
          code: 'TARGET_PROFILE_MISMATCH',
          target: rendition.target,
          message: `Target profile changed for ${rendition.target}`,
        })
      }
      if (comparableJson(rendition.policy) !== comparableJson(expectedPolicy)) {
        issues.push({
          code: 'COMPOSITION_POLICY_MISMATCH',
          target: rendition.target,
          message: `Composition policy changed for ${rendition.target}`,
        })
      }
      if (
        comparableJson(rendition.pagination) !==
        comparableJson(paginationSummary(expectedPagination))
      ) {
        issues.push({
          code: 'PAGINATION_POLICY_MISMATCH',
          target: rendition.target,
          message: `Pagination summary changed for ${rendition.target}`,
        })
      }
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
      if (parsedTarget.success) {
        const expectedComposition = resolveNodeComposition(
          parsedTarget.data,
          node,
        )
        if (
          entry.chosenVariant !== expectedComposition.chosenVariant ||
          comparableJson(entry.fallback) !==
            comparableJson(expectedComposition.fallback)
        ) {
          issues.push({
            code: 'NODE_COMPOSITION_MISMATCH',
            target: rendition.target,
            canonicalId: node.id,
            message: `Composition decision changed for ${node.id}`,
          })
        }

        const expectedPagination = paginateResearchPaper(
          paper,
          parsedTarget.data,
        )
        const expectedNode = expectedPagination.nodes.find(
          (candidate) => candidate.canonicalId === node.id,
        )
        if (
          !expectedNode ||
          comparableJson(entry.paginationPolicy) !==
            comparableJson(expectedNode.policy) ||
          comparableJson(entry.placementDecision) !==
            comparableJson(expectedNode.decision) ||
          comparableJson(entry.violations) !==
            comparableJson(expectedNode.violations) ||
          comparableJson(entry.paginationFallback) !==
            comparableJson(expectedNode.fallback)
        ) {
          issues.push({
            code: 'NODE_PAGINATION_MISMATCH',
            target: rendition.target,
            canonicalId: node.id,
            message: `Pagination decision changed for ${node.id}`,
          })
        }
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
  targets: readonly TargetProfileId[] = LAYOUT_TARGETS,
): LayoutManifest {
  const contentHash = canonicalContentHash(paper)
  const manifest = {
    schemaVersion: LAYOUT_MANIFEST_VERSION,
    document: {
      id: paper.id,
      version: paper.version,
      contentHash,
    },
    renditions: targets.map((target) => {
      const pagination = paginateResearchPaper(paper, target)
      const orderByFragmentId = fragmentOrder(pagination)

      return {
        target,
        contentHash,
        profile: getTargetProfile(target),
        policy: getCompositionPolicy(target),
        pagination: paginationSummary(pagination),
        entries: paper.nodes.map((node) => {
          const composition = resolveNodeComposition(target, node)
          const paginatedNode = pagination.nodes.find(
            (candidate) => candidate.canonicalId === node.id,
          )
          if (!paginatedNode) {
            throw new Error(`Pagination omitted canonical node ${node.id}`)
          }

          return {
            target,
            canonicalId: node.id,
            nodeType: node.type,
            contentHash: canonicalNodeContentHash(node),
            provenance: { source: node.source },
            relationships: relationshipsFor(node),
            chosenVariant: composition.chosenVariant,
            paginationPolicy: paginatedNode.policy,
            representation: representationForNode(
              paginatedNode,
              orderByFragmentId,
            ),
            placementDecision: paginatedNode.decision,
            violations: paginatedNode.violations,
            ...(paginatedNode.fallback
              ? { paginationFallback: paginatedNode.fallback }
              : {}),
            diagnostics: composition.diagnostics,
            ...(composition.fallback ? { fallback: composition.fallback } : {}),
          }
        }),
      }
    }),
  }

  return validateLayoutManifest(manifest, paper, targets)
}

export function serializeLayoutManifest(manifest: LayoutManifest) {
  return `${JSON.stringify(layoutManifestSchema.parse(manifest), null, 2)}\n`
}

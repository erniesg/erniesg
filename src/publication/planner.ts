import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  publicationGraphSchema,
  serializePublicationGraph,
  type PublicationGraph,
  type PublicationNode,
} from './schema'
import type { CompositionContext } from './profiles'
import {
  transformationPolicySchema,
  type TransformationPolicy,
} from './transformation-policy'
import {
  runStaticPreflight,
  type StaticPreflightResult,
} from './static-preflight'
import {
  validateProduction,
  type ProductionValidationResult,
} from './production-validation'
import {
  createRendererProbe,
  rendererProbeSchema,
  type RendererProbe,
} from './renderer-probe'

/** The planner is deliberately small and versioned.  A version is part of
 * every plan receipt so a replay never silently changes its candidate order. */
export const LAYOUT_PLAN_VERSION = '1.0.0' as const
export const PLANNER_VERSION = 'semantic-v1' as const
export const LAYOUT_MODES = [
  'editorial-spread',
  'conventional-page',
  'compact-page',
  'single-column-reading',
  'sequence',
] as const
export type LayoutMode = (typeof LAYOUT_MODES)[number]
export const CANDIDATE_MODES = LAYOUT_MODES
export const BOUNDED_LAYOUT_MODES = LAYOUT_MODES

const idSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

const representationSchema = z.enum([
  'canonical',
  'inline',
  'full-span',
  'conventional',
  'stacked-records',
  'margin',
  'endnote',
  'compact',
  'monochrome',
  'static',
])

export const layoutFragmentSchema = z
  .object({
    id: idSchema,
    nodeId: idSchema,
    fragmentIndex: z.number().int().nonnegative(),
    order: z.number().int().nonnegative(),
    representation: representationSchema,
    regionId: idSchema,
    flowRegion: idSchema.optional(),
    sourceAnchor: z
      .object({
        nodeId: idSchema,
        start: z.number().int().nonnegative().optional(),
        end: z.number().int().nonnegative().optional(),
      })
      .strict(),
    outputAnchor: z
      .object({ id: idSchema, nodeId: idSchema, fragmentIndex: z.number().int() })
      .strict(),
    keep: z
      .object({
        withPrevious: z.boolean(),
        withNext: z.boolean(),
        relationshipIds: z.array(idSchema).max(10_000),
      })
      .strict(),
    split: z
      .object({
        allowed: z.boolean(),
        boundary: z.enum(['word', 'row', 'none']),
      })
      .strict(),
    reasonCodes: z.array(idSchema).max(32),
    transformationId: idSchema.optional(),
    selectedVariantId: idSchema.optional(),
  })
  .strict()

export type LayoutFragment = z.infer<typeof layoutFragmentSchema>

const regionSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['main', 'full-span', 'margin', 'sequence', 'endnote']),
    order: z.number().int().nonnegative(),
  })
  .strict()

const reasonSchema = z
  .object({
    code: idSchema,
    message: z.string().min(1).max(10_000),
    nodeId: idSchema.optional(),
  })
  .strict()

export const layoutViolationSchema = z
  .object({
    code: idSchema,
    message: z.string().min(1).max(10_000),
    nodeId: idSchema.optional(),
    stage: z.enum(['static', 'measured']),
  })
  .strict()

export type LayoutViolation = z.infer<typeof layoutViolationSchema>

export const layoutSoftTradeoffSchema = z
  .object({
    code: idSchema,
    message: z.string().min(1).max(10_000),
    value: z.union([z.string(), z.number().finite(), z.boolean()]).optional(),
  })
  .strict()

export type LayoutSoftTradeoff = z.infer<typeof layoutSoftTradeoffSchema>

export const layoutPlanSchema = z
  .object({
    version: z.literal(LAYOUT_PLAN_VERSION),
    plannerVersion: z.literal(PLANNER_VERSION),
    id: idSchema,
    candidateId: idSchema,
    graphId: idSchema,
    graphVersion: z.string().min(1).max(64),
    graphSha256: z.string().regex(/^[a-f0-9]{64}$/),
    profileId: idSchema,
    profileVersion: z.string().min(1).max(64),
    policyVersion: z.string().min(1).max(64),
    policyVersions: z
      .object({
        planner: z.string().min(1).max(64),
        transformationPolicy: z.string().min(1).max(64),
      })
      .strict()
      .optional(),
    mode: z.enum(LAYOUT_MODES),
    rank: z.number().int().nonnegative(),
    regions: z.array(regionSchema).min(1).max(32),
    flowRegions: z.array(regionSchema).max(32).optional(),
    fragments: z.array(layoutFragmentSchema).min(1).max(100_000),
    /** `entries` and `placements` are compatibility aliases used by the
     * preview tooling. They intentionally contain the same ordered fragments. */
    entries: z.array(layoutFragmentSchema).min(1).max(100_000),
    placements: z.array(layoutFragmentSchema).min(1).max(100_000),
    nodeFragments: z.array(layoutFragmentSchema).max(100_000).optional(),
    sourceAnchors: z
      .array(
        z
          .object({
            nodeId: idSchema,
            fragmentIndex: z.number().int().nonnegative(),
            sourceOrder: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(100_000),
    outputAnchors: z
      .array(
        z
          .object({
            id: idSchema,
            nodeId: idSchema,
            fragmentIndex: z.number().int().nonnegative(),
            order: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(100_000),
    keepRules: z
      .array(
        z
          .object({
            id: idSchema,
            nodeId: idSchema,
            withNodeIds: z.array(idSchema).max(10_000),
          })
          .strict(),
      )
      .max(100_000),
    splitRules: z
      .array(
        z
          .object({
            id: idSchema,
            nodeId: idSchema,
            allowed: z.boolean(),
            boundary: z.enum(['word', 'row', 'none']),
          })
          .strict(),
      )
      .max(100_000),
    reasons: z.array(reasonSchema).max(100_000),
    hardViolations: z.array(layoutViolationSchema).max(100_000),
    hardFailures: z.array(layoutViolationSchema).max(100_000).optional(),
    softTradeoffs: z.array(layoutSoftTradeoffSchema).max(100_000),
    softMetrics: z
      .object({
        pageCount: z.number().finite().nonnegative().optional(),
        density: z.number().finite().nonnegative().optional(),
        hierarchy: z.number().finite().nonnegative().optional(),
        figureProminence: z.number().finite().nonnegative().optional(),
        whitespace: z.number().finite().nonnegative().optional(),
        policyPreference: z.number().finite().nonnegative().optional(),
      })
      .strict(),
    remainingUncertainty: z.array(z.string().min(1).max(10_000)).max(1_000),
    uncertainty: z.array(z.string().min(1).max(10_000)).max(1_000).optional(),
  })
  .strict()

export type LayoutPlan = z.infer<typeof layoutPlanSchema>

export type PlanningContext = CompositionContext | (Omit<CompositionContext, 'presetId'> & {
  /** Custom profiles are allowed at the planner boundary.  The named profile
   * registry remains authoritative for its four presets. */
  presetId?: string
  profileId?: string
  profileVersion?: string
  [key: string]: unknown
})

export type PlannerPolicy = TransformationPolicy & {
  componentPolicies?: Partial<{
    figure: 'inline' | 'full-span'
    table: 'conventional' | 'stacked-records'
    aside: 'margin' | 'inline' | 'endnote'
    interactive: 'interactive' | 'static'
    colorChart: 'color' | 'monochrome'
  }>
}

export type RendererProbeProvider =
  | ((plan: LayoutPlan) => RendererProbe)
  | { probe(plan: LayoutPlan): RendererProbe }

export type PlanningOptions = {
  assets?: readonly Record<string, unknown>[] | Record<string, unknown>
  renderer?: RendererProbeProvider
  probe?: RendererProbeProvider
}

export type PlanRequest = {
  graph: PublicationGraph
  context: PlanningContext
  policy?: PlannerPolicy
  options?: PlanningOptions
}

export type PlanCandidateEvaluation = LayoutPlan & {
  plan: LayoutPlan
  staticPreflight: StaticPreflightResult
  probe?: RendererProbe
  productionValidation?: ProductionValidationResult
}

export type PlanningResult = {
  version: typeof LAYOUT_PLAN_VERSION
  plannerVersion: typeof PLANNER_VERSION
  graphId: string
  profileId: string
  candidates: PlanCandidateEvaluation[]
  selectedPlan: LayoutPlan | null
  /** Short aliases keep the result convenient for CLI and preview callers. */
  plan: LayoutPlan | null
  selected: LayoutPlan | null
  eligible: boolean
  artifactEligible: boolean
  requiresRendererProbe: boolean
  noEligiblePlan: boolean
  alternatives: Array<{
    kind: 'profile-relaxation' | 'authored-variant' | 'policy'
    code: string
    message: string
  }>
}

const DEFAULT_POLICY: PlannerPolicy = {
  version: '1.0.0',
  id: 'semantic-default',
  transformations: [],
  constraints: [],
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object'
    ? (value as Record<string, any>)
    : {}
}

function contextField(context: PlanningContext, key: string) {
  return asRecord(context)[key]
}

function profileId(context: PlanningContext) {
  return String(
    contextField(context, 'profileId') ??
      contextField(context, 'presetId') ??
      'custom-profile',
  )
}

function profileVersion(context: PlanningContext) {
  return String(
    contextField(context, 'profileVersion') ??
      contextField(context, 'sourceProfileVersion') ??
      'custom',
  )
}

function policyValue(value: unknown): PlannerPolicy {
  const record = asRecord(value)
  const parsed = transformationPolicySchema.safeParse(record)
  if (parsed.success) return record as PlannerPolicy
  return {
    ...DEFAULT_POLICY,
    ...(typeof record.version === 'string' ? { version: record.version } : {}),
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(Array.isArray(record.transformations)
      ? { transformations: record.transformations }
      : {}),
    ...(Array.isArray(record.constraints) ? { constraints: record.constraints } : {}),
    ...(record.componentPolicies
      ? { componentPolicies: record.componentPolicies }
      : {}),
  } as PlannerPolicy
}

function isPolicy(value: unknown): value is PlannerPolicy {
  const record = asRecord(value)
  return (
    typeof record.version === 'string' &&
    (Array.isArray(record.transformations) || Array.isArray(record.constraints))
  )
}

function normalizeRequest(
  first: PlanRequest | PublicationGraph,
  second?: PlanningContext,
  third?: PlannerPolicy | PlanningOptions,
  fourth?: PlanningOptions,
): PlanRequest {
  const firstRecord = asRecord(first)
  if (firstRecord.publicationGraph && firstRecord.compositionContext) {
    return {
      graph: publicationGraphSchema.parse(firstRecord.publicationGraph),
      context: firstRecord.compositionContext as PlanningContext,
      policy: policyValue(firstRecord.transformationPolicy ?? firstRecord.policy ?? DEFAULT_POLICY),
      options: firstRecord.options,
    }
  }
  if (first && 'graph' in first) {
    const request = first as PlanRequest
    return {
      graph: publicationGraphSchema.parse(request.graph),
      context: request.context,
      policy: policyValue(request.policy ?? DEFAULT_POLICY),
      options: request.options,
    }
  }
  // Accept both graph-first and context-first call sites. The latter is handy
  // for callers that start from a CompositionContext and mirrors the issue
  // language without creating a second planner implementation.
  if (!('nodes' in (first as object)) && second && 'nodes' in (second as object)) {
    return normalizeRequest(second as unknown as PublicationGraph, first as unknown as PlanningContext, third, fourth)
  }
  const policy = isPolicy(third) ? third : undefined
  let options = (isPolicy(third) ? fourth : third) as PlanningOptions | undefined
  if (typeof options === 'function' || (options && typeof options === 'object' && 'probe' in options && typeof (options as any).probe === 'function')) {
    options = { renderer: options as any }
  }
  if (fourth && typeof fourth === 'function') options = { renderer: fourth as any }
  return {
    graph: publicationGraphSchema.parse(first),
    context: second as PlanningContext,
    policy: policyValue(policy ?? DEFAULT_POLICY),
    options,
  }
}

function modeReason(mode: LayoutMode, context: PlanningContext) {
  const paged = contextField(context, 'flow') === 'paged'
  switch (mode) {
    case 'editorial-spread':
      return paged
        ? { code: 'PAGED_SPREAD', message: 'Paged flow permits authored spread regions.' }
        : { code: 'SPREAD_REQUIRES_PAGED_FLOW', message: 'Editorial spreads require finite paged flow.' }
    case 'conventional-page':
      return paged
        ? { code: 'CONVENTIONAL_PAGE', message: 'Use conventional page regions for finite flow.' }
        : { code: 'PAGE_REQUIRES_PAGED_FLOW', message: 'Conventional pages require finite paged flow.' }
    case 'compact-page':
      return { code: 'COMPACT_BOUND', message: 'Use the bounded compact representation family.' }
    case 'single-column-reading':
      return contextField(context, 'flow') === 'continuous'
        ? { code: 'CONTINUOUS_SINGLE_COLUMN', message: 'Continuous reading uses one ordered column.' }
        : { code: 'SINGLE_COLUMN_FALLBACK', message: 'Single-column reading is a bounded fallback for paged flow.' }
    case 'sequence':
      return { code: 'SEQUENTIAL_FLOW', message: 'Preserve canonical order as an explicit sequence.' }
  }
}

function nodeText(node: PublicationNode) {
  if ('text' in node) return node.text
  if (node.type === 'code') return node.code
  if (node.type === 'equation') return node.source
  if (node.type === 'figure') return `${node.title} ${node.sourceText ?? ''}`
  return ''
}

function hasVariant(node: PublicationNode, kind: 'compact' | 'monochrome' | 'static') {
  return node.variants.find((variant) => variant.kind === kind && variant.reviewed)
}

function isStaticContext(context: PlanningContext) {
  const refresh = contextField(context, 'refresh')
  return (
    (refresh !== undefined && refresh !== 'dynamic') ||
    contextField(context, 'interaction') === 'none'
  )
}

function isMonochrome(context: PlanningContext) {
  return contextField(context, 'color') === 'monochrome'
}

function looksLikeColorChart(node: PublicationNode) {
  if (!['figure', 'media', 'table'].includes(node.type)) return false
  const value = `${node.id} ${node.type === 'figure' ? node.title : ''} ${node.type === 'figure' ? node.sourceText ?? '' : ''}`
  return /(?:color|colour|chart|heatmap|plot)/iu.test(value)
}

function componentPreference(
  node: PublicationNode,
  mode: LayoutMode,
  context: PlanningContext,
  policy: PlannerPolicy,
) {
  const preferences = policy.componentPolicies ?? {}
  if (node.type === 'figure') {
    if (preferences.figure) return preferences.figure
    return mode === 'editorial-spread' ? 'full-span' : 'inline'
  }
  if (node.type === 'table') {
    if (preferences.table) return preferences.table
    const width = Number(contextField(context, 'logicalDimensions')?.width ?? Infinity)
    return mode === 'compact-page' || width < 360 ? 'stacked-records' : 'conventional'
  }
  if (node.type === 'aside') {
    if (preferences.aside) return preferences.aside
    return mode === 'editorial-spread'
      ? 'margin'
      : mode === 'compact-page' && contextField(context, 'flow') === 'paged'
        ? 'endnote'
        : 'inline'
  }
  if (node.type === 'media' && node.mediaKind === 'interactive') {
    if (preferences.interactive === 'static' || isStaticContext(context)) return 'static'
    return 'canonical'
  }
  if (isMonochrome(context) && looksLikeColorChart(node)) {
    if (preferences.colorChart === 'monochrome') return 'monochrome'
    return 'monochrome'
  }
  if (node.type === 'paragraph' && mode === 'compact-page' && hasVariant(node, 'compact'))
    return 'compact'
  return 'canonical'
}

function relationshipsFor(node: PublicationNode) {
  switch (node.type) {
    case 'list':
      return node.itemIds
    case 'list-item':
      return [node.parentListId]
    case 'figure':
      return node.captionId ? [node.captionId] : []
    case 'caption':
      return [node.parentId]
    case 'table':
    case 'equation':
    case 'media':
      return node.captionId ? [node.captionId] : []
    case 'note':
      return node.backlinkIds
    case 'reference':
      return node.targetIds
    default:
      return []
  }
}

function regionFor(representation: string, mode: LayoutMode) {
  if (representation === 'full-span') return 'full-span'
  if (representation === 'margin') return 'margin'
  if (representation === 'endnote') return 'endnote'
  if (mode === 'sequence') return 'sequence'
  return 'main'
}

function buildPlan(
  graph: PublicationGraph,
  context: PlanningContext,
  policy: PlannerPolicy,
  mode: LayoutMode,
  rank: number,
): LayoutPlan {
  const graphJson = serializePublicationGraph(graph)
  const graphSha256 = sha256(graphJson)
  const regions = [
    { id: 'region-main', kind: 'main' as const, order: 0 },
    { id: 'region-full-span', kind: 'full-span' as const, order: 1 },
    { id: 'region-margin', kind: 'margin' as const, order: 2 },
    { id: 'region-endnote', kind: 'endnote' as const, order: 3 },
    { id: 'region-sequence', kind: 'sequence' as const, order: 4 },
  ]
  const modeExplanation = modeReason(mode, context)
  const fragments: LayoutFragment[] = graph.nodes.map((node, index) => {
    const representation = componentPreference(node, mode, context, policy)
    const variantKind =
      representation === 'compact' || representation === 'monochrome' || representation === 'static'
        ? representation
        : undefined
    const variant = variantKind ? hasVariant(node, variantKind) : undefined
    const relationshipIds = relationshipsFor(node)
    const text = nodeText(node)
    const splitBoundary = node.type === 'table' ? 'row' : text ? 'word' : 'none'
    const region = regionFor(representation, mode)
    const reasonCodes = [`MODE_${mode.replaceAll('-', '_').toUpperCase()}`]
    if (representation !== 'canonical') reasonCodes.push(`REPRESENTATION_${representation.replaceAll('-', '_').toUpperCase()}`)
    return {
      id: `fragment-${node.id}-0`,
      nodeId: node.id,
      fragmentIndex: 0,
      order: index,
      representation: representation as LayoutFragment['representation'],
      regionId: `region-${region}`,
      flowRegion: `region-${region}`,
      sourceAnchor: {
        nodeId: node.id,
        ...(text ? { start: 0, end: text.length } : {}),
      },
      outputAnchor: {
        id: `out-${node.id}-0`,
        nodeId: node.id,
        fragmentIndex: 0,
      },
      keep: {
        withPrevious: node.type === 'caption',
        withNext: node.type === 'caption',
        relationshipIds,
      },
      split: {
        allowed: !['figure', 'table', 'equation', 'media', 'caption'].includes(node.type),
        boundary: splitBoundary,
      },
      reasonCodes,
      ...(variant ? { selectedVariantId: `${node.id}:${variant.kind}` } : {}),
      ...(variantKind ? { transformationId: `substitute-${variantKind}` } : {}),
    }
  })
  const sourceAnchors = fragments.map((fragment, index) => ({
    nodeId: fragment.nodeId,
    fragmentIndex: fragment.fragmentIndex,
    sourceOrder: index,
  }))
  const outputAnchors = fragments.map((fragment) => ({
    ...fragment.outputAnchor,
    order: fragment.order,
  }))
  const keepRules = fragments.map((fragment) => ({
    id: `keep-${fragment.nodeId}`,
    nodeId: fragment.nodeId,
    withNodeIds: fragment.keep.relationshipIds,
  }))
  const splitRules = fragments.map((fragment) => ({
    id: `split-${fragment.nodeId}`,
    nodeId: fragment.nodeId,
    allowed: fragment.split.allowed,
    boundary: fragment.split.boundary,
  }))
  const hardViolations: LayoutViolation[] = []
  if (modeExplanation.code.endsWith('REQUIRES_PAGED_FLOW')) {
    hardViolations.push({
      code: modeExplanation.code,
      message: modeExplanation.message,
      stage: 'static',
    })
  }
  const reasons = [
    { code: modeExplanation.code, message: modeExplanation.message },
    ...fragments.flatMap((fragment) =>
      fragment.reasonCodes.map((code) => ({
        code,
        message: `Selected ${fragment.representation} representation for ${fragment.nodeId}.`,
        nodeId: fragment.nodeId,
      })),
    ),
  ]
  const width = Number(contextField(context, 'logicalDimensions')?.width ?? 0)
  const density = width > 0 ? Math.min(1, 420 / width) : 1
  const softMetrics = {
    density,
    hierarchy: mode === 'editorial-spread' ? 0.9 : mode === 'conventional-page' ? 0.8 : 0.65,
    figureProminence: mode === 'editorial-spread' ? 1 : mode === 'conventional-page' ? 0.8 : 0.6,
    whitespace: mode === 'editorial-spread' ? 0.9 : mode === 'compact-page' ? 0.25 : 0.6,
    policyPreference: mode === 'sequence' ? 0.5 : 0.75,
  }
  const softTradeoffs: LayoutSoftTradeoff[] = [
    { code: 'DENSITY', message: 'Content density is exposed independently of hard gates.', value: density },
    { code: 'HIERARCHY', message: 'Heading hierarchy prominence is exposed independently of hard gates.', value: softMetrics.hierarchy },
    { code: 'FIGURE_PROMINENCE', message: 'Figure prominence is exposed independently of hard gates.', value: softMetrics.figureProminence },
    { code: 'WHITESPACE', message: 'Whitespace preference is exposed independently of hard gates.', value: softMetrics.whitespace },
    { code: 'POLICY_PREFERENCE', message: 'Standing policy preference is exposed independently of hard gates.', value: softMetrics.policyPreference },
  ]
  const parsed = layoutPlanSchema.parse({
    version: LAYOUT_PLAN_VERSION,
    plannerVersion: PLANNER_VERSION,
    id: `${graph.id}:${profileId(context)}:${mode}`,
    candidateId: `${profileId(context)}:${mode}`,
    graphId: graph.id,
    graphVersion: graph.version,
    graphSha256,
    profileId: profileId(context),
    profileVersion: profileVersion(context),
    policyVersion: String(policy.version),
    policyVersions: {
      planner: PLANNER_VERSION,
      transformationPolicy: String(policy.version),
    },
    mode,
    rank,
    regions,
    flowRegions: regions,
    fragments,
    entries: fragments,
    placements: fragments,
    nodeFragments: fragments,
    sourceAnchors,
    outputAnchors,
    keepRules,
    splitRules,
    reasons,
    hardViolations,
    hardFailures: hardViolations,
    softTradeoffs,
    softMetrics,
    remainingUncertainty: ['Renderer geometry, shaping, and output hashes require a renderer probe.'],
    uncertainty: ['Renderer geometry, shaping, and output hashes require a renderer probe.'],
  })
  return parsed
}

/** Enumerate all five authored modes in a stable order. No profile id is used
 * as a branch; context capabilities alone influence representation details. */
export function enumerateLayoutCandidates(
  first: PlanRequest | PublicationGraph,
  second?: PlanningContext,
  third?: PlannerPolicy | PlanningOptions,
  fourth?: PlanningOptions,
): LayoutPlan[] {
  const request = normalizeRequest(first, second, third, fourth)
  return LAYOUT_MODES.map((mode, rank) =>
    buildPlan(request.graph, request.context, request.policy ?? DEFAULT_POLICY, mode, rank),
  )
}

export const enumerateCandidates = enumerateLayoutCandidates

export function createLayoutPlan(
  graph: PublicationGraph,
  context: PlanningContext,
  policy: PlannerPolicy = DEFAULT_POLICY,
  mode: LayoutMode | string = 'sequence',
) {
  const normalizedMode =
    mode === 'editorialSpread' || mode === 'editorial'
      ? 'editorial-spread'
      : mode === 'conventionalPage' || mode === 'conventional'
        ? 'conventional-page'
        : mode === 'compactPage' || mode === 'compact'
          ? 'compact-page'
          : mode === 'singleColumnReading' || mode === 'single-column'
            ? 'single-column-reading'
            : mode === 'sequence'
              ? 'sequence'
              : mode
  if (!LAYOUT_MODES.includes(normalizedMode as LayoutMode))
    throw new RangeError(`Unknown layout mode: ${mode}`)
  return buildPlan(
    publicationGraphSchema.parse(graph),
    context,
    policyValue(policy),
    normalizedMode as LayoutMode,
    LAYOUT_MODES.indexOf(normalizedMode as LayoutMode),
  )
}

function providerProbe(provider: RendererProbeProvider, plan: LayoutPlan) {
  const result = typeof provider === 'function' ? provider(plan) : provider.probe(plan)
  try {
    return rendererProbeSchema.parse(result)
  } catch (error) {
    const resultRecord = asRecord(result)
    const measurementKeys = [
      'pageCount',
      'overflow',
      'clipping',
      'glyphCoverage',
      'shapedGlyphCoverage',
      'lineBreaks',
      'pageBreaks',
      'outputAnchors',
    ]
    if (measurementKeys.some((key) => key in resultRecord)) {
      return createRendererProbe(plan, result as any)
    }
    throw error
  }
}

function modePreference(context: PlanningContext, mode: LayoutMode) {
  const flow = contextField(context, 'flow')
  const dimensions = asRecord(contextField(context, 'logicalDimensions'))
  const unit = dimensions.unit
  const width = Number(dimensions.width ?? 0)
  if (flow === 'continuous') {
    return ({
      'single-column-reading': 0,
      sequence: 1,
      'compact-page': 2,
      'conventional-page': 3,
      'editorial-spread': 4,
    } as Record<LayoutMode, number>)[mode]
  }
  // Capabilities, not profile names, drive the standing preference: a small
  // physical sheet favours conventional/compact flow, a larger sheet can
  // afford a spread, and a device-pixel page favours conventional e-ink flow.
  if (unit === 'device-px') {
    return ({
      'conventional-page': 0,
      'compact-page': 1,
      sequence: 2,
      'editorial-spread': 3,
      'single-column-reading': 4,
    } as Record<LayoutMode, number>)[mode]
  }
  if (width >= 180) {
    return ({
      'editorial-spread': 0,
      'conventional-page': 1,
      sequence: 2,
      'compact-page': 3,
      'single-column-reading': 4,
    } as Record<LayoutMode, number>)[mode]
  }
  if (unit === 'mm' && width < 160) {
    return ({
      'compact-page': 0,
      'conventional-page': 1,
      sequence: 2,
      'editorial-spread': 3,
      'single-column-reading': 4,
    } as Record<LayoutMode, number>)[mode]
  }
  return ({
    'conventional-page': 0,
    'compact-page': 1,
    sequence: 2,
    'editorial-spread': 3,
    'single-column-reading': 4,
  } as Record<LayoutMode, number>)[mode]
}

function comparePlans(
  a: PlanCandidateEvaluation,
  b: PlanCandidateEvaluation,
  context: PlanningContext,
) {
  const aPreference = modePreference(context, a.plan.mode)
  const bPreference = modePreference(context, b.plan.mode)
  if (aPreference !== bPreference) return aPreference - bPreference
  const aMetrics = a.plan.softMetrics
  const bMetrics = b.plan.softMetrics
  const aPage = a.productionValidation?.pageCount ?? Number.POSITIVE_INFINITY
  const bPage = b.productionValidation?.pageCount ?? Number.POSITIVE_INFINITY
  const metrics: Array<[number, number]> = [
    [aPage, bPage],
    [aMetrics.density ?? 1, bMetrics.density ?? 1],
    [aMetrics.hierarchy ?? 0, bMetrics.hierarchy ?? 0],
    [aMetrics.figureProminence ?? 0, bMetrics.figureProminence ?? 0],
    [aMetrics.whitespace ?? 0, bMetrics.whitespace ?? 0],
    [a.plan.rank, b.plan.rank],
  ]
  for (const [left, right] of metrics) {
    if (left < right) return -1
    if (left > right) return 1
  }
  return 0
}

function alternativesFor(candidates: PlanCandidateEvaluation[], context: PlanningContext) {
  const codes = new Set(candidates.flatMap((candidate) => candidate.staticPreflight.hardViolations.map((violation) => violation.code)))
  candidates.forEach((candidate) =>
    candidate.productionValidation?.hardViolations.forEach((violation) => codes.add(violation.code)),
  )
  const alternatives: PlanningResult['alternatives'] = []
  if ([...codes].some((code) => /AUTHORED|VARIANT|ALTERNATIVE/iu.test(code))) {
    alternatives.push({
      kind: 'authored-variant',
      code: 'ADD_REVIEWED_AUTHORED_VARIANT',
      message: 'Add the smallest reviewed compact, monochrome, or static alternative required by the profile.',
    })
  }
  if ([...codes].some((code) => /WIDTH|DIMENSION|BLEED|BINDING|LEGIBILITY|RESOLUTION/iu.test(code))) {
    alternatives.push({
      kind: 'profile-relaxation',
      code: 'RELAX_SMALLEST_GEOMETRIC_CONSTRAINT',
      message: `Increase the content box beyond the current ${String(contextField(context, 'logicalDimensions')?.width ?? 'custom')} width or relax the conflicting print constraint.`,
    })
  }
  if ([...codes].some((code) => /POLICY|READING|RELATIONSHIP/iu.test(code))) {
    alternatives.push({
      kind: 'policy',
      code: 'REVIEW_STANDING_POLICY',
      message: 'Review the standing transformation policy; no renderer score can override a hard semantic failure.',
    })
  }
  if (!alternatives.length) {
    alternatives.push({
      kind: 'profile-relaxation',
      code: 'TRY_NEXT_LARGER_PROFILE',
      message: 'Try the next larger authored profile; no final artifact was emitted.',
    })
  }
  return alternatives
}

/** Plan and, when a renderer provider is supplied, gate candidates on measured
 * production evidence. Static-only calls intentionally return a plan marked
 * `requiresRendererProbe`; callers must not treat it as a final artifact. */
export function planPublication(
  first: PlanRequest | PublicationGraph,
  second?: PlanningContext,
  third?: PlannerPolicy | PlanningOptions,
  fourth?: PlanningOptions,
): PlanningResult {
  const request = normalizeRequest(first, second, third, fourth)
  const plans = enumerateLayoutCandidates(request)
  const provider = request.options?.renderer ?? request.options?.probe
  const candidates: PlanCandidateEvaluation[] = plans.map((plan) => {
    const staticPreflight = runStaticPreflight({
      graph: request.graph,
      context: request.context,
      policy: request.policy ?? DEFAULT_POLICY,
      plan,
      assets: request.options?.assets,
    })
    let probe: RendererProbe | undefined
    let productionValidation: ProductionValidationResult | undefined
    if (staticPreflight.passed && provider) {
      try {
        probe = providerProbe(provider, plan)
        productionValidation = validateProduction({
          graph: request.graph,
          context: request.context,
          plan,
          probe,
        })
      } catch (error) {
        productionValidation = {
          version: '1.0.0',
          passed: false,
          eligible: false,
          hardViolations: [
            {
              code: 'RENDERER_PROBE_INVALID',
              message: error instanceof Error ? error.message : String(error),
              stage: 'measured',
            },
          ],
          violations: [
            {
              code: 'RENDERER_PROBE_INVALID',
              message: error instanceof Error ? error.message : String(error),
              stage: 'measured',
            },
          ],
          softTradeoffs: [],
          pageCount: undefined,
          checked: {
            glyphs: false,
            overflow: false,
            clipping: false,
            keeps: false,
            links: false,
            fallbacks: false,
            printConstraints: false,
          },
        }
      }
    }
    const measuredViolations = productionValidation?.hardViolations ?? []
    const evaluationPlan = {
      ...plan,
      hardViolations: [
        ...plan.hardViolations,
        ...staticPreflight.hardViolations,
        ...measuredViolations,
      ],
      hardFailures: [
        ...plan.hardViolations,
        ...staticPreflight.hardViolations,
        ...measuredViolations,
      ],
      softTradeoffs:
        staticPreflight.passed &&
        (!provider || productionValidation?.passed)
          ? plan.softTradeoffs
          : [],
    }
    return Object.assign(evaluationPlan, {
      plan,
      staticPreflight,
      ...(probe ? { probe } : {}),
      ...(productionValidation ? { productionValidation } : {}),
    })
  })
  const staticEligible = candidates.filter((candidate) => candidate.staticPreflight.passed)
  const measuredEligible = provider
    ? staticEligible.filter((candidate) => candidate.productionValidation?.passed)
    : staticEligible
  const selectedCandidate =
    [...measuredEligible].sort((a, b) => comparePlans(a, b, request.context))[0] ?? null
  const selected = selectedCandidate?.plan ?? null
  const artifactEligible = Boolean(
    provider && selectedCandidate && selectedCandidate.productionValidation?.passed,
  )
  return {
    version: LAYOUT_PLAN_VERSION,
    plannerVersion: PLANNER_VERSION,
    graphId: request.graph.id,
    profileId: profileId(request.context),
    candidates,
    selectedPlan: selected,
    plan: selected,
    selected,
    eligible: Boolean(selected),
    artifactEligible,
    requiresRendererProbe: !provider && Boolean(selected),
    noEligiblePlan: !selected,
    alternatives: selected ? [] : alternativesFor(candidates, request.context),
  }
}

export const planLayout = planPublication
export const chooseLayoutPlan = planPublication

export function serializeLayoutPlan(plan: LayoutPlan) {
  return JSON.stringify(layoutPlanSchema.parse(plan))
}

import { z } from 'zod'
import {
  publicationGraphSchema,
  type PublicationGraph,
  type PublicationNode,
} from './schema'
import type {
  LayoutPlan,
  PlanningContext,
  PlannerPolicy,
} from './planner'

export const STATIC_PREFLIGHT_VERSION = '1.0.0' as const

export const staticViolationSchema = z
  .object({
    code: z.string().min(1).max(256),
    message: z.string().min(1).max(10_000),
    nodeId: z.string().min(1).max(256).optional(),
    stage: z.literal('static'),
  })
  .strict()

export type StaticViolation = z.infer<typeof staticViolationSchema>

export const staticPreflightResultSchema = z
  .object({
    version: z.literal(STATIC_PREFLIGHT_VERSION),
    passed: z.boolean(),
    eligible: z.boolean(),
    hardViolations: z.array(staticViolationSchema).max(100_000),
    /** Alias used by diagnostic consumers; it is always the same ordered list. */
    violations: z.array(staticViolationSchema).max(100_000),
    softTradeoffs: z
      .array(
        z
          .object({
            code: z.string().min(1).max(256),
            message: z.string().min(1).max(10_000),
            value: z.union([z.string(), z.number().finite(), z.boolean()]).optional(),
          })
          .strict(),
      )
      .max(100_000),
    checkedNodeIds: z.array(z.string().min(1).max(256)).max(100_000),
    remainingUncertainty: z.array(z.string().min(1).max(10_000)).max(1_000),
  })
  .strict()

export type StaticPreflightResult = z.infer<typeof staticPreflightResultSchema>

export type StaticPreflightRequest = {
  graph: PublicationGraph
  context: PlanningContext
  policy: PlannerPolicy
  plan?: LayoutPlan
  assets?: readonly Record<string, unknown>[] | Record<string, unknown>
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object'
    ? (value as Record<string, any>)
    : {}
}

function contextValue(context: PlanningContext, key: string) {
  return record(context)[key]
}

function add(
  violations: StaticViolation[],
  code: string,
  message: string,
  nodeId?: string,
) {
  const violation: StaticViolation = {
    code,
    message,
    stage: 'static',
    ...(nodeId ? { nodeId } : {}),
  }
  if (
    !violations.some(
      (candidate) =>
        candidate.code === violation.code && candidate.nodeId === violation.nodeId,
    )
  )
    violations.push(violation)
}

function nodeRelationships(node: PublicationNode) {
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

function variant(node: PublicationNode, kind: 'compact' | 'monochrome' | 'static') {
  return node.variants.find((candidate) => candidate.kind === kind && candidate.reviewed)
}

function isStaticContext(context: PlanningContext) {
  const refresh = contextValue(context, 'refresh')
  return (
    (refresh !== undefined && refresh !== 'dynamic') ||
    contextValue(context, 'interaction') === 'none'
  )
}

function contentWidth(context: PlanningContext) {
  const dimensions = record(contextValue(context, 'logicalDimensions'))
  const margins = record(contextValue(context, 'margins'))
  const width = Number(dimensions.width)
  const left = Number(margins.left ?? 0)
  const right = Number(margins.right ?? 0)
  return Number.isFinite(width) ? width - left - right : 0
}

function contentHeight(context: PlanningContext) {
  const dimensions = record(contextValue(context, 'logicalDimensions'))
  const margins = record(contextValue(context, 'margins'))
  if (dimensions.height === null || dimensions.height === undefined) return null
  const height = Number(dimensions.height)
  return Number.isFinite(height)
    ? height - Number(margins.top ?? 0) - Number(margins.bottom ?? 0)
    : 0
}

function checkAssets(
  graph: PublicationGraph,
  context: PlanningContext,
  assets: readonly Record<string, unknown>[] | Record<string, unknown> | undefined,
  violations: StaticViolation[],
) {
  if (!assets) return
  const assetList = Array.isArray(assets)
    ? assets
    : Array.isArray(record(assets).assets)
      ? (record(assets).assets as Record<string, unknown>[])
      : []
  const byId = new Map(assetList.map((asset) => [String(asset.id ?? ''), asset]))
  const dimensions = record(contextValue(context, 'logicalDimensions'))
  const resolution = record(contextValue(context, 'resolution'))
  const requiredWidth = Number(
    resolution.devicePixels?.width ??
      resolution.minimumWidthPx ??
      (dimensions.unit === 'mm'
        ? (Number(dimensions.width ?? 0) * Number(resolution.pixelsPerInch ?? 0)) / 25.4
        : dimensions.width ?? 0),
  )
  for (const node of graph.nodes) {
    const ids =
      node.type === 'figure'
        ? node.assetIds
        : node.type === 'media'
          ? [node.assetId]
          : []
    for (const id of ids) {
      const asset = byId.get(id)
      if (!asset) {
        add(violations, 'MISSING_ASSET_DESCRIPTOR', `No declared asset descriptor exists for ${id}.`, node.id)
        continue
      }
      const width = Number(
        asset.widthPx ??
          asset.pixelWidth ??
          record(asset.resolution).widthPx ??
          0,
      )
      const minimum = Number(asset.minimumWidthPx ?? requiredWidth)
      if (width > 0 && minimum > 0 && width < minimum) {
        add(
          violations,
          'INSUFFICIENT_DECLARED_ASSET_RESOLUTION',
          `Asset ${id} declares ${width}px but the profile requires at least ${minimum}px.`,
          node.id,
        )
      }
      if (
        !node.accessibility.decorative &&
        !node.accessibility.alternativeText &&
        node.requirement === 'required'
      ) {
        add(
          violations,
          'MISSING_REQUIRED_ALTERNATIVE_TEXT',
          `Required visual node ${node.id} has no authored alternative text.`,
          node.id,
        )
      }
    }
  }
}

function checkPolicy(
  graph: PublicationGraph,
  policy: PlannerPolicy,
  plan: LayoutPlan | undefined,
  violations: StaticViolation[],
) {
  const policyRecord = record(policy)
  const transformations = Array.isArray(policyRecord.transformations)
    ? policyRecord.transformations
    : []
  const constraints = Array.isArray(policyRecord.constraints) ? policyRecord.constraints : []
  for (const constraint of constraints) {
    if (
      constraint.strength === 'hard' &&
      constraint.subject === 'reading-order' &&
      constraint.operator === 'forbid' &&
      constraint.value === true
    ) {
      add(violations, 'POLICY_FORBIDS_READING_ORDER_CHANGE', constraint.rationale)
    }
  }
  for (const transformation of transformations) {
    const requiredKind = transformation.requiredAuthoredAlternative
    if (!requiredKind || requiredKind === 'none') continue
    for (const node of graph.nodes) {
      if (!node.permittedTransformationIds.includes(String(transformation.id))) continue
      if (
        !variant(
          node,
          requiredKind as 'compact' | 'monochrome' | 'static',
        )
      ) {
        add(
          violations,
          'MISSING_REQUIRED_AUTHORED_VARIANT',
          `Policy transformation ${transformation.id} requires an authored ${requiredKind} variant.`,
          node.id,
        )
      }
    }
  }
  if (!plan) return
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  for (const fragment of plan.fragments) {
    const node = nodesById.get(fragment.nodeId)
    if (!node) continue
    const kind =
      fragment.representation === 'compact' ||
      fragment.representation === 'monochrome' ||
      fragment.representation === 'static'
        ? fragment.representation
        : undefined
    if (kind) {
      const allowed = node.permittedTransformationIds
      const transformation = transformations.find(
        (candidate: any) =>
          candidate.id === fragment.transformationId ||
          candidate.requiredAuthoredAlternative === kind,
      )
      if (allowed.length && fragment.transformationId && !allowed.includes(fragment.transformationId)) {
        add(
          violations,
          'TRANSFORMATION_NOT_PERMITTED_BY_NODE',
          `Node ${node.id} does not permit transformation ${fragment.transformationId}.`,
          node.id,
        )
      }
      if (
        transformation &&
        transformation.requiredAuthoredAlternative === kind &&
        transformation.reviewedVariantId &&
        !variant(node, kind)
      ) {
        add(
          violations,
          'MISSING_REQUIRED_AUTHORED_VARIANT',
          `Policy transformation ${transformation.id} requires a reviewed ${kind} variant.`,
          node.id,
        )
      }
    }
  }
}

function checkPlan(
  graph: PublicationGraph,
  context: PlanningContext,
  plan: LayoutPlan | undefined,
  violations: StaticViolation[],
) {
  if (!plan) return
  for (const violation of plan.hardViolations) {
    add(violations, violation.code, violation.message, violation.nodeId)
  }
  const rawFragments = [...plan.fragments]
  const fragments = [...rawFragments].sort((a, b) => a.order - b.order)
  const canonicalIndex = new Map(graph.nodes.map((node, index) => [node.id, index]))
  let lastCanonicalIndex = -1
  for (const fragment of rawFragments) {
    const index = canonicalIndex.get(fragment.nodeId)
    if (index !== undefined && index < lastCanonicalIndex) {
      add(violations, 'READING_ORDER_CHANGED', 'The plan changes canonical reading order.')
      break
    }
    if (index !== undefined) lastCanonicalIndex = index
  }
  const firstOrder = new Map<string, number>()
  for (const fragment of fragments) {
    if (!firstOrder.has(fragment.nodeId)) firstOrder.set(fragment.nodeId, fragment.order)
  }
  graph.nodes.forEach((node, index) => {
    if (!firstOrder.has(node.id) && node.requirement === 'required') {
      add(
        violations,
        'REQUIRED_NODE_UNREACHABLE',
        `Required node ${node.id} is not represented by the layout plan.`,
        node.id,
      )
    }
    if (firstOrder.has(node.id) && firstOrder.get(node.id)! < 0) {
      add(violations, 'INVALID_SOURCE_ANCHOR', `Node ${node.id} has an invalid source anchor.`, node.id)
    }
    const expected = firstOrder.get(node.id)
    if (expected !== undefined && expected < index) {
      // A fragment can have a later output order than its graph index only when
      // it is an ordered continuation of the same node. The first fragment is
      // the canonical ordering authority.
    }
  })
  let previous = -1
  for (const node of graph.nodes) {
    const order = firstOrder.get(node.id)
    if (order === undefined) continue
    if (order < previous) {
      add(violations, 'READING_ORDER_CHANGED', 'The plan changes canonical reading order.')
      break
    }
    previous = order
  }
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  for (const fragment of fragments) {
    const node = nodesById.get(fragment.nodeId)
    if (!node) {
      add(violations, 'UNKNOWN_PLAN_NODE', `Plan references unknown node ${fragment.nodeId}.`, fragment.nodeId)
      continue
    }
    const selected = fragment.representation
    if (selected === 'static' && (!variant(node, 'static') || node.type !== 'media' || node.mediaKind !== 'interactive')) {
      add(
        violations,
        'MISSING_REQUIRED_STATIC_ALTERNATIVE',
        `Interactive node ${node.id} requires an authored reviewed static alternative.`,
        node.id,
      )
    }
    if (selected === 'monochrome' && !variant(node, 'monochrome')) {
      add(
        violations,
        'MISSING_REQUIRED_MONOCHROME_ALTERNATIVE',
        `Color-sensitive node ${node.id} requires an authored reviewed monochrome alternative.`,
        node.id,
      )
    }
    if (selected === 'compact' && !variant(node, 'compact')) {
      add(
        violations,
        'MISSING_REQUIRED_COMPACT_ALTERNATIVE',
        `Compact representation for ${node.id} is not authored and reviewed.`,
        node.id,
      )
    }
    if (
      node.requirement === 'required' &&
      isStaticContext(context) &&
      node.type === 'media' &&
      node.mediaKind === 'interactive' &&
      selected !== 'static'
    ) {
      add(
        violations,
        'INTERACTIVE_MEDIA_NOT_STATIC',
        `Static profile cannot emit interactive media ${node.id}.`,
        node.id,
      )
    }
    const targets = nodeRelationships(node)
    for (const target of targets) {
      if (!nodesById.has(target)) {
        add(violations, 'DANGLING_RELATIONSHIP', `Relationship from ${node.id} targets missing node ${target}.`, node.id)
      }
    }
  }
}

function checkGeometry(context: PlanningContext, violations: StaticViolation[]) {
  const width = contentWidth(context)
  const unit = String(record(contextValue(context, 'logicalDimensions')).unit ?? 'css-px')
  const floor = unit === 'mm' || unit === 'in' ? 20 : 80
  if (!Number.isFinite(width) || width <= 0) {
    add(violations, 'NON_POSITIVE_CONTENT_BOX', 'Margins consume the entire logical width.')
  } else if (width < floor) {
    add(
      violations,
      'KNOWN_LEGIBILITY_FLOOR',
      `The ${unit} content width ${width} is below the deterministic legibility floor ${floor}.`,
    )
  }
  const height = contentHeight(context)
  if (height !== null && (!Number.isFinite(height) || height <= 0)) {
    add(violations, 'NON_POSITIVE_CONTENT_HEIGHT', 'Margins consume the entire logical height.')
  }
  const bleed = record(contextValue(context, 'bleed'))
  const margins = record(contextValue(context, 'margins'))
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    if (Number(bleed[edge] ?? 0) > Number(margins[edge] ?? 0)) {
      add(violations, 'BLEED_EXCEEDS_MARGIN', `${edge} bleed exceeds the declared margin.`)
    }
  }
  const binding = contextValue(context, 'binding')
  const duplex = contextValue(context, 'duplex')
  if (binding && binding !== 'none' && duplex === 'none') {
    add(violations, 'INCOMPATIBLE_BLEED_BINDING_CONSTRAINTS', 'A bound profile requires a duplex/binding edge.')
  }
}

function normalizeRequest(
  first: StaticPreflightRequest | PublicationGraph,
  second?: PlanningContext,
  third?: PlannerPolicy,
  fourth?: LayoutPlan,
  fifth?: readonly Record<string, unknown>[] | Record<string, unknown>,
): StaticPreflightRequest {
  const firstRecord = record(first)
  if (firstRecord.publicationGraph && firstRecord.compositionContext) {
    return {
      graph: firstRecord.publicationGraph as PublicationGraph,
      context: firstRecord.compositionContext as PlanningContext,
      policy: (firstRecord.transformationPolicy ?? firstRecord.policy) as PlannerPolicy,
      plan: firstRecord.plan as LayoutPlan | undefined,
      assets: firstRecord.assets as
        | readonly Record<string, unknown>[]
        | Record<string, unknown>
        | undefined,
    }
  }
  if (first && 'graph' in first) return first as StaticPreflightRequest
  if (second && 'fragments' in (second as object)) {
    return {
      graph: first as PublicationGraph,
      context: third as unknown as PlanningContext,
      policy: fourth as unknown as PlannerPolicy,
      plan: second as unknown as LayoutPlan,
      assets: fifth,
    }
  }
  if (third && 'fragments' in (third as object)) {
    return {
      graph: first as PublicationGraph,
      context: second as PlanningContext,
      policy: fourth as unknown as PlannerPolicy,
      plan: third as unknown as LayoutPlan,
      assets: fifth,
    }
  }
  return {
    graph: first as PublicationGraph,
    context: second as PlanningContext,
    policy: third as PlannerPolicy,
    plan: fourth,
    assets: fifth,
  }
}

/** Static checks are intentionally pure and renderer-neutral. */
export function runStaticPreflight(
  first: StaticPreflightRequest | PublicationGraph,
  second?: PlanningContext,
  third?: PlannerPolicy,
  fourth?: LayoutPlan,
  fifth?: readonly Record<string, unknown>[] | Record<string, unknown>,
): StaticPreflightResult {
  const request = normalizeRequest(first, second, third, fourth, fifth)
  const violations: StaticViolation[] = []
  let graph: PublicationGraph
  let validGraph = true
  try {
    graph = publicationGraphSchema.parse(request.graph)
  } catch (error) {
    add(violations, 'INVALID_PUBLICATION_GRAPH', error instanceof Error ? error.message : String(error))
    validGraph = false
    graph = { ...(request.graph as any), nodes: [] } as PublicationGraph
  }
  checkGeometry(request.context, violations)
  if (validGraph) {
    checkPlan(graph, request.context, request.plan, violations)
    checkPolicy(graph, request.policy, request.plan, violations)
    checkAssets(graph, request.context, request.assets, violations)
  }
  const passed = violations.length === 0
  const result = staticPreflightResultSchema.parse({
    version: STATIC_PREFLIGHT_VERSION,
    passed,
    eligible: passed,
    hardViolations: violations,
    violations,
    softTradeoffs: passed
      ? request.plan?.softTradeoffs ?? []
      : [],
    checkedNodeIds: graph.nodes.map((node) => node.id),
    remainingUncertainty: [
      'Static preflight does not prove renderer geometry, glyph shaping, links, or production output.',
    ],
  })
  return result
}

export const staticPreflight = runStaticPreflight
export const preflightStaticSemantics = runStaticPreflight
export const validateStaticPreflight = runStaticPreflight

export function assertStaticPreflight(result: StaticPreflightResult) {
  const parsed = staticPreflightResultSchema.parse(result)
  if (!parsed.passed) {
    throw new Error(
      `Static preflight failed: ${parsed.hardViolations
        .map((violation) => violation.code)
        .join(', ')}`,
    )
  }
  return parsed
}

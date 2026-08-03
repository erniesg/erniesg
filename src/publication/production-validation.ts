import { z } from 'zod'
import type { LayoutPlan, PlanningContext } from './planner'
import {
  rendererProbeSchema,
  type RendererProbe,
} from './renderer-probe'
import type { PublicationGraph } from './schema'

export const PRODUCTION_VALIDATION_VERSION = '1.0.0' as const

export const productionViolationSchema = z
  .object({
    code: z.string().min(1).max(256),
    message: z.string().min(1).max(10_000),
    nodeId: z.string().min(1).max(256).optional(),
    stage: z.literal('measured'),
  })
  .strict()

export type ProductionViolation = z.infer<typeof productionViolationSchema>

export const productionValidationSchema = z
  .object({
    version: z.literal(PRODUCTION_VALIDATION_VERSION),
    passed: z.boolean(),
    eligible: z.boolean(),
    hardViolations: z.array(productionViolationSchema).max(100_000),
    violations: z.array(productionViolationSchema).max(100_000),
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
    pageCount: z.number().int().nonnegative().optional(),
    checked: z
      .object({
        glyphs: z.boolean(),
        overflow: z.boolean(),
        clipping: z.boolean(),
        keeps: z.boolean(),
        links: z.boolean(),
        fallbacks: z.boolean(),
        printConstraints: z.boolean(),
      })
      .strict(),
  })
  .strict()

export type ProductionValidationResult = z.infer<typeof productionValidationSchema>

export type ProductionValidationRequest = {
  graph: PublicationGraph
  context: PlanningContext
  plan: LayoutPlan
  probe: RendererProbe
}

function add(
  violations: ProductionViolation[],
  code: string,
  message: string,
  nodeId?: string,
) {
  const violation: ProductionViolation = {
    code,
    message,
    stage: 'measured',
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

function hasFailure(value: unknown) {
  if (value === true) return true
  return Array.isArray(value) && value.length > 0
    ? true
    : Boolean(value && typeof value === 'object' && Object.keys(value).length)
}

function failureNodes(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? [value]
      : []
  return values
    .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}))
    .map((entry) => (typeof entry.nodeId === 'string' ? entry.nodeId : undefined))
    .filter((id): id is string => Boolean(id))
}

function contextValue(context: PlanningContext, key: string) {
  return context && typeof context === 'object'
    ? (context as Record<string, unknown>)[key]
    : undefined
}

function validateOutputAnchors(plan: LayoutPlan, probe: RendererProbe, violations: ProductionViolation[]) {
  const actual = new Set(probe.outputAnchors.map((anchor) => anchor.id))
  for (const anchor of plan.outputAnchors) {
    if (!actual.has(anchor.id)) {
      add(
        violations,
        'MISSING_OUTPUT_ANCHOR',
        `Renderer probe omitted output anchor ${anchor.id}.`,
        anchor.nodeId,
      )
    }
  }
}

function validateLinks(probe: RendererProbe, violations: ProductionViolation[]) {
  for (const link of probe.linkTargets) {
    if (!link.resolved) add(violations, 'BROKEN_LINK_TARGET', `Link target ${link.targetId} is unresolved.`, link.sourceId)
  }
}

function validateKeeps(probe: RendererProbe, violations: ProductionViolation[]) {
  for (const keep of probe.keeps) {
    if (!keep.satisfied) add(violations, 'BROKEN_KEEP_RELATIONSHIP', `Keep relationship ${keep.id} was not satisfied.`, keep.nodeId)
  }
}

function validateFallbacks(probe: RendererProbe, violations: ProductionViolation[]) {
  for (const fallback of probe.fallbacks) {
    if (!fallback.usable) {
      const code = fallback.kind === 'table'
        ? 'UNUSABLE_TABLE_FALLBACK'
        : fallback.kind === 'equation'
          ? 'UNUSABLE_EQUATION_FALLBACK'
          : 'UNUSABLE_FALLBACK'
      add(violations, code, fallback.reason ?? `The ${fallback.kind} fallback is unusable.`, fallback.nodeId)
    }
  }
}

function validateFigureCaptions(probe: RendererProbe, violations: ProductionViolation[]) {
  for (const geometry of probe.figureCaptionGeometry) {
    if (!geometry.withinPage) add(violations, 'FIGURE_CAPTION_OUT_OF_BOUNDS', `Figure ${geometry.figureId} or its caption lies outside the page.`, geometry.figureId)
    if (geometry.captionId && !geometry.caption) add(violations, 'MISSING_FIGURE_CAPTION_GEOMETRY', `Caption geometry for ${geometry.captionId} was not measured.`, geometry.captionId)
  }
}

function normalizeRequest(
  first: ProductionValidationRequest | LayoutPlan,
  second?: RendererProbe,
  third?: PublicationGraph,
  fourth?: PlanningContext,
): ProductionValidationRequest {
  if (first && 'plan' in first && 'probe' in first) return first as ProductionValidationRequest
  return {
    plan: first as LayoutPlan,
    probe: second as RendererProbe,
    graph: third as PublicationGraph,
    context: fourth as PlanningContext,
  }
}

/** Apply measured hard gates after static preflight.  All facts in this result
 * belong to the renderer probe; none are copied into the graph or policy. */
export function validateProduction(
  first: ProductionValidationRequest | LayoutPlan,
  second?: RendererProbe,
  third?: PublicationGraph,
  fourth?: PlanningContext,
): ProductionValidationResult {
  const request = normalizeRequest(first, second, third, fourth)
  const violations: ProductionViolation[] = []
  let probe: RendererProbe
  try {
    probe = rendererProbeSchema.parse(request.probe)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    add(violations, 'INVALID_RENDERER_PROBE', message)
    return productionValidationSchema.parse({
      version: PRODUCTION_VALIDATION_VERSION,
      passed: false,
      eligible: false,
      hardViolations: violations,
      violations,
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
    })
  }
  if (probe.planId !== request.plan.id) add(violations, 'PROBE_PLAN_MISMATCH', 'Renderer probe does not belong to the selected layout plan.')
  if (probe.graphId !== request.plan.graphId) add(violations, 'PROBE_GRAPH_MISMATCH', 'Renderer probe graph identity does not match the selected plan.')
  if (hasFailure(probe.overflow)) {
    for (const nodeId of failureNodes(probe.overflow)) add(violations, 'UNEXPECTED_OVERFLOW', 'Renderer reported content overflow.', nodeId)
    if (!failureNodes(probe.overflow).length) add(violations, 'UNEXPECTED_OVERFLOW', 'Renderer reported content overflow.')
  }
  if (hasFailure(probe.clipping)) {
    for (const nodeId of failureNodes(probe.clipping)) add(violations, 'UNEXPECTED_CLIPPING', 'Renderer reported clipping.', nodeId)
    if (!failureNodes(probe.clipping).length) add(violations, 'UNEXPECTED_CLIPPING', 'Renderer reported clipping.')
  }
  const coverage = probe.shapedGlyphCoverage
  if (coverage.missing.length || coverage.unsupported.length) {
    add(violations, 'UNSUPPORTED_GLYPH_SHAPING', `Renderer could not shape ${coverage.missing.length + coverage.unsupported.length} glyph(s).`)
  }
  if (!probe.hyphenation.supported || probe.hyphenation.missing.length) {
    add(violations, 'UNSUPPORTED_HYPHENATION', 'Renderer did not provide the required hyphenation behavior.')
  }
  validateKeeps(probe, violations)
  validateLinks(probe, violations)
  validateFallbacks(probe, violations)
  validateFigureCaptions(probe, violations)
  validateOutputAnchors(request.plan, probe, violations)
  if (!probe.printConstraints.withinBounds || probe.printConstraints.violations.length) {
    add(violations, 'PRINT_CONSTRAINT_VIOLATION', 'Renderer reported a print production constraint failure.')
  }
  if (contextValue(request.context, 'flow') === 'paged' && probe.pageCount < 1) {
    add(violations, 'NO_RENDERED_PAGES', 'A paged profile must produce at least one page.')
  }
  const passed = violations.length === 0
  const checked = {
    glyphs: coverage.missing.length === 0 && coverage.unsupported.length === 0,
    overflow: !hasFailure(probe.overflow),
    clipping: !hasFailure(probe.clipping),
    keeps: probe.keeps.every((keep) => keep.satisfied),
    links: probe.linkTargets.every((link) => link.resolved),
    fallbacks: probe.fallbacks.every((fallback) => fallback.usable),
    printConstraints: probe.printConstraints.withinBounds && probe.printConstraints.violations.length === 0,
  }
  return productionValidationSchema.parse({
    version: PRODUCTION_VALIDATION_VERSION,
    passed,
    eligible: passed,
    hardViolations: violations,
    violations,
    softTradeoffs: passed ? request.plan.softTradeoffs : [],
    pageCount: probe.pageCount,
    checked,
  })
}

export const productionValidation = validateProduction
export const validateMeasuredProduction = validateProduction

export function validateRendererProbe(
  plan: LayoutPlan,
  probe: RendererProbe,
  context: PlanningContext,
  graph: PublicationGraph,
) {
  return validateProduction({ graph, context, plan, probe })
}

export const validateProductionProbe = validateRendererProbe

export function assertProductionPass(result: ProductionValidationResult) {
  const parsed = productionValidationSchema.parse(result)
  if (!parsed.passed) {
    throw new Error(
      `Production validation failed: ${parsed.hardViolations
        .map((violation) => violation.code)
        .join(', ')}`,
    )
  }
  return parsed
}

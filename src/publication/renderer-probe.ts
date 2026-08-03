import { z } from 'zod'
import type { LayoutPlan } from './planner'

export const RENDERER_PROBE_VERSION = '1.0.0' as const

const diagnosticSchema = z
  .object({
    code: z.string().min(1).max(256),
    message: z.string().min(1).max(10_000).optional(),
    type: z.string().min(1).max(256).optional(),
    kind: z.string().min(1).max(256).optional(),
    severity: z.string().min(1).max(64).optional(),
    nodeId: z.string().min(1).max(256).optional(),
    fragmentId: z.string().min(1).max(256).optional(),
  })
  .strict()

const anchorSchema = z
  .object({
    id: z.string().min(1).max(256),
    nodeId: z.string().min(1).max(256),
    fragmentIndex: z.number().int().nonnegative(),
    page: z.number().int().positive().optional(),
    line: z.number().int().nonnegative().optional(),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
  })
  .strict()

const breakSchema = z
  .object({
    id: z.string().min(1).max(256),
    nodeId: z.string().min(1).max(256).optional(),
    fragmentId: z.string().min(1).max(256).optional(),
    page: z.number().int().positive().optional(),
    line: z.number().int().nonnegative().optional(),
    index: z.number().int().nonnegative().optional(),
  })
  .strict()

const geometrySchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
    page: z.number().int().positive().optional(),
  })
  .strict()

const figureCaptionSchema = z
  .object({
    figureId: z.string().min(1).max(256),
    captionId: z.string().min(1).max(256).optional(),
    figure: geometrySchema,
    caption: geometrySchema.optional(),
    withinPage: z.boolean(),
  })
  .strict()

const linkTargetSchema = z
  .object({
    sourceId: z.string().min(1).max(256),
    targetId: z.string().min(1).max(256),
    resolved: z.boolean(),
  })
  .strict()

const keepSchema = z
  .object({
    id: z.string().min(1).max(256),
    nodeId: z.string().min(1).max(256),
    withNodeId: z.string().min(1).max(256),
    satisfied: z.boolean(),
  })
  .strict()

const fallbackSchema = z
  .object({
    nodeId: z.string().min(1).max(256),
    kind: z.enum(['table', 'equation', 'figure', 'media', 'unknown']),
    usable: z.boolean(),
    reason: z.string().max(10_000).optional(),
  })
  .strict()

const glyphCoverageSchema = z
  .object({
    requested: z.array(z.string()).max(1_000_000),
    shaped: z.array(z.string()).max(1_000_000),
    missing: z.array(z.string()).max(1_000_000),
    unsupported: z.array(z.string()).max(1_000_000),
  })
  .strict()

const failureList = z.union([
  z.boolean(),
  z.array(diagnosticSchema).max(100_000),
  z.record(z.unknown()),
])

export const rendererProbeSchema = z
  .object({
    version: z.literal(RENDERER_PROBE_VERSION),
    rendererId: z.string().min(1).max(256),
    rendererVersion: z.string().min(1).max(256),
    planId: z.string().min(1).max(256),
    graphId: z.string().min(1).max(256),
    profileId: z.string().min(1).max(256),
    pageCount: z.number().int().nonnegative(),
    shapedGlyphCoverage: glyphCoverageSchema,
    /** `glyphCoverage` is retained as a descriptive alias for consumers that
     * do not know the longer contract field name. */
    glyphCoverage: glyphCoverageSchema,
    lineBreaks: z.array(breakSchema).max(1_000_000),
    pageBreaks: z.array(breakSchema).max(1_000_000),
    overflow: failureList,
    clipping: failureList,
    figureCaptionGeometry: z.array(figureCaptionSchema).max(100_000),
    linkTargets: z.array(linkTargetSchema).max(1_000_000),
    outputAnchors: z.array(anchorSchema).max(1_000_000),
    keeps: z.array(keepSchema).max(1_000_000),
    fallbacks: z.array(fallbackSchema).max(100_000),
    hyphenation: z
      .object({
        supported: z.boolean(),
        missing: z.array(z.string().max(256)).max(100_000),
      })
      .strict(),
    printConstraints: z
      .object({
        withinBounds: z.boolean(),
        violations: z.array(diagnosticSchema).max(100_000),
      })
      .strict(),
    diagnostics: z.array(diagnosticSchema).max(100_000),
    output: z
      .object({
        artifactSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        byteLength: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict()

export type RendererProbe = z.infer<typeof rendererProbeSchema>

export type RendererMeasurement = Partial<{
  rendererId: string
  rendererVersion: string
  pageCount: number
  shapedGlyphCoverage: Partial<z.infer<typeof glyphCoverageSchema>>
  glyphCoverage: Partial<z.infer<typeof glyphCoverageSchema>>
  lineBreaks: z.infer<typeof breakSchema>[]
  pageBreaks: z.infer<typeof breakSchema>[]
  overflow: z.infer<typeof failureList>
  clipping: z.infer<typeof failureList>
  figureCaptionGeometry: z.infer<typeof figureCaptionSchema>[]
  linkTargets: z.infer<typeof linkTargetSchema>[]
  outputAnchors: z.infer<typeof anchorSchema>[]
  keeps: z.infer<typeof keepSchema>[]
  fallbacks: z.infer<typeof fallbackSchema>[]
  hyphenation: { supported: boolean; missing?: string[] }
  printConstraints: { withinBounds: boolean; violations?: z.infer<typeof diagnosticSchema>[] }
  diagnostics: z.infer<typeof diagnosticSchema>[]
  output: { artifactSha256?: string; byteLength?: number }
}>

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object'
    ? (value as Record<string, any>)
    : {}
}

function coverage(value: unknown): z.infer<typeof glyphCoverageSchema> {
  const input = asRecord(value)
  return {
    requested: Array.isArray(input.requested)
      ? input.requested.map(String)
      : Array.isArray(input.glyphs)
        ? input.glyphs.map(String)
        : [],
    shaped: Array.isArray(input.shaped) ? input.shaped.map(String) : [],
    missing: Array.isArray(input.missing)
      ? input.missing.map(String)
      : Array.isArray(input.missingGlyphs)
        ? input.missingGlyphs.map(String)
        : [],
    unsupported: Array.isArray(input.unsupported)
      ? input.unsupported.map(String)
      : Array.isArray(input.unsupportedGlyphs)
        ? input.unsupportedGlyphs.map(String)
        : [],
  }
}

function defaultAnchors(plan: LayoutPlan) {
  return plan.outputAnchors.map((anchor) => ({
    id: anchor.id,
    nodeId: anchor.nodeId,
    fragmentIndex: anchor.fragmentIndex,
    page: 1,
  }))
}

function defaultBreaks(plan: LayoutPlan) {
  return plan.fragments.map((fragment) => ({
    id: fragment.id,
    nodeId: fragment.nodeId,
    fragmentId: fragment.id,
    page: 1,
    line: fragment.order,
  }))
}

function normalizeFailure(value: unknown): boolean | z.infer<typeof diagnosticSchema>[] {
  if (typeof value === 'boolean') return value
  const values = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []
  if (!values.length) return false
  return values.map((item) => {
    const input = asRecord(item)
    return {
      code: String(input.code ?? input.type ?? input.kind ?? 'RENDERER_FAILURE'),
      ...(input.message ? { message: String(input.message) } : {}),
      ...(input.type ? { type: String(input.type) } : {}),
      ...(input.kind ? { kind: String(input.kind) } : {}),
      ...(input.severity ? { severity: String(input.severity) } : {}),
      ...(input.nodeId ? { nodeId: String(input.nodeId) } : {}),
      ...(input.fragmentId ? { fragmentId: String(input.fragmentId) } : {}),
    }
  })
}

/** Build a versioned, renderer-specific evidence object.  The function never
 * copies measurements into PublicationGraph or standing policy. */
export function createRendererProbe(
  plan: LayoutPlan,
  measurement: RendererMeasurement = {},
): RendererProbe {
  const input = asRecord(measurement)
  const glyph = coverage(input.shapedGlyphCoverage ?? input.glyphCoverage)
  const normalized = rendererProbeSchema.parse({
    version: RENDERER_PROBE_VERSION,
    rendererId: String(input.rendererId ?? 'renderer'),
    rendererVersion: String(input.rendererVersion ?? 'unknown'),
    planId: plan.id,
    graphId: plan.graphId,
    profileId: plan.profileId,
    pageCount: Number.isInteger(input.pageCount) && Number(input.pageCount) >= 0 ? Number(input.pageCount) : 1,
    shapedGlyphCoverage: glyph,
    glyphCoverage: glyph,
    lineBreaks: Array.isArray(input.lineBreaks) ? input.lineBreaks : defaultBreaks(plan),
    pageBreaks: Array.isArray(input.pageBreaks) ? input.pageBreaks : defaultBreaks(plan),
    overflow: normalizeFailure(input.overflow),
    clipping: normalizeFailure(input.clipping),
    figureCaptionGeometry: Array.isArray(input.figureCaptionGeometry) ? input.figureCaptionGeometry : [],
    linkTargets: Array.isArray(input.linkTargets) ? input.linkTargets : [],
    outputAnchors: Array.isArray(input.outputAnchors) ? input.outputAnchors : defaultAnchors(plan),
    keeps: Array.isArray(input.keeps) ? input.keeps : [],
    fallbacks: Array.isArray(input.fallbacks) ? input.fallbacks : [],
    hyphenation: {
      supported: input.hyphenation ? Boolean(asRecord(input.hyphenation).supported) : true,
      missing: input.hyphenation && Array.isArray(asRecord(input.hyphenation).missing)
        ? asRecord(input.hyphenation).missing.map(String)
        : [],
    },
    printConstraints: {
      withinBounds: input.printConstraints
        ? Boolean(asRecord(input.printConstraints).withinBounds)
        : true,
      violations: input.printConstraints && Array.isArray(asRecord(input.printConstraints).violations)
        ? asRecord(input.printConstraints).violations
        : [],
    },
    diagnostics: Array.isArray(input.diagnostics) ? input.diagnostics : [],
    output: input.output ?? {},
  })
  return normalized
}

export const buildRendererProbe = createRendererProbe
export const createProbe = createRendererProbe

export function probeLayoutPlan(
  plan: LayoutPlan,
  measurement: RendererMeasurement = {},
) {
  return createRendererProbe(plan, measurement)
}

export const probeRenderer = probeLayoutPlan

export function serializeRendererProbe(probe: RendererProbe) {
  return JSON.stringify(rendererProbeSchema.parse(probe))
}

export function assertRendererProbe(probe: RendererProbe) {
  return rendererProbeSchema.parse(probe)
}

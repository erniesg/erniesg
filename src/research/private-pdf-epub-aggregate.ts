import { z } from 'zod'
import {
  PRIVATE_PDF_EPUB_CATEGORIES,
  PRIVATE_PDF_EPUB_STRUCT_ARTIFACT,
  safePrivatePdfEpubError,
  type PrivatePdfEpubCategory,
  type PrivatePdfEpubExport,
} from './private-pdf-epub-bridge'

export { PRIVATE_PDF_EPUB_CATEGORIES, safePrivatePdfEpubError }

export const PRIVATE_PDF_EPUB_OUTCOMES = [
  'rendered-ready',
  'source-preserved-ready',
  'expected-review-refusal',
  'invalid-bridge-document',
  'unexpected-renderer-refusal',
  'conformance-failure',
] as const

export const PRIVATE_PDF_EPUB_ZERO_TOLERANCE_KEYS = [
  'privacySanitizerFailureCount',
  'falseLinkCount',
  'falseVerifiedTableCount',
  'inventedVisibleTextCount',
  'digestMismatchCount',
  'danglingReferenceCount',
  'unsafePathCount',
  'xmlFailureCount',
  'idFailureCount',
  'linkFailureCount',
  'manifestFailureCount',
  'spineFailureCount',
  'containerFailureCount',
  'metadataFailureCount',
  'accessibilityFailureCount',
  'boundsFailureCount',
  'xhtmlByteMismatchCount',
  'epubByteMismatchCount',
] as const

const MAXIMUM_COUNT = 1_000_000
const MINIMUM_REPORTING_POPULATION = 5
const SEMANTIC_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

const boundedCount = z.number().int().min(0).max(MAXIMUM_COUNT)
const positiveCount = boundedCount.min(1)
const boundedRate = z.number().min(0).max(1).multipleOf(0.000001)

const zeroToleranceSchema = z
  .object({
    privacySanitizerFailureCount: boundedCount,
    falseLinkCount: boundedCount,
    falseVerifiedTableCount: boundedCount,
    inventedVisibleTextCount: boundedCount,
    digestMismatchCount: boundedCount,
    danglingReferenceCount: boundedCount,
    unsafePathCount: boundedCount,
    xmlFailureCount: boundedCount,
    idFailureCount: boundedCount,
    linkFailureCount: boundedCount,
    manifestFailureCount: boundedCount,
    spineFailureCount: boundedCount,
    containerFailureCount: boundedCount,
    metadataFailureCount: boundedCount,
    accessibilityFailureCount: boundedCount,
    boundsFailureCount: boundedCount,
    xhtmlByteMismatchCount: boundedCount,
    epubByteMismatchCount: boundedCount,
  })
  .strict()

const observationSchema = z
  .object({
    outcome: z.enum(PRIVATE_PDF_EPUB_OUTCOMES),
    categories: z.array(z.enum(PRIVATE_PDF_EPUB_CATEGORIES)).max(14),
    neutralObligations: positiveCount,
    conservedNeutralObligations: boundedCount,
    publicationEligible: z.boolean(),
    publicationReady: z.boolean(),
    ambiguityEligible: z.boolean(),
    ambiguitySafe: z.boolean(),
    semanticEligible: z.boolean(),
    renderedSemantically: z.boolean(),
    zeroTolerance: zeroToleranceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.conservedNeutralObligations > value.neutralObligations)
      context.addIssue({
        code: 'custom',
        message: 'CONSERVATION_COUNT',
      })
    if (new Set(value.categories).size !== value.categories.length)
      context.addIssue({ code: 'custom', message: 'CATEGORY_DUPLICATE' })
  })

export type PrivatePdfEpubObservation = z.infer<typeof observationSchema>

export class PrivatePdfEpubSanitizerError extends TypeError {
  public readonly code = 'PRIVATE_PDF_EPUB_SANITIZER_REJECTED' as const

  constructor() {
    super('Private PDF EPUB aggregate input was rejected.')
    this.name = 'PrivatePdfEpubSanitizerError'
  }
}

function parseSanitized<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new PrivatePdfEpubSanitizerError()
  return result.data
}

export function createPrivatePdfEpubObservation(
  input: unknown,
): PrivatePdfEpubObservation {
  return parseSanitized(observationSchema, input)
}

function emptyZeroTolerance() {
  return Object.fromEntries(
    PRIVATE_PDF_EPUB_ZERO_TOLERANCE_KEYS.map((key) => [key, 0]),
  ) as Record<(typeof PRIVATE_PDF_EPUB_ZERO_TOLERANCE_KEYS)[number], number>
}

export function createPrivatePdfEpubSuccessObservation(
  result: PrivatePdfEpubExport,
) {
  return createPrivatePdfEpubObservation({
    outcome: 'rendered-ready',
    categories: [...result.categories],
    neutralObligations: Math.max(1, result.conservation.neutralObligations),
    conservedNeutralObligations:
      result.conservation.neutralObligations === 0
        ? 1
        : result.conservation.conservedNeutralObligations,
    publicationEligible: true,
    publicationReady: true,
    ambiguityEligible: true,
    ambiguitySafe: true,
    semanticEligible: true,
    renderedSemantically: true,
    zeroTolerance: emptyZeroTolerance(),
  })
}

export function createPrivatePdfEpubFailureObservation(error: unknown) {
  const safe = safePrivatePdfEpubError(error)
  const zeroTolerance = emptyZeroTolerance()
  if (safe.code === 'NONDETERMINISTIC_OUTPUT') {
    zeroTolerance.xhtmlByteMismatchCount = 1
    zeroTolerance.epubByteMismatchCount = 1
  }
  if (safe.code === 'EPUB_CONFORMANCE_FAILED')
    zeroTolerance.manifestFailureCount = 1

  const categories: PrivatePdfEpubCategory[] = []
  if (
    safe.code === 'INVALID_PDF' ||
    safe.code === 'MALFORMED_PDF' ||
    safe.code === 'ENCRYPTED_PDF' ||
    safe.code === 'UNSAFE_PDF'
  )
    categories.push('malformed')
  if (safe.code === 'OVERSIZED_PDF') categories.push('bounds')
  if (safe.code === 'REVIEW_REQUIRED') categories.push('ambiguity')

  const expectedRefusal =
    safe.code === 'OCR_REQUIRED' || safe.code === 'REVIEW_REQUIRED'
  const invalidBridge =
    safe.code === 'INVALID_PDF' ||
    safe.code === 'MALFORMED_PDF' ||
    safe.code === 'ENCRYPTED_PDF' ||
    safe.code === 'UNSAFE_PDF' ||
    safe.code === 'OVERSIZED_PDF' ||
    safe.code === 'STRUCT_ARTIFACT_MISMATCH' ||
    safe.code === 'INVALID_BRIDGE_DOCUMENT' ||
    safe.code === 'IMPORT_CANCELLED'
  const rendererRefusal = safe.code === 'STRUCT_RENDERER_REFUSED'

  return createPrivatePdfEpubObservation({
    outcome: expectedRefusal
      ? 'expected-review-refusal'
      : invalidBridge
        ? 'invalid-bridge-document'
        : rendererRefusal
          ? 'unexpected-renderer-refusal'
          : 'conformance-failure',
    categories,
    neutralObligations: 1,
    conservedNeutralObligations: 1,
    publicationEligible: true,
    publicationReady: false,
    ambiguityEligible: true,
    ambiguitySafe: expectedRefusal,
    semanticEligible: true,
    renderedSemantically: false,
    zeroTolerance,
  })
}

const semanticVersionSchema = z.string().min(5).max(64).regex(SEMANTIC_VERSION)
const versionsSchema = z
  .object({
    protocolVersion: semanticVersionSchema,
    fixtureVersion: semanticVersionSchema,
    rendererVersion: semanticVersionSchema,
    profileVersion: semanticVersionSchema,
    bridgeVersion: semanticVersionSchema,
    cohortVersion: semanticVersionSchema,
  })
  .strict()

const outcomesSchema = z
  .object({
    'rendered-ready': boundedCount,
    'source-preserved-ready': boundedCount,
    'expected-review-refusal': boundedCount,
    'invalid-bridge-document': boundedCount,
    'unexpected-renderer-refusal': boundedCount,
    'conformance-failure': boundedCount,
  })
  .strict()

const countsSchema = z
  .object({
    assigned: positiveCount,
    completed: boundedCount,
    neutralObligations: positiveCount,
    conservedNeutralObligations: boundedCount,
    publicationEligible: positiveCount,
    publicationReady: boundedCount,
    ambiguityEligible: positiveCount,
    ambiguitySafe: boundedCount,
    semanticEligible: positiveCount,
    renderedSemantically: boundedCount,
  })
  .strict()

const ratesSchema = z
  .object({
    assignedCompletion: boundedRate,
    neutralConservation: boundedRate,
    publicationReady: boundedRate,
    ambiguitySafety: boundedRate,
    semanticCoverage: boundedRate,
  })
  .strict()

const reportedCategorySchema = z
  .object({
    status: z.literal('reported'),
    numerator: boundedCount,
    denominator: boundedCount.min(MINIMUM_REPORTING_POPULATION),
    rate: boundedRate,
  })
  .strict()
const suppressedCategorySchema = z
  .object({ status: z.literal('suppressed') })
  .strict()
const categorySchema = z.union([
  reportedCategorySchema,
  suppressedCategorySchema,
])
const categoriesSchema = z
  .object({
    paragraph: categorySchema,
    hierarchy: categorySchema,
    tables: categorySchema,
    figures: categorySchema,
    citations: categorySchema,
    notes: categorySchema,
    multicolumn: categorySchema,
    rtl: categorySchema,
    navigation: categorySchema,
    assets: categorySchema,
    metadata: categorySchema,
    malformed: categorySchema,
    bounds: categorySchema,
    ambiguity: categorySchema,
  })
  .strict()

const aggregateSchema = z
  .object({
    schemaVersion: z.literal('2.0.0'),
    versions: versionsSchema,
    publicArtifact: z
      .object({
        packageName: z.literal('@erniesg/struct'),
        packageVersion: semanticVersionSchema,
        gitCommit: z.string().regex(/^[0-9a-f]{40}$/u),
        packedArtifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict(),
    evaluation: z.object({ gate: z.literal('development') }).strict(),
    outcomes: outcomesSchema,
    counts: countsSchema,
    rates: ratesSchema,
    zeroTolerance: zeroToleranceSchema,
    categories: categoriesSchema,
  })
  .strict()
  .superRefine((report, context) => {
    const outcomeTotal = Object.values(report.outcomes).reduce(
      (sum, count) => sum + count,
      0,
    )
    const exactRates = {
      assignedCompletion: rate(report.counts.completed, report.counts.assigned),
      neutralConservation: rate(
        report.counts.conservedNeutralObligations,
        report.counts.neutralObligations,
      ),
      publicationReady: rate(
        report.counts.publicationReady,
        report.counts.publicationEligible,
      ),
      ambiguitySafety: rate(
        report.counts.ambiguitySafe,
        report.counts.ambiguityEligible,
      ),
      semanticCoverage: rate(
        report.counts.renderedSemantically,
        report.counts.semanticEligible,
      ),
    }
    if (
      outcomeTotal !== report.counts.assigned ||
      report.counts.completed !== report.counts.assigned ||
      Object.entries(exactRates).some(
        ([key, value]) =>
          report.rates[key as keyof typeof report.rates] !== value,
      )
    )
      context.addIssue({ code: 'custom', message: 'AGGREGATE_COUNTER_BINDING' })

    for (const category of Object.values(report.categories))
      if (
        category.status === 'reported' &&
        (category.numerator > category.denominator ||
          category.rate !== rate(category.numerator, category.denominator))
      )
        context.addIssue({
          code: 'custom',
          message: 'CATEGORY_COUNTER_BINDING',
        })
  })

export type PrivatePdfEpubAggregate = z.infer<typeof aggregateSchema>

function rate(numerator: number, denominator: number) {
  return Math.round((numerator / denominator) * 1_000_000) / 1_000_000
}

function checkedSum(values: readonly number[]) {
  const sum = values.reduce((total, value) => total + value, 0)
  if (!Number.isSafeInteger(sum) || sum > MAXIMUM_COUNT)
    throw new PrivatePdfEpubSanitizerError()
  return sum
}

export function validatePrivatePdfEpubAggregate(
  input: unknown,
): PrivatePdfEpubAggregate {
  return parseSanitized(aggregateSchema, input)
}

export function buildPrivatePdfEpubAggregate(
  input: unknown,
  options: { cohortVersion?: string } = {},
): PrivatePdfEpubAggregate {
  const observations = parseSanitized(
    z.array(observationSchema).min(1).max(MAXIMUM_COUNT),
    input,
  )
  const versions = parseSanitized(versionsSchema, {
    protocolVersion: '2.0.0',
    fixtureVersion: '2.0.0',
    rendererVersion: PRIVATE_PDF_EPUB_STRUCT_ARTIFACT.packageVersion,
    profileVersion: '1.0.0',
    bridgeVersion: '1.0.0',
    cohortVersion: options.cohortVersion ?? '1.0.0',
  })

  const outcomes = Object.fromEntries(
    PRIVATE_PDF_EPUB_OUTCOMES.map((outcome) => [
      outcome,
      observations.filter((observation) => observation.outcome === outcome)
        .length,
    ]),
  ) as z.infer<typeof outcomesSchema>
  const counts = {
    assigned: observations.length,
    completed: observations.length,
    neutralObligations: checkedSum(
      observations.map((value) => value.neutralObligations),
    ),
    conservedNeutralObligations: checkedSum(
      observations.map((value) => value.conservedNeutralObligations),
    ),
    publicationEligible: observations.filter(
      (value) => value.publicationEligible,
    ).length,
    publicationReady: observations.filter((value) => value.publicationReady)
      .length,
    ambiguityEligible: observations.filter((value) => value.ambiguityEligible)
      .length,
    ambiguitySafe: observations.filter((value) => value.ambiguitySafe).length,
    semanticEligible: observations.filter((value) => value.semanticEligible)
      .length,
    renderedSemantically: observations.filter(
      (value) => value.renderedSemantically,
    ).length,
  }
  if (
    counts.publicationEligible < 1 ||
    counts.ambiguityEligible < 1 ||
    counts.semanticEligible < 1
  )
    throw new PrivatePdfEpubSanitizerError()

  const rates = {
    assignedCompletion: rate(counts.completed, counts.assigned),
    neutralConservation: rate(
      counts.conservedNeutralObligations,
      counts.neutralObligations,
    ),
    publicationReady: rate(counts.publicationReady, counts.publicationEligible),
    ambiguitySafety: rate(counts.ambiguitySafe, counts.ambiguityEligible),
    semanticCoverage: rate(
      counts.renderedSemantically,
      counts.semanticEligible,
    ),
  }
  const zeroTolerance = Object.fromEntries(
    PRIVATE_PDF_EPUB_ZERO_TOLERANCE_KEYS.map((key) => [
      key,
      checkedSum(observations.map((value) => value.zeroTolerance[key])),
    ]),
  ) as z.infer<typeof zeroToleranceSchema>
  const categories = Object.fromEntries(
    PRIVATE_PDF_EPUB_CATEGORIES.map((category) => {
      const eligible = observations.filter((value) =>
        value.categories.includes(category),
      )
      if (eligible.length < MINIMUM_REPORTING_POPULATION)
        return [category, { status: 'suppressed' }]
      const numerator = eligible.filter(
        (value) => value.publicationReady,
      ).length
      return [
        category,
        {
          status: 'reported',
          numerator,
          denominator: eligible.length,
          rate: rate(numerator, eligible.length),
        },
      ]
    }),
  ) as z.infer<typeof categoriesSchema>

  return validatePrivatePdfEpubAggregate({
    schemaVersion: '2.0.0',
    versions,
    publicArtifact: PRIVATE_PDF_EPUB_STRUCT_ARTIFACT,
    evaluation: { gate: 'development' },
    outcomes,
    counts,
    rates,
    zeroTolerance,
    categories,
  })
}

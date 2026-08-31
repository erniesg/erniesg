import { z } from 'zod'
import {
  PRIVATE_PDF_EPUB_CATEGORIES,
  PRIVATE_PDF_EPUB_ERROR_CODES,
  PRIVATE_PDF_EPUB_STRUCT_ARTIFACT,
  safePrivatePdfEpubError,
  type PrivatePdfEpubErrorCode,
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

export const PRIVATE_PDF_EPUB_TRANSACTION_OUTCOMES = [
  ...PRIVATE_PDF_EPUB_OUTCOMES,
  'internal-failure',
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
const MAXIMUM_PILOT_POPULATION = 5
const MINIMUM_REPORTING_POPULATION = 5
const SEMANTIC_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

const boundedCount = z.number().int().min(0).max(MAXIMUM_COUNT)
const positiveCount = boundedCount.min(1)
const boundedRate = z.number().min(0).max(1).multipleOf(0.000001)
const eligibilitySchema = z.enum(['eligible', 'not-eligible', 'unavailable'])

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

const checkedAssertionSchema = z
  .object({
    status: z.literal('checked'),
    failureCount: boundedCount,
  })
  .strict()
const notApplicableAssertionSchema = z
  .object({ status: z.literal('not-applicable') })
  .strict()
const notObservedAssertionSchema = z
  .object({ status: z.literal('not-observed') })
  .strict()
const transactionAssertionSchema = z.discriminatedUnion('status', [
  checkedAssertionSchema,
  notApplicableAssertionSchema,
  notObservedAssertionSchema,
])
const transactionAssertionsSchema = z
  .object({
    privacySanitizerFailureCount: transactionAssertionSchema,
    falseLinkCount: transactionAssertionSchema,
    falseVerifiedTableCount: transactionAssertionSchema,
    inventedVisibleTextCount: transactionAssertionSchema,
    digestMismatchCount: transactionAssertionSchema,
    danglingReferenceCount: transactionAssertionSchema,
    unsafePathCount: transactionAssertionSchema,
    xmlFailureCount: transactionAssertionSchema,
    idFailureCount: transactionAssertionSchema,
    linkFailureCount: transactionAssertionSchema,
    manifestFailureCount: transactionAssertionSchema,
    spineFailureCount: transactionAssertionSchema,
    containerFailureCount: transactionAssertionSchema,
    metadataFailureCount: transactionAssertionSchema,
    accessibilityFailureCount: transactionAssertionSchema,
    boundsFailureCount: transactionAssertionSchema,
    xhtmlByteMismatchCount: transactionAssertionSchema,
    epubByteMismatchCount: transactionAssertionSchema,
  })
  .strict()

const categoryEligibilitySchema = z
  .object({
    paragraph: eligibilitySchema,
    hierarchy: eligibilitySchema,
    tables: eligibilitySchema,
    figures: eligibilitySchema,
    citations: eligibilitySchema,
    notes: eligibilitySchema,
    multicolumn: eligibilitySchema,
    rtl: eligibilitySchema,
    navigation: eligibilitySchema,
    assets: eligibilitySchema,
    metadata: eligibilitySchema,
    malformed: eligibilitySchema,
    bounds: eligibilitySchema,
    ambiguity: eligibilitySchema,
  })
  .strict()

const assignmentSchema = z
  .object({
    categoryEligibility: categoryEligibilitySchema,
    publicationEligibility: eligibilitySchema,
    ambiguityEligibility: eligibilitySchema,
    semanticEligibility: eligibilitySchema,
  })
  .strict()

const measuredSourceToStructSchema = z
  .object({
    status: z.literal('measured'),
    neutralObligations: boundedCount,
    conservedNeutralObligations: boundedCount,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.conservedNeutralObligations > value.neutralObligations)
      context.addIssue({ code: 'custom', message: 'CONSERVATION_COUNT' })
  })

const sourceToStructSchema = z.union([
  measuredSourceToStructSchema,
  z.object({ status: z.literal('review-refusal') }).strict(),
  z.object({ status: z.literal('not-reached') }).strict(),
  z.object({ status: z.literal('not-observed') }).strict(),
])

const terminalCodeSchema = z.enum(['READY', ...PRIVATE_PDF_EPUB_ERROR_CODES])

const observationSchema = z
  .object({
    terminalCode: terminalCodeSchema,
    outcome: z.enum(PRIVATE_PDF_EPUB_TRANSACTION_OUTCOMES),
    assignment: assignmentSchema,
    sourceToStruct: sourceToStructSchema,
    ambiguityDisposition: z.enum([
      'safe',
      'not-demonstrated',
      'not-applicable',
      'unavailable',
    ]),
    semanticDisposition: z.enum([
      'rendered',
      'source-preserved',
      'not-rendered',
      'not-applicable',
      'unavailable',
    ]),
    zeroTolerance: transactionAssertionsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: 'custom', message })
    const expectedOutcome = privatePdfEpubOutcomeForTerminalCode(
      value.terminalCode,
    )
    if (
      expectedOutcome !== value.outcome &&
      !(
        value.terminalCode === 'READY' &&
        value.outcome === 'source-preserved-ready'
      )
    )
      issue('TERMINAL_OUTCOME_BINDING')
    if (
      value.assignment.categoryEligibility.ambiguity !==
      value.assignment.ambiguityEligibility
    )
      issue('AMBIGUITY_CATEGORY_BINDING')

    const ready =
      value.outcome === 'rendered-ready' ||
      value.outcome === 'source-preserved-ready'
    if (ready && value.assignment.publicationEligibility === 'not-eligible')
      issue('PUBLICATION_ELIGIBILITY')

    if (
      value.assignment.ambiguityEligibility === 'eligible' &&
      (value.ambiguityDisposition === 'not-applicable' ||
        value.ambiguityDisposition === 'unavailable')
    )
      issue('AMBIGUITY_DISPOSITION')
    if (
      value.assignment.ambiguityEligibility === 'not-eligible' &&
      value.ambiguityDisposition !== 'not-applicable'
    )
      issue('AMBIGUITY_DISPOSITION')
    if (
      value.assignment.ambiguityEligibility === 'unavailable' &&
      value.ambiguityDisposition !== 'unavailable'
    )
      issue('AMBIGUITY_DISPOSITION')

    if (
      value.assignment.semanticEligibility === 'eligible' &&
      (value.semanticDisposition === 'not-applicable' ||
        value.semanticDisposition === 'unavailable')
    )
      issue('SEMANTIC_DISPOSITION')
    if (
      value.assignment.semanticEligibility === 'not-eligible' &&
      value.semanticDisposition !== 'not-applicable'
    )
      issue('SEMANTIC_DISPOSITION')
    const assertionValues = Object.values(value.zeroTolerance)
    const allAssertionsHaveStatus = (
      status: z.infer<typeof transactionAssertionSchema>['status'],
    ) => assertionValues.every((assertion) => assertion.status === status)
    const observedFailureCount = assertionValues.reduce(
      (sum, assertion) =>
        sum + (assertion.status === 'checked' ? assertion.failureCount : 0),
      0,
    )
    const hasUnobservedAssertion = assertionValues.some(
      (assertion) => assertion.status === 'not-observed',
    )
    if (
      value.outcome === 'conformance-failure' &&
      observedFailureCount === 0 &&
      !hasUnobservedAssertion
    )
      issue('CONFORMANCE_ASSERTION_REQUIRED')
    if (value.outcome !== 'conformance-failure' && observedFailureCount > 0)
      issue('CONFORMANCE_OUTCOME_REQUIRED')
    if (value.terminalCode === 'NONDETERMINISTIC_OUTPUT') {
      const mismatchFailures = [
        value.zeroTolerance.xhtmlByteMismatchCount,
        value.zeroTolerance.epubByteMismatchCount,
      ].reduce(
        (sum, assertion) =>
          sum + (assertion.status === 'checked' ? assertion.failureCount : 0),
        0,
      )
      if (mismatchFailures < 1 || observedFailureCount !== mismatchFailures)
        issue('REPRODUCIBILITY_ASSERTION_BINDING')
    }
    if (
      value.terminalCode === 'EPUB_CONFORMANCE_FAILED' &&
      (assertionFailureCount(value.zeroTolerance.xhtmlByteMismatchCount) > 0 ||
        assertionFailureCount(value.zeroTolerance.epubByteMismatchCount) > 0)
    )
      issue('EPUB_ASSERTION_BINDING')

    switch (value.outcome) {
      case 'rendered-ready':
        if (
          value.sourceToStruct.status !== 'measured' ||
          value.semanticDisposition !== 'rendered' ||
          value.ambiguityDisposition === 'not-demonstrated' ||
          observedFailureCount > 0 ||
          !allAssertionsHaveStatus('checked')
        )
          issue('RENDERED_READY_BINDING')
        break
      case 'source-preserved-ready':
        if (
          value.sourceToStruct.status !== 'measured' ||
          value.semanticDisposition !== 'source-preserved' ||
          value.ambiguityDisposition === 'not-demonstrated' ||
          observedFailureCount > 0 ||
          !allAssertionsHaveStatus('checked')
        )
          issue('SOURCE_PRESERVED_BINDING')
        break
      case 'expected-review-refusal':
        if (
          !['measured', 'review-refusal'].includes(
            value.sourceToStruct.status,
          ) ||
          (value.assignment.ambiguityEligibility === 'eligible' &&
            value.ambiguityDisposition !== 'safe') ||
          !allAssertionsHaveStatus('not-applicable')
        )
          issue('REVIEW_REFUSAL_BINDING')
        break
      case 'invalid-bridge-document':
        if (
          value.sourceToStruct.status !== 'not-reached' ||
          !allAssertionsHaveStatus('not-applicable')
        )
          issue('INVALID_BRIDGE_BINDING')
        break
      case 'unexpected-renderer-refusal':
        if (
          value.sourceToStruct.status !== 'measured' ||
          !allAssertionsHaveStatus('not-applicable')
        )
          issue('RENDERER_REFUSAL_BINDING')
        break
      case 'conformance-failure':
        if (
          value.sourceToStruct.status !== 'measured' ||
          assertionValues.some(
            (assertion) => assertion.status === 'not-applicable',
          ) ||
          value.zeroTolerance.xhtmlByteMismatchCount.status !== 'checked' ||
          value.zeroTolerance.epubByteMismatchCount.status !== 'checked'
        )
          issue('STRUCT_STAGE_BINDING')
        break
      case 'internal-failure':
        if (
          value.sourceToStruct.status !== 'not-observed' ||
          observedFailureCount > 0 ||
          !allAssertionsHaveStatus('not-observed')
        )
          issue('INTERNAL_FAILURE_BINDING')
        break
    }
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export function privatePdfEpubOutcomeForTerminalCode(
  terminalCode: 'READY' | PrivatePdfEpubErrorCode,
): (typeof PRIVATE_PDF_EPUB_TRANSACTION_OUTCOMES)[number] {
  if (terminalCode === 'READY') return 'rendered-ready'
  if (terminalCode === 'OCR_REQUIRED' || terminalCode === 'REVIEW_REQUIRED')
    return 'expected-review-refusal'
  if (terminalCode === 'STRUCT_RENDERER_REFUSED')
    return 'unexpected-renderer-refusal'
  if (
    terminalCode === 'EPUB_CONFORMANCE_FAILED' ||
    terminalCode === 'NONDETERMINISTIC_OUTPUT'
  )
    return 'conformance-failure'
  if (terminalCode === 'INTERNAL_FAILURE') return 'internal-failure'
  return 'invalid-bridge-document'
}

export function createPrivatePdfEpubObservation(
  input: unknown,
): PrivatePdfEpubObservation {
  return deepFreeze(parseSanitized(observationSchema, input))
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

const publicArtifactSchema = z
  .object({
    packageName: z.literal('@erniesg/struct'),
    packageVersion: semanticVersionSchema,
    gitCommit: z.string().regex(/^[0-9a-f]{40}$/u),
    packedArtifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
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
    publicArtifact: publicArtifactSchema,
    evaluation: z.object({ gate: z.literal('development') }).strict(),
    outcomes: outcomesSchema,
    counts: countsSchema,
    rates: ratesSchema,
    zeroTolerance: zeroToleranceSchema,
    categories: categoriesSchema,
  })
  .strict()
  .superRefine((report, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: 'custom', message })
    const outcomeTotal = Object.values(report.outcomes).reduce(
      (sum, count) => sum + count,
      0,
    )
    const zeroToleranceFailureTotal = Object.values(
      report.zeroTolerance,
    ).reduce((sum, count) => sum + count, 0)
    const conformanceFailureCount = report.outcomes['conformance-failure']
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
      report.outcomes['rendered-ready'] +
        report.outcomes['source-preserved-ready'] !==
        report.counts.publicationReady ||
      report.counts.conservedNeutralObligations >
        report.counts.neutralObligations ||
      report.counts.publicationReady > report.counts.publicationEligible ||
      report.counts.ambiguitySafe > report.counts.ambiguityEligible ||
      report.counts.renderedSemantically > report.counts.semanticEligible ||
      report.counts.publicationEligible > report.counts.assigned ||
      report.counts.ambiguityEligible > report.counts.assigned ||
      report.counts.semanticEligible > report.counts.assigned ||
      (zeroToleranceFailureTotal === 0) !== (conformanceFailureCount === 0) ||
      zeroToleranceFailureTotal < conformanceFailureCount ||
      Object.entries(exactRates).some(
        ([key, value]) =>
          report.rates[key as keyof typeof report.rates] !== value,
      )
    )
      issue('AGGREGATE_COUNTER_BINDING')

    for (const category of Object.values(report.categories))
      if (
        category.status === 'reported' &&
        (category.numerator > category.denominator ||
          category.denominator > report.counts.assigned ||
          category.numerator > report.counts.publicationReady ||
          category.rate !== rate(category.numerator, category.denominator))
      )
        issue('CATEGORY_COUNTER_BINDING')
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

function assertionFailureCount(
  assertion: z.infer<typeof transactionAssertionSchema>,
) {
  return assertion.status === 'checked' ? assertion.failureCount : 0
}

function transactionEvidenceIsComplete(
  observations: readonly PrivatePdfEpubObservation[],
) {
  return observations.every((observation) => {
    const assignment = observation.assignment
    return (
      observation.outcome !== 'internal-failure' &&
      assignment.publicationEligibility !== 'unavailable' &&
      assignment.ambiguityEligibility !== 'unavailable' &&
      assignment.semanticEligibility !== 'unavailable' &&
      Object.values(assignment.categoryEligibility).every(
        (eligibility) => eligibility !== 'unavailable',
      ) &&
      observation.sourceToStruct.status !== 'not-observed' &&
      observation.ambiguityDisposition !== 'unavailable' &&
      observation.semanticDisposition !== 'unavailable' &&
      Object.values(observation.zeroTolerance).every(
        (assertion) => assertion.status === 'checked',
      )
    )
  })
}

export function validatePrivatePdfEpubAggregate(
  input: unknown,
): PrivatePdfEpubAggregate {
  return deepFreeze(parseSanitized(aggregateSchema, input))
}

export function buildPrivatePdfEpubAggregate(
  input: unknown,
  options: { cohortVersion?: string } = {},
): PrivatePdfEpubAggregate {
  const observations = parseSanitized(
    z.array(observationSchema).min(1).max(MAXIMUM_COUNT),
    input,
  )
  if (!transactionEvidenceIsComplete(observations))
    throw new PrivatePdfEpubSanitizerError()

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
  const measured = observations.filter(
    (observation) => observation.sourceToStruct.status === 'measured',
  ) as Array<
    PrivatePdfEpubObservation & {
      sourceToStruct: z.infer<typeof measuredSourceToStructSchema>
    }
  >
  const counts = {
    assigned: observations.length,
    completed: observations.length,
    neutralObligations: checkedSum(
      measured.map((value) => value.sourceToStruct.neutralObligations),
    ),
    conservedNeutralObligations: checkedSum(
      measured.map((value) => value.sourceToStruct.conservedNeutralObligations),
    ),
    publicationEligible: observations.filter(
      (value) => value.assignment.publicationEligibility === 'eligible',
    ).length,
    publicationReady: observations.filter(
      (value) =>
        value.outcome === 'rendered-ready' ||
        value.outcome === 'source-preserved-ready',
    ).length,
    ambiguityEligible: observations.filter(
      (value) => value.assignment.ambiguityEligibility === 'eligible',
    ).length,
    ambiguitySafe: observations.filter(
      (value) =>
        value.assignment.ambiguityEligibility === 'eligible' &&
        value.ambiguityDisposition === 'safe',
    ).length,
    semanticEligible: observations.filter(
      (value) => value.assignment.semanticEligibility === 'eligible',
    ).length,
    renderedSemantically: observations.filter(
      (value) =>
        value.assignment.semanticEligibility === 'eligible' &&
        value.semanticDisposition === 'rendered',
    ).length,
  }
  if (
    counts.neutralObligations < 1 ||
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
      checkedSum(
        observations.map((value) =>
          assertionFailureCount(value.zeroTolerance[key]),
        ),
      ),
    ]),
  ) as z.infer<typeof zeroToleranceSchema>
  const categories = Object.fromEntries(
    PRIVATE_PDF_EPUB_CATEGORIES.map((category) => {
      const eligible = observations.filter(
        (value) =>
          value.assignment.categoryEligibility[category] === 'eligible',
      )
      if (eligible.length < MINIMUM_REPORTING_POPULATION)
        return [category, { status: 'suppressed' }]
      const numerator = eligible.filter(
        (value) =>
          value.outcome === 'rendered-ready' ||
          value.outcome === 'source-preserved-ready',
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

const failureClassesShape = Object.fromEntries(
  PRIVATE_PDF_EPUB_ERROR_CODES.map((code) => [code, boundedCount]),
) as Record<PrivatePdfEpubErrorCode, typeof boundedCount>
const failureClassesSchema = z.object(failureClassesShape).strict()
const unavailableAggregateSchema = z
  .object({
    status: z.literal('unavailable'),
    reason: z.enum([
      'incomplete-transaction-evidence',
      'protocol-denominator-unavailable',
    ]),
  })
  .strict()
const availableAggregateSchema = z
  .object({ status: z.literal('available'), report: aggregateSchema })
  .strict()
const pilotReceiptSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    publicArtifact: publicArtifactSchema,
    evaluation: z.object({ gate: z.literal('development') }).strict(),
    pilot: z
      .object({
        maximumAllowed: z.literal(MAXIMUM_PILOT_POPULATION),
        assigned: positiveCount.max(MAXIMUM_PILOT_POPULATION),
        completed: positiveCount.max(MAXIMUM_PILOT_POPULATION),
        holdoutRetained: positiveCount,
        disjointHoldout: z.literal(true),
        structArtifactVerified: z.literal(true),
        durableUploadCount: z.literal(0),
        persistedEpubCount: z.literal(0),
      })
      .strict(),
    failureClasses: failureClassesSchema,
    categories: categoriesSchema,
    publicAggregate: z.discriminatedUnion('status', [
      availableAggregateSchema,
      unavailableAggregateSchema,
    ]),
  })
  .strict()
  .superRefine((receipt, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: 'custom', message })
    const failures = Object.values(receipt.failureClasses).reduce(
      (sum, count) => sum + count,
      0,
    )
    const ready =
      receipt.publicAggregate.status === 'available'
        ? receipt.publicAggregate.report.outcomes['rendered-ready'] +
          receipt.publicAggregate.report.outcomes['source-preserved-ready']
        : receipt.pilot.completed - failures
    if (
      receipt.pilot.assigned !== receipt.pilot.completed ||
      failures > receipt.pilot.completed ||
      ready + failures !== receipt.pilot.completed
    )
      issue('PILOT_COUNTER_BINDING')
    for (const category of Object.values(receipt.categories))
      if (
        category.status === 'reported' &&
        (category.numerator > category.denominator ||
          category.denominator > receipt.pilot.assigned ||
          category.numerator > ready ||
          category.rate !== rate(category.numerator, category.denominator))
      )
        issue('PILOT_CATEGORY_BINDING')

    if (receipt.publicAggregate.status !== 'available') return
    const report = receipt.publicAggregate.report
    if (
      !closedValuesEqual(receipt.publicArtifact, report.publicArtifact) ||
      !closedValuesEqual(receipt.evaluation, report.evaluation) ||
      !closedValuesEqual(receipt.categories, report.categories) ||
      receipt.pilot.assigned !== report.counts.assigned ||
      receipt.pilot.completed !== report.counts.completed
    )
      issue('PILOT_AGGREGATE_BINDING')

    const groupedFailures: Record<
      Exclude<
        (typeof PRIVATE_PDF_EPUB_OUTCOMES)[number],
        'rendered-ready' | 'source-preserved-ready'
      >,
      number
    > = {
      'expected-review-refusal': 0,
      'invalid-bridge-document': 0,
      'unexpected-renderer-refusal': 0,
      'conformance-failure': 0,
    }
    for (const code of PRIVATE_PDF_EPUB_ERROR_CODES) {
      const outcome = privatePdfEpubOutcomeForTerminalCode(code)
      if (outcome === 'internal-failure') {
        if (receipt.failureClasses[code] !== 0)
          issue('PILOT_FAILURE_CLASS_BINDING')
        continue
      }
      if (
        outcome === 'rendered-ready' ||
        outcome === 'source-preserved-ready'
      ) {
        issue('PILOT_FAILURE_CLASS_BINDING')
        continue
      }
      groupedFailures[outcome] += receipt.failureClasses[code]
    }
    for (const [outcome, count] of Object.entries(groupedFailures))
      if (report.outcomes[outcome as keyof typeof groupedFailures] !== count)
        issue('PILOT_FAILURE_CLASS_BINDING')
  })

export type PrivatePdfEpubPilotReceipt = z.infer<typeof pilotReceiptSchema>

function closedValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value, index) => closedValuesEqual(value, right[index]))
    )
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        closedValuesEqual(leftRecord[key], rightRecord[key]),
    )
  )
}

export function validatePrivatePdfEpubPilotReceipt(
  input: unknown,
): PrivatePdfEpubPilotReceipt {
  return deepFreeze(parseSanitized(pilotReceiptSchema, input))
}

function pilotCategories(observations: readonly PrivatePdfEpubObservation[]) {
  return Object.fromEntries(
    PRIVATE_PDF_EPUB_CATEGORIES.map((category) => {
      const eligibility = observations.map(
        (observation) => observation.assignment.categoryEligibility[category],
      )
      if (eligibility.includes('unavailable'))
        return [category, { status: 'suppressed' }]
      const eligible = observations.filter(
        (observation) =>
          observation.assignment.categoryEligibility[category] === 'eligible',
      )
      if (eligible.length < MINIMUM_REPORTING_POPULATION)
        return [category, { status: 'suppressed' }]
      const numerator = eligible.filter(
        (observation) =>
          observation.outcome === 'rendered-ready' ||
          observation.outcome === 'source-preserved-ready',
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
}

export function buildPrivatePdfEpubPilotReceipt(
  input: unknown,
  options: { holdoutRetained: number; cohortVersion?: string },
): PrivatePdfEpubPilotReceipt {
  const observations = parseSanitized(
    z.array(observationSchema).min(1).max(MAXIMUM_PILOT_POPULATION),
    input,
  )
  const holdoutRetained = parseSanitized(positiveCount, options.holdoutRetained)
  const failureClasses = Object.fromEntries(
    PRIVATE_PDF_EPUB_ERROR_CODES.map((code) => [
      code,
      observations.filter((observation) => observation.terminalCode === code)
        .length,
    ]),
  ) as z.infer<typeof failureClassesSchema>

  let publicAggregate:
    | z.infer<typeof availableAggregateSchema>
    | z.infer<typeof unavailableAggregateSchema>
  if (!transactionEvidenceIsComplete(observations)) {
    publicAggregate = {
      status: 'unavailable',
      reason: 'incomplete-transaction-evidence',
    }
  } else {
    try {
      publicAggregate = {
        status: 'available',
        report: buildPrivatePdfEpubAggregate(observations, {
          cohortVersion: options.cohortVersion,
        }),
      }
    } catch {
      publicAggregate = {
        status: 'unavailable',
        reason: 'protocol-denominator-unavailable',
      }
    }
  }

  return validatePrivatePdfEpubPilotReceipt({
    schemaVersion: '1.0.0',
    publicArtifact: PRIVATE_PDF_EPUB_STRUCT_ARTIFACT,
    evaluation: { gate: 'development' },
    pilot: {
      maximumAllowed: MAXIMUM_PILOT_POPULATION,
      assigned: observations.length,
      completed: observations.length,
      holdoutRetained,
      disjointHoldout: true,
      structArtifactVerified: true,
      durableUploadCount: 0,
      persistedEpubCount: 0,
    },
    failureClasses,
    categories: pilotCategories(observations),
    publicAggregate,
  })
}

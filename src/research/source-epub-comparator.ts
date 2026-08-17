import { z } from 'zod'
import {
  SOURCE_EPUB_COMPARATOR_SCHEMA_VERSION,
  SOURCE_EPUB_OBSERVATION_CHECK_IDS,
  compareComparisonFailures,
  epubBindingSchema,
  hashRenderedActualObservationSet,
  hashRenderedEpubEvidence,
  hashSourceEvidenceReceipt,
  hashSourceExpectedObservationSet,
  hashTraceValue,
  observationReceiptCoreSchema,
  observationReceiptSchema,
  renderedEpubSchema,
  sourceEvidenceReceiptSchema,
  sourceRegionObligationSchema,
  sourceOutputMappingSchema,
  structBindingSchema,
  type ComparisonFailure,
  type DeterministicCheckId,
  type DeterministicComparisonObservation,
  type EpubArtifactBinding,
  type RenderedEpubEvidence,
  type SourceEpubComparatorResult,
  type SourceLocation,
  type SourceOutputMapping,
  type SourceRegionObligation,
  type SourceEvidenceReceiptBinding,
  type StructArtifactBinding,
} from './reconstruction-attempt-trace'

export type {
  DeterministicComparisonObservation,
  SourceRegionObligation,
} from './reconstruction-attempt-trace'
export { SOURCE_EPUB_OBSERVATION_CHECK_IDS } from './reconstruction-attempt-trace'

const sha256ValueSchema = z.string().regex(/^[a-f0-9]{64}$/u)

const comparisonInputSchema = z
  .object({
    sourcePdfSha256: sha256ValueSchema,
    sourceEvidence: sourceEvidenceReceiptSchema,
    structure: structBindingSchema,
    epub: epubBindingSchema,
    renderedEpub: renderedEpubSchema,
    sourceRegions: z.array(sourceRegionObligationSchema).min(1),
    mappings: z.array(sourceOutputMappingSchema).min(1),
    observations: z
      .array(
        observationReceiptSchema.refine(
          ({ check }) =>
            SOURCE_EPUB_OBSERVATION_CHECK_IDS.includes(
              check as (typeof SOURCE_EPUB_OBSERVATION_CHECK_IDS)[number],
            ),
          'Unsupported source/EPUB observation check.',
        ),
      )
      .min(1),
  })
  .strict()
export type SourceEpubComparisonInput = {
  sourcePdfSha256: string
  sourceEvidence: SourceEvidenceReceiptBinding
  structure: StructArtifactBinding
  epub: EpubArtifactBinding
  renderedEpub: RenderedEpubEvidence
  sourceRegions: SourceRegionObligation[]
  mappings: SourceOutputMapping[]
  observations: DeterministicComparisonObservation[]
}

function compareCodeUnits(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function inputError(message: string): never {
  throw new TypeError(`Invalid source/EPUB comparison input: ${message}`)
}

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) {
    inputError(`${label} must contain unique ids`)
  }
}

function observationCore(
  input: Omit<DeterministicComparisonObservation, 'receiptSha256'>,
) {
  return input
}

export function createDeterministicObservationReceipt(
  input: Omit<DeterministicComparisonObservation, 'receiptSha256'>,
) {
  const core = observationReceiptCoreSchema.parse(input)
  return observationReceiptSchema.parse({
    ...core,
    receiptSha256: hashTraceValue(core),
  })
}

function sortedSourceObligations(input: SourceRegionObligation[]) {
  return [...input].sort((left, right) => compareCodeUnits(left.id, right.id))
}

function assertInput(input: SourceEpubComparisonInput) {
  if (
    input.sourceEvidence.sourcePdfSha256 !== input.sourcePdfSha256 ||
    input.sourceEvidence.receiptSha256 !==
      hashSourceEvidenceReceipt(input.sourceEvidence)
  ) {
    inputError('source-evidence receipt is stale or unrelated')
  }
  if (input.structure.sourcePdfSha256 !== input.sourcePdfSha256) {
    inputError('STRUCT is not bound to the source PDF')
  }
  if (input.epub.structSha256 !== input.structure.artifact.sha256) {
    inputError('EPUB is not bound to the exact STRUCT artifact')
  }
  if (
    input.renderedEpub.epubSha256 !== input.epub.bytes.sha256 ||
    hashTraceValue(input.renderedEpub.download.artifact) !==
      hashTraceValue(input.epub.bytes) ||
    input.renderedEpub.receiptSha256 !==
      hashRenderedEpubEvidence(input.renderedEpub)
  ) {
    inputError('renderer receipt is not bound to the downloaded EPUB bytes')
  }
  const obligationProjection = {
    sourcePdfSha256: input.sourcePdfSha256,
    obligationsSha256: hashTraceValue(sortedSourceObligations(input.sourceRegions)),
    obligationCount: input.sourceRegions.length,
  }
  if (
    input.sourceEvidence.sourceObligations.obligationsSha256 !==
      obligationProjection.obligationsSha256 ||
    input.sourceEvidence.sourceObligations.obligationCount !==
      obligationProjection.obligationCount ||
    input.sourceEvidence.sourceObligations.receiptSha256 !==
      hashTraceValue(obligationProjection) ||
    input.renderedEpub.sourceObligations.sourcePdfSha256 !==
      obligationProjection.sourcePdfSha256 ||
    input.renderedEpub.sourceObligations.obligationsSha256 !==
      obligationProjection.obligationsSha256 ||
    input.renderedEpub.sourceObligations.obligationCount !==
      obligationProjection.obligationCount ||
    input.renderedEpub.sourceObligations.receiptSha256 !==
      hashTraceValue(obligationProjection)
  ) {
    inputError('source-obligation receipt is stale or unrelated')
  }

  assertUnique(
    input.sourceRegions.map(({ id }) => id),
    'sourceRegions',
  )
  assertUnique(
    input.mappings.map(({ id }) => id),
    'mappings',
  )
  assertUnique(
    input.observations.map(({ idSha256 }) => idSha256),
    'observations',
  )
  assertUnique(
    input.observations.map(({ check }) => check),
    'observation categories',
  )
  assertUnique(
    input.sourceEvidence.expectedObservationSets.map(({ check }) => check),
    'expected observation categories',
  )
  assertUnique(
    input.renderedEpub.actualObservationSets.map(({ check }) => check),
    'actual observation categories',
  )

  const expectedSets = new Map(
    input.sourceEvidence.expectedObservationSets.map((set) => [set.check, set]),
  )
  const actualSets = new Map(
    input.renderedEpub.actualObservationSets.map((set) => [set.check, set]),
  )
  if (
    SOURCE_EPUB_OBSERVATION_CHECK_IDS.some(
      (check) =>
        !expectedSets.has(check) ||
        !actualSets.has(check) ||
        !input.observations.some((observation) => observation.check === check),
    )
  ) {
    inputError('every observation category requires one expected, actual, and selection receipt')
  }
  const sourceRegionIds = new Set(input.sourceRegions.map(({ id }) => id))
  for (const expected of input.sourceEvidence.expectedObservationSets) {
    if (
      expected.receiptSha256 !== hashSourceExpectedObservationSet(expected) ||
      expected.setSha256 !== expected.payload.sha256 ||
      new Set(expected.sourceRegionIds).size !== expected.sourceRegionIds.length ||
      expected.sourceRegionIds.some((id) => !sourceRegionIds.has(id)) ||
      (expected.sourceRegionIds.length > 0 && expected.itemCount === 0)
    ) {
      inputError(
        `expected ${expected.check} set is stale, ungrounded, or self-attests zero source-bearing items`,
      )
    }
  }
  for (const actual of input.renderedEpub.actualObservationSets) {
    if (
      actual.receiptSha256 !== hashRenderedActualObservationSet(actual) ||
      actual.setSha256 !== actual.payload.sha256
    ) {
      inputError(`actual ${actual.check} set receipt is stale`)
    }
  }

  for (const [index, region] of input.sourceRegions.entries()) {
    if (
      region.source.sourceRegionIds.length !== 1 ||
      region.source.sourceRegionIds[0] !== region.id ||
      !input.mappings.some(({ source }) =>
        source.sourceRegionIds.includes(region.id),
      )
    ) {
      inputError(`sourceRegions.${index} is not singly and explicitly mapped`)
    }
  }
  for (const [index, observation] of input.observations.entries()) {
    const { receiptSha256, ...core } = observation
    const expected = expectedSets.get(observation.check)
    const actual = actualSets.get(observation.check)
    if (
      receiptSha256 !== hashTraceValue(observationCore(core)) ||
      observation.expectedSetReceiptSha256 !== expected?.receiptSha256 ||
      observation.actualSetReceiptSha256 !== actual?.receiptSha256
    ) {
      inputError(
        `observations.${index} lacks source-derived or renderer-derived proof`,
      )
    }
  }
  const doms = new Map(
    input.renderedEpub.domSnapshots.map((snapshot) => [
      snapshot.spineHref,
      snapshot,
    ]),
  )
  const screenshots = new Map(
    input.renderedEpub.screenshots.map((screenshot) => [
      screenshot.id,
      screenshot,
    ]),
  )
  for (const [index, mapping] of input.mappings.entries()) {
    const cardinalityValid =
      (mapping.status === 'mapped' && mapping.output.length === 1) ||
      (mapping.status === 'missing' && mapping.output.length === 0) ||
      (mapping.status === 'duplicate' && mapping.output.length >= 2)
    if (!cardinalityValid) {
      inputError(`mappings.${index} has invalid status/output cardinality`)
    }
    if (mapping.output.some((output) => !output.rendered)) {
      inputError(`mappings.${index} is missing screenshot locator evidence`)
    }
    for (const [outputIndex, output] of mapping.output.entries()) {
      const dom = doms.get(output.spineHref)
      const rendered = output.rendered!
      const screenshot = screenshots.get(rendered.screenshotId)
      const { rect } = rendered
      if (!dom?.anchors.includes(output.anchorId)) {
        inputError(
          `mappings.${index}.output.${outputIndex} names a nonexistent anchor`,
        )
      }
      if (
        !screenshot ||
        screenshot.spineHref !== output.spineHref ||
        screenshot.domSha256 !== dom.dom.sha256 ||
        hashTraceValue(rendered.viewport) !== hashTraceValue(screenshot.viewport)
      ) {
        inputError(
          `mappings.${index}.output.${outputIndex} is not bound to its screenshot`,
        )
      }
      if (
        rect.x < 0 ||
        rect.y < 0 ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.x + rect.width > rendered.viewport.width ||
        rect.y + rect.height > rendered.viewport.height
      ) {
        inputError(
          `mappings.${index}.output.${outputIndex} has an empty or out-of-bounds locator`,
        )
      }
    }
  }
}

type PendingCheck = {
  id: string
  check: DeterministicCheckId
  passed: boolean
  expectedSha256: string
  actualSha256: string
  mappingIds: string[]
  source?: SourceLocation
  output: SourceOutputMapping['output']
  message: string
}

function outputForMappings(
  mappingIds: readonly string[],
  mappingsById: ReadonlyMap<string, SourceOutputMapping>,
) {
  return mappingIds.flatMap((id) => mappingsById.get(id)?.output ?? [])
}

function receiptCheck({
  id,
  check,
  expected,
  actual,
  mappingIds,
  source,
  output,
  message,
  evidenceValid = true,
}: Omit<PendingCheck, 'passed' | 'expectedSha256' | 'actualSha256'> & {
  expected: unknown
  actual: unknown
  evidenceValid?: boolean
}): PendingCheck {
  const expectedSha256 = hashTraceValue(expected)
  const actualSha256 = hashTraceValue(actual)
  return {
    id,
    check,
    passed: evidenceValid && expectedSha256 === actualSha256,
    expectedSha256,
    actualSha256,
    mappingIds,
    ...(source ? { source } : {}),
    output,
    message,
  }
}

function renderBindingCheck(input: SourceEpubComparisonInput): PendingCheck {
  const navigation = input.mappings[0]!
  return receiptCheck({
    id: 'render-binding',
    check: 'render-binding',
    expected: {
      epub: input.epub.bytes,
      sourcePdfSha256: input.sourcePdfSha256,
      sourceObligationCount: input.sourceRegions.length,
      invalidLocatorCount: 0,
    },
    actual: {
      epub: input.renderedEpub.download.artifact,
      sourcePdfSha256:
        input.renderedEpub.sourceObligations.sourcePdfSha256,
      sourceObligationCount:
        input.renderedEpub.sourceObligations.obligationCount,
      invalidLocatorCount: 0,
    },
    mappingIds: [navigation.id],
    source: navigation.source as SourceLocation,
    output: navigation.output,
    message:
      'Actual-render receipt must bind downloaded EPUB bytes, DOM anchors, screenshots, and source obligations.',
  })
}

function epubPackageCheck(input: SourceEpubComparisonInput): PendingCheck {
  const navigation = input.mappings[0]!
  return receiptCheck({
    id: 'epub-package',
    check: 'epub-package',
    expected: { status: 'passed', errorCount: 0, warningCount: 0 },
    actual: {
      status: input.epub.epubCheck.status,
      errorCount: input.epub.epubCheck.errorCount,
      warningCount: input.epub.epubCheck.warningCount,
    },
    mappingIds: [navigation.id],
    source: navigation.source as SourceLocation,
    output: navigation.output,
    message: 'EPUBCheck must pass with no errors or warnings.',
  })
}

function sourceRegionChecks(input: SourceEpubComparisonInput): PendingCheck[] {
  const claims = new Map<string, SourceOutputMapping[]>()
  for (const mapping of input.mappings) {
    for (const regionId of new Set(mapping.source.sourceRegionIds)) {
      claims.set(regionId, [...(claims.get(regionId) ?? []), mapping])
    }
  }
  return sortedSourceObligations(input.sourceRegions).map((region) => {
    const regionClaims = claims.get(region.id) ?? []
    const successful = regionClaims.filter(
      ({ status, output }) => status === 'mapped' && output.length === 1,
    )
    return receiptCheck({
      id: `source-region-${region.id}`,
      check: 'source-region-conservation',
      expected: { claimCount: 1, successfulClaimCount: 1 },
      actual: {
        claimCount: regionClaims.length,
        successfulClaimCount: successful.length,
      },
      mappingIds: regionClaims.map(({ id }) => id).sort(compareCodeUnits),
      source: region.source as SourceLocation,
      output: regionClaims.flatMap(({ output }) => output),
      message: `Source region ${region.id} must map to one output anchor.`,
    })
  })
}

function observationChecks(input: SourceEpubComparisonInput): PendingCheck[] {
  const mappings = new Map(input.mappings.map((mapping) => [mapping.id, mapping]))
  const expectedSets = new Map(
    input.sourceEvidence.expectedObservationSets.map((set) => [set.check, set]),
  )
  const actualSets = new Map(
    input.renderedEpub.actualObservationSets.map((set) => [set.check, set]),
  )
  return input.observations.map((observation): PendingCheck => {
    const cited = observation.mappingIds.map((id) => mappings.get(id))
    const expected = expectedSets.get(observation.check)!
    const actual = actualSets.get(observation.check)!
    const evidenceValid = cited.every(
      (mapping) =>
        mapping?.status === 'mapped' && mapping.output.length === 1,
    )
    return {
      id: observation.idSha256,
      check: observation.check,
      passed:
        evidenceValid &&
        expected.setSha256 === actual.setSha256 &&
        expected.itemCount === actual.itemCount,
      expectedSha256: hashTraceValue(expected),
      actualSha256: hashTraceValue(actual),
      mappingIds: [...observation.mappingIds].sort(compareCodeUnits),
      source: (observation.source ?? cited.find(Boolean)?.source) as
        | SourceLocation
        | undefined,
      output: outputForMappings(observation.mappingIds, mappings),
      message: evidenceValid
        ? `${observation.check} source-derived and renderer-derived receipts must match.`
        : `${observation.check} cites missing or duplicate mapping evidence.`,
    }
  })
}

function failureFor(check: PendingCheck): ComparisonFailure {
  return {
    id: `failure-${hashTraceValue({
      check: check.check,
      id: check.id,
      source: check.source ?? null,
    }).slice(0, 24)}`,
    check: check.check,
    origin: 'deterministic',
    message: check.message,
    mappingIds: check.mappingIds,
    ...(check.source ? { source: check.source } : {}),
    output: check.output,
  }
}

/**
 * Compare #198 source-derived receipts with observations from a strict actual-
 * render adapter. Raw caller expected/actual values are not accepted.
 */
export function compareSourceToRenderedEpub(
  unknownInput: unknown,
): SourceEpubComparatorResult {
  const parsed = comparisonInputSchema.safeParse(unknownInput)
  if (!parsed.success) inputError(parsed.error.issues[0]?.message ?? 'invalid schema')
  const input = parsed.data as SourceEpubComparisonInput
  assertInput(input)

  const pending = [
    renderBindingCheck(input),
    epubPackageCheck(input),
    ...sourceRegionChecks(input),
    ...observationChecks(input),
  ].sort((left, right) =>
    compareComparisonFailures(failureFor(left), failureFor(right)),
  )
  const failures = pending
    .filter(({ passed }) => !passed)
    .map(failureFor)
    .sort(compareComparisonFailures)
  const failuresById = new Map(
    pending.filter(({ passed }) => !passed).map((check) => [check.id, failureFor(check)]),
  )
  const checkResults = pending.map((check) => {
    const failure = failuresById.get(check.id)
    return {
      id: check.id,
      check: check.check,
      origin: 'deterministic' as const,
      status: check.passed ? ('passed' as const) : ('failed' as const),
      expectedSha256: check.expectedSha256,
      actualSha256: check.actualSha256,
      mappingIds: check.mappingIds,
      ...(check.source ? { source: check.source } : {}),
      message: check.message,
      ...(failure ? { failureId: failure.id } : {}),
    }
  })
  return {
    schemaVersion: SOURCE_EPUB_COMPARATOR_SCHEMA_VERSION,
    sourcePdfSha256: input.sourcePdfSha256,
    structSha256: input.structure.artifact.sha256,
    epubSha256: input.epub.bytes.sha256,
    renderObservationReceiptSha256: input.renderedEpub.receiptSha256,
    observationSetSha256: hashTraceValue(
      [...input.observations].sort((left, right) =>
        compareCodeUnits(left.idSha256, right.idSha256),
      ),
    ),
    status: failures.length === 0 ? 'publication-ready' : 'failed',
    denominator: checkResults.length,
    passed: checkResults.length - failures.length,
    failed: failures.length,
    checkResults,
    judgeResults: [],
    failures,
    firstCauseFailureId: failures[0]?.id ?? null,
  }
}

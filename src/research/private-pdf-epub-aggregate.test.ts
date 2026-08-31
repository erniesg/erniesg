import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  PRIVATE_PDF_EPUB_CATEGORIES,
  PRIVATE_PDF_EPUB_ZERO_TOLERANCE_KEYS,
  PrivatePdfEpubSanitizerError,
  buildPrivatePdfEpubAggregate,
  buildPrivatePdfEpubPilotReceipt,
  createPrivatePdfEpubObservation,
  safePrivatePdfEpubError,
  validatePrivatePdfEpubAggregate,
} from './private-pdf-epub-aggregate'
import { PrivatePdfEpubBridgeError } from './private-pdf-epub-bridge'

const notEligibleCategories = Object.fromEntries(
  PRIVATE_PDF_EPUB_CATEGORIES.map((category) => [category, 'not-eligible']),
)

const checkedZeroTolerance = Object.fromEntries(
  PRIVATE_PDF_EPUB_ZERO_TOLERANCE_KEYS.map((key) => [
    key,
    { status: 'checked', failureCount: 0 },
  ]),
)

const notApplicableZeroTolerance = Object.fromEntries(
  PRIVATE_PDF_EPUB_ZERO_TOLERANCE_KEYS.map((key) => [
    key,
    { status: 'not-applicable' },
  ]),
)

const unobservedZeroTolerance = Object.fromEntries(
  PRIVATE_PDF_EPUB_ZERO_TOLERANCE_KEYS.map((key) => [
    key,
    { status: 'not-observed' },
  ]),
)

function renderedObservation(
  categories: readonly (typeof PRIVATE_PDF_EPUB_CATEGORIES)[number][] = [
    'paragraph',
  ],
  ambiguityEligible = true,
) {
  return createPrivatePdfEpubObservation({
    terminalCode: 'READY',
    outcome: 'rendered-ready',
    assignment: {
      categoryEligibility: {
        ...notEligibleCategories,
        ...Object.fromEntries(
          categories.map((category) => [category, 'eligible']),
        ),
        ambiguity: ambiguityEligible ? 'eligible' : 'not-eligible',
      },
      publicationEligibility: 'eligible',
      ambiguityEligibility: ambiguityEligible ? 'eligible' : 'not-eligible',
      semanticEligibility: 'eligible',
    },
    sourceToStruct: {
      status: 'measured',
      neutralObligations: 12,
      conservedNeutralObligations: 12,
    },
    ambiguityDisposition: ambiguityEligible ? 'safe' : 'not-applicable',
    semanticDisposition: 'rendered',
    zeroTolerance: checkedZeroTolerance,
  })
}

function rendererFailure(
  categories: readonly (typeof PRIVATE_PDF_EPUB_CATEGORIES)[number][],
) {
  return createPrivatePdfEpubObservation({
    ...renderedObservation(categories),
    terminalCode: 'STRUCT_RENDERER_REFUSED',
    outcome: 'unexpected-renderer-refusal',
    semanticDisposition: 'not-rendered',
    zeroTolerance: notApplicableZeroTolerance,
  })
}

describe('private Struct aggregate sanitizer', () => {
  it('builds and validates the exact closed public aggregate shape', async () => {
    const report = buildPrivatePdfEpubAggregate(
      Array.from({ length: 5 }, () => renderedObservation()),
    )

    expect(validatePrivatePdfEpubAggregate(report)).toEqual(report)
    expect(report.counts).toMatchObject({
      assigned: 5,
      completed: 5,
      neutralObligations: 60,
      conservedNeutralObligations: 60,
      publicationReady: 5,
    })
    expect(report.rates.assignedCompletion).toBe(1)
    expect(report.categories.paragraph).toEqual({
      status: 'reported',
      numerator: 5,
      denominator: 5,
      rate: 1,
    })
    expect(report.categories.tables).toEqual({ status: 'suppressed' })
    expect(
      Object.values(report.outcomes).reduce((sum, count) => sum + count, 0),
    ).toBe(report.counts.assigned)

    const schema = JSON.parse(
      await readFile(
        new URL(
          '../../docs/schemas/struct-epub-aggregate-report-2.0.0.schema.json',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.schemaVersion.const).toBe(report.schemaVersion)
    expect(Object.keys(schema.$defs.categories.properties).sort()).toEqual(
      [...PRIVATE_PDF_EPUB_CATEGORIES].sort(),
    )
  })

  it('keeps every failed preassigned category member in its denominator', () => {
    const report = buildPrivatePdfEpubAggregate([
      renderedObservation(['tables']),
      renderedObservation(['tables']),
      renderedObservation(['tables']),
      renderedObservation(['tables']),
      rendererFailure(['tables']),
    ])

    expect(report.outcomes['unexpected-renderer-refusal']).toBe(1)
    expect(report.categories.tables).toEqual({
      status: 'reported',
      numerator: 4,
      denominator: 5,
      rate: 0.8,
    })
  })

  it('counts each observed two-run mismatch independently without a digest', () => {
    const mismatch = createPrivatePdfEpubObservation({
      ...renderedObservation(),
      terminalCode: 'NONDETERMINISTIC_OUTPUT',
      outcome: 'conformance-failure',
      semanticDisposition: 'not-rendered',
      zeroTolerance: {
        ...notApplicableZeroTolerance,
        xhtmlByteMismatchCount: {
          status: 'checked',
          failureCount: 1,
        },
      },
    })
    const report = buildPrivatePdfEpubAggregate([
      mismatch,
      renderedObservation(),
    ])
    const serialized = JSON.stringify(report)

    expect(report.outcomes['conformance-failure']).toBe(1)
    expect(report.zeroTolerance.xhtmlByteMismatchCount).toBe(1)
    expect(report.zeroTolerance.epubByteMismatchCount).toBe(0)
    expect(serialized).not.toContain('a'.repeat(64))
    expect(serialized).not.toContain('b'.repeat(64))
  })

  it('keeps expected review refusal distinct without inventing conservation', () => {
    const refusal = createPrivatePdfEpubObservation({
      terminalCode: 'REVIEW_REQUIRED',
      outcome: 'expected-review-refusal',
      assignment: {
        categoryEligibility: {
          ...notEligibleCategories,
          ambiguity: 'eligible',
        },
        publicationEligibility: 'eligible',
        ambiguityEligibility: 'eligible',
        semanticEligibility: 'not-eligible',
      },
      sourceToStruct: { status: 'review-refusal' },
      ambiguityDisposition: 'safe',
      semanticDisposition: 'not-applicable',
      zeroTolerance: notApplicableZeroTolerance,
    })
    const report = buildPrivatePdfEpubAggregate([
      refusal,
      renderedObservation(['paragraph'], false),
    ])

    expect(report.outcomes['expected-review-refusal']).toBe(1)
    expect(report.counts.neutralObligations).toBe(12)
    expect(report.counts.conservedNeutralObligations).toBe(12)
    expect(report.counts.ambiguityEligible).toBe(1)
    expect(report.counts.ambiguitySafe).toBe(1)
  })

  it('does not publish a generic conformance class as a manifest failure', () => {
    const generic = createPrivatePdfEpubObservation({
      ...renderedObservation(),
      terminalCode: 'EPUB_CONFORMANCE_FAILED',
      outcome: 'conformance-failure',
      semanticDisposition: 'not-rendered',
      zeroTolerance: unobservedZeroTolerance,
    })

    expect(() => buildPrivatePdfEpubAggregate([generic])).toThrow(
      PrivatePdfEpubSanitizerError,
    )
    expect(
      Object.values(generic.zeroTolerance).every(
        (assertion) => assertion.status === 'not-observed',
      ),
    ).toBe(true)
  })

  it('keeps an internal pre-Struct failure out of every unobserved metric', () => {
    const internal = createPrivatePdfEpubObservation({
      terminalCode: 'INTERNAL_FAILURE',
      outcome: 'internal-failure',
      assignment: {
        categoryEligibility: Object.fromEntries(
          PRIVATE_PDF_EPUB_CATEGORIES.map((category) => [
            category,
            'unavailable',
          ]),
        ),
        publicationEligibility: 'unavailable',
        ambiguityEligibility: 'unavailable',
        semanticEligibility: 'unavailable',
      },
      sourceToStruct: { status: 'not-observed' },
      ambiguityDisposition: 'unavailable',
      semanticDisposition: 'unavailable',
      zeroTolerance: unobservedZeroTolerance,
    })

    expect(internal.sourceToStruct).toEqual({ status: 'not-observed' })
    expect(() => buildPrivatePdfEpubAggregate([internal])).toThrow(
      PrivatePdfEpubSanitizerError,
    )
  })

  it('rejects impossible outcome, eligibility, and assertion combinations', () => {
    expect(() =>
      createPrivatePdfEpubObservation({
        ...renderedObservation(),
        sourceToStruct: { status: 'not-observed' },
      }),
    ).toThrow(PrivatePdfEpubSanitizerError)

    expect(() =>
      createPrivatePdfEpubObservation({
        ...renderedObservation(),
        assignment: {
          ...renderedObservation().assignment,
          ambiguityEligibility: 'not-eligible',
        },
        ambiguityDisposition: 'safe',
      }),
    ).toThrow(PrivatePdfEpubSanitizerError)

    expect(() =>
      createPrivatePdfEpubObservation({
        ...rendererFailure(['paragraph']),
        outcome: 'conformance-failure',
      }),
    ).toThrow(PrivatePdfEpubSanitizerError)
  })

  it('emits a closed pilot receipt instead of fabricated public metrics', () => {
    const unavailable = () =>
      createPrivatePdfEpubObservation({
        terminalCode: 'INTERNAL_FAILURE',
        outcome: 'internal-failure',
        assignment: {
          categoryEligibility: Object.fromEntries(
            PRIVATE_PDF_EPUB_CATEGORIES.map((category) => [
              category,
              'unavailable',
            ]),
          ),
          publicationEligibility: 'unavailable',
          ambiguityEligibility: 'unavailable',
          semanticEligibility: 'unavailable',
        },
        sourceToStruct: { status: 'not-observed' },
        ambiguityDisposition: 'unavailable',
        semanticDisposition: 'unavailable',
        zeroTolerance: unobservedZeroTolerance,
      })
    const receipt = buildPrivatePdfEpubPilotReceipt(
      Array.from({ length: 5 }, unavailable),
      { holdoutRetained: 66 },
    )

    expect(receipt.pilot).toEqual({
      maximumAllowed: 5,
      assigned: 5,
      completed: 5,
      holdoutRetained: 66,
      disjointHoldout: true,
      structArtifactVerified: true,
      durableUploadCount: 0,
      persistedEpubCount: 0,
    })
    expect(receipt.failureClasses.INTERNAL_FAILURE).toBe(5)
    expect(receipt.publicAggregate).toEqual({
      status: 'unavailable',
      reason: 'incomplete-transaction-evidence',
    })
    expect(
      Object.values(receipt.categories).every(
        (category) => category.status === 'suppressed',
      ),
    ).toBe(true)
    expect(JSON.stringify(receipt)).not.toContain('neutralConservation')
  })

  it('rejects unknown fields and poisoned exceptions with a fixed content-free failure', () => {
    const marker = 'PRIVATE-TITLE-PATH-ID-DIGEST-DO-NOT-LEAK'
    const poisoned = {
      ...renderedObservation(),
      title: marker,
      path: `/private/${marker}`,
      error: { message: marker, stack: marker, cause: marker },
      digest: marker,
    }

    expect(() => createPrivatePdfEpubObservation(poisoned)).toThrow(
      PrivatePdfEpubSanitizerError,
    )
    try {
      createPrivatePdfEpubObservation(poisoned)
    } catch (error) {
      expect(JSON.stringify(safePrivatePdfEpubError(error))).not.toContain(
        marker,
      )
    }

    const hostile = new Error(marker, { cause: { marker } })
    hostile.name = marker
    hostile.stack = marker
    const safe = safePrivatePdfEpubError(hostile)
    expect(safe).toEqual({
      code: 'INTERNAL_FAILURE',
      message:
        'The local conversion stopped safely. Nothing was saved or uploaded.',
    })
    expect(JSON.stringify(safe)).not.toContain(marker)
  })

  it('maps stable bridge failures without copying their arbitrary message or cause', () => {
    const marker = 'PRIVATE-EXCEPTION-CONTENT'
    const error = new PrivatePdfEpubBridgeError('UNSAFE_PDF')
    Object.defineProperties(error, {
      message: { value: marker },
      stack: { value: marker },
      cause: { value: { marker } },
    })

    const safe = safePrivatePdfEpubError(error)
    expect(safe.code).toBe('UNSAFE_PDF')
    expect(safe.message).not.toContain(marker)
    expect(Object.keys(safe).sort()).toEqual(['code', 'message'])

    Object.defineProperty(error, 'code', { value: marker })
    expect(safePrivatePdfEpubError(error)).toEqual({
      code: 'INTERNAL_FAILURE',
      message:
        'The local conversion stopped safely. Nothing was saved or uploaded.',
    })
  })
})

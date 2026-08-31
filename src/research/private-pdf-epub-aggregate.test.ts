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
  validatePrivatePdfEpubPilotReceipt,
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

function conformanceFailure(
  categories: readonly (typeof PRIVATE_PDF_EPUB_CATEGORIES)[number][] = [
    'paragraph',
  ],
) {
  return createPrivatePdfEpubObservation({
    ...renderedObservation(categories),
    terminalCode: 'EPUB_CONFORMANCE_FAILED',
    outcome: 'conformance-failure',
    semanticDisposition: 'not-rendered',
    zeroTolerance: {
      ...checkedZeroTolerance,
      manifestFailureCount: { status: 'checked', failureCount: 1 },
    },
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
      conformanceFailure(['tables']),
    ])

    expect(report.outcomes['conformance-failure']).toBe(1)
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
        ...checkedZeroTolerance,
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
    const receipt = buildPrivatePdfEpubPilotReceipt(
      [refusal, renderedObservation(['paragraph'], false)],
      { holdoutRetained: 66 },
    )

    expect(receipt.failureClasses.REVIEW_REQUIRED).toBe(1)
    expect(receipt.publicAggregate).toEqual({
      status: 'unavailable',
      reason: 'incomplete-transaction-evidence',
    })
    expect(JSON.stringify(receipt)).not.toContain('neutralConservation')
  })

  it('does not publish a generic conformance class as a manifest failure', () => {
    const generic = createPrivatePdfEpubObservation({
      ...renderedObservation(),
      terminalCode: 'EPUB_CONFORMANCE_FAILED',
      outcome: 'conformance-failure',
      semanticDisposition: 'not-rendered',
      zeroTolerance: {
        ...unobservedZeroTolerance,
        xhtmlByteMismatchCount: { status: 'checked', failureCount: 0 },
        epubByteMismatchCount: { status: 'checked', failureCount: 0 },
      },
    })

    expect(() => buildPrivatePdfEpubAggregate([generic])).toThrow(
      PrivatePdfEpubSanitizerError,
    )
    expect(
      Object.values(generic.zeroTolerance).filter(
        (assertion) => assertion.status === 'not-observed',
      ).length,
    ).toBe(PRIVATE_PDF_EPUB_ZERO_TOLERANCE_KEYS.length - 2)
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

  it('rejects ready observations whose published assertions were not checked', () => {
    expect(() =>
      createPrivatePdfEpubObservation({
        ...renderedObservation(),
        zeroTolerance: notApplicableZeroTolerance,
      }),
    ).toThrow(PrivatePdfEpubSanitizerError)
  })

  it('requires measured conservation for source-preserved ready outcomes', () => {
    const sourcePreserved = {
      ...renderedObservation(),
      outcome: 'source-preserved-ready',
      semanticDisposition: 'source-preserved',
    } as const

    expect(() =>
      createPrivatePdfEpubObservation({
        ...sourcePreserved,
        sourceToStruct: { status: 'source-preserved' },
      }),
    ).toThrow(PrivatePdfEpubSanitizerError)

    const report = buildPrivatePdfEpubAggregate([
      renderedObservation(),
      renderedObservation(),
      renderedObservation(),
      renderedObservation(),
      createPrivatePdfEpubObservation(sourcePreserved),
    ])
    expect(report.counts.neutralObligations).toBe(60)
    expect(report.counts.conservedNeutralObligations).toBe(60)
    expect(report.outcomes['source-preserved-ready']).toBe(1)
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

  it('binds every available pilot summary to its nested aggregate', () => {
    const receipt = buildPrivatePdfEpubPilotReceipt(
      [
        renderedObservation(),
        renderedObservation(),
        renderedObservation(),
        renderedObservation(),
        conformanceFailure(),
      ],
      { holdoutRetained: 66 },
    )
    expect(receipt.publicAggregate.status).toBe('available')

    expect(() =>
      validatePrivatePdfEpubPilotReceipt({
        ...receipt,
        publicArtifact: {
          ...receipt.publicArtifact,
          gitCommit: 'b'.repeat(40),
        },
      }),
    ).toThrow(PrivatePdfEpubSanitizerError)

    expect(() =>
      validatePrivatePdfEpubPilotReceipt({
        ...receipt,
        categories: {
          ...receipt.categories,
          paragraph: { status: 'suppressed' },
        },
      }),
    ).toThrow(PrivatePdfEpubSanitizerError)

    expect(() =>
      validatePrivatePdfEpubPilotReceipt({
        ...receipt,
        failureClasses: {
          ...receipt.failureClasses,
          EPUB_CONFORMANCE_FAILED: 0,
          INTERNAL_FAILURE: 1,
        },
      }),
    ).toThrow(PrivatePdfEpubSanitizerError)
  })

  it('rejects public aggregates whose counters contradict their population', () => {
    const report = buildPrivatePdfEpubAggregate([
      renderedObservation(),
      renderedObservation(),
      renderedObservation(),
      renderedObservation(),
      conformanceFailure(),
    ])
    const zeroFailures = Object.fromEntries(
      PRIVATE_PDF_EPUB_ZERO_TOLERANCE_KEYS.map((key) => [key, 0]),
    )

    expect(() =>
      validatePrivatePdfEpubAggregate({
        ...report,
        zeroTolerance: zeroFailures,
      }),
    ).toThrow(PrivatePdfEpubSanitizerError)

    const allReady = buildPrivatePdfEpubAggregate(
      Array.from({ length: 5 }, () => renderedObservation()),
    )
    expect(() =>
      validatePrivatePdfEpubAggregate({
        ...allReady,
        zeroTolerance: {
          ...allReady.zeroTolerance,
          manifestFailureCount: 1,
        },
      }),
    ).toThrow(PrivatePdfEpubSanitizerError)

    for (const [count, rateName] of [
      ['publicationEligible', 'publicationReady'],
      ['ambiguityEligible', 'ambiguitySafety'],
      ['semanticEligible', 'semanticCoverage'],
    ] as const)
      expect(() =>
        validatePrivatePdfEpubAggregate({
          ...allReady,
          counts: { ...allReady.counts, [count]: 10 },
          rates: { ...allReady.rates, [rateName]: 0.5 },
        }),
      ).toThrow(PrivatePdfEpubSanitizerError)

    expect(() =>
      validatePrivatePdfEpubAggregate({
        ...allReady,
        categories: {
          ...allReady.categories,
          paragraph: {
            status: 'reported',
            numerator: 5,
            denominator: 10,
            rate: 0.5,
          },
        },
      }),
    ).toThrow(PrivatePdfEpubSanitizerError)

    expect(() =>
      validatePrivatePdfEpubAggregate({
        ...report,
        categories: {
          ...report.categories,
          paragraph: {
            status: 'reported',
            numerator: 5,
            denominator: 5,
            rate: 1,
          },
        },
      }),
    ).toThrow(PrivatePdfEpubSanitizerError)
  })

  it('rejects a pilot whose nested conformance counters are erased', () => {
    const receipt = buildPrivatePdfEpubPilotReceipt(
      [
        renderedObservation(),
        renderedObservation(),
        renderedObservation(),
        renderedObservation(),
        conformanceFailure(),
      ],
      { holdoutRetained: 66 },
    )
    if (receipt.publicAggregate.status !== 'available')
      throw new Error('Expected an available synthetic aggregate.')
    const availableReport = receipt.publicAggregate.report

    expect(() =>
      validatePrivatePdfEpubPilotReceipt({
        ...receipt,
        publicAggregate: {
          status: 'available',
          report: {
            ...availableReport,
            zeroTolerance: Object.fromEntries(
              PRIVATE_PDF_EPUB_ZERO_TOLERANCE_KEYS.map((key) => [key, 0]),
            ),
          },
        },
      }),
    ).toThrow(PrivatePdfEpubSanitizerError)
  })

  it('rejects impossible category counters when a pilot aggregate is unavailable', () => {
    const receipt = buildPrivatePdfEpubPilotReceipt(
      [
        renderedObservation(),
        renderedObservation(),
        renderedObservation(),
        renderedObservation(),
        rendererFailure(['paragraph']),
      ],
      { holdoutRetained: 66 },
    )
    expect(receipt.publicAggregate.status).toBe('unavailable')

    for (const paragraph of [
      { status: 'reported', numerator: 4, denominator: 10, rate: 0.4 },
      { status: 'reported', numerator: 5, denominator: 5, rate: 1 },
      { status: 'reported', numerator: 4, denominator: 5, rate: 1 },
    ] as const)
      expect(() =>
        validatePrivatePdfEpubPilotReceipt({
          ...receipt,
          categories: { ...receipt.categories, paragraph },
        }),
      ).toThrow(PrivatePdfEpubSanitizerError)
  })
})

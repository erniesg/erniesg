import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  PRIVATE_PDF_EPUB_CATEGORIES,
  PRIVATE_PDF_EPUB_ZERO_TOLERANCE_KEYS,
  PrivatePdfEpubSanitizerError,
  buildPrivatePdfEpubAggregate,
  createPrivatePdfEpubObservation,
  safePrivatePdfEpubError,
  validatePrivatePdfEpubAggregate,
} from './private-pdf-epub-aggregate'
import { PrivatePdfEpubBridgeError } from './private-pdf-epub-bridge'

const zeroTolerance = Object.fromEntries(
  PRIVATE_PDF_EPUB_ZERO_TOLERANCE_KEYS.map((key) => [key, 0]),
)

function renderedObservation(
  categories: readonly (typeof PRIVATE_PDF_EPUB_CATEGORIES)[number][] = [
    'paragraph',
  ],
) {
  return createPrivatePdfEpubObservation({
    outcome: 'rendered-ready',
    categories,
    neutralObligations: 12,
    conservedNeutralObligations: 12,
    publicationEligible: true,
    publicationReady: true,
    ambiguityEligible: true,
    ambiguitySafe: true,
    semanticEligible: true,
    renderedSemantically: true,
    zeroTolerance,
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

  it('keeps review refusal distinct and counts two-run mismatch without either digest', () => {
    const mismatch = createPrivatePdfEpubObservation({
      ...renderedObservation(),
      outcome: 'conformance-failure',
      publicationReady: false,
      renderedSemantically: false,
      zeroTolerance: {
        ...zeroTolerance,
        epubByteMismatchCount: 1,
        xhtmlByteMismatchCount: 1,
      },
    })
    const refusal = createPrivatePdfEpubObservation({
      ...renderedObservation(['ambiguity']),
      outcome: 'expected-review-refusal',
      publicationReady: false,
      renderedSemantically: false,
    })
    const report = buildPrivatePdfEpubAggregate([
      mismatch,
      refusal,
      renderedObservation(),
    ])
    const serialized = JSON.stringify(report)

    expect(report.outcomes['expected-review-refusal']).toBe(1)
    expect(report.outcomes['conformance-failure']).toBe(1)
    expect(report.zeroTolerance).toMatchObject({
      epubByteMismatchCount: 1,
      xhtmlByteMismatchCount: 1,
    })
    expect(serialized).not.toContain('a'.repeat(64))
    expect(serialized).not.toContain('b'.repeat(64))
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

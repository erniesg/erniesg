import { describe, expect, it } from 'vitest'
import {
  buildPdfReviewReceipt,
  automatedReviewLabel,
  criterionReviewComplete,
  humanReviewLabel,
  humanizeBlockingDiagnostics,
  paperHumanReviewComplete,
  parsePdfReviewStore,
  pdfReviewStorageKey,
  PDF_REVIEW_CRITERIA,
  randomReviewSampleIndex,
  reviewSampleGroupLabel,
  reviewWorkloadLabel,
  type PdfReviewSample,
  type PdfReviewStore,
} from './PdfEpubReviewQueue'

const sample: PdfReviewSample = {
  id: 'paper-v1',
  setId: 'sample-set',
  sha256: 'a'.repeat(64),
  byteLength: 1234,
  sourceUrl: 'https://arxiv.org/pdf/paper-v1',
}

const snapshot = {
  source: {
    fileName: 'paper-v1.pdf',
    sha256: sample.sha256,
    byteLength: sample.byteLength,
    pageCount: 2,
  },
  readiness: {
    status: 'review-required' as const,
    blockingDiagnosticCodes: ['UNRESOLVED_SEMANTIC_OBJECTS'],
  },
  completeness: {
    textCoverage: 0.99,
    assetCoverage: 0.75,
    relationshipCoverage: 0.5,
    unresolvedObjectCount: 2,
    ocrRequiredPages: [],
    readingOrderDiagnostics: 0,
  },
  diagnostics: [
    {
      code: 'UNRESOLVED_SEMANTIC_OBJECTS',
      severity: 'error' as const,
      page: 2,
    },
  ],
  epub: {
    sha256: 'b'.repeat(64),
    mode: 'readable-fallback' as const,
    profileId: 'mobile' as const,
    profileVersion: '1.1.0',
  },
}

function completeCriteria() {
  return Object.fromEntries(
    PDF_REVIEW_CRITERIA.map(({ id }) => [
      id,
      {
        verdict: id === 'visual-completeness' ? 'fail' : 'pass',
        severity: id === 'visual-completeness' ? 'critical' : undefined,
        location: id === 'visual-completeness' ? 'p. 2 · Figure 1' : '',
        notes:
          id === 'visual-completeness'
            ? 'The source diagram is absent from the EPUB.'
            : '',
        updatedAt: '2026-07-27T00:00:00.000Z',
      },
    ]),
  )
}

describe('PDF EPUB review queue receipt', () => {
  it('labels frozen and seeded-random evidence without calling it a holdout', () => {
    expect(reviewSampleGroupLabel(sample)).toBe('Regression set')
    expect(
      reviewSampleGroupLabel({
        ...sample,
        corpusGroup: 'seeded-random',
      }),
    ).toBe('Random discovery set')
    expect(reviewWorkloadLabel(sample)).toBe('Standard')
    expect(reviewWorkloadLabel({ ...sample, reviewTier: 'stress' })).toBe(
      'Large-document performance test',
    )
  })

  it('keeps provenance, workload, automated status, and human progress separate', () => {
    expect(automatedReviewLabel()).toBe('Not run')
    expect(automatedReviewLabel({ snapshot, criteria: {} })).toBe('Blocked')
    expect(humanReviewLabel()).toBe('Not started')
    expect(
      humanReviewLabel({
        criteria: {
          'content-flow': {
            verdict: 'pass',
            location: '',
            notes: '',
          },
        },
      }),
    ).toBe('1 of 7 checks completed')
    expect(
      humanReviewLabel({
        criteria: completeCriteria(),
      }),
    ).toBe('Failed')
  })

  it('selects reproducible random papers by corpus group and skips stress tests', () => {
    const samples: PdfReviewSample[] = [
      { ...sample, id: 'frozen-a', corpusGroup: 'frozen' },
      {
        ...sample,
        id: 'frozen-stress',
        corpusGroup: 'frozen',
        reviewTier: 'stress',
      },
      { ...sample, id: 'random-a', corpusGroup: 'seeded-random' },
      { ...sample, id: 'random-b', corpusGroup: 'seeded-random' },
    ]

    expect(
      randomReviewSampleIndex({
        samples,
        group: 'mixed',
        currentIndex: 0,
        randomValue: 0,
      }),
    ).toBe(2)
    expect(
      randomReviewSampleIndex({
        samples,
        group: 'seeded-random',
        currentIndex: 2,
        randomValue: 0.999,
      }),
    ).toBe(3)
  })

  it('does not call a machine failure a completed human review', () => {
    expect(
      paperHumanReviewComplete({
        snapshot,
        criteria: {},
      }),
    ).toBe(false)
    expect(
      paperHumanReviewComplete({
        snapshot,
        criteria: completeCriteria(),
      }),
    ).toBe(true)
  })

  it('explains machine blockers in reviewer-facing language', () => {
    expect(
      humanizeBlockingDiagnostics([
        'UNRESOLVED_SEMANTIC_OBJECTS',
        'UNRESOLVED_CORRUPTING_JOIN',
        'UNRESOLVED_SEMANTIC_OBJECTS',
      ]),
    ).toEqual(['missing or unresolved visual content', 'damaged text joins'])
  })

  it('uses a corpus-scoped, versioned local storage key', () => {
    expect(pdfReviewStorageKey('corpus-v1')).toBe(
      'srt:pdf-epub-review:corpus-v1:v2',
    )
  })

  it('requires structured evidence for fail and defer labels', () => {
    expect(
      criterionReviewComplete({
        verdict: 'pass',
        location: '',
        notes: '',
      }),
    ).toBe(true)
    expect(
      criterionReviewComplete({
        verdict: 'fail',
        location: 'Figure 2',
        notes: 'Missing.',
        severity: 'critical',
      }),
    ).toBe(true)
    expect(
      criterionReviewComplete({
        verdict: 'fail',
        location: '',
        notes: 'Missing.',
      }),
    ).toBe(false)
    expect(
      criterionReviewComplete({
        verdict: 'defer',
        location: '',
        notes: '',
      }),
    ).toBe(false)
  })

  it('rejects malformed, stale, or mismatched saved state', () => {
    expect(parsePdfReviewStore('not-json', 'corpus-v1')).toMatchObject({
      corpusId: 'corpus-v1',
      reviewer: '',
      annotations: {},
    })
    expect(
      parsePdfReviewStore(
        JSON.stringify({
          schemaVersion: 1,
          corpusId: 'corpus-v1',
          reviewer: 'reviewer',
          annotations: {},
        }),
        'corpus-v1',
      ),
    ).toMatchObject({ corpusId: 'corpus-v1', annotations: {} })
    expect(
      parsePdfReviewStore(
        JSON.stringify({
          schemaVersion: 2,
          corpusId: 'other-corpus',
          reviewer: 'reviewer',
          annotations: {},
        }),
        'corpus-v1',
      ),
    ).toMatchObject({ corpusId: 'corpus-v1', annotations: {} })
  })

  it('keeps objective machine blockers authoritative over human labels', () => {
    const receipt = buildPdfReviewReceipt({
      store: {
        schemaVersion: 2,
        corpusId: 'corpus-v1',
        reviewer: 'human-maintainer',
        annotations: {
          [sample.id]: {
            criteria: completeCriteria(),
            snapshot,
          },
        },
      } as PdfReviewStore,
      samples: [sample],
      generatedAt: '2026-07-27T00:00:00.000Z',
    })

    expect(receipt).toMatchObject({
      status: 'complete',
      authority: 'portable-hash-bound-receipt',
      telemetryRole: 'optional-non-authoritative-mirror',
      reviewer: 'human-maintainer',
      summary: {
        total: 1,
        machineFail: 1,
        humanFail: 1,
        incomplete: 0,
        sourceIdentityVerified: 1,
        outputIdentityRecorded: 1,
        criterionFailures: { 'visual-completeness': 1 },
      },
      items: [
        {
          disposition: 'machine-fail',
          sourceIdentityVerified: true,
          outputIdentityRecorded: true,
          humanReview: {
            criteria: {
              'visual-completeness': {
                verdict: 'fail',
                severity: 'critical',
                location: 'p. 2 · Figure 1',
              },
            },
          },
          machineReview: {
            readiness: {
              status: 'review-required',
              blockingDiagnosticCodes: ['UNRESOLVED_SEMANTIC_OBJECTS'],
            },
          },
          observation: {
            source: { sha256: sample.sha256 },
            epub: { sha256: 'b'.repeat(64) },
          },
        },
      ],
    })
  })

  it('keeps incomplete review exports explicitly draft', () => {
    const receipt = buildPdfReviewReceipt({
      store: {
        schemaVersion: 2,
        corpusId: 'corpus-v1',
        reviewer: '',
        annotations: {
          [sample.id]: {
            criteria: {},
            snapshot,
          },
        },
      },
      samples: [sample],
      generatedAt: '2026-07-27T00:00:00.000Z',
    })

    expect(receipt).toMatchObject({
      status: 'draft',
      reviewer: null,
      summary: { machineFail: 1, incomplete: 1, pass: 0 },
    })
  })
})

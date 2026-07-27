import { describe, expect, it, vi } from 'vitest'
import {
  isAllowedPdfReviewSinkUrl,
  submitPdfReviewFeedback,
  type PdfReviewFeedbackEvent,
} from './pdf-review-feedback'

const event = {
  schemaVersion: 1,
  eventId: 'event-1',
  eventType: 'pdf-epub-criterion-reviewed',
  occurredAt: '2026-07-27T00:00:00.000Z',
  corpusId: 'corpus',
  sampleId: 'paper',
  setId: 'frozen',
  reviewer: null,
  criterionId: 'visual-completeness',
  verdict: 'fail',
  severity: 'critical',
  location: 'Figure 2',
  notes: 'The diagram is absent.',
  source: {
    expectedSha256: 'a'.repeat(64),
    observedSha256: 'a'.repeat(64),
    identityVerified: true,
  },
  epub: {
    sha256: 'b'.repeat(64),
    mode: 'readable-fallback',
    profileId: 'mobile',
    profileVersion: '1.1.0',
  },
  machine: {
    readiness: 'review-required',
    blockingDiagnosticCodes: ['UNREFERENCED_VISUAL_ASSET'],
    diagnosticCodes: ['UNREFERENCED_VISUAL_ASSET'],
  },
} satisfies PdfReviewFeedbackEvent

describe('PDF review feedback sink', () => {
  it('allows HTTPS and loopback HTTP but rejects remote plaintext sinks', () => {
    expect(
      isAllowedPdfReviewSinkUrl('https://review.example.test/events'),
    ).toBe(true)
    expect(isAllowedPdfReviewSinkUrl('http://127.0.0.1:4319/events')).toBe(true)
    expect(isAllowedPdfReviewSinkUrl('http://localhost:4319/events')).toBe(true)
    expect(isAllowedPdfReviewSinkUrl('http://review.example.test/events')).toBe(
      false,
    )
  })

  it('posts a credential-free structured event', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }))
    await submitPdfReviewFeedback(
      event,
      'http://127.0.0.1:4319/events',
      fetcher,
    )
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:4319/events',
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        body: JSON.stringify(event),
      }),
    )
  })
})

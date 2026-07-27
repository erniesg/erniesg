export type PdfReviewFeedbackEvent = {
  schemaVersion: 1
  eventId: string
  eventType: 'pdf-epub-criterion-reviewed'
  occurredAt: string
  corpusId: string
  sampleId: string
  setId: string
  reviewer: string | null
  criterionId: string
  verdict: 'pass' | 'fail' | 'defer'
  severity: 'minor' | 'major' | 'critical' | null
  location: string
  notes: string
  source: {
    expectedSha256: string
    observedSha256: string | null
    identityVerified: boolean
  }
  epub: {
    sha256: string
    mode: 'publication' | 'readable-fallback'
    profileId: string
    profileVersion: string
  }
  machine: {
    readiness: 'ready' | 'review-required'
    blockingDiagnosticCodes: string[]
    diagnosticCodes: string[]
  }
}

export function isAllowedPdfReviewSinkUrl(value: string) {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        (url.hostname === '127.0.0.1' ||
          url.hostname === 'localhost' ||
          url.hostname === '::1'))
    )
  } catch {
    return false
  }
}

export async function submitPdfReviewFeedback(
  event: PdfReviewFeedbackEvent,
  endpoint: string,
  fetcher: typeof fetch = fetch,
) {
  if (!isAllowedPdfReviewSinkUrl(endpoint)) {
    throw new Error('Review sink must use HTTPS or a loopback HTTP address.')
  }
  const response = await fetcher(endpoint, {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  })
  if (!response.ok) {
    throw new Error(`Review sink rejected the event (${response.status}).`)
  }
}

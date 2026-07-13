import { MAX_LOCAL_PDF_BYTES, PdfImportError } from './import-types'

type FetchPdf = (
  input: string,
  init: RequestInit,
) => Promise<
  Pick<Response, 'blob' | 'headers' | 'ok' | 'status' | 'statusText' | 'url'>
>

function linkedFileName(url: URL) {
  const rawSegment = url.pathname.split('/').pop() || ''
  let decodedSegment = rawSegment
  try {
    decodedSegment = decodeURIComponent(rawSegment)
  } catch {
    // Keep the raw path segment; PDF magic bytes remain the source of truth.
  }
  const finalSegment = decodedSegment
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const candidate = finalSegment || 'linked-paper.pdf'
  return candidate.toLowerCase().endsWith('.pdf')
    ? candidate
    : `${candidate}.pdf`
}

export async function downloadLinkedPdf(
  rawUrl: string,
  fetchPdf: FetchPdf = fetch,
) {
  let requestedUrl: URL
  try {
    requestedUrl = new URL(rawUrl.trim())
  } catch {
    throw new PdfImportError(
      'INVALID_PDF_URL',
      'Enter a complete HTTPS link to a PDF.',
    )
  }
  if (requestedUrl.protocol !== 'https:') {
    throw new PdfImportError(
      'INVALID_PDF_URL',
      'For privacy and integrity, linked papers must use HTTPS.',
    )
  }

  let response: Awaited<ReturnType<FetchPdf>>
  try {
    response = await fetchPdf(requestedUrl.href, {
      credentials: 'omit',
      headers: { Accept: 'application/pdf,application/octet-stream;q=0.8' },
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
    })
  } catch {
    throw new PdfImportError(
      'PDF_DOWNLOAD_FAILED',
      'The publisher did not allow this browser to download the PDF. Download it yourself and drop it here; a safe server-side link adapter is tracked separately.',
    )
  }

  if (!response.ok) {
    throw new PdfImportError(
      'PDF_DOWNLOAD_FAILED',
      `The linked paper returned ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`,
    )
  }

  const finalUrl = new URL(response.url || requestedUrl.href)
  if (finalUrl.protocol !== 'https:') {
    throw new PdfImportError(
      'INVALID_PDF_URL',
      'The paper link redirected to a non-HTTPS address.',
    )
  }
  const declaredBytes = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_LOCAL_PDF_BYTES) {
    throw new PdfImportError(
      'OVERSIZED_PDF',
      `This converter accepts linked PDFs up to ${MAX_LOCAL_PDF_BYTES / 1024 / 1024} MB.`,
    )
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() || ''
  const looksLikePdf =
    contentType.includes('application/pdf') ||
    contentType.includes('application/octet-stream') ||
    finalUrl.pathname.toLowerCase().endsWith('.pdf')
  if (!looksLikePdf) {
    throw new PdfImportError(
      'INVALID_PDF_URL',
      'That link resolved to a web page, not a downloadable PDF.',
    )
  }

  const blob = await response.blob()
  if (blob.size > MAX_LOCAL_PDF_BYTES) {
    throw new PdfImportError(
      'OVERSIZED_PDF',
      `This converter accepts linked PDFs up to ${MAX_LOCAL_PDF_BYTES / 1024 / 1024} MB.`,
    )
  }
  return new File([blob], linkedFileName(finalUrl), {
    type: 'application/pdf',
    lastModified: Date.now(),
  })
}

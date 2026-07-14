import { MAX_LOCAL_PDF_BYTES, PdfImportError } from './import-types'

type FetchPdf = (
  input: string,
  init: RequestInit,
) => Promise<
  Pick<
    Response,
    'blob' | 'body' | 'headers' | 'ok' | 'status' | 'statusText' | 'url'
  >
>

function oversizedPdfError(maxBytes: number) {
  return new PdfImportError(
    'OVERSIZED_PDF',
    `PDF resource limit exceeded: the bounded linked-download limit is ${maxBytes} bytes. The response body was cancelled.`,
  )
}

function cancelledError() {
  return new PdfImportError(
    'IMPORT_CANCELLED',
    'The linked PDF download was cancelled and its response body was released.',
  )
}

async function cancelBody(response: Awaited<ReturnType<FetchPdf>>) {
  await response.body?.cancel().catch(() => undefined)
}

async function readBoundedBlob(
  response: Awaited<ReturnType<FetchPdf>>,
  maxBytes: number,
  contentType: string,
  signal?: AbortSignal,
) {
  if (!response.body) {
    const blob = await response.blob()
    if (blob.size > maxBytes) throw oversizedPdfError(maxBytes)
    return blob
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let receivedBytes = 0
  let completed = false
  const cancel = () => void reader.cancel()
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      if (signal?.aborted) throw cancelledError()
      const { done, value } = await reader.read()
      if (signal?.aborted) throw cancelledError()
      if (done) {
        completed = true
        break
      }
      receivedBytes += value.byteLength
      if (receivedBytes > maxBytes) {
        throw oversizedPdfError(maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    if (!completed) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return new Blob(chunks, { type: contentType || 'application/pdf' })
}

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
  maxBytes = MAX_LOCAL_PDF_BYTES,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw cancelledError()
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
      signal,
    })
  } catch {
    if (signal?.aborted) throw cancelledError()
    throw new PdfImportError(
      'PDF_DOWNLOAD_FAILED',
      'The publisher did not allow this browser to download the PDF. Download it yourself and drop it here; broader publisher support requires a separate safe server-side adapter.',
    )
  }

  if (!response.ok) {
    await cancelBody(response)
    throw new PdfImportError(
      'PDF_DOWNLOAD_FAILED',
      `The linked paper returned ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`,
    )
  }

  const finalUrl = new URL(response.url || requestedUrl.href)
  if (finalUrl.protocol !== 'https:') {
    await cancelBody(response)
    throw new PdfImportError(
      'INVALID_PDF_URL',
      'The paper link redirected to a non-HTTPS address.',
    )
  }
  const declaredBytes = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    await cancelBody(response)
    throw oversizedPdfError(maxBytes)
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() || ''
  const looksLikePdf =
    contentType.includes('application/pdf') ||
    contentType.includes('application/octet-stream') ||
    finalUrl.pathname.toLowerCase().endsWith('.pdf')
  if (!looksLikePdf) {
    await cancelBody(response)
    throw new PdfImportError(
      'INVALID_PDF_URL',
      'That link resolved to a web page, not a downloadable PDF.',
    )
  }

  let blob: Blob
  try {
    blob = await readBoundedBlob(response, maxBytes, contentType, signal)
  } catch (error) {
    if (error instanceof PdfImportError) throw error
    if (signal?.aborted) throw cancelledError()
    throw new PdfImportError(
      'PDF_DOWNLOAD_FAILED',
      'The linked PDF download ended unexpectedly. Download it yourself and drop it here.',
    )
  }
  return new File([blob], linkedFileName(finalUrl), {
    type: 'application/pdf',
    lastModified: Date.now(),
  })
}

import { describe, expect, it, vi } from 'vitest'
import { MAX_LOCAL_PDF_BYTES, PdfImportError } from './import-types'
import { downloadLinkedPdf } from './pdf-url'

function pdfResponse(
  bytes: BlobPart = '%PDF-1.4\n%%EOF',
  headers: Record<string, string> = { 'content-type': 'application/pdf' },
  url = 'https://papers.example/research/paper.pdf',
) {
  const blob = new Blob([bytes], { type: headers['content-type'] })
  return {
    blob: async () => blob,
    body: null,
    headers: new Headers(headers),
    ok: true,
    status: 200,
    statusText: 'OK',
    url,
  }
}

describe('linked PDF download', () => {
  it('downloads an HTTPS PDF without sending browser credentials', async () => {
    const fetchPdf = vi.fn(async () => pdfResponse())

    const file = await downloadLinkedPdf(
      'https://papers.example/research/paper.pdf',
      fetchPdf,
    )

    expect(file.name).toBe('paper.pdf')
    expect(file.type).toBe('application/pdf')
    expect(fetchPdf).toHaveBeenCalledWith(
      'https://papers.example/research/paper.pdf',
      expect.objectContaining({ credentials: 'omit', redirect: 'follow' }),
    )
  })

  it('rejects insecure and non-PDF links', async () => {
    await expect(
      downloadLinkedPdf('http://papers.example/paper.pdf'),
    ).rejects.toMatchObject({
      code: 'INVALID_PDF_URL',
    } satisfies Partial<PdfImportError>)
    await expect(
      downloadLinkedPdf('https://papers.example/article', async () =>
        pdfResponse(
          '<html></html>',
          { 'content-type': 'text/html' },
          'https://papers.example/article',
        ),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_PDF_URL',
    } satisfies Partial<PdfImportError>)
  })

  it('rejects a declared download larger than the local conversion limit', async () => {
    await expect(
      downloadLinkedPdf('https://papers.example/paper.pdf', async () =>
        pdfResponse('%PDF-1.4', {
          'content-type': 'application/pdf',
          'content-length': String(MAX_LOCAL_PDF_BYTES + 1),
        }),
      ),
    ).rejects.toMatchObject({
      code: 'OVERSIZED_PDF',
    } satisfies Partial<PdfImportError>)
  })

  it('cancels a streamed response before it exceeds the conversion limit', async () => {
    const blob = vi.fn(async () => new Blob(['not reached']))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.enqueue(new Uint8Array([4, 5, 6]))
        controller.close()
      },
    })

    await expect(
      downloadLinkedPdf(
        'https://papers.example/paper.pdf',
        async () => ({ ...pdfResponse(), blob, body }),
        5,
      ),
    ).rejects.toMatchObject({
      code: 'OVERSIZED_PDF',
    } satisfies Partial<PdfImportError>)
    expect(blob).not.toHaveBeenCalled()
  })

  it('turns a browser fetch failure into an actionable fallback', async () => {
    await expect(
      downloadLinkedPdf('https://papers.example/paper.pdf', async () => {
        throw new TypeError('CORS blocked')
      }),
    ).rejects.toMatchObject({
      code: 'PDF_DOWNLOAD_FAILED',
    } satisfies Partial<PdfImportError>)
  })
})

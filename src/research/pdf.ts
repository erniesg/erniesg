import type {
  PdfImportProgress,
  PdfPageAnalysis,
  PdfSourceRun,
} from './import-types'
import { MAX_LOCAL_PDF_BYTES, PdfImportError } from './import-types'
import { reconstructPageAnalyses, type PdfDocumentMetadata } from './pdf-layout'

type PdfImportOptions = {
  signal?: AbortSignal
}

function cancelledError() {
  return new PdfImportError(
    'IMPORT_CANCELLED',
    'The local PDF reconstruction was cancelled and its working data was released.',
  )
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelledError()
}

function isPdf(bytes: Uint8Array) {
  const prefix = new TextDecoder('latin1').decode(bytes.subarray(0, 1024))
  return prefix.includes('%PDF-')
}

async function sha256(bytes: Uint8Array) {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, finite(value)))
}

function countImages(fnArray: number[], imageOps: Set<number>) {
  return fnArray.filter((operator) => imageOps.has(operator)).length
}

function metadataValue(info: Record<string, unknown>, key: string) {
  const value = info[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function normalizedPdfDate(value?: string) {
  if (!value) return undefined
  const compact = value.match(/^D:(\d{4})(\d{2})(\d{2})/)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString()
}

export async function reconstructPdf(
  file: File,
  onProgress?: (progress: PdfImportProgress) => void,
  options: PdfImportOptions = {},
) {
  throwIfAborted(options.signal)
  if (file.size > MAX_LOCAL_PDF_BYTES) {
    throw new PdfImportError(
      'OVERSIZED_PDF',
      `PDF resource limit exceeded: received ${file.size} bytes; the bounded local limit is ${MAX_LOCAL_PDF_BYTES} bytes. No document bytes were read.`,
    )
  }

  onProgress?.({
    phase: 'opening',
    completed: 0,
    total: 1,
    message: 'Reading the PDF locally…',
  })
  const bytes = new Uint8Array(await file.arrayBuffer())
  throwIfAborted(options.signal)
  if (!isPdf(bytes)) {
    throw new PdfImportError('INVALID_PDF', 'The selected file is not a PDF.')
  }

  const sourceHash = await sha256(bytes)
  const pdfjs =
    typeof window === 'undefined'
      ? await import('pdfjs-dist/legacy/build/pdf.mjs')
      : await import('pdfjs-dist')
  if (typeof window !== 'undefined') {
    const { default: pdfWorkerUrl } = await import(
      'pdfjs-dist/build/pdf.worker.min.mjs?url'
    )
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  }
  const loadingTask = pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    useSystemFonts: true,
  })

  let passwordReject: ((error: PdfImportError) => void) | undefined
  const passwordRequired = new Promise<never>((_resolve, reject) => {
    passwordReject = reject
  })
  loadingTask.onPassword = () => {
    passwordReject?.(
      new PdfImportError(
        'ENCRYPTED_PDF',
        'Password-protected PDFs are not opened or uploaded by this studio.',
      ),
    )
    void loadingTask.destroy()
  }
  let cancelReject: ((error: PdfImportError) => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancelReject = reject
  })
  const cancelLoading = () => {
    cancelReject?.(cancelledError())
    void loadingTask.destroy()
  }
  options.signal?.addEventListener('abort', cancelLoading, { once: true })

  let document: Awaited<typeof loadingTask.promise>
  try {
    document = await Promise.race([
      loadingTask.promise,
      passwordRequired,
      cancelled,
    ])
  } catch (error) {
    options.signal?.removeEventListener('abort', cancelLoading)
    if (error instanceof PdfImportError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (/password/i.test(message)) {
      throw new PdfImportError('ENCRYPTED_PDF', message)
    }
    throw new PdfImportError(
      'PDF_PARSE_FAILED',
      `PDF.js could not open this document: ${message}`,
    )
  }

  if (document.numPages < 1) {
    await document.destroy()
    throw new PdfImportError('EMPTY_PDF', 'The PDF has no pages.')
  }

  const imageOps = new Set([
    pdfjs.OPS.paintImageMaskXObject,
    pdfjs.OPS.paintImageMaskXObjectGroup,
    pdfjs.OPS.paintImageXObject,
    pdfjs.OPS.paintInlineImageXObject,
    pdfjs.OPS.paintInlineImageXObjectGroup,
    pdfjs.OPS.paintImageXObjectRepeat,
    pdfjs.OPS.paintImageMaskXObjectRepeat,
  ])
  const pages: PdfPageAnalysis[] = []

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      throwIfAborted(options.signal)
      onProgress?.({
        phase: 'extracting',
        completed: pageNumber - 1,
        total: document.numPages,
        message: `Reading page ${pageNumber} of ${document.numPages}…`,
      })
      const page = await document.getPage(pageNumber)
      try {
        const viewport = page.getViewport({ scale: 1 })
        const [textContent, operatorList] = await Promise.all([
          page.getTextContent(),
          page.getOperatorList(),
        ])
        throwIfAborted(options.signal)
        const runs: PdfSourceRun[] = []

        for (const item of textContent.items) {
          if (!('str' in item) || !item.str.trim()) continue
          const transform = pdfjs.Util.transform(
            viewport.transform,
            item.transform,
          )
          const fontHeight =
            Math.hypot(transform[2], transform[3]) || Math.abs(item.height) || 1
          const x = finite(transform[4])
          const y = finite(transform[5] - fontHeight)
          const width = Math.max(Math.abs(item.width * viewport.scale), 0.5)
          runs.push({
            page: pageNumber,
            text: item.str,
            x: clamp(x / viewport.width),
            y: clamp(y / viewport.height),
            width: clamp(width / viewport.width),
            height: clamp(fontHeight / viewport.height),
            rotation: viewport.rotation,
            method: 'pdf-text',
            fontName: item.fontName,
            fontSize: fontHeight,
            confidence: 1,
          })
        }

        const textCharacters = runs.reduce(
          (total, run) => total + run.text.replace(/\s/g, '').length,
          0,
        )
        const imageCount = countImages(operatorList.fnArray, imageOps)
        const kind =
          textCharacters < 24
            ? 'ocr-required'
            : imageCount > 0 && textCharacters < 240
              ? 'mixed'
              : 'born-digital'
        pages.push({
          page: pageNumber,
          kind,
          width: viewport.width,
          height: viewport.height,
          rotation: viewport.rotation,
          textCharacters,
          imageCount,
          runs,
        })
      } finally {
        page.cleanup()
      }
    }

    onProgress?.({
      phase: 'reconstructing',
      completed: document.numPages,
      total: document.numPages,
      message: 'Rebuilding semantic reading order…',
    })
    const rawMetadata = await document.getMetadata().catch(() => undefined)
    const info = (rawMetadata?.info ?? {}) as unknown as Record<string, unknown>
    const metadata: PdfDocumentMetadata = {
      title: metadataValue(info, 'Title'),
      author: metadataValue(info, 'Author'),
      subject: metadataValue(info, 'Subject'),
      modified:
        normalizedPdfDate(metadataValue(info, 'ModDate')) ??
        new Date(file.lastModified || 0).toISOString(),
    }
    return reconstructPageAnalyses({
      pages,
      sourceHash,
      fileName: file.name,
      byteLength: file.size,
      metadata,
    })
  } catch (error) {
    if (options.signal?.aborted) throw cancelledError()
    throw error
  } finally {
    options.signal?.removeEventListener('abort', cancelLoading)
    await document.destroy().catch(() => undefined)
  }
}

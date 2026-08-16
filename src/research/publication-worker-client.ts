import type { EpubExportMode } from './epub'
import {
  withEpubPreviewPayload,
  type PreviewableEpubExport,
} from './epub-preview'
import {
  MAX_LOCAL_PDF_BYTES,
  type DocumentImportProgress,
  type DocumentReconstruction,
  PdfImportError,
  type PdfReconstruction,
} from './import-types'
import {
  PUBLICATION_WORKER_WATCHDOG_MS,
  type PublicationWorkerRequest,
  type PublicationWorkerResponse,
} from './publication-worker-protocol'
import type { TargetProfile } from './targets'

type WorkerLike = Pick<
  Worker,
  'postMessage' | 'terminate' | 'addEventListener' | 'removeEventListener'
>

type WorkerFactory = () => WorkerLike

function defaultWorkerFactory() {
  return new Worker(new URL('./publication.worker.ts', import.meta.url), {
    type: 'module',
    name: 'pdf-epub-publication-worker',
  })
}

function jobId(prefix: string) {
  const random =
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 14)
  return `${prefix}-${Date.now().toString(36)}-${random}`
}

function workerError(code: string, message: string) {
  const pdfCodes = new Set<PdfImportError['code']>([
    'INVALID_PDF',
    'ENCRYPTED_PDF',
    'OVERSIZED_PDF',
    'OCR_REQUIRED',
    'OCR_LANGUAGE_UNAVAILABLE',
    'OCR_NETWORK_FORBIDDEN',
    'EMPTY_PDF',
    'PDF_PARSE_FAILED',
    'INVALID_PDF_URL',
    'PDF_DOWNLOAD_FAILED',
    'IMPORT_CANCELLED',
    'CONVERSION_STALLED',
    'INCOMPLETE_RECONSTRUCTION',
  ])
  return pdfCodes.has(code as PdfImportError['code'])
    ? new PdfImportError(code as PdfImportError['code'], message)
    : new Error(message)
}

async function runWorkerJob<Result>({
  request,
  expectedResult,
  transfer,
  signal,
  onProgress,
  watchdogMs = PUBLICATION_WORKER_WATCHDOG_MS,
  createWorker = defaultWorkerFactory,
  resultFromResponse,
}: {
  request: PublicationWorkerRequest
  expectedResult: 'pdf-result' | 'epub-result'
  transfer: Transferable[]
  signal?: AbortSignal
  onProgress?: (progress: DocumentImportProgress) => void
  watchdogMs?: number
  createWorker?: WorkerFactory
  resultFromResponse?: (response: PublicationWorkerResponse) => Result
}) {
  if (signal?.aborted) {
    throw new PdfImportError(
      'IMPORT_CANCELLED',
      'The background conversion was cancelled before worker startup.',
    )
  }
  const worker = createWorker()
  let lastHeartbeat = Date.now()
  let lastProgress: DocumentImportProgress | undefined
  return await new Promise<Result>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      globalThis.clearInterval(watchdog)
      signal?.removeEventListener('abort', cancel)
      worker.removeEventListener('message', receive)
      worker.removeEventListener('error', fail)
      worker.terminate()
      callback()
    }
    const cancel = () =>
      finish(() =>
        reject(
          new PdfImportError(
            'IMPORT_CANCELLED',
            'The background conversion was cancelled and its worker was terminated.',
          ),
        ),
      )
    const receive = (event: MessageEvent<PublicationWorkerResponse>) => {
      const response = event.data
      if (!response || response.jobId !== request.jobId) return
      lastHeartbeat = Date.now()
      if (response.type === 'heartbeat') return
      if (response.type === 'progress') {
        lastProgress = response.progress
        onProgress?.(response.progress)
        return
      }
      if (response.type === 'error') {
        finish(() => reject(workerError(response.code, response.message)))
        return
      }
      if (response.type === expectedResult) {
        try {
          const result = resultFromResponse
            ? resultFromResponse(response)
            : (response.result as Result)
          finish(() => resolve(result))
        } catch (error) {
          finish(() => reject(error))
        }
      }
    }
    const fail = (event: ErrorEvent) =>
      finish(() =>
        reject(
          new Error(
            event.message ||
              'The background conversion worker stopped unexpectedly.',
          ),
        ),
      )
    const watchdog = globalThis.setInterval(
      () => {
        if (Date.now() - lastHeartbeat <= watchdogMs) return
        finish(() =>
          reject(
            new PdfImportError(
              'CONVERSION_STALLED',
              `The background worker sent no heartbeat for ${Math.ceil(
                watchdogMs / 1_000,
              )} seconds.${
                lastProgress
                  ? ` Last reported stage: ${lastProgress.message}`
                  : ''
              } Retry or cancel this job.`,
            ),
          ),
        )
      },
      Math.min(1_000, Math.max(100, Math.floor(watchdogMs / 4))),
    )
    signal?.addEventListener('abort', cancel, { once: true })
    worker.addEventListener('message', receive)
    worker.addEventListener('error', fail)
    try {
      worker.postMessage(request, transfer)
    } catch (error) {
      finish(() => reject(error))
    }
  })
}

export async function reconstructPdfInWorker(
  file: File,
  onProgress?: (progress: DocumentImportProgress) => void,
  options: {
    signal?: AbortSignal
    ocrLanguage?: 'auto' | 'eng'
    watchdogMs?: number
    createWorker?: WorkerFactory
  } = {},
) {
  if (options.signal?.aborted) {
    throw new PdfImportError(
      'IMPORT_CANCELLED',
      'The background conversion was cancelled before reading document bytes.',
    )
  }
  if (file.size > MAX_LOCAL_PDF_BYTES) {
    throw new PdfImportError(
      'OVERSIZED_PDF',
      `PDF resource limit exceeded: received ${file.size} bytes; the bounded local limit is ${MAX_LOCAL_PDF_BYTES} bytes. No document bytes were read.`,
    )
  }
  const bytes = await file.arrayBuffer()
  return runWorkerJob<PdfReconstruction>({
    request: {
      type: 'convert-pdf',
      jobId: jobId('pdf'),
      file: {
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
        bytes,
      },
      ocrLanguage: options.ocrLanguage ?? 'auto',
    },
    expectedResult: 'pdf-result',
    transfer: [bytes],
    signal: options.signal,
    onProgress,
    watchdogMs: options.watchdogMs,
    createWorker: options.createWorker,
  })
}

export function buildEpubInWorker(
  reconstruction: DocumentReconstruction,
  profile: TargetProfile,
  mode: EpubExportMode,
  options: {
    signal?: AbortSignal
    onProgress?: (progress: DocumentImportProgress) => void
    watchdogMs?: number
    createWorker?: WorkerFactory
  } = {},
) {
  return runWorkerJob<PreviewableEpubExport>({
    request: {
      type: 'build-epub',
      jobId: jobId('epub'),
      reconstruction,
      profile,
      mode,
    },
    expectedResult: 'epub-result',
    transfer: [],
    signal: options.signal,
    onProgress: options.onProgress,
    watchdogMs: options.watchdogMs,
    createWorker: options.createWorker,
    resultFromResponse: (response) => {
      const completed = response as Extract<
        PublicationWorkerResponse,
        { type: 'epub-result' }
      >
      if (!completed.preview) {
        throw new Error(
          'The background worker returned no EPUB preview payload; rebuild the artifact with the current worker.',
        )
      }
      return withEpubPreviewPayload(completed.result, completed.preview)
    },
  })
}

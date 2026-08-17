/// <reference lib="webworker" />

import { buildEpub, buildReadableEpub } from './epub'
import { compileEpubPreviewArchive } from './epub-preview'
import {
  PdfImportError,
  type DocumentImportProgress,
  type PdfReconstruction,
} from './import-types'
import { reconstructPdf } from './pdf'
import {
  PUBLICATION_WORKER_HEARTBEAT_INTERVAL_MS,
  transferableEpubBuffers,
  transferableReconstructionBuffers,
  type PublicationWorkerRequest,
  type PublicationWorkerResponse,
} from './publication-worker-protocol'

const workerScope = self as DedicatedWorkerGlobalScope

function post(
  message: PublicationWorkerResponse,
  transfer: Transferable[] = [],
) {
  workerScope.postMessage(message, transfer)
}

function serializedError(
  jobId: string,
  error: unknown,
): Extract<PublicationWorkerResponse, { type: 'error' }> {
  return {
    type: 'error',
    jobId,
    code:
      error instanceof PdfImportError
        ? error.code
        : error instanceof Error
          ? error.name
          : 'UNEXPECTED_ERROR',
    message:
      error instanceof Error
        ? error.message
        : 'The background conversion worker failed unexpectedly.',
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  }
}

async function handleRequest(request: PublicationWorkerRequest) {
  let currentStage:
    PublicationWorkerRequest['type'] | DocumentImportProgress['phase'] =
    request.type
  const reportProgress = (progress: DocumentImportProgress) => {
    currentStage = progress.phase
    post({ type: 'progress', jobId: request.jobId, progress })
  }
  const heartbeat = workerScope.setInterval(
    () =>
      post({
        type: 'heartbeat',
        jobId: request.jobId,
        at: Date.now(),
        stage: currentStage,
      }),
    PUBLICATION_WORKER_HEARTBEAT_INTERVAL_MS,
  )
  post({
    type: 'heartbeat',
    jobId: request.jobId,
    at: Date.now(),
    stage: currentStage,
  })
  try {
    if (request.type === 'convert-pdf') {
      const file = new File([request.file.bytes], request.file.name, {
        type: request.file.type || 'application/pdf',
        lastModified: request.file.lastModified,
      })
      const result = await reconstructPdf(file, reportProgress)
      post(
        { type: 'pdf-result', jobId: request.jobId, result },
        transferableReconstructionBuffers(result),
      )
      return
    }

    reportProgress({
      phase: 'asset-packaging',
      completed: 0,
      total: 0,
      message:
        'Packaging validated figures, tables, equations, and local assets…',
    })
    reportProgress({
      phase: 'assembling',
      completed: 0,
      total: 0,
      message: 'Assembling the exact packaged EPUB in a background worker…',
    })
    const result =
      request.mode === 'publication'
        ? await buildEpub(
            request.reconstruction.paper,
            request.reconstruction,
            request.profile,
          )
        : await buildReadableEpub(
            request.reconstruction.paper,
            request.reconstruction as PdfReconstruction,
            request.profile,
          )
    reportProgress({
      phase: 'validating',
      completed: 0,
      total: 0,
      message:
        'Validating the packaged EPUB and preparing its sanitized preview…',
    })
    const preview = compileEpubPreviewArchive(result.bytes, {
      markerNonce: request.jobId,
    })
    post(
      { type: 'epub-result', jobId: request.jobId, result, preview },
      transferableEpubBuffers(result, preview),
    )
  } catch (error) {
    post(serializedError(request.jobId, error))
  } finally {
    workerScope.clearInterval(heartbeat)
  }
}

workerScope.addEventListener('message', (event: MessageEvent<unknown>) => {
  const request = event.data as PublicationWorkerRequest
  if (
    !request ||
    typeof request !== 'object' ||
    (request.type !== 'convert-pdf' && request.type !== 'build-epub')
  ) {
    return
  }
  void handleRequest(request)
})

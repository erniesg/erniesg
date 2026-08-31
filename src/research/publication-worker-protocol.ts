import type { EpubExport, EpubExportMode } from './epub'
import type { EpubPreviewPayload } from './epub-preview'
import {
  PdfImportError,
  type DocumentImportProgress,
  type DocumentReconstruction,
  type PdfImportProgress,
  type PdfReconstruction,
} from './import-types'
import type { TargetProfile } from './targets'

export const PUBLICATION_WORKER_HEARTBEAT_INTERVAL_MS = 1_000
export const PUBLICATION_WORKER_WATCHDOG_MS = 30_000
export const CONTENT_FREE_PUBLICATION_WORKER_BOUNDARY = 'content-free' as const

const CONTENT_FREE_PROGRESS_MESSAGES: Record<
  PdfImportProgress['phase'],
  string
> = {
  opening: 'Opening the document locally…',
  extracting: 'Reading document structure locally…',
  ocr: 'Recovering document text locally…',
  segmenting: 'Segmenting document content locally…',
  'reading-order': 'Resolving document reading order locally…',
  'semantic-promotion': 'Checking document semantics locally…',
  'asset-packaging': 'Packaging document assets locally…',
  reconstructing: 'Reconstructing the document locally…',
  assembling: 'Assembling the document locally…',
  paginating: 'Paginating the document locally…',
  validating: 'Validating the document locally…',
}

const PDF_IMPORT_ERROR_CODES = new Set<PdfImportError['code']>([
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

function contentFreeProgressPhase(value: unknown): PdfImportProgress['phase'] {
  return typeof value === 'string' &&
    Object.hasOwn(CONTENT_FREE_PROGRESS_MESSAGES, value)
    ? (value as PdfImportProgress['phase'])
    : 'opening'
}

export function contentFreePublicationWorkerProgress(
  progress: DocumentImportProgress,
): DocumentImportProgress {
  const phase = contentFreeProgressPhase(progress?.phase)
  return {
    phase,
    completed: 0,
    total: 0,
    message: CONTENT_FREE_PROGRESS_MESSAGES[phase],
  }
}

export function contentFreePublicationWorkerErrorCode(value: unknown) {
  return typeof value === 'string' &&
    PDF_IMPORT_ERROR_CODES.has(value as PdfImportError['code'])
    ? (value as PdfImportError['code'])
    : ('UNEXPECTED_ERROR' as const)
}

export function contentFreePublicationWorkerError(error: unknown) {
  let code: unknown
  try {
    if (error instanceof PdfImportError) code = error.code
  } catch {
    code = undefined
  }
  return {
    code: contentFreePublicationWorkerErrorCode(code),
    message: 'The local conversion stopped safely.',
  }
}

export type PublicationWorkerFile = {
  name: string
  type: string
  lastModified: number
  bytes: ArrayBuffer
}

export type PublicationWorkerRequest =
  | {
      type: 'convert-pdf'
      jobId: string
      file: PublicationWorkerFile
      privacyBoundary?: typeof CONTENT_FREE_PUBLICATION_WORKER_BOUNDARY
    }
  | {
      type: 'build-epub'
      jobId: string
      reconstruction: DocumentReconstruction
      profile: TargetProfile
      mode: EpubExportMode
    }

export type PublicationWorkerResponse =
  | {
      type: 'heartbeat'
      jobId: string
      at: number
      stage: PublicationWorkerRequest['type'] | DocumentImportProgress['phase']
    }
  | {
      type: 'progress'
      jobId: string
      progress: DocumentImportProgress
    }
  | {
      type: 'pdf-result'
      jobId: string
      result: PdfReconstruction
    }
  | {
      type: 'epub-result'
      jobId: string
      result: EpubExport
      preview: EpubPreviewPayload
    }
  | {
      type: 'error'
      jobId: string
      code: string
      message: string
      stack?: string
    }

export function transferableReconstructionBuffers(
  reconstruction: PdfReconstruction,
) {
  // The reconstruction owner retains its structured-clone copy. Transfer the
  // worker's backing stores exactly once, including page-local derived renders
  // that are intentionally excluded from the canonical top-level asset set.
  const assets = [
    ...reconstruction.assets,
    ...reconstruction.pages.flatMap((page) => page.assets ?? []),
  ]
  return [
    ...new Set(
      assets.flatMap((asset) =>
        asset.bytes.buffer instanceof ArrayBuffer ? [asset.bytes.buffer] : [],
      ),
    ),
  ]
}

export function transferableEpubBuffers(
  epub: EpubExport,
  preview: EpubPreviewPayload,
) {
  return [
    ...new Set(
      [epub.bytes, ...preview.assets.map((asset) => asset.bytes)].flatMap(
        (bytes) => (bytes.buffer instanceof ArrayBuffer ? [bytes.buffer] : []),
      ),
    ),
  ]
}

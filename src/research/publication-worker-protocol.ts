import type { EpubExport, EpubExportMode } from './epub'
import type { EpubPreviewPayload } from './epub-preview'
import type {
  DocumentImportProgress,
  DocumentReconstruction,
  PdfReconstruction,
} from './import-types'
import type { TargetProfile } from './targets'

export const PUBLICATION_WORKER_HEARTBEAT_INTERVAL_MS = 1_000
export const PUBLICATION_WORKER_WATCHDOG_MS = 30_000

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
  return [
    ...new Set(
      reconstruction.assets.flatMap((asset) =>
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

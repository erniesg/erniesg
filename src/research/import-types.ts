import type { ResearchPaper } from './schema'

export const MAX_LOCAL_PDF_BYTES = 50 * 1024 * 1024

export type PdfPageKind = 'born-digital' | 'mixed' | 'ocr-required'

export type NormalizedSourceBox = {
  page: number
  x: number
  y: number
  width: number
  height: number
  rotation: number
  method: 'pdf-text' | 'ocr'
}

export type PdfSourceRun = NormalizedSourceBox & {
  text: string
  fontName: string
  fontSize: number
  confidence: number
}

export type PdfPageAnalysis = {
  page: number
  kind: PdfPageKind
  width: number
  height: number
  rotation: number
  textCharacters: number
  imageCount: number
  runs: PdfSourceRun[]
}

export type ReconstructionDiagnostic = {
  code:
    | 'OCR_REQUIRED'
    | 'MIXED_PAGE'
    | 'REPEATED_MARGIN_TEXT'
    | 'LOW_CONFIDENCE_BLOCK'
    | 'NO_RECONSTRUCTABLE_TEXT'
  severity: 'info' | 'warning' | 'error'
  page?: number
  message: string
}

export type NodeSourceEvidence = {
  confidence: number
  pages: number[]
  boxes: PdfSourceRun[]
}

export type PdfReconstruction = {
  source: {
    fileName: string
    byteLength: number
    sha256: string
    pageCount: number
    localOnly: true
  }
  paper: ResearchPaper
  pages: PdfPageAnalysis[]
  provenance: Record<string, NodeSourceEvidence>
  diagnostics: ReconstructionDiagnostic[]
}

export type PdfImportProgress = {
  phase: 'opening' | 'extracting' | 'reconstructing'
  completed: number
  total: number
  message: string
}

export class PdfImportError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_PDF'
      | 'ENCRYPTED_PDF'
      | 'OVERSIZED_PDF'
      | 'OCR_REQUIRED'
      | 'EMPTY_PDF'
      | 'PDF_PARSE_FAILED'
      | 'INVALID_PDF_URL'
      | 'PDF_DOWNLOAD_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'PdfImportError'
  }
}

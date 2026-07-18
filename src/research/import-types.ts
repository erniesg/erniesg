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
  method: 'pdf-text' | 'pdf-object' | 'ocr'
}

export type PdfSourceRun = NormalizedSourceBox & {
  text: string
  fontName: string
  fontSize: number
  confidence: number
}

export type PdfNativeObject = {
  id: string
  page: number
  kind: 'image'
  box: NormalizedSourceBox
  confidence: number
}

export type PdfRegionKind =
  | 'body'
  | 'spanning'
  | 'header'
  | 'footer'
  | 'page-number'
  | 'side'
  | 'chart-label'
  | 'figure'
  | 'caption'
  | 'footnote'
  | 'endnote'

export type PdfRegionColumn = 'single' | 'left' | 'right' | 'span'

export type PdfRegionLine = {
  id: string
  text: string
  fontSize: number
  box: NormalizedSourceBox
  runs: PdfSourceRun[]
}

export type PdfPageRegion = {
  id: string
  page: number
  kind: PdfRegionKind
  column: PdfRegionColumn
  text: string
  confidence: number
  box: NormalizedSourceBox
  lines: PdfRegionLine[]
  nativeObjectIds: string[]
  includedInReadingOrder: boolean
}

export type PdfReadingOrderEvidence = {
  code:
    | 'page-sequence'
    | 'vertical-flow'
    | 'column-flow'
    | 'column-gutter'
    | 'font-metrics'
    | 'indentation-continuity'
    | 'caption-proximity'
    | 'block-adjacency'
    | 'margin-note-exclusion'
    | 'footnote-band'
    | 'spanning-boundary'
    | 'note-after-body'
    | 'ambiguous-column-flow'
  detail: string
}

export type PdfReadingOrderAmbiguityClass =
  | 'two-column-with-spanning-float'
  | 'single-column-with-margin-notes'
  | 'mixed-single-two-column'
  | 'dense-reference-section'
  | 'footnote-band'
  | 'sparse-column-gutter'
  | 'fragmented-inline-cluster'

export type PdfReadingOrderResolution = {
  policyVersion: '1.0.0'
  page: number
  ambiguityClass: PdfReadingOrderAmbiguityClass
  status: 'resolved' | 'ambiguous'
  confidence: number
  threshold: number
  evidence: PdfReadingOrderEvidence[]
  regionIds: string[]
}

export type PdfReadingOrderEdge = {
  id: string
  from: string
  to: string
  status: 'accepted' | 'candidate'
  confidence: number
  evidence: PdfReadingOrderEvidence[]
  sourceBoxes: NormalizedSourceBox[]
}

export type PdfReadingOrderEvaluation = {
  schemaVersion: '1.0.0'
  algorithm: 'deterministic-geometry-v1'
  mode: 'deterministic-only'
  regionCount: number
  acceptedEdgeCount: number
  unresolvedEdgeCount: number
  cycleRate: number
  orderAccuracy: number | null
  provider: null
  modelVersion: null
  latencyMs: 0
  costUsd: 0
  reviewRequired: boolean
}

export type PdfReadingOrderGraph = {
  schemaVersion: '1.0.0'
  regionIds: string[]
  order: string[]
  edges: PdfReadingOrderEdge[]
  resolutions: PdfReadingOrderResolution[]
  acyclic: boolean
  evaluation: PdfReadingOrderEvaluation
}

export type PdfNoteMatchCandidate = {
  targetNoteId: string
  targetRegionId: string
  score: number
  evidence: string[]
  sourceBoxes: NormalizedSourceBox[]
}

export type PdfNoteRelationship = {
  id: string
  label: string
  referenceRegionId: string
  targetNoteId: string | null
  status: 'matched' | 'ambiguous' | 'unresolved'
  confidence: number
  evidence: string[]
  candidates: PdfNoteMatchCandidate[]
  sourceBoxes: NormalizedSourceBox[]
}

export type PdfPageAnalysis = {
  page: number
  kind: PdfPageKind
  width: number
  height: number
  rotation: number
  textCharacters: number
  imageCount: number
  objects?: PdfNativeObject[]
  runs: PdfSourceRun[]
}

export type ReconstructionDiagnostic = {
  code:
    | 'OCR_REQUIRED'
    | 'MIXED_PAGE'
    | 'REPEATED_MARGIN_TEXT'
    | 'LOW_CONFIDENCE_BLOCK'
    | 'RESOLVED_READING_ORDER'
    | 'AMBIGUOUS_READING_ORDER'
    | 'READING_ORDER_CYCLE'
    | 'AMBIGUOUS_NOTE_MATCH'
    | 'UNRESOLVED_NOTE_REFERENCE'
    | 'UNREFERENCED_NOTE'
    | 'NO_RECONSTRUCTABLE_TEXT'
    | 'INCOMPLETE_TEXT_COVERAGE'
    | 'INCOMPLETE_ASSET_COVERAGE'
    | 'INCOMPLETE_RELATIONSHIP_COVERAGE'
    | 'UNRESOLVED_SEMANTIC_OBJECTS'
  severity: 'info' | 'warning' | 'error'
  page?: number
  message: string
  sourceBoxes?: NormalizedSourceBox[]
  relationshipId?: string
  readingOrderResolution?: Omit<PdfReadingOrderResolution, 'regionIds'> & {
    regionId?: string
  }
}

export type PdfSemanticSignals = {
  captions: number
  tables: number
  equations: number
  footnoteReferences: number
  footnotes: number
}

export type PdfCompletenessMetrics = {
  sourceTextCharacters: number
  outputTextCharacters: number
  matchedTextCharacters: number
  textCoverage: number
  sourceAssetCount: number
  exportedAssetCount: number
  assetCoverage: number
  expectedRelationshipCount: number
  resolvedRelationshipCount: number
  relationshipCoverage: number
  unresolvedObjectCount: number
  unresolvedObjects: PdfSemanticSignals & { assets: number }
  ocrRequiredPages: number[]
  readingOrderDiagnostics: number
  readingOrderEvaluation: PdfReadingOrderEvaluation
}

export type PdfCompletenessPolicy = {
  minimumTextCoverage: number
  minimumAssetCoverage: number
  minimumRelationshipCoverage: number
  maximumUnresolvedObjects: number
  maximumOcrRequiredPages: number
  maximumReadingOrderDiagnostics: number
}

export type PdfReadiness = {
  status: 'ready' | 'review-required'
  ready: boolean
  policy: PdfCompletenessPolicy
  blockingDiagnosticCodes: ReconstructionDiagnostic['code'][]
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
  regions: PdfPageRegion[]
  readingOrder: PdfReadingOrderGraph
  noteRelationships: PdfNoteRelationship[]
  provenance: Record<string, NodeSourceEvidence>
  diagnostics: ReconstructionDiagnostic[]
  semanticSignals: PdfSemanticSignals
  completeness: PdfCompletenessMetrics
  readiness: PdfReadiness
}

export type PdfImportProgress = {
  phase: 'opening' | 'extracting' | 'reconstructing'
  completed: number
  total: number
  message: string
}

export class PdfImportError extends Error {
  public readonly code:
    | 'INVALID_PDF'
    | 'ENCRYPTED_PDF'
    | 'OVERSIZED_PDF'
    | 'OCR_REQUIRED'
    | 'EMPTY_PDF'
    | 'PDF_PARSE_FAILED'
    | 'INVALID_PDF_URL'
    | 'PDF_DOWNLOAD_FAILED'
    | 'IMPORT_CANCELLED'
    | 'INCOMPLETE_RECONSTRUCTION'

  constructor(code: PdfImportError['code'], message: string) {
    super(message)
    this.code = code
    this.name = 'PdfImportError'
  }
}

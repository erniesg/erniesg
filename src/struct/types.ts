/**
 * Source-agnostic document structure used between extraction and typesetting.
 *
 * The research importer predates this boundary and has PDF-specific types.
 * STRUCT deliberately keeps only evidence and semantics that are useful for
 * any source (PDF, DOCX, HTML, or a future adapter).  Rendering code should
 * consume this graph, never the extractor's private implementation details.
 */

export const STRUCT_SCHEMA_VERSION = '0.1.0' as const

export type StructSourceFormat = 'pdf' | 'docx' | 'html' | 'image' | 'unknown'

export type StructSource = {
  format: StructSourceFormat
  fileName: string
  sha256: string
  byteLength: number
  pageCount: number
  localOnly: boolean
}

export type StructBox = {
  page: number
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

export type StructEvidence = {
  confidence: number
  pages: number[]
  boxes: StructBox[]
  sourceIds: string[]
}

export type StructBlockKind =
  | 'heading'
  | 'paragraph'
  | 'quote'
  | 'list-item'
  | 'figure'
  | 'table'
  | 'equation'
  | 'caption'
  | 'footnote'
  | 'endnote'
  | 'code'
  | 'unknown'

export type StructInline = {
  start: number
  end: number
  href?: string
  annotationId?: string
  relationshipId?: string
  targetIds?: string[]
  bold?: boolean
  italic?: boolean
  verticalAlign?: 'superscript' | 'subscript'
  compactMathAtom?: boolean
  semanticRole?:
    'citation' | 'cross-reference' | 'affiliation-marker' | 'bibliography-entry'
}

export type StructMetadata = {
  title: string
  subtitle: string
  authors: string[]
  abstract: string
  language?: string
  baseDirection?: 'ltr' | 'rtl' | 'unknown'
  publicationDate?: string
  artifactModifiedAt?: string
  updated?: string
  affiliations?: string[]
  authorAffiliations?: Array<{ author: string; label: string }>
}

export type StructTableCell = {
  id: string
  text: string
  row: number
  column: number
  rowSpan: number
  columnSpan: number
  headerScope: 'column' | 'row' | null
  inline: StructInline[]
  evidence: StructEvidence
}

export type StructTable = {
  rows: number
  columns: number
  cells: StructTableCell[]
  semantic: 'verified' | 'source-preserved' | 'unresolved'
}

export type StructBlock = {
  id: string
  kind: StructBlockKind
  text: string
  label?: string
  page: number | null
  order: number
  column: 'single' | 'left' | 'right' | 'span' | null
  inline: StructInline[]
  evidence: StructEvidence
  table?: StructTable
  fallbackAssetIds?: string[]
  attributes?: Record<string, string | number | boolean>
}

export type StructAssetKind =
  'figure' | 'diagram' | 'table' | 'equation' | 'page-region' | 'unknown'

export type StructAsset = {
  id: string
  kind: StructAssetKind
  href: string
  mediaType: string
  sha256: string
  width: number
  height: number
  bytes?: Uint8Array
  sourceObjectIds: string[]
  evidence: StructEvidence
  fallback: 'asset' | 'source-region' | 'text'
}

export type StructRelationshipKind =
  | 'caption'
  | 'figure'
  | 'table'
  | 'equation'
  | 'footnote'
  | 'endnote'
  | 'citation'
  | 'cross-reference'
  | 'hyperlink'
  | 'reading-order'

export type StructRelationshipStatus =
  'matched' | 'ambiguous' | 'unresolved' | 'source-preserved'

export type StructRelationship = {
  id: string
  kind: StructRelationshipKind
  from: string
  to: string[]
  label?: string
  status: StructRelationshipStatus
  confidence: number
  evidence: StructEvidence
}

export type StructDiagnosticSeverity = 'info' | 'warning' | 'error'

export type StructDiagnostic = {
  id: string
  severity: StructDiagnosticSeverity
  category:
    | 'text'
    | 'layout'
    | 'visuals'
    | 'tables'
    | 'equations'
    | 'links'
    | 'notes'
    | 'source'
  title: string
  message: string
  action?: string
  pages: number[]
  sourceIds: string[]
}

export type StructPageLayout = {
  page: number
  width: number
  height: number
  rotation: number
  blocks: string[]
  columns: Array<{
    id: string
    side: 'single' | 'left' | 'right' | 'span'
    blockIds: string[]
  }>
}

export type StructRecovery = {
  status: 'ready' | 'review-required'
  title: string
  summary: string
  issues: Array<{
    category: StructDiagnostic['category']
    title: string
    count: number
    action?: string
  }>
  userAction?: string
}

export type StructReceipt = {
  schemaVersion: typeof STRUCT_SCHEMA_VERSION
  sourceSha256: string
  blockCount: number
  assetCount: number
  relationshipCount: number
  diagnosticCount: number
  textCharacterCount: number
  conservation: {
    sourceNodeCount: number
    accountedSourceNodeCount: number
    sourceRegionCount: number
    accountedSourceRegionCount: number
    sourceAnnotationCount: number
    accountedSourceAnnotationCount: number
    sourceAssetCount: number
    sourceRelationshipCount: number
    sourceDiagnosticCount: number
    sourceTextCharacterCount: number
    structBlockCount: number
    structAssetCount: number
    structRelationshipCount: number
    structDiagnosticCount: number
    structTextCharacterCount: number
  }
  generatedSha256: string
}

export type StructDocument = {
  schemaVersion: typeof STRUCT_SCHEMA_VERSION
  source: StructSource
  metadata: StructMetadata
  blocks: StructBlock[]
  assets: StructAsset[]
  relationships: StructRelationship[]
  pages: StructPageLayout[]
  diagnostics: StructDiagnostic[]
  recovery: StructRecovery
  receipt: StructReceipt
}

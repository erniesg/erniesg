import type { ResearchPaper } from './schema'
import type { TableCandidateReceipt } from './table-candidate-provider'

export const MAX_LOCAL_PDF_BYTES = 50 * 1024 * 1024
export const MAX_LOCAL_DOCX_BYTES = 50 * 1024 * 1024
export const DOCX_IMPORTER_VERSION = '1.0.0'

export type PdfPageKind =
  'born-digital' | 'mixed' | 'ocr-required' | 'ocr-complete'

export type NormalizedSourceBox = {
  page: number
  x: number
  y: number
  width: number
  height: number
  rotation: number
  method: 'pdf-text' | 'pdf-object' | 'pdf-link' | 'ocr'
}

export type PdfTextPaintRunProvenance = {
  algorithm: 'pdfjs-text-paint-run-v1'
  textLedgerSha256: string
  normalizedTextStart: number
  normalizedTextEnd: number
  operatorLedgerSha256: string
  operationIndexes: number[]
  filterableOperationIndexes: number[]
}

export type PdfSourceSemanticAdmission = {
  algorithm: 'pdf-text-item-semantic-admission-v1'
  status: 'unresolved-extension-glyph'
}

export type PdfSourceRun = NormalizedSourceBox & {
  text: string
  fontName: string
  fontSize: number
  sourceSequenceIndex?: number
  sourceTextPaint?: PdfTextPaintRunProvenance
  sourceSemanticAdmission?: PdfSourceSemanticAdmission
  bold?: boolean
  italic?: boolean
  confidence: number
} & (
    | {
        sourceWhitespaceBefore?: undefined
        sourceWhitespacePredecessorIndex?: undefined
      }
    | {
        sourceWhitespaceBefore: 'pdf-text-item'
        sourceWhitespacePredecessorIndex: number
      }
  )

export type PdfLineBoundaryDecision = {
  id: string
  page: number
  regionId: string
  fromLineId: string
  toLineId: string
  outcome:
    | 'space'
    | 'no-space'
    | 'preserved-lexical-hyphen'
    | 'removed-discretionary-hyphen'
    | 'ambiguous'
    | 'structural-boundary'
    | 'unresolved'
  evidence: string[]
}

export type PdfSourceFragmentLineage = {
  algorithm: 'source-run-fragment-v1'
  sourceLineId: string
  fragment:
    | 'whole'
    | 'inline-stacked-before'
    | 'inline-stacked-formula'
    | 'inline-stacked-after'
    | 'cross-gutter-left'
    | 'cross-gutter-right'
  sourceSequenceIndexes: number[]
}

export type PdfSourceSemanticFlowBoundaryEndpoint = {
  regionId: string
  lineId: string
  runIndex: number
  sourceSequenceIndex: number
  sourceRunSha256: string
  sourceFragmentId: string
}

export type PdfSourceSemanticFlowBoundaryDecision = {
  id: string
  page: number
  rotation: number
  method: 'pdf-text' | 'ocr'
  topology: 'inline-stacked-fragment' | 'lexical-hyphen'
  outcome: 'no-space' | 'discretionary-hyphen-delete' | 'hard-hyphen-retain'
  from: PdfSourceSemanticFlowBoundaryEndpoint
  to: PdfSourceSemanticFlowBoundaryEndpoint
  evidence: string[]
}

type PdfCanonicalHyphenBoundaryProofCommon = {
  sourceBoundaryProven: true
  pinnedSplit: {
    left: string
    right: string
    index: number
  }
  splitPointValid: true
  hardHyphenForm: string
  hardHyphenCounterproof: null
  model: {
    id: string
    language: string
    dictionarySha256: string
    affixSha256: string
    hyphenationSha256: string
  }
  evidence: string[]
}

export type PdfCanonicalHyphenBoundaryProof =
  | (PdfCanonicalHyphenBoundaryProofCommon & {
      tier: 'exact-same-document'
      pinnedWord: string
      pinnedJoinedFormValid: true
      exactSameDocumentJoinedForm: string
      sameDocumentJoinedFormValid: true
    })
  | (PdfCanonicalHyphenBoundaryProofCommon & {
      tier: 'same-document-derived-affix'
      derivedWord: string
      productivePrefix: {
        kind: 'prefix'
        value: 're'
        affixClass: 'PFX'
        flag: 'A'
        crossProduct: true
        affixSha256: string
      }
      baseWord: string
      pinnedBaseWordValid: true
      exactSameDocumentBaseWord: string
      sameDocumentBaseWordValid: true
    })

export type PdfCanonicalHyphenBoundaryDecision = {
  id: string
  context: 'bibliography-continuation' | 'canonical-flow-continuation'
  outcome: 'removed-discretionary-hyphen'
  fromRegionId: string
  fromLineId: string
  toRegionId: string
  toLineId: string
  geometry: {
    from: NormalizedSourceBox
    to: NormalizedSourceBox
  }
  proof: PdfCanonicalHyphenBoundaryProof
}

export type PdfSourceExclusionMask =
  | {
      algorithm: 'nearest-source-box-v1'
      expansionPixels: 2
      ownedSourceBoxes: NormalizedSourceBox[]
      excludedSourceBoxes: NormalizedSourceBox[]
    }
  | {
      algorithm: 'pdfjs-display-text-operation-filter-v2'
      expansionPixels: 0
      pdfjsVersion: string
      pdfjsBuild: string
      displayOperatorAdapter: 'pdfjs-5.4.624-display-intent-v1'
      renderIntent: 'display'
      annotationMode: 'enable'
      sourceTextLedgerSha256: string
      displayTextLedgerSha256: string
      ownedTextLedgerSpans: { start: number; end: number }[]
      excludedTextLedgerSpans: { start: number; end: number }[]
      operatorLedgerSha256: string
      ownedOperationIndexes: number[]
      excludedOperationIndexes: number[]
      ownedOnlyExcludedOperationIndexes: number[]
      ownedSourceBoxes: NormalizedSourceBox[]
      excludedSourceBoxes: NormalizedSourceBox[]
      baselineRgbaSha256: string
      filteredRgbaSha256: string
      ownedOnlyRgbaSha256: string
      changedPixelCount: number
      normalizedDiffBox: NormalizedSourceBox
      excludedRunPaintEnvelopes: NormalizedSourceBox[]
    }

export type PdfTextOperationFilterAttestation = Extract<
  PdfSourceExclusionMask,
  { algorithm: 'pdfjs-display-text-operation-filter-v2' }
>

export type PdfTextOperationFilterPlan = Pick<
  PdfTextOperationFilterAttestation,
  | 'algorithm'
  | 'expansionPixels'
  | 'displayOperatorAdapter'
  | 'renderIntent'
  | 'annotationMode'
  | 'sourceTextLedgerSha256'
  | 'ownedTextLedgerSpans'
  | 'excludedTextLedgerSpans'
  | 'ownedSourceBoxes'
  | 'excludedSourceBoxes'
>

export type PdfTextOperationFilterRequest = PdfTextOperationFilterPlan &
  Pick<PdfTextOperationFilterAttestation, 'pdfjsVersion' | 'pdfjsBuild'>

export type PdfResolvedTextOperationFilterRequest = Omit<
  PdfTextOperationFilterAttestation,
  | 'baselineRgbaSha256'
  | 'filteredRgbaSha256'
  | 'ownedOnlyRgbaSha256'
  | 'changedPixelCount'
  | 'normalizedDiffBox'
  | 'excludedRunPaintEnvelopes'
>

export type PdfSourceCropAttemptRequest = {
  kind: 'figure' | 'table' | 'equation'
  page: number
  sourceBox: NormalizedSourceBox
  sourceObjectIds: string[]
  sourceBoxes: NormalizedSourceBox[]
  ownedSourceBoxes?: NormalizedSourceBox[]
  excludedSourceBoxes?: NormalizedSourceBox[]
  sourceTextOperationFilter?: PdfTextOperationFilterPlan
  tightenToSourceInk?: boolean
}

export type PdfSourceCropAttempt = {
  schemaVersion: '1.0.0'
  sequence: number
  request: PdfSourceCropAttemptRequest
  outcome:
    | {
        status: 'edge-contact'
        evidence: 'source-page-crop-edge-contact'
      }
    | {
        status: 'accepted'
        assetId: string
        assetSha256: string
      }
}

export type PdfVisualAsset = {
  id: string
  href: string
  mediaType:
    | 'image/png'
    | 'image/jpeg'
    | 'image/gif'
    | 'image/svg+xml'
    | 'application/xhtml+xml'
  kind: 'raster' | 'vector' | 'table' | 'equation'
  rendition:
    | 'source-preserved'
    | 'profile-downscaled'
    | 'browser-composite-raster'
    | 'source-page-crop'
    | 'bounded-svg-fallback'
    | 'semantic-table'
  sha256: string
  bytes: Uint8Array
  width: number
  height: number
  resolutionDpi: number | null
  sourceObjectIds: string[]
  sourceBoxes: NormalizedSourceBox[]
  sourceCropBox?: NormalizedSourceBox
  sourceExclusionMask?: PdfSourceExclusionMask
  sourceCropAttempts?: PdfSourceCropAttempt[]
}

export type PdfNativeObject = {
  id: string
  page: number
  kind: 'image' | 'vector'
  box: NormalizedSourceBox
  confidence: number
  assetId: string | null
  role?: 'semantic' | 'scan-source'
  rolePolicy?: 'ocr-scan-surface-v1'
}

type PdfLinkAnnotationBase = {
  id: string
  page: number
}

export type PdfExternalLinkAnnotation = PdfLinkAnnotationBase & {
  status: 'external'
  url: string
  box: NormalizedSourceBox
}

export type PdfInternalDestinationPoint = {
  page: number
  x: number | null
  y: number | null
  rotation: number
  method: 'pdf-destination'
}

export type PdfInternalDestinationBox = Omit<NormalizedSourceBox, 'method'> & {
  method: 'pdf-destination'
}

export type PdfInternalDestinationEvidence = {
  source: 'pdfjs-named-destination'
  destination: string
  view: 'XYZ' | 'Fit' | 'FitB' | 'FitH' | 'FitBH' | 'FitV' | 'FitBV' | 'FitR'
  page: number
  point: PdfInternalDestinationPoint | null
  box: PdfInternalDestinationBox | null
}

export type PdfInternalLinkAnnotation = PdfLinkAnnotationBase & {
  status: 'internal'
  url?: never
  destination: string
  destinationEvidence?: PdfInternalDestinationEvidence
  box: NormalizedSourceBox
}

export type PdfUnresolvedLinkAnnotation = PdfLinkAnnotationBase & {
  status: 'unresolved'
  url?: never
  target: string | null
  reason:
    | 'conflicting-targets'
    | 'invalid-geometry'
    | 'missing-target'
    | 'unsafe-external-target'
    | 'unsupported-action'
  box: NormalizedSourceBox | null
}

export type PdfLinkAnnotation =
  | PdfExternalLinkAnnotation
  | PdfInternalLinkAnnotation
  | PdfUnresolvedLinkAnnotation

export type PdfLinkSourceAnchorFragment = {
  regionId: string
  lineId: string
  runIndex: number
  sourceSequenceIndex: number | null
  sourceStart: number
  sourceEnd: number
  text: string
  sourceBox: NormalizedSourceBox
  ownershipEvidence?:
    | 'single-pdf-text-run-character-interval-v1'
    | 'external-target-alias-character-interval-v1'
}

export type PdfLinkSourceAnchor = {
  annotationId: string
  page: number
  status: 'anchored' | 'unresolved'
  fragments: PdfLinkSourceAnchorFragment[]
  evidence: 'exact-source-run-interval-v1'
}

export type PdfEmbeddedLink =
  | PdfLinkAnnotation
  | {
      // Transitional input compatibility for deterministic test fixtures and
      // callers that predate the annotation-obligation ledger. Reconstruction
      // normalizes this shape before any canonical mapping.
      id?: never
      page?: never
      status?: never
      url: string
      box: NormalizedSourceBox
    }

export type PdfOcrWordEvidence = {
  text: string
  confidence: number
  lineId: string
  box: NormalizedSourceBox
  mergeStatus: 'accepted' | 'duplicate' | 'conflict'
}

export type PdfOcrLineEvidence = {
  id: string
  text: string
  confidence: number
  box: NormalizedSourceBox
}

export type PdfOcrPageEvidence = {
  engine: string
  engineVersion: string
  model: string
  modelVersion: string
  languages: string[]
  languageMode: 'explicit' | 'automatic-fallback'
  sourceSha256: string
  rasterSha256: string
  confidence: number
  words: PdfOcrWordEvidence[]
  lines: PdfOcrLineEvidence[]
}

export type PdfLogicalPageRegion = {
  id: string
  physicalPage: number
  side: 'left' | 'right'
  box: NormalizedSourceBox
}

export type PdfPhysicalSpread = {
  status: 'single' | 'split' | 'uncertain'
  boundary: number | null
  confidence: number
  logicalRegions: PdfLogicalPageRegion[]
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
  | 'equation'
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
  captionContinuationSeedId?: string
  sourceFragmentLineage?: PdfSourceFragmentLineage
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
  sourceCaptionLane?: {
    boundary: number
    side: 'left' | 'right'
  }
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
  algorithm: 'deterministic-geometry-v1' | 'explicit-ooxml-v1'
  mode: 'deterministic-only' | 'explicit-structure'
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

export type PdfNoteMarkerTaxonomy =
  | 'footnote-reference'
  | 'endnote-reference'
  | 'bracketed-bibliography-citation'
  | 'author-year-bibliography-citation'
  | 'superscript-citation-cluster'
  | 'superscript-bibliography-citation'
  | 'human-reclassified-citation'
  | 'author-affiliation-superscript'
  | 'symbolic-annotation-marker'
  | 'equation-reference'
  | 'section-reference'
  | 'bibliography-entry'
  | 'unresolved-note-marker'

export type PdfNoteMarkerClassification = {
  id: string
  label: string
  referenceRegionId: string
  start: number
  end: number
  taxonomy: PdfNoteMarkerTaxonomy
  disposition: 'note-reference' | 'citation' | 'plain-text'
  confidence: number
  threshold: number
  accepted: boolean
  evidence: string[]
  sourceBox: NormalizedSourceBox
}

export type PdfNoteCanonicalAnchor =
  | {
      kind: 'node'
      nodeId: string
      start: number
      end: number
    }
  | {
      kind: 'author'
      author: string
    }
  | null

export type PdfNoteRelationship = {
  id: string
  label: string
  referenceRegionId: string
  referenceStart: number
  referenceEnd: number
  targetNoteId: string | null
  status: 'matched' | 'ambiguous' | 'unresolved' | 'citation' | 'plain-text'
  canonicalAnchor: PdfNoteCanonicalAnchor
  confidence: number
  threshold: number
  evidence: string[]
  candidates: PdfNoteMatchCandidate[]
  sourceBoxes: NormalizedSourceBox[]
}

export type PdfCitationRelationship = {
  id: string
  label: string
  labels: string[]
  referenceRegionId: string
  referenceStart: number
  referenceEnd: number
  taxonomy: Extract<
    PdfNoteMarkerTaxonomy,
    | 'bracketed-bibliography-citation'
    | 'author-year-bibliography-citation'
    | 'superscript-citation-cluster'
    | 'superscript-bibliography-citation'
    | 'human-reclassified-citation'
  >
  targetNodeIds: string[]
  targets?: Array<{
    label: string
    targetNodeId: string
    referenceStart: number
    referenceEnd: number
    sourceBoxes: NormalizedSourceBox[]
    evidence: string[]
  }>
  status: 'matched' | 'unresolved'
  canonicalAnchor: {
    nodeId: string
    start: number
    end: number
  } | null
  confidence: number
  evidence: string[]
  sourceBoxes: NormalizedSourceBox[]
}

export type PdfScholarlyCrossReferenceKind =
  'figure' | 'table' | 'section' | 'appendix' | 'equation'

export type PdfScholarlyCrossReferenceTarget = {
  kind: PdfScholarlyCrossReferenceKind
  label: string
  referenceStart: number
  referenceEnd: number
  status: 'matched' | 'ambiguous' | 'unresolved'
  candidateNodeIds: string[]
  targetNodeId: string | null
  evidence: string[]
}

export type PdfScholarlyCrossReferenceRelationship = {
  id: string
  kind: PdfScholarlyCrossReferenceKind
  text: string
  labels: string[]
  referenceRegionId: string
  referenceStart: number
  referenceEnd: number
  targets: PdfScholarlyCrossReferenceTarget[]
  targetNodeIds: string[]
  status: 'matched' | 'ambiguous' | 'unresolved'
  canonicalAnchor: {
    nodeId: string
    start: number
    end: number
  } | null
  confidence: number
  evidence: string[]
  sourceBoxes: NormalizedSourceBox[]
}

export type PdfVisualMatchCandidate = {
  id?: string
  sourceRegionIds: string[]
  sourceLineIds?: string[]
  sourceObjectIds: string[]
  assetIds: string[]
  ownershipExtentSha256?: string
  score: number
  evidence: string[]
  sourceBoxes: NormalizedSourceBox[]
  sourceText?: string
  renderOnlySourceRunOwnerships?: PdfEquationRenderOnlySourceRunOwnership[]
}

export type PdfPreformattedSourceLine = {
  text: string
  indentColumns?: number
  sourceRegionId: string
  sourceLineId: string
  sourceBox: NormalizedSourceBox
  sourceRunBoxes: NormalizedSourceBox[]
}

export type PdfPreformattedSource = {
  status: 'proved' | 'unresolved'
  lines: PdfPreformattedSourceLine[]
  evidence: string[]
}

export type PdfEquationTranscriptAdjudication = {
  schemaVersion: '1.0.0'
  format: 'latex'
  source: 'owner-local-adjudication'
  transcriptSha256: string
  relationshipFingerprintSha256: string
  sourceCropAssetId: string
  sourceCropAssetSha256: string
}

export type PdfEquationMathToken =
  | { type: 'mi'; text: string }
  | { type: 'mn'; text: string }
  | { type: 'mo'; text: string }

export type PdfEquationMathNode =
  | PdfEquationMathToken
  | {
      type: 'msub'
      base: PdfEquationMathToken
      subscript: PdfEquationMathToken
    }
  | {
      type: 'msup'
      base: PdfEquationMathToken
      superscript: PdfEquationMathToken
    }
  | {
      type: 'msubsup'
      base: PdfEquationMathToken
      subscript: PdfEquationMathToken
      superscript: PdfEquationMathToken
    }

export type PdfSourceGeometryScriptTranscript = {
  schemaVersion: '1.0.0'
  source: 'source-geometry-script-transcript-v1'
  mathml: {
    type: 'math'
    display: 'block'
    children: PdfEquationMathNode[]
  }
  plainText: string
  spokenText: string
  provenance: {
    algorithm: 'exact-unicode-math-font-script-geometry-v1'
    sourceRegionIdsSha256: string
    sourceLineIdsSha256: string
    sourceRunsSha256: string
    sourceCropAssetSha256: string
    transcriptSha256: string
  }
}

export type PdfEquationRenderOnlySourceRunOwnership = {
  algorithm: 'equation-bracketed-render-only-extension-glyph-v1'
  page: number
  sourceLineId: string
  sourceSequenceIndex: number
  precedingSourceSequenceIndex: number
  followingSourceSequenceIndex: number
  sourceRunSha256: string
  precedingSourceRunSha256: string
  followingSourceRunSha256: string
}

export type PdfVisualRelationship = {
  id: string
  kind: 'figure' | 'table' | 'equation'
  semanticKind?: 'algorithm' | 'code'
  preformatted?: PdfPreformattedSource
  equationTranscriptAdjudication?: PdfEquationTranscriptAdjudication
  equationGeometryTranscript?: PdfSourceGeometryScriptTranscript
  renderOnlySourceRunOwnerships?: PdfEquationRenderOnlySourceRunOwnership[]
  label: string
  captionRegionId: string
  sourceRegionIds: string[]
  sourceLineIds?: string[]
  sourceObjectIds: string[]
  assetIds: string[]
  status: 'matched' | 'ambiguous' | 'unresolved'
  confidence: number
  evidence: string[]
  candidates: PdfVisualMatchCandidate[]
  sourceBoxes: NormalizedSourceBox[]
  sourceText: string
  altText: string
  altTextSource: 'caption' | 'source-text'
  canonicalNodeId: string | null
  captionNodeId: string | null
}

export type PublicationAsset = PdfVisualAsset
export type PublicationVisualRelationship = PdfVisualRelationship

export type PdfPageAnalysis = {
  page: number
  kind: PdfPageKind
  width: number
  height: number
  rotation: number
  textCharacters: number
  imageCount: number
  objects?: PdfNativeObject[]
  links?: PdfEmbeddedLink[]
  assets?: PdfVisualAsset[]
  runs: PdfSourceRun[]
  renderVisibleTextRuns?: PdfSourceRun[]
  ocr?: PdfOcrPageEvidence
  spread?: PdfPhysicalSpread
}

export type ReconstructionDiagnostic = {
  code:
    | 'OCR_REQUIRED'
    | 'OCR_LANGUAGE_UNAVAILABLE'
    | 'OCR_NETWORK_FORBIDDEN'
    | 'LOW_CONFIDENCE_OCR'
    | 'MIXED_OCR_CONFLICT'
    | 'UNCERTAIN_SPREAD_BOUNDARY'
    | 'MIXED_PAGE'
    | 'REPEATED_MARGIN_TEXT'
    | 'LOW_CONFIDENCE_BLOCK'
    | 'RESOLVED_READING_ORDER'
    | 'SOURCE_ORDER_FLOAT_FALLBACK'
    | 'AMBIGUOUS_READING_ORDER'
    | 'READING_ORDER_CYCLE'
    | 'CLASSIFIED_NOTE_MARKER'
    | 'AMBIGUOUS_NOTE_MATCH'
    | 'UNRESOLVED_NOTE_REFERENCE'
    | 'UNRESOLVED_CITATION_REFERENCE'
    | 'UNMAPPED_CITATION_ANCHOR'
    | 'UNRESOLVED_SCHOLARLY_CROSS_REFERENCE'
    | 'AMBIGUOUS_SCHOLARLY_CROSS_REFERENCE'
    | 'UNMAPPED_SCHOLARLY_CROSS_REFERENCE_ANCHOR'
    | 'UNREFERENCED_NOTE'
    | 'MALFORMED_DOCX'
    | 'MISSING_DOCX_PART'
    | 'MISSING_IMAGE_PART'
    | 'MISSING_IMAGE_CAPTION'
    | 'DANGLING_NOTE_REFERENCE'
    | 'UNRESOLVED_HYPERLINK'
    | 'UNSUPPORTED_DOCX_FEATURE'
    | 'AMBIGUOUS_VISUAL_MATCH'
    | 'UNRESOLVED_VISUAL_OBJECT'
    | 'BOUNDED_TABLE_FALLBACK'
    | 'TABLE_CANDIDATE_NO_PROPOSAL'
    | 'TABLE_CANDIDATE_VERIFICATION_FAILED'
    | 'TABLE_CANDIDATE_PROVIDER_UNAVAILABLE'
    | 'TABLE_CANDIDATE_VERIFIED'
    | 'UNREFERENCED_VISUAL_ASSET'
    | 'NO_RECONSTRUCTABLE_TEXT'
    | 'ISOLATED_PROSE_GLYPH'
    | 'DUPLICATE_CANONICAL_SPAN'
    | 'DUPLICATE_CANONICAL_ROLE'
    | 'CANONICAL_FLOW_ORDER_VIOLATION'
    | 'CANONICAL_VISUAL_ORDER_VIOLATION'
    | 'MISSING_SOURCE_REGION'
    | 'UNPROVENANCED_RENDERED_UNIT'
    | 'UNRESOLVED_FRONT_MATTER'
    | 'INCOMPLETE_INLINE_STYLE_COVERAGE'
    | 'INVALID_LINE_BOUNDARY_LEDGER'
    | 'INVALID_SOURCE_SEMANTIC_FLOW_BOUNDARY_LEDGER'
    | 'INVALID_CANONICAL_HYPHEN_BOUNDARY_LEDGER'
    | 'UNRESOLVED_CORRUPTING_JOIN'
    | 'EPUB_TEXT_SANITIZATION_LOSS'
    | 'DANGLING_EPUB_INTERNAL_REFERENCE'
    | 'INCOMPLETE_TEXT_COVERAGE'
    | 'INCOMPLETE_ASSET_COVERAGE'
    | 'INCOMPLETE_RELATIONSHIP_COVERAGE'
    | 'INCOMPLETE_SEMANTIC_TABLE_COVERAGE'
    | 'UNRESOLVED_EQUATION_TRANSCRIPT'
    | 'UNRESOLVED_ALGORITHM_BLOCK'
    | 'UNRESOLVED_ALGORITHM_TRANSCRIPT'
    | 'UNRESOLVED_PREFORMATTED_BLOCK'
    | 'UNRESOLVED_PREFORMATTED_TRANSCRIPT'
    | 'UNRESOLVED_SEMANTIC_OBJECTS'
    | 'STALE_HUMAN_DECISION'
  severity: 'info' | 'warning' | 'error'
  page?: number
  message: string
  sourceBoxes?: NormalizedSourceBox[]
  relationshipId?: string
  target?: {
    regionIds: string[]
    markerId: string | null
  }
  noteMarkerClassification?: PdfNoteMarkerClassification
  readingOrderResolution?: Omit<PdfReadingOrderResolution, 'regionIds'> & {
    regionId?: string
  }
}

export type PdfSemanticSignals = {
  captions: number
  tables: number
  equations: number
  citations: number
  footnoteReferences: number
  footnotes: number
}

export type PdfCompletenessMetrics = {
  sourceTextCharacters: number
  outputTextCharacters: number
  matchedTextCharacters: number
  textCoverage: number
  duplicateCanonicalSpanCount: number
  missingSourceRegionCount: number
  unprovenancedRenderedUnitCount: number
  expectedInlineSpanCount: number
  mappedInlineSpanCount: number
  inlineSpanCoverage: number
  expectedHyperlinkCount: number
  mappedHyperlinkCount: number
  hyperlinkCoverage: number
  lineBoundaryCount: number
  decidedLineBoundaryCount: number
  unresolvedCorruptingJoinCount: number
  structurallyConsumedLineBoundaryCount: number
  sourceAssetCount: number
  exportedAssetCount: number
  assetCoverage: number
  expectedRelationshipCount: number
  resolvedRelationshipCount: number
  relationshipCoverage: number
  expectedSemanticTableCount?: number
  resolvedSemanticTableCount?: number
  semanticTableCoverage?: number
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
  regionIds: string[]
  boxes: NormalizedSourceBox[]
  links: PdfEmbeddedLink[]
  part?: string
  relationshipIds?: string[]
}

export type HumanAdjudicationResolution =
  | {
      type: 'accept-note-match'
      targetNoteId: string
      targetRegionId: string
    }
  | { type: 'reclassify-citation' }
  | { type: 'reclassify-plain-text' }
  | { type: 'accept-reading-order'; regionIds: string[] }
  | {
      type: 'resolve-line-join'
      transition: {
        id: string
        regionId: string
        fromLineId: string
        toLineId: string
      }
      outcome:
        'remove-wrap-hyphen' | 'preserve-authored-hyphen' | 'leave-unresolved'
      confidence: number
      evidence: Array<'bounded-source-context' | 'owner-local-adjudication'>
    }
  | {
      type: 'accept-equation-transcript'
      relationshipId: string
      relationshipFingerprintSha256: string
      sourceCropAssetId: string
      sourceCropAssetSha256: string
      format: 'latex'
      transcript: string
      confidence: 1
      evidence: Array<'exact-source-page-crop' | 'owner-local-adjudication'>
    }
  | {
      type: 'accept-visual-match' | 'accept-visual-fallback'
      relationshipId: string
      candidateId: string
    }
  | {
      type: 'classify-visual-decoration'
      relationshipId: string
      sourceObjectIds: string[]
      reason:
        | 'page-furniture'
        | 'separator-rule'
        | 'decorative-ornament'
        | 'background'
    }
  | { type: 'dismiss' }

export type HumanAdjudicationRecord = {
  diagnosticCode: ReconstructionDiagnostic['code']
  target: {
    regionIds: string[]
    markerId: string | null
  }
  resolution: HumanAdjudicationResolution
}

export type HumanAdjudicationProvenance = {
  schemaVersion: '1.0.0' | '1.1.0' | '1.2.0' | '1.3.0'
  documentSha256: string
  applied: HumanAdjudicationRecord[]
  stale: Array<
    HumanAdjudicationRecord & {
      reason:
        | 'document-sha256-mismatch'
        | 'diagnostic-target-missing'
        | 'resolution-no-longer-legal'
    }
  >
  countsByDiagnosticCode: Record<string, number>
  visualDecorationReceipts?: Array<{
    relationshipId: string
    sourceObjectIds: string[]
    reason:
      'page-furniture' | 'separator-rule' | 'decorative-ornament' | 'background'
    oldExpectedObjectDenominator: number
    newExpectedObjectDenominator: number
    resultingCoverage: number
  }>
}

export type PdfReconstruction = {
  source: {
    fileName: string
    byteLength: number
    sha256: string
    pageCount: number
    localOnly: true
    format?: undefined
  }
  paper: ResearchPaper
  pages: PdfPageAnalysis[]
  regions: PdfPageRegion[]
  lineBoundaryDecisions: PdfLineBoundaryDecision[]
  sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[]
  sourceSemanticFlowBoundaryDecisionCount: number
  canonicalHyphenBoundaryDecisions: PdfCanonicalHyphenBoundaryDecision[]
  canonicalHyphenBoundaryDecisionCount: number
  unresolvedCorruptingJoinCount: number
  structurallyConsumedLineBoundaryCount: number
  readingOrder: PdfReadingOrderGraph
  noteRelationships: PdfNoteRelationship[]
  citationRelationships: PdfCitationRelationship[]
  crossReferenceRelationships: PdfScholarlyCrossReferenceRelationship[]
  visualRelationships: PdfVisualRelationship[]
  assets: PdfVisualAsset[]
  provenance: Record<string, NodeSourceEvidence>
  humanAdjudications: HumanAdjudicationProvenance
  diagnostics: ReconstructionDiagnostic[]
  tableCandidateReceipts?: TableCandidateReceipt[]
  semanticSignals: PdfSemanticSignals
  completeness: PdfCompletenessMetrics
  readiness: PdfReadiness
}

export type DocxReconstruction = {
  source: {
    fileName: string
    byteLength: number
    sha256: string
    pageCount: 0
    localOnly: true
    format: 'docx'
    packageParts: string[]
    importerVersion: typeof DOCX_IMPORTER_VERSION
  }
  paper: ResearchPaper
  pages: []
  regions: []
  readingOrder: PdfReadingOrderGraph
  noteRelationships: PdfNoteRelationship[]
  visualRelationships: PublicationVisualRelationship[]
  assets: PublicationAsset[]
  provenance: Record<string, NodeSourceEvidence>
  diagnostics: ReconstructionDiagnostic[]
  semanticSignals: PdfSemanticSignals
  completeness: PdfCompletenessMetrics
  readiness: PdfReadiness
}

export type DocumentReconstruction = PdfReconstruction | DocxReconstruction

export type PdfImportProgress = {
  phase:
    | 'opening'
    | 'extracting'
    | 'ocr'
    | 'segmenting'
    | 'reading-order'
    | 'semantic-promotion'
    | 'asset-packaging'
    | 'reconstructing'
    | 'assembling'
    | 'paginating'
    | 'validating'
  completed: number
  total: number
  message: string
  checkpoint?: string
}

export type DocumentImportProgress = PdfImportProgress

export class PdfImportError extends Error {
  public readonly code:
    | 'INVALID_PDF'
    | 'ENCRYPTED_PDF'
    | 'OVERSIZED_PDF'
    | 'OCR_REQUIRED'
    | 'OCR_LANGUAGE_UNAVAILABLE'
    | 'OCR_NETWORK_FORBIDDEN'
    | 'EMPTY_PDF'
    | 'PDF_PARSE_FAILED'
    | 'INVALID_PDF_URL'
    | 'PDF_DOWNLOAD_FAILED'
    | 'IMPORT_CANCELLED'
    | 'CONVERSION_STALLED'
    | 'INCOMPLETE_RECONSTRUCTION'

  constructor(code: PdfImportError['code'], message: string) {
    super(message)
    this.code = code
    this.name = 'PdfImportError'
  }
}

export class DocxImportError extends Error {
  public readonly code:
    | 'INVALID_DOCX'
    | 'OVERSIZED_DOCX'
    | 'DOCX_PARSE_FAILED'
    | 'IMPORT_CANCELLED'
    | 'INCOMPLETE_RECONSTRUCTION'

  constructor(code: DocxImportError['code'], message: string) {
    super(message)
    this.code = code
    this.name = 'DocxImportError'
  }
}

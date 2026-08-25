import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
  type Zippable,
  type ZipOptions,
} from 'fflate'
import { XMLValidator } from 'fast-xml-parser'
import { buildStructEpub } from '@erniesg/struct/renderers/epub'
import { sha256HexSync } from '@erniesg/struct'
import {
  renderPublicationXhtml as renderStructPublicationXhtml,
  type StructXhtmlOptions,
} from '@erniesg/struct/renderers/xhtml'
import type { StructDocument } from '@erniesg/struct/schema'
import {
  DocxImportError,
  PdfImportError,
  type DocumentReconstruction,
  type DocxReconstruction,
  type HumanAdjudicationRecord,
  type PdfReconstruction,
  type PublicationAsset,
} from './import-types'
import {
  validateModelConsultationReceipt,
  type ModelFallbackReceipt,
} from './model-fallback'
import {
  modelConsultationReceiptMatchesPdfReconstruction,
  pdfModelDerivedDecisionKeys,
} from './model-fallback-pipeline'
import { getCompositionPolicy } from './composition'
import {
  assessPdfCompleteness,
  hasValidCanonicalHyphenBoundaryLedger,
  hasValidSourceSemanticFlowBoundaryLedgerCount,
  hasResolvedEquationTranscript,
} from './pdf-quality'
import {
  PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE,
  PDF_HYPHEN_LEXICAL_MODEL,
  PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE,
  PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE,
  PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE,
} from './pdf-hyphenation'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import { assertPublicationIntegrity } from './publication-integrity'
import {
  assertSerializedXhtmlSemanticIntegrity,
  inspectOpfPackage,
  requireWellFormedXml,
  validateAssetMedia,
  xmlAttributeValues,
  xmlTextElements,
} from './epub-integrity'
import {
  packageVisualAssets,
  uniqueAssets,
  containerXml,
  packageOpf,
  epubArtifactModifiedAt,
  entry,
  binaryEntry,
  canonicalJsonSha256,
  opaqueCanonicalHyphenValue,
  canonicalHyphenDeletionContextCounts,
  canonicalHyphenDeletionManifestReceipt,
  sourceSemanticFlowBoundaryManifestReceipt,
  PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE_SHA256S,
  PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE_SHA256S,
  PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE_SHA256S,
} from './epub-archive-packaging'
import {
  validatePdfCrossReferenceEvidence,
  validatePdfHyperlinkEvidence,
} from './epub-pdf-evidence'
import type { ResearchPaper } from './schema'
import {
  resolveTargetProfile,
  type TargetProfile,
  type TargetProfileId,
} from './targets'
import { targetProfileSchema } from './target-schema'
import { downscalePngAsset } from './visual-assets'
import {
  MAX_EPUB_ASSET_BYTES_PER_BOOK,
  MAX_EPUB_ASSETS_PER_BOOK,
} from './publication-resource-limits'
import {
  isBareScholarlyIdentifier,
  scholarlyReferenceCandidateRanges,
  stableId,
  text,
} from './epub-semantic-links'
import {
  epubAssetResourceLimitMessage,
  epubAssetResourceUsage,
  MAX_READABLE_FALLBACK_ASSETS_PER_VISUAL,
  MAX_READABLE_FALLBACK_EQUATIONS_PER_BOOK,
  projectReadableFallbackReconstruction,
} from './epub-readable-fallback'
import {
  assertUniqueCanonicalNodeIds,
  EPUB_CSS,
  navXhtml,
  noteRelationshipSourceEvidence,
  profileEpubCss,
  renderResearchPublicationXhtml,
  renderedSemanticTableNodeIdsForPublication,
  sha256,
  slug,
} from './epub-publication-xhtml'

export { profileEpubCss } from './epub-publication-xhtml'

export {
  MAX_READABLE_FALLBACK_EQUATIONS_PER_BOOK,
  projectReadableFallbackReconstruction,
} from './epub-readable-fallback'

export {
  MAX_EPUB_ASSET_BYTES_PER_BOOK,
  MAX_EPUB_ASSETS_PER_BOOK,
} from './publication-resource-limits'

const EPUB_MIMETYPE = 'application/epub+zip'
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0)
const EPUB_EXPORT_LEGACY_SCHEMA_VERSION = '1.1.0' as const
const EPUB_EXPORT_SCHEMA_VERSION = '1.2.0' as const
export const EPUB_EXPORT_POLICY_VERSION = '1.2.0' as const
export type EpubExportMode = 'publication' | 'readable-fallback'
function isStructDocument(
  input: StructDocument | ResearchPaper,
): input is StructDocument {
  return (
    'schemaVersion' in input &&
    (input.schemaVersion === '0.1.0' || input.schemaVersion === '0.2.0')
  )
}

function isDocxReconstruction(
  reconstruction: DocumentReconstruction,
): reconstruction is DocxReconstruction {
  return reconstruction.source.format === 'docx'
}

function hasCompletePdfAssessmentEvidence(
  reconstruction: PdfReconstruction,
): boolean {
  return Boolean(
    Array.isArray(reconstruction.pages) &&
    reconstruction.pages.length > 0 &&
    Array.isArray(reconstruction.regions) &&
    reconstruction.readingOrder &&
    Array.isArray(reconstruction.visualRelationships) &&
    Array.isArray(reconstruction.assets) &&
    Array.isArray(reconstruction.citationRelationships) &&
    Array.isArray(reconstruction.noteRelationships) &&
    Array.isArray(reconstruction.crossReferenceRelationships) &&
    Array.isArray(reconstruction.lineBoundaryDecisions) &&
    hasValidSourceSemanticFlowBoundaryLedgerCount({
      decisions: reconstruction.sourceSemanticFlowBoundaryDecisions,
      expectedCount: reconstruction.sourceSemanticFlowBoundaryDecisionCount,
    }) &&
    hasValidCanonicalHyphenBoundaryLedger({
      decisions: reconstruction.canonicalHyphenBoundaryDecisions,
      expectedCount: reconstruction.canonicalHyphenBoundaryDecisionCount,
      regions: reconstruction.regions,
    }) &&
    reconstruction.provenance &&
    reconstruction.completeness &&
    Number.isInteger(reconstruction.completeness.expectedInlineSpanCount) &&
    Number.isInteger(reconstruction.completeness.mappedInlineSpanCount) &&
    Number.isInteger(reconstruction.completeness.expectedHyperlinkCount) &&
    Number.isInteger(reconstruction.completeness.mappedHyperlinkCount) &&
    reconstruction.readiness?.policy &&
    typeof reconstruction.readiness.policy.minimumTextCoverage === 'number' &&
    reconstruction.source?.sha256,
  )
}

export type EpubProfileMetadata = {
  id: TargetProfileId
  version: string
  orientation: TargetProfile['orientation']
  artifact: TargetProfile['artifact']
  compositionPolicy: ReturnType<typeof getCompositionPolicy>
  truth: TargetProfile['truth']
  exportPolicy: {
    id: 'profile-tuned-reflowable'
    version: typeof EPUB_EXPORT_POLICY_VERSION
  }
}

export type EpubExport = {
  bytes: Uint8Array
  fileName: string
  mediaType: typeof EPUB_MIMETYPE
  sha256: string
  identifier: string
  entries: string[]
  mode: EpubExportMode
  profile?: EpubProfileMetadata
}

export type EpubInspectionExpectation = {
  canonicalPaper?: ResearchPaper
  sourceCanonicalPaper?: ResearchPaper
  sourcePdfSha256?: string
  sourceSemanticFlowBoundaryLedgerSha256?: string
  canonicalHyphenDeletionLedgerSha256?: string
}

export function getEpubProfileMetadata(
  profile: TargetProfile,
): EpubProfileMetadata {
  return {
    id: profile.id,
    version: profile.version,
    orientation: profile.orientation,
    artifact: profile.artifact,
    compositionPolicy: getCompositionPolicy(profile.id),
    truth: profile.truth,
    exportPolicy: {
      id: 'profile-tuned-reflowable',
      version: EPUB_EXPORT_POLICY_VERSION,
    },
  }
}

function profileManifestReceipt(profileInput: TargetProfile) {
  const profile = targetProfileSchema.parse(profileInput)
  return {
    ...getEpubProfileMetadata(profile),
    dimensions: profile.dimensions,
    ...(profile.manufacturerDisplay
      ? { manufacturerDisplay: profile.manufacturerDisplay }
      : {}),
    preview: profile.preview,
    typography: profile.typography,
    margins: profile.margins,
    pageProgression: profile.epub,
    pixelsPerInch: profile.pixelsPerInch,
    truth: profile.truth,
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${canonicalJson(entryValue)}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

export function renderPublicationXhtml(
  document: StructDocument,
  options?: StructXhtmlOptions,
): string
export function renderPublicationXhtml(
  paper: ResearchPaper,
  options?: {
    embedStyles?: boolean
    reconstruction?: DocumentReconstruction
    styles?: string
    visualAssets?: Map<string, PublicationAsset>
  },
): string
export function renderPublicationXhtml(
  input: StructDocument | ResearchPaper,
  options: {
    embedStyles?: boolean
    reconstruction?: DocumentReconstruction
    styles?: string
    visualAssets?: Map<string, PublicationAsset>
  } = {},
) {
  return isStructDocument(input)
    ? renderStructPublicationXhtml(input, options)
    : renderResearchPublicationXhtml(input, options)
}

type EpubExportManifestReceipt = {
  schemaVersion: typeof EPUB_EXPORT_SCHEMA_VERSION
  identifier: string
  exportMode: EpubExportMode
  publicationGrade: boolean
  canonicalContentSha256: string
  sourceCanonicalContentSha256: string
  sourcePdfSha256?: string
  sourceDocxSha256?: string
  sourceFormat?: 'pdf' | 'docx'
  sourcePackageParts?: string[]
  sourceImporterVersion?: string
  canonicalNodeIds: string[]
  excludedCanonicalNodeIds: string[]
  sourceProvenanceIncluded: boolean
  sourceCompleteness?: Record<string, unknown>
  sourceReadiness?: Record<string, unknown>
  humanAdjudications?: Record<string, unknown>
  modelConsultations?: ModelFallbackReceipt
  modelConsultationsSha256?: string
  sourceSemanticFlowBoundaryCount?: number
  sourceSemanticFlowBoundaryLedger?: unknown[]
  sourceSemanticFlowBoundaryLedgerSha256?: string
  canonicalHyphenDeletionCount?: number
  canonicalHyphenDeletionContextCounts?: Record<string, number>
  canonicalHyphenDeletionLedger?: unknown[]
  canonicalHyphenDeletionLedgerSha256?: string
  assets: unknown[]
  visualRelationships?: unknown[]
  excludedUnresolvedVisualRelationshipCount: number
  profile?: ReturnType<typeof profileManifestReceipt>
  rendition:
    | 'reflowable-epub'
    | 'profile-tuned-reflowable-epub'
    | 'readable-fallback-reflowable-epub'
}

const EPUB_EXPORT_MANIFEST_FIELDS = new Set([
  'schemaVersion',
  'identifier',
  'exportMode',
  'publicationGrade',
  'canonicalContentSha256',
  'sourceCanonicalContentSha256',
  'sourcePdfSha256',
  'sourceDocxSha256',
  'sourceFormat',
  'sourcePackageParts',
  'sourceImporterVersion',
  'canonicalNodeIds',
  'excludedCanonicalNodeIds',
  'sourceProvenanceIncluded',
  'sourceCompleteness',
  'sourceReadiness',
  'humanAdjudications',
  'modelConsultations',
  'modelConsultationsSha256',
  'sourceSemanticFlowBoundaryCount',
  'sourceSemanticFlowBoundaryLedger',
  'sourceSemanticFlowBoundaryLedgerSha256',
  'canonicalHyphenDeletionCount',
  'canonicalHyphenDeletionContextCounts',
  'canonicalHyphenDeletionLedger',
  'canonicalHyphenDeletionLedgerSha256',
  'assets',
  'visualRelationships',
  'excludedUnresolvedVisualRelationshipCount',
  'profile',
  'rendition',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function exactObjectKeys(value: unknown, expected: readonly string[]) {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function isCanonicalHyphenSourceBox(value: unknown) {
  return (
    isRecord(value) &&
    exactObjectKeys(value, [
      'page',
      'x',
      'y',
      'width',
      'height',
      'rotation',
      'method',
    ]) &&
    Number.isSafeInteger(value.page) &&
    (value.page as number) >= 1 &&
    ['x', 'y', 'width', 'height', 'rotation'].every(
      (field) =>
        typeof value[field] === 'number' && Number.isFinite(value[field]),
    ) &&
    (value.width as number) >= 0 &&
    (value.height as number) >= 0 &&
    ['pdf-text', 'pdf-object', 'pdf-link', 'ocr'].includes(
      value.method as string,
    )
  )
}

function isSortedUniqueSha256Array(value: unknown, nonempty = false) {
  return (
    Array.isArray(value) &&
    (!nonempty || value.length > 0) &&
    value.every(isSha256) &&
    value.every(
      (entry, index) =>
        index === 0 || value[index - 1].localeCompare(entry) < 0,
    )
  )
}

function isLegacyCanonicalHyphenDeletionManifestRecord(value: unknown) {
  if (
    !isRecord(value) ||
    !exactObjectKeys(value, [
      'id',
      'context',
      'outcome',
      'fromRegionId',
      'fromLineId',
      'toRegionId',
      'toLineId',
      'geometry',
      'proof',
    ]) ||
    ![
      value.id,
      value.fromRegionId,
      value.fromLineId,
      value.toRegionId,
      value.toLineId,
    ].every(isSha256) ||
    !['bibliography-continuation', 'canonical-flow-continuation'].includes(
      value.context as string,
    ) ||
    value.outcome !== 'removed-discretionary-hyphen' ||
    !isRecord(value.geometry) ||
    !exactObjectKeys(value.geometry, ['from', 'to']) ||
    !isCanonicalHyphenSourceBox(value.geometry.from) ||
    !isCanonicalHyphenSourceBox(value.geometry.to) ||
    !isRecord(value.proof) ||
    !exactObjectKeys(value.proof, [
      'sourceBoundaryProven',
      'pinnedWordSha256',
      'pinnedJoinedFormValid',
      'pinnedSplit',
      'splitPointValid',
      'exactSameDocumentJoinedFormSha256',
      'sameDocumentJoinedFormValid',
      'hardHyphenFormSha256',
      'hardHyphenCounterproof',
      'model',
      'evidenceSha256s',
    ]) ||
    value.proof.sourceBoundaryProven !== true ||
    !isSha256(value.proof.pinnedWordSha256) ||
    value.proof.pinnedJoinedFormValid !== true ||
    !isRecord(value.proof.pinnedSplit) ||
    !exactObjectKeys(value.proof.pinnedSplit, [
      'leftSha256',
      'rightSha256',
      'index',
    ]) ||
    !isSha256(value.proof.pinnedSplit.leftSha256) ||
    !isSha256(value.proof.pinnedSplit.rightSha256) ||
    !Number.isSafeInteger(value.proof.pinnedSplit.index) ||
    (value.proof.pinnedSplit.index as number) < 1 ||
    value.proof.splitPointValid !== true ||
    !isSha256(value.proof.exactSameDocumentJoinedFormSha256) ||
    value.proof.exactSameDocumentJoinedFormSha256 !==
      value.proof.pinnedWordSha256 ||
    value.proof.sameDocumentJoinedFormValid !== true ||
    !isSha256(value.proof.hardHyphenFormSha256) ||
    value.proof.hardHyphenFormSha256 === value.proof.pinnedWordSha256 ||
    value.proof.hardHyphenCounterproof !== null ||
    !isRecord(value.proof.model) ||
    canonicalJson(value.proof.model) !==
      canonicalJson(PDF_HYPHEN_LEXICAL_MODEL) ||
    !isSortedUniqueSha256Array(value.proof.evidenceSha256s, true)
  ) {
    return false
  }
  const evidenceSha256s = value.proof.evidenceSha256s as string[]
  return (
    PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE_SHA256S.every((evidenceSha256) =>
      evidenceSha256s.includes(evidenceSha256),
    ) &&
    PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE_SHA256S.every(
      (evidenceSha256) => !evidenceSha256s.includes(evidenceSha256),
    )
  )
}

function isCanonicalHyphenDeletionManifestRecord(value: unknown) {
  if (
    !isRecord(value) ||
    !exactObjectKeys(value, [
      'id',
      'context',
      'outcome',
      'fromRegionId',
      'fromLineId',
      'toRegionId',
      'toLineId',
      'geometry',
      'proof',
    ]) ||
    ![
      value.id,
      value.fromRegionId,
      value.fromLineId,
      value.toRegionId,
      value.toLineId,
    ].every(isSha256) ||
    !['bibliography-continuation', 'canonical-flow-continuation'].includes(
      value.context as string,
    ) ||
    value.outcome !== 'removed-discretionary-hyphen' ||
    !isRecord(value.geometry) ||
    !exactObjectKeys(value.geometry, ['from', 'to']) ||
    !isCanonicalHyphenSourceBox(value.geometry.from) ||
    !isCanonicalHyphenSourceBox(value.geometry.to) ||
    !isRecord(value.proof) ||
    value.proof.sourceBoundaryProven !== true ||
    !isRecord(value.proof.pinnedSplit) ||
    !exactObjectKeys(value.proof.pinnedSplit, [
      'leftSha256',
      'rightSha256',
      'index',
    ]) ||
    !isSha256(value.proof.pinnedSplit.leftSha256) ||
    !isSha256(value.proof.pinnedSplit.rightSha256) ||
    !Number.isSafeInteger(value.proof.pinnedSplit.index) ||
    (value.proof.pinnedSplit.index as number) < 1 ||
    value.proof.splitPointValid !== true ||
    !isSha256(value.proof.hardHyphenFormSha256) ||
    value.proof.hardHyphenCounterproof !== null ||
    !isRecord(value.proof.model) ||
    canonicalJson(value.proof.model) !==
      canonicalJson(PDF_HYPHEN_LEXICAL_MODEL) ||
    !isSortedUniqueSha256Array(value.proof.evidenceSha256s, true)
  ) {
    return false
  }
  const evidenceSha256s = value.proof.evidenceSha256s as string[]
  const noForbiddenEvidence =
    PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE_SHA256S.every(
      (evidenceSha256) => !evidenceSha256s.includes(evidenceSha256),
    )
  if (!noForbiddenEvidence) return false
  if (value.proof.tier === 'exact-same-document') {
    return (
      exactObjectKeys(value.proof, [
        'tier',
        'sourceBoundaryProven',
        'pinnedWordSha256',
        'pinnedJoinedFormValid',
        'pinnedSplit',
        'splitPointValid',
        'exactSameDocumentJoinedFormSha256',
        'sameDocumentJoinedFormValid',
        'hardHyphenFormSha256',
        'hardHyphenCounterproof',
        'model',
        'evidenceSha256s',
      ]) &&
      isSha256(value.proof.pinnedWordSha256) &&
      value.proof.pinnedJoinedFormValid === true &&
      isSha256(value.proof.exactSameDocumentJoinedFormSha256) &&
      value.proof.exactSameDocumentJoinedFormSha256 ===
        value.proof.pinnedWordSha256 &&
      value.proof.sameDocumentJoinedFormValid === true &&
      value.proof.hardHyphenFormSha256 !== value.proof.pinnedWordSha256 &&
      PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE_SHA256S.every((evidenceSha256) =>
        evidenceSha256s.includes(evidenceSha256),
      )
    )
  }
  if (value.proof.tier !== 'same-document-derived-affix') return false
  if (
    !exactObjectKeys(value.proof, [
      'tier',
      'sourceBoundaryProven',
      'derivedWordSha256',
      'productivePrefix',
      'baseWordSha256',
      'derivationBindingSha256',
      'pinnedBaseWordValid',
      'pinnedSplit',
      'splitPointValid',
      'exactSameDocumentBaseWordSha256',
      'sameDocumentBaseWordValid',
      'hardHyphenFormSha256',
      'hardHyphenCounterproof',
      'model',
      'evidenceSha256s',
    ]) ||
    !isSha256(value.proof.derivedWordSha256) ||
    !isRecord(value.proof.productivePrefix) ||
    canonicalJson(value.proof.productivePrefix) !==
      canonicalJson(PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE) ||
    !isSha256(value.proof.baseWordSha256) ||
    !isSha256(value.proof.derivationBindingSha256) ||
    value.proof.derivationBindingSha256 !==
      canonicalJsonSha256({
        derivedWordSha256: value.proof.derivedWordSha256,
        productivePrefix: value.proof.productivePrefix,
        baseWordSha256: value.proof.baseWordSha256,
      }) ||
    value.proof.pinnedBaseWordValid !== true ||
    !isSha256(value.proof.exactSameDocumentBaseWordSha256) ||
    value.proof.exactSameDocumentBaseWordSha256 !==
      value.proof.baseWordSha256 ||
    value.proof.sameDocumentBaseWordValid !== true ||
    value.proof.derivedWordSha256 === value.proof.baseWordSha256 ||
    value.proof.hardHyphenFormSha256 === value.proof.derivedWordSha256 ||
    (value.proof.pinnedSplit.index as number) <=
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.value.length
  ) {
    return false
  }
  return PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE_SHA256S.every(
    (evidenceSha256) => evidenceSha256s.includes(evidenceSha256),
  )
}

function validateCanonicalHyphenDeletionManifestReceipt(
  parsed: Record<string, unknown>,
) {
  const fields = [
    'canonicalHyphenDeletionCount',
    'canonicalHyphenDeletionContextCounts',
    'canonicalHyphenDeletionLedger',
    'canonicalHyphenDeletionLedgerSha256',
  ] as const
  const present = fields.filter((field) => Object.hasOwn(parsed, field))
  if (parsed.sourceFormat !== 'pdf') {
    if (present.length > 0) {
      throw new Error(
        'EPUB export manifest canonical hyphen deletion receipt is only valid for PDF sources',
      )
    }
    return
  }
  if (present.length !== fields.length) {
    throw new Error(
      'EPUB PDF export manifest is missing its canonical hyphen deletion receipt',
    )
  }
  const records = parsed.canonicalHyphenDeletionLedger
  if (
    !Number.isSafeInteger(parsed.canonicalHyphenDeletionCount) ||
    (parsed.canonicalHyphenDeletionCount as number) < 0 ||
    !Array.isArray(records) ||
    records.length !== parsed.canonicalHyphenDeletionCount ||
    !records.every(
      parsed.schemaVersion === EPUB_EXPORT_LEGACY_SCHEMA_VERSION
        ? isLegacyCanonicalHyphenDeletionManifestRecord
        : isCanonicalHyphenDeletionManifestRecord,
    )
  ) {
    throw new Error(
      'EPUB export manifest canonical hyphen deletion ledger is invalid',
    )
  }
  const recordValues = records as Array<
    Record<string, unknown> & {
      id: string
      context: string
      fromRegionId: string
      fromLineId: string
      toRegionId: string
      toLineId: string
    }
  >
  if (
    recordValues.some(
      (record, index) =>
        index > 0 && recordValues[index - 1].id.localeCompare(record.id) >= 0,
    ) ||
    new Set(recordValues.map((record) => record.id)).size !== records.length ||
    new Set(
      recordValues.map((record) =>
        [
          record.fromRegionId,
          record.fromLineId,
          record.toRegionId,
          record.toLineId,
        ].join('\0'),
      ),
    ).size !== records.length ||
    !isRecord(parsed.canonicalHyphenDeletionContextCounts) ||
    !exactObjectKeys(
      parsed.canonicalHyphenDeletionContextCounts,
      Object.keys(canonicalHyphenDeletionContextCounts(recordValues)),
    ) ||
    canonicalJson(parsed.canonicalHyphenDeletionContextCounts) !==
      canonicalJson(canonicalHyphenDeletionContextCounts(recordValues)) ||
    !isSha256(parsed.canonicalHyphenDeletionLedgerSha256) ||
    parsed.canonicalHyphenDeletionLedgerSha256 !== canonicalJsonSha256(records)
  ) {
    throw new Error(
      'EPUB export manifest canonical hyphen deletion receipt is inconsistent',
    )
  }
}

function isSourceSemanticFlowBoundaryManifestEndpoint(value: unknown) {
  return (
    isRecord(value) &&
    exactObjectKeys(value, [
      'regionId',
      'lineId',
      'runIndex',
      'sourceSequenceIndex',
      'sourceRunSha256',
      'sourceFragmentId',
    ]) &&
    isSha256(value.regionId) &&
    isSha256(value.lineId) &&
    Number.isSafeInteger(value.runIndex) &&
    (value.runIndex as number) >= 0 &&
    Number.isSafeInteger(value.sourceSequenceIndex) &&
    (value.sourceSequenceIndex as number) >= 0 &&
    isSha256(value.sourceRunSha256) &&
    isSha256(value.sourceFragmentId)
  )
}

function isSourceSemanticFlowBoundaryManifestRecord(value: unknown) {
  return (
    isRecord(value) &&
    exactObjectKeys(value, [
      'id',
      'page',
      'rotation',
      'method',
      'topology',
      'outcome',
      'from',
      'to',
      'evidenceSha256s',
    ]) &&
    isSha256(value.id) &&
    Number.isSafeInteger(value.page) &&
    (value.page as number) >= 1 &&
    typeof value.rotation === 'number' &&
    Number.isFinite(value.rotation) &&
    ['pdf-text', 'ocr'].includes(value.method as string) &&
    [
      'inline-stacked-fragment',
      'lexical-hyphen',
      'same-page-column',
      'cross-page-column',
    ].includes(value.topology as string) &&
    [
      'no-space',
      'space',
      'discretionary-hyphen-delete',
      'hard-hyphen-retain',
    ].includes(value.outcome as string) &&
    isSourceSemanticFlowBoundaryManifestEndpoint(value.from) &&
    isSourceSemanticFlowBoundaryManifestEndpoint(value.to) &&
    isSortedUniqueSha256Array(value.evidenceSha256s, true)
  )
}

function validateSourceSemanticFlowBoundaryManifestReceipt(
  parsed: Record<string, unknown>,
) {
  const fields = [
    'sourceSemanticFlowBoundaryCount',
    'sourceSemanticFlowBoundaryLedger',
    'sourceSemanticFlowBoundaryLedgerSha256',
  ] as const
  const present = fields.filter((field) => Object.hasOwn(parsed, field))
  if (parsed.sourceFormat !== 'pdf') {
    if (present.length > 0) {
      throw new Error(
        'EPUB export manifest source semantic-flow receipt is only valid for PDF sources',
      )
    }
    return
  }
  if (present.length !== fields.length) {
    throw new Error(
      'EPUB PDF export manifest is missing its source semantic-flow boundary receipt',
    )
  }
  const records = parsed.sourceSemanticFlowBoundaryLedger
  if (
    !Number.isSafeInteger(parsed.sourceSemanticFlowBoundaryCount) ||
    (parsed.sourceSemanticFlowBoundaryCount as number) < 0 ||
    !Array.isArray(records) ||
    records.length !== parsed.sourceSemanticFlowBoundaryCount ||
    !records.every(isSourceSemanticFlowBoundaryManifestRecord)
  ) {
    throw new Error(
      'EPUB export manifest source semantic-flow boundary ledger is invalid',
    )
  }
  const recordValues = records as Array<{
    id: string
    from: Record<string, unknown>
    to: Record<string, unknown>
  }>
  if (
    recordValues.some(
      (record, index) =>
        index > 0 && recordValues[index - 1].id.localeCompare(record.id) >= 0,
    ) ||
    new Set(recordValues.map((record) => record.id)).size !== records.length ||
    new Set(
      recordValues.map((record) => canonicalJson([record.from, record.to])),
    ).size !== records.length ||
    !isSha256(parsed.sourceSemanticFlowBoundaryLedgerSha256) ||
    parsed.sourceSemanticFlowBoundaryLedgerSha256 !==
      canonicalJsonSha256(records)
  ) {
    throw new Error(
      'EPUB export manifest source semantic-flow boundary receipt is inconsistent',
    )
  }
}

function manifestAdjudicationRecord(decision: HumanAdjudicationRecord) {
  if (decision.resolution.type !== 'accept-equation-transcript') {
    return decision
  }
  const { transcript, ...resolution } = decision.resolution
  return {
    ...decision,
    resolution: {
      ...resolution,
      transcriptSha256: sha256HexSync(strToU8(transcript)),
    },
  }
}

function manifestHumanAdjudications(reconstruction: PdfReconstruction) {
  const applied = reconstruction.humanAdjudications.applied.map(
    manifestAdjudicationRecord,
  )
  return {
    schemaVersion: reconstruction.humanAdjudications.schemaVersion,
    privacy: 'ids-choices-and-transcript-hashes-only',
    appliedCount: applied.length,
    staleCount: reconstruction.humanAdjudications.stale.length,
    countsByDiagnosticCode:
      reconstruction.humanAdjudications.countsByDiagnosticCode,
    appliedReceiptSha256: sha256HexSync(strToU8(JSON.stringify(applied))),
    applied,
    noteSourceAnchorReceipts:
      reconstruction.humanAdjudications.noteSourceAnchorReceipts,
    visualDecorationReceipts:
      reconstruction.humanAdjudications.visualDecorationReceipts,
  }
}

function requireSha256(value: unknown, field: string): asserts value is string {
  if (!isSha256(value)) {
    throw new Error(
      `EPUB export manifest ${field} must be a lowercase SHA-256 digest`,
    )
  }
}

function invalidExportManifest(profiled: boolean): never {
  throw new Error(
    `EPUB ${profiled ? 'profiled ' : ''}export manifest contract is invalid`,
  )
}

function validatedModelConsultationReceiptForExport(
  receipt: unknown,
  {
    documentId,
    sourceSha256,
  }: {
    documentId?: string
    sourceSha256: string
  },
): ModelFallbackReceipt {
  if (!validateModelConsultationReceipt(receipt)) {
    throw new Error('EPUB model consultation receipt is invalid')
  }
  if (
    receipt.consultations.some(
      (consultation) => consultation.status === 'pending',
    )
  ) {
    throw new Error(
      'EPUB export cannot persist a pending model consultation receipt',
    )
  }
  if (documentId !== undefined && receipt.documentId !== documentId) {
    throw new Error(
      'EPUB model consultation receipt documentId does not match the PDF document',
    )
  }
  if (receipt.sourceSha256 !== sourceSha256) {
    throw new Error(
      'EPUB model consultation receipt sourceSha256 does not match the source PDF',
    )
  }
  return structuredClone(receipt)
}

function parseExportManifest(
  value: string,
  profiled = false,
): EpubExportManifestReceipt {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('EPUB export manifest must be valid JSON')
  }
  if (!isRecord(parsed)) {
    invalidExportManifest(profiled)
  }
  const unknownField = Object.keys(parsed).find(
    (field) => !EPUB_EXPORT_MANIFEST_FIELDS.has(field),
  )
  if (unknownField) {
    throw new Error(
      `EPUB export manifest contains unknown export manifest field ${unknownField}`,
    )
  }

  requireSha256(parsed.canonicalContentSha256, 'canonicalContentSha256')
  requireSha256(
    parsed.sourceCanonicalContentSha256,
    'sourceCanonicalContentSha256',
  )
  if (parsed.sourcePdfSha256 !== undefined) {
    requireSha256(parsed.sourcePdfSha256, 'sourcePdfSha256')
  }
  if (parsed.sourceDocxSha256 !== undefined) {
    requireSha256(parsed.sourceDocxSha256, 'sourceDocxSha256')
  }
  if (
    !Array.isArray(parsed.canonicalNodeIds) ||
    parsed.canonicalNodeIds.length === 0 ||
    parsed.canonicalNodeIds.some(
      (id) => typeof id !== 'string' || id.trim().length === 0,
    )
  ) {
    throw new Error(
      'EPUB canonicalNodeIds receipt must contain non-empty strings',
    )
  }

  if (
    ![EPUB_EXPORT_LEGACY_SCHEMA_VERSION, EPUB_EXPORT_SCHEMA_VERSION].includes(
      parsed.schemaVersion as
        | typeof EPUB_EXPORT_LEGACY_SCHEMA_VERSION
        | typeof EPUB_EXPORT_SCHEMA_VERSION,
    ) ||
    (parsed.exportMode !== 'publication' &&
      parsed.exportMode !== 'readable-fallback') ||
    typeof parsed.identifier !== 'string' ||
    parsed.identifier.trim().length === 0 ||
    typeof parsed.publicationGrade !== 'boolean' ||
    parsed.publicationGrade !== (parsed.exportMode === 'publication') ||
    typeof parsed.sourceProvenanceIncluded !== 'boolean' ||
    new Set(parsed.canonicalNodeIds).size !== parsed.canonicalNodeIds.length ||
    !Array.isArray(parsed.excludedCanonicalNodeIds) ||
    parsed.excludedCanonicalNodeIds.some(
      (id) => typeof id !== 'string' || id.trim().length === 0,
    ) ||
    new Set(parsed.excludedCanonicalNodeIds).size !==
      parsed.excludedCanonicalNodeIds.length ||
    parsed.excludedCanonicalNodeIds.some((id) =>
      (parsed.canonicalNodeIds as string[]).includes(id as string),
    ) ||
    !Array.isArray(parsed.assets) ||
    (parsed.visualRelationships !== undefined &&
      (!Array.isArray(parsed.visualRelationships) ||
        parsed.visualRelationships.some((entry) => !isRecord(entry)))) ||
    !Number.isInteger(parsed.excludedUnresolvedVisualRelationshipCount) ||
    (parsed.excludedUnresolvedVisualRelationshipCount as number) < 0 ||
    (parsed.sourceCompleteness !== undefined &&
      !isRecord(parsed.sourceCompleteness)) ||
    (parsed.sourceReadiness !== undefined &&
      !isRecord(parsed.sourceReadiness)) ||
    (parsed.humanAdjudications !== undefined &&
      !isRecord(parsed.humanAdjudications))
  ) {
    invalidExportManifest(profiled)
  }

  if (
    parsed.sourceFormat !== undefined &&
    parsed.sourceFormat !== 'pdf' &&
    parsed.sourceFormat !== 'docx'
  ) {
    throw new Error('EPUB export manifest sourceFormat is invalid')
  }
  if (
    parsed.sourcePackageParts !== undefined &&
    (!Array.isArray(parsed.sourcePackageParts) ||
      parsed.sourcePackageParts.some(
        (part) => typeof part !== 'string' || part.length === 0,
      ))
  ) {
    throw new Error('EPUB export manifest sourcePackageParts is invalid')
  }
  if (
    parsed.sourceImporterVersion !== undefined &&
    (typeof parsed.sourceImporterVersion !== 'string' ||
      parsed.sourceImporterVersion.length === 0)
  ) {
    throw new Error('EPUB export manifest sourceImporterVersion is invalid')
  }
  if (
    (parsed.sourceFormat === 'pdf' &&
      (parsed.sourcePdfSha256 === undefined ||
        parsed.sourceDocxSha256 !== undefined ||
        parsed.sourcePackageParts !== undefined ||
        parsed.sourceImporterVersion !== undefined)) ||
    (parsed.sourceFormat === 'docx' &&
      (parsed.sourceDocxSha256 === undefined ||
        parsed.sourcePdfSha256 !== undefined ||
        !parsed.sourcePackageParts ||
        parsed.sourceImporterVersion === undefined)) ||
    (parsed.sourceFormat === undefined &&
      (parsed.sourcePdfSha256 !== undefined ||
        parsed.sourceDocxSha256 !== undefined ||
        parsed.sourcePackageParts !== undefined ||
        parsed.sourceImporterVersion !== undefined)) ||
    parsed.sourceProvenanceIncluded !== (parsed.sourceFormat !== undefined)
  ) {
    throw new Error('EPUB export manifest source identity contract is invalid')
  }
  validateSourceSemanticFlowBoundaryManifestReceipt(parsed)
  validateCanonicalHyphenDeletionManifestReceipt(parsed)

  let profile: ReturnType<typeof profileManifestReceipt> | undefined
  if (parsed.profile !== undefined) {
    if (!isRecord(parsed.profile) || typeof parsed.profile.id !== 'string') {
      throw new Error('EPUB profiled export manifest contract is invalid')
    }
    let currentProfile: TargetProfile
    try {
      const orientation =
        isRecord(parsed.profile.orientation) &&
        typeof parsed.profile.orientation.selected === 'string'
          ? parsed.profile.orientation.selected
          : undefined
      currentProfile = resolveTargetProfile(
        parsed.profile.id as TargetProfileId,
        orientation as TargetProfile['orientation']['selected'],
      )
    } catch {
      throw new Error('EPUB profiled export manifest contract is invalid')
    }
    profile = profileManifestReceipt(currentProfile)
    if (canonicalJson(parsed.profile) !== canonicalJson(profile)) {
      throw new Error('EPUB profiled export manifest contract is invalid')
    }
  }
  const expectedRendition =
    parsed.exportMode === 'readable-fallback'
      ? 'readable-fallback-reflowable-epub'
      : profile
        ? 'profile-tuned-reflowable-epub'
        : 'reflowable-epub'
  if (parsed.rendition !== expectedRendition) {
    invalidExportManifest(profiled)
  }
  if (
    !parsed.sourceProvenanceIncluded &&
    parsed.sourceCanonicalContentSha256 !== parsed.canonicalContentSha256
  ) {
    throw new Error(
      'EPUB export manifest sourceCanonicalContentSha256 does not match its canonical input',
    )
  }

  let modelConsultations: ModelFallbackReceipt | undefined
  if (parsed.modelConsultations !== undefined) {
    if (parsed.sourceFormat !== 'pdf' || parsed.sourcePdfSha256 === undefined) {
      throw new Error(
        'EPUB model consultation receipt is only valid for a PDF source',
      )
    }
    modelConsultations = validatedModelConsultationReceiptForExport(
      parsed.modelConsultations,
      { sourceSha256: parsed.sourcePdfSha256 },
    )
    if (
      parsed.identifier !==
      exportIdentifier(
        modelConsultations.documentId,
        parsed.canonicalContentSha256,
        parsed.exportMode,
        profile,
      )
    ) {
      throw new Error(
        'EPUB model consultation receipt documentId does not match the PDF document',
      )
    }
    requireSha256(parsed.modelConsultationsSha256, 'modelConsultationsSha256')
    if (
      parsed.modelConsultationsSha256 !==
      canonicalJsonSha256(modelConsultations)
    ) {
      throw new Error(
        'EPUB model consultation receipt binding does not match the packaged receipt',
      )
    }
  } else if (parsed.modelConsultationsSha256 !== undefined) {
    throw new Error(
      'EPUB model consultation receipt binding has no packaged receipt',
    )
  }

  return {
    ...(parsed as Omit<
      EpubExportManifestReceipt,
      'modelConsultations' | 'profile'
    >),
    ...(modelConsultations ? { modelConsultations } : {}),
    ...(profile ? { profile } : {}),
  }
}

function canonicalPaperSha256(paper: ResearchPaper) {
  return sha256HexSync(strToU8(JSON.stringify(paper)))
}

function exportIdentifier(
  paperId: string,
  canonicalContentSha256: string,
  mode: EpubExportMode,
  profile?: {
    id: string
    version: string
    orientation?: { selected: string }
  },
) {
  return `urn:srt:${stableId(paperId)}:${canonicalContentSha256.slice(0, 24)}:${mode}${profile ? `:${profile.id}:${profile.version}:${profile.orientation?.selected ?? 'portrait'}:${EPUB_EXPORT_POLICY_VERSION}` : ''}`
}

function inspectAssetReceipts(
  manifest: { assets?: unknown[] },
  opf: ReturnType<typeof inspectOpfPackage>,
  files: Record<string, Uint8Array>,
) {
  if (!Array.isArray(manifest.assets)) {
    throw new Error('EPUB export manifest is missing its asset receipt list')
  }
  const assets = manifest.assets.map((value) => {
    if (!value || typeof value !== 'object') {
      throw new Error('EPUB export manifest has an invalid asset receipt')
    }
    const candidate = value as Record<string, unknown>
    const asset = {
      id: typeof candidate.id === 'string' ? candidate.id : '',
      href: typeof candidate.href === 'string' ? candidate.href : '',
      mediaType:
        typeof candidate.mediaType === 'string' ? candidate.mediaType : '',
      sha256: typeof candidate.sha256 === 'string' ? candidate.sha256 : '',
    }
    if (
      !asset.id ||
      !asset.href ||
      !asset.mediaType ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)
    ) {
      throw new Error(
        'EPUB export manifest has incomplete asset integrity data',
      )
    }
    return asset
  })
  if (new Set(assets.map(({ id }) => id)).size !== assets.length) {
    throw new Error('EPUB export manifest contains a duplicate asset id')
  }
  if (new Set(assets.map(({ href }) => href)).size !== assets.length) {
    throw new Error('EPUB export manifest contains a duplicate asset href')
  }
  for (const asset of assets) {
    const item = opf.byHref.get(asset.href)
    if (!item || item.id !== stableId(asset.id)) {
      throw new Error(`EPUB asset ${asset.href} is not bound to its OPF item`)
    }
    if (item.mediaType !== asset.mediaType) {
      throw new Error(`EPUB asset ${asset.href} media type does not match OPF`)
    }
    const bytes = files[`EPUB/${asset.href}`]
    if (!bytes) throw new Error(`EPUB is missing declared asset ${asset.href}`)
    if (sha256HexSync(bytes) !== asset.sha256) {
      throw new Error(
        `EPUB asset ${asset.href} SHA-256 does not match its bytes`,
      )
    }
    validateAssetMedia(bytes, asset.mediaType, asset.href)
  }
  const coreHrefs = new Set([
    'nav.xhtml',
    'content.xhtml',
    'styles.css',
    'export.json',
  ])
  const received = new Set(assets.map(({ href }) => href))
  for (const item of opf.items) {
    if (!coreHrefs.has(item.href) && !received.has(item.href)) {
      throw new Error(`EPUB OPF asset ${item.href} has no integrity receipt`)
    }
  }
}

function xhtmlIds(value: string, documentName: string) {
  const ids = xmlAttributeValues(value, 'id')
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${documentName} contains duplicate XHTML ids`)
  }
  return new Set(ids)
}

function resolvedPackageHref(currentDocument: string, reference: string) {
  if (!reference || reference.startsWith('/') || reference.includes('?')) {
    return null
  }
  const base = currentDocument.split('/')
  base.pop()
  const segments = reference ? [...base, ...reference.split('/')] : base
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '.') continue
    if (segment === '..') {
      if (resolved.length === 0) return null
      resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  return resolved.join('/')
}

function validateInternalHrefs(
  documents: ReadonlyMap<string, { value: string; ids: ReadonlySet<string> }>,
  declaredHrefs: ReadonlySet<string>,
) {
  for (const [documentHref, document] of documents) {
    for (const href of xmlAttributeValues(document.value, 'href')) {
      const scheme = href.match(/^([A-Za-z][A-Za-z0-9+.-]*):/)?.[1]
      if (scheme) {
        if (!['http', 'https', 'mailto'].includes(scheme.toLocaleLowerCase())) {
          throw new Error(
            `EPUB ${documentHref} has unsafe href scheme in ${href}`,
          )
        }
        continue
      }
      if (href.startsWith('//')) {
        throw new Error(`EPUB ${documentHref} has unsafe href ${href}`)
      }
      const hashIndex = href.indexOf('#')
      const documentReference =
        hashIndex === -1 ? href : href.slice(0, hashIndex)
      const fragment = hashIndex === -1 ? null : href.slice(hashIndex + 1)
      const targetDocument = documentReference
        ? resolvedPackageHref(documentHref, documentReference)
        : documentHref
      if (
        !targetDocument ||
        (!declaredHrefs.has(targetDocument) && !documents.has(targetDocument))
      ) {
        throw new Error(
          `EPUB ${documentHref} has dangling internal reference ${href}`,
        )
      }
      if (fragment !== null) {
        const target = documents.get(targetDocument)
        if (!fragment || !target?.ids.has(fragment)) {
          throw new Error(
            `EPUB ${documentHref} has dangling internal reference ${href}`,
          )
        }
      }
    }
  }
}

export function readerFacingDebugMarkers(xhtml: string) {
  const visibleText = xhtml
    .replace(/<(?:style|script)\b[\s\S]*?<\/(?:style|script)>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos);/giu, ' ')
    .replace(/\s+/gu, ' ')
  const markers: string[] = []
  const detect = (label: string, pattern: RegExp, value = visibleText) => {
    if (pattern.test(value)) markers.push(label)
  }
  detect(
    'synthetic display-equation identifier',
    /\bDisplay equation p\d{3}-\d{3}\b/iu,
  )
  detect('raw extraction identifier', /\bp\d{3}-\d{3}\b/iu)
  detect(
    'recovered OCR fallback notice',
    /\bRecovered (?:table )?(?:source )?(?:text|lines)\b/iu,
  )
  detect(
    'unresolved semantics notice',
    /\b(?:semantic(?:s)? remain unresolved|semantic transcript unresolved|semantic line order remains unresolved|source crop unavailable|unresolved visual|missing equation)\b/iu,
  )
  detect(
    'unresolved alt-source marker',
    /\bdata-alt-source\s*=\s*["']unresolved["']/iu,
    xhtml,
  )
  detect(
    'unresolved transcript markup',
    /\bdata-transcript-status\s*=\s*["']unresolved["']/iu,
    xhtml,
  )
  detect(
    'placeholder visual markup',
    /\b(?:figure-placeholder|omitted-visual(?:-transcript|-caption)?|omitted-table-transcript)\b/iu,
    xhtml,
  )
  return [...new Set(markers)]
}

/**
 * Validates EPUB structure and internal receipt consistency. Supply an
 * `expectation` to bind the artifact to trusted canonical/source inputs;
 * without one, this is structural validation rather than authenticity proof.
 */
export function inspectEpub(
  bytes: Uint8Array,
  expectedProfile?: TargetProfile,
  expectation: EpubInspectionExpectation = {},
) {
  if (
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  ) {
    throw new Error('EPUB does not begin with a ZIP local-file header')
  }
  const compressionMethod = bytes[8] | (bytes[9] << 8)
  const fileNameLength = bytes[26] | (bytes[27] << 8)
  const firstName = strFromU8(bytes.subarray(30, 30 + fileNameLength))
  if (firstName !== 'mimetype' || compressionMethod !== 0) {
    throw new Error('EPUB mimetype must be the first uncompressed ZIP entry')
  }
  const files = unzipSync(bytes)
  const required = [
    'mimetype',
    'META-INF/container.xml',
    'EPUB/package.opf',
    'EPUB/nav.xhtml',
    'EPUB/content.xhtml',
    'EPUB/styles.css',
    'EPUB/export.json',
  ]
  for (const name of required) {
    if (!files[name]) throw new Error(`EPUB is missing ${name}`)
  }
  if (strFromU8(files.mimetype) !== EPUB_MIMETYPE) {
    throw new Error('EPUB mimetype content is invalid')
  }
  const opf = strFromU8(files['EPUB/package.opf'])
  const content = strFromU8(files['EPUB/content.xhtml'])
  const navigation = strFromU8(files['EPUB/nav.xhtml'])
  requireWellFormedXml(
    strFromU8(files['META-INF/container.xml']),
    'EPUB container',
  )
  requireWellFormedXml(opf, 'EPUB OPF package')
  requireWellFormedXml(content, 'EPUB content')
  requireWellFormedXml(navigation, 'EPUB navigation')
  const opfPackage = inspectOpfPackage(opf, files)
  const xhtmlDocuments = new Map<
    string,
    { value: string; ids: ReadonlySet<string> }
  >()
  for (const item of opfPackage.items.filter(
    (candidate) => candidate.mediaType === 'application/xhtml+xml',
  )) {
    const value = strFromU8(files[`EPUB/${item.href}`])
    requireWellFormedXml(value, `EPUB ${item.href}`)
    xhtmlDocuments.set(item.href, {
      value,
      ids: xhtmlIds(value, `EPUB ${item.href}`),
    })
  }
  validateInternalHrefs(
    xhtmlDocuments,
    new Set(opfPackage.items.map((item) => item.href)),
  )
  assertSerializedXhtmlSemanticIntegrity(content, 'EPUB content')
  const manifest = parseExportManifest(
    strFromU8(files['EPUB/export.json']),
    Boolean(expectedProfile),
  )
  if (manifest.sourceFormat === 'pdf') {
    const readerFacingDebug = readerFacingDebugMarkers(content)
    if (readerFacingDebug.length > 0) {
      throw new Error(
        `EPUB reading content contains unresolved converter output: ${readerFacingDebug.join(', ')}`,
      )
    }
  }
  if (
    expectedProfile &&
    canonicalJson(manifest.profile) !==
      canonicalJson(profileManifestReceipt(expectedProfile))
  ) {
    throw new Error('EPUB profiled export manifest contract is invalid')
  }
  const canonicalNodeIds = manifest.canonicalNodeIds

  const opfIdentifiers = xmlTextElements(opf, 'dc:identifier')
  if (
    opfIdentifiers.length !== 1 ||
    opfIdentifiers[0].attributes.get('id') !== 'publication-id' ||
    !/<package\b[^>]*\bunique-identifier\s*=\s*(?:"publication-id"|'publication-id')/.test(
      opf,
    ) ||
    opfIdentifiers[0].escapedText !== text(manifest.identifier)
  ) {
    throw new Error(
      'EPUB export manifest identifier does not match the OPF dc:identifier',
    )
  }
  const opfTitles = xmlTextElements(opf, 'dc:title')
  const contentTitles = xmlTextElements(content, 'title')
  if (
    opfTitles.length !== 1 ||
    contentTitles.length !== 1 ||
    opfTitles[0].escapedText !== contentTitles[0].escapedText
  ) {
    throw new Error('EPUB XHTML title does not match the OPF title')
  }

  if (expectation.canonicalPaper) {
    const expectedCanonicalHash = canonicalPaperSha256(
      expectation.canonicalPaper,
    )
    if (manifest.canonicalContentSha256 !== expectedCanonicalHash) {
      throw new Error(
        'EPUB export manifest canonicalContentSha256 does not match its canonical input',
      )
    }
    if (
      manifest.modelConsultations !== undefined &&
      manifest.modelConsultations.documentId !== expectation.canonicalPaper.id
    ) {
      throw new Error(
        'EPUB model consultation receipt documentId does not match the PDF document',
      )
    }
    if (opfTitles[0].escapedText !== text(expectation.canonicalPaper.title)) {
      throw new Error(
        'EPUB OPF and XHTML title do not match the canonical paper title',
      )
    }
    const expectedIdentifier = exportIdentifier(
      expectation.canonicalPaper.id,
      expectedCanonicalHash,
      manifest.exportMode,
      manifest.profile,
    )
    if (manifest.identifier !== expectedIdentifier) {
      throw new Error(
        'EPUB export manifest identifier does not match its canonical input',
      )
    }
  } else {
    const profileSuffix = manifest.profile
      ? `:${manifest.profile.id}:${manifest.profile.version}:${manifest.profile.orientation.selected}:${EPUB_EXPORT_POLICY_VERSION}`
      : ''
    const receiptPattern = new RegExp(
      `^urn:srt:[A-Za-z_][A-Za-z0-9_.:-]*:${manifest.canonicalContentSha256.slice(0, 24)}:${manifest.exportMode}${profileSuffix}$`,
    )
    if (!receiptPattern.test(manifest.identifier)) {
      throw new Error(
        'EPUB export manifest identifier does not match its canonical hash and rendition',
      )
    }
  }
  if (expectation.sourceCanonicalPaper) {
    const expectedSourceCanonicalHash = canonicalPaperSha256(
      expectation.sourceCanonicalPaper,
    )
    if (manifest.sourceCanonicalContentSha256 !== expectedSourceCanonicalHash) {
      throw new Error(
        'EPUB export manifest sourceCanonicalContentSha256 does not match its canonical input',
      )
    }
  }
  if (expectation.sourcePdfSha256 !== undefined) {
    requireSha256(expectation.sourcePdfSha256, 'expected sourcePdfSha256')
    if (manifest.sourcePdfSha256 !== expectation.sourcePdfSha256) {
      throw new Error(
        'EPUB export manifest sourcePdfSha256 does not match the expected source',
      )
    }
  }
  if (expectation.sourceSemanticFlowBoundaryLedgerSha256 !== undefined) {
    requireSha256(
      expectation.sourceSemanticFlowBoundaryLedgerSha256,
      'expected sourceSemanticFlowBoundaryLedgerSha256',
    )
    if (
      manifest.sourceSemanticFlowBoundaryLedgerSha256 !==
      expectation.sourceSemanticFlowBoundaryLedgerSha256
    ) {
      throw new Error(
        'EPUB export manifest sourceSemanticFlowBoundaryLedgerSha256 does not match the expected PDF ledger',
      )
    }
  }
  if (expectation.canonicalHyphenDeletionLedgerSha256 !== undefined) {
    requireSha256(
      expectation.canonicalHyphenDeletionLedgerSha256,
      'expected canonicalHyphenDeletionLedgerSha256',
    )
    if (
      manifest.canonicalHyphenDeletionLedgerSha256 !==
      expectation.canonicalHyphenDeletionLedgerSha256
    ) {
      throw new Error(
        'EPUB export manifest canonicalHyphenDeletionLedgerSha256 does not match the expected PDF ledger',
      )
    }
  }
  const declaredHrefs = new Set(opfPackage.items.map(({ href }) => href))
  for (const attributeName of ['src', 'data']) {
    for (const href of xmlAttributeValues(content, attributeName)) {
      if (!declaredHrefs.has(href) || !files[`EPUB/${href}`]) {
        throw new Error(`EPUB content has dangling asset reference ${href}`)
      }
    }
  }
  const canonicalIds = [
    ...content.matchAll(/data-canonical-id="([^"]+)"/g),
  ].map((match) => match[1])
  const expectedIds = canonicalNodeIds.map(stableId)
  if (
    new Set(canonicalIds).size !== canonicalIds.length ||
    JSON.stringify(canonicalIds) !== JSON.stringify(expectedIds)
  ) {
    throw new Error(
      'EPUB canonical nodes must appear exactly once in source order',
    )
  }
  for (const match of content.matchAll(/data-caption-id="([^"]+)"/g)) {
    if (!canonicalIds.includes(match[1])) {
      throw new Error(`EPUB figure has dangling caption ${match[1]}`)
    }
  }
  if (
    expectedProfile &&
    strFromU8(files['EPUB/styles.css']) !== profileEpubCss(expectedProfile)
  ) {
    throw new Error(`EPUB styles do not match profile ${expectedProfile.id}`)
  }
  inspectAssetReceipts(manifest, opfPackage, files)
  return {
    files,
    entries: Object.keys(files),
    manifest,
  }
}

export function buildEpub(document: StructDocument): Promise<EpubExport>
export function buildEpub(
  paper: ResearchPaper,
  profile: TargetProfile,
): Promise<EpubExport>
export function buildEpub(
  paper: ResearchPaper,
  reconstruction?: DocumentReconstruction,
  profile?: TargetProfile,
): Promise<EpubExport>
export async function buildEpub(
  paper: ResearchPaper | StructDocument,
  reconstructionOrProfile?: DocumentReconstruction | TargetProfile,
  profileInput?: TargetProfile,
): Promise<EpubExport> {
  if (isStructDocument(paper)) {
    return buildStructEpub(paper)
  }
  return buildEpubInternal(
    paper,
    reconstructionOrProfile,
    profileInput,
    'publication',
  )
}

export function buildReadableEpub(
  paper: ResearchPaper,
  reconstruction: PdfReconstruction,
  profile?: TargetProfile,
): Promise<EpubExport> {
  return buildEpubInternal(paper, reconstruction, profile, 'readable-fallback')
}

function epubFileName(
  paper: ResearchPaper,
  profile: TargetProfile | undefined,
  mode: EpubExportMode,
  canonicalContentSha256: string,
) {
  const profileName = slug(
    profile ? profile.id.replace(/([a-z0-9])([A-Z])/g, '$1-$2') : 'reflowable',
  )
  const orientationSuffix =
    profile?.orientation.selected === 'landscape' ? '-landscape' : ''
  const modeSuffix = mode === 'readable-fallback' ? '-readable' : ''
  return `${slug(paper.title)}-${profileName}${orientationSuffix}-${canonicalContentSha256.slice(0, 12)}${modeSuffix}.epub`
}

function yieldToEpubAssembly() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

async function buildEpubInternal(
  paper: ResearchPaper,
  reconstructionOrProfile: DocumentReconstruction | TargetProfile | undefined,
  profileInput: TargetProfile | undefined,
  mode: EpubExportMode,
): Promise<EpubExport> {
  assertUniqueCanonicalNodeIds(paper)
  const secondIsProfile =
    reconstructionOrProfile !== undefined &&
    targetProfileSchema.safeParse(reconstructionOrProfile).success
  const reconstruction = secondIsProfile
    ? undefined
    : (reconstructionOrProfile as DocumentReconstruction | undefined)
  const profileCandidate = secondIsProfile
    ? reconstructionOrProfile
    : profileInput
  const profile = profileCandidate
    ? targetProfileSchema.parse(profileCandidate)
    : undefined
  if (
    profile &&
    JSON.stringify(profile) !==
      JSON.stringify(
        resolveTargetProfile(profile.id, profile.orientation.selected),
      )
  ) {
    throw new Error(
      `EPUB target profile ${profile.id} must come from src/research/targets.ts`,
    )
  }
  if (
    reconstruction &&
    !reconstruction.readiness.ready &&
    (mode === 'publication' || isDocxReconstruction(reconstruction))
  ) {
    const message = `EPUB export is blocked until these completeness diagnostics are cleared: ${reconstruction.readiness.blockingDiagnosticCodes.join(', ')}.`
    throw isDocxReconstruction(reconstruction)
      ? new DocxImportError('INCOMPLETE_RECONSTRUCTION', message)
      : new PdfImportError('INCOMPLETE_RECONSTRUCTION', message)
  }
  const renderReconstruction =
    reconstruction && mode === 'readable-fallback'
      ? projectReadableFallbackReconstruction(
          reconstruction as PdfReconstruction,
        )
      : reconstruction
  const renderPaper =
    mode === 'readable-fallback' && renderReconstruction
      ? renderReconstruction.paper
      : paper
  const modelConsultations =
    reconstruction &&
    !isDocxReconstruction(reconstruction) &&
    reconstruction.modelConsultations !== undefined
      ? validatedModelConsultationReceiptForExport(
          reconstruction.modelConsultations,
          {
            documentId: renderPaper.id,
            sourceSha256: reconstruction.source.sha256,
          },
        )
      : undefined
  if (
    modelConsultations &&
    reconstruction &&
    !isDocxReconstruction(reconstruction) &&
    !modelConsultationReceiptMatchesPdfReconstruction(
      reconstruction,
      modelConsultations,
    )
  ) {
    throw new Error(
      'EPUB model consultation receipt does not match the PDF semantic state',
    )
  }
  let publicationPdfAssessment:
    ReturnType<typeof assessPdfCompleteness> | undefined
  assertUniqueCanonicalNodeIds(renderPaper)
  const preflightVisualRelationships = new Map(
    (renderReconstruction?.visualRelationships ?? [])
      .filter((relationship) => relationship.canonicalNodeId)
      .map((relationship) => [relationship.canonicalNodeId!, relationship]),
  )
  const preflightAssets = new Map(
    (renderReconstruction?.assets ?? []).map((asset) => [asset.id, asset]),
  )
  assertPublicationIntegrity(
    renderPaper,
    renderReconstruction?.noteRelationships,
    noteRelationshipSourceEvidence(renderReconstruction),
    {
      renderedSemanticTableNodeIds: renderedSemanticTableNodeIdsForPublication({
        paper: renderPaper,
        visualRelationships: preflightVisualRelationships,
        assets: preflightAssets,
      }),
    },
  )
  // Validating the receipt only when one is present makes dropping it the way
  // to launder provenance: STRUCT refuses such a document, but this export
  // exit published it, so the guarantee held on only one of the two. Checked
  // after the structural assertions above so a malformed document still
  // reports what is actually wrong with it.
  if (
    reconstruction &&
    !isDocxReconstruction(reconstruction) &&
    reconstruction.modelConsultations === undefined &&
    pdfModelDerivedDecisionKeys(reconstruction).size > 0
  ) {
    throw new Error('MISSING_MODEL_CONSULTATION_RECEIPT')
  }
  if (renderReconstruction) {
    const validatedPdfRelationshipIds = isDocxReconstruction(
      renderReconstruction,
    )
      ? null
      : new Set(
          validatedPdfVisualRelationships({
            paper: renderPaper,
            provenance: renderReconstruction.provenance,
            relationships: renderReconstruction.visualRelationships,
            assets: renderReconstruction.assets,
            regions: (renderReconstruction as PdfReconstruction).regions,
            pages: (renderReconstruction as PdfReconstruction).pages,
          }).map((relationship) => relationship.id),
        )
    const assetIds = new Set(
      renderReconstruction.assets.map((asset) => asset.id),
    )
    const renderNodeIds = new Set(renderPaper.nodes.map((node) => node.id))
    const invalid = renderReconstruction.visualRelationships.find(
      (relationship) => {
        if (relationship.status === 'matched') {
          if (validatedPdfRelationshipIds) {
            if (!validatedPdfRelationshipIds.has(relationship.id)) return true
            return (
              mode === 'publication' &&
              relationship.kind === 'equation' &&
              !hasResolvedEquationTranscript(
                relationship,
                (renderReconstruction as PdfReconstruction).regions,
                (renderReconstruction as PdfReconstruction).pages,
                {
                  paper: renderPaper,
                  pages: (renderReconstruction as PdfReconstruction).pages,
                  regions: (renderReconstruction as PdfReconstruction).regions,
                  visualRelationships: (
                    renderReconstruction as PdfReconstruction
                  ).visualRelationships,
                  assets: (renderReconstruction as PdfReconstruction).assets,
                },
              )
            )
          }
          return (
            !relationship.canonicalNodeId ||
            relationship.assetIds.length === 0 ||
            relationship.assetIds.some((assetId) => !assetIds.has(assetId))
          )
        }
        if (mode !== 'readable-fallback') return true
        const sourcePreservedFallback =
          relationship.canonicalNodeId !== null &&
          relationship.assetIds.length > 0 &&
          relationship.assetIds.length <=
            MAX_READABLE_FALLBACK_ASSETS_PER_VISUAL &&
          relationship.assetIds.every((assetId) => assetIds.has(assetId)) &&
          renderNodeIds.has(relationship.canonicalNodeId)
        const captionOnlyFallback =
          relationship.canonicalNodeId === null &&
          relationship.assetIds.length === 0 &&
          relationship.captionNodeId &&
          renderNodeIds.has(relationship.captionNodeId)
        return !(sourcePreservedFallback || captionOnlyFallback)
      },
    )
    if (invalid) {
      const message = `EPUB export is blocked by visual relationship ${invalid.id}.`
      throw isDocxReconstruction(renderReconstruction)
        ? new DocxImportError('INCOMPLETE_RECONSTRUCTION', message)
        : new PdfImportError('INCOMPLETE_RECONSTRUCTION', message)
    }
  }
  if (
    reconstruction &&
    !isDocxReconstruction(reconstruction) &&
    mode === 'publication'
  ) {
    if (!hasCompletePdfAssessmentEvidence(reconstruction)) {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        'EPUB publication export requires complete PDF source, layout, provenance, relationship, and completeness evidence.',
      )
    }
    const hyperlinkLedger = validatePdfHyperlinkEvidence({
      reconstruction,
      paper: renderPaper,
    })
    validatePdfCrossReferenceEvidence({
      reconstruction,
      paper: renderPaper,
    })
    const assessment = assessPdfCompleteness({
      pages: reconstruction.pages,
      paper: renderPaper,
      diagnostics: reconstruction.diagnostics,
      readingOrder: reconstruction.readingOrder,
      regions: reconstruction.regions,
      visualRelationships: reconstruction.visualRelationships,
      assets: reconstruction.assets,
      citationRelationships: reconstruction.citationRelationships,
      noteRelationships: reconstruction.noteRelationships,
      policy: reconstruction.readiness.policy,
      lineBoundaryDecisions: reconstruction.lineBoundaryDecisions,
      sourceSemanticFlowBoundaryDecisions:
        reconstruction.sourceSemanticFlowBoundaryDecisions,
      sourceSemanticFlowBoundaryDecisionCount:
        reconstruction.sourceSemanticFlowBoundaryDecisionCount,
      canonicalHyphenBoundaryDecisions:
        reconstruction.canonicalHyphenBoundaryDecisions,
      canonicalHyphenBoundaryDecisionCount:
        reconstruction.canonicalHyphenBoundaryDecisionCount,
      unresolvedCorruptingJoinCount:
        reconstruction.unresolvedCorruptingJoinCount,
      structurallyConsumedLineBoundaryCount:
        reconstruction.structurallyConsumedLineBoundaryCount,
      provenance: reconstruction.provenance,
      inlineSpanLedger: {
        expected: reconstruction.completeness.expectedInlineSpanCount,
        mapped: reconstruction.completeness.mappedInlineSpanCount,
      },
      hyperlinkLedger: {
        expected: hyperlinkLedger.expected,
        mapped: hyperlinkLedger.mapped,
      },
      sourceSha256: reconstruction.source.sha256,
    })
    if (!assessment.readiness.ready) {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        `EPUB export-time reconstruction validation failed: ${assessment.readiness.blockingDiagnosticCodes.join(', ')}.`,
      )
    }
    publicationPdfAssessment = assessment
  }
  await yieldToEpubAssembly()
  const sourceAssets = renderReconstruction?.assets ?? []
  const sourceAssetUsage = epubAssetResourceUsage(sourceAssets)
  if (
    sourceAssetUsage.count > MAX_EPUB_ASSETS_PER_BOOK ||
    sourceAssetUsage.bytes > MAX_EPUB_ASSET_BYTES_PER_BOOK
  ) {
    const message = epubAssetResourceLimitMessage({
      assetCount: sourceAssetUsage.count,
      assetBytes: sourceAssetUsage.bytes,
    })
    throw renderReconstruction && isDocxReconstruction(renderReconstruction)
      ? new DocxImportError('INCOMPLETE_RECONSTRUCTION', message)
      : new PdfImportError('INCOMPLETE_RECONSTRUCTION', message)
  }
  const packaged = await packageVisualAssets(sourceAssets, profile)
  await yieldToEpubAssembly()
  const visualAssets = uniqueAssets(packaged)
  const unsafeAsset = visualAssets.find(
    (asset) => !/^assets\/[A-Za-z0-9_.-]+$/.test(asset.href),
  )
  if (unsafeAsset) {
    throw new Error(`EPUB asset has an unsafe href: ${unsafeAsset.id}`)
  }
  const packagedBySourceId = new Map(
    packaged.map(({ source, asset }) => [source.id, asset]),
  )
  const packagedRelationships = renderReconstruction?.visualRelationships.map(
    (relationship) => ({
      ...relationship,
      assetIds: relationship.assetIds.map(
        (assetId) => packagedBySourceId.get(assetId)?.id ?? assetId,
      ),
    }),
  )
  const canonicalHash = await sha256(JSON.stringify(renderPaper))
  const sourceCanonicalHash = await sha256(
    JSON.stringify(reconstruction?.paper ?? paper),
  )
  const identifier = exportIdentifier(
    renderPaper.id,
    canonicalHash,
    mode,
    profile,
  )
  const modified = epubArtifactModifiedAt(renderPaper)
  const exportProfileMetadata = profile
    ? getEpubProfileMetadata(profile)
    : undefined
  const canonicalHyphenDeletionReceipt =
    reconstruction && !isDocxReconstruction(reconstruction)
      ? canonicalHyphenDeletionManifestReceipt(reconstruction)
      : undefined
  const sourceSemanticFlowBoundaryReceipt =
    reconstruction && !isDocxReconstruction(reconstruction)
      ? sourceSemanticFlowBoundaryManifestReceipt(reconstruction)
      : undefined
  const exportManifest = {
    schemaVersion: EPUB_EXPORT_SCHEMA_VERSION,
    identifier,
    exportMode: mode,
    publicationGrade: mode === 'publication',
    canonicalContentSha256: canonicalHash,
    sourceCanonicalContentSha256: sourceCanonicalHash,
    sourcePdfSha256:
      reconstruction && !isDocxReconstruction(reconstruction)
        ? reconstruction.source.sha256
        : undefined,
    sourceDocxSha256:
      reconstruction && isDocxReconstruction(reconstruction)
        ? reconstruction.source.sha256
        : undefined,
    sourceFormat:
      reconstruction && isDocxReconstruction(reconstruction)
        ? reconstruction.source.format
        : reconstruction
          ? 'pdf'
          : undefined,
    sourcePackageParts:
      reconstruction && isDocxReconstruction(reconstruction)
        ? reconstruction.source.packageParts
        : undefined,
    sourceImporterVersion:
      reconstruction && isDocxReconstruction(reconstruction)
        ? reconstruction.source.importerVersion
        : undefined,
    canonicalNodeIds: renderPaper.nodes.map((node) => node.id),
    excludedCanonicalNodeIds: (reconstruction?.paper.nodes ?? paper.nodes)
      .filter(
        (node) =>
          !renderPaper.nodes.some((candidate) => candidate.id === node.id),
      )
      .map((node) => node.id),
    sourceProvenanceIncluded: Boolean(reconstruction),
    sourceCompleteness:
      publicationPdfAssessment?.completeness ?? reconstruction?.completeness,
    sourceReadiness:
      publicationPdfAssessment?.readiness ?? reconstruction?.readiness,
    humanAdjudications:
      reconstruction && !isDocxReconstruction(reconstruction)
        ? manifestHumanAdjudications(reconstruction)
        : undefined,
    modelConsultations,
    modelConsultationsSha256: modelConsultations
      ? canonicalJsonSha256(modelConsultations)
      : undefined,
    ...sourceSemanticFlowBoundaryReceipt,
    ...canonicalHyphenDeletionReceipt,
    assets: packaged.map(({ source, asset, policy }) => {
      const { bytes: _bytes, ...metadata } = asset
      return { ...metadata, sourceAssetId: source.id, policy }
    }),
    visualRelationships: packagedRelationships,
    excludedUnresolvedVisualRelationshipCount:
      reconstruction && renderReconstruction
        ? reconstruction.visualRelationships.filter(
            (relationship) =>
              !renderReconstruction.visualRelationships.some(
                (candidate) => candidate.id === relationship.id,
              ),
          ).length
        : 0,
    profile: profile ? profileManifestReceipt(profile) : undefined,
    rendition:
      mode === 'readable-fallback'
        ? 'readable-fallback-reflowable-epub'
        : profile
          ? 'profile-tuned-reflowable-epub'
          : 'reflowable-epub',
  }
  const styles = profile ? profileEpubCss(profile) : EPUB_CSS
  const archive: Zippable = {
    mimetype: entry(EPUB_MIMETYPE, 0),
    'META-INF/container.xml': entry(containerXml()),
    'EPUB/package.opf': entry(
      packageOpf(renderPaper, identifier, modified, visualAssets, profile),
    ),
    'EPUB/nav.xhtml': entry(navXhtml(renderPaper)),
    'EPUB/content.xhtml': entry(
      renderPublicationXhtml(renderPaper, {
        reconstruction: renderReconstruction,
        visualAssets: packagedBySourceId,
      }),
    ),
    'EPUB/styles.css': entry(styles),
    'EPUB/export.json': entry(`${JSON.stringify(exportManifest, null, 2)}\n`),
    ...Object.fromEntries(
      visualAssets.map((visualAsset) => [
        `EPUB/${visualAsset.href}`,
        binaryEntry(visualAsset.bytes),
      ]),
    ),
  }
  await yieldToEpubAssembly()
  const bytes = zipSync(archive)
  await yieldToEpubAssembly()
  const { files, entries } = inspectEpub(bytes, profile, {
    canonicalPaper: renderPaper,
    sourceCanonicalPaper: reconstruction?.paper ?? paper,
    sourcePdfSha256:
      reconstruction && !isDocxReconstruction(reconstruction)
        ? reconstruction.source.sha256
        : undefined,
    canonicalHyphenDeletionLedgerSha256:
      canonicalHyphenDeletionReceipt?.canonicalHyphenDeletionLedgerSha256,
  })
  await yieldToEpubAssembly()
  if (renderReconstruction) {
    const content = strFromU8(files['EPUB/content.xhtml'])
    const opf = strFromU8(files['EPUB/package.opf'])
    if (/figure-placeholder|placeholder only/i.test(content)) {
      throw new Error('Imported EPUB contains placeholder visual markup')
    }
    for (const visualAsset of visualAssets) {
      if (!files[`EPUB/${visualAsset.href}`]) {
        throw new Error(`EPUB is missing selected asset ${visualAsset.href}`)
      }
      if (!opf.includes(`href="${visualAsset.href}"`)) {
        throw new Error(
          `EPUB manifest omits selected asset ${visualAsset.href}`,
        )
      }
    }
    for (const match of content.matchAll(/(?:src|data)="(assets\/[^"]+)"/g)) {
      if (!files[`EPUB/${match[1]}`]) {
        throw new Error(`EPUB content has dangling asset reference ${match[1]}`)
      }
    }
  }
  return {
    bytes,
    fileName: epubFileName(renderPaper, profile, mode, canonicalHash),
    mediaType: EPUB_MIMETYPE,
    sha256: await sha256(bytes),
    identifier,
    entries,
    mode,
    profile: exportProfileMetadata,
  }
}

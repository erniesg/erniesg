import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { buildStructEpub } from '../struct/epub'
import {
  renderPublicationXhtml as renderStructPublicationXhtml,
  type StructXhtmlOptions,
} from '../struct/xhtml'
import type { StructDocument } from '../struct/types'
import {
  DocxImportError,
  PdfImportError,
  type DocumentReconstruction,
  type DocxReconstruction,
  type PdfLinkAnnotation,
  type PdfReconstruction,
  type PublicationAsset,
  type PublicationVisualRelationship,
} from './import-types'
import {
  EPUB_CSS,
  EPUB_EXPORT_POLICY_VERSION,
  EPUB_MIMETYPE,
  binaryEntry,
  containerXml,
  entry,
  epubArtifactModifiedAt,
  isCompactScrollableTableImage,
  navXhtml,
  packageOpf,
  packageVisualAssets,
  profileEpubCss,
  uniqueAssets,
  xhtmlLanguageAttributes,
  type EpubExportMode,
} from './epub-package-presentation'
export { EPUB_EXPORT_POLICY_VERSION, profileEpubCss }
export type { EpubExportMode }
import {
  MAX_READABLE_FALLBACK_ASSETS_PER_VISUAL,
  MAX_READABLE_FALLBACK_EQUATIONS_PER_BOOK,
  MAX_READABLE_FALLBACK_OPTIONAL_ASSETS_PER_BOOK,
  duplicateVisualRelationshipNodeOwnership,
  epubAssetResourceLimitMessage,
  epubAssetResourceUsage,
  projectReadableFallbackReconstruction,
} from './epub-readable-fallback'
export {
  MAX_READABLE_FALLBACK_EQUATIONS_PER_BOOK,
  projectReadableFallbackReconstruction,
}
import {
  isSourceProvedUnresolvedPartialParentTable,
  validatePdfCrossReferenceEvidence,
} from './epub-cross-reference-evidence'
import {
  assertSerializedXhtmlSemanticIntegrity,
  inspectAssetReceipts,
  inspectOpfPackage,
  requireWellFormedXml,
  validateInternalHrefs,
  xhtmlIds,
  xmlAttributeValues,
  xmlTextElements,
} from './epub-inspection-helpers'
import {
  canonicalHyphenDeletionManifestReceipt,
  canonicalJson,
  canonicalJsonSha256,
  EPUB_EXPORT_LEGACY_SCHEMA_VERSION,
  EPUB_EXPORT_SCHEMA_VERSION,
  isRecord,
  isSha256,
  manifestHumanAdjudications,
  sha256Sync,
  sourceSemanticFlowBoundaryManifestReceipt,
  validateCanonicalHyphenDeletionManifestReceipt,
  validateSourceSemanticFlowBoundaryManifestReceipt,
} from './epub-manifest-evidence'
import {
  attribute,
  comparableText,
  normalizedCrossReferenceIdentity,
  normalizedEpubHref,
  normalizedNumericIdentity,
  renderTextWithNoteReferences,
  stableId,
  text,
  validNoteReferences,
  type CanonicalSemanticTarget,
} from './epub-semantic-text'
import {
  validateModelConsultationReceipt,
  type ModelFallbackReceipt,
} from './model-fallback'
import {
  modelConsultationReceiptMatchesPdfReconstruction,
  pdfModelDerivedDecisionKeys,
} from './model-fallback-pipeline'
import {
  renderSourceGeometryScriptMathMl,
  verifyRelationshipSourceGeometryScriptTranscript,
} from './equation-geometry-transcript'
import { getCompositionPolicy } from './composition'
import {
  assessPdfCompleteness,
  hasValidCanonicalHyphenBoundaryLedger,
  hasValidSourceSemanticFlowBoundaryLedgerCount,
  hasResolvedEquationTranscript,
} from './pdf-quality'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import {
  assertPublicationIntegrity,
  renderableAuthorNoteReferences,
} from './publication-integrity'
import { safePdfExternalLinkTarget } from './pdf-links'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import type { ResearchNode, ResearchPaper } from './schema'
import {
  resolveTargetProfile,
  type TargetProfile,
  type TargetProfileId,
} from './targets'
import { targetProfileSchema } from './target-schema'
import {
  MAX_EPUB_ASSET_BYTES_PER_BOOK,
  MAX_EPUB_ASSETS_PER_BOOK,
} from './publication-resource-limits'

export {
  MAX_EPUB_ASSET_BYTES_PER_BOOK,
  MAX_EPUB_ASSETS_PER_BOOK,
} from './publication-resource-limits'

function isStructDocument(
  input: StructDocument | ResearchPaper,
): input is StructDocument {
  return (
    'schemaVersion' in input &&
    (input.schemaVersion === '0.1.0' || input.schemaVersion === '0.2.0')
  )
}

function isSemanticTableAsset(asset: PublicationAsset | undefined) {
  return asset?.mediaType === 'application/xhtml+xml' && asset.kind === 'table'
}

function semanticTableAssetForRenderedNode({
  node,
  visual,
  assets,
}: {
  node: ResearchNode | undefined
  visual: PublicationVisualRelationship
  assets: ReadonlyMap<string, PublicationAsset>
}) {
  const rendersPreformattedLines =
    visual.preformatted !== undefined &&
    visual.evidence.includes('source-preformatted-block') &&
    visual.preformatted.lines.length > 0
  if (
    rendersPreformattedLines ||
    visual.kind !== 'table' ||
    node?.type !== 'figure' ||
    !node.table
  ) {
    return undefined
  }
  return visual.assetIds
    .map((assetId) => assets.get(assetId))
    .find(isSemanticTableAsset)
}

function renderedSemanticTableNodeIdsForPublication({
  paper,
  visualRelationships,
  assets,
}: {
  paper: ResearchPaper
  visualRelationships: ReadonlyMap<string, PublicationVisualRelationship>
  assets: ReadonlyMap<string, PublicationAsset>
}) {
  return new Set(
    [...visualRelationships.entries()].flatMap(([nodeId, relationship]) =>
      semanticTableAssetForRenderedNode({
        node: paper.nodes.find((node) => node.id === nodeId),
        visual: relationship,
        assets,
      })
        ? [nodeId]
        : [],
    ),
  )
}

function isDocxReconstruction(
  reconstruction: DocumentReconstruction,
): reconstruction is DocxReconstruction {
  return reconstruction.source.format === 'docx'
}

function noteRelationshipSourceEvidence(
  reconstruction: DocumentReconstruction | undefined,
) {
  if (
    !reconstruction ||
    !Array.isArray(reconstruction.noteRelationships) ||
    reconstruction.source?.format === 'docx'
  ) {
    return undefined
  }
  const pdf = reconstruction as PdfReconstruction
  return {
    regions: Array.isArray(pdf.regions) ? pdf.regions : [],
    provenance: pdf.provenance ?? {},
  }
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

type CanonicalHyperlinkOccurrence = {
  annotationId: string
  href: string | undefined
  ownerNodeId: string
  owner: string
  start: number
  end: number
  textLength: number
}

function canonicalHyperlinkOccurrences(
  paper: ResearchPaper,
): CanonicalHyperlinkOccurrence[] {
  return paper.nodes.flatMap((node) => {
    const nodeOccurrences =
      'inlineRuns' in node
        ? (node.inlineRuns ?? []).flatMap((run, runIndex) =>
            run.annotationId
              ? [
                  {
                    annotationId: run.annotationId,
                    href: run.href,
                    ownerNodeId: node.id,
                    owner: `${node.id}.inlineRuns[${runIndex}]`,
                    start: run.start,
                    end: run.end,
                    textLength:
                      node.type === 'figure'
                        ? (node.sourceText?.length ?? 0)
                        : node.text.length,
                  },
                ]
              : [],
          )
        : []
    const tableOccurrences =
      node.type === 'figure' && node.table
        ? node.table.rows.flatMap((row, rowIndex) =>
            row.cells.flatMap((cell, cellIndex) =>
              (cell.inlineRuns ?? []).flatMap((run, runIndex) =>
                run.annotationId
                  ? [
                      {
                        annotationId: run.annotationId,
                        href: run.href,
                        ownerNodeId: node.id,
                        owner: `${node.id}.table.rows[${rowIndex}].cells[${cellIndex}].inlineRuns[${runIndex}]`,
                        start: run.start,
                        end: run.end,
                        textLength: cell.text.length,
                      },
                    ]
                  : [],
              ),
            ),
          )
        : []
    return [...nodeOccurrences, ...tableOccurrences]
  })
}

function normalizedSourceLinkAnnotations(
  reconstruction: PdfReconstruction,
): PdfLinkAnnotation[] {
  return reconstruction.pages.flatMap((page) =>
    (page.links ?? []).map((annotation) => {
      if (
        !('id' in annotation) ||
        typeof annotation.id !== 'string' ||
        !('status' in annotation) ||
        annotation.status === undefined
      ) {
        throw new PdfImportError(
          'INCOMPLETE_RECONSTRUCTION',
          `PDF hyperlink evidence on page ${page.page} is not a normalized source annotation.`,
        )
      }
      if (annotation.page !== page.page) {
        throw new PdfImportError(
          'INCOMPLETE_RECONSTRUCTION',
          `PDF hyperlink evidence ${annotation.id} claims page ${annotation.page} but is stored on page ${page.page}.`,
        )
      }
      return annotation as PdfLinkAnnotation
    }),
  )
}

function validatePdfHyperlinkEvidence({
  reconstruction,
  paper,
}: {
  reconstruction: PdfReconstruction
  paper: ResearchPaper
}) {
  const annotations = normalizedSourceLinkAnnotations(reconstruction)
  const annotationIds = annotations.map((annotation) => annotation.id)
  const duplicateAnnotationId = annotationIds.find(
    (id, index) => annotationIds.indexOf(id) !== index,
  )
  if (duplicateAnnotationId) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      `PDF hyperlink evidence contains duplicate source annotation ${duplicateAnnotationId}.`,
    )
  }
  const annotationsById = new Map(
    annotations.map((annotation) => [annotation.id, annotation]),
  )
  const occurrences = canonicalHyperlinkOccurrences(paper)
  for (const occurrence of occurrences) {
    if (!occurrence.href) {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        `PDF hyperlink evidence ${occurrence.annotationId} has canonical owner ${occurrence.owner} without an href.`,
      )
    }
    if (
      occurrence.start < 0 ||
      occurrence.end <= occurrence.start ||
      occurrence.end > occurrence.textLength
    ) {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        `PDF hyperlink evidence ${occurrence.annotationId} has a non-renderable canonical range at ${occurrence.owner}.`,
      )
    }
    if (!annotationsById.has(occurrence.annotationId)) {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        `PDF hyperlink evidence ${occurrence.annotationId} at ${occurrence.owner} has no source annotation.`,
      )
    }
  }
  const occurrencesById = new Map<string, CanonicalHyperlinkOccurrence[]>()
  for (const occurrence of occurrences) {
    const owners = occurrencesById.get(occurrence.annotationId) ?? []
    owners.push(occurrence)
    occurrencesById.set(occurrence.annotationId, owners)
  }
  let mapped = 0
  const nodeIds = new Set(paper.nodes.map((node) => node.id))
  for (const annotation of annotations) {
    const owners = occurrencesById.get(annotation.id) ?? []
    if (owners.length !== 1) {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        `PDF hyperlink evidence ${annotation.id} must have exactly one canonical inline or table-cell owner; found ${owners.length}.`,
      )
    }
    const href = owners[0].href!
    if (annotation.status === 'unresolved') {
      throw new PdfImportError(
        'INCOMPLETE_RECONSTRUCTION',
        `PDF hyperlink evidence ${annotation.id} remains unresolved (${annotation.reason}).`,
      )
    }
    if (annotation.status === 'external') {
      if (
        !safePdfExternalLinkTarget(annotation.url) ||
        href !== annotation.url
      ) {
        throw new PdfImportError(
          'INCOMPLETE_RECONSTRUCTION',
          `PDF hyperlink evidence ${annotation.id} external target does not equal its canonical href.`,
        )
      }
    } else {
      const fragment = href.match(/^#([A-Za-z_][A-Za-z0-9_.:-]{0,511})$/u)?.[1]
      if (!fragment || !nodeIds.has(fragment)) {
        throw new PdfImportError(
          'INCOMPLETE_RECONSTRUCTION',
          `PDF hyperlink evidence ${annotation.id} internal fragment does not resolve to one canonical node.`,
        )
      }
    }
    mapped += 1
  }
  return { expected: annotations.length, mapped }
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

function renderAuthors(paper: ResearchPaper) {
  const authorNotes = renderableAuthorNoteReferences(paper)
  const numberedAffiliations = (paper.affiliations ?? [])
    .map((affiliation) =>
      affiliation.match(/^\s*([\d⁰¹²³⁴⁵⁶⁷⁸⁹]+)(?=\s|\p{L})/u),
    )
    .filter((match): match is RegExpMatchArray => Boolean(match))
  const sharedAuthorNoteTargets = [
    ...new Set(
      authorNotes
        .filter((reference) => paper.authors.includes(reference.author))
        .map((reference) => reference.target),
    ),
  ]
  const sharedAuthorNote =
    sharedAuthorNoteTargets.length === 1 &&
    paper.authors.every((author) =>
      authorNotes.some(
        (reference) =>
          reference.author === author &&
          reference.target === sharedAuthorNoteTargets[0],
      ),
    )
      ? paper.nodes.find(
          (node) =>
            node.type === 'footnote' && node.id === sharedAuthorNoteTargets[0],
        )
      : undefined
  const embeddedAffiliationLabels = [
    ...new Set(
      sharedAuthorNote?.type === 'footnote'
        ? (sharedAuthorNote.inlineRuns ?? [])
            .filter(
              (run) =>
                run.verticalAlign === 'superscript' &&
                /^\d{1,3}$/u.test(
                  sharedAuthorNote.text.slice(run.start, run.end).trim(),
                ),
            )
            .map((run) =>
              sharedAuthorNote.text.slice(run.start, run.end).trim(),
            )
        : [],
    ),
  ]
  const sharedAffiliationLabel =
    numberedAffiliations.length === 1
      ? numberedAffiliations[0][1]
      : embeddedAffiliationLabels.length === 1
        ? embeddedAffiliationLabels[0]
        : undefined
  return paper.authors
    .map((author) => {
      const authorAffiliationMarkers = (paper.authorAffiliations ?? [])
        .filter((reference) => reference.author === author)
        .map(
          (reference) =>
            `<sup class="author-affiliation-marker">${text(reference.label)}</sup>`,
        )
      const affiliationMarkers =
        authorAffiliationMarkers.length > 0
          ? authorAffiliationMarkers.join('')
          : sharedAffiliationLabel
            ? `<sup class="author-affiliation-marker">${text(sharedAffiliationLabel)}</sup>`
            : ''
      const references = authorNotes
        .filter((reference) => reference.author === author)
        .map(
          (reference) =>
            `<sup class="author-note-marker"><a id="${attribute(stableId(reference.id))}" href="#${attribute(stableId(reference.target))}" epub:type="noteref" role="doc-noteref">${text(reference.label)}</a></sup>`,
        )
        .join('')
      return `${text(author)}${references}${affiliationMarkers}`
    })
    .join(', ')
}

function renderAffiliations(paper: ResearchPaper) {
  return (paper.affiliations ?? [])
    .map((affiliation) => {
      const match = affiliation.match(
        /^\s*([\d⁰¹²³⁴⁵⁶⁷⁸⁹]+[*∗†‡§]?)(?=\s|\p{L})\s*(.*)$/u,
      )
      return match
        ? `<span class="affiliation"><sup class="affiliation-marker">${text(match[1])}</sup>${text(match[2])}</span>`
        : `<span class="affiliation">${text(affiliation)}</span>`
    })
    .join('<br />')
}

function renderReconstructedByline(paper: ResearchPaper) {
  return `<div class="reconstructed-byline">
      <p class="authors">${renderAuthors(paper)}</p>
      ${paper.affiliations?.length ? `<p class="affiliations">${renderAffiliations(paper)}</p>` : ''}
    </div>`
}

function assertUniqueCanonicalNodeIds(paper: ResearchPaper) {
  const ids = paper.nodes.map((node) => node.id)
  if (new Set(ids).size !== ids.length) {
    throw new Error('EPUB canonical node ids must be globally unique')
  }
}

function slug(value: string) {
  const candidate = value
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
  return candidate || 'research-publication'
}

async function sha256(value: Uint8Array | string) {
  const bytes = typeof value === 'string' ? strToU8(value) : value
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function renderSemanticTable(
  table: NonNullable<Extract<ResearchNode, { type: 'figure' }>['table']>,
  canonicalNodeId: string,
  assetId?: string,
  captionId?: string,
  accessibleLabel = 'Scrollable table',
  scholarlyTargetKinds: ReadonlyMap<
    string,
    CanonicalSemanticTarget
  > = new Map(),
) {
  const columnCount = Math.max(
    0,
    ...table.rows.map((row) =>
      row.cells.reduce((total, cell) => total + cell.columnSpan, 0),
    ),
  )
  const firstBodyRow = table.rows.findIndex(
    (row) => !row.cells.every((cell) => cell.headerScope === 'column'),
  )
  const headerRows =
    firstBodyRow === -1 ? table.rows : table.rows.slice(0, firstBodyRow)
  const bodyRows = firstBodyRow === -1 ? [] : table.rows.slice(firstBodyRow)
  const renderRows = (rows: typeof table.rows, rowOffset: number) =>
    rows
      .map((row, relativeRowIndex) => {
        const rowIndex = rowOffset + relativeRowIndex
        return `<tr>${row.cells
          .map((cell, columnIndex) => {
            const tag = cell.headerScope ? 'th' : 'td'
            const scope = cell.headerScope
              ? ` scope="${cell.headerScope === 'column' ? 'col' : 'row'}"`
              : ''
            const localId =
              cell.id ?? `cell-r${rowIndex + 1}-c${columnIndex + 1}`
            const cellId = stableId(`${canonicalNodeId}-${localId}`)
            const headers =
              cell.headerScope === null && (cell.headerIds?.length ?? 0) > 0
                ? ` headers="${attribute(
                    cell
                      .headerIds!.map((headerId) =>
                        stableId(`${canonicalNodeId}-${headerId}`),
                      )
                      .join(' '),
                  )}"`
                : ''
            const columnSpan =
              cell.columnSpan > 1 ? ` colspan="${cell.columnSpan}"` : ''
            const rowSpan = cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''
            return `<${tag} id="${attribute(cellId)}"${scope}${headers}${columnSpan}${rowSpan}>${renderTextWithNoteReferences(cell.text, cell.noteReferences, cell.inlineRuns, scholarlyTargetKinds)}</${tag}>`
          })
          .join('')}</tr>`
      })
      .join('')
  const source = assetId ? ` data-asset-id="${attribute(assetId)}"` : ''
  const describedBy = captionId
    ? ` aria-describedby="${attribute(captionId)}"`
    : ''
  const wrapperAccessibility = captionId
    ? ` role="region" aria-labelledby="${attribute(captionId)}"`
    : ` role="group" aria-label="${attribute(accessibleLabel)}"`
  const wideTable =
    columnCount >= 6
      ? ` data-wide-table="true" data-table-columns="${columnCount}"`
      : ` data-table-columns="${columnCount}"`
  return `<div class="semantic-table-wrapper"${wrapperAccessibility} tabindex="0"${wideTable}${source}><table${describedBy}>${headerRows.length > 0 ? `<thead>${renderRows(headerRows, 0)}</thead>` : ''}${bodyRows.length > 0 ? `<tbody>${renderRows(bodyRows, Math.max(firstBodyRow, 0))}</tbody>` : ''}</table></div>`
}

type ParagraphNode = Extract<ResearchNode, { type: 'paragraph' }>
type ListParagraphNode = ParagraphNode & {
  list: NonNullable<ParagraphNode['list']>
}

type PublicationListItem = {
  node: ListParagraphNode
  children: PublicationListGroup[]
}

type PublicationListGroup = {
  level: number
  ordered: boolean
  numberingId: string
  markerStyle: NonNullable<ListParagraphNode['list']>['markerStyle']
  items: PublicationListItem[]
}

function isListParagraph(node: ResearchNode): node is ListParagraphNode {
  return node.type === 'paragraph' && Boolean(node.list)
}

function isOrderedList(node: ListParagraphNode) {
  if (node.list.numberingId !== 'references') return node.list.ordered
  return (
    node.list.ordered &&
    (node.list.ordinal !== undefined || Boolean(node.list.markerText))
  )
}

function renderPublicationListGroup(
  group: PublicationListGroup,
  scholarlyTargetKinds: ReadonlyMap<string, CanonicalSemanticTarget>,
): string {
  const tag = group.ordered ? 'ol' : 'ul'
  const markerless =
    !group.ordered &&
    group.numberingId === 'references' &&
    group.items.every(
      ({ node }) =>
        node.list.ordinal === undefined && !node.list.markerText?.trim(),
    )
  const firstOrdinal = group.items[0]?.node.list.ordinal
  const listType =
    group.markerStyle === 'lower-alpha'
      ? 'a'
      : group.markerStyle === 'upper-alpha'
        ? 'A'
        : group.markerStyle === 'lower-roman'
          ? 'i'
          : group.markerStyle === 'upper-roman'
            ? 'I'
            : undefined
  const items = group.items
    .map(({ node, children }, index) => {
      const id = attribute(stableId(node.id))
      const expectedOrdinal =
        firstOrdinal === undefined ? undefined : firstOrdinal + index
      const value =
        group.ordered &&
        node.list.ordinal !== undefined &&
        node.list.ordinal !== expectedOrdinal
          ? ` value="${node.list.ordinal}"`
          : ''
      const preservedMarker = node.list.markerText
        ? `<span class="publication-list-marker" aria-hidden="true">${text(node.list.markerText)}</span>`
        : ''
      const continued = node.list.continuedFromPreviousPage
        ? ' data-continued-from-previous-page="true"'
        : ''
      return `<li id="${id}" data-canonical-id="${id}" class="publication-list-item${preservedMarker ? ' has-preserved-marker' : ''}" data-list-level="${node.list.level}"${value}${continued}>${preservedMarker}${renderTextWithNoteReferences(node.text, node.noteReferences, node.inlineRuns, scholarlyTargetKinds)}${children.map((child) => renderPublicationListGroup(child, scholarlyTargetKinds)).join('')}</li>`
    })
    .join('')
  const start =
    group.ordered && firstOrdinal !== undefined && firstOrdinal !== 1
      ? ` start="${firstOrdinal}"`
      : ''
  const type = group.ordered && listType ? ` type="${listType}"` : ''
  return `<${tag} class="publication-list${markerless ? ' markerless-list' : ''}" data-list-level="${group.level}" data-numbering-id="${attribute(group.numberingId)}" data-marker-style="${attribute(group.markerStyle ?? (group.ordered ? 'decimal' : 'disc'))}"${type}${start}>${items}</${tag}>`
}

function renderPublicationList(
  nodes: ListParagraphNode[],
  scholarlyTargetKinds: ReadonlyMap<string, CanonicalSemanticTarget>,
) {
  const roots: PublicationListGroup[] = []
  const ancestors: Array<{ level: number; item: PublicationListItem }> = []

  for (const node of nodes) {
    const { level, numberingId } = node.list
    const ordered = isOrderedList(node)
    const markerStyle = node.list.markerStyle ?? (ordered ? 'decimal' : 'disc')
    while (
      ancestors.length > 0 &&
      ancestors[ancestors.length - 1].level >= level
    ) {
      ancestors.pop()
    }

    const parent = ancestors.at(-1)?.item
    const siblingGroups = parent ? parent.children : roots
    let group = siblingGroups.at(-1)
    if (
      !group ||
      group.level !== level ||
      group.ordered !== ordered ||
      group.numberingId !== numberingId ||
      group.markerStyle !== markerStyle
    ) {
      group = { level, ordered, numberingId, markerStyle, items: [] }
      siblingGroups.push(group)
    }

    const item = { node, children: [] } satisfies PublicationListItem
    group.items.push(item)
    ancestors.push({ level, item })
  }

  return roots
    .map((group) => renderPublicationListGroup(group, scholarlyTargetKinds))
    .join('')
}

function literalExternalHyperlinkRuns(value: string) {
  const runs: Array<{ start: number; end: number; href: string }> = []
  const unmatchedClosingDelimiter = (
    candidate: string,
    open: string,
    close: string,
  ) => candidate.split(close).length > candidate.split(open).length
  for (const match of value.matchAll(/(?:https?:\/\/|mailto:)[^\s<>"']+/giu)) {
    if (match.index === undefined) continue
    let visible = match[0].replace(/[.,;:!?]+$/u, '')
    for (const [open, close] of [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ]) {
      while (
        visible.endsWith(close) &&
        unmatchedClosingDelimiter(visible, open, close)
      ) {
        visible = visible.slice(0, -1)
      }
    }
    if (!visible || !safePdfExternalLinkTarget(visible)) continue
    const href = normalizedEpubHref(visible)
    if (!href) continue
    runs.push({
      start: match.index,
      end: match.index + visible.length,
      href,
    })
  }
  return runs
}

function renderNode(
  node: ResearchNode,
  captions: Map<string, Extract<ResearchNode, { type: 'caption' }>>,
  visualRelationships: Map<string, PublicationVisualRelationship>,
  assets: Map<string, PublicationAsset>,
  verifiedEquationTranscriptIds: ReadonlySet<string>,
  omitMissingVisuals = false,
  canonicalTitleNodeId?: string,
  renderedNoteReferenceIds: ReadonlySet<string> = new Set(),
  scholarlyTargetKinds: ReadonlyMap<
    string,
    CanonicalSemanticTarget
  > = new Map(),
  headingLevels: ReadonlyMap<string, number> = new Map(),
) {
  const id = attribute(stableId(node.id))
  if (node.type === 'heading') {
    const level =
      headingLevels.get(node.id) ??
      (node.id === canonicalTitleNodeId
        ? 1
        : Math.min(4, Math.max(2, node.level + 1)))
    return `<h${level} id="${id}" data-canonical-id="${id}">${renderTextWithNoteReferences(node.text, node.noteReferences, node.inlineRuns, scholarlyTargetKinds)}</h${level}>`
  }
  if (node.type === 'paragraph') {
    return `<p id="${id}" data-canonical-id="${id}">${renderTextWithNoteReferences(node.text, node.noteReferences, node.inlineRuns, scholarlyTargetKinds)}</p>`
  }
  if (node.type === 'quote') {
    return `<blockquote id="${id}" data-canonical-id="${id}"><p>${renderTextWithNoteReferences(node.text, node.noteReferences, node.inlineRuns, scholarlyTargetKinds)}</p></blockquote>`
  }
  if (node.type === 'footnote') {
    const backlinkLabel = attribute(node.label)
    const backlinks = node.relationships.backlinks
      .filter((backlink) => renderedNoteReferenceIds.has(stableId(backlink)))
      .map(
        (backlink, index) =>
          `<a href="#${attribute(stableId(backlink))}" class="note-backlink" aria-label="Back to reference ${backlinkLabel || index + 1}">↩</a>`,
      )
      .join(' ')
    const inlineRuns = [
      ...(node.inlineRuns ?? []),
      ...literalExternalHyperlinkRuns(node.text),
    ]
    return `<aside id="${id}" data-canonical-id="${id}" epub:type="${node.kind}" role="doc-footnote" data-note-kind="${node.kind}" class="publication-note"><span class="note-label" data-semantic-ledger-ignore="true">${text(node.markerText ?? node.label)} </span>${renderTextWithNoteReferences(node.text, node.noteReferences, inlineRuns, scholarlyTargetKinds)}${backlinks ? ` ${backlinks}` : ''}</aside>`
  }
  if (node.type === 'figure') {
    const caption = captions.get(node.relationships.caption)
    const captionId = attribute(stableId(node.relationships.caption))
    const visual = visualRelationships.get(node.id)
    if (visual) {
      const verifiedEquationGeometryTranscript =
        visual.kind === 'equation' &&
        verifiedEquationTranscriptIds.has(visual.id)
          ? visual.equationGeometryTranscript
          : undefined
      const equationTranscriptId = attribute(
        `${stableId(node.id)}-equation-transcript`,
      )
      const visualObjectType = visual.semanticKind ?? visual.kind
      const sourceAlgorithm =
        visual.semanticKind === 'algorithm' &&
        visual.evidence.includes('source-algorithm-block')
      const sourceCode =
        visual.preformatted !== undefined &&
        visual.evidence.includes('source-preformatted-block')
      const provedSourceCode =
        sourceCode &&
        visual.preformatted?.status === 'proved' &&
        visual.preformatted.lines.length > 0
      const syntheticEquationCaption = Boolean(
        visual.kind === 'equation' &&
        caption &&
        /^Display equation p\d{3}-\d{3}$/u.test(caption.text.trim()),
      )
      const parsedEquationCaption =
        visual.kind === 'equation' &&
        visual.altTextSource === 'caption' &&
        caption
          ? parsePdfScholarlyVisualLabel(caption.text, {
              context: 'caption',
            })
          : null
      const generatedEquationLabel =
        parsedEquationCaption?.status === 'parsed' &&
        parsedEquationCaption.kind === 'equation' &&
        /^[.]?$/u.test(
          caption!.text.slice(parsedEquationCaption.consumedEnd).trim(),
        )
          ? parsedEquationCaption.label
          : null
      const unresolvedEquationTranscript =
        syntheticEquationCaption &&
        visual.evidence.includes('source-text-transcript-unresolved') &&
        !visual.equationTranscriptAdjudication
      const renderedAltText = unresolvedEquationTranscript
        ? 'Equation reproduced from the source PDF.'
        : verifiedEquationGeometryTranscript
          ? ''
          : visual.equationTranscriptAdjudication
            ? 'Equation image; owner-reviewed source transcript available.'
            : (generatedEquationLabel ?? visual.altText)
      const renderedAltTextSource = unresolvedEquationTranscript
        ? 'source-image'
        : verifiedEquationGeometryTranscript
          ? 'source-geometry-script-transcript-v1'
          : visual.equationTranscriptAdjudication
            ? 'owner-local-adjudication'
            : visual.altTextSource
      const visualAssets = visual.assetIds
        .map((assetId) => assets.get(assetId))
        .filter((visualAsset): visualAsset is PublicationAsset =>
          Boolean(visualAsset),
        )
      const semanticTableAsset = semanticTableAssetForRenderedNode({
        node,
        visual,
        assets,
      })
      const renderedVisualAssets = visualAssets
        .map((visualAsset) => {
          const href = attribute(visualAsset.href)
          const alt = attribute(renderedAltText)
          if (visualAsset.mediaType === 'application/xhtml+xml') {
            return `<object data="${href}" type="application/xhtml+xml" aria-label="${alt}" data-alt-source="${renderedAltTextSource}"><p>${text(renderedAltText)}</p></object>`
          }
          const width = Math.max(1, Math.round(visualAsset.width))
          const height = Math.max(1, Math.round(visualAsset.height))
          const image = `<img src="${href}" width="${width}" height="${height}" loading="eager" decoding="async" alt="${alt}"${verifiedEquationGeometryTranscript ? ' aria-hidden="true"' : ''} data-alt-source="${renderedAltTextSource}" data-asset-id="${attribute(visualAsset.id)}" />`
          const wideSourceVisual =
            (visual.kind === 'table' &&
              isCompactScrollableTableImage({
                ...visualAsset,
                kind: 'table',
              })) ||
            (width / height >= 2 &&
              visual.kind === 'figure' &&
              visual.semanticKind !== 'algorithm')
          return wideSourceVisual
            ? `<div class="wide-source-visual-frame" data-wide-source-visual="true" data-source-visual-kind="${visual.kind}">${image}</div>`
            : image
        })
        .join('')
      const hasSourceCodeLines =
        sourceCode && (visual.preformatted?.lines.length ?? 0) > 0
      const renderedSourceCode = hasSourceCodeLines
        ? `<pre class="source-code" data-whitespace-source="source-lines" data-transcript-status="${provedSourceCode ? 'proved' : 'unresolved'}"><code>${visual
            .preformatted!.lines.map(
              (line) =>
                `<span class="source-code-line source-code-indent-${Math.min(
                  16,
                  Math.max(0, line.indentColumns ?? 0),
                )}" data-source-region-id="${attribute(line.sourceRegionId)}" data-source-line-id="${attribute(line.sourceLineId)}" data-indent-columns="${Math.min(
                  16,
                  Math.max(0, line.indentColumns ?? 0),
                )}">${text(line.text)}</span>`,
            )
            .join('\n')}</code></pre>`
        : ''
      const renderedAssets = hasSourceCodeLines
        ? provedSourceCode
          ? renderedSourceCode
          : renderedVisualAssets
        : visual.kind === 'table' && node.table && semanticTableAsset
          ? renderSemanticTable(
              node.table,
              node.id,
              semanticTableAsset.id,
              caption ? captionId : undefined,
              visual.label || node.title,
              scholarlyTargetKinds,
            )
          : renderedVisualAssets
      const sourceEquationCaption =
        visual.kind === 'equation' && visual.altTextSource === 'source-text'
      const renderedEquationTranscript = verifiedEquationGeometryTranscript
        ? renderSourceGeometryScriptMathMl(
            verifiedEquationGeometryTranscript,
            equationTranscriptId,
          )
        : ''
      const sourceTranscript =
        node.sourceText && !sourceCode
          ? `<span class="visually-hidden visual-source-transcript"${
              visual.kind === 'table' && node.table && semanticTableAsset
                ? ' aria-hidden="true"'
                : ''
            } data-source-transcript-for="${id}">${renderTextWithNoteReferences(node.sourceText, undefined, node.inlineRuns, scholarlyTargetKinds)}</span>`
          : ''
      const figureClasses = [
        ...(visual.kind === 'table' && node.table
          ? ['semantic-table-figure']
          : []),
        ...(sourceAlgorithm ? ['algorithm-figure'] : []),
        ...(sourceCode ? ['source-code-figure'] : []),
      ]
      const figureClass =
        figureClasses.length > 0
          ? ` class="${attribute(figureClasses.join(' '))}"`
          : ''
      const renderedCaption = caption
        ? syntheticEquationCaption
          ? `<figcaption id="${captionId}" data-canonical-id="${captionId}" class="synthetic-equation-caption" aria-hidden="true"></figcaption>`
          : `<figcaption id="${captionId}" data-canonical-id="${captionId}"${sourceAlgorithm ? ' class="algorithm-source-caption visually-hidden"' : sourceCode && visual.evidence.includes('fallback-source-line-caption') ? ' class="code-source-caption visually-hidden"' : generatedEquationLabel ? ' class="equation-number-caption visually-hidden"' : sourceEquationCaption ? ' class="equation-source-text"' : ''}>${generatedEquationLabel ? text(generatedEquationLabel) : renderTextWithNoteReferences(caption.text, caption.noteReferences, caption.inlineRuns, scholarlyTargetKinds)}</figcaption>`
        : ''
      return `<figure id="${id}" data-canonical-id="${id}" data-caption-id="${captionId}" data-object-type="${visualObjectType}" role="group"${figureClass}>${renderedAssets}${renderedEquationTranscript}${sourceTranscript}${renderedCaption}</figure>`
    }
    if (omitMissingVisuals) {
      return `<span id="${id}" data-canonical-id="${id}" hidden="hidden" aria-hidden="true"></span>${
        caption
          ? `<span id="${captionId}" data-canonical-id="${captionId}" hidden="hidden" aria-hidden="true"></span>`
          : ''
      }`
    }
    return `<figure id="${id}" data-canonical-id="${id}" data-caption-id="${captionId}" role="group"><div class="figure-placeholder" role="img" aria-label="${attribute(node.title)}">${text(node.title)}</div>${caption ? `<figcaption id="${captionId}" data-canonical-id="${captionId}">${renderTextWithNoteReferences(caption.text, caption.noteReferences, caption.inlineRuns, scholarlyTargetKinds)}</figcaption>` : ''}</figure>`
  }
  return ''
}

function exactNumericMarker(value: string) {
  const match = value.match(
    /^\s*(?:\[\s*(\d{1,9})\s*\]|(\d{1,9})[.)]?|(?:references?|refs?\.?)\s+(\d{1,9}))\s*$/iu,
  )
  const raw = match?.slice(1).find(Boolean)
  return raw ? normalizedNumericIdentity(raw) : null
}

function leadingNumericReferenceIdentity(value: string) {
  const match = value.match(
    /^\s*(?:\[\s*(\d{1,9})\s*\]|(\d{1,9})[.)](?=\s|$)|(?:references?|refs?\.?)\s+(\d{1,9})(?=[.:\s]|$))/iu,
  )
  if (
    match?.[2] &&
    match[2].length === 4 &&
    Number(match[2]) >= 1800 &&
    Number(match[2]) <= 2099
  ) {
    return null
  }
  const raw = match?.slice(1).find(Boolean)
  return raw ? normalizedNumericIdentity(raw) : null
}

function canonicalCitationTargetIdentifier(node: ResearchNode) {
  if (node.type !== 'paragraph') return null
  const candidates = [
    node.list?.numberingId === 'references' &&
    node.list.ordinal !== undefined &&
    Number.isSafeInteger(node.list.ordinal) &&
    node.list.ordinal >= 0
      ? String(node.list.ordinal)
      : null,
    node.list?.numberingId === 'references' && node.list.markerText
      ? exactNumericMarker(node.list.markerText)
      : null,
    leadingNumericReferenceIdentity(node.text),
  ].filter((candidate): candidate is string => candidate !== null)
  const identities = new Set(candidates)
  return identities.size === 1 ? candidates[0] : null
}

function canonicalHeadingIdentifier(value: string) {
  const source = value.trim().replace(/^appendix\s+/iu, '')
  const raw = source.match(/^(\S+?)(?:\.\s+|\s+\S)/u)?.[1]
  return raw ? normalizedCrossReferenceIdentity(raw) : null
}

function renderResearchPublicationXhtml(
  paper: ResearchPaper,
  options: {
    embedStyles?: boolean
    reconstruction?: DocumentReconstruction
    styles?: string
    visualAssets?: Map<string, PublicationAsset>
  } = {},
) {
  const duplicateVisualOwner = duplicateVisualRelationshipNodeOwnership(
    options.reconstruction?.visualRelationships ?? [],
  )
  if (duplicateVisualOwner) {
    throw new Error(
      `EPUB visual relationships ${duplicateVisualOwner.relationshipIds.join(', ')} ambiguously share ${duplicateVisualOwner.field} ${duplicateVisualOwner.nodeId}.`,
    )
  }
  const captions = new Map(
    paper.nodes
      .filter(
        (node): node is Extract<ResearchNode, { type: 'caption' }> =>
          node.type === 'caption',
      )
      .map((node) => [node.id, node]),
  )
  const sourceVisualLabels = new Map(
    (options.reconstruction?.visualRelationships ?? []).flatMap(
      (relationship) =>
        relationship.canonicalNodeId
          ? [[relationship.canonicalNodeId, relationship.label] as const]
          : [],
    ),
  )
  const scholarlyTargetKinds = new Map<string, CanonicalSemanticTarget>()
  for (const node of paper.nodes) {
    const citationIdentifier = canonicalCitationTargetIdentifier(node)
    if (citationIdentifier) {
      scholarlyTargetKinds.set(stableId(node.id), {
        kind: 'citation',
        identifier: citationIdentifier,
      })
    } else if (node.type === 'heading') {
      const identifier = canonicalHeadingIdentifier(node.text)
      scholarlyTargetKinds.set(stableId(node.id), {
        kind: 'section',
        ...(identifier ? { identifier } : {}),
      })
    } else if (node.type === 'figure') {
      const labelSource =
        sourceVisualLabels.get(node.id) ??
        captions.get(node.relationships.caption)?.text ??
        node.title
      const parsedLabel = parsePdfScholarlyVisualLabel(labelSource, {
        context: 'reference',
      })
      scholarlyTargetKinds.set(stableId(node.id), {
        kind: node.objectType ?? parsedLabel?.kind ?? 'figure',
        ...(parsedLabel?.status === 'parsed'
          ? { identifier: parsedLabel.identifier }
          : {}),
      })
    }
  }
  const associatedCaptions = new Set(
    paper.nodes
      .filter(
        (node): node is Extract<ResearchNode, { type: 'figure' }> =>
          node.type === 'figure',
      )
      .map((node) => node.relationships.caption),
  )
  const visualRelationships = new Map(
    (options.reconstruction?.visualRelationships ?? [])
      .filter((relationship) => relationship.canonicalNodeId)
      .map((relationship) => [relationship.canonicalNodeId!, relationship]),
  )
  const unresolvedVisuals = new Map(
    (options.reconstruction?.visualRelationships ?? [])
      .filter(
        (relationship) =>
          relationship.status !== 'matched' && relationship.captionNodeId,
      )
      .map((relationship) => [relationship.captionNodeId!, relationship]),
  )
  const sourceProvedUnresolvedTableCaptionIds = new Set(
    (options.reconstruction?.visualRelationships ?? []).flatMap(
      (relationship) =>
        isSourceProvedUnresolvedPartialParentTable(relationship) &&
        relationship.captionNodeId
          ? [relationship.captionNodeId]
          : [],
    ),
  )
  const assets =
    options.visualAssets ??
    new Map(
      (options.reconstruction?.assets ?? []).map((visualAsset) => [
        visualAsset.id,
        visualAsset,
      ]),
    )
  const transcriptReconstruction =
    options.reconstruction &&
    'regions' in options.reconstruction &&
    Array.isArray(options.reconstruction.regions)
      ? (options.reconstruction as PdfReconstruction)
      : null
  const verifiedEquationTranscriptIds = new Set(
    transcriptReconstruction
      ? transcriptReconstruction.visualRelationships.flatMap((relationship) =>
          verifyRelationshipSourceGeometryScriptTranscript({
            relationship,
            regions: transcriptReconstruction.regions,
            assets: transcriptReconstruction.assets,
          })
            ? [relationship.id]
            : [],
        )
      : [],
  )
  const omitMissingVisuals = Boolean(
    options.reconstruction && !options.reconstruction.readiness.ready,
  )
  const reconstructed = Boolean(options.reconstruction)
  const canonicalTitleNode = reconstructed
    ? paper.nodes.find(
        (
          node,
        ): node is Extract<ResearchNode, { type: 'heading' | 'paragraph' }> =>
          (node.type === 'heading' || node.type === 'paragraph') &&
          comparableText(node.text) === comparableText(paper.title),
      )
    : undefined
  const sourceRenderableNodes = paper.nodes.filter(
    (node) => node.type !== 'caption' || !associatedCaptions.has(node.id),
  )
  const authorNoteNodeIds = new Set(
    (paper.authorNotes ?? []).map((reference) => reference.target),
  )
  const authorNoteNodes = sourceRenderableNodes.filter((node) =>
    authorNoteNodeIds.has(node.id),
  )
  const renderableNodes =
    canonicalTitleNode && authorNoteNodes.length > 0
      ? sourceRenderableNodes.flatMap((node) => {
          if (authorNoteNodeIds.has(node.id)) return []
          return node.id === canonicalTitleNode.id
            ? [node, ...authorNoteNodes]
            : [node]
        })
      : sourceRenderableNodes
  const renderedAssociatedCaptionIds = new Set(
    paper.nodes.flatMap((node) =>
      node.type === 'figure' &&
      (visualRelationships.has(node.id) || !omitMissingVisuals)
        ? [node.relationships.caption]
        : [],
    ),
  )
  const renderedSemanticTableNodeIds =
    renderedSemanticTableNodeIdsForPublication({
      paper,
      visualRelationships,
      assets,
    })
  assertPublicationIntegrity(
    paper,
    options.reconstruction?.noteRelationships,
    noteRelationshipSourceEvidence(options.reconstruction),
    { renderedSemanticTableNodeIds },
  )
  const renderedNoteReferenceOwnerNodes = [
    ...renderableNodes,
    ...paper.nodes.filter(
      (node) =>
        node.type === 'caption' && renderedAssociatedCaptionIds.has(node.id),
    ),
  ]
  const renderedNoteReferenceIds = new Set([
    ...renderableAuthorNoteReferences(paper).map((reference) =>
      stableId(reference.id),
    ),
    ...renderedNoteReferenceOwnerNodes.flatMap((node) => [
      ...('noteReferences' in node
        ? validNoteReferences(node.text, node.noteReferences).map((reference) =>
            stableId(reference.id),
          )
        : []),
      ...(node.type === 'figure' &&
      node.table &&
      renderedSemanticTableNodeIds.has(node.id)
        ? node.table.rows.flatMap((row) =>
            row.cells.flatMap((cell) =>
              validNoteReferences(cell.text, cell.noteReferences).map(
                (reference) => stableId(reference.id),
              ),
            ),
          )
        : []),
    ]),
  ])
  const headingLevels = new Map<string, number>()
  let previousHeadingLevel = 1
  for (const node of renderableNodes) {
    if (node.type !== 'heading') continue
    if (node.id === canonicalTitleNode?.id) {
      headingLevels.set(node.id, 1)
      previousHeadingLevel = 1
      continue
    }
    const sourceLevel = Math.min(4, Math.max(2, node.level + 1))
    const accessibleLevel = Math.min(
      sourceLevel,
      Math.max(2, previousHeadingLevel + 1),
    )
    headingLevels.set(node.id, accessibleLevel)
    previousHeadingLevel = accessibleLevel
  }
  const renderedNodes: string[] = []
  for (let index = 0; index < renderableNodes.length; index += 1) {
    const node = renderableNodes[index]
    if (isListParagraph(node)) {
      const numberingId = node.list.numberingId
      const listNodes = [node]
      while (index + 1 < renderableNodes.length) {
        const nextNode = renderableNodes[index + 1]
        if (
          !isListParagraph(nextNode) ||
          nextNode.list.numberingId !== numberingId
        ) {
          break
        }
        listNodes.push(nextNode)
        index += 1
      }
      renderedNodes.push(renderPublicationList(listNodes, scholarlyTargetKinds))
      continue
    }
    renderedNodes.push(
      node.type === 'caption'
        ? (() => {
            const unresolvedVisual = unresolvedVisuals.get(node.id)
            return sourceProvedUnresolvedTableCaptionIds.has(node.id)
              ? `<aside id="${attribute(stableId(node.id))}" data-canonical-id="${attribute(stableId(node.id))}" class="orphan-caption">${renderTextWithNoteReferences(node.text, node.noteReferences, node.inlineRuns, scholarlyTargetKinds)}</aside>`
              : unresolvedVisual || omitMissingVisuals
                ? `<span id="${attribute(stableId(node.id))}" data-canonical-id="${attribute(stableId(node.id))}" hidden="hidden" aria-hidden="true"></span>`
                : `<aside id="${attribute(stableId(node.id))}" data-canonical-id="${attribute(stableId(node.id))}" class="orphan-caption">${renderTextWithNoteReferences(node.text, node.noteReferences, node.inlineRuns, scholarlyTargetKinds)}</aside>`
          })()
        : renderNode(
            node,
            captions,
            visualRelationships,
            assets,
            verifiedEquationTranscriptIds,
            omitMissingVisuals,
            canonicalTitleNode?.id,
            renderedNoteReferenceIds,
            scholarlyTargetKinds,
            headingLevels,
          ),
    )
    if (node.id === canonicalTitleNode?.id) {
      renderedNodes.push(renderReconstructedByline(paper))
    }
  }
  const body = renderedNodes.join('\n')
  const publicationHeader = reconstructed
    ? canonicalTitleNode
      ? ''
      : `<header class="reconstructed-header">
      <h1 id="publication-title">${text(paper.title)}</h1>
      <p class="authors">${renderAuthors(paper)}</p>
      ${paper.affiliations?.length ? `<p class="affiliations">${renderAffiliations(paper)}</p>` : ''}
    </header>`
    : `<header class="publication-header">
      <p class="status">${text(paper.status)} · ${text(paper.updated)}</p>
      <h1 id="publication-title">${text(paper.title)}</h1>
      <p class="subtitle">${text(paper.subtitle)}</p>
      <p class="authors">${renderAuthors(paper)}</p>
      ${paper.affiliations?.length ? `<p class="affiliations">${renderAffiliations(paper)}</p>` : ''}
      <section class="abstract" aria-labelledby="abstract-title">
        <h2 id="abstract-title">Abstract</h2>
        <p>${text(paper.abstract)}</p>
      </section>
    </header>`
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" ${xhtmlLanguageAttributes(paper)}>
<head>
  <meta charset="UTF-8" />
  <title>${text(paper.title)}</title>
  ${options.embedStyles ? `<style type="text/css">${options.styles ?? EPUB_CSS}</style>` : '<link rel="stylesheet" type="text/css" href="styles.css" />'}
</head>
<body>
  <main epub:type="bodymatter" xmlns:epub="http://www.idpf.org/2007/ops">
    ${publicationHeader}
    ${body}
  </main>
</body>
</html>
`
  assertSerializedXhtmlSemanticIntegrity(xhtml, 'EPUB content')
  return xhtml
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
  return sha256Sync(strToU8(JSON.stringify(paper)))
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

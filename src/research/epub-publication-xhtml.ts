import { strToU8 } from 'fflate'
import {
  renderSourceGeometryScriptMathMl,
  verifyRelationshipSourceGeometryScriptTranscript,
} from './equation-geometry-transcript'
import { assertSerializedXhtmlSemanticIntegrity } from './epub-integrity'
import { isSourceProvedUnresolvedPartialParentTable } from './epub-pdf-evidence'
import {
  attribute,
  comparableText,
  normalizedCrossReferenceIdentity,
  normalizedEpubHref,
  normalizedNumericIdentity,
  renderTextWithNoteReferences,
  stableId,
  text,
  type CanonicalSemanticTarget,
} from './epub-semantic-links'
import {
  duplicateVisualRelationshipNodeOwnership,
  validNoteReferences,
} from './epub-readable-fallback'
import type {
  DocumentReconstruction,
  PdfReconstruction,
  PublicationAsset,
  PublicationVisualRelationship,
} from './import-types'
import { safePdfExternalLinkTarget } from './pdf-links'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import {
  assertPublicationIntegrity,
  renderableAuthorNoteReferences,
} from './publication-integrity'
import type { ResearchNode, ResearchPaper } from './schema'
import { targetProfileSchema } from './target-schema'
import type { TargetProfile } from './targets'

const COMPACT_RASTER_TABLE_SCROLL_MIN_SOURCE_WIDTH_PX = 1_000

function isCompactScrollableTableImage({
  kind,
  mediaType,
  width,
  height,
}: Pick<PublicationAsset, 'kind' | 'mediaType' | 'width' | 'height'>) {
  return (
    kind === 'table' &&
    mediaType.startsWith('image/') &&
    (width / height >= 2 ||
      width >= COMPACT_RASTER_TABLE_SCROLL_MIN_SOURCE_WIDTH_PX)
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

export function renderedSemanticTableNodeIdsForPublication({
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
export function noteRelationshipSourceEvidence(
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

export function assertUniqueCanonicalNodeIds(paper: ResearchPaper) {
  const ids = paper.nodes.map((node) => node.id)
  if (new Set(ids).size !== ids.length) {
    throw new Error('EPUB canonical node ids must be globally unique')
  }
}

export function slug(value: string) {
  const candidate = value
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
  return candidate || 'research-publication'
}

export async function sha256(value: Uint8Array | string) {
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

function publicationLanguage(paper: ResearchPaper) {
  return paper.language ?? 'und'
}

function publicationBaseDirection(paper: ResearchPaper) {
  return paper.baseDirection === 'ltr' || paper.baseDirection === 'rtl'
    ? paper.baseDirection
    : undefined
}

function xhtmlLanguageAttributes(paper: ResearchPaper) {
  const language = attribute(publicationLanguage(paper))
  const direction = publicationBaseDirection(paper)
  return `xml:lang="${language}" lang="${language}"${direction ? ` dir="${direction}"` : ''}`
}

export function renderResearchPublicationXhtml(
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

export function navXhtml(paper: ResearchPaper) {
  const canonicalTitleNode = paper.nodes.find(
    (node): node is Extract<ResearchNode, { type: 'heading' | 'paragraph' }> =>
      (node.type === 'heading' || node.type === 'paragraph') &&
      comparableText(node.text) === comparableText(paper.title),
  )
  const headings = paper.nodes.filter(
    (node): node is Extract<ResearchNode, { type: 'heading' }> =>
      node.type === 'heading' && node.id !== canonicalTitleNode?.id,
  )
  const titleHref = canonicalTitleNode
    ? `content.xhtml#${attribute(stableId(canonicalTitleNode.id))}`
    : 'content.xhtml#publication-title'
  type NavigationItem = {
    node: (typeof headings)[number]
    children: NavigationItem[]
  }
  const roots: NavigationItem[] = []
  const ancestors: Array<{
    level: number
    item: NavigationItem
  }> = []
  for (const node of headings) {
    while (
      ancestors.length > 0 &&
      ancestors[ancestors.length - 1].level >= node.level
    ) {
      ancestors.pop()
    }
    const item = { node, children: [] }
    const parent = ancestors.at(-1)?.item
    if (parent) parent.children.push(item)
    else roots.push(item)
    ancestors.push({ level: node.level, item })
  }
  const renderNavigationItem = (item: NavigationItem): string =>
    `<li><a href="content.xhtml#${attribute(stableId(item.node.id))}">${text(item.node.text)}</a>${item.children.length > 0 ? `<ol>${item.children.map(renderNavigationItem).join('')}</ol>` : ''}</li>`
  const items = [
    `<li><a href="${titleHref}">${text(paper.title)}</a></li>`,
    ...roots.map(renderNavigationItem),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" ${xhtmlLanguageAttributes(paper)}>
<head><meta charset="UTF-8" /><title>Contents</title></head>
<body>
  <nav epub:type="toc" role="doc-toc" id="toc" aria-label="Table of contents">
    <h1>Contents</h1>
    <ol>${items.join('\n')}</ol>
  </nav>
</body>
</html>
`
}

export const EPUB_CSS = `
:root { color-scheme: light; }
*, *::before, *::after { box-sizing: border-box; }
html { font-size: 100%; max-width: 100%; }
body { margin: 0; max-width: 100%; color: #111; background: #fff; font-family: Georgia, "Times New Roman", serif; line-height: 1.62; }
main { box-sizing: border-box; width: 100%; max-width: 42rem; margin: 0 auto; padding: 5%; }
.publication-header { border-bottom: 0.08rem solid currentColor; margin-bottom: 2.5rem; padding-bottom: 2rem; }
.reconstructed-header { margin-bottom: 2rem; }
.reconstruction-status { border: 0.12rem solid currentColor; margin: 0 0 2rem; padding: 0.9rem 1rem; }
.reconstruction-status > p { font-family: sans-serif; font-size: 0.8rem; margin: 0; }
.reconstruction-status > p:first-child { font-weight: 700; }
.reconstruction-status > p + p { margin-top: 0.35rem; }
.status, .authors { font-family: sans-serif; font-size: 0.78rem; letter-spacing: 0.04em; }
.affiliation-marker, .author-affiliation-marker, .author-note-marker { margin-inline-start: 0.08em; line-height: 0; vertical-align: super; }
.note-backlink ~ .note-backlink { display: none; }
h1 { font-size: 2.2rem; line-height: 1.05; margin: 0.5rem 0 0.75rem; }
h2 { font-size: 1.45rem; margin: 2.4rem 0 0.6rem; break-after: avoid; }
h3 { font-size: 1.15rem; margin: 2rem 0 0.5rem; break-after: avoid; }
h4 { font-size: 1rem; margin: 1.7rem 0 0.45rem; break-after: avoid; }
p { margin: 0.8rem 0; orphans: 3; widows: 3; }
h1, h2, h3, h4, p, figcaption, .orphan-caption, .publication-note, .publication-list, .publication-list-item { overflow-wrap: break-word; word-break: normal; }
a, code, pre { overflow-wrap: anywhere; word-break: break-word; }
.subtitle { font-size: 1.15rem; font-style: italic; }
.abstract { margin-top: 1.8rem; }
.abstract h2 { font-family: sans-serif; font-size: 0.86rem; letter-spacing: 0.08em; text-transform: uppercase; }
blockquote { border-inline-start: 0.16rem solid currentColor; margin: 1.5rem 0; padding-inline-start: 1rem; font-style: italic; }
figure { break-inside: avoid; margin: 2rem 0; }
.figure-placeholder { border: 0.08rem solid currentColor; padding: 2rem 1rem; text-align: center; }
figcaption, .orphan-caption { font-size: 0.86rem; margin-top: 0.6rem; }
.equation-source-text { border: 0; clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px; margin: -1px; overflow: hidden; padding: 0; position: absolute; white-space: nowrap; width: 1px; }
.omitted-visual { border: 0.08rem dashed currentColor; margin: 2rem 0; padding: 1rem; }
.omitted-visual > p:first-child { font-family: sans-serif; font-size: 0.8rem; font-style: italic; }
.omitted-visual-caption { font-size: 0.86rem; }
.omitted-visual-transcript, .omitted-table-transcript { border-top: 0.06rem solid currentColor; margin-top: 0.75rem; padding-top: 0.75rem; }
.omitted-visual-transcript > p:first-child, .omitted-table-transcript > p:first-child { font-family: sans-serif; font-size: 0.76rem; font-weight: 700; }
.omitted-table-transcript-source { max-width: 100%; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.omitted-algorithm-transcript { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.78rem; line-height: 1.45; overflow-wrap: anywhere; white-space: pre-wrap; }
.source-code { box-sizing: border-box; max-width: 100%; margin: 0; overflow-x: auto; overflow-y: hidden; overflow-wrap: normal; padding: 0.8rem; border: 0.06rem solid currentColor; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.78rem; line-height: 1.45; white-space: pre; word-break: normal; }
.source-code code { display: block; font: inherit; white-space: inherit; }
.source-code-line { display: inline; }
.source-code[data-transcript-status="unresolved"] { border-style: dashed; }
.source-code-image-comparison { margin-block-start: 0.55rem; font-size: 0.72rem; }
.source-code-image-comparison summary { cursor: pointer; font-family: ui-sans-serif, system-ui, sans-serif; }
.source-code-image-comparison img { margin-block-start: 0.55rem; }
${Array.from(
  { length: 17 },
  (_, indent) =>
    `.source-code-indent-${indent} { padding-inline-start: ${indent}ch; }`,
).join('\n')}
.omitted-code-transcript { max-width: 100%; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.78rem; line-height: 1.45; white-space: pre-wrap; }
.publication-note { border-top: 0.06rem solid currentColor; font-size: 0.84rem; margin-top: 1rem; padding-top: 0.5rem; }
.note-label { font-weight: bold; }
.note-backlink { margin-inline-start: 0.35rem; }
.publication-list { max-width: 100%; min-width: 0; margin: 0.8rem 0; padding-inline-start: 1.5rem; }
.publication-list.markerless-list { list-style-type: none; padding-inline-start: 0; }
.publication-list .publication-list { margin: 0.35rem 0 0; }
.publication-list-item { margin: 0.35rem 0; }
.publication-list-item.has-preserved-marker { list-style-type: none; }
.publication-list-marker { display: inline-block; margin-inline-end: 0.4em; }
.visually-hidden, .additional-biblioref, .additional-cross-reference { position: absolute; inline-size: 1px; block-size: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.semantic-table-wrapper { max-width: 100%; overflow-x: auto; }
.semantic-table-figure, .semantic-table-wrapper, .semantic-table-wrapper table { break-inside: auto; }
.semantic-table-wrapper table { border-collapse: collapse; font-size: 0.86rem; line-height: 1.35; min-width: 0; table-layout: fixed; width: 100%; }
.semantic-table-wrapper[data-wide-table="true"] table { min-width: 100%; table-layout: auto; width: auto; }
.semantic-table-wrapper thead { display: table-header-group; }
.semantic-table-figure > figcaption { break-before: avoid; }
.semantic-table-wrapper tr { break-inside: avoid; }
.semantic-table-wrapper th, .semantic-table-wrapper td { border: 0.06rem solid currentColor; padding: 0.3rem 0.4rem; text-align: start; vertical-align: top; }
.semantic-table-wrapper th, .semantic-table-wrapper td { overflow-wrap: anywhere; word-break: break-word; }
.semantic-table-wrapper[data-wide-table="true"] th, .semantic-table-wrapper[data-wide-table="true"] td { min-width: 3.5rem; overflow-wrap: break-word; word-break: normal; }
.semantic-table-wrapper th { font-weight: bold; }
.wide-source-visual-frame { max-width: 100%; overflow: visible; }
img, svg { display: block; height: auto; max-width: 100%; }
object { border: 0; display: block; min-height: 8rem; width: 100%; }
a { color: inherit; text-decoration-line: underline; text-decoration-thickness: 0.06em; text-underline-offset: 0.14em; }
@media (max-width: 30rem) {
  main { padding: 7%; }
  h1 { font-size: 1.8rem; }
}
`

function percentage(value: number, whole: number) {
  return `${Math.round((value / whole) * 100_000) / 1000}%`
}

export function profileEpubCss(profileInput: TargetProfile) {
  const profile = targetProfileSchema.parse(profileInput)
  const width = profile.dimensions.width
  const bodySize = profile.typography.bodySizeCssPx
  const fourthOrderHeadingSize = Math.max(
    bodySize + 1,
    Math.round(profile.typography.headingSizeCssPx * 0.8),
  )
  const thirdOrderHeadingSize = Math.max(
    fourthOrderHeadingSize + 1,
    Math.round(profile.typography.headingSizeCssPx * 0.9),
  )
  const secondOrderHeadingSize = Math.max(
    thirdOrderHeadingSize + 1,
    profile.typography.headingSizeCssPx,
  )
  return `${EPUB_CSS}
/* Profile values are derived from src/research/targets.ts (${profile.id}@${profile.version}). */
html { font-size: ${profile.typography.bodySizeCssPx}px; }
body { font-family: ${profile.typography.fontFamily}; line-height: ${profile.typography.lineHeight}; }
main { max-width: none; padding: ${percentage(profile.margins.top, width)} ${percentage(profile.margins.right, width)} ${percentage(profile.margins.bottom, width)} ${percentage(profile.margins.left, width)}; }
h1 { font-size: ${profile.typography.titleSizeCssPx}px; }
h2 { font-size: ${secondOrderHeadingSize}px; }
h3 { font-size: ${thirdOrderHeadingSize}px; }
h4 { font-size: ${fourthOrderHeadingSize}px; }
blockquote { font-size: ${profile.typography.quoteSizeCssPx}px; }
@page { margin: 0; }
`
}

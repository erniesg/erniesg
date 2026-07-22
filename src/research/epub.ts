import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
  type Zippable,
  type ZipOptions,
} from 'fflate'
import { XMLValidator } from 'fast-xml-parser'
import {
  DocxImportError,
  PdfImportError,
  type DocumentReconstruction,
  type DocxReconstruction,
  type PdfReconstruction,
  type PublicationAsset,
  type PublicationVisualRelationship,
} from './import-types'
import { getCompositionPolicy } from './composition'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import type { ResearchNode, ResearchPaper } from './schema'
import {
  getTargetProfile,
  type TargetProfile,
  type TargetProfileId,
} from './targets'
import { targetProfileSchema } from './target-schema'
import { downscalePngAsset } from './visual-assets'

const EPUB_MIMETYPE = 'application/epub+zip'
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0)
const EPUB_EXPORT_SCHEMA_VERSION = '1.1.0' as const
export const EPUB_EXPORT_POLICY_VERSION = '1.1.0' as const
export type EpubExportMode = 'publication' | 'readable-fallback'
const MAX_READABLE_FALLBACK_ASSETS_PER_VISUAL = 16
const MAX_READABLE_FALLBACK_ASSETS_PER_BOOK = 64

function isDocxReconstruction(
  reconstruction: DocumentReconstruction,
): reconstruction is DocxReconstruction {
  return reconstruction.source.format === 'docx'
}

export type EpubProfileMetadata = {
  id: TargetProfileId
  version: string
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

function profileMetadata(profile: TargetProfile): EpubProfileMetadata {
  return {
    id: profile.id,
    version: profile.version,
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
    ...profileMetadata(profile),
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

function cleanXml(value: string) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

function text(value: string) {
  return cleanXml(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function renderAuthors(paper: ResearchPaper) {
  return paper.authors
    .map((author) => {
      const references = (paper.authorNotes ?? [])
        .filter((reference) => reference.author === author)
        .map(
          (reference) =>
            `<a id="${attribute(stableId(reference.id))}" href="#${attribute(stableId(reference.target))}" epub:type="noteref">${text(reference.label)}</a>`,
        )
        .join('')
      return `${text(author)}${references}`
    })
    .join(', ')
}

function attribute(value: string) {
  return text(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function stableId(value: string) {
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/g, '-')
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `n-${cleaned}`
}

function assertUniqueCanonicalNodeIds(paper: ResearchPaper) {
  const ids = paper.nodes.map((node) => node.id)
  if (new Set(ids).size !== ids.length) {
    throw new Error('EPUB canonical node ids must be globally unique')
  }
}

function comparableText(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function slug(value: string) {
  return (
    value
      .toLocaleLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'research-publication'
  )
}

function validNoteReferences(
  value: string,
  references?: Array<{
    id: string
    target: string
    start: number
    end: number
  }>,
) {
  return (references ?? []).filter(
    (reference) =>
      reference.start >= 0 &&
      reference.start < reference.end &&
      reference.end <= value.length,
  )
}

function renderTextWithNoteReferences(
  value: string,
  references?: Array<{
    id: string
    target: string
    start: number
    end: number
  }>,
  inlineRuns?: Array<{
    start: number
    end: number
    bold?: boolean
    italic?: boolean
    href?: string
    verticalAlign?: 'superscript' | 'subscript'
    relationshipId?: string
    semanticRole?:
      | 'citation'
      | 'cross-reference'
      | 'affiliation-marker'
      | 'bibliography-entry'
    targetIds?: string[]
  }>,
) {
  if (!references?.length && !inlineRuns?.length) return text(value)
  const validReferences = validNoteReferences(value, references)
  const validRuns = (inlineRuns ?? []).filter(
    (run) => run.start >= 0 && run.start < run.end && run.end <= value.length,
  )
  const boundaries = [
    0,
    value.length,
    ...validReferences.flatMap((reference) => [reference.start, reference.end]),
    ...validRuns.flatMap((run) => [run.start, run.end]),
  ]
  const points = [...new Set(boundaries)].sort((left, right) => left - right)
  type Wrapper =
    | { kind: 'note'; id: string; target: string }
    | { kind: 'hyperlink'; href: string }
    | {
        kind: 'semantic-hyperlink'
        href: string
        relationshipId: string
        semanticRole: NonNullable<
          NonNullable<typeof inlineRuns>[number]['semanticRole']
        >
      }
    | {
        kind: 'semantic'
        relationshipId: string
        semanticRole: NonNullable<
          NonNullable<typeof inlineRuns>[number]['semanticRole']
        >
        targetIds: string[]
      }
  const segments: Array<{ html: string; wrapper?: Wrapper; key: string }> = []
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]
    const end = points[index + 1]
    if (start === end) continue
    const activeRuns = validRuns.filter(
      (candidate) => candidate.start <= start && candidate.end >= end,
    )
    const reference = validReferences.find(
      (candidate) => candidate.start <= start && candidate.end >= end,
    )
    let segment = text(value.slice(start, end))
    if (activeRuns.some((run) => run.italic)) segment = `<em>${segment}</em>`
    if (activeRuns.some((run) => run.bold))
      segment = `<strong>${segment}</strong>`
    const verticalAlign = activeRuns.find(
      (run) => run.verticalAlign,
    )?.verticalAlign
    if (verticalAlign === 'superscript') segment = `<sup>${segment}</sup>`
    if (verticalAlign === 'subscript') segment = `<sub>${segment}</sub>`
    const hyperlinkRun = activeRuns.find(
      (run) => run.href && safeHref(run.href),
    )
    const semanticRun = activeRuns.find(
      (run) => run.semanticRole && run.relationshipId,
    )
    let wrapper: Wrapper | undefined
    if (reference) {
      wrapper = { kind: 'note', id: reference.id, target: reference.target }
    } else if (
      hyperlinkRun?.href &&
      semanticRun?.semanticRole &&
      semanticRun.relationshipId &&
      (semanticRun.targetIds?.length ?? 0) === 0
    ) {
      wrapper = {
        kind: 'semantic-hyperlink',
        href: hyperlinkRun.href,
        relationshipId: semanticRun.relationshipId,
        semanticRole: semanticRun.semanticRole,
      }
    } else if (hyperlinkRun?.href) {
      wrapper = { kind: 'hyperlink', href: hyperlinkRun.href }
    } else if (semanticRun?.semanticRole && semanticRun.relationshipId) {
      wrapper = {
        kind: 'semantic',
        relationshipId: semanticRun.relationshipId,
        semanticRole: semanticRun.semanticRole,
        targetIds: [...new Set(semanticRun.targetIds ?? [])],
      }
    }
    const key = wrapper ? JSON.stringify(wrapper) : ''
    const previous = segments.at(-1)
    if (previous?.key === key) previous.html += segment
    else segments.push({ html: segment, wrapper, key })
  }

  const emittedIds = new Set<string>()
  const idAttribute = (rawId: string) => {
    const id = stableId(rawId)
    if (emittedIds.has(id)) return ''
    emittedIds.add(id)
    return ` id="${attribute(id)}"`
  }
  return segments
    .map(({ html, wrapper }) => {
      if (!wrapper) return html
      if (wrapper.kind === 'note') {
        return `<a${idAttribute(wrapper.id)} href="#${attribute(stableId(wrapper.target))}" epub:type="noteref">${html}</a>`
      }
      if (wrapper.kind === 'hyperlink') {
        return `<a href="${attribute(wrapper.href)}">${html}</a>`
      }
      if (wrapper.kind === 'semantic-hyperlink') {
        const relationshipId = stableId(wrapper.relationshipId)
        return `<span${idAttribute(relationshipId)} data-semantic-role="${attribute(wrapper.semanticRole)}" data-relationship-id="${attribute(relationshipId)}"${wrapper.semanticRole === 'citation' ? ' epub:type="biblioref"' : ''}><a href="${attribute(wrapper.href)}">${html}</a></span>`
      }
      const relationshipId = stableId(wrapper.relationshipId)
      const targets = wrapper.targetIds.map(stableId)
      if (wrapper.semanticRole === 'citation' && targets.length > 0) {
        if (targets.length === 1) {
          return `<a${idAttribute(relationshipId)} href="#${attribute(targets[0])}" epub:type="biblioref" data-relationship-id="${attribute(relationshipId)}">${html}</a>`
        }
        const links = targets
          .map((target, index) =>
            index === 0
              ? `<a href="#${attribute(target)}" epub:type="biblioref">${html}</a>`
              : `<a href="#${attribute(target)}" epub:type="biblioref" class="additional-biblioref" aria-label="Additional bibliographic target ${index + 1}"><span class="visually-hidden">${html}</span></a>`,
          )
          .join('')
        return `<span${idAttribute(relationshipId)} data-semantic-role="citation" data-relationship-id="${attribute(relationshipId)}" data-target-ids="${attribute(targets.join(' '))}" epub:type="biblioref">${links}</span>`
      }
      return `<span${idAttribute(relationshipId)} data-semantic-role="${attribute(wrapper.semanticRole)}" data-relationship-id="${attribute(relationshipId)}"${targets.length > 0 ? ` data-target-ids="${attribute(targets.join(' '))}"` : ''}${wrapper.semanticRole === 'citation' ? ' epub:type="biblioref"' : ''}>${html}</span>`
    })
    .join('')
}

function safeHref(value: string) {
  // Do not rely on WHATWG URL repair here: EPUBCheck rejects raw backslashes
  // and ASCII whitespace, while rewriting source hrefs could change targets.
  if (/[\u0000-\u0020\u007f\\]/u.test(value)) return false
  if (value.startsWith('#')) return true
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
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
  assetId?: string,
  captionId?: string,
) {
  const firstBodyRow = table.rows.findIndex(
    (row) => !row.cells.every((cell) => cell.headerScope === 'column'),
  )
  const headerRows =
    firstBodyRow === -1 ? table.rows : table.rows.slice(0, firstBodyRow)
  const bodyRows = firstBodyRow === -1 ? [] : table.rows.slice(firstBodyRow)
  const renderRows = (rows: typeof table.rows) =>
    rows
      .map(
        (row) =>
          `<tr>${row.cells
            .map((cell) => {
              const tag = cell.headerScope ? 'th' : 'td'
              const scope = cell.headerScope
                ? ` scope="${cell.headerScope === 'column' ? 'col' : 'row'}"`
                : ''
              const columnSpan =
                cell.columnSpan > 1 ? ` colspan="${cell.columnSpan}"` : ''
              const rowSpan =
                cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''
              return `<${tag}${scope}${columnSpan}${rowSpan}>${text(cell.text)}</${tag}>`
            })
            .join('')}</tr>`,
      )
      .join('')
  const source = assetId ? ` data-asset-id="${attribute(assetId)}"` : ''
  const describedBy = captionId
    ? ` aria-describedby="${attribute(captionId)}"`
    : ''
  return `<div class="semantic-table-wrapper" role="region" aria-label="Scrollable table" tabindex="0"${source}><table${describedBy}>${headerRows.length > 0 ? `<thead>${renderRows(headerRows)}</thead>` : ''}${bodyRows.length > 0 ? `<tbody>${renderRows(bodyRows)}</tbody>` : ''}</table></div>`
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
  return node.list.numberingId === 'references' || node.list.ordered
}

function renderPublicationListGroup(group: PublicationListGroup): string {
  const tag = group.ordered ? 'ol' : 'ul'
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
      return `<li id="${id}" data-canonical-id="${id}" class="publication-list-item${preservedMarker ? ' has-preserved-marker' : ''}" data-list-level="${node.list.level}"${value}${continued}>${preservedMarker}${renderTextWithNoteReferences(node.text, node.noteReferences, node.inlineRuns)}${children.map(renderPublicationListGroup).join('')}</li>`
    })
    .join('')
  const start =
    group.ordered && firstOrdinal !== undefined && firstOrdinal !== 1
      ? ` start="${firstOrdinal}"`
      : ''
  const type = group.ordered && listType ? ` type="${listType}"` : ''
  return `<${tag} class="publication-list" data-list-level="${group.level}" data-numbering-id="${attribute(group.numberingId)}" data-marker-style="${attribute(group.markerStyle ?? (group.ordered ? 'decimal' : 'disc'))}"${type}${start}>${items}</${tag}>`
}

function renderPublicationList(nodes: ListParagraphNode[]) {
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

  return roots.map(renderPublicationListGroup).join('')
}

function renderNode(
  node: ResearchNode,
  captions: Map<string, Extract<ResearchNode, { type: 'caption' }>>,
  visualRelationships: Map<string, PublicationVisualRelationship>,
  assets: Map<string, PublicationAsset>,
  omitMissingVisuals = false,
  canonicalTitleNodeId?: string,
  renderedNoteReferenceIds: ReadonlySet<string> = new Set(),
) {
  const id = attribute(stableId(node.id))
  if (node.type === 'heading') {
    const level =
      node.id === canonicalTitleNodeId
        ? 1
        : Math.min(3, Math.max(2, node.level + 1))
    return `<h${level} id="${id}" data-canonical-id="${id}">${renderTextWithNoteReferences(node.text, node.noteReferences, node.inlineRuns)}</h${level}>`
  }
  if (node.type === 'paragraph') {
    return `<p id="${id}" data-canonical-id="${id}">${renderTextWithNoteReferences(node.text, node.noteReferences, node.inlineRuns)}</p>`
  }
  if (node.type === 'quote') {
    return `<blockquote id="${id}" data-canonical-id="${id}"><p>${renderTextWithNoteReferences(node.text, node.noteReferences, node.inlineRuns)}</p></blockquote>`
  }
  if (node.type === 'footnote') {
    const backlinks = node.relationships.backlinks
      .filter((backlink) => renderedNoteReferenceIds.has(stableId(backlink)))
      .map(
        (backlink, index) =>
          `<a href="#${attribute(stableId(backlink))}" class="note-backlink" aria-label="Back to reference ${index + 1}">↩</a>`,
      )
      .join(' ')
    return `<aside id="${id}" data-canonical-id="${id}" epub:type="footnote" role="doc-${node.kind}" data-note-kind="${node.kind}" class="publication-note"><span class="note-label">${text(node.markerText ?? node.label)}</span> ${text(node.text)}${backlinks ? ` ${backlinks}` : ''}</aside>`
  }
  if (node.type === 'figure') {
    const caption = captions.get(node.relationships.caption)
    const captionId = attribute(stableId(node.relationships.caption))
    const visual = visualRelationships.get(node.id)
    if (visual) {
      const visualAssets = visual.assetIds
        .map((assetId) => assets.get(assetId))
        .filter((visualAsset): visualAsset is PublicationAsset =>
          Boolean(visualAsset),
        )
      const semanticTableAsset = visualAssets.find(
        (visualAsset) =>
          visualAsset.mediaType === 'application/xhtml+xml' &&
          visualAsset.kind === 'table',
      )
      const renderedAssets =
        visual.kind === 'table' && node.table && semanticTableAsset
          ? renderSemanticTable(node.table, semanticTableAsset.id, captionId)
          : visualAssets
              .map((visualAsset) => {
                const href = attribute(visualAsset.href)
                const alt = attribute(visual.altText)
                if (visualAsset.mediaType === 'application/xhtml+xml') {
                  return `<object data="${href}" type="application/xhtml+xml" aria-label="${alt}" data-alt-source="${visual.altTextSource}"><p>${text(visual.altText)}</p></object>`
                }
                const width = Math.max(1, Math.round(visualAsset.width))
                const height = Math.max(1, Math.round(visualAsset.height))
                return `<img src="${href}" width="${width}" height="${height}" loading="lazy" decoding="async" alt="${alt}" data-alt-source="${visual.altTextSource}" data-asset-id="${attribute(visualAsset.id)}" />`
              })
              .join('')
      const sourceEquationCaption =
        visual.kind === 'equation' && visual.altTextSource === 'source-text'
      const sourceTranscript = node.sourceText
        ? `<span class="visually-hidden visual-source-transcript" data-source-transcript-for="${id}">${renderTextWithNoteReferences(node.sourceText, undefined, node.inlineRuns)}</span>`
        : ''
      const figureClass =
        visual.kind === 'table' && node.table
          ? ' class="semantic-table-figure"'
          : ''
      return `<figure id="${id}" data-canonical-id="${id}" data-caption-id="${captionId}" data-object-type="${visual.kind}" role="group"${figureClass}>${renderedAssets}${sourceTranscript}${caption ? `<figcaption id="${captionId}" data-canonical-id="${captionId}"${sourceEquationCaption ? ' class="equation-source-text"' : ''}>${text(caption.text)}</figcaption>` : ''}</figure>`
    }
    if (omitMissingVisuals) {
      return `<aside id="${id}" data-canonical-id="${id}" data-caption-id="${captionId}" class="omitted-visual" role="note"><p>Visual omitted from this readable fallback because its source fragments do not form a bounded rendition.</p>${caption ? `<p id="${captionId}" data-canonical-id="${captionId}" class="omitted-visual-caption">${text(caption.text)}</p>` : ''}</aside>`
    }
    return `<figure id="${id}" data-canonical-id="${id}" data-caption-id="${captionId}" role="group"><div class="figure-placeholder" role="img" aria-label="${attribute(node.title)}">${text(node.title)}</div>${caption ? `<figcaption id="${captionId}" data-canonical-id="${captionId}">${text(caption.text)}</figcaption>` : ''}</figure>`
  }
  return ''
}

export function renderPublicationXhtml(
  paper: ResearchPaper,
  options: {
    embedStyles?: boolean
    reconstruction?: DocumentReconstruction
    styles?: string
    visualAssets?: Map<string, PublicationAsset>
  } = {},
) {
  const captions = new Map(
    paper.nodes
      .filter(
        (node): node is Extract<ResearchNode, { type: 'caption' }> =>
          node.type === 'caption',
      )
      .map((node) => [node.id, node]),
  )
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
      .filter(
        (relationship) =>
          relationship.status === 'matched' && relationship.canonicalNodeId,
      )
      .map((relationship) => [relationship.canonicalNodeId!, relationship]),
  )
  const assets =
    options.visualAssets ??
    new Map(
      (options.reconstruction?.assets ?? []).map((visualAsset) => [
        visualAsset.id,
        visualAsset,
      ]),
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
  const renderableNodes = paper.nodes.filter(
    (node) => node.type !== 'caption' || !associatedCaptions.has(node.id),
  )
  const renderedNoteReferenceIds = new Set([
    ...(paper.authorNotes ?? []).map((reference) => stableId(reference.id)),
    ...renderableNodes.flatMap((node) =>
      node.type === 'heading' ||
      node.type === 'paragraph' ||
      node.type === 'quote'
        ? validNoteReferences(node.text, node.noteReferences).map((reference) =>
            stableId(reference.id),
          )
        : [],
    ),
  ])
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
      renderedNodes.push(renderPublicationList(listNodes))
      continue
    }
    renderedNodes.push(
      node.type === 'caption'
        ? `<aside id="${attribute(stableId(node.id))}" data-canonical-id="${attribute(stableId(node.id))}" class="orphan-caption">${text(node.text)}</aside>`
        : renderNode(
            node,
            captions,
            visualRelationships,
            assets,
            omitMissingVisuals,
            canonicalTitleNode?.id,
            renderedNoteReferenceIds,
          ),
    )
  }
  const body = renderedNodes.join('\n')
  const publicationHeader = reconstructed
    ? canonicalTitleNode
      ? ''
      : `<header class="reconstructed-header">
      <h1 id="publication-title">${text(paper.title)}</h1>
      <p class="authors">${renderAuthors(paper)}</p>
      ${paper.affiliations?.length ? `<p class="affiliations">${paper.affiliations.map(text).join('; ')}</p>` : ''}
    </header>`
    : `<header class="publication-header">
      <p class="status">${text(paper.status)} · ${text(paper.updated)}</p>
      <h1 id="publication-title">${text(paper.title)}</h1>
      <p class="subtitle">${text(paper.subtitle)}</p>
      <p class="authors">${renderAuthors(paper)}</p>
      ${paper.affiliations?.length ? `<p class="affiliations">${paper.affiliations.map(text).join('; ')}</p>` : ''}
      <section class="abstract" aria-labelledby="abstract-title">
        <h2 id="abstract-title">Abstract</h2>
        <p>${text(paper.abstract)}</p>
      </section>
    </header>`

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Publication</title>
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
}

function navXhtml(paper: ResearchPaper) {
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
  const items = [
    `<li><a href="${titleHref}">${text(paper.title)}</a></li>`,
    ...headings.map(
      (node) =>
        `<li><a href="content.xhtml#${attribute(stableId(node.id))}">${text(node.text)}</a></li>`,
    ),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><meta charset="UTF-8" /><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc" aria-label="Table of contents">
    <h1>Contents</h1>
    <ol>${items.join('\n')}</ol>
  </nav>
</body>
</html>
`
}

const EPUB_CSS = `
:root { color-scheme: light; }
*, *::before, *::after { box-sizing: border-box; }
html { font-size: 100%; max-width: 100%; }
body { margin: 0; max-width: 100%; color: #111; background: #fff; font-family: Georgia, "Times New Roman", serif; line-height: 1.62; }
main { box-sizing: border-box; width: 100%; max-width: 42rem; margin: 0 auto; padding: 5%; }
.publication-header { border-bottom: 0.08rem solid currentColor; margin-bottom: 2.5rem; padding-bottom: 2rem; }
.reconstructed-header { margin-bottom: 2rem; }
.status, .authors { font-family: sans-serif; font-size: 0.78rem; letter-spacing: 0.04em; }
h1 { font-size: 2.2rem; line-height: 1.05; margin: 0.5rem 0 0.75rem; }
h2 { font-size: 1.45rem; margin: 2.4rem 0 0.6rem; break-after: avoid; }
h3 { font-size: 1.15rem; margin: 2rem 0 0.5rem; break-after: avoid; }
p { margin: 0.8rem 0; orphans: 3; widows: 3; }
h1, h2, h3, p, figcaption, .orphan-caption, .publication-note, .publication-list, .publication-list-item { overflow-wrap: anywhere; word-break: break-word; }
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
.publication-note { border-top: 0.06rem solid currentColor; font-size: 0.84rem; margin-top: 1rem; padding-top: 0.5rem; }
.note-label { font-weight: bold; }
.note-backlink { margin-inline-start: 0.35rem; }
.publication-list { max-width: 100%; min-width: 0; margin: 0.8rem 0; padding-inline-start: 1.5rem; }
.publication-list .publication-list { margin: 0.35rem 0 0; }
.publication-list-item { margin: 0.35rem 0; }
.publication-list-item.has-preserved-marker { list-style-type: none; }
.publication-list-marker { display: inline-block; margin-inline-end: 0.4em; }
.visually-hidden { position: absolute; inline-size: 1px; block-size: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.semantic-table-wrapper { max-width: 100%; overflow-x: auto; }
.semantic-table-figure, .semantic-table-wrapper, .semantic-table-wrapper table { break-inside: auto; }
.semantic-table-wrapper table { border-collapse: collapse; font-size: 0.86rem; line-height: 1.35; min-width: 0; table-layout: fixed; width: 100%; }
.semantic-table-wrapper thead { display: table-header-group; }
.semantic-table-figure > figcaption { break-before: avoid; }
.semantic-table-wrapper tr { break-inside: avoid; }
.semantic-table-wrapper th, .semantic-table-wrapper td { border: 0.06rem solid currentColor; padding: 0.3rem 0.4rem; text-align: start; vertical-align: top; }
.semantic-table-wrapper th, .semantic-table-wrapper td { overflow-wrap: anywhere; word-break: break-word; }
.semantic-table-wrapper th { font-weight: bold; }
img, svg { display: block; height: auto; max-width: 100%; }
object { border: 0; display: block; min-height: 8rem; width: 100%; }
a { color: inherit; text-decoration: underline; }
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
  return `${EPUB_CSS}
/* Profile values are derived from src/research/targets.ts (${profile.id}@${profile.version}). */
html { font-size: ${profile.typography.bodySizeCssPx}px; }
body { font-family: ${profile.typography.fontFamily}; line-height: ${profile.typography.lineHeight}; }
main { max-width: none; padding: ${percentage(profile.margins.top, width)} ${percentage(profile.margins.right, width)} ${percentage(profile.margins.bottom, width)} ${percentage(profile.margins.left, width)}; }
h1 { font-size: ${profile.typography.titleSizeCssPx}px; }
h2, h3 { font-size: ${profile.typography.headingSizeCssPx}px; }
blockquote { font-size: ${profile.typography.quoteSizeCssPx}px; }
@page { margin: 0; }
`
}

type PackagedAsset = {
  source: PublicationAsset
  asset: PublicationAsset
  policy: {
    id: 'fit-device-content-width-no-upscale'
    version: typeof EPUB_EXPORT_POLICY_VERSION
    action: 'preserved' | 'downscaled' | 'scalable-source'
    sourceWidth: number
    sourceHeight: number
    packagedWidth: number
    packagedHeight: number
    maximumWidth: number | null
    targetPixelsPerInch: number | null
    sourcePixelsPerInch: number | null
    resampling: 'none' | 'nearest-neighbor-rgba'
    neverUpscaled: true
  }
}

async function packageVisualAssets(
  assets: readonly PublicationAsset[],
  profile?: TargetProfile,
) {
  const maximumWidth =
    profile?.dimensions.unit === 'device-px'
      ? profile.dimensions.width - profile.margins.left - profile.margins.right
      : null
  return Promise.all(
    assets.map(async (source): Promise<PackagedAsset> => {
      const asset =
        maximumWidth !== null &&
        profile?.pixelsPerInch !== null &&
        profile?.pixelsPerInch !== undefined
          ? await downscalePngAsset(source, maximumWidth, profile.pixelsPerInch)
          : source
      return {
        source,
        asset,
        policy: {
          id: 'fit-device-content-width-no-upscale',
          version: EPUB_EXPORT_POLICY_VERSION,
          action:
            source.mediaType === 'image/svg+xml'
              ? 'scalable-source'
              : source.mediaType !== 'image/png' ||
                  asset.sha256 === source.sha256
                ? 'preserved'
                : 'downscaled',
          sourceWidth: source.width,
          sourceHeight: source.height,
          packagedWidth: asset.width,
          packagedHeight: asset.height,
          maximumWidth,
          targetPixelsPerInch: profile?.pixelsPerInch ?? null,
          sourcePixelsPerInch: source.resolutionDpi,
          resampling:
            asset.sha256 === source.sha256 ? 'none' : 'nearest-neighbor-rgba',
          neverUpscaled: true,
        },
      }
    }),
  )
}

function uniqueAssets(packaged: readonly PackagedAsset[]) {
  return [...new Map(packaged.map(({ asset }) => [asset.id, asset])).values()]
}

function containerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
`
}

function packageOpf(
  paper: ResearchPaper,
  identifier: string,
  modified: string,
  assets: PublicationAsset[] = [],
  profile?: TargetProfile,
) {
  const assetItems = assets
    .map(
      (visualAsset) =>
        `<item id="${attribute(stableId(visualAsset.id))}" href="${attribute(visualAsset.href)}" media-type="${attribute(visualAsset.mediaType)}" />`,
    )
    .join('\n    ')
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="publication-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="publication-id">${text(identifier)}</dc:identifier>
    <dc:title>${text(paper.title)}</dc:title>
    <dc:language>en</dc:language>
    ${paper.authors.map((author) => `<dc:creator>${text(author)}</dc:creator>`).join('\n    ')}
    <dc:date>${text(paper.updated)}</dc:date>
    <meta property="dcterms:modified">${text(modified)}</meta>
    ${
      profile
        ? `<meta property="rendition:layout">reflowable</meta>
    <meta property="rendition:flow">${profile.epub.renditionFlow}</meta>
    <meta property="rendition:spread">none</meta>`
        : ''
    }
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml" />
    <item id="styles" href="styles.css" media-type="text/css" />
    <item id="export-manifest" href="export.json" media-type="application/json" />
    ${assetItems}
  </manifest>
  <spine${profile ? ` page-progression-direction="${profile.epub.pageProgressionDirection}"` : ''}>
    <itemref idref="content" />
  </spine>
</package>
`
}

function entry(value: string, level: 0 | 6 = 6): [Uint8Array, ZipOptions] {
  return [strToU8(value), { level, mtime: ZIP_MTIME }]
}

function binaryEntry(value: Uint8Array): [Uint8Array, ZipOptions] {
  return [value, { level: 6, mtime: ZIP_MTIME }]
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotateRight(value: number, count: number) {
  return (value >>> count) | (value << (32 - count))
}

function sha256Sync(bytes: Uint8Array) {
  const bitLength = bytes.byteLength * 8
  const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.byteLength] = 0x80
  const paddedView = new DataView(padded.buffer)
  paddedView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000))
  paddedView.setUint32(paddedLength - 4, bitLength >>> 0)

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ])
  const words = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = paddedView.getUint32(offset + index * 4)
    }
    for (let index = 16; index < 64; index += 1) {
      const before15 = words[index - 15]
      const before2 = words[index - 2]
      const sigma0 =
        rotateRight(before15, 7) ^ rotateRight(before15, 18) ^ (before15 >>> 3)
      const sigma1 =
        rotateRight(before2, 17) ^ rotateRight(before2, 19) ^ (before2 >>> 10)
      words[index] =
        (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = state
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temporary1 =
        (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temporary2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temporary1) >>> 0
      d = c
      c = b
      b = a
      a = (temporary1 + temporary2) >>> 0
    }
    state[0] = (state[0] + a) >>> 0
    state[1] = (state[1] + b) >>> 0
    state[2] = (state[2] + c) >>> 0
    state[3] = (state[3] + d) >>> 0
    state[4] = (state[4] + e) >>> 0
    state[5] = (state[5] + f) >>> 0
    state[6] = (state[6] + g) >>> 0
    state[7] = (state[7] + h) >>> 0
  }
  return [...state].map((word) => word.toString(16).padStart(8, '0')).join('')
}

function requireWellFormedXml(value: string, documentName: string) {
  if (XMLValidator.validate(value) !== true) {
    throw new Error(`${documentName} must be well-formed XML`)
  }
}

function tagAttributes(tag: string) {
  return new Map(
    [
      ...tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g),
    ].map((match) => [match[1], match[2] ?? match[3]]),
  )
}

function xmlAttributeValues(value: string, name: string) {
  const values: string[] = []
  for (const match of value.matchAll(/<[^!?][^>]*>/g)) {
    const attributeValue = tagAttributes(match[0]).get(name)
    if (attributeValue !== undefined) values.push(attributeValue)
  }
  return values
}

function inspectOpfPackage(opf: string, files: Record<string, Uint8Array>) {
  const items = [...opf.matchAll(/<item\b[^>]*\/?\s*>/g)].map((match) => {
    const attributes = tagAttributes(match[0])
    const item = {
      id: attributes.get('id') ?? '',
      href: attributes.get('href') ?? '',
      mediaType: attributes.get('media-type') ?? '',
      properties: attributes.get('properties') ?? '',
    }
    if (!item.id || !item.href || !item.mediaType) {
      throw new Error('EPUB OPF manifest item is missing required metadata')
    }
    if (
      item.href.startsWith('/') ||
      item.href.includes('\\') ||
      item.href.split('/').includes('..') ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(item.href)
    ) {
      throw new Error(`EPUB manifest href is unsafe: ${item.href}`)
    }
    return item
  })
  const ids = items.map(({ id }) => id)
  const hrefs = items.map(({ href }) => href)
  if (new Set(ids).size !== ids.length) {
    throw new Error('EPUB OPF contains a duplicate manifest id')
  }
  if (new Set(hrefs).size !== hrefs.length) {
    throw new Error('EPUB OPF contains a duplicate manifest href')
  }
  const byId = new Map(items.map((item) => [item.id, item]))
  for (const item of items) {
    if (!files[`EPUB/${item.href}`]) {
      throw new Error(`EPUB manifest has dangling reference ${item.href}`)
    }
  }
  const spineReferences = [...opf.matchAll(/<itemref\b[^>]*\/?\s*>/g)].map(
    (match) => tagAttributes(match[0]).get('idref') ?? '',
  )
  if (spineReferences.length === 0 || spineReferences.some((id) => !id)) {
    throw new Error('EPUB OPF spine is missing a content reference')
  }
  if (new Set(spineReferences).size !== spineReferences.length) {
    throw new Error('EPUB OPF spine contains a duplicate content reference')
  }
  for (const idref of spineReferences) {
    const item = byId.get(idref)
    if (!item) throw new Error(`EPUB spine references missing item ${idref}`)
    if (item.mediaType !== 'application/xhtml+xml') {
      throw new Error(`EPUB spine item ${idref} is not XHTML content`)
    }
  }
  if (
    spineReferences.length !== 1 ||
    byId.get(spineReferences[0])?.href !== 'content.xhtml'
  ) {
    throw new Error(
      'EPUB spine must resolve exactly to the previewed content.xhtml document',
    )
  }
  const navigation = items.filter((item) =>
    item.properties.split(/\s+/).includes('nav'),
  )
  if (
    navigation.length !== 1 ||
    navigation[0].mediaType !== 'application/xhtml+xml'
  ) {
    throw new Error('EPUB OPF must declare exactly one XHTML navigation item')
  }
  return {
    items,
    byId,
    byHref: new Map(items.map((item) => [item.href, item])),
  }
}

function pngCrc32(bytes: Uint8Array) {
  let crc = 0xffff_ffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0)
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

function validPngStructure(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (
    bytes.length < 45 ||
    signature.some((value, index) => bytes[index] !== value)
  ) {
    return false
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = signature.length
  let firstChunk = true
  let sawImageData = false
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    if (length > bytes.length - offset - 12) return false
    const typeOffset = offset + 4
    const dataOffset = offset + 8
    const crcOffset = dataOffset + length
    const nextOffset = crcOffset + 4
    const type = strFromU8(bytes.subarray(typeOffset, dataOffset))
    if (!/^[A-Za-z]{4}$/.test(type)) return false
    if (
      pngCrc32(bytes.subarray(typeOffset, crcOffset)) !==
      view.getUint32(crcOffset)
    ) {
      return false
    }
    if (firstChunk) {
      if (type !== 'IHDR' || length !== 13) return false
      const width = view.getUint32(dataOffset)
      const height = view.getUint32(dataOffset + 4)
      const bitDepth = bytes[dataOffset + 8]
      const colorType = bytes[dataOffset + 9]
      const validBitDepth =
        (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
        ((colorType === 2 || colorType === 4 || colorType === 6) &&
          [8, 16].includes(bitDepth)) ||
        (colorType === 3 && [1, 2, 4, 8].includes(bitDepth))
      if (
        width === 0 ||
        height === 0 ||
        width > 0x7fff_ffff ||
        height > 0x7fff_ffff ||
        !validBitDepth ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        ![0, 1].includes(bytes[dataOffset + 12])
      ) {
        return false
      }
    } else if (type === 'IHDR') {
      return false
    }
    if (
      type.charCodeAt(0) >= 65 &&
      type.charCodeAt(0) <= 90 &&
      !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)
    ) {
      return false
    }
    if (type === 'IDAT') sawImageData = true
    if (type === 'IEND') {
      return length === 0 && sawImageData && nextOffset === bytes.length
    }
    firstChunk = false
    offset = nextOffset
  }
  return false
}

function validJpegStructure(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return false
  }
  const frameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ])
  let offset = 2
  let sawFrame = false
  let sawScan = false
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) return false
    const marker = bytes[offset]
    offset += 1
    if (marker === 0x00 || marker === 0xd8) return false
    if (marker === 0xd9) {
      return sawFrame && sawScan && offset === bytes.length
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) return false
    const length = (bytes[offset] << 8) | bytes[offset + 1]
    if (length < 2 || length > bytes.length - offset) return false
    if (frameMarkers.has(marker)) sawFrame = true
    if (marker !== 0xda) {
      offset += length
      continue
    }
    sawScan = true
    offset += length
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const markerOffset = offset
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
      if (offset >= bytes.length) return false
      const scanMarker = bytes[offset]
      if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
        offset += 1
        continue
      }
      offset = markerOffset
      break
    }
  }
  return false
}

function skipGifSubBlocks(bytes: Uint8Array, start: number) {
  let offset = start
  while (offset < bytes.length) {
    const length = bytes[offset]
    offset += 1
    if (length === 0) return offset
    if (length > bytes.length - offset) return -1
    offset += length
  }
  return -1
}

function validGifStructure(bytes: Uint8Array) {
  if (
    bytes.length < 14 ||
    !/^GIF8[79]a$/.test(strFromU8(bytes.subarray(0, 6)))
  ) {
    return false
  }
  const width = bytes[6] | (bytes[7] << 8)
  const height = bytes[8] | (bytes[9] << 8)
  if (width === 0 || height === 0) return false
  const globalColorTableBytes =
    bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 0x07) + 1) : 0
  let offset = 13 + globalColorTableBytes
  if (offset > bytes.length) return false
  let sawImage = false
  while (offset < bytes.length) {
    const blockType = bytes[offset]
    offset += 1
    if (blockType === 0x3b) return sawImage && offset === bytes.length
    if (blockType === 0x21) {
      if (offset >= bytes.length) return false
      offset = skipGifSubBlocks(bytes, offset + 1)
      if (offset < 0) return false
      continue
    }
    if (blockType !== 0x2c || offset + 9 > bytes.length) return false
    const imageWidth = bytes[offset + 4] | (bytes[offset + 5] << 8)
    const imageHeight = bytes[offset + 6] | (bytes[offset + 7] << 8)
    if (imageWidth === 0 || imageHeight === 0) return false
    const localColorTableBytes =
      bytes[offset + 8] & 0x80 ? 3 * 2 ** ((bytes[offset + 8] & 0x07) + 1) : 0
    offset += 9 + localColorTableBytes
    if (offset >= bytes.length || bytes[offset] === 0) return false
    offset = skipGifSubBlocks(bytes, offset + 1)
    if (offset < 0) return false
    sawImage = true
  }
  return false
}

function validateAssetMedia(
  bytes: Uint8Array,
  mediaType: string,
  href: string,
) {
  const valid =
    mediaType === 'image/png'
      ? validPngStructure(bytes)
      : mediaType === 'image/jpeg'
        ? validJpegStructure(bytes)
        : mediaType === 'image/gif'
          ? validGifStructure(bytes)
          : mediaType === 'image/svg+xml' ||
              mediaType === 'application/xhtml+xml'
            ? (() => {
                const value = strFromU8(bytes)
                requireWellFormedXml(value, `EPUB asset ${href}`)
                return mediaType === 'image/svg+xml'
                  ? /<svg\b/.test(value)
                  : /<html\b/.test(value)
              })()
            : false
  if (!valid) {
    throw new Error(`EPUB asset ${href} bytes do not match ${mediaType}`)
  }
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
    if (sha256Sync(bytes) !== asset.sha256) {
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

function validateFragmentHrefs(
  value: string,
  localIds: ReadonlySet<string>,
  contentIds: ReadonlySet<string>,
  documentName: string,
) {
  for (const href of xmlAttributeValues(value, 'href')) {
    const target = href.startsWith('#')
      ? { id: href.slice(1), ids: localIds }
      : href.startsWith('content.xhtml#')
        ? { id: href.slice('content.xhtml#'.length), ids: contentIds }
        : null
    if (target && (!target.id || !target.ids.has(target.id))) {
      throw new Error(`${documentName} has dangling internal reference ${href}`)
    }
  }
}

export function inspectEpub(
  bytes: Uint8Array,
  expectedProfile?: TargetProfile,
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
  const contentIds = xhtmlIds(content, 'EPUB content')
  const navigationIds = xhtmlIds(navigation, 'EPUB navigation')
  validateFragmentHrefs(content, contentIds, contentIds, 'EPUB content')
  validateFragmentHrefs(
    navigation,
    navigationIds,
    contentIds,
    'EPUB navigation',
  )
  const manifest = JSON.parse(strFromU8(files['EPUB/export.json'])) as {
    schemaVersion?: unknown
    exportMode?: unknown
    rendition?: unknown
    canonicalNodeIds?: unknown
    excludedCanonicalNodeIds?: unknown
    canonicalContentSha256?: unknown
    sourceCanonicalContentSha256?: unknown
    profile?: unknown
    assets?: unknown[]
    visualRelationships?: unknown[]
  }
  const expectedRendition =
    manifest.exportMode === 'readable-fallback'
      ? 'readable-fallback-reflowable-epub'
      : manifest.exportMode === 'publication'
        ? manifest.profile
          ? 'profile-tuned-reflowable-epub'
          : 'reflowable-epub'
        : undefined
  if (
    manifest.schemaVersion !== EPUB_EXPORT_SCHEMA_VERSION ||
    expectedRendition === undefined ||
    manifest.rendition !== expectedRendition ||
    (manifest.profile !== undefined &&
      (!manifest.profile || typeof manifest.profile !== 'object'))
  ) {
    throw new Error(
      `EPUB ${expectedProfile ? 'profiled ' : ''}export manifest contract is invalid`,
    )
  }
  if (
    expectedProfile &&
    canonicalJson(manifest.profile) !==
      canonicalJson(profileManifestReceipt(expectedProfile))
  ) {
    throw new Error('EPUB profiled export manifest contract is invalid')
  }
  const canonicalNodeIds = manifest.canonicalNodeIds
  if (
    !Array.isArray(canonicalNodeIds) ||
    canonicalNodeIds.length === 0 ||
    canonicalNodeIds.some(
      (id) => typeof id !== 'string' || id.trim().length === 0,
    )
  ) {
    throw new Error(
      'EPUB canonicalNodeIds receipt must contain non-empty strings',
    )
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
  paper: ResearchPaper,
  reconstructionOrProfile?: DocumentReconstruction | TargetProfile,
  profileInput?: TargetProfile,
): Promise<EpubExport> {
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

function hasReadableText(paper: ResearchPaper) {
  return paper.nodes.some((node) => {
    if ('text' in node) return node.text.trim().length > 0
    return node.type === 'figure' && node.title.trim().length > 0
  })
}

function isSolidFillVectorFragment(asset: PublicationAsset) {
  if (
    asset.mediaType !== 'image/svg+xml' ||
    asset.bytes.length > 1024 ||
    !asset.sourceBoxes.some((box) => box.width >= 0.2 && box.height >= 0.1)
  ) {
    return false
  }
  const svg = strFromU8(asset.bytes)
  if (
    (svg.match(/<(?:path|rect)\b/g) ?? []).length !== 1 ||
    !/fill=["']#000(?:000)?["']/i.test(svg) ||
    !/stroke=["']none["']/i.test(svg)
  ) {
    return false
  }
  const viewBox = svg
    .match(/viewBox=["']([^"']+)["']/i)?.[1]
    ?.trim()
    .split(/\s+/)
    .map(Number)
  const path = svg.match(/<path\b[^>]*\bd=["']([^"']+)["']/i)?.[1]
  const coordinates = path?.match(/-?\d+(?:\.\d+)?/g)?.map(Number)
  if (
    !viewBox ||
    viewBox.length !== 4 ||
    !coordinates ||
    coordinates.length !== 8 ||
    !/^(?:\s*[ML]\s*-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?){4}\s*Z\s*$/i.test(path!)
  ) {
    return false
  }
  const [x, y, width, height] = viewBox
  const xs = coordinates.filter((_, index) => index % 2 === 0)
  const ys = coordinates.filter((_, index) => index % 2 === 1)
  const tolerance = Math.max(width, height) * 0.0001
  return (
    Math.abs(Math.min(...xs) - x) <= tolerance &&
    Math.abs(Math.max(...xs) - (x + width)) <= tolerance &&
    Math.abs(Math.min(...ys) - y) <= tolerance &&
    Math.abs(Math.max(...ys) - (y + height)) <= tolerance
  )
}

export function projectReadableFallbackReconstruction(
  reconstruction: PdfReconstruction,
): PdfReconstruction {
  if (
    reconstruction.completeness.ocrRequiredPages.length > 0 ||
    !hasReadableText(reconstruction.paper)
  ) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      'A readable EPUB requires recovered text for every source page; run local OCR first.',
    )
  }
  const availableAssetIds = new Set(
    reconstruction.assets
      .filter((asset) => !isSolidFillVectorFragment(asset))
      .map((asset) => asset.id),
  )
  let selectedAssetCount = 0
  const relationships = validatedPdfVisualRelationships({
    paper: reconstruction.paper,
    provenance: reconstruction.provenance,
    relationships: reconstruction.visualRelationships,
    assets: reconstruction.assets,
  }).flatMap((relationship) => {
    const nextAssetCount = selectedAssetCount + relationship.assetIds.length
    const accepted =
      relationship.assetIds.length <= MAX_READABLE_FALLBACK_ASSETS_PER_VISUAL &&
      nextAssetCount <= MAX_READABLE_FALLBACK_ASSETS_PER_BOOK &&
      relationship.assetIds.every((assetId) => availableAssetIds.has(assetId))
    if (accepted) selectedAssetCount = nextAssetCount
    return accepted ? [relationship] : []
  })
  const selectedAssetIds = new Set(
    relationships.flatMap((relationship) => relationship.assetIds),
  )
  const retainedFigureIds = new Set(
    relationships.map((relationship) => relationship.canonicalNodeId!),
  )
  const retainedCaptionIds = new Set(
    relationships.map((relationship) => relationship.captionNodeId!),
  )
  const paper = {
    ...reconstruction.paper,
    nodes: reconstruction.paper.nodes.filter((node) =>
      node.type === 'figure'
        ? retainedFigureIds.has(node.id)
        : node.type === 'caption'
          ? retainedCaptionIds.has(node.id)
          : true,
    ),
  }
  const retainedNodeIds = new Set(paper.nodes.map((node) => node.id))
  const excludedCanonicalNodeIds = new Set(
    reconstruction.paper.nodes
      .filter((node) => !retainedNodeIds.has(node.id))
      .map((node) => node.id),
  )
  const danglingTarget = paper.nodes
    .flatMap((node) => ('inlineRuns' in node ? (node.inlineRuns ?? []) : []))
    .flatMap((run) => run.targetIds ?? [])
    .find((targetId) => excludedCanonicalNodeIds.has(targetId))
  if (danglingTarget) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      `A readable EPUB cannot safely omit rejected visual target ${danglingTarget}.`,
    )
  }
  if (!hasReadableText(paper)) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      'A readable EPUB requires recovered text after unvalidated visuals are omitted.',
    )
  }
  return {
    ...reconstruction,
    paper,
    provenance: Object.fromEntries(
      Object.entries(reconstruction.provenance).filter(
        ([nodeId]) => !excludedCanonicalNodeIds.has(nodeId),
      ),
    ),
    visualRelationships: relationships,
    assets: reconstruction.assets.filter((asset) =>
      selectedAssetIds.has(asset.id),
    ),
  }
}

function epubFileName(
  paper: ResearchPaper,
  profile: TargetProfile | undefined,
  mode: EpubExportMode,
) {
  const base = profile?.epub.fileName ?? `${slug(paper.title)}.epub`
  return mode === 'readable-fallback'
    ? base.replace(/\.epub$/i, '-readable.epub')
    : base
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
    JSON.stringify(profile) !== JSON.stringify(getTargetProfile(profile.id))
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
  assertUniqueCanonicalNodeIds(renderPaper)
  if (renderReconstruction) {
    const assetIds = new Set(
      renderReconstruction.assets.map((asset) => asset.id),
    )
    const invalid = renderReconstruction.visualRelationships.find(
      (relationship) =>
        relationship.status !== 'matched' ||
        !relationship.canonicalNodeId ||
        relationship.assetIds.length === 0 ||
        relationship.assetIds.some((assetId) => !assetIds.has(assetId)),
    )
    if (invalid) {
      const message = `EPUB export is blocked by visual relationship ${invalid.id}.`
      throw isDocxReconstruction(renderReconstruction)
        ? new DocxImportError('INCOMPLETE_RECONSTRUCTION', message)
        : new PdfImportError('INCOMPLETE_RECONSTRUCTION', message)
    }
  }
  const packaged = await packageVisualAssets(
    renderReconstruction?.assets ?? [],
    profile,
  )
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
  const identifier = `urn:srt:${stableId(renderPaper.id)}:${canonicalHash.slice(0, 24)}:${mode}${profile ? `:${profile.id}:${profile.version}:${EPUB_EXPORT_POLICY_VERSION}` : ''}`
  const modified = `${renderPaper.updated}T00:00:00Z`
  const exportProfileMetadata = profile ? profileMetadata(profile) : undefined
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
    sourceCompleteness: reconstruction?.completeness,
    sourceReadiness: reconstruction?.readiness,
    humanAdjudications:
      reconstruction && !isDocxReconstruction(reconstruction)
        ? {
            schemaVersion: reconstruction.humanAdjudications.schemaVersion,
            appliedCount: reconstruction.humanAdjudications.applied.length,
            staleCount: reconstruction.humanAdjudications.stale.length,
            countsByDiagnosticCode:
              reconstruction.humanAdjudications.countsByDiagnosticCode,
            applied: reconstruction.humanAdjudications.applied,
          }
        : undefined,
    assets: packaged.map(({ source, asset, policy }) => {
      const { bytes: _bytes, ...metadata } = asset
      return { ...metadata, sourceAssetId: source.id, policy }
    }),
    visualRelationships: packagedRelationships,
    excludedUnresolvedVisualRelationshipCount:
      reconstruction && renderReconstruction
        ? reconstruction.visualRelationships.length -
          renderReconstruction.visualRelationships.length
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
  const bytes = zipSync(archive)
  const { files, entries } = inspectEpub(bytes, profile)
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
    fileName: epubFileName(renderPaper, profile, mode),
    mediaType: EPUB_MIMETYPE,
    sha256: await sha256(bytes),
    identifier,
    entries,
    mode,
    profile: exportProfileMetadata,
  }
}

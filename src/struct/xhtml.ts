import type {
  StructBlock,
  StructDocument,
  StructTable,
  StructTableCell,
} from './types'
import {
  buildRenderedPublicationPlan,
  emittedXhtmlIds,
  groupedCitationLinks,
  resolveStructTarget,
  type EmittedXhtmlId,
  type RenderedInlineSourcePlan,
  type RenderedPublicationPlan,
} from './emitted-ids'

export type StructXhtmlOptions = {
  embedStyles?: boolean
  styles?: string
}

const DEFAULT_STYLES = `body { font-family: serif; line-height: 1.5; margin: 5%; }
img { display: block; height: auto; max-width: 100%; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid currentColor; padding: 0.25rem; }
figure { break-inside: avoid; margin: 1.5rem 0; }
.visually-hidden, .additional-semantic-reference { clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }`

function text(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function attribute(value: string) {
  return text(value).replace(/"/g, '&quot;')
}

export function xhtmlId(value: string) {
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/g, '-')
  return /^[A-Za-z_]/u.test(cleaned) ? cleaned : `_${cleaned}`
}

function xhtmlHref(value: string) {
  return value.startsWith('#') ? `#${xhtmlId(value.slice(1))}` : value
}

// Derived nodes need an ID space that cannot overlap a canonical SAFE_ID.
// Length prefixes keep the tuple injective even when components contain the
// old delimiter.
function derivedXhtmlId(namespace: string, values: readonly string[]) {
  return `_${namespace}-${values
    .map((value) => {
      const mapped = xhtmlId(value)
      return `${mapped.length}:${mapped}`
    })
    .join('')}`
}

const UNICODE_DECIMAL_ZERO_CODE_POINTS = [
  0x0030, 0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66,
  0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040,
  0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0,
  0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0,
  0xff10, 0x104a0, 0x10d30, 0x10d40, 0x11066, 0x110f0, 0x11136, 0x111d0,
  0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0, 0x116d0, 0x116da, 0x11730,
  0x118e0, 0x11950, 0x11bf0, 0x11c50, 0x11d50, 0x11da0, 0x11de0, 0x11f50,
  0x16130, 0x16a60, 0x16ac0, 0x16b50, 0x16d70, 0x1ccf0, 0x1d7ce, 0x1d7d8,
  0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950,
  0x1fbf0,
] as const

const SUPERSCRIPT_DIGITS: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
}

function normalizedNumericToken(value: string) {
  return [...value]
    .map((character) => {
      if (SUPERSCRIPT_DIGITS[character]) return SUPERSCRIPT_DIGITS[character]
      const codePoint = character.codePointAt(0)!
      const zero = UNICODE_DECIMAL_ZERO_CODE_POINTS.find(
        (candidate) => codePoint >= candidate && codePoint <= candidate + 9,
      )
      return zero === undefined ? character : String(codePoint - zero)
    })
    .join('')
}

function foldedCitationText(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/’/gu, "'")
    .toLocaleLowerCase()
}

function renderInline(
  document: StructDocument,
  source: RenderedInlineSourcePlan,
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
) {
  const { value } = source
  const plan = source.segments
  if (plan.length === 0) return text(value)
  return plan
    .map((segment) => {
      const { start, end, owners } = segment
      const segmentValue = value.slice(start, end)
      const styled = (content: string) => {
        let rendered = content
        for (const run of owners) {
          if (run.bold) rendered = `<strong>${rendered}</strong>`
          if (run.italic) rendered = `<em>${rendered}</em>`
          if (run.verticalAlign === 'superscript') {
            rendered = `<sup>${rendered}</sup>`
          } else if (run.verticalAlign === 'subscript') {
            rendered = `<sub>${rendered}</sub>`
          }
        }
        return rendered
      }
      let rendered = styled(text(segmentValue))
      const semanticOwnerIndex = owners.findIndex(
        (run) => run.semanticRole && run.relationshipId,
      )
      const semanticRun =
        semanticOwnerIndex >= 0 ? owners[semanticOwnerIndex] : undefined
      const semantic =
        semanticOwnerIndex >= 0
          ? publicationPlan.semanticByOwnerKey.get(
              segment.ownerKeys[semanticOwnerIndex]!,
            )
          : undefined
      if (semanticRun?.relationshipId && semanticRun.semanticRole && semantic) {
        const relationshipId = xhtmlId(semantic.relationshipIdStable)
        const firstSegment = !emittedRelationshipIds.has(relationshipId)
        emittedRelationshipIds.add(relationshipId)
        const id = firstSegment ? ` id="${attribute(relationshipId)}"` : ''
        const targets = semantic.targets.map((target) => ({
          ...target,
          href: xhtmlHref(target.href),
        }))
        const semanticAttributes = semantic.semanticAttributes
        if (targets.length === 0) {
          rendered = `<span${id}${semanticAttributes}>${rendered}</span>`
        } else {
          const epubRole = semantic.epubRole
          if (targets.length === 1) {
            rendered = `<a${id} href="${attribute(targets[0]!.href)}"${epubRole}${semanticAttributes}>${rendered}</a>`
          } else {
            const grouped =
              semanticRun.semanticRole === 'citation'
                ? groupedCitationLinks(
                    segmentValue,
                    semantic.citationRanges,
                    semantic.targetById,
                    epubRole,
                    start - semanticRun.start!,
                  )
                : { html: text(segmentValue), linkedTargets: new Set<string>() }
            rendered = `<span${id}${semanticAttributes}>${styled(grouped!.html)}${firstSegment ? semantic.additionalTargets : ''}</span>`
          }
        }
      } else {
        const hyperlinkOwnerIndex = owners.findIndex(
          (run) => run.href || run.targetIds?.length,
        )
        const hyperlink =
          hyperlinkOwnerIndex >= 0
            ? publicationPlan.hyperlinkByOwnerKey.get(
                segment.ownerKeys[hyperlinkOwnerIndex]!,
              )
            : undefined
        if (hyperlink)
          rendered = `<a href="${attribute(xhtmlHref(hyperlink.href))}">${rendered}</a>`
      }
      return rendered
    })
    .join('')
}

function renderTable(
  document: StructDocument,
  table: StructTable,
  tableBlockId: string,
  blockIndex: number,
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
) {
  const rows = Array.from({ length: table.rows }, () => [] as string[])
  const cells = new Map<string, { cell: StructTableCell; index: number }>(
    table.cells.map(
      (cell, index) => [`${cell.row}:${cell.column}`, { cell, index }] as const,
    ),
  )
  const occupied = new Set<string>()
  for (let row = 0; row < table.rows; row += 1) {
    for (let column = 0; column < table.columns; column += 1) {
      const coordinate = `${row}:${column}`
      if (occupied.has(coordinate)) continue
      const cellEntry = cells.get(coordinate)
      if (!cellEntry) {
        rows[row]!.push('<td></td>')
        continue
      }
      const { cell, index: cellIndex } = cellEntry
      const tag = cell.headerScope ? 'th' : 'td'
      const htmlScope = cell.headerScope === 'column' ? 'col' : cell.headerScope
      const scope = htmlScope ? ` scope="${htmlScope}"` : ''
      const rowSpan = cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''
      const columnSpan =
        cell.columnSpan > 1 ? ` colspan="${cell.columnSpan}"` : ''
      rows[row]!.push(
        `<${tag} id="${attribute(derivedXhtmlId('table-cell', [tableBlockId, cell.id]))}"${scope}${rowSpan}${columnSpan}>${renderInline(
          document,
          publicationPlan.sourceByKey.get(`table:${blockIndex}:${cellIndex}`)!,
          emittedRelationshipIds,
          publicationPlan,
        )}</${tag}>`,
      )
      for (
        let occupiedRow = cell.row;
        occupiedRow < cell.row + cell.rowSpan;
        occupiedRow += 1
      )
        for (
          let occupiedColumn = cell.column;
          occupiedColumn < cell.column + cell.columnSpan;
          occupiedColumn += 1
        )
          occupied.add(`${occupiedRow}:${occupiedColumn}`)
    }
  }
  return `<table>${rows.map((row) => `<tr>${row.join('')}</tr>`).join('')}</table>`
}

function renderAuthors(
  document: StructDocument,
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
) {
  if (document.metadata.authors.length === 0) return ''
  const authors = document.metadata.authors
    .map((author) => {
      const references = (publicationPlan.authorNotesByAuthor.get(author) ?? [])
        .map((reference) => {
          const target = resolveStructTarget(document, reference.target)
          emittedRelationshipIds.add(xhtmlId(reference.id))
          return `<sup><a id="${attribute(xhtmlId(reference.id))}" href="${attribute(xhtmlHref(target.href))}" epub:type="noteref" role="doc-noteref">${text(reference.label)}</a></sup>`
        })
        .join('')
      return `${text(author)}${references}`
    })
    .join(', ')
  return `<p class="authors">${authors}</p>`
}

function renderSourceObservationAnchors(block: StructBlock) {
  return (block.sourceObservationAnchorIds ?? [])
    .map(
      (anchorId) =>
        `<span id="${attribute(derivedXhtmlId('source-anchor', [block.id, anchorId]))}" class="visually-hidden source-observation-anchor" aria-hidden="true"></span>`,
    )
    .join('')
}

function renderBlock(
  document: StructDocument,
  block: StructBlock,
  blockIndex: number,
  emittedRelationshipIds: Set<string>,
  publicationPlan: RenderedPublicationPlan,
) {
  // Furniture remains queryable in STRUCT with its source evidence, but is
  // intentionally outside the publication reading flow.
  if (block.kind === 'furniture') return ''
  const id = attribute(xhtmlId(block.id))
  const sourceAnchors = renderSourceObservationAnchors(block)
  if (block.kind === 'table' && block.table) {
    return `<figure id="${id}" data-struct-id="${id}">${sourceAnchors}${renderTable(document, block.table, block.id, blockIndex, emittedRelationshipIds, publicationPlan)}</figure>`
  }
  const content = renderInline(
    document,
    publicationPlan.sourceByKey.get(`block:${blockIndex}`)!,
    emittedRelationshipIds,
    publicationPlan,
  )
  if (block.kind === 'heading') {
    const level = Math.max(1, Math.min(6, Number(block.attributes?.level ?? 2)))
    return `<h${level} id="${id}" data-struct-id="${id}">${sourceAnchors}${content}</h${level}>`
  }
  if (block.kind === 'quote') {
    return `<blockquote id="${id}" data-struct-id="${id}">${sourceAnchors}<p>${content}</p></blockquote>`
  }
  if (
    block.kind === 'figure' ||
    block.kind === 'equation' ||
    block.kind === 'table'
  ) {
    const assets = (block.fallbackAssetIds ?? [])
      .map((assetId) => document.assets.find((asset) => asset.id === assetId))
      .filter((asset) => asset !== undefined)
    const artwork = assets
      .map(
        (asset) =>
          `<img src="${attribute(asset.href)}" alt="${attribute(block.label ?? block.text)}" />`,
      )
      .join('')
    return `<figure id="${id}" data-struct-id="${id}">${sourceAnchors}${artwork}<figcaption>${content || text(block.label ?? '')}</figcaption></figure>`
  }
  if (block.kind === 'caption') {
    return `<p id="${id}" data-struct-id="${id}" class="caption">${sourceAnchors}${content}</p>`
  }
  if (block.kind === 'footnote' || block.kind === 'endnote') {
    const backlinks = (publicationPlan.backlinksByTarget.get(block.id) ?? [])
      .map(
        (relationship) =>
          `<a href="#${attribute(xhtmlId(relationship.id))}" class="note-backlink" aria-label="Back to note reference">↩</a>`,
      )
      .join(' ')
    return `<aside id="${id}" data-struct-id="${id}" epub:type="${block.kind}" role="doc-footnote" data-note-kind="${block.kind}">${sourceAnchors}<p>${content}${backlinks ? ` ${backlinks}` : ''}</p></aside>`
  }
  if (block.kind === 'code') {
    return `<pre id="${id}" data-struct-id="${id}">${sourceAnchors}<code>${content}</code></pre>`
  }
  const bibliographyEntry = block.attributes?.bibliographyEntry
    ? ' role="doc-biblioentry" data-semantic-role="bibliography-entry"'
    : ''
  return `<p id="${id}" data-struct-id="${id}"${bibliographyEntry}>${sourceAnchors}${content}</p>`
}

function assertUniqueEmittedIds(entries: readonly EmittedXhtmlId[]) {
  const seen = new Set<string>()
  for (const { id } of entries) {
    if (seen.has(id)) throw new Error(`STRUCT XHTML duplicate id ${id}`)
    seen.add(id)
  }
}

/** Render a source-agnostic STRUCT graph without consulting extractor state. */
export function renderPublicationXhtml(
  document: StructDocument,
  options: StructXhtmlOptions = {},
) {
  const publicationPlan = buildRenderedPublicationPlan(document)
  assertUniqueEmittedIds(emittedXhtmlIds(document, publicationPlan))
  const emittedRelationshipIds = new Set<string>()
  const language = document.metadata.language ?? 'und'
  const direction =
    document.metadata.baseDirection === 'ltr' ||
    document.metadata.baseDirection === 'rtl'
      ? ` dir="${document.metadata.baseDirection}"`
      : ''
  const styles = options.styles ?? DEFAULT_STYLES
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${attribute(language)}" lang="${attribute(language)}"${direction}>
<head>
  <meta charset="utf-8" />
  <title>${text(document.metadata.title)}</title>
  ${options.embedStyles ? `<style>${text(styles)}</style>` : '<link rel="stylesheet" type="text/css" href="styles.css" />'}
</head>
<body>
  <header><h1>${text(document.metadata.title)}</h1>${document.metadata.subtitle ? `<p>${text(document.metadata.subtitle)}</p>` : ''}${renderAuthors(document, emittedRelationshipIds, publicationPlan)}</header>
  ${document.blocks.map((block, blockIndex) => renderBlock(document, block, blockIndex, emittedRelationshipIds, publicationPlan)).join('\n  ')}
</body>
</html>
`
}

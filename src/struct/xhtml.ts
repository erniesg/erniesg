import type {
  StructBlock,
  StructDocument,
  StructInline,
  StructTable,
} from './types'

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

function groupedCitationLinks(
  value: string,
  labels: readonly string[],
  targets: readonly string[],
  epubRole: string,
  sourceValue = value,
  sourceOffset = 0,
) {
  if (
    labels.length !== targets.length ||
    new Set(labels).size !== labels.length
  ) {
    return { html: text(value), linkedTargets: new Set<string>() }
  }
  const targetByLabel = new Map(
    labels.map((label, index) => [label, targets[index]] as const),
  )
  const ranges = [...sourceValue.matchAll(/[\p{Nd}⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu)].flatMap(
    (match) => {
      const target = targetByLabel.get(normalizedNumericToken(match[0]))
      const start = match.index ?? -1
      return target && start >= 0
        ? [{ start, end: start + match[0].length, target }]
        : []
    },
  )
  const linkedTargets = new Set(ranges.map((range) => range.target))
  for (const match of sourceValue.matchAll(/\b(?:18|19|20)\d{2}[a-z]?\b/giu)) {
    const start = match.index ?? -1
    if (start < 0) continue
    const year = match[0].toLocaleLowerCase()
    const prefix = foldedCitationText(
      sourceValue.slice(Math.max(0, start - 96), start),
    )
    const candidates = labels.flatMap((label, index) => {
      const separator = label.lastIndexOf(':')
      if (separator <= 0 || label.slice(separator + 1) !== year) return []
      const surname = foldedCitationText(label.slice(0, separator))
      const position = prefix.lastIndexOf(surname)
      return position >= 0 && !linkedTargets.has(targets[index])
        ? [{ target: targets[index], position }]
        : []
    })
    const nearest = Math.max(...candidates.map(({ position }) => position))
    const selected = candidates.filter(({ position }) => position === nearest)
    if (selected.length !== 1) continue
    ranges.push({
      start,
      end: start + match[0].length,
      target: selected[0].target,
    })
    linkedTargets.add(selected[0].target)
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end)
  if (
    ranges.some(
      (range, index) => index > 0 && range.start < ranges[index - 1].end,
    )
  ) {
    return { html: text(value), linkedTargets: new Set<string>() }
  }
  const segmentEnd = sourceOffset + value.length
  const segmentRanges = ranges.flatMap((range) => {
    const start = Math.max(range.start, sourceOffset)
    const end = Math.min(range.end, segmentEnd)
    return start < end
      ? [
          {
            start: start - sourceOffset,
            end: end - sourceOffset,
            target: range.target,
          },
        ]
      : []
  })
  let cursor = 0
  let html = ''
  for (const range of segmentRanges) {
    html += text(value.slice(cursor, range.start))
    html += `<a href="#${attribute(range.target)}"${epubRole}>${text(value.slice(range.start, range.end))}</a>`
    cursor = range.end
  }
  html += text(value.slice(cursor))
  return { html, linkedTargets }
}

function renderInline(
  document: StructDocument,
  value: string,
  runs: readonly StructInline[],
) {
  const validRuns = runs
    .filter(
      (run) =>
        Number.isInteger(run.start) &&
        Number.isInteger(run.end) &&
        run.start >= 0 &&
        run.end > run.start &&
        run.end <= value.length,
    )
    .sort((left, right) => left.start - right.start || right.end - left.end)
  if (validRuns.length === 0) return text(value)

  const boundaries = new Set([0, value.length])
  for (const run of validRuns) {
    boundaries.add(run.start)
    boundaries.add(run.end)
  }
  const positions = [...boundaries].sort((left, right) => left - right)
  const relationships = new Map(
    document.relationships.map((relationship) => [
      relationship.id,
      relationship,
    ]),
  )
  const emittedRelationshipIds = new Set<string>()
  return positions
    .slice(0, -1)
    .map((start, index) => {
      const end = positions[index + 1]
      const segmentValue = value.slice(start, end)
      const owners = validRuns.filter(
        (run) => run.start <= start && run.end >= end,
      )
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
      const semanticRun = owners.find(
        (run) => run.semanticRole && run.relationshipId,
      )
      if (semanticRun?.relationshipId && semanticRun.semanticRole) {
        const relationship = relationships.get(semanticRun.relationshipId)
        const relationshipId = xhtmlId(semanticRun.relationshipId)
        const firstSegment = !emittedRelationshipIds.has(relationshipId)
        emittedRelationshipIds.add(relationshipId)
        const id = firstSegment ? ` id="${attribute(relationshipId)}"` : ''
        const targets = relationship
          ? relationship.status === 'matched'
            ? relationship.to.map(xhtmlId)
            : []
          : (semanticRun.targetIds ?? []).map(xhtmlId)
        const semanticAttributes = ` data-semantic-role="${attribute(semanticRun.semanticRole)}" data-relationship-id="${attribute(relationshipId)}"${targets.length > 0 ? ` data-target-ids="${attribute(targets.join(' '))}"` : ''}`
        if (targets.length === 0) {
          rendered = `<span${id}${semanticAttributes}>${rendered}</span>`
        } else {
          const epubRole =
            semanticRun.semanticRole === 'note-reference'
              ? ' epub:type="noteref" role="doc-noteref"'
              : semanticRun.semanticRole === 'citation'
                ? ' epub:type="biblioref" role="doc-biblioref"'
                : ''
          if (targets.length === 1) {
            rendered = `<a${id} href="#${attribute(targets[0])}"${epubRole}${semanticAttributes}>${rendered}</a>`
          } else {
            const labels = (relationship?.label ?? '')
              .split(',')
              .map((label) => label.trim())
              .filter(Boolean)
            const grouped =
              semanticRun.semanticRole === 'citation'
                ? groupedCitationLinks(
                    segmentValue,
                    labels,
                    targets,
                    epubRole,
                    value.slice(semanticRun.start, semanticRun.end),
                    start - semanticRun.start,
                  )
                : { html: text(segmentValue), linkedTargets: new Set<string>() }
            const visibleTargets =
              semanticRun.semanticRole === 'citation'
                ? groupedCitationLinks(
                    value.slice(semanticRun.start, semanticRun.end),
                    labels,
                    targets,
                    epubRole,
                  ).linkedTargets
                : new Set<string>()
            const additionalTargets = targets
              .map((target, targetIndex) => ({ target, targetIndex }))
              .filter(({ target }) => !visibleTargets.has(target))
              .map(
                ({ target, targetIndex }) =>
                  `<a href="#${attribute(target)}"${epubRole} class="additional-semantic-reference">Additional ${text(semanticRun.semanticRole!)} target ${text(labels[targetIndex] ?? String(targetIndex + 1))}</a>`,
              )
              .join('')
            rendered = `<span${id}${semanticAttributes}>${styled(grouped.html)}${firstSegment ? additionalTargets : ''}</span>`
          }
        }
      } else {
        const hyperlinkRun = owners.find(
          (run) => run.href || run.targetIds?.length,
        )
        const internalTarget = hyperlinkRun?.targetIds?.[0]
        const href =
          hyperlinkRun?.href?.startsWith('#') && internalTarget
            ? `#${xhtmlId(internalTarget)}`
            : (hyperlinkRun?.href ??
              (internalTarget ? `#${xhtmlId(internalTarget)}` : undefined))
        if (href)
          rendered = `<a href="${attribute(xhtmlHref(href))}">${rendered}</a>`
      }
      return rendered
    })
    .join('')
}

function renderTable(
  document: StructDocument,
  table: StructTable,
  tableBlockId: string,
) {
  const rows = Array.from({ length: table.rows }, () => [] as string[])
  for (const cell of table.cells) {
    const tag = cell.headerScope ? 'th' : 'td'
    const htmlScope = cell.headerScope === 'column' ? 'col' : cell.headerScope
    const scope = htmlScope ? ` scope="${htmlScope}"` : ''
    const rowSpan = cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''
    const columnSpan =
      cell.columnSpan > 1 ? ` colspan="${cell.columnSpan}"` : ''
    rows[cell.row]?.push(
      `<${tag} id="${attribute(`${xhtmlId(tableBlockId)}-${xhtmlId(cell.id)}`)}"${scope}${rowSpan}${columnSpan}>${renderInline(document, cell.text, cell.inline)}</${tag}>`,
    )
  }
  return `<table>${rows.map((row) => `<tr>${row.join('')}</tr>`).join('')}</table>`
}

function renderedInlineRelationshipIds(document: StructDocument) {
  return new Set([
    ...(document.metadata.authorNotes ?? []).map((reference) => reference.id),
    ...document.blocks.flatMap((block) => [
      ...(block.kind !== 'furniture' && block.kind !== 'table'
        ? block.inline.flatMap((run) =>
            run.relationshipId &&
            run.semanticRole === 'note-reference' &&
            run.start >= 0 &&
            run.start < run.end &&
            run.end <= block.text.length
              ? [run.relationshipId]
              : [],
          )
        : []),
      ...(block.table?.cells.flatMap((cell) =>
        cell.inline.flatMap((run) =>
          run.relationshipId &&
          run.semanticRole === 'note-reference' &&
          run.start >= 0 &&
          run.start < run.end &&
          run.end <= cell.text.length
            ? [run.relationshipId]
            : [],
        ),
      ) ?? []),
    ]),
  ])
}

function renderAuthors(document: StructDocument) {
  if (document.metadata.authors.length === 0) return ''
  const authors = document.metadata.authors
    .map((author) => {
      const references = (document.metadata.authorNotes ?? [])
        .filter((reference) => reference.author === author)
        .map(
          (reference) =>
            `<sup><a id="${attribute(xhtmlId(reference.id))}" href="#${attribute(xhtmlId(reference.target))}" epub:type="noteref" role="doc-noteref">${text(reference.label)}</a></sup>`,
        )
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
        `<span id="${attribute(xhtmlId(anchorId))}" class="visually-hidden source-observation-anchor" aria-hidden="true"></span>`,
    )
    .join('')
}

function renderBlock(document: StructDocument, block: StructBlock) {
  // Furniture remains queryable in STRUCT with its source evidence, but is
  // intentionally outside the publication reading flow.
  if (block.kind === 'furniture') return ''
  const id = attribute(xhtmlId(block.id))
  const content = renderInline(document, block.text, block.inline)
  const sourceAnchors = renderSourceObservationAnchors(block)
  if (block.kind === 'heading') {
    const level = Math.max(1, Math.min(6, Number(block.attributes?.level ?? 2)))
    return `<h${level} id="${id}" data-struct-id="${id}">${sourceAnchors}${content}</h${level}>`
  }
  if (block.kind === 'quote') {
    return `<blockquote id="${id}" data-struct-id="${id}">${sourceAnchors}<p>${content}</p></blockquote>`
  }
  if (block.kind === 'table' && block.table) {
    return `<figure id="${id}" data-struct-id="${id}">${sourceAnchors}${renderTable(document, block.table, block.id)}</figure>`
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
    const renderedRelationships = renderedInlineRelationshipIds(document)
    const backlinks = document.relationships
      .filter(
        (relationship) =>
          relationship.status === 'matched' &&
          renderedRelationships.has(relationship.id) &&
          (relationship.kind === 'footnote' ||
            relationship.kind === 'endnote') &&
          relationship.to.includes(block.id),
      )
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

/** Render a source-agnostic STRUCT graph without consulting extractor state. */
export function renderPublicationXhtml(
  document: StructDocument,
  options: StructXhtmlOptions = {},
) {
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
  <header><h1>${text(document.metadata.title)}</h1>${document.metadata.subtitle ? `<p>${text(document.metadata.subtitle)}</p>` : ''}${renderAuthors(document)}</header>
  ${document.blocks.map((block) => renderBlock(document, block)).join('\n  ')}
</body>
</html>
`
}

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
figure { break-inside: avoid; margin: 1.5rem 0; }`

function text(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function attribute(value: string) {
  return text(value).replace(/"/g, '&quot;')
}

function renderInline(value: string, runs: readonly StructInline[]) {
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
  return positions
    .slice(0, -1)
    .map((start, index) => {
      const end = positions[index + 1]
      let rendered = text(value.slice(start, end))
      const owners = validRuns.filter(
        (run) => run.start <= start && run.end >= end,
      )
      for (const run of owners) {
        if (run.bold) rendered = `<strong>${rendered}</strong>`
        if (run.italic) rendered = `<em>${rendered}</em>`
        if (run.verticalAlign === 'superscript') {
          rendered = `<sup>${rendered}</sup>`
        } else if (run.verticalAlign === 'subscript') {
          rendered = `<sub>${rendered}</sub>`
        }
        const internalTarget = run.targetIds?.[0]
        const href =
          run.href?.startsWith('#') && internalTarget
            ? `#${internalTarget}`
            : (run.href ?? (internalTarget ? `#${internalTarget}` : undefined))
        if (href) rendered = `<a href="${attribute(href)}">${rendered}</a>`
      }
      return rendered
    })
    .join('')
}

function renderTable(table: StructTable) {
  const rows = Array.from({ length: table.rows }, () => [] as string[])
  for (const cell of table.cells) {
    const tag = cell.headerScope ? 'th' : 'td'
    const scope = cell.headerScope ? ` scope="${cell.headerScope}"` : ''
    const rowSpan = cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''
    const columnSpan =
      cell.columnSpan > 1 ? ` colspan="${cell.columnSpan}"` : ''
    rows[cell.row]?.push(
      `<${tag} id="${attribute(cell.id)}"${scope}${rowSpan}${columnSpan}>${renderInline(cell.text, cell.inline)}</${tag}>`,
    )
  }
  return `<table>${rows.map((row) => `<tr>${row.join('')}</tr>`).join('')}</table>`
}

function renderBlock(document: StructDocument, block: StructBlock) {
  // Furniture remains queryable in STRUCT with its source evidence, but is
  // intentionally outside the publication reading flow.
  if (block.kind === 'furniture') return ''
  const id = attribute(block.id)
  const content = renderInline(block.text, block.inline)
  if (block.kind === 'heading') {
    const level = Math.max(1, Math.min(6, Number(block.attributes?.level ?? 2)))
    return `<h${level} id="${id}" data-struct-id="${id}">${content}</h${level}>`
  }
  if (block.kind === 'quote') {
    return `<blockquote id="${id}" data-struct-id="${id}"><p>${content}</p></blockquote>`
  }
  if (block.kind === 'table' && block.table) {
    return `<figure id="${id}" data-struct-id="${id}">${renderTable(block.table)}</figure>`
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
    return `<figure id="${id}" data-struct-id="${id}">${artwork}<figcaption>${content || text(block.label ?? '')}</figcaption></figure>`
  }
  if (block.kind === 'caption') {
    return `<p id="${id}" data-struct-id="${id}" class="caption">${content}</p>`
  }
  if (block.kind === 'footnote' || block.kind === 'endnote') {
    return `<aside id="${id}" data-struct-id="${id}" epub:type="${block.kind}"><p>${content}</p></aside>`
  }
  if (block.kind === 'code') {
    return `<pre id="${id}" data-struct-id="${id}"><code>${content}</code></pre>`
  }
  return `<p id="${id}" data-struct-id="${id}">${content}</p>`
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
  <header><h1>${text(document.metadata.title)}</h1>${document.metadata.subtitle ? `<p>${text(document.metadata.subtitle)}</p>` : ''}</header>
  ${document.blocks.map((block) => renderBlock(document, block)).join('\n  ')}
</body>
</html>
`
}

import type { StructDocument, StructInline } from './types'

const EPUB_RESERVED_IDS = new Set([
  'publication-id',
  'nav',
  'content',
  'styles',
  'struct',
])

export type StructTarget = {
  id: string
  href: string
  kind: 'asset' | 'block' | 'external'
}

export function isPackagedAssetId(value: string) {
  return (
    /^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(value) && !EPUB_RESERVED_IDS.has(value)
  )
}

/** Resolve every publication target through the same local/external rules. */
export function resolveStructTarget(
  document: StructDocument,
  value: string,
): StructTarget {
  const id = value.startsWith('#') ? value.slice(1) : value
  if (/^(?:https?|mailto):/iu.test(value))
    return { id: value, href: value, kind: 'external' }
  const asset = document.assets.find((entry) => entry.id === id)
  if (asset) {
    if (!isPackagedAssetId(asset.id))
      throw new Error(`STRUCT target asset is not packageable: ${asset.id}`)
    return { id: asset.id, href: asset.href, kind: 'asset' }
  }
  const block = document.blocks.find((entry) => entry.id === id)
  if (block) {
    if (block.kind === 'furniture')
      throw new Error(`STRUCT target block is not rendered: ${block.id}`)
    return { id: block.id, href: `#${block.id}`, kind: 'block' }
  }
  throw new Error(`STRUCT target is not renderable: ${value}`)
}

export type EmittedXhtmlId = {
  id: string
  path: string
}

/** Keep the renderer's XML-compatible identifier normalization in one place. */
export function stableId(value: string) {
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/g, '-')
  return /^[A-Za-z_]/u.test(cleaned) ? cleaned : `n-${cleaned}`
}

function validInline(run: StructInline, text: string) {
  return (
    Number.isInteger(run.start) &&
    Number.isInteger(run.end) &&
    run.start >= 0 &&
    run.end > run.start &&
    run.end <= text.length
  )
}

function renderedInlineRuns(document: StructDocument) {
  return document.blocks.flatMap((block, blockIndex) => {
    if (block.kind === 'furniture') return []
    if (block.kind === 'table' && block.table) {
      return block.table.cells.flatMap((cell, cellIndex) =>
        cell.inline
          .filter((run) => validInline(run, cell.text))
          .map((run, inlineIndex) => ({
            run,
            path: `$.blocks[${blockIndex}].table.cells[${cellIndex}].inline[${inlineIndex}]`,
          })),
      )
    }
    return block.inline
      .filter((run) => validInline(run, block.text))
      .map((run, inlineIndex) => ({
        run,
        path: `$.blocks[${blockIndex}].inline[${inlineIndex}]`,
      }))
  })
}

/**
 * Describe every id that the publication XHTML renderer can emit. Relationship
 * ids are document-scoped: one relationship occurrence receives the id and
 * later occurrences reuse its data without emitting another id attribute.
 */
export function emittedXhtmlIds(document: StructDocument): EmittedXhtmlId[] {
  const entries: EmittedXhtmlId[] = []
  for (const [blockIndex, block] of document.blocks.entries()) {
    if (block.kind === 'furniture') continue
    entries.push({ id: block.id, path: `$.blocks[${blockIndex}].id` })
    for (const [anchorIndex, anchor] of (
      block.sourceObservationAnchorIds ?? []
    ).entries()) {
      entries.push({
        id: anchor,
        path: `$.blocks[${blockIndex}].sourceObservationAnchorIds[${anchorIndex}]`,
      })
    }
    if (block.kind === 'table' && block.table) {
      for (const [cellIndex, cell] of block.table.cells.entries()) {
        entries.push({
          id: `${block.id}-${cell.id}`,
          path: `$.blocks[${blockIndex}].table.cells[${cellIndex}].id`,
        })
      }
    }
  }
  for (const [index, note] of (document.metadata.authorNotes ?? []).entries())
    entries.push({
      id: stableId(note.id),
      path: `$.metadata.authorNotes[${index}].id`,
    })

  const relationshipIds = new Set<string>()
  for (const { run, path } of renderedInlineRuns(document)) {
    if (!run.relationshipId || !run.semanticRole) continue
    if (relationshipIds.has(run.relationshipId)) continue
    relationshipIds.add(run.relationshipId)
    entries.push({
      id: stableId(run.relationshipId),
      path: `${path}.relationshipId`,
    })
  }
  return entries
}

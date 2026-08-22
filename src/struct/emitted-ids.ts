import type { StructDocument, StructInline } from './types'

const EPUB_RESERVED_IDS = new Set([
  'publication-id',
  'nav',
  'content',
  'styles',
  'struct',
  'profile',
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
  if (/^(?:https?|mailto):/iu.test(value))
    return { id: value, href: value, kind: 'external' }
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

type RenderedInlineSource = {
  value: string
  runs: readonly StructInline[]
  paths: readonly string[]
}

export type RenderedInlineSegment = {
  start: number
  end: number
  owners: readonly StructInline[]
}

/** Return exactly the inline sources that the publication renderer consumes. */
function renderedInlineSources(document: StructDocument) {
  return document.blocks.flatMap(
    (block, blockIndex): RenderedInlineSource[] => {
      if (block.kind === 'furniture') return []
      if (block.kind === 'table' && block.table) {
        return block.table.cells.map((cell, cellIndex) => ({
          value: cell.text,
          runs: cell.inline,
          paths: cell.inline.map(
            (_run, inlineIndex) =>
              `$.blocks[${blockIndex}].table.cells[${cellIndex}].inline[${inlineIndex}]`,
          ),
        }))
      }
      return [
        {
          value: block.text,
          runs: block.inline,
          paths: block.inline.map(
            (_run, inlineIndex) =>
              `$.blocks[${blockIndex}].inline[${inlineIndex}]`,
          ),
        },
      ]
    },
  )
}

/** Build the owner plan shared by XHTML rendering, emitted IDs, and backlinks. */
export function renderedInlinePlan(
  value: string,
  runs: readonly StructInline[],
): RenderedInlineSegment[] {
  const validRuns = runs
    .filter((run) => validInline(run, value))
    .sort((left, right) => left.start - right.start || right.end - left.end)
  if (validRuns.length === 0) return []
  const boundaries = new Set([0, value.length])
  for (const run of validRuns) {
    boundaries.add(run.start)
    boundaries.add(run.end)
  }
  const positions = [...boundaries].sort((left, right) => left - right)
  return positions.slice(0, -1).map((start, index) => {
    const end = positions[index + 1]!
    return {
      start,
      end,
      owners: validRuns.filter((run) => run.start <= start && run.end >= end),
    }
  })
}

/** Return relationship IDs that have an owner in the actual rendered plan. */
export function renderedInlineRelationshipIds(document: StructDocument) {
  const ids = new Set<string>()
  for (const source of renderedInlineSources(document)) {
    for (const segment of renderedInlinePlan(source.value, source.runs)) {
      const semanticRun = segment.owners.find(
        (run) => run.semanticRole && run.relationshipId,
      )
      if (semanticRun?.relationshipId) ids.add(semanticRun.relationshipId)
    }
  }
  return ids
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
  for (const source of renderedInlineSources(document)) {
    for (const segment of renderedInlinePlan(source.value, source.runs)) {
      const run = segment.owners.find(
        (owner) => owner.relationshipId && owner.semanticRole,
      )
      if (!run?.relationshipId || relationshipIds.has(run.relationshipId))
        continue
      relationshipIds.add(run.relationshipId)
      const index = source.runs.indexOf(run)
      entries.push({
        id: stableId(run.relationshipId),
        path: `${source.paths[index]}.relationshipId`,
      })
    }
  }
  return entries
}

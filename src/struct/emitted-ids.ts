import type { StructDocument, StructInline } from './types'

const EPUB_RESERVED_IDS = new Set([
  'publication-id',
  'nav',
  'content',
  'styles',
  'struct',
  'profile',
])

/**
 * Publication planning budgets. These bound the work which can be expanded
 * into owner arrays and markup, rather than rejecting a raw run count: a
 * document with many disjoint runs is linear, while nested runs can be
 * quadratic. No valid run is truncated or reordered.
 */
export const MAX_RENDERED_INLINE_SEGMENTS = 250_000
export const MAX_RENDERED_INLINE_ACTIVE_OWNER_VISITS = 750_000
export const MAX_RENDERED_INLINE_WRAPPER_BYTES = 16_000_000
const ESTIMATED_WRAPPER_BYTES_PER_OWNER = 64

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
  key: string
  value: string
  runs: readonly StructInline[]
  paths: readonly string[]
}

export type RenderedInlineSegment = {
  start: number
  end: number
  owners: readonly StructInline[]
}

export type RenderedInlineSourcePlan = RenderedInlineSource & {
  segments: readonly RenderedInlineSegment[]
}

export type RenderedPublicationPlan = {
  sources: readonly RenderedInlineSourcePlan[]
  sourceByKey: ReadonlyMap<string, RenderedInlineSourcePlan>
  relationships: ReadonlyMap<string, StructDocument['relationships'][number]>
  renderedRelationshipIds: ReadonlySet<string>
  backlinksByTarget: ReadonlyMap<
    string,
    readonly StructDocument['relationships'][number][]
  >
  authorNotesByAuthor: ReadonlyMap<
    string,
    readonly NonNullable<StructDocument['metadata']['authorNotes']>[number][]
  >
}

export class RenderedPublicationPlanError extends Error {
  constructor(
    readonly code: 'BUDGET' | 'DUPLICATE_IDENTIFIER',
    readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'RenderedPublicationPlanError'
  }
}

/** Return exactly the inline sources that the publication renderer consumes. */
function renderedInlineSources(document: StructDocument) {
  return document.blocks.flatMap(
    (block, blockIndex): RenderedInlineSource[] => {
      if (block.kind === 'furniture') return []
      if (block.kind === 'table' && block.table) {
        return block.table.cells.map((cell, cellIndex) => ({
          key: `table:${blockIndex}:${cellIndex}`,
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
          key: `block:${blockIndex}`,
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

type InlineEvent = { position: number; runIndex: number; end: boolean }

type InlineDraft = {
  source: RenderedInlineSource
  runs: StructInline[]
  events: InlineEvent[]
  positions: number[]
  segmentCount: number
  activeOwnerVisits: number
  wrapperBytes: number
}

function draftInlinePlan(source: RenderedInlineSource): InlineDraft {
  const runs = source.runs.filter((run) => validInline(run, source.value))
  if (runs.length * 2 > MAX_RENDERED_INLINE_SEGMENTS * 4)
    throw new RenderedPublicationPlanError(
      'BUDGET',
      source.paths[0] ?? `$.${source.key}`,
      'inline event storage exceeds the publication planning budget',
    )
  runs.sort((left, right) => left.start - right.start || right.end - left.end)
  const boundaries = new Set<number>([0, source.value.length])
  const events: InlineEvent[] = []
  runs.forEach((run, runIndex) => {
    boundaries.add(run.start)
    boundaries.add(run.end)
    events.push(
      { position: run.start, runIndex, end: false },
      { position: run.end, runIndex, end: true },
    )
  })
  events.sort((left, right) => left.position - right.position)
  const positions = [...boundaries].sort((left, right) => left - right)
  const active = new Set<number>()
  let eventIndex = 0
  let segmentCount = 0
  let activeOwnerVisits = 0
  let wrapperBytes = 0
  for (
    let positionIndex = 0;
    positionIndex < positions.length - 1;
    positionIndex += 1
  ) {
    const position = positions[positionIndex]!
    while (events[eventIndex]?.position === position) {
      const event = events[eventIndex++]!
      if (event.end) active.delete(event.runIndex)
      else active.add(event.runIndex)
    }
    const next = positions[positionIndex + 1]!
    if (next <= position) continue
    segmentCount += 1
    activeOwnerVisits += active.size
    wrapperBytes += active.size * ESTIMATED_WRAPPER_BYTES_PER_OWNER
  }
  return {
    source,
    runs,
    events,
    positions,
    segmentCount,
    activeOwnerVisits,
    wrapperBytes,
  }
}

/** Build the owner plan shared by XHTML rendering, emitted IDs, and backlinks. */
export function renderedInlinePlan(
  value: string,
  runs: readonly StructInline[],
): RenderedInlineSegment[] {
  const draft = draftInlinePlan({ key: 'direct', value, runs, paths: [] })
  if (
    draft.segmentCount > MAX_RENDERED_INLINE_SEGMENTS ||
    draft.activeOwnerVisits > MAX_RENDERED_INLINE_ACTIVE_OWNER_VISITS ||
    draft.wrapperBytes > MAX_RENDERED_INLINE_WRAPPER_BYTES
  )
    throw new RenderedPublicationPlanError(
      'BUDGET',
      '$.blocks.inline',
      'inline ownership work exceeds the publication planning budget',
    )
  return materializeInlinePlan(draft)
}

function materializeInlinePlan(draft: InlineDraft): RenderedInlineSegment[] {
  const active = new Set<number>()
  let eventIndex = 0
  const segments: RenderedInlineSegment[] = []
  for (
    let positionIndex = 0;
    positionIndex < draft.positions.length - 1;
    positionIndex += 1
  ) {
    const position = draft.positions[positionIndex]!
    while (draft.events[eventIndex]?.position === position) {
      const event = draft.events[eventIndex++]!
      if (event.end) active.delete(event.runIndex)
      else active.add(event.runIndex)
    }
    const end = draft.positions[positionIndex + 1]!
    if (end <= position) continue
    segments.push({
      start: position,
      end,
      owners: [...active]
        .sort((left, right) => left - right)
        .map((index) => draft.runs[index]!),
    })
  }
  return segments
}

/** Build one document-local publication plan before any rendered owner arrays. */
export function buildRenderedPublicationPlan(
  document: StructDocument,
): RenderedPublicationPlan {
  const authors = document.metadata.authors
  const authorNotes = document.metadata.authorNotes ?? []
  const seenAuthors = new Set<string>()
  for (const [index, author] of authors.entries()) {
    if (seenAuthors.has(author))
      throw new RenderedPublicationPlanError(
        'DUPLICATE_IDENTIFIER',
        `$.metadata.authors[${index}]`,
        `duplicate metadata author ${author} is ambiguous without a stable identity`,
      )
    seenAuthors.add(author)
  }
  const drafts = renderedInlineSources(document).map(draftInlinePlan)
  let segmentCount = 0
  let activeOwnerVisits = 0
  let wrapperBytes = 0
  for (const draft of drafts) {
    segmentCount += draft.segmentCount
    activeOwnerVisits += draft.activeOwnerVisits
    wrapperBytes += draft.wrapperBytes
    if (
      segmentCount > MAX_RENDERED_INLINE_SEGMENTS ||
      activeOwnerVisits > MAX_RENDERED_INLINE_ACTIVE_OWNER_VISITS ||
      wrapperBytes > MAX_RENDERED_INLINE_WRAPPER_BYTES
    )
      throw new RenderedPublicationPlanError(
        'BUDGET',
        draft.source.paths[0] ?? `$.${draft.source.key}`,
        `inline ownership work exceeds publication budgets (segments ${MAX_RENDERED_INLINE_SEGMENTS}, active-owner visits ${MAX_RENDERED_INLINE_ACTIVE_OWNER_VISITS}, wrapper bytes ${MAX_RENDERED_INLINE_WRAPPER_BYTES})`,
      )
  }
  const relationships = new Map(
    document.relationships.map((relationship) => [
      relationship.id,
      relationship,
    ]),
  )
  const renderedRelationshipIds = new Set<string>()
  for (const note of authorNotes) {
    const relationship = relationships.get(note.id)
    if (
      authors.includes(note.author) &&
      relationship?.status === 'matched' &&
      (relationship.kind === 'footnote' || relationship.kind === 'endnote') &&
      relationship.to.includes(note.target)
    )
      renderedRelationshipIds.add(note.id)
  }
  const sources = drafts.map((draft) => ({
    ...draft.source,
    segments: materializeInlinePlan(draft),
  }))
  const sourceByKey = new Map(sources.map((source) => [source.key, source]))
  for (const source of sources)
    for (const segment of source.segments) {
      const semanticRun = segment.owners.find(
        (run) => run.semanticRole && run.relationshipId,
      )
      if (semanticRun?.relationshipId)
        renderedRelationshipIds.add(semanticRun.relationshipId)
    }
  const backlinksByTarget = new Map<
    string,
    StructDocument['relationships'][number][]
  >()
  for (const relationship of document.relationships) {
    if (
      relationship.status !== 'matched' ||
      !renderedRelationshipIds.has(relationship.id) ||
      (relationship.kind !== 'footnote' && relationship.kind !== 'endnote')
    )
      continue
    for (const target of relationship.to) {
      const backlinks = backlinksByTarget.get(target) ?? []
      backlinks.push(relationship)
      backlinksByTarget.set(target, backlinks)
    }
  }
  const authorNotesByAuthor = new Map<string, typeof authorNotes>()
  for (const note of authorNotes) {
    const notes = authorNotesByAuthor.get(note.author) ?? []
    notes.push(note)
    authorNotesByAuthor.set(note.author, notes)
  }
  return {
    sources,
    sourceByKey,
    relationships,
    renderedRelationshipIds,
    backlinksByTarget,
    authorNotesByAuthor,
  }
}

/** Return relationship IDs that have an owner in the actual rendered plan. */
export function renderedInlineRelationshipIds(document: StructDocument) {
  return buildRenderedPublicationPlan(document).renderedRelationshipIds
}

/**
 * Describe every id that the publication XHTML renderer can emit. Relationship
 * ids are document-scoped: one relationship occurrence receives the id and
 * later occurrences reuse its data without emitting another id attribute.
 */
export function emittedXhtmlIds(
  document: StructDocument,
  publicationPlan = buildRenderedPublicationPlan(document),
): EmittedXhtmlId[] {
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
  const relationshipIds = new Set<string>()
  const authorNoteAliasIds = new Set(
    (document.metadata.authorNotes ?? [])
      .filter((note) => {
        const relationship = publicationPlan.relationships.get(note.id)
        return (
          relationship?.status === 'matched' &&
          (relationship.kind === 'footnote' ||
            relationship.kind === 'endnote') &&
          relationship.to.includes(note.target)
        )
      })
      .map((note) => note.id),
  )
  for (const [index, note] of (document.metadata.authorNotes ?? []).entries())
    entries.push({
      id: stableId(note.id),
      path: `$.metadata.authorNotes[${index}].id`,
    })
  for (const source of publicationPlan.sources) {
    for (const segment of source.segments) {
      const run = segment.owners.find(
        (owner) => owner.relationshipId && owner.semanticRole,
      )
      if (
        !run?.relationshipId ||
        relationshipIds.has(run.relationshipId) ||
        authorNoteAliasIds.has(run.relationshipId)
      )
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

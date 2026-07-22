import type { ResearchNode, ResearchPaper } from './schema'
import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfCitationRelationship,
  PdfEmbeddedLink,
  PdfLineBoundaryDecision,
  PdfNoteMarkerClassification,
  PdfNoteRelationship,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfReconstruction,
  PdfVisualAsset,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import {
  assessPdfCompleteness,
  classifyStructuralLineBoundaryDecisions,
} from './pdf-quality'
import {
  classifyPdfNoteMarkers,
  PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD,
} from './pdf-note-classifier'
import { replayPdfRegionLineRanges } from './pdf-lines'
import { reconstructPdfVisuals, type PdfFigureRasterizer } from './pdf-visuals'
import {
  normalizedNoteLabel,
  noteLabelFromText,
  reconstructPageRegions,
} from './pdf-regions'

export type PdfDocumentMetadata = {
  title?: string
  author?: string
  subject?: string
  modified?: string
}

type RegionBlock = {
  type: 'heading' | 'paragraph' | 'caption' | 'footnote'
  region: PdfPageRegion
  text: string
  confidence: number
  headingLevel?: 1 | 2 | 3
  list?: {
    level: number
    ordered: boolean
    numberingId: string
    markerStyle:
      | 'decimal'
      | 'lower-roman'
      | 'upper-roman'
      | 'lower-alpha'
      | 'upper-alpha'
      | 'disc'
    ordinal?: number
    markerText?: string
    continuedFromPreviousPage?: boolean
  }
  noteKind?: 'footnote' | 'endnote'
  noteLabel?: string
  noteMarkerText?: string
  sourceSegments?: Array<{
    region: PdfPageRegion
    evidenceRegion?: PdfPageRegion
    sourceStart: number
    canonicalStart: number
    text: string
  }>
  nodeId?: string
  bibliographyContinuedFromPreviousPage?: boolean
  frontMatterRole?:
    'title' | 'author' | 'affiliation' | 'abstract-heading' | 'abstract-body'
}

type NoteReferenceDraft = {
  id: string
  label: string
  region: PdfPageRegion
  start: number
  end: number
  classification: PdfNoteMarkerClassification
}

type AuthorNoteReferenceDraft = NoteReferenceDraft & {
  author: string
}

type SemanticReferenceDraft = {
  id: string
  start: number
  end: number
  semanticRole:
    'citation' | 'cross-reference' | 'affiliation-marker' | 'bibliography-entry'
  targetIds?: string[]
}

export const PDF_NOTE_RELATIONSHIP_THRESHOLD = 0.7

type CanonicalInlineRun = NonNullable<
  Extract<ResearchNode, { type: 'paragraph' }>['inlineRuns']
>[number]

function median(values: number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function parseAuthors(author?: string) {
  const authors = author
    ?.split(/[;,]/)
    .map((value) => value.trim())
    .filter(Boolean)
  return authors?.length ? authors : ['Imported locally']
}

function headingLevel(text: string, largestFont: number, bodySize: number) {
  const numbered = text.trim().match(/^(\d+(?:\.\d+){0,2})\s+\S/)
  if (numbered) {
    return Math.min(3, numbered[1].split('.').length) as 1 | 2 | 3
  }
  if (
    /^(?:abstract|introduction|methods?|results?|discussion|conclusion|references|endnotes?|notes?)\b/i.test(
      text,
    )
  ) {
    return 1 as const
  }
  return largestFont >= bodySize * 1.45 ? (1 as const) : (2 as const)
}

function likelyAffiliation(value: string) {
  return (
    /(?:university|institute|department|laborator(?:y|ies)|\blabs?\b|school|college|centre|center|hospital|academy|research group|corporation|\binc\b|compan(?:y|ies)|studios?|technolog(?:y|ies)|@|https?:\/\/)/i.test(
      value,
    ) ||
    /(?:\b[A-Z]{2,}\s+\p{Lu}\p{Ll}[\p{L}.-]*|\p{Lu}\p{Ll}[\p{L}.-]*\s+[A-Z]{2,}\b)/u.test(
      value,
    )
  )
}

function normalizedAuthorName(value: string) {
  return value
    .replace(/(?:\s*[\d*†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+)+\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function likelyPersonName(value: string) {
  const normalized = normalizedAuthorName(value)
  if (!normalized || likelyAffiliation(normalized)) return false
  const words = normalized.split(/\s+/)
  if (words.length < 2 || words.length > 8) return false
  return words.every((word) =>
    /^(?:\p{Lu}[\p{L}'’.-]*|(?:de|del|der|di|du|la|le|van|von))$/u.test(word),
  )
}

function authorNamesFromLine(value: string) {
  const hasAttachedAffiliationMarkers =
    /(\p{L})\s*[\d*†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:\s+[\d*†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+)*\s+(?=\p{Lu}\p{Ll})/u.test(
      value,
    )
  const separated = value
    .replace(
      /(\p{L})\s*[\d*†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:\s+[\d*†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+)*\s+(?=\p{Lu}\p{Ll})/gu,
      '$1; ',
    )
    .replace(/\s+\d+(?=[A-Z]{2,}\b)/g, '; ')
    .split(/\s+(?:and|&)\s+|\s*[;,]\s*/i)
    .map(normalizedAuthorName)
    .filter(Boolean)
  const names = separated.filter(likelyPersonName)
  if (
    names.length > 0 &&
    (!likelyAffiliation(value) || hasAttachedAffiliationMarkers)
  ) {
    return names
  }
  return likelyPersonName(value) ? [normalizedAuthorName(value)] : []
}

function inferredAuthors(blocks: RegionBlock[]) {
  const firstPage = blocks.filter(
    (block) => block.region.page === 1 && block.region.box.y < 0.32,
  )
  const titleIndex = firstPage.findIndex((block) => block.type === 'heading')
  if (titleIndex < 0) return []
  const candidates: string[] = []
  for (const block of firstPage.slice(titleIndex + 1)) {
    if (block.type === 'heading') break
    if (block.type !== 'paragraph' || likelyAffiliation(block.text)) continue
    candidates.push(...authorNamesFromLine(block.text))
  }
  return [...new Set(candidates)]
}

function largestBlockFont(block: RegionBlock) {
  return Math.max(...block.region.lines.map((line) => line.fontSize), 0)
}

function classifyFrontMatter(blocks: RegionBlock[], metadataTitle?: string) {
  const firstPage = blocks.filter((block) => block.region.page === 1)
  const comparableTitle = (value: string) =>
    value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const comparableMetadataTitle = metadataTitle
    ? comparableTitle(metadataTitle)
    : undefined
  const metadataMatchesVisibleBlock = Boolean(
    comparableMetadataTitle &&
    firstPage.some(
      (block) => comparableTitle(block.text) === comparableMetadataTitle,
    ),
  )
  const abstractIndex = firstPage.findIndex((block) =>
    /^abstract(?:\s|$)/i.test(block.text.trim()),
  )
  const hasTitlePageEvidence =
    abstractIndex >= 0 ||
    metadataMatchesVisibleBlock ||
    (firstPage.some(
      (block) => block.region.box.y < 0.32 && likelyAffiliation(block.text),
    ) &&
      firstPage.some(
        (block) => block.region.box.y < 0.2 && largestBlockFont(block) >= 14,
      ))
  if (!hasTitlePageEvidence) {
    return { title: undefined, authors: [], affiliations: [], abstract: '' }
  }
  const abstractBlock =
    abstractIndex >= 0 ? firstPage[abstractIndex] : undefined
  const beforeAbstract = abstractBlock
    ? firstPage.filter(
        (block) =>
          block !== abstractBlock &&
          block.region.box.y + block.region.box.height <=
            abstractBlock.region.box.y + 0.01,
      )
    : firstPage.filter((block) => block.region.box.y < 0.32)
  const metadataTitleBlock = comparableMetadataTitle
    ? beforeAbstract.find(
        (block) => comparableTitle(block.text) === comparableMetadataTitle,
      )
    : undefined
  const titleBlock =
    metadataTitleBlock ??
    [...beforeAbstract]
      .filter((block) => !likelyAffiliation(block.text))
      .sort(
        (left, right) =>
          largestBlockFont(right) - largestBlockFont(left) ||
          left.region.box.y - right.region.box.y,
      )[0]
  if (titleBlock) titleBlock.frontMatterRole = 'title'

  const titleFont = titleBlock ? largestBlockFont(titleBlock) : 0
  for (const block of beforeAbstract) {
    if (block === titleBlock) continue
    const alignedWithTitle = Boolean(
      titleBlock &&
      (Math.abs(block.region.box.x - titleBlock.region.box.x) <= 0.025 ||
        Math.abs(
          block.region.box.x +
            block.region.box.width / 2 -
            (titleBlock.region.box.x + titleBlock.region.box.width / 2),
        ) <= 0.035),
    )
    const strongTitleContinuation = Boolean(
      titleBlock &&
      block.region.box.y > titleBlock.region.box.y &&
      !/^\p{L}$/u.test(block.text.trim()) &&
      !likelyAffiliation(block.text) &&
      authorNamesFromLine(block.text).length === 0 &&
      alignedWithTitle &&
      (largestBlockFont(block) >= titleFont * 0.62 ||
        (!/[.!?](?:\s|$)/.test(block.text) && block.region.box.y < 0.32)),
    )
    if (strongTitleContinuation) {
      block.frontMatterRole = 'title'
    } else if (authorNamesFromLine(block.text).length > 0) {
      block.frontMatterRole = 'author'
    } else if (likelyAffiliation(block.text)) {
      block.frontMatterRole = 'affiliation'
    }
  }

  let abstractText = ''
  if (abstractBlock) {
    const inlineAbstract = abstractBlock.text
      .trim()
      .match(/^abstract\s*[:.—-]?\s+(.+)$/i)?.[1]
    abstractBlock.frontMatterRole = inlineAbstract
      ? 'abstract-body'
      : 'abstract-heading'
    if (inlineAbstract) abstractText = inlineAbstract.trim()
    for (const block of firstPage.slice(abstractIndex + 1)) {
      if (block.type === 'heading') break
      if (block.region.box.y <= abstractBlock.region.box.y) continue
      block.frontMatterRole = 'abstract-body'
      abstractText = [abstractText, block.text].filter(Boolean).join(' ')
    }
  }

  const inferredTitle = beforeAbstract
    .filter((block) => block.frontMatterRole === 'title')
    .sort(
      (left, right) =>
        left.region.page - right.region.page ||
        left.region.box.y - right.region.box.y ||
        left.region.box.x - right.region.box.x,
    )
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(' ')
  const metadataCorroborated = Boolean(
    metadataTitle?.trim() &&
    inferredTitle &&
    comparableTitle(metadataTitle) === comparableTitle(inferredTitle),
  )
  const title =
    (metadataCorroborated ? metadataTitle?.trim() : undefined) ||
    inferredTitle ||
    undefined
  const authors = beforeAbstract.flatMap((block) =>
    block.frontMatterRole === 'author' ? authorNamesFromLine(block.text) : [],
  )
  const affiliations = beforeAbstract.flatMap((block) =>
    block.frontMatterRole === 'affiliation' ? [block.text.trim()] : [],
  )
  return {
    title,
    authors: [...new Set(authors)],
    affiliations: [...new Set(affiliations)],
    abstract: abstractText.trim(),
  }
}

function validDate(value?: string) {
  if (!value) return '1970-01-01'
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf())
    ? '1970-01-01'
    : parsed.toISOString().slice(0, 10)
}

function slug(value: string, maximum = 36) {
  return (
    value
      .toLocaleLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, maximum) || 'content'
  )
}

function nodeId(index: number, type: RegionBlock['type'], text: string) {
  const prefix =
    type === 'heading' ? 'sec' : type === 'caption' ? 'caption' : 'p'
  return `${prefix}-${String(index + 1).padStart(3, '0')}-${slug(text)}`
}

function visualCanonicalNodeId(
  relationship: PdfVisualRelationship,
  page: number,
) {
  const sourceAnchor =
    relationship.sourceObjectIds[0] ??
    relationship.sourceRegionIds[0] ??
    relationship.captionRegionId
  return [
    'visual',
    relationship.kind,
    `p${String(page).padStart(3, '0')}`,
    slug(relationship.label, 24),
    slug(sourceAnchor, 40),
    slug(relationship.id, 32),
  ].join('-')
}

function assertUniqueCanonicalNodeIds(nodes: ResearchNode[]) {
  const seen = new Set<string>()
  for (const node of nodes) {
    if (seen.has(node.id)) {
      throw new Error('PDF canonical node ids must be globally unique.')
    }
    seen.add(node.id)
  }
}

function isIsolatedProseGlyph(block: RegionBlock) {
  return (
    (block.type === 'paragraph' || block.type === 'heading') &&
    /^\p{L}$/u.test(block.text.trim())
  )
}

function noteText(region: PdfPageRegion, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    normalizedNoteLabel(region.text)
      .replace(
        new RegExp(
          `^(?:(?:footnote|note)\\s+)?${escaped}(?:\\s*[:.)\\]-]|\\s+)\\s*`,
          'i',
        ),
        '',
      )
      .trim() || region.text.trim()
  )
}

function noteMarkerText(region: PdfPageRegion, label: string) {
  const marker = region.text
    .trim()
    .match(
      /^(?:(?:footnote|note)\s+)?(?:\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*†‡§])(?:\s*[:.)\]-])?/iu,
    )?.[0]
    ?.trim()
  return marker && normalizedNoteLabel(marker).includes(label) ? marker : label
}

function romanOrdinal(value: string) {
  const digits: Record<string, number> = {
    i: 1,
    v: 5,
    x: 10,
    l: 50,
    c: 100,
    d: 500,
    m: 1000,
  }
  const normalized = value.toLocaleLowerCase()
  let total = 0
  for (let index = 0; index < normalized.length; index += 1) {
    const current = digits[normalized[index]] ?? 0
    const next = digits[normalized[index + 1]] ?? 0
    total += current < next ? -current : current
  }
  return Math.max(total, 1)
}

function orderedMarker(marker: string) {
  if (/^\d+$/.test(marker)) {
    return { markerStyle: 'decimal' as const, ordinal: Number(marker) }
  }
  if (/^[ivxlcdm]+$/i.test(marker)) {
    return {
      markerStyle: (marker === marker.toLocaleUpperCase()
        ? 'upper-roman'
        : 'lower-roman') as 'upper-roman' | 'lower-roman',
      ordinal: romanOrdinal(marker),
    }
  }
  return {
    markerStyle: (marker === marker.toLocaleUpperCase()
      ? 'upper-alpha'
      : 'lower-alpha') as 'upper-alpha' | 'lower-alpha',
    ordinal: marker.toLocaleLowerCase().charCodeAt(0) - 96,
  }
}

function parsedOrderedListMarker(value: string) {
  const trimmed = value.trimStart()
  const match = trimmed.match(
    /^(?:(\[\s*(\d+)\s*\])|(\(\s*(\d+|[A-Za-z]|[ivxlcdm]+)\s*\))|((\d+|[A-Za-z]|[ivxlcdm]+)[.)]))\s+(.+)$/i,
  )
  if (!match) return null
  const markerText = match[1] ?? match[3] ?? match[5]
  const marker = match[2] ?? match[4] ?? match[6]
  if (/^\d{4}$/.test(marker) && Number(marker) >= 1800) return null
  return {
    markerText,
    itemText: match[7],
    contentStart:
      value.length - trimmed.length + match[0].length - match[7].length,
    ...orderedMarker(marker),
  }
}

function parsedBibliographyListMarker(value: string) {
  const trimmed = value.trimStart()
  const match = trimmed.match(
    /^(?:(\[\s*(\d{1,4})\s*\])|(\(\s*(\d{1,4})\s*\))|((\d{1,3})[.)]))\s+(.+)$/u,
  )
  if (!match) return null
  const markerText = match[1] ?? match[3] ?? match[5]
  const marker = match[2] ?? match[4] ?? match[6]
  if (/^\d{4}$/u.test(marker) && Number(marker) >= 1800) return null
  return {
    label: marker,
    markerText,
    itemText: match[7],
    contentStart:
      value.length - trimmed.length + match[0].length - match[7].length,
    markerStyle: 'decimal' as const,
    ordinal: Number(marker),
  }
}

export type RecoveredBibliographyClassificationBlock = {
  region: PdfPageRegion
  list?: {
    numberingId: string
    ordinal?: number
    markerText?: string
  }
  sourceSegments?: Array<{
    region: PdfPageRegion
    evidenceRegion?: PdfPageRegion
    sourceStart: number
    canonicalStart: number
    text: string
  }>
}

export function synthesizeRecoveredBibliographyClassifications(
  classifications: readonly PdfNoteMarkerClassification[],
  blocks: readonly RecoveredBibliographyClassificationBlock[],
) {
  const recovered = [...classifications]
  const classifiedLabels = new Set(
    classifications
      .filter(
        (classification) => classification.taxonomy === 'bibliography-entry',
      )
      .map(
        (classification) =>
          `${classification.referenceRegionId}:${normalizedNoteLabel(classification.label)}`,
      ),
  )
  const usedIds = new Set(
    classifications.map((classification) => classification.id),
  )

  for (const block of blocks) {
    if (
      block.list?.numberingId !== 'references' ||
      block.list.ordinal === undefined ||
      !block.list.markerText
    ) {
      continue
    }
    const firstSegment = block.sourceSegments?.find(
      (segment) => segment.canonicalStart === 0,
    )
    if (!firstSegment) continue
    const evidenceRegion = firstSegment.evidenceRegion ?? firstSegment.region
    const marker = parsedBibliographyListMarker(evidenceRegion.text)
    if (
      !marker ||
      marker.ordinal !== block.list.ordinal ||
      marker.markerText !== block.list.markerText
    ) {
      continue
    }
    const labelKey = `${firstSegment.region.id}:${normalizedNoteLabel(marker.label)}`
    if (classifiedLabels.has(labelKey)) continue

    const markerOffset = evidenceRegion.text.indexOf(marker.markerText)
    const evidenceSourceStart = firstSegment.sourceStart - marker.contentStart
    const start = evidenceSourceStart + markerOffset
    const end = start + marker.markerText.length
    if (
      markerOffset < 0 ||
      start < 0 ||
      firstSegment.region.text.slice(start, end) !== marker.markerText
    ) {
      continue
    }

    const idBase = `noteref-p${String(firstSegment.region.page).padStart(3, '0')}-${slug(marker.label, 16)}-${slug(firstSegment.region.id, 48)}-s${String(start).padStart(6, '0')}-e${String(end).padStart(6, '0')}`
    let occurrence = 1
    let id = `${idBase}-${String(occurrence).padStart(3, '0')}`
    while (usedIds.has(id)) {
      occurrence += 1
      id = `${idBase}-${String(occurrence).padStart(3, '0')}`
    }
    usedIds.add(id)
    classifiedLabels.add(labelKey)
    recovered.push({
      id,
      label: marker.label,
      referenceRegionId: firstSegment.region.id,
      start,
      end,
      taxonomy: 'bibliography-entry',
      disposition: 'plain-text',
      confidence: 0.99,
      threshold: PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD,
      accepted: true,
      evidence: [
        'source-backed-bibliography-marker',
        'recovered-bibliography-entry',
        'reference-list-section-scope',
      ],
      sourceBox: { ...evidenceRegion.box },
    })
  }

  return recovered
}

function parsedBulletListMarker(value: string) {
  const trimmed = value.trimStart()
  const match = trimmed.match(/^([•◦▪‣–—-])\s+(.+)$/u)
  return match
    ? {
        markerText: match[1],
        itemText: match[2],
        contentStart:
          value.length - trimmed.length + match[0].length - match[2].length,
      }
    : null
}

function blockSourceSegments(block: RegionBlock) {
  return (
    block.sourceSegments ?? [
      {
        region: block.region,
        sourceStart: 0,
        canonicalStart: 0,
        text: block.text,
      },
    ]
  )
}

function stripBlockMarker(
  block: RegionBlock,
  marker: { itemText: string; contentStart: number },
) {
  const text = marker.itemText.trim()
  const contentEnd = marker.contentStart + text.length
  const existingSegments = blockSourceSegments(block)
  block.text = text
  block.sourceSegments = existingSegments.flatMap((segment) => {
    const segmentEnd = segment.canonicalStart + segment.text.length
    const overlapStart = Math.max(marker.contentStart, segment.canonicalStart)
    const overlapEnd = Math.min(contentEnd, segmentEnd)
    if (overlapStart >= overlapEnd) return []
    const relativeStart = overlapStart - segment.canonicalStart
    const relativeEnd = overlapEnd - segment.canonicalStart
    return [
      {
        region: segment.region,
        ...(segment.evidenceRegion
          ? { evidenceRegion: segment.evidenceRegion }
          : {}),
        sourceStart: segment.sourceStart + relativeStart,
        canonicalStart: overlapStart - marker.contentStart,
        text: segment.text.slice(relativeStart, relativeEnd),
      },
    ]
  })
}

function appendBlockContinuation(
  target: RegionBlock,
  continuation: RegionBlock,
) {
  const previousMaximumPage = Math.max(
    ...blockSourceSegments(target).map((segment) => segment.region.page),
  )
  const separator = target.text ? ' ' : ''
  const canonicalStart = target.text.length + separator.length
  target.sourceSegments = [
    ...blockSourceSegments(target),
    ...blockSourceSegments(continuation).map((segment) => ({
      ...segment,
      canonicalStart: canonicalStart + segment.canonicalStart,
    })),
  ]
  target.text = `${target.text}${separator}${continuation.text}`
  target.confidence = Math.min(target.confidence, continuation.confidence)
  if (target.list && continuation.region.page > previousMaximumPage) {
    target.list.continuedFromPreviousPage = true
  }
}

function likelyUnmarkedCrossPageContinuation(
  target: RegionBlock,
  continuation: RegionBlock,
) {
  const previousText = target.text.trimEnd()
  const continuationText = continuation.text.trimStart()
  return Boolean(
    previousText &&
    continuationText &&
    !/[.!?](?:["'’”\])}]*)$/u.test(previousText) &&
    /^\p{Ll}/u.test(continuationText),
  )
}

function mergeProseContinuations(blocks: RegionBlock[]) {
  for (let index = 0; index < blocks.length; index += 1) {
    const target = blocks[index]
    if (target.type !== 'paragraph' || target.list) continue
    while (true) {
      let continuationIndex = index + 1
      while (
        continuationIndex < blocks.length &&
        (blocks[continuationIndex].type === 'caption' ||
          blocks[continuationIndex].type === 'footnote')
      ) {
        continuationIndex += 1
      }
      const continuation = blocks[continuationIndex]
      if (
        continuation?.type !== 'paragraph' ||
        continuation.list ||
        !likelyUnmarkedCrossPageContinuation(target, continuation)
      ) {
        break
      }
      appendBlockContinuation(target, continuation)
      blocks.splice(continuationIndex, 1)
    }
  }
}

function boxForRegionLines(lines: PdfPageRegion['lines']): NormalizedSourceBox {
  const left = Math.min(...lines.map((line) => line.box.x))
  const top = Math.min(...lines.map((line) => line.box.y))
  const right = Math.max(...lines.map((line) => line.box.x + line.box.width))
  const bottom = Math.max(...lines.map((line) => line.box.y + line.box.height))
  return {
    page: lines[0].box.page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation: lines[0].box.rotation,
    method: lines.some((line) => line.box.method === 'ocr')
      ? 'ocr'
      : 'pdf-text',
  }
}

type BibliographyIndentationProfile = {
  baseX: number
  continuationX: number
}

function bibliographyFlowKey(region: Pick<PdfPageRegion, 'page' | 'column'>) {
  return `${region.page}:${region.column}`
}

function bibliographyIndentationProfiles(
  blocks: RegionBlock[],
  bibliographyRegionIds: ReadonlySet<string>,
) {
  const linesByFlow = new Map<string, PdfPageRegion['lines']>()
  for (const block of blocks) {
    if (
      block.type !== 'paragraph' ||
      !bibliographyRegionIds.has(block.region.id)
    ) {
      continue
    }
    const key = bibliographyFlowKey(block.region)
    const lines = linesByFlow.get(key) ?? []
    lines.push(...block.region.lines.filter((line) => line.text.trim()))
    linesByFlow.set(key, lines)
  }

  const profiles = new Map<string, BibliographyIndentationProfile>()
  for (const [key, lines] of linesByFlow) {
    if (lines.length < 4) continue
    const baseX = Math.min(...lines.map((line) => line.box.x))
    const baseLines = lines.filter(
      (line) => Math.abs(line.box.x - baseX) <= 0.004,
    )
    const continuationCandidates = lines.filter((line) => {
      const indentation = line.box.x - baseX
      return indentation >= 0.008 && indentation <= 0.04
    })
    const continuationX = median(
      continuationCandidates.map((line) => line.box.x),
    )
    const continuationLines = continuationCandidates.filter(
      (line) => Math.abs(line.box.x - continuationX) <= 0.004,
    )
    if (
      baseLines.length < 2 ||
      continuationLines.length < 2 ||
      continuationX - baseX < 0.008
    ) {
      continue
    }
    profiles.set(key, { baseX, continuationX })
  }
  return profiles
}

function bibliographyLineIndentation(
  line: PdfPageRegion['lines'][number],
  profile: BibliographyIndentationProfile,
) {
  if (Math.abs(line.box.x - profile.baseX) <= 0.004) return 'entry' as const
  if (Math.abs(line.box.x - profile.continuationX) <= 0.004) {
    return 'continuation' as const
  }
  return 'unknown' as const
}

function splitBibliographyBlock(
  block: RegionBlock,
  bibliographyRegionIds: ReadonlySet<string>,
  profiles: ReadonlyMap<string, BibliographyIndentationProfile>,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  const bibliography =
    bibliographyRegionIds.has(block.region.id) ||
    /^\[\d+\]\s+/u.test(block.text.trim())
  if (
    !bibliography ||
    block.type !== 'paragraph' ||
    block.region.lines.length < 2 ||
    block.sourceSegments
  ) {
    return [block]
  }
  const replay = replayPdfRegionLineRanges(block.region, lineBoundaryDecisions)
  if (!replay || replay.text !== block.text) return [block]

  const profile = profiles.get(bibliographyFlowKey(block.region))
  const fragmentStarts = [0]
  for (let index = 1; index < block.region.lines.length; index += 1) {
    const line = block.region.lines[index]
    const previous = block.region.lines[index - 1]
    const lineRange = replay.ranges.get(line.id)
    const previousRange = replay.ranges.get(previous.id)
    if (
      !lineRange ||
      !previousRange ||
      lineRange.start !== previousRange.end + 1
    ) {
      continue
    }
    const explicitEntry = Boolean(parsedBibliographyListMarker(line.text))
    const hangingIndentEntry =
      profile && bibliographyLineIndentation(line, profile) === 'entry'
    if (explicitEntry || hangingIndentEntry) fragmentStarts.push(index)
  }
  if (fragmentStarts.length === 1) return [block]

  const fragments: RegionBlock[] = []
  for (const [fragmentIndex, startIndex] of fragmentStarts.entries()) {
    const endIndex =
      (fragmentStarts[fragmentIndex + 1] ?? block.region.lines.length) - 1
    const lines = block.region.lines.slice(startIndex, endIndex + 1)
    const firstRange = replay.ranges.get(lines[0].id)
    const lastRange = replay.ranges.get(lines.at(-1)!.id)
    if (!firstRange || !lastRange || firstRange.start >= lastRange.end) {
      return [block]
    }
    const sourceStart = firstRange.start
    const sourceEnd = lastRange.end
    const text = block.region.text.slice(sourceStart, sourceEnd)
    const evidenceRegion: PdfPageRegion = {
      ...block.region,
      box: boxForRegionLines(lines),
      lines,
      text,
    }
    fragments.push({
      ...block,
      region: evidenceRegion,
      text,
      sourceSegments: [
        {
          region: block.region,
          evidenceRegion,
          sourceStart,
          canonicalStart: 0,
          text,
        },
      ],
    })
  }
  return fragments
}

function recoverBibliographyBlocks(
  blocks: RegionBlock[],
  bibliographyRegionIds: ReadonlySet<string>,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
) {
  const profiles = bibliographyIndentationProfiles(
    blocks,
    bibliographyRegionIds,
  )
  const splitBlocks = blocks.flatMap((block) =>
    splitBibliographyBlock(
      block,
      bibliographyRegionIds,
      profiles,
      lineBoundaryDecisions,
    ),
  )
  const recovered: RegionBlock[] = []
  let previousBibliographyBlock: RegionBlock | undefined
  for (const block of splitBlocks) {
    const bibliography =
      block.type === 'paragraph' &&
      (bibliographyRegionIds.has(block.region.id) ||
        /^\[\d+\]\s+/u.test(block.text.trim()))
    if (!bibliography) {
      recovered.push(block)
      previousBibliographyBlock = undefined
      continue
    }
    const profile = profiles.get(bibliographyFlowKey(block.region))
    const firstLine = block.region.lines[0]
    const continuation = Boolean(
      !parsedBibliographyListMarker(block.text) &&
      profile &&
      firstLine &&
      bibliographyLineIndentation(firstLine, profile) === 'continuation',
    )
    if (continuation && previousBibliographyBlock) {
      const previousPages = blockSourceSegments(previousBibliographyBlock).map(
        (segment) => segment.region.page,
      )
      if (block.region.page > Math.max(...previousPages)) {
        previousBibliographyBlock.bibliographyContinuedFromPreviousPage = true
      }
      appendBlockContinuation(previousBibliographyBlock, block)
      continue
    }
    recovered.push(block)
    previousBibliographyBlock = block
  }
  return recovered
}

export type PdfResidualRegionFragment = {
  region: PdfPageRegion
  sourceRegion: PdfPageRegion
  sourceStart: number
  sourceEnd: number
}

function splitLeadingStyledHeadingRegion(
  region: PdfPageRegion,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
): PdfResidualRegionFragment[] {
  if (region.lines.length < 2) {
    return [
      {
        region,
        sourceRegion: region,
        sourceStart: 0,
        sourceEnd: region.text.length,
      },
    ]
  }
  const firstLine = region.lines[0]
  const continuationLine = region.lines[1]
  const match = firstLine.text
    .trim()
    .match(/^\d+(?:\.\d+){0,3}[.)]?\s+(\S.*)$/u)
  if (!match) {
    return [
      {
        region,
        sourceRegion: region,
        sourceStart: 0,
        sourceEnd: region.text.length,
      },
    ]
  }
  const emphasizedShare = (line: PdfPageRegion['lines'][number]) => {
    const runs = line.runs.filter((run) => run.text.trim())
    const visible = runs.reduce(
      (total, run) => total + run.text.trim().length,
      0,
    )
    const emphasized = runs.reduce(
      (total, run) =>
        total +
        (run.bold ||
        /(?:bold|black|demi|semibold|(?:^|[-+,_])medi(?:$|[-+,_]))/i.test(
          run.fontName,
        )
          ? run.text.trim().length
          : 0),
      0,
    )
    return visible > 0 ? emphasized / visible : 0
  }
  const titleText = match[1]
  const multiLevelSmallCaps =
    /^\d+(?:\.\d+){2,3}[.)]?\s/u.test(firstLine.text.trim()) &&
    /\p{Lu}/u.test(titleText) &&
    !/\p{Ll}/u.test(titleText)
  const styledHeadingPrefix =
    emphasizedShare(firstLine) >= 0.6 && emphasizedShare(continuationLine) < 0.5
  if (!styledHeadingPrefix && !multiLevelSmallCaps) {
    return [
      {
        region,
        sourceRegion: region,
        sourceStart: 0,
        sourceEnd: region.text.length,
      },
    ]
  }
  const replay = replayPdfRegionLineRanges(region, lineBoundaryDecisions)
  const firstRange = replay?.ranges.get(firstLine.id)
  const continuationRange = replay?.ranges.get(continuationLine.id)
  if (
    !replay ||
    replay.text !== region.text ||
    !firstRange ||
    !continuationRange ||
    continuationRange.start !== firstRange.end + 1
  ) {
    return [
      {
        region,
        sourceRegion: region,
        sourceStart: 0,
        sourceEnd: region.text.length,
      },
    ]
  }
  const headingRegion: PdfPageRegion = {
    ...region,
    box: boxForRegionLines([firstLine]),
    lines: [firstLine],
    text: region.text.slice(0, firstRange.end),
  }
  const proseLines = region.lines.slice(1)
  const proseRegion: PdfPageRegion = {
    ...region,
    box: boxForRegionLines(proseLines),
    lines: proseLines,
    text: region.text.slice(continuationRange.start),
  }
  return [
    {
      region: headingRegion,
      sourceRegion: region,
      sourceStart: 0,
      sourceEnd: firstRange.end,
    },
    {
      region: proseRegion,
      sourceRegion: region,
      sourceStart: continuationRange.start,
      sourceEnd: region.text.length,
    },
  ]
}

export function residualPdfRegionFragmentsAfterLineConsumption(
  region: PdfPageRegion,
  consumedLineIds: ReadonlySet<string>,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
): PdfResidualRegionFragment[] {
  if (region.lines.every((line) => !consumedLineIds.has(line.id))) {
    return [
      {
        region,
        sourceRegion: region,
        sourceStart: 0,
        sourceEnd: region.text.length,
      },
    ]
  }
  const replay = replayPdfRegionLineRanges(region, lineBoundaryDecisions)
  if (!replay || replay.text !== region.text) {
    throw new Error(
      `Cannot replay source line boundaries for partial PDF region ${region.id}.`,
    )
  }
  const retainedRuns: PdfPageRegion['lines'][] = []
  for (const line of region.lines) {
    if (consumedLineIds.has(line.id)) continue
    const previous = region.lines[region.lines.indexOf(line) - 1]
    if (!previous || consumedLineIds.has(previous.id)) retainedRuns.push([])
    retainedRuns.at(-1)!.push(line)
  }
  return retainedRuns.map((lines) => {
    const first = replay.ranges.get(lines[0].id)
    const last = replay.ranges.get(lines.at(-1)!.id)
    if (!first || !last || first.start > last.end) {
      throw new Error(
        `Cannot map retained source lines for partial PDF region ${region.id}.`,
      )
    }
    const sourceStart = first.start
    const sourceEnd = last.end
    return {
      region: {
        ...region,
        box: boxForRegionLines(lines),
        lines,
        text: region.text.slice(sourceStart, sourceEnd),
      },
      sourceRegion: region,
      sourceStart,
      sourceEnd,
    }
  })
}

export function residualPdfRegionAfterLineConsumption(
  region: PdfPageRegion,
  consumedLineIds: ReadonlySet<string>,
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
): PdfPageRegion | null {
  const fragments = residualPdfRegionFragmentsAfterLineConsumption(
    region,
    consumedLineIds,
    lineBoundaryDecisions,
  )
  if (fragments.length > 1) {
    throw new Error(
      `Cannot collapse noncontiguous retained lines for partial PDF region ${region.id}.`,
    )
  }
  return fragments[0]?.region ?? null
}

function blocksFromRegions(
  orderedRegions: PdfPageRegion[],
  regions: PdfPageRegion[],
  excludedRegionIds = new Set<string>(),
  bibliographyRegionIds: ReadonlySet<string> = new Set<string>(),
  sourceEquationCaptions: ReadonlyMap<string, string> = new Map<
    string,
    string
  >(),
  consumedLineIds: ReadonlySet<string> = new Set<string>(),
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[] = [],
) {
  const residualFragments = new WeakMap<
    PdfPageRegion,
    PdfResidualRegionFragment
  >()
  const retainedRegions = orderedRegions.flatMap((region) => {
    if (
      excludedRegionIds.has(region.id) ||
      ![
        'body',
        'spanning',
        'caption',
        'equation',
        'footnote',
        'endnote',
      ].includes(region.kind)
    ) {
      return []
    }
    const fragments = residualPdfRegionFragmentsAfterLineConsumption(
      region,
      consumedLineIds,
      lineBoundaryDecisions,
    )
    for (const fragment of fragments) {
      if (
        fragment.sourceStart !== 0 ||
        fragment.sourceEnd !== fragment.sourceRegion.text.length
      ) {
        residualFragments.set(fragment.region, fragment)
      }
    }
    return fragments.map((fragment) => fragment.region)
  })
  const bodySize =
    median(
      regions
        .filter((region) => region.kind === 'body')
        .flatMap((region) => region.lines.map((line) => line.fontSize)),
    ) || 12
  const readingRegions = retainedRegions.flatMap((region) => {
    if (bibliographyRegionIds.has(region.id) || residualFragments.has(region)) {
      return [region]
    }
    const fragments = splitLeadingStyledHeadingRegion(
      region,
      lineBoundaryDecisions,
    )
    if (fragments.length === 1) return [region]
    for (const fragment of fragments) {
      residualFragments.set(fragment.region, fragment)
    }
    return fragments.map((fragment) => fragment.region)
  })
  const numberedCandidates = readingRegions.flatMap((region, index) => {
    const trimmed = region.text.trim()
    const match = trimmed.match(/^(\d+(?:\.\d+){0,3})[.)]?\s+(\S.*)$/u)
    const styledAsHeading =
      Math.max(...region.lines.map((line) => line.fontSize), bodySize) >=
        bodySize * 1.12 ||
      region.lines
        .flatMap((line) => line.runs)
        .some(
          (run) =>
            run.bold ||
            /(?:bold|black|demi|semibold|(?:^|[-+,_])medi(?:$|[-+,_]))/i.test(
              run.fontName,
            ),
        )
    if (
      !match ||
      (/^\d+[.)]\s/u.test(trimmed) && !styledAsHeading) ||
      region.lines.length > 2 ||
      trimmed.length > 180 ||
      /[.!?](?:["'’”)\]]*)$/u.test(trimmed)
    ) {
      return []
    }
    return [
      {
        index,
        regionId: region.id,
        ordinal: match[1].split('.').map(Number),
      },
    ]
  })
  const sequencedNumberedHeadingRegions = new Set<PdfPageRegion>()
  const followsInSequence = (left: number[], right: number[]) =>
    left.length === right.length &&
    left.slice(0, -1).every((part, index) => part === right[index]) &&
    right.at(-1) === (left.at(-1) ?? 0) + 1
  for (let index = 0; index < numberedCandidates.length - 1; index += 1) {
    const current = numberedCandidates[index]
    const next = numberedCandidates[index + 1]
    if (
      next.index > current.index + 1 &&
      followsInSequence(current.ordinal, next.ordinal)
    ) {
      sequencedNumberedHeadingRegions.add(readingRegions[current.index])
      sequencedNumberedHeadingRegions.add(readingRegions[next.index])
    }
  }
  const initialBlocks = readingRegions.map<RegionBlock>(
    (region, regionIndex) => {
      const residualFragment = residualFragments.get(region)
      const sourceSegments = residualFragment
        ? [
            {
              region: residualFragment.sourceRegion,
              evidenceRegion: region,
              sourceStart: residualFragment.sourceStart,
              canonicalStart: 0,
              text: region.text,
            },
          ]
        : undefined
      if (region.kind === 'caption') {
        return {
          type: 'caption',
          region,
          text: region.text,
          confidence: region.confidence,
          ...(sourceSegments ? { sourceSegments } : {}),
        }
      }
      if (region.kind === 'equation' && sourceEquationCaptions.has(region.id)) {
        return {
          type: 'caption',
          region,
          text: sourceEquationCaptions.get(region.id)!,
          confidence: region.confidence,
        }
      }
      if (
        (region.kind === 'footnote' || region.kind === 'endnote') &&
        !bibliographyRegionIds.has(region.id)
      ) {
        const label = noteLabelFromText(region.text) ?? '?'
        return {
          type: 'footnote',
          region,
          text: noteText(region, label),
          confidence: region.confidence,
          noteKind: region.kind,
          noteLabel: label,
          noteMarkerText: noteMarkerText(region, label),
        }
      }
      const largestFont = Math.max(
        ...region.lines.map((line) => line.fontSize),
        bodySize,
      )
      const styledRuns = region.lines.flatMap((line) =>
        line.runs.filter((run) => run.text.trim()),
      )
      const emphasizedCharacters = styledRuns.reduce(
        (total, run) =>
          total +
          (run.bold ||
          /(?:bold|black|demi|semibold|(?:^|[-+,_])medi(?:$|[-+,_]))/i.test(
            run.fontName,
          )
            ? run.text.trim().length
            : 0),
        0,
      )
      const visibleCharacters = styledRuns.reduce(
        (total, run) => total + run.text.trim().length,
        0,
      )
      const compactEquationSyntax = (() => {
        if (region.kind !== 'equation' || !/[=+−×÷∫∑√≤≥≈]/u.test(region.text)) {
          return false
        }
        const words = region.text.match(/\p{L}+/gu) ?? []
        return (
          words.length <= 6 &&
          words.filter((word) => word.length > 2).length <= 1
        )
      })()
      const emphasizedNumberedHeading =
        emphasizedCharacters >= Math.max(1, visibleCharacters * 0.6) &&
        /^\d+(?:\.\d+){0,3}[.)]?\s+\p{Lu}/u.test(region.text.trim()) &&
        (!/^\d+[.)]\s/u.test(region.text.trim()) ||
          largestFont >= bodySize * 1.12)
      const namedSectionPrefix =
        /^(?:abstract|introduction|methods?|results?|discussion|conclusion|references|endnotes?|notes?)\b/i.test(
          region.text,
        )
      const namedSectionHeading =
        namedSectionPrefix &&
        (/^\p{Lu}/u.test(region.text.trim()) ||
          /^(?:abstract|introduction|methods?|results?|discussion|conclusion|references|endnotes?|notes?)$/i.test(
            region.text.trim(),
          ) ||
          emphasizedCharacters >= Math.max(1, visibleCharacters * 0.6))
      const numberedSectionHeading =
        /^\d+(?:\.\d+){0,3}[.)]?\s+(?:abstract|introduction|background|related work|literature review|methods?|methodology|approach|framework|experiments?|evaluation|results?|discussion|limitations?|conclusion|references|appendix)\b/i.test(
          region.text.trim(),
        )
      const headingBoundaryEvidence =
        region.lines.length <= 2 &&
        region.text.trim().length <= 180 &&
        !/[.](?:["'’”)]*)$/.test(region.text.trim())
      const probableFirstPageAuthorLine =
        region.page === 1 &&
        regionIndex > 0 &&
        region.box.y < 0.28 &&
        !/[.!?](?:\s|$)/.test(region.text) &&
        authorNamesFromLine(region.text).length > 0
      const fontOnlyHeading =
        region.text.trim().length > 1 &&
        largestFont >= bodySize * 1.18 &&
        (/^\p{Lu}/u.test(region.text.trim()) ||
          /^\d+(?:\.\d+){1,3}\s+\p{Lu}/u.test(region.text.trim()) ||
          compactEquationSyntax) &&
        !/[,;]/u.test(region.text)
      const heading =
        !probableFirstPageAuthorLine &&
        headingBoundaryEvidence &&
        (namedSectionHeading ||
          numberedSectionHeading ||
          emphasizedNumberedHeading ||
          sequencedNumberedHeadingRegions.has(region) ||
          fontOnlyHeading)
      return {
        type: heading ? 'heading' : 'paragraph',
        region,
        text: region.text,
        confidence: Math.min(region.confidence, heading ? 0.9 : 0.86),
        ...(sourceSegments ? { sourceSegments } : {}),
        ...(heading
          ? { headingLevel: headingLevel(region.text, largestFont, bodySize) }
          : {}),
      }
    },
  )
  const blocks = recoverBibliographyBlocks(
    initialBlocks,
    bibliographyRegionIds,
    lineBoundaryDecisions,
  )

  let activeList:
    | {
        page: number
        column: PdfPageRegion['column']
        baseX: number
        numberingId: string
        ordered: boolean
        markerStyle: NonNullable<RegionBlock['list']>['markerStyle']
        lastOrdinal?: number
      }
    | undefined
  let lastBibliographyEntryPage: number | undefined
  let pendingBibliographyContinuation:
    { target: RegionBlock; tailPage: number } | undefined
  let lastListBlock: RegionBlock | undefined
  const mergedContinuationBlocks = new Set<RegionBlock>()
  const listCounts = new Map<number, number>()
  for (const block of blocks) {
    if (block.type !== 'paragraph') {
      lastBibliographyEntryPage = undefined
      pendingBibliographyContinuation = undefined
      activeList = undefined
      lastListBlock = undefined
      continue
    }
    const bibliography =
      bibliographyRegionIds.has(block.region.id) ||
      /^\[\d+\]\s+/.test(block.text.trim())
    if (bibliography) {
      const entry = parsedBibliographyListMarker(block.text)
      if (
        !entry &&
        pendingBibliographyContinuation &&
        block.region.page === pendingBibliographyContinuation.tailPage + 1 &&
        likelyUnmarkedCrossPageContinuation(
          pendingBibliographyContinuation.target,
          block,
        )
      ) {
        appendBlockContinuation(pendingBibliographyContinuation.target, block)
        mergedContinuationBlocks.add(block)
        lastBibliographyEntryPage = block.region.page
        pendingBibliographyContinuation.tailPage = block.region.page
        activeList = undefined
        continue
      }
      pendingBibliographyContinuation = undefined
      if (entry) stripBlockMarker(block, entry)
      const continuedFromPreviousPage =
        lastBibliographyEntryPage !== undefined &&
        block.region.page > lastBibliographyEntryPage
      block.list = {
        level: 1,
        ordered: true,
        numberingId: 'references',
        markerStyle: 'decimal',
        ...(entry
          ? { ordinal: entry.ordinal, markerText: entry.markerText }
          : {}),
        ...(continuedFromPreviousPage
          ? { continuedFromPreviousPage: true }
          : block.bibliographyContinuedFromPreviousPage
            ? { continuedFromPreviousPage: true }
            : {}),
      }
      lastBibliographyEntryPage = block.region.page
      if (entry) {
        pendingBibliographyContinuation = {
          target: block,
          tailPage: block.region.page,
        }
      }
      activeList = undefined
      lastListBlock = entry ? block : undefined
      continue
    }
    lastBibliographyEntryPage = undefined
    pendingBibliographyContinuation = undefined
    const ordered = parsedOrderedListMarker(block.text)
    const bullet = parsedBulletListMarker(block.text)
    const marker = ordered
    const itemText = ordered?.itemText ?? bullet?.itemText
    if (!itemText) {
      const targetTailSegment = lastListBlock
        ? blockSourceSegments(lastListBlock).at(-1)
        : undefined
      const targetTailRegion =
        targetTailSegment?.evidenceRegion ?? targetTailSegment?.region
      const samePageVerticalGap = targetTailRegion
        ? block.region.box.y -
          (targetTailRegion.box.y + targetTailRegion.box.height)
        : Number.POSITIVE_INFINITY
      const samePageIndentedContinuation = Boolean(
        activeList &&
        block.region.page === activeList.page &&
        block.region.column === activeList.column &&
        block.region.box.x > activeList.baseX + 0.012 &&
        samePageVerticalGap >= -0.004 &&
        samePageVerticalGap <= 0.03,
      )
      const crossPageContinuation = Boolean(
        activeList &&
        block.region.page > activeList.page &&
        block.region.box.x >= activeList.baseX - 0.012,
      )
      if (
        activeList &&
        lastListBlock &&
        (samePageIndentedContinuation || crossPageContinuation) &&
        likelyUnmarkedCrossPageContinuation(lastListBlock, block)
      ) {
        appendBlockContinuation(lastListBlock, block)
        mergedContinuationBlocks.add(block)
        activeList.page = block.region.page
        activeList.column = block.region.column
        continue
      }
      activeList = undefined
      lastListBlock = undefined
      continue
    }
    const continuesAcrossPage = Boolean(
      activeList &&
      activeList.page !== block.region.page &&
      activeList.ordered &&
      marker &&
      activeList.markerStyle === marker.markerStyle &&
      activeList.lastOrdinal !== undefined &&
      marker.ordinal > activeList.lastOrdinal,
    )
    const isNestedItem = Boolean(
      activeList &&
      activeList.page === block.region.page &&
      activeList.column === block.region.column &&
      block.region.box.x > activeList.baseX + 0.012,
    )
    const continuesCurrentList = Boolean(
      activeList &&
      (isNestedItem ||
        ((activeList.page === block.region.page || continuesAcrossPage) &&
          (activeList.page !== block.region.page ||
            activeList.column === block.region.column) &&
          activeList.ordered === Boolean(ordered) &&
          activeList.markerStyle === (marker?.markerStyle ?? 'disc') &&
          (!marker ||
            activeList.lastOrdinal === undefined ||
            marker.ordinal > activeList.lastOrdinal))),
    )
    if (!continuesCurrentList) {
      const sequence = (listCounts.get(block.region.page) ?? 0) + 1
      listCounts.set(block.region.page, sequence)
      activeList = {
        page: block.region.page,
        column: block.region.column,
        baseX: block.region.box.x,
        numberingId: `pdf-list-p${String(block.region.page).padStart(3, '0')}-${String(sequence).padStart(3, '0')}`,
        ordered: Boolean(ordered),
        markerStyle: marker?.markerStyle ?? 'disc',
        lastOrdinal: marker?.ordinal,
      }
    } else if (activeList && !isNestedItem) {
      activeList.page = block.region.page
      activeList.column = block.region.column
      activeList.lastOrdinal = marker?.ordinal
    }
    const list = activeList
    if (!list) continue
    const indentation = Math.max(0, block.region.box.x - list.baseX)
    stripBlockMarker(block, ordered ?? bullet!)
    block.list = {
      level: Math.min(9, Math.max(1, Math.round(indentation / 0.025) + 1)),
      ordered: Boolean(ordered),
      numberingId: list.numberingId,
      markerStyle: marker?.markerStyle ?? 'disc',
      ...(marker ? { ordinal: marker.ordinal } : {}),
      ...(ordered
        ? { markerText: ordered.markerText }
        : bullet
          ? { markerText: bullet.markerText }
          : {}),
      ...(continuesAcrossPage ? { continuedFromPreviousPage: true } : {}),
    }
    lastListBlock = block
  }
  return blocks.filter((block) => !mergedContinuationBlocks.has(block))
}

function noteNodeIds(blocks: RegionBlock[]) {
  const occurrences = new Map<string, number>()
  for (const block of blocks.filter(
    (candidate) => candidate.type === 'footnote',
  )) {
    const base = `${block.noteKind === 'endnote' ? 'en' : 'fn'}-p${String(block.region.page).padStart(3, '0')}-${slug(block.noteLabel ?? 'note', 16)}`
    const occurrence = (occurrences.get(base) ?? 0) + 1
    occurrences.set(base, occurrence)
    block.nodeId = occurrence === 1 ? base : `${base}-${occurrence}`
  }
}

function detectReferences(
  classifications: PdfNoteMarkerClassification[],
  regionMap: ReadonlyMap<string, PdfPageRegion>,
) {
  return classifications.flatMap<NoteReferenceDraft>((classification) => {
    if (classification.disposition !== 'note-reference') return []
    const region = regionMap.get(classification.referenceRegionId)
    if (!region) return []
    return [
      {
        id: classification.id,
        label: classification.label,
        region,
        start: classification.start,
        end: classification.end,
        classification,
      },
    ]
  })
}

function exactAuthorSpans(block: RegionBlock) {
  return authorNamesFromLine(block.text).flatMap((author) => {
    const occurrences: Array<{ author: string; start: number; end: number }> =
      []
    let cursor = 0
    while (cursor < block.text.length) {
      const start = block.text.indexOf(author, cursor)
      if (start < 0) break
      const end = start + author.length
      const before = block.text.slice(Math.max(0, start - 1), start)
      const after = block.text.slice(end, end + 1)
      if (!/\p{L}/u.test(before) && !/\p{L}/u.test(after)) {
        occurrences.push({ author, start, end })
      }
      cursor = Math.max(end, start + 1)
    }
    return occurrences.length === 1 ? occurrences : []
  })
}

function detectAuthorNoteReferences(
  blocks: RegionBlock[],
  classifications: PdfNoteMarkerClassification[],
): AuthorNoteReferenceDraft[] {
  const classificationsByRegion = new Map<
    string,
    PdfNoteMarkerClassification[]
  >()
  for (const classification of classifications) {
    if (
      !classification.accepted ||
      classification.disposition !== 'note-reference'
    ) {
      continue
    }
    const values =
      classificationsByRegion.get(classification.referenceRegionId) ?? []
    values.push(classification)
    classificationsByRegion.set(classification.referenceRegionId, values)
  }
  return blocks.flatMap((block) => {
    if (block.frontMatterRole !== 'author') return []
    const authorSpans = exactAuthorSpans(block).sort(
      (left, right) => left.start - right.start || left.end - right.end,
    )
    return (classificationsByRegion.get(block.region.id) ?? []).flatMap(
      (classification) => {
        const sourceMarker = block.text.slice(
          classification.start,
          classification.end,
        )
        if (
          classification.start < 0 ||
          classification.end > block.text.length ||
          normalizedNoteLabel(sourceMarker) !==
            normalizedNoteLabel(classification.label)
        ) {
          return []
        }
        const preceding = authorSpans.filter(
          (span) => span.end <= classification.start,
        )
        const owner = preceding.at(-1)
        if (!owner) return []
        const markerPrefix = block.text.slice(owner.end, classification.start)
        if (!/^[\s\d⁰¹²³⁴⁵⁶⁷⁸⁹*†‡§]*$/u.test(markerPrefix)) return []
        const nextAuthor = authorSpans.find((span) => span.start > owner.start)
        if (nextAuthor && classification.start >= nextAuthor.start) return []
        return [
          {
            id: classification.id,
            label: classification.label,
            author: owner.author,
            region: block.region,
            start: classification.start,
            end: classification.end,
            classification,
          },
        ]
      },
    )
  })
}

function semanticRoleForClassification(
  classification: PdfNoteMarkerClassification,
): SemanticReferenceDraft['semanticRole'] | undefined {
  if (classification.disposition === 'citation') return 'citation'
  if (
    classification.taxonomy === 'equation-reference' ||
    classification.taxonomy === 'section-reference'
  ) {
    return 'cross-reference'
  }
  if (classification.taxonomy === 'author-affiliation-superscript') {
    return 'affiliation-marker'
  }
  if (classification.taxonomy === 'bibliography-entry') {
    return 'bibliography-entry'
  }
  return undefined
}

function normalizedAuthorYearCitationKey(surname: string, year: string) {
  const normalizedSurname = surname
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/’/gu, "'")
    .toLowerCase()
  return `${normalizedSurname}:${year.toLowerCase()}`
}

function bibliographyAuthorYearKey(text: string) {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  const surname = normalized.match(
    /^(\p{Lu}[\p{L}\p{M}'’.-]*)(?=\s*,|\s+et\s+al\.)/u,
  )?.[1]
  if (!surname) return null
  const years = [
    ...new Set(
      [...normalized.matchAll(/\b((?:18|19|20)\d{2}[a-z]?)\b/gu)].map((match) =>
        match[1].toLowerCase(),
      ),
    ),
  ]
  return years.length === 1
    ? normalizedAuthorYearCitationKey(surname, years[0])
    : null
}

function buildCitationRelationships(
  classifications: PdfNoteMarkerClassification[],
  blocks: RegionBlock[],
) {
  const blocksBySourceRegion = new Map<string, RegionBlock[]>()
  for (const block of blocks) {
    for (const regionId of new Set(
      blockSourceSegments(block).map((segment) => segment.region.id),
    )) {
      const owners = blocksBySourceRegion.get(regionId) ?? []
      owners.push(block)
      blocksBySourceRegion.set(regionId, owners)
    }
  }
  const bibliographyTargets = new Map<string, string>()
  for (const classification of classifications.filter(
    (candidate) => candidate.taxonomy === 'bibliography-entry',
  )) {
    const owners =
      blocksBySourceRegion.get(classification.referenceRegionId) ?? []
    const bibliographyOrdinal = /^\d+$/.test(classification.label)
      ? Number(classification.label)
      : null
    const markerOwners = owners.filter(
      (block) =>
        block.list?.numberingId === 'references' &&
        ((bibliographyOrdinal !== null &&
          block.list.ordinal === bibliographyOrdinal) ||
          normalizedNoteLabel(block.list.markerText ?? '') ===
            normalizedNoteLabel(classification.label)),
    )
    const target = (
      markerOwners.length === 1
        ? markerOwners[0]
        : owners.length === 1
          ? owners[0]
          : undefined
    )?.nodeId
    if (!target) continue
    for (const label of classification.label.split(',')) {
      if (!bibliographyTargets.has(label))
        bibliographyTargets.set(label, target)
    }
  }
  const authorYearTargets = new Map<string, string[]>()
  for (const block of blocks) {
    if (block.list?.numberingId !== 'references' || !block.nodeId) continue
    const key = bibliographyAuthorYearKey(block.text)
    if (!key) continue
    const targets = authorYearTargets.get(key) ?? []
    if (!targets.includes(block.nodeId)) targets.push(block.nodeId)
    authorYearTargets.set(key, targets)
  }

  return classifications.flatMap<PdfCitationRelationship>((classification) => {
    if (!classification.accepted || classification.disposition !== 'citation')
      return []
    const labels = classification.label.split(',').filter(Boolean)
    if (classification.taxonomy === 'author-year-bibliography-citation') {
      const candidates = labels.map(
        (label) => authorYearTargets.get(label) ?? [],
      )
      const missing = candidates.some((targets) => targets.length === 0)
      const ambiguous = candidates.some((targets) => targets.length > 1)
      const status = !missing && !ambiguous ? 'matched' : 'unresolved'
      const targetNodeIds =
        status === 'matched'
          ? [...new Set(candidates.map((targets) => targets[0]))]
          : []
      return [
        {
          id: classification.id,
          label: classification.label,
          labels,
          referenceRegionId: classification.referenceRegionId,
          referenceStart: classification.start,
          referenceEnd: classification.end,
          taxonomy: classification.taxonomy,
          targetNodeIds,
          status,
          canonicalAnchor: null,
          confidence: classification.confidence,
          evidence: [
            ...classification.evidence,
            ...(ambiguous
              ? ['bibliography-author-year-target-ambiguous']
              : missing
                ? ['bibliography-author-year-target-missing']
                : ['bibliography-author-year-key-unique']),
          ],
          sourceBoxes: [{ ...classification.sourceBox }],
        },
      ]
    }
    const targetNodeIds = labels.flatMap((label) => {
      const target = bibliographyTargets.get(label)
      return target ? [target] : []
    })
    const status =
      targetNodeIds.length === labels.length ? 'matched' : 'unresolved'
    return [
      {
        id: classification.id,
        label: classification.label,
        labels,
        referenceRegionId: classification.referenceRegionId,
        referenceStart: classification.start,
        referenceEnd: classification.end,
        taxonomy:
          classification.taxonomy as PdfCitationRelationship['taxonomy'],
        targetNodeIds: [...new Set(targetNodeIds)],
        status,
        canonicalAnchor: null,
        confidence: classification.confidence,
        evidence: [
          ...classification.evidence,
          ...(status === 'matched'
            ? ['bibliography-label-target']
            : ['bibliography-label-target-missing']),
        ],
        sourceBoxes: [{ ...classification.sourceBox }],
      },
    ]
  })
}

function scoreNoteCandidate(reference: NoteReferenceDraft, note: RegionBlock) {
  let score = 0.55
  const evidence = ['label-exact']
  if (reference.region.page === note.region.page) {
    score += 0.25
    evidence.push('same-page-scope')
    if (reference.region.column === note.region.column) {
      score += 0.1
      evidence.push('same-column-geometry')
    } else if (note.region.column === 'span') {
      score += 0.06
      evidence.push('page-wide-note-region')
    }
    if (note.region.box.y >= reference.region.box.y) {
      score += 0.05
      evidence.push('note-follows-reference')
    }
  } else if (
    note.noteKind === 'endnote' &&
    note.region.page >= reference.region.page
  ) {
    const distance = note.region.page - reference.region.page
    score += Math.max(0.12, 0.2 - distance * 0.025)
    evidence.push('later-endnote-section-scope')
  }
  return { score: rounded(Math.min(score, 1)), evidence }
}

function matchNotes(
  blocks: RegionBlock[],
  references: NoteReferenceDraft[],
  diagnostics: ReconstructionDiagnostic[],
) {
  const notes = blocks.filter((block) => block.type === 'footnote')
  const relationships: PdfNoteRelationship[] = references.map((reference) => {
    const candidates = notes
      .filter(
        (note) =>
          normalizedNoteLabel(note.noteLabel ?? '') ===
          normalizedNoteLabel(reference.label),
      )
      .map((note) => {
        const scored = scoreNoteCandidate(reference, note)
        return {
          targetNoteId: note.nodeId!,
          targetRegionId: note.region.id,
          score: scored.score,
          evidence: scored.evidence,
          sourceBoxes: [reference.region.box, note.region.box],
        }
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.targetNoteId.localeCompare(right.targetNoteId),
      )
    const best = candidates[0]
    const ambiguous =
      Boolean(best) &&
      Boolean(candidates[1]) &&
      best.score - candidates[1].score < 0.04
    const matched =
      Boolean(best) &&
      best.score >= PDF_NOTE_RELATIONSHIP_THRESHOLD &&
      !ambiguous
    if (ambiguous) {
      diagnostics.push({
        code: 'AMBIGUOUS_NOTE_MATCH',
        severity: 'error',
        page: reference.region.page,
        message: `Note reference ${reference.id} retains ${candidates.length} similarly scored targets for review.`,
        relationshipId: reference.id,
        sourceBoxes: [
          reference.region.box,
          ...candidates.map((candidate) => candidate.sourceBoxes[1]),
        ],
        target: {
          regionIds: [
            reference.region.id,
            ...candidates.map((candidate) => candidate.targetRegionId),
          ],
          markerId: reference.id,
        },
      })
    } else if (!matched) {
      diagnostics.push({
        code: 'UNRESOLVED_NOTE_REFERENCE',
        severity: 'error',
        page: reference.region.page,
        message: `Note reference ${reference.id} has no deterministic target at or above the ${PDF_NOTE_RELATIONSHIP_THRESHOLD.toFixed(2)} confidence threshold.`,
        relationshipId: reference.id,
        sourceBoxes: [
          reference.region.box,
          ...candidates.map((candidate) => candidate.sourceBoxes[1]),
        ],
        target: {
          regionIds: [reference.region.id],
          markerId: reference.id,
        },
      })
    }
    return {
      id: reference.id,
      label: reference.label,
      referenceRegionId: reference.region.id,
      referenceStart: reference.start,
      referenceEnd: reference.end,
      targetNoteId: matched ? best.targetNoteId : null,
      status: ambiguous ? 'ambiguous' : matched ? 'matched' : 'unresolved',
      confidence: best?.score ?? 0,
      threshold: PDF_NOTE_RELATIONSHIP_THRESHOLD,
      evidence: best?.evidence ?? ['no-label-match'],
      candidates,
      sourceBoxes: matched ? best.sourceBoxes : [reference.region.box],
    }
  })

  const referencedNotes = new Set(
    relationships.flatMap((relationship) =>
      relationship.status === 'matched'
        ? [relationship.targetNoteId]
        : relationship.status === 'ambiguous'
          ? relationship.candidates.map((candidate) => candidate.targetNoteId)
          : [],
    ),
  )
  for (const note of notes) {
    if (referencedNotes.has(note.nodeId!)) continue
    diagnostics.push({
      code: 'UNREFERENCED_NOTE',
      severity: 'error',
      page: note.region.page,
      message: `Note ${note.nodeId} remains explicit because no unique reference resolved to it.`,
      sourceBoxes: [note.region.box],
      target: {
        regionIds: [note.region.id],
        markerId: note.nodeId ?? null,
      },
    })
  }
  return relationships
}

function boxesOverlap(
  left: {
    page?: number
    x: number
    y: number
    width: number
    height: number
  },
  right: {
    page?: number
    x: number
    y: number
    width: number
    height: number
  },
) {
  return (
    (left.page === undefined ||
      right.page === undefined ||
      left.page === right.page) &&
    Math.min(left.x + left.width, right.x + right.width) >
      Math.max(left.x, right.x) &&
    Math.min(left.y + left.height, right.y + right.height) >
      Math.max(left.y, right.y)
  )
}

const CAPTION_ENVELOPE_TOLERANCE = 0.00002

function validNormalizedSourceBox(box: NormalizedSourceBox) {
  return (
    Number.isInteger(box.page) &&
    box.page > 0 &&
    [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width <= 1 + CAPTION_ENVELOPE_TOLERANCE &&
    box.y + box.height <= 1 + CAPTION_ENVELOPE_TOLERANCE
  )
}

function boxGap(left: NormalizedSourceBox, right: NormalizedSourceBox) {
  return {
    horizontal: Math.max(
      left.x - (right.x + right.width),
      right.x - (left.x + left.width),
      0,
    ),
    vertical: Math.max(
      left.y - (right.y + right.height),
      right.y - (left.y + left.height),
      0,
    ),
  }
}

function connectedCaptionBoxes(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  const gap = boxGap(left, right)
  const verticalOverlap =
    Math.min(left.y + left.height, right.y + right.height) -
    Math.max(left.y, right.y)
  const horizontalOverlap =
    Math.min(left.x + left.width, right.x + right.width) -
    Math.max(left.x, right.x)
  return (
    (verticalOverlap > 0 &&
      gap.horizontal <= Math.max(0.04, left.height * 2, right.height * 2)) ||
    (horizontalOverlap > 0 &&
      gap.vertical <= Math.max(0.03, left.height * 1.5, right.height * 1.5))
  )
}

function oneConnectedCaptionComponent(boxes: NormalizedSourceBox[]) {
  const reached = new Set<number>([0])
  let changed = true
  while (changed) {
    changed = false
    for (let index = 0; index < boxes.length; index += 1) {
      if (reached.has(index)) continue
      if (
        [...reached].some((candidate) =>
          connectedCaptionBoxes(boxes[candidate], boxes[index]),
        )
      ) {
        reached.add(index)
        changed = true
      }
    }
  }
  return reached.size === boxes.length
}

function sameSourceBox(left: NormalizedSourceBox, right: NormalizedSourceBox) {
  return (
    left.page === right.page &&
    left.rotation === right.rotation &&
    left.method === right.method &&
    (['x', 'y', 'width', 'height'] as const).every(
      (key) => rounded(left[key]) === rounded(right[key]),
    )
  )
}

function visualLineageBoxes(
  relationship: PdfVisualRelationship,
  assetsById: ReadonlyMap<string, PdfVisualAsset>,
) {
  if (
    relationship.assetIds.length === 0 ||
    new Set(relationship.assetIds).size !== relationship.assetIds.length
  ) {
    return null
  }
  const assets = relationship.assetIds.map((assetId) => assetsById.get(assetId))
  if (assets.some((asset) => asset === undefined)) return null
  const matchedAssets = assets.filter(
    (asset): asset is PdfVisualAsset => asset !== undefined,
  )
  const sourceObjectIds = matchedAssets.flatMap(
    (asset) => asset.sourceObjectIds,
  )
  const sourceBoxes = matchedAssets.flatMap((asset) => asset.sourceBoxes)
  if (
    sourceBoxes.length === 0 ||
    sourceBoxes.some((box) => !validNormalizedSourceBox(box)) ||
    sourceObjectIds.length !== relationship.sourceObjectIds.length ||
    sourceObjectIds.some(
      (sourceObjectId, index) =>
        sourceObjectId !== relationship.sourceObjectIds[index],
    )
  ) {
    return null
  }
  return sourceBoxes.map((box) => ({ ...box }))
}

export function captionProvenanceEnvelope(
  evidence: NodeSourceEvidence | undefined,
  captionRegionId: string,
  placeholder: NormalizedSourceBox,
  options: { allowExactRegionOverflow?: boolean } = {},
) {
  const boxes = evidence?.boxes ?? []
  const first = boxes[0]
  if (
    !evidence ||
    evidence.regionIds.length !== 1 ||
    evidence.regionIds[0] !== captionRegionId ||
    evidence.pages.length !== 1 ||
    !validNormalizedSourceBox(placeholder) ||
    !first ||
    boxes.some(
      (box) =>
        !validNormalizedSourceBox(box) ||
        box.page !== first.page ||
        box.rotation !== first.rotation ||
        box.method !== first.method ||
        box.page !== placeholder.page ||
        box.rotation !== placeholder.rotation ||
        box.method !== placeholder.method ||
        (!options.allowExactRegionOverflow &&
          (box.x < placeholder.x - CAPTION_ENVELOPE_TOLERANCE ||
            box.y < placeholder.y - CAPTION_ENVELOPE_TOLERANCE ||
            box.x + box.width >
              placeholder.x + placeholder.width + CAPTION_ENVELOPE_TOLERANCE ||
            box.y + box.height >
              placeholder.y + placeholder.height + CAPTION_ENVELOPE_TOLERANCE)),
    ) ||
    evidence.pages[0] !== first.page ||
    !oneConnectedCaptionComponent(boxes)
  ) {
    return null
  }
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  const envelope: NormalizedSourceBox = {
    page: first.page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation: first.rotation,
    method: first.method,
  }
  return validNormalizedSourceBox(envelope) ? envelope : null
}

function safeHyperlink(value: string) {
  // WHATWG URL parsing repairs backslashes and ASCII whitespace in special
  // URLs. Keeping the original repaired-looking annotation would still emit
  // an invalid EPUB IRI, and rewriting it could silently change its target.
  if (/[\u0000-\u0020\u007f\\]/u.test(value)) return false
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

const ACADEMIC_MATH_ITALIC_FONT_NAME =
  /(?:^|[+,._\s-])(?:(?:cm|lm)mi(?:b)?\d+|mtmi\d*|math(?:italic|ital))(?=$|[+,._\s-])/iu
const EXPLICIT_ITALIC_STYLE_FONT_NAME =
  /(?:^|[+,._\s-])(?:(?:(?:regular|regu|roman|book|medium|med|bold|demi|semi(?:bold)?)?(?:italic|ital|oblique|obl)|it)(?:mt)?)(?=$|[+,._\s-])/iu

function fontNameIndicatesItalic(fontName: string) {
  return (
    ACADEMIC_MATH_ITALIC_FONT_NAME.test(fontName) ||
    EXPLICIT_ITALIC_STYLE_FONT_NAME.test(fontName)
  )
}

function unmatchedClosingDelimiter(value: string, open: string, close: string) {
  return value.split(close).length > value.split(open).length
}

function literalAbsoluteHyperlinks(value: string) {
  const links: Array<{ start: number; end: number; url: string }> = []
  for (const match of value.matchAll(/(?:https?:\/\/|mailto:)[^\s<>"']+/giu)) {
    if (match.index === undefined) continue
    let url = match[0].replace(/[.,;:!?]+$/u, '')
    for (const [open, close] of [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ]) {
      while (
        url.endsWith(close) &&
        unmatchedClosingDelimiter(url, open, close)
      ) {
        url = url.slice(0, -1)
      }
    }
    if (!url || !safeHyperlink(url)) continue
    links.push({ start: match.index, end: match.index + url.length, url })
  }
  return links
}

function runVerticalAlign(
  line: PdfPageRegion['lines'][number],
  run: PdfPageRegion['lines'][number]['runs'][number],
) {
  const maximumFontSize = Math.max(
    ...line.runs.map((candidate) => candidate.fontSize),
  )
  if (run.fontSize >= maximumFontSize * 0.82) return undefined
  const baselineRuns = line.runs.filter(
    (candidate) => candidate.fontSize >= maximumFontSize * 0.9,
  )
  const baselineCenter = median(
    baselineRuns.map((candidate) => candidate.y + candidate.height / 2),
  )
  const runCenter = run.y + run.height / 2
  const threshold = Math.max(
    0.0015,
    median(baselineRuns.map((candidate) => candidate.height)) * 0.12,
  )
  if (runCenter < baselineCenter - threshold) return 'superscript' as const
  if (runCenter > baselineCenter + threshold) return 'subscript' as const
  return undefined
}

type InlineMappingLedger = { expected: number; mapped: number }

function canonicalRangeForSource(
  block: RegionBlock,
  regionId: string,
  start: number,
  end: number,
) {
  for (const segment of blockSourceSegments(block)) {
    if (segment.region.id !== regionId) continue
    const sourceEnd = segment.sourceStart + segment.text.length
    const overlapStart = Math.max(start, segment.sourceStart)
    const overlapEnd = Math.min(end, sourceEnd)
    if (overlapStart >= overlapEnd) continue
    return {
      start: segment.canonicalStart + overlapStart - segment.sourceStart,
      end: segment.canonicalStart + overlapEnd - segment.sourceStart,
    }
  }
  return null
}

function exactCanonicalRangeForSource(
  block: RegionBlock,
  regionId: string,
  start: number,
  end: number,
) {
  if (start < 0 || start >= end) return null
  const containsExactRange = blockSourceSegments(block).some(
    (segment) =>
      segment.region.id === regionId &&
      segment.sourceStart <= start &&
      segment.sourceStart + segment.text.length >= end,
  )
  if (!containsExactRange) return null
  const range = canonicalRangeForSource(block, regionId, start, end)
  return range && range.end - range.start === end - start ? range : null
}

type CanonicalVisualTextSegment = {
  regionId: string
  lineId: string
  sourceStart: number
  sourceEnd: number
  canonicalStart: number
  text: string
  box: NormalizedSourceBox
}

type CanonicalVisualTextOwner = {
  nodeId: string
  relationshipId: string
  text: string
  segments: CanonicalVisualTextSegment[]
}

function canonicalVisualTextOwner(
  relationship: PdfVisualRelationship,
  nodeId: string,
  regions: PdfPageRegion[],
  lineBoundaryDecisions: readonly PdfLineBoundaryDecision[],
): CanonicalVisualTextOwner | null {
  if (
    relationship.kind !== 'table' ||
    relationship.status !== 'matched' ||
    !relationship.sourceText ||
    !relationship.sourceLineIds?.length ||
    new Set(relationship.sourceLineIds).size !==
      relationship.sourceLineIds.length
  ) {
    return null
  }
  const selectedRegionIds = new Set(relationship.sourceRegionIds)
  const lineOwners = new Map<
    string,
    Array<{ region: PdfPageRegion; line: PdfPageRegion['lines'][number] }>
  >()
  for (const region of regions.filter((candidate) =>
    selectedRegionIds.has(candidate.id),
  )) {
    for (const line of region.lines) {
      const owners = lineOwners.get(line.id) ?? []
      owners.push({ region, line })
      lineOwners.set(line.id, owners)
    }
  }
  const sourceRangesByRegion = new Map<
    string,
    ReturnType<typeof replayPdfRegionLineRanges>
  >()
  const segments: CanonicalVisualTextSegment[] = []
  let canonicalStart = 0
  for (const lineId of relationship.sourceLineIds) {
    const owners = lineOwners.get(lineId) ?? []
    if (owners.length !== 1) return null
    const { region, line } = owners[0]
    let ranges = sourceRangesByRegion.get(region.id)
    if (ranges === undefined) {
      ranges = replayPdfRegionLineRanges(region, lineBoundaryDecisions)
      sourceRangesByRegion.set(region.id, ranges)
    }
    if (ranges?.text !== region.text) return null
    const range = ranges.ranges.get(line.id)
    if (!range) return null
    segments.push({
      regionId: region.id,
      lineId,
      sourceStart: range.start,
      sourceEnd: range.end,
      canonicalStart,
      text: line.text,
      box: { ...line.box },
    })
    canonicalStart += line.text.length + 1
  }
  if (
    segments.map((segment) => segment.text).join(' ') !==
    relationship.sourceText
  ) {
    return null
  }
  return {
    nodeId,
    relationshipId: relationship.id,
    text: relationship.sourceText,
    segments,
  }
}

function exactVisualCanonicalRangeForSource(
  owner: CanonicalVisualTextOwner,
  relationship: PdfCitationRelationship,
  regionsById: ReadonlyMap<string, PdfPageRegion>,
) {
  if (
    relationship.referenceStart < 0 ||
    relationship.referenceStart >= relationship.referenceEnd
  ) {
    return null
  }
  const region = regionsById.get(relationship.referenceRegionId)
  if (!region) return null
  const markerText = region.text.slice(
    relationship.referenceStart,
    relationship.referenceEnd,
  )
  if (!markerText) return null
  const segments = owner.segments.filter(
    (segment) =>
      segment.regionId === relationship.referenceRegionId &&
      segment.sourceStart <= relationship.referenceStart &&
      segment.sourceEnd >= relationship.referenceEnd &&
      relationship.sourceBoxes.some((box) => boxesOverlap(box, segment.box)),
  )
  if (segments.length !== 1) return null
  const segment = segments[0]
  const start =
    segment.canonicalStart + relationship.referenceStart - segment.sourceStart
  const end = start + markerText.length
  return owner.text.slice(start, end) === markerText
    ? { nodeId: owner.nodeId, start, end }
    : null
}

function sourceInlineRuns(
  block: RegionBlock,
  links: PdfEmbeddedLink[],
  noteReferences: Array<{
    id: string
    start: number
    end: number
    regionId: string
  }>,
  semanticReferences: Array<SemanticReferenceDraft & { regionId: string }> = [],
) {
  const mapped = new Map<string, CanonicalInlineRun>()
  const ledger: InlineMappingLedger = { expected: 0, mapped: 0 }
  const store = (run: CanonicalInlineRun) => {
    const key = `${run.start}:${run.end}`
    mapped.set(key, { ...mapped.get(key), ...run })
  }
  for (const segment of blockSourceSegments(block)) {
    let cursor = 0
    for (const line of segment.region.lines) {
      for (const run of line.runs) {
        const sourceText = run.text
          .replace(/\u00ad/g, '')
          .replace(/\s+/g, ' ')
          .trim()
        if (!sourceText) continue
        const bold =
          run.bold ?? /(?:bold|black|demi|semibold)/i.test(run.fontName)
        const italic = run.italic ?? fontNameIndicatesItalic(run.fontName)
        const verticalAlign = runVerticalAlign(line, run)
        const overlappingLinks = links.filter((candidate) =>
          boxesOverlap(candidate.box, run),
        )
        const annotationLink = overlappingLinks.find((candidate) =>
          safeHyperlink(candidate.url),
        )
        const rawLiteralLinks =
          overlappingLinks.length === 0
            ? literalAbsoluteHyperlinks(sourceText)
            : []
        const expectedStyleCount =
          Number(bold) + Number(italic) + Number(Boolean(verticalAlign))
        let sourceStart = segment.region.text.indexOf(sourceText, cursor)
        let mappedText = sourceText
        if (sourceStart < 0 && /[-‐‑]$/u.test(sourceText)) {
          mappedText = sourceText.slice(0, -1)
          sourceStart = segment.region.text.indexOf(mappedText, cursor)
        }
        if (sourceStart < 0) {
          ledger.expected +=
            expectedStyleCount + (annotationLink ? 1 : rawLiteralLinks.length)
          continue
        }
        const sourceEnd = sourceStart + mappedText.length
        cursor = sourceEnd
        const canonicalRange = canonicalRangeForSource(
          block,
          segment.region.id,
          sourceStart,
          sourceEnd,
        )
        if (!canonicalRange) continue
        const intersectionStart =
          segment.sourceStart + canonicalRange.start - segment.canonicalStart
        const canonicalText = segment.region.text.slice(
          intersectionStart,
          intersectionStart + canonicalRange.end - canonicalRange.start,
        )
        const hyperlinkSpans = (
          annotationLink
            ? [{ start: sourceStart, end: sourceEnd, url: annotationLink.url }]
            : rawLiteralLinks.map((link) => ({
                start: sourceStart + link.start,
                end: sourceStart + link.end,
                url: link.url,
              }))
        ).flatMap((link) => {
          const start = Math.max(link.start, intersectionStart)
          const end = Math.min(
            link.end,
            intersectionStart + canonicalText.length,
          )
          return start < end
            ? [
                {
                  start: start - intersectionStart,
                  end: end - intersectionStart,
                  url: link.url,
                },
              ]
            : []
        })
        ledger.expected += expectedStyleCount + hyperlinkSpans.length
        if (bold || italic || hyperlinkSpans.length > 0 || verticalAlign) {
          const boundaries = [
            0,
            canonicalText.length,
            ...hyperlinkSpans.flatMap((link) => [link.start, link.end]),
          ]
          const points = [...new Set(boundaries)].sort(
            (left, right) => left - right,
          )
          for (let index = 0; index < points.length - 1; index += 1) {
            const segmentStart = points[index]
            const segmentEnd = points[index + 1]
            if (segmentStart === segmentEnd) continue
            const hyperlink = hyperlinkSpans.find(
              (candidate) =>
                candidate.start <= segmentStart && candidate.end >= segmentEnd,
            )
            store({
              start: canonicalRange.start + segmentStart,
              end: canonicalRange.start + segmentEnd,
              ...(bold ? { bold: true } : {}),
              ...(italic ? { italic: true } : {}),
              ...(hyperlink ? { href: hyperlink.url } : {}),
              ...(verticalAlign ? { verticalAlign } : {}),
            })
          }
          ledger.mapped += expectedStyleCount + hyperlinkSpans.length
        }
      }
    }
  }
  for (const reference of noteReferences) {
    const range = canonicalRangeForSource(
      block,
      reference.regionId,
      reference.start,
      reference.end,
    )
    if (!range) continue
    store({ ...range, relationshipId: reference.id })
  }
  for (const reference of semanticReferences) {
    const range = canonicalRangeForSource(
      block,
      reference.regionId,
      reference.start,
      reference.end,
    )
    if (!range) continue
    store({
      ...range,
      relationshipId: reference.id,
      semanticRole: reference.semanticRole,
      ...(reference.targetIds ? { targetIds: reference.targetIds } : {}),
    })
  }
  return {
    runs: [...mapped.values()].sort(
      (left, right) => left.start - right.start || left.end - right.end,
    ),
    ledger,
  }
}

function sourceEvidence(
  block: RegionBlock,
  links: PdfEmbeddedLink[],
): NodeSourceEvidence {
  const sourceRegions = blockSourceSegments(block).map(
    (segment) => segment.evidenceRegion ?? segment.region,
  )
  return {
    confidence: rounded(block.confidence),
    pages: [...new Set(sourceRegions.map((region) => region.page))],
    regionIds: [...new Set(sourceRegions.map((region) => region.id))],
    boxes: sourceRegions.flatMap((region) =>
      region.lines.flatMap((line) =>
        line.runs.map((run) => ({
          ...run,
          x: rounded(run.x),
          y: rounded(run.y),
          width: rounded(run.width),
          height: rounded(run.height),
          fontSize: rounded(run.fontSize),
          confidence: rounded(run.confidence),
        })),
      ),
    ),
    links: links.filter((link) =>
      sourceRegions.some(
        (region) =>
          link.box.page === region.page && boxesOverlap(link.box, region.box),
      ),
    ),
  }
}

type CanonicalVisualDraft = {
  captionBlock: RegionBlock & { nodeId: string }
  captionEnvelope: NormalizedSourceBox
  lineageBoxes: NormalizedSourceBox[]
  page: number
  id: string
  source: string
}

function orderCanonicalVisualPairs(
  nodes: ResearchNode[],
  pairs: readonly {
    page: number
    visualNodeId: string
    captionNodeId: string
  }[],
) {
  const pairsByPage = new Map<number, typeof pairs>()
  for (const pair of pairs) {
    const pagePairs = pairsByPage.get(pair.page) ?? []
    pairsByPage.set(pair.page, [...pagePairs, pair])
  }

  for (const pagePairs of pairsByPage.values()) {
    const orderedIds = pagePairs.flatMap(({ visualNodeId, captionNodeId }) => [
      visualNodeId,
      captionNodeId,
    ])
    const uniqueIds = new Set(orderedIds)
    if (uniqueIds.size !== orderedIds.length) continue

    const nodesById = new Map(
      nodes
        .filter((node) => uniqueIds.has(node.id))
        .map((node) => [node.id, node]),
    )
    const slots = nodes.flatMap((node, index) =>
      uniqueIds.has(node.id) ? [index] : [],
    )
    if (
      nodesById.size !== orderedIds.length ||
      slots.length !== orderedIds.length
    ) {
      continue
    }
    for (const [index, nodeId] of orderedIds.entries()) {
      nodes[slots[index]] = nodesById.get(nodeId)!
    }
  }
}

function canonicalVisualDraft(
  relationship: PdfVisualRelationship,
  blocks: RegionBlock[],
  assetsById: ReadonlyMap<string, PdfVisualAsset>,
  embeddedLinks: PdfEmbeddedLink[],
  sourceHash: string,
): CanonicalVisualDraft | null {
  const captionBlock = blocks.find(
    (block): block is RegionBlock & { nodeId: string } =>
      block.region.id === relationship.captionRegionId && Boolean(block.nodeId),
  )
  relationship.captionNodeId = captionBlock?.nodeId ?? null
  // Table and equation relationships carry their bounded content scope in
  // sourceBoxes. The caption is identified separately, so never infer it from
  // the first content box: doing so loses a valid caption-below table node.
  const captionPlaceholder = captionBlock?.region.box
  const lineageBoxes = visualLineageBoxes(relationship, assetsById)
  const verifiedCaptionEnvelope =
    captionBlock && captionPlaceholder
      ? captionProvenanceEnvelope(
          sourceEvidence(captionBlock, embeddedLinks),
          relationship.captionRegionId,
          captionPlaceholder,
          {
            allowExactRegionOverflow:
              relationship.kind === 'equation' &&
              relationship.altTextSource === 'source-text' &&
              relationship.sourceRegionIds.includes(
                relationship.captionRegionId,
              ),
          },
        )
      : null
  // A caption can contain source-backed runs whose PDF coordinates extend
  // beyond its classified region (for example, an adjacent export stamp). The
  // caption node is already canonical and source-identified; retain its
  // bounded region as the relationship anchor instead of discarding a fully
  // validated table crop and all of its table-cell provenance.
  const captionEnvelope =
    verifiedCaptionEnvelope ??
    (captionBlock && validNormalizedSourceBox(captionBlock.region.box)
      ? { ...captionBlock.region.box }
      : null)
  if (
    relationship.status !== 'matched' ||
    !captionBlock ||
    !captionPlaceholder ||
    !sameSourceBox(captionPlaceholder, captionBlock.region.box) ||
    !captionEnvelope ||
    !lineageBoxes
  ) {
    return null
  }
  const page = captionEnvelope.page
  const id = visualCanonicalNodeId(relationship, page)
  relationship.canonicalNodeId = id
  return {
    captionBlock,
    captionEnvelope,
    lineageBoxes,
    page,
    id,
    source: `pdf:${sourceHash.slice(0, 16)}#page=${page}`,
  }
}

export async function reconstructPageAnalyses({
  pages,
  sourceHash,
  fileName,
  byteLength,
  metadata = {},
  rasterizeFigure,
}: {
  pages: PdfPageAnalysis[]
  sourceHash: string
  fileName: string
  byteLength: number
  metadata?: PdfDocumentMetadata
  rasterizeFigure?: PdfFigureRasterizer
}): Promise<PdfReconstruction> {
  const diagnostics: ReconstructionDiagnostic[] = []
  for (const page of pages) {
    if (page.kind === 'ocr-required') {
      diagnostics.push({
        code: 'OCR_REQUIRED',
        severity: 'error',
        page: page.page,
        message: `Page ${page.page} has insufficient embedded text and requires local OCR.`,
        sourceBoxes: [
          {
            page: page.page,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            rotation: page.rotation,
            method: 'pdf-object',
          },
        ],
      })
    } else if (page.kind === 'mixed') {
      diagnostics.push({
        code: 'MIXED_PAGE',
        severity: 'warning',
        page: page.page,
        message: `Page ${page.page} mixes sparse text with image content; review the reconstruction.`,
        sourceBoxes: [
          ...page.runs,
          ...(page.objects ?? []).map((object) => object.box),
        ],
      })
    }
    if (page.ocr && page.ocr.confidence < 0.75) {
      diagnostics.push({
        code: 'LOW_CONFIDENCE_OCR',
        severity: 'error',
        page: page.page,
        message: `Page ${page.page} OCR confidence ${page.ocr.confidence.toFixed(3)} is below the review threshold 0.750.`,
      })
    }
    if (page.ocr?.words.some((word) => word.mergeStatus === 'conflict')) {
      diagnostics.push({
        code: 'MIXED_OCR_CONFLICT',
        severity: 'error',
        page: page.page,
        message: `Page ${page.page} retains conflicting embedded and OCR text at overlapping source boxes for review.`,
      })
    }
    if (page.spread?.status === 'uncertain') {
      diagnostics.push({
        code: 'UNCERTAIN_SPREAD_BOUNDARY',
        severity: 'error',
        page: page.page,
        message: `Page ${page.page} is likely a two-page scan, but its logical split boundary remains uncertain.`,
      })
    }
  }

  const regionResult = reconstructPageRegions(pages)
  for (const diagnostic of diagnostics.filter(
    (candidate) => candidate.code === 'MIXED_PAGE' && candidate.page,
  )) {
    diagnostic.target = {
      regionIds: regionResult.regions
        .filter((region) => region.page === diagnostic.page)
        .map((region) => region.id),
      markerId: null,
    }
  }
  const regionMap = new Map(
    regionResult.regions.map((region) => [region.id, region]),
  )
  const markerResult = classifyPdfNoteMarkers(
    regionResult.regions,
    regionResult.readingOrder.order,
  )
  const bibliographyRegionIds = new Set(markerResult.bibliographyRegionIds)
  const orderedRegions = regionResult.readingOrder.order
    .map((id) => regionMap.get(id))
    .filter((region): region is PdfPageRegion => Boolean(region))
  if (regionResult.repeatedMarginCount > 0) {
    diagnostics.push({
      code: 'REPEATED_MARGIN_TEXT',
      severity: 'info',
      message: `Removed ${regionResult.repeatedMarginCount} repeated header or footer pattern${regionResult.repeatedMarginCount === 1 ? '' : 's'} from reading order.`,
      target: {
        regionIds: regionResult.regions
          .filter(
            (region) => region.kind === 'header' || region.kind === 'footer',
          )
          .map((region) => region.id),
        markerId: null,
      },
    })
  }
  for (const resolution of regionResult.readingOrder.resolutions.filter(
    (candidate) => candidate.status === 'resolved',
  )) {
    const { regionIds, ...readingOrderResolution } = resolution
    for (const regionId of regionIds) {
      diagnostics.push({
        code: 'RESOLVED_READING_ORDER',
        severity: 'info',
        page: resolution.page,
        message: `Resolved ${regionId} as ${resolution.ambiguityClass} at confidence ${resolution.confidence.toFixed(2)} against threshold ${resolution.threshold.toFixed(2)} using ${resolution.evidence.map((item) => item.code).join(', ')}.`,
        readingOrderResolution: {
          ...readingOrderResolution,
          regionId,
        },
        target: { regionIds: [regionId], markerId: null },
      })
    }
  }
  for (const page of regionResult.ambiguousPages) {
    const resolution = regionResult.readingOrder.resolutions.find(
      (candidate) =>
        candidate.page === page && candidate.status === 'ambiguous',
    )
    const { regionIds: _regionIds, ...readingOrderResolution } = resolution ?? {
      policyVersion: '1.0.0' as const,
      page,
      ambiguityClass: 'sparse-column-gutter' as const,
      status: 'ambiguous' as const,
      confidence: 0.5,
      threshold: 0.85,
      evidence: [],
      regionIds: [],
    }
    diagnostics.push({
      code: 'AMBIGUOUS_READING_ORDER',
      severity: 'error',
      page,
      message: `Page ${page} retains both column-order candidates at confidence ${readingOrderResolution.confidence.toFixed(2)}, below threshold ${readingOrderResolution.threshold.toFixed(2)}.`,
      readingOrderResolution,
      sourceBoxes: regionResult.regions
        .filter(
          (region) => region.page === page && region.includedInReadingOrder,
        )
        .map((region) => region.box),
      target: {
        regionIds: resolution?.regionIds ?? [],
        markerId: null,
      },
    })
  }
  if (!regionResult.readingOrder.acyclic) {
    diagnostics.push({
      code: 'READING_ORDER_CYCLE',
      severity: 'error',
      message: 'The accepted reading-order edges contain a cycle.',
    })
  }

  for (const classification of markerResult.classifications) {
    diagnostics.push({
      code: 'CLASSIFIED_NOTE_MARKER',
      severity: 'info',
      page: classification.sourceBox.page,
      message: `Classified ${classification.id} as ${classification.taxonomy} at confidence ${classification.confidence.toFixed(2)} against threshold ${classification.threshold.toFixed(2)} using ${classification.evidence.join(', ')}.`,
      noteMarkerClassification: classification,
    })
  }

  const visualResult = await reconstructPdfVisuals({
    pages,
    regions: regionResult.regions,
    rasterizeFigure,
  })
  diagnostics.push(...visualResult.diagnostics)
  const blocks = blocksFromRegions(
    orderedRegions,
    regionResult.regions,
    visualResult.consumedRegionIds,
    bibliographyRegionIds,
    new Map(
      visualResult.relationships
        .filter(
          (relationship) =>
            relationship.kind === 'equation' &&
            relationship.status === 'matched' &&
            relationship.sourceRegionIds.includes(
              relationship.captionRegionId,
            ) &&
            (relationship.altTextSource === 'source-text' ||
              relationship.evidence.includes(
                'source-text-transcript-unresolved',
              )),
        )
        .map(
          (relationship) =>
            [
              relationship.captionRegionId,
              relationship.altTextSource === 'source-text'
                ? relationship.sourceText
                : relationship.altText,
            ] as const,
        ),
    ),
    visualResult.consumedLineIds,
    regionResult.lineBoundaryDecisions,
  )
  const markerClassifications = synthesizeRecoveredBibliographyClassifications(
    markerResult.classifications,
    blocks,
  )
  const originalClassificationIds = new Set(
    markerResult.classifications.map((classification) => classification.id),
  )
  for (const classification of markerClassifications.filter(
    (candidate) => !originalClassificationIds.has(candidate.id),
  )) {
    diagnostics.push({
      code: 'CLASSIFIED_NOTE_MARKER',
      severity: 'info',
      page: classification.sourceBox.page,
      message: `Classified ${classification.id} as ${classification.taxonomy} at confidence ${classification.confidence.toFixed(2)} against threshold ${classification.threshold.toFixed(2)} using ${classification.evidence.join(', ')}.`,
      noteMarkerClassification: classification,
    })
  }
  const frontMatter = classifyFrontMatter(blocks, metadata.title)
  const canonicalBlocks = blocks.filter(
    (block) =>
      block.frontMatterRole !== 'title' &&
      block.frontMatterRole !== 'author' &&
      block.frontMatterRole !== 'affiliation',
  )
  mergeProseContinuations(canonicalBlocks)
  noteNodeIds(blocks)
  for (const [index, block] of blocks.entries()) {
    block.nodeId ??= nodeId(index, block.type, block.text)
  }
  const authorNoteReferences = detectAuthorNoteReferences(
    blocks,
    markerClassifications,
  )
  const sourceAuthors =
    frontMatter.authors.length > 0
      ? frontMatter.authors
      : inferredAuthors(blocks)
  const paperAuthors = metadata.author?.trim()
    ? parseAuthors(metadata.author)
    : sourceAuthors.length > 0
      ? sourceAuthors
      : ['Imported locally']
  const renderedAuthorNoteReferences = authorNoteReferences.filter(
    (reference) => paperAuthors.includes(reference.author),
  )
  const embeddedLinks = pages.flatMap((page) => page.links ?? [])
  const visualAssetsById = new Map(
    visualResult.assets.map((asset) => [asset.id, asset] as const),
  )
  const canonicalVisualDrafts = new Map<string, CanonicalVisualDraft>()
  for (const relationship of visualResult.relationships) {
    const draft = canonicalVisualDraft(
      relationship,
      blocks,
      visualAssetsById,
      embeddedLinks,
      sourceHash,
    )
    if (draft) canonicalVisualDrafts.set(relationship.id, draft)
  }
  const canonicalVisualTextOwners = visualResult.relationships.flatMap(
    (relationship) => {
      const draft = canonicalVisualDrafts.get(relationship.id)
      if (!draft) return []
      const owner = canonicalVisualTextOwner(
        relationship,
        draft.id,
        regionResult.regions,
        regionResult.lineBoundaryDecisions,
      )
      return owner ? [owner] : []
    },
  )
  const canonicalVisualTextOwnersByNodeId = new Map(
    canonicalVisualTextOwners.map((owner) => [owner.nodeId, owner] as const),
  )
  const citationRelationships = buildCitationRelationships(
    markerClassifications,
    canonicalBlocks,
  )
  for (const relationship of citationRelationships) {
    const candidates = canonicalBlocks.flatMap((block) => {
      if (block.type !== 'heading' && block.type !== 'paragraph') return []
      const range = exactCanonicalRangeForSource(
        block,
        relationship.referenceRegionId,
        relationship.referenceStart,
        relationship.referenceEnd,
      )
      return range && block.nodeId ? [{ nodeId: block.nodeId, ...range }] : []
    })
    candidates.push(
      ...canonicalVisualTextOwners.flatMap((owner) => {
        const range = exactVisualCanonicalRangeForSource(
          owner,
          relationship,
          regionMap,
        )
        return range ? [range] : []
      }),
    )
    relationship.canonicalAnchor =
      candidates.length === 1 ? candidates[0] : null
  }
  for (const relationship of citationRelationships.filter(
    (candidate) => candidate.status === 'unresolved',
  )) {
    diagnostics.push({
      code: 'UNRESOLVED_CITATION_REFERENCE',
      severity: 'error',
      page: relationship.sourceBoxes[0]?.page,
      message: `Citation marker ${relationship.id} has no complete bibliography-label target.`,
      sourceBoxes: relationship.sourceBoxes,
      relationshipId: relationship.id,
      target: {
        regionIds: [relationship.referenceRegionId],
        markerId: relationship.id,
      },
    })
  }
  for (const relationship of citationRelationships.filter(
    (candidate) =>
      candidate.status === 'matched' && candidate.canonicalAnchor === null,
  )) {
    diagnostics.push({
      code: 'UNMAPPED_CITATION_ANCHOR',
      severity: 'error',
      page: relationship.sourceBoxes[0]?.page,
      message: `Citation marker ${relationship.id} has bibliography targets but no exact canonical inline anchor.`,
      sourceBoxes: relationship.sourceBoxes,
      relationshipId: relationship.id,
      target: {
        regionIds: [relationship.referenceRegionId],
        markerId: relationship.id,
      },
    })
  }
  const citationsById = new Map(
    citationRelationships.map((relationship) => [
      relationship.id,
      relationship,
    ]),
  )
  const semanticReferencesByRegion = new Map<string, SemanticReferenceDraft[]>()
  for (const classification of markerClassifications) {
    const semanticRole = semanticRoleForClassification(classification)
    if (!semanticRole || !classification.accepted) continue
    const citation = citationsById.get(classification.id)
    const values =
      semanticReferencesByRegion.get(classification.referenceRegionId) ?? []
    values.push({
      id: classification.id,
      start: classification.start,
      end: classification.end,
      semanticRole,
      ...(citation?.targetNodeIds.length
        ? { targetIds: citation.targetNodeIds }
        : {}),
    })
    semanticReferencesByRegion.set(classification.referenceRegionId, values)
  }
  const authorRegionIds = new Set(
    blocks
      .filter((block) => block.frontMatterRole === 'author')
      .map((block) => block.region.id),
  )
  const references = [
    ...detectReferences(markerClassifications, regionMap).filter(
      (reference) => !authorRegionIds.has(reference.region.id),
    ),
    ...renderedAuthorNoteReferences,
  ]
  const noteRelationships = matchNotes(blocks, references, diagnostics)
  const matchedReferences = new Map(
    noteRelationships
      .filter(
        (
          relationship,
        ): relationship is PdfNoteRelationship & { targetNoteId: string } =>
          relationship.status === 'matched' &&
          relationship.targetNoteId !== null,
      )
      .map((relationship) => [relationship.id, relationship]),
  )
  const referenceDrafts = new Map(
    references.map((reference) => [reference.id, reference]),
  )

  if (canonicalBlocks.length === 0) {
    diagnostics.push({
      code: 'NO_RECONSTRUCTABLE_TEXT',
      severity: 'error',
      message: 'No reconstructable embedded text was found.',
    })
  }

  const provenance: Record<string, NodeSourceEvidence> = {}
  const inlineSpanLedger: InlineMappingLedger = {
    expected: citationRelationships.length,
    mapped: citationRelationships.filter(
      (relationship) => relationship.canonicalAnchor !== null,
    ).length,
  }
  const nodes: ResearchNode[] = canonicalBlocks.map((block, index) => {
    const id = block.nodeId ?? nodeId(index, block.type, block.text)
    provenance[id] = sourceEvidence(block, embeddedLinks)
    if (isIsolatedProseGlyph(block)) {
      diagnostics.push({
        code: 'ISOLATED_PROSE_GLYPH',
        severity: 'error',
        page: block.region.page,
        message: `An isolated alphabetic glyph remains in canonical prose on page ${block.region.page}; source-region evidence is insufficient to classify it as a visual, table, list, equation, or page-furniture fragment.`,
        sourceBoxes: [block.region.box],
        target: {
          regionIds: [block.region.id],
          markerId: null,
        },
      })
    }
    if (
      block.confidence < 0.75 &&
      !regionResult.ambiguousPages.includes(block.region.page)
    ) {
      diagnostics.push({
        code: 'LOW_CONFIDENCE_BLOCK',
        severity: 'warning',
        page: block.region.page,
        message: `A reconstructed ${block.region.kind} region on page ${block.region.page} needs review.`,
        sourceBoxes: [block.region.box],
        target: {
          regionIds: [block.region.id],
          markerId: null,
        },
      })
    }
    const source = `pdf:${sourceHash.slice(0, 16)}#page=${block.region.page}`
    if (block.type === 'footnote') {
      const backlinks = noteRelationships
        .filter(
          (relationship) =>
            relationship.status === 'matched' &&
            relationship.targetNoteId === id,
        )
        .map((relationship) => relationship.id)
      return {
        id,
        type: 'footnote' as const,
        kind: block.noteKind!,
        label: block.noteLabel!,
        ...(block.noteMarkerText ? { markerText: block.noteMarkerText } : {}),
        text: block.text,
        relationships: { backlinks },
        source,
      }
    }
    const sourceRegionIds = new Set(
      blockSourceSegments(block).map((segment) => segment.region.id),
    )
    const sourceNoteReferences = [...matchedReferences.values()]
      .filter((relationship) =>
        sourceRegionIds.has(relationship.referenceRegionId),
      )
      .map((relationship) => {
        const draft = referenceDrafts.get(relationship.id)!
        return {
          id: relationship.id,
          label: relationship.label,
          target: relationship.targetNoteId,
          start: draft.start,
          end: draft.end,
          regionId: relationship.referenceRegionId,
          confidence: relationship.confidence,
        }
      })
    const noteReferences = sourceNoteReferences.flatMap((reference) => {
      const range = canonicalRangeForSource(
        block,
        reference.regionId,
        reference.start,
        reference.end,
      )
      return range
        ? [
            {
              id: reference.id,
              label: reference.label,
              target: reference.target,
              ...range,
              confidence: reference.confidence,
            },
          ]
        : []
    })
    const semanticReferences = blockSourceSegments(block).flatMap((segment) =>
      (semanticReferencesByRegion.get(segment.region.id) ?? []).flatMap(
        (reference) => {
          if (reference.semanticRole !== 'citation') {
            return [{ ...reference, regionId: segment.region.id }]
          }
          const anchor = citationsById.get(reference.id)?.canonicalAnchor
          return anchor?.nodeId === id
            ? [{ ...reference, regionId: segment.region.id }]
            : []
        },
      ),
    )
    const inlineMapping = sourceInlineRuns(
      block,
      embeddedLinks,
      sourceNoteReferences,
      semanticReferences,
    )
    inlineSpanLedger.expected += inlineMapping.ledger.expected
    inlineSpanLedger.mapped += inlineMapping.ledger.mapped
    const inlineRuns = inlineMapping.runs
    if (block.type === 'heading') {
      return {
        id,
        type: 'heading' as const,
        level: block.headingLevel ?? (2 as const),
        text: block.text,
        ...(noteReferences.length > 0 ? { noteReferences } : {}),
        ...(inlineRuns.length > 0 ? { inlineRuns } : {}),
        source,
      }
    }
    if (block.type === 'caption') {
      return {
        id,
        type: 'caption' as const,
        text: block.text,
        ...(inlineRuns.length > 0 ? { inlineRuns } : {}),
        source,
      }
    }
    return {
      id,
      type: 'paragraph' as const,
      text: block.text,
      ...(noteReferences.length > 0 ? { noteReferences } : {}),
      ...(inlineRuns.length > 0 ? { inlineRuns } : {}),
      ...(block.list ? { list: block.list } : {}),
      source,
    }
  })

  for (const relationship of visualResult.relationships) {
    const draft = canonicalVisualDrafts.get(relationship.id)
    if (!draft) continue
    relationship.sourceBoxes = [draft.captionEnvelope, ...draft.lineageBoxes]
    const table =
      relationship.kind === 'table'
        ? relationship.assetIds
            .map((assetId) =>
              visualResult.canonicalTablesByAssetId.get(assetId),
            )
            .find((candidate) => candidate !== undefined)
        : undefined
    const textOwner = canonicalVisualTextOwnersByNodeId.get(draft.id)
    const inlineRuns = textOwner
      ? citationRelationships.flatMap((citation) =>
          citation.canonicalAnchor?.nodeId === draft.id
            ? [
                {
                  start: citation.canonicalAnchor.start,
                  end: citation.canonicalAnchor.end,
                  relationshipId: citation.id,
                  semanticRole: 'citation' as const,
                  targetIds: citation.targetNodeIds,
                },
              ]
            : [],
        )
      : []
    const node: ResearchNode = {
      id: draft.id,
      type: 'figure',
      objectType: relationship.kind,
      ...(table ? { table } : {}),
      ...(textOwner ? { sourceText: textOwner.text } : {}),
      ...(inlineRuns.length > 0 ? { inlineRuns } : {}),
      title: relationship.altText,
      relationships: {
        caption: draft.captionBlock.nodeId,
        assets: relationship.assetIds,
      },
      source: draft.source,
    }
    provenance[draft.id] = {
      confidence: relationship.confidence,
      pages: [...new Set(relationship.sourceBoxes.map((box) => box.page))],
      regionIds: [...relationship.sourceRegionIds],
      boxes: relationship.sourceBoxes.map((box) => ({ ...box })),
      links: [],
    }
    const captionIndex = nodes.findIndex(
      (candidate) => candidate.id === draft.captionBlock.nodeId,
    )
    nodes.splice(captionIndex < 0 ? nodes.length : captionIndex, 0, node)
  }

  orderCanonicalVisualPairs(
    nodes,
    visualResult.relationships.flatMap((relationship) => {
      const draft = canonicalVisualDrafts.get(relationship.id)
      return draft
        ? [
            {
              page: draft.page,
              visualNodeId: draft.id,
              captionNodeId: draft.captionBlock.nodeId,
            },
          ]
        : []
    }),
  )

  assertUniqueCanonicalNodeIds(nodes)

  const firstHeading = nodes.find(
    (node): node is Extract<ResearchNode, { type: 'heading' }> =>
      node.type === 'heading',
  )
  const firstParagraph = nodes.find(
    (node): node is Extract<ResearchNode, { type: 'paragraph' }> =>
      node.type === 'paragraph',
  )
  const authorNotes = renderedAuthorNoteReferences.flatMap((reference) => {
    const relationship = noteRelationships.find(
      (candidate) =>
        candidate.id === reference.id &&
        candidate.status === 'matched' &&
        candidate.targetNoteId !== null,
    )
    return relationship && paperAuthors.includes(reference.author)
      ? [
          {
            id: reference.id,
            author: reference.author,
            label: reference.label,
            target: relationship.targetNoteId!,
          },
        ]
      : []
  })
  const paper: ResearchPaper = {
    id: `pdf-${sourceHash.slice(0, 16)}`,
    version: '1.0.0-import',
    status: 'working',
    title:
      frontMatter.title ||
      firstHeading?.text ||
      fileName.replace(/\.pdf$/i, ''),
    subtitle:
      metadata.subject?.trim() || `Reconstructed locally from ${fileName}`,
    authors: paperAuthors,
    ...(authorNotes.length > 0 ? { authorNotes } : {}),
    ...(frontMatter.affiliations.length > 0
      ? { affiliations: frontMatter.affiliations }
      : {}),
    updated: validDate(metadata.modified),
    abstract:
      frontMatter.abstract.slice(0, 700) ||
      firstParagraph?.text.slice(0, 700) ||
      'This document requires OCR or manual reconstruction before publication.',
    nodes,
  }

  const classifiedLineBoundaries = classifyStructuralLineBoundaryDecisions({
    decisions: regionResult.lineBoundaryDecisions,
    paper,
    provenance,
    visualRelationships: visualResult.relationships,
    assets: visualResult.assets,
  })

  const assessment = assessPdfCompleteness({
    pages,
    paper,
    diagnostics,
    readingOrder: regionResult.readingOrder,
    regions: regionResult.regions,
    visualRelationships: visualResult.relationships,
    assets: visualResult.assets,
    citationRelationships,
    provenance,
    lineBoundaryDecisions: classifiedLineBoundaries.decisions,
    unresolvedCorruptingJoinCount:
      classifiedLineBoundaries.unresolvedCorruptingJoinCount,
    structurallyConsumedLineBoundaryCount:
      classifiedLineBoundaries.structurallyConsumedLineBoundaryCount,
    inlineSpanLedger,
  })

  return {
    source: {
      fileName,
      byteLength,
      sha256: sourceHash,
      pageCount: pages.length,
      localOnly: true,
    },
    paper,
    pages,
    regions: regionResult.regions,
    lineBoundaryDecisions: classifiedLineBoundaries.decisions,
    unresolvedCorruptingJoinCount:
      classifiedLineBoundaries.unresolvedCorruptingJoinCount,
    structurallyConsumedLineBoundaryCount:
      classifiedLineBoundaries.structurallyConsumedLineBoundaryCount,
    readingOrder: regionResult.readingOrder,
    noteRelationships,
    citationRelationships,
    visualRelationships: visualResult.relationships,
    assets: visualResult.assets,
    provenance,
    humanAdjudications: {
      schemaVersion: '1.0.0',
      documentSha256: sourceHash,
      applied: [],
      stale: [],
      countsByDiagnosticCode: {},
    },
    diagnostics: assessment.diagnostics,
    semanticSignals: assessment.semanticSignals,
    completeness: assessment.completeness,
    readiness: assessment.readiness,
  }
}

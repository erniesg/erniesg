import type { PdfNoteMarkerClassification, PdfPageRegion } from './import-types'
import { PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD } from './pdf-note-classifier'
import { fontNameIndicatesEmphasizedFace } from './pdf-region-fragments'
import { normalizedNoteLabel } from './pdf-regions'

export type PdfListRegionBlock = {
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
  suppressSourceInlineRuns?: boolean
  nodeId?: string
  bibliographyContinuedFromPreviousPage?: boolean
  frontMatterRole?:
    'title' | 'author' | 'affiliation' | 'abstract-heading' | 'abstract-body'
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

function validRomanNumeral(value: string) {
  return /^(?:M{0,3})(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/iu.test(
    value,
  )
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

export function parsedOrderedListMarker(value: string) {
  const trimmed = value.trimStart()
  const match = trimmed.match(
    /^(?:(\[\s*(\d+)\s*\])|(\(\s*(\d+|[A-Za-z]|[ivxlcdm]+)\s*\))|((\d+|[A-Za-z]|[ivxlcdm]+)[.)]))\s+(.+)$/i,
  )
  if (!match) return null
  const markerText = match[1] ?? match[3] ?? match[5]
  const marker = match[2] ?? match[4] ?? match[6]
  if (/^\d{4}$/.test(marker) && Number(marker) >= 1800) return null
  if (/^[ivxlcdm]{2,}$/iu.test(marker) && !validRomanNumeral(marker)) {
    return null
  }
  return {
    markerText,
    itemText: match[7],
    contentStart:
      value.length - trimmed.length + match[0].length - match[7].length,
    ...orderedMarker(marker),
  }
}

export type SourceMarkupShape = {
  heading: boolean
  emphasis: boolean
  template: boolean
  orderedList: boolean
}

export function sourceMarkupShape(value: string): SourceMarkupShape {
  const trimmed = value.trim()
  return {
    heading: /^#{1,6}\s+/u.test(trimmed),
    emphasis: /^(?:\*\*(?=\S)[\s\S]*\*\*|__(?=\S)[\s\S]*__)$/u.test(trimmed),
    template: /^\{[A-Za-z_][A-Za-z0-9_.-]*\}$/u.test(trimmed),
    orderedList:
      /^(?:(?:\d+(?:\.\d+){0,3})[.)]|\(\s*\d{1,3}\s*\)|\[\s*\d{1,4}\s*\])\s+\S/u.test(
        trimmed,
      ),
  }
}

function orderedMarkerHasWithinBlockHangingIndent(
  block: PdfListRegionBlock,
  marker: NonNullable<ReturnType<typeof parsedOrderedListMarker>>,
) {
  const visibleLines = block.region.lines.filter((line) => line.text.trim())
  if (visibleLines.length < 2) return false
  const firstLine = visibleLines[0]
  const continuationLine = visibleLines[1]
  const firstLineRuns = firstLine.runs.filter((run) => run.text.trim())
  const continuationRuns = continuationLine.runs.filter((run) =>
    run.text.trim(),
  )
  if (firstLineRuns.length === 0 || continuationRuns.length === 0) {
    return false
  }

  const firstLineMarker = parsedOrderedListMarker(firstLine.text)
  if (
    !firstLineMarker ||
    firstLineMarker.markerText !== marker.markerText ||
    firstLineMarker.itemText.length === 0
  ) {
    return false
  }
  const markerRun = firstLineRuns[0]
  const markerRunText = markerRun.text.trimStart()
  if (!markerRunText.startsWith(marker.markerText)) return false
  const markerStartX = markerRun.x
  const contentStartX =
    markerRunText === marker.markerText && firstLineRuns.length > 1
      ? firstLineRuns[1].x
      : markerRun.x +
        markerRun.width *
          (firstLineMarker.contentStart /
            Math.max(Array.from(markerRun.text).length, 1))
  const continuationStartX = Math.min(...continuationRuns.map((run) => run.x))
  const verticalGap =
    continuationLine.box.y - (firstLine.box.y + firstLine.box.height)
  const fontRatio =
    Math.max(firstLine.fontSize, continuationLine.fontSize) /
    Math.max(1, Math.min(firstLine.fontSize, continuationLine.fontSize))
  return (
    contentStartX - markerStartX >= 0.012 &&
    Math.abs(continuationStartX - contentStartX) <= 0.012 &&
    verticalGap >= -0.004 &&
    verticalGap <=
      Math.max(
        0.03,
        Math.max(firstLine.box.height, continuationLine.box.height) * 2,
      ) &&
    fontRatio <= 1.12
  )
}

export function orderedMarkerHasIndependentEvidence(
  blockIndex: number,
  blocks: readonly PdfListRegionBlock[],
  marker: NonNullable<ReturnType<typeof parsedOrderedListMarker>>,
  bodySize: number,
) {
  const block = blocks[blockIndex]
  if (!block) return false
  const visibleRuns = block.region.lines.flatMap((line) =>
    line.runs.filter((run) => run.text.trim()),
  )
  const firstLine = block.region.lines.find((line) => line.text.trim())
  const firstLineRuns = firstLine?.runs.filter((run) => run.text.trim()) ?? []
  const markerRunSeparated = Boolean(
    firstLineRuns.length > 1 &&
    firstLineRuns[0].text.trim() === marker.markerText,
  )
  const withinBlockHangingIndent = orderedMarkerHasWithinBlockHangingIndent(
    block,
    marker,
  )
  const largestFont = Math.max(
    ...block.region.lines.map((line) => line.fontSize),
    bodySize,
  )
  const emphasizedShare =
    visibleRuns.reduce(
      (total, run) =>
        total +
        (run.bold || fontNameIndicatesEmphasizedFace(run.fontName)
          ? run.text.trim().length
          : 0),
      0,
    ) /
    Math.max(
      1,
      visibleRuns.reduce((total, run) => total + run.text.trim().length, 0),
    )
  if (
    markerRunSeparated ||
    withinBlockHangingIndent ||
    largestFont >= bodySize * 1.12 ||
    emphasizedShare >= 0.6
  ) {
    return true
  }

  const preceding = blocks[blockIndex - 1]
  if (preceding?.type === 'paragraph' && preceding.list?.ordered) {
    return true
  }
  if (
    preceding?.type === 'paragraph' &&
    /:\s*$/u.test(preceding.text.trimEnd()) &&
    block.region.box.x > preceding.region.box.x + 0.012
  ) {
    return true
  }
  if (
    preceding?.type === 'paragraph' &&
    block.region.page >= preceding.region.page &&
    block.region.box.x >= preceding.region.box.x + 0.05
  ) {
    return true
  }

  return blocks.some((candidate, candidateIndex) => {
    if (candidateIndex === blockIndex || candidate.type !== 'paragraph') {
      return false
    }
    const parsedPeer = parsedOrderedListMarker(candidate.text)
    const peer =
      parsedPeer ??
      (candidate.list?.ordered &&
      candidate.list.markerText &&
      candidate.list.ordinal !== undefined
        ? {
            markerText: candidate.list.markerText,
            markerStyle: candidate.list.markerStyle,
            ordinal: candidate.list.ordinal,
          }
        : null)
    if (!peer) return false
    const samePage = candidate.region.page === block.region.page
    const adjacentPage =
      candidate.region.page + 1 === block.region.page &&
      candidate.region.column === block.region.column &&
      Math.abs(candidate.region.box.x - block.region.box.x) <= 0.05
    if (!samePage && !adjacentPage) return false
    const sameStyle = peer.markerStyle === marker.markerStyle
    const ordinalSequence =
      sameStyle &&
      Math.abs(peer.ordinal - marker.ordinal) === 1 &&
      (adjacentPage ||
        (candidate.region.column === block.region.column &&
          Math.abs(candidate.region.box.x - block.region.box.x) <= 0.05 &&
          Math.abs(candidate.region.box.y - block.region.box.y) <= 0.2))
    const oppositeColumnRow =
      candidate.region.column !== block.region.column &&
      Math.abs(candidate.region.box.y - block.region.box.y) <= 0.035
    const nestedGeometry =
      candidate.region.column === block.region.column &&
      candidate.region.box.x > block.region.box.x + 0.012 &&
      Math.abs(candidate.region.box.y - block.region.box.y) <= 0.12
    return ordinalSequence || oppositeColumnRow || nestedGeometry
  })
}

export function ambiguousParenthesizedRomanListMarker(
  marker: ReturnType<typeof parsedOrderedListMarker>,
) {
  return Boolean(
    marker &&
    marker.markerStyle === 'lower-roman' &&
    /^\(\s*[ivxlcdm]+\s*\)$/iu.test(marker.markerText),
  )
}

function parenthesizedDecimalOrdinals(value: string) {
  return [...value.matchAll(/\(\s*(\d{1,3})\s*\)/gu)].map((match) =>
    Number(match[1]),
  )
}

function suffixedDecimalOrdinals(value: string) {
  return [...value.matchAll(/(?:^|\s)(\d{1,3})\)(?=\s)/gu)].map((match) =>
    Number(match[1]),
  )
}

function alignedParagraphSourceFlow(
  preceding: PdfListRegionBlock,
  continuation: PdfListRegionBlock,
) {
  if (
    preceding.region.page !== continuation.region.page ||
    preceding.region.column !== continuation.region.column
  ) {
    return false
  }
  const precedingTail = preceding.region.lines.at(-1)
  const continuationHead = continuation.region.lines[0]
  if (!precedingTail || !continuationHead) return false
  const verticalGap =
    continuationHead.box.y - (precedingTail.box.y + precedingTail.box.height)
  return (
    Math.abs(continuationHead.box.x - precedingTail.box.x) <= 0.012 &&
    verticalGap >= -0.006 &&
    verticalGap <= 0.021 &&
    Math.abs(continuationHead.fontSize - precedingTail.fontSize) <=
      Math.max(0.5, precedingTail.fontSize * 0.08)
  )
}

export function flowingParenthesizedDecimalEnumerationContinuation(
  preceding: PdfListRegionBlock | undefined,
  continuation: PdfListRegionBlock,
  marker: ReturnType<typeof parsedOrderedListMarker>,
) {
  if (
    !preceding ||
    preceding.type !== 'paragraph' ||
    preceding.list ||
    !marker ||
    marker.markerStyle !== 'decimal' ||
    !/^\(\s*\d{1,3}\s*\)$/u.test(marker.markerText) ||
    !alignedParagraphSourceFlow(preceding, continuation)
  ) {
    return false
  }

  const precedingOrdinals = parenthesizedDecimalOrdinals(preceding.text)
  const continuationOrdinals = parenthesizedDecimalOrdinals(continuation.text)
  return (
    precedingOrdinals.includes(marker.ordinal - 1) &&
    continuationOrdinals[0] === marker.ordinal &&
    continuationOrdinals.includes(marker.ordinal + 1)
  )
}

export function flowingSuffixedDecimalEnumerationContinuation(
  preceding: PdfListRegionBlock | undefined,
  continuation: PdfListRegionBlock,
  marker: ReturnType<typeof parsedOrderedListMarker>,
) {
  if (
    !preceding ||
    preceding.type !== 'paragraph' ||
    preceding.list ||
    !marker ||
    marker.markerStyle !== 'decimal' ||
    !/^\d{1,3}\)$/u.test(marker.markerText) ||
    !alignedParagraphSourceFlow(preceding, continuation) ||
    !/(?:\bor|\band|[,;:])\s*$/iu.test(preceding.text)
  ) {
    return false
  }
  return suffixedDecimalOrdinals(preceding.text).includes(marker.ordinal - 1)
}

export function flowingSentenceFinalMathVariableContinuation(
  preceding: PdfListRegionBlock | undefined,
  continuation: PdfListRegionBlock,
  marker: ReturnType<typeof parsedOrderedListMarker>,
) {
  if (
    !preceding ||
    preceding.type !== 'paragraph' ||
    preceding.list ||
    !marker ||
    !/^[A-Z]\.$/u.test(marker.markerText) ||
    /[.!?;:]\s*$/u.test(preceding.text) ||
    !alignedParagraphSourceFlow(preceding, continuation)
  ) {
    return false
  }
  const runs = continuation.region.lines[0]?.runs.filter((run) =>
    run.text.trim(),
  )
  const variable = runs?.[0]
  const prose = runs?.[1]
  const sourceVariable = marker.markerText.slice(0, -1)
  return Boolean(
    variable &&
    prose &&
    variable.text.trim() === sourceVariable &&
    (variable.italic || /(?:CMMI|math|symbol)/iu.test(variable.fontName)) &&
    /^\.\p{Lu}\p{Ll}+/u.test(prose.text.trimStart()),
  )
}

export function parsedBibliographyListMarker(value: string) {
  const trimmed = value.trimStart()
  const match = trimmed.match(
    /^(?:(\[\s*(\d{1,4})\s*\])|(\(\s*(\d{1,4})\s*\))|((\d{1,3})[.)]))\s+(.+)$/u,
  )
  if (!match) return null
  const markerText = match[1] ?? match[3] ?? match[5]
  const marker = match[2] ?? match[4] ?? match[6]
  if (/^\d{4}$/u.test(marker) && Number(marker) >= 1800) return null
  if (Number(marker) === 0) return null
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

export function parsedBulletListMarker(value: string) {
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

export function blockSourceSegments(block: PdfListRegionBlock) {
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

export function stripBlockMarker(
  block: PdfListRegionBlock,
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

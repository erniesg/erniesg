import type {
  NormalizedSourceBox,
  PdfNoteMarkerClassification,
  PdfNoteMarkerTaxonomy,
  PdfPageRegion,
} from './import-types'
import { normalizedNoteLabel, noteLabelFromText } from './pdf-regions'

export const PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD = 0.85
export const PDF_NOTE_CITATION_DENSITY_THRESHOLD = 2

type MarkerSyntax =
  | 'explicit-note-language'
  | 'author-year-syntax'
  | 'bracketed-numeric-syntax'
  | 'superscript-cluster-syntax'
  | 'superscript-syntax'
  | 'rendered-superscript-geometry'

type MarkerCandidate = {
  label: string
  labels: string[]
  region: PdfPageRegion
  start: number
  end: number
  syntax: MarkerSyntax
  sourceBox: NormalizedSourceBox
}

export type PdfNoteMarkerClassificationResult = {
  classifications: PdfNoteMarkerClassification[]
  bibliographyRegionIds: string[]
  noteBodyRegionIds: string[]
}

const REFERENCE_HEADING =
  /^(?:(?:\d+(?:\.\d+)*)\s+)?(?:references|bibliography|works cited|literature cited)$/i
const REFERENCE_SECTION_END =
  /^(?:appendix\b|acknowledg(?:e)?ments?\b|supplement(?:ary)?\b|author contributions?\b|data availability\b)/i
const BODY_SECTION_HEADING = /^(?:abstract|introduction)\b/i
const NOTE_TOKEN_SOURCE = String.raw`(?:\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*†‡§])`
const AUTHOR_YEAR_SURNAME_SOURCE = String.raw`\p{Lu}[\p{L}\p{M}'’.-]*`
const AUTHOR_YEAR_SOURCE = String.raw`(?:18|19|20)\d{2}[a-z]?`
const MAX_EXPANDED_CITATION_RANGE = 100

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function markerSlug(value: string) {
  return (
    normalizedNoteLabel(value)
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'marker'
  )
}

function markerSourceAnchor(
  marker: Pick<
    PdfNoteMarkerClassification,
    'referenceRegionId' | 'start' | 'end'
  >,
) {
  return `${markerSlug(marker.referenceRegionId)}-s${String(marker.start).padStart(6, '0')}-e${String(marker.end).padStart(6, '0')}`
}

function positionCompare(left: PdfPageRegion, right: PdfPageRegion) {
  return (
    left.page - right.page ||
    left.box.y - right.box.y ||
    left.box.x - right.box.x ||
    left.id.localeCompare(right.id)
  )
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle]
}

function endsReferenceSection(region: PdfPageRegion, bodyFontSize: number) {
  const text = region.text.trim()
  if (REFERENCE_SECTION_END.test(text)) return true
  const largestFontSize = Math.max(
    ...region.lines.map((line) => line.fontSize),
    0,
  )
  return (
    bodyFontSize > 0 &&
    region.lines.length > 0 &&
    region.lines.length <= 2 &&
    text.length <= 180 &&
    /^[A-Z]\.\s+\p{Lu}/u.test(text) &&
    largestFontSize >= bodyFontSize * 1.12
  )
}

function sourceBox(region: PdfPageRegion): NormalizedSourceBox {
  return { ...region.box }
}

function labelsFrom(value: string) {
  const labels: string[] = []
  const pattern = new RegExp(
    `(${NOTE_TOKEN_SOURCE})(?:\\s*[–—-]\\s*(${NOTE_TOKEN_SOURCE}))?`,
    'gu',
  )
  const add = (label: string) => {
    if (label && !labels.includes(label)) labels.push(label)
  }
  for (const match of value.matchAll(pattern)) {
    const first = normalizedNoteLabel(match[1])
    const last = match[2] ? normalizedNoteLabel(match[2]) : null
    const firstOrdinal = /^\d+$/.test(first) ? Number(first) : null
    const lastOrdinal = last && /^\d+$/.test(last) ? Number(last) : null
    if (
      firstOrdinal !== null &&
      lastOrdinal !== null &&
      lastOrdinal >= firstOrdinal &&
      lastOrdinal - firstOrdinal <= MAX_EXPANDED_CITATION_RANGE
    ) {
      for (let ordinal = firstOrdinal; ordinal <= lastOrdinal; ordinal += 1) {
        add(String(ordinal))
      }
      continue
    }
    add(first)
    if (last) add(last)
  }
  return labels
}

function isMathematicalBracket(text: string, start: number) {
  const prefix = text.slice(Math.max(0, start - 64), start).trimEnd()
  return /(?:[:=∈∉≤≥<>]|\b(?:set|list|array|vector|matrix|tuple|values?|numbers?|tokens?|tokenizes?|integers?|ranges?|periods?|moduli|indices|dimensions?|shape)\s*(?::|=)?)$/iu.test(
    prefix,
  )
}

function isMathematicalScript(text: string, start: number, end: number) {
  const scriptCharacters = '0-9⁰¹²³⁴⁵⁶⁷⁸⁹'
  const tokenCharacters = new RegExp(`[\\p{L}${scriptCharacters}]`, 'u')
  let tokenStart = start
  let tokenEnd = end
  while (tokenStart > 0 && tokenCharacters.test(text[tokenStart - 1])) {
    tokenStart -= 1
  }
  while (tokenEnd < text.length && tokenCharacters.test(text[tokenEnd])) {
    tokenEnd += 1
  }
  const token = text.slice(tokenStart, tokenEnd)
  const variableWithScript = new RegExp(
    `^[\\p{L}][${scriptCharacters}]+$`,
    'u',
  ).test(token)
  const before = text.slice(Math.max(0, start - 1), start)
  const after = text.slice(end, end + 8)
  const embeddedBetweenSymbols =
    /[\p{L}\p{N})\]}]/u.test(before) && /^[\p{L}\p{N}([{]/u.test(after)
  const followedByMathematicalRelation =
    /[\p{L}\p{N})\]}]/u.test(before) && /^\s*(?:=|[+\-−×÷≤≥≈∈∉])/u.test(after)
  return (
    variableWithScript ||
    embeddedBetweenSymbols ||
    followedByMathematicalRelation
  )
}

function markerCandidates(region: PdfPageRegion) {
  const found: MarkerCandidate[] = []
  const add = (
    rawLabels: string[],
    start: number,
    end: number,
    syntax: MarkerSyntax,
    box = sourceBox(region),
  ) => {
    const labels = rawLabels.map(normalizedNoteLabel).filter(Boolean)
    if (labels.length === 0 || start < 0 || end <= start) return
    const overlappingIndex = found.findIndex(
      (candidate) =>
        Math.max(candidate.start, start) < Math.min(candidate.end, end),
    )
    if (overlappingIndex >= 0) {
      const overlapping = found[overlappingIndex]
      const strongerGeometryRange =
        syntax === 'rendered-superscript-geometry' &&
        overlapping.syntax === 'superscript-syntax' &&
        start <= overlapping.start &&
        end >= overlapping.end &&
        end - start > overlapping.end - overlapping.start
      if (!strongerGeometryRange) return
      found.splice(overlappingIndex, 1)
    }
    found.push({
      label: labels.join(','),
      labels,
      region,
      start,
      end,
      syntax,
      sourceBox: box,
    })
  }

  const explicit =
    /\b(?:footnote|note)\s+(?:(?:reference|marker)\s+)?(\d{1,3}|[*†‡§])(?=\s|[.,;:)\]]|$)/giu
  for (const match of region.text.matchAll(explicit)) {
    const label = match[1]
    const start = (match.index ?? 0) + match[0].lastIndexOf(label)
    add([label], start, start + label.length, 'explicit-note-language')
  }

  const bracketed =
    /\[\s*((?:\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*†‡§])(?:\s*(?:[,;]|[–—-])\s*(?:\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*†‡§]))*)\s*\]/gu
  for (const match of region.text.matchAll(bracketed)) {
    const start = match.index ?? 0
    if (isMathematicalBracket(region.text, start)) continue
    add(
      labelsFrom(match[1]),
      start,
      start + match[0].length,
      'bracketed-numeric-syntax',
    )
  }

  const superscriptCluster = /[⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:\s*[,;˒]\s*[⁰¹²³⁴⁵⁶⁷⁸⁹]+)+/gu
  for (const match of region.text.matchAll(superscriptCluster)) {
    const start = match.index ?? 0
    if (isMathematicalScript(region.text, start, start + match[0].length)) {
      continue
    }
    add(
      labelsFrom(match[0]),
      start,
      start + match[0].length,
      'superscript-cluster-syntax',
    )
  }

  const inlineSuperscript = /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu
  for (const match of region.text.matchAll(inlineSuperscript)) {
    const start = match.index ?? 0
    if (isMathematicalScript(region.text, start, start + match[0].length)) {
      continue
    }
    add([match[0]], start, start + match[0].length, 'superscript-syntax')
  }

  const inlineSymbol = /[*†‡§]/gu
  for (const match of region.text.matchAll(inlineSymbol)) {
    const start = match.index ?? 0
    add([match[0]], start, start + match[0].length, 'superscript-syntax')
  }

  let lineOffset = 0
  for (const line of region.lines) {
    const largestRun = Math.max(...line.runs.map((run) => run.fontSize), 0)
    const baselineRuns = line.runs.filter(
      (run) => run.fontSize >= largestRun * 0.9,
    )
    const baselineCenter =
      baselineRuns.reduce((total, run) => total + run.y + run.height / 2, 0) /
      Math.max(1, baselineRuns.length)
    let runTextCursor = 0
    for (const run of line.runs) {
      const raw = run.text.trim().replace(/\s+/g, ' ')
      const label = normalizedNoteLabel(raw)
      const geometryLabels = labelsFrom(raw)
      const rawPosition = line.text.indexOf(raw, runTextCursor)
      const labelPosition =
        rawPosition < 0 ? line.text.indexOf(label, runTextCursor) : -1
      const withinLine = Math.max(rawPosition, labelPosition)
      if (withinLine >= 0) {
        runTextCursor = withinLine + raw.length
      }
      const runCenter = run.y + run.height / 2
      const baselineHeight = Math.max(
        ...baselineRuns.map((candidate) => candidate.height),
        0,
      )
      if (
        !/^(?:\d{1,3}[*†‡§]+|[*†‡§]+\d{1,3}|[*†‡§]+|\d{1,3})$/.test(label) ||
        geometryLabels.length === 0 ||
        run.fontSize > largestRun * 0.82 ||
        runCenter >= baselineCenter - Math.max(0.0005, baselineHeight * 0.04)
      ) {
        continue
      }
      if (withinLine < 0) continue
      const start = lineOffset + withinLine
      const end = start + raw.length
      if (isMathematicalScript(region.text, start, end)) continue
      add(geometryLabels, start, end, 'rendered-superscript-geometry', {
        page: run.page,
        x: run.x,
        y: run.y,
        width: run.width,
        height: run.height,
        rotation: run.rotation,
        method: run.method,
      })
    }
    lineOffset += line.text.length + 1
  }

  return found.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )
}

function normalizedAuthorYearKey(surname: string, year: string) {
  const normalizedSurname = surname
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/’/gu, "'")
    .toLowerCase()
  return `${normalizedSurname}:${year.toLowerCase()}`
}

function authorYearMarkerCandidates(region: PdfPageRegion) {
  const found: MarkerCandidate[] = []
  const add = (labels: string[], start: number, end: number) => {
    if (labels.length === 0 || start < 0 || end <= start) return
    found.push({
      label: labels.join(','),
      labels,
      region,
      start,
      end,
      syntax: 'author-year-syntax',
      sourceBox: sourceBox(region),
    })
  }
  const component = new RegExp(
    `^\\s*(${AUTHOR_YEAR_SURNAME_SOURCE})\\s+et\\s+al\\.\\s*,\\s*(${AUTHOR_YEAR_SOURCE})\\s*$`,
    'u',
  )
  for (const match of region.text.matchAll(/\([^()]{1,240}\)/gu)) {
    const parts = match[0].slice(1, -1).split(/\s*;\s*/u)
    const parsed = parts.map((part) => part.match(component))
    if (parsed.some((part) => !part)) continue
    add(
      parsed.map((part) => normalizedAuthorYearKey(part![1], part![2])),
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
    )
  }
  const narrative = new RegExp(
    `(?<![\\p{L}\\p{M}'’.-])(${AUTHOR_YEAR_SURNAME_SOURCE})\\s+et\\s+al\\.\\s*\\(\\s*(${AUTHOR_YEAR_SOURCE})\\s*\\)`,
    'gu',
  )
  for (const match of region.text.matchAll(narrative)) {
    const start = match.index ?? 0
    add(
      [normalizedAuthorYearKey(match[1], match[2])],
      start,
      start + match[0].length,
    )
  }
  return found.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )
}

function contextualTaxonomy(
  candidate: MarkerCandidate,
): PdfNoteMarkerTaxonomy | null {
  const prefix = candidate.region.text
    .slice(Math.max(0, candidate.start - 64), candidate.start)
    .trimEnd()
  if (/(?:equation|eq\.?)\s*(?:\(?\s*)?$/i.test(prefix)) {
    return 'equation-reference'
  }
  if (/(?:section|sec\.?)\s*(?:\(?\s*)?$/i.test(prefix)) {
    return 'section-reference'
  }
  return null
}

function classification(
  candidate: MarkerCandidate,
  taxonomy: PdfNoteMarkerTaxonomy,
  disposition: PdfNoteMarkerClassification['disposition'],
  confidence: number,
  evidence: string[],
): Omit<PdfNoteMarkerClassification, 'id'> {
  return {
    label: candidate.label,
    referenceRegionId: candidate.region.id,
    start: candidate.start,
    end: candidate.end,
    taxonomy,
    disposition,
    confidence: rounded(confidence),
    threshold: PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD,
    accepted: confidence >= PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD,
    evidence: [...new Set([candidate.syntax, ...evidence])],
    sourceBox: candidate.sourceBox,
  }
}

function bibliographyEntryMarker(region: PdfPageRegion) {
  const normalized = normalizedNoteLabel(region.text)
  const bracketed = normalized.match(/^\s*\[\s*(\d{1,3}|[*†‡§])\s*\](?=\s|$)/u)
  if (bracketed?.[1]) {
    const start = Math.max(0, normalized.indexOf(bracketed[1]))
    return {
      label: bracketed[1],
      start,
      end: start + bracketed[1].length,
      syntax: 'bracketed-numeric-syntax' as const,
    }
  }
  const label = noteLabelFromText(normalized)
  if (!label) return null
  const start = Math.max(0, normalized.indexOf(label))
  return {
    label: normalizedNoteLabel(label),
    start,
    end: start + label.length,
    syntax: 'rendered-superscript-geometry' as const,
  }
}

export function classifyPdfNoteMarkers(
  regions: PdfPageRegion[],
  readingOrder?: readonly string[],
): PdfNoteMarkerClassificationResult {
  const regionById = new Map(regions.map((region) => [region.id, region]))
  const orderedRegionIds = new Set(readingOrder ?? [])
  const orderedRegions = [
    ...(readingOrder ?? []).flatMap((id) => {
      const region = regionById.get(id)
      return region ? [region] : []
    }),
    ...regions
      .filter((region) => !orderedRegionIds.has(region.id))
      .sort(positionCompare),
  ]
  const bodyFontSize = median(
    orderedRegions.flatMap((region) =>
      region.lines.map((line) => line.fontSize).filter((value) => value > 0),
    ),
  )
  const referenceHeadingIndex = orderedRegions.findLastIndex((region) =>
    REFERENCE_HEADING.test(region.text.trim()),
  )
  const referenceSectionEndIndex =
    referenceHeadingIndex < 0
      ? -1
      : orderedRegions.findIndex(
          (region, index) =>
            index > referenceHeadingIndex &&
            endsReferenceSection(region, bodyFontSize),
        )
  const bibliographyRegionIds = new Set(
    referenceHeadingIndex < 0
      ? []
      : orderedRegions
          .slice(
            referenceHeadingIndex + 1,
            referenceSectionEndIndex < 0 ? undefined : referenceSectionEndIndex,
          )
          .map((region) => region.id),
  )
  const noteBodies = orderedRegions.filter(
    (region) =>
      (region.kind === 'footnote' || region.kind === 'endnote') &&
      !bibliographyRegionIds.has(region.id),
  )
  const ordinaryCandidates = orderedRegions
    .filter((region) => region.kind === 'body' || region.kind === 'spanning')
    .flatMap(markerCandidates)
  const authorYearCandidates =
    referenceHeadingIndex < 0
      ? []
      : orderedRegions
          .filter(
            (region) =>
              (region.kind === 'body' || region.kind === 'spanning') &&
              !bibliographyRegionIds.has(region.id),
          )
          .flatMap(authorYearMarkerCandidates)
  const bibliographyEntryCandidates = orderedRegions
    .filter(
      (region) =>
        bibliographyRegionIds.has(region.id) &&
        (region.kind === 'footnote' || region.kind === 'endnote'),
    )
    .flatMap((region) => {
      const marker = bibliographyEntryMarker(region)
      if (!marker) return []
      return [
        {
          label: marker.label,
          labels: [marker.label],
          region,
          start: marker.start,
          end: marker.end,
          syntax: marker.syntax,
          sourceBox: sourceBox(region),
        },
      ]
    })
  const candidates = [
    ...ordinaryCandidates,
    ...authorYearCandidates,
    ...bibliographyEntryCandidates,
  ].sort(
    (left, right) =>
      positionCompare(left.region, right.region) ||
      left.start - right.start ||
      left.end - right.end,
  )
  const citationMarkerDensity = ordinaryCandidates
    .filter(
      (candidate) =>
        !bibliographyRegionIds.has(candidate.region.id) &&
        (candidate.syntax === 'bracketed-numeric-syntax' ||
          candidate.syntax === 'superscript-cluster-syntax' ||
          candidate.syntax === 'superscript-syntax'),
    )
    .reduce((total, candidate) => total + candidate.labels.length, 0)
  const footnoteBands = noteBodies.filter(
    (region) => region.kind === 'footnote',
  )
  const firstBodySectionY = orderedRegions.find(
    (region) => region.page === 1 && BODY_SECTION_HEADING.test(region.text),
  )?.box.y

  const drafts = candidates.map((candidate) => {
    if (bibliographyRegionIds.has(candidate.region.id)) {
      return classification(
        candidate,
        'bibliography-entry',
        'plain-text',
        0.99,
        ['reference-list-section-detected', 'reference-list-section-scope'],
      )
    }

    const contextual = contextualTaxonomy(candidate)
    if (contextual) {
      return classification(candidate, contextual, 'plain-text', 0.98, [
        'scholarly-cross-reference-context',
      ])
    }

    if (candidate.syntax === 'author-year-syntax') {
      return classification(
        candidate,
        'author-year-bibliography-citation',
        'citation',
        0.98,
        ['reference-list-section-detected', 'bounded-author-year-syntax'],
      )
    }

    const matchingBodies = noteBodies.filter((region) => {
      const label = noteLabelFromText(region.text)
      return label !== null && candidate.labels.includes(label)
    })
    const titlePageAffiliation =
      candidate.region.page === 1 &&
      candidate.region.box.y < 0.34 &&
      firstBodySectionY !== undefined &&
      candidate.region.box.y < firstBodySectionY &&
      (candidate.syntax === 'superscript-syntax' ||
        candidate.syntax === 'rendered-superscript-geometry') &&
      matchingBodies.length === 0
    if (titlePageAffiliation) {
      return classification(
        candidate,
        'author-affiliation-superscript',
        'plain-text',
        0.96,
        [
          'title-page-position',
          'before-first-body-section',
          'no-matching-note-body',
        ],
      )
    }

    const symbolicSuperscriptAnnotation =
      candidate.labels.every((label) => /^[*†‡§]+$/u.test(label)) &&
      (candidate.syntax === 'superscript-syntax' ||
        candidate.syntax === 'rendered-superscript-geometry')
    if (symbolicSuperscriptAnnotation) {
      const samePageFootnotes = matchingBodies.filter(
        (region) =>
          region.kind === 'footnote' && region.page === candidate.region.page,
      )
      if (samePageFootnotes.length > 0) {
        return classification(
          candidate,
          'footnote-reference',
          'note-reference',
          0.97,
          ['matching-note-label', 'same-page-footnote-band'],
        )
      }
      const laterEndnotes = matchingBodies.filter(
        (region) =>
          region.kind === 'endnote' && region.page >= candidate.region.page,
      )
      if (laterEndnotes.length > 0) {
        return classification(
          candidate,
          'endnote-reference',
          'note-reference',
          0.93,
          ['matching-note-label', 'later-endnote-section-scope'],
        )
      }
      return classification(
        candidate,
        'symbolic-annotation-marker',
        'plain-text',
        0.96,
        ['symbolic-marker-not-bibliography-citation', 'no-matching-note-body'],
      )
    }

    const citationEvidence =
      referenceHeadingIndex >= 0 &&
      citationMarkerDensity >= PDF_NOTE_CITATION_DENSITY_THRESHOLD &&
      matchingBodies.length === 0
    if (citationEvidence && candidate.syntax === 'bracketed-numeric-syntax') {
      return classification(
        candidate,
        'bracketed-bibliography-citation',
        'citation',
        0.98,
        [
          'reference-list-section-detected',
          `citation-marker-density-at-least-${PDF_NOTE_CITATION_DENSITY_THRESHOLD}`,
          'no-footnote-band',
          'no-matching-note-body',
        ],
      )
    }
    if (citationEvidence && candidate.syntax === 'superscript-cluster-syntax') {
      return classification(
        candidate,
        'superscript-citation-cluster',
        'citation',
        0.96,
        [
          'reference-list-section-detected',
          `citation-marker-density-at-least-${PDF_NOTE_CITATION_DENSITY_THRESHOLD}`,
          'no-footnote-band',
          'no-matching-note-body',
        ],
      )
    }
    if (
      citationEvidence &&
      (candidate.syntax === 'superscript-syntax' ||
        candidate.syntax === 'rendered-superscript-geometry')
    ) {
      return classification(
        candidate,
        'superscript-bibliography-citation',
        'citation',
        0.94,
        [
          'reference-list-section-detected',
          `citation-marker-density-at-least-${PDF_NOTE_CITATION_DENSITY_THRESHOLD}`,
          'no-matching-note-body',
        ],
      )
    }

    const samePageFootnotes = matchingBodies.filter(
      (region) =>
        region.kind === 'footnote' && region.page === candidate.region.page,
    )
    if (samePageFootnotes.length > 0) {
      return classification(
        candidate,
        'footnote-reference',
        'note-reference',
        0.97,
        ['matching-note-label', 'same-page-footnote-band'],
      )
    }
    const laterEndnotes = matchingBodies.filter(
      (region) =>
        region.kind === 'endnote' && region.page >= candidate.region.page,
    )
    if (laterEndnotes.length > 0) {
      return classification(
        candidate,
        'endnote-reference',
        'note-reference',
        0.93,
        ['matching-note-label', 'later-endnote-section-scope'],
      )
    }

    return classification(
      candidate,
      'unresolved-note-marker',
      'note-reference',
      candidate.syntax === 'explicit-note-language' ? 0.7 : 0.5,
      [
        'insufficient-reclassification-evidence',
        footnoteBands.length > 0
          ? 'footnote-band-present'
          : 'no-matching-note-body',
      ],
    )
  })

  const counters = new Map<string, number>()
  const classifications = drafts.map<PdfNoteMarkerClassification>((draft) => {
    const page = draft.sourceBox.page
    const idBase = `noteref-p${String(page).padStart(3, '0')}-${markerSlug(draft.label)}-${markerSourceAnchor(draft)}`
    const key = idBase
    const count = (counters.get(key) ?? 0) + 1
    counters.set(key, count)
    return {
      id: `${idBase}-${String(count).padStart(3, '0')}`,
      ...draft,
    }
  })

  return {
    classifications,
    bibliographyRegionIds: [...bibliographyRegionIds],
    noteBodyRegionIds: noteBodies.map((region) => region.id),
  }
}

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
const NOTE_TOKEN = /\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*†‡§]/gu

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

function positionCompare(left: PdfPageRegion, right: PdfPageRegion) {
  return (
    left.page - right.page ||
    left.box.y - right.box.y ||
    left.box.x - right.box.x ||
    left.id.localeCompare(right.id)
  )
}

function sourceBox(region: PdfPageRegion): NormalizedSourceBox {
  return { ...region.box }
}

function labelsFrom(value: string) {
  return [...value.matchAll(NOTE_TOKEN)].map((match) =>
    normalizedNoteLabel(match[0]),
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
    if (
      found.some(
        (candidate) =>
          Math.max(candidate.start, start) < Math.min(candidate.end, end),
      )
    ) {
      return
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
    for (const run of line.runs) {
      const raw = run.text.trim()
      const label = normalizedNoteLabel(raw)
      if (
        !/^(?:\d{1,3}|[*†‡§])$/.test(label) ||
        run.fontSize > largestRun * 0.82
      ) {
        continue
      }
      const withinLine = Math.max(
        line.text.lastIndexOf(raw),
        line.text.lastIndexOf(label),
      )
      if (withinLine < 0) continue
      add(
        [label],
        lineOffset + withinLine,
        lineOffset + withinLine + raw.length,
        'rendered-superscript-geometry',
        {
          page: run.page,
          x: run.x,
          y: run.y,
          width: run.width,
          height: run.height,
          rotation: run.rotation,
          method: run.method,
        },
      )
    }
    lineOffset += line.text.length + 1
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

export function classifyPdfNoteMarkers(
  regions: PdfPageRegion[],
): PdfNoteMarkerClassificationResult {
  const orderedRegions = [...regions].sort(positionCompare)
  const referenceHeadingIndex = orderedRegions.findLastIndex((region) =>
    REFERENCE_HEADING.test(region.text.trim()),
  )
  const referenceSectionEndIndex =
    referenceHeadingIndex < 0
      ? -1
      : orderedRegions.findIndex(
          (region, index) =>
            index > referenceHeadingIndex &&
            REFERENCE_SECTION_END.test(region.text.trim()),
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
  const bibliographyNoteCandidates = orderedRegions
    .filter(
      (region) =>
        bibliographyRegionIds.has(region.id) &&
        (region.kind === 'footnote' || region.kind === 'endnote'),
    )
    .flatMap((region) => {
      const label = noteLabelFromText(region.text)
      if (!label) return []
      const start = Math.max(0, region.text.indexOf(label))
      return [
        {
          label: normalizedNoteLabel(label),
          labels: [normalizedNoteLabel(label)],
          region,
          start,
          end: start + label.length,
          syntax: 'rendered-superscript-geometry' as const,
          sourceBox: sourceBox(region),
        },
      ]
    })
  const candidates = [
    ...ordinaryCandidates,
    ...bibliographyNoteCandidates,
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

    const citationEvidence =
      referenceHeadingIndex >= 0 &&
      citationMarkerDensity >= PDF_NOTE_CITATION_DENSITY_THRESHOLD &&
      noteBodies.length === 0
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
          'no-note-body-region',
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
          'no-note-body-region',
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
    const key = `${page}:${draft.label}`
    const count = (counters.get(key) ?? 0) + 1
    counters.set(key, count)
    return {
      id: `noteref-p${String(page).padStart(3, '0')}-${markerSlug(draft.label)}-${String(count).padStart(3, '0')}`,
      ...draft,
    }
  })

  return {
    classifications,
    bibliographyRegionIds: [...bibliographyRegionIds],
    noteBodyRegionIds: noteBodies.map((region) => region.id),
  }
}

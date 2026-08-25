import { normalizedNoteLabel } from './note-label'
import { furnitureRunKey, marginTextIsNumeralOnly } from './pdf-furniture'
import type { PdfTextLine } from './pdf-lines'
import {
  endsCaptionSentence,
  endsIncompleteWrappedUrl,
  type ClassifiedLine,
} from './pdf-region-captions'

const NOTE_LABEL = String.raw`(?:\d{1,3}|[*†‡§])`

function median(values: number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

function quantile(values: number[], fraction: number) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[
    Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))
  ]
}

export function noteLabelFromText(text: string) {
  const normalized = normalizedNoteLabel(text)
  const attachedSymbolic = normalized.match(/^([*†‡§])/u)
  if (attachedSymbolic) return attachedSymbolic[1]
  const explicit = normalized.match(
    new RegExp(`^(?:footnote|note)\\s+(${NOTE_LABEL})(?:\\s*[:.)-]|\\s+)`, 'i'),
  )
  if (explicit) return explicit[1]
  const leading = normalized.match(
    new RegExp(`^(${NOTE_LABEL})(?:[.)\\]]|\\s+)`),
  )
  return leading?.[1] ?? null
}

const NUMBERED_BODY_SECTION_TITLE =
  /^(?:abstract|introduction|background|related work|literature review|methods?|methodology|approach|framework|experiments?|evaluation|results?|discussion|limitations?|conclusion|references|appendix)\b/iu

function numberedBodySectionHeading(text: string) {
  const match = text.match(
    /^(\d{1,3}(?:\.\d+){0,3})([.)]?)\s+(\p{Lu}[^.,;:!?]{0,99})$/u,
  )
  if (!match) return false
  const [, sectionNumber, markerPunctuation, title] = match
  return (
    sectionNumber.includes('.') ||
    (markerPunctuation === '' && NUMBERED_BODY_SECTION_TITLE.test(title))
  )
}

function fusedNumberedListOrdinal(line: PdfTextLine) {
  const firstRun = line.runs.find((run) => run.text.trim())
  const match = firstRun?.text.match(/^\s*(\d{1,3})\.\s+\S/u)
  return match ? Number(match[1]) : null
}

function sourceSmallCapsTypography(line: PdfTextLine) {
  const letters = line.text.match(/\p{L}/gu) ?? []
  if (
    letters.length < 4 ||
    letters.some((letter) => letter !== letter.toLocaleUpperCase())
  ) {
    return false
  }
  const letterRuns = line.runs.filter(
    (run) => run.text.trim() && /\p{L}/u.test(run.text),
  )
  if (letterRuns.length < 2) return false
  const leadingLetters =
    letterRuns[0].text.match(/\p{L}/gu)?.length ?? Number.POSITIVE_INFINITY
  const largestSize = Math.max(...letterRuns.map((run) => run.fontSize))
  return (
    leadingLetters <= 2 &&
    letterRuns[0].fontSize >= largestSize * 0.95 &&
    letterRuns.slice(1).some((run) => run.fontSize <= largestSize * 0.9)
  )
}

function sourceStyledBoundaryHeadingLine(
  lines: readonly PdfTextLine[],
  lineIndex: number,
  bodySize: number,
) {
  const line = lines[lineIndex]
  const text = line.text.replace(/\s+/gu, ' ').trim()
  const letters = text.match(/\p{L}/gu) ?? []
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? []
  if (
    text.length > 96 ||
    letters.length < 4 ||
    words.length === 0 ||
    words.length > 10 ||
    letters.some((letter) => letter !== letter.toLocaleUpperCase()) ||
    /(?:https?:\/\/|www\.|\S*[_@]\S*|(?:\.\s*){3,})/iu.test(text)
  ) {
    return false
  }
  const emphasized =
    line.runs.some(
      (run) =>
        run.bold === true ||
        /(?:bold|semibold|demi|medi(?:um)?|black)/iu.test(run.fontName) ||
        /(?:^|[+,._\s-])cm(?:bx|b)(?:ti|sl)?\d*(?=$|[+,._\s-])/iu.test(
          run.fontName,
        ) ||
        /(?:^|[+,._\s-])lin(?:biolinum|libertine)t?b(?:i)?(?=$|[+,._\s-])/iu.test(
          run.fontName,
        ),
    ) ||
    sourceSmallCapsTypography(line) ||
    line.fontSize >= bodySize * 1.12
  if (!emphasized) return false

  const contentLike = (candidate: PdfTextLine) =>
    candidate.text.trim().length >= 40 &&
    candidate.width >= Math.max(0.3, line.width * 1.35) &&
    Math.abs(candidate.x - line.x) <= 0.07
  const previous = lines
    .slice(0, lineIndex)
    .reverse()
    .find(
      (candidate) =>
        contentLike(candidate) &&
        candidate.y + candidate.height <= line.y + 0.002,
    )
  const next = lines
    .slice(lineIndex + 1)
    .find(
      (candidate) =>
        contentLike(candidate) && candidate.y >= line.y + line.height - 0.002,
    )
  if (!next) return false
  const lineHeight = Math.max(line.height, 0.008)
  const precedingGap = previous
    ? line.y - (previous.y + previous.height)
    : Number.POSITIVE_INFINITY
  const followingGap = next.y - (line.y + line.height)
  const startsAtPageBoundary = !previous && line.y <= 0.22
  return (
    (startsAtPageBoundary ||
      precedingGap >= Math.max(0.006, lineHeight * 0.45)) &&
    followingGap >= Math.max(0.004, lineHeight * 0.3) &&
    followingGap <= Math.max(0.055, lineHeight * 3.5)
  )
}

function hasApparentNumericNoteReference(
  lines: readonly PdfTextLine[],
  definitionLines: ReadonlySet<PdfTextLine>,
  labels: ReadonlySet<string>,
) {
  const explicitReference = new RegExp(
    String.raw`\b(?:footnote|note(?:\s+reference)?)\s*#?\s*(${[...labels].join('|')})\b`,
    'iu',
  )
  for (const line of lines) {
    if (definitionLines.has(line)) continue
    if (explicitReference.test(normalizedNoteLabel(line.text))) return true
    const runs = line.runs.filter((run) => run.text.trim())
    const largestFont = Math.max(...runs.map((run) => run.fontSize), 0)
    const tallestRun = Math.max(...runs.map((run) => run.height), 0)
    if (
      runs.some(
        (run) =>
          labels.has(normalizedNoteLabel(run.text)) &&
          runs.length > 1 &&
          (run.fontSize <= largestFont * 0.82 ||
            run.height <= tallestRun * 0.82),
      )
    ) {
      return true
    }
  }
  return false
}

/**
 * A compact numbered prompt/list at the bottom of a page can share every
 * coarse feature of a footnote band. Keep only the narrow source-backed case:
 * at least three consecutive dotted items beginning at 1, aligned and set in
 * one fused prose run, with no raised or explicit same-page note reference.
 * Separately typeset note markers and referenced compact note bands therefore
 * remain eligible for normal note classification.
 */
function unreferencedSequentialNumberedListLines(lines: PdfTextLine[]) {
  const candidates = lines
    .flatMap((line) => {
      const ordinal = fusedNumberedListOrdinal(line)
      return ordinal === null ? [] : [{ line, ordinal }]
    })
    .sort(
      (left, right) => left.line.y - right.line.y || left.line.x - right.line.x,
    )
  const sequences: (typeof candidates)[] = []
  let sequence: typeof candidates = []
  const flush = () => {
    if (sequence.length > 0) sequences.push(sequence)
    sequence = []
  }
  for (const candidate of candidates) {
    const previous = sequence.at(-1)
    const fontRatio = previous
      ? Math.max(previous.line.fontSize, candidate.line.fontSize) /
        Math.max(1, Math.min(previous.line.fontSize, candidate.line.fontSize))
      : 1
    if (
      previous &&
      candidate.ordinal === previous.ordinal + 1 &&
      candidate.line.y - previous.line.y <=
        Math.max(0.06, previous.line.height * 5) &&
      Math.abs(candidate.line.x - previous.line.x) <=
        Math.max(0.012, previous.line.height) &&
      fontRatio <= 1.08
    ) {
      sequence.push(candidate)
    } else {
      flush()
      sequence = [candidate]
    }
  }
  flush()

  const bodyListLines = new Set<PdfTextLine>()
  for (const candidateSequence of sequences) {
    if (candidateSequence.length < 3 || candidateSequence[0].ordinal !== 1) {
      continue
    }
    const definitionLines = new Set(
      candidateSequence.map((candidate) => candidate.line),
    )
    const labels = new Set(
      candidateSequence.map((candidate) => String(candidate.ordinal)),
    )
    if (hasApparentNumericNoteReference(lines, definitionLines, labels)) {
      continue
    }
    for (const candidate of candidateSequence) {
      bodyListLines.add(candidate.line)
    }
  }
  return bodyListLines
}

function bodyFontSize(lines: PdfTextLine[]) {
  const central = lines.filter(
    (line) => line.y > 0.1 && line.y + line.height < 0.9,
  )
  const prose = central.filter(
    (line) =>
      line.width >= 0.25 && (line.text.match(/\p{L}{2,}/gu)?.length ?? 0) >= 3,
  )
  // Dense plots and diagrams can contribute hundreds of tiny label lines and
  // overwhelm a page-wide font quantile. Prefer repeated, wide prose evidence
  // whenever it exists so genuine bottom notes are compared with the document
  // body rather than with chart ticks.
  const population =
    prose.length >= 2 ? prose : central.length > 0 ? central : lines
  const sizes = population
    .map((line) => line.fontSize)
    .filter((size) => size > 0)
  return quantile(sizes, 0.75) || median(sizes) || 12
}

type NoteLineClassificationEvidence = {
  label: string | null
  explicitFootnote: boolean
  symbolicFootnote: boolean
  renderedFootnote: boolean
}

function hasCompactStandaloneNoteContinuation(
  marker: PdfTextLine,
  lines: readonly PdfTextLine[],
  bodyFontSize: number,
) {
  const normalizedMarker = normalizedNoteLabel(marker.text)
  if (
    !/^\d{1,3}$/u.test(normalizedMarker) ||
    !marginTextIsNumeralOnly(normalizedMarker)
  ) {
    return false
  }
  const markerBottom = marker.y + marker.height
  const fontTolerance = Math.max(0.6, marker.fontSize * 0.08)
  return lines.some((candidate) => {
    if (candidate === marker || candidate.page !== marker.page) return false
    const normalizedCandidate = normalizedNoteLabel(candidate.text)
    const gap = candidate.y - markerBottom
    return (
      gap >= -0.002 &&
      gap <= Math.max(0.012, marker.height) &&
      Math.abs(candidate.x - marker.x) <= 0.04 &&
      Math.abs(candidate.fontSize - marker.fontSize) <= fontTolerance &&
      candidate.fontSize >= 5 &&
      candidate.fontSize <= bodyFontSize * 0.9 + 0.01 &&
      candidate.y + candidate.height >= 0.92 &&
      !marginTextIsNumeralOnly(normalizedCandidate) &&
      (normalizedCandidate.match(/\p{L}{2,}/gu)?.length ?? 0) >= 2
    )
  })
}

function noteLineClassificationEvidence(
  line: PdfTextLine,
  fontSize: number,
  lowerBand: number,
  numberedBodyListLines: ReadonlySet<PdfTextLine>,
  pageLines: readonly PdfTextLine[],
): NoteLineClassificationEvidence {
  const normalized = normalizedNoteLabel(line.text)
  const standaloneNoteContinuation = hasCompactStandaloneNoteContinuation(
    line,
    pageLines,
    fontSize,
  )
  const label =
    noteLabelFromText(normalized) ??
    (standaloneNoteContinuation ? normalized : null)
  const explicitFootnote = new RegExp(
    `^(?:footnote|note)\\s+${NOTE_LABEL}`,
    'i',
  ).test(normalized)
  const symbolicFootnote = /^[*†‡§]/u.test(normalized)
  const substantiveRuns = line.runs.filter((run) => run.text.trim())
  const monospacedNumberedContent =
    !symbolicFootnote &&
    /^\d{1,3}(?:[.)\]]|\s)/u.test(normalized) &&
    substantiveRuns.length > 0 &&
    substantiveRuns.every((run) =>
      /(?:courier|inconsolata|nimbusmon|mono|typewriter|cmtt|lmtt|sftt)/iu.test(
        run.fontName,
      ),
    )
  // Decimal-leading lower-band content is overwhelmingly a plot tick, metric
  // row, or table cell, not an integer-labeled note body. Integer-only labels
  // remain eligible because a genuine footnote may place its marker on a line
  // of its own.
  const decimalTabularContent = /^[-+]?\d+[.,]\d/u.test(normalized)
  const isolatedMarginFolio =
    substantiveRuns.length > 0 &&
    substantiveRuns.every((run) =>
      marginTextIsNumeralOnly(run.text.normalize('NFKC').trim()),
    ) &&
    (line.y <= 0.08 || line.y + line.height >= 0.92) &&
    !standaloneNoteContinuation
  const renderedFootnote =
    label !== null &&
    !decimalTabularContent &&
    !isolatedMarginFolio &&
    !monospacedNumberedContent &&
    !numberedBodyListLines.has(line) &&
    !numberedBodySectionHeading(normalized) &&
    line.y + line.height >= lowerBand &&
    line.fontSize >= 5 &&
    line.fontSize <= fontSize * (symbolicFootnote ? 0.96 : 0.9) + 0.01
  return {
    label,
    explicitFootnote,
    symbolicFootnote,
    renderedFootnote,
  }
}

/**
 * Footnote ownership is resolved before furniture. This hand-off is
 * geometry- and marker-based; it deliberately has no journal or keyword
 * allowlist. Any source run in a note-owned line is deferred to the note
 * stratum, so a repeated lower band cannot hide a genuine note body.
 */
function noteStratumRunKeys(lines: readonly PdfTextLine[]) {
  const pageFontSize = bodyFontSize([...lines])
  const numberedBodyListLines = unreferencedSequentialNumberedListLines([
    ...lines,
  ])
  const lowerBand = quantile(
    lines.map((line) => line.y + line.height),
    0.65,
  )
  const orderedLines = [...lines].sort(
    (left, right) => left.y - right.y || left.x - right.x,
  )
  const keys = new Set<string>()
  const noteSeeds = orderedLines.filter((line) => {
    const evidence = noteLineClassificationEvidence(
      line,
      pageFontSize,
      lowerBand,
      numberedBodyListLines,
      lines,
    )
    return evidence.explicitFootnote || evidence.renderedFootnote
  })
  for (const seed of noteSeeds) {
    for (const run of seed.runs) {
      if (run.text.trim()) keys.add(furnitureRunKey(run))
    }
    let previous = seed
    while (
      !endsCaptionSentence(previous.text) ||
      endsIncompleteWrappedUrl(previous.text)
    ) {
      const candidate = orderedLines
        .filter((line) => {
          if (
            line.page !== seed.page ||
            line === seed ||
            line.y <= previous.y ||
            noteLabelFromText(line.text) !== null
          ) {
            return false
          }
          const verticalGap = line.y - (previous.y + previous.height)
          const fontTolerance = Math.max(0.6, seed.fontSize * 0.08)
          return (
            verticalGap <= Math.max(0.008, seed.height * 0.8) &&
            Math.abs(line.x - seed.x) <= 0.04 &&
            Math.abs(line.fontSize - seed.fontSize) <= fontTolerance
          )
        })
        .sort(
          (left, right) =>
            left.y - right.y ||
            Math.abs(left.x - seed.x) - Math.abs(right.x - seed.x),
        )[0]
      if (!candidate) break
      previous = candidate
      for (const run of candidate.runs) {
        if (run.text.trim()) keys.add(furnitureRunKey(run))
      }
    }
  }
  return keys
}

function spread(values: number[]) {
  return values.length < 2 ? 0 : Math.max(...values) - Math.min(...values)
}

function distinctLines(values: ClassifiedLine[]): ClassifiedLine[] {
  return [...new Set(values)]
}

function alignedBandCount(
  members: Array<{ left: ClassifiedLine; right: ClassifiedLine }>,
) {
  const centers = members
    .map(
      ({ left, right }) =>
        (left.y + left.height / 2 + right.y + right.height / 2) / 2,
    )
    .sort((left, right) => left - right)
  const bands: number[] = []
  for (const center of centers) {
    if (bands.every((candidate) => Math.abs(candidate - center) > 0.012)) {
      bands.push(center)
    }
  }
  return bands.length
}

function maximumVerticalGap(lines: ClassifiedLine[]) {
  const ordered = distinctLines(lines).sort(
    (left, right) => left.y - right.y || left.x - right.x,
  )
  if (ordered.length < 2) return Number.POSITIVE_INFINITY
  return Math.max(
    ...ordered.slice(1).map((line, index) => {
      const previous = ordered[index]
      return line.y - (previous.y + previous.height)
    }),
  )
}

function dominantIndent(lines: ClassifiedLine[]) {
  const clusters = lines.map((seed) => {
    const members = lines.filter((line) => Math.abs(line.x - seed.x) <= 0.04)
    return {
      members,
      x: median(members.map((line) => line.x)),
    }
  })
  return clusters.sort(
    (left, right) =>
      right.members.length - left.members.length || left.x - right.x,
  )[0]
}

function preclassifyMarginNotes(
  lines: ClassifiedLine[],
  pageBodyFontSize: number,
) {
  const body = lines.filter((line) => line.kind === 'body')
  const dominant = dominantIndent(body)
  if (!dominant || dominant.members.length < 2) return
  for (const line of body) {
    if (line.furnitureReview) continue
    if (dominant.members.includes(line)) continue
    const alignedWithBody = dominant.members.some((candidate) => {
      const lineCenter = line.y + line.height / 2
      const candidateCenter = candidate.y + candidate.height / 2
      return (
        Math.abs(lineCenter - candidateCenter) <=
        Math.max(0.012, line.height, candidate.height)
      )
    })
    if (
      alignedWithBody &&
      line.fontSize <= pageBodyFontSize * 0.85 &&
      line.width <= 0.25 &&
      line.text.length <= 120 &&
      Math.abs(line.x - dominant.x) >= 0.18
    ) {
      line.kind = 'side'
      line.confidence = 0.9
    }
  }
}

function sourceRaisedFrontMatterAffiliation(line: ClassifiedLine) {
  if (line.page !== 1 || line.y >= 0.32) return false
  const runs = line.runs.filter((run) => run.text.trim())
  const marker = runs[0]
  const institution = runs[1]
  if (
    !marker ||
    !institution ||
    !/^\d{1,3}(?:,\d{1,3})*$/u.test(marker.text.trim()) ||
    !/(?:university|institute|department|laborator(?:y|ies)|school|college|centre|center|hospital|academy|technolog(?:y|ies))/iu.test(
      runs
        .slice(1)
        .map((run) => run.text)
        .join(' '),
    )
  ) {
    return false
  }
  const markerCenter = marker.y + marker.height / 2
  const institutionCenter = institution.y + institution.height / 2
  const horizontalGap = institution.x - (marker.x + marker.width)
  return (
    marker.fontSize <= institution.fontSize * 0.92 + 0.01 &&
    markerCenter <=
      institutionCenter - Math.max(0.0005, institution.height * 0.18) &&
    horizontalGap >= -0.001 &&
    horizontalGap <= 0.012
  )
}

export {
  alignedBandCount,
  bodyFontSize,
  distinctLines,
  maximumVerticalGap,
  median,
  noteLineClassificationEvidence,
  noteStratumRunKeys,
  preclassifyMarginNotes,
  quantile,
  sourceRaisedFrontMatterAffiliation,
  sourceStyledBoundaryHeadingLine,
  spread,
  unreferencedSequentialNumberedListLines,
}

import type {
  PdfLineBoundaryDecision,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfRegionLine,
  PdfSourceRun,
} from './import-types'
import { normalizePdfTextSequence } from './pdf-font-text'
import {
  registerPdfLinkedTokenSourceAnnotations,
  resolveRegisteredPdfLinkedTokenContinuity,
} from './pdf-links'

export type PdfTextLine = {
  id?: string
  page: number
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
  runs: PdfSourceRun[]
  column: 'single' | 'left' | 'right' | 'span'
  sourceOwnedColumn?: 'left' | 'right'
}

type PdfLineJoinOptions = {
  hardHyphenLexicon?: ReadonlySet<string>
  unhyphenatedLexicon?: ReadonlySet<string>
  regionId?: string
  decisions?: PdfLineBoundaryDecision[]
}

const MAX_LINE_JOIN_REVIEW_CHARACTERS = 240

export type PdfLineJoinReviewContext = {
  identity: {
    transitionId: string
    regionId: string
    fromLineId: string
    toLineId: string
  }
  page: number
  from: Pick<PdfRegionLine, 'id' | 'text' | 'fontSize' | 'box'> & {
    truncated: boolean
  }
  to: Pick<PdfRegionLine, 'id' | 'text' | 'fontSize' | 'box'> & {
    truncated: boolean
  }
  evidence: string[]
}

function boundedReviewLine(
  line: PdfRegionLine,
  edge: 'start' | 'end',
): PdfLineJoinReviewContext['from'] {
  const text = line.text.trim()
  const truncated = text.length > MAX_LINE_JOIN_REVIEW_CHARACTERS
  const boundedText = !truncated
    ? text
    : edge === 'end'
      ? `…${text.slice(-(MAX_LINE_JOIN_REVIEW_CHARACTERS - 1))}`
      : `${text.slice(0, MAX_LINE_JOIN_REVIEW_CHARACTERS - 1)}…`
  return {
    id: line.id,
    text: boundedText,
    fontSize: line.fontSize,
    box: { ...line.box },
    truncated,
  }
}

export function buildPdfLineJoinReviewContext(
  region: PdfPageRegion,
  decision: PdfLineBoundaryDecision,
): PdfLineJoinReviewContext | null {
  if (
    region.id !== decision.regionId ||
    region.page !== decision.page ||
    decision.outcome !== 'unresolved'
  ) {
    return null
  }
  const fromIndex = region.lines.findIndex(
    (line) => line.id === decision.fromLineId,
  )
  const toIndex = region.lines.findIndex(
    (line) => line.id === decision.toLineId,
  )
  if (fromIndex < 0 || toIndex !== fromIndex + 1) return null

  const from = region.lines[fromIndex]
  const to = region.lines[toIndex]
  if (from.box.page !== decision.page || to.box.page !== decision.page) {
    return null
  }
  return {
    identity: {
      transitionId: decision.id,
      regionId: decision.regionId,
      fromLineId: decision.fromLineId,
      toLineId: decision.toLineId,
    },
    page: decision.page,
    from: boundedReviewLine(from, 'end'),
    to: boundedReviewLine(to, 'start'),
    evidence: [...decision.evidence],
  }
}

export type PdfRegionLineReplay = {
  text: string
  ranges: Map<string, { start: number; end: number }>
}

export function replayPdfRegionLineRanges(
  region: PdfPageRegion,
  decisions: readonly PdfLineBoundaryDecision[],
): PdfRegionLineReplay | null {
  if (
    new Set(region.lines.map((line) => line.id)).size !== region.lines.length
  ) {
    return null
  }
  const byTransition = new Map(
    decisions
      .filter((decision) => decision.regionId === region.id)
      .map((decision) => [
        `${decision.fromLineId}\u0000${decision.toLineId}`,
        decision,
      ]),
  )
  if (byTransition.size !== Math.max(region.lines.length - 1, 0)) return null

  const normalizedLineText = (value: string) =>
    value.replace(/\s+/g, ' ').trim()
  let text = normalizedLineText(region.lines[0]?.text ?? '')
  const ranges = new Map<string, { start: number; end: number }>()
  if (region.lines[0]) {
    ranges.set(region.lines[0].id, { start: 0, end: text.length })
  }
  for (let index = 1; index < region.lines.length; index += 1) {
    const previous = region.lines[index - 1]
    const current = region.lines[index]
    const decision = byTransition.get(`${previous.id}\u0000${current.id}`)
    const next = normalizedLineText(current.text)
    if (
      !decision ||
      decision.page !== region.page ||
      decision.fromLineId !== previous.id ||
      decision.toLineId !== current.id
    ) {
      return null
    }
    let start = text.length
    if (decision.outcome === 'space') {
      start += 1
      text += ` ${next}`
    } else if (decision.outcome === 'no-space') {
      text += next
    } else if (decision.outcome === 'removed-discretionary-hyphen') {
      if (!/[-‐‑\u00ad]$/u.test(text)) return null
      const previousRange = ranges.get(previous.id)
      if (!previousRange || previousRange.end !== text.length) return null
      text = `${text.slice(0, -1)}${next}`
      previousRange.end -= 1
      start -= 1
    } else {
      if (!/[-‐‑]$/u.test(text)) return null
      text += next
    }
    ranges.set(current.id, { start, end: start + next.length })
  }
  return { text, ranges }
}

export function replayPdfRegionLineText(
  region: PdfPageRegion,
  decisions: readonly PdfLineBoundaryDecision[],
) {
  return replayPdfRegionLineRanges(region, decisions)?.text ?? null
}

function normalizedHyphenatedWord(value: string) {
  return value.normalize('NFKC').replace(/[‐‑]/g, '-').toLocaleLowerCase()
}

export function inlineHardHyphenLexicon(
  lines: readonly Pick<PdfTextLine, 'text'>[],
) {
  const words = new Set<string>()
  for (const line of lines) {
    for (const match of line.text.matchAll(
      /[\p{L}\p{N}]+[-‐‑][\p{L}\p{N}]+/gu,
    )) {
      words.add(normalizedHyphenatedWord(match[0]))
    }
  }
  return words
}

export function inlineUnhyphenatedLexicon(
  lines: readonly Pick<PdfTextLine, 'text'>[],
) {
  const words = new Set<string>()
  for (const line of lines) {
    for (const match of line.text.matchAll(/[\p{L}\p{N}]+/gu)) {
      words.add(match[0].normalize('NFKC').toLocaleLowerCase())
    }
  }
  return words
}

function boundaryFragments(lines: PdfTextLine[], index: number) {
  const previous = lines[index - 1]
  const next = lines[index]
  const left = previous.text.trim().match(/([\p{L}\p{N}]+)[-‐‑]$/u)?.[1]
  const right = next.text.trim().match(/^([\p{L}\p{N}]+)/u)?.[1]
  return left && right ? { left, right } : null
}

function hyphenatedBoundaryWord(lines: PdfTextLine[], index: number) {
  const fragments = boundaryFragments(lines, index)
  return fragments
    ? normalizedHyphenatedWord(`${fragments.left}-${fragments.right}`)
    : null
}

function unhyphenatedBoundaryWord(lines: PdfTextLine[], index: number) {
  const fragments = boundaryFragments(lines, index)
  return fragments
    ? `${fragments.left}${fragments.right}`
        .normalize('NFKC')
        .toLocaleLowerCase()
    : null
}

function inflectionalFamily(word: string) {
  const stems = new Set([word])
  if (word.endsWith('s') && word.length > 4) stems.add(word.slice(0, -1))
  if (word.endsWith('es') && word.length > 5) stems.add(word.slice(0, -2))
  if (word.endsWith('ed') && word.length > 5) {
    stems.add(word.slice(0, -2))
    stems.add(word.slice(0, -1))
  }
  if (word.endsWith('ing') && word.length > 6) {
    stems.add(word.slice(0, -3))
    stems.add(`${word.slice(0, -3)}e`)
  }
  if (word.endsWith('ies') && word.length > 5) {
    stems.add(`${word.slice(0, -3)}y`)
  }
  if (word.endsWith('ied') && word.length > 5) {
    stems.add(`${word.slice(0, -3)}y`)
  }
  if (word.endsWith('tion') && word.length > 7) {
    stems.add(word.slice(0, -3))
  }
  const family = new Set<string>()
  for (const stem of stems) {
    family.add(stem)
    for (const suffix of ['s', 'es', 'ed', 'ing']) {
      family.add(`${stem}${suffix}`)
    }
    if (stem.endsWith('e')) {
      family.add(`${stem}d`)
      family.add(`${stem.slice(0, -1)}ing`)
    }
    if (stem.endsWith('y')) {
      family.add(`${stem.slice(0, -1)}ied`)
      family.add(`${stem.slice(0, -1)}ies`)
    }
  }
  if (word.endsWith('ive') && word.length > 6) {
    family.add(`${word.slice(0, -1)}ity`)
  }
  if (word.endsWith('ivity') && word.length > 8) {
    family.add(`${word.slice(0, -3)}e`)
  }
  family.delete(word)
  return family
}

function hasSameDocumentInflection(
  word: string | null,
  lexicon: ReadonlySet<string>,
) {
  return Boolean(
    word && [...inflectionalFamily(word)].some((form) => lexicon.has(form)),
  )
}

function derivationalFamily(word: string) {
  const suffixes = [
    'izations',
    'ization',
    'izing',
    'ized',
    'izes',
    'ize',
    'ally',
    'al',
  ] as const
  const root = suffixes
    .filter((suffix) => word.endsWith(suffix))
    .map((suffix) => word.slice(0, -suffix.length))
    .find((candidate) => candidate.length >= 5)
  if (!root) return new Set<string>()
  const family = new Set(suffixes.map((suffix) => `${root}${suffix}`))
  family.delete(word)
  return family
}

function hasSameDocumentDerivation(
  word: string | null,
  lexicon: ReadonlySet<string>,
) {
  return Boolean(
    word && [...derivationalFamily(word)].some((form) => lexicon.has(form)),
  )
}

function sourcePreservationEvidence(lines: PdfTextLine[], index: number) {
  const previous = lines[index - 1]
  const next = lines[index]
  if (!previous || !next || previous.page !== next.page) return null
  const fragments = boundaryFragments(lines, index)
  if (!fragments) return null
  if (/^\p{N}+$/u.test(fragments.left) && /^\p{N}+$/u.test(fragments.right)) {
    return 'numeric-hyphen-boundary'
  }
  return null
}

function urlLiteralHyphenBoundary(lines: PdfTextLine[], index: number) {
  const previous = lines[index - 1]
  const next = lines[index]
  return Boolean(
    previous &&
    next &&
    previous.page === next.page &&
    /(?:https?:\/\/|www\.)\S+[-‐‑]$/iu.test(previous.text.trim()) &&
    /^[^\s<>"'`]+/u.test(next.text.trim()),
  )
}

function boundaryDecision(
  lines: PdfTextLine[],
  index: number,
  outcome: PdfLineBoundaryDecision['outcome'],
  evidence: string[],
  options: PdfLineJoinOptions,
) {
  if (!options.decisions) return
  const previous = lines[index - 1]
  const next = lines[index]
  const fromLineId = previous.id ?? `line-${String(index).padStart(4, '0')}`
  const toLineId = next.id ?? `line-${String(index + 1).padStart(4, '0')}`
  options.decisions.push({
    id: `line-boundary-p${String(previous.page).padStart(3, '0')}-${fromLineId}-${toLineId}`,
    page: previous.page,
    regionId: options.regionId ?? 'unassigned-region',
    fromLineId,
    toLineId,
    outcome,
    evidence,
  })
}

export function joinPdfLineTexts(
  lines: PdfTextLine[],
  options: PdfLineJoinOptions = {},
) {
  let joined = ''
  const linkedTokenContinuities =
    resolveRegisteredPdfLinkedTokenContinuity(lines)
  const hardHyphenLexicon = options.hardHyphenLexicon ?? new Set<string>()
  const unhyphenatedLexicon = options.unhyphenatedLexicon ?? new Set<string>()
  for (const [index, line] of lines.entries()) {
    const next = line.text.trim()
    if (!next) continue
    if (!joined) {
      joined = next
      continue
    }
    const boundaryContinuities = linkedTokenContinuities.filter(
      (candidate) =>
        candidate.fromLineIndex === index - 1 &&
        candidate.toLineIndex === index &&
        candidate.fromText === lines[index - 1].text &&
        candidate.toText === line.text,
    )
    const targetPrefixContinuity =
      boundaryContinuities.length === 1 &&
      boundaryContinuities[0].status === 'unresolved' &&
      boundaryContinuities[0].reason === 'url-round-trip-failed' &&
      !joined.includes(boundaryContinuities[0].target) &&
      boundaryContinuities[0].visibleText.startsWith(
        boundaryContinuities[0].target,
      ) &&
      /^[,.;:!?)}\]\s]/u.test(
        boundaryContinuities[0].visibleText.slice(
          boundaryContinuities[0].target.length,
        ),
      )
        ? boundaryContinuities[0]
        : null
    if (targetPrefixContinuity) {
      boundaryDecision(
        lines,
        index,
        'no-space',
        [
          'same-normalized-link-target',
          'source-link-geometry',
          'visible-url-target-prefix',
        ],
        options,
      )
      joined += next
      continue
    }
    if (boundaryContinuities.length > 0) {
      const matched = boundaryContinuities.filter(
        (candidate) => candidate.status === 'matched',
      )
      if (boundaryContinuities.length === 1 && matched.length === 1) {
        boundaryDecision(lines, index, 'no-space', matched[0].evidence, options)
        joined += next
        continue
      }
      if (!/[-‐‑\u00ad]$/u.test(joined)) {
        boundaryDecision(
          lines,
          index,
          'space',
          [
            'ordinary-wrap',
            'unresolved-linked-token-continuity',
            boundaryContinuities.some(
              (candidate) => candidate.reason === 'url-round-trip-failed',
            )
              ? 'url-round-trip-failed'
              : 'ambiguous-source-geometry',
          ],
          options,
        )
        joined += ` ${next}`
        continue
      }
    }
    if (joined.endsWith('\u00ad')) {
      boundaryDecision(
        lines,
        index,
        'removed-discretionary-hyphen',
        ['explicit-soft-hyphen'],
        options,
      )
      joined = `${joined.slice(0, -1)}${next}`
      continue
    }
    if (/[-‐‑]$/u.test(joined)) {
      const candidate = hyphenatedBoundaryWord(lines, index)
      const sourcePreservation = sourcePreservationEvidence(lines, index)
      const unhyphenatedCandidate = unhyphenatedBoundaryWord(lines, index)
      if (candidate && hardHyphenLexicon.has(candidate)) {
        boundaryDecision(
          lines,
          index,
          'preserved-lexical-hyphen',
          ['same-document-lexical-hyphen'],
          options,
        )
        joined += next
      } else if (urlLiteralHyphenBoundary(lines, index)) {
        boundaryDecision(
          lines,
          index,
          'preserved-lexical-hyphen',
          ['url-literal-hyphen'],
          options,
        )
        joined += next
      } else if (sourcePreservation) {
        boundaryDecision(
          lines,
          index,
          'preserved-lexical-hyphen',
          [sourcePreservation],
          options,
        )
        joined += next
      } else if (
        unhyphenatedCandidate &&
        unhyphenatedLexicon.has(unhyphenatedCandidate)
      ) {
        boundaryDecision(
          lines,
          index,
          'removed-discretionary-hyphen',
          ['same-document-unhyphenated-word'],
          options,
        )
        joined = `${joined.slice(0, -1)}${next}`
      } else if (
        hasSameDocumentInflection(unhyphenatedCandidate, unhyphenatedLexicon)
      ) {
        boundaryDecision(
          lines,
          index,
          'removed-discretionary-hyphen',
          ['same-document-inflectional-word'],
          options,
        )
        joined = `${joined.slice(0, -1)}${next}`
      } else if (
        hasSameDocumentDerivation(unhyphenatedCandidate, unhyphenatedLexicon)
      ) {
        boundaryDecision(
          lines,
          index,
          'removed-discretionary-hyphen',
          ['same-document-derivational-word'],
          options,
        )
        joined = `${joined.slice(0, -1)}${next}`
      } else {
        boundaryDecision(
          lines,
          index,
          'unresolved',
          ['insufficient-hyphen-evidence', 'source-form-preserved'],
          options,
        )
        joined += next
      }
      continue
    }
    const wrappedTopLevelDomain =
      /(?:https?:\/\/|www\.)\S+\.$/iu.test(joined) &&
      /^[A-Za-z]{2,24}[/?#]/u.test(next)
    const wrappedUrlPath =
      /(?:https?:\/\/|www\.)\S+\/$/iu.test(joined) &&
      /^\S+$/u.test(next) &&
      /\//u.test(next)
    if (wrappedTopLevelDomain || wrappedUrlPath) {
      boundaryDecision(
        lines,
        index,
        'no-space',
        ['wrapped-url-continuation'],
        options,
      )
      joined += next
      continue
    }
    if (/^[,.;:!?%)}\]]/.test(next)) {
      boundaryDecision(
        lines,
        index,
        'no-space',
        ['continuation-punctuation'],
        options,
      )
      joined += next
      continue
    }
    if (/[“‘«]$/u.test(joined)) {
      boundaryDecision(
        lines,
        index,
        'no-space',
        ['opening-delimiter-continuation'],
        options,
      )
      joined += next
      continue
    }
    if (/^[”’»]/u.test(next)) {
      boundaryDecision(
        lines,
        index,
        'no-space',
        ['closing-delimiter-continuation'],
        options,
      )
      joined += next
      continue
    }
    boundaryDecision(lines, index, 'space', ['ordinary-wrap'], options)
    joined += ` ${next}`
  }
  return joined.replace(/\s+/g, ' ').trim()
}

function restoreCollapsedSentenceBoundarySpacing(text: string) {
  return text
    .replace(/(^|[\s([{])(\p{Lu})\.(?=\p{Lu}\p{Ll}+(?:\s|$))/gu, '$1$2. ')
    .replace(
      /([\p{L}\p{N})\]])\.(?=(?:A|An|The|This|That|These|Those|I|We|You|He|She|It|They|Our|Their|Previous|Prior|Recent|Existing|Other|Another|However|Therefore|Thus|Moreover|Furthermore|Consequently|Meanwhile|In|On|At|For|From|By|As|Although|While|When|After|Before|Experiments|Results|Specifically|Finally)\s)/gu,
      '$1. ',
    )
}

export function mergePdfRunText(runs: PdfSourceRun[]) {
  let text = ''
  let previous: PdfSourceRun | undefined
  for (const run of runs) {
    const word = run.text.trim()
    if (!word) continue
    const gap = previous
      ? run.x - (previous.x + previous.width)
      : Number.POSITIVE_INFINITY
    const raisedLeadingMarker =
      previous !== undefined &&
      text === previous.text.trim() &&
      /^(?:\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹]+|[*†‡§]+)$/u.test(text) &&
      previous.fontSize <= run.fontSize * 0.85 &&
      previous.y + previous.height / 2 <
        run.y + run.height / 2 - Math.max(0.0005, run.height * 0.04)
    const sourceWhitespaceMatchesPredecessor =
      run.sourceWhitespaceBefore === 'pdf-text-item' &&
      previous?.sourceSequenceIndex === run.sourceWhitespacePredecessorIndex
    const needsSpace =
      text.length > 0 &&
      !/^[,.;:!?%)}\]]/.test(word) &&
      !/[({[]$/.test(text) &&
      (sourceWhitespaceMatchesPredecessor ||
        raisedLeadingMarker ||
        gap > Math.max(0.0015, run.height * 0.08))
    text += `${needsSpace ? ' ' : ''}${word}`
    previous = run
  }
  return restoreCollapsedSentenceBoundarySpacing(
    normalizePdfTextSequence(text.replace(/\s+/g, ' ').trim()),
  )
}

function expandLineBounds(
  target: PdfTextLine,
  source: Pick<PdfTextLine, 'x' | 'y' | 'width' | 'height'>,
) {
  const left = Math.min(target.x, source.x)
  const top = Math.min(target.y, source.y)
  const right = Math.max(target.x + target.width, source.x + source.width)
  const bottom = Math.max(target.y + target.height, source.y + source.height)
  target.x = left
  target.y = top
  target.width = right - left
  target.height = bottom - top
}

function crossesProbableColumnGutter(
  line: PdfTextLine,
  run: PdfSourceRun,
  horizontalGap: number,
  gutterCenter: number | null,
) {
  if (
    horizontalGap < Math.max(0.02, Math.min(line.height, run.height) * 0.65)
  ) {
    return false
  }
  if (
    gutterCenter === null &&
    line.runs.length === 1 &&
    emphasizedProseRun(line.runs[0]) !== emphasizedProseRun(run)
  ) {
    return false
  }
  const combinedText = [...line.runs, run]
    .sort((left, right) => left.x - right.x)
    .map((candidate) => candidate.text.trim())
    .filter(Boolean)
    .join(' ')
  if (beginsVisualCaptionText(combinedText)) {
    return false
  }
  const lineRight = line.x + line.width
  const runRight = run.x + run.width
  const leftRight = line.x <= run.x ? lineRight : runRight
  const rightLeft = line.x <= run.x ? run.x : line.x
  const gapCenter = (leftRight + rightLeft) / 2
  const combinedWidth = Math.max(lineRight, runRight) - Math.min(line.x, run.x)
  return gutterCenter === null
    ? gapCenter >= 0.35 && gapCenter <= 0.65 && combinedWidth >= 0.55
    : Math.abs(gapCenter - gutterCenter) <= 0.03
}

function horizontalGap(
  left: Pick<PdfTextLine, 'x' | 'width'>,
  right: Pick<PdfSourceRun, 'x' | 'width'>,
) {
  return Math.max(
    left.x - (right.x + right.width),
    right.x - (left.x + left.width),
    0,
  )
}

function beginsVisualCaptionText(text: string) {
  return /^(?:(?:fig(?:ure)?|table|eq(?:uation)?)\.?\s*(?:\d+|[ivxlcdm]+)(?:\s*[.:–—-]|\s)|figure\s*[:.–—-])/i.test(
    text.trim(),
  )
}

function mathExtensionRun(run: PdfSourceRun) {
  return /CMEX\d*/iu.test(run.fontName)
}

function inlineMathAccentRun(run: PdfSourceRun) {
  return mathExtensionRun(run) && /^[\p{M}¨¯´¸ˆˇ˘˙˚˜˝]+$/u.test(run.text.trim())
}

const POSITIONED_TEXT_PREFIX_ACCENT = /^[¨¯´¸ˆˇ˘˙˚˜˝]$/u

export function positionedPdfPrefixAccentText(
  accent: PdfSourceRun,
  target: PdfSourceRun,
) {
  const accentText = accent.text.trim()
  const targetText = target.text.trim()
  if (
    !POSITIONED_TEXT_PREFIX_ACCENT.test(accentText) ||
    !/^\p{L}/u.test(targetText) ||
    accent.page !== target.page ||
    accent.rotation !== target.rotation ||
    accent.method !== target.method ||
    accent.fontName !== target.fontName ||
    Boolean(accent.bold) !== Boolean(target.bold) ||
    Boolean(accent.italic) !== Boolean(target.italic)
  ) {
    return null
  }
  const fontRatio =
    Math.max(accent.fontSize, target.fontSize) /
    Math.max(0.001, Math.min(accent.fontSize, target.fontSize))
  const heightRatio =
    Math.max(accent.height, target.height) /
    Math.max(0.000_001, Math.min(accent.height, target.height))
  const baselineTolerance = Math.max(
    0.0015,
    Math.min(accent.height, target.height) * 0.15,
  )
  const leadingGlyphRight =
    target.x +
    Math.max(target.height * 0.85, Math.min(target.width, accent.width * 1.5))
  const horizontalTolerance = Math.max(
    0.00075,
    Math.min(accent.height, target.height) * 0.08,
  )
  if (
    fontRatio > 1.1 ||
    heightRatio > 1.1 ||
    Math.abs(accent.y - target.y) > baselineTolerance ||
    accent.x < target.x - horizontalTolerance ||
    accent.x + accent.width > leadingGlyphRight
  ) {
    return null
  }
  const normalized = normalizePdfTextSequence(`${accentText}${targetText}`)
  return normalized === `${accentText}${targetText}` ? null : normalized
}

function unresolvedMathExtensionRun(run: PdfSourceRun) {
  return (
    mathExtensionRun(run) &&
    /[\ufffd\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(run.text)
  )
}

function probableFormulaRun(run: PdfSourceRun) {
  const text = run.text.trim()
  const formulaCharacters =
    /^[\p{L}\p{N}()[\]{}.,|+*/=<>_^\-−×÷≤≥≈∼⊙∂∞∏∈∉→←]+$/u.test(text)
  const formulaEvidence = /[+*/=<>_^×÷≤≥≈∼⊙∂∞∏∈∉→←]|\p{Script=Greek}/u.test(
    text,
  )
  return (
    mathExtensionRun(run) ||
    /(?:CMMI|CMSY|MSBM)/iu.test(run.fontName) ||
    (formulaCharacters && formulaEvidence)
  )
}

// Raised glyphs can enlarge a real line, but the union must stay within one
// accepted baseline offset. Otherwise dense diagram labels form a transitive
// vertical chain whose growing box eventually absorbs the rest of the page.
function hasPlausibleLineSpan(
  ...runGroups: ReadonlyArray<readonly PdfSourceRun[]>
) {
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  let tallestRun = 0
  let containsMathExtension = false
  for (const runs of runGroups) {
    for (const run of runs) {
      top = Math.min(top, run.y)
      bottom = Math.max(bottom, run.y + run.height)
      tallestRun = Math.max(tallestRun, run.height)
      containsMathExtension ||= mathExtensionRun(run)
    }
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return false
  const mathExtensionTolerance = containsMathExtension ? 0.0125 : 0
  const maximumBaselineOffset = Math.max(
    0.004,
    tallestRun,
    mathExtensionTolerance,
  )
  return bottom - top <= tallestRun + maximumBaselineOffset
}

function probableColumnProseRun(run: PdfSourceRun) {
  const words = run.text.match(/\p{L}{2,}/gu) ?? []
  return words.length >= 2 && run.width >= 0.12
}

function emphasizedProseRun(run: PdfSourceRun) {
  return Boolean(
    run.bold ||
    /(?:bold|black|demi|semibold|(?:^|[-+,_])medi(?:$|[-+,_]))/i.test(
      run.fontName,
    ),
  )
}

const MIN_OVERPRINT_FONT_RATIO = 1.8
const MIN_OVERPRINT_SOURCE_RUN_DISTANCE = 8
const MIN_HORIZONTAL_OVERPRINT_RATIO = 0.5

function sourceRunOrder(
  run: PdfSourceRun,
  sourceOrder: ReadonlyMap<PdfSourceRun, number>,
) {
  return sourceOrder.get(run) ?? Number.NaN
}

function horizontalRunOverlapRatio(left: PdfSourceRun, right: PdfSourceRun) {
  const overlap = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
  return overlap / Math.max(0.000_001, Math.min(left.width, right.width))
}

function readableLayerEvidence(
  runs: readonly PdfSourceRun[],
  fontSize: number,
) {
  return runs.some((run) => {
    const fontRatio =
      Math.max(run.fontSize, fontSize) /
      Math.max(0.001, Math.min(run.fontSize, fontSize))
    const proseFragment =
      !probableFormulaRun(run) &&
      (run.text.match(/\p{L}/gu)?.length ?? 0) >= 6 &&
      run.width >= 0.05 &&
      /[\s.!?:]/u.test(run.text)
    return (
      fontRatio <= 1.2 &&
      (probableColumnProseRun(run) ||
        beginsVisualCaptionText(run.text) ||
        proseFragment)
    )
  })
}

// Some PDFs emit a diagram's tiny labels first and then paint a full caption
// text layer across the same coordinates. Geometry alone makes those runs look
// like one baseline. Separate them only when typography, substantial horizontal
// overprint, and a non-adjacent source-order layer all agree; ordinary inline
// superscripts and mixed-style text therefore remain grouped.
function containsCompetingTextLayers(
  leftRuns: readonly PdfSourceRun[],
  rightRuns: readonly PdfSourceRun[],
  sourceOrder: ReadonlyMap<PdfSourceRun, number>,
) {
  return leftRuns.some((left) =>
    rightRuns.some((right) => {
      const fontRatio =
        Math.max(left.fontSize, right.fontSize) /
        Math.max(0.001, Math.min(left.fontSize, right.fontSize))
      if (
        fontRatio < MIN_OVERPRINT_FONT_RATIO ||
        horizontalRunOverlapRatio(left, right) < MIN_HORIZONTAL_OVERPRINT_RATIO
      ) {
        return false
      }
      const leftOrder = sourceRunOrder(left, sourceOrder)
      const rightOrder = sourceRunOrder(right, sourceOrder)
      if (
        !Number.isFinite(leftOrder) ||
        !Number.isFinite(rightOrder) ||
        Math.abs(leftOrder - rightOrder) < MIN_OVERPRINT_SOURCE_RUN_DISTANCE
      ) {
        return false
      }
      return left.fontSize > right.fontSize
        ? readableLayerEvidence(leftRuns, left.fontSize)
        : readableLayerEvidence(rightRuns, right.fontSize)
    }),
  )
}

function adjacentTypographyLayer(
  line: PdfTextLine,
  run: PdfSourceRun,
  sourceOrder: ReadonlyMap<PdfSourceRun, number>,
) {
  const fontRatio =
    Math.max(line.fontSize, run.fontSize) /
    Math.max(0.001, Math.min(line.fontSize, run.fontSize))
  if (fontRatio > 1.2) return false
  const runOrder = sourceRunOrder(run, sourceOrder)
  return (
    Number.isFinite(runOrder) &&
    line.runs.some((candidate) => {
      const candidateOrder = sourceRunOrder(candidate, sourceOrder)
      return (
        Number.isFinite(candidateOrder) &&
        Math.abs(candidateOrder - runOrder) <= 4
      )
    })
  )
}

function lineFromSourceRuns(
  source: PdfTextLine,
  runs: readonly PdfSourceRun[],
  sourceOwnedColumn: NonNullable<PdfTextLine['sourceOwnedColumn']>,
) {
  const orderedRuns = [...runs].sort(
    (left, right) => left.x - right.x || left.y - right.y,
  )
  const left = Math.min(...orderedRuns.map((run) => run.x))
  const top = Math.min(...orderedRuns.map((run) => run.y))
  const right = Math.max(...orderedRuns.map((run) => run.x + run.width))
  const bottom = Math.max(...orderedRuns.map((run) => run.y + run.height))
  return {
    ...source,
    text: '',
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    fontSize: Math.max(...orderedRuns.map((run) => run.fontSize)),
    runs: orderedRuns,
    sourceOwnedColumn,
  }
}

function splitSourceOwnedOverprintedColumnLayers(
  lines: readonly PdfTextLine[],
  gutterCenter: number | null,
  sourceOrder: ReadonlyMap<PdfSourceRun, number>,
) {
  if (gutterCenter === null) return [...lines]
  return lines.flatMap((line) => {
    if (
      line.runs.length < 4 ||
      line.x >= gutterCenter - 0.08 ||
      line.x + line.width <= gutterCenter + 0.08
    ) {
      return [line]
    }
    const sourceOrderedRuns = [...line.runs].sort(
      (left, right) =>
        sourceRunOrder(left, sourceOrder) - sourceRunOrder(right, sourceOrder),
    )
    const candidates = sourceOrderedRuns.flatMap((rightRun, index) => {
      if (index < 2 || sourceOrderedRuns.length - index < 2) return []
      const leftRun = sourceOrderedRuns[index - 1]
      const sourceGap =
        sourceRunOrder(rightRun, sourceOrder) -
        sourceRunOrder(leftRun, sourceOrder)
      if (
        !Number.isFinite(sourceGap) ||
        sourceGap < MIN_OVERPRINT_SOURCE_RUN_DISTANCE
      ) {
        return []
      }
      const sourceGroups = [
        sourceOrderedRuns.slice(0, index),
        sourceOrderedRuns.slice(index),
      ] as const
      if (
        sourceGroups.some((group) => {
          const ordered = [...group].sort(
            (left, right) =>
              sourceRunOrder(left, sourceOrder) -
              sourceRunOrder(right, sourceOrder),
          )
          return ordered
            .slice(1)
            .some(
              (run, runIndex) =>
                sourceRunOrder(run, sourceOrder) -
                  sourceRunOrder(ordered[runIndex], sourceOrder) >
                4,
            )
        })
      ) {
        return []
      }
      const envelopes = sourceGroups.map((group) => ({
        left: Math.min(...group.map((run) => run.x)),
        right: Math.max(...group.map((run) => run.x + run.width)),
        top: Math.min(...group.map((run) => run.y)),
        bottom: Math.max(...group.map((run) => run.y + run.height)),
        fontSize: Math.max(...group.map((run) => run.fontSize)),
      }))
      const [first, second] = envelopes
      const leftIndex = first.left <= second.left ? 0 : 1
      const rightIndex = leftIndex === 0 ? 1 : 0
      const left = envelopes[leftIndex]
      const right = envelopes[rightIndex]
      const horizontalOverlap =
        Math.min(left.right, right.right) - Math.max(left.left, right.left)
      const leftOwnsColumn =
        left.left <= gutterCenter - 0.08 && left.right >= gutterCenter + 0.02
      const rightOwnsColumn =
        right.left >= gutterCenter - 0.02 && right.right >= gutterCenter + 0.08
      const centerDifference = Math.abs(
        (left.top + left.bottom) / 2 - (right.top + right.bottom) / 2,
      )
      const fontRatio =
        Math.max(left.fontSize, right.fontSize) /
        Math.max(0.001, Math.min(left.fontSize, right.fontSize))
      if (
        !leftOwnsColumn ||
        !rightOwnsColumn ||
        horizontalOverlap < 0.03 ||
        centerDifference > Math.max(0.004, (left.bottom - left.top) * 0.35) ||
        fontRatio > 1.2 ||
        sourceGroups.some(
          (group, groupIndex) =>
            !readableLayerEvidence(group, envelopes[groupIndex].fontSize),
        )
      ) {
        return []
      }
      return [
        {
          sourceGap,
          groups: [sourceGroups[leftIndex], sourceGroups[rightIndex]] as const,
        },
      ]
    })
    if (candidates.length !== 1) return [line]
    return candidates[0].groups.map((runs, index) =>
      lineFromSourceRuns(line, runs, index === 0 ? 'left' : 'right'),
    )
  })
}

function runFitsLine(
  line: PdfTextLine,
  run: PdfSourceRun,
  gutterCenter: number | null,
  sourceOrder: ReadonlyMap<PdfSourceRun, number>,
) {
  const center = run.y + run.height / 2
  const lineCenter = line.y + line.height / 2
  const gap = horizontalGap(line, run)
  const incomingMathExtension = mathExtensionRun(run)
  const lineHasMathExtension = line.runs.some(mathExtensionRun)
  const incomingStructuralMathExtension =
    incomingMathExtension && !inlineMathAccentRun(run)
  const lineHasStructuralMathExtension = line.runs.some(
    (candidate) =>
      mathExtensionRun(candidate) && !inlineMathAccentRun(candidate),
  )
  const incomingUnresolvedMathExtension = unresolvedMathExtensionRun(run)
  const lineHasUnresolvedMathExtension = line.runs.some(
    unresolvedMathExtensionRun,
  )
  if (containsCompetingTextLayers(line.runs, [run], sourceOrder)) {
    return false
  }
  if (
    incomingUnresolvedMathExtension !== lineHasUnresolvedMathExtension &&
    (incomingUnresolvedMathExtension || lineHasUnresolvedMathExtension)
  ) {
    return false
  }
  const lineHasFormulaContext = line.runs.some(
    (candidate) =>
      !mathExtensionRun(candidate) && probableFormulaRun(candidate),
  )
  if (
    incomingStructuralMathExtension &&
    !lineHasStructuralMathExtension &&
    !lineHasFormulaContext
  ) {
    return false
  }
  if (
    lineHasStructuralMathExtension &&
    !mathExtensionRun(run) &&
    !probableFormulaRun(run)
  ) {
    return false
  }
  const mathExtensionTolerance =
    incomingMathExtension || lineHasMathExtension ? 0.0125 : 0
  return (
    hasPlausibleLineSpan(line.runs, [run]) &&
    Math.abs(center - lineCenter) <=
      Math.max(
        0.004,
        run.height * 0.65,
        line.height * 0.65,
        mathExtensionTolerance,
      ) &&
    gap <= Math.max(0.025, run.height * 2) &&
    !crossesProbableColumnGutter(line, run, gap, gutterCenter)
  )
}

function probableColumnGutterCenter(runs: PdfSourceRun[]) {
  const bands: Array<{ center: number; runs: PdfSourceRun[] }> = []
  for (const run of [...runs].sort(
    (left, right) => left.y - right.y || left.x - right.x,
  )) {
    const center = run.y + run.height / 2
    const band = bands.find(
      (candidate) =>
        Math.abs(candidate.center - center) <=
        Math.max(0.004, run.height * 0.65),
    )
    if (band) band.runs.push(run)
    else bands.push({ center, runs: [run] })
  }

  const candidates: Array<{ center: number; band: number }> = []
  for (const [bandIndex, band] of bands.entries()) {
    const ordered = [...band.runs].sort((left, right) => left.x - right.x)
    for (let index = 1; index < ordered.length; index += 1) {
      const left = ordered[index - 1]
      const right = ordered[index]
      const gap = right.x - (left.x + left.width)
      if (gap < Math.max(0.012, Math.min(left.height, right.height) * 0.65)) {
        continue
      }
      // Repeated cell boundaries in a full-width table are not page-column
      // gutters. Require prose-sized text on both sides before a gap can
      // establish the global gutter used while grouping source runs.
      if (!probableColumnProseRun(left) || !probableColumnProseRun(right)) {
        continue
      }
      // A repeated run-in heading style can put a bold label and its regular
      // prose continuation on the same baseline. Those aligned typographic
      // boundaries are not evidence of page columns; treating them as a
      // gutter splits the sentence and moves the continuation out of order.
      if (emphasizedProseRun(left) !== emphasizedProseRun(right)) continue
      const center = left.x + left.width + gap / 2
      if (center >= 0.25 && center <= 0.75) {
        candidates.push({ center, band: bandIndex })
      }
    }
  }
  const clusters = candidates.map((seed) => {
    const members = candidates.filter(
      (candidate) => Math.abs(candidate.center - seed.center) <= 0.025,
    )
    return {
      members,
      center:
        members.reduce((total, member) => total + member.center, 0) /
        members.length,
      bandCount: new Set(members.map((member) => member.band)).size,
    }
  })
  const strongest = clusters.sort(
    (left, right) =>
      right.bandCount - left.bandCount ||
      Math.abs(left.center - 0.5) - Math.abs(right.center - 0.5),
  )[0]
  return strongest && strongest.bandCount >= 3 ? strongest.center : null
}

function mergeLineInto(target: PdfTextLine, source: PdfTextLine) {
  target.runs.push(...source.runs)
  expandLineBounds(target, source)
  target.fontSize = Math.max(target.fontSize, source.fontSize)
}

function structuralMathOperatorRun(run: PdfSourceRun) {
  return mathExtensionRun(run) && /^\p{Sm}+$/u.test(run.text.trim())
}

function resetLineBounds(line: PdfTextLine) {
  if (line.runs.length === 0) return
  const left = Math.min(...line.runs.map((run) => run.x))
  const top = Math.min(...line.runs.map((run) => run.y))
  const right = Math.max(...line.runs.map((run) => run.x + run.width))
  const bottom = Math.max(...line.runs.map((run) => run.y + run.height))
  line.x = left
  line.y = top
  line.width = right - left
  line.height = bottom - top
  line.fontSize = Math.max(...line.runs.map((run) => run.fontSize))
}

// PDF.js positions a large operator by its visual top, so y-order can visit it
// before the baseline that owns it. Repair only the narrow, source-proven case:
// the immediate content-stream neighbors are formula runs on one other line,
// tightly bracket the operator horizontally, and the provisional owner is
// overlapping prose. Delimiters and accents are intentionally excluded.
function restoreSourceOwnedMathOperators(
  lines: PdfTextLine[],
  sourceRuns: readonly PdfSourceRun[],
) {
  const ownerByRun = new Map<PdfSourceRun, PdfTextLine>()
  for (const line of lines) {
    for (const run of line.runs) ownerByRun.set(run, line)
  }
  for (let index = 1; index < sourceRuns.length - 1; index += 1) {
    const run = sourceRuns[index]
    if (!structuralMathOperatorRun(run)) continue
    const previous = sourceRuns[index - 1]
    const next = sourceRuns[index + 1]
    if (!probableFormulaRun(previous) || !probableFormulaRun(next)) continue
    const current = ownerByRun.get(run)
    const target = ownerByRun.get(previous)
    if (
      !current ||
      !target ||
      target === current ||
      ownerByRun.get(next) !== target
    ) {
      continue
    }
    const tolerance = Math.max(0.004, run.height * 0.75)
    const horizontallyBracketed =
      previous.x <= run.x + tolerance &&
      next.x + tolerance >= run.x + run.width &&
      horizontalGap(previous, run) <= tolerance &&
      horizontalGap(run, next) <= tolerance
    const verticallyBounded = [previous, next].every((neighbor) => {
      const neighborCenter = neighbor.y + neighbor.height / 2
      const runCenter = run.y + run.height / 2
      return (
        Math.abs(neighborCenter - runCenter) <=
        Math.max(0.02, run.height * 1.75, neighbor.height * 1.75)
      )
    })
    const overlapsProse = current.runs.some(
      (candidate) =>
        candidate !== run &&
        probableColumnProseRun(candidate) &&
        horizontalGap(candidate, run) === 0,
    )
    if (!horizontallyBracketed || !verticallyBounded || !overlapsProse) {
      continue
    }
    current.runs.splice(current.runs.indexOf(run), 1)
    target.runs.push(run)
    ownerByRun.set(run, target)
    resetLineBounds(current)
    expandLineBounds(target, run)
    target.fontSize = Math.max(target.fontSize, run.fontSize)
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].runs.length === 0) lines.splice(index, 1)
  }
}

export function groupRunsIntoLines(page: PdfPageAnalysis): PdfTextLine[] {
  const lines: PdfTextLine[] = []
  const sourceOrder = new Map(page.runs.map((run, index) => [run, index]))
  const runs = page.runs
    .filter((run) => run.text.trim())
    .sort((left, right) => left.y - right.y || left.x - right.x)
  const gutterCenter = probableColumnGutterCenter(runs)

  for (const run of runs) {
    const center = run.y + run.height / 2
    const matchingLines = lines.filter((line) =>
      runFitsLine(line, run, gutterCenter, sourceOrder),
    )
    // When overprinted layers leave a small horizontal gap, the nearest box
    // can still be the wrong layer. Adjacent content-stream order plus matching
    // typography is stronger ownership evidence than that geometric accident.
    const adjacentLayerMatches = matchingLines.filter((line) =>
      adjacentTypographyLayer(line, run, sourceOrder),
    )
    const matching = (
      adjacentLayerMatches.length > 0 ? adjacentLayerMatches : matchingLines
    ).sort((left, right) => {
      const leftCenter = left.y + left.height / 2
      const rightCenter = right.y + right.height / 2
      return (
        horizontalGap(left, run) - horizontalGap(right, run) ||
        Math.abs(center - leftCenter) - Math.abs(center - rightCenter) ||
        left.x - right.x
      )
    })[0]
    if (matching) {
      matching.runs.push(run)
      expandLineBounds(matching, run)
      matching.fontSize = Math.max(matching.fontSize, run.fontSize)
      for (const candidate of [...lines]) {
        if (candidate === matching) continue
        if (
          hasPlausibleLineSpan(matching.runs, candidate.runs) &&
          !containsCompetingTextLayers(
            matching.runs,
            candidate.runs,
            sourceOrder,
          ) &&
          candidate.runs.some((candidateRun) =>
            matching.runs.some(
              (matchingRun) =>
                runFitsLine(
                  candidate,
                  matchingRun,
                  gutterCenter,
                  sourceOrder,
                ) ||
                runFitsLine(matching, candidateRun, gutterCenter, sourceOrder),
            ),
          )
        ) {
          mergeLineInto(matching, candidate)
          lines.splice(lines.indexOf(candidate), 1)
        }
      }
      continue
    }
    lines.push({
      page: page.page,
      text: '',
      x: run.x,
      y: run.y,
      width: run.width,
      height: run.height,
      fontSize: run.fontSize,
      runs: [run],
      column: 'single',
    })
  }

  restoreSourceOwnedMathOperators(
    lines,
    page.runs.filter((run) => run.text.trim()),
  )
  const sourceOwnedLines = splitSourceOwnedOverprintedColumnLayers(
    lines,
    gutterCenter,
    sourceOrder,
  )
  for (const line of sourceOwnedLines) {
    line.runs.sort((left, right) => left.x - right.x)
    for (const accent of [...line.runs]) {
      const accentOrder = sourceRunOrder(accent, sourceOrder)
      if (!Number.isFinite(accentOrder)) continue
      const target = line.runs.find(
        (candidate) =>
          sourceRunOrder(candidate, sourceOrder) === accentOrder + 1 &&
          positionedPdfPrefixAccentText(accent, candidate) !== null,
      )
      if (!target) continue
      const accentIndex = line.runs.indexOf(accent)
      const targetIndex = line.runs.indexOf(target)
      if (accentIndex + 1 === targetIndex) continue
      line.runs.splice(accentIndex, 1)
      line.runs.splice(line.runs.indexOf(target), 0, accent)
    }
    line.text = mergePdfRunText(line.runs)
  }
  const nonEmptyLines = sourceOwnedLines.filter((line) => line.text)
  for (const line of nonEmptyLines) {
    registerPdfLinkedTokenSourceAnnotations(line, page.links ?? [])
  }
  return nonEmptyLines
}

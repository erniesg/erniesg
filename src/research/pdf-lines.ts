import type {
  PdfLineBoundaryDecision,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfRegionLine,
  PdfSourceRun,
} from './import-types'

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

export function replayPdfRegionLineText(
  region: PdfPageRegion,
  decisions: readonly PdfLineBoundaryDecision[],
) {
  const byTransition = new Map(
    decisions
      .filter((decision) => decision.regionId === region.id)
      .map((decision) => [
        `${decision.fromLineId}\u0000${decision.toLineId}`,
        decision,
      ]),
  )
  if (byTransition.size !== Math.max(region.lines.length - 1, 0)) return null

  let text = region.lines[0]?.text.trim() ?? ''
  for (let index = 1; index < region.lines.length; index += 1) {
    const previous = region.lines[index - 1]
    const current = region.lines[index]
    const decision = byTransition.get(`${previous.id}\u0000${current.id}`)
    const next = current.text.trim()
    if (
      !decision ||
      decision.page !== region.page ||
      decision.fromLineId !== previous.id ||
      decision.toLineId !== current.id
    ) {
      return null
    }
    if (decision.outcome === 'space') {
      text += ` ${next}`
    } else if (decision.outcome === 'no-space') {
      text += next
    } else if (decision.outcome === 'removed-discretionary-hyphen') {
      if (!/[-‐‑\u00ad]$/u.test(text)) return null
      text = `${text.slice(0, -1)}${next}`
    } else {
      if (!/[-‐‑]$/u.test(text)) return null
      text += next
    }
  }
  return text.replace(/\s+/g, ' ').trim()
}

function normalizedHyphenatedWord(value: string) {
  return value.normalize('NFKC').replace(/[‐‑]/g, '-').toLocaleLowerCase()
}

export function inlineHardHyphenLexicon(lines: PdfTextLine[]) {
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

export function inlineUnhyphenatedLexicon(lines: PdfTextLine[]) {
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

function sourcePreservationEvidence(lines: PdfTextLine[], index: number) {
  const fragments = boundaryFragments(lines, index)
  if (!fragments) return null
  if (/^\p{N}+$/u.test(fragments.left) && /^\p{N}+$/u.test(fragments.right)) {
    return 'numeric-hyphen-boundary'
  }
  if (
    /^\p{Lu}{2,}$/u.test(fragments.left) &&
    /^\p{Lu}\p{Ll}+/u.test(fragments.right)
  ) {
    return 'uppercase-prefix-titlecase-compound'
  }
  return null
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
  const hardHyphenLexicon = options.hardHyphenLexicon ?? new Set<string>()
  const unhyphenatedLexicon = options.unhyphenatedLexicon ?? new Set<string>()
  for (const [index, line] of lines.entries()) {
    const next = line.text.trim()
    if (!next) continue
    if (!joined) {
      joined = next
      continue
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

function mergeRunText(runs: PdfSourceRun[]) {
  let text = ''
  let previous: PdfSourceRun | undefined
  for (const run of runs) {
    const word = run.text.trim()
    if (!word) continue
    const gap = previous
      ? run.x - (previous.x + previous.width)
      : Number.POSITIVE_INFINITY
    const needsSpace =
      text.length > 0 &&
      !/^[,.;:!?%)}\]]/.test(word) &&
      !/[({[]$/.test(text) &&
      gap > Math.max(0.0015, run.height * 0.08)
    text += `${needsSpace ? ' ' : ''}${word}`
    previous = run
  }
  return text.replace(/\s+/g, ' ').trim()
}

function crossesProbableColumnGutter(
  line: PdfTextLine,
  run: PdfSourceRun,
  horizontalGap: number,
) {
  if (
    horizontalGap < Math.max(0.012, Math.min(line.height, run.height) * 0.65)
  ) {
    return false
  }
  const lineRight = line.x + line.width
  const runRight = run.x + run.width
  const gapCenter = (lineRight + run.x) / 2
  const combinedWidth = Math.max(lineRight, runRight) - Math.min(line.x, run.x)
  return gapCenter >= 0.35 && gapCenter <= 0.65 && combinedWidth >= 0.55
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

function runFitsLine(line: PdfTextLine, run: PdfSourceRun) {
  const center = run.y + run.height / 2
  const lineCenter = line.y + line.height / 2
  const gap = horizontalGap(line, run)
  return (
    Math.abs(center - lineCenter) <=
      Math.max(0.004, run.height * 0.65, line.height * 0.65) &&
    gap <= Math.max(0.025, run.height * 2) &&
    !crossesProbableColumnGutter(line, run, gap)
  )
}

function mergeLineInto(target: PdfTextLine, source: PdfTextLine) {
  const right = Math.max(target.x + target.width, source.x + source.width)
  target.runs.push(...source.runs)
  target.x = Math.min(target.x, source.x)
  target.y = Math.min(target.y, source.y)
  target.width = right - target.x
  target.height = Math.max(target.height, source.height)
  target.fontSize = Math.max(target.fontSize, source.fontSize)
}

export function groupRunsIntoLines(page: PdfPageAnalysis): PdfTextLine[] {
  const lines: PdfTextLine[] = []
  const runs = page.runs
    .filter((run) => run.text.trim())
    .sort((left, right) => left.y - right.y || left.x - right.x)

  for (const run of runs) {
    const center = run.y + run.height / 2
    const matching = lines
      .filter((line) => runFitsLine(line, run))
      .sort((left, right) => {
        const leftCenter = left.y + left.height / 2
        const rightCenter = right.y + right.height / 2
        return (
          horizontalGap(left, run) - horizontalGap(right, run) ||
          Math.abs(center - leftCenter) - Math.abs(center - rightCenter) ||
          left.x - right.x
        )
      })[0]
    if (matching) {
      const right = Math.max(matching.x + matching.width, run.x + run.width)
      matching.runs.push(run)
      matching.x = Math.min(matching.x, run.x)
      matching.y = Math.min(matching.y, run.y)
      matching.width = right - matching.x
      matching.height = Math.max(matching.height, run.height)
      matching.fontSize = Math.max(matching.fontSize, run.fontSize)
      for (const candidate of [...lines]) {
        if (candidate === matching) continue
        if (
          candidate.runs.some((candidateRun) =>
            matching.runs.some(
              (matchingRun) =>
                runFitsLine(candidate, matchingRun) ||
                runFitsLine(matching, candidateRun),
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

  for (const line of lines) {
    line.runs.sort((left, right) => left.x - right.x)
    line.text = mergeRunText(line.runs)
  }
  return lines.filter((line) => line.text)
}

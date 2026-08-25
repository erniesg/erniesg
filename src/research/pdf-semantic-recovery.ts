import type { PdfSourceRun } from './import-types'
import type { PdfTextLine } from './pdf-lines'
import { normalizedNoteLabel } from './note-label'
import { type ClassifiedLine, type ColumnLayout } from './pdf-page-layout'
import { proseDominantInlineMathLine } from './pdf-source-math'

function median(values: number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

export function emphasizedSourceRun(run: PdfTextLine['runs'][number]) {
  return (
    run.bold === true ||
    /(?:bold|semibold|demi|medi(?:um)?|black)/iu.test(run.fontName) ||
    /(?:^|[+,._\s-])cm(?:bx|b)(?:ti|sl)?\d*(?=$|[+,._\s-])/iu.test(
      run.fontName,
    ) ||
    /(?:^|[+,._\s-])lin(?:biolinum|libertine)t?b(?:i)?(?=$|[+,._\s-])/iu.test(
      run.fontName,
    )
  )
}

export function standaloneSectionHeading(line: ClassifiedLine) {
  if (line.kind !== 'body' && line.kind !== 'spanning') return false
  const text = line.text.replace(/\s+/g, ' ').trim()
  if (!text || text.length > 120) return false
  if (
    /^(?:abstract|acknowledg(?:e)?ments?|limitations?|ethics statement|references|bibliography|appendix)$/i.test(
      text,
    )
  ) {
    return true
  }
  const machineIdentifierTitle = /^(?:(?:https?:\/\/|www\.)|\S*[_@]\S*)/iu.test(
    text.replace(/^(?:\d{1,3}(?:\.\d+){0,3}|[A-Z](?:\.\d+)*)[.)]?\s+/u, ''),
  )
  const stronglyStyledStructuralHeading =
    !machineIdentifierTitle &&
    emphasizedFaceShare(line) >= 0.6 &&
    /^(?:(?:\d{1,3}(?:\.\d+){0,3}|[A-Z](?:\.\d+)*)[.)]?)\s+\p{Lu}.{0,100}$/u.test(
      text,
    )
  return (
    /^\d{1,3}(?:\.\d+){0,3}\s+\p{Lu}[^.,;:!?]{0,100}$/u.test(text) ||
    /^[A-Z](?:\.\d+)?\s+\p{Lu}[^,;:!?]{0,100}$/u.test(text) ||
    stronglyStyledStructuralHeading
  )
}

export function dominantLineHeight(line: ClassifiedLine) {
  const largestFont = Math.max(...line.runs.map((run) => run.fontSize), 0)
  const baselineHeights = line.runs
    .filter((run) => run.fontSize >= largestFont * 0.9)
    .map((run) => run.height)
    .filter((height) => height > 0)
  return median(baselineHeights) || line.height
}

export function dominantBaselineMetrics(line: PdfTextLine) {
  const visibleRuns = line.runs.filter((run) => run.text.trim())
  if (visibleRuns.length === 0) return null
  const maximumFontSize = Math.max(...visibleRuns.map((run) => run.fontSize))
  const dominantRuns = visibleRuns.filter(
    (run) => run.fontSize >= maximumFontSize * 0.9,
  )
  const characterWeight = (run: PdfSourceRun) =>
    Math.max(run.text.replace(/\s+/gu, '').length, 1)
  const totalWeight = dominantRuns.reduce(
    (total, run) => total + characterWeight(run),
    0,
  )
  const representative = [...dominantRuns].sort(
    (left, right) =>
      characterWeight(right) - characterWeight(left) ||
      right.fontSize - left.fontSize ||
      left.x - right.x,
  )[0]
  return {
    fontSize: maximumFontSize,
    fontName: representative.fontName,
    top: Math.min(...dominantRuns.map((run) => run.y)),
    bottom: Math.max(...dominantRuns.map((run) => run.y + run.height)),
    baseline:
      dominantRuns.reduce(
        (total, run) => total + (run.y + run.height) * characterWeight(run),
        0,
      ) / totalWeight,
    height: median(dominantRuns.map((run) => run.height)),
  }
}

export function comparableSemanticFlowFontName(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(
      /(?:bold|semibold|demi|medium|black|italic|ital|oblique|regular)/gu,
      '',
    )
    .replace(/\d+/gu, '')
    .replace(/[^a-z]+/gu, '')
}

export function sourceProvenDominantBaselineSequentialWrap(
  previous: PdfTextLine,
  line: PdfTextLine,
) {
  const previousRuns = previous.runs.filter((run) => run.text.trim())
  const lineRuns = line.runs.filter((run) => run.text.trim())
  if (
    previous.page !== line.page ||
    previous.column !== line.column ||
    previousRuns.length < 2 ||
    lineRuns.length === 0 ||
    previousRuns.some((run) => run.sourceSequenceIndex === undefined) ||
    lineRuns.some((run) => run.sourceSequenceIndex === undefined)
  ) {
    return false
  }
  const maximumPreviousSequence = Math.max(
    ...previousRuns.map((run) => run.sourceSequenceIndex!),
  )
  const minimumLineSequence = Math.min(
    ...lineRuns.map((run) => run.sourceSequenceIndex!),
  )
  const previousBoundaryRuns = previousRuns.filter(
    (run) => run.sourceSequenceIndex === maximumPreviousSequence,
  )
  const lineBoundaryRuns = lineRuns.filter(
    (run) => run.sourceSequenceIndex === minimumLineSequence,
  )
  if (previousBoundaryRuns.length !== 1 || lineBoundaryRuns.length !== 1) {
    return false
  }
  const previousBoundaryRun = previousBoundaryRuns[0]
  const lineBoundaryRun = lineBoundaryRuns[0]
  const exactSourceAdjacency =
    minimumLineSequence === maximumPreviousSequence + 1 ||
    (lineBoundaryRun.sourceWhitespaceBefore === 'pdf-text-item' &&
      lineBoundaryRun.sourceWhitespacePredecessorIndex ===
        maximumPreviousSequence)
  const previousMetrics = dominantBaselineMetrics(previous)
  const lineMetrics = dominantBaselineMetrics(line)
  if (
    !exactSourceAdjacency ||
    !previousMetrics ||
    !lineMetrics ||
    previousBoundaryRun.page !== lineBoundaryRun.page ||
    previousBoundaryRun.rotation !== lineBoundaryRun.rotation ||
    previousBoundaryRun.method !== lineBoundaryRun.method
  ) {
    return false
  }
  const fullEnvelopeGap = line.y - (previous.y + previous.height)
  const dominantGap = lineMetrics.top - previousMetrics.bottom
  const hasStackedEnvelope =
    previousRuns.some(
      (run) =>
        run.fontSize < previousMetrics.fontSize * 0.9 &&
        (run.y < previousMetrics.top ||
          run.y + run.height > previousMetrics.bottom),
    ) ||
    lineRuns.some(
      (run) =>
        run.fontSize < lineMetrics.fontSize * 0.9 &&
        (run.y < lineMetrics.top || run.y + run.height > lineMetrics.bottom),
    )
  const fontRatio =
    Math.max(previousMetrics.fontSize, lineMetrics.fontSize) /
    Math.max(1, Math.min(previousMetrics.fontSize, lineMetrics.fontSize))
  const previousFont = comparableSemanticFlowFontName(previousMetrics.fontName)
  const lineFont = comparableSemanticFlowFontName(lineMetrics.fontName)
  const fontCompatible =
    previousFont === lineFont ||
    previousFont.includes(lineFont) ||
    lineFont.includes(previousFont)
  return (
    hasStackedEnvelope &&
    fullEnvelopeGap < -0.004 &&
    dominantGap >= -0.004 &&
    dominantGap <=
      Math.max(
        0.014,
        Math.max(previousMetrics.height, lineMetrics.height) * 1.25,
      ) &&
    fontRatio <= 1.18 &&
    fontCompatible &&
    Math.abs(line.x - previous.x) <=
      Math.max(0.06, Math.max(previousMetrics.height, lineMetrics.height) * 4)
  )
}

export function sourceProvenSpanningInlineMathContinuation(
  previous: ClassifiedLine,
  line: ClassifiedLine,
  sourceSequenceCounts: ReadonlyMap<number, number>,
) {
  if (
    previous.page !== line.page ||
    previous.kind !== 'spanning' ||
    previous.column !== 'span' ||
    line.kind !== 'body' ||
    (line.column !== 'left' && line.column !== 'right') ||
    previous.y >= line.y ||
    !proseDominantInlineMathLine(previous) ||
    /[.!?](?:["'’”\])}]*)$/u.test(previous.text.trim()) ||
    !/^\p{Ll}/u.test(line.text.trim())
  ) {
    return false
  }
  const continuationWords = line.text.match(/[\p{L}\p{N}]+/gu) ?? []
  if (
    continuationWords.length === 0 ||
    continuationWords.length > 8 ||
    line.text.trim().length > 72 ||
    line.width > Math.min(0.3, previous.width * 0.45)
  ) {
    return false
  }

  const previousRuns = previous.runs.filter((run) => run.text.trim())
  const lineRuns = line.runs.filter((run) => run.text.trim())
  const inlineMathEvidence = previousRuns.some(
    (run) =>
      /(?:cmmi|cmsy|cmex|msbm|math|symbol)/iu.test(run.fontName) ||
      /[\p{Script=Greek}∆_=+*/<>^−×÷≤≥≈≠∼⊙∂∞∏∈∉→←∫∑√]/u.test(run.text),
  )
  const previousSequenceIndexes = previousRuns.flatMap((run) =>
    run.sourceSequenceIndex === undefined ? [] : [run.sourceSequenceIndex],
  )
  const lineSequenceIndexes = lineRuns.flatMap((run) =>
    run.sourceSequenceIndex === undefined ? [] : [run.sourceSequenceIndex],
  )
  if (
    !inlineMathEvidence ||
    previousRuns.length === 0 ||
    lineRuns.length === 0 ||
    previousSequenceIndexes.length !== previousRuns.length ||
    lineSequenceIndexes.length !== lineRuns.length ||
    new Set(previousSequenceIndexes).size !== previousSequenceIndexes.length ||
    new Set(lineSequenceIndexes).size !== lineSequenceIndexes.length
  ) {
    return false
  }
  const previousBoundary = Math.max(...previousSequenceIndexes)
  const lineBoundary = Math.min(...lineSequenceIndexes)
  if (
    lineBoundary !== previousBoundary + 1 ||
    sourceSequenceCounts.get(previousBoundary) !== 1 ||
    sourceSequenceCounts.get(lineBoundary) !== 1
  ) {
    return false
  }

  const previousSource = previousRuns[0]
  const lineSource = lineRuns[0]
  if (
    previousRuns.some(
      (run) =>
        run.page !== previous.page ||
        run.rotation !== previousSource.rotation ||
        run.method !== previousSource.method,
    ) ||
    lineRuns.some(
      (run) =>
        run.page !== line.page ||
        run.rotation !== lineSource.rotation ||
        run.method !== lineSource.method,
    ) ||
    previousSource.rotation !== lineSource.rotation ||
    previousSource.method !== lineSource.method
  ) {
    return false
  }

  const previousMetrics = dominantBaselineMetrics(previous)
  const lineMetrics = dominantBaselineMetrics(line)
  if (!previousMetrics || !lineMetrics) return false
  const fontRatio =
    Math.max(previousMetrics.fontSize, lineMetrics.fontSize) /
    Math.max(1, Math.min(previousMetrics.fontSize, lineMetrics.fontSize))
  const previousFont = comparableSemanticFlowFontName(previousMetrics.fontName)
  const lineFont = comparableSemanticFlowFontName(lineMetrics.fontName)
  const fontCompatible =
    previousFont.length > 0 &&
    lineFont.length > 0 &&
    (previousFont === lineFont ||
      previousFont.includes(lineFont) ||
      lineFont.includes(previousFont))
  const dominantHeight = Math.max(previousMetrics.height, lineMetrics.height)
  const dominantGap = lineMetrics.top - previousMetrics.bottom
  const baselineStep = lineMetrics.baseline - previousMetrics.baseline
  return (
    fontRatio <= 1.08 &&
    fontCompatible &&
    Math.abs(line.x - previous.x) <=
      Math.max(
        0.006,
        Math.min(previousMetrics.height, lineMetrics.height) * 0.5,
      ) &&
    dominantGap >= -0.002 &&
    dominantGap <= Math.max(0.008, dominantHeight * 0.75) &&
    baselineStep >= dominantHeight * 0.75 &&
    baselineStep <= Math.max(0.024, dominantHeight * 1.75)
  )
}

export function promoteSourceProvenSpanningInlineMathContinuations(
  lines: ClassifiedLine[],
) {
  const sourceSequenceCounts = new Map<number, number>()
  for (const run of lines.flatMap((line) => line.runs)) {
    if (!run.text.trim() || run.sourceSequenceIndex === undefined) continue
    sourceSequenceCounts.set(
      run.sourceSequenceIndex,
      (sourceSequenceCounts.get(run.sourceSequenceIndex) ?? 0) + 1,
    )
  }
  const proposals = lines.flatMap((line) => {
    const predecessors = lines.filter((previous) =>
      sourceProvenSpanningInlineMathContinuation(
        previous,
        line,
        sourceSequenceCounts,
      ),
    )
    return predecessors.length === 1
      ? [{ previous: predecessors[0], line }]
      : []
  })
  const predecessorClaims = new Map<ClassifiedLine, number>()
  const continuationClaims = new Map<ClassifiedLine, number>()
  for (const proposal of proposals) {
    predecessorClaims.set(
      proposal.previous,
      (predecessorClaims.get(proposal.previous) ?? 0) + 1,
    )
    continuationClaims.set(
      proposal.line,
      (continuationClaims.get(proposal.line) ?? 0) + 1,
    )
  }
  for (const proposal of proposals) {
    if (
      predecessorClaims.get(proposal.previous) !== 1 ||
      continuationClaims.get(proposal.line) !== 1
    ) {
      continue
    }
    proposal.line.kind = 'spanning'
    proposal.line.column = 'span'
  }
}

export function hasEmphasizedFace(line: ClassifiedLine) {
  return line.runs.some(
    (run) =>
      run.bold === true ||
      /(?:bold|semibold|demi|medi(?:um)?|black)/i.test(run.fontName) ||
      /(?:^|[+,._\s-])cm(?:bx|b)(?:ti|sl)?\d*(?=$|[+,._\s-])/iu.test(
        run.fontName,
      ) ||
      /(?:^|[+,._\s-])lin(?:biolinum|libertine)t?b(?:i)?(?=$|[+,._\s-])/iu.test(
        run.fontName,
      ),
  )
}

export function emphasizedFaceShare(line: ClassifiedLine) {
  const visibleRuns = line.runs.filter((run) => run.text.trim())
  const visibleCharacters = visibleRuns.reduce(
    (total, run) => total + run.text.replace(/\s/gu, '').length,
    0,
  )
  const emphasizedCharacters = visibleRuns.reduce(
    (total, run) =>
      total +
      (run.bold === true ||
      /(?:bold|semibold|demi|medi(?:um)?|black)/i.test(run.fontName) ||
      /(?:^|[+,._\s-])cm(?:bx|b)(?:ti|sl)?\d*(?=$|[+,._\s-])/iu.test(
        run.fontName,
      ) ||
      /(?:^|[+,._\s-])lin(?:biolinum|libertine)t?b(?:i)?(?=$|[+,._\s-])/iu.test(
        run.fontName,
      )
        ? run.text.replace(/\s/gu, '').length
        : 0),
    0,
  )
  return visibleCharacters > 0 ? emphasizedCharacters / visibleCharacters : 0
}

export function markWrappedHeadingContinuations(lines: ClassifiedLine[]) {
  const claimed = new Set<string>()
  const seeds = lines
    .filter(
      (line) =>
        line.kind === 'body' &&
        standaloneSectionHeading(line) &&
        hasEmphasizedFace(line) &&
        /^(?:\d{1,3}(?:\.\d+){0,3}|[A-Z](?:\.\d+)*)[.)]?\s+\p{Lu}/u.test(
          line.text.trim(),
        ),
    )
    .sort((left, right) => left.y - right.y || left.x - right.x)
  for (const seed of seeds) {
    const sameBaselineCrossGutterCandidates = lines.filter((candidate) => {
      if (
        candidate === seed ||
        claimed.has(candidate.id) ||
        candidate.page !== seed.page ||
        seed.column !== 'left' ||
        candidate.column !== 'right' ||
        candidate.kind !== 'body' ||
        !hasEmphasizedFace(candidate) ||
        !/[:–—-]$/u.test(seed.text.trim())
      ) {
        return false
      }
      const fontRatio =
        Math.max(seed.fontSize, candidate.fontSize) /
        Math.max(1, Math.min(seed.fontSize, candidate.fontSize))
      const horizontalGap = candidate.x - (seed.x + seed.width)
      const text = candidate.text.replace(/\s+/gu, ' ').trim()
      return (
        Math.abs(candidate.y - seed.y) <=
          Math.max(0.004, Math.max(seed.height, candidate.height) * 0.4) &&
        candidate.x > seed.x + Math.min(0.12, seed.width * 0.5) &&
        horizontalGap >= -0.03 &&
        horizontalGap <= 0.18 &&
        fontRatio <= 1.05 &&
        text.length <= 72 &&
        /^\p{Lu}[\p{L}\p{N}'’&/(),:–—\s-]*$/u.test(text) &&
        !/(?:https?:\/\/|www\.|\S*[_@]\S*)/iu.test(text)
      )
    })
    if (sameBaselineCrossGutterCandidates.length === 1) {
      const candidate = sameBaselineCrossGutterCandidates[0]
      candidate.headingContinuationSeedId = seed.id
      claimed.add(candidate.id)
    }
    const candidates = lines.filter((candidate) => {
      if (
        candidate === seed ||
        claimed.has(candidate.id) ||
        candidate.page !== seed.page ||
        candidate.column !== seed.column ||
        candidate.kind !== 'body' ||
        !hasEmphasizedFace(candidate)
      ) {
        return false
      }
      const gap = candidate.y - (seed.y + seed.height)
      const fontRatio =
        Math.max(seed.fontSize, candidate.fontSize) /
        Math.max(1, Math.min(seed.fontSize, candidate.fontSize))
      const text = candidate.text.replace(/\s+/gu, ' ').trim()
      const continuesDiscretionaryHyphen =
        /\p{L}-$/u.test(seed.text.trim()) && /^\p{Ll}/u.test(text)
      const beginsOrdinaryHeadingWrap = /^\p{Lu}/u.test(text)
      const continuesFullyEmphasizedLowercaseWrap =
        /^\p{Ll}/u.test(text) &&
        emphasizedFaceShare(candidate) >= 0.9 &&
        (text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) <= 8
      return (
        gap >= -0.002 &&
        gap <= Math.max(0.007, seed.height * 0.55) &&
        candidate.x - seed.x >= 0.015 &&
        candidate.x - seed.x <= 0.08 &&
        fontRatio <= 1.05 &&
        text.length <= 72 &&
        (continuesDiscretionaryHyphen ||
          beginsOrdinaryHeadingWrap ||
          continuesFullyEmphasizedLowercaseWrap) &&
        /^[\p{L}\p{N}][\p{L}\p{N}'’&/(),:–—\s-]*$/u.test(text) &&
        !/[.!?][”’'"\])}]*$/u.test(text) &&
        !/(?:https?:\/\/|www\.|\S*[_@]\S*)/iu.test(text)
      )
    })
    if (candidates.length !== 1) continue
    candidates[0].headingContinuationSeedId = seed.id
    claimed.add(candidates[0].id)
  }
}

export function repairCrossGutterHeadingPrefixes(
  lines: ClassifiedLine[],
  layout: ColumnLayout,
) {
  const split = layout.split
  if (split === null) return lines
  const consumed = new Set<ClassifiedLine>()
  for (const prefix of lines) {
    const prefixText = prefix.text.trim()
    if (
      prefix.kind !== 'body' ||
      prefix.column !== 'left' ||
      !/^\d{1,3}$/u.test(prefixText) ||
      !hasEmphasizedFace(prefix)
    ) {
      continue
    }
    const prefixRight = prefix.x + prefix.width
    if (Math.abs(prefixRight - split) > 0.04) continue
    const candidates = lines
      .filter((candidate) => {
        const text = candidate.text.replace(/\s+/g, ' ').trim()
        const baselineTolerance = Math.max(
          0.003,
          Math.min(prefix.height, candidate.height) * 0.25,
        )
        const gap = candidate.x - prefixRight
        const fontRatio =
          Math.max(prefix.fontSize, candidate.fontSize) /
          Math.max(1, Math.min(prefix.fontSize, candidate.fontSize))
        return (
          candidate !== prefix &&
          candidate.page === prefix.page &&
          candidate.kind === 'body' &&
          candidate.column === 'right' &&
          hasEmphasizedFace(candidate) &&
          Math.abs(candidate.y - prefix.y) <= baselineTolerance &&
          gap >= 0 &&
          gap <= 0.06 &&
          candidate.x - split <= 0.08 &&
          fontRatio <= 1.08 &&
          text.length <= 80 &&
          /^\p{Lu}[\p{L}\p{N}'’&/–—-]*(?:\s+\p{Lu}[\p{L}\p{N}'’&/–—-]*){1,10}$/u.test(
            text,
          )
        )
      })
      .sort(
        (left, right) =>
          left.x - prefixRight - (right.x - prefixRight) || left.x - right.x,
      )
    if (candidates.length !== 1) continue
    const heading = candidates[0]
    const right = Math.max(prefix.x + prefix.width, heading.x + heading.width)
    const bottom = Math.max(
      prefix.y + prefix.height,
      heading.y + heading.height,
    )
    heading.text = `${prefixText} ${heading.text.trim()}`
    heading.x = prefix.x
    heading.y = Math.min(prefix.y, heading.y)
    heading.width = right - heading.x
    heading.height = bottom - heading.y
    heading.fontSize = Math.max(prefix.fontSize, heading.fontSize)
    heading.confidence = Math.min(prefix.confidence, heading.confidence)
    heading.runs = [...prefix.runs, ...heading.runs].sort(
      (left, right) => left.x - right.x,
    )
    consumed.add(prefix)
  }
  return lines.filter((line) => !consumed.has(line))
}

export function sourceProvenLexicalHyphenContinuation(
  previous: ClassifiedLine,
  line: ClassifiedLine,
  hardHyphenLexicon: ReadonlySet<string>,
) {
  if (
    previous.page !== line.page ||
    previous.kind !== line.kind ||
    previous.column !== line.column
  ) {
    return false
  }
  const left = previous.text.trimEnd().match(/([\p{L}\p{N}]+)[-‐‑]$/u)?.[1]
  const right = line.text.trimStart().match(/^([\p{L}\p{N}]+)/u)?.[1]
  if (!left || !right) return false
  const candidate = `${left}-${right}`
    .normalize('NFKC')
    .replace(/[‐‑]/gu, '-')
    .toLocaleLowerCase()
  if (!hardHyphenLexicon.has(candidate)) return false

  const leftEdgeTolerance = Math.max(
    0.012,
    Math.max(previous.height, line.height) * 0.75,
  )
  if (Math.abs(previous.x - line.x) > leftEdgeTolerance) return false
  const previousRight = previous.x + previous.width
  const lineRight = line.x + line.width
  const rightEdgeTolerance = Math.max(
    0.025,
    Math.min(previous.width, line.width) * 0.08,
  )
  return previousRight >= lineRight - rightEdgeTolerance
}

export function sourceProvenDetachedDisplayEquationAtomHost(
  previous: ClassifiedLine,
  line: ClassifiedLine,
  lines: readonly ClassifiedLine[],
): ClassifiedLine | null {
  if (
    previous.page !== line.page ||
    previous.kind !== line.kind ||
    previous.column !== line.column ||
    line.kind !== 'body'
  ) {
    return null
  }
  const visibleRuns = line.runs.filter((run) => run.text.trim())
  if (visibleRuns.length !== 1) return null
  const atom = visibleRuns[0]
  const atomText = atom.text.replace(/\s+/gu, '')
  if (
    atom.sourceSequenceIndex === undefined ||
    !/^[\p{L}\p{N}]{1,3}$/u.test(atomText) ||
    (!emphasizedSourceRun(atom) &&
      !/(?:math|cmmi|cmsy|msbm|symbol)/iu.test(atom.fontName))
  ) {
    return null
  }

  const atomCenterX = line.x + line.width / 2
  const atomCenterY = line.y + line.height / 2
  const nearbyEquationLines = lines.filter((candidate) => {
    if (
      candidate === line ||
      candidate.page !== line.page ||
      candidate.column !== line.column ||
      candidate.kind !== 'equation'
    ) {
      return false
    }
    const centerY = candidate.y + candidate.height / 2
    const horizontalGap = Math.max(
      candidate.x - (line.x + line.width),
      line.x - (candidate.x + candidate.width),
      0,
    )
    return (
      Math.abs(centerY - atomCenterY) <= Math.max(0.04, line.height * 3) &&
      horizontalGap <= Math.max(0.08, line.height * 6)
    )
  })
  const nearbyEquationRuns = nearbyEquationLines.flatMap((candidate) =>
    candidate.runs.filter(
      (run) =>
        run.text.trim() &&
        run.sourceSequenceIndex !== undefined &&
        run.page === atom.page &&
        run.rotation === atom.rotation &&
        run.method === atom.method,
    ),
  )
  const precedingEquationIndexes = nearbyEquationRuns
    .map((run) => run.sourceSequenceIndex!)
    .filter(
      (sourceSequenceIndex) => sourceSequenceIndex < atom.sourceSequenceIndex!,
    )
  const followingEquationIndexes = nearbyEquationRuns
    .map((run) => run.sourceSequenceIndex!)
    .filter(
      (sourceSequenceIndex) => sourceSequenceIndex > atom.sourceSequenceIndex!,
    )
  if (
    precedingEquationIndexes.length === 0 ||
    followingEquationIndexes.length === 0 ||
    atom.sourceSequenceIndex - Math.max(...precedingEquationIndexes) > 4 ||
    Math.min(...followingEquationIndexes) - atom.sourceSequenceIndex > 4
  ) {
    return null
  }

  const stackedHosts = nearbyEquationLines
    .flatMap((candidate) => {
      const baselineBands: PdfSourceRun[][] = []
      for (const run of candidate.runs
        .filter((candidateRun) => candidateRun.text.trim())
        .sort(
          (left, right) =>
            left.y + left.height / 2 - (right.y + right.height / 2) ||
            left.x - right.x,
        )) {
        const centerY = run.y + run.height / 2
        const band = baselineBands.find((candidateBand) => {
          const bandCenterY = median(
            candidateBand.map(
              (candidateRun) => candidateRun.y + candidateRun.height / 2,
            ),
          )
          const bandHeight = Math.max(
            ...candidateBand.map((candidateRun) => candidateRun.height),
          )
          return (
            Math.abs(centerY - bandCenterY) <=
            Math.max(0.0025, Math.min(run.height, bandHeight) * 0.45)
          )
        })
        if (band) band.push(run)
        else baselineBands.push([run])
      }
      return baselineBands.map((runs) => {
        const x = Math.min(...runs.map((run) => run.x))
        const y = Math.min(...runs.map((run) => run.y))
        const right = Math.max(...runs.map((run) => run.x + run.width))
        const bottom = Math.max(...runs.map((run) => run.y + run.height))
        return {
          line: candidate,
          runs,
          x,
          y,
          width: right - x,
          height: bottom - y,
        }
      })
    })
    .filter((candidate) => {
      if (
        candidate.runs.length === 0 ||
        !candidate.runs.some(
          (run) =>
            run.sourceSequenceIndex !== undefined &&
            Math.abs(run.sourceSequenceIndex - atom.sourceSequenceIndex!) <=
              4 &&
            run.page === atom.page &&
            run.rotation === atom.rotation &&
            run.method === atom.method,
        )
      ) {
        return false
      }
      const overlap = Math.max(
        0,
        Math.min(line.x + line.width, candidate.x + candidate.width) -
          Math.max(line.x, candidate.x),
      )
      const minimumWidth = Math.min(line.width, candidate.width)
      const candidateCenterX = candidate.x + candidate.width / 2
      const candidateCenterY = candidate.y + candidate.height / 2
      const minimumHeight = Math.min(line.height, candidate.height)
      const verticalGap = Math.max(
        line.y - (candidate.y + candidate.height),
        candidate.y - (line.y + line.height),
        0,
      )
      return (
        minimumWidth > 0 &&
        overlap >= minimumWidth * 0.8 &&
        Math.abs(atomCenterX - candidateCenterX) <=
          Math.max(0.006, minimumWidth * 0.2) &&
        Math.abs(atomCenterY - candidateCenterY) >=
          Math.max(0.004, minimumHeight * 0.75) &&
        verticalGap <= Math.max(0.018, minimumHeight * 1.4)
      )
    })
  return stackedHosts.length === 1 ? stackedHosts[0].line : null
}

export function visibleSourceSequenceIndexes(line: PdfTextLine) {
  const visibleRuns = line.runs.filter((run) => run.text.trim())
  const sourceSequenceIndexes = visibleRuns.flatMap((run) =>
    run.sourceSequenceIndex === undefined ? [] : [run.sourceSequenceIndex],
  )
  return sourceSequenceIndexes.length === visibleRuns.length
    ? sourceSequenceIndexes
    : null
}

export function sourceProvenMultiComponentDisplayCluster(
  anchor: ClassifiedLine,
  lines: readonly ClassifiedLine[],
): ClassifiedLine[] | null {
  if (
    anchor.kind !== 'equation' ||
    !/(?:=|≤|≥|≈|≠)/u.test(anchor.text) ||
    proseDominantInlineMathLine(anchor)
  ) {
    return null
  }
  const anchorRuns = anchor.runs.filter((run) => run.text.trim())
  const anchorSequenceIndexes = visibleSourceSequenceIndexes(anchor)
  if (
    anchorRuns.length === 0 ||
    !anchorSequenceIndexes ||
    new Set(anchorSequenceIndexes).size !== anchorSequenceIndexes.length
  ) {
    return null
  }
  const anchorSource = anchorRuns[0]
  const anchorStart = Math.min(...anchorSequenceIndexes)
  const anchorEnd = Math.max(...anchorSequenceIndexes)
  const anchorCenterY = anchor.y + anchor.height / 2
  const equationNumberCandidates = lines.filter((candidate) => {
    if (
      candidate === anchor ||
      candidate.page !== anchor.page ||
      !/^\(\s*\d+(?:\.\d+)*\s*\)$/u.test(candidate.text.trim()) ||
      candidate.x < anchor.x + anchor.width ||
      Math.abs(candidate.y + candidate.height / 2 - anchorCenterY) >
        Math.max(0.05, anchor.height * 4)
    ) {
      return false
    }
    const runs = candidate.runs.filter((run) => run.text.trim())
    const sequenceIndexes = visibleSourceSequenceIndexes(candidate)
    return (
      runs.length > 0 &&
      sequenceIndexes !== null &&
      Math.min(...sequenceIndexes) > anchorEnd &&
      Math.min(...sequenceIndexes) - anchorEnd <= 128 &&
      runs.every(
        (run) =>
          run.page === anchorSource.page &&
          run.rotation === anchorSource.rotation &&
          run.method === anchorSource.method,
      )
    )
  })
  if (equationNumberCandidates.length !== 1) return null
  const equationNumber = equationNumberCandidates[0]
  const equationNumberSequenceIndexes =
    visibleSourceSequenceIndexes(equationNumber)!
  const sequenceEnd = Math.max(...equationNumberSequenceIndexes)
  const corridorLeft = anchor.x - Math.max(0.025, anchor.height * 2)
  const corridorRight =
    equationNumber.x +
    equationNumber.width +
    Math.max(0.015, equationNumber.height)
  const corridorTop = anchor.y - Math.max(0.045, anchor.height * 3.5)
  const corridorBottom =
    anchor.y + anchor.height + Math.max(0.065, anchor.height * 5)
  const sequenceIntersectingLines = lines.filter((candidate) => {
    if (candidate.page !== anchor.page) return false
    const sequenceIndexes = visibleSourceSequenceIndexes(candidate)
    return (
      sequenceIndexes !== null &&
      sequenceIndexes.some(
        (sourceSequenceIndex) =>
          sourceSequenceIndex >= anchorStart &&
          sourceSequenceIndex <= sequenceEnd,
      )
    )
  })
  const members = sequenceIntersectingLines.filter((candidate) => {
    const sequenceIndexes = visibleSourceSequenceIndexes(candidate)!
    const visibleRuns = candidate.runs.filter((run) => run.text.trim())
    return (
      sequenceIndexes.every(
        (sourceSequenceIndex) =>
          sourceSequenceIndex >= anchorStart &&
          sourceSequenceIndex <= sequenceEnd,
      ) &&
      candidate.x >= corridorLeft &&
      candidate.x + candidate.width <= corridorRight &&
      candidate.y >= corridorTop &&
      candidate.y + candidate.height <= corridorBottom &&
      visibleRuns.every(
        (run) =>
          run.page === anchorSource.page &&
          run.rotation === anchorSource.rotation &&
          run.method === anchorSource.method,
      )
    )
  })
  if (
    members.length < 8 ||
    members.length !== sequenceIntersectingLines.length ||
    !members.includes(anchor) ||
    !members.includes(equationNumber)
  ) {
    return null
  }
  const allSequenceIndexes = members
    .flatMap((member) => visibleSourceSequenceIndexes(member)!)
    .sort((left, right) => left - right)
  if (
    new Set(allSequenceIndexes).size !== allSequenceIndexes.length ||
    allSequenceIndexes[0] !== anchorStart ||
    allSequenceIndexes.at(-1) !== sequenceEnd ||
    allSequenceIndexes
      .slice(1)
      .some(
        (sourceSequenceIndex, index) =>
          sourceSequenceIndex - allSequenceIndexes[index] > 4,
      )
  ) {
    return null
  }

  const numericNumerators = members.filter((candidate) => {
    if (!/^[+-]?\d+(?:[.,]\d+)?$/u.test(candidate.text.trim())) return false
    return candidate.y + candidate.height / 2 < anchorCenterY
  })
  const extensionFont = (fontName: string) =>
    /(?:CMEX|MathExtensions?)/iu.test(fontName)
  const mathFont = (fontName: string) =>
    /(?:cmmi|cmsy|cmex|math|symbol)/iu.test(fontName)
  const denominatorHosts = new Set<ClassifiedLine>()
  for (const numerator of numericNumerators) {
    const numeratorSequenceIndexes = visibleSourceSequenceIndexes(numerator)!
    const numeratorEnd = Math.max(...numeratorSequenceIndexes)
    const numeratorCenterX = numerator.x + numerator.width / 2
    const denominatorCandidates = members.filter((candidate) => {
      if (candidate === numerator || denominatorHosts.has(candidate)) {
        return false
      }
      return candidate.runs.some((run) => {
        if (
          !run.text.trim() ||
          run.sourceSequenceIndex === undefined ||
          run.sourceSequenceIndex <= numeratorEnd ||
          extensionFont(run.fontName) ||
          !mathFont(run.fontName)
        ) {
          return false
        }
        const runCenterX = run.x + run.width / 2
        const runCenterY = run.y + run.height / 2
        return (
          runCenterY - (numerator.y + numerator.height / 2) >= 0.004 &&
          runCenterY - (numerator.y + numerator.height / 2) <=
            Math.max(0.04, numerator.height * 3) &&
          Math.abs(runCenterX - numeratorCenterX) <=
            Math.max(0.035, numerator.width * 0.9)
        )
      })
    })
    if (denominatorCandidates.length === 1) {
      denominatorHosts.add(denominatorCandidates[0])
    }
  }
  const extensionRuns = members.flatMap((member) =>
    member.runs.filter((run) => run.text.trim() && extensionFont(run.fontName)),
  )
  if (
    numericNumerators.length < 2 ||
    denominatorHosts.size < 2 ||
    extensionRuns.length < 3
  ) {
    return null
  }
  return members
}

export function promoteSourceProvenMultiComponentDisplayClusters(
  lines: ClassifiedLine[],
  layout: ColumnLayout,
) {
  const resolvedColumnAuthority =
    layout.accepted &&
    !layout.ambiguous &&
    layout.resolution?.status === 'resolved'
  const proposals = lines.flatMap((anchor) => {
    const members = sourceProvenMultiComponentDisplayCluster(anchor, lines)
    return members &&
      (!resolvedColumnAuthority ||
        members.every((member) => member.column === anchor.column))
      ? [{ anchor, members }]
      : []
  })
  const accepted = proposals.filter(
    (proposal) =>
      !proposals.some(
        (candidate) =>
          candidate !== proposal &&
          candidate.members.some((member) => proposal.members.includes(member)),
      ),
  )
  for (const { anchor, members } of accepted) {
    const seedId = `${anchor.id}-source-bounded-display-cluster`
    for (const member of members) {
      member.kind = 'equation'
      member.confidence = Math.max(member.confidence, 0.98)
      member.displayEquationClusterSeedId = seedId
    }
  }
}

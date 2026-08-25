import type { PdfSourceRun } from './import-types'
import { mergePdfRunText, type PdfTextLine } from './pdf-lines'
import { copyPdfLinkedTokenSourceAnnotations } from './pdf-links'
import { isQuarterTurn } from './pdf-furniture'
import { inlineStackedFragmentOrder } from './pdf-reading-order'
import { sanitizeXmlText } from './publication-integrity'

function unpublishableText(text: string) {
  return text.includes('\ufffd') || sanitizeXmlText(text) !== text
}

export function unresolvedMathExtensionLine(line: PdfTextLine) {
  return line.runs.some(
    (run) => /CMEX\d*/iu.test(run.fontName) && unpublishableText(run.text),
  )
}

export function proseDominantPdfMathSource(source: {
  text: string
  width: number
  runs: readonly PdfSourceRun[]
}) {
  const text = source.text.replace(/\s+/gu, ' ').trim()
  const proseWords = text.match(/\p{L}{3,}/gu) ?? []
  const visibleRuns = source.runs.filter((run) => run.text.trim())
  const visibleCharacters = visibleRuns.reduce(
    (total, run) => total + run.text.replace(/\s/gu, '').length,
    0,
  )
  const mathCharacters = visibleRuns.reduce(
    (total, run) =>
      total +
      (/(?:cmmi|cmsy|cmex|math|symbol)/iu.test(run.fontName)
        ? run.text.replace(/\s/gu, '').length
        : 0),
    0,
  )
  const proseFontShare =
    visibleCharacters > 0 ? 1 - mathCharacters / visibleCharacters : 1
  const numberedInstruction =
    /^(?:\d+|[A-Za-z])[.)]\s+\p{Lu}/u.test(text) && proseWords.length >= 3
  const relationCount = (text.match(/(?:<=|>=|==|!=|=|≤|≥|≈|≠|<|>)/gu) ?? [])
    .length
  const alphabeticTokenCount = (text.match(/\p{L}{2,}/gu) ?? []).length
  const strongMathSignal =
    /[\p{Script=Greek}\p{N}∆_=+*/<>^−×÷≤≥≈≠∼⊙∂∞∏∈∉→←∫∑√]/u.test(text)
  const openingDelimiter = /[\p{Ps}\p{Pi}]/u
  const closingDelimiter = /[\p{Pe}\p{Pf}]/u
  const delimiterDepth = (value: string) =>
    Array.from(value).reduce(
      (depth, character) =>
        depth +
        Number(openingDelimiter.test(character)) -
        Number(closingDelimiter.test(character)),
      0,
    )
  const insideSourceDelimiter = (start: number, end: number) => {
    const before = text.slice(0, start)
    const after = text.slice(end)
    const pairedStraightQuote = ['"', "'"].some(
      (quote) => before.lastIndexOf(quote) >= 0 && after.indexOf(quote) >= 0,
    )
    return (
      delimiterDepth(before) > 0 ||
      delimiterDepth(after) < 0 ||
      pairedStraightQuote
    )
  }
  const compactMathContext = /[\p{Script=Greek}∆_=+*/<>^−×÷≤≥≈≠∼⊙∂∞∏∈∉→←∫∑√]/u
  const compactLeftAtom = /[\p{L}\p{N}\p{Pe}]/u
  const compactRightAtom = /[\p{L}\p{N}\p{Ps}]/u
  const delimitedUnsupportedAlphabeticTokens = [
    ...text.matchAll(/\p{L}{2,}/gu),
  ].flatMap((match) => {
    const word = match[0]
    const start = match.index
    const end = start + word.length
    const compactBefore =
      compactMathContext.test(text[start - 1] ?? '') &&
      compactLeftAtom.test(text[start - 2] ?? '')
    const compactAfter =
      compactMathContext.test(text[end] ?? '') &&
      compactRightAtom.test(text[end + 1] ?? '')
    const compactSymbolIdentifier =
      Array.from(word).length <= 3 && (compactBefore || compactAfter)
    return insideSourceDelimiter(start, end) &&
      !/^\p{Ll}\p{Lu}$/u.test(word) &&
      !/^d(?:\p{Ll}|\p{Script=Greek}){1,2}$/u.test(word) &&
      !/\p{Script=Greek}/u.test(word) &&
      !compactSymbolIdentifier &&
      !/^(?:arg|cosh?|det|diag|dim|exp|gcd|lim|log|max|min|mod|sinh?|sqrt|tanh?|var)$/iu.test(
        word,
      )
      ? [{ word, start, end }]
      : []
  })
  const unresolvedDelimitedProse =
    unpublishableText(text) &&
    (delimitedUnsupportedAlphabeticTokens.length >= 2 ||
      delimitedUnsupportedAlphabeticTokens.some(({ end }) =>
        /^[^\p{L}]{0,8}[.!?]/u.test(text.slice(end)),
      ))
  const shortWordSentence =
    alphabeticTokenCount >= 3 &&
    relationCount === 0 &&
    (!strongMathSignal || /[.!?](?:\s|$)/u.test(text))
  const narrowProseSentence =
    source.width < 0.3 &&
    proseWords.length >= 4 &&
    proseFontShare >= 0.7 &&
    relationCount <= 1 &&
    /(?:[.!?]\s*$|[,;:](?:\s|$)|\s[-–—]\s)/u.test(text) &&
    /\b(?:this|that|these|those|is|are|was|were|be|been|being|has|have|had|with|without|not|remains?|after|before|because|while|where|which|who|we|our|their)\b/iu.test(
      text,
    )
  const narrowProseLeadIn =
    source.width < 0.3 &&
    proseFontShare >= 0.7 &&
    relationCount === 0 &&
    alphabeticTokenCount >= 1 &&
    text.includes(':')
  return (
    numberedInstruction ||
    unresolvedDelimitedProse ||
    shortWordSentence ||
    narrowProseLeadIn ||
    narrowProseSentence ||
    (source.width >= 0.3 && proseWords.length >= 4 && proseFontShare >= 0.5)
  )
}

export function proseDominantInlineMathLine(line: PdfTextLine) {
  return proseDominantPdfMathSource(line)
}

export function marginBand(
  source: Pick<PdfTextLine, 'x' | 'y' | 'width' | 'height'> & {
    rotation?: number
  },
) {
  return (
    source.y <= 0.1 ||
    source.y + source.height >= 0.9 ||
    (isQuarterTurn(source.rotation ?? 0) &&
      (source.x <= 0.12 || source.x + source.width >= 0.88))
  )
}

export function textLineFromRuns(
  source: PdfTextLine,
  runs: PdfTextLine['runs'],
) {
  const left = Math.min(...runs.map((run) => run.x))
  const top = Math.min(...runs.map((run) => run.y))
  const right = Math.max(...runs.map((run) => run.x + run.width))
  const bottom = Math.max(...runs.map((run) => run.y + run.height))
  const fragment = {
    ...source,
    text: mergePdfRunText(runs),
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    fontSize: Math.max(...runs.map((run) => run.fontSize)),
    runs,
  }
  copyPdfLinkedTokenSourceAnnotations(source, fragment)
  return fragment
}

function computerModernMathSourceRun(
  run: PdfTextLine['runs'][number],
  maximumFontSize: number,
) {
  const text = run.text.replace(/\s+/gu, ' ').trim()
  if (!text) return false
  if (/(?:^|[+_-])CM(?:MI|SY|EX)\d*(?:$|[+_-])/iu.test(run.fontName)) {
    return true
  }
  if (!/(?:^|[+_-])CMR\d*(?:$|[+_-])/iu.test(run.fontName)) return false
  const proseWords = text.match(/\p{L}{3,}/gu) ?? []
  return (
    run.fontSize <= maximumFontSize * 0.82 ||
    proseWords.length === 0 ||
    (proseWords.length === 1 &&
      /^(?:arg|cosh?|diag|exp|min|max|log|sinh?|sqrt|tanh?|var)\b/iu.test(text))
  )
}

function horizontallyStackedMathPair(
  left: PdfTextLine['runs'][number],
  right: PdfTextLine['runs'][number],
  maximumFontSize: number,
) {
  if (
    left.fontSize > maximumFontSize * 0.86 ||
    right.fontSize > maximumFontSize * 0.86
  ) {
    return false
  }
  const horizontalOverlap = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
  const minimumWidth = Math.min(left.width, right.width)
  if (
    minimumWidth <= 0 ||
    horizontalOverlap < minimumWidth * 0.7 ||
    Math.abs(left.x + left.width / 2 - (right.x + right.width / 2)) >
      Math.max(0.008, Math.max(left.width, right.width) * 0.3)
  ) {
    return false
  }
  const leftCenterY = left.y + left.height / 2
  const rightCenterY = right.y + right.height / 2
  const minimumHeight = Math.min(left.height, right.height)
  const verticalGap = Math.max(
    left.y - (right.y + right.height),
    right.y - (left.y + left.height),
    0,
  )
  return (
    Math.abs(leftCenterY - rightCenterY) >=
      Math.max(0.003, minimumHeight * 0.45) &&
    verticalGap <= Math.max(0.006, minimumHeight * 0.7)
  )
}

function horizontalBoxGap(
  left: PdfTextLine['runs'][number],
  right: PdfTextLine['runs'][number],
) {
  return Math.max(
    left.x - (right.x + right.width),
    right.x - (left.x + left.width),
    0,
  )
}

export function sourceStackedMathPairs(
  runs: PdfTextLine['runs'],
  maximumFontSize: number,
) {
  return runs.flatMap((left, leftIndex) =>
    runs
      .slice(leftIndex + 1)
      .flatMap((right) =>
        horizontallyStackedMathPair(left, right, maximumFontSize)
          ? [[left, right] as const]
          : [],
      ),
  )
}

export function sourceInlineFractionPairs(line: PdfTextLine) {
  const runs = line.runs.filter((run) => run.text.trim())
  if (runs.length < 2 || runs.some(mathExtensionSourceRun)) return []
  const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
  // PDF placement alone cannot distinguish a stacked numerator/denominator
  // from simultaneous super/subscripts, including mixed letter pairs such as
  // x/y beside a coefficient. Preserve every such pair as a two-dimensional
  // equation obligation instead of guessing canonical inline semantics.
  return sourceStackedMathPairs(runs, maximumFontSize)
}

function verticalLineOverlap(left: PdfTextLine, right: PdfTextLine) {
  return Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  )
}

function mathExtensionSourceRun(run: PdfTextLine['runs'][number]) {
  return (
    /(?:^|[+_-])CMEX\d*(?:$|[+_-])/iu.test(run.fontName) ||
    /^[∑∫∏√]$/u.test(run.text.trim())
  )
}

/**
 * Large operators can cause PDF.js to split one visual row into two source
 * lines: the operator and its scripts land in one line while a neighboring
 * fraction plus prose land in another. Coalesce only the proved source case:
 * a vertically interleaved math-extension line beside a companion that owns a
 * small stacked pair and prose before the operator. The ordinary inline
 * splitter can then retain prose and crop the complete 2-D formula envelope.
 */
function mergeInterleavedStackedFormulaLines(lines: PdfTextLine[]) {
  const claimed = new Set<number>()
  const mergedAt = new Map<number, PdfTextLine>()

  for (const [lineIndex, line] of lines.entries()) {
    if (claimed.has(lineIndex)) continue
    const extensionRuns = line.runs.filter(mathExtensionSourceRun)
    if (extensionRuns.length === 0) continue
    const extensionLeft = Math.min(...extensionRuns.map((run) => run.x))
    const candidates = lines
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidate, candidateIndex }) => {
        if (
          candidateIndex === lineIndex ||
          claimed.has(candidateIndex) ||
          candidate.page !== line.page
        ) {
          return false
        }
        const overlap = verticalLineOverlap(line, candidate)
        if (overlap < Math.min(line.height, candidate.height) * 0.45) {
          return false
        }
        const maximumFontSize = Math.max(
          ...candidate.runs.map((run) => run.fontSize),
        )
        const pairs = sourceStackedMathPairs(candidate.runs, maximumFontSize)
        if (pairs.length === 0) return false
        const pairNearExtension = pairs.some((pair) =>
          pair.some((run) =>
            extensionRuns.some(
              (extension) => horizontalBoxGap(run, extension) <= 0.02,
            ),
          ),
        )
        if (!pairNearExtension) return false
        return candidate.runs.some(
          (run) =>
            run.x + run.width <= extensionLeft &&
            !computerModernMathSourceRun(run, maximumFontSize) &&
            (run.text.match(/\p{L}{2,}/gu)?.length ?? 0) > 0,
        )
      })
      .sort(
        (left, right) =>
          Math.abs(left.candidate.y - line.y) -
            Math.abs(right.candidate.y - line.y) ||
          left.candidateIndex - right.candidateIndex,
      )
    const match = candidates[0]
    if (!match) continue

    const runs = [...line.runs, ...match.candidate.runs].sort(
      (left, right) => left.x - right.x || left.y - right.y,
    )
    const merged = textLineFromRuns(line, runs)
    const outputIndex = Math.min(lineIndex, match.candidateIndex)
    mergedAt.set(outputIndex, merged)
    claimed.add(lineIndex)
    claimed.add(match.candidateIndex)
  }

  return lines.flatMap((line, lineIndex) => {
    const merged = mergedAt.get(lineIndex)
    if (merged) return [merged]
    return claimed.has(lineIndex) ? [] : [line]
  })
}

/**
 * A PDF text line can contain a prose prefix and a visually stacked fraction
 * or simultaneous super/subscripts. Linear text merging cannot distinguish
 * those semantics. Split the source-backed two-dimensional run geometry,
 * retaining the prose runs as ordinary text and the exact run envelope as an
 * equation crop candidate.
 */
export function splitSourceStackedInlineFormulaLines(lines: PdfTextLine[]) {
  return mergeInterleavedStackedFormulaLines(lines).flatMap(
    (line, lineIndex) => {
      const runs = line.runs.filter((run) => run.text.trim())
      if (runs.length < 2) return [line]
      const maximumFontSize = Math.max(...runs.map((run) => run.fontSize))
      const stackedPairs = sourceStackedMathPairs(runs, maximumFontSize)
      if (stackedPairs.length === 0) return [line]
      const baseId = `page-${String(line.page).padStart(3, '0')}-inline-stacked-${String(lineIndex + 1).padStart(4, '0')}`
      const withFragmentLineage = (
        fragmentLine: PdfTextLine,
        part: 'before' | 'formula' | 'after',
      ) => {
        const visibleRuns = fragmentLine.runs.filter((run) => run.text.trim())
        const sourceSequenceIndexes = visibleRuns.flatMap((run) =>
          run.sourceSequenceIndex === undefined
            ? []
            : [run.sourceSequenceIndex],
        )
        const sourceFragmentLineage =
          sourceSequenceIndexes.length === visibleRuns.length &&
          new Set(sourceSequenceIndexes).size === sourceSequenceIndexes.length
            ? {
                algorithm: 'source-run-fragment-v1' as const,
                sourceLineId: line.id ?? baseId,
                fragment: `inline-stacked-${part}` as const,
                sourceSequenceIndexes,
              }
            : undefined
        return {
          ...fragmentLine,
          ...(sourceFragmentLineage ? { sourceFragmentLineage } : {}),
        }
      }

      const formulaRuns = new Set(stackedPairs.flat())
      let expanded = true
      while (expanded) {
        expanded = false
        for (const candidate of runs) {
          const compactCandidateText = candidate.text.replace(/\s+/gu, '')
          const adjacentBaselineAnchor =
            candidate.fontSize >= maximumFontSize * 0.9 &&
            /^[\p{L}\p{N})\]}]{1,4}$/u.test(compactCandidateText) &&
            stackedPairs.some((pair) => {
              const pairLeft = Math.min(...pair.map((run) => run.x))
              const pairCenters = pair
                .map((run) => run.y + run.height / 2)
                .sort((left, right) => left - right)
              const horizontalGap = pairLeft - (candidate.x + candidate.width)
              const candidateCenter = candidate.y + candidate.height / 2
              return (
                !pair.includes(candidate) &&
                horizontalGap >= -0.001 &&
                horizontalGap <= Math.max(0.004, candidate.width * 0.45) &&
                candidateCenter > pairCenters[0] &&
                candidateCenter < pairCenters[1]
              )
            })
          if (
            formulaRuns.has(candidate) ||
            (!computerModernMathSourceRun(candidate, maximumFontSize) &&
              !adjacentBaselineAnchor)
          ) {
            continue
          }
          if (
            [...formulaRuns].some(
              (owned) => horizontalBoxGap(owned, candidate) <= 0.02,
            )
          ) {
            formulaRuns.add(candidate)
            expanded = true
          }
        }
      }
      const formulaLeft = Math.min(...[...formulaRuns].map((run) => run.x))
      const formulaRight = Math.max(
        ...[...formulaRuns].map((run) => run.x + run.width),
      )
      for (const candidate of runs) {
        if (
          !formulaRuns.has(candidate) &&
          /^[,.;:!?()[\]{}]+$/u.test(candidate.text.trim()) &&
          horizontalBoxGap(candidate, {
            ...candidate,
            x: formulaLeft,
            width: formulaRight - formulaLeft,
          }) <= 0.008
        ) {
          formulaRuns.add(candidate)
        }
      }
      const beforeRuns = runs.filter(
        (run) => !formulaRuns.has(run) && run.x + run.width <= formulaLeft,
      )
      const afterRuns = runs.filter(
        (run) => !formulaRuns.has(run) && run.x >= formulaRight,
      )
      const unownedRuns = runs.filter(
        (run) =>
          !formulaRuns.has(run) &&
          !beforeRuns.includes(run) &&
          !afterRuns.includes(run),
      )
      const proseWordCount =
        [...beforeRuns, ...afterRuns]
          .map((run) => run.text)
          .join(' ')
          .match(/\p{L}{2,}/gu)?.length ?? 0
      const hasProseSiblings = beforeRuns.length > 0 || afterRuns.length > 0
      if (unownedRuns.length > 0 || (hasProseSiblings && proseWordCount < 2)) {
        // The stacked source geometry is still ambiguous even when the
        // surrounding text cannot be split conservatively. Withhold the whole
        // line as one equation obligation rather than publishing guessed
        // super/subscript semantics.
        return [
          withFragmentLineage({ ...line, id: `${baseId}-formula` }, 'formula'),
        ]
      }

      const fragments: PdfTextLine[] = []
      if (beforeRuns.length > 0) {
        fragments.push(
          withFragmentLineage(
            {
              ...textLineFromRuns(line, beforeRuns),
              id: `${baseId}-before`,
            },
            'before',
          ),
        )
      }
      fragments.push(
        withFragmentLineage(
          {
            ...textLineFromRuns(
              line,
              [...formulaRuns].sort(
                (left, right) => left.x - right.x || left.y - right.y,
              ),
            ),
            id: `${baseId}-formula`,
          },
          'formula',
        ),
      )
      if (afterRuns.length > 0) {
        fragments.push(
          withFragmentLineage(
            {
              ...textLineFromRuns(line, afterRuns),
              id: `${baseId}-after`,
            },
            'after',
          ),
        )
      }
      return fragments
    },
  )
}

export function splitDetachedMathExtensionProseRuns(lines: PdfTextLine[]) {
  const mathFont = (fontName: string) =>
    /(?:cmmi|cmsy|cmex|math|symbol)/iu.test(fontName)
  const extensionFont = (fontName: string) =>
    /(?:CMEX|MathExtensions)/iu.test(fontName)
  const sourceLineId = (line: PdfTextLine, lineIndex: number) =>
    line.id ??
    `page-${String(line.page).padStart(3, '0')}-source-line-${String(lineIndex + 1).padStart(4, '0')}`
  const lineIndexes = new Map(lines.map((line, lineIndex) => [line, lineIndex]))
  const exactRadicalHosts = new Map<PdfSourceRun, string>()
  const exactHostLineIds = new Map<PdfTextLine, string>()
  const runEntries = lines.flatMap((line) =>
    line.runs.filter((run) => run.text.trim()).map((run) => ({ line, run })),
  )

  for (const { line: rootLine, run: root } of runEntries) {
    if (
      root.text.trim() !== '√' ||
      !extensionFont(root.fontName) ||
      root.sourceSequenceIndex === undefined
    ) {
      continue
    }
    const candidates = runEntries.filter(({ line, run: candidate }) => {
      if (
        line === rootLine ||
        line.page !== rootLine.page ||
        candidate.sourceSequenceIndex !== root.sourceSequenceIndex! + 1 ||
        !candidate.text.trim() ||
        extensionFont(candidate.fontName) ||
        !mathFont(candidate.fontName)
      ) {
        return false
      }
      if (
        root.sourceTextPaint &&
        candidate.sourceTextPaint &&
        (root.sourceTextPaint.textLedgerSha256 !==
          candidate.sourceTextPaint.textLedgerSha256 ||
          root.sourceTextPaint.operatorLedgerSha256 !==
            candidate.sourceTextPaint.operatorLedgerSha256)
      ) {
        return false
      }
      const horizontalTolerance = Math.max(0.00001, root.width * 0.001)
      const radicalBottom = root.y + root.height
      const verticalTolerance = Math.max(0.001, root.height * 0.08)
      const fontSizeRatio = candidate.fontSize / root.fontSize
      const heightRatio = candidate.height / root.height
      return (
        Math.abs(candidate.x - (root.x + root.width)) <= horizontalTolerance &&
        candidate.y > root.y + root.height * 0.5 &&
        Math.abs(candidate.y - radicalBottom) <= verticalTolerance &&
        fontSizeRatio >= 0.65 &&
        fontSizeRatio <= 1.5 &&
        heightRatio >= 0.65 &&
        heightRatio <= 1.5
      )
    })
    if (candidates.length !== 1) continue
    const hostLine = candidates[0].line
    const hostLineIndex = lineIndexes.get(hostLine)
    if (hostLineIndex === undefined) continue
    const hostLineId = sourceLineId(hostLine, hostLineIndex)
    exactHostLineIds.set(hostLine, hostLineId)
    exactRadicalHosts.set(root, hostLineId)
  }
  const probableHost = (line: PdfTextLine) => {
    if (proseDominantInlineMathLine(line)) return false
    if (/-inline-stacked-\d+-formula$/u.test(line.id ?? '')) return true
    const runs = line.runs.filter((run) => run.text.trim())
    const visibleCharacters = runs.reduce(
      (total, run) => total + run.text.replace(/\s+/gu, '').length,
      0,
    )
    const mathCharacters = runs
      .filter((run) => mathFont(run.fontName))
      .reduce((total, run) => total + run.text.replace(/\s+/gu, '').length, 0)
    return (
      visibleCharacters > 0 &&
      mathCharacters / visibleCharacters >= 0.7 &&
      /[=+−×÷∫∑√≤≥≈]/u.test(line.text)
    )
  }
  const hosts = lines.filter(probableHost)
  const boxDistance = (run: PdfSourceRun, line: PdfTextLine) => {
    const horizontalGap = Math.max(
      line.x - (run.x + run.width),
      run.x - (line.x + line.width),
      0,
    )
    const verticalGap = Math.max(
      line.y - (run.y + run.height),
      run.y - (line.y + line.height),
      0,
    )
    const centerDistance = Math.abs(
      run.x + run.width / 2 - (line.x + line.width / 2),
    )
    return verticalGap * 2 + horizontalGap + centerDistance * 0.05
  }

  return lines.flatMap((line, lineIndex) => {
    const preparedLine =
      !line.id && exactHostLineIds.has(line)
        ? { ...line, id: exactHostLineIds.get(line)! }
        : line
    const runs = line.runs.filter((run) => run.text.trim())
    const extensionRuns = runs.filter(
      (run) =>
        extensionFont(run.fontName) &&
        /^[√∫∑∏()[\]{}|]+$/u.test(run.text.trim()),
    )
    const proseRuns = runs.filter((run) => !extensionRuns.includes(run))
    if (extensionRuns.length === 0) return [preparedLine]
    const fallbackProseCue =
      proseRuns.length > 0 &&
      proseDominantPdfMathSource({
        text: proseRuns.map((run) => run.text).join(' '),
        width:
          Math.max(...proseRuns.map((run) => run.x + run.width)) -
          Math.min(...proseRuns.map((run) => run.x)),
        runs: proseRuns,
      })
    const exactDetached = extensionRuns.filter((run) =>
      exactRadicalHosts.has(run),
    )
    if (!fallbackProseCue && exactDetached.length === 0) return [preparedLine]
    const maximumProseFontSize =
      proseRuns.length > 0
        ? Math.max(...proseRuns.map((run) => run.fontSize))
        : 0
    const proseBaselineCenter =
      proseRuns.length > 0
        ? proseRuns.reduce((total, run) => total + run.y + run.height / 2, 0) /
          proseRuns.length
        : 0
    const detachedHosts = new Map<PdfSourceRun, string | null>()
    const detached = extensionRuns.filter((run) => {
      const exactHost = exactRadicalHosts.get(run)
      if (exactHost) {
        detachedHosts.set(run, exactHost)
        return true
      }
      if (!fallbackProseCue) return false
      if (
        run.fontSize > maximumProseFontSize * 0.82 ||
        Math.abs(run.y + run.height / 2 - proseBaselineCenter) <
          Math.max(0.002, run.height * 0.3)
      ) {
        return false
      }
      const candidates = hosts
        .filter((host) => {
          if (host === line || host.page !== line.page || !host.id) return false
          const horizontalGap = Math.max(
            host.x - (run.x + run.width),
            run.x - (host.x + host.width),
            0,
          )
          const verticalGap = Math.max(
            host.y - (run.y + run.height),
            run.y - (host.y + host.height),
            0,
          )
          return horizontalGap <= 0.02 && verticalGap <= 0.018
        })
        .map((host) => ({ host, score: boxDistance(run, host) }))
        .sort(
          (left, right) =>
            left.score - right.score ||
            sourceLineFlowOrder(left.host, right.host),
        )
      const uniquelyHosted =
        candidates.length > 0 &&
        (candidates.length === 1 ||
          candidates[1].score - candidates[0].score > 0.0015)
      if (uniquelyHosted) {
        detachedHosts.set(run, candidates[0].host.id!)
      } else {
        // A visibly displaced extension glyph is not prose merely because two
        // nearby formula hosts are tied. Split it into an explicit unresolved
        // equation obligation; retaining it in the cue would silently publish
        // the prose while allowing both candidate formulas to omit the glyph.
        detachedHosts.set(run, null)
      }
      return true
    })
    if (detached.length === 0) return [preparedLine]
    const retainedRuns = runs.filter((run) => !detached.includes(run))
    const fragments: PdfTextLine[] =
      retainedRuns.length > 0
        ? [
            {
              ...textLineFromRuns(preparedLine, retainedRuns),
              id: preparedLine.id,
            },
          ]
        : []
    for (const [index, run] of detached.entries()) {
      const detachedSourceLineId = sourceLineId(preparedLine, lineIndex)
      const hostLineId = detachedHosts.get(run)
      fragments.push({
        ...textLineFromRuns(preparedLine, [run]),
        id: `${detachedSourceLineId}-detached-math-${String(index + 1).padStart(3, '0')}-host-${
          hostLineId ? encodeURIComponent(hostLineId) : 'ambiguous'
        }`,
      })
    }
    return fragments
  })
}

export function sourceLineFlowOrder(left: PdfTextLine, right: PdfTextLine) {
  if (left.page !== right.page) return left.page - right.page
  const inlineOrder = inlineStackedFragmentOrder(left, right)
  return inlineOrder ?? (left.y - right.y || left.x - right.x)
}

import type {
  NormalizedSourceBox,
  PdfLineBoundaryDecision,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfRegionLine,
} from './import-types'
import { joinPdfLineTexts, type PdfTextLine } from './pdf-lines'
import { copyPdfLinkedTokenSourceAnnotations } from './pdf-links'
import { beginsVisualCaption, type ClassifiedLine } from './pdf-page-layout'
import {
  dominantLineHeight,
  sourceProvenDetachedDisplayEquationAtomHost,
  sourceProvenDominantBaselineSequentialWrap,
  sourceProvenLexicalHyphenContinuation,
  standaloneSectionHeading,
  visibleSourceSequenceIndexes,
} from './pdf-semantic-recovery'
import {
  unresolvedMathExtensionLine,
  sourceLineFlowOrder,
} from './pdf-source-math'

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}
function median(values: number[]) {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

export function lineBelongsToNativeVisual(
  line: PdfTextLine,
  objects: PdfPageAnalysis['objects'],
) {
  const centerX = line.x + line.width / 2
  const centerY = line.y + line.height / 2
  return (objects ?? [])
    .filter(
      (object) =>
        object.role !== 'scan-source' &&
        object.box.width * object.box.height <= 0.72,
    )
    .some((object) => {
      const padding = Math.max(0.012, Math.min(0.04, line.height * 2.5))
      return (
        centerX >= object.box.x - padding &&
        centerX <= object.box.x + object.box.width + padding &&
        centerY >= object.box.y - padding &&
        centerY <= object.box.y + object.box.height + padding
      )
    })
}

export function lineBox(line: PdfTextLine): NormalizedSourceBox {
  return {
    page: line.page,
    x: rounded(line.x),
    y: rounded(line.y),
    width: rounded(line.width),
    height: rounded(line.height),
    rotation: line.runs[0]?.rotation ?? 0,
    method: line.runs.some((run) => run.method === 'ocr') ? 'ocr' : 'pdf-text',
  }
}

export function unionBox(lines: PdfRegionLine[]): NormalizedSourceBox {
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

export function unionRunBox(
  runs: PdfRegionLine['runs'],
): NormalizedSourceBox | null {
  if (runs.length === 0) return null
  const left = Math.min(...runs.map((run) => run.x))
  const top = Math.min(...runs.map((run) => run.y))
  const right = Math.max(...runs.map((run) => run.x + run.width))
  const bottom = Math.max(...runs.map((run) => run.y + run.height))
  return {
    page: runs[0].page,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
    rotation: runs[0].rotation,
    method: runs.some((run) => run.method === 'ocr') ? 'ocr' : 'pdf-text',
  }
}

export function joinsRegion(
  previous: ClassifiedLine,
  line: ClassifiedLine,
  hardHyphenLexicon: ReadonlySet<string>,
) {
  if (previous.page !== line.page) return false
  if (
    unresolvedMathExtensionLine(previous) ||
    unresolvedMathExtensionLine(line)
  ) {
    return false
  }
  if (previous.kind !== line.kind || previous.column !== line.column)
    return false
  if (previous.tabularGridBandId || line.tabularGridBandId) {
    return (
      previous.tabularGridBandId !== undefined &&
      previous.tabularGridBandId === line.tabularGridBandId
    )
  }
  const standaloneListMarker = (text: string) =>
    /^(?:\d{1,3}|[A-Za-z]|[ivxlcdm]+)[.)]$/iu.test(text.trim())
  if (line.kind !== 'caption' && standaloneListMarker(line.text)) {
    return false
  }
  if (
    previous.kind !== 'caption' &&
    standaloneListMarker(previous.text) &&
    line.x > previous.x + previous.width &&
    line.x - (previous.x + previous.width) <= 0.12 &&
    Math.abs(line.y - previous.y) <=
      Math.max(0.004, Math.max(previous.height, line.height) * 0.4)
  ) {
    return true
  }
  if (previous.headingContinuationSeedId) return false
  if (line.kind === 'caption' && beginsVisualCaption(line.text)) return false
  if (standaloneSectionHeading(previous) || standaloneSectionHeading(line)) {
    return false
  }
  if (
    (line.kind === 'footnote' || line.kind === 'endnote') &&
    line.noteLabel !== null
  ) {
    return false
  }
  if (line.kind === 'chart-label' || line.kind === 'page-number') return false
  // A printed display-equation number is often emitted as a standalone line at
  // the right edge of a column.  Do not merge it into the prose explanation
  // that begins below and to its left: the visual pass needs the detached
  // fragment so it can attach the number to the aligned equation instead of
  // layout interpreting `(4) where ...` as an ordered-list item.
  if (
    /^\(\s*\d+[a-z]?\s*\)$/iu.test(previous.text.trim()) &&
    line.x + Math.max(0.08, line.width * 0.2) < previous.x
  ) {
    return false
  }
  if (
    previous.page === 1 &&
    previous.y < 0.3 &&
    /(?:,|\s(?:and|&)\s)/i.test(previous.text) &&
    /(?:university|institute|department|laborator(?:y|ies)|\blab\b|school|college|centre|center|hospital|academy|research group)/i.test(
      line.text,
    )
  ) {
    return false
  }
  const listItem =
    /^(?:[•◦▪‣–—-]|\[\s*\d+\s*\]|\(\s*(?:\d+|[A-Za-z]|[ivxlcdm]+)\s*\)|(?:\d+|[A-Za-z]|[ivxlcdm]+)[.)])\s+/iu
  if (
    line.kind !== 'caption' &&
    listItem.test(line.text.trim()) &&
    !sourceProvenLexicalHyphenContinuation(previous, line, hardHyphenLexicon)
  ) {
    return false
  }
  if (sourceProvenDominantBaselineSequentialWrap(previous, line)) {
    return true
  }
  const gap = line.y - (previous.y + previous.height)
  const fontRatio =
    Math.max(previous.fontSize, line.fontSize) /
    Math.max(1, Math.min(previous.fontSize, line.fontSize))
  if (gap < -0.004 || fontRatio > 1.18) return false
  // Scripts legitimately expand the source-backed line envelope, but they do
  // not expand the body leading that decides whether the next baseline starts
  // a new paragraph. Using the full union here can merge separate paragraphs
  // whenever a subscript or superscript reaches toward the following line.
  const lineHeight = Math.max(
    dominantLineHeight(previous),
    dominantLineHeight(line),
  )
  return gap <= Math.max(0.014, lineHeight * 1.25)
}

function beginsRepeatedFirstLineIndent(
  group: ClassifiedLine[],
  line: ClassifiedLine,
) {
  if (group.length < 2) return false
  const first = group[0]
  const previous = group.at(-1)!
  if (
    line.page !== first.page ||
    line.kind !== first.kind ||
    line.column !== first.column
  ) {
    return false
  }
  const continuationX = median(group.slice(1).map((candidate) => candidate.x))
  const indent = first.x - continuationX
  const tolerance = Math.max(0.007, first.height * 0.45)
  return (
    Math.abs(indent) >= Math.max(0.012, first.height * 0.75) &&
    Math.abs(line.x - first.x) <= tolerance &&
    Math.abs(previous.x - continuationX) <= tolerance
  )
}

function endsProseSentence(line: ClassifiedLine) {
  return /[.!?](?:["'’”\])}]*)$/u.test(line.text.trim())
}

function beginsUppercaseProse(line: ClassifiedLine) {
  return /^\p{Lu}/u.test(line.text.trim())
}

function beginsIndentedParagraph(
  group: ClassifiedLine[],
  line: ClassifiedLine,
) {
  if (group.length < 2 || !beginsUppercaseProse(line)) return false
  const previous = group.at(-1)!
  if (!endsProseSentence(previous)) return false
  const continuationX = median(
    group.slice(-Math.min(5, group.length)).map((candidate) => candidate.x),
  )
  const lineHeight = Math.max(
    dominantLineHeight(previous),
    dominantLineHeight(line),
  )
  return line.x - continuationX >= Math.max(0.012, lineHeight * 0.75)
}

function runUsesEmphasizedOrItalicFace(run: ClassifiedLine['runs'][number]) {
  return (
    run.bold === true ||
    run.italic === true ||
    /(?:bold|semibold|demi|medi(?:um)?|black|italic|ital|oblique)/iu.test(
      run.fontName,
    ) ||
    /(?:^|[+,._\s-])cm(?:bx|b|ti|it|sl)\d*(?=$|[+,._\s-])/iu.test(run.fontName)
  )
}

function beginsStyledRunInParagraph(
  group: ClassifiedLine[],
  line: ClassifiedLine,
) {
  if (group.length === 0 || !beginsUppercaseProse(line)) return false
  const previous = group.at(-1)!
  if (!endsProseSentence(previous)) return false
  const visibleRuns = [...line.runs]
    .filter((run) => run.text.trim())
    .sort((left, right) => left.x - right.x)
  if (
    visibleRuns.length === 0 ||
    !runUsesEmphasizedOrItalicFace(visibleRuns[0])
  ) {
    return false
  }
  const styledRunIn =
    visibleRuns.length > 1 &&
    visibleRuns.slice(1).some((run) => !runUsesEmphasizedOrItalicFace(run))
  const continuationX = median(
    group.slice(-Math.min(5, group.length)).map((candidate) => candidate.x),
  )
  const lineHeight = Math.max(
    dominantLineHeight(previous),
    dominantLineHeight(line),
  )
  const visiblyIndented =
    line.x - continuationX >= Math.max(0.012, lineHeight * 0.75)
  return styledRunIn || visiblyIndented
}

function beginsBlankLeadingParagraph(
  group: ClassifiedLine[],
  line: ClassifiedLine,
) {
  if (group.length === 0) return false
  const previous = group.at(-1)!
  if (
    previous.page !== line.page ||
    previous.kind !== line.kind ||
    previous.column !== line.column ||
    !['body', 'spanning'].includes(line.kind)
  ) {
    return false
  }
  const gap = line.y - (previous.y + previous.height)
  const lineHeight = Math.max(
    dominantLineHeight(previous),
    dominantLineHeight(line),
  )
  if (
    !endsProseSentence(previous) ||
    (/:\s*$/u.test(line.text.trim()) &&
      (line.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) <= 8)
  ) {
    return false
  }
  const priorGaps = group
    .slice(1)
    .map((candidate, index) => {
      const prior = group[index]
      return candidate.y - (prior.y + prior.height)
    })
    .filter(
      (candidateGap) =>
        candidateGap >= -0.002 && candidateGap <= lineHeight * 0.55,
    )
  if (priorGaps.length === 0) return false
  const threshold = Math.max(
    0.006,
    median(priorGaps) + lineHeight * 0.35,
    lineHeight * 0.5,
  )
  return gap >= threshold
}

function beginsParagraphBoundary(
  group: ClassifiedLine[],
  line: ClassifiedLine,
) {
  return (
    beginsRepeatedFirstLineIndent(group, line) ||
    beginsBlankLeadingParagraph(group, line) ||
    beginsIndentedParagraph(group, line) ||
    beginsStyledRunInParagraph(group, line)
  )
}

export function makeRegions(
  lines: ClassifiedLine[],
  hardHyphenLexicon: ReadonlySet<string>,
  unhyphenatedLexicon: ReadonlySet<string>,
  language: string | null,
  lineBoundaryDecisions: PdfLineBoundaryDecision[],
) {
  const groups: ClassifiedLine[][] = []
  const detachedDisplayEquationAtomHosts = new Map<
    ClassifiedLine,
    ClassifiedLine
  >()
  const displayEquationClusterGroups = new Map<string, ClassifiedLine[]>()
  const ordered = [...lines].sort((left, right) => {
    if (left.page !== right.page) return left.page - right.page
    const columnOrder = left.column.localeCompare(right.column)
    if (columnOrder !== 0) return columnOrder
    return sourceLineFlowOrder(left, right)
  })
  for (const line of ordered) {
    if (line.displayEquationClusterSeedId) {
      const clusterGroup = displayEquationClusterGroups.get(
        line.displayEquationClusterSeedId,
      )
      if (clusterGroup) clusterGroup.push(line)
      else {
        const group = [line]
        groups.push(group)
        displayEquationClusterGroups.set(
          line.displayEquationClusterSeedId,
          group,
        )
      }
      continue
    }
    const headingGroup = line.headingContinuationSeedId
      ? groups.find((group) =>
          group.some(
            (candidate) => candidate.id === line.headingContinuationSeedId,
          ),
        )
      : undefined
    if (headingGroup) {
      headingGroup.push(line)
      continue
    }
    const captionGroup = line.captionContinuationSeedId
      ? groups.find((group) =>
          group.some(
            (candidate) => candidate.id === line.captionContinuationSeedId,
          ),
        )
      : undefined
    if (captionGroup) {
      captionGroup.push(line)
      continue
    }
    const panelLabelGroup = line.panelLabelContinuationSeedId
      ? groups.find((group) =>
          group.some(
            (candidate) => candidate.id === line.panelLabelContinuationSeedId,
          ),
        )
      : undefined
    if (panelLabelGroup) {
      panelLabelGroup.push(line)
      continue
    }
    const previousGroup = groups.at(-1)
    const previous = previousGroup?.at(-1)
    const paragraphBoundary = previous
      ? beginsParagraphBoundary(previousGroup!, line)
      : false
    const detachedDisplayEquationAtomHost =
      previous && !paragraphBoundary
        ? sourceProvenDetachedDisplayEquationAtomHost(previous, line, ordered)
        : null
    if (detachedDisplayEquationAtomHost) {
      detachedDisplayEquationAtomHosts.set(
        line,
        detachedDisplayEquationAtomHost,
      )
    }
    if (
      previous &&
      !paragraphBoundary &&
      !detachedDisplayEquationAtomHost &&
      joinsRegion(previous, line, hardHyphenLexicon)
    )
      previousGroup!.push(line)
    else groups.push([line])
  }

  for (const [atom, host] of detachedDisplayEquationAtomHosts.entries()) {
    const atomGroup = groups.find((group) => group.includes(atom))
    const hostGroup = groups.find((group) => group.includes(host))
    if (!atomGroup || !hostGroup || atomGroup === hostGroup) continue
    // The atom boundary was proved before grouping, but move it only while it
    // remains a standalone region. Any later claimant makes the ownership
    // ambiguous and must leave the atom visible for review.
    if (atomGroup.length !== 1) continue
    const hostIndex = hostGroup.indexOf(host)
    if (hostIndex < 0) continue
    atom.kind = 'equation'
    atom.confidence = Math.max(atom.confidence, 0.98)
    hostGroup.splice(hostIndex, 0, atom)
    groups.splice(groups.indexOf(atomGroup), 1)
  }

  const sourceOrderedGroups = groups.sort((left, right) =>
    sourceLineFlowOrder(left[0], right[0]),
  )
  const pageCounters = new Map<number, number>()
  return sourceOrderedGroups.map<PdfPageRegion>((group) => {
    const page = group[0].page
    const number = (pageCounters.get(page) ?? 0) + 1
    pageCounters.set(page, number)
    const id = `page-${String(page).padStart(3, '0')}-region-${String(number).padStart(3, '0')}`
    const orderedGroup = group[0].tabularGridBandId
      ? [...group].sort((left, right) => left.x - right.x || left.y - right.y)
      : group[0].displayEquationClusterSeedId
        ? [...group].sort((left, right) => {
            const leftSequenceIndexes = visibleSourceSequenceIndexes(left) ?? []
            const rightSequenceIndexes =
              visibleSourceSequenceIndexes(right) ?? []
            return (
              Math.min(...leftSequenceIndexes) -
                Math.min(...rightSequenceIndexes) ||
              sourceLineFlowOrder(left, right)
            )
          })
        : group.some((line) => line.headingContinuationSeedId)
          ? [...group].sort(
              (left, right) => left.y - right.y || left.x - right.x,
            )
          : group
    const regionLines = orderedGroup.map<PdfRegionLine>((line) => {
      const visibleRuns = line.runs.filter((run) => run.text.trim())
      const sourceSequenceIndexes = visibleRuns.flatMap((run) =>
        run.sourceSequenceIndex === undefined ? [] : [run.sourceSequenceIndex],
      )
      const sourceFragmentLineage =
        line.sourceFragmentLineage ??
        (sourceSequenceIndexes.length === visibleRuns.length &&
        new Set(sourceSequenceIndexes).size === sourceSequenceIndexes.length
          ? {
              algorithm: 'source-run-fragment-v1' as const,
              sourceLineId: line.id,
              fragment: 'whole' as const,
              sourceSequenceIndexes,
            }
          : undefined)
      const regionLine = {
        id: line.id,
        text: line.text,
        fontSize: rounded(line.fontSize),
        box: lineBox(line),
        runs: line.runs.map((run) => ({ ...run })),
        ...(line.captionContinuationSeedId
          ? {
              captionContinuationSeedId: line.captionContinuationSeedId,
            }
          : {}),
        ...(sourceFragmentLineage ? { sourceFragmentLineage } : {}),
      }
      copyPdfLinkedTokenSourceAnnotations(line, regionLine)
      return regionLine
    })
    const kind = orderedGroup[0].kind
    const furnitureEvidence = orderedGroup.find(
      (line) => line.furniture,
    )?.furniture
    const furnitureReview = orderedGroup.find(
      (line) => line.furnitureReview,
    )?.furnitureReview
    const sourceCaptionLaneBoundary = orderedGroup[0].sourceCaptionLaneBoundary
    const sourceCaptionLaneSide = orderedGroup[0].sourceCaptionLaneSide
    const sourceCaptionLane =
      sourceCaptionLaneBoundary !== undefined &&
      sourceCaptionLaneSide !== undefined &&
      orderedGroup.every(
        (line) =>
          line.sourceCaptionLaneBoundary === sourceCaptionLaneBoundary &&
          line.sourceCaptionLaneSide === sourceCaptionLaneSide,
      )
        ? {
            boundary: rounded(sourceCaptionLaneBoundary),
            side: sourceCaptionLaneSide,
          }
        : null
    return {
      id,
      page,
      kind,
      column: orderedGroup[0].column,
      text: joinPdfLineTexts(orderedGroup, {
        hardHyphenLexicon,
        unhyphenatedLexicon,
        language,
        regionId: id,
        decisions: lineBoundaryDecisions,
      }),
      confidence: rounded(
        Math.min(...orderedGroup.map((line) => line.confidence)),
      ),
      box: unionBox(regionLines),
      lines: regionLines,
      nativeObjectIds: [],
      includedInReadingOrder: ![
        'header',
        'footer',
        'page-number',
        'side',
        'chart-label',
      ].includes(kind),
      ...(furnitureEvidence ? { furniture: furnitureEvidence } : {}),
      ...(furnitureReview ? { furnitureReview } : {}),
      ...(sourceCaptionLane ? { sourceCaptionLane } : {}),
    }
  })
}

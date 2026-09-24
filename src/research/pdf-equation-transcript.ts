import type { PdfPageRegion } from './import-types'
import {
  computerOrLatinModernMathFont,
  equationTranscriptResolved,
  lineHasSourceScriptGeometry,
  lineHasUnencodedSourceScriptGeometry,
  sourceEquationLineText,
  sourceMathFontProvenance,
  unpublishableEquationTranscriptText,
  unreliableMathExtensionRun,
} from './pdf-equation-source-math'
import {
  hasAmbiguousStackedEquationGeometry,
  numericListAssignmentFragment,
  sourceMathFragment,
  sourceMathOperatorFragment,
} from './pdf-equation-fragment-evidence'
import { rounded } from './pdf-visual-matching'
import { boxGap } from './pdf-visual-figure-grouping'

type EquationTranscriptEvidence = {
  sourcePrintedEquationNumber: (region: PdfPageRegion) => string | null
  probableDisplayEquationText: (sourceText: string) => boolean
  printedEquationNumberFragment: (region: PdfPageRegion) => boolean
}

function sourceMathFontTranscript(
  regions: PdfPageRegion[],
  evidence: EquationTranscriptEvidence,
) {
  if (
    !equationTranscriptResolved(regions) ||
    !regions.some(
      (region) => evidence.sourcePrintedEquationNumber(region) !== null,
    )
  ) {
    return null
  }
  const lines = regions.flatMap((region) => region.lines)
  const runs = lines
    .flatMap((line) => line.runs)
    .filter((run) => run.text.trim())
  const sourceText = sourceEquationLineText(regions)
  const sourceCharactersComplete = lines.every(
    (line) =>
      line.runs
        .map((run) => run.text)
        .join('')
        .replace(/\s+/gu, '') === line.text.replace(/\s+/gu, ''),
  )
  const nonMathText = runs
    .filter((run) => !computerOrLatinModernMathFont(run.fontName))
    .map((run) => run.text)
    .join('')
  if (
    !sourceText ||
    sourceText.length > 240 ||
    !sourceCharactersComplete ||
    runs.filter((run) => computerOrLatinModernMathFont(run.fontName)).length <
      3 ||
    !lines.some(lineHasSourceScriptGeometry) ||
    /[^\s()[\]{},.;:_0-9]/u.test(nonMathText) ||
    !/[\p{L}\p{N})\]}]\s*=\s*[\p{L}\p{N}([{]/u.test(sourceText)
  ) {
    return null
  }
  return sourceText
}

function equationLineText(line: PdfPageRegion['lines'][number]) {
  const runs = [...line.runs]
    .filter(
      (run) =>
        run.text.trim() &&
        !unpublishableEquationTranscriptText(run.text) &&
        !unreliableMathExtensionRun(run),
    )
    .sort((left, right) => left.x - right.x || left.y - right.y)
  if (runs.length === 0) return line.text.trim()
  let text = ''
  for (const [index, run] of runs.entries()) {
    const next = run.text.trim()
    if (!next) continue
    if (!text) {
      text = next
      continue
    }
    const previous = runs[index - 1]
    const gap = Math.max(run.x - (previous.x + previous.width), 0)
    const attachedScript =
      run.fontSize <= previous.fontSize * 0.82 &&
      gap <= Math.max(0.006, previous.height * 0.75)
    const touchingGlyph = gap <= 0.0035
    text += `${attachedScript || touchingGlyph ? '' : ' '}${next}`
  }
  return text.replace(/\s+/g, ' ').trim()
}

export function equationSourceText(regions: PdfPageRegion[]) {
  return regions
    .flatMap((region) => region.lines)
    .sort(
      (left, right) =>
        left.box.y - right.box.y ||
        left.box.x - right.box.x ||
        left.id.localeCompare(right.id),
    )
    .map(equationLineText)
    .filter(Boolean)
    .join(' ')
}

function sourceRunUnionBox(
  runs: readonly PdfPageRegion['lines'][number]['runs'][number][],
) {
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
    method: runs.some((run) => run.method === 'ocr')
      ? ('ocr' as const)
      : ('pdf-text' as const),
  }
}

function sourceSequenceRunText(
  runs: readonly PdfPageRegion['lines'][number]['runs'][number][],
) {
  let text = ''
  for (const [index, run] of runs.entries()) {
    const token = run.text.trim()
    if (!token) continue
    const previous = runs[index - 1]
    const sourceWhitespace =
      previous !== undefined &&
      run.sourceWhitespaceBefore === 'pdf-text-item' &&
      run.sourceWhitespacePredecessorIndex === previous.sourceSequenceIndex
    text += `${text && sourceWhitespace ? ' ' : ''}${token}`
  }
  return text.replace(/\s+/gu, ' ').trim()
}

function sourceSequenceLinkedMathRuns(
  left: PdfPageRegion['lines'][number]['runs'][number],
  right: PdfPageRegion['lines'][number]['runs'][number],
) {
  return (
    (Number.isSafeInteger(left.sourceSequenceIndex) &&
      right.sourceWhitespaceBefore === 'pdf-text-item' &&
      right.sourceWhitespacePredecessorIndex === left.sourceSequenceIndex) ||
    (Number.isSafeInteger(right.sourceSequenceIndex) &&
      left.sourceWhitespaceBefore === 'pdf-text-item' &&
      left.sourceWhitespacePredecessorIndex === right.sourceSequenceIndex)
  )
}

export function splitSourceProvedAnswerCueEquations(
  regions: PdfPageRegion[],
  consumedRegionIds: ReadonlySet<string>,
) {
  const existingRegionIds = new Set(regions.map((region) => region.id))
  const existingLineIds = new Set(
    regions.flatMap((region) => region.lines.map((line) => line.id)),
  )
  for (let regionIndex = 0; regionIndex < regions.length; regionIndex += 1) {
    const region = regions[regionIndex]
    if (
      consumedRegionIds.has(region.id) ||
      !['body', 'spanning'].includes(region.kind) ||
      region.lines.length !== 1 ||
      region.nativeObjectIds.length > 0 ||
      !region.includedInReadingOrder
    ) {
      continue
    }
    const line = region.lines[0]
    const visibleRuns = line.runs.filter((run) => run.text.trim())
    if (
      visibleRuns.length < 3 ||
      visibleRuns.some(
        (run) => !Number.isSafeInteger(run.sourceSequenceIndex),
      ) ||
      new Set(visibleRuns.map((run) => run.sourceSequenceIndex)).size !==
        visibleRuns.length
    ) {
      continue
    }
    const sourceOrderedRuns = [...visibleRuns].sort(
      (left, right) => left.sourceSequenceIndex! - right.sourceSequenceIndex!,
    )
    let cueRuns: typeof sourceOrderedRuns | null = null
    let equationRuns: typeof sourceOrderedRuns | null = null
    let cueText = ''
    for (
      let prefixLength = 1;
      prefixLength < sourceOrderedRuns.length;
      prefixLength += 1
    ) {
      const candidateCueRuns = sourceOrderedRuns.slice(0, prefixLength)
      const candidateCueText = sourceSequenceRunText(candidateCueRuns)
      if (!/^(?:final\s+)?answer\s*:\s*$/iu.test(candidateCueText)) {
        continue
      }
      const candidateEquationRuns = sourceOrderedRuns.slice(prefixLength)
      if (
        candidateEquationRuns.length === 0 ||
        candidateEquationRuns.some(
          (run) => sourceMathFontProvenance(run.fontName) === null,
        )
      ) {
        continue
      }
      cueRuns = candidateCueRuns
      equationRuns = candidateEquationRuns
      cueText = candidateCueText
      break
    }
    if (!cueRuns || !equationRuns) continue

    const adjacentMathRegions = regions.filter((candidate) => {
      if (
        candidate.id === region.id ||
        candidate.page !== region.page ||
        consumedRegionIds.has(candidate.id) ||
        !(
          candidate.kind === 'equation' ||
          sourceMathFragment(candidate) ||
          sourceMathOperatorFragment(candidate)
        )
      ) {
        return false
      }
      const gap = boxGap(region.box, candidate.box)
      if (
        gap.horizontal > 0.08 ||
        gap.vertical > 0.04 ||
        !(
          region.column === candidate.column ||
          region.column === 'span' ||
          candidate.column === 'span'
        )
      ) {
        return false
      }
      return equationRuns!.some((equationRun) =>
        candidate.lines.some((candidateLine) =>
          candidateLine.runs.some((candidateRun) =>
            sourceSequenceLinkedMathRuns(equationRun, candidateRun),
          ),
        ),
      )
    })
    if (adjacentMathRegions.length === 0) continue

    const equationRegionId = `${region.id}-answer-equation`
    const equationLineId = `${line.id}-answer-equation`
    if (
      existingRegionIds.has(equationRegionId) ||
      existingLineIds.has(equationLineId)
    ) {
      continue
    }
    const cueBox = sourceRunUnionBox(cueRuns)
    const equationBox = sourceRunUnionBox(equationRuns)
    const equationText = sourceSequenceRunText(equationRuns)
    const equationRegion: PdfPageRegion = {
      ...region,
      id: equationRegionId,
      kind: 'equation',
      text: equationText,
      box: equationBox,
      lines: [
        {
          id: equationLineId,
          text: equationText,
          fontSize: line.fontSize,
          box: equationBox,
          runs: equationRuns,
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: false,
    }
    region.text = cueText
    region.box = cueBox
    region.lines = [
      {
        id: line.id,
        text: cueText,
        fontSize: line.fontSize,
        box: cueBox,
        runs: cueRuns,
      },
    ]
    regions.splice(regionIndex + 1, 0, equationRegion)
    existingRegionIds.add(equationRegionId)
    existingLineIds.add(equationLineId)
    regionIndex += 1
  }
}

export function sourceSequenceEquationOwnerRegionIds(
  candidate: PdfPageRegion,
  regions: readonly PdfPageRegion[],
  hasDisplayEquationEvidence: (
    region: PdfPageRegion,
    regions: readonly PdfPageRegion[],
  ) => boolean,
) {
  return new Set(
    regions
      .filter(
        (region) =>
          region.id !== candidate.id &&
          region.page === candidate.page &&
          region.kind === 'equation' &&
          hasDisplayEquationEvidence(region, regions) &&
          region.lines.some((line) =>
            line.runs.some((ownerRun) =>
              candidate.lines.some((candidateLine) =>
                candidateLine.runs.some((candidateRun) =>
                  sourceSequenceLinkedMathRuns(ownerRun, candidateRun),
                ),
              ),
            ),
          ),
      )
      .map((region) => region.id),
  )
}

export function hasUnprovedTwoDimensionalEquationTranscript(
  regions: readonly PdfPageRegion[],
) {
  return (
    hasAmbiguousStackedEquationGeometry([...regions]) ||
    regions.some((region) =>
      region.lines.some(lineHasUnencodedSourceScriptGeometry),
    )
  )
}

export function sourceEquationTranscript(
  regions: PdfPageRegion[],
  evidence: EquationTranscriptEvidence,
) {
  // PDF text order cannot distinguish a tightly stacked numerator/denominator
  // from a linear continuation. Preserve the source crop, but do not invent a
  // one-dimensional semantic transcript for that geometry.
  if (hasUnprovedTwoDimensionalEquationTranscript(regions)) return null
  // Likewise, source font geometry can prove that a run is a superscript or
  // subscript while the extracted line text merely concatenates that run with
  // its base. Unless the transcript itself carries an explicit script marker,
  // publishing the flattened text would certify semantics the source extractor
  // did not recover.
  const reconstructed = equationSourceText(regions)
  const sourceOwnedMathTranscript =
    regions.some(
      (region) =>
        region.kind === 'equation' &&
        evidence.probableDisplayEquationText(equationSourceText([region])),
    ) &&
    regions.every(
      (region) =>
        region.kind === 'equation' ||
        sourceMathFragment(region) ||
        numericListAssignmentFragment(region) ||
        evidence.printedEquationNumberFragment(region),
    )
  if (
    equationTranscriptResolved(regions) &&
    (evidence.probableDisplayEquationText(reconstructed) ||
      sourceOwnedMathTranscript)
  ) {
    return {
      text: reconstructed,
      evidence: ['source-text-alt'],
    }
  }
  const mathFontTranscript = sourceMathFontTranscript(regions, evidence)
  return mathFontTranscript
    ? {
        text: mathFontTranscript,
        evidence: [
          'source-text-alt',
          'source-math-font-transcript',
          'source-script-geometry',
        ],
      }
    : null
}

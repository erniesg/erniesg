import type {
  NormalizedSourceBox,
  PdfPageRegion,
  PdfVisualAsset,
} from './import-types'
import {
  contextualNeutralVerticalEllipsisFragment,
  mathExtensionGlyphFragment,
  sourceMathExtensionScaffoldFragment,
  sourceMathFontProvenance,
  unresolvedMathExtensionRegion,
} from './pdf-equation-source-math'
import {
  bareNumericMathFragment,
  contextualSourceRomanScriptFragment,
  detachedMathHostProvenance,
  hasAmbiguousStackedEquationGeometry,
  numericListAssignmentFragment,
  sourceMathFontOnlyContinuation,
  sourceMathFragment,
  sourceMathOperatorFragment,
  sourceUprightMathOperatorContinuation,
} from './pdf-equation-fragment-evidence'
import { equationSourceText } from './pdf-equation-transcript'
import {
  completeSingleSourcePdfVisualAsset as completeSingleSourceAsset,
  materiallyOverlapsPdfSourceText as materiallyOverlapsSourceText,
} from './pdf-visual-source-crops'
import {
  FIGURE_OVERLAY_BOX_TOLERANCE,
  horizontalOverlapRatio,
  type VisualCandidate,
} from './pdf-visual-matching'
import { intersectionArea } from './pdf-visual-figure-lineage'
import { boxGap } from './pdf-visual-figure-grouping'

const MIN_EXACT_CROP_NATIVE_OBJECT_CONTAINMENT = 0.99
export const MAX_DISPLAY_EQUATION_WIDTH = 0.82

export function sourceEquationRendition(
  caption: PdfPageRegion,
  textSources: PdfPageRegion[],
  regions: PdfPageRegion[],
  objectAssetIds: ReadonlyMap<string, string | null>,
  objectBoxes: ReadonlyMap<string, NormalizedSourceBox>,
  assetStore: ReadonlyMap<string, PdfVisualAsset>,
): VisualCandidate | null {
  const captionBottom = caption.box.y + caption.box.height
  const candidates = regions
    .filter((region) => {
      if (
        region.page !== caption.page ||
        region.nativeObjectIds.length !== 1 ||
        !['figure', 'equation'].includes(region.kind) ||
        !materiallyOverlapsSourceText(region, textSources)
      ) {
        return false
      }
      const distance = region.box.y - captionBottom
      const overlap = Math.max(
        0,
        Math.min(
          region.box.x + region.box.width,
          caption.box.x + caption.box.width,
        ) - Math.max(region.box.x, caption.box.x),
      )
      return (
        distance >= -0.02 &&
        distance <= 0.16 &&
        overlap >= Math.min(region.box.width, caption.box.width) * 0.35
      )
    })
    .flatMap((region) => {
      const sourceObjectId = region.nativeObjectIds[0]
      const assetId = objectAssetIds.get(sourceObjectId)
      const sourceBox = objectBoxes.get(sourceObjectId)
      const visualAsset = assetId ? assetStore.get(assetId) : undefined
      return sourceBox &&
        assetId &&
        completeSingleSourceAsset(visualAsset, sourceObjectId, sourceBox)
        ? [
            {
              region,
              sourceObjectId,
              sourceBox,
              assetId,
              visualAsset: visualAsset!,
            },
          ]
        : []
    })
    .sort(
      (left, right) =>
        Math.abs(left.region.box.y - captionBottom) -
          Math.abs(right.region.box.y - captionBottom) ||
        left.sourceObjectId.localeCompare(right.sourceObjectId),
    )
  const selected = candidates[0]
  if (!selected) return null
  return {
    kind: 'equation',
    sourceRegionIds: [
      ...textSources.map((region) => region.id),
      selected.region.id,
    ],
    sourceLineIds: textSources.flatMap((region) =>
      region.lines.map((line) => line.id),
    ),
    sourceObjectIds: [selected.sourceObjectId],
    assetIds: [selected.assetId],
    sourceBoxes: [selected.sourceBox],
    sourceText: equationSourceText(textSources),
    page: selected.region.page,
    column: selected.region.column,
    evidence: [
      selected.visualAsset.kind === 'raster'
        ? 'source-glyph-raster'
        : 'source-glyph-vector',
      'accessible-source-text',
      'bounded-source-geometry',
    ],
  }
}

export function exactCropUniquelyOwnsNativeObject({
  sourceCropBox,
  ownerSourceBox,
  objectBox,
  ownerCaption,
  figureCaptions,
}: {
  sourceCropBox: NormalizedSourceBox
  ownerSourceBox: NormalizedSourceBox
  objectBox: NormalizedSourceBox
  ownerCaption: PdfPageRegion
  figureCaptions: readonly PdfPageRegion[]
}) {
  const objectArea = objectBox.width * objectBox.height
  if (
    objectArea <= 0 ||
    objectBox.page !== sourceCropBox.page ||
    objectBox.page !== ownerCaption.page ||
    intersectionArea(sourceCropBox, objectBox) / objectArea <
      MIN_EXACT_CROP_NATIVE_OBJECT_CONTAINMENT ||
    intersectionArea(ownerSourceBox, objectBox) / objectArea <
      MIN_EXACT_CROP_NATIVE_OBJECT_CONTAINMENT ||
    objectBox.y + objectBox.height >
      ownerCaption.box.y + FIGURE_OVERLAY_BOX_TOLERANCE ||
    horizontalOverlapRatio(sourceCropBox, ownerCaption.box) < 0.35
  ) {
    return false
  }
  return !figureCaptions.some(
    (caption) =>
      caption.id !== ownerCaption.id &&
      caption.page === ownerCaption.page &&
      caption.box.y >= objectBox.y - FIGURE_OVERLAY_BOX_TOLERANCE &&
      caption.box.y <=
        ownerCaption.box.y +
          ownerCaption.box.height +
          FIGURE_OVERLAY_BOX_TOLERANCE &&
      horizontalOverlapRatio(sourceCropBox, caption.box) >= 0.35,
  )
}

function displayEquationProseCue(text: string) {
  const proseWords = text.match(/[A-Za-z]{2,}/g) ?? []
  return (
    proseWords.length >= 2 &&
    /\b(?:the|this|that|these|those|we|our|for|with|from|where|which|using|use|used|each|value|model|models|result|results|example|examples|figure|table|equation|performance|activating|because|namely|allowing|represents|output|number|sharp|discontinuity|simple|optimizer|epochs|trained|gains|point|moving)\b/iu.test(
      text,
    )
  )
}

export function probableDisplayEquationText(sourceText: string) {
  const text = sourceText.replace(/\s+/g, ' ').trim()
  if (!text || text.length > 240) return false
  if (
    /^(?:\d{1,3}|[A-Za-z])[.)]\s+\S/u.test(text) ||
    /^\(\s*\d{1,3}\s*\)\s+\S/u.test(text) ||
    /^\(\s*[a-z]\s*\)\s+\S(?:.*\S)?\s+\(\s*[a-z]\s*=\s*[-+]?\d+(?:\.\d+)?\s*\)$/iu.test(
      text,
    )
  ) {
    return false
  }
  if (
    /(?:https?:\/\/|www\.|openreview|forum\?id=|\bdoi\s*:|\S+@\S+)/iu.test(
      text,
    ) ||
    /(?:^|\s)(?:id|doi)\s*=\s*[A-Za-z0-9_-]{6,}\.?$/u.test(text) ||
    /^(?:[A-Za-z0-9._~-]{1,32}\?)?(?:id|d|doi)=[A-Za-z0-9_-]{6,}\.?$/u.test(
      text,
    )
  ) {
    return false
  }
  if (
    /^(?:\d+(?:\.\d+)?\s+)?[rp]\s*=\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s+[rp]\s*=\s*[-+]?(?:\d+(?:\.\d+)?|\.\d+))*$/iu.test(
      text,
    )
  ) {
    return false
  }
  if (/^[\s=+\-−×÷≤≥≈∼⊙→←]+$/u.test(text)) return false
  const proseWords = text.match(/[A-Za-z]{2,}/g) ?? []
  if (displayEquationProseCue(text)) return false
  const operators = text.match(/[=+\-−×÷∫∑√≤≥≈∼⊙∂∞∏∈∉→←]/gu)?.length ?? 0
  const compactLength = text.replace(/\s+/g, '').length
  const operatorDensity = compactLength > 0 ? operators / compactLength : 0
  const formulaOnly =
    /^[\p{L}\p{N}\p{Script=Greek}\s()[\]{},.|+*/=<>_^\-−×÷≤≥≈∼⊙∂∞∏∈∉→←]+$/u.test(
      text,
    )
  const hasRelation =
    /[\p{L}\p{N})\]}]\s*(?:=+|≤|≥|≈|∼|∈|∉|→|←)\s*[\p{L}\p{N}([{]/u.test(text)
  const hasLargeOperator = /[∫∑√∂∞∏⊙]/u.test(text)
  if (formulaOnly && proseWords.length === 0 && operators > 0) return true
  if (hasRelation) return proseWords.length <= 3 || operatorDensity >= 0.1
  return (
    (hasLargeOperator || operators > 0) &&
    proseWords.length <= 1 &&
    operatorDensity >= 0.12
  )
}

export function hasMathExtensionFontProvenance(region: PdfPageRegion) {
  return region.lines.some((line) =>
    line.runs.some(
      (run) =>
        sourceMathFontProvenance(run.fontName)?.role === 'math-extension' &&
        run.text.trim(),
    ),
  )
}

export function isProbableDisplayEquation(region: PdfPageRegion) {
  const fontOrGeometryEvidence =
    hasMathExtensionFontProvenance(region) ||
    unresolvedMathExtensionRegion(region) ||
    hasAmbiguousStackedEquationGeometry([region])
  return (
    region.kind === 'equation' &&
    region.lines.length > 0 &&
    (probableDisplayEquationText(region.text) ||
      sourceMathFontOnlyContinuation(region) ||
      (fontOrGeometryEvidence && sourceMathFragment(region)))
  )
}

export function compactEquationFragment(region: PdfPageRegion) {
  const text = region.text.trim()
  return (
    region.lines.length > 0 &&
    text.length > 0 &&
    text.length <= 12 &&
    !/\s/u.test(text) &&
    /^[\p{L}\p{N}()[\]{}.,|+*/=<>_\-−×÷≤≥≈∼⊙∂∞∏∈∉→←]+$/u.test(text) &&
    (/[\p{N}=−×÷≤≥≈∼⊙∂∞∏∈∉→←]/u.test(text) || /\p{Script=Greek}/u.test(text))
  )
}

export function printedEquationNumberFragment(region: PdfPageRegion) {
  return /^\(\s*\d+(?:\.\d+){0,3}[a-z]?\s*\)$/i.test(region.text.trim())
}

export function sourcePrintedEquationNumber(region: PdfPageRegion) {
  const text = region.text.replace(/\s+/gu, ' ').trim()
  const fragment = text.match(/^\(\s*(\d+(?:\.\d+){0,3}[a-z]?)\s*\)$/iu)?.[1]
  if (fragment) return fragment

  const embeddedMarginNumbers = region.lines.flatMap((line) => {
    const number = /^\(\s*(\d+(?:\.\d+){0,3}[a-z]?)\s*\)$/iu.exec(
      line.text.trim(),
    )?.[1]
    return number && line.box.x >= 0.72 ? [{ line, number }] : []
  })
  if (
    embeddedMarginNumbers.length === 1 &&
    region.lines.some((line) => {
      if (line.id === embeddedMarginNumbers[0].line.id) return false
      const lineFragment = {
        ...region,
        text: line.text,
        box: line.box,
        lines: [line],
      }
      return (
        hasMathExtensionFontProvenance(lineFragment) ||
        sourceMathFragment(lineFragment)
      )
    })
  ) {
    return embeddedMarginNumbers[0].number
  }

  const terminal = /(?:[,;]\s*|\s+)\(\s*(\d+(?:\.\d+){0,3}[a-z]?)\s*\)$/iu.exec(
    text,
  )
  if (!terminal || terminal.index <= 0) return null
  const formulaPrefix = text.slice(0, terminal.index).trim()
  const compactFormulaContinuation =
    region.kind === 'equation' &&
    (formulaPrefix.match(/[A-Za-z]{2,}/gu)?.length ?? 0) <= 2 &&
    /[=+\-−×÷∫∑√≤≥≈∼⊙∂∞∏∈∉→←]/u.test(formulaPrefix)
  return /(?:=+|≤|≥|≈|∼|∈|∉|→|←)/u.test(formulaPrefix) ||
    probableDisplayEquationText(formulaPrefix) ||
    compactFormulaContinuation
    ? terminal[1]
    : null
}

export function alignedPrintedEquationNumber(
  source: PdfPageRegion,
  candidate: PdfPageRegion,
) {
  if (!printedEquationNumberFragment(candidate)) return false
  const sameEquationLane =
    source.column === candidate.column ||
    source.column === 'span' ||
    candidate.column === 'span'
  const sourceRight = source.box.x + source.box.width
  const crossColumnMarginContinuation =
    source.column === 'left' &&
    candidate.column === 'right' &&
    sourceRight >= 0.6 &&
    candidate.box.x >= 0.72
  // A printed number in the adjacent column can be vertically aligned with a
  // display by coincidence. Permit that margin label only after the owned
  // equation envelope itself reaches across the page midpoint; a narrow
  // left-column fraction cannot claim a right-column number.
  if (!sameEquationLane && !crossColumnMarginContinuation) return false
  const gap = boxGap(source.box, candidate.box)
  const sourceCenter = source.box.y + source.box.height / 2
  const candidateCenter = candidate.box.y + candidate.box.height / 2
  const aligned =
    Math.abs(sourceCenter - candidateCenter) <=
    Math.max(0.018, source.box.height, candidate.box.height)
  const toRight = candidate.box.x >= source.box.x + source.box.width
  const inRightMarginBand =
    candidate.box.x >= Math.max(0.65, source.box.x + source.box.width * 0.65)
  const nearOrMarginAligned = gap.horizontal <= 0.08 || inRightMarginBand
  return aligned && (toRight || inRightMarginBand) && nearOrMarginAligned
}

function hasAlignedPrintedEquationNumber(
  source: PdfPageRegion,
  regions: readonly PdfPageRegion[],
) {
  return regions.some(
    (candidate) =>
      candidate.id !== source.id &&
      candidate.page === source.page &&
      alignedPrintedEquationNumber(source, candidate),
  )
}

function printedEquationNumbersForDisplayRegion(
  source: PdfPageRegion,
  regions: readonly PdfPageRegion[],
) {
  const numbers = new Set<string>()
  const ownNumber = sourcePrintedEquationNumber(source)
  if (ownNumber) numbers.add(ownNumber.toLocaleLowerCase())
  for (const candidate of regions) {
    if (
      candidate.id === source.id ||
      candidate.page !== source.page ||
      !alignedPrintedEquationNumber(source, candidate)
    ) {
      continue
    }
    const alignedNumber = sourcePrintedEquationNumber(candidate)
    if (alignedNumber) numbers.add(alignedNumber.toLocaleLowerCase())
  }
  return numbers
}

export function preservesPrintedEquationCardinality(
  displayRegions: PdfPageRegion[],
  candidate: PdfPageRegion,
  regions: readonly PdfPageRegion[],
) {
  const existingNumbers = new Set(
    displayRegions.flatMap((region) => [
      ...printedEquationNumbersForDisplayRegion(region, regions),
    ]),
  )
  const candidateNumbers = printedEquationNumbersForDisplayRegion(
    candidate,
    regions,
  )
  if (existingNumbers.size === 0 || candidateNumbers.size === 0) return true
  return new Set([...existingNumbers, ...candidateNumbers]).size === 1
}

export function hasDisplayEquationEvidence(
  source: PdfPageRegion,
  regions: readonly PdfPageRegion[],
) {
  const sourceLineIds = new Set(source.lines.map((line) => line.id))
  if (
    source.lines.some((line) => {
      const provenance = detachedMathHostProvenance(line.id)
      return (
        provenance?.kind === 'linked' &&
        !sourceLineIds.has(provenance.hostLineId)
      )
    })
  ) {
    return false
  }
  return (
    isProbableDisplayEquation(source) ||
    (source.kind === 'equation' &&
      ((sourcePrintedEquationNumber(source) !== null &&
        !printedEquationNumberFragment(source)) ||
        hasAlignedPrintedEquationNumber(source, regions)))
  )
}

export function adjacentDisplayEquationRegion(
  source: PdfPageRegion,
  candidate: PdfPageRegion,
  regions: readonly PdfPageRegion[],
) {
  const sameColumn =
    source.column === candidate.column ||
    source.column === 'span' ||
    candidate.column === 'span'
  const sourceNumber = sourcePrintedEquationNumber(source)
  const candidateNumber = sourcePrintedEquationNumber(candidate)
  const crossColumnNumberedContinuation =
    sourceNumber !== candidateNumber &&
    (sourceNumber !== null || candidateNumber !== null) &&
    !(sourceNumber !== null && candidateNumber !== null)
  if (
    source.page !== candidate.page ||
    (!sameColumn && !crossColumnNumberedContinuation)
  ) {
    return false
  }
  const gap = boxGap(source.box, candidate.box)
  const horizontalOverlap = Math.max(
    0,
    Math.min(
      source.box.x + source.box.width,
      candidate.box.x + candidate.box.width,
    ) - Math.max(source.box.x, candidate.box.x),
  )
  const minimumWidth = Math.min(source.box.width, candidate.box.width)
  const verticalOverlap = Math.max(
    0,
    Math.min(
      source.box.y + source.box.height,
      candidate.box.y + candidate.box.height,
    ) - Math.max(source.box.y, candidate.box.y),
  )
  const minimumHeight = Math.min(source.box.height, candidate.box.height)
  const sourceCenterY = source.box.y + source.box.height / 2
  const candidateCenterY = candidate.box.y + candidate.box.height / 2
  const upperCenterY = Math.min(sourceCenterY, candidateCenterY)
  const lowerCenterY = Math.max(sourceCenterY, candidateCenterY)
  const isIntermediateRegion = (region: PdfPageRegion) => {
    if (
      region.id === source.id ||
      region.id === candidate.id ||
      region.page !== source.page
    ) {
      return false
    }
    const centerY = region.box.y + region.box.height / 2
    if (centerY <= upperCenterY || centerY >= lowerCenterY) {
      return false
    }
    return true
  }
  const hasMathBridge = regions.some((region) => {
    if (
      !isIntermediateRegion(region) ||
      boxGap(source.box, region.box).vertical > 0.02 ||
      boxGap(candidate.box, region.box).vertical > 0.02
    ) {
      return false
    }
    return (
      mathExtensionGlyphFragment(region) ||
      sourceMathExtensionScaffoldFragment(region) ||
      contextualNeutralVerticalEllipsisFragment(region, [source, candidate]) ||
      sourceMathFragment(region) ||
      sourceMathFontOnlyContinuation(region) ||
      sourceMathOperatorFragment(region)
    )
  })
  const hasUprightOperatorBridge =
    sourceUprightMathOperatorContinuation(source) ||
    sourceUprightMathOperatorContinuation(candidate) ||
    regions.some(
      (region) =>
        isIntermediateRegion(region) &&
        boxGap(candidate.box, region.box).vertical <= 0.02 &&
        boxGap(candidate.box, region.box).horizontal <= 0.08 &&
        sourceUprightMathOperatorContinuation(region),
    )
  const hasPrintedNumber =
    printedEquationNumbersForDisplayRegion(source, regions).size > 0 ||
    printedEquationNumbersForDisplayRegion(candidate, regions).size > 0
  if (
    !sameColumn &&
    (gap.horizontal > 0.05 || verticalOverlap < minimumHeight * 0.25)
  ) {
    return false
  }
  return (
    (gap.vertical <= Math.max(0.012, minimumHeight) &&
      horizontalOverlap >= minimumWidth * 0.25) ||
    (gap.horizontal <= 0.12 && verticalOverlap >= minimumHeight * 0.25) ||
    (gap.vertical <= 0.04 &&
      horizontalOverlap >= minimumWidth * 0.25 &&
      hasMathBridge &&
      hasUprightOperatorBridge &&
      hasPrintedNumber) ||
    // PDF font metrics can place neighboring fragments from the same display
    // on slightly staggered baselines. Keep this diagonal bridge narrow so it
    // joins split formula runs without swallowing a separate display line.
    (gap.horizontal <= 0.025 && gap.vertical <= 0.012)
  )
}

export function hasInterstitialEquationProseBoundary(
  source: PdfPageRegion,
  candidate: PdfPageRegion,
  regions: readonly PdfPageRegion[],
) {
  const sourceCenterY = source.box.y + source.box.height / 2
  const candidateCenterY = candidate.box.y + candidate.box.height / 2
  const upperCenterY = Math.min(sourceCenterY, candidateCenterY)
  const lowerCenterY = Math.max(sourceCenterY, candidateCenterY)
  if (lowerCenterY - upperCenterY <= 0.002) return false
  const corridorLeft = Math.min(source.box.x, candidate.box.x) - 0.01
  const corridorRight =
    Math.max(
      source.box.x + source.box.width,
      candidate.box.x + candidate.box.width,
    ) + 0.01
  const intermediateMathBridgeRegions = regions.filter((region) => {
    if (
      region.id === source.id ||
      region.id === candidate.id ||
      region.page !== source.page
    ) {
      return false
    }
    const centerY = region.box.y + region.box.height / 2
    if (
      centerY <= upperCenterY + 0.001 ||
      centerY >= lowerCenterY - 0.001 ||
      boxGap(source.box, region.box).vertical > 0.02 ||
      boxGap(candidate.box, region.box).vertical > 0.02 ||
      boxGap(source.box, region.box).horizontal > 0.08 ||
      boxGap(candidate.box, region.box).horizontal > 0.08
    ) {
      return false
    }
    return (
      mathExtensionGlyphFragment(region) ||
      sourceMathExtensionScaffoldFragment(region) ||
      sourceMathFragment(region) ||
      sourceMathFontOnlyContinuation(region) ||
      sourceMathOperatorFragment(region)
    )
  })
  return regions.some((region) => {
    if (
      region.id === source.id ||
      region.id === candidate.id ||
      region.page !== source.page ||
      !['body', 'spanning'].includes(region.kind)
    ) {
      return false
    }
    const centerY = region.box.y + region.box.height / 2
    const centerX = region.box.x + region.box.width / 2
    if (
      centerY <= upperCenterY + 0.001 ||
      centerY >= lowerCenterY - 0.001 ||
      centerX < corridorLeft ||
      centerX > corridorRight
    ) {
      return false
    }
    return (
      region.includedInReadingOrder &&
      region.text.trim().length > 0 &&
      !sourceMathExtensionScaffoldFragment(region) &&
      !contextualNeutralVerticalEllipsisFragment(region, [source, candidate]) &&
      !contextualSourceRomanScriptFragment(region, [
        source,
        candidate,
        ...intermediateMathBridgeRegions,
      ]) &&
      !sourceMathFragment(region) &&
      !sourceMathFontOnlyContinuation(region) &&
      !numericListAssignmentFragment(region) &&
      !bareNumericMathFragment(region) &&
      !printedEquationNumberFragment(region)
    )
  })
}

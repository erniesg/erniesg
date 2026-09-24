import type { PdfImportProgress, PdfPageRegion } from './import-types'
import {
  contextualNeutralVerticalEllipsisFragment,
  mathExtensionGlyphFragment,
  sourceMathExtensionScaffoldFragment,
  unresolvedMathExtensionGlyphFragment,
} from './pdf-equation-source-math'
import {
  bareNumericMathFragment,
  contextualSourceRomanScriptFragment,
  contextualStixMathOperatorFragment,
  detachedMathHostLineId,
  inlineStackedFormulaBaseIds,
  inlineStackedSiblingBaseId,
  numericListAssignmentFragment,
  provedProseSplitInlineStackedFormulaBaseIds,
  sourceMathFontOnlyContinuation,
  sourceMathFragment,
  sourceMathOperatorFragment,
  sourceProvedInlineStackedMathFormula,
  sourceUprightMathOperatorContinuation,
  unresolvedDetachedMathHost,
} from './pdf-equation-fragment-evidence'
import {
  sourceSequenceEquationOwnerRegionIds,
  splitSourceProvedAnswerCueEquations,
} from './pdf-equation-transcript'
import {
  adjacentDisplayEquationRegion,
  alignedPrintedEquationNumber,
  compactEquationFragment,
  hasDisplayEquationEvidence,
  hasInterstitialEquationProseBoundary,
  MAX_DISPLAY_EQUATION_WIDTH,
  preservesPrintedEquationCardinality,
  printedEquationNumberFragment,
  sourcePrintedEquationNumber,
} from './pdf-equation-display-evidence'
import { equationSourceRunOwnershipKey } from './pdf-visual-matching'
import { boxForLines, unionBox } from './pdf-visual-source-geometry'
import {
  boxGap,
  PDF_VISUAL_COOPERATIVE_BATCH_SIZE,
  PDF_VISUAL_INDEX_COOPERATIVE_BATCH_SIZE,
  yieldPdfVisualTask,
} from './pdf-visual-figure-grouping'

function componentAttachableSequenceOwnerCluster(
  candidate: PdfPageRegion,
  ownerRegionIds: ReadonlySet<string>,
  displayRegions: readonly PdfPageRegion[],
  regions: readonly PdfPageRegion[],
  consumedRegionIds: ReadonlySet<string>,
  reservedLineIds: ReadonlySet<string>,
) {
  // Walk the transitive source-sequence ownership cluster reachable from the
  // candidate. The cluster stays internal to the growing display component
  // only if every linked owner row is itself attachable: an adjacent,
  // unreserved display-equation row in the same column band that preserves
  // printed-number cardinality and the bounded display envelope. Any owner
  // that fails these layout proofs is evidence of a different display, so the
  // candidate must not be captured.
  const displayRegionIds = new Set(displayRegions.map((region) => region.id))
  const regionsById = new Map(regions.map((region) => [region.id, region]))
  const visitedRegionIds = new Set<string>([candidate.id])
  const clusterRegions = new Map<string, PdfPageRegion>([
    [candidate.id, candidate],
  ])
  const pending = [...ownerRegionIds]
  while (pending.length > 0) {
    const ownerRegionId = pending.pop()!
    if (visitedRegionIds.has(ownerRegionId)) continue
    visitedRegionIds.add(ownerRegionId)
    const owner = regionsById.get(ownerRegionId)
    if (!owner) return null
    if (
      !displayRegionIds.has(owner.id) &&
      (owner.page !== candidate.page ||
        consumedRegionIds.has(owner.id) ||
        owner.lines.some((line) => reservedLineIds.has(line.id)) ||
        owner.kind !== 'equation' ||
        unresolvedMathExtensionGlyphFragment(owner) ||
        !hasDisplayEquationEvidence(owner, regions))
    ) {
      return null
    }
    if (!displayRegionIds.has(owner.id)) {
      clusterRegions.set(owner.id, owner)
    }
    for (const transitiveOwnerRegionId of sourceSequenceEquationOwnerRegionIds(
      owner,
      regions,
      hasDisplayEquationEvidence,
    )) {
      if (!visitedRegionIds.has(transitiveOwnerRegionId)) {
        pending.push(transitiveOwnerRegionId)
      }
    }
  }
  const orderedCluster = [...clusterRegions.values()].sort(
    (left, right) =>
      left.box.y - right.box.y ||
      left.box.x - right.box.x ||
      left.id.localeCompare(right.id),
  )
  if (
    orderedCluster.some(
      (region) =>
        region.page !== candidate.page ||
        consumedRegionIds.has(region.id) ||
        region.lines.some((line) => reservedLineIds.has(line.id)) ||
        region.kind !== 'equation' ||
        unresolvedMathExtensionGlyphFragment(region) ||
        !hasDisplayEquationEvidence(region, regions),
    )
  ) {
    return null
  }
  const combined = unionBox([...displayRegions, ...orderedCluster])
  if (combined.height > 0.12 || combined.width > MAX_DISPLAY_EQUATION_WIDTH) {
    return null
  }
  if (
    orderedCluster.some((owner) =>
      displayRegions.every((region) =>
        hasInterstitialEquationProseBoundary(region, owner, regions),
      ),
    )
  ) {
    return null
  }

  const growingComponent = [...displayRegions]
  const remaining = [
    candidate,
    ...orderedCluster.filter((region) => region.id !== candidate.id),
  ]
  while (remaining.length > 0) {
    const attachableIndex = remaining.findIndex((owner) =>
      growingComponent.some(
        (region) =>
          adjacentDisplayEquationRegion(region, owner, regions) &&
          !hasInterstitialEquationProseBoundary(region, owner, regions),
      ),
    )
    if (attachableIndex < 0) return null
    const owner = remaining[attachableIndex]
    if (
      !preservesPrintedEquationCardinality(growingComponent, owner, regions)
    ) {
      return null
    }
    growingComponent.push(owner)
    remaining.splice(attachableIndex, 1)
  }
  return orderedCluster
}

export function attachedEquationRegions(
  source: PdfPageRegion,
  regions: PdfPageRegion[],
  consumedRegionIds: ReadonlySet<string>,
  reservedLineIds: ReadonlySet<string> = new Set(),
  proseSplitInlineFormulaBaseIds: ReadonlySet<string> = provedProseSplitInlineStackedFormulaBaseIds(
    regions,
  ),
) {
  const displayRegions = [source]
  let foundAdjacent = true
  while (foundAdjacent) {
    foundAdjacent = false
    for (const candidate of regions) {
      const ownedInlineFormulaBaseIds = new Set(
        displayRegions.flatMap((region) =>
          [...inlineStackedFormulaBaseIds(region)].filter((baseId) =>
            proseSplitInlineFormulaBaseIds.has(baseId),
          ),
        ),
      )
      const candidateInlineFormulaBaseIds = new Set(
        [...inlineStackedFormulaBaseIds(candidate)].filter((baseId) =>
          proseSplitInlineFormulaBaseIds.has(baseId),
        ),
      )
      const crossesInlineFormulaBoundary =
        (ownedInlineFormulaBaseIds.size > 0 ||
          candidateInlineFormulaBaseIds.size > 0) &&
        ![...candidateInlineFormulaBaseIds].some((baseId) =>
          ownedInlineFormulaBaseIds.has(baseId),
        )
      const sourceSequenceOwnerRegionIds = sourceSequenceEquationOwnerRegionIds(
        candidate,
        regions,
        hasDisplayEquationEvidence,
      )
      const candidateAlreadyAttached = displayRegions.some(
        (region) => region.id === candidate.id,
      )
      const linkedSourceSequenceOwner =
        sourceSequenceOwnerRegionIds.size > 0 &&
        displayRegions.some((region) =>
          sourceSequenceOwnerRegionIds.has(region.id),
        )
      // A stacked display can be painted as interleaved rows whose source
      // whitespace links point at one another (a radical column linked to its
      // radicand row) rather than at the seeding row. Such a mutually linked
      // cluster proves shared ownership only when every linked owner is itself
      // attachable to this component; ownership by a *different* display is
      // proved the moment the linked cluster escapes those bounds.
      const attachableSourceSequenceOwnerCluster =
        sourceSequenceOwnerRegionIds.size > 0 && !candidateAlreadyAttached
          ? componentAttachableSequenceOwnerCluster(
              candidate,
              sourceSequenceOwnerRegionIds,
              displayRegions,
              regions,
              consumedRegionIds,
              reservedLineIds,
            )
          : null
      const hasUnattachableSourceSequenceOwnerCluster =
        sourceSequenceOwnerRegionIds.size > 0 &&
        !candidateAlreadyAttached &&
        attachableSourceSequenceOwnerCluster === null
      if (
        candidate.id === source.id ||
        candidate.page !== source.page ||
        consumedRegionIds.has(candidate.id) ||
        candidate.lines.some((line) => reservedLineIds.has(line.id)) ||
        displayRegions.some((region) => region.id === candidate.id) ||
        (crossesInlineFormulaBoundary && !linkedSourceSequenceOwner) ||
        hasUnattachableSourceSequenceOwnerCluster ||
        candidate.kind !== 'equation' ||
        unresolvedMathExtensionGlyphFragment(candidate) ||
        !hasDisplayEquationEvidence(candidate, regions) ||
        !preservesPrintedEquationCardinality(
          displayRegions,
          candidate,
          regions,
        ) ||
        !displayRegions.some(
          (region) =>
            adjacentDisplayEquationRegion(region, candidate, regions) &&
            !hasInterstitialEquationProseBoundary(region, candidate, regions),
        )
      ) {
        continue
      }
      const regionsToAttach = attachableSourceSequenceOwnerCluster ?? [
        candidate,
      ]
      const combined = unionBox([...displayRegions, ...regionsToAttach])
      if (
        combined.height > 0.12 ||
        combined.width > MAX_DISPLAY_EQUATION_WIDTH
      ) {
        continue
      }
      displayRegions.push(...regionsToAttach)
      foundAdjacent = true
    }
  }
  const insideDisplayEnvelope = (
    candidate: PdfPageRegion,
    ownedRegions: readonly PdfPageRegion[],
  ) => {
    const displayBox = unionBox([...ownedRegions])
    const centerX = candidate.box.x + candidate.box.width / 2
    const centerY = candidate.box.y + candidate.box.height / 2
    return (
      centerX >= displayBox.x - 0.025 &&
      centerX <= displayBox.x + displayBox.width + 0.025 &&
      centerY >= displayBox.y - 0.025 &&
      centerY <= displayBox.y + displayBox.height + 0.025
    )
  }
  const displayDistance = (
    display: PdfPageRegion,
    candidate: PdfPageRegion,
  ) => {
    const gap = boxGap(display.box, candidate.box)
    const centerDistance = Math.hypot(
      display.box.x +
        display.box.width / 2 -
        (candidate.box.x + candidate.box.width / 2),
      display.box.y +
        display.box.height / 2 -
        (candidate.box.y + candidate.box.height / 2),
    )
    return gap.vertical * 2 + gap.horizontal + centerDistance * 0.1
  }
  const uniquelyOwnedByDisplay = (
    candidate: PdfPageRegion,
    ownedRegions: readonly PdfPageRegion[] = displayRegions,
  ) => {
    const ownedRegionIds = new Set(ownedRegions.map((region) => region.id))
    const ownedDistance = Math.min(
      ...ownedRegions.map((region) => displayDistance(region, candidate)),
    )
    const competingDistances = regions
      .filter(
        (region) =>
          region.id !== candidate.id &&
          region.page === candidate.page &&
          !consumedRegionIds.has(region.id) &&
          region.kind === 'equation' &&
          hasDisplayEquationEvidence(region, regions) &&
          !ownedRegionIds.has(region.id),
      )
      .map((region) => displayDistance(region, candidate))
    return (
      competingDistances.length === 0 ||
      ownedDistance + 0.002 < Math.min(...competingDistances)
    )
  }
  const attachedFragments: PdfPageRegion[] = []
  const attachedRegionIds = new Set(displayRegions.map((region) => region.id))
  let foundFragment = true
  while (foundFragment) {
    foundFragment = false
    for (const candidate of regions) {
      const mathExtensionFragment = mathExtensionGlyphFragment(candidate)
      const mathExtensionScaffold =
        sourceMathExtensionScaffoldFragment(candidate)
      const sourceMathGlyphFragment = sourceMathFragment(candidate)
      const sourceMathFontContinuation =
        sourceMathFontOnlyContinuation(candidate)
      const numericAssignmentFragment = numericListAssignmentFragment(candidate)
      const contextualMathOperatorFragment =
        contextualStixMathOperatorFragment(candidate)
      const sourceMathOperator = sourceMathOperatorFragment(candidate)
      const sourceUprightMathOperator =
        sourceUprightMathOperatorContinuation(candidate)
      const attachableFragmentKind =
        ['body', 'spanning', 'side', 'chart-label', 'page-number'].includes(
          candidate.kind,
        ) || candidate.kind === 'equation'
      const wholeFragmentAvailable = candidate.lines.every(
        (line) => !reservedLineIds.has(line.id),
      )
      const ownedInlineFormulaBaseIds = new Set(
        displayRegions.flatMap((region) =>
          [...inlineStackedFormulaBaseIds(region)].filter((baseId) =>
            proseSplitInlineFormulaBaseIds.has(baseId),
          ),
        ),
      )
      const candidateInlineFormulaBaseIds = new Set(
        [...inlineStackedFormulaBaseIds(candidate)].filter((baseId) =>
          proseSplitInlineFormulaBaseIds.has(baseId),
        ),
      )
      const belongsToAnotherInlineFormula =
        candidateInlineFormulaBaseIds.size > 0 &&
        ![...candidateInlineFormulaBaseIds].some((baseId) =>
          ownedInlineFormulaBaseIds.has(baseId),
        )
      const detachedHostLineIds = new Set(
        candidate.lines.flatMap((line) => {
          const hostLineId = detachedMathHostLineId(line.id)
          return hostLineId ? [hostLineId] : []
        }),
      )
      const unresolvedDetachedHost = unresolvedDetachedMathHost(candidate)
      const ownedRegions = [...displayRegions, ...attachedFragments]
      const ownedLineIds = new Set(
        ownedRegions.flatMap((region) => region.lines.map((line) => line.id)),
      )
      const belongsToAnotherDetachedHost =
        detachedHostLineIds.size > 0 &&
        ![...detachedHostLineIds].every((lineId) => ownedLineIds.has(lineId))
      const sourceSequenceOwnerRegionIds = sourceSequenceEquationOwnerRegionIds(
        candidate,
        regions,
        hasDisplayEquationEvidence,
      )
      const linkedSourceSequenceOwner =
        sourceSequenceOwnerRegionIds.size > 0 &&
        ownedRegions.some((region) =>
          sourceSequenceOwnerRegionIds.has(region.id),
        )
      const belongsToAnotherSourceSequenceOwner =
        sourceSequenceOwnerRegionIds.size > 0 && !linkedSourceSequenceOwner
      if (
        attachedRegionIds.has(candidate.id) ||
        candidate.page !== source.page ||
        consumedRegionIds.has(candidate.id) ||
        (belongsToAnotherInlineFormula && !linkedSourceSequenceOwner) ||
        belongsToAnotherDetachedHost ||
        belongsToAnotherSourceSequenceOwner ||
        unresolvedDetachedHost ||
        !attachableFragmentKind
      ) {
        continue
      }
      const contextualRomanScript = contextualSourceRomanScriptFragment(
        candidate,
        ownedRegions,
      )
      const contextualNeutralVerticalEllipsis =
        contextualNeutralVerticalEllipsisFragment(candidate, ownedRegions)
      let fragment: PdfPageRegion | null = null
      if (
        wholeFragmentAvailable &&
        (mathExtensionFragment ||
          mathExtensionScaffold ||
          sourceMathGlyphFragment ||
          sourceMathFontContinuation ||
          numericAssignmentFragment ||
          contextualMathOperatorFragment ||
          sourceMathOperator ||
          sourceUprightMathOperator ||
          contextualRomanScript ||
          contextualNeutralVerticalEllipsis)
      ) {
        fragment = candidate
      } else {
        const selectedMathLines = candidate.lines.filter((line) => {
          if (reservedLineIds.has(line.id)) return false
          const lineFragment = {
            ...candidate,
            text: line.text,
            box: line.box,
            lines: [line],
          }
          return (
            mathExtensionGlyphFragment(lineFragment) ||
            sourceMathExtensionScaffoldFragment(lineFragment) ||
            contextualNeutralVerticalEllipsisFragment(
              lineFragment,
              ownedRegions,
            ) ||
            sourceMathFragment(lineFragment) ||
            sourceMathFontOnlyContinuation(lineFragment) ||
            sourceMathOperatorFragment(lineFragment) ||
            numericListAssignmentFragment(lineFragment) ||
            bareNumericMathFragment(lineFragment) ||
            printedEquationNumberFragment(lineFragment)
          )
        })
        if (selectedMathLines.length > 0) {
          fragment = {
            ...candidate,
            text: selectedMathLines.map((line) => line.text).join(' '),
            box: boxForLines(selectedMathLines),
            lines: selectedMathLines,
          }
        }
      }
      const linkedInlineMathSibling =
        fragment !== null &&
        fragment.lines.length > 0 &&
        fragment.lines.every((line) => {
          const baseId = inlineStackedSiblingBaseId(line.id)
          return baseId !== null && ownedInlineFormulaBaseIds.has(baseId)
        })
      const linkedDetachedMathHost =
        fragment !== null &&
        detachedHostLineIds.size > 0 &&
        [...detachedHostLineIds].every((lineId) => ownedLineIds.has(lineId))
      const displayScope = {
        ...source,
        box: unionBox(ownedRegions),
      }
      const sourceOwnedFragment =
        fragment !== null &&
        insideDisplayEnvelope(fragment, ownedRegions) &&
        uniquelyOwnedByDisplay(fragment, ownedRegions)
      const compactFragment =
        wholeFragmentAvailable && compactEquationFragment(candidate)
      const sourceProvedInlineFormula =
        wholeFragmentAvailable &&
        sourceProvedInlineStackedMathFormula(candidate)
      const gap = boxGap(displayScope.box, candidate.box)
      const adjacentCompactFragment =
        compactFragment &&
        (printedEquationNumberFragment(candidate) ||
          uniquelyOwnedByDisplay(candidate, ownedRegions)) &&
        (alignedPrintedEquationNumber(displayScope, candidate) ||
          ownedRegions.some((region) =>
            alignedPrintedEquationNumber(region, candidate),
          ) ||
          ownedRegions.some((region) => {
            const regionGap = boxGap(region.box, candidate.box)
            return regionGap.horizontal <= 0.01 && regionGap.vertical <= 0.012
          }) ||
          (gap.horizontal <= 0.01 && gap.vertical <= 0.012))
      const adjacentSourceMathFontContinuation =
        fragment !== null &&
        sourceMathFontContinuation &&
        uniquelyOwnedByDisplay(fragment, ownedRegions) &&
        ownedRegions.some((region) => {
          const regionGap = boxGap(region.box, fragment!.box)
          return regionGap.horizontal <= 0.02 && regionGap.vertical <= 0.012
        })
      const selected = linkedDetachedMathHost
        ? fragment
        : linkedSourceSequenceOwner
          ? (fragment ??
            (sourceProvedInlineFormula || compactFragment ? candidate : null))
          : linkedInlineMathSibling
            ? fragment
            : sourceOwnedFragment
              ? fragment
              : adjacentSourceMathFontContinuation
                ? fragment
                : adjacentCompactFragment
                  ? candidate
                  : null
      const bypassesDisplayAdjacencyGuards =
        selected !== null &&
        !linkedDetachedMathHost &&
        !linkedSourceSequenceOwner &&
        !linkedInlineMathSibling &&
        hasDisplayEquationEvidence(selected, regions) &&
        displayRegions.some((display) =>
          hasInterstitialEquationProseBoundary(display, selected, regions),
        )
      if (
        !selected ||
        bypassesDisplayAdjacencyGuards ||
        !preservesPrintedEquationCardinality(displayRegions, selected, regions)
      ) {
        continue
      }
      const combined = unionBox([...ownedRegions, selected])
      if (
        combined.height > 0.12 ||
        combined.width > MAX_DISPLAY_EQUATION_WIDTH
      ) {
        continue
      }
      attachedFragments.push(selected)
      attachedRegionIds.add(selected.id)
      foundFragment = true
    }
  }
  return [...displayRegions, ...attachedFragments].sort(
    (left, right) =>
      left.box.y - right.box.y ||
      left.box.x - right.box.x ||
      left.id.localeCompare(right.id),
  )
}

export interface DisplayEquationComponent {
  source: PdfPageRegion
  regions: PdfPageRegion[]
}

interface EquationComponentOwnership {
  sourceRegionIds: string[]
  sourceLineIds: string[]
}

export function proveEquationComponentOwnership(
  sources: readonly PdfPageRegion[],
  allRegions: readonly PdfPageRegion[],
): EquationComponentOwnership | null {
  const sourceRegionIds = sources.map((source) => source.id)
  const sourceLineIds = sources.flatMap((source) =>
    source.lines.map((line) => line.id),
  )
  if (
    sourceRegionIds.length === 0 ||
    sourceLineIds.length === 0 ||
    new Set(sourceRegionIds).size !== sourceRegionIds.length ||
    new Set(sourceLineIds).size !== sourceLineIds.length
  ) {
    return null
  }
  const sourceLineIdSet = new Set(sourceLineIds)
  const inlineFormulaBaseIds = new Set(
    sourceLineIds.flatMap((lineId) => {
      const match = /^(.*-inline-stacked-\d+)-formula$/u.exec(lineId)
      return match ? [match[1]] : []
    }),
  )
  const unsafeInlineSibling = allRegions.some(
    (region) =>
      region.kind !== 'body' &&
      region.lines.some((line) => {
        if (sourceLineIdSet.has(line.id)) return false
        const match = /^(.*-inline-stacked-\d+)-(before|after)$/u.exec(line.id)
        return Boolean(match && inlineFormulaBaseIds.has(match[1]))
      }),
  )
  if (unsafeInlineSibling) return null
  const sourceRunOwnershipKeys = sources.flatMap((source) =>
    source.lines.flatMap((line) =>
      line.runs
        .filter((run) => run.text.trim())
        .map(equationSourceRunOwnershipKey),
    ),
  )
  if (
    sourceRunOwnershipKeys.length === 0 ||
    new Set(sourceRunOwnershipKeys).size !== sourceRunOwnershipKeys.length
  ) {
    return null
  }

  const regionOccurrenceCount = new Map<string, number>()
  const lineOccurrenceCount = new Map<string, number>()
  const regionLineOccurrenceCount = new Map<string, number>()
  const runOccurrenceCount = new Map<string, number>()
  for (const region of allRegions) {
    regionOccurrenceCount.set(
      region.id,
      (regionOccurrenceCount.get(region.id) ?? 0) + 1,
    )
    for (const line of region.lines) {
      lineOccurrenceCount.set(
        line.id,
        (lineOccurrenceCount.get(line.id) ?? 0) + 1,
      )
      const regionLineKey = `${region.id}\u001f${line.id}`
      regionLineOccurrenceCount.set(
        regionLineKey,
        (regionLineOccurrenceCount.get(regionLineKey) ?? 0) + 1,
      )
      for (const run of line.runs.filter((candidate) =>
        candidate.text.trim(),
      )) {
        const key = equationSourceRunOwnershipKey(run)
        runOccurrenceCount.set(key, (runOccurrenceCount.get(key) ?? 0) + 1)
      }
    }
  }
  if (
    sourceRegionIds.some(
      (regionId) => regionOccurrenceCount.get(regionId) !== 1,
    ) ||
    sources.some((source) =>
      source.lines.some(
        (line) =>
          lineOccurrenceCount.get(line.id) !== 1 ||
          regionLineOccurrenceCount.get(`${source.id}\u001f${line.id}`) !== 1,
      ),
    ) ||
    sourceRunOwnershipKeys.some((key) => runOccurrenceCount.get(key) !== 1)
  ) {
    return null
  }
  return { sourceRegionIds, sourceLineIds }
}

export async function displayEquationComponents(
  regions: PdfPageRegion[],
  consumedRegionIds: ReadonlySet<string>,
  onProgress?: (progress: PdfImportProgress) => void,
  signal?: AbortSignal,
) {
  splitSourceProvedAnswerCueEquations(regions, consumedRegionIds)
  const sourceOrder = (left: PdfPageRegion, right: PdfPageRegion) =>
    left.page - right.page ||
    left.box.y - right.box.y ||
    left.box.x - right.box.x ||
    left.id.localeCompare(right.id)
  const orderedRegions = [...regions].sort(sourceOrder)
  onProgress?.({
    phase: 'semantic-promotion',
    completed: 0,
    total: orderedRegions.length,
    message: `Indexing display-equation evidence across ${orderedRegions.length} source regions…`,
    checkpoint: 'equation-component-discovery',
  })
  await yieldPdfVisualTask(signal)
  const proseSplitInlineFormulaBaseIds =
    provedProseSplitInlineStackedFormulaBaseIds(orderedRegions)
  const regionsByPage = new Map<number, PdfPageRegion[]>()
  for (const region of orderedRegions) {
    const pageRegions = regionsByPage.get(region.page) ?? []
    pageRegions.push(region)
    regionsByPage.set(region.page, pageRegions)
  }
  const displaySources: PdfPageRegion[] = []
  for (const [regionIndex, region] of orderedRegions.entries()) {
    if (
      !consumedRegionIds.has(region.id) &&
      hasDisplayEquationEvidence(region, regionsByPage.get(region.page) ?? [])
    ) {
      displaySources.push(region)
    }
    const completed = regionIndex + 1
    if (
      completed % PDF_VISUAL_INDEX_COOPERATIVE_BATCH_SIZE === 0 ||
      completed === orderedRegions.length
    ) {
      onProgress?.({
        phase: 'semantic-promotion',
        completed,
        total: orderedRegions.length,
        message: `Indexed display-equation evidence for ${completed} of ${orderedRegions.length} source regions…`,
        checkpoint: 'equation-component-discovery',
      })
      await yieldPdfVisualTask(signal)
    }
  }
  const displaySourcePageRegions = new Map(
    displaySources.map((source) => [
      source.id,
      regionsByPage.get(source.page) ?? [],
    ]),
  )
  const ownedLineIds = new Set<string>()
  const components: DisplayEquationComponent[] = []

  for (const [sourceIndex, source] of displaySources.entries()) {
    if (
      sourceIndex > 0 &&
      sourceIndex % PDF_VISUAL_COOPERATIVE_BATCH_SIZE === 0
    ) {
      onProgress?.({
        phase: 'semantic-promotion',
        completed: sourceIndex,
        total: displaySources.length,
        message: `Examined ${sourceIndex} of ${displaySources.length} display-equation source candidates…`,
        checkpoint: 'equation-component-resolution',
      })
      await yieldPdfVisualTask(signal)
    }
    if (source.lines.some((line) => ownedLineIds.has(line.id))) continue
    const pageRegions = displaySourcePageRegions.get(source.id) ?? []
    const componentRegions = attachedEquationRegions(
      source,
      pageRegions,
      consumedRegionIds,
      ownedLineIds,
      proseSplitInlineFormulaBaseIds,
    )
    // Only a region with display-level evidence can seed a component. Source
    // math fragments, operators, scripts, and printed numbers may extend that
    // component, but can never promote themselves as singleton displays.
    if (
      !componentRegions.some(
        (region) =>
          region.id === source.id &&
          hasDisplayEquationEvidence(region, pageRegions),
      )
    ) {
      continue
    }
    for (const region of componentRegions) {
      for (const line of region.lines) ownedLineIds.add(line.id)
    }
    const primarySource =
      componentRegions.find(
        (region) =>
          region.kind === 'equation' &&
          region.includedInReadingOrder &&
          !unresolvedMathExtensionGlyphFragment(region) &&
          (hasDisplayEquationEvidence(region, pageRegions) ||
            sourceMathOperatorFragment(region)),
      ) ??
      componentRegions.find(
        (region) =>
          region.kind === 'equation' &&
          hasDisplayEquationEvidence(region, pageRegions) &&
          !unresolvedMathExtensionGlyphFragment(region),
      ) ??
      source
    components.push({ source: primarySource, regions: componentRegions })
  }
  if (displaySources.length > 0) {
    onProgress?.({
      phase: 'semantic-promotion',
      completed: displaySources.length,
      total: displaySources.length,
      message: `Examined ${displaySources.length} of ${displaySources.length} display-equation source candidates…`,
      checkpoint: 'equation-component-resolution',
    })
    await yieldPdfVisualTask(signal)
  }

  return components.sort((left, right) => {
    const leftBox = unionBox(left.regions)
    const rightBox = unionBox(right.regions)
    return (
      leftBox.page - rightBox.page ||
      leftBox.y - rightBox.y ||
      leftBox.x - rightBox.x ||
      left.source.id.localeCompare(right.source.id)
    )
  })
}

export function consumeRegionLineSelection(
  regionId: string,
  selectedLineIds: readonly string[],
  regions: readonly PdfPageRegion[],
  consumedRegionIds: Set<string>,
  consumedLineIds: Set<string>,
) {
  const original = regions.find((region) => region.id === regionId)
  if (
    !original ||
    original.lines.length === 0 ||
    selectedLineIds.length === 0
  ) {
    consumedRegionIds.add(regionId)
    return
  }
  const selected = new Set(selectedLineIds)
  if (original.lines.every((line) => selected.has(line.id))) {
    consumedRegionIds.add(regionId)
    return
  }
  for (const line of original.lines) {
    if (selected.has(line.id)) consumedLineIds.add(line.id)
  }
}

export function sourceEquationLabel(
  region: PdfPageRegion,
  pageSequence: number,
  sources: PdfPageRegion[],
) {
  const printedNumber = sources
    .map(sourcePrintedEquationNumber)
    .find((value) => value !== null)
  return printedNumber
    ? `Equation ${printedNumber}`
    : `Display equation p${String(region.page).padStart(3, '0')}-${String(pageSequence).padStart(3, '0')}`
}

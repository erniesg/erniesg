import type {
  NormalizedSourceBox,
  PdfImportProgress,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
  PdfTextOperationFilterPlan,
  PdfVisualAsset,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import {
  createSourceGeometryScriptTranscript,
  SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE,
} from './equation-geometry-transcript'
import {
  equationRenderOnlySourceRunIdentity,
  proveEquationRenderOnlySourceRunOwnerships,
  RENDER_ONLY_EQUATION_OWNERSHIP_EVIDENCE,
} from './equation-render-only-ownership'
import {
  contextualNeutralVerticalEllipsisFragment,
  mathExtensionGlyphFragment,
  sourceMathExtensionScaffoldFragment,
  unresolvedMathExtensionRegion,
} from './pdf-equation-source-math'
import {
  hasAmbiguousStackedEquationGeometry,
  numericListAssignmentFragment,
  sourceMathFontOnlyContinuation,
  sourceMathFragment,
  sourceMathOperatorFragment,
  unresolvedDetachedMathHost,
} from './pdf-equation-fragment-evidence'
import {
  equationSourceText,
  sourceEquationTranscript,
} from './pdf-equation-transcript'
import {
  adjacentDisplayEquationRegion,
  compactEquationFragment,
  hasDisplayEquationEvidence,
  hasMathExtensionFontProvenance,
  printedEquationNumberFragment,
  probableDisplayEquationText,
  sourcePrintedEquationNumber,
} from './pdf-equation-display-evidence'
import { isBoundedPdfPageCropBox } from './pdf-page-crop'
import { createTextSvgAsset } from './visual-assets'
import {
  completeSourcePageCropPdfVisualAsset as completeSourcePageCropAsset,
  mergePdfVisualAsset as mergeAsset,
  samePdfSourceBox as sameSourceBox,
  sourcePageCropTouchesEdge,
} from './pdf-visual-source-crops'
import {
  excludedEquationSourceBoxesForCrop,
  hasOverlappingUnownedEquationText,
  sourceBoxesIntersect,
  sourceTextOperationFilterPlanForEquationCrop,
  sourceTextPaintInventoryForPage,
  unownedSourceTextBoxesInEquationCrop,
} from './pdf-equation-source-crop'
import {
  pdfVisualOwnershipExtentSha256,
  SOURCE_CROP_CONTAINMENT_TOLERANCE,
} from './pdf-visual-matching'
import {
  neighborBoundedCropBoxes,
  paddedEquationCropBox,
  paddedUnionBox,
  unionBox,
  verticalBoxOverlap,
} from './pdf-visual-source-geometry'
import { fullyContainsBox } from './pdf-visual-figure-lineage'
import {
  boxGap,
  PDF_VISUAL_COOPERATIVE_BATCH_SIZE,
  yieldPdfVisualTask,
} from './pdf-visual-figure-grouping'
import type { PdfFigureRasterizer } from './pdf-visual-algorithms'
import {
  consumeRegionLineSelection,
  displayEquationComponents,
  proveEquationComponentOwnership,
  sourceEquationLabel,
} from './pdf-equation-components'

const EQUATION_SOURCE_CROP_RETRY_PADDINGS = [
  0.006, 0.008, 0.01, 0.012, 0.014, 0.016, 0.02,
] as const
const EQUATION_SOURCE_CROP_RETRY_NEIGHBOR_GAP_FRACTIONS = [
  0.5, 0.75, 0.9,
] as const

function completeEquationSourceScope(
  sources: readonly PdfPageRegion[],
  regions: readonly PdfPageRegion[],
  consumedRegionIds: ReadonlySet<string>,
  examinedEquationRegionIds: ReadonlySet<string>,
) {
  const sourceLineIds = sources.flatMap((source) =>
    source.lines.map((line) => line.id),
  )
  const sourceLineIdSet = new Set(sourceLineIds)
  const inlineFormulaBaseIds = new Set(
    sourceLineIds.flatMap((lineId) => {
      const match = /^(.*-inline-stacked-\d+)-formula$/u.exec(lineId)
      return match ? [match[1]] : []
    }),
  )
  const inlineSiblingRegions = regions.filter((region) =>
    region.lines.some((line) => {
      if (sourceLineIdSet.has(line.id)) return false
      const match = /^(.*-inline-stacked-\d+)-(before|after)$/u.exec(line.id)
      return Boolean(match && inlineFormulaBaseIds.has(match[1]))
    }),
  )
  if (
    inlineFormulaBaseIds.size > 0 &&
    inlineSiblingRegions.length > 0 &&
    !hasAmbiguousStackedEquationGeometry([...sources])
  ) {
    return false
  }
  const isOwnedInlineSiblingRegion = (region: PdfPageRegion) =>
    region.kind === 'body' &&
    region.lines.some((line) => {
      const match = /^(.*-inline-stacked-\d+)-(before|after)$/u.exec(line.id)
      return Boolean(match && inlineFormulaBaseIds.has(match[1]))
    })
  const sourceIds = new Set(sources.map((source) => source.id))
  const printedNumbers = new Set(
    sources.flatMap((source) => {
      const number = sourcePrintedEquationNumber(source)
      return number === null ? [] : [number.toLocaleLowerCase()]
    }),
  )
  const envelope = unionBox([...sources])
  const insideNearbyEnvelope = (candidate: PdfPageRegion) => {
    const centerX = candidate.box.x + candidate.box.width / 2
    const centerY = candidate.box.y + candidate.box.height / 2
    return (
      centerX >= envelope.x - 0.025 &&
      centerX <= envelope.x + envelope.width + 0.025 &&
      centerY >= envelope.y - 0.025 &&
      centerY <= envelope.y + envelope.height + 0.025
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
  return !regions.some((candidate) => {
    if (
      sourceIds.has(candidate.id) ||
      consumedRegionIds.has(candidate.id) ||
      candidate.page !== envelope.page
    ) {
      return false
    }
    const candidateNumber = sourcePrintedEquationNumber(candidate)
    if (
      candidateNumber !== null &&
      printedNumbers.size > 0 &&
      !printedNumbers.has(candidateNumber.toLocaleLowerCase())
    ) {
      return false
    }
    // The region splitter deliberately keeps the prose before and after a
    // two-dimensional inline formula as body text. Those sibling fragments
    // prove the formula's source-line position; they do not make the formula
    // crop incomplete. Crop bounding and unowned-text checks below still keep
    // pixels from either prose sibling out of the equation asset.
    if (isOwnedInlineSiblingRegion(candidate)) return false
    const adjacentSameLineContinuation = sources.some((source) => {
      if (
        source.page !== candidate.page ||
        source.box.rotation !== candidate.box.rotation ||
        printedEquationNumberFragment(candidate)
      ) {
        return false
      }
      const verticalOverlap = verticalBoxOverlap(source.box, candidate.box)
      const minimumHeight = Math.min(source.box.height, candidate.box.height)
      if (
        minimumHeight <= 0 ||
        verticalOverlap < minimumHeight * 0.35 ||
        boxGap(source.box, candidate.box).horizontal > 0.015
      ) {
        return false
      }
      const left =
        source.box.x <= candidate.box.x
          ? { region: source, text: source.text.trimEnd() }
          : { region: candidate, text: candidate.text.trimEnd() }
      const right =
        left.region.id === source.id
          ? candidate.text.trimStart()
          : source.text.trimStart()
      return (
        /[=+\-−×÷≤≥≈∼⊙∂∞∏∈∉→←([{,]$/u.test(left.text) ||
        /^[=+\-−×÷≤≥≈∼⊙∂∞∏∈∉→←)\]},]/u.test(right)
      )
    })
    if (adjacentSameLineContinuation) return true
    if (
      candidate.kind === 'equation' &&
      examinedEquationRegionIds.has(candidate.id)
    ) {
      return false
    }
    const mathExtensionFragment = mathExtensionGlyphFragment(candidate)
    const mathExtensionScaffold = sourceMathExtensionScaffoldFragment(candidate)
    const sourceMathGlyphFragment = sourceMathFragment(candidate)
    const sourceMathFontContinuation = sourceMathFontOnlyContinuation(candidate)
    const numericAssignmentFragment = numericListAssignmentFragment(candidate)
    const formulaFragment =
      (candidate.kind === 'equation' &&
        hasDisplayEquationEvidence(candidate, regions)) ||
      mathExtensionFragment ||
      mathExtensionScaffold ||
      contextualNeutralVerticalEllipsisFragment(candidate, sources) ||
      sourceMathGlyphFragment ||
      sourceMathFontContinuation ||
      sourceMathOperatorFragment(candidate) ||
      numericAssignmentFragment ||
      compactEquationFragment(candidate) ||
      printedEquationNumberFragment(candidate)
    if (!formulaFragment) return false
    const independentDisplay =
      candidate.kind === 'equation' &&
      !mathExtensionFragment &&
      !sourceMathGlyphFragment
    if (independentDisplay) {
      return sources.some((source) =>
        adjacentDisplayEquationRegion(source, candidate, regions),
      )
    }
    if (!insideNearbyEnvelope(candidate)) return false
    const ownedDistance = Math.min(
      ...sources.map((source) => displayDistance(source, candidate)),
    )
    const competingDistances = regions
      .filter(
        (region) =>
          region.id !== candidate.id &&
          region.page === candidate.page &&
          !sourceIds.has(region.id) &&
          !consumedRegionIds.has(region.id) &&
          region.kind === 'equation' &&
          !mathExtensionGlyphFragment(region) &&
          hasDisplayEquationEvidence(region, regions),
      )
      .map((region) => displayDistance(region, candidate))
    return (
      competingDistances.length === 0 ||
      Math.min(...competingDistances) + 0.002 >= ownedDistance
    )
  })
}

export async function reconstructDisplayEquations({
  pages,
  regions,
  rasterizeFigure,
  assetStore,
  consumedRegionIds,
  consumedLineIds,
  relationships,
  diagnostics,
  unresolvedExtensionTextItems,
  onProgress,
  signal,
}: {
  pages: PdfPageAnalysis[]
  regions: PdfPageRegion[]
  rasterizeFigure?: PdfFigureRasterizer
  assetStore: Map<string, PdfVisualAsset>
  consumedRegionIds: Set<string>
  consumedLineIds: Set<string>
  relationships: PdfVisualRelationship[]
  diagnostics: ReconstructionDiagnostic[]
  unresolvedExtensionTextItems: PdfSourceRun[]
  onProgress?: (progress: PdfImportProgress) => void
  signal?: AbortSignal
}) {
  const equationCountByPage = new Map<number, number>()
  const equationComponents = await displayEquationComponents(
    regions,
    consumedRegionIds,
    onProgress,
    signal,
  )
  const equationComponentScopes = equationComponents.map((component, index) => {
    const id = `${component.source.id}\u001f${index}`
    return {
      id,
      component,
      ownership: proveEquationComponentOwnership(component.regions, regions),
    }
  })
  const equationComponentOwnershipByScopeId = new Map(
    equationComponentScopes.map((scope) => [scope.id, scope.ownership]),
  )
  const renderOnlyOwnershipByScopeId =
    proveEquationRenderOnlySourceRunOwnerships({
      pages,
      regions,
      scopes: equationComponentScopes.flatMap((scope) =>
        scope.ownership
          ? [
              {
                id: scope.id,
                page: scope.component.source.page,
                sourceRegionIds: scope.ownership.sourceRegionIds,
                sourceLineIds: scope.ownership.sourceLineIds,
              },
            ]
          : [],
      ),
    })
  const resolvedRenderOnlySourceRunKeys = new Set<string>()
  const componentEquationRegionIds = new Set(
    equationComponents.flatMap((component) =>
      component.regions
        .filter((region) => region.kind === 'equation')
        .map((region) => region.id),
    ),
  )
  for (const [
    equationIndex,
    { source, regions: sources },
  ] of equationComponents.entries()) {
    const equationComponentScopeId = `${source.id}\u001f${equationIndex}`
    if (
      equationIndex > 0 &&
      equationIndex % PDF_VISUAL_COOPERATIVE_BATCH_SIZE === 0
    ) {
      onProgress?.({
        phase: 'semantic-promotion',
        completed: equationIndex,
        total: equationComponents.length,
        message: `Resolving atomic display equations ${equationIndex} of ${equationComponents.length}…`,
      })
      await yieldPdfVisualTask(signal)
    }
    if (consumedRegionIds.has(source.id)) continue
    const page = pages.find((item) => item.page === source.page)
    if (!page) continue
    const renderVisibleTextRuns = sourceTextPaintInventoryForPage(page, regions)
    const sourceText = equationSourceText(sources)
    if (
      !probableDisplayEquationText(sourceText) &&
      !probableDisplayEquationText(equationSourceText([source])) &&
      !hasMathExtensionFontProvenance(source) &&
      !hasAmbiguousStackedEquationGeometry(sources) &&
      !sources.some(unresolvedMathExtensionRegion) &&
      !sources.some((region) => sourcePrintedEquationNumber(region) !== null)
    ) {
      continue
    }
    const ownership =
      equationComponentOwnershipByScopeId.get(equationComponentScopeId) ?? null
    const renderOnlyOwnershipProjection =
      renderOnlyOwnershipByScopeId.get(equationComponentScopeId) ?? null
    const sourceScopeComplete =
      ownership !== null &&
      !sources.some(unresolvedDetachedMathHost) &&
      completeEquationSourceScope(
        sources,
        regions,
        consumedRegionIds,
        componentEquationRegionIds,
      )
    const renderOnlyOwnedSourceRuns = sourceScopeComplete
      ? (renderOnlyOwnershipProjection?.sourceRuns ?? [])
      : []
    const renderOnlyOwnedRunKeys = new Set(
      renderOnlyOwnedSourceRuns.map(equationRenderOnlySourceRunIdentity),
    )
    const transcript = sourceScopeComplete
      ? sourceEquationTranscript(sources, {
          sourcePrintedEquationNumber,
          probableDisplayEquationText,
          printedEquationNumberFragment,
        })
      : null
    const transcriptResolved = transcript !== null
    const pageSequence = (equationCountByPage.get(source.page) ?? 0) + 1
    equationCountByPage.set(source.page, pageSequence)
    const sourceBox = unionBox(sources)
    const label = sourceEquationLabel(source, pageSequence, sources)
    const sourceObjectId = `equation-source-p${String(source.page).padStart(3, '0')}-${String(pageSequence).padStart(3, '0')}`
    const visualAsset = transcriptResolved
      ? await createTextSvgAsset({
          kind: 'equation',
          sourceObjectId,
          sourceBox,
          lines: sources.flatMap((region) => region.lines),
          pageWidth: page.width,
          pageHeight: page.height,
        })
      : null
    if (visualAsset) mergeAsset(assetStore, visualAsset)
    const transcriptEvidence = transcript
      ? transcript.evidence
      : ['source-text-transcript-unresolved']
    const approximationEvidence = [
      'source-equation-region',
      'bounded-source-geometry',
      ...(ownership ? ['source-proved-atomic-equation-component'] : []),
      ...transcriptEvidence,
      ...(!sourceScopeComplete ? ['incomplete-equation-source-scope'] : []),
      ...(sources.some(unresolvedDetachedMathHost)
        ? ['unresolved-detached-math-host']
        : []),
      ...(visualAsset ? ['readable-text-svg-approximation'] : []),
    ]
    const unboundedInitialCropBox = paddedUnionBox([sourceBox])
    const projectedSourceLineIds =
      ownership?.sourceLineIds ??
      sources.flatMap((region) => region.lines.map((line) => line.id))
    const sourceEquationLineIds = new Set(projectedSourceLineIds)
    const ownedSourceBoxes = [
      ...sources.flatMap((region) =>
        region.lines.flatMap((line) =>
          line.runs
            .filter((run) => run.text.trim())
            .map((run) => ({
              page: run.page,
              x: run.x,
              y: run.y,
              width: run.width,
              height: run.height,
              rotation: run.rotation,
              method: run.method,
            })),
        ),
      ),
      ...renderOnlyOwnedSourceRuns.map((run) => ({
        page: run.page,
        x: run.x,
        y: run.y,
        width: run.width,
        height: run.height,
        rotation: run.rotation,
        method: run.method,
      })),
    ]
    const overlappingUnownedSourceText = hasOverlappingUnownedEquationText(
      ownedSourceBoxes,
      sourceEquationLineIds,
      regions,
      renderVisibleTextRuns,
      renderOnlyOwnedRunKeys,
    )
    const sourceRegionIdSet = new Set(sources.map((region) => region.id))
    const hasNearbyUnownedEquationText = regions.some((candidate) => {
      if (
        sourceRegionIdSet.has(candidate.id) ||
        consumedRegionIds.has(candidate.id) ||
        candidate.page !== source.page ||
        candidate.text.trim().length === 0 ||
        printedEquationNumberFragment(candidate)
      ) {
        return false
      }
      const gap = boxGap(sourceBox, candidate.box)
      return (
        gap.vertical <= 0.03 &&
        gap.horizontal <= 0.12 &&
        ['body', 'spanning', 'side', 'equation'].includes(candidate.kind)
      )
    })
    if (overlappingUnownedSourceText) {
      approximationEvidence.push('overlapping-unowned-source-text')
    }
    let sourceCropBox = neighborBoundedCropBoxes(
      sourceBox,
      sourceEquationLineIds,
      regions,
      0.004,
    )[0]
    let sourceCrop: PdfVisualAsset | null = null
    let cropTouchedEdge = false
    let cropVetoedUnownedText = false
    let adaptivePaddingRetry = false
    let postExhaustionV2Retry = false
    let requestedExcludedSourceBoxes: NormalizedSourceBox[] = []
    let requestedTextOperationFilter: PdfTextOperationFilterPlan | null = null
    let retainedExcludedSourceBoxes: NormalizedSourceBox[] = []
    let neighborBoundedCrop = !sameSourceBox(
      sourceCropBox,
      unboundedInitialCropBox,
    )
    // A complete ownership proof is required for semantic promotion, but it
    // is not required to keep the equation readable. When the source box is
    // bounded and contains no unowned text, rasterize that exact box as a
    // source-preserved fallback instead of allowing its glyphs to fall into
    // ordinary prose. Contaminated/ambiguous boxes remain fail-closed.
    const sourcePreservedFallbackEligible =
      ownership !== null &&
      !sourceScopeComplete &&
      !overlappingUnownedSourceText &&
      !hasNearbyUnownedEquationText
    if (
      rasterizeFigure &&
      (sourceScopeComplete || sourcePreservedFallbackEligible)
    ) {
      const rasterizeEquationCrop = async (
        cropBox: NormalizedSourceBox,
        excludedSourceBoxes: readonly NormalizedSourceBox[],
        sourceTextOperationFilter: PdfTextOperationFilterPlan | null,
      ) => {
        const attempt = async (
          requestedExcludedSourceBoxes: readonly NormalizedSourceBox[],
        ) => {
          let touchedEdge = false
          const asset = await rasterizeFigure({
            kind: 'equation',
            page: source.page,
            sourceBox: cropBox,
            sourceObjectIds: [sourceObjectId],
            sourceBoxes: [sourceBox],
            ...(sourceTextOperationFilter
              ? { sourceTextOperationFilter }
              : { ownedSourceBoxes }),
            ...(!sourceTextOperationFilter &&
            requestedExcludedSourceBoxes.length > 0
              ? {
                  excludedSourceBoxes: [...requestedExcludedSourceBoxes],
                }
              : {}),
          }).catch((error: unknown) => {
            touchedEdge = sourcePageCropTouchesEdge(error)
            return null
          })
          return { asset, touchedEdge }
        }
        const maskedAttempt = await attempt(excludedSourceBoxes)
        if (
          maskedAttempt.asset &&
          !sourceTextOperationFilter &&
          excludedSourceBoxes.length > 0 &&
          !maskedAttempt.asset.sourceExclusionMask
        ) {
          // A renderer may prove that no pixels needed exclusion. Re-render
          // without the exclusion request before accepting that claim so a
          // dropped mask record cannot silently bless modified pixels.
          const cleanAttempt = await attempt([])
          return {
            crop: cleanAttempt.asset,
            touchedEdge: cleanAttempt.touchedEdge,
            requestedExcludedSourceBoxes: [] as NormalizedSourceBox[],
          }
        }
        return {
          crop: maskedAttempt.asset,
          touchedEdge: maskedAttempt.touchedEdge,
          requestedExcludedSourceBoxes: maskedAttempt.asset
            ? [...excludedSourceBoxes]
            : [],
        }
      }
      const initialUnownedSourceBoxes = unownedSourceTextBoxesInEquationCrop(
        sourceCropBox,
        sourceEquationLineIds,
        regions,
        renderVisibleTextRuns,
        renderOnlyOwnedRunKeys,
      )
      const initialHasUnownedText = initialUnownedSourceBoxes.length > 0
      const initialExcludedSourceBoxes = excludedEquationSourceBoxesForCrop(
        sourceCropBox,
        ownedSourceBoxes,
        sourceEquationLineIds,
        regions,
        page.width,
        page.height,
      )
      const initialExclusionsComplete = initialUnownedSourceBoxes.every(
        (unowned) =>
          initialExcludedSourceBoxes.some((excluded) =>
            sameSourceBox(unowned, excluded),
          ),
      )
      const initialV1Unsafe =
        initialHasUnownedText &&
        (!initialExclusionsComplete ||
          initialUnownedSourceBoxes.some((unowned) =>
            ownedSourceBoxes.some((owned) =>
              sourceBoxesIntersect(owned, unowned),
            ),
          ))
      const initialTextOperationFilter = initialV1Unsafe
        ? sourceTextOperationFilterPlanForEquationCrop(
            sourceCropBox,
            sourceEquationLineIds,
            regions,
            renderVisibleTextRuns,
            renderOnlyOwnedRunKeys,
          )
        : null
      cropVetoedUnownedText = initialV1Unsafe && !initialTextOperationFilter
      const initialCropResult = cropVetoedUnownedText
        ? null
        : await rasterizeEquationCrop(
            sourceCropBox,
            initialTextOperationFilter ? [] : initialExcludedSourceBoxes,
            initialTextOperationFilter,
          )
      sourceCrop = initialCropResult?.crop ?? null
      cropTouchedEdge = initialCropResult?.touchedEdge ?? false
      if (sourceCrop) {
        requestedTextOperationFilter = initialTextOperationFilter
        requestedExcludedSourceBoxes =
          initialCropResult!.requestedExcludedSourceBoxes
        retainedExcludedSourceBoxes =
          sourceCrop.sourceExclusionMask?.excludedSourceBoxes.map((box) => ({
            ...box,
          })) ?? []
      } else if (
        initialHasUnownedText &&
        !initialExclusionsComplete &&
        !initialTextOperationFilter
      ) {
        cropTouchedEdge = false
      }
      const attemptedBoxes = [sourceCropBox]
      const retryCropScopes = [
        ...EQUATION_SOURCE_CROP_RETRY_PADDINGS.map(
          (padding) => [padding, 0.25] as const,
        ),
        ...EQUATION_SOURCE_CROP_RETRY_NEIGHBOR_GAP_FRACTIONS.map(
          (neighborGapFraction) =>
            [
              EQUATION_SOURCE_CROP_RETRY_PADDINGS.at(-1)!,
              neighborGapFraction,
            ] as const,
        ),
      ]
      retryEquationCrop: for (const [
        padding,
        neighborGapFraction,
      ] of retryCropScopes) {
        if (sourceCrop || !cropTouchedEdge) break
        const retryBoxes = neighborBoundedCropBoxes(
          sourceBox,
          sourceEquationLineIds,
          regions,
          padding,
          neighborGapFraction,
        )
        for (const retryBox of retryBoxes) {
          if (
            attemptedBoxes.some((attempted) =>
              sameSourceBox(attempted, retryBox),
            )
          ) {
            continue
          }
          attemptedBoxes.push(retryBox)
          const retryUnownedSourceBoxes = unownedSourceTextBoxesInEquationCrop(
            retryBox,
            sourceEquationLineIds,
            regions,
            renderVisibleTextRuns,
            renderOnlyOwnedRunKeys,
          )
          const retryHasUnownedText = retryUnownedSourceBoxes.length > 0
          const retryExcludedSourceBoxes = excludedEquationSourceBoxesForCrop(
            retryBox,
            ownedSourceBoxes,
            sourceEquationLineIds,
            regions,
            page.width,
            page.height,
          )
          const retryExclusionsComplete = retryUnownedSourceBoxes.every(
            (unowned) =>
              retryExcludedSourceBoxes.some((excluded) =>
                sameSourceBox(unowned, excluded),
              ),
          )
          const retryV1Unsafe =
            retryHasUnownedText &&
            (!retryExclusionsComplete ||
              retryUnownedSourceBoxes.some((unowned) =>
                ownedSourceBoxes.some((owned) =>
                  sourceBoxesIntersect(owned, unowned),
                ),
              ))
          const retryTextOperationFilter = retryV1Unsafe
            ? sourceTextOperationFilterPlanForEquationCrop(
                retryBox,
                sourceEquationLineIds,
                regions,
                renderVisibleTextRuns,
                renderOnlyOwnedRunKeys,
              )
            : null
          if (retryV1Unsafe && !retryTextOperationFilter) {
            cropVetoedUnownedText = true
            continue
          }
          const retryResult = await rasterizeEquationCrop(
            retryBox,
            retryTextOperationFilter ? [] : retryExcludedSourceBoxes,
            retryTextOperationFilter,
          )
          const retryCrop = retryResult.crop
          cropTouchedEdge = retryResult.touchedEdge
          if (retryCrop) {
            sourceCropBox = retryBox
            sourceCrop = retryCrop
            requestedTextOperationFilter = retryTextOperationFilter
            requestedExcludedSourceBoxes =
              retryResult.requestedExcludedSourceBoxes
            retainedExcludedSourceBoxes =
              retryCrop.sourceExclusionMask?.excludedSourceBoxes.map((box) => ({
                ...box,
              })) ?? []
            adaptivePaddingRetry = true
            neighborBoundedCrop = true
            break retryEquationCrop
          }
          if (!cropTouchedEdge) break retryEquationCrop
        }
      }
      if (!sourceCrop && (cropTouchedEdge || cropVetoedUnownedText)) {
        for (const padding of EQUATION_SOURCE_CROP_RETRY_PADDINGS) {
          const postExhaustionBox = paddedEquationCropBox(sourceBox, padding)
          if (
            attemptedBoxes.some((attempted) =>
              sameSourceBox(attempted, postExhaustionBox),
            ) ||
            !isBoundedPdfPageCropBox(postExhaustionBox) ||
            !fullyContainsBox(
              postExhaustionBox,
              sourceBox,
              SOURCE_CROP_CONTAINMENT_TOLERANCE,
            )
          ) {
            continue
          }
          const postExhaustionTextOperationFilter =
            sourceTextOperationFilterPlanForEquationCrop(
              postExhaustionBox,
              sourceEquationLineIds,
              regions,
              renderVisibleTextRuns,
              renderOnlyOwnedRunKeys,
            )
          if (
            !postExhaustionTextOperationFilter ||
            postExhaustionTextOperationFilter.algorithm !==
              'pdfjs-display-text-operation-filter-v2' ||
            !postExhaustionTextOperationFilter.ownedSourceBoxes.every((box) =>
              fullyContainsBox(
                postExhaustionBox,
                box,
                SOURCE_CROP_CONTAINMENT_TOLERANCE,
              ),
            )
          ) {
            continue
          }
          attemptedBoxes.push(postExhaustionBox)
          const postExhaustionResult = await rasterizeEquationCrop(
            postExhaustionBox,
            [],
            postExhaustionTextOperationFilter,
          )
          cropTouchedEdge = postExhaustionResult.touchedEdge
          if (postExhaustionResult.crop) {
            sourceCropBox = postExhaustionBox
            sourceCrop = postExhaustionResult.crop
            requestedTextOperationFilter = postExhaustionTextOperationFilter
            requestedExcludedSourceBoxes = []
            retainedExcludedSourceBoxes =
              sourceCrop.sourceExclusionMask?.excludedSourceBoxes.map(
                (box) => ({ ...box }),
              ) ?? []
            adaptivePaddingRetry = true
            postExhaustionV2Retry = true
            neighborBoundedCrop = false
            break
          }
          if (!cropTouchedEdge) break
        }
      }
    }
    if (cropVetoedUnownedText) {
      approximationEvidence.push('source-page-crop-vetoed-unowned-text')
    }
    const cropMatched = Boolean(
      sourceCrop &&
      completeSourcePageCropAsset(
        sourceCrop,
        'equation',
        [sourceObjectId],
        [sourceBox],
        sourceCropBox,
        ownedSourceBoxes,
        requestedExcludedSourceBoxes,
        requestedTextOperationFilter,
      ),
    )
    const appliedRenderOnlyOwnerships = cropMatched
      ? (renderOnlyOwnershipProjection?.ownerships ?? [])
      : []
    if (cropMatched) {
      for (const run of renderOnlyOwnedSourceRuns) {
        resolvedRenderOnlySourceRunKeys.add(
          equationRenderOnlySourceRunIdentity(run),
        )
      }
    }
    if (sourceCrop && cropMatched) mergeAsset(assetStore, sourceCrop)
    const fallbackOwnership = ownership
    const equationGeometryTranscript =
      cropMatched && sourceCrop && transcript === null && fallbackOwnership
        ? createSourceGeometryScriptTranscript({
            sourceRegionIds: fallbackOwnership.sourceRegionIds,
            sourceLineIds: fallbackOwnership.sourceLineIds,
            sourceObjectIds: [sourceObjectId],
            regions,
            sourceCropAsset: sourceCrop,
          })
        : null
    const resolvedTranscriptEvidence = equationGeometryTranscript
      ? [SOURCE_GEOMETRY_SCRIPT_TRANSCRIPT_EVIDENCE]
      : transcriptEvidence
    const evidence = cropMatched
      ? [
          'source-equation-region',
          'bounded-source-geometry',
          ...(sourceScopeComplete
            ? ['source-proved-atomic-equation-component']
            : ['source-preserved-equation-fallback']),
          ...resolvedTranscriptEvidence,
          ...(adaptivePaddingRetry
            ? ['source-page-crop-adaptive-padding']
            : []),
          ...(postExhaustionV2Retry
            ? ['source-page-crop-post-exhaustion-v2']
            : []),
          ...(neighborBoundedCrop ? ['source-page-crop-neighbor-bounded'] : []),
          ...(retainedExcludedSourceBoxes.length > 0 &&
          sourceCrop?.sourceExclusionMask?.algorithm === 'nearest-source-box-v1'
            ? ['source-page-crop-unowned-text-masked']
            : []),
          ...(requestedTextOperationFilter
            ? ['source-page-crop-text-operation-filter-attested']
            : []),
          ...(appliedRenderOnlyOwnerships.length > 0
            ? [RENDER_ONLY_EQUATION_OWNERSHIP_EVIDENCE]
            : []),
          'source-page-crop',
        ]
      : approximationEvidence
    // Exact source identity proves which regions form this equation, but it
    // does not prove that their text has a canonical replacement. Preserve
    // every source line when the rendition is unresolved; otherwise an
    // unavailable crop can silently turn source equations (and adjacent
    // inline obligations) into missing content.
    if (cropMatched) {
      for (const attached of sources) {
        if (attached.id === source.id) continue
        consumeRegionLineSelection(
          attached.id,
          attached.lines.map((line) => line.id),
          regions,
          consumedRegionIds,
          consumedLineIds,
        )
      }
    }
    const relationshipEvidence = cropMatched
      ? evidence
      : [...evidence, 'source-rendition-unavailable']
    relationships.push({
      id: '',
      kind: 'equation',
      label,
      // Keep the primary equation region in reading order so layout can turn
      // its source text into the typed caption for this atomic obligation.
      captionRegionId: source.id,
      sourceRegionIds: fallbackOwnership?.sourceRegionIds ?? [],
      sourceLineIds: fallbackOwnership?.sourceLineIds ?? [],
      sourceObjectIds: cropMatched ? [sourceObjectId] : [],
      assetIds: cropMatched ? [sourceCrop!.id] : [],
      status: cropMatched ? 'matched' : 'unresolved',
      confidence: source.confidence,
      evidence: relationshipEvidence,
      candidates: [
        {
          sourceRegionIds:
            fallbackOwnership?.sourceRegionIds ??
            sources.map((region) => region.id),
          ...(fallbackOwnership
            ? {
                sourceLineIds: fallbackOwnership.sourceLineIds,
                sourceText,
                ownershipExtentSha256: pdfVisualOwnershipExtentSha256(
                  regions,
                  fallbackOwnership.sourceRegionIds,
                  fallbackOwnership.sourceLineIds,
                ),
                ...(appliedRenderOnlyOwnerships.length > 0
                  ? {
                      renderOnlySourceRunOwnerships:
                        appliedRenderOnlyOwnerships,
                    }
                  : {}),
              }
            : {}),
          sourceObjectIds: [sourceObjectId],
          assetIds: cropMatched
            ? [sourceCrop!.id]
            : visualAsset
              ? [visualAsset.id]
              : [],
          score: source.confidence,
          evidence: relationshipEvidence,
          sourceBoxes: [sourceBox],
        },
      ],
      sourceBoxes: sources.map((region) => region.box),
      ...(equationGeometryTranscript ? { equationGeometryTranscript } : {}),
      ...(appliedRenderOnlyOwnerships.length > 0
        ? { renderOnlySourceRunOwnerships: appliedRenderOnlyOwnerships }
        : {}),
      sourceText: transcript?.text ?? '',
      altText: transcript?.text ?? label,
      altTextSource: transcriptResolved ? 'source-text' : 'caption',
      canonicalNodeId: null,
      captionNodeId: null,
    })
    if (!cropMatched) {
      diagnostics.push({
        code: 'UNRESOLVED_VISUAL_OBJECT',
        severity: 'error',
        page: source.page,
        message: transcriptResolved
          ? `${label} has readable source text but no source glyph, path, or raster rendition.`
          : overlappingUnownedSourceText
            ? `${label} has source geometry that materially overlaps unowned text, so no contaminated rectangular crop was retained.`
            : !sourceScopeComplete
              ? `${label} has an incomplete or ambiguously owned adjacent equation source scope, so no partial glyph crop was retained.`
              : `${label} has bounded source geometry but its extracted semantic transcript is unresolved and no source glyph raster is available.`,
        sourceBoxes: sources.map((region) => region.box),
        target: {
          regionIds: sources.map((region) => region.id),
          markerId: null,
        },
      })
    }
  }

  for (const run of unresolvedExtensionTextItems) {
    if (
      resolvedRenderOnlySourceRunKeys.has(
        equationRenderOnlySourceRunIdentity(run),
      )
    ) {
      continue
    }
    const regionIds = regions
      .filter(
        (region) =>
          region.page === run.page &&
          Math.min(region.box.x + region.box.width, run.x + run.width) >
            Math.max(region.box.x, run.x) &&
          Math.min(region.box.y + region.box.height, run.y + run.height) >
            Math.max(region.box.y, run.y),
      )
      .map((region) => region.id)
      .sort()
    diagnostics.push({
      code: 'UNRESOLVED_VISUAL_OBJECT',
      severity: 'error',
      page: run.page,
      message:
        'An extension-font PDF text item decoded from unattested whitespace has no publishable semantic transcript; its exact source box remains a visual review obligation.',
      sourceBoxes: [
        {
          page: run.page,
          x: run.x,
          y: run.y,
          width: run.width,
          height: run.height,
          rotation: run.rotation,
          method: run.method,
        },
      ],
      target: { regionIds, markerId: null },
    })
  }
}

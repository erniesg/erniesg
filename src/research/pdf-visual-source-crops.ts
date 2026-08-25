import type {
  NormalizedSourceBox,
  PdfPageRegion,
  PdfSourceCropAttempt,
  PdfSourceCropAttemptRequest,
  PdfTextOperationFilterPlan,
  PdfVisualAsset,
  PdfVisualRelationship,
} from './import-types'
import {
  isCanonicalPdfSourceExclusionMask,
  isTrustedPdfTextOperationFilterAsset,
  isValidSourcePageCropPayload,
  pdfSourceExclusionMaskIdentity,
} from './visual-assets'

type VisualKind = PdfVisualRelationship['kind']

const MIN_COMPOSITE_FIGURE_FRAGMENTS = 2
const SOURCE_CROP_CONTAINMENT_TOLERANCE = 0.00001

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function fullyContainsBox(
  container: NormalizedSourceBox,
  candidate: NormalizedSourceBox,
  tolerance = 0,
) {
  return (
    container.page === candidate.page &&
    container.rotation === candidate.rotation &&
    candidate.x >= container.x - tolerance &&
    candidate.y >= container.y - tolerance &&
    candidate.x + candidate.width <=
      container.x + container.width + tolerance &&
    candidate.y + candidate.height <= container.y + container.height + tolerance
  )
}

function intersectSourceBox(
  scope: NormalizedSourceBox,
  source: NormalizedSourceBox,
) {
  if (scope.page !== source.page || scope.rotation !== source.rotation) {
    return null
  }
  const left = Math.max(scope.x, source.x)
  const top = Math.max(scope.y, source.y)
  const right = Math.min(scope.x + scope.width, source.x + source.width)
  const bottom = Math.min(scope.y + scope.height, source.y + source.height)
  if (right <= left || bottom <= top) return null
  const clipped = {
    ...source,
    x: rounded(left),
    y: rounded(top),
    width: rounded(right - left),
    height: rounded(bottom - top),
  }
  return clipped.width > 0 && clipped.height > 0 ? clipped : null
}

export function mergePdfVisualAsset(
  store: Map<string, PdfVisualAsset>,
  next: PdfVisualAsset,
) {
  const current = store.get(next.id)
  if (!current) {
    store.set(next.id, next)
    return
  }
  for (const [index, sourceObjectId] of next.sourceObjectIds.entries()) {
    if (current.sourceObjectIds.includes(sourceObjectId)) continue
    current.sourceObjectIds.push(sourceObjectId)
    current.sourceBoxes.push({ ...next.sourceBoxes[index] })
  }
}

export function samePdfSourceBox(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  return (
    left.page === right.page &&
    left.rotation === right.rotation &&
    left.method === right.method &&
    (['x', 'y', 'width', 'height'] as const).every(
      (key) => Math.abs(left[key] - right[key]) <= 0.00001,
    )
  )
}

function hasValidPayload(asset: PdfVisualAsset) {
  return (
    asset.id.trim().length > 0 &&
    asset.href.trim().length > 0 &&
    asset.bytes.byteLength > 0 &&
    Number.isFinite(asset.width) &&
    asset.width > 0 &&
    Number.isFinite(asset.height) &&
    asset.height > 0
  )
}

export function completeSingleSourcePdfVisualAsset(
  visualAsset: PdfVisualAsset | undefined,
  sourceObjectId: string,
  sourceBox: NormalizedSourceBox,
) {
  if (
    !visualAsset ||
    !sourceObjectId.trim() ||
    !hasValidPayload(visualAsset) ||
    !['source-preserved', 'semantic-table'].includes(visualAsset.rendition) ||
    visualAsset.sourceObjectIds.length !== visualAsset.sourceBoxes.length
  ) {
    return false
  }
  const assetIndex = visualAsset.sourceObjectIds.indexOf(sourceObjectId)
  return (
    assetIndex >= 0 &&
    samePdfSourceBox(visualAsset.sourceBoxes[assetIndex], sourceBox)
  )
}

export function materiallyOverlapsPdfSourceText(
  objectRegion: PdfPageRegion,
  textSources: PdfPageRegion[],
) {
  return textSources.some((source) => {
    if (source.page !== objectRegion.page) return false
    if (
      source.nativeObjectIds.some((sourceObjectId) =>
        objectRegion.nativeObjectIds.includes(sourceObjectId),
      )
    ) {
      return true
    }
    const width = Math.max(
      0,
      Math.min(
        source.box.x + source.box.width,
        objectRegion.box.x + objectRegion.box.width,
      ) - Math.max(source.box.x, objectRegion.box.x),
    )
    const height = Math.max(
      0,
      Math.min(
        source.box.y + source.box.height,
        objectRegion.box.y + objectRegion.box.height,
      ) - Math.max(source.box.y, objectRegion.box.y),
    )
    const smallerArea = Math.min(
      source.box.width * source.box.height,
      objectRegion.box.width * objectRegion.box.height,
    )
    return smallerArea > 0 && (width * height) / smallerArea >= 0.35
  })
}

export function completeCompositePdfVisualAsset(
  visualAsset: PdfVisualAsset,
  sourceObjectIds: string[],
  sourceBoxes: NormalizedSourceBox[],
) {
  const sourcePreservedSvgComposite =
    visualAsset.mediaType === 'image/svg+xml' &&
    visualAsset.kind === 'vector' &&
    visualAsset.rendition === 'source-preserved' &&
    new TextDecoder()
      .decode(visualAsset.bytes)
      .includes('data-pdf-composite="true"')
  const rasterComposite =
    visualAsset.mediaType === 'image/png' &&
    visualAsset.kind === 'raster' &&
    visualAsset.rendition === 'browser-composite-raster'
  if (
    (!rasterComposite && !sourcePreservedSvgComposite) ||
    !hasValidPayload(visualAsset) ||
    sourceObjectIds.length < MIN_COMPOSITE_FIGURE_FRAGMENTS ||
    sourceObjectIds.length !== sourceBoxes.length ||
    visualAsset.sourceObjectIds.length !== sourceObjectIds.length ||
    visualAsset.sourceBoxes.length !== sourceObjectIds.length ||
    new Set(visualAsset.sourceObjectIds).size !== sourceObjectIds.length
  ) {
    return false
  }
  return sourceObjectIds.every((sourceObjectId, index) => {
    const assetIndex = visualAsset.sourceObjectIds.indexOf(sourceObjectId)
    return (
      assetIndex >= 0 &&
      samePdfSourceBox(visualAsset.sourceBoxes[assetIndex], sourceBoxes[index])
    )
  })
}

export function completeSourcePageCropPdfVisualAsset(
  visualAsset: PdfVisualAsset,
  kind: VisualKind,
  sourceObjectIds: string[],
  sourceBoxes: NormalizedSourceBox[],
  sourceCropBox: NormalizedSourceBox,
  expectedOwnedSourceBoxes: readonly NormalizedSourceBox[] = [],
  expectedExcludedSourceBoxes: readonly NormalizedSourceBox[] = [],
  expectedTextOperationFilter: PdfTextOperationFilterPlan | null = null,
) {
  const actualMaskIdentity = pdfSourceExclusionMaskIdentity(
    visualAsset.sourceExclusionMask,
    sourceCropBox,
  )
  const textOperationFilterMatches =
    expectedTextOperationFilter !== null &&
    visualAsset.sourceExclusionMask?.algorithm ===
      'pdfjs-display-text-operation-filter-v2' &&
    visualAsset.sourceExclusionMask.displayOperatorAdapter ===
      expectedTextOperationFilter.displayOperatorAdapter &&
    visualAsset.sourceExclusionMask.sourceTextLedgerSha256 ===
      expectedTextOperationFilter.sourceTextLedgerSha256 &&
    JSON.stringify(visualAsset.sourceExclusionMask.ownedTextLedgerSpans) ===
      JSON.stringify(expectedTextOperationFilter.ownedTextLedgerSpans) &&
    JSON.stringify(visualAsset.sourceExclusionMask.excludedTextLedgerSpans) ===
      JSON.stringify(expectedTextOperationFilter.excludedTextLedgerSpans) &&
    visualAsset.sourceExclusionMask.ownedSourceBoxes.length ===
      expectedTextOperationFilter.ownedSourceBoxes.length &&
    visualAsset.sourceExclusionMask.excludedSourceBoxes.length ===
      expectedTextOperationFilter.excludedSourceBoxes.length &&
    expectedTextOperationFilter.ownedSourceBoxes.every((expected) =>
      visualAsset.sourceExclusionMask!.ownedSourceBoxes.some((actual) =>
        samePdfSourceBox(actual, expected),
      ),
    ) &&
    expectedTextOperationFilter.excludedSourceBoxes.every((expected) =>
      visualAsset.sourceExclusionMask!.excludedSourceBoxes.some((actual) =>
        samePdfSourceBox(actual, expected),
      ),
    )
  const trustedTextOperationFilter =
    expectedTextOperationFilter === null ||
    isTrustedPdfTextOperationFilterAsset(visualAsset)
  const expectedMaskIdentity =
    !expectedTextOperationFilter &&
    expectedOwnedSourceBoxes.length > 0 &&
    expectedExcludedSourceBoxes.length > 0
      ? pdfSourceExclusionMaskIdentity(
          {
            algorithm: 'nearest-source-box-v1',
            expansionPixels: 2,
            ownedSourceBoxes: [...expectedOwnedSourceBoxes],
            excludedSourceBoxes: [...expectedExcludedSourceBoxes],
          },
          sourceCropBox,
        )
      : null
  return (
    (!visualAsset.sourceExclusionMask ||
      (actualMaskIdentity !== null &&
        isCanonicalPdfSourceExclusionMask(
          visualAsset.sourceExclusionMask,
          sourceCropBox,
        ))) &&
    (expectedTextOperationFilter
      ? textOperationFilterMatches && trustedTextOperationFilter
      : JSON.stringify(actualMaskIdentity) ===
        JSON.stringify(expectedMaskIdentity)) &&
    sourcePageCropValidationFailure(
      visualAsset,
      kind,
      sourceObjectIds,
      sourceBoxes,
      sourceCropBox,
    ) === null
  )
}

export function sourcePageCropValidationFailure(
  visualAsset: PdfVisualAsset,
  kind: VisualKind,
  sourceObjectIds: string[],
  sourceBoxes: NormalizedSourceBox[],
  sourceCropBox: NormalizedSourceBox,
) {
  const expectedKind = kind === 'figure' ? 'raster' : kind
  if (
    visualAsset.mediaType !== 'image/png' ||
    visualAsset.kind !== expectedKind ||
    visualAsset.rendition !== 'source-page-crop'
  ) {
    return 'source-page-crop-rendition-rejected'
  }
  if (!visualAsset.sourceCropBox) {
    return 'source-page-crop-identity-rejected'
  }
  const sourceInkTightened = !samePdfSourceBox(
    visualAsset.sourceCropBox,
    sourceCropBox,
  )
  if (
    sourceInkTightened &&
    (kind !== 'figure' ||
      visualAsset.sourceCropBox.method !== sourceCropBox.method ||
      !fullyContainsBox(
        sourceCropBox,
        visualAsset.sourceCropBox,
        SOURCE_CROP_CONTAINMENT_TOLERANCE,
      ))
  ) {
    return 'source-page-crop-identity-rejected'
  }
  if (
    !hasValidPayload(visualAsset) ||
    !isValidSourcePageCropPayload(visualAsset)
  ) {
    return 'source-page-crop-payload-rejected'
  }
  if (
    sourceObjectIds.length === 0 ||
    sourceObjectIds.length !== sourceBoxes.length ||
    new Set(sourceObjectIds).size !== sourceObjectIds.length
  ) {
    return 'source-page-crop-lineage-rejected'
  }
  const expectedLineage = sourceInkTightened
    ? sourceObjectIds.flatMap((sourceObjectId, index) => {
        const clippedBox = intersectSourceBox(
          visualAsset.sourceCropBox!,
          sourceBoxes[index],
        )
        return clippedBox ? [{ sourceObjectId, sourceBox: clippedBox }] : []
      })
    : sourceObjectIds.map((sourceObjectId, index) => ({
        sourceObjectId,
        sourceBox: sourceBoxes[index],
      }))
  if (
    expectedLineage.length === 0 ||
    expectedLineage.length !== sourceObjectIds.length ||
    visualAsset.sourceObjectIds.length !== expectedLineage.length ||
    visualAsset.sourceBoxes.length !== expectedLineage.length ||
    new Set(visualAsset.sourceObjectIds).size !== expectedLineage.length
  ) {
    return 'source-page-crop-lineage-rejected'
  }
  if (
    visualAsset.sourceBoxes.some(
      (sourceBox) =>
        !fullyContainsBox(
          visualAsset.sourceCropBox!,
          sourceBox,
          SOURCE_CROP_CONTAINMENT_TOLERANCE,
        ),
    )
  ) {
    return 'source-page-crop-containment-rejected'
  }
  const exactLineage = expectedLineage.every((item) => {
    const assetIndex = visualAsset.sourceObjectIds.indexOf(item.sourceObjectId)
    return (
      assetIndex >= 0 &&
      samePdfSourceBox(visualAsset.sourceBoxes[assetIndex], item.sourceBox)
    )
  })
  return exactLineage ? null : 'source-page-crop-lineage-geometry-rejected'
}

export function sourcePageCropFailureEvidence(error: unknown) {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'source-page-crop-aborted'
  }
  const message = error instanceof Error ? error.message : ''
  if (/timed out/i.test(message)) return 'source-page-crop-timeout'
  if (/source ink touching its edge/i.test(message)) {
    return 'source-page-crop-edge-contact'
  }
  if (/bounded|rotation|source region/i.test(message)) {
    return 'source-page-crop-geometry-rejected'
  }
  if (/pixel|ink|png|rgba/i.test(message)) {
    return 'source-page-crop-payload-rejected'
  }
  if (/canvas|render|bitmap|image\s*data/i.test(message)) {
    return 'source-page-crop-render-backend-error'
  }
  return 'source-page-crop-rasterization-error'
}

export function sourcePageCropTouchesEdge(error: unknown) {
  return (
    error instanceof Error &&
    /source ink touching its edge/i.test(error.message)
  )
}

function sourceCropAttemptRequestSnapshot(
  input: PdfSourceCropAttemptRequest,
): PdfSourceCropAttemptRequest {
  return {
    kind: input.kind,
    page: input.page,
    sourceBox: { ...input.sourceBox },
    sourceObjectIds: [...input.sourceObjectIds],
    sourceBoxes: input.sourceBoxes.map((box) => ({ ...box })),
    ...(input.ownedSourceBoxes
      ? {
          ownedSourceBoxes: input.ownedSourceBoxes.map((box) => ({ ...box })),
        }
      : {}),
    ...(input.excludedSourceBoxes
      ? {
          excludedSourceBoxes: input.excludedSourceBoxes.map((box) => ({
            ...box,
          })),
        }
      : {}),
    ...(input.sourceTextOperationFilter
      ? {
          sourceTextOperationFilter: {
            ...input.sourceTextOperationFilter,
            ownedTextLedgerSpans:
              input.sourceTextOperationFilter.ownedTextLedgerSpans.map(
                (span) => ({ ...span }),
              ),
            excludedTextLedgerSpans:
              input.sourceTextOperationFilter.excludedTextLedgerSpans.map(
                (span) => ({ ...span }),
              ),
            ownedSourceBoxes:
              input.sourceTextOperationFilter.ownedSourceBoxes.map((box) => ({
                ...box,
              })),
            excludedSourceBoxes:
              input.sourceTextOperationFilter.excludedSourceBoxes.map(
                (box) => ({ ...box }),
              ),
          },
        }
      : {}),
    ...(input.tightenToSourceInk === undefined
      ? {}
      : { tightenToSourceInk: input.tightenToSourceInk }),
  }
}

function sourceCropAttemptFamilyKey(input: PdfSourceCropAttemptRequest) {
  const snapshot = sourceCropAttemptRequestSnapshot(input)
  return JSON.stringify({
    kind: snapshot.kind,
    page: snapshot.page,
    sourceObjectIds: snapshot.sourceObjectIds,
    sourceBoxes: snapshot.sourceBoxes,
    ownedSourceBoxes: snapshot.ownedSourceBoxes ?? null,
    excludedSourceBoxes: snapshot.excludedSourceBoxes ?? null,
    sourceTextOperationFilter: snapshot.sourceTextOperationFilter ?? null,
    tightenToSourceInk: snapshot.tightenToSourceInk ?? true,
  })
}

export function withSourceCropAttemptProvenance(
  rasterizeFigure: (
    input: PdfSourceCropAttemptRequest,
  ) => Promise<PdfVisualAsset | null>,
) {
  const pendingEdgeAttempts = new Map<string, PdfSourceCropAttempt[]>()
  return async (input: PdfSourceCropAttemptRequest) => {
    const familyKey = sourceCropAttemptFamilyKey(input)
    const priorAttempts = pendingEdgeAttempts.get(familyKey) ?? []
    const request = sourceCropAttemptRequestSnapshot(input)
    try {
      const rasterized = await rasterizeFigure(input)
      if (!rasterized) {
        pendingEdgeAttempts.delete(familyKey)
        return null
      }
      const acceptedAttempt: PdfSourceCropAttempt = {
        schemaVersion: '1.0.0',
        sequence: priorAttempts.length + 1,
        request,
        outcome: {
          status: 'accepted',
          assetId: rasterized.id,
          assetSha256: rasterized.sha256,
        },
      }
      rasterized.sourceCropAttempts = [...priorAttempts, acceptedAttempt]
      pendingEdgeAttempts.delete(familyKey)
      return rasterized
    } catch (error) {
      if (sourcePageCropTouchesEdge(error)) {
        pendingEdgeAttempts.set(familyKey, [
          ...priorAttempts,
          {
            schemaVersion: '1.0.0',
            sequence: priorAttempts.length + 1,
            request,
            outcome: {
              status: 'edge-contact',
              evidence: 'source-page-crop-edge-contact',
            },
          },
        ])
      } else {
        pendingEdgeAttempts.delete(familyKey)
      }
      throw error
    }
  }
}

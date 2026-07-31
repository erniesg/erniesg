import type {
  NormalizedSourceBox,
  PdfSourceExclusionMask,
  PdfResolvedTextOperationFilterRequest,
  PdfTextOperationFilterRequest,
} from './import-types'
import { sha256HexSync } from './sha256-sync'
import {
  capturePinnedPdfjsDisplayOperatorList,
  createPdfDisplayOperationsFilterAttestation,
  PDFJS_DISPLAY_OPERATOR_ADAPTER,
  PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD,
  PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS,
  PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION,
  provePdfDisplayTextOperationFilter,
} from './pdf-text-paint'

export const MAX_PDF_PAGE_CROP_PIXELS = 3_200_000
export const PDF_PAGE_CROP_TIMEOUT_MS = 15_000
export const MAX_SOURCE_PAGE_CROP_AREA = 0.72
const SOURCE_INK_PADDING = 0.004
const SOURCE_EXCLUSION_EXPANSION_PIXELS = 2
const SOURCE_OWNED_PROTECTION_PIXELS = 1
const MAX_SOURCE_EXCLUSION_BOXES = 32
const MAX_SOURCE_EXCLUSION_OWNED_BOXES = 256
const MAX_MASKED_EDGE_COMPONENT_PIXELS = 32
const MAX_MASKED_EDGE_COMPONENT_SPAN = 8

type CropCanvas = {
  width: number
  height: number
}

type CropCanvasContext = {
  fillStyle: string
  fillRect(x: number, y: number, width: number, height: number): void
  getImageData(
    x: number,
    y: number,
    width: number,
    height: number,
  ): { data: Uint8ClampedArray }
}

export type PdfCanvasFactory = {
  create(
    width: number,
    height: number,
  ): {
    canvas: CropCanvas
    context: CropCanvasContext
  }
  destroy(canvasAndContext: {
    canvas: CropCanvas
    context: CropCanvasContext
  }): void
}

export type PdfPageCropSource = {
  pageNumber?: number
  _intentStates?: unknown
  getViewport(options: { scale: number }): {
    width: number
    height: number
    rotation?: number
  }
  render(options: {
    canvas: CropCanvas
    canvasContext: CropCanvasContext
    viewport: { width: number; height: number; rotation?: number }
    transform: number[]
    background: string
    operationsFilter?: (index: number) => boolean
  }): { promise: Promise<unknown>; cancel?: () => void }
}

export type PdfPageCropRaster = {
  width: number
  height: number
  pixels: Uint8Array
  resolutionDpi: number
  sourceBox: NormalizedSourceBox
  sourceExclusionMask?: PdfSourceExclusionMask
}

const trustedTextOperationFilterRasters = new WeakMap<object, string>()

function textOperationFilterRasterFingerprint(value: PdfPageCropRaster) {
  return sha256HexSync(
    JSON.stringify({
      width: value.width,
      height: value.height,
      resolutionDpi: value.resolutionDpi,
      sourceBox: sourceBoxIdentity(value.sourceBox),
      sourceExclusionMask: value.sourceExclusionMask,
      pixelsSha256: sha256HexSync(value.pixels),
    }),
  )
}

export function isTrustedPdfTextOperationFilterRaster(
  value: object | null | undefined,
) {
  if (!value) return false
  const expected = trustedTextOperationFilterRasters.get(value)
  if (!expected) return false
  try {
    return (
      textOperationFilterRasterFingerprint(value as PdfPageCropRaster) ===
      expected
    )
  } catch {
    return false
  }
}

type UnscaledPdfPageCropRaster = Omit<PdfPageCropRaster, 'resolutionDpi'>

function isSourceInkPixel(pixels: Uint8Array, offset: number) {
  const alpha = pixels[offset + 3] / 255
  const red = pixels[offset] * alpha + 255 * (1 - alpha)
  const green = pixels[offset + 1] * alpha + 255 * (1 - alpha)
  const blue = pixels[offset + 2] * alpha + 255 * (1 - alpha)
  return Math.min(red, green, blue) < 248
}

export function hasSourceInkOnCropEdge(
  pixels: Uint8Array,
  width: number,
  height: number,
) {
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    !Number.isInteger(height) ||
    height < 1 ||
    pixels.byteLength !== width * height * 4
  ) {
    return true
  }
  for (let x = 0; x < width; x += 1) {
    if (
      isSourceInkPixel(pixels, x * 4) ||
      isSourceInkPixel(pixels, ((height - 1) * width + x) * 4)
    ) {
      return true
    }
  }
  for (let y = 1; y < height - 1; y += 1) {
    if (
      isSourceInkPixel(pixels, y * width * 4) ||
      isSourceInkPixel(pixels, (y * width + width - 1) * 4)
    ) {
      return true
    }
  }
  return false
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function boundedRoundedExtent(start: number, end: number) {
  const extent = rounded(end - start)
  // Decimal canonicalization can round the extent one floating-point unit
  // beyond its already-bounded endpoint. Keep the canonical extent when it
  // fits; otherwise move it inward by the smallest safe normalized epsilon.
  return start + extent <= end ? extent : extent - Number.EPSILON
}

function sourceInkBounds(pixels: Uint8Array, width: number, height: number) {
  let left = width
  let top = height
  let right = 0
  let bottom = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isSourceInkPixel(pixels, (y * width + x) * 4)) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x + 1)
      bottom = Math.max(bottom, y + 1)
    }
  }
  return right > left && bottom > top ? { left, top, right, bottom } : null
}

function tightenRasterToSourceInk(
  pixels: Uint8Array,
  width: number,
  height: number,
  sourceBox: NormalizedSourceBox,
): UnscaledPdfPageCropRaster {
  const ink = sourceInkBounds(pixels, width, height)
  if (!ink) return { width, height, pixels, sourceBox }
  const normalizedPixelWidth = sourceBox.width / width
  const normalizedPixelHeight = sourceBox.height / height
  const horizontalPadding = Math.max(
    1,
    Math.ceil(SOURCE_INK_PADDING / normalizedPixelWidth),
  )
  const verticalPadding = Math.max(
    1,
    Math.ceil(SOURCE_INK_PADDING / normalizedPixelHeight),
  )
  const left = Math.max(0, ink.left - horizontalPadding)
  const top = Math.max(0, ink.top - verticalPadding)
  const right = Math.min(width, ink.right + horizontalPadding)
  const bottom = Math.min(height, ink.bottom + verticalPadding)
  if (left === 0 && top === 0 && right === width && bottom === height) {
    return { width, height, pixels, sourceBox }
  }
  const tightenedWidth = right - left
  const tightenedHeight = bottom - top
  const tightenedPixels = new Uint8Array(tightenedWidth * tightenedHeight * 4)
  for (let y = 0; y < tightenedHeight; y += 1) {
    const sourceOffset = ((top + y) * width + left) * 4
    const targetOffset = y * tightenedWidth * 4
    tightenedPixels.set(
      pixels.subarray(sourceOffset, sourceOffset + tightenedWidth * 4),
      targetOffset,
    )
  }
  const tightenedLeft = sourceBox.x + left * normalizedPixelWidth
  const tightenedTop = sourceBox.y + top * normalizedPixelHeight
  const tightenedRight = sourceBox.x + right * normalizedPixelWidth
  const tightenedBottom = sourceBox.y + bottom * normalizedPixelHeight
  return {
    width: tightenedWidth,
    height: tightenedHeight,
    pixels: tightenedPixels,
    sourceBox: {
      ...sourceBox,
      x: rounded(tightenedLeft),
      y: rounded(tightenedTop),
      width: rounded(tightenedRight - tightenedLeft),
      height: rounded(tightenedBottom - tightenedTop),
    },
  }
}

export function isBoundedPdfPageCropBox(sourceBox: NormalizedSourceBox) {
  return (
    sourceBox.width * sourceBox.height <= MAX_SOURCE_PAGE_CROP_AREA &&
    !(sourceBox.width >= 0.8 && sourceBox.height >= 0.8)
  )
}

function validateSourceBox(
  page: PdfPageCropSource,
  sourceBox: NormalizedSourceBox,
) {
  const values = [sourceBox.x, sourceBox.y, sourceBox.width, sourceBox.height]
  if (
    !Number.isInteger(sourceBox.page) ||
    sourceBox.page < 1 ||
    (page.pageNumber !== undefined && page.pageNumber !== sourceBox.page) ||
    values.some((value) => !Number.isFinite(value)) ||
    sourceBox.x < 0 ||
    sourceBox.y < 0 ||
    sourceBox.width <= 0 ||
    sourceBox.height <= 0 ||
    sourceBox.x + sourceBox.width > 1 ||
    sourceBox.y + sourceBox.height > 1 ||
    !isBoundedPdfPageCropBox(sourceBox)
  ) {
    throw new Error(
      'PDF page crop requires one valid bounded normalized page region',
    )
  }
}

function abortError() {
  const error = new Error('PDF page crop was cancelled')
  error.name = 'AbortError'
  return error
}

function validOwnedSourceBox(
  sourceBox: NormalizedSourceBox,
  ownedSourceBox: NormalizedSourceBox,
) {
  const tolerance = 0.00001
  return (
    ownedSourceBox.page === sourceBox.page &&
    ownedSourceBox.rotation === sourceBox.rotation &&
    [
      ownedSourceBox.x,
      ownedSourceBox.y,
      ownedSourceBox.width,
      ownedSourceBox.height,
    ].every(Number.isFinite) &&
    ownedSourceBox.width > 0 &&
    ownedSourceBox.height > 0 &&
    ownedSourceBox.x >= sourceBox.x - tolerance &&
    ownedSourceBox.y >= sourceBox.y - tolerance &&
    ownedSourceBox.x + ownedSourceBox.width <=
      sourceBox.x + sourceBox.width + tolerance &&
    ownedSourceBox.y + ownedSourceBox.height <=
      sourceBox.y + sourceBox.height + tolerance
  )
}

function validPageSourceBox(
  sourceBox: NormalizedSourceBox,
  candidate: NormalizedSourceBox,
) {
  return (
    candidate.page === sourceBox.page &&
    candidate.rotation === sourceBox.rotation &&
    [candidate.x, candidate.y, candidate.width, candidate.height].every(
      Number.isFinite,
    ) &&
    candidate.x >= 0 &&
    candidate.y >= 0 &&
    candidate.width > 0 &&
    candidate.height > 0 &&
    candidate.x + candidate.width <= 1 &&
    candidate.y + candidate.height <= 1
  )
}

function sourceBoxIdentity(box: NormalizedSourceBox) {
  return [
    box.page,
    Object.is(box.x, -0) ? 0 : box.x,
    Object.is(box.y, -0) ? 0 : box.y,
    Object.is(box.width, -0) ? 0 : box.width,
    Object.is(box.height, -0) ? 0 : box.height,
    box.rotation,
    box.method,
  ] as const
}

function compareSourceBoxes(
  first: NormalizedSourceBox,
  second: NormalizedSourceBox,
) {
  const firstIdentity = sourceBoxIdentity(first)
  const secondIdentity = sourceBoxIdentity(second)
  for (let index = 0; index < firstIdentity.length; index += 1) {
    const firstValue = firstIdentity[index]
    const secondValue = secondIdentity[index]
    if (firstValue === secondValue) continue
    return firstValue < secondValue ? -1 : 1
  }
  return 0
}

function canonicalSourceBoxes(boxes: readonly NormalizedSourceBox[]) {
  const unique = new Map<string, NormalizedSourceBox>()
  for (const box of boxes) {
    const canonical = {
      ...box,
      x: Object.is(box.x, -0) ? 0 : box.x,
      y: Object.is(box.y, -0) ? 0 : box.y,
      width: Object.is(box.width, -0) ? 0 : box.width,
      height: Object.is(box.height, -0) ? 0 : box.height,
    }
    unique.set(JSON.stringify(sourceBoxIdentity(canonical)), canonical)
  }
  return [...unique.values()].sort(compareSourceBoxes)
}

function sourceBoxesIntersect(
  first: NormalizedSourceBox,
  second: NormalizedSourceBox,
) {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  )
}

function pixelBox(
  box: NormalizedSourceBox,
  sourceBox: NormalizedSourceBox,
  viewportWidth: number,
  viewportHeight: number,
) {
  return {
    left: (box.x - sourceBox.x) * viewportWidth,
    top: (box.y - sourceBox.y) * viewportHeight,
    right: (box.x + box.width - sourceBox.x) * viewportWidth,
    bottom: (box.y + box.height - sourceBox.y) * viewportHeight,
  }
}

function pixelDistanceToBox(
  x: number,
  y: number,
  box: ReturnType<typeof pixelBox>,
) {
  const horizontal =
    x < box.left ? box.left - x : x > box.right ? x - box.right : 0
  const vertical =
    y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0
  return Math.hypot(horizontal, vertical)
}

function boxIsAdjacentToCropEdge(
  box: ReturnType<typeof pixelBox>,
  width: number,
  height: number,
) {
  const expansion = SOURCE_EXCLUSION_EXPANSION_PIXELS
  const overlapsHorizontally =
    box.right >= -expansion && box.left <= width + expansion
  const overlapsVertically =
    box.bottom >= -expansion && box.top <= height + expansion
  return (
    (overlapsHorizontally &&
      ((box.top <= expansion && box.bottom >= -expansion) ||
        (box.top <= height + expansion && box.bottom >= height - expansion))) ||
    (overlapsVertically &&
      ((box.left <= expansion && box.right >= -expansion) ||
        (box.left <= width + expansion && box.right >= width - expansion)))
  )
}

function pixelTouchesProtectedBox(
  x: number,
  y: number,
  box: ReturnType<typeof pixelBox>,
) {
  return (
    x + 1 >= box.left - SOURCE_OWNED_PROTECTION_PIXELS &&
    x <= box.right + SOURCE_OWNED_PROTECTION_PIXELS &&
    y + 1 >= box.top - SOURCE_OWNED_PROTECTION_PIXELS &&
    y <= box.bottom + SOURCE_OWNED_PROTECTION_PIXELS
  )
}

function maskExcludedEdgeComponents({
  pixels,
  width,
  height,
  sourceBox,
  viewportWidth,
  viewportHeight,
  ownedSourceBoxes,
  excludedSourceBoxes,
}: {
  pixels: Uint8Array
  width: number
  height: number
  sourceBox: NormalizedSourceBox
  viewportWidth: number
  viewportHeight: number
  ownedSourceBoxes: readonly NormalizedSourceBox[]
  excludedSourceBoxes: readonly NormalizedSourceBox[]
}) {
  const owned = ownedSourceBoxes.map((box) =>
    pixelBox(box, sourceBox, viewportWidth, viewportHeight),
  )
  const excluded = excludedSourceBoxes.map((box) =>
    pixelBox(box, sourceBox, viewportWidth, viewportHeight),
  )
  if (excluded.some((box) => !boxIsAdjacentToCropEdge(box, width, height))) {
    throw new Error(
      'PDF page crop excluded source boxes must be adjacent to its crop edge',
    )
  }

  const pixelCount = width * height
  const visited = new Uint8Array(pixelCount)
  const queue = new Int32Array(pixelCount)
  const component = new Int32Array(MAX_MASKED_EDGE_COMPONENT_PIXELS)
  let changedPixels = 0

  const inspectEdgeComponent = (seed: number) => {
    if (visited[seed] || !isSourceInkPixel(pixels, seed * 4)) {
      return
    }
    let queueHead = 0
    let queueLength = 1
    let componentLength = 0
    let safe = true
    let left = width
    let top = height
    let right = 0
    let bottom = 0
    queue[0] = seed
    visited[seed] = 1

    while (queueHead < queueLength) {
      const index = queue[queueHead]
      queueHead += 1
      const x = index % width
      const y = Math.floor(index / width)
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x + 1)
      bottom = Math.max(bottom, y + 1)
      if (componentLength < component.length) {
        component[componentLength] = index
      } else {
        safe = false
      }
      componentLength += 1

      const centerX = x + 0.5
      const centerY = y + 0.5
      if (
        !excluded.some(
          (box) =>
            pixelDistanceToBox(centerX, centerY, box) <=
            SOURCE_EXCLUSION_EXPANSION_PIXELS,
        ) ||
        owned.some((box) => pixelTouchesProtectedBox(x, y, box))
      ) {
        safe = false
      }

      for (
        let neighborY = Math.max(0, y - 1);
        neighborY <= Math.min(height - 1, y + 1);
        neighborY += 1
      ) {
        for (
          let neighborX = Math.max(0, x - 1);
          neighborX <= Math.min(width - 1, x + 1);
          neighborX += 1
        ) {
          if (neighborX === x && neighborY === y) continue
          const neighbor = neighborY * width + neighborX
          if (visited[neighbor] || !isSourceInkPixel(pixels, neighbor * 4)) {
            continue
          }
          visited[neighbor] = 1
          queue[queueLength] = neighbor
          queueLength += 1
        }
      }
    }

    if (
      !safe ||
      componentLength > MAX_MASKED_EDGE_COMPONENT_PIXELS ||
      right - left > MAX_MASKED_EDGE_COMPONENT_SPAN ||
      bottom - top > MAX_MASKED_EDGE_COMPONENT_SPAN
    ) {
      return
    }
    for (let index = 0; index < componentLength; index += 1) {
      const offset = component[index] * 4
      pixels[offset] = 255
      pixels[offset + 1] = 255
      pixels[offset + 2] = 255
      pixels[offset + 3] = 255
      changedPixels += 1
    }
  }

  for (let x = 0; x < width; x += 1) {
    inspectEdgeComponent(x)
    if (height > 1) {
      inspectEdgeComponent((height - 1) * width + x)
    }
  }
  for (let y = 1; y < height - 1; y += 1) {
    inspectEdgeComponent(y * width)
    if (width > 1) {
      inspectEdgeComponent(y * width + width - 1)
    }
  }
  if (hasSourceInkOnCropEdge(pixels, width, height)) {
    return changedPixels
  }
  for (const excludedBox of excluded) {
    const left = Math.max(
      0,
      Math.floor(excludedBox.left - SOURCE_EXCLUSION_EXPANSION_PIXELS),
    )
    const top = Math.max(
      0,
      Math.floor(excludedBox.top - SOURCE_EXCLUSION_EXPANSION_PIXELS),
    )
    const right = Math.min(
      width,
      Math.ceil(excludedBox.right + SOURCE_EXCLUSION_EXPANSION_PIXELS),
    )
    const bottom = Math.min(
      height,
      Math.ceil(excludedBox.bottom + SOURCE_EXCLUSION_EXPANSION_PIXELS),
    )
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        if (!isSourceInkPixel(pixels, (y * width + x) * 4)) continue
        const centerX = x + 0.5
        const centerY = y + 0.5
        const insideExcludedZone =
          pixelDistanceToBox(centerX, centerY, excludedBox) <=
          SOURCE_EXCLUSION_EXPANSION_PIXELS
        if (!insideExcludedZone) continue
        const protectedByOwnedSource = owned.some((box) =>
          pixelTouchesProtectedBox(x, y, box),
        )
        if (!protectedByOwnedSource) {
          throw new Error(
            'PDF page crop exclusion mask left disconnected unprotected source ink',
          )
        }
      }
    }
  }
  return changedPixels
}

function canonicalMaskSourceBoxes({
  sourceBox,
  ownedSourceBoxes,
  excludedSourceBoxes,
}: {
  sourceBox: NormalizedSourceBox
  ownedSourceBoxes?: readonly NormalizedSourceBox[]
  excludedSourceBoxes?: readonly NormalizedSourceBox[]
}) {
  const owned = ownedSourceBoxes
    ? canonicalSourceBoxes(ownedSourceBoxes)
    : undefined
  const excluded = excludedSourceBoxes
    ? canonicalSourceBoxes(excludedSourceBoxes)
    : undefined
  if (
    owned &&
    (owned.length === 0 ||
      owned.length > MAX_SOURCE_EXCLUSION_OWNED_BOXES ||
      owned.some((box) => !validOwnedSourceBox(sourceBox, box)))
  ) {
    throw new Error(
      'PDF page crop owned source boxes must be bounded by its source region',
    )
  }
  if (
    excluded &&
    (excluded.length === 0 ||
      excluded.length > MAX_SOURCE_EXCLUSION_BOXES ||
      !owned?.length ||
      excluded.some((box) => !validPageSourceBox(sourceBox, box)))
  ) {
    throw new Error(
      'PDF page crop excluded source boxes must be valid normalized page regions',
    )
  }
  if (
    excluded?.some((excludedBox) =>
      owned?.some((ownedBox) => sourceBoxesIntersect(ownedBox, excludedBox)),
    )
  ) {
    throw new Error(
      'PDF page crop owned and excluded source boxes must not intersect',
    )
  }
  return {
    ownedSourceBoxes: owned,
    excludedSourceBoxes: excluded,
  }
}

function canonicalTextOperationFilter(
  sourceBox: NormalizedSourceBox,
  request: PdfTextOperationFilterRequest | undefined,
) {
  if (!request) return null
  const ownedSourceBoxes = canonicalSourceBoxes(request.ownedSourceBoxes)
  const excludedSourceBoxes = canonicalSourceBoxes(request.excludedSourceBoxes)
  const canonicalSpans = (values: readonly { start: number; end: number }[]) =>
    values.length > 0 &&
    values.length <= MAX_SOURCE_EXCLUSION_OWNED_BOXES &&
    values.every(
      ({ start, end }) =>
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 0 &&
        end > start,
    )
      ? values
          .map(({ start, end }) => ({ start, end }))
          .sort(
            (left, right) => left.start - right.start || left.end - right.end,
          )
      : null
  const ownedTextLedgerSpans = canonicalSpans(request.ownedTextLedgerSpans)
  const excludedTextLedgerSpans = canonicalSpans(
    request.excludedTextLedgerSpans,
  )
  if (
    request.algorithm !== 'pdfjs-display-text-operation-filter-v2' ||
    request.expansionPixels !== 0 ||
    request.displayOperatorAdapter !== PDFJS_DISPLAY_OPERATOR_ADAPTER ||
    request.pdfjsVersion !== PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION ||
    request.pdfjsBuild !== PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD ||
    request.renderIntent !== 'display' ||
    request.annotationMode !== 'enable' ||
    !/^[a-f0-9]{64}$/u.test(request.sourceTextLedgerSha256) ||
    ownedSourceBoxes.length === 0 ||
    ownedSourceBoxes.length > MAX_SOURCE_EXCLUSION_OWNED_BOXES ||
    ownedSourceBoxes.some((box) => !validOwnedSourceBox(sourceBox, box)) ||
    excludedSourceBoxes.length === 0 ||
    excludedSourceBoxes.length > MAX_SOURCE_EXCLUSION_BOXES ||
    excludedSourceBoxes.some((box) => !validPageSourceBox(sourceBox, box)) ||
    !ownedTextLedgerSpans ||
    !excludedTextLedgerSpans ||
    excludedTextLedgerSpans.some((excluded) =>
      ownedTextLedgerSpans.some(
        (owned) =>
          Math.min(excluded.end, owned.end) >
          Math.max(excluded.start, owned.start),
      ),
    )
  ) {
    throw new Error('PDF page crop text operation filter is invalid')
  }
  return {
    ...request,
    ownedSourceBoxes,
    excludedSourceBoxes,
    ownedTextLedgerSpans,
    excludedTextLedgerSpans,
  }
}

export function pdfTextOperationRunPaintEnvelopes({
  sourceBox,
  excludedSourceBoxes,
  width,
  height,
}: {
  sourceBox: NormalizedSourceBox
  excludedSourceBoxes: readonly NormalizedSourceBox[]
  width: number
  height: number
}) {
  const viewportWidth = width / sourceBox.width
  const viewportHeight = height / sourceBox.height
  return excludedSourceBoxes.map((box) => {
    const emPixels = box.height * viewportHeight
    const horizontalPadding = Math.max(2, emPixels * 0.15) / viewportWidth
    const verticalPadding = Math.max(2, emPixels * 0.35) / viewportHeight
    const left = Math.max(sourceBox.x, box.x - horizontalPadding)
    const top = Math.max(sourceBox.y, box.y - verticalPadding)
    const right = Math.min(
      sourceBox.x + sourceBox.width,
      box.x + box.width + horizontalPadding,
    )
    const bottom = Math.min(
      sourceBox.y + sourceBox.height,
      box.y + box.height + verticalPadding,
    )
    return {
      page: sourceBox.page,
      x: rounded(left),
      y: rounded(top),
      width: rounded(right - left),
      height: rounded(bottom - top),
      rotation: sourceBox.rotation,
      method: 'pdf-text' as const,
    }
  })
}

export async function renderPdfPageCrop({
  page,
  canvasFactory,
  sourceBox: inputSourceBox,
  ownedSourceBoxes: inputOwnedSourceBoxes,
  excludedSourceBoxes: inputExcludedSourceBoxes,
  sourceTextOperationFilter: inputSourceTextOperationFilter,
  signal,
  maximumPixels = MAX_PDF_PAGE_CROP_PIXELS,
  timeoutMs = PDF_PAGE_CROP_TIMEOUT_MS,
  tightenToSourceInk = false,
}: {
  page: PdfPageCropSource
  canvasFactory: PdfCanvasFactory
  sourceBox: NormalizedSourceBox
  ownedSourceBoxes?: readonly NormalizedSourceBox[]
  excludedSourceBoxes?: readonly NormalizedSourceBox[]
  sourceTextOperationFilter?: PdfTextOperationFilterRequest
  signal?: AbortSignal
  maximumPixels?: number
  timeoutMs?: number
  tightenToSourceInk?: boolean
}): Promise<PdfPageCropRaster> {
  const sourceBox = { ...inputSourceBox }
  validateSourceBox(page, sourceBox)
  if (
    inputSourceTextOperationFilter &&
    (inputOwnedSourceBoxes || inputExcludedSourceBoxes)
  ) {
    throw new Error(
      'PDF page crop cannot combine source-box masking with text operation filtering',
    )
  }
  const sourceTextOperationFilter = canonicalTextOperationFilter(
    sourceBox,
    inputSourceTextOperationFilter,
  )
  const { ownedSourceBoxes, excludedSourceBoxes } = canonicalMaskSourceBoxes({
    sourceBox,
    ownedSourceBoxes: sourceTextOperationFilter
      ? undefined
      : inputOwnedSourceBoxes,
    excludedSourceBoxes: sourceTextOperationFilter
      ? undefined
      : inputExcludedSourceBoxes,
  })
  if (
    (excludedSourceBoxes?.length || sourceTextOperationFilter) &&
    tightenToSourceInk
  ) {
    throw new Error(
      'PDF page crop cannot tighten source ink after excluding source boxes',
    )
  }
  if (signal?.aborted) throw abortError()
  if (!Number.isFinite(maximumPixels) || maximumPixels < 1) {
    throw new Error('PDF page crop maximumPixels must be positive')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error('PDF page crop timeoutMs must be positive')
  }

  const base = page.getViewport({ scale: 1 })
  const sourceWidth = Math.max(1, base.width * sourceBox.width)
  const sourceHeight = Math.max(1, base.height * sourceBox.height)
  const scale = Math.min(
    3,
    Math.sqrt(maximumPixels / (sourceWidth * sourceHeight)),
  )
  const viewport = page.getViewport({ scale })
  if (
    viewport.rotation !== undefined &&
    viewport.rotation !== sourceBox.rotation
  ) {
    throw new Error('PDF page crop rotation differs from its source region')
  }
  const width = Math.max(1, Math.ceil(viewport.width * sourceBox.width))
  const height = Math.max(1, Math.ceil(viewport.height * sourceBox.height))
  const renderPixels = async (
    operationsFilter?: (index: number) => boolean,
  ) => {
    const target = canvasFactory.create(width, height)
    target.context.fillStyle = '#fff'
    target.context.fillRect(0, 0, width, height)
    const renderTask = page.render({
      canvas: target.canvas,
      canvasContext: target.context,
      viewport,
      transform: [
        1,
        0,
        0,
        1,
        -sourceBox.x * viewport.width,
        -sourceBox.y * viewport.height,
      ],
      background: '#fff',
      ...(operationsFilter ? { operationsFilter } : {}),
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    let rejectAbort: ((error: Error) => void) | undefined
    const abort = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
    })
    const onAbort = () => {
      renderTask.cancel?.()
      rejectAbort?.(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await Promise.race([
        renderTask.promise,
        abort,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            renderTask.cancel?.()
            reject(new Error('PDF page crop rasterization timed out'))
          }, timeoutMs)
        }),
      ])
      if (signal?.aborted) throw abortError()
      const image = target.context.getImageData(0, 0, width, height)
      const pixels = new Uint8Array(image.data.byteLength)
      pixels.set(image.data)
      return pixels
    } catch (error) {
      void renderTask.promise.catch(() => undefined)
      throw error
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      canvasFactory.destroy(target)
    }
  }

  let resolvedTextOperationFilter:
    PdfResolvedTextOperationFilterRequest | undefined
  let baselinePixels: Uint8Array | undefined
  let excludedTextOperationIndexes: number[] | undefined
  let exactDisplayOperatorList:
    | NonNullable<ReturnType<typeof capturePinnedPdfjsDisplayOperatorList>>
    | undefined
  if (sourceTextOperationFilter) {
    if (
      sourceTextOperationFilter.displayOperatorAdapter !==
      PDFJS_DISPLAY_OPERATOR_ADAPTER
    ) {
      throw new Error('PDF display-stream adapter is not supported')
    }
    const proveCurrentDisplayOperatorList = () => {
      const operatorList = capturePinnedPdfjsDisplayOperatorList({
        page,
        pdfjsVersion: sourceTextOperationFilter.pdfjsVersion,
        pdfjsBuild: sourceTextOperationFilter.pdfjsBuild,
      })
      const proof = operatorList
        ? provePdfDisplayTextOperationFilter({
            operatorList,
            sourceTextLedgerSha256:
              sourceTextOperationFilter.sourceTextLedgerSha256,
            ownedTextLedgerSpans:
              sourceTextOperationFilter.ownedTextLedgerSpans,
            excludedTextLedgerSpans:
              sourceTextOperationFilter.excludedTextLedgerSpans,
            showTextOperation: PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.showText,
            textPaintOperations: new Set([
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.showText,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.showSpacedText,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.nextLineShowText,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.nextLineSetSpacingShowText,
            ]),
            textStateOperations: new Set([
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.save,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.restore,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.transform,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.setGState,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.beginText,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.endText,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.setCharSpacing,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.setWordSpacing,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.setHScale,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.setLeading,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.setFont,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.setTextRenderingMode,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.setTextRise,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.moveText,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.setLeadingMoveText,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.setTextMatrix,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.nextLine,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.showText,
            ]),
            setTextRenderingModeOperation:
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.setTextRenderingMode,
            textPositionResetOperations: new Set([
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.moveText,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.setLeadingMoveText,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.setTextMatrix,
              PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.nextLine,
            ]),
            beginTextOperation: PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.beginText,
            endTextOperation: PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.endText,
            saveOperation: PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.save,
            restoreOperation: PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.restore,
          })
        : null
      return { operatorList, proof }
    }
    // A completed DISPLAY list may already be present from a prior crop on
    // this page. Validate its bounded operation-index proof before spending
    // another raster pass. On first use, one baseline render is still needed
    // to materialize the exact private DISPLAY stream.
    let displayProof = proveCurrentDisplayOperatorList()
    if (displayProof.operatorList && !displayProof.proof) {
      throw new Error(
        'PDF display-stream text operation provenance is stale or unsafe',
      )
    }
    baselinePixels = await renderPixels()
    if (!displayProof.operatorList) {
      displayProof = proveCurrentDisplayOperatorList()
    }
    const { operatorList, proof } = displayProof
    if (!operatorList || !proof) {
      throw new Error(
        'PDF display-stream text operation provenance is stale or unsafe',
      )
    }
    resolvedTextOperationFilter = {
      ...sourceTextOperationFilter,
      displayTextLedgerSha256: proof.displayTextLedgerSha256,
      operatorLedgerSha256: proof.operatorLedgerSha256,
      ownedOperationIndexes: proof.ownedOperationIndexes,
      excludedOperationIndexes: proof.excludedOperationIndexes,
      ownedOnlyExcludedOperationIndexes:
        proof.ownedOnlyExcludedOperationIndexes,
    }
    exactDisplayOperatorList = operatorList
    excludedTextOperationIndexes =
      resolvedTextOperationFilter.excludedOperationIndexes
  }
  const filteredRenderAttestation =
    exactDisplayOperatorList && excludedTextOperationIndexes
      ? createPdfDisplayOperationsFilterAttestation({
          operatorList: exactDisplayOperatorList,
          excludedOperationIndexes: excludedTextOperationIndexes,
        })
      : null
  if (exactDisplayOperatorList && !filteredRenderAttestation) {
    throw new Error(
      'PDF display-stream operationsFilter callback cannot be attested',
    )
  }
  const pixels = await renderPixels(filteredRenderAttestation?.operationsFilter)
  if (
    filteredRenderAttestation &&
    !filteredRenderAttestation.hasCompleteExactCoverage()
  ) {
    throw new Error(
      'PDF display-stream operationsFilter callback did not cover the exact DISPLAY stream',
    )
  }
  let textOperationMask: PdfSourceExclusionMask | undefined
  if (
    sourceTextOperationFilter &&
    resolvedTextOperationFilter &&
    baselinePixels
  ) {
    const replayAttestation = createPdfDisplayOperationsFilterAttestation({
      operatorList: exactDisplayOperatorList!,
      excludedOperationIndexes: excludedTextOperationIndexes!,
    })
    if (!replayAttestation) {
      throw new Error(
        'PDF display-stream operationsFilter replay cannot be attested',
      )
    }
    if (
      replayAttestation.exactOperationStreamSha256 !==
      filteredRenderAttestation!.exactOperationStreamSha256
    ) {
      throw new Error(
        'PDF display-stream operationsFilter replay changed the exact DISPLAY stream',
      )
    }
    const replayPixels = await renderPixels(replayAttestation.operationsFilter)
    if (!replayAttestation.hasCompleteExactCoverage()) {
      throw new Error(
        'PDF display-stream operationsFilter replay did not cover the exact DISPLAY stream',
      )
    }
    if (
      replayPixels.length !== pixels.length ||
      replayPixels.some((value, index) => value !== pixels[index])
    ) {
      throw new Error(
        'PDF page crop text operation filter is not deterministic',
      )
    }
    const ownedOnlyAttestation = createPdfDisplayOperationsFilterAttestation({
      operatorList: exactDisplayOperatorList!,
      excludedOperationIndexes:
        resolvedTextOperationFilter.ownedOnlyExcludedOperationIndexes,
    })
    if (
      !ownedOnlyAttestation ||
      ownedOnlyAttestation.exactOperationStreamSha256 !==
        filteredRenderAttestation!.exactOperationStreamSha256
    ) {
      throw new Error(
        'PDF display-stream owned-only negative control cannot be attested',
      )
    }
    const ownedOnlyPixels = await renderPixels(
      ownedOnlyAttestation.operationsFilter,
    )
    if (!ownedOnlyAttestation.hasCompleteExactCoverage()) {
      throw new Error(
        'PDF display-stream owned-only negative control did not cover the exact DISPLAY stream',
      )
    }
    if (
      ownedOnlyPixels.length !== pixels.length ||
      ownedOnlyPixels.some((value, index) => value !== pixels[index])
    ) {
      throw new Error(
        'PDF page crop contains unowned DISPLAY text paint outside the selected exclusion filter',
      )
    }
    const excludedRunPaintEnvelopes = pdfTextOperationRunPaintEnvelopes({
      sourceBox,
      excludedSourceBoxes: resolvedTextOperationFilter.excludedSourceBoxes,
      width,
      height,
    })
    const excludedPixelBoxes = excludedRunPaintEnvelopes.map((box) =>
      pixelBox(box, sourceBox, viewport.width, viewport.height),
    )
    let changedPixelCount = 0
    let left = width
    let top = height
    let right = 0
    let bottom = 0
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4
        if (
          baselinePixels[offset] === pixels[offset] &&
          baselinePixels[offset + 1] === pixels[offset + 1] &&
          baselinePixels[offset + 2] === pixels[offset + 2] &&
          baselinePixels[offset + 3] === pixels[offset + 3]
        ) {
          continue
        }
        if (
          !excludedPixelBoxes.some(
            (box) =>
              x + 1 >= box.left &&
              x <= box.right &&
              y + 1 >= box.top &&
              y <= box.bottom,
          )
        ) {
          throw new Error(
            'PDF page crop text operation filter changed pixels outside excluded source bounds',
          )
        }
        changedPixelCount += 1
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x + 1)
        bottom = Math.max(bottom, y + 1)
      }
    }
    if (changedPixelCount === 0) {
      throw new Error(
        'PDF page crop text operation filter did not change source pixels',
      )
    }
    const normalizedDiffLeft = Math.max(
      sourceBox.x,
      sourceBox.x + left / viewport.width,
    )
    const normalizedDiffTop = Math.max(
      sourceBox.y,
      sourceBox.y + top / viewport.height,
    )
    const normalizedDiffRight = Math.min(
      sourceBox.x + sourceBox.width,
      sourceBox.x + right / viewport.width,
    )
    const normalizedDiffBottom = Math.min(
      sourceBox.y + sourceBox.height,
      sourceBox.y + bottom / viewport.height,
    )
    const canonicalDiffLeft = rounded(normalizedDiffLeft)
    const canonicalDiffTop = rounded(normalizedDiffTop)
    const canonicalDiffRight = rounded(normalizedDiffRight)
    const canonicalDiffBottom = rounded(normalizedDiffBottom)
    textOperationMask = {
      ...resolvedTextOperationFilter,
      ownedTextLedgerSpans:
        resolvedTextOperationFilter.ownedTextLedgerSpans.map((span) => ({
          ...span,
        })),
      excludedTextLedgerSpans:
        resolvedTextOperationFilter.excludedTextLedgerSpans.map((span) => ({
          ...span,
        })),
      ownedSourceBoxes: resolvedTextOperationFilter.ownedSourceBoxes.map(
        (box) => ({ ...box }),
      ),
      excludedSourceBoxes: resolvedTextOperationFilter.excludedSourceBoxes.map(
        (box) => ({
          ...box,
        }),
      ),
      baselineRgbaSha256: sha256HexSync(baselinePixels),
      filteredRgbaSha256: sha256HexSync(pixels),
      ownedOnlyRgbaSha256: sha256HexSync(ownedOnlyPixels),
      changedPixelCount,
      normalizedDiffBox: {
        page: sourceBox.page,
        x: canonicalDiffLeft,
        y: canonicalDiffTop,
        width: boundedRoundedExtent(canonicalDiffLeft, canonicalDiffRight),
        height: boundedRoundedExtent(canonicalDiffTop, canonicalDiffBottom),
        rotation: sourceBox.rotation,
        method: 'pdf-text',
      },
      excludedRunPaintEnvelopes,
    }
  }

  const changedPixels =
    excludedSourceBoxes?.length && ownedSourceBoxes?.length
      ? maskExcludedEdgeComponents({
          pixels,
          width,
          height,
          sourceBox,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          ownedSourceBoxes,
          excludedSourceBoxes,
        })
      : 0
  if (hasSourceInkOnCropEdge(pixels, width, height)) {
    throw new Error('PDF page crop has source ink touching its edge')
  }
  const raster = tightenToSourceInk
    ? tightenRasterToSourceInk(pixels, width, height, sourceBox)
    : {
        width,
        height,
        pixels,
        sourceBox,
        ...(changedPixels > 0
          ? {
              sourceExclusionMask: {
                algorithm: 'nearest-source-box-v1',
                expansionPixels: SOURCE_EXCLUSION_EXPANSION_PIXELS,
                ownedSourceBoxes: ownedSourceBoxes!.map((box) => ({
                  ...box,
                })),
                excludedSourceBoxes: excludedSourceBoxes!.map((box) => ({
                  ...box,
                })),
              } satisfies PdfSourceExclusionMask,
            }
          : textOperationMask
            ? { sourceExclusionMask: textOperationMask }
            : {}),
      }
  const result = {
    ...raster,
    resolutionDpi: 72 * scale,
  }
  if (textOperationMask) {
    trustedTextOperationFilterRasters.set(
      result,
      textOperationFilterRasterFingerprint(result),
    )
  }
  return result
}

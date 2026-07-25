import type {
  NormalizedSourceBox,
  PdfSourceExclusionMask,
} from './import-types'

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
  }): { promise: Promise<unknown>; cancel?: () => void }
}

export type PdfPageCropRaster = {
  width: number
  height: number
  pixels: Uint8Array
  sourceBox: NormalizedSourceBox
  sourceExclusionMask?: PdfSourceExclusionMask
}

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
): PdfPageCropRaster {
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

export async function renderPdfPageCrop({
  page,
  canvasFactory,
  sourceBox,
  ownedSourceBoxes: inputOwnedSourceBoxes,
  excludedSourceBoxes: inputExcludedSourceBoxes,
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
  signal?: AbortSignal
  maximumPixels?: number
  timeoutMs?: number
  tightenToSourceInk?: boolean
}): Promise<PdfPageCropRaster> {
  validateSourceBox(page, sourceBox)
  const { ownedSourceBoxes, excludedSourceBoxes } = canonicalMaskSourceBoxes({
    sourceBox,
    ownedSourceBoxes: inputOwnedSourceBoxes,
    excludedSourceBoxes: inputExcludedSourceBoxes,
  })
  if (excludedSourceBoxes?.length && tightenToSourceInk) {
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
  })
  const cancelRender = () => renderTask.cancel?.()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let rejectAbort: ((error: Error) => void) | undefined
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => {
    cancelRender()
    rejectAbort?.(abortError())
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    await Promise.race([
      renderTask.promise,
      abort,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          cancelRender()
          reject(new Error('PDF page crop rasterization timed out'))
        }, timeoutMs)
      }),
    ])
    if (signal?.aborted) throw abortError()
    const image = target.context.getImageData(0, 0, width, height)
    const pixels = new Uint8Array(image.data.byteLength)
    pixels.set(image.data)
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
    return tightenToSourceInk
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
            : {}),
        }
  } catch (error) {
    // `cancel()` is advisory in PDF.js and custom browser renderers. Some
    // implementations never settle their render promise after cancellation,
    // so cleanup must not wait on it. Promise.race already observes later
    // rejection; this catch also documents that late failures are consumed.
    void renderTask.promise.catch(() => undefined)
    throw error
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
    canvasFactory.destroy(target)
  }
}

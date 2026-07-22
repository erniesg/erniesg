import type { NormalizedSourceBox } from './import-types'

export const MAX_PDF_PAGE_CROP_PIXELS = 3_200_000
export const PDF_PAGE_CROP_TIMEOUT_MS = 15_000
export const MAX_SOURCE_PAGE_CROP_AREA = 0.72
const SOURCE_INK_PADDING = 0.004

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

export async function renderPdfPageCrop({
  page,
  canvasFactory,
  sourceBox,
  signal,
  maximumPixels = MAX_PDF_PAGE_CROP_PIXELS,
  timeoutMs = PDF_PAGE_CROP_TIMEOUT_MS,
  tightenToSourceInk = false,
}: {
  page: PdfPageCropSource
  canvasFactory: PdfCanvasFactory
  sourceBox: NormalizedSourceBox
  signal?: AbortSignal
  maximumPixels?: number
  timeoutMs?: number
  tightenToSourceInk?: boolean
}): Promise<PdfPageCropRaster> {
  validateSourceBox(page, sourceBox)
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
    if (hasSourceInkOnCropEdge(pixels, width, height)) {
      throw new Error('PDF page crop has source ink touching its edge')
    }
    return tightenToSourceInk
      ? tightenRasterToSourceInk(pixels, width, height, sourceBox)
      : { width, height, pixels, sourceBox }
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

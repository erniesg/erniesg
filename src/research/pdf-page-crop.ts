import type { NormalizedSourceBox } from './import-types'

export const MAX_PDF_PAGE_CROP_PIXELS = 3_200_000
export const PDF_PAGE_CROP_TIMEOUT_MS = 15_000
export const MAX_SOURCE_PAGE_CROP_AREA = 0.72

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
}: {
  page: PdfPageCropSource
  canvasFactory: PdfCanvasFactory
  sourceBox: NormalizedSourceBox
  signal?: AbortSignal
  maximumPixels?: number
  timeoutMs?: number
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
    return { width, height, pixels }
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

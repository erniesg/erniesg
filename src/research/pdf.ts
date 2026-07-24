import type {
  NormalizedSourceBox,
  PdfImportProgress,
  PdfNativeObject,
  PdfPageAnalysis,
  PdfSourceRun,
} from './import-types'
import { MAX_LOCAL_PDF_BYTES, PdfImportError } from './import-types'
import { reconstructPageAnalyses, type PdfDocumentMetadata } from './pdf-layout'
import {
  classifyPdfPage,
  detectPhysicalSpread,
  mergeOcrPage,
  type PdfOcrOptions,
  type PdfOcrRaster,
  type PdfOcrSession,
} from './pdf-ocr'
import {
  createPngAsset,
  createSourcePageCropAsset,
  createVectorSvgAsset,
} from './visual-assets'
import {
  normalizePdfFontText,
  pdfOperatorListDependencyIds,
  resolvePdfFontMetadata,
} from './pdf-font-text'
import {
  renderPdfPageCrop,
  type PdfCanvasFactory,
  type PdfPageCropSource,
} from './pdf-page-crop'
import {
  applyHumanDecisionFile,
  type HumanDecisionFile,
} from './decision-record'
import {
  extractPdfLinkAnnotations,
  resolvePdfNamedDestinationEvidence,
} from './pdf-links'

export { extractPdfLinkAnnotations } from './pdf-links'

type PdfImportOptions = {
  signal?: AbortSignal
  standardFontDataUrl?: string
  ocr?: PdfOcrOptions
  decisionFile?: HumanDecisionFile
}

export const MAX_OCR_RASTER_PIXELS = 3_200_000
const COMPOSITE_RASTER_TIMEOUT_MS = 15_000

function cancelledError() {
  return new PdfImportError(
    'IMPORT_CANCELLED',
    'The local PDF reconstruction was cancelled and its working data was released.',
  )
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelledError()
}

function isPdf(bytes: Uint8Array) {
  const prefix = new TextDecoder('latin1').decode(bytes.subarray(0, 1024))
  return prefix.includes('%PDF-')
}

async function sha256(bytes: Uint8Array) {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, finite(value)))
}

function roundedSourceCoordinate(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function sourceLineageWithinCrop(
  sourceObjectIds: string[],
  sourceBoxes: NormalizedSourceBox[],
  sourceCropBox: NormalizedSourceBox,
) {
  const lineage = sourceObjectIds.flatMap((sourceObjectId, index) => {
    const sourceBox = sourceBoxes[index]
    if (
      !sourceBox ||
      sourceBox.page !== sourceCropBox.page ||
      sourceBox.rotation !== sourceCropBox.rotation
    ) {
      return []
    }
    const left = Math.max(sourceCropBox.x, sourceBox.x)
    const top = Math.max(sourceCropBox.y, sourceBox.y)
    const right = Math.min(
      sourceCropBox.x + sourceCropBox.width,
      sourceBox.x + sourceBox.width,
    )
    const bottom = Math.min(
      sourceCropBox.y + sourceCropBox.height,
      sourceBox.y + sourceBox.height,
    )
    if (right <= left || bottom <= top) return []
    return [
      {
        sourceObjectId,
        sourceBox: {
          ...sourceBox,
          x: roundedSourceCoordinate(left),
          y: roundedSourceCoordinate(top),
          width: roundedSourceCoordinate(right - left),
          height: roundedSourceCoordinate(bottom - top),
        },
      },
    ]
  })
  return {
    sourceObjectIds: lineage.map((item) => item.sourceObjectId),
    sourceBoxes: lineage.map((item) => item.sourceBox),
  }
}

export function isFlowAlignedPdfTextTransform(transform: readonly number[]) {
  // The x-axis of a horizontal glyph run is predominantly horizontal. A
  // vertical marginal stamp instead has a predominantly vertical x-axis and
  // must not be allowed to bridge body columns during line reconstruction.
  return Math.abs(transform[0] ?? 0) >= Math.abs(transform[1] ?? 0)
}

export function isPdfLocalPathArtifact(
  text: string,
  fontHeight: number,
  viewportHeight: number,
) {
  const value = text.trim()
  if (
    (value.includes('/') &&
      /(?:^|[/\\])(?:users?|downloads?|documents?|desktop|library)(?:[/\\]|$)/iu.test(
        value,
      )) ||
    (value.includes('\\') &&
      /(?:^|[/\\])(?:users?|downloads?|documents?|desktop|library)(?:[/\\]|$)/iu.test(
        value,
      )) ||
    /[/\\][^/\\\s]+\.html?$/iu.test(value)
  ) {
    return true
  }
  // Broken PDF exports sometimes split a local `file:///…` overlay into
  // tiny `fi` and `1/1` runs around its path fragments. Those runs have no
  // standalone prose meaning; retain genuine normal-size text instead.
  return fontHeight <= viewportHeight * 0.008 && /^(?:fi|1\/1)$/iu.test(value)
}

export function isPdfMicroscopicTextArtifact(
  fontHeight: number,
  viewportHeight: number,
) {
  // PDF authoring tools can place private source or accessibility payloads in
  // effectively zero-size text runs. Keep the cutoff far below a visible
  // glyph so ordinary small print and normal-size invisible OCR layers remain.
  return (
    Number.isFinite(fontHeight) &&
    Number.isFinite(viewportHeight) &&
    fontHeight >= 0 &&
    viewportHeight > 0 &&
    fontHeight <= viewportHeight / 1_000_000
  )
}

export function resolvePdfTextFontHeight(
  transform: readonly number[],
  itemHeight: number,
  viewportHeight: number,
) {
  const measuredHeight =
    Math.hypot(transform[2], transform[3]) || Math.abs(itemHeight)
  if (isPdfMicroscopicTextArtifact(measuredHeight, viewportHeight)) return null
  return measuredHeight || 1
}

type RasterizablePage = {
  getViewport(options: { scale: number }): {
    width: number
    height: number
  }
  render(options: {
    canvas: HTMLCanvasElement
    canvasContext: CanvasRenderingContext2D
    viewport: { width: number; height: number }
    transform?: number[]
  }): { promise: Promise<unknown>; cancel?: () => void }
}

async function renderPageRaster(
  page: RasterizablePage,
  signal?: AbortSignal,
): Promise<PdfOcrRaster> {
  throwIfAborted(signal)
  if (typeof document === 'undefined') {
    throw new PdfImportError(
      'OCR_REQUIRED',
      'Local OCR needs a browser rasterizer; no document bytes were uploaded.',
    )
  }
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(
    3,
    Math.sqrt(
      MAX_OCR_RASTER_PIXELS /
        Math.max(1, Math.ceil(base.width) * Math.ceil(base.height)),
    ),
  )
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) {
    throw new PdfImportError(
      'OCR_REQUIRED',
      'The browser could not create a bounded local OCR raster.',
    )
  }
  const renderTask = page.render({
    canvas,
    canvasContext: context,
    viewport,
  })
  const cancelRender = () => renderTask.cancel?.()
  signal?.addEventListener('abort', cancelRender, { once: true })
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      renderTask.promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          cancelRender()
          reject(new Error('Composite figure rasterization timed out'))
        }, COMPOSITE_RASTER_TIMEOUT_MS)
      }),
    ])
    throwIfAborted(signal)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) =>
          value
            ? resolve(value)
            : reject(new Error('The browser returned an empty OCR raster.')),
        'image/png',
      )
    })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    throwIfAborted(signal)
    return {
      bytes,
      mediaType: 'image/png',
      width: canvas.width,
      height: canvas.height,
      sha256: await sha256(bytes),
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    signal?.removeEventListener('abort', cancelRender)
    canvas.width = 0
    canvas.height = 0
  }
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
) {
  if (!signal) return operation
  if (signal.aborted) {
    onAbort()
    throw cancelledError()
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort()
      reject(cancelledError())
    }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort)
    })
  })
}

function countImages(fnArray: number[], imageOps: Set<number>) {
  return fnArray.filter((operator) => imageOps.has(operator)).length
}

type Matrix = [number, number, number, number, number, number]

function matrix(value: unknown): Matrix | null {
  if (
    !Array.isArray(value) ||
    value.length < 6 ||
    !value.slice(0, 6).every((item) => typeof item === 'number')
  ) {
    return null
  }
  return value.slice(0, 6) as Matrix
}

function multiply(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

function point(transform: Matrix, x: number, y: number) {
  return {
    x: transform[0] * x + transform[2] * y + transform[4],
    y: transform[1] * x + transform[3] * y + transform[5],
  }
}

type NativeObjectDraft = {
  object: PdfNativeObject
  source?: unknown
  vector?: {
    path: string
    viewBox: { x: number; y: number; width: number; height: number }
    paint: 'fill' | 'stroke' | 'fill-stroke'
  }
}

function vectorPath(value: unknown, minMax: number[]) {
  if (!ArrayBuffer.isView(value)) return null
  const values = Array.from(value as unknown as ArrayLike<number>)
  const commands: string[] = []
  const flipY = (y: number) => minMax[1] + minMax[3] - y
  for (let index = 0; index < values.length;) {
    const operation = values[index++]
    const take = (count: number) => {
      const result = values.slice(index, index + count)
      index += count
      return result
    }
    if (operation === 0 || operation === 1) {
      const [x, y] = take(2)
      commands.push(
        `${operation === 0 ? 'M' : 'L'} ${rounded(x)} ${rounded(flipY(y))}`,
      )
    } else if (operation === 2) {
      const [x1, y1, x2, y2, x, y] = take(6)
      commands.push(
        `C ${rounded(x1)} ${rounded(flipY(y1))} ${rounded(x2)} ${rounded(flipY(y2))} ${rounded(x)} ${rounded(flipY(y))}`,
      )
    } else if (operation === 3) {
      const [x1, y1, x, y] = take(4)
      commands.push(
        `Q ${rounded(x1)} ${rounded(flipY(y1))} ${rounded(x)} ${rounded(flipY(y))}`,
      )
    } else if (operation === 4) {
      commands.push('Z')
    } else {
      return null
    }
  }
  return commands.length > 0 ? commands.join(' ') : null
}

function rounded(value: number) {
  return Math.round(value * 1000) / 1000
}

function extractNativeObjects({
  page,
  rotation,
  viewportWidth,
  viewportHeight,
  viewportTransform,
  fnArray,
  argsArray,
  imageOps,
  saveOp,
  restoreOp,
  transformOp,
  constructPathOp,
}: {
  page: number
  rotation: number
  viewportWidth: number
  viewportHeight: number
  viewportTransform: Matrix
  fnArray: number[]
  argsArray: unknown[]
  imageOps: Set<number>
  saveOp: number
  restoreOp: number
  transformOp: number
  constructPathOp: number
}) {
  let current: Matrix = [1, 0, 0, 1, 0, 0]
  const stack: Matrix[] = []
  const objects: NativeObjectDraft[] = []
  let imageNumber = 0
  let vectorNumber = 0
  for (const [index, operator] of fnArray.entries()) {
    if (operator === saveOp) {
      stack.push([...current])
      continue
    }
    if (operator === restoreOp) {
      current = stack.pop() ?? [1, 0, 0, 1, 0, 0]
      continue
    }
    if (operator === transformOp) {
      const next = matrix(argsArray[index])
      if (next) current = multiply(current, next)
      continue
    }
    const pathArgs =
      operator === constructPathOp && Array.isArray(argsArray[index])
        ? argsArray[index]
        : null
    const pathBounds =
      pathArgs && ArrayBuffer.isView(pathArgs[2])
        ? Array.from(pathArgs[2] as unknown as ArrayLike<number>)
        : null
    const paint =
      pathArgs && [20, 21].includes(pathArgs[0] as number)
        ? ('stroke' as const)
        : pathArgs && [22, 23].includes(pathArgs[0] as number)
          ? ('fill' as const)
          : pathArgs && [24, 25, 26, 27].includes(pathArgs[0] as number)
            ? ('fill-stroke' as const)
            : null
    const vector =
      pathArgs &&
      pathBounds?.length === 4 &&
      pathBounds.every(Number.isFinite) &&
      pathBounds[2] > pathBounds[0] &&
      pathBounds[3] > pathBounds[1] &&
      paint
        ? vectorPath(
            Array.isArray(pathArgs[1]) ? pathArgs[1][0] : null,
            pathBounds,
          )
        : null
    if (!imageOps.has(operator) && !vector) continue
    const localBounds = vector ? pathBounds! : [0, 0, 1, 1]
    const device = multiply(viewportTransform, current)
    const corners = [
      point(device, localBounds[0], localBounds[1]),
      point(device, localBounds[2], localBounds[1]),
      point(device, localBounds[0], localBounds[3]),
      point(device, localBounds[2], localBounds[3]),
    ]
    const left = Math.min(...corners.map((corner) => corner.x))
    const right = Math.max(...corners.map((corner) => corner.x))
    const top = Math.min(...corners.map((corner) => corner.y))
    const bottom = Math.max(...corners.map((corner) => corner.y))
    const x = clamp(left / viewportWidth)
    const y = clamp(top / viewportHeight)
    const width = clamp(right / viewportWidth) - x
    const height = clamp(bottom / viewportHeight) - y
    if (width <= 0 || height <= 0) continue
    const kind = vector ? ('vector' as const) : ('image' as const)
    const number = vector ? ++vectorNumber : ++imageNumber
    const id = `${kind}-p${String(page).padStart(3, '0')}-${String(number).padStart(3, '0')}`
    objects.push({
      object: {
        id,
        page,
        kind,
        box: {
          page,
          x,
          y,
          width,
          height,
          rotation,
          method: 'pdf-object',
        },
        confidence: 0.98,
        assetId: null,
      },
      ...(vector
        ? {
            vector: {
              path: vector,
              viewBox: {
                x: pathBounds![0],
                y: pathBounds![1],
                width: pathBounds![2] - pathBounds![0],
                height: pathBounds![3] - pathBounds![1],
              },
              paint: paint!,
            },
          }
        : {
            source: Array.isArray(argsArray[index])
              ? argsArray[index][0]
              : null,
          }),
    })
  }
  return objects
}

const MAX_DECODED_IMAGE_PIXELS = 16_777_216
const MAX_ASYNC_IMAGE_SOURCES_PER_PAGE = 64
const IMAGE_DECODE_TIMEOUT_MS = 10_000

function bitmapPixelData(
  bitmap: CanvasImageSource,
  width: number,
  height: number,
) {
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : typeof document !== 'undefined'
        ? Object.assign(document.createElement('canvas'), { width, height })
        : null
  const context = canvas?.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(bitmap, 0, 0, width, height)
  const data = context.getImageData(0, 0, width, height).data
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

function pixelData(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const image = value as {
    width?: unknown
    height?: unknown
    kind?: unknown
    data?: unknown
    bitmap?: unknown
  }
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height)) {
    return null
  }
  const width = image.width as number
  const height = image.height as number
  if (width < 1 || height < 1 || width * height > MAX_DECODED_IMAGE_PIXELS) {
    return null
  }
  const pixels = ArrayBuffer.isView(image.data)
    ? new Uint8Array(
        image.data.buffer,
        image.data.byteOffset,
        image.data.byteLength,
      )
    : image.bitmap && typeof image.bitmap === 'object'
      ? bitmapPixelData(image.bitmap as CanvasImageSource, width, height)
      : null
  if (!pixels) return null
  const colorSpace = !ArrayBuffer.isView(image.data)
    ? ('rgba' as const)
    : image.kind === 1
      ? ('grayscale-1bpp' as const)
      : image.kind === 2 || pixels.length === width * height * 3
        ? ('rgb' as const)
        : image.kind === 3 || pixels.length === width * height * 4
          ? ('rgba' as const)
          : null
  return colorSpace ? { width, height, pixels, colorSpace } : null
}

export async function resolveNativeObjects(
  page: {
    objs: {
      get(id: string, callback?: (value: unknown) => void): unknown
      has?(id: string): boolean
    }
  },
  drafts: NativeObjectDraft[],
  signal?: AbortSignal,
  decodeTimeoutMs = IMAGE_DECODE_TIMEOUT_MS,
) {
  throwIfAborted(signal)
  const assets = new Map<
    string,
    Awaited<ReturnType<typeof createPngAsset | typeof createVectorSvgAsset>>
  >()
  const store = (
    visualAsset: Awaited<
      ReturnType<typeof createPngAsset | typeof createVectorSvgAsset>
    >,
  ) => {
    const current = assets.get(visualAsset.id)
    if (!current) {
      assets.set(visualAsset.id, visualAsset)
      return
    }
    for (const [
      index,
      sourceObjectId,
    ] of visualAsset.sourceObjectIds.entries()) {
      if (current.sourceObjectIds.includes(sourceObjectId)) continue
      current.sourceObjectIds.push(sourceObjectId)
      current.sourceBoxes.push({ ...visualAsset.sourceBoxes[index] })
    }
  }
  const resolvedSources = new Map<string, Promise<unknown>>()
  const asyncSourceCount = new Set(
    drafts.flatMap((draft) =>
      typeof draft.source === 'string' ? [draft.source] : [],
    ),
  ).size
  for (const draft of drafts) {
    if (typeof draft.source !== 'string' || resolvedSources.has(draft.source)) {
      continue
    }
    const source = draft.source
    if (asyncSourceCount > MAX_ASYNC_IMAGE_SOURCES_PER_PAGE) {
      // Dense image mosaics do not form a bounded standalone rendition and
      // waiting on their callback order made coverage cache- and load-sensitive.
      resolvedSources.set(source, Promise.resolve(null))
      continue
    }
    resolvedSources.set(
      source,
      new Promise<unknown>((resolve) => {
        let settled = false
        let timeout: ReturnType<typeof setTimeout> | undefined
        const finish = (value: unknown) => {
          if (settled) return
          settled = true
          if (timeout !== undefined) clearTimeout(timeout)
          signal?.removeEventListener('abort', abort)
          resolve(value)
        }
        const abort = () => finish(null)
        if (signal?.aborted) {
          finish(null)
          return
        }
        signal?.addEventListener('abort', abort, { once: true })
        // Bounded operator-list dependencies resolve concurrently so callback
        // order does not decide which payloads survive. A source that does not
        // settle within the page budget remains unresolved.
        timeout = setTimeout(() => finish(null), decodeTimeoutMs)
        try {
          if (page.objs.has?.(source)) finish(page.objs.get(source))
          else page.objs.get(source, finish)
        } catch {
          finish(null)
        }
      }),
    )
  }
  const resolvedEntries = await Promise.all(
    [...resolvedSources].map(
      async ([source, value]) => [source, await value] as const,
    ),
  )
  const incompleteAsyncPage = resolvedEntries.some(([, value]) => !value)
  const resolvedValues = new Map(
    resolvedEntries.map(([source, value]) => [
      source,
      incompleteAsyncPage ? null : value,
    ]),
  )
  for (const draft of drafts) {
    throwIfAborted(signal)
    if (draft.vector) {
      const visualAsset = await createVectorSvgAsset({
        sourceObjectId: draft.object.id,
        sourceBox: draft.object.box,
        ...draft.vector,
      })
      draft.object.assetId = visualAsset.id
      store(visualAsset)
      continue
    }
    let decoded: unknown = draft.source
    try {
      if (typeof draft.source === 'string') {
        decoded = resolvedValues.get(draft.source)
      }
    } catch {
      decoded = null
    }
    const image = pixelData(decoded)
    if (!image) continue
    const visualAsset = await createPngAsset({
      sourceObjectId: draft.object.id,
      sourceBox: draft.object.box,
      ...image,
    })
    draft.object.assetId = visualAsset.id
    store(visualAsset)
  }
  throwIfAborted(signal)
  return {
    objects: drafts.map((draft) => draft.object),
    assets: [...assets.values()],
  }
}

function metadataValue(info: Record<string, unknown>, key: string) {
  const value = info[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function normalizedPdfDate(value?: string) {
  if (!value) return undefined
  const compact = value.match(/^D:(\d{4})(\d{2})(\d{2})/)
  if (compact) {
    const parsed = new Date(
      `${compact[1]}-${compact[2]}-${compact[3]}T00:00:00.000Z`,
    )
    return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString()
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString()
}

let browserPdfRuntimePromise: Promise<typeof import('pdfjs-dist')> | undefined

async function loadBrowserPdfRuntime() {
  browserPdfRuntimePromise ??= (async () => {
    const pdfjs = await import('pdfjs-dist')
    const { default: pdfWorkerUrl } =
      await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
    return pdfjs
  })()
  try {
    return await browserPdfRuntimePromise
  } catch (error) {
    browserPdfRuntimePromise = undefined
    throw error
  }
}

export async function warmBrowserPdfRuntime() {
  if (typeof window === 'undefined') return
  await loadBrowserPdfRuntime()
}

export async function reconstructPdf(
  file: File,
  onProgress?: (progress: PdfImportProgress) => void,
  options: PdfImportOptions = {},
) {
  throwIfAborted(options.signal)
  if (file.size > MAX_LOCAL_PDF_BYTES) {
    throw new PdfImportError(
      'OVERSIZED_PDF',
      `PDF resource limit exceeded: received ${file.size} bytes; the bounded local limit is ${MAX_LOCAL_PDF_BYTES} bytes. No document bytes were read.`,
    )
  }

  onProgress?.({
    phase: 'opening',
    completed: 0,
    total: 1,
    message: 'Reading the PDF locally…',
  })
  const bytes = new Uint8Array(await file.arrayBuffer())
  throwIfAborted(options.signal)
  if (!isPdf(bytes)) {
    throw new PdfImportError('INVALID_PDF', 'The selected file is not a PDF.')
  }

  const sourceHash = await sha256(bytes)
  const pdfjs =
    typeof window === 'undefined'
      ? await import('pdfjs-dist/legacy/build/pdf.mjs')
      : await loadBrowserPdfRuntime()
  throwIfAborted(options.signal)
  const loadingTask = pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    useSystemFonts: true,
    ...(options.standardFontDataUrl
      ? { standardFontDataUrl: options.standardFontDataUrl }
      : {}),
  })

  let passwordReject: ((error: PdfImportError) => void) | undefined
  const passwordRequired = new Promise<never>((_resolve, reject) => {
    passwordReject = reject
  })
  loadingTask.onPassword = () => {
    passwordReject?.(
      new PdfImportError(
        'ENCRYPTED_PDF',
        'Password-protected PDFs are not opened or uploaded by this studio.',
      ),
    )
    void loadingTask.destroy()
  }
  let cancelReject: ((error: PdfImportError) => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancelReject = reject
  })
  const cancelLoading = () => {
    cancelReject?.(cancelledError())
    void loadingTask.destroy()
  }
  options.signal?.addEventListener('abort', cancelLoading, { once: true })

  let document: Awaited<typeof loadingTask.promise>
  try {
    document = await Promise.race([
      loadingTask.promise,
      passwordRequired,
      cancelled,
    ])
  } catch (error) {
    options.signal?.removeEventListener('abort', cancelLoading)
    await loadingTask.destroy().catch(() => undefined)
    if (error instanceof PdfImportError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (/password/i.test(message)) {
      throw new PdfImportError('ENCRYPTED_PDF', message)
    }
    throw new PdfImportError(
      'PDF_PARSE_FAILED',
      `PDF.js could not open this document: ${message}`,
    )
  }

  if (document.numPages < 1) {
    await document.destroy()
    throw new PdfImportError('EMPTY_PDF', 'The PDF has no pages.')
  }

  const imageOps = new Set([
    pdfjs.OPS.paintImageMaskXObject,
    pdfjs.OPS.paintImageMaskXObjectGroup,
    pdfjs.OPS.paintImageXObject,
    pdfjs.OPS.paintInlineImageXObject,
    pdfjs.OPS.paintInlineImageXObjectGroup,
    pdfjs.OPS.paintImageXObjectRepeat,
    pdfjs.OPS.paintImageMaskXObjectRepeat,
  ])
  const pages: PdfPageAnalysis[] = []
  const namedDestinationEvidenceCache = new Map<
    string,
    ReturnType<typeof resolvePdfNamedDestinationEvidence>
  >()
  const namedDestinationEvidence = (destination: string) => {
    const cached = namedDestinationEvidenceCache.get(destination)
    if (cached) return cached
    const pending = resolvePdfNamedDestinationEvidence({
      destination,
      document: document as Parameters<
        typeof resolvePdfNamedDestinationEvidence
      >[0]['document'],
    })
    namedDestinationEvidenceCache.set(destination, pending)
    return pending
  }
  let ocrSession: PdfOcrSession | undefined
  let ocrTermination: Promise<void> | undefined
  let activeOcrPage = 0
  const terminateOcrSession = () => {
    if (!ocrSession) return Promise.resolve()
    if (ocrTermination) return ocrTermination
    ocrTermination = ocrSession.terminate().catch(() => undefined)
    return ocrTermination
  }

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      throwIfAborted(options.signal)
      onProgress?.({
        phase: 'extracting',
        completed: pageNumber - 1,
        total: document.numPages,
        message: `Reading page ${pageNumber} of ${document.numPages}…`,
      })
      const page = await document.getPage(pageNumber)
      try {
        const viewport = page.getViewport({ scale: 1 })
        const [textContent, operatorList, annotations] = await Promise.all([
          page.getTextContent(),
          page.getOperatorList(),
          page.getAnnotations({ intent: 'display' }),
        ])
        throwIfAborted(options.signal)
        const fontMetadata = await resolvePdfFontMetadata({
          commonObjects: page.commonObjs,
          fontIds: textContent.items.flatMap((item) =>
            'str' in item ? [item.fontName] : [],
          ),
          dependencyIds: pdfOperatorListDependencyIds({
            fnArray: operatorList.fnArray,
            argsArray: operatorList.argsArray,
            dependencyOp: pdfjs.OPS.dependency,
          }),
          signal: options.signal,
        })
        throwIfAborted(options.signal)
        const runs: PdfSourceRun[] = []

        for (const item of textContent.items) {
          if (!('str' in item)) continue
          const font = fontMetadata.get(item.fontName)
          const sourceFontName = font?.name ?? item.fontName
          const sourceText = normalizePdfFontText(item.str, sourceFontName)
          if (!sourceText.trim()) continue
          const transform = pdfjs.Util.transform(
            viewport.transform,
            item.transform,
          )
          // PDF.js reports a 90°-rotated marginal stamp as one enormous
          // horizontal bounding box. If it enters line grouping it bridges
          // otherwise separate columns and turns real prose into a discarded
          // `side` region. Rotated source text remains visible in any bounded
          // page crop, but it is not safe canonical reading-order prose.
          if (!isFlowAlignedPdfTextTransform(transform)) continue
          const fontHeight = resolvePdfTextFontHeight(
            transform,
            item.height,
            viewport.height,
          )
          if (
            fontHeight === null ||
            isPdfLocalPathArtifact(sourceText, fontHeight, viewport.height)
          ) {
            continue
          }
          const x = finite(transform[4])
          const y = finite(transform[5] - fontHeight)
          const width = Math.max(Math.abs(item.width * viewport.scale), 0.5)
          runs.push({
            page: pageNumber,
            text: sourceText,
            x: clamp(x / viewport.width),
            y: clamp(y / viewport.height),
            width: clamp(width / viewport.width),
            height: clamp(fontHeight / viewport.height),
            rotation: viewport.rotation,
            method: 'pdf-text',
            fontName: sourceFontName,
            fontSize: fontHeight,
            ...(typeof font?.bold === 'boolean' ? { bold: font.bold } : {}),
            ...(typeof font?.italic === 'boolean'
              ? { italic: font.italic }
              : {}),
            confidence: 1,
          })
        }

        const textCharacters = runs.reduce(
          (total, run) => total + run.text.replace(/\s/g, '').length,
          0,
        )
        const imageCount = countImages(operatorList.fnArray, imageOps)
        const objectDrafts = extractNativeObjects({
          page: pageNumber,
          rotation: viewport.rotation,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          viewportTransform: viewport.transform as Matrix,
          fnArray: operatorList.fnArray,
          argsArray: operatorList.argsArray,
          imageOps,
          saveOp: pdfjs.OPS.save,
          restoreOp: pdfjs.OPS.restore,
          transformOp: pdfjs.OPS.transform,
          constructPathOp: pdfjs.OPS.constructPath,
        })
        const objects = objectDrafts.map((draft) => draft.object)
        const resolvedInternalDestinations = new Map(
          (
            await Promise.all(
              [
                ...new Set(
                  annotations.flatMap((annotation) =>
                    annotation &&
                    typeof annotation === 'object' &&
                    typeof (annotation as { dest?: unknown }).dest === 'string'
                      ? [(annotation as { dest: string }).dest]
                      : [],
                  ),
                ),
              ].map(
                async (destination) =>
                  [
                    destination,
                    await namedDestinationEvidence(destination),
                  ] as const,
              ),
            )
          ).flatMap(([destination, evidence]) =>
            evidence ? [[destination, evidence] as const] : [],
          ),
        )
        throwIfAborted(options.signal)
        const links = extractPdfLinkAnnotations({
          page: pageNumber,
          rotation: viewport.rotation,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          annotations,
          convertToViewportRectangle: (rect) =>
            viewport.convertToViewportRectangle(rect),
          resolvedInternalDestinations,
        })
        const analysis: PdfPageAnalysis = {
          page: pageNumber,
          kind: 'born-digital',
          width: viewport.width,
          height: viewport.height,
          rotation: viewport.rotation,
          textCharacters,
          imageCount,
          objects,
          links,
          runs,
        }
        const attachNativeAssets = async (target: PdfPageAnalysis) => {
          const resolved = await resolveNativeObjects(
            page,
            objectDrafts,
            options.signal,
          )
          const resolvedObjects = new Map(
            resolved.objects.map((object) => [object.id, object]),
          )
          target.objects = (target.objects ?? []).map((object) => ({
            ...object,
            assetId: resolvedObjects.get(object.id)?.assetId ?? object.assetId,
          }))
          target.assets = resolved.assets
        }
        const classification = classifyPdfPage(analysis)
        analysis.kind =
          classification.contentClass === 'born-digital' ||
          classification.contentClass === 'scholarly-visual'
            ? 'born-digital'
            : classification.contentClass === 'mixed'
              ? 'mixed'
              : 'ocr-required'

        if (options.ocr && classification.needsOcr) {
          activeOcrPage = pageNumber
          if (!ocrSession) {
            const sessionPromise = options.ocr.createSession({
              languages: [...options.ocr.languages],
              languageMode: options.ocr.languageMode,
              signal: options.signal,
              onProgress: (progress, message) => {
                onProgress?.({
                  phase: 'ocr',
                  completed: activeOcrPage - 1 + clamp(progress),
                  total: document.numPages,
                  message,
                })
              },
            })
            ocrSession = await raceWithAbort(
              sessionPromise,
              options.signal,
              () => {
                void sessionPromise
                  .then((lateSession) => lateSession.terminate())
                  .catch(() => undefined)
              },
            )
          }
          onProgress?.({
            phase: 'ocr',
            completed: pageNumber - 1,
            total: document.numPages,
            message: `Recognizing page ${pageNumber} of ${document.numPages} locally…`,
          })
          throwIfAborted(options.signal)
          const rasterPage = {
            page: pageNumber,
            width: viewport.width,
            height: viewport.height,
            rotation: viewport.rotation,
            signal: options.signal,
            render: () =>
              renderPageRaster(page as RasterizablePage, options.signal),
          }
          const rasterPromise = options.ocr.rasterize
            ? options.ocr.rasterize(rasterPage)
            : rasterPage.render()
          const raster = await raceWithAbort(
            rasterPromise,
            options.signal,
            () => undefined,
          )
          if (raster.width * raster.height > MAX_OCR_RASTER_PIXELS) {
            throw new PdfImportError(
              'OCR_REQUIRED',
              `OCR raster resource limit exceeded: ${raster.width} × ${raster.height} pixels is above the bounded ${MAX_OCR_RASTER_PIXELS}-pixel limit.`,
            )
          }
          throwIfAborted(options.signal)
          const recognition = await raceWithAbort(
            ocrSession.recognize({
              page: pageNumber,
              rotation: viewport.rotation,
              sourceSha256: sourceHash,
              raster,
              signal: options.signal,
            }),
            options.signal,
            terminateOcrSession,
          )
          throwIfAborted(options.signal)
          const merged = mergeOcrPage(analysis, recognition, {
            sourceSha256: sourceHash,
          }).page
          merged.spread = detectPhysicalSpread(merged)
          await attachNativeAssets(merged)
          pages.push(merged)
        } else {
          analysis.spread = detectPhysicalSpread(analysis)
          await attachNativeAssets(analysis)
          pages.push(analysis)
        }
      } finally {
        page.cleanup()
      }
    }

    onProgress?.({
      phase: 'reconstructing',
      completed: document.numPages,
      total: document.numPages,
      message: 'Rebuilding semantic reading order…',
    })
    throwIfAborted(options.signal)
    const rawMetadata = await document.getMetadata().catch(() => undefined)
    throwIfAborted(options.signal)
    const info = (rawMetadata?.info ?? {}) as unknown as Record<string, unknown>
    const pdfInfoModified = normalizedPdfDate(metadataValue(info, 'ModDate'))
    const metadata: PdfDocumentMetadata = {
      title: metadataValue(info, 'Title'),
      author: metadataValue(info, 'Author'),
      subject: metadataValue(info, 'Subject'),
      modified: pdfInfoModified,
      modifiedSource: pdfInfoModified ? 'pdf-info-mod-date' : undefined,
    }
    const reconstruction = await reconstructPageAnalyses({
      pages,
      sourceHash,
      fileName: file.name,
      byteLength: file.size,
      metadata,
      rasterizeFigure: async (input) => {
        const page = await document.getPage(input.page)
        try {
          const raster = await renderPdfPageCrop({
            page: page as unknown as PdfPageCropSource,
            canvasFactory:
              document.canvasFactory as unknown as PdfCanvasFactory,
            sourceBox: input.sourceBox,
            ownedSourceBoxes: input.ownedSourceBoxes,
            signal: options.signal,
            tightenToSourceInk: input.kind === 'figure',
          })
          const { sourceBox: renderedSourceBox, ...renderedRaster } = raster
          const sourceLineage = sourceLineageWithinCrop(
            input.sourceObjectIds,
            input.sourceBoxes,
            renderedSourceBox,
          )
          return await createSourcePageCropAsset({
            kind: input.kind === 'figure' ? 'raster' : input.kind,
            cropBox: renderedSourceBox,
            ...sourceLineage,
            ...renderedRaster,
          })
        } finally {
          page.cleanup()
        }
      },
    })
    throwIfAborted(options.signal)
    return options.decisionFile
      ? applyHumanDecisionFile(reconstruction, options.decisionFile)
      : reconstruction
  } catch (error) {
    if (options.signal?.aborted) throw cancelledError()
    throw error
  } finally {
    options.signal?.removeEventListener('abort', cancelLoading)
    await terminateOcrSession()
    await document.destroy().catch(() => undefined)
  }
}

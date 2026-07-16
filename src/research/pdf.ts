import type {
  PdfImportProgress,
  PdfNativeObject,
  PdfPageAnalysis,
  PdfSourceRun,
} from './import-types'
import { MAX_LOCAL_PDF_BYTES, PdfImportError } from './import-types'
import { reconstructPageAnalyses, type PdfDocumentMetadata } from './pdf-layout'
import { createPngAsset, createVectorSvgAsset } from './visual-assets'

type PdfImportOptions = {
  signal?: AbortSignal
  standardFontDataUrl?: string
}

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
  for (let index = 0; index < values.length; ) {
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

function pixelData(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const image = value as {
    width?: unknown
    height?: unknown
    kind?: unknown
    data?: unknown
  }
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    !ArrayBuffer.isView(image.data)
  ) {
    return null
  }
  const width = image.width as number
  const height = image.height as number
  const data = image.data as ArrayBufferView
  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  const colorSpace =
    image.kind === 1
      ? ('grayscale-1bpp' as const)
      : image.kind === 2 || pixels.length === width * height * 3
        ? ('rgb' as const)
        : image.kind === 3 || pixels.length === width * height * 4
          ? ('rgba' as const)
          : null
  return colorSpace ? { width, height, pixels, colorSpace } : null
}

async function resolveNativeObjects(
  page: { objs: { get(id: string): unknown } },
  drafts: NativeObjectDraft[],
) {
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
  for (const draft of drafts) {
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
      if (typeof draft.source === 'string')
        decoded = page.objs.get(draft.source)
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
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString()
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
      : await import('pdfjs-dist')
  if (typeof window !== 'undefined') {
    const { default: pdfWorkerUrl } = await import(
      'pdfjs-dist/build/pdf.worker.min.mjs?url'
    )
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  }
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
        const [textContent, operatorList] = await Promise.all([
          page.getTextContent(),
          page.getOperatorList(),
        ])
        throwIfAborted(options.signal)
        const runs: PdfSourceRun[] = []

        for (const item of textContent.items) {
          if (!('str' in item) || !item.str.trim()) continue
          const transform = pdfjs.Util.transform(
            viewport.transform,
            item.transform,
          )
          const fontHeight =
            Math.hypot(transform[2], transform[3]) || Math.abs(item.height) || 1
          const x = finite(transform[4])
          const y = finite(transform[5] - fontHeight)
          const width = Math.max(Math.abs(item.width * viewport.scale), 0.5)
          runs.push({
            page: pageNumber,
            text: item.str,
            x: clamp(x / viewport.width),
            y: clamp(y / viewport.height),
            width: clamp(width / viewport.width),
            height: clamp(fontHeight / viewport.height),
            rotation: viewport.rotation,
            method: 'pdf-text',
            fontName: item.fontName,
            fontSize: fontHeight,
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
        const { objects, assets } = await resolveNativeObjects(
          page,
          objectDrafts,
        )
        const kind =
          textCharacters < 24
            ? 'ocr-required'
            : imageCount > 0 && textCharacters < 240
              ? 'mixed'
              : 'born-digital'
        pages.push({
          page: pageNumber,
          kind,
          width: viewport.width,
          height: viewport.height,
          rotation: viewport.rotation,
          textCharacters,
          imageCount,
          objects,
          assets,
          runs,
        })
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
    const metadata: PdfDocumentMetadata = {
      title: metadataValue(info, 'Title'),
      author: metadataValue(info, 'Author'),
      subject: metadataValue(info, 'Subject'),
      modified:
        normalizedPdfDate(metadataValue(info, 'ModDate')) ??
        new Date(file.lastModified || 0).toISOString(),
    }
    return reconstructPageAnalyses({
      pages,
      sourceHash,
      fileName: file.name,
      byteLength: file.size,
      metadata,
    })
  } catch (error) {
    if (options.signal?.aborted) throw cancelledError()
    throw error
  } finally {
    options.signal?.removeEventListener('abort', cancelLoading)
    await document.destroy().catch(() => undefined)
  }
}

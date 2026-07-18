import { PdfImportError } from './import-types'
import type { PdfOcrOptions, PdfOcrRecognition, PdfOcrSession } from './pdf-ocr'

export const TESSERACT_JS_VERSION = '6.0.1'
export const TESSDATA_MODEL_VERSION = '4.0.0'
export const LOCAL_OCR_LANGUAGES = ['eng'] as const

export type BrowserOcrAssets = {
  workerUrl: string
  corePath: string
  langPath: string
  modelUrl: string
}

type TesseractBox = { x0: number; y0: number; x1: number; y1: number }

type TesseractPage = {
  confidence: number
  version: string
  text: string
  blocks: Array<{
    paragraphs: Array<{
      lines: Array<{
        text: string
        confidence: number
        bbox: TesseractBox
        words: Array<{
          text: string
          confidence: number
          bbox: TesseractBox
        }>
      }>
    }>
  }> | null
}

export type TesseractWorkerAdapter = {
  recognize(
    image: Blob,
    options?: Record<string, unknown>,
    output?: Record<string, boolean>,
  ): Promise<{ data: TesseractPage }>
  terminate(): Promise<unknown>
}

type BrowserWorkerFactory = (
  languages: string[],
  options: {
    workerPath: string
    corePath: string
    langPath: string
    gzip: true
    logger: (message: { progress: number; status: string }) => void
  },
) => Promise<TesseractWorkerAdapter>

type BrowserOcrDependencies = {
  assets?: BrowserOcrAssets
  origin?: string
  createWorker?: BrowserWorkerFactory
}

export function localBrowserOcrAssets(
  origin = typeof window === 'undefined'
    ? 'http://localhost'
    : window.location.origin,
): BrowserOcrAssets {
  const asset = (name: string) =>
    new URL(`/assets/ocr/${name}`, new URL(origin).origin).href
  return {
    workerUrl: asset('worker.min.js'),
    corePath: asset(''),
    langPath: asset(''),
    modelUrl: asset('eng.traineddata.gz'),
  }
}

export function validateLocalOcrAssets(
  assets: BrowserOcrAssets,
  origin: string,
) {
  const expected = new URL(origin).origin
  for (const value of Object.values(assets)) {
    if (new URL(value, expected).origin !== expected) {
      throw new PdfImportError(
        'OCR_NETWORK_FORBIDDEN',
        'Local OCR worker, core, and language assets must use the same origin as the publication studio.',
      )
    }
  }
}

function normalizedConfidence(value: number) {
  return Math.max(0, Math.min(1, value / 100))
}

async function defaultWorkerFactory(
  languages: string[],
  options: Parameters<BrowserWorkerFactory>[1],
) {
  const { createWorker, OEM } = await import('tesseract.js')
  return (await createWorker(
    languages,
    OEM.LSTM_ONLY,
    options,
  )) as unknown as TesseractWorkerAdapter
}

function recognitionFromPage(
  page: TesseractPage,
  request: Parameters<PdfOcrSession['recognize']>[0],
  languages: string[],
  languageMode: PdfOcrOptions['languageMode'],
): PdfOcrRecognition {
  const lines = (page.blocks ?? []).flatMap((block) =>
    block.paragraphs.flatMap((paragraph) => paragraph.lines),
  )
  return {
    engine: 'tesseract.js',
    engineVersion: TESSERACT_JS_VERSION,
    model: 'tessdata_best_int',
    modelVersion: TESSDATA_MODEL_VERSION,
    languages: [...languages],
    languageMode,
    raster: {
      width: request.raster.width,
      height: request.raster.height,
      sha256: request.raster.sha256,
    },
    words: lines.flatMap((line, lineIndex) =>
      line.words.map((word) => ({
        text: word.text,
        confidence: normalizedConfidence(word.confidence),
        bbox: { ...word.bbox },
        lineId: `ocr-p${String(request.page).padStart(3, '0')}-line-${String(lineIndex + 1).padStart(3, '0')}`,
      })),
    ),
    lines: lines.map((line, lineIndex) => ({
      id: `ocr-p${String(request.page).padStart(3, '0')}-line-${String(lineIndex + 1).padStart(3, '0')}`,
      text: line.text,
      confidence: normalizedConfidence(line.confidence),
      bbox: { ...line.bbox },
    })),
  }
}

export async function createBrowserOcrSession(
  options: Pick<PdfOcrOptions, 'languages' | 'languageMode'> & {
    signal?: AbortSignal
    onProgress?: (progress: number, message: string) => void
  },
  dependencies: BrowserOcrDependencies = {},
): Promise<PdfOcrSession> {
  if (options.signal?.aborted) {
    throw new PdfImportError(
      'IMPORT_CANCELLED',
      'The local PDF reconstruction was cancelled before OCR worker startup.',
    )
  }
  const languages =
    options.languageMode === 'automatic-fallback' &&
    options.languages.length === 0
      ? ['eng']
      : [...options.languages]
  if (
    languages.length === 0 ||
    languages.some(
      (language) =>
        !LOCAL_OCR_LANGUAGES.includes(
          language as (typeof LOCAL_OCR_LANGUAGES)[number],
        ),
    )
  ) {
    throw new PdfImportError(
      'OCR_LANGUAGE_UNAVAILABLE',
      `The selected OCR language is not installed locally. Available language packs: ${LOCAL_OCR_LANGUAGES.join(', ')}.`,
    )
  }

  const origin =
    dependencies.origin ??
    (typeof window === 'undefined'
      ? 'http://localhost'
      : window.location.origin)
  const assets = dependencies.assets ?? localBrowserOcrAssets(origin)
  validateLocalOcrAssets(assets, origin)
  const worker = await (dependencies.createWorker ?? defaultWorkerFactory)(
    languages,
    {
      workerPath: assets.workerUrl,
      corePath: assets.corePath,
      langPath: assets.langPath,
      gzip: true,
      logger: ({ progress, status }) =>
        options.onProgress?.(
          Math.max(0, Math.min(1, progress)),
          `Local OCR: ${status}`,
        ),
    },
  )
  if (options.signal?.aborted) {
    await worker.terminate()
    throw new PdfImportError(
      'IMPORT_CANCELLED',
      'The local PDF reconstruction was cancelled during OCR worker startup.',
    )
  }
  let terminated = false

  return {
    async recognize(request) {
      if (request.signal?.aborted) {
        throw new PdfImportError(
          'IMPORT_CANCELLED',
          'The local PDF reconstruction was cancelled and its working data was released.',
        )
      }
      const bytes = request.raster.bytes.slice().buffer as ArrayBuffer
      const result = await worker.recognize(
        new Blob([bytes], { type: request.raster.mediaType }),
        {},
        { blocks: true, text: true },
      )
      return recognitionFromPage(
        result.data,
        request,
        languages,
        options.languageMode,
      )
    },
    async terminate() {
      if (terminated) return
      terminated = true
      await worker.terminate()
    },
  }
}

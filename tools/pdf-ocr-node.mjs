import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute } from 'node:path'

export const HEADLESS_OCR_ENGINES = Object.freeze(['none', 'tesseract'])
export const DEFAULT_HEADLESS_OCR_ENGINE = 'none'
export const TESSERACT_JS_VERSION = '6.0.1'
export const TESSDATA_MODEL_VERSION = '4.0.0'
export const LOCAL_NODE_OCR_LANGUAGES = Object.freeze(['eng'])

const localRequire = createRequire(import.meta.url)

function ocrError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function throwIfAborted(signal, stage) {
  if (!signal?.aborted) return
  throw ocrError(
    'IMPORT_CANCELLED',
    `The local PDF reconstruction was cancelled ${stage}.`,
  )
}

export function normalizeHeadlessOcrEngine(value) {
  if (!HEADLESS_OCR_ENGINES.includes(value)) {
    throw new Error('INVALID_OCR_ENGINE')
  }
  return value
}

export function localNodeOcrAssets(resolveModule = localRequire.resolve) {
  const modelPath = resolveModule(
    '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
  )
  return {
    workerPath: resolveModule('tesseract.js/src/worker-script/node/index.js'),
    langPath: dirname(modelPath),
    modelPath,
    corePaths: [
      resolveModule('tesseract.js-core/tesseract-core-lstm.wasm.js'),
      resolveModule('tesseract.js-core/tesseract-core-simd-lstm.wasm.js'),
    ],
  }
}

function isLocalAbsolutePath(value) {
  return (
    typeof value === 'string' &&
    isAbsolute(value) &&
    !/^[a-z][a-z0-9+.-]*:/iu.test(value)
  )
}

export async function validateLocalNodeOcrAssets(assets, accessFile = access) {
  const paths = [
    assets?.workerPath,
    assets?.langPath,
    assets?.modelPath,
    ...(assets?.corePaths ?? []),
  ]
  if (
    assets?.corePaths?.length !== 2 ||
    paths.length !== 5 ||
    paths.some((candidate) => !isLocalAbsolutePath(candidate))
  ) {
    throw ocrError(
      'OCR_REQUIRED',
      'Headless OCR requires installed local worker, core, and language assets.',
    )
  }
  try {
    await Promise.all(paths.map((path) => accessFile(path, fsConstants.R_OK)))
  } catch {
    throw ocrError(
      'OCR_REQUIRED',
      'Headless OCR requires installed local worker, core, and language assets.',
    )
  }
  return assets
}

function normalizedConfidence(value) {
  return Math.max(0, Math.min(1, Number(value) / 100))
}

function recognitionFromPage(page, request, languages, languageMode) {
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

async function defaultWorkerFactory(languages, options) {
  const { createWorker, OEM } = await import('tesseract.js')
  return createWorker(languages, OEM.LSTM_ONLY, options)
}

export async function createNodeOcrSession(options, dependencies = {}) {
  throwIfAborted(options.signal, 'before OCR worker startup')
  const languages =
    options.languageMode === 'automatic-fallback' &&
    options.languages.length === 0
      ? ['eng']
      : [...options.languages]
  if (
    languages.length === 0 ||
    languages.some((language) => !LOCAL_NODE_OCR_LANGUAGES.includes(language))
  ) {
    throw ocrError(
      'OCR_REQUIRED',
      `The selected OCR language is not installed locally. Available language packs: ${LOCAL_NODE_OCR_LANGUAGES.join(', ')}.`,
    )
  }

  let requestedAssets
  try {
    requestedAssets =
      dependencies.assets ?? localNodeOcrAssets(dependencies.resolveModule)
  } catch {
    throw ocrError(
      'OCR_REQUIRED',
      'Headless OCR requires installed local worker, core, and language assets.',
    )
  }
  const assets = await validateLocalNodeOcrAssets(
    requestedAssets,
    dependencies.accessFile,
  )
  let worker
  try {
    worker = await (dependencies.createWorker ?? defaultWorkerFactory)(
      languages,
      {
        workerPath: assets.workerPath,
        corePath: dirname(assets.corePaths[0]),
        langPath: assets.langPath,
        gzip: true,
        cacheMethod: 'none',
        logger: ({ progress, status }) =>
          options.onProgress?.(
            Math.max(0, Math.min(1, Number(progress))),
            `Local OCR: ${status}`,
          ),
      },
    )
  } catch {
    throw ocrError(
      'OCR_REQUIRED',
      'The pinned local Tesseract OCR worker could not start.',
    )
  }

  if (options.signal?.aborted) {
    await worker.terminate()
    throwIfAborted(options.signal, 'during OCR worker startup')
  }
  let terminated = false

  return {
    async recognize(request) {
      throwIfAborted(request.signal, 'and its working data was released')
      try {
        const image = Buffer.from(
          request.raster.bytes.buffer,
          request.raster.bytes.byteOffset,
          request.raster.bytes.byteLength,
        )
        const result = await worker.recognize(
          image,
          {},
          { blocks: true, text: true },
        )
        return recognitionFromPage(
          result.data,
          request,
          languages,
          options.languageMode,
        )
      } catch (error) {
        if (error?.code === 'IMPORT_CANCELLED') throw error
        throw ocrError(
          'OCR_REQUIRED',
          'The pinned local Tesseract OCR worker could not recognize this page.',
        )
      }
    },
    async terminate() {
      if (terminated) return
      terminated = true
      await worker.terminate()
    },
  }
}

export function createNodeOcrOptions() {
  return {
    languages: ['eng'],
    languageMode: 'explicit',
    createSession: createNodeOcrSession,
  }
}

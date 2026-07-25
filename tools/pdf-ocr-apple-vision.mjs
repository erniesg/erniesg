import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ocrEngineError } from './pdf-ocr-engines.mjs'

export const APPLE_VISION_ENGINE = 'apple-vision'
export const APPLE_VISION_MODEL = 'vn-recognize-text'
export const APPLE_VISION_MODEL_VERSION = '3'
export const APPLE_VISION_RESPONSE_SCHEMA_VERSION = '1.0.0'
export const APPLE_VISION_LANGUAGES = Object.freeze(['eng'])
export const APPLE_VISION_HELPER_PATH = fileURLToPath(
  new URL('./ocr/apple-vision-recognize.swift', import.meta.url),
)

const HELPER_TIMEOUT_MS = 120_000
const MAX_HELPER_OUTPUT_BYTES = 16 * 1024 * 1024
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const execFileAsync = promisify(execFile)

// Vision speaks BCP-47; the corpus and the Tesseract reference engine speak the
// three-letter tessdata codes, so the mapping stays explicit and closed.
const VISION_LANGUAGE_CODES = Object.freeze({ eng: 'en-US' })

function unusableResponse() {
  return ocrEngineError(
    'OCR_REQUIRED',
    'The local Apple Vision OCR helper returned an unusable response.',
  )
}

function throwIfAborted(signal, stage) {
  if (!signal?.aborted) return
  throw ocrEngineError(
    'IMPORT_CANCELLED',
    `The local PDF reconstruction was cancelled ${stage}.`,
  )
}

function ratio(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw unusableResponse()
  return Math.max(0, Math.min(1, number))
}

function pixelBox(box, raster) {
  if (box === null || typeof box !== 'object') throw unusableResponse()
  const coordinates = ['x0', 'y0', 'x1', 'y1'].map((key) => {
    const value = Number(box[key])
    if (!Number.isFinite(value)) throw unusableResponse()
    return value
  })
  const limits = [raster.width, raster.height, raster.width, raster.height]
  const [x0, y0, x1, y1] = coordinates.map((value, index) =>
    Math.max(0, Math.min(limits[index], value)),
  )
  return {
    x0: Math.min(x0, x1),
    y0: Math.min(y0, y1),
    x1: Math.max(x0, x1),
    y1: Math.max(y0, y1),
  }
}

function safeIdentifier(value) {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw unusableResponse()
  }
  return value
}

function lineId(page, index) {
  return `ocr-p${String(page).padStart(3, '0')}-line-${String(index + 1).padStart(3, '0')}`
}

/**
 * Map a helper response onto the shared recognition contract. Runs on every
 * host so the contract can be exercised without a macOS runtime.
 */
export function normalizeAppleVisionRecognition(
  payload,
  request,
  { languages, languageMode },
) {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    payload.schemaVersion !== APPLE_VISION_RESPONSE_SCHEMA_VERSION ||
    payload.engine !== APPLE_VISION_ENGINE ||
    !Array.isArray(payload.lines) ||
    payload.raster === null ||
    typeof payload.raster !== 'object' ||
    payload.raster.width !== request.raster.width ||
    payload.raster.height !== request.raster.height
  ) {
    throw unusableResponse()
  }

  const raster = {
    width: request.raster.width,
    height: request.raster.height,
    sha256: request.raster.sha256,
  }
  const lines = []
  const words = []
  for (const [index, line] of payload.lines.entries()) {
    if (line === null || typeof line !== 'object') throw unusableResponse()
    if (typeof line.text !== 'string' || !Array.isArray(line.words)) {
      throw unusableResponse()
    }
    const id = lineId(request.page, index)
    lines.push({
      id,
      text: line.text,
      confidence: ratio(line.confidence),
      bbox: pixelBox(line.bbox, raster),
    })
    for (const word of line.words) {
      if (word === null || typeof word !== 'object') throw unusableResponse()
      if (typeof word.text !== 'string') throw unusableResponse()
      words.push({
        text: word.text,
        confidence: ratio(word.confidence),
        bbox: pixelBox(word.bbox, raster),
        lineId: id,
      })
    }
  }

  return {
    engine: APPLE_VISION_ENGINE,
    engineVersion: safeIdentifier(payload.engineVersion),
    model: APPLE_VISION_MODEL,
    modelVersion: safeIdentifier(payload.modelVersion),
    languages: [...languages],
    languageMode,
    raster,
    words,
    lines,
  }
}

function visionLanguages(languages) {
  return languages.map((language) => {
    const code = VISION_LANGUAGE_CODES[language]
    if (!code) {
      throw ocrEngineError(
        'OCR_REQUIRED',
        `The selected OCR language is not available in Apple Vision. Available language packs: ${Object.keys(VISION_LANGUAGE_CODES).join(', ')}.`,
      )
    }
    return code
  })
}

async function defaultRunHelper(imagePath, languages, helperPath) {
  const { stdout } = await execFileAsync(
    'swift',
    [helperPath, imagePath, '--languages', languages.join(',')],
    {
      timeout: HELPER_TIMEOUT_MS,
      maxBuffer: MAX_HELPER_OUTPUT_BYTES,
      windowsHide: true,
    },
  )
  return stdout
}

/**
 * Recognize each page raster with a small local Apple Vision helper. The helper
 * is invoked once per page image inside a private temporary directory; page
 * bytes never leave this host.
 */
export async function createAppleVisionOcrSession(options, dependencies = {}) {
  throwIfAborted(options.signal, 'before OCR helper startup')
  const platform = dependencies.platform ?? process.platform
  if (platform !== 'darwin') {
    throw ocrEngineError(
      'OCR_ENGINE_HOST_UNSUPPORTED',
      `The ${APPLE_VISION_ENGINE} OCR engine requires a darwin host; this host reports ${/^[a-z0-9]{1,32}$/u.test(String(platform)) ? platform : 'an unrecognized platform'}.`,
    )
  }
  const languages =
    options.languageMode === 'automatic-fallback' &&
    options.languages.length === 0
      ? ['eng']
      : [...options.languages]
  const requestedVisionLanguages = visionLanguages(languages)

  const helperPath = dependencies.helperPath ?? APPLE_VISION_HELPER_PATH
  const runHelper = dependencies.runHelper ?? defaultRunHelper
  if (!dependencies.runHelper) {
    try {
      await (dependencies.accessFile ?? access)(helperPath, fsConstants.R_OK)
    } catch {
      throw ocrEngineError(
        'OCR_REQUIRED',
        'The local Apple Vision OCR helper is not installed on this host.',
      )
    }
  }

  const workspace = await mkdtemp(join(tmpdir(), 'srt-apple-vision-'))
  let terminated = false

  return {
    async recognize(request) {
      throwIfAborted(request.signal, 'and its working data was released')
      const imagePath = join(
        workspace,
        `page-${String(request.page).padStart(6, '0')}.png`,
      )
      try {
        await writeFile(imagePath, request.raster.bytes, { mode: 0o600 })
        options.onProgress?.(0, 'Local OCR: apple-vision recognizing')
        const stdout = await runHelper(
          imagePath,
          requestedVisionLanguages,
          helperPath,
        )
        let payload
        try {
          payload = JSON.parse(stdout)
        } catch {
          throw unusableResponse()
        }
        const recognition = normalizeAppleVisionRecognition(payload, request, {
          languages,
          languageMode: options.languageMode,
        })
        options.onProgress?.(1, 'Local OCR: apple-vision recognized')
        return recognition
      } catch (error) {
        if (
          error?.code === 'IMPORT_CANCELLED' ||
          error?.code === 'OCR_REQUIRED'
        ) {
          throw error
        }
        // Helper failures can carry a local path in their message; report the
        // named contract failure instead.
        throw ocrEngineError(
          'OCR_REQUIRED',
          'The local Apple Vision OCR helper could not recognize this page.',
        )
      } finally {
        await rm(imagePath, { force: true })
      }
    },
    async terminate() {
      if (terminated) return
      terminated = true
      await rm(workspace, { recursive: true, force: true })
    },
  }
}

export function createAppleVisionOcrOptions(dependencies = {}) {
  return {
    languages: ['eng'],
    languageMode: 'explicit',
    createSession: (options) =>
      createAppleVisionOcrSession(options, dependencies),
  }
}

// Opt-in adapter for a self-hosted GPU OCR worker. It is never a default and
// never a fallback: the caller must select the `remote-worker` engine, pass the
// per-run opt-in flag, declare the run's documents public, and configure an
// endpoint in the environment. Page rasters are uploaded only after all four
// gates pass. Endpoint and token values are read from the environment and are
// never logged, echoed, or written to evidence.
import {
  ocrEngineError,
  REMOTE_OCR_ENDPOINT_VARIABLE,
  REMOTE_OCR_TOKEN_VARIABLE,
} from './pdf-ocr-engines.mjs'

export const REMOTE_OCR_ENGINE = 'remote-worker'
export const REMOTE_OCR_REQUEST_SCHEMA_VERSION = '1.0.0'
export const REMOTE_OCR_RESPONSE_SCHEMA_VERSION = '1.0.0'
export const REMOTE_OCR_LANGUAGES = Object.freeze(['eng'])

const REQUEST_TIMEOUT_MS = 180_000
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

function unusableResponse() {
  return ocrEngineError(
    'OCR_REQUIRED',
    'The opt-in remote OCR worker did not return a usable response.',
  )
}

function throwIfAborted(signal, stage) {
  if (!signal?.aborted) return
  throw ocrEngineError(
    'IMPORT_CANCELLED',
    `The local PDF reconstruction was cancelled ${stage}.`,
  )
}

/**
 * Only an absolute HTTPS endpoint without embedded credentials is accepted, so
 * a misconfigured variable cannot downgrade the upload or smuggle a token into
 * a URL. The endpoint itself is never returned to a caller that logs.
 */
export function readRemoteOcrEndpoint(env) {
  const raw = env?.[REMOTE_OCR_ENDPOINT_VARIABLE]
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw ocrEngineError(
      'OCR_ENGINE_ENDPOINT_UNSET',
      `The ${REMOTE_OCR_ENGINE} OCR engine requires an endpoint in the ${REMOTE_OCR_ENDPOINT_VARIABLE} environment variable; endpoint values are never read from the command line or written to evidence.`,
    )
  }
  let endpoint
  try {
    endpoint = new URL(raw.trim())
  } catch {
    endpoint = null
  }
  if (
    endpoint === null ||
    endpoint.protocol !== 'https:' ||
    endpoint.username !== '' ||
    endpoint.password !== ''
  ) {
    throw ocrEngineError(
      'OCR_ENGINE_ENDPOINT_INVALID',
      `The ${REMOTE_OCR_ENDPOINT_VARIABLE} environment variable must hold an absolute https endpoint without embedded credentials.`,
    )
  }
  return endpoint
}

function toBase64(bytes) {
  return Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString('base64')
}

/** The request schema a self-hosted worker must accept. */
export function buildRemoteOcrRequest(request, { languages, languageMode }) {
  return {
    schemaVersion: REMOTE_OCR_REQUEST_SCHEMA_VERSION,
    page: request.page,
    rotation: request.rotation,
    sourceSha256: request.sourceSha256,
    languages: [...languages],
    languageMode,
    raster: {
      mediaType: request.raster.mediaType,
      width: request.raster.width,
      height: request.raster.height,
      sha256: request.raster.sha256,
      base64: toBase64(request.raster.bytes),
    },
  }
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

/**
 * The response schema a self-hosted worker must return, mapped onto the shared
 * recognition contract. The worker must echo the raster hash it scored so a
 * recognition can never be attributed to bytes it did not see.
 */
export function parseRemoteOcrResponse(
  payload,
  request,
  { languages, languageMode },
) {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    payload.schemaVersion !== REMOTE_OCR_RESPONSE_SCHEMA_VERSION ||
    !Array.isArray(payload.lines) ||
    payload.raster === null ||
    typeof payload.raster !== 'object' ||
    payload.raster.width !== request.raster.width ||
    payload.raster.height !== request.raster.height ||
    typeof payload.raster.sha256 !== 'string' ||
    !SHA256_PATTERN.test(payload.raster.sha256) ||
    payload.raster.sha256 !== request.raster.sha256
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
    if (
      line === null ||
      typeof line !== 'object' ||
      typeof line.text !== 'string' ||
      !Array.isArray(line.words)
    ) {
      throw unusableResponse()
    }
    const id = `ocr-p${String(request.page).padStart(3, '0')}-line-${String(index + 1).padStart(3, '0')}`
    lines.push({
      id,
      text: line.text,
      confidence: ratio(line.confidence),
      bbox: pixelBox(line.bbox, raster),
    })
    for (const word of line.words) {
      if (
        word === null ||
        typeof word !== 'object' ||
        typeof word.text !== 'string'
      ) {
        throw unusableResponse()
      }
      words.push({
        text: word.text,
        confidence: ratio(word.confidence),
        bbox: pixelBox(word.bbox, raster),
        lineId: id,
      })
    }
  }

  return {
    // The engine identity stays namespaced so provenance never confuses a
    // remote recognition with a local one.
    engine: `${REMOTE_OCR_ENGINE}:${safeIdentifier(payload.engine)}`.slice(
      0,
      128,
    ),
    engineVersion: safeIdentifier(payload.engineVersion),
    model: safeIdentifier(payload.model),
    modelVersion: safeIdentifier(payload.modelVersion),
    languages: [...languages],
    languageMode,
    raster,
    words,
    lines,
  }
}

async function defaultRequestRecognition(endpoint, token, body, signal) {
  const response = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw unusableResponse()
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) throw unusableResponse()
  try {
    return JSON.parse(text)
  } catch {
    throw unusableResponse()
  }
}

export async function createRemoteOcrSession(options, dependencies = {}) {
  throwIfAborted(options.signal, 'before remote OCR activation')
  const env = dependencies.env ?? process.env
  const endpoint = readRemoteOcrEndpoint(env)
  const token = env?.[REMOTE_OCR_TOKEN_VARIABLE]
  const requestRecognition =
    dependencies.requestRecognition ?? defaultRequestRecognition
  const languages =
    options.languageMode === 'automatic-fallback' &&
    options.languages.length === 0
      ? ['eng']
      : [...options.languages]
  if (languages.length === 0) {
    throw ocrEngineError(
      'OCR_REQUIRED',
      'The remote OCR worker requires at least one requested language.',
    )
  }
  let terminated = false

  return {
    async recognize(request) {
      throwIfAborted(request.signal, 'and its working data was released')
      if (terminated) throw unusableResponse()
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const signal = request.signal
        ? AbortSignal.any([request.signal, timeout])
        : timeout
      let payload
      try {
        options.onProgress?.(0, 'Remote OCR: uploading page raster')
        payload = await requestRecognition(
          endpoint,
          typeof token === 'string' && token.length > 0 ? token : null,
          buildRemoteOcrRequest(request, {
            languages,
            languageMode: options.languageMode,
          }),
          signal,
        )
      } catch (error) {
        throwIfAborted(request.signal, 'and its working data was released')
        if (error?.code === 'OCR_REQUIRED') throw error
        // Transport failures can carry the endpoint in their message; report
        // the named contract failure instead.
        throw unusableResponse()
      }
      const recognition = parseRemoteOcrResponse(payload, request, {
        languages,
        languageMode: options.languageMode,
      })
      options.onProgress?.(1, 'Remote OCR: page recognized')
      return recognition
    },
    async terminate() {
      terminated = true
    },
  }
}

export function createRemoteOcrOptions(dependencies = {}) {
  return {
    languages: ['eng'],
    languageMode: 'explicit',
    createSession: (options) => createRemoteOcrSession(options, dependencies),
  }
}

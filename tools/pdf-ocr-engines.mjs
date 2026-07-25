// Headless OCR engine registry. Every engine fulfils the same recognition
// contract as the vendored Tesseract reference implementation: word and line
// boxes in raster pixels, per-token confidence, page rotation carried by the
// caller, engine and model versions, and the raster and source hashes that tie
// a recognition to the exact bytes it scored.
export const OCR_ENGINE_CONTRACT_VERSION = '1.0.0'

export const HEADLESS_OCR_ENGINES = Object.freeze([
  'none',
  'tesseract',
  'apple-vision',
  'remote-worker',
])

// OCR stays off unless a run selects an engine, and `tesseract` remains the
// reference engine everywhere it is selected.
export const DEFAULT_HEADLESS_OCR_ENGINE = 'none'
export const REFERENCE_HEADLESS_OCR_ENGINE = 'tesseract'

export const DOCUMENT_VISIBILITIES = Object.freeze(['private', 'public'])
export const DEFAULT_DOCUMENT_VISIBILITY = 'private'

// Endpoint and token are read from the environment by the opt-in remote
// adapter only. Their values never reach the command line, evidence, or logs;
// only these variable names are recorded.
export const REMOTE_OCR_ENDPOINT_VARIABLE = 'SRT_OCR_REMOTE_ENDPOINT'
export const REMOTE_OCR_TOKEN_VARIABLE = 'SRT_OCR_REMOTE_TOKEN'

const DESCRIPTORS = Object.freeze({
  none: Object.freeze({
    id: 'none',
    locality: 'disabled',
    hostPlatforms: null,
    requiresOptIn: false,
    uploadsDocumentBytes: false,
    module: null,
  }),
  tesseract: Object.freeze({
    id: 'tesseract',
    locality: 'local',
    hostPlatforms: null,
    requiresOptIn: false,
    uploadsDocumentBytes: false,
    module: './pdf-ocr-node.mjs',
  }),
  'apple-vision': Object.freeze({
    id: 'apple-vision',
    locality: 'local',
    hostPlatforms: Object.freeze(['darwin']),
    requiresOptIn: false,
    uploadsDocumentBytes: false,
    module: './pdf-ocr-apple-vision.mjs',
  }),
  'remote-worker': Object.freeze({
    id: 'remote-worker',
    locality: 'remote',
    hostPlatforms: null,
    requiresOptIn: true,
    uploadsDocumentBytes: true,
    module: './pdf-ocr-remote.mjs',
  }),
})

export function ocrEngineError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function normalizeHeadlessOcrEngine(value) {
  if (!HEADLESS_OCR_ENGINES.includes(value)) {
    throw new Error('INVALID_OCR_ENGINE')
  }
  return value
}

export function normalizeDocumentVisibility(value) {
  if (!DOCUMENT_VISIBILITIES.includes(value)) {
    throw new Error('INVALID_DOCUMENT_VISIBILITY')
  }
  return value
}

export function describeHeadlessOcrEngine(engine) {
  return DESCRIPTORS[normalizeHeadlessOcrEngine(engine)]
}

// Host names reach diagnostics, so keep them to the short identifiers Node
// reports rather than anything caller-supplied.
function safeHostName(platform) {
  return typeof platform === 'string' && /^[a-z0-9]{1,32}$/u.test(platform)
    ? platform
    : 'an unrecognized platform'
}

function remoteEndpointConfigured(env) {
  const endpoint = env?.[REMOTE_OCR_ENDPOINT_VARIABLE]
  return typeof endpoint === 'string' && endpoint.trim().length > 0
}

function engineDiagnostic(
  descriptor,
  { platform, env, remoteOptIn, documentVisibility },
) {
  if (
    descriptor.hostPlatforms &&
    !descriptor.hostPlatforms.includes(platform)
  ) {
    return {
      code: 'OCR_ENGINE_HOST_UNSUPPORTED',
      message: `The ${descriptor.id} OCR engine requires a ${descriptor.hostPlatforms.join(' or ')} host; this host reports ${safeHostName(platform)}.`,
    }
  }
  if (descriptor.requiresOptIn && remoteOptIn !== true) {
    return {
      code: 'OCR_ENGINE_OPT_IN_REQUIRED',
      message: `The ${descriptor.id} OCR engine is disabled by default; pass --ocr-remote-opt-in to send page rasters off this host.`,
    }
  }
  if (descriptor.uploadsDocumentBytes && documentVisibility !== 'public') {
    return {
      code: 'OCR_ENGINE_PRIVATE_DOCUMENT_FORBIDDEN',
      message: `The ${descriptor.id} OCR engine refuses documents the completeness policy marks private; declare --document-visibility public to allow upload.`,
    }
  }
  if (descriptor.locality === 'remote' && !remoteEndpointConfigured(env)) {
    return {
      code: 'OCR_ENGINE_ENDPOINT_UNSET',
      message: `The ${descriptor.id} OCR engine requires an endpoint in the ${REMOTE_OCR_ENDPOINT_VARIABLE} environment variable; endpoint values are never read from the command line or written to evidence.`,
    }
  }
  return null
}

/**
 * Report whether an engine can run here, and why not when it cannot. Callers
 * that benchmark several engines use this to skip an engine with a named
 * diagnostic instead of failing obscurely mid-run.
 */
export function resolveHeadlessOcrEngine(engine, context = {}) {
  const descriptor = describeHeadlessOcrEngine(engine)
  const platform = context.platform ?? process.platform
  const env = context.env ?? process.env
  const remoteOptIn = context.remoteOptIn === true
  const documentVisibility = normalizeDocumentVisibility(
    context.documentVisibility ?? DEFAULT_DOCUMENT_VISIBILITY,
  )
  const diagnostic = engineDiagnostic(descriptor, {
    platform,
    env,
    remoteOptIn,
    documentVisibility,
  })
  return {
    engine: descriptor.id,
    descriptor,
    contractVersion: OCR_ENGINE_CONTRACT_VERSION,
    documentVisibility,
    available: diagnostic === null,
    diagnostic,
  }
}

/**
 * Provenance for engines that leave this host. Only variable names are
 * recorded so an endpoint or token never reaches an export manifest.
 */
export function remoteOcrActivationProvenance(resolution) {
  if (
    !resolution?.available ||
    resolution.descriptor?.locality !== 'remote'
  ) {
    return null
  }
  return {
    schemaVersion: '1.0.0',
    engine: resolution.engine,
    contractVersion: resolution.contractVersion,
    locality: 'remote',
    activation: 'explicit-per-run-flag-and-environment-endpoint',
    endpointVariable: REMOTE_OCR_ENDPOINT_VARIABLE,
    tokenVariable: REMOTE_OCR_TOKEN_VARIABLE,
    uploadsDocumentBytes: true,
    documentVisibility: resolution.documentVisibility,
  }
}

/**
 * Build the `PdfOcrOptions` for a selected engine, or `undefined` when OCR is
 * off. Throws a named `OCR_ENGINE_UNAVAILABLE` error carrying the resolver
 * diagnostic when the engine cannot run here.
 */
export async function createHeadlessOcrOptions(engine, context = {}) {
  const resolution = resolveHeadlessOcrEngine(engine, context)
  if (resolution.engine === 'none') return undefined
  if (!resolution.available) {
    const error = ocrEngineError(
      'OCR_ENGINE_UNAVAILABLE',
      resolution.diagnostic.message,
    )
    error.diagnostic = resolution.diagnostic
    throw error
  }
  if (resolution.engine === 'tesseract') {
    const { createNodeOcrOptions } = await import('./pdf-ocr-node.mjs')
    return createNodeOcrOptions()
  }
  if (resolution.engine === 'apple-vision') {
    const { createAppleVisionOcrOptions } = await import(
      './pdf-ocr-apple-vision.mjs'
    )
    return createAppleVisionOcrOptions({ platform: context.platform })
  }
  const { createRemoteOcrOptions } = await import('./pdf-ocr-remote.mjs')
  return createRemoteOcrOptions({ env: context.env ?? process.env })
}

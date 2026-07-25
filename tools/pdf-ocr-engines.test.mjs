import { describe, expect, it, vi } from 'vitest'
import {
  APPLE_VISION_RESPONSE_SCHEMA_VERSION,
  createAppleVisionOcrSession,
  normalizeAppleVisionRecognition,
} from './pdf-ocr-apple-vision.mjs'
import {
  createHeadlessOcrOptions,
  DEFAULT_DOCUMENT_VISIBILITY,
  DEFAULT_HEADLESS_OCR_ENGINE,
  describeHeadlessOcrEngine,
  HEADLESS_OCR_ENGINES,
  normalizeDocumentVisibility,
  normalizeHeadlessOcrEngine,
  OCR_ENGINE_CONTRACT_VERSION,
  REFERENCE_HEADLESS_OCR_ENGINE,
  REMOTE_OCR_ENDPOINT_VARIABLE,
  REMOTE_OCR_TOKEN_VARIABLE,
  remoteOcrActivationProvenance,
  resolveHeadlessOcrEngine,
} from './pdf-ocr-engines.mjs'
import {
  buildRemoteOcrRequest,
  createRemoteOcrSession,
  parseRemoteOcrResponse,
  readRemoteOcrEndpoint,
  REMOTE_OCR_REQUEST_SCHEMA_VERSION,
  REMOTE_OCR_RESPONSE_SCHEMA_VERSION,
} from './pdf-ocr-remote.mjs'

const RASTER_SHA256 = 'a'.repeat(64)
const SOURCE_SHA256 = 'b'.repeat(64)
const SECRET_ENDPOINT = 'https://ocr.example.invalid/recognize'
const SECRET_TOKEN = 'token-must-never-be-recorded'

function recognitionRequest() {
  return {
    page: 4,
    rotation: 90,
    sourceSha256: SOURCE_SHA256,
    raster: {
      bytes: Uint8Array.from([137, 80, 78, 71]),
      mediaType: 'image/png',
      width: 200,
      height: 100,
      sha256: RASTER_SHA256,
    },
  }
}

function appleVisionPayload() {
  return {
    schemaVersion: APPLE_VISION_RESPONSE_SCHEMA_VERSION,
    engine: 'apple-vision',
    engineVersion: 'macos-15.3.1',
    model: 'vn-recognize-text',
    modelVersion: '3',
    raster: { width: 200, height: 100 },
    lines: [
      {
        text: 'Turing machine',
        confidence: 0.94,
        bbox: { x0: 10, y0: 20, x1: 180, y1: 44 },
        words: [
          {
            text: 'Turing',
            confidence: 0.96,
            bbox: { x0: 10, y0: 20, x1: 90, y1: 44 },
          },
          {
            text: 'machine',
            confidence: 0.91,
            bbox: { x0: 95, y0: 20, x1: 180, y1: 44 },
          },
        ],
      },
    ],
  }
}

function remotePayload() {
  return {
    schemaVersion: REMOTE_OCR_RESPONSE_SCHEMA_VERSION,
    engine: 'modal-doc-ocr',
    engineVersion: '2.1.0',
    model: 'doc-ocr',
    modelVersion: '2026.03',
    raster: { width: 200, height: 100, sha256: RASTER_SHA256 },
    lines: [
      {
        text: 'Turing machine',
        confidence: 0.99,
        bbox: { x0: 10, y0: 20, x1: 180, y1: 44 },
        words: [
          {
            text: 'Turing',
            confidence: 0.99,
            bbox: { x0: 10, y0: 20, x1: 90, y1: 44 },
          },
        ],
      },
    ],
  }
}

describe('headless OCR engine registry', () => {
  it('keeps OCR off by default and Tesseract as the reference engine', () => {
    expect(DEFAULT_HEADLESS_OCR_ENGINE).toBe('none')
    expect(REFERENCE_HEADLESS_OCR_ENGINE).toBe('tesseract')
    expect(DEFAULT_DOCUMENT_VISIBILITY).toBe('private')
    expect([...HEADLESS_OCR_ENGINES]).toEqual([
      'none',
      'tesseract',
      'apple-vision',
      'remote-worker',
    ])
    for (const value of ['', 'remote', 'auto', 'apple', undefined]) {
      expect(() => normalizeHeadlessOcrEngine(value)).toThrow(
        'INVALID_OCR_ENGINE',
      )
    }
    for (const value of ['', 'secret', undefined]) {
      expect(() => normalizeDocumentVisibility(value)).toThrow(
        'INVALID_DOCUMENT_VISIBILITY',
      )
    }
    expect(describeHeadlessOcrEngine('tesseract')).toMatchObject({
      locality: 'local',
      requiresOptIn: false,
      uploadsDocumentBytes: false,
    })
  })

  it('resolves the reference engine on any host without opt-in', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      expect(
        resolveHeadlessOcrEngine('tesseract', { platform, env: {} }),
      ).toMatchObject({
        engine: 'tesseract',
        available: true,
        diagnostic: null,
        contractVersion: OCR_ENGINE_CONTRACT_VERSION,
      })
    }
  })

  it('names why Apple Vision is unavailable off macOS instead of failing obscurely', () => {
    expect(
      resolveHeadlessOcrEngine('apple-vision', { platform: 'darwin', env: {} }),
    ).toMatchObject({ available: true, diagnostic: null })

    const unavailable = resolveHeadlessOcrEngine('apple-vision', {
      platform: 'linux',
      env: {},
    })
    expect(unavailable.available).toBe(false)
    expect(unavailable.diagnostic.code).toBe('OCR_ENGINE_HOST_UNSUPPORTED')
    expect(unavailable.diagnostic.message).toContain('apple-vision')
    expect(unavailable.diagnostic.message).toContain('darwin host')
    expect(unavailable.diagnostic.message).toContain('linux')

    const injected = resolveHeadlessOcrEngine('apple-vision', {
      platform: '../../etc/passwd',
      env: {},
    })
    expect(injected.diagnostic.message).toContain('an unrecognized platform')
    expect(injected.diagnostic.message).not.toContain('passwd')
  })

  it('gates the remote engine behind opt-in, public visibility, and an environment endpoint', () => {
    const env = { [REMOTE_OCR_ENDPOINT_VARIABLE]: SECRET_ENDPOINT }

    expect(
      resolveHeadlessOcrEngine('remote-worker', { env, platform: 'linux' })
        .diagnostic.code,
    ).toBe('OCR_ENGINE_OPT_IN_REQUIRED')

    expect(
      resolveHeadlessOcrEngine('remote-worker', {
        env,
        platform: 'linux',
        remoteOptIn: true,
      }).diagnostic.code,
    ).toBe('OCR_ENGINE_PRIVATE_DOCUMENT_FORBIDDEN')

    expect(
      resolveHeadlessOcrEngine('remote-worker', {
        env: {},
        platform: 'linux',
        remoteOptIn: true,
        documentVisibility: 'public',
      }).diagnostic.code,
    ).toBe('OCR_ENGINE_ENDPOINT_UNSET')

    expect(
      resolveHeadlessOcrEngine('remote-worker', {
        env,
        platform: 'linux',
        remoteOptIn: true,
        documentVisibility: 'public',
      }),
    ).toMatchObject({ available: true, diagnostic: null })
  })

  it('records remote activation with variable names only', () => {
    const activation = remoteOcrActivationProvenance(
      resolveHeadlessOcrEngine('remote-worker', {
        env: {
          [REMOTE_OCR_ENDPOINT_VARIABLE]: SECRET_ENDPOINT,
          [REMOTE_OCR_TOKEN_VARIABLE]: SECRET_TOKEN,
        },
        platform: 'linux',
        remoteOptIn: true,
        documentVisibility: 'public',
      }),
    )
    expect(activation).toEqual({
      schemaVersion: '1.0.0',
      engine: 'remote-worker',
      contractVersion: OCR_ENGINE_CONTRACT_VERSION,
      locality: 'remote',
      activation: 'explicit-per-run-flag-and-environment-endpoint',
      endpointVariable: REMOTE_OCR_ENDPOINT_VARIABLE,
      tokenVariable: REMOTE_OCR_TOKEN_VARIABLE,
      uploadsDocumentBytes: true,
      documentVisibility: 'public',
    })
    const serialized = JSON.stringify(activation)
    expect(serialized).not.toContain(SECRET_ENDPOINT)
    expect(serialized).not.toContain(SECRET_TOKEN)

    // Local engines add no remote activation record at all.
    for (const engine of ['none', 'tesseract', 'apple-vision']) {
      expect(
        remoteOcrActivationProvenance(
          resolveHeadlessOcrEngine(engine, { platform: 'darwin', env: {} }),
        ),
      ).toBeNull()
    }
  })

  it('builds engine options only for engines that can run here', async () => {
    await expect(createHeadlessOcrOptions('none')).resolves.toBeUndefined()

    const tesseract = await createHeadlessOcrOptions('tesseract')
    expect(tesseract).toMatchObject({
      languages: ['eng'],
      languageMode: 'explicit',
    })
    expect(typeof tesseract.createSession).toBe('function')

    await expect(
      createHeadlessOcrOptions('apple-vision', { platform: 'linux', env: {} }),
    ).rejects.toMatchObject({ code: 'OCR_ENGINE_UNAVAILABLE' })

    await expect(
      createHeadlessOcrOptions('remote-worker', { platform: 'linux', env: {} }),
    ).rejects.toMatchObject({ code: 'OCR_ENGINE_UNAVAILABLE' })
  })
})

describe('Apple Vision OCR engine', () => {
  it('carries the shared recognition contract from the local helper', () => {
    const request = recognitionRequest()
    const recognition = normalizeAppleVisionRecognition(
      appleVisionPayload(),
      request,
      { languages: ['eng'], languageMode: 'explicit' },
    )

    expect(Object.keys(recognition).sort()).toEqual([
      'engine',
      'engineVersion',
      'languageMode',
      'languages',
      'lines',
      'model',
      'modelVersion',
      'raster',
      'words',
    ])
    expect(recognition).toMatchObject({
      engine: 'apple-vision',
      engineVersion: 'macos-15.3.1',
      model: 'vn-recognize-text',
      modelVersion: '3',
      languages: ['eng'],
      languageMode: 'explicit',
      raster: { width: 200, height: 100, sha256: RASTER_SHA256 },
    })
    expect(recognition.lines).toEqual([
      {
        id: 'ocr-p004-line-001',
        text: 'Turing machine',
        confidence: 0.94,
        bbox: { x0: 10, y0: 20, x1: 180, y1: 44 },
      },
    ])
    expect(recognition.words.map((word) => word.lineId)).toEqual([
      'ocr-p004-line-001',
      'ocr-p004-line-001',
    ])
    expect(recognition.words[0]).toEqual({
      text: 'Turing',
      confidence: 0.96,
      bbox: { x0: 10, y0: 20, x1: 90, y1: 44 },
      lineId: 'ocr-p004-line-001',
    })
  })

  it('clamps boxes to the raster and rejects unusable helper responses', () => {
    const request = recognitionRequest()
    const overflowing = appleVisionPayload()
    overflowing.lines[0].bbox = { x0: -50, y0: -10, x1: 9_000, y1: 9_000 }
    expect(
      normalizeAppleVisionRecognition(overflowing, request, {
        languages: ['eng'],
        languageMode: 'explicit',
      }).lines[0].bbox,
    ).toEqual({ x0: 0, y0: 0, x1: 200, y1: 100 })

    for (const mutate of [
      (payload) => {
        payload.schemaVersion = '9.9.9'
      },
      (payload) => {
        payload.engine = 'tesseract.js'
      },
      (payload) => {
        payload.raster.width = 201
      },
      (payload) => {
        payload.engineVersion = 'macos 15.3.1 (build)'
      },
      (payload) => {
        payload.lines[0].confidence = 'high'
      },
      (payload) => {
        payload.lines[0].words = 'Turing'
      },
    ]) {
      const payload = appleVisionPayload()
      mutate(payload)
      expect(() =>
        normalizeAppleVisionRecognition(payload, request, {
          languages: ['eng'],
          languageMode: 'explicit',
        }),
      ).toThrow()
    }
  })

  it('refuses to start off macOS with the named host diagnostic', async () => {
    await expect(
      createAppleVisionOcrSession(
        { languages: ['eng'], languageMode: 'explicit' },
        { platform: 'linux' },
      ),
    ).rejects.toMatchObject({ code: 'OCR_ENGINE_HOST_UNSUPPORTED' })
  })

  it('invokes the helper once per page image and reports contract failures safely', async () => {
    const runHelper = vi
      .fn()
      .mockResolvedValue(JSON.stringify(appleVisionPayload()))
    const session = await createAppleVisionOcrSession(
      { languages: ['eng'], languageMode: 'explicit' },
      { platform: 'darwin', runHelper },
    )
    try {
      const recognition = await session.recognize(recognitionRequest())
      expect(recognition.engine).toBe('apple-vision')
      expect(runHelper).toHaveBeenCalledTimes(1)
      expect(runHelper.mock.calls[0][1]).toEqual(['en-US'])

      runHelper.mockRejectedValueOnce(
        new Error('/Users/owner/private/page.png: helper crashed'),
      )
      const failure = await session
        .recognize(recognitionRequest())
        .catch((error) => error)
      expect(failure.code).toBe('OCR_REQUIRED')
      expect(failure.message).toBe(
        'The local Apple Vision OCR helper could not recognize this page.',
      )
      expect(failure.message).not.toContain('/Users/')
    } finally {
      await session.terminate()
    }
  })
})

describe('opt-in remote OCR worker adapter', () => {
  it('defines the request schema a self-hosted worker must accept', () => {
    const request = buildRemoteOcrRequest(recognitionRequest(), {
      languages: ['eng'],
      languageMode: 'explicit',
    })
    expect(request).toEqual({
      schemaVersion: REMOTE_OCR_REQUEST_SCHEMA_VERSION,
      page: 4,
      rotation: 90,
      sourceSha256: SOURCE_SHA256,
      languages: ['eng'],
      languageMode: 'explicit',
      raster: {
        mediaType: 'image/png',
        width: 200,
        height: 100,
        sha256: RASTER_SHA256,
        base64: 'iVBORw==',
      },
    })
  })

  it('namespaces remote provenance and binds it to the exact raster scored', () => {
    const request = recognitionRequest()
    const recognition = parseRemoteOcrResponse(remotePayload(), request, {
      languages: ['eng'],
      languageMode: 'explicit',
    })
    expect(recognition).toMatchObject({
      engine: 'remote-worker:modal-doc-ocr',
      engineVersion: '2.1.0',
      model: 'doc-ocr',
      modelVersion: '2026.03',
      raster: { sha256: RASTER_SHA256 },
    })
    expect(recognition.words[0].lineId).toBe('ocr-p004-line-001')

    const mismatched = remotePayload()
    mismatched.raster.sha256 = 'c'.repeat(64)
    expect(() =>
      parseRemoteOcrResponse(mismatched, request, {
        languages: ['eng'],
        languageMode: 'explicit',
      }),
    ).toThrow('The opt-in remote OCR worker did not return a usable response.')
  })

  it('requires an absolute https endpoint without embedded credentials', () => {
    expect(
      readRemoteOcrEndpoint({
        [REMOTE_OCR_ENDPOINT_VARIABLE]: SECRET_ENDPOINT,
      }).href,
    ).toBe(SECRET_ENDPOINT)
    expect(() => readRemoteOcrEndpoint({})).toThrow(
      /SRT_OCR_REMOTE_ENDPOINT environment variable/u,
    )
    for (const value of [
      'http://ocr.example.invalid/recognize',
      'ocr.example.invalid/recognize',
      // Assembled at runtime: a literal credential-shaped URL would trip the
      // Rucksack publisher secret scan on every later edit of this file.
      'https://user:' + 'secret@ocr.example.invalid/recognize',
      '   ',
    ]) {
      expect(() =>
        readRemoteOcrEndpoint({ [REMOTE_OCR_ENDPOINT_VARIABLE]: value }),
      ).toThrow()
    }
  })

  it('uploads a page only through the adapter and never leaks the endpoint or token', async () => {
    const requestRecognition = vi.fn().mockResolvedValue(remotePayload())
    const session = await createRemoteOcrSession(
      { languages: ['eng'], languageMode: 'explicit' },
      {
        env: {
          [REMOTE_OCR_ENDPOINT_VARIABLE]: SECRET_ENDPOINT,
          [REMOTE_OCR_TOKEN_VARIABLE]: SECRET_TOKEN,
        },
        requestRecognition,
      },
    )
    try {
      const recognition = await session.recognize(recognitionRequest())
      expect(recognition.engine).toBe('remote-worker:modal-doc-ocr')
      expect(requestRecognition).toHaveBeenCalledTimes(1)
      const [endpoint, token, body] = requestRecognition.mock.calls[0]
      expect(endpoint.href).toBe(SECRET_ENDPOINT)
      expect(token).toBe(SECRET_TOKEN)
      expect(body.schemaVersion).toBe(REMOTE_OCR_REQUEST_SCHEMA_VERSION)

      requestRecognition.mockRejectedValueOnce(
        new Error(`connect ECONNREFUSED ${SECRET_ENDPOINT} ${SECRET_TOKEN}`),
      )
      const failure = await session
        .recognize(recognitionRequest())
        .catch((error) => error)
      expect(failure.code).toBe('OCR_REQUIRED')
      expect(failure.message).not.toContain(SECRET_ENDPOINT)
      expect(failure.message).not.toContain(SECRET_TOKEN)
    } finally {
      await session.terminate()
    }
  })
})

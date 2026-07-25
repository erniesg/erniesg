import { describe, expect, it, vi } from 'vitest'
import {
  createOcrEngineBenchmarkReport,
  instrumentOcrOptions,
  OCR_ENGINE_BENCHMARK_SCHEMA_VERSION,
  parseArguments,
  runOcrEngineBenchmark,
  summarizeOcrEngineRun,
} from './pdf-ocr-engine-benchmark.mjs'
import {
  HEADLESS_OCR_ENGINES,
  REMOTE_OCR_ENDPOINT_VARIABLE,
} from './pdf-ocr-engines.mjs'

function auditedDocument({ basename, ready, textCoverage, ocr = [] }) {
  return {
    basename,
    sha256: 'd'.repeat(64),
    completeness: { textCoverage },
    readiness: { ready },
    ...(ocr.length > 0 ? { ocr } : {}),
  }
}

describe('per-engine OCR benchmark', () => {
  it('parses engine selection and defaults to every registered engine', () => {
    expect(parseArguments(['scanned.pdf'])).toEqual({
      inputs: ['scanned.pdf'],
      engines: [...HEADLESS_OCR_ENGINES],
      ocrRemoteOptIn: false,
      documentVisibility: 'private',
    })
    expect(
      parseArguments([
        '--engine',
        'tesseract',
        '--engine=apple-vision',
        '--engine=tesseract',
        '--document-visibility=public',
        '--ocr-remote-opt-in',
        'scanned.pdf',
      ]),
    ).toEqual({
      inputs: ['scanned.pdf'],
      engines: ['tesseract', 'apple-vision'],
      ocrRemoteOptIn: true,
      documentVisibility: 'public',
    })
    for (const args of [
      [],
      ['--engine=sassy-ocr', 'a.pdf'],
      ['--nope', 'a.pdf'],
    ]) {
      expect(() => parseArguments(args)).toThrow()
    }
  })

  it('times every page recognition without changing the recognition', async () => {
    const latenciesMs = []
    let clock = 0
    const recognize = vi.fn().mockResolvedValue({ engine: 'tesseract.js' })
    const terminate = vi.fn().mockResolvedValue(undefined)
    const instrumented = instrumentOcrOptions(
      {
        languages: ['eng'],
        languageMode: 'explicit',
        createSession: async () => ({ recognize, terminate }),
      },
      latenciesMs,
      () => {
        clock += 25
        return clock
      },
    )

    const session = await instrumented.createSession({})
    expect(await session.recognize({ page: 1 })).toEqual({
      engine: 'tesseract.js',
    })
    await session.recognize({ page: 2 })
    await session.terminate()

    expect(recognize).toHaveBeenCalledTimes(2)
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(latenciesMs).toEqual([25, 25])
    expect(instrumentOcrOptions(undefined, latenciesMs)).toBeUndefined()
  })

  it('summarizes accuracy, gate pass-rate, and page latency for one engine', () => {
    expect(
      summarizeOcrEngineRun({
        engine: 'tesseract',
        available: true,
        documents: [
          auditedDocument({
            basename: 'scanned.pdf',
            ready: true,
            textCoverage: 0.99,
            ocr: [{ page: 1, confidence: 0.9 }, { page: 2, confidence: 0.8 }],
          }),
          auditedDocument({
            basename: 'faint.pdf',
            ready: false,
            textCoverage: 0.5,
          }),
          { basename: 'broken.pdf', code: 'INVALID_PDF' },
        ],
        pageLatenciesMs: [100, 300, 200],
      }),
    ).toEqual({
      engine: 'tesseract',
      available: true,
      diagnostic: null,
      documents: 3,
      audited: 2,
      ready: 1,
      failed: 1,
      gatePassRate: 0.33333,
      meanTextCoverage: 0.745,
      ocrPages: 2,
      meanOcrConfidence: 0.85,
      pageLatencyMs: { pages: 3, mean: 200, median: 200, max: 300 },
    })
  })

  it('reports an unavailable engine with its named diagnostic instead of omitting it', async () => {
    const createPipeline = vi.fn(async ({ ocrEngine }) => ({
      ocrEngine,
      ocr: {
        languages: ['eng'],
        languageMode: 'explicit',
        createSession: async () => ({
          recognize: async () => ({}),
          terminate: async () => {},
        }),
      },
      close: async () => {},
    }))
    const auditPath = vi.fn(async (path, pipeline) => ({
      document: auditedDocument({
        basename: 'scanned.pdf',
        ready: pipeline.ocrEngine === 'tesseract',
        textCoverage: pipeline.ocrEngine === 'tesseract' ? 0.99 : 0.1,
      }),
    }))

    const report = await runOcrEngineBenchmark({
      paths: ['scanned.pdf'],
      engines: ['none', 'tesseract', 'apple-vision', 'remote-worker'],
      createPipeline,
      auditPath,
      platform: 'linux',
      // A configured endpoint alone must not activate the remote engine.
      env: { [REMOTE_OCR_ENDPOINT_VARIABLE]: 'https://ocr.example.invalid' },
    })

    expect(report.schemaVersion).toBe(OCR_ENGINE_BENCHMARK_SCHEMA_VERSION)
    expect(report.referenceEngine).toBe('tesseract')
    expect(report.engines.map((engine) => engine.engine)).toEqual([
      'apple-vision',
      'none',
      'remote-worker',
      'tesseract',
    ])

    const byEngine = new Map(
      report.engines.map((engine) => [engine.engine, engine]),
    )
    expect(byEngine.get('tesseract')).toMatchObject({
      available: true,
      gatePassRate: 1,
      meanTextCoverage: 0.99,
    })
    expect(byEngine.get('none')).toMatchObject({
      available: true,
      gatePassRate: 0,
    })
    expect(byEngine.get('remote-worker')).toMatchObject({
      available: false,
      documents: 0,
      diagnostic: { code: 'OCR_ENGINE_OPT_IN_REQUIRED' },
    })
    expect(byEngine.get('apple-vision')).toMatchObject({
      available: false,
      documents: 0,
      diagnostic: { code: 'OCR_ENGINE_HOST_UNSUPPORTED' },
    })
    // Every engine keeps a row, so runs stay comparable side by side.
    expect(
      report.engines.every((engine) =>
        Object.hasOwn(engine, 'gatePassRate'),
      ),
    ).toBe(true)

    const attempted = createPipeline.mock.calls.map(([call]) => call.ocrEngine)
    expect(attempted).toEqual(['none', 'tesseract'])
  })

  it('sorts engine rows deterministically', () => {
    const report = createOcrEngineBenchmarkReport([
      summarizeOcrEngineRun({ engine: 'tesseract', available: true }),
      summarizeOcrEngineRun({ engine: 'apple-vision', available: false }),
    ])
    expect(report.engines.map((engine) => engine.engine)).toEqual([
      'apple-vision',
      'tesseract',
    ])
    expect(report.privacy).toBe('engine-identities-and-metrics-only')
  })
})

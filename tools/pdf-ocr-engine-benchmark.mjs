#!/usr/bin/env node
// Run the same scanned fixtures through each headless OCR engine and report
// accuracy, completeness gate pass-rate, and per-page latency side by side.
// Engines that cannot run on this host are reported with their named
// availability diagnostic rather than silently omitted.
import { pathToFileURL } from 'node:url'
import {
  auditPdfPath,
  canonicalPassRate,
  createPdfPipeline,
  pdfPaths,
} from './pdf-corpus-audit-lib.mjs'
import {
  DEFAULT_DOCUMENT_VISIBILITY,
  HEADLESS_OCR_ENGINES,
  normalizeDocumentVisibility,
  normalizeHeadlessOcrEngine,
  OCR_ENGINE_CONTRACT_VERSION,
  REFERENCE_HEADLESS_OCR_ENGINE,
  resolveHeadlessOcrEngine,
} from './pdf-ocr-engines.mjs'

export const OCR_ENGINE_BENCHMARK_SCHEMA_VERSION = '1.0.0'

const USAGE = `Usage: npm run pdf:ocr:benchmark -- [--engine <${HEADLESS_OCR_ENGINES.join('|')}>]... [--ocr-remote-opt-in] [--document-visibility <private|public>] <pdf-or-directory> [...]\n`

function rounded(value) {
  return Math.round(value * 100_000) / 100_000
}

function mean(values) {
  return values.length === 0
    ? null
    : rounded(values.reduce((total, value) => total + value, 0) / values.length)
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return rounded(
    sorted.length % 2 === 1
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2,
  )
}

/**
 * Wrap an engine's session factory so every page recognition is timed without
 * changing what the reconstruction pipeline sees.
 */
export function instrumentOcrOptions(
  options,
  latenciesMs,
  now = () => performance.now(),
) {
  if (!options) return options
  return {
    ...options,
    async createSession(sessionOptions) {
      const session = await options.createSession(sessionOptions)
      return {
        recognize: async (request) => {
          const started = now()
          try {
            return await session.recognize(request)
          } finally {
            latenciesMs.push(Math.round(now() - started))
          }
        },
        terminate: () => session.terminate(),
      }
    },
  }
}

/**
 * Reduce one engine's audited documents to the side-by-side comparison row.
 * `textCoverage` is the reconstruction's own accuracy measure, so an engine
 * that recovers more of the scanned page raises it.
 */
export function summarizeOcrEngineRun({
  engine,
  available,
  diagnostic = null,
  documents = [],
  pageLatenciesMs = [],
}) {
  const audited = documents.filter((document) => document.readiness)
  const ready = audited.filter((document) => document.readiness.ready).length
  const ocrPages = documents.flatMap((document) => document.ocr ?? [])
  return {
    engine,
    available,
    diagnostic: diagnostic
      ? { code: diagnostic.code, message: diagnostic.message }
      : null,
    documents: documents.length,
    audited: audited.length,
    ready,
    failed: documents.length - audited.length,
    gatePassRate: canonicalPassRate(ready, documents.length),
    meanTextCoverage: mean(
      audited.map((document) => document.completeness.textCoverage),
    ),
    ocrPages: ocrPages.length,
    meanOcrConfidence: mean(ocrPages.map((page) => page.confidence)),
    pageLatencyMs:
      pageLatenciesMs.length === 0
        ? null
        : {
            pages: pageLatenciesMs.length,
            mean: mean(pageLatenciesMs),
            median: median(pageLatenciesMs),
            max: Math.max(...pageLatenciesMs),
          },
  }
}

export function createOcrEngineBenchmarkReport(engineRuns) {
  return {
    schemaVersion: OCR_ENGINE_BENCHMARK_SCHEMA_VERSION,
    privacy: 'engine-identities-and-metrics-only',
    contractVersion: OCR_ENGINE_CONTRACT_VERSION,
    referenceEngine: REFERENCE_HEADLESS_OCR_ENGINE,
    engines: [...engineRuns].sort((left, right) =>
      left.engine.localeCompare(right.engine),
    ),
  }
}

export async function runOcrEngineBenchmark({
  paths,
  engines,
  ocrRemoteOptIn = false,
  documentVisibility = DEFAULT_DOCUMENT_VISIBILITY,
  platform = process.platform,
  env = process.env,
  createPipeline = createPdfPipeline,
  auditPath = auditPdfPath,
}) {
  const runs = []
  for (const engine of engines) {
    const resolution = resolveHeadlessOcrEngine(engine, {
      platform,
      env,
      remoteOptIn: ocrRemoteOptIn,
      documentVisibility,
    })
    if (!resolution.available) {
      runs.push(
        summarizeOcrEngineRun({
          engine,
          available: false,
          diagnostic: resolution.diagnostic,
        }),
      )
      continue
    }

    const pipeline = await createPipeline({
      ocrEngine: engine,
      ocrRemoteOptIn,
      documentVisibility,
    })
    const pageLatenciesMs = []
    try {
      const instrumented = {
        ...pipeline,
        ocr: instrumentOcrOptions(pipeline.ocr, pageLatenciesMs),
      }
      const documents = []
      for (const path of paths) {
        const record = await auditPath(path, instrumented, {})
        documents.push(record.document)
      }
      documents.sort((left, right) =>
        left.basename.localeCompare(right.basename),
      )
      runs.push(
        summarizeOcrEngineRun({
          engine,
          available: true,
          documents,
          pageLatenciesMs,
        }),
      )
    } finally {
      await pipeline.close()
    }
  }
  return createOcrEngineBenchmarkReport(runs)
}

export function parseArguments(args) {
  const inputs = []
  const engines = []
  let ocrRemoteOptIn = false
  let documentVisibility = null
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--engine') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error('INVALID_USAGE')
      engines.push(value)
      index += 1
    } else if (argument.startsWith('--engine=')) {
      engines.push(argument.slice('--engine='.length))
    } else if (argument === '--ocr-remote-opt-in') {
      ocrRemoteOptIn = true
    } else if (argument === '--document-visibility') {
      if (documentVisibility !== null) throw new Error('INVALID_USAGE')
      documentVisibility = args[index + 1] ?? null
      if (!documentVisibility || documentVisibility.startsWith('--')) {
        throw new Error('INVALID_USAGE')
      }
      index += 1
    } else if (argument.startsWith('--document-visibility=')) {
      if (documentVisibility !== null) throw new Error('INVALID_USAGE')
      documentVisibility = argument.slice('--document-visibility='.length)
    } else if (argument.startsWith('--')) {
      throw new Error('INVALID_USAGE')
    } else {
      inputs.push(argument)
    }
  }
  if (inputs.length === 0) throw new Error('INVALID_USAGE')
  return {
    inputs,
    engines: [
      ...new Set(
        (engines.length > 0 ? engines : HEADLESS_OCR_ENGINES).map(
          normalizeHeadlessOcrEngine,
        ),
      ),
    ],
    ocrRemoteOptIn,
    documentVisibility: normalizeDocumentVisibility(
      documentVisibility ?? DEFAULT_DOCUMENT_VISIBILITY,
    ),
  }
}

async function main() {
  let cli
  try {
    cli = parseArguments(process.argv.slice(2))
  } catch {
    process.stderr.write(USAGE)
    process.exitCode = 2
    return
  }
  const paths = await pdfPaths(cli.inputs)
  if (paths.length === 0) {
    process.stderr.write('No local PDF inputs were found.\n')
    process.exitCode = 2
    return
  }
  const report = await runOcrEngineBenchmark({
    paths,
    engines: cli.engines,
    ocrRemoteOptIn: cli.ocrRemoteOptIn,
    documentVisibility: cli.documentVisibility,
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.stderr.write(
      'The OCR engine benchmark failed without publishing local path details.\n',
    )
    process.exitCode = 2
  })
}

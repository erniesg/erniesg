#!/usr/bin/env node

// Run the deterministic table path beside a configured candidate provider and
// its verified result. This command never enables a provider implicitly.

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import {
  auditPdfPath,
  createPdfPipeline,
  pdfPaths,
} from './pdf-corpus-audit-lib.mjs'
import {
  createProcessTableCandidateProvider,
  DEFAULT_TABLE_CANDIDATE_PROVIDER,
  readTableCandidateProviderConfiguration,
  resolveTableCandidateProviderConfiguration,
} from './pdf-table-candidate-provider.mjs'

export const TABLE_CANDIDATE_BENCHMARK_SCHEMA_VERSION = '1.0.0'

const USAGE = `Usage: node tools/pdf-table-candidate-benchmark.mjs --corpus-id <id> [--provider-config <json>] [--table-candidate-opt-in] [--source-render-evidence <json>] [--out <json>] <pdf-or-directory> [...]
`
const SHA256 = /^[a-f0-9]{64}$/u

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function addCounts(left, right) {
  return {
    semantic: left.semantic + right.semantic,
    raster: left.raster + right.raster,
    unresolved: left.unresolved + right.unresolved,
  }
}

function emptyCounts() {
  return { semantic: 0, raster: 0, unresolved: 0 }
}

function tablePathCounts(reconstruction) {
  const expected = reconstruction.completeness.expectedSemanticTableCount ?? 0
  const semantic = reconstruction.completeness.resolvedSemanticTableCount ?? 0
  const raster = reconstruction.visualRelationships.filter(
    (relationship) =>
      relationship.kind === 'table' &&
      relationship.status === 'matched' &&
      relationship.assetIds.some((assetId) => {
        const asset = reconstruction.assets.find((candidate) => candidate.id === assetId)
        return asset?.kind === 'table' && asset.mediaType !== 'application/xhtml+xml'
      }),
  ).length
  return {
    semantic,
    raster: Math.min(raster, Math.max(0, expected - semantic)),
    unresolved: Math.max(0, expected - semantic - raster),
  }
}

/**
 * The unverified provider row is intentionally labelled as candidate-only:
 * it counts proposals before deterministic source verification and is not a
 * publication path. The verified row is the actual reconstruction result.
 */
export function tableCandidatePathSummary(reconstruction, { rawProvider = false } = {}) {
  const actual = tablePathCounts(reconstruction)
  if (!rawProvider) return actual
  const total = actual.semantic + actual.raster + actual.unresolved
  const proposed = (reconstruction.tableCandidateReceipts ?? []).filter(
    (receipt) => receipt.candidateSha256 !== null,
  ).length
  return {
    semantic: Math.min(proposed, total),
    raster: 0,
    unresolved: Math.max(0, total - proposed),
  }
}

export function parseArguments(args) {
  const inputs = []
  let corpusId
  let providerConfigPath
  let sourceRenderEvidencePath
  let outPath
  let optIn = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const value = () => {
      const next = args[index + 1]
      if (!next || next.startsWith('--')) throw new Error('INVALID_USAGE')
      index += 1
      return next
    }
    if (argument === '--corpus-id') corpusId = value()
    else if (argument.startsWith('--corpus-id=')) corpusId = argument.slice(12)
    else if (argument === '--provider-config') providerConfigPath = value()
    else if (argument.startsWith('--provider-config=')) providerConfigPath = argument.slice(19)
    else if (argument === '--source-render-evidence') sourceRenderEvidencePath = value()
    else if (argument.startsWith('--source-render-evidence=')) sourceRenderEvidencePath = argument.slice(25)
    else if (argument === '--out') outPath = value()
    else if (argument.startsWith('--out=')) outPath = argument.slice(6)
    else if (argument === '--table-candidate-opt-in') optIn = true
    else if (argument.startsWith('--')) throw new Error('INVALID_USAGE')
    else inputs.push(argument)
  }
  if (!corpusId || inputs.length === 0) throw new Error('INVALID_USAGE')
  return {
    corpusId,
    inputs,
    provider: providerConfigPath
      ? 'docling-tableformer'
      : DEFAULT_TABLE_CANDIDATE_PROVIDER,
    providerConfigPath: providerConfigPath ?? null,
    sourceRenderEvidencePath: sourceRenderEvidencePath ?? null,
    outPath: outPath ?? null,
    optIn,
  }
}

async function runPipeline(
  paths,
  pipeline,
  { rawProvider = false, auditPath = auditPdfPath } = {},
) {
  const aggregate = emptyCounts()
  const documents = []
  for (const path of paths) {
    const record = await auditPath(path, pipeline)
    if (!record.reconstruction) {
      documents.push({ basename: record.document.basename, code: record.document.code })
      continue
    }
    const counts = tableCandidatePathSummary(record.reconstruction, { rawProvider })
    Object.assign(aggregate, addCounts(aggregate, counts))
    documents.push({
      basename: record.document.basename,
      sha256: record.document.sha256,
      counts,
    })
  }
  return { counts: aggregate, documents }
}

async function sourceRenderEvidence(path) {
  if (!path) return null
  let value
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error('TABLE_CANDIDATE_SOURCE_RENDER_EVIDENCE_UNREADABLE')
  }
  if (
    !value ||
    !Array.isArray(value.documents) ||
    value.documents.some(
      (document) =>
        !SHA256.test(document?.sourceSha256 ?? '') ||
        !SHA256.test(document?.renderSha256 ?? '') ||
        !Array.isArray(document?.pages) ||
        document.pages.length === 0 ||
        document.pages.some(
          (page) => !Number.isSafeInteger(page) || page < 1,
        ),
    )
  ) {
    throw new Error('TABLE_CANDIDATE_SOURCE_RENDER_EVIDENCE_INVALID')
  }
  const sourceHashes = value.documents.map((document) => document.sourceSha256)
  if (new Set(sourceHashes).size !== sourceHashes.length) {
    throw new Error('TABLE_CANDIDATE_SOURCE_RENDER_EVIDENCE_INVALID')
  }
  return { sha256: sha256(Buffer.from(JSON.stringify(value))), documents: value.documents }
}

export async function runTableCandidateBenchmark({
  corpusId,
  inputs,
  providerConfig = null,
  optIn = false,
  createPipeline = createPdfPipeline,
  collectPaths = pdfPaths,
  auditPath = auditPdfPath,
  sourceRenderEvidence = null,
}) {
  const paths = await collectPaths(inputs)
  if (paths.length === 0) throw new Error('NO_PDF_INPUTS')
  const modulePipeline = await createPipeline()
  const providerResolution = resolveTableCandidateProviderConfiguration({
    provider: providerConfig ? 'docling-tableformer' : 'none',
    optIn,
    configuration: providerConfig,
  })
  if (!providerResolution.available) {
    await modulePipeline.close()
    throw new Error(providerResolution.diagnostic.code)
  }
  const providerModule = await modulePipeline.loadTableCandidateProviderModule()
  const deterministicPipeline = modulePipeline
  const deterministic = await runPipeline(paths, deterministicPipeline, {
    auditPath,
  })
  const provider = providerConfig
    ? createProcessTableCandidateProvider({
        module: providerModule,
        configuration: providerConfig,
      })
    : null
  const providerPipeline = provider
    ? await createPipeline({ tableCandidateProvider: provider })
    : null
  try {
    const providerRun = providerPipeline
      ? await runPipeline(paths, providerPipeline, {
          rawProvider: true,
          auditPath,
        })
      : { counts: { ...deterministic.counts }, documents: [] }
    const verifiedRun = providerPipeline
      ? await runPipeline(paths, providerPipeline, { auditPath })
      : { counts: { ...deterministic.counts }, documents: [] }
    const report = providerModule.createTableCandidateBenchmarkReport({
      corpusId,
      deterministic: deterministic.counts,
      provider: providerRun.counts,
      verifiedProvider: verifiedRun.counts,
    })
    return {
      schemaVersion: TABLE_CANDIDATE_BENCHMARK_SCHEMA_VERSION,
      contractVersion: providerModule.TABLE_CANDIDATE_RECEIPT_SCHEMA_VERSION,
      corpusId,
      provider: provider?.identity ?? null,
      paths: report.paths,
      sha256: report.sha256,
      documents: {
        deterministic: deterministic.documents,
        provider: providerRun.documents,
        verifiedProvider: verifiedRun.documents,
      },
      sourceRenderEvidence,
      evidenceStatus: sourceRenderEvidence ? 'attached' : 'missing',
    }
  } finally {
    await providerPipeline?.close()
    // The deterministic run owns the first Vite instance in every mode.
    await deterministicPipeline.close()
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
  let configuration = null
  try {
    if (cli.providerConfigPath) {
      configuration = await readTableCandidateProviderConfiguration(cli.providerConfigPath)
    }
    const evidence = await sourceRenderEvidence(cli.sourceRenderEvidencePath)
    const report = await runTableCandidateBenchmark({
      corpusId: cli.corpusId,
      inputs: cli.inputs,
      providerConfig: configuration,
      optIn: cli.optIn,
      sourceRenderEvidence: evidence,
    })
    const serialized = `${JSON.stringify(report, null, 2)}\n`
    if (cli.outPath) await writeFile(cli.outPath, serialized)
    else process.stdout.write(serialized)
  } catch (error) {
    process.stderr.write(`${error?.message ?? 'TABLE_CANDIDATE_BENCHMARK_FAILED'}\n`)
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()

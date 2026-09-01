#!/usr/bin/env node

import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import reportSchema from '../docs/schemas/extraction-bakeoff-report.schema.json' with { type: 'json' }
import {
  createExtractionArchitectureDecision,
  EXTRACTION_BAKEOFF_STRATA,
  runExtractionBakeoff,
} from '../src/research/extraction-bakeoff.ts'
import { structuredExtractionHash } from '../src/research/structured-extraction.ts'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SCORE_LEDGER_SCHEMA_VERSION = '1.0.0'
const validateReportSchema = new Ajv2020({ strict: false }).compile(
  reportSchema,
)
const SYNTHETIC_AUTHORITY = Object.freeze({
  kind: 'synthetic-contract-self-test',
  realProviderCalls: 0,
  realProviderAuthority: false,
  promotionEligible: false,
})

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function authorityIsSynthetic(authority) {
  return (
    exactKeys(authority, [
      'kind',
      'realProviderCalls',
      'realProviderAuthority',
      'promotionEligible',
    ]) &&
    authority.kind === SYNTHETIC_AUTHORITY.kind &&
    authority.realProviderCalls === SYNTHETIC_AUTHORITY.realProviderCalls &&
    authority.realProviderAuthority ===
      SYNTHETIC_AUTHORITY.realProviderAuthority &&
    authority.promotionEligible === SYNTHETIC_AUTHORITY.promotionEligible
  )
}

export function validateSyntheticBakeoffReport(report) {
  if (!isRecord(report) || !authorityIsSynthetic(report.authority))
    throw new Error('INVALID_SYNTHETIC_BAKEOFF_AUTHORITY')
  const { reportSha256, ...reportWithoutHash } = report
  if (
    typeof reportSha256 !== 'string' ||
    structuredExtractionHash(reportWithoutHash) !== reportSha256
  ) {
    throw new Error('INVALID_SYNTHETIC_BAKEOFF_REPORT_HASH')
  }
  if (!validateReportSchema(report))
    throw new Error('INVALID_SYNTHETIC_BAKEOFF_REPORT_SCHEMA')
  return report
}

function syntheticReport(report) {
  const { reportSha256: _priorReportSha256, ...reportWithoutHash } = report
  const reportWithAuthority = {
    ...reportWithoutHash,
    authority: SYNTHETIC_AUTHORITY,
  }
  return {
    ...reportWithAuthority,
    reportSha256: structuredExtractionHash(reportWithAuthority),
  }
}

async function loadScoreLedger(path) {
  let value
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT')
      return new Set()
    throw new Error('INVALID_EXTRACTION_SCORE_LEDGER')
  }
  if (
    !value ||
    typeof value !== 'object' ||
    value.schemaVersion !== SCORE_LEDGER_SCHEMA_VERSION ||
    !Array.isArray(value.scoredHeldOutKeys) ||
    !value.scoredHeldOutKeys.every((key) => typeof key === 'string') ||
    new Set(value.scoredHeldOutKeys).size !== value.scoredHeldOutKeys.length
  ) {
    throw new Error('INVALID_EXTRACTION_SCORE_LEDGER')
  }
  return new Set(value.scoredHeldOutKeys)
}

async function fileExists(path) {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT')
      return false
    throw error
  }
}

async function persistScoreLedger(path, scoredHeldOutKeys) {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(
        {
          schemaVersion: SCORE_LEDGER_SCHEMA_VERSION,
          scoredHeldOutKeys: [...scoredHeldOutKeys].sort(),
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

export async function withScoreLedger(
  pathInput,
  run,
  persist = persistScoreLedger,
) {
  const path = resolve(pathInput)
  await mkdir(dirname(path), { recursive: true })
  const lockPath = `${path}.lock`
  const failurePath = `${path}.failed`
  let lock
  try {
    lock = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST')
      throw new Error('EXTRACTION_SCORE_LEDGER_LOCKED')
    throw error
  }
  let scoredHeldOutKeys
  let persistenceFailed = false
  try {
    // Inspect the failure receipt only after acquiring the lock so a process
    // cannot race past a receipt being installed by the previous owner.
    if (await fileExists(failurePath))
      throw new Error('EXTRACTION_SCORE_LEDGER_RECOVERY_REQUIRED')
    scoredHeldOutKeys = await loadScoreLedger(path)
    return await run(scoredHeldOutKeys)
  } finally {
    try {
      if (scoredHeldOutKeys) await persist(path, scoredHeldOutKeys)
    } catch (error) {
      persistenceFailed = true
      await lock.close().catch(() => undefined)
      // A distinct failure receipt is not an active lock, but it keeps every
      // future process fail-closed until an owner reconciles the held-out run.
      await rename(lockPath, failurePath).catch(() => undefined)
      throw error
    } finally {
      if (!persistenceFailed) {
        try {
          await lock.close()
        } finally {
          await unlink(lockPath).catch(() => undefined)
        }
      }
    }
  }
}

function context(id, split, layout) {
  return {
    documentId: id,
    sourceSha256: id.startsWith('development') ? SHA_A : SHA_B,
    split,
    layout,
    sourceRuns: [
      { id: `${id}-title`, text: 'Synthetic title', page: 1, order: 1 },
      {
        id: `${id}-body`,
        text: 'Synthetic source paragraph.',
        page: 1,
        order: 2,
      },
    ],
    sourceAssets: [],
  }
}

function proposal(input, quality = 'complete') {
  const nodes = [
    {
      id: `${input.documentId}-title`,
      type: 'title',
      sourceRunIds: [`${input.documentId}-title`],
    },
    {
      id: `${input.documentId}-body`,
      type: 'paragraph',
      sourceRunIds: [`${input.documentId}-body`],
    },
  ]
  if (quality === 'baseline') nodes.pop()
  if (quality === 'authored')
    nodes[1].text = 'Model-authored text that cannot be verified.'
  return {
    schemaVersion: '1.0.0',
    nodes,
  }
}

function makeCorpus() {
  const documents = [
    ['development-one', 'development', 'one-column'],
    ['heldout-one', 'held-out', 'one-column'],
    ['heldout-two', 'held-out', 'two-column'],
  ].map(([id, split, layout]) => {
    const source = context(id, split, layout)
    return {
      id,
      split,
      layout,
      context: source,
      cases: EXTRACTION_BAKEOFF_STRATA.map((stratum) => ({
        id: `${id}-${stratum}`,
        documentId: id,
        stratum,
        layout,
        expectedNodeTypes: ['title', 'paragraph'],
        expectedSourceRunIds: [`${id}-title`, `${id}-body`],
      })),
    }
  })
  return {
    id: 'synthetic-extraction-bakeoff-v1',
    development: documents.filter(({ split }) => split === 'development'),
    heldOut: documents.filter(({ split }) => split === 'held-out'),
  }
}

function arm(id) {
  return {
    id,
    identity: {
      providerId: id,
      modelId: `${id}-model`,
      modelVersion: 'fixture-1.0.0',
      modelDigest: SHA_A,
      promptHash: SHA_B,
    },
    tunedOn: ['development'],
    run: async (input) => ({
      proposal: proposal(
        input,
        id === 'geometric-baseline'
          ? 'baseline'
          : id === 'llm-authored'
            ? 'authored'
            : 'complete',
      ),
      metrics: { latencyMs: 1, costUsd: 0 },
    }),
  }
}

async function main() {
  const args = process.argv.slice(2)
  const validationIndex = args.indexOf('--validate-report')
  if (validationIndex >= 0) {
    const reportPath = args[validationIndex + 1]
    if (!reportPath) throw new Error('--validate-report requires a path')
    let report
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'))
    } catch {
      throw new Error('INVALID_SYNTHETIC_BAKEOFF_REPORT')
    }
    validateSyntheticBakeoffReport(report)
    return
  }
  const stampIndex = args.indexOf('--stamp-report')
  if (stampIndex >= 0) {
    const inputPath = args[stampIndex + 1]
    if (!inputPath) throw new Error('--stamp-report requires a path')
    const reportOutIndex = args.indexOf('--report-out')
    const outputPath = args[reportOutIndex + 1]
    if (reportOutIndex < 0 || !outputPath)
      throw new Error('--stamp-report requires --report-out <path>')
    let report
    try {
      report = JSON.parse(await readFile(inputPath, 'utf8'))
    } catch {
      throw new Error('INVALID_SYNTHETIC_BAKEOFF_REPORT')
    }
    validateSyntheticBakeoffReport(report)
    await writeFile(
      outputPath,
      `${JSON.stringify(syntheticReport(report), null, 2)}\n`,
      'utf8',
    )
    return
  }
  if (!args.includes('--self-test')) {
    process.stderr.write(
      'Usage: node --experimental-strip-types tools/pdf-extraction-bakeoff.mjs --self-test --score-ledger <path> [--out <path>]\n',
    )
    process.exitCode = 2
    return
  }
  const scoreLedgerIndex = args.indexOf('--score-ledger')
  const scoreLedgerPath = args[scoreLedgerIndex + 1]
  if (scoreLedgerIndex < 0 || !scoreLedgerPath)
    throw new Error('--score-ledger requires a path')
  const report = syntheticReport(
    await withScoreLedger(scoreLedgerPath, (scoredHeldOutKeys) =>
      runExtractionBakeoff({
        corpus: makeCorpus(),
        arms: [
          arm('geometric-baseline'),
          arm('llm-authored'),
          arm('llm-grounded'),
        ],
        scoredHeldOutKeys,
      }),
    ),
  )
  const decision = createExtractionArchitectureDecision({ report })
  const payload = `${JSON.stringify({ report, decision }, null, 2)}\n`
  const outIndex = args.indexOf('--out')
  if (outIndex >= 0) {
    const outputPath = args[outIndex + 1]
    if (!outputPath) throw new Error('--out requires a path')
    await writeFile(outputPath, payload, 'utf8')
  } else {
    process.stdout.write(payload)
  }
  const reportOutIndex = args.indexOf('--report-out')
  if (reportOutIndex >= 0) {
    const reportPath = args[reportOutIndex + 1]
    if (!reportPath) throw new Error('--report-out requires a path')
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  const decisionOutIndex = args.indexOf('--decision-out')
  if (decisionOutIndex >= 0) {
    const decisionPath = args[decisionOutIndex + 1]
    if (!decisionPath) throw new Error('--decision-out requires a path')
    await writeFile(
      decisionPath,
      `${JSON.stringify(decision, null, 2)}\n`,
      'utf8',
    )
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Extraction bake-off failed.'}\n`,
    )
    process.exitCode = 1
  })
}

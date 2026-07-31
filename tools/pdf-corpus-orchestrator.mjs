#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createCorpusContractBinding,
  validateCorpusContract,
} from './pdf-corpus-contract.mjs'

export const ORCHESTRATOR_SCHEMA_VERSION = '1.1.0'
export const OPERATIONAL_OBSERVATION_SCHEMA_VERSION = '1.0.0'
export const MAX_CONVERSION_CONCURRENCY = 2
export const MAX_EXTERNAL_VALIDATION_CONCURRENCY = 2
export const MAX_CHROMIUM_SPINE_SMOKE_CONCURRENCY = 2
export const DEFAULT_SHARD_SIZE = 2
export const VALIDATOR_IDS = ['epubcheck', 'ace', 'chromiumSpineSmoke']

const SHA256 = /^[a-f0-9]{64}$/u
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u
const MAX_RECEIPT_BYTES = 64 * 1024 * 1024
const MAX_VERSION_OUTPUT_BYTES = 1024 * 1024
const MAX_CONVERSION_STDERR_EVIDENCE_BYTES = 512 * 1024
const MAX_EPUB_BYTES = 256 * 1024 * 1024
const CHROMIUM_VERSION_SIGNATURE =
  /(?:^|\r?\n)(?:Google Chrome(?: for Testing)?|Chromium|HeadlessChrome)\s+[0-9]+(?:\.[0-9]+){1,3}(?:\s|$)/iu
const PDF_EXPORT_PERFORMANCE_PREFIX = 'PDF_EXPORT_PERFORMANCE_EVIDENCE '
const SAFE_TELEMETRY_LABEL = /^[a-z0-9][a-z0-9-]{0,63}$/u
const DEFAULT_DOCUMENT_TIMEOUT_SECONDS = 900
const DEFAULT_VALIDATION_TIMEOUT_SECONDS = 180
const CHROMIUM_SPINE_SMOKE_TOOL_VERSION = '1.2.0'
const EXPORTER_DOCUMENT_CONCURRENCY = 1
const activeChildren = new Set()
let atomicSequence = 0

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultExporterPath = fileURLToPath(
  new URL('./pdf-export.mjs', import.meta.url),
)
const defaultBrowserValidatorPath = fileURLToPath(
  new URL('./pdf-epub-browser-reader.mjs', import.meta.url),
)

const USAGE = `Usage: npm run pdf:corpus-regenerate -- --contract <contract.json> --corpus-set <frozen|seededRandom> --source-root <directory> --out <external-directory> [--shard-count <n> | --shard-size <n>] [--conversion-concurrency <1-2>] [--external-validation-concurrency <1-2>] [--chromium-spine-smoke-concurrency <1-2>] [--target <profile>]... [--ocr-engine <engine>] [--ocr-remote-opt-in] [--document-visibility <private|public>] [--no-readable-fallback] [--document-timeout-seconds <n>] [--validation-timeout-seconds <n>]\n`

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalSha256(value) {
  return sha256(canonicalJson(value))
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function parsePositiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^[1-9][0-9]*$/u.test(value ?? '')) throw new Error('INVALID_USAGE')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error('INVALID_USAGE')
  }
  return parsed
}

export function parseArguments(arguments_) {
  const parsed = {
    contractPath: null,
    corpusSet: null,
    sourceRoot: null,
    outputRoot: null,
    shardCount: null,
    shardSize: null,
    conversionConcurrency: MAX_CONVERSION_CONCURRENCY,
    externalValidationConcurrency: MAX_EXTERNAL_VALIDATION_CONCURRENCY,
    chromiumSpineSmokeConcurrency: 1,
    targets: [],
    ocrEngine: 'none',
    ocrRemoteOptIn: false,
    documentVisibility: 'private',
    readableFallback: true,
    documentTimeoutSeconds: DEFAULT_DOCUMENT_TIMEOUT_SECONDS,
    validationTimeoutSeconds: DEFAULT_VALIDATION_TIMEOUT_SECONDS,
  }
  const takeValue = (index) => {
    const value = arguments_[index + 1]
    if (!value || value.startsWith('--')) throw new Error('INVALID_USAGE')
    return value
  }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--help') return { help: true }
    const equalsIndex = argument.indexOf('=')
    const key = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex)
    const inlineValue =
      equalsIndex === -1 ? null : argument.slice(equalsIndex + 1)
    const valueFor = () => {
      if (inlineValue !== null) {
        if (inlineValue === '') throw new Error('INVALID_USAGE')
        return inlineValue
      }
      const value = takeValue(index)
      index += 1
      return value
    }
    if (key === '--contract') parsed.contractPath = valueFor()
    else if (key === '--corpus-set') parsed.corpusSet = valueFor()
    else if (key === '--source-root') parsed.sourceRoot = valueFor()
    else if (key === '--out') parsed.outputRoot = valueFor()
    else if (key === '--shard-count') {
      parsed.shardCount = parsePositiveInteger(valueFor(), 10_000)
    } else if (key === '--shard-size') {
      parsed.shardSize = parsePositiveInteger(valueFor(), 10_000)
    } else if (key === '--conversion-concurrency') {
      parsed.conversionConcurrency = parsePositiveInteger(
        valueFor(),
        MAX_CONVERSION_CONCURRENCY,
      )
    } else if (key === '--external-validation-concurrency') {
      parsed.externalValidationConcurrency = parsePositiveInteger(
        valueFor(),
        MAX_EXTERNAL_VALIDATION_CONCURRENCY,
      )
    } else if (key === '--chromium-spine-smoke-concurrency') {
      parsed.chromiumSpineSmokeConcurrency = parsePositiveInteger(
        valueFor(),
        MAX_CHROMIUM_SPINE_SMOKE_CONCURRENCY,
      )
    } else if (key === '--target') parsed.targets.push(valueFor())
    else if (key === '--ocr-engine') parsed.ocrEngine = valueFor()
    else if (key === '--document-visibility') {
      parsed.documentVisibility = valueFor()
    } else if (key === '--document-timeout-seconds') {
      parsed.documentTimeoutSeconds = parsePositiveInteger(valueFor(), 86_400)
    } else if (key === '--validation-timeout-seconds') {
      parsed.validationTimeoutSeconds = parsePositiveInteger(valueFor(), 3_600)
    } else if (argument === '--ocr-remote-opt-in') {
      parsed.ocrRemoteOptIn = true
    } else if (argument === '--no-readable-fallback') {
      parsed.readableFallback = false
    } else {
      throw new Error('INVALID_USAGE')
    }
  }
  if (
    !parsed.contractPath ||
    !parsed.corpusSet ||
    !parsed.sourceRoot ||
    !parsed.outputRoot ||
    !['frozen', 'seededRandom'].includes(parsed.corpusSet) ||
    (parsed.shardCount !== null && parsed.shardSize !== null) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(parsed.ocrEngine) ||
    !['private', 'public'].includes(parsed.documentVisibility)
  ) {
    throw new Error('INVALID_USAGE')
  }
  parsed.contractPath = resolve(parsed.contractPath)
  parsed.sourceRoot = resolve(parsed.sourceRoot)
  parsed.outputRoot = resolve(parsed.outputRoot)
  parsed.targets = [...new Set(parsed.targets)]
  return parsed
}

export function partitionContractDocuments(
  documents,
  { shardCount = null, shardSize = null } = {},
) {
  if (
    !Array.isArray(documents) ||
    documents.length === 0 ||
    (shardCount !== null && shardSize !== null)
  ) {
    throw new Error('INVALID_SHARD_PLAN')
  }
  const count =
    shardCount ??
    Math.ceil(documents.length / (shardSize ?? DEFAULT_SHARD_SIZE))
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > documents.length ||
    (shardSize !== null && (!Number.isSafeInteger(shardSize) || shardSize < 1))
  ) {
    throw new Error('INVALID_SHARD_PLAN')
  }
  const baseSize = Math.floor(documents.length / count)
  const largerShardCount = documents.length % count
  const shards = []
  let cursor = 0
  for (let index = 0; index < count; index += 1) {
    const size = baseSize + (index < largerShardCount ? 1 : 0)
    const indexedDocuments = documents
      .slice(cursor, cursor + size)
      .map((document, offset) => ({
        contractIndex: cursor + offset,
        ...structuredClone(document),
      }))
    shards.push({
      id: `shard-${String(index + 1).padStart(4, '0')}-of-${String(
        count,
      ).padStart(4, '0')}`,
      index,
      count,
      startIndex: cursor,
      endIndexExclusive: cursor + size,
      documents: indexedDocuments,
    })
    cursor += size
  }
  return shards
}

export async function runBoundedQueue(items, limit, worker, { signal } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('INVALID_CONCURRENCY_LIMIT')
  }
  const controller = new AbortController()
  const abortFromParent = () =>
    controller.abort(signal.reason ?? cancelledError())
  if (signal?.aborted) abortFromParent()
  else signal?.addEventListener('abort', abortFromParent, { once: true })
  const results = new Array(items.length)
  let nextIndex = 0
  let failure = null
  const runNext = async () => {
    while (!controller.signal.aborted) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      try {
        results[index] = await worker(items[index], index, controller.signal)
      } catch (error) {
        if (!controller.signal.aborted) {
          failure = { index, error }
          controller.abort(error)
        }
        return
      }
    }
  }
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(limit, Math.max(1, items.length)) },
        runNext,
      ),
    )
    if (signal?.aborted) {
      throw signal.reason ?? cancelledError()
    }
    if (failure) throw failure.error
    return results
  } finally {
    signal?.removeEventListener('abort', abortFromParent)
  }
}

function createBoundedExecutor(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('INVALID_CONCURRENCY_LIMIT')
  }
  const waiting = []
  let active = 0
  const drain = () => {
    while (active < limit && waiting.length > 0) {
      const task = waiting.shift()
      if (task.signal?.aborted) {
        task.reject(task.signal.reason ?? cancelledError())
        continue
      }
      task.started = true
      task.signal?.removeEventListener('abort', task.abort)
      active += 1
      Promise.resolve()
        .then(() => {
          throwIfAborted(task.signal)
          return task.work()
        })
        .then(task.resolve, task.reject)
        .finally(() => {
          active -= 1
          drain()
        })
    }
  }
  return (work, { signal } = {}) =>
    new Promise((resolveTask, rejectTask) => {
      if (typeof work !== 'function') {
        rejectTask(new Error('INVALID_PIPELINE_STAGE'))
        return
      }
      if (signal?.aborted) {
        rejectTask(signal.reason ?? cancelledError())
        return
      }
      const task = {
        work,
        signal,
        resolve: resolveTask,
        reject: rejectTask,
        started: false,
        abort: null,
      }
      task.abort = () => {
        if (task.started) return
        const index = waiting.indexOf(task)
        if (index !== -1) waiting.splice(index, 1)
        rejectTask(signal.reason ?? cancelledError())
      }
      signal?.addEventListener('abort', task.abort, { once: true })
      waiting.push(task)
      drain()
    })
}

export async function runPipelinedQueue(
  items,
  {
    conversionConcurrency,
    externalValidationConcurrency,
    chromiumSpineSmokeConcurrency,
  },
  worker,
  { signal } = {},
) {
  if (
    !Array.isArray(items) ||
    typeof worker !== 'function' ||
    conversionConcurrency > MAX_CONVERSION_CONCURRENCY ||
    externalValidationConcurrency > MAX_EXTERNAL_VALIDATION_CONCURRENCY ||
    chromiumSpineSmokeConcurrency > MAX_CHROMIUM_SPINE_SMOKE_CONCURRENCY
  ) {
    throw new Error('INVALID_PIPELINE')
  }
  const controller = new AbortController()
  const abortFromParent = () =>
    controller.abort(signal.reason ?? cancelledError())
  if (signal?.aborted) abortFromParent()
  else signal?.addEventListener('abort', abortFromParent, { once: true })
  const conversion = createBoundedExecutor(conversionConcurrency)
  const externalValidation = createBoundedExecutor(
    externalValidationConcurrency,
  )
  const chromiumSpineSmoke = createBoundedExecutor(
    chromiumSpineSmokeConcurrency,
  )
  const checkpoint = createBoundedExecutor(1)
  try {
    const settled = await Promise.allSettled(
      items.map(async (item, index) => {
        const execute = (stage) => (work) =>
          stage(work, { signal: controller.signal })
        try {
          return await worker(
            item,
            index,
            {
              conversion: execute(conversion),
              externalValidation: execute(externalValidation),
              chromiumSpineSmoke: execute(chromiumSpineSmoke),
              checkpoint: execute(checkpoint),
            },
            controller.signal,
          )
        } catch (error) {
          if (!controller.signal.aborted) controller.abort(error)
          throw error
        }
      }),
    )
    if (signal?.aborted) throw signal.reason ?? cancelledError()
    const failure = settled.find((result) => result.status === 'rejected')
    if (failure) throw failure.reason
    return settled.map((result) => result.value)
  } finally {
    signal?.removeEventListener('abort', abortFromParent)
  }
}

function canonicalPassRate(numerator, denominator) {
  if (denominator === 0) return 0
  return Math.round((numerator / denominator) * 100_000) / 100_000
}

function validationResult(status, reason) {
  return {
    status,
    ...(reason === undefined ? {} : { reason }),
  }
}

function missingProfile(profile) {
  return {
    id: profile,
    artifact: null,
    validations: Object.fromEntries(
      VALIDATOR_IDS.map((validator) => [
        validator,
        validationResult('not-run', 'artifact-missing'),
      ]),
    ),
  }
}

export function summarizeRegenerationDocuments(documents) {
  const documentSummary = {
    total: documents.length,
    ready: documents.filter(({ outcome }) => outcome === 'ready').length,
    reviewRequired: documents.filter(
      ({ outcome }) => outcome === 'review-required',
    ).length,
    failed: documents.filter(({ outcome }) => outcome === 'failed').length,
  }
  const failureReasons = new Map()
  for (const document of documents) {
    for (const code of new Set(document.failureCodes ?? [])) {
      failureReasons.set(code, (failureReasons.get(code) ?? 0) + 1)
    }
  }
  const expectedArtifacts = documents.reduce(
    (count, document) => count + document.profiles.length,
    0,
  )
  const producedArtifacts = documents.reduce(
    (count, document) =>
      count +
      document.profiles.filter((profile) => profile.artifact !== null).length,
    0,
  )
  const validations = {}
  for (const validator of VALIDATOR_IDS) {
    const counts = {
      total: expectedArtifacts,
      passed: 0,
      failed: 0,
      unavailable: 0,
      notRun: 0,
    }
    for (const document of documents) {
      for (const profile of document.profiles) {
        const status = profile.validations[validator].status
        if (status === 'passed') counts.passed += 1
        else if (status === 'failed') counts.failed += 1
        else if (status === 'unavailable') counts.unavailable += 1
        else counts.notRun += 1
      }
    }
    validations[validator] = counts
  }
  const passed =
    documentSummary.ready === documentSummary.total &&
    producedArtifacts === expectedArtifacts &&
    Object.values(validations).every((counts) => counts.passed === counts.total)
  return {
    documents: {
      ...documentSummary,
      passRate: canonicalPassRate(documentSummary.ready, documentSummary.total),
      failureReasons: Object.fromEntries(
        [...failureReasons].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    },
    artifacts: {
      expected: expectedArtifacts,
      produced: producedArtifacts,
      missing: expectedArtifacts - producedArtifacts,
    },
    validations,
    passed,
  }
}

function receiptPayload(receipt) {
  return Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== 'receiptSha256'),
  )
}

export function sealReceipt(receipt) {
  const sealed = structuredClone(receiptPayload(receipt))
  sealed.receiptSha256 = canonicalSha256(sealed)
  return sealed
}

function deterministicConversionResult(conversion) {
  if (
    !conversion ||
    !['completed', 'failed'].includes(conversion.status) ||
    !(
      conversion.exitCode === null || Number.isSafeInteger(conversion.exitCode)
    ) ||
    (conversion.status === 'completed' &&
      (conversion.reason !== undefined ||
        ![0, 1].includes(conversion.exitCode))) ||
    (conversion.status === 'failed' &&
      !['timeout', 'execution-failed'].includes(conversion.reason))
  ) {
    throw new Error('INVALID_DETERMINISTIC_CONVERSION_RESULT')
  }
  return {
    status: conversion.status,
    exitCode: conversion.exitCode,
    ...(conversion.reason === undefined ? {} : { reason: conversion.reason }),
  }
}

function operationalObservationPayload(observation) {
  return Object.fromEntries(
    Object.entries(observation).filter(([key]) => key !== 'observationSha256'),
  )
}

export function sealOperationalObservation(observation) {
  const sealed = structuredClone(operationalObservationPayload(observation))
  sealed.observationSha256 = canonicalSha256(sealed)
  return sealed
}

export function createShardIdentity({
  runIdentitySha256,
  contractBinding,
  shard,
  toolchainSha256,
  configurationSha256,
}) {
  return {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    runIdentitySha256,
    contract: {
      schemaVersion: contractBinding.schemaVersion,
      setKey: contractBinding.setKey,
      setId: contractBinding.setId,
      contractSha256: contractBinding.contractSha256,
      documentIdentitySha256: contractBinding.documentIdentitySha256,
    },
    shard: {
      id: shard.id,
      index: shard.index,
      count: shard.count,
      startIndex: shard.startIndex,
      endIndexExclusive: shard.endIndexExclusive,
      documents: shard.documents.map(
        ({ contractIndex, id, byteLength, sha256 }) => ({
          contractIndex,
          id,
          byteLength,
          sha256,
        }),
      ),
    },
    toolchainSha256,
    configurationSha256,
  }
}

export function isCompletedShardReceiptCurrent(receipt, expectedIdentity) {
  try {
    const expectedDocuments = expectedIdentity?.shard?.documents ?? []
    const receiptDocuments = Array.isArray(receipt?.documents)
      ? receipt.documents
      : []
    const documentedArtifacts = shardArtifacts(receiptDocuments)
    const sourceIdentity = receipt.evidence?.sourceIdentity
    return Boolean(
      exactKeys(receipt, [
        'schemaVersion',
        'kind',
        'status',
        'identity',
        'evidence',
        'documents',
        'summary',
        'artifacts',
        'receiptSha256',
      ]) &&
      receipt.schemaVersion === ORCHESTRATOR_SCHEMA_VERSION &&
      receipt.kind === 'pdf-corpus-regeneration-shard' &&
      receipt.status === 'completed' &&
      receipt.summary?.passed === true &&
      SHA256.test(receipt.receiptSha256 ?? '') &&
      canonicalJson(receipt.identity) === canonicalJson(expectedIdentity) &&
      exactKeys(receipt.evidence, [
        'versions',
        'configuration',
        'commands',
        'concurrency',
        'sourceIdentity',
        'conversionResult',
      ]) &&
      canonicalSha256(receipt.evidence?.versions) ===
        expectedIdentity.toolchainSha256 &&
      canonicalSha256(receipt.evidence?.configuration) ===
        expectedIdentity.configurationSha256 &&
      canonicalJson(receipt.evidence?.commands?.conversion) ===
        canonicalJson(
          conversionCommandEvidence(receipt.evidence.configuration),
        ) &&
      canonicalJson(receipt.evidence?.commands?.validators) ===
        canonicalJson(receipt.evidence?.versions?.validators) &&
      canonicalJson(receipt.evidence?.concurrency) ===
        canonicalJson(receipt.evidence?.configuration?.concurrency) &&
      canonicalJson(receipt.evidence?.conversionResult) ===
        canonicalJson(
          deterministicConversionResult(receipt.evidence?.conversionResult),
        ) &&
      receipt.evidence.conversionResult.status === 'completed' &&
      receipt.evidence.conversionResult.exitCode === 0 &&
      sourceIdentity?.contractSha256 ===
        expectedIdentity.contract.contractSha256 &&
      sourceIdentity?.documentIdentitySha256 ===
        expectedIdentity.contract.documentIdentitySha256 &&
      canonicalSha256(sourceIdentity?.documents) ===
        expectedIdentity.contract.documentIdentitySha256 &&
      receiptDocuments.length === expectedDocuments.length &&
      receiptDocuments.every((document, index) => {
        const expected = expectedDocuments[index]
        return (
          document.contractIndex === expected.contractIndex &&
          document.id === expected.id &&
          document.source?.sha256 === expected.sha256 &&
          document.source?.byteLength === expected.byteLength
        )
      }) &&
      canonicalJson(receipt.artifacts) === canonicalJson(documentedArtifacts) &&
      canonicalJson(receipt.summary) ===
        canonicalJson(summarizeRegenerationDocuments(receiptDocuments)) &&
      receipt.receiptSha256 === canonicalSha256(receiptPayload(receipt)),
    )
  } catch {
    return false
  }
}

export function mergeShardReceipts({
  contractDocuments,
  receipts,
  attempts,
  profiles,
  identity = null,
  evidence = null,
}) {
  if (
    !Array.isArray(attempts) ||
    attempts.length !== receipts.length ||
    attempts.some((attempt) => !validAttemptName(attempt))
  ) {
    throw new Error('INVALID_SHARD_ARTIFACT_LOCATOR')
  }
  const documentsByIndex = new Map()
  for (const receipt of receipts) {
    const shard = receipt.identity?.shard
    const attempt = attempts[shard?.index]
    if (
      !shard ||
      !Number.isSafeInteger(shard.index) ||
      typeof shard.id !== 'string' ||
      !shard.id.startsWith('shard-') ||
      basename(shard.id) !== shard.id ||
      !attempt ||
      attempt !== shardAttemptName(receipt)
    ) {
      throw new Error('INVALID_SHARD_ARTIFACT_LOCATOR')
    }
    for (const sourceDocument of receipt.documents) {
      const document = structuredClone(sourceDocument)
      if (
        !Number.isSafeInteger(document.contractIndex) ||
        documentsByIndex.has(document.contractIndex)
      ) {
        throw new Error('INVALID_SHARD_RECEIPT_COVERAGE')
      }
      for (const profile of document.profiles) {
        if (!profile.artifact) continue
        if (!safeRelativeArtifactPath(profile.artifact.relativePath)) {
          throw new Error('INVALID_SHARD_ARTIFACT_LOCATOR')
        }
        profile.artifact.relativePath = [
          'shards',
          shard.id,
          attempt,
          profile.artifact.relativePath,
        ].join('/')
      }
      documentsByIndex.set(document.contractIndex, document)
    }
  }
  const documents = contractDocuments.map((source, contractIndex) => {
    const document = documentsByIndex.get(contractIndex)
    if (
      !document ||
      document.id !== source.id ||
      document.source.sha256 !== source.sha256 ||
      document.source.byteLength !== source.byteLength ||
      canonicalJson(document.profiles.map(({ id }) => id)) !==
        canonicalJson(profiles)
    ) {
      throw new Error('INVALID_SHARD_RECEIPT_COVERAGE')
    }
    return document
  })
  if (documentsByIndex.size !== contractDocuments.length) {
    throw new Error('INVALID_SHARD_RECEIPT_COVERAGE')
  }
  const summary = summarizeRegenerationDocuments(documents)
  return sealReceipt({
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    kind: 'pdf-corpus-regeneration',
    status: summary.passed ? 'completed' : 'failed',
    ...(identity === null ? {} : { identity }),
    ...(evidence === null ? {} : { evidence }),
    validationScope: {
      status: 'regeneration-and-configured-checks-only',
      publicationReadinessEstablished: false,
      chromiumSpineSmoke: chromiumSpineSmokeCoverage(),
    },
    shards: receipts
      .map((receipt) => ({
        id: receipt.identity.shard.id,
        index: receipt.identity.shard.index,
        attempt: attempts[receipt.identity.shard.index],
        receiptPath: [
          'shards',
          receipt.identity.shard.id,
          attempts[receipt.identity.shard.index],
          'receipt.json',
        ].join('/'),
        receiptSha256: receipt.receiptSha256,
      }))
      .sort((left, right) => left.index - right.index),
    documents,
    summary,
  })
}

function validAttemptName(attempt) {
  return (
    typeof attempt === 'string' &&
    /^attempt-[a-f0-9]{64}$/u.test(attempt) &&
    basename(attempt) === attempt
  )
}

function shardAttemptName(receipt) {
  if (!SHA256.test(receipt?.receiptSha256 ?? '')) {
    throw new Error('INVALID_SHARD_ARTIFACT_LOCATOR')
  }
  return `attempt-${receipt.receiptSha256}`
}

async function fileSha256(path, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const flags =
    fsConstants.O_RDONLY |
    (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)
  const handle = await open(path, flags)
  try {
    const details = await handle.stat()
    if (!details.isFile() || details.size > maximumBytes) {
      throw new Error('INVALID_REGULAR_FILE')
    }
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(
      Math.min(1024 * 1024, Math.max(1, details.size)),
    )
    let byteLength = 0
    while (byteLength < details.size) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.byteLength, details.size - byteLength),
        byteLength,
      )
      if (bytesRead === 0) throw new Error('SOURCE_CHANGED_DURING_HASH')
      hash.update(chunk.subarray(0, bytesRead))
      byteLength += bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    if ((await handle.read(extra, 0, 1, byteLength)).bytesRead !== 0) {
      throw new Error('SOURCE_CHANGED_DURING_HASH')
    }
    const after = await handle.stat()
    if (
      !after.isFile() ||
      after.size !== details.size ||
      after.mtimeMs !== details.mtimeMs ||
      after.ctimeMs !== details.ctimeMs ||
      after.ino !== details.ino ||
      after.dev !== details.dev
    ) {
      throw new Error('SOURCE_CHANGED_DURING_HASH')
    }
    return { sha256: hash.digest('hex'), byteLength }
  } finally {
    await handle.close()
  }
}

async function readJson(path, maximumBytes = MAX_RECEIPT_BYTES) {
  const flags =
    fsConstants.O_RDONLY |
    (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)
  const handle = await open(path, flags)
  try {
    const details = await handle.stat()
    if (!details.isFile() || details.size > maximumBytes) {
      throw new Error('INVALID_JSON_FILE')
    }
    const bytes = Buffer.allocUnsafe(details.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      )
      if (bytesRead === 0) throw new Error('INVALID_JSON_FILE')
      offset += bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      throw new Error('INVALID_JSON_FILE')
    }
    const after = await handle.stat()
    if (
      !after.isFile() ||
      after.size !== details.size ||
      after.mtimeMs !== details.mtimeMs ||
      after.ctimeMs !== details.ctimeMs ||
      after.ino !== details.ino ||
      after.dev !== details.dev
    ) {
      throw new Error('INVALID_JSON_FILE')
    }
    return JSON.parse(bytes.toString('utf8'))
  } finally {
    await handle.close()
  }
}

async function atomicJson(path, value, { exclusive = false } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  atomicSequence += 1
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${atomicSequence}.tmp`,
  )
  const bytes = `${JSON.stringify(value, null, 2)}\n`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (exclusive) {
      await link(temporary, path)
      await rm(temporary)
    } else {
      await rename(temporary, path)
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

function pathIsContainedBy(root, candidate) {
  const relativePath = relative(root, candidate)
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  )
}

async function operationalTelemetryDirectory(runRoot, shardId) {
  if (!isAbsolute(runRoot) || resolve(runRoot) !== runRoot) {
    throw new Error('UNSAFE_OPERATIONAL_TELEMETRY_PATH')
  }
  const rootDetails = await lstat(runRoot)
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error('UNSAFE_OPERATIONAL_TELEMETRY_PATH')
  }
  const resolvedRoot = await realpath(runRoot)
  let directory = runRoot
  for (const segment of ['operational-telemetry', shardId]) {
    directory = join(directory, segment)
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const details = await lstat(directory)
    const resolvedDirectory = await realpath(directory)
    if (
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      !pathIsContainedBy(resolvedRoot, resolvedDirectory)
    ) {
      throw new Error('UNSAFE_OPERATIONAL_TELEMETRY_PATH')
    }
  }
  return directory
}

function safeRelativeArtifactPath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    posix.normalize(path) === path &&
    path.split('/').every((segment) => segment && segment !== '..')
  )
}

async function verifyReceiptArtifacts(receipt, attemptRoot) {
  if (
    !Array.isArray(receipt.artifacts) ||
    canonicalJson(receipt.artifacts) !==
      canonicalJson(shardArtifacts(receipt.documents ?? []))
  ) {
    return false
  }
  for (const artifact of receipt.artifacts) {
    if (
      !safeRelativeArtifactPath(artifact.relativePath) ||
      !SHA256.test(artifact.sha256 ?? '') ||
      !Number.isSafeInteger(artifact.byteLength) ||
      artifact.byteLength < 1 ||
      artifact.byteLength > MAX_EPUB_BYTES
    ) {
      return false
    }
    try {
      const identity = await fileSha256(
        join(attemptRoot, ...artifact.relativePath.split('/')),
        MAX_EPUB_BYTES,
      )
      if (
        identity.sha256 !== artifact.sha256 ||
        identity.byteLength !== artifact.byteLength
      ) {
        return false
      }
    } catch {
      return false
    }
  }
  return true
}

async function copyRegularFile(sourcePath, destinationPath) {
  const sourceFlags =
    fsConstants.O_RDONLY |
    (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)
  const source = await open(sourcePath, sourceFlags)
  let destination
  try {
    const details = await source.stat()
    if (!details.isFile()) throw new Error('UNSAFE_STAGED_EXPORT')
    destination = await open(destinationPath, 'wx', 0o600)
    const chunk = Buffer.allocUnsafe(
      Math.min(1024 * 1024, Math.max(1, details.size)),
    )
    let offset = 0
    while (offset < details.size) {
      const { bytesRead } = await source.read(
        chunk,
        0,
        Math.min(chunk.byteLength, details.size - offset),
        offset,
      )
      if (bytesRead === 0) throw new Error('UNSAFE_STAGED_EXPORT')
      let written = 0
      while (written < bytesRead) {
        const result = await destination.write(
          chunk,
          written,
          bytesRead - written,
          offset + written,
        )
        if (result.bytesWritten === 0) {
          throw new Error('UNSAFE_STAGED_EXPORT')
        }
        written += result.bytesWritten
      }
      offset += bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    if ((await source.read(extra, 0, 1, offset)).bytesRead !== 0) {
      throw new Error('UNSAFE_STAGED_EXPORT')
    }
    const after = await source.stat()
    if (
      !after.isFile() ||
      after.size !== details.size ||
      after.mtimeMs !== details.mtimeMs ||
      after.ctimeMs !== details.ctimeMs ||
      after.ino !== details.ino ||
      after.dev !== details.dev
    ) {
      throw new Error('UNSAFE_STAGED_EXPORT')
    }
  } finally {
    await destination?.close()
    await source.close()
  }
}

async function copyRegularTree(source, destination) {
  await mkdir(destination, { mode: 0o700 })
  const directory = await opendir(source)
  try {
    while (true) {
      const entry = await directory.read()
      if (entry === null) break
      const sourcePath = join(source, entry.name)
      const destinationPath = join(destination, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await copyRegularTree(sourcePath, destinationPath)
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        await copyRegularFile(sourcePath, destinationPath)
      } else {
        throw new Error('UNSAFE_STAGED_EXPORT')
      }
    }
  } finally {
    await directory.close()
  }
}

function killProcessTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    const arguments_ = ['/pid', String(child.pid), '/T']
    if (signal === 'SIGKILL') arguments_.push('/F')
    const result = spawnSync('taskkill', arguments_, {
      stdio: 'ignore',
      timeout: 10_000,
      windowsHide: true,
    })
    if (!result.error && result.status === 0) return
    try {
      child.kill(signal)
    } catch {
      // The child tree already exited.
    }
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The child tree already exited.
    }
  }
}

function cancelledError(signal) {
  const error = new Error(`CANCELLED_${signal ?? 'REQUESTED'}`)
  error.code = 'ORCHESTRATOR_CANCELLED'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? cancelledError()
}

export function runProcessTree(
  command,
  arguments_,
  {
    signal,
    timeoutMs,
    stdio = 'ignore',
    captureStderrBytes = 0,
    environment,
  } = {},
) {
  return new Promise((resolveProcess, rejectProcess) => {
    if (signal?.aborted) {
      rejectProcess(signal.reason ?? cancelledError())
      return
    }
    const child = spawn(command, arguments_, {
      detached: process.platform !== 'win32',
      stdio: captureStderrBytes > 0 ? ['ignore', 'ignore', 'pipe'] : stdio,
      windowsHide: true,
      ...(environment ? { env: { ...process.env, ...environment } } : {}),
    })
    activeChildren.add(child)
    let timedOut = false
    let aborted = false
    let stderrByteLength = 0
    let stderrTruncated = false
    const stderrChunks = []
    child.stderr?.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = Math.max(0, captureStderrBytes - stderrByteLength)
      if (remaining > 0) {
        const retained = bytes.subarray(0, remaining)
        stderrChunks.push(retained)
        stderrByteLength += retained.byteLength
      }
      if (bytes.byteLength > remaining) stderrTruncated = true
    })
    let escalation = null
    const stop = () => {
      killProcessTree(child, 'SIGTERM')
      escalation = setTimeout(() => killProcessTree(child, 'SIGKILL'), 1_500)
      escalation.unref()
    }
    const abort = () => {
      aborted = true
      stop()
    }
    signal?.addEventListener('abort', abort, { once: true })
    const timeout =
      timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true
            stop()
          }, timeoutMs)
    timeout?.unref()
    let spawnError = false
    child.once('error', () => {
      spawnError = true
    })
    child.once('close', (exitCode, exitSignal) => {
      activeChildren.delete(child)
      if (timeout) clearTimeout(timeout)
      if (escalation) clearTimeout(escalation)
      signal?.removeEventListener('abort', abort)
      if (aborted) {
        rejectProcess(signal.reason ?? cancelledError())
        return
      }
      resolveProcess({
        exitCode,
        signal: exitSignal,
        timedOut,
        spawnError,
        ...(captureStderrBytes > 0
          ? {
              stderr: Buffer.concat(stderrChunks).toString('utf8'),
              stderrTruncated,
            }
          : {}),
      })
    })
  })
}

function safeTelemetryInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

export function parseExporterPerformanceEvidence(
  stderr,
  expectedBasenames,
  { truncated = false } = {},
) {
  const unavailable = (reason) => ({
    schemaVersion: '1.0.0',
    status: 'unavailable',
    reason,
  })
  if (truncated) return unavailable('capture-truncated')
  if (
    typeof stderr !== 'string' ||
    !Array.isArray(expectedBasenames) ||
    expectedBasenames.length === 0 ||
    expectedBasenames.some(
      (name) =>
        typeof name !== 'string' ||
        basename(name) !== name ||
        !name.endsWith('.pdf'),
    )
  ) {
    return unavailable('invalid-capture-contract')
  }
  const lines = stderr
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(PDF_EXPORT_PERFORMANCE_PREFIX))
  if (lines.length !== 1) return unavailable('missing-or-duplicate-evidence')
  let parsed
  try {
    parsed = JSON.parse(lines[0].slice(PDF_EXPORT_PERFORMANCE_PREFIX.length))
  } catch {
    return unavailable('invalid-json')
  }
  if (
    !exactKeys(parsed, ['schemaVersion', 'documents']) ||
    parsed.schemaVersion !== '1.1.0' ||
    !Array.isArray(parsed.documents) ||
    parsed.documents.length !== expectedBasenames.length
  ) {
    return unavailable('invalid-schema')
  }
  const statuses = new Set([
    'completed',
    'timeout',
    'stalled',
    'cancelled',
    'failed',
  ])
  const documents = []
  for (const [index, document] of parsed.documents.entries()) {
    if (
      !exactKeys(document, ['basename', 'status', 'telemetry']) ||
      document.basename !== expectedBasenames[index] ||
      !statuses.has(document.status)
    ) {
      return unavailable('invalid-document')
    }
    const telemetry = document.telemetry
    if (
      !exactKeys(telemetry, [
        'heartbeatCount',
        'maximumRssBytes',
        'maximumHeapUsedBytes',
        'lastStage',
        'lastCheckpoint',
        'elapsedMs',
        'userCpuMicros',
        'systemCpuMicros',
        'stages',
      ]) ||
      ![
        telemetry.heartbeatCount,
        telemetry.maximumRssBytes,
        telemetry.maximumHeapUsedBytes,
        telemetry.elapsedMs,
        telemetry.userCpuMicros,
        telemetry.systemCpuMicros,
      ].every(safeTelemetryInteger) ||
      !SAFE_TELEMETRY_LABEL.test(telemetry.lastStage) ||
      !SAFE_TELEMETRY_LABEL.test(telemetry.lastCheckpoint) ||
      !Array.isArray(telemetry.stages) ||
      telemetry.stages.length < 1 ||
      telemetry.stages.length > 64
    ) {
      return unavailable('invalid-telemetry')
    }
    const stages = []
    for (const stage of telemetry.stages) {
      if (
        !exactKeys(stage, [
          'stage',
          'checkpoint',
          'heartbeatCount',
          'firstElapsedMs',
          'lastElapsedMs',
          'firstCompleted',
          'lastCompleted',
          'total',
        ]) ||
        !SAFE_TELEMETRY_LABEL.test(stage.stage) ||
        !SAFE_TELEMETRY_LABEL.test(stage.checkpoint) ||
        ![
          stage.heartbeatCount,
          stage.firstElapsedMs,
          stage.lastElapsedMs,
          stage.firstCompleted,
          stage.lastCompleted,
          stage.total,
        ].every(safeTelemetryInteger) ||
        stage.firstElapsedMs > stage.lastElapsedMs
      ) {
        return unavailable('invalid-stage')
      }
      stages.push({ ...stage })
    }
    documents.push({
      basename: document.basename,
      status: document.status,
      telemetry: {
        heartbeatCount: telemetry.heartbeatCount,
        maximumRssBytes: telemetry.maximumRssBytes,
        maximumHeapUsedBytes: telemetry.maximumHeapUsedBytes,
        lastStage: telemetry.lastStage,
        lastCheckpoint: telemetry.lastCheckpoint,
        elapsedMs: telemetry.elapsedMs,
        userCpuMicros: telemetry.userCpuMicros,
        systemCpuMicros: telemetry.systemCpuMicros,
        stages,
      },
    })
  }
  return {
    schemaVersion: '1.0.0',
    status: 'captured',
    documents,
  }
}

function boundedVersion(command, arguments_, requiredOutputPattern = null) {
  const result = spawnSync(command, arguments_, {
    encoding: 'buffer',
    timeout: 10_000,
    maxBuffer: MAX_VERSION_OUTPUT_BYTES,
    windowsHide: true,
  })
  const output = Buffer.concat([
    Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0),
  ])
  return {
    available:
      !result.error &&
      result.status === 0 &&
      (requiredOutputPattern === null ||
        requiredOutputPattern.test(output.toString('utf8'))),
    outputSha256: sha256(output),
  }
}

async function resolvedRegularFile(path) {
  try {
    const resolvedPath = await realpath(path)
    const details = await lstat(resolvedPath)
    return details.isFile() && !details.isSymbolicLink() ? resolvedPath : null
  } catch {
    return null
  }
}

async function resolveEpubCheckTool() {
  const directVersion = boundedVersion('epubcheck', ['--version'])
  if (directVersion.available) {
    return {
      evidence: {
        id: 'epubcheck',
        availability: 'available',
        command: {
          executable: 'epubcheck',
          arguments: ['--failonwarnings', '<epub>'],
        },
        version: {
          arguments: ['--version'],
          outputSha256: directVersion.outputSha256,
        },
      },
      invocation: (epubPath) => ({
        command: 'epubcheck',
        arguments: ['--failonwarnings', epubPath],
      }),
    }
  }
  const javaVersion = boundedVersion('java', ['-version'])
  const jarCandidates = [
    process.env.EPUBCHECK_JAR,
    resolve(repositoryRoot, 'tools/epubcheck/epubcheck.jar'),
    '/usr/share/java/epubcheck.jar',
    '/usr/local/share/java/epubcheck.jar',
  ].filter(Boolean)
  if (javaVersion.available) {
    for (const jarPath of jarCandidates) {
      const resolvedJarPath = await resolvedRegularFile(jarPath)
      if (!resolvedJarPath) continue
      const jarIdentity = await fileSha256(resolvedJarPath)
      const version = boundedVersion('java', [
        '-jar',
        resolvedJarPath,
        '--version',
      ])
      if (!version.available) continue
      return {
        evidence: {
          id: 'epubcheck',
          availability: 'available',
          command: {
            executable: 'java',
            arguments: [
              '-jar',
              '<epubcheck-jar>',
              '--failonwarnings',
              '<epub>',
            ],
          },
          version: {
            arguments: ['-jar', '<epubcheck-jar>', '--version'],
            outputSha256: version.outputSha256,
            distributionSha256: jarIdentity.sha256,
          },
        },
        invocation: (epubPath) => ({
          command: 'java',
          arguments: ['-jar', resolvedJarPath, '--failonwarnings', epubPath],
        }),
      }
    }
  }
  return {
    evidence: {
      id: 'epubcheck',
      availability: 'unavailable',
      command: {
        executable: 'epubcheck-or-java',
        arguments: ['--failonwarnings', '<epub>'],
      },
      version: { status: 'unavailable' },
    },
    invocation: null,
  }
}

async function identifyAceBrowserExecutable(path) {
  const resolvedPath = await resolvedRegularFile(path)
  if (!resolvedPath) return null
  try {
    const version = boundedVersion(
      resolvedPath,
      ['--version'],
      CHROMIUM_VERSION_SIGNATURE,
    )
    if (!version.available) return null
    return {
      path: resolvedPath,
      ...(await fileSha256(resolvedPath)),
      versionOutputSha256: version.outputSha256,
    }
  } catch {
    return null
  }
}

export async function resolveAceBrowserExecutable({
  configuredPath = process.env.PUPPETEER_EXECUTABLE_PATH,
  playwrightExecutablePath,
} = {}) {
  const configured = await identifyAceBrowserExecutable(configuredPath)
  if (configured) return configured
  let fallbackPath = playwrightExecutablePath
  if (fallbackPath === undefined) {
    try {
      const { chromium } = await import('@playwright/test')
      fallbackPath = chromium.executablePath()
    } catch {
      return null
    }
  }
  return await identifyAceBrowserExecutable(fallbackPath)
}

export async function resolveAceTool(browserResolution) {
  const version = boundedVersion('ace', ['--version'])
  const browserExecutable = version.available
    ? await resolveAceBrowserExecutable(browserResolution)
    : null
  if (!version.available || !browserExecutable) {
    return {
      evidence: {
        id: 'ace',
        availability: 'unavailable',
        command: {
          executable: 'ace',
          arguments: [
            '--exiterror2',
            '--outdir',
            '<temporary-report>',
            '<epub>',
          ],
        },
        version: version.available
          ? {
              arguments: ['--version'],
              outputSha256: version.outputSha256,
              browserExecutable: { status: 'unavailable' },
            }
          : { status: 'unavailable' },
      },
      invocation: null,
    }
  }
  return {
    evidence: {
      id: 'ace',
      availability: 'available',
      command: {
        executable: 'ace',
        arguments: ['--exiterror2', '--outdir', '<temporary-report>', '<epub>'],
        environment: {
          PUPPETEER_EXECUTABLE_PATH: '<browser-executable>',
        },
      },
      version: {
        arguments: ['--version'],
        outputSha256: version.outputSha256,
        browserExecutableSha256: browserExecutable.sha256,
        browserVersionOutputSha256: browserExecutable.versionOutputSha256,
      },
    },
    invocation: (epubPath, scratchDirectory) => ({
      command: 'ace',
      arguments: [
        '--exiterror2',
        '--outdir',
        join(scratchDirectory, 'ace'),
        epubPath,
      ],
      environment: {
        PUPPETEER_EXECUTABLE_PATH: browserExecutable.path,
      },
    }),
  }
}

async function resolveChromiumSpineSmokeTool() {
  try {
    const { chromium } = await import('@playwright/test')
    const executableIdentity = await fileSha256(chromium.executablePath())
    return {
      evidence: {
        id: 'chromiumSpineSmoke',
        availability: 'available',
        command: {
          executable: 'node',
          arguments: [
            'tools/pdf-epub-browser-reader.mjs',
            '<epub>',
            '--scratch-root',
            '<temporary-validation-root>',
          ],
        },
        version: {
          adapterVersion: CHROMIUM_SPINE_SMOKE_TOOL_VERSION,
          browserExecutableSha256: executableIdentity.sha256,
        },
        coverage: chromiumSpineSmokeCoverage(),
      },
      invocation: (epubPath, scratchDirectory) => ({
        command: process.execPath,
        arguments: [
          defaultBrowserValidatorPath,
          epubPath,
          '--scratch-root',
          scratchDirectory,
        ],
      }),
    }
  } catch {
    return {
      evidence: {
        id: 'chromiumSpineSmoke',
        availability: 'unavailable',
        command: {
          executable: 'node',
          arguments: [
            'tools/pdf-epub-browser-reader.mjs',
            '<epub>',
            '--scratch-root',
            '<temporary-validation-root>',
          ],
        },
        version: { status: 'unavailable' },
        coverage: chromiumSpineSmokeCoverage(),
      },
      invocation: null,
    }
  }
}

function chromiumSpineSmokeCoverage() {
  return {
    role: 'supplementary-only',
    included: ['chromium-spine-document-load-and-finite-layout-smoke'],
    excluded: [
      'webkit',
      'href-and-fragment-integrity',
      'reader-marker-scans',
      'responsiveness',
      'apple-books',
      'target-e-ink',
    ],
  }
}

async function captureToolchain() {
  const { capturePdfCorpusExecutionProvenance } =
    await import('./pdf-corpus-audit-lib.mjs')
  const [
    provenanceCapture,
    packageJson,
    packageLockIdentity,
    exporterIdentity,
    orchestratorIdentity,
    browserValidatorIdentity,
    epubcheck,
  ] = await Promise.all([
    capturePdfCorpusExecutionProvenance('pdf-export'),
    readJson(resolve(repositoryRoot, 'package.json'), 1024 * 1024),
    fileSha256(resolve(repositoryRoot, 'package-lock.json')),
    fileSha256(defaultExporterPath),
    fileSha256(fileURLToPath(import.meta.url)),
    fileSha256(defaultBrowserValidatorPath),
    resolveEpubCheckTool(),
  ])
  const ace = await resolveAceTool()
  const chromiumSpineSmoke = await resolveChromiumSpineSmokeTool()
  const evidence = {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    implementation: {
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      orchestratorSha256: orchestratorIdentity.sha256,
      exporterSha256: exporterIdentity.sha256,
      chromiumSpineSmokeValidatorSha256: browserValidatorIdentity.sha256,
    },
    runtime: {
      name: 'node',
      version: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
    },
    repository: {
      exporterExecutionProvenance: {
        ...provenanceCapture.publicIdentity,
        verification: {
          method: 'before-after-exact-match-v1',
          stateSha256: provenanceCapture.stateSha256,
        },
      },
      packageLockSha256: packageLockIdentity.sha256,
    },
    validators: {
      epubcheck: epubcheck.evidence,
      ace: ace.evidence,
      chromiumSpineSmoke: chromiumSpineSmoke.evidence,
    },
  }
  return {
    evidence,
    sha256: canonicalSha256(evidence),
    provenanceCapture,
    tools: { epubcheck, ace, chromiumSpineSmoke },
  }
}

async function assertToolchainUnchanged(capture) {
  const { finalizePdfCorpusExecutionProvenance } =
    await import('./pdf-corpus-audit-lib.mjs')
  await finalizePdfCorpusExecutionProvenance(capture.provenanceCapture)
  const [epubcheck, ace, chromiumSpineSmoke] = await Promise.all([
    resolveEpubCheckTool(),
    resolveAceTool(),
    resolveChromiumSpineSmokeTool(),
  ])
  const finalValidators = {
    epubcheck: epubcheck.evidence,
    ace: ace.evidence,
    chromiumSpineSmoke: chromiumSpineSmoke.evidence,
  }
  if (
    canonicalJson(finalValidators) !==
    canonicalJson(capture.evidence.validators)
  ) {
    throw new Error('VALIDATOR_TOOLCHAIN_CHANGED_DURING_RUN')
  }
}

async function safeExternalOutputRoot(requested) {
  const target = resolve(requested)
  if (target === parse(target).root) throw new Error('UNSAFE_OUTPUT_ROOT')
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new Error('UNSAFE_OUTPUT_ROOT')
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  let existingPath = target
  let resolvedExisting
  while (true) {
    try {
      resolvedExisting = await realpath(existingPath)
      break
    } catch {
      const parent = dirname(existingPath)
      if (parent === existingPath) throw new Error('UNSAFE_OUTPUT_ROOT')
      existingPath = parent
    }
  }
  const repository = await realpath(repositoryRoot)
  const resolvedTarget = resolve(
    resolvedExisting,
    relative(existingPath, target),
  )
  const repositoryRelative = relative(repository, resolvedTarget)
  const insideRepository =
    repositoryRelative === '' ||
    (repositoryRelative !== '..' &&
      !repositoryRelative.startsWith(`..${sep}`) &&
      !isAbsolute(repositoryRelative))
  if (insideRepository) throw new Error('OUTPUT_ROOT_INSIDE_REPOSITORY')
  await mkdir(resolvedTarget, { recursive: true, mode: 0o700 })
  const details = await lstat(resolvedTarget)
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('UNSAFE_OUTPUT_ROOT')
  }
  return await realpath(resolvedTarget)
}

async function sourceDocuments(contract, setKey, sourceRoot) {
  const selected = contract[setKey]
  const root = await realpath(sourceRoot)
  const details = await lstat(root)
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('INVALID_SOURCE_ROOT')
  }
  const resolved = []
  for (const expected of selected.documents) {
    const path = join(root, `${expected.id}.pdf`)
    const identity = await fileSha256(path)
    if (
      identity.byteLength !== expected.byteLength ||
      identity.sha256 !== expected.sha256
    ) {
      throw new Error('PDF_CORPUS_CONTRACT_MISMATCH')
    }
    resolved.push({ ...expected, path })
  }
  return resolved
}

function safeStem(value) {
  return (
    basename(value, extname(value))
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9._-]+/gu, '-')
      .replace(/^-|-$/gu, '') || 'publication'
  )
}

function documentExportRelativeDirectory(document, documentCount) {
  if (documentCount === 1) return ''
  return `${safeStem(document.audit.basename)}-${document.audit.sha256.slice(
    0,
    12,
  )}`
}

function failureDocument(source, contractIndex, profiles, code) {
  return {
    contractIndex,
    id: source.id,
    source: {
      sha256: source.sha256,
      byteLength: source.byteLength,
    },
    outcome: 'failed',
    failureCodes: [code],
    audit: null,
    profiles: profiles.map(missingProfile),
  }
}

function auditOutcome(audit) {
  if (!audit?.readiness) return 'failed'
  return audit.readiness.ready ? 'ready' : 'review-required'
}

function auditFailureCodes(audit) {
  if (!audit?.readiness) {
    return [
      SAFE_CODE.test(audit?.code ?? '') ? audit.code : 'PDF_EXPORT_FAILED',
    ]
  }
  return audit.readiness.ready
    ? []
    : [...new Set(audit.readiness.blockingDiagnosticCodes ?? [])].filter(
        (code) => SAFE_CODE.test(code),
      )
}

async function normalizeConversionState({
  shard,
  report,
  outputDirectory,
  profiles,
  expectedProvenanceSha256,
}) {
  if (
    report?.executionProvenance?.verification?.stateSha256 !==
      expectedProvenanceSha256 ||
    !Array.isArray(report.documents)
  ) {
    throw new Error('INVALID_CONVERSION_REPORT')
  }
  const byId = new Map()
  for (const audit of report.documents) {
    const id =
      typeof audit?.basename === 'string'
        ? basename(audit.basename, extname(audit.basename))
        : null
    if (!id || byId.has(id)) throw new Error('INVALID_CONVERSION_REPORT')
    byId.set(id, audit)
  }
  const expectedIds = new Set(shard.documents.map(({ id }) => id))
  if (
    byId.size !== shard.documents.length ||
    [...byId.keys()].some((id) => !expectedIds.has(id))
  ) {
    throw new Error('INVALID_CONVERSION_REPORT')
  }
  const artifacts = []
  const documents = []
  for (const source of shard.documents) {
    const audit = byId.get(source.id)
    if (!audit) {
      documents.push(
        failureDocument(
          source,
          source.contractIndex,
          profiles,
          'CONVERSION_DOCUMENT_MISSING',
        ),
      )
      continue
    }
    let outcome = auditOutcome(audit)
    const failureCodes = auditFailureCodes(audit)
    if (
      audit.readiness &&
      (audit.sha256 !== source.sha256 ||
        audit.byteLength !== source.byteLength ||
        audit.basename !== `${source.id}.pdf`)
    ) {
      documents.push(
        failureDocument(
          source,
          source.contractIndex,
          profiles,
          'CONVERSION_SOURCE_IDENTITY_MISMATCH',
        ),
      )
      continue
    }
    const exportRows = audit.exports ?? []
    const exportsByTarget = new Map(
      exportRows.map((artifact) => [artifact.target, artifact]),
    )
    if (
      exportsByTarget.size !== exportRows.length ||
      exportRows.some((artifact) => !profiles.includes(artifact.target))
    ) {
      throw new Error('INVALID_CONVERSION_REPORT')
    }
    const document = {
      contractIndex: source.contractIndex,
      id: source.id,
      source: {
        sha256: source.sha256,
        byteLength: source.byteLength,
      },
      outcome,
      failureCodes,
      audit,
      profiles: [],
    }
    for (const profile of profiles) {
      const artifact = exportsByTarget.get(profile)
      if (!artifact) {
        document.profiles.push(missingProfile(profile))
        continue
      }
      if (
        typeof artifact.basename !== 'string' ||
        artifact.basename.length === 0 ||
        basename(artifact.basename) !== artifact.basename
      ) {
        outcome = 'failed'
        if (!failureCodes.includes('CONVERSION_ARTIFACT_INVALID')) {
          failureCodes.push('CONVERSION_ARTIFACT_INVALID')
        }
        document.profiles.push(missingProfile(profile))
        continue
      }
      const directory = documentExportRelativeDirectory(
        document,
        shard.documents.length,
      )
      const relativePath = [directory, artifact.basename]
        .filter(Boolean)
        .join('/')
      let identity
      try {
        identity = await fileSha256(
          join(outputDirectory, ...relativePath.split('/')),
          MAX_EPUB_BYTES,
        )
      } catch {
        identity = null
      }
      if (
        !identity ||
        identity.sha256 !== artifact.sha256 ||
        identity.byteLength !== artifact.byteLength ||
        artifact.structuralValidation !== 'passed'
      ) {
        outcome = 'failed'
        if (!failureCodes.includes('CONVERSION_ARTIFACT_INVALID')) {
          failureCodes.push('CONVERSION_ARTIFACT_INVALID')
        }
        document.profiles.push(missingProfile(profile))
        continue
      }
      const publicArtifact = {
        target: profile,
        basename: artifact.basename,
        byteLength: artifact.byteLength,
        sha256: artifact.sha256,
        mode: artifact.mode,
        structuralValidation: artifact.structuralValidation,
        relativePath: `export/${relativePath}`,
      }
      document.profiles.push({
        id: profile,
        artifact: publicArtifact,
        validations: Object.fromEntries(
          VALIDATOR_IDS.map((validator) => [
            validator,
            validationResult('not-run', 'validation-pending'),
          ]),
        ),
      })
      artifacts.push({
        document,
        profile: document.profiles.at(-1),
        path: join(outputDirectory, ...relativePath.split('/')),
      })
    }
    document.outcome = outcome
    documents.push(document)
  }
  return { shard, outputDirectory, report, documents, artifacts }
}

function conversionCommandEvidence(configuration) {
  return {
    executable: 'node',
    arguments: [
      'tools/pdf-export.mjs',
      '<contract-shard-pdfs...>',
      ...configuration.profiles.flatMap((profile) => ['--target', profile]),
      '--ocr-engine',
      configuration.ocrEngine,
      '--document-visibility',
      configuration.documentVisibility,
      ...(configuration.ocrRemoteOptIn ? ['--ocr-remote-opt-in'] : []),
      ...(configuration.readableFallback ? ['--readable-fallback'] : []),
      '--concurrency',
      String(configuration.concurrency.exporterDocumentsPerShard),
      '--document-timeout-seconds',
      String(configuration.documentTimeoutSeconds),
      '--out',
      '<temporary-output>',
    ],
  }
}

async function convertShard({
  shard,
  configuration,
  scratchRoot,
  expectedProvenanceSha256,
  signal,
}) {
  const scratchDirectory = await mkdtemp(join(scratchRoot, `${shard.id}-`))
  const inputDirectory = join(scratchDirectory, 'input')
  const outputDirectory = join(scratchDirectory, 'export')
  await mkdir(inputDirectory, { mode: 0o700 })
  const stagedSources = []
  for (const source of shard.documents) {
    throwIfAborted(signal)
    const stagedPath = join(inputDirectory, `${source.id}.pdf`)
    await copyRegularFile(source.path, stagedPath)
    const stagedIdentity = await fileSha256(stagedPath)
    if (
      stagedIdentity.sha256 !== source.sha256 ||
      stagedIdentity.byteLength !== source.byteLength
    ) {
      throw new Error('SOURCE_CHANGED_DURING_STAGING')
    }
    stagedSources.push(stagedPath)
  }
  const arguments_ = [
    defaultExporterPath,
    ...stagedSources,
    ...configuration.profiles.flatMap((profile) => ['--target', profile]),
    '--ocr-engine',
    configuration.ocrEngine,
    '--document-visibility',
    configuration.documentVisibility,
    ...(configuration.ocrRemoteOptIn ? ['--ocr-remote-opt-in'] : []),
    ...(configuration.readableFallback ? ['--readable-fallback'] : []),
    '--concurrency',
    String(configuration.concurrency.exporterDocumentsPerShard),
    '--document-timeout-seconds',
    String(configuration.documentTimeoutSeconds),
    '--out',
    outputDirectory,
  ]
  const result = await runProcessTree(process.execPath, arguments_, {
    signal,
    timeoutMs:
      (configuration.documentTimeoutSeconds * shard.documents.length + 120) *
      1000,
    captureStderrBytes: MAX_CONVERSION_STDERR_EVIDENCE_BYTES,
  })
  const performanceEvidence = parseExporterPerformanceEvidence(
    result.stderr,
    shard.documents.map((document) => `${document.id}.pdf`),
    { truncated: result.stderrTruncated },
  )
  if (
    !result.timedOut &&
    !result.spawnError &&
    [0, 1].includes(result.exitCode)
  ) {
    try {
      const report = await readJson(join(outputDirectory, 'corpus-audit.json'))
      const normalized = await normalizeConversionState({
        shard,
        report,
        outputDirectory,
        profiles: configuration.profiles,
        expectedProvenanceSha256,
      })
      return {
        ...normalized,
        scratchDirectory,
        conversion: {
          status: 'completed',
          exitCode: result.exitCode,
          performanceEvidence,
        },
      }
    } catch {
      // A malformed or source-mismatched report becomes a bounded shard failure.
    }
  }
  const code = result.timedOut
    ? 'CONVERSION_SHARD_TIMEOUT'
    : 'CONVERSION_SHARD_FAILED'
  return {
    shard,
    scratchDirectory,
    outputDirectory: null,
    report: null,
    documents: shard.documents.map((source) =>
      failureDocument(
        source,
        source.contractIndex,
        configuration.profiles,
        code,
      ),
    ),
    artifacts: [],
    conversion: {
      status: 'failed',
      exitCode: result.exitCode,
      reason: result.timedOut ? 'timeout' : 'execution-failed',
      performanceEvidence,
    },
  }
}

export async function validateArtifact(
  task,
  tool,
  configuration,
  scratchRoot,
  signal,
) {
  if (!tool.invocation) {
    return validationResult('unavailable', `${task.validator}-unavailable`)
  }
  const scratchDirectory = await mkdtemp(
    join(scratchRoot, `${task.validator}-`),
  )
  try {
    const invocation = tool.invocation(task.artifact.path, scratchDirectory)
    const result = await runProcessTree(
      invocation.command,
      invocation.arguments,
      {
        signal,
        timeoutMs: configuration.validationTimeoutSeconds * 1000,
        environment: invocation.environment,
      },
    )
    if (!result.timedOut && !result.spawnError && result.exitCode === 0) {
      return validationResult('passed')
    }
    const reason =
      task.validator === 'ace'
        ? result.exitCode === 2
          ? 'accessibility-violations'
          : 'validator-execution-failed'
        : 'validation-failed'
    return validationResult('failed', result.timedOut ? 'timeout' : reason)
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true })
  }
}

async function runIndependentValidations({
  state,
  tools,
  configuration,
  scratchRoot,
  stages,
  signal,
}) {
  const artifacts = state.artifacts
  const externalTasks = artifacts.flatMap((artifact) => [
    { validator: 'epubcheck', artifact },
    { validator: 'ace', artifact },
  ])
  const externalResults = await Promise.all(
    externalTasks.map((task) =>
      stages.externalValidation(async () => ({
        task,
        result: await validateArtifact(
          task,
          tools[task.validator],
          configuration,
          scratchRoot,
          signal,
        ),
      })),
    ),
  )
  for (const { task, result } of externalResults) {
    task.artifact.profile.validations[task.validator] = result
  }

  const browserTasks = artifacts.map((artifact) => ({
    validator: 'chromiumSpineSmoke',
    artifact,
  }))
  const browserResults = await Promise.all(
    browserTasks.map((task) =>
      stages.chromiumSpineSmoke(async () => ({
        task,
        result: await validateArtifact(
          task,
          tools.chromiumSpineSmoke,
          configuration,
          scratchRoot,
          signal,
        ),
      })),
    ),
  )
  for (const { task, result } of browserResults) {
    task.artifact.profile.validations.chromiumSpineSmoke = result
  }
}

function shardArtifacts(documents) {
  return documents.flatMap((document) =>
    document.profiles.flatMap((profile) =>
      profile.artifact ? [profile.artifact] : [],
    ),
  )
}

export function createShardReceipt({ state, identity, evidence }) {
  const documents = structuredClone(state.documents)
  const summary = summarizeRegenerationDocuments(documents)
  return sealReceipt({
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    kind: 'pdf-corpus-regeneration-shard',
    status: summary.passed ? 'completed' : 'failed',
    identity,
    evidence: {
      ...evidence,
      conversionResult: deterministicConversionResult(state.conversion),
    },
    documents,
    summary,
    artifacts: shardArtifacts(documents),
  })
}

export async function publishOperationalObservation({
  runRoot,
  state,
  receipt,
}) {
  const shard = receipt?.identity?.shard
  const runIdentitySha256 = receipt?.identity?.runIdentitySha256
  if (
    typeof runRoot !== 'string' ||
    !shard ||
    typeof shard.id !== 'string' ||
    basename(shard.id) !== shard.id ||
    !shard.id.startsWith('shard-') ||
    !Number.isSafeInteger(shard.index) ||
    !SHA256.test(runIdentitySha256 ?? '') ||
    !SHA256.test(receipt?.receiptSha256 ?? '') ||
    state?.shard?.id !== shard.id ||
    state?.shard?.index !== shard.index ||
    !state?.conversion?.performanceEvidence
  ) {
    throw new Error('INVALID_OPERATIONAL_OBSERVATION')
  }
  const observation = sealOperationalObservation({
    schemaVersion: OPERATIONAL_OBSERVATION_SCHEMA_VERSION,
    kind: 'pdf-corpus-operational-observation',
    scope: 'operational-only',
    runIdentitySha256,
    shard: {
      id: shard.id,
      index: shard.index,
    },
    deterministicReceiptSha256: receipt.receiptSha256,
    performanceEvidence: state.conversion.performanceEvidence,
  })
  const directory = await operationalTelemetryDirectory(runRoot, shard.id)
  const basename_ = `observation-${observation.observationSha256}.json`
  const path = join(directory, basename_)
  try {
    await atomicJson(path, observation, { exclusive: true })
    return { observation, basename: basename_ }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    try {
      const existing = await readJson(path)
      if (
        canonicalJson(existing) === canonicalJson(observation) &&
        existing.observationSha256 ===
          canonicalSha256(operationalObservationPayload(existing))
      ) {
        return { observation: existing, basename: basename_ }
      }
    } catch {
      // A malformed or conflicting observation never replaces prior bytes.
    }
    throw new Error('OPERATIONAL_OBSERVATION_CONFLICT')
  }
}

export async function publishShard({ state, receipt, shardParent, signal }) {
  await mkdir(shardParent, { recursive: true, mode: 0o700 })
  const publication = await mkdtemp(join(shardParent, '.staging-'))
  let published = false
  try {
    if (state.outputDirectory) {
      await copyRegularTree(state.outputDirectory, join(publication, 'export'))
    } else {
      await mkdir(join(publication, 'export'), { mode: 0o700 })
    }
    throwIfAborted(signal)
    if (!(await verifyReceiptArtifacts(receipt, publication))) {
      throw new Error('PUBLISHED_ARTIFACT_VERIFICATION_FAILED')
    }
    await atomicJson(join(publication, 'receipt.json'), receipt)
    throwIfAborted(signal)
    const attemptName = shardAttemptName(receipt)
    const attempt = join(shardParent, attemptName)
    try {
      await rename(publication, attempt)
      published = true
      return { receipt, attempt: attemptName }
    } catch (error) {
      try {
        const existing = await readJson(join(attempt, 'receipt.json'))
        if (
          canonicalJson(existing) === canonicalJson(receipt) &&
          (await verifyReceiptArtifacts(existing, attempt))
        ) {
          return { receipt: existing, attempt: attemptName }
        }
      } catch {
        // The destination is absent, partial, malformed, or conflicting.
      }
      if (error?.code === 'ENOENT') throw error
      throw new Error('SHARD_RECEIPT_CONFLICT')
    }
  } finally {
    if (!published) {
      await rm(publication, { recursive: true, force: true })
    }
  }
}

export async function currentShardReceipt(shardParent, expectedIdentity) {
  let directory
  try {
    directory = await opendir(shardParent)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  const valid = []
  try {
    while (true) {
      const entry = await directory.read()
      if (entry === null) break
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !entry.name.startsWith('attempt-')
      ) {
        continue
      }
      const attemptRoot = join(shardParent, entry.name)
      try {
        const receipt = await readJson(join(attemptRoot, 'receipt.json'))
        if (
          entry.name === shardAttemptName(receipt) &&
          isCompletedShardReceiptCurrent(receipt, expectedIdentity) &&
          (await verifyReceiptArtifacts(receipt, attemptRoot))
        ) {
          valid.push({ receipt, attempt: entry.name })
        }
      } catch {
        // Old, partial, malformed, or mismatched attempts are never evidence.
      }
    }
  } finally {
    await directory.close()
  }
  if (valid.length === 0) return null
  const first = canonicalJson(valid[0].receipt)
  if (valid.some(({ receipt }) => canonicalJson(receipt) !== first)) {
    throw new Error('CONFLICTING_CURRENT_SHARD_RECEIPTS')
  }
  valid.sort((left, right) => left.attempt.localeCompare(right.attempt))
  return valid[0]
}

async function assertSourcesUnchanged(sources, signal) {
  for (const source of sources) {
    throwIfAborted(signal)
    const identity = await fileSha256(source.path)
    if (
      identity.sha256 !== source.sha256 ||
      identity.byteLength !== source.byteLength
    ) {
      throw new Error('SOURCE_CHANGED_DURING_RUN')
    }
  }
}

function installSignalHandlers(controller) {
  let received = null
  const handlers = new Map()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      if (received) return
      received = signal
      controller.abort(cancelledError(signal))
      for (const child of activeChildren) killProcessTree(child, 'SIGTERM')
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
  return {
    received: () => received,
    remove() {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler)
      }
    },
  }
}

export async function writeFinalReceipt(path, receipt) {
  try {
    const existing = await readJson(path)
    if (canonicalJson(existing) === canonicalJson(receipt)) {
      return existing
    }
    if (
      canonicalJson(existing?.identity) !== canonicalJson(receipt?.identity)
    ) {
      throw new Error('MERGED_RECEIPT_CONFLICT')
    }
    if (existing?.summary?.passed === true) {
      if (receipt?.summary?.passed === true) {
        throw new Error('MERGED_RECEIPT_CONFLICT')
      }
      return existing
    }
    if (receipt?.summary?.passed !== true) return existing
    await atomicJson(path, receipt)
    return receipt
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.message !== 'INVALID_JSON_FILE') {
      throw error
    }
    if (error?.message === 'INVALID_JSON_FILE') {
      throw new Error('MERGED_RECEIPT_CONFLICT')
    }
  }
  try {
    await atomicJson(path, receipt, { exclusive: true })
    return receipt
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = await readJson(path)
    if (canonicalJson(existing) === canonicalJson(receipt)) {
      return existing
    }
    if (
      canonicalJson(existing?.identity) !== canonicalJson(receipt?.identity)
    ) {
      throw new Error('MERGED_RECEIPT_CONFLICT')
    }
    if (existing?.summary?.passed === true) {
      if (receipt?.summary?.passed === true) {
        throw new Error('MERGED_RECEIPT_CONFLICT')
      }
      return existing
    }
    if (receipt?.summary?.passed !== true) return existing
    await atomicJson(path, receipt)
    return receipt
  }
}

async function orchestrate(parsed, signal) {
  const contract = await readJson(parsed.contractPath, 16 * 1024 * 1024)
  const contractValidation = validateCorpusContract(contract)
  const profiles =
    parsed.targets.length > 0 ? parsed.targets : [...contract.profiles]
  if (
    profiles.length === 0 ||
    profiles.some((profile) => !contract.profiles.includes(profile))
  ) {
    throw new Error('INVALID_TARGET_PROFILE')
  }
  const sources = await sourceDocuments(
    contract,
    parsed.corpusSet,
    parsed.sourceRoot,
  )
  const contractBinding = createCorpusContractBinding(
    contract,
    parsed.corpusSet,
    sources.map(({ id, byteLength, sha256 }) => ({
      id,
      byteLength,
      sha256,
    })),
  )
  const shards = partitionContractDocuments(sources, {
    shardCount: parsed.shardCount,
    shardSize: parsed.shardSize,
  })
  const outputRoot = await safeExternalOutputRoot(parsed.outputRoot)
  const toolchain = await captureToolchain()
  const configuration = {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    profiles,
    shardPlan: shards.map(({ id, startIndex, endIndexExclusive }) => ({
      id,
      startIndex,
      endIndexExclusive,
    })),
    concurrency: {
      conversionShards: parsed.conversionConcurrency,
      exporterDocumentsPerShard: EXPORTER_DOCUMENT_CONCURRENCY,
      maximumConcurrentDocuments:
        parsed.conversionConcurrency * EXPORTER_DOCUMENT_CONCURRENCY,
      externalValidators: parsed.externalValidationConcurrency,
      chromiumSpineSmokes: parsed.chromiumSpineSmokeConcurrency,
    },
    ocrEngine: parsed.ocrEngine,
    ocrRemoteOptIn: parsed.ocrRemoteOptIn,
    documentVisibility: parsed.documentVisibility,
    readableFallback: parsed.readableFallback,
    documentTimeoutSeconds: parsed.documentTimeoutSeconds,
    validationTimeoutSeconds: parsed.validationTimeoutSeconds,
  }
  const configurationSha256 = canonicalSha256(configuration)
  const runIdentity = {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    contract: {
      schemaVersion: contractBinding.schemaVersion,
      setKey: contractBinding.setKey,
      setId: contractBinding.setId,
      contractSha256: contractValidation.contractSha256,
      documentIdentitySha256: contractBinding.documentIdentitySha256,
    },
    toolchainSha256: toolchain.sha256,
    configurationSha256,
  }
  const runIdentitySha256 = canonicalSha256(runIdentity)
  const runRoot = join(outputRoot, `run-${runIdentitySha256.slice(0, 32)}`)
  await mkdir(join(runRoot, 'shards'), { recursive: true, mode: 0o700 })
  const evidence = {
    commands: {
      conversion: conversionCommandEvidence(configuration),
      validators: toolchain.evidence.validators,
    },
    versions: toolchain.evidence,
    configuration,
    concurrency: configuration.concurrency,
    sourceIdentity: {
      contractSha256: contractBinding.contractSha256,
      documentIdentitySha256: contractBinding.documentIdentitySha256,
      documents: contractBinding.documents,
    },
  }
  const shardIdentities = shards.map((shard) =>
    createShardIdentity({
      runIdentitySha256,
      contractBinding,
      shard,
      toolchainSha256: toolchain.sha256,
      configurationSha256,
    }),
  )
  const receipts = new Array(shards.length)
  const attempts = new Array(shards.length)
  const pending = []
  for (const shard of shards) {
    const current = await currentShardReceipt(
      join(runRoot, 'shards', shard.id),
      shardIdentities[shard.index],
    )
    if (current) {
      receipts[shard.index] = current.receipt
      attempts[shard.index] = current.attempt
    } else {
      pending.push(shard)
    }
  }

  const scratchRoot = await mkdtemp(join(tmpdir(), 'pdf-corpus-orchestrator-'))
  try {
    await runPipelinedQueue(
      pending,
      {
        conversionConcurrency: parsed.conversionConcurrency,
        externalValidationConcurrency: parsed.externalValidationConcurrency,
        chromiumSpineSmokeConcurrency: parsed.chromiumSpineSmokeConcurrency,
      },
      async (shard, _index, stages, pipelineSignal) => {
        let state
        try {
          state = await stages.conversion(() =>
            convertShard({
              shard,
              configuration,
              scratchRoot,
              expectedProvenanceSha256: toolchain.provenanceCapture.stateSha256,
              signal: pipelineSignal,
            }),
          )
          await runIndependentValidations({
            state,
            tools: toolchain.tools,
            configuration,
            scratchRoot,
            stages,
            signal: pipelineSignal,
          })
          await stages.checkpoint(async () => {
            await assertSourcesUnchanged(shard.documents, pipelineSignal)
            await assertToolchainUnchanged(toolchain)
          })
          throwIfAborted(pipelineSignal)
          const receipt = createShardReceipt({
            state,
            identity: shardIdentities[state.shard.index],
            evidence,
          })
          await publishOperationalObservation({
            runRoot,
            state,
            receipt,
          })
          const published = await publishShard({
            state,
            receipt,
            shardParent: join(runRoot, 'shards', state.shard.id),
            signal: pipelineSignal,
          })
          receipts[state.shard.index] = published.receipt
          attempts[state.shard.index] = published.attempt
          return published
        } finally {
          if (state?.scratchDirectory) {
            await rm(state.scratchDirectory, {
              recursive: true,
              force: true,
            })
          }
        }
      },
      { signal },
    )
  } finally {
    await rm(scratchRoot, { recursive: true, force: true })
  }
  if (
    receipts.length !== shards.length ||
    receipts.filter(Boolean).length !== shards.length ||
    attempts.filter(Boolean).length !== shards.length
  ) {
    throw new Error('INCOMPLETE_SHARD_RECEIPTS')
  }
  throwIfAborted(signal)
  await assertSourcesUnchanged(sources, signal)
  await assertToolchainUnchanged(toolchain)
  throwIfAborted(signal)
  const merged = mergeShardReceipts({
    contractDocuments: contractBinding.documents,
    receipts,
    attempts,
    profiles,
    identity: {
      ...runIdentity,
      runIdentitySha256,
    },
    evidence: {
      ...evidence,
    },
  })
  return await writeFinalReceipt(
    join(runRoot, 'corpus-regeneration-receipt.json'),
    merged,
  )
}

async function main() {
  let parsed
  try {
    parsed = parseArguments(process.argv.slice(2))
  } catch {
    process.stderr.write(USAGE)
    process.exitCode = 2
    return
  }
  if (parsed.help) {
    process.stdout.write(USAGE)
    return
  }
  const controller = new AbortController()
  const signals = installSignalHandlers(controller)
  try {
    const receipt = await orchestrate(parsed, controller.signal)
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
    if (!receipt.summary.passed) process.exitCode = 1
  } catch (error) {
    if (error?.code === 'ORCHESTRATOR_CANCELLED') {
      process.exitCode = 130
    } else {
      process.stderr.write(
        `PDF corpus regeneration failed without publishing private paths. Code: ${
          SAFE_CODE.test(error?.message ?? '')
            ? error.message
            : 'PDF_CORPUS_ORCHESTRATION_FAILED'
        }.\n`,
      )
      process.exitCode = 2
    }
  } finally {
    const received = signals.received()
    signals.remove()
    if (received) {
      try {
        process.kill(process.pid, received)
      } catch {
        // The portable fallback exit code remains 130.
      }
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}

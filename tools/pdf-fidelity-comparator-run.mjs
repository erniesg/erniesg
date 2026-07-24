#!/usr/bin/env node
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  canonicalJson,
  sha256,
  validatePdfFidelityEvalReceipt,
  validatePdfFidelityEvalSet,
  validatePdfFidelityPredictions,
} from './pdf-fidelity-eval.mjs'

export const PDF_FIDELITY_COMPARATOR_RUN_RECEIPT_SCHEMA_VERSION = '2.0.0'
export const PDF_FIDELITY_COMPARATOR_RUN_SPEC_SCHEMA_VERSION = '2.0.0'

const PRIVACY =
  'public-identities-hashes-performance-aggregates-no-source-content-or-local-paths'
const MAX_JSON_BYTES = 32 * 1024 * 1024
const MAX_BOUND_ARTIFACT_BYTES = 32 * 1024 * 1024
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/
const SHA256 = /^[a-f0-9]{64}$/
const COMPARATOR_SCHEMA_PATH =
  'docs/schemas/pdf-fidelity-comparator-run-receipt-v2.schema.json'
const COMPARATOR_CONTRACT_SCHEMA_PATH =
  'docs/schemas/pdf-fidelity-comparator-contract-v2.schema.json'
const COMPARATOR_CONTRACT_SCHEMA_SHA256 =
  'c1b31d5fa9e0fe174dca51a7945093d4d90b5cee0332d4955b7bfd019ae6f185'
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GOVERNANCE_SCHEMA_PATHS = {
  '1.0.0': 'docs/schemas/pdf-reconstruction-eval-contract.schema.json',
  '2.0.0': 'docs/schemas/pdf-reconstruction-eval-contract-v2.schema.json',
}

function invalid(code = 'INVALID_PDF_FIDELITY_COMPARATOR_RUN') {
  throw new Error(code)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  )
}

function canonicalHash(value) {
  return sha256(canonicalJson(value))
}

function parseJsonArtifact(bytes) {
  const value =
    typeof bytes === 'string'
      ? Buffer.from(bytes)
      : bytes instanceof Uint8Array
        ? Buffer.from(bytes)
        : null
  if (!value || value.byteLength === 0 || value.byteLength > MAX_JSON_BYTES) {
    invalid()
  }
  try {
    return {
      value: JSON.parse(value.toString('utf8')),
      fileSha256: sha256(value),
    }
  } catch {
    invalid()
  }
}

async function readSchema(path) {
  return parseJsonArtifact(await readRepositoryArtifact(path))
}

async function readRepositoryArtifact(repositoryPath) {
  if (
    typeof repositoryPath !== 'string' ||
    repositoryPath.startsWith('/') ||
    repositoryPath.includes('\\') ||
    repositoryPath.split('/').includes('..')
  ) {
    invalid()
  }
  const root = await realpath(REPOSITORY_ROOT)
  const candidate = resolve(root, repositoryPath)
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) invalid()
  try {
    const details = await lstat(candidate)
    const canonical = await realpath(candidate)
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.size <= 0 ||
      details.size > MAX_JSON_BYTES ||
      (canonical !== root && !canonical.startsWith(`${root}${sep}`))
    ) {
      invalid()
    }
    const bytes = await readFile(canonical)
    if (bytes.byteLength !== details.size) invalid()
    return bytes
  } catch {
    invalid()
  }
}

function compileSchema(schema) {
  try {
    return new Ajv2020({ strict: false }).compile(schema)
  } catch {
    invalid()
  }
}

function contractEvalBinding(contract) {
  if (contract.schemaVersion === '1.0.0') return contract.fidelityEval
  if (contract.schemaVersion === '2.0.0') return contract.additiveFidelityEval
  invalid()
}

function validClaimedComponent(value) {
  return (
    exactKeys(value, [
      'id',
      'version',
      'artifactSha256',
      'identityAuthority',
      'boundArtifactSha256',
    ]) &&
    SAFE_ID.test(value.id) &&
    SAFE_ID.test(value.version) &&
    (value.artifactSha256 === null || SHA256.test(value.artifactSha256)) &&
    ['run-spec-self-asserted', 'caller-bound-unverified-artifact'].includes(
      value.identityAuthority,
    ) &&
    (value.identityAuthority === 'run-spec-self-asserted'
      ? value.boundArtifactSha256 === null
      : SHA256.test(value.boundArtifactSha256))
  )
}

function validAdapter(value) {
  return (
    exactKeys(value, ['id', 'version', 'sourceSha256', 'identityAuthority']) &&
    SAFE_ID.test(value.id) &&
    SAFE_ID.test(value.version) &&
    SHA256.test(value.sourceSha256) &&
    value.identityAuthority === 'predictions-self-reported'
  )
}

function validNetworkIsolation(value) {
  return (
    exactKeys(value, ['status', 'authority', 'boundArtifactSha256']) &&
    [
      'none',
      'cooperative-offline-flags',
      'caller-claimed-isolated-unverified',
    ].includes(value.status) &&
    ['run-spec-self-asserted', 'caller-bound-unverified-artifact'].includes(
      value.authority,
    ) &&
    (value.authority === 'run-spec-self-asserted'
      ? value.boundArtifactSha256 === null &&
        value.status !== 'caller-claimed-isolated-unverified'
      : SHA256.test(value.boundArtifactSha256))
  )
}

function artifactBytes(value) {
  const bytes =
    typeof value === 'string'
      ? Buffer.from(value)
      : value instanceof Uint8Array
        ? Buffer.from(value)
        : null
  if (
    bytes === null ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_BOUND_ARTIFACT_BYTES
  ) {
    invalid()
  }
  return bytes
}

function assertArtifactBinding(expectedSha256, value) {
  const bytes = artifactBytes(value)
  if (!SHA256.test(expectedSha256) || sha256(bytes) !== expectedSha256) {
    invalid()
  }
}

function assertOptionalBoundArtifact(authority, expectedSha256, value) {
  if (authority === 'run-spec-self-asserted') {
    if (expectedSha256 !== null || value !== undefined) invalid()
    return
  }
  if (authority !== 'caller-bound-unverified-artifact') invalid()
  assertArtifactBinding(expectedSha256, value)
}

function validEvidence(value) {
  return (
    ['run-spec-self-asserted', 'caller-bound-unverified-artifact'].includes(
      value?.evidenceAuthority,
    ) &&
    (value.evidenceAuthority === 'run-spec-self-asserted'
      ? value.evidenceSha256 === null
      : SHA256.test(value.evidenceSha256))
  )
}

function assertOptionalEvidenceArtifact(evidence, value) {
  if (evidence.evidenceAuthority === 'run-spec-self-asserted') {
    if (evidence.evidenceSha256 !== null || value !== undefined) invalid()
    return
  }
  if (evidence.evidenceAuthority !== 'caller-bound-unverified-artifact') {
    invalid()
  }
  assertArtifactBinding(evidence.evidenceSha256, value)
}

async function assertContractBinding(
  contractArtifact,
  evalSetArtifact,
  evalIdentity,
  comparatorSchemaArtifact,
) {
  const comparatorContractSchemaArtifact = await readSchema(
    COMPARATOR_CONTRACT_SCHEMA_PATH,
  )
  if (
    comparatorContractSchemaArtifact.fileSha256 !==
    COMPARATOR_CONTRACT_SCHEMA_SHA256
  ) {
    invalid()
  }
  const validateComparatorContract = compileSchema(
    comparatorContractSchemaArtifact.value,
  )
  if (!validateComparatorContract(contractArtifact.value)) invalid()
  if (
    contractArtifact.value.receiptSchema.path !== COMPARATOR_SCHEMA_PATH ||
    contractArtifact.value.receiptSchema.fileSha256 !==
      comparatorSchemaArtifact.fileSha256 ||
    contractArtifact.value.runSpecificationSchemaVersion !==
      PDF_FIDELITY_COMPARATOR_RUN_SPEC_SCHEMA_VERSION ||
    contractArtifact.value.authority !==
      'performance-provenance-sidecar-never-promotion-authority'
  ) {
    invalid()
  }

  const candidates = contractArtifact.value.evaluationBindings.filter(
    (candidate) =>
      candidate.evalSet.id === evalIdentity.id &&
      candidate.evalSet.fileSha256 === evalSetArtifact.fileSha256 &&
      candidate.evalSet.evalSetSha256 === evalIdentity.evalSetSha256 &&
      candidate.evalSet.documentIdentitySha256 ===
        evalIdentity.documentIdentitySha256 &&
      candidate.evalSet.caseIdentitySha256 ===
        evalIdentity.caseIdentitySha256 &&
      candidate.evalSet.documentCount === evalIdentity.documentCount &&
      candidate.evalSet.caseCount === evalIdentity.caseCount &&
      candidate.evalSet.stratumCount === evalIdentity.stratumCount,
  )
  if (candidates.length !== 1) invalid()
  const comparatorBinding = candidates[0]
  const repositoryEvalSetArtifact = parseJsonArtifact(
    await readRepositoryArtifact(comparatorBinding.evalSet.path),
  )
  if (
    repositoryEvalSetArtifact.fileSha256 !== evalSetArtifact.fileSha256 ||
    canonicalJson(repositoryEvalSetArtifact.value) !==
      canonicalJson(evalSetArtifact.value)
  ) {
    invalid()
  }

  const governanceArtifact = parseJsonArtifact(
    await readRepositoryArtifact(comparatorBinding.governance.path),
  )
  if (
    governanceArtifact.fileSha256 !== comparatorBinding.governance.fileSha256 ||
    governanceArtifact.value.id !== comparatorBinding.governance.id ||
    governanceArtifact.value.schemaVersion !==
      comparatorBinding.governance.schemaVersion
  ) {
    invalid()
  }
  const governanceSchemaPath =
    GOVERNANCE_SCHEMA_PATHS[governanceArtifact.value.schemaVersion]
  if (!governanceSchemaPath) invalid()
  const governanceSchemaArtifact = await readSchema(governanceSchemaPath)
  const validateGovernance = compileSchema(governanceSchemaArtifact.value)
  if (!validateGovernance(governanceArtifact.value)) invalid()

  const binding = contractEvalBinding(governanceArtifact.value)
  if (
    binding.artifact.fileSha256 !== evalSetArtifact.fileSha256 ||
    binding.id !== evalIdentity.id ||
    binding.evalSetSha256 !== evalIdentity.evalSetSha256 ||
    binding.documentIdentitySha256 !== evalIdentity.documentIdentitySha256 ||
    binding.caseIdentitySha256 !== evalIdentity.caseIdentitySha256 ||
    binding.documentCount !== evalIdentity.documentCount ||
    binding.caseCount !== evalIdentity.caseCount ||
    binding.stratumCount !== evalIdentity.stratumCount
  ) {
    invalid()
  }
}

function assertRunSpecification(run, predictions, evalIdentity, artifacts) {
  if (
    !exactKeys(run, [
      'schemaVersion',
      'candidate',
      'execution',
      'latency',
      'cost',
    ]) ||
    run.schemaVersion !== PDF_FIDELITY_COMPARATOR_RUN_SPEC_SCHEMA_VERSION ||
    !exactKeys(run.candidate, [
      'id',
      'version',
      'provider',
      'model',
      'adapter',
      'promptSha256',
      'configSha256',
      'seedSha256',
    ]) ||
    run.candidate.id !== predictions.candidate.id ||
    run.candidate.version !== predictions.candidate.version ||
    !SAFE_ID.test(run.candidate.id) ||
    !SAFE_ID.test(run.candidate.version) ||
    !validClaimedComponent(run.candidate.provider) ||
    !validClaimedComponent(run.candidate.model) ||
    !validAdapter(run.candidate.adapter) ||
    !SHA256.test(run.candidate.promptSha256) ||
    !SHA256.test(run.candidate.configSha256) ||
    !SHA256.test(run.candidate.seedSha256) ||
    predictions.candidate.adapterSha256 === null ||
    run.candidate.adapter?.sourceSha256 !==
      predictions.candidate.adapterSha256 ||
    !exactKeys(run.execution, [
      'lane',
      'platform',
      'architecture',
      'accelerator',
      'networkIsolation',
      'repeatCount',
      'warmupCount',
    ]) ||
    !SAFE_ID.test(run.execution.lane) ||
    !SAFE_ID.test(run.execution.platform) ||
    !SAFE_ID.test(run.execution.architecture) ||
    !(
      run.execution.accelerator === null ||
      SAFE_ID.test(run.execution.accelerator)
    ) ||
    !validNetworkIsolation(run.execution.networkIsolation) ||
    !Number.isSafeInteger(run.execution.repeatCount) ||
    run.execution.repeatCount < 1 ||
    !Number.isSafeInteger(run.execution.warmupCount) ||
    run.execution.warmupCount < 0 ||
    !exactKeys(run.latency, [
      'scope',
      'samplesMs',
      'evidenceAuthority',
      'evidenceSha256',
    ]) ||
    !validEvidence(run.latency) ||
    !Array.isArray(run.latency.samplesMs) ||
    run.latency.samplesMs.length !==
      evalIdentity.documentCount * run.execution.repeatCount ||
    run.latency.samplesMs.some(
      (sample) =>
        typeof sample !== 'number' || !Number.isFinite(sample) || sample < 0,
    ) ||
    !exactKeys(run.cost, [
      'currency',
      'amount',
      'basis',
      'inputTokens',
      'outputTokens',
      'evidenceAuthority',
      'evidenceSha256',
    ]) ||
    !validEvidence(run.cost)
  ) {
    invalid()
  }

  assertArtifactBinding(
    run.candidate.promptSha256,
    artifacts.promptArtifactBytes,
  )
  assertArtifactBinding(
    run.candidate.configSha256,
    artifacts.configArtifactBytes,
  )
  assertArtifactBinding(run.candidate.seedSha256, artifacts.seedArtifactBytes)
  assertOptionalBoundArtifact(
    run.candidate.provider.identityAuthority,
    run.candidate.provider.boundArtifactSha256,
    artifacts.providerIdentityArtifactBytes,
  )
  assertOptionalBoundArtifact(
    run.candidate.model.identityAuthority,
    run.candidate.model.boundArtifactSha256,
    artifacts.modelIdentityArtifactBytes,
  )
  assertOptionalBoundArtifact(
    run.execution.networkIsolation.authority,
    run.execution.networkIsolation.boundArtifactSha256,
    artifacts.networkClaimArtifactBytes,
  )
  assertOptionalEvidenceArtifact(run.latency, artifacts.latencyEvidenceBytes)
  assertOptionalEvidenceArtifact(run.cost, artifacts.costEvidenceBytes)

  const runtimeModel = predictions.candidate.runtimeIdentity.model
  if (
    runtimeModel &&
    (run.candidate.model?.id !== runtimeModel.id ||
      run.candidate.model?.artifactSha256 !== runtimeModel.sha256)
  ) {
    invalid()
  }
}

function rounded(value) {
  return Math.round(value * 100_000_000) / 100_000_000
}

function percentile(sortedSamples, percentileValue) {
  const index = Math.max(
    0,
    Math.ceil((percentileValue / 100) * sortedSamples.length) - 1,
  )
  return rounded(sortedSamples[index])
}

export function deriveComparatorLatency(samplesMs, scope, evidence) {
  if (
    !Array.isArray(samplesMs) ||
    samplesMs.length === 0 ||
    samplesMs.some(
      (sample) =>
        typeof sample !== 'number' || !Number.isFinite(sample) || sample < 0,
    )
  ) {
    invalid()
  }
  const sortedSamples = [...samplesMs].sort((left, right) => left - right)
  const totalMs = rounded(
    samplesMs.reduce((total, sample) => total + sample, 0),
  )
  return {
    scope,
    sampleCount: samplesMs.length,
    p50Ms: percentile(sortedSamples, 50),
    p95Ms: percentile(sortedSamples, 95),
    meanMs: rounded(totalMs / samplesMs.length),
    totalMs,
    evidenceAuthority: evidence.evidenceAuthority,
    evidenceSha256: evidence.evidenceSha256,
  }
}

function createRunInputIdentity({
  contractArtifact,
  evalIdentity,
  accuracyReceipt,
  run,
}) {
  return canonicalHash({
    schemaVersion: PDF_FIDELITY_COMPARATOR_RUN_SPEC_SCHEMA_VERSION,
    contractSha256: contractArtifact.fileSha256,
    evalSetSha256: evalIdentity.evalSetSha256,
    documentIdentitySha256: evalIdentity.documentIdentitySha256,
    caseIdentitySha256: evalIdentity.caseIdentitySha256,
    predictionSha256: accuracyReceipt.predictionSha256,
    accuracyReceiptSha256: accuracyReceipt.receiptSha256,
    runSpecificationSha256: canonicalHash(run),
  })
}

async function deriveReceipt(artifacts) {
  const contractArtifact = parseJsonArtifact(artifacts.contractBytes)
  const evalSetArtifact = parseJsonArtifact(artifacts.evalSetBytes)
  const predictionsArtifact = parseJsonArtifact(artifacts.predictionsBytes)
  const accuracyReceiptArtifact = parseJsonArtifact(
    artifacts.accuracyReceiptBytes,
  )
  const runArtifact = parseJsonArtifact(artifacts.runBytes)
  const comparatorSchemaArtifact = await readSchema(COMPARATOR_SCHEMA_PATH)

  const evalIdentity = validatePdfFidelityEvalSet(evalSetArtifact.value)
  validatePdfFidelityPredictions(
    predictionsArtifact.value,
    evalSetArtifact.value,
  )
  validatePdfFidelityEvalReceipt(
    accuracyReceiptArtifact.value,
    evalSetArtifact.value,
    predictionsArtifact.value,
  )
  await assertContractBinding(
    contractArtifact,
    evalSetArtifact,
    evalIdentity,
    comparatorSchemaArtifact,
  )
  assertRunSpecification(
    runArtifact.value,
    predictionsArtifact.value,
    evalIdentity,
    artifacts,
  )

  const run = runArtifact.value
  const accuracyReceipt = accuracyReceiptArtifact.value
  const receiptWithoutHash = {
    schemaVersion: PDF_FIDELITY_COMPARATOR_RUN_RECEIPT_SCHEMA_VERSION,
    privacy: PRIVACY,
    contract: {
      id: contractArtifact.value.id,
      sha256: contractArtifact.fileSha256,
    },
    evalSet: {
      id: evalSetArtifact.value.id,
      sha256: evalIdentity.evalSetSha256,
      documentIdentitySha256: evalIdentity.documentIdentitySha256,
      caseIdentitySha256: evalIdentity.caseIdentitySha256,
    },
    candidate: {
      ...structuredClone(run.candidate),
      runtimeIdentity: structuredClone(
        predictionsArtifact.value.candidate.runtimeIdentity,
      ),
      runtimeIdentityAuthority:
        predictionsArtifact.value.candidate.runtimeIdentity.status ===
        'not-applicable'
          ? 'not-applicable'
          : 'predictions-self-reported',
    },
    execution: {
      ...structuredClone(run.execution),
      inputIdentitySha256: createRunInputIdentity({
        contractArtifact,
        evalIdentity,
        accuracyReceipt,
        run,
      }),
    },
    latency: deriveComparatorLatency(run.latency.samplesMs, run.latency.scope, {
      evidenceAuthority: run.latency.evidenceAuthority,
      evidenceSha256: run.latency.evidenceSha256,
    }),
    cost: structuredClone(run.cost),
    accuracyReceiptSha256: accuracyReceipt.receiptSha256,
    promotionEligible: false,
  }
  const receipt = {
    ...receiptWithoutHash,
    receiptSha256: canonicalHash(receiptWithoutHash),
  }
  const validateReceiptSchema = compileSchema(comparatorSchemaArtifact.value)
  if (!validateReceiptSchema(receipt)) invalid()
  return receipt
}

export async function createPdfFidelityComparatorRunReceipt(artifacts) {
  try {
    return await deriveReceipt(artifacts)
  } catch {
    invalid()
  }
}

export async function validatePdfFidelityComparatorRunReceipt(
  receiptBytes,
  artifacts,
) {
  try {
    const receiptArtifact = parseJsonArtifact(receiptBytes)
    const expected = await deriveReceipt(artifacts)
    if (
      canonicalJson(receiptArtifact.value) !== canonicalJson(expected) ||
      receiptArtifact.value.promotionEligible !== false
    ) {
      invalid()
    }
    return {
      valid: true,
      receiptSha256: expected.receiptSha256,
    }
  } catch {
    invalid()
  }
}

function valueAfter(arguments_, index) {
  const value = arguments_[index + 1]
  if (!value || value.startsWith('--')) invalid('INVALID_USAGE')
  return value
}

function parseNamedArguments(arguments_) {
  const values = {}
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (!argument.startsWith('--')) invalid('INVALID_USAGE')
    const equals = argument.indexOf('=')
    const key = argument.slice(2, equals < 0 ? undefined : equals)
    const value =
      equals < 0 ? valueAfter(arguments_, index) : argument.slice(equals + 1)
    if (equals < 0) index += 1
    if (!key || !value || Object.hasOwn(values, key)) {
      invalid('INVALID_USAGE')
    }
    values[key] = value
  }
  return values
}

async function readRegularInputFile(path, maximumBytes) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1
  ) {
    invalid()
  }
  const candidate = resolve(path)
  let handle
  try {
    const beforeOpen = await lstat(candidate)
    if (
      !beforeOpen.isFile() ||
      beforeOpen.isSymbolicLink() ||
      beforeOpen.size <= 0 ||
      beforeOpen.size > maximumBytes
    ) {
      invalid()
    }
    handle = await open(
      candidate,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    )
    const afterOpen = await handle.stat()
    if (
      !afterOpen.isFile() ||
      afterOpen.size !== beforeOpen.size ||
      afterOpen.dev !== beforeOpen.dev ||
      afterOpen.ino !== beforeOpen.ino ||
      afterOpen.size <= 0 ||
      afterOpen.size > maximumBytes
    ) {
      invalid()
    }
    const bytes = await handle.readFile()
    if (bytes.byteLength !== afterOpen.size) invalid()
    return bytes
  } catch {
    invalid()
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function readInputArtifacts(values) {
  const [
    contractBytes,
    evalSetBytes,
    predictionsBytes,
    accuracyReceiptBytes,
    runBytes,
    promptArtifactBytes,
    configArtifactBytes,
    seedArtifactBytes,
  ] = await Promise.all([
    readRegularInputFile(values.contract, MAX_JSON_BYTES),
    readRegularInputFile(values['eval-set'], MAX_JSON_BYTES),
    readRegularInputFile(values.predictions, MAX_JSON_BYTES),
    readRegularInputFile(values['accuracy-receipt'], MAX_JSON_BYTES),
    readRegularInputFile(values.run, MAX_JSON_BYTES),
    readRegularInputFile(values['prompt-artifact'], MAX_BOUND_ARTIFACT_BYTES),
    readRegularInputFile(values['config-artifact'], MAX_BOUND_ARTIFACT_BYTES),
    readRegularInputFile(values['seed-artifact'], MAX_BOUND_ARTIFACT_BYTES),
  ])
  const artifacts = {
    contractBytes,
    evalSetBytes,
    predictionsBytes,
    accuracyReceiptBytes,
    runBytes,
    promptArtifactBytes,
    configArtifactBytes,
    seedArtifactBytes,
  }
  for (const [argument, field] of [
    ['provider-identity-artifact', 'providerIdentityArtifactBytes'],
    ['model-identity-artifact', 'modelIdentityArtifactBytes'],
    ['network-claim-artifact', 'networkClaimArtifactBytes'],
    ['latency-evidence', 'latencyEvidenceBytes'],
    ['cost-evidence', 'costEvidenceBytes'],
  ]) {
    if (values[argument]) {
      artifacts[field] = await readRegularInputFile(
        values[argument],
        MAX_BOUND_ARTIFACT_BYTES,
      )
    }
  }
  return artifacts
}

const REQUIRED_INPUT_ARGUMENTS = [
  'contract',
  'eval-set',
  'predictions',
  'accuracy-receipt',
  'run',
  'prompt-artifact',
  'config-artifact',
  'seed-artifact',
]
const OPTIONAL_EVIDENCE_ARGUMENTS = [
  'provider-identity-artifact',
  'model-identity-artifact',
  'network-claim-artifact',
  'latency-evidence',
  'cost-evidence',
]

function assertArgumentKeys(values, commandArgument) {
  const required = [...REQUIRED_INPUT_ARGUMENTS, commandArgument]
  const allowed = new Set([...required, ...OPTIONAL_EVIDENCE_ARGUMENTS])
  if (
    required.some((key) => !Object.hasOwn(values, key)) ||
    Object.keys(values).some((key) => !allowed.has(key))
  ) {
    invalid('INVALID_USAGE')
  }
}

async function buildCommand(arguments_) {
  const values = parseNamedArguments(arguments_)
  assertArgumentKeys(values, 'out')
  const artifacts = await readInputArtifacts(values)
  const receipt = await createPdfFidelityComparatorRunReceipt(artifacts)
  await writeFile(
    resolve(values.out),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  )
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

async function validateCommand(arguments_) {
  const values = parseNamedArguments(arguments_)
  assertArgumentKeys(values, 'receipt')
  const [artifacts, receiptBytes] = await Promise.all([
    readInputArtifacts(values),
    readRegularInputFile(values.receipt, MAX_JSON_BYTES),
  ])
  const result = await validatePdfFidelityComparatorRunReceipt(
    receiptBytes,
    artifacts,
  )
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function usage() {
  return (
    [
      'Usage:',
      '  node tools/pdf-fidelity-comparator-run.mjs build --contract <comparator-governance.json> --eval-set <eval-set.json> --predictions <predictions.json> --accuracy-receipt <accuracy-receipt.json> --run <run-spec.json> --prompt-artifact <bytes> --config-artifact <bytes> --seed-artifact <bytes> [--provider-identity-artifact <unverified-bytes>] [--model-identity-artifact <unverified-bytes>] [--network-claim-artifact <unverified-bytes>] [--latency-evidence <unverified-bytes>] [--cost-evidence <unverified-bytes>] --out <new-receipt.json>',
      '  node tools/pdf-fidelity-comparator-run.mjs validate --contract <comparator-governance.json> --eval-set <eval-set.json> --predictions <predictions.json> --accuracy-receipt <accuracy-receipt.json> --run <run-spec.json> --prompt-artifact <bytes> --config-artifact <bytes> --seed-artifact <bytes> [--provider-identity-artifact <unverified-bytes>] [--model-identity-artifact <unverified-bytes>] [--network-claim-artifact <unverified-bytes>] [--latency-evidence <unverified-bytes>] [--cost-evidence <unverified-bytes>] --receipt <receipt.json>',
    ].join('\n') + '\n'
  )
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2)
  if (command === 'build') return buildCommand(arguments_)
  if (command === 'validate') return validateCommand(arguments_)
  process.stderr.write(usage())
  process.exitCode = 2
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const code = /^[A-Z][A-Z0-9_]{0,127}$/.test(error?.message ?? '')
      ? error.message
      : 'PDF_FIDELITY_COMPARATOR_RUN_FAILED'
    process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`)
    process.exitCode = 2
  })
}

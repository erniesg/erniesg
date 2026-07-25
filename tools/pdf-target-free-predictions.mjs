#!/usr/bin/env node
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAdapterSourceIdentity } from './adapter-source-identity.mjs'
import {
  canonicalJson,
  goldStripAdapterCases,
  isNormalizedPdfBox,
  restoreGoldStrippedAdapterPredictions,
  sha256,
  validatePdfFidelityEvalSet,
  validatePdfFidelityPredictions,
} from './pdf-fidelity-eval.mjs'
import {
  observePdfTargetFreeCandidateExecutableIdentity,
  publicAdapterIdentifier,
  sanitizeAdapterRuntimeIdentity,
  validatePdfTargetFreeCandidateReceipt,
  validatePdfTargetFreeCandidateRetainedOutputs,
} from './pdf-target-free-candidate-run.mjs'

export const PDF_TARGET_FREE_DOCUMENT_OBSERVATIONS_SCHEMA_VERSION = '1.0.0'
export const PDF_TARGET_FREE_PREDICTION_BRIDGE_VERSION = '1.0.0'

const OBSERVATION_FORMAT = 'pdf-document-observations'
const PREDICTION_FORMAT = 'target-free-observation-bridge'
const MAX_JSON_BYTES = 128 * 1024 * 1024
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const SAFE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const MINIMUM_BINDING_SCORE_MARGIN = 0.05
const BRIDGE_PATH = fileURLToPath(import.meta.url)

function invalid(code = 'INVALID_PDF_TARGET_FREE_PREDICTION_BRIDGE') {
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

function uniqueBy(values, selector) {
  return new Set(values.map(selector)).size === values.length
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function publicAdapterIdentifierMatches(publicValue, rawValue) {
  return (
    publicValue === rawValue ||
    publicValue === publicAdapterIdentifier(rawValue)
  )
}

export function validateTargetFreeDocumentObservations(
  value,
  pageCount = null,
) {
  try {
    if (
      !exactKeys(value, [
        'schemaVersion',
        'objects',
        'readingOrder',
        'relationships',
      ]) ||
      value.schemaVersion !==
        PDF_TARGET_FREE_DOCUMENT_OBSERVATIONS_SCHEMA_VERSION ||
      !Array.isArray(value.objects) ||
      !Array.isArray(value.readingOrder) ||
      !Array.isArray(value.relationships) ||
      !uniqueBy(value.objects, ({ id }) => id) ||
      !uniqueBy(value.readingOrder, (id) => id) ||
      !uniqueBy(value.relationships, canonicalJson)
    ) {
      invalid('INVALID_PDF_TARGET_FREE_DOCUMENT_OBSERVATIONS')
    }
    const objectIds = new Set()
    for (const object of value.objects) {
      if (
        !exactKeys(object, ['id', 'page', 'kind', 'label', 'box']) ||
        !SAFE_ID.test(object.id ?? '') ||
        !Number.isSafeInteger(object.page) ||
        object.page < 1 ||
        (pageCount !== null && object.page > pageCount) ||
        !SAFE_ID.test(object.kind ?? '') ||
        !SAFE_ID.test(object.label ?? '') ||
        !isNormalizedPdfBox(object.box)
      ) {
        invalid('INVALID_PDF_TARGET_FREE_DOCUMENT_OBSERVATIONS')
      }
      objectIds.add(object.id)
    }
    if (
      value.readingOrder.length !== objectIds.size ||
      value.readingOrder.some((id) => !objectIds.has(id))
    ) {
      invalid('INVALID_PDF_TARGET_FREE_DOCUMENT_OBSERVATIONS')
    }
    for (const relationship of value.relationships) {
      if (
        !exactKeys(relationship, ['type', 'sourceId', 'targetId']) ||
        !SAFE_ID.test(relationship.type ?? '') ||
        !objectIds.has(relationship.sourceId) ||
        !objectIds.has(relationship.targetId) ||
        relationship.sourceId === relationship.targetId
      ) {
        invalid('INVALID_PDF_TARGET_FREE_DOCUMENT_OBSERVATIONS')
      }
    }
    return { valid: true, objectCount: objectIds.size }
  } catch {
    invalid('INVALID_PDF_TARGET_FREE_DOCUMENT_OBSERVATIONS')
  }
}

function intersectionArea(left, right) {
  const x0 = Math.max(left[0], right[0])
  const y0 = Math.max(left[1], right[1])
  const x1 = Math.min(left[0] + left[2], right[0] + right[2])
  const y1 = Math.min(left[1] + left[3], right[1] + right[3])
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
}

function area(box) {
  return box[2] * box[3]
}

function matchTargets(item, observations) {
  const pairsByTarget = new Map()
  for (const target of item.targets) {
    if (!isNormalizedPdfBox(target.box)) continue
    const page = target.sourcePage ?? item.page
    for (const object of observations.objects) {
      if (object.page !== page) continue
      const intersection = intersectionArea(target.box, object.box)
      const targetCoverage = intersection / area(target.box)
      if (targetCoverage < 0.15) continue
      const union = area(target.box) + area(object.box) - intersection
      const iou = union === 0 ? 0 : intersection / union
      const objectCoverage = intersection / area(object.box)
      const pair = {
        target,
        object,
        targetCoverage,
        iou,
        objectCoverage,
        bindingScore: targetCoverage * 0.7 + iou * 0.2 + objectCoverage * 0.1,
      }
      const pairs = pairsByTarget.get(target.id) ?? []
      pairs.push(pair)
      pairsByTarget.set(target.id, pairs)
    }
  }
  const proposed = new Map()
  for (const targetId of [...pairsByTarget.keys()].sort()) {
    const pairs = pairsByTarget
      .get(targetId)
      .sort(
        (left, right) =>
          right.bindingScore - left.bindingScore ||
          left.object.id.localeCompare(right.object.id),
      )
    if (
      pairs.length > 1 &&
      pairs[0].bindingScore - pairs[1].bindingScore <
        MINIMUM_BINDING_SCORE_MARGIN
    ) {
      continue
    }
    proposed.set(targetId, pairs[0].object)
  }
  const objectUseCounts = new Map()
  for (const object of proposed.values()) {
    objectUseCounts.set(object.id, (objectUseCounts.get(object.id) ?? 0) + 1)
  }
  return new Map(
    [...proposed].filter(([, object]) => objectUseCounts.get(object.id) === 1),
  )
}

function normalizedCaseOutput(item, observations) {
  if (item.task === 'detection') {
    return {
      objects: observations.objects
        .filter(({ page }) => page === item.page)
        .map((object) => ({
          id: object.id,
          label: object.kind,
          box: [...object.box],
        })),
    }
  }

  const targets = matchTargets(item, observations)
  if (item.task === 'classification') {
    return {
      labels: item.targets.flatMap((target) => {
        const object = targets.get(target.id)
        return object ? [{ targetId: target.id, label: object.label }] : []
      }),
    }
  }
  if (item.task === 'reading-order') {
    const orderIndex = new Map(
      observations.readingOrder.map((id, index) => [id, index]),
    )
    return {
      order: [...targets]
        .sort(
          ([leftTarget, leftObject], [rightTarget, rightObject]) =>
            orderIndex.get(leftObject.id) - orderIndex.get(rightObject.id) ||
            leftTarget.localeCompare(rightTarget),
        )
        .map(([targetId]) => targetId),
    }
  }
  if (item.task === 'relationship') {
    const targetByObject = new Map(
      [...targets].map(([targetId, object]) => [object.id, targetId]),
    )
    return {
      relationships: observations.relationships.flatMap((relationship) => {
        const sourceId = targetByObject.get(relationship.sourceId)
        const targetId = targetByObject.get(relationship.targetId)
        return sourceId && targetId
          ? [{ type: relationship.type, sourceId, targetId }]
          : []
      }),
    }
  }
  invalid('INVALID_PDF_TARGET_FREE_PREDICTION_BRIDGE')
}

function combinedAdapterSha256(acquisitionAdapterSha256, bridgeSourceSha256) {
  if (
    !SHA256.test(acquisitionAdapterSha256 ?? '') ||
    !SHA256.test(bridgeSourceSha256 ?? '')
  ) {
    invalid('INVALID_PDF_TARGET_FREE_PREDICTION_BRIDGE')
  }
  return sha256(
    canonicalJson({
      schemaVersion: PDF_TARGET_FREE_PREDICTION_BRIDGE_VERSION,
      acquisitionAdapterSha256,
      bridgeSourceSha256,
    }),
  )
}

function validateRawOutput(raw, receipt, document, pageCount) {
  if (
    !exactKeys(raw, [
      'schemaVersion',
      'documentId',
      'sourceSha256',
      'candidate',
      'runtimeIdentity',
      'output',
    ]) ||
    raw.schemaVersion !== '1.0.0' ||
    raw.documentId !== document.id ||
    raw.sourceSha256 !== document.sha256 ||
    !exactKeys(raw.candidate, [
      'id',
      'version',
      'format',
      'formatVersion',
      'adapterSourceSha256',
    ]) ||
    raw.candidate.id !== receipt.candidate.id ||
    raw.candidate.version !== receipt.candidate.version ||
    raw.candidate.format !== OBSERVATION_FORMAT ||
    raw.candidate.formatVersion !==
      PDF_TARGET_FREE_DOCUMENT_OBSERVATIONS_SCHEMA_VERSION ||
    raw.candidate.adapterSourceSha256 !==
      receipt.candidate.adapterSource.sha256 ||
    (!sameJson(raw.runtimeIdentity, receipt.candidate.runtimeIdentity) &&
      !sameJson(
        sanitizeAdapterRuntimeIdentity(
          raw.runtimeIdentity,
          receipt.candidate.runnerExecutableIdentity ?? null,
        ),
        receipt.candidate.runtimeIdentity,
      ))
  ) {
    invalid('INVALID_PDF_TARGET_FREE_OBSERVATION_OUTPUT')
  }
  validateTargetFreeDocumentObservations(raw.output, pageCount)
  return raw.output
}

export function normalizeTargetFreePredictions(
  evalSet,
  receipt,
  rawOutputs,
  bridgeSourceSha256,
) {
  const evalIdentity = validatePdfFidelityEvalSet(evalSet)
  if (
    !isRecord(receipt) ||
    !isRecord(receipt.candidate) ||
    !isRecord(receipt.candidate.adapterSource) ||
    !SAFE_ID.test(receipt.candidate.id ?? '') ||
    !SAFE_ID.test(receipt.candidate.version ?? '') ||
    !publicAdapterIdentifierMatches(
      receipt.candidate.format,
      OBSERVATION_FORMAT,
    ) ||
    !publicAdapterIdentifierMatches(
      receipt.candidate.formatVersion,
      PDF_TARGET_FREE_DOCUMENT_OBSERVATIONS_SCHEMA_VERSION,
    ) ||
    !SHA256.test(receipt.candidate.adapterSource.sha256 ?? '') ||
    !Array.isArray(receipt.documents) ||
    !uniqueBy(receipt.documents, ({ id }) => id) ||
    !(rawOutputs instanceof Map)
  ) {
    invalid('INVALID_PDF_TARGET_FREE_PREDICTION_BRIDGE')
  }
  const receiptDocuments = new Map(
    receipt.documents.map((document) => [document.id, document]),
  )
  const observations = new Map()
  for (const document of evalSet.documents) {
    const acquired = receiptDocuments.get(document.id)
    const raw = rawOutputs.get(document.id)
    if (
      !acquired ||
      acquired.byteLength !== document.byteLength ||
      acquired.sourceSha256 !== document.sha256 ||
      !raw
    ) {
      invalid('PDF_TARGET_FREE_EVAL_SOURCE_IDENTITY_MISMATCH')
    }
    observations.set(
      document.id,
      validateRawOutput(raw, receipt, document, document.pageCount),
    )
  }

  const mapping = goldStripAdapterCases(evalSet)
  const privatePredictions = {
    schemaVersion: '1.0.0',
    evalSetId: evalSet.id,
    evalSetSha256: evalIdentity.evalSetSha256,
    candidate: {
      id: receipt.candidate.id,
      version: receipt.candidate.version,
      format: PREDICTION_FORMAT,
      formatVersion: PDF_TARGET_FREE_PREDICTION_BRIDGE_VERSION,
      adapterSha256: combinedAdapterSha256(
        receipt.candidate.adapterSource.sha256,
        bridgeSourceSha256,
      ),
      runtimeIdentity: structuredClone(receipt.candidate.runtimeIdentity),
    },
    cases: mapping.cases.map((item) => ({
      caseId: item.id,
      output: normalizedCaseOutput(item, observations.get(item.documentId)),
    })),
  }
  const predictions = restoreGoldStrippedAdapterPredictions(
    privatePredictions,
    evalSet,
    mapping,
  )
  validatePdfFidelityPredictions(predictions, evalSet)
  return predictions
}

async function readJsonArtifact(path, code) {
  try {
    const before = await lstat(path)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size < 1 ||
      before.size > MAX_JSON_BYTES
    ) {
      invalid(code)
    }
    const bytes = await readFile(path)
    const after = await lstat(path)
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      bytes.byteLength !== before.size
    ) {
      invalid(code)
    }
    return {
      value: JSON.parse(bytes.toString('utf8')),
      bytes,
      byteLength: bytes.byteLength,
      fileSha256: sha256(bytes),
    }
  } catch (error) {
    if (error?.message === code) throw error
    invalid(code)
  }
}

async function parseJsonFile(path, code) {
  return (await readJsonArtifact(path, code)).value
}

function valueAfter(arguments_, index) {
  const value = arguments_[index + 1]
  if (!value || value.startsWith('--')) invalid('INVALID_USAGE')
  return value
}

function parseArguments(arguments_, environment = process.env) {
  if (arguments_[0] !== 'build') invalid('INVALID_USAGE')
  const values = {}
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (!argument.startsWith('--')) invalid('INVALID_USAGE')
    const key = argument.slice(2)
    const value = valueAfter(arguments_, index)
    if (Object.hasOwn(values, key)) invalid('INVALID_USAGE')
    values[key] = value
    index += 1
  }
  const required = [
    'eval-manifest',
    'target-free-manifest',
    'receipt',
    'raw-output-dir-env',
    'out',
  ]
  const optional = ['candidate-executable-env']
  if (
    Object.keys(values).some(
      (key) => !required.includes(key) && !optional.includes(key),
    ) ||
    required.some((key) => !values[key]) ||
    !SAFE_ENVIRONMENT_NAME.test(values['raw-output-dir-env']) ||
    typeof environment[values['raw-output-dir-env']] !== 'string' ||
    environment[values['raw-output-dir-env']].length === 0 ||
    (values['candidate-executable-env'] !== undefined &&
      (!SAFE_ENVIRONMENT_NAME.test(values['candidate-executable-env']) ||
        typeof environment[values['candidate-executable-env']] !== 'string' ||
        environment[values['candidate-executable-env']].length === 0))
  ) {
    invalid('INVALID_USAGE')
  }
  return {
    evalManifest: resolve(values['eval-manifest']),
    targetFreeManifest: resolve(values['target-free-manifest']),
    receipt: resolve(values.receipt),
    rawOutputDirectory: resolve(environment[values['raw-output-dir-env']]),
    candidateExecutable: values['candidate-executable-env']
      ? resolve(environment[values['candidate-executable-env']])
      : null,
    output: resolve(values.out),
  }
}

async function readRawOutputs(receipt, rawOutputDirectory) {
  const suppliedDetails = await lstat(rawOutputDirectory)
  if (!suppliedDetails.isDirectory() || suppliedDetails.isSymbolicLink()) {
    invalid('INVALID_PDF_TARGET_FREE_RETAINED_OUTPUTS')
  }
  const directory = await realpath(rawOutputDirectory)
  const outputs = new Map()
  for (const [index, document] of receipt.documents.entries()) {
    const filename = `raw-output-${String(index + 1).padStart(6, '0')}.json`
    const artifact = await readJsonArtifact(
      join(directory, filename),
      'INVALID_PDF_TARGET_FREE_RETAINED_OUTPUTS',
    )
    if (
      artifact.byteLength !== document.rawOutputByteLength ||
      artifact.fileSha256 !== document.rawOutputSha256
    ) {
      invalid('INVALID_PDF_TARGET_FREE_RETAINED_OUTPUTS')
    }
    outputs.set(document.id, artifact.value)
  }
  return outputs
}

function assertEvalDocumentsWereAcquired(evalSet, targetFreeManifest) {
  const acquired = new Map(
    targetFreeManifest.documents.map((document) => [document.id, document]),
  )
  for (const document of evalSet.documents) {
    const source = acquired.get(document.id)
    if (
      !source ||
      source.byteLength !== document.byteLength ||
      source.sha256 !== document.sha256
    ) {
      invalid('PDF_TARGET_FREE_EVAL_SOURCE_IDENTITY_MISMATCH')
    }
  }
}

async function writeExclusive(path, value) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(value)
  } finally {
    await handle.close()
  }
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2))
  const [evalSet, targetFreeManifestArtifact, receipt] = await Promise.all([
    parseJsonFile(parsed.evalManifest, 'INVALID_PDF_FIDELITY_EVAL_SET'),
    readJsonArtifact(
      parsed.targetFreeManifest,
      'INVALID_PDF_TARGET_FREE_CANDIDATE_MANIFEST',
    ),
    parseJsonFile(parsed.receipt, 'INVALID_PDF_TARGET_FREE_CANDIDATE_RECEIPT'),
  ])
  const targetFreeManifest = targetFreeManifestArtifact.value
  validatePdfFidelityEvalSet(evalSet)
  const expectedRunnerExecutableIdentity = parsed.candidateExecutable
    ? await observePdfTargetFreeCandidateExecutableIdentity(
        parsed.candidateExecutable,
      )
    : null
  await validatePdfTargetFreeCandidateReceipt(
    receipt,
    targetFreeManifestArtifact.bytes,
    null,
    expectedRunnerExecutableIdentity,
  )
  await validatePdfTargetFreeCandidateRetainedOutputs(
    receipt,
    parsed.rawOutputDirectory,
  )
  assertEvalDocumentsWereAcquired(evalSet, targetFreeManifest)
  const rawOutputs = await readRawOutputs(receipt, parsed.rawOutputDirectory)
  const bridgeSourceSha256 = (await createAdapterSourceIdentity(BRIDGE_PATH))
    .sha256
  const predictions = normalizeTargetFreePredictions(
    evalSet,
    receipt,
    rawOutputs,
    bridgeSourceSha256,
  )
  await writeExclusive(
    parsed.output,
    `${JSON.stringify(predictions, null, 2)}\n`,
  )
  process.stdout.write(
    `${JSON.stringify({
      evalSetId: predictions.evalSetId,
      candidate: predictions.candidate,
      predictionCount: predictions.cases.length,
      predictionSha256: sha256(canonicalJson(predictions)),
    })}\n`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    const code = /^[A-Z][A-Z0-9_]{0,127}$/.test(error?.message ?? '')
      ? error.message
      : 'PDF_TARGET_FREE_BRIDGE_FAILED'
    process.stderr.write(`${code}\n`)
    process.exitCode = 1
  })
}

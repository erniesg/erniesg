#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAdapterSourceIdentity } from './adapter-source-identity.mjs'

export {
  assertAdapterSourceIdentity,
  createAdapterSourceIdentity,
} from './adapter-source-identity.mjs'

export const PDF_FIDELITY_EVAL_SET_SCHEMA_VERSION = '1.0.0'
export const PDF_FIDELITY_PREDICTIONS_SCHEMA_VERSION = '1.0.0'
export const PDF_FIDELITY_EVAL_RECEIPT_SCHEMA_VERSION = '1.0.0'
export const PDF_FIDELITY_EVAL_COMPARISON_SCHEMA_VERSION = '1.0.0'

const EVAL_SET_PRIVACY =
  'public-identities-normalized-geometry-no-source-content'
const RECEIPT_PRIVACY =
  'public-identities-hashes-aggregate-scores-bounded-case-results-only'
const ADAPTER_REQUEST_PRIVACY =
  'owner-local-paths-present-ephemeral-delete-after-run'
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const TASKS = ['classification', 'detection', 'reading-order', 'relationship']
const MAX_JSON_BYTES = 32 * 1024 * 1024
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

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

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalHash(value) {
  return sha256(canonicalJson(value))
}

function invalid(code) {
  throw new Error(code)
}

function unit(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  )
}

export function isNormalizedPdfBox(value) {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(unit) &&
    value[2] > 0 &&
    value[3] > 0 &&
    value[0] + value[2] <= 1.000001 &&
    value[1] + value[3] <= 1.000001
  )
}

function validTarget(value) {
  return (
    exactKeys(value, ['id', 'kind', 'box']) &&
    SAFE_ID.test(value.id) &&
    SAFE_ID.test(value.kind) &&
    (value.box === null || isNormalizedPdfBox(value.box))
  )
}

function validRelationship(value) {
  return (
    exactKeys(value, ['type', 'sourceId', 'targetId']) &&
    SAFE_ID.test(value.type) &&
    SAFE_ID.test(value.sourceId) &&
    SAFE_ID.test(value.targetId)
  )
}

function validRuntimeToolIdentity(value) {
  return (
    exactKeys(value, [
      'id',
      'version',
      'executableSha256',
      'versionOutputSha256',
    ]) &&
    SAFE_ID.test(value.id) &&
    SAFE_ID.test(value.version) &&
    SHA256.test(value.executableSha256) &&
    SHA256.test(value.versionOutputSha256)
  )
}

function validRuntimeModelIdentity(value) {
  return (
    exactKeys(value, ['id', 'sha256']) &&
    SAFE_ID.test(value.id) &&
    SHA256.test(value.sha256)
  )
}

function validRuntimeIdentity(value) {
  if (!exactKeys(value, ['status', 'tool', 'model'])) return false
  if (value.status === 'not-applicable') {
    return value.tool === null && value.model === null
  }
  if (value.status === 'unattested') {
    return (
      (value.tool === null || validRuntimeToolIdentity(value.tool)) &&
      value.model === null
    )
  }
  return (
    value.status === 'attested' &&
    validRuntimeToolIdentity(value.tool) &&
    validRuntimeModelIdentity(value.model)
  )
}

function uniqueBy(values, selector) {
  return new Set(values.map(selector)).size === values.length
}

function validateExpected(task, expected, targets) {
  const targetIds = new Set(targets.map(({ id }) => id))
  if (task === 'classification') {
    return (
      exactKeys(expected, ['labels']) &&
      Array.isArray(expected.labels) &&
      expected.labels.length === targets.length &&
      expected.labels.every(
        (item) =>
          exactKeys(item, ['targetId', 'label']) &&
          targetIds.has(item.targetId) &&
          SAFE_ID.test(item.label),
      ) &&
      uniqueBy(expected.labels, ({ targetId }) => targetId)
    )
  }
  if (task === 'reading-order') {
    return (
      exactKeys(expected, ['order']) &&
      Array.isArray(expected.order) &&
      expected.order.length >= 2 &&
      expected.order.length === targets.length &&
      uniqueBy(expected.order, (id) => id) &&
      expected.order.every((id) => targetIds.has(id))
    )
  }
  if (task === 'relationship') {
    return (
      exactKeys(expected, ['relationships']) &&
      Array.isArray(expected.relationships) &&
      expected.relationships.length > 0 &&
      expected.relationships.every(
        (item) =>
          validRelationship(item) &&
          targetIds.has(item.sourceId) &&
          targetIds.has(item.targetId),
      ) &&
      uniqueBy(expected.relationships, canonicalJson)
    )
  }
  if (task === 'detection') {
    return (
      exactKeys(expected, ['objects']) &&
      Array.isArray(expected.objects) &&
      expected.objects.length > 0 &&
      expected.objects.every(
        (item) =>
          exactKeys(item, ['id', 'label', 'box']) &&
          SAFE_ID.test(item.id) &&
          SAFE_ID.test(item.label) &&
          isNormalizedPdfBox(item.box),
      ) &&
      uniqueBy(expected.objects, ({ id }) => id)
    )
  }
  return false
}

export function validatePdfFidelityEvalSet(value) {
  try {
    if (
      !exactKeys(value, [
        'schemaVersion',
        'id',
        'annotationSchemaVersion',
        'privacy',
        'scoring',
        'strata',
        'documents',
        'cases',
      ]) ||
      value.schemaVersion !== PDF_FIDELITY_EVAL_SET_SCHEMA_VERSION ||
      !SAFE_ID.test(value.id) ||
      value.annotationSchemaVersion !== '1.0.0' ||
      value.privacy !== EVAL_SET_PRIVACY ||
      !exactKeys(value.scoring, [
        'detectionIouThreshold',
        'minimumOverallScore',
        'requireAllCriticalCases',
      ]) ||
      !unit(value.scoring.detectionIouThreshold) ||
      value.scoring.detectionIouThreshold <= 0 ||
      !unit(value.scoring.minimumOverallScore) ||
      typeof value.scoring.requireAllCriticalCases !== 'boolean' ||
      !Array.isArray(value.strata) ||
      value.strata.length === 0 ||
      !value.strata.every(
        (item) =>
          exactKeys(item, ['id', 'task', 'critical']) &&
          SAFE_ID.test(item.id) &&
          TASKS.includes(item.task) &&
          typeof item.critical === 'boolean',
      ) ||
      !uniqueBy(value.strata, ({ id }) => id) ||
      !Array.isArray(value.documents) ||
      value.documents.length === 0 ||
      !value.documents.every(
        (document) =>
          exactKeys(document, [
            'id',
            'fileName',
            'byteLength',
            'sha256',
            'pageCount',
          ]) &&
          SAFE_ID.test(document.id) &&
          document.fileName === `${document.id}.pdf` &&
          Number.isSafeInteger(document.byteLength) &&
          document.byteLength > 0 &&
          SHA256.test(document.sha256) &&
          Number.isSafeInteger(document.pageCount) &&
          document.pageCount > 0,
      ) ||
      !uniqueBy(value.documents, ({ id }) => id) ||
      !uniqueBy(value.documents, ({ sha256: digest }) => digest) ||
      !Array.isArray(value.cases) ||
      value.cases.length === 0 ||
      !uniqueBy(value.cases, ({ id }) => id)
    ) {
      invalid('INVALID_PDF_FIDELITY_EVAL_SET')
    }
    const strata = new Map(value.strata.map((item) => [item.id, item]))
    const documents = new Map(value.documents.map((item) => [item.id, item]))
    for (const item of value.cases) {
      if (
        !exactKeys(item, [
          'id',
          'documentId',
          'page',
          'stratum',
          'task',
          'critical',
          'targets',
          'expected',
        ]) ||
        !SAFE_ID.test(item.id) ||
        !documents.has(item.documentId) ||
        !Number.isSafeInteger(item.page) ||
        item.page < 1 ||
        item.page > documents.get(item.documentId).pageCount ||
        !strata.has(item.stratum) ||
        item.task !== strata.get(item.stratum).task ||
        typeof item.critical !== 'boolean' ||
        item.critical !== strata.get(item.stratum).critical ||
        !Array.isArray(item.targets) ||
        item.targets.length === 0 ||
        !item.targets.every(validTarget) ||
        !uniqueBy(item.targets, ({ id }) => id) ||
        !validateExpected(item.task, item.expected, item.targets)
      ) {
        invalid('INVALID_PDF_FIDELITY_EVAL_SET')
      }
    }
    const usedStrata = new Set(value.cases.map(({ stratum }) => stratum))
    if (value.strata.some(({ id }) => !usedStrata.has(id))) {
      invalid('INVALID_PDF_FIDELITY_EVAL_SET')
    }
    return {
      id: value.id,
      schemaVersion: value.schemaVersion,
      documentCount: value.documents.length,
      caseCount: value.cases.length,
      stratumCount: value.strata.length,
      documentIdentitySha256: canonicalHash(value.documents),
      caseIdentitySha256: canonicalHash(value.cases),
      evalSetSha256: canonicalHash(value),
      valid: true,
    }
  } catch {
    invalid('INVALID_PDF_FIDELITY_EVAL_SET')
  }
}

function validPredictionOutput(task, output) {
  if (task === 'classification') {
    return (
      exactKeys(output, ['labels']) &&
      Array.isArray(output.labels) &&
      output.labels.every(
        (item) =>
          exactKeys(item, ['targetId', 'label']) &&
          SAFE_ID.test(item.targetId) &&
          SAFE_ID.test(item.label),
      ) &&
      uniqueBy(output.labels, ({ targetId }) => targetId)
    )
  }
  if (task === 'reading-order') {
    return (
      exactKeys(output, ['order']) &&
      Array.isArray(output.order) &&
      output.order.every((id) => SAFE_ID.test(id)) &&
      uniqueBy(output.order, (id) => id)
    )
  }
  if (task === 'relationship') {
    return (
      exactKeys(output, ['relationships']) &&
      Array.isArray(output.relationships) &&
      output.relationships.every(validRelationship) &&
      uniqueBy(output.relationships, canonicalJson)
    )
  }
  if (task === 'detection') {
    return (
      exactKeys(output, ['objects']) &&
      Array.isArray(output.objects) &&
      output.objects.every(
        (item) =>
          exactKeys(item, ['id', 'label', 'box']) &&
          SAFE_ID.test(item.id) &&
          SAFE_ID.test(item.label) &&
          isNormalizedPdfBox(item.box),
      ) &&
      uniqueBy(output.objects, ({ id }) => id)
    )
  }
  return false
}

export function validatePdfFidelityPredictions(value, evalSet) {
  const identity = validatePdfFidelityEvalSet(evalSet)
  try {
    if (
      !exactKeys(value, [
        'schemaVersion',
        'evalSetId',
        'evalSetSha256',
        'candidate',
        'cases',
      ]) ||
      value.schemaVersion !== PDF_FIDELITY_PREDICTIONS_SCHEMA_VERSION ||
      value.evalSetId !== evalSet.id ||
      value.evalSetSha256 !== identity.evalSetSha256 ||
      !exactKeys(value.candidate, [
        'id',
        'version',
        'format',
        'formatVersion',
        'adapterSha256',
        'runtimeIdentity',
      ]) ||
      !SAFE_ID.test(value.candidate.id) ||
      !SAFE_ID.test(value.candidate.version) ||
      !SAFE_ID.test(value.candidate.format) ||
      !SAFE_ID.test(value.candidate.formatVersion) ||
      !(
        value.candidate.adapterSha256 === null ||
        SHA256.test(value.candidate.adapterSha256)
      ) ||
      !validRuntimeIdentity(value.candidate.runtimeIdentity) ||
      !Array.isArray(value.cases) ||
      !uniqueBy(value.cases, ({ caseId }) => caseId)
    ) {
      invalid('INVALID_PDF_FIDELITY_PREDICTIONS')
    }
    const cases = new Map(evalSet.cases.map((item) => [item.id, item]))
    for (const prediction of value.cases) {
      const gold = cases.get(prediction.caseId)
      if (
        !exactKeys(prediction, ['caseId', 'output']) ||
        !gold ||
        !validPredictionOutput(gold.task, prediction.output)
      ) {
        invalid('INVALID_PDF_FIDELITY_PREDICTIONS')
      }
    }
    return { valid: true, predictionCount: value.cases.length }
  } catch {
    invalid('INVALID_PDF_FIDELITY_PREDICTIONS')
  }
}

function rounded(value) {
  return Math.round(value * 100_000_000) / 100_000_000
}

function ratio(numerator, denominator, empty = 1) {
  return denominator === 0 ? empty : rounded(numerator / denominator)
}

function f1(precision, recall) {
  return precision + recall === 0
    ? 0
    : rounded((2 * precision * recall) / (precision + recall))
}

function iou(left, right) {
  const x1 = Math.max(left[0], right[0])
  const y1 = Math.max(left[1], right[1])
  const x2 = Math.min(left[0] + left[2], right[0] + right[2])
  const y2 = Math.min(left[1] + left[3], right[1] + right[3])
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = left[2] * left[3] + right[2] * right[3] - intersection
  return union === 0 ? 0 : intersection / union
}

function setMetrics(expected, predicted) {
  const expectedSet = new Set(expected)
  const predictedSet = new Set(predicted)
  const truePositive = [...predictedSet].filter((item) =>
    expectedSet.has(item),
  ).length
  const falsePositive = predictedSet.size - truePositive
  const falseNegative = expectedSet.size - truePositive
  const precision = ratio(truePositive, truePositive + falsePositive)
  const recall = ratio(truePositive, truePositive + falseNegative)
  return {
    truePositive,
    falsePositive,
    falseNegative,
    precision,
    recall,
    f1: f1(precision, recall),
  }
}

function scoreClassification(gold, predicted) {
  const expected = new Map(
    gold.labels.map((item) => [item.targetId, item.label]),
  )
  const actual = new Map(
    predicted.labels.map((item) => [item.targetId, item.label]),
  )
  let correct = 0
  for (const [targetId, label] of expected) {
    if (actual.get(targetId) === label) correct += 1
  }
  const unexpected = [...actual].filter(
    ([targetId]) => !expected.has(targetId),
  ).length
  const total = expected.size
  const falsePositive = unexpected + total - correct
  const falseNegative = total - correct
  const precision = ratio(correct, correct + falsePositive)
  const recall = ratio(correct, correct + falseNegative)
  return {
    score: f1(precision, recall),
    correct,
    total,
    truePositive: correct,
    falsePositive,
    falseNegative,
  }
}

function scoreReadingOrder(gold, predicted) {
  const pairs = (order) => {
    const result = []
    for (let left = 0; left < order.length; left += 1) {
      for (let right = left + 1; right < order.length; right += 1) {
        result.push(`${order[left]}\0${order[right]}`)
      }
    }
    return result
  }
  const metrics = setMetrics(pairs(gold.order), pairs(predicted.order))
  return {
    score: metrics.f1,
    correct: metrics.truePositive,
    total: pairs(gold.order).length,
    truePositive: metrics.truePositive,
    falsePositive: metrics.falsePositive,
    falseNegative: metrics.falseNegative,
  }
}

function scoreRelationships(gold, predicted) {
  const metrics = setMetrics(
    gold.relationships.map(canonicalJson),
    predicted.relationships.map(canonicalJson),
  )
  return {
    score: metrics.f1,
    correct: metrics.truePositive,
    total: gold.relationships.length,
    truePositive: metrics.truePositive,
    falsePositive: metrics.falsePositive,
    falseNegative: metrics.falseNegative,
  }
}

function scoreDetection(gold, predicted, threshold) {
  const evaluatedLabels = new Set(gold.objects.map(({ label }) => label))
  const relevantPredictions = predicted.objects.filter(({ label }) =>
    evaluatedLabels.has(label),
  )
  const candidates = []
  for (
    let expectedIndex = 0;
    expectedIndex < gold.objects.length;
    expectedIndex += 1
  ) {
    for (
      let predictedIndex = 0;
      predictedIndex < relevantPredictions.length;
      predictedIndex += 1
    ) {
      if (
        gold.objects[expectedIndex].label !==
        relevantPredictions[predictedIndex].label
      )
        continue
      const overlap = iou(
        gold.objects[expectedIndex].box,
        relevantPredictions[predictedIndex].box,
      )
      if (overlap >= threshold) {
        candidates.push({ expectedIndex, predictedIndex, overlap })
      }
    }
  }
  candidates.sort(
    (left, right) =>
      right.overlap - left.overlap ||
      left.expectedIndex - right.expectedIndex ||
      left.predictedIndex - right.predictedIndex,
  )
  const expectedMatched = new Set()
  const predictedMatched = new Set()
  for (const candidate of candidates) {
    if (
      expectedMatched.has(candidate.expectedIndex) ||
      predictedMatched.has(candidate.predictedIndex)
    ) {
      continue
    }
    expectedMatched.add(candidate.expectedIndex)
    predictedMatched.add(candidate.predictedIndex)
  }
  const truePositive = expectedMatched.size
  const falsePositive = relevantPredictions.length - truePositive
  const falseNegative = gold.objects.length - truePositive
  const precision = ratio(truePositive, truePositive + falsePositive)
  const recall = ratio(truePositive, truePositive + falseNegative)
  return {
    score: f1(precision, recall),
    correct: truePositive,
    total: gold.objects.length,
    truePositive,
    falsePositive,
    falseNegative,
  }
}

function emptyPrediction(task) {
  if (task === 'classification') return { labels: [] }
  if (task === 'reading-order') return { order: [] }
  if (task === 'relationship') return { relationships: [] }
  return { objects: [] }
}

function aggregateCaseResults(results, selector) {
  const groups = new Map()
  for (const result of results) {
    const key = selector(result)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(result)
  }
  return Object.fromEntries(
    [...groups]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [
        key,
        {
          cases: values.length,
          passed: values.filter(({ passed }) => passed).length,
          score: rounded(
            values.reduce((total, value) => total + value.score, 0) /
              values.length,
          ),
        },
      ]),
  )
}

function deriveReceiptSummary(caseResults) {
  const passed = caseResults.filter((item) => item.passed).length
  const critical = caseResults.filter((item) => item.critical)
  const criticalPassed = critical.filter((item) => item.passed).length
  return {
    cases: caseResults.length,
    present: caseResults.filter((item) => item.present).length,
    passed,
    failed: caseResults.length - passed,
    passRate: ratio(passed, caseResults.length),
    overallScore: rounded(
      caseResults.reduce((total, item) => total + item.score, 0) /
        caseResults.length,
    ),
    criticalCases: critical.length,
    criticalPassed,
    criticalPassRate: ratio(criticalPassed, critical.length),
    taskScores: aggregateCaseResults(caseResults, ({ task }) => task),
    stratumScores: aggregateCaseResults(caseResults, ({ stratum }) => stratum),
  }
}

function receiptPassesPolicy(summary, scoring, candidate) {
  return (
    candidate.runtimeIdentity.status !== 'unattested' &&
    summary.present === summary.cases &&
    summary.overallScore >= scoring.minimumOverallScore &&
    (!scoring.requireAllCriticalCases ||
      summary.criticalPassed === summary.criticalCases)
  )
}

function evidenceWithoutHash(receipt) {
  return Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== 'receiptSha256'),
  )
}

export function scorePdfFidelityPredictions(
  evalSet,
  predictions,
  execution = null,
) {
  const identity = validatePdfFidelityEvalSet(evalSet)
  validatePdfFidelityPredictions(predictions, evalSet)
  const predictionMap = new Map(
    predictions.cases.map((item) => [item.caseId, item.output]),
  )
  const caseResults = evalSet.cases.map((item) => {
    const output = predictionMap.get(item.id) ?? emptyPrediction(item.task)
    const raw =
      item.task === 'classification'
        ? scoreClassification(item.expected, output)
        : item.task === 'reading-order'
          ? scoreReadingOrder(item.expected, output)
          : item.task === 'relationship'
            ? scoreRelationships(item.expected, output)
            : scoreDetection(
                item.expected,
                output,
                evalSet.scoring.detectionIouThreshold,
              )
    return {
      caseId: item.id,
      documentId: item.documentId,
      page: item.page,
      stratum: item.stratum,
      task: item.task,
      critical: item.critical,
      present: predictionMap.has(item.id),
      passed: raw.score === 1,
      ...raw,
    }
  })
  const summary = deriveReceiptSummary(caseResults)
  const passed = receiptPassesPolicy(
    summary,
    evalSet.scoring,
    predictions.candidate,
  )
  const receipt = {
    schemaVersion: PDF_FIDELITY_EVAL_RECEIPT_SCHEMA_VERSION,
    privacy: RECEIPT_PRIVACY,
    evalSet: {
      id: evalSet.id,
      sha256: identity.evalSetSha256,
      annotationSchemaVersion: evalSet.annotationSchemaVersion,
      documentIdentitySha256: identity.documentIdentitySha256,
      caseIdentitySha256: identity.caseIdentitySha256,
    },
    candidate: structuredClone(predictions.candidate),
    predictionSha256: canonicalHash(predictions),
    execution: execution ?? {
      lane: 'external-predictions',
      platform: null,
      architecture: null,
      offlineRequested: false,
      allInputsVerified: false,
    },
    summary,
    cases: caseResults,
    passed,
  }
  return { ...receipt, receiptSha256: canonicalHash(receipt) }
}

function expectedCaseTotal(item) {
  if (item.task === 'classification') return item.expected.labels.length
  if (item.task === 'detection') return item.expected.objects.length
  if (item.task === 'relationship') return item.expected.relationships.length
  return (item.expected.order.length * (item.expected.order.length - 1)) / 2
}

function receiptCaseMatchesEvalCase(result, item) {
  const total = expectedCaseTotal(item)
  const precision = ratio(
    result.truePositive,
    result.truePositive + result.falsePositive,
  )
  const recall = ratio(
    result.truePositive,
    result.truePositive + result.falseNegative,
  )
  const score = f1(precision, recall)
  return (
    result.caseId === item.id &&
    result.documentId === item.documentId &&
    result.page === item.page &&
    result.stratum === item.stratum &&
    result.task === item.task &&
    result.critical === item.critical &&
    result.total === total &&
    result.correct === result.truePositive &&
    result.truePositive + result.falseNegative === total &&
    result.score === score &&
    result.passed === (score === 1) &&
    (result.present ||
      (result.truePositive === 0 &&
        result.falsePositive === (item.task === 'classification' ? total : 0) &&
        result.falseNegative === total))
  )
}

export function validatePdfFidelityEvalReceipt(receipt, evalSet, predictions) {
  try {
    const identity = validatePdfFidelityEvalSet(evalSet)
    const expectedEvalSet = {
      id: evalSet.id,
      sha256: identity.evalSetSha256,
      annotationSchemaVersion: evalSet.annotationSchemaVersion,
      documentIdentitySha256: identity.documentIdentitySha256,
      caseIdentitySha256: identity.caseIdentitySha256,
    }
    if (
      !exactKeys(receipt, [
        'schemaVersion',
        'privacy',
        'evalSet',
        'candidate',
        'predictionSha256',
        'execution',
        'summary',
        'cases',
        'passed',
        'receiptSha256',
      ]) ||
      receipt.schemaVersion !== PDF_FIDELITY_EVAL_RECEIPT_SCHEMA_VERSION ||
      receipt.privacy !== RECEIPT_PRIVACY ||
      !exactKeys(receipt.evalSet, [
        'id',
        'sha256',
        'annotationSchemaVersion',
        'documentIdentitySha256',
        'caseIdentitySha256',
      ]) ||
      !SAFE_ID.test(receipt.evalSet.id) ||
      receipt.evalSet.annotationSchemaVersion !== '1.0.0' ||
      ['sha256', 'documentIdentitySha256', 'caseIdentitySha256'].some(
        (key) => !SHA256.test(receipt.evalSet[key]),
      ) ||
      !exactKeys(receipt.candidate, [
        'id',
        'version',
        'format',
        'formatVersion',
        'adapterSha256',
        'runtimeIdentity',
      ]) ||
      !SAFE_ID.test(receipt.candidate.id) ||
      !SAFE_ID.test(receipt.candidate.version) ||
      !SAFE_ID.test(receipt.candidate.format) ||
      !SAFE_ID.test(receipt.candidate.formatVersion) ||
      !(
        receipt.candidate.adapterSha256 === null ||
        SHA256.test(receipt.candidate.adapterSha256)
      ) ||
      !validRuntimeIdentity(receipt.candidate.runtimeIdentity) ||
      !SHA256.test(receipt.predictionSha256) ||
      !exactKeys(receipt.execution, [
        'lane',
        'platform',
        'architecture',
        'offlineRequested',
        'allInputsVerified',
      ]) ||
      !SAFE_ID.test(receipt.execution.lane) ||
      !(
        receipt.execution.platform === null ||
        SAFE_ID.test(receipt.execution.platform)
      ) ||
      !(
        receipt.execution.architecture === null ||
        SAFE_ID.test(receipt.execution.architecture)
      ) ||
      typeof receipt.execution.offlineRequested !== 'boolean' ||
      typeof receipt.execution.allInputsVerified !== 'boolean' ||
      !validReceiptSummary(receipt.summary) ||
      !Array.isArray(receipt.cases) ||
      !receipt.cases.every(validReceiptCase) ||
      !uniqueBy(receipt.cases, ({ caseId }) => caseId) ||
      typeof receipt.passed !== 'boolean' ||
      !SHA256.test(receipt.receiptSha256) ||
      receipt.receiptSha256 !== canonicalHash(evidenceWithoutHash(receipt)) ||
      canonicalJson(receipt.evalSet) !== canonicalJson(expectedEvalSet) ||
      receipt.cases.length !== evalSet.cases.length ||
      receipt.cases.some(
        (result, index) =>
          !receiptCaseMatchesEvalCase(result, evalSet.cases[index]),
      )
    ) {
      invalid('INVALID_PDF_FIDELITY_EVAL_RECEIPT')
    }
    const expectedSummary = deriveReceiptSummary(receipt.cases)
    if (
      canonicalJson(receipt.summary) !== canonicalJson(expectedSummary) ||
      receipt.passed !==
        receiptPassesPolicy(expectedSummary, evalSet.scoring, receipt.candidate)
    ) {
      invalid('INVALID_PDF_FIDELITY_EVAL_RECEIPT')
    }
    validatePdfFidelityPredictions(predictions, evalSet)
    const expectedReceipt = scorePdfFidelityPredictions(
      evalSet,
      predictions,
      receipt.execution,
    )
    if (canonicalJson(receipt) !== canonicalJson(expectedReceipt)) {
      invalid('INVALID_PDF_FIDELITY_EVAL_RECEIPT')
    }
    return { valid: true }
  } catch {
    invalid('INVALID_PDF_FIDELITY_EVAL_RECEIPT')
  }
}

function validScoreGroup(value) {
  return (
    exactKeys(value, ['cases', 'passed', 'score']) &&
    Number.isSafeInteger(value.cases) &&
    value.cases > 0 &&
    Number.isSafeInteger(value.passed) &&
    value.passed >= 0 &&
    value.passed <= value.cases &&
    unit(value.score)
  )
}

function validScoreGroups(value) {
  return (
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(
      ([key, score]) => SAFE_ID.test(key) && validScoreGroup(score),
    )
  )
}

function validReceiptSummary(value) {
  return (
    exactKeys(value, [
      'cases',
      'present',
      'passed',
      'failed',
      'passRate',
      'overallScore',
      'criticalCases',
      'criticalPassed',
      'criticalPassRate',
      'taskScores',
      'stratumScores',
    ]) &&
    [
      'cases',
      'present',
      'passed',
      'failed',
      'criticalCases',
      'criticalPassed',
    ].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0) &&
    value.present <= value.cases &&
    value.passed + value.failed === value.cases &&
    value.criticalPassed <= value.criticalCases &&
    unit(value.passRate) &&
    unit(value.overallScore) &&
    unit(value.criticalPassRate) &&
    validScoreGroups(value.taskScores) &&
    validScoreGroups(value.stratumScores)
  )
}

function validReceiptCase(value) {
  return (
    exactKeys(value, [
      'caseId',
      'documentId',
      'page',
      'stratum',
      'task',
      'critical',
      'present',
      'passed',
      'score',
      'correct',
      'total',
      'truePositive',
      'falsePositive',
      'falseNegative',
    ]) &&
    SAFE_ID.test(value.caseId) &&
    SAFE_ID.test(value.documentId) &&
    Number.isSafeInteger(value.page) &&
    value.page > 0 &&
    SAFE_ID.test(value.stratum) &&
    TASKS.includes(value.task) &&
    typeof value.critical === 'boolean' &&
    typeof value.present === 'boolean' &&
    typeof value.passed === 'boolean' &&
    value.passed === (value.score === 1) &&
    unit(value.score) &&
    [
      'correct',
      'total',
      'truePositive',
      'falsePositive',
      'falseNegative',
    ].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
  )
}

function buildPdfFidelityEvalComparison(baseline, candidate) {
  const baselineCases = new Map(
    baseline.cases.map((item) => [item.caseId, item]),
  )
  const cases = candidate.cases.map((item) => {
    const previous = baselineCases.get(item.caseId)
    const delta = rounded(item.score - previous.score)
    return {
      caseId: item.caseId,
      stratum: item.stratum,
      task: item.task,
      critical: item.critical,
      baselineScore: previous.score,
      candidateScore: item.score,
      delta,
      change: delta > 0 ? 'improved' : delta < 0 ? 'regressed' : 'unchanged',
    }
  })
  const comparison = {
    schemaVersion: PDF_FIDELITY_EVAL_COMPARISON_SCHEMA_VERSION,
    privacy: RECEIPT_PRIVACY,
    evalSet: structuredClone(candidate.evalSet),
    baseline: {
      candidateId: baseline.candidate.id,
      candidateVersion: baseline.candidate.version,
      receiptSha256: baseline.receiptSha256,
    },
    candidate: {
      candidateId: candidate.candidate.id,
      candidateVersion: candidate.candidate.version,
      receiptSha256: candidate.receiptSha256,
    },
    overallScoreDelta: rounded(
      candidate.summary.overallScore - baseline.summary.overallScore,
    ),
    criticalRegressionCount: cases.filter(
      ({ critical, change }) => critical && change === 'regressed',
    ).length,
    cases,
    passed:
      candidate.passed &&
      cases.every(
        ({ critical, change }) => !critical || change !== 'regressed',
      ),
  }
  return { ...comparison, comparisonSha256: canonicalHash(comparison) }
}

export function validatePdfFidelityEvalComparison(
  comparison,
  baseline,
  candidate,
  evalSet,
  baselinePredictions,
  candidatePredictions,
) {
  try {
    validatePdfFidelityEvalReceipt(baseline, evalSet, baselinePredictions)
    validatePdfFidelityEvalReceipt(candidate, evalSet, candidatePredictions)
    const expected = buildPdfFidelityEvalComparison(baseline, candidate)
    if (canonicalJson(comparison) !== canonicalJson(expected)) {
      invalid('INVALID_PDF_FIDELITY_EVAL_COMPARISON')
    }
    return { valid: true }
  } catch {
    invalid('INVALID_PDF_FIDELITY_EVAL_COMPARISON')
  }
}

export function comparePdfFidelityEvalReceipts(
  baseline,
  candidate,
  evalSet,
  baselinePredictions,
  candidatePredictions,
) {
  validatePdfFidelityEvalReceipt(baseline, evalSet, baselinePredictions)
  validatePdfFidelityEvalReceipt(candidate, evalSet, candidatePredictions)
  return buildPdfFidelityEvalComparison(baseline, candidate)
}

async function readJson(path, code) {
  const details = await stat(path)
  if (!details.isFile() || details.size <= 0 || details.size > MAX_JSON_BYTES) {
    invalid(code)
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    invalid(code)
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

function within(parent, child) {
  const path = relative(parent, child)
  return (
    path === '' ||
    (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
  )
}

async function prepareExternalOwnerDirectory(path) {
  const target = resolve(path)
  if (within(REPOSITORY_ROOT, target)) invalid('OUTPUT_MUST_BE_EXTERNAL')
  try {
    await lstat(target)
    invalid('OUTPUT_DIRECTORY_MUST_BE_NEW')
  } catch (error) {
    if (error.message === 'OUTPUT_DIRECTORY_MUST_BE_NEW') throw error
    if (error.code !== 'ENOENT') throw error
  }
  const parent = await realpath(dirname(target))
  const resolvedTarget = resolve(
    parent,
    target.slice(dirname(target).length + 1),
  )
  if (within(REPOSITORY_ROOT, resolvedTarget))
    invalid('OUTPUT_MUST_BE_EXTERNAL')
  await mkdir(resolvedTarget, { mode: 0o700 })
  const details = await lstat(resolvedTarget)
  if (
    !details.isDirectory() ||
    details.isSymbolicLink() ||
    (details.mode & 0o077) !== 0
  ) {
    invalid('OUTPUT_DIRECTORY_NOT_OWNER_ONLY')
  }
  return resolvedTarget
}

function valueAfter(arguments_, index) {
  const value = arguments_[index + 1]
  if (!value || value.startsWith('--')) invalid('INVALID_USAGE')
  return value
}

function parseNamedArguments(arguments_) {
  const values = {}
  const flags = new Set()
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--allow-non-darwin') {
      if (flags.has(argument)) invalid('INVALID_USAGE')
      flags.add(argument)
      continue
    }
    if (!argument.startsWith('--')) invalid('INVALID_USAGE')
    const equals = argument.indexOf('=')
    const key = argument.slice(2, equals < 0 ? undefined : equals)
    const value =
      equals < 0 ? valueAfter(arguments_, index) : argument.slice(equals + 1)
    if (equals < 0) index += 1
    if (!value || Object.hasOwn(values, key)) invalid('INVALID_USAGE')
    values[key] = value
  }
  return { values, flags }
}

export function parseLocalEvalArguments(arguments_, environment = process.env) {
  const { values, flags } = parseNamedArguments(arguments_)
  const required = [
    'manifest',
    'input-root-env',
    'adapter-env',
    'candidate-id',
    'candidate-version',
    'out',
  ]
  const optional = ['timeout-seconds']
  if (
    Object.keys(values).some(
      (key) => !required.includes(key) && !optional.includes(key),
    ) ||
    required.some((key) => !values[key]) ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(values['input-root-env']) ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(values['adapter-env']) ||
    !SAFE_ID.test(values['candidate-id']) ||
    !SAFE_ID.test(values['candidate-version'])
  ) {
    invalid('INVALID_USAGE')
  }
  const inputRoot = environment[values['input-root-env']]
  const adapter = environment[values['adapter-env']]
  const timeoutSeconds = Number(values['timeout-seconds'] ?? 7200)
  if (
    typeof inputRoot !== 'string' ||
    !inputRoot ||
    typeof adapter !== 'string' ||
    !adapter ||
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 86_400
  ) {
    invalid('INVALID_USAGE')
  }
  return {
    manifest: resolve(values.manifest),
    inputRoot: resolve(inputRoot),
    adapter: resolve(adapter),
    candidateId: values['candidate-id'],
    candidateVersion: values['candidate-version'],
    outputDirectory: resolve(values.out),
    timeoutSeconds,
    allowNonDarwin: flags.has('--allow-non-darwin'),
  }
}

async function verifyLocalInputs(evalSet, inputRoot) {
  const root = await realpath(inputRoot)
  if (within(REPOSITORY_ROOT, root))
    invalid('PRIVATE_INPUT_ROOT_MUST_BE_EXTERNAL')
  const documents = []
  for (const document of evalSet.documents) {
    const path = resolve(root, document.fileName)
    if (!within(root, path)) invalid('SOURCE_IDENTITY_MISMATCH')
    const details = await lstat(path)
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.size !== document.byteLength
    ) {
      invalid('SOURCE_IDENTITY_MISMATCH')
    }
    const bytes = await readFile(path)
    if (sha256(bytes) !== document.sha256) invalid('SOURCE_IDENTITY_MISMATCH')
    documents.push({
      id: document.id,
      path,
      byteLength: document.byteLength,
      sha256: document.sha256,
      pageCount: document.pageCount,
    })
  }
  return documents
}

function opaqueAdapterId(kind, evalSetId, value) {
  return `${kind}-${sha256(`${kind}\0${evalSetId}\0${value}`).slice(0, 24)}`
}

export function goldStripAdapterCases(evalSet) {
  validatePdfFidelityEvalSet(evalSet)
  const caseIds = new Map()
  const targetIds = new Map()
  const cases = evalSet.cases.map((item) => {
    const id = opaqueAdapterId('case', evalSet.id, item.id)
    caseIds.set(id, item.id)
    const targets =
      item.task === 'detection'
        ? []
        : item.targets.map((target) => {
            const targetId = opaqueAdapterId(
              'target',
              evalSet.id,
              `${item.id}\0${target.id}`,
            )
            targetIds.set(`${id}\0${targetId}`, target.id)
            return {
              id: targetId,
              kind: 'candidate',
              box: target.box === null ? null : [...target.box],
            }
          })
    return {
      id,
      documentId: item.documentId,
      page: item.page,
      stratum: item.stratum,
      task: item.task,
      targets,
    }
  })
  return { cases, caseIds, targetIds }
}

function restoreAdapterTargetId(mapping, publicCaseId, publicTargetId) {
  const restored = mapping.targetIds.get(`${publicCaseId}\0${publicTargetId}`)
  if (!restored) invalid('ADAPTER_GOLD_STRIP_MAPPING_MISMATCH')
  return restored
}

function restoreAdapterOutput(mapping, publicCaseId, task, output) {
  if (task === 'classification') {
    return {
      labels: output.labels.map((item) => ({
        targetId: restoreAdapterTargetId(mapping, publicCaseId, item.targetId),
        label: item.label,
      })),
    }
  }
  if (task === 'reading-order') {
    return {
      order: output.order.map((targetId) =>
        restoreAdapterTargetId(mapping, publicCaseId, targetId),
      ),
    }
  }
  if (task === 'relationship') {
    return {
      relationships: output.relationships.map((item) => ({
        type: item.type,
        sourceId: restoreAdapterTargetId(mapping, publicCaseId, item.sourceId),
        targetId: restoreAdapterTargetId(mapping, publicCaseId, item.targetId),
      })),
    }
  }
  return structuredClone(output)
}

export function restoreGoldStrippedAdapterPredictions(
  predictions,
  evalSet,
  mapping,
) {
  const evalCases = new Map(evalSet.cases.map((item) => [item.id, item]))
  const restoredCases = predictions.cases.map((prediction) => {
    const caseId = mapping.caseIds.get(prediction.caseId)
    const item = caseId ? evalCases.get(caseId) : null
    if (!item) invalid('ADAPTER_GOLD_STRIP_MAPPING_MISMATCH')
    return {
      caseId,
      output: restoreAdapterOutput(
        mapping,
        prediction.caseId,
        item.task,
        prediction.output,
      ),
    }
  })
  return { ...predictions, cases: restoredCases }
}

function safeAdapterEnvironment() {
  const names = [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'SRT_MINERU_MODEL_ID',
    'SRT_MINERU_MODEL_SHA256',
  ]
  const environment = Object.fromEntries(
    names
      .filter((name) => typeof process.env[name] === 'string')
      .map((name) => [name, process.env[name]]),
  )
  return {
    ...environment,
    SRT_PDF_EVAL_OFFLINE: '1',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
  }
}

async function runLocalEval(parsed) {
  if (platform() !== 'darwin' && !parsed.allowNonDarwin) {
    invalid('LOCAL_MAC_REQUIRED')
  }
  const evalSet = await readJson(
    parsed.manifest,
    'INVALID_PDF_FIDELITY_EVAL_SET',
  )
  const identity = validatePdfFidelityEvalSet(evalSet)
  const adapterDetails = await lstat(parsed.adapter)
  if (!adapterDetails.isFile() || adapterDetails.isSymbolicLink()) {
    invalid('INVALID_ADAPTER')
  }
  const adapterSha256 = (await createAdapterSourceIdentity(parsed.adapter))
    .sha256
  const documents = await verifyLocalInputs(evalSet, parsed.inputRoot)
  const outputDirectory = await prepareExternalOwnerDirectory(
    parsed.outputDirectory,
  )
  const scratch = await mkdtemp(join(tmpdir(), 'srt-pdf-eval-'))
  const requestPath = join(scratch, 'request.json')
  const predictionsPath = join(scratch, 'predictions.json')
  try {
    const publicRequestMapping = goldStripAdapterCases(evalSet)
    const request = {
      schemaVersion: '1.1.0',
      privacy: ADAPTER_REQUEST_PRIVACY,
      evalSet: { id: evalSet.id, sha256: identity.evalSetSha256 },
      candidate: {
        id: parsed.candidateId,
        version: parsed.candidateVersion,
        adapterSha256,
      },
      documents,
      cases: publicRequestMapping.cases,
    }
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, {
      mode: 0o600,
    })
    const result = spawnSync(
      parsed.adapter,
      ['--request', requestPath, '--output', predictionsPath],
      {
        env: safeAdapterEnvironment(),
        stdio: 'ignore',
        timeout: parsed.timeoutSeconds * 1000,
        windowsHide: true,
      },
    )
    if (result.error || result.status !== 0) invalid('ADAPTER_FAILED')
    const adapterPredictions = await readJson(
      predictionsPath,
      'INVALID_PDF_FIDELITY_PREDICTIONS',
    )
    if (
      !isRecord(adapterPredictions) ||
      !Array.isArray(adapterPredictions.cases)
    ) {
      invalid('INVALID_PDF_FIDELITY_PREDICTIONS')
    }
    const predictions = restoreGoldStrippedAdapterPredictions(
      adapterPredictions,
      evalSet,
      publicRequestMapping,
    )
    validatePdfFidelityPredictions(predictions, evalSet)
    if (
      predictions.candidate.id !== parsed.candidateId ||
      predictions.candidate.version !== parsed.candidateVersion ||
      predictions.candidate.adapterSha256 !== adapterSha256
    ) {
      invalid('ADAPTER_IDENTITY_MISMATCH')
    }
    const receipt = scorePdfFidelityPredictions(evalSet, predictions, {
      lane: 'local-mac',
      platform: platform(),
      architecture: arch(),
      offlineRequested: true,
      allInputsVerified: true,
    })
    validatePdfFidelityEvalReceipt(receipt, evalSet, predictions)
    await writeExclusive(
      join(outputDirectory, 'predictions.json'),
      `${JSON.stringify(predictions, null, 2)}\n`,
    )
    await writeExclusive(
      join(outputDirectory, 'eval-receipt.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
    )
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
    if (!receipt.passed) process.exitCode = 1
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function scoreCommand(arguments_) {
  const { values, flags } = parseNamedArguments(arguments_)
  if (
    flags.size > 0 ||
    !exactKeys(values, ['manifest', 'predictions', 'out'])
  ) {
    invalid('INVALID_USAGE')
  }
  const evalSet = await readJson(
    resolve(values.manifest),
    'INVALID_PDF_FIDELITY_EVAL_SET',
  )
  const predictions = await readJson(
    resolve(values.predictions),
    'INVALID_PDF_FIDELITY_PREDICTIONS',
  )
  const receipt = scorePdfFidelityPredictions(evalSet, predictions)
  validatePdfFidelityEvalReceipt(receipt, evalSet, predictions)
  await writeFile(resolve(values.out), `${JSON.stringify(receipt, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
  if (!receipt.passed) process.exitCode = 1
}

async function compareCommand(arguments_) {
  const { values, flags } = parseNamedArguments(arguments_)
  if (
    flags.size > 0 ||
    !exactKeys(values, [
      'manifest',
      'baseline',
      'baseline-predictions',
      'candidate',
      'candidate-predictions',
      'out',
    ])
  ) {
    invalid('INVALID_USAGE')
  }
  const evalSet = await readJson(
    resolve(values.manifest),
    'INVALID_PDF_FIDELITY_EVAL_SET',
  )
  const baseline = await readJson(
    resolve(values.baseline),
    'INVALID_PDF_FIDELITY_EVAL_RECEIPT',
  )
  const candidate = await readJson(
    resolve(values.candidate),
    'INVALID_PDF_FIDELITY_EVAL_RECEIPT',
  )
  const baselinePredictions = await readJson(
    resolve(values['baseline-predictions']),
    'INVALID_PDF_FIDELITY_PREDICTIONS',
  )
  const candidatePredictions = await readJson(
    resolve(values['candidate-predictions']),
    'INVALID_PDF_FIDELITY_PREDICTIONS',
  )
  const comparison = comparePdfFidelityEvalReceipts(
    baseline,
    candidate,
    evalSet,
    baselinePredictions,
    candidatePredictions,
  )
  await writeFile(
    resolve(values.out),
    `${JSON.stringify(comparison, null, 2)}\n`,
  )
  process.stdout.write(`${JSON.stringify(comparison)}\n`)
  if (!comparison.passed) process.exitCode = 1
}

function usage() {
  return (
    [
      'Usage:',
      '  node tools/pdf-fidelity-eval.mjs score --manifest <eval-set.json> --predictions <predictions.json> --out <receipt.json>',
      '  node tools/pdf-fidelity-eval.mjs compare --manifest <eval-set.json> --baseline <receipt.json> --baseline-predictions <predictions.json> --candidate <receipt.json> --candidate-predictions <predictions.json> --out <comparison.json>',
      '  node tools/pdf-fidelity-eval.mjs local --manifest <eval-set.json> --input-root-env <ENV> --adapter-env <ENV> --candidate-id <id> --candidate-version <version> --out <new-external-directory> [--timeout-seconds <seconds>] [--allow-non-darwin]',
    ].join('\n') + '\n'
  )
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2)
  if (command === 'score') return scoreCommand(arguments_)
  if (command === 'compare') return compareCommand(arguments_)
  if (command === 'local') {
    return runLocalEval(parseLocalEvalArguments(arguments_))
  }
  process.stderr.write(usage())
  process.exitCode = 2
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const code = SAFE_ID.test(error?.message ?? '')
      ? error.message
      : 'PDF_FIDELITY_EVAL_FAILED'
    process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`)
    process.exitCode = 2
  })
}

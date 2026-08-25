#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyReconstructionEvaluatorImplementationBinding } from './pdf-benchmark-readiness.mjs'
import {
  canonicalJson,
  sha256,
  validatePdfFidelityEvalReceipt,
  validatePdfFidelityEvalSet,
} from './pdf-fidelity-eval.mjs'

export const PDF_FIDELITY_SUITE_RECEIPT_SCHEMA_VERSION = '1.0.0'

const SUITE_ID = 'scholarly-pdf-fidelity-public-calibration-suite-2026-07-v1'
const SUITE_PRIVACY =
  'public-identities-hashes-aggregate-scores-bounded-failure-mode-results-only'
const SUITE_SPLIT = 'public-development-calibration'
const MAX_JSON_BYTES = 32 * 1024 * 1024
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/
const SHA256 = /^[a-f0-9]{64}$/
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const STATIC_PATHS = {
  base: {
    contract: 'benchmarks/pdf/reconstruction-eval-contract-v1.json',
    evalSet: 'benchmarks/pdf/fidelity-eval-v1.json',
    observations: 'benchmarks/pdf/fidelity-eval-observations-v1.json',
  },
  additive: {
    contract: 'benchmarks/pdf/reconstruction-eval-contract-v2.json',
    evalSet: 'benchmarks/pdf/fidelity-eval-v2.json',
    observations: 'benchmarks/pdf/fidelity-eval-observations-v2.json',
  },
  runtime: {
    contract: 'benchmarks/pdf/reconstruction-eval-contract-v4.json',
  },
}
const FROZEN_ARTIFACT_SHA256 = {
  base: {
    contract:
      'a9710abfd82f9ae9e301ed04752e877b3425d98a3f6e8a02649bc0a150068e3f',
    evalSet: '35d6d3f80eb646470afccaec9fd96b7e2a4c8405d33bcd5db62fcca425989002',
    observations:
      '65c147dfd19b6a62bd1b33c176e505e0f47e1fb963c5a0ad609296ca18dd9ce8',
  },
  additive: {
    contract:
      '0ee0826873f0b7349a5f4187746f9cc35a9acc1556fd7aa35e004b1a51a9a2dd',
    evalSet: '7420fc497895a058d24592b7c5164ded261846a5da4fed2f014c8a52cbafccf9',
    observations:
      '01f0a8022c06b18c79c8b7ab7258d72deff28b5dfeef9574425135a25ff1ed64',
  },
  runtime: {
    contract:
      '9b5c688d654c7f756b02628a58776e900076fee5445851a06c1383db7c039eee',
  },
}

function invalid(code = 'INVALID_PDF_FIDELITY_SUITE') {
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

function receiptWithoutHash(receipt) {
  return Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== 'receiptSha256'),
  )
}

function rounded(value) {
  return Math.round(value * 100_000_000) / 100_000_000
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : rounded(numerator / denominator)
}

function parseJsonArtifact(bytes, code) {
  const value =
    typeof bytes === 'string'
      ? Buffer.from(bytes)
      : bytes instanceof Uint8Array
        ? Buffer.from(bytes)
        : null
  if (!value || value.byteLength === 0 || value.byteLength > MAX_JSON_BYTES) {
    invalid(code)
  }
  try {
    return {
      value: JSON.parse(value.toString('utf8')),
      fileSha256: sha256(value),
    }
  } catch {
    invalid(code)
  }
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function expectedEvaluator(task) {
  if (task === 'classification') return 'exact-classification'
  if (task === 'detection') return 'complete-label-scoped-detection-iou'
  if (task === 'reading-order') return 'all-pairs-reading-order'
  if (task === 'relationship') return 'exact-typed-relationship'
  invalid()
}

function validateObservationSet(
  observations,
  evalSet,
  evalIdentity,
  fileSha256,
) {
  const version = evalSet.schemaVersion
  const expectedMethodKeys =
    version === '2.0.0'
      ? [
          'unit',
          'firstFailureDefinition',
          'annotationStatus',
          'selectionStatus',
          'candidateOutputConsulted',
        ]
      : [
          'unit',
          'firstFailureDefinition',
          'annotationStatus',
          'candidateOutputConsulted',
        ]
  if (
    !exactKeys(observations, [
      'schemaVersion',
      'id',
      'privacy',
      'evalSet',
      'method',
      'observations',
    ]) ||
    observations.schemaVersion !== version ||
    !SAFE_ID.test(observations.id ?? '') ||
    observations.privacy !==
      'public-identities-hashes-normalized-case-provenance-no-source-content' ||
    !exactKeys(observations.evalSet, [
      'path',
      'fileSha256',
      'evalSetSha256',
      'documentIdentitySha256',
      'caseIdentitySha256',
    ]) ||
    observations.evalSet.fileSha256 !== fileSha256 ||
    observations.evalSet.evalSetSha256 !== evalIdentity.evalSetSha256 ||
    observations.evalSet.documentIdentitySha256 !==
      evalIdentity.documentIdentitySha256 ||
    observations.evalSet.caseIdentitySha256 !==
      evalIdentity.caseIdentitySha256 ||
    !exactKeys(observations.method, expectedMethodKeys) ||
    observations.method.unit !== 'bounded-source-to-output-case' ||
    observations.method.firstFailureDefinition !==
      'earliest-source-backed-pipeline-decision-that-can-explain-the-bounded-failure' ||
    (version === '1.0.0' &&
      (observations.method.annotationStatus !==
        'source-verified-public-calibration-not-independent-blind-holdout' ||
        observations.method.candidateOutputConsulted !== false)) ||
    (version === '2.0.0' &&
      (observations.method.annotationStatus !==
        'source-verified-complaint-driven-public-calibration-not-independent-blind-holdout' ||
        observations.method.selectionStatus !==
          'candidate-output-used-for-case-selection-source-pdf-used-for-label' ||
        observations.method.candidateOutputConsulted !== true)) ||
    !Array.isArray(observations.observations) ||
    observations.observations.length !== evalSet.cases.length
  ) {
    invalid('INVALID_PDF_FIDELITY_SUITE_OBSERVATIONS')
  }

  const cases = new Map(evalSet.cases.map((item) => [item.id, item]))
  const documents = new Map(evalSet.documents.map((item) => [item.id, item]))
  const result = new Map()
  for (const observation of observations.observations) {
    const item = cases.get(observation?.caseId)
    const document = item ? documents.get(item.documentId) : null
    const sourceKeys =
      version === '2.0.0'
        ? ['documentId', 'sourcePdfSha256', 'pages', 'evidence']
        : ['documentId', 'sourcePdfSha256', 'page', 'evidence']
    if (
      !exactKeys(observation, [
        'caseId',
        'firstFailureClass',
        'sourceArtifact',
        'evaluator',
      ]) ||
      !item ||
      !document ||
      result.has(observation.caseId) ||
      !SAFE_ID.test(observation.firstFailureClass ?? '') ||
      !exactKeys(observation.sourceArtifact, sourceKeys) ||
      observation.sourceArtifact.documentId !== item.documentId ||
      observation.sourceArtifact.sourcePdfSha256 !== document.sha256 ||
      !exactKeys(observation.evaluator, ['id', 'kind', 'outcome']) ||
      observation.evaluator.id !== expectedEvaluator(item.task) ||
      observation.evaluator.kind !== 'code' ||
      observation.evaluator.outcome !== 'binary-pass-fail'
    ) {
      invalid('INVALID_PDF_FIDELITY_SUITE_OBSERVATIONS')
    }
    if (version === '1.0.0') {
      if (
        observation.sourceArtifact.page !== item.page ||
        observation.sourceArtifact.evidence !==
          'hash-pinned-source-pdf-page-and-normalized-geometry'
      ) {
        invalid('INVALID_PDF_FIDELITY_SUITE_OBSERVATIONS')
      }
    } else {
      const expectedPages = [
        ...new Set(item.targets.map(({ sourcePage }) => sourcePage)),
      ].sort((left, right) => left - right)
      if (
        !sameJson(observation.sourceArtifact.pages, expectedPages) ||
        observation.sourceArtifact.evidence !==
          'hash-pinned-source-pdf-pages-and-per-target-normalized-geometry'
      ) {
        invalid('INVALID_PDF_FIDELITY_SUITE_OBSERVATIONS')
      }
    }
    result.set(observation.caseId, observation.firstFailureClass)
  }
  return result
}

function validateEvalBinding(binding, artifact, identity) {
  return (
    binding?.artifact?.fileSha256 === artifact.fileSha256 &&
    binding.id === identity.id &&
    binding.evalSetSha256 === identity.evalSetSha256 &&
    binding.documentIdentitySha256 === identity.documentIdentitySha256 &&
    binding.caseIdentitySha256 === identity.caseIdentitySha256 &&
    binding.documentCount === identity.documentCount &&
    binding.caseCount === identity.caseCount &&
    binding.stratumCount === identity.stratumCount
  )
}

async function normalizePart(raw, role) {
  const contractArtifact = parseJsonArtifact(
    raw.contractArtifact,
    'INVALID_PDF_FIDELITY_SUITE_CONTRACT',
  )
  const evalArtifact = parseJsonArtifact(
    raw.evalSetArtifact,
    'INVALID_PDF_FIDELITY_EVAL_SET',
  )
  const observationsArtifact = parseJsonArtifact(
    raw.observationsArtifact,
    'INVALID_PDF_FIDELITY_SUITE_OBSERVATIONS',
  )
  const frozen = FROZEN_ARTIFACT_SHA256[role]
  if (
    contractArtifact.fileSha256 !== frozen.contract ||
    evalArtifact.fileSha256 !== frozen.evalSet ||
    observationsArtifact.fileSha256 !== frozen.observations
  ) {
    invalid('INVALID_PDF_FIDELITY_SUITE_FROZEN_ARTIFACT')
  }
  const evalIdentity = validatePdfFidelityEvalSet(evalArtifact.value)
  const failureModes = validateObservationSet(
    observationsArtifact.value,
    evalArtifact.value,
    evalIdentity,
    evalArtifact.fileSha256,
  )
  const contract = contractArtifact.value
  const evalBinding =
    role === 'base' ? contract.fidelityEval : contract.additiveFidelityEval
  const observationBinding =
    role === 'base' ? contract.observations : contract.additiveObservations
  if (
    contract.schemaVersion !== (role === 'base' ? '1.0.0' : '2.0.0') ||
    !SAFE_ID.test(contract.id ?? '') ||
    !validateEvalBinding(evalBinding, evalArtifact, evalIdentity) ||
    observationBinding?.artifact?.fileSha256 !==
      observationsArtifact.fileSha256 ||
    observationBinding.observationCount !== evalArtifact.value.cases.length
  ) {
    invalid('INVALID_PDF_FIDELITY_SUITE_CONTRACT')
  }
  validatePdfFidelityEvalReceipt(
    raw.baselineReceipt,
    evalArtifact.value,
    raw.baselinePredictions,
  )
  validatePdfFidelityEvalReceipt(
    raw.candidateReceipt,
    evalArtifact.value,
    raw.candidatePredictions,
  )
  return {
    role,
    contract,
    contractFileSha256: contractArtifact.fileSha256,
    evalSet: evalArtifact.value,
    evalSetFileSha256: evalArtifact.fileSha256,
    evalIdentity,
    observations: observationsArtifact.value,
    observationsFileSha256: observationsArtifact.fileSha256,
    failureModes,
    baselineReceipt: raw.baselineReceipt,
    candidateReceipt: raw.candidateReceipt,
  }
}

async function verifyRuntimeBinding() {
  const runtimeArtifact = parseJsonArtifact(
    await readFile(resolve(REPOSITORY_ROOT, STATIC_PATHS.runtime.contract)),
    'INVALID_PDF_FIDELITY_SUITE_CONTRACT',
  )
  if (runtimeArtifact.fileSha256 !== FROZEN_ARTIFACT_SHA256.runtime.contract)
    invalid('INVALID_PDF_FIDELITY_SUITE_FROZEN_ARTIFACT')
  try {
    await verifyReconstructionEvaluatorImplementationBinding(runtimeArtifact.value)
  } catch {
    invalid('INVALID_PDF_FIDELITY_SUITE_CONTRACT')
  }
}

function validateSuiteBindings(base, additive) {
  const extension = additive.evalSet.extends
  const expectedAggregateIdentity = sha256(
    [base.evalIdentity.evalSetSha256, additive.evalIdentity.evalSetSha256].join(
      '\0',
    ),
  )
  if (
    additive.contract.extends?.id !== base.contract.id ||
    additive.contract.extends?.fileSha256 !== base.contractFileSha256 ||
    extension?.id !== base.evalSet.id ||
    extension?.schemaVersion !== base.evalSet.schemaVersion ||
    extension?.fileSha256 !== base.evalSetFileSha256 ||
    extension?.evalSetSha256 !== base.evalIdentity.evalSetSha256 ||
    additive.contract.aggregatePublicCalibration?.baseCaseCount !==
      base.evalSet.cases.length ||
    additive.contract.aggregatePublicCalibration?.additiveCaseCount !==
      additive.evalSet.cases.length ||
    additive.contract.aggregatePublicCalibration?.totalCaseCount !==
      base.evalSet.cases.length + additive.evalSet.cases.length ||
    additive.contract.aggregatePublicCalibration?.labelsExposed !== true ||
    additive.contract.aggregatePublicCalibration?.identitySha256 !==
      expectedAggregateIdentity ||
    base.contract.splits?.publicCalibration?.labelsExposed !== true ||
    base.contract.splits?.blindHoldout?.status !== 'not-built' ||
    additive.contract.splitStatus?.publicCalibration !==
      'available-labels-exposed' ||
    additive.contract.splitStatus?.blindHoldout !== 'not-built'
  ) {
    invalid('INVALID_PDF_FIDELITY_SUITE_BINDING')
  }
}

function accuracyPolicyPasses(receipt, evalSet) {
  return (
    receipt.summary.present === receipt.summary.cases &&
    receipt.summary.overallScore >= evalSet.scoring.minimumOverallScore &&
    (!evalSet.scoring.requireAllCriticalCases ||
      receipt.summary.criticalPassed === receipt.summary.criticalCases)
  )
}

function runBinding(parts, role) {
  const receipts = parts.map((part) => part[`${role}Receipt`])
  const [first, ...rest] = receipts
  if (
    rest.some(
      (receipt) =>
        !sameJson(receipt.candidate, first.candidate) ||
        !sameJson(receipt.execution, first.execution),
    )
  ) {
    invalid('PDF_FIDELITY_SUITE_RUN_IDENTITY_MISMATCH')
  }
  return {
    candidate: structuredClone(first.candidate),
    execution: structuredClone(first.execution),
    receipts: parts.map((part) => {
      const receipt = part[`${role}Receipt`]
      return {
        evalSetId: part.evalSet.id,
        evalSetSha256: part.evalIdentity.evalSetSha256,
        predictionSha256: receipt.predictionSha256,
        receiptSha256: receipt.receiptSha256,
      }
    }),
  }
}

function suitePartBinding(part) {
  return {
    role: part.role,
    contract: {
      id: part.contract.id,
      schemaVersion: part.contract.schemaVersion,
      fileSha256: part.contractFileSha256,
    },
    evalSet: {
      id: part.evalSet.id,
      schemaVersion: part.evalSet.schemaVersion,
      annotationSchemaVersion: part.evalSet.annotationSchemaVersion,
      fileSha256: part.evalSetFileSha256,
      sha256: part.evalIdentity.evalSetSha256,
      documentIdentitySha256: part.evalIdentity.documentIdentitySha256,
      caseIdentitySha256: part.evalIdentity.caseIdentitySha256,
      caseCount: part.evalSet.cases.length,
    },
    observations: {
      id: part.observations.id,
      schemaVersion: part.observations.schemaVersion,
      fileSha256: part.observationsFileSha256,
      observationCount: part.observations.observations.length,
    },
  }
}

function buildCases(parts) {
  return parts.flatMap((part) => {
    const baseline = new Map(
      part.baselineReceipt.cases.map((item) => [item.caseId, item]),
    )
    return part.candidateReceipt.cases.map((candidate) => {
      const previous = baseline.get(candidate.caseId)
      const delta = rounded(candidate.score - previous.score)
      return {
        evalSetId: part.evalSet.id,
        caseId: candidate.caseId,
        failureMode: part.failureModes.get(candidate.caseId),
        task: candidate.task,
        stratum: candidate.stratum,
        critical: candidate.critical,
        baselinePassed: previous.passed,
        baselineScore: previous.score,
        passed: candidate.passed,
        score: candidate.score,
        delta,
        change: delta > 0 ? 'improved' : delta < 0 ? 'regressed' : 'unchanged',
      }
    })
  })
}

function aggregateFailureModes(cases) {
  const groups = new Map()
  for (const item of cases) {
    if (!groups.has(item.failureMode)) groups.set(item.failureMode, [])
    groups.get(item.failureMode).push(item)
  }
  return [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([failureMode, values]) => {
      const baselinePassed = values.filter((item) => item.baselinePassed).length
      const passed = values.filter((item) => item.passed).length
      return {
        failureMode,
        cases: values.length,
        baselinePassed,
        baselinePassRate: ratio(baselinePassed, values.length),
        passed,
        failed: values.length - passed,
        passRate: ratio(passed, values.length),
        regressions: values.filter(({ change }) => change === 'regressed')
          .length,
      }
    })
}

export async function buildPdfFidelitySuiteReceipt(input) {
  const [base, additive] = await Promise.all([
    normalizePart(input.base, 'base'),
    normalizePart(input.additive, 'additive'),
  ])
  await verifyRuntimeBinding()
  validateSuiteBindings(base, additive)
  const parts = [base, additive]
  const cases = buildCases(parts)
  const failureModes = aggregateFailureModes(cases)
  const receipt = {
    schemaVersion: PDF_FIDELITY_SUITE_RECEIPT_SCHEMA_VERSION,
    privacy: SUITE_PRIVACY,
    suite: {
      id: SUITE_ID,
      split: SUITE_SPLIT,
      blindHoldout: false,
      contractsSha256: sha256(
        [base.contractFileSha256, additive.contractFileSha256].join('\0'),
      ),
      aggregateIdentitySha256:
        additive.contract.aggregatePublicCalibration.identitySha256,
      caseCount: cases.length,
      failureModeCount: failureModes.length,
      parts: parts.map(suitePartBinding),
    },
    baseline: runBinding(parts, 'baseline'),
    candidate: runBinding(parts, 'candidate'),
    cases,
    failureModes,
    accuracyPassed: parts.every((part) =>
      accuracyPolicyPasses(part.candidateReceipt, part.evalSet),
    ),
    nonRegressionPassed: cases.every(({ change }) => change !== 'regressed'),
    promotionEligible: false,
  }
  return { ...receipt, receiptSha256: canonicalHash(receipt) }
}

export async function validatePdfFidelitySuiteReceipt(receipt, input) {
  try {
    if (
      !isRecord(receipt) ||
      receipt.schemaVersion !== PDF_FIDELITY_SUITE_RECEIPT_SCHEMA_VERSION ||
      receipt.privacy !== SUITE_PRIVACY ||
      receipt.suite?.split !== SUITE_SPLIT ||
      receipt.suite?.blindHoldout !== false ||
      receipt.promotionEligible !== false ||
      !SHA256.test(receipt.receiptSha256 ?? '') ||
      receipt.receiptSha256 !== canonicalHash(receiptWithoutHash(receipt))
    ) {
      invalid('INVALID_PDF_FIDELITY_SUITE_RECEIPT')
    }
    const expected = await buildPdfFidelitySuiteReceipt(input)
    if (!sameJson(receipt, expected)) {
      invalid('INVALID_PDF_FIDELITY_SUITE_RECEIPT')
    }
    return { valid: true }
  } catch {
    invalid('INVALID_PDF_FIDELITY_SUITE_RECEIPT')
  }
}

async function readJson(path, code) {
  const bytes = await readFile(path)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_JSON_BYTES) invalid(code)
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    invalid(code)
  }
}

function parseArguments(arguments_) {
  const values = {}
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    const value = arguments_[index + 1]
    if (
      !key?.startsWith('--') ||
      !value ||
      value.startsWith('--') ||
      Object.hasOwn(values, key.slice(2))
    ) {
      invalid('INVALID_USAGE')
    }
    values[key.slice(2)] = value
  }
  const required = [
    'baseline-v1-receipt',
    'baseline-v1-predictions',
    'baseline-v2-receipt',
    'baseline-v2-predictions',
    'candidate-v1-receipt',
    'candidate-v1-predictions',
    'candidate-v2-receipt',
    'candidate-v2-predictions',
    'out',
  ]
  if (
    Object.keys(values).length !== required.length ||
    required.some((key) => !values[key])
  ) {
    invalid('INVALID_USAGE')
  }
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, resolve(value)]),
  )
}

async function staticPart(role) {
  const paths = STATIC_PATHS[role]
  return {
    contractArtifact: await readFile(resolve(REPOSITORY_ROOT, paths.contract)),
    evalSetArtifact: await readFile(resolve(REPOSITORY_ROOT, paths.evalSet)),
    observationsArtifact: await readFile(
      resolve(REPOSITORY_ROOT, paths.observations),
    ),
  }
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2)
  if (command !== 'build') {
    process.stderr.write(
      'Usage: node tools/pdf-fidelity-suite.mjs build --baseline-v1-receipt <json> --baseline-v1-predictions <json> --baseline-v2-receipt <json> --baseline-v2-predictions <json> --candidate-v1-receipt <json> --candidate-v1-predictions <json> --candidate-v2-receipt <json> --candidate-v2-predictions <json> --out <json>\n',
    )
    process.exitCode = 2
    return
  }
  const paths = parseArguments(arguments_)
  const [base, additive] = await Promise.all([
    staticPart('base'),
    staticPart('additive'),
  ])
  Object.assign(base, {
    baselineReceipt: await readJson(
      paths['baseline-v1-receipt'],
      'INVALID_PDF_FIDELITY_EVAL_RECEIPT',
    ),
    baselinePredictions: await readJson(
      paths['baseline-v1-predictions'],
      'INVALID_PDF_FIDELITY_PREDICTIONS',
    ),
    candidateReceipt: await readJson(
      paths['candidate-v1-receipt'],
      'INVALID_PDF_FIDELITY_EVAL_RECEIPT',
    ),
    candidatePredictions: await readJson(
      paths['candidate-v1-predictions'],
      'INVALID_PDF_FIDELITY_PREDICTIONS',
    ),
  })
  Object.assign(additive, {
    baselineReceipt: await readJson(
      paths['baseline-v2-receipt'],
      'INVALID_PDF_FIDELITY_EVAL_RECEIPT',
    ),
    baselinePredictions: await readJson(
      paths['baseline-v2-predictions'],
      'INVALID_PDF_FIDELITY_PREDICTIONS',
    ),
    candidateReceipt: await readJson(
      paths['candidate-v2-receipt'],
      'INVALID_PDF_FIDELITY_EVAL_RECEIPT',
    ),
    candidatePredictions: await readJson(
      paths['candidate-v2-predictions'],
      'INVALID_PDF_FIDELITY_PREDICTIONS',
    ),
  })
  const input = { base, additive }
  const receipt = await buildPdfFidelitySuiteReceipt(input)
  await validatePdfFidelitySuiteReceipt(receipt, input)
  await writeFile(paths.out, `${JSON.stringify(receipt, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
  if (!receipt.accuracyPassed || !receipt.nonRegressionPassed) {
    process.exitCode = 1
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const code = SAFE_ID.test(error?.message ?? '')
      ? error.message
      : 'PDF_FIDELITY_SUITE_FAILED'
    process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`)
    process.exitCode = 2
  })
}

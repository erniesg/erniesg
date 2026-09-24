#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import Ajv2020 from 'ajv/dist/2020.js'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { Inflate } from 'fflate'
import {
  canonicalJson,
  validatePdfFidelityEvalSet,
} from './pdf-fidelity-eval.mjs'

export const PDF_BENCHMARK_READINESS_SCHEMA_VERSION = '1.0.0'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULT_SCHEMA_PATH = resolve(
  REPOSITORY_ROOT,
  'docs/schemas/pdf-benchmark-readiness-registry.schema.json',
)
const DEFAULT_SCHEMA_ID =
  'https://ernie.sg/schemas/pdf-benchmark-readiness-registry-1.0.0.json'
const DEFAULT_SCHEMA_SHA256 =
  '4b1f161abffadff696e022b074af6a91aacd75c6f9f02e9dc0ea7e85ceffe2df'
const PUBLIC_ERROR_CODE = /^(?:INVALID|MISSING|PDF)_[A-Z0-9_]+$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/
const SAFE_FAILURE_CLASS = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,11}$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_GOVERNANCE_JSON_BYTES = 16 * 1024 * 1024
const MAX_EPUB_COMPRESSED_BYTES = 256 * 1024 * 1024
const MAX_EPUB_INFLATED_BYTES = 512 * 1024 * 1024
const MAX_EPUB_ENTRIES = 544
// A legal comment may contain EOCD magic, but each candidate triggers a
// bounded full index parse. Allow normal nested comments without multiplying
// the 544-entry parser across the whole 65,535-byte comment space.
const MAX_EPUB_EOCD_CANDIDATES = 16
const MAX_EPUB_CONTAINER_BYTES = 64 * 1024
const MAX_EPUB_PACKAGE_DOCUMENT_BYTES = 4 * 1024 * 1024
const PROMOTION_PROTOCOL_IMPLEMENTED = false
const CANDIDATE_COMPONENT_KINDS = [
  'provider',
  'model',
  'adapter',
  'prompt',
  'config',
  'seed',
  'runtime',
]
const REQUIRED_METRICS = [
  'prose-transcript',
  'inline-semantics',
  'caption-completeness-and-ownership',
  'table-content-and-header-topology',
  'formula-content-and-layout',
  'bibliography-cardinality-and-content',
  'note-anchor-body-placement-and-content',
  'whole-document-reading-order',
  'profile-clipping-and-legibility',
  'abstention-risk-coverage',
  'review-gate-precision-recall',
  'package-integrity',
]
const PACKAGE_INTEGRITY_TEST_DEPENDENCIES = [
  'tools/pdf-private-fidelity.cases-support.mjs',
  'tools/pdf-private-fidelity-semantic.cases.mjs',
  'tools/pdf-private-fidelity-receipt.cases.mjs',
  'tools/pdf-private-fidelity-boundary.cases.mjs',
]
const REQUIRED_NATIVE_READER_TYPES = {
  'apple-books': 'apple-books',
  'independent-desktop-epub-reader': 'independent-desktop-epub-reader',
  'target-eink-reader-device': 'target-eink-reader-device',
}
const execFileAsync = promisify(execFile)

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function invalid(code) {
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

function unique(values) {
  return new Set(values).size === values.length
}

function sortedUnique(values) {
  return [...new Set(values)].sort()
}

function resolveRepositoryPath(repositoryPath) {
  if (
    typeof repositoryPath !== 'string' ||
    repositoryPath.startsWith('/') ||
    repositoryPath.includes('\\') ||
    repositoryPath.split('/').includes('..')
  ) {
    invalid('INVALID_PDF_BENCHMARK_REPOSITORY_PATH')
  }
  const absolute = resolve(REPOSITORY_ROOT, repositoryPath)
  if (
    absolute !== REPOSITORY_ROOT &&
    !absolute.startsWith(`${REPOSITORY_ROOT}${sep}`)
  ) {
    invalid('INVALID_PDF_BENCHMARK_REPOSITORY_PATH')
  }
  return absolute
}

async function descriptorRealPath(handle, code) {
  if (process.platform === 'linux') {
    return realpath(`/proc/self/fd/${handle.fd}`)
  }
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync(
      '/usr/sbin/lsof',
      ['-a', '-p', String(process.pid), '-d', String(handle.fd), '-Fn'],
      { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 5_000 },
    )
    const names = stdout
      .split('\n')
      .filter((line) => line.startsWith('n'))
      .map((line) => line.slice(1))
    if (
      names.length !== 1 ||
      !names[0].startsWith('/') ||
      names[0].endsWith(' (deleted)')
    ) {
      invalid(code)
    }
    return names[0]
  }
  invalid(code)
}

async function readStableRegularFile(path, maxBytes, code) {
  let handle
  try {
    const absolute = resolve(path)
    handle = await open(
      absolute,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    )
    const before = await handle.stat({ bigint: true })
    const [pathDetails, stableRealPath, openedRealPath] = await Promise.all([
      lstat(absolute, { bigint: true }),
      realpath(absolute),
      descriptorRealPath(handle, code),
    ])
    if (
      !before.isFile() ||
      !pathDetails.isFile() ||
      pathDetails.isSymbolicLink() ||
      before.dev !== pathDetails.dev ||
      before.ino !== pathDetails.ino ||
      openedRealPath !== stableRealPath ||
      before.size <= 0n ||
      before.size > BigInt(maxBytes)
    ) {
      invalid(code)
    }
    const expectedSize = Number(before.size)
    const bytes = Buffer.allocUnsafe(expectedSize)
    let offset = 0
    while (offset < expectedSize) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        expectedSize - offset,
        offset,
      )
      if (bytesRead === 0) invalid(code)
      offset += bytesRead
    }
    const probe = Buffer.allocUnsafe(1)
    const { bytesRead: trailingBytes } = await handle.read(
      probe,
      0,
      1,
      expectedSize,
    )
    const after = await handle.stat({ bigint: true })
    if (
      trailingBytes !== 0 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      invalid(code)
    }
    return { bytes, realPath: stableRealPath }
  } catch {
    invalid(code)
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function readJsonArtifact(path, code) {
  try {
    const { bytes } = await readStableRegularFile(
      path,
      MAX_GOVERNANCE_JSON_BYTES,
      code,
    )
    return {
      value: JSON.parse(bytes.toString('utf8')),
      bytes,
      fileSha256: sha256(bytes),
    }
  } catch {
    invalid(code)
  }
}

async function validateSchema(registry, schemaPath) {
  const schemaArtifact = await readJsonArtifact(
    schemaPath,
    'INVALID_PDF_BENCHMARK_REGISTRY_SCHEMA',
  )
  if (
    schemaArtifact.value.$id !== DEFAULT_SCHEMA_ID ||
    (resolve(schemaPath) === DEFAULT_SCHEMA_PATH &&
      schemaArtifact.fileSha256 !== DEFAULT_SCHEMA_SHA256)
  ) {
    invalid('INVALID_PDF_BENCHMARK_REGISTRY_SCHEMA')
  }
  const validate = new Ajv2020({ strict: false }).compile(schemaArtifact.value)
  if (!validate(registry)) {
    const detail = (validate.errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ')
    const failure = new Error('INVALID_PDF_BENCHMARK_REGISTRY')
    failure.cause = detail
    throw failure
  }
  return {
    id: schemaArtifact.value.$id,
    fileSha256: schemaArtifact.fileSha256,
  }
}

export async function verifyRepositoryFileBinding(
  repositoryPath,
  expectedSha256,
  code = 'PDF_BENCHMARK_METRIC_BINDING_MISMATCH',
  maxBytes = null,
) {
  try {
    const absolute = resolveRepositoryPath(repositoryPath)
    const [repositoryRealPath, fileRealPath] = await Promise.all([
      realpath(REPOSITORY_ROOT),
      realpath(absolute),
    ])
    if (
      fileRealPath !== repositoryRealPath &&
      !fileRealPath.startsWith(`${repositoryRealPath}${sep}`)
    ) {
      invalid(code)
    }
    const effectiveMaxBytes = maxBytes ?? MAX_EPUB_COMPRESSED_BYTES
    const { bytes, realPath: stableRealPath } = await readStableRegularFile(
      fileRealPath,
      effectiveMaxBytes,
      code,
    )
    if (
      stableRealPath !== fileRealPath ||
      (stableRealPath !== repositoryRealPath &&
        !stableRealPath.startsWith(`${repositoryRealPath}${sep}`))
    ) {
      invalid(code)
    }
    if (sha256(bytes) !== expectedSha256) {
      invalid(code)
    }
    return bytes
  } catch {
    invalid(code)
  }
}

async function readBoundJson(binding, code) {
  try {
    const bytes = await verifyRepositoryFileBinding(
      binding.path,
      binding.fileSha256,
      'PDF_BENCHMARK_METRIC_BINDING_MISMATCH',
      MAX_GOVERNANCE_JSON_BYTES,
    )
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    invalid(code)
  }
}

function finiteRate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null
}

function validJudgeCalibrationEvidence(
  value,
  metric,
  frozenCalibrationSplitIdentities,
) {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'kind',
      'metricId',
      'implementationSha256',
      'heldOutSplitIdentitySha256',
      'confusionMatrix',
    ]) ||
    value.schemaVersion !== '1.0.0' ||
    value.kind !== 'pdf-benchmark-judge-calibration-evidence' ||
    value.metricId !== metric.id ||
    value.implementationSha256 !== metric.implementationSha256 ||
    !SHA256.test(value.heldOutSplitIdentitySha256 ?? '') ||
    !frozenCalibrationSplitIdentities.has(value.heldOutSplitIdentitySha256) ||
    !exactKeys(value.confusionMatrix, [
      'truePositive',
      'falseNegative',
      'trueNegative',
      'falsePositive',
    ])
  ) {
    return null
  }
  const counts = value.confusionMatrix
  if (
    Object.values(counts).some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    )
  ) {
    return null
  }
  const truePositiveRate = finiteRate(
    counts.truePositive,
    counts.truePositive + counts.falseNegative,
  )
  const trueNegativeRate = finiteRate(
    counts.trueNegative,
    counts.trueNegative + counts.falsePositive,
  )
  return truePositiveRate === null || trueNegativeRate === null
    ? null
    : { truePositiveRate, trueNegativeRate }
}

function judgeCalibrationOutputIdentitySha256(metric, calibrationEvidence) {
  return sha256(
    canonicalJson({
      kind: 'pdf-benchmark-judge-calibration-output-v1',
      metricId: metric.id,
      implementationSha256: metric.implementationSha256,
      heldOutSplitIdentitySha256:
        calibrationEvidence.heldOutSplitIdentitySha256,
      confusionMatrix: calibrationEvidence.confusionMatrix,
    }),
  )
}

function validJudgeExecutionReceipt(
  value,
  metric,
  calibration,
  calibrationEvidence,
) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'kind',
      'metricId',
      'implementationSha256',
      'calibrationEvidenceFileSha256',
      'inputIdentitySha256',
      'outputIdentitySha256',
      'status',
    ]) &&
    value.schemaVersion === '1.0.0' &&
    value.kind === 'pdf-benchmark-judge-calibration-execution-receipt' &&
    value.metricId === metric.id &&
    value.implementationSha256 === metric.implementationSha256 &&
    value.calibrationEvidenceFileSha256 === calibration.evidence.fileSha256 &&
    value.inputIdentitySha256 ===
      calibrationEvidence.heldOutSplitIdentitySha256 &&
    value.outputIdentitySha256 ===
      judgeCalibrationOutputIdentitySha256(metric, calibrationEvidence) &&
    value.status === 'passed'
  )
}

async function validateMetricImplementations(registry) {
  const metricIds = registry.metricImplementations.map((metric) => metric.id)
  if (
    !unique(metricIds) ||
    REQUIRED_METRICS.some((id) => !metricIds.includes(id))
  ) {
    invalid('PDF_BENCHMARK_INCOMPLETE_METRIC_REGISTRY')
  }
  const frozenCalibrationSplitIdentities = new Set(
    registry.splits
      .filter(
        (split) =>
          split.status === 'frozen' &&
          ['public-calibration', 'development'].includes(split.role),
      )
      .map((split) => split.frozenIdentitySha256),
  )
  const verifiedMetricIds = []
  for (const metric of registry.metricImplementations) {
    if (metric.status !== 'available') continue
    if (metric.id === 'package-integrity') {
      const dependencies = metric.testDependencies
      if (
        !Array.isArray(dependencies) ||
        dependencies.length !== PACKAGE_INTEGRITY_TEST_DEPENDENCIES.length ||
        new Set(dependencies.map((dependency) => dependency.path)).size !==
          dependencies.length ||
        !PACKAGE_INTEGRITY_TEST_DEPENDENCIES.every((path) =>
          dependencies.some((dependency) => dependency.path === path),
        )
      ) {
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      }
    }
    await Promise.all([
      verifyRepositoryFileBinding(
        metric.implementation,
        metric.implementationSha256,
      ),
      verifyRepositoryFileBinding(metric.test, metric.testSha256),
      ...(metric.testDependencies ?? []).map((dependency) =>
        verifyRepositoryFileBinding(dependency.path, dependency.fileSha256),
      ),
    ])
    if (metric.kind === 'calibrated-judge') {
      const [calibrationEvidence, executionReceipt] = await Promise.all([
        readBoundJson(
          metric.calibration.evidence,
          'PDF_BENCHMARK_JUDGE_CALIBRATION_MISMATCH',
        ),
        readBoundJson(
          metric.calibration.executionReceipt,
          'PDF_BENCHMARK_JUDGE_CALIBRATION_MISMATCH',
        ),
      ])
      const rates = validJudgeCalibrationEvidence(
        calibrationEvidence,
        metric,
        frozenCalibrationSplitIdentities,
      )
      if (
        rates === null ||
        !validJudgeExecutionReceipt(
          executionReceipt,
          metric,
          metric.calibration,
          calibrationEvidence,
        ) ||
        rates.truePositiveRate <
          registry.protocol.minimumJudgeTruePositiveRate ||
        rates.trueNegativeRate <
          registry.protocol.minimumJudgeTrueNegativeRate ||
        calibrationEvidence.confusionMatrix.truePositive +
          calibrationEvidence.confusionMatrix.falseNegative <
          registry.protocol.minimumJudgePositiveExamples ||
        calibrationEvidence.confusionMatrix.trueNegative +
          calibrationEvidence.confusionMatrix.falsePositive <
          registry.protocol.minimumJudgeNegativeExamples
      ) {
        invalid('PDF_BENCHMARK_JUDGE_CALIBRATION_MISMATCH')
      }
    }
    verifiedMetricIds.push(metric.id)
  }
  return verifiedMetricIds
}

export function validateObservationBinding(
  observations,
  evalSet,
  source,
  validateObservations,
) {
  const evalSetIdentity = validatePdfFidelityEvalSet(evalSet)
  if (
    !validateObservations(observations) ||
    !exactKeys(observations, [
      'schemaVersion',
      'id',
      'privacy',
      'evalSet',
      'method',
      'observations',
    ]) ||
    !SAFE_ID.test(observations.id ?? '') ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(observations.privacy ?? '') ||
    !Array.isArray(observations.observations)
  ) {
    invalid('INVALID_PDF_BENCHMARK_OBSERVATIONS')
  }
  const expectedCandidateOutputConsulted =
    source.selectionStatus === 'complaint-driven-candidate-output-consulted'
  if (
    observations.method?.candidateOutputConsulted !==
      expectedCandidateOutputConsulted ||
    (source.labelVisibility === 'public' &&
      !observations.privacy.startsWith('public-')) ||
    (source.labelVisibility === 'private' &&
      !observations.privacy.startsWith('private-'))
  ) {
    invalid('PDF_BENCHMARK_OBSERVATION_POLICY_MISMATCH')
  }
  if (
    !isRecord(source.evalSet) ||
    !exactKeys(observations.evalSet, [
      'path',
      'fileSha256',
      'evalSetSha256',
      'documentIdentitySha256',
      'caseIdentitySha256',
    ]) ||
    observations.evalSet.path !== source.evalSet.path ||
    observations.evalSet.fileSha256 !== source.evalSet.fileSha256 ||
    observations.evalSet.evalSetSha256 !== evalSetIdentity.evalSetSha256 ||
    observations.evalSet.documentIdentitySha256 !==
      evalSetIdentity.documentIdentitySha256 ||
    observations.evalSet.caseIdentitySha256 !==
      evalSetIdentity.caseIdentitySha256
  ) {
    invalid('PDF_BENCHMARK_OBSERVATION_EVAL_SET_MISMATCH')
  }
  const cases = new Map(evalSet.cases.map((item) => [item.id, item]))
  const documents = new Map(evalSet.documents.map((item) => [item.id, item]))
  const observedIds = observations.observations.map((item) => item.caseId)
  if (
    observedIds.length !== cases.size ||
    !unique(observedIds) ||
    observedIds.some((caseId) => !cases.has(caseId))
  ) {
    invalid('PDF_BENCHMARK_OBSERVATION_CASE_MISMATCH')
  }

  for (const observation of observations.observations) {
    if (
      !exactKeys(observation, [
        'caseId',
        'firstFailureClass',
        'sourceArtifact',
        'evaluator',
      ]) ||
      !SAFE_FAILURE_CLASS.test(observation.firstFailureClass ?? '') ||
      /(?:[/\\:]|\.\.?|\s|(?:^|-)(?:users?|home|private|tmp|var|desktop|downloads)(?:-|$))/iu.test(
        observation.firstFailureClass,
      )
    ) {
      invalid('INVALID_PDF_BENCHMARK_FAILURE_CLASS')
    }
    const item = cases.get(observation.caseId)
    const document = documents.get(item.documentId)
    const sourceArtifact = observation.sourceArtifact
    if (
      !isRecord(sourceArtifact) ||
      sourceArtifact.documentId !== item.documentId ||
      sourceArtifact.sourcePdfSha256 !== document.sha256 ||
      typeof observation.firstFailureClass !== 'string'
    ) {
      invalid('PDF_BENCHMARK_OBSERVATION_SOURCE_MISMATCH')
    }
    const pages = Array.isArray(sourceArtifact.pages)
      ? sourceArtifact.pages
      : [sourceArtifact.page]
    if (
      pages.length === 0 ||
      pages.some(
        (page) =>
          !Number.isSafeInteger(page) || page < 1 || page > document.pageCount,
      )
    ) {
      invalid('PDF_BENCHMARK_OBSERVATION_PAGE_MISMATCH')
    }
  }

  if (
    source.labelVisibility === 'private' &&
    source.selectionStatus === 'complaint-driven-candidate-output-consulted'
  ) {
    invalid('PDF_BENCHMARK_PRIVATE_LABEL_SELECTION_LEAKAGE')
  }
}

async function loadSource(source) {
  const [evalSetBytes, observationsBytes, observationsSchemaBytes] =
    await Promise.all([
      verifyRepositoryFileBinding(
        source.evalSet.path,
        source.evalSet.fileSha256,
        'PDF_BENCHMARK_SOURCE_HASH_MISMATCH',
      ),
      verifyRepositoryFileBinding(
        source.observations.path,
        source.observations.fileSha256,
        'PDF_BENCHMARK_SOURCE_HASH_MISMATCH',
      ),
      verifyRepositoryFileBinding(
        source.observations.schema.path,
        source.observations.schema.fileSha256,
        'PDF_BENCHMARK_OBSERVATION_SCHEMA_MISMATCH',
      ),
    ])
  const evalSet = JSON.parse(evalSetBytes.toString('utf8'))
  const observations = JSON.parse(observationsBytes.toString('utf8'))
  const observationsSchema = JSON.parse(
    observationsSchemaBytes.toString('utf8'),
  )
  const validateObservations = new Ajv2020({ strict: false }).compile(
    observationsSchema,
  )
  const identity = validatePdfFidelityEvalSet(evalSet)
  validateObservationBinding(
    observations,
    evalSet,
    source,
    validateObservations,
  )
  return {
    source,
    evalSet,
    observations,
    identity,
  }
}

function validFileBindingShape(value) {
  return (
    exactKeys(value, ['path', 'fileSha256']) &&
    typeof value.path === 'string' &&
    SHA256.test(value.fileSha256 ?? '')
  )
}

function validTemplateFamilyReviewDecision(value, binding, reviewerId) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'kind',
      'documentId',
      'sourcePdfSha256',
      'templateFamilyId',
      'reviewerId',
      'method',
      'sourceOnly',
      'decision',
    ]) &&
    value.schemaVersion === '1.0.0' &&
    value.kind === 'pdf-template-family-assignment-review-evidence' &&
    value.documentId === binding.documentId &&
    value.sourcePdfSha256 === binding.sourcePdfSha256 &&
    value.templateFamilyId === binding.templateFamilyId &&
    value.reviewerId === reviewerId &&
    value.method === 'source-template-structure-review' &&
    value.sourceOnly === true &&
    value.decision === 'confirmed'
  )
}

async function validTemplateFamilyEvidence(value, binding) {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'kind',
      'documentId',
      'sourcePdfSha256',
      'templateFamilyId',
      'method',
      'reviewers',
    ]) ||
    value.schemaVersion !== '1.0.0' ||
    value.kind !== 'pdf-template-family-assignment-evidence' ||
    value.documentId !== binding.documentId ||
    value.sourcePdfSha256 !== binding.sourcePdfSha256 ||
    value.templateFamilyId !== binding.templateFamilyId ||
    value.method !== 'source-template-structure-review' ||
    !Array.isArray(value.reviewers) ||
    value.reviewers.length < 2 ||
    value.reviewers.some(
      (reviewer) =>
        !exactKeys(reviewer, [
          'reviewerId',
          'identityEvidence',
          'decisionEvidence',
        ]) ||
        !SAFE_ID.test(reviewer.reviewerId ?? '') ||
        !validFileBindingShape(reviewer.identityEvidence) ||
        !validFileBindingShape(reviewer.decisionEvidence),
    ) ||
    !unique(value.reviewers.map((reviewer) => reviewer.reviewerId)) ||
    !unique(
      value.reviewers.map((reviewer) => reviewer.identityEvidence.fileSha256),
    ) ||
    !unique(
      value.reviewers.map((reviewer) => reviewer.decisionEvidence.fileSha256),
    )
  ) {
    return null
  }
  const verifiedReviewers = await Promise.all(
    value.reviewers.map(async (reviewer) => {
      const [identity, decision] = await Promise.all([
        readBoundJson(
          reviewer.identityEvidence,
          'PDF_BENCHMARK_TEMPLATE_FAMILY_EVIDENCE_MISMATCH',
        ),
        readBoundJson(
          reviewer.decisionEvidence,
          'PDF_BENCHMARK_TEMPLATE_FAMILY_EVIDENCE_MISMATCH',
        ),
      ])
      if (
        !validReviewerIdentityEvidence(identity, reviewer.reviewerId) ||
        !validTemplateFamilyReviewDecision(
          decision,
          binding,
          reviewer.reviewerId,
        )
      ) {
        invalid('PDF_BENCHMARK_TEMPLATE_FAMILY_EVIDENCE_MISMATCH')
      }
      return {
        reviewerId: reviewer.reviewerId,
        identityEvidenceFileSha256: reviewer.identityEvidence.fileSha256,
        subjectIdentitySha256: identity.subjectIdentitySha256,
      }
    }),
  )
  return unique(
    verifiedReviewers.map((reviewer) => reviewer.subjectIdentitySha256),
  )
    ? verifiedReviewers
    : null
}

export function validateSourcePdfDocumentIdentities(documents) {
  const identityByDocument = new Map()
  const documentIdBySourceSha = new Map()
  for (const document of documents) {
    const identity = {
      sha256: document.sha256,
      byteLength: document.byteLength,
      pageCount: document.pageCount,
    }
    const priorIdentity = identityByDocument.get(document.id)
    const priorDocumentId = documentIdBySourceSha.get(document.sha256)
    if (
      (priorIdentity !== undefined &&
        canonicalJson(priorIdentity) !== canonicalJson(identity)) ||
      (priorDocumentId !== undefined && priorDocumentId !== document.id)
    ) {
      invalid(
        priorDocumentId !== undefined && priorDocumentId !== document.id
          ? 'PDF_BENCHMARK_SOURCE_PDF_ALIAS_COLLISION'
          : 'PDF_BENCHMARK_DOCUMENT_IDENTITY_COLLISION',
      )
    }
    identityByDocument.set(document.id, identity)
    documentIdBySourceSha.set(document.sha256, document.id)
  }
  return new Map(
    [...identityByDocument.entries()].map(([documentId, identity]) => [
      documentId,
      identity.sha256,
    ]),
  )
}

async function validateDocumentBindings(registry, loadedSources) {
  const sourcePoliciesByDocument = new Map()
  const sourceShaByDocument = validateSourcePdfDocumentIdentities(
    loadedSources.flatMap((loaded) => loaded.evalSet.documents),
  )
  for (const loaded of loadedSources) {
    for (const document of loaded.evalSet.documents) {
      const policies = sourcePoliciesByDocument.get(document.id) ?? []
      policies.push({
        sourceId: loaded.source.id,
        sourcePdfSha256: document.sha256,
        labelVisibility: loaded.source.labelVisibility,
        oracleLocalized: loaded.source.oracleLocalized,
        selectionStatus: loaded.source.selectionStatus,
      })
      sourcePoliciesByDocument.set(document.id, policies)
    }
  }

  const bindingsByDocument = new Map()
  const verifiedTemplateBindings = new Map()
  const templateIdentityByReviewerId = new Map()
  const templateReviewerIdBySubjectIdentity = new Map()
  for (const binding of registry.documentBindings) {
    if (
      bindingsByDocument.has(binding.documentId) ||
      sourceShaByDocument.get(binding.documentId) !== binding.sourcePdfSha256
    ) {
      invalid('PDF_BENCHMARK_DOCUMENT_BINDING_MISMATCH')
    }
    bindingsByDocument.set(binding.documentId, binding)
    if (binding.templateFamilyId === null) continue
    const evidence = await readBoundJson(
      binding.templateFamilyEvidence,
      'PDF_BENCHMARK_TEMPLATE_FAMILY_EVIDENCE_MISMATCH',
    )
    const verifiedReviewers = await validTemplateFamilyEvidence(
      evidence,
      binding,
    )
    if (verifiedReviewers === null) {
      invalid('PDF_BENCHMARK_TEMPLATE_FAMILY_EVIDENCE_MISMATCH')
    }
    for (const reviewer of verifiedReviewers) {
      const priorIdentity = templateIdentityByReviewerId.get(
        reviewer.reviewerId,
      )
      const priorReviewerId = templateReviewerIdBySubjectIdentity.get(
        reviewer.subjectIdentitySha256,
      )
      if (
        (priorIdentity !== undefined &&
          (priorIdentity.identityEvidenceFileSha256 !==
            reviewer.identityEvidenceFileSha256 ||
            priorIdentity.subjectIdentitySha256 !==
              reviewer.subjectIdentitySha256)) ||
        (priorReviewerId !== undefined &&
          priorReviewerId !== reviewer.reviewerId)
      ) {
        invalid('PDF_BENCHMARK_TEMPLATE_REVIEW_IDENTITY_INCONSISTENCY')
      }
      templateIdentityByReviewerId.set(reviewer.reviewerId, reviewer)
      templateReviewerIdBySubjectIdentity.set(
        reviewer.subjectIdentitySha256,
        reviewer.reviewerId,
      )
    }
    verifiedTemplateBindings.set(binding.documentId, {
      documentId: binding.documentId,
      sourcePdfSha256: binding.sourcePdfSha256,
      templateFamilyId: binding.templateFamilyId,
      templateFamilyEvidenceSha256: binding.templateFamilyEvidence.fileSha256,
    })
  }
  if (
    bindingsByDocument.size !== sourceShaByDocument.size ||
    [...sourceShaByDocument.keys()].some(
      (documentId) => !bindingsByDocument.has(documentId),
    )
  ) {
    invalid('PDF_BENCHMARK_DOCUMENT_BINDING_MISMATCH')
  }
  return {
    bindingsByDocument,
    sourcePoliciesByDocument,
    verifiedTemplateBindings,
  }
}

export function createPdfBenchmarkSplitIdentitySha256(
  split,
  verifiedDocumentBindings,
) {
  const bindings =
    verifiedDocumentBindings instanceof Map
      ? verifiedDocumentBindings
      : new Map(
          (verifiedDocumentBindings ?? []).map((binding) => [
            binding.documentId,
            binding,
          ]),
        )
  const documents = sortedUnique(split.documentIds).map((documentId) => {
    const binding = bindings.get(documentId)
    if (
      !binding ||
      !SHA256.test(binding.sourcePdfSha256 ?? '') ||
      !SAFE_ID.test(binding.templateFamilyId ?? '') ||
      !SHA256.test(binding.templateFamilyEvidenceSha256 ?? '')
    ) {
      invalid('PDF_BENCHMARK_INCOMPLETE_FROZEN_SPLIT_BINDING')
    }
    return {
      documentId,
      sourcePdfSha256: binding.sourcePdfSha256,
      templateFamilyId: binding.templateFamilyId,
      templateFamilyEvidenceSha256: binding.templateFamilyEvidenceSha256,
    }
  })
  return sha256(
    canonicalJson({
      kind: 'pdf-benchmark-split-identity-v1',
      id: split.id,
      role: split.role,
      labelVisibility: split.labelVisibility,
      documents,
    }),
  )
}

function validateSplits(registry, allDocumentIds, verifiedTemplateBindings) {
  const knownDocumentIds = new Set(allDocumentIds)
  const splitIds = registry.splits.map((split) => split.id)
  const roles = registry.splits.map((split) => split.role)
  if (!unique(splitIds) || !unique(roles)) {
    invalid('PDF_BENCHMARK_DUPLICATE_SPLIT')
  }
  const requiredRoles = [
    'public-calibration',
    'train',
    'development',
    'blind-test',
  ]
  if (requiredRoles.some((role) => !roles.includes(role))) {
    invalid('PDF_BENCHMARK_MISSING_SPLIT')
  }

  const assignedDocuments = new Map()
  const assignedFamilies = new Map()
  const splitIdentitySha256s = {}
  for (const split of registry.splits) {
    const verifiedBindings = split.documentIds.flatMap((documentId) => {
      const binding = verifiedTemplateBindings.get(documentId)
      return binding ? [binding] : []
    })
    const derivedFamilyIds = sortedUnique(
      verifiedBindings.map((binding) => binding.templateFamilyId),
    )
    if (
      canonicalJson(sortedUnique(split.templateFamilyIds)) !==
      canonicalJson(derivedFamilyIds)
    ) {
      invalid('PDF_BENCHMARK_TEMPLATE_FAMILY_MAPPING_MISMATCH')
    }
    if (
      split.status === 'frozen' &&
      (split.documentIds.length === 0 ||
        verifiedBindings.length !== split.documentIds.length ||
        split.frozenIdentitySha256 !==
          createPdfBenchmarkSplitIdentitySha256(
            split,
            verifiedTemplateBindings,
          ))
    ) {
      invalid('PDF_BENCHMARK_INVALID_FROZEN_SPLIT')
    }
    splitIdentitySha256s[split.role] =
      split.status === 'frozen' ? split.frozenIdentitySha256 : null
    if (split.status !== 'frozen' && split.frozenIdentitySha256 !== null) {
      invalid('PDF_BENCHMARK_UNFROZEN_SPLIT_HAS_IDENTITY')
    }
    for (const documentId of split.documentIds) {
      if (!knownDocumentIds.has(documentId)) {
        invalid('PDF_BENCHMARK_UNKNOWN_SPLIT_DOCUMENT')
      }
      if (assignedDocuments.has(documentId)) {
        invalid('PDF_BENCHMARK_DOCUMENT_SPLIT_LEAKAGE')
      }
      assignedDocuments.set(documentId, split.id)
    }
    for (const familyId of derivedFamilyIds) {
      if (assignedFamilies.has(familyId)) {
        invalid('PDF_BENCHMARK_TEMPLATE_FAMILY_SPLIT_LEAKAGE')
      }
      assignedFamilies.set(familyId, split.id)
    }
  }

  if (allDocumentIds.some((documentId) => !assignedDocuments.has(documentId))) {
    invalid('PDF_BENCHMARK_UNASSIGNED_DOCUMENT')
  }
  return {
    documentDisjoint: true,
    templateFamilyDisjoint: true,
    verifiedSourceTemplateBindingCount: verifiedTemplateBindings.size,
    splitIdentitySha256s,
  }
}

function validReviewerIdentityEvidence(value, reviewerId) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'kind',
      'reviewerId',
      'identityAuthority',
      'subjectIdentitySha256',
    ]) &&
    value.schemaVersion === '1.0.0' &&
    value.kind === 'pdf-benchmark-reviewer-identity-evidence' &&
    value.reviewerId === reviewerId &&
    value.identityAuthority === 'verified-benchmark-reviewer-roster' &&
    SHA256.test(value.subjectIdentitySha256 ?? '')
  )
}

function validReviewDecisionEvidence(
  value,
  {
    caseId,
    reviewerId,
    protocolVersion,
    kind = 'pdf-benchmark-initial-review-decision-evidence',
  },
) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'kind',
      'caseId',
      'reviewerId',
      'protocolVersion',
      'sourceOnly',
      'candidateOutputConsultedForLabel',
      'decisionSha256',
    ]) &&
    value.schemaVersion === '1.0.0' &&
    value.kind === kind &&
    value.caseId === caseId &&
    value.reviewerId === reviewerId &&
    value.protocolVersion === protocolVersion &&
    value.sourceOnly === true &&
    value.candidateOutputConsultedForLabel === false &&
    SHA256.test(value.decisionSha256 ?? '')
  )
}

async function validateReviewerEvidence(reviewer, bundle, kind) {
  const [identity, decision] = await Promise.all([
    readBoundJson(
      reviewer.identityEvidence,
      'PDF_BENCHMARK_REVIEW_EVIDENCE_MISMATCH',
    ),
    readBoundJson(
      reviewer.decisionEvidence,
      'PDF_BENCHMARK_REVIEW_EVIDENCE_MISMATCH',
    ),
  ])
  if (
    !validReviewerIdentityEvidence(identity, reviewer.reviewerId) ||
    !validReviewDecisionEvidence(decision, {
      caseId: bundle.caseId,
      reviewerId: reviewer.reviewerId,
      protocolVersion: bundle.protocolVersion,
      kind,
    })
  ) {
    invalid('PDF_BENCHMARK_REVIEW_EVIDENCE_MISMATCH')
  }
  return {
    subjectIdentitySha256: identity.subjectIdentitySha256,
    decisionSha256: decision.decisionSha256,
  }
}

async function validateReviewBundles(registry, allCaseIds) {
  const caseIds = registry.reviewBundles.map((bundle) => bundle.caseId)
  if (!unique(caseIds) || caseIds.some((caseId) => !allCaseIds.has(caseId))) {
    invalid('PDF_BENCHMARK_INVALID_REVIEW_BUNDLE_CASE')
  }
  const identityByReviewerId = new Map()
  const reviewerIdBySubjectIdentity = new Map()
  const bindReviewerIdentity = (
    reviewerId,
    identityEvidenceFileSha256,
    subjectIdentitySha256,
  ) => {
    const priorIdentity = identityByReviewerId.get(reviewerId)
    const priorReviewerId = reviewerIdBySubjectIdentity.get(
      subjectIdentitySha256,
    )
    if (
      (priorIdentity !== undefined &&
        (priorIdentity.identityEvidenceFileSha256 !==
          identityEvidenceFileSha256 ||
          priorIdentity.subjectIdentitySha256 !== subjectIdentitySha256)) ||
      (priorReviewerId !== undefined && priorReviewerId !== reviewerId)
    ) {
      invalid('PDF_BENCHMARK_REVIEW_IDENTITY_INCONSISTENCY')
    }
    identityByReviewerId.set(reviewerId, {
      identityEvidenceFileSha256,
      subjectIdentitySha256,
    })
    reviewerIdBySubjectIdentity.set(subjectIdentitySha256, reviewerId)
  }
  for (const bundle of registry.reviewBundles) {
    const reviewerIds = bundle.reviewers.map((reviewer) => reviewer.reviewerId)
    const identityEvidenceHashes = bundle.reviewers.map(
      (reviewer) => reviewer.identityEvidence.fileSha256,
    )
    const decisionEvidenceHashes = bundle.reviewers.map(
      (reviewer) => reviewer.decisionEvidence.fileSha256,
    )
    if (
      bundle.reviewers.length <
        registry.protocol.requiredIndependentReviewers ||
      !unique(reviewerIds) ||
      !unique(identityEvidenceHashes) ||
      !unique(decisionEvidenceHashes) ||
      (bundle.disagreement && bundle.adjudication === null) ||
      (!bundle.disagreement && bundle.adjudication !== null)
    ) {
      invalid('PDF_BENCHMARK_INVALID_REVIEW_BUNDLE')
    }
    const verifiedReviewers = await Promise.all(
      bundle.reviewers.map((reviewer) =>
        validateReviewerEvidence(
          reviewer,
          bundle,
          'pdf-benchmark-initial-review-decision-evidence',
        ),
      ),
    )
    bundle.reviewers.forEach((reviewer, index) => {
      bindReviewerIdentity(
        reviewer.reviewerId,
        reviewer.identityEvidence.fileSha256,
        verifiedReviewers[index].subjectIdentitySha256,
      )
    })
    if (
      !unique(
        verifiedReviewers.map((reviewer) => reviewer.subjectIdentitySha256),
      ) ||
      new Set(verifiedReviewers.map((reviewer) => reviewer.decisionSha256))
        .size >
        1 !==
        bundle.disagreement
    ) {
      invalid('PDF_BENCHMARK_INVALID_REVIEW_BUNDLE')
    }
    if (bundle.adjudication) {
      if (reviewerIds.includes(bundle.adjudication.adjudicatorId)) {
        invalid('PDF_BENCHMARK_INVALID_REVIEW_BUNDLE')
      }
      const verifiedAdjudicator = await validateReviewerEvidence(
        {
          reviewerId: bundle.adjudication.adjudicatorId,
          identityEvidence: bundle.adjudication.identityEvidence,
          decisionEvidence: bundle.adjudication.decisionEvidence,
        },
        bundle,
        'pdf-benchmark-adjudication-decision-evidence',
      )
      bindReviewerIdentity(
        bundle.adjudication.adjudicatorId,
        bundle.adjudication.identityEvidence.fileSha256,
        verifiedAdjudicator.subjectIdentitySha256,
      )
      if (
        verifiedReviewers.some(
          (reviewer) =>
            reviewer.subjectIdentitySha256 ===
            verifiedAdjudicator.subjectIdentitySha256,
        )
      ) {
        invalid('PDF_BENCHMARK_INVALID_REVIEW_BUNDLE')
      }
    }
  }
  return new Set(caseIds)
}

function observedFinalNoNewClassWindow(registry, classByCase, allCaseIds) {
  if (registry.discoveryOrder.status !== 'recorded') return 0
  const order = registry.discoveryOrder.caseIds
  if (
    order.length !== allCaseIds.size ||
    !unique(order) ||
    order.some((caseId) => !allCaseIds.has(caseId))
  ) {
    invalid('PDF_BENCHMARK_INVALID_DISCOVERY_ORDER')
  }
  const seen = new Set()
  let lastNovelIndex = -1
  for (let index = 0; index < order.length; index += 1) {
    const failureClass = classByCase.get(order[index])
    if (!seen.has(failureClass)) {
      seen.add(failureClass)
      lastNovelIndex = index
    }
  }
  return order.length - lastNovelIndex - 1
}

function criterion(id, passed, observed, required) {
  return { id, passed, observed, required }
}

function candidateComponentCommitmentSha256(components) {
  return sha256(
    canonicalJson({
      kind: 'pdf-benchmark-candidate-component-commitment-v1',
      components: [...components]
        .map((component) => ({
          kind: component.kind,
          id: component.id,
          version: component.version,
          artifactFileSha256: component.artifact.fileSha256,
        }))
        .sort((left, right) => left.kind.localeCompare(right.kind)),
    }),
  )
}

function validCandidateAuthorityEvidence(value) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'kind',
      'authorityId',
      'authorityRole',
      'authorizationScope',
      'subjectIdentitySha256',
    ]) &&
    value.schemaVersion === '1.0.0' &&
    value.kind === 'pdf-benchmark-custodian-authority-evidence' &&
    SAFE_ID.test(value.authorityId ?? '') &&
    value.authorityRole === 'independent-benchmark-custodian' &&
    value.authorizationScope ===
      'witness-candidate-freeze-before-private-label-reveal' &&
    SHA256.test(value.subjectIdentitySha256 ?? '')
  )
}

function validCandidateCommitmentReceipt(
  value,
  commitment,
  componentCommitmentSha256,
  authorityEvidence,
) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'kind',
      'candidateComponentCommitmentSha256',
      'blindSplitIdentitySha256',
      'labelStateAtCommitment',
      'authorityId',
      'authorityEvidenceFileSha256',
    ]) &&
    value.schemaVersion === '1.0.0' &&
    value.kind === 'pdf-benchmark-candidate-freeze-receipt' &&
    value.candidateComponentCommitmentSha256 === componentCommitmentSha256 &&
    value.blindSplitIdentitySha256 === commitment.blindSplitIdentitySha256 &&
    value.labelStateAtCommitment === 'private-labels-withheld' &&
    value.authorityId === authorityEvidence.authorityId &&
    value.authorityEvidenceFileSha256 ===
      commitment.authorityEvidence.fileSha256
  )
}

export async function validateCandidateCommitment(registry) {
  const commitment = registry.candidateCommitment
  if (commitment.status === 'not-built') {
    return { verified: false, componentCommitmentSha256: null }
  }
  const blind = registry.splits.find((split) => split.role === 'blind-test')
  const componentKinds = commitment.components.map(
    (component) => component.kind,
  )
  if (
    commitment.status !== 'frozen' ||
    commitment.committedBeforePrivateLabelReveal !== true ||
    blind.status !== 'frozen' ||
    commitment.blindSplitIdentitySha256 !== blind.frozenIdentitySha256 ||
    !unique(componentKinds) ||
    CANDIDATE_COMPONENT_KINDS.some((kind) => !componentKinds.includes(kind)) ||
    componentKinds.some((kind) => !CANDIDATE_COMPONENT_KINDS.includes(kind))
  ) {
    invalid('PDF_BENCHMARK_CANDIDATE_COMMITMENT_MISMATCH')
  }
  const verifiedCommitmentArtifacts = await Promise.all([
    ...commitment.components.map((component) =>
      verifyRepositoryFileBinding(
        component.artifact.path,
        component.artifact.fileSha256,
        'PDF_BENCHMARK_CANDIDATE_COMMITMENT_MISMATCH',
      ),
    ),
    readBoundJson(
      commitment.authorityEvidence,
      'PDF_BENCHMARK_CANDIDATE_COMMITMENT_MISMATCH',
    ),
  ])
  const authorityEvidence = verifiedCommitmentArtifacts.at(-1)
  if (!validCandidateAuthorityEvidence(authorityEvidence)) {
    invalid('PDF_BENCHMARK_CANDIDATE_COMMITMENT_MISMATCH')
  }
  const componentCommitmentSha256 = candidateComponentCommitmentSha256(
    commitment.components,
  )
  const receipt = await readBoundJson(
    commitment.commitmentReceipt,
    'PDF_BENCHMARK_CANDIDATE_COMMITMENT_MISMATCH',
  )
  if (
    !validCandidateCommitmentReceipt(
      receipt,
      commitment,
      componentCommitmentSha256,
      authorityEvidence,
    )
  ) {
    invalid('PDF_BENCHMARK_CANDIDATE_COMMITMENT_MISMATCH')
  }
  return { verified: true, componentCommitmentSha256 }
}

function validIsolationAttestorIdentity(value) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'kind',
      'attestorId',
      'identityAuthority',
      'subjectIdentitySha256',
    ]) &&
    value.schemaVersion === '1.0.0' &&
    value.kind === 'pdf-benchmark-isolation-attestor-identity-evidence' &&
    SAFE_ID.test(value.attestorId ?? '') &&
    value.identityAuthority ===
      'verified-independent-isolation-attestor-roster' &&
    SHA256.test(value.subjectIdentitySha256 ?? '')
  )
}

function validIsolationExecutionReceipt(
  value,
  track,
  blind,
  componentCommitmentSha256,
  identity,
  identityEvidenceFileSha256,
) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'kind',
      'trackId',
      'attestorId',
      'attestorIdentityEvidenceFileSha256',
      'blindSplitIdentitySha256',
      'candidateComponentCommitmentSha256',
      'networkIsolation',
      'filesystemIsolation',
      'runnerIdentitySha256',
      'executionIdentitySha256',
      'status',
    ]) &&
    value.schemaVersion === '1.0.0' &&
    value.kind === 'pdf-benchmark-independent-isolation-execution-receipt' &&
    value.trackId === 'end-to-end-blind' &&
    value.attestorId === identity.attestorId &&
    value.attestorIdentityEvidenceFileSha256 === identityEvidenceFileSha256 &&
    value.blindSplitIdentitySha256 === blind.frozenIdentitySha256 &&
    value.candidateComponentCommitmentSha256 === componentCommitmentSha256 &&
    value.networkIsolation === track.networkIsolation &&
    value.filesystemIsolation === track.filesystemIsolation &&
    value.networkIsolation === 'independently-enforced' &&
    value.filesystemIsolation === 'independently-enforced' &&
    SHA256.test(value.runnerIdentitySha256 ?? '') &&
    SHA256.test(value.executionIdentitySha256 ?? '') &&
    value.status === 'passed'
  )
}

export async function validateIndependentIsolationEvidence(
  registry,
  candidateCommitment,
) {
  const track = registry.tracks.endToEndBlind
  if (track.isolationEvidence === null) return false
  const blind = registry.splits.find((split) => split.role === 'blind-test')
  if (
    track.status !== 'frozen' ||
    track.promotionAuthority !== true ||
    blind?.status !== 'frozen' ||
    candidateCommitment.verified !== true ||
    !SHA256.test(candidateCommitment.componentCommitmentSha256 ?? '')
  ) {
    invalid('PDF_BENCHMARK_ISOLATION_EVIDENCE_MISMATCH')
  }
  const [identity, receipt] = await Promise.all([
    readBoundJson(
      track.isolationEvidence.attestorIdentity,
      'PDF_BENCHMARK_ISOLATION_EVIDENCE_MISMATCH',
    ),
    readBoundJson(
      track.isolationEvidence.executionReceipt,
      'PDF_BENCHMARK_ISOLATION_EVIDENCE_MISMATCH',
    ),
  ])
  if (
    !validIsolationAttestorIdentity(identity) ||
    !validIsolationExecutionReceipt(
      receipt,
      track,
      blind,
      candidateCommitment.componentCommitmentSha256,
      identity,
      track.isolationEvidence.attestorIdentity.fileSha256,
    )
  ) {
    invalid('PDF_BENCHMARK_ISOLATION_EVIDENCE_MISMATCH')
  }
  return true
}

function validEpubEntryName(name) {
  const parts = typeof name === 'string' ? name.split('/') : []
  if (name?.endsWith('/')) parts.pop()
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !name.startsWith('/') &&
    !name.startsWith('\\') &&
    !name.includes('\\') &&
    parts.length > 0 &&
    parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
  )
}

function childElementInNamespace(
  parent,
  localName,
  namespace,
  namespaceScope = parent,
) {
  if (!isRecord(parent)) return null
  const entry = Object.entries(parent).find(([name]) => {
    if (name.startsWith('@_') || name.split(':').at(-1) !== localName) {
      return false
    }
    return true
  })
  if (entry === undefined) return null
  const prefix = entry[0].includes(':') ? entry[0].split(':')[0] : null
  const namespaceAttribute = prefix === null ? '@_xmlns' : `@_xmlns:${prefix}`
  const children = Array.isArray(entry[1]) ? entry[1] : [entry[1]]
  const matching = children.filter((child) => {
    const effectiveNamespace = [child, parent, namespaceScope]
      .filter(isRecord)
      .find((scope) => Object.hasOwn(scope, namespaceAttribute))?.[
      namespaceAttribute
    ]
    return effectiveNamespace === namespace
  })
  return Array.isArray(entry[1]) ? matching : (matching[0] ?? null)
}

function namespacedRoot(document, localName, namespace) {
  if (!isRecord(document)) return null
  const entry = Object.entries(document).find(
    ([name]) => name.split(':').at(-1) === localName,
  )
  if (entry === undefined || !isRecord(entry[1])) return null
  const prefix = entry[0].includes(':') ? entry[0].split(':')[0] : null
  const namespaceAttribute = prefix === null ? '@_xmlns' : `@_xmlns:${prefix}`
  return entry[1][namespaceAttribute] === namespace ? entry[1] : null
}

function epubRootfilePath(containerXml) {
  if (XMLValidator.validate(containerXml) !== true) return null
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: false,
  }).parse(containerXml)
  const container = namespacedRoot(
    parsed,
    'container',
    'urn:oasis:names:tc:opendocument:xmlns:container',
  )
  const containerNamespace = 'urn:oasis:names:tc:opendocument:xmlns:container'
  const rootfilesNode = childElementInNamespace(
    container,
    'rootfiles',
    containerNamespace,
  )
  if (
    !isRecord(container) ||
    container['@_version'] !== '1.0' ||
    !isRecord(rootfilesNode)
  ) {
    return null
  }
  const rootfileNode = childElementInNamespace(
    rootfilesNode,
    'rootfile',
    containerNamespace,
    container,
  )
  const rootfiles = Array.isArray(rootfileNode) ? rootfileNode : [rootfileNode]
  const packageRootfile = rootfiles.find(
    (rootfile) =>
      isRecord(rootfile) &&
      rootfile['@_media-type'] === 'application/oebps-package+xml' &&
      typeof rootfile['@_full-path'] === 'string',
  )
  return packageRootfile?.['@_full-path'] ?? null
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return crc >>> 0
})

function crc32Update(crc, bytes) {
  for (const value of bytes) {
    crc = CRC32_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8)
  }
  return crc >>> 0
}

function crc32(bytes) {
  return (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0
}

function strictZipIndex(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let candidateAttempts = 0
  for (
    let offset = bytes.byteLength - 22;
    offset >= Math.max(0, bytes.byteLength - 65_557);
    offset -= 1
  ) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue
    const entryCount = view.getUint16(offset + 10, true)
    const centralSize = view.getUint32(offset + 12, true)
    const centralOffset = view.getUint32(offset + 16, true)
    const commentLength = view.getUint16(offset + 20, true)
    if (
      view.getUint16(offset + 4, true) !== 0 ||
      view.getUint16(offset + 6, true) !== 0 ||
      view.getUint16(offset + 8, true) !== entryCount ||
      entryCount === 0 ||
      entryCount > MAX_EPUB_ENTRIES ||
      centralOffset + centralSize !== offset ||
      offset + 22 + commentLength !== bytes.byteLength
    ) {
      continue
    }
    candidateAttempts += 1
    if (candidateAttempts > MAX_EPUB_EOCD_CANDIDATES) {
      throw new Error('ZIP end record candidate limit exceeded')
    }
    try {
      return strictZipIndexAt(bytes, view, offset, entryCount, centralOffset)
    } catch {
      // A comment may contain a plausible EOCD header. Only a candidate whose
      // bounded central and local records fully validate is authoritative.
    }
  }
  throw new Error('missing ZIP end record')
}

function strictZipIndexAt(bytes, view, endOffset, entryCount, centralOffset) {
  const entries = []
  const names = new Set()
  let cursor = centralOffset
  let inflatedBytes = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > endOffset ||
      view.getUint32(cursor, true) !== 0x02014b50
    ) {
      throw new Error('invalid ZIP central record')
    }
    const flags = view.getUint16(cursor + 8, true)
    const compression = view.getUint16(cursor + 10, true)
    const checksum = view.getUint32(cursor + 16, true)
    const size = view.getUint32(cursor + 20, true)
    const originalSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const entryCommentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const recordEnd =
      cursor + 46 + nameLength + extraLength + entryCommentLength
    if (recordEnd > endOffset) throw new Error('truncated ZIP central record')
    const nameBytes = Buffer.from(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    )
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
    if (
      !validEpubEntryName(name) ||
      names.has(name) ||
      (flags & ~0x080e) !== 0 ||
      (compression !== 0 && compression !== 8) ||
      size > MAX_EPUB_COMPRESSED_BYTES ||
      originalSize > MAX_EPUB_INFLATED_BYTES ||
      (compression === 0 && size !== originalSize) ||
      (inflatedBytes += originalSize) > MAX_EPUB_INFLATED_BYTES ||
      localOffset >= centralOffset
    ) {
      throw new Error('invalid ZIP central metadata')
    }
    names.add(name)
    entries.push({
      name,
      flags,
      compression,
      checksum,
      size,
      originalSize,
      localOffset,
      nameBytes,
      extraLength,
    })
    cursor = recordEnd
  }
  if (cursor !== endOffset) throw new Error('unindexed ZIP central bytes')
  let localCursor = 0
  const localEntries = [...entries].sort(
    (left, right) => left.localOffset - right.localOffset,
  )
  for (const [index, entry] of localEntries.entries()) {
    if (
      entry.localOffset !== localCursor ||
      entry.localOffset + 30 > centralOffset ||
      view.getUint32(entry.localOffset, true) !== 0x04034b50
    ) {
      throw new Error('hidden or invalid ZIP local record')
    }
    const nameLength = view.getUint16(entry.localOffset + 26, true)
    const extraLength = view.getUint16(entry.localOffset + 28, true)
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength
    const nextLocalOffset =
      localEntries[index + 1]?.localOffset ?? centralOffset
    const localNameBytes = Buffer.from(
      bytes.subarray(
        entry.localOffset + 30,
        entry.localOffset + 30 + nameLength,
      ),
    )
    const hasDataDescriptor = (entry.flags & 0x0008) !== 0
    if (
      !localNameBytes.equals(entry.nameBytes) ||
      (entry.name === 'mimetype' &&
        (extraLength !== 0 || entry.extraLength !== 0)) ||
      view.getUint16(entry.localOffset + 6, true) !== entry.flags ||
      view.getUint16(entry.localOffset + 8, true) !== entry.compression ||
      dataOffset + entry.size > nextLocalOffset
    ) {
      throw new Error('ZIP local and central record mismatch')
    }
    const localChecksum = view.getUint32(entry.localOffset + 14, true)
    const localSize = view.getUint32(entry.localOffset + 18, true)
    const localOriginalSize = view.getUint32(entry.localOffset + 22, true)
    if (
      !hasDataDescriptor &&
      (localChecksum !== entry.checksum ||
        localSize !== entry.size ||
        localOriginalSize !== entry.originalSize)
    ) {
      throw new Error('ZIP local and central record mismatch')
    }
    let recordEnd = dataOffset + entry.size
    if (hasDataDescriptor) {
      if (localChecksum !== 0 || localSize !== 0 || localOriginalSize !== 0) {
        throw new Error('ZIP local and central record mismatch')
      }
      const descriptorOffset = recordEnd
      const descriptorSize = nextLocalOffset - descriptorOffset
      if (descriptorSize !== 12 && descriptorSize !== 16) {
        throw new Error('truncated ZIP data descriptor')
      }
      const descriptorHasSignature = descriptorSize === 16
      if (
        descriptorHasSignature &&
        view.getUint32(descriptorOffset, true) !== 0x08074b50
      ) {
        throw new Error('ZIP data descriptor mismatch')
      }
      const descriptorFieldsOffset =
        descriptorOffset + (descriptorHasSignature ? 4 : 0)
      if (
        view.getUint32(descriptorFieldsOffset, true) !== entry.checksum ||
        view.getUint32(descriptorFieldsOffset + 4, true) !== entry.size ||
        view.getUint32(descriptorFieldsOffset + 8, true) !== entry.originalSize
      ) {
        throw new Error('ZIP data descriptor mismatch')
      }
      recordEnd = nextLocalOffset
    }
    entry.dataOffset = dataOffset
    localCursor = recordEnd
  }
  if (localCursor !== centralOffset)
    throw new Error('unindexed ZIP local bytes')
  return new Map(entries.map((entry) => [entry.name, entry]))
}

function extractZipEntryBounded(bytes, entry, maxBytes, collect = true) {
  if (entry.originalSize < 0 || entry.originalSize > maxBytes) {
    throw new Error('ZIP entry exceeds output limit')
  }
  const compressed = bytes.subarray(
    entry.dataOffset,
    entry.dataOffset + entry.size,
  )
  let output
  if (entry.originalSize === 0 && entry.compression === 0) {
    if (entry.size !== 0 || entry.checksum !== 0) {
      throw new Error('invalid empty ZIP entry')
    }
    return Buffer.alloc(0)
  }
  if (entry.compression === 0) {
    output = collect ? Buffer.from(compressed) : compressed
  } else {
    const chunks = []
    let emittedBytes = 0
    let completed = false
    let runningCrc = 0xffffffff
    const inflate = new Inflate((chunk, final) => {
      emittedBytes += chunk.byteLength
      if (emittedBytes > maxBytes || emittedBytes > entry.originalSize) {
        throw new Error('ZIP entry exceeds actual output limit')
      }
      runningCrc = crc32Update(runningCrc, chunk)
      if (collect) chunks.push(Buffer.from(chunk))
      if (final) completed = true
    })
    for (let offset = 0; offset < compressed.byteLength; offset += 256) {
      inflate.push(
        compressed.subarray(
          offset,
          Math.min(offset + 256, compressed.byteLength),
        ),
        offset + 256 >= compressed.byteLength,
      )
    }
    if (!completed || emittedBytes !== entry.originalSize) {
      throw new Error('ZIP entry size mismatch')
    }
    // fflate retains the final partially consumed byte in `p` and its bit
    // position in `s.p`. A raw DEFLATE member may end mid-byte, but it must
    // not leave a complete declared byte unconsumed after the final block.
    const trailingInputBytes = inflate.p.byteLength
    const finalBitOffset = inflate.s.p
    if (
      trailingInputBytes !== 0 &&
      (trailingInputBytes !== 1 || finalBitOffset === 0)
    ) {
      throw new Error('ZIP entry has trailing compressed input')
    }
    if ((runningCrc ^ 0xffffffff) >>> 0 !== entry.checksum) {
      throw new Error('ZIP entry checksum mismatch')
    }
    output = collect ? Buffer.concat(chunks, emittedBytes) : null
  }
  if (entry.compression === 0 && crc32(output) !== entry.checksum) {
    throw new Error('ZIP entry integrity mismatch')
  }
  return output
}

export function validEpubPackage(bytes) {
  try {
    if (
      bytes.length < 30 ||
      bytes[0] !== 0x50 ||
      bytes[1] !== 0x4b ||
      bytes[2] !== 0x03 ||
      bytes[3] !== 0x04 ||
      bytes[8] !== 0 ||
      bytes[9] !== 0 ||
      bytes[26] !== 8 ||
      bytes[27] !== 0 ||
      Buffer.from(bytes.subarray(30, 38)).toString('ascii') !== 'mimetype'
    ) {
      return false
    }
    const entries = strictZipIndex(bytes)
    const mimetypeEntry = entries.get('mimetype')
    const containerEntry = entries.get('META-INF/container.xml')
    if (
      mimetypeEntry?.compression !== 0 ||
      mimetypeEntry.size !== 20 ||
      mimetypeEntry.originalSize !== 20 ||
      containerEntry === undefined ||
      containerEntry.originalSize > MAX_EPUB_CONTAINER_BYTES ||
      extractZipEntryBounded(bytes, mimetypeEntry, 20).toString('utf8') !==
        'application/epub+zip'
    ) {
      return false
    }
    const container = extractZipEntryBounded(
      bytes,
      containerEntry,
      MAX_EPUB_CONTAINER_BYTES,
    ).toString('utf8')
    const rootfile = epubRootfilePath(container)
    const rootfileEntry = entries.get(rootfile)
    if (
      typeof rootfile !== 'string' ||
      !validEpubEntryName(rootfile) ||
      rootfileEntry === undefined ||
      rootfileEntry.originalSize <= 0 ||
      rootfileEntry.originalSize > MAX_EPUB_PACKAGE_DOCUMENT_BYTES
    ) {
      return false
    }
    const rootfileBytes = extractZipEntryBounded(
      bytes,
      rootfileEntry,
      MAX_EPUB_PACKAGE_DOCUMENT_BYTES,
    )
    const packageXml = Buffer.from(rootfileBytes).toString('utf8')
    if (XMLValidator.validate(packageXml) !== true) return false
    const packageDocument = new XMLParser({
      ignoreAttributes: false,
      processEntities: false,
    }).parse(packageXml)
    const packageRoot = namespacedRoot(
      packageDocument,
      'package',
      'http://www.idpf.org/2007/opf',
    )
    const structurallyValid =
      isRecord(packageRoot) &&
      /^3(?:\.\d+)+$/u.test(packageRoot['@_version'] ?? '') &&
      typeof packageRoot['@_unique-identifier'] === 'string' &&
      packageRoot['@_unique-identifier'].length > 0 &&
      isRecord(
        childElementInNamespace(
          packageRoot,
          'metadata',
          'http://www.idpf.org/2007/opf',
        ),
      ) &&
      isRecord(
        childElementInNamespace(
          packageRoot,
          'manifest',
          'http://www.idpf.org/2007/opf',
        ),
      ) &&
      isRecord(
        childElementInNamespace(
          packageRoot,
          'spine',
          'http://www.idpf.org/2007/opf',
        ),
      )
    if (!structurallyValid) return false
    for (const entry of entries.values()) {
      if (
        entry.name !== 'mimetype' &&
        entry.name !== 'META-INF/container.xml' &&
        entry.name !== rootfile
      ) {
        extractZipEntryBounded(bytes, entry, entry.originalSize, false)
      }
    }
    return true
  } catch {
    return false
  }
}

async function validateExactEpubExportEvidence(exportEvidence) {
  if (exportEvidence === null) return null
  if (!exactKeys(exportEvidence, ['path', 'fileSha256'])) {
    invalid('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')
  }
  const evidence = await readBoundJson(
    exportEvidence,
    'PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH',
  )
  if (
    !exactKeys(evidence, [
      'schemaVersion',
      'kind',
      'epubArtifact',
      'exactArtifactSha256',
      'exportReceipt',
      'exportReceiptIdentitySha256',
      'toolchainManifest',
      'epubCheckReceipt',
      'epubCheckTranscript',
      'status',
    ]) ||
    evidence.schemaVersion !== '1.0.0' ||
    evidence.kind !== 'pdf-benchmark-exact-epub-export-evidence' ||
    !exactKeys(evidence.epubArtifact, ['path', 'fileSha256']) ||
    !evidence.epubArtifact.path.endsWith('.epub') ||
    !SHA256.test(evidence.exactArtifactSha256 ?? '') ||
    !SHA256.test(evidence.exportReceiptIdentitySha256 ?? '') ||
    evidence.status !== 'passed'
  ) {
    invalid('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')
  }
  const epubBytes = await verifyRepositoryFileBinding(
    evidence.epubArtifact.path,
    evidence.epubArtifact.fileSha256,
    'PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH',
    MAX_EPUB_COMPRESSED_BYTES,
  )
  if (evidence.exactArtifactSha256 !== evidence.epubArtifact.fileSha256) {
    invalid('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')
  }
  if (!validEpubPackage(epubBytes)) {
    invalid('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')
  }
  const exportReceipt = await readBoundJson(
    evidence.exportReceipt,
    'PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH',
  )
  if (
    !exactKeys(exportReceipt, [
      'schemaVersion',
      'kind',
      'exactArtifactSha256',
      'status',
    ]) ||
    exportReceipt.schemaVersion !== '1.0.0' ||
    exportReceipt.kind !== 'pdf-benchmark-exact-epub-export-receipt' ||
    exportReceipt.exactArtifactSha256 !== evidence.exactArtifactSha256 ||
    exportReceipt.status !== 'passed' ||
    sha256(canonicalJson(exportReceipt)) !==
      evidence.exportReceiptIdentitySha256
  ) {
    invalid('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')
  }
  const epubCheckReceipt = await readBoundJson(
    evidence.epubCheckReceipt,
    'PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH',
  )
  if (
    !exactKeys(evidence.toolchainManifest, ['path', 'fileSha256']) ||
    evidence.toolchainManifest.path !==
      'src/publication/toolchain-manifest.json'
  ) {
    invalid('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')
  }
  const toolchainManifest = await readBoundJson(
    evidence.toolchainManifest,
    'PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH',
  )
  const epubcheck = toolchainManifest.epubcheck
  const epubCheckTranscript = await readBoundJson(
    evidence.epubCheckTranscript,
    'PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH',
  )
  if (
    !exactKeys(epubCheckReceipt, [
      'schemaVersion',
      'kind',
      'exactArtifactSha256',
      'toolchainManifestFileSha256',
      'checkerIdentitySha256',
      'checkerVersion',
      'epubCheckTranscriptEvidenceFileSha256',
      'inputIdentitySha256',
      'outputIdentitySha256',
      'status',
    ]) ||
    epubCheckReceipt.schemaVersion !== '1.0.0' ||
    epubCheckReceipt.kind !== 'pdf-benchmark-epubcheck-execution-receipt' ||
    epubCheckReceipt.exactArtifactSha256 !== evidence.exactArtifactSha256 ||
    epubCheckReceipt.toolchainManifestFileSha256 !==
      evidence.toolchainManifest.fileSha256 ||
    !isRecord(epubcheck) ||
    !exactKeys(epubcheck, ['package', 'packageVersion', 'version', 'sha256']) ||
    epubCheckReceipt.checkerIdentitySha256 !== epubcheck.sha256 ||
    epubCheckReceipt.checkerVersion !== epubcheck.version ||
    epubCheckReceipt.epubCheckTranscriptEvidenceFileSha256 !==
      evidence.epubCheckTranscript.fileSha256 ||
    epubCheckReceipt.inputIdentitySha256 !==
      sha256(
        canonicalJson({
          kind: 'pdf-benchmark-epubcheck-input-v1',
          exactArtifactSha256: evidence.exactArtifactSha256,
          checkerIdentitySha256: epubCheckReceipt.checkerIdentitySha256,
          checkerVersion: epubCheckReceipt.checkerVersion,
        }),
      ) ||
    !exactKeys(epubCheckTranscript, [
      'schemaVersion',
      'kind',
      'command',
      'exactArtifactSha256',
      'checkerIdentitySha256',
      'checkerVersion',
      'exitCode',
      'epubCheckStatus',
      'stdoutSha256',
      'stderrSha256',
    ]) ||
    epubCheckTranscript.schemaVersion !== '1.0.0' ||
    epubCheckTranscript.kind !==
      'pdf-benchmark-epubcheck-execution-transcript' ||
    epubCheckTranscript.command !== 'epubcheck' ||
    epubCheckTranscript.exactArtifactSha256 !== evidence.exactArtifactSha256 ||
    epubCheckTranscript.checkerIdentitySha256 !== epubcheck.sha256 ||
    epubCheckTranscript.checkerVersion !== epubcheck.version ||
    epubCheckTranscript.exitCode !== 0 ||
    epubCheckTranscript.epubCheckStatus !== 'passed' ||
    !SHA256.test(epubCheckTranscript.stdoutSha256 ?? '') ||
    !SHA256.test(epubCheckTranscript.stderrSha256 ?? '') ||
    epubCheckReceipt.outputIdentitySha256 !==
      sha256(canonicalJson(epubCheckTranscript)) ||
    epubCheckReceipt.status !== 'passed'
  ) {
    invalid('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')
  }
  return {
    exactArtifactSha256: evidence.exactArtifactSha256,
    exportEvidenceFileSha256: exportEvidence.fileSha256,
    exportReceiptEvidenceFileSha256: evidence.exportReceipt.fileSha256,
    exportReceiptIdentitySha256: evidence.exportReceiptIdentitySha256,
    epubCheckReceiptEvidenceFileSha256: evidence.epubCheckReceipt.fileSha256,
    toolchainManifestFileSha256: evidence.toolchainManifest.fileSha256,
    epubCheckTranscriptEvidenceFileSha256:
      evidence.epubCheckTranscript.fileSha256,
  }
}

export async function validateNativeReaderEvidence(nativeReaderEvidence) {
  if (
    !exactKeys(nativeReaderEvidence, [
      'exportEvidence',
      ...Object.keys(REQUIRED_NATIVE_READER_TYPES),
    ])
  ) {
    invalid('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')
  }
  const exportArtifact = await validateExactEpubExportEvidence(
    nativeReaderEvidence.exportEvidence,
  )
  const structurallyValidatedReaderIds = []
  for (const [readerId, readerType] of Object.entries(
    REQUIRED_NATIVE_READER_TYPES,
  )) {
    const evidence = nativeReaderEvidence[readerId]
    if (
      !exactKeys(evidence, ['status', 'readerIdentity', 'executionReceipt'])
    ) {
      invalid('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')
    }
    if (
      evidence.status === 'unavailable-blocker' &&
      evidence.readerIdentity === null &&
      evidence.executionReceipt === null
    ) {
      continue
    }
    if (
      evidence.status !== 'passed' ||
      !isRecord(evidence.readerIdentity) ||
      !isRecord(evidence.executionReceipt)
    ) {
      invalid('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')
    }
    const [identity, receipt] = await Promise.all([
      readBoundJson(
        evidence.readerIdentity,
        'PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH',
      ),
      readBoundJson(
        evidence.executionReceipt,
        'PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH',
      ),
    ])
    if (
      !exactKeys(identity, [
        'schemaVersion',
        'kind',
        'readerId',
        'readerType',
        'readerIdentitySha256',
        'status',
      ]) ||
      identity.schemaVersion !== '1.0.0' ||
      identity.kind !== 'pdf-benchmark-native-reader-identity-evidence' ||
      identity.readerId !== readerId ||
      identity.readerType !== readerType ||
      !SHA256.test(identity.readerIdentitySha256 ?? '') ||
      identity.status !== 'passed' ||
      !exactKeys(receipt, [
        'schemaVersion',
        'kind',
        'readerId',
        'readerType',
        'readerIdentityEvidenceFileSha256',
        'exportEvidenceFileSha256',
        'exportReceiptEvidenceFileSha256',
        'exportReceiptIdentitySha256',
        'epubCheckReceiptEvidenceFileSha256',
        'toolchainManifestFileSha256',
        'epubCheckTranscriptEvidenceFileSha256',
        'exactArtifactSha256',
        'executionIdentitySha256',
        'status',
      ]) ||
      receipt.schemaVersion !== '1.0.0' ||
      receipt.kind !== 'pdf-benchmark-native-reader-execution-receipt' ||
      receipt.readerId !== readerId ||
      receipt.readerType !== readerType ||
      receipt.readerIdentityEvidenceFileSha256 !==
        evidence.readerIdentity.fileSha256 ||
      receipt.exportEvidenceFileSha256 !==
        exportArtifact?.exportEvidenceFileSha256 ||
      receipt.exportReceiptEvidenceFileSha256 !==
        exportArtifact?.exportReceiptEvidenceFileSha256 ||
      receipt.exportReceiptIdentitySha256 !==
        exportArtifact?.exportReceiptIdentitySha256 ||
      receipt.epubCheckReceiptEvidenceFileSha256 !==
        exportArtifact?.epubCheckReceiptEvidenceFileSha256 ||
      receipt.toolchainManifestFileSha256 !==
        exportArtifact?.toolchainManifestFileSha256 ||
      receipt.epubCheckTranscriptEvidenceFileSha256 !==
        exportArtifact?.epubCheckTranscriptEvidenceFileSha256 ||
      !SHA256.test(receipt.exactArtifactSha256 ?? '') ||
      !SHA256.test(receipt.executionIdentitySha256 ?? '') ||
      receipt.status !== 'passed' ||
      exportArtifact === null ||
      receipt.exactArtifactSha256 !== exportArtifact.exactArtifactSha256
    ) {
      invalid('PDF_BENCHMARK_NATIVE_READER_EVIDENCE_MISMATCH')
    }
    structurallyValidatedReaderIds.push(readerId)
  }
  return {
    exactArtifactSha256: exportArtifact?.exactArtifactSha256 ?? null,
    structurallyValidatedReaderIds,
    trustedAttestationVerified: false,
    trustedAttestationReason: 'trusted-attestation-verifier-not-implemented',
    verifiedReaderIds: [],
  }
}

function unavailableNativeReaderEvidence() {
  return {
    exportEvidence: null,
    ...Object.fromEntries(
      Object.keys(REQUIRED_NATIVE_READER_TYPES).map((readerId) => [
        readerId,
        {
          status: 'unavailable-blocker',
          readerIdentity: null,
          executionReceipt: null,
        },
      ]),
    ),
  }
}

function blindSourcePolicyVerified(blind, sourcePoliciesByDocument) {
  return (
    blind.documentIds.length > 0 &&
    blind.documentIds.every((documentId) => {
      const policies = sourcePoliciesByDocument.get(documentId) ?? []
      return (
        policies.length > 0 &&
        policies.every(
          (policy) =>
            policy.labelVisibility === 'private' &&
            policy.oracleLocalized === false &&
            policy.selectionStatus ===
              'source-only-candidate-output-not-consulted',
        )
      )
    })
  )
}

export function assessPdfBenchmarkReadiness(
  registry,
  inventory,
  {
    boundDocumentIds = [],
    verifiedMetricIds = [],
    validatedReviewCaseIds = [],
    verifiedSourceTemplateDocumentIds = [],
    blindSourcePolicyVerified: blindPolicyVerified = false,
    candidateCommitmentVerified = false,
    independentIsolationEvidenceVerified = false,
    nativeReaderEvidenceVerified = false,
    nativeReaderEvidenceSummary = {
      exactArtifactSha256: null,
      structurallyValidatedReaderIds: [],
      trustedAttestationVerified: false,
      trustedAttestationReason: 'trusted-attestation-verifier-not-implemented',
      verifiedReaderIds: [],
    },
  } = {},
) {
  const blind = registry.splits.find((split) => split.role === 'blind-test')
  const trainAndDevelopment = ['train', 'development'].map((role) =>
    registry.splits.find((split) => split.role === role),
  )
  const metricById = new Map(
    registry.metricImplementations.map((metric) => [metric.id, metric]),
  )
  if (
    metricById.size !== registry.metricImplementations.length ||
    REQUIRED_METRICS.some((id) => !metricById.has(id))
  ) {
    invalid('PDF_BENCHMARK_INCOMPLETE_METRIC_REGISTRY')
  }
  const boundDocuments = new Set(boundDocumentIds)
  const verifiedMetrics = new Set(verifiedMetricIds)
  const availableMetrics = REQUIRED_METRICS.filter(
    (id) =>
      metricById.get(id).status === 'available' && verifiedMetrics.has(id),
  )
  const verifiedSourceTemplateDocuments = new Set(
    verifiedSourceTemplateDocumentIds,
  )
  const reviewedCaseIds = new Set(validatedReviewCaseIds)

  const criteria = [
    criterion(
      'trace-count',
      inventory.caseCount >= registry.protocol.targetTraceCount,
      inventory.caseCount,
      registry.protocol.targetTraceCount,
    ),
    criterion(
      'distinct-document-count',
      inventory.documentCount >= registry.protocol.minimumDistinctDocuments,
      inventory.documentCount,
      registry.protocol.minimumDistinctDocuments,
    ),
    criterion(
      'discovery-order-recorded',
      registry.discoveryOrder.status === 'recorded',
      registry.discoveryOrder.status,
      'recorded',
    ),
    criterion(
      'final-no-new-class-window',
      inventory.finalNoNewClassWindow >=
        registry.protocol.requiredFinalNoNewClassWindow,
      inventory.finalNoNewClassWindow,
      registry.protocol.requiredFinalNoNewClassWindow,
    ),
    criterion(
      'independent-review-coverage',
      reviewedCaseIds.size === inventory.caseCount,
      reviewedCaseIds.size,
      inventory.caseCount,
    ),
    criterion(
      'document-split-disjoint',
      inventory.documentDisjoint,
      inventory.documentDisjoint,
      true,
    ),
    criterion(
      'template-family-split-disjoint',
      inventory.templateFamilyDisjoint,
      inventory.templateFamilyDisjoint,
      true,
    ),
    criterion(
      'source-template-binding-coverage',
      verifiedSourceTemplateDocuments.size === inventory.documentCount &&
        boundDocumentIds.every((documentId) =>
          verifiedSourceTemplateDocuments.has(documentId),
        ),
      verifiedSourceTemplateDocuments.size,
      inventory.documentCount,
    ),
    criterion(
      'train-development-splits-frozen',
      trainAndDevelopment.every(
        (split) =>
          split.status === 'frozen' &&
          split.labelVisibility === 'private' &&
          split.documentIds.length > 0 &&
          split.documentIds.every((documentId) =>
            boundDocuments.has(documentId),
          ) &&
          split.documentIds.every((documentId) =>
            verifiedSourceTemplateDocuments.has(documentId),
          ) &&
          split.frozenIdentitySha256 ===
            inventory.splitIdentitySha256s?.[split.role],
      ),
      Object.fromEntries(
        trainAndDevelopment.map((split) => [
          split.role,
          {
            status: split.status,
            labelVisibility: split.labelVisibility,
            documentCount: split.documentIds.length,
          },
        ]),
      ),
      {
        train: {
          status: 'frozen',
          labelVisibility: 'private',
          minimumDocumentCount: 1,
        },
        development: {
          status: 'frozen',
          labelVisibility: 'private',
          minimumDocumentCount: 1,
        },
        allDocumentsSourceBound: true,
        allDocumentsTemplateFamilyBound: true,
      },
    ),
    criterion(
      'blind-split-frozen',
      blind.status === 'frozen' &&
        blind.labelVisibility === 'private' &&
        blind.documentIds.length >= registry.protocol.minimumBlindDocuments &&
        blind.documentIds.every((documentId) =>
          boundDocuments.has(documentId),
        ) &&
        blind.documentIds.every((documentId) =>
          verifiedSourceTemplateDocuments.has(documentId),
        ) &&
        blindPolicyVerified &&
        blind.frozenIdentitySha256 ===
          inventory.splitIdentitySha256s?.['blind-test'],
      {
        status: blind.status,
        labelVisibility: blind.labelVisibility,
        documentCount: blind.documentIds.length,
      },
      {
        status: 'frozen',
        labelVisibility: 'private',
        minimumDocumentCount: registry.protocol.minimumBlindDocuments,
        allDocumentsSourceBound: true,
        allDocumentsTemplateFamilyBound: true,
        allDocumentSourcesPrivateAndNonOracle: true,
      },
    ),
    criterion(
      'candidate-commitment-frozen-before-label-reveal',
      candidateCommitmentVerified,
      {
        status: registry.candidateCommitment.status,
        committedBeforePrivateLabelReveal:
          registry.candidateCommitment.committedBeforePrivateLabelReveal,
      },
      {
        status: 'frozen',
        committedBeforePrivateLabelReveal: true,
        components: CANDIDATE_COMPONENT_KINDS,
        receiptBoundToBlindSplit: true,
      },
    ),
    criterion(
      'target-free-end-to-end-track',
      registry.tracks.endToEndBlind.status === 'frozen' &&
        registry.tracks.endToEndBlind.labelVisibility === 'private' &&
        registry.tracks.endToEndBlind.oracleLocalized === false &&
        registry.tracks.endToEndBlind.promotionAuthority === true &&
        registry.tracks.endToEndBlind.networkIsolation ===
          'independently-enforced' &&
        registry.tracks.endToEndBlind.filesystemIsolation ===
          'independently-enforced' &&
        independentIsolationEvidenceVerified,
      {
        status: registry.tracks.endToEndBlind.status,
        labelVisibility: registry.tracks.endToEndBlind.labelVisibility,
        oracleLocalized: registry.tracks.endToEndBlind.oracleLocalized,
        promotionAuthority: registry.tracks.endToEndBlind.promotionAuthority,
        networkIsolation: registry.tracks.endToEndBlind.networkIsolation,
        filesystemIsolation: registry.tracks.endToEndBlind.filesystemIsolation,
        independentIsolationEvidenceVerified,
      },
      {
        status: 'frozen',
        labelVisibility: 'private',
        oracleLocalized: false,
        promotionAuthority: true,
        networkIsolation: 'independently-enforced',
        filesystemIsolation: 'independently-enforced',
      },
    ),
    criterion(
      'metric-coverage',
      availableMetrics.length === REQUIRED_METRICS.length,
      availableMetrics,
      REQUIRED_METRICS,
    ),
    criterion(
      'native-reader-exact-artifact-coverage',
      nativeReaderEvidenceVerified,
      nativeReaderEvidenceSummary,
      {
        'apple-books': 'hash-bound-passed-exact-artifact-receipt',
        'independent-desktop-epub-reader':
          'hash-bound-passed-exact-artifact-receipt',
        'target-eink-reader-device': 'hash-bound-passed-exact-artifact-receipt',
      },
    ),
    criterion(
      'promotion-protocol-implementation',
      PROMOTION_PROTOCOL_IMPLEMENTED,
      'not-implemented-in-readiness-v1',
      'independently-reviewed-source-review-metric-policy-v2-or-later',
    ),
  ]

  return {
    criteria,
    gaps: criteria.filter((item) => !item.passed).map((item) => item.id),
    ready: criteria.every((item) => item.passed),
  }
}

export async function createPdfBenchmarkReadinessReceipt({
  registryPath,
  schemaPath = DEFAULT_SCHEMA_PATH,
}) {
  const absoluteRegistryPath = resolve(registryPath)
  const registryArtifact = await readJsonArtifact(
    absoluteRegistryPath,
    'PDF_BENCHMARK_READINESS_FAILED',
  )
  const registry = registryArtifact.value
  const schema = await validateSchema(registry, resolve(schemaPath))
  const verifiedMetricIds = await validateMetricImplementations(registry)

  const loadedSources = []
  for (const source of registry.sources) {
    loadedSources.push(await loadSource(source))
  }
  const documentEvidence = await validateDocumentBindings(
    registry,
    loadedSources,
  )
  const allCaseIds = new Set()
  const allDocumentIds = new Set()
  const classByCase = new Map()
  const failureClasses = new Set()
  const publicFailureClassCounts = new Map()
  let privateFailureObservationCount = 0
  const sourceInventory = []
  for (const loaded of loadedSources) {
    for (const document of loaded.evalSet.documents) {
      allDocumentIds.add(document.id)
    }
    for (const observation of loaded.observations.observations) {
      if (allCaseIds.has(observation.caseId)) {
        invalid('PDF_BENCHMARK_DUPLICATE_CASE_ACROSS_SOURCES')
      }
      allCaseIds.add(observation.caseId)
      classByCase.set(observation.caseId, observation.firstFailureClass)
      failureClasses.add(observation.firstFailureClass)
      if (loaded.source.labelVisibility === 'private') {
        privateFailureObservationCount += 1
      } else {
        publicFailureClassCounts.set(
          observation.firstFailureClass,
          (publicFailureClassCounts.get(observation.firstFailureClass) ?? 0) +
            1,
        )
      }
    }
    sourceInventory.push({
      id: loaded.source.id,
      evalSetId: loaded.identity.id,
      evalSetSha256: loaded.identity.evalSetSha256,
      caseCount: loaded.identity.caseCount,
      documentCount: loaded.identity.documentCount,
      labelVisibility: loaded.source.labelVisibility,
      oracleLocalized: loaded.source.oracleLocalized,
    })
  }
  const splitValidation = validateSplits(
    registry,
    [...allDocumentIds].sort(),
    documentEvidence.verifiedTemplateBindings,
  )
  const validatedReviewCaseIds = await validateReviewBundles(
    registry,
    allCaseIds,
  )
  const candidateCommitment = await validateCandidateCommitment(registry)
  const independentIsolationEvidenceVerified =
    await validateIndependentIsolationEvidence(registry, candidateCommitment)
  const nativeReaderEvidence = await validateNativeReaderEvidence(
    registry.nativeReaderEvidence ?? unavailableNativeReaderEvidence(),
  )
  const blind = registry.splits.find((split) => split.role === 'blind-test')
  const verifiedBlindSourcePolicy = blindSourcePolicyVerified(
    blind,
    documentEvidence.sourcePoliciesByDocument,
  )
  const finalNoNewClassWindow = observedFinalNoNewClassWindow(
    registry,
    classByCase,
    allCaseIds,
  )
  const inventory = {
    caseCount: allCaseIds.size,
    documentCount: allDocumentIds.size,
    failureClassCount: failureClasses.size,
    failureClassCounts: {
      public: Object.fromEntries(
        [...publicFailureClassCounts.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      privateRedactedObservationCount: privateFailureObservationCount,
    },
    finalNoNewClassWindow,
    ...splitValidation,
  }
  const assessment = assessPdfBenchmarkReadiness(registry, inventory, {
    boundDocumentIds: [...allDocumentIds],
    verifiedMetricIds,
    validatedReviewCaseIds: [...validatedReviewCaseIds],
    verifiedSourceTemplateDocumentIds: [
      ...documentEvidence.verifiedTemplateBindings.keys(),
    ],
    blindSourcePolicyVerified: verifiedBlindSourcePolicy,
    candidateCommitmentVerified: candidateCommitment.verified,
    independentIsolationEvidenceVerified,
    nativeReaderEvidenceVerified:
      nativeReaderEvidence.trustedAttestationVerified &&
      nativeReaderEvidence.verifiedReaderIds.length ===
        Object.keys(REQUIRED_NATIVE_READER_TYPES).length,
    nativeReaderEvidenceSummary: nativeReaderEvidence,
  })
  const unsigned = {
    schemaVersion: PDF_BENCHMARK_READINESS_SCHEMA_VERSION,
    privacy:
      'public-identities-hashes-readiness-aggregates-no-source-content-private-labels-or-local-paths',
    registry: {
      id: registry.id,
      fileSha256: registryArtifact.fileSha256,
      canonicalSha256: sha256(canonicalJson(registry)),
    },
    schema,
    inventory,
    sources: sourceInventory,
    candidateCommitment: {
      status: registry.candidateCommitment.status,
      committedBeforePrivateLabelReveal:
        registry.candidateCommitment.committedBeforePrivateLabelReveal,
      componentCommitmentSha256: candidateCommitment.componentCommitmentSha256,
    },
    nativeReaderEvidence,
    criteria: assessment.criteria,
    gaps: assessment.gaps,
    ready: assessment.ready,
  }
  return {
    ...unsigned,
    receiptSha256: sha256(canonicalJson(unsigned)),
  }
}

function parseArgs(argv) {
  const options = {
    registryPath: null,
    schemaPath: DEFAULT_SCHEMA_PATH,
    outPath: null,
    requireReady: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--registry') {
      options.registryPath = argv[++index]
    } else if (argument === '--schema') {
      options.schemaPath = argv[++index]
    } else if (argument === '--out') {
      options.outPath = argv[++index]
    } else if (argument === '--require-ready') {
      options.requireReady = true
    } else {
      invalid('INVALID_PDF_BENCHMARK_READINESS_ARGUMENT')
    }
  }
  if (!options.registryPath) {
    invalid('MISSING_PDF_BENCHMARK_READINESS_REGISTRY')
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (
    options.requireReady &&
    resolve(options.schemaPath) !== DEFAULT_SCHEMA_PATH
  ) {
    invalid('PDF_BENCHMARK_NONCANONICAL_PROMOTION_SCHEMA')
  }
  const receipt = await createPdfBenchmarkReadinessReceipt(options)
  const output = `${JSON.stringify(receipt, null, 2)}\n`
  if (options.outPath) {
    await mkdir(dirname(resolve(options.outPath)), { recursive: true })
    await writeFile(resolve(options.outPath), output)
  } else {
    process.stdout.write(output)
  }
  if (options.requireReady && !receipt.ready) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : ''
    const code = PUBLIC_ERROR_CODE.test(message)
      ? message
      : 'PDF_BENCHMARK_READINESS_FAILED'
    process.stderr.write(`${code}\n`)
    process.exitCode = 1
  })
}

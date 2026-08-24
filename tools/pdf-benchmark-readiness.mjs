#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import ts from 'typescript'
import {
  canonicalJson,
  validatePdfFidelityEvalSet,
} from './pdf-fidelity-eval.mjs'

export const PDF_BENCHMARK_READINESS_SCHEMA_VERSION = '1.0.0'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const LEGACY_SCHEMA_PATH = resolve(
  REPOSITORY_ROOT,
  'docs/schemas/pdf-benchmark-readiness-registry.schema.json',
)
const DEFAULT_SCHEMA_PATH = resolve(
  REPOSITORY_ROOT,
  'docs/schemas/pdf-benchmark-readiness-registry-v2.schema.json',
)
const SCHEMA_BINDINGS = new Map([
  [
    '1.0.0',
    {
      path: LEGACY_SCHEMA_PATH,
      id: 'https://ernie.sg/schemas/pdf-benchmark-readiness-registry-1.0.0.json',
      fileSha256:
        '3dd77733e86da34b9810afeab607c1f325d4b70fa43c2c8116dd30d3cd5c4ff9',
    },
  ],
  [
    '2.0.0',
    {
      path: DEFAULT_SCHEMA_PATH,
      id: 'https://ernie.sg/schemas/pdf-benchmark-readiness-registry-2.0.0.json',
      fileSha256:
        'af358f8b3fce3cc1bbe90a38a11f31ac9904865bddd83e32d6c452e5c36ab4c7',
    },
  ],
])
const PUBLIC_ERROR_CODE = /^(?:INVALID|MISSING|PDF)_[A-Z0-9_]+$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/
const SAFE_FAILURE_CLASS = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,11}$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_GOVERNANCE_JSON_BYTES = 16 * 1024 * 1024
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

function canonicalRepositoryPath(repositoryPath) {
  if (
    typeof repositoryPath !== 'string' ||
    repositoryPath.length === 0 ||
    repositoryPath.startsWith('/') ||
    repositoryPath.includes('\\') ||
    repositoryPath
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..') ||
    posix.normalize(repositoryPath) !== repositoryPath
  ) {
    invalid('INVALID_PDF_BENCHMARK_REPOSITORY_PATH')
  }
  return repositoryPath
}

function resolveRepositoryPath(
  repositoryPath,
  repositoryRoot = REPOSITORY_ROOT,
) {
  const canonical = canonicalRepositoryPath(repositoryPath)
  const absolute = resolve(repositoryRoot, canonical)
  if (
    absolute !== repositoryRoot &&
    !absolute.startsWith(`${repositoryRoot}${sep}`)
  ) {
    invalid('INVALID_PDF_BENCHMARK_REPOSITORY_PATH')
  }
  return absolute
}

async function readJsonArtifact(path, code) {
  try {
    const absolute = resolve(path)
    const details = await lstat(absolute)
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.size <= 0 ||
      details.size > MAX_GOVERNANCE_JSON_BYTES
    ) {
      invalid(code)
    }
    const bytes = await readFile(absolute)
    if (bytes.byteLength !== details.size) invalid(code)
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
  const binding = SCHEMA_BINDINGS.get(registry?.schemaVersion)
  const selectedPath = schemaPath ? resolve(schemaPath) : binding?.path
  if (!binding || selectedPath !== binding.path) {
    invalid('INVALID_PDF_BENCHMARK_REGISTRY_SCHEMA')
  }
  const schemaArtifact = await readJsonArtifact(
    selectedPath,
    'INVALID_PDF_BENCHMARK_REGISTRY_SCHEMA',
  )
  if (
    schemaArtifact.value.$id !== binding.id ||
    schemaArtifact.fileSha256 !== binding.fileSha256
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

async function verifyRepositoryFileBinding(
  repositoryPath,
  expectedSha256,
  code = 'PDF_BENCHMARK_METRIC_BINDING_MISMATCH',
  repositoryRoot = REPOSITORY_ROOT,
) {
  try {
    const canonical = canonicalRepositoryPath(repositoryPath)
    const absolute = resolveRepositoryPath(canonical, repositoryRoot)
    const [details, repositoryRealPath, fileRealPath] = await Promise.all([
      lstat(absolute),
      realpath(repositoryRoot),
      realpath(absolute),
    ])
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      (fileRealPath !== repositoryRealPath &&
        !fileRealPath.startsWith(`${repositoryRealPath}${sep}`))
    ) {
      invalid(code)
    }
    const actualPath = relative(repositoryRealPath, fileRealPath)
      .split(sep)
      .join('/')
    if (actualPath !== canonical) invalid(code)
    const bytes = await readFile(fileRealPath)
    if (sha256(bytes) !== expectedSha256) {
      invalid(code)
    }
    return bytes
  } catch {
    invalid(code)
  }
}

function metricImplementationCompositeSha256(metric) {
  return sha256(
    canonicalJson({
      kind: 'pdf-benchmark-metric-implementation-v1',
      entrypoint: metric.implementation,
      components: metric.implementationComponents
        .map((component) => ({
          path: component.path,
          fileSha256: component.fileSha256,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    }),
  )
}

function localModuleSpecifiers(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  )
  const specifiers = []
  const createRequireIdentifiers = new Set()
  const requireIdentifiers = new Set(['require'])
  function collectRequireBindings(node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      ['node:module', 'module'].includes(node.moduleSpecifier.text) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements)
        if ((element.propertyName ?? element.name).text === 'createRequire')
          createRequireIdentifiers.add(element.name.text)
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      createRequireIdentifiers.has(node.initializer.expression.text)
    ) {
      requireIdentifiers.add(node.name.text)
    }
    ts.forEachChild(node, collectRequireBindings)
  }
  collectRequireBindings(sourceFile)
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      if (!ts.isStringLiteral(node.moduleSpecifier))
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      specifiers.push(node.arguments[0].text)
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      requireIdentifiers.has(node.expression.text)
    ) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => {
      if (
        specifier.includes('\\') ||
        specifier.includes('//') ||
        specifier.includes('/./') ||
        specifier.endsWith('/.') ||
        specifier.endsWith('/..')
      )
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      return specifier
    })
}

async function canonicalRepositoryFile(repositoryPath, repositoryRoot, code) {
  const canonical = canonicalRepositoryPath(repositoryPath)
  const absolute = resolveRepositoryPath(canonical, repositoryRoot)
  const [details, rootRealPath, fileRealPath] = await Promise.all([
    lstat(absolute),
    realpath(repositoryRoot),
    realpath(absolute),
  ])
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    (fileRealPath !== rootRealPath &&
      !fileRealPath.startsWith(`${rootRealPath}${sep}`))
  ) {
    invalid(code)
  }
  const actualPath = relative(rootRealPath, fileRealPath).split(sep).join('/')
  if (actualPath !== canonical) invalid(code)
  return {
    path: canonical,
    realPath: fileRealPath,
    bytes: await readFile(fileRealPath),
  }
}

export async function deriveLocalExecutableImportClosure(
  entrypoint,
  { repositoryRoot = REPOSITORY_ROOT } = {},
) {
  const pending = [canonicalRepositoryPath(entrypoint)]
  const byPath = new Map()
  const pathsByRealPath = new Map()
  while (pending.length > 0) {
    const current = pending.pop()
    if (byPath.has(current)) continue
    let artifact
    try {
      artifact = await canonicalRepositoryFile(
        current,
        repositoryRoot,
        'PDF_BENCHMARK_METRIC_BINDING_MISMATCH',
      )
    } catch {
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    }
    const priorPath = pathsByRealPath.get(artifact.realPath)
    if (priorPath && priorPath !== artifact.path)
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    pathsByRealPath.set(artifact.realPath, artifact.path)
    byPath.set(artifact.path, artifact)
    for (const specifier of localModuleSpecifiers(
      artifact.bytes.toString('utf8'),
      artifact.path,
    )) {
      const importedPath = posix.join(posix.dirname(artifact.path), specifier)
      canonicalRepositoryPath(importedPath)
      pending.push(importedPath)
    }
  }
  return [...byPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  )
}

export async function verifyMetricImplementationBinding(
  metric,
  { repositoryRoot = REPOSITORY_ROOT, requireClosure = true } = {},
) {
  if (!requireClosure) {
    await verifyRepositoryFileBinding(
      metric.implementation,
      metric.implementationSha256,
      'PDF_BENCHMARK_METRIC_BINDING_MISMATCH',
      repositoryRoot,
    )
    return
  }
  const components = metric.implementationComponents
  const componentPaths = components.map((component) => component.path)
  if (
    components.length === 0 ||
    !unique(componentPaths) ||
    !componentPaths.includes(metric.implementation)
  ) {
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  }
  const closure = await deriveLocalExecutableImportClosure(
    metric.implementation,
    { repositoryRoot },
  )
  const closurePaths = closure.map((artifact) => artifact.path)
  if ([...componentPaths].sort().join('\n') !== closurePaths.join('\n')) {
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  }
  await Promise.all(
    components.map((component) =>
      verifyRepositoryFileBinding(
        component.path,
        component.fileSha256,
        'PDF_BENCHMARK_METRIC_BINDING_MISMATCH',
        repositoryRoot,
      ),
    ),
  )
  if (
    metricImplementationCompositeSha256(metric) !== metric.implementationSha256
  ) {
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  }
}

async function readBoundJson(binding, code) {
  try {
    const bytes = await verifyRepositoryFileBinding(
      binding.path,
      binding.fileSha256,
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
    await Promise.all([
      verifyMetricImplementationBinding(metric, {
        requireClosure: registry.schemaVersion === '2.0.0',
      }),
      verifyRepositoryFileBinding(metric.test, metric.testSha256),
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
  schemaPath = null,
}) {
  const absoluteRegistryPath = resolve(registryPath)
  const registryArtifact = await readJsonArtifact(
    absoluteRegistryPath,
    'PDF_BENCHMARK_READINESS_FAILED',
  )
  const registry = registryArtifact.value
  const schema = await validateSchema(registry, schemaPath)
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
    schemaPath: null,
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
    options.schemaPath &&
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

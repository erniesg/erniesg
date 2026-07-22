#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { canonicalJson, canonicalJsonHash } from './pdf-corpus-audit-lib.mjs'

export const PDF_BENCHMARK_COMPARISON_SCHEMA_VERSION = '1.4.0'

const METRICS = Object.freeze(
  [
    { key: 'textCoverage', direction: 'higher', tolerance: 0 },
    { key: 'missingSourceRegionCount', direction: 'lower', tolerance: 0 },
    {
      key: 'unprovenancedRenderedUnitCount',
      direction: 'lower',
      tolerance: 0,
    },
    { key: 'expectedInlineSpanCount', direction: 'higher', tolerance: 0 },
    { key: 'mappedInlineSpanCount', direction: 'higher', tolerance: 0 },
    { key: 'inlineSpanCoverage', direction: 'higher', tolerance: 0 },
    { key: 'assetCoverage', direction: 'higher', tolerance: 0 },
    { key: 'relationshipCoverage', direction: 'higher', tolerance: 0 },
    { key: 'duplicateCanonicalSpanCount', direction: 'lower', tolerance: 0 },
    { key: 'unresolvedCorruptingJoinCount', direction: 'lower', tolerance: 0 },
    { key: 'unresolvedObjectCount', direction: 'lower', tolerance: 0 },
    { key: 'readingOrderDiagnostics', direction: 'lower', tolerance: 0 },
  ].map((metric) => Object.freeze(metric)),
)

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const STRUCTURE_SHA_FIELDS = [
  'canonicalNodeSequenceSha256',
  'canonicalNodeTypeSequenceSha256',
  'canonicalContentSha256',
  'readingOrderGraphSha256',
  'visualRelationshipGraphSha256',
  'noteRelationshipGraphSha256',
  'citationRelationshipGraphSha256',
  'assetManifestSha256',
]
const STRUCTURE_COUNT_FIELDS = [
  'canonicalNodeCount',
  'visualRelationshipCount',
  'noteRelationshipCount',
  'citationRelationshipCount',
  'assetCount',
  'lineTransitionCount',
]
const STRUCTURE_COUNT_MAP_FIELDS = [
  'nodeCounts',
  'visualRelationshipCounts',
  'noteRelationshipCounts',
  'citationRelationshipCounts',
  'assetCounts',
]
const COMPLETENESS_INTEGER_FIELDS = [
  'sourceTextCharacters',
  'outputTextCharacters',
  'matchedTextCharacters',
  'missingSourceRegionCount',
  'unprovenancedRenderedUnitCount',
  'expectedInlineSpanCount',
  'mappedInlineSpanCount',
  'duplicateCanonicalSpanCount',
  'lineBoundaryCount',
  'decidedLineBoundaryCount',
  'unresolvedCorruptingJoinCount',
  'structurallyConsumedLineBoundaryCount',
  'sourceAssetCount',
  'exportedAssetCount',
  'expectedRelationshipCount',
  'resolvedRelationshipCount',
  'unresolvedObjectCount',
  'readingOrderDiagnostics',
]
const UNRESOLVED_OBJECT_FIELDS = [
  'assets',
  'captions',
  'tables',
  'equations',
  'citations',
  'footnoteReferences',
  'footnotes',
]
const DIAGNOSTIC_SAMPLE_LIMIT = Object.freeze({ total: 64, perCode: 3 })
const TARGETS = ['mobile', 'paperProMove', 'paperPro', 'print']
const EPUBCHECK_SKIPPED_REASONS = Object.freeze([
  'java-unavailable',
  'epubcheck-unavailable',
])

function rounded(value) {
  return Math.round(value * 100_000) / 100_000
}

function documentKey(document) {
  return document.sha256 ?? `basename:${document.basename}`
}

function status(document) {
  if (!document.readiness) return 'failed'
  return document.readiness.ready ? 'ready' : 'review-required'
}

function metricValue(document, key) {
  return document.completeness?.[key] ?? null
}

function metricChange(metric, baseline, candidate, tolerances) {
  if (baseline === null && candidate === null) return 'unchanged'
  if (candidate === null) return 'regressed'
  if (baseline === null) return 'improved'
  const tolerance = tolerances[metric.key] ?? metric.tolerance
  const delta = rounded(candidate - baseline)
  if (Math.abs(delta) <= tolerance) return 'unchanged'
  const improved = metric.direction === 'higher' ? delta > 0 : delta < 0
  return improved ? 'improved' : 'regressed'
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalidReport() {
  throw new Error('INVALID_BENCHMARK_REPORT')
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

function hasOnlyAndRequiredKeys(value, allowed, required) {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  )
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isUnitInterval(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  )
}

function validCountMap(value) {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, count]) =>
        SAFE_IDENTIFIER_PATTERN.test(key) &&
        Number.isSafeInteger(count) &&
        count >= 1,
    )
  )
}

function countMapTotal(value) {
  return Object.values(value).reduce((total, count) => total + count, 0)
}

function validSourceBox(value) {
  return (
    hasExactKeys(value, [
      'page',
      'x',
      'y',
      'width',
      'height',
      'rotation',
      'method',
    ]) &&
    Number.isSafeInteger(value.page) &&
    value.page >= 1 &&
    ['x', 'y', 'width', 'height', 'rotation'].every(
      (field) =>
        typeof value[field] === 'number' && Number.isFinite(value[field]),
    ) &&
    value.width >= 0 &&
    value.height >= 0 &&
    ['pdf-text', 'pdf-object', 'pdf-link', 'ocr'].includes(value.method)
  )
}

function validHashArray(value, { nonempty = false } = {}) {
  return (
    Array.isArray(value) &&
    (!nonempty || value.length > 0) &&
    value.every((item) => SHA256_PATTERN.test(String(item ?? ''))) &&
    new Set(value).size === value.length
  )
}

function validCanonicalAnchor(value) {
  return (
    value === null ||
    (hasExactKeys(value, ['nodeId', 'start', 'end']) &&
      SHA256_PATTERN.test(String(value.nodeId ?? '')) &&
      isNonNegativeInteger(value.start) &&
      Number.isSafeInteger(value.end) &&
      value.end > value.start)
  )
}

function validCitationRelationshipGraph(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (relationship) =>
        hasExactKeys(relationship, [
          'id',
          'status',
          'taxonomy',
          'referenceRegionId',
          'referenceStart',
          'referenceEnd',
          'labels',
          'targetNodeIds',
          'canonicalAnchor',
          'sourceBoxes',
        ]) &&
        SHA256_PATTERN.test(String(relationship.id ?? '')) &&
        ['matched', 'unresolved'].includes(relationship.status) &&
        [
          'bracketed-bibliography-citation',
          'author-year-bibliography-citation',
          'superscript-citation-cluster',
          'superscript-bibliography-citation',
          'human-reclassified-citation',
        ].includes(relationship.taxonomy) &&
        SHA256_PATTERN.test(String(relationship.referenceRegionId ?? '')) &&
        isNonNegativeInteger(relationship.referenceStart) &&
        Number.isSafeInteger(relationship.referenceEnd) &&
        relationship.referenceEnd > relationship.referenceStart &&
        validHashArray(relationship.labels, { nonempty: true }) &&
        validHashArray(relationship.targetNodeIds) &&
        validCanonicalAnchor(relationship.canonicalAnchor) &&
        Array.isArray(relationship.sourceBoxes) &&
        relationship.sourceBoxes.length > 0 &&
        relationship.sourceBoxes.every(validSourceBox),
    ) &&
    new Set(value.map((relationship) => relationship.id)).size === value.length
  )
}

function citationStatusCounts(graph) {
  const counts = {}
  for (const relationship of graph) {
    counts[relationship.status] = (counts[relationship.status] ?? 0) + 1
  }
  return counts
}

function validateStructure(structure) {
  if (
    !hasExactKeys(structure, [
      'schemaVersion',
      ...STRUCTURE_COUNT_FIELDS,
      ...STRUCTURE_COUNT_MAP_FIELDS,
      ...STRUCTURE_SHA_FIELDS,
      'citationRelationshipGraph',
      'lineTransitionLedgerAvailable',
      'lineTransitionLedgerSha256',
      'unresolvedCorruptingJoinCount',
      'structurallyConsumedLineBoundaryCount',
    ]) ||
    structure.schemaVersion !== '1.2.0' ||
    STRUCTURE_COUNT_FIELDS.some(
      (field) => !isNonNegativeInteger(structure[field]),
    ) ||
    STRUCTURE_COUNT_MAP_FIELDS.some(
      (field) => !validCountMap(structure[field]),
    ) ||
    STRUCTURE_SHA_FIELDS.some(
      (field) => !SHA256_PATTERN.test(String(structure[field] ?? '')),
    ) ||
    typeof structure.lineTransitionLedgerAvailable !== 'boolean' ||
    countMapTotal(structure.nodeCounts) !== structure.canonicalNodeCount ||
    countMapTotal(structure.visualRelationshipCounts) !==
      structure.visualRelationshipCount ||
    countMapTotal(structure.noteRelationshipCounts) !==
      structure.noteRelationshipCount ||
    !validCitationRelationshipGraph(structure.citationRelationshipGraph) ||
    structure.citationRelationshipGraph.length !==
      structure.citationRelationshipCount ||
    canonicalJson(structure.citationRelationshipCounts) !==
      canonicalJson(
        citationStatusCounts(structure.citationRelationshipGraph),
      ) ||
    structure.citationRelationshipGraphSha256 !==
      canonicalJsonHash(structure.citationRelationshipGraph) ||
    countMapTotal(structure.assetCounts) !== structure.assetCount
  ) {
    invalidReport()
  }
  if (structure.lineTransitionLedgerAvailable) {
    if (
      !SHA256_PATTERN.test(
        String(structure.lineTransitionLedgerSha256 ?? ''),
      ) ||
      !Number.isInteger(structure.unresolvedCorruptingJoinCount) ||
      structure.unresolvedCorruptingJoinCount < 0 ||
      !Number.isInteger(structure.structurallyConsumedLineBoundaryCount) ||
      structure.structurallyConsumedLineBoundaryCount < 0 ||
      structure.unresolvedCorruptingJoinCount +
        structure.structurallyConsumedLineBoundaryCount >
        structure.lineTransitionCount
    ) {
      invalidReport()
    }
  } else if (
    structure.lineTransitionCount !== 0 ||
    structure.lineTransitionLedgerSha256 !== null ||
    structure.unresolvedCorruptingJoinCount !== null ||
    structure.structurallyConsumedLineBoundaryCount !== null
  ) {
    invalidReport()
  }
}

function validateCompleteness(completeness) {
  if (
    !hasExactKeys(completeness, [
      ...COMPLETENESS_INTEGER_FIELDS,
      'textCoverage',
      'inlineSpanCoverage',
      'assetCoverage',
      'relationshipCoverage',
      'unresolvedObjects',
      'ocrRequiredPages',
      'readingOrderEvaluation',
    ]) ||
    COMPLETENESS_INTEGER_FIELDS.some(
      (field) => !isNonNegativeInteger(completeness[field]),
    ) ||
    METRICS.filter(({ key }) => key.endsWith('Coverage')).some(
      ({ key }) => !isUnitInterval(completeness[key]),
    ) ||
    !hasExactKeys(completeness.unresolvedObjects, UNRESOLVED_OBJECT_FIELDS) ||
    UNRESOLVED_OBJECT_FIELDS.some(
      (field) => !isNonNegativeInteger(completeness.unresolvedObjects[field]),
    ) ||
    countMapTotal(completeness.unresolvedObjects) !==
      completeness.unresolvedObjectCount ||
    completeness.unresolvedCorruptingJoinCount +
      completeness.structurallyConsumedLineBoundaryCount >
      completeness.decidedLineBoundaryCount ||
    completeness.mappedInlineSpanCount > completeness.expectedInlineSpanCount ||
    completeness.inlineSpanCoverage !==
      (completeness.expectedInlineSpanCount === 0
        ? 1
        : rounded(
            completeness.mappedInlineSpanCount /
              completeness.expectedInlineSpanCount,
          )) ||
    !Array.isArray(completeness.ocrRequiredPages) ||
    completeness.ocrRequiredPages.some(
      (page) => !Number.isSafeInteger(page) || page < 1,
    ) ||
    new Set(completeness.ocrRequiredPages).size !==
      completeness.ocrRequiredPages.length
  ) {
    invalidReport()
  }
  validateReadingOrderEvaluation(completeness.readingOrderEvaluation)
}

function validateReadingOrderEvaluation(evaluation) {
  if (
    !hasExactKeys(evaluation, [
      'schemaVersion',
      'algorithm',
      'mode',
      'regionCount',
      'acceptedEdgeCount',
      'unresolvedEdgeCount',
      'cycleRate',
      'orderAccuracy',
      'provider',
      'modelVersion',
      'latencyMs',
      'costUsd',
      'reviewRequired',
    ]) ||
    evaluation.schemaVersion !== '1.0.0' ||
    evaluation.algorithm !== 'deterministic-geometry-v1' ||
    evaluation.mode !== 'deterministic-only' ||
    ['regionCount', 'acceptedEdgeCount', 'unresolvedEdgeCount'].some(
      (key) => !isNonNegativeInteger(evaluation[key]),
    ) ||
    !isUnitInterval(evaluation.cycleRate) ||
    !(
      evaluation.orderAccuracy === null ||
      isUnitInterval(evaluation.orderAccuracy)
    ) ||
    evaluation.provider !== null ||
    evaluation.modelVersion !== null ||
    evaluation.latencyMs !== 0 ||
    evaluation.costUsd !== 0 ||
    typeof evaluation.reviewRequired !== 'boolean'
  ) {
    invalidReport()
  }
}

function validatePolicy(policy) {
  if (
    !hasExactKeys(policy, [
      'minimumTextCoverage',
      'minimumAssetCoverage',
      'minimumRelationshipCoverage',
      'maximumUnresolvedObjects',
      'maximumOcrRequiredPages',
      'maximumReadingOrderDiagnostics',
    ]) ||
    [
      'minimumTextCoverage',
      'minimumAssetCoverage',
      'minimumRelationshipCoverage',
    ].some((field) => !isUnitInterval(policy[field])) ||
    [
      'maximumUnresolvedObjects',
      'maximumOcrRequiredPages',
      'maximumReadingOrderDiagnostics',
    ].some((field) => !isNonNegativeInteger(policy[field]))
  ) {
    invalidReport()
  }
}

function validateExports(exports) {
  if (exports === undefined) return
  if (!Array.isArray(exports)) invalidReport()
  const targets = new Set()
  for (const artifact of exports) {
    if (
      !hasExactKeys(artifact, [
        'target',
        'basename',
        'mode',
        'byteLength',
        'sha256',
        'structuralValidation',
        'epubCheck',
      ]) ||
      !TARGETS.includes(artifact.target) ||
      !/^publication-[a-z-]+\.epub$/.test(artifact.basename) ||
      !['publication', 'readable-fallback'].includes(artifact.mode) ||
      !Number.isSafeInteger(artifact.byteLength) ||
      artifact.byteLength <= 0 ||
      !SHA256_PATTERN.test(String(artifact.sha256 ?? '')) ||
      artifact.structuralValidation !== 'passed' ||
      targets.has(artifact.target)
    ) {
      invalidReport()
    }
    validateEpubCheck(artifact.epubCheck)
    targets.add(artifact.target)
  }
}

function validateEpubCheck(epubCheck) {
  if (!isRecord(epubCheck)) invalidReport()
  if (epubCheck.status === 'skipped') {
    if (
      !hasExactKeys(epubCheck, ['status', 'reason']) ||
      !EPUBCHECK_SKIPPED_REASONS.includes(epubCheck.reason)
    ) {
      invalidReport()
    }
    return
  }
  if (
    !hasExactKeys(epubCheck, ['status']) ||
    !['passed', 'failed'].includes(epubCheck.status)
  ) {
    invalidReport()
  }
}

function validateReadiness(readiness) {
  if (
    !hasExactKeys(readiness, [
      'status',
      'ready',
      'policy',
      'blockingDiagnosticCodes',
    ]) ||
    !['ready', 'review-required'].includes(readiness.status) ||
    typeof readiness.ready !== 'boolean' ||
    readiness.ready !== (readiness.status === 'ready') ||
    !Array.isArray(readiness.blockingDiagnosticCodes) ||
    readiness.blockingDiagnosticCodes.some(
      (code) => typeof code !== 'string' || !SAFE_IDENTIFIER_PATTERN.test(code),
    ) ||
    new Set(readiness.blockingDiagnosticCodes).size !==
      readiness.blockingDiagnosticCodes.length
  ) {
    invalidReport()
  }
  validatePolicy(readiness.policy)
}

function validateDiagnostic(diagnostic) {
  if (
    !hasOnlyAndRequiredKeys(
      diagnostic,
      ['code', 'severity', 'page', 'message'],
      ['code', 'severity', 'message'],
    ) ||
    typeof diagnostic.code !== 'string' ||
    !SAFE_IDENTIFIER_PATTERN.test(diagnostic.code) ||
    !['info', 'warning', 'error'].includes(diagnostic.severity) ||
    typeof diagnostic.message !== 'string' ||
    diagnostic.message.length === 0 ||
    (diagnostic.page !== undefined &&
      (!Number.isSafeInteger(diagnostic.page) || diagnostic.page < 1))
  ) {
    invalidReport()
  }
}

function validateSummary(summary, documents) {
  const ready = documents.filter((document) => document.readiness?.ready).length
  const reviewRequired = documents.filter(
    (document) => document.readiness && !document.readiness.ready,
  ).length
  const failed = documents.filter((document) => !document.readiness).length
  const expectedPassRate = documents.length === 0 ? 0 : ready / documents.length
  if (
    !hasExactKeys(summary, [
      'documents',
      'ready',
      'reviewRequired',
      'failed',
      'passRate',
      'failureReasons',
    ]) ||
    !isNonNegativeInteger(summary.documents) ||
    !isNonNegativeInteger(summary.ready) ||
    !isNonNegativeInteger(summary.reviewRequired) ||
    !isNonNegativeInteger(summary.failed) ||
    !isUnitInterval(summary.passRate) ||
    !validCountMap(summary.failureReasons) ||
    summary.documents !== documents.length ||
    summary.ready !== ready ||
    summary.reviewRequired !== reviewRequired ||
    summary.failed !== failed ||
    summary.passRate !== expectedPassRate
  ) {
    invalidReport()
  }
}

function validateReport(report) {
  if (
    !hasExactKeys(report, [
      'schemaVersion',
      'reportSchema',
      'privacy',
      'policy',
      'summary',
      'documents',
    ]) ||
    report.schemaVersion !== '1.4.0' ||
    report.reportSchema !== 'docs/schemas/pdf-corpus-audit.schema.json' ||
    report.privacy !== 'basenames-hashes-metrics-diagnostics-only' ||
    !Array.isArray(report.documents)
  ) {
    invalidReport()
  }
  validatePolicy(report.policy)
  const keys = new Set()
  for (const document of report.documents) {
    if (
      !isRecord(document) ||
      typeof document.basename !== 'string' ||
      document.basename.length === 0 ||
      /[\\/]/u.test(document.basename)
    ) {
      invalidReport()
    }
    const key = documentKey(document)
    if (keys.has(key)) invalidReport()
    keys.add(key)

    if (!Object.hasOwn(document, 'readiness')) {
      if (
        !hasExactKeys(document, ['basename', 'sha256', 'code', 'message']) ||
        document.sha256 !== null ||
        typeof document.code !== 'string' ||
        !SAFE_IDENTIFIER_PATTERN.test(document.code) ||
        typeof document.message !== 'string' ||
        document.message.length === 0
      ) {
        invalidReport()
      }
      continue
    }

    const auditedKeys = [
      'basename',
      'sha256',
      'byteLength',
      'pageCount',
      'completeness',
      'readiness',
      'structure',
      'diagnosticCounts',
      'diagnosticSampleLimit',
      'diagnosticSamplesTruncated',
      'diagnostics',
    ]
    if (
      !hasOnlyAndRequiredKeys(
        document,
        [...auditedKeys, 'exports'],
        auditedKeys,
      ) ||
      !SHA256_PATTERN.test(String(document.sha256 ?? '')) ||
      !isNonNegativeInteger(document.byteLength) ||
      !Number.isSafeInteger(document.pageCount) ||
      document.pageCount < 1 ||
      !validCountMap(document.diagnosticCounts) ||
      !hasExactKeys(document.diagnosticSampleLimit, ['total', 'perCode']) ||
      document.diagnosticSampleLimit.total !== DIAGNOSTIC_SAMPLE_LIMIT.total ||
      document.diagnosticSampleLimit.perCode !==
        DIAGNOSTIC_SAMPLE_LIMIT.perCode ||
      !isNonNegativeInteger(document.diagnosticSamplesTruncated) ||
      !Array.isArray(document.diagnostics) ||
      document.diagnostics.length > DIAGNOSTIC_SAMPLE_LIMIT.total ||
      document.diagnostics.length + document.diagnosticSamplesTruncated !==
        countMapTotal(document.diagnosticCounts)
    ) {
      invalidReport()
    }

    const sampleCounts = new Map()
    for (const diagnostic of document.diagnostics) {
      validateDiagnostic(diagnostic)
      const count = (sampleCounts.get(diagnostic.code) ?? 0) + 1
      if (
        count > DIAGNOSTIC_SAMPLE_LIMIT.perCode ||
        count > (document.diagnosticCounts[diagnostic.code] ?? 0)
      ) {
        invalidReport()
      }
      sampleCounts.set(diagnostic.code, count)
    }
    validateReadiness(document.readiness)
    if (
      canonicalJson(document.readiness.policy) !== canonicalJson(report.policy)
    ) {
      invalidReport()
    }
    validateCompleteness(document.completeness)
    validateStructure(document.structure)
    if (
      document.completeness.decidedLineBoundaryCount !==
        document.structure.lineTransitionCount ||
      document.completeness.unresolvedCorruptingJoinCount !==
        (document.structure.unresolvedCorruptingJoinCount ?? 0) ||
      document.completeness.structurallyConsumedLineBoundaryCount !==
        (document.structure.structurallyConsumedLineBoundaryCount ?? 0)
    ) {
      invalidReport()
    }
    validateExports(document.exports)
  }
  validateSummary(report.summary, report.documents)
}

function validateTolerances(tolerances) {
  if (!isRecord(tolerances)) throw new Error('INVALID_TOLERANCE')
  for (const [key, value] of Object.entries(tolerances)) {
    if (
      !METRICS.some((metric) => metric.key === key) ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0
    ) {
      throw new Error('INVALID_TOLERANCE')
    }
  }
  return { ...tolerances }
}

function exportChecks(document) {
  return (document.exports ?? []).map((artifact) => ({
    target: artifact.target,
    mode: artifact.mode,
    structuralValidation: artifact.structuralValidation,
    epubCheck:
      artifact.epubCheck.status === 'skipped'
        ? {
            status: artifact.epubCheck.status,
            reason: artifact.epubCheck.reason,
          }
        : { status: artifact.epubCheck.status },
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
  }))
}

function artifactExpectations(documents) {
  const byTarget = new Map()
  for (const document of documents) {
    for (const artifact of exportChecks(document)) {
      const expectation = byTarget.get(artifact.target) ?? {
        target: artifact.target,
        requirePassedEpubCheck: false,
      }
      expectation.requirePassedEpubCheck ||=
        artifact.epubCheck.status === 'passed'
      byTarget.set(artifact.target, expectation)
    }
  }
  return [...byTarget.values()].sort((left, right) =>
    left.target.localeCompare(right.target),
  )
}

function addedDocumentCheck(document, expectations) {
  const documentStatus = status(document)
  const artifacts = exportChecks(document)
  const expectedTargets = expectations.map(({ target }) => target)
  const missingTargets = expectedTargets.filter(
    (target) => !artifacts.some((artifact) => artifact.target === target),
  )
  const invalid =
    artifacts.some(
      (artifact) =>
        artifact.structuralValidation !== 'passed' ||
        artifact.epubCheck.status === 'failed' ||
        (documentStatus === 'ready' && artifact.mode !== 'publication'),
    ) ||
    expectations.some((expectation) => {
      const artifact = artifacts.find(
        (candidate) => candidate.target === expectation.target,
      )
      return (
        artifact !== undefined &&
        expectation.requirePassedEpubCheck &&
        artifact.epubCheck.status !== 'passed'
      )
    })
  return {
    basename: document.basename,
    sha256: document.sha256,
    status: documentStatus,
    passed:
      documentStatus === 'ready' && missingTargets.length === 0 && !invalid,
    artifacts: {
      expectedTargets,
      missingTargets,
      invalid,
    },
  }
}

function epubCheckRegression(baselineArtifacts, candidateArtifacts) {
  if (
    candidateArtifacts.some(
      (artifact) => artifact.epubCheck.status === 'failed',
    )
  ) {
    return true
  }
  return baselineArtifacts.some((baselineArtifact) => {
    const candidateArtifact = candidateArtifacts.find(
      (artifact) => artifact.target === baselineArtifact.target,
    )
    if (candidateArtifact === undefined) return false
    return (
      (baselineArtifact.mode === 'publication' &&
        candidateArtifact.mode !== 'publication') ||
      (baselineArtifact.epubCheck.status === 'passed' &&
        candidateArtifact.epubCheck.status !== 'passed')
    )
  })
}

function diagnosticChecks(baselineDocument, candidateDocument) {
  if (!baselineDocument.readiness || !candidateDocument.readiness) {
    return { available: false, regressed: false, changes: [] }
  }
  const baseline = baselineDocument.diagnosticCounts
  const candidate = candidateDocument.diagnosticCounts
  const codes = [
    ...new Set([...Object.keys(baseline), ...Object.keys(candidate)]),
  ].sort()
  const changes = codes.flatMap((code) => {
    const baselineCount = baseline[code] ?? 0
    const candidateCount = candidate[code] ?? 0
    const delta = candidateCount - baselineCount
    if (delta === 0) return []
    return [
      {
        code,
        baseline: baselineCount,
        candidate: candidateCount,
        delta,
        change: delta > 0 ? 'regressed' : 'improved',
      },
    ]
  })
  return {
    available: true,
    regressed: changes.some((change) => change.change === 'regressed'),
    changes,
  }
}

function structuralReceiptOutput(structure) {
  if (structure === null) return null
  const countMap = (counts) =>
    Object.fromEntries(
      Object.entries(counts).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    )
  return {
    schemaVersion: structure.schemaVersion,
    canonicalNodeCount: structure.canonicalNodeCount,
    canonicalNodeSequenceSha256: structure.canonicalNodeSequenceSha256,
    canonicalNodeTypeSequenceSha256: structure.canonicalNodeTypeSequenceSha256,
    canonicalContentSha256: structure.canonicalContentSha256,
    readingOrderGraphSha256: structure.readingOrderGraphSha256,
    nodeCounts: countMap(structure.nodeCounts),
    visualRelationshipCount: structure.visualRelationshipCount,
    visualRelationshipCounts: countMap(structure.visualRelationshipCounts),
    visualRelationshipGraphSha256: structure.visualRelationshipGraphSha256,
    noteRelationshipCount: structure.noteRelationshipCount,
    noteRelationshipCounts: countMap(structure.noteRelationshipCounts),
    noteRelationshipGraphSha256: structure.noteRelationshipGraphSha256,
    citationRelationshipCount: structure.citationRelationshipCount,
    citationRelationshipCounts: countMap(structure.citationRelationshipCounts),
    citationRelationshipGraph: structure.citationRelationshipGraph,
    citationRelationshipGraphSha256: structure.citationRelationshipGraphSha256,
    assetCount: structure.assetCount,
    assetCounts: countMap(structure.assetCounts),
    assetManifestSha256: structure.assetManifestSha256,
    lineTransitionLedgerAvailable: structure.lineTransitionLedgerAvailable,
    lineTransitionCount: structure.lineTransitionCount,
    lineTransitionLedgerSha256: structure.lineTransitionLedgerSha256,
    unresolvedCorruptingJoinCount: structure.unresolvedCorruptingJoinCount,
    structurallyConsumedLineBoundaryCount:
      structure.structurallyConsumedLineBoundaryCount,
  }
}

function structureChecks(
  baselineDocument,
  candidateDocument,
  requireIdenticalStructure,
) {
  const baselineReceipt = baselineDocument.structure ?? null
  const candidateReceipt = candidateDocument.structure ?? null
  const available = baselineReceipt !== null && candidateReceipt !== null
  const identical =
    available &&
    canonicalJson(baselineReceipt) === canonicalJson(candidateReceipt)
  const ledger = {
    baseline: lineTransitionLedgerCheck(baselineReceipt),
    candidate: lineTransitionLedgerCheck(candidateReceipt),
  }
  return {
    baseline: structuralReceiptOutput(baselineReceipt),
    candidate: structuralReceiptOutput(candidateReceipt),
    available,
    identical,
    ledger,
    nondeterministic:
      requireIdenticalStructure &&
      (!available ||
        !identical ||
        !ledger.baseline.valid ||
        !ledger.candidate.valid),
  }
}

function lineTransitionLedgerCheck(structure) {
  const available = structure?.lineTransitionLedgerAvailable === true
  const count = structure?.lineTransitionCount
  const unresolved = structure?.unresolvedCorruptingJoinCount
  const structurallyConsumed = structure?.structurallyConsumedLineBoundaryCount
  const valid =
    available &&
    Number.isInteger(count) &&
    count >= 0 &&
    SHA256_PATTERN.test(String(structure?.lineTransitionLedgerSha256 ?? '')) &&
    Number.isInteger(unresolved) &&
    unresolved >= 0 &&
    Number.isInteger(structurallyConsumed) &&
    structurallyConsumed >= 0 &&
    unresolved + structurallyConsumed <= count
  return { available, valid }
}

export function comparePdfBenchmarkReports(
  baseline,
  candidate,
  {
    requireIdenticalArtifacts = false,
    requireIdenticalStructure = false,
    tolerances = {},
  } = {},
) {
  validateReport(baseline)
  validateReport(candidate)
  const validatedTolerances = validateTolerances(tolerances)
  const auditPolicy = {
    baseline: { ...baseline.policy },
    candidate: { ...candidate.policy },
    identical:
      canonicalJson(baseline.policy) === canonicalJson(candidate.policy),
  }
  const candidateByKey = new Map(
    candidate.documents.map((document) => [documentKey(document), document]),
  )
  const baselineKeys = new Set(
    baseline.documents.map((document) => documentKey(document)),
  )
  const expectedArtifacts = artifactExpectations(baseline.documents)
  const failedCandidateByBasename = new Map(
    candidate.documents
      .filter((document) => !document.readiness)
      .map((document) => [document.basename, document]),
  )
  const documents = baseline.documents.map((baselineDocument) => {
    const key = documentKey(baselineDocument)
    const candidateDocument =
      candidateByKey.get(key) ??
      (baselineDocument.readiness
        ? failedCandidateByBasename.get(baselineDocument.basename)
        : undefined)
    if (!candidateDocument) {
      return {
        basename: baselineDocument.basename,
        sha256: baselineDocument.sha256,
        verdict: 'regressed',
        reason: 'missing-candidate-document',
        metrics: [],
      }
    }
    const metrics = METRICS.map((metric) => {
      const baselineValue = metricValue(baselineDocument, metric.key)
      const candidateValue = metricValue(candidateDocument, metric.key)
      return {
        key: metric.key,
        direction: metric.direction,
        baseline: baselineValue,
        candidate: candidateValue,
        delta:
          baselineValue === null || candidateValue === null
            ? null
            : rounded(candidateValue - baselineValue),
        change: metricChange(
          metric,
          baselineValue,
          candidateValue,
          validatedTolerances,
        ),
      }
    })
    const baselineExports = exportChecks(baselineDocument)
    const candidateExports = exportChecks(candidateDocument)
    const invalidArtifact =
      candidateExports.some(
        (artifact) => artifact.structuralValidation !== 'passed',
      ) || epubCheckRegression(baselineExports, candidateExports)
    const missingArtifact = baselineExports.some(
      (artifact) =>
        !candidateExports.some(
          (candidateArtifact) => candidateArtifact.target === artifact.target,
        ),
    )
    const nondeterministicArtifact =
      requireIdenticalArtifacts &&
      baselineExports.some((artifact) => {
        const matching = candidateExports.find(
          (candidateArtifact) => candidateArtifact.target === artifact.target,
        )
        return matching && matching.sha256 !== artifact.sha256
      })
    const baselineStatus = status(baselineDocument)
    const candidateStatus = status(candidateDocument)
    const readinessRegression =
      (baselineStatus === 'ready' && candidateStatus !== 'ready') ||
      (baselineStatus === 'review-required' && candidateStatus === 'failed')
    const blockingDiagnostics = {
      added: (candidateDocument.readiness?.blockingDiagnosticCodes ?? [])
        .filter(
          (code) =>
            !(
              baselineDocument.readiness?.blockingDiagnosticCodes ?? []
            ).includes(code),
        )
        .sort(),
      removed: (baselineDocument.readiness?.blockingDiagnosticCodes ?? [])
        .filter(
          (code) =>
            !(
              candidateDocument.readiness?.blockingDiagnosticCodes ?? []
            ).includes(code),
        )
        .sort(),
    }
    const structure = structureChecks(
      baselineDocument,
      candidateDocument,
      requireIdenticalStructure,
    )
    const diagnostics = diagnosticChecks(baselineDocument, candidateDocument)
    const regressed =
      readinessRegression ||
      blockingDiagnostics.added.length > 0 ||
      invalidArtifact ||
      missingArtifact ||
      nondeterministicArtifact ||
      structure.nondeterministic ||
      diagnostics.regressed ||
      metrics.some((metric) => metric.change === 'regressed')
    const improved =
      metrics.some((metric) => metric.change === 'improved') ||
      diagnostics.changes.some((change) => change.change === 'improved')
    return {
      basename: baselineDocument.basename,
      sha256: baselineDocument.sha256,
      verdict: regressed ? 'regressed' : improved ? 'improved' : 'unchanged',
      status: {
        baseline: baselineStatus,
        candidate: candidateStatus,
      },
      metrics,
      blockingDiagnostics,
      artifacts: {
        baseline: baselineExports,
        candidate: candidateExports,
        invalid: invalidArtifact,
        missing: missingArtifact,
        nondeterministic: nondeterministicArtifact,
      },
      structure,
      diagnostics,
    }
  })
  const addedDocuments = candidate.documents
    .filter((document) => !baselineKeys.has(documentKey(document)))
    .map((document) => addedDocumentCheck(document, expectedArtifacts))
    .sort((left, right) => left.basename.localeCompare(right.basename))
  const failedEpubChecks = candidate.documents.reduce(
    (count, document) =>
      count +
      (document.exports ?? []).filter(
        (artifact) => artifact.epubCheck.status === 'failed',
      ).length,
    0,
  )
  const summary = {
    baselineDocuments: baseline.documents.length,
    candidateDocuments: candidate.documents.length,
    comparedDocuments: documents.length,
    improved: documents.filter((document) => document.verdict === 'improved')
      .length,
    unchanged: documents.filter((document) => document.verdict === 'unchanged')
      .length,
    regressed: documents.filter((document) => document.verdict === 'regressed')
      .length,
    added: addedDocuments.length,
    failedEpubChecks,
    passed:
      auditPolicy.identical &&
      failedEpubChecks === 0 &&
      addedDocuments.every((document) => document.passed) &&
      documents.every((document) => document.verdict !== 'regressed'),
  }
  return {
    schemaVersion: PDF_BENCHMARK_COMPARISON_SCHEMA_VERSION,
    privacy: 'basenames-hashes-metrics-artifact-invariants-only',
    policy: {
      metrics: METRICS.map((metric) => ({ ...metric })),
      tolerances: validatedTolerances,
      auditPolicy,
      requireIdenticalArtifacts,
      requireIdenticalStructure,
      artifactMode: { publicationToFallback: 'regression' },
      epubCheck: {
        failed: 'regression',
        passedToSkipped: 'regression',
        skipped: {
          allowedReasons: [...EPUBCHECK_SKIPPED_REASONS],
        },
      },
      note: 'This is a deterministic regression gate, not ground-truth accuracy. Promote parser or model changes only with frozen human gold annotations for ambiguous semantics.',
    },
    summary,
    documents,
    addedDocuments,
  }
}

function usage() {
  return 'Usage: node tools/pdf-benchmark-compare.mjs <baseline-corpus-audit.json> <candidate-corpus-audit.json> [--out <comparison.json>] [--tolerance <metric>=<value>]... [--require-identical-artifacts] [--require-identical-structure]\n'
}

function parseArguments(arguments_) {
  const inputs = []
  const tolerances = {}
  let output
  let requireIdenticalArtifacts = false
  let requireIdenticalStructure = false
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--out') {
      output = arguments_[++index]
      if (!output || output.startsWith('--')) throw new Error('INVALID_USAGE')
    } else if (argument === '--tolerance') {
      const rawTolerance = arguments_[++index] ?? ''
      const [key, rawValue, extra] = rawTolerance.split('=')
      const value = Number(rawValue)
      if (
        extra !== undefined ||
        rawValue === '' ||
        !METRICS.some((metric) => metric.key === key) ||
        !Number.isFinite(value) ||
        value < 0
      ) {
        throw new Error('INVALID_TOLERANCE')
      }
      tolerances[key] = value
    } else if (argument === '--require-identical-artifacts') {
      requireIdenticalArtifacts = true
    } else if (argument === '--require-identical-structure') {
      requireIdenticalStructure = true
    } else if (argument.startsWith('--')) {
      throw new Error('INVALID_USAGE')
    } else {
      inputs.push(argument)
    }
  }
  if (inputs.length !== 2 || (output !== undefined && !output)) {
    throw new Error('INVALID_USAGE')
  }
  return {
    inputs,
    output,
    tolerances,
    requireIdenticalArtifacts,
    requireIdenticalStructure,
  }
}

async function main() {
  let parsed
  try {
    parsed = parseArguments(process.argv.slice(2))
  } catch {
    process.stderr.write(usage())
    process.exitCode = 2
    return
  }
  const [baseline, candidate] = await Promise.all(
    parsed.inputs.map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
  )
  const comparison = comparePdfBenchmarkReports(baseline, candidate, parsed)
  const serialized = `${JSON.stringify(comparison, null, 2)}\n`
  if (parsed.output) await writeFile(parsed.output, serialized)
  else process.stdout.write(serialized)
  if (!comparison.summary.passed) process.exitCode = 1
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.stderr.write(
      'PDF benchmark comparison failed without exposing local paths.\n',
    )
    process.exitCode = 2
  })
}

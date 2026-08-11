#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  canonicalJson,
  canonicalJsonHash,
  canonicalPassRate,
  PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE_SHA256S,
  PDF_HYPHEN_LEXICAL_MODEL_RECEIPT,
  PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE_RECEIPT,
  PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE_SHA256S,
  PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE_SHA256S,
  validPdfCitationRelationshipTargetState,
} from './pdf-corpus-audit-lib.mjs'

export const PDF_BENCHMARK_COMPARISON_SCHEMA_VERSION = '1.5.0'
export const PDF_BENCHMARK_COMPARISON_OCR_SCHEMA_VERSION = '1.6.0'
export const PDF_BENCHMARK_COMPARISON_PROVENANCE_SCHEMA_VERSION = '1.7.0'
export const PDF_BENCHMARK_COMPARISON_V18_SCHEMA_VERSION = '1.8.0'
export const PDF_BENCHMARK_COMPARISON_V19_SCHEMA_VERSION = '1.9.0'
export const PDF_BENCHMARK_COMPARISON_V110_SCHEMA_VERSION = '1.10.0'

const CORPUS_REPORT_SCHEMA_POLICY_V15 = 'v1.5-only'
const CORPUS_REPORT_SCHEMA_POLICY_V15_V16 = 'v1.5-v1.6-compatible'
const CORPUS_REPORT_SCHEMA_POLICY_V17 = 'v1.7-only'
const CORPUS_REPORT_SCHEMA_POLICY_V18 = 'v1.8-only'
const CORPUS_REPORT_SCHEMA_POLICY_V19 = 'v1.9-only'
const CORPUS_REPORT_SCHEMA_POLICY_V110 = 'v1.10-only'
const CORPUS_REPORT_SCHEMAS = Object.freeze({
  '1.5.0': 'docs/schemas/pdf-corpus-audit.schema.json',
  '1.6.0': 'docs/schemas/pdf-corpus-audit-v1.6.schema.json',
  '1.7.0': 'docs/schemas/pdf-corpus-audit-v1.7.schema.json',
  '1.8.0': 'docs/schemas/pdf-corpus-audit-v1.8.schema.json',
  '1.9.0': 'docs/schemas/pdf-corpus-audit-v1.9.schema.json',
  '1.10.0': 'docs/schemas/pdf-corpus-audit-v1.10.schema.json',
})

const LEGACY_METRICS = Object.freeze(
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
    { key: 'expectedHyperlinkCount', direction: 'higher', tolerance: 0 },
    { key: 'mappedHyperlinkCount', direction: 'higher', tolerance: 0 },
    { key: 'hyperlinkCoverage', direction: 'higher', tolerance: 0 },
    { key: 'assetCoverage', direction: 'higher', tolerance: 0 },
    { key: 'relationshipCoverage', direction: 'higher', tolerance: 0 },
    {
      key: 'expectedSemanticTableCount',
      direction: 'higher',
      tolerance: 0,
    },
    {
      key: 'resolvedSemanticTableCount',
      direction: 'higher',
      tolerance: 0,
    },
    { key: 'semanticTableCoverage', direction: 'higher', tolerance: 0 },
    { key: 'duplicateCanonicalSpanCount', direction: 'lower', tolerance: 0 },
    { key: 'unresolvedCorruptingJoinCount', direction: 'lower', tolerance: 0 },
    { key: 'unresolvedObjectCount', direction: 'lower', tolerance: 0 },
    { key: 'readingOrderDiagnostics', direction: 'lower', tolerance: 0 },
  ].map((metric) => Object.freeze(metric)),
)
const V18_SAME_EVALUATOR_METRICS = Object.freeze(
  [
    { key: 'sourceAssetCount', direction: 'exact', tolerance: 0 },
    { key: 'exportedAssetCount', direction: 'higher', tolerance: 0 },
    { key: 'expectedRelationshipCount', direction: 'exact', tolerance: 0 },
    { key: 'resolvedRelationshipCount', direction: 'higher', tolerance: 0 },
  ].map((metric) => Object.freeze(metric)),
)
const V18_METRICS = Object.freeze([
  ...LEGACY_METRICS.slice(0, 9),
  ...V18_SAME_EVALUATOR_METRICS.slice(0, 2),
  LEGACY_METRICS[9],
  ...V18_SAME_EVALUATOR_METRICS.slice(2),
  LEGACY_METRICS[10],
  ...LEGACY_METRICS.slice(11),
])

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const GIT_OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const GIT_COMMIT_TIMESTAMP_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/
const SEMANTIC_VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const STRUCTURE_SHA_FIELDS = [
  'canonicalNodeSequenceSha256',
  'canonicalNodeTypeSequenceSha256',
  'canonicalContentSha256',
  'canonicalNodeProvenanceSha256',
  'readingOrderGraphSha256',
  'visualRelationshipGraphSha256',
  'noteRelationshipGraphSha256',
  'citationRelationshipGraphSha256',
  'crossReferenceRelationshipGraphSha256',
  'assetManifestSha256',
]
const STRUCTURE_COUNT_FIELDS = [
  'canonicalNodeCount',
  'visualRelationshipCount',
  'noteRelationshipCount',
  'citationRelationshipCount',
  'crossReferenceRelationshipCount',
  'assetCount',
  'lineTransitionCount',
]
const STRUCTURE_COUNT_MAP_FIELDS = [
  'nodeCounts',
  'visualRelationshipCounts',
  'noteRelationshipCounts',
  'citationRelationshipCounts',
  'crossReferenceRelationshipCounts',
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
  'expectedHyperlinkCount',
  'mappedHyperlinkCount',
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
const SEMANTIC_TABLE_COMPLETENESS_INTEGER_FIELDS = [
  'expectedSemanticTableCount',
  'resolvedSemanticTableCount',
]
const SEMANTIC_TABLE_METRIC_KEYS = new Set([
  ...SEMANTIC_TABLE_COMPLETENESS_INTEGER_FIELDS,
  'semanticTableCoverage',
])
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
const TARGET_FILE_SLUGS = Object.freeze({
  mobile: 'mobile',
  paperProMove: 'paper-pro-move',
  paperPro: 'paper-pro',
  print: 'print',
})
const EPUBCHECK_SKIPPED_REASONS = Object.freeze([
  'java-unavailable',
  'epubcheck-unavailable',
])
const NON_DIRECTIONAL_DIAGNOSTIC_CODES = new Set([
  // This is emitted once per region whose ordering was successfully resolved.
  // Its volume follows the number of affected regions, not unresolved risk.
  'RESOLVED_READING_ORDER',
  // This records a safe no-op: an optional float move was skipped while the
  // source-proved visual-caption order remained intact.
  'SOURCE_ORDER_FLOAT_FALLBACK',
])

function rounded(value) {
  return Math.round(value * 100_000) / 100_000
}

function exactCoverage(resolved, expected) {
  return expected === 0 ? 1 : rounded(Math.min(resolved / expected, 1))
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
  if (baseline === null) {
    // Optional evidence added after a receipt schema shipped cannot promote
    // against an unmeasured baseline. Re-freeze an independently accepted
    // baseline with the same denominator before comparing this metric.
    return SEMANTIC_TABLE_METRIC_KEYS.has(metric.key) ? 'regressed' : 'improved'
  }
  if (metric.key === 'expectedSemanticTableCount') {
    return candidate === baseline ? 'unchanged' : 'regressed'
  }
  if (metric.direction === 'exact') {
    return candidate === baseline ? 'unchanged' : 'regressed'
  }
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

function validateCorpusReportSchemaPolicy(value) {
  if (
    value !== CORPUS_REPORT_SCHEMA_POLICY_V15 &&
    value !== CORPUS_REPORT_SCHEMA_POLICY_V15_V16 &&
    value !== CORPUS_REPORT_SCHEMA_POLICY_V17 &&
    value !== CORPUS_REPORT_SCHEMA_POLICY_V18 &&
    value !== CORPUS_REPORT_SCHEMA_POLICY_V19 &&
    value !== CORPUS_REPORT_SCHEMA_POLICY_V110
  ) {
    throw new Error('INVALID_CORPUS_REPORT_SCHEMA_POLICY')
  }
  return value
}

function comparisonMetricsForSchemaPolicy(corpusReportSchemaPolicy) {
  return corpusReportSchemaPolicy === CORPUS_REPORT_SCHEMA_POLICY_V18 ||
    corpusReportSchemaPolicy === CORPUS_REPORT_SCHEMA_POLICY_V19 ||
    corpusReportSchemaPolicy === CORPUS_REPORT_SCHEMA_POLICY_V110
    ? V18_METRICS
    : LEGACY_METRICS
}

function validateExecutionProvenance(value) {
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'implementation',
      'runtime',
      'tool',
      'toolchain',
      'verification',
    ]) ||
    value.schemaVersion !== '1.1.0' ||
    !hasExactKeys(value.implementation, [
      'gitCommit',
      'gitCommitTimestamp',
      'worktreeState',
      'exactHead',
    ]) ||
    !GIT_OBJECT_ID_PATTERN.test(value.implementation.gitCommit ?? '') ||
    typeof value.implementation.gitCommitTimestamp !== 'string' ||
    !GIT_COMMIT_TIMESTAMP_PATTERN.test(
      value.implementation.gitCommitTimestamp,
    ) ||
    Number.isNaN(Date.parse(value.implementation.gitCommitTimestamp)) ||
    !['clean', 'dirty'].includes(value.implementation.worktreeState) ||
    value.implementation.exactHead !==
      (value.implementation.worktreeState === 'clean') ||
    !hasExactKeys(value.runtime, [
      'name',
      'version',
      'platform',
      'architecture',
    ]) ||
    value.runtime.name !== 'node' ||
    !SEMANTIC_VERSION_PATTERN.test(value.runtime.version ?? '') ||
    !SAFE_IDENTIFIER_PATTERN.test(value.runtime.platform ?? '') ||
    !SAFE_IDENTIFIER_PATTERN.test(value.runtime.architecture ?? '') ||
    !hasExactKeys(value.tool, ['id', 'packageName', 'packageVersion']) ||
    !['pdf-corpus-audit', 'pdf-export'].includes(value.tool.id) ||
    value.tool.packageName !== 'astro-erudite' ||
    !SEMANTIC_VERSION_PATTERN.test(value.tool.packageVersion ?? '') ||
    !hasExactKeys(value.toolchain, ['packageLockSha256', 'pdfjsDist']) ||
    !SHA256_PATTERN.test(value.toolchain.packageLockSha256 ?? '') ||
    !hasExactKeys(value.toolchain.pdfjsDist, [
      'declaredVersion',
      'lockedVersion',
      'resolvedVersion',
      'resolvedPackageJsonSha256',
      'resolvedPackageContentsSha256',
    ]) ||
    !SEMANTIC_VERSION_PATTERN.test(
      value.toolchain.pdfjsDist.declaredVersion ?? '',
    ) ||
    value.toolchain.pdfjsDist.lockedVersion !==
      value.toolchain.pdfjsDist.declaredVersion ||
    value.toolchain.pdfjsDist.resolvedVersion !==
      value.toolchain.pdfjsDist.lockedVersion ||
    !SHA256_PATTERN.test(
      value.toolchain.pdfjsDist.resolvedPackageJsonSha256 ?? '',
    ) ||
    !SHA256_PATTERN.test(
      value.toolchain.pdfjsDist.resolvedPackageContentsSha256 ?? '',
    ) ||
    !hasExactKeys(value.verification, ['method', 'stateSha256']) ||
    value.verification.method !== 'before-after-exact-match-v1' ||
    !SHA256_PATTERN.test(value.verification.stateSha256 ?? '')
  ) {
    invalidReport()
  }
}

function validateOcrProvenance(value) {
  if (!Array.isArray(value) || value.length === 0) invalidReport()
  const pages = new Set()
  for (const page of value) {
    if (
      !hasExactKeys(page, [
        'page',
        'engine',
        'engineVersion',
        'model',
        'modelVersion',
        'languages',
        'languageMode',
        'rasterSha256',
        'confidence',
      ]) ||
      !Number.isSafeInteger(page.page) ||
      page.page < 1 ||
      pages.has(page.page) ||
      typeof page.engine !== 'string' ||
      !SAFE_IDENTIFIER_PATTERN.test(page.engine) ||
      typeof page.engineVersion !== 'string' ||
      !SAFE_IDENTIFIER_PATTERN.test(page.engineVersion) ||
      typeof page.model !== 'string' ||
      !SAFE_IDENTIFIER_PATTERN.test(page.model) ||
      typeof page.modelVersion !== 'string' ||
      !SAFE_IDENTIFIER_PATTERN.test(page.modelVersion) ||
      !Array.isArray(page.languages) ||
      page.languages.length === 0 ||
      new Set(page.languages).size !== page.languages.length ||
      page.languages.some(
        (language) =>
          typeof language !== 'string' ||
          !SAFE_IDENTIFIER_PATTERN.test(language),
      ) ||
      !['explicit', 'automatic-fallback'].includes(page.languageMode) ||
      typeof page.rasterSha256 !== 'string' ||
      !SHA256_PATTERN.test(page.rasterSha256) ||
      !isUnitInterval(page.confidence)
    ) {
      invalidReport()
    }
    pages.add(page.page)
  }
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

function validateCorpusContractBinding(binding) {
  if (
    !hasExactKeys(binding, [
      'schemaVersion',
      'setKey',
      'setId',
      'contractSha256',
      'documentIdentitySha256',
      'documents',
    ]) ||
    binding.schemaVersion !== '1.0.0' ||
    !['frozen', 'seededRandom'].includes(binding.setKey) ||
    !SAFE_IDENTIFIER_PATTERN.test(String(binding.setId ?? '')) ||
    !SHA256_PATTERN.test(String(binding.contractSha256 ?? '')) ||
    !SHA256_PATTERN.test(String(binding.documentIdentitySha256 ?? '')) ||
    !Array.isArray(binding.documents) ||
    binding.documents.length !== 10
  ) {
    invalidReport()
  }
  const ids = new Set()
  const hashes = new Set()
  for (const document of binding.documents) {
    if (
      !hasExactKeys(document, ['id', 'byteLength', 'sha256']) ||
      !SAFE_IDENTIFIER_PATTERN.test(String(document.id ?? '')) ||
      !Number.isSafeInteger(document.byteLength) ||
      document.byteLength <= 0 ||
      !SHA256_PATTERN.test(String(document.sha256 ?? '')) ||
      ids.has(document.id) ||
      hashes.has(document.sha256)
    ) {
      invalidReport()
    }
    ids.add(document.id)
    hashes.add(document.sha256)
  }
  if (canonicalJsonHash(binding.documents) !== binding.documentIdentitySha256) {
    invalidReport()
  }
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

function validCitationRelationshipGraph(value, legacy = false) {
  const keys = [
    'id',
    'status',
    'taxonomy',
    'referenceRegionId',
    'referenceStart',
    'referenceEnd',
    'labels',
    'targetNodeIds',
    ...(legacy ? [] : ['candidateNodeIds']),
    'canonicalAnchor',
    ...(legacy ? [] : ['evidenceSha256s']),
    'sourceBoxes',
  ]
  return (
    Array.isArray(value) &&
    value.every(
      (relationship) =>
        hasExactKeys(relationship, keys) &&
        SHA256_PATTERN.test(String(relationship.id ?? '')) &&
        (legacy
          ? ['matched', 'unresolved']
          : ['matched', 'ambiguous', 'unresolved']
        ).includes(relationship.status) &&
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
        (legacy ||
          (validHashArray(relationship.candidateNodeIds) &&
            validHashArray(relationship.evidenceSha256s, { nonempty: true }) &&
            validPdfCitationRelationshipTargetState(relationship))) &&
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

const CROSS_REFERENCE_KINDS = [
  'figure',
  'table',
  'section',
  'appendix',
  'equation',
]
const CROSS_REFERENCE_STATUSES = ['matched', 'ambiguous', 'unresolved']

function validCrossReferenceTarget(target) {
  if (
    !hasExactKeys(target, [
      'kind',
      'labelSha256',
      'referenceStart',
      'referenceEnd',
      'status',
      'candidateNodeIds',
      'targetNodeId',
      'evidenceSha256s',
    ]) ||
    !CROSS_REFERENCE_KINDS.includes(target.kind) ||
    !SHA256_PATTERN.test(String(target.labelSha256 ?? '')) ||
    !isNonNegativeInteger(target.referenceStart) ||
    !Number.isSafeInteger(target.referenceEnd) ||
    target.referenceEnd <= target.referenceStart ||
    !CROSS_REFERENCE_STATUSES.includes(target.status) ||
    !validHashArray(target.candidateNodeIds) ||
    !validHashArray(target.evidenceSha256s, { nonempty: true })
  ) {
    return false
  }
  if (target.status === 'matched') {
    return (
      target.candidateNodeIds.length === 1 &&
      target.targetNodeId === target.candidateNodeIds[0]
    )
  }
  return (
    target.targetNodeId === null &&
    (target.status === 'ambiguous'
      ? target.candidateNodeIds.length > 1
      : target.candidateNodeIds.length === 0)
  )
}

function validCrossReferenceRelationship(relationship) {
  if (
    !hasExactKeys(relationship, [
      'id',
      'kind',
      'status',
      'textSha256',
      'referenceRegionId',
      'referenceStart',
      'referenceEnd',
      'labels',
      'targets',
      'targetNodeIds',
      'canonicalAnchor',
      'confidence',
      'evidenceSha256s',
      'sourceBoxes',
    ]) ||
    !SHA256_PATTERN.test(String(relationship.id ?? '')) ||
    !CROSS_REFERENCE_KINDS.includes(relationship.kind) ||
    !CROSS_REFERENCE_STATUSES.includes(relationship.status) ||
    !SHA256_PATTERN.test(String(relationship.textSha256 ?? '')) ||
    !SHA256_PATTERN.test(String(relationship.referenceRegionId ?? '')) ||
    !isNonNegativeInteger(relationship.referenceStart) ||
    !Number.isSafeInteger(relationship.referenceEnd) ||
    relationship.referenceEnd <= relationship.referenceStart ||
    !validHashArray(relationship.labels, { nonempty: true }) ||
    !Array.isArray(relationship.targets) ||
    relationship.targets.length === 0 ||
    relationship.targets.length !== relationship.labels.length ||
    !relationship.targets.every(validCrossReferenceTarget) ||
    relationship.targets.some(
      (target, index) =>
        target.kind !== relationship.kind ||
        target.labelSha256 !== relationship.labels[index] ||
        target.referenceStart < relationship.referenceStart ||
        target.referenceEnd > relationship.referenceEnd ||
        (index > 0 &&
          target.referenceStart <
            relationship.targets[index - 1].referenceEnd &&
          (target.referenceStart !==
            relationship.targets[index - 1].referenceStart ||
            target.referenceEnd !==
              relationship.targets[index - 1].referenceEnd)),
    ) ||
    !validHashArray(relationship.targetNodeIds) ||
    !validCanonicalAnchor(relationship.canonicalAnchor) ||
    !isUnitInterval(relationship.confidence) ||
    !validHashArray(relationship.evidenceSha256s, { nonempty: true }) ||
    !Array.isArray(relationship.sourceBoxes) ||
    relationship.sourceBoxes.length === 0 ||
    !relationship.sourceBoxes.every(validSourceBox)
  ) {
    return false
  }
  const derivedStatus = relationship.targets.some(
    (target) => target.status === 'ambiguous',
  )
    ? 'ambiguous'
    : relationship.targets.some((target) => target.status === 'unresolved')
      ? 'unresolved'
      : 'matched'
  const derivedTargetNodeIds =
    derivedStatus === 'matched'
      ? relationship.targets.map((target) => target.targetNodeId)
      : []
  return (
    relationship.status === derivedStatus &&
    canonicalJson(relationship.targetNodeIds) ===
      canonicalJson(derivedTargetNodeIds)
  )
}

function validCrossReferenceRelationshipGraph(value) {
  return (
    Array.isArray(value) &&
    value.every(validCrossReferenceRelationship) &&
    new Set(value.map((relationship) => relationship.id)).size === value.length
  )
}

function crossReferenceStatusCounts(graph) {
  const counts = {}
  for (const relationship of graph) {
    const key = `${relationship.kind}:${relationship.status}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function validLegacyCanonicalHyphenDeletionRecord(record) {
  const evidenceSha256s = record?.proof?.evidenceSha256s
  return (
    hasExactKeys(record, [
      'id',
      'context',
      'outcome',
      'fromRegionId',
      'fromLineId',
      'toRegionId',
      'toLineId',
      'geometry',
      'proof',
    ]) &&
    [
      record.id,
      record.fromRegionId,
      record.fromLineId,
      record.toRegionId,
      record.toLineId,
    ].every((value) => SHA256_PATTERN.test(String(value ?? ''))) &&
    ['bibliography-continuation', 'canonical-flow-continuation'].includes(
      record.context,
    ) &&
    record.outcome === 'removed-discretionary-hyphen' &&
    hasExactKeys(record.geometry, ['from', 'to']) &&
    validSourceBox(record.geometry.from) &&
    validSourceBox(record.geometry.to) &&
    hasExactKeys(record.proof, [
      'sourceBoundaryProven',
      'pinnedWordSha256',
      'pinnedJoinedFormValid',
      'pinnedSplit',
      'splitPointValid',
      'exactSameDocumentJoinedFormSha256',
      'sameDocumentJoinedFormValid',
      'hardHyphenFormSha256',
      'hardHyphenCounterproof',
      'model',
      'evidenceSha256s',
    ]) &&
    record.proof.sourceBoundaryProven === true &&
    SHA256_PATTERN.test(String(record.proof.pinnedWordSha256 ?? '')) &&
    record.proof.pinnedJoinedFormValid === true &&
    hasExactKeys(record.proof.pinnedSplit, [
      'leftSha256',
      'rightSha256',
      'index',
    ]) &&
    SHA256_PATTERN.test(String(record.proof.pinnedSplit.leftSha256 ?? '')) &&
    SHA256_PATTERN.test(String(record.proof.pinnedSplit.rightSha256 ?? '')) &&
    Number.isSafeInteger(record.proof.pinnedSplit.index) &&
    record.proof.pinnedSplit.index > 0 &&
    record.proof.splitPointValid === true &&
    SHA256_PATTERN.test(
      String(record.proof.exactSameDocumentJoinedFormSha256 ?? ''),
    ) &&
    record.proof.exactSameDocumentJoinedFormSha256 ===
      record.proof.pinnedWordSha256 &&
    record.proof.sameDocumentJoinedFormValid === true &&
    SHA256_PATTERN.test(String(record.proof.hardHyphenFormSha256 ?? '')) &&
    record.proof.hardHyphenFormSha256 !== record.proof.pinnedWordSha256 &&
    record.proof.hardHyphenCounterproof === null &&
    hasExactKeys(record.proof.model, [
      'id',
      'language',
      'dictionarySha256',
      'affixSha256',
      'hyphenationSha256',
    ]) &&
    canonicalJson(record.proof.model) ===
      canonicalJson(PDF_HYPHEN_LEXICAL_MODEL_RECEIPT) &&
    validHashArray(evidenceSha256s, { nonempty: true }) &&
    evidenceSha256s.every(
      (value, index) =>
        index === 0 || evidenceSha256s[index - 1].localeCompare(value) < 0,
    ) &&
    PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE_SHA256S.every((evidenceSha256) =>
      evidenceSha256s.includes(evidenceSha256),
    ) &&
    PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE_SHA256S.every(
      (evidenceSha256) => !evidenceSha256s.includes(evidenceSha256),
    )
  )
}

function validCanonicalHyphenDeletionRecord(record) {
  const evidenceSha256s = record?.proof?.evidenceSha256s
  if (
    !hasExactKeys(record, [
      'id',
      'context',
      'outcome',
      'fromRegionId',
      'fromLineId',
      'toRegionId',
      'toLineId',
      'geometry',
      'proof',
    ]) ||
    [
      record.id,
      record.fromRegionId,
      record.fromLineId,
      record.toRegionId,
      record.toLineId,
    ].some((value) => !SHA256_PATTERN.test(String(value ?? ''))) ||
    !['bibliography-continuation', 'canonical-flow-continuation'].includes(
      record.context,
    ) ||
    record.outcome !== 'removed-discretionary-hyphen' ||
    !hasExactKeys(record.geometry, ['from', 'to']) ||
    !validSourceBox(record.geometry.from) ||
    !validSourceBox(record.geometry.to) ||
    record.proof?.sourceBoundaryProven !== true ||
    !hasExactKeys(record.proof?.pinnedSplit, [
      'leftSha256',
      'rightSha256',
      'index',
    ]) ||
    !SHA256_PATTERN.test(String(record.proof.pinnedSplit.leftSha256 ?? '')) ||
    !SHA256_PATTERN.test(String(record.proof.pinnedSplit.rightSha256 ?? '')) ||
    !Number.isSafeInteger(record.proof.pinnedSplit.index) ||
    record.proof.pinnedSplit.index < 1 ||
    record.proof.splitPointValid !== true ||
    !SHA256_PATTERN.test(String(record.proof.hardHyphenFormSha256 ?? '')) ||
    record.proof.hardHyphenCounterproof !== null ||
    !hasExactKeys(record.proof.model, [
      'id',
      'language',
      'dictionarySha256',
      'affixSha256',
      'hyphenationSha256',
    ]) ||
    canonicalJson(record.proof.model) !==
      canonicalJson(PDF_HYPHEN_LEXICAL_MODEL_RECEIPT) ||
    !validHashArray(evidenceSha256s, { nonempty: true }) ||
    evidenceSha256s.some(
      (value, index) =>
        index > 0 && evidenceSha256s[index - 1].localeCompare(value) >= 0,
    ) ||
    PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE_SHA256S.some((evidenceSha256) =>
      evidenceSha256s.includes(evidenceSha256),
    )
  ) {
    return false
  }
  if (record.proof.tier === 'exact-same-document') {
    return (
      hasExactKeys(record.proof, [
        'tier',
        'sourceBoundaryProven',
        'pinnedWordSha256',
        'pinnedJoinedFormValid',
        'pinnedSplit',
        'splitPointValid',
        'exactSameDocumentJoinedFormSha256',
        'sameDocumentJoinedFormValid',
        'hardHyphenFormSha256',
        'hardHyphenCounterproof',
        'model',
        'evidenceSha256s',
      ]) &&
      SHA256_PATTERN.test(String(record.proof.pinnedWordSha256 ?? '')) &&
      record.proof.pinnedJoinedFormValid === true &&
      SHA256_PATTERN.test(
        String(record.proof.exactSameDocumentJoinedFormSha256 ?? ''),
      ) &&
      record.proof.exactSameDocumentJoinedFormSha256 ===
        record.proof.pinnedWordSha256 &&
      record.proof.sameDocumentJoinedFormValid === true &&
      record.proof.hardHyphenFormSha256 !== record.proof.pinnedWordSha256 &&
      PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE_SHA256S.every((evidenceSha256) =>
        evidenceSha256s.includes(evidenceSha256),
      )
    )
  }
  if (record.proof.tier !== 'same-document-derived-affix') return false
  return (
    hasExactKeys(record.proof, [
      'tier',
      'sourceBoundaryProven',
      'derivedWordSha256',
      'productivePrefix',
      'baseWordSha256',
      'derivationBindingSha256',
      'pinnedBaseWordValid',
      'pinnedSplit',
      'splitPointValid',
      'exactSameDocumentBaseWordSha256',
      'sameDocumentBaseWordValid',
      'hardHyphenFormSha256',
      'hardHyphenCounterproof',
      'model',
      'evidenceSha256s',
    ]) &&
    SHA256_PATTERN.test(String(record.proof.derivedWordSha256 ?? '')) &&
    hasExactKeys(record.proof.productivePrefix, [
      'kind',
      'value',
      'affixClass',
      'flag',
      'crossProduct',
      'affixSha256',
    ]) &&
    canonicalJson(record.proof.productivePrefix) ===
      canonicalJson(PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE_RECEIPT) &&
    SHA256_PATTERN.test(String(record.proof.baseWordSha256 ?? '')) &&
    SHA256_PATTERN.test(String(record.proof.derivationBindingSha256 ?? '')) &&
    record.proof.derivationBindingSha256 ===
      canonicalJsonHash({
        derivedWordSha256: record.proof.derivedWordSha256,
        productivePrefix: record.proof.productivePrefix,
        baseWordSha256: record.proof.baseWordSha256,
      }) &&
    record.proof.pinnedBaseWordValid === true &&
    SHA256_PATTERN.test(
      String(record.proof.exactSameDocumentBaseWordSha256 ?? ''),
    ) &&
    record.proof.exactSameDocumentBaseWordSha256 ===
      record.proof.baseWordSha256 &&
    record.proof.sameDocumentBaseWordValid === true &&
    record.proof.derivedWordSha256 !== record.proof.baseWordSha256 &&
    record.proof.hardHyphenFormSha256 !== record.proof.derivedWordSha256 &&
    record.proof.pinnedSplit.index >
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE_RECEIPT.value.length &&
    PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE_SHA256S.every(
      (evidenceSha256) => evidenceSha256s.includes(evidenceSha256),
    )
  )
}

function canonicalHyphenDeletionContextCounts(records) {
  const counts = {}
  for (const record of records) {
    counts[record.context] = (counts[record.context] ?? 0) + 1
  }
  return counts
}

function validCanonicalHyphenDeletionLedger(structure, legacy = false) {
  const records = structure.canonicalHyphenDeletionLedger
  return (
    structure.canonicalHyphenDeletionLedgerAvailable === true &&
    isNonNegativeInteger(structure.canonicalHyphenDeletionCount) &&
    Array.isArray(records) &&
    records.length === structure.canonicalHyphenDeletionCount &&
    records.every(
      legacy
        ? validLegacyCanonicalHyphenDeletionRecord
        : validCanonicalHyphenDeletionRecord,
    ) &&
    records.every(
      (record, index) =>
        index === 0 || records[index - 1].id.localeCompare(record.id) < 0,
    ) &&
    new Set(records.map((record) => record.id)).size === records.length &&
    new Set(
      records.map((record) =>
        [
          record.fromRegionId,
          record.fromLineId,
          record.toRegionId,
          record.toLineId,
        ].join('\0'),
      ),
    ).size === records.length &&
    validCountMap(structure.canonicalHyphenDeletionContextCounts) &&
    canonicalJson(structure.canonicalHyphenDeletionContextCounts) ===
      canonicalJson(canonicalHyphenDeletionContextCounts(records)) &&
    SHA256_PATTERN.test(
      String(structure.canonicalHyphenDeletionLedgerSha256 ?? ''),
    ) &&
    structure.canonicalHyphenDeletionLedgerSha256 === canonicalJsonHash(records)
  )
}

function validateStructure(structure, allowHistoricalV14 = false) {
  const current = structure?.schemaVersion === '1.7.0'
  const legacyV16 = structure?.schemaVersion === '1.6.0'
  const legacyV15 = structure?.schemaVersion === '1.5.0'
  const historical = allowHistoricalV14 && structure?.schemaVersion === '1.4.0'
  const canonicalHyphenFields = [
    'canonicalHyphenDeletionLedgerAvailable',
    'canonicalHyphenDeletionCount',
    'canonicalHyphenDeletionContextCounts',
    'canonicalHyphenDeletionLedger',
    'canonicalHyphenDeletionLedgerSha256',
  ]
  if (
    !hasExactKeys(structure, [
      'schemaVersion',
      ...STRUCTURE_COUNT_FIELDS,
      ...STRUCTURE_COUNT_MAP_FIELDS,
      ...STRUCTURE_SHA_FIELDS,
      'citationRelationshipGraph',
      'crossReferenceRelationshipGraph',
      'lineTransitionLedgerAvailable',
      'lineTransitionLedgerSha256',
      'unresolvedCorruptingJoinCount',
      'structurallyConsumedLineBoundaryCount',
      ...(current || legacyV16 || legacyV15 ? canonicalHyphenFields : []),
    ]) ||
    (!current && !legacyV16 && !legacyV15 && !historical) ||
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
    !validCitationRelationshipGraph(
      structure.citationRelationshipGraph,
      !current,
    ) ||
    structure.citationRelationshipGraph.length !==
      structure.citationRelationshipCount ||
    canonicalJson(structure.citationRelationshipCounts) !==
      canonicalJson(
        citationStatusCounts(structure.citationRelationshipGraph),
      ) ||
    structure.citationRelationshipGraphSha256 !==
      canonicalJsonHash(structure.citationRelationshipGraph) ||
    !validCrossReferenceRelationshipGraph(
      structure.crossReferenceRelationshipGraph,
    ) ||
    structure.crossReferenceRelationshipGraph.length !==
      structure.crossReferenceRelationshipCount ||
    canonicalJson(structure.crossReferenceRelationshipCounts) !==
      canonicalJson(
        crossReferenceStatusCounts(structure.crossReferenceRelationshipGraph),
      ) ||
    structure.crossReferenceRelationshipGraphSha256 !==
      canonicalJsonHash(structure.crossReferenceRelationshipGraph) ||
    countMapTotal(structure.assetCounts) !== structure.assetCount ||
    (current && !validCanonicalHyphenDeletionLedger(structure)) ||
    (legacyV16 && !validCanonicalHyphenDeletionLedger(structure)) ||
    (legacyV15 && !validCanonicalHyphenDeletionLedger(structure, true))
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
  if (!isRecord(completeness)) invalidReport()
  const hasSemanticTableMetrics = [
    ...SEMANTIC_TABLE_COMPLETENESS_INTEGER_FIELDS,
    'semanticTableCoverage',
  ].some((field) => Object.hasOwn(completeness, field))
  if (
    !hasExactKeys(completeness, [
      ...COMPLETENESS_INTEGER_FIELDS,
      ...(hasSemanticTableMetrics
        ? [
            ...SEMANTIC_TABLE_COMPLETENESS_INTEGER_FIELDS,
            'semanticTableCoverage',
          ]
        : []),
      'textCoverage',
      'inlineSpanCoverage',
      'hyperlinkCoverage',
      'assetCoverage',
      'relationshipCoverage',
      'unresolvedObjects',
      'ocrRequiredPages',
      'readingOrderEvaluation',
    ]) ||
    COMPLETENESS_INTEGER_FIELDS.some(
      (field) => !isNonNegativeInteger(completeness[field]),
    ) ||
    (hasSemanticTableMetrics &&
      SEMANTIC_TABLE_COMPLETENESS_INTEGER_FIELDS.some(
        (field) => !isNonNegativeInteger(completeness[field]),
      )) ||
    V18_METRICS.filter(({ key }) => key.endsWith('Coverage')).some(
      ({ key }) =>
        Object.hasOwn(completeness, key) && !isUnitInterval(completeness[key]),
    ) ||
    !hasExactKeys(completeness.unresolvedObjects, UNRESOLVED_OBJECT_FIELDS) ||
    UNRESOLVED_OBJECT_FIELDS.some(
      (field) => !isNonNegativeInteger(completeness.unresolvedObjects[field]),
    ) ||
    countMapTotal(completeness.unresolvedObjects) !==
      completeness.unresolvedObjectCount ||
    completeness.matchedTextCharacters > completeness.sourceTextCharacters ||
    completeness.matchedTextCharacters > completeness.outputTextCharacters ||
    completeness.textCoverage !==
      Math.min(
        exactCoverage(
          completeness.matchedTextCharacters,
          completeness.sourceTextCharacters,
        ),
        exactCoverage(
          completeness.matchedTextCharacters,
          completeness.outputTextCharacters,
        ),
      ) ||
    completeness.decidedLineBoundaryCount > completeness.lineBoundaryCount ||
    completeness.unresolvedCorruptingJoinCount +
      completeness.structurallyConsumedLineBoundaryCount >
      completeness.decidedLineBoundaryCount ||
    completeness.mappedInlineSpanCount > completeness.expectedInlineSpanCount ||
    completeness.inlineSpanCoverage !==
      exactCoverage(
        completeness.mappedInlineSpanCount,
        completeness.expectedInlineSpanCount,
      ) ||
    completeness.mappedHyperlinkCount > completeness.expectedHyperlinkCount ||
    completeness.hyperlinkCoverage !==
      exactCoverage(
        completeness.mappedHyperlinkCount,
        completeness.expectedHyperlinkCount,
      ) ||
    completeness.exportedAssetCount > completeness.sourceAssetCount ||
    completeness.assetCoverage !==
      exactCoverage(
        completeness.exportedAssetCount,
        completeness.sourceAssetCount,
      ) ||
    completeness.resolvedRelationshipCount >
      completeness.expectedRelationshipCount ||
    completeness.relationshipCoverage !==
      exactCoverage(
        completeness.resolvedRelationshipCount,
        completeness.expectedRelationshipCount,
      ) ||
    (hasSemanticTableMetrics &&
      (completeness.resolvedSemanticTableCount >
        completeness.expectedSemanticTableCount ||
        !isUnitInterval(completeness.semanticTableCoverage) ||
        completeness.semanticTableCoverage !==
          exactCoverage(
            completeness.resolvedSemanticTableCount,
            completeness.expectedSemanticTableCount,
          ))) ||
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
      !['publication', 'readable-fallback'].includes(artifact.mode) ||
      !new RegExp(
        `^[a-z0-9]+(?:-[a-z0-9]+)*-?-${TARGET_FILE_SLUGS[artifact.target]}-[a-f0-9]{12}${
          artifact.mode === 'readable-fallback' ? '-readable' : ''
        }\\.epub$`,
      ).test(artifact.basename) ||
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

function completenessBlocksReadiness(completeness, policy) {
  return (
    completeness.textCoverage < policy.minimumTextCoverage ||
    completeness.assetCoverage < policy.minimumAssetCoverage ||
    completeness.relationshipCoverage < policy.minimumRelationshipCoverage ||
    completeness.unresolvedObjectCount > policy.maximumUnresolvedObjects ||
    completeness.ocrRequiredPages.length > policy.maximumOcrRequiredPages ||
    completeness.readingOrderDiagnostics >
      policy.maximumReadingOrderDiagnostics ||
    completeness.readingOrderEvaluation.reviewRequired ||
    completeness.duplicateCanonicalSpanCount > 0 ||
    completeness.missingSourceRegionCount > 0 ||
    completeness.unprovenancedRenderedUnitCount > 0 ||
    completeness.inlineSpanCoverage < 1 ||
    completeness.hyperlinkCoverage < 1 ||
    completeness.decidedLineBoundaryCount < completeness.lineBoundaryCount ||
    completeness.unresolvedCorruptingJoinCount > 0
  )
}

function validateReadiness(
  readiness,
  completeness,
  diagnostics,
  diagnosticCounts,
) {
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
  const blockingCodes = new Set(readiness.blockingDiagnosticCodes)
  const errorCodes = new Set(
    diagnostics
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => diagnostic.code),
  )
  if (
    [...errorCodes].some((code) => !blockingCodes.has(code)) ||
    [...blockingCodes].some(
      (code) =>
        !isNonNegativeInteger(diagnosticCounts[code]) ||
        diagnosticCounts[code] === 0 ||
        !diagnostics.some((diagnostic) => diagnostic.code === code),
    )
  ) {
    invalidReport()
  }
  const derivedReady =
    blockingCodes.size === 0 &&
    errorCodes.size === 0 &&
    !completenessBlocksReadiness(completeness, readiness.policy)
  if (
    readiness.ready !== derivedReady ||
    readiness.status !== (derivedReady ? 'ready' : 'review-required')
  ) {
    invalidReport()
  }
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
  const expectedPassRate = canonicalPassRate(ready, documents.length)
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

function validateCorpusContractDocuments(binding, documents) {
  if (documents.length !== binding.documents.length) invalidReport()
  const expectedById = new Map(
    binding.documents.map((document) => [document.id, document]),
  )
  const seenIds = new Set()
  for (const document of documents) {
    if (!/\.pdf$/iu.test(document.basename)) invalidReport()
    const id = document.basename.slice(0, -4)
    const expected = expectedById.get(id)
    if (!expected || seenIds.has(id)) invalidReport()
    seenIds.add(id)
    if (
      Object.hasOwn(document, 'readiness') &&
      (document.sha256 !== expected.sha256 ||
        document.byteLength !== expected.byteLength)
    ) {
      invalidReport()
    }
  }
  if (seenIds.size !== expectedById.size) invalidReport()
}

function validateReport(report, corpusReportSchemaPolicy) {
  const requiredKeys = [
    'schemaVersion',
    'reportSchema',
    'privacy',
    'policy',
    'summary',
    'documents',
  ]
  const expectedReportSchema = CORPUS_REPORT_SCHEMAS[report?.schemaVersion]
  const compatibleSchema =
    isRecord(report) &&
    expectedReportSchema === report.reportSchema &&
    ((corpusReportSchemaPolicy === CORPUS_REPORT_SCHEMA_POLICY_V15 &&
      report.schemaVersion === '1.5.0') ||
      (corpusReportSchemaPolicy === CORPUS_REPORT_SCHEMA_POLICY_V15_V16 &&
        ['1.5.0', '1.6.0'].includes(report.schemaVersion)) ||
      (corpusReportSchemaPolicy === CORPUS_REPORT_SCHEMA_POLICY_V17 &&
        report.schemaVersion === '1.7.0') ||
      (corpusReportSchemaPolicy === CORPUS_REPORT_SCHEMA_POLICY_V18 &&
        report.schemaVersion === '1.8.0') ||
      (corpusReportSchemaPolicy === CORPUS_REPORT_SCHEMA_POLICY_V19 &&
        report.schemaVersion === '1.9.0') ||
      (corpusReportSchemaPolicy === CORPUS_REPORT_SCHEMA_POLICY_V110 &&
        report.schemaVersion === '1.10.0'))
  const provenanceKeys = ['1.7.0', '1.8.0', '1.9.0', '1.10.0'].includes(
    report?.schemaVersion,
  )
    ? ['executionProvenance']
    : []
  if (
    !hasOnlyAndRequiredKeys(
      report,
      [...requiredKeys, 'corpusContract', ...provenanceKeys],
      [...requiredKeys, ...provenanceKeys],
    ) ||
    !compatibleSchema ||
    report.privacy !== 'basenames-hashes-metrics-diagnostics-only' ||
    !Array.isArray(report.documents)
  ) {
    invalidReport()
  }
  if (['1.7.0', '1.8.0', '1.9.0', '1.10.0'].includes(report.schemaVersion)) {
    validateExecutionProvenance(report.executionProvenance)
  }
  if (Object.hasOwn(report, 'corpusContract')) {
    validateCorpusContractBinding(report.corpusContract)
  }
  validatePolicy(report.policy)
  const keys = new Set()
  let hasOcrProvenance = false
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
    const optionalAuditedKeys = [
      'exports',
      ...(['1.6.0', '1.7.0', '1.8.0', '1.9.0', '1.10.0'].includes(
        report.schemaVersion,
      )
        ? ['ocr']
        : []),
    ]
    if (
      !hasOnlyAndRequiredKeys(
        document,
        [...auditedKeys, ...optionalAuditedKeys],
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
    if (Object.hasOwn(document, 'ocr')) {
      validateOcrProvenance(document.ocr)
      hasOcrProvenance = true
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
    validateCompleteness(document.completeness)
    validateReadiness(
      document.readiness,
      document.completeness,
      document.diagnostics,
      document.diagnosticCounts,
    )
    if (
      canonicalJson(document.readiness.policy) !== canonicalJson(report.policy)
    ) {
      invalidReport()
    }
    validateStructure(
      document.structure,
      ['1.5.0', '1.6.0', '1.7.0'].includes(report.schemaVersion),
    )
    if (
      report.schemaVersion === '1.8.0' &&
      document.structure.schemaVersion !== '1.5.0'
    ) {
      invalidReport()
    }
    if (
      report.schemaVersion === '1.9.0' &&
      document.structure.schemaVersion !== '1.6.0'
    ) {
      invalidReport()
    }
    if (
      report.schemaVersion === '1.10.0' &&
      document.structure.schemaVersion !== '1.7.0'
    ) {
      invalidReport()
    }
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
  if (report.schemaVersion === '1.6.0' && !hasOcrProvenance) {
    invalidReport()
  }
  if (Object.hasOwn(report, 'corpusContract')) {
    validateCorpusContractDocuments(report.corpusContract, report.documents)
  }
  validateSummary(report.summary, report.documents)
}

function validateTolerances(tolerances, metrics) {
  if (!isRecord(tolerances)) throw new Error('INVALID_TOLERANCE')
  for (const [key, value] of Object.entries(tolerances)) {
    const metric = metrics.find((candidate) => candidate.key === key)
    if (
      !metric ||
      metric.direction === 'exact' ||
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
        change: NON_DIRECTIONAL_DIAGNOSTIC_CODES.has(code)
          ? 'unchanged'
          : delta > 0
            ? 'regressed'
            : 'improved',
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
  const output = {
    schemaVersion: structure.schemaVersion,
    canonicalNodeCount: structure.canonicalNodeCount,
    canonicalNodeSequenceSha256: structure.canonicalNodeSequenceSha256,
    canonicalNodeTypeSequenceSha256: structure.canonicalNodeTypeSequenceSha256,
    canonicalContentSha256: structure.canonicalContentSha256,
    canonicalNodeProvenanceSha256: structure.canonicalNodeProvenanceSha256,
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
    crossReferenceRelationshipCount: structure.crossReferenceRelationshipCount,
    crossReferenceRelationshipCounts: countMap(
      structure.crossReferenceRelationshipCounts,
    ),
    crossReferenceRelationshipGraph: structure.crossReferenceRelationshipGraph,
    crossReferenceRelationshipGraphSha256:
      structure.crossReferenceRelationshipGraphSha256,
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
  return structure.schemaVersion === '1.5.0'
    ? {
        ...output,
        canonicalHyphenDeletionLedgerAvailable:
          structure.canonicalHyphenDeletionLedgerAvailable,
        canonicalHyphenDeletionCount: structure.canonicalHyphenDeletionCount,
        canonicalHyphenDeletionContextCounts: countMap(
          structure.canonicalHyphenDeletionContextCounts,
        ),
        canonicalHyphenDeletionLedger: structure.canonicalHyphenDeletionLedger,
        canonicalHyphenDeletionLedgerSha256:
          structure.canonicalHyphenDeletionLedgerSha256,
      }
    : output
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
  const canonicalHyphenDeletionLedger = {
    baseline: canonicalHyphenDeletionLedgerCheck(baselineReceipt),
    candidate: canonicalHyphenDeletionLedgerCheck(candidateReceipt),
  }
  return {
    baseline: structuralReceiptOutput(baselineReceipt),
    candidate: structuralReceiptOutput(candidateReceipt),
    available,
    identical,
    ledger,
    canonicalHyphenDeletionLedger,
    nondeterministic:
      requireIdenticalStructure &&
      (!available ||
        !identical ||
        !ledger.baseline.valid ||
        !ledger.candidate.valid ||
        !canonicalHyphenDeletionLedger.baseline.valid ||
        !canonicalHyphenDeletionLedger.candidate.valid),
  }
}

function canonicalHyphenDeletionLedgerCheck(structure) {
  const available = structure?.canonicalHyphenDeletionLedgerAvailable === true
  return {
    available,
    valid:
      structure?.schemaVersion === '1.4.0'
        ? true
        : available && validCanonicalHyphenDeletionLedger(structure),
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
    corpusReportSchemaPolicy = CORPUS_REPORT_SCHEMA_POLICY_V15,
    requireIdenticalArtifacts = false,
    requireIdenticalStructure = false,
    tolerances = {},
  } = {},
) {
  const validatedCorpusReportSchemaPolicy = validateCorpusReportSchemaPolicy(
    corpusReportSchemaPolicy,
  )
  validateReport(baseline, validatedCorpusReportSchemaPolicy)
  validateReport(candidate, validatedCorpusReportSchemaPolicy)
  const comparisonMetrics = comparisonMetricsForSchemaPolicy(
    validatedCorpusReportSchemaPolicy,
  )
  const baselineCorpusContract = baseline.corpusContract ?? null
  const candidateCorpusContract = candidate.corpusContract ?? null
  if (
    (baselineCorpusContract === null) !== (candidateCorpusContract === null) ||
    (baselineCorpusContract !== null &&
      canonicalJson(baselineCorpusContract) !==
        canonicalJson(candidateCorpusContract))
  ) {
    throw new Error('PDF_CORPUS_CONTRACT_BINDING_MISMATCH')
  }
  const validatedTolerances = validateTolerances(tolerances, comparisonMetrics)
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
    const metrics = comparisonMetrics.map((metric) => {
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
  const provenanceSchemaPolicy = [
    CORPUS_REPORT_SCHEMA_POLICY_V17,
    CORPUS_REPORT_SCHEMA_POLICY_V18,
    CORPUS_REPORT_SCHEMA_POLICY_V19,
    CORPUS_REPORT_SCHEMA_POLICY_V110,
  ].includes(validatedCorpusReportSchemaPolicy)
  const exactHeadEvidencePassed =
    !provenanceSchemaPolicy ||
    (baseline.executionProvenance.implementation.exactHead === true &&
      candidate.executionProvenance.implementation.exactHead === true)
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
    ...(provenanceSchemaPolicy ? { exactHeadEvidencePassed } : {}),
    passed:
      exactHeadEvidencePassed &&
      auditPolicy.identical &&
      failedEpubChecks === 0 &&
      addedDocuments.every((document) => document.passed) &&
      documents.every((document) => document.verdict !== 'regressed'),
  }
  return {
    schemaVersion:
      validatedCorpusReportSchemaPolicy === CORPUS_REPORT_SCHEMA_POLICY_V15_V16
        ? PDF_BENCHMARK_COMPARISON_OCR_SCHEMA_VERSION
        : validatedCorpusReportSchemaPolicy === CORPUS_REPORT_SCHEMA_POLICY_V110
          ? PDF_BENCHMARK_COMPARISON_V110_SCHEMA_VERSION
          : validatedCorpusReportSchemaPolicy ===
              CORPUS_REPORT_SCHEMA_POLICY_V19
            ? PDF_BENCHMARK_COMPARISON_V19_SCHEMA_VERSION
            : validatedCorpusReportSchemaPolicy ===
                CORPUS_REPORT_SCHEMA_POLICY_V18
              ? PDF_BENCHMARK_COMPARISON_V18_SCHEMA_VERSION
              : validatedCorpusReportSchemaPolicy ===
                  CORPUS_REPORT_SCHEMA_POLICY_V17
                ? PDF_BENCHMARK_COMPARISON_PROVENANCE_SCHEMA_VERSION
                : PDF_BENCHMARK_COMPARISON_SCHEMA_VERSION,
    privacy: 'basenames-hashes-metrics-artifact-invariants-only',
    ...(baselineCorpusContract
      ? { corpusContract: baselineCorpusContract }
      : {}),
    policy: {
      metrics: comparisonMetrics.map((metric) => ({ ...metric })),
      tolerances: validatedTolerances,
      auditPolicy,
      ...(validatedCorpusReportSchemaPolicy ===
        CORPUS_REPORT_SCHEMA_POLICY_V15_V16 || provenanceSchemaPolicy
        ? {
            corpusReportSchemaCompatibility: {
              policy: validatedCorpusReportSchemaPolicy,
              baseline: {
                schemaVersion: baseline.schemaVersion,
                reportSchema: baseline.reportSchema,
                ...(provenanceSchemaPolicy
                  ? {
                      reportSha256: canonicalJsonHash(baseline),
                      executionProvenance: baseline.executionProvenance,
                    }
                  : {}),
              },
              candidate: {
                schemaVersion: candidate.schemaVersion,
                reportSchema: candidate.reportSchema,
                ...(provenanceSchemaPolicy
                  ? {
                      reportSha256: canonicalJsonHash(candidate),
                      executionProvenance: candidate.executionProvenance,
                    }
                  : {}),
              },
            },
          }
        : {}),
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
  return 'Usage: node tools/pdf-benchmark-compare.mjs <baseline-corpus-audit.json> <candidate-corpus-audit.json> [--out <comparison.json>] [--tolerance <metric>=<value>]... [--corpus-report-schema-policy <v1.5-only|v1.5-v1.6-compatible|v1.7-only|v1.8-only|v1.9-only|v1.10-only>] [--require-identical-artifacts] [--require-identical-structure]\n'
}

function parseArguments(arguments_) {
  const inputs = []
  const tolerances = {}
  let output
  let corpusReportSchemaPolicy = CORPUS_REPORT_SCHEMA_POLICY_V15
  let corpusReportSchemaPolicySet = false
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
        !V18_METRICS.some((metric) => metric.key === key) ||
        !Number.isFinite(value) ||
        value < 0
      ) {
        throw new Error('INVALID_TOLERANCE')
      }
      tolerances[key] = value
    } else if (argument === '--corpus-report-schema-policy') {
      if (corpusReportSchemaPolicySet) throw new Error('INVALID_USAGE')
      corpusReportSchemaPolicy = validateCorpusReportSchemaPolicy(
        arguments_[++index],
      )
      corpusReportSchemaPolicySet = true
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
  validateTolerances(
    tolerances,
    comparisonMetricsForSchemaPolicy(corpusReportSchemaPolicy),
  )
  return {
    inputs,
    output,
    tolerances,
    corpusReportSchemaPolicy,
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

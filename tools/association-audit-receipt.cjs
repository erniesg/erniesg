const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')

const FIXTURE = 'tests/fixtures/pdf/note-citation-associations.pdf'
const BASELINE_REF = '769d19836560d43cb67a4b4d7ca11bceb0a4121a'
const CHECKPOINT_IDS = [
  'associations-page-1-marker-to-body',
  'associations-page-2-citation-to-entry',
  'associations-page-2-caption-citation',
  'associations-page-2-table-cell-note',
  'associations-page-2-dangling-link-verifier',
]
const ASSOCIATIONS = [
  ['numeric-footnote', 'note', 'matched'],
  ['symbol-footnote', 'note', 'matched'],
  ['arabic-indic-footnote', 'note', 'matched'],
  ['nested-label-6-footnote', 'note', 'matched'],
  ['numeric-citation-range', 'citation', 'matched'],
  ['author-year-citation', 'citation', 'matched'],
  ['cross-page-endnote', 'note', 'matched'],
  ['caption-citation', 'citation', 'matched'],
  ['table-cell-note', 'note', 'matched'],
  ['ambiguous-duplicate-note', 'note', 'ambiguous'],
]

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

function roundRate(value) {
  return Number(value.toFixed(5))
}

function validCounters(value, expected) {
  const countKeys = [
    'expectedAssociations',
    'matchedAssociations',
    'ambiguousAssociations',
    'unresolvedAssociations',
    'falseLinkCount',
  ]
  const keys = [
    ...countKeys,
    'resolvedAssociationRate',
    'verifiedAssociationRate',
  ]
  if (!exactKeys(value, keys)) return false
  if (
    countKeys.some((key) => !Number.isInteger(value[key]) || value[key] < 0)
  ) {
    return false
  }
  if (
    value.matchedAssociations +
      value.ambiguousAssociations +
      value.unresolvedAssociations +
      value.falseLinkCount !==
    value.expectedAssociations
  ) {
    return false
  }
  if (
    value.resolvedAssociationRate !==
      roundRate(value.matchedAssociations / value.expectedAssociations) ||
    value.verifiedAssociationRate !==
      roundRate(
        (value.matchedAssociations + value.ambiguousAssociations) /
          value.expectedAssociations,
      )
  ) {
    return false
  }
  return keys.every((key) => value[key] === expected[key])
}

const EXPECTED_BEFORE = {
  expectedAssociations: 10,
  matchedAssociations: 5,
  ambiguousAssociations: 1,
  unresolvedAssociations: 4,
  falseLinkCount: 0,
  resolvedAssociationRate: 0.5,
  verifiedAssociationRate: 0.6,
}
const EXPECTED_AFTER = {
  expectedAssociations: 10,
  matchedAssociations: 9,
  ambiguousAssociations: 1,
  unresolvedAssociations: 0,
  falseLinkCount: 0,
  resolvedAssociationRate: 0.9,
  verifiedAssociationRate: 1,
}

function validCompleteness(value, after) {
  const keys = [
    'expectedAssociationCount',
    'resolvedAssociationCount',
    'associationCoverage',
    'expectedRelationshipCount',
    'resolvedRelationshipCount',
    'relationshipCoverage',
    'unresolvedObjects',
  ]
  if (!exactKeys(value, keys)) return false
  const unresolvedKeys = [
    'assets',
    'captions',
    'tables',
    'equations',
    'citations',
    'footnoteReferences',
    'footnotes',
  ]
  if (
    !exactKeys(value.unresolvedObjects, unresolvedKeys) ||
    unresolvedKeys.some(
      (key) =>
        !Number.isInteger(value.unresolvedObjects[key]) ||
        value.unresolvedObjects[key] < 0,
    )
  ) {
    return false
  }
  return (
    value.expectedAssociationCount === after.expectedAssociations &&
    value.resolvedAssociationCount === after.matchedAssociations &&
    value.associationCoverage === after.resolvedAssociationRate &&
    Number.isInteger(value.expectedRelationshipCount) &&
    Number.isInteger(value.resolvedRelationshipCount) &&
    value.expectedRelationshipCount >= value.resolvedRelationshipCount &&
    value.resolvedRelationshipCount >= value.resolvedAssociationCount &&
    value.relationshipCoverage ===
      roundRate(
        value.resolvedRelationshipCount / value.expectedRelationshipCount,
      )
  )
}

function validReadiness(value) {
  if (
    !exactKeys(value, ['ready', 'status', 'blockingDiagnosticCodes']) ||
    value.ready !== false ||
    value.status !== 'review-required' ||
    !Array.isArray(value.blockingDiagnosticCodes) ||
    value.blockingDiagnosticCodes.length === 0 ||
    value.blockingDiagnosticCodes.length > 50
  ) {
    return false
  }
  return (
    new Set(value.blockingDiagnosticCodes).size ===
      value.blockingDiagnosticCodes.length &&
    value.blockingDiagnosticCodes.every((code) =>
      /^[A-Z][A-Z0-9_]{0,127}$/u.test(code),
    )
  )
}

function validAssociationAudit(value) {
  const receiptKeys = [
    'schemaVersion',
    'status',
    'fixture',
    'fixtureSha256',
    'baselineRef',
    'before',
    'after',
    'checkpoints',
    'associations',
    'diagnosticCounts',
    'completeness',
    'readiness',
  ]
  if (
    !exactKeys(value, receiptKeys) ||
    value.schemaVersion !== '1.0.0' ||
    value.status !== 'passed' ||
    value.fixture !== FIXTURE ||
    value.baselineRef !== BASELINE_REF ||
    !/^[a-f0-9]{64}$/u.test(value.fixtureSha256 || '')
  ) {
    return false
  }
  let fixtureSha256
  try {
    fixtureSha256 = createHash('sha256')
      .update(readFileSync(FIXTURE))
      .digest('hex')
  } catch (_error) {
    return false
  }
  if (value.fixtureSha256 !== fixtureSha256) return false
  if (
    !validCounters(value.before, EXPECTED_BEFORE) ||
    !validCounters(value.after, EXPECTED_AFTER)
  ) {
    return false
  }
  if (
    !Array.isArray(value.checkpoints) ||
    value.checkpoints.length !== CHECKPOINT_IDS.length ||
    !value.checkpoints.every(
      (checkpoint, index) =>
        exactKeys(checkpoint, ['checkpointId', 'status']) &&
        checkpoint.checkpointId === CHECKPOINT_IDS[index] &&
        checkpoint.status === 'passed',
    )
  ) {
    return false
  }
  if (
    !Array.isArray(value.associations) ||
    value.associations.length !== ASSOCIATIONS.length ||
    !value.associations.every((association, index) => {
      const [id, kind, expectedStatus] = ASSOCIATIONS[index]
      return (
        exactKeys(association, [
          'id',
          'kind',
          'expectedStatus',
          'observedStatus',
          'outcome',
          'reason',
        ]) &&
        association.id === id &&
        association.kind === kind &&
        association.expectedStatus === expectedStatus &&
        association.observedStatus === expectedStatus &&
        association.outcome === expectedStatus &&
        association.reason ===
          (expectedStatus === 'matched'
            ? 'verified-target-and-owner'
            : 'source-ambiguity-retained')
      )
    })
  ) {
    return false
  }
  if (
    !isRecord(value.diagnosticCounts) ||
    Object.keys(value.diagnosticCounts).length > 200 ||
    Object.entries(value.diagnosticCounts).some(
      ([code, count]) =>
        !/^[A-Z][A-Z0-9_]{0,127}$/u.test(code) ||
        !Number.isInteger(count) ||
        count < 0,
    )
  ) {
    return false
  }
  return (
    validCompleteness(value.completeness, value.after) &&
    validReadiness(value.readiness)
  )
}

module.exports = { validAssociationAudit }

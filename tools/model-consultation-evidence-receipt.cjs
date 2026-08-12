const HASH = /^[a-f0-9]{64}$/u
const DECISION_CLASSES = new Set([
  'candidate-ambiguous-caption-association',
  'ambiguous-note-marker-match',
  'reading-order-tie',
])
const RECORD_KEYS = [
  'documentIdSha256',
  'decisionClass',
  'decisionCount',
  'consultationCount',
  'consultationRate',
  'providerCallCount',
  'retired',
]
const EXPECTED_RECORDS = [
  {
    documentIdSha256:
      '1e92f266d26de96f009bc28e0ee1b269d22624b19422e69f2384655a41d9bd66',
    decisionClass: 'candidate-ambiguous-caption-association',
    decisionCount: 1,
    consultationCount: 1,
    consultationRate: 1,
    providerCallCount: 1,
    retired: false,
  },
  {
    documentIdSha256:
      '1e92f266d26de96f009bc28e0ee1b269d22624b19422e69f2384655a41d9bd66',
    decisionClass: 'candidate-ambiguous-caption-association',
    decisionCount: 1,
    consultationCount: 0,
    consultationRate: 0,
    providerCallCount: 0,
    retired: true,
  },
  {
    documentIdSha256:
      '5388133662ab0137d2ad08d6b9ad8ea75a3a4b8ee1720691fa57d44b46361133',
    decisionClass: 'ambiguous-note-marker-match',
    decisionCount: 2,
    consultationCount: 2,
    consultationRate: 1,
    providerCallCount: 2,
    retired: false,
  },
  {
    documentIdSha256:
      '5388133662ab0137d2ad08d6b9ad8ea75a3a4b8ee1720691fa57d44b46361133',
    decisionClass: 'reading-order-tie',
    decisionCount: 1,
    consultationCount: 1,
    consultationRate: 1,
    providerCallCount: 1,
    retired: false,
  },
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

function validRecord(value) {
  if (
    !exactKeys(value, RECORD_KEYS) ||
    !HASH.test(value.documentIdSha256) ||
    !DECISION_CLASSES.has(value.decisionClass) ||
    !Number.isInteger(value.decisionCount) ||
    value.decisionCount < 1 ||
    !Number.isInteger(value.consultationCount) ||
    value.consultationCount < 0 ||
    value.consultationCount > value.decisionCount ||
    !Number.isInteger(value.providerCallCount) ||
    value.providerCallCount < 0 ||
    value.providerCallCount !== value.consultationCount ||
    typeof value.consultationRate !== 'number' ||
    !Number.isFinite(value.consultationRate) ||
    value.consultationRate !== value.consultationCount / value.decisionCount ||
    typeof value.retired !== 'boolean'
  ) {
    return false
  }
  return (
    !value.retired ||
    (value.decisionClass === 'candidate-ambiguous-caption-association' &&
      value.consultationCount === 0 &&
      value.providerCallCount === 0)
  )
}

function validModelConsultationEvidence(value) {
  if (
    !exactKeys(value, ['records']) ||
    !Array.isArray(value.records) ||
    value.records.length !== EXPECTED_RECORDS.length ||
    !value.records.every(validRecord)
  ) {
    return false
  }
  return value.records.every((record, index) =>
    RECORD_KEYS.every((key) => record[key] === EXPECTED_RECORDS[index][key]),
  )
}

module.exports = { validModelConsultationEvidence }

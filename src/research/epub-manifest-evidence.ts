import { strToU8 } from 'fflate'
import {
  PdfImportError,
  type HumanAdjudicationRecord,
  type PdfReconstruction,
} from './import-types'
import {
  PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE,
  PDF_HYPHEN_LEXICAL_MODEL,
  PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE,
  PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE,
  PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE,
} from './pdf-hyphenation'
import {
  hasValidCanonicalHyphenBoundaryLedger,
  hasValidSourceSemanticFlowBoundaryLedgerCount,
} from './pdf-quality'

export const EPUB_EXPORT_LEGACY_SCHEMA_VERSION = '1.1.0' as const
export const EPUB_EXPORT_SCHEMA_VERSION = '1.2.0' as const

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${canonicalJson(entryValue)}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotateRight(value: number, count: number) {
  return (value >>> count) | (value << (32 - count))
}

export function sha256Sync(bytes: Uint8Array) {
  const bitLength = bytes.byteLength * 8
  const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.byteLength] = 0x80
  const paddedView = new DataView(padded.buffer)
  paddedView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000))
  paddedView.setUint32(paddedLength - 4, bitLength >>> 0)

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ])
  const words = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = paddedView.getUint32(offset + index * 4)
    }
    for (let index = 16; index < 64; index += 1) {
      const before15 = words[index - 15]
      const before2 = words[index - 2]
      const sigma0 =
        rotateRight(before15, 7) ^ rotateRight(before15, 18) ^ (before15 >>> 3)
      const sigma1 =
        rotateRight(before2, 17) ^ rotateRight(before2, 19) ^ (before2 >>> 10)
      words[index] =
        (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = state
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temporary1 =
        (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temporary2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temporary1) >>> 0
      d = c
      c = b
      b = a
      a = (temporary1 + temporary2) >>> 0
    }
    state[0] = (state[0] + a) >>> 0
    state[1] = (state[1] + b) >>> 0
    state[2] = (state[2] + c) >>> 0
    state[3] = (state[3] + d) >>> 0
    state[4] = (state[4] + e) >>> 0
    state[5] = (state[5] + f) >>> 0
    state[6] = (state[6] + g) >>> 0
    state[7] = (state[7] + h) >>> 0
  }
  return [...state].map((word) => word.toString(16).padStart(8, '0')).join('')
}

export function canonicalJsonSha256(value: unknown) {
  return sha256Sync(strToU8(canonicalJson(value)))
}

function opaqueCanonicalHyphenValue(kind: string, value: string) {
  return sha256Sync(strToU8(`${kind}\0${value}`))
}

const PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE_SHA256S =
  PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE.map((evidence) =>
    opaqueCanonicalHyphenValue('canonical-hyphen-evidence', evidence),
  )
const PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE_SHA256S =
  PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE.map((evidence) =>
    opaqueCanonicalHyphenValue('canonical-hyphen-evidence', evidence),
  )
const PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE_SHA256S =
  PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE.map((evidence) =>
    opaqueCanonicalHyphenValue('canonical-hyphen-evidence', evidence),
  )

function canonicalHyphenDeletionContextCounts(
  records: readonly { context: string }[],
) {
  const counts = new Map<string, number>()
  for (const record of records) {
    counts.set(record.context, (counts.get(record.context) ?? 0) + 1)
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function canonicalHyphenDeletionManifestReceipt(
  reconstruction: PdfReconstruction,
) {
  if (
    !hasValidCanonicalHyphenBoundaryLedger({
      decisions: reconstruction.canonicalHyphenBoundaryDecisions,
      expectedCount: reconstruction.canonicalHyphenBoundaryDecisionCount,
      regions: reconstruction.regions,
    })
  ) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      'EPUB export requires a complete canonical hyphen deletion ledger and count.',
    )
  }
  const records = reconstruction.canonicalHyphenBoundaryDecisions
    .map((decision) => {
      const left = decision.proof.pinnedSplit.left
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
      const right = decision.proof.pinnedSplit.right
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
      const joined = `${left}${right}`
      const hardHyphen = `${left}-${right}`
      return {
        id: opaqueCanonicalHyphenValue(
          'canonical-hyphen-decision',
          decision.id,
        ),
        context: decision.context,
        outcome: decision.outcome,
        fromRegionId: opaqueCanonicalHyphenValue(
          'region',
          decision.fromRegionId,
        ),
        fromLineId: opaqueCanonicalHyphenValue('line', decision.fromLineId),
        toRegionId: opaqueCanonicalHyphenValue('region', decision.toRegionId),
        toLineId: opaqueCanonicalHyphenValue('line', decision.toLineId),
        geometry: {
          from: { ...decision.geometry.from },
          to: { ...decision.geometry.to },
        },
        proof: {
          ...(decision.proof.tier === 'exact-same-document'
            ? {
                tier: 'exact-same-document' as const,
                sourceBoundaryProven: true as const,
                pinnedWordSha256: canonicalJsonSha256(joined),
                pinnedJoinedFormValid: true as const,
                pinnedSplit: {
                  leftSha256: canonicalJsonSha256(left),
                  rightSha256: canonicalJsonSha256(right),
                  index: decision.proof.pinnedSplit.index,
                },
                splitPointValid: true as const,
                exactSameDocumentJoinedFormSha256: canonicalJsonSha256(joined),
                sameDocumentJoinedFormValid: true as const,
              }
            : (() => {
                const derivedWordSha256 = canonicalJsonSha256(joined)
                const baseWord = decision.proof.baseWord
                  .normalize('NFKC')
                  .toLocaleLowerCase('en-US')
                const baseWordSha256 = canonicalJsonSha256(baseWord)
                const productivePrefix = {
                  ...PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE,
                }
                return {
                  tier: 'same-document-derived-affix' as const,
                  sourceBoundaryProven: true as const,
                  derivedWordSha256,
                  productivePrefix,
                  baseWordSha256,
                  derivationBindingSha256: canonicalJsonSha256({
                    derivedWordSha256,
                    productivePrefix,
                    baseWordSha256,
                  }),
                  pinnedBaseWordValid: true as const,
                  pinnedSplit: {
                    leftSha256: canonicalJsonSha256(left),
                    rightSha256: canonicalJsonSha256(right),
                    index: decision.proof.pinnedSplit.index,
                  },
                  splitPointValid: true as const,
                  exactSameDocumentBaseWordSha256: baseWordSha256,
                  sameDocumentBaseWordValid: true as const,
                }
              })()),
          hardHyphenFormSha256: canonicalJsonSha256(hardHyphen),
          hardHyphenCounterproof: null,
          model: { ...decision.proof.model },
          evidenceSha256s: [
            ...new Set(
              decision.proof.evidence.map((evidence) =>
                opaqueCanonicalHyphenValue(
                  'canonical-hyphen-evidence',
                  evidence,
                ),
              ),
            ),
          ].sort(),
        },
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id))
  return {
    canonicalHyphenDeletionCount: records.length,
    canonicalHyphenDeletionContextCounts:
      canonicalHyphenDeletionContextCounts(records),
    canonicalHyphenDeletionLedger: records,
    canonicalHyphenDeletionLedgerSha256: canonicalJsonSha256(records),
  }
}

export function sourceSemanticFlowBoundaryManifestReceipt(
  reconstruction: PdfReconstruction,
) {
  if (
    !hasValidSourceSemanticFlowBoundaryLedgerCount({
      decisions: reconstruction.sourceSemanticFlowBoundaryDecisions,
      expectedCount: reconstruction.sourceSemanticFlowBoundaryDecisionCount,
    })
  ) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      'EPUB export requires a complete source semantic-flow boundary ledger and count.',
    )
  }
  const endpoint = (
    value: PdfReconstruction['sourceSemanticFlowBoundaryDecisions'][number]['from'],
  ) => ({
    regionId: opaqueCanonicalHyphenValue('region', value.regionId),
    lineId: opaqueCanonicalHyphenValue('line', value.lineId),
    runIndex: value.runIndex,
    sourceSequenceIndex: value.sourceSequenceIndex,
    sourceRunSha256: value.sourceRunSha256,
    sourceFragmentId: opaqueCanonicalHyphenValue(
      'source-fragment',
      value.sourceFragmentId,
    ),
  })
  const records = reconstruction.sourceSemanticFlowBoundaryDecisions
    .map((decision) => ({
      id: decision.id,
      page: decision.page,
      rotation: decision.rotation,
      method: decision.method,
      topology: decision.topology,
      outcome: decision.outcome,
      from: endpoint(decision.from),
      to: endpoint(decision.to),
      evidenceSha256s: decision.evidence
        .map((evidence) =>
          opaqueCanonicalHyphenValue('semantic-flow-evidence', evidence),
        )
        .sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return {
    sourceSemanticFlowBoundaryCount: records.length,
    sourceSemanticFlowBoundaryLedger: records,
    sourceSemanticFlowBoundaryLedgerSha256: canonicalJsonSha256(records),
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function exactObjectKeys(value: unknown, expected: readonly string[]) {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function isCanonicalHyphenSourceBox(value: unknown) {
  return (
    isRecord(value) &&
    exactObjectKeys(value, [
      'page',
      'x',
      'y',
      'width',
      'height',
      'rotation',
      'method',
    ]) &&
    Number.isSafeInteger(value.page) &&
    (value.page as number) >= 1 &&
    ['x', 'y', 'width', 'height', 'rotation'].every(
      (field) =>
        typeof value[field] === 'number' && Number.isFinite(value[field]),
    ) &&
    (value.width as number) >= 0 &&
    (value.height as number) >= 0 &&
    ['pdf-text', 'pdf-object', 'pdf-link', 'ocr'].includes(
      value.method as string,
    )
  )
}

function isSortedUniqueSha256Array(value: unknown, nonempty = false) {
  return (
    Array.isArray(value) &&
    (!nonempty || value.length > 0) &&
    value.every(isSha256) &&
    value.every(
      (entry, index) =>
        index === 0 || value[index - 1].localeCompare(entry) < 0,
    )
  )
}

function isLegacyCanonicalHyphenDeletionManifestRecord(value: unknown) {
  if (
    !isRecord(value) ||
    !exactObjectKeys(value, [
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
    ![
      value.id,
      value.fromRegionId,
      value.fromLineId,
      value.toRegionId,
      value.toLineId,
    ].every(isSha256) ||
    !['bibliography-continuation', 'canonical-flow-continuation'].includes(
      value.context as string,
    ) ||
    value.outcome !== 'removed-discretionary-hyphen' ||
    !isRecord(value.geometry) ||
    !exactObjectKeys(value.geometry, ['from', 'to']) ||
    !isCanonicalHyphenSourceBox(value.geometry.from) ||
    !isCanonicalHyphenSourceBox(value.geometry.to) ||
    !isRecord(value.proof) ||
    !exactObjectKeys(value.proof, [
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
    ]) ||
    value.proof.sourceBoundaryProven !== true ||
    !isSha256(value.proof.pinnedWordSha256) ||
    value.proof.pinnedJoinedFormValid !== true ||
    !isRecord(value.proof.pinnedSplit) ||
    !exactObjectKeys(value.proof.pinnedSplit, [
      'leftSha256',
      'rightSha256',
      'index',
    ]) ||
    !isSha256(value.proof.pinnedSplit.leftSha256) ||
    !isSha256(value.proof.pinnedSplit.rightSha256) ||
    !Number.isSafeInteger(value.proof.pinnedSplit.index) ||
    (value.proof.pinnedSplit.index as number) < 1 ||
    value.proof.splitPointValid !== true ||
    !isSha256(value.proof.exactSameDocumentJoinedFormSha256) ||
    value.proof.exactSameDocumentJoinedFormSha256 !==
      value.proof.pinnedWordSha256 ||
    value.proof.sameDocumentJoinedFormValid !== true ||
    !isSha256(value.proof.hardHyphenFormSha256) ||
    value.proof.hardHyphenFormSha256 === value.proof.pinnedWordSha256 ||
    value.proof.hardHyphenCounterproof !== null ||
    !isRecord(value.proof.model) ||
    canonicalJson(value.proof.model) !==
      canonicalJson(PDF_HYPHEN_LEXICAL_MODEL) ||
    !isSortedUniqueSha256Array(value.proof.evidenceSha256s, true)
  ) {
    return false
  }
  const evidenceSha256s = value.proof.evidenceSha256s as string[]
  return (
    PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE_SHA256S.every((evidenceSha256) =>
      evidenceSha256s.includes(evidenceSha256),
    ) &&
    PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE_SHA256S.every(
      (evidenceSha256) => !evidenceSha256s.includes(evidenceSha256),
    )
  )
}

function isCanonicalHyphenDeletionManifestRecord(value: unknown) {
  if (
    !isRecord(value) ||
    !exactObjectKeys(value, [
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
    ![
      value.id,
      value.fromRegionId,
      value.fromLineId,
      value.toRegionId,
      value.toLineId,
    ].every(isSha256) ||
    !['bibliography-continuation', 'canonical-flow-continuation'].includes(
      value.context as string,
    ) ||
    value.outcome !== 'removed-discretionary-hyphen' ||
    !isRecord(value.geometry) ||
    !exactObjectKeys(value.geometry, ['from', 'to']) ||
    !isCanonicalHyphenSourceBox(value.geometry.from) ||
    !isCanonicalHyphenSourceBox(value.geometry.to) ||
    !isRecord(value.proof) ||
    value.proof.sourceBoundaryProven !== true ||
    !isRecord(value.proof.pinnedSplit) ||
    !exactObjectKeys(value.proof.pinnedSplit, [
      'leftSha256',
      'rightSha256',
      'index',
    ]) ||
    !isSha256(value.proof.pinnedSplit.leftSha256) ||
    !isSha256(value.proof.pinnedSplit.rightSha256) ||
    !Number.isSafeInteger(value.proof.pinnedSplit.index) ||
    (value.proof.pinnedSplit.index as number) < 1 ||
    value.proof.splitPointValid !== true ||
    !isSha256(value.proof.hardHyphenFormSha256) ||
    value.proof.hardHyphenCounterproof !== null ||
    !isRecord(value.proof.model) ||
    canonicalJson(value.proof.model) !==
      canonicalJson(PDF_HYPHEN_LEXICAL_MODEL) ||
    !isSortedUniqueSha256Array(value.proof.evidenceSha256s, true)
  ) {
    return false
  }
  const evidenceSha256s = value.proof.evidenceSha256s as string[]
  const noForbiddenEvidence =
    PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE_SHA256S.every(
      (evidenceSha256) => !evidenceSha256s.includes(evidenceSha256),
    )
  if (!noForbiddenEvidence) return false
  if (value.proof.tier === 'exact-same-document') {
    return (
      exactObjectKeys(value.proof, [
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
      isSha256(value.proof.pinnedWordSha256) &&
      value.proof.pinnedJoinedFormValid === true &&
      isSha256(value.proof.exactSameDocumentJoinedFormSha256) &&
      value.proof.exactSameDocumentJoinedFormSha256 ===
        value.proof.pinnedWordSha256 &&
      value.proof.sameDocumentJoinedFormValid === true &&
      value.proof.hardHyphenFormSha256 !== value.proof.pinnedWordSha256 &&
      PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE_SHA256S.every((evidenceSha256) =>
        evidenceSha256s.includes(evidenceSha256),
      )
    )
  }
  if (value.proof.tier !== 'same-document-derived-affix') return false
  if (
    !exactObjectKeys(value.proof, [
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
    ]) ||
    !isSha256(value.proof.derivedWordSha256) ||
    !isRecord(value.proof.productivePrefix) ||
    canonicalJson(value.proof.productivePrefix) !==
      canonicalJson(PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE) ||
    !isSha256(value.proof.baseWordSha256) ||
    !isSha256(value.proof.derivationBindingSha256) ||
    value.proof.derivationBindingSha256 !==
      canonicalJsonSha256({
        derivedWordSha256: value.proof.derivedWordSha256,
        productivePrefix: value.proof.productivePrefix,
        baseWordSha256: value.proof.baseWordSha256,
      }) ||
    value.proof.pinnedBaseWordValid !== true ||
    !isSha256(value.proof.exactSameDocumentBaseWordSha256) ||
    value.proof.exactSameDocumentBaseWordSha256 !==
      value.proof.baseWordSha256 ||
    value.proof.sameDocumentBaseWordValid !== true ||
    value.proof.derivedWordSha256 === value.proof.baseWordSha256 ||
    value.proof.hardHyphenFormSha256 === value.proof.derivedWordSha256 ||
    (value.proof.pinnedSplit.index as number) <=
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.value.length
  ) {
    return false
  }
  return PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE_SHA256S.every(
    (evidenceSha256) => evidenceSha256s.includes(evidenceSha256),
  )
}

export function validateCanonicalHyphenDeletionManifestReceipt(
  parsed: Record<string, unknown>,
) {
  const fields = [
    'canonicalHyphenDeletionCount',
    'canonicalHyphenDeletionContextCounts',
    'canonicalHyphenDeletionLedger',
    'canonicalHyphenDeletionLedgerSha256',
  ] as const
  const present = fields.filter((field) => Object.hasOwn(parsed, field))
  if (parsed.sourceFormat !== 'pdf') {
    if (present.length > 0) {
      throw new Error(
        'EPUB export manifest canonical hyphen deletion receipt is only valid for PDF sources',
      )
    }
    return
  }
  if (present.length !== fields.length) {
    throw new Error(
      'EPUB PDF export manifest is missing its canonical hyphen deletion receipt',
    )
  }
  const records = parsed.canonicalHyphenDeletionLedger
  if (
    !Number.isSafeInteger(parsed.canonicalHyphenDeletionCount) ||
    (parsed.canonicalHyphenDeletionCount as number) < 0 ||
    !Array.isArray(records) ||
    records.length !== parsed.canonicalHyphenDeletionCount ||
    !records.every(
      parsed.schemaVersion === EPUB_EXPORT_LEGACY_SCHEMA_VERSION
        ? isLegacyCanonicalHyphenDeletionManifestRecord
        : isCanonicalHyphenDeletionManifestRecord,
    )
  ) {
    throw new Error(
      'EPUB export manifest canonical hyphen deletion ledger is invalid',
    )
  }
  const recordValues = records as Array<
    Record<string, unknown> & {
      id: string
      context: string
      fromRegionId: string
      fromLineId: string
      toRegionId: string
      toLineId: string
    }
  >
  if (
    recordValues.some(
      (record, index) =>
        index > 0 && recordValues[index - 1].id.localeCompare(record.id) >= 0,
    ) ||
    new Set(recordValues.map((record) => record.id)).size !== records.length ||
    new Set(
      recordValues.map((record) =>
        [
          record.fromRegionId,
          record.fromLineId,
          record.toRegionId,
          record.toLineId,
        ].join('\0'),
      ),
    ).size !== records.length ||
    !isRecord(parsed.canonicalHyphenDeletionContextCounts) ||
    !exactObjectKeys(
      parsed.canonicalHyphenDeletionContextCounts,
      Object.keys(canonicalHyphenDeletionContextCounts(recordValues)),
    ) ||
    canonicalJson(parsed.canonicalHyphenDeletionContextCounts) !==
      canonicalJson(canonicalHyphenDeletionContextCounts(recordValues)) ||
    !isSha256(parsed.canonicalHyphenDeletionLedgerSha256) ||
    parsed.canonicalHyphenDeletionLedgerSha256 !== canonicalJsonSha256(records)
  ) {
    throw new Error(
      'EPUB export manifest canonical hyphen deletion receipt is inconsistent',
    )
  }
}

function isSourceSemanticFlowBoundaryManifestEndpoint(value: unknown) {
  return (
    isRecord(value) &&
    exactObjectKeys(value, [
      'regionId',
      'lineId',
      'runIndex',
      'sourceSequenceIndex',
      'sourceRunSha256',
      'sourceFragmentId',
    ]) &&
    isSha256(value.regionId) &&
    isSha256(value.lineId) &&
    Number.isSafeInteger(value.runIndex) &&
    (value.runIndex as number) >= 0 &&
    Number.isSafeInteger(value.sourceSequenceIndex) &&
    (value.sourceSequenceIndex as number) >= 0 &&
    isSha256(value.sourceRunSha256) &&
    isSha256(value.sourceFragmentId)
  )
}

function isSourceSemanticFlowBoundaryManifestRecord(value: unknown) {
  return (
    isRecord(value) &&
    exactObjectKeys(value, [
      'id',
      'page',
      'rotation',
      'method',
      'topology',
      'outcome',
      'from',
      'to',
      'evidenceSha256s',
    ]) &&
    isSha256(value.id) &&
    Number.isSafeInteger(value.page) &&
    (value.page as number) >= 1 &&
    typeof value.rotation === 'number' &&
    Number.isFinite(value.rotation) &&
    ['pdf-text', 'ocr'].includes(value.method as string) &&
    [
      'inline-stacked-fragment',
      'lexical-hyphen',
      'same-page-column',
      'cross-page-column',
    ].includes(value.topology as string) &&
    [
      'no-space',
      'space',
      'discretionary-hyphen-delete',
      'hard-hyphen-retain',
    ].includes(value.outcome as string) &&
    isSourceSemanticFlowBoundaryManifestEndpoint(value.from) &&
    isSourceSemanticFlowBoundaryManifestEndpoint(value.to) &&
    isSortedUniqueSha256Array(value.evidenceSha256s, true)
  )
}

export function validateSourceSemanticFlowBoundaryManifestReceipt(
  parsed: Record<string, unknown>,
) {
  const fields = [
    'sourceSemanticFlowBoundaryCount',
    'sourceSemanticFlowBoundaryLedger',
    'sourceSemanticFlowBoundaryLedgerSha256',
  ] as const
  const present = fields.filter((field) => Object.hasOwn(parsed, field))
  if (parsed.sourceFormat !== 'pdf') {
    if (present.length > 0) {
      throw new Error(
        'EPUB export manifest source semantic-flow receipt is only valid for PDF sources',
      )
    }
    return
  }
  if (present.length !== fields.length) {
    throw new Error(
      'EPUB PDF export manifest is missing its source semantic-flow boundary receipt',
    )
  }
  const records = parsed.sourceSemanticFlowBoundaryLedger
  if (
    !Number.isSafeInteger(parsed.sourceSemanticFlowBoundaryCount) ||
    (parsed.sourceSemanticFlowBoundaryCount as number) < 0 ||
    !Array.isArray(records) ||
    records.length !== parsed.sourceSemanticFlowBoundaryCount ||
    !records.every(isSourceSemanticFlowBoundaryManifestRecord)
  ) {
    throw new Error(
      'EPUB export manifest source semantic-flow boundary ledger is invalid',
    )
  }
  const recordValues = records as Array<{
    id: string
    from: Record<string, unknown>
    to: Record<string, unknown>
  }>
  if (
    recordValues.some(
      (record, index) =>
        index > 0 && recordValues[index - 1].id.localeCompare(record.id) >= 0,
    ) ||
    new Set(recordValues.map((record) => record.id)).size !== records.length ||
    new Set(
      recordValues.map((record) => canonicalJson([record.from, record.to])),
    ).size !== records.length ||
    !isSha256(parsed.sourceSemanticFlowBoundaryLedgerSha256) ||
    parsed.sourceSemanticFlowBoundaryLedgerSha256 !==
      canonicalJsonSha256(records)
  ) {
    throw new Error(
      'EPUB export manifest source semantic-flow boundary receipt is inconsistent',
    )
  }
}

function manifestAdjudicationRecord(decision: HumanAdjudicationRecord) {
  if (decision.resolution.type !== 'accept-equation-transcript') {
    return decision
  }
  const { transcript, ...resolution } = decision.resolution
  return {
    ...decision,
    resolution: {
      ...resolution,
      transcriptSha256: sha256Sync(strToU8(transcript)),
    },
  }
}

export function manifestHumanAdjudications(reconstruction: PdfReconstruction) {
  const applied = reconstruction.humanAdjudications.applied.map(
    manifestAdjudicationRecord,
  )
  return {
    schemaVersion: reconstruction.humanAdjudications.schemaVersion,
    privacy: 'ids-choices-and-transcript-hashes-only',
    appliedCount: applied.length,
    staleCount: reconstruction.humanAdjudications.stale.length,
    countsByDiagnosticCode:
      reconstruction.humanAdjudications.countsByDiagnosticCode,
    appliedReceiptSha256: sha256Sync(strToU8(JSON.stringify(applied))),
    applied,
    noteSourceAnchorReceipts:
      reconstruction.humanAdjudications.noteSourceAnchorReceipts,
    visualDecorationReceipts:
      reconstruction.humanAdjudications.visualDecorationReceipts,
  }
}

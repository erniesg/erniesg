import type {
  NormalizedSourceBox,
  PdfCanonicalHyphenBoundaryDecision,
  PdfPageRegion,
  PdfSourceSemanticFlowBoundaryDecision,
} from './import-types'
import {
  PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE,
  PDF_HYPHEN_LEXICAL_MODEL,
  PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE,
  PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE,
  PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE,
  resolvePdfHyphenBoundary,
} from './pdf-hyphenation'
import { canonicalPdfSourceSemanticFlowEvidence } from './pdf-regions'

function exactObjectKeys(value: unknown, expected: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isPdfSourceSemanticFlowBoundaryEndpoint(value: unknown) {
  return (
    isUnknownRecord(value) &&
    exactObjectKeys(value, [
      'regionId',
      'lineId',
      'runIndex',
      'sourceSequenceIndex',
      'sourceRunSha256',
      'sourceFragmentId',
    ]) &&
    typeof value.regionId === 'string' &&
    value.regionId.length > 0 &&
    typeof value.lineId === 'string' &&
    value.lineId.length > 0 &&
    Number.isSafeInteger(value.runIndex) &&
    (value.runIndex as number) >= 0 &&
    Number.isSafeInteger(value.sourceSequenceIndex) &&
    (value.sourceSequenceIndex as number) >= 0 &&
    typeof value.sourceRunSha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.sourceRunSha256) &&
    typeof value.sourceFragmentId === 'string' &&
    value.sourceFragmentId.length > 0
  )
}

export function isPdfSourceSemanticFlowBoundaryDecision(
  value: unknown,
): value is PdfSourceSemanticFlowBoundaryDecision {
  return (
    isUnknownRecord(value) &&
    exactObjectKeys(value, [
      'id',
      'page',
      'rotation',
      'method',
      'topology',
      'outcome',
      'from',
      'to',
      'evidence',
    ]) &&
    typeof value.id === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.id) &&
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
    isPdfSourceSemanticFlowBoundaryEndpoint(value.from) &&
    isPdfSourceSemanticFlowBoundaryEndpoint(value.to) &&
    Array.isArray(value.evidence) &&
    value.evidence.length > 0 &&
    value.evidence.every(
      (entry: unknown) => typeof entry === 'string' && entry.length > 0,
    ) &&
    new Set(value.evidence).size === value.evidence.length &&
    value.evidence.every(
      (entry, index) =>
        entry ===
        canonicalPdfSourceSemanticFlowEvidence(value.evidence as string[])[
          index
        ],
    )
  )
}

function isNormalizedSourceBox(value: unknown): value is NormalizedSourceBox {
  return (
    isUnknownRecord(value) &&
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

function sameNormalizedSourceBox(left: unknown, right: NormalizedSourceBox) {
  return (
    isNormalizedSourceBox(left) &&
    exactObjectKeys(right, [
      'page',
      'x',
      'y',
      'width',
      'height',
      'rotation',
      'method',
    ]) &&
    left.page === right.page &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.rotation === right.rotation &&
    left.method === right.method
  )
}

function normalizedSourceWords(regions: readonly PdfPageRegion[]) {
  return regions.flatMap((region) =>
    region.lines.flatMap(
      (line) =>
        line.text
          .normalize('NFKC')
          .toLocaleLowerCase('en-US')
          .match(/[\p{L}\p{N}]+/gu) ?? [],
    ),
  )
}

function normalizedHardHyphenWords(regions: readonly PdfPageRegion[]) {
  return regions.flatMap((region) =>
    region.lines.flatMap((line) =>
      (
        line.text
          .normalize('NFKC')
          .toLocaleLowerCase('en-US')
          .match(/[\p{L}\p{N}]+[-‐‑][\p{L}\p{N}]+/gu) ?? []
      ).map((word) => word.replace(/[-‐‑]/gu, '-')),
    ),
  )
}

export function hasValidSourceSemanticFlowBoundaryLedgerCount({
  decisions,
  expectedCount,
}: {
  decisions: unknown
  expectedCount: unknown
}): boolean {
  return (
    Array.isArray(decisions) &&
    Number.isSafeInteger(expectedCount) &&
    (expectedCount as number) >= 0 &&
    decisions.length === expectedCount &&
    decisions.every(isPdfSourceSemanticFlowBoundaryDecision)
  )
}

export function hasValidCanonicalHyphenBoundaryLedger({
  decisions,
  expectedCount,
  regions,
}: {
  decisions: unknown
  expectedCount: unknown
  regions: readonly PdfPageRegion[]
}): boolean {
  if (
    !Array.isArray(decisions) ||
    !Number.isSafeInteger(expectedCount) ||
    (expectedCount as number) < 0 ||
    decisions.length !== expectedCount
  ) {
    return false
  }
  const regionMap = new Map<string, PdfPageRegion>()
  const lineOwners = new Map<
    string,
    { region: PdfPageRegion; line: PdfPageRegion['lines'][number] }
  >()
  for (const region of regions) {
    if (regionMap.has(region.id)) return false
    regionMap.set(region.id, region)
    for (const line of region.lines) {
      if (lineOwners.has(line.id)) return false
      lineOwners.set(line.id, { region, line })
    }
  }
  const sourceWords = new Set(normalizedSourceWords(regions))
  const hardHyphenWords = new Set(normalizedHardHyphenWords(regions))
  const ids = new Set<string>()
  const boundaries = new Set<string>()
  for (const candidate of decisions) {
    if (
      !isUnknownRecord(candidate) ||
      !exactObjectKeys(candidate, [
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
      typeof candidate.id !== 'string' ||
      typeof candidate.context !== 'string' ||
      typeof candidate.outcome !== 'string' ||
      typeof candidate.fromRegionId !== 'string' ||
      typeof candidate.fromLineId !== 'string' ||
      typeof candidate.toRegionId !== 'string' ||
      typeof candidate.toLineId !== 'string' ||
      !['bibliography-continuation', 'canonical-flow-continuation'].includes(
        candidate.context,
      ) ||
      candidate.outcome !== 'removed-discretionary-hyphen' ||
      !isUnknownRecord(candidate.geometry) ||
      !exactObjectKeys(candidate.geometry, ['from', 'to']) ||
      !isUnknownRecord(candidate.proof) ||
      !isUnknownRecord(candidate.proof.pinnedSplit) ||
      !exactObjectKeys(candidate.proof.pinnedSplit, [
        'left',
        'right',
        'index',
      ]) ||
      typeof candidate.proof.pinnedSplit.left !== 'string' ||
      typeof candidate.proof.pinnedSplit.right !== 'string' ||
      !Number.isSafeInteger(candidate.proof.pinnedSplit.index) ||
      typeof candidate.proof.hardHyphenForm !== 'string' ||
      !isUnknownRecord(candidate.proof.model) ||
      !exactObjectKeys(candidate.proof.model, [
        'id',
        'language',
        'dictionarySha256',
        'affixSha256',
        'hyphenationSha256',
      ]) ||
      typeof candidate.proof.model.id !== 'string' ||
      typeof candidate.proof.model.language !== 'string' ||
      typeof candidate.proof.model.dictionarySha256 !== 'string' ||
      typeof candidate.proof.model.affixSha256 !== 'string' ||
      typeof candidate.proof.model.hyphenationSha256 !== 'string' ||
      !Array.isArray(candidate.proof.evidence) ||
      candidate.proof.evidence.some(
        (entry: unknown) => typeof entry !== 'string' || entry.length === 0,
      ) ||
      !isNormalizedSourceBox(candidate.geometry.from) ||
      !isNormalizedSourceBox(candidate.geometry.to)
    ) {
      return false
    }
    const proofCandidate = candidate.proof
    const exactProofShape =
      proofCandidate.tier === 'exact-same-document' &&
      exactObjectKeys(proofCandidate, [
        'tier',
        'sourceBoundaryProven',
        'pinnedWord',
        'pinnedJoinedFormValid',
        'pinnedSplit',
        'splitPointValid',
        'exactSameDocumentJoinedForm',
        'sameDocumentJoinedFormValid',
        'hardHyphenForm',
        'hardHyphenCounterproof',
        'model',
        'evidence',
      ]) &&
      typeof proofCandidate.pinnedWord === 'string' &&
      proofCandidate.pinnedJoinedFormValid === true &&
      typeof proofCandidate.exactSameDocumentJoinedForm === 'string' &&
      proofCandidate.sameDocumentJoinedFormValid === true
    const derivedProofShape =
      proofCandidate.tier === 'same-document-derived-affix' &&
      exactObjectKeys(proofCandidate, [
        'tier',
        'sourceBoundaryProven',
        'derivedWord',
        'productivePrefix',
        'baseWord',
        'pinnedBaseWordValid',
        'pinnedSplit',
        'splitPointValid',
        'exactSameDocumentBaseWord',
        'sameDocumentBaseWordValid',
        'hardHyphenForm',
        'hardHyphenCounterproof',
        'model',
        'evidence',
      ]) &&
      typeof proofCandidate.derivedWord === 'string' &&
      isUnknownRecord(proofCandidate.productivePrefix) &&
      exactObjectKeys(proofCandidate.productivePrefix, [
        'kind',
        'value',
        'affixClass',
        'flag',
        'crossProduct',
        'affixSha256',
      ]) &&
      typeof proofCandidate.baseWord === 'string' &&
      proofCandidate.pinnedBaseWordValid === true &&
      typeof proofCandidate.exactSameDocumentBaseWord === 'string' &&
      proofCandidate.sameDocumentBaseWordValid === true
    if (!exactProofShape && !derivedProofShape) return false
    const decision = candidate as unknown as PdfCanonicalHyphenBoundaryDecision
    const from = lineOwners.get(decision.fromLineId)
    const to = lineOwners.get(decision.toLineId)
    const left = decision.proof.pinnedSplit.left
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
    const right = decision.proof.pinnedSplit.right
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
    const joined = `${left}${right}`
    const hardHyphen = `${left}-${right}`
    const replayedProof = resolvePdfHyphenBoundary({
      left,
      right,
      language: decision.proof.model.language,
      sourceProven: true,
      hardHyphenLexicon: hardHyphenWords,
      unhyphenatedLexicon: sourceWords,
    })
    const exactTierValid =
      decision.proof.tier === 'exact-same-document' &&
      replayedProof.verdict === 'remove' &&
      replayedProof.lexicalProof?.tier === 'exact-same-document' &&
      decision.proof.pinnedWord.normalize('NFKC').toLocaleLowerCase('en-US') ===
        joined &&
      decision.proof.exactSameDocumentJoinedForm
        .normalize('NFKC')
        .toLocaleLowerCase('en-US') === joined &&
      sourceWords.has(joined) &&
      PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE.every((evidence) =>
        decision.proof.evidence.includes(evidence),
      )
    const derivedTierValid =
      decision.proof.tier === 'same-document-derived-affix' &&
      replayedProof.verdict === 'remove' &&
      replayedProof.lexicalProof?.tier === 'same-document-derived-affix' &&
      decision.proof.derivedWord
        .normalize('NFKC')
        .toLocaleLowerCase('en-US') === joined &&
      decision.proof.productivePrefix.kind ===
        PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.kind &&
      decision.proof.productivePrefix.value ===
        PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.value &&
      decision.proof.productivePrefix.affixClass ===
        PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.affixClass &&
      decision.proof.productivePrefix.flag ===
        PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.flag &&
      decision.proof.productivePrefix.crossProduct ===
        PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.crossProduct &&
      decision.proof.productivePrefix.affixSha256 ===
        PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.affixSha256 &&
      decision.proof.baseWord.normalize('NFKC').toLocaleLowerCase('en-US') ===
        replayedProof.lexicalProof.baseWord &&
      decision.proof.exactSameDocumentBaseWord
        .normalize('NFKC')
        .toLocaleLowerCase('en-US') === replayedProof.lexicalProof.baseWord &&
      left.length > PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE.value.length &&
      sourceWords.has(replayedProof.lexicalProof.baseWord) &&
      PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE.every((evidence) =>
        decision.proof.evidence.includes(evidence),
      )
    const boundary = [
      decision.fromRegionId,
      decision.fromLineId,
      decision.toRegionId,
      decision.toLineId,
    ].join('\0')
    if (
      ids.has(decision.id) ||
      boundaries.has(boundary) ||
      !from ||
      !to ||
      from.region.id !== decision.fromRegionId ||
      to.region.id !== decision.toRegionId ||
      decision.id !==
        `canonical-hyphen-boundary:${decision.context}:${decision.fromRegionId}:${decision.fromLineId}->${decision.toRegionId}:${decision.toLineId}` ||
      !sameNormalizedSourceBox(decision.geometry.from, from.line.box) ||
      !sameNormalizedSourceBox(decision.geometry.to, to.line.box) ||
      decision.proof.sourceBoundaryProven !== true ||
      decision.proof.splitPointValid !== true ||
      decision.proof.hardHyphenCounterproof !== null ||
      (!exactTierValid && !derivedTierValid) ||
      left.length === 0 ||
      right.length === 0 ||
      decision.proof.pinnedSplit.index !== left.length ||
      decision.proof.hardHyphenForm
        .normalize('NFKC')
        .toLocaleLowerCase('en-US') !== hardHyphen ||
      !from.line.text
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .trimEnd()
        .replace(/[-‐‑]$/u, '-')
        .endsWith(`${left}-`) ||
      !to.line.text
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .trimStart()
        .startsWith(right) ||
      hardHyphenWords.has(hardHyphen) ||
      decision.proof.model.id !== PDF_HYPHEN_LEXICAL_MODEL.id ||
      decision.proof.model.language !== PDF_HYPHEN_LEXICAL_MODEL.language ||
      decision.proof.model.dictionarySha256 !==
        PDF_HYPHEN_LEXICAL_MODEL.dictionarySha256 ||
      decision.proof.model.affixSha256 !==
        PDF_HYPHEN_LEXICAL_MODEL.affixSha256 ||
      decision.proof.model.hyphenationSha256 !==
        PDF_HYPHEN_LEXICAL_MODEL.hyphenationSha256 ||
      decision.proof.evidence.length === 0 ||
      new Set(decision.proof.evidence).size !==
        decision.proof.evidence.length ||
      PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE.some((evidence) =>
        decision.proof.evidence.includes(evidence),
      )
    ) {
      return false
    }
    ids.add(decision.id)
    boundaries.add(boundary)
  }
  return true
}

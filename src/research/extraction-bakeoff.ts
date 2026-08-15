import {
  STRUCTURED_EXTRACTION_NODE_TYPES,
  type StructuredExtractionContext,
  type StructuredExtractionLayout,
  type StructuredExtractionNodeType,
  type StructuredExtractionProposal,
  type StructuredExtractionSplit,
  structuredExtractionHash,
  structuredExtractionStableJson,
  verifyStructuredExtraction,
  modelInputForStructuredExtraction,
  type VerifiedStructuredExtraction,
} from './structured-extraction.ts'

export const EXTRACTION_BAKEOFF_SCHEMA_VERSION = '1.0.0' as const
export const EXTRACTION_BAKEOFF_ARMS = [
  'geometric-baseline',
  'llm-authored',
  'llm-grounded',
] as const
export type ExtractionBakeoffArmId = (typeof EXTRACTION_BAKEOFF_ARMS)[number]

export const EXTRACTION_BAKEOFF_STRATA = [
  'sectioning',
  'prose-continuity',
  'boilerplate-exclusion',
  'code-listings',
  'tables',
  'figures-diagrams',
  'equations',
  'footnotes-citations',
] as const
export type ExtractionBakeoffStratum =
  (typeof EXTRACTION_BAKEOFF_STRATA)[number]

export type ExtractionBakeoffDocument = {
  id: string
  split: StructuredExtractionSplit
  layout: StructuredExtractionLayout
  context: StructuredExtractionContext
  cases: ExtractionBakeoffCase[]
}

export type ExtractionBakeoffCase = {
  id: string
  documentId: string
  stratum: string
  layout: StructuredExtractionLayout
  /** Independent labels; never supplied to a candidate arm. */
  expectedNodeTypes: StructuredExtractionNodeType[]
  expectedHeadingLevels?: number[]
  expectedAssetIds?: string[]
  expectedSourceRunIds?: string[]
  expectedExcludedBoilerplateRunIds?: string[]
}

export type ExtractionBakeoffCorpus = {
  id: string
  development: ExtractionBakeoffDocument[]
  heldOut: ExtractionBakeoffDocument[]
}

export type ExtractionBakeoffModelIdentity = {
  providerId: string
  modelId: string
  modelVersion: string
  modelDigest: string
  promptHash: string
}

export type ExtractionBakeoffRunMetrics = {
  latencyMs: number
  costUsd: number
  pageCount?: number
}

export type ExtractionBakeoffArmResult = {
  proposal: StructuredExtractionProposal
  metrics?: ExtractionBakeoffRunMetrics
}

export type ExtractionBakeoffArm = {
  id: ExtractionBakeoffArmId
  identity: ExtractionBakeoffModelIdentity
  /** Candidate tuning may only use development labels. */
  tunedOn: readonly StructuredExtractionSplit[]
  /** Set this when the adapter knows it consulted held-out labels. */
  usedHeldOutForTuning?: boolean
  run: (
    input: StructuredExtractionContext,
  ) => ExtractionBakeoffArmResult | Promise<ExtractionBakeoffArmResult>
}

export type ExtractionBakeoffVerification = {
  status: 'passed' | 'failed'
  issueCodes: string[]
  issueCount: number
}

export type ExtractionBakeoffCaseScore = {
  caseId: string
  documentId: string
  stratum: string
  layout: StructuredExtractionLayout
  score: number
  typePrecision: number
  typeRecall: number
  sourceRecall: number
  assetRecall: number
  /** Only present when the case declares `expectedHeadingLevels`. */
  headingLevelRecall?: number
  boilerplateContamination: number
  /** Hash of the verified structure owned by this case's source labels. */
  structureHash: string | null
  verification: ExtractionBakeoffVerification
}

export type ExtractionBakeoffDocumentResult = {
  documentId: string
  split: StructuredExtractionSplit
  layout: StructuredExtractionLayout
  status: 'passed' | 'failed' | 'disqualified'
  verification: ExtractionBakeoffVerification
  outputHash: string | null
  byteStable: boolean
  latencyMsPerPage: number | null
  costUsdPerPage: number | null
  caseScores: ExtractionBakeoffCaseScore[]
}

export type ExtractionBakeoffComparisonRow = {
  stratum: string
  layout: StructuredExtractionLayout
  scores: Record<ExtractionBakeoffArmId, number | null>
  winner: ExtractionBakeoffArmId | 'tie' | null
  disagreementDocumentIds: string[]
}

export type ExtractionBakeoffReport = {
  schemaVersion: typeof EXTRACTION_BAKEOFF_SCHEMA_VERSION
  corpusId: string
  heldOutIdentitySha256: string
  candidateIdentities: Record<
    ExtractionBakeoffArmId,
    ExtractionBakeoffModelIdentity
  >
  heldOutScoredOnce: true
  arms: Record<
    ExtractionBakeoffArmId,
    {
      documents: ExtractionBakeoffDocumentResult[]
      byStratumAndLayout: Record<string, number>
      disqualified: boolean
    }
  >
  comparison: ExtractionBakeoffComparisonRow[]
  disagreements: Array<{
    documentId: string
    stratum: string
    layout: StructuredExtractionLayout
    arms: ExtractionBakeoffArmId[]
    reason: 'verification' | 'structure' | 'score'
  }>
  reportSha256: string
}

export type ExtractionArchitectureDecision = {
  schemaVersion: typeof EXTRACTION_BAKEOFF_SCHEMA_VERSION
  decisionId: string
  owner:
    | 'llm-authored'
    | 'llm-grounded'
    | 'geometric-baseline'
    | 'hybrid'
    | 'pending'
  humanDecisionRequired: boolean
  perStratum: Record<string, ExtractionBakeoffArmId | 'tie' | 'pending'>
  geometricRole: string
  reversalCriteria: string[]
  heldOutIdentitySha256: string
  reportSha256: string
}

const SHA256 = /^[a-f0-9]{64}$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u
const FORBIDDEN_GROUND_TRUTH_KEYS = new Set([
  'gold',
  'goldlabel',
  'groundtruth',
  'expected',
  'labels',
  'reviewerannotation',
  'reviewerlabel',
  'targetbox',
])

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validExtractionArmResult(
  value: unknown,
): value is ExtractionBakeoffArmResult & {
  metrics: ExtractionBakeoffRunMetrics
} {
  if (!value || typeof value !== 'object') return false
  const metrics = (value as Partial<ExtractionBakeoffArmResult>).metrics
  return Boolean(
    metrics &&
    finiteNonNegative(metrics.latencyMs) &&
    finiteNonNegative(metrics.costUsd) &&
    (metrics.pageCount === undefined ||
      (Number.isSafeInteger(metrics.pageCount) && metrics.pageCount >= 1)),
  )
}

function stableJson(value: unknown) {
  return structuredExtractionStableJson(value)
}

function identityValid(identity: ExtractionBakeoffModelIdentity) {
  return (
    SAFE_ID.test(identity.providerId) &&
    SAFE_ID.test(identity.modelId) &&
    SAFE_ID.test(identity.modelVersion) &&
    SHA256.test(identity.modelDigest) &&
    SHA256.test(identity.promptHash)
  )
}

function hasForbiddenGroundTruth(value: unknown, path = ''): string | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = hasForbiddenGroundTruth(item, `${path}[${index}]`)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key
      .normalize('NFKC')
      .replace(/[^A-Za-z0-9]/gu, '')
      .toLowerCase()
    if (
      FORBIDDEN_GROUND_TRUTH_KEYS.has(normalizedKey) ||
      /^(?:gold|groundtruth|expected|labels?|reviewer|targetbox)/u.test(
        normalizedKey,
      )
    )
      return `${path}.${key}`
    const found = hasForbiddenGroundTruth(child, `${path}.${key}`)
    if (found) return found
  }
  return null
}

function unique(values: readonly string[]) {
  return new Set(values).size === values.length
}

function validateCase(
  caseInput: ExtractionBakeoffCase,
  document: ExtractionBakeoffDocument,
) {
  const sourceRunIds = new Set(document.context.sourceRuns.map(({ id }) => id))
  const assetIds = new Set(document.context.sourceAssets.map(({ id }) => id))
  const boilerplateRunIds = new Set(document.context.boilerplateRunIds ?? [])
  if (
    !SAFE_ID.test(caseInput.id) ||
    caseInput.documentId !== document.id ||
    caseInput.layout !== document.layout ||
    !caseInput.stratum ||
    caseInput.expectedNodeTypes.length === 0 ||
    !caseInput.expectedNodeTypes.every((type) =>
      (STRUCTURED_EXTRACTION_NODE_TYPES as readonly string[]).includes(type),
    ) ||
    !unique(caseInput.expectedAssetIds ?? []) ||
    !unique(caseInput.expectedSourceRunIds ?? []) ||
    !unique(caseInput.expectedExcludedBoilerplateRunIds ?? []) ||
    (caseInput.expectedHeadingLevels ?? []).some(
      (level) => !Number.isSafeInteger(level) || level < 1 || level > 6,
    ) ||
    (caseInput.expectedSourceRunIds ?? []).some(
      (sourceRunId) => !sourceRunIds.has(sourceRunId),
    ) ||
    (caseInput.expectedAssetIds ?? []).some(
      (assetId) => !assetIds.has(assetId),
    ) ||
    (caseInput.expectedExcludedBoilerplateRunIds ?? []).some(
      (sourceRunId) => !boilerplateRunIds.has(sourceRunId),
    )
  ) {
    throw new Error(`INVALID_EXTRACTION_BAKEOFF_CASE:${caseInput.id}`)
  }
}

export function validateExtractionBakeoffCorpus(
  corpus: ExtractionBakeoffCorpus,
) {
  if (!SAFE_ID.test(corpus.id))
    throw new Error('INVALID_EXTRACTION_BAKEOFF_CORPUS')
  if (corpus.development.length === 0 || corpus.heldOut.length === 0) {
    throw new Error('EXTRACTION_BAKEOFF_REQUIRES_DEVELOPMENT_AND_HELD_OUT')
  }
  // Bind each entry to the array holding it. A development-tagged entry under
  // `heldOut` still contributes to the held-out identity and layout checks but
  // bypasses the contamination guards and drops out of held-out comparisons,
  // and a held-out-tagged development entry is bound by no identity at all.
  const documents = [
    ...corpus.development.map((document) => ({
      document,
      split: 'development' as const,
    })),
    ...corpus.heldOut.map((document) => ({
      document,
      split: 'held-out' as const,
    })),
  ]
  if (!unique(documents.map(({ document }) => document.id)))
    throw new Error('DUPLICATE_EXTRACTION_BAKEOFF_DOCUMENT')
  for (const { document, split } of documents) {
    if (
      !SAFE_ID.test(document.id) ||
      document.context.documentId !== document.id ||
      document.split !== split ||
      document.context.split !== document.split ||
      document.context.layout !== document.layout
    ) {
      throw new Error(`INVALID_EXTRACTION_BAKEOFF_DOCUMENT:${document.id}`)
    }
    if (
      !SHA256.test(document.context.sourceSha256) ||
      document.cases.length === 0
    ) {
      throw new Error(`INVALID_EXTRACTION_BAKEOFF_DOCUMENT:${document.id}`)
    }
    const caseIds = document.cases.map(({ id }) => id)
    if (!unique(caseIds))
      throw new Error(`DUPLICATE_EXTRACTION_BAKEOFF_CASE:${document.id}`)
    for (const caseInput of document.cases) validateCase(caseInput, document)
  }
  const layouts = new Set(corpus.heldOut.map(({ layout }) => layout))
  if (layouts.size < 2)
    throw new Error('EXTRACTION_BAKEOFF_HELD_OUT_MUST_BALANCE_LAYOUTS')
  const heldOutStrata = new Map<string, Set<StructuredExtractionLayout>>()
  for (const document of corpus.heldOut) {
    for (const caseInput of document.cases) {
      const layoutsForStratum =
        heldOutStrata.get(caseInput.stratum) ??
        new Set<StructuredExtractionLayout>()
      layoutsForStratum.add(caseInput.layout)
      heldOutStrata.set(caseInput.stratum, layoutsForStratum)
    }
  }
  for (const stratum of EXTRACTION_BAKEOFF_STRATA) {
    const stratumLayouts = heldOutStrata.get(stratum)
    if (!stratumLayouts || stratumLayouts.size < 2) {
      throw new Error(
        `EXTRACTION_BAKEOFF_HELD_OUT_MISSING_STRATUM_OR_LAYOUT:${stratum}`,
      )
    }
  }
  return {
    corpusId: corpus.id,
    developmentCount: corpus.development.length,
    heldOutCount: corpus.heldOut.length,
    // Bind the receipt to the complete held-out binding, including its
    // independent labels.  The digest is published, never the source text.
    heldOutIdentitySha256: structuredExtractionHash(corpus.heldOut),
  }
}

export function assertNoHeldOutContamination(
  arm: ExtractionBakeoffArm,
  proposal: unknown,
  split: StructuredExtractionSplit,
) {
  if (!identityValid(arm.identity))
    throw new Error(`INVALID_EXTRACTION_MODEL_IDENTITY:${arm.id}`)
  if (!arm.tunedOn.every((value) => value === 'development')) {
    throw new Error(`HELD_OUT_CONTAMINATION:${arm.id}:tunedOn`)
  }
  if (arm.usedHeldOutForTuning)
    throw new Error(`HELD_OUT_CONTAMINATION:${arm.id}:adapter-flag`)
  const forbidden = hasForbiddenGroundTruth(proposal)
  if (forbidden)
    throw new Error(`HELD_OUT_CONTAMINATION:${arm.id}:${forbidden}`)
  if (
    split === 'held-out' &&
    arm.tunedOn.some((tuningSplit) => tuningSplit !== 'development')
  ) {
    throw new Error(`HELD_OUT_CONTAMINATION:${arm.id}:held-out-tuning`)
  }
  // The `every` check above deliberately narrows the tuning declaration to
  // development-only; a held-out entry can therefore never pass this point.
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0
    ? 1
    : Math.max(0, Math.min(1, numerator / denominator))
}

function scoreCase(
  caseInput: ExtractionBakeoffCase,
  output: VerifiedStructuredExtraction | null,
  verification: ExtractionBakeoffVerification,
): ExtractionBakeoffCaseScore {
  const nodes = output?.nodes ?? []
  const actualTypes = nodes.map(({ type }) => type)
  const expectedTypes = [...caseInput.expectedNodeTypes]
  const matchedTypes = expectedTypes.filter(
    (type, index) => actualTypes[index] === type,
  ).length
  const expectedCounts = new Map<string, number>()
  const actualCounts = new Map<string, number>()
  expectedTypes.forEach((type) =>
    expectedCounts.set(type, (expectedCounts.get(type) ?? 0) + 1),
  )
  actualTypes.forEach((type) =>
    actualCounts.set(type, (actualCounts.get(type) ?? 0) + 1),
  )
  const typePrecision = ratio(
    [...actualCounts.entries()].reduce(
      (sum, [type, count]) =>
        sum + Math.min(count, expectedCounts.get(type) ?? 0),
      0,
    ),
    actualTypes.length,
  )
  const typeRecall = ratio(matchedTypes, expectedTypes.length)
  const expectedRuns = new Set(caseInput.expectedSourceRunIds ?? [])
  const actualRuns = new Set(nodes.flatMap(({ sourceRunIds }) => sourceRunIds))
  const sourceRecall = ratio(
    [...expectedRuns].filter((id) => actualRuns.has(id)).length,
    expectedRuns.size,
  )
  const expectedAssets = new Set(caseInput.expectedAssetIds ?? [])
  const actualAssets = new Set(output?.assetIds ?? [])
  const assetRecall = ratio(
    [...expectedAssets].filter((id) => actualAssets.has(id)).length,
    expectedAssets.size,
  )
  const boilerplate = new Set(caseInput.expectedExcludedBoilerplateRunIds ?? [])
  const bodyRuns = [...actualRuns].filter((id) => boilerplate.has(id)).length
  const boilerplateContamination =
    boilerplate.size === 0 ? 0 : ratio(bodyRuns, boilerplate.size)
  // A sectioning case that declares the expected hierarchy is scored on it.
  // Without this, a candidate can emit every heading at the wrong depth — a
  // broken hierarchy — and score exactly as well as one that gets it right.
  const expectedHeadingLevels = caseInput.expectedHeadingLevels
  const headingLevelRecall =
    expectedHeadingLevels === undefined
      ? undefined
      : ratio(
          expectedHeadingLevels.filter(
            (level, index) =>
              nodes.filter(({ type }) => type === 'heading')[index]?.level ===
              level,
          ).length,
          expectedHeadingLevels.length,
        )
  // A failed verifier and a degenerate/no-object answer are both zero. The
  // precision term keeps "every line is a heading" below a useful answer.
  const terms = [
    typePrecision,
    typeRecall,
    sourceRecall,
    assetRecall,
    1 - boilerplateContamination,
    ...(headingLevelRecall === undefined ? [] : [headingLevelRecall]),
  ]
  const score =
    verification.status === 'passed' && nodes.length > 0
      ? terms.reduce((sum, term) => sum + term, 0) / terms.length
      : 0
  const relevantNodes = output?.nodes.filter((node) => {
    const ownedRunIds = [
      ...node.sourceRunIds,
      ...(node.table?.rows.flatMap(({ cells }) =>
        cells.flatMap(({ sourceRunIds }) => sourceRunIds),
      ) ?? []),
    ]
    if (ownedRunIds.some((id) => expectedRuns.has(id))) return true
    if (node.assetId && expectedAssets.has(node.assetId)) return true
    return (
      expectedRuns.size === 0 &&
      expectedAssets.size === 0 &&
      expectedTypes.includes(node.type)
    )
  })
  const structureHash = output
    ? structuredExtractionHash({
        nodes: relevantNodes,
        assetIds: output.assetIds.filter((id) => expectedAssets.has(id)),
        excludedBoilerplateRunIds: output.excludedBoilerplateRunIds.filter(
          (id) => boilerplate.has(id),
        ),
      })
    : null
  return {
    caseId: caseInput.id,
    documentId: caseInput.documentId,
    stratum: caseInput.stratum,
    layout: caseInput.layout,
    score,
    typePrecision,
    typeRecall,
    sourceRecall,
    assetRecall,
    ...(headingLevelRecall === undefined ? {} : { headingLevelRecall }),
    boilerplateContamination,
    structureHash,
    verification,
  }
}

function aggregateCaseScores(cases: readonly ExtractionBakeoffCaseScore[]) {
  if (cases.length === 0) return 0
  return cases.reduce((sum, item) => sum + item.score, 0) / cases.length
}

function verificationSummary(
  result: ReturnType<typeof verifyStructuredExtraction>,
): ExtractionBakeoffVerification {
  return result.status === 'passed'
    ? { status: 'passed', issueCodes: [], issueCount: 0 }
    : {
        status: 'failed',
        issueCodes: [...new Set(result.issues.map(({ code }) => code))],
        issueCount: result.issues.length,
      }
}

function combinedVerification(
  first: ReturnType<typeof verifyStructuredExtraction>,
  second: ReturnType<typeof verifyStructuredExtraction>,
  byteStable: boolean,
): ExtractionBakeoffVerification {
  const firstSummary = verificationSummary(first)
  const secondSummary = verificationSummary(second)
  const issueCodes = [
    ...new Set([...firstSummary.issueCodes, ...secondSummary.issueCodes]),
  ]
  const byteInstability =
    first.status === 'passed' && second.status === 'passed' && !byteStable
  if (byteInstability) issueCodes.push('byte-instability')
  return {
    status:
      first.status === 'passed' && second.status === 'passed' && byteStable
        ? 'passed'
        : 'failed',
    issueCodes: [...new Set(issueCodes)],
    issueCount:
      Math.max(firstSummary.issueCount, secondSummary.issueCount) +
      (byteInstability ? 1 : 0),
  }
}

function disqualifiedDocumentResult(
  document: ExtractionBakeoffDocument,
  issueCode: string,
  status: ExtractionBakeoffDocumentResult['status'] = 'disqualified',
): ExtractionBakeoffDocumentResult {
  const verification: ExtractionBakeoffVerification = {
    status: 'failed',
    issueCodes: [issueCode],
    issueCount: 1,
  }
  return {
    documentId: document.id,
    split: document.split,
    layout: document.layout,
    status,
    verification,
    outputHash: null,
    byteStable: false,
    latencyMsPerPage: null,
    costUsdPerPage: null,
    caseScores: document.cases.map((caseInput) =>
      scoreCase(caseInput, null, verification),
    ),
  }
}

function heldOutContaminationCode(error: unknown) {
  return error instanceof Error &&
    error.message.startsWith('HELD_OUT_CONTAMINATION')
    ? 'held-out-contamination'
    : null
}

function pageCount(context: StructuredExtractionContext) {
  return Math.max(
    1,
    ...context.sourceRuns.map(({ page }) => page),
    ...context.sourceAssets.map(({ page }) => page),
  )
}

function scoreByStratumAndLayout(
  documents: readonly ExtractionBakeoffDocumentResult[],
) {
  const grouped = new Map<string, number[]>()
  for (const document of documents) {
    for (const score of document.caseScores) {
      const key = `${score.stratum}\u0000${score.layout}`
      const values = grouped.get(key) ?? []
      values.push(score.score)
      grouped.set(key, values)
    }
  }
  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [
        key.replace('\u0000', '/'),
        aggregateCaseScores(
          values.map((score) => ({ score }) as ExtractionBakeoffCaseScore),
        ),
      ]),
  )
}

function winner(
  scores: Record<ExtractionBakeoffArmId, number | null>,
): ExtractionBakeoffArmId | 'tie' | null {
  const present = EXTRACTION_BAKEOFF_ARMS.filter((arm) => scores[arm] !== null)
  if (present.length === 0) return null
  const max = Math.max(...present.map((arm) => scores[arm]!))
  const winners = present.filter((arm) => Math.abs(scores[arm]! - max) < 1e-12)
  return winners.length === 1 ? winners[0] : 'tie'
}

function comparisons(
  corpus: ExtractionBakeoffCorpus,
  results: Record<ExtractionBakeoffArmId, ExtractionBakeoffDocumentResult[]>,
) {
  const heldOutCases = corpus.heldOut.flatMap(({ cases }) => cases)
  const keys = [
    ...new Set(
      heldOutCases.map(({ stratum, layout }) => `${stratum}\u0000${layout}`),
    ),
  ].sort()
  return keys.map((key) => {
    const [stratum, layout] = key.split('\u0000') as [
      string,
      StructuredExtractionLayout,
    ]
    const scores = Object.fromEntries(
      EXTRACTION_BAKEOFF_ARMS.map((arm) => {
        const values = results[arm]
          .filter(({ split }) => split === 'held-out')
          .flatMap((result) =>
            result.caseScores
              .filter(
                (score) => score.stratum === stratum && score.layout === layout,
              )
              .map((score) => score.score),
          )
        return [
          arm,
          values.length === 0
            ? null
            : values.reduce((sum, value) => sum + value, 0) / values.length,
        ]
      }),
    ) as Record<ExtractionBakeoffArmId, number | null>
    const relevant = EXTRACTION_BAKEOFF_ARMS.map((arm) =>
      results[arm]
        .filter(({ split }) => split === 'held-out')
        .filter((result) =>
          result.caseScores.some(
            (score) => score.stratum === stratum && score.layout === layout,
          ),
        ),
    )
    const documentIds = [
      ...new Set(
        relevant.flatMap((items) => items.map(({ documentId }) => documentId)),
      ),
    ].sort()
    // Compare what this row is about. The whole-document output hash differs
    // whenever the arms diverge anywhere in the document, which marks it a
    // disagreement for every stratum it appears in and stops the report from
    // saying where the architectures actually diverge.
    const disagreementDocumentIds = documentIds.filter((documentId) => {
      const states = EXTRACTION_BAKEOFF_ARMS.map((arm) => {
        const result = results[arm].find(
          ({ documentId: id }) => id === documentId,
        )
        if (!result) return 'missing'
        const rowScores = result.caseScores
          .filter(
            (score) => score.stratum === stratum && score.layout === layout,
          )
          .map((score) =>
            [
              score.caseId,
              score.score,
              score.typePrecision,
              score.typeRecall,
              score.sourceRecall,
              score.assetRecall,
              score.headingLevelRecall ?? 'none',
              score.boilerplateContamination,
              score.structureHash ?? 'none',
            ].join('\u0000'),
          )
          .sort()
        return [result.status, result.byteStable, ...rowScores].join('\u0001')
      })
      return new Set(states).size > 1
    })
    return {
      stratum,
      layout,
      scores,
      winner: winner(scores),
      disagreementDocumentIds,
    }
  })
}

/**
 * Run all arms against one corpus.  The runner never passes case labels to an
 * arm, scores held-out documents once per candidate identity, and rejects any
 * unverified candidate instead of publishing a partial structure.
 */
export async function runExtractionBakeoff({
  corpus,
  arms,
  includeDevelopment = false,
  scoredHeldOutKeys,
}: {
  corpus: ExtractionBakeoffCorpus
  arms: readonly ExtractionBakeoffArm[]
  includeDevelopment?: boolean
  /**
   * Ledger of held-out (identity, document) pairs already scored. A run-local
   * set cannot substantiate `heldOutScoredOnce`: calling this function again
   * with the same corpus and identities rescores every held-out document and
   * claims compliance again. Pass a caller-owned, run-spanning set to make the
   * guard mean what the report says.
   */
  scoredHeldOutKeys: Set<string>
}): Promise<ExtractionBakeoffReport> {
  const corpusReceipt = validateExtractionBakeoffCorpus(corpus)
  if (
    arms.length !== EXTRACTION_BAKEOFF_ARMS.length ||
    new Set(arms.map(({ id }) => id)).size !== arms.length
  ) {
    throw new Error('EXTRACTION_BAKEOFF_REQUIRES_BASELINE_AND_BOTH_ARMS')
  }
  for (const arm of arms)
    if (!EXTRACTION_BAKEOFF_ARMS.includes(arm.id))
      throw new Error(`UNKNOWN_EXTRACTION_BAKEOFF_ARM:${arm.id}`)

  const candidateIdentities = Object.fromEntries(
    arms.map(({ id, identity }) => [id, { ...identity }]),
  ) as Record<ExtractionBakeoffArmId, ExtractionBakeoffModelIdentity>
  const resultByArm = {
    'geometric-baseline': [],
    'llm-authored': [],
    'llm-grounded': [],
  } as Record<ExtractionBakeoffArmId, ExtractionBakeoffDocumentResult[]>
  const identityRunKeys = scoredHeldOutKeys
  const documents = includeDevelopment
    ? [...corpus.development, ...corpus.heldOut]
    : corpus.heldOut

  for (const arm of arms) {
    // Once an arm has leaked on the held-out split it must not be handed any
    // more held-out papers. Advancing only to the next document keeps feeding
    // held-out input to an adapter already recorded as contaminated, widening
    // the leak it was disqualified for.
    let contaminatedOnHeldOut: string | undefined
    // Isolate the adapter. A provider error, timeout, or adapter exception on
    // one document must not reject the whole run: the other arms are healthy
    // and their side-by-side evidence is the point of the bake-off.
    const runArm = async (input: StructuredExtractionContext) => {
      try {
        return { ok: true as const, value: await arm.run(input) }
      } catch {
        return { ok: false as const, value: null }
      }
    }
    for (const document of documents) {
      const runKey = `${corpusReceipt.heldOutIdentitySha256}\u0000${structuredExtractionHash(arm.identity)}\u0000${document.id}`
      if (document.split === 'held-out' && identityRunKeys.has(runKey))
        throw new Error(
          `HELD_OUT_SCORED_MORE_THAN_ONCE:${arm.id}:${document.id}`,
        )
      const inputArm =
        arm.id === 'geometric-baseline' ? 'geometric-baseline' : arm.id
      if (document.split === 'held-out') {
        if (!identityValid(arm.identity))
          throw new Error(`INVALID_EXTRACTION_MODEL_IDENTITY:${arm.id}`)
        if (contaminatedOnHeldOut) {
          resultByArm[arm.id].push(
            disqualifiedDocumentResult(document, contaminatedOnHeldOut),
          )
          identityRunKeys.add(runKey)
          continue
        }
        const staticContamination =
          !arm.tunedOn.every((value) => value === 'development') ||
          Boolean(arm.usedHeldOutForTuning)
        if (staticContamination) {
          contaminatedOnHeldOut = 'held-out-contamination'
          resultByArm[arm.id].push(
            disqualifiedDocumentResult(document, 'held-out-contamination'),
          )
          identityRunKeys.add(runKey)
          continue
        }
      }
      const firstInput = modelInputForStructuredExtraction(
        document.context,
        inputArm,
      )
      const firstRun = await runArm(firstInput)
      if (!firstRun.ok) {
        resultByArm[arm.id].push(
          disqualifiedDocumentResult(document, 'adapter-failure', 'failed'),
        )
        if (document.split === 'held-out') identityRunKeys.add(runKey)
        continue
      }
      const first = firstRun.value
      if (!validExtractionArmResult(first)) {
        resultByArm[arm.id].push(
          disqualifiedDocumentResult(document, 'adapter-failure', 'failed'),
        )
        if (document.split === 'held-out') identityRunKeys.add(runKey)
        continue
      }
      if (document.split === 'held-out') {
        try {
          assertNoHeldOutContamination(arm, first.proposal, document.split)
        } catch (error) {
          const issueCode = heldOutContaminationCode(error)
          if (!issueCode) throw error
          contaminatedOnHeldOut = issueCode
          resultByArm[arm.id].push(
            disqualifiedDocumentResult(document, issueCode),
          )
          identityRunKeys.add(runKey)
          continue
        }
      }
      const firstVerification = verifyStructuredExtraction(
        document.context,
        first.proposal,
      )
      const secondInput = modelInputForStructuredExtraction(
        document.context,
        inputArm,
      )
      const secondRun = await runArm(secondInput)
      if (!secondRun.ok) {
        resultByArm[arm.id].push(
          disqualifiedDocumentResult(document, 'adapter-failure', 'failed'),
        )
        if (document.split === 'held-out') identityRunKeys.add(runKey)
        continue
      }
      const second = secondRun.value
      if (!validExtractionArmResult(second)) {
        resultByArm[arm.id].push(
          disqualifiedDocumentResult(document, 'adapter-failure', 'failed'),
        )
        if (document.split === 'held-out') identityRunKeys.add(runKey)
        continue
      }
      if (document.split === 'held-out') {
        try {
          assertNoHeldOutContamination(arm, second.proposal, document.split)
        } catch (error) {
          const issueCode = heldOutContaminationCode(error)
          if (!issueCode) throw error
          contaminatedOnHeldOut = issueCode
          resultByArm[arm.id].push(
            disqualifiedDocumentResult(document, issueCode),
          )
          identityRunKeys.add(runKey)
          continue
        }
      }
      const secondVerification = verifyStructuredExtraction(
        document.context,
        second.proposal,
      )
      const byteStable =
        firstVerification.status === 'passed' &&
        secondVerification.status === 'passed' &&
        structuredExtractionStableJson(firstVerification.output) ===
          structuredExtractionStableJson(secondVerification.output)
      const verification = combinedVerification(
        firstVerification,
        secondVerification,
        byteStable,
      )
      const metrics = first.metrics
      // Derive the denominator from the document, never from the arm. An arm
      // that reports its own page count can drive latency and cost per page
      // arbitrarily close to zero and win the operating-profile comparison on
      // nothing. `metrics.pageCount` stays validated above but is not used.
      const pages = pageCount(document.context)
      const output =
        firstVerification.status === 'passed' &&
        secondVerification.status === 'passed' &&
        byteStable
          ? firstVerification.output
          : null
      const caseScores = document.cases.map((caseInput) =>
        scoreCase(caseInput, output, verification),
      )
      const status: ExtractionBakeoffDocumentResult['status'] =
        firstVerification.status === 'passed' &&
        secondVerification.status === 'passed'
          ? byteStable
            ? 'passed'
            : 'disqualified'
          : 'failed'
      resultByArm[arm.id].push({
        documentId: document.id,
        split: document.split,
        layout: document.layout,
        status,
        verification,
        outputHash: output ? structuredExtractionHash(output) : null,
        byteStable,
        latencyMsPerPage: metrics.latencyMs / pages,
        costUsdPerPage: metrics.costUsd / pages,
        caseScores,
      })
      if (document.split === 'held-out') identityRunKeys.add(runKey)
    }
  }

  const comparison = comparisons(corpus, resultByArm)
  const disagreements = comparison.flatMap((row) =>
    row.disagreementDocumentIds.map((documentId) => {
      const states = EXTRACTION_BAKEOFF_ARMS.map((arm) => {
        const result = resultByArm[arm].find(
          (item) => item.documentId === documentId && item.split === 'held-out',
        )
        const rowScores =
          result?.caseScores.filter(
            (score) =>
              score.stratum === row.stratum && score.layout === row.layout,
          ) ?? []
        return { arm, result, rowScores }
      })
      const scores = states.map(({ rowScores }) =>
        stableJson(rowScores.map(({ score }) => score)),
      )
      const structures = states.map(({ rowScores }) =>
        stableJson(rowScores.map(({ structureHash }) => structureHash)),
      )
      return {
        documentId,
        stratum: row.stratum,
        layout: row.layout,
        arms: states
          .filter(({ rowScores }) => rowScores.length > 0)
          .map(({ arm }) => arm),
        reason: states.some(({ result }) => result?.status !== 'passed')
          ? ('verification' as const)
          : new Set(structures).size > 1
            ? ('structure' as const)
            : new Set(scores).size > 1
              ? ('score' as const)
              : ('structure' as const),
      }
    }),
  )
  const reportWithoutHash = {
    schemaVersion: EXTRACTION_BAKEOFF_SCHEMA_VERSION,
    corpusId: corpus.id,
    heldOutIdentitySha256: corpusReceipt.heldOutIdentitySha256,
    candidateIdentities,
    heldOutScoredOnce: true as const,
    arms: Object.fromEntries(
      EXTRACTION_BAKEOFF_ARMS.map((arm) => [
        arm,
        {
          documents: resultByArm[arm],
          byStratumAndLayout: scoreByStratumAndLayout(resultByArm[arm]),
          disqualified: resultByArm[arm].some(
            ({ status }) => status === 'disqualified',
          ),
        },
      ]),
    ) as ExtractionBakeoffReport['arms'],
    comparison,
    disagreements,
  }
  return {
    ...reportWithoutHash,
    reportSha256: structuredExtractionHash(reportWithoutHash),
  }
}

export function createExtractionArchitectureDecision({
  report,
  decisionId = 'extraction-architecture-v1',
}: {
  report: ExtractionBakeoffReport
  decisionId?: string
}): ExtractionArchitectureDecision {
  // The decision copies `reportSha256` forward as the binding between the
  // recorded owner and the rows it was derived from. Verify that binding
  // before reading the rows, or a mutated report yields a decision that
  // presents the old hash as vouching for the altered comparison.
  const { reportSha256, ...reportWithoutHash } = report
  if (structuredExtractionHash(reportWithoutHash) !== reportSha256) {
    throw new Error('EXTRACTION_BAKEOFF_REPORT_HASH_MISMATCH')
  }
  const perStratum: Record<string, ExtractionBakeoffArmId | 'tie' | 'pending'> =
    {}
  for (const row of report.comparison) {
    const winner = row.winner ?? 'pending'
    const previous = perStratum[row.stratum]
    if (previous === undefined) perStratum[row.stratum] = winner
    else if (previous !== winner)
      perStratum[row.stratum] =
        previous === 'pending' || winner === 'pending' ? 'pending' : 'tie'
  }
  const winners = Object.values(perStratum).filter(
    (value): value is ExtractionBakeoffArmId =>
      EXTRACTION_BAKEOFF_ARMS.includes(value as ExtractionBakeoffArmId),
  )
  const uniqueWinners = [...new Set(winners)]
  const unresolved = Object.values(perStratum).some(
    (value) => value === 'tie' || value === 'pending',
  )
  const humanDecisionRequired = unresolved || uniqueWinners.length !== 1
  const owner: ExtractionArchitectureDecision['owner'] = humanDecisionRequired
    ? 'pending'
    : uniqueWinners[0]!
  return {
    schemaVersion: EXTRACTION_BAKEOFF_SCHEMA_VERSION,
    decisionId,
    owner,
    humanDecisionRequired,
    perStratum,
    geometricRole:
      'Remain the source-run, asset-bound, and publication verifier in every arm; it may provide the fail-closed fallback.',
    reversalCriteria: [
      'Reverse only after a new hash-pinned held-out split is scored once per candidate version.',
      'A proposed winner must improve the affected stratum and layout without lowering any other held-out stratum below the recorded baseline.',
      'Any unverified span, model-authored alt text, or model-authored asset bounds disqualifies the candidate regardless of score.',
    ],
    heldOutIdentitySha256: report.heldOutIdentitySha256,
    reportSha256: report.reportSha256,
  }
}

export function serializeExtractionBakeoffReport(
  report: ExtractionBakeoffReport,
) {
  return `${stableJson(report)}\n`
}

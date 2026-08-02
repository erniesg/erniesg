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
  boilerplateContamination: number
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
  'groundTruth',
  'groundtruth',
  'expected',
  'labels',
  'reviewerAnnotation',
  'targetBox',
])

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
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
    if (FORBIDDEN_GROUND_TRUTH_KEYS.has(key)) return `${path}.${key}`
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
    !unique(caseInput.expectedExcludedBoilerplateRunIds ?? [])
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
  const documents = [...corpus.development, ...corpus.heldOut]
  if (!unique(documents.map(({ id }) => id)))
    throw new Error('DUPLICATE_EXTRACTION_BAKEOFF_DOCUMENT')
  for (const document of documents) {
    if (
      !SAFE_ID.test(document.id) ||
      document.context.documentId !== document.id ||
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
    heldOutIdentitySha256: structuredExtractionHash(
      corpus.heldOut.map(({ id, split, layout, context }) => ({
        id,
        split,
        layout,
        sourceSha256: context.sourceSha256,
      })),
    ),
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
  // A failed verifier and a degenerate/no-object answer are both zero. The
  // precision term keeps "every line is a heading" below a useful answer.
  const score =
    verification.status === 'passed' && nodes.length > 0
      ? (typePrecision +
          typeRecall +
          sourceRecall +
          assetRecall +
          (1 - boilerplateContamination)) /
        5
      : 0
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
    boilerplateContamination,
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
        const values = results[arm].flatMap((result) =>
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
      results[arm].filter((result) =>
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
    const disagreementDocumentIds = documentIds.filter((documentId) => {
      const states = EXTRACTION_BAKEOFF_ARMS.map((arm) => {
        const result = results[arm].find(
          ({ documentId: id }) => id === documentId,
        )
        return result
          ? `${result.status}\u0000${result.outputHash ?? 'none'}\u0000${result.byteStable}`
          : 'missing'
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
}: {
  corpus: ExtractionBakeoffCorpus
  arms: readonly ExtractionBakeoffArm[]
  includeDevelopment?: boolean
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
  const identityRunKeys = new Set<string>()
  const documents = includeDevelopment
    ? [...corpus.development, ...corpus.heldOut]
    : corpus.heldOut

  for (const arm of arms) {
    for (const document of documents) {
      const runKey = `${structuredExtractionHash(arm.identity)}\u0000${document.id}`
      if (document.split === 'held-out' && identityRunKeys.has(runKey))
        throw new Error(
          `HELD_OUT_SCORED_MORE_THAN_ONCE:${arm.id}:${document.id}`,
        )
      const inputArm =
        arm.id === 'geometric-baseline' ? 'geometric-baseline' : arm.id
      const firstInput = modelInputForStructuredExtraction(
        document.context,
        inputArm,
      )
      const first = await arm.run(firstInput)
      if (!first || typeof first !== 'object')
        throw new Error(`INVALID_EXTRACTION_ARM_RESULT:${arm.id}`)
      if (document.split === 'held-out')
        assertNoHeldOutContamination(arm, first.proposal, document.split)
      const firstVerification = verifyStructuredExtraction(
        document.context,
        first.proposal,
      )
      const secondInput = modelInputForStructuredExtraction(
        document.context,
        inputArm,
      )
      const second = await arm.run(secondInput)
      if (!second || typeof second !== 'object')
        throw new Error(`INVALID_EXTRACTION_ARM_RESULT:${arm.id}`)
      if (document.split === 'held-out')
        assertNoHeldOutContamination(arm, second.proposal, document.split)
      const secondVerification = verifyStructuredExtraction(
        document.context,
        second.proposal,
      )
      const byteStable =
        firstVerification.status === 'passed' &&
        secondVerification.status === 'passed' &&
        structuredExtractionStableJson(firstVerification.output) ===
          structuredExtractionStableJson(secondVerification.output)
      const verification = verificationSummary(firstVerification)
      const metrics = first.metrics
      if (!metrics) throw new Error(`MISSING_EXTRACTION_RUN_METRICS:${arm.id}`)
      if (
        !finiteNonNegative(metrics.latencyMs) ||
        !finiteNonNegative(metrics.costUsd) ||
        (metrics.pageCount !== undefined &&
          (!Number.isSafeInteger(metrics.pageCount) || metrics.pageCount < 1))
      )
        throw new Error(`INVALID_EXTRACTION_RUN_METRICS:${arm.id}`)
      const pages = metrics.pageCount ?? pageCount(document.context)
      const output =
        firstVerification.status === 'passed' && byteStable
          ? firstVerification.output
          : null
      const caseScores = document.cases.map((caseInput) =>
        scoreCase(
          caseInput,
          output,
          byteStable
            ? verification
            : {
                status: 'failed',
                issueCodes: [
                  ...verification.issueCodes,
                  ...(byteStable ? [] : ['byte-instability']),
                ],
                issueCount: verification.issueCount + (byteStable ? 0 : 1),
              },
        ),
      )
      const status: ExtractionBakeoffDocumentResult['status'] = !byteStable
        ? 'disqualified'
        : firstVerification.status === 'passed'
          ? 'passed'
          : 'failed'
      resultByArm[arm.id].push({
        documentId: document.id,
        split: document.split,
        layout: document.layout,
        status,
        verification: byteStable
          ? verification
          : {
              status: 'failed',
              issueCodes: [...verification.issueCodes, 'byte-instability'],
              issueCount: verification.issueCount + 1,
            },
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
  const disagreements = comparison.flatMap((row) => {
    const armResults = EXTRACTION_BAKEOFF_ARMS.map((arm) =>
      resultByArm[arm].filter((result) =>
        result.caseScores.some(
          (score) =>
            score.stratum === row.stratum && score.layout === row.layout,
        ),
      ),
    )
    const ids = [
      ...new Set(
        armResults.flatMap((items) =>
          items.map(({ documentId }) => documentId),
        ),
      ),
    ].sort()
    return ids.flatMap((documentId) => {
      const states = EXTRACTION_BAKEOFF_ARMS.map((arm) => {
        const result = resultByArm[arm].find(
          (item) => item.documentId === documentId,
        )
        return {
          arm,
          result,
          state: result
            ? `${result.status}\u0000${result.outputHash ?? 'none'}\u0000${result.byteStable}`
            : 'missing',
        }
      })
      if (new Set(states.map(({ state }) => state)).size === 1) return []
      const matches = states
        .filter(({ result }) =>
          result?.caseScores.some(
            (score) =>
              score.stratum === row.stratum && score.layout === row.layout,
          ),
        )
        .map(({ arm }) => arm)
      return [
        {
          documentId,
          stratum: row.stratum,
          layout: row.layout,
          arms: matches,
          reason: states.some(({ result }) => result?.status !== 'passed')
            ? ('verification' as const)
            : ('structure' as const),
        },
      ]
    })
  })
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
  const perStratum: Record<string, ExtractionBakeoffArmId | 'tie' | 'pending'> =
    {}
  for (const row of report.comparison) {
    const previous = perStratum[row.stratum]
    if (previous === undefined)
      perStratum[row.stratum] = row.winner ?? 'pending'
    else if (previous !== row.winner && row.winner !== null)
      perStratum[row.stratum] = 'tie'
  }
  const winners = Object.values(perStratum).filter(
    (value): value is ExtractionBakeoffArmId =>
      EXTRACTION_BAKEOFF_ARMS.includes(value as ExtractionBakeoffArmId),
  )
  const uniqueWinners = [...new Set(winners)]
  const owner: ExtractionArchitectureDecision['owner'] =
    uniqueWinners.length === 0
      ? 'pending'
      : uniqueWinners.length > 1
        ? 'pending'
        : uniqueWinners[0]!
  return {
    schemaVersion: EXTRACTION_BAKEOFF_SCHEMA_VERSION,
    decisionId,
    owner,
    humanDecisionRequired: uniqueWinners.length > 1,
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

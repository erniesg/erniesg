import { z } from 'zod'
import type { StructBox } from '../struct/types'
import { sha256HexSync } from '../struct/sha256'

/**
 * Closed, content-addressed evidence for one source-PDF reconstruction attempt.
 *
 * The trace deliberately stores hashes and stable identifiers, not document
 * bytes, DOM text, screenshots, prompts, or provider output. Private artifacts
 * remain owner-local and can be verified against these bindings.
 */
export const RECONSTRUCTION_ATTEMPT_TRACE_SCHEMA_VERSION = '1.0.0' as const
export const SOURCE_EPUB_COMPARATOR_SCHEMA_VERSION = '1.0.0' as const

export const DETERMINISTIC_CHECK_IDS = [
  'render-binding',
  'epub-package',
  'source-region-conservation',
  'text-exactness',
  'reading-order',
  'hierarchy',
  'object-counts',
  'table-cells',
  'table-spans',
  'table-headers',
  'figures',
  'diagrams',
  'captions',
  'formulas',
  'code-preformatted',
  'notes',
  'citations',
  'links',
  'asset-bytes',
  'clipping',
  'overflow',
  'dangling-targets',
] as const

export type DeterministicCheckId = (typeof DETERMINISTIC_CHECK_IDS)[number]

export const SOURCE_EPUB_OBSERVATION_CHECK_IDS = [
  'text-exactness',
  'reading-order',
  'hierarchy',
  'object-counts',
  'table-cells',
  'table-spans',
  'table-headers',
  'figures',
  'diagrams',
  'captions',
  'formulas',
  'code-preformatted',
  'notes',
  'citations',
  'links',
  'asset-bytes',
  'clipping',
  'overflow',
  'dangling-targets',
] as const satisfies readonly DeterministicCheckId[]

export type SourceEpubObservationCheckId =
  (typeof SOURCE_EPUB_OBSERVATION_CHECK_IDS)[number]

export const RECONSTRUCTION_ATTEMPT_DEFAULT_BUDGET = {
  maxRefinements: 3,
  maxFreshTasks: 1,
  maxTokens: 24_000,
  maxDurationMs: 30 * 60 * 1_000,
} as const

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const nonEmptyStringSchema = z.string().trim().min(1).max(512)
const nonNegativeIntegerSchema = z.number().int().min(0)
const positiveIntegerSchema = z.number().int().positive()
const finiteNumberSchema = z.number().finite()
const rasterMediaTypeSchema = z.enum(['image/png', 'image/webp', 'image/jpeg'])

const hashedArtifactSchema = z
  .object({
    sha256: sha256Schema,
    byteLength: nonNegativeIntegerSchema,
  })
  .strict()

const nonEmptyHashedArtifactSchema = hashedArtifactSchema.refine(
  ({ byteLength }) => byteLength > 0,
  'Artifact bytes cannot be empty.',
)

const boxSchema = z
  .object({
    page: positiveIntegerSchema,
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    width: finiteNumberSchema.nonnegative(),
    height: finiteNumberSchema.nonnegative(),
    rotation: finiteNumberSchema,
  })
  .strict()

export const sourceLocationSchema = z
  .object({
    page: positiveIntegerSchema,
    boxes: z.array(boxSchema),
    sourceRegionIds: z.array(nonEmptyStringSchema).min(1),
  })
  .strict()

const viewportSchema = z
  .object({
    width: positiveIntegerSchema,
    height: positiveIntegerSchema,
    deviceScaleFactor: finiteNumberSchema.positive(),
  })
  .strict()

const rectSchema = z
  .object({
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    width: finiteNumberSchema.nonnegative(),
    height: finiteNumberSchema.nonnegative(),
  })
  .strict()

const renderedLocatorSchema = z
  .object({
    screenshotId: nonEmptyStringSchema,
    viewport: viewportSchema,
    rect: rectSchema,
    scrollOffset: z
      .object({ x: finiteNumberSchema, y: finiteNumberSchema })
      .strict()
      .optional(),
  })
  .strict()

const epubLocationSchema = z
  .object({
    spineHref: nonEmptyStringSchema,
    anchorId: nonEmptyStringSchema,
    /** Advisory only; the stable spine href and anchor id are authoritative. */
    domPath: nonEmptyStringSchema.optional(),
    /** Hash-bound visual locator for offline review, never an identity key. */
    rendered: renderedLocatorSchema.optional(),
  })
  .strict()

export const sourceOutputMappingSchema = z
  .object({
    id: nonEmptyStringSchema,
    obligationId: nonEmptyStringSchema,
    source: sourceLocationSchema,
    output: z.array(epubLocationSchema),
    status: z.enum(['mapped', 'missing', 'duplicate']),
  })
  .strict()

export const sourceRegionObligationSchema = z
  .object({ id: nonEmptyStringSchema, source: sourceLocationSchema })
  .strict()

export const canonicalObservationItemSchema = z
  .object({
    idSha256: sha256Schema,
    valueSha256: sha256Schema,
    anchorIds: z.array(nonEmptyStringSchema),
  })
  .strict()

export const canonicalObservationPayloadSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    check: z.enum(SOURCE_EPUB_OBSERVATION_CHECK_IDS),
    items: z.array(canonicalObservationItemSchema),
  })
  .strict()

export const sourceExpectedObservationSetSchema = z
  .object({
    check: z.enum(SOURCE_EPUB_OBSERVATION_CHECK_IDS),
    setSha256: sha256Schema,
    itemCount: nonNegativeIntegerSchema,
    payload: nonEmptyHashedArtifactSchema,
    sourceRegionIds: z.array(nonEmptyStringSchema),
    receiptSha256: sha256Schema,
  })
  .strict()

export const renderedActualObservationSetSchema = z
  .object({
    check: z.enum(SOURCE_EPUB_OBSERVATION_CHECK_IDS),
    setSha256: sha256Schema,
    itemCount: nonNegativeIntegerSchema,
    payload: nonEmptyHashedArtifactSchema,
    receiptSha256: sha256Schema,
  })
  .strict()

export const observationReceiptCoreSchema = z
  .object({
    idSha256: sha256Schema,
    check: z.enum(SOURCE_EPUB_OBSERVATION_CHECK_IDS),
    source: sourceLocationSchema.optional(),
    mappingIds: z.array(nonEmptyStringSchema).min(1),
    expectedSetReceiptSha256: sha256Schema,
    actualSetReceiptSha256: sha256Schema,
  })
  .strict()

export const observationReceiptSchema = observationReceiptCoreSchema
  .extend({ receiptSha256: sha256Schema })
  .strict()

const comparisonEvidenceSchema = z
  .object({
    sourceRegions: z.array(sourceRegionObligationSchema).min(1),
    observations: z.array(observationReceiptSchema).min(1),
  })
  .strict()

const sourcePdfSchema = z
  .object({
    artifact: hashedArtifactSchema,
    pageCount: positiveIntegerSchema,
    pageRenders: z
      .array(
        z
          .object({
            page: positiveIntegerSchema,
            sourcePdfSha256: sha256Schema,
            image: hashedArtifactSchema,
            mediaType: rasterMediaTypeSchema,
            width: positiveIntegerSchema,
            height: positiveIntegerSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()

const evidenceGraphSchema = z
  .object({
    /** #198 owns the graph schema; this module treats it as an opaque blob. */
    schemaVersion: nonEmptyStringSchema,
    artifact: hashedArtifactSchema,
    sourcePdfSha256: sha256Schema,
  })
  .strict()

export const sourceEvidenceReceiptSchema = z
  .object({
    schemaVersion: nonEmptyStringSchema,
    sourcePdfSha256: sha256Schema,
    evidenceGraphSha256: sha256Schema,
    candidateSetSha256: sha256Schema,
    sourceObligations: z
      .object({
        obligationsSha256: sha256Schema,
        obligationCount: positiveIntegerSchema,
        receiptSha256: sha256Schema,
      })
      .strict(),
    expectedObservationSets: z
      .array(sourceExpectedObservationSetSchema)
      .length(SOURCE_EPUB_OBSERVATION_CHECK_IDS.length),
    receiptSha256: sha256Schema,
  })
  .strict()

const evidenceCandidateReferenceSchema = z
  .object({
    referenceSha256: sha256Schema,
    bindingSha256: sha256Schema,
  })
  .strict()

export const structBindingSchema = z
  .object({
    schemaVersion: nonEmptyStringSchema,
    documentId: nonEmptyStringSchema,
    sourcePdfSha256: sha256Schema,
    artifact: hashedArtifactSchema,
    generatedSha256: sha256Schema,
    assets: z.array(
      z
        .object({
          id: nonEmptyStringSchema,
          sha256: sha256Schema,
          byteLength: nonNegativeIntegerSchema,
        })
        .strict(),
    ),
  })
  .strict()

export const epubBindingSchema = z
  .object({
    bytes: nonEmptyHashedArtifactSchema,
    mediaType: z.literal('application/epub+zip'),
    structSha256: sha256Schema,
    epubCheck: z
      .object({
        toolId: nonEmptyStringSchema,
        toolVersion: nonEmptyStringSchema,
        reportSha256: sha256Schema,
        status: z.enum(['passed', 'failed', 'not-run']),
        errorCount: nonNegativeIntegerSchema,
        warningCount: nonNegativeIntegerSchema,
      })
      .strict(),
  })
  .strict()

export const renderedEpubSchema = z
  .object({
    epubSha256: sha256Schema,
    download: z
      .object({
        artifact: nonEmptyHashedArtifactSchema,
        verificationReceiptSha256: sha256Schema,
      })
      .strict(),
    sourceObligations: z
      .object({
        sourcePdfSha256: sha256Schema,
        obligationsSha256: sha256Schema,
        obligationCount: positiveIntegerSchema,
        receiptSha256: sha256Schema,
      })
      .strict(),
    actualObservationSets: z
      .array(renderedActualObservationSetSchema)
      .length(SOURCE_EPUB_OBSERVATION_CHECK_IDS.length),
    renderer: z
      .object({
        id: nonEmptyStringSchema,
        version: nonEmptyStringSchema,
        executableSha256: sha256Schema.optional(),
        configurationSha256: sha256Schema,
      })
      .strict(),
    domSnapshots: z
      .array(
        z
          .object({
            spineHref: nonEmptyStringSchema,
            dom: hashedArtifactSchema,
            anchors: z.array(nonEmptyStringSchema).min(1),
          })
          .strict(),
      )
      .min(1),
    screenshots: z
      .array(
        z
          .object({
            id: nonEmptyStringSchema,
            spineHref: nonEmptyStringSchema,
            domSha256: sha256Schema,
            image: nonEmptyHashedArtifactSchema,
            mediaType: rasterMediaTypeSchema,
            width: positiveIntegerSchema,
            height: positiveIntegerSchema,
            viewport: viewportSchema,
            fullPage: z.boolean(),
          })
          .strict(),
      )
      .min(1),
    receiptSha256: sha256Schema,
  })
  .strict()

const providerReceiptSchema = z
  .object({
    id: nonEmptyStringSchema,
    role: z.enum([
      'source-evidence',
      'actual-render',
      'owner-local-codex-reconciliation',
      'owner-local-codex-repair',
      'optional',
    ]),
    required: z.boolean(),
    enabledBeforeRun: z.boolean(),
    providerId: nonEmptyStringSchema,
    identitySha256: sha256Schema.optional(),
    receiptSha256: sha256Schema,
    inputSha256: sha256Schema,
    outputSha256: sha256Schema,
    prompt: z
      .object({
        id: nonEmptyStringSchema,
        version: nonEmptyStringSchema,
        sha256: sha256Schema,
      })
      .strict()
      .optional(),
    tool: z
      .object({ id: nonEmptyStringSchema, version: nonEmptyStringSchema })
      .strict()
      .optional(),
    model: z
      .object({
        id: nonEmptyStringSchema,
        version: nonEmptyStringSchema,
        sha256: sha256Schema,
      })
      .strict()
      .optional(),
    server: z
      .object({
        id: nonEmptyStringSchema,
        version: nonEmptyStringSchema,
        transport: nonEmptyStringSchema,
        executableSha256: sha256Schema,
      })
      .strict()
      .optional(),
    status: z.enum([
      'available',
      'succeeded',
      'failed',
      'abstained',
      'disabled',
    ]),
  })
  .strict()

const comparatorCheckResultSchema = z
  .object({
    id: nonEmptyStringSchema,
    check: z.enum(DETERMINISTIC_CHECK_IDS),
    origin: z.enum(['deterministic', 'judge']),
    judgeResultId: nonEmptyStringSchema.optional(),
    status: z.enum(['passed', 'failed']),
    expectedSha256: sha256Schema,
    actualSha256: sha256Schema,
    mappingIds: z.array(nonEmptyStringSchema),
    source: sourceLocationSchema.optional(),
    message: nonEmptyStringSchema,
    failureId: nonEmptyStringSchema.optional(),
  })
  .strict()

const comparisonFailureSchema = z
  .object({
    id: nonEmptyStringSchema,
    check: z.enum(DETERMINISTIC_CHECK_IDS),
    origin: z.enum(['deterministic', 'judge']),
    judgeResultId: nonEmptyStringSchema.optional(),
    message: nonEmptyStringSchema,
    mappingIds: z.array(nonEmptyStringSchema),
    source: sourceLocationSchema.optional(),
    output: z.array(epubLocationSchema),
  })
  .strict()

// Interpretive judges are intentionally fail-closed in the core trace. A
// separately calibrated judge slice may replace this empty contract only after
// its frozen human labels and held-out thresholds are available.
const comparatorJudgeResultSchema = z.never()

const comparatorResultSchema = z
  .object({
    schemaVersion: z.literal(SOURCE_EPUB_COMPARATOR_SCHEMA_VERSION),
    sourcePdfSha256: sha256Schema,
    structSha256: sha256Schema,
    epubSha256: sha256Schema,
    renderObservationReceiptSha256: sha256Schema,
    observationSetSha256: sha256Schema,
    status: z.enum(['publication-ready', 'failed']),
    denominator: nonNegativeIntegerSchema,
    passed: nonNegativeIntegerSchema,
    failed: nonNegativeIntegerSchema,
    checkResults: z.array(comparatorCheckResultSchema).min(1),
    judgeResults: z.array(comparatorJudgeResultSchema).max(0),
    failures: z.array(comparisonFailureSchema),
    firstCauseFailureId: nonEmptyStringSchema.nullable(),
  })
  .strict()

export const structEvidencePatchOperationSchema = z
  .object({
    op: z.literal('select-evidence-candidate'),
    targetKind: z.enum(['block', 'asset', 'relationship']),
    targetId: nonEmptyStringSchema,
    candidateReferenceSha256: sha256Schema,
  })
  .strict()

export const structEvidencePatchSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    documentId: nonEmptyStringSchema,
    sourcePdfSha256: sha256Schema,
    sourceEvidenceGraphSha256: sha256Schema,
    baseStructSha256: sha256Schema,
    priorTraceSha256: sha256Schema,
    taskIdSha256: sha256Schema,
    operations: z.array(structEvidencePatchOperationSchema).min(1),
    proposalSha256: sha256Schema,
  })
  .strict()

const critiqueRepairSchema = z
  .object({
    providerReceiptId: nonEmptyStringSchema,
    priorComparatorSha256: sha256Schema,
    priorFirstCauseFailureId: nonEmptyStringSchema,
    critiqueSha256: sha256Schema,
    proposal: structEvidencePatchSchema,
    disposition: z.enum(['proposed', 'verified', 'rejected']),
  })
  .strict()

const budgetSchema = z
  .object({
    policy: z
      .object({
        maxRefinements: nonNegativeIntegerSchema,
        maxFreshTasks: positiveIntegerSchema,
        maxTokens: positiveIntegerSchema,
        maxDurationMs: positiveIntegerSchema,
        repairPolicySha256: sha256Schema,
      })
      .strict(),
    usage: z
      .object({
        refinements: nonNegativeIntegerSchema,
        freshTasks: nonNegativeIntegerSchema,
        tokens: nonNegativeIntegerSchema,
        durationMs: nonNegativeIntegerSchema,
      })
      .strict(),
  })
  .strict()

const traceCoreSchema = z
  .object({
    schemaVersion: z.literal(RECONSTRUCTION_ATTEMPT_TRACE_SCHEMA_VERSION),
    attemptId: nonEmptyStringSchema,
    lineage: z
      .object({
        attemptIndex: nonNegativeIntegerSchema,
        parentTraceSha256: sha256Schema.nullable(),
        immutablePriorTraceSha256: sha256Schema.nullable(),
        appliedRepair: z
          .object({
            proposalSha256: sha256Schema,
            baseStructSha256: sha256Schema,
            resultingStructSha256: sha256Schema,
            applicationReceiptSha256: sha256Schema,
            groundedVerifierReceiptSha256: sha256Schema,
            applicationSha256: sha256Schema,
          })
          .strict()
          .nullable(),
      })
      .strict(),
    sourcePdf: sourcePdfSchema,
    evidenceGraph: evidenceGraphSchema,
    sourceEvidence: sourceEvidenceReceiptSchema,
    evidenceCandidates: z.array(evidenceCandidateReferenceSchema).min(1),
    structure: structBindingSchema,
    epub: epubBindingSchema,
    renderedEpub: renderedEpubSchema,
    mappings: z.array(sourceOutputMappingSchema).min(1),
    comparisonEvidence: comparisonEvidenceSchema,
    providerReceipts: z.array(providerReceiptSchema),
    comparator: comparatorResultSchema,
    critiqueRepair: critiqueRepairSchema.nullable(),
    budget: budgetSchema,
    terminalState: z.enum(['publication-ready', 'failed']),
  })
  .strict()

const traceSchema = traceCoreSchema
  .extend({ traceSha256: sha256Schema })
  .strict()

export type HashedArtifact = z.infer<typeof hashedArtifactSchema>
export type SourceLocation = Omit<
  z.infer<typeof sourceLocationSchema>,
  'boxes'
> & { boxes: StructBox[] }
export type EpubLocation = z.infer<typeof epubLocationSchema>
export type SourceOutputMapping = z.infer<typeof sourceOutputMappingSchema>
export type SourceRegionObligation = z.infer<
  typeof sourceRegionObligationSchema
>
export type CanonicalObservationPayload = z.infer<
  typeof canonicalObservationPayloadSchema
>
export type SourceExpectedObservationSet = z.infer<
  typeof sourceExpectedObservationSetSchema
>
export type RenderedActualObservationSet = z.infer<
  typeof renderedActualObservationSetSchema
>
export type DeterministicComparisonObservation = z.infer<
  typeof observationReceiptSchema
>
export type SourcePdfBinding = z.infer<typeof sourcePdfSchema>
export type EvidenceGraphBinding = z.infer<typeof evidenceGraphSchema>
export type SourceEvidenceReceiptBinding = z.infer<
  typeof sourceEvidenceReceiptSchema
>
export type EvidenceCandidateReference = z.infer<
  typeof evidenceCandidateReferenceSchema
>
export type StructArtifactBinding = z.infer<typeof structBindingSchema>
export type EpubArtifactBinding = z.infer<typeof epubBindingSchema>
export type RenderedEpubEvidence = z.infer<typeof renderedEpubSchema>
export type ProviderReceiptBinding = z.infer<typeof providerReceiptSchema>
export type ComparatorCheckResult = z.infer<typeof comparatorCheckResultSchema>
export type ComparisonFailure = z.infer<typeof comparisonFailureSchema>
export type ComparatorJudgeResult = z.infer<typeof comparatorJudgeResultSchema>
export type SourceEpubComparatorResult = z.infer<typeof comparatorResultSchema>
export type StructEvidencePatchOperation = z.infer<
  typeof structEvidencePatchOperationSchema
>
export type StructEvidencePatch = z.infer<typeof structEvidencePatchSchema>
export type CritiqueRepairBinding = z.infer<typeof critiqueRepairSchema>
export type ReconstructionAttemptBudget = z.infer<typeof budgetSchema>
export type ReconstructionAttemptTraceCore = z.infer<typeof traceCoreSchema>
export type ReconstructionAttemptTrace = z.infer<typeof traceSchema>

export type TraceValidationIssue = {
  code:
    | 'invalid-schema'
    | 'hash-mismatch'
    | 'binding-mismatch'
    | 'invalid-lineage'
    | 'invalid-page-render-set'
    | 'invalid-mapping'
    | 'invalid-comparator'
    | 'invalid-budget'
    | 'invalid-repair'
    | 'duplicate-id'
  path: string
  message: string
}

export class ReconstructionAttemptTraceValidationError extends Error {
  constructor(public readonly issues: TraceValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'))
    this.name = 'ReconstructionAttemptTraceValidationError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Stable, locale-independent JSON used by all trace commitments. */
export function canonicalTraceJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Only finite numbers hash')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const expectedOwnKeys = new Set([
      'length',
      ...Array.from({ length: value.length }, (_, index) => String(index)),
    ])
    if (
      Reflect.ownKeys(value).some(
        (key) => typeof key !== 'string' || !expectedOwnKeys.has(key),
      ) ||
      Reflect.ownKeys(value).length !== expectedOwnKeys.size ||
      Array.from({ length: value.length }, (_, index) =>
        descriptors[String(index)],
      ).some((descriptor) => !descriptor?.enumerable || !('value' in descriptor))
    ) {
      throw new TypeError(
        'Arrays with holes or noncanonical own properties cannot be committed to a trace',
      )
    }
    return `[${Array.from({ length: value.length }, (_, index) =>
      canonicalTraceJson(descriptors[String(index)]!.value),
    ).join(',')}]`
  }
  if (isPlainObject(value)) {
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some((key) => typeof key !== 'string')) {
      throw new TypeError('Symbol keys cannot be committed to a trace')
    }
    const keys = ownKeys as string[]
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      keys.some((key) => {
        const descriptor = descriptors[key]
        return !descriptor?.enumerable || !('value' in descriptor)
      })
    ) {
      throw new TypeError(
        'Only enumerable data properties can be committed to a trace',
      )
    }
    return `{${keys
      .sort(compareCodeUnits)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalTraceJson(descriptors[key]!.value)}`,
      )
      .join(',')}}`
  }
  throw new TypeError('Only plain JSON values can be committed to a trace')
}

export function hashTraceValue(value: unknown) {
  return sha256HexSync(canonicalTraceJson(value))
}

export function encodeCanonicalObservationPayload(
  input: CanonicalObservationPayload,
) {
  const payload = canonicalObservationPayloadSchema.parse(input)
  const bytes = new TextEncoder().encode(canonicalTraceJson(payload))
  parseCanonicalObservationPayloadBytes(bytes)
  return bytes
}

export function parseCanonicalObservationPayloadBytes(bytes: Uint8Array) {
  let text: string
  let parsed: unknown
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    parsed = JSON.parse(text)
  } catch {
    throw new TypeError('INVALID_CANONICAL_OBSERVATION_PAYLOAD')
  }
  const payload = canonicalObservationPayloadSchema.parse(parsed)
  const sortedItems = [...payload.items].sort((left, right) =>
    compareCodeUnits(left.idSha256, right.idSha256),
  )
  if (
    text !== canonicalTraceJson(payload) ||
    new Set(payload.items.map(({ idSha256 }) => idSha256)).size !==
      payload.items.length ||
    hashTraceValue(payload.items) !== hashTraceValue(sortedItems) ||
    payload.items.some(
      ({ anchorIds }) =>
        new Set(anchorIds).size !== anchorIds.length ||
        anchorIds.some(
          (anchorId, index) =>
            index > 0 &&
            compareCodeUnits(anchorIds[index - 1]!, anchorId) >= 0,
        ),
    )
  ) {
    throw new TypeError('INVALID_CANONICAL_OBSERVATION_PAYLOAD')
  }
  return payload
}

export function hashSourceExpectedObservationSet(
  value: SourceExpectedObservationSet,
) {
  const { receiptSha256: _receiptSha256, ...projection } = value
  return hashTraceValue(projection)
}

export function hashRenderedActualObservationSet(
  value: RenderedActualObservationSet,
) {
  const { receiptSha256: _receiptSha256, ...projection } = value
  return hashTraceValue(projection)
}

export function hashSourceEvidenceReceipt(
  value: SourceEvidenceReceiptBinding,
) {
  const { receiptSha256: _receiptSha256, ...projection } = value
  return hashTraceValue(projection)
}

export function codexProviderIdentityProjection(
  value: ProviderReceiptBinding,
) {
  return {
    server: value.server ?? null,
    model: value.model ?? null,
    prompt: value.prompt ?? null,
    tool: value.tool ?? null,
  }
}

export function hashCodexProviderIdentity(value: ProviderReceiptBinding) {
  return hashTraceValue(codexProviderIdentityProjection(value))
}

/** Commit the exact downloadable EPUB bytes with the browser-safe hasher. */
export function hashEpubBytes(bytes: Uint8Array) {
  return sha256HexSync(bytes)
}

export function verifyEpubArtifactBytes(
  artifact: HashedArtifact,
  bytes: Uint8Array,
) {
  return (
    artifact.byteLength === bytes.byteLength &&
    artifact.sha256 === hashEpubBytes(bytes)
  )
}

/** Hash the complete renderer receipt independently of the EPUB byte hash. */
export function hashRenderedEpubEvidence(evidence: RenderedEpubEvidence) {
  const { receiptSha256: _receiptSha256, ...projection } = evidence
  return hashTraceValue(projection)
}

export function hashRepairProposal(
  proposal: Omit<CritiqueRepairBinding['proposal'], 'proposalSha256'>,
) {
  return hashTraceValue(proposal)
}

export function parseStructEvidencePatch(input: unknown): StructEvidencePatch {
  const proposal = structEvidencePatchSchema.parse(input)
  const { proposalSha256, ...projection } = proposal
  if (proposalSha256 !== hashTraceValue(projection)) {
    throw new TypeError('Repair proposal hash does not match its content.')
  }
  return proposal
}

export function hashAppliedRepairBinding(input: {
  proposalSha256: string
  baseStructSha256: string
  resultingStructSha256: string
  applicationReceiptSha256: string
  groundedVerifierReceiptSha256: string
}) {
  return hashTraceValue(input)
}

const DETERMINISTIC_CHECK_PRIORITY: Readonly<
  Record<DeterministicCheckId, number>
> = {
  'render-binding': 0,
  'epub-package': 1,
  'source-region-conservation': 2,
  figures: 3,
  diagrams: 4,
  captions: 5,
  'table-cells': 6,
  'table-spans': 7,
  'table-headers': 8,
  formulas: 9,
  'code-preformatted': 10,
  notes: 11,
  citations: 12,
  links: 13,
  'text-exactness': 14,
  'reading-order': 15,
  hierarchy: 16,
  'object-counts': 17,
  'asset-bytes': 18,
  clipping: 19,
  overflow: 20,
  'dangling-targets': 21,
}

function compareCodeUnits(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Stable order used to select the single first actionable cause. */
export function compareComparisonFailures(
  left: ComparisonFailure,
  right: ComparisonFailure,
) {
  // A judge can add a narrow failure but can never outrank deterministic
  // evidence, even when its semantic category has an earlier display order.
  if (left.origin !== right.origin)
    return left.origin === 'deterministic' ? -1 : 1
  const checkDifference =
    DETERMINISTIC_CHECK_PRIORITY[left.check] -
    DETERMINISTIC_CHECK_PRIORITY[right.check]
  if (checkDifference !== 0) return checkDifference
  const pageDifference =
    (left.source?.page ?? Number.MAX_SAFE_INTEGER) -
    (right.source?.page ?? Number.MAX_SAFE_INTEGER)
  if (pageDifference !== 0) return pageDifference
  const leftBox = left.source?.boxes[0]
  const rightBox = right.source?.boxes[0]
  const yDifference =
    (leftBox?.y ?? Number.MAX_SAFE_INTEGER) -
    (rightBox?.y ?? Number.MAX_SAFE_INTEGER)
  if (yDifference !== 0) return yDifference
  const xDifference =
    (leftBox?.x ?? Number.MAX_SAFE_INTEGER) -
    (rightBox?.x ?? Number.MAX_SAFE_INTEGER)
  if (xDifference !== 0) return xDifference
  return compareCodeUnits(left.id, right.id)
}

function uniqueIssues(
  values: readonly string[],
  path: string,
): TraceValidationIssue[] {
  const seen = new Set<string>()
  const duplicate = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value)
    seen.add(value)
  }
  return [...duplicate].sort().map((value) => ({
    code: 'duplicate-id' as const,
    path,
    message: `Duplicate id ${value}.`,
  }))
}

function isOwnerLocalTransport(transport: string) {
  if (transport.startsWith('unix://')) {
    const path = transport.slice('unix://'.length)
    return path.startsWith('/') && !path.includes('\0') && !path.split('/').includes('..')
  }
  try {
    const url = new URL(transport)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

function coreInvariantIssues(
  trace: ReconstructionAttemptTraceCore,
): TraceValidationIssue[] {
  const issues: TraceValidationIssue[] = []
  const sourceSha256 = trace.sourcePdf.artifact.sha256

  const renderedPages = trace.sourcePdf.pageRenders.map((render) => render.page)
  const expectedPages = Array.from(
    { length: trace.sourcePdf.pageCount },
    (_, index) => index + 1,
  )
  if (
    renderedPages.length !== expectedPages.length ||
    [...renderedPages]
      .sort((a, b) => a - b)
      .some((page, index) => page !== expectedPages[index])
  ) {
    issues.push({
      code: 'invalid-page-render-set',
      path: 'sourcePdf.pageRenders',
      message: 'Page renders must contain every source page exactly once.',
    })
  }
  for (const [index, render] of trace.sourcePdf.pageRenders.entries()) {
    if (render.sourcePdfSha256 !== sourceSha256) {
      issues.push({
        code: 'binding-mismatch',
        path: `sourcePdf.pageRenders.${index}.sourcePdfSha256`,
        message: 'Page render is not bound to the source PDF.',
      })
    }
  }

  const sourceBindings: Array<[string, string]> = [
    ['evidenceGraph.sourcePdfSha256', trace.evidenceGraph.sourcePdfSha256],
    [
      'sourceEvidence.sourcePdfSha256',
      trace.sourceEvidence.sourcePdfSha256,
    ],
    ['structure.sourcePdfSha256', trace.structure.sourcePdfSha256],
  ]
  for (const [path, actual] of sourceBindings) {
    if (actual !== sourceSha256) {
      issues.push({
        code: 'binding-mismatch',
        path,
        message: 'Artifact is not bound to the source PDF.',
      })
    }
  }
  if (
    trace.sourceEvidence.evidenceGraphSha256 !==
    trace.evidenceGraph.artifact.sha256
  ) {
    issues.push({
      code: 'binding-mismatch',
      path: 'sourceEvidence.evidenceGraphSha256',
      message: 'Source-evidence receipt is not bound to the evidence graph.',
    })
  }
  if (
    trace.sourceEvidence.candidateSetSha256 !==
    hashTraceValue(trace.evidenceCandidates)
  ) {
    issues.push({
      code: 'binding-mismatch',
      path: 'sourceEvidence.candidateSetSha256',
      message:
        'Source-evidence receipt is not bound to the provider-neutral candidate references.',
    })
  }
  if (
    trace.sourceEvidence.receiptSha256 !==
    hashSourceEvidenceReceipt(trace.sourceEvidence)
  ) {
    issues.push({
      code: 'hash-mismatch',
      path: 'sourceEvidence.receiptSha256',
      message: 'Source-evidence receipt hash does not match its content.',
    })
  }
  const expectedChecks = trace.sourceEvidence.expectedObservationSets.map(
    ({ check }) => check,
  )
  if (
    new Set(expectedChecks).size !== SOURCE_EPUB_OBSERVATION_CHECK_IDS.length ||
    SOURCE_EPUB_OBSERVATION_CHECK_IDS.some(
      (check) => !expectedChecks.includes(check),
    )
  ) {
    issues.push({
      code: 'invalid-comparator',
      path: 'sourceEvidence.expectedObservationSets',
      message:
        'Source evidence must commit exactly one expected set for every observation category.',
    })
  }
  const sourceRegionIds = new Set(
    trace.comparisonEvidence.sourceRegions.map(({ id }) => id),
  )
  for (const [index, expected] of
    trace.sourceEvidence.expectedObservationSets.entries()) {
    if (
      expected.receiptSha256 !== hashSourceExpectedObservationSet(expected) ||
      expected.setSha256 !== expected.payload.sha256 ||
      new Set(expected.sourceRegionIds).size !== expected.sourceRegionIds.length ||
      expected.sourceRegionIds.some((id) => !sourceRegionIds.has(id)) ||
      (expected.sourceRegionIds.length > 0 && expected.itemCount === 0)
    ) {
      issues.push({
        code: 'binding-mismatch',
        path: `sourceEvidence.expectedObservationSets.${index}`,
        message:
          'Expected category sets must be hash-bound to known source obligations and cannot self-attest zero items for source-bearing evidence.',
      })
    }
  }
  const actualChecks = trace.renderedEpub.actualObservationSets.map(
    ({ check }) => check,
  )
  if (
    new Set(actualChecks).size !== SOURCE_EPUB_OBSERVATION_CHECK_IDS.length ||
    SOURCE_EPUB_OBSERVATION_CHECK_IDS.some(
      (check) => !actualChecks.includes(check),
    )
  ) {
    issues.push({
      code: 'invalid-comparator',
      path: 'renderedEpub.actualObservationSets',
      message:
        'Actual renderer evidence must commit exactly one set for every observation category.',
    })
  }
  for (const [index, actual] of
    trace.renderedEpub.actualObservationSets.entries()) {
    if (
      actual.receiptSha256 !== hashRenderedActualObservationSet(actual) ||
      actual.setSha256 !== actual.payload.sha256
    ) {
      issues.push({
        code: 'hash-mismatch',
        path: `renderedEpub.actualObservationSets.${index}.receiptSha256`,
        message: 'Actual renderer category-set receipt is stale.',
      })
    }
  }
  if (trace.epub.structSha256 !== trace.structure.artifact.sha256) {
    issues.push({
      code: 'binding-mismatch',
      path: 'epub.structSha256',
      message: 'EPUB is not bound to this serialized STRUCT artifact.',
    })
  }
  if (trace.renderedEpub.epubSha256 !== trace.epub.bytes.sha256) {
    issues.push({
      code: 'binding-mismatch',
      path: 'renderedEpub.epubSha256',
      message: 'Rendered evidence is not from the exact EPUB bytes.',
    })
  }
  if (
    hashTraceValue(trace.renderedEpub.download.artifact) !==
      hashTraceValue(trace.epub.bytes) ||
    trace.renderedEpub.receiptSha256 !==
      hashRenderedEpubEvidence(trace.renderedEpub) ||
    trace.renderedEpub.sourceObligations.sourcePdfSha256 !== sourceSha256
  ) {
    issues.push({
      code: 'binding-mismatch',
      path: 'renderedEpub',
      message:
        'Actual-render receipt must bind the downloaded EPUB artifact, source obligations, and complete renderer observation.',
    })
  }

  if (trace.lineage.attemptIndex === 0) {
    if (
      trace.lineage.parentTraceSha256 !== null ||
      trace.lineage.immutablePriorTraceSha256 !== null ||
      trace.lineage.appliedRepair !== null ||
      trace.critiqueRepair !== null
    ) {
      issues.push({
        code: 'invalid-lineage',
        path: 'lineage',
        message: 'The first attempt cannot have a parent trace.',
      })
    }
  } else if (
    trace.lineage.parentTraceSha256 === null ||
    trace.lineage.immutablePriorTraceSha256 !==
      trace.lineage.parentTraceSha256 ||
    trace.lineage.appliedRepair === null ||
    trace.critiqueRepair === null
  ) {
    issues.push({
      code: 'invalid-lineage',
      path: 'lineage',
      message:
        'A refinement must name the same immutable parent trace in both lineage fields.',
    })
  }
  if (trace.lineage.appliedRepair) {
    const application = trace.lineage.appliedRepair
    if (
      application.resultingStructSha256 !== trace.structure.artifact.sha256 ||
      application.applicationSha256 !==
        hashAppliedRepairBinding({
          proposalSha256: application.proposalSha256,
          baseStructSha256: application.baseStructSha256,
          resultingStructSha256: application.resultingStructSha256,
          applicationReceiptSha256: application.applicationReceiptSha256,
          groundedVerifierReceiptSha256:
            application.groundedVerifierReceiptSha256,
        })
    ) {
      issues.push({
        code: 'invalid-lineage',
        path: 'lineage.appliedRepair',
        message:
          'Repair application must commit its parent, proposal, base STRUCT, and exact resulting STRUCT.',
      })
    }
  }

  issues.push(
    ...uniqueIssues(
      trace.evidenceCandidates.map((candidate) => candidate.referenceSha256),
      'evidenceCandidates',
    ),
    ...uniqueIssues(
      trace.structure.assets.map((asset) => asset.id),
      'structure.assets',
    ),
    ...uniqueIssues(
      trace.renderedEpub.domSnapshots.map((snapshot) => snapshot.spineHref),
      'renderedEpub.domSnapshots',
    ),
    ...uniqueIssues(
      trace.renderedEpub.screenshots.map((screenshot) => screenshot.id),
      'renderedEpub.screenshots',
    ),
    ...uniqueIssues(
      trace.mappings.map((mapping) => mapping.id),
      'mappings',
    ),
    ...uniqueIssues(
      trace.mappings.map((mapping) => mapping.obligationId),
      'mappings.obligationId',
    ),
    ...uniqueIssues(
      trace.comparisonEvidence.sourceRegions.map((region) => region.id),
      'comparisonEvidence.sourceRegions',
    ),
    ...uniqueIssues(
      trace.comparisonEvidence.observations.map(
        (observation) => observation.idSha256,
      ),
      'comparisonEvidence.observations',
    ),
    ...uniqueIssues(
      trace.providerReceipts.map((receipt) => receipt.id),
      'providerReceipts',
    ),
    ...uniqueIssues(
      trace.comparator.checkResults.map((result) => result.id),
      'comparator.checkResults',
    ),
    ...uniqueIssues(
      trace.comparator.failures.map((failure) => failure.id),
      'comparator.failures',
    ),
  )

  const requiredProviderRoles: ProviderReceiptBinding['role'][] = [
    'source-evidence',
    'actual-render',
    'owner-local-codex-reconciliation',
    ...(trace.critiqueRepair ? ['owner-local-codex-repair' as const] : []),
  ]
  const requiredReceipts = new Map<
    ProviderReceiptBinding['role'],
    ProviderReceiptBinding[]
  >(
    requiredProviderRoles.map((role) => [
      role,
      trace.providerReceipts.filter((receipt) => receipt.role === role),
    ] as const),
  )
  for (const role of requiredProviderRoles) {
    const receipts = requiredReceipts.get(role) ?? []
    if (receipts.length !== 1) {
      issues.push({
        code: receipts.length === 0 ? 'invalid-schema' : 'duplicate-id',
        path: 'providerReceipts',
        message: `Required provider role ${role} must appear exactly once.`,
      })
      continue
    }
    const receipt = receipts[0]!
    if (!receipt.required || !receipt.enabledBeforeRun) {
      issues.push({
        code: 'binding-mismatch',
        path: `providerReceipts.${receipt.id}`,
        message: `Required provider role ${role} must be enabled before the run.`,
      })
    }
  }
  for (const receipt of trace.providerReceipts) {
    if (receipt.role === 'optional') {
      if (receipt.required) {
        issues.push({
          code: 'binding-mismatch',
          path: `providerReceipts.${receipt.id}.required`,
          message: 'An optional provider arm cannot be marked required.',
        })
      }
      if (
        (!receipt.enabledBeforeRun && receipt.status !== 'disabled') ||
        (receipt.enabledBeforeRun && receipt.status === 'disabled')
      ) {
        issues.push({
          code: 'binding-mismatch',
          path: `providerReceipts.${receipt.id}.status`,
          message:
            'Optional provider status must preserve whether it was enabled before the run.',
        })
      }
    } else if (!receipt.required) {
      issues.push({
        code: 'binding-mismatch',
        path: `providerReceipts.${receipt.id}.required`,
        message: 'Core provider roles are required.',
      })
    }
  }
  const deterministicReceipt = requiredReceipts.get('source-evidence')?.[0]
  if (
    deterministicReceipt &&
    (deterministicReceipt.status !== 'succeeded' ||
      deterministicReceipt.inputSha256 !== sourceSha256 ||
      deterministicReceipt.outputSha256 !== trace.sourceEvidence.receiptSha256)
  ) {
    issues.push({
      code: 'binding-mismatch',
      path: `providerReceipts.${deterministicReceipt.id}`,
      message:
        'Source-evidence provider must bind the source PDF to its graph and candidate receipt.',
    })
  }
  const renderReceipt = requiredReceipts.get('actual-render')?.[0]
  const renderedEvidenceSha256 = hashRenderedEpubEvidence(trace.renderedEpub)
  if (
    renderReceipt &&
    (renderReceipt.status !== 'succeeded' ||
      renderReceipt.inputSha256 !== trace.epub.bytes.sha256 ||
      renderReceipt.outputSha256 !== renderedEvidenceSha256 ||
      trace.renderedEpub.receiptSha256 !== renderedEvidenceSha256)
  ) {
    issues.push({
      code: 'binding-mismatch',
      path: `providerReceipts.${renderReceipt.id}`,
      message:
        'Actual EPUB renderer must bind the exact EPUB bytes to its complete evidence receipt.',
    })
  }
  const codexReceipt = requiredReceipts.get(
    'owner-local-codex-reconciliation',
  )?.[0]
  const reconciliationInputSha256 = hashTraceValue({
    sourcePdfSha256: sourceSha256,
    evidenceGraphSha256: trace.evidenceGraph.artifact.sha256,
    candidateSetSha256: trace.sourceEvidence.candidateSetSha256,
    structSha256: trace.structure.artifact.sha256,
    epubSha256: trace.epub.bytes.sha256,
    renderObservationReceiptSha256: trace.renderedEpub.receiptSha256,
  })
  if (
    codexReceipt &&
    (codexReceipt.status !== 'succeeded' ||
      codexReceipt.inputSha256 !== reconciliationInputSha256 ||
      codexReceipt.outputSha256 !== hashTraceValue(trace.comparator))
  ) {
    issues.push({
      code: 'binding-mismatch',
      path: `providerReceipts.${codexReceipt.id}`,
      message:
        'Owner-local Codex reconciliation must succeed and bind the exact render input to the comparator result.',
    })
  }
  if (
    codexReceipt &&
    (!codexReceipt.server ||
      !codexReceipt.model ||
      !codexReceipt.prompt ||
      !codexReceipt.tool ||
      codexReceipt.identitySha256 !==
        hashCodexProviderIdentity(codexReceipt) ||
      !isOwnerLocalTransport(codexReceipt.server.transport))
  ) {
    issues.push({
      code: 'binding-mismatch',
      path: `providerReceipts.${codexReceipt.id}.server`,
      message:
        'Owner-local Codex requires an identified local server transport.',
    })
  }

  const doms = new Map(
    trace.renderedEpub.domSnapshots.map((snapshot) => [
      snapshot.spineHref,
      snapshot,
    ]),
  )
  const screenshots = new Map(
    trace.renderedEpub.screenshots.map((screenshot) => [
      screenshot.id,
      screenshot,
    ]),
  )
  for (const [mappingIndex, mapping] of trace.mappings.entries()) {
    if (mapping.source.page > trace.sourcePdf.pageCount) {
      issues.push({
        code: 'invalid-mapping',
        path: `mappings.${mappingIndex}.source.page`,
        message: 'Mapping page is outside the source PDF.',
      })
    }
    if (
      new Set(mapping.source.sourceRegionIds).size !==
      mapping.source.sourceRegionIds.length
    ) {
      issues.push({
        code: 'invalid-mapping',
        path: `mappings.${mappingIndex}.source.sourceRegionIds`,
        message: 'A mapping cannot repeat a source region id.',
      })
    }
    for (const [boxIndex, box] of mapping.source.boxes.entries()) {
      if (box.page !== mapping.source.page) {
        issues.push({
          code: 'invalid-mapping',
          path: `mappings.${mappingIndex}.source.boxes.${boxIndex}.page`,
          message: 'Every source box must be on the mapping source page.',
        })
      }
    }
    if (mapping.status === 'missing' && mapping.output.length !== 0) {
      issues.push({
        code: 'invalid-mapping',
        path: `mappings.${mappingIndex}.output`,
        message: 'A missing mapping cannot claim output locations.',
      })
    }
    if (mapping.status === 'mapped' && mapping.output.length !== 1) {
      issues.push({
        code: 'invalid-mapping',
        path: `mappings.${mappingIndex}.output`,
        message: 'A mapped obligation must have exactly one output location.',
      })
    }
    if (mapping.status === 'duplicate' && mapping.output.length < 2) {
      issues.push({
        code: 'invalid-mapping',
        path: `mappings.${mappingIndex}.output`,
        message:
          'A duplicate obligation must have at least two output locations.',
      })
    }
    for (const [outputIndex, output] of mapping.output.entries()) {
      if (!output.rendered) {
        issues.push({
          code: 'invalid-mapping',
          path: `mappings.${mappingIndex}.output.${outputIndex}.rendered`,
          message:
            'Every output locator must include hash-bound screenshot geometry.',
        })
      }
      const dom = doms.get(output.spineHref)
      if (!dom) {
        issues.push({
          code: 'invalid-mapping',
          path: `mappings.${mappingIndex}.output.${outputIndex}.spineHref`,
          message: 'Output location does not exist in rendered DOM evidence.',
        })
      }
      if (dom && !dom.anchors.includes(output.anchorId)) {
        issues.push({
          code: 'invalid-mapping',
          path: `mappings.${mappingIndex}.output.${outputIndex}.anchorId`,
          message: 'Output anchor does not exist in rendered DOM evidence.',
        })
      }
      if (output.rendered) {
        const screenshot = screenshots.get(output.rendered.screenshotId)
        if (!screenshot || screenshot.spineHref !== output.spineHref) {
          issues.push({
            code: 'invalid-mapping',
            path: `mappings.${mappingIndex}.output.${outputIndex}.rendered.screenshotId`,
            message:
              'Rendered locator must reference a screenshot of the same spine item.',
          })
        } else if (
          output.rendered.viewport.width !== screenshot.viewport.width ||
          output.rendered.viewport.height !== screenshot.viewport.height ||
          output.rendered.viewport.deviceScaleFactor !==
            screenshot.viewport.deviceScaleFactor
        ) {
          issues.push({
            code: 'invalid-mapping',
            path: `mappings.${mappingIndex}.output.${outputIndex}.rendered.viewport`,
            message: 'Rendered locator viewport does not match its screenshot.',
          })
        }
        const { rect, viewport } = output.rendered
        if (
          rect.x < 0 ||
          rect.y < 0 ||
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.x + rect.width > viewport.width ||
          rect.y + rect.height > viewport.height
        ) {
          issues.push({
            code: 'invalid-mapping',
            path: `mappings.${mappingIndex}.output.${outputIndex}.rendered.rect`,
            message:
              'Rendered locator must have positive area inside its screenshot viewport.',
          })
        }
      }
    }
  }

  const domHashes = new Map(
    trace.renderedEpub.domSnapshots.map((snapshot) => [
      snapshot.spineHref,
      snapshot.dom.sha256,
    ]),
  )
  for (const [index, screenshot] of trace.renderedEpub.screenshots.entries()) {
    if (screenshot.domSha256 !== domHashes.get(screenshot.spineHref)) {
      issues.push({
        code: 'binding-mismatch',
        path: `renderedEpub.screenshots.${index}.domSha256`,
        message: 'Screenshot is not bound to its rendered DOM snapshot.',
      })
    }
  }

  const sortedSourceRegions = [...trace.comparisonEvidence.sourceRegions].sort(
    (left, right) => compareCodeUnits(left.id, right.id),
  )
  const sourceObligationProjection = {
    sourcePdfSha256: sourceSha256,
    obligationsSha256: hashTraceValue(sortedSourceRegions),
    obligationCount: sortedSourceRegions.length,
  }
  const sourceObligationReceiptSha256 = hashTraceValue(
    sourceObligationProjection,
  )
  if (
    trace.sourceEvidence.sourceObligations.obligationsSha256 !==
      sourceObligationProjection.obligationsSha256 ||
    trace.sourceEvidence.sourceObligations.obligationCount !==
      sourceObligationProjection.obligationCount ||
    trace.sourceEvidence.sourceObligations.receiptSha256 !==
      sourceObligationReceiptSha256 ||
    trace.renderedEpub.sourceObligations.obligationsSha256 !==
      sourceObligationProjection.obligationsSha256 ||
    trace.renderedEpub.sourceObligations.obligationCount !==
      sourceObligationProjection.obligationCount ||
    trace.renderedEpub.sourceObligations.receiptSha256 !==
      sourceObligationReceiptSha256
  ) {
    issues.push({
      code: 'binding-mismatch',
      path: 'comparisonEvidence.sourceRegions',
      message:
        'Private comparison evidence must match the authoritative source-evidence obligation receipt and renderer copy.',
    })
  }
  const expectedSets = new Map(
    trace.sourceEvidence.expectedObservationSets.map((set) => [set.check, set]),
  )
  const actualSets = new Map(
    trace.renderedEpub.actualObservationSets.map((set) => [set.check, set]),
  )
  for (const [index, observation] of trace.comparisonEvidence.observations.entries()) {
    const { receiptSha256, ...core } = observation
    if (
      receiptSha256 !== hashTraceValue(core) ||
      observation.expectedSetReceiptSha256 !==
        expectedSets.get(observation.check)?.receiptSha256 ||
      observation.actualSetReceiptSha256 !==
        actualSets.get(observation.check)?.receiptSha256
    ) {
      issues.push({
        code: 'binding-mismatch',
        path: `comparisonEvidence.observations.${index}`,
        message:
          'Observation must select the authoritative source-expected and renderer-actual category receipts.',
      })
    }
  }

  const comparator = trace.comparator
  const comparatorBindings: Array<[string, string, string]> = [
    ['sourcePdfSha256', comparator.sourcePdfSha256, sourceSha256],
    ['structSha256', comparator.structSha256, trace.structure.artifact.sha256],
    ['epubSha256', comparator.epubSha256, trace.epub.bytes.sha256],
    [
      'renderObservationReceiptSha256',
      comparator.renderObservationReceiptSha256,
      trace.renderedEpub.receiptSha256,
    ],
  ]
  for (const [field, actual, expected] of comparatorBindings) {
    if (actual !== expected) {
      issues.push({
        code: 'binding-mismatch',
        path: `comparator.${field}`,
        message: 'Comparator result is stale for this attempt.',
      })
    }
  }
  const expectedObservationSetSha256 = hashTraceValue(
    [...trace.comparisonEvidence.observations].sort((left, right) =>
      compareCodeUnits(left.idSha256, right.idSha256),
    ),
  )
  if (comparator.observationSetSha256 !== expectedObservationSetSha256) {
    issues.push({
      code: 'binding-mismatch',
      path: 'comparator.observationSetSha256',
      message: 'Comparator is not bound to the private observation receipt set.',
    })
  }
  if (
    comparator.denominator !== comparator.checkResults.length ||
    comparator.passed !==
      comparator.checkResults.filter((result) => result.status === 'passed')
        .length ||
    comparator.failed !==
      comparator.checkResults.filter((result) => result.status === 'failed')
        .length ||
    comparator.denominator !== comparator.passed + comparator.failed
  ) {
    issues.push({
      code: 'invalid-comparator',
      path: 'comparator',
      message: 'Comparator totals do not match its check results.',
    })
  }

  const evaluatedChecks = new Set(
    comparator.checkResults
      .filter((result) => result.origin === 'deterministic')
      .map((result) => result.check),
  )
  if (DETERMINISTIC_CHECK_IDS.some((check) => !evaluatedChecks.has(check))) {
    issues.push({
      code: 'invalid-comparator',
      path: 'comparator.checkResults',
      message: 'Comparator omitted a required deterministic check category.',
    })
  }

  const failureById = new Map(
    comparator.failures.map((failure) => [failure.id, failure]),
  )
  for (const result of comparator.checkResults) {
    if (
      (result.status === 'passed' && result.failureId !== undefined) ||
      (result.status === 'failed' &&
        (!result.failureId || !failureById.has(result.failureId)))
    ) {
      issues.push({
        code: 'invalid-comparator',
        path: `comparator.checkResults.${result.id}`,
        message: 'Failed checks and failure records must reference each other.',
      })
    }
    if (
      result.origin === 'deterministic' &&
      result.status === 'passed' &&
      result.check !== 'render-binding' &&
      result.check !== 'epub-package' &&
      result.check !== 'source-region-conservation' &&
      (result.mappingIds.length === 0 ||
        result.mappingIds.some((id) => {
          const mapping = trace.mappings.find(
            (candidate) => candidate.id === id,
          )
          return (
            !mapping ||
            mapping.status !== 'mapped' ||
            mapping.output.length !== 1
          )
        }))
    ) {
      issues.push({
        code: 'invalid-comparator',
        path: `comparator.checkResults.${result.id}.mappingIds`,
        message:
          'A passing semantic observation requires known one-to-one mapping evidence.',
      })
    }
  }
  for (const result of comparator.checkResults) {
    if (
      result.origin !== 'deterministic' ||
      result.judgeResultId !== undefined
    ) {
      issues.push({
        code: 'invalid-comparator',
        path: `comparator.checkResults.${result.id}.origin`,
        message:
          'Interpretive judges cannot enter the core trace until their separately calibrated contract is enabled.',
      })
    }
  }
  const referencedFailureIds = new Set(
    comparator.checkResults.flatMap((result) =>
      result.failureId ? [result.failureId] : [],
    ),
  )
  for (const failure of comparator.failures) {
    const citedMappings = failure.mappingIds.map((id) =>
      trace.mappings.find((mapping) => mapping.id === id),
    )
    if (
      failure.mappingIds.length === 0 ||
      !failure.source ||
      citedMappings.some((mapping) => !mapping) ||
      !citedMappings.some(
        (mapping) =>
          mapping &&
          hashTraceValue(mapping.source) === hashTraceValue(failure.source),
      )
    ) {
      issues.push({
        code: 'invalid-comparator',
        path: `comparator.failures.${failure.id}`,
        message:
          'Every failure must cite a known mapping and source location for browser navigation.',
      })
    }
  }
  if (
    comparator.failures.some((failure) => !referencedFailureIds.has(failure.id))
  ) {
    issues.push({
      code: 'invalid-comparator',
      path: 'comparator.failures',
      message: 'Every failure must be referenced by a failed check.',
    })
  }
  if (comparator.failures.length !== comparator.failed) {
    issues.push({
      code: 'invalid-comparator',
      path: 'comparator.failures',
      message: 'Every failed check must have exactly one failure record.',
    })
  }
  if (comparator.status === 'publication-ready') {
    if (
      comparator.failed !== 0 ||
      comparator.failures.length !== 0 ||
      comparator.firstCauseFailureId !== null ||
      trace.epub.epubCheck.status !== 'passed' ||
      trace.epub.epubCheck.errorCount !== 0 ||
      trace.epub.epubCheck.warningCount !== 0 ||
      [...requiredReceipts.values()].some(
        ([receipt]) =>
          !receipt || receipt.status !== 'succeeded',
      )
    ) {
      issues.push({
        code: 'invalid-comparator',
        path: 'comparator.status',
        message:
          'Publication-ready requires every check and EPUBCheck to pass.',
      })
    }
  } else if (
    comparator.failed === 0 ||
    comparator.failures.length === 0 ||
    comparator.firstCauseFailureId === null ||
    !failureById.has(comparator.firstCauseFailureId)
  ) {
    issues.push({
      code: 'invalid-comparator',
      path: 'comparator.firstCauseFailureId',
      message: 'A failed comparison requires a valid first cause.',
    })
  }
  if (
    comparator.firstCauseFailureId !== null &&
    [...comparator.failures].sort(compareComparisonFailures)[0]?.id !==
      comparator.firstCauseFailureId
  ) {
    issues.push({
      code: 'invalid-comparator',
      path: 'comparator.firstCauseFailureId',
      message: 'First cause is not the deterministic earliest failure.',
    })
  }
  if (trace.terminalState !== comparator.status) {
    issues.push({
      code: 'invalid-comparator',
      path: 'terminalState',
      message: 'Only the comparator may declare publication-ready.',
    })
  }

  const { policy, usage } = trace.budget
  if (
    usage.refinements > policy.maxRefinements ||
    usage.freshTasks > policy.maxFreshTasks ||
    usage.tokens > policy.maxTokens ||
    usage.durationMs > policy.maxDurationMs ||
    usage.refinements !== trace.lineage.attemptIndex
  ) {
    issues.push({
      code: 'invalid-budget',
      path: 'budget',
      message: 'Attempt usage exceeds its frozen policy or lineage index.',
    })
  }

  if (trace.critiqueRepair) {
    const repair = trace.critiqueRepair
    const receipt = trace.providerReceipts.find(
      (candidate) => candidate.id === repair.providerReceiptId,
    )
    const candidateIds = new Set(
      trace.evidenceCandidates.map((candidate) => candidate.referenceSha256),
    )
    const hasUnknownEvidenceCandidate = repair.proposal.operations.some(
      (operation) =>
        !candidateIds.has(operation.candidateReferenceSha256),
    )
    const { proposalSha256, ...proposalProjection } = repair.proposal
    const application = trace.lineage.appliedRepair
    if (
      repair.disposition !== 'verified' ||
      repair.proposal.documentId !== trace.structure.documentId ||
      repair.proposal.sourcePdfSha256 !== sourceSha256 ||
      repair.proposal.sourceEvidenceGraphSha256 !==
        trace.evidenceGraph.artifact.sha256 ||
      repair.proposal.priorTraceSha256 !== trace.lineage.parentTraceSha256 ||
      repair.proposal.baseStructSha256 !== application?.baseStructSha256 ||
      repair.proposal.proposalSha256 !== application?.proposalSha256 ||
      repair.proposal.proposalSha256 !==
        hashRepairProposal(proposalProjection) ||
      !receipt ||
      receipt.role !== 'owner-local-codex-repair' ||
      receipt.status !== 'succeeded' ||
      !receipt.server ||
      !receipt.model ||
      !receipt.prompt ||
      !receipt.tool ||
      receipt.identitySha256 !== hashCodexProviderIdentity(receipt) ||
      receipt.identitySha256 !== codexReceipt?.identitySha256 ||
      receipt.inputSha256 !== repair.priorComparatorSha256 ||
      receipt.outputSha256 !== repair.proposal.proposalSha256 ||
      hasUnknownEvidenceCandidate
    ) {
      issues.push({
        code: 'invalid-repair',
        path: 'critiqueRepair',
        message:
          'Child repair must be a verified driver-compatible Codex patch bound to its parent, evidence, and applied STRUCT.',
      })
    }
  }

  return issues
}

function schemaIssues(error: z.ZodError): TraceValidationIssue[] {
  return error.issues.map((issue) => ({
    code: 'invalid-schema',
    path: issue.path.join('.') || 'trace',
    message: issue.message,
  }))
}

export function validateReconstructionAttemptTrace(
  input: unknown,
): TraceValidationIssue[] {
  const parsed = traceSchema.safeParse(input)
  if (!parsed.success) return schemaIssues(parsed.error)
  const issues = coreInvariantIssues(parsed.data)
  const expectedTraceSha256 = hashReconstructionAttemptTrace(parsed.data)
  if (parsed.data.traceSha256 !== expectedTraceSha256) {
    issues.push({
      code: 'hash-mismatch',
      path: 'traceSha256',
      message: 'Trace hash does not match its canonical content.',
    })
  }
  return issues
}

export function parseReconstructionAttemptTrace(
  input: unknown,
): ReconstructionAttemptTrace {
  const parsed = traceSchema.safeParse(input)
  if (!parsed.success) {
    throw new ReconstructionAttemptTraceValidationError(
      schemaIssues(parsed.error),
    )
  }
  const issues = validateReconstructionAttemptTrace(parsed.data)
  if (issues.length > 0) {
    throw new ReconstructionAttemptTraceValidationError(issues)
  }
  return parsed.data
}

export function hashReconstructionAttemptTrace(
  input: ReconstructionAttemptTrace | ReconstructionAttemptTraceCore,
) {
  const { traceSha256: _traceSha256, ...candidateCore } = input as
    | ReconstructionAttemptTrace
    | (ReconstructionAttemptTraceCore & { traceSha256?: string })
  const core = traceCoreSchema.parse(candidateCore)
  return hashTraceValue(core)
}

export function createReconstructionAttemptTrace(
  input: ReconstructionAttemptTraceCore,
): ReconstructionAttemptTrace {
  const core = traceCoreSchema.parse(input)
  const issues = coreInvariantIssues(core)
  if (issues.length > 0) {
    throw new ReconstructionAttemptTraceValidationError(issues)
  }
  return parseReconstructionAttemptTrace({
    ...core,
    traceSha256: hashReconstructionAttemptTrace(core),
  })
}

export function serializeReconstructionAttemptTrace(
  trace: ReconstructionAttemptTrace,
) {
  return canonicalTraceJson(parseReconstructionAttemptTrace(trace))
}

function providerIdentityProjection(
  trace: ReconstructionAttemptTrace,
  role: ProviderReceiptBinding['role'],
) {
  const receipt = trace.providerReceipts.find(
    (candidate) => candidate.role === role,
  )
  if (!receipt) return null
  return {
    role: receipt.role,
    required: receipt.required,
    enabledBeforeRun: receipt.enabledBeforeRun,
    providerId: receipt.providerId,
    identitySha256: receipt.identitySha256 ?? null,
    prompt: receipt.prompt ?? null,
    tool: receipt.tool ?? null,
    model: receipt.model ?? null,
    server: receipt.server ?? null,
  }
}

function executionIdentityProjection(trace: ReconstructionAttemptTrace) {
  const requiredRoles: ProviderReceiptBinding['role'][] = [
    'source-evidence',
    'actual-render',
    'owner-local-codex-reconciliation',
  ]
  return {
    providers: requiredRoles.map((role) =>
      providerIdentityProjection(trace, role),
    ),
    renderer: trace.renderedEpub.renderer,
    epubCheck: {
      toolId: trace.epub.epubCheck.toolId,
      toolVersion: trace.epub.epubCheck.toolVersion,
    },
  }
}

/**
 * Validate deterministic resume/replay across the complete ordered history.
 * A child cannot establish this property by naming an arbitrary parent hash;
 * callers must retain and validate every immutable prior trace.
 */
export function validateReconstructionAttemptTraceLineage(
  input: readonly unknown[],
): TraceValidationIssue[] {
  if (input.length === 0) {
    return [
      {
        code: 'invalid-lineage',
        path: 'traces',
        message: 'A replay lineage must contain at least one attempt.',
      },
    ]
  }

  const issues: TraceValidationIssue[] = []
  const traces: Array<ReconstructionAttemptTrace | undefined> = input.map(
    (candidate, index) => {
      const parsed = traceSchema.safeParse(candidate)
      if (!parsed.success) {
        issues.push(
          ...schemaIssues(parsed.error).map((issue) => ({
            ...issue,
            path: `traces.${index}.${issue.path}`,
          })),
        )
        return undefined
      }
      issues.push(
        ...validateReconstructionAttemptTrace(parsed.data).map((issue) => ({
          ...issue,
          path: `traces.${index}.${issue.path}`,
        })),
      )
      return parsed.data
    },
  )

  const first = traces[0]
  if (!first) return issues
  const frozenSourceSha256 = hashTraceValue(first.sourcePdf)
  const frozenEvidenceSha256 = hashTraceValue({
    evidenceGraph: first.evidenceGraph,
    sourceEvidence: first.sourceEvidence,
    evidenceCandidates: first.evidenceCandidates,
  })
  const frozenPolicySha256 = hashTraceValue(first.budget.policy)
  const frozenExecutionIdentitySha256 = hashTraceValue(
    executionIdentityProjection(first),
  )
  const documentId = first.structure.documentId
  const seenAttemptIds = new Set<string>()

  for (const [index, trace] of traces.entries()) {
    if (!trace) continue
    if (seenAttemptIds.has(trace.attemptId)) {
      issues.push({
        code: 'duplicate-id',
        path: `traces.${index}.attemptId`,
        message: 'Attempt ids must be unique across a replay lineage.',
      })
    }
    seenAttemptIds.add(trace.attemptId)

    if (trace.lineage.attemptIndex !== index) {
      issues.push({
        code: 'invalid-lineage',
        path: `traces.${index}.lineage.attemptIndex`,
        message: 'Attempt indexes must be contiguous and ordered from zero.',
      })
    }
    const previous = index > 0 ? traces[index - 1] : undefined
    const expectedParentSha256 = previous?.traceSha256 ?? null
    if (
      trace.lineage.parentTraceSha256 !== expectedParentSha256 ||
      trace.lineage.immutablePriorTraceSha256 !== expectedParentSha256
    ) {
      issues.push({
        code: 'invalid-lineage',
        path: `traces.${index}.lineage`,
        message:
          'Parent and immutable-prior hashes must name the immediately preceding trace.',
      })
    }
    if (previous) {
      const application = trace.lineage.appliedRepair
      const repair = trace.critiqueRepair
      if (
        previous.terminalState !== 'failed' ||
        !application ||
        !repair ||
        repair.priorComparatorSha256 !== hashTraceValue(previous.comparator) ||
        repair.priorFirstCauseFailureId !==
          previous.comparator.firstCauseFailureId ||
        repair.proposal.priorTraceSha256 !== previous.traceSha256 ||
        repair.proposal.baseStructSha256 !==
          previous.structure.artifact.sha256 ||
        application.proposalSha256 !== repair.proposal.proposalSha256 ||
        application.baseStructSha256 !== previous.structure.artifact.sha256 ||
        application.resultingStructSha256 !== trace.structure.artifact.sha256 ||
        application.resultingStructSha256 === application.baseStructSha256
      ) {
        issues.push({
          code: 'invalid-lineage',
          path: `traces.${index}.lineage.appliedRepair`,
          message:
            'A child requires its verified proposal for the exact failed parent comparator to produce a changed STRUCT.',
        })
      }
    }
    if (
      hashTraceValue(trace.sourcePdf) !== frozenSourceSha256 ||
      trace.structure.documentId !== documentId
    ) {
      issues.push({
        code: 'invalid-lineage',
        path: `traces.${index}.sourcePdf`,
        message: 'Source identity changed during replay.',
      })
    }
    if (
      hashTraceValue({
        evidenceGraph: trace.evidenceGraph,
        sourceEvidence: trace.sourceEvidence,
        evidenceCandidates: trace.evidenceCandidates,
      }) !== frozenEvidenceSha256
    ) {
      issues.push({
        code: 'invalid-lineage',
        path: `traces.${index}.evidenceGraph`,
        message: 'Extraction evidence changed during replay.',
      })
    }
    if (hashTraceValue(trace.budget.policy) !== frozenPolicySha256) {
      issues.push({
        code: 'invalid-lineage',
        path: `traces.${index}.budget.policy`,
        message: 'The refinement policy changed during replay.',
      })
    }
    if (
      hashTraceValue(executionIdentityProjection(trace)) !==
      frozenExecutionIdentitySha256
    ) {
      issues.push({
        code: 'invalid-lineage',
        path: `traces.${index}.providerReceipts`,
        message:
          'Required provider, tool, renderer, EPUBCheck, model, server, or prompt identity changed during replay.',
      })
    }
    if (
      previous &&
      (trace.budget.usage.freshTasks < previous.budget.usage.freshTasks ||
        trace.budget.usage.tokens < previous.budget.usage.tokens ||
        trace.budget.usage.durationMs < previous.budget.usage.durationMs)
    ) {
      issues.push({
        code: 'invalid-lineage',
        path: `traces.${index}.budget.usage`,
        message: 'Replay usage counters cannot move backwards.',
      })
    }
  }
  return issues
}

export function parseReconstructionAttemptTraceLineage(
  input: readonly unknown[],
): ReconstructionAttemptTrace[] {
  const issues = validateReconstructionAttemptTraceLineage(input)
  if (issues.length > 0) {
    throw new ReconstructionAttemptTraceValidationError(issues)
  }
  return input.map((trace) => parseReconstructionAttemptTrace(trace))
}

const reconstructionAttemptRefinementTraceBindingSchema = z
  .object({
    traceSha256: sha256Schema,
    sourcePdfSha256: sha256Schema,
    sourceEvidenceGraphSha256: sha256Schema,
    canonicalStructSha256: sha256Schema,
    attemptIndex: nonNegativeIntegerSchema,
    parentTraceSha256: sha256Schema.nullable(),
    terminalStatus: z.enum(['publication-ready', 'failed']),
    firstCause: z
      .object({
        failureReferenceSha256: sha256Schema,
        code: z.enum(DETERMINISTIC_CHECK_IDS),
      })
      .strict()
      .nullable(),
    evidenceCandidateReferences: z.array(sha256Schema).min(1),
    policy: budgetSchema.shape.policy,
    usage: budgetSchema.shape.usage,
  })
  .strict()

/** Public, allowlisted receipt projection; it never contains source text or bytes. */
export type ReconstructionAttemptRefinementTraceBinding = z.infer<
  typeof reconstructionAttemptRefinementTraceBindingSchema
>

export function parseReconstructionAttemptRefinementTraceBinding(
  input: unknown,
): ReconstructionAttemptRefinementTraceBinding {
  return reconstructionAttemptRefinementTraceBindingSchema.parse(input)
}

/** Validate the public projection without requiring private owner-local payloads. */
export function validateReconstructionAttemptRefinementTraceBindingLineage(
  input: readonly unknown[],
) {
  const parsed = input.map((value) =>
    reconstructionAttemptRefinementTraceBindingSchema.safeParse(value),
  )
  if (parsed.length === 0 || parsed.some((result) => !result.success)) {
    return false
  }
  const bindings = parsed.flatMap((result) =>
    result.success ? [result.data] : [],
  )
  const first = bindings[0]!
  const policySha256 = hashTraceValue(first.policy)
  for (const [index, binding] of bindings.entries()) {
    const previous = bindings[index - 1]
    if (
      binding.attemptIndex !== index ||
      binding.parentTraceSha256 !== (previous?.traceSha256 ?? null) ||
      binding.sourcePdfSha256 !== first.sourcePdfSha256 ||
      binding.sourceEvidenceGraphSha256 !==
        first.sourceEvidenceGraphSha256 ||
      hashTraceValue(binding.policy) !== policySha256 ||
      new Set(binding.evidenceCandidateReferences).size !==
        binding.evidenceCandidateReferences.length ||
      (binding.terminalStatus === 'publication-ready') !==
        (binding.firstCause === null) ||
      binding.usage.refinements > binding.policy.maxRefinements ||
      binding.usage.refinements !== binding.attemptIndex ||
      binding.usage.freshTasks > binding.policy.maxFreshTasks ||
      binding.usage.tokens > binding.policy.maxTokens ||
      binding.usage.durationMs > binding.policy.maxDurationMs ||
      (previous !== undefined &&
        (binding.usage.refinements < previous.usage.refinements ||
          binding.usage.freshTasks < previous.usage.freshTasks ||
          binding.usage.tokens < previous.usage.tokens ||
          binding.usage.durationMs < previous.usage.durationMs))
    ) {
      return false
    }
  }
  return true
}

/** Bind the generic bounded-refinement loop to one fully verified trace. */
export function toRefinementTraceBinding(
  input: unknown,
): ReconstructionAttemptRefinementTraceBinding {
  const trace = parseReconstructionAttemptTrace(input)
  const firstCause = trace.comparator.firstCauseFailureId
    ? trace.comparator.failures.find(
        (failure) => failure.id === trace.comparator.firstCauseFailureId,
      )
    : undefined
  return parseReconstructionAttemptRefinementTraceBinding({
    traceSha256: trace.traceSha256,
    sourcePdfSha256: trace.sourcePdf.artifact.sha256,
    sourceEvidenceGraphSha256: trace.evidenceGraph.artifact.sha256,
    canonicalStructSha256: trace.structure.artifact.sha256,
    attemptIndex: trace.lineage.attemptIndex,
    parentTraceSha256: trace.lineage.parentTraceSha256,
    terminalStatus: trace.terminalState,
    firstCause: firstCause
      ? {
          failureReferenceSha256: hashTraceValue({
            kind: 'first-cause',
            failureId: firstCause.id,
          }),
          code: firstCause.check,
        }
      : null,
    evidenceCandidateReferences: trace.evidenceCandidates
      .map((candidate) => candidate.referenceSha256)
      .sort(compareCodeUnits),
    policy: trace.budget.policy,
    usage: trace.budget.usage,
  })
}

export function assertSha256(value: string, label = 'sha256') {
  if (!sha256Schema.safeParse(value).success) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`)
  }
}

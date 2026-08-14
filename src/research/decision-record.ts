import { z } from 'zod'
import type {
  HumanAdjudicationRecord,
  PdfCandidateResolutionOrigin,
  PdfReconstruction,
  ReconstructionDiagnostic,
} from './import-types'
import {
  equationTranscriptDecisionBinding,
  OWNER_EQUATION_TRANSCRIPT_EVIDENCE,
} from './equation-transcript-adjudication'
import { assessPdfCompleteness } from './pdf-quality'
import { MAX_CITATION_TARGETS_PER_RELATIONSHIP } from './pdf-citation-surface'
import {
  buildPdfLineJoinReviewContext,
  replayPdfRegionLineRanges,
} from './pdf-lines'
import {
  materializeCanonicalVisualNode,
  visualCanonicalNodeId,
} from './pdf-layout'
import { rebindModelConsultationReceipt } from './model-consultation-binding'
import {
  pdfVisualMatchCandidateId,
  VISUAL_MATCH_DECISION_SCHEMA_VERSION,
} from './pdf-visuals'
import { sha256HexSync } from './sha256-sync'

export {
  equationTranscriptDecisionBinding,
  type EquationTranscriptDecisionBinding,
} from './equation-transcript-adjudication'
export type { PdfCandidateResolutionOrigin } from './import-types'

export const HUMAN_DECISION_SCHEMA_VERSION =
  VISUAL_MATCH_DECISION_SCHEMA_VERSION
const LEGACY_HUMAN_DECISION_SCHEMA_VERSION = '1.0.0' as const
const LINE_JOIN_HUMAN_DECISION_SCHEMA_VERSION = '1.1.0' as const
const EQUATION_HUMAN_DECISION_SCHEMA_VERSION = '1.2.0' as const
export const MAX_HUMAN_DECISION_FILE_BYTES = 1024 * 1024
export const MAX_EQUATION_TRANSCRIPT_LENGTH = 8192
const MAX_HUMAN_DECISIONS = 1000
const MAX_TARGET_REGION_IDS = 10_000
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const stableIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_.:-]+$/)

const diagnosticCodeSchema = z.enum([
  'OCR_REQUIRED',
  'MIXED_PAGE',
  'REPEATED_MARGIN_TEXT',
  'FURNITURE_REVIEW_REQUIRED',
  'FURNITURE_CONTAMINATION',
  'LOW_CONFIDENCE_BLOCK',
  'RESOLVED_READING_ORDER',
  'AMBIGUOUS_READING_ORDER',
  'READING_ORDER_CYCLE',
  'AMBIGUOUS_NOTE_MATCH',
  'UNRESOLVED_NOTE_REFERENCE',
  'UNREFERENCED_NOTE',
  'UNRESOLVED_CORRUPTING_JOIN',
  'FURNITURE_REVIEW_REQUIRED',
  'FURNITURE_CONTAMINATION',
  'UNRESOLVED_EQUATION_TRANSCRIPT',
  'AMBIGUOUS_VISUAL_MATCH',
  'UNRESOLVED_VISUAL_OBJECT',
  'NO_RECONSTRUCTABLE_TEXT',
  'INCOMPLETE_TEXT_COVERAGE',
  'INCOMPLETE_ASSET_COVERAGE',
  'INCOMPLETE_RELATIONSHIP_COVERAGE',
  'INCOMPLETE_SEMANTIC_TABLE_COVERAGE',
  'UNRESOLVED_SEMANTIC_OBJECTS',
  'STALE_HUMAN_DECISION',
])

const targetSchema = z
  .object({
    regionIds: z.array(stableIdSchema).min(1).max(MAX_TARGET_REGION_IDS),
    markerId: stableIdSchema.nullable(),
  })
  .strict()
  .refine(
    (target) => new Set(target.regionIds).size === target.regionIds.length,
    {
      message: 'Diagnostic target region identifiers must be unique.',
      path: ['regionIds'],
    },
  )

const resolutionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('accept-note-match'),
      targetNoteId: stableIdSchema,
      targetRegionId: stableIdSchema,
    })
    .strict(),
  z.object({ type: z.literal('reclassify-citation') }).strict(),
  z.object({ type: z.literal('reclassify-plain-text') }).strict(),
  z
    .object({
      type: z.literal('accept-reading-order'),
      regionIds: z.array(stableIdSchema).min(1).max(MAX_TARGET_REGION_IDS),
    })
    .strict(),
  z
    .object({
      type: z.literal('resolve-line-join'),
      transition: z
        .object({
          id: stableIdSchema,
          regionId: stableIdSchema,
          fromLineId: stableIdSchema,
          toLineId: stableIdSchema,
        })
        .strict(),
      outcome: z.enum([
        'remove-wrap-hyphen',
        'preserve-authored-hyphen',
        'leave-unresolved',
      ]),
      confidence: z.literal(1),
      evidence: z.tuple([
        z.literal('bounded-source-context'),
        z.literal('owner-local-adjudication'),
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal('accept-equation-transcript'),
      relationshipId: stableIdSchema,
      relationshipFingerprintSha256: sha256Schema,
      sourceCropAssetId: stableIdSchema,
      sourceCropAssetSha256: sha256Schema,
      format: z.literal('latex'),
      transcript: z
        .string()
        .min(1)
        .max(MAX_EQUATION_TRANSCRIPT_LENGTH)
        .refine((value) => value.trim().length > 0, {
          message: 'Equation transcripts must contain non-whitespace text.',
        })
        .refine((value) => !value.includes('\u0000'), {
          message: 'Equation transcripts may not contain NUL characters.',
        }),
      confidence: z.literal(1),
      evidence: z.tuple([
        z.literal('exact-source-page-crop'),
        z.literal('owner-local-adjudication'),
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal('accept-visual-match'),
      relationshipId: stableIdSchema,
      candidateId: stableIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('accept-visual-fallback'),
      relationshipId: stableIdSchema,
      candidateId: stableIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('classify-visual-decoration'),
      relationshipId: stableIdSchema,
      sourceObjectIds: z
        .array(stableIdSchema)
        .min(1)
        .max(MAX_TARGET_REGION_IDS),
      reason: z.enum([
        'page-furniture',
        'separator-rule',
        'decorative-ornament',
        'background',
      ]),
    })
    .strict(),
  z.object({ type: z.literal('dismiss') }).strict(),
])

export const humanAdjudicationRecordSchema = z
  .object({
    diagnosticCode: diagnosticCodeSchema,
    target: targetSchema,
    resolution: resolutionSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.resolution.type === 'resolve-line-join') {
      const transition = decision.resolution.transition
      if (decision.diagnosticCode !== 'UNRESOLVED_CORRUPTING_JOIN') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['diagnosticCode'],
          message:
            'Line-join resolutions apply only to unresolved corrupting joins.',
        })
      }
      if (
        decision.target.markerId !== transition.id ||
        decision.target.regionIds.length !== 1 ||
        decision.target.regionIds[0] !== transition.regionId
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['target'],
          message:
            'Line-join targets must exactly match the transition and region identity.',
        })
      }
    } else if (decision.resolution.type === 'accept-equation-transcript') {
      if (decision.diagnosticCode !== 'UNRESOLVED_EQUATION_TRANSCRIPT') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['diagnosticCode'],
          message:
            'Equation transcript resolutions apply only to unresolved equation transcripts.',
        })
      }
      if (
        decision.target.markerId !== decision.resolution.relationshipId ||
        decision.target.regionIds.length === 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['target'],
          message:
            'Equation transcript targets must identify the exact visual relationship and its source regions.',
        })
      }
    } else if (
      decision.resolution.type === 'accept-visual-match' ||
      decision.resolution.type === 'accept-visual-fallback' ||
      decision.resolution.type === 'classify-visual-decoration'
    ) {
      if (
        decision.diagnosticCode !== 'AMBIGUOUS_VISUAL_MATCH' &&
        decision.diagnosticCode !== 'UNRESOLVED_VISUAL_OBJECT'
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['diagnosticCode'],
          message:
            'Visual resolutions apply only to ambiguous or unresolved visual diagnostics.',
        })
      }
      if (decision.target.markerId !== decision.resolution.relationshipId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['target'],
          message:
            'Visual decisions must identify the exact diagnostic relationship.',
        })
      }
      if (
        decision.resolution.type === 'classify-visual-decoration' &&
        new Set(decision.resolution.sourceObjectIds).size !==
          decision.resolution.sourceObjectIds.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resolution', 'sourceObjectIds'],
          message: 'Decoration source object identifiers must be unique.',
        })
      }
    } else if (decision.diagnosticCode === 'UNRESOLVED_CORRUPTING_JOIN') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resolution'],
        message:
          'Unresolved line joins require an explicit line-join resolution.',
      })
    } else if (decision.diagnosticCode === 'UNRESOLVED_EQUATION_TRANSCRIPT') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resolution'],
        message:
          'Unresolved equation transcripts require an explicit equation-transcript resolution.',
      })
    }
  })

export const humanDecisionFileSchema = z
  .object({
    schemaVersion: z.union([
      z.literal(LEGACY_HUMAN_DECISION_SCHEMA_VERSION),
      z.literal(LINE_JOIN_HUMAN_DECISION_SCHEMA_VERSION),
      z.literal(EQUATION_HUMAN_DECISION_SCHEMA_VERSION),
      z.literal(HUMAN_DECISION_SCHEMA_VERSION),
    ]),
    documentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    decisions: z.array(humanAdjudicationRecordSchema).max(MAX_HUMAN_DECISIONS),
  })
  .strict()
  .superRefine((file, context) => {
    const seen = new Set<string>()
    for (const [index, decision] of file.decisions.entries()) {
      const key = decisionKey(decision)
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['decisions', index],
          message:
            'A decision file may contain only one resolution per diagnostic target.',
        })
      }
      seen.add(key)
      if (
        file.schemaVersion === LEGACY_HUMAN_DECISION_SCHEMA_VERSION &&
        decision.resolution.type === 'resolve-line-join'
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['decisions', index, 'resolution'],
          message: 'Line-join resolutions require decision schema v1.1.0.',
        })
      }
      if (
        (file.schemaVersion === LEGACY_HUMAN_DECISION_SCHEMA_VERSION ||
          file.schemaVersion === LINE_JOIN_HUMAN_DECISION_SCHEMA_VERSION) &&
        decision.resolution.type === 'accept-equation-transcript'
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['decisions', index, 'resolution'],
          message:
            'Equation transcript resolutions require decision schema v1.2.0.',
        })
      }
      if (
        file.schemaVersion !== HUMAN_DECISION_SCHEMA_VERSION &&
        (decision.resolution.type === 'accept-visual-match' ||
          decision.resolution.type === 'accept-visual-fallback' ||
          decision.resolution.type === 'classify-visual-decoration')
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['decisions', index, 'resolution'],
          message: 'Visual resolutions require decision schema v1.3.0.',
        })
      }
    }
  })

export type HumanDecisionFile = z.infer<typeof humanDecisionFileSchema>
export type EquationTranscriptDecision = Omit<
  HumanAdjudicationRecord,
  'diagnosticCode' | 'resolution'
> & {
  diagnosticCode: 'UNRESOLVED_EQUATION_TRANSCRIPT'
  resolution: Extract<
    HumanAdjudicationRecord['resolution'],
    { type: 'accept-equation-transcript' }
  >
}
export type VisualMatchDecision = Omit<
  HumanAdjudicationRecord,
  'diagnosticCode' | 'resolution'
> & {
  diagnosticCode: 'AMBIGUOUS_VISUAL_MATCH' | 'UNRESOLVED_VISUAL_OBJECT'
  resolution: Extract<
    HumanAdjudicationRecord['resolution'],
    { type: 'accept-visual-match' | 'accept-visual-fallback' }
  >
}

export type VerifiedPdfCandidateResolution = {
  decision: HumanAdjudicationRecord
  origin: PdfCandidateResolutionOrigin
}

const QUALITY_DIAGNOSTIC_CODES = new Set<ReconstructionDiagnostic['code']>([
  'OCR_REQUIRED',
  'UNRESOLVED_EQUATION_TRANSCRIPT',
  'UNRESOLVED_ALGORITHM_TRANSCRIPT',
  'UNRESOLVED_PREFORMATTED_TRANSCRIPT',
  'EPUB_TEXT_SANITIZATION_LOSS',
  'DANGLING_EPUB_INTERNAL_REFERENCE',
  'INCOMPLETE_TEXT_COVERAGE',
  'DUPLICATE_CANONICAL_SPAN',
  'DUPLICATE_CANONICAL_ROLE',
  'CANONICAL_FLOW_ORDER_VIOLATION',
  'CANONICAL_VISUAL_ORDER_VIOLATION',
  'MISSING_SOURCE_REGION',
  'UNPROVENANCED_RENDERED_UNIT',
  'INCOMPLETE_INLINE_STYLE_COVERAGE',
  'UNRESOLVED_HYPERLINK',
  'INVALID_LINE_BOUNDARY_LEDGER',
  'INVALID_SOURCE_SEMANTIC_FLOW_BOUNDARY_LEDGER',
  'INVALID_CANONICAL_HYPHEN_BOUNDARY_LEDGER',
  'UNRESOLVED_CORRUPTING_JOIN',
  'INCOMPLETE_ASSET_COVERAGE',
  'INCOMPLETE_RELATIONSHIP_COVERAGE',
  'INCOMPLETE_SEMANTIC_TABLE_COVERAGE',
  'UNRESOLVED_SEMANTIC_OBJECTS',
])

function normalizedTarget(target: HumanAdjudicationRecord['target']) {
  return {
    regionIds: [...new Set(target.regionIds)].sort(),
    markerId: target.markerId,
  }
}

function normalizedRecord(
  decision: HumanAdjudicationRecord,
): HumanAdjudicationRecord {
  const resolution = (() => {
    if (decision.resolution.type === 'accept-reading-order') {
      return {
        ...decision.resolution,
        regionIds: [...decision.resolution.regionIds],
      }
    }
    if (decision.resolution.type === 'resolve-line-join') {
      return {
        ...decision.resolution,
        transition: { ...decision.resolution.transition },
        evidence: [...decision.resolution.evidence],
      }
    }
    if (decision.resolution.type === 'accept-equation-transcript') {
      return {
        ...decision.resolution,
        evidence: [...decision.resolution.evidence],
      }
    }
    if (decision.resolution.type === 'classify-visual-decoration') {
      return {
        ...decision.resolution,
        sourceObjectIds: [...decision.resolution.sourceObjectIds].sort(),
      }
    }
    return { ...decision.resolution }
  })()
  return {
    diagnosticCode: decision.diagnosticCode,
    target: normalizedTarget(decision.target),
    resolution,
  }
}

function decisionKey(decision: HumanAdjudicationRecord) {
  const target = normalizedTarget(decision.target)
  return `${decision.diagnosticCode}\u0000${target.markerId ?? ''}\u0000${target.regionIds.join('\u0000')}`
}

function sameValues(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function sameTarget(
  left: HumanAdjudicationRecord['target'],
  right: HumanAdjudicationRecord['target'],
) {
  const normalizedLeft = normalizedTarget(left)
  const normalizedRight = normalizedTarget(right)
  return (
    normalizedLeft.markerId === normalizedRight.markerId &&
    sameValues(normalizedLeft.regionIds, normalizedRight.regionIds)
  )
}

function sameDecision(
  left: HumanAdjudicationRecord,
  right: HumanAdjudicationRecord,
) {
  return (
    JSON.stringify(normalizedRecord(left)) ===
    JSON.stringify(normalizedRecord(right))
  )
}

function readingOrderDecisionStillInstalled(
  reconstruction: PdfReconstruction,
  decision: HumanAdjudicationRecord,
) {
  if (
    decision.diagnosticCode !== 'AMBIGUOUS_READING_ORDER' ||
    decision.resolution.type !== 'accept-reading-order'
  ) {
    return false
  }
  const targetIds = new Set(decision.target.regionIds)
  const installed = reconstruction.readingOrder.order.filter((regionId) =>
    targetIds.has(regionId),
  )
  return sameValues(installed, decision.resolution.regionIds)
}

function noteDecisionStillInstalled(
  reconstruction: PdfReconstruction,
  decision: HumanAdjudicationRecord,
) {
  if (
    decision.diagnosticCode !== 'AMBIGUOUS_NOTE_MATCH' ||
    decision.resolution.type !== 'accept-note-match'
  ) {
    return false
  }
  const resolution = decision.resolution
  const relationship = reconstruction.noteRelationships.find(
    ({ id }) => id === decision.target.markerId,
  )
  const candidates = relationship?.candidates.filter(
    ({ targetNoteId, targetRegionId }) =>
      targetNoteId === resolution.targetNoteId &&
      targetRegionId === resolution.targetRegionId,
  )
  const candidate = candidates?.length === 1 ? candidates[0] : undefined
  return Boolean(
    relationship?.status === 'matched' &&
    relationship.evidence.includes('human-adjudication') &&
    candidate &&
    relationship.targetNoteId === candidate.targetNoteId &&
    relationship.confidence === candidate.score &&
    JSON.stringify(relationship.sourceBoxes) ===
      JSON.stringify(candidate.sourceBoxes),
  )
}

function visualDecisionStillInstalled(
  reconstruction: PdfReconstruction,
  decision: HumanAdjudicationRecord,
) {
  if (!(
    (decision.diagnosticCode === 'AMBIGUOUS_VISUAL_MATCH' &&
      decision.resolution.type === 'accept-visual-match') ||
    (decision.diagnosticCode === 'UNRESOLVED_VISUAL_OBJECT' &&
      decision.resolution.type === 'accept-visual-fallback')
  )) {
    return false
  }
  const resolution = decision.resolution
  const existingDecisionCandidate =
    reconstruction.humanAdjudications.applied.find((candidate) =>
      sameDecision(candidate, decision),
    )
  if (!existingDecisionCandidate) return false
  const relationship = reconstruction.visualRelationships.find(
    ({ id }) =>
      id === decision.target.markerId && id === resolution.relationshipId,
  )
  const candidates = relationship?.candidates.filter(
    (candidate) =>
      visualDecisionCandidateId(relationship, candidate) ===
      resolution.candidateId,
  )
  const candidate = candidates?.length === 1 ? candidates[0] : undefined
  const captionBox = relationship
    ? ((relationship.captionNodeId
        ? reconstruction.provenance[relationship.captionNodeId]?.boxes[0]
        : undefined) ??
      reconstruction.regions.find(
        ({ id }) => id === relationship.captionRegionId,
      )?.box)
    : undefined
  const installedBoxes =
    captionBox && candidate
      ? [{ ...captionBox }, ...candidate.sourceBoxes.map((box) => ({ ...box }))]
      : null
  return Boolean(
    relationship?.status === 'matched' &&
    relationship.evidence.includes('human-adjudicated-visual-match') &&
    relationship.evidence.includes(
      `human-adjudicated-visual-kind:${relationship.kind}`,
    ) &&
    candidate &&
    installedBoxes &&
    relationship.confidence === candidate.score &&
    JSON.stringify(relationship.sourceBoxes) ===
      JSON.stringify(installedBoxes) &&
    sameValues(relationship.sourceRegionIds, candidate.sourceRegionIds) &&
    sameValues(
      relationship.sourceLineIds ?? [],
      candidate.sourceLineIds ?? [],
    ) &&
    sameValues(relationship.sourceObjectIds, candidate.sourceObjectIds) &&
    sameValues(relationship.assetIds, candidate.assetIds),
  )
}

export function parseHumanDecisionFile(input: string | unknown) {
  if (
    typeof input === 'string' &&
    new TextEncoder().encode(input).byteLength > MAX_HUMAN_DECISION_FILE_BYTES
  ) {
    throw new Error(
      `Decision file exceeds the ${MAX_HUMAN_DECISION_FILE_BYTES}-byte local limit.`,
    )
  }
  return humanDecisionFileSchema.parse(
    typeof input === 'string' ? JSON.parse(input) : input,
  )
}

export function createHumanDecisionFile(documentSha256: string) {
  return humanDecisionFileSchema.parse({
    schemaVersion: EQUATION_HUMAN_DECISION_SCHEMA_VERSION,
    documentSha256,
    decisions: [],
  })
}

export function upsertHumanDecision(
  file: HumanDecisionFile,
  decision: HumanAdjudicationRecord,
) {
  const normalized = normalizedRecord(decision)
  return humanDecisionFileSchema.parse({
    ...file,
    schemaVersion:
      normalized.resolution.type === 'accept-visual-match' ||
      normalized.resolution.type === 'accept-visual-fallback' ||
      normalized.resolution.type === 'classify-visual-decoration'
        ? HUMAN_DECISION_SCHEMA_VERSION
        : normalized.resolution.type === 'resolve-line-join' ||
            normalized.resolution.type === 'accept-equation-transcript'
          ? file.schemaVersion === HUMAN_DECISION_SCHEMA_VERSION
            ? HUMAN_DECISION_SCHEMA_VERSION
            : EQUATION_HUMAN_DECISION_SCHEMA_VERSION
          : file.schemaVersion,
    decisions: [
      ...file.decisions.filter(
        (candidate) => decisionKey(candidate) !== decisionKey(normalized),
      ),
      normalized,
    ].sort((left, right) =>
      decisionKey(left).localeCompare(decisionKey(right)),
    ),
  })
}

export function serializeHumanDecisionFile(file: HumanDecisionFile) {
  return `${JSON.stringify(humanDecisionFileSchema.parse(file), null, 2)}\n`
}

export function humanDecisionFileSha256(file: HumanDecisionFile) {
  return sha256HexSync(serializeHumanDecisionFile(file))
}

export function createEquationTranscriptDecision(
  reconstruction: PdfReconstruction,
  relationshipId: string,
  transcript: string,
): EquationTranscriptDecision {
  const relationshipMatches = reconstruction.visualRelationships.filter(
    (candidate) => candidate.id === relationshipId,
  )
  if (relationshipMatches.length !== 1) {
    throw new Error(
      'Equation transcript decision requires one exact visual relationship.',
    )
  }
  const relationship = relationshipMatches[0]
  const diagnosticMatches = reconstruction.diagnostics.filter(
    (diagnostic) =>
      diagnostic.code === 'UNRESOLVED_EQUATION_TRANSCRIPT' &&
      diagnostic.relationshipId === relationship.id &&
      diagnostic.target?.markerId === relationship.id &&
      sameValues(
        normalizedTarget(diagnostic.target).regionIds,
        normalizedTarget({
          markerId: relationship.id,
          regionIds: relationship.sourceRegionIds,
        }).regionIds,
      ),
  )
  const binding = equationTranscriptDecisionBinding(
    reconstruction,
    relationship.id,
  )
  if (diagnosticMatches.length !== 1 || !binding) {
    throw new Error(
      'Equation transcript decision is not legal for the current reconstruction.',
    )
  }
  return humanAdjudicationRecordSchema.parse({
    diagnosticCode: 'UNRESOLVED_EQUATION_TRANSCRIPT',
    target: {
      markerId: relationship.id,
      regionIds: relationship.sourceRegionIds,
    },
    resolution: {
      type: 'accept-equation-transcript',
      ...binding,
      format: 'latex',
      transcript,
      confidence: 1,
      evidence: ['exact-source-page-crop', 'owner-local-adjudication'],
    },
  }) as EquationTranscriptDecision
}

export function createVisualMatchDecision(
  reconstruction: PdfReconstruction,
  relationshipId: string,
  candidateId: string,
  type:
    'accept-visual-match' | 'accept-visual-fallback' = 'accept-visual-match',
): VisualMatchDecision {
  const relationship = reconstruction.visualRelationships.find(
    (candidate) => candidate.id === relationshipId,
  )
  const diagnostic = reconstruction.diagnostics.find(
    (candidate) =>
      (candidate.code === 'AMBIGUOUS_VISUAL_MATCH' ||
        candidate.code === 'UNRESOLVED_VISUAL_OBJECT') &&
      candidate.target?.markerId === relationshipId,
  )
  const candidate = relationship?.candidates.find(
    (item) =>
      (item.id ?? pdfVisualMatchCandidateId(relationshipId, item)) ===
      candidateId,
  )
  if (!relationship || !diagnostic?.target || !candidate) {
    throw new Error(
      'Visual match decision is not legal for the current diagnostic.',
    )
  }
  const semanticCandidateId = visualDecisionCandidateId(relationship, candidate)
  return humanAdjudicationRecordSchema.parse({
    diagnosticCode: diagnostic.code,
    target: diagnostic.target,
    resolution: { type, relationshipId, candidateId: semanticCandidateId },
  }) as VisualMatchDecision
}

export function visualDecisionCandidateId(
  relationship: PdfReconstruction['visualRelationships'][number],
  candidate: PdfReconstruction['visualRelationships'][number]['candidates'][number],
) {
  const sourceCandidateId =
    candidate.id ?? pdfVisualMatchCandidateId(relationship.id, candidate)
  return `visual-decision-${sha256HexSync(
    JSON.stringify({
      sourceCandidateId,
      kind: relationship.kind,
      score: candidate.score,
      sourceBoxes: candidate.sourceBoxes,
      sourceRegionIds: candidate.sourceRegionIds,
      sourceLineIds: candidate.sourceLineIds ?? [],
      sourceObjectIds: candidate.sourceObjectIds,
      assetIds: candidate.assetIds,
      sourceTextSha256: sha256HexSync(
        candidate.sourceText ?? relationship.sourceText ?? '',
      ),
    }),
  )}`
}

export function readingOrderCandidates(
  reconstruction: PdfReconstruction,
  diagnostic: ReconstructionDiagnostic,
) {
  if (
    diagnostic.code !== 'AMBIGUOUS_READING_ORDER' ||
    !diagnostic.target?.regionIds.length
  ) {
    return []
  }
  const targetIds = new Set(diagnostic.target.regionIds)
  const base = reconstruction.readingOrder.order.filter((id) =>
    targetIds.has(id),
  )
  if (base.length !== targetIds.size) return []
  const regions = new Map(
    reconstruction.regions
      .filter((region) => targetIds.has(region.id))
      .map((region) => [region.id, region]),
  )
  const swappable = (id: string) => {
    const region = regions.get(id)
    return (
      region &&
      region.kind !== 'footnote' &&
      region.kind !== 'endnote' &&
      (region.column === 'left' || region.column === 'right')
    )
  }
  const alternate: string[] = []
  let segment: string[] = []
  const flushSegment = () => {
    alternate.push(
      ...segment.filter((id) => regions.get(id)?.column === 'right'),
      ...segment.filter((id) => regions.get(id)?.column === 'left'),
    )
    segment = []
  }
  for (const regionId of base) {
    if (swappable(regionId)) {
      segment.push(regionId)
    } else {
      flushSegment()
      alternate.push(regionId)
    }
  }
  flushSegment()
  return sameValues(base, alternate) ? [base] : [base, alternate]
}

function diagnosticForDecision(
  reconstruction: PdfReconstruction,
  decision: HumanAdjudicationRecord,
) {
  return reconstruction.diagnostics.find(
    (diagnostic) =>
      diagnostic.code === decision.diagnosticCode &&
      diagnostic.target &&
      sameTarget(diagnostic.target, decision.target),
  )
}

function updateNoteRelationship(
  reconstruction: PdfReconstruction,
  decision: HumanAdjudicationRecord,
  evidenceOrigin:
    'human-adjudication' | PdfCandidateResolutionOrigin = 'human-adjudication',
) {
  if (
    decision.diagnosticCode !== 'AMBIGUOUS_NOTE_MATCH' &&
    decision.diagnosticCode !== 'UNRESOLVED_NOTE_REFERENCE'
  ) {
    return false
  }
  const markerId = decision.target.markerId
  const relationship = reconstruction.noteRelationships.find(
    (candidate) => candidate.id === markerId,
  )
  if (
    !relationship ||
    !decision.target.regionIds.includes(relationship.referenceRegionId)
  ) {
    return false
  }
  const resolutionInputConfidence = relationship.confidence

  const referenceNode = reconstruction.paper.nodes.find((node) =>
    reconstruction.provenance[node.id]?.regionIds.includes(
      relationship.referenceRegionId,
    ),
  )
  const tableCellAnchors =
    referenceNode?.type === 'figure' && referenceNode.table
      ? referenceNode.table.rows.flatMap((row, rowIndex) =>
          row.cells.flatMap((cell, cellIndex) => {
            const noteReference = cell.noteReferences?.find(
              (reference) => reference.id === relationship.id,
            )
            const inlineRun = cell.inlineRuns?.find(
              (run) => run.relationshipId === relationship.id,
            )
            if (!noteReference && !inlineRun) return []
            if (
              noteReference &&
              inlineRun &&
              (noteReference.start !== inlineRun.start ||
                noteReference.end !== inlineRun.end)
            ) {
              return []
            }
            const range = noteReference ?? inlineRun!
            return [
              {
                cell,
                nodeId: `${referenceNode.id}:table:${cell.id ?? `${rowIndex}:${cellIndex}`}`,
                start: range.start,
                end: range.end,
              },
            ]
          }),
        )
      : []
  const tableCellAnchor =
    tableCellAnchors.length === 1 ? tableCellAnchors[0] : null
  if (
    referenceNode?.type === 'figure' &&
    referenceNode.table &&
    !tableCellAnchor
  ) {
    return false
  }

  let targetNoteId: string | null = null
  let citationTargetIds: string[] | undefined
  if (decision.resolution.type === 'accept-note-match') {
    const resolution = decision.resolution
    const candidate = relationship.candidates.find(
      (item) =>
        item.targetNoteId === resolution.targetNoteId &&
        item.targetRegionId === resolution.targetRegionId &&
        decision.target.regionIds.includes(item.targetRegionId),
    )
    if (!candidate) return false
    const targetNote = reconstruction.paper.nodes.find(
      (node) => node.id === candidate.targetNoteId && node.type === 'footnote',
    )
    const authorAnchor = relationship.canonicalAnchor?.kind === 'author'
    if (
      !targetNote ||
      (!referenceNode && !authorAnchor) ||
      (referenceNode?.type === 'figure' && !tableCellAnchor)
    ) {
      return false
    }
    targetNoteId = candidate.targetNoteId
    relationship.targetNoteId = candidate.targetNoteId
    relationship.status = 'matched'
    relationship.confidence = candidate.score
    relationship.evidence = [...candidate.evidence, evidenceOrigin]
    relationship.sourceBoxes = [...candidate.sourceBoxes]
  } else if (decision.resolution.type === 'reclassify-citation') {
    const labels = relationship.label.split(',').filter(Boolean)
    if (
      labels.length === 0 ||
      labels.length > MAX_CITATION_TARGETS_PER_RELATIONSHIP
    ) {
      return false
    }
    relationship.targetNoteId = null
    relationship.status = 'citation'
    relationship.evidence = [...relationship.evidence, evidenceOrigin]
    const bibliographyTargets = new Map<string, string>()
    for (const node of reconstruction.paper.nodes) {
      if (
        node.type !== 'paragraph' ||
        node.list?.numberingId !== 'references'
      ) {
        continue
      }
      const label =
        node.list.ordinal?.toString() ??
        node.text.trim().match(/^\[?([0-9]+)\]?[.)]?\s+/)?.[1]
      if (label && !bibliographyTargets.has(label)) {
        bibliographyTargets.set(label, node.id)
      }
    }
    const retainedCitationCandidateNodeIds = labels.flatMap((label) => {
      const target = bibliographyTargets.get(label)
      return target ? [target] : []
    })
    const uniqueCitationCandidateNodeIds = [
      ...new Set(retainedCitationCandidateNodeIds),
    ]
    const citationMatched =
      uniqueCitationCandidateNodeIds.length === labels.length
    citationTargetIds = citationMatched ? uniqueCitationCandidateNodeIds : []
    const replacesCitation = reconstruction.citationRelationships.some(
      (candidate) => candidate.id === relationship.id,
    )
    const citation = {
      id: relationship.id,
      label: relationship.label,
      labels,
      referenceRegionId: relationship.referenceRegionId,
      referenceStart: relationship.referenceStart,
      referenceEnd: relationship.referenceEnd,
      taxonomy: 'human-reclassified-citation' as const,
      targetNodeIds: citationTargetIds,
      ...(!citationMatched && uniqueCitationCandidateNodeIds.length > 0
        ? { candidateNodeIds: uniqueCitationCandidateNodeIds }
        : {}),
      status: citationMatched ? ('matched' as const) : ('unresolved' as const),
      canonicalAnchor: null,
      confidence: relationship.confidence,
      evidence: [...relationship.evidence],
      sourceBoxes: relationship.sourceBoxes.map((box) => ({ ...box })),
    }
    reconstruction.citationRelationships = [
      ...reconstruction.citationRelationships.filter(
        (candidate) => candidate.id !== citation.id,
      ),
      citation,
    ].sort((left, right) => left.id.localeCompare(right.id))
    if (!replacesCitation) {
      reconstruction.completeness.expectedInlineSpanCount += 1
      reconstruction.completeness.inlineSpanCoverage =
        reconstruction.completeness.mappedInlineSpanCount /
        reconstruction.completeness.expectedInlineSpanCount
    }
    if (citation.status === 'unresolved') {
      reconstruction.diagnostics.push({
        code: 'UNRESOLVED_CITATION_REFERENCE',
        severity: 'error',
        page: citation.sourceBoxes[0]?.page,
        message: `Citation marker ${citation.id} has no complete bibliography-label target.`,
        sourceBoxes: citation.sourceBoxes,
        relationshipId: citation.id,
        target: {
          regionIds: [citation.referenceRegionId],
          markerId: citation.id,
        },
      })
    } else {
      reconstruction.diagnostics.push({
        code: 'UNMAPPED_CITATION_ANCHOR',
        severity: 'error',
        page: citation.sourceBoxes[0]?.page,
        message: `Citation marker ${citation.id} has bibliography targets but no exact canonical inline anchor.`,
        sourceBoxes: citation.sourceBoxes,
        relationshipId: citation.id,
        target: {
          regionIds: [citation.referenceRegionId],
          markerId: citation.id,
        },
      })
    }
  } else if (decision.resolution.type === 'reclassify-plain-text') {
    relationship.targetNoteId = null
    relationship.status = 'plain-text'
    relationship.evidence = [...relationship.evidence, evidenceOrigin]
  } else {
    return false
  }
  relationship.resolutionOrigin = evidenceOrigin
  if (evidenceOrigin === 'human-adjudication') {
    delete relationship.resolutionInputConfidence
  } else {
    relationship.resolutionInputConfidence = resolutionInputConfidence
  }

  for (const node of reconstruction.paper.nodes) {
    if ('noteReferences' in node && node.noteReferences) {
      node.noteReferences = node.noteReferences.filter(
        (reference) => reference.id !== relationship.id,
      )
      if (node.noteReferences.length === 0) delete node.noteReferences
    }
    if (node.type === 'footnote') {
      node.relationships.backlinks = node.relationships.backlinks.filter(
        (backlink) => backlink !== relationship.id,
      )
    }
    if (node.type === 'figure' && node.table) {
      for (const row of node.table.rows) {
        for (const cell of row.cells) {
          if (cell.noteReferences) {
            cell.noteReferences = cell.noteReferences.filter(
              (reference) => reference.id !== relationship.id,
            )
            if (cell.noteReferences.length === 0) delete cell.noteReferences
          }
          if (cell.inlineRuns) {
            cell.inlineRuns = cell.inlineRuns.flatMap((run) => {
              if (run.relationshipId !== relationship.id) return [run]
              const {
                relationshipId: _relationshipId,
                semanticRole: _semanticRole,
                targetIds: _targetIds,
                ...retained
              } = run
              return Object.keys(retained).length > 2 ? [retained] : []
            })
            if (cell.inlineRuns.length === 0) delete cell.inlineRuns
          }
        }
      }
    }
  }
  if (
    decision.resolution.type === 'reclassify-citation' &&
    referenceNode &&
    referenceNode.type !== 'figure'
  ) {
    const semanticRun = {
      start: relationship.referenceStart,
      end: relationship.referenceEnd,
      relationshipId: relationship.id,
      semanticRole: 'citation' as const,
      ...(citationTargetIds?.length ? { targetIds: citationTargetIds } : {}),
    }
    const existing = referenceNode.inlineRuns?.find(
      (run) => run.start === semanticRun.start && run.end === semanticRun.end,
    )
    if (existing) {
      Object.assign(existing, semanticRun)
      if (!citationTargetIds?.length) delete existing.targetIds
    } else {
      referenceNode.inlineRuns = [
        ...(referenceNode.inlineRuns ?? []),
        semanticRun,
      ].sort((left, right) => left.start - right.start || left.end - right.end)
    }
  }
  if (decision.resolution.type === 'reclassify-citation' && tableCellAnchor) {
    tableCellAnchor.cell.inlineRuns = [
      ...(tableCellAnchor.cell.inlineRuns ?? []),
      {
        start: tableCellAnchor.start,
        end: tableCellAnchor.end,
        relationshipId: relationship.id,
        semanticRole: 'citation' as const,
        ...(citationTargetIds?.length ? { targetIds: citationTargetIds } : {}),
      },
    ].sort(
      (left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        String(left.relationshipId ?? '').localeCompare(
          String(right.relationshipId ?? ''),
        ),
    )
  }
  let projectedNoteReference = relationship.canonicalAnchor?.kind === 'author'
  if (targetNoteId && referenceNode && referenceNode.type !== 'figure') {
    referenceNode.noteReferences = [
      ...(referenceNode.noteReferences ?? []),
      {
        id: relationship.id,
        label: relationship.label,
        target: targetNoteId,
        start: relationship.referenceStart,
        end: relationship.referenceEnd,
        confidence: relationship.confidence,
      },
    ].sort(
      (left, right) =>
        left.start - right.start || left.id.localeCompare(right.id),
    )
    projectedNoteReference = true
  }
  if (targetNoteId && tableCellAnchor) {
    tableCellAnchor.cell.noteReferences = [
      ...(tableCellAnchor.cell.noteReferences ?? []),
      {
        id: relationship.id,
        label: relationship.label,
        target: targetNoteId,
        start: tableCellAnchor.start,
        end: tableCellAnchor.end,
        confidence: relationship.confidence,
      },
    ].sort(
      (left, right) =>
        left.start - right.start || left.id.localeCompare(right.id),
    )
    relationship.canonicalAnchor = {
      kind: 'node',
      nodeId: tableCellAnchor.nodeId,
      start: tableCellAnchor.start,
      end: tableCellAnchor.end,
    }
    projectedNoteReference = true
  }
  if (targetNoteId && projectedNoteReference) {
    const target = reconstruction.paper.nodes.find(
      (node) => node.id === targetNoteId && node.type === 'footnote',
    )
    if (target?.type === 'footnote') {
      target.relationships.backlinks = [
        ...new Set([...target.relationships.backlinks, relationship.id]),
      ].sort()
    }
    if (relationship.canonicalAnchor?.kind === 'author') {
      const authorNote = {
        id: relationship.id,
        author: relationship.canonicalAnchor.author,
        label: relationship.label,
        target: targetNoteId,
      }
      reconstruction.paper.authorNotes = [
        ...(reconstruction.paper.authorNotes ?? []).filter(
          ({ id }) => id !== relationship.id,
        ),
        authorNote,
      ].sort((left, right) => left.id.localeCompare(right.id))
    }
  }
  return true
}

function updateReadingOrder(
  reconstruction: PdfReconstruction,
  diagnostic: ReconstructionDiagnostic,
  decision: HumanAdjudicationRecord,
  resolutionOrigin:
    'human-adjudication' | PdfCandidateResolutionOrigin = 'human-adjudication',
) {
  if (
    decision.diagnosticCode !== 'AMBIGUOUS_READING_ORDER' ||
    decision.resolution.type !== 'accept-reading-order'
  ) {
    return false
  }
  const candidates = readingOrderCandidates(reconstruction, diagnostic)
  const chosen = decision.resolution.regionIds
  if (!candidates.some((candidate) => sameValues(candidate, chosen)))
    return false

  const targetIds = new Set(decision.target.regionIds)
  const nextOrder: string[] = []
  let inserted = false
  for (const regionId of reconstruction.readingOrder.order) {
    if (!targetIds.has(regionId)) {
      nextOrder.push(regionId)
    } else if (!inserted) {
      nextOrder.push(...chosen)
      inserted = true
    }
  }
  const selectedPairs = new Set(
    chosen.slice(0, -1).map((id, index) => `${id}\u0000${chosen[index + 1]}`),
  )
  reconstruction.readingOrder.edges = reconstruction.readingOrder.edges
    .filter((edge) => {
      if (
        edge.status !== 'candidate' ||
        !targetIds.has(edge.from) ||
        !targetIds.has(edge.to)
      ) {
        return true
      }
      return selectedPairs.has(`${edge.from}\u0000${edge.to}`)
    })
    .map((edge) =>
      edge.status === 'candidate' &&
      targetIds.has(edge.from) &&
      targetIds.has(edge.to)
        ? { ...edge, status: 'accepted' as const }
        : edge,
    )
  reconstruction.readingOrder.order = nextOrder
  for (const resolution of reconstruction.readingOrder.resolutions) {
    if (
      sameValues(
        [...resolution.regionIds].sort(),
        [...decision.target.regionIds].sort(),
      )
    ) {
      resolution.resolutionOrigin = resolutionOrigin
    }
  }
  const unresolvedEdgeCount = reconstruction.readingOrder.edges.filter(
    (edge) => edge.status === 'candidate',
  ).length
  reconstruction.readingOrder.evaluation = {
    ...reconstruction.readingOrder.evaluation,
    acceptedEdgeCount:
      reconstruction.readingOrder.edges.length - unresolvedEdgeCount,
    unresolvedEdgeCount,
    reviewRequired:
      !reconstruction.readingOrder.acyclic || unresolvedEdgeCount > 0,
  }

  const positions = new Map(nextOrder.map((id, index) => [id, index]))
  reconstruction.paper.nodes = reconstruction.paper.nodes
    .map((node, index) => ({ node, index }))
    .sort((left, right) => {
      const leftRegion = reconstruction.provenance[left.node.id]?.regionIds[0]
      const rightRegion = reconstruction.provenance[right.node.id]?.regionIds[0]
      return (
        (positions.get(leftRegion) ?? Number.MAX_SAFE_INTEGER) -
          (positions.get(rightRegion) ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index
      )
    })
    .map(({ node }) => node)
  return true
}

function occurrenceIndexes(value: string, query: string) {
  if (!query) return []
  const indexes: number[] = []
  let cursor = 0
  while (cursor <= value.length - query.length) {
    const index = value.indexOf(query, cursor)
    if (index < 0) break
    indexes.push(index)
    cursor = index + Math.max(query.length, 1)
  }
  return indexes
}

function shiftedOffset(
  offset: number,
  removedStart: number,
  removedCount: number,
) {
  if (offset <= removedStart) return offset
  if (offset >= removedStart + removedCount) return offset - removedCount
  return removedStart
}

function shiftedRange(
  start: number,
  end: number,
  removedStart: number,
  removedCount: number,
) {
  return {
    start: shiftedOffset(start, removedStart, removedCount),
    end: shiftedOffset(end, removedStart, removedCount),
  }
}

function exactRemovalEdit(current: string, resolved: string) {
  if (current === resolved) return { start: current.length, count: 0 }
  if (resolved.length >= current.length) return null
  let start = 0
  while (start < resolved.length && current[start] === resolved[start]) {
    start += 1
  }
  let currentEnd = current.length
  let resolvedEnd = resolved.length
  while (
    currentEnd > start &&
    resolvedEnd > start &&
    current[currentEnd - 1] === resolved[resolvedEnd - 1]
  ) {
    currentEnd -= 1
    resolvedEnd -= 1
  }
  const count = currentEnd - start
  if (
    count <= 0 ||
    current.slice(0, start) + current.slice(currentEnd) !== resolved
  ) {
    return null
  }
  return { start, count }
}

type CanonicalNode = PdfReconstruction['paper']['nodes'][number]
type CanonicalTextNode = CanonicalNode & { text: string }

function hasCanonicalText(node: CanonicalNode): node is CanonicalTextNode {
  return 'text' in node
}

function updateNodeRanges(
  node: PdfReconstruction['paper']['nodes'][number],
  removedStart: number,
  removedCount: number,
) {
  if ('inlineRuns' in node && node.inlineRuns) {
    node.inlineRuns = node.inlineRuns.map((run) => ({
      ...run,
      ...shiftedRange(run.start, run.end, removedStart, removedCount),
    }))
  }
  if ('noteReferences' in node && node.noteReferences) {
    node.noteReferences = node.noteReferences.map((reference) => ({
      ...reference,
      ...shiftedRange(
        reference.start,
        reference.end,
        removedStart,
        removedCount,
      ),
    }))
  }
}

function resolveLineJoinText(
  reconstruction: PdfReconstruction,
  regionId: string,
  fromLineId: string,
  toLineId: string,
  outcome: 'removed-discretionary-hyphen' | 'preserved-lexical-hyphen',
) {
  const region = reconstruction.regions.find(
    (candidate) => candidate.id === regionId,
  )
  if (!region) return false
  const fromIndex = region.lines.findIndex((line) => line.id === fromLineId)
  if (fromIndex < 0 || region.lines[fromIndex + 1]?.id !== toLineId) {
    return false
  }
  const fromText = region.lines[fromIndex].text.trim()
  const toText = region.lines[fromIndex + 1].text.trim()
  const left = fromText.match(/([\p{L}\p{N}]+)([-‐‑])$/u)
  const right = toText.match(/^([\p{L}\p{N}]+)/u)
  if (!left || !right) return false
  const transition = reconstruction.lineBoundaryDecisions.find(
    (candidate) =>
      candidate.regionId === regionId &&
      candidate.fromLineId === fromLineId &&
      candidate.toLineId === toLineId,
  )
  if (!transition) return false
  const currentReplay = replayPdfRegionLineRanges(
    region,
    reconstruction.lineBoundaryDecisions,
  )
  const resolvedReplay = replayPdfRegionLineRanges(
    region,
    reconstruction.lineBoundaryDecisions.map((candidate) =>
      candidate.id === transition.id
        ? {
            ...candidate,
            outcome,
          }
        : candidate,
    ),
  )
  const currentRegionText = currentReplay?.text
  const resolvedRegionText = resolvedReplay?.text
  if (
    currentRegionText !== region.text ||
    !currentReplay ||
    !resolvedReplay ||
    !resolvedRegionText
  ) {
    return false
  }
  const edit = exactRemovalEdit(currentRegionText, resolvedRegionText)
  if (!edit) return false
  if (edit.count === 0) return true
  const fromRange = currentReplay.ranges.get(fromLineId)
  const toRange = currentReplay.ranges.get(toLineId)
  if (!fromRange || !toRange) return false
  const boundaryStart = fromRange.end - left[0].length
  const boundaryEnd = toRange.start + right[0].length
  if (
    boundaryStart < 0 ||
    boundaryEnd > currentRegionText.length ||
    edit.start < boundaryStart ||
    edit.start + edit.count > boundaryEnd
  ) {
    return false
  }
  const currentBoundary = currentRegionText.slice(boundaryStart, boundaryEnd)
  const resolvedBoundary =
    currentBoundary.slice(0, edit.start - boundaryStart) +
    currentBoundary.slice(edit.start - boundaryStart + edit.count)

  const candidateNodes = reconstruction.paper.nodes
    .filter(hasCanonicalText)
    .filter((node) =>
      reconstruction.provenance[node.id]?.regionIds.includes(regionId),
    )
  let canonicalMatches = candidateNodes.flatMap((node) =>
    occurrenceIndexes(node.text, region.text).map((index) => ({
      node,
      index: index + edit.start,
    })),
  )
  if (canonicalMatches.length !== 1) {
    canonicalMatches = candidateNodes.flatMap((node) =>
      occurrenceIndexes(node.text, currentBoundary).map((index) => ({
        node,
        index: index + edit.start - boundaryStart,
      })),
    )
  }
  if (canonicalMatches.length !== 1) return false
  const canonicalMatch = canonicalMatches[0]
  const removedText = currentRegionText.slice(
    edit.start,
    edit.start + edit.count,
  )
  if (
    canonicalMatch.node.text.slice(
      canonicalMatch.index,
      canonicalMatch.index + edit.count,
    ) !== removedText
  ) {
    return false
  }

  const originalRegionText = region.text
  region.text = resolvedRegionText
  canonicalMatch.node.text = `${canonicalMatch.node.text.slice(0, canonicalMatch.index)}${canonicalMatch.node.text.slice(canonicalMatch.index + edit.count)}`
  updateNodeRanges(canonicalMatch.node, canonicalMatch.index, edit.count)

  for (const relationship of reconstruction.noteRelationships) {
    if (relationship.referenceRegionId === regionId) {
      const range = shiftedRange(
        relationship.referenceStart,
        relationship.referenceEnd,
        edit.start,
        edit.count,
      )
      relationship.referenceStart = range.start
      relationship.referenceEnd = range.end
    }
    const anchor = relationship.canonicalAnchor
    if (anchor?.kind === 'node' && anchor.nodeId === canonicalMatch.node.id) {
      const range = shiftedRange(
        anchor.start,
        anchor.end,
        canonicalMatch.index,
        edit.count,
      )
      anchor.start = range.start
      anchor.end = range.end
    }
  }
  for (const relationship of reconstruction.citationRelationships) {
    if (relationship.referenceRegionId === regionId) {
      const range = shiftedRange(
        relationship.referenceStart,
        relationship.referenceEnd,
        edit.start,
        edit.count,
      )
      relationship.referenceStart = range.start
      relationship.referenceEnd = range.end
    }
    if (relationship.canonicalAnchor?.nodeId === canonicalMatch.node.id) {
      const range = shiftedRange(
        relationship.canonicalAnchor.start,
        relationship.canonicalAnchor.end,
        canonicalMatch.index,
        edit.count,
      )
      relationship.canonicalAnchor.start = range.start
      relationship.canonicalAnchor.end = range.end
    }
  }
  for (const relationship of reconstruction.crossReferenceRelationships) {
    if (relationship.referenceRegionId === regionId) {
      const range = shiftedRange(
        relationship.referenceStart,
        relationship.referenceEnd,
        edit.start,
        edit.count,
      )
      relationship.referenceStart = range.start
      relationship.referenceEnd = range.end
      relationship.targets = relationship.targets.map((target) => {
        const targetRange = shiftedRange(
          target.referenceStart,
          target.referenceEnd,
          edit.start,
          edit.count,
        )
        return {
          ...target,
          referenceStart: targetRange.start,
          referenceEnd: targetRange.end,
        }
      })
    }
    if (relationship.canonicalAnchor?.nodeId === canonicalMatch.node.id) {
      const range = shiftedRange(
        relationship.canonicalAnchor.start,
        relationship.canonicalAnchor.end,
        canonicalMatch.index,
        edit.count,
      )
      relationship.canonicalAnchor.start = range.start
      relationship.canonicalAnchor.end = range.end
    }
  }
  for (const diagnostic of reconstruction.diagnostics) {
    const classification = diagnostic.noteMarkerClassification
    if (classification?.referenceRegionId !== regionId) continue
    const range = shiftedRange(
      classification.start,
      classification.end,
      edit.start,
      edit.count,
    )
    classification.start = range.start
    classification.end = range.end
  }
  for (const key of ['title', 'subtitle', 'abstract'] as const) {
    const value = reconstruction.paper[key]
    if (occurrenceIndexes(value, originalRegionText).length === 1) {
      reconstruction.paper[key] = value.replace(
        originalRegionText,
        resolvedRegionText,
      )
    } else if (occurrenceIndexes(value, currentBoundary).length === 1) {
      reconstruction.paper[key] = value.replace(
        currentBoundary,
        resolvedBoundary,
      )
    }
  }
  return true
}

function updateLineJoin(
  reconstruction: PdfReconstruction,
  decision: HumanAdjudicationRecord,
) {
  if (
    decision.diagnosticCode !== 'UNRESOLVED_CORRUPTING_JOIN' ||
    decision.resolution.type !== 'resolve-line-join'
  ) {
    return false
  }
  const resolution = decision.resolution
  const transition = reconstruction.lineBoundaryDecisions.find(
    (candidate) => candidate.id === resolution.transition.id,
  )
  if (
    !transition ||
    (transition.outcome !== 'unresolved' &&
      transition.outcome !== 'ambiguous') ||
    transition.regionId !== resolution.transition.regionId ||
    transition.fromLineId !== resolution.transition.fromLineId ||
    transition.toLineId !== resolution.transition.toLineId ||
    decision.target.markerId !== transition.id ||
    !sameValues(decision.target.regionIds, [transition.regionId])
  ) {
    return false
  }
  const region = reconstruction.regions.find(
    (candidate) => candidate.id === transition.regionId,
  )
  if (!region || !buildPdfLineJoinReviewContext(region, transition)) {
    return false
  }
  if (
    resolution.outcome !== 'leave-unresolved' &&
    !resolveLineJoinText(
      reconstruction,
      transition.regionId,
      transition.fromLineId,
      transition.toLineId,
      resolution.outcome === 'remove-wrap-hyphen'
        ? 'removed-discretionary-hyphen'
        : 'preserved-lexical-hyphen',
    )
  ) {
    return false
  }

  transition.outcome =
    resolution.outcome === 'remove-wrap-hyphen'
      ? 'removed-discretionary-hyphen'
      : resolution.outcome === 'preserve-authored-hyphen'
        ? 'preserved-lexical-hyphen'
        : 'unresolved'
  const retainedEvidence =
    resolution.outcome === 'leave-unresolved'
      ? transition.evidence
      : transition.evidence.filter(
          (evidence) => evidence !== 'source-line-separator-preserved',
        )
  transition.evidence = [
    ...new Set([...retainedEvidence, ...resolution.evidence]),
  ]
  reconstruction.unresolvedCorruptingJoinCount =
    reconstruction.lineBoundaryDecisions.filter(
      (candidate) =>
        candidate.outcome === 'unresolved' || candidate.outcome === 'ambiguous',
    ).length
  reconstruction.structurallyConsumedLineBoundaryCount =
    reconstruction.lineBoundaryDecisions.filter(
      (candidate) => candidate.outcome === 'structural-boundary',
    ).length
  return true
}

function updateEquationTranscript(
  reconstruction: PdfReconstruction,
  diagnostic: ReconstructionDiagnostic,
  decision: HumanAdjudicationRecord,
) {
  if (
    diagnostic.code !== 'UNRESOLVED_EQUATION_TRANSCRIPT' ||
    decision.diagnosticCode !== 'UNRESOLVED_EQUATION_TRANSCRIPT' ||
    decision.resolution.type !== 'accept-equation-transcript'
  ) {
    return false
  }
  const resolution = decision.resolution
  const relationship = reconstruction.visualRelationships.find(
    (candidate) => candidate.id === resolution.relationshipId,
  )
  if (
    !relationship ||
    diagnostic.relationshipId !== relationship.id ||
    diagnostic.target?.markerId !== relationship.id ||
    !sameTarget(decision.target, {
      markerId: relationship.id,
      regionIds: relationship.sourceRegionIds,
    })
  ) {
    return false
  }
  const binding = equationTranscriptDecisionBinding(
    reconstruction,
    relationship.id,
  )
  if (
    !binding ||
    binding.relationshipFingerprintSha256 !==
      resolution.relationshipFingerprintSha256 ||
    binding.sourceCropAssetId !== resolution.sourceCropAssetId ||
    binding.sourceCropAssetSha256 !== resolution.sourceCropAssetSha256
  ) {
    return false
  }
  const canonicalNodes = reconstruction.paper.nodes.filter(
    (node) => node.id === relationship.canonicalNodeId,
  )
  if (canonicalNodes.length !== 1 || canonicalNodes[0].type !== 'figure') {
    return false
  }
  const canonicalNode = canonicalNodes[0]
  const transcriptSha256 = sha256HexSync(resolution.transcript)
  relationship.sourceText = resolution.transcript
  relationship.evidence = [
    ...relationship.evidence,
    ...OWNER_EQUATION_TRANSCRIPT_EVIDENCE,
  ].filter((evidence, index, values) => values.indexOf(evidence) === index)
  relationship.equationTranscriptAdjudication = {
    schemaVersion: '1.0.0',
    format: resolution.format,
    source: 'owner-local-adjudication',
    transcriptSha256,
    relationshipFingerprintSha256: resolution.relationshipFingerprintSha256,
    sourceCropAssetId: resolution.sourceCropAssetId,
    sourceCropAssetSha256: resolution.sourceCropAssetSha256,
  }
  canonicalNode.sourceText = resolution.transcript
  return true
}

function completeVisualCandidateAssets(
  reconstruction: PdfReconstruction,
  candidate: {
    assetIds: readonly string[]
    sourceObjectIds: readonly string[]
    sourceBoxes: readonly { page: number }[]
  },
) {
  const { assetIds } = candidate
  if (assetIds.length === 0 || new Set(assetIds).size !== assetIds.length) {
    return false
  }
  return assetIds.every((assetId) => {
    const matches = reconstruction.assets.filter(
      (asset) => asset.id === assetId,
    )
    const asset = matches[0]
    return (
      matches.length === 1 &&
      asset.bytes.byteLength > 0 &&
      asset.width > 0 &&
      asset.height > 0 &&
      asset.sourceObjectIds.length > 0 &&
      asset.sourceBoxes.length > 0 &&
      candidate.sourceObjectIds.every((sourceObjectId) =>
        asset.sourceObjectIds.includes(sourceObjectId),
      ) &&
      candidate.sourceBoxes.every((sourceBox) =>
        asset.sourceBoxes.some((assetBox) => assetBox.page === sourceBox.page),
      ) &&
      /^[a-f0-9]{64}$/u.test(asset.sha256)
    )
  })
}

function updateVisualMatch(
  reconstruction: PdfReconstruction,
  diagnostic: ReconstructionDiagnostic,
  decision: HumanAdjudicationRecord,
  evidenceOrigin:
    'human-adjudication' | PdfCandidateResolutionOrigin = 'human-adjudication',
) {
  if (
    (diagnostic.code !== 'AMBIGUOUS_VISUAL_MATCH' &&
      diagnostic.code !== 'UNRESOLVED_VISUAL_OBJECT') ||
    (decision.resolution.type !== 'accept-visual-match' &&
      decision.resolution.type !== 'accept-visual-fallback')
  ) {
    return false
  }
  const resolution = decision.resolution
  const relationship = reconstruction.visualRelationships.find(
    (candidate) => candidate.id === resolution.relationshipId,
  )
  if (
    !relationship ||
    relationship.status === 'matched' ||
    diagnostic.target?.markerId !== relationship.id ||
    !sameTarget(decision.target, diagnostic.target)
  ) {
    return false
  }
  const resolutionInputConfidence = relationship.confidence
  const candidates = relationship.candidates.filter(
    (candidate) =>
      visualDecisionCandidateId(relationship, candidate) ===
      resolution.candidateId,
  )
  if (candidates.length !== 1) return false
  const candidate = candidates[0]
  if (
    candidate.sourceObjectIds.length === 0 ||
    !completeVisualCandidateAssets(reconstruction, candidate)
  ) {
    return false
  }

  const captionNodeId =
    relationship.captionNodeId ??
    reconstruction.paper.nodes.find(
      (node) =>
        node.type === 'caption' &&
        reconstruction.provenance[node.id]?.regionIds.length === 1 &&
        reconstruction.provenance[node.id]?.regionIds[0] ===
          relationship.captionRegionId,
    )?.id ??
    null
  const captionNode = reconstruction.paper.nodes.find(
    (node) => node.id === captionNodeId && node.type === 'caption',
  )
  if (!captionNodeId || !captionNode) return false

  const competingSourceOwner = reconstruction.paper.nodes.some(
    (node) =>
      node.id !== captionNodeId &&
      reconstruction.provenance[node.id]?.regionIds.some((regionId) =>
        candidate.sourceRegionIds.includes(regionId),
      ),
  )
  if (competingSourceOwner) return false

  const captionBox =
    reconstruction.provenance[captionNodeId]?.boxes[0] ??
    reconstruction.regions.find(
      (region) => region.id === relationship.captionRegionId,
    )?.box
  const page = captionBox?.page ?? candidate.sourceBoxes[0]?.page
  if (!captionBox || !page) return false

  const materializedRelationship = {
    ...relationship,
    captionNodeId,
    sourceRegionIds: [...candidate.sourceRegionIds],
    sourceLineIds: [...(candidate.sourceLineIds ?? [])],
    sourceObjectIds: [...candidate.sourceObjectIds],
    assetIds: [...candidate.assetIds],
    status: 'matched' as const,
    confidence: candidate.score,
    evidence: [
      ...candidate.evidence,
      evidenceOrigin === 'human-adjudication'
        ? 'human-adjudicated-visual-match'
        : evidenceOrigin,
      ...(evidenceOrigin === 'human-adjudication'
        ? [`human-adjudicated-visual-kind:${relationship.kind}`]
        : []),
      evidenceOrigin === 'human-adjudication'
        ? // `toLocaleLowerCase` folds by the runtime's locale: under `tr`/`az`
          // `AMBIGUOUS_VISUAL_MATCH` becomes `ambıguous_vısual_match`, and
          // these strings are serialized into both the EPUB manifest and the
          // STRUCT relationships. The published bytes must not depend on the
          // host's locale.
          `human-adjudicated-${diagnostic.code.toLowerCase()}`
        : evidenceOrigin === 'model-consultation'
          ? `model-consulted-${diagnostic.code.toLowerCase()}`
          : `deterministically-distilled-${diagnostic.code.toLowerCase()}`,
    ],
    sourceBoxes: [
      { ...captionBox },
      ...candidate.sourceBoxes.map((box) => ({ ...box })),
    ],
    sourceText: candidate.sourceText ?? relationship.sourceText,
  }
  const canonicalNodeId = visualCanonicalNodeId(materializedRelationship, page)
  if (
    reconstruction.paper.nodes.some((node) => node.id === canonicalNodeId) ||
    reconstruction.provenance[canonicalNodeId]
  ) {
    return false
  }
  Object.assign(relationship, materializedRelationship, { canonicalNodeId })
  if (evidenceOrigin === 'human-adjudication') {
    delete relationship.resolutionInputConfidence
  } else {
    relationship.resolutionInputConfidence = resolutionInputConfidence
  }
  const canonicalNode = materializeCanonicalVisualNode({
    relationship,
    id: canonicalNodeId,
    captionNodeId,
    source: `pdf:${reconstruction.source.sha256.slice(0, 16)}#page=${page}`,
    sourceText: relationship.sourceText.trim()
      ? relationship.sourceText
      : undefined,
  })
  const captionIndex = reconstruction.paper.nodes.findIndex(
    (node) => node.id === captionNodeId,
  )
  reconstruction.paper.nodes.splice(
    captionIndex < 0 ? reconstruction.paper.nodes.length : captionIndex,
    0,
    canonicalNode,
  )
  reconstruction.provenance[canonicalNodeId] = {
    confidence: candidate.score,
    pages: [
      ...new Set(relationship.sourceBoxes.map((sourceBox) => sourceBox.page)),
    ],
    regionIds: [...candidate.sourceRegionIds],
    boxes: relationship.sourceBoxes.map((box) => ({ ...box })),
    links: [],
    relationshipIds: [relationship.id],
  }
  return true
}

function updateVisualDecoration(
  reconstruction: PdfReconstruction,
  diagnostic: ReconstructionDiagnostic,
  decision: HumanAdjudicationRecord,
) {
  if (
    (diagnostic.code !== 'AMBIGUOUS_VISUAL_MATCH' &&
      diagnostic.code !== 'UNRESOLVED_VISUAL_OBJECT') ||
    decision.resolution.type !== 'classify-visual-decoration'
  ) {
    return null
  }
  const resolution = decision.resolution
  const relationship = reconstruction.visualRelationships.find(
    (candidate) => candidate.id === resolution.relationshipId,
  )
  if (
    !relationship ||
    diagnostic.target?.markerId !== relationship.id ||
    !sameTarget(decision.target, diagnostic.target)
  ) {
    return null
  }
  const legalObjectIds = new Set(
    relationship.candidates.flatMap((candidate) => candidate.sourceObjectIds),
  )
  if (
    resolution.sourceObjectIds.some(
      (sourceObjectId) => !legalObjectIds.has(sourceObjectId),
    )
  ) {
    return null
  }
  const occurrences = new Map<string, number>()
  for (const page of reconstruction.pages) {
    for (const object of page.objects ?? []) {
      occurrences.set(object.id, (occurrences.get(object.id) ?? 0) + 1)
    }
  }
  if (
    resolution.sourceObjectIds.some(
      (sourceObjectId) => occurrences.get(sourceObjectId) !== 1,
    )
  ) {
    return null
  }
  const removed = new Set(resolution.sourceObjectIds)
  for (const page of reconstruction.pages) {
    if (page.objects) {
      page.objects = page.objects.filter((object) => !removed.has(object.id))
    }
  }
  relationship.evidence = [
    ...relationship.evidence,
    'human-adjudicated-visual-decoration',
    `decoration-reason:${resolution.reason}`,
  ]
  return {
    relationshipId: relationship.id,
    sourceObjectIds: [...resolution.sourceObjectIds],
    reason: resolution.reason,
    oldExpectedObjectDenominator: reconstruction.completeness.sourceAssetCount,
  }
}

function legalDismissal(diagnostic: ReconstructionDiagnostic) {
  return diagnostic.severity !== 'error'
}

export function reassessPdfReconstruction(
  reconstruction: PdfReconstruction,
  additionalDiagnostics: ReconstructionDiagnostic[] = [],
) {
  const assessment = assessPdfCompleteness({
    pages: reconstruction.pages,
    sourceSha256: reconstruction.source.sha256,
    paper: reconstruction.paper,
    diagnostics: reconstruction.diagnostics,
    readingOrder: reconstruction.readingOrder,
    regions: reconstruction.regions,
    visualRelationships: reconstruction.visualRelationships,
    assets: reconstruction.assets,
    citationRelationships: reconstruction.citationRelationships,
    noteRelationships: reconstruction.noteRelationships,
    provenance: reconstruction.provenance,
    lineBoundaryDecisions: reconstruction.lineBoundaryDecisions,
    sourceSemanticFlowBoundaryDecisions:
      reconstruction.sourceSemanticFlowBoundaryDecisions,
    sourceSemanticFlowBoundaryDecisionCount:
      reconstruction.sourceSemanticFlowBoundaryDecisionCount,
    canonicalHyphenBoundaryDecisions:
      reconstruction.canonicalHyphenBoundaryDecisions,
    canonicalHyphenBoundaryDecisionCount:
      reconstruction.canonicalHyphenBoundaryDecisionCount,
    unresolvedCorruptingJoinCount: reconstruction.unresolvedCorruptingJoinCount,
    structurallyConsumedLineBoundaryCount:
      reconstruction.structurallyConsumedLineBoundaryCount,
    inlineSpanLedger: {
      expected: reconstruction.completeness.expectedInlineSpanCount,
      mapped: reconstruction.completeness.mappedInlineSpanCount,
    },
    policy: reconstruction.readiness.policy,
    reclassifiedNoteReferenceCount: reconstruction.noteRelationships.filter(
      (relationship) =>
        relationship.status === 'citation' ||
        relationship.status === 'plain-text',
    ).length,
    reclassifiedCitationCount: reconstruction.noteRelationships.filter(
      (relationship) => relationship.status === 'citation',
    ).length,
  })
  reconstruction.semanticSignals = assessment.semanticSignals
  reconstruction.completeness = assessment.completeness
  reconstruction.diagnostics = [
    ...assessment.diagnostics,
    ...additionalDiagnostics,
  ]
  reconstruction.readiness = assessment.readiness
  return reconstruction
}

export function applyVerifiedPdfCandidateResolutions(
  reconstruction: PdfReconstruction,
  resolutions: readonly VerifiedPdfCandidateResolution[],
) {
  const result = structuredClone(reconstruction)
  const applied: HumanAdjudicationRecord[] = []

  for (const { decision: rawDecision, origin } of resolutions) {
    const parsed = humanAdjudicationRecordSchema.safeParse(rawDecision)
    if (!parsed.success) continue
    const decision = normalizedRecord(parsed.data as HumanAdjudicationRecord)
    const diagnostic = diagnosticForDecision(result, decision)
    if (!diagnostic) continue

    const legalModelResolution =
      (decision.diagnosticCode === 'AMBIGUOUS_NOTE_MATCH' &&
        decision.resolution.type === 'accept-note-match') ||
      (decision.diagnosticCode === 'AMBIGUOUS_READING_ORDER' &&
        decision.resolution.type === 'accept-reading-order') ||
      (decision.diagnosticCode === 'AMBIGUOUS_VISUAL_MATCH' &&
        decision.resolution.type === 'accept-visual-match')
    if (!legalModelResolution) continue

    const appliedLegally =
      updateNoteRelationship(result, decision, origin) ||
      updateReadingOrder(result, diagnostic, decision, origin) ||
      updateVisualMatch(result, diagnostic, decision, origin)
    if (!appliedLegally) continue

    result.diagnostics = result.diagnostics.filter(
      (candidate) => candidate !== diagnostic,
    )
    applied.push(decision)
  }

  if (applied.length > 0) {
    result.diagnostics = result.diagnostics.filter(
      (diagnostic) => !QUALITY_DIAGNOSTIC_CODES.has(diagnostic.code),
    )
    reassessPdfReconstruction(result)
  }
  return { reconstruction: result, applied }
}

export function applyHumanDecisionFile(
  reconstruction: PdfReconstruction,
  input: HumanDecisionFile,
  options: {
    emptyFilePolicy?: 'reassess' | 'reuse-fresh-assessment'
  } = {},
) {
  const file = humanDecisionFileSchema.parse(input)
  const existingAdjudications = reconstruction.humanAdjudications
  if (
    options.emptyFilePolicy === 'reuse-fresh-assessment' &&
    file.decisions.length === 0 &&
    file.documentSha256 === reconstruction.source.sha256 &&
    existingAdjudications.applied.length === 0 &&
    existingAdjudications.stale.length === 0 &&
    Object.keys(existingAdjudications.countsByDiagnosticCode).length === 0 &&
    !reconstruction.diagnostics.some(
      (diagnostic) => diagnostic.code === 'STALE_HUMAN_DECISION',
    )
  ) {
    return rebindModelConsultationReceipt(reconstruction, {
      ...reconstruction,
      humanAdjudications: {
        schemaVersion: file.schemaVersion,
        documentSha256: reconstruction.source.sha256,
        applied: [],
        stale: [],
        countsByDiagnosticCode: {},
      },
    })
  }
  const result = structuredClone(reconstruction)
  const decisionDiagnostics = [...result.diagnostics]
  result.diagnostics = result.diagnostics.filter(
    (diagnostic) =>
      !QUALITY_DIAGNOSTIC_CODES.has(diagnostic.code) &&
      diagnostic.code !== 'STALE_HUMAN_DECISION',
  )
  const applied: HumanAdjudicationRecord[] = []
  const stale: PdfReconstruction['humanAdjudications']['stale'] = []
  const visualDecorationReceipts: Array<{
    relationshipId: string
    sourceObjectIds: string[]
    reason:
      'page-furniture' | 'separator-rule' | 'decorative-ornament' | 'background'
    oldExpectedObjectDenominator: number
  }> = []

  for (const rawDecision of file.decisions) {
    const decision = normalizedRecord(rawDecision)
    if (file.documentSha256 !== result.source.sha256) {
      stale.push({ ...decision, reason: 'document-sha256-mismatch' })
      continue
    }
    if (decision.resolution.type === 'resolve-line-join') {
      if (!updateLineJoin(result, decision)) {
        stale.push({ ...decision, reason: 'resolution-no-longer-legal' })
        continue
      }
      applied.push(decision)
      continue
    }
    if (decision.resolution.type === 'accept-equation-transcript') {
      const diagnostic = decisionDiagnostics.find(
        (candidate) =>
          candidate.code === decision.diagnosticCode &&
          candidate.target &&
          sameTarget(candidate.target, decision.target),
      )
      if (
        !diagnostic ||
        !updateEquationTranscript(result, diagnostic, decision)
      ) {
        stale.push({
          ...decision,
          reason: diagnostic
            ? 'resolution-no-longer-legal'
            : 'diagnostic-target-missing',
        })
        continue
      }
      applied.push(decision)
      continue
    }
    if (
      decision.resolution.type === 'accept-visual-match' ||
      decision.resolution.type === 'accept-visual-fallback' ||
      decision.resolution.type === 'classify-visual-decoration'
    ) {
      const diagnostic = decisionDiagnostics.find(
        (candidate) =>
          candidate.code === decision.diagnosticCode &&
          candidate.target &&
          sameTarget(candidate.target, decision.target),
      )
      const decorationReceipt =
        diagnostic && decision.resolution.type === 'classify-visual-decoration'
          ? updateVisualDecoration(result, diagnostic, decision)
          : null
      const appliedLegally = diagnostic
        ? decorationReceipt !== null ||
          updateVisualMatch(result, diagnostic, decision)
        : false
      if (
        !diagnostic &&
        existingAdjudications.applied.some((candidate) =>
          sameDecision(candidate, decision),
        ) &&
        visualDecisionStillInstalled(result, decision)
      ) {
        applied.push(decision)
        continue
      }
      if (!diagnostic || !appliedLegally) {
        stale.push({
          ...decision,
          reason: diagnostic
            ? 'resolution-no-longer-legal'
            : 'diagnostic-target-missing',
        })
        continue
      }
      result.diagnostics = result.diagnostics.filter(
        (candidate) =>
          !(
            candidate.code === diagnostic.code &&
            candidate.target &&
            sameTarget(candidate.target, diagnostic.target!)
          ),
      )
      if (decorationReceipt) {
        visualDecorationReceipts.push(decorationReceipt)
      }
      applied.push(decision)
      continue
    }
    const diagnostic = diagnosticForDecision(result, decision)
    if (!diagnostic) {
      if (
        existingAdjudications.applied.some((candidate) =>
          sameDecision(candidate, decision),
        ) &&
        (readingOrderDecisionStillInstalled(result, decision) ||
          noteDecisionStillInstalled(result, decision))
      ) {
        applied.push(decision)
        continue
      }
      stale.push({ ...decision, reason: 'diagnostic-target-missing' })
      continue
    }

    const appliedLegally =
      updateNoteRelationship(result, decision) ||
      updateReadingOrder(result, diagnostic, decision) ||
      (decision.resolution.type === 'dismiss' && legalDismissal(diagnostic))
    if (!appliedLegally) {
      stale.push({ ...decision, reason: 'resolution-no-longer-legal' })
      continue
    }
    result.diagnostics = result.diagnostics.filter(
      (candidate) => candidate !== diagnostic,
    )
    applied.push(decision)
  }

  reassessPdfReconstruction(
    result,
    stale.map<ReconstructionDiagnostic>((decision) => ({
      code: 'STALE_HUMAN_DECISION',
      severity: 'warning',
      message: `A saved ${decision.diagnosticCode} decision is stale (${decision.reason}).`,
      target: { ...decision.target, regionIds: [...decision.target.regionIds] },
    })),
  )
  const countsByDiagnosticCode = applied.reduce<Record<string, number>>(
    (counts, decision) => {
      counts[decision.diagnosticCode] =
        (counts[decision.diagnosticCode] ?? 0) + 1
      return counts
    },
    {},
  )
  result.humanAdjudications = {
    schemaVersion: file.schemaVersion,
    documentSha256: result.source.sha256,
    applied,
    stale,
    countsByDiagnosticCode,
    ...(visualDecorationReceipts.length > 0
      ? {
          visualDecorationReceipts: visualDecorationReceipts.map((receipt) => ({
            ...receipt,
            newExpectedObjectDenominator: result.completeness.sourceAssetCount,
            resultingCoverage: result.completeness.assetCoverage,
          })),
        }
      : {}),
  }
  return rebindModelConsultationReceipt(reconstruction, result)
}

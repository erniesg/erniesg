import {
  applyVerifiedPdfCandidateResolutions,
  readingOrderCandidates,
  visualDecisionCandidateId,
  type VerifiedPdfCandidateResolution,
} from './decision-record'
import type {
  HumanAdjudicationRecord,
  PdfReadingOrderResolution,
  PdfReconstruction,
  PdfVisualMatchCandidate,
  PdfVisualRelationship,
  ReconstructionDiagnostic,
} from './import-types'
import {
  MODEL_FALLBACK_DECISION_CLASSES,
  MODEL_FALLBACK_EVIDENCE_CODES,
  DistillationLedger,
  ModelConsultationGate,
  type ModelConsultationGateOptions,
  type ModelConsultationMetrics,
  type ModelConsultationRecord,
  type ModelDecisionMetricEvent,
  type ModelFallbackChoice,
  type ModelFallbackDecisionPoint,
  type ModelFallbackReceipt,
  validateModelConsultationReceipt,
} from './model-fallback'
import {
  pdfModelConsultationSemanticStateSha256,
  stableModelConsultationJson,
} from './model-consultation-binding'
import { pdfVisualMatchCandidateId } from './pdf-visuals'
import { sha256HexSync } from './sha256-sync'

export { pdfModelConsultationSemanticStateSha256 } from './model-consultation-binding'

type BoundPdfDecisionPoint = {
  point: ModelFallbackDecisionPoint
  decisionFor: (choice: ModelFallbackChoice) => HumanAdjudicationRecord | null
}

export const PRODUCTION_PDF_MODEL_FALLBACK_OPTIONS = Object.freeze({
  enabled: false,
  ownerOptIn: false,
}) satisfies ModelConsultationGateOptions

export const PDF_CAPTION_UNIQUE_BOUNDED_DISTANCE_RULE_ID =
  'pdf-caption-unique-bounded-distance-v1' as const

const SAFE_EVIDENCE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const CAPTION_DIRECTION_EVIDENCE = new Set([
  'object-above-caption',
  'object-below-caption',
])

function safeEvidenceCodes(
  values: readonly string[],
  allowedValues: readonly string[],
) {
  const allowed = new Set(allowedValues)
  return [
    ...new Set(
      values.filter(
        (value) => SAFE_EVIDENCE_CODE.test(value) && allowed.has(value),
      ),
    ),
  ].sort()
}

/**
 * Retire only the narrow, source-backed caption ambiguity proved by one
 * uniquely bounded same-page candidate. Candidate order is never evidence.
 */
export function resolveCaptionAssociationByUniqueBoundedDistance(
  point: ModelFallbackDecisionPoint,
) {
  if (
    point.decisionClass !==
      MODEL_FALLBACK_DECISION_CLASSES.captionAssociation ||
    point.candidates.length < 2
  )
    return null
  const kinds = new Set<unknown>()
  const bounded = []
  for (const candidate of point.candidates) {
    if (candidate.kind !== 'figure') return null
    kinds.add(candidate.kind)
    if (
      !Array.isArray(candidate.evidence_codes) ||
      !candidate.evidence_codes.every(
        (code) => typeof code === 'string' && SAFE_EVIDENCE_CODE.test(code),
      )
    )
      return null
    const evidence = new Set(candidate.evidence_codes)
    if (!evidence.has('same-page-scope')) return null
    if (evidence.has('bounded-distance')) bounded.push({ candidate, evidence })
  }
  if (kinds.size !== 1 || bounded.length !== 1) return null
  const selected = bounded[0]!
  if (
    [...CAPTION_DIRECTION_EVIDENCE].filter((code) =>
      selected.evidence.has(code),
    ).length !== 1
  )
    return null
  return selected.candidate.id
}

function stableCandidateId(prefix: string, values: readonly string[]) {
  return `${prefix}-${sha256HexSync(JSON.stringify(values)).slice(0, 24)}`
}

type PdfNoteCandidate =
  PdfReconstruction['noteRelationships'][number]['candidates'][number]

function noteCandidateSetSha256(candidates: readonly PdfNoteCandidate[]) {
  return sha256HexSync(
    stableModelConsultationJson(
      candidates.map((candidate) => [
        candidate.targetNoteId,
        candidate.targetRegionId,
        String(candidate.score),
        stableModelConsultationJson(candidate.sourceBoxes),
        stableModelConsultationJson(
          safeEvidenceCodes(
            candidate.evidence,
            MODEL_FALLBACK_EVIDENCE_CODES.noteMarkerMatch,
          ),
        ),
      ]),
    ),
  )
}

function noteModelCandidateId(
  relationship: PdfReconstruction['noteRelationships'][number],
  candidate: PdfNoteCandidate,
  candidateSetSha256: string,
) {
  return stableCandidateId('note-candidate', [
    stableModelConsultationJson({
      diagnostic_code: 'AMBIGUOUS_NOTE_MATCH',
      relationship_id: relationship.id,
      reference_region_id: relationship.referenceRegionId,
      reference_start: relationship.referenceStart,
      reference_end: relationship.referenceEnd,
      canonical_anchor: relationship.canonicalAnchor,
      confidence:
        relationship.resolutionInputConfidence ?? relationship.confidence,
      threshold: relationship.threshold,
      candidate_count: relationship.candidates.length,
    }),
    candidate.targetNoteId,
    candidate.targetRegionId,
    String(candidate.score),
    stableModelConsultationJson(candidate.sourceBoxes),
    candidateSetSha256,
  ])
}

function visualCandidateSetSha256(
  relationship: PdfReconstruction['visualRelationships'][number],
) {
  return sha256HexSync(
    stableModelConsultationJson(
      relationship.candidates.map((candidate) => [
        candidate.id ?? pdfVisualMatchCandidateId(relationship.id, candidate),
        relationship.kind,
        String(candidate.score),
        stableModelConsultationJson(candidate.sourceBoxes),
        stableModelConsultationJson(candidate.sourceRegionIds),
        stableModelConsultationJson(candidate.sourceLineIds ?? []),
        stableModelConsultationJson(candidate.sourceObjectIds),
        stableModelConsultationJson(candidate.assetIds),
        sha256HexSync(candidate.sourceText ?? relationship.sourceText ?? ''),
        stableModelConsultationJson(
          safeEvidenceCodes(
            candidate.evidence,
            MODEL_FALLBACK_EVIDENCE_CODES.captionAssociation,
          ),
        ),
      ]),
    ),
  )
}

function visualModelCandidateId(
  relationship: PdfReconstruction['visualRelationships'][number],
  candidate: PdfReconstruction['visualRelationships'][number]['candidates'][number],
  candidateSetSha256: string,
) {
  return stableCandidateId('visual-kind-candidate', [
    stableModelConsultationJson({
      diagnostic_code: 'AMBIGUOUS_VISUAL_MATCH',
      relationship_id: relationship.id,
      caption_region_id: relationship.captionRegionId,
      confidence:
        relationship.resolutionInputConfidence ?? relationship.confidence,
      candidate_count: relationship.candidates.length,
    }),
    candidate.id ?? pdfVisualMatchCandidateId(relationship.id, candidate),
    relationship.kind,
    String(candidate.score),
    stableModelConsultationJson(candidate.sourceBoxes),
    stableModelConsultationJson(candidate.sourceRegionIds),
    stableModelConsultationJson(candidate.sourceLineIds ?? []),
    stableModelConsultationJson(candidate.sourceObjectIds),
    stableModelConsultationJson(candidate.assetIds),
    sha256HexSync(candidate.sourceText ?? relationship.sourceText ?? ''),
    candidateSetSha256,
  ])
}

/**
 * The ambiguity inputs a reading-order decision was taken against. The tie's
 * own resolution survives the decision, so this is reconstructible from the
 * document long after the diagnostic that opened it is gone.
 */
function readingOrderAmbiguityEvidence(
  resolution: Omit<PdfReadingOrderResolution, 'regionIds'>,
) {
  return {
    page: resolution.page,
    ambiguity_class: resolution.ambiguityClass,
    confidence: resolution.confidence,
    threshold: resolution.threshold,
    evidence_codes: safeEvidenceCodes(
      resolution.evidence.map(({ code }) => code),
      MODEL_FALLBACK_EVIDENCE_CODES.readingOrderTie,
    ),
  }
}

function compareCodeUnits(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function immutableSnapshot<T>(
  value: T,
  seen = new WeakMap<object, unknown>(),
): T {
  if (!value || typeof value !== 'object') return value
  const prior = seen.get(value)
  if (prior) return prior as T
  if (value instanceof Uint8Array) return new Uint8Array(value) as T
  if (value instanceof Date) return new Date(value.getTime()) as T

  const copy: object = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(value))
  seen.set(value, copy)
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) continue
    Object.defineProperty(
      copy,
      key,
      Object.hasOwn(descriptor, 'value')
        ? {
            ...descriptor,
            value: immutableSnapshot(descriptor.value, seen),
          }
        : descriptor,
    )
  }
  return copy as T
}

function exactTarget(diagnostic: ReconstructionDiagnostic) {
  return diagnostic.target
    ? {
        regionIds: [...diagnostic.target.regionIds],
        markerId: diagnostic.target.markerId,
      }
    : null
}

function noteDecisionPoint(
  reconstruction: PdfReconstruction,
  diagnostic: ReconstructionDiagnostic,
): BoundPdfDecisionPoint | null {
  if (diagnostic.code !== 'AMBIGUOUS_NOTE_MATCH') return null
  const target = exactTarget(diagnostic)
  const relationship = reconstruction.noteRelationships.find(
    ({ id }) => id === target?.markerId,
  )
  if (!target || !relationship || relationship.candidates.length === 0)
    return null

  const candidateSetSha256 = noteCandidateSetSha256(relationship.candidates)
  const candidates = relationship.candidates.map((candidate) => ({
    id: noteModelCandidateId(relationship, candidate, candidateSetSha256),
    associationId: candidate.targetNoteId,
    note_id: candidate.targetNoteId,
    region_id: candidate.targetRegionId,
    score: candidate.score,
    evidence_codes: safeEvidenceCodes(
      candidate.evidence,
      MODEL_FALLBACK_EVIDENCE_CODES.noteMarkerMatch,
    ),
  }))
  const selectedByCandidateId = new Map(
    candidates.map((candidate, index) => {
      const selected = relationship.candidates[index]!
      return [
        candidate.id,
        {
          targetNoteId: selected.targetNoteId,
          targetRegionId: selected.targetRegionId,
        },
      ] as const
    }),
  )
  return {
    point: {
      documentId: reconstruction.paper.id,
      decisionId: relationship.id,
      decisionClass: MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
      sourceSha256: reconstruction.source.sha256,
      inputs: {
        diagnostic_code: diagnostic.code,
        relationship_id: relationship.id,
        reference_region_id: relationship.referenceRegionId,
        confidence: relationship.confidence,
        threshold: relationship.threshold,
        candidate_count: candidates.length,
      },
      candidates,
      status: 'ambiguous',
      insufficientEvidence: true,
    },
    decisionFor: ({ candidateId }) => {
      const selected = selectedByCandidateId.get(candidateId)
      return selected
        ? {
            diagnosticCode: diagnostic.code,
            target,
            resolution: {
              type: 'accept-note-match',
              targetNoteId: selected.targetNoteId,
              targetRegionId: selected.targetRegionId,
            },
          }
        : null
    },
  }
}

function readingOrderDecisionPoint(
  reconstruction: PdfReconstruction,
  diagnostic: ReconstructionDiagnostic,
): BoundPdfDecisionPoint | null {
  if (diagnostic.code !== 'AMBIGUOUS_READING_ORDER') return null
  const target = exactTarget(diagnostic)
  const orders = readingOrderCandidates(reconstruction, diagnostic)
  if (
    !target ||
    diagnostic.readingOrderResolution?.status !== 'ambiguous' ||
    orders.length < 2
  )
    return null
  const regionById = new Map(
    reconstruction.regions.map((region) => [region.id, region]),
  )
  if (orders.some((regionIds) => regionIds.some((id) => !regionById.has(id))))
    return null
  const evidence = diagnostic.readingOrderResolution
  const ambiguity = readingOrderAmbiguityEvidence(evidence)
  const candidates = orders.map((regionIds) => {
    const regions = regionIds.map((id) => {
      const region = regionById.get(id)!
      return {
        id: region.id,
        kind: region.kind,
        column: region.column,
        page: region.page,
      }
    })
    return {
      // A retired rule may key off any part of the decision point, so the
      // choice has to commit the whole of it. Committing only the order would
      // let the surviving ambiguity inputs move under a versioned rule that no
      // longer makes this choice.
      id: stableCandidateId('reading-order-candidate', [
        ...regionIds,
        stableModelConsultationJson(regions),
        stableModelConsultationJson(ambiguity),
      ]),
      region_ids: [...regionIds],
      regions,
      evidence_codes: [...ambiguity.evidence_codes],
    }
  })
  const regionIdsByCandidateId = new Map(
    candidates.map((candidate, index) => [candidate.id, [...orders[index]!]]),
  )
  return {
    point: {
      documentId: reconstruction.paper.id,
      decisionId: stableCandidateId(
        'reading-order-decision',
        [...new Set(target.regionIds)].sort(),
      ),
      decisionClass: MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie,
      sourceSha256: reconstruction.source.sha256,
      inputs: {
        diagnostic_code: diagnostic.code,
        page: ambiguity.page,
        ambiguity_class: ambiguity.ambiguity_class,
        confidence: ambiguity.confidence,
        threshold: ambiguity.threshold,
        candidate_count: candidates.length,
      },
      candidates,
      status: 'ambiguous',
      insufficientEvidence: true,
    },
    decisionFor: ({ candidateId }) => {
      const regionIds = regionIdsByCandidateId.get(candidateId)
      return regionIds
        ? {
            diagnosticCode: diagnostic.code,
            target,
            resolution: {
              type: 'accept-reading-order',
              regionIds: [...regionIds],
            },
          }
        : null
    },
  }
}

function visualDecisionPoint(
  reconstruction: PdfReconstruction,
  diagnostic: ReconstructionDiagnostic,
): BoundPdfDecisionPoint | null {
  if (diagnostic.code !== 'AMBIGUOUS_VISUAL_MATCH') return null
  const target = exactTarget(diagnostic)
  const relationship = reconstruction.visualRelationships.find(
    ({ id }) => id === target?.markerId,
  )
  if (!target || !relationship || relationship.candidates.length === 0)
    return null
  const candidateSetSha256 = visualCandidateSetSha256(relationship)
  const candidates = relationship.candidates.map((candidate) => ({
    id: visualModelCandidateId(relationship, candidate, candidateSetSha256),
    score: candidate.score,
    kind: relationship.kind,
    region_ids: [...candidate.sourceRegionIds],
    line_ids: [...(candidate.sourceLineIds ?? [])],
    object_ids: [...candidate.sourceObjectIds],
    asset_ids: [...candidate.assetIds],
    evidence_codes: safeEvidenceCodes(
      candidate.evidence,
      MODEL_FALLBACK_EVIDENCE_CODES.captionAssociation,
    ),
  }))
  const sourceCandidateIdByDecisionId = new Map(
    candidates.map((candidate, index) => [
      candidate.id,
      visualDecisionCandidateId(relationship, relationship.candidates[index]!),
    ]),
  )
  return {
    point: {
      documentId: reconstruction.paper.id,
      decisionId: relationship.id,
      decisionClass: MODEL_FALLBACK_DECISION_CLASSES.captionAssociation,
      sourceSha256: reconstruction.source.sha256,
      inputs: {
        diagnostic_code: diagnostic.code,
        relationship_id: relationship.id,
        caption_region_id: relationship.captionRegionId,
        kind: relationship.kind,
        confidence: relationship.confidence,
        candidate_count: candidates.length,
      },
      candidates,
      status: 'ambiguous',
      insufficientEvidence: true,
    },
    decisionFor: ({ candidateId }) => {
      const sourceCandidateId = sourceCandidateIdByDecisionId.get(candidateId)
      return sourceCandidateId
        ? {
            diagnosticCode: diagnostic.code,
            target,
            resolution: {
              type: 'accept-visual-match',
              relationshipId: relationship.id,
              candidateId: sourceCandidateId,
            },
          }
        : null
    },
  }
}

function boundModelDecisionPointsForPdf(reconstruction: PdfReconstruction) {
  return reconstruction.diagnostics
    .flatMap((diagnostic) => {
      const binding =
        noteDecisionPoint(reconstruction, diagnostic) ??
        readingOrderDecisionPoint(reconstruction, diagnostic) ??
        visualDecisionPoint(reconstruction, diagnostic)
      return binding ? [binding] : []
    })
    .sort(
      (left, right) =>
        compareCodeUnits(left.point.decisionClass, right.point.decisionClass) ||
        compareCodeUnits(left.point.decisionId, right.point.decisionId),
    )
}

export function modelDecisionPointsForPdf(reconstruction: PdfReconstruction) {
  return boundModelDecisionPointsForPdf(reconstruction).map(({ point }) =>
    structuredClone(point),
  )
}

function decisionKey(decisionClass: string, decisionId: string) {
  return `${decisionClass}\u0000${decisionId}`
}

function consultationMetrics(
  decisions: readonly ModelDecisionMetricEvent[],
): ModelConsultationMetrics {
  const metricsByDecisionClass = new Map<
    string,
    {
      decisionCount: number
      consultationCount: number
      consultationRate: number
    }
  >()
  for (const decision of decisions) {
    const current = metricsByDecisionClass.get(decision.decisionClass) ?? {
      decisionCount: 0,
      consultationCount: 0,
      consultationRate: 0,
    }
    current.decisionCount += 1
    if (decision.consulted) current.consultationCount += 1
    current.consultationRate = current.consultationCount / current.decisionCount
    metricsByDecisionClass.set(decision.decisionClass, current)
  }
  const byDecisionClass = Object.fromEntries(
    metricsByDecisionClass,
  ) as ModelConsultationMetrics['byDecisionClass']
  const totalDecisionCount = decisions.length
  const totalConsultationCount = Object.values(byDecisionClass).reduce(
    (sum, metric) => sum + metric.consultationCount,
    0,
  )
  return {
    totalDecisionCount,
    totalConsultationCount,
    consultationRate:
      totalDecisionCount === 0
        ? 0
        : totalConsultationCount / totalDecisionCount,
    byDecisionClass,
  }
}

function appendReceiptHistory(
  prior: ModelFallbackReceipt,
  current: ModelFallbackReceipt,
): ModelFallbackReceipt {
  const consultations = [
    ...structuredClone(prior.consultations),
    ...current.consultations,
  ]
  const decisions = [...structuredClone(prior.decisions), ...current.decisions]
  return {
    schemaVersion: current.schemaVersion,
    documentId: current.documentId,
    sourceSha256: current.sourceSha256,
    consultations,
    decisions,
    metrics: consultationMetrics(decisions),
  }
}

function sameStringList(left: unknown, right: readonly string[]) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

/**
 * `updateReadingOrder` stamps a resolution's origin by region set, so the
 * resolution and the adjudication target may legitimately list the same tied
 * regions in different orders. Accounting has to use the same equality.
 */
function sameRegionSet(left: readonly string[], right: readonly string[]) {
  const target = new Set(right)
  return (
    new Set(left).size === target.size &&
    [...new Set(left)].every((id) => target.has(id))
  )
}

function visualInstalledSourceBoxes(
  reconstruction: PdfReconstruction,
  relationship: PdfVisualRelationship,
  candidate: PdfVisualMatchCandidate,
) {
  const captionBox =
    (relationship.captionNodeId
      ? reconstruction.provenance[relationship.captionNodeId]?.boxes[0]
      : undefined) ??
    reconstruction.regions.find(({ id }) => id === relationship.captionRegionId)
      ?.box
  return captionBox
    ? [{ ...captionBox }, ...candidate.sourceBoxes.map((box) => ({ ...box }))]
    : null
}

function humanNoteSourceAnchorMatches(
  reconstruction: PdfReconstruction,
  adjudication: HumanAdjudicationRecord,
  relationship: PdfReconstruction['noteRelationships'][number],
) {
  if (adjudication.resolution.type !== 'accept-note-match') return false
  const candidateTargetRegionIds = new Set(
    relationship.candidates.map(({ targetRegionId }) => targetRegionId),
  )
  const sourceRegionIds = adjudication.target.regionIds.filter(
    (regionId) => !candidateTargetRegionIds.has(regionId),
  )
  if (
    sourceRegionIds.length !== 1 ||
    sourceRegionIds[0] !== relationship.referenceRegionId
  ) {
    return false
  }

  const anchor = relationship.canonicalAnchor
  if (!anchor) return false
  if (anchor.kind === 'author') {
    return (
      reconstruction.paper.authorNotes?.filter(
        ({ id, author, label, target }) =>
          id === relationship.id &&
          author === anchor.author &&
          label === relationship.label &&
          target === relationship.targetNoteId,
      ).length === 1
    )
  }
  if (
    anchor.start !== relationship.referenceStart ||
    anchor.end !== relationship.referenceEnd
  ) {
    return false
  }
  const matchesReference = (reference: {
    id: string
    label: string
    target: string
    start: number
    end: number
    confidence: number
  }) =>
    reference.id === relationship.id &&
    reference.label === relationship.label &&
    reference.target === relationship.targetNoteId &&
    reference.start === relationship.referenceStart &&
    reference.end === relationship.referenceEnd &&
    reference.confidence === relationship.confidence

  const directOwner = reconstruction.paper.nodes.find(
    ({ id }) => id === anchor.nodeId,
  )
  if (directOwner && 'noteReferences' in directOwner) {
    return Boolean(
      reconstruction.provenance[directOwner.id]?.regionIds.includes(
        relationship.referenceRegionId,
      ) && directOwner.noteReferences?.filter(matchesReference).length === 1,
    )
  }

  const tableCellOwners = reconstruction.paper.nodes.flatMap((node) => {
    if (node.type !== 'figure' || !node.table) return []
    return node.table.rows.flatMap((row, rowIndex) =>
      row.cells.flatMap((cell, cellIndex) => {
        const cellNodeId = `${node.id}:table:${cell.id ?? `${rowIndex}:${cellIndex}`}`
        if (
          cellNodeId !== anchor.nodeId ||
          !reconstruction.provenance[node.id]?.regionIds.includes(
            relationship.referenceRegionId,
          ) ||
          cell.noteReferences?.filter(matchesReference).length !== 1
        ) {
          return []
        }
        return [cellNodeId]
      }),
    )
  })
  return tableCellOwners.length === 1
}

function humanVisualCaptionAnchorMatches(
  reconstruction: PdfReconstruction,
  adjudication: HumanAdjudicationRecord,
  relationship: PdfVisualRelationship,
) {
  const candidateSourceRegionIds = new Set(
    relationship.candidates.flatMap(({ sourceRegionIds }) => sourceRegionIds),
  )
  const captionTargetRegionIds = adjudication.target.regionIds.filter(
    (regionId) => !candidateSourceRegionIds.has(regionId),
  )
  if (
    captionTargetRegionIds.length !== 1 ||
    captionTargetRegionIds[0] !== relationship.captionRegionId ||
    !relationship.captionNodeId ||
    !relationship.canonicalNodeId
  ) {
    return false
  }
  const captionNode = reconstruction.paper.nodes.find(
    ({ id }) => id === relationship.captionNodeId,
  )
  const canonicalNode = reconstruction.paper.nodes.find(
    ({ id }) => id === relationship.canonicalNodeId,
  )
  return Boolean(
    captionNode?.type === 'caption' &&
    reconstruction.provenance[captionNode.id]?.regionIds.includes(
      relationship.captionRegionId,
    ) &&
    canonicalNode?.type === 'figure' &&
    canonicalNode.relationships.caption === captionNode.id,
  )
}

function acceptedConsultationMatchesReconstruction(
  reconstruction: PdfReconstruction,
  consultation: ModelConsultationRecord,
) {
  if (consultation.status !== 'accepted' || !consultation.choice) return false
  const candidate = consultation.candidates.find(
    ({ id }) => id === consultation.choice!.candidateId,
  )
  if (!candidate) return false

  if (
    consultation.decisionClass ===
    MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch
  ) {
    const relationship = reconstruction.noteRelationships.find(
      ({ id }) => id === consultation.decisionId,
    )
    const currentCandidate = relationship?.candidates.find(
      ({ targetNoteId, targetRegionId, score }) =>
        targetNoteId === candidate.note_id &&
        targetRegionId === candidate.region_id &&
        score === candidate.score,
    )
    const candidateSetSha256 = relationship
      ? noteCandidateSetSha256(relationship.candidates)
      : null
    const currentCandidates = relationship?.candidates.map((item) => ({
      id: noteModelCandidateId(relationship, item, candidateSetSha256!),
      associationId: item.targetNoteId,
      note_id: item.targetNoteId,
      region_id: item.targetRegionId,
      score: item.score,
      evidence_codes: safeEvidenceCodes(
        item.evidence,
        MODEL_FALLBACK_EVIDENCE_CODES.noteMarkerMatch,
      ),
    }))
    return (
      relationship?.status === 'matched' &&
      relationship.resolutionOrigin === 'model-consultation' &&
      typeof relationship.resolutionInputConfidence === 'number' &&
      typeof candidate.note_id === 'string' &&
      typeof candidate.region_id === 'string' &&
      typeof candidate.score === 'number' &&
      relationship.targetNoteId === candidate.note_id &&
      relationship.confidence === candidate.score &&
      currentCandidate !== undefined &&
      stableModelConsultationJson(currentCandidates) ===
        stableModelConsultationJson(consultation.candidates) &&
      consultation.inputs.relationship_id === relationship.id &&
      consultation.inputs.reference_region_id ===
        relationship.referenceRegionId &&
      consultation.inputs.confidence ===
        relationship.resolutionInputConfidence &&
      consultation.inputs.threshold === relationship.threshold &&
      consultation.inputs.candidate_count === relationship.candidates.length &&
      noteModelCandidateId(
        relationship,
        currentCandidate,
        candidateSetSha256!,
      ) === candidate.id &&
      stableModelConsultationJson(relationship.sourceBoxes) ===
        stableModelConsultationJson(currentCandidate.sourceBoxes) &&
      stableModelConsultationJson([...relationship.evidence].sort()) ===
        stableModelConsultationJson(
          [
            ...(candidate.evidence_codes as string[]),
            'model-consultation',
          ].sort(),
        )
    )
  }

  if (
    consultation.decisionClass ===
    MODEL_FALLBACK_DECISION_CLASSES.captionAssociation
  ) {
    const relationship = reconstruction.visualRelationships.find(
      ({ id }) => id === consultation.decisionId,
    )
    const candidateSetSha256 = relationship
      ? visualCandidateSetSha256(relationship)
      : null
    const currentCandidate = relationship?.candidates.find(
      (item) =>
        visualModelCandidateId(relationship, item, candidateSetSha256!) ===
        candidate.id,
    )
    const currentCandidates = relationship?.candidates.map((item) => ({
      id: visualModelCandidateId(relationship, item, candidateSetSha256!),
      score: item.score,
      kind: relationship.kind,
      region_ids: [...item.sourceRegionIds],
      line_ids: [...(item.sourceLineIds ?? [])],
      object_ids: [...item.sourceObjectIds],
      asset_ids: [...item.assetIds],
      evidence_codes: safeEvidenceCodes(
        item.evidence,
        MODEL_FALLBACK_EVIDENCE_CODES.captionAssociation,
      ),
    }))
    const installedBoxes =
      relationship && currentCandidate
        ? visualInstalledSourceBoxes(
            reconstruction,
            relationship,
            currentCandidate,
          )
        : null
    return Boolean(
      relationship?.status === 'matched' &&
      relationship.resolutionOrigin === 'model-consultation' &&
      typeof relationship.resolutionInputConfidence === 'number' &&
      currentCandidate &&
      currentCandidates &&
      stableModelConsultationJson(currentCandidates) ===
        stableModelConsultationJson(consultation.candidates) &&
      consultation.inputs.caption_region_id === relationship.captionRegionId &&
      consultation.inputs.confidence ===
        relationship.resolutionInputConfidence &&
      relationship.kind === candidate.kind &&
      relationship.confidence === candidate.score &&
      installedBoxes &&
      stableModelConsultationJson(relationship.sourceBoxes) ===
        stableModelConsultationJson(installedBoxes) &&
      sameStringList(candidate.region_ids, relationship.sourceRegionIds) &&
      sameStringList(candidate.line_ids, relationship.sourceLineIds ?? []) &&
      sameStringList(candidate.object_ids, relationship.sourceObjectIds) &&
      sameStringList(candidate.asset_ids, relationship.assetIds) &&
      // `materializeVisualRelationship` installs the selected candidate's own
      // text. A candidate that carries its own text keeps the candidate-set
      // hash stable across a rewrite of the installed, reader-visible text.
      (currentCandidate.sourceText === undefined ||
        relationship.sourceText === currentCandidate.sourceText) &&
      stableModelConsultationJson([...relationship.evidence].sort()) ===
        stableModelConsultationJson(
          [
            ...currentCandidate.evidence,
            'model-consultation',
            `model-consulted-${String(
              consultation.inputs.diagnostic_code,
            ).toLowerCase()}`,
          ].sort(),
        ),
    )
  }

  if (
    consultation.decisionClass ===
    MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie
  ) {
    const chosen = candidate.region_ids
    if (!Array.isArray(chosen) || !chosen.every((id) => typeof id === 'string'))
      return false
    // Anchor on the deterministic resolution that survives the decision, not on
    // the receipt's own candidate list: a receipt that rewrote both its
    // candidates and the installed order would otherwise verify against itself.
    const resolutions = readingOrderResolutionsForDecision(
      reconstruction,
      consultation.decisionId,
    )
    if (resolutions.length !== 1) return false
    const targetIds = new Set(resolutions[0]!.regionIds)
    const installedOrder = reconstruction.readingOrder.order.filter((id) =>
      targetIds.has(id),
    )
    const regionById = new Map(
      reconstruction.regions.map((region) => [region.id, region]),
    )
    const installedRegionEvidence = chosen.map((id) => {
      const region = regionById.get(id)
      return region
        ? {
            id: region.id,
            kind: region.kind,
            column: region.column,
            page: region.page,
          }
        : null
    })
    // The ambiguity the model was asked about survives on the resolution, so
    // the receipt cannot certify inputs the document no longer carries.
    const ambiguity = readingOrderAmbiguityEvidence(resolutions[0]!)
    return (
      resolutions[0]!.resolutionOrigin === 'model-consultation' &&
      installedOrder.length === targetIds.size &&
      sameStringList(installedOrder, chosen) &&
      acceptedReadingOrderEdgesMatch(reconstruction, chosen) &&
      !installedRegionEvidence.includes(null) &&
      stableModelConsultationJson(installedRegionEvidence) ===
        stableModelConsultationJson(candidate.regions) &&
      consultation.inputs.page === ambiguity.page &&
      consultation.inputs.ambiguity_class === ambiguity.ambiguity_class &&
      consultation.inputs.confidence === ambiguity.confidence &&
      consultation.inputs.threshold === ambiguity.threshold &&
      stableModelConsultationJson(candidate.evidence_codes) ===
        stableModelConsultationJson(ambiguity.evidence_codes)
    )
  }

  return false
}

/** Evidence strings `applyVerifiedPdfCandidateResolutions` stamps on model-resolved state. */
const MODEL_FALLBACK_ORIGINS = Object.freeze([
  'model-consultation',
  'deterministic-distillation',
])

/**
 * `materializeVisualRelationship` also stamps a per-diagnostic marker beside
 * the bare origin. Matching only the bare origin would let a document drop one
 * string while still declaring its provenance in the next array slot.
 */
const MODEL_FALLBACK_ORIGIN_PREFIXES = Object.freeze([
  'model-consulted-',
  'deterministically-distilled-',
])

function readingOrderResolutionsForDecision(
  reconstruction: PdfReconstruction,
  decisionId: string,
) {
  return reconstruction.readingOrder.resolutions.filter(
    ({ regionIds }) =>
      stableCandidateId(
        'reading-order-decision',
        [...new Set(regionIds)].sort(),
      ) === decisionId,
  )
}

function acceptedReadingOrderEdgesMatch(
  reconstruction: PdfReconstruction,
  chosen: readonly string[],
) {
  const targetIds = new Set(chosen)
  const installed = reconstruction.readingOrder.edges.filter(
    ({ from, to }) => targetIds.has(from) && targetIds.has(to),
  )
  const expectedPairs = chosen
    .slice(0, -1)
    .map((from, index) => `${from}\u0000${chosen[index + 1]}`)
  return (
    installed.length === expectedPairs.length &&
    installed.every(
      ({ from, to, status }) =>
        status === 'accepted' && expectedPairs.includes(`${from}\u0000${to}`),
    )
  )
}

/**
 * Decision keys for state the document itself attributes to the model fallback
 * layer. `existingReceiptMatchesReconstruction` verifies receipt -> document;
 * this is the reverse direction, so a receipt cannot disclaim work the
 * reconstruction still carries.
 */
export function pdfModelDerivedDecisionKeys(reconstruction: PdfReconstruction) {
  const keys = new Set<string>()
  const attributed = (evidence: readonly string[]) =>
    evidence.some(
      (code) =>
        MODEL_FALLBACK_ORIGINS.includes(code) ||
        MODEL_FALLBACK_ORIGIN_PREFIXES.some((prefix) =>
          code.startsWith(prefix),
        ),
    )
  // Legacy and round-tripped reconstructions may omit these collections
  // entirely (`humanAdjudications` is optional on the parsed EPUB shape), and
  // this runs before STRUCT can reject the document. Reading an absent
  // collection as empty is the fail-closed direction: it accounts for less, so
  // it attributes more to the model layer, never less.
  const list = <T>(value: readonly T[] | undefined): readonly T[] => value ?? []

  for (const relationship of list(reconstruction.noteRelationships)) {
    const rankedScores = relationship.candidates
      .map(({ score }) => score)
      .sort((left, right) => right - left)
    const intrinsicallyAmbiguous =
      rankedScores.length > 1 && rankedScores[0]! - rankedScores[1]! < 0.04
    const humanAccounted = list(
      reconstruction.humanAdjudications?.applied,
    ).some((adjudication) => {
      if (
        adjudication.diagnosticCode !== 'AMBIGUOUS_NOTE_MATCH' ||
        adjudication.target.markerId !== relationship.id ||
        adjudication.resolution.type !== 'accept-note-match' ||
        relationship.status !== 'matched' ||
        relationship.resolutionOrigin !== 'human-adjudication' ||
        !relationship.evidence.includes('human-adjudication')
      ) {
        return false
      }
      const resolution = adjudication.resolution
      const candidates = relationship.candidates.filter(
        ({ targetNoteId, targetRegionId }) =>
          targetNoteId === resolution.targetNoteId &&
          targetRegionId === resolution.targetRegionId,
      )
      const candidate = candidates.length === 1 ? candidates[0] : undefined
      return Boolean(
        candidate &&
        humanNoteSourceAnchorMatches(
          reconstruction,
          adjudication,
          relationship,
        ) &&
        relationship.targetNoteId === resolution.targetNoteId &&
        relationship.confidence === candidate.score &&
        stableModelConsultationJson(relationship.sourceBoxes) ===
          stableModelConsultationJson(candidate.sourceBoxes),
      )
    })
    if (
      attributed(relationship.evidence) ||
      (relationship.resolutionOrigin !== undefined &&
        MODEL_FALLBACK_ORIGINS.includes(relationship.resolutionOrigin)) ||
      (relationship.status === 'matched' &&
        intrinsicallyAmbiguous &&
        !humanAccounted)
    ) {
      keys.add(
        decisionKey(
          MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
          relationship.id,
        ),
      )
    }
  }
  for (const relationship of list(reconstruction.visualRelationships)) {
    const rankedScores = relationship.candidates
      .map(({ score }) => score)
      .sort((left, right) => right - left)
    const intrinsicallyAmbiguous =
      rankedScores.length > 1 && rankedScores[0]! - rankedScores[1]! < 0.08
    const humanAccounted = list(
      reconstruction.humanAdjudications?.applied,
    ).some((adjudication) => {
      if (
        adjudication.diagnosticCode !== 'AMBIGUOUS_VISUAL_MATCH' ||
        adjudication.target.markerId !== relationship.id ||
        adjudication.resolution.type !== 'accept-visual-match' ||
        adjudication.resolution.relationshipId !== relationship.id ||
        relationship.status !== 'matched' ||
        relationship.resolutionOrigin !== 'human-adjudication' ||
        !relationship.evidence.includes('human-adjudicated-visual-match') ||
        !relationship.evidence.includes(
          `human-adjudicated-visual-kind:${relationship.kind}`,
        )
      ) {
        return false
      }
      const resolution = adjudication.resolution
      const candidates = relationship.candidates.filter(
        (candidate) =>
          visualDecisionCandidateId(relationship, candidate) ===
          resolution.candidateId,
      )
      const candidate = candidates.length === 1 ? candidates[0] : undefined
      const installedBoxes = candidate
        ? visualInstalledSourceBoxes(reconstruction, relationship, candidate)
        : null
      return Boolean(
        candidate &&
        installedBoxes &&
        humanVisualCaptionAnchorMatches(
          reconstruction,
          adjudication,
          relationship,
        ) &&
        relationship.confidence === candidate.score &&
        stableModelConsultationJson(relationship.sourceBoxes) ===
          stableModelConsultationJson(installedBoxes) &&
        sameStringList(
          candidate.sourceRegionIds,
          relationship.sourceRegionIds,
        ) &&
        sameStringList(
          candidate.sourceLineIds ?? [],
          relationship.sourceLineIds ?? [],
        ) &&
        sameStringList(
          candidate.sourceObjectIds,
          relationship.sourceObjectIds,
        ) &&
        sameStringList(candidate.assetIds, relationship.assetIds) &&
        (candidate.sourceText === undefined ||
          relationship.sourceText === candidate.sourceText),
      )
    })
    if (
      attributed(relationship.evidence) ||
      (relationship.resolutionOrigin !== undefined &&
        MODEL_FALLBACK_ORIGINS.includes(relationship.resolutionOrigin)) ||
      (relationship.status === 'matched' &&
        intrinsicallyAmbiguous &&
        !humanAccounted)
    ) {
      keys.add(
        decisionKey(
          MODEL_FALLBACK_DECISION_CLASSES.captionAssociation,
          relationship.id,
        ),
      )
    }
  }
  // A reading-order tie leaves no evidence string on the document. Something
  // has to have settled a tie that nothing open still accounts for, and that
  // something has to be claimed.
  //
  // Only an obligation over the exact tied region set can account for that
  // tie. A narrower diagnostic can be appended independently of the
  // deterministic resolver and therefore cannot vouch for the whole state.
  // A successfully applied human adjudication accounts for a tie just as a
  // receipt does. Stale decisions have not established that provenance.
  const readingOrderDiagnostics = list(reconstruction.diagnostics).filter(
    ({ code }) => code === 'AMBIGUOUS_READING_ORDER',
  )
  const regionSets = (targets: readonly (readonly string[] | undefined)[]) =>
    targets
      .map((regionIds) => regionIds ?? [])
      .filter((regionIds) => regionIds.length > 0)
      .map((regionIds) => new Set(regionIds))
  const accountedTargets = regionSets([
    ...readingOrderDiagnostics.map(
      (diagnostic) => diagnostic.target?.regionIds,
    ),
    ...list(reconstruction.humanAdjudications?.applied)
      .filter((adjudication) => {
        if (
          adjudication.diagnosticCode !== 'AMBIGUOUS_READING_ORDER' ||
          adjudication.resolution.type !== 'accept-reading-order'
        )
          return false
        const resolution = reconstruction.readingOrder.resolutions.find(
          ({ regionIds }) =>
            sameRegionSet(regionIds, adjudication.target.regionIds),
        )
        if (resolution?.resolutionOrigin !== 'human-adjudication') return false
        const targetIds = new Set(adjudication.target.regionIds)
        const installed = reconstruction.readingOrder.order.filter((id) =>
          targetIds.has(id),
        )
        return (
          sameStringList(installed, adjudication.resolution.regionIds) &&
          acceptedReadingOrderEdgesMatch(reconstruction, installed)
        )
      })
      .map(({ target }) => target?.regionIds),
  ])
  for (const resolution of list(reconstruction.readingOrder?.resolutions)) {
    // `status` is a bare enum that nothing cross-checks, so a settled tie can
    // be relabelled `resolved` in one edit. The resolution's own confidence
    // still records it as unsettled, and no deterministic resolution in the
    // corpus sits below its threshold.
    if (
      resolution.status !== 'ambiguous' &&
      !(resolution.confidence < resolution.threshold)
    )
      continue
    // A resolution naming no regions identifies no state to claim, and every
    // such resolution would collide onto the digest of the empty list.
    if (resolution.regionIds.length === 0) continue
    const regionIds = new Set(resolution.regionIds)
    // A resolution that names this layer as its own origin proves the
    // obligation outright. Reopening the diagnostic does not retract the work
    // already installed, so nothing open may account for it.
    const selfAttributed =
      resolution.resolutionOrigin !== undefined &&
      MODEL_FALLBACK_ORIGINS.includes(resolution.resolutionOrigin)
    if (
      !selfAttributed &&
      accountedTargets.some(
        (target) =>
          target.size === regionIds.size &&
          [...target].every((id) => regionIds.has(id)),
      )
    )
      continue
    const decisionId = stableCandidateId(
      'reading-order-decision',
      [...regionIds].sort(),
    )
    keys.add(
      decisionKey(MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie, decisionId),
    )
  }
  return keys
}

function deterministicDecisionMatchesReconstruction(
  reconstruction: PdfReconstruction,
  decision: ModelDecisionMetricEvent,
) {
  const choice = decision.choice
  if (!choice || !decision.deterministicRuleId) return false
  if (
    decision.decisionClass ===
    MODEL_FALLBACK_DECISION_CLASSES.captionAssociation
  ) {
    const relationship = reconstruction.visualRelationships.find(
      ({ id }) => id === decision.decisionId,
    )
    const candidateSetSha256 = relationship
      ? visualCandidateSetSha256(relationship)
      : null
    const candidate = relationship?.candidates.find(
      (candidate) =>
        visualModelCandidateId(relationship, candidate, candidateSetSha256!) ===
        choice.candidateId,
    )
    const installedBoxes =
      relationship && candidate
        ? visualInstalledSourceBoxes(reconstruction, relationship, candidate)
        : null
    const boundedRuleStillApplies =
      decision.deterministicRuleId !==
        PDF_CAPTION_UNIQUE_BOUNDED_DISTANCE_RULE_ID ||
      (relationship?.candidates.every(({ evidence }) =>
        evidence.includes('same-page-scope'),
      ) === true &&
        relationship.candidates.filter(({ evidence }) =>
          evidence.includes('bounded-distance'),
        ).length === 1 &&
        candidate?.evidence.includes('bounded-distance') === true &&
        [...CAPTION_DIRECTION_EVIDENCE].filter((code) =>
          candidate.evidence.includes(code),
        ).length === 1)
    return Boolean(
      relationship?.status === 'matched' &&
      relationship.resolutionOrigin === 'deterministic-distillation' &&
      typeof relationship.resolutionInputConfidence === 'number' &&
      boundedRuleStillApplies &&
      candidate &&
      installedBoxes &&
      stableModelConsultationJson(relationship.sourceBoxes) ===
        stableModelConsultationJson(installedBoxes) &&
      relationship.confidence === candidate.score &&
      sameStringList(candidate.sourceRegionIds, relationship.sourceRegionIds) &&
      sameStringList(
        candidate.sourceLineIds ?? [],
        relationship.sourceLineIds ?? [],
      ) &&
      sameStringList(candidate.sourceObjectIds, relationship.sourceObjectIds) &&
      sameStringList(candidate.assetIds, relationship.assetIds) &&
      // The rule selected this candidate's own transcript, and
      // `visualModelCandidateId` hashes that candidate text rather than the
      // installed text. Bind the reader-visible text the decision installed.
      (candidate.sourceText === undefined ||
        relationship.sourceText === candidate.sourceText) &&
      stableModelConsultationJson([...relationship.evidence].sort()) ===
        stableModelConsultationJson(
          [
            ...candidate.evidence,
            'deterministic-distillation',
            'deterministically-distilled-ambiguous_visual_match',
          ].sort(),
        ),
    )
  }
  if (
    decision.decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch
  ) {
    const relationship = reconstruction.noteRelationships.find(
      ({ id }) => id === decision.decisionId,
    )
    const candidateSetSha256 = relationship
      ? noteCandidateSetSha256(relationship.candidates)
      : null
    const candidate = relationship?.candidates.find(
      (item) =>
        noteModelCandidateId(relationship, item, candidateSetSha256!) ===
        choice.candidateId,
    )
    return Boolean(
      relationship?.status === 'matched' &&
      relationship.resolutionOrigin === 'deterministic-distillation' &&
      typeof relationship.resolutionInputConfidence === 'number' &&
      candidate &&
      relationship.targetNoteId === candidate.targetNoteId &&
      relationship.confidence === candidate.score &&
      stableModelConsultationJson(relationship.sourceBoxes) ===
        stableModelConsultationJson(candidate.sourceBoxes) &&
      // `updateNoteRelationship` installs exactly the selected candidate's
      // evidence beside the origin marker, and STRUCT publishes it as the
      // relationship's reader-visible signals.
      stableModelConsultationJson([...relationship.evidence].sort()) ===
        stableModelConsultationJson(
          [...candidate.evidence, 'deterministic-distillation'].sort(),
        ),
    )
  }
  if (
    decision.decisionClass === MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie
  ) {
    const resolutions = readingOrderResolutionsForDecision(
      reconstruction,
      decision.decisionId,
    )
    if (resolutions.length !== 1) return false
    const targetIds = new Set(resolutions[0]!.regionIds)
    const installedOrder = reconstruction.readingOrder.order.filter((id) =>
      targetIds.has(id),
    )
    const regionById = new Map(
      reconstruction.regions.map((region) => [region.id, region]),
    )
    const installedRegionEvidence = installedOrder.map((id) => {
      const region = regionById.get(id)
      return region
        ? {
            id: region.id,
            kind: region.kind,
            column: region.column,
            page: region.page,
          }
        : null
    })
    // Recomputing the choice id from the surviving resolution binds the
    // versioned rule to the whole decision point it was replayed against, not
    // just to the order it installed.
    const ambiguity = readingOrderAmbiguityEvidence(resolutions[0]!)
    return (
      resolutions[0]!.resolutionOrigin === 'deterministic-distillation' &&
      installedOrder.length === targetIds.size &&
      acceptedReadingOrderEdgesMatch(reconstruction, installedOrder) &&
      !installedRegionEvidence.includes(null) &&
      stableCandidateId('reading-order-candidate', [
        ...installedOrder,
        stableModelConsultationJson(installedRegionEvidence),
        stableModelConsultationJson(ambiguity),
      ]) === choice.candidateId
    )
  }
  return false
}

function sameConsultationEvidence(
  left: ModelConsultationRecord,
  right: ModelConsultationRecord,
) {
  return (
    stableModelConsultationJson(left.inputs) ===
      stableModelConsultationJson(right.inputs) &&
    stableModelConsultationJson(left.candidates) ===
      stableModelConsultationJson(right.candidates)
  )
}

function humanAdjudicationSupersedesDecision(
  reconstruction: PdfReconstruction,
  decision: ModelDecisionMetricEvent,
) {
  return reconstruction.humanAdjudications.applied.some((adjudication) => {
    if (
      decision.decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch
    ) {
      const relationship = reconstruction.noteRelationships.find(
        ({ id }) => id === decision.decisionId,
      )
      if (
        adjudication.diagnosticCode !== 'AMBIGUOUS_NOTE_MATCH' ||
        adjudication.target.markerId !== decision.decisionId ||
        relationship?.resolutionOrigin !== 'human-adjudication' ||
        !relationship.evidence.includes('human-adjudication')
      ) {
        return false
      }
      if (adjudication.resolution.type === 'reclassify-plain-text') {
        return (
          relationship.status === 'plain-text' &&
          relationship.targetNoteId === null &&
          !reconstruction.citationRelationships.some(
            ({ id }) => id === relationship.id,
          )
        )
      }
      if (adjudication.resolution.type === 'reclassify-citation') {
        const citation = reconstruction.citationRelationships.find(
          ({ id }) => id === relationship.id,
        )
        return Boolean(
          relationship.status === 'citation' &&
          relationship.targetNoteId === null &&
          citation?.taxonomy === 'human-reclassified-citation' &&
          citation.label === relationship.label &&
          sameStringList(
            citation.labels,
            relationship.label.split(',').filter(Boolean),
          ) &&
          citation.referenceRegionId === relationship.referenceRegionId &&
          citation.referenceStart === relationship.referenceStart &&
          citation.referenceEnd === relationship.referenceEnd &&
          citation.confidence === relationship.confidence &&
          stableModelConsultationJson(citation.evidence) ===
            stableModelConsultationJson(relationship.evidence) &&
          stableModelConsultationJson(citation.sourceBoxes) ===
            stableModelConsultationJson(relationship.sourceBoxes),
        )
      }
      if (adjudication.resolution.type !== 'accept-note-match') return false
      const resolution = adjudication.resolution
      const candidates = relationship?.candidates.filter(
        ({ targetNoteId, targetRegionId }) =>
          targetNoteId === resolution.targetNoteId &&
          targetRegionId === resolution.targetRegionId,
      )
      const candidate = candidates?.length === 1 ? candidates[0] : undefined
      return (
        relationship?.status === 'matched' &&
        relationship.targetNoteId === resolution.targetNoteId &&
        candidate !== undefined &&
        humanNoteSourceAnchorMatches(
          reconstruction,
          adjudication,
          relationship,
        ) &&
        relationship.confidence === candidate.score &&
        stableModelConsultationJson(relationship.sourceBoxes) ===
          stableModelConsultationJson(candidate.sourceBoxes)
      )
    }
    if (
      decision.decisionClass ===
      MODEL_FALLBACK_DECISION_CLASSES.captionAssociation
    ) {
      if (adjudication.resolution.type !== 'accept-visual-match') return false
      const resolution = adjudication.resolution
      const relationship = reconstruction.visualRelationships.find(
        ({ id }) => id === decision.decisionId,
      )
      const candidates = relationship?.candidates.filter(
        (candidate) =>
          visualDecisionCandidateId(relationship, candidate) ===
          resolution.candidateId,
      )
      const candidate = candidates?.length === 1 ? candidates[0] : undefined
      const installedBoxes =
        relationship && candidate
          ? visualInstalledSourceBoxes(reconstruction, relationship, candidate)
          : null
      return (
        adjudication.diagnosticCode === 'AMBIGUOUS_VISUAL_MATCH' &&
        adjudication.target.markerId === decision.decisionId &&
        resolution.relationshipId === decision.decisionId &&
        relationship?.status === 'matched' &&
        relationship.resolutionOrigin === 'human-adjudication' &&
        relationship.evidence.includes('human-adjudicated-visual-match') &&
        relationship.evidence.includes(
          `human-adjudicated-visual-kind:${relationship.kind}`,
        ) &&
        candidate !== undefined &&
        installedBoxes !== null &&
        humanVisualCaptionAnchorMatches(
          reconstruction,
          adjudication,
          relationship,
        ) &&
        relationship.confidence === candidate.score &&
        stableModelConsultationJson(relationship.sourceBoxes) ===
          stableModelConsultationJson(installedBoxes) &&
        sameStringList(
          candidate.sourceRegionIds,
          relationship.sourceRegionIds,
        ) &&
        sameStringList(
          candidate.sourceLineIds ?? [],
          relationship.sourceLineIds ?? [],
        ) &&
        sameStringList(
          candidate.sourceObjectIds,
          relationship.sourceObjectIds,
        ) &&
        sameStringList(candidate.assetIds, relationship.assetIds) &&
        (candidate.sourceText === undefined ||
          relationship.sourceText === candidate.sourceText)
      )
    }
    if (
      decision.decisionClass === MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie
    ) {
      if (adjudication.resolution.type !== 'accept-reading-order') return false
      const targetIds = new Set(adjudication.target.regionIds)
      const installedOrder = reconstruction.readingOrder.order.filter((id) =>
        targetIds.has(id),
      )
      const resolutions = readingOrderResolutionsForDecision(
        reconstruction,
        decision.decisionId,
      )
      return (
        adjudication.diagnosticCode === 'AMBIGUOUS_READING_ORDER' &&
        stableCandidateId(
          'reading-order-decision',
          [...new Set(adjudication.target.regionIds)].sort(),
        ) === decision.decisionId &&
        resolutions.length === 1 &&
        resolutions[0]!.resolutionOrigin === 'human-adjudication' &&
        installedOrder.length === targetIds.size &&
        sameStringList(adjudication.resolution.regionIds, installedOrder) &&
        acceptedReadingOrderEdgesMatch(reconstruction, installedOrder)
      )
    }
    return false
  })
}

function existingReceiptMatchesReconstruction(
  reconstruction: PdfReconstruction,
  receipt: ModelFallbackReceipt,
) {
  const openBindings = new Map(
    boundModelDecisionPointsForPdf(reconstruction).map((binding) => [
      decisionKey(binding.point.decisionClass, binding.point.decisionId),
      binding,
    ]),
  )
  const decisionsByKey = new Map<string, ModelDecisionMetricEvent[]>()
  for (const decision of receipt.decisions) {
    const key = decisionKey(decision.decisionClass, decision.decisionId)
    const history = decisionsByKey.get(key) ?? []
    history.push(decision)
    decisionsByKey.set(key, history)
  }
  if ([...openBindings.keys()].some((key) => !decisionsByKey.has(key)))
    return false

  // Reverse direction: state the document attributes to this layer must be
  // claimed by the receipt. Without this an emptied receipt verifies vacuously,
  // because a fully resolved document has no open bindings left to check.
  if (
    [...pdfModelDerivedDecisionKeys(reconstruction)].some(
      (key) => !decisionsByKey.has(key),
    )
  )
    return false

  return [...decisionsByKey].every(([key, history]) => {
    const decision = history.at(-1)!
    const priorResolved = history
      .slice(0, -1)
      .some(({ outcome }) => outcome === 'deterministic')
    const binding = openBindings.get(key)
    const consultations = receipt.consultations.filter(
      (consultation) =>
        consultation.decisionClass === decision.decisionClass &&
        consultation.decisionId === decision.decisionId,
    )
    const accepted = consultations.filter(({ status }) => status === 'accepted')

    if (binding) {
      if (
        priorResolved ||
        decision.outcome === 'deterministic' ||
        accepted.length > 0
      )
        return false
      if (
        consultations.some(
          (consultation) =>
            stableModelConsultationJson(consultation.inputs) !==
              stableModelConsultationJson(binding.point.inputs) ||
            stableModelConsultationJson(consultation.candidates) !==
              stableModelConsultationJson(binding.point.candidates),
        )
      )
        return false
      return decision.outcome === 'review-required' || consultations.length > 0
    }

    if (decision.outcome === 'review-required') {
      return humanAdjudicationSupersedesDecision(reconstruction, decision)
    }
    const latestConsultation = consultations.at(-1)
    if (
      decision.outcome === 'consulted' &&
      accepted.length === 0 &&
      latestConsultation &&
      (latestConsultation.status === 'failed' ||
        latestConsultation.status === 'rejected')
    ) {
      return humanAdjudicationSupersedesDecision(reconstruction, decision)
    }
    if (decision.outcome === 'deterministic') {
      if (priorResolved || accepted.length > 0) return false
      const evidence = consultations[0]
      if (
        evidence &&
        (!consultations.every((item) =>
          sameConsultationEvidence(item, evidence),
        ) ||
          consultations.some(
            ({ candidates }) =>
              !candidates.some(({ id }) => id === decision.choice?.candidateId),
          ))
      )
        return false
      return deterministicDecisionMatchesReconstruction(
        reconstruction,
        decision,
      )
    }

    if (
      priorResolved ||
      accepted.length !== 1 ||
      !latestConsultation ||
      latestConsultation.status !== 'accepted'
    )
      return false
    if (
      !consultations.every((consultation) =>
        sameConsultationEvidence(consultation, latestConsultation),
      )
    )
      return false
    return accepted.every((consultation) =>
      acceptedConsultationMatchesReconstruction(reconstruction, consultation),
    )
  })
}

export function modelConsultationReceiptMatchesPdfReconstruction(
  reconstruction: PdfReconstruction,
  receipt: unknown = reconstruction.modelConsultations,
): receipt is ModelFallbackReceipt {
  if (
    !validateModelConsultationReceipt(receipt) ||
    receipt.documentId !== reconstruction.paper.id ||
    receipt.sourceSha256 !== reconstruction.source.sha256 ||
    receipt.consultations.some(({ status }) => status === 'pending') ||
    !existingReceiptMatchesReconstruction(reconstruction, receipt)
  )
    return false
  if (receipt.semanticStateSha256 === undefined) return false
  return (
    receipt.semanticStateSha256 ===
    pdfModelConsultationSemanticStateSha256(reconstruction, receipt)
  )
}

function validatedExistingReceipt(reconstruction: PdfReconstruction) {
  const receipt = reconstruction.modelConsultations
  if (!receipt) return null
  if (
    !modelConsultationReceiptMatchesPdfReconstruction(reconstruction, receipt)
  ) {
    throw new Error('INVALID_MODEL_CONSULTATION_RECEIPT')
  }
  return {
    ...reconstruction,
    modelConsultations: structuredClone(receipt),
  }
}

export async function resolvePdfModelFallbacks(
  reconstruction: PdfReconstruction,
  gateOrOptions: ModelConsultationGate | ModelConsultationGateOptions = {},
) {
  const existing = validatedExistingReceipt(reconstruction)
  const reconstructionSnapshot = immutableSnapshot(existing ?? reconstruction)
  const bindings = boundModelDecisionPointsForPdf(reconstructionSnapshot)
  if (existing && bindings.length === 0) return existing

  let gate: ModelConsultationGate
  if (gateOrOptions instanceof ModelConsultationGate) {
    gate = gateOrOptions
  } else {
    let options = gateOrOptions
    if (
      options.enabled === true &&
      options.ownerOptIn === true &&
      options.ledger === undefined &&
      options.distillation === undefined
    ) {
      const distillation = new DistillationLedger()
      const captionBindings = bindings.filter(
        ({ point }) =>
          point.decisionClass ===
          MODEL_FALLBACK_DECISION_CLASSES.captionAssociation,
      )
      for (const { point } of captionBindings)
        distillation.registerFixture(point)
      if (
        captionBindings.length > 0 &&
        captionBindings.every(
          ({ point }) =>
            resolveCaptionAssociationByUniqueBoundedDistance(point) !== null,
        )
      ) {
        distillation.retireClass(
          MODEL_FALLBACK_DECISION_CLASSES.captionAssociation,
          resolveCaptionAssociationByUniqueBoundedDistance,
          PDF_CAPTION_UNIQUE_BOUNDED_DISTANCE_RULE_ID,
        )
      }
      options = { ...options, distillation }
    }
    gate = new ModelConsultationGate(options)
  }
  if (existing?.modelConsultations)
    gate.ledger.rememberStableChoices(existing.modelConsultations)
  const invocation = Symbol('pdf-model-fallback-invocation')
  if (
    !gate.ledger.bindDocumentSource(
      reconstructionSnapshot.paper.id,
      reconstructionSnapshot.source.sha256,
    )
  ) {
    throw new Error('DOCUMENT_SOURCE_HASH_MISMATCH')
  }

  const resolutions: VerifiedPdfCandidateResolution[] = []
  for (const binding of bindings) {
    const outcome = await gate.decide(binding.point, invocation)
    if (
      !outcome.choice ||
      (outcome.status !== 'consulted' && outcome.status !== 'deterministic')
    ) {
      continue
    }
    const decision = binding.decisionFor(outcome.choice)
    if (!decision) throw new Error('MODEL_DECISION_REPLAY_FAILED')
    resolutions.push({
      decision,
      origin:
        outcome.status === 'deterministic'
          ? 'deterministic-distillation'
          : 'model-consultation',
    })
  }

  let resolved = reconstructionSnapshot
  if (resolutions.length > 0) {
    const replay = applyVerifiedPdfCandidateResolutions(
      reconstructionSnapshot,
      resolutions,
    )
    if (replay.applied.length !== resolutions.length) {
      throw new Error('MODEL_DECISION_REPLAY_FAILED')
    }
    resolved = replay.reconstruction
  }
  const currentReceipt = gate.ledger.receiptForInvocation(
    reconstructionSnapshot.paper.id,
    invocation,
  )
  const receipt = existing?.modelConsultations
    ? appendReceiptHistory(existing.modelConsultations, currentReceipt)
    : currentReceipt
  if (
    !validateModelConsultationReceipt(receipt) ||
    receipt.documentId !== reconstructionSnapshot.paper.id ||
    receipt.sourceSha256 !== reconstructionSnapshot.source.sha256 ||
    receipt.consultations.some(({ status }) => status === 'pending')
  ) {
    throw new Error('INVALID_MODEL_CONSULTATION_RECEIPT')
  }
  const boundReceipt = structuredClone(receipt)
  boundReceipt.semanticStateSha256 = pdfModelConsultationSemanticStateSha256(
    resolved,
    boundReceipt,
  )
  const result = {
    ...resolved,
    modelConsultations: boundReceipt,
  }
  if (!modelConsultationReceiptMatchesPdfReconstruction(result))
    throw new Error('INVALID_MODEL_CONSULTATION_RECEIPT')
  return result
}

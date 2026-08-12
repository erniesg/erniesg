import {
  applyVerifiedPdfCandidateResolutions,
  readingOrderCandidates,
  type VerifiedPdfCandidateResolution,
} from './decision-record'
import type {
  HumanAdjudicationRecord,
  PdfReconstruction,
  ReconstructionDiagnostic,
} from './import-types'
import {
  MODEL_FALLBACK_DECISION_CLASSES,
  MODEL_FALLBACK_EVIDENCE_CODES,
  DistillationLedger,
  ModelConsultationGate,
  type ModelConsultationGateOptions,
  type ModelConsultationRecord,
  type ModelDecisionMetricEvent,
  type ModelFallbackChoice,
  type ModelFallbackDecisionPoint,
  type ModelFallbackReceipt,
  validateModelConsultationReceipt,
} from './model-fallback'
import { pdfVisualMatchCandidateId } from './pdf-visuals'
import { sha256HexSync } from './sha256-sync'

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

  const candidates = relationship.candidates.map((candidate) => ({
    id: stableCandidateId('note-candidate', [
      candidate.targetNoteId,
      candidate.targetRegionId,
    ]),
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
  if (!target || orders.length === 0) return null
  const regionById = new Map(
    reconstruction.regions.map((region) => [region.id, region]),
  )
  if (orders.some((regionIds) => regionIds.some((id) => !regionById.has(id))))
    return null
  const evidence = diagnostic.readingOrderResolution
  const candidates = orders.map((regionIds) => ({
    id: stableCandidateId('reading-order-candidate', regionIds),
    region_ids: [...regionIds],
    regions: regionIds.map((id) => {
      const region = regionById.get(id)!
      return {
        id: region.id,
        kind: region.kind,
        column: region.column,
        page: region.page,
      }
    }),
    evidence_codes: safeEvidenceCodes(
      evidence?.evidence.map(({ code }) => code) ?? [],
      MODEL_FALLBACK_EVIDENCE_CODES.readingOrderTie,
    ),
  }))
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
        page: diagnostic.page ?? evidence?.page ?? 0,
        ambiguity_class: evidence?.ambiguityClass ?? 'unspecified',
        confidence: evidence?.confidence ?? 0,
        threshold: evidence?.threshold ?? 0,
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
  const candidates = relationship.candidates.map((candidate) => ({
    id: candidate.id ?? pdfVisualMatchCandidateId(relationship.id, candidate),
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
    decisionFor: ({ candidateId }) =>
      candidates.some(({ id }) => id === candidateId)
        ? {
            diagnosticCode: diagnostic.code,
            target,
            resolution: {
              type: 'accept-visual-match',
              relationshipId: relationship.id,
              candidateId,
            },
          }
        : null,
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
        left.point.decisionClass.localeCompare(right.point.decisionClass) ||
        left.point.decisionId.localeCompare(right.point.decisionId),
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

function stableSemanticStateJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null'
  if (typeof value === 'bigint') return JSON.stringify(String(value))
  if (value instanceof Uint8Array)
    return JSON.stringify({ sha256: sha256HexSync(value) })
  if (Array.isArray(value))
    return `[${value.map(stableSemanticStateJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableSemanticStateJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function pdfModelConsultationSemanticStateSha256(
  reconstruction: PdfReconstruction,
  receipt: ModelFallbackReceipt,
) {
  const {
    modelConsultations: _modelConsultations,
    source,
    assets,
    ...semanticState
  } = reconstruction
  const { semanticStateSha256: _semanticStateSha256, ...receiptCore } = receipt
  return sha256HexSync(
    stableSemanticStateJson({
      schemaVersion: 'pdf-model-consultation-semantic-state-v1',
      receipt: receiptCore,
      reconstruction: {
        ...semanticState,
        source: {
          sha256: source.sha256,
          byteLength: source.byteLength,
          pageCount: source.pageCount,
        },
        assets: assets.map(({ bytes: _bytes, ...asset }) => asset),
      },
    }),
  )
}

function sameStringList(left: unknown, right: readonly string[]) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
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
    return (
      relationship?.status === 'matched' &&
      typeof candidate.note_id === 'string' &&
      typeof candidate.region_id === 'string' &&
      relationship.targetNoteId === candidate.note_id &&
      relationship.candidates.some(
        ({ targetNoteId, targetRegionId }) =>
          targetNoteId === candidate.note_id &&
          targetRegionId === candidate.region_id,
      ) &&
      relationship.evidence.includes('model-consultation')
    )
  }

  if (
    consultation.decisionClass ===
    MODEL_FALLBACK_DECISION_CLASSES.captionAssociation
  ) {
    const relationship = reconstruction.visualRelationships.find(
      ({ id }) => id === consultation.decisionId,
    )
    return Boolean(
      relationship?.status === 'matched' &&
      relationship.confidence === candidate.score &&
      sameStringList(candidate.region_ids, relationship.sourceRegionIds) &&
      sameStringList(candidate.line_ids, relationship.sourceLineIds ?? []) &&
      sameStringList(candidate.object_ids, relationship.sourceObjectIds) &&
      sameStringList(candidate.asset_ids, relationship.assetIds) &&
      relationship.evidence.includes('model-consultation'),
    )
  }

  if (
    consultation.decisionClass ===
    MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie
  ) {
    const chosen = candidate.region_ids
    if (!Array.isArray(chosen) || !chosen.every((id) => typeof id === 'string'))
      return false
    const targetIds = new Set(
      consultation.candidates.flatMap(({ region_ids: regionIds }) =>
        Array.isArray(regionIds)
          ? regionIds.filter((id): id is string => typeof id === 'string')
          : [],
      ),
    )
    return sameStringList(
      reconstruction.readingOrder.order.filter((id) => targetIds.has(id)),
      chosen,
    )
  }

  return false
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
    if (
      decision.deterministicRuleId !==
      PDF_CAPTION_UNIQUE_BOUNDED_DISTANCE_RULE_ID
    )
      return false
    const relationship = reconstruction.visualRelationships.find(
      ({ id }) => id === decision.decisionId,
    )
    const candidate = relationship?.candidates.find(
      (candidate) =>
        (candidate.id ??
          pdfVisualMatchCandidateId(relationship.id, candidate)) ===
        choice.candidateId,
    )
    return Boolean(
      relationship?.status === 'matched' &&
      candidate &&
      relationship.confidence === candidate.score &&
      sameStringList(candidate.sourceRegionIds, relationship.sourceRegionIds) &&
      sameStringList(
        candidate.sourceLineIds ?? [],
        relationship.sourceLineIds ?? [],
      ) &&
      sameStringList(candidate.sourceObjectIds, relationship.sourceObjectIds) &&
      sameStringList(candidate.assetIds, relationship.assetIds) &&
      relationship.evidence.includes('deterministic-distillation'),
    )
  }
  if (
    decision.decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch
  ) {
    const relationship = reconstruction.noteRelationships.find(
      ({ id }) => id === decision.decisionId,
    )
    const candidate = relationship?.candidates.find(
      ({ targetNoteId, targetRegionId }) =>
        stableCandidateId('note-candidate', [targetNoteId, targetRegionId]) ===
        choice.candidateId,
    )
    return Boolean(
      relationship?.status === 'matched' &&
      candidate &&
      relationship.targetNoteId === candidate.targetNoteId &&
      relationship.evidence.includes('deterministic-distillation'),
    )
  }
  return false
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
  const decisions = new Set(
    receipt.decisions.map(({ decisionClass, decisionId }) =>
      decisionKey(decisionClass, decisionId),
    ),
  )
  if (decisions.size !== receipt.decisions.length) return false
  if ([...openBindings.keys()].some((key) => !decisions.has(key))) return false

  return receipt.decisions.every((decision) => {
    const key = decisionKey(decision.decisionClass, decision.decisionId)
    const binding = openBindings.get(key)
    if (decision.outcome === 'review-required') return Boolean(binding)
    if (decision.outcome === 'deterministic') {
      if (binding) return false
      return deterministicDecisionMatchesReconstruction(
        reconstruction,
        decision,
      )
    }

    const consultations = receipt.consultations.filter(
      (consultation) =>
        consultation.decisionClass === decision.decisionClass &&
        consultation.decisionId === decision.decisionId,
    )
    if (consultations.length === 0) return false
    const accepted = consultations.filter(({ status }) => status === 'accepted')
    if (accepted.length > 0) {
      if (binding) return false
      return accepted.every((consultation) =>
        acceptedConsultationMatchesReconstruction(reconstruction, consultation),
      )
    }
    if (!binding) return false
    return consultations.every(
      (consultation) =>
        JSON.stringify(consultation.inputs) ===
          JSON.stringify(binding.point.inputs) &&
        JSON.stringify(consultation.candidates) ===
          JSON.stringify(binding.point.candidates),
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
  if (existing) return existing

  const reconstructionSnapshot = immutableSnapshot(reconstruction)
  const bindings = boundModelDecisionPointsForPdf(reconstructionSnapshot)

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
    const outcome = await gate.decide(binding.point)
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
  const receipt = gate.ledger.receiptFor(reconstructionSnapshot.paper.id)
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

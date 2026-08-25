import { readdirSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtureFile } from '../../tests/fixtures/pdf-fixtures'
import type { NormalizedSourceBox, PdfReconstruction } from './import-types'
import {
  applyHumanDecisionFile,
  createHumanDecisionFile,
  createVisualMatchDecision,
  readingOrderCandidates,
  upsertHumanDecision,
} from './decision-record'
import {
  DistillationLedger,
  MODEL_FALLBACK_DECISION_CLASSES,
  ModelConsultationGate,
  serializeModelConsultationReceipt,
  type ModelConsultationGateOptions,
  type ModelDecisionRequest,
  validateModelConsultationReceipt,
} from './model-fallback'
import {
  PDF_CAPTION_UNIQUE_BOUNDED_DISTANCE_RULE_ID,
  modelConsultationReceiptMatchesPdfReconstruction,
  modelDecisionPointsForPdf,
  pdfModelConsultationSemanticStateSha256,
  pdfModelDerivedDecisionKeys,
  PRODUCTION_PDF_MODEL_FALLBACK_OPTIONS,
  resolveCaptionAssociationByUniqueBoundedDistance,
  resolvePdfModelFallbacks,
} from './model-fallback-pipeline'
import { reconstructPdf } from './pdf'
import { pdfVisualMatchCandidateId } from './pdf-visuals'
import { buildStructDocument } from '../struct/from-reconstruction'

const modelIdentity = {
  providerId: 'recorded-stub',
  modelId: 'candidate-picker',
  modelVersion: '1.0.0',
  modelDigest: 'b'.repeat(64),
}

function withoutReceipt(reconstruction: PdfReconstruction) {
  const { modelConsultations: _modelConsultations, ...legacy } = reconstruction
  return legacy
}

describe('PDF model fallback production adapter', () => {
  let adjudicationRequired: PdfReconstruction
  let visualAdjudicationRequired: PdfReconstruction

  beforeAll(async () => {
    ;[adjudicationRequired, visualAdjudicationRequired] = await Promise.all([
      reconstructPdf(await fixtureFile('adjudication-required.pdf')),
      reconstructPdf(await fixtureFile('visual-adjudication-required.pdf')),
    ])
  })
  it('does not let a forged applied note decision supersede installed model state', async () => {
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) =>
          request.decisionClass ===
          MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch
            ? { candidateId: request.candidates[0]!.id }
            : { candidateId: 'invented-candidate' },
      },
    })
    const disabled = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: false,
    })
    const installed = resolved.noteRelationships.find(({ evidence }) =>
      evidence.includes('model-consultation'),
    )!
    const different = installed.candidates.find(
      ({ targetNoteId }) => targetNoteId !== installed.targetNoteId,
    )!
    resolved.humanAdjudications.applied = [
      {
        diagnosticCode: 'AMBIGUOUS_NOTE_MATCH',
        target: { markerId: installed.id, regionIds: [] },
        resolution: {
          type: 'accept-note-match',
          targetNoteId: different.targetNoteId,
          targetRegionId: different.targetRegionId,
        },
      },
    ]
    resolved.modelConsultations = structuredClone(disabled.modelConsultations)
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('does not let a forged applied visual decision supersede installed model state', async () => {
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      {
        enabled: true,
        ownerOptIn: true,
        distillation: new DistillationLedger(),
        model: {
          identity: modelIdentity,
          consult: (request) => ({ candidateId: request.candidates[0]!.id }),
        },
      },
    )
    const disabled = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      { enabled: false },
    )
    const installed = resolved.visualRelationships.find(({ evidence }) =>
      evidence.includes('model-consultation'),
    )!
    const selected = installed.candidates.find(
      ({ score }) => score === installed.confidence,
    )!
    const different = installed.candidates.find(
      (candidate) => candidate !== selected,
    )!
    resolved.humanAdjudications.applied = [
      {
        diagnosticCode: 'AMBIGUOUS_VISUAL_MATCH',
        target: { markerId: installed.id, regionIds: [] },
        resolution: {
          type: 'accept-visual-match',
          relationshipId: installed.id,
          candidateId:
            different.id ?? pdfVisualMatchCandidateId(installed.id, different),
        },
      },
    ]
    resolved.modelConsultations = structuredClone(disabled.modelConsultations)
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('requires human-origin visual evidence even when a forged adjudication names the installed candidate', async () => {
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      {
        enabled: true,
        ownerOptIn: true,
        distillation: new DistillationLedger(),
        model: {
          identity: modelIdentity,
          consult: (request) => ({ candidateId: request.candidates[0]!.id }),
        },
      },
    )
    const disabled = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      { enabled: false },
    )
    const installed = resolved.visualRelationships.find(({ evidence }) =>
      evidence.includes('model-consultation'),
    )!
    const selected = installed.candidates.find(
      ({ score }) => score === installed.confidence,
    )!
    resolved.humanAdjudications.applied = [
      {
        diagnosticCode: 'AMBIGUOUS_VISUAL_MATCH',
        target: { markerId: installed.id, regionIds: [] },
        resolution: {
          type: 'accept-visual-match',
          relationshipId: installed.id,
          candidateId:
            selected.id ?? pdfVisualMatchCandidateId(installed.id, selected),
        },
      },
    ]
    resolved.modelConsultations = structuredClone(disabled.modelConsultations)
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds superseding note adjudications to installed score and geometry', async () => {
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) => ({ candidateId: request.candidates[0]!.id }),
      },
    })
    const disabled = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: false,
    })
    const installed = resolved.noteRelationships.find(({ evidence }) =>
      evidence.includes('model-consultation'),
    )!
    const selected = installed.candidates.find(
      ({ targetNoteId }) => targetNoteId === installed.targetNoteId,
    )!
    resolved.humanAdjudications.applied = [
      {
        diagnosticCode: 'AMBIGUOUS_NOTE_MATCH',
        target: { markerId: installed.id, regionIds: [] },
        resolution: {
          type: 'accept-note-match',
          targetNoteId: selected.targetNoteId,
          targetRegionId: selected.targetRegionId,
        },
      },
    ]
    installed.evidence = [...installed.evidence, 'human-adjudication']
    installed.confidence = Math.max(0, selected.score - 0.1)
    resolved.modelConsultations = structuredClone(disabled.modelConsultations)
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('requires human origin for superseding reading-order adjudications', async () => {
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) => ({ candidateId: request.candidates[0]!.id }),
      },
    })
    const disabled = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: false,
    })
    const tie = resolved.readingOrder.resolutions.find(
      ({ status }) => status === 'ambiguous',
    )!
    const installedOrder = resolved.readingOrder.order.filter((id) =>
      new Set(tie.regionIds).has(id),
    )
    resolved.humanAdjudications.applied = [
      {
        diagnosticCode: 'AMBIGUOUS_READING_ORDER',
        target: { markerId: null, regionIds: [...tie.regionIds] },
        resolution: {
          type: 'accept-reading-order',
          regionIds: [...installedOrder],
        },
      },
    ]
    resolved.modelConsultations = structuredClone(disabled.modelConsultations)
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('reads model-derived state from a reconstruction that carries no adjudication record', async () => {
    // `humanAdjudications` is optional on parsed reconstructions (see the EPUB
    // round-trip shape), so a legacy document reaches STRUCT without one. An
    // absent record accounts for nothing, which is the fail-closed reading.
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      {
        enabled: true,
        ownerOptIn: true,
        distillation: new DistillationLedger(),
        model: {
          identity: modelIdentity,
          consult: (request) => ({ candidateId: request.candidates[0]!.id }),
        },
      },
    )
    const expected = pdfModelDerivedDecisionKeys(resolved)
    expect(expected.size).toBeGreaterThan(0)

    const legacy = structuredClone(resolved)
    delete (legacy as { humanAdjudications?: unknown }).humanAdjudications
    expect(pdfModelDerivedDecisionKeys(legacy)).toEqual(expected)

    // The digest spans the whole semantic state, so dropping the record alone
    // refuses the receipt. Rebind it and the document must verify end to end:
    // the absent record is a shape this layer reads, not one it chokes on.
    expect(modelConsultationReceiptMatchesPdfReconstruction(legacy)).toBe(false)
    legacy.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        legacy,
        legacy.modelConsultations!,
      )
    expect(modelConsultationReceiptMatchesPdfReconstruction(legacy)).toBe(true)
    expect(() => buildStructDocument(legacy)).not.toThrow()

    // A deterministic document with neither receipt nor adjudication record
    // still builds: there is no model-derived state to launder.
    const deterministic = withoutReceipt(
      structuredClone(visualAdjudicationRequired),
    ) as PdfReconstruction
    delete (deterministic as { humanAdjudications?: unknown })
      .humanAdjudications
    expect(pdfModelDerivedDecisionKeys(deterministic).size).toBe(0)
    expect(() => buildStructDocument(deterministic)).not.toThrow()
  })

  it('refuses a receipt that disclaims model-derived state in the document', async () => {
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      {
        enabled: true,
        ownerOptIn: true,
        distillation: new DistillationLedger(),
        model: {
          identity: modelIdentity,
          consult: (request) => ({ candidateId: request.candidates[0]!.id }),
        },
      },
    )
    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      true,
    )

    // `semanticStateSha256` is an unkeyed digest over public state, so a stale
    // value is not what makes an erased receipt fail. Recompute it and the
    // receipt must still be refused: the document still carries
    // model-consultation evidence that no consultation claims.
    const erased = structuredClone(resolved)
    const emptyReceipt = {
      ...structuredClone(resolved.modelConsultations!),
      consultations: [],
      decisions: [],
      metrics: {
        totalDecisionCount: 0,
        totalConsultationCount: 0,
        consultationRate: 0,
        byDecisionClass: {},
      },
    }
    erased.modelConsultations = emptyReceipt
    emptyReceipt.semanticStateSha256 = pdfModelConsultationSemanticStateSha256(
      erased,
      emptyReceipt,
    )
    expect(validateModelConsultationReceipt(emptyReceipt)).toBe(true)
    expect(modelConsultationReceiptMatchesPdfReconstruction(erased)).toBe(false)
    await expect(resolvePdfModelFallbacks(erased)).rejects.toThrow(
      'INVALID_MODEL_CONSULTATION_RECEIPT',
    )

    // Dropping the receipt outright must not silently launder the same state.
    const stripped = withoutReceipt(
      structuredClone(resolved),
    ) as PdfReconstruction
    expect(modelConsultationReceiptMatchesPdfReconstruction(stripped)).toBe(
      false,
    )
    expect(() => buildStructDocument(stripped)).toThrow(
      'MISSING_MODEL_CONSULTATION_RECEIPT',
    )
  })

  it('refuses a reading order the deterministic layer never offered', async () => {
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) => ({ candidateId: request.candidates[0]!.id }),
      },
    })
    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      true,
    )

    const consultation = resolved.modelConsultations!.consultations.find(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie,
    )!
    const tiedIds = new Set(
      consultation.candidates.flatMap(
        ({ region_ids: ids }) => (ids as string[] | undefined) ?? [],
      ),
    )

    // `promptHash`/`requestId`/`fixtureId` seal the receipt's candidate list, so
    // the reachable tampering surface is the reconstruction. Drop the
    // deterministic resolution that authorized this tie: the receipt still
    // claims an ordering, but nothing deterministic offers it any more.
    // `semanticStateSha256` is recomputable, so it cannot be what refuses this.
    const tampered = structuredClone(resolved)
    tampered.readingOrder.resolutions =
      tampered.readingOrder.resolutions.filter(
        ({ regionIds }) => !regionIds.some((id) => tiedIds.has(id)),
      )
    expect(tampered.readingOrder.resolutions.length).toBeLessThan(
      resolved.readingOrder.resolutions.length,
    )
    tampered.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        tampered,
        tampered.modelConsultations!,
      )

    expect(validateModelConsultationReceipt(tampered.modelConsultations)).toBe(
      true,
    )
    expect(modelConsultationReceiptMatchesPdfReconstruction(tampered)).toBe(
      false,
    )
  })

  it('binds a reading-order consultation to its recorded region evidence', async () => {
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) => ({ candidateId: request.candidates[0]!.id }),
      },
    })
    const consultation = resolved.modelConsultations!.consultations.find(
      ({ decisionClass, status }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie &&
        status === 'accepted',
    )!
    const candidate = consultation.candidates.find(
      ({ id }) => id === consultation.choice!.candidateId,
    )!
    const regionId = (candidate.region_ids as string[])[0]!
    const region = resolved.regions.find(({ id }) => id === regionId)!
    region.column = region.column === 'left' ? 'right' : 'left'
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds an accepted reading-order receipt to its surviving ambiguity inputs', async () => {
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) => ({ candidateId: request.candidates[0]!.id }),
      },
    })
    const tie = resolved.readingOrder.resolutions.find(
      ({ resolutionOrigin }) => resolutionOrigin === 'model-consultation',
    )!
    expect(tie.ambiguityClass).toBe('sparse-column-gutter')
    tie.ambiguityClass = 'footnote-band'
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds an accepted reading-order receipt to its model-consultation origin', async () => {
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) => ({ candidateId: request.candidates[0]!.id }),
      },
    })

    for (const replacementOrigin of [
      'human-adjudication',
      'deterministic-distillation',
    ] as const) {
      const tampered = structuredClone(resolved)
      const tie = tampered.readingOrder.resolutions.find(
        ({ resolutionOrigin }) => resolutionOrigin === 'model-consultation',
      )!
      tie.resolutionOrigin = replacementOrigin
      tampered.modelConsultations!.semanticStateSha256 =
        pdfModelConsultationSemanticStateSha256(
          tampered,
          tampered.modelConsultations!,
        )

      expect(modelConsultationReceiptMatchesPdfReconstruction(tampered)).toBe(
        false,
      )
    }
  })

  it('binds an accepted reading-order receipt to its installed edges', async () => {
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) => ({ candidateId: request.candidates[0]!.id }),
      },
    })
    const consultation = resolved.modelConsultations!.consultations.find(
      ({ decisionClass, status }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie &&
        status === 'accepted',
    )!
    const candidate = consultation.candidates.find(
      ({ id }) => id === consultation.choice!.candidateId,
    )!
    const chosen = candidate.region_ids as string[]
    const selectedPairs = chosen
      .slice(0, -1)
      .map((from, index) => `${from}\u0000${chosen[index + 1]}`)
    expect(selectedPairs.length).toBeGreaterThan(0)

    for (const mutation of ['remove', 'relabel'] as const) {
      const tampered = structuredClone(resolved)
      const selectedEdgeIndex = tampered.readingOrder.edges.findIndex(
        ({ from, to }) => selectedPairs.includes(`${from}\u0000${to}`),
      )
      expect(selectedEdgeIndex).toBeGreaterThanOrEqual(0)
      if (mutation === 'remove') {
        tampered.readingOrder.edges.splice(selectedEdgeIndex, 1)
      } else {
        tampered.readingOrder.edges[selectedEdgeIndex]!.status = 'candidate'
      }
      tampered.modelConsultations!.semanticStateSha256 =
        pdfModelConsultationSemanticStateSha256(
          tampered,
          tampered.modelConsultations!,
        )

      expect(modelConsultationReceiptMatchesPdfReconstruction(tampered)).toBe(
        false,
      )
    }
  })

  it('binds a note consultation to its candidate score and installed confidence', async () => {
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) => ({ candidateId: request.candidates[0]!.id }),
      },
    })
    const consultation = resolved.modelConsultations!.consultations.find(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
    )!
    const relationship = resolved.noteRelationships.find(
      ({ id }) => id === consultation.decisionId,
    )!
    relationship.confidence = Math.max(0, relationship.confidence - 0.1)
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds a note consultation to the installed candidate source boxes', async () => {
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) => ({ candidateId: request.candidates[0]!.id }),
      },
    })
    const consultation = resolved.modelConsultations!.consultations.find(
      ({ decisionClass, status }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch &&
        status === 'accepted',
    )!
    const relationship = resolved.noteRelationships.find(
      ({ id }) => id === consultation.decisionId,
    )!
    const replacementBoxes: NormalizedSourceBox[] = relationship.sourceBoxes
      .length
      ? []
      : [
          {
            page: 999,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            rotation: 0,
            method: 'pdf-text',
          },
        ]
    relationship.sourceBoxes = replacementBoxes
    const selected = relationship.candidates.find(
      ({ targetNoteId }) => targetNoteId === relationship.targetNoteId,
    )!
    selected.sourceBoxes = structuredClone(replacementBoxes)
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds an accepted note receipt to the complete current candidate set', async () => {
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) => ({ candidateId: request.candidates[0]!.id }),
      },
    })
    const consultation = resolved.modelConsultations!.consultations.find(
      ({ decisionClass, status }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch &&
        status === 'accepted',
    )!
    const relationship = resolved.noteRelationships.find(
      ({ id }) => id === consultation.decisionId,
    )!
    const unselected = relationship.candidates.find(
      ({ targetNoteId }) => targetNoteId !== relationship.targetNoteId,
    )!
    unselected.score = Math.max(0, unselected.score - 0.1)
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds an accepted visual receipt to every candidate source text', async () => {
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      {
        enabled: true,
        ownerOptIn: true,
        distillation: new DistillationLedger(),
        model: {
          identity: modelIdentity,
          consult: (request) => ({ candidateId: request.candidates[0]!.id }),
        },
      },
    )
    const consultation = resolved.modelConsultations!.consultations.find(
      ({ decisionClass, status }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.captionAssociation &&
        status === 'accepted',
    )!
    const relationship = resolved.visualRelationships.find(
      ({ id }) => id === consultation.decisionId,
    )!
    const selected = relationship.candidates.find(
      ({ score }) => score === relationship.confidence,
    )!
    const unselected = relationship.candidates.find(
      (candidate) => candidate !== selected,
    )!
    unselected.sourceText = `${unselected.sourceText ?? ''} changed`
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds an accepted visual receipt to the installed source text', async () => {
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      {
        enabled: true,
        ownerOptIn: true,
        distillation: new DistillationLedger(),
        model: {
          identity: modelIdentity,
          consult: (request) => ({ candidateId: request.candidates[0]!.id }),
        },
      },
    )
    const consultation = resolved.modelConsultations!.consultations.find(
      ({ decisionClass, status }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.captionAssociation &&
        status === 'accepted',
    )!
    const relationship = resolved.visualRelationships.find(
      ({ id }) => id === consultation.decisionId,
    )!
    // Every candidate carries its own `sourceText`, so rewriting the installed
    // text leaves the candidate set — and therefore every candidate id —
    // untouched.
    expect(
      relationship.candidates.every(
        ({ sourceText }) => sourceText !== undefined,
      ),
    ).toBe(true)
    relationship.sourceText = `${relationship.sourceText} rewritten`
    const canonicalNode = resolved.paper.nodes.find(
      (node) => node.id === relationship.canonicalNodeId,
    )
    if (canonicalNode?.type === 'figure')
      canonicalNode.sourceText = relationship.sourceText
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds an accepted visual receipt to the complete installed evidence', async () => {
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      {
        enabled: true,
        ownerOptIn: true,
        distillation: new DistillationLedger(),
        model: {
          identity: modelIdentity,
          consult: (request) => ({ candidateId: request.candidates[0]!.id }),
        },
      },
    )
    const consultation = resolved.modelConsultations!.consultations.find(
      ({ decisionClass, status }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.captionAssociation &&
        status === 'accepted',
    )!
    const relationship = resolved.visualRelationships.find(
      ({ id }) => id === consultation.decisionId,
    )!
    const selected = relationship.candidates.find(
      ({ score }) => score === relationship.confidence,
    )!
    const diagnosticMarker = relationship.evidence.find((code) =>
      code.startsWith('model-consulted-'),
    )!
    expect(selected.evidence.length).toBeGreaterThan(0)
    expect(diagnosticMarker).toBeDefined()

    for (const removedEvidence of [selected.evidence[0]!, diagnosticMarker]) {
      const tampered = structuredClone(resolved)
      const current = tampered.visualRelationships.find(
        ({ id }) => id === relationship.id,
      )!
      current.evidence = current.evidence.filter(
        (code) => code !== removedEvidence,
      )
      tampered.modelConsultations!.semanticStateSha256 =
        pdfModelConsultationSemanticStateSha256(
          tampered,
          tampered.modelConsultations!,
        )

      expect(modelConsultationReceiptMatchesPdfReconstruction(tampered)).toBe(
        false,
      )
    }
  })

  it('binds a deterministic note decision to its candidate score', async () => {
    const [point] = modelDecisionPointsForPdf(adjudicationRequired).filter(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
    )
    const distillation = new DistillationLedger()
    distillation.registerFixture(point!)
    distillation.retireClass(
      point!.decisionClass,
      () => point!.candidates[0]!.id,
      'note-marker-match-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      adjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const decision = resolved.modelConsultations!.decisions.find(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
    )!
    const relationship = resolved.noteRelationships.find(
      ({ id }) => id === decision.decisionId,
    )!
    const selected = relationship.candidates.find(
      ({ targetNoteId }) => targetNoteId === relationship.targetNoteId,
    )!
    selected.score = Math.max(0, selected.score - 0.1)
    relationship.confidence = selected.score
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds a deterministic note decision to its pre-resolution confidence', async () => {
    const [point] = modelDecisionPointsForPdf(adjudicationRequired).filter(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
    )
    const originalConfidence = point!.inputs.confidence as number
    const changed = structuredClone(adjudicationRequired)
    changed.noteRelationships.find(
      ({ id }) => id === point!.decisionId,
    )!.confidence = originalConfidence === 0 ? 0.01 : originalConfidence - 0.01
    const changedPoint = modelDecisionPointsForPdf(changed).find(
      ({ decisionId }) => decisionId === point!.decisionId,
    )!

    expect(changedPoint.inputs.confidence).not.toBe(originalConfidence)
    expect(changedPoint.candidates.map(({ id }) => id)).not.toEqual(
      point!.candidates.map(({ id }) => id),
    )

    const distillation = new DistillationLedger()
    distillation.registerFixture(point!)
    distillation.retireClass(
      point!.decisionClass,
      () => point!.candidates[0]!.id,
      'note-input-confidence-binding-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      adjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const decision = resolved.modelConsultations!.decisions.find(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
    )!
    const relationship = resolved.noteRelationships.find(
      ({ id }) => id === decision.decisionId,
    )!

    expect(relationship.resolutionInputConfidence).toBe(originalConfidence)
    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      true,
    )

    const tampered = structuredClone(resolved)
    tampered.noteRelationships.find(
      ({ id }) => id === relationship.id,
    )!.resolutionInputConfidence =
      originalConfidence === 0 ? 0.01 : originalConfidence - 0.01
    tampered.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        tampered,
        tampered.modelConsultations!,
      )
    expect(modelConsultationReceiptMatchesPdfReconstruction(tampered)).toBe(
      false,
    )
  })

  it('binds a deterministic note decision to the installed candidate evidence', async () => {
    const [point] = modelDecisionPointsForPdf(adjudicationRequired).filter(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
    )
    const distillation = new DistillationLedger()
    distillation.registerFixture(point!)
    distillation.retireClass(
      point!.decisionClass,
      () => point!.candidates[0]!.id,
      'note-marker-evidence-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      adjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const decision = resolved.modelConsultations!.decisions.find(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
    )!
    const relationship = resolved.noteRelationships.find(
      ({ id }) => id === decision.decisionId,
    )!
    // `updateNoteRelationship` installs the selected candidate's evidence
    // beside the origin marker, and STRUCT publishes it as reader-visible
    // signals. Dropping one signal leaves candidates and choice untouched.
    expect(relationship.evidence).toContain('deterministic-distillation')
    relationship.evidence = relationship.evidence.filter(
      (code) => code !== 'label-exact',
    )
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('commits complete note candidate evidence before deterministic replay', async () => {
    const [point] = modelDecisionPointsForPdf(adjudicationRequired).filter(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
    )
    const distillation = new DistillationLedger()
    distillation.registerFixture(point!)
    distillation.retireClass(
      point!.decisionClass,
      () => point!.candidates[0]!.id,
      'note-complete-evidence-commitment-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      adjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const decision = resolved.modelConsultations!.decisions.find(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
    )!
    const relationship = resolved.noteRelationships.find(
      ({ id }) => id === decision.decisionId,
    )!
    const selected = relationship.candidates.find(
      ({ targetNoteId }) => targetNoteId === relationship.targetNoteId,
    )!
    const uncommittedSignal = 'retired-rule-never-evaluated-note-signal'
    expect(point!.candidates[0]!.evidence_codes).not.toContain(
      uncommittedSignal,
    )
    selected.evidence.push(uncommittedSignal)
    relationship.evidence.push(uncommittedSignal)
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds a deterministic note decision to the complete candidate set', async () => {
    const [point] = modelDecisionPointsForPdf(adjudicationRequired).filter(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
    )
    const distillation = new DistillationLedger()
    distillation.registerFixture(point!)
    distillation.retireClass(
      point!.decisionClass,
      () => point!.candidates[0]!.id,
      'note-complete-candidate-set-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      adjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const decision = resolved.modelConsultations!.decisions.find(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
    )!
    const relationship = resolved.noteRelationships.find(
      ({ id }) => id === decision.decisionId,
    )!
    const unselected = relationship.candidates.find(
      ({ targetNoteId }) => targetNoteId !== relationship.targetNoteId,
    )!
    unselected.score = Math.max(0, unselected.score - 0.1)
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds a deterministic note decision to its surviving ambiguity inputs', async () => {
    const [point] = modelDecisionPointsForPdf(adjudicationRequired).filter(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
    )
    const distillation = new DistillationLedger()
    distillation.registerFixture(point!)
    distillation.retireClass(
      point!.decisionClass,
      () => point!.candidates[0]!.id,
      'note-ambiguity-input-binding-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      adjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const decision = resolved.modelConsultations!.decisions.find(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
    )!
    const relationship = resolved.noteRelationships.find(
      ({ id }) => id === decision.decisionId,
    )!

    for (const mutate of [
      (copy: typeof resolved) => {
        copy.noteRelationships.find(
          ({ id }) => id === relationship.id,
        )!.referenceRegionId = 'retargeted-note-reference-region'
      },
      (copy: typeof resolved) => {
        const current = copy.noteRelationships.find(
          ({ id }) => id === relationship.id,
        )!
        current.threshold = Math.max(0, current.threshold - 0.1)
      },
    ]) {
      const tampered = structuredClone(resolved)
      mutate(tampered)
      tampered.modelConsultations!.semanticStateSha256 =
        pdfModelConsultationSemanticStateSha256(
          tampered,
          tampered.modelConsultations!,
        )

      expect(modelConsultationReceiptMatchesPdfReconstruction(tampered)).toBe(
        false,
      )
    }
  })

  it('binds a deterministic reading decision to its region evidence', async () => {
    const [point] = modelDecisionPointsForPdf(adjudicationRequired).filter(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie,
    )
    const distillation = new DistillationLedger()
    distillation.registerFixture(point!)
    distillation.retireClass(
      point!.decisionClass,
      () => point!.candidates[0]!.id,
      'reading-order-region-evidence-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      adjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const selectedIds = point!.candidates[0]!.region_ids as string[]
    const region = resolved.regions.find(({ id }) => id === selectedIds[0])!
    region.column = region.column === 'left' ? 'right' : 'left'
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds a deterministic reading decision to its surviving ambiguity evidence', async () => {
    const [point] = modelDecisionPointsForPdf(adjudicationRequired).filter(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie,
    )
    const distillation = new DistillationLedger()
    distillation.registerFixture(point!)
    distillation.retireClass(
      point!.decisionClass,
      () => point!.candidates[0]!.id,
      'reading-order-ambiguity-evidence-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      adjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    // A retired rule may key off the tie's evidence codes, so dropping one
    // leaves a versioned rule that need not still make this choice.
    const tie = resolved.readingOrder.resolutions.find(
      ({ resolutionOrigin }) =>
        resolutionOrigin === 'deterministic-distillation',
    )!
    expect(tie.evidence.length).toBeGreaterThan(1)
    tie.evidence = tie.evidence.slice(1)
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds a deterministic reading decision to its distillation origin', async () => {
    const [point] = modelDecisionPointsForPdf(adjudicationRequired).filter(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie,
    )
    const distillation = new DistillationLedger()
    distillation.registerFixture(point!)
    distillation.retireClass(
      point!.decisionClass,
      () => point!.candidates[0]!.id,
      'reading-order-origin-binding-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      adjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )

    for (const replacementOrigin of [
      'model-consultation',
      'human-adjudication',
    ] as const) {
      const tampered = structuredClone(resolved)
      const tie = tampered.readingOrder.resolutions.find(
        ({ resolutionOrigin }) =>
          resolutionOrigin === 'deterministic-distillation',
      )!
      tie.resolutionOrigin = replacementOrigin
      tampered.modelConsultations!.semanticStateSha256 =
        pdfModelConsultationSemanticStateSha256(
          tampered,
          tampered.modelConsultations!,
        )

      expect(modelConsultationReceiptMatchesPdfReconstruction(tampered)).toBe(
        false,
      )
    }
  })

  it('binds a deterministic reading decision to its installed accepted edges', async () => {
    const [point] = modelDecisionPointsForPdf(adjudicationRequired).filter(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie,
    )
    const selected = point!.candidates[0]!
    const distillation = new DistillationLedger()
    distillation.registerFixture(point!)
    distillation.retireClass(
      point!.decisionClass,
      () => selected.id,
      'reading-order-edge-binding-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      adjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const selectedIds = new Set(selected.region_ids as string[])
    const installedEdge = resolved.readingOrder.edges.find(
      ({ from, to }) => selectedIds.has(from) && selectedIds.has(to),
    )!
    expect(installedEdge.status).toBe('accepted')

    for (const mutate of [
      (copy: typeof resolved) => {
        copy.readingOrder.edges = copy.readingOrder.edges.filter(
          ({ id }) => id !== installedEdge.id,
        )
      },
      (copy: typeof resolved) => {
        copy.readingOrder.edges.find(
          ({ id }) => id === installedEdge.id,
        )!.status = 'candidate'
      },
    ]) {
      const tampered = structuredClone(resolved)
      mutate(tampered)
      tampered.modelConsultations!.semanticStateSha256 =
        pdfModelConsultationSemanticStateSha256(
          tampered,
          tampered.modelConsultations!,
        )

      expect(modelConsultationReceiptMatchesPdfReconstruction(tampered)).toBe(
        false,
      )
    }
  })

  it('does not accept a reading-order consultation receipt while the decision remains open', async () => {
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) =>
          request.decisionClass ===
          MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie
            ? { candidateId: request.candidates[0]!.id }
            : { candidateId: 'invented-candidate' },
      },
    })
    expect(
      resolved.modelConsultations?.consultations.some(
        ({ decisionClass, status }) =>
          decisionClass === MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie &&
          status === 'accepted',
      ),
    ).toBe(true)

    const unresolved = structuredClone(adjudicationRequired)
    unresolved.modelConsultations = structuredClone(resolved.modelConsultations)
    await expect(resolvePdfModelFallbacks(unresolved)).rejects.toThrow(
      'INVALID_MODEL_CONSULTATION_RECEIPT',
    )
  })

  it('returns the immutable pre-consultation snapshot when a provider mutates caller state and is rejected', async () => {
    const base = structuredClone(adjudicationRequired)
    const beforeConsultation = structuredClone(base)
    const result = await resolvePdfModelFallbacks(base, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: () => {
          base.noteRelationships.reverse()
          base.diagnostics.length = 0
          return { candidateId: 'invented-candidate' }
        },
      },
    })

    expect(withoutReceipt(result)).toEqual(beforeConsultation)
  })

  it('binds accepted choices to an immutable pre-consultation snapshot', async () => {
    const base = structuredClone(adjudicationRequired)
    const relationship = base.noteRelationships[0]!
    let expectedTargetNoteId: string | undefined
    const result = await resolvePdfModelFallbacks(base, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) => {
          if (request.decisionId === relationship.id) {
            expectedTargetNoteId = request.candidates[0]!
              .associationId as string
            relationship.candidates.reverse()
          }
          return { candidateId: request.candidates[0]!.id }
        },
      },
    })

    expect(expectedTargetNoteId).toBeDefined()
    expect(
      result.noteRelationships.find(({ id }) => id === relationship.id)
        ?.targetNoteId,
    ).toBe(expectedTargetNoteId)
  })

  it('fails closed when an accepted visual choice cannot pass replay verification', async () => {
    const base = structuredClone(visualAdjudicationRequired)
    const relationship = base.visualRelationships.find(
      ({ status }) => status === 'ambiguous',
    )!
    const selectedAssetId = relationship.candidates[0]!.assetIds[0]!
    const asset = base.assets.find(({ id }) => id === selectedAssetId)!
    asset.bytes = new Uint8Array()
    const diagnosticCodes = base.diagnostics.map(({ code }) => code)

    await expect(
      resolvePdfModelFallbacks(base, {
        enabled: true,
        ownerOptIn: true,
        distillation: new DistillationLedger(),
        model: {
          identity: modelIdentity,
          consult: (request) => ({ candidateId: request.candidates[0]!.id }),
        },
      }),
    ).rejects.toThrow('MODEL_DECISION_REPLAY_FAILED')
    expect(base.diagnostics.map(({ code }) => code)).toEqual(diagnosticCodes)
    expect(relationship.status).toBe('ambiguous')
  })

  it('fails closed when an accepted note choice has no canonical owner', async () => {
    const base = structuredClone(adjudicationRequired)
    const relationship = base.noteRelationships[0]!
    const owner = base.paper.nodes.find((node) =>
      base.provenance[node.id]?.regionIds.includes(
        relationship.referenceRegionId,
      ),
    )!
    base.paper.nodes = base.paper.nodes.filter(({ id }) => id !== owner.id)
    const diagnosticCodes = base.diagnostics.map(({ code }) => code)

    await expect(
      resolvePdfModelFallbacks(base, {
        enabled: true,
        ownerOptIn: true,
        model: {
          identity: modelIdentity,
          consult: (request) => ({ candidateId: request.candidates[0]!.id }),
        },
      }),
    ).rejects.toThrow('MODEL_DECISION_REPLAY_FAILED')
    expect(base.diagnostics.map(({ code }) => code)).toEqual(diagnosticCodes)
    expect(relationship.status).toBe('ambiguous')
  })

  it('retires an actual caption class with an order-independent bounded-evidence rule and reopens on an uncovered fixture', async () => {
    const [point] = modelDecisionPointsForPdf(
      visualAdjudicationRequired,
    ).filter(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.captionAssociation,
    )
    expect(point).toBeDefined()
    const selected = resolveCaptionAssociationByUniqueBoundedDistance(point!)
    expect(selected).not.toBeNull()
    expect(
      resolveCaptionAssociationByUniqueBoundedDistance({
        ...point!,
        candidates: [...point!.candidates].reverse(),
      }),
    ).toBe(selected)
    expect(
      resolveCaptionAssociationByUniqueBoundedDistance({
        ...point!,
        candidates: point!.candidates.map((candidate) => ({
          ...candidate,
          kind: 'table',
        })),
      }),
    ).toBeNull()
    const distillation = new DistillationLedger()
    distillation.registerFixture(point!)
    distillation.retireClass(
      point!.decisionClass,
      resolveCaptionAssociationByUniqueBoundedDistance,
      PDF_CAPTION_UNIQUE_BOUNDED_DISTANCE_RULE_ID,
    )
    const consult = vi.fn(() => ({ candidateId: 'not-called' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      distillation,
      model: { identity: modelIdentity, consult },
    })

    const result = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      gate,
    )

    expect(consult).not.toHaveBeenCalled()
    expect(result.modelConsultations?.metrics).toMatchObject({
      totalDecisionCount: 1,
      totalConsultationCount: 0,
      consultationRate: 0,
    })
    expect(result.diagnostics.map(({ code }) => code)).not.toContain(
      'AMBIGUOUS_VISUAL_MATCH',
    )
    expect(
      result.visualRelationships
        .filter(({ status }) => status === 'matched')
        .flatMap(({ evidence }) => evidence),
    ).toContain('deterministic-distillation')

    const uncovered = structuredClone(point!)
    uncovered.decisionId = `${uncovered.decisionId}-uncovered`
    uncovered.candidates = uncovered.candidates.map((candidate) => ({
      ...candidate,
      evidence_codes: (candidate.evidence_codes as string[]).filter(
        (code) => code !== 'bounded-distance',
      ),
    }))
    const reopened = await gate.decide(uncovered)
    expect(reopened).toMatchObject({
      status: 'review-required',
      diagnostic: 'DISTILLED_RULE_NO_CANDIDATE_CHOICE',
    })
    expect(consult).not.toHaveBeenCalled()
    expect(distillation.entry(point!.decisionClass)).toMatchObject({
      retired: false,
      fixtureCount: 2,
      consultationCount: 2,
    })
    expect(
      distillation
        .fixturesFor(point!.decisionClass)
        .every(
          (fixture) =>
            fixture.resolution === 'model-consulted' &&
            fixture.deterministicRuleId === undefined,
        ),
    ).toBe(true)
  })

  it('binds deterministic receipts to the exact choice and versioned rule', async () => {
    const [point] = modelDecisionPointsForPdf(
      visualAdjudicationRequired,
    ).filter(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.captionAssociation,
    )
    expect(point?.candidates).toHaveLength(2)

    const resolveCandidateAt = async (index: number) => {
      const distillation = new DistillationLedger()
      distillation.registerFixture(point!)
      distillation.retireClass(
        point!.decisionClass,
        () => point!.candidates[index]!.id,
        'caption-choice-binding-v1',
      )
      return resolvePdfModelFallbacks(
        visualAdjudicationRequired,
        new ModelConsultationGate({ distillation }),
      )
    }

    const first = await resolveCandidateAt(0)
    expect(first.modelConsultations?.decisions).toEqual([
      expect.objectContaining({
        outcome: 'deterministic',
        choice: { candidateId: point!.candidates[0]!.id },
        deterministicRuleId: 'caption-choice-binding-v1',
      }),
    ])

    const differentlyResolved = await resolveCandidateAt(1)
    differentlyResolved.modelConsultations = structuredClone(
      first.modelConsultations,
    )
    await expect(resolvePdfModelFallbacks(differentlyResolved)).rejects.toThrow(
      'INVALID_MODEL_CONSULTATION_RECEIPT',
    )
  })

  it('accepts a supplied caption distillation rule id when its choice matches', async () => {
    const [point] = modelDecisionPointsForPdf(
      visualAdjudicationRequired,
    ).filter(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.captionAssociation,
    )
    const distillation = new DistillationLedger()
    distillation.registerFixture(point!)
    distillation.retireClass(
      point!.decisionClass,
      () => point!.candidates[0]!.id,
      'caption-association-v1',
    )

    const result = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )

    expect(result.modelConsultations?.decisions).toEqual([
      expect.objectContaining({
        outcome: 'deterministic',
        choice: { candidateId: point!.candidates[0]!.id },
        deterministicRuleId: 'caption-association-v1',
      }),
    ])
    expect(result.diagnostics.map(({ code }) => code)).not.toContain(
      'AMBIGUOUS_VISUAL_MATCH',
    )
  })
})

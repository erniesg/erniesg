import { beforeAll, describe, expect, it } from 'vitest'
import { fixtureFile } from '../../tests/fixtures/pdf-fixtures'
import type { NormalizedSourceBox, PdfReconstruction } from './import-types'
import {
  DistillationLedger,
  MODEL_FALLBACK_DECISION_CLASSES,
  ModelConsultationGate,
  validateModelConsultationReceipt,
} from './model-fallback'
import {
  modelConsultationReceiptMatchesPdfReconstruction,
  modelDecisionPointsForPdf,
  pdfModelConsultationSemanticStateSha256,
  resolvePdfModelFallbacks,
} from './model-fallback-pipeline'
import { reconstructPdf } from './pdf'

const modelIdentity = {
  providerId: 'recorded-stub',
  modelId: 'candidate-picker',
  modelVersion: '1.0.0',
  modelDigest: 'b'.repeat(64),
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
})

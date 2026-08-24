import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtureFile } from '../../tests/fixtures/pdf-fixtures'
import type { NormalizedSourceBox, PdfReconstruction } from './import-types'
import {
  DistillationLedger,
  MODEL_FALLBACK_DECISION_CLASSES,
  ModelConsultationGate,
  type ModelDecisionRequest,
} from './model-fallback'
import {
  PDF_CAPTION_UNIQUE_BOUNDED_DISTANCE_RULE_ID,
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

describe('PDF model fallback visual deterministic bindings', () => {
  let adjudicationRequired: PdfReconstruction
  let visualAdjudicationRequired: PdfReconstruction

  beforeAll(async () => {
    ;[adjudicationRequired, visualAdjudicationRequired] = await Promise.all([
      reconstructPdf(await fixtureFile('adjudication-required.pdf')),
      reconstructPdf(await fixtureFile('visual-adjudication-required.pdf')),
    ])
  })

  it('resolves only the eligible visual ambiguity and keeps private source material out of requests and receipts', async () => {
    const base = structuredClone(visualAdjudicationRequired)
    const sentinel = 'PRIVATE_SOURCE_SENTINEL_8f9c2a'
    for (const relationship of base.visualRelationships) {
      relationship.sourceText = sentinel
      relationship.altText = sentinel
      for (const candidate of relationship.candidates) {
        candidate.sourceText = sentinel
        candidate.evidence.push(sentinel)
      }
    }
    const requests: ModelDecisionRequest[] = []
    const result = await resolvePdfModelFallbacks(base, {
      enabled: true,
      ownerOptIn: true,
      distillation: new DistillationLedger(),
      model: {
        identity: modelIdentity,
        consult: (request) => {
          requests.push(request)
          return { candidateId: request.candidates[0]!.id }
        },
      },
    })

    expect(requests).toHaveLength(1)
    expect(result.diagnostics.map(({ code }) => code)).not.toContain(
      'AMBIGUOUS_VISUAL_MATCH',
    )
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      'UNRESOLVED_VISUAL_OBJECT',
    )
    expect(
      result.visualRelationships
        .filter(({ status }) => status === 'matched')
        .flatMap(({ evidence }) => evidence),
    ).toContain('model-consultation')
    const persistedEvidence = JSON.stringify({
      requests,
      receipt: result.modelConsultations,
    })
    expect(persistedEvidence).not.toContain(sentinel)
    expect(persistedEvidence).not.toMatch(/sourceText|altText|bytes/u)
    const [request] = requests
    expect(request?.candidates).not.toHaveLength(0)
    for (const candidate of request?.candidates ?? []) {
      const evidenceCodes = candidate.evidence_codes as string[]
      expect(evidenceCodes).toEqual([...new Set(evidenceCodes)].sort())
    }
  })

  it('binds a visual consultation to the selected candidate kind', async () => {
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
    relationship.kind = relationship.kind === 'figure' ? 'table' : 'figure'
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds a visual consultation to the installed candidate geometry', async () => {
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
      (candidate) =>
        candidate.sourceRegionIds.join() ===
        relationship.sourceRegionIds.join(),
    )!
    const replacementBoxes: NormalizedSourceBox[] = []
    relationship.sourceBoxes = replacementBoxes
    selected.sourceBoxes = replacementBoxes
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds accepted note receipts to their anchor, threshold, and evidence', async () => {
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
    expect(relationship.canonicalAnchor?.kind).toBe('node')
    if (relationship.canonicalAnchor?.kind !== 'node') {
      throw new Error('Expected a canonical node anchor for the note fixture')
    }
    const alternateRelationship = resolved.noteRelationships.find(
      ({ id, canonicalAnchor }) =>
        id !== relationship.id && canonicalAnchor?.kind === 'node',
    )
    expect(alternateRelationship?.canonicalAnchor?.kind).toBe('node')
    if (alternateRelationship?.canonicalAnchor?.kind !== 'node') {
      throw new Error('Expected a second canonical note anchor for the fixture')
    }
    const alternateAnchor = structuredClone(
      alternateRelationship.canonicalAnchor,
    )

    for (const mutate of [
      (copy: typeof resolved) => {
        const current = copy.noteRelationships.find(
          ({ id }) => id === relationship.id,
        )!
        current.referenceStart = alternateRelationship.referenceStart
        current.referenceEnd = alternateRelationship.referenceEnd
        current.canonicalAnchor = structuredClone(alternateAnchor)
      },
      (copy: typeof resolved) => {
        copy.noteRelationships.find(
          ({ id }) => id === relationship.id,
        )!.referenceRegionId = 'retargeted-note-anchor'
      },
      (copy: typeof resolved) => {
        const current = copy.noteRelationships.find(
          ({ id }) => id === relationship.id,
        )!
        current.threshold = Math.max(0, current.threshold - 0.1)
      },
      (copy: typeof resolved) => {
        const current = copy.noteRelationships.find(
          ({ id }) => id === relationship.id,
        )!
        current.evidence = ['model-consultation']
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

  it('binds an accepted visual receipt to its caption region anchor', async () => {
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
    relationship.captionRegionId = 'retargeted-caption-region'
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds a deterministic visual decision to its caption region anchor', async () => {
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
      'caption-anchor-binding-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const relationship = resolved.visualRelationships.find(({ evidence }) =>
      evidence.includes('deterministic-distillation'),
    )!
    relationship.captionRegionId = 'retargeted-caption-region'
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds a deterministic visual decision to its pre-resolution confidence', async () => {
    const [point] = modelDecisionPointsForPdf(
      visualAdjudicationRequired,
    ).filter(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.captionAssociation,
    )
    const originalConfidence = point!.inputs.confidence as number
    const changed = structuredClone(visualAdjudicationRequired)
    changed.visualRelationships.find(
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
      'caption-input-confidence-binding-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const relationship = resolved.visualRelationships.find(({ evidence }) =>
      evidence.includes('deterministic-distillation'),
    )!

    expect(relationship.resolutionInputConfidence).toBe(originalConfidence)
    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      true,
    )

    const tampered = structuredClone(resolved)
    tampered.visualRelationships.find(
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

  it('binds a deterministic visual decision to the complete installed evidence', async () => {
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
      'caption-installed-evidence-binding-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const relationship = resolved.visualRelationships.find(({ evidence }) =>
      evidence.includes('deterministic-distillation'),
    )!
    const selected = relationship.candidates.find(
      ({ score }) => score === relationship.confidence,
    )!
    const diagnosticMarker = relationship.evidence.find((code) =>
      code.startsWith('deterministically-distilled-'),
    )!
    expect(selected.evidence.length).toBeGreaterThan(0)
    expect(diagnosticMarker).toBeDefined()

    for (const mutateEvidence of [
      (evidence: string[]) =>
        evidence.filter((code) => code !== selected.evidence[0]),
      (evidence: string[]) =>
        evidence.filter((code) => code !== diagnosticMarker),
      (evidence: string[]) => [...evidence, 'model-consultation'],
    ]) {
      const tampered = structuredClone(resolved)
      const current = tampered.visualRelationships.find(
        ({ id }) => id === relationship.id,
      )!
      current.evidence = mutateEvidence(current.evidence)
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

  it('commits complete visual candidate evidence before deterministic replay', async () => {
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
      'caption-complete-evidence-commitment-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const relationship = resolved.visualRelationships.find(({ evidence }) =>
      evidence.includes('deterministic-distillation'),
    )!
    const selected = relationship.candidates.find(
      ({ score }) => score === relationship.confidence,
    )!
    const uncommittedSignal = 'retired-rule-never-evaluated-visual-signal'
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

  it('binds a deterministic visual decision to its selected kind', async () => {
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
      'caption-kind-binding-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const relationship = resolved.visualRelationships.find(({ evidence }) =>
      evidence.includes('deterministic-distillation'),
    )!
    relationship.kind = relationship.kind === 'figure' ? 'table' : 'figure'
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds a deterministic visual decision to its candidate score', async () => {
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
      'caption-score-binding-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const relationship = resolved.visualRelationships.find(({ evidence }) =>
      evidence.includes('deterministic-distillation'),
    )!
    const selected = relationship.candidates.find(
      (candidate) => candidate.score === relationship.confidence,
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

  it('binds a deterministic visual decision to its source identifiers', async () => {
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
      'caption-source-id-binding-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const relationship = resolved.visualRelationships.find(({ evidence }) =>
      evidence.includes('deterministic-distillation'),
    )!
    const selected = relationship.candidates.find(
      ({ score }) => score === relationship.confidence,
    )!
    selected.sourceRegionIds = ['retargeted-source-region']
    relationship.sourceRegionIds = [...selected.sourceRegionIds]
    resolved.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        resolved,
        resolved.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      false,
    )
  })

  it('binds a deterministic visual decision to the installed source text', async () => {
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
      'caption-source-text-binding-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const relationship = resolved.visualRelationships.find(({ evidence }) =>
      evidence.includes('deterministic-distillation'),
    )!
    // `visualModelCandidateId` hashes each candidate's own text, so rewriting
    // only the installed text leaves the deterministic choice id unchanged.
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

  it('binds a custom deterministic visual decision to the complete candidate set', async () => {
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
      'caption-complete-candidate-set-v1',
    )
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )
    const relationship = resolved.visualRelationships.find(({ evidence }) =>
      evidence.includes('deterministic-distillation'),
    )!
    const selected = relationship.candidates.find(
      ({ score }) => score === relationship.confidence,
    )!
    const unselected = relationship.candidates.find(
      (candidate) => candidate !== selected,
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

  it('automatically retires a fully covered caption class for normal strict opt-in options', async () => {
    const consult = vi.fn((request: ModelDecisionRequest) => ({
      candidateId: request.candidates[0]!.id,
    }))

    const result = await resolvePdfModelFallbacks(visualAdjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: { identity: modelIdentity, consult },
    })

    expect(consult).not.toHaveBeenCalled()
    expect(result.modelConsultations?.consultations).toEqual([])
    expect(result.modelConsultations?.decisions).toEqual([
      expect.objectContaining({
        decisionClass: MODEL_FALLBACK_DECISION_CLASSES.captionAssociation,
        outcome: 'deterministic',
        consulted: false,
        deterministicRuleId: PDF_CAPTION_UNIQUE_BOUNDED_DISTANCE_RULE_ID,
      }),
    ])
    expect(result.modelConsultations?.metrics).toMatchObject({
      totalDecisionCount: 1,
      totalConsultationCount: 0,
      consultationRate: 0,
    })
    expect(result.diagnostics.map(({ code }) => code)).not.toContain(
      'AMBIGUOUS_VISUAL_MATCH',
    )
  })
})

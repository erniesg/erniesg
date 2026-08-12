import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtureFile } from '../../tests/fixtures/pdf-fixtures'
import type { PdfReconstruction } from './import-types'
import {
  DistillationLedger,
  MODEL_FALLBACK_DECISION_CLASSES,
  ModelConsultationGate,
  type ModelDecisionRequest,
  validateModelConsultationReceipt,
} from './model-fallback'
import {
  PDF_CAPTION_UNIQUE_BOUNDED_DISTANCE_RULE_ID,
  modelDecisionPointsForPdf,
  PRODUCTION_PDF_MODEL_FALLBACK_OPTIONS,
  resolveCaptionAssociationByUniqueBoundedDistance,
  resolvePdfModelFallbacks,
} from './model-fallback-pipeline'
import { reconstructPdf } from './pdf'

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

  it('leaves the legacy result unchanged when no model configuration exists', () => {
    expect(adjudicationRequired).not.toHaveProperty('modelConsultations')
    expect(modelDecisionPointsForPdf(adjudicationRequired)).toHaveLength(3)
    expect(
      new Set(
        modelDecisionPointsForPdf(adjudicationRequired).map(
          ({ decisionClass }) => decisionClass,
        ),
      ),
    ).toEqual(
      new Set([
        MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
        MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie,
      ]),
    )
  })

  it('wires an explicitly disabled gate through reconstructPdf without consulting or resolving', async () => {
    const consult = vi.fn(() => ({ candidateId: 'not-called' }))
    const result = await reconstructPdf(
      await fixtureFile('adjudication-required.pdf'),
      undefined,
      {
        modelFallback: {
          ...PRODUCTION_PDF_MODEL_FALLBACK_OPTIONS,
          model: { identity: modelIdentity, consult },
        },
      },
    )

    expect(consult).not.toHaveBeenCalled()
    expect(structuredClone(PRODUCTION_PDF_MODEL_FALLBACK_OPTIONS)).toEqual({
      enabled: false,
      ownerOptIn: false,
    })
    expect(withoutReceipt(result)).toEqual(adjudicationRequired)
    expect(validateModelConsultationReceipt(result.modelConsultations)).toBe(
      true,
    )
    expect(result.modelConsultations).toMatchObject({
      documentId: result.paper.id,
      sourceSha256: result.source.sha256,
      metrics: {
        totalDecisionCount: 3,
        totalConsultationCount: 0,
        consultationRate: 0,
      },
    })
    expect(result.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'AMBIGUOUS_NOTE_MATCH',
        'AMBIGUOUS_READING_ORDER',
      ]),
    )
  })

  it('consults only bounded candidates and replays note and reading-order choices without human provenance', async () => {
    const requests: ModelDecisionRequest[] = []
    const consult = vi.fn((request: ModelDecisionRequest) => {
      requests.push(request)
      return { candidateId: request.candidates[0]!.id }
    })
    const result = await reconstructPdf(
      await fixtureFile('adjudication-required.pdf'),
      undefined,
      {
        modelFallback: {
          enabled: true,
          ownerOptIn: true,
          model: { identity: modelIdentity, consult },
        },
      },
    )

    expect(consult).toHaveBeenCalledTimes(3)
    expect(result.modelConsultations?.metrics).toMatchObject({
      totalDecisionCount: 3,
      totalConsultationCount: 3,
      consultationRate: 1,
    })
    expect(
      result.noteRelationships.every(({ status }) => status === 'matched'),
    ).toBe(true)
    expect(result.diagnostics.map(({ code }) => code)).not.toEqual(
      expect.arrayContaining([
        'AMBIGUOUS_NOTE_MATCH',
        'AMBIGUOUS_READING_ORDER',
      ]),
    )
    expect(result.humanAdjudications).toEqual(
      adjudicationRequired.humanAdjudications,
    )
    expect(JSON.stringify(requests)).not.toMatch(
      /sourceText|altText|bytes|apiKey|accessToken|refreshToken/u,
    )
    expect(
      result.noteRelationships.flatMap(({ evidence }) => evidence),
    ).toContain('model-consultation')
    expect(
      result.noteRelationships.flatMap(({ evidence }) => evidence),
    ).not.toContain('human-adjudication')
    const readingRequest = requests.find(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie,
    )!
    expect(readingRequest).toBeDefined()
    expect(
      new Set(
        readingRequest.candidates.map((candidate) =>
          JSON.stringify(candidate.regions),
        ),
      ).size,
    ).toBe(readingRequest.candidates.length)
    for (const candidate of readingRequest.candidates) {
      expect(
        (candidate.regions as Array<{ id: string }>).map(({ id }) => id),
      ).toEqual(candidate.region_ids)
    }
  })

  it('keeps abort ownership until asynchronous model fallback completes', async () => {
    const controller = new AbortController()

    await expect(
      reconstructPdf(
        await fixtureFile('adjudication-required.pdf'),
        undefined,
        {
          signal: controller.signal,
          modelFallback: {
            enabled: true,
            ownerOptIn: true,
            model: {
              identity: modelIdentity,
              consult: async (request) => {
                controller.abort()
                await Promise.resolve()
                return { candidateId: request.candidates[0]!.id }
              },
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
  })

  it('uses a canonical target set for stable reading-order decision identity', () => {
    const reordered = structuredClone(adjudicationRequired)
    const diagnostic = reordered.diagnostics.find(
      ({ code }) => code === 'AMBIGUOUS_READING_ORDER',
    )!
    diagnostic.target!.regionIds.reverse()
    const decisionId = (reconstruction: PdfReconstruction) =>
      modelDecisionPointsForPdf(reconstruction).find(
        ({ decisionClass }) =>
          decisionClass === MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie,
      )!.decisionId

    expect(decisionId(reordered)).toBe(decisionId(adjudicationRequired))
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

  it('leaves semantic state fail-closed for an out-of-set proposal', async () => {
    const result = await resolvePdfModelFallbacks(visualAdjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      distillation: new DistillationLedger(),
      model: {
        identity: modelIdentity,
        consult: () => ({ candidateId: 'invented-candidate' }),
      },
    })

    expect(withoutReceipt(result)).toEqual(visualAdjudicationRequired)
    expect(result.modelConsultations?.consultations).toEqual([
      expect.objectContaining({
        status: 'rejected',
        failureCode: 'OUT_OF_CANDIDATE_SET',
      }),
    ])
  })

  it('binds an existing receipt to the exact resolved semantic state', async () => {
    const resolveCandidateAt = (index: number) =>
      resolvePdfModelFallbacks(visualAdjudicationRequired, {
        enabled: true,
        ownerOptIn: true,
        distillation: new DistillationLedger(),
        model: {
          identity: modelIdentity,
          consult: (request) => ({
            candidateId: request.candidates[index]!.id,
          }),
        },
      })
    const first = await resolveCandidateAt(0)
    expect(await resolvePdfModelFallbacks(first)).toEqual(first)

    const unresolved = structuredClone(visualAdjudicationRequired)
    unresolved.modelConsultations = structuredClone(first.modelConsultations)
    await expect(resolvePdfModelFallbacks(unresolved)).rejects.toThrow(
      'INVALID_MODEL_CONSULTATION_RECEIPT',
    )

    const differentlyResolved = await resolveCandidateAt(1)
    differentlyResolved.modelConsultations = structuredClone(
      first.modelConsultations,
    )
    await expect(resolvePdfModelFallbacks(differentlyResolved)).rejects.toThrow(
      'INVALID_MODEL_CONSULTATION_RECEIPT',
    )

    const erasedHistory = structuredClone(first)
    erasedHistory.modelConsultations = {
      schemaVersion: '1.0.0',
      documentId: first.paper.id,
      sourceSha256: first.source.sha256,
      consultations: [],
      decisions: [],
      metrics: {
        totalDecisionCount: 0,
        totalConsultationCount: 0,
        consultationRate: 0,
        byDecisionClass: {},
      },
      semanticStateSha256: first.modelConsultations!.semanticStateSha256,
    }
    await expect(resolvePdfModelFallbacks(erasedHistory)).rejects.toThrow(
      'INVALID_MODEL_CONSULTATION_RECEIPT',
    )

    const renamedSource = structuredClone(first)
    renamedSource.source.fileName = 'same-source-renamed.pdf'
    await expect(resolvePdfModelFallbacks(renamedSource)).resolves.toEqual(
      renamedSource,
    )
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
        PDF_CAPTION_UNIQUE_BOUNDED_DISTANCE_RULE_ID,
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
        deterministicRuleId: PDF_CAPTION_UNIQUE_BOUNDED_DISTANCE_RULE_ID,
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
})

import { describe, expect, it, vi } from 'vitest'
import {
  MODEL_FALLBACK_DECISION_CLASSES,
  MODEL_FALLBACK_REFERENCE_FIXTURES,
  ModelFallbackLedger,
  ModelConsultationGate,
  createReferenceDistillationLedger,
  verifyModelDecisionProposal,
} from './model-fallback'

const modelIdentity = {
  providerId: 'recorded-stub',
  modelId: 'candidate-picker',
  modelVersion: '1.0.0',
  modelDigest: 'a'.repeat(64),
}

describe('model fallback consultation gate', () => {
  it('is disabled by default and preserves fail-closed review behavior', async () => {
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const ledger = new ModelFallbackLedger()
    const gate = new ModelConsultationGate({
      model: { identity: modelIdentity, consult },
      ledger,
    })

    const result = await gate.decide(MODEL_FALLBACK_REFERENCE_FIXTURES[0]!)
    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('MODEL_ASSISTANCE_DISABLED')
    expect(consult).not.toHaveBeenCalled()
    expect(ledger.metrics()).toMatchObject({
      totalDecisionCount: 1,
      totalConsultationCount: 0,
      consultationRate: 0,
    })
  })

  it('refuses an enabled provider without a complete supplied identity', async () => {
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      model: { consult },
    })

    const result = await gate.decide(MODEL_FALLBACK_REFERENCE_FIXTURES[0]!)

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('MODEL_IDENTITY_REQUIRED')
    expect(result.provenance).toBeNull()
    expect(consult).not.toHaveBeenCalled()
  })

  it('records the request before consulting and persists candidate-constrained provenance', async () => {
    const ledger = new ModelFallbackLedger()
    let requestObserved = false
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger,
      model: {
        identity: modelIdentity,
        consult: (request) => {
          requestObserved =
            ledger.query({ documentId: request.documentId })[0]?.status ===
            'pending'
          return {
            proposal: { candidateId: 'caption-figure-1' },
            costUsd: 0.012,
          }
        },
      },
    })

    const result = await gate.decide(MODEL_FALLBACK_REFERENCE_FIXTURES[0]!)
    expect(requestObserved).toBe(true)
    expect(result.status).toBe('consulted')
    expect(result.choice).toEqual({
      candidateId: 'caption-figure-1',
    })
    expect(result.provenance).toMatchObject({
      decisionClass: MODEL_FALLBACK_DECISION_CLASSES.captionAssociation,
      model: modelIdentity,
      promptHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      candidateIds: ['caption-figure-1', 'caption-figure-2'],
      choice: { candidateId: 'caption-figure-1' },
      costUsd: 0.012,
      status: 'accepted',
    })
    expect(ledger.receiptFor('fixture-caption').consultations).toHaveLength(1)
  })

  it('rejects out-of-set and authored payloads into review-required', async () => {
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[1]!
    expect(
      verifyModelDecisionProposal(point, { candidateId: 'invented' }),
    ).toMatchObject({
      status: 'rejected',
      code: 'OUT_OF_CANDIDATE_SET',
    })
    expect(
      verifyModelDecisionProposal(point, {
        candidateId: 'note-body-1',
        text: 'made up',
      } as never),
    ).toMatchObject({
      status: 'rejected',
      code: 'MODEL_AUTHORED_TEXT',
    })
    expect(
      verifyModelDecisionProposal(point, {
        candidateId: 'note-body-1',
        bounds: { x: 0 },
      } as never),
    ).toMatchObject({
      status: 'rejected',
      code: 'MODEL_AUTHORED_ASSET_BOUNDS',
    })

    const gate = new ModelConsultationGate({
      enabled: true,
      model: {
        identity: modelIdentity,
        consult: () => ({ candidateId: 'invented' }),
      },
    })
    const result = await gate.decide(point)
    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('OUT_OF_CANDIDATE_SET')
    expect(result.provenance?.status).toBe('rejected')
  })

  it('rejects fields outside the exact provider response wrapper', async () => {
    const gate = new ModelConsultationGate({
      enabled: true,
      model: {
        identity: modelIdentity,
        consult: () => ({
          proposal: { candidateId: 'caption-figure-1' },
          text: 'model-authored wrapper content',
        }) as never,
      },
    })

    const result = await gate.decide(MODEL_FALLBACK_REFERENCE_FIXTURES[0]!)

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('MODEL_RESPONSE_UNKNOWN_FIELD')
    expect(result.provenance).toMatchObject({
      status: 'rejected',
      failureCode: 'MODEL_RESPONSE_UNKNOWN_FIELD',
    })
  })

  it('names a byte-stability mismatch when the same request changes choice', async () => {
    const ledger = new ModelFallbackLedger()
    let invocation = 0
    const gate = new ModelConsultationGate({
      enabled: true,
      ledger,
      model: {
        identity: modelIdentity,
        consult: () => {
          invocation += 1
          return {
            candidateId: invocation === 1 ? 'note-body-1' : 'note-body-2',
          }
        },
      },
    })
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[1]!
    expect((await gate.decide(point)).status).toBe('consulted')
    const second = await gate.decide(point)
    expect(second.status).toBe('review-required')
    expect(second.diagnostic).toBe('BYTE_STABILITY_MISMATCH')
    expect(
      ledger.recordsFor({ decisionClass: point.decisionClass }),
    ).toHaveLength(2)
  })

  it('does not consult when deterministic evidence is sufficient', async () => {
    const consult = vi.fn(() => ({ candidateId: 'order-a-b' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      model: { identity: modelIdentity, consult },
    })
    const point = {
      ...MODEL_FALLBACK_REFERENCE_FIXTURES[2]!,
      status: 'deterministic' as const,
      deterministicChoice: 'order-a-b',
    }
    const result = await gate.decide(point)
    expect(result.status).toBe('deterministic')
    expect(consult).not.toHaveBeenCalled()
  })

  it('fails closed without consulting when sufficient evidence has no choice', async () => {
    const consult = vi.fn(() => ({ candidateId: 'order-a-b' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      model: { identity: modelIdentity, consult },
    })
    const point = {
      ...MODEL_FALLBACK_REFERENCE_FIXTURES[2]!,
      insufficientEvidence: false,
      evidenceStatus: 'sufficient' as const,
    }

    const result = await gate.decide(point)

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('NO_CANDIDATE_CHOICE')
    expect(consult).not.toHaveBeenCalled()
  })

  it('retires a class only after its generated ambiguity fixture has a valid rule', async () => {
    const ledger = new ModelFallbackLedger()
    const gate = new ModelConsultationGate({
      enabled: true,
      ledger,
      model: {
        identity: modelIdentity,
        consult: () => ({ candidateId: 'caption-figure-2' }),
      },
    })
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    expect((await gate.decide(point)).status).toBe('consulted')
    const entry = ledger.retireDecisionClass(
      point.decisionClass,
      () => 'caption-figure-2',
      'caption-association-v1',
    )
    expect(entry).toMatchObject({
      decisionClass: point.decisionClass,
      fixtureCount: 1,
      consultationCount: 0,
      retired: true,
      deterministicRuleId: 'caption-association-v1',
    })

    const future = await gate.decide({
      ...point,
      decisionId: 'caption-2',
    })
    expect(future.status).toBe('deterministic')
    expect(future.choice).toEqual({ candidateId: 'caption-figure-2' })
    expect(ledger.metrics(point.documentId)).toMatchObject({
      totalConsultationCount: 0,
    })
  })

  it('ships the three reference classes as distillation fixtures', () => {
    const ledger = createReferenceDistillationLedger()
    expect(ledger.entries()).toHaveLength(3)
    expect(ledger.entries().map(({ decisionClass }) => decisionClass)).toEqual(
      [
        MODEL_FALLBACK_DECISION_CLASSES.captionAssociation,
        MODEL_FALLBACK_DECISION_CLASSES.noteMarkerMatch,
        MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie,
      ].sort(),
    )
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  MODEL_FALLBACK_DECISION_CLASSES,
  MODEL_FALLBACK_REFERENCE_FIXTURES,
  type ModelDecisionRequest,
  type ModelFallbackCandidate,
  ModelFallbackLedger,
  ModelConsultationGate,
  createReferenceDistillationLedger,
  validateModelConsultationReceipt,
  verifyModelDecisionProposal,
} from './model-fallback'

const modelIdentity = {
  providerId: 'recorded-stub',
  modelId: 'candidate-picker',
  modelVersion: '1.0.0',
  modelDigest: 'a'.repeat(64),
}

const credentialShapedIds = [
  ['openai-legacy', ['sk', 'FAKEFAKEFAKEFAKEFAKEFAKE'].join('-')],
  ['openai', ['sk', 'proj', 'FAKEFAKEFAKEFAKEFAKEFAKE'].join('-')],
  ['aws', ['AKIA', 'IOSFODNN7EXAMPLE'].join('')],
  ['bearer', ['Bearer', 'FAKEFAKEFAKEFAKE'].join(':')],
  [
    'jwt',
    ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJmYWtlIn0', 'ZmFrZXNpZ25hdHVyZQ'].join(
      '.',
    ),
  ],
  ['private-key', ['BEGIN', 'PRIVATE', 'KEY', 'FAKEFAKE'].join('-')],
] as const

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

  it('preserves the disabled path without consultation-only provenance inputs', async () => {
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const gate = new ModelConsultationGate({
      model: { identity: modelIdentity, consult },
    })

    const result = await gate.decide({
      ...MODEL_FALLBACK_REFERENCE_FIXTURES[0]!,
      sourceSha256: undefined,
      inputs: { optionalEvidence: undefined } as never,
    })

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('MODEL_ASSISTANCE_DISABLED')
    expect(consult).not.toHaveBeenCalled()
  })

  it('requires explicit owner opt-in even when model assistance is enabled', async () => {
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      model: { identity: modelIdentity, consult },
    })

    const result = await gate.decide(MODEL_FALLBACK_REFERENCE_FIXTURES[0]!)

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('MODEL_ASSISTANCE_DISABLED')
    expect(consult).not.toHaveBeenCalled()
  })

  it('refuses an enabled provider without a complete supplied identity', async () => {
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      model: { consult },
    })

    const result = await gate.decide(MODEL_FALLBACK_REFERENCE_FIXTURES[0]!)

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('MODEL_IDENTITY_REQUIRED')
    expect(result.provenance).toBeNull()
    expect(consult).not.toHaveBeenCalled()
  })

  it('uses a supplied identity with a bare consultation client', async () => {
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      model: { consult },
      modelIdentity,
    })

    const result = await gate.decide(MODEL_FALLBACK_REFERENCE_FIXTURES[0]!)

    expect(result.status).toBe('consulted')
    expect(result.provenance?.model).toEqual(modelIdentity)
    expect(consult).toHaveBeenCalledOnce()
  })

  it('rejects a non-string model identity at the boundary', () => {
    expect(
      () =>
        new ModelConsultationGate({
          enabled: true,
          ownerOptIn: true,
          model: {
            identity: { ...modelIdentity, providerId: 7 as never },
            consult: () => ({ candidateId: 'caption-figure-1' }),
          },
        }),
    ).toThrow('INVALID_MODEL_IDENTITY')
  })

  it('rejects an invalid explicit prompt-template digest at construction', () => {
    expect(
      () =>
        new ModelConsultationGate({
          promptTemplateSha256: 'not-a-sha256',
        }),
    ).toThrow('INVALID_PROMPT_TEMPLATE_SHA256')
  })

  it.each(credentialShapedIds)(
    'rejects %s credential-shaped model identity values',
    (_name, value) => {
      expect(
        () =>
          new ModelConsultationGate({
            enabled: true,
            ownerOptIn: true,
            model: {
              identity: { ...modelIdentity, providerId: value },
              consult: () => ({ candidateId: 'caption-figure-1' }),
            },
          }),
      ).toThrow('INVALID_MODEL_IDENTITY')
    },
  )

  it.each(['providerId', 'modelId', 'modelVersion', 'modelDigest'] as const)(
    'rejects a credential-shaped %s',
    (field) => {
      expect(
        () =>
          new ModelConsultationGate({
            enabled: true,
            ownerOptIn: true,
            model: {
              identity: {
                ...modelIdentity,
                [field]: credentialShapedIds[0][1],
              },
              consult: () => ({ candidateId: 'caption-figure-1' }),
            },
          }),
      ).toThrow('INVALID_MODEL_IDENTITY')
    },
  )

  it.each([
    ['provider', 'conflicting-provider'],
    ['id', 'conflicting-model'],
    ['version', 'conflicting-version'],
    ['digest', 'conflicting-digest'],
  ])('rejects a conflicting legacy model identity %s', (field, value) => {
    expect(
      () =>
        new ModelConsultationGate({
          enabled: true,
          ownerOptIn: true,
          model: {
            identity: {
              ...modelIdentity,
              [field]: value,
            },
            consult: () => ({ candidateId: 'caption-figure-1' }),
          },
        }),
    ).toThrow('CONFLICTING_MODEL_IDENTITY')
  })

  it('rejects a provider identity that conflicts with the pinned identity', () => {
    expect(
      () =>
        new ModelConsultationGate({
          enabled: true,
          ownerOptIn: true,
          modelIdentity,
          model: {
            identity: {
              ...modelIdentity,
              modelDigest: 'b'.repeat(64),
            },
            consult: () => ({ candidateId: 'caption-figure-1' }),
          },
        }),
    ).toThrow('CONFLICTING_MODEL_IDENTITY')
  })

  it('preserves the receiver for class-based consultation clients', async () => {
    class RecordedClient {
      readonly identity = modelIdentity
      readonly candidateId = 'caption-figure-1'

      consult() {
        return { candidateId: this.candidateId }
      }
    }

    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      model: new RecordedClient(),
    })

    const result = await gate.decide(MODEL_FALLBACK_REFERENCE_FIXTURES[0]!)

    expect(result.status).toBe('consulted')
    expect(result.choice).toEqual({ candidateId: 'caption-figure-1' })
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
      promptTemplateSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      promptHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      candidateIds: ['caption-figure-1', 'caption-figure-2'],
      choice: { candidateId: 'caption-figure-1' },
      costUsd: 0.012,
      status: 'accepted',
    })
    expect(ledger.receiptFor('fixture-caption').consultations).toHaveLength(1)
  })

  it.each(credentialShapedIds)(
    'keeps %s credential-shaped identifiers out of provider requests and receipts',
    async (_name, value) => {
      const ledger = new ModelFallbackLedger()
      const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
      const gate = new ModelConsultationGate({
        enabled: true,
        ownerOptIn: true,
        ledger,
        model: { identity: modelIdentity, consult },
      })
      const point = {
        ...MODEL_FALLBACK_REFERENCE_FIXTURES[0]!,
        documentId: value,
      }

      const result = await gate.decide(point)

      expect(result).toMatchObject({
        status: 'review-required',
        diagnostic: 'INVALID_MODEL_DECISION_POINT',
      })
      expect(consult).not.toHaveBeenCalled()
      expect(JSON.stringify(ledger.toJSON())).not.toContain(value)
    },
  )

  it('rejects a credential-shaped candidate id before provider invocation', async () => {
    const value = credentialShapedIds[0][1]
    const ledger = new ModelFallbackLedger()
    const consult = vi.fn(() => ({ candidateId: value }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger,
      model: { identity: modelIdentity, consult },
    })
    const reference = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    const point = {
      ...reference,
      candidates: reference.candidates.map((candidate, index) =>
        index === 0 ? { ...candidate, id: value } : candidate,
      ),
    }

    const result = await gate.decide(point)

    expect(result).toMatchObject({
      status: 'review-required',
      diagnostic: 'INVALID_MODEL_CANDIDATE_SET',
    })
    expect(consult).not.toHaveBeenCalled()
    expect(JSON.stringify(ledger.toJSON())).not.toContain(value)
  })

  it('rejects a credential-shaped nested evidence id before provider invocation', async () => {
    const value = credentialShapedIds[1][1]
    const ledger = new ModelFallbackLedger()
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger,
      model: { identity: modelIdentity, consult },
    })
    const reference = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    const point = {
      ...reference,
      inputs: { ...reference.inputs, figureId: value },
    }

    const result = await gate.decide(point)

    expect(result).toMatchObject({
      status: 'review-required',
      diagnostic: 'UNSAFE_MODEL_DECISION_EVIDENCE',
    })
    expect(consult).not.toHaveBeenCalled()
    expect(JSON.stringify(ledger.toJSON())).not.toContain(value)
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
      ownerOptIn: true,
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

  it.each([
    ['asset_bytes', 'MODEL_AUTHORED_ASSET_BYTES'],
    ['asset_bounds', 'MODEL_AUTHORED_ASSET_BOUNDS'],
    ['WIDTH', 'MODEL_AUTHORED_ASSET_BOUNDS'],
    ['asset_bytes.', 'MODEL_AUTHORED_ASSET_BYTES'],
    ['asset_bounds.', 'MODEL_AUTHORED_ASSET_BOUNDS'],
    ['.WIDTH.', 'MODEL_AUTHORED_ASSET_BOUNDS'],
  ])('classifies normalized forbidden field %s', (field, code) => {
    expect(
      verifyModelDecisionProposal(MODEL_FALLBACK_REFERENCE_FIXTURES[0]!, {
        candidateId: 'caption-figure-1',
        [field]: 'forbidden',
      } as never),
    ).toMatchObject({ status: 'rejected', code })
  })

  it('rejects contradictory nested candidate references', () => {
    expect(
      verifyModelDecisionProposal(MODEL_FALLBACK_REFERENCE_FIXTURES[1]!, {
        candidateId: 'note-body-1',
        choice: { candidateId: 'note-body-2' },
      }),
    ).toMatchObject({
      status: 'rejected',
      code: 'CONFLICTING_MODEL_CHOICE',
    })
  })

  it('rejects contradictory nested association references', () => {
    expect(
      verifyModelDecisionProposal(MODEL_FALLBACK_REFERENCE_FIXTURES[0]!, {
        candidateId: 'caption-figure-1',
        associationId: 'figure-1',
        association: { id: 'figure-2' },
      }),
    ).toMatchObject({
      status: 'rejected',
      code: 'CONFLICTING_MODEL_ASSOCIATION',
    })
  })

  it('rejects fields outside the exact nested association reference', () => {
    expect(
      verifyModelDecisionProposal(MODEL_FALLBACK_REFERENCE_FIXTURES[0]!, {
        candidateId: 'caption-figure-1',
        association: {
          id: 'figure-1',
          destination: 'model-authored-destination',
        },
      } as never),
    ).toMatchObject({
      status: 'rejected',
      code: 'MODEL_PROPOSAL_UNKNOWN_FIELD',
    })
  })

  it('rejects hidden fields outside the exact model proposal contract', () => {
    const hiddenText = Object.defineProperty(
      { candidateId: 'caption-figure-1' },
      'text',
      { value: 'hidden model-authored text' },
    )
    const hiddenAssociationField = {
      candidateId: 'caption-figure-1',
      association: Object.defineProperty({ id: 'figure-1' }, 'destination', {
        value: 'hidden destination',
      }),
    }
    const symbolField = Object.assign(
      { candidateId: 'caption-figure-1' },
      { [Symbol('hidden')]: true },
    )

    for (const proposal of [hiddenText, hiddenAssociationField, symbolField]) {
      expect(
        verifyModelDecisionProposal(
          MODEL_FALLBACK_REFERENCE_FIXTURES[0]!,
          proposal,
        ),
      ).toMatchObject({ status: 'rejected' })
    }
  })

  it('rejects arbitrary metadata on candidate associations', async () => {
    const consult = vi.fn(() => ({
      candidateId: 'caption-figure-1',
      associationId: 'figure-1',
    }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      model: { identity: modelIdentity, consult },
    })
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!

    const result = await gate.decide({
      ...point,
      candidates: point.candidates.map((candidate) =>
        candidate.id === 'caption-figure-1'
          ? {
              id: candidate.id,
              association: {
                id: 'figure-1',
                kind: 'figure',
                confidence: 1,
              },
            }
          : candidate,
      ),
    })

    expect(result).toMatchObject({
      status: 'review-required',
      diagnostic: 'UNSAFE_MODEL_DECISION_EVIDENCE',
    })
    expect(consult).not.toHaveBeenCalled()
  })

  it('rejects contradictory association aliases in deterministic candidates', async () => {
    const consult = vi.fn(() => ({
      candidateId: 'caption-figure-1',
      associationId: 'figure-1',
    }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      model: { identity: modelIdentity, consult },
    })
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!

    const result = await gate.decide({
      ...point,
      candidates: point.candidates.map((candidate) =>
        candidate.id === 'caption-figure-1'
          ? {
              id: candidate.id,
              associationId: 'figure-1',
              association: { id: 'figure-2' },
            }
          : candidate,
      ),
    })

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('INVALID_MODEL_CANDIDATE_SET')
    expect(consult).not.toHaveBeenCalled()
  })

  it('fails closed when an unselected candidate association accessor throws', async () => {
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    const candidates = point.candidates.map((candidate) => ({ ...candidate }))
    Object.defineProperty(candidates[1]!, 'association', {
      enumerable: true,
      get() {
        throw new Error('association getter invoked')
      },
    })
    const gate = new ModelConsultationGate()

    const result = await gate.decide({
      ...point,
      candidates,
      status: 'deterministic',
      insufficientEvidence: false,
      deterministicChoice: 'caption-figure-1',
    })

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('CONFLICTING_CANDIDATE_ASSOCIATION')
  })

  it.each([
    { name: 'missing', candidate: {} },
    { name: 'non-string', candidate: { id: 123 } },
  ])(
    'rejects a $name deterministic candidate id without consulting',
    async ({ candidate }) => {
      const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
      const gate = new ModelConsultationGate({
        enabled: true,
        ownerOptIn: true,
        model: { identity: modelIdentity, consult },
      })

      const result = await gate.decide({
        ...MODEL_FALLBACK_REFERENCE_FIXTURES[0]!,
        candidates: [candidate] as never,
      })

      expect(result.status).toBe('review-required')
      expect(result.diagnostic).toBe('INVALID_MODEL_CANDIDATE_SET')
      expect(consult).not.toHaveBeenCalled()
    },
  )

  it('rejects a sparse candidate array before consulting', async () => {
    const candidates = new Array<ModelFallbackCandidate>(2)
    candidates[1] = { id: 'caption-figure-1', associationId: 'figure-1' }
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const ledger = new ModelFallbackLedger()
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger,
      model: { identity: modelIdentity, consult },
    })

    const result = await gate.decide({
      ...MODEL_FALLBACK_REFERENCE_FIXTURES[0]!,
      candidates,
    })

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('INVALID_MODEL_CANDIDATE_SET')
    expect(consult).not.toHaveBeenCalled()
    expect(ledger.recordsFor()).toEqual([])
  })

  it('rejects hidden candidate-array state before consulting', async () => {
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    const candidates = point.candidates.map((candidate) => ({ ...candidate }))
    Object.defineProperty(candidates, 'hidden', { value: 'not committed' })
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      model: { identity: modelIdentity, consult },
    })

    const result = await gate.decide({ ...point, candidates })

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('INVALID_MODEL_CANDIDATE_SET')
    expect(consult).not.toHaveBeenCalled()
  })

  it('rejects a malformed supplied source hash without consulting', async () => {
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      model: { identity: modelIdentity, consult },
    })

    const result = await gate.decide({
      ...MODEL_FALLBACK_REFERENCE_FIXTURES[0]!,
      sourceSha256: 'not-a-source-digest',
    })

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('INVALID_SOURCE_SHA256')
    expect(consult).not.toHaveBeenCalled()
  })

  it('requires a source hash before model consultation', async () => {
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      model: { identity: modelIdentity, consult },
    })

    const result = await gate.decide({
      ...MODEL_FALLBACK_REFERENCE_FIXTURES[0]!,
      sourceSha256: undefined,
    })

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('SOURCE_SHA256_REQUIRED')
    expect(consult).not.toHaveBeenCalled()
  })

  it.each([
    { field: 'documentId', value: '' },
    { field: 'decisionId', value: '' },
    { field: 'decisionClass', value: '' },
  ])(
    'rejects an invalid $field before consulting',
    async ({ field, value }) => {
      const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
      const gate = new ModelConsultationGate({
        enabled: true,
        ownerOptIn: true,
        model: { identity: modelIdentity, consult },
      })

      const result = await gate.decide({
        ...MODEL_FALLBACK_REFERENCE_FIXTURES[0]!,
        [field]: value,
      })

      expect(result.status).toBe('review-required')
      expect(result.diagnostic).toBe('INVALID_MODEL_DECISION_POINT')
      expect(consult).not.toHaveBeenCalled()
    },
  )

  it('requires an explicit insufficient-evidence signal before consulting', async () => {
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      model: { identity: modelIdentity, consult },
    })
    const { insufficientEvidence: _omitted, ...point } =
      MODEL_FALLBACK_REFERENCE_FIXTURES[0]!

    const result = await gate.decide(point)

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('NO_CANDIDATE_CHOICE')
    expect(consult).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'non-JSON input',
      patch: { inputs: { value: undefined } },
      diagnostic: 'INVALID_MODEL_DECISION_INPUTS',
    },
    {
      name: 'non-JSON candidate metadata',
      patch: {
        candidates: [
          {
            id: 'caption-figure-1',
            associationId: 'figure-1',
            value: undefined,
          },
        ],
      },
      diagnostic: 'INVALID_MODEL_CANDIDATE_SET',
    },
    {
      name: 'empty candidate association id',
      patch: {
        candidates: [{ id: 'caption-figure-1', associationId: '' }],
      },
      diagnostic: 'INVALID_MODEL_CANDIDATE_SET',
    },
  ])('rejects $name before consulting', async ({ patch, diagnostic }) => {
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      model: { identity: modelIdentity, consult },
    })

    const result = await gate.decide({
      ...MODEL_FALLBACK_REFERENCE_FIXTURES[0]!,
      ...patch,
    } as never)

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe(diagnostic)
    expect(consult).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'raw source input',
      patch: { inputs: { nested: { source_text: 'must-not-persist' } } },
    },
    {
      name: 'credential candidate metadata',
      patch: {
        candidates: MODEL_FALLBACK_REFERENCE_FIXTURES[0]!.candidates.map(
          (candidate, index) =>
            index === 0
              ? { ...candidate, apiKey: 'must-not-persist' }
              : candidate,
        ),
      },
    },
    {
      name: 'composite credential candidate metadata',
      patch: {
        candidates: MODEL_FALLBACK_REFERENCE_FIXTURES[0]!.candidates.map(
          (candidate, index) =>
            index === 0
              ? { ...candidate, refreshToken: 'must-not-persist' }
              : candidate,
        ),
      },
    },
    ...[
      ['normalized token alias', 'TOKEN'],
      ['separator-obfuscated token alias', 'to_ken'],
      ['separator-obfuscated API key', 'a_p_i_k_e_y'],
      ['non-ASCII credential key', 'ｓｅｃｒｅｔ'],
      ['separator-obfuscated raw source key', 'source_t_e_x_t'],
    ].map(([name, field]) => ({
      name,
      patch: {
        candidates: MODEL_FALLBACK_REFERENCE_FIXTURES[0]!.candidates.map(
          (candidate, index) =>
            index === 0
              ? { ...candidate, [field!]: 'must-not-persist' }
              : candidate,
        ),
      },
    })),
  ])('rejects $name before recording or consulting', async ({ patch }) => {
    const ledger = new ModelFallbackLedger()
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger,
      model: { identity: modelIdentity, consult },
    })

    const result = await gate.decide({
      ...MODEL_FALLBACK_REFERENCE_FIXTURES[0]!,
      ...patch,
    })

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('UNSAFE_MODEL_DECISION_EVIDENCE')
    expect(consult).not.toHaveBeenCalled()
    expect(ledger.recordsFor()).toEqual([])
    expect(JSON.stringify(ledger.toJSON())).not.toContain('must-not-persist')
  })

  it.each([
    {
      name: 'an innocuous input key',
      patch: { inputs: { evidence: 'PRIVATE_SOURCE_SENTINEL' } },
    },
    {
      name: 'an innocuous candidate key',
      patch: {
        candidates: MODEL_FALLBACK_REFERENCE_FIXTURES[0]!.candidates.map(
          (candidate, index) =>
            index === 0
              ? { ...candidate, payload: 'PRIVATE_SOURCE_SENTINEL' }
              : candidate,
        ),
      },
    },
    {
      name: 'nested association metadata',
      patch: {
        candidates: [
          {
            id: 'caption-figure-1',
            association: {
              id: 'figure-1',
              metadata: 'PRIVATE_SOURCE_SENTINEL',
            },
          },
          MODEL_FALLBACK_REFERENCE_FIXTURES[0]!.candidates[1]!,
        ],
      },
    },
    {
      name: 'a lowercase token candidate key',
      patch: {
        candidates: MODEL_FALLBACK_REFERENCE_FIXTURES[0]!.candidates.map(
          (candidate, index) =>
            index === 0
              ? { ...candidate, token: 'PRIVATE_SOURCE_SENTINEL' }
              : candidate,
        ),
      },
    },
  ])('rejects private data disguised under $name', async ({ patch }) => {
    const ledger = new ModelFallbackLedger()
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger,
      model: { identity: modelIdentity, consult },
    })

    const result = await gate.decide({
      ...MODEL_FALLBACK_REFERENCE_FIXTURES[0]!,
      ...patch,
    } as never)

    expect(result).toMatchObject({
      status: 'review-required',
      diagnostic: 'UNSAFE_MODEL_DECISION_EVIDENCE',
    })
    expect(consult).not.toHaveBeenCalled()
    expect(ledger.recordsFor()).toEqual([])
    expect(JSON.stringify(ledger.toJSON())).not.toContain(
      'PRIVATE_SOURCE_SENTINEL',
    )
  })

  it('rejects unsafe evidence at the public ledger boundary', () => {
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    const request: ModelDecisionRequest = {
      schemaVersion: '1.0.0',
      documentId: point.documentId,
      decisionId: point.decisionId,
      decisionClass: point.decisionClass,
      sourceSha256: point.sourceSha256!,
      inputs: { payload: 'PRIVATE_SOURCE_SENTINEL' },
      candidates: point.candidates,
      promptTemplateSha256: '1'.repeat(64),
      promptHash: 'e'.repeat(64),
    }

    expect(() =>
      new ModelFallbackLedger().beginConsultation(request, modelIdentity),
    ).toThrow('UNSAFE_MODEL_DECISION_EVIDENCE')
  })

  it('rejects a mismatched prompt commitment at the public ledger boundary', () => {
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    const ledger = new ModelFallbackLedger()
    const request: ModelDecisionRequest = {
      schemaVersion: '1.0.0',
      documentId: point.documentId,
      decisionId: point.decisionId,
      decisionClass: point.decisionClass,
      sourceSha256: point.sourceSha256!,
      inputs: point.inputs,
      candidates: point.candidates,
      promptTemplateSha256: '1'.repeat(64),
      promptHash: 'e'.repeat(64),
    }

    expect(() => ledger.beginConsultation(request, modelIdentity)).toThrow(
      'INVALID_MODEL_PROMPT_COMMITMENT',
    )
    expect(ledger.recordsFor()).toEqual([])
  })

  it('rejects credential-shaped values at direct ledger mutation boundaries', async () => {
    let request: ModelDecisionRequest | undefined
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      onRequest: (current) => {
        request = current
      },
      model: {
        identity: modelIdentity,
        consult: () => ({ candidateId: 'caption-figure-1' }),
      },
    })
    expect(
      (await gate.decide(MODEL_FALLBACK_REFERENCE_FIXTURES[0]!)).status,
    ).toBe('consulted')
    expect(request).toBeDefined()

    const value = credentialShapedIds[1][1]
    const modelLedger = new ModelFallbackLedger()
    expect(() =>
      modelLedger.beginConsultation(request!, {
        ...modelIdentity,
        providerId: value,
      }),
    ).toThrow('INVALID_MODEL_IDENTITY')
    expect(JSON.stringify(modelLedger.toJSON())).not.toContain(value)

    const metricLedger = new ModelFallbackLedger()
    expect(() =>
      metricLedger.recordDecision({
        documentId: value,
        decisionId: 'decision-1',
        decisionClass: MODEL_FALLBACK_DECISION_CLASSES.captionAssociation,
        outcome: 'review-required',
        consulted: false,
      }),
    ).toThrow('INVALID_MODEL_DECISION_METRIC')
    expect(JSON.stringify(metricLedger.toJSON())).not.toContain(value)

    const completionLedger = new ModelFallbackLedger()
    const requestId = completionLedger.beginConsultation(
      request!,
      modelIdentity,
    )
    expect(() =>
      completionLedger.completeConsultation(requestId, {
        status: 'failed',
        choice: null,
        costUsd: 0,
        latencyMs: null,
        failureCode: value,
      }),
    ).toThrow('INVALID_MODEL_CONSULTATION_COMPLETION')
    expect(JSON.stringify(completionLedger.toJSON())).not.toContain(value)
  })

  it('rejects hidden and accessor-backed consultation inputs', async () => {
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      model: { identity: modelIdentity, consult },
    })
    const evidence = ['bounded']
    Object.defineProperty(evidence, 'hidden', { value: 'not committed' })
    const accessorInputs = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        throw new Error('must not invoke untrusted accessors')
      },
    })

    for (const inputs of [{ evidence }, accessorInputs]) {
      const result = await gate.decide({
        ...MODEL_FALLBACK_REFERENCE_FIXTURES[0]!,
        inputs,
      })
      expect(result.status).toBe('review-required')
      expect(result.diagnostic).toBe('INVALID_MODEL_DECISION_INPUTS')
    }
    expect(consult).not.toHaveBeenCalled()
  })

  it('rejects fields outside the exact provider response wrapper', async () => {
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: () =>
          ({
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
      ownerOptIn: true,
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

  it('enforces byte stability from a validated prior-run receipt without importing prior metrics', async () => {
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[1]!
    const priorLedger = new ModelFallbackLedger()
    const priorGate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger: priorLedger,
      model: {
        identity: modelIdentity,
        consult: () => ({ candidateId: 'note-body-1' }),
      },
    })
    expect((await priorGate.decide(point)).status).toBe('consulted')
    const priorReceipt = priorLedger.receiptFor(point.documentId)
    expect(validateModelConsultationReceipt(priorReceipt)).toBe(true)

    const ledger = new ModelFallbackLedger()
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger,
      priorReceipt,
      model: {
        identity: modelIdentity,
        consult: () => ({ candidateId: 'note-body-2' }),
      },
    })
    const outcome = await gate.decide(point)

    expect(outcome).toMatchObject({
      status: 'review-required',
      diagnostic: 'BYTE_STABILITY_MISMATCH',
    })
    expect(ledger.recordsFor()).toEqual([
      expect.objectContaining({
        status: 'rejected',
        failureCode: 'BYTE_STABILITY_MISMATCH',
      }),
    ])
    expect(ledger.metrics(point.documentId)).toMatchObject({
      totalDecisionCount: 1,
      totalConsultationCount: 1,
    })
  })

  it('separates prior choices produced by different prompt templates', async () => {
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[1]!
    const templateA = '1'.repeat(64)
    const templateB = '2'.repeat(64)
    const requests: ModelDecisionRequest[] = []
    const priorLedger = new ModelFallbackLedger()
    const priorGate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      promptTemplateSha256: templateA,
      ledger: priorLedger,
      model: {
        identity: modelIdentity,
        consult: (request: ModelDecisionRequest) => {
          requests.push(request)
          return { candidateId: 'note-body-1' }
        },
      },
    } as never)
    expect((await priorGate.decide(point)).status).toBe('consulted')
    const priorReceipt = priorLedger.receiptFor(point.documentId)

    const currentLedger = new ModelFallbackLedger()
    const currentGate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      promptTemplateSha256: templateB,
      priorReceipt,
      ledger: currentLedger,
      model: {
        identity: modelIdentity,
        consult: (request: ModelDecisionRequest) => {
          requests.push(request)
          return { candidateId: 'note-body-2' }
        },
      },
    } as never)

    const outcome = await currentGate.decide(point)
    const [requestA, requestB] = requests
    const priorRecord = priorReceipt.consultations[0] as Record<string, unknown>
    const currentRecord = currentLedger.recordsFor()[0] as Record<
      string,
      unknown
    >

    expect(outcome).toMatchObject({
      status: 'consulted',
      choice: { candidateId: 'note-body-2' },
    })
    expect(requestA).toHaveProperty('promptTemplateSha256', templateA)
    expect(requestB).toHaveProperty('promptTemplateSha256', templateB)
    expect(requestA?.promptHash).not.toBe(requestB?.promptHash)
    expect(priorRecord.promptTemplateSha256).toBe(templateA)
    expect(currentRecord.promptTemplateSha256).toBe(templateB)
    expect(priorRecord.requestId).not.toBe(currentRecord.requestId)
  })

  it('rejects an invalid or pending prior-run receipt at construction', async () => {
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    const ledger = new ModelFallbackLedger()
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger,
      model: {
        identity: modelIdentity,
        consult: () => ({ candidateId: 'caption-figure-1' }),
      },
    })
    expect((await gate.decide(point)).status).toBe('consulted')
    const invalid = ledger.receiptFor(point.documentId)
    invalid.consultations[0]!.status = 'pending'
    invalid.consultations[0]!.choice = null

    expect(() => new ModelConsultationGate({ priorReceipt: invalid })).toThrow(
      'INVALID_PRIOR_MODEL_CONSULTATION_RECEIPT',
    )
  })

  it('does not let a provider mutate the request used for byte stability', async () => {
    const ledger = new ModelFallbackLedger()
    let invocation = 0
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger,
      model: {
        identity: modelIdentity,
        consult: (request) => {
          invocation += 1
          if (invocation === 2) request.promptHash = 'f'.repeat(64)
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
      validateModelConsultationReceipt(ledger.receiptFor(point.documentId)),
    ).toBe(true)
  })

  it('verifies provider output against the pre-call candidate snapshot', async () => {
    const ledger = new ModelFallbackLedger()
    const reference = MODEL_FALLBACK_REFERENCE_FIXTURES[1]!
    const point = {
      ...reference,
      candidates: reference.candidates.map((candidate) => ({ ...candidate })),
    }
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger,
      model: {
        identity: modelIdentity,
        consult: () => {
          ;(point.candidates as ModelFallbackCandidate[]).splice(
            0,
            point.candidates.length,
            { id: 'invented-after-request' },
          )
          return { candidateId: 'invented-after-request' }
        },
      },
    })

    const result = await gate.decide(point)

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('OUT_OF_CANDIDATE_SET')
    expect(result.provenance?.candidateIds).toEqual([
      'note-body-1',
      'note-body-2',
    ])
    expect(
      validateModelConsultationReceipt(ledger.receiptFor(point.documentId)),
    ).toBe(true)
  })

  it('uses the pre-call identity snapshot for outcomes and metrics', async () => {
    const ledger = new ModelFallbackLedger()
    const reference = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    const point = {
      ...reference,
      candidates: reference.candidates.map((candidate) => ({ ...candidate })),
    }
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger,
      model: {
        identity: modelIdentity,
        consult: () => {
          point.documentId = 'mutated-document'
          point.decisionId = 'mutated-decision'
          return { candidateId: 'caption-figure-1' }
        },
      },
    })

    const result = await gate.decide(point)

    expect(result).toMatchObject({
      status: 'consulted',
      documentId: reference.documentId,
      decisionId: reference.decisionId,
    })
    expect(ledger.decisionsFor()).toMatchObject([
      {
        documentId: reference.documentId,
        decisionId: reference.decisionId,
      },
    ])
    expect(
      validateModelConsultationReceipt(ledger.receiptFor(reference.documentId)),
    ).toBe(true)
  })

  it('closes both records for concurrent identical consultations', async () => {
    const ledger = new ModelFallbackLedger()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const consult = vi.fn(async () => {
      await barrier
      return { candidateId: 'caption-figure-1' }
    })
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger,
      model: { identity: modelIdentity, consult },
    })
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!

    const first = gate.decide(point)
    const second = gate.decide(point)
    await vi.waitFor(() => expect(consult).toHaveBeenCalledTimes(2))
    release()
    const outcomes = await Promise.all([first, second])

    expect(outcomes.map(({ status }) => status)).toEqual([
      'consulted',
      'consulted',
    ])
    expect(ledger.recordsFor().map(({ status }) => status)).toEqual([
      'accepted',
      'accepted',
    ])
    expect(
      validateModelConsultationReceipt(ledger.receiptFor(point.documentId)),
    ).toBe(true)
  })

  it.each(['request hook', 'provider method getter', 'response getter'])(
    'closes provenance when the %s throws',
    async (failurePoint) => {
      const ledger = new ModelFallbackLedger()
      let model: unknown = {
        identity: modelIdentity,
        consult: () => ({ candidateId: 'caption-figure-1' }),
      }
      let onRequest: (() => void) | undefined
      if (failurePoint === 'request hook') {
        onRequest = () => {
          throw new Error('request hook failed')
        }
      } else if (failurePoint === 'provider method getter') {
        model = Object.defineProperty({ identity: modelIdentity }, 'consult', {
          get() {
            throw new Error('provider method lookup failed')
          },
        })
      } else {
        model = {
          identity: modelIdentity,
          consult: () =>
            Object.defineProperty({}, 'proposal', {
              enumerable: true,
              get() {
                throw new Error('response processing failed')
              },
            }) as never,
        }
      }
      const gate = new ModelConsultationGate({
        enabled: true,
        ownerOptIn: true,
        ledger,
        model: model as never,
        onRequest,
      })
      const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!

      const result = await gate.decide(point)

      expect(result.status).toBe('review-required')
      expect(result.diagnostic).toBe('MODEL_PROVIDER_ERROR')
      expect(ledger.recordsFor()).toMatchObject([
        { status: 'failed', failureCode: 'MODEL_PROVIDER_ERROR' },
      ])
      expect(
        validateModelConsultationReceipt(ledger.receiptFor(point.documentId)),
      ).toBe(true)
    },
  )

  it('fails closed when one document id is reused for another source', async () => {
    const ledger = new ModelFallbackLedger()
    const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger,
      model: { identity: modelIdentity, consult },
    })
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!

    expect((await gate.decide(point)).status).toBe('consulted')
    const second = await gate.decide({
      ...point,
      decisionId: 'caption-other-source',
      sourceSha256: 'f'.repeat(64),
    })

    expect(second.status).toBe('review-required')
    expect(second.diagnostic).toBe('DOCUMENT_SOURCE_HASH_MISMATCH')
    expect(consult).toHaveBeenCalledOnce()
    expect(
      validateModelConsultationReceipt(ledger.receiptFor(point.documentId)),
    ).toBe(true)
  })

  it.each(['consultation-first', 'deterministic-first'] as const)(
    'prevents a deterministic decision from mixing document sources (%s)',
    async (order) => {
      const ledger = new ModelFallbackLedger()
      const consult = vi.fn(() => ({ candidateId: 'caption-figure-1' }))
      const gate = new ModelConsultationGate({
        enabled: true,
        ownerOptIn: true,
        ledger,
        model: { identity: modelIdentity, consult },
      })
      const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
      const consultedPoint = {
        ...point,
        sourceSha256:
          order === 'consultation-first' ? 'a'.repeat(64) : 'b'.repeat(64),
      }
      const deterministicPoint = {
        ...point,
        decisionId: 'caption-deterministic-source',
        sourceSha256:
          order === 'consultation-first' ? 'b'.repeat(64) : 'a'.repeat(64),
        status: 'deterministic' as const,
        insufficientEvidence: false,
        deterministicChoice: 'caption-figure-1',
      }

      const first = await gate.decide(
        order === 'consultation-first' ? consultedPoint : deterministicPoint,
      )
      const second = await gate.decide(
        order === 'consultation-first' ? deterministicPoint : consultedPoint,
      )

      expect(first.status).toBe(
        order === 'consultation-first' ? 'consulted' : 'deterministic',
      )
      expect(second.status).toBe('review-required')
      expect(second.diagnostic).toBe('DOCUMENT_SOURCE_HASH_MISMATCH')
      expect(ledger.decisionsFor()).toHaveLength(1)
      expect(consult).toHaveBeenCalledTimes(
        order === 'consultation-first' ? 1 : 0,
      )
    },
  )

  it('keeps prototype-named decision classes in consultation metrics', () => {
    const ledger = new ModelFallbackLedger()
    const objectConstructor = Object as unknown as Record<string, unknown>

    try {
      ledger.recordDecision({
        documentId: 'document-1',
        decisionId: 'decision-1',
        decisionClass: 'constructor',
        outcome: 'consulted',
        consulted: true,
      })

      const metrics = ledger.metrics()
      expect(metrics).toMatchObject({
        totalDecisionCount: 1,
        totalConsultationCount: 1,
        consultationRate: 1,
      })
      expect(Object.hasOwn(metrics.byDecisionClass, 'constructor')).toBe(true)
      expect(metrics.byDecisionClass.constructor).toEqual({
        decisionCount: 1,
        consultationCount: 1,
        consultationRate: 1,
      })
    } finally {
      delete objectConstructor.decisionCount
      delete objectConstructor.consultationCount
      delete objectConstructor.consultationRate
    }
  })

  it('does not consult when deterministic evidence is sufficient', async () => {
    const consult = vi.fn(() => ({ candidateId: 'order-a-b' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
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

  it('preserves a known source hash on deterministic receipts', async () => {
    const ledger = new ModelFallbackLedger()
    const gate = new ModelConsultationGate({ ledger })
    const point = {
      ...MODEL_FALLBACK_REFERENCE_FIXTURES[2]!,
      status: 'deterministic' as const,
      deterministicChoice: 'order-a-b',
    }

    expect((await gate.decide(point)).status).toBe('deterministic')
    const receipt = ledger.receiptFor(point.documentId)

    expect(receipt.sourceSha256).toBe(point.sourceSha256)
    expect(validateModelConsultationReceipt(receipt)).toBe(true)
  })

  it('preserves a deterministic choice without consultation-only provenance inputs', async () => {
    const consult = vi.fn(() => ({ candidateId: 'order-a-b' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      model: { identity: modelIdentity, consult },
    })
    const point = {
      ...MODEL_FALLBACK_REFERENCE_FIXTURES[2]!,
      sourceSha256: undefined,
      inputs: { optionalEvidence: undefined } as never,
      status: 'deterministic' as const,
      deterministicChoice: 'order-a-b',
    }

    const result = await gate.decide(point)

    expect(result.status).toBe('deterministic')
    expect(result.choice).toEqual({ candidateId: 'order-a-b' })
    expect(consult).not.toHaveBeenCalled()
  })

  it('rejects invalid decision identity before a deterministic outcome', async () => {
    const ledger = new ModelFallbackLedger()
    const gate = new ModelConsultationGate({ ledger })

    const result = await gate.decide({
      ...MODEL_FALLBACK_REFERENCE_FIXTURES[2]!,
      documentId: '',
      status: 'deterministic',
      deterministicChoice: 'order-a-b',
    })

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('INVALID_MODEL_DECISION_POINT')
    expect(ledger.decisionsFor()).toEqual([])
  })

  it('does not record invalid identity when candidates are also invalid', async () => {
    const ledger = new ModelFallbackLedger()
    const gate = new ModelConsultationGate({ ledger })

    const result = await gate.decide({
      ...MODEL_FALLBACK_REFERENCE_FIXTURES[0]!,
      documentId: '',
      candidates: [],
    })

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('INVALID_MODEL_DECISION_POINT')
    expect(ledger.decisionsFor()).toEqual([])
  })

  it('fails closed without consulting when sufficient evidence has no choice', async () => {
    const consult = vi.fn(() => ({ candidateId: 'order-a-b' }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
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
      ownerOptIn: true,
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
      totalConsultationCount: 1,
    })
  })

  it('never exposes private decision points through distillation APIs', () => {
    const ledger = new ModelFallbackLedger()
    const registered = ledger.distillation.registerFixture({
      ...MODEL_FALLBACK_REFERENCE_FIXTURES[0]!,
      reason: 'PRIVATE_REASON_SENTINEL',
    })
    const exposed = [
      registered,
      ledger.distillation.fixture(registered.id),
      ...ledger.distillation.fixturesFor(),
      ...ledger.distillation.entry(registered.decisionClass).fixtures,
      ...ledger.toJSON().distillation.fixtures,
    ]

    expect(exposed.every((fixture) => !Object.hasOwn(fixture!, 'point'))).toBe(
      true,
    )
    expect(JSON.stringify(exposed)).not.toContain('PRIVATE_REASON_SENTINEL')
  })

  it('refuses to retire a learned fixture to a different choice', async () => {
    const ledger = new ModelFallbackLedger()
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger,
      model: {
        identity: modelIdentity,
        consult: () => ({ candidateId: 'caption-figure-1' }),
      },
    })
    expect((await gate.decide(point)).status).toBe('consulted')

    expect(() =>
      ledger.retireDecisionClass(
        point.decisionClass,
        () => 'caption-figure-2',
        'contradictory-rule-v1',
      ),
    ).toThrow('DISTILLATION_RULE_DISAGREES_WITH_MODEL_PATH')
    expect(ledger.distillation.entry(point.decisionClass)).toMatchObject({
      retired: false,
      consultationCount: 1,
      fixtures: [
        { modelPath: { choice: { candidateId: 'caption-figure-1' } } },
      ],
    })
  })

  it('refuses retirement while a same-class consultation is pending', async () => {
    const ledger = new ModelFallbackLedger()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const consult = vi.fn(async () => {
      await barrier
      return { candidateId: 'caption-figure-1' }
    })
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger,
      model: { identity: modelIdentity, consult },
    })
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    const pending = gate.decide(point)
    await vi.waitFor(() => expect(consult).toHaveBeenCalledOnce())

    expect(() =>
      ledger.retireDecisionClass(
        point.decisionClass,
        () => 'caption-figure-1',
        'racing-rule-v1',
      ),
    ).toThrow('DISTILLATION_PENDING_CONSULTATION')
    release()
    expect((await pending).status).toBe('consulted')
  })

  it('fails closed when a distilled rule throws on a future decision', async () => {
    const ledger = new ModelFallbackLedger()
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    ledger.distillation.registerFixture(point)
    ledger.retireDecisionClass(
      point.decisionClass,
      (candidate) => {
        if (candidate.decisionId !== point.decisionId)
          throw new Error('fixture did not cover this input')
        return 'caption-figure-1'
      },
      'throwing-caption-rule-v1',
    )
    const gate = new ModelConsultationGate({ ledger })

    const result = await gate.decide({
      ...point,
      decisionId: 'caption-future',
    })

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('DISTILLATION_RULE_ERROR')
    expect(ledger.distillation.entry(point.decisionClass)).toMatchObject({
      retired: false,
      fixtureCount: 2,
      consultationCount: 2,
    })
  })

  it('does not let a distillation rule mutate a fixture before verification', () => {
    const ledger = new ModelFallbackLedger()
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    ledger.distillation.registerFixture(point)

    expect(() =>
      ledger.retireDecisionClass(
        point.decisionClass,
        (fixturePoint) => {
          ;(fixturePoint.candidates as ModelFallbackCandidate[]).push({
            id: 'invented-by-rule',
          })
          return 'invented-by-rule'
        },
        'mutating-caption-rule-v1',
      ),
    ).toThrow('DISTILLATION_RULE_DOES_NOT_RESOLVE_FIXTURE')
    expect(ledger.distillation.entry(point.decisionClass)).toMatchObject({
      retired: false,
      consultationCount: 1,
    })
  })

  it('exposes only fixture-committed evidence to a distillation rule', () => {
    const ledger = new ModelFallbackLedger()
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    ledger.distillation.registerFixture({ ...point, reason: 'covered' })

    expect(() =>
      ledger.retireDecisionClass(
        point.decisionClass,
        (fixturePoint) =>
          fixturePoint.reason === 'covered' ? 'caption-figure-1' : null,
        'reason-dependent-rule-v1',
      ),
    ).toThrow('DISTILLATION_RULE_DOES_NOT_RESOLVE_FIXTURE')
    expect(ledger.distillation.entry(point.decisionClass)).toMatchObject({
      retired: false,
      consultationCount: 1,
    })
  })

  it('rejects noncanonical distillation evidence before hashing a fixture', () => {
    const ledger = new ModelFallbackLedger()
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!

    expect(() =>
      ledger.distillation.registerFixture({
        ...point,
        inputs: { flag: undefined } as never,
      }),
    ).toThrow('INVALID_DISTILLATION_FIXTURE')
    expect(ledger.distillation.fixturesFor()).toEqual([])
  })

  it('requires an explicit versioned identifier for every distilled rule', () => {
    const ledger = new ModelFallbackLedger()
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    ledger.distillation.registerFixture(point)

    expect(() =>
      ledger.retireDecisionClass(
        point.decisionClass,
        () => 'caption-figure-1',
        undefined as never,
      ),
    ).toThrow('DISTILLATION_RULE_ID_REQUIRED')
  })

  it('applies a retired rule to fixtures registered later', () => {
    const ledger = new ModelFallbackLedger()
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    ledger.distillation.registerFixture(point)
    ledger.retireDecisionClass(
      point.decisionClass,
      () => 'caption-figure-1',
      'caption-rule-v1',
    )

    const fixture = ledger.distillation.registerFixture({
      ...point,
      decisionId: 'caption-after-retirement',
    })

    expect(fixture).toMatchObject({
      resolution: 'deterministic-decided',
      deterministicRuleId: 'caption-rule-v1',
      modelPath: { choice: { candidateId: 'caption-figure-1' } },
    })
    expect(ledger.distillation.consultationCount(point.decisionClass)).toBe(0)
    expect(ledger.distillation.entry(point.decisionClass)).toMatchObject({
      retired: true,
      consultationCount: 0,
    })
  })

  it('reopens a retired class when a later fixture is not covered', () => {
    const ledger = new ModelFallbackLedger()
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    ledger.distillation.registerFixture(point)
    ledger.retireDecisionClass(
      point.decisionClass,
      (candidate) =>
        candidate.decisionId === point.decisionId ? 'caption-figure-1' : null,
      'narrow-caption-rule-v1',
    )

    const fixture = ledger.distillation.registerFixture({
      ...point,
      decisionId: 'caption-not-covered',
    })

    expect(fixture.resolution).toBe('model-consulted')
    const entry = ledger.distillation.entry(point.decisionClass)
    expect(entry).toMatchObject({
      retired: false,
      fixtureCount: 2,
      consultationCount: 2,
    })
    expect(
      entry.fixtures.every(
        (candidate) =>
          candidate.resolution === 'model-consulted' &&
          candidate.deterministicRuleId === undefined,
      ),
    ).toBe(true)
  })

  it('does not apply the reference rule to contradictory association aliases', async () => {
    const ledger = createReferenceDistillationLedger()
    const gate = new ModelConsultationGate({ distillation: ledger })
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!

    const result = await gate.decide({
      ...point,
      decisionId: 'caption-contradictory-aliases',
      candidates: point.candidates.map((candidate) =>
        candidate.id === 'caption-figure-1'
          ? {
              ...candidate,
              association: { id: 'figure-2' },
            }
          : candidate,
      ),
    })

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('INVALID_MODEL_CANDIDATE_SET')
    expect(ledger.entry(point.decisionClass).retired).toBe(true)
  })

  it('reopens a distilled class for contradictory aliases on an unselected candidate', async () => {
    const ledger = createReferenceDistillationLedger()
    const gate = new ModelConsultationGate({ distillation: ledger })
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!

    const result = await gate.decide({
      ...point,
      decisionId: 'caption-unselected-contradictory-aliases',
      candidates: point.candidates.map((candidate) =>
        candidate.id === 'caption-figure-2'
          ? {
              ...candidate,
              association: { id: 'figure-3' },
            }
          : candidate,
      ),
    })

    expect(result.status).toBe('review-required')
    expect(result.diagnostic).toBe('INVALID_MODEL_CANDIDATE_SET')
    expect(ledger.entry(point.decisionClass).retired).toBe(true)
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
    expect(
      ledger.entry(MODEL_FALLBACK_DECISION_CLASSES.captionAssociation),
    ).toMatchObject({
      retired: true,
      deterministicRuleId: 'caption-association-by-figure-id-v1',
      consultationCount: 0,
    })
  })
})

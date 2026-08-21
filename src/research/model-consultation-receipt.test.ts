import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it, vi } from 'vitest'
import { sha256HexSync } from './sha256-sync'
import {
  MODEL_FALLBACK_DECISION_CLASSES,
  MODEL_FALLBACK_REFERENCE_FIXTURES,
  ModelFallbackLedger,
  ModelConsultationGate,
  attachModelConsultationReceipt,
  serializeModelConsultationReceipt,
  validateModelConsultationReceipt,
} from './model-fallback'
import { validReceiptMetric } from './model-fallback-receipt'
import { validateModelConsultationReceipt as validateGenericReceipt } from '@erniesg/struct'
import * as Struct from '@erniesg/struct'

const schema = JSON.parse(
  readFileSync(
    new URL(
      '../../docs/schemas/model-consultation-receipt.schema.json',
      import.meta.url,
    ),
    'utf8',
  ),
)
const validateSchema = new Ajv2020({ strict: false }).compile(schema)
const credentialShapedIds = [
  ['openai-legacy', ['sk', 'FAKEFAKEFAKEFAKEFAKEFAKE'].join('-')],
  ['openai', ['sk', 'proj', 'FAKEFAKEFAKEFAKEFAKEFAKE'].join('-')],
  ['openai-uppercase', ['SK', 'FAKEFAKEFAKEFAKEFAKEFAKE'].join('-')],
  ['slack-uppercase', ['XOXB', 'FAKEFAKEFAKEFAKE'].join('-')],
  ['github-classic', ['ghp', 'FAKEFAKEFAKEFAKEFAKEFAKE'].join('_')],
  ['github-oauth', ['gho', 'FAKEFAKEFAKEFAKEFAKEFAKE'].join('_')],
  ['github-user', ['ghu', 'FAKEFAKEFAKEFAKEFAKEFAKE'].join('_')],
  ['github-app', ['ghs', 'FAKEFAKEFAKEFAKEFAKEFAKE'].join('_')],
  ['github-refresh', ['ghr', 'FAKEFAKEFAKEFAKEFAKEFAKE'].join('_')],
  [
    'github-fine-grained',
    ['github', 'pat', 'FAKEFAKEFAKE', 'FAKEFAKEFAKE'].join('_'),
  ],
  ['aws', ['AKIA', 'IOSFODNN7EXAMPLE'].join('')],
  ['bearer', ['Bearer', 'FAKEFAKEFAKEFAKE'].join(':')],
  [
    'jwt',
    ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJmYWtlIn0', 'ZmFrZXNpZ25hdHVyZQ'].join(
      '.',
    ),
  ],
  ['private-key', ['BEGIN', 'PRIVATE', 'KEY', 'FAKEFAKE'].join('-')],
  [
    'private-key-lowercase-algorithm',
    ['begin', 'rsa', 'private', 'key', 'fakefake'].join('-'),
  ],
] as const

// Ids that only share a credential prefix. The runtime patterns anchor the
// credential body to the end of the value, so these stay valid document ids;
// the schema must not reject what the runtime accepts.
const credentialPrefixedSafeIds = [
  [
    'aws-prefixed-document',
    [['AKIA', 'IOSFODNN7EXAMPLE'].join(''), 'page-1'].join('-'),
  ],
  [
    'jwt-prefixed-document',
    [
      [
        'eyJhbGciOiJIUzI1NiJ9',
        'eyJzdWIiOiJmYWtlIn0',
        'ZmFrZXNpZ25hdHVyZQ',
      ].join('.'),
      'page-1',
    ].join(':'),
  ],
] as const

async function validReceipt(associationObject = false) {
  const ledger = new ModelFallbackLedger()
  const gate = new ModelConsultationGate({
    enabled: true,
    ownerOptIn: true,
    ledger,
    model: {
      identity: {
        providerId: 'recorded-stub',
        modelId: 'candidate-picker',
        modelVersion: '1.0.0',
        modelDigest: 'd'.repeat(64),
      },
      consult: () => ({
        candidateId: 'caption-figure-1',
        associationId: 'figure-1',
        costUsd: 0.01,
        latencyMs: 12,
      }),
    },
  })
  const reference = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
  const point = associationObject
    ? {
        ...reference,
        candidates: reference.candidates.map((candidate) =>
          candidate.id === 'caption-figure-1'
            ? { id: candidate.id, association: { id: 'figure-1' } }
            : candidate,
        ),
      }
    : reference
  const result = await gate.decide(point)
  if (result.status !== 'consulted')
    throw new Error('fixture consultation failed')
  return ledger.receiptFor(point.documentId)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: unknown) {
  return sha256HexSync(stableJson(value))
}

function recommitConsultation(
  consultation: Awaited<
    ReturnType<typeof validReceipt>
  >['consultations'][number],
) {
  const prompt = {
    schemaVersion: consultation.schemaVersion,
    documentId: consultation.documentId,
    decisionId: consultation.decisionId,
    decisionClass: consultation.decisionClass,
    sourceSha256: consultation.sourceSha256,
    inputs: consultation.inputs,
    candidates: consultation.candidates,
    promptTemplateSha256: consultation.promptTemplateSha256,
  }
  consultation.inputsHash = hash(consultation.inputs)
  consultation.promptHash = hash(prompt)
  consultation.requestId = hash({
    sourceSha256: consultation.sourceSha256,
    model: consultation.model,
    promptHash: consultation.promptHash,
    decisionClass: consultation.decisionClass,
    decisionId: consultation.decisionId,
  })
  consultation.fixtureId = `fixture-${hash({
    documentId: consultation.documentId,
    decisionId: consultation.decisionId,
    decisionClass: consultation.decisionClass,
    sourceSha256: consultation.sourceSha256,
    inputs: consultation.inputs,
    candidates: consultation.candidates,
  }).slice(0, 24)}`
}

describe('model consultation receipt validation', () => {
  it('compiles the receipt schema in strict mode', () => {
    expect(() => new Ajv2020({ strict: true }).compile(schema)).not.toThrow()
  })

  it('accepts one internally consistent closed receipt', async () => {
    const receipt = await validReceipt()

    expect(receipt.consultations[0]).toHaveProperty(
      'promptTemplateSha256',
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    )
    expect(validateSchema(receipt), JSON.stringify(validateSchema.errors)).toBe(
      true,
    )
    expect(validateModelConsultationReceipt(receipt)).toBe(true)
  })

  it('propagates Struct receipt rejection before app policy acceptance', async () => {
    const receipt = await validReceipt()
    expect(validateGenericReceipt(receipt)).toBe(true)
    expect(validateModelConsultationReceipt(receipt)).toBe(true)

    const genericValidator = vi
      .spyOn(Struct, 'validateModelConsultationReceipt')
      .mockReturnValue(false)
    try {
      expect(validateModelConsultationReceipt(receipt)).toBe(false)
      expect(genericValidator).toHaveBeenCalledOnce()
      expect(genericValidator).toHaveBeenCalledWith(receipt)
    } finally {
      genericValidator.mockRestore()
    }
  })

  it('short-circuits app policy inspection when Struct rejects first', async () => {
    const receipt = await validReceipt()
    expect(validateModelConsultationReceipt(receipt)).toBe(true)

    const consultations = receipt.consultations
    const consultationsDescriptor = Object.getOwnPropertyDescriptor(
      receipt,
      'consultations',
    )
    if (!consultationsDescriptor)
      throw new Error('receipt consultations descriptor missing')

    let consultationReads = 0
    let result: boolean | undefined
    let readsBeforeAssertions = -1
    let packageCallCount = -1
    let delegatedReceipt: unknown
    const genericValidator = vi
      .spyOn(Struct, 'validateModelConsultationReceipt')
      .mockReturnValue(false)
    try {
      Object.defineProperty(receipt, 'consultations', {
        configurable: true,
        enumerable: true,
        get() {
          consultationReads += 1
          return consultations
        },
      })
      result = validateModelConsultationReceipt(receipt)
      readsBeforeAssertions = consultationReads
      packageCallCount = genericValidator.mock.calls.length
      delegatedReceipt = genericValidator.mock.calls[0]?.[0]
    } finally {
      Object.defineProperty(receipt, 'consultations', consultationsDescriptor)
      genericValidator.mockRestore()
    }

    expect(result).toBe(false)
    expect(readsBeforeAssertions).toBe(0)
    expect(packageCallCount).toBe(1)
    expect(delegatedReceipt).toBe(receipt)
  })

  it('accepts receipts produced for bounded custom deterministic classes', async () => {
    const ledger = new ModelFallbackLedger()
    const gate = new ModelConsultationGate({ ledger })
    const point = {
      documentId: 'custom-decision-document',
      decisionId: 'custom-layout-choice-1',
      decisionClass: 'custom-layout-choice',
      sourceSha256: 'a'.repeat(64),
      inputs: { reason: 'deterministic-fixture' },
      candidates: [{ id: 'candidate-a' }, { id: 'candidate-b' }],
      status: 'deterministic' as const,
      deterministicChoice: { candidateId: 'candidate-a' },
    }

    await expect(gate.decide(point)).resolves.toMatchObject({
      status: 'deterministic',
      decisionClass: point.decisionClass,
    })
    const receipt = ledger.receiptFor(point.documentId)

    expect(validateModelConsultationReceipt(receipt)).toBe(true)
    expect(validateSchema(receipt), JSON.stringify(validateSchema.errors)).toBe(
      true,
    )
  })

  it('keeps PDF decision-class policy at the app-owned validator seam', async () => {
    const receipt = await validReceipt()
    const consultation = receipt.consultations[0]!
    const priorClass = consultation.decisionClass
    const policyClass = MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie
    consultation.decisionClass = policyClass
    receipt.decisions[0]!.decisionClass = policyClass
    const metric = receipt.metrics.byDecisionClass[priorClass]!
    delete receipt.metrics.byDecisionClass[priorClass]
    receipt.metrics.byDecisionClass[policyClass] = metric
    recommitConsultation(consultation)

    expect(validateGenericReceipt(receipt)).toBe(true)
    expect(validateModelConsultationReceipt(receipt)).toBe(false)
  })

  it.each(credentialShapedIds)(
    'rejects %s credential-shaped scalar values in an otherwise recommitted receipt',
    async (_name, value) => {
      const receipt = await validReceipt()
      const consultation = receipt.consultations[0]!
      consultation.model.providerId = value
      recommitConsultation(consultation)

      expect(validateSchema(receipt)).toBe(false)
      expect(validateModelConsultationReceipt(receipt)).toBe(false)
    },
  )

  it.each([
    [
      'credential-shaped input scalar',
      { reason: ['sk', 'proj', 'FAKEFAKEFAKEFAKE'].join('-') },
    ],
    ['normalized content key', { Text: 'source content' }],
    ['normalized source-text key', { sourcetext: 'source content' }],
    ['normalized token key', { accessToken: 'value' }],
  ])(
    'rejects %s in both generic and app receipt validators',
    async (_name, inputs) => {
      const receipt = await validReceipt()
      const consultation = receipt.consultations[0]!
      consultation.inputs = inputs
      recommitConsultation(consultation)

      expect(validateGenericReceipt(receipt)).toBe(false)
      expect(validateModelConsultationReceipt(receipt)).toBe(false)
    },
  )

  it('rejects a credential-shaped document id in an otherwise recommitted receipt', async () => {
    const receipt = await validReceipt()
    const value = credentialShapedIds[2][1]
    receipt.documentId = value
    receipt.consultations[0]!.documentId = value
    receipt.decisions[0]!.documentId = value
    recommitConsultation(receipt.consultations[0]!)

    expect(validateSchema(receipt)).toBe(false)
    expect(validateModelConsultationReceipt(receipt)).toBe(false)
  })

  it.each(credentialPrefixedSafeIds)(
    'keeps the schema and runtime agreed on %s document ids',
    async (_name, value) => {
      const receipt = await validReceipt()
      receipt.documentId = value
      receipt.consultations[0]!.documentId = value
      receipt.decisions[0]!.documentId = value
      recommitConsultation(receipt.consultations[0]!)

      expect(
        validateSchema(receipt),
        JSON.stringify(validateSchema.errors),
      ).toBe(true)
      expect(validateModelConsultationReceipt(receipt)).toBe(true)
    },
  )

  it('accepts the association object already normalized by the proposal gate', async () => {
    const receipt = await validReceipt(true)

    expect(validateSchema(receipt), JSON.stringify(validateSchema.errors)).toBe(
      true,
    )
    expect(validateModelConsultationReceipt(receipt)).toBe(true)
  })

  it('allows only the bounded marker ordinal used by reference notes', async () => {
    const ledger = new ModelFallbackLedger()
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[1]!
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      ledger,
      model: {
        identity: {
          providerId: 'recorded-stub',
          modelId: 'candidate-picker',
          modelVersion: '1.0.0',
          modelDigest: 'd'.repeat(64),
        },
        consult: () => ({ candidateId: 'note-body-1' }),
      },
    })
    expect((await gate.decide(point)).status).toBe('consulted')
    const receipt = ledger.receiptFor(point.documentId)

    expect(validateSchema(receipt), JSON.stringify(validateSchema.errors)).toBe(
      true,
    )
    expect(validateModelConsultationReceipt(receipt)).toBe(true)
    expect(receipt.consultations[0]!.inputs).toEqual({
      markerId: 'marker-1',
      markerOrdinal: '1',
    })
  })

  it.each([
    ['input evidence', 'inputs', 'evidence'],
    ['candidate payload', 'candidate', 'payload'],
    ['candidate metadata', 'candidate', 'metadata'],
    ['candidate value', 'candidate', 'value'],
  ])(
    'rejects private data recomitted under an innocuous %s key',
    async (_name, location, field) => {
      const receipt = await validReceipt()
      const consultation = receipt.consultations[0]!
      if (location === 'inputs')
        consultation.inputs = { [field]: 'PRIVATE_SOURCE_SENTINEL' }
      else
        Object.assign(consultation.candidates[0]!, {
          [field]: 'PRIVATE_SOURCE_SENTINEL',
        })
      recommitConsultation(consultation)

      expect(validateSchema(receipt)).toBe(false)
      expect(validateModelConsultationReceipt(receipt)).toBe(false)
    },
  )

  it.each([
    {
      name: 'raw source input',
      mutate: (
        consultation: Awaited<
          ReturnType<typeof validReceipt>
        >['consultations'][number],
      ) => {
        consultation.inputs = {
          nested: { source_text: 'must-not-persist' },
        }
      },
    },
    {
      name: 'credential candidate metadata',
      mutate: (
        consultation: Awaited<
          ReturnType<typeof validReceipt>
        >['consultations'][number],
      ) => {
        Object.assign(consultation.candidates[0]!, {
          apiKey: 'must-not-persist',
        })
      },
    },
    {
      name: 'composite credential candidate metadata',
      mutate: (
        consultation: Awaited<
          ReturnType<typeof validReceipt>
        >['consultations'][number],
      ) => {
        Object.assign(consultation.candidates[0]!, {
          refreshToken: 'must-not-persist',
        })
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
      mutate: (
        consultation: Awaited<
          ReturnType<typeof validReceipt>
        >['consultations'][number],
      ) => {
        Object.assign(consultation.candidates[0]!, {
          [field!]: 'must-not-persist',
        })
      },
    })),
  ])(
    'rejects $name even when commitments are recomputed',
    async ({ mutate }) => {
      const receipt = await validReceipt()
      mutate(receipt.consultations[0]!)
      recommitConsultation(receipt.consultations[0]!)

      expect(validateSchema(receipt)).toBe(false)
      expect(validateModelConsultationReceipt(receipt)).toBe(false)
    },
  )

  it.each([
    {
      name: 'unknown consultation field',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        Object.assign(receipt.consultations[0]!, { unrecognized: true })
      },
    },
    {
      name: 'candidate without an id',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        receipt.consultations[0]!.candidates = [{} as never]
      },
    },
    {
      name: 'malformed model identity',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        receipt.consultations[0]!.model = {
          providerId: 7,
          modelId: null,
          modelVersion: {},
          modelDigest: 'not-a-digest',
        } as never
      },
    },
    {
      name: 'accepted consultation without a choice',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        receipt.consultations[0]!.choice = null as never
      },
    },
    {
      name: 'consultation without its prompt-template digest',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        delete (
          receipt.consultations[0]! as {
            promptTemplateSha256?: string
          }
        ).promptTemplateSha256
      },
    },
    {
      name: 'malformed prompt-template digest',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        receipt.consultations[0]!.promptTemplateSha256 = 'not-a-sha256'
      },
    },
    {
      name: 'model-authored choice label',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        Object.assign(receipt.consultations[0]!.choice!, {
          label: 'must-not-persist',
        })
      },
    },
    {
      name: 'consultation without its generated fixture link',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        delete (receipt.consultations[0]! as { fixtureId?: string }).fixtureId
      },
    },
  ])('rejects $name in both validators', async ({ mutate }) => {
    const receipt = await validReceipt()
    mutate(receipt)

    expect(validateSchema(receipt)).toBe(false)
    expect(validateModelConsultationReceipt(receipt)).toBe(false)
  })

  it.each([
    {
      name: 'choice outside the candidate set',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        receipt.consultations[0]!.choice!.candidateId = 'order-b-a'
      },
    },
    {
      name: 'candidate id list that differs from candidates',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        receipt.consultations[0]!.candidateIds = ['order-b-a']
      },
    },
    {
      name: 'aggregate metric count that differs from class metrics',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        receipt.metrics.totalConsultationCount = 0
      },
    },
    {
      name: 'class consultation rate that differs from its counts',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        Object.values(receipt.metrics.byDecisionClass)[0]!.consultationRate = 0
      },
    },
    {
      name: 'tampered recorded inputs',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        receipt.consultations[0]!.inputs = { tampered: true }
      },
    },
    {
      name: 'tampered prompt commitment',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        receipt.consultations[0]!.promptHash = 'f'.repeat(64)
      },
    },
    {
      name: 'tampered prompt-template commitment',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        receipt.consultations[0]!.promptTemplateSha256 = 'f'.repeat(64)
      },
    },
    {
      name: 'tampered request commitment',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        receipt.consultations[0]!.requestId = 'f'.repeat(64)
      },
    },
    {
      name: 'consulted decision without its provenance record',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        receipt.consultations = []
      },
    },
    {
      name: 'consultation metrics below actual provider calls',
      mutate: (receipt: Awaited<ReturnType<typeof validReceipt>>) => {
        receipt.metrics.totalConsultationCount = 0
        receipt.metrics.consultationRate = 0
        const metric = Object.values(receipt.metrics.byDecisionClass)[0]!
        metric.consultationCount = 0
        metric.consultationRate = 0
      },
    },
  ])('rejects $name at runtime', async ({ mutate }) => {
    const receipt = await validReceipt()
    mutate(receipt)

    expect(validateModelConsultationReceipt(receipt)).toBe(false)
  })

  it('refuses to serialize or attach an invalid receipt', async () => {
    const receipt = await validReceipt()
    receipt.consultations[0]!.inputs = { tampered: true }

    expect(() => serializeModelConsultationReceipt(receipt)).toThrow(
      'INVALID_MODEL_CONSULTATION_RECEIPT',
    )
    expect(() =>
      attachModelConsultationReceipt(
        { artifact: 'epub' },
        { receiptFor: () => receipt } as never,
        receipt.documentId,
      ),
    ).toThrow('INVALID_MODEL_CONSULTATION_RECEIPT')
  })

  it('enforces the published receipt history and metric limits at runtime', async () => {
    const ledger = new ModelFallbackLedger()
    const point = MODEL_FALLBACK_REFERENCE_FIXTURES[0]!
    await new ModelConsultationGate({ ledger }).decide(point)
    const receipt = ledger.receiptFor(point.documentId)
    const overLimit = 100_001
    receipt.decisions = new Array(overLimit).fill(receipt.decisions[0]!)
    receipt.metrics.totalDecisionCount = overLimit
    const metric = Object.values(receipt.metrics.byDecisionClass)[0]!
    metric.decisionCount = overLimit

    expect(validateSchema(receipt)).toBe(false)
    expect(validateModelConsultationReceipt(receipt)).toBe(false)
    expect(
      validReceiptMetric({
        decisionCount: overLimit,
        consultationCount: overLimit,
        consultationRate: 1,
      }),
    ).toBe(false)
  })

  it('rejects divergent accepted choices for one stable request id', async () => {
    const receipt = await validReceipt()
    const duplicate = structuredClone(receipt.consultations[0]!)
    duplicate.choice = {
      candidateId: 'caption-figure-2',
      associationId: 'figure-2',
    }
    receipt.consultations.push(duplicate)
    receipt.decisions.push(structuredClone(receipt.decisions[0]!))
    receipt.metrics.totalDecisionCount = 2
    receipt.metrics.totalConsultationCount = 2
    const classMetric = Object.values(receipt.metrics.byDecisionClass)[0]!
    classMetric.decisionCount = 2
    classMetric.consultationCount = 2

    expect(validateSchema(receipt), JSON.stringify(validateSchema.errors)).toBe(
      true,
    )
    expect(validateModelConsultationReceipt(receipt)).toBe(false)
  })

  it('rejects consistently recommitted contradictory candidate aliases', async () => {
    const receipt = await validReceipt()
    const consultation = receipt.consultations[0]!
    Object.assign(consultation.candidates[0]!, {
      associationId: 'figure-1',
      association: { id: 'figure-2' },
    })
    recommitConsultation(consultation)

    expect(validateSchema(receipt)).toBe(false)
    expect(validateModelConsultationReceipt(receipt)).toBe(false)
    expect(() => serializeModelConsultationReceipt(receipt)).toThrow(
      'INVALID_MODEL_CONSULTATION_RECEIPT',
    )
  })

  it.each(['consultations', 'decisions'] as const)(
    'rejects a sparse %s array without throwing',
    async (field) => {
      const receipt = await validReceipt()
      const source = receipt[field]
      const sparse = new Array(source.length + 1)
      sparse[1] = source[0]
      receipt[field] = sparse as never

      expect(() => validateModelConsultationReceipt(receipt)).not.toThrow()
      expect(validateModelConsultationReceipt(receipt)).toBe(false)
      expect(() => serializeModelConsultationReceipt(receipt)).toThrow(
        'INVALID_MODEL_CONSULTATION_RECEIPT',
      )
    },
  )

  it('rejects accessor-backed and hidden receipt state before serialization', async () => {
    const receipts = [await validReceipt(), await validReceipt()]
    Object.defineProperty(
      receipts[0]!.consultations[0]!.choice!,
      'candidateId',
      {
        enumerable: true,
        get() {
          return 'caption-figure-1'
        },
      },
    )
    Object.defineProperty(receipts[1]!.consultations[0]!, 'hidden', {
      value: true,
    })

    for (const receipt of receipts) {
      expect(() => validateModelConsultationReceipt(receipt)).not.toThrow()
      expect(validateModelConsultationReceipt(receipt)).toBe(false)
      expect(() => serializeModelConsultationReceipt(receipt)).toThrow(
        'INVALID_MODEL_CONSULTATION_RECEIPT',
      )
    }
  })
})

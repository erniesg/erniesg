import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { sha256HexSync } from './sha256-sync'
import {
  MODEL_FALLBACK_REFERENCE_FIXTURES,
  ModelFallbackLedger,
  ModelConsultationGate,
  attachModelConsultationReceipt,
  serializeModelConsultationReceipt,
  validateModelConsultationReceipt,
} from './model-fallback'

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

async function validReceipt(associationObject = false) {
  const ledger = new ModelFallbackLedger()
  const gate = new ModelConsultationGate({
    enabled: true,
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

    expect(validateSchema(receipt), JSON.stringify(validateSchema.errors)).toBe(
      true,
    )
    expect(validateModelConsultationReceipt(receipt)).toBe(true)
  })

  it('accepts the association object already normalized by the proposal gate', async () => {
    const receipt = await validReceipt(true)

    expect(validateSchema(receipt), JSON.stringify(validateSchema.errors)).toBe(
      true,
    )
    expect(validateModelConsultationReceipt(receipt)).toBe(true)
  })

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

    expect(validateSchema(receipt), JSON.stringify(validateSchema.errors)).toBe(
      true,
    )
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

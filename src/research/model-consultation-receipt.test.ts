import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { validateModelConsultationReceipt } from './model-fallback'

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

function validReceipt() {
  return {
    schemaVersion: '1.0.0',
    documentId: 'document-1',
    sourceSha256: 'a'.repeat(64),
    consultations: [
      {
        schemaVersion: '1.0.0',
        requestId: 'b'.repeat(64),
        fixtureId: 'fixture-1',
        documentId: 'document-1',
        decisionId: 'decision-1',
        decisionClass: 'reading-order-tie',
        sourceSha256: 'a'.repeat(64),
        inputs: { regionIds: ['region-a', 'region-b'] },
        inputsHash: 'c'.repeat(64),
        candidates: [
          {
            id: 'order-a-b',
            associationId: 'association-a-b',
            order: 0,
            label: 'A then B',
          },
        ],
        candidateIds: ['order-a-b'],
        model: {
          providerId: 'recorded-stub',
          modelId: 'candidate-picker',
          modelVersion: '1.0.0',
          modelDigest: 'd'.repeat(64),
        },
        promptHash: 'e'.repeat(64),
        status: 'accepted',
        choice: {
          candidateId: 'order-a-b',
          associationId: 'association-a-b',
          order: 0,
          label: 'A then B',
        },
        costUsd: 0.01,
        latencyMs: 12,
      },
    ],
    decisions: [
      {
        documentId: 'document-1',
        decisionId: 'decision-1',
        decisionClass: 'reading-order-tie',
        outcome: 'consulted',
        consulted: true,
      },
    ],
    metrics: {
      totalDecisionCount: 1,
      totalConsultationCount: 1,
      consultationRate: 1,
      byDecisionClass: {
        'reading-order-tie': {
          decisionCount: 1,
          consultationCount: 1,
          consultationRate: 1,
        },
      },
    },
  }
}

describe('model consultation receipt validation', () => {
  it('compiles the receipt schema in strict mode', () => {
    expect(() => new Ajv2020({ strict: true }).compile(schema)).not.toThrow()
  })

  it('accepts one internally consistent closed receipt', () => {
    const receipt = validReceipt()

    expect(
      validateSchema(receipt),
      JSON.stringify(validateSchema.errors),
    ).toBe(true)
    expect(validateModelConsultationReceipt(receipt)).toBe(true)
  })

  it('accepts the association object already normalized by the proposal gate', () => {
    const receipt = validReceipt()
    const candidate = receipt.consultations[0]!.candidates[0]! as Record<
      string,
      unknown
    >
    delete candidate.associationId
    candidate.association = { id: 'association-a-b' }

    expect(
      validateSchema(receipt),
      JSON.stringify(validateSchema.errors),
    ).toBe(true)
    expect(validateModelConsultationReceipt(receipt)).toBe(true)
  })

  it.each([
    {
      name: 'unknown consultation field',
      mutate: (receipt: ReturnType<typeof validReceipt>) => {
        Object.assign(receipt.consultations[0]!, { unrecognized: true })
      },
    },
    {
      name: 'candidate without an id',
      mutate: (receipt: ReturnType<typeof validReceipt>) => {
        receipt.consultations[0]!.candidates = [{} as never]
      },
    },
    {
      name: 'malformed model identity',
      mutate: (receipt: ReturnType<typeof validReceipt>) => {
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
      mutate: (receipt: ReturnType<typeof validReceipt>) => {
        receipt.consultations[0]!.choice = null as never
      },
    },
  ])('rejects $name in both validators', ({ mutate }) => {
    const receipt = validReceipt()
    mutate(receipt)

    expect(validateSchema(receipt)).toBe(false)
    expect(validateModelConsultationReceipt(receipt)).toBe(false)
  })

  it.each([
    {
      name: 'choice outside the candidate set',
      mutate: (receipt: ReturnType<typeof validReceipt>) => {
        receipt.consultations[0]!.choice.candidateId = 'order-b-a'
      },
    },
    {
      name: 'candidate id list that differs from candidates',
      mutate: (receipt: ReturnType<typeof validReceipt>) => {
        receipt.consultations[0]!.candidateIds = ['order-b-a']
      },
    },
    {
      name: 'aggregate metric count that differs from class metrics',
      mutate: (receipt: ReturnType<typeof validReceipt>) => {
        receipt.metrics.totalConsultationCount = 0
      },
    },
    {
      name: 'class consultation rate that differs from its counts',
      mutate: (receipt: ReturnType<typeof validReceipt>) => {
        receipt.metrics.byDecisionClass[
          'reading-order-tie'
        ]!.consultationRate = 0
      },
    },
  ])('rejects $name at runtime', ({ mutate }) => {
    const receipt = validReceipt()
    mutate(receipt)

    expect(validateModelConsultationReceipt(receipt)).toBe(false)
  })
})

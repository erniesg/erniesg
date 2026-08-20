import { describe, expect, it } from 'vitest'
import {
  buildStructEpub,
  decodeStructDocument,
  encodeStructDocument,
  structDigest,
  type ModelFallbackReceipt,
  validateModelConsultationReceipt,
} from '../src/index'
import { hash } from '../src/model-consultation-receipt'
import { characterizationDocument } from './characterization-fixtures'

function sealedDocument() {
  const document = characterizationDocument('0.2.0') as any
  document.receipt.modelConsultations = acceptedReceipt(
    document.documentId,
    document.source.sha256,
  )
  const { receipt, ...withoutReceipt } = document
  receipt.generatedSha256 = structDigest({
    ...withoutReceipt,
    conservation: receipt.conservation,
    modelConsultations: receipt.modelConsultations,
    assets: document.assets.map(({ bytes: _bytes, ...asset }: any) => asset),
  })
  return document
}

function pendingReceipt(
  documentId: string,
  sourceSha256: string,
): ModelFallbackReceipt {
  const decisionClass = 'generic-decision'
  const inputs = { reason: 'pending-fixture' }
  const candidates = [{ id: 'candidate-a' }]
  const promptTemplateSha256 = 'b'.repeat(64)
  const promptHash = hash({
    schemaVersion: '1.0.0',
    documentId,
    decisionId: 'decision-1',
    decisionClass,
    sourceSha256,
    inputs,
    candidates,
    promptTemplateSha256,
  })
  const model = {
    providerId: 'provider',
    modelId: 'model',
    modelVersion: '1',
    modelDigest: 'c'.repeat(64),
  }
  const consultation = {
    schemaVersion: '1.0.0' as const,
    requestId: hash({
      sourceSha256,
      model,
      promptHash,
      decisionClass,
      decisionId: 'decision-1',
    }),
    fixtureId: `fixture-${hash({
      documentId,
      decisionId: 'decision-1',
      decisionClass,
      sourceSha256,
      inputs,
      candidates,
    }).slice(0, 24)}`,
    documentId,
    decisionId: 'decision-1',
    decisionClass,
    sourceSha256,
    inputs,
    inputsHash: hash(inputs),
    candidates,
    candidateIds: ['candidate-a'],
    model,
    promptTemplateSha256,
    promptHash,
    status: 'pending' as const,
    choice: null,
    costUsd: 0,
    latencyMs: null,
  }
  return {
    schemaVersion: '1.0.0' as const,
    documentId,
    sourceSha256,
    consultations: [consultation],
    decisions: [
      {
        documentId,
        decisionId: 'decision-1',
        decisionClass,
        outcome: 'review-required' as const,
        consulted: false,
      },
    ],
    metrics: {
      totalDecisionCount: 1,
      totalConsultationCount: 0,
      consultationRate: 0,
      byDecisionClass: {
        [decisionClass]: {
          decisionCount: 1,
          consultationCount: 0,
          consultationRate: 0,
        },
      },
    },
  }
}

function acceptedReceipt(
  documentId: string,
  sourceSha256: string,
): ModelFallbackReceipt {
  const receipt = pendingReceipt(documentId, sourceSha256)
  const consultation = receipt.consultations[0]!
  consultation.status = 'accepted'
  consultation.choice = { candidateId: 'candidate-a' }
  receipt.decisions[0]!.outcome = 'consulted'
  receipt.decisions[0]!.consulted = true
  receipt.metrics.totalConsultationCount = 1
  receipt.metrics.consultationRate = 1
  receipt.metrics.byDecisionClass['generic-decision']!.consultationCount = 1
  receipt.metrics.byDecisionClass['generic-decision']!.consultationRate = 1
  return receipt
}

describe('generic STRUCT model consultation receipt', () => {
  it('round-trips a valid closed receipt without policy symbols', () => {
    const document = sealedDocument()
    expect(
      validateModelConsultationReceipt(document.receipt.modelConsultations),
    ).toBe(true)
    const encoded = encodeStructDocument(document)
    expect(encoded.receipt.modelConsultations).toEqual(
      document.receipt.modelConsultations,
    )
    expect(decodeStructDocument(encoded)).toEqual(document)
  })

  it('rejects pending receipts at the package publication seam', async () => {
    const document = sealedDocument()
    document.receipt.modelConsultations = pendingReceipt(
      document.documentId,
      document.source.sha256,
    )
    const { receipt, ...withoutReceipt } = document
    receipt.generatedSha256 = structDigest({
      ...withoutReceipt,
      conservation: receipt.conservation,
      modelConsultations: receipt.modelConsultations,
      assets: document.assets.map(({ bytes: _bytes, ...asset }: any) => asset),
    })
    expect(validateModelConsultationReceipt(receipt.modelConsultations)).toBe(
      true,
    )
    await expect(buildStructEpub(document)).rejects.toThrow(
      'PENDING_MODEL_CONSULTATION_RECEIPT',
    )
  })
})

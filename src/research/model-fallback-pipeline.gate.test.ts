import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtureFile } from '../../tests/fixtures/pdf-fixtures'
import type { PdfReconstruction } from './import-types'
import {
  MODEL_FALLBACK_DECISION_CLASSES,
  type ModelDecisionRequest,
  validateModelConsultationReceipt,
} from './model-fallback'
import {
  modelDecisionPointsForPdf,
  PRODUCTION_PDF_MODEL_FALLBACK_OPTIONS,
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

describe('PDF model fallback production adapter gate', () => {
  let adjudicationRequired: PdfReconstruction

  beforeAll(async () => {
    adjudicationRequired = await reconstructPdf(
      await fixtureFile('adjudication-required.pdf'),
    )
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

  it('orders fallback decisions by code unit independent of locale collation', () => {
    const expected = modelDecisionPointsForPdf(adjudicationRequired).map(
      ({ decisionClass, decisionId }) => `${decisionClass}\u0000${decisionId}`,
    )
    const localeCompare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(function (this: string, other: string) {
        return this < String(other) ? 1 : this > String(other) ? -1 : 0
      })
    try {
      expect(
        modelDecisionPointsForPdf(adjudicationRequired).map(
          ({ decisionClass, decisionId }) =>
            `${decisionClass}\u0000${decisionId}`,
        ),
      ).toEqual(expected)
    } finally {
      localeCompare.mockRestore()
    }
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
})

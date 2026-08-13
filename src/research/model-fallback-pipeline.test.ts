import { readdirSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtureFile } from '../../tests/fixtures/pdf-fixtures'
import type { PdfReconstruction } from './import-types'
import {
  applyHumanDecisionFile,
  createHumanDecisionFile,
  readingOrderCandidates,
  upsertHumanDecision,
} from './decision-record'
import {
  DistillationLedger,
  MODEL_FALLBACK_DECISION_CLASSES,
  ModelConsultationGate,
  serializeModelConsultationReceipt,
  type ModelConsultationGateOptions,
  type ModelDecisionRequest,
  validateModelConsultationReceipt,
} from './model-fallback'
import {
  PDF_CAPTION_UNIQUE_BOUNDED_DISTANCE_RULE_ID,
  modelConsultationReceiptMatchesPdfReconstruction,
  modelDecisionPointsForPdf,
  pdfModelConsultationSemanticStateSha256,
  pdfModelDerivedDecisionKeys,
  PRODUCTION_PDF_MODEL_FALLBACK_OPTIONS,
  resolveCaptionAssociationByUniqueBoundedDistance,
  resolvePdfModelFallbacks,
} from './model-fallback-pipeline'
import { reconstructPdf } from './pdf'
import { buildStructDocument } from '../struct/from-reconstruction'

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

  it('keeps a reading-order ambiguity open when no alternate candidate exists', async () => {
    const singleton = structuredClone(adjudicationRequired)
    const diagnostic = singleton.diagnostics.find(
      ({ code }) => code === 'AMBIGUOUS_READING_ORDER',
    )!
    diagnostic.target!.regionIds = diagnostic.target!.regionIds.slice(0, 1)
    diagnostic.readingOrderResolution!.regionId =
      diagnostic.target!.regionIds[0]
    singleton.readingOrder.resolutions.find(
      ({ page }) => page === diagnostic.page,
    )!.regionIds = [...diagnostic.target!.regionIds]
    singleton.diagnostics = [diagnostic]
    const consult = vi.fn(() => ({ candidateId: 'not-called' }))

    const result = await resolvePdfModelFallbacks(singleton, {
      enabled: true,
      ownerOptIn: true,
      model: { identity: modelIdentity, consult },
    })

    expect(consult).not.toHaveBeenCalled()
    expect(
      modelDecisionPointsForPdf(singleton).filter(
        ({ decisionClass }) =>
          decisionClass === MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie,
      ),
    ).toHaveLength(0)
    expect(result.diagnostics).toContainEqual(diagnostic)
  })

  it('keeps non-column reading-order obligations out of model consultation', async () => {
    const nonColumn = structuredClone(adjudicationRequired)
    const diagnostic = nonColumn.diagnostics.find(
      ({ code }) => code === 'AMBIGUOUS_READING_ORDER',
    )!
    delete diagnostic.readingOrderResolution
    nonColumn.diagnostics = [diagnostic]
    const consult = vi.fn(() => ({ candidateId: 'not-called' }))

    const result = await resolvePdfModelFallbacks(nonColumn, {
      enabled: true,
      ownerOptIn: true,
      model: { identity: modelIdentity, consult },
    })

    expect(consult).not.toHaveBeenCalled()
    expect(
      modelDecisionPointsForPdf(nonColumn).filter(
        ({ decisionClass }) =>
          decisionClass === MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie,
      ),
    ).toHaveLength(0)
    expect(result.diagnostics).toContainEqual(diagnostic)
  })

  it('binds deterministic reading-order receipts to the installed candidate order', async () => {
    const [point] = modelDecisionPointsForPdf(adjudicationRequired).filter(
      ({ decisionClass }) =>
        decisionClass === MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie,
    )
    expect(point?.candidates).toHaveLength(2)
    const selected = point!.candidates[1]!
    const distillation = new DistillationLedger()
    distillation.registerFixture(point!)
    distillation.retireClass(
      point!.decisionClass,
      () => selected.id,
      'reading-order-columns-v1',
    )

    const result = await resolvePdfModelFallbacks(
      adjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )

    expect(result.modelConsultations?.decisions).toContainEqual(
      expect.objectContaining({
        decisionId: point!.decisionId,
        outcome: 'deterministic',
        choice: { candidateId: selected.id },
        deterministicRuleId: 'reading-order-columns-v1',
      }),
    )
    expect(result.diagnostics.map(({ code }) => code)).not.toContain(
      'AMBIGUOUS_READING_ORDER',
    )
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

  it.each<{
    name: string
    options: ModelConsultationGateOptions
    expectedConsultationStatus?: 'failed' | 'rejected'
    expectedFailureCode?: string
  }>([
    { name: 'disabled', options: {} },
    {
      name: 'provider unavailable before a request',
      options: { enabled: true, ownerOptIn: true },
    },
    {
      name: 'provider method unavailable',
      options: {
        enabled: true,
        ownerOptIn: true,
        model: { identity: modelIdentity },
      },
      expectedConsultationStatus: 'failed',
      expectedFailureCode: 'MODEL_PROVIDER_UNAVAILABLE',
    },
    {
      name: 'provider failure',
      options: {
        enabled: true,
        ownerOptIn: true,
        model: {
          identity: modelIdentity,
          consult: () => {
            throw new Error('provider failed')
          },
        },
      },
      expectedConsultationStatus: 'failed',
      expectedFailureCode: 'MODEL_PROVIDER_ERROR',
    },
    {
      name: 'rejected proposal',
      options: {
        enabled: true,
        ownerOptIn: true,
        model: {
          identity: modelIdentity,
          consult: () => ({ candidateId: 'invented-candidate' }),
        },
      },
      expectedConsultationStatus: 'rejected',
      expectedFailureCode: 'OUT_OF_CANDIDATE_SET',
    },
  ])('resumes unresolved decisions after $name', async (priorCase) => {
    const unresolved = await resolvePdfModelFallbacks(
      adjudicationRequired,
      priorCase.options,
    )
    const priorReceipt = structuredClone(unresolved.modelConsultations!)
    expect(withoutReceipt(unresolved)).toEqual(adjudicationRequired)
    if (priorCase.expectedConsultationStatus) {
      expect(priorReceipt.consultations).toHaveLength(3)
      expect(priorReceipt.consultations).toEqual(
        Array.from({ length: 3 }, () =>
          expect.objectContaining({
            status: priorCase.expectedConsultationStatus,
            failureCode: priorCase.expectedFailureCode,
          }),
        ),
      )
    } else {
      expect(priorReceipt.consultations).toEqual([])
    }
    unresolved.modelConsultations = JSON.parse(
      serializeModelConsultationReceipt(priorReceipt),
    )
    const consult = vi.fn((request: ModelDecisionRequest) => ({
      candidateId: request.candidates[0]!.id,
    }))

    const resumed = await resolvePdfModelFallbacks(unresolved, {
      enabled: true,
      ownerOptIn: true,
      distillation: new DistillationLedger(),
      model: { identity: modelIdentity, consult },
    })

    expect(consult).toHaveBeenCalledTimes(3)
    expect(resumed.diagnostics.map(({ code }) => code)).not.toEqual(
      expect.arrayContaining([
        'AMBIGUOUS_NOTE_MATCH',
        'AMBIGUOUS_READING_ORDER',
      ]),
    )
    expect(
      resumed.modelConsultations?.consultations.slice(
        0,
        priorReceipt.consultations.length,
      ),
    ).toEqual(priorReceipt.consultations)
    expect(resumed.modelConsultations?.consultations).toHaveLength(
      priorReceipt.consultations.length + 3,
    )
    expect(
      resumed.modelConsultations?.decisions.slice(
        0,
        priorReceipt.decisions.length,
      ),
    ).toEqual(priorReceipt.decisions)
    expect(resumed.modelConsultations?.decisions).toHaveLength(
      priorReceipt.decisions.length + 3,
    )
    expect(validateModelConsultationReceipt(resumed.modelConsultations)).toBe(
      true,
    )
  })

  it('rebinds model receipts after later human adjudication changes semantic state', async () => {
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      distillation: new DistillationLedger(),
      model: {
        identity: modelIdentity,
        consult: (request) => ({ candidateId: request.candidates[0]!.id }),
      },
    })
    const priorReceipt = structuredClone(resolved.modelConsultations!)

    const adjudicated = applyHumanDecisionFile(
      resolved,
      createHumanDecisionFile(resolved.source.sha256),
    )

    expect(adjudicated.humanAdjudications.schemaVersion).toBe('1.2.0')
    expect(adjudicated.modelConsultations?.consultations).toEqual(
      priorReceipt.consultations,
    )
    expect(modelConsultationReceiptMatchesPdfReconstruction(adjudicated)).toBe(
      true,
    )
    expect(() => buildStructDocument(adjudicated)).not.toThrow()
  })

  it('preserves review-required history after human adjudication closes the same decision', async () => {
    const unresolved = await resolvePdfModelFallbacks(adjudicationRequired, {})
    const relationship = unresolved.noteRelationships.find(
      ({ candidates }) => candidates.length > 0,
    )!
    const diagnostic = unresolved.diagnostics.find(
      ({ code, target }) =>
        code === 'AMBIGUOUS_NOTE_MATCH' && target?.markerId === relationship.id,
    )!
    const candidate = relationship.candidates[0]!
    const decisionFile = upsertHumanDecision(
      createHumanDecisionFile(unresolved.source.sha256),
      {
        diagnosticCode: 'AMBIGUOUS_NOTE_MATCH',
        target: structuredClone(diagnostic.target!),
        resolution: {
          type: 'accept-note-match',
          targetNoteId: candidate.targetNoteId,
          targetRegionId: candidate.targetRegionId,
        },
      },
    )

    const adjudicated = applyHumanDecisionFile(unresolved, decisionFile)

    expect(adjudicated.humanAdjudications.applied).toHaveLength(1)
    expect(adjudicated.modelConsultations?.decisions).toEqual(
      unresolved.modelConsultations?.decisions,
    )
    expect(modelConsultationReceiptMatchesPdfReconstruction(adjudicated)).toBe(
      true,
    )
    expect(() => buildStructDocument(adjudicated)).not.toThrow()
  })

  it('scopes receipts to the current invocation when a gate ledger is reused', async () => {
    const consult = vi.fn((request: ModelDecisionRequest) => ({
      candidateId: request.candidates[0]!.id,
    }))
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      model: { identity: modelIdentity, consult },
    })

    const first = await resolvePdfModelFallbacks(adjudicationRequired, gate)
    const second = await resolvePdfModelFallbacks(adjudicationRequired, gate)

    expect(first.modelConsultations?.decisions).toHaveLength(3)
    expect(second.modelConsultations?.decisions).toHaveLength(3)
    expect(second.modelConsultations?.consultations).toHaveLength(3)
    expect(
      gate.ledger.decisionsFor({ documentId: adjudicationRequired.paper.id }),
    ).toHaveLength(6)
    expect(consult).toHaveBeenCalledTimes(6)
  })

  it('isolates receipts for concurrent invocations that share a gate', async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const consult = vi.fn(async (request: ModelDecisionRequest) => {
      await barrier
      return { candidateId: request.candidates[0]!.id }
    })
    const gate = new ModelConsultationGate({
      enabled: true,
      ownerOptIn: true,
      model: { identity: modelIdentity, consult },
    })

    const first = resolvePdfModelFallbacks(adjudicationRequired, gate)
    const second = resolvePdfModelFallbacks(adjudicationRequired, gate)
    await vi.waitFor(() => expect(consult).toHaveBeenCalledTimes(2))
    release()
    const results = await Promise.all([first, second])

    for (const result of results) {
      expect(result.modelConsultations?.consultations).toHaveLength(3)
      expect(result.modelConsultations?.decisions).toHaveLength(3)
      expect(validateModelConsultationReceipt(result.modelConsultations)).toBe(
        true,
      )
    }
    expect(consult).toHaveBeenCalledTimes(6)
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

  it.each(
    readdirSync(new URL('../../tests/fixtures/pdf', import.meta.url))
      .filter((name) => name.endsWith('.pdf'))
      .sort(),
  )(
    'attributes nothing to the model layer in a purely deterministic %s',
    async (name) => {
      // The reverse-direction check throws when the document carries
      // model-derived state no receipt claims. Every deterministic
      // reconstruction must therefore attribute nothing: an ambiguous reading
      // order whose diagnostic was deduplicated or downgraded to
      // `SOURCE_ORDER_FLOAT_FALLBACK` would otherwise refuse a legitimate PDF.
      const reconstruction = await reconstructPdf(await fixtureFile(name))
      expect(reconstruction).not.toHaveProperty('modelConsultations')
      expect([
        ...pdfModelDerivedDecisionKeys(reconstruction as PdfReconstruction),
      ]).toEqual([])
      expect(() => buildStructDocument(reconstruction)).not.toThrow()
    },
  )

  it('preserves and binds provider measurements in the published receipt', async () => {
    const resolveWith = (latencyMs: number, costUsd: number) =>
      resolvePdfModelFallbacks(adjudicationRequired, {
        enabled: true,
        ownerOptIn: true,
        model: {
          identity: modelIdentity,
          consult: (request) => ({
            proposal: { candidateId: request.candidates[0]!.id },
            latencyMs,
            costUsd,
          }),
        },
      })

    const [fast, slow] = await Promise.all([
      resolveWith(11, 0.001),
      resolveWith(37, 0.009),
    ])

    expect(
      fast.modelConsultations!.consultations.map(
        ({ latencyMs, costUsd }) => `${latencyMs}:${costUsd}`,
      ),
    ).toEqual(fast.modelConsultations!.consultations.map(() => '11:0.001'))
    expect(
      slow.modelConsultations!.consultations.map(
        ({ latencyMs, costUsd }) => `${latencyMs}:${costUsd}`,
      ),
    ).toEqual(slow.modelConsultations!.consultations.map(() => '37:0.009'))
    expect(fast.modelConsultations!.consultations.length).toBeGreaterThan(0)
    expect(
      buildStructDocument(slow as PdfReconstruction).receipt.generatedSha256,
    ).not.toEqual(
      buildStructDocument(fast as PdfReconstruction).receipt.generatedSha256,
    )
  })

  it('attributes model work stamped only by a per-diagnostic evidence marker', async () => {
    // `materializeVisualRelationship` stamps both a bare origin and a
    // per-diagnostic `<origin>-<code>` marker. Matching the bare origin exactly
    // lets a document drop that one string and keep the marker that still
    // declares the provenance out loud. This fixture resolves through the
    // deterministic-distillation origin, so the surviving marker is
    // `deterministically-distilled-<code>`.
    const resolved = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      {
        enabled: true,
        ownerOptIn: true,
        model: {
          identity: modelIdentity,
          consult: (request) => ({ candidateId: request.candidates[0]!.id }),
        },
      },
    )
    const stripped = structuredClone(resolved)
    for (const relationship of stripped.visualRelationships) {
      relationship.evidence = relationship.evidence.filter(
        (code) =>
          code !== 'model-consultation' &&
          code !== 'deterministic-distillation',
      )
    }
    expect(
      stripped.visualRelationships.flatMap(({ evidence }) => evidence),
    ).toContain('deterministically-distilled-ambiguous_visual_match')

    expect(pdfModelDerivedDecisionKeys(stripped).size).toBeGreaterThan(0)
    expect(() =>
      buildStructDocument(withoutReceipt(stripped) as PdfReconstruction),
    ).toThrow('MISSING_MODEL_CONSULTATION_RECEIPT')
  })

  it('attributes a settled tie whose own confidence still records it as unsettled', async () => {
    // `updateReadingOrder` never rewrites `readingOrder.resolutions`, so the
    // `status` enum is the only trace a tie was model-resolved. Anchor on the
    // resolution's own numbers instead: a tie below its threshold stays a tie
    // however the enum is relabelled.
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) => ({ candidateId: request.candidates[0]!.id }),
      },
    })
    const expected = pdfModelDerivedDecisionKeys(resolved)
    const relabelled = structuredClone(resolved)
    for (const resolution of relabelled.readingOrder.resolutions) {
      if (resolution.status !== 'ambiguous') continue
      expect(resolution.confidence).toBeLessThan(resolution.threshold)
      resolution.status = 'resolved'
    }

    expect(pdfModelDerivedDecisionKeys(relabelled)).toEqual(expected)
  })

  it('refuses to let a narrower diagnostic account for a whole reading-order tie', async () => {
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) => ({ candidateId: request.candidates[0]!.id }),
      },
    })
    const expected = pdfModelDerivedDecisionKeys(resolved)
    expect(expected.size).toBeGreaterThan(0)

    const narrowed = structuredClone(resolved)
    const tie = narrowed.readingOrder.resolutions.find(
      ({ status }) => status === 'ambiguous',
    )!
    narrowed.diagnostics.push({
      code: 'AMBIGUOUS_READING_ORDER',
      severity: 'error',
      page: 1,
      message: 'obligation over one tied region',
      sourceBoxes: [],
      target: { regionIds: [tie.regionIds[0]!], markerId: null },
    })

    const tieKey = [...expected].find((key) =>
      key.startsWith(MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie),
    )!
    expect(tieKey).toBeDefined()
    expect(pdfModelDerivedDecisionKeys(narrowed)).toEqual(expected)
    expect(() =>
      buildStructDocument(withoutReceipt(narrowed) as PdfReconstruction),
    ).toThrow('MISSING_MODEL_CONSULTATION_RECEIPT')
  })

  it('keeps building a deterministic document when a decision file is applied twice', async () => {
    // Re-applying an exact prior success preserves its attribution when the
    // installed reading order still matches. No model ever ran here, so
    // refusing this document would break the deterministic flow.
    const unresolved = await resolvePdfModelFallbacks(adjudicationRequired, {})
    const diagnostic = unresolved.diagnostics.find(
      ({ code }) => code === 'AMBIGUOUS_READING_ORDER',
    )!
    const [order] = readingOrderCandidates(unresolved, diagnostic)
    const decisionFile = upsertHumanDecision(
      createHumanDecisionFile(unresolved.source.sha256),
      {
        diagnosticCode: 'AMBIGUOUS_READING_ORDER',
        target: structuredClone(diagnostic.target!),
        resolution: { type: 'accept-reading-order', regionIds: [...order!] },
      },
    )

    const once = applyHumanDecisionFile(unresolved, decisionFile)
    expect(once.humanAdjudications.applied).toHaveLength(1)
    expect(pdfModelDerivedDecisionKeys(once).size).toBe(0)

    const twice = applyHumanDecisionFile(once, decisionFile)
    expect(twice.humanAdjudications.applied).toEqual(
      once.humanAdjudications.applied,
    )
    expect(twice.humanAdjudications.stale).toEqual([])
    expect(pdfModelDerivedDecisionKeys(twice).size).toBe(0)
    expect(() =>
      buildStructDocument(withoutReceipt(twice) as PdfReconstruction),
    ).not.toThrow()
  })

  it('does not let a never-applied stale decision account for a model-settled tie', async () => {
    const diagnostic = adjudicationRequired.diagnostics.find(
      ({ code }) => code === 'AMBIGUOUS_READING_ORDER',
    )!
    const [order] = readingOrderCandidates(adjudicationRequired, diagnostic)
    const decisionFile = upsertHumanDecision(
      createHumanDecisionFile(adjudicationRequired.source.sha256),
      {
        diagnosticCode: 'AMBIGUOUS_READING_ORDER',
        target: structuredClone(diagnostic.target!),
        resolution: { type: 'accept-reading-order', regionIds: [...order!] },
      },
    )
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) => ({ candidateId: request.candidates[0]!.id }),
      },
    })
    const expected = pdfModelDerivedDecisionKeys(resolved)
    const tieKey = [...expected].find((key) =>
      key.startsWith(MODEL_FALLBACK_DECISION_CLASSES.readingOrderTie),
    )
    expect(tieKey).toBeDefined()

    const stale = applyHumanDecisionFile(resolved, decisionFile)
    expect(stale.humanAdjudications.applied).toEqual([])
    expect(stale.humanAdjudications.stale).toEqual([
      expect.objectContaining({
        diagnosticCode: 'AMBIGUOUS_READING_ORDER',
        reason: 'diagnostic-target-missing',
      }),
    ])
    expect(pdfModelDerivedDecisionKeys(stale)).toEqual(expected)
    expect(() =>
      buildStructDocument(withoutReceipt(stale) as PdfReconstruction),
    ).toThrow('MISSING_MODEL_CONSULTATION_RECEIPT')
  })

  it('does not let a forged applied decision account for a model-settled tie', async () => {
    const resolved = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: (request) => ({ candidateId: request.candidates[0]!.id }),
      },
    })
    const tie = resolved.readingOrder.resolutions.find(
      ({ status }) => status === 'ambiguous',
    )!
    const forged = withoutReceipt(
      structuredClone(resolved),
    ) as PdfReconstruction
    forged.humanAdjudications.applied = [
      {
        diagnosticCode: 'AMBIGUOUS_READING_ORDER',
        target: { markerId: null, regionIds: [...tie.regionIds] },
        resolution: {
          type: 'accept-reading-order',
          regionIds: [...tie.regionIds].reverse(),
        },
      },
    ]

    expect(() => buildStructDocument(forged)).toThrow(
      'MISSING_MODEL_CONSULTATION_RECEIPT',
    )
  })

  it('reads model-derived state from a reconstruction that carries no adjudication record', async () => {
    // `humanAdjudications` is optional on parsed reconstructions (see the EPUB
    // round-trip shape), so a legacy document reaches STRUCT without one. An
    // absent record accounts for nothing, which is the fail-closed reading.
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
    const expected = pdfModelDerivedDecisionKeys(resolved)
    expect(expected.size).toBeGreaterThan(0)

    const legacy = structuredClone(resolved)
    delete (legacy as { humanAdjudications?: unknown }).humanAdjudications
    expect(pdfModelDerivedDecisionKeys(legacy)).toEqual(expected)

    // The digest spans the whole semantic state, so dropping the record alone
    // refuses the receipt. Rebind it and the document must verify end to end:
    // the absent record is a shape this layer reads, not one it chokes on.
    expect(modelConsultationReceiptMatchesPdfReconstruction(legacy)).toBe(false)
    legacy.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        legacy,
        legacy.modelConsultations!,
      )
    expect(modelConsultationReceiptMatchesPdfReconstruction(legacy)).toBe(true)
    expect(() => buildStructDocument(legacy)).not.toThrow()

    // A deterministic document with neither receipt nor adjudication record
    // still builds: there is no model-derived state to launder.
    const deterministic = withoutReceipt(
      structuredClone(visualAdjudicationRequired),
    ) as PdfReconstruction
    delete (deterministic as { humanAdjudications?: unknown })
      .humanAdjudications
    expect(pdfModelDerivedDecisionKeys(deterministic).size).toBe(0)
    expect(() => buildStructDocument(deterministic)).not.toThrow()
  })

  it('refuses a receipt that disclaims model-derived state in the document', async () => {
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
    expect(modelConsultationReceiptMatchesPdfReconstruction(resolved)).toBe(
      true,
    )

    // `semanticStateSha256` is an unkeyed digest over public state, so a stale
    // value is not what makes an erased receipt fail. Recompute it and the
    // receipt must still be refused: the document still carries
    // model-consultation evidence that no consultation claims.
    const erased = structuredClone(resolved)
    const emptyReceipt = {
      ...structuredClone(resolved.modelConsultations!),
      consultations: [],
      decisions: [],
      metrics: {
        totalDecisionCount: 0,
        totalConsultationCount: 0,
        consultationRate: 0,
        byDecisionClass: {},
      },
    }
    erased.modelConsultations = emptyReceipt
    emptyReceipt.semanticStateSha256 = pdfModelConsultationSemanticStateSha256(
      erased,
      emptyReceipt,
    )
    expect(validateModelConsultationReceipt(emptyReceipt)).toBe(true)
    expect(modelConsultationReceiptMatchesPdfReconstruction(erased)).toBe(false)
    await expect(resolvePdfModelFallbacks(erased)).rejects.toThrow(
      'INVALID_MODEL_CONSULTATION_RECEIPT',
    )

    // Dropping the receipt outright must not silently launder the same state.
    const stripped = withoutReceipt(
      structuredClone(resolved),
    ) as PdfReconstruction
    expect(modelConsultationReceiptMatchesPdfReconstruction(stripped)).toBe(
      false,
    )
    expect(() => buildStructDocument(stripped)).toThrow(
      'MISSING_MODEL_CONSULTATION_RECEIPT',
    )
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

  it('accepts a supplied caption distillation rule id when its choice matches', async () => {
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
      'caption-association-v1',
    )

    const result = await resolvePdfModelFallbacks(
      visualAdjudicationRequired,
      new ModelConsultationGate({ distillation }),
    )

    expect(result.modelConsultations?.decisions).toEqual([
      expect.objectContaining({
        outcome: 'deterministic',
        choice: { candidateId: point!.candidates[0]!.id },
        deterministicRuleId: 'caption-association-v1',
      }),
    ])
    expect(result.diagnostics.map(({ code }) => code)).not.toContain(
      'AMBIGUOUS_VISUAL_MATCH',
    )
  })
})

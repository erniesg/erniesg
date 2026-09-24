import { beforeAll, describe, expect, it } from 'vitest'
import { fixtureFile } from '../../tests/fixtures/pdf-fixtures'
import type { PdfReconstruction } from './import-types'
import {
  applyHumanDecisionFile,
  createHumanDecisionFile,
  createVisualMatchDecision,
  readingOrderCandidates,
  upsertHumanDecision,
} from './decision-record'
import { DistillationLedger } from './model-fallback'
import {
  modelConsultationReceiptMatchesPdfReconstruction,
  pdfModelConsultationSemanticStateSha256,
  pdfModelDerivedDecisionKeys,
  resolvePdfModelFallbacks,
} from './model-fallback-pipeline'
import { reconstructPdf } from './pdf'
import { pdfVisualMatchCandidateId } from './pdf-visuals'
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

  it('lets verified human review supersede a failed consultation', async () => {
    const failed = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: () => {
          throw new Error('provider failed')
        },
      },
    })
    const relationship = failed.noteRelationships.find(
      ({ candidates }) => candidates.length > 0,
    )!
    const diagnostic = failed.diagnostics.find(
      ({ code, target }) =>
        code === 'AMBIGUOUS_NOTE_MATCH' && target?.markerId === relationship.id,
    )!
    const candidate = relationship.candidates[0]!
    const file = upsertHumanDecision(
      createHumanDecisionFile(failed.source.sha256),
      {
        diagnosticCode: diagnostic.code,
        target: structuredClone(diagnostic.target!),
        resolution: {
          type: 'accept-note-match',
          targetNoteId: candidate.targetNoteId,
          targetRegionId: candidate.targetRegionId,
        },
      },
    )

    const adjudicated = applyHumanDecisionFile(failed, file)

    expect(adjudicated.humanAdjudications.applied).toHaveLength(1)
    expect(modelConsultationReceiptMatchesPdfReconstruction(adjudicated)).toBe(
      true,
    )
  })

  it('binds human note supersession to the adjudicated source marker', async () => {
    const failed = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: () => {
          throw new Error('provider failed')
        },
      },
    })
    const relationship = failed.noteRelationships.find(
      ({ candidates }) => candidates.length > 0,
    )!
    const diagnostic = failed.diagnostics.find(
      ({ code, target }) =>
        code === 'AMBIGUOUS_NOTE_MATCH' && target?.markerId === relationship.id,
    )!
    const candidate = relationship.candidates[0]!
    const adjudicated = applyHumanDecisionFile(
      failed,
      upsertHumanDecision(createHumanDecisionFile(failed.source.sha256), {
        diagnosticCode: diagnostic.code,
        target: structuredClone(diagnostic.target!),
        resolution: {
          type: 'accept-note-match',
          targetNoteId: candidate.targetNoteId,
          targetRegionId: candidate.targetRegionId,
        },
      }),
    )
    expect(modelConsultationReceiptMatchesPdfReconstruction(adjudicated)).toBe(
      true,
    )

    const legacy = structuredClone(adjudicated)
    delete legacy.humanAdjudications.noteSourceAnchorReceipts
    legacy.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        legacy,
        legacy.modelConsultations!,
      )
    expect(modelConsultationReceiptMatchesPdfReconstruction(legacy)).toBe(true)
    expect(pdfModelDerivedDecisionKeys(withoutReceipt(legacy))).toEqual(
      new Set(),
    )

    const mutations = [
      (current: typeof relationship) => {
        current.referenceRegionId = 'retargeted-note-reference-region'
      },
      (current: typeof relationship) => {
        current.referenceStart += 1
      },
      (current: typeof relationship) => {
        current.referenceEnd += 1
      },
      (current: typeof relationship) => {
        current.canonicalAnchor = null
      },
    ]
    for (const mutate of mutations) {
      const tampered = structuredClone(adjudicated)
      mutate(
        tampered.noteRelationships.find(({ id }) => id === relationship.id)!,
      )
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

  it('fails closed for receiptless legacy human note author anchors', async () => {
    const authorAnchored = structuredClone(adjudicationRequired)
    const relationship = authorAnchored.noteRelationships.find(
      ({ candidates }) => candidates.length > 0,
    )!
    const originalAuthor = 'Ada Example'
    const replacementAuthor = 'Grace Example'
    authorAnchored.paper.authors = [originalAuthor, replacementAuthor]
    relationship.canonicalAnchor = {
      kind: 'author',
      author: originalAuthor,
    }
    authorAnchored.paper.nodes = authorAnchored.paper.nodes.filter(
      (node) =>
        !authorAnchored.provenance[node.id]?.regionIds.includes(
          relationship.referenceRegionId,
        ),
    )
    const failed = await resolvePdfModelFallbacks(authorAnchored, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: () => {
          throw new Error('provider failed')
        },
      },
    })
    const diagnostic = failed.diagnostics.find(
      ({ code, target }) =>
        code === 'AMBIGUOUS_NOTE_MATCH' && target?.markerId === relationship.id,
    )!
    const candidate = relationship.candidates[0]!
    const adjudicated = applyHumanDecisionFile(
      failed,
      upsertHumanDecision(createHumanDecisionFile(failed.source.sha256), {
        diagnosticCode: diagnostic.code,
        target: structuredClone(diagnostic.target!),
        resolution: {
          type: 'accept-note-match',
          targetNoteId: candidate.targetNoteId,
          targetRegionId: candidate.targetRegionId,
        },
      }),
    )
    expect(modelConsultationReceiptMatchesPdfReconstruction(adjudicated)).toBe(
      true,
    )

    const legacy = structuredClone(adjudicated)
    delete legacy.humanAdjudications.noteSourceAnchorReceipts
    legacy.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        legacy,
        legacy.modelConsultations!,
      )
    const retargeted = structuredClone(legacy)
    const retargetedRelationship = retargeted.noteRelationships.find(
      ({ id }) => id === relationship.id,
    )!
    retargetedRelationship.canonicalAnchor = {
      kind: 'author',
      author: replacementAuthor,
    }
    retargeted.paper.authorNotes = retargeted.paper.authorNotes?.map((note) =>
      note.id === relationship.id
        ? { ...note, author: replacementAuthor }
        : note,
    )
    retargeted.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        retargeted,
        retargeted.modelConsultations!,
      )

    expect([
      modelConsultationReceiptMatchesPdfReconstruction(legacy),
      modelConsultationReceiptMatchesPdfReconstruction(retargeted),
    ]).toEqual([false, false])
  })

  it.each(['reclassify-citation', 'reclassify-plain-text'] as const)(
    'binds human note %s supersession to the adjudicated source marker',
    async (resolutionType) => {
      const failed = await resolvePdfModelFallbacks(adjudicationRequired, {
        enabled: true,
        ownerOptIn: true,
        model: {
          identity: modelIdentity,
          consult: () => {
            throw new Error('provider failed')
          },
        },
      })
      const relationship = failed.noteRelationships.find(
        ({ candidates }) => candidates.length > 0,
      )!
      const diagnostic = failed.diagnostics.find(
        ({ code, target }) =>
          code === 'AMBIGUOUS_NOTE_MATCH' &&
          target?.markerId === relationship.id,
      )!
      const adjudicated = applyHumanDecisionFile(
        failed,
        upsertHumanDecision(createHumanDecisionFile(failed.source.sha256), {
          diagnosticCode: diagnostic.code,
          target: structuredClone(diagnostic.target!),
          resolution: { type: resolutionType },
        }),
      )
      expect(
        modelConsultationReceiptMatchesPdfReconstruction(adjudicated),
      ).toBe(true)

      const legacy = structuredClone(adjudicated)
      delete legacy.humanAdjudications.noteSourceAnchorReceipts
      legacy.modelConsultations!.semanticStateSha256 =
        pdfModelConsultationSemanticStateSha256(
          legacy,
          legacy.modelConsultations!,
        )
      if (resolutionType === 'reclassify-citation') {
        expect(modelConsultationReceiptMatchesPdfReconstruction(legacy)).toBe(
          true,
        )
      }

      const mutations = [
        (copy: typeof adjudicated) => {
          const current = copy.noteRelationships.find(
            ({ id }) => id === relationship.id,
          )!
          const replacement = copy.regions.find(
            ({ id }) =>
              id !== current.referenceRegionId &&
              !current.candidates.some(
                ({ targetRegionId }) => targetRegionId === id,
              ),
          )!
          current.referenceRegionId = replacement.id
          const citation = copy.citationRelationships.find(
            ({ id }) => id === current.id,
          )
          if (citation) citation.referenceRegionId = replacement.id
        },
        (copy: typeof adjudicated) => {
          const current = copy.noteRelationships.find(
            ({ id }) => id === relationship.id,
          )!
          current.referenceStart += 1
          const citation = copy.citationRelationships.find(
            ({ id }) => id === current.id,
          )
          if (citation) citation.referenceStart = current.referenceStart
        },
        (copy: typeof adjudicated) => {
          const current = copy.noteRelationships.find(
            ({ id }) => id === relationship.id,
          )!
          current.referenceEnd += 1
          const citation = copy.citationRelationships.find(
            ({ id }) => id === current.id,
          )
          if (citation) citation.referenceEnd = current.referenceEnd
        },
        (copy: typeof adjudicated) => {
          copy.noteRelationships.find(
            ({ id }) => id === relationship.id,
          )!.canonicalAnchor = null
        },
      ]
      for (const mutate of mutations) {
        const tampered = structuredClone(adjudicated)
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

      if (resolutionType === 'reclassify-plain-text') {
        const zeroRunLegacy = structuredClone(legacy)
        const zeroRunRelationship = zeroRunLegacy.noteRelationships.find(
          ({ id }) => id === relationship.id,
        )!
        const zeroRunAnchor = zeroRunRelationship.canonicalAnchor
        expect(zeroRunAnchor?.kind).toBe('node')
        const zeroRunOwner = zeroRunLegacy.paper.nodes.find(
          ({ id }) =>
            zeroRunAnchor?.kind === 'node' && id === zeroRunAnchor.nodeId,
        )!
        if (!('inlineRuns' in zeroRunOwner)) {
          throw new Error('Missing inline-run owner for legacy note marker')
        }
        zeroRunOwner.inlineRuns = zeroRunOwner.inlineRuns?.filter(
          ({ relationshipId }) => relationshipId !== relationship.id,
        )
        if (zeroRunOwner.inlineRuns?.length === 0) {
          delete zeroRunOwner.inlineRuns
        }
        zeroRunLegacy.modelConsultations!.semanticStateSha256 =
          pdfModelConsultationSemanticStateSha256(
            zeroRunLegacy,
            zeroRunLegacy.modelConsultations!,
          )

        const movedLegacy = structuredClone(zeroRunLegacy)
        const legacyRelationship = movedLegacy.noteRelationships.find(
          ({ id }) => id === relationship.id,
        )!
        legacyRelationship.referenceStart += 1
        legacyRelationship.referenceEnd += 1
        if (legacyRelationship.canonicalAnchor?.kind === 'node') {
          legacyRelationship.canonicalAnchor.start =
            legacyRelationship.referenceStart
          legacyRelationship.canonicalAnchor.end =
            legacyRelationship.referenceEnd
        }
        const legacyClassification = movedLegacy.diagnostics
          .flatMap(({ noteMarkerClassification }) =>
            noteMarkerClassification ? [noteMarkerClassification] : [],
          )
          .find(({ id }) => id === relationship.id)!
        legacyClassification.start = legacyRelationship.referenceStart
        legacyClassification.end = legacyRelationship.referenceEnd
        movedLegacy.modelConsultations!.semanticStateSha256 =
          pdfModelConsultationSemanticStateSha256(
            movedLegacy,
            movedLegacy.modelConsultations!,
          )
        expect([
          modelConsultationReceiptMatchesPdfReconstruction(legacy),
          modelConsultationReceiptMatchesPdfReconstruction(zeroRunLegacy),
          modelConsultationReceiptMatchesPdfReconstruction(movedLegacy),
        ]).toEqual([true, false, false])

        const zeroRun = structuredClone(adjudicated)
        const current = zeroRun.noteRelationships.find(
          ({ id }) => id === relationship.id,
        )!
        const anchor = current.canonicalAnchor
        expect(anchor?.kind).toBe('node')
        const owner = zeroRun.paper.nodes.find(
          ({ id }) => anchor?.kind === 'node' && id === anchor.nodeId,
        )!
        if ('inlineRuns' in owner && owner.inlineRuns) {
          owner.inlineRuns = owner.inlineRuns.filter(
            ({ relationshipId }) => relationshipId !== current.id,
          )
          if (owner.inlineRuns.length === 0) delete owner.inlineRuns
        }
        zeroRun.modelConsultations!.semanticStateSha256 =
          pdfModelConsultationSemanticStateSha256(
            zeroRun,
            zeroRun.modelConsultations!,
          )
        expect(modelConsultationReceiptMatchesPdfReconstruction(zeroRun)).toBe(
          true,
        )

        const tampered = structuredClone(zeroRun)
        const moved = tampered.noteRelationships.find(
          ({ id }) => id === relationship.id,
        )!
        moved.referenceStart += 1
        moved.referenceEnd += 1
        if (moved.canonicalAnchor?.kind === 'node') {
          moved.canonicalAnchor.start = moved.referenceStart
          moved.canonicalAnchor.end = moved.referenceEnd
        }
        tampered.modelConsultations!.semanticStateSha256 =
          pdfModelConsultationSemanticStateSha256(
            tampered,
            tampered.modelConsultations!,
          )
        expect(modelConsultationReceiptMatchesPdfReconstruction(tampered)).toBe(
          false,
        )
      }
    },
  )

  it('binds human visual supersession to the adjudicated caption anchor', async () => {
    const failed = await resolvePdfModelFallbacks(visualAdjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      distillation: new DistillationLedger(),
      model: {
        identity: modelIdentity,
        consult: () => {
          throw new Error('provider failed')
        },
      },
    })
    const relationship = failed.visualRelationships.find(
      ({ status, candidates }) =>
        status === 'ambiguous' && candidates.length > 0,
    )!
    const candidate = relationship.candidates[0]!
    const decision = createVisualMatchDecision(
      failed,
      relationship.id,
      candidate.id ?? pdfVisualMatchCandidateId(relationship.id, candidate),
    )
    const adjudicated = applyHumanDecisionFile(
      failed,
      upsertHumanDecision(
        createHumanDecisionFile(failed.source.sha256),
        decision,
      ),
    )
    expect(modelConsultationReceiptMatchesPdfReconstruction(adjudicated)).toBe(
      true,
    )

    const tampered = structuredClone(adjudicated)
    const current = tampered.visualRelationships.find(
      ({ id }) => id === relationship.id,
    )!
    const originalCaptionNode = tampered.paper.nodes.find(
      ({ id }) => id === current.captionNodeId,
    )!
    const originalCaptionProvenance =
      tampered.provenance[current.captionNodeId!]!
    const retargetedCaptionNodeId = `${current.captionNodeId}-retargeted`
    const retargetedCaptionRegionId = `${current.captionRegionId}-retargeted`
    tampered.paper.nodes.push({
      ...structuredClone(originalCaptionNode),
      id: retargetedCaptionNodeId,
    })
    tampered.provenance[retargetedCaptionNodeId] = {
      ...structuredClone(originalCaptionProvenance),
      regionIds: [retargetedCaptionRegionId],
    }
    current.captionNodeId = retargetedCaptionNodeId
    current.captionRegionId = retargetedCaptionRegionId
    const canonicalNode = tampered.paper.nodes.find(
      ({ id }) => id === current.canonicalNodeId,
    )
    if (canonicalNode?.type === 'figure') {
      canonicalNode.relationships.caption = retargetedCaptionNodeId
    }
    tampered.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        tampered,
        tampered.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(tampered)).toBe(
      false,
    )
  })

  it('binds human visual supersession to the adjudicated figure node', async () => {
    const failed = await resolvePdfModelFallbacks(visualAdjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      distillation: new DistillationLedger(),
      model: {
        identity: modelIdentity,
        consult: () => {
          throw new Error('provider failed')
        },
      },
    })
    const relationship = failed.visualRelationships.find(
      ({ status, candidates }) =>
        status === 'ambiguous' && candidates.length > 0,
    )!
    const candidate = relationship.candidates[0]!
    const adjudicated = applyHumanDecisionFile(
      failed,
      upsertHumanDecision(
        createHumanDecisionFile(failed.source.sha256),
        createVisualMatchDecision(
          failed,
          relationship.id,
          candidate.id ?? pdfVisualMatchCandidateId(relationship.id, candidate),
        ),
      ),
    )
    expect(modelConsultationReceiptMatchesPdfReconstruction(adjudicated)).toBe(
      true,
    )

    const tampered = structuredClone(adjudicated)
    const current = tampered.visualRelationships.find(
      ({ id }) => id === relationship.id,
    )!
    const canonicalNode = tampered.paper.nodes.find(
      ({ id }) => id === current.canonicalNodeId,
    )!
    const retargetedNodeId = `${current.canonicalNodeId}-retargeted`
    tampered.paper.nodes.push({
      ...structuredClone(canonicalNode),
      id: retargetedNodeId,
    })
    tampered.provenance[retargetedNodeId] = structuredClone(
      tampered.provenance[current.canonicalNodeId!]!,
    )
    current.canonicalNodeId = retargetedNodeId
    tampered.modelConsultations!.semanticStateSha256 =
      pdfModelConsultationSemanticStateSha256(
        tampered,
        tampered.modelConsultations!,
      )

    expect(modelConsultationReceiptMatchesPdfReconstruction(tampered)).toBe(
      false,
    )
  })

  it('binds human visual supersession to the installed node payload and provenance', async () => {
    const failed = await resolvePdfModelFallbacks(visualAdjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      distillation: new DistillationLedger(),
      model: {
        identity: modelIdentity,
        consult: () => {
          throw new Error('provider failed')
        },
      },
    })
    const relationship = failed.visualRelationships.find(
      ({ status, candidates }) =>
        status === 'ambiguous' && candidates.length > 0,
    )!
    const candidate = relationship.candidates[0]!
    const adjudicated = applyHumanDecisionFile(
      failed,
      upsertHumanDecision(
        createHumanDecisionFile(failed.source.sha256),
        createVisualMatchDecision(
          failed,
          relationship.id,
          candidate.id ?? pdfVisualMatchCandidateId(relationship.id, candidate),
        ),
      ),
    )
    expect(modelConsultationReceiptMatchesPdfReconstruction(adjudicated)).toBe(
      true,
    )

    for (const mutate of [
      (copy: typeof adjudicated) => {
        const current = copy.visualRelationships.find(
          ({ id }) => id === relationship.id,
        )!
        const node = copy.paper.nodes.find(
          ({ id }) => id === current.canonicalNodeId,
        )!
        if (node.type === 'figure') node.title = `${node.title}-tampered`
      },
      (copy: typeof adjudicated) => {
        const current = copy.visualRelationships.find(
          ({ id }) => id === relationship.id,
        )!
        const node = copy.paper.nodes.find(
          ({ id }) => id === current.canonicalNodeId,
        )!
        if (node.type === 'figure') node.sourceText = 'tampered source text'
      },
      (copy: typeof adjudicated) => {
        const current = copy.visualRelationships.find(
          ({ id }) => id === relationship.id,
        )!
        const node = copy.paper.nodes.find(
          ({ id }) => id === current.canonicalNodeId,
        )!
        if (node.type === 'figure') {
          node.objectType = node.objectType === 'figure' ? 'table' : 'figure'
        }
      },
      (copy: typeof adjudicated) => {
        const current = copy.visualRelationships.find(
          ({ id }) => id === relationship.id,
        )!
        const node = copy.paper.nodes.find(
          ({ id }) => id === current.canonicalNodeId,
        )!
        if (node.type === 'figure') node.relationships.assets = []
      },
      (copy: typeof adjudicated) => {
        const current = copy.visualRelationships.find(
          ({ id }) => id === relationship.id,
        )!
        copy.provenance[current.canonicalNodeId!]!.confidence = Math.max(
          0,
          current.confidence - 0.1,
        )
      },
    ]) {
      const tampered = structuredClone(adjudicated)
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

  it('accounts for a human unresolved-visual fallback without a model receipt', () => {
    const base = structuredClone(visualAdjudicationRequired)
    const unresolvedDiagnostic = base.diagnostics.find(
      ({ code }) => code === 'UNRESOLVED_VISUAL_OBJECT',
    )!
    const unresolvedRelationship = base.visualRelationships.find(
      ({ id }) => id === unresolvedDiagnostic.target?.markerId,
    )!
    if (unresolvedRelationship.candidates.length === 1) {
      const selected = unresolvedRelationship.candidates[0]!
      unresolvedRelationship.candidates.push({
        ...structuredClone(selected),
        id: `${selected.id ?? 'unresolved-visual-candidate'}-alternate`,
        score: Math.max(0, selected.score - 0.01),
      })
    }
    let decisions = createHumanDecisionFile(base.source.sha256)
    let unresolvedRelationshipId: string | undefined
    for (const diagnostic of base.diagnostics) {
      if (
        (diagnostic.code !== 'AMBIGUOUS_VISUAL_MATCH' &&
          diagnostic.code !== 'UNRESOLVED_VISUAL_OBJECT') ||
        !diagnostic.target?.markerId
      ) {
        continue
      }
      const relationship = base.visualRelationships.find(
        ({ id }) => id === diagnostic.target!.markerId,
      )!
      const candidate = relationship.candidates[0]!
      if (diagnostic.code === 'UNRESOLVED_VISUAL_OBJECT') {
        unresolvedRelationshipId = relationship.id
        const scores = relationship.candidates
          .map(({ score }) => score)
          .sort((left, right) => right - left)
        expect(scores[0]! - scores[1]!).toBeLessThan(0.08)
      }
      decisions = upsertHumanDecision(
        decisions,
        createVisualMatchDecision(
          base,
          relationship.id,
          candidate.id ?? pdfVisualMatchCandidateId(relationship.id, candidate),
          diagnostic.code === 'UNRESOLVED_VISUAL_OBJECT'
            ? 'accept-visual-fallback'
            : 'accept-visual-match',
        ),
      )
    }
    expect(unresolvedRelationshipId).toBeDefined()

    const adjudicated = applyHumanDecisionFile(base, decisions)
    expect(adjudicated.humanAdjudications.stale).toEqual([])
    expect(
      [...pdfModelDerivedDecisionKeys(adjudicated)].some((key) =>
        key.endsWith(`\u0000${unresolvedRelationshipId}`),
      ),
    ).toBe(false)
    expect(() => buildStructDocument(adjudicated)).not.toThrow()
  })

  it('binds human reading-order supersession to installed accepted edges', async () => {
    const failed = await resolvePdfModelFallbacks(adjudicationRequired, {
      enabled: true,
      ownerOptIn: true,
      model: {
        identity: modelIdentity,
        consult: () => {
          throw new Error('provider failed')
        },
      },
    })
    const diagnostic = failed.diagnostics.find(
      ({ code }) => code === 'AMBIGUOUS_READING_ORDER',
    )!
    const chosen = readingOrderCandidates(failed, diagnostic)[0]!
    const adjudicated = applyHumanDecisionFile(
      failed,
      upsertHumanDecision(createHumanDecisionFile(failed.source.sha256), {
        diagnosticCode: diagnostic.code,
        target: structuredClone(diagnostic.target!),
        resolution: {
          type: 'accept-reading-order',
          regionIds: [...chosen],
        },
      }),
    )
    expect(modelConsultationReceiptMatchesPdfReconstruction(adjudicated)).toBe(
      true,
    )
    const targetIds = new Set(chosen)
    const installedEdge = adjudicated.readingOrder.edges.find(
      ({ from, to, status }) =>
        targetIds.has(from) && targetIds.has(to) && status === 'accepted',
    )!

    for (const mutate of [
      (copy: typeof adjudicated) => {
        copy.readingOrder.edges = copy.readingOrder.edges.filter(
          ({ id }) => id !== installedEdge.id,
        )
      },
      (copy: typeof adjudicated) => {
        copy.readingOrder.edges.find(
          ({ id }) => id === installedEdge.id,
        )!.status = 'candidate'
      },
      (copy: typeof adjudicated) => {
        const selectedEdges = copy.readingOrder.edges.filter(
          ({ from, to, status }) =>
            targetIds.has(from) && targetIds.has(to) && status === 'accepted',
        )
        expect(selectedEdges.length).toBeGreaterThan(1)
        selectedEdges[1]!.from = selectedEdges[0]!.from
        selectedEdges[1]!.to = selectedEdges[0]!.to
      },
    ]) {
      const tampered = structuredClone(adjudicated)
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
})

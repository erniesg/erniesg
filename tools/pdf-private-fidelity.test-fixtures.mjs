import { canonicalJsonHash } from './pdf-corpus-audit-lib.mjs'
import {
  createPrivateFidelityReceipt,
  createPrivateFidelityRunReceipt,
  createPrivateReconstructionEvidence as createPrivateReconstructionEvidenceRaw,
} from './pdf-private-fidelity.mjs'

export const hash = 'a'.repeat(64)
export const privateCompletenessPolicy = {
  minimumTextCoverage: 0.98,
  minimumAssetCoverage: 1,
  minimumRelationshipCoverage: 1,
  maximumUnresolvedObjects: 0,
  maximumOcrRequiredPages: 0,
  maximumReadingOrderDiagnostics: 0,
}

export function createPrivateReconstructionEvidence(
  reconstruction,
  artifactProjections = { 'readable-fallback': reconstruction },
) {
  return createPrivateReconstructionEvidenceRaw(
    reconstruction,
    artifactProjections,
  )
}

export function reconstruction(ready = true, ledgerAvailable = true) {
  return {
    source: { pageCount: 3 },
    completeness: {
      sourceTextCharacters: 100,
      outputTextCharacters: ready ? 100 : 90,
      matchedTextCharacters: ready ? 100 : 90,
      textCoverage: ready ? 1 : 0.9,
      duplicateCanonicalSpanCount: 0,
      missingSourceRegionCount: 0,
      unprovenancedRenderedUnitCount: 0,
      expectedInlineSpanCount: 1,
      mappedInlineSpanCount: 1,
      inlineSpanCoverage: 1,
      expectedHyperlinkCount: 1,
      mappedHyperlinkCount: 1,
      hyperlinkCoverage: 1,
      lineBoundaryCount: ledgerAvailable ? 1 : 0,
      decidedLineBoundaryCount: ledgerAvailable ? 1 : 0,
      unresolvedCorruptingJoinCount: 0,
      structurallyConsumedLineBoundaryCount: 0,
      sourceAssetCount: 1,
      exportedAssetCount: 1,
      assetCoverage: 1,
      expectedRelationshipCount: 1,
      resolvedRelationshipCount: 1,
      relationshipCoverage: 1,
      unresolvedObjectCount: ready ? 0 : 1,
      unresolvedObjects: {
        assets: 0,
        captions: ready ? 0 : 1,
        tables: 0,
        equations: 0,
        citations: 0,
        footnoteReferences: 0,
        footnotes: 0,
      },
      ocrRequiredPages: [],
      readingOrderDiagnostics: 0,
      readingOrderEvaluation: {
        schemaVersion: '1.0.0',
        algorithm: 'deterministic-geometry-v1',
        mode: 'deterministic-only',
        regionCount: 2,
        acceptedEdgeCount: 1,
        unresolvedEdgeCount: 0,
        cycleRate: 0,
        orderAccuracy: null,
        provider: null,
        modelVersion: null,
        latencyMs: 0,
        costUsd: 0,
        reviewRequired: false,
      },
    },
    readiness: {
      ready,
      status: ready ? 'ready' : 'review-required',
      policy: privateCompletenessPolicy,
      blockingDiagnosticCodes: ready ? [] : ['INCOMPLETE_TEXT_COVERAGE'],
    },
    paper: {
      id: 'paper-v1',
      version: '1.0.0',
      status: 'working',
      title: 'Synthetic paper',
      subtitle: 'Private runner fixture',
      authors: ['Example Author'],
      updated: '2026-07-20',
      abstract: 'Synthetic abstract.',
      nodes: [
        {
          id: 'heading-1',
          source: 'region-1',
          type: 'heading',
          level: 1,
          text: 'Synthetic paper',
        },
        {
          id: 'paragraph-1',
          source: 'region-2',
          type: 'paragraph',
          text: 'Synthetic body.',
        },
      ],
    },
    readingOrder: { order: ['region-1', 'region-2'] },
    regions: [
      {
        id: 'region-1',
        page: 1,
        lines: [{ id: 'line-1' }, { id: 'line-2' }],
      },
      { id: 'region-2', page: 1, lines: [{ id: 'line-3' }] },
    ],
    canonicalHyphenBoundaryDecisions: [],
    canonicalHyphenBoundaryDecisionCount: 0,
    visualRelationships: [{ kind: 'figure', status: 'matched' }],
    noteRelationships: [],
    assets: [],
    diagnostics: ready
      ? [{ severity: 'info', code: 'SOURCE_OK' }]
      : [
          {
            severity: 'error',
            code: 'INCOMPLETE_TEXT_COVERAGE',
          },
        ],
    ...(ledgerAvailable
      ? {
          lineBoundaryDecisions: [
            {
              id: 'transition-1',
              page: 1,
              regionId: 'region-1',
              fromLineId: 'line-1',
              toLineId: 'line-2',
              outcome: 'space',
              evidence: [],
            },
          ],
          unresolvedCorruptingJoinCount: 0,
          structurallyConsumedLineBoundaryCount: 0,
        }
      : {}),
  }
}

export function artifact(target, suffix = '', source = reconstruction()) {
  const parity =
    createPrivateReconstructionEvidence(source).artifactParity.publication
  const evidence = {
    target,
    profileVersion: '1.0.0',
    mode: 'publication',
    byteLength: 1024,
    sha256: `${'b'.repeat(63)}${suffix || 'b'}`,
    canonicalNodeCount: parity.canonicalNodeCount,
    canonicalNodeSequenceSha256: parity.canonicalNodeSequenceSha256,
    canonicalContentSha256: parity.canonicalContentSha256,
    relationshipCount: parity.relationshipCount,
    relationshipGraphSha256: parity.relationshipGraphSha256,
    assetCount: parity.assetCount,
    assetManifestSha256: parity.assetManifestSha256,
    inlineSemanticLedger: parity.inlineSemanticLedger,
    structuralValidation: 'passed',
    epubCheck: { status: 'skipped', reason: 'not-required' },
  }
  return { ...evidence, receiptSha256: canonicalJsonHash(evidence) }
}

export function run(
  ordinal,
  source,
  artifacts,
  readableFallbackProjection = source,
) {
  return createPrivateFidelityRunReceipt({
    ordinal,
    reconstruction: source,
    artifacts,
    artifactProjections: {
      'readable-fallback': readableFallbackProjection,
    },
  })
}

export function fidelityReceipt({
  paperId = 'paper-v1',
  sourceSha256 = hash,
  byteLength = 123,
  decisionSetSha256 = null,
  profiles = ['mobile'],
  repeat = 2,
  ready = true,
  transformReconstruction = (value) => value,
  transformArtifact = (value) => value,
} = {}) {
  const runs = Array.from({ length: repeat }, (_, index) => {
    const ordinal = index + 1
    const source = transformReconstruction(reconstruction(ready), ordinal)
    const artifacts = profiles.map((profile) => {
      const candidate = transformArtifact(
        artifact(profile, '', source),
        profile,
        ordinal,
      )
      const evidence = Object.fromEntries(
        Object.entries(candidate).filter(([key]) => key !== 'receiptSha256'),
      )
      return { ...evidence, receiptSha256: canonicalJsonHash(evidence) }
    })
    return run(ordinal, source, artifacts)
  })
  return createPrivateFidelityReceipt({
    paperId,
    sourceSha256,
    byteLength,
    decisionSetSha256,
    runs,
    repeat,
    profiles,
  })
}

export function acceptedBaselineSha256(receipt) {
  return canonicalJsonHash(receipt)
}

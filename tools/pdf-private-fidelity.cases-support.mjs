import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  canonicalHyphenEvidenceSha256,
  canonicalJsonHash,
  PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE,
  PDF_HYPHEN_LEXICAL_MODEL_RECEIPT,
  PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE_RECEIPT,
  PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE,
} from './pdf-corpus-audit-lib.mjs'
import {
  applyPrivateDecisionSet,
  comparePrivateFidelityBaseline,
  comparePrivateFidelityReceipts,
  createPrivateFidelityReceipt,
  createPrivateFidelityRunReceipt,
  createPrivateReconstructionEvidence as createPrivateReconstructionEvidenceRaw,
  parsePrivateFidelityArguments,
  prepareOwnerOnlyDirectory,
  writeExclusive,
} from './pdf-private-fidelity.mjs'
import * as privateFidelity from './pdf-private-fidelity.mjs'

const hash = 'a'.repeat(64)
const privateCompletenessPolicy = {
  minimumTextCoverage: 0.98,
  minimumAssetCoverage: 1,
  minimumRelationshipCoverage: 1,
  maximumUnresolvedObjects: 0,
  maximumOcrRequiredPages: 0,
  maximumReadingOrderDiagnostics: 0,
}

function createPrivateReconstructionEvidence(
  reconstruction,
  artifactProjections = { 'readable-fallback': reconstruction },
) {
  return createPrivateReconstructionEvidenceRaw(
    reconstruction,
    artifactProjections,
  )
}

function canonicalHyphenDeletionRecord() {
  const joinedWord = 'representation'
  return {
    id: '1'.repeat(64),
    context: 'canonical-flow-continuation',
    outcome: 'removed-discretionary-hyphen',
    fromRegionId: '2'.repeat(64),
    fromLineId: '3'.repeat(64),
    toRegionId: '4'.repeat(64),
    toLineId: '5'.repeat(64),
    geometry: {
      from: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.02,
        rotation: 0,
        method: 'pdf-text',
      },
      to: {
        page: 1,
        x: 0.1,
        y: 0.22,
        width: 0.3,
        height: 0.02,
        rotation: 0,
        method: 'pdf-text',
      },
    },
    proof: {
      tier: 'exact-same-document',
      sourceBoundaryProven: true,
      pinnedWordSha256: canonicalJsonHash(joinedWord),
      pinnedJoinedFormValid: true,
      pinnedSplit: {
        leftSha256: canonicalJsonHash('repre'),
        rightSha256: canonicalJsonHash('sentation'),
        index: 5,
      },
      splitPointValid: true,
      exactSameDocumentJoinedFormSha256: canonicalJsonHash(joinedWord),
      sameDocumentJoinedFormValid: true,
      hardHyphenFormSha256: canonicalJsonHash('repre-sentation'),
      hardHyphenCounterproof: null,
      model: { ...PDF_HYPHEN_LEXICAL_MODEL_RECEIPT },
      evidenceSha256s: [
        ...PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE,
        'language-scope:en-US->en-US',
      ]
        .map(canonicalHyphenEvidenceSha256)
        .sort(),
    },
  }
}

function canonicalDerivedAffixHyphenDeletionRecord() {
  const derivedWordSha256 = canonicalJsonHash('reparameterized')
  const baseWordSha256 = canonicalJsonHash('parameterized')
  const productivePrefix = {
    ...PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE_RECEIPT,
  }
  return {
    ...canonicalHyphenDeletionRecord(),
    proof: {
      tier: 'same-document-derived-affix',
      sourceBoundaryProven: true,
      derivedWordSha256,
      productivePrefix,
      baseWordSha256,
      derivationBindingSha256: canonicalJsonHash({
        derivedWordSha256,
        productivePrefix,
        baseWordSha256,
      }),
      pinnedBaseWordValid: true,
      pinnedSplit: {
        leftSha256: canonicalJsonHash('reparameter'),
        rightSha256: canonicalJsonHash('ized'),
        index: 11,
      },
      splitPointValid: true,
      exactSameDocumentBaseWordSha256: baseWordSha256,
      sameDocumentBaseWordValid: true,
      hardHyphenFormSha256: canonicalJsonHash('reparameter-ized'),
      hardHyphenCounterproof: null,
      model: { ...PDF_HYPHEN_LEXICAL_MODEL_RECEIPT },
      evidenceSha256s: [
        ...PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE,
        'language-scope:en-US->en-US',
      ]
        .map(canonicalHyphenEvidenceSha256)
        .sort(),
    },
  }
}

function citationRelationship(overrides = {}) {
  return {
    id: 'citation-private-1',
    status: 'matched',
    taxonomy: 'bracketed-bibliography-citation',
    referenceRegionId: 'region-private-1',
    referenceStart: 4,
    referenceEnd: 7,
    labels: ['private-label-1'],
    targetNodeIds: ['bibliography-private-1'],
    canonicalAnchor: { nodeId: 'paragraph-private-1', start: 4, end: 7 },
    evidence: ['private-citation-evidence'],
    sourceBoxes: [
      {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.1,
        height: 0.02,
        rotation: 0,
        method: 'pdf-text',
      },
    ],
    ...overrides,
  }
}

function crossReferenceRelationship(overrides = {}) {
  return {
    id: 'cross-reference-private-1',
    kind: 'figure',
    text: 'Figure 1',
    labels: ['Figure 1'],
    referenceRegionId: 'region-private-1',
    referenceStart: 4,
    referenceEnd: 12,
    targets: [
      {
        kind: 'figure',
        label: 'Figure 1',
        referenceStart: 11,
        referenceEnd: 12,
        status: 'matched',
        candidateNodeIds: ['figure-private-1'],
        targetNodeId: 'figure-private-1',
        evidence: [
          'explicit-scholarly-cross-reference-syntax',
          'canonical-label-unique',
        ],
      },
    ],
    targetNodeIds: ['figure-private-1'],
    status: 'matched',
    canonicalAnchor: {
      nodeId: 'paragraph-private-1',
      start: 4,
      end: 12,
    },
    confidence: 0.99,
    evidence: [
      'explicit-scholarly-cross-reference-syntax',
      'all-canonical-labels-unique',
    ],
    sourceBoxes: [
      {
        page: 1,
        x: 0.2,
        y: 0.3,
        width: 0.2,
        height: 0.02,
        rotation: 0,
        method: 'pdf-text',
      },
    ],
    ...overrides,
  }
}

function reconstruction(ready = true, ledgerAvailable = true) {
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

function requireReconstructionReview(source, code) {
  source.readiness.ready = false
  source.readiness.status = 'review-required'
  source.readiness.blockingDiagnosticCodes = [code]
  source.diagnostics.push({ severity: 'error', code })
  return source
}

function artifact(target, suffix = '', source = reconstruction()) {
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

function inspectedArtifact(source, content) {
  const bytes = new TextEncoder().encode('inspected semantic artifact')
  return privateFidelity.createPrivateArtifactEvidence(
    {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      profile: { id: 'mobile', version: '1.0.0' },
      mode: 'publication',
    },
    {
      files: {
        'EPUB/content.xhtml': new TextEncoder().encode(content),
      },
      manifest: {
        canonicalNodeIds: source.paper.nodes.map((node) => node.id),
        canonicalContentSha256: createHash('sha256')
          .update(JSON.stringify(source.paper))
          .digest('hex'),
        visualRelationships: source.visualRelationships,
        assets: source.assets,
      },
    },
  )
}

function run(ordinal, source, artifacts, readableFallbackProjection = source) {
  return createPrivateFidelityRunReceipt({
    ordinal,
    reconstruction: source,
    artifacts,
    artifactProjections: {
      'readable-fallback': readableFallbackProjection,
    },
  })
}

function fidelityReceipt({
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

function acceptedBaselineSha256(receipt) {
  return canonicalJsonHash(receipt)
}

function recomputePrivateReconstructionReceiptSha256(runReceipt) {
  const {
    latencyMs: _latencyMs,
    costUsd: _costUsd,
    ...readingOrderEvaluation
  } = runReceipt.reconstruction.completeness.readingOrderEvaluation
  runReceipt.reconstructionReceiptSha256 = canonicalJsonHash({
    ...runReceipt.reconstruction,
    completeness: {
      ...runReceipt.reconstruction.completeness,
      readingOrderEvaluation,
    },
  })
}

function rebuildPrivateFidelityReceipt(receipt) {
  return createPrivateFidelityReceipt({
    paperId: receipt.source.paperId,
    sourceSha256: receipt.source.sha256,
    byteLength: receipt.source.byteLength,
    decisionSetSha256: receipt.decisionSetSha256,
    runs: receipt.runs,
    repeat: receipt.execution.repeat,
    profiles: receipt.execution.profiles,
    epubCheckRequired: receipt.execution.epubCheckRequired,
    baselineComparison: receipt.baselineComparison,
  })
}

function installCanonicalHyphenDeletionLedger(
  receipt,
  recordFactory = canonicalHyphenDeletionRecord,
) {
  const updated = structuredClone(receipt)
  for (const runReceipt of updated.runs) {
    const record = recordFactory()
    const structure = runReceipt.reconstruction.structure
    structure.canonicalHyphenDeletionLedgerAvailable = true
    structure.canonicalHyphenDeletionCount = 1
    structure.canonicalHyphenDeletionContextCounts = {
      'canonical-flow-continuation': 1,
    }
    structure.canonicalHyphenDeletionLedger = [record]
    structure.canonicalHyphenDeletionLedgerSha256 = canonicalJsonHash([record])
    recomputePrivateReconstructionReceiptSha256(runReceipt)
  }
  return rebuildPrivateFidelityReceipt(updated)
}

function forgeCanonicalHyphenDeletionLedger(receipt, mutateRecord) {
  const forged = structuredClone(receipt)
  for (const runReceipt of forged.runs) {
    const structure = runReceipt.reconstruction.structure
    mutateRecord(structure.canonicalHyphenDeletionLedger[0])
    structure.canonicalHyphenDeletionLedgerSha256 = canonicalJsonHash(
      structure.canonicalHyphenDeletionLedger,
    )
    recomputePrivateReconstructionReceiptSha256(runReceipt)
  }
  return rebuildPrivateFidelityReceipt(forged)
}

function historicalV14Receipt(receipt) {
  const historical = structuredClone(receipt)
  for (const runReceipt of historical.runs) {
    runReceipt.reconstruction.structure.schemaVersion = '1.4.0'
    for (const field of [
      'canonicalHyphenDeletionLedgerAvailable',
      'canonicalHyphenDeletionCount',
      'canonicalHyphenDeletionContextCounts',
      'canonicalHyphenDeletionLedger',
      'canonicalHyphenDeletionLedgerSha256',
    ]) {
      delete runReceipt.reconstruction.structure[field]
    }
    recomputePrivateReconstructionReceiptSha256(runReceipt)
  }
  return historical
}

export {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
  homedir, tmpdir, join, resolve, spawnSync, createHash, fileURLToPath,
  describe, expect, it, canonicalHyphenEvidenceSha256, canonicalJsonHash,
  PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE, PDF_HYPHEN_LEXICAL_MODEL_RECEIPT,
  PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE_RECEIPT, PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE,
  applyPrivateDecisionSet, comparePrivateFidelityBaseline, comparePrivateFidelityReceipts,
  createPrivateFidelityReceipt, createPrivateFidelityRunReceipt, createPrivateReconstructionEvidenceRaw,
  parsePrivateFidelityArguments, prepareOwnerOnlyDirectory, writeExclusive, privateFidelity,
  hash, privateCompletenessPolicy, createPrivateReconstructionEvidence, canonicalHyphenDeletionRecord,
  canonicalDerivedAffixHyphenDeletionRecord, citationRelationship, crossReferenceRelationship,
  reconstruction, requireReconstructionReview, artifact, inspectedArtifact, run, fidelityReceipt,
  acceptedBaselineSha256, recomputePrivateReconstructionReceiptSha256, rebuildPrivateFidelityReceipt,
  installCanonicalHyphenDeletionLedger, forgeCanonicalHyphenDeletionLedger, historicalV14Receipt,
}

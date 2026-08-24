import { createHash } from 'node:crypto'
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
  createPrivateReconstructionEvidence as createPrivateReconstructionEvidenceRaw,
  parsePrivateFidelityArguments,
} from './pdf-private-fidelity.mjs'
import * as privateFidelity from './pdf-private-fidelity.mjs'
import {
  acceptedBaselineSha256,
  artifact,
  createPrivateReconstructionEvidence,
  fidelityReceipt,
  hash,
  privateCompletenessPolicy,
  reconstruction,
  run,
} from './pdf-private-fidelity.test-fixtures.mjs'

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

function requireReconstructionReview(source, code) {
  source.readiness.ready = false
  source.readiness.status = 'review-required'
  source.readiness.blockingDiagnosticCodes = [code]
  source.diagnostics.push({ severity: 'error', code })
  return source
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

describe('private PDF fidelity runner', () => {
  it('accepts v1.4 only as a historical baseline and rejects current ledger tampering', () => {
    const current = fidelityReceipt()
    const historical = historicalV14Receipt(current)

    expect(
      comparePrivateFidelityReceipts(
        historical,
        current,
        acceptedBaselineSha256(historical),
      ),
    ).toEqual({ status: 'failed', passed: false })
    expect(() =>
      comparePrivateFidelityReceipts(
        current,
        historical,
        acceptedBaselineSha256(current),
      ),
    ).toThrow('INVALID_PRIVATE_FIDELITY_BASELINE')

    const missingLedger = structuredClone(current)
    delete missingLedger.runs[0].reconstruction.structure
      .canonicalHyphenDeletionLedger
    recomputePrivateReconstructionReceiptSha256(missingLedger.runs[0])
    const tamperedHash = structuredClone(current)
    tamperedHash.runs[0].reconstruction.structure.canonicalHyphenDeletionLedgerSha256 =
      'f'.repeat(64)
    recomputePrivateReconstructionReceiptSha256(tamperedHash.runs[0])
    for (const invalid of [missingLedger, tamperedHash]) {
      expect(() =>
        comparePrivateFidelityReceipts(
          invalid,
          current,
          acceptedBaselineSha256(invalid),
        ),
      ).toThrow('INVALID_PRIVATE_FIDELITY_BASELINE')
    }
  })

  it('rejects coordinated private canonical-hyphen proof tampering after every receipt hash is recomputed', () => {
    const valid = installCanonicalHyphenDeletionLedger(fidelityReceipt())
    expect(
      comparePrivateFidelityReceipts(
        valid,
        valid,
        acceptedBaselineSha256(valid),
      ),
    ).toMatchObject({ status: 'passed', passed: true })

    const joinedDigestMismatch = forgeCanonicalHyphenDeletionLedger(
      valid,
      (record) => {
        record.proof.exactSameDocumentJoinedFormSha256 = 'f'.repeat(64)
      },
    )
    const missingMandatoryEvidence = forgeCanonicalHyphenDeletionLedger(
      valid,
      (record) => {
        record.proof.evidenceSha256s = ['a'.repeat(64)]
      },
    )
    const forbiddenCounterproof = forgeCanonicalHyphenDeletionLedger(
      valid,
      (record) => {
        record.proof.evidenceSha256s.push(
          canonicalHyphenEvidenceSha256('hard-hyphen-form-valid:same-document'),
        )
        record.proof.evidenceSha256s.sort()
      },
    )

    for (const forged of [
      joinedDigestMismatch,
      missingMandatoryEvidence,
      forbiddenCounterproof,
    ]) {
      expect(() =>
        comparePrivateFidelityReceipts(
          forged,
          valid,
          acceptedBaselineSha256(forged),
        ),
      ).toThrow('INVALID_PRIVATE_FIDELITY_BASELINE')
    }
  })

  it('versions and validates derived-affix proof receipts in private fidelity evidence', () => {
    const valid = installCanonicalHyphenDeletionLedger(
      fidelityReceipt(),
      canonicalDerivedAffixHyphenDeletionRecord,
    )
    expect(valid.schemaVersion).toBe('1.9.0')
    expect(
      comparePrivateFidelityReceipts(
        valid,
        valid,
        acceptedBaselineSha256(valid),
      ),
    ).toMatchObject({ status: 'passed', passed: true })

    const wrongPrefix = forgeCanonicalHyphenDeletionLedger(valid, (record) => {
      record.proof.productivePrefix.flag = 'Z'
      record.proof.derivationBindingSha256 = canonicalJsonHash({
        derivedWordSha256: record.proof.derivedWordSha256,
        productivePrefix: record.proof.productivePrefix,
        baseWordSha256: record.proof.baseWordSha256,
      })
    })
    const wrongBase = forgeCanonicalHyphenDeletionLedger(valid, (record) => {
      record.proof.exactSameDocumentBaseWordSha256 = 'f'.repeat(64)
    })
    const prefixBoundary = forgeCanonicalHyphenDeletionLedger(
      valid,
      (record) => {
        record.proof.pinnedSplit.index = 2
      },
    )
    for (const forged of [wrongPrefix, wrongBase, prefixBoundary]) {
      expect(() =>
        comparePrivateFidelityReceipts(
          forged,
          forged,
          acceptedBaselineSha256(forged),
        ),
      ).toThrow('INVALID_PRIVATE_FIDELITY_BASELINE')
    }
  })

  it('records policy and error-diagnostic evidence for derived readiness round trips', () => {
    const ready = createPrivateReconstructionEvidence(reconstruction(true))
    const blocked = createPrivateReconstructionEvidence(reconstruction(false))
    const receipt = fidelityReceipt()

    expect(ready.readiness).toMatchObject({
      policy: privateCompletenessPolicy,
      errorDiagnosticCodes: [],
    })
    expect(blocked.readiness).toMatchObject({
      policy: privateCompletenessPolicy,
      errorDiagnosticCodes: ['INCOMPLETE_TEXT_COVERAGE'],
    })
    expect(
      comparePrivateFidelityReceipts(
        receipt,
        receipt,
        acceptedBaselineSha256(receipt),
      ),
    ).toMatchObject({ status: 'passed', passed: true })
  })

  it('binds readable fallback parity to its strictly validated canonical projection', () => {
    const source = reconstruction(false)
    source.paper.nodes.push(
      {
        id: 'rejected-figure',
        source: 'region-2',
        type: 'figure',
        title: 'Rejected visual',
        relationships: { caption: 'rejected-caption' },
      },
      {
        id: 'rejected-caption',
        source: 'region-2',
        type: 'caption',
        text: 'Figure 1. Rejected visual.',
      },
    )
    const projection = {
      ...source,
      paper: {
        ...source.paper,
        nodes: source.paper.nodes.slice(0, 2),
      },
      visualRelationships: [],
      assets: [],
    }

    const evidence = createPrivateReconstructionEvidence(source, {
      'readable-fallback': projection,
    })

    expect(evidence.artifactParity.publication.canonicalNodeCount).toBe(4)
    expect(evidence.artifactParity['readable-fallback']).toMatchObject({
      canonicalNodeCount: 2,
      canonicalNodeSequenceSha256: canonicalJsonHash([
        'heading-1',
        'paragraph-1',
      ]),
      canonicalContentSha256: createHash('sha256')
        .update(JSON.stringify(projection.paper))
        .digest('hex'),
      relationshipCount: 0,
      assetCount: 0,
    })
  })

  it('binds parity to the exact authoritative readable projection', () => {
    const source = reconstruction(false)
    const relationship = (kind, index) => {
      const suffix = String(index).padStart(3, '0')
      return {
        id: `${kind}-relationship-${suffix}`,
        kind,
        status: 'matched',
        canonicalNodeId: `${kind}-node-${suffix}`,
        captionNodeId: `${kind}-caption-${suffix}`,
        assetIds: [`${kind}-asset-${suffix}`],
      }
    }
    const equations = Array.from({ length: 66 }, (_, index) =>
      relationship('equation', index + 1),
    )
    const figures = Array.from({ length: 65 }, (_, index) =>
      relationship('figure', index + 1),
    )
    source.visualRelationships = [...equations, ...figures]
    source.assets = source.visualRelationships.map((candidate, index) => {
      const bytes = new Uint8Array([index % 256])
      return {
        id: candidate.assetIds[0],
        href: `assets/${candidate.assetIds[0]}.png`,
        mediaType: 'image/png',
        kind: 'raster',
        rendition: 'source-preserved',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes,
        width: 1,
        height: 1,
        resolutionDpi: null,
        sourceObjectIds: [],
        sourceBoxes: [],
      }
    })

    const projectedRelationships = [...equations, ...figures.slice(0, 64)]
    const projectedAssetIds = new Set(
      projectedRelationships.flatMap((candidate) => candidate.assetIds),
    )
    const projection = {
      ...source,
      visualRelationships: projectedRelationships,
      assets: source.assets.filter((asset) => projectedAssetIds.has(asset.id)),
    }
    const parity = createPrivateReconstructionEvidence(source, {
      'readable-fallback': projection,
    }).artifactParity['readable-fallback']

    expect(parity.relationshipCount).toBe(66 + 64)
    expect(parity.assetCount).toBe(66 + 64)
  })

  it('refuses to synthesize readable fallback parity without an authoritative projection', () => {
    expect(() =>
      createPrivateReconstructionEvidenceRaw(reconstruction()),
    ).toThrow('READABLE_FALLBACK_PROJECTION_REQUIRED')
  })

  it('binds one canonical citation range to every rendered bibliography target', () => {
    const source = reconstruction()
    source.paper.nodes[1] = {
      ...source.paper.nodes[1],
      text: 'See [1–3] now.',
      inlineRuns: [
        {
          start: 4,
          end: 9,
          semanticRole: 'citation',
          relationshipId: 'citation-range',
          targetIds: ['bibliography-1', 'bibliography-2', 'bibliography-3'],
        },
      ],
    }
    const artifactEvidence = inspectedArtifact(
      source,
      '<h1 data-canonical-id="heading-1">Synthetic paper</h1><p data-canonical-id="paragraph-1">See <span id="citation-range" data-semantic-role="citation" data-relationship-id="citation-range" data-target-ids="bibliography-1 bibliography-2 bibliography-3" epub:type="biblioref"><a href="#bibliography-1" epub:type="biblioref">[1–3]</a><a href="#bibliography-2" epub:type="biblioref" class="additional-biblioref"></a><a href="#bibliography-3" epub:type="biblioref" class="additional-biblioref"></a></span> now.</p>',
    )
    const reconstructionEvidence = createPrivateReconstructionEvidence(source)

    expect(reconstructionEvidence.inlineSemanticLedger).toMatchObject({
      semanticRangeCount: 1,
      relationshipCount: 1,
      relationshipTargetCount: 3,
    })
    expect(artifactEvidence.inlineSemanticLedger).toEqual(
      reconstructionEvidence.inlineSemanticLedger,
    )

    const receipt = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs: [1, 2].map((ordinal) => run(ordinal, source, [artifactEvidence])),
      repeat: 2,
      profiles: ['mobile'],
    })
    expect(receipt.execution.profileResults[0].structurallyValid).toBe(true)
  })

  it('binds a single rendered scholarly cross-reference to its canonical target', () => {
    const source = reconstruction()
    source.paper.nodes[1] = {
      ...source.paper.nodes[1],
      text: 'See Table II now.',
      inlineRuns: [
        {
          start: 4,
          end: 12,
          semanticRole: 'cross-reference',
          relationshipId: 'cross-reference-table-ii',
          targetIds: ['table-ii'],
        },
      ],
    }
    const artifactEvidence = inspectedArtifact(
      source,
      '<h1 data-canonical-id="heading-1">Synthetic paper</h1><p data-canonical-id="paragraph-1">See <a id="cross-reference-table-ii" href="#table-ii" data-semantic-role="cross-reference" data-relationship-id="cross-reference-table-ii" data-target-ids="table-ii">Table II</a> now.</p>',
    )
    const reconstructionEvidence = createPrivateReconstructionEvidence(source)

    expect(reconstructionEvidence.inlineSemanticLedger).toMatchObject({
      semanticRangeCount: 1,
      relationshipCount: 1,
      relationshipTargetCount: 1,
    })
    expect(artifactEvidence.inlineSemanticLedger).toEqual(
      reconstructionEvidence.inlineSemanticLedger,
    )
  })

  it('normalizes overlapping inline markup into canonical semantic ranges', () => {
    const source = reconstruction()
    source.paper.nodes[1] = {
      ...source.paper.nodes[1],
      text: 'abcdefghijklmno',
      inlineRuns: [
        { start: 0, end: 10, bold: true },
        { start: 5, end: 15, italic: true },
      ],
    }
    const artifactEvidence = inspectedArtifact(
      source,
      '<h1 data-canonical-id="heading-1">Synthetic paper</h1><p data-canonical-id="paragraph-1"><strong>abcde</strong><em><strong>fghij</strong></em><em>klmno</em></p>',
    )
    const reconstructionEvidence = createPrivateReconstructionEvidence(source)

    expect(reconstructionEvidence.inlineSemanticLedger).toMatchObject({
      semanticRangeCount: 2,
      relationshipCount: 0,
      relationshipTargetCount: 0,
    })
    expect(artifactEvidence.inlineSemanticLedger).toEqual(
      reconstructionEvidence.inlineSemanticLedger,
    )

    const receipt = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs: [1, 2].map((ordinal) => run(ordinal, source, [artifactEvidence])),
      repeat: 2,
      profiles: ['mobile'],
    })
    expect(receipt.execution.profileResults[0].structurallyValid).toBe(true)
  })

  it('excludes visible noncanonical prefixes from semantic range offsets', () => {
    const source = reconstruction()
    source.paper.nodes[1] = {
      ...source.paper.nodes[1],
      text: 'Caption evidence.',
      inlineRuns: [{ start: 0, end: 7, bold: true }],
    }
    const artifactEvidence = inspectedArtifact(
      source,
      '<h1 data-canonical-id="heading-1">Synthetic paper</h1><aside data-canonical-id="paragraph-1"><p data-semantic-ledger-ignore="true">Review required.</p><p><strong>Caption</strong> evidence.</p></aside>',
    )
    const reconstructionEvidence = createPrivateReconstructionEvidence(source)

    expect(artifactEvidence.inlineSemanticLedger).toEqual(
      reconstructionEvidence.inlineSemanticLedger,
    )
  })

  it('normalizes a bare-host external link before comparing rendered semantics', () => {
    const source = reconstruction()
    source.paper.nodes[1] = {
      ...source.paper.nodes[1],
      text: 'example',
      inlineRuns: [{ start: 0, end: 7, href: 'https://example.test' }],
    }
    const artifactEvidence = inspectedArtifact(
      source,
      '<h1 data-canonical-id="heading-1">Synthetic paper</h1><p data-canonical-id="paragraph-1"><a href="https://example.test/">example</a></p>',
    )
    const reconstructionEvidence = createPrivateReconstructionEvidence(source)

    expect(artifactEvidence.inlineSemanticLedger).toEqual(
      reconstructionEvidence.inlineSemanticLedger,
    )
  })

  it('rejects a rendered citation target tampered without changing raw tag counts', () => {
    const source = reconstruction()
    source.paper.nodes[1] = {
      ...source.paper.nodes[1],
      text: 'See [1].',
      inlineRuns: [
        {
          start: 4,
          end: 7,
          semanticRole: 'citation',
          relationshipId: 'citation-1',
          targetIds: ['bibliography-1'],
        },
      ],
    }
    const artifactEvidence = inspectedArtifact(
      source,
      '<h1 data-canonical-id="heading-1">Synthetic paper</h1><p data-canonical-id="paragraph-1">See <a id="citation-1" href="#bibliography-9" epub:type="biblioref" data-relationship-id="citation-1">[1]</a>.</p>',
    )
    const reconstructionEvidence = createPrivateReconstructionEvidence(source)

    expect(artifactEvidence.inlineSemanticLedger).not.toEqual(
      reconstructionEvidence.inlineSemanticLedger,
    )

    const receipt = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs: [1, 2].map((ordinal) => run(ordinal, source, [artifactEvidence])),
      repeat: 2,
      profiles: ['mobile'],
    })
    expect(receipt.execution.profileResults[0].structurallyValid).toBe(false)
  })

  it('records opaque canonical and rendered inline semantic ledgers without source text', () => {
    const source = reconstruction()
    source.paper.nodes[1] = {
      ...source.paper.nodes[1],
      text: 'Synthetic inline evidence.',
      inlineRuns: [
        { start: 0, end: 9, italic: true },
        { start: 10, end: 16, verticalAlign: 'superscript' },
        { start: 17, end: 25, verticalAlign: 'subscript' },
        {
          start: 10,
          end: 25,
          href: 'https://example.test/evidence',
        },
      ],
    }
    const reconstructionEvidence = createPrivateReconstructionEvidence(source)
    expect(reconstructionEvidence.inlineSemanticLedger).toMatchObject({
      nodeCount: 1,
      semanticRangeCount: 4,
      relationshipCount: 1,
      relationshipTargetCount: 1,
    })

    const createArtifactEvidence = privateFidelity.createPrivateArtifactEvidence
    expect(createArtifactEvidence).toEqual(expect.any(Function))
    if (typeof createArtifactEvidence !== 'function') return
    const bytes = new TextEncoder().encode('synthetic epub bytes')
    const content = new TextEncoder().encode(
      '<p data-canonical-id="paragraph-1"><em>Synthetic</em> <a href="https://example.test/evidence"><sup>inline</sup> <sub>evidence</sub></a>.</p>',
    )
    const artifactEvidence = createArtifactEvidence(
      {
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        profile: { id: 'mobile', version: '1.0.0' },
        mode: 'publication',
      },
      {
        files: { 'EPUB/content.xhtml': content },
        manifest: {
          canonicalNodeIds: ['paragraph-1'],
          canonicalContentSha256: '9'.repeat(64),
          visualRelationships: [],
          assets: [],
        },
      },
    )
    expect(artifactEvidence.inlineSemanticLedger).toEqual(
      reconstructionEvidence.inlineSemanticLedger,
    )
    expect(artifactEvidence.canonicalContentSha256).toBe('9'.repeat(64))
    expect(
      JSON.stringify({ reconstructionEvidence, artifactEvidence }),
    ).not.toContain('Synthetic inline evidence.')
  })

  it('maps packaged relationship assets back to reconstruction asset sets', () => {
    const source = reconstruction()
    source.visualRelationships = [
      {
        id: 'relationship-1',
        kind: 'figure',
        status: 'matched',
        canonicalNodeId: 'paragraph-1',
        captionRegionId: null,
        sourceRegionIds: ['region-2'],
        sourceObjectIds: ['object-1'],
        assetIds: ['source-asset'],
        sourceBoxes: [],
        altTextSource: 'source-text',
      },
    ]
    source.assets = [
      {
        id: 'source-asset',
        kind: 'raster',
        mediaType: 'image/png',
        rendition: 'source-preserved',
        sha256: '8'.repeat(64),
        width: 10,
        height: 10,
        sourceBoxes: [],
      },
    ]
    const bytes = new TextEncoder().encode('synthetic packaged epub')
    const createArtifactEvidence = privateFidelity.createPrivateArtifactEvidence
    const artifactEvidence = createArtifactEvidence(
      {
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        profile: { id: 'mobile', version: '1.0.0' },
        mode: 'publication',
      },
      {
        files: {
          'EPUB/content.xhtml': new TextEncoder().encode(
            '<p data-canonical-id="heading-1"></p><p data-canonical-id="paragraph-1"></p>',
          ),
        },
        manifest: {
          canonicalNodeIds: source.paper.nodes.map((node) => node.id),
          canonicalContentSha256: createHash('sha256')
            .update(JSON.stringify(source.paper))
            .digest('hex'),
          visualRelationships: [
            {
              ...source.visualRelationships[0],
              assetIds: ['packaged-asset'],
            },
          ],
          assets: [{ id: 'packaged-asset', sourceAssetId: 'source-asset' }],
        },
      },
    )
    const runs = [1, 2].map((ordinal) =>
      run(ordinal, source, [artifactEvidence]),
    )
    const receipt = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs,
      repeat: 2,
      profiles: ['mobile'],
      baselineComparison: {
        status: 'passed',
        passed: true,
        receiptSha256: 'f'.repeat(64),
      },
    })

    expect(receipt.execution.profileResults[0]).toMatchObject({
      structurallyValid: true,
      deterministic: true,
    })
    expect(receipt.passed).toBe(true)
  })

  it('binds visual semantics and source lineage consistently across private parity receipts', () => {
    const relationship = {
      id: 'relationship-1',
      kind: 'table',
      semanticKind: 'source-code',
      status: 'matched',
      canonicalNodeId: 'paragraph-1',
      preformatted: {
        status: 'ordered-lines',
        evidence: ['monospaced-source-lines'],
        lines: [
          {
            text: 'PRIVATE source code',
            sourceRegionId: 'region-2',
            sourceLineId: 'line-3',
            sourceBox: {
              page: 1,
              x: 0.1,
              y: 0.2,
              width: 0.3,
              height: 0.04,
              rotation: 0,
              method: 'pdf-text',
            },
            sourceRunBoxes: [],
          },
        ],
      },
    }
    const evidenceFor = (
      sourceLineIds,
      preformatted = relationship.preformatted,
    ) => {
      const source = reconstruction()
      source.visualRelationships = [
        sourceLineIds === undefined
          ? relationship
          : { ...relationship, sourceLineIds, preformatted },
      ]
      return createPrivateReconstructionEvidence(source)
    }
    const receipt = evidenceFor(['line-1', 'line-2'])
    const changed = evidenceFor(['line-1'])
    const changedPreformatted = evidenceFor(['line-1', 'line-2'], {
      ...relationship.preformatted,
      lines: [
        {
          ...relationship.preformatted.lines[0],
          text: 'PRIVATE changed source code',
        },
      ],
    })

    expect(receipt.artifactParity.publication.relationshipGraphSha256).toBe(
      receipt.structure.visualRelationshipGraphSha256,
    )
    expect(changed.artifactParity.publication.relationshipGraphSha256).not.toBe(
      receipt.artifactParity.publication.relationshipGraphSha256,
    )
    expect(canonicalJsonHash(changed.structure)).not.toBe(
      canonicalJsonHash(receipt.structure),
    )
    expect(
      changedPreformatted.artifactParity.publication.relationshipGraphSha256,
    ).not.toBe(receipt.artifactParity.publication.relationshipGraphSha256)
    expect(
      changedPreformatted.artifactParity.publication.relationshipGraphSha256,
    ).toBe(changedPreformatted.structure.visualRelationshipGraphSha256)
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE source code')
    expect(
      evidenceFor().artifactParity.publication.relationshipGraphSha256,
    ).toBe(evidenceFor([]).artifactParity.publication.relationshipGraphSha256)
  })

  it('binds an equation transcript and adjudication by digest without exposing the transcript', () => {
    const evidenceFor = (sourceText, transcriptSha256 = 'b'.repeat(64)) => {
      const source = reconstruction()
      source.visualRelationships = [
        {
          id: 'equation-relationship-1',
          kind: 'equation',
          status: 'matched',
          canonicalNodeId: 'paragraph-1',
          sourceText,
          equationTranscriptAdjudication: {
            schemaVersion: '1.0.0',
            format: 'latex',
            source: 'owner-local-adjudication',
            transcriptSha256,
            relationshipFingerprintSha256: 'c'.repeat(64),
            sourceCropAssetId: 'source-asset',
            sourceCropAssetSha256: 'd'.repeat(64),
          },
        },
      ]
      return createPrivateReconstructionEvidence(source)
    }
    const receipt = evidenceFor('PRIVATE synthetic equation transcript')
    const changedText = evidenceFor('PRIVATE changed equation transcript')
    const changedAdjudication = evidenceFor(
      'PRIVATE synthetic equation transcript',
      'e'.repeat(64),
    )

    expect(receipt.artifactParity.publication.relationshipGraphSha256).toBe(
      receipt.structure.visualRelationshipGraphSha256,
    )
    expect(
      changedText.artifactParity.publication.relationshipGraphSha256,
    ).not.toBe(receipt.artifactParity.publication.relationshipGraphSha256)
    expect(
      changedAdjudication.artifactParity.publication.relationshipGraphSha256,
    ).not.toBe(receipt.artifactParity.publication.relationshipGraphSha256)
    expect(JSON.stringify(receipt)).not.toContain(
      'PRIVATE synthetic equation transcript',
    )
  })

  it('binds review-required readable fallback artifacts to their exported semantic subset', () => {
    const source = reconstruction(false)
    source.paper.nodes[1] = {
      ...source.paper.nodes[1],
      inlineRuns: [
        {
          start: 0,
          end: 9,
          bold: true,
          href: 'https://example.test/resource',
        },
        {
          start: 10,
          end: 14,
          semanticRole: 'citation',
          relationshipId: 'citation-1',
          targetIds: ['bibliography-1'],
        },
      ],
    }
    source.visualRelationships = [
      {
        id: 'relationship-matched',
        kind: 'figure',
        status: 'matched',
        canonicalNodeId: 'paragraph-1',
        captionRegionId: null,
        sourceRegionIds: ['region-2'],
        sourceObjectIds: ['object-1'],
        assetIds: ['asset-matched'],
        sourceBoxes: [],
        altTextSource: 'source-text',
      },
      {
        id: 'relationship-unresolved',
        kind: 'table',
        status: 'unresolved',
        canonicalNodeId: null,
        captionRegionId: null,
        sourceRegionIds: ['region-2'],
        sourceObjectIds: ['object-2'],
        assetIds: ['asset-excluded'],
        sourceBoxes: [],
        altTextSource: null,
      },
    ]
    source.assets = [
      {
        id: 'asset-matched',
        kind: 'raster',
        mediaType: 'image/png',
        rendition: 'source-preserved',
        sha256: '7'.repeat(64),
        width: 10,
        height: 10,
        sourceBoxes: [],
        bytes: new Uint8Array([1]),
      },
      {
        id: 'asset-excluded',
        kind: 'table',
        mediaType: 'image/png',
        rendition: 'source-preserved',
        sha256: '8'.repeat(64),
        width: 10,
        height: 10,
        sourceBoxes: [],
        bytes: new Uint8Array([2]),
      },
    ]
    const content = new TextEncoder().encode(
      '<h1 data-canonical-id="heading-1">Synthetic paper</h1><p data-canonical-id="paragraph-1"><a href="https://example.test/resource"><strong>Synthetic</strong></a> <a id="citation-1" href="#bibliography-1" epub:type="biblioref" data-relationship-id="citation-1">body</a>.</p>',
    )
    const bytes = new TextEncoder().encode('readable fallback epub')
    const manifestBase = {
      canonicalNodeIds: source.paper.nodes.map((node) => node.id),
      canonicalContentSha256: createHash('sha256')
        .update(JSON.stringify(source.paper))
        .digest('hex'),
    }
    const createArtifact = (includeExcluded) =>
      privateFidelity.createPrivateArtifactEvidence(
        {
          bytes,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          profile: { id: 'mobile', version: '1.0.0' },
          mode: 'readable-fallback',
        },
        {
          files: { 'EPUB/content.xhtml': content },
          manifest: {
            ...manifestBase,
            visualRelationships: source.visualRelationships
              .filter(
                (relationship) =>
                  includeExcluded || relationship.status === 'matched',
              )
              .map((relationship) => ({
                ...relationship,
                assetIds: relationship.assetIds.map(
                  (assetId) => `packaged-${assetId}`,
                ),
              })),
            assets: source.assets
              .filter(
                (asset) => includeExcluded || asset.id === 'asset-matched',
              )
              .map((asset) => ({
                id: `packaged-${asset.id}`,
                sourceAssetId: asset.id,
              })),
          },
        },
      )

    const fallbackArtifact = createArtifact(false)
    const fallbackProjection = {
      ...source,
      visualRelationships: source.visualRelationships.filter(
        (relationship) => relationship.status === 'matched',
      ),
      assets: source.assets.filter((asset) => asset.id === 'asset-matched'),
    }
    expect(fallbackArtifact.inlineSemanticLedger).toMatchObject({
      nodeCount: 1,
      semanticRangeCount: 3,
      relationshipCount: 2,
      relationshipTargetCount: 2,
    })
    const validReceipt = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs: [1, 2].map((ordinal) =>
        run(ordinal, source, [fallbackArtifact], fallbackProjection),
      ),
      repeat: 2,
      profiles: ['mobile'],
    })
    expect(validReceipt.execution.profileResults[0]).toMatchObject({
      structurallyValid: true,
      deterministic: true,
    })

    const overinclusiveArtifact = createArtifact(true)
    const invalidReceipt = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs: [1, 2].map((ordinal) =>
        run(ordinal, source, [overinclusiveArtifact], fallbackProjection),
      ),
      repeat: 2,
      profiles: ['mobile'],
    })
    expect(invalidReceipt.execution.profileResults[0].structurallyValid).toBe(
      false,
    )

    const coordinatedRuns = [1, 2].map((ordinal) => {
      const candidate = run(
        ordinal,
        source,
        [overinclusiveArtifact],
        fallbackProjection,
      )
      const fallbackParity =
        candidate.reconstruction.artifactParity['readable-fallback']
      for (const key of [
        'relationshipCount',
        'relationshipGraphSha256',
        'assetCount',
        'assetManifestSha256',
      ]) {
        fallbackParity[key] = overinclusiveArtifact[key]
      }
      candidate.reconstructionReceiptSha256 = canonicalJsonHash(
        candidate.reconstruction,
      )
      return candidate
    })
    const coordinatedReceipt = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs: coordinatedRuns,
      repeat: 2,
      profiles: ['mobile'],
    })
    expect(
      coordinatedReceipt.execution.profileResults[0].structurallyValid,
    ).toBe(false)
  })

  it('requires an explicit hash, size, external output, profiles, and repeat', () => {
    const arguments_ = [
      '--input-env',
      'SRT_PRIVATE_TEST_PDF',
      '--paper-id',
      'paper-v1',
      '--expected-size',
      '123',
      '--expected-sha256',
      hash,
      '--profiles',
      'mobile,paperProMove,paperPro',
      '--repeat',
      '2',
      '--out',
      '/tmp/private-proof',
      '--require-epubcheck',
    ]
    const parsed = parsePrivateFidelityArguments(arguments_, {
      SRT_PRIVATE_TEST_PDF: '/private/input.pdf',
    })
    expect(parsed).toMatchObject({
      paperId: 'paper-v1',
      expectedSize: 123,
      expectedSha256: hash,
      profiles: ['mobile', 'paperProMove', 'paperPro'],
      repeat: 2,
      requireEpubCheck: true,
    })
    expect(() =>
      parsePrivateFidelityArguments([
        '--input',
        '/private/input.pdf',
        '--paper-id',
        'paper-v1',
      ]),
    ).toThrow()
  })

  it('reads the private source path from exactly one named environment variable', () => {
    const privatePath = '/private/operator-staged/input.pdf'
    const arguments_ = [
      '--input-env',
      'SRT_PRIVATE_TEST_PDF',
      '--paper-id',
      'paper-v1',
      '--expected-size',
      '123',
      '--expected-sha256',
      hash,
      '--profiles',
      'mobile,paperProMove,paperPro',
      '--repeat',
      '2',
      '--out',
      '/tmp/private-proof',
    ]
    const parsed = parsePrivateFidelityArguments(arguments_, {
      SRT_PRIVATE_TEST_PDF: privatePath,
    })

    expect(parsed.input).toBe(privatePath)
    expect(() =>
      parsePrivateFidelityArguments(['--input', privatePath, ...arguments_], {
        SRT_PRIVATE_TEST_PDF: privatePath,
      }),
    ).toThrow()
    expect(() => parsePrivateFidelityArguments(arguments_, {})).toThrow()
    expect(() =>
      parsePrivateFidelityArguments(
        arguments_.toSpliced(1, 1, 'INVALID-NAME'),
        { 'INVALID-NAME': privatePath },
      ),
    ).toThrow()
  })

  it('accepts only a hash-pinned environment-sourced decision sidecar', () => {
    const privatePath = '/private/operator-staged/input.pdf'
    const decisionPath = '/private/operator-staged/decisions.json'
    const baseArguments = [
      '--input-env',
      'SRT_PRIVATE_TEST_PDF',
      '--paper-id',
      'paper-v1',
      '--expected-size',
      '123',
      '--expected-sha256',
      hash,
      '--profiles',
      'mobile',
      '--repeat',
      '2',
      '--out',
      '/tmp/private-proof',
    ]
    const decisionArguments = [
      '--decisions-env',
      'SRT_PRIVATE_TEST_DECISIONS',
      '--expected-decisions-sha256',
      'f'.repeat(64),
    ]
    const environment = {
      SRT_PRIVATE_TEST_PDF: privatePath,
      SRT_PRIVATE_TEST_DECISIONS: decisionPath,
    }

    expect(
      parsePrivateFidelityArguments(
        [...baseArguments, ...decisionArguments],
        environment,
      ),
    ).toMatchObject({
      decisions: decisionPath,
      expectedDecisionsSha256: 'f'.repeat(64),
    })
    for (const incomplete of [
      decisionArguments.slice(0, 2),
      decisionArguments.slice(2),
    ]) {
      expect(() =>
        parsePrivateFidelityArguments(
          [...baseArguments, ...incomplete],
          environment,
        ),
      ).toThrow('INVALID_USAGE')
    }
    expect(() =>
      parsePrivateFidelityArguments([...baseArguments, ...decisionArguments], {
        SRT_PRIVATE_TEST_PDF: privatePath,
      }),
    ).toThrow('INVALID_USAGE')
  })

  it('fails closed unless every pinned private decision applies without staleness', () => {
    const decisionFile = {
      schemaVersion: '1.1.0',
      documentSha256: hash,
      decisions: [{ id: 'decision-1' }, { id: 'decision-2' }],
    }
    const applied = applyPrivateDecisionSet(
      { source: { sha256: hash } },
      decisionFile,
      () => ({
        source: { sha256: hash },
        humanAdjudications: {
          applied: [...decisionFile.decisions],
          stale: [],
        },
      }),
    )
    expect(applied.humanAdjudications.applied).toHaveLength(2)

    expect(() =>
      applyPrivateDecisionSet(
        { source: { sha256: hash } },
        decisionFile,
        () => ({
          humanAdjudications: {
            applied: [decisionFile.decisions[0]],
            stale: [decisionFile.decisions[1]],
          },
        }),
      ),
    ).toThrow('PRIVATE_DECISION_SET_STALE')
  })

  it('accepts one externally pinned frozen baseline without adding its path to receipts', () => {
    const privatePath = '/private/operator-staged/input.pdf'
    const baselinePath = '/external/operator-only/frozen-receipt.json'
    const parsed = parsePrivateFidelityArguments(
      [
        '--input-env',
        'SRT_PRIVATE_TEST_PDF',
        '--paper-id',
        'paper-v1',
        '--expected-size',
        '123',
        '--expected-sha256',
        hash,
        '--profiles',
        'mobile',
        '--repeat',
        '2',
        '--out',
        '/tmp/private-proof',
        '--baseline',
        baselinePath,
        '--expected-baseline-sha256',
        'f'.repeat(64),
      ],
      { SRT_PRIVATE_TEST_PDF: privatePath },
    )

    expect(parsed.baseline).toBe(baselinePath)
    expect(parsed.expectedBaselineSha256).toBe('f'.repeat(64))
    expect(JSON.stringify(fidelityReceipt())).not.toContain(baselinePath)
    expect(() =>
      parsePrivateFidelityArguments(
        [
          '--input-env',
          'SRT_PRIVATE_TEST_PDF',
          '--paper-id',
          'paper-v1',
          '--expected-size',
          '123',
          '--expected-sha256',
          hash,
          '--profiles',
          'mobile',
          '--repeat',
          '2',
          '--out',
          '/tmp/private-proof',
          '--baseline',
          baselinePath,
          '--expected-baseline-sha256',
          'f'.repeat(64),
          '--baseline',
          baselinePath,
        ],
        { SRT_PRIVATE_TEST_PDF: privatePath },
      ),
    ).toThrow('INVALID_USAGE')

    for (const incomplete of [
      ['--baseline', baselinePath],
      ['--expected-baseline-sha256', 'f'.repeat(64)],
    ]) {
      expect(() =>
        parsePrivateFidelityArguments(
          [
            '--input-env',
            'SRT_PRIVATE_TEST_PDF',
            '--paper-id',
            'paper-v1',
            '--expected-size',
            '123',
            '--expected-sha256',
            hash,
            '--profiles',
            'mobile',
            '--repeat',
            '2',
            '--out',
            '/tmp/private-proof',
            ...incomplete,
          ],
          { SRT_PRIVATE_TEST_PDF: privatePath },
        ),
      ).toThrow('INVALID_USAGE')
    }
  })

  it('passes only ready byte-identical reconstruction and profile repetitions with an accepted baseline', () => {
    const profiles = ['mobile', 'paperProMove', 'paperPro']
    const runs = [1, 2].map((ordinal) =>
      run(
        ordinal,
        reconstruction(),
        profiles.map((profile) => artifact(profile)),
      ),
    )
    const receipt = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs,
      repeat: 2,
      profiles,
      baselineComparison: {
        status: 'passed',
        passed: true,
        receiptSha256: 'f'.repeat(64),
      },
    })
    expect(receipt.execution).toMatchObject({
      reconstructionDeterministic: true,
      artifactsDeterministic: true,
      allReady: true,
      lineTransitionGatePassed: true,
      localValidationPassed: true,
    })
    expect(receipt.passed).toBe(true)
    const serialized = JSON.stringify(receipt)
    expect(serialized).not.toContain('/private/input.pdf')
    expect(serialized).not.toContain('/private/operator-staged/input.pdf')
    expect(serialized).not.toContain('SRT_PRIVATE_TEST_PDF')
  })

  it('requires six passing EPUBCheck results for a required three-profile repeat', () => {
    const profiles = ['mobile', 'paperProMove', 'paperPro']
    const checkedRuns = [1, 2].map((ordinal) =>
      run(
        ordinal,
        reconstruction(),
        profiles.map((profile) => {
          const { receiptSha256: _receiptSha256, ...evidence } =
            artifact(profile)
          const checkedEvidence = {
            ...evidence,
            epubCheck: { status: 'passed' },
          }
          return {
            ...checkedEvidence,
            receiptSha256: canonicalJsonHash(checkedEvidence),
          }
        }),
      ),
    )
    const checked = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs: checkedRuns,
      repeat: 2,
      profiles,
      epubCheckRequired: true,
    })

    expect(checked.schemaVersion).toBe('1.9.0')
    expect(checked.execution).toMatchObject({
      epubCheckRequired: true,
      epubCheckPassedCount: 6,
      allEpubCheckPassed: true,
      localValidationPassed: true,
    })
    expect(
      checked.runs.flatMap((candidate) => candidate.artifacts),
    ).toHaveLength(6)
    expect(
      checked.runs
        .flatMap((candidate) => candidate.artifacts)
        .every((candidate) => candidate.epubCheck.status === 'passed'),
    ).toBe(true)

    const unchecked = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs: [1, 2].map((ordinal) =>
        run(
          ordinal,
          reconstruction(),
          profiles.map((profile) => artifact(profile)),
        ),
      ),
      repeat: 2,
      profiles,
      epubCheckRequired: true,
    })
    expect(unchecked.execution).toMatchObject({
      epubCheckRequired: true,
      epubCheckPassedCount: 0,
      allEpubCheckPassed: false,
      localValidationPassed: false,
    })
  })

  it('accepts strict structural boundaries while preserving their separate count', () => {
    const profiles = ['mobile']
    const runs = [1, 2].map((ordinal) => {
      const source = reconstruction()
      source.lineBoundaryDecisions[0].outcome = 'structural-boundary'
      source.structurallyConsumedLineBoundaryCount = 1
      source.completeness.structurallyConsumedLineBoundaryCount = 1
      return run(ordinal, source, [artifact('mobile', '', source)])
    })
    const receipt = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs,
      repeat: 2,
      profiles,
    })

    expect(receipt.execution).toMatchObject({
      lineTransitionGatePassed: true,
      localValidationPassed: true,
    })
    expect(receipt.runs[0].reconstruction).toMatchObject({
      completeness: {
        unresolvedCorruptingJoinCount: 0,
        structurallyConsumedLineBoundaryCount: 1,
      },
      lineTransitionEvidence: {
        decisions: [{ outcome: 'structural-boundary' }],
      },
      structure: {
        unresolvedCorruptingJoinCount: 0,
        structurallyConsumedLineBoundaryCount: 1,
      },
    })
  })

  it('rejects structural-boundary count mismatches and impossible raw totals', () => {
    const completenessMismatch = reconstruction()
    const reportedMismatch = reconstruction()
    const impossibleRawTotal = reconstruction()
    for (const source of [
      completenessMismatch,
      reportedMismatch,
      impossibleRawTotal,
    ]) {
      source.lineBoundaryDecisions[0].outcome = 'structural-boundary'
    }
    completenessMismatch.structurallyConsumedLineBoundaryCount = 1
    completenessMismatch.completeness.structurallyConsumedLineBoundaryCount = 0
    reportedMismatch.structurallyConsumedLineBoundaryCount = 0
    reportedMismatch.completeness.structurallyConsumedLineBoundaryCount = 1
    impossibleRawTotal.structurallyConsumedLineBoundaryCount = 1
    impossibleRawTotal.completeness.structurallyConsumedLineBoundaryCount = 1
    impossibleRawTotal.completeness.unresolvedCorruptingJoinCount = 1

    for (const source of [completenessMismatch, impossibleRawTotal]) {
      const receipt = createPrivateFidelityReceipt({
        paperId: 'paper-v1',
        sourceSha256: hash,
        byteLength: 123,
        runs: [1, 2].map((ordinal) =>
          run(ordinal, source, [artifact('mobile', '', source)]),
        ),
        repeat: 2,
        profiles: ['mobile'],
      })
      expect(receipt.execution.lineTransitionGatePassed).toBe(false)
      expect(receipt.execution.localValidationPassed).toBe(false)
    }
    expect(() => artifact('mobile', '', reportedMismatch)).toThrow(
      'Line transition counts do not match the decision ledger.',
    )
  })

  it('fails for review-required or ledger-free reconstruction and changed repeat artifacts', () => {
    const profiles = ['mobile']
    const changed = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs: [
        run(1, reconstruction(), [artifact('mobile')]),
        run(2, reconstruction(), [artifact('mobile', 'f')]),
      ],
      repeat: 2,
      profiles,
    })
    const blocked = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs: [1, 2].map((ordinal) =>
        run(ordinal, reconstruction(false), [artifact('mobile')]),
      ),
      repeat: 2,
      profiles,
    })
    const missingLedger = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs: [1, 2].map((ordinal) =>
        run(ordinal, reconstruction(true, false), [artifact('mobile')]),
      ),
      repeat: 2,
      profiles,
    })
    expect(changed.execution.artifactsDeterministic).toBe(false)
    expect(changed.passed).toBe(false)
    expect(blocked.execution.reconstructionDeterministic).toBe(true)
    expect(blocked.execution.allReady).toBe(false)
    expect(blocked.passed).toBe(false)
    expect(missingLedger.execution.lineTransitionGatePassed).toBe(false)
    expect(missingLedger.passed).toBe(false)
  })

  it('reports byte-identical artifacts as deterministic without weakening semantic parity', () => {
    const receipt = fidelityReceipt({
      transformArtifact(value) {
        return {
          ...value,
          inlineSemanticLedger: {
            ...value.inlineSemanticLedger,
            semanticRangeCount:
              value.inlineSemanticLedger.semanticRangeCount + 1,
            semanticRangeLedgerSha256: 'f'.repeat(64),
          },
        }
      },
    })

    expect(receipt.runs[0].artifacts[0]).toMatchObject({
      structuralValidation: 'passed',
      receiptSha256: receipt.runs[1].artifacts[0].receiptSha256,
    })
    expect(receipt.execution.profileResults[0]).toMatchObject({
      complete: true,
      structurallyValid: false,
      deterministic: true,
    })
    expect(receipt.execution.artifactsDeterministic).toBe(true)
    expect(receipt.execution.localValidationPassed).toBe(false)
  })

  it('rejects empty, duplicate, non-adjacent, or cross-region transition ledgers', () => {
    function receiptWithTransitionMutation(mutate) {
      const profiles = ['mobile']
      const runs = [1, 2].map((ordinal) => {
        const source = reconstruction()
        mutate(source)
        return run(ordinal, source, [artifact('mobile', '', source)])
      })
      return createPrivateFidelityReceipt({
        paperId: 'paper-v1',
        sourceSha256: hash,
        byteLength: 123,
        runs,
        repeat: 2,
        profiles,
      })
    }

    const empty = receiptWithTransitionMutation((source) => {
      source.lineBoundaryDecisions = []
    })
    const duplicate = receiptWithTransitionMutation((source) => {
      source.regions[0].lines.push({ id: 'line-4' })
      source.lineBoundaryDecisions.push({
        ...source.lineBoundaryDecisions[0],
        id: 'transition-2',
      })
    })
    const nonAdjacent = receiptWithTransitionMutation((source) => {
      source.regions[0].lines.push({ id: 'line-4' })
      source.lineBoundaryDecisions = [
        {
          ...source.lineBoundaryDecisions[0],
          toLineId: 'line-4',
        },
        {
          ...source.lineBoundaryDecisions[0],
          id: 'transition-2',
          fromLineId: 'line-2',
          toLineId: 'line-4',
        },
      ]
    })
    const crossRegion = receiptWithTransitionMutation((source) => {
      source.lineBoundaryDecisions[0].toLineId = 'line-3'
    })

    for (const receipt of [empty, duplicate, nonAdjacent, crossRegion]) {
      expect(receipt.execution.lineTransitionGatePassed).toBe(false)
      expect(receipt.execution.localValidationPassed).toBe(false)
    }
  })

  it('keeps transition topology opaque and rejects artifact parity mismatches', () => {
    const source = reconstruction()
    source.regions[0].id = 'PRIVATE region prose must not escape'
    source.regions[0].lines[0].id = 'PRIVATE first line must not escape'
    source.regions[0].lines[1].id = 'PRIVATE second line must not escape'
    source.lineBoundaryDecisions[0] = {
      ...source.lineBoundaryDecisions[0],
      regionId: source.regions[0].id,
      fromLineId: source.regions[0].lines[0].id,
      toLineId: source.regions[0].lines[1].id,
    }
    const evidence = createPrivateReconstructionEvidence(source)
    const serializedTopology = JSON.stringify(evidence.lineTransitionEvidence)

    expect(serializedTopology).not.toContain('PRIVATE')
    expect(evidence.lineTransitionEvidence.expectedTransitionCount).toBe(1)

    const mismatchKeys = [
      'canonicalNodeSequenceSha256',
      'canonicalContentSha256',
      'relationshipGraphSha256',
      'assetManifestSha256',
    ]
    for (const key of mismatchKeys) {
      const receipt = fidelityReceipt({
        transformArtifact(value) {
          return { ...value, [key]: 'f'.repeat(64) }
        },
      })
      expect(receipt.execution.profileResults[0].structurallyValid).toBe(false)
      expect(receipt.execution.localValidationPassed).toBe(false)
    }

    const inlineMismatch = fidelityReceipt({
      transformArtifact(value) {
        return {
          ...value,
          inlineSemanticLedger: {
            ...value.inlineSemanticLedger,
            semanticRangeLedgerSha256: 'f'.repeat(64),
          },
        }
      },
    })
    expect(inlineMismatch.execution.profileResults[0].structurallyValid).toBe(
      false,
    )
  })

  it('keeps citation topology opaque and binds anchor-only and target-only changes', () => {
    const source = reconstruction()
    source.citationRelationships = [
      citationRelationship({
        id: 'PRIVATE citation relationship',
        referenceRegionId: 'PRIVATE source region',
        labels: ['PRIVATE citation label'],
        targetNodeIds: ['PRIVATE bibliography target'],
        canonicalAnchor: {
          nodeId: 'PRIVATE canonical anchor',
          start: 4,
          end: 7,
        },
      }),
    ]
    const evidence = createPrivateReconstructionEvidence(source)
    const serializedCitationGraph = JSON.stringify(
      evidence.structure.citationRelationshipGraph,
    )
    expect(serializedCitationGraph).not.toContain('PRIVATE')
    expect(serializedCitationGraph).not.toContain('"x"')
    expect(evidence.structure.citationRelationshipGraph[0].sourceBoxes).toEqual(
      [expect.stringMatching(/^[a-f0-9]{64}$/)],
    )
    expect(evidence.structure).toMatchObject({
      schemaVersion: '1.7.0',
      citationRelationshipCount: 1,
      citationRelationshipCounts: { matched: 1 },
      citationRelationshipGraphSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })

    const baseline = fidelityReceipt({
      transformReconstruction(value) {
        value.citationRelationships = [citationRelationship()]
        return value
      },
    })
    for (const relationship of [
      citationRelationship({
        canonicalAnchor: { nodeId: 'paragraph-private-2', start: 4, end: 7 },
      }),
      citationRelationship({ targetNodeIds: ['bibliography-private-2'] }),
    ]) {
      const candidate = fidelityReceipt({
        transformReconstruction(value) {
          value.citationRelationships = [relationship]
          return value
        },
      })
      expect(
        comparePrivateFidelityReceipts(
          baseline,
          candidate,
          acceptedBaselineSha256(baseline),
        ),
      ).toEqual({ status: 'failed', passed: false })
    }
  })

  it('accepts ambiguous citation relationships in private fidelity evidence', () => {
    const baseline = fidelityReceipt({
      transformReconstruction(value) {
        value.citationRelationships = [
          citationRelationship({
            status: 'ambiguous',
            targetNodeIds: [],
            candidateNodeIds: [
              'bibliography-private-1',
              'bibliography-private-2',
            ],
          }),
        ]
        return value
      },
    })

    expect(baseline.runs[0].reconstruction.structure).toMatchObject({
      citationRelationshipCount: 1,
      citationRelationshipCounts: { ambiguous: 1 },
      citationRelationshipGraph: [
        expect.objectContaining({
          candidateNodeIds: [
            expect.stringMatching(/^[a-f0-9]{64}$/),
            expect.stringMatching(/^[a-f0-9]{64}$/),
          ],
          evidenceSha256s: expect.arrayContaining([
            expect.stringMatching(/^[a-f0-9]{64}$/),
          ]),
          targetNodeIds: [],
        }),
      ],
    })
    expect(() =>
      comparePrivateFidelityReceipts(
        baseline,
        structuredClone(baseline),
        acceptedBaselineSha256(baseline),
      ),
    ).not.toThrow()
    const changedCandidates = fidelityReceipt({
      transformReconstruction(value) {
        value.citationRelationships = [
          citationRelationship({
            status: 'ambiguous',
            targetNodeIds: [],
            candidateNodeIds: [
              'bibliography-private-1',
              'bibliography-private-3',
            ],
          }),
        ]
        return value
      },
    })
    const changedEvidence = fidelityReceipt({
      transformReconstruction(value) {
        value.citationRelationships = [
          citationRelationship({
            status: 'ambiguous',
            targetNodeIds: [],
            candidateNodeIds: [
              'bibliography-private-1',
              'bibliography-private-2',
            ],
            evidence: ['private-citation-evidence-changed'],
          }),
        ]
        return value
      },
    })
    expect(
      changedCandidates.runs[0].reconstruction.structure
        .citationRelationshipGraphSha256,
    ).not.toBe(
      baseline.runs[0].reconstruction.structure.citationRelationshipGraphSha256,
    )
    expect(
      changedEvidence.runs[0].reconstruction.structure
        .citationRelationshipGraphSha256,
    ).not.toBe(
      baseline.runs[0].reconstruction.structure.citationRelationshipGraphSha256,
    )
  })

  it('rejects missing or malformed private citation graph evidence', () => {
    const baseline = fidelityReceipt({
      transformReconstruction(value) {
        value.citationRelationships = [citationRelationship()]
        return value
      },
    })
    const missing = structuredClone(baseline)
    delete missing.runs[0].reconstruction.structure.citationRelationshipGraph
    const malformed = structuredClone(baseline)
    malformed.runs[0].reconstruction.structure.citationRelationshipGraph[0].canonicalAnchor =
      { nodeId: '', start: 7, end: 4 }
    for (const staleRelationship of [
      citationRelationship({
        status: 'ambiguous',
        candidateNodeIds: ['bibliography-private-1', 'bibliography-private-2'],
      }),
      citationRelationship({ status: 'unresolved' }),
    ]) {
      expect(() =>
        fidelityReceipt({
          transformReconstruction(value) {
            value.citationRelationships = [staleRelationship]
            return value
          },
        }),
      ).toThrow('Citation relationship receipt state is invalid.')
    }

    for (const invalid of [missing, malformed]) {
      expect(() =>
        comparePrivateFidelityReceipts(
          invalid,
          baseline,
          canonicalJsonHash(invalid),
        ),
      ).toThrow('INVALID_PRIVATE_FIDELITY_BASELINE')
    }
  })

  it('keeps scholarly cross-reference topology opaque and binds anchor-only and target-only changes', () => {
    const source = reconstruction()
    source.crossReferenceRelationships = [
      crossReferenceRelationship({
        id: 'PRIVATE cross-reference relationship',
        text: 'PRIVATE Figure 1',
        labels: ['PRIVATE Figure 1'],
        referenceRegionId: 'PRIVATE source region',
        targets: [
          {
            ...crossReferenceRelationship().targets[0],
            label: 'PRIVATE Figure 1',
            candidateNodeIds: ['PRIVATE figure target'],
            targetNodeId: 'PRIVATE figure target',
          },
        ],
        targetNodeIds: ['PRIVATE figure target'],
        canonicalAnchor: {
          nodeId: 'PRIVATE canonical anchor',
          start: 4,
          end: 12,
        },
      }),
    ]
    const evidence = createPrivateReconstructionEvidence(source)
    const serializedGraph = JSON.stringify(
      evidence.structure.crossReferenceRelationshipGraph,
    )
    expect(serializedGraph).not.toContain('PRIVATE')
    expect(serializedGraph).not.toContain('"x"')
    expect(
      evidence.structure.crossReferenceRelationshipGraph[0].sourceBoxes,
    ).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)])
    expect(evidence.structure).toMatchObject({
      schemaVersion: '1.7.0',
      crossReferenceRelationshipCount: 1,
      crossReferenceRelationshipCounts: { 'figure:matched': 1 },
      crossReferenceRelationshipGraphSha256:
        expect.stringMatching(/^[a-f0-9]{64}$/),
    })

    const baseline = fidelityReceipt({
      transformReconstruction(value) {
        value.crossReferenceRelationships = [crossReferenceRelationship()]
        return value
      },
    })
    for (const relationship of [
      crossReferenceRelationship({
        canonicalAnchor: {
          nodeId: 'paragraph-private-2',
          start: 4,
          end: 12,
        },
      }),
      crossReferenceRelationship({
        targets: [
          {
            ...crossReferenceRelationship().targets[0],
            candidateNodeIds: ['figure-private-2'],
            targetNodeId: 'figure-private-2',
          },
        ],
        targetNodeIds: ['figure-private-2'],
      }),
    ]) {
      const candidate = fidelityReceipt({
        transformReconstruction(value) {
          value.crossReferenceRelationships = [relationship]
          return value
        },
      })
      expect(
        comparePrivateFidelityReceipts(
          baseline,
          candidate,
          acceptedBaselineSha256(baseline),
        ),
      ).toEqual({ status: 'failed', passed: false })
    }
  })

  it('rejects missing or malformed private scholarly cross-reference graph evidence', () => {
    const baseline = fidelityReceipt({
      transformReconstruction(value) {
        value.crossReferenceRelationships = [crossReferenceRelationship()]
        return value
      },
    })
    const missing = structuredClone(baseline)
    delete missing.runs[0].reconstruction.structure
      .crossReferenceRelationshipGraph
    const malformed = structuredClone(baseline)
    malformed.runs[0].reconstruction.structure.crossReferenceRelationshipGraph[0].targets[0] =
      {
        ...malformed.runs[0].reconstruction.structure
          .crossReferenceRelationshipGraph[0].targets[0],
        status: 'unresolved',
        targetNodeId: 'a'.repeat(64),
      }

    for (const invalid of [missing, malformed]) {
      expect(() =>
        comparePrivateFidelityReceipts(
          invalid,
          baseline,
          canonicalJsonHash(invalid),
        ),
      ).toThrow('INVALID_PRIVATE_FIDELITY_BASELINE')
    }
  })

  it('rejects coordinated artifact and parity tampering against structural evidence', () => {
    for (const key of [
      'canonicalContentSha256',
      'relationshipGraphSha256',
      'assetManifestSha256',
    ]) {
      const source = reconstruction()
      const first = run(1, source, [artifact('mobile', '', source)])
      const second = structuredClone(first)
      second.ordinal = 2
      for (const candidate of [first, second]) {
        candidate.reconstruction.artifactParity.publication[key] = 'f'.repeat(
          64,
        )
        candidate.artifacts[0][key] = 'f'.repeat(64)
        const artifactEvidence = Object.fromEntries(
          Object.entries(candidate.artifacts[0]).filter(
            ([field]) => field !== 'receiptSha256',
          ),
        )
        candidate.artifacts[0].receiptSha256 =
          canonicalJsonHash(artifactEvidence)
        candidate.reconstructionReceiptSha256 = canonicalJsonHash(
          candidate.reconstruction,
        )
      }

      const receipt = createPrivateFidelityReceipt({
        paperId: 'paper-v1',
        sourceSha256: hash,
        byteLength: 123,
        runs: [first, second],
        repeat: 2,
        profiles: ['mobile'],
      })

      expect(receipt.execution.profileResults[0].structurallyValid).toBe(false)
      expect(receipt.execution.localValidationPassed).toBe(false)
    }
  })

  it('binds sanitized transition outcomes to the source transition ledger', () => {
    const runs = [1, 2].map((ordinal) => {
      const source = reconstruction()
      const candidate = run(ordinal, source, [artifact('mobile', '', source)])
      candidate.reconstruction.lineTransitionEvidence.decisions[0].outcome =
        'no-space'
      return candidate
    })
    const receipt = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs,
      repeat: 2,
      profiles: ['mobile'],
    })

    expect(receipt.execution.lineTransitionGatePassed).toBe(false)
    expect(receipt.execution.localValidationPassed).toBe(false)
  })

  it('reports an absent frozen baseline explicitly and does not declare acceptance', () => {
    const profiles = ['mobile']
    const receipt = createPrivateFidelityReceipt({
      paperId: 'paper-v1',
      sourceSha256: hash,
      byteLength: 123,
      runs: [1, 2].map((ordinal) =>
        run(ordinal, reconstruction(), [artifact('mobile')]),
      ),
      repeat: 2,
      profiles,
    })

    expect(receipt.schemaVersion).toBe('1.9.0')
    expect(receipt.execution.localValidationPassed).toBe(true)
    expect(receipt.baselineComparison).toEqual({
      status: 'not-configured',
      passed: false,
    })
    expect(receipt.passed).toBe(false)
  })

  it('passes an identical frozen sanitized baseline and ignores timing-only changes', () => {
    const baseline = fidelityReceipt()
    const candidate = fidelityReceipt({
      transformReconstruction(source, ordinal) {
        source.completeness.readingOrderEvaluation.latencyMs = 912.5 + ordinal
        source.completeness.readingOrderEvaluation.costUsd = 0.004 * ordinal
        return source
      },
    })

    expect(candidate.execution.reconstructionDeterministic).toBe(true)
    expect(
      comparePrivateFidelityReceipts(
        baseline,
        candidate,
        acceptedBaselineSha256(baseline),
      ),
    ).toEqual({
      status: 'passed',
      passed: true,
      receiptSha256: canonicalJsonHash(baseline),
    })
  })

  it('accepts author-year citation relationships in sanitized evidence', () => {
    const baseline = fidelityReceipt({
      transformReconstruction(source) {
        source.citationRelationships = [
          citationRelationship({
            taxonomy: 'author-year-bibliography-citation',
          }),
        ]
        return source
      },
    })

    expect(
      comparePrivateFidelityReceipts(
        baseline,
        structuredClone(baseline),
        acceptedBaselineSha256(baseline),
      ),
    ).toMatchObject({ status: 'passed', passed: true })
  })

  it('requires an independently supplied digest before a not-configured receipt can act as the accepted baseline', () => {
    const baseline = fidelityReceipt()
    const candidate = fidelityReceipt()

    expect(baseline.baselineComparison.status).toBe('not-configured')
    expect(() => comparePrivateFidelityReceipts(baseline, candidate)).toThrow(
      'INVALID_PRIVATE_FIDELITY_BASELINE',
    )
    expect(() =>
      comparePrivateFidelityReceipts(baseline, candidate, 'f'.repeat(64)),
    ).toThrow('INVALID_PRIVATE_FIDELITY_BASELINE')
    expect(
      comparePrivateFidelityReceipts(
        baseline,
        candidate,
        acceptedBaselineSha256(baseline),
      ),
    ).toMatchObject({ status: 'passed', passed: true })
  })

  it('fails closed for completeness, readiness, structure, diagnostic, or artifact regressions', () => {
    const baseline = fidelityReceipt()
    const regressions = [
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.textCoverage = 0.99
          source.completeness.matchedTextCharacters = 99
          return source
        },
      }),
      fidelityReceipt({ ready: false }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.paper.nodes.push({
            id: 'paragraph-regression',
            source: 'region-regression',
            type: 'paragraph',
            text: 'Sanitized structural regression fixture.',
          })
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.diagnostics.push({
            severity: 'warning',
            code: 'NEW_SANITIZED_DIAGNOSTIC',
          })
          return source
        },
      }),
      fidelityReceipt({
        transformArtifact(value) {
          return { ...value, sha256: 'f'.repeat(64) }
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.missingSourceRegionCount = 1
          return requireReconstructionReview(source, 'MISSING_SOURCE_REGION')
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.unprovenancedRenderedUnitCount = 1
          return requireReconstructionReview(
            source,
            'UNPROVENANCED_RENDERED_UNIT',
          )
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.mappedInlineSpanCount = 0
          source.completeness.inlineSpanCoverage = 0
          return requireReconstructionReview(
            source,
            'INCOMPLETE_INLINE_STYLE_COVERAGE',
          )
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.mappedHyperlinkCount = 0
          source.completeness.hyperlinkCoverage = 0
          return requireReconstructionReview(source, 'UNRESOLVED_HYPERLINK')
        },
      }),
    ]

    for (const [index, candidate] of regressions.entries()) {
      expect(
        comparePrivateFidelityReceipts(
          baseline,
          candidate,
          acceptedBaselineSha256(baseline),
        ),
        `regression fixture ${index}`,
      ).toEqual({ status: 'failed', passed: false })
    }
  })

  it('fails closed when source identity, repeat, or requested profiles differ', () => {
    const baseline = fidelityReceipt()
    const mismatches = [
      fidelityReceipt({ paperId: 'paper-v2' }),
      fidelityReceipt({ sourceSha256: '9'.repeat(64) }),
      fidelityReceipt({ byteLength: 124 }),
      fidelityReceipt({ repeat: 3 }),
      fidelityReceipt({ profiles: ['paperPro'] }),
    ]

    for (const candidate of mismatches) {
      expect(
        comparePrivateFidelityReceipts(
          baseline,
          candidate,
          acceptedBaselineSha256(baseline),
        ),
      ).toEqual({ status: 'failed', passed: false })
    }
  })

  it('binds the optional decision-set digest into accepted receipt identity', () => {
    const acceptedDecisionSetSha256 = 'd'.repeat(64)
    const changedDecisionSetSha256 = 'e'.repeat(64)
    const baseline = fidelityReceipt({
      decisionSetSha256: acceptedDecisionSetSha256,
    })
    const matching = fidelityReceipt({
      decisionSetSha256: acceptedDecisionSetSha256,
    })

    expect(baseline.decisionSetSha256).toBe(acceptedDecisionSetSha256)
    expect(fidelityReceipt().decisionSetSha256).toBeNull()
    expect(
      comparePrivateFidelityReceipts(
        baseline,
        matching,
        acceptedBaselineSha256(baseline),
      ),
    ).toMatchObject({ status: 'passed', passed: true })

    const changed = fidelityReceipt({
      decisionSetSha256: changedDecisionSetSha256,
    })
    expect(
      comparePrivateFidelityReceipts(
        baseline,
        changed,
        acceptedBaselineSha256(baseline),
      ),
    ).toEqual({ status: 'failed', passed: false })

    const missing = structuredClone(matching)
    delete missing.decisionSetSha256
    expect(() =>
      comparePrivateFidelityReceipts(
        baseline,
        missing,
        acceptedBaselineSha256(baseline),
      ),
    ).toThrow('INVALID_PRIVATE_FIDELITY_BASELINE')

    const malformed = structuredClone(matching)
    malformed.decisionSetSha256 = 'not-a-sha256'
    expect(() =>
      comparePrivateFidelityReceipts(
        baseline,
        malformed,
        acceptedBaselineSha256(baseline),
      ),
    ).toThrow('INVALID_PRIVATE_FIDELITY_BASELINE')

    const forgedBaseline = structuredClone(baseline)
    forgedBaseline.decisionSetSha256 = changedDecisionSetSha256
    expect(() =>
      comparePrivateFidelityReceipts(
        forgedBaseline,
        matching,
        acceptedBaselineSha256(baseline),
      ),
    ).toThrow('INVALID_PRIVATE_FIDELITY_BASELINE')
  })
})

import { describe, expect, it } from 'vitest'
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, homedir, tmpdir, join, resolve, spawnSync, createHash, fileURLToPath, canonicalHyphenEvidenceSha256, canonicalJsonHash, PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE, PDF_HYPHEN_LEXICAL_MODEL_RECEIPT, PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE_RECEIPT, PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE, applyPrivateDecisionSet, comparePrivateFidelityBaseline, comparePrivateFidelityReceipts, createPrivateFidelityReceipt, createPrivateFidelityRunReceipt, createPrivateReconstructionEvidenceRaw, parsePrivateFidelityArguments, prepareOwnerOnlyDirectory, writeExclusive, privateFidelity, hash, privateCompletenessPolicy, createPrivateReconstructionEvidence, canonicalHyphenDeletionRecord, canonicalDerivedAffixHyphenDeletionRecord, citationRelationship, crossReferenceRelationship, reconstruction, requireReconstructionReview, artifact, inspectedArtifact, run, fidelityReceipt, acceptedBaselineSha256, recomputePrivateReconstructionReceiptSha256, rebuildPrivateFidelityReceipt, installCanonicalHyphenDeletionLedger, forgeCanonicalHyphenDeletionLedger, historicalV14Receipt,
} from './pdf-private-fidelity.cases-support.mjs'

describe('private PDF fidelity semantic cases', () => {
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


})

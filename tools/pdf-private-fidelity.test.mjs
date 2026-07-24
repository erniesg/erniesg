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
import { canonicalJsonHash } from './pdf-corpus-audit-lib.mjs'
import {
  applyPrivateDecisionSet,
  comparePrivateFidelityBaseline,
  comparePrivateFidelityReceipts,
  createPrivateFidelityReceipt,
  createPrivateFidelityRunReceipt,
  createPrivateReconstructionEvidence,
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

function run(ordinal, source, artifacts) {
  return createPrivateFidelityRunReceipt({
    ordinal,
    reconstruction: source,
    artifacts,
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

describe('private PDF fidelity runner', () => {
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
      runs: [1, 2].map((ordinal) => run(ordinal, source, [fallbackArtifact])),
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
        run(ordinal, source, [overinclusiveArtifact]),
      ),
      repeat: 2,
      profiles: ['mobile'],
    })
    expect(invalidReceipt.execution.profileResults[0].structurallyValid).toBe(
      false,
    )

    const coordinatedRuns = [1, 2].map((ordinal) => {
      const candidate = run(ordinal, source, [overinclusiveArtifact])
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

    expect(checked.schemaVersion).toBe('1.7.0')
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
      schemaVersion: '1.4.0',
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
      schemaVersion: '1.4.0',
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

    expect(receipt.schemaVersion).toBe('1.7.0')
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

  it('rejects legacy private receipts that predate complete semantic evidence', () => {
    const legacy = fidelityReceipt()
    legacy.schemaVersion = '1.6.0'

    expect(() =>
      comparePrivateFidelityReceipts(
        legacy,
        fidelityReceipt(),
        acceptedBaselineSha256(legacy),
      ),
    ).toThrow('INVALID_PRIVATE_FIDELITY_BASELINE')
  })

  it('rejects an invalid or locally unaccepted frozen receipt generically', () => {
    const invalidSchema = { ...fidelityReceipt(), schemaVersion: 'invalid' }
    const corruptHash = structuredClone(fidelityReceipt())
    corruptHash.runs[0].reconstructionReceiptSha256 = '0'.repeat(64)
    const locallyBlocked = fidelityReceipt({ ready: false })
    const emptyFallbackArtifact = fidelityReceipt({
      transformArtifact(value) {
        return {
          ...value,
          mode: 'readable-fallback',
          byteLength: 0,
          canonicalNodeCount: 0,
        }
      },
    })
    const invalidInlineCoverage = fidelityReceipt({
      transformReconstruction(source) {
        source.completeness.inlineSpanCoverage = 0.5
        return source
      },
    })
    const invalidCompletenessEvidence = [
      fidelityReceipt({
        transformReconstruction(source) {
          delete source.completeness.expectedHyperlinkCount
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.hyperlinkCoverage = 0.5
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.mappedHyperlinkCount = 2
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.textCoverage = 0.5
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.assetCoverage = 0.5
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.relationshipCoverage = 0.5
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.matchedTextCharacters = 101
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.exportedAssetCount = 2
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.resolvedRelationshipCount = 2
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.decidedLineBoundaryCount = 2
          return source
        },
      }),
    ]

    for (const baseline of [
      invalidSchema,
      corruptHash,
      locallyBlocked,
      emptyFallbackArtifact,
      invalidInlineCoverage,
      ...invalidCompletenessEvidence,
    ]) {
      expect(() =>
        comparePrivateFidelityReceipts(
          baseline,
          fidelityReceipt(),
          acceptedBaselineSha256(baseline),
        ),
      ).toThrow('INVALID_PRIVATE_FIDELITY_BASELINE')
    }
  })

  it('rejects private readiness claims that contradict policy, completeness, diagnostics, or blockers', () => {
    const baseline = fidelityReceipt()
    const invalidCandidates = [
      fidelityReceipt({
        transformReconstruction(source) {
          source.readiness.blockingDiagnosticCodes = ['SOURCE_ERROR']
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.diagnostics.push({
            severity: 'error',
            code: 'SOURCE_ERROR',
          })
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.outputTextCharacters = 97
          source.completeness.matchedTextCharacters = 97
          source.completeness.textCoverage = 0.97
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.unresolvedObjectCount = 1
          source.completeness.unresolvedObjects.assets = 1
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.ocrRequiredPages = [1]
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.completeness.readingOrderDiagnostics = 1
          source.completeness.readingOrderEvaluation.unresolvedEdgeCount = 1
          source.completeness.readingOrderEvaluation.reviewRequired = true
          return source
        },
      }),
      fidelityReceipt({
        transformReconstruction(source) {
          source.readiness.ready = false
          source.readiness.status = 'review-required'
          return source
        },
      }),
    ]

    for (const candidate of invalidCandidates) {
      expect(() =>
        comparePrivateFidelityReceipts(
          baseline,
          candidate,
          acceptedBaselineSha256(baseline),
        ),
      ).toThrow('INVALID_PRIVATE_FIDELITY_BASELINE')
    }
  })

  it('loads an external baseline without exposing its path or unexpected private fields', async () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'pdf-private-baseline-test-'),
    )
    const privatePath = join(
      temporaryDirectory,
      'operator frozen baseline private path.json',
    )
    const privateText = 'PRIVATE SOURCE TEXT MUST NEVER ESCAPE'
    try {
      const baseline = fidelityReceipt()
      const expectedBaselineSha256 = acceptedBaselineSha256(baseline)
      writeFileSync(privatePath, JSON.stringify(baseline))
      const comparison = await comparePrivateFidelityBaseline(
        privatePath,
        fidelityReceipt(),
        expectedBaselineSha256,
      )
      const serialized = JSON.stringify(comparison)
      expect(serialized).not.toContain(privatePath)
      expect(serialized).not.toContain('operator frozen baseline')

      writeFileSync(privatePath, JSON.stringify({ sourceText: privateText }))
      let failure
      try {
        await comparePrivateFidelityBaseline(
          privatePath,
          fidelityReceipt(),
          expectedBaselineSha256,
        )
      } catch (error) {
        failure = String(error)
      }
      expect(failure).toBe('Error: INVALID_PRIVATE_FIDELITY_BASELINE')
      expect(failure).not.toContain(privatePath)
      expect(failure).not.toContain(privateText)
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('requires a new external owner-only directory and exclusive artifact writes', async () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'pdf-private-output-test-'),
    )
    const output = join(temporaryDirectory, 'new-proof')
    const linkedOutput = join(temporaryDirectory, 'linked-proof')
    try {
      const created = await prepareOwnerOnlyDirectory(output)
      expect(statSync(created).mode & 0o077).toBe(0)
      await expect(prepareOwnerOnlyDirectory(created)).rejects.toThrow(
        'OUTPUT_MUST_BE_NEW_EXTERNAL_DIRECTORY',
      )
      symlinkSync(created, linkedOutput)
      await expect(prepareOwnerOnlyDirectory(linkedOutput)).rejects.toThrow(
        'OUTPUT_MUST_BE_NEW_EXTERNAL_DIRECTORY',
      )
      await expect(prepareOwnerOnlyDirectory('/')).rejects.toThrow(
        'OUTPUT_MUST_BE_NEW_EXTERNAL_DIRECTORY',
      )
      await expect(prepareOwnerOnlyDirectory(homedir())).rejects.toThrow(
        'OUTPUT_MUST_BE_NEW_EXTERNAL_DIRECTORY',
      )
      await expect(
        prepareOwnerOnlyDirectory(resolve('private-proof-inside-repository')),
      ).rejects.toThrow('OUTPUT_MUST_BE_NEW_EXTERNAL_DIRECTORY')

      const artifactPath = join(created, 'artifact.epub')
      await writeExclusive(artifactPath, new Uint8Array([1, 2, 3]))
      expect(statSync(artifactPath).mode & 0o077).toBe(0)
      await expect(
        writeExclusive(artifactPath, new Uint8Array([4, 5, 6])),
      ).rejects.toMatchObject({ code: 'EEXIST' })
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('does not expose an environment-sourced path when execution fails', () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'pdf-private-fidelity-test-'),
    )
    const privatePath = join(temporaryDirectory, 'operator source.pdf')
    const outputDirectory = join(temporaryDirectory, 'proof')
    try {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./pdf-private-fidelity.mjs', import.meta.url)),
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
          outputDirectory,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, SRT_PRIVATE_TEST_PDF: privatePath },
        },
      )
      const output = `${result.stdout}\n${result.stderr}`

      expect(result.status).toBe(2)
      expect(output).not.toContain(privatePath)
      expect(output).not.toContain('operator source.pdf')
      expect(output).toContain(
        'Private PDF fidelity validation failed without exposing local paths or source content.',
      )
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('emits only a safe error class, code, and message digest when diagnostic output is requested', () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'pdf-private-fidelity-diagnostic-test-'),
    )
    const privatePath = join(temporaryDirectory, 'missing owner source.pdf')
    const outputDirectory = join(temporaryDirectory, 'proof')
    try {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./pdf-private-fidelity.mjs', import.meta.url)),
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
          outputDirectory,
          '--safe-error-diagnostic',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, SRT_PRIVATE_TEST_PDF: privatePath },
        },
      )
      const output = `${result.stdout}\n${result.stderr}`
      const diagnosticLine = result.stderr
        .split('\n')
        .find((line) => line.startsWith('{'))

      expect(result.status).toBe(2)
      expect(diagnosticLine).toBeDefined()
      expect(JSON.parse(diagnosticLine)).toEqual({
        errorClass: 'Error',
        errorCode: 'ENOENT',
        messageSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        stage: 'source-stat',
      })
      expect(output).not.toContain(privatePath)
      expect(output).not.toContain('missing owner source.pdf')
      expect(output).not.toContain('no such file')
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('does not reinterpret an arbitrary identifier-shaped error message as a diagnostic code', () => {
    expect(
      privateFidelity.safePrivateFailureDiagnostic(
        new Error('private-source.pdf'),
        'test-stage',
      ),
    ).toEqual({
      errorClass: 'Error',
      errorCode: 'UNCLASSIFIED',
      messageSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      stage: 'test-stage',
    })
  })

  it('treats EPUBCheck warnings as a pre-publication failure in required mode', () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'pdf-private-epubcheck-test-'),
    )
    const binaryDirectory = join(temporaryDirectory, 'bin')
    const argumentsLog = join(temporaryDirectory, 'epubcheck-arguments.jsonl')
    const outputDirectory = join(temporaryDirectory, 'proof')
    const inputPath = resolve('tests/fixtures/pdf/born-digital.pdf')
    const inputBytes = readFileSync(inputPath)
    const inputSha256 = createHash('sha256').update(inputBytes).digest('hex')
    try {
      mkdirSync(binaryDirectory)
      const fakeEpubCheck = join(binaryDirectory, 'epubcheck')
      writeFileSync(
        fakeEpubCheck,
        `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv.includes('--version')) process.exit(0)
appendFileSync(process.env.EPUBCHECK_ARGUMENTS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
process.exit(1)
`,
      )
      chmodSync(fakeEpubCheck, 0o755)

      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./pdf-private-fidelity.mjs', import.meta.url)),
          '--input-env',
          'SRT_PRIVATE_TEST_PDF',
          '--paper-id',
          'public-fixture',
          '--expected-size',
          String(inputBytes.byteLength),
          '--expected-sha256',
          inputSha256,
          '--profiles',
          'mobile',
          '--repeat',
          '2',
          '--out',
          outputDirectory,
          '--require-epubcheck',
          '--safe-error-diagnostic',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            EPUBCHECK_ARGUMENTS_LOG: argumentsLog,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
            SRT_PRIVATE_TEST_PDF: inputPath,
          },
          timeout: 120_000,
        },
      )
      const diagnostic = JSON.parse(
        result.stderr.split('\n').find((line) => line.startsWith('{')),
      )

      expect(result.status, result.stderr).toBe(2)
      expect(diagnostic).toMatchObject({
        errorClass: 'Error',
        errorCode: 'EPUBCHECK_FAILED',
        stage: 'epubcheck-validate',
      })
      expect(
        readFileSync(argumentsLog, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual([
        ['--failonwarnings', expect.stringMatching(/publication\.epub$/)],
      ])
      expect(readdirSync(outputDirectory)).toEqual([])
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(inputPath)
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }, 120_000)

  it('records every required EPUBCheck pass in the sanitized private receipt', () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'pdf-private-epubcheck-pass-test-'),
    )
    const binaryDirectory = join(temporaryDirectory, 'bin')
    const argumentsLog = join(temporaryDirectory, 'epubcheck-arguments.jsonl')
    const outputDirectory = join(temporaryDirectory, 'proof')
    const inputPath = resolve('tests/fixtures/pdf/born-digital.pdf')
    const inputBytes = readFileSync(inputPath)
    const inputSha256 = createHash('sha256').update(inputBytes).digest('hex')
    try {
      mkdirSync(binaryDirectory)
      const fakeEpubCheck = join(binaryDirectory, 'epubcheck')
      writeFileSync(
        fakeEpubCheck,
        `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv.includes('--version')) process.exit(0)
appendFileSync(process.env.EPUBCHECK_ARGUMENTS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
`,
      )
      chmodSync(fakeEpubCheck, 0o755)

      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./pdf-private-fidelity.mjs', import.meta.url)),
          '--input-env',
          'SRT_PRIVATE_TEST_PDF',
          '--paper-id',
          'public-fixture',
          '--expected-size',
          String(inputBytes.byteLength),
          '--expected-sha256',
          inputSha256,
          '--profiles',
          'mobile',
          '--repeat',
          '2',
          '--out',
          outputDirectory,
          '--require-epubcheck',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            EPUBCHECK_ARGUMENTS_LOG: argumentsLog,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
            SRT_PRIVATE_TEST_PDF: inputPath,
          },
          timeout: 120_000,
        },
      )
      const receipt = JSON.parse(result.stdout)

      expect(result.status, result.stderr).toBe(1)
      expect(receipt).toMatchObject({
        schemaVersion: '1.7.0',
        execution: {
          epubCheckRequired: true,
          epubCheckPassedCount: 2,
          allEpubCheckPassed: true,
        },
      })
      expect(
        receipt.runs
          .flatMap((run) => run.artifacts)
          .map((artifact) => artifact.epubCheck),
      ).toEqual([{ status: 'passed' }, { status: 'passed' }])
      expect(readdirSync(outputDirectory).sort()).toEqual([
        'private-fidelity-receipt.json',
        'run-1-mobile.epub',
        'run-2-mobile.epub',
      ])
      expect(
        readFileSync(argumentsLog, 'utf8').trim().split('\n'),
      ).toHaveLength(2)
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }, 120_000)

  it('replays a hash-pinned empty decision set without exposing either local path', () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'pdf-private-decisions-test-'),
    )
    const inputPath = resolve('tests/fixtures/pdf/born-digital.pdf')
    const inputBytes = readFileSync(inputPath)
    const inputSha256 = createHash('sha256').update(inputBytes).digest('hex')
    const decisionPath = join(temporaryDirectory, 'owner decisions.json')
    const decisionBytes = Buffer.from(
      `${JSON.stringify({
        schemaVersion: '1.1.0',
        documentSha256: inputSha256,
        decisions: [],
      })}\n`,
    )
    const decisionSha256 = createHash('sha256')
      .update(decisionBytes)
      .digest('hex')
    const outputDirectory = join(temporaryDirectory, 'proof')
    try {
      writeFileSync(decisionPath, decisionBytes, { mode: 0o600 })
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./pdf-private-fidelity.mjs', import.meta.url)),
          '--input-env',
          'SRT_PRIVATE_TEST_PDF',
          '--paper-id',
          'public-fixture',
          '--expected-size',
          String(inputBytes.byteLength),
          '--expected-sha256',
          inputSha256,
          '--profiles',
          'mobile',
          '--repeat',
          '2',
          '--out',
          outputDirectory,
          '--decisions-env',
          'SRT_PRIVATE_TEST_DECISIONS',
          '--expected-decisions-sha256',
          decisionSha256,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            SRT_PRIVATE_TEST_PDF: inputPath,
            SRT_PRIVATE_TEST_DECISIONS: decisionPath,
          },
          timeout: 120_000,
        },
      )
      const output = `${result.stdout}\n${result.stderr}`

      expect(result.status, result.stderr).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        decisionSetSha256: decisionSha256,
        execution: {
          reconstructionDeterministic: true,
          artifactsDeterministic: true,
          localValidationPassed: true,
        },
        baselineComparison: { status: 'not-configured', passed: false },
      })
      expect(output).not.toContain(inputPath)
      expect(output).not.toContain(decisionPath)
      expect(output).not.toContain('owner decisions.json')
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }, 120_000)
})

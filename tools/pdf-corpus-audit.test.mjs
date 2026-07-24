import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  canonicalJsonHash,
  createSafeAuditFailureDocument,
  createPdfStructuralReceipt,
  summarizeAuditDiagnostics,
} from './pdf-corpus-audit-lib.mjs'
import { safeAuditDiagnostic } from './pdf-corpus-audit-safety.mjs'

function sourceBox(overrides = {}) {
  return {
    page: 1,
    x: 0.1,
    y: 0.2,
    width: 0.1,
    height: 0.02,
    rotation: 0,
    method: 'pdf-text',
    ...overrides,
  }
}

describe('local PDF corpus audit', () => {
  it('creates only allowlisted basename-only audit failure rows', () => {
    expect(
      createSafeAuditFailureDocument(
        '/private/source/problematic paper.pdf',
        'PDF_DOCUMENT_TIMEOUT',
      ),
    ).toEqual({
      basename: 'problematic paper.pdf',
      sha256: null,
      code: 'PDF_DOCUMENT_TIMEOUT',
      message: 'The PDF exceeded the local per-document processing time limit.',
    })
    expect(
      createSafeAuditFailureDocument(
        '/private/source/problematic paper.pdf',
        '/private/arbitrary-code',
      ),
    ).toEqual({
      basename: 'problematic paper.pdf',
      sha256: null,
      code: 'AUDIT_FAILED',
      message:
        'The PDF could not be audited; local path and document details were suppressed.',
    })
  })

  it('requires exact source-provenance and inline-semantic completeness fields in the public schema', async () => {
    const schema = JSON.parse(
      await readFile('docs/schemas/pdf-corpus-audit.schema.json', 'utf8'),
    )
    const completeness = schema.$defs.completeness
    const required = [
      'missingSourceRegionCount',
      'unprovenancedRenderedUnitCount',
      'expectedInlineSpanCount',
      'mappedInlineSpanCount',
      'inlineSpanCoverage',
      'expectedHyperlinkCount',
      'mappedHyperlinkCount',
      'hyperlinkCoverage',
      'structurallyConsumedLineBoundaryCount',
    ]

    expect(completeness.required).toEqual(expect.arrayContaining(required))
    expect(Object.keys(completeness.properties)).toEqual(
      expect.arrayContaining(required),
    )
    expect(
      schema.$defs.citationRelationship.properties.taxonomy.enum,
    ).toContain('author-year-bibliography-citation')
    expect(completeness.dependentRequired).toMatchObject({
      expectedSemanticTableCount: [
        'resolvedSemanticTableCount',
        'semanticTableCoverage',
      ],
      resolvedSemanticTableCount: [
        'expectedSemanticTableCount',
        'semanticTableCoverage',
      ],
      semanticTableCoverage: [
        'expectedSemanticTableCount',
        'resolvedSemanticTableCount',
      ],
    })
  })

  it('validates the required structural line-boundary count in report and receipt schemas', async () => {
    const schema = JSON.parse(
      await readFile('docs/schemas/pdf-corpus-audit.schema.json', 'utf8'),
    )
    const ajv = new Ajv2020({ strict: false })
    const completenessValidator = ajv.compile({
      $schema: schema.$schema,
      $defs: schema.$defs,
      ...schema.$defs.completeness,
    })
    const receiptValidator = ajv.compile({
      $schema: schema.$schema,
      $defs: schema.$defs,
      ...schema.$defs.structuralReceipt,
    })
    const reconstruction = {
      paper: {
        id: 'paper-1',
        nodes: [{ id: 'node-1', type: 'paragraph', text: 'Body' }],
      },
      lineBoundaryDecisions: [
        {
          id: 'boundary-1',
          page: 1,
          regionId: 'table-region-1',
          fromLineId: 'line-1',
          toLineId: 'line-2',
          outcome: 'structural-boundary',
          evidence: ['strict-visual-only-region'],
        },
        {
          id: 'boundary-2',
          page: 1,
          regionId: 'prose-region-1',
          fromLineId: 'line-3',
          toLineId: 'line-4',
          outcome: 'unresolved',
          evidence: ['ambiguous-line-break'],
        },
      ],
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 1,
    }
    const receipt = createPdfStructuralReceipt(reconstruction)

    expect(schema.$id).toBe(
      'https://ernie.sg/schemas/pdf-corpus-audit-1.5.0.json',
    )
    expect(schema.properties.schemaVersion.const).toBe('1.5.0')
    expect(schema.$defs.structuralReceipt.properties.schemaVersion.const).toBe(
      '1.3.0',
    )
    expect(schema.$defs.structuralReceipt.required).toContain(
      'canonicalNodeProvenanceSha256',
    )
    expect(schema.$defs.structuralReceipt.required).toEqual(
      expect.arrayContaining([
        'crossReferenceRelationshipCount',
        'crossReferenceRelationshipCounts',
        'crossReferenceRelationshipGraph',
        'crossReferenceRelationshipGraphSha256',
      ]),
    )
    expect(schema.$defs.crossReferenceRelationship).toBeDefined()
    expect(schema.$defs.crossReferenceTarget).toBeDefined()
    expect(receipt).toMatchObject({
      schemaVersion: '1.3.0',
      canonicalNodeProvenanceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      lineTransitionCount: 2,
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 1,
    })
    expect(receiptValidator(receipt), receiptValidator.errors).toBe(true)
    expect(
      receiptValidator({
        ...receipt,
        structurallyConsumedLineBoundaryCount: -1,
      }),
    ).toBe(false)
    const { structurallyConsumedLineBoundaryCount: _, ...missingCount } =
      receipt
    expect(receiptValidator(missingCount)).toBe(false)

    const completeness = {
      sourceTextCharacters: 0,
      outputTextCharacters: 0,
      matchedTextCharacters: 0,
      textCoverage: 0,
      duplicateCanonicalSpanCount: 0,
      missingSourceRegionCount: 0,
      unprovenancedRenderedUnitCount: 0,
      expectedInlineSpanCount: 0,
      mappedInlineSpanCount: 0,
      inlineSpanCoverage: 0,
      expectedHyperlinkCount: 0,
      mappedHyperlinkCount: 0,
      hyperlinkCoverage: 0,
      lineBoundaryCount: 2,
      decidedLineBoundaryCount: 2,
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 1,
      sourceAssetCount: 0,
      exportedAssetCount: 0,
      assetCoverage: 0,
      expectedRelationshipCount: 0,
      resolvedRelationshipCount: 0,
      relationshipCoverage: 0,
      unresolvedObjectCount: 0,
      unresolvedObjects: {
        assets: 0,
        captions: 0,
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
        regionCount: 0,
        acceptedEdgeCount: 0,
        unresolvedEdgeCount: 0,
        cycleRate: 0,
        orderAccuracy: null,
        provider: null,
        modelVersion: null,
        latencyMs: 0,
        costUsd: 0,
        reviewRequired: false,
      },
    }
    expect(
      completenessValidator(completeness),
      completenessValidator.errors,
    ).toBe(true)
    expect(
      completenessValidator({
        ...completeness,
        structurallyConsumedLineBoundaryCount: -1,
      }),
    ).toBe(false)
  })

  it('rejects receipt counts that disagree with the line-boundary decision ledger', () => {
    const reconstruction = {
      paper: { id: 'paper-1', nodes: [] },
      lineBoundaryDecisions: [
        {
          id: 'boundary-1',
          outcome: 'structural-boundary',
          evidence: ['strict-visual-only-region'],
        },
      ],
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 1,
    }

    expect(() => createPdfStructuralReceipt(reconstruction)).toThrow(
      'Line transition counts do not match the decision ledger.',
    )
    expect(() =>
      createPdfStructuralReceipt({
        ...reconstruction,
        unresolvedCorruptingJoinCount: 0,
        structurallyConsumedLineBoundaryCount: 1,
        lineBoundaryDecisions: [
          { ...reconstruction.lineBoundaryDecisions[0], outcome: 'invented' },
        ],
      }),
    ).toThrow('Line transition decision outcome is invalid.')
  })

  it('canonicalizes structural hashes and recognizes the line-boundary decision ledger', async () => {
    expect(canonicalJson({ beta: 2, alpha: 1 })).toBe(
      canonicalJson({ alpha: 1, beta: 2 }),
    )
    expect(canonicalJsonHash({ beta: 2, alpha: 1 })).toBe(
      canonicalJsonHash({ alpha: 1, beta: 2 }),
    )
    const reconstruction = {
      paper: {
        id: 'paper-1',
        title: 'First title',
        nodes: [{ id: 'node-1', type: 'paragraph', text: 'Body' }],
      },
      readingOrder: { order: ['region-1'] },
      lineBoundaryDecisions: [],
      unresolvedCorruptingJoinCount: 0,
      citationRelationships: [
        {
          id: 'citation-1',
          status: 'matched',
          taxonomy: 'bracketed-bibliography-citation',
          referenceRegionId: 'region-1',
          referenceStart: 4,
          referenceEnd: 7,
          labels: ['1'],
          targetNodeIds: ['bibliography-1'],
          canonicalAnchor: { nodeId: 'node-1', start: 4, end: 7 },
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
        },
      ],
      crossReferenceRelationships: [
        {
          id: 'cross-reference-1',
          kind: 'figure',
          text: 'Figures 4 and 5',
          labels: ['Figure 4', 'Figure 5'],
          referenceRegionId: 'region-1',
          referenceStart: 8,
          referenceEnd: 23,
          targets: [
            {
              kind: 'figure',
              label: 'Figure 4',
              referenceStart: 16,
              referenceEnd: 17,
              status: 'matched',
              candidateNodeIds: ['figure-4'],
              targetNodeId: 'figure-4',
              evidence: [
                'explicit-scholarly-cross-reference-syntax',
                'canonical-label-unique',
              ],
            },
            {
              kind: 'figure',
              label: 'Figure 5',
              referenceStart: 22,
              referenceEnd: 23,
              status: 'matched',
              candidateNodeIds: ['figure-5'],
              targetNodeId: 'figure-5',
              evidence: [
                'explicit-scholarly-cross-reference-syntax',
                'canonical-label-unique',
              ],
            },
          ],
          targetNodeIds: ['figure-4', 'figure-5'],
          status: 'matched',
          canonicalAnchor: { nodeId: 'node-1', start: 8, end: 23 },
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
        },
      ],
    }
    const receipt = createPdfStructuralReceipt(reconstruction)
    const retitled = createPdfStructuralReceipt({
      ...reconstruction,
      paper: { ...reconstruction.paper, title: 'Second title' },
    })

    expect(receipt).toMatchObject({
      schemaVersion: '1.3.0',
      citationRelationshipCount: 1,
      citationRelationshipCounts: { matched: 1 },
      citationRelationshipGraph: [
        expect.objectContaining({
          id: expect.stringMatching(/^[a-f0-9]{64}$/),
          referenceRegionId: expect.stringMatching(/^[a-f0-9]{64}$/),
          labels: [expect.stringMatching(/^[a-f0-9]{64}$/)],
          targetNodeIds: [expect.stringMatching(/^[a-f0-9]{64}$/)],
          canonicalAnchor: expect.objectContaining({
            nodeId: expect.stringMatching(/^[a-f0-9]{64}$/),
            start: 4,
            end: 7,
          }),
          sourceBoxes: reconstruction.citationRelationships[0].sourceBoxes,
        }),
      ],
      citationRelationshipGraphSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      crossReferenceRelationshipCount: 1,
      crossReferenceRelationshipCounts: { 'figure:matched': 1 },
      crossReferenceRelationshipGraph: [
        expect.objectContaining({
          id: expect.stringMatching(/^[a-f0-9]{64}$/),
          kind: 'figure',
          status: 'matched',
          textSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          referenceRegionId: expect.stringMatching(/^[a-f0-9]{64}$/),
          labels: [
            expect.stringMatching(/^[a-f0-9]{64}$/),
            expect.stringMatching(/^[a-f0-9]{64}$/),
          ],
          targets: [
            expect.objectContaining({
              kind: 'figure',
              labelSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              status: 'matched',
              candidateNodeIds: [expect.stringMatching(/^[a-f0-9]{64}$/)],
              targetNodeId: expect.stringMatching(/^[a-f0-9]{64}$/),
              evidenceSha256s: expect.arrayContaining([
                expect.stringMatching(/^[a-f0-9]{64}$/),
              ]),
            }),
            expect.objectContaining({
              kind: 'figure',
              labelSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
              status: 'matched',
              candidateNodeIds: [expect.stringMatching(/^[a-f0-9]{64}$/)],
              targetNodeId: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
          ],
          targetNodeIds: [
            expect.stringMatching(/^[a-f0-9]{64}$/),
            expect.stringMatching(/^[a-f0-9]{64}$/),
          ],
          canonicalAnchor: expect.objectContaining({
            nodeId: expect.stringMatching(/^[a-f0-9]{64}$/),
            start: 8,
            end: 23,
          }),
          confidence: 0.99,
          evidenceSha256s: expect.arrayContaining([
            expect.stringMatching(/^[a-f0-9]{64}$/),
          ]),
          sourceBoxes:
            reconstruction.crossReferenceRelationships[0].sourceBoxes,
        }),
      ],
      crossReferenceRelationshipGraphSha256:
        expect.stringMatching(/^[a-f0-9]{64}$/),
      lineTransitionLedgerAvailable: true,
      lineTransitionCount: 0,
      lineTransitionLedgerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      unresolvedCorruptingJoinCount: 0,
      readingOrderGraphSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(retitled.canonicalContentSha256).not.toBe(
      receipt.canonicalContentSha256,
    )
    const schema = JSON.parse(
      await readFile('docs/schemas/pdf-corpus-audit.schema.json', 'utf8'),
    )
    const receiptValidator = new Ajv2020({ strict: false }).compile({
      $schema: schema.$schema,
      $defs: schema.$defs,
      ...schema.$defs.structuralReceipt,
    })
    expect(receiptValidator(receipt), receiptValidator.errors).toBe(true)
    const invalidCrossReferenceState = structuredClone(receipt)
    invalidCrossReferenceState.crossReferenceRelationshipGraph[0].targets[0] = {
      ...invalidCrossReferenceState.crossReferenceRelationshipGraph[0]
        .targets[0],
      status: 'ambiguous',
    }
    expect(receiptValidator(invalidCrossReferenceState)).toBe(false)
    expect(JSON.stringify(receipt.citationRelationshipGraph)).not.toContain(
      'bibliography-1',
    )
    expect(
      JSON.stringify(receipt.crossReferenceRelationshipGraph),
    ).not.toContain('Figure 4')
    expect(
      JSON.stringify(receipt.crossReferenceRelationshipGraph),
    ).not.toContain('figure-4')
    for (const changedRelationship of [
      {
        ...reconstruction.citationRelationships[0],
        canonicalAnchor: { nodeId: 'node-2', start: 4, end: 7 },
      },
      {
        ...reconstruction.citationRelationships[0],
        targetNodeIds: ['bibliography-2'],
      },
    ]) {
      const changed = createPdfStructuralReceipt({
        ...reconstruction,
        citationRelationships: [changedRelationship],
      })
      expect(changed.citationRelationshipGraphSha256).not.toBe(
        receipt.citationRelationshipGraphSha256,
      )
    }
    for (const mutate of [
      (relationship) => {
        relationship.canonicalAnchor.nodeId = 'node-2'
      },
      (relationship) => {
        relationship.targets[0].candidateNodeIds = ['figure-6']
        relationship.targets[0].targetNodeId = 'figure-6'
        relationship.targetNodeIds = ['figure-6', 'figure-5']
      },
    ]) {
      const relationship = structuredClone(
        reconstruction.crossReferenceRelationships[0],
      )
      mutate(relationship)
      const changed = createPdfStructuralReceipt({
        ...reconstruction,
        crossReferenceRelationships: [relationship],
      })
      expect(changed.crossReferenceRelationshipGraphSha256).not.toBe(
        receipt.crossReferenceRelationshipGraphSha256,
      )
    }
  })

  it('binds visual source-line lineage into the structural relationship hash', () => {
    const relationship = {
      id: 'table-1',
      kind: 'table',
      status: 'matched',
    }
    const reconstruction = {
      paper: { id: 'paper-1', nodes: [] },
      visualRelationships: [
        { ...relationship, sourceLineIds: ['line-1', 'line-2'] },
      ],
    }
    const receipt = createPdfStructuralReceipt(reconstruction)
    const changed = createPdfStructuralReceipt({
      ...reconstruction,
      visualRelationships: [{ ...relationship, sourceLineIds: ['line-1'] }],
    })
    const withoutLineage = createPdfStructuralReceipt({
      ...reconstruction,
      visualRelationships: [relationship],
    })

    expect(withoutLineage.visualRelationshipGraphSha256).toBe(
      canonicalJsonHash([
        {
          ...relationship,
          semanticKind: null,
          canonicalNodeId: null,
          captionNodeId: null,
          captionRegionId: null,
          sourceRegionIds: [],
          sourceObjectIds: [],
          sourceLineIds: [],
          assetIds: [],
          sourceBoxes: [],
          altTextSource: null,
          preformattedSourceSha256: null,
          selectedCandidateSha256: null,
          selectedCropSha256: null,
        },
      ]),
    )
    expect(changed.visualRelationshipGraphSha256).not.toBe(
      receipt.visualRelationshipGraphSha256,
    )
    expect(canonicalJsonHash(changed)).not.toBe(canonicalJsonHash(receipt))
  })

  it('binds proved preformatted source order and whitespace without exposing source text', () => {
    const sourceLine = {
      text: 'Context: {context}',
      sourceRegionId: 'code-region-private-1',
      sourceLineId: 'code-line-private-1',
      sourceBox: sourceBox(),
      sourceRunBoxes: [sourceBox()],
    }
    const relationship = {
      id: 'code-relationship-1',
      kind: 'figure',
      semanticKind: 'code',
      status: 'matched',
      preformatted: {
        status: 'proved',
        lines: [sourceLine],
        evidence: [
          'exact-single-source-run-per-line',
          'deterministic-page-y-order',
        ],
      },
    }
    const reconstruction = {
      paper: { id: 'paper-1', nodes: [] },
      visualRelationships: [relationship],
    }
    const receipt = createPdfStructuralReceipt(reconstruction)
    const textChanged = createPdfStructuralReceipt({
      ...reconstruction,
      visualRelationships: [
        {
          ...relationship,
          preformatted: {
            ...relationship.preformatted,
            lines: [{ ...sourceLine, text: 'Context:{context}' }],
          },
        },
      ],
    })
    const orderChanged = createPdfStructuralReceipt({
      ...reconstruction,
      visualRelationships: [
        {
          ...relationship,
          preformatted: {
            ...relationship.preformatted,
            lines: [
              sourceLine,
              {
                ...sourceLine,
                text: 'Question: {question}',
                sourceLineId: 'code-line-private-2',
              },
            ].reverse(),
          },
        },
      ],
    })
    const unresolved = createPdfStructuralReceipt({
      ...reconstruction,
      visualRelationships: [
        {
          ...relationship,
          preformatted: {
            ...relationship.preformatted,
            status: 'unresolved',
          },
        },
      ],
    })

    expect(textChanged.visualRelationshipGraphSha256).not.toBe(
      receipt.visualRelationshipGraphSha256,
    )
    expect(orderChanged.visualRelationshipGraphSha256).not.toBe(
      receipt.visualRelationshipGraphSha256,
    )
    expect(unresolved.visualRelationshipGraphSha256).not.toBe(
      receipt.visualRelationshipGraphSha256,
    )
    expect(JSON.stringify(receipt)).not.toContain(sourceLine.text)
    expect(JSON.stringify(receipt)).not.toContain(sourceLine.sourceLineId)
    expect(JSON.stringify(receipt)).not.toContain(sourceLine.sourceRegionId)
  })

  it('binds canonical note-anchor offsets and owning node identity into the note graph hash', () => {
    const noteReference = {
      id: 'note-reference-private-1',
      label: '1',
      target: 'note-private-1',
      start: 4,
      end: 5,
      confidence: 1,
    }
    const reconstruction = {
      paper: {
        id: 'paper-1',
        nodes: [
          {
            id: 'paragraph-private-1',
            type: 'paragraph',
            text: 'Body1',
            noteReferences: [noteReference],
          },
          {
            id: 'paragraph-private-2',
            type: 'paragraph',
            text: 'Other',
          },
        ],
      },
      noteRelationships: [
        {
          id: noteReference.id,
          status: 'matched',
          referenceRegionId: 'region-private-1',
          targetNoteId: noteReference.target,
          label: noteReference.label,
          canonicalAnchor: {
            kind: 'node',
            nodeId: 'paragraph-private-1',
            start: noteReference.start,
            end: noteReference.end,
          },
          sourceBoxes: [sourceBox()],
        },
      ],
    }
    const baseline = createPdfStructuralReceipt(reconstruction)
    const offsetChanged = createPdfStructuralReceipt({
      ...reconstruction,
      noteRelationships: reconstruction.noteRelationships.map(
        (relationship) => ({
          ...relationship,
          canonicalAnchor: {
            ...relationship.canonicalAnchor,
            start: 3,
            end: 4,
          },
        }),
      ),
    })
    const ownerChanged = createPdfStructuralReceipt({
      ...reconstruction,
      noteRelationships: reconstruction.noteRelationships.map(
        (relationship) => ({
          ...relationship,
          canonicalAnchor: {
            ...relationship.canonicalAnchor,
            nodeId: 'paragraph-private-2',
          },
        }),
      ),
    })

    for (const changed of [offsetChanged, ownerChanged]) {
      expect(changed.noteRelationshipGraphSha256).not.toBe(
        baseline.noteRelationshipGraphSha256,
      )
      expect(canonicalJsonHash(changed)).not.toBe(canonicalJsonHash(baseline))
    }
    expect(JSON.stringify(baseline)).not.toContain('paragraph-private-1')
    expect(JSON.stringify(baseline)).not.toContain('note-reference-private-1')
  })

  it('binds canonical node provenance without disclosing its private identities', () => {
    const reconstruction = {
      paper: {
        id: 'paper-1',
        nodes: [{ id: 'node-private-1', type: 'paragraph', text: 'Body' }],
      },
      provenance: {
        'node-private-1': {
          confidence: 1,
          pages: [1],
          regionIds: ['region-private-1'],
          boxes: [sourceBox()],
          links: [],
          relationshipIds: ['relationship-private-1'],
        },
      },
    }
    const baseline = createPdfStructuralReceipt(reconstruction)
    const changed = createPdfStructuralReceipt({
      ...reconstruction,
      provenance: {
        'node-private-1': {
          ...reconstruction.provenance['node-private-1'],
          regionIds: ['region-private-2'],
        },
      },
    })

    expect(baseline.canonicalNodeProvenanceSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(changed.canonicalNodeProvenanceSha256).not.toBe(
      baseline.canonicalNodeProvenanceSha256,
    )
    expect(canonicalJsonHash(changed)).not.toBe(canonicalJsonHash(baseline))
    expect(JSON.stringify(baseline)).not.toContain('region-private-1')
    expect(JSON.stringify(baseline)).not.toContain('relationship-private-1')
  })

  it('binds visual caption-node, selected candidate, and selected crop identities into the visual graph hash', () => {
    const crop = sourceBox({
      x: 0.2,
      y: 0.3,
      width: 0.4,
      height: 0.2,
      method: 'pdf-object',
    })
    const candidate = {
      sourceRegionIds: ['visual-region-private-1'],
      sourceObjectIds: ['visual-object-private-1'],
      assetIds: ['visual-asset-private-1'],
      score: 1,
      evidence: ['source-page-crop'],
      sourceBoxes: [crop],
    }
    const relationship = {
      id: 'visual-relationship-private-1',
      kind: 'figure',
      status: 'matched',
      canonicalNodeId: 'figure-node-private-1',
      captionNodeId: 'caption-node-private-1',
      captionRegionId: 'caption-region-private-1',
      sourceRegionIds: candidate.sourceRegionIds,
      sourceObjectIds: candidate.sourceObjectIds,
      assetIds: candidate.assetIds,
      sourceBoxes: [sourceBox(), crop],
      altTextSource: 'caption',
      candidates: [candidate],
    }
    const asset = {
      id: 'visual-asset-private-1',
      kind: 'raster',
      mediaType: 'image/png',
      rendition: 'source-page-crop',
      sha256: 'a'.repeat(64),
      sourceBoxes: [crop],
      sourceCropBox: crop,
    }
    const reconstruction = {
      paper: {
        id: 'paper-1',
        nodes: [
          { id: 'caption-node-private-1', type: 'caption', text: 'Figure 1' },
          { id: 'caption-node-private-2', type: 'caption', text: 'Figure 2' },
          { id: 'figure-node-private-1', type: 'figure', title: 'Figure 1' },
        ],
      },
      visualRelationships: [relationship],
      assets: [asset],
    }
    const baseline = createPdfStructuralReceipt(reconstruction)
    const captionChanged = createPdfStructuralReceipt({
      ...reconstruction,
      visualRelationships: [
        { ...relationship, captionNodeId: 'caption-node-private-2' },
      ],
    })
    const candidateChanged = createPdfStructuralReceipt({
      ...reconstruction,
      visualRelationships: [
        {
          ...relationship,
          candidates: [
            {
              ...candidate,
              sourceObjectIds: ['visual-object-private-2'],
            },
          ],
        },
      ],
    })
    const cropChanged = createPdfStructuralReceipt({
      ...reconstruction,
      assets: [
        {
          ...asset,
          sourceCropBox: { ...crop, x: 0.21 },
        },
      ],
    })

    for (const changed of [captionChanged, candidateChanged, cropChanged]) {
      expect(changed.visualRelationshipGraphSha256).not.toBe(
        baseline.visualRelationshipGraphSha256,
      )
      expect(canonicalJsonHash(changed)).not.toBe(canonicalJsonHash(baseline))
    }
    expect(JSON.stringify(baseline)).not.toContain('caption-node-private-1')
    expect(JSON.stringify(baseline)).not.toContain('visual-object-private-1')
  })

  it('redacts document text from successful diagnostic messages', () => {
    const privateMarker = 'private reconstructed paragraph'

    expect(
      safeAuditDiagnostic({
        code: 'LOW_CONFIDENCE_BLOCK',
        severity: 'warning',
        page: 3,
        message: `p-001-${privateMarker} needs reading-order review.`,
      }),
    ).toEqual({
      code: 'LOW_CONFIDENCE_BLOCK',
      severity: 'warning',
      page: 3,
      message: 'A reconstructed block requires reading-order review.',
    })
    expect(
      JSON.stringify(
        safeAuditDiagnostic({
          code: 'FUTURE_DIAGNOSTIC',
          severity: 'warning',
          message: privateMarker,
        }),
      ),
    ).not.toContain(privateMarker)
    expect(
      safeAuditDiagnostic({
        code: 'SOURCE_ORDER_FLOAT_FALLBACK',
        severity: 'info',
        page: 4,
        message: privateMarker,
      }),
    ).toEqual({
      code: 'SOURCE_ORDER_FLOAT_FALLBACK',
      severity: 'info',
      page: 4,
      message:
        'An optional float move was skipped to preserve source-proved order.',
    })
  })

  it('counts every diagnostic while emitting only bounded deterministic samples', () => {
    const diagnostics = Array.from({ length: 100 }, (_, index) => ({
      code: index < 90 ? 'UNREFERENCED_VISUAL_ASSET' : 'AMBIGUOUS_VISUAL_MATCH',
      severity: 'warning',
      page: (index % 12) + 1,
      message: `private diagnostic ${index}`,
    }))
    const reversed = summarizeAuditDiagnostics([...diagnostics].reverse())
    const summary = summarizeAuditDiagnostics(diagnostics)

    expect(summary).toEqual(reversed)
    expect(summary.diagnosticCounts).toEqual({
      AMBIGUOUS_VISUAL_MATCH: 10,
      UNREFERENCED_VISUAL_ASSET: 90,
    })
    expect(summary.diagnosticSampleLimit).toEqual({ total: 64, perCode: 3 })
    expect(summary.diagnostics).toHaveLength(6)
    expect(summary.diagnosticSamplesTruncated).toBe(94)
    expect(JSON.stringify(summary)).not.toContain('private diagnostic')
  })

  it('reports only stable document identifiers and quality results', async () => {
    const result = spawnSync(
      process.execPath,
      [
        'tools/pdf-corpus-audit.mjs',
        '--report-only',
        'tests/fixtures/pdf/born-digital.pdf',
        'tests/fixtures/pdf/structured-scientific.pdf',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    )

    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout)
    const schema = JSON.parse(
      await readFile('docs/schemas/pdf-corpus-audit.schema.json', 'utf8'),
    )
    const reportValidator = new Ajv2020({ strict: false }).compile(schema)
    expect(reportValidator(report), reportValidator.errors).toBe(true)
    expect(report).toMatchObject({
      schemaVersion: '1.5.0',
      privacy: 'basenames-hashes-metrics-diagnostics-only',
      summary: {
        documents: 2,
        ready: 2,
        reviewRequired: 0,
        failed: 0,
        passRate: 1,
        failureReasons: {},
      },
    })
    expect(report.documents.map((document) => document.basename)).toEqual([
      'born-digital.pdf',
      'structured-scientific.pdf',
    ])
    expect(report.documents.every((document) => document.sha256)).toBe(true)
    expect(
      report.documents.every(
        (document) =>
          Number.isInteger(document.diagnosticSamplesTruncated) &&
          document.diagnosticSamplesTruncated >= 0 &&
          document.diagnosticSampleLimit.total === 64 &&
          document.diagnosticSampleLimit.perCode === 3 &&
          document.diagnostics.length + document.diagnosticSamplesTruncated ===
            Object.values(document.diagnosticCounts).reduce(
              (total, count) => total + count,
              0,
            ),
      ),
    ).toBe(true)
    expect(
      report.documents.every(
        (document) =>
          document.structure?.schemaVersion === '1.3.0' &&
          document.structure.canonicalNodeCount > 0 &&
          /^[a-f0-9]{64}$/.test(
            document.structure.canonicalNodeSequenceSha256,
          ) &&
          /^[a-f0-9]{64}$/.test(document.structure.canonicalContentSha256) &&
          /^[a-f0-9]{64}$/.test(
            document.structure.visualRelationshipGraphSha256,
          ) &&
          /^[a-f0-9]{64}$/.test(document.structure.assetManifestSha256) &&
          document.structure.unresolvedCorruptingJoinCount +
            document.structure.structurallyConsumedLineBoundaryCount <=
            document.structure.lineTransitionCount,
      ),
    ).toBe(true)
    expect(result.stdout).not.toContain(resolve('.'))
    expect(result.stdout).not.toContain(
      'Synthetic semantic completeness fixture',
    )
  })

  it('requires a complete corpus-contract option pair and rejects a substituted set before audit', () => {
    const missingSet = spawnSync(
      process.execPath,
      [
        'tools/pdf-corpus-audit.mjs',
        '--report-only',
        '--corpus-contract',
        'benchmarks/pdf/corpus-contract-v1.json',
        'tests/fixtures/pdf/born-digital.pdf',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    )
    const substituted = spawnSync(
      process.execPath,
      [
        'tools/pdf-corpus-audit.mjs',
        '--report-only',
        '--corpus-contract',
        'benchmarks/pdf/corpus-contract-v1.json',
        '--corpus-set',
        'frozen',
        'tests/fixtures/pdf/born-digital.pdf',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    )

    expect(missingSet.status).toBe(2)
    expect(missingSet.stderr).toContain('--corpus-contract')
    expect(substituted.status).toBe(2)
    expect(substituted.stderr).toBe('PDF corpus contract binding failed.\n')
    expect(substituted.stdout).toBe('')
  })

  it('redacts parser failures and supplies PDF.js standard-font assets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-corpus-private-'))
    const path = join(directory, 'private-corrupt.pdf')
    const privateMarker = 'private parser payload must never enter the report'
    try {
      await writeFile(path, `%PDF-1.7\n${privateMarker}\n`)
      const result = spawnSync(
        process.execPath,
        ['tools/pdf-corpus-audit.mjs', '--report-only', path],
        { encoding: 'utf8', timeout: 120_000 },
      )

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        summary: { documents: 1, ready: 0, reviewRequired: 0, failed: 1 },
        documents: [
          {
            basename: 'private-corrupt.pdf',
            sha256: null,
            code: 'PDF_PARSE_FAILED',
            message:
              'The PDF parser could not open the document; local path and document details were suppressed.',
          },
        ],
      })
      expect(result.stdout).not.toContain(directory)
      expect(result.stdout).not.toContain(privateMarker)
      expect(result.stderr).not.toContain('standardFontDataUrl')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('streams multiple opt-in private overlays outside the repository without widening the report', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-corpus-overlays-'))
    try {
      const result = spawnSync(
        process.execPath,
        [
          'tools/pdf-corpus-audit.mjs',
          '--report-only',
          '--overlay-output',
          directory,
          'tests/fixtures/pdf/diagnostic-overlays.pdf',
          'tests/fixtures/pdf/born-digital.pdf',
        ],
        { encoding: 'utf8', timeout: 120_000 },
      )

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        privacy: 'basenames-hashes-metrics-diagnostics-only',
        summary: { documents: 2, ready: 1, reviewRequired: 1 },
      })
      const artifacts = await readdir(directory)
      expect(artifacts).toHaveLength(2)
      const diagnosticArtifact = artifacts.find((artifact) =>
        artifact.startsWith('diagnostic-overlays-'),
      )
      expect(diagnosticArtifact).toMatch(
        /^diagnostic-overlays-[a-f0-9]{16}\.diagnostics\.html$/,
      )
      const html = await readFile(join(directory, diagnosticArtifact), 'utf8')
      expect(html).toContain('pdf-diagnostic-overlay__svg')
      expect(html).toContain('Candidate A · left column then right column')
      expect(result.stdout).not.toContain(directory)
      expect(result.stdout).not.toContain(
        'This deliberately wide source region',
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses corpus overlay output anywhere inside the repository', () => {
    const result = spawnSync(
      process.execPath,
      [
        'tools/pdf-corpus-audit.mjs',
        '--report-only',
        '--overlay-output',
        '.agent/evidence/private-corpus',
        'tests/fixtures/pdf/born-digital.pdf',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    )

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('outside the repository')
    expect(result.stderr).not.toContain(resolve('.'))
  })
})

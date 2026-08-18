import { describe, expect, it } from 'vitest'
import type { PdfReconstruction } from './import-types'
import { pdfEvidenceBundlesFromReconstruction } from './pdf-source-evidence'
import { sha256HexSync } from './sha256-sync'
import { validatePdfEvidenceBundle } from './source-evidence-graph'

const sourceSha256 = '1'.repeat(64)
const renderBytes = new TextEncoder().encode('rendered page')
const renderSha256 = sha256HexSync(renderBytes)

function reconstruction(
  kind: PdfReconstruction['pages'][number]['kind'] = 'born-digital',
): PdfReconstruction {
  return {
    source: {
      fileName: 'ordinary.pdf',
      byteLength: 4096,
      sha256: sourceSha256,
      pageCount: 1,
      localOnly: true,
    },
    paper: { id: 'ordinary-document' },
    pages: [
      {
        page: 1,
        kind,
        width: 612,
        height: 792,
        rotation: 0,
        textCharacters: 11,
        imageCount: 0,
        runs: [
          {
            page: 1,
            text: 'Source text',
            x: 0.1,
            y: 0.2,
            width: 0.2,
            height: 0.02,
            rotation: 0,
            method: 'pdf-text',
            fontName: 'Fixture Serif',
            fontSize: 10,
            confidence: 1,
          },
        ],
      },
    ],
    regions: [],
    readingOrder: { edges: [] },
    noteRelationships: [],
    citationRelationships: [],
    crossReferenceRelationships: [],
    visualRelationships: [],
    assets: [],
  } as unknown as PdfReconstruction
}

function renderEvidence() {
  return {
    page: 1,
    mediaType: 'image/png' as const,
    sha256: renderSha256,
    byteLength: renderBytes.byteLength,
    width: 1224,
    height: 1584,
    bytes: renderBytes,
  }
}

describe('deterministic PDF source evidence', () => {
  it('retains text, fonts, normalized page geometry, and every-page renders in a valid graph', () => {
    const extracted = pdfEvidenceBundlesFromReconstruction(reconstruction(), {
      pageRenders: [renderEvidence()],
    })
    const bundle = extracted.bundles[0]!
    expect(bundle.sources.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(['page-geometry', 'font', 'text-glyph-run']),
    )
    expect(bundle.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'full-page-render',
          sha256: renderSha256,
          box: expect.objectContaining({ width: 1, height: 1 }),
        }),
      ]),
    )

    expect(() => validatePdfEvidenceBundle(bundle)).not.toThrow()
  })

  it('fails closed when an ordinary page render is missing', () => {
    expect(() =>
      pdfEvidenceBundlesFromReconstruction(reconstruction(), {
        pageRenders: [],
      }),
    ).toThrow('MISSING_PDF_FULL_PAGE_RENDER_EVIDENCE')
  })

  it('fails closed when a hybrid page lacks configured local OCR evidence', () => {
    expect(() =>
      pdfEvidenceBundlesFromReconstruction(reconstruction('mixed'), {
        pageRenders: [renderEvidence()],
      }),
    ).toThrow('PDF_LOCAL_OCR_EVIDENCE_REQUIRED')
  })

  it('keeps OCR conflict candidates valid with the deterministic complete-page fallback', () => {
    const input = reconstruction('mixed')
    input.pages[0]!.ocr = {
      engine: 'fixture-ocr',
      engineVersion: '1.0.0',
      model: 'fixture-model',
      modelVersion: '1',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256,
      rasterSha256: renderSha256,
      confidence: 0.8,
      words: [
        {
          text: 'S0urce',
          confidence: 0.6,
          lineId: 'ocr-line-1',
          box: {
            page: 1,
            x: 0.1,
            y: 0.2,
            width: 0.2,
            height: 0.02,
            rotation: 0,
            method: 'ocr',
          },
          mergeStatus: 'conflict',
        },
      ],
      lines: [
        {
          id: 'ocr-line-1',
          text: 'S0urce text',
          confidence: 0.6,
          box: {
            page: 1,
            x: 0.1,
            y: 0.2,
            width: 0.2,
            height: 0.02,
            rotation: 0,
            method: 'ocr',
          },
        },
      ],
    }
    const extracted = pdfEvidenceBundlesFromReconstruction(input, {
      pageRenders: [renderEvidence()],
    })
    const ocrBundle = extracted.bundles.find(({ armId }) =>
      armId.startsWith('ocr-'),
    )!
    const deterministicBundle = extracted.bundles.find(
      ({ armId }) => armId === 'deterministic',
    )!
    const disagreement = extracted.disagreements.find(
      ({ kind }) => kind === 'ocr-conflict',
    )!
    expect(disagreement.providerIds).toEqual(
      [deterministicBundle.provider.id, ocrBundle.provider.id].sort(),
    )
    expect(
      disagreement.candidateIds.some((candidateId) =>
        deterministicBundle.candidates.some(
          ({ id, kind }) => id === candidateId && kind === 'full-page-render',
        ),
      ),
    ).toBe(true)
  })

  it('retains source-proved semantic table spans in the selected graph candidate', () => {
    const input = reconstruction()
    input.paper = {
      id: 'ordinary-document',
      nodes: [
        {
          id: 'table-node',
          type: 'figure',
          title: 'Table 1',
          objectType: 'table',
          table: {
            rows: [
              {
                cells: [
                  {
                    text: 'Header',
                    headerScope: 'column',
                    rowSpan: 1,
                    columnSpan: 2,
                  },
                ],
              },
            ],
          },
        },
      ],
    } as PdfReconstruction['paper']
    input.visualRelationships = [
      {
        id: 'table-relationship',
        kind: 'table',
        label: 'Table 1',
        captionRegionId: 'caption-region',
        sourceRegionIds: [],
        sourceObjectIds: [],
        assetIds: [],
        status: 'matched',
        confidence: 1,
        evidence: ['semantic-table-source'],
        candidates: [],
        sourceBoxes: [
          {
            page: 1,
            x: 0.1,
            y: 0.2,
            width: 0.2,
            height: 0.02,
            rotation: 0,
            method: 'pdf-text',
          },
        ],
        sourceText: 'Header',
        altText: 'Table 1',
        altTextSource: 'caption',
        canonicalNodeId: 'table-node',
        captionNodeId: null,
      },
    ]

    const extracted = pdfEvidenceBundlesFromReconstruction(input, {
      pageRenders: [renderEvidence()],
    })
    const selected = extracted.bundles[0]!.candidates.find(
      ({ kind }) => kind === 'table-relationship',
    )

    expect(selected?.payload).toMatchObject({
      semanticTable: {
        rows: [
          {
            cells: [expect.objectContaining({ rowSpan: 1, columnSpan: 2 })],
          },
        ],
      },
    })
    expect(() => validatePdfEvidenceBundle(extracted.bundles[0]!)).not.toThrow()
  })
})

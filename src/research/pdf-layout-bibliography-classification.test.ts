import { describe, expect, it } from 'vitest'
import type {
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
} from './import-types'
import {
  reconstructPageAnalyses,
  synthesizeRecoveredBibliographyClassifications,
} from './pdf-layout'
import { PDF_HYPHEN_LEXICAL_MODEL } from './pdf-hyphenation'
import { assessPdfCompleteness } from './pdf-quality'

function run(
  page: number,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
): PdfSourceRun {
  return {
    page,
    text,
    x,
    y,
    width,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
    fontName: fontSize > 12 ? 'Heading' : 'Body',
    fontSize,
    confidence: 1,
  }
}

function page(
  number: number,
  runs: PdfSourceRun[],
  kind: PdfPageAnalysis['kind'] = 'born-digital',
): PdfPageAnalysis {
  return {
    page: number,
    kind,
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: kind === 'born-digital' ? 0 : 1,
    runs,
  }
}

function withExplicitEnglishLanguage(page: PdfPageAnalysis): PdfPageAnalysis {
  return {
    ...page,
    ocr: {
      engine: 'test-language-authority',
      engineVersion: '1',
      model: 'test-en',
      modelVersion: '1',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: '1'.repeat(64),
      rasterSha256: '2'.repeat(64),
      confidence: 1,
      words: [],
      lines: [],
    },
  }
}

describe('PDF semantic reconstruction', () => {
  it('synthesizes an exact later marker classification when one bibliography region is split', () => {
    const firstText = '[1] First source-backed reference.'
    const secondText = '[2] Second source-backed reference.'
    const sourceText = `${firstText} ${secondText}`
    const firstRun = run(2, firstText, 0.1, 0.2, 0.72)
    const secondRun = run(2, secondText, 0.1, 0.222, 0.72)
    const sourceRegion = {
      id: 'merged-bibliography-region',
      page: 2,
      kind: 'endnote',
      column: 'single',
      text: sourceText,
      confidence: 1,
      box: {
        page: 2,
        x: 0.1,
        y: 0.2,
        width: 0.72,
        height: 0.04,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [firstRun, secondRun].map((sourceRun, index) => ({
        id: `merged-reference-line-${index + 1}`,
        text: sourceRun.text,
        fontSize: sourceRun.fontSize,
        box: { ...sourceRun },
        runs: [{ ...sourceRun }],
      })),
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies import('./import-types').PdfPageRegion
    const secondSourceStart = firstText.length + 1
    const evidenceRegion = {
      ...sourceRegion,
      text: secondText,
      box: { ...secondRun },
      lines: [sourceRegion.lines[1]],
    }
    const classifications = synthesizeRecoveredBibliographyClassifications(
      [
        {
          id: 'existing-reference-1',
          label: '1',
          referenceRegionId: sourceRegion.id,
          start: 0,
          end: 3,
          taxonomy: 'bibliography-entry',
          disposition: 'plain-text',
          confidence: 0.99,
          threshold: 0.85,
          accepted: true,
          evidence: ['source-backed-bibliography-marker'],
          sourceBox: { ...firstRun },
        },
      ],
      [
        {
          region: evidenceRegion,
          list: {
            numberingId: 'references',
            ordinal: 2,
            markerText: '[2]',
          },
          sourceSegments: [
            {
              region: sourceRegion,
              evidenceRegion,
              sourceStart: secondSourceStart + 4,
              canonicalStart: 0,
              text: 'Second source-backed reference.',
            },
          ],
        },
      ],
    )

    expect(classifications).toHaveLength(2)
    expect(classifications[1]).toMatchObject({
      label: '2',
      referenceRegionId: sourceRegion.id,
      start: secondSourceStart,
      end: secondSourceStart + 3,
      taxonomy: 'bibliography-entry',
      accepted: true,
      sourceBox: secondRun,
    })
    expect(
      sourceRegion.text.slice(classifications[1].start, classifications[1].end),
    ).toBe('[2]')
  })

  it('maps citations to every numbered bibliography entry', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
          run(
            1,
            'Prior work [1, 2] establishes the baseline.',
            0.1,
            0.24,
            0.72,
          ),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[1] First source-backed reference.', 0.1, 0.82, 0.72, 7),
          run(2, '[2] Second source-backed reference.', 0.1, 0.838, 0.72, 7),
        ]),
      ],
      sourceHash: '6'.repeat(64),
      fileName: 'merged-numbered-references.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(references).toHaveLength(2)
    expect(references.map((node) => node.list?.ordinal)).toEqual([1, 2])

    const bibliographyClassifications = result.diagnostics.flatMap(
      (diagnostic) =>
        diagnostic.noteMarkerClassification?.taxonomy === 'bibliography-entry'
          ? [diagnostic.noteMarkerClassification]
          : [],
    )
    expect(
      bibliographyClassifications.map((classification) => ({
        label: classification.label,
        sourceText: result.regions
          .find((region) => region.id === classification.referenceRegionId)!
          .text.slice(classification.start, classification.end),
      })),
    ).toEqual([
      { label: '1', sourceText: '[1]' },
      { label: '2', sourceText: '[2]' },
    ])
    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['1', '2'],
        status: 'matched',
        targetNodeIds: [references[0].id, references[1].id],
      }),
    ])
    expect(result.provenance[references[0].id].regionIds).not.toEqual(
      result.provenance[references[1].id].regionIds,
    )
    expect(result.provenance[references[0].id].boxes).not.toEqual(
      result.provenance[references[1].id].boxes,
    )
  })

  it('keeps a partially missing citation cluster unresolved', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
          run(
            1,
            'Prior work [1, 2] establishes the baseline.',
            0.1,
            0.24,
            0.72,
          ),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[1] First competing reference.', 0.1, 0.22, 0.72),
          run(2, '[1] Second competing reference.', 0.1, 0.3, 0.72),
        ]),
      ],
      sourceHash: '1'.repeat(64),
      fileName: 'partially-missing-citation-cluster.pdf',
      byteLength: 4096,
    })

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['1', '2'],
        status: 'unresolved',
        targetNodeIds: [],
        candidateNodeIds: [expect.any(String), expect.any(String)],
        evidence: expect.arrayContaining(['bibliography-label-target-missing']),
      }),
    ])
  })

  it('keeps citation-led body prose outside the bibliography list scope', async () => {
    const citationLedText =
      '[298] learn coordinated representations using a Cauchy loss to strengthen robustness to outliers.'
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'Introduction', 0.1, 0.16, 0.3, 16),
          run(1, 'Finally, Xu et al.', 0.1, 0.28, 0.72),
          run(1, citationLedText, 0.1, 0.42, 0.72),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(
            2,
            '[298] Chang Xu, Dacheng Tao, and Chao Xu. 2015. Multi-view intact space learning.',
            0.1,
            0.22,
            0.72,
          ),
        ]),
      ],
      sourceHash: '8'.repeat(64),
      fileName: 'citation-led-body-prose.pdf',
      byteLength: 4096,
    })

    const citationLedNode = result.paper.nodes.find(
      (node) => node.type === 'paragraph' && node.text === citationLedText,
    )
    expect(citationLedNode).toMatchObject({
      type: 'paragraph',
      text: citationLedText,
    })
    expect(citationLedNode).not.toHaveProperty('list')
    expect(
      citationLedNode &&
        'inlineRuns' in citationLedNode &&
        citationLedNode.inlineRuns,
    ).toEqual([
      expect.objectContaining({
        start: 0,
        end: 5,
        semanticRole: 'citation',
        targetIds: [expect.stringMatching(/^p-/u)],
      }),
    ])

    const references = result.paper.nodes.filter(
      (node) =>
        node.type === 'paragraph' && node.list?.numberingId === 'references',
    )
    expect(references).toHaveLength(1)
    expect(references[0]).toMatchObject({
      text: 'Chang Xu, Dacheng Tao, and Chao Xu. 2015. Multi-view intact space learning.',
      list: {
        markerText: '[298]',
        ordinal: 298,
        numberingId: 'references',
      },
    })
  })

  it('recovers an unheaded numbered bibliography entry only from strong author-year evidence', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'An Unheaded Source List', 0.1, 0.08, 0.7, 22),
          run(1, 'Conclusion', 0.1, 0.16, 0.3, 16),
          run(1, 'The source list follows.', 0.1, 0.28, 0.72),
          run(
            1,
            '[7] Ada Lovelace and Charles Babbage. 1843. Notes on the analytical engine.',
            0.1,
            0.54,
            0.72,
          ),
        ]),
      ],
      sourceHash: '7'.repeat(64),
      fileName: 'unheaded-numbered-bibliography.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.find(
        (node) =>
          node.type === 'paragraph' && node.list?.numberingId === 'references',
      ),
    ).toMatchObject({
      text: 'Ada Lovelace and Charles Babbage. 1843. Notes on the analytical engine.',
      list: {
        markerText: '[7]',
        ordinal: 7,
        numberingId: 'references',
      },
    })
  })

  it('merges markerless numbered-reference continuations into the preceding proven entry', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
          run(
            1,
            'Prior work [8, 9] establishes the baseline.',
            0.1,
            0.24,
            0.72,
          ),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(
            2,
            '[8] Guillermo Angeris, Tarun Chitra, and collaborators.',
            0.1,
            0.22,
            0.72,
          ),
          run(
            2,
            'The geometry of constant function market makers. arXiv preprint.',
            0.1,
            0.26,
            0.72,
          ),
          run(2, '[9] A separately labelled reference.', 0.1, 0.42, 0.72),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'numbered-reference-continuation.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(
      references.map((node) => ({
        text: node.text,
        ordinal: node.list?.ordinal,
        markerText: node.list?.markerText,
      })),
    ).toEqual([
      {
        text:
          'Guillermo Angeris, Tarun Chitra, and collaborators. ' +
          'The geometry of constant function market makers. arXiv preprint.',
        ordinal: 8,
        markerText: '[8]',
      },
      {
        text: 'A separately labelled reference.',
        ordinal: 9,
        markerText: '[9]',
      },
    ])
    expect(
      references.filter((node) => node.list?.markerText === undefined),
    ).toEqual([])
    expect(result.provenance[references[0].id].boxes).toHaveLength(2)
    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['8', '9'],
        status: 'matched',
        targetNodeIds: [references[0].id, references[1].id],
      }),
    ])
  })

  it('does not absorb a source-contiguous markerless bibliography entry into a numbered entry', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'References', 0.1, 0.14, 0.3, 16),
          run(1, '[1] A complete numbered reference.', 0.1, 0.22, 0.7),
          run(
            1,
            'Okafor, N. 2024. An independent markerless reference.',
            0.08,
            0.246,
            0.72,
          ),
          run(1, '[2] A second numbered reference.', 0.1, 0.29, 0.7),
        ]),
      ],
      sourceHash: 'm'.repeat(64),
      fileName: 'numbered-then-markerless-reference.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(
      references.map((node) => ({
        text: node.text,
        markerText: node.list?.markerText,
      })),
    ).toEqual([
      {
        text: 'A complete numbered reference.',
        markerText: '[1]',
      },
      {
        text: 'Okafor, N. 2024. An independent markerless reference.',
        markerText: undefined,
      },
      {
        text: 'A second numbered reference.',
        markerText: '[2]',
      },
    ])
  })

  it('does not let a learned hanging-indent profile absorb an independent markerless bibliography entry', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.05, 0.7, 22),
          run(1, 'References', 0.1, 0.12, 0.3, 16),
          run(1, '[1] First numbered entry', 0.1, 0.2, 0.7),
          run(1, 'continued first details.', 0.13, 0.225, 0.67),
          run(1, '[2] Second numbered entry', 0.1, 0.26, 0.7),
          run(1, 'continued second details.', 0.13, 0.285, 0.67),
          run(1, '[3] A third numbered entry', 0.1, 0.32, 0.7),
          run(1, 'with completed venue details.', 0.13, 0.345, 0.67),
          run(
            1,
            'Research Collective. New benchmark paper. 2024.',
            0.13,
            0.37,
            0.67,
          ),
          run(1, '[4] A fourth numbered entry.', 0.1, 0.415, 0.7),
        ]),
      ],
      sourceHash: 'h'.repeat(64),
      fileName: 'profiled-numbered-then-markerless-reference.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(
      references.map((node) => ({
        text: node.text,
        markerText: node.list?.markerText,
      })),
    ).toEqual([
      {
        text: 'First numbered entry continued first details.',
        markerText: '[1]',
      },
      {
        text: 'Second numbered entry continued second details.',
        markerText: '[2]',
      },
      {
        text: 'A third numbered entry with completed venue details.',
        markerText: '[3]',
      },
      {
        text: 'Research Collective. New benchmark paper. 2024.',
        markerText: undefined,
      },
      {
        text: 'A fourth numbered entry.',
        markerText: '[4]',
      },
    ])
  })

  it('does not merge a markerless bibliography block from a different column flow', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.08, 0.04, 0.84, 22),
          run(1, 'References', 0.08, 0.12, 0.3, 16),
          run(1, '[1] First left-column reference.', 0.08, 0.2, 0.38),
          run(1, '[2] Second left-column reference.', 0.08, 0.25, 0.38),
          run(1, '[3] Third left-column reference.', 0.08, 0.3, 0.38),
          run(
            1,
            'continued venue details for separate material.',
            0.55,
            0.2,
            0.37,
          ),
          run(1, '[4] First right-column reference.', 0.55, 0.25, 0.37),
          run(1, '[5] Second right-column reference.', 0.55, 0.3, 0.37),
        ]),
      ],
      sourceHash: 'n'.repeat(64),
      fileName: 'different-flow-markerless-reference.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(
      references.find((node) => node.list?.markerText === '[3]')?.text,
    ).toBe('Third left-column reference.')
    expect(
      references.some(
        (node) =>
          node.list?.markerText === undefined &&
          node.text === 'continued venue details for separate material.',
      ),
    ).toBe(true)
  })

  it('does not bridge a large same-page source gap for a markerless bibliography block', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'References', 0.1, 0.14, 0.3, 16),
          run(1, '[1] A complete numbered reference.', 0.1, 0.22, 0.7),
          run(
            1,
            'continued venue details after unrelated intervening space.',
            0.1,
            0.52,
            0.7,
          ),
        ]),
      ],
      sourceHash: 'g'.repeat(64),
      fileName: 'large-gap-markerless-reference.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(references.map((node) => node.text)).toEqual([
      'A complete numbered reference.',
      'continued venue details after unrelated intervening space.',
    ])
  })

  it('fails closed when a profiled lowercase bibliography continuation crosses a large same-page source gap', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.05, 0.7, 22),
          run(1, 'References', 0.1, 0.12, 0.3, 16),
          run(1, '[1] First numbered entry', 0.1, 0.2, 0.7),
          run(1, 'continued first details.', 0.13, 0.225, 0.67),
          run(1, '[2] Second numbered entry', 0.1, 0.26, 0.7),
          run(1, 'continued second details.', 0.13, 0.285, 0.67),
          run(1, '[3] An apparently unfinished entry', 0.1, 0.32, 0.7),
          run(
            1,
            'continued details after unrelated intervening space.',
            0.13,
            0.52,
            0.67,
          ),
          run(1, '[4] A fourth numbered entry.', 0.1, 0.57, 0.7),
        ]),
      ],
      sourceHash: 'k'.repeat(64),
      fileName: 'profiled-large-gap-reference.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(references.map((node) => node.text)).toEqual([
      'First numbered entry continued first details.',
      'Second numbered entry continued second details.',
      'An apparently unfinished entry',
      'continued details after unrelated intervening space.',
      'A fourth numbered entry.',
    ])
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'LOW_CONFIDENCE_BLOCK',
      ),
    ).toEqual([
      expect.objectContaining({
        severity: 'warning',
        sourceBoxes: expect.arrayContaining([
          expect.objectContaining({ page: 1, y: 0.32 }),
          expect.objectContaining({ page: 1, y: 0.52 }),
        ]),
        target: {
          regionIds: expect.arrayContaining([
            expect.any(String),
            expect.any(String),
          ]),
          markerId: null,
        },
      }),
    ])
  })

  it('does not merge an adjacent-page bibliography block without page-boundary geometry', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'References', 0.1, 0.14, 0.3, 16),
          run(1, '[1] An apparently unfinished entry', 0.1, 0.4, 0.7),
        ]),
        page(2, [
          run(
            2,
            'continued details that lack a proven page boundary.',
            0.1,
            0.12,
            0.7,
          ),
        ]),
      ],
      sourceHash: 'p'.repeat(64),
      fileName: 'unproven-cross-page-numbered-reference.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(references.map((node) => node.text)).toEqual([
      'An apparently unfinished entry',
      'continued details that lack a proven page boundary.',
    ])
  })

  it('fails closed on an unproved proper-name hyphen across bibliography pages', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.05, 0.7, 22),
          run(1, 'Rajeev introduced the cited method.', 0.1, 0.12, 0.7),
          run(1, 'References', 0.1, 0.7, 0.3, 16),
          run(1, '[1] A. Example and Ra-', 0.1, 0.84, 0.7),
        ]),
        page(2, [
          run(2, 'jeev Nayak. Complete venue details, 2025.', 0.13, 0.12, 0.67),
        ]),
      ],
      sourceHash: 'r'.repeat(64),
      fileName: 'cross-page-discretionary-reference.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(references).toEqual([
      expect.objectContaining({
        text: 'A. Example and Ra-jeev Nayak. Complete venue details, 2025.',
      }),
    ])
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'CANONICAL_FLOW_ORDER_VIOLATION',
    )
    expect(result.canonicalHyphenBoundaryDecisions).toEqual([])
  })

  it('persists complete lexical proof for a bibliography continuation deletion', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        withExplicitEnglishLanguage(
          page(1, [
            run(1, 'A Citation Study', 0.1, 0.05, 0.7, 22),
            run(
              1,
              'Additionally, this sentence supplies the exact joined form.',
              0.1,
              0.12,
              0.7,
            ),
            run(1, 'References', 0.1, 0.7, 0.3, 16),
            run(1, '[1] A. Example. Addition-', 0.1, 0.84, 0.7),
          ]),
        ),
        page(2, [
          run(
            2,
            'ally, complete venue details follow, 2025.',
            0.13,
            0.12,
            0.67,
          ),
        ]),
      ],
      sourceHash: 'y'.repeat(64),
      fileName: 'proved-cross-page-reference-hyphen.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.find(
        (node) =>
          node.type === 'paragraph' && node.list?.numberingId === 'references',
      ),
    ).toMatchObject({
      text: 'A. Example. Additionally, complete venue details follow, 2025.',
    })
    expect(result.canonicalHyphenBoundaryDecisions).toEqual([
      expect.objectContaining({
        id: expect.stringContaining('canonical-hyphen-boundary:'),
        context: 'bibliography-continuation',
        outcome: 'removed-discretionary-hyphen',
        fromRegionId: expect.stringContaining('page-001-region-'),
        fromLineId: expect.stringContaining('page-001-line-'),
        toRegionId: expect.stringContaining('page-002-region-'),
        toLineId: expect.stringContaining('page-002-line-'),
        geometry: {
          from: expect.objectContaining({ page: 1, y: 0.84 }),
          to: expect.objectContaining({ page: 2, y: 0.12 }),
        },
        proof: expect.objectContaining({
          sourceBoundaryProven: true,
          pinnedWord: 'Additionally',
          pinnedJoinedFormValid: true,
          pinnedSplit: {
            left: 'Addition',
            right: 'ally',
            index: 8,
          },
          splitPointValid: true,
          exactSameDocumentJoinedForm: 'Additionally',
          sameDocumentJoinedFormValid: true,
          hardHyphenForm: 'Addition-ally',
          hardHyphenCounterproof: null,
          model: expect.objectContaining({
            id: 'scowl-2020.12.07+ushyphmax-2005-05-30',
          }),
          evidence: expect.arrayContaining([
            'source-proven-wrapped-line-boundary',
            'joined-form-valid:pinned-lexicon',
            'split-point-valid:pinned-hyphenation-pattern',
            'same-document-unhyphenated-word',
            'hard-hyphen-form-not-proved',
          ]),
        }),
      }),
    ])
    expect(result.canonicalHyphenBoundaryDecisionCount).toBe(1)
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'INVALID_CANONICAL_HYPHEN_BOUNDARY_LEDGER',
    )

    const reassess = (decisions: unknown, expectedCount: number) =>
      assessPdfCompleteness({
        pages: result.pages,
        paper: result.paper,
        diagnostics: result.diagnostics.filter(
          (diagnostic) =>
            diagnostic.code !== 'INVALID_CANONICAL_HYPHEN_BOUNDARY_LEDGER',
        ),
        readingOrder: result.readingOrder,
        regions: result.regions,
        visualRelationships: result.visualRelationships,
        assets: result.assets,
        citationRelationships: result.citationRelationships,
        noteRelationships: result.noteRelationships,
        policy: result.readiness.policy,
        lineBoundaryDecisions: result.lineBoundaryDecisions,
        canonicalHyphenBoundaryDecisions:
          decisions as typeof result.canonicalHyphenBoundaryDecisions,
        canonicalHyphenBoundaryDecisionCount: expectedCount,
        unresolvedCorruptingJoinCount: result.unresolvedCorruptingJoinCount,
        structurallyConsumedLineBoundaryCount:
          result.structurallyConsumedLineBoundaryCount,
        provenance: result.provenance,
        inlineSpanLedger: {
          expected: result.completeness.expectedInlineSpanCount,
          mapped: result.completeness.mappedInlineSpanCount,
        },
        hyperlinkLedger: {
          expected: result.completeness.expectedHyperlinkCount,
          mapped: result.completeness.mappedHyperlinkCount,
        },
        sourceSha256: result.source.sha256,
      })
    const malformed = structuredClone(result.canonicalHyphenBoundaryDecisions)
    malformed[0].proof.pinnedSplit.index += 1
    for (const [decisions, expectedCount] of [
      [undefined, 1],
      [[], 1],
      [malformed, 1],
      [
        [
          result.canonicalHyphenBoundaryDecisions[0],
          structuredClone(result.canonicalHyphenBoundaryDecisions[0]),
        ],
        2,
      ],
    ] as const) {
      expect(reassess(decisions, expectedCount).readiness).toMatchObject({
        ready: false,
        blockingDiagnosticCodes: expect.arrayContaining([
          'INVALID_CANONICAL_HYPHEN_BOUNDARY_LEDGER',
        ]),
      })
    }
    expect(
      result.lineBoundaryDecisions.some((decision) =>
        decision.id.startsWith('canonical-hyphen-boundary:'),
      ),
    ).toBe(false)
  })

  it('persists a distinct derived-affix proof for a same-document base word', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        withExplicitEnglishLanguage(
          page(1, [
            run(1, 'A Derived Word Study', 0.1, 0.05, 0.7, 22),
            run(
              1,
              'Parameterized models supply the exact same-document base word.',
              0.1,
              0.12,
              0.7,
            ),
            run(1, 'References', 0.1, 0.7, 0.3, 16),
            run(1, '[1] A. Example. Reparameter-', 0.1, 0.84, 0.7),
          ]),
        ),
        page(2, [
          run(
            2,
            'ized models are discussed in complete venue details, 2025.',
            0.13,
            0.12,
            0.67,
          ),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'proved-derived-prefix-reference-hyphen.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.find(
        (node) =>
          node.type === 'paragraph' && node.list?.numberingId === 'references',
      ),
    ).toMatchObject({
      text: 'A. Example. Reparameterized models are discussed in complete venue details, 2025.',
    })
    expect(result.canonicalHyphenBoundaryDecisions).toEqual([
      expect.objectContaining({
        context: 'bibliography-continuation',
        proof: {
          tier: 'same-document-derived-affix',
          sourceBoundaryProven: true,
          derivedWord: 'Reparameterized',
          productivePrefix: {
            kind: 'prefix',
            value: 're',
            affixClass: 'PFX',
            flag: 'A',
            crossProduct: true,
            affixSha256: PDF_HYPHEN_LEXICAL_MODEL.affixSha256,
          },
          baseWord: 'parameterized',
          pinnedBaseWordValid: true,
          pinnedSplit: {
            left: 'Reparameter',
            right: 'ized',
            index: 11,
          },
          splitPointValid: true,
          exactSameDocumentBaseWord: 'parameterized',
          sameDocumentBaseWordValid: true,
          hardHyphenForm: 'Reparameter-ized',
          hardHyphenCounterproof: null,
          model: PDF_HYPHEN_LEXICAL_MODEL,
          evidence: expect.arrayContaining([
            'joined-form-valid:same-document-derived-affix',
            'productive-prefix-valid:pinned-affix-model',
            'base-form-valid:pinned-lexicon',
            'same-document-unhyphenated-base-word',
            'hard-hyphen-form-not-proved',
          ]),
        },
      }),
    ])
    expect(result.canonicalHyphenBoundaryDecisionCount).toBe(1)
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'INVALID_CANONICAL_HYPHEN_BOUNDARY_LEDGER',
    )
  })

  it('does not merge an adjacent-page bibliography block from a horizontally incompatible flow', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.05, 0.7, 22),
          run(1, 'References', 0.1, 0.12, 0.3, 16),
          run(1, '[1] An unfinished reference entry', 0.1, 0.84, 0.32),
        ]),
        page(2, [
          run(
            2,
            'lowercase unrelated bibliography material.',
            0.55,
            0.12,
            0.34,
          ),
        ]),
      ],
      sourceHash: 'x'.repeat(64),
      fileName: 'cross-page-flow-mismatch-reference.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(references.map((node) => node.text)).toEqual([
      'An unfinished reference entry',
      'lowercase unrelated bibliography material.',
    ])
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'LOW_CONFIDENCE_BLOCK',
      ),
    ).toEqual([
      expect.objectContaining({
        severity: 'warning',
        sourceBoxes: [
          expect.objectContaining({ page: 1, x: 0.1, y: 0.84 }),
          expect.objectContaining({ page: 2, x: 0.55, y: 0.12 }),
        ],
      }),
    ])
  })
})

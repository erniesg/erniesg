import { describe, expect, it } from 'vitest'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { createSourcePageCropAsset } from './visual-assets'

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

function sourceOrderedPage(
  number: number,
  runs: PdfSourceRun[],
  kind: PdfPageAnalysis['kind'] = 'born-digital',
) {
  return page(
    number,
    runs.map((sourceRun, sourceSequenceIndex) => ({
      ...sourceRun,
      sourceSequenceIndex,
    })),
    kind,
  )
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
  it('removes a float-interrupted discretionary hyphen only with lexical and language proof', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        withExplicitEnglishLanguage(
          sourceOrderedPage(1, [
            run(1, 'Float-interrupted lexical prose', 0.12, 0.06, 0.68, 18),
            run(1, '1 Introduction', 0.12, 0.18, 0.3, 14),
            run(
              1,
              'Additionally, a separate sentence proves the unhyphenated token.',
              0.12,
              0.28,
              0.68,
            ),
            run(1, 'We observed frequent hallucination. ', 0.12, 0.82, 0.4),
            {
              ...run(1, 'Addition', 0.54, 0.82, 0.09),
              fontName: 'ABCDEF+NimbusRomNo9L-Medi',
            },
            {
              ...run(1, '-', 0.629, 0.82, 0.008),
              fontName: 'ABCDEF+NimbusRomNo9L-Medi',
            },
          ]),
        ),
        sourceOrderedPage(2, [
          run(2, 'Method', 0.12, 0.08, 0.12, 8),
          run(2, 'Score', 0.45, 0.08, 0.1, 8),
          run(2, 'DRAFT', 0.12, 0.105, 0.12, 8),
          run(2, '50.3', 0.45, 0.105, 0.1, 8),
          run(2, 'RE3', 0.12, 0.13, 0.12, 8),
          run(2, '59.7', 0.45, 0.13, 0.1, 8),
          run(2, 'Table 8: A source-authored prompt.', 0.12, 0.17, 0.68, 8),
          run(
            2,
            'ally, we filter out low-confidence attributes.',
            0.12,
            0.25,
            0.68,
          ),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'owned-float-discretionary-hyphen.pdf',
      byteLength: 4096,
      metadata: { title: 'Float-interrupted lexical prose' },
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 8,
          pixels: new Uint8Array(12 * 8 * 4).fill(96),
        }),
    })
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('We observed frequent hallucination.'),
    )

    expect(joined).toMatchObject({
      text: 'We observed frequent hallucination. Additionally, we filter out low-confidence attributes.',
    })
    expect(result.provenance[joined!.id]).toMatchObject({
      pages: [1, 2],
      regionIds: expect.arrayContaining([
        expect.stringContaining('page-001-region-'),
        expect.stringContaining('page-002-region-'),
      ]),
    })
    expect(result.completeness.inlineSpanCoverage).toBe(1)
    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 1,
      mappedInlineSpanCount: 1,
    })
    expect(result.sourceSemanticFlowBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topology: 'cross-page-column',
          outcome: 'discretionary-hyphen-delete',
        }),
      ]),
    )
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'CANONICAL_FLOW_ORDER_VIOLATION',
      ),
    ).toBe(false)
    expect(result.canonicalHyphenBoundaryDecisions).toEqual([
      expect.objectContaining({
        context: 'canonical-flow-continuation',
        outcome: 'removed-discretionary-hyphen',
        geometry: {
          from: expect.objectContaining({ page: 1, y: 0.82 }),
          to: expect.objectContaining({ page: 2, y: 0.25 }),
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
          hardHyphenCounterproof: null,
          evidence: expect.arrayContaining([
            'same-document-unhyphenated-word',
            'hard-hyphen-form-not-proved',
          ]),
        }),
      }),
    ])
  })

  it('does not jump lowercase prose across an unowned caption-shaped interruption', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Unowned interruption', 0.12, 0.06, 0.68, 18),
          run(
            1,
            'Additionally, this line proves the complete token.',
            0.12,
            0.28,
            0.68,
          ),
          run(1, 'A sentence ends with Addition-', 0.12, 0.82, 0.68),
        ]),
        page(2, [
          run(
            2,
            'Table 8: No bounded source scope exists for this caption.',
            0.12,
            0.17,
            0.68,
            8,
          ),
          run(
            2,
            'ally, this is a separate source paragraph.',
            0.12,
            0.25,
            0.68,
          ),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'unowned-float-continuation.pdf',
      byteLength: 4096,
      metadata: { title: 'Unowned interruption' },
    })
    const paragraphs = result.paper.nodes.filter(
      (node) => node.type === 'paragraph',
    )

    expect(
      paragraphs.some((node) => node.text.includes('Addition- ally')),
    ).toBe(false)
    expect(paragraphs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'A sentence ends with Addition-' }),
        expect.objectContaining({
          text: 'ally, this is a separate source paragraph.',
        }),
      ]),
    )
  })

  it('joins a source-contiguous numeric continuation after an incomplete prose boundary', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Numeric prose continuity', 0.1, 0.04, 0.8, 18),
          run(1, '1 Introduction', 0.1, 0.14, 0.3, 14),
          run(
            1,
            'We evaluated the system on a challenge set of',
            0.1,
            0.28,
            0.39,
          ),
          run(
            1,
            '178 enterprise bugs and recorded the outcomes.',
            0.1,
            0.315,
            0.39,
          ),
        ]),
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'numeric-prose-continuation.pdf',
      byteLength: 4096,
      metadata: { title: 'Numeric prose continuity' },
    })
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('We evaluated the system'),
    )

    expect(joined).toMatchObject({
      text: 'We evaluated the system on a challenge set of 178 enterprise bugs and recorded the outcomes.',
    })
  })

  it('fails closed on a lowercase hyphen continuation without source-boundary proof', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Unproved hyphen continuity', 0.12, 0.06, 0.68, 18),
          run(1, '1 Introduction', 0.12, 0.18, 0.3, 14),
          run(1, 'This paragraph contains an unproved frag-', 0.12, 0.4, 0.68),
        ]),
        page(2, [
          run(2, 'ment that begins a separate source block.', 0.12, 0.08, 0.68),
        ]),
      ],
      sourceHash: '8'.repeat(64),
      fileName: 'unproved-hyphen-continuation.pdf',
      byteLength: 4096,
      metadata: { title: 'Unproved hyphen continuity' },
    })
    const paragraphs = result.paper.nodes.filter(
      (node) => node.type === 'paragraph',
    )

    expect(paragraphs.some((node) => node.text.includes('frag- ment'))).toBe(
      false,
    )
    expect(paragraphs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'This paragraph contains an unproved frag-',
        }),
        expect.objectContaining({
          text: 'ment that begins a separate source block.',
        }),
      ]),
    )
    expect(result.canonicalHyphenBoundaryDecisions).toEqual([])
  })

  it('fails closed when source geometry exists but the hyphen form is unresolved', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Unresolved hyphen continuity', 0.12, 0.06, 0.68, 18),
          run(1, '1 Introduction', 0.12, 0.18, 0.3, 14),
          run(
            1,
            'Opening prose establishes the document body.',
            0.12,
            0.28,
            0.68,
          ),
          run(1, 'The source ends with an unresolved frag-', 0.12, 0.82, 0.68),
        ]),
        page(2, [
          run(2, 'ment that has no same-document proof.', 0.12, 0.08, 0.68),
        ]),
      ],
      sourceHash: '9'.repeat(64),
      fileName: 'unresolved-hyphen-continuation.pdf',
      byteLength: 4096,
      metadata: { title: 'Unresolved hyphen continuity' },
    })
    const paragraphs = result.paper.nodes.filter(
      (node) => node.type === 'paragraph',
    )

    expect(paragraphs.some((node) => node.text.includes('frag-ment'))).toBe(
      false,
    )
    expect(paragraphs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'The source ends with an unresolved frag-',
        }),
        expect.objectContaining({
          text: 'ment that has no same-document proof.',
        }),
      ]),
    )
    expect(result.canonicalHyphenBoundaryDecisions).toEqual([])
  })

  it('preserves a source-proven hard hyphen without inventing cross-page whitespace', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        sourceOrderedPage(1, [
          run(1, 'Hard-hyphen continuity', 0.12, 0.06, 0.68, 18),
          run(
            1,
            'A long-form baseline proves the source-authored compound.',
            0.12,
            0.28,
            0.68,
          ),
          run(1, 'The source uses long-', 0.12, 0.82, 0.68),
        ]),
        sourceOrderedPage(2, [
          run(2, 'form examples throughout the evaluation.', 0.12, 0.08, 0.68),
        ]),
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'hard-hyphen-cross-page-continuation.pdf',
      byteLength: 4096,
      metadata: { title: 'Hard-hyphen continuity' },
    })
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('The source uses long'),
    )

    expect(joined).toMatchObject({
      text: 'The source uses long-form examples throughout the evaluation.',
    })
    expect(result.provenance[joined!.id]).toMatchObject({
      pages: [1, 2],
    })
    expect(result.canonicalHyphenBoundaryDecisions).toEqual([])
    expect(result.sourceSemanticFlowBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topology: 'cross-page-column',
          outcome: 'hard-hyphen-retain',
        }),
      ]),
    )
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'CANONICAL_FLOW_ORDER_VIOLATION',
      ),
    ).toBe(false)
  })

  it('removes a source-proven wrap hyphen across adjacent same-page columns', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        withExplicitEnglishLanguage(
          page(1, [
            run(1, 'Column-boundary continuity', 0.1, 0.035, 0.8, 18),
            run(1, '1 Introduction', 0.09, 0.12, 0.3, 14),
            run(
              1,
              'A separate sentence proves interpretation as a complete token.',
              0.09,
              0.2,
              0.385,
            ),
            run(
              1,
              'Left-column body establishes the source reading geometry.',
              0.09,
              0.23,
              0.385,
            ),
            run(
              1,
              'A second left-column row confirms the stable gutter.',
              0.09,
              0.26,
              0.385,
            ),
            run(
              1,
              'A third left-column row completes the layout evidence.',
              0.09,
              0.29,
              0.385,
            ),
            run(
              1,
              'The final left-column sentence continues with inter-',
              0.09,
              0.8537,
              0.385,
            ),
            run(
              1,
              'pretation across the adjacent column boundary.',
              0.502,
              0.0847,
              0.385,
            ),
            run(
              1,
              'Right-column body continues after the repaired token.',
              0.502,
              0.1147,
              0.385,
            ),
            run(
              1,
              'A final right-column sentence closes the section.',
              0.502,
              0.1447,
              0.385,
            ),
            run(
              1,
              'An aligned right-column row confirms the stable gutter.',
              0.502,
              0.2,
              0.385,
            ),
            run(
              1,
              'Another right-column row keeps the source flow explicit.',
              0.502,
              0.23,
              0.385,
            ),
            run(
              1,
              'The last aligned right-column row completes the evidence.',
              0.502,
              0.26,
              0.385,
            ),
          ]),
        ),
      ],
      sourceHash: 'f'.repeat(64),
      fileName: 'same-page-column-wrap-hyphen.pdf',
      byteLength: 4096,
      metadata: { title: 'Column-boundary continuity' },
    })
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.includes('final left-column sentence'),
    )
    expect(joined?.type).toBe('paragraph')
    if (!joined || joined.type !== 'paragraph') {
      throw new Error('Expected the source-proven column continuation.')
    }
    expect(joined).toMatchObject({
      text: expect.stringContaining(
        'continues with interpretation across the adjacent column boundary.',
      ),
    })
    expect(joined.text).not.toContain('inter- pretation')
    expect(result.provenance[joined.id]).toMatchObject({
      pages: [1],
      regionIds: expect.arrayContaining([
        expect.stringContaining('page-001-region-'),
      ]),
    })
  })

  it('repairs a left-to-right wrap hyphen when the proved continuation begins midway down the right column', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        withExplicitEnglishLanguage(
          page(1, [
            run(1, 'Mid-column continuity', 0.1, 0.035, 0.8, 18),
            run(1, '1 Introduction', 0.09, 0.12, 0.3, 14),
            run(
              1,
              'A complete operation proves the unhyphenated token.',
              0.09,
              0.2,
              0.385,
            ),
            run(
              1,
              'The left column establishes stable source geometry.',
              0.09,
              0.28,
              0.385,
            ),
            run(
              1,
              'Another left row keeps the source lane explicit.',
              0.09,
              0.36,
              0.385,
            ),
            run(
              1,
              'Aligned left prose begins below the upper-page content.',
              0.09,
              0.52,
              0.385,
            ),
            run(
              1,
              'A second aligned left row confirms the gutter.',
              0.09,
              0.58,
              0.385,
            ),
            run(
              1,
              'A third aligned left row completes the proof.',
              0.09,
              0.64,
              0.385,
            ),
            run(
              1,
              'The final left-column sentence completes the oper-',
              0.09,
              0.82,
              0.385,
            ),
            run(
              1,
              'ation before the right-column discussion continues.',
              0.515,
              0.52,
              0.385,
            ),
            run(
              1,
              'A second aligned right row confirms the gutter.',
              0.515,
              0.58,
              0.385,
            ),
            run(
              1,
              'A third aligned right row completes the proof.',
              0.515,
              0.64,
              0.385,
            ),
          ]),
        ),
      ],
      sourceHash: '7'.repeat(64),
      fileName: 'same-page-mid-column-wrap-hyphen.pdf',
      byteLength: 4096,
      metadata: { title: 'Mid-column continuity' },
    })
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.includes('final left-column sentence'),
    )

    expect(joined).toMatchObject({
      text: expect.stringContaining(
        'completes the operation before the right-column discussion continues.',
      ),
    })
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'CANONICAL_FLOW_ORDER_VIOLATION',
      ),
    ).toBe(false)
  })

  it('does not absorb an unattested small-font block from deep in the right column', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Mid-column fail-closed continuity', 0.1, 0.035, 0.8, 18),
          run(1, '1 Introduction', 0.09, 0.12, 0.3, 14),
          run(
            1,
            'The left column establishes stable source geometry.',
            0.09,
            0.28,
            0.385,
          ),
          run(
            1,
            'Another left row keeps the source lane explicit.',
            0.09,
            0.36,
            0.385,
          ),
          run(
            1,
            'Aligned left prose begins below the upper-page content.',
            0.09,
            0.52,
            0.385,
          ),
          run(
            1,
            'A second aligned left row confirms the gutter.',
            0.09,
            0.58,
            0.385,
          ),
          run(
            1,
            'A third aligned left row completes the proof.',
            0.09,
            0.64,
            0.385,
          ),
          run(
            1,
            'The final left-column sentence ends with an unattested oper-',
            0.09,
            0.82,
            0.385,
          ),
          run(
            1,
            'ation belongs to a small unrelated annotation.',
            0.515,
            0.52,
            0.385,
            7,
          ),
          run(
            1,
            'A second aligned right row confirms the gutter.',
            0.515,
            0.58,
            0.385,
          ),
          run(
            1,
            'A third aligned right row completes the proof.',
            0.515,
            0.64,
            0.385,
          ),
        ]),
      ],
      sourceHash: '6'.repeat(64),
      fileName: 'same-page-mid-column-unattested-hyphen.pdf',
      byteLength: 4096,
      metadata: { title: 'Mid-column fail-closed continuity' },
    })
    const canonicalText = result.paper.nodes
      .flatMap((node) => ('text' in node ? [node.text] : []))
      .join('\n')

    expect(canonicalText).not.toContain(
      'unattested operation belongs to a small unrelated annotation',
    )
    expect(canonicalText).toContain('unattested oper-')
    expect(
      result.regions.some((region) =>
        region.text.includes('ation belongs to a small unrelated annotation.'),
      ),
    ).toBe(true)
  })

  it('joins one paragraph across an owned figure at an adjacent-column boundary', async () => {
    const sourcePage = page(1, [
      run(1, 'Adjacent-column figure continuity', 0.1, 0.035, 0.8, 18),
      run(1, '1 Introduction', 0.09, 0.12, 0.3, 14),
      run(
        1,
        'Left-column context establishes the source reading geometry.',
        0.09,
        0.2,
        0.385,
      ),
      run(
        1,
        'A second left-column row confirms the stable gutter.',
        0.09,
        0.3,
        0.385,
      ),
      run(
        1,
        'A third left-column row completes the layout evidence.',
        0.09,
        0.4,
        0.385,
      ),
      run(
        1,
        'Lower left-column prose keeps the first source lane active.',
        0.09,
        0.64,
        0.385,
      ),
      run(
        1,
        'Another lower left-column row preserves the stable gutter.',
        0.09,
        0.68,
        0.385,
      ),
      run(
        1,
        'The lower left-column discussion continues toward its boundary.',
        0.09,
        0.72,
        0.385,
      ),
      run(
        1,
        'A final lower left-column row retains the proved source flow.',
        0.09,
        0.76,
        0.385,
      ),
      run(
        1,
        'The method scales to longer samples with further',
        0.09,
        0.84,
        0.385,
      ),
      run(1, 'Input', 0.58, 0.2, 0.12, 8),
      run(1, 'Transform', 0.58, 0.24, 0.12, 8),
      run(1, 'Output', 0.58, 0.28, 0.12, 8),
      run(
        1,
        'Figure 12: Source-backed scaling overview.',
        0.515,
        0.61,
        0.385,
        8,
      ),
      run(
        1,
        'length increases limited only by evaluation.',
        0.515,
        0.67,
        0.385,
      ),
      run(
        1,
        'Right-column context continues after the repaired sentence.',
        0.515,
        0.72,
        0.385,
      ),
      run(
        1,
        'A second right-column row confirms the stable gutter.',
        0.515,
        0.76,
        0.385,
      ),
      run(
        1,
        'A third right-column row completes the layout evidence.',
        0.515,
        0.8,
        0.385,
      ),
    ])
    sourcePage.imageCount = 1
    sourcePage.objects = [
      {
        id: 'adjacent-column-figure-object',
        page: 1,
        kind: 'image',
        box: {
          page: 1,
          x: 0.54,
          y: 0.18,
          width: 0.33,
          height: 0.39,
          rotation: 0,
          method: 'pdf-object',
        },
        confidence: 1,
        assetId: null,
        role: 'semantic',
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [sourcePage],
      sourceHash: '6'.repeat(64),
      fileName: 'adjacent-column-owned-figure.pdf',
      byteLength: 4096,
      metadata: { title: 'Adjacent-column figure continuity' },
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 8,
          pixels: new Uint8Array(12 * 8 * 4).fill(96),
        }),
    })
    const visual = result.visualRelationships.find(
      (relationship) => relationship.label === 'Figure 12',
    )
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.includes('The method scales to longer samples'),
    )
    expect(visual).toMatchObject({
      status: 'matched',
      canonicalNodeId: expect.any(String),
    })
    expect(joined).toMatchObject({
      text: expect.stringContaining(
        'The method scales to longer samples with further length increases limited only by evaluation.',
      ),
    })
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' && node.text.startsWith('length increases'),
      ),
    ).toEqual([])
    expect(
      result.paper.nodes.findIndex((node) => node.id === joined?.id),
    ).toBeLessThan(
      result.paper.nodes.findIndex(
        (node) => node.id === visual?.canonicalNodeId,
      ),
    )
  })

  it('does not let an owned vertical float split two source-backed halves of one prose sentence', async () => {
    const sourcePage = page(1, [
      run(1, 'Vertical float sentence continuity', 0.1, 0.035, 0.8, 18),
      run(1, '1 Source-backed section', 0.12, 0.12, 0.4, 14),
      run(
        1,
        'Ordinary prose establishes the body typography.',
        0.12,
        0.19,
        0.68,
      ),
      run(1, 'The source-backed sentence continues with', 0.12, 0.25, 0.68),
      run(1, 'Figure 9: A bounded source-backed process.', 0.12, 0.57, 0.68, 8),
      run(1, 'a deterministic conclusion after the float.', 0.12, 0.63, 0.68),
      run(
        1,
        'A separate sentence follows the completed thought.',
        0.12,
        0.69,
        0.68,
      ),
    ])
    sourcePage.imageCount = 1
    sourcePage.objects = [
      {
        id: 'vertical-float-object',
        page: 1,
        kind: 'image',
        box: {
          page: 1,
          x: 0.18,
          y: 0.3,
          width: 0.64,
          height: 0.23,
          rotation: 0,
          method: 'pdf-object',
        },
        confidence: 1,
        assetId: null,
        role: 'semantic',
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [sourcePage],
      sourceHash: '1'.repeat(64),
      fileName: 'vertical-owned-float-sentence.pdf',
      byteLength: 4096,
      metadata: { title: 'Vertical float sentence continuity' },
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 8,
          pixels: new Uint8Array(12 * 8 * 4).fill(96),
        }),
    })
    const visual = result.visualRelationships.find(
      (relationship) => relationship.label === 'Figure 9',
    )
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('The source-backed sentence'),
    )

    expect(visual).toMatchObject({
      status: 'matched',
      canonicalNodeId: expect.any(String),
    })
    expect(joined).toMatchObject({
      text: 'The source-backed sentence continues with a deterministic conclusion after the float.',
    })
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' &&
          node.text.startsWith('a deterministic conclusion'),
      ),
    ).toEqual([])
  })

  it('joins one paragraph across an owned page-tail table before the next page', async () => {
    const firstPage = sourceOrderedPage(1, [
      run(1, 'Page-tail table continuity', 0.1, 0.035, 0.8, 18),
      run(1, '1 Evaluation', 0.09, 0.12, 0.3, 14),
      run(
        1,
        'Left-column context establishes the source reading geometry.',
        0.09,
        0.2,
        0.385,
      ),
      run(
        1,
        'A second left-column row confirms the stable gutter.',
        0.09,
        0.24,
        0.385,
      ),
      run(
        1,
        'A third left-column row completes the layout evidence.',
        0.09,
        0.28,
        0.385,
      ),
      run(
        1,
        'Right-column context establishes the second source lane.',
        0.515,
        0.2,
        0.385,
      ),
      run(
        1,
        'A second right-column row confirms the stable gutter.',
        0.515,
        0.24,
        0.385,
      ),
      run(
        1,
        'A third right-column row completes the layout evidence.',
        0.515,
        0.28,
        0.385,
      ),
      run(1, 'The comparison proceeds according', 0.515, 0.69, 0.385),
      run(1, 'Method', 0.535, 0.75, 0.13, 8),
      run(1, 'Score', 0.75, 0.75, 0.1, 8),
      run(1, 'BASE', 0.535, 0.775, 0.13, 8),
      run(1, '40.0', 0.75, 0.775, 0.1, 8),
      run(1, 'SYSTEM', 0.535, 0.8, 0.13, 8),
      run(1, '60.0', 0.75, 0.8, 0.1, 8),
      run(
        1,
        'Table 6: Source-backed comparison scores.',
        0.515,
        0.845,
        0.385,
        8,
      ),
    ])
    const result = await reconstructPageAnalyses({
      pages: [
        firstPage,
        sourceOrderedPage(2, [
          run(
            2,
            'to the standard metric used for classification.',
            0.09,
            0.08,
            0.385,
          ),
        ]),
      ],
      sourceHash: '7'.repeat(64),
      fileName: 'page-tail-owned-table.pdf',
      byteLength: 4096,
      metadata: { title: 'Page-tail table continuity' },
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 8,
          pixels: new Uint8Array(12 * 8 * 4).fill(96),
        }),
    })
    const visual = result.visualRelationships.find(
      (relationship) => relationship.label === 'Table 6',
    )
    const joined = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.startsWith('The comparison proceeds according'),
    )

    expect(visual).toMatchObject({
      status: 'matched',
      canonicalNodeId: expect.any(String),
    })
    expect(joined).toMatchObject({
      text: 'The comparison proceeds according to the standard metric used for classification.',
    })
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' && node.text.startsWith('to the standard'),
      ),
    ).toEqual([])
    expect(result.sourceSemanticFlowBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topology: 'cross-page-column',
          outcome: 'space',
        }),
      ]),
    )
    expect(
      result.paper.nodes.findIndex((node) => node.id === joined?.id),
    ).toBeLessThan(
      result.paper.nodes.findIndex(
        (node) => node.id === visual?.canonicalNodeId,
      ),
    )
  })
})

import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildReadableEpub, inspectEpub } from './epub'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import { createSourcePageCropAsset } from './visual-assets'
import type { ResearchNode } from './schema'

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

function mathRun(
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize: number,
  fontName: string,
) {
  return {
    ...run(1, text, x, y, width, fontSize),
    height: fontSize < 9 ? 0.009 : 0.014,
    fontName,
  }
}

function splitInlineProseEquationRuns({
  afterText = '). The first term records the local drift [42].',
  extraRuns = [],
}: {
  afterText?: string
  extraRuns?: PdfSourceRun[]
} = {}) {
  const before = run(1, 'where', 0.1, 0.34, 0.05)
  const firstBase = mathRun('S', 0.16, 0.34, 0.012, 10, 'Synthetic-CMMI10')
  const firstSubscript = mathRun('k', 0.172, 0.347, 0.007, 7, 'Synthetic-CMMI7')
  const firstSuperscript = mathRun(
    '′',
    0.173,
    0.333,
    0.007,
    7,
    'Synthetic-CMSY7',
  )
  const relationAndSecondBase = mathRun(
    ' = S′(',
    0.184,
    0.34,
    0.052,
    10,
    'Synthetic-CMR10',
  )
  const argumentBase = mathRun('x', 0.236, 0.34, 0.012, 10, 'Synthetic-CMMI10')
  const argumentSuperscript = mathRun(
    'k',
    0.248,
    0.333,
    0.007,
    7,
    'Synthetic-CMMI7',
  )
  const argumentSubscript = mathRun(
    't',
    0.248,
    0.347,
    0.007,
    7,
    'Synthetic-CMMI7',
  )
  const after = run(1, afterText, 0.266, 0.34, 0.39)
  before.sourceSequenceIndex = 0
  Object.assign(firstBase, {
    sourceSequenceIndex: 2,
    sourceWhitespaceBefore: 'pdf-text-item' as const,
    sourceWhitespacePredecessorIndex: 0,
  })
  ;[
    firstSubscript,
    firstSuperscript,
    relationAndSecondBase,
    argumentBase,
    argumentSuperscript,
    argumentSubscript,
  ].forEach((sourceRun, index) => {
    sourceRun.sourceSequenceIndex = index + 3
  })
  Object.assign(after, {
    sourceSequenceIndex: 9,
    sourceWhitespaceBefore: 'pdf-text-item' as const,
    sourceWhitespacePredecessorIndex: 8,
  })
  return [
    before,
    firstBase,
    firstSubscript,
    firstSuperscript,
    relationAndSecondBase,
    argumentBase,
    argumentSuperscript,
    argumentSubscript,
    after,
    ...extraRuns,
  ]
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

describe('PDF semantic reconstruction', () => {
  it('retains source-text equation lineage when the equation is its own caption', async () => {
    const equationRun = run(1, 'E = m c 2', 0.3, 0.28, 0.24, 12)
    const result = await reconstructPageAnalyses({
      pages: [page(1, [equationRun])],
      sourceHash: 'b'.repeat(64),
      fileName: 'source-text-equation.pdf',
      byteLength: 2048,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 8,
          height: 4,
          pixels: new Uint8Array(8 * 4 * 4).fill(96),
        }),
    })

    const relationship = result.visualRelationships.find(
      (candidate) => candidate.kind === 'equation',
    )!
    const asset = result.assets.find(
      (candidate) => candidate.id === relationship.assetIds[0],
    )!

    expect(relationship).toMatchObject({
      status: 'matched',
      altTextSource: 'source-text',
      captionRegionId: relationship.sourceRegionIds[0],
      sourceObjectIds: [expect.stringMatching(/^equation-source-/)],
      canonicalNodeId: expect.any(String),
      captionNodeId: expect.any(String),
    })
    expect(relationship.sourceBoxes).toHaveLength(2)
    expect(relationship.sourceBoxes[0]).toEqual(relationship.sourceBoxes[1])
    expect(relationship.sourceBoxes[1]).toEqual(asset.sourceBoxes[0])
    expect(result.provenance[relationship.canonicalNodeId!].boxes).toEqual(
      relationship.sourceBoxes,
    )
    expect(
      validatedPdfVisualRelationships({
        paper: result.paper,
        provenance: result.provenance,
        relationships: result.visualRelationships,
        assets: result.assets,
        regions: result.regions,
        pages: result.pages,
      }),
    ).toEqual([relationship])
  })

  it('keeps a generated numbered-equation label plain while retaining source lineage', async () => {
    const base = {
      ...run(1, 'd', 0.3, 0.28, 0.012, 12),
      fontName: 'Synthetic-CMMI10',
    }
    const unencodedSubscript = {
      ...run(1, 'i', 0.312, 0.287, 0.008, 7),
      height: 0.009,
      fontName: 'Synthetic-CMMI7',
    }
    const formulaTail = {
      ...run(1, ' = Model(x), (2)', 0.322, 0.28, 0.3, 12),
      fontName: 'Synthetic-CMR10',
    }
    const result = await reconstructPageAnalyses({
      pages: [page(1, [base, unencodedSubscript, formulaTail])],
      sourceHash: '2'.repeat(64),
      fileName: 'generated-equation-label.pdf',
      byteLength: 2048,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 16,
          height: 6,
          pixels: new Uint8Array(16 * 6 * 4).fill(96),
        }),
    })

    const relationship = result.visualRelationships.find(
      (candidate) => candidate.kind === 'equation',
    )!
    const caption = result.paper.nodes.find(
      (node) => node.id === relationship.captionNodeId,
    )
    expect(relationship).toMatchObject({
      label: 'Equation 2',
      status: 'matched',
      sourceText: '',
      altText: 'Equation 2',
      altTextSource: 'caption',
    })
    expect(caption).toMatchObject({
      type: 'caption',
      text: 'Equation 2',
    })
    expect(caption).not.toHaveProperty('inlineRuns')
    expect(result.provenance[relationship.captionNodeId!]).toMatchObject({
      regionIds: [relationship.captionRegionId],
      boxes: expect.any(Array),
    })

    const epub = await buildReadableEpub(result.paper, result)
    const content = strFromU8(
      inspectEpub(epub.bytes).files['EPUB/content.xhtml'],
    )
    expect(content).toContain(
      `<figcaption id="${relationship.captionNodeId}" data-canonical-id="${relationship.captionNodeId}" class="equation-number-caption visually-hidden">Equation 2</figcaption>`,
    )
  })

  it('keeps an inline display equation between the prose that introduces and explains it', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(
            1,
            'We steer the residual stream at each decoding step:',
            0.12,
            0.2,
            0.65,
            10,
          ),
          run(1, 'hℓ ← hℓ + α · vℓ,', 0.34, 0.3, 0.32, 12),
          run(1, '* Supporting detail.', 0.12, 0.88, 0.24, 8),
        ]),
        page(2, [
          run(
            2,
            'where α is a scalar steering coefficient.',
            0.12,
            0.12,
            0.5,
            10,
          ),
        ]),
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'equation-prose-order.pdf',
      byteLength: 2048,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 16,
          height: 6,
          pixels: new Uint8Array(16 * 6 * 4).fill(96),
        }),
    })
    const relationship = result.visualRelationships.find(
      (candidate) => candidate.kind === 'equation',
    )!
    const introducingIndex = result.paper.nodes.findIndex(
      (node) =>
        node.type === 'paragraph' &&
        node.text === 'We steer the residual stream at each decoding step:',
    )
    const equationIndex = result.paper.nodes.findIndex(
      (node) => node.id === relationship.canonicalNodeId,
    )
    const captionIndex = result.paper.nodes.findIndex(
      (node) => node.id === relationship.captionNodeId,
    )
    const explanationIndex = result.paper.nodes.findIndex(
      (node) =>
        node.type === 'paragraph' &&
        node.text === 'where α is a scalar steering coefficient.',
    )
    const footnoteIndex = result.paper.nodes.findIndex(
      (node) => node.type === 'footnote' && node.text === 'Supporting detail.',
    )

    expect(relationship).toMatchObject({
      status: 'matched',
      sourceText: 'hℓ ← hℓ + α · vℓ,',
    })
    expect([
      introducingIndex,
      equationIndex,
      captionIndex,
      explanationIndex,
      footnoteIndex,
    ]).toEqual([
      expect.any(Number),
      introducingIndex + 1,
      equationIndex + 1,
      captionIndex + 1,
      explanationIndex + 1,
    ])
    expect(introducingIndex).toBeGreaterThan(-1)
  })

  it('uses a source equation label without publishing an unsafe glyph transcript', async () => {
    const opening = run(1, '\u0012', 0.81, 0.09, 0.012, 10)
    opening.fontName = 'Synthetic-CMEX10'
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Ordinary prose establishes the body font.', 0.1, 0.3, 0.36),
          run(1, 'Another ordinary prose line.', 0.1, 0.33, 0.3),
          opening,
          run(1, 'N(a,b) = c + d', 0.5, 0.115, 0.35, 12),
          run(1, 'd(a,b) = e', 0.52, 0.135, 0.3, 12),
          run(1, '(3)', 0.87, 0.155, 0.02, 10),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'unsafe-source-equation.pdf',
      byteLength: 2048,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 16,
          height: 6,
          pixels: new Uint8Array(16 * 6 * 4).fill(96),
        }),
    })

    const relationship = result.visualRelationships.find(
      (candidate) => candidate.kind === 'equation',
    )!
    expect(relationship).toMatchObject({
      status: 'matched',
      label: 'Equation 3',
      sourceText: '',
      altText: 'Equation 3',
      altTextSource: 'caption',
      canonicalNodeId: expect.any(String),
      captionNodeId: expect.any(String),
      evidence: expect.arrayContaining(['source-text-transcript-unresolved']),
    })
    expect(
      result.paper.nodes.find((node) => node.id === relationship.captionNodeId),
    ).toMatchObject({ type: 'caption', text: 'Equation 3' })
    expect(
      result.paper.nodes.some(
        (node) =>
          'text' in node &&
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(node.text),
      ),
    ).toBe(false)
  })

  it('keeps a proved split inline formula inside one prose paragraph without resolving its two-dimensional obligation', async () => {
    const continuedAfter = run(
      1,
      'and cites the source-backed reference [42].',
      0.266,
      0.365,
      0.34,
    )
    Object.assign(continuedAfter, {
      sourceSequenceIndex: 10,
      sourceWhitespaceBefore: 'pdf-text-item' as const,
      sourceWhitespacePredecessorIndex: 9,
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.42),
          run(
            1,
            'A second ordinary prose line remains intact.',
            0.1,
            0.23,
            0.44,
          ),
          ...splitInlineProseEquationRuns({
            afterText: '). The first term records the local drift',
            extraRuns: [continuedAfter],
          }),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[42] Source-backed reference.', 0.1, 0.72, 0.72, 7),
        ]),
      ],
      sourceHash: '7'.repeat(64),
      fileName: 'split-inline-prose-equation.pdf',
      byteLength: 4096,
      rasterizeFigure: async () => {
        throw new Error('source crop unavailable')
      },
    })

    const relationship = result.visualRelationships.find(
      (candidate) =>
        candidate.kind === 'equation' &&
        candidate.status === 'unresolved' &&
        candidate.evidence.includes('source-text-transcript-unresolved'),
    )
    expect(relationship).toBeDefined()
    const formulaLineIds =
      relationship?.sourceLineIds?.filter((lineId) =>
        lineId.endsWith('-formula'),
      ) ?? []
    expect(formulaLineIds).toHaveLength(1)
    const ownedParagraphs = result.paper.nodes.filter(
      (
        node,
      ): node is Extract<
        (typeof result.paper.nodes)[number],
        { type: 'paragraph' }
      > =>
        node.type === 'paragraph' &&
        (node.text === 'where' ||
          node.text.includes(
            'The first term records the local drift and cites the source-backed reference [42].',
          ) ||
          result.provenance[node.id]?.regionIds.some((regionId) =>
            relationship!.sourceRegionIds.includes(regionId),
          )),
    )
    expect(ownedParagraphs).toHaveLength(1)
    expect(ownedParagraphs[0].text).toBe(
      'where Sk′ = S′(xkt). The first term records the local drift and cites the source-backed reference [42].',
    )
    expect(result.provenance[ownedParagraphs[0].id]?.regionIds).toHaveLength(3)
    expect(
      ownedParagraphs[0].inlineRuns?.map((inline) => ({
        text: ownedParagraphs[0].text.slice(inline.start, inline.end),
        verticalAlign: inline.verticalAlign,
        semanticRole: inline.semanticRole,
      })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'k', verticalAlign: 'subscript' }),
        expect.objectContaining({ text: '′', verticalAlign: 'superscript' }),
        expect.objectContaining({ text: 'k', verticalAlign: 'superscript' }),
        expect.objectContaining({ text: 't', verticalAlign: 'subscript' }),
        expect.objectContaining({
          text: '[42]',
          semanticRole: 'citation',
        }),
      ]),
    )
    expect(result.visualRelationships).toContain(relationship)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_VISUAL_OBJECT',
          target: expect.objectContaining({
            markerId: relationship?.id,
          }),
        }),
      ]),
    )
    expect(result.completeness.unresolvedObjects.equations).toBeGreaterThan(0)
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNRESOLVED_VISUAL_OBJECT',
      ]),
    })
    expect(
      result.sourceSemanticFlowBoundaryDecisions.map(
        (decision) => decision.outcome,
      ),
    ).toEqual(['no-space'])
    expect(result.sourceSemanticFlowBoundaryDecisionCount).toBe(1)
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'CANONICAL_FLOW_ORDER_VIOLATION',
      ),
    ).toBe(false)
  })

  it('uses one exact unresolved candidate lineage when a prose suffix is held by a spanning container', async () => {
    const columnEvidence = [0.12, 0.15, 0.18].flatMap((y, index) => [
      run(
        1,
        `Left column evidence ${index + 1} remains readable.`,
        0.1,
        y,
        0.34,
      ),
      run(
        1,
        `Right column evidence ${index + 1} remains readable.`,
        0.55,
        y,
        0.34,
      ),
    ])
    const inlineRuns = splitInlineProseEquationRuns()
    const after = inlineRuns.find((sourceRun) =>
      sourceRun.text.startsWith('). The first term'),
    )!
    after.width = 0.61

    const result = await reconstructPageAnalyses({
      pages: [page(1, [...columnEvidence, ...inlineRuns])],
      sourceHash: '9'.repeat(64),
      fileName: 'split-inline-spanning-candidate.pdf',
      byteLength: 4096,
      rasterizeFigure: async () => {
        throw new Error('source crop unavailable')
      },
    })
    const relationship = result.visualRelationships.find(
      (candidate) =>
        candidate.kind === 'equation' &&
        candidate.status === 'unresolved' &&
        candidate.candidates.some((match) =>
          match.sourceRegionIds.some((regionId) =>
            result.regions
              .find((region) => region.id === regionId)
              ?.lines.some((line) => line.id.endsWith('-formula')),
          ),
        ),
    )
    expect(relationship).toBeDefined()
    expect(relationship).toMatchObject({
      sourceRegionIds: [],
      sourceLineIds: [],
      evidence: expect.arrayContaining([
        'source-text-transcript-unresolved',
        'incomplete-equation-source-scope',
      ]),
    })
    const formulaRegionId = relationship!.candidates[0].sourceRegionIds[0]
    const formulaRegion = result.regions.find(
      (region) => region.id === formulaRegionId,
    )!
    const afterBaseId = formulaRegion.lines[0].id.replace(/-formula$/u, '')
    expect(
      result.regions.find((region) =>
        region.lines.some((line) => line.id === `${afterBaseId}-after`),
      ),
    ).toMatchObject({ kind: 'spanning' })
    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'paragraph' &&
          (node.text === 'where' ||
            result.provenance[node.id]?.regionIds.includes(formulaRegionId) ||
            node.text.startsWith('). The first term')),
      ),
    ).toEqual([
      expect.objectContaining({
        text: 'where Sk′ = S′(xkt). The first term records the local drift [42].',
      }),
    ])
    expect(result.visualRelationships).toContain(relationship)
    expect(result.readiness.ready).toBe(false)
  })

  it('does not coalesce a split inline formula through an unresolved extra-line boundary', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.42),
          run(
            1,
            'A second ordinary prose line remains intact.',
            0.1,
            0.23,
            0.44,
          ),
          ...splitInlineProseEquationRuns({
            afterText: '). The first term preserves quux-',
            extraRuns: [run(1, 'blorp remains separate.', 0.266, 0.365, 0.2)],
          }),
        ]),
      ],
      sourceHash: '8'.repeat(64),
      fileName: 'split-inline-unresolved-extra-line.pdf',
      byteLength: 4096,
      rasterizeFigure: async () => {
        throw new Error('source crop unavailable')
      },
    })

    const relationship = result.visualRelationships.find(
      (candidate) =>
        candidate.kind === 'equation' &&
        candidate.status === 'unresolved' &&
        candidate.sourceLineIds?.some((lineId) => lineId.endsWith('-formula')),
    )
    expect(relationship).toBeDefined()
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          node.text.startsWith('where ') &&
          node.text.includes('blorp remains separate.'),
      ),
    ).toBe(false)
  })

  it.each([
    {
      name: 'the source whitespace predecessor is missing',
      runs: () => {
        const runs = splitInlineProseEquationRuns()
        const formulaStart = runs.find((sourceRun) => sourceRun.text === 'S')!
        Object.assign(formulaStart, {
          sourceWhitespaceBefore: undefined,
          sourceWhitespacePredecessorIndex: undefined,
        })
        return runs
      },
    },
    {
      name: 'the prose suffix has no leading closing punctuation',
      runs: () =>
        splitInlineProseEquationRuns({
          afterText: 'The first term records the local drift [42].',
        }),
    },
  ])('fails closed when $name', async ({ runs }) => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.42),
          run(
            1,
            'A second ordinary prose line remains intact.',
            0.1,
            0.23,
            0.44,
          ),
          ...runs(),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[42] Source-backed reference.', 0.1, 0.72, 0.72, 7),
        ]),
      ],
      sourceHash: '6'.repeat(64),
      fileName: 'split-inline-fail-closed.pdf',
      byteLength: 4096,
      rasterizeFigure: async () => {
        throw new Error('source crop unavailable')
      },
    })
    const relationship = result.visualRelationships.find(
      (candidate) =>
        candidate.kind === 'equation' &&
        candidate.status === 'unresolved' &&
        candidate.sourceLineIds?.some((lineId) => lineId.endsWith('-formula')),
    )
    expect(relationship).toBeDefined()
    expect(
      result.paper.nodes.find(
        (node) =>
          node.type === 'paragraph' &&
          result.provenance[node.id]?.regionIds.includes(
            relationship!.sourceRegionIds[0],
          ),
      ),
    ).toSatisfy(
      (owner: Extract<ResearchNode, { type: 'paragraph' }> | undefined) =>
        Boolean(owner) && result.provenance[owner!.id].regionIds.length < 3,
    )
    expect(result.completeness.unresolvedObjects.equations).toBeGreaterThan(0)
    expect(result.readiness.ready).toBe(false)
  })

  it('does not coalesce a split inline formula that is owned by a matched equation relationship', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.42),
          run(
            1,
            'A second ordinary prose line remains intact.',
            0.1,
            0.23,
            0.44,
          ),
          ...splitInlineProseEquationRuns(),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[42] Source-backed reference.', 0.1, 0.72, 0.72, 7),
        ]),
      ],
      sourceHash: '5'.repeat(64),
      fileName: 'split-inline-matched-equation.pdf',
      byteLength: 4096,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 20,
          height: 8,
          pixels: new Uint8Array(20 * 8 * 4).fill(96),
        }),
    })
    const relationship = result.visualRelationships.find(
      (candidate) =>
        candidate.kind === 'equation' &&
        candidate.sourceLineIds?.some((lineId) => lineId.endsWith('-formula')),
    )
    expect(relationship).toMatchObject({
      status: 'matched',
      canonicalNodeId: expect.any(String),
    })
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          node.text ===
            'where Sk′ = S′(xkt). The first term records the local drift [42].',
      ),
    ).toBe(false)
  })

  it.each([
    {
      name: 'a superscript-before-base formula',
      fileName: 'unresolved-inline-script.pdf',
      corruptTranscript: /qla\s*=\s*R\(x\)/u,
      runs: [
        run(
          1,
          'The recovered paragraph introduces a fitted transform:',
          0.1,
          0.3,
          0.42,
        ),
        mathRun('q', 0.2, 0.34, 0.012, 10, 'Synthetic-CMMI10'),
        mathRun('l', 0.212, 0.333, 0.007, 7, 'Synthetic-CMMI7'),
        mathRun('a', 0.212, 0.348, 0.007, 7, 'Synthetic-CMMI7'),
        mathRun(' = R(x)', 0.225, 0.34, 0.09, 10, 'Synthetic-CMR10'),
        run(1, 'The following sentence remains readable.', 0.1, 0.38, 0.36),
      ],
    },
    {
      name: 'a reordered summation formula',
      fileName: 'unresolved-inline-summation.pdf',
      corruptTranscript: /L1\s*∑l\s*LDal/u,
      runs: [
        run(
          1,
          'The recovered paragraph selects a spectral basis:',
          0.1,
          0.3,
          0.4,
        ),
        mathRun('L', 0.2, 0.34, 0.012, 10, 'Synthetic-CMMI10'),
        mathRun('1', 0.212, 0.348, 0.007, 7, 'Synthetic-CMR7'),
        mathRun('∑', 0.225, 0.34, 0.02, 10, 'Synthetic-CMSY10'),
        mathRun('l', 0.239, 0.348, 0.007, 7, 'Synthetic-CMMI7'),
        mathRun('LD', 0.252, 0.34, 0.025, 10, 'Synthetic-CMMI10'),
        mathRun('a', 0.277, 0.348, 0.007, 7, 'Synthetic-CMMI7'),
        mathRun('l', 0.277, 0.333, 0.007, 7, 'Synthetic-CMMI7'),
        run(1, 'as the stable basis for evaluation.', 0.3, 0.34, 0.27),
      ],
    },
    {
      name: 'a split formula shard',
      fileName: 'unresolved-split-inline-formula.pdf',
      corruptTranscript: /hl=\s*=\s*f\(a,\s*b\)/u,
      runs: [
        run(
          1,
          'The recovered paragraph says the state is modeled by',
          0.1,
          0.34,
          0.36,
        ),
        mathRun('h', 0.47, 0.34, 0.012, 10, 'Synthetic-CMMI10'),
        mathRun('l', 0.482, 0.333, 0.007, 7, 'Synthetic-CMMI7'),
        mathRun('=', 0.482, 0.348, 0.009, 7, 'Synthetic-CMR7'),
        mathRun(
          '= f(a, b), where the mapping remains stable.',
          0.502,
          0.34,
          0.34,
          10,
          'Synthetic-CMR10',
        ),
      ],
    },
    {
      name: 'a mixed variable fraction without a relation operator',
      fileName: 'unresolved-mixed-variable-fraction.pdf',
      corruptTranscript: /2xy/u,
      runs: [
        run(1, 'The recovered ratio is', 0.1, 0.34, 0.16),
        mathRun('2', 0.261, 0.34, 0.012, 10, 'Synthetic-CMR10'),
        mathRun('x', 0.274, 0.333, 0.007, 7, 'Synthetic-CMMI7'),
        mathRun('y', 0.274, 0.348, 0.007, 7, 'Synthetic-CMMI7'),
        run(1, 'for each observed sample.', 0.283, 0.34, 0.2),
      ],
    },
    {
      name: 'a three-run variable fraction',
      fileName: 'unresolved-three-run-variable-fraction.pdf',
      corruptTranscript: /2xy/u,
      runs: [
        mathRun('2', 0.261, 0.34, 0.012, 10, 'Synthetic-CMR10'),
        mathRun('x', 0.274, 0.333, 0.007, 7, 'Synthetic-CMMI7'),
        mathRun('y', 0.274, 0.348, 0.007, 7, 'Synthetic-CMMI7'),
      ],
    },
    {
      name: 'a four-run line-start variable fraction',
      fileName: 'unresolved-line-start-variable-fraction.pdf',
      corruptTranscript: /2xy\s*defines the observed ratio/u,
      runs: [
        mathRun('2', 0.1, 0.34, 0.012, 10, 'Synthetic-CMR10'),
        mathRun('x', 0.113, 0.333, 0.007, 7, 'Synthetic-CMMI7'),
        mathRun('y', 0.113, 0.348, 0.007, 7, 'Synthetic-CMMI7'),
        run(1, 'defines the observed ratio.', 0.122, 0.34, 0.22),
      ],
    },
    {
      name: 'a non-Computer-Modern variable fraction',
      fileName: 'unresolved-non-cm-variable-fraction.pdf',
      corruptTranscript: /2xy\s*defines the observed ratio/u,
      runs: [
        mathRun('2', 0.1, 0.34, 0.012, 10, 'Synthetic-Math-Regular'),
        mathRun('x', 0.113, 0.333, 0.007, 7, 'Synthetic-Math-Regular'),
        mathRun('y', 0.113, 0.348, 0.007, 7, 'Synthetic-Math-Regular'),
        run(1, 'defines the observed ratio.', 0.122, 0.34, 0.22),
      ],
    },
  ])(
    'preserves $name and blocks publication when its two-dimensional semantics remain unresolved',
    async ({ fileName, runs }) => {
      const result = await reconstructPageAnalyses({
        pages: [
          page(1, [
            run(1, 'Ordinary prose establishes the body font.', 0.1, 0.2, 0.42),
            run(
              1,
              'A second ordinary prose line remains intact.',
              0.1,
              0.23,
              0.44,
            ),
            ...runs,
          ]),
        ],
        sourceHash: '9'.repeat(64),
        fileName,
        byteLength: 2048,
        rasterizeFigure: async () => {
          throw new Error('source crop unavailable')
        },
      })

      const relationship = result.visualRelationships.find(
        (candidate) =>
          candidate.kind === 'equation' &&
          candidate.status === 'unresolved' &&
          candidate.evidence.includes('source-text-transcript-unresolved'),
      )
      expect(relationship).toMatchObject({
        kind: 'equation',
        status: 'unresolved',
        sourceText: '',
        altTextSource: 'caption',
        evidence: expect.arrayContaining([
          'source-proved-atomic-equation-component',
          'source-rendition-unavailable',
        ]),
      })
      expect(relationship!.sourceRegionIds).toContain(
        relationship!.captionRegionId,
      )
      const sourceNodes = result.paper.nodes.filter(
        (
          node,
        ): node is Extract<
          (typeof result.paper.nodes)[number],
          { text: string }
        > => 'text' in node,
      )
      const canonicalText = sourceNodes.map((node) => node.text).join(' ')
      const preservedEquationNodes = sourceNodes.filter((node) =>
        result.provenance[node.id]?.regionIds.some((regionId) =>
          relationship!.sourceRegionIds.includes(regionId),
        ),
      )
      expect(preservedEquationNodes.length).toBeGreaterThan(0)
      expect(preservedEquationNodes).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: relationship!.altText }),
        ]),
      )
      expect(
        preservedEquationNodes.every(
          (node) => result.provenance[node.id]?.boxes.length > 0,
        ),
      ).toBe(true)
      if (fileName === 'unresolved-split-inline-formula.pdf') {
        expect(canonicalText).toContain('where the mapping remains stable.')
      }
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'UNRESOLVED_VISUAL_OBJECT',
            severity: 'error',
          }),
        ]),
      )
      expect(result.completeness.unresolvedObjects.equations).toBeGreaterThan(0)
      expect(result.completeness.expectedInlineSpanCount).toBeGreaterThan(0)
      expect(result.readiness).toMatchObject({
        ready: false,
        status: 'review-required',
        blockingDiagnosticCodes: expect.arrayContaining([
          'UNRESOLVED_VISUAL_OBJECT',
        ]),
      })

      const epub = await buildReadableEpub(result.paper, result)
      const content = strFromU8(
        inspectEpub(epub.bytes).files['EPUB/content.xhtml'],
      )
      for (const node of preservedEquationNodes) {
        expect(content).toContain(`data-canonical-id="${node.id}"`)
      }
      expect(content).not.toContain('orphan-caption omitted-visual')
      expect(content).not.toContain(`>${relationship!.altText}<`)
    },
  )
})

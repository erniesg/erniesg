import { describe, expect, it } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
} from './import-types'
import {
  reconstructPageAnalyses,
  resolveCanonicalHyperlinkObligations,
} from './pdf-layout'

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

function canonicalHyperlinkTestBlock(text = 'Open target') {
  const sourceRun = run(1, text, 0.1, 0.2, 0.3)
  const region = {
    id: 'internal-link-source-region',
    page: 1,
    kind: 'body',
    column: 'single',
    text,
    confidence: 1,
    box: { ...sourceRun },
    lines: [
      {
        id: 'internal-link-source-line',
        text,
        fontSize: sourceRun.fontSize,
        box: { ...sourceRun },
        runs: [sourceRun],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  return {
    block: {
      type: 'paragraph' as const,
      region,
      text,
      confidence: 1,
      nodeId: 'internal-link-source-node',
    },
    box: {
      page: 1,
      x: sourceRun.x,
      y: sourceRun.y,
      width: sourceRun.width,
      height: sourceRun.height,
      rotation: 0,
      method: 'pdf-link' as const,
    },
  }
}

function sourceSubstringBox(
  sourceRun: PdfSourceRun,
  start: number,
  end: number,
  method: NormalizedSourceBox['method'] = 'pdf-link',
): NormalizedSourceBox {
  return {
    page: sourceRun.page,
    x: sourceRun.x + sourceRun.width * (start / sourceRun.text.length),
    y: sourceRun.y,
    width: sourceRun.width * ((end - start) / sourceRun.text.length),
    height: sourceRun.height,
    rotation: sourceRun.rotation,
    method,
  }
}

describe('PDF semantic reconstruction', () => {
  it('maps three ordered citation labels to three exact annotation-owned targets', async () => {
    const citationText =
      'Although interpretation requires care [62, 63, 48], the evidence remains useful.'
    const citationRun = run(1, citationText, 0.1, 0.24, 0.78)
    const labels = ['62', '63', '48']
    const linked = page(1, [
      run(1, 'Ordered Citation Study', 0.1, 0.08, 0.7, 22),
      run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
      citationRun,
    ])
    linked.links = labels.map((label, index) => {
      const start = citationText.indexOf(label, index === 0 ? 0 : undefined)
      return {
        id: `pdf-link-p001-a${String(index + 1).padStart(4, '0')}`,
        page: 1,
        status: 'internal' as const,
        destination: `cite.${label}`,
        box: sourceSubstringBox(citationRun, start, start + label.length),
      }
    })
    const result = await reconstructPageAnalyses({
      pages: [
        linked,
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[62] First source-backed reference.', 0.1, 0.7, 0.72, 7),
          run(2, '[63] Second source-backed reference.', 0.1, 0.73, 0.72, 7),
          run(2, '[48] Third source-backed reference.', 0.1, 0.76, 0.72, 7),
        ]),
      ],
      sourceHash: 'a'.repeat(64),
      fileName: 'ordered-multi-citation-links.pdf',
      byteLength: 4096,
    })
    const references = new Map(
      result.paper.nodes.flatMap((node) =>
        node.type === 'paragraph' &&
        node.list?.numberingId === 'references' &&
        node.list.ordinal !== undefined
          ? [[String(node.list.ordinal), node.id] as const]
          : [],
      ),
    )
    const relationship = result.citationRelationships.find(
      (candidate) => candidate.labels.join(',') === labels.join(','),
    )
    const annotationRuns = result.paper.nodes
      .flatMap((node) =>
        'inlineRuns' in node
          ? (node.inlineRuns ?? []).flatMap((inline) =>
              inline.annotationId
                ? [{ nodeText: 'text' in node ? node.text : '', inline }]
                : [],
            )
          : [],
      )
      .sort((left, right) => left.inline.start - right.inline.start)

    expect(relationship).toMatchObject({
      status: 'matched',
      targetNodeIds: labels.map((label) => references.get(label)),
      targets: labels.map((label) =>
        expect.objectContaining({
          label,
          targetNodeId: references.get(label),
          referenceStart: expect.any(Number),
          referenceEnd: expect.any(Number),
          sourceBoxes: [expect.objectContaining({ method: 'pdf-text' })],
        }),
      ),
    })
    expect(
      annotationRuns.map(({ nodeText, inline }) => ({
        text: nodeText.slice(inline.start, inline.end),
        href: inline.href,
      })),
    ).toEqual(
      labels.map((label) => ({
        text: label,
        href: `#${references.get(label)}`,
      })),
    )
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 3,
      mappedHyperlinkCount: 3,
      hyperlinkCoverage: 1,
    })
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'UNRESOLVED_HYPERLINK',
      ),
    ).toEqual([])
  })

  it('preserves exact citation-link ownership when its paragraph continues on the next page', async () => {
    const citationText =
      'Source-backed systems combine distinct inputs [37, 222] before producing a result.'
    const citationRun = run(1, citationText, 0.1, 0.78, 0.78)
    citationRun.sourceSequenceIndex = 4
    const labels = ['37', '222']
    const linked = page(1, [
      {
        ...run(1, 'Cross-page Citation Link Study', 0.1, 0.04, 0.72, 22),
        sourceSequenceIndex: 0,
      },
      {
        ...run(1, '1 Introduction', 0.1, 0.14, 0.3, 16),
        sourceSequenceIndex: 1,
      },
      {
        ...run(
          1,
          'The opening sentence establishes ordinary body typography.',
          0.1,
          0.72,
          0.78,
        ),
        sourceSequenceIndex: 2,
      },
      {
        ...run(
          1,
          'The next sentence provides enough adjacent source flow.',
          0.1,
          0.75,
          0.78,
        ),
        sourceSequenceIndex: 3,
      },
      citationRun,
      { ...run(1, 'This', 0.1, 0.81, 0.78), sourceSequenceIndex: 5 },
    ])
    linked.links = labels.map((label, index) => {
      const start = citationText.indexOf(label)
      return {
        id: `pdf-link-p001-a${String(index + 1).padStart(4, '0')}`,
        page: 1,
        status: 'internal' as const,
        destination: `cite.${label}`,
        box: sourceSubstringBox(citationRun, start, start + label.length),
      }
    })
    const result = await reconstructPageAnalyses({
      pages: [
        linked,
        page(2, [
          {
            ...run(
              2,
              'continuation completes the paragraph with source-proven geometry.',
              0.1,
              0.08,
              0.78,
            ),
            sourceSequenceIndex: 0,
          },
        ]),
        page(3, [
          run(3, 'References', 0.1, 0.1, 0.3, 16),
          run(3, '[37] First source-backed reference.', 0.1, 0.7, 0.72, 7),
          run(3, '[222] Second source-backed reference.', 0.1, 0.73, 0.72, 7),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'cross-page-citation-links.pdf',
      byteLength: 4096,
    })
    const linkedRuns = result.paper.nodes.flatMap((node) =>
      'inlineRuns' in node && 'text' in node
        ? (node.inlineRuns ?? []).flatMap((inline) =>
            inline.annotationId
              ? [
                  {
                    text: node.text.slice(inline.start, inline.end),
                    href: inline.href,
                    ownerText: node.text,
                  },
                ]
              : [],
          )
        : [],
    )

    expect(linkedRuns).toHaveLength(2)
    expect(linkedRuns.map(({ text }) => text)).toEqual(labels)
    expect(
      linkedRuns.every(({ ownerText }) =>
        ownerText.endsWith(
          'This continuation completes the paragraph with source-proven geometry.',
        ),
      ),
    ).toBe(true)
    expect(new Set(linkedRuns.map(({ href }) => href)).size).toBe(2)
    expect(result.sourceSemanticFlowBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topology: 'cross-page-column' }),
      ]),
    )
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 2,
      mappedHyperlinkCount: 2,
      hyperlinkCoverage: 1,
    })
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'UNRESOLVED_HYPERLINK',
      ),
    ).toEqual([])
  })

  it('does not let adjacent citation annotations steal a neighboring singleton', async () => {
    const citationText =
      'Recent advances [37, 222] differ from the separate baseline [295].'
    const citationRun = run(1, citationText, 0.1, 0.24, 0.78)
    const labels = ['37', '222', '295']
    const linked = page(1, [
      run(1, 'Adjacent Citation Study', 0.1, 0.08, 0.7, 22),
      run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
      citationRun,
    ])
    linked.links = labels.map((label, index) => {
      const start = citationText.indexOf(label)
      return {
        id: `pdf-link-p001-a${String(index + 1).padStart(4, '0')}`,
        page: 1,
        status: 'internal' as const,
        destination: `cite.${label}`,
        box: sourceSubstringBox(citationRun, start, start + label.length),
      }
    })
    const result = await reconstructPageAnalyses({
      pages: [
        linked,
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[37] First source-backed reference.', 0.1, 0.7, 0.72, 7),
          run(2, '[222] Second source-backed reference.', 0.1, 0.73, 0.72, 7),
          run(2, '[295] Separate source-backed reference.', 0.1, 0.76, 0.72, 7),
        ]),
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'adjacent-multi-singleton-citations.pdf',
      byteLength: 4096,
    })
    const linkedTexts = result.paper.nodes.flatMap((node) =>
      'inlineRuns' in node && 'text' in node
        ? (node.inlineRuns ?? []).flatMap((inline) =>
            inline.annotationId
              ? [
                  {
                    text: node.text.slice(inline.start, inline.end),
                    href: inline.href,
                  },
                ]
              : [],
          )
        : [],
    )

    expect(linkedTexts.map(({ text }) => text)).toEqual(['37', '222', '[295]'])
    expect(new Set(linkedTexts.map(({ href }) => href)).size).toBe(3)
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'UNRESOLVED_HYPERLINK',
      ),
    ).toEqual([])
  })

  it('uses source offsets to distinguish repeated citations to one target', async () => {
    const citationText =
      'Prior work [1] establishes the baseline, while later work [1] confirms it.'
    const citationRun = run(1, citationText, 0.1, 0.24, 0.78)
    const first = citationText.indexOf('[1]')
    const second = citationText.indexOf('[1]', first + 1)
    const linked = page(1, [
      run(1, 'Repeated Citation Study', 0.1, 0.08, 0.7, 22),
      run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
      citationRun,
    ])
    linked.links = [first, second].map((start, index) => ({
      id: `pdf-link-p001-a${String(index + 1).padStart(4, '0')}`,
      page: 1,
      status: 'internal' as const,
      destination: 'cite.1',
      box: sourceSubstringBox(citationRun, start, start + 3),
    }))
    const result = await reconstructPageAnalyses({
      pages: [
        linked,
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[1] Shared source-backed reference.', 0.1, 0.82, 0.72, 7),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'repeated-citation-target.pdf',
      byteLength: 4096,
    })
    const annotationRanges = result.paper.nodes
      .flatMap((node) =>
        'inlineRuns' in node
          ? (node.inlineRuns ?? []).flatMap((inline) =>
              inline.annotationId
                ? [{ start: inline.start, end: inline.end, href: inline.href }]
                : [],
            )
          : [],
      )
      .sort((left, right) => left.start - right.start)

    expect(annotationRanges).toEqual([
      expect.objectContaining({ start: first, end: first + 3 }),
      expect.objectContaining({ start: second, end: second + 3 }),
    ])
    expect(annotationRanges[0].href).toBe(annotationRanges[1].href)
    expect(result.completeness.mappedHyperlinkCount).toBe(2)
  })

  it('maps a bounded shifted link rectangle only to its substantially overlapping citation surface', () => {
    const text = '[190, 228]'
    const { block } = canonicalHyperlinkTestBlock(text)
    const firstStart = text.indexOf('190')
    const secondStart = text.indexOf('228')
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal' as const,
      destination: 'cite.190',
      box: {
        page: 1,
        x: 0.355,
        y: 0.204,
        width: 0.1,
        height: 0.014,
        rotation: 0,
        method: 'pdf-link' as const,
      },
    }
    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
      canonicalTargets: [
        {
          kind: 'reference',
          label: 'Reference 190',
          nodeId: 'reference-190',
        },
        {
          kind: 'reference',
          label: 'Reference 228',
          nodeId: 'reference-228',
        },
      ],
      canonicalInternalSurfaces: [
        {
          targetNodeId: 'reference-190',
          blockNodeId: block.nodeId,
          start: firstStart,
          end: firstStart + 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.3,
              y: 0.2,
              width: 0.1,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
        {
          targetNodeId: 'reference-228',
          blockNodeId: block.nodeId,
          start: secondStart,
          end: secondStart + 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.445,
              y: 0.2,
              width: 0.1,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
      ],
    })

    expect(resolution.mappings).toEqual([
      {
        annotationId: annotation.id,
        blockNodeId: block.nodeId,
        start: firstStart,
        end: firstStart + 3,
        href: '#reference-190',
      },
    ])
    expect(resolution.diagnostics).toEqual([])
  })

  it.each([
    {
      label: 'tiny edge contact',
      annotationBox: {
        page: 1,
        x: 0.1999,
        y: 0.2,
        width: 0.02,
        height: 0.018,
        rotation: 0,
        method: 'pdf-link' as const,
      },
      surfaces: [
        {
          targetNodeId: 'reference-one',
          blockNodeId: 'internal-link-source-node',
          start: 0,
          end: 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.14,
              y: 0.2,
              width: 0.06,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text' as const,
            },
          ],
        },
      ],
    },
    {
      label: 'substantial area with insufficient horizontal coverage',
      annotationBox: {
        page: 1,
        x: 0.17,
        y: 0.2,
        width: 0.1,
        height: 0.02,
        rotation: 0,
        method: 'pdf-link' as const,
      },
      surfaces: [
        {
          targetNodeId: 'reference-one',
          blockNodeId: 'internal-link-source-node',
          start: 0,
          end: 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.1,
              y: 0.2,
              width: 0.1,
              height: 0.02,
              rotation: 0,
              method: 'pdf-text' as const,
            },
          ],
        },
      ],
    },
    {
      label: 'substantial area with insufficient vertical coverage',
      annotationBox: {
        page: 1,
        x: 0.13,
        y: 0.211,
        width: 0.1,
        height: 0.02,
        rotation: 0,
        method: 'pdf-link' as const,
      },
      surfaces: [
        {
          targetNodeId: 'reference-one',
          blockNodeId: 'internal-link-source-node',
          start: 0,
          end: 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.1,
              y: 0.2,
              width: 0.1,
              height: 0.02,
              rotation: 0,
              method: 'pdf-text' as const,
            },
          ],
        },
      ],
    },
    {
      label: 'axis coverage with insufficient smaller-area overlap',
      annotationBox: {
        page: 1,
        x: 0.16,
        y: 0.209,
        width: 0.1,
        height: 0.02,
        rotation: 0,
        method: 'pdf-link' as const,
      },
      surfaces: [
        {
          targetNodeId: 'reference-one',
          blockNodeId: 'internal-link-source-node',
          start: 0,
          end: 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.1,
              y: 0.2,
              width: 0.1,
              height: 0.02,
              rotation: 0,
              method: 'pdf-text' as const,
            },
          ],
        },
      ],
    },
    {
      label: 'rotation-mismatched geometry',
      annotationBox: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.1,
        height: 0.02,
        rotation: 0,
        method: 'pdf-link' as const,
      },
      surfaces: [
        {
          targetNodeId: 'reference-one',
          blockNodeId: 'internal-link-source-node',
          start: 0,
          end: 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.1,
              y: 0.2,
              width: 0.1,
              height: 0.02,
              rotation: 90,
              method: 'pdf-text' as const,
            },
          ],
        },
      ],
    },
    {
      label: 'ambiguous broad ownership',
      annotationBox: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.018,
        rotation: 0,
        method: 'pdf-link' as const,
      },
      surfaces: [
        {
          targetNodeId: 'reference-one',
          blockNodeId: 'internal-link-source-node',
          start: 0,
          end: 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.1,
              y: 0.2,
              width: 0.08,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text' as const,
            },
          ],
        },
        {
          targetNodeId: 'reference-two',
          blockNodeId: 'internal-link-source-node',
          start: 4,
          end: 7,
          sourceBoxes: [
            {
              page: 1,
              x: 0.22,
              y: 0.2,
              width: 0.08,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text' as const,
            },
          ],
        },
      ],
    },
    {
      label: 'missing source geometry',
      annotationBox: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.08,
        height: 0.018,
        rotation: 0,
        method: 'pdf-link' as const,
      },
      surfaces: [
        {
          targetNodeId: 'reference-one',
          blockNodeId: 'internal-link-source-node',
          start: 0,
          end: 3,
          sourceBoxes: [],
        },
      ],
    },
  ])(
    'keeps $label citation ownership unresolved',
    ({ annotationBox, surfaces }) => {
      const { block } = canonicalHyperlinkTestBlock('[1] [2]')
      const annotation = {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal' as const,
        destination: 'cite.1',
        box: annotationBox,
      }
      const resolution = resolveCanonicalHyperlinkObligations({
        blocks: [block],
        annotations: [annotation],
        canonicalTargets: [
          {
            kind: 'reference',
            label: 'Reference 1',
            nodeId: 'reference-one',
          },
          {
            kind: 'reference',
            label: 'Reference 2',
            nodeId: 'reference-two',
          },
        ],
        canonicalInternalSurfaces: surfaces,
      })

      expect(resolution.mappings).toEqual([])
      expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
      expect(resolution.diagnostics).toEqual([
        expect.objectContaining({
          code: 'UNRESOLVED_HYPERLINK',
          message: expect.stringMatching(/no exact canonical inline owner/iu),
        }),
      ])
    },
  )

  it('maps vertically overlapping link rectangles when exact source anchors are on disjoint lines', () => {
    const firstText = 'https://example.test/first'
    const secondText = 'https://example.test/second'
    const firstRun = run(1, firstText, 0.1, 0.2, 0.34)
    const secondRun = run(1, secondText, 0.1, 0.212, 0.35)
    const blockFor = (id: string, text: string, sourceRun: PdfSourceRun) => ({
      type: 'paragraph' as const,
      region: {
        id: `${id}-region`,
        page: 1,
        kind: 'body' as const,
        column: 'single' as const,
        text,
        confidence: 1,
        box: { ...sourceRun },
        lines: [
          {
            id: `${id}-line`,
            text,
            fontSize: sourceRun.fontSize,
            box: { ...sourceRun },
            runs: [sourceRun],
          },
        ],
        nativeObjectIds: [],
        includedInReadingOrder: true,
      },
      text,
      confidence: 1,
      nodeId: `${id}-node`,
    })
    const annotations = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'external' as const,
        url: firstText,
        box: {
          ...firstRun,
          height: 0.014,
          method: 'pdf-link' as const,
        },
      },
      {
        id: 'pdf-link-p001-a0002',
        page: 1,
        status: 'external' as const,
        url: secondText,
        box: {
          ...secondRun,
          y: 0.211,
          height: 0.014,
          method: 'pdf-link' as const,
        },
      },
    ]

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [
        blockFor('first', firstText, firstRun),
        blockFor('second', secondText, secondRun),
      ],
      annotations,
    })

    expect(resolution.diagnostics).toEqual([])
    expect(resolution.mappings).toEqual([
      {
        annotationId: annotations[0].id,
        blockNodeId: 'first-node',
        start: 0,
        end: firstText.length,
        href: firstText,
      },
      {
        annotationId: annotations[1].id,
        blockNodeId: 'second-node',
        start: 0,
        end: secondText.length,
        href: secondText,
      },
    ])
    expect(resolution.approvedAnnotationIds).toEqual(
      new Set(annotations.map((annotation) => annotation.id)),
    )
    expect(resolution.ledger).toEqual({ expected: 2, mapped: 2 })
  })

  it('fails overlapping external annotations closed instead of choosing one target', async () => {
    const linked = page(1, [
      run(1, 'Ambiguous linked text remains readable.', 0.1, 0.2, 0.7),
    ])
    const sourceBox = {
      page: 1,
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.018,
      rotation: 0,
      method: 'pdf-link' as const,
    }
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'external',
        url: 'https://example.test/one',
        box: sourceBox,
      },
      {
        id: 'pdf-link-p001-a0002',
        page: 1,
        status: 'external',
        url: 'https://example.test/two',
        box: sourceBox,
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [linked],
      sourceHash: '4'.repeat(64),
      fileName: 'synthetic-overlapping-links.pdf',
      byteLength: 2048,
    })
    const textNode = result.paper.nodes.find(
      (node) => 'text' in node && node.text.includes('Ambiguous linked text'),
    )

    expect(
      textNode && 'inlineRuns' in textNode
        ? textNode.inlineRuns?.filter((run) => run.href)
        : [],
    ).toEqual([])
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'UNRESOLVED_HYPERLINK',
      ),
    ).toHaveLength(2)
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 2,
      mappedHyperlinkCount: 0,
      hyperlinkCoverage: 0,
    })
  })
})

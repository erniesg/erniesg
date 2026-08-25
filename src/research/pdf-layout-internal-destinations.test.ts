import { describe, expect, it } from 'vitest'

import type {
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

describe('PDF semantic reconstruction', () => {
  it('maps a named footnote destination only to an explicit canonical note surface', () => {
    const text = 'See Footnote 1 for implementation details.'
    const { block, box } = canonicalHyperlinkTestBlock(text)
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'Hfootnote.1',
      destinationEvidence: {
        source: 'pdfjs-named-destination',
        destination: 'Hfootnote.1',
        view: 'XYZ',
        page: 1,
        point: {
          page: 1,
          x: 0.5414,
          y: 0.90399,
          rotation: 0,
          method: 'pdf-destination',
        },
        box: null,
      },
      box,
    } as const

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
      canonicalTargets: [
        {
          kind: 'note',
          label: 'Footnote 1',
          nodeId: 'fn-p001-1',
          sourceBoxes: [
            {
              page: 1,
              x: 0.5414,
              y: 0.90517,
              width: 0.28812,
              height: 0.01065,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
        {
          kind: 'reference',
          label: 'Reference 1',
          nodeId: 'reference-one',
          sourceBoxes: [
            {
              page: 1,
              x: 0.53,
              y: 0.9,
              width: 0.32,
              height: 0.03,
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
        start: text.indexOf('Footnote 1'),
        end: text.indexOf('Footnote 1') + 'Footnote 1'.length,
        href: '#fn-p001-1',
      },
    ])
    expect(resolution.diagnostics).toEqual([])
  })

  it('maps a named footnote destination to one exact semantic note-reference surface', () => {
    const text = 'The mechanism directly boosts the answer logit.1'
    const { block } = canonicalHyperlinkTestBlock(text)
    const markerStart = text.length - 1
    const markerBox = {
      page: 1,
      x: 0.388,
      y: 0.196,
      width: 0.012,
      height: 0.01,
      rotation: 0,
      method: 'pdf-text' as const,
    }
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'Hfootnote.1',
      destinationEvidence: {
        source: 'pdfjs-named-destination',
        destination: 'Hfootnote.1',
        view: 'XYZ',
        page: 1,
        point: {
          page: 1,
          x: 0.1,
          y: 0.86,
          rotation: 0,
          method: 'pdf-destination',
        },
        box: null,
      },
      box: {
        ...markerBox,
        method: 'pdf-link' as const,
      },
    } as const

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
      canonicalTargets: [
        {
          kind: 'note',
          label: 'Footnote 1',
          nodeId: 'fn-p001-1',
          sourceBoxes: [
            {
              page: 1,
              x: 0.1,
              y: 0.86,
              width: 0.7,
              height: 0.02,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
      ],
      canonicalInternalSurfaces: [
        {
          targetNodeId: 'fn-p001-1',
          blockNodeId: block.nodeId,
          start: markerStart,
          end: markerStart + 1,
          sourceBoxes: [markerBox],
        },
      ],
    })

    expect(resolution.mappings).toEqual([
      {
        annotationId: annotation.id,
        blockNodeId: block.nodeId,
        start: markerStart,
        end: markerStart + 1,
        href: '#fn-p001-1',
      },
    ])
    expect(resolution.diagnostics).toEqual([])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 1 })
  })

  it('emits one internal href for an exact superscript note reference without linking its surrounding prose', async () => {
    const body = run(
      1,
      'The mechanism directly boosts the answer logit.',
      0.1,
      0.34,
      0.46,
    )
    const marker = {
      ...run(1, '1', 0.562, 0.337, 0.008, 6),
      height: 0.009,
    }
    const linked = page(1, [
      run(1, 'Semantic note hyperlink study', 0.18, 0.07, 0.64, 18),
      run(1, 'Ada Example', 0.4, 0.14, 0.2, 11),
      run(1, 'Abstract', 0.1, 0.23, 0.25, 16),
      body,
      marker,
      run(1, '1 Source-backed implementation detail.', 0.1, 0.86, 0.7, 7),
    ])
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal',
        destination: 'Hfootnote.1',
        destinationEvidence: {
          source: 'pdfjs-named-destination',
          destination: 'Hfootnote.1',
          view: 'XYZ',
          page: 1,
          point: {
            page: 1,
            x: 0.1,
            y: 0.86,
            rotation: 0,
            method: 'pdf-destination',
          },
          box: null,
        },
        box: {
          ...marker,
          method: 'pdf-link',
        },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [linked],
      sourceHash: '1'.repeat(64),
      fileName: 'semantic-note-hyperlink.pdf',
      byteLength: 4096,
    })
    const target = result.paper.nodes.find(
      (node) => node.type === 'footnote' && node.label === '1',
    )
    const owner = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.text.includes('directly boosts the answer logit'),
    )
    const annotationRuns =
      owner && 'inlineRuns' in owner
        ? (owner.inlineRuns ?? []).filter(
            (run) => run.annotationId === 'pdf-link-p001-a0001',
          )
        : []

    expect(target).toBeDefined()
    expect(annotationRuns).toEqual([
      expect.objectContaining({
        href: `#${target!.id}`,
        annotationId: 'pdf-link-p001-a0001',
      }),
    ])
    expect(
      annotationRuns.map((run) =>
        owner && 'text' in owner ? owner.text.slice(run.start, run.end) : '',
      ),
    ).toEqual(['1'])
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 1,
      mappedHyperlinkCount: 1,
      hyperlinkCoverage: 1,
    })
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'UNRESOLVED_HYPERLINK',
      ),
    ).toEqual([])
  })

  it('does not let a narrow footnote annotation claim its surrounding prose run', () => {
    const { block, box } = canonicalHyperlinkTestBlock(
      'The mechanism directly boosts the answer logit.1',
    )
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'Hfootnote.1',
      destinationEvidence: {
        source: 'pdfjs-named-destination',
        destination: 'Hfootnote.1',
        view: 'XYZ',
        page: 1,
        point: {
          page: 1,
          x: 0.5414,
          y: 0.90399,
          rotation: 0,
          method: 'pdf-destination',
        },
        box: null,
      },
      box: {
        ...box,
        x: box.x + box.width * 0.96,
        width: box.width * 0.04,
      },
    } as const

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
      canonicalTargets: [
        {
          kind: 'note',
          label: 'Footnote 1',
          nodeId: 'fn-p001-1',
          sourceBoxes: [
            {
              page: 1,
              x: 0.5414,
              y: 0.90517,
              width: 0.28812,
              height: 0.01065,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
      ],
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        message: expect.stringMatching(/no exact canonical inline owner/iu),
      }),
    ])
  })

  it('uses destination geometry to disambiguate duplicate exact section labels', () => {
    const { block, box } = canonicalHyperlinkTestBlock()
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'section.4',
      destinationEvidence: {
        source: 'pdfjs-named-destination',
        destination: 'section.4',
        view: 'XYZ',
        page: 5,
        point: {
          page: 5,
          x: 0.51429,
          y: 0.47747,
          rotation: 0,
          method: 'pdf-destination',
        },
        box: null,
      },
      box,
    } as const
    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
      canonicalTargets: [
        {
          kind: 'section',
          label: 'Section 4',
          nodeId: 'section-four-near',
          sourceBoxes: [
            {
              page: 5,
              x: 0.51429,
              y: 0.48084,
              width: 0.28,
              height: 0.0142,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
        {
          kind: 'section',
          label: 'Section 4',
          nodeId: 'section-four-far',
          sourceBoxes: [
            {
              page: 5,
              x: 0.1,
              y: 0.1,
              width: 0.3,
              height: 0.02,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
      ],
    })

    expect(resolution.mappings).toEqual([
      expect.objectContaining({ href: '#section-four-near' }),
    ])
    expect(resolution.diagnostics).toEqual([])
  })

  it('does not assign a whole prose run when an internal visual target has no exact source surface', () => {
    const { block, box } = canonicalHyperlinkTestBlock(
      '-1.5B in §B.3, Fig. 11a and Fig. 11b.',
    )
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'figure.11',
      destinationEvidence: {
        source: 'pdfjs-named-destination',
        destination: 'figure.11',
        view: 'XYZ',
        page: 4,
        point: {
          page: 4,
          x: 0.1,
          y: 0.4,
          rotation: 0,
          method: 'pdf-destination',
        },
        box: null,
      },
      box: {
        ...box,
        x: box.x + box.width * 0.7,
        width: box.width * 0.12,
      },
    } as const

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
      canonicalTargets: [
        {
          kind: 'figure',
          label: 'Figure 11',
          nodeId: 'visual-figure-11',
          sourceBoxes: [
            {
              page: 4,
              x: 0.1,
              y: 0.4,
              width: 0.5,
              height: 0.2,
              rotation: 0,
              method: 'pdf-object',
            },
          ],
        },
      ],
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        message: expect.stringMatching(/no exact canonical inline owner/iu),
      }),
    ])
  })

  it.each([
    {
      text: 'The difference appears in Fig. 9.',
      surface: 'Fig. 9',
      destination: 'figure.caption.48',
      kind: 'figure' as const,
      targetLabel: 'Figure 9',
      targetNodeId: 'visual-figure-9',
    },
    {
      text: 'Tab. 9 presents the measured repetitions.',
      surface: 'Tab. 9',
      destination: 'table.caption.62',
      kind: 'table' as const,
      targetLabel: 'Table 9',
      targetNodeId: 'visual-table-9',
    },
  ])(
    'uses the geometry-resolved canonical $kind label for exact source surface $surface',
    ({ text, surface, destination, kind, targetLabel, targetNodeId }) => {
      const { block, box } = canonicalHyperlinkTestBlock(text)
      const annotation = {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal',
        destination,
        destinationEvidence: {
          source: 'pdfjs-named-destination',
          destination,
          view: 'XYZ',
          page: 4,
          point: {
            page: 4,
            x: 0.1,
            y: 0.4,
            rotation: 0,
            method: 'pdf-destination',
          },
          box: null,
        },
        box: {
          ...box,
          x: box.x + box.width * 0.65,
          width: box.width * 0.12,
        },
      } as const

      const resolution = resolveCanonicalHyperlinkObligations({
        blocks: [block],
        annotations: [annotation],
        canonicalTargets: [
          {
            kind,
            label: targetLabel,
            nodeId: targetNodeId,
            sourceBoxes: [
              {
                page: 4,
                x: 0.1,
                y: 0.4,
                width: 0.5,
                height: 0.2,
                rotation: 0,
                method: 'pdf-object',
              },
            ],
          },
        ],
      })
      const start = text.indexOf(surface)

      expect(resolution.mappings).toEqual([
        {
          annotationId: annotation.id,
          blockNodeId: block.nodeId,
          start,
          end: start + surface.length,
          href: `#${targetNodeId}`,
        },
      ])
      expect(resolution.diagnostics).toEqual([])
    },
  )

  it('does not map an internal destination from a target page without target coordinates', () => {
    const { block, box } = canonicalHyperlinkTestBlock()
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'Hfootnote.1',
      destinationEvidence: {
        source: 'pdfjs-named-destination',
        destination: 'Hfootnote.1',
        view: 'Fit',
        page: 8,
        point: null,
        box: null,
      },
      box,
    } as const
    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
      canonicalTargets: [
        {
          kind: 'note',
          label: 'Footnote 1',
          nodeId: 'fn-p008-1',
          sourceBoxes: [
            {
              page: 8,
              x: 0.1,
              y: 0.85,
              width: 0.7,
              height: 0.03,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
      ],
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        message: expect.stringMatching(/unsupported internal PDF destination/i),
      }),
    ])
  })

  it('does not treat an all-null destination point as target geometry', () => {
    const { block, box } = canonicalHyperlinkTestBlock()
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'Hfootnote.1',
      destinationEvidence: {
        source: 'pdfjs-named-destination',
        destination: 'Hfootnote.1',
        view: 'XYZ',
        page: 8,
        point: {
          page: 8,
          x: null,
          y: null,
          rotation: 0,
          method: 'pdf-destination',
        },
        box: null,
      },
      box,
    } as const
    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
      canonicalTargets: [
        {
          kind: 'note',
          label: 'Footnote 1',
          nodeId: 'fn-p008-1',
          sourceBoxes: [
            {
              page: 8,
              x: 0.1,
              y: 0.85,
              width: 0.7,
              height: 0.03,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
      ],
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
  })

  it('keeps equidistant geometry-backed canonical targets ambiguous', () => {
    const { block, box } = canonicalHyperlinkTestBlock()
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'cite.SourceKey',
      destinationEvidence: {
        source: 'pdfjs-named-destination',
        destination: 'cite.SourceKey',
        view: 'XYZ',
        page: 4,
        point: {
          page: 4,
          x: 0.5,
          y: 0.5,
          rotation: 0,
          method: 'pdf-destination',
        },
        box: null,
      },
      box,
    } as const
    const sharedBox = {
      page: 4,
      x: 0.49,
      y: 0.49,
      width: 0.02,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text' as const,
    }
    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
      canonicalTargets: [
        {
          kind: 'reference',
          label: 'Reference 1',
          nodeId: 'reference-one',
          sourceBoxes: [sharedBox],
        },
        {
          kind: 'reference',
          label: 'Reference 2',
          nodeId: 'reference-two',
          sourceBoxes: [sharedBox],
        },
      ],
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        message: expect.stringMatching(/more than one canonical target/i),
      }),
    ])
  })

  it('keeps a same-page but geometrically distant BibTeX-key destination unresolved', () => {
    const { block, box } = canonicalHyperlinkTestBlock()
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'cite.SourceKey',
      destinationEvidence: {
        source: 'pdfjs-named-destination',
        destination: 'cite.SourceKey',
        view: 'XYZ',
        page: 4,
        point: {
          page: 4,
          x: 0.1,
          y: 0.1,
          rotation: 0,
          method: 'pdf-destination',
        },
        box: null,
      },
      box,
    } as const
    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
      canonicalTargets: [
        {
          kind: 'reference',
          label: 'Reference 1',
          nodeId: 'reference-one',
          sourceBoxes: [
            {
              page: 4,
              x: 0.7,
              y: 0.8,
              width: 0.2,
              height: 0.02,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
      ],
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        message: expect.stringMatching(/no exact canonical target/i),
      }),
    ])
  })
})

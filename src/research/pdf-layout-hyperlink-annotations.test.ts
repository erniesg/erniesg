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

function splitExternalHyperlinkTestBlock({
  text,
  continuation,
  target,
}: {
  text: string
  continuation: string
  target: string
}) {
  const scheme = run(1, 'https:', 0.7, 0.2, 0.06)
  const authority = run(1, continuation, 0.1, 0.22, 0.24)
  const region = {
    id: 'split-external-link-region',
    page: 1,
    kind: 'body',
    column: 'single',
    text,
    confidence: 1,
    box: {
      page: 1,
      x: 0.1,
      y: 0.2,
      width: 0.66,
      height: 0.038,
      rotation: 0,
      method: 'pdf-text',
    },
    lines: [
      {
        id: 'split-external-link-line-1',
        text: scheme.text,
        fontSize: scheme.fontSize,
        box: { ...scheme },
        runs: [scheme],
      },
      {
        id: 'split-external-link-line-2',
        text: authority.text,
        fontSize: authority.fontSize,
        box: { ...authority },
        runs: [authority],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
  const annotations = [scheme, authority].map((sourceRun, index) => ({
    id: `pdf-link-p001-a${String(index + 1).padStart(4, '0')}`,
    page: 1,
    status: 'external' as const,
    url: index === 0 ? target.replace(/\/$/u, '') : target,
    box: { ...sourceRun, method: 'pdf-link' as const },
  }))
  return {
    block: {
      type: 'paragraph' as const,
      region,
      text,
      confidence: 1,
      nodeId: 'split-external-link-node',
    },
    annotations,
  }
}

describe('PDF semantic reconstruction', () => {
  it('fails a BibTeX-key citation closed when no exact citation surface owns the annotation', () => {
    const { block, box } = canonicalHyperlinkTestBlock()
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'cite.charniak1972toward',
      destinationEvidence: {
        source: 'pdfjs-named-destination',
        destination: 'cite.charniak1972toward',
        view: 'XYZ',
        page: 11,
        point: {
          page: 11,
          x: 0.11068,
          y: 0.41442,
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
          label: 'Reference 17',
          nodeId: 'bibliography-charniak',
          sourceBoxes: [
            {
              page: 11,
              x: 0.11905,
              y: 0.41561,
              width: 0.36667,
              height: 0.01183,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
      ],
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.approvedAnnotationIds).toEqual(new Set())
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        severity: 'error',
        message: expect.stringMatching(/no exact canonical inline owner/iu),
      }),
    ])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
  })

  it('resolves a biblatex refsection citation destination through named-destination geometry', () => {
    const { block, box } = canonicalHyperlinkTestBlock()
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'cite.0@creativex',
      destinationEvidence: {
        source: 'pdfjs-named-destination',
        destination: 'cite.0@creativex',
        view: 'XYZ',
        page: 11,
        point: {
          page: 11,
          x: 0.11068,
          y: 0.41442,
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
          label: 'Reference 3',
          nodeId: 'bibliography-creativex',
          sourceBoxes: [
            {
              page: 11,
              x: 0.11905,
              y: 0.41561,
              width: 0.36667,
              height: 0.01183,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
      ],
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        severity: 'error',
        message: expect.stringMatching(/no exact canonical inline owner/iu),
      }),
    ])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
  })

  it('resolves a biblatex citation destination whose entry key contains path characters', () => {
    const { block, box } = canonicalHyperlinkTestBlock()
    const destination =
      'cite.0@annurev:/content/journals/10.1146/annurev-control-090523-100059'
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination,
      destinationEvidence: {
        source: 'pdfjs-named-destination',
        destination,
        view: 'XYZ',
        page: 11,
        point: {
          page: 11,
          x: 0.11068,
          y: 0.41442,
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
          label: 'Reference 9',
          nodeId: 'bibliography-annurev',
          sourceBoxes: [
            {
              page: 11,
              x: 0.11905,
              y: 0.41561,
              width: 0.36667,
              height: 0.01183,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
      ],
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        severity: 'error',
        message: expect.stringMatching(/no exact canonical inline owner/iu),
      }),
    ])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
  })

  it.each([
    {
      rotation: 0,
      point: { x: 0.1, y: 0.4 },
      previous: { x: 0.1, y: 0.37, width: 0.8, height: 0.03 },
      intended: { x: 0.1, y: 0.4025, width: 0.8, height: 0.03 },
    },
    {
      rotation: 90,
      point: { x: 0.4, y: 0.1 },
      previous: { x: 0.4, y: 0.1, width: 0.03, height: 0.8 },
      intended: { x: 0.3675, y: 0.1, width: 0.03, height: 0.8 },
    },
    {
      rotation: 180,
      point: { x: 0.1, y: 0.4 },
      previous: { x: 0.1, y: 0.4, width: 0.8, height: 0.03 },
      intended: { x: 0.1, y: 0.3675, width: 0.8, height: 0.03 },
    },
    {
      rotation: 270,
      point: { x: 0.4, y: 0.1 },
      previous: { x: 0.37, y: 0.1, width: 0.03, height: 0.8 },
      intended: { x: 0.4025, y: 0.1, width: 0.03, height: 0.8 },
    },
  ])(
    'treats a $rotation° XYZ destination point as a target anchor instead of the preceding block edge',
    ({ rotation, point, previous, intended }) => {
      const text = '[37, 222]'
      const { block, box } = canonicalHyperlinkTestBlock(text)
      const firstLabelStart = text.indexOf('37')
      const firstLabelEnd = firstLabelStart + '37'.length
      const secondLabelStart = text.indexOf('222')
      const secondLabelEnd = secondLabelStart + '222'.length
      const inlineBox = (start: number, end: number) => ({
        ...box,
        x: box.x + box.width * (start / text.length),
        width: box.width * ((end - start) / text.length),
      })
      const annotation = {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal',
        destination: 'cite.sourceBackedEntry',
        destinationEvidence: {
          source: 'pdfjs-named-destination',
          destination: 'cite.sourceBackedEntry',
          view: 'XYZ',
          page: 11,
          point: {
            page: 11,
            ...point,
            rotation,
            method: 'pdf-destination',
          },
          box: null,
        },
        box: inlineBox(firstLabelStart, firstLabelEnd),
      } as const
      const resolution = resolveCanonicalHyperlinkObligations({
        blocks: [block],
        annotations: [annotation],
        canonicalTargets: [
          {
            kind: 'reference',
            label: 'Reference 36',
            nodeId: 'bibliography-previous',
            sourceBoxes: [
              {
                page: 11,
                ...previous,
                rotation,
                method: 'pdf-text',
              },
            ],
          },
          {
            kind: 'reference',
            label: 'Reference 37',
            nodeId: 'bibliography-intended',
            sourceBoxes: [
              {
                page: 11,
                ...intended,
                rotation,
                method: 'pdf-text',
              },
            ],
          },
          {
            kind: 'reference',
            label: 'Reference 222',
            nodeId: 'bibliography-other',
            sourceBoxes: [
              {
                page: 11,
                x: 0.1,
                y: 0.7,
                width: 0.8,
                height: 0.03,
                rotation,
                method: 'pdf-text',
              },
            ],
          },
        ],
        canonicalInternalSurfaces: [
          {
            targetNodeId: 'bibliography-intended',
            blockNodeId: block.nodeId,
            start: firstLabelStart,
            end: firstLabelEnd,
            sourceBoxes: [inlineBox(firstLabelStart, firstLabelEnd)],
          },
          {
            targetNodeId: 'bibliography-other',
            blockNodeId: block.nodeId,
            start: secondLabelStart,
            end: secondLabelEnd,
            sourceBoxes: [inlineBox(secondLabelStart, secondLabelEnd)],
          },
        ],
      })

      expect(resolution.mappings).toEqual([
        {
          annotationId: annotation.id,
          blockNodeId: block.nodeId,
          start: firstLabelStart,
          end: firstLabelEnd,
          href: '#bibliography-intended',
        },
      ])
      expect(resolution.diagnostics).toEqual([])
      expect(resolution.ledger).toEqual({ expected: 1, mapped: 1 })
    },
  )

  it('keeps a biblatex citation destination without named-destination geometry unsupported', () => {
    const { block, box } = canonicalHyperlinkTestBlock()
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'cite.0@creativex',
      box,
    } as const

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
      canonicalTargets: [
        {
          kind: 'reference',
          label: 'Reference 3',
          nodeId: 'bibliography-creativex',
          sourceBoxes: [
            {
              page: 11,
              x: 0.11905,
              y: 0.41561,
              width: 0.36667,
              height: 0.01183,
              rotation: 0,
              method: 'pdf-text',
            },
          ],
        },
      ],
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        severity: 'error',
        message: expect.stringMatching(
          /unsupported internal PDF destination scheme/iu,
        ),
      }),
    ])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
  })

  it('maps an exact arXiv target surface without retaining an overlapping neighboring bibliography owner', () => {
    const text =
      'Detection and Editing for Language Models. arXiv:2401.06855 [cs]'
    const arxivId = '2401.06855'
    const start = text.indexOf(arxivId)
    const end = start + arxivId.length
    const { block, box } = canonicalHyperlinkTestBlock(text)
    const sourceRun = block.region.lines[0].runs[0]
    const adjacentText =
      'Neighboring bibliography entry without the linked identifier.'
    const adjacentRun = {
      ...sourceRun,
      text: adjacentText,
      sourceSequenceIndex: (sourceRun.sourceSequenceIndex ?? 0) + 1,
    }
    const adjacentRegion = {
      ...block.region,
      id: 'adjacent-reference-region',
      text: adjacentText,
      lines: [
        {
          ...block.region.lines[0],
          id: 'adjacent-reference-line',
          text: adjacentText,
          runs: [adjacentRun],
        },
      ],
    }
    const adjacentBlock = {
      ...block,
      region: adjacentRegion,
      text: adjacentText,
      nodeId: 'adjacent-reference-node',
    }
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'external' as const,
      url: `https://arxiv.org/abs/${arxivId}`,
      box: {
        ...box,
        x: sourceRun.x + sourceRun.width * 0.7675984032567996,
        y: sourceRun.y + sourceRun.height * 0.15165043943943362,
        width: sourceRun.width * 0.17274752104265478,
        height: sourceRun.height * 1.227670266599994,
      },
    }

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block, adjacentBlock],
      annotations: [annotation],
    })

    expect(resolution.mappings).toEqual([
      {
        annotationId: annotation.id,
        blockNodeId: block.nodeId,
        start,
        end,
        href: annotation.url,
      },
    ])
    expect(resolution.sourceAnchorLedger).toEqual([
      expect.objectContaining({
        annotationId: annotation.id,
        fragments: [
          expect.objectContaining({
            regionId: block.region.id,
            sourceStart: start,
            sourceEnd: end,
            text: arxivId,
            ownershipEvidence: 'external-target-alias-character-interval-v1',
          }),
        ],
      }),
    ])
    expect(resolution.diagnostics).toEqual([])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 1 })
  })

  it('coalesces contiguous same-target URL fragments into one canonical hyperlink range', () => {
    const text = 'https://leandojo.org.'
    const { block, annotations } = splitExternalHyperlinkTestBlock({
      text,
      continuation: '//leandojo.org',
      target: 'https://leandojo.org/',
    })

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations,
    })

    expect(resolution.mappings).toEqual(
      annotations.map((annotation) => ({
        annotationId: annotation.id,
        blockNodeId: block.nodeId,
        start: 0,
        end: text.length - 1,
        href: annotation.url,
      })),
    )
    expect(resolution.approvedAnnotationIds).toEqual(
      new Set(annotations.map((annotation) => annotation.id)),
    )
    expect(
      resolution.sourceAnchorLedger.map((anchor) =>
        anchor.fragments.map((fragment) => ({
          regionId: fragment.regionId,
          lineId: fragment.lineId,
          text: fragment.text,
        })),
      ),
    ).toEqual([
      [
        {
          regionId: 'split-external-link-region',
          lineId: 'split-external-link-line-1',
          text: 'https:',
        },
      ],
      [
        {
          regionId: 'split-external-link-region',
          lineId: 'split-external-link-line-2',
          text: '//leandojo.org',
        },
      ],
    ])
    expect(resolution.diagnostics).toEqual([])
    expect(resolution.ledger).toEqual({ expected: 2, mapped: 2 })
  })

  it('maps a source anchor through joined region segments without rescanning same-page columns', () => {
    const prefixRun = run(1, 'Read', 0.1, 0.2, 0.08)
    const linkedRun = run(1, 'project page', 0.2, 0.2, 0.2)
    const decoyRun = run(1, 'project page', 0.62, 0.2, 0.2)
    const sourceRegion = (
      id: string,
      text: string,
      sourceRun: PdfSourceRun,
      column: 'left' | 'right',
    ) =>
      ({
        id,
        page: 1,
        kind: 'body',
        column,
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
      }) satisfies PdfPageRegion
    const prefixRegion = sourceRegion(
      'joined-prefix-region',
      prefixRun.text,
      prefixRun,
      'left',
    )
    const linkedRegion = sourceRegion(
      'joined-link-region',
      linkedRun.text,
      linkedRun,
      'left',
    )
    const decoyRegion = sourceRegion(
      'same-page-decoy-region',
      decoyRun.text,
      decoyRun,
      'right',
    )
    const block = {
      type: 'paragraph' as const,
      region: prefixRegion,
      text: 'Read project page',
      confidence: 1,
      nodeId: 'joined-source-node',
      sourceSegments: [
        {
          region: prefixRegion,
          sourceStart: 0,
          canonicalStart: 0,
          text: prefixRun.text,
        },
        {
          region: linkedRegion,
          sourceStart: 0,
          canonicalStart: 5,
          text: linkedRun.text,
        },
      ],
    }
    const decoyBlock = {
      type: 'paragraph' as const,
      region: decoyRegion,
      text: decoyRun.text,
      confidence: 1,
      nodeId: 'same-page-decoy-node',
    }
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'external' as const,
      url: 'https://example.test/project',
      box: { ...linkedRun, method: 'pdf-link' as const },
    }

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block, decoyBlock],
      annotations: [annotation],
    })

    expect(resolution.mappings).toEqual([
      {
        annotationId: annotation.id,
        blockNodeId: block.nodeId,
        start: 5,
        end: block.text.length,
        href: annotation.url,
      },
    ])
    expect(resolution.sourceAnchorLedger).toEqual([
      expect.objectContaining({
        annotationId: annotation.id,
        status: 'anchored',
        fragments: [
          expect.objectContaining({
            regionId: linkedRegion.id,
            lineId: `${linkedRegion.id}-line`,
            sourceStart: 0,
            sourceEnd: linkedRun.text.length,
            text: linkedRun.text,
          }),
        ],
      }),
    ])
    expect(resolution.diagnostics).toEqual([])
  })

  it('preserves source intervals when a canonical join removes a discretionary hyphen', () => {
    const leftRun = run(1, 'hyper-', 0.1, 0.2, 0.12)
    const rightRun = run(1, 'link', 0.1, 0.23, 0.08)
    const sourceRegion = (
      id: string,
      sourceRun: PdfSourceRun,
    ): PdfPageRegion => ({
      id,
      page: 1,
      kind: 'body',
      column: 'single',
      text: sourceRun.text,
      confidence: 1,
      box: { ...sourceRun },
      lines: [
        {
          id: `${id}-line`,
          text: sourceRun.text,
          fontSize: sourceRun.fontSize,
          box: { ...sourceRun },
          runs: [sourceRun],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })
    const leftRegion = sourceRegion('hyphen-left-region', leftRun)
    const rightRegion = sourceRegion('hyphen-right-region', rightRun)
    const block = {
      type: 'paragraph' as const,
      region: leftRegion,
      text: 'hyperlink',
      confidence: 1,
      nodeId: 'hyphen-joined-node',
      sourceSegments: [
        {
          region: leftRegion,
          sourceStart: 0,
          canonicalStart: 0,
          text: 'hyper',
        },
        {
          region: rightRegion,
          sourceStart: 0,
          canonicalStart: 5,
          text: rightRun.text,
        },
      ],
    }
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'external' as const,
      url: 'https://example.test/hyperlink',
      box: {
        page: 1,
        x: 0.09,
        y: 0.19,
        width: 0.15,
        height: 0.06,
        rotation: 0,
        method: 'pdf-link' as const,
      },
    }

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
    })

    expect(resolution.mappings).toEqual([
      {
        annotationId: annotation.id,
        blockNodeId: block.nodeId,
        start: 0,
        end: block.text.length,
        href: annotation.url,
      },
    ])
    expect(
      resolution.sourceAnchorLedger[0].fragments.map((fragment) => ({
        regionId: fragment.regionId,
        sourceStart: fragment.sourceStart,
        sourceEnd: fragment.sourceEnd,
        text: fragment.text,
      })),
    ).toEqual([
      {
        regionId: leftRegion.id,
        sourceStart: 0,
        sourceEnd: 5,
        text: 'hyper',
      },
      {
        regionId: rightRegion.id,
        sourceStart: 0,
        sourceEnd: 4,
        text: 'link',
      },
    ])
    expect(
      Object.keys(resolution.sourceAnchorLedger[0].fragments[0].sourceBox),
    ).toEqual(['page', 'x', 'y', 'width', 'height', 'rotation', 'method'])
    expect(resolution.diagnostics).toEqual([])
  })

  it('coalesces overlapping same-target annotations onto one punctuation-bounded visible URL', () => {
    const text = 'https://example.test/archive.'
    const { block, box } = canonicalHyperlinkTestBlock(text)
    const target = 'https://example.test/archive'
    const annotations = [1, 2].map((index) => ({
      id: `pdf-link-p001-a${String(index).padStart(4, '0')}`,
      page: 1,
      status: 'external' as const,
      url: target,
      box: {
        ...box,
        x: box.x + (index - 1) * 0.002,
        width: box.width - (index - 1) * 0.002,
      },
    }))

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations,
    })

    expect(resolution.mappings).toEqual(
      annotations.map((annotation) => ({
        annotationId: annotation.id,
        blockNodeId: block.nodeId,
        start: 0,
        end: target.length,
        href: target,
      })),
    )
    expect(resolution.approvedAnnotationIds).toEqual(
      new Set(annotations.map((annotation) => annotation.id)),
    )
    expect(resolution.diagnostics).toEqual([])
    expect(resolution.ledger).toEqual({ expected: 2, mapped: 2 })
  })

  it('emits a hyperlink obligation when same-target visible fragments cannot round-trip', () => {
    const { block, annotations } = splitExternalHyperlinkTestBlock({
      text: 'https: //example.org/a b',
      continuation: '//example.org/a b',
      target: 'https://example.org/a%20b',
    })

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations,
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.approvedAnnotationIds).toEqual(new Set())
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        severity: 'error',
        message: expect.stringMatching(/visible URL fragments.*round-trip/iu),
        sourceBoxes: annotations.map((annotation) => annotation.box),
      }),
    ])
    expect(resolution.ledger).toEqual({ expected: 2, mapped: 0 })
  })

  it('fails a single annotation over a truncated visible URL closed', () => {
    const { block, box } = canonicalHyperlinkTestBlock(
      'https://transformer-circuits. .',
    )
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'external',
      url: 'https://transformer-circuits.pub/2022/toy_model/index.html',
      box,
    } as const

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.approvedAnnotationIds).toEqual(new Set())
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        severity: 'error',
        message: expect.stringMatching(/visible URL fragments.*round-trip/iu),
        sourceBoxes: [annotation.box],
      }),
    ])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
  })

  it('fails a single broad URL annotation with missing path text closed', () => {
    const { block, box } = canonicalHyperlinkTestBlock(
      'https: //transformer-circuits.pub/2024/ .',
    )
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'external',
      url: 'https://transformer-circuits.pub/2024/scaling-monosemanticity/index.html',
      box,
    } as const

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.approvedAnnotationIds).toEqual(new Set())
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        severity: 'error',
        message: expect.stringMatching(/visible URL fragments.*round-trip/iu),
      }),
    ])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
  })

  it('keeps a descriptive external-link label when its target is source-approved', () => {
    const { block, box } = canonicalHyperlinkTestBlock('Project homepage')
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'external',
      url: 'https://example.test/project',
      box,
    } as const

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
    })

    expect(resolution.mappings).toEqual([
      {
        annotationId: annotation.id,
        blockNodeId: block.nodeId,
        start: 0,
        end: block.text.length,
        href: annotation.url,
      },
    ])
    expect(resolution.diagnostics).toEqual([])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 1 })
  })

  it.each([0, 90, 180, 270])(
    'fails a narrow annotation over a multi-token source run closed at %i° rotation',
    (rotation) => {
      const { block, box } = canonicalHyperlinkTestBlock(
        'Read the project homepage for details',
      )
      const sourceRun = block.region.lines[0].runs[0]
      sourceRun.rotation = rotation
      block.region.box.rotation = rotation
      block.region.lines[0].box.rotation = rotation
      const annotation = {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'external' as const,
        url: 'https://example.test/project',
        box: {
          ...box,
          rotation,
          x: box.x + box.width * 0.28,
          width: box.width * 0.22,
        },
      }

      const resolution = resolveCanonicalHyperlinkObligations({
        blocks: [block],
        annotations: [annotation],
      })

      expect(resolution.sourceAnchorLedger).toEqual([
        expect.objectContaining({
          status: 'anchored',
          fragments: [
            expect.objectContaining({
              sourceStart: 0,
              sourceEnd: block.text.length,
              text: block.text,
            }),
          ],
        }),
      ])
      expect(resolution.mappings).toEqual([])
      expect(resolution.approvedAnnotationIds).toEqual(new Set())
      expect(resolution.diagnostics).toEqual([
        expect.objectContaining({
          code: 'UNRESOLVED_HYPERLINK',
          relationshipId: annotation.id,
          message: expect.stringMatching(/no exact canonical inline owner/iu),
        }),
      ])
      expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
    },
  )

  it.each([0, 90, 180, 270])(
    'maps one exact source-backed external-link sub-run without claiming its surrounding prose at %i° rotation',
    (rotation) => {
      const text = 'Read the project homepage for details'
      const { block } = canonicalHyperlinkTestBlock(text)
      const sourceRun = block.region.lines[0].runs[0]
      sourceRun.rotation = rotation
      block.region.box.rotation = rotation
      block.region.lines[0].box.rotation = rotation
      const start = text.indexOf('project homepage')
      const end = start + 'project homepage'.length
      const annotation = {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'external' as const,
        url: 'https://example.test/project',
        box: sourceSubstringBox(sourceRun, start, end),
      }

      const resolution = resolveCanonicalHyperlinkObligations({
        blocks: [block],
        annotations: [annotation],
      })

      expect(resolution.sourceAnchorLedger).toEqual([
        expect.objectContaining({
          status: 'anchored',
          fragments: [
            expect.objectContaining({
              sourceStart: start,
              sourceEnd: end,
              text: 'project homepage',
              ownershipEvidence: 'single-pdf-text-run-character-interval-v1',
              sourceBox: {
                ...annotation.box,
                method: 'pdf-text',
              },
            }),
          ],
        }),
      ])
      expect(resolution.mappings).toEqual([
        {
          annotationId: annotation.id,
          blockNodeId: block.nodeId,
          start,
          end,
          href: annotation.url,
        },
      ])
      expect(resolution.approvedAnnotationIds).toEqual(new Set([annotation.id]))
      expect(resolution.diagnostics).toEqual([])
      expect(resolution.ledger).toEqual({ expected: 1, mapped: 1 })
    },
  )

  it('narrows a partial-run annotation only when one literal URL proves the range', () => {
    const url = 'https://example.test/project'
    const text = `Read ${url} for details`
    const { block, box } = canonicalHyperlinkTestBlock(text)
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'external' as const,
      url,
      box: {
        ...box,
        x: box.x + box.width * 0.12,
        width: box.width * 0.62,
      },
    }

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
    })

    expect(resolution.mappings).toEqual([
      {
        annotationId: annotation.id,
        blockNodeId: block.nodeId,
        start: text.indexOf(url),
        end: text.indexOf(url) + url.length,
        href: url,
      },
    ])
    expect(resolution.diagnostics).toEqual([])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 1 })
  })

  it('fails a truncated linked URL continuation closed without exposing partial token anchors', () => {
    const { block, annotations } = splitExternalHyperlinkTestBlock({
      text: 'https: //docs.example.test/archive-continuation/index.html',
      continuation: '//docs.example.test/archive-',
      target: 'https://docs.example.test/archive-continuation/index.html',
    })

    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations,
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.approvedAnnotationIds).toEqual(new Set())
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        severity: 'error',
        message: expect.stringMatching(/visible URL fragments.*round-trip/iu),
        sourceBoxes: annotations.map((annotation) => annotation.box),
      }),
    ])
    expect(resolution.ledger).toEqual({ expected: 2, mapped: 0 })
  })

  it('removes a synthetic bibliography block separator only for a proved linked URL token', async () => {
    const linked = page(1, [
      run(1, 'Linked Bibliography Study', 0.2, 0.05, 0.6, 18),
      run(1, 'Ada Example', 0.4, 0.1, 0.2, 11),
      run(1, 'Abstract', 0.1, 0.14, 0.2, 14),
      run(
        1,
        'This source-backed fixture verifies bibliography URL continuity.',
        0.1,
        0.17,
        0.72,
      ),
      run(1, 'References', 0.1, 0.24, 0.3, 14),
      run(1, '[1] Cai, T. URL', 0.1, 0.3, 0.55),
      run(1, 'https:', 0.72, 0.3, 0.06),
      run(1, '//openreview.net/forum?id=proved', 0.12, 0.36, 0.42),
    ])
    const scheme = linked.runs[6]
    const continuation = linked.runs[7]
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'external',
        url: 'https://openreview.net/forum?id=proved',
        box: { ...scheme, method: 'pdf-link' },
      },
      {
        id: 'pdf-link-p001-a0002',
        page: 1,
        status: 'external',
        url: 'https://openreview.net/forum?id=proved',
        box: { ...continuation, method: 'pdf-link' },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [linked],
      sourceHash: '7'.repeat(64),
      fileName: 'split-bibliography-url.pdf',
      byteLength: 2048,
    })
    const reference = result.paper.nodes.find(
      (node) => node.type === 'paragraph' && node.text.includes('Cai, T. URL'),
    )

    expect(reference && 'text' in reference ? reference.text : null).toBe(
      'Cai, T. URL https://openreview.net/forum?id=proved',
    )
    expect(
      reference && 'inlineRuns' in reference
        ? reference.inlineRuns?.filter((candidate) => candidate.href)
        : [],
    ).toEqual([
      expect.objectContaining({
        start: 12,
        end: 50,
        href: 'https://openreview.net/forum?id=proved',
      }),
    ])
  })

  it('removes a bibliography block separator when source link geometry overreaches trailing prose', async () => {
    const linked = page(1, [
      run(1, 'Linked Bibliography Study', 0.2, 0.05, 0.6, 18),
      run(1, 'Ada Example', 0.4, 0.1, 0.2, 11),
      run(1, 'Abstract', 0.1, 0.14, 0.2, 14),
      run(
        1,
        'This fixture verifies a URL whose final link box includes prose.',
        0.1,
        0.17,
        0.72,
      ),
      run(1, 'References', 0.1, 0.24, 0.3, 14),
      run(1, '[1] Cai, T. URL', 0.1, 0.3, 0.55),
      run(1, 'https://openreview.net/', 0.72, 0.3, 0.2),
      run(1, 'forum?id=proved. under review.', 0.12, 0.36, 0.42),
    ])
    const scheme = linked.runs[6]
    const continuation = linked.runs[7]
    const target = 'https://openreview.net/forum?id=proved'
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'external',
        url: target,
        box: { ...scheme, method: 'pdf-link' },
      },
      {
        id: 'pdf-link-p001-a0002',
        page: 1,
        status: 'external',
        url: target,
        box: { ...continuation, method: 'pdf-link' },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [linked],
      sourceHash: '7'.repeat(64),
      fileName: 'overreaching-split-bibliography-url.pdf',
      byteLength: 2048,
    })
    const reference = result.paper.nodes.find(
      (node) => node.type === 'paragraph' && node.text.includes('Cai, T. URL'),
    )

    expect(reference && 'text' in reference ? reference.text : null).toBe(
      `Cai, T. URL ${target}. under review.`,
    )
  })
})

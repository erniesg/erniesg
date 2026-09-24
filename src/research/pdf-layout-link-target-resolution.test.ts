import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildEpub, buildReadableEpub, inspectEpub } from './epub'
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
  it('maps a safe literal absolute URL when no PDF link annotation exists', async () => {
    const url = 'https://example.test/archive?q=one&lang=en'
    const literal = run(
      1,
      `Source evidence at ${url}, remains linked without an annotation.`,
      0.1,
      0.2,
      0.78,
    )
    const unsafe = run(
      1,
      'A javascript:alert(1) literal and /relative/path remain plain text.',
      0.1,
      0.24,
      0.78,
    )
    const result = await reconstructPageAnalyses({
      pages: [page(1, [literal, unsafe])],
      sourceHash: '1'.repeat(64),
      fileName: 'synthetic-literal-links.pdf',
      byteLength: 2048,
    })
    const node = result.paper.nodes.find(
      (candidate) => 'text' in candidate && candidate.text.includes(url),
    )

    expect(node && 'inlineRuns' in node ? node.inlineRuns : undefined).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          start: node && 'text' in node ? node.text.indexOf(url) : -1,
          end:
            node && 'text' in node ? node.text.indexOf(url) + url.length : -1,
          href: url,
        }),
      ]),
    )
    expect(
      result.paper.nodes.flatMap((candidate) =>
        'inlineRuns' in candidate
          ? (candidate.inlineRuns ?? []).flatMap((inline) =>
              inline.href ? [inline.href] : [],
            )
          : [],
      ),
    ).toEqual([url])
  })

  it('maps one complete literal URL across a source line boundary', async () => {
    const url = 'https://sample-domain.test/archive'
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Source evidence at https://sample-', 0.1, 0.2, 0.45),
          run(1, 'domain.test/archive remains readable.', 0.1, 0.222, 0.45),
        ]),
      ],
      sourceHash: '3'.repeat(64),
      fileName: 'synthetic-wrapped-literal-link.pdf',
      byteLength: 2048,
    })
    const node = result.paper.nodes.find(
      (candidate) => 'text' in candidate && candidate.text.includes(url),
    )

    expect(node && 'text' in node ? node.text : null).toContain(
      `${url} remains readable.`,
    )
    expect(node && 'inlineRuns' in node ? node.inlineRuns : undefined).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          start: node && 'text' in node ? node.text.indexOf(url) : -1,
          end:
            node && 'text' in node ? node.text.indexOf(url) + url.length : -1,
          href: url,
        }),
      ]),
    )
    expect(
      result.paper.nodes.flatMap((candidate) =>
        'inlineRuns' in candidate
          ? (candidate.inlineRuns ?? []).flatMap((inline) =>
              inline.href ? [inline.href] : [],
            )
          : [],
      ),
    ).toEqual([url])
  })

  it('does not infer a literal URL through an overlapping unresolved annotation', async () => {
    const url = 'https://example.test/annotated'
    const linked = page(1, [
      run(1, `Annotated literal ${url} remains readable.`, 0.1, 0.2, 0.78),
    ])
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'unresolved',
        target: url,
        reason: 'conflicting-targets',
        box: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.78,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [linked],
      sourceHash: '2'.repeat(64),
      fileName: 'synthetic-annotated-literal-link.pdf',
      byteLength: 2048,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        'inlineRuns' in node
          ? (node.inlineRuns ?? []).filter((run) => run.href)
          : [],
      ),
    ).toEqual([])
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_HYPERLINK',
    )
  })

  it('keeps malformed embedded URLs as blocking source obligations', async () => {
    const linked = page(1, [
      run(1, 'Malformed link text remains readable.', 0.1, 0.2, 0.7),
    ])
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'unresolved',
        target: String.raw`https://example.test/archive\n\nor`,
        reason: 'unsafe-external-target',
        box: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.7,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [linked],
      sourceHash: '2'.repeat(64),
      fileName: 'synthetic-malformed-link.pdf',
      byteLength: 2048,
    })
    const textNode = result.paper.nodes.find(
      (candidate) =>
        'text' in candidate && candidate.text.includes('Malformed link text'),
    )

    expect(textNode && 'text' in textNode ? textNode.text : '').toContain(
      'Malformed link text remains readable.',
    )
    expect(
      textNode && 'inlineRuns' in textNode
        ? (textNode.inlineRuns ?? []).flatMap((run) =>
            run.href ? [run.href] : [],
          )
        : [],
    ).toEqual([])
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 1,
      mappedHyperlinkCount: 0,
      hyperlinkCoverage: 0,
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_HYPERLINK',
          severity: 'error',
          page: 1,
          relationshipId: 'pdf-link-p001-a0001',
          sourceBoxes: linked.links[0].box ? [linked.links[0].box] : undefined,
        }),
      ]),
    )
    expect(result.readiness.ready).toBe(false)
  })

  it('anchors explicit section and appendix references to unique canonical headings', async () => {
    const appendixHeading = {
      ...run(2, 'A Supplement', 0.1, 0.12, 0.36, 11),
      fontName: 'NimbusRomNo9L-Medi',
    }
    const secondAppendixHeading = {
      ...run(2, 'B Additional Results', 0.1, 0.5, 0.44, 11),
      fontName: 'NimbusRomNo9L-Medi',
    }
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Deterministic cross references', 0.1, 0.06, 0.74, 20),
          run(1, '1. Introduction', 0.1, 0.16, 0.36, 16),
          run(
            1,
            'See Section 6.1 and Appendix A for the full results.',
            0.1,
            0.22,
            0.78,
          ),
          run(1, '6.1 Evaluation', 0.1, 0.42, 0.36, 16),
          run(1, 'The evaluation is deterministic.', 0.1, 0.48, 0.7),
        ]),
        page(2, [
          appendixHeading,
          run(2, 'Supplementary evidence.', 0.1, 0.22, 0.6),
          secondAppendixHeading,
          run(2, 'Additional evidence.', 0.1, 0.6, 0.6),
        ]),
      ],
      sourceHash: '3'.repeat(64),
      fileName: 'synthetic-cross-references.pdf',
      byteLength: 2048,
    })

    expect(
      result.crossReferenceRelationships.map(
        (relationship) => relationship.text,
      ),
    ).toEqual(['Section 6.1', 'Appendix A'])
    for (const relationship of result.crossReferenceRelationships) {
      expect(relationship).toMatchObject({
        status: 'matched',
        targetNodeIds: [expect.any(String)],
        canonicalAnchor: {
          nodeId: expect.any(String),
          start: expect.any(Number),
          end: expect.any(Number),
        },
      })
      const owner = result.paper.nodes.find(
        (node) => node.id === relationship.canonicalAnchor?.nodeId,
      )
      expect(owner && 'text' in owner ? owner.text : '').toContain(
        relationship.text,
      )
      expect(
        result.paper.nodes.find(
          (node) => node.id === relationship.targetNodeIds[0],
        ),
      ).toMatchObject({ type: 'heading' })
    }
    expect(
      result.diagnostics.filter((diagnostic) =>
        diagnostic.code.includes('SCHOLARLY_CROSS_REFERENCE'),
      ),
    ).toEqual([])
  })

  it('retains internal destinations as blocking source-cited obligations', async () => {
    const linked = page(1, [
      run(1, 'See the internal destination.', 0.1, 0.2, 0.7),
    ])
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal',
        destination: 'methods',
        box: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.7,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [linked],
      sourceHash: '3'.repeat(64),
      fileName: 'synthetic-internal-link.pdf',
      byteLength: 2048,
    })

    expect(Object.values(result.provenance)[0].links).toEqual(linked.links)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_HYPERLINK',
          relationshipId: 'pdf-link-p001-a0001',
          sourceBoxes: [linked.links[0].box],
        }),
      ]),
    )
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 1,
      mappedHyperlinkCount: 0,
      hyperlinkCoverage: 0,
    })
    expect(result.readiness.ready).toBe(false)
  })

  it.each([
    ['section.4', 'section', 'Section 4', 'section-four'],
    ['appendix.M', 'appendix', 'Appendix M', 'appendix-m'],
    ['figure.caption.3', 'figure', 'Figure 3', 'figure-three'],
    ['table.caption.7', 'table', 'Table 7', 'table-seven'],
    ['equation.2.1', 'equation', 'Equation 2.1', 'equation-two-one'],
  ] as const)(
    'maps the exact internal destination %s to one unique canonical target',
    (destination, kind, label, targetNodeId) => {
      const { block, box } = canonicalHyperlinkTestBlock()
      const annotation = {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal',
        destination,
        box,
      } as const

      const resolution = resolveCanonicalHyperlinkObligations({
        blocks: [block],
        annotations: [annotation],
        canonicalTargets: [
          {
            kind,
            label,
            nodeId: targetNodeId,
          },
        ],
      })

      expect(resolution.mappings).toEqual([
        {
          annotationId: annotation.id,
          blockNodeId: block.nodeId,
          start: 0,
          end: block.text.length,
          href: `#${targetNodeId}`,
        },
      ])
      expect(resolution.diagnostics).toEqual([])
      expect(resolution.ledger).toEqual({ expected: 1, mapped: 1 })
    },
  )

  it('keeps duplicate canonical labels unresolved instead of selecting a destination', () => {
    const { block, box } = canonicalHyperlinkTestBlock()
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'section.4',
      box,
    } as const
    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
      canonicalTargets: [
        { kind: 'section', label: 'Section 4', nodeId: 'section-four-a' },
        { kind: 'section', label: 'Section 4', nodeId: 'section-four-b' },
      ],
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        relationshipId: annotation.id,
        message: expect.stringMatching(/more than one canonical target/i),
      }),
    ])
  })

  it('keeps unsupported internal destination schemes unresolved', () => {
    const { block, box } = canonicalHyperlinkTestBlock()
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'internal',
      destination: 'section*.4',
      box,
    } as const
    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations: [annotation],
      canonicalTargets: [
        { kind: 'section', label: 'Section 4', nodeId: 'section-four' },
      ],
    })

    expect(resolution.mappings).toEqual([])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 0 })
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNRESOLVED_HYPERLINK',
        relationshipId: annotation.id,
        message: expect.stringMatching(/unsupported internal PDF destination/i),
      }),
    ])
  })

  it('emits a source-proved internal annotation href to an existing EPUB heading id', async () => {
    const linked = page(1, [
      run(1, 'Internal Destination Study', 0.2, 0.06, 0.6, 18),
      run(1, 'Ada Example', 0.4, 0.13, 0.2, 11),
      run(1, 'Abstract', 0.1, 0.2, 0.2, 14),
      run(
        1,
        'This abstract establishes a source-backed internal-link fixture.',
        0.1,
        0.25,
        0.78,
      ),
      run(1, 'Open the methods section.', 0.1, 0.38, 0.42),
      run(1, '4 Methods', 0.1, 0.56, 0.3, 16),
      run(1, 'The methods remain canonical prose.', 0.1, 0.62, 0.7),
    ])
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal',
        destination: 'section.4',
        box: {
          page: 1,
          x: 0.1,
          y: 0.38,
          width: 0.42,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [linked],
      sourceHash: '4'.repeat(64),
      fileName: 'source-proved-internal-link.pdf',
      byteLength: 2048,
    })
    const target = result.paper.nodes.find(
      (node) => node.type === 'heading' && node.text === '4 Methods',
    )
    const owner = result.paper.nodes.find(
      (node) =>
        'text' in node && node.text.includes('Open the methods section.'),
    )

    expect(target).toBeDefined()
    expect(
      owner && 'inlineRuns' in owner
        ? owner.inlineRuns?.filter(
            (run) => run.annotationId === 'pdf-link-p001-a0001',
          )
        : [],
    ).toEqual([
      expect.objectContaining({
        href: `#${target!.id}`,
        annotationId: 'pdf-link-p001-a0001',
      }),
    ])
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

    const epub = await buildEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    expect(content).toContain(`href="#${target!.id}"`)
    expect(content).toContain(`id="${target!.id}"`)
  })

  it('maps an exact numeric citation destination to its unique bibliography entry', async () => {
    const citationText = 'Prior work [1] establishes the baseline.'
    const citationStart = citationText.indexOf('[1]')
    const citationEnd = citationStart + '[1]'.length
    const linked = page(1, [
      run(1, 'Internal Citation Study', 0.1, 0.08, 0.7, 22),
      run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
      run(1, citationText, 0.1, 0.24, 0.72),
    ])
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal',
        destination: 'cite.1',
        box: {
          page: 1,
          x: 0.29,
          y: 0.24,
          width: 0.07,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]
    const result = await reconstructPageAnalyses({
      pages: [
        linked,
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[1] First source-backed reference.', 0.1, 0.82, 0.72, 7),
        ]),
      ],
      sourceHash: '9'.repeat(64),
      fileName: 'source-proved-internal-citation.pdf',
      byteLength: 2048,
    })
    const reference = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' &&
        node.list?.numberingId === 'references' &&
        node.list.ordinal === 1,
    )
    const annotationRun = result.paper.nodes.flatMap((node) =>
      'inlineRuns' in node
        ? (node.inlineRuns ?? []).filter(
            (run) => run.annotationId === 'pdf-link-p001-a0001',
          )
        : [],
    )

    expect(reference).toBeDefined()
    expect(annotationRun).toEqual([
      expect.objectContaining({
        start: citationStart,
        end: citationEnd,
        href: `#${reference!.id}`,
        annotationId: 'pdf-link-p001-a0001',
        semanticRole: 'citation',
        targetIds: [reference!.id],
      }),
    ])
    expect(
      result.paper.nodes.some(
        (node) =>
          'inlineRuns' in node &&
          node.inlineRuns?.some(
            (run) =>
              run.annotationId === 'pdf-link-p001-a0001' &&
              'text' in node &&
              node.text.slice(run.start, run.end) !== '[1]',
          ),
      ),
    ).toBe(false)
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 1,
      mappedHyperlinkCount: 1,
      hyperlinkCoverage: 1,
    })

    const epub = await buildReadableEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    expect(content).toMatch(
      /Prior work <a[^>]+epub:type="biblioref"[^>]*>\[1\]<\/a> establishes the baseline\./u,
    )
    expect(content).not.toMatch(/<a[^>]*>Prior work/u)
  })

  it('coalesces duplicate internal annotation fragments for one canonical range and target', () => {
    const { block } = canonicalHyperlinkTestBlock('[1]')
    const annotations = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal' as const,
        destination: 'cite.1',
        box: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.14,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link' as const,
        },
      },
      {
        id: 'pdf-link-p001-a0002',
        page: 1,
        status: 'internal' as const,
        destination: 'cite.1',
        box: {
          page: 1,
          x: 0.25,
          y: 0.2,
          width: 0.15,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link' as const,
        },
      },
    ]
    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [block],
      annotations,
      canonicalTargets: [
        {
          kind: 'reference',
          label: 'Reference 1',
          nodeId: 'reference-one',
        },
      ],
      canonicalInternalSurfaces: [
        {
          targetNodeId: 'reference-one',
          blockNodeId: block.nodeId,
          start: 0,
          end: 3,
          sourceBoxes: [
            {
              page: 1,
              x: 0.1,
              y: 0.2,
              width: 0.3,
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
        annotationId: annotations[0].id,
        blockNodeId: block.nodeId,
        start: 0,
        end: 3,
        href: '#reference-one',
      },
    ])
    expect(resolution.approvedAnnotationIds).toEqual(
      new Set(annotations.map((annotation) => annotation.id)),
    )
    expect(resolution.ledger).toEqual({ expected: 2, mapped: 2 })
    expect(resolution.diagnostics).toEqual([])
  })

  it('rejects every conflicting internal target claimed by one canonical range independent of input order', () => {
    const { block } = canonicalHyperlinkTestBlock('[1]')
    const annotations = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal' as const,
        destination: 'cite.1',
        box: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.14,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link' as const,
        },
      },
      {
        id: 'pdf-link-p001-a0002',
        page: 1,
        status: 'internal' as const,
        destination: 'cite.2',
        box: {
          page: 1,
          x: 0.25,
          y: 0.2,
          width: 0.15,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link' as const,
        },
      },
    ]
    const resolve = (orderedAnnotations: typeof annotations) =>
      resolveCanonicalHyperlinkObligations({
        blocks: [block],
        annotations: orderedAnnotations,
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
        canonicalInternalSurfaces: [
          {
            targetNodeId: 'reference-one',
            blockNodeId: block.nodeId,
            start: 0,
            end: 3,
            sourceBoxes: [
              {
                page: 1,
                x: 0.1,
                y: 0.2,
                width: 0.14,
                height: 0.018,
                rotation: 0,
                method: 'pdf-text',
              },
            ],
          },
          {
            targetNodeId: 'reference-two',
            blockNodeId: block.nodeId,
            start: 0,
            end: 3,
            sourceBoxes: [
              {
                page: 1,
                x: 0.25,
                y: 0.2,
                width: 0.15,
                height: 0.018,
                rotation: 0,
                method: 'pdf-text',
              },
            ],
          },
        ],
      })

    const forward = resolve(annotations)
    const reversed = resolve([...annotations].reverse())

    for (const resolution of [forward, reversed]) {
      expect(resolution.mappings).toEqual([])
      expect(resolution.approvedAnnotationIds).toEqual(new Set())
      expect(resolution.ledger).toEqual({ expected: 2, mapped: 0 })
      expect(resolution.diagnostics).toEqual([
        expect.objectContaining({
          code: 'UNRESOLVED_HYPERLINK',
          relationshipId: annotations[0].id,
          message: expect.stringMatching(
            /canonical inline owner.*conflicting internal targets/iu,
          ),
        }),
        expect.objectContaining({
          code: 'UNRESOLVED_HYPERLINK',
          relationshipId: annotations[1].id,
          message: expect.stringMatching(
            /canonical inline owner.*conflicting internal targets/iu,
          ),
        }),
      ])
    }
    expect(reversed.mappings).toEqual(forward.mappings)
    expect(reversed.diagnostics).toEqual(forward.diagnostics)
  })
})

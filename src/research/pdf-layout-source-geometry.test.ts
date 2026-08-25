import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildReadableEpub, inspectEpub } from './epub'
import type {
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
} from './import-types'
import {
  canonicalHyperlinkOccurrencesForTable,
  canonicalTableWithApprovedHyperlinks,
  reconstructPageAnalyses,
  resolveCanonicalHyperlinkObligations,
} from './pdf-layout'
import { canonicalTableFromLines } from './visual-assets'

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
  it('removes repeated margins and retains normalized source-box provenance', async () => {
    const pages = [
      page(1, [
        run(1, 'Journal 2026', 0.1, 0.02, 0.2, 8),
        run(1, 'A Semantic Paper', 0.1, 0.15, 0.7, 22),
        run(1, 'This is the first reconstructed paragraph.', 0.1, 0.24, 0.72),
      ]),
      page(2, [
        run(2, 'Journal 2026', 0.1, 0.02, 0.2, 8),
        run(2, 'Methods', 0.1, 0.16, 0.25, 17),
        run(2, 'The second page remains in reading order.', 0.1, 0.24, 0.7),
      ]),
    ]
    const result = await reconstructPageAnalyses({
      pages,
      sourceHash: 'a'.repeat(64),
      fileName: 'paper.pdf',
      byteLength: 2048,
      metadata: { author: 'Ada Example', modified: '2026-07-13' },
    })

    expect(result.paper.title).toBe('A Semantic Paper')
    expect(result.paper.authors).toEqual(['Ada Example'])
    expect(
      result.paper.nodes.map((node) => 'text' in node && node.text),
    ).not.toContain('Journal 2026')
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'REPEATED_MARGIN_TEXT' }),
      ]),
    )
    const first = result.paper.nodes[0]
    expect(result.provenance[first.id]).toMatchObject({
      confidence: 0.9,
      pages: [1],
    })
    expect(result.provenance[first.id].boxes[0]).toMatchObject({
      page: 1,
      method: 'pdf-text',
      x: 0.1,
      y: 0.15,
    })
  })

  it('retains embedded links alongside reconstructed node provenance', async () => {
    const linked = page(1, [
      run(1, 'Linked embedded text remains source evidence.', 0.1, 0.2, 0.7),
    ])
    linked.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'external',
        url: 'https://example.test/evidence',
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
      sourceHash: 'e'.repeat(64),
      fileName: 'linked.pdf',
      byteLength: 2048,
    })

    expect(Object.values(result.provenance)[0].links).toEqual(linked.links)
    const linkedNode = result.paper.nodes.find(
      (node) => 'text' in node && node.text.includes('Linked embedded text'),
    )
    expect(
      linkedNode && 'inlineRuns' in linkedNode
        ? linkedNode.inlineRuns
        : undefined,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          href: 'https://example.test/evidence',
          annotationId: 'pdf-link-p001-a0001',
        }),
      ]),
    )
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 1,
      mappedHyperlinkCount: 1,
      hyperlinkCoverage: 1,
    })
  })

  it('maps styles and internal links from exact line ranges after a cross-run accent repair', async () => {
    const source = withExplicitEnglishLanguage(
      page(1, [
        run(1, 'Uncomputable Lineage', 0.1, 0.05, 0.34, 18),
        {
          ...run(1, 'Earlier Vit´', 0.1, 0.2, 0.08),
          height: 0.0125,
        },
        {
          ...run(
            1,
            'anyi text (see §2 for a detailed background). Complexity is',
            0.18,
            0.2,
            0.48,
          ),
          height: 0.0125,
        },
        {
          ...run(1, 'un-', 0.665, 0.2, 0.03),
          height: 0.0125,
          fontName: 'Body-Italic',
          italic: true,
        },
        {
          ...run(1, 'computable', 0.1, 0.214, 0.08),
          height: 0.0125,
          fontName: 'Body-Italic',
          italic: true,
        },
        {
          ...run(
            1,
            'as it reduces to a finite source-backed proof.',
            0.185,
            0.214,
            0.5,
          ),
          height: 0.0125,
        },
      ]),
    )
    source.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'internal',
        destination: 'section.2',
        destinationEvidence: {
          source: 'pdfjs-named-destination',
          destination: 'section.2',
          view: 'XYZ',
          page: 2,
          point: {
            page: 2,
            x: 0.1,
            y: 0.2,
            rotation: 0,
            method: 'pdf-destination',
          },
          box: null,
        },
        box: {
          page: 1,
          x: 0.34,
          y: 0.2,
          width: 0.02,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [source, page(2, [run(2, '2 BACKGROUND', 0.1, 0.2, 0.34, 16)])],
      sourceHash: 'a'.repeat(64),
      fileName: 'line-range-inline-lineage.pdf',
      byteLength: 2048,
      metadata: { author: 'Ada Example' },
    })
    const paragraph = result.paper.nodes.find(
      (node) => 'text' in node && node.text.includes('Earlier Vitányi'),
    )

    expect(paragraph).toBeDefined()
    if (!paragraph || !('text' in paragraph) || !('inlineRuns' in paragraph)) {
      throw new Error('missing reconstructed inline paragraph')
    }
    const italicRuns = (paragraph.inlineRuns ?? []).filter(
      (candidate) => candidate.italic,
    )
    const italicText = italicRuns
      .map((candidate) => paragraph.text.slice(candidate.start, candidate.end))
      .join('')
    const italicCharacterIndexes = italicRuns.flatMap((candidate) =>
      Array.from(
        { length: candidate.end - candidate.start },
        (_value, index) => candidate.start + index,
      ),
    )
    const uncomputableStart = paragraph.text.indexOf('un-computable')
    const sectionLink = (paragraph.inlineRuns ?? []).find(
      (candidate) => candidate.annotationId === 'pdf-link-p001-a0001',
    )

    expect(italicText).toBe('un-computable')
    expect(italicCharacterIndexes).toEqual(
      Array.from(
        { length: 'un-computable'.length },
        (_value, index) => uncomputableStart + index,
      ),
    )
    expect(result.lineBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: 'unresolved',
          evidence: expect.arrayContaining([
            'source-proven-wrapped-line-boundary',
            'same-document-unhyphenated-word',
          ]),
        }),
      ]),
    )
    expect(sectionLink).toMatchObject({
      href: expect.stringMatching(/^#sec-/u),
      annotationId: 'pdf-link-p001-a0001',
    })
    expect(
      sectionLink
        ? paragraph.text.slice(sectionLink.start, sectionLink.end)
        : null,
    ).toBe('§2')

    const epub = await buildReadableEpub(result.paper, result)
    const content = strFromU8(
      inspectEpub(epub.bytes).files['EPUB/content.xhtml'],
    )
    expect(content).toContain(
      `<a href="${sectionLink!.href}" data-source-annotation-id="pdf-link-p001-a0001">§2</a>`,
    )
    expect(content).toContain('<em>un-computable</em>')
  })

  it('keeps positioned-accent provenance and exact inline mapping through EPUB reconstruction', async () => {
    const prefix = {
      ...run(1, 'A source cites Kram', 0.1, 0.2, 0.23281),
      height: 0.012579,
      fontSize: 9.9626,
      fontName: 'Body',
    }
    const accent = {
      ...run(1, '´', 0.33371, 0.1999369, 0.00542),
      height: 0.012579,
      fontSize: 9.9626,
      fontName: 'Body-Italic',
      italic: true,
    }
    const linkedPeer = {
      ...run(1, 'ar method', 0.33281, 0.2, 0.068),
      height: 0.012579,
      fontSize: 9.9626,
      fontName: 'Body-Italic',
      italic: true,
    }
    const suffix = {
      ...run(1, 'and continues.', 0.405, 0.2, 0.11),
      height: 0.012579,
      fontSize: 9.9626,
      fontName: 'Body',
    }
    const source = page(1, [prefix, accent, linkedPeer, suffix])
    source.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'external',
        url: 'https://example.test/accented-source',
        box: {
          page: 1,
          x: linkedPeer.x,
          y: linkedPeer.y,
          width: linkedPeer.width,
          height: linkedPeer.height,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [source],
      sourceHash: 'c'.repeat(64),
      fileName: 'positioned-accent-lineage.pdf',
      byteLength: 2048,
      metadata: { author: 'Ada Example' },
    })
    const paragraph = result.paper.nodes.find(
      (node) => 'text' in node && node.text.includes('Kramár method'),
    )

    expect(paragraph).toBeDefined()
    if (!paragraph || !('text' in paragraph) || !('inlineRuns' in paragraph)) {
      throw new Error('missing positioned-accent paragraph')
    }
    const linked = (paragraph.inlineRuns ?? []).find(
      (candidate) => candidate.annotationId === 'pdf-link-p001-a0001',
    )
    expect(linked).toMatchObject({
      href: 'https://example.test/accented-source',
      annotationId: 'pdf-link-p001-a0001',
      italic: true,
    })
    expect(linked ? paragraph.text.slice(linked.start, linked.end) : null).toBe(
      'ár method',
    )

    const paragraphEvidence = result.provenance[paragraph.id]
    expect(paragraphEvidence.boxes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          page: 1,
          x: accent.x,
          y: 0.19994,
          width: accent.width,
          height: 0.01258,
        }),
      ]),
    )

    const epub = await buildReadableEpub(result.paper, result)
    const content = strFromU8(
      inspectEpub(epub.bytes).files['EPUB/content.xhtml'],
    )
    expect(content).toContain(
      '<a href="https://example.test/accented-source"><em>ár method</em></a>',
    )
  })

  it('counts one source-verified semantic-table link annotation exactly once', () => {
    const sourceBox = (x: number, y: number, width = 0.08, height = 0.018) =>
      ({
        page: 1,
        x,
        y,
        width,
        height,
        rotation: 0,
        method: 'pdf-text',
      }) as const
    const headerRuns = [
      {
        ...run(1, 'Method', 0.1, 0.2, 0.08),
        bold: true,
        fontName: 'Table-Bold',
      },
      {
        ...run(1, 'Score', 0.5, 0.2, 0.08),
        bold: true,
        fontName: 'Table-Bold',
      },
    ]
    const bodyRuns = [
      {
        ...run(1, 'Ours', 0.1, 0.25, 0.08),
        italic: true,
        fontName: 'Table-Italic',
      },
      run(1, '91.0', 0.5, 0.25, 0.08),
    ]
    const lines: PdfPageRegion['lines'] = [
      {
        id: 'table-header',
        text: 'Method Score',
        fontSize: 10,
        box: sourceBox(0.1, 0.2, 0.48),
        runs: headerRuns,
      },
      {
        id: 'table-body',
        text: 'Ours 91.0',
        fontSize: 10,
        box: sourceBox(0.1, 0.25, 0.48),
        runs: bodyRuns,
      },
    ]
    const region = {
      id: 'table-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: 'Method Score Ours 91.0',
      confidence: 1,
      box: sourceBox(0.1, 0.2, 0.48, 0.068),
      lines,
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion
    const annotation = {
      id: 'pdf-link-p001-a0001',
      page: 1,
      status: 'external',
      url: 'https://example.test/table-method',
      box: { ...sourceBox(0.1, 0.25), method: 'pdf-link' as const },
    } as const
    const table = canonicalTableFromLines(lines, {
      sourceRegions: [region],
      links: [annotation],
    })

    expect(table).not.toBeNull()
    const occurrences = canonicalHyperlinkOccurrencesForTable(table!)
    const resolution = resolveCanonicalHyperlinkObligations({
      blocks: [],
      annotations: [annotation],
      canonicalOccurrences: occurrences,
    })
    const approved = canonicalTableWithApprovedHyperlinks(
      table!,
      resolution.approvedAnnotationIds,
    )
    const linkedCell = approved.rows
      .flatMap((row) => row.cells)
      .find((cell) => cell.text === 'Ours')

    expect(occurrences).toEqual([
      {
        annotationId: annotation.id,
        url: annotation.url,
      },
    ])
    expect(resolution.ledger).toEqual({ expected: 1, mapped: 1 })
    expect(resolution.diagnostics).toEqual([])
    expect(linkedCell?.inlineRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          href: annotation.url,
          annotationId: annotation.id,
        }),
      ]),
    )
  })

  it('does not project a link annotation onto matching geometry on another page', async () => {
    const first = page(1, [
      run(1, 'Linked text on the annotated page.', 0.1, 0.2, 0.7),
    ])
    first.links = [
      {
        id: 'pdf-link-p001-a0001',
        page: 1,
        status: 'external',
        url: 'https://example.test/page-one',
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
    const second = page(2, [
      run(2, 'Plain text at matching coordinates.', 0.1, 0.2, 0.7),
    ])

    const result = await reconstructPageAnalyses({
      pages: [first, second],
      sourceHash: 'd'.repeat(64),
      fileName: 'page-scoped-link.pdf',
      byteLength: 2048,
    })
    const linked = result.paper.nodes.find(
      (node) => 'text' in node && node.text.includes('Linked text'),
    )
    const plain = result.paper.nodes.find(
      (node) => 'text' in node && node.text.includes('Plain text'),
    )

    expect(
      linked && 'inlineRuns' in linked
        ? linked.inlineRuns?.some(
            (inline) => inline.href === 'https://example.test/page-one',
          )
        : false,
    ).toBe(true)
    expect(
      plain && 'inlineRuns' in plain
        ? plain.inlineRuns?.some((inline) => inline.href)
        : false,
    ).toBe(false)
  })

  it('orders detected columns left before right without storing target geometry', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Left one.', 0.08, 0.2, 0.32),
          run(1, 'Left two.', 0.08, 0.24, 0.32),
          run(1, 'Left three.', 0.08, 0.28, 0.32),
          run(1, 'Right one.', 0.55, 0.2, 0.32),
          run(1, 'Right two.', 0.55, 0.24, 0.32),
          run(1, 'Right three.', 0.55, 0.28, 0.32),
        ]),
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'columns.pdf',
      byteLength: 4096,
    })
    const text = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .join(' ')
    expect(text.indexOf('Left one')).toBeLessThan(text.indexOf('Right one'))
    expect(result.paper).not.toHaveProperty('geometry')
    expect(result.paper).not.toHaveProperty('pages')
  })

  it('preserves narrow-gutter columns instead of interleaving their rows', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Left one.', 0.08, 0.2, 0.43),
          run(1, 'Right one.', 0.53, 0.2, 0.39),
          run(1, 'Left two.', 0.08, 0.24, 0.43),
          run(1, 'Right two.', 0.53, 0.24, 0.39),
          run(1, 'Left three.', 0.08, 0.28, 0.43),
          run(1, 'Right three.', 0.53, 0.28, 0.39),
        ]),
      ],
      sourceHash: '1'.repeat(64),
      fileName: 'narrow-gutter-columns.pdf',
      byteLength: 2048,
    })

    const text = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .join(' ')
    expect(text.indexOf('Left three')).toBeLessThan(text.indexOf('Right one'))
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNPROVENANCED_RENDERED_UNIT',
      ]),
    })
  })

  it('keeps complete section and list subtrees in column flow when a compact grid has a denser internal gap', async () => {
    const section = (text: string, x: number, y: number, width: number) => ({
      ...run(2, text, x, y, width),
      fontName: 'NimbusRomNo9L-Medi',
      bold: true,
    })
    const compactGrid = Array.from({ length: 6 }, (_, index) => {
      const y = 0.08 + index * 0.024
      return [
        run(2, `Metric ${index + 1}`, 0.08, y, 0.32, 8),
        run(2, `Score ${String.fromCharCode(65 + index)}`, 0.44, y, 0.04),
      ]
    }).flat()
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Column subtree ordering', 0.1, 0.08, 0.72, 20),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(
            1,
            'Opening context remains single-column prose.',
            0.1,
            0.3,
            0.72,
          ),
        ]),
        page(2, [
          ...compactGrid,
          run(2, 'Left gutter evidence one.', 0.08, 0.25, 0.4),
          run(2, 'Right gutter evidence one.', 0.54, 0.25, 0.36),
          run(2, 'Left gutter evidence two.', 0.08, 0.28, 0.4),
          run(2, 'Right gutter evidence two.', 0.54, 0.28, 0.36),
          run(2, 'Left gutter evidence three.', 0.08, 0.31, 0.4),
          run(2, 'Right gutter evidence three.', 0.54, 0.31, 0.36),
          section('4.5. Left-column study', 0.08, 0.39, 0.29),
          section('5. Right-column method', 0.54, 0.34, 0.31),
          section('5.1. Right-column details', 0.54, 0.365, 0.29),
          run(
            2,
            'Left introduction explains the complete study.',
            0.08,
            0.43,
            0.4,
          ),
          run(
            2,
            'Right introduction explains the complete method.',
            0.54,
            0.455,
            0.36,
          ),
          run(2, '1. Left method one.', 0.1, 0.48, 0.36),
          run(2, '1. Right clock one.', 0.56, 0.505, 0.32),
          run(2, '2. Left method two.', 0.1, 0.53, 0.36),
          run(2, '2. Right clock two.', 0.56, 0.555, 0.32),
          run(2, '3. Left method three.', 0.1, 0.58, 0.36),
          run(
            2,
            'Left conclusion completes the study subtree.',
            0.08,
            0.64,
            0.4,
          ),
          run(
            2,
            'Right conclusion completes the method subtree.',
            0.54,
            0.61,
            0.36,
          ),
        ]),
      ],
      sourceHash: '6'.repeat(64),
      fileName: 'compact-grid-column-subtrees.pdf',
      byteLength: 4096,
    })

    const subtreeText = result.paper.nodes.flatMap((node) =>
      'text' in node &&
      /^(?:4\.5\.|5\.|Left introduction|Left method|Left conclusion|Right introduction|Right clock|Right conclusion)/u.test(
        node.text,
      )
        ? [node.text]
        : [],
    )
    expect(subtreeText).toEqual([
      '4.5. Left-column study',
      'Left introduction explains the complete study.',
      'Left method one.',
      'Left method two.',
      'Left method three.',
      'Left conclusion completes the study subtree.',
      '5. Right-column method',
      '5.1. Right-column details',
      'Right introduction explains the complete method.',
      'Right clock one.',
      'Right clock two.',
      'Right conclusion completes the method subtree.',
    ])
    expect(
      result.readingOrder.resolutions.find(
        (resolution) =>
          resolution.page === 2 && resolution.status === 'resolved',
      ),
    ).toMatchObject({
      evidence: expect.arrayContaining([
        expect.objectContaining({
          code: 'column-gutter',
          detail: expect.stringMatching(/0 candidate lines cross/iu),
        }),
      ]),
    })
    expect(
      result.regions.filter(
        (region) =>
          region.page === 2 &&
          /^(?:Left introduction|Left method|Left conclusion)/u.test(
            region.text,
          ) &&
          region.column === 'span',
      ),
    ).toHaveLength(0)
    expect(result.completeness.readingOrderDiagnostics).toBe(0)
  })

  it('retains a true page-spanning source line as a column-flow boundary', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Left above one.', 0.08, 0.2, 0.36),
          run(1, 'Right above one.', 0.56, 0.2, 0.36),
          run(1, 'Left above two.', 0.08, 0.24, 0.36),
          run(1, 'Right above two.', 0.56, 0.24, 0.36),
          run(1, 'Left above three.', 0.08, 0.28, 0.36),
          run(1, 'Right above three.', 0.56, 0.28, 0.36),
          run(
            1,
            'A page-spanning transition remains a boundary.',
            0.1,
            0.42,
            0.8,
          ),
          run(1, 'Left below one.', 0.08, 0.52, 0.36),
          run(1, 'Right below one.', 0.56, 0.52, 0.36),
          run(1, 'Left below two.', 0.08, 0.56, 0.36),
          run(1, 'Right below two.', 0.56, 0.56, 0.36),
        ]),
      ],
      sourceHash: '7'.repeat(64),
      fileName: 'true-spanning-column-boundary.pdf',
      byteLength: 2048,
    })

    const text = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .join(' ')
    const spanning = result.regions.find((region) =>
      region.text.includes('page-spanning transition'),
    )
    expect(spanning).toMatchObject({ kind: 'spanning', column: 'span' })
    expect(text.indexOf('Right above three')).toBeLessThan(
      text.indexOf('page-spanning transition'),
    )
    expect(text.indexOf('page-spanning transition')).toBeLessThan(
      text.indexOf('Left below one'),
    )
  })

  it('fails closed when a short two-column page cannot be ordered safely', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Left one.', 0.08, 0.2, 0.32),
          run(1, 'Right one.', 0.55, 0.2, 0.32),
          run(1, 'Indented left two.', 0.18, 0.7, 0.22),
          run(1, 'Right two.', 0.55, 0.7, 0.32),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'short-columns.pdf',
      byteLength: 2048,
    })

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AMBIGUOUS_READING_ORDER',
          severity: 'error',
        }),
      ]),
    )
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'SOURCE_ORDER_FLOAT_FALLBACK',
      ),
    ).toEqual([])
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
  })
})

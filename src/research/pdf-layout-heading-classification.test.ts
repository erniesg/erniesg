import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildReadableEpub, inspectEpub } from './epub'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'

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

describe('PDF semantic reconstruction', () => {
  it('does not turn a parenthesized citation year into a numbered list', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Zhou et al.', 0.1, 0.3, 0.7),
          run(
            1,
            '(2024) analyze a fine-tuned model and report results.',
            0.1,
            0.34,
            0.7,
          ),
        ]),
      ],
      sourceHash: 'f'.repeat(64),
      fileName: 'citation-year.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.filter(
        (node) => node.type === 'paragraph' && node.list,
      ),
    ).toEqual([])
    expect(
      result.paper.nodes
        .filter((node) => node.type === 'paragraph')
        .map((node) => node.text)
        .join(' '),
    ).toContain('(2024) analyze a fine-tuned model')
  })

  it('retains a typographic section heading phrased as a question', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Introductory prose line one', 0.1, 0.24, 0.7),
          run(1, 'continues on line two', 0.1, 0.27, 0.7),
          run(1, 'and continues on line three', 0.1, 0.3, 0.7),
          run(1, 'before ending on line four.', 0.1, 0.33, 0.7),
          run(1, 'E. Why Use This Algorithm at All?', 0.1, 0.4, 0.5, 16),
          run(1, 'The appendix answer remains prose.', 0.1, 0.48, 0.7),
        ]),
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'question-heading.pdf',
      byteLength: 4096,
    })

    expect(result.paper.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'heading',
          text: 'E. Why Use This Algorithm at All?',
        }),
      ]),
    )
  })

  it('preserves medium-face lettered appendix hierarchy without a terminal dot', async () => {
    const appendixHeading = {
      ...run(2, 'A Datasets Details', 0.1, 0.1, 0.35, 11),
      fontName: 'NimbusRomNo9L-Medi',
    }
    const appendixSubheading = {
      ...run(2, 'B.1 Prompt Details', 0.1, 0.46, 0.32, 11),
      fontName: 'NimbusRomNo9L-Medi',
    }
    const secondAppendixHeading = {
      ...run(2, 'B Prompt Details', 0.1, 0.32, 0.32, 11),
      fontName: 'NimbusRomNo9L-Medi',
    }
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.72, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(
            1,
            'Introductory body establishes the prose size.',
            0.1,
            0.3,
            0.7,
          ),
        ]),
        page(2, [
          appendixHeading,
          run(2, 'Appendix body remains ordinary prose.', 0.1, 0.18, 0.7),
          secondAppendixHeading,
          appendixSubheading,
          run(2, 'Nested appendix prose remains ordinary.', 0.1, 0.56, 0.7),
        ]),
      ],
      sourceHash: 'j'.repeat(64),
      fileName: 'lettered-appendix.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' &&
        [
          'A Datasets Details',
          'B Prompt Details',
          'B.1 Prompt Details',
        ].includes(node.text)
          ? [{ text: node.text, level: node.level }]
          : [],
      ),
    ).toEqual([
      { text: 'A Datasets Details', level: 1 },
      { text: 'B Prompt Details', level: 1 },
      { text: 'B.1 Prompt Details', level: 2 },
    ])
  })

  it('keeps sequenced split appendix headings out of digit-normalized running furniture', async () => {
    const medium = (
      pageNumber: number,
      text: string,
      x: number,
      y: number,
      width: number,
      fontSize = 11,
    ) => ({
      ...run(pageNumber, text, x, y, width, fontSize),
      fontName: 'SyntheticSerif-Medi',
    })
    const runningHeader = (pageNumber: number) =>
      run(pageNumber, 'Proceedings of Synthetic Studies', 0.12, 0.02, 0.42, 8)
    const childPage = (pageNumber: number, ordinal: number) =>
      page(pageNumber, [
        runningHeader(pageNumber),
        medium(pageNumber, `Q.${ordinal}`, 0.12, 0.084, 0.025),
        medium(pageNumber, `Cases for Scenario ${ordinal}`, 0.16, 0.084, 0.185),
        run(
          pageNumber,
          `Canonical appendix prose for scenario ${ordinal}.`,
          0.12,
          0.15,
          0.72,
          9,
        ),
      ])
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Synthetic hierarchy study', 0.16, 0.07, 0.68, 20),
          run(1, 'Abstract', 0.12, 0.18, 0.24, 14),
          run(
            1,
            'The abstract establishes source-backed publication structure.',
            0.12,
            0.24,
            0.72,
            9,
          ),
          medium(1, '1 Introduction', 0.12, 0.34, 0.28, 12),
          run(
            1,
            'See Appendix Q.2 for the selected scenario.',
            0.12,
            0.4,
            0.72,
            9,
          ),
        ]),
        page(2, [
          runningHeader(2),
          medium(2, 'Q Example Collections', 0.12, 0.18, 0.34, 12),
          run(
            2,
            'The appendix parent introduces the sequenced examples.',
            0.12,
            0.24,
            0.72,
            9,
          ),
        ]),
        childPage(3, 1),
        childPage(4, 2),
        childPage(5, 3),
      ],
      sourceHash: 'a'.repeat(64),
      fileName: 'split-repeated-appendix-headings.pdf',
      byteLength: 4096,
    })

    const appendixParent = result.paper.nodes.find(
      (node) =>
        node.type === 'heading' && node.text === 'Q Example Collections',
    )
    const appendixChildren = result.paper.nodes.flatMap((node) =>
      node.type === 'heading' && /^Q\.\d+\s/u.test(node.text) ? [node] : [],
    )
    expect(appendixParent).toMatchObject({ type: 'heading', level: 1 })
    expect(
      appendixChildren.map((node) => ({
        text: node.text,
        level: node.level,
        sourceBoxCount: result.provenance[node.id].boxes.length,
        sourceRuns: result.regions
          .filter((region) =>
            result.provenance[node.id].regionIds.includes(region.id),
          )
          .flatMap((region) =>
            region.lines.flatMap((line) => line.runs.map((run) => run.text)),
          ),
      })),
    ).toEqual([
      {
        text: 'Q.1 Cases for Scenario 1',
        level: 2,
        sourceBoxCount: 2,
        sourceRuns: ['Q.1', 'Cases for Scenario 1'],
      },
      {
        text: 'Q.2 Cases for Scenario 2',
        level: 2,
        sourceBoxCount: 2,
        sourceRuns: ['Q.2', 'Cases for Scenario 2'],
      },
      {
        text: 'Q.3 Cases for Scenario 3',
        level: 2,
        sourceBoxCount: 2,
        sourceRuns: ['Q.3', 'Cases for Scenario 3'],
      },
    ])
    expect(
      result.paper.nodes.filter(
        (node) =>
          'text' in node &&
          (/^Q\.\d+$/u.test(node.text) ||
            /^Cases for Scenario \d+$/u.test(node.text)),
      ),
    ).toEqual([])
    expect(
      result.regions
        .filter((region) => region.text === 'Proceedings of Synthetic Studies')
        .every(
          (region) =>
            region.kind === 'header' && region.includedInReadingOrder === false,
        ),
    ).toBe(true)
    expect(
      result.paper.nodes.some(
        (node) =>
          'text' in node &&
          node.text.includes('Proceedings of Synthetic Studies'),
      ),
    ).toBe(false)
    expect(
      result.crossReferenceRelationships.find(
        (relationship) => relationship.text === 'Appendix Q.2',
      ),
    ).toMatchObject({
      status: 'matched',
      targetNodeIds: [appendixChildren[1]?.id],
    })

    const epub = await buildReadableEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    const navigation = strFromU8(files['EPUB/nav.xhtml'])
    expect(navigation).toMatch(
      /Q Example Collections<\/a><ol><li><a[^>]+>Q\.1 Cases for Scenario 1<\/a><\/li><li><a[^>]+>Q\.2 Cases for Scenario 2<\/a><\/li><li><a[^>]+>Q\.3 Cases for Scenario 3<\/a><\/li><\/ol><\/li>/u,
    )
  })

  it('recognizes a styled plain-letter appendix parent from its direct child', async () => {
    const medium = (text: string, y: number, width = 0.36) => ({
      ...run(2, text, 0.1, y, width, 10),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Direct appendix hierarchy', 0.1, 0.08, 0.72, 20),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(
            1,
            'Opening context establishes typography; see Appendix A for discussion.',
            0.1,
            0.3,
            0.72,
          ),
        ]),
        page(2, [
          medium('A Discussion', 0.1),
          run(2, 'Appendix overview remains ordinary prose.', 0.1, 0.16, 0.7),
          medium('A.1 Limitation', 0.24),
          run(2, 'The limitation remains ordinary prose.', 0.1, 0.3, 0.7),
        ]),
      ],
      sourceHash: 'q'.repeat(64),
      fileName: 'direct-lettered-parent.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && /^A(?:\s|\.)/u.test(node.text)
          ? [{ text: node.text, level: node.level }]
          : [],
      ),
    ).toEqual([
      { text: 'A Discussion', level: 1 },
      { text: 'A.1 Limitation', level: 2 },
    ])
    expect(result.crossReferenceRelationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'Appendix A',
          status: 'matched',
          targetNodeIds: [expect.any(String)],
        }),
      ]),
    )
  })

  it('does not promote appendix-contents entries into the canonical heading hierarchy', async () => {
    const contentsHeading = (pageNumber: number, text: string, y: number) => ({
      ...run(pageNumber, text, 0.1, y, 0.58, 10),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const appendixContentsPage = page(2, [
      run(2, 'Appendix', 0.1, 0.1, 0.35, 12),
      contentsHeading(2, 'A Direction extraction pipeline', 0.18),
      run(2, '23', 0.82, 0.18, 0.025),
      run(2, 'A.1 Prompts . . . . . . . . . . . . . . . . 23', 0.14, 0.22, 0.7),
      contentsHeading(2, 'B LLM-based trait expression score', 0.28),
      run(2, '28', 0.82, 0.28, 0.025),
      run(
        2,
        'B.1 Evaluation scoring details . . . . . . . . . . 28',
        0.14,
        0.32,
        0.7,
      ),
    ])
    appendixContentsPage.links = [
      {
        id: 'pdf-link-p002-a0001',
        page: 2,
        status: 'internal',
        destination: 'appendix.A',
        box: {
          page: 2,
          x: 0.1,
          y: 0.18,
          width: 0.58,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.72, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(
            1,
            'Introductory body establishes the prose size.',
            0.1,
            0.3,
            0.7,
          ),
        ]),
        appendixContentsPage,
        page(3, [
          run(
            3,
            'J.2 Comparison with prompting . . . . . . . . . . 45',
            0.14,
            0.1,
            0.7,
          ),
          contentsHeading(3, 'K Sample-wise filtering', 0.18),
          run(3, '53', 0.82, 0.18, 0.025),
          contentsHeading(
            3,
            'M Decomposing persona vectors using sparse autoencoders',
            0.28,
          ),
          run(3, '59', 0.82, 0.28, 0.025),
          run(
            3,
            'M.1 SAE training details . . . . . . . . . . . . 59',
            0.14,
            0.32,
            0.7,
          ),
        ]),
        page(4, [
          run(4, 'A Direction extraction pipeline', 0.1, 0.12, 0.58, 14),
          run(
            4,
            'The actual appendix section remains canonical prose.',
            0.1,
            0.18,
            0.7,
          ),
          run(4, 'A.1 Prompts', 0.1, 0.28, 0.3, 12),
          run(
            4,
            'The actual appendix subsection also remains canonical prose.',
            0.1,
            0.34,
            0.7,
          ),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'appendix-contents.pdf',
      byteLength: 4096,
    })

    const contentsEntries = new Set([
      'A Direction extraction pipeline',
      'B LLM-based trait expression score',
      'K Sample-wise filtering',
      'M Decomposing persona vectors using sparse autoencoders',
    ])
    const contentsEntryNodes = result.paper.nodes.filter(
      (node) =>
        'text' in node &&
        contentsEntries.has(node.text) &&
        result.provenance[node.id].pages.some((pageNumber) =>
          [2, 3].includes(pageNumber),
        ),
    )
    expect(
      contentsEntryNodes.flatMap((node) =>
        node.type === 'heading' ? [node.text] : [],
      ),
    ).toEqual([])
    expect(contentsEntryNodes).toHaveLength(contentsEntries.size)

    const actualAppendixHeading = result.paper.nodes.find(
      (node) =>
        node.type === 'heading' &&
        node.text === 'A Direction extraction pipeline' &&
        result.provenance[node.id].pages.includes(4),
    )
    const linkedContentsEntry = contentsEntryNodes.find(
      (node) =>
        'text' in node && node.text === 'A Direction extraction pipeline',
    )
    expect(actualAppendixHeading).toBeDefined()
    expect(
      linkedContentsEntry && 'inlineRuns' in linkedContentsEntry
        ? linkedContentsEntry.inlineRuns?.filter(
            (inlineRun) => inlineRun.annotationId === 'pdf-link-p002-a0001',
          )
        : [],
    ).toEqual([
      expect.objectContaining({ href: `#${actualAppendixHeading!.id}` }),
    ])
    expect(result.completeness).toMatchObject({
      expectedHyperlinkCount: 1,
      mappedHyperlinkCount: 1,
      hyperlinkCoverage: 1,
    })

    const epub = await buildReadableEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    const navigation = strFromU8(files['EPUB/nav.xhtml'])
    expect(navigation.match(/A Direction extraction pipeline/gu)).toHaveLength(
      1,
    )
  })

  it('does not treat a plain Appendix title as a contents page without contents geometry', async () => {
    const sourceHeading = (text: string, y: number, width: number) => ({
      ...run(2, text, 0.1, y, width, 12),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.72, 22),
          run(1, 'Ada Example', 0.36, 0.14, 0.28, 11),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(
            1,
            'Introductory body establishes the prose size.',
            0.1,
            0.3,
            0.7,
          ),
        ]),
        page(2, [
          run(2, 'Appendix', 0.1, 0.08, 0.3, 16),
          sourceHeading('A Actual appendix section', 0.16, 0.5),
          run(
            2,
            'This is prose, not a trailing contents-page number.',
            0.1,
            0.22,
            0.7,
          ),
          sourceHeading('A.1 Actual subsection', 0.3, 0.42),
          run(
            2,
            'The subsection prose remains in canonical reading order.',
            0.1,
            0.36,
            0.7,
          ),
        ]),
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'plain-appendix-title.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && /^A(?:\s|\.)/u.test(node.text)
          ? [{ text: node.text, level: node.level }]
          : [],
      ),
    ).toEqual([
      { text: 'A Actual appendix section', level: 1 },
      { text: 'A.1 Actual subsection', level: 2 },
    ])
  })

  it('recovers source-styled small-cap appendix subsections and splits them from prose', async () => {
    const smallCapsHeading = (
      pageNumber: number,
      ordinal: string,
      initial: string,
      smallCapsTail: string,
      y: number,
    ) => [
      run(pageNumber, ordinal, 0.1, y, 0.045, 10),
      run(pageNumber, initial, 0.16, y, 0.012, 10),
      run(pageNumber, smallCapsTail, 0.172, y + 0.0025, 0.42, 8),
    ]
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.72, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(
            1,
            'Introductory body establishes the prose size.',
            0.1,
            0.3,
            0.7,
          ),
        ]),
        page(2, [
          ...smallCapsHeading(2, 'A.1', 'P', 'ROMPTS', 0.12),
          run(2, 'The prompt details remain ordinary prose.', 0.1, 0.145, 0.7),
          ...smallCapsHeading(2, 'B.1', 'E', 'VALUATION SCORING DETAILS', 0.24),
          run(2, 'The scoring details remain ordinary prose.', 0.1, 0.265, 0.7),
        ]),
        page(3, [
          ...smallCapsHeading(3, 'J.7', 'C', 'ASE STUDY', 0.12),
          ...smallCapsHeading(3, 'J.7.1', 'P', 'REVENTATIVE STEERING', 0.145),
          run(
            3,
            'The case-study explanation remains ordinary prose.',
            0.1,
            0.17,
            0.7,
          ),
        ]),
      ],
      sourceHash: 's'.repeat(64),
      fileName: 'small-cap-appendix-headings.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' ? [{ text: node.text, level: node.level }] : [],
      ),
    ).toEqual([
      { text: 'Abstract', level: 1 },
      { text: 'A.1 PROMPTS', level: 2 },
      { text: 'B.1 EVALUATION SCORING DETAILS', level: 2 },
      { text: 'J.7 CASE STUDY', level: 2 },
      { text: 'J.7.1 PREVENTATIVE STEERING', level: 3 },
    ])
    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'paragraph' && /ordinary prose/u.test(node.text)
          ? [node.text]
          : [],
      ),
    ).toEqual([
      'The prompt details remain ordinary prose.',
      'The scoring details remain ordinary prose.',
      'The case-study explanation remains ordinary prose.',
    ])
  })

  it('keeps a named table-column header such as Method out of the heading hierarchy', async () => {
    const medium = (text: string, x: number, width: number) => ({
      ...run(2, text, x, 0.3, width),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.72, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(
            1,
            'Introductory body establishes the prose size.',
            0.1,
            0.3,
            0.7,
          ),
        ]),
        page(2, [
          run(2, 'Table 2: Correlation analysis.', 0.1, 0.24, 0.5),
          medium('Trait', 0.1, 0.08),
          medium('Method', 0.3, 0.1),
          medium('Overall correlation', 0.5, 0.22),
          run(2, 'Evil', 0.1, 0.34, 0.08),
          run(2, 'System prompting', 0.3, 0.34, 0.16),
          run(2, '0.747', 0.58, 0.34, 0.06),
        ]),
      ],
      sourceHash: 'm'.repeat(64),
      fileName: 'named-table-header.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.find(
        (node) => 'text' in node && node.text === 'Method',
      ),
    ).toMatchObject({ type: 'paragraph' })
  })

  it.each(['Table 8', 'Table S2'])(
    'keeps a two-fragment styled table header out of prose and the heading hierarchy after %s',
    async (tableLabel) => {
      const medium = (text: string, x: number, width: number) => ({
        ...run(2, text, x, 0.3, width, 12),
        fontName: 'NimbusRomNo9L-Medi',
      })
      const result = await reconstructPageAnalyses({
        pages: [
          page(1, [
            run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.72, 22),
            run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
            run(
              1,
              'Introductory body establishes the prose size.',
              0.1,
              0.3,
              0.7,
            ),
          ]),
          page(2, [
            run(
              2,
              `${tableLabel}: Datasets used for model pre-training.`,
              0.1,
              0.22,
              0.7,
            ),
            medium('Dataset Address License Category', 0.1, 0.52),
            medium('W MG Citation', 0.65, 0.23),
            run(2, 'WebInstruct chargoddard apache generic', 0.1, 0.34, 0.52),
            run(2, '1.0 ✓ Kim et al.', 0.65, 0.34, 0.23),
            run(2, 'OpenMath nvidia-license math-instruct', 0.1, 0.38, 0.52),
            run(2, '1.0 ✓ Toshniwal et al.', 0.65, 0.38, 0.23),
          ]),
        ],
        sourceHash: 't'.repeat(64),
        fileName: 'two-fragment-table-header.pdf',
        byteLength: 4096,
      })

      const retainedHeaderFragments = result.paper.nodes.flatMap((node) =>
        'text' in node &&
        ['Dataset Address License Category', 'W MG Citation'].includes(
          node.text,
        )
          ? [{ type: node.type, text: node.text }]
          : [],
      )
      expect(
        retainedHeaderFragments.every(({ type }) => type !== 'heading'),
      ).toBe(true)
      if (tableLabel === 'Table 8') {
        expect(retainedHeaderFragments).toEqual([])
        expect(result.visualRelationships[0]).toMatchObject({
          kind: 'table',
          status: 'unresolved',
          evidence: expect.arrayContaining([
            'bounded-table-scope',
            'unresolved-bounded-table-text-owned',
          ]),
        })
      }
    },
  )

  it('keeps paired structural appendix headings even when they follow a table caption', async () => {
    const appendixHeading = (
      text: string,
      x: number,
      y: number,
      width: number,
    ) => ({
      ...run(2, text, x, y, width, 12),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Appendix hierarchy study', 0.1, 0.08, 0.72, 20),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Opening prose establishes body typography.', 0.1, 0.3, 0.72),
        ]),
        page(2, [
          run(
            2,
            'Table 6: Full metrics reported above the appendix sections.',
            0.1,
            0.14,
            0.75,
          ),
          appendixHeading(
            'F Length vs. Story Quality Analysis',
            0.1,
            0.22,
            0.34,
          ),
          appendixHeading('G Full Metrics for Miscellaneous', 0.54, 0.22, 0.34),
          appendixHeading('Writing Problems', 0.575, 0.239, 0.17),
          run(2, 'Left-column appendix prose.', 0.1, 0.29, 0.36),
          run(2, 'Right-column appendix prose.', 0.54, 0.29, 0.36),
          run(2, 'Left-column continuation.', 0.1, 0.32, 0.36),
          run(2, 'Right-column continuation.', 0.54, 0.32, 0.36),
        ]),
      ],
      sourceHash: 'v'.repeat(64),
      fileName: 'paired-appendix-headings-after-table.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && /^[FG]\s/u.test(node.text)
          ? [node.text]
          : [],
      ),
    ).toEqual([
      'F Length vs. Story Quality Analysis',
      'G Full Metrics for Miscellaneous Writing Problems',
    ])
  })

  it('keeps enlarged example-story titles out of an explicit section hierarchy', async () => {
    const structural = (text: string, y: number) => ({
      ...run(2, text, 0.1, y, 0.55, 12),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Structured appendix examples', 0.1, 0.08, 0.72, 20),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          structural('1 Introduction', 0.3),
          run(
            1,
            'The paper establishes an explicit hierarchy.',
            0.1,
            0.35,
            0.7,
          ),
        ]),
        page(2, [
          structural('F Example generated outline', 0.1),
          run(2, 'The outline begins with ordinary content.', 0.1, 0.16, 0.7),
          structural('A New Color in the Canvas', 0.3),
          run(
            2,
            'The story event remains ordinary example content.',
            0.1,
            0.35,
            0.7,
          ),
          structural('A New Beginning', 0.48),
          run(
            2,
            'Another story event remains example content.',
            0.1,
            0.53,
            0.7,
          ),
          structural('G Example generated story', 0.7),
          run(2, 'The next appendix section begins here.', 0.1, 0.75, 0.7),
        ]),
      ],
      sourceHash: 'y'.repeat(64),
      fileName: 'example-story-titles.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.filter(
        (node) =>
          node.type === 'heading' &&
          /^(?:A New Color in the Canvas|A New Beginning)$/u.test(node.text),
      ),
    ).toEqual([])
    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'heading' && /^[FG]\s/u.test(node.text)
          ? [node.text]
          : [],
      ),
    ).toEqual(['F Example generated outline', 'G Example generated story'])
  })

  it('uses excluded same-row table labels to reject a surviving styled header fragment', async () => {
    const medium = (text: string, x: number, width: number) => ({
      ...run(2, text, x, 0.31, width, 7),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const survivingMedium = (text: string, x: number, width: number) => ({
      ...run(2, text, x, 0.31, width, 9),
      fontName: 'NimbusRomNo9L-Medi',
    })
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.72, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(
            1,
            'Introductory body establishes the prose size.',
            0.1,
            0.3,
            0.7,
          ),
        ]),
        page(2, [
          run(2, 'The retained left prose establishes', 0.08, 0.08, 0.38, 10),
          run(2, 'The paired right prose establishes', 0.54, 0.08, 0.38, 10),
          run(2, 'a stable scholarly text column.', 0.08, 0.105, 0.38, 10),
          run(2, 'a second stable scholarly column.', 0.54, 0.105, 0.38, 10),
          run(
            2,
            'A third left line keeps labels subordinate.',
            0.08,
            0.13,
            0.38,
            10,
          ),
          run(2, 'A third right line proves the gutter.', 0.54, 0.13, 0.38, 10),
          run(
            2,
            'Table 8: Datasets used for model pre-training (Part 2: Instruction Data)',
            0.08,
            0.209,
            0.7,
            7,
          ),
          medium('Dataset', 0.08, 0.08),
          medium('Address', 0.22, 0.08),
          medium('License', 0.38, 0.08),
          medium('Category', 0.52, 0.09),
          survivingMedium('W MG Citation', 0.655, 0.113),
          run(2, 'WebInstruct', 0.08, 0.35, 0.08, 7),
          run(2, 'example.org/data', 0.22, 0.35, 0.12, 7),
          run(2, 'Apache-2.0', 0.38, 0.35, 0.09, 7),
          run(2, 'Generic', 0.52, 0.35, 0.08, 7),
          run(2, '1.0 ✓ Kim et al.', 0.655, 0.35, 0.113, 7),
        ]),
      ],
      sourceHash: 'u'.repeat(64),
      fileName: 'fragmented-table-header.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.find(
        (node) => 'text' in node && node.text === 'W MG Citation',
      ),
    ).toMatchObject({ type: 'paragraph' })
  })
})

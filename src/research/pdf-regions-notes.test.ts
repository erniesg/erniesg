import { existsSync } from 'node:fs'
import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildEpub, inspectEpub } from './epub'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import {
  digitValue,
  evaluateReadingOrder,
  noteLabelFromText,
  reconstructPageRegions,
} from './pdf-regions'

function run(
  page: number,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
  height = 0.018,
): PdfSourceRun {
  return {
    page,
    text,
    x,
    y,
    width,
    height,
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
  objects: NonNullable<PdfPageAnalysis['objects']> = [],
): PdfPageAnalysis {
  return {
    page: number,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: objects.length,
    objects,
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

async function reconstruct(pages: PdfPageAnalysis[], hash = '7') {
  return reconstructPageAnalyses({
    pages,
    sourceHash: hash.repeat(64),
    fileName: 'regions.pdf',
    byteLength: 4096,
  })
}

describe('deterministic scholarly page regions', () => {
  it('owns note-label classification behind the compatibility export', async () => {
    const moduleUrl = new URL(
      './pdf-region-note-classification.ts',
      import.meta.url,
    )
    expect(existsSync(moduleUrl)).toBe(true)

    const extracted = await import(moduleUrl.href)
    expect(extracted.noteLabelFromText('Footnote †: Detail')).toBe('†')
    expect(noteLabelFromText).toBe(extracted.noteLabelFromText)
  })

  it('matches a page-wide symbolic footnote and emits EPUB note semantics and backlinks', async () => {
    const result = await reconstruct(
      [
        page(1, [
          run(1, 'Page-Wide Symbolic Notes', 0.2, 0.06, 0.6, 18, 0.03),
          run(1, 'Ada Example', 0.4, 0.13, 0.2, 11),
          run(1, 'Abstract', 0.08, 0.22, 0.18, 14),
          run(
            1,
            'This abstract establishes a source-backed scholarly document.',
            0.08,
            0.27,
            0.84,
          ),
          run(1, '1 Regions', 0.35, 0.39, 0.3, 16, 0.03),
          run(1, 'Left one.', 0.08, 0.5, 0.32),
          run(1, 'Left two.', 0.08, 0.54, 0.32),
          run(1, 'Left marker', 0.08, 0.58, 0.24),
          run(1, '*', 0.325, 0.583, 0.008, 6, 0.009),
          run(1, 'Right one.', 0.56, 0.5, 0.32),
          run(1, 'Right two.', 0.56, 0.54, 0.32),
          run(1, 'Right three.', 0.56, 0.58, 0.32),
          run(
            1,
            '*. A note spanning the full page width.',
            0.08,
            0.84,
            0.84,
            7,
          ),
        ]),
      ],
      '8',
    )

    expect(result.noteRelationships).toEqual([
      expect.objectContaining({
        label: '*',
        status: 'matched',
        evidence: expect.arrayContaining(['page-wide-note-region']),
      }),
    ])
    expect(result.readiness.ready).toBe(true)
    const epub = await buildEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    expect(content).toContain('epub:type="noteref"')
    expect(content).toContain('epub:type="footnote"')
    expect(content).toContain('class="note-backlink"')
  })

  it('splits independently run-backed symbolic note definitions on one source line', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Run-backed author notes', 0.1, 0.08, 0.72, 18),
        run(1, 'Ada Example', 0.2, 0.15, 0.12, 11),
        run(1, '*', 0.321, 0.146, 0.008, 6, 0.009),
        run(1, 'Ben Reader', 0.35, 0.15, 0.12, 11),
        run(1, '†', 0.471, 0.146, 0.008, 6, 0.009),
        run(1, 'Abstract', 0.1, 0.28, 0.25, 16),
        run(1, 'The abstract remains canonical prose.', 0.1, 0.34, 0.72),
        run(1, '*', 0.1, 0.856, 0.008, 6, 0.009),
        run(1, 'Lead author.', 0.109, 0.86, 0.1, 8),
        run(1, '†', 0.22, 0.854, 0.008, 6, 0.009),
        run(1, 'Core contributor.', 0.229, 0.86, 0.14, 8),
      ]),
    ])

    const sourceNotes = result.regions.filter(
      (region) => region.kind === 'footnote',
    )
    expect(
      sourceNotes.map((region) => ({
        id: region.id,
        text: region.text,
        runs: region.lines.flatMap((line) =>
          line.runs.map((sourceRun) => sourceRun.text),
        ),
      })),
    ).toEqual([
      {
        id: expect.stringMatching(/page-001-region-\d{3}$/),
        text: '* Lead author.',
        runs: ['*', 'Lead author.'],
      },
      {
        id: expect.stringMatching(/page-001-region-\d{3}-note-002$/),
        text: '†Core contributor.',
        runs: ['†', 'Core contributor.'],
      },
    ])
    expect(
      result.paper.nodes
        .filter((node) => node.type === 'footnote')
        .map((node) => ({
          label: node.label,
          text: node.text,
          backlinkCount: node.relationships.backlinks.length,
          sourceRuns: result.provenance[node.id].boxes.map((box) =>
            'text' in box ? box.text : undefined,
          ),
        })),
    ).toEqual([
      {
        label: '*',
        text: 'Lead author.',
        backlinkCount: 1,
        sourceRuns: ['*', 'Lead author.'],
      },
      {
        label: '†',
        text: 'Core contributor.',
        backlinkCount: 1,
        sourceRuns: ['†', 'Core contributor.'],
      },
    ])
    expect(
      result.noteRelationships.map((relationship) => ({
        label: relationship.label,
        status: relationship.status,
        targetRegionId: relationship.candidates[0]?.targetRegionId,
      })),
    ).toEqual([
      {
        label: '*',
        status: 'matched',
        targetRegionId: sourceNotes[0].id,
      },
      {
        label: '†',
        status: 'matched',
        targetRegionId: sourceNotes[1].id,
      },
    ])
  })

  it('does not split a symbol embedded inside a prose run', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Body line one.', 0.1, 0.2, 0.7, 10),
        run(1, 'Body line two.', 0.1, 0.25, 0.7, 10),
        run(1, 'Body line three.', 0.1, 0.3, 0.7, 10),
        run(1, '*', 0.1, 0.856, 0.008, 6, 0.009),
        run(1, 'Lead author. †Core contributor.', 0.109, 0.86, 0.26, 8),
      ]),
    ])

    expect(
      result.regions
        .filter((region) => region.kind === 'footnote')
        .map((region) => ({
          id: region.id,
          text: region.text,
          runs: region.lines.flatMap((line) =>
            line.runs.map((sourceRun) => sourceRun.text),
          ),
        })),
    ).toEqual([
      {
        id: expect.stringMatching(/page-001-region-\d{3}$/),
        text: '* Lead author. †Core contributor.',
        runs: ['*', 'Lead author. †Core contributor.'],
      },
    ])
  })

  it('retains a near-body-size symbolic bottom note as a footnote', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Body line one.', 0.08, 0.2, 0.7, 10),
        run(1, 'Body line two.', 0.08, 0.25, 0.7, 10),
        run(1, 'Body line three.', 0.08, 0.3, 0.7, 10),
        run(1, '* Work done during the internship.', 0.08, 0.86, 0.7, 9.5),
      ]),
    ])

    expect(result.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'footnote',
          text: expect.stringContaining('Work done during the internship.'),
        }),
      ]),
    )
    expect(
      result.paper.nodes.some(
        (node) => node.type === 'footnote' && node.text.includes('Work done'),
      ),
    ).toBe(true)
  })

  it('separates an attached raised affiliation note before paragraph joining', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Introduction', 0.1, 0.12, 0.3, 16),
        run(1, 'Body line one.', 0.1, 0.2, 0.7, 10),
        run(1, 'Body line two.', 0.1, 0.25, 0.7, 10),
        run(1, 'Body line three.', 0.1, 0.3, 0.7, 10),
        run(1, 'LLMs use a form', 0.1, 0.82, 0.32, 10),
        run(1, '1', 0.1, 0.848, 0.008, 6, 0.008),
        run(
          1,
          'Example Institute. Correspondence to:',
          0.108,
          0.849,
          0.52,
          9,
          0.016,
        ),
        run(1, 'Ada <ada@example.edu>.', 0.1, 0.866, 0.36, 9, 0.016),
      ]),
    ])

    const note = result.regions.find((region) => region.kind === 'footnote')
    const prose = result.regions
      .filter((region) => region.kind === 'body')
      .map((region) => region.text)
      .join(' ')

    expect(note).toMatchObject({
      kind: 'footnote',
      text: '1 Example Institute. Correspondence to: Ada <ada@example.edu>.',
    })
    expect(note?.lines).toHaveLength(2)
    expect(prose).toContain('LLMs use a form')
    expect(prose).not.toContain('Example Institute')
    expect(
      result.paper.nodes.find((node) => node.type === 'footnote'),
    ).toMatchObject({
      label: '1',
      text: 'Example Institute. Correspondence to: Ada <ada@example.edu>.',
    })
  })

  it('keeps a wrapped symbolic note continuation in the note', async () => {
    const result = await reconstruct([
      withExplicitEnglishLanguage(
        page(1, [
          run(1, 'LightSpeed Studios, Tencent', 0.2, 0.1, 0.5, 9),
          run(1, 'Body line one.', 0.08, 0.2, 0.7, 10),
          run(1, 'Body line two.', 0.08, 0.25, 0.7, 10),
          run(1, 'Body line three.', 0.08, 0.3, 0.7, 10),
          run(
            1,
            '*Work done during the internship at Tencent Lightspeed stu-',
            0.109,
            0.862,
            0.369,
            9,
            0.011,
          ),
          run(1, 'dios.', 0.088, 0.875, 0.028, 9, 0.011),
        ]),
      ),
    ])

    expect(
      result.paper.nodes.find((node) => node.type === 'footnote'),
    ).toMatchObject({
      text: '*Work done during the internship at Tencent Lightspeed studios.',
    })
    expect(
      result.paper.nodes.some(
        (node) => node.type === 'paragraph' && node.text.includes('dios.'),
      ),
    ).toBe(false)
  })

  it('keeps short continuation lines with page-wide numbered footnotes', async () => {
    const result = await reconstruct([
      withExplicitEnglishLanguage(
        page(1, [
          run(
            1,
            'Left-column prose establishes the first column.',
            0.08,
            0.2,
            0.34,
          ),
          run(
            1,
            'Right-column prose establishes the second column.',
            0.56,
            0.2,
            0.34,
          ),
          run(1, 'More left-column prose continues below.', 0.08, 0.24, 0.34),
          run(1, 'More right-column prose continues below.', 0.56, 0.24, 0.34),
          run(1, 'Final left-column evidence.', 0.08, 0.28, 0.34),
          run(1, 'Final right-column evidence.', 0.56, 0.28, 0.34),
          run(
            1,
            '2 We found that response tokens yield more effective steering directions than alternative positions such as',
            0.197,
            0.87,
            0.626,
            8,
            0.012,
          ),
          run(
            1,
            'prompt tokens (see Appendix A.3).',
            0.176,
            0.884,
            0.207,
            8,
            0.011,
          ),
          run(
            1,
            '3 We show results for four additional traits, including positive traits such as optimism and humor, in Ap-',
            0.197,
            0.897,
            0.626,
            8,
            0.012,
          ),
          run(1, 'pendix G.', 0.176, 0.911, 0.058, 8, 0.011),
        ]),
      ),
    ])

    expect(
      result.paper.nodes
        .filter((node) => node.type === 'footnote')
        .map((node) => ({ label: node.label, text: node.text })),
    ).toEqual([
      {
        label: '2',
        text: 'We found that response tokens yield more effective steering directions than alternative positions such as prompt tokens (see Appendix A.3).',
      },
      {
        label: '3',
        text: 'We show results for four additional traits, including positive traits such as optimism and humor, in Appendix G.',
      },
    ])
  })

  it('keeps a wrapped URL continuation in its symbolic footnote', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Body line one.', 0.08, 0.2, 0.7, 10),
        run(1, 'Body line two.', 0.08, 0.25, 0.7, 10),
        run(1, 'Body line three.', 0.08, 0.3, 0.7, 10),
        run(
          1,
          '* The implementation is available at https://github.',
          0.109,
          0.862,
          0.369,
          9,
          0.011,
        ),
        run(1, 'com/example/project', 0.088, 0.875, 0.16, 9, 0.011),
      ]),
    ])

    expect(
      result.paper.nodes.find((node) => node.type === 'footnote'),
    ).toMatchObject({
      text: 'The implementation is available at https://github.com/example/project',
    })
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          node.text.includes('com/example/project'),
      ),
    ).toBe(false)
  })

  it('retains unresolved and equally plausible note candidates as explicit diagnostics', async () => {
    const unresolved = await reconstruct([
      page(1, [run(1, 'A claim with an unavailable note[3].', 0.1, 0.2, 0.72)]),
    ])
    expect(unresolved.noteRelationships).toEqual([
      expect.objectContaining({
        label: '3',
        status: 'unresolved',
        targetNoteId: null,
        candidates: [],
      }),
    ])
    expect(unresolved.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNRESOLVED_NOTE_REFERENCE' }),
      ]),
    )

    const ambiguous = await reconstruct([
      page(1, [
        run(1, 'Left one.', 0.08, 0.2, 0.32),
        run(1, 'Left two.', 0.08, 0.24, 0.32),
        run(1, 'Left three.', 0.08, 0.28, 0.32),
        run(1, 'Right one.', 0.56, 0.2, 0.32),
        run(1, 'Right two.', 0.56, 0.24, 0.32),
        run(1, 'Right three.', 0.56, 0.28, 0.32),
        run(1, 'A spanning claim has note reference 1.', 0.1, 0.42, 0.8),
        run(1, '1. Left candidate.', 0.08, 0.82, 0.32, 7),
        run(1, '1. Right candidate.', 0.56, 0.82, 0.32, 7),
      ]),
    ])
    expect(ambiguous.noteRelationships).toEqual([
      expect.objectContaining({
        status: 'ambiguous',
        targetNoteId: null,
        candidates: [
          expect.objectContaining({ score: 0.85 }),
          expect.objectContaining({ score: 0.85 }),
        ],
      }),
    ])
    expect(ambiguous.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AMBIGUOUS_NOTE_MATCH' }),
      ]),
    )
  })

  it('resolves multi-page endnotes and exposes machine-readable order accuracy', async () => {
    const result = await reconstruct(
      [
        page(1, [
          run(1, 'The first claim has note reference 1.', 0.1, 0.2, 0.72),
          run(1, 'The second claim has note reference 2.', 0.1, 0.25, 0.72),
        ]),
        page(2, [
          run(2, 'Endnotes', 0.1, 0.12, 0.3, 18),
          run(2, '1. First endnote on page two.', 0.1, 0.22, 0.72),
        ]),
        page(3, [run(3, '2. Second endnote on page three.', 0.1, 0.18, 0.72)]),
      ],
      '9',
    )

    expect(
      result.paper.nodes.filter((node) => node.type === 'footnote'),
    ).toEqual([
      expect.objectContaining({ kind: 'endnote', label: '1' }),
      expect.objectContaining({ kind: 'endnote', label: '2' }),
    ])
    expect(
      result.noteRelationships.every((note) => note.status === 'matched'),
    ).toBe(true)
    expect(result.completeness).toMatchObject({
      expectedRelationshipCount: 2,
      resolvedRelationshipCount: 2,
      relationshipCoverage: 1,
    })
    expect(
      evaluateReadingOrder(result.readingOrder, result.readingOrder.order),
    ).toMatchObject({ orderAccuracy: 1, cycleRate: 0 })
  })

  it('accounts for Unicode folios, rotated stamps, and one-off margin review', () => {
    const arabic = ['١', '٢', '٣']
    const devanagari = ['१', '२', '३']
    const roman = ['I', 'II', 'III']
    const pages = [1, 2, 3].map((pageNumber, index) =>
      page(pageNumber, [
        run(pageNumber, arabic[index], 0.46, 0.95, 0.03, 8),
        run(pageNumber, devanagari[index], 0.52, 0.95, 0.03, 8),
        run(pageNumber, roman[index], 0.58, 0.95, 0.03, 8),
        {
          ...run(
            pageNumber,
            'opaque rotated archive stamp',
            0.02,
            0.35,
            0.5,
            8,
          ),
          rotation: 90,
        },
        run(
          pageNumber,
          pageNumber === 2
            ? 'A genuine sentence in the lower margin remains reviewable.'
            : `Canonical body prose on page ${pageNumber}.`,
          0.12,
          pageNumber === 2 ? 0.94 : 0.2,
          0.7,
          10,
        ),
      ]),
    )
    const first = reconstructPageRegions(pages)
    const second = reconstructPageRegions(pages)
    const furniture = first.regions.filter((region) => region.furniture)
    expect(
      furniture
        .filter((region) => region.kind === 'page-number')
        .flatMap((region) => region.text.split(/\s+/u)),
    ).toEqual(['١', '१', 'I', '٢', '२', 'II', '٣', '३', 'III'])
    expect(
      furniture.some(
        (region) =>
          region.furniture?.classification === 'rotated-margin' &&
          region.furniture.evidence.includes('quarter-turn-margin-rotation'),
      ),
    ).toBe(true)
    expect(
      first.regions.some(
        (region) =>
          region.furnitureReview?.reason === 'single-occurrence-margin' &&
          region.includedInReadingOrder,
      ),
    ).toBe(true)
    expect(first.regions).toEqual(second.regions)
  })

  it('splits a reviewable margin run from an adjacent first-page title run', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Submitted for bounded source review', 0.1, 0.03, 0.3, 8),
        run(1, 'Synthetic title block', 0.41, 0.03, 0.16, 14),
        run(
          1,
          'Canonical body prose establishes the page font.',
          0.12,
          0.2,
          0.72,
        ),
        run(
          1,
          'A second body line stabilizes the source geometry.',
          0.12,
          0.24,
          0.72,
        ),
      ]),
    ])

    expect(
      result.regions.find(
        (region) => region.text === 'Submitted for bounded source review',
      ),
    ).toMatchObject({
      furnitureReview: { reason: 'single-occurrence-margin' },
      includedInReadingOrder: true,
    })
    expect(
      result.regions.find((region) => region.text === 'Synthetic title block'),
    ).toMatchObject({ includedInReadingOrder: true })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'FURNITURE_REVIEW_REQUIRED',
          severity: 'error',
        }),
      ]),
    )
  })

  it('keeps short unproven margin lines on the bounded header path', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(
          1,
          'Canonical body prose establishes the page font.',
          0.12,
          0.2,
          0.72,
        ),
        run(
          1,
          'A second body line stabilizes the source geometry.',
          0.12,
          0.24,
          0.72,
        ),
        run(1, 'DRAFT', 0.2, 0.03, 0.08, 8.5),
      ]),
    ])

    expect(
      result.regions.find((region) => region.text === 'DRAFT'),
    ).toMatchObject({
      kind: 'header',
      confidence: 0.78,
      includedInReadingOrder: false,
    })
  })

  it('does not attach furniture evidence to protected repeated-margin headings', () => {
    const prefixForms = [
      (ordinal: number) => `A.${ordinal}.`,
      (ordinal: number) => `A.1.${ordinal}`,
    ]

    for (const prefix of prefixForms) {
      const headingPage = (pageNumber: number, ordinal: number) =>
        page(pageNumber, [
          {
            ...run(pageNumber, prefix(ordinal), 0.1, 0.08, 0.05, 14),
            fontName: 'Synthetic-Bold',
            bold: true,
          },
          {
            ...run(
              pageNumber,
              `Repeated Section ${ordinal}`,
              0.155,
              0.08,
              0.5,
              14,
            ),
            fontName: 'Synthetic-Bold',
            bold: true,
          },
          run(
            pageNumber,
            `Canonical body prose on page ${pageNumber}.`,
            0.12,
            0.2,
            0.72,
          ),
        ])
      const result = reconstructPageRegions([
        page(1, [
          {
            ...run(1, 'A Parent Heading', 0.12, 0.04, 0.3, 14),
            fontName: 'Synthetic-Bold',
            bold: true,
          },
          run(1, 'Canonical body prose on page 1.', 0.12, 0.2, 0.72),
        ]),
        headingPage(2, 1),
        headingPage(3, 2),
        headingPage(4, 3),
      ])

      const headings = result.regions.filter((region) =>
        region.text.includes('Repeated Section'),
      )
      expect(headings).toHaveLength(3)
      expect(
        headings.every(
          (region) =>
            region.kind === 'body' &&
            region.furniture === undefined &&
            region.includedInReadingOrder,
        ),
      ).toBe(true)
    }
  })

  it('protects a narrow first-page title-block run while later repeats remain furniture', () => {
    const titlePage = (pageNumber: number) =>
      page(pageNumber, [
        run(pageNumber, 'Ada Lovelace', 0.12, 0.09, 0.22, 9),
        run(
          pageNumber,
          `Canonical body prose on page ${pageNumber}.`,
          0.12,
          0.2,
          0.72,
        ),
        run(
          pageNumber,
          `A second body line stabilizes page ${pageNumber}.`,
          0.12,
          0.24,
          0.72,
        ),
      ])
    const result = reconstructPageRegions([
      titlePage(1),
      titlePage(2),
      titlePage(3),
    ])
    const titleRegions = result.regions.filter(
      (region) => region.text === 'Ada Lovelace',
    )

    expect(titleRegions).toHaveLength(3)
    expect(titleRegions[0]).toMatchObject({
      kind: 'body',
      includedInReadingOrder: true,
    })
    expect(titleRegions[0].furniture).toBeUndefined()
    expect(
      titleRegions
        .slice(1)
        .every(
          (region) =>
            region.kind === 'header' &&
            region.includedInReadingOrder === false &&
            region.furniture?.classification === 'repeated-text',
        ),
    ).toBe(true)
  })

  it('recognizes every Unicode decimal digit supported by the runtime', () => {
    const missing: string[] = []
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      const character = String.fromCodePoint(codePoint)
      if (!/^\p{Nd}$/u.test(character)) continue
      if (digitValue(character) === null) {
        missing.push(`U+${codePoint.toString(16).toUpperCase()}`)
      }
    }

    expect(missing).toEqual([])
  })

  it('classifies a newly assigned decimal digit range as incrementing folios', () => {
    const folio = (index: number) => String.fromCodePoint(0x10d40 + index)
    const result = reconstructPageRegions(
      [1, 2, 3].map((pageNumber, index) =>
        page(pageNumber, [
          run(
            pageNumber,
            `Canonical body prose on page ${pageNumber}.`,
            0.12,
            0.2,
            0.72,
          ),
          run(pageNumber, folio(index), 0.48, 0.95, 0.03, 8),
        ]),
      ),
    )

    expect(
      result.regions
        .filter((region) =>
          [folio(0), folio(1), folio(2)].includes(region.text),
        )
        .map((region) => ({
          text: region.text,
          kind: region.kind,
          classification: region.furniture?.classification,
        })),
    ).toEqual(
      [folio(0), folio(1), folio(2)].map((text) => ({
        text,
        kind: 'page-number',
        classification: 'incrementing-numeral',
      })),
    )
  })

  it('keeps raised Unicode note markers linked while margin numerals remain furniture', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Unicode note geometry', 0.12, 0.08, 0.68, 18),
        run(1, 'Ada Researcher', 0.12, 0.14, 0.3, 11),
        run(1, 'Abstract', 0.12, 0.21, 0.22, 14),
        run(
          1,
          'The abstract establishes a source-backed multilingual fixture.',
          0.12,
          0.26,
          0.72,
        ),
        run(1, 'Arabic-Indic evidence', 0.12, 0.38, 0.3, 10),
        run(1, '١', 0.425, 0.374, 0.009, 6, 0.009),
        run(1, 'Devanagari evidence', 0.12, 0.46, 0.3, 10),
        run(1, '२', 0.425, 0.454, 0.009, 6, 0.009),
        run(1, '١. Arabic-Indic note body.', 0.12, 0.82, 0.72, 7),
        run(1, '२. Devanagari note body.', 0.12, 0.86, 0.72, 7),
      ]),
    ])

    expect(
      result.noteRelationships.map((relationship) => ({
        label: relationship.label,
        status: relationship.status,
        sourceText: result.regions
          .find((region) => region.id === relationship.referenceRegionId)
          ?.text.slice(relationship.referenceStart, relationship.referenceEnd),
      })),
    ).toEqual([
      { label: '1', status: 'matched', sourceText: '١' },
      { label: '2', status: 'matched', sourceText: '२' },
    ])
  })

  it('defers overlapping repeated numeral bands to the footnote stratum', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Body prose establishes the page font.', 0.12, 0.2, 0.72, 10),
        run(
          1,
          '1. Genuine note body remains a footnote, not page furniture,',
          0.12,
          0.86,
          0.72,
          7,
        ),
        run(
          1,
          'The wrapped note continuation remains owned by the footnote.',
          0.12,
          0.884,
          0.72,
          7,
        ),
      ]),
      page(2, [
        run(
          2,
          'More body prose establishes the page font.',
          0.12,
          0.2,
          0.72,
          10,
        ),
        run(
          2,
          '2. Genuine note body remains a footnote, not page furniture,',
          0.12,
          0.86,
          0.72,
          7,
        ),
        run(
          2,
          'The wrapped note continuation remains owned by the footnote.',
          0.12,
          0.884,
          0.72,
          7,
        ),
      ]),
    ])

    const notes = result.regions.filter((region) => region.kind === 'footnote')
    expect(notes).toHaveLength(2)
    expect(notes.every((region) => region.includedInReadingOrder)).toBe(true)
    expect(notes.every((region) => region.furniture === undefined)).toBe(true)
    expect(
      notes.every((region) =>
        region.text.includes('wrapped note continuation'),
      ),
    ).toBe(true)
    expect(result.furnitureAssessment.furnitureRuns).toHaveLength(0)
  })
})

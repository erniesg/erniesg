import { describe, expect, it } from 'vitest'
import {
  ambiguousNoteMarkerFixture,
  decisiveNoteMarkerFixtures,
  orphanedNoteFixture,
  type NoteMarkerFixture,
} from '../../tests/fixtures/note-marker-fixtures'
import type {
  PdfLineBoundaryDecision,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
  ReconstructionDiagnostic,
} from './import-types'
import {
  PDF_NOTE_RELATIONSHIP_THRESHOLD,
  reconstructPageAnalyses,
} from './pdf-layout'
import {
  classifyPdfNoteMarkers,
  pdfAlternateAuthorYearKeyFromBoundary,
  PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD,
} from './pdf-note-classifier'
import { assessPdfCompleteness } from './pdf-quality'

const BLOCKING_NOTE_CODES = new Set<ReconstructionDiagnostic['code']>([
  'UNRESOLVED_NOTE_REFERENCE',
  'AMBIGUOUS_NOTE_MATCH',
  'UNREFERENCED_NOTE',
])

function reconstruct(
  fixture: NoteMarkerFixture,
  hashCharacter: string,
  language?: string,
) {
  return reconstructPageAnalyses({
    pages: fixture.pages,
    sourceHash: hashCharacter.repeat(64),
    fileName: `${fixture.name.replace(/[^a-z0-9]+/gi, '-')}.pdf`,
    byteLength: 4096,
    metadata: language ? { language } : {},
  })
}

function noteRun(
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
  height = 0.018,
): PdfSourceRun {
  return {
    page: 1,
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

function notePage(runs: PdfSourceRun[]): PdfPageAnalysis {
  return {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, run) => total + run.text.length, 0),
    imageCount: 0,
    runs,
  }
}

function authorYearRegion(
  id: string,
  page: number,
  texts: string[],
  y: number,
): PdfPageRegion {
  const lines = texts.map((text, index) => {
    const source = {
      ...noteRun(text, 0.1, y + index * 0.022, 0.72),
      page,
    }
    return {
      id: `${id}-line-${index + 1}`,
      text,
      fontSize: source.fontSize,
      box: { ...source },
      runs: [source],
    }
  })
  return {
    id,
    page,
    kind: 'body',
    column: 'single',
    text: texts.join(''),
    confidence: 1,
    box: {
      page,
      x: 0.1,
      y,
      width: 0.72,
      height: Math.max(0.018, texts.length * 0.022),
      rotation: 0,
      method: 'pdf-text',
    },
    lines,
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

function authorYearBoundaryDecision(
  region: PdfPageRegion,
  outcome: PdfLineBoundaryDecision['outcome'],
): PdfLineBoundaryDecision {
  return {
    id: `${region.id}-boundary`,
    page: region.page,
    regionId: region.id,
    fromLineId: region.lines[0].id,
    toLineId: region.lines[1].id,
    outcome,
    evidence: ['test-line-boundary'],
  }
}

function markerDiagnostics(result: Awaited<ReturnType<typeof reconstruct>>) {
  return result.diagnostics.filter(
    (diagnostic) => diagnostic.code === 'CLASSIFIED_NOTE_MARKER',
  )
}

describe('scholarly note-marker taxonomy', () => {
  it('recognizes an unheaded bracketed reference only from strong author-year evidence', () => {
    const text =
      '[7] Ada Lovelace and Charles Babbage. 1843. Notes on the analytical engine.'
    const sourceRun = noteRun(text, 0.1, 0.42, 0.72)
    const region = {
      id: 'unheaded-author-year-reference',
      page: 1,
      kind: 'body',
      column: 'single',
      text,
      confidence: 1,
      box: { ...sourceRun },
      lines: [
        {
          id: 'unheaded-author-year-reference-line',
          text,
          fontSize: sourceRun.fontSize,
          box: { ...sourceRun },
          runs: [sourceRun],
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion

    const result = classifyPdfNoteMarkers([region])

    expect(result.bibliographyRegionIds).toEqual([region.id])
    expect(result.classifications).toEqual([
      expect.objectContaining({
        referenceRegionId: region.id,
        label: '7',
        taxonomy: 'bibliography-entry',
        disposition: 'plain-text',
        accepted: true,
      }),
    ])
  })

  it('keeps an excluded visual-style References heading in physical section scope', () => {
    const region = (
      id: string,
      page: number,
      text: string,
      y: number,
      kind: PdfPageRegion['kind'] = 'body',
    ): PdfPageRegion => ({
      id,
      page,
      kind,
      column: 'single',
      text,
      confidence: 1,
      box: {
        page,
        x: 0.1,
        y,
        width: 0.72,
        height: 0.018,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [],
      nativeObjectIds: [],
      includedInReadingOrder: kind !== 'chart-label',
    })
    const body = region(
      'citation-led-body',
      1,
      '[9] continues the ordinary body sentence.',
      0.3,
    )
    const heading = region(
      'visual-style-reference-heading',
      2,
      'REFERENCES',
      0.2,
      'chart-label',
    )
    const reference = region(
      'split-reference-start',
      2,
      '[9] Ada Lovelace and Charles Babbage.',
      0.3,
    )

    const result = classifyPdfNoteMarkers(
      [body, heading, reference],
      [body.id, reference.id],
    )

    expect(result.bibliographyRegionIds).toContain(reference.id)
    expect(result.bibliographyRegionIds).not.toContain(body.id)
    expect(
      result.classifications.map(
        ({ referenceRegionId, taxonomy, disposition }) => ({
          referenceRegionId,
          taxonomy,
          disposition,
        }),
      ),
    ).toEqual([
      {
        referenceRegionId: body.id,
        taxonomy: 'bracketed-bibliography-citation',
        disposition: 'citation',
      },
      {
        referenceRegionId: reference.id,
        taxonomy: 'bibliography-entry',
        disposition: 'plain-text',
      },
    ])
  })

  it('does not promote mathematical intervals or numeric lists to citations', () => {
    const region = (id: string, text: string): PdfPageRegion => ({
      id,
      page: 1,
      kind: 'body',
      column: 'single',
      text,
      confidence: 1,
      box: {
        page: 1,
        x: 0.1,
        y: id === 'references' ? 0.8 : 0.2,
        width: 0.7,
        height: 0.03,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })

    const classifications = classifyPdfNoteMarkers([
      region('citations', 'Prior work [1] and later work [2] support this.'),
      region(
        'math',
        'For a, b ∈ [0,99], evaluate periods T = [2,5,10,100], numbers [0,361], tokenizes [0,557], bounded probabilities on [0,1], remove [0, 1] boundaries, repeat values + [26] * 5, and concatenate d + [1] + e. Helix: [2,5,10,100]. Hidden states h⁰³⁶⁰ and h⁰⁹⁹ yield R² = 0.788, variance ŝ²_J, and RV = (∆x̂u)². Re³ improves planning while Re³ preserves coherence.',
      ),
      region('references', 'References'),
    ]).classifications

    expect(
      classifications.map(({ label, taxonomy, disposition }) => ({
        label,
        taxonomy,
        disposition,
      })),
    ).toEqual([
      {
        label: '1',
        taxonomy: 'bracketed-bibliography-citation',
        disposition: 'citation',
      },
      {
        label: '2',
        taxonomy: 'bracketed-bibliography-citation',
        disposition: 'citation',
      },
    ])
  })

  it('keeps a comma-separated bracket citation when one label also names a footnote', () => {
    const region = (
      id: string,
      page: number,
      text: string,
      y: number,
      kind: PdfPageRegion['kind'] = 'body',
    ): PdfPageRegion => ({
      id,
      page,
      kind,
      column: 'single',
      text,
      confidence: 1,
      box: {
        page,
        x: 0.1,
        y,
        width: 0.7,
        height: 0.03,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })

    const result = classifyPdfNoteMarkers([
      region(
        'citation',
        1,
        'Prior work [1, 60] establishes the baseline.',
        0.3,
      ),
      region(
        'footnote',
        1,
        '1 This genuine note belongs to a different inline marker.',
        0.88,
        'footnote',
      ),
      region('references', 2, 'References', 0.1),
    ])

    expect(
      result.classifications
        .filter(({ referenceRegionId }) => referenceRegionId === 'citation')
        .map(({ label, taxonomy, disposition }) => ({
          label,
          taxonomy,
          disposition,
        })),
    ).toEqual([
      {
        label: '1,60',
        taxonomy: 'bracketed-bibliography-citation',
        disposition: 'citation',
      },
    ])
  })

  it('keeps an exact single-label bibliography citation when its number also names a footnote', () => {
    const region = (
      id: string,
      page: number,
      text: string,
      y: number,
      kind: PdfPageRegion['kind'] = 'body',
    ): PdfPageRegion => ({
      id,
      page,
      kind,
      column: 'single',
      text,
      confidence: 1,
      box: {
        page,
        x: 0.1,
        y,
        width: 0.7,
        height: 0.03,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })

    const result = classifyPdfNoteMarkers([
      region(
        'citations',
        1,
        'Foundational work [3] and a later extension [4] establish this.',
        0.3,
      ),
      region(
        'footnote',
        1,
        '3 This genuine note belongs to a different superscript marker.',
        0.88,
        'footnote',
      ),
      region('references', 2, 'References', 0.1),
      region('reference-3', 2, '[3] A. Author. Foundational work.', 0.2),
      region('reference-4', 2, '[4] B. Author. Later extension.', 0.25),
    ])

    expect(
      result.classifications
        .filter(({ referenceRegionId }) => referenceRegionId === 'citations')
        .map(({ label, taxonomy, disposition }) => ({
          label,
          taxonomy,
          disposition,
        })),
    ).toEqual([
      {
        label: '3',
        taxonomy: 'bracketed-bibliography-citation',
        disposition: 'citation',
      },
      {
        label: '4',
        taxonomy: 'bracketed-bibliography-citation',
        disposition: 'citation',
      },
    ])
  })

  it('keeps raised mathematical powers out of note references while retaining a real note', () => {
    const geometryRegion = (
      id: string,
      y: number,
      parts: Array<{ text: string; raised?: boolean }>,
    ): PdfPageRegion => {
      let x = 0.1
      const runs = parts.map(({ text, raised = false }) => {
        const width = Math.max(0.008, text.length * 0.009)
        const source = noteRun(
          text,
          x,
          raised ? y - 0.006 : y,
          width,
          raised ? 6 : 10,
          raised ? 0.009 : 0.018,
        )
        x += width
        return source
      })
      const text = parts.map((part) => part.text).join('')
      return {
        id,
        page: 1,
        kind: 'body',
        column: 'single',
        text,
        confidence: 1,
        box: {
          page: 1,
          x: 0.1,
          y,
          width: 0.75,
          height: 0.02,
          rotation: 0,
          method: 'pdf-text',
        },
        lines: [
          {
            id: `${id}-line`,
            text,
            fontSize: 10,
            box: {
              page: 1,
              x: 0.1,
              y,
              width: 0.75,
              height: 0.02,
              rotation: 0,
              method: 'pdf-text',
            },
            runs,
          },
        ],
        nativeObjectIds: [],
        includedInReadingOrder: true,
      }
    }
    const footnote = (id: string, text: string, y: number): PdfPageRegion => ({
      id,
      page: 1,
      kind: 'footnote',
      column: 'single',
      text,
      confidence: 1,
      box: {
        page: 1,
        x: 0.1,
        y,
        width: 0.75,
        height: 0.02,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })
    const result = classifyPdfNoteMarkers([
      geometryRegion('variance', 0.2, [
        { text: 'Belief variance σb' },
        { text: '2', raised: true },
        { text: ' has units.' },
      ]),
      geometryRegion('jacobian', 0.3, [
        { text: 'The Jacobian S′(x)' },
        { text: '2', raised: true },
        { text: 'σb' },
        { text: '2', raised: true },
        { text: ' and realized (dp)' },
        { text: '2', raised: true },
        { text: ' remain stable.' },
      ]),
      geometryRegion('delimiter', 0.4, [
        { text: '⎧' },
        { text: '2', raised: true },
        { text: '(x⎭⎩(⎫' },
      ]),
      geometryRegion('fraction', 0.45, [
        { text: 'The weighted mid = ' },
        { text: '1', raised: true },
        { text: ' ∑ values.' },
      ]),
      geometryRegion('styled-variable', 0.47, [
        { text: 'The radius √ ' },
        { text: '𝑂𝐶' },
        { text: '2', raised: true },
        { text: ' remains bounded.' },
      ]),
      geometryRegion('styled-mixed-script', 0.472, [
        { text: 'The mixed suffix ' },
        { text: '𝑂𝐶' },
        { text: '2', raised: true },
        { text: '³', raised: true },
        { text: ' remains mathematical.' },
      ]),
      geometryRegion('styled-eight-letter-variable', 0.474, [
        { text: 'The bounded identifier ' },
        { text: '𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇' },
        { text: '3', raised: true },
        { text: ' remains mathematical.' },
      ]),
      geometryRegion('styled-nine-letter-control', 0.476, [
        { text: 'The unbounded styled token ' },
        { text: '𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈' },
        { text: '4', raised: true },
        { text: ' remains fail-closed.' },
      ]),
      geometryRegion('styled-inline-digit', 0.478, [
        { text: 'The inline identifier ' },
        { text: '𝑂𝐶' },
        { text: '2' },
        { text: ' is not raised.' },
      ]),
      geometryRegion('scientific', 0.48, [
        { text: 'Use learning rates 10−' },
        { text: '5', raised: true },
        { text: ' and 1e−' },
        { text: '5', raised: true },
        { text: '.' },
      ]),
      geometryRegion('power-grid', 0.49, [
        { text: '10' },
        { text: '3', raised: true },
        { text: ' 10' },
        { text: '4', raised: true },
        { text: ' Optimizer Step Main' },
      ]),
      geometryRegion('power-column', 0.495, [
        { text: '10' },
        { text: '1', raised: true },
      ]),
      geometryRegion('parenthesized-index', 0.497, [
        { text: '(T(' },
        { text: '1', raised: true },
        { text: ') 2π' },
      ]),
      geometryRegion('separated-styled-token', 0.499, [
        { text: '𝐀𝐁 ' },
        { text: '1', raised: true },
        { text: ' remains a genuine prose note.' },
      ]),
      geometryRegion('claim', 0.5, [
        { text: 'We' },
        { text: '2', raised: true },
        { text: ' report this prose claim.' },
      ]),
      footnote('note-one', '1 A genuine numbered note.', 0.87),
      footnote('note', '2 This is the genuine note.', 0.88),
      footnote('note-three', '3 Another genuine note.', 0.89),
      footnote('note-four', '4 A final genuine note.', 0.9),
    ])

    expect(
      result.classifications
        .filter(({ disposition }) => disposition === 'note-reference')
        .map(({ referenceRegionId, label, taxonomy }) => ({
          referenceRegionId,
          label,
          taxonomy,
        })),
    ).toEqual([
      {
        referenceRegionId: 'styled-nine-letter-control',
        label: '4',
        taxonomy: 'footnote-reference',
      },
      {
        referenceRegionId: 'separated-styled-token',
        label: '1',
        taxonomy: 'footnote-reference',
      },
      {
        referenceRegionId: 'claim',
        label: '2',
        taxonomy: 'footnote-reference',
      },
    ])
  })

  it('does not promote a repeated rendered model-name superscript to a citation', () => {
    const proseRegion = (
      id: string,
      text: string,
      y: number,
      runs: PdfSourceRun[],
    ): PdfPageRegion => ({
      id,
      page: 1,
      kind: 'body',
      column: 'single',
      text,
      confidence: 1,
      box: {
        page: 1,
        x: 0.1,
        y,
        width: 0.7,
        height: 0.02,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [
        {
          id: `${id}-line`,
          text,
          fontSize: Math.max(...runs.map((run) => run.fontSize)),
          box: {
            page: 1,
            x: 0.1,
            y,
            width: 0.7,
            height: 0.02,
            rotation: 0,
            method: 'pdf-text',
          },
          runs,
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })
    const modelRegion = (id: string, tail: string, y: number) =>
      proseRegion(id, `Re3 ${tail}`, y, [
        noteRun('Re', 0.1, y, 0.025),
        noteRun('3', 0.125, y - 0.002, 0.006, 7, 0.009),
        noteRun(` ${tail}`, 0.135, y, 0.5),
      ])
    const plainRegion = (
      id: string,
      text: string,
      y: number,
    ): PdfPageRegion => ({
      ...proseRegion(id, text, y, [noteRun(text, 0.1, y, 0.7)]),
      lines: [],
    })

    const result = classifyPdfNoteMarkers([
      plainRegion(
        'author-year',
        'Prior work (Yang et al., 2022) establishes the baseline.',
        0.2,
      ),
      modelRegion('model-one', 'improves planning.', 0.3),
      modelRegion('model-two', 'preserves coherence.', 0.4),
      plainRegion('references', 'References', 0.7),
      plainRegion(
        'reference-entry',
        'Kevin Yang, Nanyun Peng, and Dan Klein. 2022. A planning study.',
        0.76,
      ),
    ])

    expect(
      result.classifications.filter(
        ({ referenceRegionId, label }) =>
          label === '3' &&
          (referenceRegionId === 'model-one' ||
            referenceRegionId === 'model-two'),
      ),
    ).toEqual([])
  })

  it('ends a bibliography before a font-backed lettered appendix heading', () => {
    const region = (
      id: string,
      page: number,
      text: string,
      fontSize: number,
      lines = 1,
    ): PdfPageRegion => {
      const y = id === 'reference-entry' ? 0.2 : 0.1
      return {
        id,
        page,
        kind: 'body',
        column: 'single',
        text,
        confidence: 1,
        box: {
          page,
          x: 0.1,
          y,
          width: 0.7,
          height: 0.02 * lines,
          rotation: 0,
          method: 'pdf-text',
        },
        lines: Array.from({ length: lines }, (_, index) => ({
          id: `${id}-line-${index + 1}`,
          text,
          fontSize,
          box: {
            page,
            x: 0.1,
            y: y + index * 0.02,
            width: 0.7,
            height: 0.02,
            rotation: 0,
            method: 'pdf-text',
          },
          runs: [],
        })),
        nativeObjectIds: [],
        includedInReadingOrder: true,
      }
    }

    const appendixHeading = region(
      'appendix-heading',
      2,
      'A Datasets Detsils',
      11,
    )
    appendixHeading.lines[0].runs = [
      {
        ...appendixHeading.lines[0].box,
        text: appendixHeading.text,
        fontName: 'NimbusRomNo9L-Medi',
        fontSize: 11,
        confidence: 1,
      },
    ]
    const result = classifyPdfNoteMarkers(
      [
        region('references', 1, 'References', 16),
        region(
          'reference-entry',
          1,
          'A. Localizing model behavior with path patching, 2023.',
          10,
          4,
        ),
        appendixHeading,
        region('appendix-body', 2, 'Appendix prose remains ordinary body.', 10),
      ],
      ['references', 'reference-entry', 'appendix-heading', 'appendix-body'],
    )

    expect(result.bibliographyRegionIds).toEqual(['reference-entry'])
  })

  it('keeps title-page affiliation declaration numbers out of note relationships even when later notes reuse their labels', () => {
    const region = (
      id: string,
      page: number,
      text: string,
      y: number,
      kind: PdfPageRegion['kind'] = 'body',
      runs: PdfSourceRun[] = [],
    ): PdfPageRegion => ({
      id,
      page,
      kind,
      column: 'single',
      text,
      confidence: 1,
      box: {
        page,
        x: 0.18,
        y,
        width: 0.64,
        height: 0.014,
        rotation: 0,
        method: 'pdf-text',
      },
      lines:
        runs.length === 0
          ? []
          : [
              {
                id: `${id}-line`,
                text,
                fontSize: Math.max(...runs.map((run) => run.fontSize)),
                box: {
                  page,
                  x: 0.18,
                  y,
                  width: 0.64,
                  height: 0.014,
                  rotation: 0,
                  method: 'pdf-text',
                },
                runs,
              },
            ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })
    const affiliationRun = (
      text: string,
      x: number,
      y: number,
      fontSize: number,
    ): PdfSourceRun => ({
      page: 1,
      text,
      x,
      y,
      width: Math.max(0.006, text.length * 0.008),
      height: fontSize < 8 ? 0.009 : 0.013,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize,
      confidence: 1,
    })
    const declarations = region(
      'affiliations',
      1,
      '1 Anthropic Fellows Program 2UT Austin',
      0.2,
      'body',
      [
        affiliationRun('1', 0.18, 0.199, 7),
        affiliationRun('Anthropic Fellows Program', 0.19, 0.2, 10),
        affiliationRun('2', 0.4, 0.199, 7),
        affiliationRun('UT Austin', 0.41, 0.2, 10),
      ],
    )
    const result = classifyPdfNoteMarkers([
      region('authors', 1, 'Ada Example¹ Ben Reader²', 0.17),
      declarations,
      region('abstract', 1, 'Abstract', 0.3),
      region('note-1', 3, '1 A later, unrelated note.', 0.88, 'footnote'),
      region('note-2', 4, '2 Another later, unrelated note.', 0.88, 'footnote'),
    ])

    expect(
      result.classifications
        .filter(
          ({ referenceRegionId }) => referenceRegionId === declarations.id,
        )
        .map(({ label, taxonomy, disposition }) => ({
          label,
          taxonomy,
          disposition,
        })),
    ).toEqual([
      {
        label: '1',
        taxonomy: 'author-affiliation-superscript',
        disposition: 'plain-text',
      },
      {
        label: '2',
        taxonomy: 'author-affiliation-superscript',
        disposition: 'plain-text',
      },
    ])
  })

  it('recognizes an affiliation declaration line inside a merged author and contact region', () => {
    const line = (
      id: string,
      text: string,
      y: number,
      runs: PdfSourceRun[],
    ) => ({
      id,
      text,
      fontSize: Math.max(...runs.map((run) => run.fontSize)),
      box: {
        page: 1,
        x: 0.16,
        y,
        width: 0.68,
        height: 0.014,
        rotation: 0,
        method: 'pdf-text' as const,
      },
      runs,
    })
    const run = (
      text: string,
      x: number,
      y: number,
      fontSize = 12,
    ): PdfSourceRun => ({
      page: 1,
      text,
      x,
      y,
      width: Math.max(0.007, text.length * 0.009),
      height: fontSize < 8 ? 0.009 : 0.014,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize,
      confidence: 1,
    })
    const authorLine = line(
      'authors-line',
      'Kevin Yang1 Yuandong Tian2',
      0.156,
      [
        run('Kevin Yang', 0.24, 0.156),
        run('1', 0.34, 0.1555, 7),
        run('Yuandong Tian', 0.37, 0.156),
        run('2', 0.5, 0.1555, 7),
      ],
    )
    const declarationLine = line(
      'declaration-line',
      '1 UC Berkeley, 2Meta AI, 3UCLA',
      0.172,
      [
        run('1', 0.37, 0.1715, 7),
        run('UC Berkeley,', 0.378, 0.172),
        run('2', 0.49, 0.1715, 7),
        run('Meta AI,', 0.498, 0.172),
        run('3', 0.575, 0.1715, 7),
        run('UCLA', 0.583, 0.172),
      ],
    )
    const contactLine = line(
      'contact-line',
      'yangk@berkeley.edu,yuandong@meta.com',
      0.189,
      [run('yangk@berkeley.edu,yuandong@meta.com', 0.24, 0.189)],
    )
    const merged: PdfPageRegion = {
      id: 'merged-author-affiliation-contact',
      page: 1,
      kind: 'body',
      column: 'single',
      text: `${authorLine.text} ${declarationLine.text} ${contactLine.text}`,
      confidence: 1,
      box: {
        page: 1,
        x: 0.16,
        y: 0.1555,
        width: 0.68,
        height: 0.048,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [authorLine, declarationLine, contactLine],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    }
    const simpleRegion = (
      id: string,
      page: number,
      text: string,
      y: number,
      kind: PdfPageRegion['kind'] = 'body',
    ): PdfPageRegion => ({
      id,
      page,
      kind,
      column: 'single',
      text,
      confidence: 1,
      box: {
        page,
        x: 0.1,
        y,
        width: 0.8,
        height: 0.02,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })
    const result = classifyPdfNoteMarkers(
      [
        merged,
        simpleRegion('abstract', 1, 'Abstract', 0.3),
        simpleRegion('note-1', 1, '1 A real footnote.', 0.9, 'footnote'),
        simpleRegion('note-2', 2, '2 A later note.', 0.9, 'footnote'),
        simpleRegion('note-3', 3, '3 Another later note.', 0.9, 'footnote'),
      ],
      undefined,
      [
        {
          id: 'authors-to-declaration',
          page: 1,
          regionId: merged.id,
          fromLineId: authorLine.id,
          toLineId: declarationLine.id,
          outcome: 'space',
          evidence: ['ordinary-wrap'],
        },
        {
          id: 'declaration-to-contact',
          page: 1,
          regionId: merged.id,
          fromLineId: declarationLine.id,
          toLineId: contactLine.id,
          outcome: 'space',
          evidence: ['ordinary-wrap'],
        },
      ],
    )

    expect(
      result.classifications
        .filter(
          ({ referenceRegionId, sourceBox }) =>
            referenceRegionId === merged.id &&
            sourceBox.y >= declarationLine.box.y - 0.002,
        )
        .map(({ label, taxonomy, disposition }) => ({
          label,
          taxonomy,
          disposition,
        })),
    ).toEqual([
      {
        label: '1',
        taxonomy: 'author-affiliation-superscript',
        disposition: 'plain-text',
      },
      {
        label: '2',
        taxonomy: 'author-affiliation-superscript',
        disposition: 'plain-text',
      },
      {
        label: '3',
        taxonomy: 'author-affiliation-superscript',
        disposition: 'plain-text',
      },
    ])
  })

  it('separates a footnote symbol from an adjacent numeric affiliation marker in one rendered run', () => {
    const region = (
      id: string,
      page: number,
      text: string,
      y: number,
      kind: PdfPageRegion['kind'] = 'body',
      runs: PdfSourceRun[] = [],
    ): PdfPageRegion => ({
      id,
      page,
      kind,
      column: 'single',
      text,
      confidence: 1,
      box: {
        page,
        x: 0.18,
        y,
        width: 0.64,
        height: 0.014,
        rotation: 0,
        method: 'pdf-text',
      },
      lines:
        runs.length === 0
          ? []
          : [
              {
                id: `${id}-line`,
                text,
                fontSize: Math.max(...runs.map((run) => run.fontSize)),
                box: {
                  page,
                  x: 0.18,
                  y,
                  width: 0.64,
                  height: 0.014,
                  rotation: 0,
                  method: 'pdf-text',
                },
                runs,
              },
            ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      fontSize: number,
    ): PdfSourceRun => ({
      page: 1,
      text,
      x,
      y,
      width: Math.max(0.012, text.length * 0.01),
      height: fontSize < 8 ? 0.009 : 0.013,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize,
      confidence: 1,
    })
    const author = region('author', 1, 'Ada Example†1', 0.17, 'body', [
      sourceRun('Ada Example', 0.18, 0.171, 10),
      sourceRun('†1', 0.3, 0.168, 7),
    ])
    const result = classifyPdfNoteMarkers([
      author,
      region('affiliation', 1, '1 Constellation', 0.21, 'body', [
        sourceRun('1', 0.18, 0.207, 6),
        sourceRun('Constellation', 0.2, 0.21, 9),
      ]),
      region('abstract', 1, 'Abstract', 0.36),
      region('symbol-note', 1, '† Core contributor.', 0.88, 'footnote'),
      region('numeric-note', 3, '1 A later unrelated note.', 0.88, 'footnote'),
    ])

    expect(
      result.classifications
        .filter(({ referenceRegionId }) => referenceRegionId === author.id)
        .map(({ label, taxonomy, disposition }) => ({
          label,
          taxonomy,
          disposition,
        })),
    ).toEqual([
      {
        label: '†',
        taxonomy: 'footnote-reference',
        disposition: 'note-reference',
      },
      {
        label: '1',
        taxonomy: 'author-affiliation-superscript',
        disposition: 'plain-text',
      },
    ])
  })

  it('does not treat sub-five-point plot ticks as rendered superscript citations', () => {
    const region = (
      id: string,
      text: string,
      y: number,
      runs: PdfSourceRun[] = [],
    ): PdfPageRegion => ({
      id,
      page: 1,
      kind: 'body',
      column: 'single',
      text,
      confidence: 1,
      box: {
        page: 1,
        x: 0.2,
        y,
        width: 0.4,
        height: 0.01,
        rotation: 0,
        method: 'pdf-text',
      },
      lines:
        runs.length === 0
          ? []
          : [
              {
                id: `${id}-line`,
                text,
                fontSize: Math.max(...runs.map((run) => run.fontSize)),
                box: {
                  page: 1,
                  x: 0.2,
                  y,
                  width: 0.4,
                  height: 0.01,
                  rotation: 0,
                  method: 'pdf-text',
                },
                runs,
              },
            ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })
    const plotRun = (
      text: string,
      x: number,
      y: number,
      fontSize: number,
    ): PdfSourceRun => ({
      page: 1,
      text,
      x,
      y,
      width: text.length * 0.004,
      height: fontSize / 790,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Plot',
      fontSize,
      confidence: 1,
    })
    const plot = region(
      'plot-ticks',
      '25 Response Avg Projection20 15 10 5 0',
      0.5,
      [
        plotRun('25', 0.2, 0.497, 2.1),
        plotRun('Response Avg Projection', 0.21, 0.5, 2.9),
        plotRun('20', 0.3, 0.497, 2.1),
        plotRun('15', 0.32, 0.497, 2.1),
        plotRun('10', 0.34, 0.497, 2.1),
        plotRun('5', 0.36, 0.497, 2.1),
        plotRun('0', 0.37, 0.497, 2.1),
      ],
    )
    const result = classifyPdfNoteMarkers([
      region('body', 'Prior work [1] and later work [2] support this.', 0.2),
      region('references', 'References', 0.8),
      plot,
    ])

    expect(
      result.classifications.filter(
        ({ referenceRegionId }) => referenceRegionId === plot.id,
      ),
    ).toEqual([])
  })

  it('uses canonical column reading order to scope references that start above the left-column heading', () => {
    const region = (
      id: string,
      text: string,
      column: PdfPageRegion['column'],
      x: number,
      y: number,
    ): PdfPageRegion => ({
      id,
      page: 9,
      kind: 'body',
      column,
      text,
      confidence: 1,
      box: {
        page: 9,
        x,
        y,
        width: 0.38,
        height: 0.02,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })
    const regions = [
      region('right-entry', 'Fiotto-Kaufman, J. 2024.', 'right', 0.52, 0.08),
      region('references', 'References', 'left', 0.1, 0.22),
      region('left-entry', 'Ahn, J. 2024.', 'left', 0.1, 0.25),
    ]

    const result = classifyPdfNoteMarkers(regions, [
      'references',
      'left-entry',
      'right-entry',
    ])

    expect(result.bibliographyRegionIds).toEqual(['left-entry', 'right-entry'])
  })

  it('keeps an unpaired symbolic superscript out of the bibliography citation graph', () => {
    const region = (
      id: string,
      page: number,
      kind: PdfPageRegion['kind'],
      text: string,
    ): PdfPageRegion => ({
      id,
      page,
      kind,
      column: 'single',
      text,
      confidence: 1,
      box: {
        page,
        x: 0.1,
        y: 0.2,
        width: 0.7,
        height: 0.03,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })
    const classifications = classifyPdfNoteMarkers([
      region('body', 1, 'body', 'Prior work¹ and follow-up² annotate Table*.'),
      region('references', 2, 'body', 'References'),
    ]).classifications

    expect(
      classifications.map(({ label, taxonomy, disposition }) => ({
        label,
        taxonomy,
        disposition,
      })),
    ).toEqual([
      {
        label: '1',
        taxonomy: 'superscript-bibliography-citation',
        disposition: 'citation',
      },
      {
        label: '2',
        taxonomy: 'superscript-bibliography-citation',
        disposition: 'citation',
      },
      {
        label: '*',
        taxonomy: 'symbolic-annotation-marker',
        disposition: 'plain-text',
      },
    ])
  })

  for (const [index, fixture] of decisiveNoteMarkerFixtures.entries()) {
    it(`classifies ${fixture.name} with recorded deciding evidence`, async () => {
      const result = await reconstruct(fixture, String(index + 1))
      const diagnostics = markerDiagnostics(result)

      expect(
        diagnostics.map(
          (diagnostic) => diagnostic.noteMarkerClassification?.taxonomy,
        ),
      ).toEqual(fixture.expectedTaxonomies)
      expect(diagnostics).toHaveLength(fixture.expectedTaxonomies.length)
      expect(
        diagnostics.every(
          (diagnostic) =>
            diagnostic.severity === 'info' &&
            diagnostic.noteMarkerClassification !== undefined &&
            diagnostic.noteMarkerClassification.evidence.length > 0 &&
            diagnostic.noteMarkerClassification.threshold ===
              PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD,
        ),
      ).toBe(true)
      expect(
        result.diagnostics.filter((diagnostic) =>
          BLOCKING_NOTE_CODES.has(diagnostic.code),
        ),
      ).toEqual([])
    })
  }

  it('keeps citations and scholarly cross-references in prose without treating them as notes', async () => {
    for (const [index, fixture] of decisiveNoteMarkerFixtures
      .slice(0, 4)
      .entries()) {
      const result = await reconstruct(fixture, String(index + 1))
      expect(result.noteRelationships).toEqual([])
      expect(result.semanticSignals).toMatchObject({
        footnoteReferences: 0,
        footnotes: 0,
      })
    }
  })

  it('assigns repeated superscript glyphs to distinct geometry-ordered text ranges', async () => {
    const fixture: NoteMarkerFixture = {
      name: 'authors sharing an affiliation marker',
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: 63,
          imageCount: 0,
          runs: [
            {
              page: 1,
              text: 'Shared affiliation study',
              x: 0.1,
              y: 0.08,
              width: 0.72,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Heading',
              fontSize: 18,
              confidence: 1,
            },
            {
              page: 1,
              text: 'Ada Example',
              x: 0.1,
              y: 0.18,
              width: 0.18,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 11,
              confidence: 1,
            },
            {
              page: 1,
              text: '1',
              x: 0.2805,
              y: 0.176,
              width: 0.008,
              height: 0.009,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 6,
              confidence: 1,
            },
            {
              page: 1,
              text: ', Ben Reader',
              x: 0.29,
              y: 0.18,
              width: 0.2,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 11,
              confidence: 1,
            },
            {
              page: 1,
              text: '1',
              x: 0.4905,
              y: 0.176,
              width: 0.008,
              height: 0.009,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 6,
              confidence: 1,
            },
            {
              page: 1,
              text: 'Example University',
              x: 0.1,
              y: 0.25,
              width: 0.4,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 9,
              confidence: 1,
            },
            {
              page: 1,
              text: 'Abstract',
              x: 0.1,
              y: 0.36,
              width: 0.25,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Heading',
              fontSize: 16,
              confidence: 1,
            },
          ],
        },
      ],
      expectedTaxonomies: [
        'author-affiliation-superscript',
        'author-affiliation-superscript',
      ],
    }

    const result = await reconstruct(fixture, 'd')
    const classifications = markerDiagnostics(result).map(
      (diagnostic) => diagnostic.noteMarkerClassification!,
    )

    expect(classifications).toHaveLength(2)
    expect(classifications.map(({ taxonomy }) => taxonomy)).toEqual(
      fixture.expectedTaxonomies,
    )
    expect(classifications.map(({ start, end }) => [start, end])).toEqual([
      [11, 12],
      [24, 25],
    ])
  })

  it('keeps each marker in a reduced numeric-symbol affiliation cluster on its exact source range', async () => {
    const fixture: NoteMarkerFixture = {
      name: 'corresponding author affiliation cluster',
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: 74,
          imageCount: 0,
          runs: [
            {
              page: 1,
              text: 'Affiliation cluster study',
              x: 0.1,
              y: 0.08,
              width: 0.72,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Heading',
              fontSize: 18,
              confidence: 1,
            },
            {
              page: 1,
              text: 'Ada Example',
              x: 0.1,
              y: 0.18,
              width: 0.18,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 11,
              confidence: 1,
            },
            {
              page: 1,
              text: '1*',
              x: 0.2805,
              y: 0.176,
              width: 0.014,
              height: 0.009,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 6,
              confidence: 1,
            },
            {
              page: 1,
              text: ', Ben Reader',
              x: 0.296,
              y: 0.18,
              width: 0.2,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 11,
              confidence: 1,
            },
            {
              page: 1,
              text: '2',
              x: 0.497,
              y: 0.176,
              width: 0.008,
              height: 0.009,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 6,
              confidence: 1,
            },
            {
              page: 1,
              text: 'Example University',
              x: 0.1,
              y: 0.25,
              width: 0.4,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 9,
              confidence: 1,
            },
            {
              page: 1,
              text: 'Abstract',
              x: 0.1,
              y: 0.36,
              width: 0.25,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Heading',
              fontSize: 16,
              confidence: 1,
            },
          ],
        },
      ],
      expectedTaxonomies: [
        'author-affiliation-superscript',
        'author-affiliation-superscript',
        'author-affiliation-superscript',
      ],
    }

    const result = await reconstruct(fixture, 'e')
    const classifications = markerDiagnostics(result).map(
      (diagnostic) => diagnostic.noteMarkerClassification!,
    )

    expect(classifications).toHaveLength(3)
    expect(classifications.map(({ taxonomy }) => taxonomy)).toEqual(
      fixture.expectedTaxonomies,
    )
    expect(classifications.map(({ start, end }) => [start, end])).toEqual([
      [11, 12],
      [12, 13],
      [25, 26],
    ])
    expect(classifications[0].evidence).toContain(
      'rendered-superscript-geometry',
    )
    expect(classifications[2].evidence).toContain(
      'rendered-superscript-geometry',
    )
  })

  it('keeps numeric author affiliations distinct when a later footnote reuses the label', () => {
    const region = (
      id: string,
      text: string,
      y: number,
      kind: PdfPageRegion['kind'] = 'body',
    ): PdfPageRegion => ({
      id,
      page: 1,
      kind,
      column: 'single',
      text,
      confidence: 1,
      box: {
        page: 1,
        x: 0.1,
        y,
        width: 0.72,
        height: 0.03,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })
    const result = classifyPdfNoteMarkers([
      region('authors', 'Ada Example¹ 1 Example University', 0.18),
      region('other-authors', 'Ben Reader¹', 0.18),
      region('abstract', 'Abstract', 0.36),
      region(
        'body',
        'The body makes a separate claim¹ that needs a note.',
        0.43,
      ),
      region(
        'footnote',
        '1 This note belongs only to the body claim.',
        0.88,
        'footnote',
      ),
    ])

    expect(
      result.classifications.map(({ taxonomy, referenceRegionId }) => ({
        taxonomy,
        referenceRegionId,
      })),
    ).toEqual([
      {
        taxonomy: 'author-affiliation-superscript',
        referenceRegionId: 'authors',
      },
      {
        taxonomy: 'author-affiliation-superscript',
        referenceRegionId: 'other-authors',
      },
      { taxonomy: 'footnote-reference', referenceRegionId: 'body' },
    ])
  })

  it('materializes citation spans and bibliography targets as canonical relationships', async () => {
    const result = await reconstruct(decisiveNoteMarkerFixtures[0], '6')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        label: '1',
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
        canonicalAnchor: {
          nodeId: expect.stringMatching(/^p-/),
          start: expect.any(Number),
          end: expect.any(Number),
        },
      }),
      expect.objectContaining({
        label: '2',
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
        canonicalAnchor: {
          nodeId: expect.stringMatching(/^p-/),
          start: expect.any(Number),
          end: expect.any(Number),
        },
      }),
    ])
    const citationRuns = result.paper.nodes.flatMap((node) =>
      'inlineRuns' in node
        ? (node.inlineRuns ?? []).filter(
            (run) => run.semanticRole === 'citation',
          )
        : [],
    )
    expect(citationRuns).toHaveLength(2)
    expect(citationRuns.every((run) => run.targetIds?.length === 1)).toBe(true)
    expect(result.semanticSignals.citations).toBe(2)
    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 2,
      mappedInlineSpanCount: 2,
      inlineSpanCoverage: 1,
      expectedRelationshipCount: 2,
      resolvedRelationshipCount: 2,
      relationshipCoverage: 1,
    })
  })

  it('maps one unique exact numeric bibliography citation below the global marker-density threshold', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'unique singleton numeric bibliography citation'
    fixture.pages[0].runs[3].text = 'No second citation appears here.'
    fixture.pages[1].runs.splice(2)

    const result = await reconstruct(fixture, '1')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        label: '1',
        labels: ['1'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
        evidence: expect.arrayContaining([
          'unique-exact-bibliography-label-target',
        ]),
      }),
    ])
  })

  it('keeps the raw citation key while exposing only one replayed unresolved boundary alternate', () => {
    const heading = authorYearRegion('references', 2, ['References'], 0.12)
    const citation = authorYearRegion(
      'citation',
      1,
      ['Prior work (Hoff-', 'mann et al., 2020) establishes the baseline.'],
      0.28,
    )
    const bibliography = authorYearRegion(
      'bibliography',
      2,
      ['Hoffmann, A. (2020). Reference entry.'],
      0.24,
    )
    const classify = (
      decisions: PdfLineBoundaryDecision[],
      extraBibliography: PdfPageRegion[] = [],
    ) =>
      classifyPdfNoteMarkers(
        [citation, heading, bibliography, ...extraBibliography],
        [
          citation.id,
          heading.id,
          bibliography.id,
          ...extraBibliography.map(({ id }) => id),
        ],
        decisions,
      ).classifications.find(
        ({ taxonomy }) => taxonomy === 'author-year-bibliography-citation',
      )

    const normalized = classify([
      authorYearBoundaryDecision(citation, 'unresolved'),
    ])
    expect(normalized).toMatchObject({
      label: 'hoff-mann:2020',
      start: 'Prior work ('.length,
      end: 'Prior work ('.length + 'Hoff-mann et al., 2020'.length,
      evidence: expect.not.arrayContaining([
        'author-year-key-normalized-from-unresolved-line-boundary-hyphen',
      ]),
    })
    expect(citation.text.slice(normalized!.start, normalized!.end)).toBe(
      'Hoff-mann et al., 2020',
    )
    const surnameStart = citation.text.indexOf('Hoff-mann')
    expect(
      pdfAlternateAuthorYearKeyFromBoundary(
        citation,
        [authorYearBoundaryDecision(citation, 'unresolved')],
        'Hoff-mann',
        '2020',
        surnameStart,
      ),
    ).toBe('hoffmann:2020')
    expect(
      pdfAlternateAuthorYearKeyFromBoundary(
        citation,
        [authorYearBoundaryDecision(citation, 'ambiguous')],
        'Hoff-mann',
        '2020',
        surnameStart,
      ),
    ).toBe('hoffmann:2020')

    for (const decisions of [
      [],
      [authorYearBoundaryDecision(citation, 'preserved-lexical-hyphen')],
      [authorYearBoundaryDecision(citation, 'removed-discretionary-hyphen')],
      [
        {
          ...authorYearBoundaryDecision(citation, 'unresolved'),
          toLineId: 'nonadjacent-line',
        },
      ],
    ]) {
      expect(classify(decisions)).toMatchObject({
        label: 'hoff-mann:2020',
        evidence: expect.not.arrayContaining([
          'author-year-key-normalized-from-unresolved-line-boundary-hyphen',
        ]),
      })
      expect(
        pdfAlternateAuthorYearKeyFromBoundary(
          citation,
          decisions,
          'Hoff-mann',
          '2020',
          surnameStart,
        ),
      ).toBeNull()
    }

    const multiplySplit = authorYearRegion(
      'multiply-split-citation',
      1,
      ['Prior work (Hoff-', 'mann-', 'son et al., 2020) is relevant.'],
      0.28,
    )
    const multiplySplitSurnameStart =
      multiplySplit.text.indexOf('Hoff-mann-son')
    const multipleDecisions = [
      authorYearBoundaryDecision(multiplySplit, 'unresolved'),
      {
        ...authorYearBoundaryDecision(multiplySplit, 'ambiguous'),
        id: 'multiply-split-second-boundary',
        fromLineId: multiplySplit.lines[1].id,
        toLineId: multiplySplit.lines[2].id,
      },
    ]
    expect(
      pdfAlternateAuthorYearKeyFromBoundary(
        multiplySplit,
        multipleDecisions,
        'Hoff-mann-son',
        '2020',
        multiplySplitSurnameStart,
      ),
    ).toBeNull()
  })

  it('preserves an ordinary lexical surname hyphen in an author-year key', () => {
    const citation = authorYearRegion(
      'lexical-citation',
      1,
      ['Prior work (Smith-Jones et al., 2020) establishes the baseline.'],
      0.28,
    )
    const heading = authorYearRegion(
      'lexical-references',
      2,
      ['References'],
      0.12,
    )
    const bibliography = authorYearRegion(
      'lexical-bibliography',
      2,
      ['Smith-Jones, A. (2020). Reference entry.'],
      0.24,
    )

    expect(
      classifyPdfNoteMarkers(
        [citation, heading, bibliography],
        [citation.id, heading.id, bibliography.id],
      ).classifications.find(
        ({ taxonomy }) => taxonomy === 'author-year-bibliography-citation',
      ),
    ).toMatchObject({
      label: 'smith-jones:2020',
      evidence: expect.not.arrayContaining([
        'author-year-key-normalized-from-unresolved-line-boundary-hyphen',
      ]),
    })
  })

  it('resolves a boundary-normalized author key without changing its exact canonical anchor', async () => {
    const fixture: NoteMarkerFixture = {
      name: 'unresolved line-boundary author-year comparison key',
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: 84,
          imageCount: 0,
          runs: [
            { ...noteRun('Citation study', 0.1, 0.08, 0.72, 18), page: 1 },
            { ...noteRun('Abstract', 0.1, 0.18, 0.25, 16), page: 1 },
            { ...noteRun('Prior work (Hoff-', 0.1, 0.28, 0.72), page: 1 },
            {
              ...noteRun(
                'mann et al., 2020) establishes the baseline.',
                0.1,
                0.302,
                0.72,
              ),
              page: 1,
            },
          ],
        },
        {
          page: 2,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: 52,
          imageCount: 0,
          runs: [
            { ...noteRun('References', 0.1, 0.12, 0.3, 18), page: 2 },
            {
              ...noteRun(
                'Hoffmann, A. (2020). Reference entry.',
                0.1,
                0.24,
                0.72,
              ),
              page: 2,
            },
          ],
        },
      ],
      expectedTaxonomies: ['author-year-bibliography-citation'],
    }

    const result = await reconstruct(fixture, 'h', 'en-US')
    const [relationship] = result.citationRelationships
    const anchor = relationship.canonicalAnchor
    const owner = anchor
      ? result.paper.nodes.find((node) => node.id === anchor.nodeId)
      : undefined

    expect(relationship).toMatchObject({
      labels: ['hoff-mann:2020'],
      status: 'matched',
      targetNodeIds: [expect.stringMatching(/^p-/)],
      evidence: expect.arrayContaining([
        'author-year-key-normalized-from-unresolved-line-boundary-hyphen',
      ]),
    })
    expect(owner && 'text' in owner && anchor).toBeTruthy()
    if (!owner || !('text' in owner) || !anchor) return
    expect(owner.text.slice(anchor.start, anchor.end)).toBe(
      'Hoff-mann et al., 2020',
    )
    expect(owner.text).toContain('Hoff-mann et al., 2020')
    expect(result.lineBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: 'unresolved',
          fromLineId: expect.any(String),
          toLineId: expect.any(String),
        }),
      ]),
    )
  })

  it('maps bounded author-year citations to unique canonical reference entries', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'author-year citations with unique reference entries'
    fixture.pages[0].runs[2].text =
      'Prior work (Ahn et al., 2024; Satpute et al., 2024) establishes the baseline.'
    fixture.pages[0].runs[3].text =
      'Nanda et al. (2023a) confirms it; an unbounded 2024 mention and standalone (2024) label are plain prose.'
    fixture.pages[1].runs[1].text =
      'Ahn, J., Example, A. (2024). First reference entry.'
    fixture.pages[1].runs[2].text =
      'Satpute, A., Example, B. 2024. Second reference entry.'
    fixture.pages[1].runs.push({
      ...fixture.pages[1].runs[2],
      text: 'Nanda, N., Example, C. (2023a). Third reference entry.',
      y: 0.36,
    })

    const result = await reconstruct(fixture, 'f')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        taxonomy: 'author-year-bibliography-citation',
        labels: ['ahn:2024'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
      expect.objectContaining({
        taxonomy: 'author-year-bibliography-citation',
        labels: ['satpute:2024'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
      expect.objectContaining({
        taxonomy: 'author-year-bibliography-citation',
        labels: ['nanda:2023a'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
    ])

    const expectedMarkers = [
      'Ahn et al., 2024',
      'Satpute et al., 2024',
      'Nanda et al. (2023a)',
    ]
    for (const [
      index,
      relationship,
    ] of result.citationRelationships.entries()) {
      const anchor = relationship.canonicalAnchor
      const owner = anchor
        ? result.paper.nodes.find((node) => node.id === anchor.nodeId)
        : undefined
      expect(anchor).not.toBeNull()
      expect(owner && 'text' in owner && anchor).toBeTruthy()
      if (!owner || !('text' in owner) || !anchor) continue
      expect(owner.text.slice(anchor.start, anchor.end)).toBe(
        expectedMarkers[index],
      )
      const citationRun =
        'inlineRuns' in owner
          ? owner.inlineRuns?.find(
              (run) => run.relationshipId === relationship.id,
            )
          : undefined
      expect(citationRun).toMatchObject({
        start: anchor.start,
        end: anchor.end,
        semanticRole: 'citation',
        targetIds: relationship.targetNodeIds,
      })
      expect(result.provenance[owner.id]?.regionIds).toContain(
        relationship.referenceRegionId,
      )
    }
  })

  it('maps common single and two-author forms only for unique exact bibliography keys', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'bibliography-backed single and two-author citations'
    fixture.pages[0].runs[2].text =
      'Prior work (Smith, 2020; Brown & Lee, 2021; Clark and Evans, 2022; Missing, 2020; Jones & Reader, 2019) establishes the baseline.'
    fixture.pages[0].runs[3].text =
      'Smith (2020), Brown & Lee (2021), and Clark and Evans (2022) confirm it; Missing (2020) and Jones & Reader (2019) remain ordinary prose.'
    fixture.pages[1].runs[1].text = 'Smith, A. (2020). First reference entry.'
    fixture.pages[1].runs[2].text =
      'Brown, B., and Lee, C. 2021. Second reference entry.'
    fixture.pages[1].runs.push(
      {
        ...fixture.pages[1].runs[2],
        text: 'Clark, C., and Evans, D. (2022). Third reference entry.',
        y: 0.36,
      },
      {
        ...fixture.pages[1].runs[2],
        text: 'Jones, J., and Reader, R. (2019). First ambiguous entry.',
        y: 0.42,
      },
      {
        ...fixture.pages[1].runs[2],
        text: 'Jones, K., and Reader, R. (2019). Second ambiguous entry.',
        y: 0.48,
      },
    )

    const result = await reconstruct(fixture, 'c')

    expect(
      result.citationRelationships.map(
        ({ labels, status, targetNodeIds, canonicalAnchor }) => ({
          labels,
          status,
          targetNodeIds,
          canonicalAnchor,
        }),
      ),
    ).toEqual(
      [
        'smith:2020',
        'brown:2021',
        'clark:2022',
        'smith:2020',
        'brown:2021',
        'clark:2022',
      ].map((label) => ({
        labels: [label],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
        canonicalAnchor: {
          nodeId: expect.stringMatching(/^p-/),
          start: expect.any(Number),
          end: expect.any(Number),
        },
      })),
    )
    expect(
      result.citationRelationships.flatMap((relationship) =>
        relationship.labels.filter((label) =>
          /^(?:missing|jones):/u.test(label),
        ),
      ),
    ).toEqual([])
  })

  it('maps given-name-first bibliography entries to author-year citations', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'given-name-first author-year bibliography entries'
    fixture.pages[0].runs[2].text =
      'Prior work (Askell et al., 2021; Bai et al., 2022) establishes the baseline.'
    fixture.pages[0].runs[3].text = 'The result remains reproducible.'
    fixture.pages[1].runs[1].text =
      'Amanda Askell, Yuntao Bai, Anna Chen, and Jared Kaplan. A general language assistant as a laboratory for alignment, 2021.'
    fixture.pages[1].runs[2].text =
      'Yuntao Bai, Andy Jones, Kamal Ndousse, and Amanda Askell. Training a helpful and harmless assistant, 2022.'

    const result = await reconstruct(fixture, 'g')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['askell:2021'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
      expect.objectContaining({
        labels: ['bai:2022'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
    ])
  })

  it('does not mistake bibliography pagination for competing publication years', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'author-year bibliography entry with year-shaped pages'
    fixture.pages[0].runs[2].text =
      'Prior work (Brown et al., 2020) establishes the baseline.'
    fixture.pages[0].runs[3].text = 'The result remains reproducible.'
    fixture.pages[1].runs[1].text =
      'Tom Brown, Benjamin Mann, Nick Ryder, and Melanie Subbiah. 2020. Language models are few-shot learners. Advances in neural information processing systems, 33:1877–1901.'
    fixture.pages[1].runs.splice(2)

    const result = await reconstruct(fixture, 'y')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['brown:2020'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
    ])
  })

  it('links resolvable members of a mixed author-year cluster without hiding unresolved members', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'partially resolvable author-year citation cluster'
    fixture.pages[0].runs[2].text =
      'Prior work (Askell et al., 2021; Unknown et al., 2025) establishes the baseline.'
    fixture.pages[0].runs[3].text = 'The result remains reproducible.'
    fixture.pages[1].runs[1].text =
      'Amanda Askell, Yuntao Bai, Anna Chen, and Jared Kaplan. A general language assistant as a laboratory for alignment, 2021.'
    fixture.pages[1].runs.splice(2)

    const result = await reconstruct(fixture, 'p')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['askell:2021'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
      expect.objectContaining({
        labels: ['unknown:2025'],
        status: 'unresolved',
        targetNodeIds: [],
        evidence: expect.arrayContaining([
          'bibliography-author-year-target-missing',
        ]),
      }),
    ])
    const owner = result.paper.nodes.find(
      (node) =>
        'text' in node &&
        node.text.includes('Askell et al., 2021; Unknown et al., 2025'),
    )
    expect(owner && 'text' in owner).toBe(true)
    if (!owner || !('text' in owner)) return
    const citationRuns =
      'inlineRuns' in owner
        ? (owner.inlineRuns ?? []).filter(
            (run) => run.semanticRole === 'citation',
          )
        : []
    expect(
      citationRuns.map((run) => ({
        text: owner.text.slice(run.start, run.end),
        targets: run.targetIds ?? [],
      })),
    ).toEqual([
      {
        text: 'Askell et al., 2021',
        targets: [expect.stringMatching(/^p-/)],
      },
      { text: 'Unknown et al., 2025', targets: [] },
    ])
    for (const relationship of result.citationRelationships) {
      expect(relationship.canonicalAnchor).not.toBeNull()
      expect(
        result.provenance[relationship.canonicalAnchor!.nodeId].regionIds,
      ).toContain(relationship.referenceRegionId)
    }
  })

  it('uses the publication year before a URL instead of an arXiv identifier year', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'publication year before arxiv identifier'
    fixture.pages[0].runs[2].text =
      'Hendrycks et al. (2021a) establishes the baseline.'
    fixture.pages[0].runs[3].text = 'The result remains reproducible.'
    fixture.pages[1].runs[1].text =
      'Dan Hendrycks, Collin Burns, Steven Basart, and Jacob Steinhardt. Measuring massive multitask language understanding, 2021a. URL https://arxiv.org/abs/2009.03300.'
    fixture.pages[1].runs.splice(2)

    const result = await reconstruct(fixture, 'y')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['hendrycks:2021a'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
    ])
  })

  it('uses the publication year before a bare arXiv identifier', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'publication year before bare arxiv identifier'
    fixture.pages[0].runs[2].text =
      'Brahman et al. (2020) establishes the baseline.'
    fixture.pages[0].runs[3].text = 'The result remains reproducible.'
    fixture.pages[1].runs[1].text =
      'Faeze Brahman, Alexandru Petrusca, and Snigdha Chaturvedi. 2020. Cue me in: Content-inducing approaches to interactive story generation. arXiv preprint arXiv:2010.09935.'
    fixture.pages[1].runs.splice(2)

    const result = await reconstruct(fixture, 'x')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['brahman:2020'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
    ])
  })

  it('uses a suffixed publication year when a venue repeats its base year', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'suffixed publication years before repeated venue years'
    fixture.pages[0].runs[2].text =
      'Wang et al. (2023a) establishes the baseline.'
    fixture.pages[0].runs[3].text = 'Wang et al. (2023b) confirms the result.'
    fixture.pages[1].runs[1].text =
      'Yichen Wang, Kevin Yang, Xiaoming Liu, and Dan Klein. 2023a. Improving pacing in long-form story planning. In Findings of the Association for Computational Linguistics: EMNLP 2023.'
    fixture.pages[1].runs[2].text =
      'Yichen Wang, Kevin Yang, Xiaoming Liu, and Dan Klein. 2023b. A follow-up analysis. In Findings of the Association for Computational Linguistics: EMNLP 2023.'

    const result = await reconstruct(fixture, 'v')

    expect(
      result.citationRelationships.map(({ labels, status, targetNodeIds }) => ({
        labels,
        status,
        targetNodeIds,
      })),
    ).toEqual([
      {
        labels: ['wang:2023a'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      },
      {
        labels: ['wang:2023b'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      },
    ])
  })

  it('fails closed when multiple publication-year candidates precede the external identifier', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'ambiguous publication year candidates'
    fixture.pages[0].runs[2].text =
      'Example et al. (2021) establishes the baseline.'
    fixture.pages[0].runs[3].text = 'The result remains reproducible.'
    fixture.pages[1].runs[1].text =
      'Amanda Example, Ben Reader, and Cam Writer. A 2020 benchmark revised in 2021. URL https://example.test/paper.'
    fixture.pages[1].runs.splice(2)

    const result = await reconstruct(fixture, 'u')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['example:2021'],
        status: 'unresolved',
        targetNodeIds: [],
        evidence: expect.arrayContaining([
          'bibliography-author-year-target-missing',
        ]),
      }),
    ])
  })

  it('maps a long reference when its unique publication year follows the first 240 characters', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'long author-year reference entry'
    fixture.pages[0].runs[2].text =
      'Prior work (Biderman et al., 2023) establishes the baseline.'
    fixture.pages[0].runs[3].text = 'The result remains reproducible.'
    fixture.pages[1].runs[1].text = `Biderman, S., Example, A., and Reader, B. ${'Detailed model analysis and evaluation '.repeat(8)}PMLR, 2023. URL https://example.test/2023/paper.`
    fixture.pages[1].runs.splice(2)

    const result = await reconstruct(fixture, 'b')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['biderman:2023'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
    ])
  })

  it('leaves missing and duplicate author-year keys unresolved instead of guessing', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'ambiguous and missing author-year targets'
    fixture.pages[0].runs[2].text =
      'Prior work (Ahn et al., 2024) establishes the baseline.'
    fixture.pages[0].runs[3].text =
      'Unknown et al. (2025) reports a different result.'
    fixture.pages[1].runs[1].text =
      'Ahn, J., Example, A. (2024). First reference entry.'
    fixture.pages[1].runs[2].text =
      'Ahn, K., Example, B. (2024). Second reference entry.'

    const result = await reconstruct(fixture, 'a')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['ahn:2024'],
        status: 'unresolved',
        targetNodeIds: [],
        evidence: expect.arrayContaining([
          'bibliography-author-year-target-ambiguous',
        ]),
      }),
      expect.objectContaining({
        labels: ['unknown:2025'],
        status: 'unresolved',
        targetNodeIds: [],
        evidence: expect.arrayContaining([
          'bibliography-author-year-target-missing',
        ]),
      }),
    ])
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_CITATION_REFERENCE',
    )
    const unresolvedRuns = result.paper.nodes.flatMap((node) =>
      'inlineRuns' in node
        ? (node.inlineRuns ?? []).filter(
            (run) => run.semanticRole === 'citation',
          )
        : [],
    )
    expect(unresolvedRuns).toHaveLength(2)
    expect(unresolvedRuns.every((run) => run.targetIds === undefined)).toBe(
      true,
    )
  })

  it('targets a bracketed bibliography entry retained in a reference footnote region', async () => {
    const fixture: NoteMarkerFixture = {
      name: 'body-region bracketed bibliography entry',
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: 97,
          imageCount: 0,
          runs: [
            {
              page: 1,
              text: 'Citation study',
              x: 0.1,
              y: 0.08,
              width: 0.5,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Heading',
              fontSize: 18,
              confidence: 1,
            },
            {
              page: 1,
              text: 'Prior work [1] and later work [1] support the claim.',
              x: 0.1,
              y: 0.18,
              width: 0.7,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 11,
              confidence: 1,
            },
            {
              page: 1,
              text: 'References',
              x: 0.1,
              y: 0.42,
              width: 0.3,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Heading',
              fontSize: 16,
              confidence: 1,
            },
            {
              page: 1,
              text: '[1] Reference-footnote entry.',
              x: 0.1,
              y: 0.9,
              width: 0.72,
              height: 0.012,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 8,
              confidence: 1,
            },
          ],
        },
      ],
      expectedTaxonomies: [
        'bracketed-bibliography-citation',
        'bibliography-entry',
      ],
    }

    const result = await reconstruct(fixture, 'g')
    const bibliography = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' && node.list?.numberingId === 'references',
    )
    const citation = result.citationRelationships[0]

    expect(bibliography).toMatchObject({
      list: { markerText: '[1]', ordinal: 1, numberingId: 'references' },
    })
    expect(citation).toMatchObject({
      label: '1',
      status: 'matched',
      targetNodeIds: [bibliography!.id],
    })
  })

  it('gives distinct source-anchored IDs to citation labels that share a lossy slug', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'symbol citations with colliding marker slugs'
    fixture.pages[0].runs[2].text =
      'Prior work [*] establishes the matched baseline.'
    fixture.pages[0].runs[3].text =
      'Subsequent evidence [†] remains intentionally unresolved.'
    fixture.pages[1].runs = [
      fixture.pages[1].runs[0],
      {
        ...fixture.pages[1].runs[1],
        text: '*. Symbol bibliography entry.',
      },
    ]

    const first = await reconstruct(fixture, '1')
    const repeat = await reconstruct(fixture, '2')
    const citationClassifications = markerDiagnostics(first)
      .map((diagnostic) => diagnostic.noteMarkerClassification!)
      .filter((classification) => classification.disposition === 'citation')

    expect(citationClassifications.map(({ label }) => label)).toEqual([
      '*',
      '†',
    ])
    expect(
      citationClassifications.map(({ start, end }) => [start, end]),
    ).toEqual([
      [11, 14],
      [20, 23],
    ])
    expect(citationClassifications[0].sourceBox).not.toEqual(
      citationClassifications[1].sourceBox,
    )
    expect(new Set(citationClassifications.map(({ id }) => id))).toHaveLength(
      citationClassifications.length,
    )
    for (const classification of citationClassifications) {
      expect(classification.id).toContain(
        `-${classification.referenceRegionId}-s${String(classification.start).padStart(6, '0')}-e${String(classification.end).padStart(6, '0')}-001`,
      )
    }
    expect(
      markerDiagnostics(first).map(
        (diagnostic) => diagnostic.noteMarkerClassification!.id,
      ),
    ).toEqual(
      markerDiagnostics(repeat).map(
        (diagnostic) => diagnostic.noteMarkerClassification!.id,
      ),
    )
    expect(first.citationRelationships.map(({ status }) => status)).toEqual([
      'matched',
      'unresolved',
    ])
    expect(
      new Set(first.citationRelationships.map(({ id }) => id)),
    ).toHaveLength(first.citationRelationships.length)
    expect(first.citationRelationships.map(({ id }) => id)).toEqual(
      citationClassifications.map(({ id }) => id),
    )
  })

  it('does not resolve a citation from a same-ID run on a different canonical node', async () => {
    const result = await reconstruct(decisiveNoteMarkerFixtures[0], 'e')
    const reassess = (
      paper: typeof result.paper,
      provenance = result.provenance,
      citationRelationships = result.citationRelationships,
    ) =>
      assessPdfCompleteness({
        pages: result.pages,
        paper,
        diagnostics: [],
        regions: result.regions,
        readingOrder: result.readingOrder,
        provenance,
        visualRelationships: result.visualRelationships,
        assets: result.assets,
        citationRelationships,
        inlineSpanLedger: {
          expected: result.completeness.expectedInlineSpanCount,
          mapped: result.completeness.mappedInlineSpanCount,
        },
      })
    const expectOneUnresolvedCitation = (
      reassessed: ReturnType<typeof reassess>,
    ) => {
      expect(reassessed.completeness.unresolvedObjects.citations).toBe(1)
      expect(reassessed.completeness.resolvedRelationshipCount).toBe(1)
    }
    const paper = structuredClone(result.paper)
    const relationship = result.citationRelationships[0]
    const owner = paper.nodes.find(
      (node) =>
        'inlineRuns' in node &&
        node.inlineRuns?.some((run) => run.relationshipId === relationship.id),
    )!
    const misplacedRun =
      'inlineRuns' in owner
        ? owner.inlineRuns!.find(
            (run) => run.relationshipId === relationship.id,
          )!
        : undefined
    if ('inlineRuns' in owner) {
      owner.inlineRuns = owner.inlineRuns?.filter(
        (run) => run.relationshipId !== relationship.id,
      )
    }
    const wrongOwner = paper.nodes.find(
      (node) =>
        node.id !== owner.id &&
        (node.type === 'heading' || node.type === 'paragraph'),
    )!
    if (wrongOwner.type !== 'heading' && wrongOwner.type !== 'paragraph') {
      throw new Error('INLINE_CAPABLE_NODE_REQUIRED')
    }
    wrongOwner.inlineRuns = [...(wrongOwner.inlineRuns ?? []), misplacedRun!]
    expectOneUnresolvedCitation(reassess(paper))

    const wrongRangePaper = structuredClone(result.paper)
    const anchoredNode = wrongRangePaper.nodes.find(
      (node) => node.id === relationship.canonicalAnchor?.nodeId,
    )!
    if (anchoredNode.type !== 'heading' && anchoredNode.type !== 'paragraph') {
      throw new Error('INLINE_CAPABLE_NODE_REQUIRED')
    }
    const wrongRangeRun = anchoredNode.inlineRuns!.find(
      (run) => run.relationshipId === relationship.id,
    )!
    wrongRangeRun.start += 1
    expectOneUnresolvedCitation(reassess(wrongRangePaper))

    const wrongTargetPaper = structuredClone(result.paper)
    const wrongTargetNode = wrongTargetPaper.nodes.find(
      (node) => node.id === relationship.canonicalAnchor?.nodeId,
    )!
    if (
      wrongTargetNode.type !== 'heading' &&
      wrongTargetNode.type !== 'paragraph'
    ) {
      throw new Error('INLINE_CAPABLE_NODE_REQUIRED')
    }
    wrongTargetNode.inlineRuns!.find(
      (run) => run.relationshipId === relationship.id,
    )!.targetIds = []
    expectOneUnresolvedCitation(reassess(wrongTargetPaper))

    const wrongProvenance = structuredClone(result.provenance)
    wrongProvenance[relationship.canonicalAnchor!.nodeId].regionIds =
      wrongProvenance[relationship.canonicalAnchor!.nodeId].regionIds.filter(
        (regionId) => regionId !== relationship.referenceRegionId,
      )
    expectOneUnresolvedCitation(reassess(result.paper, wrongProvenance))

    const wrongBibliographyPaper = structuredClone(result.paper)
    const wrongBibliographyRelationships = structuredClone(
      result.citationRelationships,
    )
    const ordinaryParagraph = wrongBibliographyPaper.nodes.find(
      (node) =>
        node.type === 'paragraph' && node.list?.numberingId !== 'references',
    )!
    const wrongBibliographyRelationship = wrongBibliographyRelationships.find(
      (candidate) => candidate.id === relationship.id,
    )!
    wrongBibliographyRelationship.targetNodeIds = [ordinaryParagraph.id]
    const citationOwner = wrongBibliographyPaper.nodes.find(
      (node) => node.id === relationship.canonicalAnchor?.nodeId,
    )!
    if (
      citationOwner.type !== 'heading' &&
      citationOwner.type !== 'paragraph' &&
      citationOwner.type !== 'quote'
    ) {
      throw new Error('INLINE_CAPABLE_NODE_REQUIRED')
    }
    citationOwner.inlineRuns!.find(
      (run) => run.relationshipId === relationship.id,
    )!.targetIds = [ordinaryParagraph.id]
    expectOneUnresolvedCitation(
      reassess(
        wrongBibliographyPaper,
        result.provenance,
        wrongBibliographyRelationships,
      ),
    )
  })

  it('blocks a target-matched citation without an inline-capable canonical anchor', async () => {
    const fixture: NoteMarkerFixture = {
      name: 'front-matter citation without canonical prose anchor',
      pages: [
        {
          ...decisiveNoteMarkerFixtures[0].pages[0],
          runs: [
            decisiveNoteMarkerFixtures[0].pages[0].runs[0],
            {
              ...decisiveNoteMarkerFixtures[0].pages[0].runs[2],
              text: 'Example University [1,2]',
              y: 0.16,
            },
            {
              ...decisiveNoteMarkerFixtures[0].pages[0].runs[1],
              y: 0.24,
            },
          ],
        },
        {
          ...decisiveNoteMarkerFixtures[0].pages[1],
          runs: decisiveNoteMarkerFixtures[0].pages[1].runs,
        },
      ],
      expectedTaxonomies: [
        'bracketed-bibliography-citation',
        'bibliography-entry',
        'bibliography-entry',
      ],
    }
    const result = await reconstruct(fixture, 'f')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        status: 'matched',
        canonicalAnchor: null,
      }),
    ])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNMAPPED_CITATION_ANCHOR',
          severity: 'error',
          relationshipId: result.citationRelationships[0].id,
        }),
      ]),
    )
    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 1,
      mappedInlineSpanCount: 0,
      inlineSpanCoverage: 0,
      resolvedRelationshipCount: 0,
    })
  })

  it('expands a bounded numeric citation range to every bibliography target', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.pages[0].runs[2].text =
      'Prior work [1–3] establishes the complete baseline.'
    fixture.pages[0].runs[3].text = 'Later work confirms the result.'
    fixture.pages[1].runs.push({
      ...fixture.pages[1].runs[2],
      text: '[3] Third reference entry.',
      y: 0.36,
    })

    const result = await reconstruct(fixture, 'b')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        label: '1,2,3',
        labels: ['1', '2', '3'],
        status: 'matched',
        targetNodeIds: [
          expect.stringMatching(/^p-/),
          expect.stringMatching(/^p-/),
          expect.stringMatching(/^p-/),
        ],
      }),
    ])
    const citationRun = result.paper.nodes
      .flatMap((node) => ('inlineRuns' in node ? (node.inlineRuns ?? []) : []))
      .find((run) => run.semanticRole === 'citation')
    expect(citationRun?.targetIds).toHaveLength(3)
  })

  it('keeps a numeric citation range blocked when its middle target is missing', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.pages[0].runs[2].text =
      'Prior work [1-3] establishes the incomplete baseline.'
    fixture.pages[0].runs[3].text = 'Later work confirms the result.'
    fixture.pages[1].runs[2].text = '[3] Third reference entry.'

    const result = await reconstruct(fixture, 'c')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['1', '2', '3'],
        status: 'unresolved',
        targetNodeIds: [
          expect.stringMatching(/^p-/),
          expect.stringMatching(/^p-/),
        ],
      }),
    ])
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_CITATION_REFERENCE',
    )
  })

  it('fails closed when citation labels have no bibliography target', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.pages[1].runs[1].text = '[3] Third reference entry.'
    fixture.pages[1].runs[2].text = '[4] Fourth reference entry.'

    const result = await reconstruct(fixture, '5')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({ label: '1', status: 'unresolved' }),
      expect.objectContaining({ label: '2', status: 'unresolved' }),
    ])
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_CITATION_REFERENCE',
    )
  })

  it('preserves bibliography entries in node order instead of emitting orphaned notes', async () => {
    const fixture = decisiveNoteMarkerFixtures[1]
    const result = await reconstruct(fixture, '7')

    expect(result.paper.nodes.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'paragraph',
      'paragraph',
    ])
    expect(
      result.paper.nodes.map((node) => ('text' in node ? node.text : '')),
    ).toEqual([
      'Abstract',
      'Prior evidence¹,² supports the claim.',
      'References',
      'First citation.',
      'Second citation.',
    ])
    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'paragraph' && node.list?.numberingId === 'references'
          ? [node.list.ordinal]
          : [],
      ),
    ).toEqual([1, 2])
    expect(result.paper.nodes.some((node) => node.type === 'footnote')).toBe(
      false,
    )
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNREFERENCED_NOTE' }),
      ]),
    )
  })

  it('accepts true note relationships only at the documented threshold and retains node order', async () => {
    for (const [fixtureIndex, fixture] of decisiveNoteMarkerFixtures
      .slice(4)
      .entries()) {
      const result = await reconstruct(fixture, String(fixtureIndex + 8))
      expect(result.noteRelationships).toEqual([
        expect.objectContaining({
          status: 'matched',
          threshold: PDF_NOTE_RELATIONSHIP_THRESHOLD,
          evidence: expect.arrayContaining(['label-exact']),
        }),
      ])
      expect(result.noteRelationships[0].confidence).toBeGreaterThanOrEqual(
        result.noteRelationships[0].threshold,
      )
      const note = result.paper.nodes.find((node) => node.type === 'footnote')
      expect(note).toBeDefined()
      expect(result.paper.nodes.indexOf(note!)).toBeGreaterThan(0)
      expect(note?.relationships.backlinks).toEqual([
        result.noteRelationships[0].id,
      ])
    }
  })

  it('anchors a raised note marker with the exact joined-text offset after a removed line-end hyphen', async () => {
    const result = await reconstruct(
      {
        name: 'joined prose note offset ledger',
        pages: [
          notePage([
            noteRun(
              'A study that reconstructs wrapped scholarly prose',
              0.1,
              0.08,
              0.72,
              18,
            ),
            noteRun('The pipeline recon-', 0.1, 0.24, 0.2),
            noteRun('structs wrapped prose without losing', 0.1, 0.257, 0.2),
            noteRun('the final claim.', 0.1, 0.277, 0.25),
            noteRun('2', 0.352, 0.273, 0.008, 6, 0.009),
            noteRun('2. Exact note body.', 0.1, 0.82, 0.72, 7),
          ]),
        ],
        expectedTaxonomies: ['footnote-reference'],
      },
      'c',
      'en-US',
    )

    const relationship = result.noteRelationships.find(
      (candidate) => candidate.label === '2',
    )
    const owner = result.paper.nodes.find(
      (node) =>
        'noteReferences' in node &&
        node.noteReferences?.some(
          (reference) => reference.id === relationship?.id,
        ),
    )
    const reference =
      owner && 'noteReferences' in owner
        ? owner.noteReferences?.find(
            (candidate) => candidate.id === relationship?.id,
          )
        : undefined
    const note = result.paper.nodes.find(
      (node) => node.type === 'footnote' && node.label === '2',
    )

    expect(
      result.lineBoundaryDecisions.map(({ outcome }) => outcome),
    ).toContain('removed-discretionary-hyphen')
    expect(relationship).toMatchObject({
      status: 'matched',
      targetNoteId: note?.id,
    })
    expect(owner && 'text' in owner && reference).toBeTruthy()
    if (!owner || !('text' in owner) || !reference) return
    expect(owner.text.slice(reference.start, reference.end)).toBe('2')
    expect(
      note?.type === 'footnote' ? note.relationships.backlinks : undefined,
    ).toEqual([relationship?.id])
    expect(result.completeness.unresolvedObjects.footnoteReferences).toBe(0)
  })

  it('anchors a source-backed raised title note on its canonical title heading', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        notePage([
          noteRun('Anchored title', 0.1, 0.08, 0.5, 18),
          noteRun('2', 0.605, 0.076, 0.008, 6, 0.009),
          noteRun('Abstract', 0.1, 0.22, 0.25, 16),
          noteRun(
            'Ordinary body prose remains available to the reader.',
            0.1,
            0.32,
            0.72,
          ),
          noteRun('2. Title note body.', 0.1, 0.82, 0.72, 7),
        ]),
      ],
      metadata: { title: 'Anchored title2' },
      sourceHash: 'd'.repeat(64),
      fileName: 'front-matter-note-anchor.pdf',
      byteLength: 4096,
    })

    const relationship = result.noteRelationships.find(
      (candidate) => candidate.label === '2',
    )
    const renderedRelationshipIds = new Set([
      ...result.paper.nodes.flatMap((node) =>
        'noteReferences' in node
          ? (node.noteReferences ?? []).map((reference) => reference.id)
          : [],
      ),
      ...(result.paper.authorNotes ?? []).map((note) => note.id),
    ])
    const note = result.paper.nodes.find(
      (node) => node.type === 'footnote' && node.label === '2',
    )
    const title = result.paper.nodes.find(
      (node) => node.type === 'heading' && node.text === result.paper.title,
    )
    const titleReference =
      title?.type === 'heading'
        ? title.noteReferences?.find(
            (reference) => reference.id === relationship?.id,
          )
        : undefined
    const titleMarkerStart =
      title?.type === 'heading' ? title.text.lastIndexOf('2') : -1

    expect(relationship).toMatchObject({
      status: 'matched',
      targetNoteId: note?.id,
      canonicalAnchor: {
        kind: 'node',
        nodeId: title?.id,
        start: titleMarkerStart,
        end: titleMarkerStart + 1,
      },
    })
    expect(titleReference).toMatchObject({
      target: note?.id,
      start: titleMarkerStart,
      end: titleMarkerStart + 1,
    })
    expect(
      title?.type === 'heading' && titleReference
        ? title.text.slice(titleReference.start, titleReference.end)
        : undefined,
    ).toBe('2')
    expect(
      result.noteRelationships
        .filter((candidate) => candidate.status === 'matched')
        .every((candidate) => renderedRelationshipIds.has(candidate.id)),
    ).toBe(true)
    expect(
      note?.type === 'footnote' ? note.relationships.backlinks : undefined,
    ).toEqual([relationship?.id])
    expect(result.completeness).toMatchObject({
      expectedRelationshipCount: 1,
      resolvedRelationshipCount: 1,
      relationshipCoverage: 1,
      unresolvedObjects: {
        footnoteReferences: 0,
        footnotes: 0,
      },
    })
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_NOTE_REFERENCE',
          relationshipId: relationship?.id,
        }),
      ]),
    )
  })

  it('keeps genuinely ambiguous matches blocked below the uniqueness margin', async () => {
    const result = await reconstruct(ambiguousNoteMarkerFixture, 'a')

    expect(markerDiagnostics(result)).toEqual([
      expect.objectContaining({
        noteMarkerClassification: expect.objectContaining({
          taxonomy: 'footnote-reference',
        }),
      }),
    ])
    expect(result.noteRelationships).toEqual([
      expect.objectContaining({
        status: 'ambiguous',
        targetNoteId: null,
        threshold: PDF_NOTE_RELATIONSHIP_THRESHOLD,
      }),
    ])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AMBIGUOUS_NOTE_MATCH',
          severity: 'error',
        }),
      ]),
    )
  })

  it('still blocks genuinely orphaned note bodies', async () => {
    const result = await reconstruct(orphanedNoteFixture, 'b')

    expect(markerDiagnostics(result)).toEqual([])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNREFERENCED_NOTE',
          severity: 'error',
        }),
      ]),
    )
  })
})

import type {
  PdfNoteMarkerTaxonomy,
  PdfPageAnalysis,
  PdfSourceRun,
} from '../../src/research/import-types'

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

function page(number: number, runs: PdfSourceRun[]): PdfPageAnalysis {
  return {
    page: number,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: 0,
    runs,
  }
}

export type NoteMarkerFixture = {
  name: string
  pages: PdfPageAnalysis[]
  expectedTaxonomies: PdfNoteMarkerTaxonomy[]
}

export const decisiveNoteMarkerFixtures: NoteMarkerFixture[] = [
  {
    name: 'bracketed numeric citations with a reference-list section',
    pages: [
      page(1, [
        run(1, 'Citation study', 0.1, 0.08, 0.72, 18),
        run(1, 'Abstract', 0.1, 0.18, 0.25, 16),
        run(1, 'Prior work [1] establishes the baseline.', 0.1, 0.28, 0.72),
        run(1, 'Later work [2] confirms the result.', 0.1, 0.34, 0.72),
      ]),
      page(2, [
        run(2, 'References', 0.1, 0.12, 0.3, 18),
        run(2, '[1] First reference entry.', 0.1, 0.24, 0.72, 9),
        run(2, '[2] Second reference entry.', 0.1, 0.3, 0.72, 9),
      ]),
    ],
    expectedTaxonomies: [
      'bracketed-bibliography-citation',
      'bracketed-bibliography-citation',
      'bibliography-entry',
      'bibliography-entry',
    ],
  },
  {
    name: 'superscript citation cluster with numbered bibliography entries',
    pages: [
      page(1, [
        run(1, 'Superscript citation study', 0.1, 0.08, 0.72, 18),
        run(1, 'Abstract', 0.1, 0.18, 0.25, 16),
        run(1, 'Prior evidence¹,² supports the claim.', 0.1, 0.28, 0.72),
      ]),
      page(2, [
        run(2, 'References', 0.1, 0.12, 0.3, 18),
        run(2, '1. First citation.', 0.1, 0.72, 0.72, 9),
        run(2, '2. Second citation.', 0.1, 0.78, 0.72, 9),
      ]),
    ],
    expectedTaxonomies: [
      'superscript-citation-cluster',
      'bibliography-entry',
      'bibliography-entry',
    ],
  },
  {
    name: 'author-affiliation superscript on a title page',
    pages: [
      page(1, [
        run(1, 'Affiliation study', 0.1, 0.08, 0.72, 18),
        run(1, 'Ada Example', 0.1, 0.18, 0.2, 11),
        run(1, '1', 0.305, 0.176, 0.008, 6, 0.009),
        run(1, 'Research Institute', 0.1, 0.25, 0.4, 9),
        run(1, 'Abstract', 0.1, 0.36, 0.25, 16),
      ]),
    ],
    expectedTaxonomies: ['author-affiliation-superscript'],
  },
  {
    name: 'equation and section cross-references',
    pages: [
      page(1, [
        run(1, 'Cross-reference study', 0.1, 0.08, 0.72, 18),
        run(1, 'Abstract', 0.1, 0.18, 0.25, 16),
        run(1, 'Equation [1] defines the objective.', 0.1, 0.3, 0.72),
        run(1, 'Section [2] describes the method.', 0.1, 0.36, 0.72),
      ]),
    ],
    expectedTaxonomies: ['equation-reference', 'section-reference'],
  },
  {
    name: 'same-page footnote band',
    pages: [
      page(1, [
        run(1, 'A claim with a footnote', 0.1, 0.24, 0.32),
        run(1, '1', 0.425, 0.236, 0.008, 6, 0.009),
        run(1, '1. Same-page note body.', 0.1, 0.82, 0.72, 7),
      ]),
    ],
    expectedTaxonomies: ['footnote-reference'],
  },
  {
    name: 'end-of-document endnote section',
    pages: [
      page(1, [run(1, 'A claim has note reference 1.', 0.1, 0.24, 0.72)]),
      page(2, [
        run(2, 'Endnotes', 0.1, 0.12, 0.3, 18),
        run(2, '1. Endnote body.', 0.1, 0.24, 0.72, 9),
      ]),
    ],
    expectedTaxonomies: ['endnote-reference'],
  },
]

export const ambiguousNoteMarkerFixture: NoteMarkerFixture = {
  name: 'two equally plausible same-page notes',
  pages: [
    page(1, [
      run(1, 'Left body one.', 0.08, 0.2, 0.32),
      run(1, 'Left body two.', 0.08, 0.24, 0.32),
      run(1, 'Left body three.', 0.08, 0.28, 0.32),
      run(1, 'Right body one.', 0.56, 0.2, 0.32),
      run(1, 'Right body two.', 0.56, 0.24, 0.32),
      run(1, 'Right body three.', 0.56, 0.28, 0.32),
      run(1, 'A spanning claim has note reference 1.', 0.1, 0.42, 0.8),
      run(1, '1. Left candidate.', 0.08, 0.82, 0.32, 7),
      run(1, '1. Right candidate.', 0.56, 0.82, 0.32, 7),
    ]),
  ],
  expectedTaxonomies: ['footnote-reference'],
}

export const orphanedNoteFixture: NoteMarkerFixture = {
  name: 'genuinely orphaned note body',
  pages: [
    page(1, [
      run(1, 'Body without a note marker.', 0.1, 0.24, 0.72),
      run(1, '7. Orphaned note body.', 0.1, 0.82, 0.72, 7),
    ]),
  ],
  expectedTaxonomies: [],
}

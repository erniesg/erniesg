import type {
  PdfPageAnalysis,
  PdfSourceRun,
} from '../../src/research/import-types'

type AmbiguityClass =
  | 'two-column-with-spanning-float'
  | 'single-column-with-margin-notes'
  | 'mixed-single-two-column'
  | 'dense-reference-section'
  | 'footnote-band'

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

function page(pageNumber: number, runs: PdfSourceRun[]): PdfPageAnalysis {
  return {
    page: pageNumber,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: 0,
    runs,
  }
}

export type ScholarlyReadingOrderFixture = {
  name: string
  ambiguityClass: AmbiguityClass
  pages: PdfPageAnalysis[]
  expectedNodeText: string[]
  expectedListMarkers?: string[]
  expectedEvidence: string[]
}

export const scholarlyReadingOrderFixtures: ScholarlyReadingOrderFixture[] = [
  {
    name: 'two-column body with a spanning float',
    ambiguityClass: 'two-column-with-spanning-float',
    pages: [
      page(1, [
        run(1, 'Left above one.', 0.08, 0.2, 0.32),
        run(1, 'Right above one.', 0.56, 0.2, 0.32),
        run(1, 'Left above two.', 0.08, 0.24, 0.32),
        run(1, 'Right above two.', 0.56, 0.24, 0.32),
        run(1, 'Figure 1. A page-spanning result.', 0.12, 0.42, 0.76, 8),
      ]),
    ],
    expectedNodeText: [
      'Left above one. Left above two.',
      'Right above one. Right above two.',
      'Figure 1. A page-spanning result.',
    ],
    expectedEvidence: ['column-gutter', 'caption-proximity', 'block-adjacency'],
  },
  {
    name: 'single-column body with margin notes',
    ambiguityClass: 'single-column-with-margin-notes',
    pages: [
      page(1, [
        run(1, 'Main body one.', 0.1, 0.2, 0.56),
        run(1, 'Margin gloss one.', 0.78, 0.2, 0.14, 7),
        run(1, 'Main body two.', 0.1, 0.24, 0.56),
        run(1, 'Margin gloss two.', 0.78, 0.24, 0.14, 7),
      ]),
    ],
    expectedNodeText: ['Main body one.', 'Main body two.'],
    expectedEvidence: ['font-metrics', 'indentation-continuity'],
  },
  {
    name: 'mixed single-column and two-column pages',
    ambiguityClass: 'mixed-single-two-column',
    pages: [
      page(1, [
        run(1, 'Single-column opening one.', 0.1, 0.2, 0.72),
        run(1, 'Single-column opening two.', 0.1, 0.24, 0.72),
      ]),
      page(2, [
        run(2, 'Left continuation one.', 0.08, 0.18, 0.32),
        run(2, 'Right continuation one.', 0.56, 0.18, 0.32),
        run(2, 'Left continuation two.', 0.08, 0.22, 0.32),
        run(2, 'Right continuation two.', 0.56, 0.22, 0.32),
      ]),
    ],
    expectedNodeText: [
      'Single-column opening one. Single-column opening two.',
      'Left continuation one. Left continuation two.',
      'Right continuation one. Right continuation two.',
    ],
    expectedEvidence: ['column-gutter', 'block-adjacency'],
  },
  {
    name: 'dense two-column reference section',
    ambiguityClass: 'dense-reference-section',
    pages: [
      page(1, [
        run(1, 'References', 0.08, 0.12, 0.3, 16),
        run(1, '[1] Left reference one.', 0.08, 0.2, 0.34, 8),
        run(1, '[3] Right reference one.', 0.55, 0.2, 0.34, 8),
        run(1, '[2] Left reference two.', 0.08, 0.25, 0.34, 8),
        run(1, '[4] Right reference two.', 0.55, 0.25, 0.34, 8),
      ]),
    ],
    expectedNodeText: [
      'References',
      'Left reference one.',
      'Left reference two.',
      'Right reference one.',
      'Right reference two.',
    ],
    expectedListMarkers: ['[1]', '[2]', '[3]', '[4]'],
    expectedEvidence: ['font-metrics', 'indentation-continuity'],
  },
  {
    name: 'two-column body with a separated footnote band',
    ambiguityClass: 'footnote-band',
    pages: [
      page(1, [
        run(1, 'Left body one.', 0.08, 0.2, 0.32),
        run(1, 'Right body one.', 0.56, 0.2, 0.32),
        run(1, 'Left body two.', 0.08, 0.24, 0.32),
        run(1, 'Right body two.', 0.56, 0.24, 0.32),
        run(1, '1. First separated note.', 0.08, 0.82, 0.84, 7),
        run(1, '2. Second separated note.', 0.08, 0.85, 0.84, 7),
      ]),
    ],
    expectedNodeText: [
      'Left body one. Left body two.',
      'Right body one. Right body two.',
      'First separated note.',
      'Second separated note.',
    ],
    expectedEvidence: ['column-gutter', 'footnote-band'],
  },
]

export const belowThresholdReadingOrderFixture = page(1, [
  run(1, 'Left candidate one.', 0.08, 0.2, 0.32),
  run(1, 'Right candidate one.', 0.55, 0.2, 0.32),
  run(1, 'Indented left candidate.', 0.18, 0.7, 0.22),
  run(1, 'Right candidate two.', 0.55, 0.7, 0.32),
])

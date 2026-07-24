import { describe, expect, it } from 'vitest'
import {
  createDeterministicPredictions,
  observeDeterministicReconstruction,
  predictDeterministicCase,
} from './pdf-deterministic-eval-adapter.mjs'

const sourceBox = (page, x, y, width, height) => ({
  page,
  x,
  y,
  width,
  height,
  rotation: 0,
  method: 'pdf-text',
})

function reconstruction() {
  const headingBox = sourceBox(2, 0.51, 0.08, 0.35, 0.04)
  const proseBox = sourceBox(2, 0.51, 0.13, 0.35, 0.5)
  const noteReferenceBox = sourceBox(2, 0.44, 0.85, 0.03, 0.02)
  const noteBodyBox = sourceBox(2, 0.12, 0.89, 0.37, 0.03)
  const captionBox = sourceBox(1, 0.5, 0.52, 0.39, 0.06)
  const captionContinuationBox = sourceBox(1, 0.5, 0.58, 0.39, 0.04)
  const figureBox = sourceBox(1, 0.5, 0.22, 0.39, 0.29)
  const figureInternalTextBox = sourceBox(1, 0.56, 0.25, 0.25, 0.08)
  const orderedListBox = sourceBox(2, 0.1, 0.64, 0.3, 0.03)
  const referenceEntryBox = sourceBox(2, 0.1, 0.68, 0.34, 0.03)
  const appendixHeadingBox = sourceBox(2, 0.1, 0.72, 0.34, 0.03)
  const appendixProseBox = sourceBox(2, 0.1, 0.76, 0.34, 0.05)
  const chartTickBox = sourceBox(2, 0.47, 0.68, 0.025, 0.015)
  const equationBox = sourceBox(2, 0.12, 0.82, 0.24, 0.02)
  const equationNumberBox = sourceBox(2, 0.45, 0.82, 0.03, 0.02)
  return {
    source: {
      sha256: 'a'.repeat(64),
      byteLength: 42,
      pageCount: 2,
    },
    paper: {
      title: 'A Deterministic Paper',
      nodes: [
        { id: 'heading-node', type: 'heading', text: '3.2 Draft Module' },
        {
          id: 'ordered-list-node',
          type: 'paragraph',
          text: 'A source-backed task item for a ∈ [23, 99].',
          list: {
            level: 1,
            ordered: true,
            numberingId: 'pdf-list-p002-001',
            markerStyle: 'decimal',
            ordinal: 1,
            markerText: '1.',
          },
        },
        {
          id: 'reference-entry-node',
          type: 'paragraph',
          text: 'A source-backed bibliography entry.',
          list: {
            level: 1,
            ordered: true,
            numberingId: 'references',
            markerStyle: 'decimal',
            ordinal: 1,
            markerText: '[1]',
          },
        },
        {
          id: 'appendix-heading-node',
          type: 'heading',
          text: 'A. Additional Results',
        },
        {
          id: 'appendix-prose-node',
          type: 'paragraph',
          text: 'Appendix prose for a, b ∈ [0, 99] is outside the reference list.',
        },
        {
          id: 'chart-container-node',
          type: 'paragraph',
          text: 'A source-backed chart container.',
        },
        {
          id: 'caption-node',
          type: 'caption',
          text: 'Figure 1. Complete caption continued on another line.',
        },
        {
          id: 'table-node',
          type: 'figure',
          objectType: 'table',
          table: {
            rows: [
              {
                cells: [
                  {
                    text: 'Method',
                    headerScope: 'column',
                    columnSpan: 1,
                    rowSpan: 1,
                  },
                  {
                    text: 'Score',
                    headerScope: 'column',
                    columnSpan: 1,
                    rowSpan: 1,
                  },
                ],
              },
              {
                cells: [
                  {
                    text: 'A',
                    headerScope: null,
                    columnSpan: 1,
                    rowSpan: 1,
                  },
                  {
                    text: '1',
                    headerScope: null,
                    columnSpan: 1,
                    rowSpan: 1,
                  },
                ],
              },
            ],
          },
        },
      ],
    },
    provenance: {
      'heading-node': {
        pages: [2],
        regionIds: ['heading-region'],
        boxes: [headingBox],
      },
      'ordered-list-node': {
        pages: [2],
        regionIds: ['ordered-list-region'],
        boxes: [orderedListBox],
      },
      'reference-entry-node': {
        pages: [2],
        regionIds: ['reference-entry-region'],
        boxes: [referenceEntryBox],
      },
      'appendix-heading-node': {
        pages: [2],
        regionIds: ['appendix-heading-region'],
        boxes: [appendixHeadingBox],
      },
      'appendix-prose-node': {
        pages: [2],
        regionIds: ['appendix-prose-region'],
        boxes: [appendixProseBox],
      },
      'chart-container-node': {
        pages: [2],
        regionIds: ['chart-container-region'],
        boxes: [sourceBox(2, 0.1, 0.62, 0.4, 0.12)],
      },
      'caption-node': {
        pages: [1],
        regionIds: ['caption-region', 'caption-continuation-region'],
        boxes: [captionBox, captionContinuationBox],
      },
      'table-node': {
        pages: [2],
        boxes: [sourceBox(2, 0.19, 0.08, 0.62, 0.09)],
      },
    },
    regions: [
      {
        id: 'heading-region',
        page: 2,
        kind: 'body',
        text: '3.2 Draft Module',
        box: headingBox,
      },
      {
        id: 'prose-region',
        page: 2,
        kind: 'body',
        text: 'Prose follows the heading.',
        box: proseBox,
      },
      {
        id: 'note-reference-region',
        page: 2,
        kind: 'body',
        text: 'Source prose2',
        box: noteReferenceBox,
      },
      {
        id: 'note-body-region',
        page: 2,
        kind: 'footnote',
        text: '2 Source note.',
        box: noteBodyBox,
      },
      {
        id: 'caption-region',
        page: 1,
        kind: 'caption',
        text: 'Figure 1. Complete caption.',
        box: captionBox,
      },
      {
        id: 'caption-continuation-region',
        page: 1,
        kind: 'body',
        text: 'Caption continued on another line.',
        box: captionContinuationBox,
      },
      {
        id: 'figure-internal-region',
        page: 1,
        kind: 'body',
        text: 'Step 1: diagram instructions.',
        box: figureInternalTextBox,
      },
      {
        id: 'figure-internal-label-region',
        page: 1,
        kind: 'chart-label',
        text: '63',
        box: sourceBox(1, 0.7, 0.44, 0.02, 0.01),
      },
      {
        id: 'ordered-list-region',
        page: 2,
        kind: 'equation',
        text: '1. A source-backed task item for a ∈ [23, 99].',
        box: orderedListBox,
      },
      {
        id: 'reference-entry-region',
        page: 2,
        kind: 'endnote',
        text: '[1] A source-backed bibliography entry.',
        box: referenceEntryBox,
      },
      {
        id: 'appendix-heading-region',
        page: 2,
        kind: 'equation',
        text: 'A. Additional Results',
        box: appendixHeadingBox,
      },
      {
        id: 'appendix-prose-region',
        page: 2,
        kind: 'body',
        text: 'Appendix prose for a, b ∈ [0, 99] is outside the reference list.',
        box: appendixProseBox,
      },
      {
        id: 'chart-container-region',
        page: 2,
        kind: 'figure',
        text: '',
        box: sourceBox(2, 0.1, 0.62, 0.4, 0.12),
      },
      {
        id: 'chart-tick-region',
        page: 2,
        kind: 'chart-label',
        text: '0.5',
        box: chartTickBox,
      },
      {
        id: 'equation-region',
        page: 2,
        kind: 'equation',
        text: 'CR = m / N',
        box: equationBox,
      },
      {
        id: 'equation-number-region',
        page: 2,
        kind: 'body',
        text: '(4)',
        box: equationNumberBox,
      },
      {
        id: 'numeric-region',
        page: 1,
        kind: 'body',
        text: 'For a, b ∈ [0, 99], the result follows.',
        box: sourceBox(1, 0.1, 0.7, 0.38, 0.03),
      },
    ],
    readingOrder: {
      order: [
        'note-reference-region',
        'heading-region',
        'prose-region',
        'note-body-region',
      ],
    },
    noteRelationships: [
      {
        id: 'note-relationship',
        status: 'matched',
        referenceRegionId: 'note-reference-region',
        targetNoteId: 'note-node',
        candidates: [
          {
            targetNoteId: 'note-node',
            targetRegionId: 'note-body-region',
          },
        ],
      },
    ],
    citationRelationships: [],
    visualRelationships: [
      {
        id: 'figure-relationship',
        kind: 'figure',
        status: 'matched',
        captionRegionId: 'caption-region',
        captionNodeId: 'caption-node',
        sourceRegionIds: [
          'figure-internal-region',
          'figure-internal-label-region',
        ],
        sourceText: 'Step 1: diagram instructions. 63',
        assetIds: ['figure-asset'],
        candidates: [
          {
            sourceRegionIds: [
              'figure-internal-region',
              'figure-internal-label-region',
            ],
            score: 1,
            sourceBoxes: [
              figureBox,
              figureInternalTextBox,
              sourceBox(1, 0.7, 0.44, 0.02, 0.01),
            ],
          },
        ],
      },
      {
        id: 'equation-relationship',
        kind: 'equation',
        status: 'matched',
        captionRegionId: 'equation-region',
        sourceRegionIds: ['equation-region', 'equation-number-region'],
        sourceText: 'CR = m / N (4)',
        assetIds: ['equation-asset'],
        candidates: [],
      },
    ],
    assets: [
      {
        id: 'figure-asset',
        kind: 'raster',
        rendition: 'source-page-crop',
        sourceBoxes: [figureBox],
        sourceCropBox: figureBox,
      },
      {
        id: 'equation-asset',
        kind: 'equation',
        rendition: 'source-page-crop',
        sourceBoxes: [equationBox, equationNumberBox],
        sourceCropBox: sourceBox(2, 0.12, 0.82, 0.36, 0.02),
      },
    ],
  }
}

function evalCase(task, targets, overrides = {}) {
  return {
    id: `paper-v1.p001.${task}`,
    documentId: 'paper-v1',
    page: 1,
    stratum: `${task}-stratum`,
    task,
    targets,
    ...overrides,
  }
}

describe('deterministic PDF fidelity adapter', () => {
  it('emits generic page observations without eval targets or gold labels', () => {
    const observations = observeDeterministicReconstruction(reconstruction())

    expect(observations.pages.find(({ page }) => page === 1)).toMatchObject({
      objects: [
        {
          id: 'caption:figure-relationship',
          label: 'caption',
          box: [0.5, 0.52, 0.39, 0.1],
        },
        {
          id: 'figure-relationship',
          label: 'figure',
          box: [0.5, 0.22, 0.39, 0.29],
        },
      ],
      entities: expect.arrayContaining([
        expect.objectContaining({ label: 'caption' }),
        expect.objectContaining({ label: 'numeric-range' }),
      ]),
    })
    expect(JSON.stringify(observations)).not.toContain('figure-source-area')
  })

  it('emits all source-backed page detections with no target hint and fails closed on unresolved visuals', () => {
    const item = evalCase('detection', [])
    expect(predictDeterministicCase(item, reconstruction())).toEqual({
      objects: [
        {
          id: 'caption:figure-relationship',
          label: 'caption',
          box: [0.5, 0.52, 0.39, 0.1],
        },
        {
          id: 'figure-relationship',
          label: 'figure',
          box: [0.5, 0.22, 0.39, 0.29],
        },
      ],
    })

    const unresolved = reconstruction()
    unresolved.visualRelationships[0].status = 'unresolved'
    unresolved.visualRelationships[0].sourceRegionIds = []
    unresolved.visualRelationships[0].assetIds = []
    expect(predictDeterministicCase(item, unresolved)).toEqual({
      objects: [
        {
          id: 'caption:figure-relationship',
          label: 'caption',
          box: [0.5, 0.52, 0.39, 0.1],
        },
      ],
    })
  })

  it('projects canonical list and reference-scope roles plus numeric chart ticks by geometry', () => {
    const result = reconstruction()
    const item = evalCase(
      'classification',
      [
        { id: 'opaque-list', kind: 'candidate', box: [0.1, 0.64, 0.3, 0.03] },
        {
          id: 'opaque-reference',
          kind: 'candidate',
          box: [0.1, 0.68, 0.34, 0.03],
        },
        {
          id: 'opaque-heading',
          kind: 'candidate',
          box: [0.1, 0.72, 0.34, 0.03],
        },
        {
          id: 'opaque-prose',
          kind: 'candidate',
          box: [0.1, 0.76, 0.34, 0.05],
        },
        {
          id: 'opaque-tick',
          kind: 'candidate',
          box: [0.470001, 0.68, 0.025, 0.015],
        },
      ],
      { page: 2 },
    )

    expect(predictDeterministicCase(item, result)).toEqual({
      labels: [
        { targetId: 'opaque-list', label: 'ordered-list-item' },
        { targetId: 'opaque-reference', label: 'reference-entry' },
        { targetId: 'opaque-heading', label: 'heading' },
        { targetId: 'opaque-prose', label: 'prose' },
        { targetId: 'opaque-tick', label: 'chart-axis-tick' },
      ],
    })
  })

  it('uses complete canonical caption provenance for detection bounds', () => {
    const objects = predictDeterministicCase(
      evalCase('detection', []),
      reconstruction(),
    ).objects

    expect(objects).toContainEqual({
      id: 'caption:figure-relationship',
      label: 'caption',
      box: [0.5, 0.52, 0.39, 0.1],
    })
  })

  it('projects equation-number and nested figure-internal text ownership without semantic target hints', () => {
    const result = reconstruction()
    const equationNumber = evalCase(
      'relationship',
      [
        {
          id: 'opaque-equation',
          kind: 'candidate',
          box: [0.12, 0.82, 0.24, 0.02],
        },
        {
          id: 'opaque-number',
          kind: 'candidate',
          box: [0.45, 0.82, 0.03, 0.02],
        },
      ],
      { page: 2 },
    )
    const figureInternalText = evalCase('relationship', [
      {
        id: 'opaque-internal-text',
        kind: 'candidate',
        box: [0.560001, 0.244, 0.250002, 0.092],
      },
      {
        id: 'opaque-figure',
        kind: 'candidate',
        box: [0.5, 0.22, 0.39, 0.29],
      },
    ])

    expect(predictDeterministicCase(equationNumber, result)).toEqual({
      relationships: [
        {
          type: 'equation-number-of',
          sourceId: 'opaque-number',
          targetId: 'opaque-equation',
        },
      ],
    })
    expect(predictDeterministicCase(figureInternalText, result)).toEqual({
      relationships: [
        {
          type: 'figure-internal-text-of',
          sourceId: 'opaque-internal-text',
          targetId: 'opaque-figure',
        },
      ],
    })

    result.visualRelationships[0].status = 'unresolved'
    result.visualRelationships[0].sourceRegionIds = []
    result.visualRelationships[0].assetIds = []
    expect(predictDeterministicCase(figureInternalText, result)).toEqual({
      relationships: [
        {
          type: 'figure-internal-text-of',
          sourceId: 'opaque-internal-text',
          targetId: 'opaque-figure',
        },
      ],
    })
  })

  it('maps semantic roles from reconstruction evidence instead of target names alone', () => {
    const result = reconstruction()
    const heading = evalCase(
      'classification',
      [{ id: 'opaque-1', kind: 'candidate', box: [0.51, 0.08, 0.35, 0.04] }],
      { page: 2 },
    )
    const table = evalCase(
      'classification',
      [{ id: 'opaque-2', kind: 'candidate', box: [0.19, 0.08, 0.62, 0.09] }],
      { page: 2 },
    )
    const numericRange = evalCase(
      'classification',
      [{ id: 'opaque-3', kind: 'candidate', box: null }],
      { stratum: 'semantic-type-confusion' },
    )

    expect(predictDeterministicCase(heading, result)).toEqual({
      labels: [{ targetId: 'opaque-1', label: 'heading' }],
    })
    expect(predictDeterministicCase(table, result)).toEqual({
      labels: [{ targetId: 'opaque-2', label: 'semantic-table' }],
    })
    expect(predictDeterministicCase(numericRange, result)).toEqual({
      labels: [{ targetId: 'opaque-3', label: 'numeric-range' }],
    })
  })

  it('projects a source-proved compact math atom instead of its enclosing prose role', () => {
    const result = reconstruction()
    const atomBox = sourceBox(2, 0.71, 0.197, 0.045, 0.01)
    const lineBox = sourceBox(2, 0.51, 0.2, 0.35, 0.016)
    const text = 'The score is CP lot.'
    const atomStart = text.indexOf('P lot')
    result.paper.nodes.push({
      id: 'inline-atom-node',
      type: 'paragraph',
      text,
      inlineRuns: [
        {
          start: atomStart,
          end: atomStart + 'P lot'.length,
          italic: true,
          verticalAlign: 'superscript',
          compactMathAtom: true,
        },
      ],
    })
    result.provenance['inline-atom-node'] = {
      pages: [2],
      regionIds: ['inline-atom-region'],
      boxes: [lineBox],
    }
    result.regions.push({
      id: 'inline-atom-region',
      page: 2,
      kind: 'body',
      text,
      box: lineBox,
      lines: [
        {
          id: 'inline-atom-line',
          text,
          fontSize: 10,
          box: lineBox,
          runs: [
            {
              ...sourceBox(2, 0.51, 0.2, 0.18, 0.016),
              text: 'The score is ',
              fontName: 'Synthetic-Serif',
              fontSize: 10,
            },
            {
              ...sourceBox(2, 0.695, 0.2, 0.012, 0.016),
              text: 'C',
              fontName: 'Synthetic-CMMI10',
              fontSize: 10,
            },
            {
              ...atomBox,
              text: 'P lot',
              fontName: 'Synthetic-CMMI8',
              fontSize: 8,
            },
            {
              ...sourceBox(2, 0.757, 0.2, 0.006, 0.016),
              text: '.',
              fontName: 'Synthetic-Serif',
              fontSize: 10,
            },
          ],
        },
      ],
    })
    const item = evalCase(
      'classification',
      [
        {
          id: 'opaque-inline-atom',
          kind: 'candidate',
          box: [atomBox.x, atomBox.y, atomBox.width, atomBox.height],
        },
      ],
      { page: 2, stratum: 'opaque-inline-role' },
    )

    expect(predictDeterministicCase(item, result)).toEqual({
      labels: [
        {
          targetId: 'opaque-inline-atom',
          label: 'contiguous-token',
        },
      ],
    })
  })

  it('projects an incomplete inline equation veto instead of its generated caption role', () => {
    const result = reconstruction()
    const fragmentBox = sourceBox(1, 0.84, 0.24, 0.018, 0.014)
    result.paper.nodes.push({
      id: 'generated-fragment-caption',
      type: 'caption',
      text: 'Display equation p001-001',
    })
    result.provenance['generated-fragment-caption'] = {
      pages: [1],
      regionIds: ['inline-fragment-region'],
      boxes: [fragmentBox],
    }
    result.regions.push({
      id: 'inline-fragment-region',
      page: 1,
      kind: 'equation',
      text: '',
      box: fragmentBox,
      lines: [],
    })
    result.visualRelationships.push({
      id: 'inline-fragment-relationship',
      kind: 'equation',
      status: 'unresolved',
      captionRegionId: 'inline-fragment-region',
      captionNodeId: 'generated-fragment-caption',
      sourceRegionIds: [],
      sourceText: '',
      assetIds: [],
      evidence: ['source-equation-region', 'incomplete-equation-source-scope'],
      candidates: [
        {
          sourceRegionIds: ['inline-fragment-region'],
          sourceObjectIds: ['inline-fragment-source'],
          assetIds: [],
          score: 0.9,
          evidence: [
            'source-equation-region',
            'incomplete-equation-source-scope',
          ],
          sourceBoxes: [fragmentBox],
        },
      ],
    })
    const item = evalCase(
      'classification',
      [
        {
          id: 'opaque-inline-fragment',
          kind: 'candidate',
          box: [
            fragmentBox.x,
            fragmentBox.y,
            fragmentBox.width,
            fragmentBox.height,
          ],
        },
      ],
      { stratum: 'opaque-inline-role' },
    )

    expect(predictDeterministicCase(item, result)).toEqual({
      labels: [
        {
          targetId: 'opaque-inline-fragment',
          label: 'not-standalone-display-equation',
        },
      ],
    })
  })

  it('uses the canonical table asset boundary when provenance also contains its caption', () => {
    const result = reconstruction()
    const tableBox = sourceBox(2, 0.19, 0.08, 0.62, 0.09)
    const table = result.paper.nodes.find(({ id }) => id === 'table-node')
    table.relationships = {
      caption: 'table-caption-node',
      assets: ['semantic-table-asset'],
    }
    result.provenance['table-node'].boxes = [
      sourceBox(2, 0.19, 0.04, 0.62, 0.03),
      tableBox,
    ]
    result.assets.push({
      id: 'semantic-table-asset',
      kind: 'table',
      rendition: 'source-page-crop',
      sourceBoxes: [tableBox],
      sourceCropBox: tableBox,
    })
    result.visualRelationships.push({
      id: 'a-table-relationship',
      kind: 'table',
      status: 'matched',
      captionRegionId: 'table-caption-region',
      captionNodeId: 'table-caption-node',
      sourceRegionIds: [],
      sourceText: '',
      assetIds: ['semantic-table-asset'],
      candidates: [],
    })
    const item = evalCase(
      'classification',
      [
        {
          id: 'opaque-table',
          kind: 'candidate',
          box: [0.19, 0.08, 0.62, 0.09],
        },
      ],
      { page: 2 },
    )

    expect(predictDeterministicCase(item, result)).toEqual({
      labels: [{ targetId: 'opaque-table', label: 'semantic-table' }],
    })
  })

  it('does not call an empty or non-rectangular table payload semantic', () => {
    const item = evalCase(
      'classification',
      [
        {
          id: 'opaque-table',
          kind: 'candidate',
          box: [0.19, 0.08, 0.62, 0.09],
        },
      ],
      { page: 2 },
    )
    const empty = reconstruction()
    empty.paper.nodes.find(({ id }) => id === 'table-node').table = {}
    const ragged = reconstruction()
    ragged.paper.nodes
      .find(({ id }) => id === 'table-node')
      .table.rows[1].cells.pop()

    expect(
      predictDeterministicCase(item, empty).labels.some(
        ({ label }) => label === 'semantic-table',
      ),
    ).toBe(false)
    expect(
      predictDeterministicCase(item, ragged).labels.some(
        ({ label }) => label === 'semantic-table',
      ),
    ).toBe(false)
  })

  it('projects verified note, caption, and reading-order graph decisions onto target IDs', () => {
    const result = reconstruction()
    const note = evalCase(
      'relationship',
      [
        {
          id: 'opaque-note-reference',
          kind: 'candidate',
          box: [0.44, 0.85, 0.03, 0.02],
        },
        {
          id: 'opaque-note-body',
          kind: 'candidate',
          box: [0.12, 0.89, 0.37, 0.03],
        },
      ],
      { page: 2 },
    )
    const caption = evalCase('relationship', [
      { id: 'opaque-figure', kind: 'candidate', box: [0.5, 0.22, 0.39, 0.29] },
      { id: 'opaque-caption', kind: 'candidate', box: [0.5, 0.52, 0.39, 0.06] },
    ])
    const order = evalCase(
      'reading-order',
      [
        {
          id: 'opaque-left',
          kind: 'candidate',
          box: [0.44, 0.85, 0.03, 0.02],
        },
        {
          id: 'opaque-head',
          kind: 'candidate',
          box: [0.51, 0.08, 0.35, 0.04],
        },
        {
          id: 'opaque-prose',
          kind: 'candidate',
          box: [0.51, 0.13, 0.35, 0.5],
        },
      ],
      { page: 2 },
    )

    expect(predictDeterministicCase(note, result)).toEqual({
      relationships: [
        {
          type: 'note-body-of',
          sourceId: 'opaque-note-body',
          targetId: 'opaque-note-reference',
        },
      ],
    })
    expect(predictDeterministicCase(caption, result)).toEqual({
      relationships: [
        {
          type: 'caption-of',
          sourceId: 'opaque-caption',
          targetId: 'opaque-figure',
        },
      ],
    })
    expect(predictDeterministicCase(order, result)).toEqual({
      order: ['opaque-left', 'opaque-head', 'opaque-prose'],
    })
  })

  it('uses matched visual relationship order for figure-only reading targets', () => {
    const result = reconstruction()
    const figures = [
      { label: '15', box: sourceBox(1, 0.09, 0.09, 0.38, 0.15) },
      { label: '16', box: sourceBox(1, 0.09, 0.32, 0.38, 0.14) },
      { label: '17', box: sourceBox(1, 0.09, 0.58, 0.38, 0.23) },
      { label: '18', box: sourceBox(1, 0.502, 0.27, 0.38, 0.36) },
    ]
    result.regions.push(
      ...figures.map(({ label, box }) => ({
        id: `raw-figure-${label}`,
        page: 1,
        kind: 'figure',
        text: '',
        box,
      })),
    )
    result.readingOrder.order.push(
      'raw-figure-15',
      'raw-figure-18',
      'raw-figure-16',
      'raw-figure-17',
    )
    result.assets.push(
      ...figures.map(({ label, box }) => ({
        id: `figure-${label}-asset`,
        kind: 'raster',
        rendition: 'source-page-crop',
        sourceBoxes: [box],
        sourceCropBox: box,
      })),
    )
    result.visualRelationships = figures.map(({ label }) => ({
      id: `figure-${label}-relationship`,
      kind: 'figure',
      status: 'matched',
      captionRegionId: `figure-${label}-caption`,
      captionNodeId: `figure-${label}-caption-node`,
      sourceRegionIds: [],
      sourceText: '',
      assetIds: [`figure-${label}-asset`],
      candidates: [],
    }))
    const item = evalCase(
      'reading-order',
      figures.map(({ label, box }) => ({
        id: `opaque-figure-${label}`,
        kind: 'candidate',
        box: [box.x, box.y, box.width, box.height],
      })),
    )

    expect(predictDeterministicCase(item, result)).toEqual({
      order: [
        'opaque-figure-15',
        'opaque-figure-16',
        'opaque-figure-17',
        'opaque-figure-18',
      ],
    })
  })

  it('binds predictions to source and request identities without accepting gold fields', () => {
    const item = evalCase(
      'classification',
      [
        {
          id: 'opaque-invariant',
          kind: 'candidate',
          box: null,
        },
      ],
      { stratum: 'document-invariant' },
    )
    const request = {
      schemaVersion: '1.1.0',
      privacy: 'owner-local-paths-present-ephemeral-delete-after-run',
      evalSet: { id: 'eval-v1', sha256: 'b'.repeat(64) },
      candidate: {
        id: 'srt-deterministic',
        version: '1.0.0',
        adapterSha256: 'c'.repeat(64),
      },
      documents: [
        {
          id: 'paper-v1',
          path: '/private/paper-v1.pdf',
          byteLength: 42,
          sha256: 'a'.repeat(64),
          pageCount: 2,
        },
      ],
      cases: [item],
    }

    expect(
      createDeterministicPredictions(
        request,
        new Map([['paper-v1', reconstruction()]]),
      ),
    ).toMatchObject({
      evalSetId: 'eval-v1',
      evalSetSha256: 'b'.repeat(64),
      candidate: {
        id: 'srt-deterministic',
        version: '1.0.0',
        format: 'srt-pdf-reconstruction',
        formatVersion: '1.1.0',
        adapterSha256: 'c'.repeat(64),
        runtimeIdentity: {
          status: 'not-applicable',
          tool: null,
          model: null,
        },
      },
      cases: [
        {
          caseId: item.id,
          output: {
            labels: [
              {
                targetId: 'opaque-invariant',
                label: 'not-duplicated',
              },
            ],
          },
        },
      ],
    })

    const withGold = structuredClone(request)
    withGold.cases[0].expected = { labels: [] }
    expect(() =>
      createDeterministicPredictions(
        withGold,
        new Map([['paper-v1', reconstruction()]]),
      ),
    ).toThrow('INVALID_DETERMINISTIC_EVAL_REQUEST')

    const wrongSource = reconstruction()
    wrongSource.source.sha256 = 'd'.repeat(64)
    expect(() =>
      createDeterministicPredictions(
        request,
        new Map([['paper-v1', wrongSource]]),
      ),
    ).toThrow('SOURCE_IDENTITY_MISMATCH')
  })
})

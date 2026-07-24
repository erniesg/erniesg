import { describe, expect, it } from 'vitest'
import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfPageRegion,
  PdfVisualRelationship,
} from './import-types'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import type { ResearchPaper } from './schema'
import { createSourcePageCropAsset } from './visual-assets'

function textBox(
  x: number,
  y: number,
  width: number,
  height: number,
): NormalizedSourceBox {
  return {
    page: 1,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-text',
  }
}

function line(
  id: string,
  text: string,
  box: NormalizedSourceBox,
  fontName = 'Synthetic-CMMI12',
) {
  return {
    id,
    text,
    fontSize: 12,
    box,
    runs: [
      {
        ...box,
        text,
        fontName,
        fontSize: 12,
        confidence: 1,
      },
    ],
  } satisfies PdfPageRegion['lines'][number]
}

function region(
  id: string,
  kind: PdfPageRegion['kind'],
  lines: PdfPageRegion['lines'],
): PdfPageRegion {
  const left = Math.min(...lines.map((item) => item.box.x))
  const top = Math.min(...lines.map((item) => item.box.y))
  const right = Math.max(...lines.map((item) => item.box.x + item.box.width))
  const bottom = Math.max(...lines.map((item) => item.box.y + item.box.height))
  return {
    id,
    page: 1,
    kind,
    column: 'single',
    text: lines.map((item) => item.text).join(' '),
    confidence: 1,
    box: textBox(left, top, right - left, bottom - top),
    lines,
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

function unionBox(boxes: NormalizedSourceBox[]): NormalizedSourceBox {
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return textBox(left, top, right - left, bottom - top)
}

async function partialEquationFixture() {
  const numeratorLine = line(
    'equation-numerator-line',
    'dS_t = σ dW_t (under Q),',
    textBox(0.39, 0.49, 0.23, 0.018),
  )
  const denominatorLine = line(
    'equation-denominator-line',
    'S_t',
    textBox(0.49, 0.505, 0.025, 0.014),
  )
  const proseLine = line(
    'retained-prose-line',
    'Conceptually, this ratio gives the return process.',
    textBox(0.12, 0.55, 0.72, 0.018),
    'Synthetic-CMR12',
  )
  const equationRegion = region('equation-region', 'equation', [numeratorLine])
  const sharedBodyRegion = region('shared-body-region', 'body', [
    denominatorLine,
    proseLine,
  ])
  const visualSourceBox = unionBox([numeratorLine.box, denominatorLine.box])
  const pixels = new Uint8Array(32 * 16 * 4).fill(255)
  for (let y = 4; y < 12; y += 1) {
    for (let x = 4; x < 28; x += 1) {
      const offset = (y * 32 + x) * 4
      pixels.set([0, 0, 0, 255], offset)
    }
  }
  const asset = await createSourcePageCropAsset({
    kind: 'equation',
    cropBox: visualSourceBox,
    sourceObjectIds: ['equation-source-object'],
    sourceBoxes: [visualSourceBox],
    width: 32,
    height: 16,
    pixels,
  })
  const relationship = {
    id: 'equation-relationship',
    kind: 'equation',
    label: 'Equation 1',
    captionRegionId: equationRegion.id,
    sourceRegionIds: [equationRegion.id, sharedBodyRegion.id],
    sourceLineIds: [numeratorLine.id, denominatorLine.id],
    sourceObjectIds: ['equation-source-object'],
    assetIds: [asset.id],
    status: 'matched',
    confidence: 1,
    evidence: [
      'source-equation-region',
      'bounded-source-geometry',
      'source-page-crop',
      'source-text-transcript-unresolved',
    ],
    candidates: [],
    sourceBoxes: [numeratorLine.box, visualSourceBox],
    sourceText: '',
    altText: 'Equation 1',
    altTextSource: 'caption',
    canonicalNodeId: 'equation-node',
    captionNodeId: 'equation-caption',
  } satisfies PdfVisualRelationship
  const paper = {
    id: 'partial-equation-paper',
    version: '1.0.0',
    status: 'working',
    title: 'Partial equation ownership',
    subtitle: '',
    authors: ['Test Author'],
    updated: '2026-07-23',
    abstract: 'A source-provenance fixture.',
    nodes: [
      {
        id: 'equation-node',
        type: 'figure',
        objectType: 'equation',
        title: relationship.altText,
        relationships: {
          caption: 'equation-caption',
          assets: [asset.id],
        },
        source: 'test',
      },
      {
        id: 'equation-caption',
        type: 'caption',
        text: relationship.altText,
        source: 'test',
      },
      {
        id: 'retained-prose',
        type: 'paragraph',
        text: proseLine.text,
        source: 'test',
      },
    ],
  } satisfies ResearchPaper
  const provenance = {
    'equation-node': {
      confidence: 1,
      pages: [1],
      regionIds: [...relationship.sourceRegionIds],
      boxes: relationship.sourceBoxes.map((box) => ({ ...box })),
      links: [],
    },
    'equation-caption': {
      confidence: 1,
      pages: [1],
      regionIds: [equationRegion.id],
      boxes: [{ ...numeratorLine.box }],
      links: [],
    },
    'retained-prose': {
      confidence: 1,
      pages: [1],
      regionIds: [sharedBodyRegion.id],
      boxes: [{ ...proseLine.box }],
      links: [],
    },
  } satisfies Record<string, NodeSourceEvidence>
  return {
    asset,
    denominatorLine,
    equationRegion,
    numeratorLine,
    paper,
    proseLine,
    provenance,
    relationship,
    regions: [equationRegion, sharedBodyRegion],
    sharedBodyRegion,
  }
}

describe('PDF visual relationship line-scoped ownership', () => {
  it('retains an exact equation crop when only selected lines share a prose region', async () => {
    const fixture = await partialEquationFixture()

    expect(
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [fixture.relationship],
        assets: [fixture.asset],
        regions: fixture.regions,
      }),
    ).toEqual([fixture.relationship])
  })

  it('rejects a line-scoped equation when a competing canonical owner overlaps the selected line', async () => {
    const fixture = await partialEquationFixture()
    const provenance = {
      ...fixture.provenance,
      'retained-prose': {
        ...fixture.provenance['retained-prose'],
        boxes: [
          fixture.proseLine.box,
          {
            ...fixture.denominatorLine.box,
          },
        ],
      },
    }

    expect(
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance,
        relationships: [fixture.relationship],
        assets: [fixture.asset],
        regions: fixture.regions,
      }),
    ).toEqual([])
  })

  it('rejects missing, forged, or non-unique equation line scope', async () => {
    const fixture = await partialEquationFixture()
    const duplicateLineRegion = region('duplicate-line-region', 'body', [
      line(
        fixture.denominatorLine.id,
        'forged duplicate',
        textBox(0.15, 0.72, 0.2, 0.018),
      ),
    ])
    const cases: Array<{
      sourceLineIds: string[]
      regions: PdfPageRegion[]
    }> = [
      {
        sourceLineIds: [
          fixture.numeratorLine.id,
          'missing-equation-source-line',
        ],
        regions: fixture.regions,
      },
      {
        sourceLineIds: [fixture.numeratorLine.id, fixture.proseLine.id],
        regions: fixture.regions,
      },
      {
        sourceLineIds: [fixture.numeratorLine.id, fixture.denominatorLine.id],
        regions: [...fixture.regions, duplicateLineRegion],
      },
    ]

    for (const testCase of cases) {
      expect(
        validatedPdfVisualRelationships({
          paper: fixture.paper,
          provenance: fixture.provenance,
          relationships: [
            {
              ...fixture.relationship,
              sourceLineIds: testCase.sourceLineIds,
            },
          ],
          assets: [fixture.asset],
          regions: testCase.regions,
        }),
      ).toEqual([])
    }
  })

  it('rejects a matched equation that owns only the formula fragment of an inline stacked line', async () => {
    const fixture = await partialEquationFixture()
    const fragmentBaseId = 'page-001-inline-stacked-0001'
    const formulaLineId = `${fragmentBaseId}-formula`
    fixture.numeratorLine.id = formulaLineId
    const captionFragments = region('inline-caption-fragments', 'caption', [
      line(
        `${fragmentBaseId}-before`,
        'Caption text before',
        textBox(0.12, 0.49, 0.25, 0.018),
        'Synthetic-CMR12',
      ),
      line(
        `${fragmentBaseId}-after`,
        'and after',
        textBox(0.64, 0.49, 0.12, 0.018),
        'Synthetic-CMR12',
      ),
    ])

    expect(
      validatedPdfVisualRelationships({
        paper: fixture.paper,
        provenance: fixture.provenance,
        relationships: [
          {
            ...fixture.relationship,
            sourceLineIds: [formulaLineId, fixture.denominatorLine.id],
          },
        ],
        assets: [fixture.asset],
        regions: [...fixture.regions, captionFragments],
      }),
    ).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
} from './import-types'
import { reconstructPdfVisuals } from './pdf-visuals'

function box(x: number, y: number, width = 0.2, height = 0.1) {
  return {
    page: 1,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-object',
  } satisfies NormalizedSourceBox
}

function objectRegion(
  id: string,
  objectId: string,
  sourceBox: NormalizedSourceBox,
) {
  return {
    id,
    page: 1,
    kind: 'figure',
    column: 'single',
    text: '',
    confidence: 0.98,
    box: sourceBox,
    lines: [],
    nativeObjectIds: [objectId],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
}

function captionRegion(text: string) {
  return {
    id: 'caption-region',
    page: 1,
    kind: 'caption',
    column: 'single',
    text,
    confidence: 0.94,
    box: { ...box(0.2, 0.32, 0.5, 0.02), method: 'pdf-text' as const },
    lines: [],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
}

function page(objects: PdfPageAnalysis['objects']): PdfPageAnalysis {
  return {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: 20,
    imageCount: objects?.length ?? 0,
    objects,
    assets: [],
    runs: [],
  }
}

describe('PDF visual association graph', () => {
  it('does not claim a match when the source object has no safe rendition', async () => {
    const sourceBox = box(0.3, 0.2)
    const result = await reconstructPdfVisuals({
      pages: [
        page([
          {
            id: 'image-p001-001',
            page: 1,
            kind: 'image',
            box: sourceBox,
            confidence: 0.98,
            assetId: null,
          },
        ]),
      ],
      regions: [
        objectRegion('object-region', 'image-p001-001', sourceBox),
        captionRegion('Figure 1. Source object without a safe payload.'),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      assetIds: [],
      sourceObjectIds: [],
      candidates: [expect.objectContaining({ assetIds: [] })],
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_VISUAL_OBJECT',
          severity: 'error',
        }),
      ]),
    )
  })

  it('retains equally scored Roman-label candidates instead of guessing', async () => {
    const left = box(0.05, 0.2)
    const right = box(0.7, 0.2)
    const objects = [
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image' as const,
        box: left,
        confidence: 0.98,
        assetId: 'asset-left',
      },
      {
        id: 'image-p001-002',
        page: 1,
        kind: 'image' as const,
        box: right,
        confidence: 0.98,
        assetId: 'asset-right',
      },
    ]
    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        objectRegion('left-region', objects[0].id, left),
        objectRegion('right-region', objects[1].id, right),
        captionRegion('Figure I. Competing candidates.'),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'ambiguous',
      candidates: [
        expect.objectContaining({ score: expect.any(Number) }),
        expect.objectContaining({ score: expect.any(Number) }),
      ],
    })
  })
})

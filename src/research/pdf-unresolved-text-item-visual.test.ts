import { describe, expect, it } from 'vitest'
import type {
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
} from './import-types'
import { reconstructPdfVisuals, type PdfFigureRasterizer } from './pdf-visuals'
import { createSourcePageCropAsset } from './visual-assets'

function sourceRun({
  text,
  fontName,
}: {
  text: string
  fontName: string
}): PdfSourceRun {
  return {
    page: 1,
    text,
    x: 0.42,
    y: 0.38,
    width: 0.012,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
    fontName,
    fontSize: 12,
    sourceSequenceIndex: 7,
    confidence: 1,
  }
}

function page(renderVisibleRuns: PdfSourceRun[]): PdfPageAnalysis {
  return {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: 24,
    imageCount: 0,
    runs: [],
    renderVisibleTextRuns: renderVisibleRuns,
  }
}

function region(): PdfPageRegion {
  const textRun = sourceRun({
    text: 'q = a − b',
    fontName: 'Synthetic-CMMI12',
  })
  return {
    id: 'synthetic-inline-formula-region',
    page: 1,
    kind: 'body',
    column: 'single',
    text: textRun.text,
    confidence: 1,
    box: {
      page: 1,
      x: 0.35,
      y: 0.37,
      width: 0.22,
      height: 0.04,
      rotation: 0,
      method: 'pdf-text',
    },
    lines: [
      {
        id: 'synthetic-inline-formula-line',
        text: textRun.text,
        fontSize: textRun.fontSize,
        box: { ...textRun },
        runs: [textRun],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

describe('unresolved PDF text-item visual obligations', () => {
  it('visually owns a render-only CMEX assembly item bracketed by one proved equation line', async () => {
    const equation = region()
    const prefix = {
      ...sourceRun({
        text: 'q = (',
        fontName: 'Synthetic-CMMI12',
      }),
      x: 0.35,
      width: 0.07,
      sourceSequenceIndex: 12,
    }
    const left = {
      ...sourceRun({
        text: ')',
        fontName: 'Synthetic-CMEX10',
      }),
      x: 0.42,
      width: 0.02,
      sourceSequenceIndex: 13,
    }
    const right = {
      ...sourceRun({
        text: 'ν',
        fontName: 'Synthetic-CMMI12',
      }),
      x: 0.45,
      width: 0.02,
      sourceSequenceIndex: 15,
    }
    equation.id = 'bracketed-render-only-equation'
    equation.kind = 'equation'
    equation.text = 'q = ()ν'
    equation.box = {
      ...equation.box,
      x: 0.35,
      width: 0.12,
    }
    equation.lines[0] = {
      ...equation.lines[0],
      id: 'bracketed-render-only-equation-line',
      text: equation.text,
      box: { ...equation.box },
      runs: [prefix, left, right],
    }
    const marker = {
      ...sourceRun({
        text: '\ufffd',
        fontName: 'Synthetic-CMEX10',
      }),
      x: 0.44,
      width: 0.01,
      sourceSequenceIndex: 14,
      sourceSemanticAdmission: {
        algorithm: 'pdf-text-item-semantic-admission-v1',
        status: 'unresolved-extension-glyph',
      },
    } as PdfSourceRun
    const rasterizeFigure: PdfFigureRasterizer = async (input) =>
      createSourcePageCropAsset({
        kind: 'equation',
        cropBox: input.sourceBox,
        sourceObjectIds: input.sourceObjectIds,
        sourceBoxes: input.sourceBoxes,
        width: 64,
        height: 16,
        pixels: new Uint8Array(64 * 16 * 4).fill(72),
      })

    const result = await reconstructPdfVisuals({
      pages: [page([{ ...prefix }, { ...left }, marker, { ...right }])],
      regions: [equation],
      rasterizeFigure,
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        status: 'matched',
        evidence: expect.arrayContaining([
          'source-page-crop',
          'source-render-only-extension-glyph-owned-v1',
        ]),
        renderOnlySourceRunOwnerships: [
          expect.objectContaining({
            sourceLineId: equation.lines[0].id,
            sourceSequenceIndex: marker.sourceSequenceIndex,
            precedingSourceSequenceIndex: left.sourceSequenceIndex,
            followingSourceSequenceIndex: right.sourceSequenceIndex,
          }),
        ],
      }),
    ])
    expect(
      result.diagnostics.filter(
        (diagnostic) =>
          diagnostic.code === 'UNRESOLVED_VISUAL_OBJECT' &&
          diagnostic.sourceBoxes?.some(
            (box) =>
              box.x === marker.x &&
              box.y === marker.y &&
              box.width === marker.width &&
              box.height === marker.height,
          ),
      ),
    ).toEqual([])
  })

  it('blocks an unattested extension-font replacement marker at its exact source box', async () => {
    const marker = sourceRun({
      text: '\ufffd',
      fontName: 'Synthetic-CMEX10',
    })

    const result = await reconstructPdfVisuals({
      pages: [page([marker])],
      regions: [region()],
    })

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_VISUAL_OBJECT',
          severity: 'error',
          page: 1,
          sourceBoxes: [
            expect.objectContaining({
              x: marker.x,
              y: marker.y,
              width: marker.width,
              height: marker.height,
            }),
          ],
          target: {
            regionIds: ['synthetic-inline-formula-region'],
            markerId: null,
          },
        }),
      ]),
    )
  })

  it.each([
    {
      name: 'ordinary-font replacement text',
      run: sourceRun({
        text: '\ufffd',
        fontName: 'Synthetic-CMR12',
      }),
    },
    {
      name: 'publishable extension delimiter',
      run: sourceRun({
        text: '(',
        fontName: 'Synthetic-CMEX10',
      }),
    },
  ])('does not create this obligation for $name', async ({ run }) => {
    const result = await reconstructPdfVisuals({
      pages: [page([run])],
      regions: [region()],
    })

    expect(
      result.diagnostics.filter(
        (diagnostic) =>
          diagnostic.code === 'UNRESOLVED_VISUAL_OBJECT' &&
          (diagnostic.sourceBoxes ?? []).some(
            (sourceBox) =>
              sourceBox.x === run.x &&
              sourceBox.y === run.y &&
              sourceBox.width === run.width &&
              sourceBox.height === run.height,
          ),
      ),
    ).toEqual([])
  })
})

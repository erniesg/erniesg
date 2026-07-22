import { strFromU8 } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfVisualAsset,
} from './import-types'
import { reconstructPdfVisuals, type PdfFigureRasterizer } from './pdf-visuals'
import {
  createCompositePngAsset,
  createPngAsset,
  createSourcePageCropAsset,
  createVectorSvgAsset,
} from './visual-assets'

function box(x: number, y: number, width = 0.2, height = 0.1, page = 1) {
  return {
    page,
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
    page: sourceBox.page,
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

function captionRegion(text: string, sourceBox = box(0.2, 0.32, 0.5, 0.02)) {
  return {
    id: 'caption-region',
    page: sourceBox.page,
    kind: 'caption',
    column: 'single',
    text,
    confidence: 0.94,
    box: { ...sourceBox, method: 'pdf-text' as const },
    lines: [],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
}

function equationRegion(
  id: string,
  text: string,
  sourceBox: NormalizedSourceBox,
) {
  const textBox = { ...sourceBox, method: 'pdf-text' as const }
  return {
    id,
    page: 1,
    kind: 'equation',
    column: 'single',
    text,
    confidence: 0.93,
    box: textBox,
    lines: [
      {
        id: `${id}-line`,
        text,
        fontSize: 12,
        box: textBox,
        runs: [
          {
            ...textBox,
            text,
            fontName: 'EquationFont',
            fontSize: 12,
            confidence: 0.98,
          },
        ],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
}

function textRegion(
  id: string,
  text: string,
  sourceBox: NormalizedSourceBox,
  kind: PdfPageRegion['kind'] = 'body',
) {
  const textBox = { ...sourceBox, method: 'pdf-text' as const }
  return {
    id,
    page: textBox.page,
    kind,
    column: 'single',
    text,
    confidence: 0.99,
    box: textBox,
    lines: [
      {
        id: `${id}-line`,
        text,
        fontSize: 9,
        box: textBox,
        runs: [
          {
            ...textBox,
            text,
            fontName: 'DiagramSans',
            fontSize: 9,
            confidence: 0.99,
          },
        ],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: !['side', 'chart-label'].includes(kind),
  } satisfies PdfPageRegion
}

function page(
  objects: PdfPageAnalysis['objects'],
  pageNumber = objects?.[0]?.page ?? 1,
  assets: PdfVisualAsset[] = [],
): PdfPageAnalysis {
  return {
    page: pageNumber,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: 20,
    imageCount: objects?.length ?? 0,
    objects,
    assets,
    runs: [],
  }
}

function sourcePreservedSvgAsset(
  sourceObjectId: string,
  sourceBox: NormalizedSourceBox,
): PdfVisualAsset {
  return {
    id: `asset-${sourceObjectId}`,
    href: `assets/asset-${sourceObjectId}.svg`,
    mediaType: 'image/svg+xml',
    kind: 'vector',
    rendition: 'source-preserved',
    sha256: 'a'.repeat(64),
    bytes: new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 30"><path d="M0 0L40 0L20 30Z" fill="#c30" /></svg>',
    ),
    width: 40,
    height: 30,
    resolutionDpi: null,
    sourceObjectIds: [sourceObjectId],
    sourceBoxes: [sourceBox],
  }
}

describe('PDF visual association graph', () => {
  it('keeps a text-SVG display equation review-required without source glyph truth', async () => {
    const formula = equationRegion(
      'equation-region',
      'min E(s,a) − log π(a|s) = 0',
      box(0.24, 0.22, 0.5, 0.025),
    )
    const loweredPi = {
      ...equationRegion(
        'lowered-pi-region',
        'π',
        box(0.25, 0.242, 0.012, 0.01),
      ),
      kind: 'side' as const,
    }
    const falsePositive = equationRegion(
      'prose-region',
      'The model trained with aligned data (+RPA & CC) showed gains.',
      box(0.1, 0.32, 0.8, 0.025),
    )
    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [formula, loweredPi, falsePositive],
    })
    const repeated = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [formula, loweredPi, falsePositive],
    })

    expect(result.relationships).toHaveLength(1)
    expect(repeated.relationships).toEqual(result.relationships)
    expect(repeated.assets).toEqual(result.assets)
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'unresolved',
      captionRegionId: formula.id,
      sourceRegionIds: [],
      sourceObjectIds: [],
      assetIds: [],
      sourceText: `${formula.text} π`,
      altText: `${formula.text} π`,
      altTextSource: 'source-text',
      evidence: expect.arrayContaining(['readable-text-svg-approximation']),
    })
    expect(result.consumedRegionIds.has(formula.id)).toBe(false)
    expect(result.consumedRegionIds.has(loweredPi.id)).toBe(false)
    const asset = result.assets.find(
      (candidate) => candidate.kind === 'equation',
    )!
    expect(asset).toMatchObject({
      kind: 'equation',
      mediaType: 'image/svg+xml',
      rendition: 'bounded-svg-fallback',
      sourceObjectIds: ['equation-source-p001-001'],
      sourceBoxes: [expect.objectContaining({ page: 1 })],
    })
    const svg = strFromU8(asset.bytes)
    expect(svg).toContain('min E(s,a) − log π(a|s) = 0')
    expect(svg).toContain('>π</text>')
    expect(svg).not.toMatch(/<math\b|mathml|latex/i)

    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 8,
          height: 4,
          pixels: new Uint8Array(8 * 4 * 4).fill(96),
        }),
    )
    const cropped = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [formula, loweredPi, falsePositive],
      rasterizeFigure,
    })
    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(cropped.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'matched',
      captionRegionId: formula.id,
      sourceRegionIds: [formula.id, loweredPi.id],
      sourceObjectIds: ['equation-source-p001-001'],
      assetIds: [expect.stringMatching(/^asset-/)],
      evidence: expect.arrayContaining(['source-page-crop']),
    })
    expect(cropped.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rendition: 'source-page-crop' }),
      ]),
    )
  })

  it('does not publish styled script glyphs from a hardcoded serif text SVG', async () => {
    const formula = equationRegion(
      'equation-region',
      'E 1 = m c 2',
      box(0.4, 0.38, 0.11, 0.02),
    )
    formula.lines[0].runs = [
      {
        ...box(0.4, 0.38, 0.016, 0.019),
        method: 'pdf-text',
        text: 'E',
        fontName: 'EquationFont',
        fontSize: 15,
        confidence: 0.98,
      },
      {
        ...box(0.418, 0.394, 0.007, 0.01),
        method: 'pdf-text',
        text: '1',
        fontName: 'EquationFont',
        fontSize: 8,
        confidence: 0.98,
      },
      {
        ...box(0.434, 0.38, 0.061, 0.019),
        method: 'pdf-text',
        text: '= m c',
        fontName: 'EquationFont',
        fontSize: 15,
        confidence: 0.98,
      },
      {
        ...box(0.502, 0.377, 0.007, 0.01),
        method: 'pdf-text',
        text: '2',
        fontName: 'EquationFont',
        fontSize: 8,
        confidence: 0.98,
      },
    ]
    const printedNumber = {
      ...equationRegion('(1)-region', '(1)', box(0.82, 0.385, 0.022, 0.014)),
      kind: 'body' as const,
    }
    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [
        captionRegion(
          'Equation 1. Source-backed display equation.',
          box(0.09, 0.32, 0.53, 0.02),
        ),
        formula,
        printedNumber,
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      label: 'Equation 1',
      status: 'unresolved',
      sourceRegionIds: [],
      sourceObjectIds: [],
      assetIds: [],
      candidates: [
        expect.objectContaining({
          sourceRegionIds: [formula.id, printedNumber.id],
          assetIds: [expect.stringMatching(/^asset-/)],
          evidence: expect.arrayContaining(['readable-text-svg-approximation']),
        }),
      ],
    })
    expect(result.consumedRegionIds.has(formula.id)).toBe(false)
    expect(result.consumedRegionIds.has(printedNumber.id)).toBe(false)
  })

  it('matches a styled equation only when a bounded source raster carries its glyphs', async () => {
    const imageBox = box(0.32, 0.37, 0.36, 0.07)
    const formula = equationRegion(
      'equation-text-region',
      'E1 = m c2 (1)',
      box(0.4, 0.38, 0.2, 0.025),
    )
    formula.lines[0].runs[0].fontName = 'Math-Italic'
    const equationAsset = await createPngAsset({
      sourceObjectId: 'image-p001-equation',
      sourceBox: imageBox,
      width: 12,
      height: 4,
      colorSpace: 'rgba',
      pixels: new Uint8Array(12 * 4 * 4).fill(96),
    })
    const rasterRegion = objectRegion(
      'equation-raster-region',
      'image-p001-equation',
      imageBox,
    )

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'image-p001-equation',
              page: 1,
              kind: 'image',
              box: imageBox,
              confidence: 0.99,
              assetId: equationAsset.id,
            },
          ],
          1,
          [equationAsset],
        ),
      ],
      regions: [
        captionRegion(
          'Equation 1. A bounded source glyph raster.',
          box(0.2, 0.32, 0.5, 0.025),
        ),
        formula,
        rasterRegion,
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      label: 'Equation 1',
      status: 'matched',
      sourceRegionIds: [formula.id, rasterRegion.id],
      sourceObjectIds: ['image-p001-equation'],
      assetIds: [equationAsset.id],
      sourceText: formula.text,
      evidence: expect.arrayContaining([
        'source-glyph-raster',
        'accessible-source-text',
      ]),
    })
    expect(result.assets).toEqual([equationAsset])
    expect(result.consumedRegionIds).toEqual(
      new Set([formula.id, rasterRegion.id]),
    )
  })

  it('does not bind a nearby source-preserved logo to separate equation text', async () => {
    const logoBox = box(0.3, 0.22, 0.08, 0.04)
    const formula = equationRegion(
      'equation-text-region',
      'q = r',
      box(0.42, 0.3, 0.18, 0.025),
    )
    const logo = await createPngAsset({
      sourceObjectId: 'image-p001-logo',
      sourceBox: logoBox,
      width: 4,
      height: 4,
      colorSpace: 'rgba',
      pixels: new Uint8Array(4 * 4 * 4).fill(96),
    })

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'image-p001-logo',
              page: 1,
              kind: 'image',
              box: logoBox,
              confidence: 0.99,
              assetId: logo.id,
            },
          ],
          1,
          [logo],
        ),
      ],
      regions: [
        captionRegion(
          'Equation 1. A source-backed display equation.',
          box(0.2, 0.18, 0.5, 0.02),
        ),
        objectRegion('logo-region', 'image-p001-logo', logoBox),
        formula,
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
    })
    expect(result.relationships[0].candidates[0]).toMatchObject({
      sourceRegionIds: [formula.id],
      sourceObjectIds: ['equation-p001-001'],
      evidence: expect.arrayContaining(['readable-text-svg-approximation']),
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNREFERENCED_VISUAL_ASSET',
          sourceBoxes: [logoBox],
        }),
      ]),
    )
  })

  it('does not promote prose cross-references into visual captions', async () => {
    const crossReference = {
      ...captionRegion('Table 16 shows the comparison in the appendix.'),
      kind: 'body' as const,
    }
    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [crossReference],
    })

    expect(result.relationships).toEqual([])
    expect(result.assets).toEqual([])
  })

  it('rejects prose beneath a table caption instead of synthesizing a table', async () => {
    const prose = {
      ...captionRegion(
        'The results remain statistically significant.',
        box(0.2, 0.38, 0.5, 0.04),
      ),
      id: 'prose-region',
      kind: 'body' as const,
      lines: [
        {
          id: 'prose-line',
          text: 'The results remain statistically significant.',
          fontSize: 10,
          box: { ...box(0.2, 0.38, 0.5, 0.04), method: 'pdf-text' as const },
          runs: [],
        },
      ],
    }
    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [captionRegion('Table 5. Comparison results.'), prose],
    })

    expect(result.relationships[0]).toMatchObject({
      label: 'Table 5',
      status: 'unresolved',
      assetIds: [],
    })
    expect(result.assets).toEqual([])
  })

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

  it('does not match a dangling asset id that is absent from the asset store', async () => {
    const sourceBox = box(0.3, 0.2)
    const result = await reconstructPdfVisuals({
      pages: [
        page([
          {
            id: 'image-p001-dangling',
            page: 1,
            kind: 'image',
            box: sourceBox,
            confidence: 0.98,
            assetId: 'asset-not-in-store',
          },
        ]),
      ],
      regions: [
        objectRegion('object-region', 'image-p001-dangling', sourceBox),
        captionRegion('Figure 1. Dangling source asset.'),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
    })
    expect(result.relationships[0].candidates[0]).toMatchObject({
      sourceObjectIds: ['image-p001-dangling'],
      assetIds: ['asset-not-in-store'],
    })
  })

  it.each([
    {
      name: 'empty payload',
      asset: (sourceBox: NormalizedSourceBox) =>
        ({
          id: 'asset-empty',
          href: 'assets/asset-empty.png',
          mediaType: 'image/png',
          kind: 'raster',
          rendition: 'source-preserved',
          sha256: '0'.repeat(64),
          bytes: new Uint8Array(),
          width: 1,
          height: 1,
          resolutionDpi: null,
          sourceObjectIds: ['image-p001-invalid'],
          sourceBoxes: [sourceBox],
        }) satisfies PdfVisualAsset,
    },
    {
      name: 'foreign lineage',
      asset: (sourceBox: NormalizedSourceBox) =>
        ({
          id: 'asset-foreign-lineage',
          href: 'assets/asset-foreign-lineage.png',
          mediaType: 'image/png',
          kind: 'raster',
          rendition: 'source-preserved',
          sha256: '1'.repeat(64),
          bytes: new Uint8Array([1, 2, 3]),
          width: 1,
          height: 1,
          resolutionDpi: null,
          sourceObjectIds: ['image-p001-other'],
          sourceBoxes: [sourceBox],
        }) satisfies PdfVisualAsset,
    },
  ])('does not match a stored asset with $name', async ({ asset }) => {
    const sourceBox = box(0.3, 0.2)
    const visualAsset = asset(sourceBox)
    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'image-p001-invalid',
              page: 1,
              kind: 'image',
              box: sourceBox,
              confidence: 0.98,
              assetId: visualAsset.id,
            },
          ],
          1,
          [visualAsset],
        ),
      ],
      regions: [
        objectRegion('object-region', 'image-p001-invalid', sourceBox),
        captionRegion('Figure 1. Invalid source asset.'),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
    })
  })

  it('requires every bounded text overlay in a vector figure to reach the raster lineage', async () => {
    const sourceBox = box(0.2, 0.18, 0.5, 0.18)
    const labelBox = {
      ...box(0.34, 0.23, 0.12, 0.025),
      method: 'pdf-text' as const,
    }
    const vector = await createVectorSvgAsset({
      sourceObjectId: 'vector-p001-colored',
      sourceBox,
      path: 'M 0 0 L 40 0 L 20 30 Z',
      viewBox: { x: 0, y: 0, width: 40, height: 30 },
      paint: 'fill-stroke',
    })
    const textOverlay = textRegion(
      'chart-label-region',
      'State B',
      labelBox,
      'chart-label',
    )
    const outsideOverlay = textRegion(
      'outside-prose-region',
      'Paragraph prose overlaps the diagram edge.',
      box(0.17, 0.25, 0.03, 0.025),
    )
    const largeOverlay = textRegion(
      'large-prose-region',
      'A large non-flow label inside a loose object boundary stays separate.',
      box(0.25, 0.2, 0.4, 0.12),
      'side',
    )

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-colored',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion('vector-region', 'vector-p001-colored', sourceBox),
        textOverlay,
        outsideOverlay,
        largeOverlay,
        captionRegion(
          'Figure 1. Colored state diagram with a source label.',
          box(0.2, 0.38, 0.5, 0.025),
        ),
      ],
    })

    expect(vector.rendition).toBe('bounded-svg-fallback')
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
      candidates: [
        expect.objectContaining({
          sourceObjectIds: [
            'vector-p001-colored',
            'text-overlay:chart-label-region',
          ],
          sourceBoxes: expect.arrayContaining([sourceBox, labelBox]),
        }),
      ],
    })
    expect(result.consumedRegionIds.has(textOverlay.id)).toBe(false)
    expect(result.consumedRegionIds.has(outsideOverlay.id)).toBe(false)
    expect(result.consumedRegionIds.has(largeOverlay.id)).toBe(false)

    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 6,
          pixels: new Uint8Array(12 * 6 * 4).fill(72),
        }),
    )
    const cropped = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-colored',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion('vector-region', 'vector-p001-colored', sourceBox),
        textOverlay,
        outsideOverlay,
        largeOverlay,
        captionRegion(
          'Figure 1. Colored state diagram with a source label.',
          box(0.2, 0.38, 0.5, 0.025),
        ),
      ],
      rasterizeFigure,
    })
    expect(cropped.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        'vector-p001-colored',
        'text-overlay:chart-label-region',
      ],
      assetIds: [expect.stringMatching(/^asset-/)],
      evidence: expect.arrayContaining(['source-page-crop']),
    })
    expect(cropped.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rendition: 'source-page-crop',
          sourceObjectIds: [
            'vector-p001-colored',
            'text-overlay:chart-label-region',
          ],
        }),
      ]),
    )
    expect(cropped.consumedRegionIds.has(textOverlay.id)).toBe(true)
    expect(cropped.consumedRegionIds.has(outsideOverlay.id)).toBe(false)
    expect(cropped.consumedRegionIds.has(largeOverlay.id)).toBe(false)

    const missingOverlayLineage = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-colored',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion('vector-region', 'vector-p001-colored', sourceBox),
        textOverlay,
        outsideOverlay,
        largeOverlay,
        captionRegion(
          'Figure 1. Colored state diagram with a source label.',
          box(0.2, 0.38, 0.5, 0.025),
        ),
      ],
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: [input.sourceObjectIds[0]],
          sourceBoxes: [input.sourceBoxes[0]],
          width: 12,
          height: 6,
          pixels: new Uint8Array(12 * 6 * 4).fill(72),
        }),
    })
    expect(missingOverlayLineage.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
    })
    expect(missingOverlayLineage.consumedRegionIds.has(textOverlay.id)).toBe(
      false,
    )

    const blankCrop = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-colored',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion('vector-region', 'vector-p001-colored', sourceBox),
        textOverlay,
        outsideOverlay,
        largeOverlay,
        captionRegion(
          'Figure 1. Colored state diagram with a source label.',
          box(0.2, 0.38, 0.5, 0.025),
        ),
      ],
      rasterizeFigure: async (input) => {
        const blank = await createCompositePngAsset({
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 6,
          pixels: new Uint8Array(12 * 6 * 4).fill(255),
        })
        return {
          ...blank,
          rendition: 'source-page-crop' as const,
          sourceCropBox: input.sourceBox,
        }
      },
    })
    expect(blankCrop.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
    })
    expect(blankCrop.consumedRegionIds.has(textOverlay.id)).toBe(false)
  })

  it('never promotes reading-order text into figure overlay lineage', async () => {
    const sourceBox = box(0.15, 0.14, 0.7, 0.38)
    const vector = sourcePreservedSvgAsset(
      'vector-p001-reading-order-label',
      sourceBox,
    )
    const orderedLabel = {
      ...textRegion(
        'ordered-chart-label-region',
        'Ordered label',
        box(0.24, 0.22, 0.16, 0.025),
        'chart-label',
      ),
      includedInReadingOrder: true,
    } satisfies PdfPageRegion

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-reading-order-label',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion(
          'reading-order-vector-region',
          'vector-p001-reading-order-label',
          sourceBox,
        ),
        orderedLabel,
        captionRegion(
          'Figure 1. Diagram with an ordered text fragment.',
          box(0.15, 0.55, 0.7, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['vector-p001-reading-order-label'],
      assetIds: [vector.id],
    })
    expect(result.relationships[0].candidates[0].sourceObjectIds).toEqual([
      'vector-p001-reading-order-label',
    ])
    expect(result.consumedRegionIds.has(orderedLabel.id)).toBe(false)
  })

  it('reclaims reading-order labels only when coextensive native layers prove a caption-bounded figure', async () => {
    const firstLayerBox = box(0.12, 0.1, 0.76, 0.32)
    const secondLayerBox = box(0.121, 0.101, 0.758, 0.318)
    const firstLayer = sourcePreservedSvgAsset(
      'vector-p001-caption-scaffold-001',
      firstLayerBox,
    )
    const secondLayer = sourcePreservedSvgAsset(
      'vector-p001-caption-scaffold-002',
      secondLayerBox,
    )
    const internalLabels = textRegion(
      'ordered-internal-diagram-labels',
      'Input profile   Dialogue response   Aligned output',
      box(0.2, 0.18, 0.5, 0.035),
    )
    const internalOutcomes = textRegion(
      'ordered-internal-diagram-outcomes',
      'Local evidence   Owner checks   Final graph',
      box(0.2, 0.3, 0.5, 0.035),
    )
    const followingProse = textRegion(
      'following-prose-region',
      'Canonical prose after the figure remains in reading order.',
      box(0.12, 0.5, 0.76, 0.03),
    )
    const objects = [
      {
        id: 'vector-p001-caption-scaffold-001',
        page: 1,
        kind: 'vector' as const,
        box: firstLayerBox,
        confidence: 0.99,
        assetId: firstLayer.id,
      },
      {
        id: 'vector-p001-caption-scaffold-002',
        page: 1,
        kind: 'vector' as const,
        box: secondLayerBox,
        confidence: 0.99,
        assetId: secondLayer.id,
      },
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 20,
          height: 10,
          pixels: new Uint8Array(20 * 10 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [firstLayer, secondLayer])],
      regions: [
        objectRegion(
          'caption-scaffold-region-001',
          objects[0].id,
          firstLayerBox,
        ),
        objectRegion(
          'caption-scaffold-region-002',
          objects[1].id,
          secondLayerBox,
        ),
        internalLabels,
        internalOutcomes,
        captionRegion(
          'Figure 1. A source-native layered framework diagram.',
          box(0.12, 0.44, 0.76, 0.025),
        ),
        followingProse,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        'vector-p001-caption-scaffold-001',
        'vector-p001-caption-scaffold-002',
        'text-overlay:ordered-internal-diagram-labels',
        'text-overlay:ordered-internal-diagram-outcomes',
      ],
      evidence: expect.arrayContaining([
        'caption-bounded-native-scaffold',
        'source-page-crop',
      ]),
    })
    expect(result.consumedRegionIds.has(internalLabels.id)).toBe(true)
    expect(result.consumedRegionIds.has(internalOutcomes.id)).toBe(true)
    expect(result.consumedRegionIds.has(followingProse.id)).toBe(false)
  })

  it('uses one exact native asset while vetoing a crop across canonical prose', async () => {
    const sourceBox = box(0.15, 0.14, 0.7, 0.38)
    const vector = sourcePreservedSvgAsset(
      'vector-p001-loose-prose-scope',
      sourceBox,
    )
    const orderedProse = textRegion(
      'ordered-prose-region',
      'A small canonical paragraph fragment remains in reading order.',
      box(0.2, 0.24, 0.22, 0.025),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 6,
          pixels: new Uint8Array(12 * 6 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-loose-prose-scope',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion(
          'loose-prose-vector-region',
          'vector-p001-loose-prose-scope',
          sourceBox,
        ),
        orderedProse,
        captionRegion(
          'Figure 1. Loose native scope around canonical prose.',
          box(0.15, 0.55, 0.7, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['vector-p001-loose-prose-scope'],
      assetIds: [vector.id],
      evidence: expect.arrayContaining([
        'source-page-crop-vetoed-reading-order-text',
        'native-only-exact-rendition',
      ]),
    })
    expect(result.consumedRegionIds.has(orderedProse.id)).toBe(false)
  })

  it('uses a native-only headless composite while vetoing ordered page text', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const sourceAssets = await Promise.all(
      boxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-safe-00${index + 1}`,
          sourceBox,
          width: 2,
          height: 2,
          colorSpace: 'rgba',
          pixels: new Uint8Array(16).fill(index === 0 ? 64 : 192),
        }),
      ),
    )
    const objects = boxes.map((sourceBox, index) => ({
      id: `image-p001-safe-00${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))
    const orderedProse = textRegion(
      'ordered-composite-prose-region',
      'Canonical prose inside a loose composite scope stays in flow.',
      box(0.24, 0.2, 0.16, 0.02),
    )
    const nonFlowLabel = textRegion(
      'non-flow-composite-label-region',
      'State D',
      box(0.28, 0.24, 0.08, 0.015),
      'chart-label',
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 6,
          pixels: new Uint8Array(12 * 6 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`safe-fragment-${index + 1}`, object.id, object.box),
        ),
        orderedProse,
        nonFlowLabel,
        captionRegion(
          'Figure 1. Native-only composite near canonical prose.',
          box(0.2, 0.32, 0.25, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: ['safe-fragment-1', 'safe-fragment-2'],
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-[a-f0-9]{24}$/)],
      evidence: expect.arrayContaining([
        'source-page-crop-vetoed-reading-order-text',
        'headless-composite-raster',
      ]),
      candidates: [
        expect.objectContaining({
          sourceObjectIds: [
            ...objects.map((object) => object.id),
            'text-overlay:non-flow-composite-label-region',
          ],
        }),
      ],
    })
    const composite = result.assets.find(
      (asset) => asset.id === result.relationships[0].assetIds[0],
    )!
    expect(composite).toMatchObject({
      rendition: 'browser-composite-raster',
      sourceObjectIds: objects.map((object) => object.id),
      sourceBoxes: boxes,
    })
    expect(
      composite.sourceObjectIds.some((id) => id.startsWith('text-overlay:')),
    ).toBe(false)
    expect(result.consumedRegionIds.has(orderedProse.id)).toBe(false)
    expect(result.consumedRegionIds.has(nonFlowLabel.id)).toBe(false)
  })

  it('keeps an incomplete native fragment set unresolved without page crop', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const sourceAsset = await createPngAsset({
      sourceObjectId: 'image-p001-incomplete-001',
      sourceBox: boxes[0],
      width: 2,
      height: 2,
      colorSpace: 'rgba',
      pixels: new Uint8Array(16).fill(64),
    })
    const objects = boxes.map((sourceBox, index) => ({
      id: `image-p001-incomplete-00${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: index === 0 ? sourceAsset.id : null,
    }))
    const orderedProse = textRegion(
      'ordered-incomplete-prose-region',
      'Canonical prose cannot authorize a missing native fragment.',
      box(0.24, 0.2, 0.16, 0.02),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 6,
          pixels: new Uint8Array(12 * 6 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [sourceAsset])],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(
            `incomplete-fragment-${index + 1}`,
            object.id,
            object.box,
          ),
        ),
        orderedProse,
        captionRegion(
          'Figure 1. Incomplete native fragment set.',
          box(0.2, 0.32, 0.25, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
      evidence: expect.arrayContaining([
        'source-page-crop-vetoed-reading-order-text',
        'source-rendition-unavailable',
      ]),
    })
    expect(result.consumedRegionIds.has(orderedProse.id)).toBe(false)
  })

  it('still matches and consumes safe non-flow diagram labels', async () => {
    const sourceBox = box(0.15, 0.14, 0.7, 0.38)
    const vector = sourcePreservedSvgAsset(
      'vector-p001-non-flow-label',
      sourceBox,
    )
    const nonFlowLabel = {
      ...textRegion(
        'non-flow-chart-label-region',
        'State C',
        box(0.24, 0.22, 0.16, 0.025),
        'chart-label',
      ),
      includedInReadingOrder: false,
    } satisfies PdfPageRegion
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 6,
          pixels: new Uint8Array(12 * 6 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-non-flow-label',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion(
          'non-flow-label-vector-region',
          'vector-p001-non-flow-label',
          sourceBox,
        ),
        nonFlowLabel,
        captionRegion(
          'Figure 1. Diagram with a non-flow label.',
          box(0.15, 0.55, 0.7, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        'vector-p001-non-flow-label',
        'text-overlay:non-flow-chart-label-region',
      ],
      assetIds: [expect.stringMatching(/^asset-/)],
    })
    expect(result.consumedRegionIds.has(nonFlowLabel.id)).toBe(true)
  })

  it('clips loose source-object lineage at the caption boundary before an exact crop', async () => {
    const sourceBox = box(0.2, 0.18, 0.5, 0.23)
    const subprecisionCaptionOverlap = box(0.3, 0.379997, 0.1, 0.01)
    const vector = await createVectorSvgAsset({
      sourceObjectId: 'vector-p001-caption-overlap',
      sourceBox,
      path: 'M 0 0 L 40 0 L 20 30 Z',
      viewBox: { x: 0, y: 0, width: 40, height: 30 },
      paint: 'fill-stroke',
    })
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 12,
          height: 6,
          pixels: new Uint8Array(12 * 6 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-caption-overlap',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: vector.id,
            },
            {
              id: 'vector-p001-subprecision-overlap',
              page: 1,
              kind: 'vector',
              box: subprecisionCaptionOverlap,
              confidence: 0.98,
              assetId: null,
            },
          ],
          1,
          [vector],
        ),
      ],
      regions: [
        objectRegion('vector-region', 'vector-p001-caption-overlap', sourceBox),
        objectRegion(
          'subprecision-vector-region',
          'vector-p001-subprecision-overlap',
          subprecisionCaptionOverlap,
        ),
        captionRegion(
          'Figure 1. Caption overlaps the loose source-object box.',
          box(0.2, 0.38, 0.5, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: ['vector-region'],
      sourceObjectIds: ['vector-p001-caption-overlap'],
      assetIds: [expect.stringMatching(/^asset-/)],
      evidence: expect.arrayContaining([
        'source-lineage-clipped-to-render-scope',
        'source-page-crop',
      ]),
      candidates: [
        expect.objectContaining({
          sourceRegionIds: ['vector-region', 'subprecision-vector-region'],
          sourceObjectIds: [
            'vector-p001-caption-overlap',
            'vector-p001-subprecision-overlap',
          ],
        }),
      ],
    })
    const cropInput = rasterizeFigure.mock.calls[0]![0]
    expect(
      cropInput.sourceBox.y + cropInput.sourceBox.height,
    ).toBeLessThanOrEqual(result.relationships[0].sourceBoxes[0].y)
    expect(cropInput.sourceBoxes).toEqual([
      expect.objectContaining({
        x: sourceBox.x,
        y: sourceBox.y,
        width: sourceBox.width,
        height: expect.any(Number),
      }),
    ])
    expect(
      cropInput.sourceBoxes[0].y + cropInput.sourceBoxes[0].height,
    ).toBeLessThanOrEqual(cropInput.sourceBox.y + cropInput.sourceBox.height)
    expect(
      cropInput.sourceBoxes.every(
        (source) => source.width > 0 && source.height > 0,
      ),
    ).toBe(true)
  })

  it('records a bounded safe reason when source crop rasterization fails', async () => {
    const sourceBox = box(0.2, 0.18, 0.5, 0.12)
    const sourceAsset = sourcePreservedSvgAsset(
      'vector-p001-raster-failure',
      sourceBox,
    )
    const rasterizeFigure = vi.fn(async () => {
      throw new Error('Source page crop contains no nontrivial source ink')
    })

    const result = await reconstructPdfVisuals({
      pages: [
        page(
          [
            {
              id: 'vector-p001-raster-failure',
              page: 1,
              kind: 'vector',
              box: sourceBox,
              confidence: 0.98,
              assetId: sourceAsset.id,
            },
          ],
          1,
          [sourceAsset],
        ),
      ],
      regions: [
        objectRegion('vector-region', 'vector-p001-raster-failure', sourceBox),
        textRegion(
          'diagram-label',
          'state',
          box(0.3, 0.21, 0.06, 0.015),
          'chart-label',
        ),
        captionRegion(
          'Figure 1. Bounded source crop failure.',
          box(0.2, 0.32, 0.5, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      evidence: expect.arrayContaining([
        'source-page-crop-payload-rejected',
        'source-rendition-unavailable',
      ]),
    })
  })

  it('keeps a single large captioned vector as scientific content', async () => {
    const sourceBox = box(0.1, 0.14, 0.8, 0.5)
    const sourceAsset = sourcePreservedSvgAsset('vector-p001-001', sourceBox)
    const object = {
      id: 'vector-p001-001',
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAsset.id,
    }

    const result = await reconstructPdfVisuals({
      pages: [page([object], 1, [sourceAsset])],
      regions: [
        objectRegion('large-vector-region', object.id, sourceBox),
        captionRegion(
          'Figure 1. A full-width scientific vector diagram.',
          box(0.1, 0.66, 0.8, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [object.id],
      assetIds: [object.assetId],
    })
  })

  it('reports a single uncaptioned large vector instead of suppressing it by size', async () => {
    const sourceBox = box(0.1, 0.14, 0.8, 0.5)
    const object = {
      id: 'vector-p001-001',
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: 'asset-large-vector',
    }

    const result = await reconstructPdfVisuals({
      pages: [page([object])],
      regions: [],
    })

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNREFERENCED_VISUAL_ASSET',
        sourceBoxes: [sourceBox],
      }),
    ])
  })

  it('suppresses a large vector only when its geometry repeats across pages', async () => {
    const firstBox = box(0.05, 0.05, 0.9, 0.8, 1)
    const secondBox = box(0.05, 0.05, 0.9, 0.8, 2)
    const first = {
      id: 'vector-p001-001',
      page: 1,
      kind: 'vector' as const,
      box: firstBox,
      confidence: 0.98,
      assetId: 'asset-page-background-1',
    }
    const second = {
      ...first,
      id: 'vector-p002-001',
      page: 2,
      box: secondBox,
      assetId: 'asset-page-background-2',
    }

    const result = await reconstructPdfVisuals({
      pages: [page([first], 1), page([second], 2)],
      regions: [],
    })

    expect(result.diagnostics).toEqual([])
  })

  it('rasterizes a matched multi-object figure into one bounded asset', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const objects = boxes.map((sourceBox, index) => ({
      id: `vector-p001-00${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: null,
    }))
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 20,
          height: 10,
          pixels: new Uint8Array(20 * 10 * 4).fill(64),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`figure-fragment-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. One diagram assembled from source fragments.',
          box(0.2, 0.32, 0.51, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        sourceObjectIds: objects.map((object) => object.id),
        sourceBox: expect.objectContaining({
          x: 0.196,
          y: 0.176,
          width: 0.258,
          height: 0.128,
        }),
      }),
    )
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-/)],
      evidence: expect.arrayContaining(['source-page-crop']),
    })
    expect(result.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rendition: 'source-page-crop',
        }),
      ]),
    )
  })

  it('keeps asset-bearing fragments unresolved in headless mode without a composite', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const objects = boxes.map((sourceBox, index) => ({
      id: `vector-p001-00${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: `asset-fragment-${index + 1}`,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`figure-fragment-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. One diagram assembled from source fragments.',
          box(0.2, 0.32, 0.25, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
      candidates: [
        expect.objectContaining({
          sourceObjectIds: objects.map((object) => object.id),
          assetIds: objects.map((object) => object.assetId),
        }),
      ],
    })
    expect(result.relationships[0].evidence).toContain(
      'source-rendition-unavailable',
    )
  })

  it('composes source PNG fragments deterministically in headless mode', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const sourceAssets = await Promise.all(
      boxes.map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-00${index + 1}`,
          sourceBox,
          width: 2,
          height: 2,
          colorSpace: 'rgba',
          pixels: new Uint8Array(16).fill(index === 0 ? 64 : 192),
        }),
      ),
    )
    const objects = boxes.map((sourceBox, index) => ({
      id: `image-p001-00${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))
    const input = {
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`figure-fragment-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. One diagram assembled from source images.',
          box(0.2, 0.32, 0.25, 0.025),
        ),
      ],
    }

    const first = await reconstructPdfVisuals(input)
    const second = await reconstructPdfVisuals(input)

    expect(second.relationships).toEqual(first.relationships)
    expect(second.assets).toEqual(first.assets)
    expect(first.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-[a-f0-9]{24}$/)],
      evidence: expect.arrayContaining(['headless-composite-raster']),
    })
    const composite = first.assets.find(
      (asset) => asset.id === first.relationships[0].assetIds[0],
    )!
    expect(composite).toMatchObject({
      mediaType: 'image/png',
      kind: 'raster',
      rendition: 'browser-composite-raster',
      sourceObjectIds: objects.map((object) => object.id),
      sourceBoxes: boxes,
    })
    expect([...composite.bytes.subarray(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ])
  })

  it('composes mixed preserved image and vector fragments into one bounded SVG', async () => {
    const boxes = [box(0.2, 0.18, 0.12, 0.12), box(0.33, 0.18, 0.12, 0.12)]
    const raster = await createPngAsset({
      sourceObjectId: 'image-p001-001',
      sourceBox: boxes[0],
      width: 2,
      height: 2,
      colorSpace: 'rgba',
      pixels: new Uint8Array(16).fill(255),
    })
    const vector = sourcePreservedSvgAsset('vector-p001-001', boxes[1])
    const sourceAssets = [raster, vector]
    const objects = [
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image' as const,
        box: boxes[0],
        confidence: 0.98,
        assetId: raster.id,
      },
      {
        id: 'vector-p001-001',
        page: 1,
        kind: 'vector' as const,
        box: boxes[1],
        confidence: 0.98,
        assetId: vector.id,
      },
    ]

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`figure-fragment-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. Mixed source-backed fragments.',
          box(0.2, 0.32, 0.25, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-[a-f0-9]{24}$/)],
      evidence: expect.arrayContaining(['headless-composite-svg']),
    })
    const composite = result.assets.find(
      (asset) => asset.id === result.relationships[0].assetIds[0],
    )!
    expect(composite).toMatchObject({
      mediaType: 'image/svg+xml',
      kind: 'vector',
      rendition: 'source-preserved',
      sourceObjectIds: objects.map((object) => object.id),
      sourceBoxes: boxes,
    })
    const svg = strFromU8(composite.bytes)
    expect(svg).toContain('data-pdf-composite="true"')
    expect(svg).toContain('href="data:image/png;base64,')
    expect(svg).toContain('href="data:image/svg+xml;base64,')
    expect(svg).not.toContain(raster.href)
    expect(svg).not.toContain(vector.href)
  })

  it('retains a broad vector scaffold when it binds disconnected source fragments', async () => {
    const scaffold = box(0.05, 0.1, 0.9, 0.42)
    const fragmentBoxes = [
      box(0.1, 0.15, 0.05, 0.04),
      box(0.32, 0.23, 0.05, 0.04),
      box(0.58, 0.17, 0.05, 0.04),
      box(0.82, 0.36, 0.05, 0.04),
    ]
    const objects = [
      {
        id: 'vector-p001-001',
        page: 1,
        kind: 'vector' as const,
        box: scaffold,
        confidence: 0.98,
        assetId: 'asset-scaffold',
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: `image-p001-00${index + 1}`,
        page: 1,
        kind: 'image' as const,
        box: sourceBox,
        confidence: 0.98,
        assetId: `asset-fragment-${index + 1}`,
      })),
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(64),
        }),
    )
    const caption = captionRegion(
      'Figure 1. One bounded composite.',
      box(0.1, 0.54, 0.8, 0.02),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`composite-region-${index + 1}`, object.id, object.box),
        ),
        caption,
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceObjectIds: objects.map((object) => object.id),
        sourceBox: expect.objectContaining({ page: 1 }),
      }),
    )
    const renderBox = rasterizeFigure.mock.calls[0]![0].sourceBox
    expect(renderBox.y + renderBox.height).toBeLessThanOrEqual(
      caption.box.y + 0.001,
    )
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: objects.map((object) => object.id),
      assetIds: [expect.stringMatching(/^asset-/)],
    })
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNREFERENCED_VISUAL_ASSET' }),
      ]),
    )
  })

  it('trims scaffold and glyph objects that overlap unrelated reading-order text', async () => {
    const scaffold = box(0.48, 0.12, 0.36, 0.36)
    const authorGlyph = box(0.6, 0.18, 0.04, 0.02)
    const fragmentBoxes = Array.from({ length: 8 }, (_, index) =>
      box(
        0.52 + (index % 4) * 0.07,
        0.26 + Math.floor(index / 4) * 0.12,
        0.05,
        0.06,
      ),
    )
    const figureIds = fragmentBoxes.map(
      (_, index) => `vector-p001-figure-${index + 1}`,
    )
    const objects = [
      {
        id: 'vector-p001-overbroad-scaffold',
        page: 1,
        kind: 'vector' as const,
        box: scaffold,
        confidence: 0.98,
        assetId: null,
      },
      {
        id: 'vector-p001-author-glyph',
        page: 1,
        kind: 'vector' as const,
        box: authorGlyph,
        confidence: 0.98,
        assetId: null,
      },
      ...fragmentBoxes.map((sourceBox, index) => ({
        id: figureIds[index],
        page: 1,
        kind: 'vector' as const,
        box: sourceBox,
        confidence: 0.98,
        assetId: null,
      })),
    ]
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'raster',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 40,
          height: 20,
          pixels: new Uint8Array(40 * 20 * 4).fill(64),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`scaffold-region-${index + 1}`, object.id, object.box),
        ),
        textRegion(
          'author-line',
          'Author One, Author Two, University Laboratory',
          box(0.3, 0.17, 0.45, 0.035),
          'body',
        ),
        textRegion(
          'diagram-label-one',
          'Premise',
          box(0.55, 0.27, 0.08, 0.015),
          'body',
        ),
        textRegion(
          'diagram-label-two',
          'Write content',
          box(0.68, 0.39, 0.09, 0.015),
          'body',
        ),
        captionRegion(
          'Figure 1. A bounded diagram below the author block.',
          box(0.5, 0.5, 0.36, 0.025),
        ),
      ],
      rasterizeFigure,
    })

    expect(rasterizeFigure).toHaveBeenCalledOnce()
    expect(rasterizeFigure).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceObjectIds: [
          ...figureIds,
          'text-overlay:diagram-label-one',
          'text-overlay:diagram-label-two',
        ],
        sourceBox: expect.objectContaining({ y: expect.any(Number) }),
      }),
    )
    const sourceBox = rasterizeFigure.mock.calls[0]![0].sourceBox
    expect(sourceBox.y).toBeGreaterThan(0.2)
    expect(sourceBox.x).toBeLessThanOrEqual(0.5)
    expect(sourceBox.x + sourceBox.width).toBeGreaterThanOrEqual(0.86)
    expect(sourceBox.y + sourceBox.height).toBeGreaterThanOrEqual(0.49)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [
        ...figureIds,
        'text-overlay:diagram-label-one',
        'text-overlay:diagram-label-two',
      ],
      evidence: expect.arrayContaining([
        'source-scaffold-trimmed-reading-order-overlap',
        'source-page-crop',
      ]),
    })
  })

  it('uses an intervening caption to split overlapping composite scaffolds', async () => {
    const firstScaffold = box(0.05, 0.08, 0.9, 0.38)
    const secondScaffold = box(0.05, 0.4, 0.9, 0.36)
    const first = [
      {
        id: 'vector-p001-001',
        page: 1,
        kind: 'vector' as const,
        box: firstScaffold,
        confidence: 0.98,
        assetId: 'asset-first-scaffold',
      },
      ...[box(0.12, 0.14, 0.04, 0.03), box(0.78, 0.3, 0.04, 0.03)].map(
        (sourceBox, index) => ({
          id: `image-p001-00${index + 1}`,
          page: 1,
          kind: 'image' as const,
          box: sourceBox,
          confidence: 0.98,
          assetId: `asset-first-${index + 1}`,
        }),
      ),
    ]
    const second = [
      {
        id: 'vector-p001-002',
        page: 1,
        kind: 'vector' as const,
        box: secondScaffold,
        confidence: 0.98,
        assetId: 'asset-second-scaffold',
      },
      ...[box(0.14, 0.48, 0.04, 0.03), box(0.8, 0.67, 0.04, 0.03)].map(
        (sourceBox, index) => ({
          id: `image-p001-00${index + 3}`,
          page: 1,
          kind: 'image' as const,
          box: sourceBox,
          confidence: 0.98,
          assetId: `asset-second-${index + 1}`,
        }),
      ),
    ]
    const objects = [...first, ...second]

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`stacked-region-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. First bounded composite.',
          box(0.1, 0.38, 0.8, 0.02),
        ),
        captionRegion(
          'Figure 2. Second bounded composite.',
          box(0.1, 0.77, 0.8, 0.02),
        ),
      ],
    })

    expect(result.relationships).toEqual([
      expect.objectContaining({
        label: 'Figure 1',
        status: 'unresolved',
        sourceObjectIds: [],
        candidates: expect.arrayContaining([
          expect.objectContaining({
            sourceObjectIds: first.map((object) => object.id),
          }),
        ]),
      }),
      expect.objectContaining({
        label: 'Figure 2',
        status: 'unresolved',
        sourceObjectIds: [],
        candidates: expect.arrayContaining([
          expect.objectContaining({
            sourceObjectIds: second.map((object) => object.id),
          }),
        ]),
      }),
    ])
  })

  it('keeps a fragmented figure unresolved when no browser rasterizer exists', async () => {
    const boxes = [
      box(0.2, 0.18, 0.12, 0.12),
      box(0.33, 0.18, 0.12, 0.12),
      box(0.46, 0.18, 0.12, 0.12),
      box(0.59, 0.18, 0.12, 0.12),
    ]
    const objects = boxes.map((sourceBox, index) => ({
      id: `vector-p001-00${index + 1}`,
      page: 1,
      kind: 'vector' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: null,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects)],
      regions: [
        ...objects.map((object, index) =>
          objectRegion(`figure-fragment-${index + 1}`, object.id, object.box),
        ),
        captionRegion(
          'Figure 1. One diagram assembled from source fragments.',
          box(0.2, 0.32, 0.51, 0.025),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'unresolved',
      sourceObjectIds: [],
      assetIds: [],
    })
    expect(result.relationships[0].evidence).toContain(
      'source-rendition-unavailable',
    )
  })

  it('ignores a thin title-page rule without hiding bounded visual objects', async () => {
    const rule = box(0.18, 0.1, 0.65, 0.005)
    const figure = box(0.2, 0.6, 0.58, 0.23)
    const figureAsset = await createPngAsset({
      sourceObjectId: 'image-p001-001',
      sourceBox: figure,
      width: 2,
      height: 2,
      colorSpace: 'rgba',
      pixels: new Uint8Array(16).fill(128),
    })
    const objects = [
      {
        id: 'vector-p001-001',
        page: 1,
        kind: 'vector' as const,
        box: rule,
        confidence: 0.98,
        assetId: 'asset-rule',
      },
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image' as const,
        box: figure,
        confidence: 0.98,
        assetId: figureAsset.id,
      },
    ]
    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [figureAsset])],
      regions: [
        objectRegion('rule-region', objects[0].id, rule),
        objectRegion('figure-region', objects[1].id, figure),
        captionRegion(
          'Figure 1. Bounded source figure.',
          box(0.18, 0.84, 0.65, 0.02),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['image-p001-001'],
      assetIds: [figureAsset.id],
    })
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNREFERENCED_VISUAL_ASSET',
          sourceBoxes: [rule],
        }),
      ]),
    )
  })

  it('does not require an interior short hairline to have a figure caption', async () => {
    const rule = box(0.2, 0.46, 0.03, 0.00001)
    const figure = box(0.2, 0.62, 0.58, 0.23)
    const figureAsset = await createPngAsset({
      sourceObjectId: 'image-p001-001',
      sourceBox: figure,
      width: 2,
      height: 2,
      colorSpace: 'rgba',
      pixels: new Uint8Array(16).fill(128),
    })
    const objects = [
      {
        id: 'vector-p001-table-rule',
        page: 1,
        kind: 'vector' as const,
        box: rule,
        confidence: 0.98,
        assetId: 'asset-table-rule',
      },
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image' as const,
        box: figure,
        confidence: 0.98,
        assetId: figureAsset.id,
      },
    ]
    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [figureAsset])],
      regions: [
        objectRegion('rule-region', objects[0].id, rule),
        objectRegion('figure-region', objects[1].id, figure),
      ],
    })

    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNREFERENCED_VISUAL_ASSET',
          sourceBoxes: [rule],
        }),
      ]),
    )
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNREFERENCED_VISUAL_ASSET',
          sourceBoxes: [figure],
        }),
      ]),
    )
  })

  it('uses horizontal alignment to associate side-by-side figures', async () => {
    const left = box(0.08, 0.2, 0.38, 0.18)
    const right = box(0.54, 0.2, 0.38, 0.18)
    const sourceAssets = await Promise.all(
      [left, right].map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-00${index + 1}`,
          sourceBox,
          width: 2,
          height: 2,
          colorSpace: 'rgba',
          pixels: new Uint8Array(16).fill(80 + index * 80),
        }),
      ),
    )
    const objects = [
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image' as const,
        box: left,
        confidence: 0.98,
        assetId: sourceAssets[0].id,
      },
      {
        id: 'image-p001-002',
        page: 1,
        kind: 'image' as const,
        box: right,
        confidence: 0.98,
        assetId: sourceAssets[1].id,
      },
    ]
    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        objectRegion('left-region', objects[0].id, left),
        objectRegion('right-region', objects[1].id, right),
        captionRegion(
          'Figure 2. Right-hand result.',
          box(0.54, 0.4, 0.38, 0.02),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['image-p001-002'],
      assetIds: [sourceAssets[1].id],
    })
    expect(result.relationships[0].candidates[0].evidence).toContain(
      'horizontal-alignment',
    )
  })

  it('prefers a conventional above-caption figure before using caption-above fallback', async () => {
    const above = box(0.12, 0.18, 0.76, 0.18)
    const below = box(0.12, 0.42, 0.76, 0.18)
    const sourceAssets = await Promise.all(
      [above, below].map((sourceBox, index) =>
        createPngAsset({
          sourceObjectId: `image-p001-00${index + 1}`,
          sourceBox,
          width: 4,
          height: 2,
          colorSpace: 'rgba',
          pixels: new Uint8Array(4 * 2 * 4).fill(80 + index * 40),
        }),
      ),
    )
    const objects = [above, below].map((sourceBox, index) => ({
      id: `image-p001-00${index + 1}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox,
      confidence: 0.98,
      assetId: sourceAssets[index].id,
    }))

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, sourceAssets)],
      regions: [
        objectRegion('above-region', objects[0].id, above),
        objectRegion('below-region', objects[1].id, below),
        captionRegion(
          'Figure IV. Directionally bounded source figure.',
          box(0.12, 0.38, 0.76, 0.02),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: [objects[0].id],
      assetIds: [sourceAssets[0].id],
      evidence: expect.arrayContaining(['object-above-caption']),
    })
  })

  it('does not let a thin aligned vector sliver tie a caption-width figure', async () => {
    const figureBox = box(0.2, 0.2, 0.45, 0.18)
    const sliverBox = box(0.82, 0.2, 0.015, 0.18)
    const figureAsset = sourcePreservedSvgAsset(
      'vector-p001-caption-width-figure',
      figureBox,
    )
    const sliverAsset = sourcePreservedSvgAsset(
      'vector-p001-caption-sliver',
      sliverBox,
    )
    const objects = [
      {
        id: 'vector-p001-caption-width-figure',
        page: 1,
        kind: 'vector' as const,
        box: figureBox,
        confidence: 0.99,
        assetId: figureAsset.id,
      },
      {
        id: 'vector-p001-caption-sliver',
        page: 1,
        kind: 'vector' as const,
        box: sliverBox,
        confidence: 0.99,
        assetId: sliverAsset.id,
      },
    ]

    const result = await reconstructPdfVisuals({
      pages: [page(objects, 1, [figureAsset, sliverAsset])],
      regions: [
        objectRegion('caption-width-figure-region', objects[0].id, figureBox),
        objectRegion('caption-sliver-region', objects[1].id, sliverBox),
        captionRegion(
          'Figure IV. Caption-width figure with a decorative sliver.',
          box(0.2, 0.4, 0.65, 0.02),
        ),
      ],
    })

    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceObjectIds: ['vector-p001-caption-width-figure'],
      assetIds: [figureAsset.id],
    })
    expect(result.relationships[0].candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceObjectIds: ['vector-p001-caption-width-figure'],
          evidence: expect.arrayContaining(['horizontal-alignment']),
        }),
        expect.objectContaining({
          sourceObjectIds: ['vector-p001-caption-sliver'],
          evidence: expect.not.arrayContaining(['horizontal-alignment']),
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
        captionRegion(
          'Figure I. Competing candidates.',
          box(0.05, 0.32, 0.85, 0.02),
        ),
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

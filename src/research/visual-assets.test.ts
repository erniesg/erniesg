import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { NormalizedSourceBox, PdfRegionLine } from './import-types'
import {
  canonicalTableFromLines,
  createCompositePngAsset,
  createPngAsset,
  createTableAsset,
  createTextSvgAsset,
  createVectorSvgAsset,
  downscalePngAsset,
} from './visual-assets'

const sourceBox: NormalizedSourceBox = {
  page: 1,
  x: 0.2,
  y: 0.3,
  width: 0.4,
  height: 0.2,
  rotation: 0,
  method: 'pdf-object',
}

function line(
  id: string,
  y: number,
  cells: Array<{ text: string; x: number }>,
): PdfRegionLine {
  return {
    id,
    text: cells.map((cell) => cell.text).join(' '),
    fontSize: 10,
    box: { ...sourceBox, y, height: 0.02 },
    runs: cells.map((cell) => ({
      ...sourceBox,
      text: cell.text,
      x: cell.x,
      y,
      width: 0.12,
      height: 0.02,
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    })),
  }
}

describe('PDF visual asset primitives', () => {
  it('encodes decoded source pixels as a stable content-addressed PNG', async () => {
    const input = {
      sourceObjectId: 'image-p001-001',
      sourceBox,
      width: 2,
      height: 1,
      colorSpace: 'rgb' as const,
      pixels: new Uint8Array([255, 0, 0, 0, 128, 255]),
    }

    const first = await createPngAsset(input)
    const second = await createPngAsset(input)

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      id: expect.stringMatching(/^asset-[a-f0-9]{24}$/),
      mediaType: 'image/png',
      kind: 'raster',
      rendition: 'source-preserved',
      sourceObjectIds: ['image-p001-001'],
      sourceBoxes: [sourceBox],
      width: 2,
      height: 1,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(first.sha256).toBe(
      '5aef7d594dd6d4427308fac6871cafa2a911676ebd75e13f614edb86a397e01e',
    )
    expect([...first.bytes.subarray(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ])
    expect(first.href).toBe(`assets/${first.id}.png`)
  })

  it.each([
    {
      colorSpace: 'rgba' as const,
      width: 2,
      height: 1,
      pixels: new Uint8Array([255, 0, 0, 255, 0, 128, 255, 64]),
      sha256:
        '234feb93e6531bf5464f80ba77142b349766313308e70d2d569fec04f88e8496',
    },
    {
      colorSpace: 'grayscale-1bpp' as const,
      width: 8,
      height: 1,
      pixels: new Uint8Array([0b10100101]),
      sha256:
        '88f6eb641eb07d33bcb7843effa1bf50755ad1c1d0f0cefabce8603f076e279f',
    },
  ])(
    'pins the deterministic $colorSpace PNG byte stream',
    async ({ colorSpace, width, height, pixels, sha256 }) => {
      const encoded = await createPngAsset({
        sourceObjectId: `image-${colorSpace}`,
        sourceBox,
        width,
        height,
        colorSpace,
        pixels,
      })

      expect(encoded.sha256).toBe(sha256)
    },
  )

  it('preserves offset multi-row RGBA input without byte drift or mutation', async () => {
    const content = [
      255, 0, 0, 255, 0, 255, 0, 192, 0, 0, 255, 128, 255, 255, 255, 64,
      0, 0, 0, 255, 127, 63, 191, 0,
    ]
    const backing = new Uint8Array([9, 8, 7, ...content, 6, 5])
    const pixels = backing.subarray(3, 3 + content.length)
    const before = backing.slice()
    const input = {
      sourceObjectId: 'image-offset-rgba',
      sourceBox,
      width: 3,
      height: 2,
      colorSpace: 'rgba' as const,
    }

    const fromOffset = await createPngAsset({ ...input, pixels })
    const fromContiguous = await createPngAsset({
      ...input,
      pixels: pixels.slice(),
    })

    expect(pixels.byteOffset).toBeGreaterThan(0)
    expect(fromOffset.bytes).toEqual(fromContiguous.bytes)
    expect(fromOffset.sha256).toBe(
      '842965e4553691c931e320a8db66fac5d92c89a2261d47b78076286cc59de2ce',
    )
    expect(backing).toEqual(before)
  })

  it('encodes a composite raster with complete fragment lineage', async () => {
    const sourceBoxes = [sourceBox, { ...sourceBox, x: 0.61 }]
    const input = {
      sourceObjectIds: ['vector-p001-001', 'image-p001-001'],
      sourceBoxes,
      width: 2,
      height: 1,
      pixels: new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]),
    }

    const first = await createCompositePngAsset(input)
    const second = await createCompositePngAsset(input)

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      mediaType: 'image/png',
      kind: 'raster',
      rendition: 'browser-composite-raster',
      sourceObjectIds: input.sourceObjectIds,
      sourceBoxes,
      width: 2,
      height: 1,
    })
    await expect(
      createCompositePngAsset({
        ...input,
        sourceBoxes: [sourceBox],
      }),
    ).rejects.toThrow(/source box for every source object/)
  })

  it('labels hardcoded-paint vector SVG as a readable approximation', async () => {
    const asset = await createVectorSvgAsset({
      sourceObjectId: 'vector-p001-001',
      sourceBox,
      path: 'M 0 0 L 40 0 L 20 30 Z',
      viewBox: { x: 0, y: 0, width: 40, height: 30 },
      paint: 'fill-stroke',
    })
    const svg = strFromU8(asset.bytes)

    expect(asset).toMatchObject({
      mediaType: 'image/svg+xml',
      kind: 'vector',
      rendition: 'bounded-svg-fallback',
    })
    expect(svg).toContain('viewBox="0 0 40 30"')
    expect(svg).toContain('d="M 0 0 L 40 0 L 20 30 Z"')
    expect(svg).not.toContain('<text')
  })

  it('downscales generated PNGs deterministically without upscaling', async () => {
    const source = await createPngAsset({
      sourceObjectId: 'image-p001-wide',
      sourceBox,
      width: 4,
      height: 2,
      colorSpace: 'rgba',
      pixels: new Uint8Array(4 * 2 * 4).fill(127),
    })

    const first = await downscalePngAsset(source, 2, 264)
    const second = await downscalePngAsset(source, 2, 264)

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      width: 2,
      height: 1,
      rendition: 'profile-downscaled',
      resolutionDpi: 264,
    })
    expect(first.sha256).not.toBe(source.sha256)
    await expect(downscalePngAsset(source, 8, 264)).resolves.toBe(source)
  })

  it('uses exact source text in an SVG equation fallback', async () => {
    const equationLine = line('equation-line', 0.4, [
      { text: 'x < y & y = z', x: 0.3 },
    ])
    const asset = await createTextSvgAsset({
      kind: 'equation',
      sourceObjectId: 'equation-p001-001',
      sourceBox,
      lines: [equationLine],
      pageWidth: 612,
      pageHeight: 792,
    })
    const svg = strFromU8(asset.bytes)

    expect(asset).toMatchObject({
      mediaType: 'image/svg+xml',
      kind: 'equation',
      rendition: 'bounded-svg-fallback',
      resolutionDpi: null,
    })
    expect(svg).toContain('x &lt; y &amp; y = z')
    expect(svg).not.toMatch(/latex|mathml/i)
  })

  it('expands equation render bounds for lowered source runs without changing lineage', async () => {
    const tightSourceBox = {
      ...sourceBox,
      y: 0.3,
      height: 0.012,
      method: 'pdf-text' as const,
    }
    const equationLine: PdfRegionLine = {
      id: 'equation-line',
      text: 'Dr',
      fontSize: 10,
      box: tightSourceBox,
      runs: [
        {
          ...tightSourceBox,
          text: 'D',
          width: 0.02,
          fontName: 'Equation',
          fontSize: 10,
          confidence: 1,
        },
        {
          ...tightSourceBox,
          text: 'r',
          x: 0.22,
          y: 0.309,
          width: 0.01,
          height: 0.008,
          fontName: 'EquationSubscript',
          fontSize: 6,
          confidence: 1,
        },
      ],
    }
    const result = await createTextSvgAsset({
      kind: 'equation',
      sourceObjectId: 'equation-p001-lowered',
      sourceBox: tightSourceBox,
      lines: [equationLine],
      pageWidth: 612,
      pageHeight: 792,
    })

    expect(result.sourceBoxes).toEqual([tightSourceBox])
    expect(result.height).toBeGreaterThan(tightSourceBox.height * 792)
    expect(strFromU8(result.bytes)).toContain('>r</text>')
  })

  it('emits semantic XHTML only for aligned rectangular table rows', async () => {
    const aligned = [
      line('header', 0.4, [
        { text: 'Group', x: 0.2 },
        { text: 'Score', x: 0.5 },
      ]),
      line('row', 0.44, [
        { text: 'Control', x: 0.2 },
        { text: '10', x: 0.5 },
      ]),
    ]
    for (const run of aligned[0].runs) run.bold = true
    const semantic = await createTableAsset({
      sourceObjectId: 'table-p001-001',
      sourceBox,
      lines: aligned,
      pageWidth: 612,
      pageHeight: 792,
    })
    const fallback = await createTableAsset({
      sourceObjectId: 'table-p001-002',
      sourceBox,
      lines: [aligned[0], line('bad-row', 0.44, [{ text: '10', x: 0.5 }])],
      pageWidth: 612,
      pageHeight: 792,
    })

    expect(semantic).toMatchObject({
      mediaType: 'application/xhtml+xml',
      kind: 'table',
      rendition: 'semantic-table',
    })
    expect(semantic).not.toBeNull()
    if (!semantic) throw new Error('Expected an aligned semantic table asset')
    expect(strFromU8(semantic.bytes)).toContain(
      '<th id="cell-r1-c1" scope="col">Group</th>',
    )
    expect(strFromU8(semantic.bytes)).toContain(
      '<td id="cell-r2-c2">10</td>',
    )
    expect(canonicalTableFromLines(aligned)).toEqual({
      rows: [
        {
          cells: [
            {
              text: 'Group',
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
              text: 'Control',
              headerScope: null,
              columnSpan: 1,
              rowSpan: 1,
            },
            {
              text: '10',
              headerScope: null,
              columnSpan: 1,
              rowSpan: 1,
            },
          ],
        },
      ],
    })
    expect(
      canonicalTableFromLines([
        aligned[0],
        line('bad-row', 0.44, [{ text: '10', x: 0.5 }]),
      ]),
    ).toBeNull()
    const nonuniform = [
      line('wide-header', 0.4, [
        { text: 'Model', x: 0.2 },
        { text: 'English', x: 0.5 },
        { text: 'Chinese', x: 0.7 },
      ]),
      line('missing-cell', 0.44, [
        { text: 'Baseline', x: 0.2 },
        { text: '72.1', x: 0.7 },
      ]),
      line('wide-row', 0.48, [
        { text: 'Proposed', x: 0.2 },
        { text: '81.4', x: 0.5 },
        { text: '79.8', x: 0.7 },
      ]),
    ]
    expect(canonicalTableFromLines(nonuniform)).toBeNull()
    await expect(
      createTableAsset({
        sourceObjectId: 'table-p001-003',
        sourceBox,
        lines: nonuniform,
        pageWidth: 612,
        pageHeight: 792,
      }),
    ).resolves.toBeNull()
    expect(fallback).toBeNull()
  })

  it('does not invent header cells for a uniform headerless numeric table', async () => {
    const headerless = [
      line('row-1', 0.4, [
        { text: '10', x: 0.2 },
        { text: '20', x: 0.5 },
      ]),
      line('row-2', 0.44, [
        { text: '30', x: 0.2 },
        { text: '40', x: 0.5 },
      ]),
    ]

    expect(canonicalTableFromLines(headerless)).toBeNull()
    await expect(
      createTableAsset({
        sourceObjectId: 'table-p001-headerless',
        sourceBox,
        lines: headerless,
        pageWidth: 612,
        pageHeight: 792,
      }),
    ).resolves.toBeNull()
  })

  it('accepts an explicit PDF bold font name as table-header evidence', () => {
    const styled = [
      line('header', 0.4, [
        { text: 'Profile', x: 0.2 },
        { text: 'Nodes', x: 0.5 },
      ]),
      line('body', 0.44, [
        { text: 'Mobile', x: 0.2 },
        { text: '12', x: 0.5 },
      ]),
    ]
    for (const run of styled[0].runs) run.fontName = 'Helvetica-BoldMT'

    expect(canonicalTableFromLines(styled)?.rows[0].cells).toEqual([
      expect.objectContaining({ text: 'Profile', headerScope: 'column' }),
      expect.objectContaining({ text: 'Nodes', headerScope: 'column' }),
    ])
  })

  it('accepts a PDF medium face as explicit printed table-header evidence', () => {
    const styled = [
      line('header', 0.4, [
        { text: 'Method', x: 0.2 },
        { text: 'Score', x: 0.5 },
      ]),
      line('body', 0.44, [
        { text: 'Baseline', x: 0.2 },
        { text: '10', x: 0.5 },
      ]),
    ]
    for (const run of styled[0].runs) {
      run.fontName = 'Subset+NimbusRomNo9L-Medi'
    }

    expect(canonicalTableFromLines(styled)?.rows[0].cells).toEqual([
      expect.objectContaining({ text: 'Method', headerScope: 'column' }),
      expect.objectContaining({ text: 'Score', headerScope: 'column' }),
    ])
  })

  it('accepts a regular header only with exact source header-line evidence', async () => {
    const sourceClassified = [
      line('source-header', 0.4, [
        { text: 'Dataset', x: 0.2 },
        { text: 'Scope', x: 0.5 },
      ]),
      line('body', 0.44, [
        { text: 'Example', x: 0.2 },
        { text: 'Dialogue', x: 0.5 },
      ]),
    ]

    expect(canonicalTableFromLines(sourceClassified)).toBeNull()
    expect(
      canonicalTableFromLines(sourceClassified, {
        sourceHeaderLineIds: ['source-header'],
      })?.rows[0].cells,
    ).toEqual([
      expect.objectContaining({ text: 'Dataset', headerScope: 'column' }),
      expect.objectContaining({ text: 'Scope', headerScope: 'column' }),
    ])
    await expect(
      createTableAsset({
        sourceObjectId: 'table-p001-source-classified-header',
        sourceBox,
        lines: sourceClassified,
        sourceHeaderLineIds: ['source-header'],
        pageWidth: 612,
        pageHeight: 792,
      }),
    ).resolves.toMatchObject({ rendition: 'semantic-table' })
    expect(
      canonicalTableFromLines(sourceClassified, {
        sourceHeaderLineIds: ['body'],
      }),
    ).toBeNull()
  })

  it('accepts dense columns only with proved rectangular detector geometry', async () => {
    const dense = [
      line('dense-header', 0.4, [
        { text: 'Dataset', x: 0.2 },
        { text: 'Character', x: 0.31 },
        { text: 'Evaluation', x: 0.42 },
      ]),
      line('dense-body-1', 0.44, [
        { text: 'Baseline', x: 0.2 },
        { text: 'Yes', x: 0.31 },
        { text: 'Dialogue', x: 0.42 },
      ]),
      line('dense-body-2', 0.48, [
        { text: 'Proposed', x: 0.2 },
        { text: 'Yes', x: 0.31 },
        { text: 'Interview', x: 0.42 },
      ]),
    ]
    const sourceHeaderLineIds = ['dense-header']

    expect(canonicalTableFromLines(dense, { sourceHeaderLineIds })).toBeNull()
    expect(
      canonicalTableFromLines(dense, {
        sourceHeaderLineIds,
        detectedRectangularGeometry: true,
      })?.rows,
    ).toHaveLength(3)
    await expect(
      createTableAsset({
        sourceObjectId: 'table-p001-dense-proved-grid',
        sourceBox,
        lines: dense,
        sourceHeaderLineIds,
        detectedRectangularGeometry: true,
        pageWidth: 612,
        pageHeight: 792,
      }),
    ).resolves.toMatchObject({ rendition: 'semantic-table' })
  })
})

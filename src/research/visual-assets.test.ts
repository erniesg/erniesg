import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { NormalizedSourceBox, PdfRegionLine } from './import-types'
import {
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
    expect([...first.bytes.subarray(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ])
    expect(first.href).toBe(`assets/${first.id}.png`)
  })

  it('preserves simple source vector geometry as bounded SVG', async () => {
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
      rendition: 'source-preserved',
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
    expect(strFromU8(semantic.bytes)).toContain('<th scope="col">Group</th>')
    expect(strFromU8(semantic.bytes)).toContain('<td>10</td>')
    expect(fallback).toMatchObject({
      mediaType: 'image/svg+xml',
      kind: 'table',
      rendition: 'bounded-svg-fallback',
    })
  })
})

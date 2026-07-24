import { expect, it, vi } from 'vitest'
import { renderPdfPageCrop } from './pdf-page-crop'

const width = 20
const height = 20
const sourceBox = {
  page: 1,
  x: 0.1,
  y: 0.1,
  width: 0.2,
  height: 0.2,
  rotation: 0,
  method: 'pdf-object' as const,
}

function blackPixel(pixels: Uint8ClampedArray, x: number, y: number) {
  pixels[(y * width + x) * 4] = 0
}

function renderPixels(
  pixels: Uint8ClampedArray,
  ownedSourceBoxes: Parameters<typeof renderPdfPageCrop>[0]['ownedSourceBoxes'],
) {
  return renderPdfPageCrop({
    page: {
      pageNumber: 1,
      getViewport: ({ scale }) => ({
        width: 100 * scale,
        height: 100 * scale,
        rotation: 0,
      }),
      render: () => ({ promise: Promise.resolve() }),
    },
    canvasFactory: {
      create: () => ({
        canvas: { width, height },
        context: {
          fillStyle: '',
          fillRect: vi.fn(),
          getImageData: vi.fn(() => ({ data: pixels })),
        },
      }),
      destroy: vi.fn(),
    },
    sourceBox,
    ownedSourceBoxes,
    maximumPixels: 400,
  })
}

it('fails closed on border-connected ink that has no proved source owner', async () => {
  const width = 20
  const height = 20
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  blackPixel(pixels, 2, 0)
  blackPixel(pixels, 2, 1)
  blackPixel(pixels, 3, 1)
  blackPixel(pixels, 10, 10)

  await expect(
    renderPixels(pixels, [
      {
        page: 1,
        x: 0.18,
        y: 0.18,
        width: 0.05,
        height: 0.05,
        rotation: 0,
        method: 'pdf-text',
      },
    ]),
  ).rejects.toThrow('PDF page crop has source ink touching its edge')
})

it('does not erase remote edge ink merely because it lies between owned zones', async () => {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  blackPixel(pixels, 10, 0)
  blackPixel(pixels, 10, 1)
  blackPixel(pixels, 4, 2)
  blackPixel(pixels, 16, 2)

  await expect(
    renderPixels(pixels, [
      {
        page: 1,
        x: 0.12,
        y: 0.102,
        width: 0.04,
        height: 0.03,
        rotation: 0,
        method: 'pdf-text',
      },
      {
        page: 1,
        x: 0.25,
        y: 0.102,
        width: 0.04,
        height: 0.03,
        rotation: 0,
        method: 'pdf-text',
      },
    ]),
  ).rejects.toThrow('PDF page crop has source ink touching its edge')
})

it('preserves a vector fraction bar between owned text boxes', async () => {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  for (let x = 7; x <= 13; x += 1) blackPixel(pixels, x, 10)
  blackPixel(pixels, 9, 6)
  blackPixel(pixels, 9, 14)

  const raster = await renderPixels(pixels, [
    {
      page: 1,
      x: 0.18,
      y: 0.15,
      width: 0.04,
      height: 0.03,
      rotation: 0,
      method: 'pdf-text',
    },
    {
      page: 1,
      x: 0.18,
      y: 0.23,
      width: 0.04,
      height: 0.03,
      rotation: 0,
      method: 'pdf-text',
    },
  ])

  for (let x = 7; x <= 13; x += 1) {
    expect(raster.pixels[(10 * width + x) * 4]).toBe(0)
  }
})

it.each([
  {
    kind: 'radical',
    paint(pixels: Uint8ClampedArray) {
      for (let y = 0; y <= 6; y += 1) blackPixel(pixels, 1 + y, y)
      for (let x = 7; x <= 12; x += 1) blackPixel(pixels, x, 6)
    },
  },
  {
    kind: 'brace',
    paint(pixels: Uint8ClampedArray) {
      for (let y = 0; y <= 8; y += 1) blackPixel(pixels, 2, y)
      blackPixel(pixels, 3, 4)
    },
  },
  {
    kind: 'arrow',
    paint(pixels: Uint8ClampedArray) {
      for (let x = 0; x <= 8; x += 1) blackPixel(pixels, x, 3)
      blackPixel(pixels, 6, 1)
      blackPixel(pixels, 7, 2)
      blackPixel(pixels, 7, 4)
      blackPixel(pixels, 6, 5)
    },
  },
  {
    kind: 'rule',
    paint(pixels: Uint8ClampedArray) {
      for (let x = 4; x <= 15; x += 1) blackPixel(pixels, x, 0)
    },
  },
])(
  'keeps a vector-only $kind at the crop edge review-required',
  async ({ paint }) => {
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
    paint(pixels)
    blackPixel(pixels, 10, 12)

    await expect(
      renderPixels(pixels, [
        {
          page: 1,
          x: 0.19,
          y: 0.21,
          width: 0.04,
          height: 0.04,
          rotation: 0,
          method: 'pdf-text',
        },
      ]),
    ).rejects.toThrow('PDF page crop has source ink touching its edge')
  },
)

it('fails closed when a border-connected component reaches an owned source box', async () => {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  for (let y = 0; y <= 10; y += 1) blackPixel(pixels, 10, y)

  await expect(
    renderPixels(pixels, [
      {
        page: 1,
        x: 0.19,
        y: 0.19,
        width: 0.03,
        height: 0.03,
        rotation: 0,
        method: 'pdf-text',
      },
    ]),
  ).rejects.toThrow('PDF page crop has source ink touching its edge')
})

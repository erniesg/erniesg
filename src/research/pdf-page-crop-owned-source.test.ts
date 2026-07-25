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
  excludedSourceBoxes?: Parameters<
    typeof renderPdfPageCrop
  >[0]['excludedSourceBoxes'],
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
    excludedSourceBoxes,
    maximumPixels: 400,
  })
}

const interiorOwner = {
  page: 1,
  x: 0.18,
  y: 0.18,
  width: 0.05,
  height: 0.05,
  rotation: 0,
  method: 'pdf-text' as const,
}

const precedingLineBox = {
  page: 1,
  x: 0.115,
  y: 0.08,
  width: 0.02,
  height: 0.02,
  rotation: 0,
  method: 'pdf-text' as const,
}

it('removes only tiny edge-connected bleed proved by an adjacent source box', async () => {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  blackPixel(pixels, 2, 0)
  blackPixel(pixels, 2, 1)
  blackPixel(pixels, 3, 1)
  blackPixel(pixels, 10, 10)

  const raster = await renderPixels(pixels, [interiorOwner], [precedingLineBox])

  expect(raster.pixels[(10 * width + 10) * 4]).toBe(0)
  expect(raster.pixels[(1 * width + 2) * 4]).toBe(255)
  expect(raster.sourceExclusionMask).toEqual({
    algorithm: 'nearest-source-box-v1',
    expansionPixels: 2,
    ownedSourceBoxes: [interiorOwner],
    excludedSourceBoxes: [precedingLineBox],
  })
})

it('accepts an excluded source box whose interval straddles the crop edge', async () => {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  blackPixel(pixels, 9, 0)
  blackPixel(pixels, 9, 1)
  blackPixel(pixels, 10, 10)
  const straddlingBox = {
    ...precedingLineBox,
    x: 0.18,
    y: 0.05,
    height: 0.1,
  }

  const raster = await renderPixels(pixels, [interiorOwner], [straddlingBox])

  expect(raster.pixels[(1 * width + 9) * 4]).toBe(255)
  expect(raster.sourceExclusionMask?.excludedSourceBoxes).toEqual([
    straddlingBox,
  ])
})

it('rejects disconnected unprotected ink left inside any changed exclusion zone', async () => {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  blackPixel(pixels, 2, 0)
  blackPixel(pixels, 2, 1)
  blackPixel(pixels, 3, 1)
  blackPixel(pixels, 19, 2)
  blackPixel(pixels, 18, 2)
  blackPixel(pixels, 16, 2)
  blackPixel(pixels, 10, 10)

  await expect(
    renderPixels(
      pixels,
      [interiorOwner],
      [
        {
          ...precedingLineBox,
          height: 0.08,
        },
        {
          ...precedingLineBox,
          x: 0.28,
          y: 0.115,
          width: 0.04,
        },
      ],
    ),
  ).rejects.toThrow(/disconnected unprotected source ink/i)
})

it('rejects any intersection between owned and excluded source geometry', async () => {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  blackPixel(pixels, 10, 10)

  await expect(
    renderPixels(
      pixels,
      [interiorOwner],
      [
        {
          ...interiorOwner,
          x: interiorOwner.x + 0.01,
          y: interiorOwner.y + 0.01,
        },
      ],
    ),
  ).rejects.toThrow(/owned and excluded source boxes must not intersect/i)
})

it('does not attest an exclusion mask when no rendered pixels changed', async () => {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  blackPixel(pixels, 10, 10)

  const raster = await renderPixels(pixels, [interiorOwner], [precedingLineBox])

  expect(raster.sourceExclusionMask).toBeUndefined()
})

it('rejects unprotected exclusion-zone ink even when no edge component changed', async () => {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  blackPixel(pixels, 4, 1)
  blackPixel(pixels, 10, 10)

  await expect(
    renderPixels(pixels, [interiorOwner], [precedingLineBox]),
  ).rejects.toThrow(/unprotected source ink/i)
})

it('canonicalizes and deduplicates mask provenance deterministically', async () => {
  const secondOwner = {
    ...interiorOwner,
    x: 0.24,
  }
  const secondExcluded = {
    ...precedingLineBox,
    x: 0.14,
  }
  const render = (reverse: boolean) => {
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
    blackPixel(pixels, 2, 0)
    blackPixel(pixels, 10, 10)
    return renderPixels(
      pixels,
      reverse
        ? [secondOwner, interiorOwner, secondOwner]
        : [interiorOwner, secondOwner],
      reverse
        ? [secondExcluded, precedingLineBox, secondExcluded]
        : [precedingLineBox, secondExcluded],
    )
  }

  const [first, second] = await Promise.all([render(false), render(true)])

  expect(second.sourceExclusionMask).toEqual(first.sourceExclusionMask)
  expect(first.sourceExclusionMask).toEqual({
    algorithm: 'nearest-source-box-v1',
    expansionPixels: 2,
    ownedSourceBoxes: [interiorOwner, secondOwner],
    excludedSourceBoxes: [precedingLineBox, secondExcluded],
  })
})

it('projects source boxes with the rendered viewport instead of rounded canvas dimensions', async () => {
  const narrowSourceBox = {
    ...sourceBox,
    width: 0.009,
  }
  const raster = await renderPdfPageCrop({
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
      create: (renderedWidth, renderedHeight) => {
        const pixels = new Uint8ClampedArray(
          renderedWidth * renderedHeight * 4,
        ).fill(255)
        pixels[0] = 0
        pixels[(30 * renderedWidth + 1) * 4] = 0
        return {
          canvas: { width: renderedWidth, height: renderedHeight },
          context: {
            fillStyle: '',
            fillRect: vi.fn(),
            getImageData: vi.fn(() => ({ data: pixels })),
          },
        }
      },
      destroy: vi.fn(),
    },
    sourceBox: narrowSourceBox,
    ownedSourceBoxes: [
      {
        page: 1,
        x: 0.103,
        y: 0.195,
        width: 0.002,
        height: 0.01,
        rotation: 0,
        method: 'pdf-text',
      },
    ],
    excludedSourceBoxes: [
      {
        page: 1,
        x: 0.1083,
        y: 0.1,
        width: 0.0001,
        height: 0.01,
        rotation: 0,
        method: 'pdf-text',
      },
    ],
    maximumPixels: 400,
  })

  expect({ width: raster.width, height: raster.height }).toEqual({
    width: 3,
    height: 60,
  })
  expect(raster.pixels[0]).toBe(255)
  expect(raster.sourceExclusionMask).toBeDefined()
})

it('caps the canonical exclusion decision', async () => {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  blackPixel(pixels, 10, 10)
  const excludedSourceBoxes = Array.from({ length: 33 }, (_, index) => ({
    ...precedingLineBox,
    x: 0.1 + index * 0.001,
    width: 0.0005,
  }))

  await expect(
    renderPixels(pixels, [interiorOwner], excludedSourceBoxes),
  ).rejects.toThrow(
    /excluded source boxes must be valid normalized page regions/i,
  )
})

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
      renderPixels(
        pixels,
        [
          {
            page: 1,
            x: 0.19,
            y: 0.21,
            width: 0.04,
            height: 0.04,
            rotation: 0,
            method: 'pdf-text',
          },
        ],
        [
          {
            ...precedingLineBox,
            x: 0.1,
            width: 0.2,
          },
          {
            ...precedingLineBox,
            x: 0.1,
            y: 0.1,
            width: 0.015,
            height: 0.1,
          },
        ],
      ),
    ).rejects.toThrow('PDF page crop has source ink touching its edge')
  },
)

it('fails closed when a border-connected component reaches an owned source box', async () => {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  for (let y = 0; y <= 10; y += 1) blackPixel(pixels, 9, y)

  await expect(
    renderPixels(
      pixels,
      [
        {
          page: 1,
          x: 0.19,
          y: 0.19,
          width: 0.03,
          height: 0.03,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
      [
        {
          page: 1,
          x: 0.1,
          y: 0.1,
          width: 0.09,
          height: 0.09,
          rotation: 0,
          method: 'pdf-text',
        },
      ],
    ),
  ).rejects.toThrow('PDF page crop has source ink touching its edge')
})

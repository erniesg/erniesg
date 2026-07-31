import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  hasSourceInkOnCropEdge,
  renderPdfPageCrop,
  type PdfCanvasFactory,
  type PdfPageCropSource,
} from './pdf-page-crop'
import { createSourcePageCropAsset, downscalePngAsset } from './visual-assets'

describe('PDF source-page crops', () => {
  it('detects source ink that reaches any crop edge', () => {
    const width = 8
    const height = 6
    const clear = new Uint8Array(width * height * 4).fill(255)
    expect(hasSourceInkOnCropEdge(clear, width, height)).toBe(false)
    const clipped = clear.slice()
    clipped[(width * 3 - 1) * 4] = 0
    expect(hasSourceInkOnCropEdge(clipped, width, height)).toBe(true)
  })

  it('rejects a rendered crop whose source ink touches its boundary', async () => {
    const width = 20
    const height = 20
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
    pixels[0] = 0
    await expect(
      renderPdfPageCrop({
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
        sourceBox: {
          page: 1,
          x: 0.1,
          y: 0.1,
          width: 0.2,
          height: 0.2,
          rotation: 0,
          method: 'pdf-object',
        },
        maximumPixels: 400,
      }),
    ).rejects.toThrow(/ink touching its edge/i)
  })

  it('snapshots source geometry before rendering crosses an async boundary', async () => {
    const sourceBox = {
      page: 1,
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    let releaseRender!: () => void
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve
    })
    const transforms: number[][] = []
    const operation = renderPdfPageCrop({
      page: {
        pageNumber: 1,
        getViewport: ({ scale }) => ({
          width: 100 * scale,
          height: 100 * scale,
          rotation: 0,
        }),
        render: ({ transform }) => {
          transforms.push([...(transform ?? [])])
          return { promise: renderGate }
        },
      },
      canvasFactory: {
        create: (width, height) => {
          const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
          const center =
            (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
          pixels.set([0, 0, 0, 255], center)
          return {
            canvas: { width, height },
            context: {
              fillStyle: '',
              fillRect: vi.fn(),
              getImageData: vi.fn(() => ({ data: pixels })),
            },
          }
        },
        destroy: vi.fn(),
      },
      sourceBox,
    })

    sourceBox.x = 0.45
    sourceBox.y = 0.35
    sourceBox.width = 0.4
    sourceBox.height = 0.3
    releaseRender()
    const raster = await operation

    expect(transforms).toEqual([[1, 0, 0, 1, -30, -30]])
    expect({ width: raster.width, height: raster.height }).toEqual({
      width: 60,
      height: 60,
    })
    expect(raster.sourceBox).toEqual({
      page: 1,
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
      rotation: 0,
      method: 'pdf-object',
    })
    sourceBox.x = 0.7
    expect(raster.sourceBox.x).toBe(0.1)
  })

  it('tightens declared PDF geometry to padded rendered-ink bounds', async () => {
    const sourceBox = {
      page: 1,
      x: 0.1,
      y: 0.1,
      width: 0.4,
      height: 0.4,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const raster = await renderPdfPageCrop({
      page: {
        pageNumber: 1,
        getViewport: ({ scale }) => ({
          width: 1_000 * scale,
          height: 1_000 * scale,
          rotation: 0,
        }),
        render: () => ({ promise: Promise.resolve() }),
      },
      canvasFactory: {
        create: (width, height) => {
          const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
          for (let y = 80; y < 320; y += 1) {
            for (let x = 40; x < 360; x += 1) {
              const offset = (y * width + x) * 4
              pixels[offset] = 0
              pixels[offset + 1] = 0
              pixels[offset + 2] = 0
            }
          }
          return {
            canvas: { width, height },
            context: {
              fillStyle: '',
              fillRect: vi.fn(),
              getImageData: vi.fn(() => ({ data: pixels })),
            },
          }
        },
        destroy: vi.fn(),
      },
      sourceBox,
      maximumPixels: 160_000,
      tightenToSourceInk: true,
    })

    expect(raster.sourceBox).toEqual({
      ...sourceBox,
      x: 0.136,
      y: 0.176,
      width: 0.328,
      height: 0.248,
    })
    expect({ width: raster.width, height: raster.height }).toEqual({
      width: 328,
      height: 248,
    })
    expect(raster.resolutionDpi).toBe(72)
    expect(
      hasSourceInkOnCropEdge(raster.pixels, raster.width, raster.height),
    ).toBe(false)
  })

  it('renders deterministic source pixels headlessly without a DOM', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const bytes = await readFile(
      new URL('../../tests/fixtures/pdf/born-digital.pdf', import.meta.url),
    )
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: true,
    })
    const document = await loadingTask.promise
    const page = await document.getPage(1)
    try {
      expect(globalThis.document).toBeUndefined()
      const input = {
        page: page as unknown as PdfPageCropSource,
        canvasFactory: document.canvasFactory as unknown as PdfCanvasFactory,
        sourceBox: {
          page: 1,
          x: 0.08,
          y: 0.04,
          width: 0.75,
          height: 0.2,
          rotation: 0,
          method: 'pdf-object' as const,
        },
      }
      const first = await renderPdfPageCrop(input)
      const second = await renderPdfPageCrop(input)

      expect({ width: second.width, height: second.height }).toEqual({
        width: first.width,
        height: first.height,
      })
      const [firstHash, secondHash] = await Promise.all(
        [first.pixels, second.pixels].map(async (pixels) => {
          const copy = new Uint8Array(pixels.byteLength)
          copy.set(pixels)
          const digest = await crypto.subtle.digest('SHA-256', copy)
          return Buffer.from(digest).toString('hex')
        }),
      )
      expect(secondHash).toBe(firstHash)
      expect(first.resolutionDpi).toBe(216)
      expect(
        first.pixels.some((value, index) => index % 4 !== 3 && value < 240),
      ).toBe(true)

      const firstAsset = await createSourcePageCropAsset({
        kind: 'raster',
        cropBox: input.sourceBox,
        sourceObjectIds: ['bounded-source-region'],
        sourceBoxes: [input.sourceBox],
        ...first,
      })
      const secondAsset = await createSourcePageCropAsset({
        kind: 'raster',
        cropBox: input.sourceBox,
        sourceObjectIds: ['bounded-source-region'],
        sourceBoxes: [input.sourceBox],
        ...second,
      })
      expect(secondAsset.sha256).toBe(firstAsset.sha256)
      expect(secondAsset.bytes).toEqual(firstAsset.bytes)
      expect(firstAsset.resolutionDpi).toBe(216)
      expect([...firstAsset.bytes.subarray(0, 8)]).toEqual([
        137, 80, 78, 71, 13, 10, 26, 10,
      ])
      expect(firstAsset).toMatchObject({
        kind: 'raster',
        rendition: 'source-page-crop',
        sourceCropBox: input.sourceBox,
        sourceObjectIds: ['bounded-source-region'],
        sourceBoxes: [input.sourceBox],
      })
    } finally {
      page.cleanup()
      await document.destroy()
    }
  })

  it('rejects crop assets whose source IDs and boxes do not form exact lineage', async () => {
    const cropBox = {
      page: 1,
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    await expect(
      createSourcePageCropAsset({
        kind: 'table',
        cropBox,
        sourceObjectIds: ['table-region', 'dangling-region'],
        sourceBoxes: [cropBox],
        width: 2,
        height: 2,
        pixels: new Uint8Array(16).fill(255),
      }),
    ).rejects.toThrow(/source box for every source object/i)
  })

  it('rejects blank pixels and near-full-page screenshots', async () => {
    const cropBox = {
      page: 1,
      x: 0.1,
      y: 0.1,
      width: 0.3,
      height: 0.2,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const common = {
      kind: 'raster' as const,
      sourceObjectIds: ['figure-region'],
      sourceBoxes: [cropBox],
      width: 10,
      height: 10,
    }
    await expect(
      createSourcePageCropAsset({
        ...common,
        cropBox,
        pixels: new Uint8Array(10 * 10 * 4).fill(255),
      }),
    ).rejects.toThrow(/source ink/i)

    await expect(
      createSourcePageCropAsset({
        ...common,
        cropBox: {
          ...cropBox,
          x: 0.01,
          y: 0.01,
          width: 0.98,
          height: 0.98,
        },
        sourceBoxes: [{ ...cropBox, x: 0.01, y: 0.01 }],
        pixels: new Uint8Array(10 * 10 * 4).fill(32),
      }),
    ).rejects.toThrow(/bounded source region/i)
  })

  it('binds identical crop bytes to their distinct source geometry', async () => {
    const firstBox = {
      page: 1,
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const secondBox = { ...firstBox, x: 0.5 }
    const pixels = new Uint8Array(8 * 8 * 4).fill(48)
    const first = await createSourcePageCropAsset({
      kind: 'raster',
      cropBox: firstBox,
      sourceObjectIds: ['figure-region'],
      sourceBoxes: [firstBox],
      width: 8,
      height: 8,
      pixels,
    })
    const second = await createSourcePageCropAsset({
      kind: 'raster',
      cropBox: secondBox,
      sourceObjectIds: ['figure-region'],
      sourceBoxes: [secondBox],
      width: 8,
      height: 8,
      pixels,
    })

    expect(second.sha256).toBe(first.sha256)
    expect(second.id).not.toBe(first.id)
    expect(second.sourceCropBox).toEqual(secondBox)

    const [firstPackaged, secondPackaged] = await Promise.all([
      downscalePngAsset(first, 4, 264),
      downscalePngAsset(second, 4, 264),
    ])
    expect(firstPackaged.sourceCropBox).toEqual(firstBox)
    expect(secondPackaged.sourceCropBox).toEqual(secondBox)
    expect(secondPackaged.id).not.toBe(firstPackaged.id)
  })

  it('cancels and releases a stalled renderer without awaiting its promise', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const destroy = vi.fn()
    const canvas = { width: 20, height: 20 }
    const context = {
      fillStyle: '',
      fillRect: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(canvas.width * canvas.height * 4),
      })),
    }
    const operation = renderPdfPageCrop({
      page: {
        pageNumber: 1,
        getViewport: ({ scale }) => ({
          width: 100 * scale,
          height: 100 * scale,
          rotation: 0,
        }),
        render: () => ({
          promise: new Promise<never>(() => undefined),
          cancel,
        }),
      },
      canvasFactory: {
        create: () => ({ canvas, context }),
        destroy,
      },
      sourceBox: {
        page: 1,
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.2,
        rotation: 0,
        method: 'pdf-object',
      },
      signal: controller.signal,
    })
    controller.abort()

    const outcome = await Promise.race([
      operation.catch((error: Error) => error.name),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('still-pending'), 100),
      ),
    ])
    expect(outcome).toBe('AbortError')
    expect(cancel).toHaveBeenCalledOnce()
    expect(destroy).toHaveBeenCalledOnce()
  })
})

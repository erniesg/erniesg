import { expect, it, vi } from 'vitest'
import {
  isTrustedPdfTextOperationFilterRaster,
  renderPdfPageCrop,
  type PdfPageCropSource,
} from './pdf-page-crop'
import {
  MAX_PDF_TEXT_OPERATION_FILTER_INDEX_COUNT,
  pdfTextLedgerSha256,
  PDFJS_DISPLAY_OPERATOR_ADAPTER,
  PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD,
  PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION,
} from './pdf-text-paint'
import {
  createSourcePageCropAsset,
  downscalePngAsset,
  isTrustedPdfTextOperationFilterAsset,
} from './visual-assets'

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

it('rejects stale runtime identities and V1 requests before DISPLAY filtering', async () => {
  const currentRequest = {
    algorithm: 'pdfjs-display-text-operation-filter-v2' as const,
    expansionPixels: 0 as const,
    pdfjsVersion: PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION,
    pdfjsBuild: PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD,
    displayOperatorAdapter: PDFJS_DISPLAY_OPERATOR_ADAPTER,
    renderIntent: 'display' as const,
    annotationMode: 'enable' as const,
    sourceTextLedgerSha256: pdfTextLedgerSha256('cueown'),
    ownedTextLedgerSpans: [{ start: 3, end: 6 }],
    excludedTextLedgerSpans: [{ start: 0, end: 3 }],
    ownedSourceBoxes: [interiorOwner],
    excludedSourceBoxes: [
      {
        ...precedingLineBox,
        x: 0.12,
        y: 0.11,
      },
    ],
  }
  const invalidRequests = [
    {
      label: 'stale PDF.js version',
      request: { ...currentRequest, pdfjsVersion: 'stale-version' },
    },
    {
      label: 'stale PDF.js build',
      request: { ...currentRequest, pdfjsBuild: 'stale-build' },
    },
    {
      label: 'V1 source-box mask',
      request: {
        ...currentRequest,
        algorithm: 'nearest-source-box-v1',
        expansionPixels: 2,
      },
    },
  ]
  for (const { label, request } of invalidRequests) {
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
          create: () => {
            throw new Error(`unexpected render for ${label}`)
          },
          destroy: vi.fn(),
        },
        sourceBox,
        sourceTextOperationFilter: request as Parameters<
          typeof renderPdfPageCrop
        >[0]['sourceTextOperationFilter'],
        maximumPixels: 400,
      }),
    ).rejects.toThrow(/text operation filter is invalid/i)
  }
})

it('rejects an over-cap DISPLAY negative-control proof before raster rendering', async () => {
  const glyphs = (text: string) => [[...text].map((unicode) => ({ unicode }))]
  const nonOwnedPaintCount = MAX_PDF_TEXT_OPERATION_FILTER_INDEX_COUNT + 1
  const fnArray = [31]
  const argsArray: unknown[] = [[]]
  let ledgerText = ''
  for (let index = 0; index < nonOwnedPaintCount; index += 1) {
    if (index > 0) {
      fnArray.push(40)
      argsArray.push([0, 10])
    }
    fnArray.push(44)
    argsArray.push(glyphs(index === 0 ? 'c' : 'u'))
    ledgerText += index === 0 ? 'c' : 'u'
  }
  fnArray.push(40, 44, 32)
  argsArray.push([0, 10], glyphs('x'), [])
  ledgerText += 'x'
  let resolveDisplay!: (value: unknown) => void
  let rejectDisplay!: (reason: unknown) => void
  const displayPromise = new Promise<unknown>((resolve, reject) => {
    resolveDisplay = resolve
    rejectDisplay = reject
  })
  resolveDisplay(false)
  const displayIntentState = Object.assign(Object.create(null), {
    displayReadyCapability: {
      promise: displayPromise,
      resolve: resolveDisplay,
      reject: rejectDisplay,
    },
    operatorList: {
      fnArray,
      argsArray,
      lastChunk: true,
      separateAnnots: null,
    },
    renderTasks: new Set(),
    streamReader: null,
  })
  const render = vi.fn(() => ({ promise: Promise.resolve() }))
  const canvasFactory = {
    create: () => {
      const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
      return {
        canvas: { width, height },
        context: {
          pixels,
          fillStyle: '',
          fillRect: vi.fn(),
          getImageData: vi.fn(() => ({ data: pixels })),
        },
      }
    },
    destroy: vi.fn(),
  }

  await expect(
    renderPdfPageCrop({
      page: {
        pageNumber: 1,
        _intentStates: new Map([['2__', displayIntentState]]),
        getViewport: ({ scale }) => ({
          width: 100 * scale,
          height: 100 * scale,
          rotation: 0,
        }),
        render,
      },
      canvasFactory,
      sourceBox,
      sourceTextOperationFilter: {
        algorithm: 'pdfjs-display-text-operation-filter-v2',
        expansionPixels: 0,
        pdfjsVersion: PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION,
        pdfjsBuild: PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD,
        displayOperatorAdapter: PDFJS_DISPLAY_OPERATOR_ADAPTER,
        renderIntent: 'display',
        annotationMode: 'enable',
        sourceTextLedgerSha256: pdfTextLedgerSha256(ledgerText),
        ownedTextLedgerSpans: [
          { start: nonOwnedPaintCount, end: nonOwnedPaintCount + 1 },
        ],
        excludedTextLedgerSpans: [{ start: 0, end: 1 }],
        ownedSourceBoxes: [interiorOwner],
        excludedSourceBoxes: [
          {
            ...precedingLineBox,
            x: 0.12,
            y: 0.11,
          },
        ],
      },
      maximumPixels: 400,
    }),
  ).rejects.toThrow(/stale or unsafe/i)
  expect(render).not.toHaveBeenCalled()
  expect(canvasFactory.destroy).not.toHaveBeenCalled()
})

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

it('uses the exact private DISPLAY stream when public DISPLAY|OPLIST indexes differ', async () => {
  const ownedBox = {
    ...interiorOwner,
    x: 0.19,
    y: 0.19,
    width: 0.03,
    height: 0.03,
  }
  const excludedBox = {
    ...precedingLineBox,
    x: 0.145,
    y: 0.145,
    width: 0.02,
    height: 0.02,
  }
  const canvasFactory = {
    create: () => {
      const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
      return {
        canvas: { width, height },
        context: {
          pixels,
          fillStyle: '',
          fillRect: vi.fn(),
          getImageData: vi.fn(() => ({ data: pixels })),
        },
      }
    },
    destroy: vi.fn(),
  }
  const glyphs = (text: string) => [[...text].map((unicode) => ({ unicode }))]
  const displayOperatorList = {
    fnArray: [31, 44, 40, 44, 32],
    argsArray: [[], glyphs('Multiplyby2:'), [0, 10], glyphs('√x=y'), []],
    lastChunk: true,
    separateAnnots: null,
  }
  const publicOperatorList = {
    fnArray: [31, 40, 40, 40, 40, 40, 40, 44, 40, 44, 32],
    argsArray: [
      [],
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 1],
      glyphs('Multiply by 2:'),
      [0, 10],
      glyphs('√x = y'),
      [],
    ],
  }
  const capability = (() => {
    let resolve!: (value: unknown) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    return { promise, resolve, reject }
  })()
  capability.resolve(false)
  const displayIntentState = Object.assign(Object.create(null), {
    displayReadyCapability: capability,
    operatorList: displayOperatorList,
    renderTasks: new Set(),
    streamReader: null,
  })
  const publicIntentState = Object.assign(Object.create(null), {
    opListReadCapability: capability,
    operatorList: {
      ...publicOperatorList,
      lastChunk: true,
      separateAnnots: null,
    },
    renderTasks: new Set(),
    streamReader: null,
  })
  const page = {
    pageNumber: 1,
    _intentStates: new Map<string, unknown>([
      ['258__', publicIntentState],
      ['2__', displayIntentState],
    ]),
    getOperatorList: vi.fn(async () => publicOperatorList),
    getViewport: ({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 100 * scale,
      rotation: 0,
    }),
    render: (options: Parameters<PdfPageCropSource['render']>[0]) => {
      const pixels = (
        options.canvasContext as typeof options.canvasContext & {
          pixels: Uint8ClampedArray
        }
      ).pixels
      blackPixel(pixels, 10, 10)
      blackPixel(pixels, 10, 11)
      blackPixel(pixels, 11, 10)
      blackPixel(pixels, 11, 11)
      if (!options.operationsFilter) {
        blackPixel(pixels, 5, 5)
      } else {
        const decisions = [0, 1, 1, 2, 3, 4].map((index) =>
          options.operationsFilter!(index),
        )
        if (decisions[1]) blackPixel(pixels, 5, 5)
      }
      return { promise: Promise.resolve() }
    },
  }
  const observedPublicList = await page.getOperatorList()
  expect(observedPublicList.fnArray.indexOf(44)).toBe(7)
  const raster = await renderPdfPageCrop({
    page,
    canvasFactory,
    sourceBox,
    sourceTextOperationFilter: {
      algorithm: 'pdfjs-display-text-operation-filter-v2',
      expansionPixels: 0,
      pdfjsVersion: PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION,
      pdfjsBuild: PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD,
      displayOperatorAdapter: PDFJS_DISPLAY_OPERATOR_ADAPTER,
      renderIntent: 'display',
      annotationMode: 'enable',
      sourceTextLedgerSha256: pdfTextLedgerSha256('Multiplyby2:√x=y'),
      ownedTextLedgerSpans: [{ start: 12, end: 16 }],
      excludedTextLedgerSpans: [{ start: 0, end: 12 }],
      ownedSourceBoxes: [ownedBox],
      excludedSourceBoxes: [excludedBox],
    },
    maximumPixels: 400,
  })

  expect(raster.pixels[(10 * width + 10) * 4]).toBe(0)
  expect(raster.pixels[(5 * width + 5) * 4]).toBe(255)
  expect(raster.sourceExclusionMask).toMatchObject({
    algorithm: 'pdfjs-display-text-operation-filter-v2',
    changedPixelCount: 1,
    ownedOperationIndexes: [3],
    excludedOperationIndexes: [1],
    ownedOnlyExcludedOperationIndexes: [1],
  })
  if (
    raster.sourceExclusionMask?.algorithm ===
    'pdfjs-display-text-operation-filter-v2'
  ) {
    expect(raster.sourceExclusionMask.ownedOnlyRgbaSha256).toBe(
      raster.sourceExclusionMask.filteredRgbaSha256,
    )
  }
  expect(canvasFactory.destroy).toHaveBeenCalledTimes(4)
  expect(isTrustedPdfTextOperationFilterRaster(raster)).toBe(true)
  const assetInput = {
    kind: 'equation' as const,
    cropBox: raster.sourceBox,
    sourceObjectIds: ['trusted-operation-filter-source'],
    sourceBoxes: [ownedBox],
    width: raster.width,
    height: raster.height,
    pixels: raster.pixels,
    resolutionDpi: raster.resolutionDpi,
    sourceExclusionMask: raster.sourceExclusionMask,
  }
  await expect(createSourcePageCropAsset(assetInput)).rejects.toThrow(
    /text operation proof/i,
  )
  const asset = await createSourcePageCropAsset(assetInput, raster)
  expect(isTrustedPdfTextOperationFilterAsset(asset)).toBe(true)
  const pendingInput = {
    ...assetInput,
    cropBox: { ...assetInput.cropBox },
    sourceObjectIds: [...assetInput.sourceObjectIds],
    sourceBoxes: assetInput.sourceBoxes.map((box) => ({ ...box })),
  }
  const originalPendingPixel = pendingInput.pixels[0]
  const pendingAssetPromise = createSourcePageCropAsset(pendingInput, raster)
  pendingInput.sourceObjectIds[0] = 'mutated-after-promise-start'
  pendingInput.sourceBoxes[0].x += 0.01
  pendingInput.cropBox.x += 0.01
  pendingInput.pixels[0] ^= 1
  const snapshottedAsset = await pendingAssetPromise
  pendingInput.pixels[0] = originalPendingPixel
  expect(snapshottedAsset.sourceObjectIds).toEqual([
    'trusted-operation-filter-source',
  ])
  expect(snapshottedAsset.sourceBoxes[0].x).toBe(ownedBox.x)
  expect(snapshottedAsset.sourceCropBox?.x).toBe(raster.sourceBox.x)
  expect(isTrustedPdfTextOperationFilterAsset(snapshottedAsset)).toBe(true)
  const originalAssetSha256 = asset.sha256
  const assetMutations: Array<{
    mutate(): void
    restore(): void
  }> = [
    {
      mutate: () => {
        asset.id += '-mutated'
      },
      restore: () => {
        asset.id = asset.id.replace(/-mutated$/u, '')
      },
    },
    {
      mutate: () => {
        asset.href += '.mutated'
      },
      restore: () => {
        asset.href = asset.href.replace(/\.mutated$/u, '')
      },
    },
    {
      mutate: () => {
        asset.mediaType = 'image/svg+xml'
      },
      restore: () => {
        asset.mediaType = 'image/png'
      },
    },
    {
      mutate: () => {
        asset.kind = 'table'
      },
      restore: () => {
        asset.kind = 'equation'
      },
    },
    {
      mutate: () => {
        asset.rendition = 'profile-downscaled'
      },
      restore: () => {
        asset.rendition = 'source-page-crop'
      },
    },
    {
      mutate: () => {
        asset.sha256 = '0'.repeat(64)
      },
      restore: () => {
        asset.sha256 = originalAssetSha256
      },
    },
    {
      mutate: () => {
        asset.width += 1
      },
      restore: () => {
        asset.width -= 1
      },
    },
    {
      mutate: () => {
        asset.height += 1
      },
      restore: () => {
        asset.height -= 1
      },
    },
    {
      mutate: () => {
        asset.resolutionDpi! += 1
      },
      restore: () => {
        asset.resolutionDpi! -= 1
      },
    },
    {
      mutate: () => {
        asset.sourceObjectIds[0] += '-mutated'
      },
      restore: () => {
        asset.sourceObjectIds[0] = asset.sourceObjectIds[0].replace(
          /-mutated$/u,
          '',
        )
      },
    },
    {
      mutate: () => {
        asset.sourceBoxes[0].x += 0.001
      },
      restore: () => {
        asset.sourceBoxes[0].x -= 0.001
      },
    },
  ]
  for (const mutation of assetMutations) {
    mutation.mutate()
    expect(isTrustedPdfTextOperationFilterAsset(asset)).toBe(false)
    mutation.restore()
    expect(isTrustedPdfTextOperationFilterAsset(asset)).toBe(true)
  }
  await expect(downscalePngAsset(asset, 4, 264)).resolves.toBe(asset)

  const originalRasterX = raster.sourceBox.x
  raster.sourceBox.x += 0.001
  expect(isTrustedPdfTextOperationFilterRaster(raster)).toBe(false)
  raster.sourceBox.x = originalRasterX
  expect(isTrustedPdfTextOperationFilterRaster(raster)).toBe(true)
  if (
    raster.sourceExclusionMask?.algorithm ===
    'pdfjs-display-text-operation-filter-v2'
  ) {
    raster.sourceExclusionMask.changedPixelCount += 1
    expect(isTrustedPdfTextOperationFilterRaster(raster)).toBe(false)
    raster.sourceExclusionMask.changedPixelCount -= 1
  }
  expect(isTrustedPdfTextOperationFilterRaster(raster)).toBe(true)
  raster.pixels[0] ^= 1
  expect(isTrustedPdfTextOperationFilterRaster(raster)).toBe(false)

  const originalAssetX = asset.sourceCropBox!.x
  asset.sourceCropBox!.x += 0.001
  expect(isTrustedPdfTextOperationFilterAsset(asset)).toBe(false)
  asset.sourceCropBox!.x = originalAssetX
  expect(isTrustedPdfTextOperationFilterAsset(asset)).toBe(true)
  if (
    asset.sourceExclusionMask?.algorithm ===
    'pdfjs-display-text-operation-filter-v2'
  ) {
    asset.sourceExclusionMask.changedPixelCount += 1
    expect(isTrustedPdfTextOperationFilterAsset(asset)).toBe(false)
    asset.sourceExclusionMask.changedPixelCount -= 1
  }
  expect(isTrustedPdfTextOperationFilterAsset(asset)).toBe(true)
  asset.bytes[0] ^= 1
  expect(isTrustedPdfTextOperationFilterAsset(asset)).toBe(false)
})

it('bounds a pixel-derived text-operation diff to a fractional declared crop', async () => {
  const fractionalCrop = {
    page: 1,
    x: 0.1017,
    y: 0.1031,
    width: 0.2033,
    height: 0.2069,
    rotation: 0,
    method: 'pdf-object' as const,
  }
  const ownedBox = {
    ...fractionalCrop,
    x: 0.17,
    y: 0.17,
    width: 0.04,
    height: 0.04,
    method: 'pdf-text' as const,
  }
  const excludedBox = {
    ...fractionalCrop,
    x: fractionalCrop.x + fractionalCrop.width - 0.005,
    y: fractionalCrop.y + fractionalCrop.height - 0.005,
    width: 0.015,
    height: 0.015,
    method: 'pdf-text' as const,
  }
  const glyphs = (text: string) => [[...text].map((unicode) => ({ unicode }))]
  const operatorList = {
    fnArray: [31, 44, 40, 44, 32],
    argsArray: [[], glyphs('edge'), [0, 10], glyphs('own'), []],
    lastChunk: true,
    separateAnnots: null,
  }
  const capability = (() => {
    let resolve!: (value: unknown) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    return { promise, resolve, reject }
  })()
  capability.resolve(false)
  const displayIntentState = Object.assign(Object.create(null), {
    displayReadyCapability: capability,
    operatorList,
    renderTasks: new Set(),
    streamReader: null,
  })
  const canvasFactory = {
    create: (rasterWidth: number, rasterHeight: number) => {
      const pixels = new Uint8ClampedArray(rasterWidth * rasterHeight * 4).fill(
        255,
      )
      return {
        canvas: { width: rasterWidth, height: rasterHeight },
        context: {
          pixels,
          fillStyle: '',
          fillRect: vi.fn(),
          getImageData: vi.fn(() => ({ data: pixels })),
        },
      }
    },
    destroy: vi.fn(),
  }
  const page = {
    pageNumber: 1,
    _intentStates: new Map<string, unknown>([['2__', displayIntentState]]),
    getViewport: ({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 100 * scale,
      rotation: 0,
    }),
    render: (options: Parameters<PdfPageCropSource['render']>[0]) => {
      const canvas = options.canvas as { width: number; height: number }
      const pixels = (
        options.canvasContext as typeof options.canvasContext & {
          pixels: Uint8ClampedArray
        }
      ).pixels
      const setBlack = (x: number, y: number) => {
        pixels[(y * canvas.width + x) * 4] = 0
      }
      const centerX = Math.floor(canvas.width / 2)
      const centerY = Math.floor(canvas.height / 2)
      setBlack(centerX, centerY)
      setBlack(centerX + 1, centerY)
      setBlack(centerX, centerY + 1)
      setBlack(centerX + 1, centerY + 1)
      if (!options.operationsFilter) {
        setBlack(canvas.width - 1, canvas.height - 1)
      } else {
        const decisions = Array.from({ length: 5 }, (_unused, index) =>
          options.operationsFilter!(index),
        )
        if (decisions[1]) setBlack(canvas.width - 1, canvas.height - 1)
      }
      return { promise: Promise.resolve() }
    },
  }
  const raster = await renderPdfPageCrop({
    page,
    canvasFactory,
    sourceBox: fractionalCrop,
    sourceTextOperationFilter: {
      algorithm: 'pdfjs-display-text-operation-filter-v2',
      expansionPixels: 0,
      pdfjsVersion: PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION,
      pdfjsBuild: PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD,
      displayOperatorAdapter: PDFJS_DISPLAY_OPERATOR_ADAPTER,
      renderIntent: 'display',
      annotationMode: 'enable',
      sourceTextLedgerSha256: pdfTextLedgerSha256('edgeown'),
      ownedTextLedgerSpans: [{ start: 4, end: 7 }],
      excludedTextLedgerSpans: [{ start: 0, end: 4 }],
      ownedSourceBoxes: [ownedBox],
      excludedSourceBoxes: [excludedBox],
    },
    maximumPixels: 400,
  })
  const operationMask = raster.sourceExclusionMask
  expect(operationMask?.algorithm).toBe(
    'pdfjs-display-text-operation-filter-v2',
  )
  if (
    !operationMask ||
    operationMask.algorithm !== 'pdfjs-display-text-operation-filter-v2'
  ) {
    throw new Error('expected a V2 text-operation exclusion mask')
  }
  const diffBox = operationMask.normalizedDiffBox
  expect(diffBox.x).toBeGreaterThanOrEqual(fractionalCrop.x)
  expect(diffBox.y).toBeGreaterThanOrEqual(fractionalCrop.y)
  expect(
    diffBox.x + diffBox.width - (fractionalCrop.x + fractionalCrop.width),
  ).toBeLessThanOrEqual(1e-10)
  expect(
    diffBox.y + diffBox.height - (fractionalCrop.y + fractionalCrop.height),
  ).toBeLessThanOrEqual(1e-10)

  const asset = await createSourcePageCropAsset(
    {
      kind: 'equation',
      cropBox: raster.sourceBox,
      sourceObjectIds: ['fractional-crop-equation'],
      sourceBoxes: [ownedBox],
      width: raster.width,
      height: raster.height,
      pixels: raster.pixels,
      resolutionDpi: raster.resolutionDpi,
      sourceExclusionMask: raster.sourceExclusionMask,
    },
    raster,
  )
  expect(isTrustedPdfTextOperationFilterAsset(asset)).toBe(true)
})

it('still rejects text-operation ownership that extends outside the declared crop', async () => {
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
        create: () => {
          const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
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
      sourceTextOperationFilter: {
        algorithm: 'pdfjs-display-text-operation-filter-v2',
        expansionPixels: 0,
        pdfjsVersion: PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION,
        pdfjsBuild: PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD,
        displayOperatorAdapter: PDFJS_DISPLAY_OPERATOR_ADAPTER,
        renderIntent: 'display',
        annotationMode: 'enable',
        sourceTextLedgerSha256: pdfTextLedgerSha256('edgeown'),
        ownedTextLedgerSpans: [{ start: 4, end: 7 }],
        excludedTextLedgerSpans: [{ start: 0, end: 4 }],
        ownedSourceBoxes: [
          {
            ...interiorOwner,
            x: sourceBox.x + sourceBox.width - 0.01,
            width: 0.02,
          },
        ],
        excludedSourceBoxes: [precedingLineBox],
      },
      maximumPixels: 400,
    }),
  ).rejects.toThrow(/text operation filter is invalid/i)
})

it('rejects selected filtering when an unowned DISPLAY text paint remains', async () => {
  const glyphs = (text: string) => [[...text].map((unicode) => ({ unicode }))]
  const operatorList = {
    fnArray: [31, 44, 40, 44, 40, 44, 32],
    argsArray: [
      [],
      glyphs('cue'),
      [0, 10],
      glyphs('own'),
      [0, 10],
      glyphs('rogue'),
      [],
    ],
    lastChunk: true,
    separateAnnots: null,
  }
  const capability = (() => {
    let resolve!: (value: unknown) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    return { promise, resolve, reject }
  })()
  capability.resolve(false)
  const displayIntentState = Object.assign(Object.create(null), {
    displayReadyCapability: capability,
    operatorList,
    renderTasks: new Set(),
    streamReader: null,
  })
  const canvasFactory = {
    create: () => {
      const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
      return {
        canvas: { width, height },
        context: {
          pixels,
          fillStyle: '',
          fillRect: vi.fn(),
          getImageData: vi.fn(() => ({ data: pixels })),
        },
      }
    },
    destroy: vi.fn(),
  }
  const page = {
    pageNumber: 1,
    _intentStates: new Map<string, unknown>([['2__', displayIntentState]]),
    getViewport: ({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 100 * scale,
      rotation: 0,
    }),
    render: (options: Parameters<PdfPageCropSource['render']>[0]) => {
      const pixels = (
        options.canvasContext as typeof options.canvasContext & {
          pixels: Uint8ClampedArray
        }
      ).pixels
      if (!options.operationsFilter) {
        blackPixel(pixels, 5, 5)
        blackPixel(pixels, 10, 10)
        blackPixel(pixels, 15, 15)
      } else {
        const decisions = Array.from({ length: 7 }, (_unused, index) =>
          options.operationsFilter!(index),
        )
        options.operationsFilter!(6)
        if (decisions[1]) blackPixel(pixels, 5, 5)
        if (decisions[3]) blackPixel(pixels, 10, 10)
        if (decisions[5]) blackPixel(pixels, 15, 15)
      }
      return { promise: Promise.resolve() }
    },
  }

  await expect(
    renderPdfPageCrop({
      page,
      canvasFactory,
      sourceBox,
      sourceTextOperationFilter: {
        algorithm: 'pdfjs-display-text-operation-filter-v2',
        expansionPixels: 0,
        pdfjsVersion: PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION,
        pdfjsBuild: PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD,
        displayOperatorAdapter: PDFJS_DISPLAY_OPERATOR_ADAPTER,
        renderIntent: 'display',
        annotationMode: 'enable',
        sourceTextLedgerSha256: pdfTextLedgerSha256('cueownrogue'),
        ownedTextLedgerSpans: [{ start: 3, end: 6 }],
        excludedTextLedgerSpans: [{ start: 0, end: 3 }],
        ownedSourceBoxes: [
          {
            ...interiorOwner,
            x: 0.19,
            y: 0.19,
            width: 0.03,
            height: 0.03,
          },
        ],
        excludedSourceBoxes: [
          {
            ...precedingLineBox,
            x: 0.145,
            y: 0.145,
            width: 0.02,
            height: 0.02,
          },
        ],
      },
      maximumPixels: 400,
    }),
  ).rejects.toThrow(/unowned DISPLAY text paint/i)
  expect(canvasFactory.destroy).toHaveBeenCalledTimes(4)
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

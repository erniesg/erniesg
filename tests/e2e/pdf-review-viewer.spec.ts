import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { installStaticRoutes } from './static-build'

const fixturePath = path.resolve('tests/fixtures/pdf/pdf-to-epub-fidelity.pdf')
const fixtureContractPath = path.resolve(
  'tests/fixtures/pdf/pdf-to-epub-fidelity.contract.json',
)
const corpusContractPath = path.resolve(
  'benchmarks/pdf/corpus-contract-v2.json',
)
const stressFixtureId = '2501.09223v1'
const stressFixturePath = path.resolve(
  `node_modules/.cache/erniesg-pdf-corpus-20260728/${stressFixtureId}.pdf`,
)
const stressFixtureSha256 =
  '8b8f659beda18f55ab82191bde2d0d8090ae73925b2c7ea3e8d9171857cc506a'
const stressFixtureUrl = `https://arxiv.org/pdf/${stressFixtureId}`
const stressFixturePageCount = 231
const sourceFixturePageCount = 3
const cssPixelTolerance = 1
const reviewFitGutterCssPixels = 48

const reviewViewportGeometry = {
  phone: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  'paper-pro-move': { width: 954, height: 1696 },
  'paper-pro': { width: 1620, height: 2160 },
} as const

type ReviewViewportId = keyof typeof reviewViewportGeometry
type ReviewOrientation = 'portrait' | 'landscape'

function expectedReviewViewport(
  viewportId: ReviewViewportId,
  orientation: ReviewOrientation,
) {
  const portrait = reviewViewportGeometry[viewportId]
  return orientation === 'portrait'
    ? portrait
    : { width: portrait.height, height: portrait.width }
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function pdfPageCount(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: true,
  })
  const document = await loadingTask.promise
  try {
    return document.numPages
  } finally {
    await document.destroy()
  }
}

test.beforeEach(async ({ page }) => installStaticRoutes(page))

async function waitForReviewPage(page: Page) {
  const stage = page.getByRole('region', {
    name: 'Single Mobile EPUB page',
  })
  await expect(stage).toBeVisible({
    timeout: 90_000,
  })
  const frameElement = page.getByTitle('Generated EPUB rendition on Mobile')
  await expect(frameElement).toHaveAttribute(
    'sandbox',
    'allow-same-origin allow-scripts',
  )
  await expect(page.locator('.epub-rendition-preview--review')).toHaveAttribute(
    'data-review-pagination-status',
    'complete',
    {
      timeout: 90_000,
    },
  )
  const frame = frameElement.contentFrame()
  await expect(
    frame.locator('meta[http-equiv="Content-Security-Policy"]'),
  ).toHaveAttribute('content', /script-src 'none'/u)
  await expect(
    frame.locator('[data-review-page-fragment]:not([hidden])'),
  ).toHaveCount(1, { timeout: 90_000 })
  return { stage, frame }
}

type MainThreadResponsivenessReceipt = {
  maximumLagMs: number
  samples: number
}

type MainThreadResponsivenessProbe = MainThreadResponsivenessReceipt & {
  intervalMs: number
  lastTickMs: number
  timerId: number
}

type ResponsivenessProbeWindow = Window & {
  __srtMainThreadResponsivenessProbe?: MainThreadResponsivenessProbe
}

async function installMainThreadResponsivenessProbe(
  page: Page,
  intervalMs = 20,
) {
  await page.evaluate((probeIntervalMs) => {
    const scope = window as ResponsivenessProbeWindow
    const previous = scope.__srtMainThreadResponsivenessProbe
    if (previous) window.clearInterval(previous.timerId)

    const probe: MainThreadResponsivenessProbe = {
      intervalMs: probeIntervalMs,
      lastTickMs: performance.now(),
      maximumLagMs: 0,
      samples: 0,
      timerId: 0,
    }
    probe.timerId = window.setInterval(() => {
      const now = performance.now()
      probe.maximumLagMs = Math.max(
        probe.maximumLagMs,
        now - probe.lastTickMs - probe.intervalMs,
      )
      probe.lastTickMs = now
      probe.samples += 1
    }, probe.intervalMs)
    scope.__srtMainThreadResponsivenessProbe = probe
  }, intervalMs)
}

async function readMainThreadResponsivenessProbe(
  page: Page,
): Promise<MainThreadResponsivenessReceipt> {
  return page.evaluate(() => {
    const probe = (window as ResponsivenessProbeWindow)
      .__srtMainThreadResponsivenessProbe
    if (!probe) throw new Error('Main-thread responsiveness probe is missing.')
    return {
      maximumLagMs: Math.max(
        probe.maximumLagMs,
        performance.now() - probe.lastTickMs - probe.intervalMs,
      ),
      samples: probe.samples,
    }
  })
}

test('browser-side responsiveness probe detects a blocked page event loop', async ({
  page,
}) => {
  await page.setContent('<main>Responsiveness probe fixture</main>')
  await installMainThreadResponsivenessProbe(page)
  await page.waitForTimeout(50)
  await page.evaluate(() => {
    const blockedUntil = performance.now() + 150
    while (performance.now() < blockedUntil) {
      // This deliberate busy loop models a real browser main-thread stall.
    }
  })
  await page.waitForTimeout(50)

  const receipt = await readMainThreadResponsivenessProbe(page)
  expect(receipt.samples).toBeGreaterThan(0)
  expect(receipt.maximumLagMs).toBeGreaterThan(100)

  await page.evaluate(() => {
    const probe = (window as ResponsivenessProbeWindow)
      .__srtMainThreadResponsivenessProbe!
    window.clearInterval(probe.timerId)
    probe.maximumLagMs = 0
    probe.lastTickMs = performance.now() - probe.intervalMs - 150
  })
  const trailingReceipt = await readMainThreadResponsivenessProbe(page)
  expect(trailingReceipt.maximumLagMs).toBeGreaterThan(100)
})

test('materializes one complete responsive EPUB page with matching PDF controls', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const [bytes, fixtureContractBytes] = await Promise.all([
    readFile(fixturePath),
    readFile(fixtureContractPath, 'utf8'),
  ])
  const fixtureContract = JSON.parse(fixtureContractBytes) as {
    fixture: string
    sourceSha256: string
    note: { label: string; text: string }
  }
  expect(path.basename(fixturePath)).toBe(fixtureContract.fixture)
  expect(sha256(bytes)).toBe(fixtureContract.sourceSha256)
  expect(fixtureContract.note.label).not.toBe('')
  expect(fixtureContract.note.text).not.toBe('')
  await page.route('https://arxiv.org/pdf/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: bytes,
    })
  })
  await page.goto('/research/pdf-review')
  const { stage, frame } = await waitForReviewPage(page)

  const assertCompletePage = async (
    expectedViewport: { width: number; height: number },
    expectedPage?: number,
    expectedPageCount?: number,
  ) => {
    await expect(
      frame.locator('[data-review-page-fragment]:not([hidden])'),
    ).toHaveCount(1, { timeout: 15_000 })
    const geometry = await frame.locator('body').evaluate(() => {
      const visiblePages = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-review-page-fragment]:not([hidden])',
        ),
      ]
      const fragment = visiblePages[0]
      const pagesRoot = document.querySelector<HTMLElement>(
        '[data-review-pages]',
      )
      const fragmentRect = fragment?.getBoundingClientRect()
      const pagesRect = pagesRoot?.getBoundingClientRect()
      return {
        visiblePageCount: visiblePages.length,
        viewport: [innerWidth, innerHeight],
        documentViewport: [
          document.documentElement.clientWidth,
          document.documentElement.clientHeight,
        ],
        selectedPage: Number(pagesRoot?.dataset.reviewPage ?? 0),
        visiblePage: Number(fragment?.dataset.reviewPageFragment ?? 0),
        fragmentCount: pagesRoot?.children.length ?? 0,
        hiddenFragmentsValid: pagesRoot
          ? [...pagesRoot.children].every((candidate) => {
              const element = candidate as HTMLElement
              const selected = element === fragment
              return (
                element.hidden === !selected &&
                element.getAttribute('aria-hidden') ===
                  (selected ? 'false' : 'true')
              )
            })
          : false,
        fragmentEdges: fragmentRect
          ? [
              fragmentRect.left,
              fragmentRect.top,
              fragmentRect.right,
              fragmentRect.bottom,
            ]
          : null,
        pagesEdges: pagesRect
          ? [pagesRect.left, pagesRect.top, pagesRect.right, pagesRect.bottom]
          : null,
        fragment: fragment
          ? [
              fragment.getBoundingClientRect().width,
              fragment.getBoundingClientRect().height,
            ]
          : null,
        htmlOverflow:
          document.documentElement.scrollWidth >
            document.documentElement.clientWidth + 1 ||
          document.documentElement.scrollHeight >
            document.documentElement.clientHeight + 1,
        bodyOverflow:
          document.body.scrollWidth > document.body.clientWidth + 1 ||
          document.body.scrollHeight > document.body.clientHeight + 1,
        fragmentOverflow: fragment
          ? fragment.scrollWidth > fragment.clientWidth + 1 ||
            fragment.scrollHeight > fragment.clientHeight + 1
          : true,
        pageBodyOverflow: (() => {
          const body = fragment?.querySelector<HTMLElement>(
            '[data-review-page-body]',
          )
          return !body
            ? true
            : body.scrollWidth > body.clientWidth + 1 ||
                body.scrollHeight > body.clientHeight + 1
        })(),
        pageBodyMetrics: (() => {
          const body = fragment?.querySelector<HTMLElement>(
            '[data-review-page-body]',
          )
          return body
            ? [
                body.clientWidth,
                body.clientHeight,
                body.scrollWidth,
                body.scrollHeight,
              ]
            : null
        })(),
        pageBodyChildren: (() => {
          const body = fragment?.querySelector<HTMLElement>(
            '[data-review-page-body]',
          )
          return body
            ? [...body.children].map((child) => {
                const element = child as HTMLElement
                const rect = element.getBoundingClientRect()
                return {
                  tag: element.tagName,
                  id: element.id,
                  atomicFit: element.dataset.reviewAtomicFit ?? null,
                  top: Math.round(rect.top),
                  bottom: Math.round(rect.bottom),
                  height: Math.round(rect.height),
                  scrollHeight: element.scrollHeight,
                  clientHeight: element.clientHeight,
                }
              })
            : []
        })(),
        pageNotesOverflow: (() => {
          const notes = fragment?.querySelector<HTMLElement>(
            '[data-review-page-notes]',
          )
          return !notes
            ? true
            : notes.scrollWidth > notes.clientWidth + 1 ||
                notes.scrollHeight > notes.clientHeight + 1
        })(),
        clippedAtomicObjects: (() => {
          const body = fragment?.querySelector<HTMLElement>(
            '[data-review-page-body]',
          )
          if (!body) return ['missing-page-body']
          const bodyRect = body.getBoundingClientRect()
          return [
            ...body.querySelectorAll<HTMLElement>(
              ':scope > figure, :scope > table, :scope > pre, :scope > blockquote, :scope > [data-review-atomic-fit]',
            ),
          ]
            .filter((element) => {
              const rect = element.getBoundingClientRect()
              const outsideBody =
                rect.left < bodyRect.left - 1 ||
                rect.right > bodyRect.right + 1 ||
                rect.top < bodyRect.top - 1 ||
                rect.bottom > bodyRect.bottom + 1
              if (outsideBody) return true
              if (element.dataset.reviewAtomicFit === 'true') {
                return [...element.children].some((child) => {
                  const childRect = child.getBoundingClientRect()
                  return (
                    childRect.left < rect.left - 1 ||
                    childRect.right > rect.right + 1 ||
                    childRect.top < rect.top - 1 ||
                    childRect.bottom > rect.bottom + 1
                  )
                })
              }
              return (
                element.scrollWidth > element.clientWidth + 1 ||
                element.scrollHeight > element.clientHeight + 1
              )
            })
            .map(
              (element) =>
                element.id ||
                element.dataset.objectType ||
                element.tagName.toLocaleLowerCase(),
            )
        })(),
        nestedHorizontalScrollers: [
          ...document.querySelectorAll<HTMLElement>(
            '[data-review-page-fragment]:not([hidden]) *',
          ),
        ]
          .filter((element) => {
            if (element.closest('[data-review-atomic-fit="true"]')) return false
            const overflowX = getComputedStyle(element).overflowX
            return (
              (overflowX === 'auto' || overflowX === 'scroll') &&
              element.scrollWidth > element.clientWidth + 1
            )
          })
          .map(
            (element) =>
              element.id ||
              element.className ||
              element.dataset.objectType ||
              element.tagName.toLocaleLowerCase(),
          ),
      }
    })
    const pasteboard = await stage.evaluate((element) => {
      const shell = element.querySelector<HTMLElement>(
        '.epub-preview-device-shell',
      )
      const device = element.querySelector<HTMLElement>('.epub-preview-device')
      const frame = element.querySelector<HTMLIFrameElement>('iframe')
      const stageRect = element.getBoundingClientRect()
      const shellRect = shell?.getBoundingClientRect()
      const deviceRect = device?.getBoundingClientRect()
      const frameRect = frame?.getBoundingClientRect()
      const style = getComputedStyle(element)
      const deviceStyle = device ? getComputedStyle(device) : null
      const padding = {
        top: Number.parseFloat(style.paddingTop),
        right: Number.parseFloat(style.paddingRight),
        bottom: Number.parseFloat(style.paddingBottom),
        left: Number.parseFloat(style.paddingLeft),
      }
      const border = {
        top: Number.parseFloat(style.borderTopWidth),
        right: Number.parseFloat(style.borderRightWidth),
        bottom: Number.parseFloat(style.borderBottomWidth),
        left: Number.parseFloat(style.borderLeftWidth),
      }
      const devicePadding = {
        top: Number.parseFloat(deviceStyle?.paddingTop ?? '0'),
        right: Number.parseFloat(deviceStyle?.paddingRight ?? '0'),
        bottom: Number.parseFloat(deviceStyle?.paddingBottom ?? '0'),
        left: Number.parseFloat(deviceStyle?.paddingLeft ?? '0'),
      }
      const deviceBorder = {
        top: Number.parseFloat(deviceStyle?.borderTopWidth ?? '0'),
        right: Number.parseFloat(deviceStyle?.borderRightWidth ?? '0'),
        bottom: Number.parseFloat(deviceStyle?.borderBottomWidth ?? '0'),
        left: Number.parseFloat(deviceStyle?.borderLeftWidth ?? '0'),
      }
      return {
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
        padding,
        border,
        devicePadding,
        deviceBorder,
        stageEdges: [
          stageRect.left,
          stageRect.top,
          stageRect.right,
          stageRect.bottom,
        ],
        scale: Number.parseFloat(
          shell?.style.getPropertyValue('--epub-review-scale') ?? '0',
        ),
        shellCssWidth: Number.parseFloat(
          shell?.style.getPropertyValue('--epub-review-shell-width') ?? '0',
        ),
        shellCssHeight: Number.parseFloat(
          shell?.style.getPropertyValue('--epub-review-shell-height') ?? '0',
        ),
        deviceCssWidth: Number.parseFloat(
          shell?.style.getPropertyValue('--epub-device-width') ?? '0',
        ),
        deviceCssHeight: Number.parseFloat(
          shell?.style.getPropertyValue('--epub-device-height') ?? '0',
        ),
        shellEdges: shellRect
          ? [shellRect.left, shellRect.top, shellRect.right, shellRect.bottom]
          : null,
        shellSize: shellRect ? [shellRect.width, shellRect.height] : null,
        deviceSize: deviceRect ? [deviceRect.width, deviceRect.height] : null,
        frameSize: frameRect ? [frameRect.width, frameRect.height] : null,
        deviceContentSize: device
          ? [
              device.clientWidth - devicePadding.left - devicePadding.right,
              device.clientHeight - devicePadding.top - devicePadding.bottom,
            ]
          : null,
        frameClientSize: frame ? [frame.clientWidth, frame.clientHeight] : null,
        frameViewport: frame?.contentWindow
          ? [frame.contentWindow.innerWidth, frame.contentWindow.innerHeight]
          : null,
      }
    })
    expect(pasteboard.scale).toBeGreaterThan(0)
    expect(pasteboard.deviceCssWidth).toBe(expectedViewport.width)
    expect(pasteboard.deviceCssHeight).toBe(expectedViewport.height)

    expect(pasteboard.deviceContentSize).not.toBeNull()
    const expectedDeviceContentWidth =
      expectedViewport.width -
      pasteboard.deviceBorder.left -
      pasteboard.deviceBorder.right -
      pasteboard.devicePadding.left -
      pasteboard.devicePadding.right
    const expectedDeviceContentHeight =
      expectedViewport.height -
      pasteboard.deviceBorder.top -
      pasteboard.deviceBorder.bottom -
      pasteboard.devicePadding.top -
      pasteboard.devicePadding.bottom
    expect(
      Math.abs(pasteboard.deviceContentSize![0] - expectedDeviceContentWidth),
    ).toBeLessThanOrEqual(cssPixelTolerance)
    expect(
      Math.abs(pasteboard.deviceContentSize![1] - expectedDeviceContentHeight),
    ).toBeLessThanOrEqual(cssPixelTolerance)
    expect(pasteboard.frameClientSize).toEqual(pasteboard.deviceContentSize)
    expect(pasteboard.frameViewport).toEqual(pasteboard.frameClientSize)

    expect(geometry.visiblePageCount).toBe(1)
    expect(geometry.viewport).toEqual(pasteboard.frameViewport)
    expect(geometry.documentViewport).toEqual(geometry.viewport)
    expect(geometry.fragment).toEqual(geometry.viewport)
    expect(geometry.fragmentEdges).toEqual([
      0,
      0,
      geometry.viewport[0],
      geometry.viewport[1],
    ])
    expect(geometry.pagesEdges).toEqual(geometry.fragmentEdges)
    expect(geometry.fragmentCount).toBeGreaterThan(0)
    if (expectedPageCount !== undefined) {
      expect(geometry.fragmentCount).toBe(expectedPageCount)
    }
    expect(geometry.hiddenFragmentsValid).toBe(true)
    expect(geometry.selectedPage).toBe(geometry.visiblePage)
    if (expectedPage !== undefined) {
      expect(geometry.selectedPage).toBe(expectedPage)
    }
    expect(geometry.htmlOverflow).toBe(false)
    expect(geometry.bodyOverflow).toBe(false)
    expect(geometry.fragmentOverflow).toBe(false)
    expect(geometry.pageBodyOverflow, JSON.stringify(geometry)).toBe(false)
    expect(geometry.pageNotesOverflow, JSON.stringify(geometry)).toBe(false)
    expect(geometry.clippedAtomicObjects, JSON.stringify(geometry)).toEqual([])
    expect(
      geometry.nestedHorizontalScrollers,
      JSON.stringify(geometry),
    ).toEqual([])

    const expectedFitScale = Math.min(
      Math.max(
        0.05,
        (pasteboard.clientWidth - reviewFitGutterCssPixels) /
          expectedViewport.width,
      ),
      Math.max(
        0.05,
        (pasteboard.clientHeight - reviewFitGutterCssPixels) /
          expectedViewport.height,
      ),
    )
    const scaledWidth = expectedViewport.width * expectedFitScale
    const scaledHeight = expectedViewport.height * expectedFitScale
    expect(
      Math.abs(pasteboard.shellCssWidth - scaledWidth),
    ).toBeLessThanOrEqual(cssPixelTolerance)
    expect(
      Math.abs(pasteboard.shellCssHeight - scaledHeight),
    ).toBeLessThanOrEqual(cssPixelTolerance)
    expect(
      Math.min(
        Math.abs(
          pasteboard.clientWidth -
            reviewFitGutterCssPixels -
            pasteboard.shellCssWidth,
        ),
        Math.abs(
          pasteboard.clientHeight -
            reviewFitGutterCssPixels -
            pasteboard.shellCssHeight,
        ),
      ),
    ).toBeLessThanOrEqual(cssPixelTolerance)
    for (const size of [pasteboard.shellSize, pasteboard.deviceSize]) {
      expect(size).not.toBeNull()
      expect(Math.abs(size![0] - scaledWidth)).toBeLessThanOrEqual(
        cssPixelTolerance,
      )
      expect(Math.abs(size![1] - scaledHeight)).toBeLessThanOrEqual(
        cssPixelTolerance,
      )
    }
    expect(pasteboard.frameSize).not.toBeNull()
    expect(
      Math.abs(
        pasteboard.frameSize![0] -
          pasteboard.deviceContentSize![0] * expectedFitScale,
      ),
    ).toBeLessThanOrEqual(cssPixelTolerance)
    expect(
      Math.abs(
        pasteboard.frameSize![1] -
          pasteboard.deviceContentSize![1] * expectedFitScale,
      ),
    ).toBeLessThanOrEqual(cssPixelTolerance)
    expect(
      pasteboard.scrollWidth,
      JSON.stringify(pasteboard),
    ).toBeLessThanOrEqual(pasteboard.clientWidth + 1)
    expect(
      pasteboard.scrollHeight,
      JSON.stringify(pasteboard),
    ).toBeLessThanOrEqual(pasteboard.clientHeight + 1)
    expect(pasteboard.scrollLeft).toBe(0)
    expect(pasteboard.scrollTop).toBe(0)
    const [stageLeft, stageTop, stageRight, stageBottom] = pasteboard.stageEdges
    const [shellLeft, shellTop, shellRight, shellBottom] =
      pasteboard.shellEdges!
    expect(shellLeft).toBeGreaterThanOrEqual(
      stageLeft + pasteboard.padding.left - 1,
    )
    expect(
      Math.abs(
        shellTop - (stageTop + pasteboard.border.top + pasteboard.padding.top),
      ),
    ).toBeLessThanOrEqual(cssPixelTolerance)
    expect(shellRight).toBeLessThanOrEqual(
      stageRight - pasteboard.padding.right + 1,
    )
    expect(shellBottom).toBeLessThanOrEqual(
      stageBottom - pasteboard.padding.bottom + 1,
    )
  }

  await assertCompletePage(expectedReviewViewport('phone', 'portrait'))

  const assertEqualNavigationButtons = async () => {
    const paneBoxes = await Promise.all(
      [
        page.locator('.pdf-source-page-viewer'),
        page.locator('.epub-rendition-preview--review'),
      ].map((scope) =>
        scope.locator('.page-navigation button').evaluateAll((buttons) =>
          buttons.map((button) => {
            const rect = button.getBoundingClientRect()
            return {
              width: rect.width,
              height: rect.height,
            }
          }),
        ),
      ),
    )
    expect(paneBoxes[0]).toHaveLength(2)
    expect(paneBoxes[1]).toHaveLength(2)
    const allButtons = paneBoxes.flat()
    expect(allButtons[0].width).toBeGreaterThan(0)
    expect(allButtons[0].height).toBeGreaterThan(0)
    for (const button of allButtons.slice(1)) {
      expect(button).toEqual(allButtons[0])
    }
  }
  await assertEqualNavigationButtons()
  await page.setViewportSize({ width: 820, height: 1200 })
  await assertEqualNavigationButtons()
  await page.setViewportSize({ width: 1440, height: 1200 })

  const pasteboardTops = await Promise.all([
    page
      .locator('.pdf-source-page-stage')
      .evaluate((element) => element.getBoundingClientRect().top),
    stage.evaluate((element) => element.getBoundingClientRect().top),
  ])
  expect(Math.abs(pasteboardTops[0] - pasteboardTops[1])).toBeLessThanOrEqual(1)

  const epubNavigation = page.locator(
    '.epub-rendition-preview--review .page-navigation',
  )
  const epubCounter = epubNavigation.locator('strong')
  const epubPageCount = Number(
    ((await epubCounter.textContent()) ?? '').match(/of (\d+)/u)?.[1] ?? '0',
  )
  expect(epubPageCount).toBeGreaterThan(2)

  const pdfViewer = page.locator('.pdf-source-page-viewer')
  const pdfStage = page.getByRole('region', { name: 'Single PDF page' })
  const pdfNavigation = pdfViewer.locator('.page-navigation')
  const pdfCounter = pdfNavigation.locator('strong')
  await expect(pdfCounter).toHaveText(
    `PDF page 1 of ${sourceFixturePageCount}`,
    { timeout: 15_000 },
  )

  const assertPdfPageAtTop = async (expectedPage: number) => {
    await expect(pdfCounter).toHaveText(
      `PDF page ${expectedPage} of ${sourceFixturePageCount}`,
    )
    await expect(pdfViewer.locator('.pdf-source-page-status')).toContainText(
      `Page ${expectedPage} of ${sourceFixturePageCount}`,
      { timeout: 15_000 },
    )
    await expect(
      pdfStage.getByLabel(`Source PDF page ${expectedPage}`),
    ).toHaveCount(1)
    const geometry = await pdfStage.evaluate(async (element) => {
      const shell = element.querySelector<HTMLElement>('.pdf-source-page-shell')
      const canvas = element.querySelector<HTMLCanvasElement>('canvas')
      const stageRect = element.getBoundingClientRect()
      const shellRect = shell?.getBoundingClientRect()
      const canvasRect = canvas?.getBoundingClientRect()
      const style = getComputedStyle(element)
      const context = canvas?.getContext('2d')
      const pixels =
        canvas && context
          ? context.getImageData(0, 0, canvas.width, canvas.height).data
          : null
      const rasterDigest = pixels
        ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')
        : ''
      return {
        canvasCount: element.querySelectorAll('canvas').length,
        canvasBitmap: canvas ? [canvas.width, canvas.height] : null,
        canvasSize: canvasRect ? [canvasRect.width, canvasRect.height] : null,
        shellSize: shellRect ? [shellRect.width, shellRect.height] : null,
        expectedShellTop:
          stageRect.top +
          Number.parseFloat(style.borderTopWidth) +
          Number.parseFloat(style.paddingTop),
        shellTop: shellRect?.top ?? null,
        canvasTop: canvasRect?.top ?? null,
        rasterDigest,
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
      }
    })
    expect(geometry.canvasCount).toBe(1)
    expect(geometry.canvasBitmap![0]).toBeGreaterThan(0)
    expect(geometry.canvasBitmap![1]).toBeGreaterThan(0)
    expect(geometry.canvasSize).not.toBeNull()
    expect(geometry.shellSize).not.toBeNull()
    expect(
      Math.abs(geometry.canvasSize![0] - geometry.shellSize![0]),
    ).toBeLessThanOrEqual(cssPixelTolerance)
    expect(
      Math.abs(geometry.canvasSize![1] - geometry.shellSize![1]),
    ).toBeLessThanOrEqual(cssPixelTolerance)
    expect(
      Math.abs(geometry.canvasTop! - geometry.shellTop!),
    ).toBeLessThanOrEqual(cssPixelTolerance)
    expect(
      Math.abs(geometry.shellTop! - geometry.expectedShellTop),
    ).toBeLessThanOrEqual(cssPixelTolerance)
    expect(geometry.rasterDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(geometry.scrollLeft).toBe(0)
    expect(geometry.scrollTop).toBe(0)
    return geometry.rasterDigest
  }

  const pdfRasterByPage = new Map<number, string>()
  const assertPdfRaster = (pageNumber: number, rasterDigest: string) => {
    if (pdfRasterByPage.has(pageNumber)) return
    expect([...pdfRasterByPage.values()]).not.toContain(rasterDigest)
    pdfRasterByPage.set(pageNumber, rasterDigest)
  }

  assertPdfRaster(1, await assertPdfPageAtTop(1))
  await expect(epubCounter).toHaveText(`EPUB page 1 of ${epubPageCount}`)
  await pdfNavigation.getByRole('button', { name: 'Next page' }).click()
  assertPdfRaster(2, await assertPdfPageAtTop(2))
  await expect(epubCounter).toHaveText(`EPUB page 1 of ${epubPageCount}`)
  await pdfStage.focus()
  await page.keyboard.press('ArrowRight')
  assertPdfRaster(3, await assertPdfPageAtTop(3))
  await expect(epubCounter).toHaveText(`EPUB page 1 of ${epubPageCount}`)
  await pdfNavigation.getByRole('button', { name: 'Previous page' }).click()
  assertPdfRaster(2, await assertPdfPageAtTop(2))
  await expect(epubCounter).toHaveText(`EPUB page 1 of ${epubPageCount}`)
  await pdfStage.focus()
  await page.keyboard.press('ArrowLeft')
  assertPdfRaster(1, await assertPdfPageAtTop(1))
  await expect(epubCounter).toHaveText(`EPUB page 1 of ${epubPageCount}`)
  expect(pdfRasterByPage.size).toBe(sourceFixturePageCount)

  const defaultViewport = expectedReviewViewport('phone', 'portrait')
  const assertEpubPageAtTop = async (expectedPage: number) => {
    await expect(epubCounter).toHaveText(
      `EPUB page ${expectedPage} of ${epubPageCount}`,
    )
    await assertCompletePage(defaultViewport, expectedPage)
  }
  await assertEpubPageAtTop(1)
  await expect(pdfCounter).toHaveText(`PDF page 1 of ${sourceFixturePageCount}`)
  await epubNavigation.getByRole('button', { name: 'Next page' }).click()
  await assertEpubPageAtTop(2)
  await expect(pdfCounter).toHaveText(`PDF page 1 of ${sourceFixturePageCount}`)
  await stage.focus()
  await page.keyboard.press('ArrowRight')
  await assertEpubPageAtTop(3)
  await expect(pdfCounter).toHaveText(`PDF page 1 of ${sourceFixturePageCount}`)
  await epubNavigation.getByRole('button', { name: 'Previous page' }).click()
  await assertEpubPageAtTop(2)
  await expect(pdfCounter).toHaveText(`PDF page 1 of ${sourceFixturePageCount}`)
  await stage.focus()
  await page.keyboard.press('ArrowLeft')
  await assertEpubPageAtTop(1)
  await expect(pdfCounter).toHaveText(`PDF page 1 of ${sourceFixturePageCount}`)

  const footnoteSelector =
    'aside[epub\\:type~="footnote"], aside[role="doc-footnote"], aside[role="doc-endnote"]'
  const footnoteEvidence = async () => {
    const evidence = await frame.locator('body').evaluate(
      (_body, expected) => {
        const references = [
          ...document.querySelectorAll<HTMLAnchorElement>(
            'a[role="doc-noteref"], a[epub\\:type~="noteref"]',
          ),
        ]
        const matching = references.filter((reference) => {
          const href = reference.getAttribute('href') ?? ''
          const target = href.startsWith('#')
            ? document.getElementById(decodeURIComponent(href.slice(1)))
            : null
          return (
            reference.textContent?.trim() === expected.label &&
            target?.textContent?.includes(expected.text)
          )
        })
        const reference = matching[0] ?? null
        const targetId = reference
          ? decodeURIComponent((reference.getAttribute('href') ?? '').slice(1))
          : ''
        const target = targetId ? document.getElementById(targetId) : null
        const backlink = reference?.id
          ? target?.querySelector<HTMLAnchorElement>(
              `a.note-backlink[href="#${CSS.escape(reference.id)}"]`,
            )
          : null
        const ownerPage = (element: Element | null) =>
          Number(
            element?.closest<HTMLElement>('[data-review-page-fragment]')
              ?.dataset.reviewPageFragment ?? 0,
          )
        const footnotesInPageBodiesSelector = expected.footnoteSelector
          .split(',')
          .map((selector) => `[data-review-page-body] ${selector.trim()}`)
          .join(', ')
        return {
          matchingReferenceCount: matching.length,
          referenceId: reference?.id ?? '',
          targetId,
          referencePage: ownerPage(reference),
          targetPage: ownerPage(target),
          referenceInPageBody: Boolean(
            reference?.closest('[data-review-page-body]'),
          ),
          targetInPageNotes: Boolean(
            target?.closest('[data-review-page-notes]'),
          ),
          footnoteCount: document.querySelectorAll(expected.footnoteSelector)
            .length,
          footnotesInPageBodies: document.querySelectorAll(
            footnotesInPageBodiesSelector,
          ).length,
          backlinkCount: backlink ? 1 : 0,
          backlinkHref: backlink?.getAttribute('href') ?? '',
        }
      },
      {
        label: fixtureContract.note.label,
        text: fixtureContract.note.text,
        footnoteSelector,
      },
    )
    expect(evidence.matchingReferenceCount).toBe(1)
    expect(evidence.referenceId).not.toBe('')
    expect(evidence.targetId).not.toBe('')
    expect(evidence.referencePage).toBeGreaterThan(0)
    expect(evidence.targetPage).toBe(evidence.referencePage)
    expect(evidence.referenceInPageBody).toBe(true)
    expect(evidence.targetInPageNotes).toBe(true)
    expect(evidence.footnoteCount).toBe(1)
    expect(evidence.footnotesInPageBodies).toBe(0)
    expect(evidence.backlinkCount).toBe(1)
    expect(evidence.backlinkHref).toBe(`#${evidence.referenceId}`)
    return evidence
  }

  const currentEpubPage = async () =>
    Number(
      ((await epubCounter.textContent()) ?? '').match(
        /EPUB page (\d+) of/u,
      )?.[1] ?? '0',
    )

  const goToEpubPage = async (targetPage: number, pageCount: number) => {
    let current = await currentEpubPage()
    expect(current).toBeGreaterThan(0)
    while (current !== targetPage) {
      const direction = targetPage > current ? 1 : -1
      await epubNavigation
        .getByRole('button', {
          name: direction > 0 ? 'Next page' : 'Previous page',
        })
        .click()
      current += direction
      await expect(epubCounter).toHaveText(
        `EPUB page ${current} of ${pageCount}`,
      )
    }
  }

  const assertFootnoteAtReference = async (
    expectedViewport: { width: number; height: number },
    pageCount: number,
  ) => {
    const evidence = await footnoteEvidence()
    await goToEpubPage(evidence.referencePage, pageCount)
    await assertCompletePage(expectedViewport, evidence.referencePage)
    const placement = await frame.locator('body').evaluate(
      (_body, expected) => {
        const reference = document.getElementById(expected.referenceId)
        const note = document.getElementById(expected.targetId)
        const fragment = reference?.closest<HTMLElement>(
          '[data-review-page-fragment]',
        )
        const body = fragment?.querySelector<HTMLElement>(
          '[data-review-page-body]',
        )
        const notes = fragment?.querySelector<HTMLElement>(
          '[data-review-page-notes]',
        )
        if (!reference || !note || !fragment || !body || !notes) return null
        const fragmentRect = fragment.getBoundingClientRect()
        const bodyRect = body.getBoundingClientRect()
        const notesRect = notes.getBoundingClientRect()
        const noteRect = note.getBoundingClientRect()
        return {
          visiblePage: Number(fragment.dataset.reviewPageFragment),
          referenceVisible: reference.getClientRects().length > 0,
          noteVisible: note.getClientRects().length > 0,
          referenceInBody: body.contains(reference),
          noteInBody: body.contains(note),
          noteInFooter: notes.contains(note),
          footerBelowBody: notesRect.top >= bodyRect.bottom - 1,
          noteInsideFooter:
            noteRect.top >= notesRect.top - 1 &&
            noteRect.bottom <= notesRect.bottom + 1,
          footerInsidePage:
            notesRect.left >= fragmentRect.left - 1 &&
            notesRect.right <= fragmentRect.right + 1 &&
            notesRect.bottom <= fragmentRect.bottom + 1,
          footerBottomGap: fragmentRect.bottom - notesRect.bottom,
          viewportHeight: innerHeight,
        }
      },
      {
        referenceId: evidence.referenceId,
        targetId: evidence.targetId,
      },
    )
    expect(placement).not.toBeNull()
    expect(placement).toMatchObject({
      visiblePage: evidence.referencePage,
      referenceVisible: true,
      noteVisible: true,
      referenceInBody: true,
      noteInBody: false,
      noteInFooter: true,
      footerBelowBody: true,
      noteInsideFooter: true,
      footerInsidePage: true,
    })
    expect(placement!.footerBottomGap).toBeGreaterThanOrEqual(0)
    expect(placement!.footerBottomGap).toBeLessThan(
      placement!.viewportHeight * 0.08,
    )
    return evidence
  }

  const footnote = await assertFootnoteAtReference(
    defaultViewport,
    epubPageCount,
  )
  await frame.locator(`#${footnote.referenceId}`).click()
  await expect(frame.locator(`#${footnote.targetId}`)).toHaveAttribute(
    'data-review-navigation-target',
    'true',
  )
  const returnButton = page.getByRole('button', {
    name: 'Return to previous EPUB location',
  })
  await expect(returnButton).toBeVisible()
  await returnButton.click()
  await expect(epubCounter).toHaveText(
    `EPUB page ${footnote.referencePage} of ${epubPageCount}`,
  )
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => document.activeElement?.id ?? ''),
    )
    .toBe(footnote.referenceId)
  await expect(
    frame.locator(
      `#${footnote.targetId} .note-backlink[href="#${footnote.referenceId}"]`,
    ),
  ).toHaveCount(1)

  const pdfZoom = page
    .locator('.pdf-source-page-viewer')
    .getByLabel('Zoom percentage')
  const epubZoom = page
    .locator('.epub-rendition-preview--review')
    .getByLabel('Zoom percentage')
  const pdfZoomBefore = await pdfZoom.inputValue()
  const epubCounterBefore =
    (await page
      .locator('.epub-rendition-preview--review .page-navigation strong')
      .textContent()) ?? ''
  await goToEpubPage(2, epubPageCount)
  for (const percent of ['125', '200']) {
    await epubZoom.selectOption(percent)
    await expect(epubZoom).toHaveValue(percent)
    const scrollEvidence = await stage.evaluate(async (element) => {
      element.scrollTop = element.scrollHeight
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      }
    })
    expect(scrollEvidence.scrollHeight).toBeGreaterThan(
      scrollEvidence.clientHeight,
    )
    expect(scrollEvidence.scrollTop).toBeGreaterThan(0)
    expect(
      Math.abs(
        scrollEvidence.scrollTop -
          (scrollEvidence.scrollHeight - scrollEvidence.clientHeight),
      ),
    ).toBeLessThanOrEqual(cssPixelTolerance)
  }
  await expect(pdfZoom).toHaveValue(pdfZoomBefore)
  await epubNavigation.getByRole('button', { name: 'Next page' }).click()
  await expect(epubCounter).toHaveText(`EPUB page 3 of ${epubPageCount}`)
  await expect
    .poll(() => stage.evaluate((element) => element.scrollTop))
    .toBe(0)
  await stage.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect
    .poll(() => stage.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0)
  await epubNavigation.getByRole('button', { name: 'Previous page' }).click()
  await expect(epubCounter).toHaveText(`EPUB page 2 of ${epubPageCount}`)
  await expect
    .poll(() => stage.evaluate((element) => element.scrollTop))
    .toBe(0)
  await page
    .locator('.epub-rendition-preview--review')
    .getByRole('button', { name: 'Fit page' })
    .click()
  await goToEpubPage(
    Number(epubCounterBefore.match(/EPUB page (\d+) of/u)?.[1] ?? '1'),
    epubPageCount,
  )
  await assertCompletePage(defaultViewport, await currentEpubPage())
  const epubZoomBeforePdfChange = await epubZoom.inputValue()
  const epubCounterBeforePdfChange = (await epubCounter.textContent()) ?? ''
  const pdfCounterBeforeZoom = (await pdfCounter.textContent()) ?? ''
  await pdfZoom.selectOption('125')
  await expect(pdfZoom).toHaveValue('125')
  await expect(epubZoom).toHaveValue(epubZoomBeforePdfChange)
  await expect(epubCounter).toHaveText(epubCounterBeforePdfChange)
  await expect(pdfCounter).toHaveText(pdfCounterBeforeZoom)
  await assertCompletePage(defaultViewport, await currentEpubPage())
  await pdfViewer.getByRole('button', { name: 'Fit page' }).click()

  await page.locator('.epub-review-settings summary').click()
  const viewport = page.getByLabel('Viewport size')
  const orientation = page.getByLabel('Orientation')
  const fontSize = page.getByLabel('Font size')
  const fontFamily = page.getByLabel('Font family')
  const preview = page.locator('.epub-rendition-preview--review')
  const viewportIds = Object.keys(reviewViewportGeometry) as ReviewViewportId[]
  const orientationIds = ['portrait', 'landscape'] as const
  const fontSizeIds = ['small', 'default', 'large', 'x-large'] as const
  const fontFamilyIds = ['publisher', 'serif', 'sans'] as const
  let checkedLayouts = 0
  for (const viewportId of viewportIds) {
    await viewport.selectOption(viewportId)
    for (const orientationId of orientationIds) {
      await orientation.selectOption(orientationId)
      for (const fontSizeId of fontSizeIds) {
        await fontSize.selectOption(fontSizeId)
        for (const fontFamilyId of fontFamilyIds) {
          await fontFamily.selectOption(fontFamilyId)
          await expect(preview).toHaveAttribute(
            'data-review-paginated-layout',
            `${viewportId}:${orientationId}:${fontSizeId}:${fontFamilyId}`,
            { timeout: 90_000 },
          )
          const count = Number(
            ((await epubCounter.textContent()) ?? '').match(/of (\d+)/u)?.[1] ??
              '0',
          )
          expect(
            count,
            `${viewportId}:${orientationId}:${fontSizeId}:${fontFamilyId}`,
          ).toBeGreaterThan(0)
          const expectedViewport = expectedReviewViewport(
            viewportId,
            orientationId,
          )
          await assertCompletePage(
            expectedViewport,
            await currentEpubPage(),
            count,
          )
          await assertFootnoteAtReference(expectedViewport, count)
          checkedLayouts += 1
        }
      }
    }
  }
  expect(checkedLayouts).toBe(96)

  await frame.locator('body').evaluate(() => {
    const sourceTemplate = document.head.querySelector<HTMLTemplateElement>(
      'template[data-review-source-template]',
    )
    const table =
      sourceTemplate?.content.querySelector<HTMLElement>(
        '.semantic-table-wrapper table',
      ) ?? null
    if (!table) throw new Error('The review fixture has no semantic table.')
    table.style.setProperty('width', '4000px', 'important')
    table.style.setProperty('min-width', '4000px', 'important')
  })
  await fontSize.selectOption('large')
  await expect(preview).toHaveAttribute(
    'data-review-paginated-layout',
    'paper-pro:landscape:large:sans',
    { timeout: 90_000 },
  )
  const wideTablePage = await frame.locator('body').evaluate(() => {
    const table = document.querySelector<HTMLElement>(
      '.semantic-table-wrapper table',
    )
    const page = table?.closest<HTMLElement>('[data-review-page-fragment]')
    return Number(page?.dataset.reviewPageFragment ?? 0)
  })
  expect(wideTablePage).toBeGreaterThan(0)
  const wideTablePageCount = Number(
    ((await epubCounter.textContent()) ?? '').match(/of (\d+)/u)?.[1] ?? '0',
  )
  await goToEpubPage(wideTablePage, wideTablePageCount)
  const wideTableEvidence = await frame.locator('body').evaluate(() => {
    const table = document.querySelector<HTMLElement>(
      '.semantic-table-wrapper table',
    )
    const page = table?.closest<HTMLElement>('[data-review-page-fragment]')
    const body = page?.querySelector<HTMLElement>('[data-review-page-body]')
    const fit = table?.closest<HTMLElement>('[data-review-atomic-fit="true"]')
    const tableRect = table?.getBoundingClientRect()
    const bodyRect = body?.getBoundingClientRect()
    return {
      page: Number(page?.dataset.reviewPageFragment ?? 0),
      fitted: Boolean(fit),
      naturalWidth: table?.scrollWidth ?? 0,
      bodyWidth: body?.clientWidth ?? 0,
      visuallyInsideBody: Boolean(
        tableRect &&
        bodyRect &&
        tableRect.left >= bodyRect.left - 1 &&
        tableRect.right <= bodyRect.right + 1,
      ),
    }
  })
  expect(wideTableEvidence.page).toBe(wideTablePage)
  expect(wideTableEvidence.naturalWidth).toBeGreaterThan(
    wideTableEvidence.bodyWidth,
  )
  expect(wideTableEvidence.fitted).toBe(true)
  expect(wideTableEvidence.visuallyInsideBody).toBe(true)
  await assertCompletePage(
    expectedReviewViewport('paper-pro', 'landscape'),
    wideTableEvidence.page,
    wideTablePageCount,
  )

  const splitIdentityIds = await frame.locator('body').evaluate(() => {
    const sourceTemplate = document.head.querySelector<HTMLTemplateElement>(
      'template[data-review-source-template]',
    )
    if (!sourceTemplate) {
      throw new Error('The review source template is unavailable.')
    }
    const createReferenceParagraph = (
      prefix: string,
      ids: { citation: string; noteref: string; crossReference: string },
    ) => {
      const paragraph = document.createElement('p')
      paragraph.append(document.createTextNode(prefix))
      const citation = document.createElement('a')
      citation.id = ids.citation
      citation.href = '#split-citation-target'
      citation.setAttribute('role', 'doc-biblioref')
      citation.textContent = 'citation'
      const noteref = document.createElement('a')
      noteref.id = ids.noteref
      noteref.href = '#split-note-target'
      noteref.setAttribute('role', 'doc-noteref')
      noteref.setAttribute('epub:type', 'noteref')
      noteref.textContent = 'note'
      const crossReference = document.createElement('a')
      crossReference.id = ids.crossReference
      crossReference.href = '#split-cross-reference-target'
      crossReference.dataset.semanticRole = 'cross-reference'
      crossReference.textContent = 'cross-reference'
      paragraph.append(
        citation,
        document.createTextNode(' '),
        noteref,
        document.createTextNode(' '),
        crossReference,
      )
      return paragraph
    }
    const unsplit = {
      citation: 'unsplit-citation-reference',
      noteref: 'unsplit-note-reference',
      crossReference: 'unsplit-cross-reference',
    }
    const splitTail = {
      citation: 'split-tail-citation-reference',
      noteref: 'split-tail-note-reference',
      crossReference: 'split-tail-cross-reference',
    }
    sourceTemplate.content.append(
      createReferenceParagraph('Unsplit controls: ', unsplit),
      createReferenceParagraph('prefix '.repeat(4_000), splitTail),
    )
    for (const [id, text] of [
      ['split-citation-target', 'Citation target.'],
      ['split-cross-reference-target', 'Cross-reference target.'],
    ]) {
      const target = document.createElement('p')
      target.id = id
      target.textContent = text
      sourceTemplate.content.append(target)
    }
    const note = document.createElement('aside')
    note.id = 'split-note-target'
    note.setAttribute('role', 'doc-footnote')
    note.setAttribute('epub:type', 'footnote')
    note.textContent = 'Synthetic split-tail note.'
    sourceTemplate.content.append(note)
    return { splitTail, unsplit }
  })
  await fontSize.selectOption('x-large')
  await expect(preview).toHaveAttribute(
    'data-review-paginated-layout',
    'paper-pro:landscape:x-large:sans',
    { timeout: 90_000 },
  )
  const splitIdentityEvidence = await frame
    .locator('body')
    .evaluate((_body, ids) => {
      const counts = (group: typeof ids.splitTail) =>
        Object.fromEntries(
          Object.entries(group).map(([kind, id]) => [
            kind,
            document.querySelectorAll(`#${CSS.escape(id)}`).length,
          ]),
        )
      const resolvedTargets = (group: typeof ids.splitTail) =>
        Object.fromEntries(
          Object.entries(group).map(([kind, id]) => {
            const reference = document.getElementById(id)
            const href = reference?.getAttribute('href') ?? ''
            return [
              kind,
              href.startsWith('#') &&
                Boolean(document.getElementById(href.slice(1))),
            ]
          }),
        )
      return {
        splitTailCounts: counts(ids.splitTail),
        splitTailTargets: resolvedTargets(ids.splitTail),
        unsplitCounts: counts(ids.unsplit),
        unsplitTargets: resolvedTargets(ids.unsplit),
      }
    }, splitIdentityIds)
  expect(splitIdentityEvidence.unsplitCounts).toEqual({
    citation: 1,
    noteref: 1,
    crossReference: 1,
  })
  expect(splitIdentityEvidence.unsplitTargets).toEqual({
    citation: true,
    noteref: true,
    crossReference: true,
  })
  expect(splitIdentityEvidence.splitTailCounts).toEqual({
    citation: 1,
    noteref: 1,
    crossReference: 1,
  })
  expect(splitIdentityEvidence.splitTailTargets).toEqual({
    citation: true,
    noteref: true,
    crossReference: true,
  })
})

test('keeps the UI responsive and cancellation bounded during the 231-page stress conversion', async ({
  page,
}) => {
  test.skip(
    process.env.RUN_PDF_STRESS_E2E !== '1',
    'Run explicitly against the hash-pinned 231-page stress paper.',
  )
  test.setTimeout(25 * 60_000)
  const [standardBytes, stressBytes, corpusContractBytes] = await Promise.all([
    readFile(fixturePath),
    readFile(stressFixturePath),
    readFile(corpusContractPath, 'utf8'),
  ])
  const corpusContract = JSON.parse(corpusContractBytes) as {
    frozen: {
      documents: Array<{ id: string; byteLength: number; sha256: string }>
    }
  }
  const contractEntries = corpusContract.frozen.documents.filter(
    (document) => document.id === stressFixtureId,
  )
  expect(contractEntries).toHaveLength(1)
  const stressContract = contractEntries[0]
  expect(path.basename(stressFixturePath)).toBe(`${stressFixtureId}.pdf`)
  expect(stressContract.sha256).toBe(stressFixtureSha256)
  expect(stressBytes.byteLength).toBe(stressContract.byteLength)
  expect(sha256(stressBytes)).toBe(stressFixtureSha256)
  expect(await pdfPageCount(stressBytes)).toBe(stressFixturePageCount)

  let recordStressRequests = false
  const linkedPdfAccept = 'application/pdf,application/octet-stream;q=0.8'
  const stressConversionRequestUrls: string[] = []
  const stressSourceViewerRequests: Array<{ url: string; accept: string }> = []
  await page.route('https://arxiv.org/pdf/**', async (route) => {
    const request = route.request()
    const requestUrl = request.url()
    if (recordStressRequests && requestUrl === stressFixtureUrl) {
      const accept = request.headers().accept ?? ''
      if (accept === linkedPdfAccept) {
        stressConversionRequestUrls.push(requestUrl)
      } else {
        stressSourceViewerRequests.push({ url: requestUrl, accept })
      }
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: requestUrl === stressFixtureUrl ? stressBytes : standardBytes,
    })
  })
  await page.goto('/research/pdf-review')
  await waitForReviewPage(page)
  recordStressRequests = true
  await page.locator('.pdf-review-toolbar__controls select').selectOption('1')
  await expect(page.getByRole('heading', { name: /Paper 2\/20/ })).toBeVisible()
  await expect(page.locator('.pdf-review-identity code')).toHaveText(
    stressFixtureSha256,
  )
  await expect(
    page.locator('.pdf-review-stress').getByRole('heading'),
  ).toHaveText(`${stressFixturePageCount} pages`)
  const sourcePdfViewer = page.locator('.pdf-source-page-viewer')
  await expect(sourcePdfViewer.locator('.page-navigation strong')).toHaveText(
    `PDF page 1 of ${stressFixturePageCount}`,
    {
      timeout: 30_000,
    },
  )
  await expect(sourcePdfViewer.locator('canvas')).toHaveAttribute(
    'aria-label',
    'Source PDF page 1',
  )
  expect(stressSourceViewerRequests).toEqual([
    { url: stressFixtureUrl, accept: '*/*' },
  ])
  expect(stressConversionRequestUrls).toEqual([])
  const startStress = page.getByRole('button', {
    name: 'Start stress conversion',
  })
  await expect(startStress).toBeVisible({ timeout: 10_000 })
  await installMainThreadResponsivenessProbe(page)
  await startStress.click()
  const cancel = page.getByRole('button', { name: 'Cancel conversion' })
  await expect(cancel).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => stressConversionRequestUrls)
    .toEqual([stressFixtureUrl])

  for (let probe = 0; probe < 5; probe += 1) {
    await page.evaluate(() => document.visibilityState)
    await page.waitForTimeout(500)
  }
  const cancelStarted = performance.now()
  await cancel.click()
  await expect(page.locator('.publication-failure')).toContainText(
    'Conversion stopped.',
    { timeout: 5_000 },
  )
  const cancellationLatencyMs = performance.now() - cancelStarted
  expect(cancellationLatencyMs).toBeLessThan(3_000)

  await page.getByRole('button', { name: 'Retry conversion' }).click()
  await expect(cancel).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => stressConversionRequestUrls)
    .toEqual([stressFixtureUrl, stressFixtureUrl])
  const progressMessages = new Set<string>()
  const reviewer = page.getByPlaceholder('Stable reviewer ID')
  const importer = page.locator('.publication-importer--review')
  let maximumMainHeapBytes = 0
  let mainHeapMeasurementSupported = false
  let terminalStatus: 'ready' | 'review-required' | undefined
  const completionStarted = performance.now()
  for (let probe = 0; probe < 20 * 60 * 2; probe += 1) {
    const failure = page.locator('.publication-failure')
    if (await failure.isVisible()) {
      throw new Error(`Stress conversion failed: ${await failure.innerText()}`)
    }
    const conversionStatus = await importer.getAttribute(
      'data-conversion-status',
    )
    if (
      conversionStatus === 'ready' ||
      conversionStatus === 'review-required'
    ) {
      terminalStatus = conversionStatus
      break
    }
    const progressMessage = page.locator('.publication-progress strong')
    const message = await progressMessage
      .textContent({ timeout: 1_000 })
      .catch(() => null)
    if (message) progressMessages.add(message)
    if (probe % 60 === 0) {
      console.log(
        JSON.stringify({
          elapsedSeconds: Math.round(
            (performance.now() - completionStarted) / 1_000,
          ),
          progress: message,
          profileState: (await importer.innerText().catch(() => '')).slice(
            0,
            500,
          ),
          workerCount: page.workers().length,
        }),
      )
    }
    const heap = await page.evaluate(() => {
      const memory = (
        performance as Performance & {
          memory?: { usedJSHeapSize?: number }
        }
      ).memory
      return memory?.usedJSHeapSize ?? null
    })
    if (heap !== null) {
      mainHeapMeasurementSupported = true
      maximumMainHeapBytes = Math.max(maximumMainHeapBytes, heap)
    }
    if (probe % 10 === 0) {
      await reviewer.fill(`stress-probe-${probe % 20}`)
    }
    await page.waitForTimeout(500)
  }

  expect(terminalStatus).toBeDefined()
  await expect(page.locator('.pdf-review-identity .is-verified')).toHaveText(
    'Source verified',
  )
  expect(stressConversionRequestUrls).toEqual([
    stressFixtureUrl,
    stressFixtureUrl,
  ])
  expect(stressSourceViewerRequests).toEqual([
    { url: stressFixtureUrl, accept: '*/*' },
  ])
  if (terminalStatus !== 'ready') {
    await expect(page.locator('.pdf-review-machine-status')).toContainText(
      'Automated conversion checks found EPUB defects',
    )
  }
  const exactEpubPreview = page.getByRole('region', {
    name: 'Single Mobile EPUB page',
  })
  const assemblyDeadline = performance.now() + 10 * 60_000
  while (
    !(await exactEpubPreview.isVisible().catch(() => false)) &&
    performance.now() < assemblyDeadline
  ) {
    const buildIssue = page.locator('.publication-actions [role="alert"]')
    if (await buildIssue.isVisible().catch(() => false)) {
      throw new Error(
        `Stress EPUB assembly failed: ${await buildIssue.innerText()}`,
      )
    }
    const buildMessage = await page
      .locator('.publication-actions [aria-live="polite"]')
      .textContent({ timeout: 1_000 })
      .catch(() => null)
    if (buildMessage) progressMessages.add(buildMessage)
    const heap = await page.evaluate(() => {
      const memory = (
        performance as Performance & {
          memory?: { usedJSHeapSize?: number }
        }
      ).memory
      return memory?.usedJSHeapSize ?? null
    })
    if (heap !== null) {
      mainHeapMeasurementSupported = true
      maximumMainHeapBytes = Math.max(maximumMainHeapBytes, heap)
    }
    await page.waitForTimeout(500)
  }
  await expect(exactEpubPreview).toBeVisible({ timeout: 1_000 })
  const reviewRendition = importer.locator(
    '.epub-rendition-preview--review',
  )
  await expect(reviewRendition).toHaveAttribute(
    'data-review-pagination-status',
    'complete',
    { timeout: 10 * 60_000 },
  )
  await expect(reviewRendition).toHaveAttribute(
    'data-review-paginated-layout',
    /\S/u,
  )
  await page.waitForTimeout(50)
  const buildStageReceipt = await page
    .locator('.publication-build-stage-history')
    .textContent({ timeout: 1_000 })
    .catch(() => null)
  if (buildStageReceipt) progressMessages.add(buildStageReceipt)
  const responsivenessReceipt =
    await readMainThreadResponsivenessProbe(page)
  expect(responsivenessReceipt.samples).toBeGreaterThan(0)
  expect(responsivenessReceipt.maximumLagMs).toBeLessThan(2_000)
  if (mainHeapMeasurementSupported) {
    expect(maximumMainHeapBytes).toBeLessThan(512 * 1024 * 1024)
  }
  expect(
    [...progressMessages].some((message) => /Reading page/iu.test(message)),
  ).toBe(true)
  expect(
    [...progressMessages].some((message) =>
      /segment|reading order|semantic|asset|validat|assembl/iu.test(message),
    ),
  ).toBe(true)
  expect(
    [...progressMessages].some((message) => /packag|assembl/iu.test(message)),
  ).toBe(true)
  test.info().annotations.push(
    {
      type: 'stress-completion-ms',
      description: String(Math.round(performance.now() - completionStarted)),
    },
    {
      type: 'stress-cancellation-ms',
      description: String(Math.round(cancellationLatencyMs)),
    },
    {
      type: 'stress-max-main-thread-latency-ms',
      description: String(Math.round(responsivenessReceipt.maximumLagMs)),
    },
    {
      type: 'stress-main-thread-responsiveness-samples',
      description: String(responsivenessReceipt.samples),
    },
    {
      type: 'stress-max-main-heap-bytes',
      description: mainHeapMeasurementSupported
        ? String(Math.round(maximumMainHeapBytes))
        : 'unsupported',
    },
    {
      type: 'stress-main-heap-measurement-supported',
      description: String(mainHeapMeasurementSupported),
    },
    {
      type: 'stress-terminal-status',
      description: terminalStatus ?? 'missing',
    },
  )
  console.log(
    JSON.stringify({
      terminalStatus,
      completionMs: Math.round(performance.now() - completionStarted),
      cancellationLatencyMs: Math.round(cancellationLatencyMs),
      maximumMainThreadLatencyMs: Math.round(
        responsivenessReceipt.maximumLagMs,
      ),
      mainThreadResponsivenessSamples: responsivenessReceipt.samples,
      maximumMainHeapBytes: mainHeapMeasurementSupported
        ? Math.round(maximumMainHeapBytes)
        : null,
      mainHeapMeasurementSupported,
      progressMessages: [...progressMessages],
    }),
  )
})

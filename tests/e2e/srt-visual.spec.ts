import { expect, test, type Locator, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import {
  getTargetProfile,
  TARGET_PROFILE_IDS,
} from '../../src/research/targets'
import { installStaticRoutes, jsonFixture } from './static-build'

const PAPER_ID = 'semantic-responsive-typesetting'
const ANCHOR_QUOTE =
  'Once meaning becomes coordinates, every new screen or sheet becomes a repair job.'
const ANNOTATION_IDS = [
  'highlight-reading-position',
  'note-reading-position',
] as const
const GEOMETRY_EPSILON_CSS_PX = 0.5
const OVERFLOW_EPSILON_CSS_PX = 1

type SourceNode = {
  id: string
  type: 'heading' | 'paragraph' | 'quote' | 'caption' | 'figure'
  text?: string
  title?: string
}

type GeometryReport = {
  target: string
  paper: { width: number; height: number }
  pages: Array<{ number: number; width: number; height: number }>
  renderedNodeIds: string[]
  missingNodes: string[]
  invalidFragmentLineage: string[]
  textLoss: string[]
  clippedContent: string[]
  headerContentOverflow: string[]
  overlaps: string[]
  orphanedCaptions: string[]
  horizontalOverflow: Array<{ element: string; amount: number }>
  missingAnnotations: string[]
  unstableAnchors: string[]
}

type GeometryEvidence = {
  schemaVersion: '1.0.0'
  runtime: {
    browserName: 'chromium' | 'firefox' | 'webkit'
    browserVersion: string
    viewport: { width: number; height: number }
    deviceScaleFactor: number
  }
  tolerances: {
    geometryCssPx: number
    overflowCssPx: number
  }
  targets: GeometryReport[]
}

async function expectStudioHydrated(page: Page) {
  const annotation = page.locator(
    '[data-annotation-summary="highlight-reading-position"]',
  )
  await expect
    .poll(async () =>
      Number(await annotation.getAttribute('data-geometry-rect-count')),
    )
    .toBeGreaterThan(0)
}

async function inspectAnnotations(page: Page, anchorStart: number) {
  return page.evaluate(
    ({ annotationIds, anchorNodeId, anchorQuote, anchorStart }) => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
      const rendition = document.querySelector<HTMLElement>('.srt-paper')
      const layoutVersion = rendition?.dataset.layoutVersion ?? ''
      const missingAnnotations: string[] = []
      const unstableAnchors: string[] = []

      for (const id of annotationIds) {
        const summary = document.querySelector<HTMLElement>(
          `[data-annotation-summary="${id}"]`,
        )
        const marks = Array.from(
          document.querySelectorAll<HTMLElement>(
            `[data-annotation-id="${id}"]`,
          ),
        )
        const renderedText = normalize(
          marks.map((element) => element.textContent ?? '').join(' '),
        )
        if (
          !summary ||
          summary.dataset.resolutionStatus !== 'resolved' ||
          Number(summary.dataset.geometryRectCount ?? 0) < 1 ||
          marks.length === 0
        ) {
          missingAnnotations.push(id)
          continue
        }
        if (
          renderedText !== anchorQuote ||
          summary.dataset.anchorNodeId !== anchorNodeId ||
          Number(summary.dataset.anchorStart) !== anchorStart ||
          Number(summary.dataset.anchorEnd) !==
            anchorStart + anchorQuote.length ||
          summary.dataset.geometryLayoutVersion !== layoutVersion
        ) {
          unstableAnchors.push(id)
        }
      }
      return { missingAnnotations, unstableAnchors }
    },
    {
      annotationIds: ANNOTATION_IDS,
      anchorNodeId: 'p-proposition-1',
      anchorQuote: ANCHOR_QUOTE,
      anchorStart,
    },
  )
}

test.beforeEach(async ({ page }) => installStaticRoutes(page))

async function inspectGeometry(
  paper: Locator,
  expectedNodes: SourceNode[],
): Promise<GeometryReport> {
  return paper.evaluate(
    (rendition, options) => {
      type Rect = {
        top: number
        right: number
        bottom: number
        left: number
        width: number
        height: number
      }
      type MeasuredElement = {
        element: Element
        label: string
        rects: Rect[]
        page: Element | null
      }

      const toRect = (rect: DOMRect): Rect => ({
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      })
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
      const nodeElements = Array.from(
        rendition.querySelectorAll<HTMLElement>('[data-node-id]'),
      )
      const elementsByNode = new Map<string, HTMLElement[]>()
      for (const element of nodeElements) {
        const id = element.dataset.nodeId ?? ''
        const elements = elementsByNode.get(id) ?? []
        elements.push(element)
        elementsByNode.set(id, elements)
      }

      const invalidFragmentLineage = [...elementsByNode.entries()]
        .filter(([, elements]) => {
          const expectedCount = Number(elements[0]?.dataset.fragmentCount ?? 1)
          const indices = elements
            .map((element) => Number(element.dataset.fragmentIndex ?? 0))
            .sort((left, right) => left - right)
          const fragmentIds = elements.map(
            (element) => element.dataset.fragmentId ?? '',
          )
          return (
            elements.length !== expectedCount ||
            new Set(fragmentIds).size !== fragmentIds.length ||
            indices.some((index, position) => index !== position)
          )
        })
        .map(([id]) => id)

      const textLoss = options.expectedNodes
        .filter((node) => {
          const elements = elementsByNode.get(node.id) ?? []
          const expectedText = normalize(node.text ?? node.title ?? '')
          if (!expectedText || elements.length === 0) return false
          const renderedText = normalize(
            elements
              .sort(
                (left, right) =>
                  Number(left.dataset.fragmentIndex ?? 0) -
                  Number(right.dataset.fragmentIndex ?? 0),
              )
              .map((element) => element.textContent ?? '')
              .join(' '),
          )
          return !renderedText.includes(expectedText)
        })
        .map((node) => node.id)

      const headers = Array.from(
        rendition.querySelectorAll<HTMLElement>('.srt-document-header'),
      )
      const contentElements: Element[] = [...headers, ...nodeElements]
      const measured: MeasuredElement[] = contentElements.map((element) => ({
        element,
        label:
          element instanceof HTMLElement && element.dataset.fragmentId
            ? element.dataset.fragmentId
            : element instanceof HTMLElement && element.dataset.nodeId
              ? element.dataset.nodeId
              : 'document-header',
        rects: Array.from(element.getClientRects(), toRect).filter(
          (rect) =>
            rect.width > options.geometryEpsilon &&
            rect.height > options.geometryEpsilon,
        ),
        page: element.closest('.srt-page'),
      }))
      const renditionRect = toRect(rendition.getBoundingClientRect())
      const clippedContent = measured
        .filter(({ page, rects }) => {
          if (!page) return true
          const pageRect = toRect(page.getBoundingClientRect())
          return rects.some(
            (rect) =>
              rect.left < pageRect.left - options.geometryEpsilon ||
              rect.right > pageRect.right + options.geometryEpsilon ||
              rect.top < pageRect.top - options.geometryEpsilon ||
              rect.bottom > pageRect.bottom + options.geometryEpsilon,
          )
        })
        .map(({ label }) => label)
      const headerContentOverflow = headers.flatMap((header, index) => {
        const headerRect = toRect(header.getBoundingClientRect())
        const style = getComputedStyle(header)
        const contentBottom =
          headerRect.bottom -
          (Number.parseFloat(style.borderBottomWidth) || 0) -
          (Number.parseFloat(style.paddingBottom) || 0)
        const childBottom = Math.max(
          headerRect.top,
          ...Array.from(
            header.children,
            (child) => child.getBoundingClientRect().bottom,
          ),
        )
        const scrollOverflow = header.scrollHeight - header.clientHeight
        return childBottom > contentBottom + options.geometryEpsilon ||
          scrollOverflow > options.geometryEpsilon
          ? [`document-header-${index + 1}`]
          : []
      })

      const overlaps: string[] = []
      for (let firstIndex = 0; firstIndex < measured.length; firstIndex += 1) {
        for (
          let secondIndex = firstIndex + 1;
          secondIndex < measured.length;
          secondIndex += 1
        ) {
          const first = measured[firstIndex]
          const second = measured[secondIndex]
          if (
            first.page !== second.page ||
            first.element.contains(second.element) ||
            second.element.contains(first.element)
          ) {
            continue
          }
          const intersects = first.rects.some((firstRect) =>
            second.rects.some(
              (secondRect) =>
                Math.min(firstRect.right, secondRect.right) -
                  Math.max(firstRect.left, secondRect.left) >
                  options.geometryEpsilon &&
                Math.min(firstRect.bottom, secondRect.bottom) -
                  Math.max(firstRect.top, secondRect.top) >
                  options.geometryEpsilon,
            ),
          )
          if (intersects) overlaps.push(`${first.label}::${second.label}`)
        }
      }

      const orphanedCaptions = Array.from(
        rendition.querySelectorAll<HTMLElement>('figcaption[data-node-id]'),
      )
        .filter((caption) => {
          const figure = caption.closest('figure[data-node-id]')
          return (
            !figure ||
            figure.closest('.srt-page') !== caption.closest('.srt-page')
          )
        })
        .map((caption) => caption.dataset.nodeId ?? 'unknown-caption')

      const pages = Array.from(
        rendition.querySelectorAll<HTMLElement>('.srt-page'),
      )
      const overflowCandidates = [
        {
          element: 'document',
          amount:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        },
        {
          element: 'rendition',
          amount: rendition.scrollWidth - rendition.clientWidth,
        },
        ...pages.map((page) => ({
          element: `page-${page.dataset.page ?? 'unknown'}`,
          amount: page.scrollWidth - page.clientWidth,
        })),
        ...nodeElements.map((element) => ({
          element: element.dataset.fragmentId ?? element.dataset.nodeId ?? '',
          amount: element.scrollWidth - element.clientWidth,
        })),
      ]

      return {
        target: rendition.getAttribute('data-target-profile') ?? 'unknown',
        paper: { width: renditionRect.width, height: renditionRect.height },
        pages: pages.map((page) => {
          const rect = toRect(page.getBoundingClientRect())
          return {
            number: Number(page.dataset.page),
            width: rect.width,
            height: rect.height,
          }
        }),
        renderedNodeIds: [...elementsByNode.keys()],
        missingNodes: options.expectedNodes
          .map((node) => node.id)
          .filter((id) => !elementsByNode.has(id)),
        invalidFragmentLineage,
        textLoss,
        clippedContent,
        headerContentOverflow,
        overlaps,
        orphanedCaptions,
        horizontalOverflow: overflowCandidates.filter(
          ({ amount }) => amount > options.overflowEpsilon,
        ),
        missingAnnotations: [],
        unstableAnchors: [],
      }
    },
    {
      expectedNodes,
      geometryEpsilon: GEOMETRY_EPSILON_CSS_PX,
      overflowEpsilon: OVERFLOW_EPSILON_CSS_PX,
    },
  )
}

test('captures every paginated target and rejects invalid geometry', async ({
  browser,
  browserName,
  page,
  request,
}, testInfo) => {
  const source = await jsonFixture<{ nodes: SourceNode[] }>(
    request,
    `/research/${PAPER_ID}/source.json`,
  )
  const manifest = await jsonFixture<{
    renditions: Array<{
      target: string
      pagination: {
        mode: 'continuous' | 'finite'
        finalPageCount: number | null
        violations: unknown[]
      }
      entries: Array<{ violations: unknown[] }>
    }>
  }>(request, `/research/${PAPER_ID}/manifest.json`)
  const reports: GeometryReport[] = []
  const anchorNode = source.nodes.find((node) => node.id === 'p-proposition-1')
  const anchorStart = anchorNode?.text?.indexOf(ANCHOR_QUOTE) ?? -1
  expect(anchorStart).toBeGreaterThanOrEqual(0)

  for (const target of TARGET_PROFILE_IDS) {
    await page.goto(`/research/${PAPER_ID}`)
    await expectStudioHydrated(page)
    await page.locator('html').evaluate((element) => {
      element.classList.add('disable-transitions')
    })
    await page.evaluate(() => document.fonts.ready)

    const profile = getTargetProfile(target)
    await page.getByRole('button', { name: profile.label, exact: true }).click()

    const paper = page.locator(`.srt-paper[data-target-profile="${target}"]`)
    await expect(paper).toBeVisible()

    const report = await inspectGeometry(paper, source.nodes)
    Object.assign(report, await inspectAnnotations(page, anchorStart))
    const renditionManifest = manifest.renditions.find(
      (rendition) => rendition.target === target,
    )
    reports.push(report)
    expect.soft(report.target, `${target}: active target`).toBe(target)
    expect.soft(report.missingNodes, `${target}: missing nodes`).toEqual([])
    expect
      .soft(
        report.invalidFragmentLineage,
        `${target}: invalid fragment lineage`,
      )
      .toEqual([])
    expect.soft(report.textLoss, `${target}: text loss`).toEqual([])
    expect.soft(report.clippedContent, `${target}: clipped content`).toEqual([])
    expect.soft(report.overlaps, `${target}: overlapping content`).toEqual([])
    expect
      .soft(report.orphanedCaptions, `${target}: orphaned captions`)
      .toEqual([])
    expect
      .soft(report.horizontalOverflow, `${target}: horizontal overflow`)
      .toEqual([])
    expect
      .soft(report.missingAnnotations, `${target}: missing annotations`)
      .toEqual([])
    expect
      .soft(report.unstableAnchors, `${target}: unstable anchors`)
      .toEqual([])
    expect
      .soft(report.paper.width, `${target}: rendition width`)
      .toBeCloseTo(profile.preview.widthCssPx, 1)
    expect
      .soft(report.pages.map((item) => item.number))
      .toEqual(report.pages.map((_, index) => index + 1))
    expect.soft(renditionManifest?.pagination.violations).toEqual([])
    expect
      .soft(renditionManifest?.entries.flatMap((entry) => entry.violations))
      .toEqual([])

    if (profile.finiteHeight) {
      expect
        .soft(
          report.headerContentOverflow,
          `${target}: header content overflow`,
        )
        .toEqual([])
      expect
        .soft(report.pages.length, `${target}: final page count`)
        .toBe(renditionManifest?.pagination.finalPageCount)
      for (const renderedPage of report.pages) {
        expect
          .soft(renderedPage.width, `${target}: page width`)
          .toBeCloseTo(profile.preview.widthCssPx, 1)
        expect
          .soft(renderedPage.height, `${target}: page height`)
          .toBeCloseTo(profile.preview.heightCssPx ?? 0, 1)
      }
    } else {
      expect.soft(report.pages).toHaveLength(1)
      expect.soft(renditionManifest?.pagination.finalPageCount).toBeNull()
    }

    await paper.evaluate((rendition) => {
      document.body.replaceChildren(rendition)
      document.body.style.margin = '0'
      document.body.style.background = '#faf9f4'
      rendition.style.margin = '0'
    })
    await paper.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath(`${target}-rendition.png`),
    })
  }

  const evidence: GeometryEvidence = {
    schemaVersion: '1.0.0',
    runtime: {
      browserName,
      browserVersion: browser.version(),
      viewport: { width: 1440, height: 1200 },
      deviceScaleFactor: 1,
    },
    tolerances: {
      geometryCssPx: GEOMETRY_EPSILON_CSS_PX,
      overflowCssPx: OVERFLOW_EPSILON_CSS_PX,
    },
    targets: reports,
  }
  const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`
  const reportPath = testInfo.outputPath('geometry-report.json')
  await writeFile(reportPath, serializedEvidence)
  if (process.env.SRT_GEOMETRY_REPORT) {
    await writeFile(process.env.SRT_GEOMETRY_REPORT, serializedEvidence)
  }
  await testInfo.attach('geometry-report', {
    path: reportPath,
    contentType: 'application/json',
  })
})

test('keeps the semantic sentence and annotations through target, width, and font reflow', async ({
  page,
}, testInfo) => {
  await page.goto(`/research/${PAPER_ID}`)
  await expectStudioHydrated(page)
  await page.locator('html').evaluate((element) => {
    element.classList.add('disable-transitions')
  })
  await page.evaluate(() => document.fonts.ready)

  const rendition = page.locator('.srt-paper')
  const viewport = page.locator('.srt-viewport')
  const highlight = page.locator(
    '[data-annotation-id="highlight-reading-position"]',
  )
  const note = page.locator('[data-annotation-id="note-reading-position"]')
  const highlightSummary = page.locator(
    '[data-annotation-summary="highlight-reading-position"]',
  )
  const noteSummary = page.locator(
    '[data-annotation-summary="note-reading-position"]',
  )

  const expectAnchorVisibleAndCached = async () => {
    await expect
      .poll(async () => (await highlight.allTextContents()).join(''))
      .toBe(ANCHOR_QUOTE)
    await expect
      .poll(async () => (await note.allTextContents()).join(''))
      .toBe(ANCHOR_QUOTE)
    await expect(highlight.first()).toHaveAttribute(
      'data-anchor-node-id',
      'p-proposition-1',
    )
    await expect(highlightSummary).toHaveAttribute(
      'data-resolution-status',
      'resolved',
    )
    await expect(noteSummary).toHaveAttribute(
      'data-resolution-status',
      'resolved',
    )
    await expect
      .poll(async () =>
        Number(await highlightSummary.getAttribute('data-geometry-rect-count')),
      )
      .toBeGreaterThan(0)
    await expect
      .poll(async () =>
        Number(await noteSummary.getAttribute('data-geometry-rect-count')),
      )
      .toBeGreaterThan(0)

    const anchorBox = await highlight.first().boundingBox()
    const viewportBox = await viewport.boundingBox()
    expect(anchorBox).not.toBeNull()
    expect(viewportBox).not.toBeNull()
    expect(anchorBox!.y + anchorBox!.height).toBeGreaterThanOrEqual(
      viewportBox!.y,
    )
    expect(anchorBox!.y).toBeLessThanOrEqual(
      viewportBox!.y + viewportBox!.height,
    )

    const layoutVersion = await rendition.getAttribute('data-layout-version')
    expect(layoutVersion).toBeTruthy()
    await expect(highlightSummary).toHaveAttribute(
      'data-geometry-layout-version',
      layoutVersion!,
    )
    await expect(noteSummary).toHaveAttribute(
      'data-geometry-layout-version',
      layoutVersion!,
    )
    return layoutVersion!
  }

  const layoutVersions = new Set<string>()
  for (const target of TARGET_PROFILE_IDS) {
    const profile = getTargetProfile(target)
    await page.getByRole('button', { name: profile.label, exact: true }).click()
    await expect(rendition).toHaveAttribute('data-target-profile', target)
    layoutVersions.add(await expectAnchorVisibleAndCached())
  }

  await page.getByRole('button', { name: 'Simulate narrow reader' }).click()
  await expect(rendition).toHaveAttribute('data-width-scale', '0.86')
  layoutVersions.add(await expectAnchorVisibleAndCached())

  await page
    .getByRole('button', { name: 'Simulate larger reader text' })
    .click()
  await expect(rendition).toHaveAttribute('data-font-scale', '1.12')
  layoutVersions.add(await expectAnchorVisibleAndCached())

  expect(layoutVersions.size).toBe(TARGET_PROFILE_IDS.length + 2)
  await page.screenshot({
    animations: 'disabled',
    fullPage: true,
    path: testInfo.outputPath('annotation-reflow.png'),
  })
})

test('recomposes every finite profile in landscape without structural or geometry loss', async ({
  page,
  request,
}) => {
  const source = await jsonFixture<{ nodes: SourceNode[] }>(
    request,
    `/research/${PAPER_ID}/source.json`,
  )
  await page.goto(`/research/${PAPER_ID}`)
  await expectStudioHydrated(page)
  await page.locator('html').evaluate((element) => {
    element.classList.add('disable-transitions')
  })
  await page.evaluate(() => document.fonts.ready)

  for (const target of ['paperProMove', 'paperPro', 'print'] as const) {
    const portrait = getTargetProfile(target)
    await page
      .getByRole('button', { name: portrait.label, exact: true })
      .click()
    await page.getByRole('button', { name: 'Landscape', exact: true }).click()

    const paper = page.locator(
      `.srt-paper[data-target-profile="${target}"][data-orientation="landscape"]`,
    )
    const report = await inspectGeometry(paper, source.nodes)
    expect(report.missingNodes, `${target}: missing nodes`).toEqual([])
    expect(report.textLoss, `${target}: text loss`).toEqual([])
    expect(report.clippedContent, `${target}: clipping`).toEqual([])
    expect(report.overlaps, `${target}: overlap`).toEqual([])
    expect(report.horizontalOverflow, `${target}: horizontal overflow`).toEqual(
      [],
    )
    expect(report.orphanedCaptions, `${target}: captions`).toEqual([])
    expect(report.paper.width, `${target}: landscape width`).toBeCloseTo(
      portrait.preview.heightCssPx!,
      1,
    )
    for (const renderedPage of report.pages) {
      expect(renderedPage.width).toBeCloseTo(portrait.preview.heightCssPx!, 1)
      expect(renderedPage.height).toBeCloseTo(portrait.preview.widthCssPx, 1)
    }
  }
})

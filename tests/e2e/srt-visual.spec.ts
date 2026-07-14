import { expect, test, type Locator } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import {
  getTargetProfile,
  TARGET_PROFILE_IDS,
} from '../../src/research/targets'

const PAPER_ID = 'semantic-responsive-typesetting'
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
  overlaps: string[]
  orphanedCaptions: string[]
  horizontalOverflow: Array<{ element: string; amount: number }>
}

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
        overlaps,
        orphanedCaptions,
        horizontalOverflow: overflowCandidates.filter(
          ({ amount }) => amount > options.overflowEpsilon,
        ),
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
  page,
  request,
}, testInfo) => {
  const sourceResponse = await request.get(`/research/${PAPER_ID}/source.json`)
  expect(sourceResponse.ok()).toBe(true)
  const source = (await sourceResponse.json()) as { nodes: SourceNode[] }
  const manifestResponse = await request.get(
    `/research/${PAPER_ID}/manifest.json`,
  )
  expect(manifestResponse.ok()).toBe(true)
  const manifest = (await manifestResponse.json()) as {
    renditions: Array<{
      target: string
      pagination: {
        mode: 'continuous' | 'finite'
        finalPageCount: number | null
        violations: unknown[]
      }
      entries: Array<{ violations: unknown[] }>
    }>
  }
  const reports: GeometryReport[] = []

  for (const target of TARGET_PROFILE_IDS) {
    await page.goto(`/research/${PAPER_ID}`)
    await expect(
      page.locator('astro-island[component-url$="ResearchStudio.tsx"]'),
    ).toHaveAttribute('client-render-time', /.+/)
    await page.locator('html').evaluate((element) => {
      element.classList.add('disable-transitions')
    })
    await page.evaluate(() => document.fonts.ready)

    const profile = getTargetProfile(target)
    await page.getByRole('button', { name: profile.label, exact: true }).click()

    const paper = page.locator(`.srt-paper[data-target-profile="${target}"]`)
    await expect(paper).toBeVisible()

    const report = await inspectGeometry(paper, source.nodes)
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

  const reportPath = testInfo.outputPath('geometry-report.json')
  await writeFile(reportPath, `${JSON.stringify(reports, null, 2)}\n`)
  await testInfo.attach('geometry-report', {
    path: reportPath,
    contentType: 'application/json',
  })
})

import { expect, test, type Locator } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import {
  getTargetProfile,
  TARGET_PROFILE_IDS,
} from '../../src/research/targets'

const PAPER_ID = 'semantic-responsive-typesetting'
const GEOMETRY_EPSILON_CSS_PX = 0.5
const OVERFLOW_EPSILON_CSS_PX = 1

type GeometryReport = {
  target: string
  paper: { width: number; height: number }
  renderedNodeIds: string[]
  missingNodes: string[]
  duplicateNodes: string[]
  clippedContent: string[]
  overlaps: string[]
  horizontalOverflow: Array<{ element: string; amount: number }>
}

async function inspectGeometry(
  paper: Locator,
  expectedNodeIds: string[],
): Promise<GeometryReport> {
  return paper.evaluate(
    (article, options) => {
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
      }

      const toRect = (rect: DOMRect): Rect => ({
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      })
      const nodeElements = Array.from(
        article.querySelectorAll<HTMLElement>('[data-node-id]'),
      )
      const renderedNodeIds = nodeElements.map(
        (element) => element.dataset.nodeId ?? '',
      )
      const counts = new Map<string, number>()
      for (const id of renderedNodeIds)
        counts.set(id, (counts.get(id) ?? 0) + 1)

      const header = article.querySelector(':scope > header')
      const contentElements = [header, ...nodeElements].filter(
        (element): element is Element => element !== null,
      )
      const measured: MeasuredElement[] = contentElements.map((element) => ({
        element,
        label:
          element instanceof HTMLElement && element.dataset.nodeId
            ? element.dataset.nodeId
            : 'article-header',
        rects: Array.from(element.getClientRects(), toRect).filter(
          (rect) =>
            rect.width > options.geometryEpsilon &&
            rect.height > options.geometryEpsilon,
        ),
      }))
      const paperRect = toRect(article.getBoundingClientRect())
      const clippedContent = measured
        .filter(({ rects }) =>
          rects.some(
            (rect) =>
              rect.left < paperRect.left - options.geometryEpsilon ||
              rect.right > paperRect.right + options.geometryEpsilon ||
              rect.top < paperRect.top - options.geometryEpsilon ||
              rect.bottom > paperRect.bottom + options.geometryEpsilon,
          ),
        )
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

      const documentElement = document.documentElement
      const overflowCandidates = [
        {
          element: 'document',
          amount: documentElement.scrollWidth - documentElement.clientWidth,
        },
        {
          element: 'paper',
          amount: article.scrollWidth - article.clientWidth,
        },
        ...contentElements.map((element) => ({
          element:
            element instanceof HTMLElement && element.dataset.nodeId
              ? element.dataset.nodeId
              : 'article-header',
          amount:
            element instanceof HTMLElement
              ? element.scrollWidth - element.clientWidth
              : 0,
        })),
      ]

      return {
        target: article.getAttribute('data-target-profile') ?? 'unknown',
        paper: { width: paperRect.width, height: paperRect.height },
        renderedNodeIds,
        missingNodes: options.expectedNodeIds.filter((id) => !counts.has(id)),
        duplicateNodes: [...counts.entries()]
          .filter(([, count]) => count !== 1)
          .map(([id]) => id),
        clippedContent,
        overlaps,
        horizontalOverflow: overflowCandidates.filter(
          ({ amount }) => amount > options.overflowEpsilon,
        ),
      }
    },
    {
      expectedNodeIds,
      geometryEpsilon: GEOMETRY_EPSILON_CSS_PX,
      overflowEpsilon: OVERFLOW_EPSILON_CSS_PX,
    },
  )
}

test('captures every target and rejects invalid geometry', async ({
  page,
  request,
}, testInfo) => {
  const sourceResponse = await request.get(`/research/${PAPER_ID}/source.json`)
  expect(sourceResponse.ok()).toBe(true)
  const source = (await sourceResponse.json()) as {
    nodes: Array<{ id: string }>
  }
  const expectedNodeIds = source.nodes.map((node) => node.id)
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

    const report = await inspectGeometry(paper, expectedNodeIds)
    reports.push(report)
    expect.soft(report.target, `${target}: active target`).toBe(target)
    expect.soft(report.missingNodes, `${target}: missing nodes`).toEqual([])
    expect.soft(report.duplicateNodes, `${target}: duplicate nodes`).toEqual([])
    expect.soft(report.clippedContent, `${target}: clipped content`).toEqual([])
    expect.soft(report.overlaps, `${target}: overlapping content`).toEqual([])
    expect
      .soft(report.horizontalOverflow, `${target}: horizontal overflow`)
      .toEqual([])

    await paper.evaluate((article) => {
      document.body.replaceChildren(article)
      document.body.style.margin = '0'
      document.body.style.background = '#faf9f4'
      article.style.margin = '0'
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

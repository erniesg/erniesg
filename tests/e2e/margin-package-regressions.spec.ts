import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { MarginRailElement } from '../../packages/margin/src/element'
import type { PaintTarget } from '../../packages/margin/src/dom/paint'
import type { MarginTransport } from '../../packages/margin/src/transport'

declare global {
  interface Window {
    marginTest: {
      render(props: {
        documentUri: string
        apiBase?: string
        transport?: unknown
        annotations?: unknown[]
      }): void
      paint(targets: PaintTarget[], palette: Record<string, string>, namespace: string): () => void
      capture(range: Range): { status: string; anchors?: { nodeId: string; position: { start: number; end: number } }[] }
    }
    marginInjected: MarginTransport
  }
}

const root = process.cwd()
const entry = `
  import React from '${path.join(root, 'node_modules/react/index.js')}'
  import { createRoot } from '${path.join(root, 'node_modules/react-dom/client.js')}'
  import { MarginRail } from '${path.join(root, 'packages/margin/src/react.tsx')}'
  import { readAnchorableBlocks } from '${path.join(root, 'packages/margin/src/dom/blocks.ts')}'
  import { paintHighlights } from '${path.join(root, 'packages/margin/src/dom/paint.ts')}'
  import { anchorsFromRange } from '${path.join(root, 'packages/margin/src/dom/selection.ts')}'
  const root = createRoot(document.getElementById('mount'))
  window.marginTest = {
    render: (props) => root.render(React.createElement(MarginRail, props)),
    paint: (targets, palette, namespace) => paintHighlights(
      readAnchorableBlocks(document), targets,
      { palette, registryNamespace: namespace },
    ),
    capture: (range) => anchorsFromRange(range, readAnchorableBlocks(document)),
  }
`
const bundle = execFileSync(path.join(root, 'node_modules/.bin/esbuild'), [
  '--bundle',
  '--platform=browser',
  '--format=iife',
  '--loader=tsx',
], { input: entry, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

test.beforeEach(async ({ page }) => {
  await page.setContent(
    '<p id="quote" data-block-kind="prose">A colorful passage.</p><div id="mount"></div>',
  )
  await page.addScriptTag({ content: bundle })
})

test('arbitrary palette keys paint through CSS highlights without collisions', async ({ page }) => {
  const result = await page.evaluate(() => {
    const palette = {
      'brand.yellow': 'rgb(255, 0, 0)',
      'brand yellow': 'rgb(0, 255, 0)',
      '色': 'rgb(0, 0, 255)',
    }
    const names: string[] = []
    for (const [index, color] of Object.keys(palette).entries()) {
      const before = new Set(CSS.highlights.keys())
      window.marginTest.paint(
        [{ id: String(index), color, nodeId: 'quote', start: 0, end: 1 }],
        palette,
        index === 0 ? 'brand.yellow' : 'brand yellow',
      )
      const name = [...CSS.highlights.keys()].find((key) => !before.has(key))!
      names.push(name)
      const computed = getComputedStyle(document.querySelector('#quote')!, `::highlight(${name})`).backgroundColor
      if (computed !== Object.values(palette)[index]) throw new Error(`Highlight ${name} painted ${computed}`)
    }
    return names
  })
  expect(new Set(result).size).toBe(3)
})

test('React restores apiBase after removing an override and preserves client-only mode', async ({ page }) => {
  await page.evaluate(() => {
    window.marginInjected = { request: async () => ({ status: 200, body: {} }) }
    window.marginTest.render({ documentUri: 'doc', apiBase: '/service' })
  })
  await expect.poll(() => page.evaluate(() => Boolean(document.querySelector<MarginRailElement>('margin-rail')?.transport))).toBe(true)

  await page.evaluate(() => window.marginTest.render({
    documentUri: 'doc', apiBase: '/service', transport: window.marginInjected,
  }))
  await expect.poll(() => page.evaluate(() => document.querySelector<MarginRailElement>('margin-rail')?.transport === window.marginInjected)).toBe(true)

  await page.evaluate(() => window.marginTest.render({ documentUri: 'doc', apiBase: '/service' }))
  await expect.poll(() => page.evaluate(() => {
    const transport = document.querySelector<MarginRailElement>('margin-rail')?.transport
    return Boolean(transport && transport !== window.marginInjected)
  })).toBe(true)

  await page.evaluate(() => window.marginTest.render({
    documentUri: 'doc', apiBase: '/service', transport: window.marginInjected,
  }))
  await expect.poll(() => page.evaluate(() => document.querySelector<MarginRailElement>('margin-rail')?.transport === window.marginInjected)).toBe(true)

  await page.evaluate(() => window.marginTest.render({ documentUri: 'doc' }))
  await expect.poll(() => page.evaluate(() => document.querySelector<MarginRailElement>('margin-rail')?.transport === null)).toBe(true)
})

/**
 * Review round on #338. Each test pins a rule over every instance of its shape,
 * not the one reported line.
 */

const RULES_FIXTURE = [
  '<p id="prose" data-block-kind="prose">alpha <em>beta</em> gamma</p>',
  '<p id="spaced" data-block-kind="prose">one   two</p>',
  '<p id="mixed" data-block-kind="prose">lead <span data-margin-annotatable="false">Generated</span> tail</p>',
  '<p id="next" data-block-kind="prose">   </p>',
  '<figure id="fig" data-block-kind="figure">Figure text</figure>',
  '<div id="mount"></div>',
].join('')

test.describe('review rules', () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(RULES_FIXTURE)
    await page.addScriptTag({ content: bundle })
  })

  // Rule: every DOM spelling of one boundary maps to the same text offset. A
  // point on an element boundary (as `selectNode` and `selectNodeContents`
  // produce) must land on the same side as the text-node spelling of it.
  test('every spelling of a boundary maps to the same offset', async ({ page }) => {
    const results = await page.evaluate(() => {
      const prose = document.querySelector('#prose')!
      const [alpha, em, gamma] = Array.from(prose.childNodes)
      const beta = em.firstChild!
      const spell = (build: (range: Range) => void) => {
        const range = document.createRange()
        build(range)
        const capture = window.marginTest.capture(range)
        return capture.anchors?.map((anchor) => [anchor.position.start, anchor.position.end])
      }
      return {
        textEm: spell((r) => { r.setStart(beta, 0); r.setEnd(beta, 4) }),
        selectNodeEm: spell((r) => r.selectNode(em)),
        selectContentsEm: spell((r) => r.selectNodeContents(em)),
        parentPointsEm: spell((r) => { r.setStart(prose, 1); r.setEnd(prose, 2) }),
        textAlpha: spell((r) => { r.setStart(alpha, 0); r.setEnd(alpha, 5) }),
        selectNodeAlpha: spell((r) => r.selectNode(alpha)),
        textGamma: spell((r) => { r.setStart(gamma, 1); r.setEnd(gamma, 6) }),
        selectNodeGamma: spell((r) => r.selectNode(gamma)),
        endOfBlock: spell((r) => { r.setStart(beta, 0); r.setEnd(prose, 3) }),
        // A point inside a skipped subtree lands on the next indexed text.
        fromInsideSkipped: (() => {
          const mixed = document.querySelector('#mixed')!
          const generated = mixed.childNodes[1].firstChild!
          const tail = mixed.childNodes[2]
          return spell((r) => { r.setStart(generated, 3); r.setEnd(tail, 5) })
        })(),
        fromBeforeSkipped: (() => {
          const mixed = document.querySelector('#mixed')!
          return spell((r) => { r.setStart(mixed, 1); r.setEnd(mixed, 3) })
        })(),
      }
    })
    const beta = [[6, 10]]
    expect(results.textEm).toEqual(beta)
    expect(results.selectNodeEm).toEqual(beta)
    expect(results.selectContentsEm).toEqual(beta)
    expect(results.parentPointsEm).toEqual(beta)
    // Trimming drops the trailing space of `alpha ` and the leading one of ` gamma`.
    expect(results.textAlpha).toEqual([[0, 5]])
    expect(results.selectNodeAlpha).toEqual([[0, 5]])
    expect(results.textGamma).toEqual([[11, 16]])
    expect(results.selectNodeGamma).toEqual([[11, 16]])
    expect(results.endOfBlock).toEqual([[6, 16]])
    // `lead ` + ` tail`: the excluded word is not in the coordinate space.
    expect(results.fromInsideSkipped).toEqual([[6, 10]])
    expect(results.fromBeforeSkipped).toEqual([[6, 10]])
  })

  // Rule: `non-annotatable` means the selection's non-whitespace content is all
  // in excluded subtrees. Whitespace alone is `empty`, wherever it sits.
  test('only excluded content is non-annotatable; whitespace alone is empty', async ({ page }) => {
    const statuses = await page.evaluate(() => {
      const status = (build: (range: Range) => void) => {
        const range = document.createRange()
        build(range)
        return window.marginTest.capture(range).status
      }
      const spaced = document.querySelector('#spaced')!.firstChild!
      const mixed = document.querySelector('#mixed')!
      const [lead, generated, tail] = Array.from(mixed.childNodes)
      const next = document.querySelector('#next')!.firstChild!
      const fig = document.querySelector('#fig')!.firstChild!
      return {
        whitespaceInProse: status((r) => { r.setStart(spaced, 3); r.setEnd(spaced, 6) }),
        whitespaceAcrossBlocks: status((r) => { r.setStart(tail, 5); r.setEnd(next, 3) }),
        whitespaceAroundGenerated: status((r) => { r.setStart(lead, 4); r.setEnd(tail, 1) }),
        generatedOnly: status((r) => r.selectNodeContents(generated)),
        figureOnly: status((r) => { r.setStart(fig, 0); r.setEnd(fig, 6) }),
        realText: status((r) => { r.setStart(spaced, 0); r.setEnd(spaced, 3) }),
      }
    })
    expect(statuses).toEqual({
      whitespaceInProse: 'empty',
      whitespaceAcrossBlocks: 'empty',
      whitespaceAroundGenerated: 'non-annotatable',
      generatedOnly: 'non-annotatable',
      figureOnly: 'non-annotatable',
      realText: 'captured',
    })
  })

  // Rule: a painter's cleanup leaves the document exactly as it found it, on
  // both paint paths — nothing in <head>, nothing in <body>, no registry key.
  for (const path of ['css-highlights', 'overlay'] as const) {
    test(`paint cleanup restores the document (${path})`, async ({ page }) => {
      const result = await page.evaluate((path) => {
        const saved = window.Highlight
        if (path === 'overlay') {
          ;(window as unknown as { Highlight?: unknown }).Highlight = undefined
        }
        const snapshot = () => ({
          head: document.head.innerHTML,
          body: document.body.innerHTML,
          highlights: [...CSS.highlights.keys()].sort(),
        })
        const before = snapshot()
        const cleanups = [1, 2, 3].map((n) =>
          window.marginTest.paint(
            [{ id: String(n), color: 'amber', nodeId: 'prose', start: 0, end: 5 }],
            { amber: 'rgb(255, 0, 0)' },
            `rail-${n}`,
          ),
        )
        const during = snapshot()
        for (const cleanup of cleanups) cleanup()
        const after = snapshot()
        window.Highlight = saved
        return { before, during, after }
      }, path)
      expect(result.during).not.toEqual(result.before)
      expect(result.after).toEqual(result.before)
    })
  }

  // Rule: an optional React prop that goes from set to absent leaves the rail
  // exactly as a fresh mount without it would, whatever came before.
  test('removing an optional prop matches a fresh mount without it', async ({ page }) => {
    const annotation = {
      id: 'a1',
      kind: 'highlight',
      target: {
        nodeId: 'prose',
        position: { start: 0, end: 5 },
        quote: { exact: 'alpha', prefix: '', suffix: ' beta' },
      },
      appearance: { color: 'amber' },
      geometryCache: [],
    }
    const rail = () =>
      page.evaluate(() => {
        const element = document.querySelector<MarginRailElement>('margin-rail')
        return element
          ? { annotations: element.annotations.length, transport: element.transport === null }
          : null
      })

    await page.evaluate(() => window.marginTest.render({ documentUri: 'doc' }))
    await expect.poll(rail).not.toBeNull()
    const fresh = await rail()

    await page.evaluate((annotation) => {
      window.marginInjected = { request: async () => ({ status: 200, body: {} }) }
      window.marginTest.render({
        documentUri: 'doc',
        annotations: [annotation],
        transport: window.marginInjected,
      })
    }, annotation)
    await expect.poll(rail).toEqual({ annotations: 1, transport: false })

    await page.evaluate(() => window.marginTest.render({ documentUri: 'doc' }))
    await expect.poll(rail).toEqual(fresh)
  })
})

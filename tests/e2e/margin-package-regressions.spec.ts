import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { MarginRailElement } from '../../packages/margin/src/element'
import type { PaintTarget } from '../../packages/margin/src/dom/paint'
import type { MarginTransport } from '../../packages/margin/src/transport'

declare global {
  interface Window {
    marginTest: {
      render(props: { documentUri: string; apiBase?: string; transport?: unknown }): void
      paint(targets: PaintTarget[], palette: Record<string, string>, namespace: string): void
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
  const root = createRoot(document.getElementById('mount'))
  window.marginTest = {
    render: (props) => root.render(React.createElement(MarginRail, props)),
    paint: (targets, palette, namespace) => paintHighlights(
      readAnchorableBlocks(document), targets,
      { palette, registryNamespace: namespace },
    ),
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

import { access, cp, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adaptAstroBlogEntry } from '../adapters/astro'
import {
  PUBLICATION_PROFILES,
  prepareWebPubDirectory,
  publicationGraphToHtml,
  publicationPlaywrightExecutableCandidates,
  renderEpubToc,
  vivliostyleRenderer,
} from './vivliostyle'
import type { PublicationNode } from '../schema'

async function fixtureCollection(name: string) {
  const root = await mkdtemp(resolve(tmpdir(), 'publication-renderer-'))
  const entry = resolve(root, name)
  await mkdir(entry)
  await cp(
    resolve(`tests/fixtures/publication/astro/${name}.mdx`),
    resolve(entry, 'index.mdx'),
  )
  await cp(
    resolve('tests/fixtures/publication/astro/fixture-image.svg'),
    resolve(entry, 'fixture-image.svg'),
  )
  return root
}

describe('Vivliostyle publication renderer boundary', () => {
  it('renders repository-owned semantic HTML without Astro knowledge', async () => {
    const bundle = await adaptAstroBlogEntry({
      entryId: 'moving-to-cloudflare-with-astro',
    })
    const paths = new Map(
      bundle.assetBundle.descriptor.assets.map((asset) => [
        asset.id,
        `assets/${asset.fileName}`,
      ]),
    )
    const html = publicationGraphToHtml(bundle.graph, paths, 'phone-webpub')
    expect(html).toContain('<main>')
    expect(html).toContain('<h1>Moving to Cloudflare Pages with Astro</h1>')
    expect(html).toContain(
      'alt="The Astro logo in white on an orange-to-purple gradient"',
    )
    expect(html.indexOf('Why Astro?')).toBeLessThan(
      html.indexOf('The Benefits of Cloudflare Pages'),
    )
    const rendererSource = await readFile(
      'src/publication/renderers/vivliostyle.ts',
      'utf8',
    )
    expect(rendererSource).not.toMatch(/from ['"][^'"]*astro/)
    expect(rendererSource).not.toContain('.provenance')
  })

  it('renders nested lists, inline-code semantics, and footnote noteref semantics', async () => {
    const contentRoot = await fixtureCollection('synthetic-publication')
    const bundle = await adaptAstroBlogEntry({
      entryId: 'synthetic-publication',
      contentRoot,
    })
    const paragraph = bundle.graph.nodes.find(
      (node) => node.type === 'paragraph',
    )
    if (!paragraph || paragraph.type !== 'paragraph')
      throw new Error('missing paragraph')
    const suffix = ' main'
    const graph = {
      ...bundle.graph,
      nodes: bundle.graph.nodes.map((node) =>
        node.type === 'paragraph' && node.id === paragraph.id
          ? {
              ...node,
              text: `${node.text}${suffix}`,
              inlineRuns: [
                ...(node.inlineRuns ?? []),
                {
                  start: node.text.length + 1,
                  end: node.text.length + suffix.length,
                  inlineCode: true,
                },
              ],
            }
          : node,
      ),
    }
    const outerList = graph.nodes.find(
      (node): node is Extract<PublicationNode, { type: 'list' }> =>
        node.type === 'list',
    )
    const outerItem = graph.nodes.find(
      (node): node is Extract<PublicationNode, { type: 'list-item' }> =>
        node.type === 'list-item' && node.id === outerList?.itemIds[0],
    )
    if (!outerList || !outerItem || outerItem.type !== 'list-item')
      throw new Error('missing list fixture')
    const nestedList = {
      ...outerList,
      id: 'nested-list',
      itemIds: ['nested-item'],
    }
    const nestedItem = {
      ...outerItem,
      id: 'nested-item',
      parentListId: 'nested-list',
      childListIds: [],
      text: 'Nested child',
      inlineRuns: [],
    }
    graph.nodes = graph.nodes
      .map((node) =>
        node.id === outerItem.id
          ? { ...node, childListIds: ['nested-list'] }
          : node,
      )
      .concat(nestedList, nestedItem)
    const paths = new Map(
      bundle.assetBundle.descriptor.assets.map((asset) => [
        asset.id,
        `assets/${asset.fileName}`,
      ]),
    )
    const html = publicationGraphToHtml(graph, paths, 'phone-webpub')
    expect(html).toContain('<code>main</code>')
    expect(html).toContain('id="ref-proof"')
    expect(html).toContain('role="doc-noteref"')
    expect(html).toContain('<sup>[proof]</sup>')
    expect(html.match(/id="nested-list"/g)).toHaveLength(1)
    expect(html.indexOf('Nested child')).toBeGreaterThan(
      html.indexOf('First item'),
    )
  })

  it('fails an incomplete output matrix before rendering', async () => {
    const bundle = await adaptAstroBlogEntry({
      entryId: 'moving-to-cloudflare-with-astro',
    })
    await expect(
      vivliostyleRenderer.render(bundle, {
        outputDirectory: '.agent/evidence/incomplete-publication',
        profiles: PUBLICATION_PROFILES.slice(0, 1),
      }),
    ).rejects.toThrow(/output matrix must be exactly/)
  })

  it('nests EPUB navigation entries according to heading levels', () => {
    const toc = renderEpubToc([
      { id: 'h1', level: 1, text: 'One' },
      { id: 'h2', level: 2, text: 'Two' },
      { id: 'h3', level: 3, text: 'Three' },
      { id: 'h2b', level: 2, text: 'Two B' },
    ])
    expect(toc).toContain(
      '<li><a href="content.xhtml#h1">One</a><ol><li><a href="content.xhtml#h2">Two</a><ol><li><a href="content.xhtml#h3">Three</a></li></ol></li><li><a href="content.xhtml#h2b">Two B</a></li></ol></li>',
    )
  })

  it('resolves Playwright executables using each supported host layout', () => {
    expect(
      publicationPlaywrightExecutableCandidates('1228', 'darwin', 'arm64'),
    ).toEqual([
      expect.stringContaining('chrome-mac-arm64/Google Chrome for Testing.app'),
      expect.stringContaining('chrome-headless-shell-mac-arm64'),
    ])
    expect(
      publicationPlaywrightExecutableCandidates('1228', 'win32', 'arm64'),
    ).toEqual([
      expect.stringContaining('chrome-win64/chrome.exe'),
      expect.stringContaining('chrome-headless-shell-win64'),
    ])
  })

  it('removes stale WebPub assets before a new publication', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-webpub-clean-'))
    const webpub = resolve(root, 'phone-webpub')
    await mkdir(resolve(webpub, 'assets'), { recursive: true })
    const stale = resolve(webpub, 'assets', 'stale.svg')
    await (await import('node:fs/promises')).writeFile(stale, 'stale')
    await prepareWebPubDirectory(webpub)
    await expect(access(stale)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

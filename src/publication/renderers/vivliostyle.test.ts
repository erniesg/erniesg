import { access, cp, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adaptAstroBlogEntry } from '../adapters/astro'
import {
  PUBLICATION_PROFILES,
  preparePublicationAssetDirectory,
  prepareWebPubDirectory,
  publicationAssetFileExtension,
  publicationEpubAccessibilityMetadata,
  publicationEpubManifestItemId,
  publicationBrowserVersionMatches,
  publicationGraphToHtml,
  publicationPlaywrightExecutableCandidates,
  publicationVariantKindForProfile,
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

  it('coalesces styled link runs and preserves hard-break markup', async () => {
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
    const graph = {
      ...bundle.graph,
      nodes: bundle.graph.nodes.map((node) =>
        node.id === paragraph.id
          ? {
              ...node,
              text: 'read this\n',
              inlineRuns: [
                { start: 0, end: 5, href: 'https://example.com/' },
                { start: 5, end: 9, href: 'https://example.com/', bold: true },
                { start: 9, end: 10, hardBreak: true },
              ],
            }
          : node,
      ),
    }
    const paths = new Map(
      bundle.assetBundle.descriptor.assets.map((asset) => [
        asset.id,
        `assets/${asset.fileName}`,
      ]),
    )
    const html = publicationGraphToHtml(graph, paths, 'phone-webpub')
    expect(html.match(/href="https:\/\/example\.com\//g)).toHaveLength(1)
    expect(html).toContain('<strong>this</strong>')
    expect(html).toContain('</a><br>')
    expect(html).toContain('<br>')
  })

  it('rejects hard-break runs that cover authored text', async () => {
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
    const graph = {
      ...bundle.graph,
      nodes: bundle.graph.nodes.map((node) =>
        node.id === paragraph.id
          ? {
              ...node,
              text: 'authored text',
              inlineRuns: [{ start: 0, end: 4, hardBreak: true }],
            }
          : node,
      ),
    }
    expect(() =>
      publicationGraphToHtml(graph, new Map(), 'phone-webpub'),
    ).toThrow(/Malformed hard-break inline run/)
  })

  it('renders subtitles and source-backed figures while requiring alternatives', async () => {
    const bundle = await adaptAstroBlogEntry({
      entryId: 'moving-to-cloudflare-with-astro',
    })
    const template = bundle.graph.nodes[0]
    if (!template || template.type !== 'figure')
      throw new Error('missing figure fixture')
    const sourceFigure = {
      ...template,
      id: 'source-figure',
      title: 'Source figure',
      assetIds: [],
      sourceText: 'diagram source',
      accessibility: {
        decorative: false,
        longDescription: 'Diagram description',
      },
    }
    const graph = {
      ...bundle.graph,
      metadata: { ...bundle.graph.metadata, subtitle: 'A useful subtitle' },
      nodes: [sourceFigure],
    }
    const html = publicationGraphToHtml(graph, new Map(), 'phone-webpub')
    expect(html).toContain('<p class="subtitle">A useful subtitle</p>')
    expect(html).toContain('<div class="figure-title">Source figure</div>')
    expect(html).toContain('class="figure-source"')
    expect(html).toContain('diagram source')
    expect(() =>
      publicationGraphToHtml(
        {
          ...graph,
          nodes: [{ ...sourceFigure, accessibility: { decorative: false } }],
        },
        new Map(),
        'phone-webpub',
      ),
    ).toThrow(/requires alternative text or a long description/)
  })

  it('renders target-only cross-references and preserves note-kind semantics', async () => {
    const contentRoot = await fixtureCollection('synthetic-publication')
    const bundle = await adaptAstroBlogEntry({
      entryId: 'synthetic-publication',
      contentRoot,
    })
    const paragraph = bundle.graph.nodes.find((node) => node.type === 'paragraph')
    const note = bundle.graph.nodes.find((node) => node.type === 'note')
    if (!paragraph || paragraph.type !== 'paragraph' || !note || note.type !== 'note')
      throw new Error('missing semantic fixture')
    const graph = {
      ...bundle.graph,
      nodes: bundle.graph.nodes
        .map((node) =>
          node.id === paragraph.id
            ? {
                ...node,
                text: 'Jump',
                inlineRuns: [
                  {
                    start: 0,
                    end: 4,
                    semanticRole: 'cross-reference' as const,
                    targetIds: ['hero-figure'],
                  },
                ],
              }
            : node,
        )
        .concat(
          { ...note, id: 'endnote', noteKind: 'endnote', backlinkIds: [] },
          { ...note, id: 'author-note', noteKind: 'author-note', backlinkIds: [] },
        ),
    }
    const html = publicationGraphToHtml(
      graph,
      new Map(
        bundle.assetBundle.descriptor.assets.map((asset) => [
          asset.id,
          `assets/${asset.fileName}`,
        ]),
      ),
      'phone-webpub',
    )
    expect(html).toContain('href="#hero-figure"')
    const heroLink = html.match(/<a[^>]+href="#hero-figure"[^>]*>/)?.[0]
    expect(heroLink).toBeDefined()
    expect(heroLink).not.toContain('role="doc-noteref"')
    expect(html).toContain('role="doc-endnote"')
    expect(html).toContain('role="doc-annotation"')
  })

  it('prints nondecorative audio transcripts in paged profiles', async () => {
    const bundle = await adaptAstroBlogEntry({
      entryId: 'moving-to-cloudflare-with-astro',
    })
    const template = bundle.graph.nodes[0]
    const graph = {
      ...bundle.graph,
      nodes: [
        {
          ...template,
          id: 'print-audio',
          type: 'media' as const,
          mediaKind: 'audio' as const,
          assetId: 'audio-asset',
          accessibility: { decorative: false, transcript: 'Spoken proof' },
        },
      ],
    }
    const html = publicationGraphToHtml(
      graph,
      new Map([['audio-asset', 'assets/audio.mp3']]),
      'a5-pdf',
    )
    expect(html).toContain('class="media-transcript"')
    expect(html).toContain('Spoken proof')
  })

  it('rejects captions without reciprocal parent ownership', async () => {
    const bundle = await adaptAstroBlogEntry({
      entryId: 'moving-to-cloudflare-with-astro',
    })
    const template = bundle.graph.nodes[0]
    if (!template || template.type !== 'figure') throw new Error('missing figure fixture')
    const figure = { ...template, id: 'orphan-figure' } as any
    delete figure.captionId
    const caption = {
      ...template,
      id: 'orphan-caption',
      type: 'caption' as const,
      parentId: 'orphan-figure',
      text: 'Orphan caption',
    } as any
    expect(() =>
      publicationGraphToHtml(
        { ...bundle.graph, nodes: [figure, caption] },
        new Map(),
        'phone-webpub',
      ),
    ).toThrow(/reciprocal caption ownership/)
  })

  it('keeps the e-ink stylesheet line height aligned with the receipt', async () => {
    const css = await readFile('src/styles/publication/publication.css', 'utf8')
    expect(css).toMatch(
      /html\[data-profile='eink-epub'\]\s*\{[^}]*line-height:\s*1\.5/s,
    )
  })

  it('selects reviewed profile variants and preserves node language and direction', async () => {
    const bundle = await adaptAstroBlogEntry({
      entryId: 'moving-to-cloudflare-with-astro',
    })
    const figure = bundle.graph.nodes.find((node) => node.type === 'figure')
    const paragraph = bundle.graph.nodes.find((node) => node.type === 'paragraph')
    if (!figure || !paragraph || figure.type !== 'figure' || paragraph.type !== 'paragraph')
      throw new Error('missing variant fixture')
    const graph = {
      ...bundle.graph,
      nodes: [
        {
          ...figure,
          variants: [
            {
              kind: 'monochrome' as const,
              assetId: 'monochrome-asset',
              reviewed: true,
            },
          ],
        },
        {
          ...paragraph,
          locale: 'ar',
          direction: 'rtl' as const,
          variants: [
            { kind: 'compact' as const, text: 'مختصر', reviewed: true },
          ],
        },
      ],
    }
    const paths = new Map(
      bundle.assetBundle.descriptor.assets.map((asset) => [
        asset.id,
        `assets/${asset.fileName}`,
      ]),
    )
    paths.set('monochrome-asset', 'assets/monochrome.png')
    expect(publicationVariantKindForProfile('eink-epub')).toBe('monochrome')
    expect(publicationVariantKindForProfile('a5-pdf')).toBe('compact')
    const epub = publicationGraphToHtml(graph, paths, 'eink-epub')
    expect(epub).toContain('src="assets/monochrome.png"')
    expect(epub).toContain('lang="ar"')
    expect(epub).toContain('dir="rtl"')
    const a5 = publicationGraphToHtml(graph, paths, 'a5-pdf')
    expect(a5).toContain('مختصر')
    const phone = publicationGraphToHtml(graph, paths, 'phone-webpub')
    expect(phone).toContain(`src="assets/${bundle.assetBundle.descriptor.assets[0]?.fileName}"`)
    expect(phone).not.toContain('مختصر')
  })

  it('selects reviewed profile variants for equation captions', async () => {
    const bundle = await adaptAstroBlogEntry({
      entryId: 'moving-to-cloudflare-with-astro',
    })
    const template = bundle.graph.nodes[0]
    const graph = {
      ...bundle.graph,
      nodes: [
        {
          ...template,
          id: 'equation',
          type: 'equation' as const,
          source: 'x = 1',
          format: 'plain-text' as const,
          captionId: 'equation-caption',
        },
        {
          ...template,
          id: 'equation-caption',
          type: 'caption' as const,
          parentId: 'equation',
          text: 'Canonical equation caption',
          variants: [
            { kind: 'compact' as const, text: 'Compact equation caption', reviewed: true },
          ],
        },
      ],
    }
    const html = publicationGraphToHtml(graph, new Map(), 'a5-pdf')
    expect(html).toContain('Compact equation caption')
    expect(html).not.toContain('Canonical equation caption')
  })

  it('derives EPUB accessibility modes and features from graph media', () => {
    const metadata = publicationEpubAccessibilityMetadata({
      metadata: { title: 'Publication' },
      nodes: [
        {
          type: 'paragraph',
          text: 'Body',
          accessibility: { alternativeText: '', decorative: false },
        },
        {
          type: 'figure',
          assetIds: ['image'],
          accessibility: { alternativeText: 'Image', decorative: false },
        },
        {
          type: 'media',
          mediaKind: 'audio',
          assetId: 'audio',
          accessibility: { transcript: 'Transcript', decorative: false },
        },
      ],
    } as any)
    expect(metadata.accessModes).toEqual(['textual', 'visual', 'auditory'])
    expect(metadata.accessModeSufficient).toEqual(['textual'])
    expect(metadata.accessibilityFeatures).toEqual([
      'alternativeText',
      'transcript',
    ])
  })

  it('renders captions, table relationships, media kinds, automatic direction, and citations', async () => {
    const bundle = await adaptAstroBlogEntry({
      entryId: 'moving-to-cloudflare-with-astro',
    })
    const template = bundle.graph.nodes[0]
    const assetId = bundle.assetBundle.descriptor.assets[0]?.id ?? 'asset'
    const graph = {
      ...bundle.graph,
      edition: { ...bundle.graph.edition, direction: 'auto' as const },
      nodes: [
        template,
        {
          ...template,
          id: 'citation-paragraph',
          type: 'paragraph' as const,
          text: 'Cite',
          inlineRuns: [
            {
              start: 0,
              end: 4,
              semanticRole: 'citation' as const,
              targetIds: ['citation-reference'],
            },
          ],
        },
        {
          ...template,
          id: 'citation-reference',
          type: 'reference' as const,
          targetIds: ['citation-paragraph'],
          text: 'Reference',
        },
        {
          ...template,
          id: 'render-table',
          type: 'table' as const,
          captionId: 'render-table-caption',
          rows: [
            {
              cells: [
                {
                  id: 'header',
                  text: 'Header',
                  headerScope: 'column' as const,
                  columnSpan: 2,
                  rowSpan: 2,
                },
                {
                  id: 'cell',
                  text: 'Cell',
                  headerScope: null,
                  columnSpan: 1,
                  rowSpan: 1,
                  headerIds: ['header'],
                },
              ],
            },
          ],
        },
        {
          ...template,
          id: 'render-table-caption',
          type: 'caption' as const,
          parentId: 'render-table',
          text: 'Table caption',
        },
        {
          ...template,
          id: 'render-media',
          type: 'media' as const,
          mediaKind: 'audio' as const,
          assetId,
          captionId: 'render-media-caption',
        },
        {
          ...template,
          id: 'render-media-caption',
          type: 'caption' as const,
          parentId: 'render-media',
          text: 'Audio caption',
        },
      ],
    }
    const paths = new Map([[assetId, 'assets/audio.bin']])
    const html = publicationGraphToHtml(graph, paths, 'phone-webpub')
    expect(html).toContain('dir="auto"')
    expect(html).toContain(
      '<caption id="render-table-caption">Table caption</caption>',
    )
    expect(html).toContain('colspan="2"')
    expect(html).toContain('rowspan="2"')
    expect(html).toContain('headers="header"')
    expect(html).toContain('<audio controls')
    expect(html).toContain('<audio controls="controls"')
    expect(html).toContain('Audio caption')
    expect(html).toContain('href="#citation-reference"')
    expect(() =>
      publicationGraphToHtml(
        {
          ...graph,
          nodes: graph.nodes.map((node) =>
            node.id === 'render-media'
              ? { ...node, accessibility: { decorative: false } }
              : node,
          ),
        },
        paths,
        'phone-webpub',
      ),
    ).toThrow(/Media render-media requires/)
  })

  it('falls through empty alternatives before requiring a media label', async () => {
    const bundle = await adaptAstroBlogEntry({
      entryId: 'moving-to-cloudflare-with-astro',
    })
    const template = bundle.graph.nodes[0]
    const graph = {
      ...bundle.graph,
      nodes: [
        {
          ...template,
          type: 'media' as const,
          id: 'audio-with-fallback-label',
          mediaKind: 'audio' as const,
          assetId: 'asset',
          accessibility: {
            decorative: false,
            alternativeText: '',
            transcript: 'Spoken proof',
          },
        },
      ],
    }
    expect(
      publicationGraphToHtml(
        graph,
        new Map([['asset', 'assets/audio.mp3']]),
        'phone-webpub',
      ),
    ).toContain('aria-label="Spoken proof"')
  })

  it('hides decorative non-image media controls and preserves equation labels', async () => {
    const bundle = await adaptAstroBlogEntry({
      entryId: 'moving-to-cloudflare-with-astro',
    })
    const template = bundle.graph.nodes[0]
    const graph = {
      ...bundle.graph,
      nodes: [
        {
          ...template,
          type: 'media' as const,
          id: 'decorative-audio',
          mediaKind: 'audio' as const,
          assetId: 'asset',
          accessibility: { decorative: true },
        },
        {
          ...template,
          type: 'equation' as const,
          id: 'equation-with-label',
          source: 'x = 1',
          format: 'plain-text' as const,
          label: 'Eq. 1',
        },
      ],
    }
    const html = publicationGraphToHtml(
      graph,
      new Map([['asset', 'assets/audio.mp3']]),
      'phone-webpub',
    )
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('<audio controls')
    expect(html).toContain('class="equation-label">Eq. 1</span>')
  })

  it('fails closed for MathML until a safe renderer exists', async () => {
    const bundle = await adaptAstroBlogEntry({
      entryId: 'moving-to-cloudflare-with-astro',
    })
    const template = bundle.graph.nodes[0]
    const graph = {
      ...bundle.graph,
      nodes: [
        template,
        {
          ...template,
          id: 'mathml',
          type: 'equation' as const,
          source: '<math><mi>x</mi></math>',
          format: 'mathml' as const,
        },
      ],
    }
    expect(() =>
      publicationGraphToHtml(
        graph,
        new Map(
          bundle.assetBundle.descriptor.assets.map((asset) => [
            asset.id,
            `assets/${asset.fileName}`,
          ]),
        ),
        'phone-webpub',
      ),
    ).toThrow(/MathML/)
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

  it('normalizes all EPUB heading levels relative to the first authored heading', () => {
    const toc = renderEpubToc([
      { id: 'h2', level: 2, text: 'First' },
      { id: 'h2b', level: 2, text: 'Second' },
      { id: 'h3', level: 3, text: 'Nested' },
    ])
    expect(toc).toBe(
      '<ol><li><a href="content.xhtml#h2">First</a></li><li><a href="content.xhtml#h2b">Second</a><ol><li><a href="content.xhtml#h3">Nested</a></li></ol></li></ol>',
    )
  })

  it('derives safe asset extensions from media types', () => {
    expect(publicationAssetFileExtension('cover.#fragment', 'image/png')).toBe(
      '.png',
    )
    expect(
      publicationAssetFileExtension('diagram.svg+xml', 'image/svg+xml'),
    ).toBe('.svg')
    expect(publicationAssetFileExtension('photo.JPG', 'image/jpeg')).toBe(
      '.jpg',
    )
  })

  it('derives XML-safe, unique EPUB manifest ids from asset ids', () => {
    expect(publicationEpubManifestItemId('cover:hero#1', 0)).toBe(
      'asset-0-cover-hero-1',
    )
    expect(publicationEpubManifestItemId('cover:hero#1', 1)).toBe(
      'asset-1-cover-hero-1',
    )
    expect(publicationEpubManifestItemId('', 2)).toBe('asset-2-item')
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

  it('requires the pinned browser build before rendering', () => {
    expect(
      publicationBrowserVersionMatches(
        'Chromium 149.0.7827.0',
        '149.0.7827.0',
      ),
    ).toBe(true)
    expect(
      publicationBrowserVersionMatches(
        'Chromium 149.0.7827.55',
        '149.0.7827.0',
      ),
    ).toBe(false)
  })

  it('removes stale WebPub and layout assets before a new publication', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-webpub-clean-'))
    const webpub = resolve(root, 'phone-webpub')
    await mkdir(resolve(webpub, 'assets'), { recursive: true })
    const stale = resolve(webpub, 'assets', 'stale.svg')
    await (await import('node:fs/promises')).writeFile(stale, 'stale')
    await prepareWebPubDirectory(webpub)
    await expect(access(stale)).rejects.toMatchObject({ code: 'ENOENT' })

    const layout = resolve(root, 'layout-assets')
    await mkdir(layout, { recursive: true })
    const staleLayout = resolve(layout, 'stale.svg')
    await (await import('node:fs/promises')).writeFile(staleLayout, 'stale')
    await preparePublicationAssetDirectory(layout)
    await expect(access(staleLayout)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

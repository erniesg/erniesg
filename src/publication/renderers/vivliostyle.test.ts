import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, relative, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { adaptAstroBlogEntry } from '../adapters/astro'
import {
  PUBLICATION_BROWSER_SNAPSHOT_ROOT,
  PUBLICATION_BROWSER_CACHE,
  preparePublicationBrowserSnapshot,
  publicationBrowserSnapshotRootPath,
  publicationBrowserBundleForExecutable,
  publicationPuppeteerBrowserBundleForExecutable,
  publicationPlaywrightPackageIdentityPaths,
  snapshotPublicationBrowserBundle,
} from '../browser-runtime'
import {
  PUBLICATION_PROFILES,
  preparePublicationAssetDirectory,
  prepareWebPubDirectory,
  publicationAssetFileExtension,
  publicationEpubAccessibilityMetadata,
  publicationEpubManifestItemId,
  publicationEpubNavigationLabels,
  publicationEpubTocHeadings,
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

  it('renders one anchor per link range without crossing hard breaks', async () => {
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
              text: 'read thisonetwoup\ndown',
              inlineRuns: [
                {
                  start: 0,
                  end: 9,
                  href: 'https://example.com/formatted',
                },
                {
                  start: 5,
                  end: 9,
                  bold: true,
                  underline: true,
                },
                {
                  start: 9,
                  end: 12,
                  href: 'https://example.com/adjacent',
                },
                {
                  start: 12,
                  end: 15,
                  href: 'https://example.com/adjacent',
                },
                {
                  start: 15,
                  end: 22,
                  href: 'https://example.com/break',
                },
                { start: 17, end: 18, hardBreak: true },
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
    expect(
      html.match(/href="https:\/\/example\.com\/formatted"/g),
    ).toHaveLength(1)
    expect(html.match(/href="https:\/\/example\.com\/adjacent"/g)).toHaveLength(
      2,
    )
    expect(html.match(/href="https:\/\/example\.com\/break"/g)).toHaveLength(2)
    expect(html).toContain(
      '<a href="https://example.com/formatted">read <u><strong>this</strong></u></a>',
    )
    expect(html).toContain(
      '<a href="https://example.com/adjacent">one</a><a href="https://example.com/adjacent">two</a>',
    )
    expect(html).toContain(
      '<a href="https://example.com/break">up</a><br><a href="https://example.com/break">down</a>',
    )
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
      { id: 'h1', level: 1, locale: 'en', text: 'One' },
      { id: 'h2', level: 2, locale: 'en', text: 'Two' },
      { id: 'h3', level: 3, locale: 'en', text: 'Three' },
      { id: 'h2b', level: 2, locale: 'en', text: 'Two B' },
    ])
    expect(toc).toContain(
      '<li><a href="content.xhtml#h1" lang="en">One</a><ol><li><a href="content.xhtml#h2" lang="en">Two</a><ol><li><a href="content.xhtml#h3" lang="en">Three</a></li></ol></li><li><a href="content.xhtml#h2b" lang="en">Two B</a></li></ol></li>',
    )
  })

  it('normalizes all EPUB heading levels relative to the first authored heading', () => {
    const toc = renderEpubToc([
      { id: 'h2', level: 2, locale: 'en', text: 'First' },
      { id: 'h2b', level: 2, locale: 'en', text: 'Second' },
      { id: 'h3', level: 3, locale: 'en', text: 'Nested' },
    ])
    expect(toc).toBe(
      '<ol><li><a href="content.xhtml#h2" lang="en">First</a></li><li><a href="content.xhtml#h2b" lang="en">Second</a><ol><li><a href="content.xhtml#h3" lang="en">Nested</a></li></ol></li></ol>',
    )
  })

  it('uses reviewed monochrome heading text in EPUB navigation', () => {
    const headings = publicationEpubTocHeadings([
      {
        id: 'heading',
        type: 'heading',
        level: 1,
        locale: 'en',
        text: 'Canonical heading',
        variants: [
          {
            kind: 'monochrome',
            text: 'E-ink heading',
            reviewed: true,
          },
        ],
      } as PublicationNode,
    ])
    expect(renderEpubToc(headings)).toContain('>E-ink heading</a>')
    expect(renderEpubToc(headings)).not.toContain('Canonical heading')
  })

  it('renders each mixed-locale EPUB navigation anchor in its authored locale', async () => {
    const bundle = await adaptAstroBlogEntry({
      entryId: 'moving-to-cloudflare-with-astro',
    })
    const template = bundle.graph.nodes.find((node) => node.type === 'heading')
    if (!template || template.type !== 'heading')
      throw new Error('missing heading fixture')
    const headings = publicationEpubTocHeadings([
      {
        ...template,
        id: 'heading-en',
        level: 1,
        locale: 'en',
        text: 'English heading',
        variants: [],
      },
      {
        ...template,
        id: 'heading-ja',
        level: 2,
        locale: 'ja',
        text: '日本語の見出し',
        variants: [],
      },
    ])
    expect(renderEpubToc(headings)).toBe(
      '<ol><li><a href="content.xhtml#heading-en" lang="en">English heading</a><ol><li><a href="content.xhtml#heading-ja" lang="ja">日本語の見出し</a></li></ol></li></ol>',
    )
  })

  it('marks generated EPUB navigation labels with their actual language', () => {
    expect(publicationEpubNavigationLabels('zh-Hans-CN')).toEqual({
      title: 'Navigation',
      toc: 'Table of contents',
      contents: 'Contents',
      article: 'Article',
      languageOverride: 'en',
    })
    expect(publicationEpubNavigationLabels('en-GB')).toEqual({
      title: 'Navigation',
      toc: 'Table of contents',
      contents: 'Contents',
      article: 'Article',
    })
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
    expect(publicationAssetFileExtension('cover.html', 'image/png')).toBe(
      '.png',
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
      publicationPlaywrightExecutableCandidates('1228', 'linux', 'arm64'),
    ).toEqual([
      expect.stringContaining('chrome-linux/chrome'),
      expect.stringContaining('chrome-linux/headless_shell'),
    ])
    expect(
      publicationPlaywrightExecutableCandidates('1228', 'darwin', 'arm64'),
    ).toEqual([
      expect.stringContaining('chrome-mac-arm64/Google Chrome for Testing.app'),
      expect.stringContaining('chrome-headless-shell-mac-arm64'),
    ])
    expect(() =>
      publicationPlaywrightExecutableCandidates('1228', 'win32', 'arm64'),
    ).toThrow(/Unsupported publication operating system/i)
  })

  it('requires the pinned browser build before rendering', () => {
    expect(
      publicationBrowserVersionMatches(
        'Chromium 149.0.7827.55',
        '149.0.7827.55',
      ),
    ).toBe(true)
    expect(
      publicationBrowserVersionMatches(
        'Chromium 149.0.7827.0',
        '149.0.7827.55',
      ),
    ).toBe(false)
  })

  it('rejects cache-escaping browser links and snapshots regular bundles', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-browser-bundle-'))
    try {
      const cache = resolve(root, 'cache')
      const bundle = resolve(cache, 'chromium-1228')
      const browser = resolve(bundle, 'chrome-linux/chrome')
      await mkdir(resolve(bundle, 'chrome-linux'), { recursive: true })
      await writeFile(browser, 'reviewed browser bytes')
      await writeFile(resolve(bundle, 'resource'), 'linked resource')
      await symlink('../resource', resolve(bundle, 'chrome-linux/resource'))
      const selected = await publicationBrowserBundleForExecutable(
        browser,
        cache,
      )
      const snapshot = await snapshotPublicationBrowserBundle(
        selected,
        resolve(root, 'snapshots'),
      )
      await writeFile(browser, 'changed source bytes')
      await expect(readFile(snapshot.executablePath, 'utf8')).resolves.toBe(
        'reviewed browser bytes',
      )
      await expect(
        readFile(resolve(dirname(snapshot.executablePath), 'resource'), 'utf8'),
      ).resolves.toBe('linked resource')
      await snapshot.cleanup()

      const defaultSnapshot = await snapshotPublicationBrowserBundle(selected)
      const defaultPrivateRoot = dirname(
        dirname(dirname(defaultSnapshot.executablePath)),
      )
      expect(
        relative(
          PUBLICATION_BROWSER_SNAPSHOT_ROOT,
          defaultSnapshot.executablePath,
        ),
      ).not.toMatch(/^\.\.(?:\/|$)/u)
      expect(publicationBrowserSnapshotRootPath({})).toBe(
        resolve(
          PUBLICATION_BROWSER_CACHE,
          '../../..',
          '.publication-browser-snapshots',
        ),
      )
      expect(
        publicationBrowserSnapshotRootPath({
          PUBLICATION_BROWSER_SNAPSHOT_ROOT: resolve(root, 'operator-root'),
        }),
      ).toBe(resolve(root, 'operator-root'))
      expect(() =>
        publicationBrowserSnapshotRootPath({
          PUBLICATION_BROWSER_SNAPSHOT_ROOT: 'relative/snapshots',
        }),
      ).toThrow(/absolute normalized path/i)
      expect(relative(cache, defaultSnapshot.executablePath)).toMatch(
        /^\.\.(?:\/|$)/u,
      )
      expect((await stat(defaultPrivateRoot)).mode & 0o777).toBe(0o700)
      await defaultSnapshot.cleanup()
      await expect(access(defaultPrivateRoot)).rejects.toMatchObject({
        code: 'ENOENT',
      })

      const outsideResource = resolve(root, 'outside-resource')
      const escapingResource = resolve(bundle, 'chrome-linux/escape')
      await writeFile(outsideResource, 'must not be copied')
      await symlink(
        relative(dirname(escapingResource), outsideResource),
        escapingResource,
      )
      await expect(
        snapshotPublicationBrowserBundle(selected, resolve(root, 'snapshots')),
      ).rejects.toThrow(/escaping symlink/i)
      await rm(escapingResource)

      const cleanupSnapshot = await snapshotPublicationBrowserBundle(
        selected,
        resolve(root, 'snapshots'),
      )
      const cleanupPrivateRoot = dirname(
        dirname(dirname(cleanupSnapshot.executablePath)),
      )
      const movedSnapshots = resolve(root, 'moved-snapshots')
      await rename(resolve(root, 'snapshots'), movedSnapshots)
      await mkdir(resolve(root, 'snapshots'))
      const replacementPrivateRoot = resolve(
        root,
        'snapshots',
        basename(cleanupPrivateRoot),
      )
      await mkdir(replacementPrivateRoot)
      const sentinel = resolve(replacementPrivateRoot, 'do-not-delete')
      await writeFile(sentinel, 'replacement directory')
      await expect(cleanupSnapshot.cleanup()).rejects.toThrow(
        /cleanup refused.*identity changed/i,
      )
      await expect(readFile(sentinel, 'utf8')).resolves.toBe(
        'replacement directory',
      )

      const outsideSnapshots = resolve(root, 'outside-snapshots')
      await mkdir(outsideSnapshots)
      const linkedSnapshots = resolve(root, 'linked-snapshots')
      await symlink(outsideSnapshots, linkedSnapshots)
      await expect(
        snapshotPublicationBrowserBundle(selected, linkedSnapshots),
      ).rejects.toThrow(/snapshot.*symlink/i)
      await expect(
        snapshotPublicationBrowserBundle(
          selected,
          resolve(bundle, 'snapshots'),
        ),
      ).rejects.toThrow(/snapshot.*overlaps/i)

      const outside = resolve(root, 'outside-browser')
      await writeFile(outside, 'outside')
      const linked = resolve(bundle, 'chrome-linux/linked-chrome')
      await symlink(outside, linked)
      await expect(
        publicationBrowserBundleForExecutable(linked, cache),
      ).rejects.toThrow(/regular file|outside.*cache/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when a cache file is replaced between inspection and open', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-browser-race-'))
    const cache = resolve(root, 'cache')
    const bundle = resolve(cache, 'chromium-1228')
    const browser = resolve(bundle, 'chrome-linux/chrome')
    const originalBrowser = `${browser}.original`
    const originalFsPromises = await import('node:fs/promises')
    let replacementInjected = false

    vi.resetModules()
    vi.doMock('node:fs/promises', () => ({
      ...originalFsPromises,
      open: async (path: unknown, ...args: unknown[]) => {
        if (!replacementInjected && resolve(String(path)) === browser) {
          replacementInjected = true
          await originalFsPromises.rename(browser, originalBrowser)
          await originalFsPromises.writeFile(browser, 'replacement bytes')
        }
        return (originalFsPromises.open as (...values: unknown[]) => unknown)(
          path,
          ...args,
        )
      },
    }))

    try {
      await mkdir(dirname(browser), { recursive: true })
      await writeFile(browser, 'reviewed browser bytes')
      const runtime = await import('../browser-runtime')
      const selected = await runtime.publicationBrowserBundleForExecutable(
        browser,
        cache,
      )
      await expect(
        runtime.snapshotPublicationBrowserBundle(
          selected,
          resolve(root, 'snapshots'),
        ),
      ).rejects.toThrow(/cache bundle changed during snapshot creation/i)
      expect(replacementInjected).toBe(true)
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reclaims stale browser snapshots without disturbing active snapshots', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-browser-lease-'))
    try {
      const cache = resolve(root, 'cache')
      const bundle = resolve(cache, 'chromium-1228')
      const browser = resolve(bundle, 'chrome-linux/chrome')
      const snapshotRoot = resolve(root, 'snapshots')
      await mkdir(dirname(browser), { recursive: true })
      await writeFile(browser, 'reviewed browser bytes')
      const selected = await publicationBrowserBundleForExecutable(
        browser,
        cache,
      )
      const active = await snapshotPublicationBrowserBundle(
        selected,
        snapshotRoot,
      )
      const staleRoot = resolve(snapshotRoot, 'browser-stale-fixture')
      const staleLease = resolve(staleRoot, '.lease')
      await mkdir(staleRoot, { mode: 0o700 })
      await writeFile(staleLease, 'publication browser snapshot lease\n', {
        mode: 0o600,
      })
      await writeFile(resolve(staleRoot, 'orphan'), 'stale browser bytes')
      await utimes(staleLease, new Date(0), new Date(0))

      const current = await snapshotPublicationBrowserBundle(
        selected,
        snapshotRoot,
      )
      await expect(access(staleRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(active.executablePath, 'utf8')).resolves.toBe(
        'reviewed browser bytes',
      )
      await current.cleanup()
      await active.cleanup()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prepares an immutable verified Puppeteer browser snapshot', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-puppeteer-'))
    try {
      const cache = resolve(root, 'cache')
      const bundle = resolve(cache, 'chrome/linux-150.0.7871.115')
      const browser = resolve(bundle, 'chrome-linux64/chrome')
      await mkdir(dirname(browser), { recursive: true })
      await writeFile(
        browser,
        '#!/bin/sh\necho "Google Chrome for Testing 150.0.7871.115"\n',
      )
      const selected = await publicationPuppeteerBrowserBundleForExecutable(
        browser,
        {
          cacheRoot: cache,
          platform: 'linux',
          architecture: 'x64',
          buildId: '150.0.7871.115',
        },
      )
      const prepared = await preparePublicationBrowserSnapshot(
        selected,
        '150.0.7871.115',
        resolve(root, 'snapshots'),
      )
      expect(prepared.executablePath).not.toBe(browser)

      await writeFile(browser, '#!/bin/sh\necho "changed source cache"\n')
      await expect(prepared.assertUnchanged()).resolves.toBeUndefined()
      await expect(prepared.verifyUnchanged()).resolves.toBeUndefined()

      await chmod(prepared.executablePath, 0o700)
      await writeFile(
        prepared.executablePath,
        '#!/bin/sh\n# changed bytes\necho "Google Chrome for Testing 150.0.7871.115"\n',
      )
      await expect(prepared.assertUnchanged()).rejects.toThrow(
        /browser.*changed/i,
      )
      await prepared.cleanup()

      await writeFile(
        browser,
        '#!/bin/sh\necho "Google Chrome for Testing 150.0.7871.115"\n',
      )
      const identityPrepared = await preparePublicationBrowserSnapshot(
        selected,
        '150.0.7871.115',
        resolve(root, 'snapshots'),
      )
      const identityPrivateRoot = dirname(
        dirname(dirname(identityPrepared.executablePath)),
      )
      const movedIdentityPrivateRoot = `${identityPrivateRoot}-moved`
      const pinnedBrowserBytes = await readFile(identityPrepared.executablePath)
      await rename(identityPrivateRoot, movedIdentityPrivateRoot)
      await mkdir(dirname(identityPrepared.executablePath), { recursive: true })
      await writeFile(identityPrepared.executablePath, pinnedBrowserBytes)
      await chmod(identityPrepared.executablePath, 0o500)
      await expect(identityPrepared.assertUnchanged()).rejects.toThrow(
        /snapshot directory identity changed/i,
      )
      await expect(identityPrepared.cleanup()).rejects.toThrow(
        /cleanup refused.*identity changed/i,
      )
      await expect(readFile(identityPrepared.executablePath)).resolves.toEqual(
        pinnedBrowserBytes,
      )

      const outside = resolve(root, 'outside-browser')
      await writeFile(outside, '#!/bin/sh\necho outside\n')
      const linked = resolve(bundle, 'chrome-linux64/linked-chrome')
      await symlink(outside, linked)
      await expect(
        publicationPuppeteerBrowserBundleForExecutable(linked, {
          cacheRoot: cache,
          platform: 'linux',
          architecture: 'x64',
          buildId: '150.0.7871.115',
        }),
      ).rejects.toThrow(/symlink|outside.*cache/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves package identity independently of the process working directory', async () => {
    const before = publicationPlaywrightPackageIdentityPaths()
    const original = process.cwd()
    const elsewhere = await mkdtemp(resolve(tmpdir(), 'publication-cwd-'))
    try {
      process.chdir(elsewhere)
      expect(publicationPlaywrightPackageIdentityPaths()).toEqual(before)
      for (const path of Object.values(before))
        await expect(access(path)).resolves.toBeUndefined()
    } finally {
      process.chdir(original)
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('refuses to reuse pre-existing WebPub and layout asset directories', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-webpub-exclusive-'))
    try {
      const webpub = resolve(root, 'phone-webpub')
      await mkdir(resolve(webpub, 'assets'), { recursive: true })
      await expect(prepareWebPubDirectory(webpub)).rejects.toMatchObject({
        code: 'EEXIST',
      })

      const layout = resolve(root, 'layout-assets')
      await mkdir(layout)
      await expect(
        preparePublicationAssetDirectory(layout),
      ).rejects.toMatchObject({ code: 'EEXIST' })

      const fresh = resolve(root, 'fresh-assets')
      await preparePublicationAssetDirectory(fresh)
      await expect(access(fresh)).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a pre-existing render target directory', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-render-target-'))
    try {
      const target = resolve(root, 'render-output')
      await mkdir(target)
      const bundle = await adaptAstroBlogEntry({
        entryId: 'moving-to-cloudflare-with-astro',
      })
      await expect(
        vivliostyleRenderer.render(bundle, {
          outputDirectory: target,
          profiles: [...PUBLICATION_PROFILES],
        }),
      ).rejects.toThrow(/already exists/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

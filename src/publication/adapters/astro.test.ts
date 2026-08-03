import {
  cp,
  mkdir,
  mkdtemp,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adaptAstroBlogEntry, astroPublicationAdapter } from './astro'
import {
  PublicationAdapterRegistry,
  buildRegisteredPublication,
} from '../adapter-registry'
import type { PublicationNode } from '../schema'

async function fixtureCollection(name: string) {
  const root = await mkdtemp(resolve(tmpdir(), 'publication-astro-'))
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

describe('Astro publication adapter', () => {
  it('adapts the published golden entry with authored hero alt and local translations', async () => {
    const result = await adaptAstroBlogEntry({
      entryId: 'moving-to-cloudflare-with-astro',
    })
    expect(result.graph.metadata).toMatchObject({
      title: 'Moving to Cloudflare Pages with Astro',
      abstract:
        'Why I moved my website to Cloudflare Pages using Astro, and the benefits of this modern web stack',
      contributors: ['erniesg'],
      created: '2025-02-10',
      defaultLocale: 'en',
      sourceDocumentVersion: 'moving-to-cloudflare-with-astro',
    })
    expect(result.assetBundle.descriptor.assets).toHaveLength(1)
    expect(result.assetBundle.descriptor.assets[0]).toMatchObject({
      fileName: 'astro.png',
      accessibilityLabel:
        'The Astro logo in white on an orange-to-purple gradient',
    })
    expect(result.diagnostics.map((item) => item.message)).toEqual([
      'Resolved local translation sibling ja.mdx',
      'Resolved local translation sibling ko.mdx',
      'Resolved local translation sibling zh.mdx',
    ])
  })

  it('preserves synthetic code, math, quote, footnote, caption, link, list, and image semantics', async () => {
    const contentRoot = await fixtureCollection('synthetic-publication')
    const result = await adaptAstroBlogEntry({
      entryId: 'synthetic-publication',
      contentRoot,
    })
    const types = result.graph.nodes.map((node) => node.type)
    expect(types).toEqual(
      expect.arrayContaining([
        'heading',
        'paragraph',
        'quote',
        'list',
        'list-item',
        'code',
        'equation',
        'figure',
        'caption',
        'note',
      ]),
    )
    const paragraph = result.graph.nodes.find(
      (node) => node.type === 'paragraph',
    )
    expect(paragraph).toMatchObject({
      type: 'paragraph',
      inlineRuns: expect.arrayContaining([
        expect.objectContaining({ italic: true }),
        expect.objectContaining({ href: 'https://example.com/' }),
        expect.objectContaining({ compactMathAtom: true }),
      ]),
    })
    expect(result.assetBundle.descriptor.assets).toHaveLength(1)
  })

  it('fails unsupported MDX closed with component type and source location without evaluation', async () => {
    const contentRoot = await fixtureCollection('unsupported-component')
    ;(globalThis as Record<string, unknown>).__mustNotRun = false
    await expect(
      adaptAstroBlogEntry({
        entryId: 'unsupported-component',
        contentRoot,
      }),
    ).rejects.toThrow(
      /Unsupported MDX node ClientOnly \(mdxJsxFlowElement\) at blog:unsupported-component:\d+:\d+/,
    )
    expect((globalThis as Record<string, unknown>).__mustNotRun).toBe(false)
  })

  it('rejects traversal, missing authored alt text, and duplicate adapter ids', async () => {
    await expect(
      adaptAstroBlogEntry({ entryId: '../private' }),
    ).rejects.toThrow(/Invalid Astro blog entry id/)
    const root = await mkdtemp(resolve(tmpdir(), 'publication-alt-'))
    const entry = resolve(root, 'missing-alt')
    await mkdir(entry)
    await writeFile(
      resolve(entry, 'index.mdx'),
      `---\ntitle: Missing alt\ndescription: Test\ndate: 2026-07-27\nimage: ./image.svg\n---\n# Heading\n`,
    )
    await writeFile(
      resolve(entry, 'image.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    )
    await expect(
      adaptAstroBlogEntry({ entryId: 'missing-alt', contentRoot: root }),
    ).rejects.toThrow(/requires authored imageAlt/)
    const registry = new PublicationAdapterRegistry().register(
      astroPublicationAdapter,
    )
    expect(() => registry.register(astroPublicationAdapter)).toThrow(
      /already registered/,
    )
  })

  it('rejects entry and source symlinks that escape the configured collection', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-realpath-'))
    const outside = await mkdtemp(resolve(tmpdir(), 'publication-realpath-outside-'))
    await writeFile(
      resolve(outside, 'index.mdx'),
      `---\ntitle: Escaped\ndescription: Escaped entry\ndate: 2026-07-27\n---\n# Escaped\n`,
    )
    await symlink(resolve(outside), resolve(root, 'escaped'))
    await expect(
      adaptAstroBlogEntry({ entryId: 'escaped', contentRoot: root }),
    ).rejects.toThrow(/escapes the blog collection/)

    const safe = resolve(root, 'safe')
    await mkdir(safe)
    await symlink(resolve(outside, 'index.mdx'), resolve(safe, 'index.mdx'))
    await expect(
      adaptAstroBlogEntry({ entryId: 'safe', contentRoot: root }),
    ).rejects.toThrow(/source escapes the blog collection/)
  })

  it('preserves authored heading fragments, inline code, and nested list ownership while rejecting escaping assets', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-contract-'))
    const entry = resolve(root, 'contract')
    const outside = await mkdtemp(resolve(tmpdir(), 'publication-outside-'))
    await mkdir(entry)
    await writeFile(
      resolve(entry, 'index.mdx'),
      `---\ntitle: Contract\ndescription: Contract fixture\ndate: 2026-07-27\n---\n# Why Astro?\n\n[Jump](#why-astro) to \`main\`.\n\n1. Parent\n   - Child\n\n![Card](./asset.svg)\n`,
    )
    await writeFile(resolve(outside, 'asset.svg'), '<svg/>')
    await symlink(resolve(outside, 'asset.svg'), resolve(entry, 'asset.svg'))
    await expect(
      adaptAstroBlogEntry({ entryId: 'contract', contentRoot: root }),
    ).rejects.toThrow(/asset escapes its entry/)

    await unlink(resolve(entry, 'asset.svg'))
    await writeFile(resolve(entry, 'asset.svg'), '<svg/>')
    const result = await adaptAstroBlogEntry({
      entryId: 'contract',
      contentRoot: root,
    })
    expect(
      result.graph.nodes.find(
        (node) => node.type === 'heading' && node.text === 'Why Astro?',
      ),
    ).toMatchObject({ id: 'why-astro' })
    expect(
      result.graph.nodes.find(
        (node) => node.type === 'paragraph' && node.text.includes('main'),
      ),
    ).toMatchObject({
      inlineRuns: expect.arrayContaining([
        expect.objectContaining({ inlineCode: true }),
        expect.objectContaining({ href: '#why-astro' }),
      ]),
    })
    const list = result.graph.nodes.find(
      (node): node is Extract<PublicationNode, { type: 'list' }> =>
        node.type === 'list' && node.ordered,
    )
    expect(list).toBeDefined()
    const item = result.graph.nodes.find(
      (node): node is Extract<PublicationNode, { type: 'list-item' }> =>
        node.type === 'list-item' && node.id === list?.itemIds[0],
    )
    expect(item).toMatchObject({ childListIds: [expect.any(String)] })
    expect(
      result.graph.nodes.find(
        (node) => node.type === 'list' && node.id === item?.childListIds[0],
      ),
    ).toBeDefined()
  })

  it('allocates generated ids around authored slugs without collisions', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-id-collision-'))
    const entry = resolve(root, 'id-collision')
    await mkdir(entry)
    await writeFile(
      resolve(entry, 'index.mdx'),
      `---\ntitle: IDs\ndescription: ID collision fixture\ndate: 2026-07-27\n---\n# Paragraph 2\n\nFirst paragraph.\n\nSecond paragraph.\n`,
    )
    const result = await adaptAstroBlogEntry({
      entryId: 'id-collision',
      contentRoot: root,
    })
    const ids = result.graph.nodes.map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(result.graph.nodes.find((node) => node.type === 'heading')).toMatchObject({
      id: 'paragraph-2',
    })
  })

  it('normalizes non-ASCII heading slugs to schema-safe ids', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-heading-unicode-'))
    const entry = resolve(root, 'heading-unicode')
    await mkdir(entry)
    await writeFile(
      resolve(entry, 'index.mdx'),
      `---\ntitle: Unicode headings\ndescription: Unicode heading fixture\ndate: 2026-07-27\n---\n# Café\n\n# 中文\n\n# Café\n`,
    )
    const result = await adaptAstroBlogEntry({
      entryId: 'heading-unicode',
      contentRoot: root,
    })
    expect(result.graph.nodes.filter((node) => node.type === 'heading').map((node) => node.id)).toEqual([
      'cafe',
      'heading-1',
      'cafe-1',
    ])
    expect(result.graph.nodes.every((node) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(node.id))).toBe(true)
  })

  it('preserves deletion semantics, unique repeated footnote anchors, and all backlinks', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-footnote-'))
    const entry = resolve(root, 'footnote-references')
    await mkdir(entry)
    await writeFile(
      resolve(entry, 'index.mdx'),
      `---\ntitle: Footnotes\ndescription: Footnote fixture\ndate: 2026-07-27\n---\nA ~~removed~~ claim [^proof] and again [^proof].\n\n[^proof]: The note remains linked.\n`,
    )
    const result = await adaptAstroBlogEntry({
      entryId: 'footnote-references',
      contentRoot: root,
    })
    const paragraph = result.graph.nodes.find(
      (node) => node.type === 'paragraph',
    )
    const note = result.graph.nodes.find((node) => node.type === 'note')
    expect(paragraph).toMatchObject({
      inlineRuns: expect.arrayContaining([
        expect.objectContaining({ strikethrough: true }),
        expect.objectContaining({ relationshipId: 'ref-proof' }),
        expect.objectContaining({ relationshipId: 'ref-proof-2' }),
      ]),
    })
    expect(note).toMatchObject({
      backlinkIds: ['ref-proof', 'ref-proof-2'],
    })
  })

  it('reserves footnote anchors in the global node id namespace', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-footnote-collision-'))
    const entry = resolve(root, 'footnote-collision')
    await mkdir(entry)
    await writeFile(
      resolve(entry, 'index.mdx'),
      `---\ntitle: Footnote collision\ndescription: Footnote collision fixture\ndate: 2026-07-27\n---\n# Ref Proof\n\nA claim[^proof].\n\n[^proof]: The note remains linked.\n`,
    )
    const result = await adaptAstroBlogEntry({
      entryId: 'footnote-collision',
      contentRoot: root,
    })
    expect(result.graph.nodes.find((node) => node.type === 'heading')).toMatchObject({
      id: 'ref-proof',
    })
    expect(result.graph.nodes.find((node) => node.type === 'paragraph')).toMatchObject({
      inlineRuns: [expect.objectContaining({ relationshipId: 'ref-proof-2' })],
    })
    expect(result.graph.nodes.find((node) => node.type === 'note')).toMatchObject({
      backlinkIds: ['ref-proof-2'],
    })
  })

  it('rewrites footnote targets when a heading already owns the preferred note id', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-footnote-note-collision-'))
    const entry = resolve(root, 'footnote-note-collision')
    await mkdir(entry)
    await writeFile(
      resolve(entry, 'index.mdx'),
      `---\ntitle: Footnote note collision\ndescription: Footnote note collision fixture\ndate: 2026-07-27\n---\n# Note Proof\n\nA [heading link](#note-proof) and a claim[^proof].\n\n[^proof]: The note remains linked.\n`,
    )
    const result = await adaptAstroBlogEntry({
      entryId: 'footnote-note-collision',
      contentRoot: root,
    })
    expect(result.graph.nodes.find((node) => node.type === 'heading')).toMatchObject({
      id: 'note-proof',
    })
    expect(result.graph.nodes.find((node) => node.type === 'paragraph')).toMatchObject({
      inlineRuns: [
        expect.objectContaining({ href: '#note-proof' }),
        expect.objectContaining({
          href: '#note-proof-1',
          targetIds: ['note-proof-1'],
          semanticRole: 'cross-reference',
        }),
      ],
    })
    expect(result.graph.nodes.find((node) => node.type === 'note')).toMatchObject({
      id: 'note-proof-1',
      backlinkIds: ['ref-proof'],
    })
  })

  it('resolves definitions before references and preserves authored hard breaks', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-footnote-order-'))
    const entry = resolve(root, 'definition-before-reference')
    await mkdir(entry)
    await writeFile(
      resolve(entry, 'index.mdx'),
      `---\ntitle: Ordered footnote\ndescription: Footnote order fixture\ndate: 2026-07-27\n---\n[^proof]: Defined before its reference.\n\nA hard  \nbreak and a reference[^proof].\n`,
    )
    const result = await adaptAstroBlogEntry({
      entryId: 'definition-before-reference',
      contentRoot: root,
    })
    expect(result.graph.nodes.find((node) => node.type === 'note')).toMatchObject({
      text: 'Defined before its reference.',
    })
    expect(result.graph.nodes.find((node) => node.type === 'paragraph')).toMatchObject({
      inlineRuns: expect.arrayContaining([expect.objectContaining({ hardBreak: true })]),
    })
  })

  it('preserves zero ordered-list starts and rejects task-list and thematic-break loss', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-block-contract-'))
    const createEntry = async (name: string, body: string) => {
      const entry = resolve(root, name)
      await mkdir(entry)
      await writeFile(
        resolve(entry, 'index.mdx'),
        `---\ntitle: ${name}\ndescription: Block fixture\ndate: 2026-07-27\n---\n${body}`,
      )
      return entry
    }
    await createEntry('zero-list', '0. First zero-based item\n')
    const zeroList = await adaptAstroBlogEntry({
      entryId: 'zero-list',
      contentRoot: root,
    })
    expect(zeroList.graph.nodes.find((node) => node.type === 'list')).toMatchObject({
      start: 0,
    })

    await createEntry('task-list', '- [x] Shipped\n')
    await expect(
      adaptAstroBlogEntry({ entryId: 'task-list', contentRoot: root }),
    ).rejects.toThrow(/task-list/i)

    await createEntry('thematic-break', 'Before\n\n---\n\nAfter\n')
    await expect(
      adaptAstroBlogEntry({ entryId: 'thematic-break', contentRoot: root }),
    ).rejects.toThrow(/thematicBreak/)
  })

  it('rejects multi-paragraph blockquotes instead of flattening their boundaries', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-quote-'))
    const entry = resolve(root, 'multi-paragraph-quote')
    await mkdir(entry)
    await writeFile(
      resolve(entry, 'index.mdx'),
      `---\ntitle: Quote\ndescription: Quote fixture\ndate: 2026-07-27\n---\n> First paragraph.\n>\n> Second paragraph.\n`,
    )
    await expect(
      adaptAstroBlogEntry({
        entryId: 'multi-paragraph-quote',
        contentRoot: root,
      }),
    ).rejects.toThrow(/Unsupported MDX node blockquote/)
  })

  it('selects the registered source before invoking a source-neutral renderer', async () => {
    const registry = new PublicationAdapterRegistry().register(
      astroPublicationAdapter,
    )
    let receivedTitle = ''
    await buildRegisteredPublication(
      registry,
      {
        id: 'fixture-renderer',
        async render(bundle) {
          receivedTitle = bundle.graph.metadata.title
        },
      },
      {
        adapterId: 'astro',
        locator: { entryId: 'moving-to-cloudflare-with-astro' },
        outputDirectory: 'unused',
        profiles: ['phone-webpub'],
      },
    )
    expect(receivedTitle).toBe('Moving to Cloudflare Pages with Astro')
  })
})

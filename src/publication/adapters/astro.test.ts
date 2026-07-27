import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adaptAstroBlogEntry, astroPublicationAdapter } from './astro'
import {
  PublicationAdapterRegistry,
  buildRegisteredPublication,
} from '../adapter-registry'

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

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
import { beforeAll, describe, expect, it } from 'vitest'
import { adaptAstroBlogEntry, astroPublicationAdapter } from './astro'
import {
  PublicationAdapterRegistry,
  buildRegisteredPublication,
} from '../adapter-registry'
import type { PublicationNode } from '../schema'
import type {
  AdapterDiagnostic,
  PublicationSourceResult,
} from '../source-adapter'
import { adaptStructDocument } from '../struct-adapter'
import { structDocumentSha256 } from '../struct-source-binding'

const STRUCT_BLOCK_ID = /^struct-block-[0-9a-f]{24}$/u
/**
 * The Struct digest of the golden entry covers a 1.5 MB asset, so the
 * adapter call is slower than the default test timeout allows.
 */
const SLOW = { timeout: 120_000 }

let golden: PublicationSourceResult

beforeAll(async () => {
  golden = await adaptAstroBlogEntry({
    entryId: 'moving-to-cloudflare-with-astro',
  })
}, SLOW.timeout)

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

function lossyInlineStyles(result: { diagnostics: AdapterDiagnostic[] }) {
  return result.diagnostics.filter(
    (diagnostic) => diagnostic.code === 'lossy-inline-style',
  )
}

function paragraphNode(result: PublicationSourceResult) {
  return result.graph.nodes.find(
    (node): node is Extract<PublicationNode, { type: 'paragraph' }> =>
      node.type === 'paragraph',
  )
}

describe('Astro publication adapter', () => {
  it('adapts the published golden entry with authored hero alt and local translations', async () => {
    const result = golden
    expect(result.graph.metadata).toMatchObject({
      title: 'Moving to Cloudflare Pages with Astro',
      abstract:
        'Why I moved my website to Cloudflare Pages using Astro, and the benefits of this modern web stack',
      contributors: ['erniesg'],
      created: '2025-02-10',
      defaultLocale: 'en',
      // The graph is a projection of the Struct document, so the source
      // document version is the Struct schema revision the app derived it
      // from.
      sourceDocumentVersion: '0.2.0',
    })
    expect(result.assetBundle.descriptor.assets).toHaveLength(1)
    expect(result.assetBundle.descriptor.assets[0]).toMatchObject({
      fileName: 'astro.png',
      accessibilityLabel:
        'The Astro logo in white on an orange-to-purple gradient',
      width: 2048,
      height: 1024,
    })
    expect(result.diagnostics.map((item) => item.message)).toEqual([
      'Resolved local translation sibling ja.mdx',
      'Resolved local translation sibling ko.mdx',
      'Resolved local translation sibling zh.mdx',
    ])
  })

  it(
    'projects exactly the Struct document the app-owned ingress produced',
    SLOW,
    () => {
      const result = golden
      expect(result.structDocument).toBeDefined()
      const projected = adaptStructDocument(result.structDocument!)
      expect(projected.graph.nodes.map((node) => node.id)).toEqual(
        result.graph.nodes.map((node) => node.id),
      )
      expect(projected.graph.nodes.map((node) => node.type)).toEqual(
        result.graph.nodes.map((node) => node.type),
      )
      expect(result.graph.metadata).toEqual(projected.graph.metadata)
    },
  )

  it(
    'binds the result to the Struct document this invocation produced',
    SLOW,
    () => {
      const result = golden
      expect(result.structDocument).toBeDefined()
      const binding = result.sourceBinding
      if (!binding || binding.kind !== 'struct-cutover')
        throw new Error('the adapter result is not bound to a Struct document')
      expect(binding.documentSha256).toBe(
        structDocumentSha256(result.structDocument!),
      )
      expect(binding.semanticReceiptSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(binding.packageSourceCommit).toBe(
        '3d3a7c95b1c55a9ff4b527eee5acf36c168cd896',
      )
    },
  )

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
    const paragraph = paragraphNode(result)
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

  it('preserves authored heading fragments, keeps the inline-code styling, and keeps nested list ownership while rejecting escaping assets', async () => {
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
    const heading = result.graph.nodes.find(
      (node): node is Extract<PublicationNode, { type: 'heading' }> =>
        node.type === 'heading' && node.text === 'Why Astro?',
    )
    expect(heading).toBeDefined()
    // The authored anchor survives as the Struct block id of the heading.
    expect(heading?.id).toMatch(STRUCT_BLOCK_ID)
    const paragraph = result.graph.nodes.find(
      (node): node is Extract<PublicationNode, { type: 'paragraph' }> =>
        node.type === 'paragraph' && node.text.includes('main'),
    )
    expect(paragraph?.text).toBe('Jump to main.')
    // The inline code span keeps its style: the pinned Struct document
    // carries it and the projection maps it onto the publication inline run.
    expect(
      paragraph?.inlineRuns?.some((run) => run.inlineCode === true),
    ).toBe(true)
    expect(lossyInlineStyles(result)).toHaveLength(0)
    // The authored fragment now resolves to the Struct block it names.
    expect(paragraph?.inlineRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ href: `#${heading?.id}` }),
      ]),
    )
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

  it('mints unique Struct-derived ids for authored slugs without collisions', async () => {
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
      id: expect.stringMatching(STRUCT_BLOCK_ID),
    })
  })

  it('keeps the hero figure distinct from the authored heading anchors', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-hero-collision-'))
    const entry = resolve(root, 'hero-collision')
    await mkdir(entry)
    await writeFile(
      resolve(entry, 'index.mdx'),
      `---\ntitle: Hero collision\ndescription: Hero id fixture\ndate: 2026-07-27\nimage: ./hero.svg\nimageAlt: Hero illustration\n---\n# Hero Figure\n`,
    )
    await writeFile(
      resolve(entry, 'hero.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    )
    const result = await adaptAstroBlogEntry({
      entryId: 'hero-collision',
      contentRoot: root,
    })
    const ids = result.graph.nodes.map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    const figure = result.graph.nodes.find((node) => node.type === 'figure')
    expect(figure?.id).toMatch(STRUCT_BLOCK_ID)
    expect(figure).toMatchObject({
      accessibility: {
        alternativeText: 'Hero illustration',
      },
    })
    const heading = result.graph.nodes.find((node) => node.type === 'heading')
    expect(heading?.id).toMatch(STRUCT_BLOCK_ID)
    expect(heading?.id).not.toBe(figure?.id)
  })

  it('normalizes non-ASCII heading anchors to schema-safe ids', async () => {
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
    const headings = result.graph.nodes.filter((node) => node.type === 'heading')
    expect(headings).toHaveLength(3)
    expect(new Set(headings.map((node) => node.id)).size).toBe(3)
    expect(result.graph.nodes.every((node) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(node.id))).toBe(true)
    // The authored anchor of a non-ASCII heading still resolves to its block.
    const cafe = headings[0]
    expect(cafe?.id).toMatch(STRUCT_BLOCK_ID)
  })

  it('preserves deletion text, unique repeated footnote anchors, and all backlinks', async () => {
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
    const paragraph = paragraphNode(result)
    expect(paragraph?.text).toBe('A removed claim [proof] and again [proof].')
    // The struck-through text is preserved and the dropped style is reported.
    const lossy = lossyInlineStyles(result)
    expect(lossy).toHaveLength(1)
    expect(lossy[0]?.message).toMatch(/strikethrough/u)
    expect(lossy[0]?.nodeId).toBe(paragraph?.id)
    const note = result.graph.nodes.find((node) => node.type === 'note')
    const relationships = paragraph?.inlineRuns
      ?.map((run) => run.relationshipId)
      .filter((id): id is string => Boolean(id))
    expect(new Set(relationships).size).toBe(2)
    expect(note).toMatchObject({
      backlinkIds: expect.arrayContaining([expect.any(String)]),
    })
    expect(note && 'backlinkIds' in note ? note.backlinkIds : []).toHaveLength(2)
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
    const ids = result.graph.nodes.map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    const heading = result.graph.nodes.find((node) => node.type === 'heading')
    expect(heading?.id).toMatch(STRUCT_BLOCK_ID)
    const paragraph = paragraphNode(result)
    const relationshipId = paragraph?.inlineRuns?.find(
      (run) => run.relationshipId,
    )?.relationshipId
    expect(relationshipId).toMatch(/^struct-relationship-[0-9a-f]{24}$/u)
    const note = result.graph.nodes.find((node) => node.type === 'note')
    expect(note).toMatchObject({
      backlinkIds: [relationshipId],
    })
  })

  it('resolves footnote targets and heading links to distinct Struct blocks', async () => {
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
    const heading = result.graph.nodes.find((node) => node.type === 'heading')
    expect(heading?.id).toMatch(STRUCT_BLOCK_ID)
    const note = result.graph.nodes.find((node) => node.type === 'note')
    expect(note?.id).toMatch(STRUCT_BLOCK_ID)
    expect(note?.id).not.toBe(heading?.id)
    const paragraph = paragraphNode(result)
    const linked = paragraph?.inlineRuns?.filter((run) => run.href)
    expect(linked).toEqual([
      expect.objectContaining({ href: `#${heading?.id}` }),
      expect.objectContaining({
        href: `#${note?.id}`,
        targetIds: [note?.id],
        semanticRole: 'cross-reference',
      }),
    ])
  })

  it('resolves definitions before references and records the authored hard break loss', async () => {
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
    const paragraph = paragraphNode(result)
    expect(paragraph?.text).toBe('A hard\nbreak and a reference[proof].')
    const lossy = lossyInlineStyles(result)
    expect(lossy).toHaveLength(1)
    expect(lossy[0]?.message).toMatch(/hard break/u)
    expect(lossy[0]?.nodeId).toBe(paragraph?.id)
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

    await createEntry('one-list', '1. First item\n')
    const oneList = await adaptAstroBlogEntry({
      entryId: 'one-list',
      contentRoot: root,
    })
    expect(oneList.graph.nodes.find((node) => node.type === 'list')).toMatchObject({
      start: 1,
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

  it(
    'selects the registered source before invoking a source-neutral renderer',
    SLOW,
    async () => {
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
    },
  )
})

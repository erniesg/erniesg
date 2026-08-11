import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import equivalentPayload from '../../tests/fixtures/payload/equivalent-publication.json'
import mapping from '../../tests/fixtures/payload/mapping.json'
import {
  createDefaultPublicationAdapterRegistry,
  PublicationAdapterRegistry,
} from './adapter-registry'
import { adaptAstroBlogEntry } from './adapters/astro'
import {
  adaptPayloadLexical,
  payloadLexicalSourceAdapter,
} from './adapters/payload-lexical'
import {
  canonicalPublicationGraph,
  canonicalPublicationSourceResult,
  canonicalPublicationSubset,
  canonicalPublicationSubsetSha256,
  comparePublicationOutputReceipts,
  comparePublicationSemanticSubset,
  sourceReceiptHashes,
} from './adapter-conformance'
import type { AssetDescriptor } from './asset-bundle'
import {
  publicationGraphSchema,
  serializePublicationGraph,
} from './schema'
import {
  PUBLICATION_PROFILES,
  publicationGraphToHtml,
} from './renderers/vivliostyle'
import { createPublicationContractReceipt } from './source-adapter'

describe('publication source adapter conformance', () => {
  it('registers Payload through the same validated bundle boundary', async () => {
    const registry = createDefaultPublicationAdapterRegistry()
    const bundle = await registry.resolve('payload-lexical', {
      id: 'conformance',
      title: 'Conformance',
      content: { root: { children: [{ type: 'paragraph', children: [{ type: 'text', text: 'One' }] }] } },
    })
    expect(bundle.provenance.sourceType).toBe('payload')
    expect(bundle.graph.nodes[0].provenance.adapterId).toBe('payload-lexical')
  })

  it('rejects duplicate registrations and unknown adapters', async () => {
    const registry = new PublicationAdapterRegistry().register(payloadLexicalSourceAdapter)
    expect(() => registry.register(payloadLexicalSourceAdapter)).toThrow(/already registered/)
    await expect(registry.resolve('missing', {})).rejects.toThrow(/Unknown publication source adapter/)
  })

  it('gives equivalent Astro and Payload fixtures the same canonical semantics and contracts', async () => {
    const contentRoot = await mkdtemp(resolve(tmpdir(), 'publication-conformance-'))
    const entryRoot = resolve(contentRoot, 'payload-equivalent')
    try {
      await mkdir(entryRoot)
      await writeFile(
        resolve(entryRoot, 'index.mdx'),
        await readFile(
          resolve('tests/fixtures/publication/astro/payload-equivalent.mdx'),
          'utf8',
        ),
      )
      await copyFile(
        resolve('public/favicon-16x16.png'),
        resolve(entryRoot, 'fixture-image.png'),
      )
      const astro = await adaptAstroBlogEntry({
        entryId: 'payload-equivalent',
        contentRoot,
      })
      const payload = adaptPayloadLexical(equivalentPayload, mapping)
      expect(comparePublicationSemanticSubset(astro, payload)).toBe(true)
      expect(canonicalPublicationSubsetSha256(astro)).toBe(
        canonicalPublicationSubsetSha256(payload),
      )

      const astroHashes = sourceReceiptHashes(astro)
      const payloadHashes = sourceReceiptHashes(payload)
      expect(payloadHashes.canonicalSubsetSha256).toBe(
        astroHashes.canonicalSubsetSha256,
      )
      expect(payloadHashes.sourceRevision).not.toBe(astroHashes.sourceRevision)

      const environment = {
        toolchain: {
          node: 'v22.22.3',
          packageLockSha256: 'a'.repeat(64),
        },
        repository: { commit: 'b'.repeat(40), dirty: false as const },
      }
      const astroReceipt = createPublicationContractReceipt(astro, environment)
      const payloadReceipt = createPublicationContractReceipt(payload, environment)
      expect(payloadReceipt.contracts).toEqual(astroReceipt.contracts)
      expect(payloadReceipt.source).toEqual({
        adapterId: 'payload-lexical',
        sourceType: 'payload',
        mappingVersion: '1.0.0',
      })
    } finally {
      await rm(contentRoot, { recursive: true, force: true })
    }
  })

  it('normalizes internal fragment hrefs with their canonical target ids', () => {
    const left = adaptPayloadLexical(
      {
        id: 'fragment-normalization',
        title: 'Fragment normalization',
        content: {
          root: {
            children: [
              {
                type: 'paragraph',
                children: [
                  {
                    type: 'citation',
                    value: 'left-target',
                    label: 'Inline target',
                  },
                ],
              },
              {
                type: 'relationship',
                value: 'left-target',
                label: 'Block target',
              },
            ],
          },
        },
      },
      { relationships: { citation: { role: 'cross-reference' } } },
    ).graph
    const right = structuredClone(left)
    for (const node of right.nodes) {
      if (node.id === 'left-target') node.id = 'right-target'
      if ('targetIds' in node)
        node.targetIds = node.targetIds.map((id) =>
          id === 'left-target' ? 'right-target' : id,
        )
      if ('href' in node && node.href === '#left-target')
        node.href = '#right-target'
      if ('inlineRuns' in node && node.inlineRuns) {
        node.inlineRuns = node.inlineRuns.map((run) => ({
          ...run,
          ...(run.href === '#left-target' ? { href: '#right-target' } : {}),
          ...(run.targetIds
            ? {
                targetIds: run.targetIds.map((id) =>
                  id === 'left-target' ? 'right-target' : id,
                ),
              }
            : {}),
        }))
      }
    }

    expect(comparePublicationSemanticSubset(left, right)).toBe(true)
    expect(canonicalPublicationSubsetSha256(left)).toBe(
      canonicalPublicationSubsetSha256(right),
    )
  })

  it('canonicalizes adjacent equivalent inline runs across source segmentation', () => {
    const segmented = adaptPayloadLexical({
      id: 'segmented-inline-runs',
      title: 'Segmented inline runs',
      content: {
        root: {
          children: [
            {
              type: 'paragraph',
              children: [
                { type: 'text', text: 'a', format: 'bold' },
                { type: 'text', text: 'b', format: 'bold' },
              ],
            },
          ],
        },
      },
    })
    const combined = adaptPayloadLexical({
      id: 'combined-inline-runs',
      title: 'Segmented inline runs',
      content: {
        root: {
          children: [
            {
              type: 'paragraph',
              children: [{ type: 'text', text: 'ab', format: 'bold' }],
            },
          ],
        },
      },
    })

    expect(comparePublicationSemanticSubset(segmented, combined)).toBe(true)
    expect(canonicalPublicationSubsetSha256(segmented)).toBe(
      canonicalPublicationSubsetSha256(combined),
    )
    const canonical = canonicalPublicationSourceResult(segmented)
    const paragraph = canonical.graph.nodes.find(
      (node) => node.type === 'paragraph',
    )
    expect(paragraph).toMatchObject({
      type: 'paragraph',
      inlineRuns: [{ start: 0, end: 2, bold: true }],
    })
  })

  it('canonicalizes overlapping inline runs independently of array order', () => {
    const base = adaptPayloadLexical({
      id: 'ordered-inline-runs',
      title: 'Ordered inline runs',
      content: {
        root: {
          children: [
            {
              type: 'paragraph',
              children: [{ type: 'text', text: 'abcdef' }],
            },
          ],
        },
      },
    }).graph
    const withRuns = (runs: Array<Record<string, unknown>>) => {
      const clone = structuredClone(base)
      for (const node of clone.nodes)
        if (node.type === 'paragraph')
          node.inlineRuns = runs as typeof node.inlineRuns
      return publicationGraphSchema.parse(clone)
    }
    const bold = { start: 0, end: 4, bold: true }
    const italic = { start: 2, end: 6, italic: true }
    const left = withRuns([bold, italic])
    const right = withRuns([italic, bold])

    expect(comparePublicationSemanticSubset(left, right)).toBe(true)
    expect(canonicalPublicationSubsetSha256(left)).toBe(
      canonicalPublicationSubsetSha256(right),
    )
    const canonicalRuns = (graph: typeof left) => {
      const paragraph = canonicalPublicationSubset(graph).nodes.find(
        (node) => node.type === 'paragraph',
      )
      return paragraph?.inlineRuns
    }
    expect(canonicalRuns(right)).toEqual([bold, italic])
    expect(canonicalRuns(left)).toEqual(canonicalRuns(right))
  })

  it('preserves authored order for overlapping vertical-align runs', () => {
    const base = adaptPayloadLexical({
      id: 'ordered-vertical-align-runs',
      title: 'Ordered vertical align runs',
      content: {
        root: {
          children: [
            {
              type: 'paragraph',
              children: [{ type: 'text', text: 'xy' }],
            },
          ],
        },
      },
    }).graph
    const withRuns = (runs: Array<Record<string, unknown>>) => {
      const clone = structuredClone(base)
      for (const node of clone.nodes)
        if (node.type === 'paragraph')
          node.inlineRuns = runs as typeof node.inlineRuns
      return publicationGraphSchema.parse(clone)
    }
    const superscript = {
      start: 0,
      end: 2,
      verticalAlign: 'superscript',
    }
    const subscript = { start: 0, end: 2, verticalAlign: 'subscript' }
    const superscriptFirst = withRuns([superscript, subscript])
    const subscriptFirst = withRuns([subscript, superscript])

    expect(
      comparePublicationSemanticSubset(superscriptFirst, subscriptFirst),
    ).toBe(false)
    expect(canonicalPublicationSubsetSha256(superscriptFirst)).not.toBe(
      canonicalPublicationSubsetSha256(subscriptFirst),
    )
    const canonicalRuns = (graph: typeof superscriptFirst) => {
      const paragraph = canonicalPublicationSubset(graph).nodes.find(
        (node) => node.type === 'paragraph',
      )
      return paragraph?.inlineRuns
    }
    expect(canonicalRuns(superscriptFirst)).toEqual([superscript, subscript])
    expect(canonicalRuns(subscriptFirst)).toEqual([subscript, superscript])
  })

  it('folds adjacent equivalent runs even when an overlapping style separates them', () => {
    const base = adaptPayloadLexical({
      id: 'interleaved-inline-runs',
      title: 'Interleaved inline runs',
      content: {
        root: {
          children: [
            {
              type: 'paragraph',
              children: [{ type: 'text', text: 'abcd' }],
            },
          ],
        },
      },
    }).graph
    const withRuns = (runs: Array<Record<string, unknown>>) => {
      const clone = structuredClone(base)
      for (const node of clone.nodes)
        if (node.type === 'paragraph')
          node.inlineRuns = runs as typeof node.inlineRuns
      return publicationGraphSchema.parse(clone)
    }
    const combined = withRuns([
      { start: 0, end: 4, bold: true },
      { start: 0, end: 4, italic: true },
    ])
    const segmented = withRuns([
      { start: 0, end: 2, bold: true },
      { start: 0, end: 4, italic: true },
      { start: 2, end: 4, bold: true },
    ])

    expect(comparePublicationSemanticSubset(segmented, combined)).toBe(true)
    expect(canonicalPublicationSubsetSha256(segmented)).toBe(
      canonicalPublicationSubsetSha256(combined),
    )
    const paragraph = canonicalPublicationSubset(segmented).nodes.find(
      (node) => node.type === 'paragraph',
    )
    expect(paragraph?.inlineRuns).toEqual([
      { start: 0, end: 4, bold: true },
      { start: 0, end: 4, italic: true },
    ])
  })

  it('preserves authored link boundaries through canonical serialization in every profile', () => {
    const canonical = canonicalPublicationSourceResult(
      adaptPayloadLexical({
        id: 'canonical-link-boundaries',
        title: 'Canonical link boundaries',
        content: {
          root: {
            type: 'root',
            children: [
              {
                type: 'paragraph',
                children: [
                  {
                    type: 'link',
                    url: 'https://example.com/formatted',
                    children: [
                      { type: 'text', text: 'Read ' },
                      { type: 'text', text: 'more', format: 'bold' },
                    ],
                  },
                  {
                    type: 'link',
                    url: 'https://example.com/adjacent',
                    children: [{ type: 'text', text: 'one' }],
                  },
                  {
                    type: 'link',
                    url: 'https://example.com/adjacent',
                    children: [{ type: 'text', text: 'two' }],
                  },
                  {
                    type: 'link',
                    url: 'https://example.com/break',
                    children: [
                      { type: 'text', text: 'up' },
                      { type: 'linebreak' },
                      { type: 'text', text: 'down' },
                    ],
                  },
                ],
              },
              {
                type: 'paragraph',
                children: [
                  {
                    type: 'link',
                    url: 'https://example.com/adjacent',
                    children: [{ type: 'text', text: 'block' }],
                  },
                ],
              },
            ],
          },
        },
      }),
    )
    const graph = publicationGraphSchema.parse(
      JSON.parse(serializePublicationGraph(canonical.graph)),
    )
    const firstParagraph = graph.nodes.find(
      (node) => node.type === 'paragraph' && node.text === 'Read moreonetwoup\ndown',
    )
    if (!firstParagraph || firstParagraph.type !== 'paragraph')
      throw new Error('canonical link boundary regression setup failed')
    const linkRuns = firstParagraph.inlineRuns?.filter((run) => run.href) ?? []
    expect(linkRuns).toEqual([
      {
        start: 0,
        end: 9,
        href: 'https://example.com/formatted',
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
    ])
    expect(linkRuns[1]).not.toBe(linkRuns[2])
    expect(firstParagraph.inlineRuns).toContainEqual({
      start: 5,
      end: 9,
      bold: true,
    })

    for (const profile of PUBLICATION_PROFILES) {
      const html = publicationGraphToHtml(graph, new Map(), profile)
      expect(
        html.match(/href="https:\/\/example\.com\/formatted"/g),
      ).toHaveLength(1)
      expect(
        html.match(/href="https:\/\/example\.com\/adjacent"/g),
      ).toHaveLength(3)
      expect(
        html.match(/href="https:\/\/example\.com\/break"/g),
      ).toHaveLength(2)
    }
  })

  it('preserves adjacent target-only cross-reference ranges through canonicalization', () => {
    const adapted = adaptPayloadLexical(
      {
        id: 'canonical-target-only-boundaries',
        title: 'Canonical target-only boundaries',
        content: {
          root: {
            children: [
              {
                type: 'paragraph',
                children: [
                  { type: 'citation', value: 'target', label: 'a' },
                  { type: 'citation', value: 'target', label: 'b' },
                ],
              },
            ],
          },
        },
      },
      { relationships: { citation: { role: 'cross-reference' } } },
    )
    const graph = publicationGraphSchema.parse({
      ...adapted.graph,
      nodes: adapted.graph.nodes.map((node) =>
        node.type === 'paragraph'
          ? {
              ...node,
              inlineRuns: node.inlineRuns?.map((run) =>
                run.semanticRole === 'cross-reference'
                  ? {
                      start: run.start,
                      end: run.end,
                      semanticRole: run.semanticRole,
                      targetIds: run.targetIds,
                    }
                  : run,
              ),
            }
          : node,
      ),
    })
    const canonical = canonicalPublicationSourceResult({ ...adapted, graph })
    const paragraph = canonical.graph.nodes.find(
      (node) => node.type === 'paragraph',
    )
    if (!paragraph || paragraph.type !== 'paragraph')
      throw new Error('target-only link boundary regression setup failed')
    const runs =
      paragraph.inlineRuns?.filter(
        (run) => run.semanticRole === 'cross-reference',
      ) ?? []
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ start: 0, end: 1 })
    expect(runs[1]).toMatchObject({ start: 1, end: 2 })
    expect(runs[0]).not.toBe(runs[1])

    const target = `#${runs[0]?.targetIds?.[0]}`
    for (const profile of PUBLICATION_PROFILES) {
      const html = publicationGraphToHtml(canonical.graph, new Map(), profile)
      expect(html.split(`href="${target}"`)).toHaveLength(3)
    }
  })

  it('canonicalizes relationship anchors separately from publication node ids', () => {
    const graphWithFootnote = (documentId: string) => {
      const graph = adaptPayloadLexical(
        {
          id: documentId,
          title: 'Relationship anchor normalization',
          content: {
            root: {
              children: [
                {
                  type: 'paragraph',
                  id: 'paragraph',
                  children: [
                    {
                      type: 'citation',
                      value: 'target-note',
                      label: 'Footnote',
                    },
                  ],
                },
              ],
            },
          },
        },
        { relationships: { citation: { role: 'cross-reference' } } },
      ).graph
      const paragraph = graph.nodes.find((node) => node.type === 'paragraph')
      const relationshipId =
        paragraph?.type === 'paragraph'
          ? paragraph.inlineRuns?.[0]?.relationshipId
          : undefined
      const targetIndex = graph.nodes.findIndex((node) => node.id === 'target-note')
      const target = graph.nodes[targetIndex]
      if (!relationshipId || target?.type !== 'reference')
        throw new Error('relationship anchor regression setup failed')
      const {
        type: _type,
        targetIds: _targetIds,
        href: _href,
        ...targetBase
      } = target
      graph.nodes[targetIndex] = {
        ...targetBase,
        type: 'note',
        noteKind: 'footnote',
        label: '1',
        backlinkIds: [relationshipId],
        text: 'Footnote',
      }
      return publicationGraphSchema.parse(graph)
    }

    const left = graphWithFootnote('anchor-left')
    const right = graphWithFootnote('anchor-right')
    const relationshipId = (graph: typeof left) => {
      const paragraph = graph.nodes.find((node) => node.type === 'paragraph')
      return paragraph?.type === 'paragraph'
        ? paragraph.inlineRuns?.[0]?.relationshipId
        : undefined
    }
    expect(relationshipId(left)).not.toBe(relationshipId(right))
    expect(comparePublicationSemanticSubset(left, right)).toBe(true)
    expect(canonicalPublicationSubsetSha256(left)).toBe(
      canonicalPublicationSubsetSha256(right),
    )
  })

  it('canonicalizes content-addressed asset semantics but excludes source filenames', async () => {
    const payloadWithFileName = (fileName: string) =>
      adaptPayloadLexical({
        id: 'asset-semantics',
        title: 'Asset semantics',
        content: {
          root: {
            children: [{ type: 'upload', value: 'diagram' }],
          },
        },
        uploads: [
          {
            id: 'diagram',
            fileName,
            mediaType: 'image/png',
            width: 16,
            height: 12,
            focalPoint: { x: 0.25, y: 0.75 },
            crop: { x: 1, y: 2, width: 10, height: 8, unit: 'px' },
            alt: 'Semantic diagram',
            data: 'AQIDBA==',
          },
        ],
      })
    const original = payloadWithFileName('diagram-original.png')
    const renamed = payloadWithFileName('diagram-renamed.png')
    const originalDescriptor = original.assetBundle.descriptor.assets[0]!
    const withDescriptor = (
      descriptor: typeof originalDescriptor,
    ): typeof original => ({
      ...original,
      assetBundle: {
        ...original.assetBundle,
        descriptor: {
          ...original.assetBundle.descriptor,
          assets: [descriptor],
        },
      },
    })
    const changedSemantics = [
      { ...originalDescriptor, sha256: 'f'.repeat(64) },
      { ...originalDescriptor, byteLength: originalDescriptor.byteLength + 1 },
      { ...originalDescriptor, mediaType: 'image/webp' },
      { ...originalDescriptor, width: 17 },
      { ...originalDescriptor, height: 13 },
      { ...originalDescriptor, focalPoint: { x: 0.5, y: 0.75 } },
      {
        ...originalDescriptor,
        crop: { ...originalDescriptor.crop!, width: 9 },
      },
    ]

    expect(comparePublicationSemanticSubset(original, renamed)).toBe(true)
    expect(
      comparePublicationSemanticSubset(
        original,
        withDescriptor({
          ...originalDescriptor,
          accessibilityLabel: 'Source-specific asset label',
        }),
      ),
    ).toBe(true)
    expect(canonicalPublicationSubsetSha256(original)).toBe(
      canonicalPublicationSubsetSha256(renamed),
    )
    const canonicalOriginal = canonicalPublicationSourceResult(original)
    expect(canonicalOriginal.assetBundle.descriptor).toEqual(
      canonicalPublicationSourceResult(renamed).assetBundle.descriptor,
    )
    expect(
      canonicalPublicationGraph(original).nodes.find(
        (node) => node.type === 'figure',
      ),
    ).toMatchObject({ assetIds: [originalDescriptor.id] })
    await expect(
      canonicalOriginal.assetBundle.resolveBytes(
        canonicalOriginal.assetBundle.descriptor.assets[0]!,
      ),
    ).resolves.toEqual(new Uint8Array([1, 2, 3, 4]))
    for (const descriptor of changedSemantics)
      expect(
        comparePublicationSemanticSubset(
          original,
          withDescriptor(descriptor),
        ),
      ).toBe(false)
  })

  it('remaps reordered source asset ids and delegates canonical byte resolution', async () => {
    const source = adaptPayloadLexical({
      id: 'asset-order',
      title: 'Asset order',
      content: {
        root: {
          children: [
            { type: 'upload', value: 'first' },
            { type: 'upload', value: 'second' },
          ],
        },
      },
      uploads: [
        {
          id: 'first',
          fileName: 'first.png',
          mediaType: 'image/png',
          alt: 'First',
          data: 'AQ==',
        },
        {
          id: 'second',
          fileName: 'second.png',
          mediaType: 'image/png',
          alt: 'Second',
          data: 'Ag==',
        },
      ],
    })
    const originalAssets = source.assetBundle.descriptor.assets
    const renamedAssets = originalAssets.map((asset, index) => ({
      ...asset,
      id: `source-asset-${index + 1}`,
      fileName: `source-name-${index + 1}.png`,
    }))
    const renamedByOriginalId = new Map(
      originalAssets.map((asset, index) => [asset.id, renamedAssets[index]!.id]),
    )
    const originalBySha = new Map(
      originalAssets.map((asset) => [asset.sha256, asset]),
    )
    const reordered = {
      ...source,
      graph: publicationGraphSchema.parse({
        ...source.graph,
        nodes: source.graph.nodes.map((node) => ({
          ...node,
          ...(node.type === 'figure'
            ? {
                assetIds: node.assetIds.map(
                  (assetId) => renamedByOriginalId.get(assetId) ?? assetId,
                ),
              }
            : {}),
          variants: node.variants.map((variant) => ({
            ...variant,
            ...(variant.assetId
              ? {
                  assetId:
                    renamedByOriginalId.get(variant.assetId) ?? variant.assetId,
                }
              : {}),
          })),
        })),
      }),
      assetBundle: {
        descriptor: {
          ...source.assetBundle.descriptor,
          assets: [...renamedAssets].reverse(),
        },
        resolveBytes: async (descriptor: AssetDescriptor) =>
          source.assetBundle.resolveBytes(originalBySha.get(descriptor.sha256)!),
      },
    }

    expect(comparePublicationSemanticSubset(source, reordered)).toBe(true)
    const canonical = canonicalPublicationSourceResult(reordered)
    const bytes = await Promise.all(
      canonical.assetBundle.descriptor.assets.map((descriptor) =>
        canonical.assetBundle.resolveBytes(descriptor),
      ),
    )
    expect(bytes.map((value) => [...value]).sort()).toEqual([[1], [2]])
  })

  it('walks nested lists and captions by ownership instead of flat storage order', () => {
    const adapted = adaptPayloadLexical({
      id: 'structural-ownership',
      title: 'Structural ownership',
      content: {
        root: {
          children: [
            {
              type: 'list',
              id: 'outer-list',
              children: [
                {
                  type: 'listitem',
                  id: 'outer-item',
                  children: [
                    { type: 'text', text: 'Outer item' },
                    {
                      type: 'list',
                      id: 'inner-list',
                      children: [
                        {
                          type: 'listitem',
                          id: 'inner-item',
                          children: [{ type: 'text', text: 'Inner item' }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            { type: 'upload', id: 'figure', title: 'Missing figure' },
          ],
        },
      },
    }).graph
    const figureIndex = adapted.nodes.findIndex((node) => node.id === 'figure')
    const figure = adapted.nodes[figureIndex]!
    if (figure.type !== 'figure')
      throw new Error('structural ownership regression setup failed')
    const {
      id: _figureId,
      type: _figureType,
      title: _figureTitle,
      assetIds: _figureAssetIds,
      captionId: _figureCaptionId,
      sourceText: _figureSourceText,
      inlineRuns: _figureInlineRuns,
      ...captionBase
    } = figure
    const caption = {
      ...captionBase,
      id: 'figure-caption',
      type: 'caption' as const,
      parentId: figure.id,
      text: 'Owned caption',
      inlineRuns: [],
    }
    const left = publicationGraphSchema.parse({
      ...adapted,
      nodes: [
        ...adapted.nodes.slice(0, figureIndex),
        { ...figure, captionId: caption.id },
        caption,
      ],
    })
    const byId = new Map(left.nodes.map((node) => [node.id, node]))
    const right = publicationGraphSchema.parse({
      ...left,
      nodes: [
        byId.get('outer-list'),
        byId.get('figure'),
        byId.get('figure-caption'),
        byId.get('inner-item'),
        byId.get('inner-list'),
        byId.get('outer-item'),
      ],
    })

    expect(comparePublicationSemanticSubset(left, right)).toBe(true)
    const canonicalLeft = canonicalPublicationGraph(left)
    const canonicalRight = canonicalPublicationGraph(right)
    expect(canonicalRight.nodes.map((node) => node.type)).toEqual(
      canonicalLeft.nodes.map((node) => node.type),
    )
    expect(
      canonicalRight.nodes.map((node) => node.provenance.evidence[0]),
    ).toEqual(
      canonicalLeft.nodes.map((node) => node.provenance.evidence[0]),
    )
  })

  it('normalizes table cell anchors and their header relationships', () => {
    const left = adaptPayloadLexical(
      {
        id: 'table-anchors',
        title: 'Table anchors',
        content: {
          root: {
            children: [
              {
                type: 'paragraph',
                children: [
                  {
                    type: 'link',
                    url: '#left-header',
                    children: [{ type: 'text', text: 'Jump to header' }],
                  },
                ],
              },
              {
                type: 'table',
                rows: [
                  {
                    cells: [
                      {
                        id: 'left-header',
                        text: 'Header',
                        headerScope: 'column',
                      },
                      {
                        id: 'left-cell',
                        text: 'Value',
                        headerIds: ['left-header'],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      { blocks: { table: 'table' } },
    ).graph
    const right = structuredClone(left)
    const table = right.nodes.find((node) => node.type === 'table')
    if (table?.type !== 'table')
      throw new Error('table anchor regression setup failed')
    table.rows[0]!.cells[0]!.id = 'right-header'
    table.rows[0]!.cells[1]!.id = 'right-cell'
    table.rows[0]!.cells[1]!.headerIds = ['right-header']
    const paragraph = right.nodes.find((node) => node.type === 'paragraph')
    if (paragraph?.type !== 'paragraph' || !paragraph.inlineRuns?.[0])
      throw new Error('table anchor link regression setup failed')
    paragraph.inlineRuns[0].href = '#right-header'

    expect(comparePublicationSemanticSubset(left, right)).toBe(true)
    expect(canonicalPublicationSubsetSha256(left)).toBe(
      canonicalPublicationSubsetSha256(right),
    )
  })

  it('allows only source provenance and source hashes to differ in output receipts', () => {
    const shared = {
      version: '1.0.0',
      profiles: { 'phone-webpub': { dimensions: '390px x continuous' } },
      policyVersions: {
        renderer: '1.0.0',
        semanticHtml: '1.0.0',
        accessibility: '1.0.0',
        transformationPolicy: '1.0.0',
        publicationCheck: '1.0.0',
      },
      toolchain: { node: '22.22.3' },
      repository: { commit: 'a'.repeat(40), dirty: false },
      artifacts: [
        {
          profile: 'phone-webpub',
          path: 'phone-webpub',
          sha256: 'b'.repeat(64),
          byteLength: 42,
          renderer: 'semantic-html',
        },
      ],
    }
    const astro = {
      ...shared,
      source: {
        adapterId: 'astro',
        adapterVersion: '1.0.0',
        sourceType: 'astro',
        sourceId: 'blog:equivalent',
        graphSha256: 'c'.repeat(64),
        assetBundleSha256: 'd'.repeat(64),
        canonicalSubsetSha256: 'e'.repeat(64),
        routeParity: 'not-applicable',
      },
    }
    const payload = {
      ...shared,
      source: {
        ...astro.source,
        adapterId: 'payload-lexical',
        sourceType: 'payload',
        sourceId: 'payload:equivalent:en',
        graphSha256: 'f'.repeat(64),
        assetBundleSha256: '0'.repeat(64),
        mappingVersion: '1.0.0',
      },
    }
    expect(comparePublicationOutputReceipts(astro, payload)).toBe(true)
    expect(comparePublicationOutputReceipts(astro, {
      ...payload,
      policyVersions: { ...payload.policyVersions, publicationCheck: '2.0.0' },
    })).toBe(false)
    expect(comparePublicationOutputReceipts(astro, {
      ...payload,
      artifacts: [{ ...payload.artifacts[0], sha256: '1'.repeat(64) }],
    })).toBe(false)
    expect(() =>
      comparePublicationOutputReceipts(astro, {
        ...payload,
        source: { ...payload.source, ignoredPolicyBypass: true },
      }),
    ).toThrow(/unsupported source receipt key.*ignoredPolicyBypass/)
    expect(() =>
      comparePublicationOutputReceipts(astro, {
        ...payload,
        unexpectedOutputPolicy: 'changed',
      }),
    ).toThrow(/unsupported output receipt key.*unexpectedOutputPolicy/)
  })
})

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  canonicalPublicationGraph,
  canonicalPublicationSourceResult,
  canonicalPublicationSubset,
  canonicalPublicationSubsetSha256,
  comparePublicationOutputReceipts,
  comparePublicationSemanticSubset,
} from './adapter-conformance'
import {
  createAssetBundle,
  type AssetBundle,
  type AssetDescriptor,
} from './asset-bundle'
import {
  createDefaultPublicationAdapterRegistry,
  PublicationAdapterRegistry,
} from './adapter-registry'
import { astroPublicationAdapter } from './adapters/astro'
import {
  publicationGraphSchema,
  serializePublicationGraph,
  type PublicationGraph,
} from './schema'
import {
  PUBLICATION_PROFILES,
  publicationGraphToHtml,
} from './renderers/vivliostyle'
import type { PublicationSourceResult } from './source-adapter'

/**
 * The canonicalization under test is adapter-agnostic: it projects a
 * publication graph onto its semantic subset. The retired Payload-Lexical
 * adapter used to be the convenient fixture producer for these cases, so the
 * fixtures are now stated directly as the graphs the canonicalizer sees.
 */
const FIXTURE_ADAPTER_ID = 'conformance-fixture'
const FIXTURE_EDITION_ID = 'edition'
const FIXTURE_SOURCE_ID = 'conformance:fixture'

function fixtureEnvelope(node: Record<string, unknown>) {
  return {
    locale: 'en',
    direction: 'auto',
    requirement: 'required',
    importance: 'essential',
    provenance: {
      adapterId: FIXTURE_ADAPTER_ID,
      sourceId: FIXTURE_SOURCE_ID,
      sourceRevision: '1',
      evidence: [FIXTURE_SOURCE_ID],
      idOrigin: 'source',
    },
    accessibility: { decorative: false },
    variants: [],
    permittedTransformationIds: [],
    edition: { editionId: FIXTURE_EDITION_ID },
    ...node,
  }
}

function fixtureGraph(
  nodes: Array<Record<string, unknown>>,
  options: { id?: string; title?: string } = {},
): PublicationGraph {
  return publicationGraphSchema.parse({
    version: '1.0.0',
    id: options.id ?? 'conformance-fixture',
    metadata: {
      title: options.title ?? 'Conformance fixture',
      contributors: [],
      defaultLocale: 'en',
      defaultDirection: 'auto',
      keywords: [],
    },
    edition: { id: FIXTURE_EDITION_ID, locale: 'en', direction: 'auto' },
    nodes: nodes.map((node) => fixtureEnvelope(node)),
  })
}

function fixtureSourceResult(
  graph: PublicationGraph,
  assets: AssetDescriptor[] = [],
  bytes: (descriptor: AssetDescriptor) => Uint8Array = () => new Uint8Array(),
): PublicationSourceResult {
  const assetBundle: AssetBundle = createAssetBundle(
    { version: '1.0.0', assets },
    async (descriptor) => bytes(descriptor),
  )
  return {
    graph,
    assetBundle,
    diagnostics: [],
    provenance: {
      adapterId: FIXTURE_ADAPTER_ID,
      adapterVersion: '1.0.0',
      sourceType: 'astro',
      sourceId: FIXTURE_SOURCE_ID,
      sourceRevision: '1',
    },
  }
}

describe('publication source adapter conformance', () => {
  it('does not register the retired Payload publication adapter', async () => {
    const registry = createDefaultPublicationAdapterRegistry()
    await expect(registry.resolve('payload-lexical', {})).rejects.toThrow(
      /Unknown publication source adapter: payload-lexical/,
    )
  })

  it('rejects duplicate registrations and unknown adapters', async () => {
    const registry = new PublicationAdapterRegistry().register(
      astroPublicationAdapter,
    )
    expect(() => registry.register(astroPublicationAdapter)).toThrow(
      /already registered/,
    )
    await expect(registry.resolve('missing', {})).rejects.toThrow(
      /Unknown publication source adapter/,
    )
  })

  it('normalizes internal fragment hrefs with their canonical target ids', () => {
    const left = fixtureGraph([
      {
        id: 'inline-target-paragraph',
        type: 'paragraph',
        text: 'Inline target',
        inlineRuns: [
          {
            start: 0,
            end: 13,
            href: '#left-target',
            relationshipId: 'relationship-1',
            semanticRole: 'cross-reference',
            targetIds: ['left-target'],
          },
        ],
      },
      {
        id: 'block-target-reference',
        type: 'reference',
        targetIds: ['left-target'],
        href: '#left-target',
        text: 'Block target',
      },
      {
        id: 'left-target',
        type: 'reference',
        targetIds: [],
        text: 'Block target',
      },
    ])
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
    const segmented = fixtureSourceResult(
      fixtureGraph([
        {
          id: 'paragraph',
          type: 'paragraph',
          text: 'ab',
          inlineRuns: [
            { start: 0, end: 1, bold: true },
            { start: 1, end: 2, bold: true },
          ],
        },
      ]),
    )
    const combined = fixtureSourceResult(
      fixtureGraph([
        {
          id: 'paragraph',
          type: 'paragraph',
          text: 'ab',
          inlineRuns: [{ start: 0, end: 2, bold: true }],
        },
      ]),
    )

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
    const base = fixtureGraph([
      {
        id: 'paragraph',
        type: 'paragraph',
        text: 'abcdef',
        inlineRuns: [],
      },
    ])
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
    const base = fixtureGraph([
      {
        id: 'paragraph',
        type: 'paragraph',
        text: 'xy',
        inlineRuns: [],
      },
    ])
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
    expect(canonicalRuns(superscriptFirst)).toEqual([superscript])
    expect(canonicalRuns(subscriptFirst)).toEqual([subscript])
  })

  it('canonicalizes non-overlapping vertical-align runs independently of array order', () => {
    const base = fixtureGraph([
      {
        id: 'paragraph',
        type: 'paragraph',
        text: 'abcd',
        inlineRuns: [],
      },
    ])
    const withRuns = (runs: Array<Record<string, unknown>>) => {
      const clone = structuredClone(base)
      for (const node of clone.nodes)
        if (node.type === 'paragraph')
          node.inlineRuns = runs as typeof node.inlineRuns
      return publicationGraphSchema.parse(clone)
    }
    const superscript = {
      start: 0,
      end: 1,
      verticalAlign: 'superscript',
    }
    const subscript = { start: 2, end: 3, verticalAlign: 'subscript' }
    const superscriptFirst = withRuns([superscript, subscript])
    const subscriptFirst = withRuns([subscript, superscript])

    expect(
      comparePublicationSemanticSubset(superscriptFirst, subscriptFirst),
    ).toBe(true)
    expect(canonicalPublicationSubsetSha256(superscriptFirst)).toBe(
      canonicalPublicationSubsetSha256(subscriptFirst),
    )
    const canonicalRuns = (graph: typeof superscriptFirst) => {
      const paragraph = canonicalPublicationSubset(graph).nodes.find(
        (node) => node.type === 'paragraph',
      )
      return paragraph?.inlineRuns
    }
    expect(canonicalRuns(subscriptFirst)).toEqual([superscript, subscript])
    expect(canonicalRuns(superscriptFirst)).toEqual(
      canonicalRuns(subscriptFirst),
    )
  })

  it('folds adjacent equivalent vertical-align runs', () => {
    const base = fixtureGraph([
      {
        id: 'paragraph',
        type: 'paragraph',
        text: 'ab',
        inlineRuns: [],
      },
    ])
    const withRuns = (runs: Array<Record<string, unknown>>) => {
      const clone = structuredClone(base)
      for (const node of clone.nodes)
        if (node.type === 'paragraph')
          node.inlineRuns = runs as typeof node.inlineRuns
      return publicationGraphSchema.parse(clone)
    }
    const combined = withRuns([
      { start: 0, end: 2, verticalAlign: 'superscript' },
    ])
    const segmented = withRuns([
      { start: 0, end: 1, verticalAlign: 'superscript' },
      { start: 1, end: 2, verticalAlign: 'superscript' },
    ])

    expect(comparePublicationSemanticSubset(segmented, combined)).toBe(true)
    expect(canonicalPublicationSubsetSha256(segmented)).toBe(
      canonicalPublicationSubsetSha256(combined),
    )
    const paragraph = canonicalPublicationSubset(segmented).nodes.find(
      (node) => node.type === 'paragraph',
    )
    expect(paragraph?.inlineRuns).toEqual([
      { start: 0, end: 2, verticalAlign: 'superscript' },
    ])
  })

  it('folds adjacent equivalent runs even when an overlapping style separates them', () => {
    const base = fixtureGraph([
      {
        id: 'paragraph',
        type: 'paragraph',
        text: 'abcd',
        inlineRuns: [],
      },
    ])
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
      fixtureSourceResult(
        fixtureGraph([
          {
            id: 'paragraph',
            type: 'paragraph',
            text: 'Read moreonetwoup\ndown',
            inlineRuns: [
              { start: 5, end: 9, bold: true },
              { start: 0, end: 9, href: 'https://example.com/formatted' },
              { start: 9, end: 12, href: 'https://example.com/adjacent' },
              { start: 12, end: 15, href: 'https://example.com/adjacent' },
              { start: 17, end: 18, hardBreak: true },
              { start: 15, end: 22, href: 'https://example.com/break' },
            ],
          },
          {
            id: 'block-paragraph',
            type: 'paragraph',
            text: 'block',
            inlineRuns: [
              { start: 0, end: 5, href: 'https://example.com/adjacent' },
            ],
          },
        ]),
      ),
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
    const adapted = fixtureSourceResult(
      fixtureGraph([
        {
          id: 'paragraph',
          type: 'paragraph',
          text: 'ab',
          inlineRuns: [
            {
              start: 0,
              end: 1,
              semanticRole: 'cross-reference',
              targetIds: ['target'],
            },
            {
              start: 1,
              end: 2,
              semanticRole: 'cross-reference',
              targetIds: ['target'],
            },
          ],
        },
        {
          id: 'target',
          type: 'reference',
          targetIds: [],
          text: 'b',
        },
      ]),
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
    const graphWithFootnote = (relationshipId: string) => {
      const graph = fixtureGraph([
        {
          id: 'paragraph',
          type: 'paragraph',
          text: 'Footnote',
          inlineRuns: [
            {
              start: 0,
              end: 8,
              href: '#target-note',
              relationshipId,
              semanticRole: 'cross-reference',
              targetIds: ['target-note'],
            },
          ],
        },
        {
          id: 'target-note',
          type: 'reference',
          targetIds: [],
          text: 'Footnote',
        },
      ])
      const paragraph = graph.nodes.find((node) => node.type === 'paragraph')
      const targetIndex = graph.nodes.findIndex((node) => node.id === 'target-note')
      const target = graph.nodes[targetIndex]
      if (paragraph?.type !== 'paragraph' || target?.type !== 'reference')
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

    const left = graphWithFootnote('relationship-left')
    const right = graphWithFootnote('relationship-right')
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
    const bytes = new Uint8Array([1, 2, 3, 4])
    const sourceWithFileName = (fileName: string) => {
      const descriptor: AssetDescriptor = {
        id: 'asset-diagram',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.byteLength,
        mediaType: 'image/png',
        fileName,
        accessibilityLabel: 'Semantic diagram',
        width: 16,
        height: 12,
        focalPoint: { x: 0.25, y: 0.75 },
        crop: { x: 1, y: 2, width: 10, height: 8, unit: 'px' },
      }
      return fixtureSourceResult(
        fixtureGraph([
          {
            id: 'figure',
            type: 'figure',
            title: 'Semantic diagram',
            assetIds: [descriptor.id],
            accessibility: {
              alternativeText: 'Semantic diagram',
              decorative: false,
            },
          },
        ]),
        [descriptor],
        () => bytes,
      )
    }
    const original = sourceWithFileName('diagram-original.png')
    const renamed = sourceWithFileName('diagram-renamed.png')
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
    const firstBytes = new Uint8Array([1])
    const secondBytes = new Uint8Array([2])
    const firstDescriptor: AssetDescriptor = {
      id: 'asset-first',
      sha256: createHash('sha256').update(firstBytes).digest('hex'),
      byteLength: firstBytes.byteLength,
      mediaType: 'image/png',
      fileName: 'first.png',
      accessibilityLabel: 'First',
    }
    const secondDescriptor: AssetDescriptor = {
      id: 'asset-second',
      sha256: createHash('sha256').update(secondBytes).digest('hex'),
      byteLength: secondBytes.byteLength,
      mediaType: 'image/png',
      fileName: 'second.png',
      accessibilityLabel: 'Second',
    }
    const source = fixtureSourceResult(
      fixtureGraph([
        {
          id: 'figure-first',
          type: 'figure',
          title: 'First',
          assetIds: [firstDescriptor.id],
          accessibility: { alternativeText: 'First', decorative: false },
        },
        {
          id: 'figure-second',
          type: 'figure',
          title: 'Second',
          assetIds: [secondDescriptor.id],
          accessibility: { alternativeText: 'Second', decorative: false },
        },
      ]),
      [firstDescriptor, secondDescriptor],
      (descriptor) =>
        descriptor.sha256 === firstDescriptor.sha256 ? firstBytes : secondBytes,
    )
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
    const adapted = fixtureGraph([
      {
        id: 'outer-list',
        type: 'list',
        ordered: false,
        itemIds: ['outer-item'],
        provenance: {
          adapterId: FIXTURE_ADAPTER_ID,
          sourceId: FIXTURE_SOURCE_ID,
          sourceRevision: '1',
          evidence: ['conformance:fixture:outer-list'],
          idOrigin: 'source',
        },
      },
      {
        id: 'outer-item',
        type: 'list-item',
        parentListId: 'outer-list',
        childListIds: ['inner-list'],
        text: 'Outer item',
        inlineRuns: [],
        provenance: {
          adapterId: FIXTURE_ADAPTER_ID,
          sourceId: FIXTURE_SOURCE_ID,
          sourceRevision: '1',
          evidence: ['conformance:fixture:outer-item'],
          idOrigin: 'source',
        },
      },
      {
        id: 'inner-list',
        type: 'list',
        ordered: false,
        itemIds: ['inner-item'],
        provenance: {
          adapterId: FIXTURE_ADAPTER_ID,
          sourceId: FIXTURE_SOURCE_ID,
          sourceRevision: '1',
          evidence: ['conformance:fixture:inner-list'],
          idOrigin: 'source',
        },
      },
      {
        id: 'inner-item',
        type: 'list-item',
        parentListId: 'inner-list',
        childListIds: [],
        text: 'Inner item',
        inlineRuns: [],
        provenance: {
          adapterId: FIXTURE_ADAPTER_ID,
          sourceId: FIXTURE_SOURCE_ID,
          sourceRevision: '1',
          evidence: ['conformance:fixture:inner-item'],
          idOrigin: 'source',
        },
      },
      {
        id: 'figure',
        type: 'figure',
        title: 'Missing figure',
        assetIds: [],
        sourceText: 'Missing local asset: Missing figure',
        accessibility: {
          alternativeText: 'Missing figure',
          decorative: false,
        },
        provenance: {
          adapterId: FIXTURE_ADAPTER_ID,
          sourceId: FIXTURE_SOURCE_ID,
          sourceRevision: '1',
          evidence: ['conformance:fixture:figure'],
          idOrigin: 'source',
        },
      },
    ])
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
    const left = fixtureGraph([
      {
        id: 'paragraph',
        type: 'paragraph',
        text: 'Jump to header',
        inlineRuns: [{ start: 0, end: 14, href: '#left-header' }],
      },
      {
        id: 'table',
        type: 'table',
        rows: [
          {
            cells: [
              {
                id: 'left-header',
                text: 'Header',
                headerScope: 'column',
                columnSpan: 1,
                rowSpan: 1,
              },
              {
                id: 'left-cell',
                text: 'Value',
                headerScope: null,
                columnSpan: 1,
                rowSpan: 1,
                headerIds: ['left-header'],
              },
            ],
          },
        ],
      },
    ])
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
      sourceBinding: {
        kind: 'struct-cutover',
        documentSha256: '9'.repeat(64),
        packageSourceCommit: 'c'.repeat(40),
        packageArtifact: 'struct-0.0.0.tgz',
        packageArtifactSha256: '8'.repeat(64),
        packageIntegrity: 'sha512-digest',
        packageVersion: '0.0.0',
      },
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
    const struct = {
      ...shared,
      source: {
        ...astro.source,
        adapterId: 'struct-document',
        sourceType: 'research-paper',
        sourceId: 'struct:equivalent',
        graphSha256: 'f'.repeat(64),
        assetBundleSha256: '0'.repeat(64),
      },
    }
    expect(comparePublicationOutputReceipts(astro, struct)).toBe(true)
    expect(comparePublicationOutputReceipts(astro, {
      ...struct,
      policyVersions: { ...struct.policyVersions, publicationCheck: '2.0.0' },
    })).toBe(false)
    expect(comparePublicationOutputReceipts(astro, {
      ...struct,
      artifacts: [{ ...struct.artifacts[0], sha256: '1'.repeat(64) }],
    })).toBe(false)
    expect(() =>
      comparePublicationOutputReceipts(astro, {
        ...struct,
        source: { ...struct.source, ignoredPolicyBypass: true },
      }),
    ).toThrow(/unsupported source receipt key.*ignoredPolicyBypass/)
    expect(() =>
      comparePublicationOutputReceipts(astro, {
        ...struct,
        unexpectedOutputPolicy: 'changed',
      }),
    ).toThrow(/unsupported output receipt key.*unexpectedOutputPolicy/)
  })
})

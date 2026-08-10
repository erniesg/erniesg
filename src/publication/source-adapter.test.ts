import { describe, expect, it } from 'vitest'
import { papers } from '../research/papers'
import {
  createAssetBundle,
  createMemoryAssetResolver,
  describeAsset,
} from './asset-bundle'
import {
  readResearchPaper,
  researchPaperSourceAdapter,
  researchPaperToPublicationGraph,
} from './research-paper-adapter'
import {
  defineSourceAdapter,
  parsePublicationSourceResult,
  publicationSourceResultSchema,
  PUBLICATION_SOURCE_ADAPTER_VERSION,
  runSourceAdapter,
  serializePublicationSourceResult,
  SOURCE_DIAGNOSTIC_CODES,
  sourceProvenanceSchema,
} from './source-adapter'
import { UnsupportedPublicationVersionError } from './schema'

const BYTES = new TextEncoder().encode('pipeline diagram bytes')

function fixtureResult() {
  return readResearchPaper({ paper: papers[1] })
}

describe('publication source adapter', () => {
  it('returns graph, asset bundle, diagnostics, and provenance', () => {
    const result = fixtureResult()

    expect(Object.keys(result).sort()).toEqual([
      'assetBundle',
      'diagnostics',
      'graph',
      'provenance',
      'version',
    ])
    expect(result.version).toBe(PUBLICATION_SOURCE_ADAPTER_VERSION)
    expect(result.graph.metadata.id).toBe(papers[1].id)
    expect(result.assetBundle.assets).toEqual([])
    expect(typeof result.assetBundle.resolver.resolve).toBe('function')
    expect(sourceProvenanceSchema.parse(result.provenance)).toEqual(result.provenance)
    expect(result.provenance).toMatchObject({
      adapterId: 'research-paper',
      sourceKind: 'research-paper',
      sourceId: `${papers[1].id}@${papers[1].version}`,
    })
    expect(result.provenance.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    for (const diagnostic of result.diagnostics) {
      expect(SOURCE_DIAGNOSTIC_CODES).toContain(diagnostic.code)
    }
  })

  it('never lets bytes, local paths, or runtime objects into serialised output', () => {
    const descriptor = describeAsset({
      id: 'asset-pipeline',
      mediaType: 'image/png',
      role: 'image',
      bytes: BYTES,
      provenance: { source: 'PRD §3', method: 'authored' },
    })
    const result = readResearchPaper({
      paper: papers[1],
      assets: [descriptor],
      resolver: createMemoryAssetResolver('memory', { 'asset-pipeline': BYTES }),
    })
    const serialized = serializePublicationSourceResult(result)

    expect(serialized).toContain(descriptor.contentHash)
    expect(serialized).not.toContain('resolver')
    expect(serialized).not.toContain('pipeline diagram bytes')
    expect(JSON.parse(serialized).assetBundle.assets).toHaveLength(1)
    expect(serializePublicationSourceResult(result)).toBe(serialized)
  })

  it('rejects unknown adapter versions', () => {
    expect(() =>
      defineSourceAdapter({
        id: 'legacy',
        version: '0.9.0' as never,
        sourceKind: 'astro',
        read: () => fixtureResult(),
      }),
    ).toThrow(UnsupportedPublicationVersionError)

    expect(() =>
      parsePublicationSourceResult({ ...fixtureResult(), version: '2.0.0' }),
    ).toThrow(UnsupportedPublicationVersionError)
  })

  it('rejects asset references the bundle does not describe', () => {
    const { graph } = researchPaperToPublicationGraph(papers[1])
    const withReference = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.type === 'figure'
          ? { ...node, assetRefs: [{ role: 'primary' as const, assetId: 'ghost' }] }
          : node,
      ),
    }

    expect(() =>
      publicationSourceResultSchema.parse({
        ...fixtureResult(),
        graph: withReference,
      }),
    ).toThrow(/references an asset the bundle does not describe/)

    expect(
      publicationSourceResultSchema.parse({
        ...fixtureResult(),
        graph: withReference,
        assetBundle: createAssetBundle(
          [
            describeAsset({
              id: 'ghost',
              mediaType: 'image/png',
              role: 'image',
              bytes: BYTES,
              provenance: { source: 'PRD §3', method: 'authored' },
            }),
          ],
          createMemoryAssetResolver('memory', { ghost: BYTES }),
        ),
      }).graph.nodes.some((node) => node.assetRefs.length === 1),
    ).toBe(true)
  })

  it('rejects provenance that carries local paths or secret material', () => {
    for (const sourceId of [
      '/Users/ernie/Documents/paper.pdf',
      'token=abcdef0123456789',
    ]) {
      expect(() =>
        publicationSourceResultSchema.parse({
          ...fixtureResult(),
          provenance: { ...fixtureResult().provenance, sourceId },
        }),
      ).toThrow()
    }
    expect(() =>
      publicationSourceResultSchema.parse({
        ...fixtureResult(),
        provenance: {
          ...fixtureResult().provenance,
          sourceDigest: 'md5:deadbeef',
        },
      }),
    ).toThrow()
  })

  it('validates whatever an adapter returns, not merely what it promises', () => {
    const dishonest = defineSourceAdapter<null>({
      id: 'dishonest',
      version: PUBLICATION_SOURCE_ADAPTER_VERSION,
      sourceKind: 'astro',
      read: () =>
        ({
          ...fixtureResult(),
          diagnostics: [{ code: 'invented-code', severity: 'info', message: 'x' }],
        }) as never,
    })

    expect(() => runSourceAdapter(dishonest, null)).toThrow()
    expect(runSourceAdapter(researchPaperSourceAdapter, { paper: papers[1] }).graph).toEqual(
      fixtureResult().graph,
    )
  })
})

import { describe, expect, it } from 'vitest'
import rawPaper from '../research/papers/semantic-responsive-typesetting.json'
import { researchPaperSchema } from '../research/schema'
import { createAssetBundle } from './asset-bundle'
import {
  adaptResearchPaper,
  researchPaperToPublicationGraph,
} from './research-paper-adapter'
import {
  adapterProvenanceSchema,
  createPublicationContractReceipt,
  validatePublicationSourceResult,
} from './source-adapter'

describe('PublicationSourceAdapter', () => {
  it('returns the versioned graph, asset, diagnostics and provenance boundary', () => {
    const result = adaptResearchPaper(researchPaperSchema.parse(rawPaper))
    const validated = validatePublicationSourceResult(result)
    expect({
      ...validated,
      assetBundle: { descriptor: validated.assetBundle.descriptor },
    }).toEqual({
      ...result,
      assetBundle: { descriptor: result.assetBundle.descriptor },
    })
    expect(validated.assetBundle.resolveBytes).toBeTypeOf('function')
    expect(result).toMatchObject({
      graph: { version: '1.0.0' },
      assetBundle: { descriptor: { version: '1.0.0' } },
      diagnostics: [],
      provenance: { adapterVersion: '1.0.0', sourceType: 'research-paper' },
    })
  })

  it.each([
    '/tmp/manuscript.docx',
    'file:///tmp/input.pdf',
    'source?token=abc',
    '%2Ftmp%2Finput.pdf',
    'https://user:password@example.com/source',
  ])('rejects unsafe source id %s', (sourceId) => {
    expect(
      adapterProvenanceSchema.safeParse({
        adapterId: 'docx',
        adapterVersion: '1.0.0',
        sourceType: 'docx',
        sourceId,
      }).success,
    ).toBe(false)
  })

  it('rejects malformed bundles and dangling graph asset references', () => {
    const paper = researchPaperSchema.parse(rawPaper)
    const graph = researchPaperToPublicationGraph(paper)
    graph.nodes[0].variants.push({
      kind: 'compact',
      assetId: 'missing',
      reviewed: true,
    })
    expect(() =>
      validatePublicationSourceResult({
        graph,
        assetBundle: createAssetBundle(
          { version: '1.0.0', assets: [] },
          async () => new Uint8Array(),
        ),
        diagnostics: [],
        provenance: {
          adapterId: 'test',
          adapterVersion: '1.0.0',
          sourceType: 'research-paper',
          sourceId: 'fixture',
        },
      }),
    ).toThrow(/missing asset/)
  })

  it('creates deterministic exact-head contract receipts', () => {
    const result = adaptResearchPaper(researchPaperSchema.parse(rawPaper))
    const environment = {
      toolchain: {
        node: 'v24.0.0',
        packageLockSha256: 'a'.repeat(64),
      },
      repository: { commit: 'b'.repeat(40), dirty: false as const },
    }
    const receipt = createPublicationContractReceipt(result, environment)
    expect(createPublicationContractReceipt(result, environment)).toEqual(
      receipt,
    )
    expect(receipt).toMatchObject({
      contracts: {
        publicationGraph: '1.0.0',
        assetBundle: '1.0.0',
        compositionContext: '1.0.0',
        transformationPolicy: '1.0.0',
        sourceAdapter: '1.0.0',
        targetProfile: '1.1.0',
      },
      repository: environment.repository,
    })
    expect(() =>
      createPublicationContractReceipt(result, {
        ...environment,
        repository: { ...environment.repository, dirty: true },
      } as any),
    ).toThrow()
  })
})

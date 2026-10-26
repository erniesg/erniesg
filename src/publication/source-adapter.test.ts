import { describe, expect, it } from 'vitest'
import { loadAdapterCase } from '../../tests/fixtures/struct-adapter-parity/cases'
import { buildStructDocument } from '../struct-adapters'
import { adaptStructDocument } from './struct-adapter'
import {
  adapterProvenanceSchema,
  createPublicationContractReceipt,
  validatePublicationSourceResult,
  type PublicationSourceResult,
} from './source-adapter'

/**
 * The source-adapter contract is exercised on the one projection that
 * remains.
 *
 * The forward `ResearchPaper` -> `PublicationGraph` producer is retired
 * (EG-15): it had no production caller, and a second producer of the
 * renderer plan would have competed with the Struct projection for the
 * authority of the published text. The contract below is therefore proven on
 * the app-owned Struct projection, driven by the repository's own frozen
 * reconstruction fixture and the app-owned ingress conversion.
 */
async function structResult(): Promise<PublicationSourceResult> {
  const document = buildStructDocument(await loadAdapterCase('ordinary-pdf'))
  return adaptStructDocument(document)
}

describe('PublicationSourceAdapter', () => {
  it('returns the versioned graph, asset, diagnostics and provenance boundary', async () => {
    const result = await structResult()
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
      provenance: {
        adapterId: 'struct-document',
        adapterVersion: '1.0.0',
        sourceType: 'pdf',
        sourceId: 'born-digital.pdf',
      },
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

  it('rejects malformed bundles and dangling graph asset references', async () => {
    const result = await structResult()
    const graph = result.graph
    graph.nodes[0].variants.push({
      kind: 'compact',
      assetId: 'missing',
      reviewed: true,
    })
    expect(() => validatePublicationSourceResult({ ...result, graph })).toThrow(
      /missing asset/,
    )
  })

  it('creates deterministic exact-head contract receipts', async () => {
    const result = await structResult()
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

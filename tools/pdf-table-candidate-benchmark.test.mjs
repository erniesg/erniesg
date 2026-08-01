import { describe, expect, it, vi } from 'vitest'
import {
  parseArguments,
  runTableCandidateBenchmark,
  tableCandidatePathSummary,
} from './pdf-table-candidate-benchmark.mjs'

function reconstruction({ receipts = [] } = {}) {
  return {
    completeness: {
      expectedSemanticTableCount: 2,
      resolvedSemanticTableCount: 1,
    },
    visualRelationships: [
      {
        kind: 'table',
        status: 'matched',
        assetIds: ['table-raster'],
      },
      {
        kind: 'table',
        status: 'matched',
        assetIds: ['table-semantic'],
      },
    ],
    assets: [
      { id: 'table-raster', kind: 'table', mediaType: 'image/png' },
      {
        id: 'table-semantic',
        kind: 'table',
        mediaType: 'application/xhtml+xml',
      },
    ],
    tableCandidateReceipts: receipts,
  }
}

describe('table candidate benchmark runner', () => {
  it('requires a corpus id and keeps provider opt-in explicit', () => {
    expect(parseArguments(['--corpus-id', 'bookworld-v1', 'papers'])).toEqual({
      corpusId: 'bookworld-v1',
      inputs: ['papers'],
      provider: 'none',
      providerConfigPath: null,
      sourceRenderEvidencePath: null,
      outPath: null,
      optIn: false,
    })
    expect(() => parseArguments(['papers'])).toThrow()
  })

  it('separates actual verified counts from candidate-only proposal counts', () => {
    const result = reconstruction({
      receipts: [
        { candidateSha256: 'a'.repeat(64) },
        { candidateSha256: null },
      ],
    })
    expect(tableCandidatePathSummary(result)).toEqual({
      semantic: 1,
      raster: 1,
      unresolved: 0,
    })
    expect(tableCandidatePathSummary(result, { rawProvider: true })).toEqual({
      semantic: 1,
      raster: 0,
      unresolved: 1,
    })
  })

  it('runs one shared corpus denominator through deterministic and verified paths', async () => {
    const module = {
      TABLE_CANDIDATE_RECEIPT_SCHEMA_VERSION: '1.0.0',
      createTableCandidateBenchmarkReport: vi.fn((input) => ({
        ...input,
        paths: {
          deterministic: { ...input.deterministic },
          provider: { ...input.provider },
          verifiedProvider: { ...input.verifiedProvider },
        },
        sha256: 'd'.repeat(64),
      })),
    }
    const close = vi.fn(async () => {})
    const loadTableCandidateProviderModule = vi.fn(async () => module)
    const createPipeline = vi.fn(async () => ({
      loadTableCandidateProviderModule,
      close,
      tableCandidateProvider: null,
    }))
    const auditPath = vi.fn(async (path) => ({
      reconstruction: reconstruction(),
      document: { basename: path, sha256: 's'.repeat(64) },
    }))
    const report = await runTableCandidateBenchmark({
      corpusId: 'bookworld-v1',
      inputs: ['bookworld'],
      collectPaths: async () => ['book-1.pdf'],
      createPipeline,
      auditPath,
    })
    expect(report.paths).toEqual({
      deterministic: { semantic: 1, raster: 1, unresolved: 0 },
      provider: { semantic: 1, raster: 1, unresolved: 0 },
      verifiedProvider: { semantic: 1, raster: 1, unresolved: 0 },
    })
    expect(module.createTableCandidateBenchmarkReport).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })
})

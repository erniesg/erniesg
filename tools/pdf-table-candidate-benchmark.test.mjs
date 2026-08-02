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

  it('runs the provider once and reuses its verified reconstruction', async () => {
    const module = {
      TABLE_CANDIDATE_RECEIPT_SCHEMA_VERSION: '1.0.0',
      createDoclingTableCandidateProvider: ({ infer, adapter, runtime }) => ({
        identity: {
          id: 'docling-tableformer',
          version: '2.48.0',
          modelDigest: 'a'.repeat(64),
          configurationHash: 'b'.repeat(64),
          adapter,
          runtime,
        },
        locality: 'local',
        propose: infer,
      }),
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
    }))
    const auditPath = vi.fn(async (path) => ({
      reconstruction: reconstruction({
        receipts: [{ candidateSha256: 'a'.repeat(64) }],
      }),
      document: { basename: path, sha256: 's'.repeat(64) },
    }))
    const report = await runTableCandidateBenchmark({
      corpusId: 'bookworld-v1',
      inputs: ['bookworld'],
      providerConfig: {
        provider: 'docling-tableformer',
        command: process.execPath,
        args: [],
        version: '2.48.0',
        modelDigest: 'a'.repeat(64),
        adapter: { id: 'adapter', version: '1.0.0', sha256: 'b'.repeat(64) },
        runtime: { id: 'runtime', version: '1.0.0', sha256: 'c'.repeat(64) },
        configuration: {},
      },
      optIn: true,
      collectPaths: async () => ['book-1.pdf'],
      createPipeline,
      auditPath,
    })
    expect(auditPath).toHaveBeenCalledTimes(2)
    expect(createPipeline).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(2)
    expect(report.documents.provider).toEqual([
      {
        basename: 'book-1.pdf',
        sha256: 's'.repeat(64),
        counts: { semantic: 1, raster: 0, unresolved: 1 },
      },
    ])
    expect(report.documents.verifiedProvider).toEqual([
      {
        basename: 'book-1.pdf',
        sha256: 's'.repeat(64),
        counts: { semantic: 1, raster: 1, unresolved: 0 },
      },
    ])
    expect(report.providerReceiptManifestSha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('rejects source-render evidence that is not for the deterministic documents', async () => {
    const close = vi.fn(async () => {})
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
    await expect(
      runTableCandidateBenchmark({
        corpusId: 'bookworld-v1',
        inputs: ['bookworld'],
        collectPaths: async () => ['book-1.pdf'],
        createPipeline: async () => ({
          loadTableCandidateProviderModule: async () => module,
          close,
        }),
        auditPath: async (path) => ({
          reconstruction: reconstruction(),
          document: { basename: path, sha256: 's'.repeat(64) },
        }),
        sourceRenderEvidence: {
          sha256: 'e'.repeat(64),
          documents: [
            {
              sourceSha256: 'f'.repeat(64),
              renderSha256: 'r'.repeat(64),
              pages: [1],
            },
          ],
        },
      }),
    ).rejects.toThrow('TABLE_CANDIDATE_SOURCE_RENDER_EVIDENCE_MISMATCH')
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes the deterministic pipeline when provider startup fails', async () => {
    const close = vi.fn(async () => {})
    const module = {
      TABLE_CANDIDATE_RECEIPT_SCHEMA_VERSION: '1.0.0',
      createDoclingTableCandidateProvider: ({ infer, adapter, runtime }) => ({
        identity: {
          id: 'docling-tableformer',
          version: '2.48.0',
          modelDigest: 'a'.repeat(64),
          configurationHash: 'b'.repeat(64),
          adapter,
          runtime,
        },
        locality: 'local',
        propose: infer,
      }),
      createTableCandidateBenchmarkReport: vi.fn(),
    }
    let pipelines = 0
    await expect(
      runTableCandidateBenchmark({
        corpusId: 'bookworld-v1',
        inputs: ['bookworld'],
        providerConfig: {
          provider: 'docling-tableformer',
          command: process.execPath,
          args: [],
          version: '2.48.0',
          modelDigest: 'a'.repeat(64),
          adapter: { id: 'adapter', version: '1.0.0', sha256: 'b'.repeat(64) },
          runtime: { id: 'runtime', version: '1.0.0', sha256: 'c'.repeat(64) },
          configuration: {},
        },
        optIn: true,
        collectPaths: async () => ['book-1.pdf'],
        createPipeline: async () => {
          pipelines += 1
          if (pipelines === 2) throw new Error('provider startup failed')
          return {
            loadTableCandidateProviderModule: async () => module,
            close,
          }
        },
        auditPath: async (path) => ({
          reconstruction: reconstruction(),
          document: { basename: path, sha256: 'a'.repeat(64) },
        }),
      }),
    ).rejects.toThrow('provider startup failed')
    expect(close).toHaveBeenCalledOnce()
  })

  it('binds the report digest to document and evidence identity', async () => {
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
    const run = (documentSha256, renderSha256) =>
      runTableCandidateBenchmark({
        corpusId: 'bookworld-v1',
        inputs: ['bookworld'],
        collectPaths: async () => ['book-1.pdf'],
        createPipeline: async () => ({
          loadTableCandidateProviderModule: async () => module,
          close: async () => {},
        }),
        auditPath: async (path) => ({
          reconstruction: reconstruction(),
          document: { basename: path, sha256: documentSha256 },
        }),
        sourceRenderEvidence: {
          sha256: 'e'.repeat(64),
          documents: [
            { sourceSha256: documentSha256, renderSha256, pages: [1] },
          ],
        },
      })
    const first = await run('a'.repeat(64), 'b'.repeat(64))
    const second = await run('c'.repeat(64), 'd'.repeat(64))
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.sha256).not.toBe(second.sha256)
    expect(first.sha256).not.toBe('d'.repeat(64))
  })
})

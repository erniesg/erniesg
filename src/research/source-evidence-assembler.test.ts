import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { PdfReconstruction } from './import-types'
import { normalizeMineruRunArtifacts } from './mineru-owner-local-runner'
import {
  MINERU_MAX_OWNER_CACHE_BYTES,
  MINERU_PRODUCTION_MODEL_BYTE_LENGTH,
} from './mineru-source-evidence'
import { sha256HexSync } from './sha256-sync'
import { assembleProductionSourceEvidence } from './source-evidence-assembler'

const roots: string[] = []
const sourcePdfPath = [
  new URL('../../tests/fixtures/pdf/born-digital.pdf', import.meta.url),
  new URL('../../../../tests/fixtures/pdf/born-digital.pdf', import.meta.url),
]
  .map((url) => fileURLToPath(url))
  .find(existsSync)!
const sourceSha256 =
  '50874645b2cec033726018c86974241db2048ac46291e02fcb25d3cb7fbaa907'
const pageRenderBytes = new TextEncoder().encode('source page render')

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

async function mineruRun() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'mineru-assembler-test-')),
  )
  roots.push(root)
  await chmod(root, 0o700)
  const output = join(root, 'raw-output', 'document', 'vlm')
  await mkdir(output, { recursive: true, mode: 0o700 })
  const records = [
    {
      type: 'text',
      page_idx: 0,
      bbox: [50, 50, 950, 120],
      text: 'A Reconstructed Research Paper',
    },
  ]
  await writeFile(join(output, 'document.md'), '# Paper\n')
  await writeFile(
    join(output, 'document_content_list.json'),
    JSON.stringify(records),
  )
  await writeFile(
    join(output, 'document_content_list_v2.json'),
    JSON.stringify(records),
  )
  await writeFile(join(output, 'document_middle.json'), '{}')
  await writeFile(join(output, 'document_model.json'), '{}')
  await writeFile(join(output, 'document_layout.pdf'), '%PDF-1.7\n%%EOF\n')
  const cacheInventorySha256 = hash('cache')
  const rootRef = `cache-${cacheInventorySha256.slice(0, 32)}`
  const manifest = await normalizeMineruRunArtifacts({
    sourcePdfPath,
    runDirectory: root,
    outputRoot: join(root, 'raw-output'),
    maximumCacheBytes: MINERU_MAX_OWNER_CACHE_BYTES,
    identity: {
      rootRef,
      mineruExecutableSha256: hash('mineru'),
      mineruConfigSha256: hash('mineru-config'),
      modelConfigSha256: hash('model-config'),
      runtimeInventorySha256: hash('runtime-inventory'),
      runtimeTreeByteLength: 4096,
      cacheInventorySha256,
      cacheByteLength: MINERU_PRODUCTION_MODEL_BYTE_LENGTH,
      execution: {
        hostClass: 'owner-laptop',
        operatingSystem: 'macOS-15.6',
        architecture: 'arm64',
        runtime: 'python-3.12',
        backend: 'mlx-vlm',
        backendVersion: 'mlx-vlm-0.3.12+mlx-0.31.1',
        runtimeSha256: hash('runtime'),
        backendSha256: hash('backend'),
        packageSetSha256: hash('packages'),
        cacheNamespaceSha256: hash(
          `{"namespace":"mineru-production","rootRef":"${rootRef}"}`,
        ),
        networkIsolation: 'macos-sandbox-exec-deny-network-v1',
        networkIsolationSha256: hash('sandbox-exec-deny-network-policy'),
      },
    },
  })
  return {
    schemaVersion: '1.0.0' as const,
    runDirectory: root,
    manifestPath: join(root, 'manifest.json'),
    manifest,
  }
}

function reconstruction(
  byteLength: number,
  kind: PdfReconstruction['pages'][number]['kind'] = 'born-digital',
): PdfReconstruction {
  return {
    source: {
      fileName: 'private-input.pdf',
      byteLength,
      sha256: sourceSha256,
      pageCount: 1,
      localOnly: true,
    },
    paper: { id: 'source-bound-document' },
    pages: [
      {
        page: 1,
        kind,
        width: 612,
        height: 792,
        rotation: 0,
        textCharacters: 30,
        imageCount: 0,
        runs: [
          {
            page: 1,
            text: 'A Reconstructed Research Paper',
            x: 0.05,
            y: 0.05,
            width: 0.9,
            height: 0.07,
            rotation: 0,
            method: 'pdf-text',
            fontName: 'Fixture Serif',
            fontSize: 18,
            confidence: 1,
          },
        ],
      },
    ],
    regions: [],
    readingOrder: { edges: [] },
    noteRelationships: [],
    citationRelationships: [],
    crossReferenceRelationships: [],
    visualRelationships: [],
    assets: [],
  } as unknown as PdfReconstruction
}

function addLocalOcr(input: PdfReconstruction) {
  input.pages[0]!.ocr = {
    engine: 'owner-local-ocr',
    engineVersion: '1.0.0',
    model: 'fixture-ocr-model',
    modelVersion: '1',
    languages: ['eng'],
    languageMode: 'explicit',
    sourceSha256,
    rasterSha256: sha256HexSync(pageRenderBytes),
    confidence: 0.95,
    words: [
      {
        text: 'A Reconstructed Research Paper',
        confidence: 0.95,
        lineId: 'local-line-1',
        box: {
          page: 1,
          x: 0.05,
          y: 0.05,
          width: 0.9,
          height: 0.07,
          rotation: 0,
          method: 'ocr',
        },
        mergeStatus: 'accepted',
      },
    ],
    lines: [
      {
        id: 'local-line-1',
        text: 'A Reconstructed Research Paper',
        confidence: 0.95,
        box: {
          page: 1,
          x: 0.05,
          y: 0.05,
          width: 0.9,
          height: 0.07,
          rotation: 0,
          method: 'ocr',
        },
      },
    ],
  }
}

function expectExactEvidenceOwnership(
  graph: Awaited<ReturnType<typeof assembleProductionSourceEvidence>>['graph'],
) {
  for (const field of ['sourceIds', 'artifactIds', 'candidateIds'] as const) {
    const owned = graph.obligations.flatMap((obligation) => obligation[field])
    const expected = graph.bundles.flatMap((bundle) => {
      if (field === 'sourceIds') return bundle.sources.map(({ id }) => id)
      if (field === 'artifactIds') return bundle.artifacts.map(({ id }) => id)
      return bundle.candidates.map(({ id }) => id)
    })
    expect(owned).toHaveLength(expected.length)
    expect(new Set(owned)).toEqual(new Set(expected))
  }
}

describe('production source-evidence assembler', () => {
  it('requires and authenticates both deterministic and MinerU arms', async () => {
    const run = await mineruRun()
    const result = await assembleProductionSourceEvidence(
      {
        reconstruction: reconstruction(run.manifest.document.byteLength),
        deterministic: {
          pageRenders: [
            {
              page: 1,
              mediaType: 'image/png',
              sha256: sha256HexSync(pageRenderBytes),
              byteLength: pageRenderBytes.byteLength,
              width: 1224,
              height: 1584,
              bytes: pageRenderBytes,
            },
          ],
        },
        mineru: {
          pdfPath: sourcePdfPath,
          runRoot: run.runDirectory,
          mineruExecutable: '/private/pinned/mineru',
          pythonExecutable: '/private/pinned/python3.12',
          configPath: '/private/pinned/mineru.json',
          modelRoot: '/private/pinned/model',
        },
      },
      { runMineru: async () => run },
    )

    expect(result.graph.arms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'deterministic',
          requirement: 'required',
        }),
        expect.objectContaining({ id: 'mineru', requirement: 'required' }),
      ]),
    )
    expect(
      result.graph.obligations.find(({ kind }) => kind === 'source-text')
        ?.candidateIds.length,
    ).toBeGreaterThan(1)
    expectExactEvidenceOwnership(result.graph)
  })

  it('rejects a MinerU receipt bound to different source bytes', async () => {
    const run = await mineruRun()
    await expect(
      assembleProductionSourceEvidence(
        {
          reconstruction: reconstruction(run.manifest.document.byteLength + 1),
          deterministic: {
            pageRenders: [
              {
                page: 1,
                mediaType: 'image/png',
                sha256: sha256HexSync(pageRenderBytes),
                byteLength: pageRenderBytes.byteLength,
                width: 1224,
                height: 1584,
                bytes: pageRenderBytes,
              },
            ],
          },
          mineru: {
            pdfPath: sourcePdfPath,
            runRoot: run.runDirectory,
            mineruExecutable: '/private/pinned/mineru',
            pythonExecutable: '/private/pinned/python3.12',
            configPath: '/private/pinned/mineru.json',
            modelRoot: '/private/pinned/model',
          },
        },
        { runMineru: async () => run },
      ),
    ).rejects.toThrow(/SOURCE_IDENTITY_MISMATCH/u)
  })

  it('requires configured local OCR even when MinerU evidence exists', async () => {
    const run = await mineruRun()
    const input = reconstruction(run.manifest.document.byteLength, 'ocr-required')
    input.pages[0]!.runs = []
    await expect(
      assembleProductionSourceEvidence(
        {
          reconstruction: input,
          deterministic: {
            pageRenders: [
              {
                page: 1,
                mediaType: 'image/png',
                sha256: sha256HexSync(pageRenderBytes),
                byteLength: pageRenderBytes.byteLength,
                width: 1224,
                height: 1584,
                bytes: pageRenderBytes,
              },
            ],
          },
          mineru: {
            pdfPath: sourcePdfPath,
            runRoot: run.runDirectory,
            mineruExecutable: '/private/pinned/mineru',
            pythonExecutable: '/private/pinned/python3.12',
            configPath: '/private/pinned/mineru.json',
            modelRoot: '/private/pinned/model',
          },
        },
        { runMineru: async () => run },
      ),
    ).rejects.toThrow('PDF_LOCAL_OCR_EVIDENCE_REQUIRED')
  })

  it('requires a source-preserved page candidate plus local OCR and grounded MinerU alternatives for a scan', async () => {
    const run = await mineruRun()
    const input = reconstruction(run.manifest.document.byteLength, 'ocr-required')
    input.pages[0]!.runs = []
    addLocalOcr(input)

    const result = await assembleProductionSourceEvidence(
      {
        reconstruction: input,
        deterministic: {
          pageRenders: [
            {
              page: 1,
              mediaType: 'image/png',
              sha256: sha256HexSync(pageRenderBytes),
              byteLength: pageRenderBytes.byteLength,
              width: 1224,
              height: 1584,
              bytes: pageRenderBytes,
            },
          ],
        },
        mineru: {
          pdfPath: sourcePdfPath,
          runRoot: run.runDirectory,
          mineruExecutable: '/private/pinned/mineru',
          pythonExecutable: '/private/pinned/python3.12',
          configPath: '/private/pinned/mineru.json',
          modelRoot: '/private/pinned/model',
        },
      },
      { runMineru: async () => run },
    )

    const fallback = result.graph.obligations.find(
      ({ kind }) => kind === 'source-preserved-page',
    )
    expect(fallback).toMatchObject({ page: 1, required: true, semantic: true })
    expect(
      fallback?.candidateIds.some((id) =>
        id.startsWith('pdfjs-candidate-page-render-'),
      ),
    ).toBe(true)
    expect(result.graph.bundles.some(({ armId }) => armId === 'mineru')).toBe(
      true,
    )
    expect(
      result.graph.obligations.some(
        ({ candidateIds }) =>
          candidateIds.some((id) => id.startsWith('mineru:')),
      ),
    ).toBe(true)
    expectExactEvidenceOwnership(result.graph)
  })
})

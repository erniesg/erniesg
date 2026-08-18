import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validatePdfEvidenceBundle } from './source-evidence-graph'
import {
  createMineruOfflineRunReceipt,
  inspectMineruSourceEvidence,
  MINERU_ARTIFACT_KINDS,
  MINERU_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  MINERU_MAX_OWNER_CACHE_BYTES,
  MINERU_MAX_RETAINED_ARTIFACT_BYTES,
  MINERU_MAX_TEXTUAL_ARTIFACT_BYTES,
  MINERU_PRODUCTION_BACKEND,
  MINERU_PRODUCTION_BINDING,
  MINERU_PRODUCTION_CONFIGURATION,
  MINERU_PRODUCTION_MODEL_ARCHITECTURE,
  MINERU_PRODUCTION_MODEL_BYTE_LENGTH,
  MINERU_PRODUCTION_MODEL_FILE,
  MINERU_PRODUCTION_MODEL_ID,
  MINERU_PRODUCTION_MODEL_LICENSE,
  MINERU_PRODUCTION_MODEL_REVISION,
  MINERU_PRODUCTION_MODEL_SHA256,
  MINERU_PRODUCTION_MODEL_TYPE,
  MINERU_PRODUCTION_VERSION,
  MINERU_PRODUCTION_WHEEL_SHA256,
  type MineruArtifactKind,
  type MineruArtifactManifest,
} from './mineru-source-evidence'

const roots: string[] = []
const encoder = new TextEncoder()

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function jsonBytes(value: unknown) {
  return encoder.encode(JSON.stringify(value))
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function canonicalHash(value: unknown) {
  return sha256(encoder.encode(canonicalJson(value)))
}

function refreshProducerReceipt(manifest: MineruArtifactManifest) {
  const pages = [
    { page: 1, width: 612, height: 792, rotation: 0 },
    { page: 2, width: 792, height: 612, rotation: 90 },
  ]
  const projection = {
    schemaVersion: '1.0.0' as const,
    sourcePdfSha256: manifest.document.sha256,
    sourceByteLength: manifest.document.byteLength,
    sourcePageCount: manifest.document.pageCount,
    sourcePageGeometrySha256: canonicalHash(pages),
    mineruExecutableSha256: '5'.repeat(64),
    mineruConfigSha256: '8'.repeat(64),
    runtimeSha256: manifest.execution.runtimeSha256,
    runtimeInventorySha256: '9'.repeat(64),
    runtimeTreeByteLength: 4096,
    packageSetSha256: manifest.execution.packageSetSha256,
    backendSha256: manifest.execution.backendSha256,
    modelSha256: MINERU_PRODUCTION_MODEL_SHA256,
    modelConfigSha256: '6'.repeat(64),
    cacheInventorySha256: '7'.repeat(64),
    cacheByteLength: MINERU_PRODUCTION_MODEL_BYTE_LENGTH,
    privateSnapshotAllocatedByteLength: 0,
    rawOutputInventorySha256: canonicalHash(
      manifest.artifacts
        .filter(({ kind }) => kind === 'raw-output')
        .map(({ relativePath, byteLength, sha256: digest }) => ({
          relativePath,
          byteLength,
          sha256: digest,
        })),
    ),
    rawOutputByteLength: manifest.artifacts
      .filter(({ kind }) => kind === 'raw-output')
      .reduce((total, { byteLength }) => total + byteLength, 0),
    networkIsolation: manifest.execution.networkIsolation,
    networkIsolationSha256: manifest.execution.networkIsolationSha256,
    artifactSetSha256: canonicalHash(manifest.artifacts),
    offline: true as const,
    runDirectoryMode: '0700' as const,
  }
  manifest.producerReceipt = {
    ...projection,
    receiptSha256: canonicalHash(projection),
  }
}

function payload(value: unknown) {
  return value as Record<string, unknown>
}

function artifact(manifest: MineruArtifactManifest, kind: MineruArtifactKind) {
  const found = manifest.artifacts.find((item) => item.kind === kind)
  if (!found) throw new Error(`fixture is missing ${kind}`)
  return found
}

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'mineru-owner-cache-')),
  )
  roots.push(root)
  await chmod(root, 0o700)
  const relativeDirectory = 'opaque-run-7/files-with-arbitrary-names'
  await mkdir(join(root, relativeDirectory), { recursive: true, mode: 0o700 })

  const contents: Record<
    MineruArtifactKind,
    { bytes: Uint8Array; mediaType: string; pageScope: 'document' | number[] }
  > = {
    markdown: {
      bytes: encoder.encode(
        '# Inspectable candidate\n\nComplete MinerU Markdown is not canonical.\n',
      ),
      mediaType: 'text/markdown',
      pageScope: 'document',
    },
    'content-list-v1': {
      bytes: jsonBytes([
        {
          type: 'text',
          page_idx: 0,
          bbox: [100, 100, 900, 210],
          text: 'Version one reading.',
        },
        {
          type: 'table',
          page_idx: 1,
          bbox: [90, 250, 910, 620],
          table_body: '<table><tr><td>A</td></tr></table>',
        },
      ]),
      mediaType: 'application/json',
      pageScope: 'document',
    },
    'content-list-v2': {
      bytes: jsonBytes([
        {
          type: 'text',
          page_idx: 0,
          bbox: [100, 100, 900, 210],
          text: 'Version two disagrees.',
        },
        {
          type: 'equation',
          page_idx: 1,
          bbox: [90, 250, 910, 620],
          latex: 'E=mc^2',
        },
      ]),
      mediaType: 'application/json',
      pageScope: 'document',
    },
    'middle-json': {
      bytes: jsonBytes({ schemaVersion: '1.0.0', blocks: [{ id: 'b1' }] }),
      mediaType: 'application/json',
      pageScope: 'document',
    },
    'layout-json': {
      bytes: jsonBytes({ schemaVersion: '1.0.0', layouts: [{ page: 1 }] }),
      mediaType: 'application/json',
      pageScope: 'document',
    },
    'model-json': {
      bytes: jsonBytes({ schemaVersion: '1.0.0', predictions: [{ page: 1 }] }),
      mediaType: 'application/json',
      pageScope: 'document',
    },
    ocr: {
      bytes: jsonBytes({ schemaVersion: '1.0.0', spans: [{ page: 2 }] }),
      mediaType: 'application/json',
      pageScope: [2],
    },
    table: {
      bytes: jsonBytes({ tables: [{ page: 2, rows: 1, columns: 1 }] }),
      mediaType: 'application/json',
      pageScope: [2],
    },
    formula: {
      bytes: jsonBytes({ formulas: [{ page: 2, latex: 'E=mc^2' }] }),
      mediaType: 'application/json',
      pageScope: [2],
    },
    figure: {
      bytes: jsonBytes({ figures: [{ page: 1, caption: 'Figure 1' }] }),
      mediaType: 'application/json',
      pageScope: [1],
    },
    image: {
      bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mediaType: 'image/png',
      pageScope: [1],
    },
    'reading-order': {
      bytes: jsonBytes({
        schemaVersion: '1.0.0',
        pages: [
          { page: 1, order: ['b1'] },
          { page: 2, order: ['b2'] },
        ],
      }),
      mediaType: 'application/json',
      pageScope: 'document',
    },
    'page-geometry': {
      bytes: jsonBytes({
        schemaVersion: '1.0.0',
        pages: [
          { page: 1, width: 612, height: 792, rotation: 0 },
          { page: 2, width: 792, height: 612, rotation: 90 },
        ],
      }),
      mediaType: 'application/json',
      pageScope: 'document',
    },
    'layout-pdf': {
      bytes: encoder.encode('%PDF-1.7\n% owner-local derived layout\n'),
      mediaType: 'application/pdf',
      pageScope: 'document',
    },
    'raw-output': {
      bytes: encoder.encode('owner-local raw output'),
      mediaType: 'application/octet-stream',
      pageScope: 'document',
    },
  }

  const artifacts = [] as MineruArtifactManifest['artifacts']
  for (const [index, kind] of MINERU_ARTIFACT_KINDS.entries()) {
    const item = contents[kind]
    const relativePath = `${relativeDirectory}/${index + 17}.opaque-payload`
    await writeFile(join(root, relativePath), item.bytes, { mode: 0o600 })
    artifacts.push({
      id: `retained:${index + 1}`,
      kind,
      relativePath,
      mediaType: item.mediaType,
      byteLength: item.bytes.byteLength,
      sha256: sha256(item.bytes),
      pageScope: item.pageScope,
    })
  }
  const retainedBytes = artifacts.reduce(
    (total, item) => total + item.byteLength,
    0,
  )
  const manifest: MineruArtifactManifest = {
    schemaVersion: MINERU_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    document: {
      id: 'incoming-document-47',
      sha256: 'd'.repeat(64),
      byteLength: 45_127,
      pageCount: 2,
    },
    binding: structuredClone(MINERU_PRODUCTION_BINDING),
    execution: {
      hostClass: 'owner-laptop',
      operatingSystem: 'macOS-15.6',
      architecture: 'arm64',
      runtime: 'python-3.12',
      backend: 'mlx-vlm',
      backendVersion: 'mlx-vlm-0.3.12+mlx-0.31.1',
      runtimeSha256: '1'.repeat(64),
      backendSha256: '2'.repeat(64),
      packageSetSha256: '3'.repeat(64),
      cacheNamespaceSha256: sha256(
        encoder.encode(
          '{"namespace":"mineru-production","rootRef":"owner-cache-47"}',
        ),
      ),
      networkIsolation: 'macos-sandbox-exec-deny-network-v1' as const,
      networkIsolationSha256: '8'.repeat(64),
    },
    cache: {
      scope: 'owner-local',
      rootRef: 'owner-cache-47',
      namespace: 'mineru-production',
      maximumBytes: MINERU_MAX_OWNER_CACHE_BYTES,
      retainedBytes,
      artifactCount: artifacts.length,
    },
    artifacts,
    producerReceipt: null as never,
  }
  refreshProducerReceipt(manifest)
  return { root, manifest }
}

async function replaceJsonArtifact(
  value: Awaited<ReturnType<typeof fixture>>,
  kind: MineruArtifactKind,
  content: unknown,
) {
  const descriptor = artifact(value.manifest, kind)
  const bytes = jsonBytes(content)
  await writeFile(join(value.root, descriptor.relativePath), bytes)
  descriptor.byteLength = bytes.byteLength
  descriptor.sha256 = sha256(bytes)
  value.manifest.cache.retainedBytes = value.manifest.artifacts.reduce(
    (total, item) => total + item.byteLength,
    0,
  )
  refreshProducerReceipt(value.manifest)
}

describe('MinerU source-evidence normalization', () => {
  it('binds the two real offline MLX smokes and keeps VM CPU identity distinct', () => {
    const execution = {
      hostClass: 'owner-laptop' as const,
      operatingSystem: 'macOS-15.6',
      architecture: 'arm64' as const,
      runtime: 'python-3.12' as const,
      backend: 'mlx-vlm' as const,
      backendVersion: 'mlx-vlm-0.3.12+mlx-0.31.1',
      runtimeSha256: '1'.repeat(64),
      backendSha256: '2'.repeat(64),
      packageSetSha256: '3'.repeat(64),
      cacheNamespaceSha256: '4'.repeat(64),
      networkIsolation: 'macos-sandbox-exec-deny-network-v1' as const,
      networkIsolationSha256: '5'.repeat(64),
    }
    const bornDigital = createMineruOfflineRunReceipt({
      schemaVersion: '1.0.0',
      sourceSha256:
        '50874645b2cec033726018c86974241db2048ac46291e02fcb25d3cb7fbaa907',
      execution,
      artifacts: [
        {
          kind: 'markdown',
          sha256:
            'c07cd881ed06981303d35a7a039c04670f2eb397976b1061ccb56bf45747409a',
        },
        {
          kind: 'content-list-v1',
          sha256:
            '1f3ad4482ae1a1485175c32530092a102c4a018520fca8e42141da1bcb2ddc88',
        },
        {
          kind: 'content-list-v2',
          sha256:
            '0a24ef9cece4ed7acc715c90fe4710ffbf1094cadb2253b5fb824b5bbcb89566',
        },
        {
          kind: 'middle-json',
          sha256:
            'f57e7e7bdcd6d3c4fe21385496dd2e3a033a89b46df91a7dc0cfda20ed1ff31f',
        },
        {
          kind: 'model-json',
          sha256:
            '7383748a5fb49422e703cb4cff05f8857c01c6c6c32d9202abf30ed68b4b82bd',
        },
        {
          kind: 'layout-pdf',
          sha256:
            'd1fa744a8beb2e6ddaad50d93378ff45a0a59dd68ff13e6868fe446f505fa1b4',
        },
      ],
    })
    const scan = createMineruOfflineRunReceipt({
      schemaVersion: '1.0.0',
      sourceSha256:
        '2bb7049bf4c854d31a95eadc0d8462306708b36bc8a11eb7c885549e0c241c01',
      execution,
      artifacts: [
        {
          kind: 'markdown',
          sha256:
            '99c6f4a2d300db88d56a4ce0975428371abc7fb610bb477cab341c0dd23535eb',
        },
        {
          kind: 'content-list-v1',
          sha256:
            '2a769007c5e921f0f1443b24bd1514762a13c94fa21ce64a276804ce9d899bba',
        },
        {
          kind: 'content-list-v2',
          sha256:
            '9282e7d829dc9e3eb600aef13f73056ffcfc9d25e3b1f4a528d530e23be0e6ae',
        },
        {
          kind: 'middle-json',
          sha256:
            '8d3edf6356859d4c047f2d751a3157cbf2ade768e285c9bcee85ca70a83ec06e',
        },
        {
          kind: 'model-json',
          sha256:
            '4e23ef9bb58f7b2a5ba21e8dcdcbebe4cd0230e02569202a4a15a308bf72a71f',
        },
        {
          kind: 'layout-pdf',
          sha256:
            '4db642914ce20cfab8225e4a8e4f491174fd8fd158a7284079e1d45374f94806',
        },
      ],
    })
    const vmCpu = createMineruOfflineRunReceipt({
      ...bornDigital,
      execution: {
        ...execution,
        hostClass: 'trusted-vm',
        operatingSystem: 'Ubuntu-24.04',
        backend: 'torch-cpu',
        backendVersion: 'torch-2.13.0+cpu',
        backendSha256:
          '6f307c2c32d764ffc6ff6893b801fad6d4752f3e67966cb8abf1843427c02604',
      },
      artifacts: bornDigital.artifacts,
    })

    expect(bornDigital.receiptSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(scan.receiptSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(bornDigital.bindingSha256).toBe(scan.bindingSha256)
    expect(vmCpu.bindingSha256).not.toBe(bornDigital.bindingSha256)
    expect(Object.keys(vmCpu.execution)).toEqual(Object.keys(execution))
    expect(() =>
      createMineruOfflineRunReceipt({
        ...bornDigital,
        execution: {
          ...execution,
          hostClass: 'trusted-vm',
          operatingSystem: 'Ubuntu-24.04',
        },
        artifacts: bornDigital.artifacts,
      }),
    ).toThrow(/INVALID_MINERU_OFFLINE_RUN_RECEIPT/u)
  })

  it('pins the exact approved production runtime, model file, architecture, and bounded caches', () => {
    expect(MINERU_PRODUCTION_VERSION).toBe('3.4.4')
    expect(MINERU_PRODUCTION_WHEEL_SHA256).toBe(
      'd4d678539782a7683d998e2914a52d96b5720676ce65658b29666b1f4d9dfd13',
    )
    expect(MINERU_PRODUCTION_MODEL_ID).toBe(
      'opendatalab/MinerU2.5-Pro-2605-1.2B',
    )
    expect(MINERU_PRODUCTION_MODEL_REVISION).toBe(
      'bff20d4ae2bf202df9f45284b4d43681555a97ed',
    )
    expect(MINERU_PRODUCTION_MODEL_LICENSE).toBe('Apache-2.0')
    expect(MINERU_PRODUCTION_MODEL_ARCHITECTURE).toBe(
      'Qwen2VLForConditionalGeneration',
    )
    expect(MINERU_PRODUCTION_MODEL_TYPE).toBe('qwen2_vl')
    expect(MINERU_PRODUCTION_MODEL_FILE).toBe('model.safetensors')
    expect(MINERU_PRODUCTION_MODEL_BYTE_LENGTH).toBe(2_312_126_640)
    expect(MINERU_PRODUCTION_MODEL_SHA256).toBe(
      'abf8681ca63b8dec7b67de257af47b821f179442f72998d0696ae2ed9232a5f0',
    )
    expect(MINERU_PRODUCTION_BACKEND).toBe('vlm-engine')
    expect(MINERU_PRODUCTION_CONFIGURATION).toEqual({
      formula: true,
      table: true,
      imageAnalysis: true,
    })
    expect(MINERU_MAX_RETAINED_ARTIFACT_BYTES).toBe(1024 * 1024 * 1024)
    expect(MINERU_MAX_OWNER_CACHE_BYTES).toBe(8 * 1024 * 1024 * 1024)
  })

  it('retains every class separately, preserves v1/v2 disagreements, and keeps Markdown noncanonical', async () => {
    const value = await fixture()
    const bundle = await inspectMineruSourceEvidence({
      artifactRoot: value.root,
      manifest: value.manifest,
    })

    expect(() => validatePdfEvidenceBundle(bundle)).not.toThrow()
    expect(bundle.provider).toMatchObject({
      kind: 'mineru',
      version: '3.4.4',
      implementationSha256: MINERU_PRODUCTION_WHEEL_SHA256,
      model: {
        id: MINERU_PRODUCTION_MODEL_ID,
        revision: MINERU_PRODUCTION_MODEL_REVISION,
        digestSha256: MINERU_PRODUCTION_MODEL_SHA256,
        license: 'Apache-2.0',
        architecture: 'Qwen2VLForConditionalGeneration',
      },
    })
    expect(bundle.pages).toEqual([
      { page: 1, width: 612, height: 792, rotation: 0 },
      { page: 2, width: 792, height: 612, rotation: 90 },
    ])
    expect(new Set(bundle.artifacts.map(({ kind }) => kind))).toEqual(
      new Set(MINERU_ARTIFACT_KINDS),
    )
    const artifactCandidates = bundle.candidates.filter((candidate) =>
      candidate.id.includes(':candidate:artifact:'),
    )
    expect(new Set(artifactCandidates.map(({ kind }) => kind))).toEqual(
      new Set(MINERU_ARTIFACT_KINDS),
    )
    expect(
      artifactCandidates.every(
        (candidate) => payload(candidate.payload).grounded === false,
      ),
    ).toBe(true)

    const markdownSource = bundle.sources.find(
      (source) => source.kind === 'markdown',
    )
    expect(markdownSource?.payload).toMatchObject({
      representation: 'complete-inspectable-markdown',
      complete: true,
      inspectable: true,
      canonical: false,
      markdown: expect.stringContaining('Complete MinerU Markdown'),
    })
    const competingText = bundle.candidates.filter(
      (candidate) =>
        candidate.kind === 'text' &&
        !candidate.id.includes(':candidate:artifact:'),
    )
    expect(competingText).toHaveLength(2)
    expect(competingText[0]!.boxes).toEqual(competingText[1]!.boxes)
    expect(
      new Set(
        competingText.map(
          (candidate) => payload(candidate.payload).representation,
        ),
      ),
    ).toEqual(new Set(['content-list-v1', 'content-list-v2']))
    expect(
      new Set(
        competingText.map(
          (candidate) => payload(candidate.payload).recordSha256,
        ),
      ).size,
    ).toBe(2)
    expect(
      competingText.every(
        (candidate) =>
          candidate.providerId === bundle.provider.id &&
          candidate.sourceIds.length === 1 &&
          candidate.artifactIds?.length === 1,
      ),
    ).toBe(true)

    const serialized = JSON.stringify(bundle)
    expect(serialized).not.toContain(value.root)
    expect(serialized).not.toContain('files-with-arbitrary-names')
    expect(serialized).not.toContain('.opaque-payload')
  })

  it('fails closed on changed bindings, incomplete classes, cache inflation, and oversized textual artifacts', async () => {
    const bindingMismatch = await fixture()
    const wrongBinding = structuredClone(
      bindingMismatch.manifest,
    ) as unknown as {
      binding: { backend: string }
    }
    wrongBinding.binding.backend = 'pipeline'
    await expect(
      inspectMineruSourceEvidence({
        artifactRoot: bindingMismatch.root,
        manifest: wrongBinding,
      }),
    ).rejects.toThrow('MINERU_PRODUCTION_BINDING_MISMATCH')

    const missingClass = await fixture()
    missingClass.manifest.artifacts = missingClass.manifest.artifacts.filter(
      ({ kind }) => kind !== 'formula',
    )
    missingClass.manifest.cache.artifactCount =
      missingClass.manifest.artifacts.length
    missingClass.manifest.cache.retainedBytes =
      missingClass.manifest.artifacts.reduce(
        (total, item) => total + item.byteLength,
        0,
      )
    await expect(
      inspectMineruSourceEvidence({
        artifactRoot: missingClass.root,
        manifest: missingClass.manifest,
      }),
    ).rejects.toThrow('MISSING_MINERU_ARTIFACT_CLASS')

    const cacheInflation = await fixture()
    cacheInflation.manifest.cache.retainedBytes += 1
    await expect(
      inspectMineruSourceEvidence({
        artifactRoot: cacheInflation.root,
        manifest: cacheInflation.manifest,
      }),
    ).rejects.toThrow('MINERU_CACHE_METADATA_MISMATCH')

    const oversized = await fixture()
    const layout = artifact(oversized.manifest, 'layout-json')
    oversized.manifest.cache.retainedBytes +=
      MINERU_MAX_TEXTUAL_ARTIFACT_BYTES + 1 - layout.byteLength
    oversized.manifest.cache.maximumBytes =
      MINERU_MAX_TEXTUAL_ARTIFACT_BYTES + 1024 * 1024
    layout.byteLength = MINERU_MAX_TEXTUAL_ARTIFACT_BYTES + 1
    await expect(
      inspectMineruSourceEvidence({
        artifactRoot: oversized.root,
        manifest: oversized.manifest,
      }),
    ).rejects.toThrow('MINERU_TEXTUAL_ARTIFACT_TOO_LARGE')
  })

  it('rejects tampered bytes and paths instead of trusting filenames or stale hashes', async () => {
    const tampered = await fixture()
    const image = artifact(tampered.manifest, 'image')
    await writeFile(
      join(tampered.root, image.relativePath),
      new Uint8Array(image.byteLength).fill(120),
    )
    await expect(
      inspectMineruSourceEvidence({
        artifactRoot: tampered.root,
        manifest: tampered.manifest,
      }),
    ).rejects.toThrow('MINERU_ARTIFACT_IDENTITY_MISMATCH')

    const escaped = await fixture()
    artifact(escaped.manifest, 'image').relativePath = '../outside.png'
    await expect(
      inspectMineruSourceEvidence({
        artifactRoot: escaped.root,
        manifest: escaped.manifest,
      }),
    ).rejects.toThrow('INVALID_MINERU_ARTIFACT_DESCRIPTOR')
  })

  it('rejects malformed or incomplete page geometry, reading order, and candidate boxes', async () => {
    const badGeometry = await fixture()
    await replaceJsonArtifact(badGeometry, 'page-geometry', {
      schemaVersion: '1.0.0',
      pages: [{ page: 1, width: 612, height: 792, rotation: 0 }],
    })
    await expect(
      inspectMineruSourceEvidence({
        artifactRoot: badGeometry.root,
        manifest: badGeometry.manifest,
      }),
    ).rejects.toThrow('INVALID_MINERU_PAGE_GEOMETRY')

    const badOrder = await fixture()
    await replaceJsonArtifact(badOrder, 'reading-order', {
      schemaVersion: '1.0.0',
      pages: [
        { page: 1, order: ['b1'] },
        { page: 1, order: ['b2'] },
      ],
    })
    await expect(
      inspectMineruSourceEvidence({
        artifactRoot: badOrder.root,
        manifest: badOrder.manifest,
      }),
    ).rejects.toThrow('INVALID_MINERU_READING_ORDER')

    const badBox = await fixture()
    await replaceJsonArtifact(badBox, 'content-list-v2', [
      { type: 'text', page_idx: 0, bbox: [100, 100, 1001, 200] },
    ])
    await expect(
      inspectMineruSourceEvidence({
        artifactRoot: badBox.root,
        manifest: badBox.manifest,
      }),
    ).rejects.toThrow('INVALID_MINERU_CONTENT_LIST_GEOMETRY')
  })
})

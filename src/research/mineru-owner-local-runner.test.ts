import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectMineruSourceEvidence } from './mineru-source-evidence'
import {
  MINERU_PRODUCTION_MODEL_SHA256,
  MINERU_PRODUCTION_MODEL_BYTE_LENGTH,
  MINERU_MAX_OWNER_CACHE_BYTES,
  MINERU_PRODUCTION_VERSION,
} from './mineru-source-evidence'
import {
  OWNER_LOCAL_MINERU_HELP,
  assertOwnerLocalSealedPreflightIdentity,
  assertOwnerLocalMineruResourceUsage,
  buildOwnerLocalMineruIsolationCommand,
  measureOwnerLocalExecutionTree,
  normalizeMineruRunArtifacts,
  ownerLocalPrivateSnapshotAllocatedBytes,
  parseOwnerLocalMineruArguments,
  remainingOwnerLocalSealedModelAllocatedBytes,
  sealOwnerLocalExecutionTree,
} from './mineru-owner-local-runner'

const roots: string[] = []
function fixturePath(name: string) {
  return [
    new URL(`../../tests/fixtures/pdf/${name}`, import.meta.url),
    new URL(`../../../../tests/fixtures/pdf/${name}`, import.meta.url),
  ]
    .map((url) => fileURLToPath(url))
    .find(existsSync)!
}

const fixturePdf = fixturePath('born-digital.pdf')
const scanFixturePdf = fixturePath('scanned-page.pdf')

const realMlxSmokeReceipts = [
  {
    fixture: fixturePdf,
    sourcePdfSha256:
      '50874645b2cec033726018c86974241db2048ac46291e02fcb25d3cb7fbaa907',
    producerReceiptSha256:
      'b4a77ad340d34fbd6683ca099b66011d256808d560df68bf34f16ecfa0bd3d24',
    artifacts: {
      markdown:
        'c07cd881ed06981303d35a7a039c04670f2eb397976b1061ccb56bf45747409a',
      'content-list-v1':
        '1f3ad4482ae1a1485175c32530092a102c4a018520fca8e42141da1bcb2ddc88',
      'content-list-v2':
        '0a24ef9cece4ed7acc715c90fe4710ffbf1094cadb2253b5fb824b5bbcb89566',
      'middle-json':
        'f57e7e7bdcd6d3c4fe21385496dd2e3a033a89b46df91a7dc0cfda20ed1ff31f',
      'model-json':
        '7383748a5fb49422e703cb4cff05f8857c01c6c6c32d9202abf30ed68b4b82bd',
      'layout-pdf':
        'd1fa744a8beb2e6ddaad50d93378ff45a0a59dd68ff13e6868fe446f505fa1b4',
    },
  },
  {
    fixture: scanFixturePdf,
    sourcePdfSha256:
      '2bb7049bf4c854d31a95eadc0d8462306708b36bc8a11eb7c885549e0c241c01',
    producerReceiptSha256:
      '62895b2a12ae418d18c80c2daa24745a1e17fce731e77a4c7d71ebed4e24c609',
    artifacts: {
      markdown:
        '99c6f4a2d300db88d56a4ce0975428371abc7fb610bb477cab341c0dd23535eb',
      'content-list-v1':
        '2a769007c5e921f0f1443b24bd1514762a13c94fa21ce64a276804ce9d899bba',
      'content-list-v2':
        '9282e7d829dc9e3eb600aef13f73056ffcfc9d25e3b1f4a528d530e23be0e6ae',
      'middle-json':
        '8d3edf6356859d4c047f2d751a3157cbf2ade768e285c9bcee85ca70a83ec06e',
      'model-json':
        '4e23ef9bb58f7b2a5ba21e8dcdcbebe4cd0230e02569202a4a15a308bf72a71f',
      'layout-pdf':
        '4db642914ce20cfab8225e4a8e4f491174fd8fd158a7284079e1d45374f94806',
    },
  },
] as const

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

async function fakeMineruOutput(options: { omitReferencedImage?: boolean } = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'mineru-runner-test-')),
  )
  roots.push(root)
  await chmod(root, 0o700)
  const output = join(root, 'raw-output', 'opaque-document', 'vlm')
  await mkdir(output, { recursive: true, mode: 0o700 })
  const records = [
    {
      type: 'text',
      page_idx: 0,
      bbox: [50, 50, 950, 100],
      text: 'A Reconstructed Research Paper',
    },
    {
      type: 'image',
      page_idx: 0,
      bbox: [50, 150, 450, 550],
      img_path: 'images/figure.png',
    },
  ]
  await writeFile(
    join(output, 'opaque.md'),
    '# A Reconstructed Research Paper\n',
  )
  await writeFile(
    join(output, 'opaque_content_list.json'),
    JSON.stringify(records),
  )
  await writeFile(
    join(output, 'opaque_content_list_v2.json'),
    JSON.stringify(records),
  )
  await writeFile(
    join(output, 'opaque_middle.json'),
    JSON.stringify({ pages: [] }),
  )
  await writeFile(
    join(output, 'opaque_model.json'),
    JSON.stringify({ pages: [] }),
  )
  await writeFile(join(output, 'opaque_layout.pdf'), '%PDF-1.7\n%%EOF\n')
  if (!options.omitReferencedImage) {
    await mkdir(join(output, 'images'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(output, 'images', 'figure.png'),
      Buffer.from('89504e470d0a1a0a', 'hex'),
      { mode: 0o600 },
    )
  }
  return { root, outputRoot: join(root, 'raw-output') }
}

describe('owner-local MinerU runner', () => {
  it('normalizes a real PDF fixture into a private authenticated manifest', async () => {
    const { root, outputRoot } = await fakeMineruOutput()
    const cacheInventorySha256 = sha256('owner-local-cache-inventory')
    const rootRef = `cache-${cacheInventorySha256.slice(0, 32)}`
    const manifest = await normalizeMineruRunArtifacts({
      sourcePdfPath: fixturePdf,
      runDirectory: root,
      outputRoot,
      maximumCacheBytes: MINERU_MAX_OWNER_CACHE_BYTES,
      identity: {
        rootRef,
        mineruExecutableSha256: sha256('mineru-executable'),
        mineruConfigSha256: sha256('mineru-config'),
        modelConfigSha256: sha256('model-config'),
        runtimeInventorySha256: sha256('runtime-inventory'),
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
          runtimeSha256: sha256('python-runtime'),
          backendSha256: sha256('mlx-backend'),
          packageSetSha256: sha256('installed-package-records'),
          cacheNamespaceSha256: sha256(
            `{"namespace":"mineru-production","rootRef":"${rootRef}"}`,
          ),
          networkIsolation: 'macos-sandbox-exec-deny-network-v1',
          networkIsolationSha256: sha256('sandbox-exec-deny-network'),
        },
      },
    })

    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect(manifest.document.sha256).toBe(
      '50874645b2cec033726018c86974241db2048ac46291e02fcb25d3cb7fbaa907',
    )
    expect(manifest.artifacts.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        'markdown',
        'content-list-v1',
        'content-list-v2',
        'middle-json',
        'layout-json',
        'model-json',
        'reading-order',
        'page-geometry',
        'layout-pdf',
        'raw-output',
      ]),
    )
    const bundle = await inspectMineruSourceEvidence({
      artifactRoot: root,
      manifest,
    })
    expect(bundle.source).toMatchObject({
      sha256: manifest.document.sha256,
      pageCount: 1,
    })
    expect(bundle.candidates.some(({ kind }) => kind === 'text')).toBe(true)
    expect(bundle.artifacts.some(({ kind }) => kind === 'layout-pdf')).toBe(
      true,
    )
  })

  it('fails closed on a missing referenced image, raw-output tampering, and the configured output bound', async () => {
    const missing = await fakeMineruOutput({ omitReferencedImage: true })
    const identity = {
      rootRef: `cache-${sha256('cache').slice(0, 32)}`,
      mineruExecutableSha256: sha256('mineru-executable'),
      mineruConfigSha256: sha256('mineru-config'),
      modelConfigSha256: sha256('model-config'),
      runtimeInventorySha256: sha256('runtime-inventory'),
      runtimeTreeByteLength: 4096,
      cacheInventorySha256: sha256('cache'),
      cacheByteLength: MINERU_PRODUCTION_MODEL_BYTE_LENGTH,
      execution: {
        hostClass: 'owner-laptop' as const,
        operatingSystem: 'macOS-15.6',
        architecture: 'arm64' as const,
        runtime: 'python-3.12' as const,
        backend: 'mlx-vlm' as const,
        backendVersion: 'mlx-vlm-0.3.12+mlx-0.31.1',
        runtimeSha256: sha256('python-runtime'),
        backendSha256: sha256('mlx-backend'),
        packageSetSha256: sha256('installed-package-records'),
        cacheNamespaceSha256: sha256('cache-namespace'),
        networkIsolation: 'macos-sandbox-exec-deny-network-v1' as const,
        networkIsolationSha256: sha256('sandbox-exec-deny-network'),
      },
    }
    identity.execution.cacheNamespaceSha256 = sha256(
      `{"namespace":"mineru-production","rootRef":"${identity.rootRef}"}`,
    )
    await expect(
      normalizeMineruRunArtifacts({
        sourcePdfPath: fixturePdf,
        runDirectory: missing.root,
        outputRoot: missing.outputRoot,
        maximumCacheBytes: MINERU_MAX_OWNER_CACHE_BYTES,
        identity,
      }),
    ).rejects.toThrow(/REFERENCED_IMAGE/u)

    const bounded = await fakeMineruOutput()
    await expect(
      normalizeMineruRunArtifacts({
        sourcePdfPath: fixturePdf,
        runDirectory: bounded.root,
        outputRoot: bounded.outputRoot,
        maximumCacheBytes: MINERU_MAX_OWNER_CACHE_BYTES,
        maximumOutputBytes: 1,
        identity,
      } as Parameters<typeof normalizeMineruRunArtifacts>[0]),
    ).rejects.toThrow(/OUTPUT_BOUND/u)

    const retained = await fakeMineruOutput()
    const manifest = await normalizeMineruRunArtifacts({
      sourcePdfPath: fixturePdf,
      runDirectory: retained.root,
      outputRoot: retained.outputRoot,
      maximumCacheBytes: MINERU_MAX_OWNER_CACHE_BYTES,
      identity,
    })
    const raw = manifest.artifacts.find(({ kind }) => kind === 'raw-output')!
    expect(raw).toBeDefined()
    await writeFile(join(retained.root, raw.relativePath), 'tampered')
    await expect(
      inspectMineruSourceEvidence({
        artifactRoot: retained.root,
        manifest,
      }),
    ).rejects.toThrow(/ARTIFACT_IDENTITY_MISMATCH/u)
  })

  it('exposes a strict help/argument contract without accepting relative paths', () => {
    expect(OWNER_LOCAL_MINERU_HELP).toContain('--model-root')
    expect(parseOwnerLocalMineruArguments(['--help'])).toEqual({ help: true })
    expect(() =>
      parseOwnerLocalMineruArguments([
        '--pdf',
        'relative.pdf',
        '--run-root',
        '/private/tmp/runs',
        '--mineru',
        '/private/tmp/venv/bin/mineru',
        '--python',
        '/private/tmp/venv/bin/python3.12',
        '--config',
        '/private/tmp/mineru.json',
        '--model-root',
        '/private/tmp/model',
      ]),
    ).toThrow(/ABSOLUTE_PATH_REQUIRED/u)
  })

  it('executes through a real OS network-isolation boundary', async () => {
    const runDirectory = await realpath(
      await mkdtemp(join(tmpdir(), 'mineru-network-probe-')),
    )
    roots.push(runDirectory)
    await chmod(runDirectory, 0o700)
    const isMac = process.platform === 'darwin'
    const plan = buildOwnerLocalMineruIsolationCommand({
      isolation: isMac
        ? 'macos-sandbox-exec-deny-network-v1'
        : 'linux-user-netns-loopback-only-v1',
      isolationExecutable: isMac
        ? '/usr/bin/sandbox-exec'
        : '/usr/bin/unshare',
      runDirectory,
      program: process.execPath,
      args: [
        '-e',
        `const net=require('node:net');const socket=net.connect(53,'1.1.1.1');socket.once('connect',()=>process.exit(9));socket.once('error',(error)=>process.exit(['EPERM','EACCES','ENETUNREACH','EHOSTUNREACH','EADDRNOTAVAIL'].includes(error.code)?0:8));setTimeout(()=>process.exit(7),2000)`,
      ],
    })
    if (isMac) expect(plan.args[0]).toBe('-p')
    else expect(plan.args).toContain('--net')
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(plan.command, plan.args, { stdio: 'ignore' })
      child.once('error', rejectPromise)
      child.once('exit', (code, signal) => {
        if (code === 0 && signal === null) resolvePromise()
        else rejectPromise(
          new Error(`NETWORK_ISOLATION_PROBE_FAILED:${code}:${signal}`),
        )
      })
    })
  })

  it('enforces the measured execution snapshot as read-only inside isolation', async () => {
    const runDirectory = await realpath(
      await mkdtemp(join(tmpdir(), 'mineru-readonly-probe-')),
    )
    roots.push(runDirectory)
    await chmod(runDirectory, 0o700)
    const measuredRoot = join(runDirectory, 'measured')
    const measuredFile = join(measuredRoot, 'identity.txt')
    await mkdir(measuredRoot, { mode: 0o700 })
    await writeFile(measuredFile, 'measured')
    const isMac = process.platform === 'darwin'
    const plan = buildOwnerLocalMineruIsolationCommand({
      isolation: isMac
        ? 'macos-sandbox-exec-deny-network-v1'
        : 'linux-user-netns-loopback-only-v1',
      isolationExecutable: isMac
        ? '/usr/bin/sandbox-exec'
        : '/usr/bin/unshare',
      runDirectory,
      program: process.execPath,
      args: [
        '-e',
        `const fs=require('node:fs');try{fs.writeFileSync(${JSON.stringify(
          measuredFile,
        )},'swapped');process.exit(9)}catch(error){process.exit(['EPERM','EACCES','EROFS'].includes(error.code)?0:8)}`,
      ],
      readOnlyPaths: [measuredRoot],
    })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(plan.command, plan.args, { stdio: 'ignore' })
      child.once('error', rejectPromise)
      child.once('exit', (code, signal) => {
        if (code === 0 && signal === null) resolvePromise()
        else
          rejectPromise(
            new Error(`READONLY_ISOLATION_PROBE_FAILED:${code}:${signal}`),
          )
      })
    })
    expect(await readFile(measuredFile, 'utf8')).toBe('measured')
  })

  it('seals execution bytes before use and rejects swap-use-restore aliases', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'mineru-sealed-tree-test-')),
    )
    roots.push(root)
    const source = join(root, 'mutable-runtime')
    const sealed = join(root, 'sealed-runtime')
    await mkdir(join(source, 'bin'), { recursive: true, mode: 0o700 })
    await writeFile(join(source, 'bin', 'python'), 'measured-runtime', {
      mode: 0o755,
    })
    await symlink('python', join(source, 'bin', 'python-alias'))
    const preflightRuntime = await measureOwnerLocalExecutionTree(source)
    const snapshot = await sealOwnerLocalExecutionTree({
      sourceRoot: source,
      sealedRoot: sealed,
      maximumLogicalBytes: 32 * 1024,
      maximumAllocatedBytes: 32 * 1024,
    })
    await writeFile(join(source, 'bin', 'python'), 'swapped-then-restored', {
      mode: 0o755,
    })
    expect(await readFile(join(sealed, 'bin', 'python'), 'utf8')).toBe(
      'measured-runtime',
    )
    expect(await readFile(join(sealed, 'bin', 'python-alias'), 'utf8')).toBe(
      'measured-runtime',
    )
    expect((await stat(sealed)).mode & 0o222).toBe(0)
    expect((await stat(join(sealed, 'bin', 'python'))).mode & 0o222).toBe(0)
    expect(snapshot.fileCount).toBe(2)
    expect(snapshot.inventorySha256).toBe(preflightRuntime.sha256)
    expect(snapshot.byteLength).toBe(preflightRuntime.byteLength)
    expect(snapshot.allocatedByteLength).toBeGreaterThan(0)

    const ordinarySnapshot = await sealOwnerLocalExecutionTree({
      sourceRoot: source,
      sealedRoot: join(root, 'sealed-runtime-ordinary-copy'),
      maximumLogicalBytes: 32 * 1024,
      maximumAllocatedBytes: 32 * 1024,
      copyMode: 'ordinary-copy',
    })
    expect(ordinarySnapshot.allocatedByteLength).toBeGreaterThanOrEqual(
      ordinarySnapshot.byteLength,
    )
    const privateSnapshotByteLength =
      ownerLocalPrivateSnapshotAllocatedBytes({
        runtimeAllocatedByteLength: snapshot.allocatedByteLength,
        modelAllocatedByteLength: ordinarySnapshot.allocatedByteLength,
        sourceAllocatedByteLength: 4096,
        preflightConfigAllocatedByteLength: 4096,
        effectiveConfigAllocatedByteLength: 4096,
      })
    expect(privateSnapshotByteLength).toBe(
      snapshot.allocatedByteLength +
        ordinarySnapshot.allocatedByteLength +
        3 * 4096,
    )
    const preflightConfig = join(root, 'preflight-mineru.json')
    await writeFile(preflightConfig, '{"model-source":"local"}', {
      mode: 0o600,
    })
    await expect(
      assertOwnerLocalSealedPreflightIdentity({
        runtimeSnapshot: ordinarySnapshot,
        expectedRuntimeInventorySha256: snapshot.inventorySha256,
        expectedRuntimeTreeByteLength: snapshot.byteLength,
        sealedPreflightConfigPath: preflightConfig,
        expectedPreflightConfigSha256: sha256('{"model-source":"local"}'),
      }),
    ).rejects.toThrow(/SEALED_RUNTIME_IDENTITY_MISMATCH/u)
    await expect(
      assertOwnerLocalSealedPreflightIdentity({
        runtimeSnapshot: ordinarySnapshot,
        expectedRuntimeInventorySha256: ordinarySnapshot.inventorySha256,
        expectedRuntimeTreeByteLength: ordinarySnapshot.byteLength,
        sealedPreflightConfigPath: preflightConfig,
        expectedPreflightConfigSha256: sha256('different-config'),
      }),
    ).rejects.toThrow(/SEALED_CONFIG_IDENTITY_MISMATCH/u)
    expect(() =>
      assertOwnerLocalMineruResourceUsage({
        maximumOutputBytes: 1,
        maximumCacheBytes: privateSnapshotByteLength,
        cacheByteLength: 0,
        privateSnapshotByteLength: privateSnapshotByteLength + 1,
        outputByteLength: 0,
        privateScratchByteLength: 0,
        fileCount: 0,
      }),
    ).toThrow(/CACHE_BOUND/u)

    const plan = buildOwnerLocalMineruIsolationCommand({
      isolation: 'macos-sandbox-exec-deny-network-v1',
      isolationExecutable: '/usr/bin/sandbox-exec',
      runDirectory: root,
      program: join(sealed, 'bin', 'python'),
      args: [],
      readOnlyPaths: [sealed],
    })
    expect(plan.args[1]).toContain(
      `(deny file-write* (subpath "${sealed}"))`,
    )
    await chmod(join(sealed, 'bin'), 0o700)
    await chmod(sealed, 0o700)
    await chmod(join(ordinarySnapshot.sealedRoot, 'bin'), 0o700)
    await chmod(ordinarySnapshot.sealedRoot, 0o700)
  })

  it('uses one code-unit inventory order for preflight and sealed runtime trees', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'mineru-runtime-order-test-')),
    )
    roots.push(root)
    const source = join(root, 'runtime')
    await mkdir(join(source, 'bin'), { recursive: true, mode: 0o700 })
    await writeFile(join(source, 'bin', 'python'), 'runtime', {
      mode: 0o755,
    })
    await writeFile(join(source, 'CACHEDIR.TAG'), 'cache-tag')

    const preflight = await measureOwnerLocalExecutionTree(source)
    const sealed = await sealOwnerLocalExecutionTree({
      sourceRoot: source,
      sealedRoot: join(root, 'sealed-runtime'),
      maximumLogicalBytes: 32 * 1024,
      maximumAllocatedBytes: 32 * 1024,
    })
    await chmod(join(sealed.sealedRoot, 'bin'), 0o700)
    await chmod(sealed.sealedRoot, 0o700)

    expect(sealed.inventorySha256).toBe(preflight.sha256)
    expect(sealed.byteLength).toBe(preflight.byteLength)
  })

  it('admits unaligned logical model bytes by remaining global allocation and rejects true overflow', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'mineru-model-allocation-test-')),
    )
    roots.push(root)
    const source = join(root, 'model-source')
    await mkdir(source, { mode: 0o700 })
    const logicalBytes = 4097
    await writeFile(
      join(source, 'model.safetensors'),
      Buffer.alloc(logicalBytes, 1),
    )

    const fixedUsage = {
      originalCacheByteLength: 8 * 1024,
      runtimeAllocatedByteLength: 16 * 1024,
      sourceAllocatedByteLength: 4 * 1024,
      preflightConfigAllocatedByteLength: 4 * 1024,
      effectiveConfigAllocatedByteLength: 4 * 1024,
      reservedOutputByteLength: 16 * 1024,
      reservedPrivateScratchByteLength: 16 * 1024,
    }
    const fixedByteLength = Object.values(fixedUsage).reduce(
      (total, value) => total + value,
      0,
    )
    const allocatedCapacity = 64 * 1024
    const maximumCacheBytes = fixedByteLength + allocatedCapacity
    const maximumAllocatedBytes =
      remainingOwnerLocalSealedModelAllocatedBytes({
        maximumCacheBytes,
        ...fixedUsage,
      })
    expect(maximumAllocatedBytes).toBe(allocatedCapacity)

    const snapshot = await sealOwnerLocalExecutionTree({
      sourceRoot: source,
      sealedRoot: join(root, 'sealed-model'),
      maximumLogicalBytes: logicalBytes,
      maximumAllocatedBytes,
      copyMode: 'ordinary-copy',
    })
    expect(snapshot.byteLength).toBe(logicalBytes)
    expect(snapshot.allocatedByteLength).toBeGreaterThan(logicalBytes)
    expect(snapshot.allocatedByteLength).toBeLessThanOrEqual(
      maximumAllocatedBytes,
    )

    const overflowAllocatedBytes =
      remainingOwnerLocalSealedModelAllocatedBytes({
        maximumCacheBytes:
          fixedByteLength + snapshot.allocatedByteLength - 1,
        ...fixedUsage,
      })
    await expect(
      sealOwnerLocalExecutionTree({
        sourceRoot: source,
        sealedRoot: join(root, 'sealed-model-overflow'),
        maximumLogicalBytes: logicalBytes,
        maximumAllocatedBytes: overflowAllocatedBytes,
        copyMode: 'ordinary-copy',
      }),
    ).rejects.toThrow(/SEALED_SNAPSHOT_BOUND_EXCEEDED/u)
    await chmod(snapshot.sealedRoot, 0o700)
  })

  it('counts private HOME and TMPDIR in live and final owner-local bounds', () => {
    expect(() =>
      assertOwnerLocalMineruResourceUsage({
        maximumOutputBytes: 100,
        maximumCacheBytes: 1_000,
        cacheByteLength: 700,
        privateSnapshotByteLength: 100,
        outputByteLength: 50,
        privateScratchByteLength: 151,
        fileCount: 4,
      }),
    ).toThrow(/CACHE_BOUND/u)
    expect(() =>
      assertOwnerLocalMineruResourceUsage({
        maximumOutputBytes: 100,
        maximumCacheBytes: 1_000,
        cacheByteLength: 700,
        privateSnapshotByteLength: 100,
        outputByteLength: 50,
        privateScratchByteLength: 150,
        fileCount: 4,
      }),
    ).not.toThrow()
  })

  it('binds the real offline MLX born-digital and scan smoke receipts to distinct source bytes', async () => {
    expect(MINERU_PRODUCTION_VERSION).toBe('3.4.4')
    expect(MINERU_PRODUCTION_MODEL_SHA256).toBe(
      'abf8681ca63b8dec7b67de257af47b821f179442f72998d0696ae2ed9232a5f0',
    )
    for (const receipt of realMlxSmokeReceipts) {
      expect(
        createHash('sha256')
          .update(await readFile(receipt.fixture))
          .digest('hex'),
      ).toBe(receipt.sourcePdfSha256)
      expect(receipt.producerReceiptSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(Object.keys(receipt.artifacts)).toEqual([
        'markdown',
        'content-list-v1',
        'content-list-v2',
        'middle-json',
        'model-json',
        'layout-pdf',
      ])
      expect(
        Object.values(receipt.artifacts).every((value) =>
          /^[a-f0-9]{64}$/u.test(value),
        ),
      ).toBe(true)
    }
    expect(realMlxSmokeReceipts[0].artifacts).not.toEqual(
      realMlxSmokeReceipts[1].artifacts,
    )
  })
})

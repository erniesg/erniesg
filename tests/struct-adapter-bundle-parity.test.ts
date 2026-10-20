import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  StructBundleError,
  createStructBundle,
  decodeStructBundle,
  encodeStructBundle,
} from '@erniesg/struct/bundle'
import { encodeStructDocument as packageEncodeDocument } from '@erniesg/struct/document'
import { buildStructDocument } from '../src/struct-adapters'
import {
  adapterCases,
  loadAdapterCase,
} from './fixtures/struct-adapter-parity/cases'
import {
  decodeReconstruction,
  observeAdapterBundle,
} from './fixtures/struct-adapter-parity/observe'

const frozen = JSON.parse(
  await readFile(
    new URL('./fixtures/struct-adapter-parity/expected.json', import.meta.url),
    'utf8',
  ),
)

const srcRoot = new URL('../src/', import.meta.url)

async function sourceFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => sourceFiles(new URL(`${entry.name}/`, directory))),
  )
  return [
    ...nested.flat(),
    ...entries
      .filter((entry) => entry.isFile() && /\.(?:ts|tsx|astro)$/.test(entry.name))
      .map((entry) => new URL(entry.name, directory)),
  ]
}

async function loadDocument(name: string) {
  const text = await readFile(
    new URL(
      `./fixtures/struct-adapter-parity/reconstructions/${name}.json`,
      import.meta.url,
    ),
    'utf8',
  )
  return buildStructDocument(decodeReconstruction(text))
}

describe('app-owned Struct bundle parity at the S-04 pin', () => {
  it.each(adapterCases)(
    'creates, encodes and bytes-only decodes the %s bundle',
    async (name) => {
      const observed = await observeAdapterBundle(await loadAdapterCase(name))
      expect(observed).toEqual(frozen.bundle[name])
    },
  )

  it('conserves every supplied asset by digest and length, not by count', async () => {
    for (const name of adapterCases) {
      const observed = frozen.bundle[name] as {
        assetIds: string[]
        assetDigestConservation: Array<{
          id: string
          suppliedSha256: string
          suppliedByteLength: number
          verifiedSha256: string
          verifiedByteLength: number
          conserved: boolean
        }>
        assetDigestConservationOk: boolean
      }
      expect(observed.assetDigestConservationOk, name).toBe(true)
      expect(observed.assetDigestConservation.map((a) => a.id), name).toEqual(
        observed.assetIds,
      )
      for (const asset of observed.assetDigestConservation) {
        expect(asset.conserved, `${name}:${asset.id}`).toBe(true)
        expect(asset.verifiedSha256, `${name}:${asset.id}`).toBe(
          asset.suppliedSha256,
        )
        expect(asset.verifiedByteLength, `${name}:${asset.id}`).toBe(
          asset.suppliedByteLength,
        )
        expect(asset.suppliedSha256, `${name}:${asset.id}`).toMatch(
          /^[a-f0-9]{64}$/u,
        )
      }
      // The bundle's verified asset digests must equal the already-frozen
      // per-case asset digests. The frozen file is not regenerated here; this
      // is a read-only cross-check against the existing golden.
      const frozenAssets = (
        frozen[name] as { assets: Array<{ id: string; sha256: string }> }
      ).assets
      expect(
        observed.assetDigestConservation.map((a) => ({
          id: a.id,
          sha256: a.verifiedSha256,
        })),
        name,
      ).toEqual(frozenAssets.map((a) => ({ id: a.id, sha256: a.sha256 })))
    }
  })

  it('binds the bytes-only ingress to the expected bundle digest', async () => {
    const document = await loadDocument('structured-docx')
    const handle = createStructBundle({
      document: packageEncodeDocument(document),
    })
    const raw = encodeStructBundle(handle)
    await expect(
      decodeStructBundle(raw, { expectedBundleSha256: 'a'.repeat(64) }),
    ).rejects.toMatchObject({
      name: 'StructBundleError',
      stage: 'digest',
      code: 'MISMATCH',
    })
  })

  it('never throws synchronously from the bytes-only decoder', async () => {
    let promise: unknown
    expect(() => {
      promise = decodeStructBundle(new Uint8Array([1, 2, 3]))
    }).not.toThrow()
    expect(promise).toBeInstanceOf(Promise)
    await expect(promise).rejects.toBeInstanceOf(StructBundleError)
  })

  it('fails closed when the handle is forged', async () => {
    const document = await loadDocument('structured-docx')
    const handle = createStructBundle({
      document: packageEncodeDocument(document),
    })
    for (const candidate of [
      { documentSha256: 'x', bundleSha256: 'y' },
      { ...handle },
      null,
      'not-a-handle',
    ]) {
      expect(() => encodeStructBundle(candidate as unknown)).toThrow(
        StructBundleError,
      )
      try {
        encodeStructBundle(candidate as unknown)
      } catch (error) {
        expect(error).toMatchObject({ stage: 'handle', code: 'FORGED' })
      }
    }
  })

  it('records the absence of a production wire reader and keeps the adapter in-memory', async () => {
    // There is no production struct-jar/wire reader in this app yet, so the
    // bundle adapter stays in-memory and test-scoped. Any future production
    // ingress must call decodeStructBundle(rawBytes, ...) and must not use the
    // embedded value verifier for wire data.
    const production = await Promise.all(
      (await sourceFiles(srcRoot)).map(async (file) => ({
        path: file.pathname,
        source: await readFile(file, 'utf8'),
      })),
    )
    expect(production.length).toBeGreaterThan(0)
    const bundleConsumers = production.filter((file) =>
      file.source.includes('@erniesg/struct/bundle'),
    )
    expect(bundleConsumers.map((file) => file.path)).toEqual([])
    const valueVerifierUsers = production.filter((file) =>
      file.source.includes('verifyStructBundle'),
    )
    expect(valueVerifierUsers.map((file) => file.path)).toEqual([])

    const observeSource = await readFile(
      new URL('./fixtures/struct-adapter-parity/observe.ts', import.meta.url),
      'utf8',
    )
    expect(observeSource).toContain('decodeStructBundle(raw,')
    expect(observeSource).not.toContain('verifyStructBundle')
    // E-02 is embedded-only: no resolver option is passed at the call site.
    for (const option of [
      'resolverExecutor',
      'resolverPolicy',
      'resolverBudget',
      'resolverSignal',
      'resolverHostSupervisor',
    ]) {
      expect(observeSource).not.toContain(option)
    }
  })
})

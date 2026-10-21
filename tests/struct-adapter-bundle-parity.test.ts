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
  sha256,
} from './fixtures/struct-adapter-parity/observe'

const frozen = JSON.parse(
  await readFile(
    new URL('./fixtures/struct-adapter-parity/expected.json', import.meta.url),
    'utf8',
  ),
)

const srcRoot = new URL('../src/', import.meta.url)
const toolsRoot = new URL('../tools/', import.meta.url)

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

/**
 * The tool sources, including the plain-JS tools. The release checker is a
 * `.mjs` tool, so the wire-reader census has to see it.
 */
async function toolSourceFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        toolSourceFiles(new URL(`${entry.name}/`, directory)),
      ),
  )
  return [
    ...nested.flat(),
    ...entries
      .filter(
        (entry) =>
          entry.isFile() && /\.(?:ts|tsx|astro|mjs|cjs|mts|cts)$/.test(entry.name),
      )
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

  it('refuses a bundle body with one flipped byte instead of decoding it', async () => {
    const document = await loadDocument('structured-docx')
    const handle = createStructBundle({
      document: packageEncodeDocument(document),
    })
    const raw = encodeStructBundle(handle)
    // Baseline: the untampered body is accepted, so the rejection below is
    // caused by the flipped byte alone and not by a broken fixture.
    const accepted = await decodeStructBundle(raw)
    expect(accepted.bundleSha256).toBe(handle.bundleSha256)

    // Exactly one byte of the encoded body is flipped: the last one.
    const tampered = new Uint8Array(raw)
    tampered[tampered.length - 1] ^= 0xff
    let differing = 0
    for (let index = 0; index < raw.length; index += 1) {
      if (tampered[index] !== raw[index]) differing += 1
    }
    expect(differing).toBe(1)

    // The bytes-only ingress must refuse the tampered body. Measured at this
    // pin: stage `canonical`, code `SYNTAX`, because the flipped byte breaks
    // the canonical JSON envelope before any asset is inspected.
    await expect(decodeStructBundle(tampered)).rejects.toBeInstanceOf(
      StructBundleError,
    )
    await expect(decodeStructBundle(tampered)).rejects.toMatchObject({
      name: 'StructBundleError',
      stage: 'canonical',
      code: 'SYNTAX',
    })
  })

  it('refuses asset bytes whose digest does not match the declared digest', async () => {
    const document = await loadDocument('structured-docx')
    const json = packageEncodeDocument(document)
    const tamperedAssets = json.assets.map((asset, index) => {
      if (index !== 0) return asset
      const bytes = new Uint8Array(Buffer.from(asset.bytes ?? '', 'base64'))
      expect(bytes.byteLength).toBeGreaterThan(0)
      bytes[0] ^= 0xff
      // The declared digest and the supplied bytes must genuinely disagree.
      // Both sides are computed here, so no frozen fixture value is asserted.
      expect(sha256(bytes)).not.toBe(asset.sha256)
      return { ...asset, bytes: Buffer.from(bytes).toString('base64') }
    })
    const tampered = { ...json, assets: tamperedAssets }

    // The creator throws synchronously; it never returns a handle for the
    // mismatch and never returns a rejected promise.
    expect(() => createStructBundle({ document: tampered })).toThrow(
      StructBundleError,
    )
    let thrown: unknown
    try {
      createStructBundle({ document: tampered })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(StructBundleError)
    // Measured at this pin: the document codec refuses the mismatched bytes
    // first, so the bundle facade surfaces the refusal at stage `input`.
    expect(thrown).toMatchObject({
      name: 'StructBundleError',
      stage: 'input',
      code: 'TYPE',
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
    //
    // E-04 changed exactly one thing here, and the rule is still the rule: the
    // publication facade may CREATE a bundle from the document the build
    // produced and ENCODE it to bind the receipt to those bytes, but no
    // production module may READ bundle wire bytes and no production module
    // may use the value verifier. The permitted bundle importer is therefore
    // the one module that creates and encodes, and the wire reader and the
    // value verifier stay out of production entirely.
    const production = await Promise.all(
      (await sourceFiles(srcRoot))
        .filter((file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.pathname))
        .map(async (file) => ({
          path: file.pathname,
          source: await readFile(file, 'utf8'),
        })),
    )
    expect(production.length).toBeGreaterThan(0)
    const bundleConsumers = production.filter((file) =>
      file.source.includes('@erniesg/struct/bundle'),
    )
    expect(bundleConsumers.map((file) => file.path)).toEqual([
      new URL('../src/publication/struct-source-binding.ts', import.meta.url)
        .pathname,
    ])
    // The permitted importer creates and encodes; it never reads wire bytes.
    expect(bundleConsumers[0]?.source).toContain('createStructBundle')
    expect(bundleConsumers[0]?.source).toContain('encodeStructBundle')
    expect(bundleConsumers[0]?.source).not.toContain('decodeStructBundle')
    const wireReaders = production.filter((file) =>
      file.source.includes('decodeStructBundle'),
    )
    expect(wireReaders.map((file) => file.path)).toEqual([])
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

  it('requires the release checker to be the one bounded wire reader', async () => {
    // E-04 gate EG-10 (plan clause F8, governing plan commit
    // 51c6656f9e0cab725672d09efaf22a8c6b9af1b5) requires the release check
    // to decode the receipt-bound `struct-bundle.bin` with
    // `decodeStructBundle(bytes, { expectedBundleSha256 })`.
    //
    // This is a deliberate, cited amendment of the E-02 policy above, not a
    // silent narrowing of it: `src/**` still contains NO wire reader and NO
    // value verifier, and the release checker in `tools/` is the ONE required
    // bounded reader. The value verifier stays forbidden for wire data
    // everywhere, and the reader stays embedded-only: no resolver option and
    // no external fetch is passed at the call site.
    const releaseChecker = await readFile(
      new URL('../tools/publication-check.mjs', import.meta.url),
      'utf8',
    )
    expect(releaseChecker).toContain('decodeStructBundle')
    expect(releaseChecker).toContain('expectedBundleSha256')
    // The value verifier is forbidden for wire data, in the release checker
    // as well as in src.
    expect(releaseChecker).not.toContain('verifyStructBundle')
    // The bounded reader stays embedded-only.
    for (const option of [
      'resolverExecutor',
      'resolverPolicy',
      'resolverBudget',
      'resolverSignal',
      'resolverHostSupervisor',
    ]) {
      expect(releaseChecker).not.toContain(option)
    }

    // The release checker is the ONLY wire reader outside the test scope.
    const toolFiles = (
      await Promise.all(
        (await toolSourceFiles(toolsRoot)).map(async (file) => ({
          path: file.pathname,
          source: await readFile(file, 'utf8'),
        })),
      )
    ).filter((file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file.path))
    expect(toolFiles.length).toBeGreaterThan(0)
    const toolWireReaders = toolFiles.filter((file) =>
      file.source.includes('decodeStructBundle'),
    )
    expect(toolWireReaders.map((file) => file.path)).toEqual([
      new URL('../tools/publication-check.mjs', import.meta.url).pathname,
    ])
    const toolValueVerifierUsers = toolFiles.filter((file) =>
      file.source.includes('verifyStructBundle'),
    )
    expect(toolValueVerifierUsers.map((file) => file.path)).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import {
  assetBundleSchema,
  assetContentHash,
  AssetIntegrityError,
  ASSET_BUNDLE_VERSION,
  createAssetBundle,
  createMemoryAssetResolver,
  describeAsset,
  findAssetDescriptor,
  parseAssetBundleData,
  resolveAssetBytes,
  serializeAssetBundle,
} from './asset-bundle'
import { UnsupportedPublicationVersionError } from './schema'

const BYTES = new TextEncoder().encode('a deterministic figure payload')

function fixtureDescriptor() {
  return describeAsset({
    id: 'asset-pipeline',
    mediaType: 'image/png',
    role: 'image',
    title: 'Canonical composition pipeline',
    bytes: BYTES,
    provenance: { source: 'PRD §3', method: 'authored' },
  })
}

function fixtureBundle() {
  return createAssetBundle(
    [fixtureDescriptor()],
    createMemoryAssetResolver('memory', { 'asset-pipeline': BYTES }),
  )
}

describe('publication asset bundle', () => {
  it('describes assets by content address without embedding bytes or paths', () => {
    const descriptor = fixtureDescriptor()

    expect(descriptor.contentHash).toBe(assetContentHash(BYTES))
    expect(descriptor.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(descriptor.byteLength).toBe(BYTES.byteLength)
    expect(serializeAssetBundle(fixtureBundle())).not.toContain('resolver')
    expect(JSON.parse(serializeAssetBundle(fixtureBundle()))).toEqual({
      version: ASSET_BUNDLE_VERSION,
      assets: [descriptor],
    })
  })

  it('rejects bytes, local paths, and unknown fields in descriptors', () => {
    const descriptor = fixtureDescriptor()
    const resolver = createMemoryAssetResolver('memory', {})

    expect(() =>
      createAssetBundle([{ ...descriptor, bytes: [1, 2, 3] } as never], resolver),
    ).toThrow()
    expect(() =>
      createAssetBundle(
        [{ ...descriptor, path: '/Users/ernie/figure.png' } as never],
        resolver,
      ),
    ).toThrow()
    expect(() =>
      createAssetBundle(
        [
          {
            ...descriptor,
            provenance: {
              source: 'file:///Users/ernie/figure.png',
              method: 'imported',
            },
          },
        ],
        resolver,
      ),
    ).toThrow()
    expect(() =>
      createAssetBundle([{ ...descriptor, contentHash: 'md5:abc' } as never], resolver),
    ).toThrow()
    expect(() =>
      createAssetBundle([{ ...descriptor, mediaType: 'not-a-media-type' }], resolver),
    ).toThrow()
  })

  it('requires a byte-resolver interface and rejects duplicate ids', () => {
    expect(() =>
      assetBundleSchema.parse({
        version: ASSET_BUNDLE_VERSION,
        assets: [fixtureDescriptor()],
      }),
    ).toThrow()
    expect(() =>
      createAssetBundle(
        [fixtureDescriptor(), fixtureDescriptor()],
        createMemoryAssetResolver('memory', {}),
      ),
    ).toThrow(/Duplicate asset id/)
  })

  it('rejects unknown bundle versions', () => {
    expect(() =>
      parseAssetBundleData({ version: '9.9.9', assets: [] }),
    ).toThrow(UnsupportedPublicationVersionError)
    expect(parseAssetBundleData({ version: ASSET_BUNDLE_VERSION, assets: [] })).toEqual({
      version: ASSET_BUNDLE_VERSION,
      assets: [],
    })
  })

  it('proves the content address when bytes are resolved', async () => {
    const bundle = fixtureBundle()

    expect(findAssetDescriptor(bundle, 'asset-pipeline')?.role).toBe('image')
    await expect(resolveAssetBytes(bundle, 'asset-pipeline')).resolves.toEqual(BYTES)
    await expect(resolveAssetBytes(bundle, 'missing')).rejects.toBeInstanceOf(
      AssetIntegrityError,
    )

    const tampered = createAssetBundle(
      [fixtureDescriptor()],
      createMemoryAssetResolver('memory', {
        'asset-pipeline': new TextEncoder().encode(
          'a deterministic figure payloae',
        ),
      }),
    )
    await expect(resolveAssetBytes(tampered, 'asset-pipeline')).rejects.toBeInstanceOf(
      AssetIntegrityError,
    )

    const shortened = createAssetBundle(
      [fixtureDescriptor()],
      createMemoryAssetResolver('memory', {
        'asset-pipeline': new TextEncoder().encode('short'),
      }),
    )
    await expect(resolveAssetBytes(shortened, 'asset-pipeline')).rejects.toThrow(
      /declares \d+/,
    )
  })

  it('serialises deterministically regardless of descriptor key order', () => {
    const descriptor = fixtureDescriptor()
    const reordered = Object.fromEntries(
      Object.entries(descriptor).reverse(),
    ) as typeof descriptor

    expect(
      serializeAssetBundle(
        createAssetBundle([reordered], createMemoryAssetResolver('memory', {})),
      ),
    ).toBe(serializeAssetBundle(fixtureBundle()))
  })
})

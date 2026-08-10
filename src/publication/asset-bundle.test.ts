import { describe, expect, it } from 'vitest'
import {
  assetBundleDescriptorSchema,
  createAssetBundle,
  serializeAssetBundle,
} from './asset-bundle'

const descriptor = {
  version: '1.0.0',
  assets: [
    {
      id: 'image',
      sha256: 'a'.repeat(64),
      byteLength: 3,
      mediaType: 'image/png',
      fileName: 'image.png',
    },
  ],
}

describe('AssetBundle', () => {
  it('keeps content-addressed descriptors separate from byte resolution', async () => {
    const bundle = createAssetBundle(
      descriptor,
      async () => new Uint8Array([1, 2, 3]),
    )
    expect(await bundle.resolveBytes(bundle.descriptor.assets[0])).toEqual(
      new Uint8Array([1, 2, 3]),
    )
    expect(serializeAssetBundle(bundle)).not.toContain('[1,2,3]')
    expect(JSON.parse(serializeAssetBundle(bundle))).toEqual(descriptor)
  })

  it('rejects embedded bytes, paths, duplicate ids and invalid bounds', () => {
    expect(
      assetBundleDescriptorSchema.safeParse({ ...descriptor, bytes: [1] })
        .success,
    ).toBe(false)
    expect(
      assetBundleDescriptorSchema.safeParse({
        ...descriptor,
        assets: [{ ...descriptor.assets[0], fileName: '../image.png' }],
      }).success,
    ).toBe(false)
    expect(
      assetBundleDescriptorSchema.safeParse({
        ...descriptor,
        assets: [descriptor.assets[0], descriptor.assets[0]],
      }).success,
    ).toBe(false)
    expect(
      assetBundleDescriptorSchema.safeParse({
        ...descriptor,
        assets: [{ ...descriptor.assets[0], byteLength: -1 }],
      }).success,
    ).toBe(false)
  })
})

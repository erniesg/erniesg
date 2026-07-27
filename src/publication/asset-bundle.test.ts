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
      sha256:
        '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
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
    expect(
      assetBundleDescriptorSchema.safeParse({
        ...descriptor,
        assets: [{ ...descriptor.assets[0], fileName: '..' }],
      }).success,
    ).toBe(false)
  })

  it('verifies resolved bytes against descriptor identity and content', async () => {
    const wrongLength = createAssetBundle(
      descriptor,
      async () => new Uint8Array([1]),
    )
    await expect(
      wrongLength.resolveBytes(wrongLength.descriptor.assets[0]),
    ).rejects.toThrow(/expected 3/)

    const wrongHash = createAssetBundle(
      descriptor,
      async () => new Uint8Array([3, 2, 1]),
    )
    await expect(
      wrongHash.resolveBytes(wrongHash.descriptor.assets[0]),
    ).rejects.toThrow(/content-address/)

    const valid = createAssetBundle(
      descriptor,
      async () => new Uint8Array([1, 2, 3]),
    )
    await expect(
      valid.resolveBytes({
        ...valid.descriptor.assets[0],
        mediaType: 'image/jpeg',
      }),
    ).rejects.toThrow(/does not match/)
  })
})

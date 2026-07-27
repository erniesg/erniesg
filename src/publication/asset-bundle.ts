import { z } from 'zod'
import { createHash } from 'node:crypto'

export const ASSET_BUNDLE_VERSION = '1.0.0' as const
export const MAX_ASSET_COUNT = 10_000
export const MAX_ASSET_BYTES = 1_000_000_000

const assetIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

export const assetDescriptorSchema = z
  .object({
    id: assetIdSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().nonnegative().max(MAX_ASSET_BYTES),
    mediaType: z
      .string()
      .min(3)
      .max(256)
      .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i),
    fileName: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[^/\\\u0000-\u001f\u007f]+$/)
      .refine((value) => value !== '.' && value !== '..', {
        message: 'Asset file names cannot be path traversal segments',
      })
      .optional(),
    accessibilityLabel: z.string().min(1).max(100_000).optional(),
  })
  .strict()

export const assetBundleDescriptorSchema = z
  .object({
    version: z.literal(ASSET_BUNDLE_VERSION),
    assets: z.array(assetDescriptorSchema).max(MAX_ASSET_COUNT),
  })
  .strict()
  .superRefine((bundle, context) => {
    const ids = new Set<string>()
    const hashes = new Set<string>()
    bundle.assets.forEach((asset, index) => {
      if (ids.has(asset.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assets', index, 'id'],
          message: `Duplicate asset id: ${asset.id}`,
        })
      }
      if (hashes.has(asset.sha256)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assets', index, 'sha256'],
          message: `Duplicate asset content hash: ${asset.sha256}`,
        })
      }
      ids.add(asset.id)
      hashes.add(asset.sha256)
    })
  })

export type AssetDescriptor = z.infer<typeof assetDescriptorSchema>
export type AssetBundleDescriptor = z.infer<typeof assetBundleDescriptorSchema>
export type AssetByteResolver = (
  descriptor: AssetDescriptor,
) => Promise<Uint8Array>

export type AssetBundle = {
  descriptor: AssetBundleDescriptor
  resolveBytes: AssetByteResolver
}

export function createAssetBundle(
  value: unknown,
  resolveBytes: AssetByteResolver,
): AssetBundle {
  if (typeof resolveBytes !== 'function') {
    throw new TypeError('Asset bundles require a byte resolver')
  }
  const descriptor = assetBundleDescriptorSchema.parse(value)
  const descriptorIds = new Set(descriptor.assets.map((asset) => asset.id))
  return {
    descriptor,
    resolveBytes: async (requested) => {
      const parsed = assetDescriptorSchema.parse(requested)
      if (!descriptorIds.has(parsed.id)) {
        throw new Error(
          `Asset resolver received unknown descriptor ${parsed.id}`,
        )
      }
      const expected = descriptor.assets.find((asset) => asset.id === parsed.id)
      if (!expected || JSON.stringify(expected) !== JSON.stringify(parsed)) {
        throw new Error(
          `Asset resolver descriptor ${parsed.id} does not match its bundle`,
        )
      }
      const bytes = await resolveBytes(expected)
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError('Asset byte resolvers must return Uint8Array')
      }
      if (bytes.byteLength !== expected.byteLength) {
        throw new Error(
          `Asset ${expected.id} resolved ${bytes.byteLength} bytes; expected ${expected.byteLength}`,
        )
      }
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== expected.sha256) {
        throw new Error(
          `Asset ${expected.id} failed content-address verification`,
        )
      }
      return bytes
    },
  }
}

export function serializeAssetBundle(
  bundle: AssetBundle | AssetBundleDescriptor,
) {
  const descriptor = 'descriptor' in bundle ? bundle.descriptor : bundle
  return JSON.stringify(assetBundleDescriptorSchema.parse(descriptor))
}

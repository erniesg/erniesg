import { createHash } from 'node:crypto'
import {
  encodeStructDocument,
  type StructDocument,
} from '@erniesg/struct/document'
import {
  structReceiptDigest,
  verifyStructReceipt,
} from '@erniesg/struct/receipt'
import { structDigest } from '@erniesg/struct/identity'
import {
  createStructBundle,
  encodeStructBundle,
  type VerifiedStructBundle,
} from '@erniesg/struct/bundle'
import {
  structCutoverSourceBindingSchema,
  type StructCutoverSourceBinding,
} from './source-binding'
import type { StructPackagePin } from './struct-package-pin'

/**
 * Canonical digest of the ACTUAL Struct document bytes. The document is
 * encoded by the pinned package and digested by the package's own stable
 * serializer, so the value is never a stored constant and never a re-derived
 * approximation of the canonical form.
 */
export function structDocumentSha256(document: StructDocument): string {
  return structDigest(encodeStructDocument(document))
}

/**
 * The package's authoritative semantic receipt digest, not a re-implementation
 * of it.
 */
export function structSemanticReceiptSha256(document: StructDocument): string {
  return structReceiptDigest(document)
}

/**
 * Canonical digest of the ACTUAL bundle wire bytes. The bytes are produced by
 * the package from a handle this build created, so the digest can only exist
 * when the bundle was really encoded.
 */
export function structBundleSha256(bundle: VerifiedStructBundle): string {
  return createHash('sha256')
    .update(encodeStructBundle(bundle))
    .digest('hex')
}

/**
 * Create the package bundle handle for one document. The handle is the only
 * thing the package accepts as a bundle, so a forged descriptor cannot be
 * encoded.
 */
export function createStructBundleForDocument(
  document: StructDocument,
): VerifiedStructBundle {
  return createStructBundle({ document })
}

export type StructBundleDescriptorAsset = {
  id: string
  sha256: string
  mediaType: string
  byteLength: number
}

export type StructBundleDescriptor = {
  bundleVersion: string
  schemaVersion: string
  documentSha256: string
  bundleSha256: string
  assets: StructBundleDescriptorAsset[]
}

/**
 * The canonical serialized Struct document, as persisted. The bytes are
 * produced by the pinned package, so the persisted file is the canonical
 * form and not a re-serialization of the in-memory object.
 */
export function structDocumentJson(document: StructDocument): string {
  return `${JSON.stringify(encodeStructDocument(document), null, 2)}\n`
}

/**
 * The persisted Struct bundle descriptor: the bundle identity plus the asset
 * digests. The asset bytes stay in the render output's asset directory; they
 * are not duplicated into the descriptor.
 */
export function structBundleDescriptor(
  document: StructDocument,
  bundle: VerifiedStructBundle,
): StructBundleDescriptor {
  const assetsById = new Map(document.assets.map((asset) => [asset.id, asset]))
  return {
    bundleVersion: '1.0.0',
    schemaVersion: document.schemaVersion,
    documentSha256: structDocumentSha256(document),
    bundleSha256: structBundleSha256(bundle),
    assets: bundle.assetIds().map((id) => {
      const asset = assetsById.get(id)
      if (!asset)
        throw new Error(`Struct bundle carries an unknown asset id: ${id}`)
      return {
        id,
        sha256: asset.sha256,
        mediaType: asset.mediaType,
        byteLength: bundle.assetBytes(id)?.byteLength ?? 0,
      }
    }),
  }
}

/**
 * Build the Struct variant of the source binding from the digests this
 * invocation actually produced.
 *
 * `documentSha256` is the digest of the canonical document bytes.
 * `bundleSha256` is present only when the bundle wire bytes were produced
 * here, and `semanticReceiptSha256` only when the document's own semantic
 * receipt verifies. Neither is ever faked, and the package pin fields come
 * from the single provenance authority.
 */
export function structCutoverSourceBindingSync(
  document: StructDocument,
  pin: StructPackagePin,
  bundle?: VerifiedStructBundle,
): StructCutoverSourceBinding {
  return structCutoverSourceBindingSchema.parse({
    kind: 'struct-cutover',
    documentSha256: structDocumentSha256(document),
    ...(bundle ? { bundleSha256: structBundleSha256(bundle) } : {}),
    ...(verifyStructReceipt(document)
      ? { semanticReceiptSha256: structSemanticReceiptSha256(document) }
      : {}),
    packageSourceCommit: pin.sourceCommit,
    packageArtifact: pin.artifact,
    packageArtifactSha256: pin.artifactSha256,
    packageIntegrity: pin.integrity,
    packageVersion: pin.packageVersion,
  })
}

/**
 * The asynchronous form of {@link structCutoverSourceBindingSync}, for the
 * callers that already await their provenance.
 */
export async function structCutoverSourceBinding(
  document: StructDocument,
  pin: StructPackagePin,
  bundle?: VerifiedStructBundle,
): Promise<StructCutoverSourceBinding> {
  return structCutoverSourceBindingSync(document, pin, bundle)
}

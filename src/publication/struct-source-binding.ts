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
 * The exact bundle wire bytes of one Struct document, together with the
 * digests that bind a receipt to those bytes.
 *
 * `bytes` are the canonical encoded bundle, produced by the pinned package
 * from a handle this call created, so they are the wire form itself and not
 * a re-serialization of it. `documentSha256` is the app's canonical document
 * digest, which includes the asset bytes; it is deliberately NOT the bundle
 * handle's byte-free `documentSha256`, and the two must never be compared to
 * each other. `semanticReceiptSha256` is the package's own semantic receipt
 * digest.
 */
export type StructBundleWire = {
  /** The exact encoded bundle bytes, to be persisted as `struct-bundle.bin`. */
  bytes: Uint8Array
  /** The SHA-256 of `bytes`; it equals the verified handle's bundle digest. */
  bundleSha256: string
  /** The app's canonical document digest, asset bytes included. */
  documentSha256: string
  /** The package's semantic receipt digest. It is always present. */
  semanticReceiptSha256: string
  /** The persisted bundle descriptor. Its shape is unchanged. */
  descriptor: StructBundleDescriptor
}

/**
 * Produce the bundle wire bytes of one Struct document and the digests that
 * bind a receipt to them.
 *
 * The helper creates and encodes a package bundle handle and returns the
 * exact bytes it encoded; it never reads wire bytes and never uses the
 * package's embedded value verifier. A document whose semantic receipt does
 * not verify is refused: there is no "digest unavailable" downgrade, so a
 * receipt can never be published with a missing semantic digest.
 */
export function structBundleWire(document: StructDocument): StructBundleWire {
  if (!verifyStructReceipt(document))
    throw new Error(
      'Struct bundle wire requires a document whose semantic receipt verifies',
    )
  const bundle = createStructBundleForDocument(document)
  const bytes = encodeStructBundle(bundle)
  const bundleSha256 = createHash('sha256').update(bytes).digest('hex')
  if (bundleSha256 !== bundle.bundleSha256)
    throw new Error(
      'Struct bundle wire digest does not match the package bundle handle',
    )
  const documentSha256 = structDocumentSha256(document)
  const descriptor = structBundleDescriptor(document, bundle)
  if (
    descriptor.bundleSha256 !== bundleSha256 ||
    descriptor.documentSha256 !== documentSha256
  )
    throw new Error(
      'Struct bundle descriptor does not match the bundle wire it describes',
    )
  return {
    bytes,
    bundleSha256,
    documentSha256,
    semanticReceiptSha256: structSemanticReceiptSha256(document),
    descriptor,
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

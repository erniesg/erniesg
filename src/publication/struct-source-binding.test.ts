import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { loadAdapterCase } from '../../tests/fixtures/struct-adapter-parity/cases'
import { encodeStructDocument } from '@erniesg/struct/document'
import { structReceiptDigest } from '@erniesg/struct/receipt'
import { structDigest } from '@erniesg/struct/identity'
import { encodeStructBundle } from '@erniesg/struct/bundle'
import { buildStructDocument } from '../struct-adapters'
import { structCutoverSourceBindingSchema } from './source-binding'
import { readStructPackagePin } from './struct-package-pin'
import {
  createStructBundleForDocument,
  structBundleDescriptor,
  structBundleSha256,
  structCutoverSourceBinding,
  structCutoverSourceBindingSync,
  structDocumentSha256,
  structSemanticReceiptSha256,
} from './struct-source-binding'

// The pinned package refuses to encode a document whose semantic receipt does
// not verify, so the "receipt did not verify" branch of the binding builder
// is unreachable with a real document. The verification decision is therefore
// the only part of the package this file overrides.
const receiptVerification = vi.hoisted(() => ({
  override: undefined as undefined | (() => boolean),
}))

vi.mock('@erniesg/struct/receipt', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@erniesg/struct/receipt')>()
  return {
    ...actual,
    verifyStructReceipt: (
      document: Parameters<typeof actual.verifyStructReceipt>[0],
    ) =>
      receiptVerification.override
        ? receiptVerification.override()
        : actual.verifyStructReceipt(document),
  }
})

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

async function realDocument() {
  return buildStructDocument(await loadAdapterCase('ordinary-pdf'))
}

describe('Struct source binding digests', () => {
  it('derives the document digest from the canonical document bytes', async () => {
    const document = await realDocument()
    const digest = structDocumentSha256(document)
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(digest).toBe(structDigest(encodeStructDocument(document)))
    expect(structDocumentSha256(document)).toBe(digest)
  })

  it('agrees with the package bundle handle about both digests', async () => {
    const document = await realDocument()
    const bundle = createStructBundleForDocument(document)
    expect(structDocumentSha256(document)).toBe(bundle.documentSha256)
    expect(structBundleSha256(bundle)).toBe(bundle.bundleSha256)
    expect(structBundleSha256(bundle)).toBe(sha256(encodeStructBundle(bundle)))
  })

  it('uses the package semantic receipt digest', async () => {
    const document = await realDocument()
    expect(structSemanticReceiptSha256(document)).toBe(
      structReceiptDigest(document),
    )
  })

  it('omits the bundle digest when the bundle bytes were not produced', async () => {
    const document = await realDocument()
    const pin = await readStructPackagePin(repositoryRoot)
    const binding = await structCutoverSourceBinding(document, pin)
    expect('bundleSha256' in binding).toBe(false)
    expect(binding.documentSha256).toBe(structDocumentSha256(document))
  })

  it('carries the bundle digest when the bundle bytes were produced', async () => {
    const document = await realDocument()
    const pin = await readStructPackagePin(repositoryRoot)
    const bundle = createStructBundleForDocument(document)
    const binding = await structCutoverSourceBinding(document, pin, bundle)
    expect(binding.bundleSha256).toBe(structBundleSha256(bundle))
    expect(structCutoverSourceBindingSync(document, pin, bundle)).toEqual(
      binding,
    )
  })

  it('omits the semantic receipt digest when the receipt does not verify', async () => {
    const document = await realDocument()
    const pin = await readStructPackagePin(repositoryRoot)
    receiptVerification.override = () => false
    try {
      const binding = structCutoverSourceBindingSync(document, pin)
      expect('semanticReceiptSha256' in binding).toBe(false)
    } finally {
      receiptVerification.override = undefined
    }
  })

  it('carries the semantic receipt digest when the receipt verifies', async () => {
    const document = await realDocument()
    const pin = await readStructPackagePin(repositoryRoot)
    const binding = structCutoverSourceBindingSync(document, pin)
    expect(binding.semanticReceiptSha256).toBe(
      structSemanticReceiptSha256(document),
    )
  })

  it('derives a different document digest for a different document', async () => {
    const ordinary = await realDocument()
    const structured = buildStructDocument(
      await loadAdapterCase('structured-docx'),
    )
    expect(structDocumentSha256(structured)).not.toBe(
      structDocumentSha256(ordinary),
    )
  })

  it('maps the package pin fields exactly', async () => {
    const document = await realDocument()
    const pin = await readStructPackagePin(repositoryRoot)
    const binding = await structCutoverSourceBinding(document, pin)
    expect(binding.packageSourceCommit).toBe(pin.sourceCommit)
    expect(binding.packageArtifact).toBe(pin.artifact)
    expect(binding.packageArtifactSha256).toBe(pin.artifactSha256)
    expect(binding.packageIntegrity).toBe(pin.integrity)
    expect(binding.packageVersion).toBe(pin.packageVersion)
    expect(binding.kind).toBe('struct-cutover')
    expect(structCutoverSourceBindingSchema.parse(binding)).toEqual(binding)
  })

  it('describes the bundle with the asset digests and no asset bytes', async () => {
    const document = buildStructDocument(
      await loadAdapterCase('structured-docx'),
    )
    const bundle = createStructBundleForDocument(document)
    const descriptor = structBundleDescriptor(document, bundle)
    expect(descriptor.bundleVersion).toBe('1.0.0')
    expect(descriptor.schemaVersion).toBe(document.schemaVersion)
    expect(descriptor.documentSha256).toBe(structDocumentSha256(document))
    expect(descriptor.bundleSha256).toBe(structBundleSha256(bundle))
    expect(descriptor.assets.map((asset) => asset.id)).toEqual(
      document.assets.map((asset) => asset.id),
    )
    expect(
      descriptor.assets.every(
        (asset) => asset.sha256.length === 64 && asset.byteLength > 0,
      ),
    ).toBe(true)
  })
})

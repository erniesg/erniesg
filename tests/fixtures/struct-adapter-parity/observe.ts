import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import { decodeStructDocument as packageDecode } from '@erniesg/struct/document'
import type { DocumentReconstruction } from '../../../src/research/import-types'
import { buildStructDocument } from '../../../src/struct-adapters'
import { encodeStructDocument } from '../../../src/struct/codec'
import { buildStructEpub } from '../../../src/struct/epub'
import { renderPublicationXhtml } from '../../../src/struct/xhtml'

export const sha256 = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex')

const outcome = (fn: () => unknown) => {
  try {
    fn()
    return 'accepted'
  } catch (error) {
    return String(error instanceof Error ? error.message : error)
  }
}

type FrozenBytes = { $bytes: string }

export function encodeReconstruction(reconstruction: DocumentReconstruction) {
  return JSON.stringify(
    reconstruction,
    (_key, value) =>
      value instanceof Uint8Array
        ? ({
            $bytes: Buffer.from(value).toString('base64'),
          } satisfies FrozenBytes)
        : value,
    2,
  )
}

export function decodeReconstruction(text: string): DocumentReconstruction {
  return JSON.parse(text, (_key, value) => {
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as FrozenBytes).$bytes === 'string'
    ) {
      return new Uint8Array(
        Buffer.from((value as FrozenBytes).$bytes, 'base64'),
      )
    }
    return value
  }) as DocumentReconstruction
}

export async function observeAdapterCase(source: DocumentReconstruction) {
  const document = buildStructDocument(source)

  let encoded: ReturnType<typeof encodeStructDocument> | undefined
  const localEncode = outcome(() => {
    encoded = encodeStructDocument(document)
  })

  const decoderInput = encoded ?? document
  const invalidVersion = structuredClone(decoderInput) as any
  invalidVersion.schemaVersion = '9.9.9'
  const invalidReceipt = structuredClone(decoderInput) as any
  invalidReceipt.receipt.generatedSha256 = 'b'.repeat(64)

  const observed: Record<string, unknown> = {
    sourceSha256: source.source.sha256,
    sourceNodeCount: source.paper.nodes.length,
    sourceAssetCount: source.assets.length,
    documentJsonSha256: sha256(JSON.stringify(encoded ?? document)),
    localEncode,
    receiptSha256: document.receipt.generatedSha256,
    conservation: document.receipt.conservation,
    blockIdsInOrder: document.blocks.map(({ id }) => id),
    assetIdsInOrder: document.assets.map(({ id }) => id),
    assets: document.assets.map(({ id, sha256, bytes, href }) => ({
      id,
      sha256,
      byteLength: bytes?.length ?? 0,
      href,
    })),
    relationshipIdsInOrder: document.relationships.map(({ id }) => id),
    diagnostics: document.diagnostics.map(({ severity }) => ({ severity })),
    recovery: document.recovery,
    xhtmlSha256: sha256(renderPublicationXhtml(document)),
  }

  try {
    const epub = await buildStructEpub(document)
    observed.epubSha256 = epub.sha256
    const entries = unzipSync(epub.bytes)
    observed.epubEntries = Object.fromEntries(
      Object.entries(entries)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, bytes]) => [path, sha256(bytes)]),
    )
  } catch (error) {
    observed.epubError = String(error instanceof Error ? error.message : error)
    observed.epubEntries = {}
  }

  observed.packageDecode = outcome(() => packageDecode(decoderInput))
  observed.packageInvalidVersion = outcome(() => packageDecode(invalidVersion))
  observed.packageInvalidReceipt = outcome(() => packageDecode(invalidReceipt))

  return observed
}

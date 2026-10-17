import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { decodeStructDocument as packageDecode } from '@erniesg/struct/document'
import { buildStructDocument } from '../src/struct-adapters'
import { encodeStructDocument } from '../src/struct/codec'
import { buildStructEpub } from '../src/struct/epub'
import { renderPublicationXhtml } from '../src/struct/xhtml'
import {
  adapterCases,
  reconstructAdapterCase,
} from './fixtures/struct-adapter-parity/cases'

const frozen = JSON.parse(
  await readFile(
    new URL('./fixtures/struct-adapter-parity/expected.json', import.meta.url),
    'utf8',
  ),
)
const sha = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex')
const outcome = (fn: () => unknown) => {
  try {
    fn()
    return 'accepted'
  } catch (error) {
    return String(error instanceof Error ? error.message : error)
  }
}

describe('frozen app reconstruction adapter parity at 74d483a', () => {
  it.each(adapterCases)('preserves the %s source and output', async (name) => {
    const source = await reconstructAdapterCase(name)
    const document = buildStructDocument(source)
    const expected = frozen[name]
    expect(source.source.sha256).toBe(expected.sourceSha256)
    expect(source.paper.nodes.length).toBe(expected.sourceNodeCount)
    expect(source.assets.length).toBe(expected.sourceAssetCount)

    let encoded: ReturnType<typeof encodeStructDocument> | undefined
    const localEncode = outcome(() => {
      encoded = encodeStructDocument(document)
    })
    expect(localEncode).toBe(expected.localEncode)
    expect(sha(JSON.stringify(encoded ?? document))).toBe(
      expected.documentJsonSha256,
    )
    expect(document.receipt.generatedSha256).toBe(expected.receiptSha256)
    expect(document.receipt.conservation).toEqual(expected.conservation)
    expect(document.blocks.map(({ id }) => id)).toEqual(
      expected.blockIdsInOrder,
    )
    expect(document.assets.map(({ id }) => id)).toEqual(
      expected.assetIdsInOrder,
    )
    expect(
      document.assets.map(({ id, sha256, bytes, href }) => ({
        id,
        sha256,
        byteLength: bytes?.length ?? 0,
        href,
      })),
    ).toEqual(expected.assets)
    expect(document.relationships.map(({ id }) => id)).toEqual(
      expected.relationshipIdsInOrder,
    )
    expect(document.diagnostics.map(({ severity }) => ({ severity }))).toEqual(
      expected.diagnostics,
    )
    expect(document.recovery).toEqual(expected.recovery)
    expect(sha(renderPublicationXhtml(document))).toBe(expected.xhtmlSha256)

    const decoderInput = encoded ?? document
    expect(outcome(() => packageDecode(decoderInput))).toBe(
      expected.packageDecode,
    )
    const invalidVersion = structuredClone(decoderInput) as any
    invalidVersion.schemaVersion = '9.9.9'
    expect(outcome(() => packageDecode(invalidVersion))).toBe(
      expected.packageInvalidVersion,
    )
    const invalidReceipt = structuredClone(decoderInput) as any
    invalidReceipt.receipt.generatedSha256 = 'b'.repeat(64)
    expect(outcome(() => packageDecode(invalidReceipt))).toBe(
      expected.packageInvalidReceipt,
    )

    try {
      const epub = await buildStructEpub(document)
      expect(expected.epubError).toBeUndefined()
      expect(epub.sha256).toBe(expected.epubSha256)
      const entries = unzipSync(epub.bytes)
      expect(
        Object.fromEntries(
          Object.entries(entries)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([path, bytes]) => [path, sha(bytes)]),
        ),
      ).toEqual(expected.epubEntries)
    } catch (error) {
      expect(String(error instanceof Error ? error.message : error)).toBe(
        expected.epubError,
      )
    }
  })
})

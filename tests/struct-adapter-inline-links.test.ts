import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { buildStructDocument } from '../src/struct-adapters'
import { decodeReconstruction } from './fixtures/struct-adapter-parity/observe'
import { encodeStructDocument } from '../src/struct/codec'
import { decodeStructDocument as packageDecode } from '@erniesg/struct/document'

describe('inline hyperlink relationship accounting', () => {
  it('counts every emitted hyperlink and binds inline runs to it', async () => {
    const text = await readFile(
      new URL(
        './fixtures/struct-adapter-parity/reconstructions/structured-docx.json',
        import.meta.url,
      ),
      'utf8',
    )
    const document = buildStructDocument(decodeReconstruction(text))
    const conservation = document.receipt.conservation

    expect(conservation.accountedSourceRelationshipCount).toBe(
      document.relationships.length,
    )
    expect(conservation.sourceRelationshipCount).toBe(
      document.relationships.length,
    )

    const relationshipIds = new Set(document.relationships.map(({ id }) => id))
    for (const block of document.blocks) {
      for (const inline of block.inline) {
        if (!inline.relationshipId) continue
        expect(relationshipIds.has(inline.relationshipId)).toBe(true)
      }
    }

    expect(() => encodeStructDocument(document)).not.toThrow()
    expect(() => packageDecode(encodeStructDocument(document))).not.toThrow()
  })
})

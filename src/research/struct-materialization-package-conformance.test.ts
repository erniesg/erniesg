import { describe, expect, it } from 'vitest'
import {
  decodeStructDocument as packageDecodeStructDocument,
  encodeStructDocument as packageEncodeStructDocument,
} from '@erniesg/struct/document'
import {
  decodeStructDocument as localDecodeStructDocument,
  encodeStructDocument as localEncodeStructDocument,
} from '../struct/codec'
import { buildStructDocument } from '../struct-adapters'
import {
  adapterCases,
  loadAdapterCase,
} from '../../tests/fixtures/struct-adapter-parity/cases'

/**
 * The pinned Struct package is the contract. Every materialization path the
 * app owns must emit a document the package's own validator accepts, not only
 * the app's permissive local renderer.
 *
 * The reconstruction path already satisfies the STRUCT receipt invariant
 * (`receipt.textCharacterCount == sum(block.text.length) ==
 * conservation.sourceTextCharacterCount`) because it measures the source side
 * on the source node texts it publishes. This test proves that against the
 * real frozen fixtures, so a later change to that path cannot silently
 * regress the package conformance.
 */
describe('app materialization paths satisfy the pinned package validator', () => {
  it.each(adapterCases)(
    'accepts the frozen %s reconstruction document',
    async (name) => {
      const reconstruction = await loadAdapterCase(name)
      const document = buildStructDocument(reconstruction)
      const blockTextSum = document.blocks.reduce(
        (total, block) => total + block.text.length,
        0,
      )

      expect(document.receipt.textCharacterCount).toBe(blockTextSum)
      expect(document.receipt.conservation.sourceTextCharacterCount).toBe(
        blockTextSum,
      )
      expect(document.receipt.conservation.structTextCharacterCount).toBe(
        blockTextSum,
      )
      expect(() => packageDecodeStructDocument(document)).not.toThrow()
      expect(() => packageEncodeStructDocument(document)).not.toThrow()
      expect(() => localDecodeStructDocument(document)).not.toThrow()
      expect(() => localEncodeStructDocument(document)).not.toThrow()
    },
  )
})

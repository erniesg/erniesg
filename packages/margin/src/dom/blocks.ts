/**
 * The anchorable blocks of a rendered document.
 *
 * A block is whatever the renderer marked as addressable. This package does
 * not know what a renderer is: it takes a CSS selector and reads three things
 * off each match — an id, a struct id, and a digest — from attributes that are
 * named here and nowhere else. A host whose markup differs passes different
 * attribute names rather than a different package.
 */
import type { AnchorableNode } from '../anchor'
import {
  indexBlockText,
  type BlockTextIndex,
  type IndexOptions,
} from './text-index'

export type BlockAttributes = {
  /** Elements that are addressable blocks. */
  blockSelector?: string
  /** Attribute holding the struct id; falls back to the element's `id`. */
  structIdAttribute?: string
  /** Attribute holding the block digest, if the renderer emits one. */
  structDigestAttribute?: string
}

export type BlockOptions = BlockAttributes & IndexOptions

export const DEFAULT_BLOCK_OPTIONS = {
  blockSelector: '[data-block-kind]',
  structIdAttribute: 'data-struct-id',
  structDigestAttribute: 'data-block-digest',
} as const

export type AnchorableBlock = AnchorableNode & {
  id: string
  structId: string
  structDigest?: string
  text: string
  element: Element
  index: BlockTextIndex
}

export function readAnchorableBlocks(
  root: ParentNode,
  options: BlockOptions = {},
): AnchorableBlock[] {
  const selector = options.blockSelector ?? DEFAULT_BLOCK_OPTIONS.blockSelector
  const structIdAttribute =
    options.structIdAttribute ?? DEFAULT_BLOCK_OPTIONS.structIdAttribute
  const digestAttribute =
    options.structDigestAttribute ??
    DEFAULT_BLOCK_OPTIONS.structDigestAttribute

  const elements = Array.from(root.querySelectorAll(selector))
  // Blocks are siblings in every renderer this targets, but a host could nest
  // them. Keeping only the outermost match means a character belongs to
  // exactly one block and the offsets in an anchor stay unambiguous.
  const outermost = elements.filter(
    (element) =>
      !elements.some((other) => other !== element && other.contains(element)),
  )

  return outermost.flatMap((element) => {
    const structId = element.getAttribute(structIdAttribute) ?? element.id
    const id = element.id || structId
    if (!id || !structId) return []
    const index = indexBlockText(element, options)
    const digest = element.getAttribute(digestAttribute)
    return [
      {
        id,
        structId,
        ...(digest ? { structDigest: digest } : {}),
        text: index.text,
        element,
        index,
      },
    ]
  })
}

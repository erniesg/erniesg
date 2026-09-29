/**
 * Stable per-block ids for prose rendered from Markdown.
 *
 * Margin anchors an annotation to a block's id first and falls back to quote
 * and context only when that fails (`packages/margin/src/anchor.ts`), so a
 * block that has no id, or one that changes between two builds of the same
 * source, costs every annotation on it its best selector. The book gets its
 * ids from `render.py`; this is the same contract for the blog.
 *
 * An id is derived from the block's own text, not from its position: adding a
 * paragraph above does not renumber the ones below it. Identical blocks are
 * told apart by the order they occur in. Headings keep the slug they already
 * have — the table of contents links to it.
 *
 * Every addressable block is marked with `data-block-kind`, which is what
 * margin's block reader selects on. Only the outermost block is marked, so a
 * character belongs to exactly one block.
 */
import type { Element, Root, RootContent } from 'hast'
import { createHash } from 'node:crypto'

type HastNode = Root | RootContent

const BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'pre',
  'table',
  'dt',
  'dd',
])

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(textOf).join('') : ''
}

export function blockDigest(text: string): string {
  return createHash('sha256')
    .update(text.replace(/\s+/gu, ' ').trim())
    .digest('hex')
    .slice(0, 12)
}

export default function rehypeBlockIds() {
  return (tree: Root) => {
    const seen = new Map<string, number>()

    const visit = (node: Root | Element) => {
      for (const child of node.children) {
        if (child.type !== 'element') continue
        if (BLOCK_TAGS.has(child.tagName)) {
          const properties = child.properties
          const digest = blockDigest(textOf(child))
          const kind = child.tagName
          if (typeof properties.id !== 'string' || properties.id === '') {
            const base = `block-${kind}-${digest}`
            const count = (seen.get(base) ?? 0) + 1
            seen.set(base, count)
            properties.id = count === 1 ? base : `${base}-${count}`
          }
          properties.dataBlockKind = kind
          properties.dataBlockDigest = digest
          // Nested blocks belong to this one; do not mark them again.
          continue
        }
        visit(child)
      }
    }

    visit(tree)
  }
}

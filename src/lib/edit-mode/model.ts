/**
 * Edit mode's document model, over the prose schema (issue 059).
 *
 * The editor turns what the reader typed back into schema nodes. Text it
 * rebuilds has lost its source spelling (escapes, `_` versus `*`), so a block
 * whose meaning did not change keeps the node it was parsed as: that is what
 * makes an untouched paragraph write back byte for byte, and a one-word edit a
 * one-word patch rather than a rewrite of every escape around it.
 */
import type {
  Block,
  EditableBlock,
  Inline,
  ListBlock,
  ListItem,
  ProseDoc,
} from '../../annotations/prose-schema'

/** What a run of inline nodes means, with its source spelling set aside. */
export function inlineSignature(nodes: readonly Inline[]): string {
  const walk = (list: readonly Inline[]): unknown[] =>
    list.map((node) => {
      switch (node.type) {
        case 'text':
        case 'code':
          return [node.type, node.text]
        case 'em':
        case 'strong':
          return [node.type, walk(node.content)]
        case 'link':
          return ['link', node.href, node.title ?? '', walk(node.content)]
      }
    })
  // Adjacent text runs are one run to a reader.
  const merged: Inline[] = []
  for (const node of nodes) {
    const last = merged[merged.length - 1]
    if (node.type === 'text' && last?.type === 'text') {
      merged[merged.length - 1] = { type: 'text', text: last.text + node.text }
    } else {
      merged.push(node)
    }
  }
  return JSON.stringify(walk(merged))
}

/** The plain text a reader sees for a run of inline nodes. */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => (node.type === 'text' || node.type === 'code' ? node.text : inlineText(node.content)))
    .join('')
}

/** A block's plain text; a locked block has none a reader can edit. */
export function blockText(block: Block): string {
  if (block.type === 'locked') return ''
  if (block.type === 'list') return block.items.map((item) => inlineText(item.content)).join('\n')
  return inlineText(block.content)
}

/**
 * The block to store for an edit: the original when the edit means the same
 * thing, otherwise the original's shape (level, prefix, spacing) with the new
 * content.
 */
export function withContent(block: EditableBlock, content: Inline[]): EditableBlock {
  if (block.type === 'list') throw new Error('a list is edited item by item')
  if (inlineSignature(content) === inlineSignature(block.content)) return block
  return { ...block, content }
}

/** A list whose items were edited: unchanged items keep their spelling. */
export function withItems(block: ListBlock, contents: Inline[][]): ListBlock | null {
  // Pair each edited item with the item it came from before dropping emptied
  // ones, so a survivor keeps its own marker and indent, never a neighbour's.
  const kept = contents
    .map((content, index) => ({ content, original: block.items[index] ?? block.items[block.items.length - 1] }))
    .filter(({ content }) => inlineText(content).trim().length > 0)
  if (kept.length === 0) return null
  const items: ListItem[] = kept.map(({ content, original }) =>
    inlineSignature(content) === inlineSignature(original.content) ? original : { ...original, content },
  )
  const same =
    items.length === block.items.length && items.every((item, index) => item === block.items[index])
  return same ? block : { ...block, items }
}

/** Replace the block at `index` with `next` (none: delete it). */
export function replaceBlock(doc: ProseDoc, index: number, next: Block[]): ProseDoc {
  const blocks = doc.blocks.slice()
  const [removed] = blocks.splice(index, 1, ...next)
  // Deleting the last block would take the file's final newline with it.
  if (next.length === 0 && index === blocks.length && index > 0) {
    const previous = blocks[index - 1]
    blocks[index - 1] = { ...previous, after: removed.after }
  }
  return { ...doc, blocks }
}

/** Split a paragraph into two at a caret, given both halves' content. */
export function splitAt(
  doc: ProseDoc,
  index: number,
  left: Inline[],
  right: Inline[],
): ProseDoc {
  const block = doc.blocks[index]
  if (block.type !== 'paragraph') throw new Error('only a paragraph splits')
  return replaceBlock(doc, index, [
    { type: 'paragraph', content: left, after: '\n\n' },
    { type: 'paragraph', content: right, after: block.after },
  ])
}

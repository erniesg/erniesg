import { describe, expect, it } from 'vitest'

import { proposeHunks } from '../../annotations/criticmarkup'
import {
  parseMarkdown,
  serializeMarkdown,
  type EditableBlock,
  type ParagraphBlock,
} from '../../annotations/prose-schema'
import { inlineSignature, replaceBlock, splitAt, withContent, withItems } from './model'

const SOURCE = `+++
id = "x"
+++

# A title

A *first* paragraph with an escaped \\* star
that wraps onto a second line.

A second paragraph.

- one
- two
`

function paragraph(doc = parseMarkdown(SOURCE), index = 2): ParagraphBlock {
  const block = doc.blocks[index]
  if (block.type !== 'paragraph') throw new Error(`block ${index} is ${block.type}`)
  return block
}

describe('withContent', () => {
  it('keeps the parsed block, source spelling and all, when the meaning is unchanged', () => {
    const doc = parseMarkdown(SOURCE)
    const block = paragraph(doc)
    // What an editor rebuilds from the DOM: same text and marks, no `raw`.
    const rebuilt: ParagraphBlock['content'] = [
      { type: 'text', text: 'A ' },
      { type: 'em', marker: '_', content: [{ type: 'text', text: 'first' }] },
      { type: 'text', text: ' paragraph with an escaped * star\nthat wraps onto a second line.' },
    ]
    expect(inlineSignature(rebuilt)).toBe(inlineSignature(block.content))
    expect(withContent(block, rebuilt)).toBe(block)
    expect(serializeMarkdown(doc)).toBe(SOURCE)
  })

  it('makes a one-word edit a patch on that one line', () => {
    const doc = parseMarkdown(SOURCE)
    const index = doc.blocks.findIndex((b) => b.type === 'paragraph' && b.content.some((n) => n.type === 'text' && n.text.includes('second paragraph')))
    const block = paragraph(doc, index)
    const edited = replaceBlock(doc, index, [
      withContent(block, [{ type: 'text', text: 'A third paragraph.' }]),
    ])
    const hunks = proposeHunks(SOURCE, serializeMarkdown(edited))
    expect(hunks).toHaveLength(1)
    expect(hunks[0].criticMarkup).toContain('{~~second~>third~~}')
    expect(hunks[0].criticMarkup).not.toMatch(/\{~~.*first/)
  })
})

describe('withItems', () => {
  it('keeps untouched items and drops an emptied one', () => {
    const doc = parseMarkdown(SOURCE)
    const index = doc.blocks.findIndex((b) => b.type === 'list')
    const list = doc.blocks[index]
    if (list.type !== 'list') throw new Error('no list')
    const same = withItems(list, list.items.map((item) => item.content))
    expect(same).toBe(list)
    const shorter = withItems(list, [list.items[0].content, [{ type: 'text', text: '  ' }]])
    expect(shorter?.items).toHaveLength(1)
    expect(withItems(list, [[{ type: 'text', text: '' }]])).toBeNull()
  })
})

describe('splitAt and replaceBlock', () => {
  it('splits a paragraph and deletes one, keeping the file’s final newline', () => {
    const doc = parseMarkdown(SOURCE)
    const index = doc.blocks.length - 1
    const split = splitAt(doc, 2, [{ type: 'text', text: 'A' }], [{ type: 'text', text: 'rest' }])
    expect(serializeMarkdown(split)).toContain('A\n\nrest\n\nA second paragraph.')
    const withoutList = replaceBlock(doc, index, [])
    expect(serializeMarkdown(withoutList).endsWith('A second paragraph.\n')).toBe(true)
  })
})

describe('withItems keeps each item its own marker', () => {
  it('when an earlier item of a numbered list is emptied', () => {
    const doc = parseMarkdown('1. one\n2. two\n3. three\n')
    const list = doc.blocks[0]
    if (list.type !== 'list') throw new Error('no list')
    const edited = withItems(list, [[{ type: 'text', text: '' }], list.items[1].content, list.items[2].content])
    expect(edited?.items.map((item) => item.marker)).toEqual(['2. ', '3. '])
    expect(edited?.items[0]).toBe(list.items[1])
  })
})

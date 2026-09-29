import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  deleteBlock,
  deleteListItem,
  EditSession,
  isEditable,
  joinParagraphs,
  parseMarkdown,
  replaceText,
  retypeBlock,
  schemaViolations,
  serializeBlock,
  serializeMarkdown,
  splitParagraph,
  type ProseDoc,
} from './prose-schema'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..')

/** Every node of the book, as a repo-relative source path. */
function bookNodePaths(): string[] {
  const chapters = readdirSync(path.join(ROOT, 'books/chapters'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `books/chapters/${name}`)
  const challenges = readdirSync(path.join(ROOT, 'books/challenges'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `books/challenges/${entry.name}/challenge.md`)
  return [...chapters, ...challenges].sort()
}

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8')
}

function blockIndex(doc: ProseDoc, startsWith: string): number {
  const index = doc.blocks.findIndex(
    (block) => isEditable(block) && serializeBlock(block).startsWith(startsWith),
  )
  expect(index, `an editable block starting "${startsWith}"`).toBeGreaterThan(-1)
  return index
}

const NODES = bookNodePaths()

describe('every node round-trips through the editor schema', () => {
  it('finds all 46 nodes', () => {
    expect(NODES).toHaveLength(46)
  })

  it.each(NODES)('%s is byte-identical with no edit applied', (node) => {
    const source = read(node)
    const doc = parseMarkdown(source)
    expect(serializeMarkdown(doc)).toBe(source)
    expect(schemaViolations(doc)).toEqual([])
  })

  it.each(NODES)('%s offers no :::, fence or front matter for editing', (node) => {
    const doc = parseMarkdown(read(node))
    expect(doc.blocks[0]).toMatchObject({ type: 'locked', reason: 'front_matter' })
    for (const block of doc.blocks.filter(isEditable)) {
      expect(serializeBlock(block)).not.toMatch(/^\s*(?::::|```|~~~|\+\+\+)/m)
    }
  })

  it.each(NODES.filter((node) => /\/ch\d\d-/.test(node)))(
    '%s has editable prose',
    (node) => {
      const doc = parseMarkdown(read(node))
      expect(doc.blocks.filter((block) => block.type === 'paragraph').length)
        .toBeGreaterThan(0)
    },
  )
})

describe('the schema is the enforcement', () => {
  const doc = parseMarkdown(read('books/chapters/ch03-lists.md'))

  it('locks :::, code fences and front matter against every edit', () => {
    const lockedIndexes = doc.blocks
      .map((block, index) => (block.type === 'locked' ? index : -1))
      .filter((index) => index >= 0)
    const reasons = lockedIndexes.map(
      (index) => (doc.blocks[index] as { reason: string }).reason,
    )
    expect(reasons).toContain('front_matter')
    expect(reasons).toContain('directive')
    expect(reasons).toContain('code')
    for (const index of lockedIndexes) {
      expect(() => replaceText(doc, index, 'tins', 'cans')).toThrow(/locked/)
      expect(() => deleteBlock(doc, index)).toThrow(/locked/)
      expect(() => retypeBlock(doc, index, 'gone')).toThrow(/locked/)
    }
  })

  it('writes typed Markdown syntax as characters, never as structure', () => {
    const typed = '::: *not em* [x](y) `c` # h\n- not a list\n1. nor this'
    const start = parseMarkdown('Hello world.\n')
    const retyped = serializeMarkdown(retypeBlock(start, 0, typed))
    expect(retyped.startsWith('\\:::')).toBe(true)

    const reread = parseMarkdown(retyped)
    expect(reread.blocks).toHaveLength(1)
    const [block] = reread.blocks
    expect(block.type).toBe('paragraph')
    if (block.type !== 'paragraph') return
    expect(block.content).toEqual([
      expect.objectContaining({ type: 'text', text: typed }),
    ])
  })

  it('rejects nodes and attributes outside the allowlist', () => {
    expect(
      schemaViolations([
        { type: 'paragraph', content: [], after: '', style: 'color: red' },
        { type: 'table', rows: [] },
        {
          type: 'paragraph',
          after: '',
          content: [{ type: 'image', src: 'x.png' }],
        },
      ]),
    ).toHaveLength(3)
  })
})

describe('ordinary editing', () => {
  const source = read('books/chapters/ch03-lists.md')
  const base = parseMarkdown(source)

  it('replaces one word and leaves the rest of the source alone', () => {
    const index = blockIndex(base, 'A food bank')
    const edited = serializeMarkdown(replaceText(base, index, 'volunteer', 'helper'))
    expect(edited).toBe(source.replace('A volunteer walks', 'A helper walks'))
  })

  it('deletes a paragraph, joins and splits paragraphs, and deletes a list item', () => {
    const nine = blockIndex(base, 'Nine things in a row')
    expect(serializeMarkdown(deleteBlock(base, nine))).not.toContain(
      'Nine things in a row',
    )

    const food = blockIndex(base, 'A food bank')
    const joined = serializeMarkdown(joinParagraphs(base, food))
    expect(joined).toBe(
      source.replace('as she goes.\n\nShe pulls', 'as she goes.\nShe pulls'),
    )

    const split = serializeMarkdown(splitParagraph(base, food, 'A volunteer'))
    expect(split).toBe(
      source.replace('past their date. A volunteer', 'past their date.\n\nA volunteer'),
    )

    const list = parseMarkdown('Intro.\n\n- one\n- two\n- three\n')
    expect(serializeMarkdown(deleteListItem(list, 1, 1))).toBe(
      'Intro.\n\n- one\n- three\n',
    )
  })

  it('undoes and redoes inside the session, byte for byte', () => {
    const session = new EditSession(base)
    session.apply((doc) => deleteBlock(doc, blockIndex(doc, 'Nine things')))
    const deleted = serializeMarkdown(session.doc)
    session.apply((doc) => joinParagraphs(doc, blockIndex(doc, 'A food bank')))
    expect(session.canUndo).toBe(true)

    session.undo()
    expect(serializeMarkdown(session.doc)).toBe(deleted)
    session.undo()
    expect(serializeMarkdown(session.doc)).toBe(source)
    expect(session.canUndo).toBe(false)

    session.redo()
    expect(serializeMarkdown(session.doc)).toBe(deleted)
  })
})

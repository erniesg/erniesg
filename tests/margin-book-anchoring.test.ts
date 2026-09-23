/**
 * Anchoring against the book as `render.py` actually emits it.
 *
 * The package's own tests work on synthetic nodes, which is the right place to
 * pin the selector chain. This file exists because the thing that breaks
 * anchoring in practice is not the chain — it is the markup. So every fixture
 * here is real renderer output: the block ids, the digests and the text are
 * whatever `render_node` produced, and the edits are applied to the source and
 * re-rendered rather than applied to a string.
 *
 * Parts III-IX of the book are still to be written. Every one of those commits
 * is one of these edits.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'parse5'
import { describe, expect, it } from 'vitest'

import {
  createSemanticTextAnchor,
  resolveTextAnchor,
  withStructSelector,
  type AnchorableNode,
} from '../packages/margin/src/anchor'
import { resolveAnchorInDocument } from '../packages/margin/src/document'
import { NON_ANNOTATABLE_SELECTOR } from '../packages/margin/src/dom/text-index'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const PYTHON = process.env.CHALLENGES_PYTHON ?? 'python3'
const SLOW = { timeout: 120_000 }

/** One node through the renderer, with nothing between it and the assertion. */
const RENDER_BODY = `
import sys
sys.path.insert(0, "challenges/tools")
from render import render_node
sys.stdout.write(
    render_node(
        {"id": "anchoring", "title": "Anchoring", "kind": "prose", "body": sys.stdin.read()},
        "web",
    )
)
`

const RENDER_BOOK_NODE = `
import sys
sys.path.insert(0, "challenges/tools")
from render import load_book, render_node
_, order = load_book()
node = next(n for n in order if n["id"] == sys.argv[1])
sys.stdout.write(render_node(node, "web", runnable=True, reveal="reader"))
`

function python(source: string, args: string[] = [], input = '') {
  return execFileSync(PYTHON, ['-c', source, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    maxBuffer: 64 * 1024 * 1024,
  })
}

type Parse5Node = {
  nodeName: string
  tagName?: string
  value?: string
  attrs?: { name: string; value: string }[]
  childNodes?: Parse5Node[]
}

/**
 * The same reading rule the browser layer uses, over a parse5 tree.
 *
 * Text inside a generated figure is excluded from the anchorable string. The
 * browser expresses that as a CSS selector; here it is the tag list that
 * selector names, which is why the constant is imported rather than retyped.
 */
const SKIPPED_TAGS = new Set(
  NON_ANNOTATABLE_SELECTOR.split(',')
    .map((part) => part.trim())
    .filter((part) => /^[a-z]+$/u.test(part)),
)

function attr(node: Parse5Node, name: string) {
  return node.attrs?.find((entry) => entry.name === name)?.value
}

function textOf(node: Parse5Node): string {
  if (node.nodeName === '#text') return node.value ?? ''
  if (node.tagName && SKIPPED_TAGS.has(node.tagName)) return ''
  if (attr(node, 'data-margin-annotatable') === 'false') return ''
  return (node.childNodes ?? []).map(textOf).join('')
}

/** Every addressable block in a fragment of rendered book HTML. */
function blocksFromHtml(html: string): AnchorableNode[] {
  const blocks: AnchorableNode[] = []
  const visit = (node: Parse5Node) => {
    const kind = attr(node, 'data-block-kind')
    const id = attr(node, 'id')
    if (kind && id) {
      blocks.push({
        id,
        type: kind,
        text: textOf(node),
        structId: id,
        structDigest: attr(node, 'data-block-digest'),
      })
      return
    }
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(parse(html) as unknown as Parse5Node)
  return blocks
}

function render(body: string) {
  return blocksFromHtml(python(RENDER_BODY, [], body))
}

function prose(blocks: AnchorableNode[], ordinal: number) {
  const block = blocks.find((entry) => entry.id === `block-anchoring-prose-${ordinal}`)
  if (!block) throw new Error(`render.py emitted no prose block ${ordinal}`)
  return block
}

const FIRST =
  'A page is a rendition, not a document. Once meaning becomes coordinates, every new screen or sheet becomes a repair job.'
const SECOND =
  'The renderer owns geometry. The document owns meaning, and the two meet only at the moment of composition.'
const QUOTE = 'Once meaning becomes coordinates'

function book(first: string, second: string) {
  return `:::prose\n${first}\n:::\n\n:::prose\n${second}\n:::\n`
}

const original = render(book(FIRST, SECOND))
const source = prose(original, 1)
const anchor = withStructSelector(
  createSemanticTextAnchor(source.id, source.text ?? '', QUOTE),
  source.structDigest
    ? { id: source.structId!, digest: source.structDigest }
    : { id: source.structId! },
)

describe('the blocks render.py emits', () => {
  it('carries a stable id and a content digest on every block', () => {
    expect(original.length).toBeGreaterThanOrEqual(3)
    expect(original.map((block) => block.id)).toContain('block-anchoring-title-1')
    for (const block of original) {
      expect(block.structDigest, `${block.id} has no digest`).toMatch(
        /^[0-9a-f]{12}$/u,
      )
    }
    expect(source.text).toContain(QUOTE)
  })

  it('renders the same ids and digests on an unchanged source', () => {
    const again = render(book(FIRST, SECOND))

    expect(again.map((block) => [block.id, block.structDigest])).toEqual(
      original.map((block) => [block.id, block.structDigest]),
    )
    expect(resolveTextAnchor(anchor, again)).toMatchObject({
      status: 'resolved',
      matchedBy: 'struct-id',
    })
  })

  it('anchors into a real chapter of the book', SLOW, () => {
    const chapter = blocksFromHtml(python(RENDER_BOOK_NODE, ['ch12-hash-maps']))
    const paragraph = chapter.find(
      (block) => block.type === 'prose' && (block.text ?? '').length > 200,
    )
    if (!paragraph) throw new Error('ch12-hash-maps has no prose block')

    const words = (paragraph.text ?? '').slice(40, 120)
    const chapterAnchor = withStructSelector(
      createSemanticTextAnchor(paragraph.id, paragraph.text ?? '', words),
      { id: paragraph.structId!, digest: paragraph.structDigest! },
    )

    expect(resolveAnchorInDocument(chapterAnchor, chapter)).toMatchObject({
      status: 'anchored',
      nodeId: paragraph.id,
      matchedBy: 'struct-id',
    })
  })
})

describe('re-anchoring across edits to the book source', () => {
  it('survives text inserted above the anchor', () => {
    const edited = render(book(`A new opening sentence. ${FIRST}`, SECOND))

    expect(resolveAnchorInDocument(anchor, edited)).toMatchObject({
      status: 'anchored',
      nodeId: source.id,
      matchedBy: 'quote-and-context',
    })
  })

  it('survives the containing paragraph being reworded around it', () => {
    const reworded = FIRST.replace(
      'A page is a rendition, not a document.',
      'A page is one rendition among several, and never the document.',
    )
    const edited = render(book(reworded, SECOND))

    const placement = resolveAnchorInDocument(anchor, edited)
    expect(placement.status).toBe('anchored')
    if (placement.status !== 'anchored') return
    expect(placement.nodeId).toBe(source.id)
    expect(prose(edited, 1).text!.slice(placement.start, placement.end)).toBe(
      QUOTE,
    )
  })

  it('follows its own words into a different block', () => {
    const edited = render(
      book('The opening paragraph says something else now.', `${SECOND} ${FIRST}`),
    )

    expect(resolveAnchorInDocument(anchor, edited)).toMatchObject({
      status: 'anchored',
      nodeId: 'block-anchoring-prose-2',
      matchedBy: 'relocated-quote',
      movedFromNodeId: source.id,
    })
  })

  it('picks the right occurrence when the quote appears twice', () => {
    // Offsets drift and the quote is no longer unique, so the stored prefix
    // and suffix are the only thing left that can tell the two apart.
    const edited = render(
      book(
        `Preface. ${FIRST} Then, differently: ${QUOTE} is said again here.`,
        SECOND,
      ),
    )
    const block = prose(edited, 1)

    const placement = resolveAnchorInDocument(anchor, edited)
    expect(placement).toMatchObject({
      status: 'anchored',
      nodeId: source.id,
      matchedBy: 'quote-and-context',
    })
    if (placement.status !== 'anchored') return
    expect(placement.start).toBe(block.text!.indexOf(QUOTE))
    expect(block.text!.indexOf(QUOTE, placement.start + 1)).toBeGreaterThan(
      placement.start,
    )
  })

  it('orphans when the anchored text is deleted outright', () => {
    const edited = render(
      book('A page is a rendition, not a document.', SECOND),
    )

    expect(resolveAnchorInDocument(anchor, edited)).toMatchObject({
      status: 'orphaned',
      reason: 'quote-not-found',
      quote: QUOTE,
    })
  })

  it('orphans when the whole block is deleted', () => {
    // Block ids are positional, so deleting the *last* block is the edit that
    // makes an id stop existing rather than start holding something else.
    const tail = prose(original, 2)
    const tailQuote = 'the moment of composition'
    const tailAnchor = withStructSelector(
      createSemanticTextAnchor(tail.id, tail.text ?? '', tailQuote),
      { id: tail.structId!, digest: tail.structDigest! },
    )
    const edited = render(`:::prose\n${FIRST}\n:::\n`)

    expect(edited.map((block) => block.id)).not.toContain(tail.id)
    expect(resolveAnchorInDocument(tailAnchor, edited)).toMatchObject({
      status: 'orphaned',
      reason: 'missing-node',
      quote: tailQuote,
    })
  })
})

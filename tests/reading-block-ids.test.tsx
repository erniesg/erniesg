/**
 * Stable per-block ids on the two surfaces that are not the book.
 *
 * The book's ids come from `render.py` and are pinned by
 * `margin-book-anchoring.test.ts`. A blog entry gets its ids from
 * `rehype-block-ids` and a paper from its authored node ids. For both, the
 * same source rendered twice has to produce the same ids, and an anchor made
 * against the first rendering has to re-resolve against the second by its
 * struct id — otherwise every annotation on a post or a paper would fall back
 * to quote matching on every build.
 */
import type { Root } from 'hast'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'parse5'
import { renderToStaticMarkup } from 'react-dom/server'
import rehypeStringify from 'rehype-stringify'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'

import {
  createSemanticTextAnchorFromRange,
  withStructSelector,
  type AnchorableNode,
} from '../packages/margin/src/anchor'
import { resolveAnchorInDocument } from '../packages/margin/src/document'
import { NON_ANNOTATABLE_SELECTOR } from '../packages/margin/src/dom/text-index'
import ResearchStudio from '../src/components/research/ResearchStudio'
import rehypeBlockIds from '../src/lib/rehype-block-ids'
import { getPaper } from '../src/research/papers'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..')

type Parse5Node = {
  nodeName: string
  tagName?: string
  value?: string
  attrs?: { name: string; value: string }[]
  childNodes?: Parse5Node[]
}

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

/** The outermost `[data-block-kind]` elements, read as margin reads them. */
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
        structId: attr(node, 'data-struct-id') ?? id,
        structDigest: attr(node, 'data-block-digest'),
      })
      return
    }
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(parse(html) as unknown as Parse5Node)
  return blocks
}

/** Anchors a span in the middle of the longest block, then re-resolves it. */
function expectAnchorSurvives(
  first: AnchorableNode[],
  second: AnchorableNode[],
) {
  const block = [...first].sort(
    (a, b) => (b.text ?? '').length - (a.text ?? '').length,
  )[0]
  const text = block.text ?? ''
  expect(text.length).toBeGreaterThan(40)
  const anchor = withStructSelector(
    createSemanticTextAnchorFromRange(block.id, text, 10, 40),
    block.structDigest
      ? { id: block.structId!, digest: block.structDigest }
      : { id: block.structId! },
  )

  expect(resolveAnchorInDocument(anchor, second)).toMatchObject({
    status: 'anchored',
    nodeId: block.id,
    matchedBy: 'struct-id',
  })
}

function expectStableUniqueIds(
  first: AnchorableNode[],
  second: AnchorableNode[],
) {
  const ids = first.map((block) => block.id)
  expect(ids.length).toBeGreaterThan(3)
  expect(new Set(ids).size).toBe(ids.length)
  expect(second.map((block) => [block.id, block.structDigest])).toEqual(
    first.map((block) => [block.id, block.structDigest]),
  )
}

describe('a blog entry', () => {
  const source = readFileSync(
    path.join(ROOT, 'src/content/blog/a-i-art-and-anti-discrimination/index.mdx'),
    'utf8',
  )
    // The prose is what gets ids; frontmatter and MDX imports are not blocks.
    .replace(/^---[\s\S]*?\n---\n/u, '')
    .replace(/^(import|export) .*$/gmu, '')

  const render = (markdown: string) =>
    blocksFromHtml(
      String(
        unified()
          .use(remarkParse)
          .use(remarkRehype)
          .use(rehypeBlockIds)
          .use(rehypeStringify)
          .processSync(markdown),
      ),
    )

  it('carries the same block ids across two builds of the same source', () => {
    expectStableUniqueIds(render(source), render(source))
  })

  it('re-resolves an anchor by its block id on the next build', () => {
    expectAnchorSurvives(render(source), render(source))
  })

  it('does not renumber blocks when a paragraph is added above them', () => {
    const before = render(source)
    const after = render(`A new opening paragraph.\n\n${source}`)

    expect(after.map((block) => block.id)).toEqual(
      expect.arrayContaining(before.map((block) => block.id)),
    )
    expectAnchorSurvives(before, after)
  })

  it('keeps a heading on the slug the contents already link to', () => {
    const html = String(
      unified()
        .use(remarkParse)
        .use(remarkRehype)
        // Stands in for the slugger that runs first on the site.
        .use(() => (tree: Root) => {
          for (const node of tree.children) {
            if (node.type === 'element' && node.tagName === 'h2') {
              node.properties.id = 'a-slug'
            }
          }
        })
        .use(rehypeBlockIds)
        .use(rehypeStringify)
        .processSync('## A heading\n\nSome prose.'),
    )

    expect(html).toContain('<h2 id="a-slug" data-block-kind="h2"')
  })
})

describe('a paper', () => {
  const paper = getPaper('semantic-responsive-typesetting')!
  const render = () =>
    blocksFromHtml(renderToStaticMarkup(<ResearchStudio paper={paper} />))

  it('carries its authored node ids as block ids across two renders', () => {
    const first = render()

    expectStableUniqueIds(first, render())
    expect(first.map((block) => block.id)).toContain('p-proposition-1')
    const authored = new Set(paper.nodes.map((node) => node.id))
    expect(first.every((block) => authored.has(block.id))).toBe(true)
  })

  it('re-resolves an anchor by its block id on the next render', () => {
    expectAnchorSurvives(render(), render())
  })
})

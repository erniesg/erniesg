import { describe, expect, it } from 'vitest'
import { blocksFromHtml } from './prose-paste'
import {
  isEditable,
  parseMarkdown,
  schemaViolations,
  serializeMarkdown,
  type Inline,
} from './prose-schema'

const PERMITTED = new Set([
  'paragraph',
  'heading',
  'list',
  'list_item',
  'text',
  'code',
  'em',
  'strong',
  'link',
])

function nodeTypes(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) nodeTypes(entry, into)
  } else if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>
    if (typeof node.type === 'string') into.add(node.type)
    nodeTypes(node.content, into)
    nodeTypes(node.items, into)
  }
  return into
}

function links(value: unknown, into: Inline[] = []): Inline[] {
  if (Array.isArray(value)) {
    for (const entry of value) links(entry, into)
  } else if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>
    if (node.type === 'link') into.push(node as Inline)
    links(node.content, into)
    links(node.items, into)
  }
  return into
}

const RICH = [
  '<table style="width:100%"><tr><th>Item</th><th>Price</th></tr>',
  '<tr><td>Tea</td><td style="color:red" data-cell="1">3</td></tr></table>',
  '<p>Before <img src="x.png" onerror="alert(1)"> after</p>',
  "<script>alert('owned')</script><style>p { display: none }</style>",
  '<p><span style="font-weight:bold" class="fancy" data-track="1">styled</span>',
  ' <b>bold</b> <i>it</i> <code>x = 1</code>',
  ' <a href="https://ernie.sg/a" target="_blank" rel="noopener" onclick="steal()">ok</a>',
  ' <a href="javascript:alert(1)">bad</a></p>',
  '<ul class="x"><li>one</li><li>two <u>under</u></li></ul>',
  '<h2 id="h" style="color:red">A <em>heading</em></h2>',
].join('')

describe('pasting rich HTML', () => {
  const blocks = blocksFromHtml(RICH)

  it('yields only permitted nodes and no attribute outside the allowlist', () => {
    expect(schemaViolations(blocks)).toEqual([])
    for (const type of nodeTypes(blocks)) expect([...PERMITTED]).toContain(type)

    const json = JSON.stringify(blocks)
    for (const banned of [
      'alert',
      'owned',
      'onerror',
      'onclick',
      'font-weight',
      'color',
      'width',
      'fancy',
      'data-',
      'target',
      'rel',
      'x.png',
      'javascript',
      'display',
    ]) {
      expect(json).not.toContain(banned)
    }
  })

  it('keeps a table as its text, drops the image, script and style, unwraps the span', () => {
    const markdown = serializeMarkdown({ type: 'doc', leading: '', blocks })
    expect(markdown).toBe(
      [
        'Item Price',
        'Tea 3',
        'Before after',
        'styled **bold** *it* `x = 1` [ok](https://ernie.sg/a) bad',
        '- one\n- two under',
        '## A *heading*',
        '',
      ].join('\n\n'),
    )
  })

  it('keeps only a permitted link destination', () => {
    expect(links(blocks)).toEqual([
      {
        type: 'link',
        href: 'https://ernie.sg/a',
        content: [{ type: 'text', text: 'ok' }],
      },
    ])
  })

  it('reads back as editable prose, not as locked blocks', () => {
    const markdown = serializeMarkdown({ type: 'doc', leading: '', blocks })
    const reread = parseMarkdown(markdown)
    expect(reread.blocks.every(isEditable)).toBe(true)
    expect(serializeMarkdown(reread)).toBe(markdown)
  })

  it('escapes pasted Markdown syntax instead of obeying it', () => {
    const [block] = blocksFromHtml('<p>:::aside{x=1} **not bold** &lt;b&gt;</p>')
    const markdown = serializeMarkdown({ type: 'doc', leading: '', blocks: [block] })
    expect(markdown.startsWith('\\:::aside')).toBe(true)
    expect(markdown).toContain('\\*\\*not bold\\*\\*')
    expect(markdown).toContain('\\<b\\>')
  })
})

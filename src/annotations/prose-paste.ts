import { parseFragment } from 'parse5'
import {
  isPermittedHref,
  type EditableBlock,
  type Inline,
  type ListItem,
} from './prose-schema'

/**
 * Pasted HTML, mapped into the prose schema (issue 059).
 *
 * This is not a sanitizer over a permissive editor. It builds schema nodes
 * from the parsed HTML, and the schema has no node for a table, an image, a
 * script or a style, and no field for an arbitrary attribute. So a table
 * arrives as its text, one paragraph per row; an image, a script, a style or
 * an embed arrives as nothing; a styled `<span>` arrives as its text; and a
 * link keeps its `href` only when it is a permitted destination.
 */

type HtmlNode = {
  nodeName: string
  tagName?: string
  value?: string
  attrs?: { name: string; value: string }[]
  childNodes?: HtmlNode[]
}

/** Dropped with everything inside them. */
const DROPPED = new Set([
  'script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed',
  'img', 'picture', 'svg', 'math', 'video', 'audio', 'canvas', 'source',
  'track', 'map', 'head', 'title', 'meta', 'link', 'base', 'input', 'button',
  'select', 'textarea', 'form', 'hr',
])

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const EMPHASIS = new Set(['em', 'i', 'cite', 'dfn', 'var'])
const STRONG = new Set(['strong', 'b'])
const CODE = new Set(['code', 'kbd', 'samp', 'tt'])

/** Elements that end the paragraph being collected. */
const BLOCKS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside',
  'nav', 'blockquote', 'pre', 'figure', 'figcaption', 'address', 'table',
  'thead', 'tbody', 'tfoot', 'tr', 'caption', 'dl', 'dt', 'dd', 'li', 'ul',
  'ol', 'br', 'details', 'summary', 'fieldset', 'legend',
  ...HEADINGS,
])

function tag(node: HtmlNode): string {
  return (node.tagName ?? node.nodeName).toLowerCase()
}

function textContent(node: HtmlNode): string {
  if (node.nodeName === '#text') return node.value ?? ''
  if (DROPPED.has(tag(node))) return ''
  return (node.childNodes ?? []).map(textContent).join('')
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/** Adjacent text merged, whitespace collapsed, empty marks and text dropped. */
function normalize(nodes: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const node of nodes) {
    if (node.type === 'text') {
      const text = collapse(node.text)
      const last = out[out.length - 1]
      if (last?.type === 'text') {
        out[out.length - 1] = {
          type: 'text',
          text: collapse(last.text + text),
        }
      } else if (text) {
        out.push({ type: 'text', text })
      }
    } else if (node.type === 'code') {
      if (node.text.trim()) out.push({ type: 'code', text: collapse(node.text) })
    } else {
      const content = normalize(node.content)
      if (content.length === 0) continue
      // Emphasis cannot open or close on a space in Markdown, so the spaces
      // move outside the mark.
      const first = content[0]
      if (first.type === 'text' && first.text.startsWith(' ')) {
        out.push({ type: 'text', text: ' ' })
        content[0] = { type: 'text', text: first.text.slice(1) }
      }
      const last = content[content.length - 1]
      const trailing = last.type === 'text' && last.text.endsWith(' ')
      if (trailing) {
        content[content.length - 1] = {
          type: 'text',
          text: (last as { text: string }).text.slice(0, -1),
        }
      }
      const kept = content.filter(
        (child) => child.type !== 'text' || child.text !== '',
      )
      if (kept.length > 0) out.push({ ...node, content: kept })
      if (trailing) out.push({ type: 'text', text: ' ' })
    }
  }
  // Merge any text the hoisting above left side by side.
  return out.reduce<Inline[]>((merged, node) => {
    const last = merged[merged.length - 1]
    if (node.type === 'text' && last?.type === 'text') {
      merged[merged.length - 1] = {
        type: 'text',
        text: collapse(last.text + node.text),
      }
    } else {
      merged.push(node)
    }
    return merged
  }, [])
}

function trim(nodes: Inline[]): Inline[] {
  const out = nodes.slice()
  const first = out[0]
  if (first?.type === 'text') {
    const text = first.text.trimStart()
    if (text) out[0] = { type: 'text', text }
    else out.shift()
  }
  const last = out[out.length - 1]
  if (last?.type === 'text') {
    const text = last.text.trimEnd()
    if (text) out[out.length - 1] = { type: 'text', text }
    else out.pop()
  }
  return out
}

function permittedHref(node: HtmlNode): string | null {
  const raw = node.attrs?.find((attr) => attr.name === 'href')?.value.trim()
  if (!raw) return null
  const href = raw.replace(
    /[\s()<>\\"]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  )
  return isPermittedHref(href) ? href : null
}

/** Inline content of a node; nested blocks flatten to their text. */
function inlineOf(node: HtmlNode, inLink = false): Inline[] {
  if (node.nodeName === '#text') return [{ type: 'text', text: node.value ?? '' }]
  if (node.nodeName.startsWith('#')) return []
  const name = tag(node)
  if (DROPPED.has(name)) return []
  const children = () =>
    (node.childNodes ?? []).flatMap((child) => inlineOf(child, inLink))

  if (CODE.has(name)) return [{ type: 'code', text: textContent(node) }]
  if (EMPHASIS.has(name)) return [{ type: 'em', marker: '*', content: children() }]
  if (STRONG.has(name)) {
    return [{ type: 'strong', marker: '**', content: children() }]
  }
  if (name === 'a' && !inLink) {
    const href = permittedHref(node)
    const content = (node.childNodes ?? []).flatMap((child) =>
      inlineOf(child, true),
    )
    return href ? [{ type: 'link', href, content }] : content
  }
  if (BLOCKS.has(name)) {
    return [{ type: 'text', text: ' ' }, ...children(), { type: 'text', text: ' ' }]
  }
  return children()
}

/** The blocks a paste of `html` becomes. Only permitted nodes, ever. */
export function blocksFromHtml(html: string): EditableBlock[] {
  const blocks: EditableBlock[] = []
  let pending: Inline[] = []

  const flush = () => {
    const content = trim(normalize(pending))
    pending = []
    if (content.length > 0) {
      blocks.push({ type: 'paragraph', content, after: '\n\n' })
    }
  }

  const visit = (node: HtmlNode) => {
    if (node.nodeName === '#text') {
      pending.push({ type: 'text', text: node.value ?? '' })
      return
    }
    if (node.nodeName.startsWith('#')) return
    const name = tag(node)
    if (DROPPED.has(name)) return

    if (HEADINGS.has(name)) {
      flush()
      const content = trim(normalize(inlineOf(node)))
      const level = Number(name.slice(1))
      if (content.length > 0) {
        blocks.push({
          type: 'heading',
          level,
          prefix: `${'#'.repeat(level)} `,
          content,
          after: '\n\n',
        })
      }
      return
    }
    if (name === 'ul' || name === 'ol') {
      flush()
      const items: ListItem[] = []
      for (const child of node.childNodes ?? []) {
        const content = trim(normalize(inlineOf(child)))
        if (content.length === 0) continue
        items.push({
          type: 'list_item',
          marker: name === 'ol' ? `${items.length + 1}. ` : '- ',
          indent: name === 'ol' ? ' '.repeat(`${items.length + 1}. `.length) : '  ',
          content,
        })
      }
      if (items.length > 0) blocks.push({ type: 'list', items, after: '\n\n' })
      return
    }
    if (BLOCKS.has(name)) {
      flush()
      for (const child of node.childNodes ?? []) visit(child)
      flush()
      return
    }
    // A table cell's text is kept, with a space between cells.
    if (name === 'td' || name === 'th') {
      pending.push({ type: 'text', text: ' ' })
      for (const child of node.childNodes ?? []) visit(child)
      pending.push({ type: 'text', text: ' ' })
      return
    }
    pending.push(...inlineOf(node))
  }

  const fragment = parseFragment(html) as unknown as HtmlNode
  for (const child of fragment.childNodes ?? []) visit(child)
  flush()
  return blocks
}

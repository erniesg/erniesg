/**
 * The edit-mode document model (issue 059): a constrained prose schema over a
 * book node's Markdown source.
 *
 * The schema is the enforcement mechanism. An editable block is a paragraph,
 * a heading or a flat list, and its inline content is text, emphasis, strong,
 * links and inline code — nothing else can be represented, so nothing else can
 * be produced. Every other construct (`+++` front matter, `:::` blocks and the
 * figures inside them, code fences, tables, block quotes, HTML, maths) is a
 * `locked` block that carries its source verbatim and cannot be edited.
 *
 * The round trip is proven per block rather than assumed: a block that the
 * parser can read but not write back byte for byte is locked as `round_trip`
 * instead of being offered for editing. A smaller editable surface is correct;
 * a lossy one is not. `serializeMarkdown(parseMarkdown(source))` is therefore
 * the identity for every source, and `prose-schema.test.ts` asserts it for all
 * 46 book nodes.
 *
 * Parsed text keeps its source spelling in `raw`, so an unedited node writes
 * back exactly what it read (escapes included). Text an edit produces has no
 * `raw` and is escaped on the way out, so a reader typing `*` or `:::` gets
 * the character, never new structure.
 */

export type TextNode = { type: 'text'; text: string; raw?: string }
export type CodeNode = { type: 'code'; text: string; raw?: string }
export type EmNode = { type: 'em'; marker: '*' | '_'; content: Inline[] }
export type StrongNode = {
  type: 'strong'
  marker: '**' | '__'
  content: Inline[]
}
export type LinkNode = {
  type: 'link'
  href: string
  title?: string
  content: Inline[]
}
export type Inline = TextNode | CodeNode | EmNode | StrongNode | LinkNode

export type ListItem = {
  type: 'list_item'
  /** The marker as written, with its indentation and trailing spaces: `- `. */
  marker: string
  /** Prefix of every continuation line of the item. */
  indent: string
  content: Inline[]
}

export type ParagraphBlock = {
  type: 'paragraph'
  content: Inline[]
  after: string
}
export type HeadingBlock = {
  type: 'heading'
  level: number
  /** The `## ` prefix as written. */
  prefix: string
  content: Inline[]
  after: string
}
export type ListBlock = { type: 'list'; items: ListItem[]; after: string }

export const LOCK_REASONS = [
  'front_matter',
  'directive',
  'code',
  'indented_code',
  'table',
  'blockquote',
  'html',
  'thematic_break',
  'setext_heading',
  'nested_list',
  'list_interrupt',
  'definition',
  'unsupported_inline',
  'round_trip',
] as const
export type LockReason = (typeof LOCK_REASONS)[number]

export type LockedBlock = {
  type: 'locked'
  reason: LockReason
  raw: string
  after: string
}

export type EditableBlock = ParagraphBlock | HeadingBlock | ListBlock
export type Block = EditableBlock | LockedBlock

export type ProseDoc = { type: 'doc'; leading: string; blocks: Block[] }

export function isEditable(block: Block): block is EditableBlock {
  return block.type !== 'locked'
}

/* -------------------------------------------------------------------------- */
/* Block structure                                                            */
/* -------------------------------------------------------------------------- */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const DIRECTIVE_OPEN = /^ {0,3}:{3,}[A-Za-z]/
const DIRECTIVE_CLOSE = /^ {0,3}:{3,}\s*$/
const DIRECTIVE_ANY = /^ {0,3}:{3,}/
const HEADING = /^( {0,3}(#{1,6})[ \t]+)(.*)$/
const LIST_MARKER = /^( {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+)(.*)$/
const ANY_LIST_MARKER = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
const DEFINITION = /^ {0,3}\[[^\]]+\]:/

function isBlank(line: string): boolean {
  return /^[ \t]*$/.test(line)
}

/** The index one past the closing fence, or the end of the source. */
function fenceEnd(lines: string[], start: number): number {
  const open = FENCE_OPEN.exec(lines[start])
  if (!open) return start + 1
  const char = open[1][0]
  const length = open[1].length
  for (let k = start + 1; k < lines.length; k += 1) {
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[k])
    if (close && close[1][0] === char && close[1].length >= length) return k + 1
  }
  return lines.length
}

/** A `:::` block and everything nested in it, fences included. */
function directiveEnd(lines: string[], start: number): number {
  let depth = 0
  let k = start
  while (k < lines.length) {
    const line = lines[k]
    if (k > start && FENCE_OPEN.test(line)) {
      k = fenceEnd(lines, k)
      continue
    }
    if (DIRECTIVE_OPEN.test(line)) depth += 1
    else if (DIRECTIVE_CLOSE.test(line)) depth -= 1
    k += 1
    if (depth <= 0) return k
  }
  return lines.length
}

function frontMatterEnd(lines: string[], fence: string): number {
  for (let k = 1; k < lines.length; k += 1) {
    if (lines[k] === fence) return k + 1
  }
  return lines.length
}

/** Where a run of prose lines stops: a blank line or a line that opens a block. */
function groupEnd(lines: string[], start: number): number {
  if (HEADING.test(lines[start])) return start + 1
  let k = start + 1
  while (
    k < lines.length &&
    !isBlank(lines[k]) &&
    !FENCE_OPEN.test(lines[k]) &&
    !DIRECTIVE_ANY.test(lines[k]) &&
    !HEADING.test(lines[k])
  ) {
    k += 1
  }
  return k
}

function locked(reason: LockReason, raw: string): LockedBlock {
  return { type: 'locked', reason, raw, after: '' }
}

/**
 * Text the inline parser does not model. Rather than guess what the site's
 * renderer makes of it, the block is locked.
 */
function unsupportedInline(text: string): boolean {
  return (
    text.includes('<') ||
    text.includes('$') ||
    text.includes('![') ||
    text.includes('[^') ||
    text.includes('~~') ||
    /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(text)
  )
}

function buildGroup(groupLines: string[]): Block {
  const raw = groupLines.join('\n')
  const first = groupLines[0]

  if (/^( {4}|\t)/.test(first)) return locked('indented_code', raw)
  if (/^ {0,3}>/.test(first)) return locked('blockquote', raw)
  if (/^ {0,3}</.test(first)) return locked('html', raw)
  if (
    /^ {0,3}\|/.test(first) ||
    groupLines.some((l) => TABLE_DELIMITER.test(l) && l.includes('|'))
  ) {
    return locked('table', raw)
  }
  if (THEMATIC_BREAK.test(first)) return locked('thematic_break', raw)
  if (groupLines.slice(1).some((l) => SETEXT_UNDERLINE.test(l))) {
    return locked('setext_heading', raw)
  }
  if (DEFINITION.test(first)) return locked('definition', raw)
  if (groupLines.slice(1).some((l) => /^ {0,3}(?:>|<)/.test(l))) {
    return locked('list_interrupt', raw)
  }
  if (unsupportedInline(raw)) return locked('unsupported_inline', raw)

  let block: EditableBlock
  const heading = HEADING.exec(first)
  if (heading) {
    if (!heading[3].trim()) return locked('round_trip', raw)
    block = {
      type: 'heading',
      level: heading[2].length,
      prefix: heading[1],
      content: parseInline(heading[3]),
      after: '',
    }
  } else if (LIST_MARKER.test(first)) {
    const items = parseListItems(groupLines)
    if (!items) return locked('nested_list', raw)
    block = { type: 'list', items, after: '' }
  } else {
    if (groupLines.slice(1).some((l) => ANY_LIST_MARKER.test(l))) {
      return locked('list_interrupt', raw)
    }
    block = { type: 'paragraph', content: parseInline(raw), after: '' }
  }

  // The proof, per block: what is offered for editing writes back unchanged.
  return serializeBlock(block) === raw ? block : locked('round_trip', raw)
}

function parseListItems(groupLines: string[]): ListItem[] | null {
  const items: { marker: string; lines: string[]; indent: string | null }[] =
    []
  for (const line of groupLines) {
    const marker = LIST_MARKER.exec(line)
    if (marker) {
      items.push({ marker: marker[1], lines: [marker[2]], indent: null })
      continue
    }
    const item = items[items.length - 1]
    if (!item) return null
    // A marker on an indented line is a nested list: not in the prose subset.
    if (ANY_LIST_MARKER.test(line)) return null
    const leading = /^[ \t]*/.exec(line)![0]
    if (item.indent === null) item.indent = leading
    item.lines.push(
      line.startsWith(item.indent) ? line.slice(item.indent.length) : line,
    )
  }
  return items.map((item): ListItem => ({
    type: 'list_item',
    marker: item.marker,
    indent: item.indent ?? '',
    content: parseInline(item.lines.join('\n')),
  }))
}

/** Parse a node's Markdown source into the constrained document. */
export function parseMarkdown(source: string): ProseDoc {
  const lines = source.split('\n')
  const doc: ProseDoc = { type: 'doc', leading: '', blocks: [] }
  const gap = (text: string) => {
    const last = doc.blocks[doc.blocks.length - 1]
    if (last) last.after += text
    else doc.leading += text
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) {
      gap(i < lines.length - 1 ? `${line}\n` : line)
      i += 1
      continue
    }

    let end: number
    let block: Block
    if (i === 0 && (line === '+++' || line === '---')) {
      end = frontMatterEnd(lines, line)
      block = locked('front_matter', lines.slice(i, end).join('\n'))
    } else if (FENCE_OPEN.test(line)) {
      end = fenceEnd(lines, i)
      block = locked('code', lines.slice(i, end).join('\n'))
    } else if (DIRECTIVE_ANY.test(line)) {
      end = DIRECTIVE_OPEN.test(line) ? directiveEnd(lines, i) : i + 1
      block = locked('directive', lines.slice(i, end).join('\n'))
    } else {
      end = groupEnd(lines, i)
      block = buildGroup(lines.slice(i, end))
    }
    // The newline that ends the block's last line belongs to the gap after it.
    block.after = end < lines.length ? '\n' : ''
    doc.blocks.push(block)
    i = end
  }
  return doc
}

/* -------------------------------------------------------------------------- */
/* Inline structure                                                           */
/* -------------------------------------------------------------------------- */

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/

function runLength(s: string, at: number, char: string): number {
  let k = at
  while (s[k] === char) k += 1
  return k - at
}

/** The start of the next backtick run of exactly `length`, or -1. */
function closingBackticks(s: string, from: number, length: number): number {
  let k = from
  while (k < s.length) {
    if (s[k] === '`') {
      const run = runLength(s, k, '`')
      if (run === length) return k
      k += run
    } else {
      k += 1
    }
  }
  return -1
}

function unescapeText(raw: string): string {
  return raw.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

function codeText(inner: string): string {
  return inner.length >= 2 &&
    inner.startsWith(' ') &&
    inner.endsWith(' ') &&
    inner.trim() !== ''
    ? inner.slice(1, -1)
    : inner
}

function isWhitespace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char)
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char)
}

/** Skip an escape or a whole code span starting at `k`, else one character. */
function skipAtom(s: string, k: number): number {
  if (s[k] === '\\' && ASCII_PUNCTUATION.test(s[k + 1] ?? '')) return k + 2
  if (s[k] === '`') {
    const run = runLength(s, k, '`')
    const close = closingBackticks(s, k + run, run)
    return close >= 0 ? close + run : k + run
  }
  return k + 1
}

function parseEmphasis(
  s: string,
  at: number,
): { node: EmNode | StrongNode; end: number } | null {
  const char = s[at]
  const run = runLength(s, at, char)
  if (run > 2) return null
  if (isWhitespace(s[at + run])) return null
  if (char === '_' && isWordChar(s[at - 1])) return null

  let k = at + run
  while (k < s.length) {
    if (s[k] === char) {
      const closeRun = runLength(s, k, char)
      if (
        closeRun === run &&
        k > at + run &&
        !isWhitespace(s[k - 1]) &&
        !(char === '_' && isWordChar(s[k + run]))
      ) {
        const content = parseInline(s.slice(at + run, k))
        const node: EmNode | StrongNode =
          run === 1
            ? { type: 'em', marker: char as '*' | '_', content }
            : { type: 'strong', marker: (char + char) as '**' | '__', content }
        return { node, end: k + run }
      }
      k += closeRun
      continue
    }
    k = skipAtom(s, k)
  }
  return null
}

function parseLink(
  s: string,
  at: number,
): { node: LinkNode; end: number } | null {
  let depth = 0
  let k = at
  let close = -1
  while (k < s.length) {
    if (s[k] === '[') depth += 1
    else if (s[k] === ']') {
      depth -= 1
      if (depth === 0) {
        close = k
        break
      }
    }
    k = skipAtom(s, k)
  }
  if (close <= at + 1 || s[close + 1] !== '(') return null

  const destination = /^\(([^\s()<>\\]+)(?: "([^"\\\n]*)")?\)/.exec(
    s.slice(close + 1),
  )
  if (!destination) return null
  const node: LinkNode = {
    type: 'link',
    href: destination[1],
    ...(destination[2] !== undefined ? { title: destination[2] } : {}),
    content: parseInline(s.slice(at + 1, close)),
  }
  return { node, end: close + 1 + destination[0].length }
}

/** Parse inline Markdown into the permitted inline nodes. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = []
  let textStart = 0
  let k = 0
  const flush = (to: number) => {
    if (to > textStart) {
      const raw = s.slice(textStart, to)
      out.push({ type: 'text', text: unescapeText(raw), raw })
    }
  }

  while (k < s.length) {
    const char = s[k]
    if (char === '\\' && ASCII_PUNCTUATION.test(s[k + 1] ?? '')) {
      k += 2
      continue
    }
    if (char === '`') {
      const run = runLength(s, k, '`')
      const close = closingBackticks(s, k + run, run)
      if (close < 0) {
        k += run
        continue
      }
      flush(k)
      const raw = s.slice(k, close + run)
      out.push({ type: 'code', text: codeText(s.slice(k + run, close)), raw })
      k = close + run
      textStart = k
      continue
    }
    if (char === '[') {
      const link = parseLink(s, k)
      if (link) {
        flush(k)
        out.push(link.node)
        k = link.end
        textStart = k
        continue
      }
    }
    if (char === '*' || char === '_') {
      const emphasis = parseEmphasis(s, k)
      if (emphasis) {
        flush(k)
        out.push(emphasis.node)
        k = emphasis.end
        textStart = k
        continue
      }
      k += runLength(s, k, char)
      continue
    }
    k += 1
  }
  flush(s.length)
  return out
}

/* -------------------------------------------------------------------------- */
/* Serialization                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Escape text an edit produced, so it reads back as the same characters and
 * never as structure. Unedited text is written from `raw` instead.
 */
export function escapeText(text: string, atLineStart: boolean): string {
  const escaped = text.replace(/[\\`*_[\]<>$~&|]/g, '\\$&')
  return escaped.replace(
    atLineStart ? /(^|\n)([ \t]*)(?:([#>+=:-])|(\d+)([.)]))/g : /(\n)([ \t]*)(?:([#>+=:-])|(\d+)([.)]))/g,
    (_match, start: string, space: string, mark?: string, digits?: string, dot?: string) =>
      mark !== undefined
        ? `${start}${space}\\${mark}`
        : `${start}${space}${digits}\\${dot}`,
  )
}

function codeSpan(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length)
  }
  const fence = '`'.repeat(longest + 1)
  const pad =
    text.startsWith('`') ||
    text.endsWith('`') ||
    (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '')
      ? ' '
      : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

export function serializeInline(nodes: Inline[], atLineStart = true): string {
  let out = ''
  for (const node of nodes) {
    const start = out === '' ? atLineStart : out.endsWith('\n')
    switch (node.type) {
      case 'text':
        out += node.raw ?? escapeText(node.text, start)
        break
      case 'code':
        out += node.raw ?? codeSpan(node.text)
        break
      case 'em':
      case 'strong':
        out += `${node.marker}${serializeInline(node.content, false)}${node.marker}`
        break
      case 'link':
        out +=
          `[${serializeInline(node.content, false)}](${node.href}` +
          `${node.title !== undefined ? ` "${node.title}"` : ''})`
        break
    }
  }
  return out
}

export function serializeBlock(block: Block): string {
  switch (block.type) {
    case 'locked':
      return block.raw
    case 'paragraph':
      return serializeInline(block.content)
    case 'heading':
      return `${block.prefix}${serializeInline(block.content, false)}`
    case 'list':
      return block.items
        .map(
          (item) =>
            item.marker +
            serializeInline(item.content, false).replaceAll(
              '\n',
              `\n${item.indent}`,
            ),
        )
        .join('\n')
  }
}

export function serializeMarkdown(doc: ProseDoc): string {
  return (
    doc.leading +
    doc.blocks.map((block) => serializeBlock(block) + block.after).join('')
  )
}

/* -------------------------------------------------------------------------- */
/* The schema, checked                                                        */
/* -------------------------------------------------------------------------- */

const KEYS: Record<string, readonly string[]> = {
  text: ['type', 'text', 'raw'],
  code: ['type', 'text', 'raw'],
  em: ['type', 'marker', 'content'],
  strong: ['type', 'marker', 'content'],
  link: ['type', 'href', 'title', 'content'],
  list_item: ['type', 'marker', 'indent', 'content'],
  paragraph: ['type', 'content', 'after'],
  heading: ['type', 'level', 'prefix', 'content', 'after'],
  list: ['type', 'items', 'after'],
  locked: ['type', 'reason', 'raw', 'after'],
}

/** Link targets an edit may introduce. Anything else is dropped on paste. */
export function isPermittedHref(href: string): boolean {
  return /^(?:https?:\/\/|mailto:|\/|#)/i.test(href) && !/[\s()<>\\]/.test(href)
}

/**
 * Every way a value departs from the schema: an unknown node type, a key
 * outside the allowlist, or text that would break out of its block. Empty
 * means the value is a valid document, block list or inline list.
 */
export function schemaViolations(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      schemaViolations(entry, `${path}[${index}]`),
    )
  }
  if (typeof value !== 'object' || value === null) {
    return [`${path}: not a node`]
  }
  const node = value as Record<string, unknown>
  if (node.type === 'doc') {
    return typeof node.leading === 'string'
      ? schemaViolations(node.blocks, `${path}.blocks`)
      : [`${path}.leading: not a string`]
  }
  const allowed = KEYS[String(node.type)]
  if (!allowed) return [`${path}: node type ${String(node.type)} is not permitted`]
  const problems = Object.keys(node)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${path}.${key}: attribute not permitted`)

  switch (node.type) {
    case 'text':
    case 'code':
      if (typeof node.text !== 'string' || node.text === '') {
        problems.push(`${path}.text: empty`)
      } else if (/\n[ \t]*\n/.test(node.text)) {
        problems.push(`${path}.text: a blank line would end the block`)
      }
      break
    case 'link':
      if (typeof node.href !== 'string' || /[\s()<>\\]/.test(node.href)) {
        problems.push(`${path}.href: not a permitted destination`)
      }
      problems.push(...schemaViolations(node.content, `${path}.content`))
      break
    case 'em':
    case 'strong':
    case 'paragraph':
    case 'heading':
    case 'list_item':
      problems.push(...schemaViolations(node.content, `${path}.content`))
      break
    case 'list':
      problems.push(...schemaViolations(node.items, `${path}.items`))
      break
    case 'locked':
      if (!(LOCK_REASONS as readonly unknown[]).includes(node.reason)) {
        problems.push(`${path}.reason: unknown`)
      }
      break
  }
  return problems
}

/* -------------------------------------------------------------------------- */
/* Edits                                                                      */
/* -------------------------------------------------------------------------- */

function editable(doc: ProseDoc, index: number): EditableBlock {
  const block = doc.blocks[index]
  if (!block) throw new RangeError(`no block ${index}`)
  if (!isEditable(block)) {
    throw new Error(`block ${index} is locked (${block.reason})`)
  }
  return block
}

function replaceInInlines(
  nodes: Inline[],
  search: string,
  replacement: string,
): Inline[] | null {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node.type === 'text' && node.text.includes(search)) {
      const at = node.text.indexOf(search)
      const before = node.text.slice(0, at)
      const rest = node.text.slice(at + search.length)
      const text = before + replacement + rest
      // A run with no escapes keeps its source spelling around the edit, so a
      // one-word change is a one-word patch rather than a re-escaped run.
      const lineStart = at === 0 || before.endsWith('\n')
      const next: TextNode | null = !text
        ? null
        : node.raw === node.text
          ? {
              type: 'text',
              text,
              raw: before + escapeText(replacement, lineStart) + rest,
            }
          : { type: 'text', text }
      const copy = nodes.slice()
      if (next) copy[index] = next
      else copy.splice(index, 1)
      return copy
    }
    if (node.type === 'em' || node.type === 'strong' || node.type === 'link') {
      const content = replaceInInlines(node.content, search, replacement)
      if (content) {
        const copy = nodes.slice()
        copy[index] = { ...node, content }
        return copy
      }
    }
  }
  return null
}

/**
 * Replace the first occurrence of `search` inside one text run of an editable
 * block. The edited run loses its source spelling and is escaped on output.
 */
export function replaceText(
  doc: ProseDoc,
  index: number,
  search: string,
  replacement: string,
): ProseDoc {
  const block = editable(doc, index)
  let next: EditableBlock | null = null
  if (block.type === 'list') {
    for (let item = 0; item < block.items.length; item += 1) {
      const content = replaceInInlines(
        block.items[item].content,
        search,
        replacement,
      )
      if (content) {
        const items = block.items.slice()
        items[item] = { ...block.items[item], content }
        next = { ...block, items }
        break
      }
    }
  } else {
    const content = replaceInInlines(block.content, search, replacement)
    if (content) next = { ...block, content }
  }
  if (!next) throw new Error(`"${search}" is not in the text of block ${index}`)
  const blocks = doc.blocks.slice()
  blocks[index] = next
  return { ...doc, blocks }
}

/** Replace a block's whole inline content, as retyping it does. */
export function retypeBlock(
  doc: ProseDoc,
  index: number,
  text: string,
): ProseDoc {
  const block = editable(doc, index)
  if (block.type === 'list') throw new Error('retype a list item by item')
  const blocks = doc.blocks.slice()
  blocks[index] = { ...block, content: [{ type: 'text', text }] }
  return { ...doc, blocks }
}

/** Delete an editable block and the blank line that separated it. */
export function deleteBlock(doc: ProseDoc, index: number): ProseDoc {
  editable(doc, index)
  const blocks = doc.blocks.slice()
  const [removed] = blocks.splice(index, 1)
  // The last block's trailing newline would otherwise go with it.
  if (index === blocks.length && index > 0) {
    blocks[index - 1] = { ...blocks[index - 1], after: removed.after }
  }
  return { ...doc, blocks }
}

/** Delete one item of an editable list. */
export function deleteListItem(
  doc: ProseDoc,
  index: number,
  item: number,
): ProseDoc {
  const block = editable(doc, index)
  if (block.type !== 'list') throw new Error(`block ${index} is not a list`)
  if (block.items.length === 1) return deleteBlock(doc, index)
  const blocks = doc.blocks.slice()
  blocks[index] = { ...block, items: block.items.filter((_, k) => k !== item) }
  return { ...doc, blocks }
}

/** Join a paragraph with the paragraph after it, as Backspace at its start does. */
export function joinParagraphs(doc: ProseDoc, index: number): ProseDoc {
  const first = editable(doc, index)
  const second = editable(doc, index + 1)
  if (first.type !== 'paragraph' || second.type !== 'paragraph') {
    throw new Error('only two paragraphs can be joined')
  }
  const blocks = doc.blocks.slice()
  blocks.splice(index, 2, {
    type: 'paragraph',
    // A soft line break: the joined paragraph renders its halves with a space.
    content: [...first.content, { type: 'text', text: '\n' }, ...second.content],
    after: second.after,
  })
  return { ...doc, blocks }
}

/** Split a paragraph into two before the first occurrence of `before`. */
export function splitParagraph(
  doc: ProseDoc,
  index: number,
  before: string,
): ProseDoc {
  const block = editable(doc, index)
  if (block.type !== 'paragraph') throw new Error('only a paragraph splits')
  const at = block.content.findIndex(
    (node) => node.type === 'text' && node.text.includes(before),
  )
  if (at < 0) throw new Error(`"${before}" is not in block ${index}`)
  const node = block.content[at] as TextNode
  const offset = node.text.indexOf(before)
  const head = node.text.slice(0, offset).replace(/[ \t\n]+$/, '')
  const tail = node.text.slice(offset)
  const left: Inline[] = [
    ...block.content.slice(0, at),
    ...(head ? [{ type: 'text' as const, text: head }] : []),
  ]
  const right: Inline[] = [
    { type: 'text', text: tail },
    ...block.content.slice(at + 1),
  ]
  if (left.length === 0) throw new Error('nothing before the split')
  const blocks = doc.blocks.slice()
  blocks.splice(
    index,
    1,
    { type: 'paragraph', content: left, after: '\n\n' },
    { type: 'paragraph', content: right, after: block.after },
  )
  return { ...doc, blocks }
}

/**
 * One edit-mode session: the document plus its undo and redo stacks. Every
 * state is an immutable document, so undo restores one exactly.
 */
export class EditSession {
  #past: ProseDoc[] = []
  #future: ProseDoc[] = []
  doc: ProseDoc

  constructor(doc: ProseDoc) {
    this.doc = doc
  }

  apply(edit: (doc: ProseDoc) => ProseDoc): ProseDoc {
    const next = edit(this.doc)
    this.#past.push(this.doc)
    this.#future = []
    this.doc = next
    return next
  }

  undo(): ProseDoc {
    const previous = this.#past.pop()
    if (previous) {
      this.#future.push(this.doc)
      this.doc = previous
    }
    return this.doc
  }

  redo(): ProseDoc {
    const next = this.#future.pop()
    if (next) {
      this.#past.push(this.doc)
      this.doc = next
    }
    return this.doc
  }

  get canUndo(): boolean {
    return this.#past.length > 0
  }

  get canRedo(): boolean {
    return this.#future.length > 0
  }
}

/** Finite, inert serialization of trusted-current readonly book fragments.
 * This is not a general HTML sanitizer or an independent browser sandbox. */
import { parseFragment, serialize, type DefaultTreeAdapterTypes as Tree } from 'parse5'

export const SAFE_HISTORY_PROFILE = 'book-history-safe-html-v1'
export const SAFE_HISTORY_LIMITS = Object.freeze({ htmlBytes: 4 * 1024 * 1024, nodes: 100_000, depth: 128, attributes: 32, attributeBytes: 4096, cssBytes: 64 * 1024 })
export type SafeHistoryBlock = { kind: string; id: string; digest: string; domId: string }
const encoder = new TextEncoder()
const bytes = (s: string) => encoder.encode(s).length
const htmlNS = 'http://www.w3.org/1999/xhtml', svgNS = 'http://www.w3.org/2000/svg'
const htmlTags = new Set('div span section p h1 h2 h3 h4 strong em b code pre blockquote ul ol li dl dt dd table thead tbody tr th td figure figcaption details summary a'.split(' '))
const svgTags = new Set('svg g defs marker path line polyline rect text'.split(' '))
const svgAttributes: Record<string, readonly string[]> = {
  svg: ['viewBox', 'width', 'height', 'role', 'aria-label', 'aria-hidden'], g: [], defs: [],
  marker: ['markerWidth', 'markerHeight', 'refX', 'refY', 'orient'], path: ['d', 'fill', 'stroke', 'stroke-width'],
  line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width', 'marker-end'],
  polyline: ['points', 'fill', 'stroke', 'stroke-width'], rect: ['x', 'y', 'width', 'height', 'rx', 'fill', 'stroke', 'stroke-width'],
  text: ['x', 'y', 'font-size', 'text-anchor', 'fill'],
}
function fail(reason: string): never { throw new Error(`rendered history HTML profile: ${reason}`) }
function validText(value: string, limit: number) {
  if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value) || bytes(value) > limit) fail('string bound or encoding')
}
function number(value: string) {
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 10_000_000) fail('SVG numeric value')
}
const attr = (node: Tree.Element, name: string) => node.attrs.find(a => a.name === name)
type Item = { node: Tree.Element; scope: Tree.ParentNode }
function inspect(fragment: Tree.DocumentFragment, output: boolean): Item[] {
  const work: { node: Tree.ChildNode; depth: number; scope: Tree.ParentNode }[] = fragment.childNodes.map(node => ({ node, depth: 1, scope: fragment })).reverse()
  const items: Item[] = []; let count = 0
  while (work.length) {
    const { node, depth, scope } = work.pop()!
    if (++count > SAFE_HISTORY_LIMITS.nodes || depth > SAFE_HISTORY_LIMITS.depth) fail('node/depth bound')
    if (node.nodeName === '#text') continue
    if (!('tagName' in node)) fail('non-element markup')
    const svg = node.namespaceURI === svgNS
    if (!(svg ? svgTags.has(node.tagName) : node.namespaceURI === htmlNS && htmlTags.has(node.tagName))) fail('unsupported element/namespace')
    if (node.attrs.length > SAFE_HISTORY_LIMITS.attributes) fail('attribute count')
    const seen = new Set<string>()
    for (const a of node.attrs) {
      validText(a.value, SAFE_HISTORY_LIMITS.attributeBytes)
      if (seen.has(a.name) || a.namespace || a.prefix || /[\x00-\x1f\x7f]/.test(a.value)) fail('attribute identity/control')
      seen.add(a.name)
      if (a.name === 'class') { if (!/^[A-Za-z0-9_.+ -]{1,1024}$/.test(a.value)) fail('class grammar'); continue }
      if (a.name === 'id') { if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(a.value)) fail('id grammar'); continue }
      if (svg) {
        if (!svgAttributes[node.tagName].includes(a.name)) fail('unsupported SVG attribute')
        if (a.name === 'viewBox') { const v = a.value.split(' '); if (v.length !== 4) fail('viewBox'); v.forEach(number) }
        else if (a.name === 'points') { const v = a.value.trim().split(/[ ,]+/); if (v.length % 2 || v.length > 1024) fail('points'); v.forEach(number) }
        else if (a.name === 'd') {
          const tokens = a.value.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []
          if (!tokens.length || tokens.length > 1024 || tokens.join('') !== a.value.replace(/[ ,\t\n]/g, '')) fail('path grammar')
          for (const token of tokens) if (token.length !== 1 || !/[A-Za-z]/.test(token)) number(token)
        } else if (['fill', 'stroke'].includes(a.name)) { if (!/^(?:none|#[a-fA-F0-9]{3}|#[a-fA-F0-9]{6})$/.test(a.value)) fail('SVG colour') }
        else if (a.name === 'marker-end') { if (!/^url\(#[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}\)$/.test(a.value)) fail('marker reference') }
        else if (a.name === 'role') { if (a.value !== 'img') fail('SVG role') }
        else if (a.name === 'aria-label') { /* inert bounded text */ }
        else if (a.name === 'aria-hidden') { if (!['true', 'false'].includes(a.value)) fail('aria value') }
        else if (a.name === 'orient') { if (a.value !== 'auto') fail('marker orientation') }
        else if (a.name === 'text-anchor') { if (a.value !== 'middle') fail('text anchor') }
        else number(a.value)
      } else if (node.tagName === 'a' && a.name === (output ? 'data-history-link-destination' : 'href')) {
        if (!/^(?:https?:\/\/|\/|#)/.test(a.value)) fail('link destination grammar')
      } else if (node.tagName === 'div' && a.name === 'data-block-kind') { if (!/^[a-z-]{1,64}$/.test(a.value)) fail('block kind') }
      else if (node.tagName === 'div' && a.name === 'data-block-digest') { if (!/^[a-f0-9]{12}$/.test(a.value)) fail('block digest') }
      else if (node.tagName === 'details' && a.name === 'open' && a.value === '') { /* passive disclosure */ }
      else fail('unsupported HTML attribute')
    }
    const ownScope = svg && node.tagName === 'svg' ? node : scope
    items.push({ node, scope: ownScope })
    for (let i = node.childNodes.length - 1; i >= 0; i--) work.push({ node: node.childNodes[i], depth: depth + 1, scope: ownScope })
  }
  return items
}
function parse(source: string) {
  return parseFragment(source, { onParseError: error => fail(`parse ${error.code}`) })
}
export function safeHistoryHtml(source: string, namespace: string): { html: string; blocks: SafeHistoryBlock[] } {
  return rewriteHistoryHtml(source, namespace, false)
}

/** Validate the closed published profile and isolate one readonly view.
 * Link destinations remain inert data; original fragment IDs are not restored.
 * Returned block `id` is the incoming published DOM ID, to pair with the
 * sidecar's `domId`; original source descriptors remain separate caller data.
 * This establishes profile validity, not source/hash/publication authority. */
export function readPublishedHistoryHtml(source: string, viewNamespace: string): { html: string; blocks: SafeHistoryBlock[] } {
  return rewriteHistoryHtml(source, viewNamespace, true)
}

function rewriteHistoryHtml(source: string, namespace: string, published: boolean): { html: string; blocks: SafeHistoryBlock[] } {
  validText(source, SAFE_HISTORY_LIMITS.htmlBytes)
  if (!/^[a-z][a-z0-9-]{0,100}$/.test(namespace)) fail('namespace')
  const tree = parse(source), items = inspect(tree, published)
  const publishedIds = new Set<string>()
  const ids = new Map<Tree.ParentNode, Map<string, Tree.Element[]>>()
  for (const { node, scope } of items) {
    const id = attr(node, 'id')
    if (id && published) {
      if (publishedIds.has(id.value)) fail('duplicate published ID')
      publishedIds.add(id.value)
    }
    if (id) { let names = ids.get(scope); if (!names) ids.set(scope, names = new Map()); let occurrences = names.get(id.value); if (!occurrences) names.set(id.value, occurrences = []); occurrences.push(node) }
  }
  const references: { attribute: Tree.Element['attrs'][number]; target: Tree.Element }[] = []
  for (const { node, scope } of items) {
    const marker = attr(node, 'marker-end')
    if (marker) {
      const target = ids.get(scope)?.get(marker.value.slice(5, -1))
      if (target?.length !== 1 || target[0].tagName !== 'marker') fail('ambiguous/missing SVG reference')
      references.push({ attribute: marker, target: target[0] })
    }
    const link = attr(node, 'href')
    if (link) {
      if (link.value.startsWith('#')) {
        let name: string; try { name = decodeURIComponent(link.value.slice(1)) } catch { return fail('fragment encoding') }
        if (ids.get(tree)?.get(name)?.length !== 1) fail('ambiguous/missing fragment')
      }
      link.name = 'data-history-link-destination'
    }
  }
  const blocks: SafeHistoryBlock[] = []; let ordinal = 0
  for (const { node } of items) {
    const id = attr(node, 'id'), kind = attr(node, 'data-block-kind'), digest = attr(node, 'data-block-digest')
    const old = id?.value
    if (id) id.value = `${namespace}-${ordinal++}`
    if (kind || digest || attr(node, 'class')?.value.split(' ').includes('block')) {
      if (!id || !kind || !digest || node.tagName !== 'div') fail('incomplete block descriptor')
      blocks.push({ kind: kind.value, id: old!, digest: digest.value, domId: id.value })
    }
  }
  for (const ref of references) ref.attribute.value = `url(#${attr(ref.target, 'id')!.value})`
  const html = serialize(tree)
  validText(html, SAFE_HISTORY_LIMITS.htmlBytes)
  const again = parse(html); inspect(again, true)
  if (serialize(again) !== html) fail('serialization roundtrip')
  return { html, blocks }
}

/** Current trusted CONTENT_CSS only. Refuse escapes instead of pretending a
 * substring filter is a general CSS sanitizer. Preserve comments and bytes. */
export function validateHistoryCss(css: string): string {
  validText(css, SAFE_HISTORY_LIMITS.cssBytes)
  if (/[\\@<\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(css)) fail('CSS unsupported lexical form')
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  if (/\/\*|\*\//.test(stripped)) fail('CSS comment framing')
  const withoutStrings = stripped.replace(/"[^"\n]*"|'[^'\n]*'/g, '""')
  if (/["']/.test(withoutStrings.replace(/""/g, ''))) fail('CSS string framing')
  for (const match of withoutStrings.matchAll(/([-A-Za-z][\w-]*)\s*\(/g)) {
    if (!['var', 'rgba', 'rgb', 'calc', 'minmax', 'not', 'has'].includes(match[1])) fail('CSS unsupported function')
  }
  if (/url|expression|behavior|-moz-binding/i.test(withoutStrings)) fail('CSS resource/executable token')
  return css
}

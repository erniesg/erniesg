import { XMLParser } from 'fast-xml-parser'

/**
 * E-04 both-mode parity: a small, mode-agnostic view over a rendered
 * publication.
 *
 * The view answers exactly the questions EG-13 asks of the legacy
 * `research/epub.ts` overloads and the public `StructDocument` overloads:
 *
 *  1. what is the canonical text of the publication, in reading order;
 *  2. which element ids do the internal links point at, and what does the
 *     target say (the legacy ids and the Struct ids are presentational
 *     aliases of the same anchor, so the TARGET is compared, never the id
 *     string itself);
 *  3. which assets are published, under which href and with which alt text;
 *  4. which inline marks carry each text run;
 *  5. how the list structure is nested.
 *
 * It deliberately does NOT compare whole-archive bytes, CSS, class names,
 * stylesheet rules or the two document envelopes: the legacy mode renders
 * the research-paper metadata block and the Struct mode renders the document
 * metadata block, so comparing those byte-wise would prove nothing about the
 * publication.
 *
 * The extractor is test-side only. It reads the bytes the two public
 * overloads produced and never writes or normalises a publication.
 */

type XmlText = { text: string }
type XmlElement = {
  tag: string
  attributes: Record<string, string>
  children: XmlNode[]
}
type XmlNode = XmlElement | XmlText

/** Elements that carry one unit of publication content. */
const UNIT_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'li',
  'figcaption',
  'td',
  'th',
  'aside',
  'pre',
  'blockquote',
])

/** Inline marks that carry meaning for the reader. */
const INLINE_TAGS = new Set(['a', 'strong', 'em', 'code', 'sup', 'sub'])

/** List containers, whose nesting is publication structure. */
const LIST_TAGS = new Set(['ul', 'ol'])

export type PublicationUnit = {
  kind: string
  text: string
  id: string | null
  markup: string[]
  /** Number of enclosing list containers (0 for every non-list unit). */
  listDepth: number
  /** Tag of the innermost enclosing list container. */
  listTag: string | null
}

export type PublicationLink = {
  href: string
  text: string
  internal: boolean
}

export type PublicationAsset = {
  src: string
  alt: string
}

export type PublicationView = {
  title: string
  authors: string[]
  units: PublicationUnit[]
  links: PublicationLink[]
  assets: PublicationAsset[]
  idText: Record<string, string>
}

export type UnitDifference = {
  index: number
  legacy: string | null
  struct: string | null
}

export type MarkupDifference = {
  index: number
  legacy: string[]
  struct: string[]
}

export type PublicationComparison = {
  legacy: PublicationView
  struct: PublicationView
  unitsEqual: boolean
  unitDifferences: UnitDifference[]
  markupDifferences: MarkupDifference[]
  assetsEqual: boolean
  assetDifferences: UnitDifference[]
  externalLinksEqual: boolean
  externalLinkDifferences: UnitDifference[]
  internalTargetsEqual: boolean
  internalTargetDifferences: UnitDifference[]
}

function isText(node: XmlNode): node is XmlText {
  return 'text' in node
}

function parseNodes(entry: unknown): XmlNode[] {
  if (!entry || typeof entry !== 'object') return []
  if ('#text' in entry) {
    const text = String((entry as { '#text': unknown })['#text'])
    return text.length > 0 ? [{ text }] : []
  }
  const record = entry as Record<string, unknown>
  const attributes = (record[':@'] as Record<string, string> | undefined) ?? {}
  const nodes: XmlNode[] = []
  for (const [key, value] of Object.entries(record)) {
    if (key === ':@' || key.startsWith('?') || key.startsWith('!')) continue
    if (!Array.isArray(value)) continue
    nodes.push({
      tag: key,
      attributes,
      children: value.flatMap(parseNodes),
    })
  }
  return nodes
}

function canonicalText(value: string) {
  return value.replace(/\s+/gu, ' ').trim()
}

function classNames(element: XmlElement) {
  return (element.attributes['class'] ?? '').split(/\s+/u).filter(Boolean)
}

/**
 * The app marks the note-marker label as outside the semantic ledger
 * (`data-semantic-ledger-ignore="true"`), so it is not publication text.
 */
function isLedgerIgnored(element: XmlElement) {
  return element.attributes['data-semantic-ledger-ignore'] === 'true'
}

/**
 * The text of an element, excluding the text of a nested unit: a nested unit
 * is its own unit, so the two modes stay comparable block by block.
 */
function ownText(element: XmlElement, deep = false): string {
  let text = ''
  for (const child of element.children) {
    if (isText(child)) {
      text += child.text
      continue
    }
    if (isLedgerIgnored(child)) continue
    if (!deep && UNIT_TAGS.has(child.tag)) continue
    text += ownText(child, deep)
  }
  return text
}

function ownMarkup(element: XmlElement): string[] {
  const markup: string[] = []
  for (const child of element.children) {
    if (isText(child)) continue
    if (isLedgerIgnored(child)) continue
    if (UNIT_TAGS.has(child.tag)) continue
    if (INLINE_TAGS.has(child.tag)) markup.push(child.tag)
    markup.push(...ownMarkup(child))
  }
  return markup
}

function unitKind(element: XmlElement, ancestors: string[]): string {
  if (classNames(element).includes('caption')) return 'caption'
  if (ancestors.includes('aside')) return 'note'
  if (ancestors.includes('blockquote')) return 'quote'
  switch (element.tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading'
    case 'p':
      return 'paragraph'
    case 'li':
      return 'list-item'
    case 'figcaption':
      return 'caption'
    case 'td':
    case 'th':
      return 'table-cell'
    case 'aside':
      return 'note'
    case 'pre':
      return 'code'
    case 'blockquote':
      return 'quote'
    default:
      return element.tag
  }
}

/**
 * The signature two units must share to count as the same published content.
 */
export function unitSignature(unit: PublicationUnit | undefined) {
  if (!unit) return null
  const structure =
    unit.kind === 'list-item'
      ? `|${unit.listTag ?? 'none'}@${unit.listDepth}`
      : ''
  return `${unit.kind}:${unit.text}${structure}`
}

function findElement(nodes: XmlNode[], tag: string): XmlElement | undefined {
  for (const node of nodes) {
    if (isText(node)) continue
    if (node.tag === tag) return node
    const found = findElement(node.children, tag)
    if (found) return found
  }
  return undefined
}

function collect(
  element: XmlElement,
  ancestors: string[],
  listDepth: number,
  listTag: string | null,
  suppressUnits: boolean,
  view: {
    units: PublicationUnit[]
    links: PublicationLink[]
    assets: PublicationAsset[]
    idText: Record<string, string>
    authors: string[]
  },
) {
  if (element.tag === 'head') return
  const classes = classNames(element)
  // The two modes publish different document envelopes: the legacy mode
  // renders the research-paper metadata block and the Struct mode renders
  // the document metadata block. Neither envelope is publication content, so
  // it is read for the metadata it carries and never compared as content.
  const isEnvelope =
    element.tag === 'header' || classes.includes('reconstructed-byline')
  const isUnit = UNIT_TAGS.has(element.tag)
  const text = canonicalText(ownText(element))
  const id = element.attributes['id'] ?? null
  if (id) view.idText[id] = canonicalText(ownText(element, true))
  if (classes.includes('authors')) {
    view.authors.push(text)
    return
  }
  if (isUnit && text.length > 0 && !suppressUnits && !isEnvelope) {
    view.units.push({
      kind: unitKind(element, ancestors),
      text,
      id,
      markup: ownMarkup(element),
      listDepth,
      listTag,
    })
  }
  if (element.tag === 'a' && element.attributes['href']) {
    view.links.push({
      href: element.attributes['href'],
      text,
      internal: element.attributes['href'].startsWith('#'),
    })
  }
  if (element.tag === 'img') {
    view.assets.push({
      src: element.attributes['src'] ?? '',
      alt: element.attributes['alt'] ?? '',
    })
  }
  if (element.tag === 'object') {
    view.assets.push({
      src: element.attributes['data'] ?? '',
      alt: element.attributes['aria-label'] ?? '',
    })
  }
  const nextAncestors = isUnit ? [...ancestors, element.tag] : ancestors
  const nextListDepth = LIST_TAGS.has(element.tag) ? listDepth + 1 : listDepth
  const nextListTag = LIST_TAGS.has(element.tag) ? element.tag : listTag
  const nextSuppress = suppressUnits || isEnvelope
  for (const child of element.children) {
    if (isText(child)) continue
    collect(
      child,
      nextAncestors,
      nextListDepth,
      nextListTag,
      nextSuppress,
      view,
    )
  }
}

/**
 * Read the rendered publication into the mode-agnostic view.
 */
export function publicationView(xhtml: string): PublicationView {
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    preserveOrder: true,
    trimValues: false,
  }).parse(xhtml) as unknown[]
  const nodes = parsed.flatMap(parseNodes)
  const body = findElement(nodes, 'body')
  const title = findElement(nodes, 'title')
  const view = {
    units: [] as PublicationUnit[],
    links: [] as PublicationLink[],
    assets: [] as PublicationAsset[],
    idText: {} as Record<string, string>,
    authors: [] as string[],
  }
  if (body) collect(body, [], 0, null, false, view)
  return {
    title: title ? canonicalText(ownText(title)) : '',
    authors: view.authors,
    units: view.units,
    links: view.links,
    assets: view.assets,
    idText: view.idText,
  }
}

/**
 * Resolve every internal link to the canonical text of the element it points
 * at. The legacy ids (`fn-docx-1`) and the Struct ids (`struct-block-...`)
 * are presentational aliases of the same anchor, so the resolved TARGET is
 * what the two modes must agree on.
 */
export function internalTargets(view: PublicationView) {
  return view.links
    .filter((link) => link.internal)
    .map((link) => ({
      href: link.href,
      text: link.text,
      target: view.idText[link.href.slice(1)] ?? null,
    }))
}

export function externalLinks(view: PublicationView) {
  return view.links.filter((link) => !link.internal)
}

function differences<T>(
  legacy: T[],
  struct: T[],
  signature: (value: T) => string,
): UnitDifference[] {
  const found: UnitDifference[] = []
  const length = Math.max(legacy.length, struct.length)
  for (let index = 0; index < length; index += 1) {
    const left = legacy[index] === undefined ? null : signature(legacy[index]!)
    const right = struct[index] === undefined ? null : signature(struct[index]!)
    if (left !== right) found.push({ index, legacy: left, struct: right })
  }
  return found
}

/**
 * Compare two rendered publications of the same content.
 */
export function comparePublications(
  legacy: PublicationView,
  struct: PublicationView,
): PublicationComparison {
  const unitDifferences = differences(
    legacy.units,
    struct.units,
    (unit) => unitSignature(unit) ?? '',
  )
  const markupDifferences: MarkupDifference[] = []
  legacy.units.forEach((unit, index) => {
    const counterpart = struct.units[index]
    if (!counterpart) return
    // Only units that are the same published content are compared for their
    // inline marks; a shifted unit is reported by the unit differences.
    if (unitSignature(unit) !== unitSignature(counterpart)) return
    if (unit.markup.join(',') === counterpart.markup.join(',')) return
    markupDifferences.push({
      index,
      legacy: unit.markup,
      struct: counterpart.markup,
    })
  })
  const assetDifferences = differences(
    legacy.assets,
    struct.assets,
    (asset) => `${asset.src}|${asset.alt}`,
  )
  const externalLinkDifferences = differences(
    externalLinks(legacy),
    externalLinks(struct),
    (link) => `${link.href}|${link.text}`,
  )
  const internalTargetDifferences = differences(
    internalTargets(legacy),
    internalTargets(struct),
    (target) => `${target.text}->${target.target ?? 'missing'}`,
  )
  return {
    legacy,
    struct,
    unitsEqual: unitDifferences.length === 0,
    unitDifferences,
    markupDifferences,
    assetsEqual: assetDifferences.length === 0,
    assetDifferences,
    externalLinksEqual: externalLinkDifferences.length === 0,
    externalLinkDifferences,
    internalTargetsEqual: internalTargetDifferences.length === 0,
    internalTargetDifferences,
  }
}

/** Bounded readonly comparison of already published fragments. No Markdown renderer, network or DOM privileges. */
import { readPublishedHistoryHtml } from './book-history-safe-html'
import { parseFragment, serialize, defaultTreeAdapter } from 'parse5'
export const LIMITS = Object.freeze({
  units: 512,
  blockCells: 250000,
  tokens: 100000,
  wordCells: 1000000,
  totalWordCells: 4000000,
  canonicalChars: 16 * 1024 * 1024,
  hashChars: 32 * 1024 * 1024,
  internProbes: 1000000,
  equalityChars: 64 * 1024 * 1024,
  similarityVisits: 1000000,
})
type Node = any
type Work = {
  canonicalChars: number
  hashChars: number
  internProbes: number
  equalityChars: number
  similarityVisits: number
  tokenChars: number
  tokens: number
  blockCells: number
  wordCells: number
  matrixBytes: number
  matrices: number
}
type Unit = {
  node: Node
  visualId: number
  kind: string
  key: string
  id: number
  structureId: number
  text: string
  complex: boolean
  tokens: number[]
  tokenText: string[]
  words: Map<number, number>
  wordCount: number
  tags: string[]
  links: string[]
  formatIds: number[]
}
class Limit extends Error {}
function limit(ok: boolean, reason: string): asserts ok {
  if (!ok) throw new Limit(reason)
}
function hash(value: string, work: Work) {
  limit(
    work.hashChars + value.length <= LIMITS.hashChars,
    'hash character budget',
  )
  let h = 2166136261
  work.hashChars += value.length
  for (let i = 0; i < value.length; i++)
    h = Math.imul(h ^ value.charCodeAt(i), 16777619)
  return h >>> 0
}
class Intern {
  private buckets = new Map<number, { value: string; id: number }[]>()
  private next = 0
  constructor(private work: Work) {}
  get(value: string) {
    const key = hash(value, this.work),
      bucket = this.buckets.get(key) ?? []
    for (const row of bucket) {
      limit(
        ++this.work.internProbes <= LIMITS.internProbes,
        'intern bucket probe budget',
      )
      if (row.value.length !== value.length) continue
      limit(
        this.work.equalityChars + value.length <= LIMITS.equalityChars,
        'full-string equality budget',
      )
      this.work.equalityChars += value.length
      if (row.value === value) return row.id
    }
    const id = this.next++
    bucket.push({ value, id })
    this.buckets.set(key, bucket)
    return id
  }
}
function attr(node: Node, name: string) {
  return node.attrs?.find((a: any) => a.name === name)?.value
}
function assertHistoricalDecorations(tree: Node) {
  const stack: Node[] = [tree]
  while (stack.length) {
    const node = stack.pop()!
    if (
      (attr(node, 'class') ?? '')
        .split(/\s+/)
        .some((name: string) => name.startsWith('history-diff-'))
    )
      throw Error('Generated history decorations are not historical input.')
    for (const child of node.childNodes ?? []) stack.push(child)
  }
}
function treeUnits(tree: Node, work: Work, semantic: Intern, words: Intern) {
  const markerPaths = new Map<string, string>()
  function index(node: Node, scope: string, position: string) {
    if (node.tagName === 'svg') {
      scope = position
      position = 'svg'
    }
    if (node.tagName === 'marker') markerPaths.set(attr(node, 'id'), position)
    for (const [i, child] of (node.childNodes ?? []).entries())
      index(child, scope, position + '/' + i)
  }
  index(tree, '', 'root')
  limit(typeof Intl.Segmenter === 'function', 'word segmentation unavailable')
  const segmenter = new Intl.Segmenter('en', { granularity: 'word' })
  const units: Unit[] = []
  for (const node of tree.childNodes) {
    limit(units.length < LIMITS.units, 'unit count')
    const tags: string[] = [],
      links: string[] = []
    let text = '',
      complex = false
    const kind =
      attr(node, 'data-block-kind') ??
      ('tagName' in node ? node.tagName : '#text')
    if (
      [
        'figure',
        'problem',
        'exercise',
        'run',
        'card',
        'solution',
        'hints',
        '#text',
      ].includes(kind)
    )
      complex = true
    function canonical(
      n: Node,
      mode: 'full' | 'structure' | 'visible' = 'full',
    ): unknown {
      const structure = mode === 'structure'
      if (n.nodeName === '#text') {
        if (mode === 'full') text += n.value
        return ['text', structure ? '' : n.value]
      }
      if (mode === 'full') {
        tags.push(n.tagName)
        if (['svg', 'table', 'pre', 'details', 'figure'].includes(n.tagName))
          complex = true
        const link = attr(n, 'data-history-link-destination')
        if (link !== undefined) links.push(link)
      }
      const attributes = []
      for (const a of n.attrs ?? []) {
        if (
          a.name === 'id' ||
          (mode === 'visible' && a.name === 'data-block-digest')
        )
          continue // every published ID is view-generated
        let value = a.value
        if (a.name === 'marker-end')
          value = ['local-marker', markerPaths.get(a.value.slice(5, -1))]
        if (structure && a.name === 'data-block-digest')
          value = 'derived-block-signature'
        attributes.push([a.name, value])
      }
      return [
        n.namespaceURI,
        n.tagName,
        attributes,
        (n.childNodes ?? []).map((child: Node) => canonical(child, mode)),
      ]
    }
    const key = JSON.stringify(canonical(node)),
      structure = JSON.stringify(canonical(node, 'structure')),
      visible = JSON.stringify(canonical(node, 'visible'))
    // Finite label signatures are interned and charged like all other full
    // strings. Each bounded tree contributes only these four linear scans.
    const formatKeys = [
      tags.filter((tag) => /^h[1-4]$/.test(tag)),
      tags.filter((tag) => ['em', 'strong', 'b'].includes(tag)),
      tags.filter((tag) => ['ul', 'ol', 'li', 'dl', 'dt', 'dd'].includes(tag)),
      links,
    ].map((value) => JSON.stringify(value))
    work.canonicalChars +=
      key.length +
      structure.length +
      visible.length +
      formatKeys.reduce((n, key) => n + key.length, 0)
    limit(
      work.canonicalChars <= LIMITS.canonicalChars,
      'canonical character budget',
    )
    const id = semantic.get(key),
      structureId = semantic.get(structure),
      visualId = semantic.get(visible),
      formatIds = formatKeys.map((key) => semantic.get(key)),
      tokenText: string[] = [],
      tokens: number[] = [],
      frequency = new Map<number, number>()
    let wordCount = 0
    work.tokenChars += text.length
    for (const token of segmenter.segment(text)) {
      limit(++work.tokens <= LIMITS.tokens * 2, 'total token count')
      tokenText.push(token.segment)
      const value = words.get(token.segment)
      tokens.push(value)
      if (token.isWordLike) {
        frequency.set(value, (frequency.get(value) ?? 0) + 1)
        wordCount++
      }
    }
    units.push({
      node,
      visualId,
      kind,
      key,
      id,
      structureId,
      text,
      complex,
      tokens,
      tokenText,
      words: frequency,
      wordCount,
      tags,
      links,
      formatIds,
    })
  }
  limit(
    units.reduce((n, u) => n + u.tokens.length, 0) <= LIMITS.tokens,
    'per-version token count',
  )
  return units
}
function lcs(a: number[], b: number[], work: Work, word: boolean) {
  const cells = (a.length + 1) * (b.length + 1)
  if (word) {
    limit(cells <= LIMITS.wordCells, 'pair token matrix budget')
    limit(
      work.wordCells + cells <= LIMITS.totalWordCells,
      'selection token matrix budget',
    )
    work.wordCells += cells
  } else {
    limit(cells <= LIMITS.blockCells, 'block matrix budget')
    work.blockCells += cells
  }
  work.matrixBytes += cells * 4
  work.matrices++
  const table = new Uint32Array(cells),
    width = b.length + 1
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j]
          ? 1 + table[(i + 1) * width + j + 1]
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
  const pairs: [number, number][] = []
  let i = 0,
    j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i++, j++])
      continue
    }
    if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++
    else j++ // deterministic skip-left tie
  }
  return pairs
}
function similarity(a: Unit, b: Unit, work: Work) {
  const [small, large] =
    a.words.size <= b.words.size ? [a.words, b.words] : [b.words, a.words]
  limit(
    work.similarityVisits + small.size <= LIMITS.similarityVisits,
    'similarity token-visit budget',
  )
  work.similarityVisits += small.size
  let intersection = 0
  for (const [id, count] of small)
    intersection += Math.min(count, large.get(id) ?? 0)
  const count = a.wordCount + b.wordCount
  return { numerator: 2 * intersection, denominator: count }
}
function tokens(a: Unit, b: Unit, work: Work) {
  const anchors = lcs(a.tokens, b.tokens, work, true),
    ops: { kind: string; text: string }[] = []
  let ai = 0,
    bi = 0
  for (const [x, y] of [
    ...anchors,
    [a.tokens.length, b.tokens.length] as [number, number],
  ]) {
    while (ai < x) ops.push({ kind: 'remove', text: a.tokenText[ai++] })
    while (bi < y) ops.push({ kind: 'add', text: b.tokenText[bi++] })
    if (x < a.tokens.length) {
      ops.push({ kind: 'keep', text: a.tokenText[x] })
      ai++
      bi++
    }
  }
  return ops
}
export function diffHistoryHtml(left: string, right: string) {
  const before = readPublishedHistoryHtml(left, 'history-before').html,
    after = readPublishedHistoryHtml(right, 'history-after').html
  const beforeTree = parseFragment(before),
    afterTree = parseFragment(after)
  // Refusing detailed alignment never grants a looser display grammar. Check
  // both complete inputs before entering any resource-fallback path.
  assertHistoricalDecorations(beforeTree)
  assertHistoricalDecorations(afterTree)
  const work: Work = {
    canonicalChars: 0,
    hashChars: 0,
    internProbes: 0,
    equalityChars: 0,
    similarityVisits: 0,
    tokenChars: 0,
    tokens: 0,
    blockCells: 0,
    wordCells: 0,
    matrixBytes: 0,
    matrices: 0,
  }
  try {
    const semantic = new Intern(work),
      words = new Intern(work),
      a = treeUnits(beforeTree, work, semantic, words),
      b = treeUnits(afterTree, work, semantic, words)
    const anchors = lcs(
        a.map((u) => u.id),
        b.map((u) => u.id),
        work,
        false,
      ),
      matches: any[] = []
    let startA = 0,
      startB = 0
    const pairedA = new Set<number>(),
      pairedB = new Set<number>()
    for (const [endA, endB] of [
      ...anchors,
      [a.length, b.length] as [number, number],
    ]) {
      let nextB = startB
      for (let i = startA; i < endA; i++) {
        let best = -1,
          score = { numerator: 0, denominator: 1 }
        for (let j = nextB; j < endB; j++) {
          if (a[i].kind !== b[j].kind) continue
          const current =
            a[i].visualId === b[j].visualId
              ? { numerator: 1, denominator: 1 }
              : similarity(a[i], b[j], work)
          if (
            !current.denominator ||
            current.numerator * 2 < current.denominator
          )
            continue
          if (
            best < 0 ||
            current.numerator * score.denominator >
              score.numerator * current.denominator
          ) {
            best = j
            score = current
          }
        }
        if (best < 0) continue
        const old = a[i],
          fresh = b[best],
          complex = old.complex || fresh.complex,
          format = old.structureId !== fresh.structureId
        const metadata = old.visualId === fresh.visualId
        matches.push({
          kind: metadata
            ? 'metadata'
            : complex
              ? 'complex'
              : format
                ? 'format'
                : 'text',
          a: i,
          b: best,
          formatChanged: format,
          formatLabel:
            ['Heading', 'Emphasis', 'List', 'Link destination']
              .filter((_, i) => old.formatIds[i] !== fresh.formatIds[i])
              .map((label) => label + ' changed.')
              .join(' ') || 'Block structure changed.',
          ops: metadata || complex || format ? null : tokens(old, fresh, work),
          beforeText: old.text,
          afterText: fresh.text,
        })
        pairedA.add(i)
        pairedB.add(best)
        nextB = best + 1
      }
      if (endA < a.length) {
        matches.push({ kind: 'equal', a: endA, b: endB })
        pairedA.add(endA)
        pairedB.add(endB)
      }
      startA = endA + 1
      startB = endB + 1
    }
    const removed = a.map((_, i) => i).filter((i) => !pairedA.has(i)),
      added = b.map((_, i) => i).filter((i) => !pairedB.has(i))
    const metadataChanged = matches.some((m) => m.kind === 'metadata')
    const changed =
      removed.length > 0 ||
      added.length > 0 ||
      matches.some((m) => !['equal', 'metadata'].includes(m.kind))
    for (const match of matches) {
      if (match.kind === 'text') {
        decorateText(a[match.a].node, match.ops, 'before')
        decorateText(b[match.b].node, match.ops, 'after')
      } else if (match.kind === 'complex' || match.kind === 'format') {
        decorateBlock(a[match.a].node, 'before', match.kind, match.formatLabel)
        decorateBlock(b[match.b].node, 'after', match.kind, match.formatLabel)
      }
    }
    removed.forEach((i) => decorateBlock(a[i].node, 'before', 'removed'))
    added.forEach((i) => decorateBlock(b[i].node, 'after', 'added'))
    return {
      mode: 'detailed' as const,
      before: serialize(beforeTree),
      after: serialize(afterTree),
      work,
      changed,
      metadataChanged,
      notice: !changed
        ? metadataChanged
          ? 'Source metadata changed; rendered content unchanged.'
          : 'No changes.'
        : 'Changes are marked in both versions.',
    }
  } catch (error) {
    if (!(error instanceof Limit)) throw error
    return {
      mode: 'coarse' as const,
      reason: error.message,
      before,
      after,
      work,
      changed: null,
      metadataChanged: false,
      notice:
        'Detailed comparison unavailable for this size. Both complete versions are shown.',
    }
  }
}

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'
/** These constructors are the entire generated decoration grammar. Historical
 * input is validated before any constructor is called and cannot supply attrs. */
function generated(
  tag: 'ins' | 'del' | 'section' | 'p',
  className: string,
  children: Node[],
): Node {
  const attrs = [{ name: 'class', value: className }]
  if (tag === 'p') attrs.push({ name: 'role', value: 'note' })
  const node = defaultTreeAdapter.createElement(
    tag,
    HTML_NAMESPACE as any,
    attrs,
  )
  for (const child of children) defaultTreeAdapter.appendChild(node, child)
  return node
}
function literal(value: string): Node {
  return { nodeName: '#text', value, parentNode: null }
}
function decorateBlock(
  node: Node,
  side: 'before' | 'after',
  kind: string,
  formatLabel = 'Block structure changed.',
) {
  const parent = node.parentNode,
    index = parent.childNodes.indexOf(node)
  const label =
    kind === 'complex'
      ? 'Complex content changed.'
      : kind === 'format'
        ? formatLabel
        : side === 'before'
          ? 'Removed block.'
          : 'Added block.'
  const wrapper = generated(
    'section',
    'history-diff-block history-diff-' + side,
    [],
  )
  defaultTreeAdapter.appendChild(
    wrapper,
    generated('p', 'history-diff-format', [literal(label)]),
  )
  defaultTreeAdapter.appendChild(wrapper, node)
  wrapper.parentNode = parent
  parent.childNodes[index] = wrapper
}
function decorateText(
  root: Node,
  ops: { kind: string; text: string }[],
  side: 'before' | 'after',
) {
  const intervals: { start: number; end: number }[] = []
  let position = 0
  for (const op of ops) {
    if (op.kind === (side === 'before' ? 'add' : 'remove')) continue
    const end = position + op.text.length
    if (op.kind === (side === 'before' ? 'remove' : 'add')) {
      const last = intervals.at(-1)
      if (last && last.end === position) last.end = end
      else intervals.push({ start: position, end })
    }
    position = end
  }
  let offset = 0,
    cursor = 0
  function visit(node: Node) {
    for (const child of [...(node.childNodes ?? [])]) {
      if (child.nodeName !== '#text') {
        visit(child)
        continue
      }
      const start = offset,
        end = start + child.value.length
      offset = end
      while (cursor < intervals.length && intervals[cursor].end <= start)
        cursor++
      let scan = cursor,
        at = start
      const replacement: Node[] = []
      while (scan < intervals.length && intervals[scan].start < end) {
        const mark = intervals[scan],
          lo = Math.max(at, mark.start),
          hi = Math.min(end, mark.end)
        if (lo > at)
          replacement.push(literal(child.value.slice(at - start, lo - start)))
        if (hi > lo)
          replacement.push(
            generated(
              side === 'before' ? 'del' : 'ins',
              side === 'before' ? 'history-diff-remove' : 'history-diff-add',
              [literal(child.value.slice(lo - start, hi - start))],
            ),
          )
        at = hi
        scan++
      }
      if (!replacement.length) continue
      if (at < end) replacement.push(literal(child.value.slice(at - start)))
      const index = node.childNodes.indexOf(child)
      replacement.forEach((n) => (n.parentNode = node))
      node.childNodes.splice(index, 1, ...replacement)
    }
  }
  // A top-level text unit cannot contain markup; wrap it temporarily only for
  // traversal, then splice its children back into the original fragment.
  if (root.nodeName === '#text') return
  visit(root)
}

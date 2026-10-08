import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

async function api() {
  const url = new URL('./book-history-safe-html.ts', import.meta.url)
  const module = existsSync(url) ? await import(/* @vite-ignore */ url.href) : {}
  expect(module.safeHistoryHtml).toBeTypeOf('function')
  return module as { safeHistoryHtml: (...args: any[]) => any; validateHistoryCss: (...args: any[]) => string }
}
const svg = '<svg viewBox="0 0 30 20" class="links" role="img"><defs><marker id="link-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#94a3b8"></path></marker></defs><line x1="0" y1="1" x2="10" y2="1" stroke="#94a3b8" marker-end="url(#link-arrow)"></line></svg>'
describe('rendered publication finite profile RED families', () => {
  it('preserves text/formatting/disclosures and independently scoped SVG figures', async () => {
    const { safeHistoryHtml } = await api()
    const input = '<div class="block" data-block-kind="prose" data-block-digest="012345abcdef" id="prose-1"><p>Literal &lt;x&gt; <strong>bold</strong> and <em>emphasis</em>.</p><details><summary>Hint</summary><pre><code>print(&quot;hello&quot;)</code></pre></details></div>' + svg + svg
    const result = safeHistoryHtml(input, 'h-fixture')
    expect(result.html).toContain('<strong>bold</strong>')
    expect(result.html).toContain('Literal &lt;x&gt;')
    expect(result.html).toContain('<details>')
    expect(result.blocks).toHaveLength(1)
    const ids = [...result.html.matchAll(/ id="([^"]+)"/g)].map((x: any) => x[1])
    expect(new Set(ids).size).toBe(ids.length)
    for (const reference of result.html.matchAll(/marker-end="url\(#([^)]*)\)"/g)) expect(ids).toContain(reference[1])
  })
  it('emits only the closed inert link carrier and refuses active/unknown shapes', async () => {
    const { safeHistoryHtml } = await api()
    const result = safeHistoryHtml('<p><a href="//example.invalid/path?a=1&amp;b=2">link</a></p>', 'h-link')
    expect(result.html).toContain('data-history-link-destination="//example.invalid/path?a=1&amp;b=2"')
    expect(result.html).not.toMatch(/\shref=/)
    for (const markup of ['<script>inert fixture</script>', '<img src="/fixture.png">', '<p onclick="fixture">text</p>', '<svg><foreignObject><p>text</p></foreignObject></svg>', '<p data-unknown="x">text</p>']) {
      expect(() => safeHistoryHtml(markup, 'h-refuse')).toThrow()
    }
  })
  it('bounds malformed input and rejects CSS capability tokens without rejecting var', async () => {
    const { safeHistoryHtml, validateHistoryCss } = await api()
    expect(() => safeHistoryHtml('<p id="a" id="b">x</p>', 'h-duplicate')).toThrow()
    expect(() => safeHistoryHtml('<div>'.repeat(129) + 'x' + '</div>'.repeat(129), 'h-depth')).toThrow()
    expect(() => safeHistoryHtml('x'.repeat(4 * 1024 * 1024 + 1), 'h-size')).toThrow()
    expect(validateHistoryCss(':root { --ink:#111; } p { color:var(--ink); }')).toContain('var(--ink)')
    for (const css of ['p{background:url(/fixture)}', 'p{background:u\\72l(/fixture)}', '@import "fixture";', 'p{color:red}</style>']) expect(() => validateHistoryCss(css)).toThrow()
  })
})

// Owned payloads are data; only the current reviewed renderer is imported.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseFragment } from 'parse5'
import { scopeContentCss } from './books'
const root = fileURLToPath(new URL('../../', import.meta.url))
const textHash = (value: string) => createHash('sha256').update(value).digest('hex')
const doc = (body: string, kind = 'concept', id = 'example') => `+++\nid = "${id}"\nkind = "${kind}"\ntitle = "Historical π title"\n+++\n${body}`
function currentRender(body: string, extras: Record<string, string> = {}, source = 'books/chapters/example.md', kind = 'concept') {
  const files = { [source]: doc(body, kind), ...extras }
  const payload = { schemaVersion: 1, sourcePath: source, files: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', content, sha256: textHash(content) })) }
  return JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-B', root + '/books/tools/history_render.py'], {
    cwd: root, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, input: JSON.stringify(payload), encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  }))
}
function textNodes(html: string): string[] {
  const tree = parseFragment(html), result: string[] = [], stack: any[] = [tree]
  while (stack.length) { const node = stack.pop(); if (node.nodeName === '#text') result.push(node.value); if (node.childNodes) stack.push(...[...node.childNodes].reverse()) }
  return result
}
const figures = [
  { type: 'cells', cells: [{ label: 'x', note: 'y' }] },
  { type: 'walk', sequence: [1, 2], state: [{ label: 'sum', values: [1, 3] }] },
  { type: 'table', header: ['a'], rows: [[1]] },
  { type: 'cost', x: { values: [1, 2] }, series: [{ label: 'a', values: [1, 2] }] },
  { type: 'links', nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] },
]
describe('actual trusted current-renderer small data pilots', () => {
  it.each([
    ['concept', '## Heading\n\n**Bold** and *emphasis*, literal <tag>, π.\n\n[External](https://example.invalid)\n\n> Quoted\n', {}, 'books/chapters/example.md', 'concept'],
    ['tables and code', '| One | Two |\n| --- | --- |\n| old | new |\n\n```python\nprint("fixture")\n```\n', {}, 'books/chapters/example.md', 'concept'],
    ['all five figures', figures.map((_, n) => `:::figure{id="f${n}"}\n:::\n`).join('') + ':::figure{id="f4"}\n:::\n', Object.fromEntries(figures.map((value, n) => [`books/figures/f${n}.json`, JSON.stringify(value)])), 'books/chapters/example.md', 'concept'],
    ['readonly challenge and exercise', ':::run\n:::\n:::exercise{id="sample"}\nPrint a value.\n```python\nprint(1)\n```\n```output\n1\n```\n```answer\nprint(1)\n```\n:::\n', { 'books/challenges/example/starter.py': "print('historical')\n" }, 'books/challenges/example/challenge.md', 'challenge'],
    ['legacy include', ':::problem{id="included"}\n:::\n:::run{starter="starter.py"}\n:::\n', { 'challenges/included/challenge.md': doc(':::statement\nAn older problem.\n:::\n', 'challenge', 'included'), 'challenges/example/starter.py': "print('data only')\n" }, 'challenges/example/challenge.md', 'challenge'],
  ] as const)('%s preserves visible text and canonical block descriptors', async (_, body, extras, source, kind) => {
    const { safeHistoryHtml } = await api(), rendered = currentRender(body, extras, source, kind)
    const safe = safeHistoryHtml(rendered.html, 'h-canonical')
    expect(textNodes(safe.html)).toEqual(textNodes(rendered.html))
    expect(safe.blocks.map(({ kind, id, digest }: any) => ({ kind, id, digest }))).toEqual(rendered.blocks)
    expect(safe.html).not.toMatch(/<(?:script|input|button|textarea|form)\b|\shref=/)
    expect(safe.html.length).toBeGreaterThan(0)
    const read = await publishedReader(), view = read(safe.html, 'view-canonical')
    expect(textNodes(view.html)).toEqual(textNodes(safe.html))
    expect(view.blocks.map(block => block.id)).toEqual(safe.blocks.map((block: any) => block.domId))
  })
  it('accepts the actual current content stylesheet before and after existing scoping', async () => {
    const { validateHistoryCss } = await api()
    const css = execFileSync('/usr/bin/python3', ['-I', '-B', '-c', 'import sys;sys.path.insert(0,sys.argv[1]);import render;sys.stdout.write(render.CONTENT_CSS)', root + '/books/tools'], { cwd: root, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 })
    expect(validateHistoryCss(css)).toBe(css)
    const scoped = scopeContentCss(css, '.history-content')
    expect(validateHistoryCss(scoped)).toBe(scoped)
  })
})

it('binds fragment destinations and SVG references without cross-figure ambiguity', async () => {
  const { safeHistoryHtml } = await api()
  const safe = safeHistoryHtml('<h2 id="title">Title</h2><a href="#title">Read</a>', 'h-fragment')
  expect(safe.html).toContain('data-history-link-destination="#title"')
  for (const html of [
    '<h2 id="title">A</h2><h2 id="title">B</h2><a href="#title">Ambiguous</a>',
    '<a href="#missing">Missing</a>', '<a href="#%zz">Malformed</a>',
    '<svg><line marker-end="url(#absent)"></line></svg>',
    '<svg><marker id="m"></marker></svg><svg><line marker-end="url(#m)"></line></svg>',
    '<svg><marker id="m"></marker><marker id="m"></marker><line marker-end="url(#m)"></line></svg>',
    '<p data-history-link-destination="/x">Wrong carrier</p>', '<a data-history-link-destination="/x">Not input</a>',
  ]) expect(() => safeHistoryHtml(html, 'h-reference')).toThrow()
})
it('enforces the exact UTF-8 byte ceiling and rejects malformed encoding', async () => {
  const { safeHistoryHtml, validateHistoryCss } = await api()
  expect(safeHistoryHtml('π'.repeat(2 * 1024 * 1024), 'h-exact').html.length).toBe(2 * 1024 * 1024)
  expect(() => safeHistoryHtml('π'.repeat(2 * 1024 * 1024) + 'x', 'h-over')).toThrow()
  expect(() => safeHistoryHtml('\ud800', 'h-encoding')).toThrow()
})
it('enforces the depth ceiling without truncating accepted nesting', async () => {
  const { safeHistoryHtml, validateHistoryCss } = await api()
  expect(safeHistoryHtml('<div>'.repeat(127) + 'x' + '</div>'.repeat(127), 'h-depth').html).toContain('x')
})
it('enforces the node ceiling without silently truncating', async () => {
  const { safeHistoryHtml, validateHistoryCss } = await api()
  expect(() => safeHistoryHtml('<p>x</p>'.repeat(50001), 'h-nodes')).toThrow(/node\/depth/)
})
it('enforces the CSS byte ceiling without silently truncating', async () => {
  const { safeHistoryHtml, validateHistoryCss } = await api()
  expect(validateHistoryCss(' '.repeat(65536))).toHaveLength(65536)
  expect(() => validateHistoryCss(' '.repeat(65537))).toThrow()
})
it('enforces the attribute byte ceiling without silently truncating', async () => {
  const { safeHistoryHtml, validateHistoryCss } = await api()
  expect(safeHistoryHtml('<a href="/' + 'x'.repeat(4095) + '">x</a>', 'h-attr').html).toContain('data-history-link-destination')
  expect(() => safeHistoryHtml('<a href="/' + 'x'.repeat(4096) + '">x</a>', 'h-attr')).toThrow()
})

async function publishedReader() {
  const module = await import('./book-history-safe-html')
  expect((module as any).readPublishedHistoryHtml).toBeTypeOf('function')
  return (module as any).readPublishedHistoryHtml as (source: string, namespace: string) => { html: string; blocks: { kind: string; id: string; digest: string; domId: string }[] }
}
function elementAttributes(html: string, name: string): string[] {
  const result: string[] = [], stack: any[] = [parseFragment(html)]
  while (stack.length) {
    const node = stack.pop()
    for (const attr of node.attrs ?? []) if (attr.name === name) result.push(attr.value)
    if (node.childNodes) stack.push(...[...node.childNodes].reverse())
  }
  return result
}
describe('published output reader prerequisite', () => {
  it('preserves every inert carrier spelling and never reconstructs navigation', async () => {
    const { safeHistoryHtml } = await api(), read = await publishedReader()
    const canonical = '<h2 id="title">Title</h2>' + [
      '#title', '#%74itle', '/books/example/', 'https://example.invalid/?a=&quot;x&quot;&amp;b=π', 'http://example.invalid/', '//example.invalid/path',
    ].map(destination => `<a href="${destination}">Label &amp; 🧭</a>`).join('')
    const published = safeHistoryHtml(canonical, 'h-published')
    const output = read(published.html, 'view-left')
    expect(elementAttributes(output.html, 'data-history-link-destination')).toEqual(elementAttributes(published.html, 'data-history-link-destination'))
    expect(elementAttributes(output.html, 'href')).toEqual([])
    expect(textNodes(output.html)).toEqual(textNodes(published.html))
    expect(elementAttributes(output.html, 'id')).toEqual(['view-left-0'])
  })
  it('creates disjoint view IDs and keeps both figures marker references local', async () => {
    const { safeHistoryHtml } = await api(), read = await publishedReader()
    const published = safeHistoryHtml(svg + svg, 'h-published')
    const left = read(published.html, 'view-left'), right = read(published.html, 'view-right')
    const ids = [...elementAttributes(left.html, 'id'), ...elementAttributes(right.html, 'id')]
    expect(new Set(ids).size).toBe(ids.length)
    for (const [output, prefix] of [[left, 'view-left-'], [right, 'view-right-']] as const) {
      const ownIds = elementAttributes(output.html, 'id')
      expect(ownIds.every(id => id.startsWith(prefix))).toBe(true)
      expect(elementAttributes(output.html, 'marker-end')).toEqual(ownIds.map(id => `url(#${id})`))
      expect(textNodes(output.html)).toEqual(textNodes(published.html))
    }
  })
  it('refuses all duplicate published IDs and missing/cross-scope marker references', async () => {
    const read = await publishedReader()
    for (const html of [
      '<p id="same">A</p><p id="same">B</p>',
      '<svg><marker id="same"></marker></svg><svg><marker id="same"></marker></svg>',
      '<svg><marker id="m"></marker></svg><svg><line marker-end="url(#m)"></line></svg>',
      '<svg><line marker-end="url(#absent)"></line></svg>',
      '<svg><g id="wrong"></g><line marker-end="url(#wrong)"></line></svg>',
    ]) expect(() => read(html, 'view-refused')).toThrow()
  })
  it('shares the closed profile and resource limits without admitting href or capabilities', async () => {
    const read = await publishedReader()
    for (const html of [
      '<a href="/fixture">Navigation</a>', '<a href="/fixture" data-history-link-destination="/fixture">Mixed</a>',
      '<p data-history-link-destination="/fixture">Wrong tag</p>', '<a data-history-link-destination="relative">Unsupported spelling</a>',
      '<p data-other="fixture">Unknown</p>', '<img src="/fixture">', '<script>fixture</script>',
      '<svg><foreignObject><p>Fixture</p></foreignObject></svg>', '<svg><line marker-end="url(/fixture)"></line></svg>',
      '<svg width="1e309"></svg>', '<p style="color:red">Inline style</p>',
      '<a data-history-link-destination="/fixture&#10;other">Control</a>',
      '<div>'.repeat(129) + 'x' + '</div>'.repeat(129), 'x'.repeat(4 * 1024 * 1024 + 1),
    ]) expect(() => read(html, 'view-refused')).toThrow()
  })
  it('binds published block IDs to fresh view IDs while preserving source descriptors separately', async () => {
    const { safeHistoryHtml } = await api(), read = await publishedReader()
    const canonical = '<div class="block" data-block-kind="prose" data-block-digest="012345abcdef" id="source-block"><p>Old <strong>text</strong>.</p></div>'
    const published = safeHistoryHtml(canonical, 'h-published'), sourceDescriptors = JSON.stringify(published.blocks)
    const first = read(published.html, 'view-left')
    expect(first.blocks).toEqual([{ kind: 'prose', id: published.blocks[0].domId, digest: '012345abcdef', domId: 'view-left-0' }])
    expect(read(first.html, 'view-right').blocks).toEqual([{ kind: 'prose', id: 'view-left-0', digest: '012345abcdef', domId: 'view-right-0' }])
    expect(read(published.html, 'view-left')).toEqual(first)
    expect(JSON.stringify(published.blocks)).toBe(sourceDescriptors)
    expect(() => read(published.html, '../invalid')).toThrow()
    expect(() => safeHistoryHtml(published.html + '<a data-history-link-destination="/x">X</a>', 'h-default')).toThrow()
  })
})

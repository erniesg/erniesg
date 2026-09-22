/**
 * The book on the web: one renderer, durable routes, anchorable blocks.
 *
 * These tests exist to keep three promises. `render.py` stays the only thing
 * that emits block markup; the route comes from the path's `slug` and moves
 * only when that field does; and a block's DOM id is the same in the next
 * build as in this one, because annotations anchor to it.
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  bookManifest,
  documentUri,
  renderBookManifest,
  scopeContentCss,
  type BookManifest,
} from '../src/lib/books'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const DIST = path.join(ROOT, 'dist')
const SLUG = 'build-a-coding-agent'
const SAMPLE = 'ch12-hash-maps'
const PYTHON = process.env.CHALLENGES_PYTHON ?? 'python3'
const SLOW = { timeout: 180_000 }

const PY_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8' }

function python(source: string, args: string[] = []): string {
  return execFileSync(PYTHON, ['-c', source, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: PY_ENV,
    maxBuffer: 256 * 1024 * 1024,
  })
}

/** `render_node` called directly, with nothing between it and the assertion. */
const RENDER_ONE = `
import sys
sys.path.insert(0, "challenges/tools")
from render import load_book, render_node
_, order = load_book()
node = next(n for n in order if n["id"] == sys.argv[1])
reveal = sys.argv[4] if len(sys.argv) > 4 else "grader"
sys.stdout.write(
    render_node(node, sys.argv[2], runnable=sys.argv[3] == "yes", reveal=reveal)
)
`

/** Nodes carrying a steppable figure. */
const FIGURE_IDS = `
import sys, json
sys.path.insert(0, "challenges/tools")
from render import load_book, render_node
_, order = load_book()
ids = [
    n["id"]
    for n in order
    if "walk-controls" in render_node(n, "web", runnable=True)
]
json.dump(ids, sys.stdout)
`

/** Every node the tiers would gate: `contract` and `unaided`. */
const GATED_IDS = `
import sys, json
sys.path.insert(0, "challenges/tools")
from render import load_book
_, order = load_book()
json.dump([n["id"] for n in order if n.get("support") in ("contract", "unaided")], sys.stdout)
`

/** Render one node twice, with a block inserted ahead of its prose. */
const DIGEST_DRIFT = `
import sys
sys.path.insert(0, "challenges/tools")
from render import render_node, BLOCK_TAG
body = "alpha\\n\\n:::prose\\nbravo\\n:::\\n"
inserted = "alpha\\n\\n:::prose\\nINSERTED\\n:::\\n\\n:::prose\\nbravo\\n:::\\n"
def blocks(text):
    markup = render_node({"id": "n", "title": "T", "kind": "prose", "body": text}, "web")
    return {i: d for _, d, i in BLOCK_TAG.findall(markup)}
before, after = blocks(body), blocks(inserted)
shared = sorted(set(before) & set(after))
sys.stdout.write(
    "\\n".join(f"{i} {'drift' if before[i] != after[i] else 'same'}" for i in shared)
)
`

/** Nodes carrying a figure that needs no controller: a static SVG chart. */
const STATIC_CHART_IDS = `
import sys, json
sys.path.insert(0, "challenges/tools")
from render import load_book, render_node
_, order = load_book()
ids = [
    n["id"]
    for n in order
    if 'class="cost"' in render_node(n, "web", runnable=True)
]
json.dump(ids, sys.stdout)
`

/** The topic map as the manifest builds it, beside the pool it drew from. */
const TOPIC_MAP = `
import sys, json
sys.path.insert(0, "challenges/tools")
from render import load_book, all_nodes
from manifest import topic_entries
_, order = load_book()
json.dump(
    {
        "topics": topic_entries(order),
        "book": [n["id"] for n in order],
        "pool": sorted(all_nodes()),
    },
    sys.stdout,
)
`

const COUNT_POOL = `
import sys
sys.path.insert(0, "challenges/tools")
from render import all_nodes
sys.stdout.write(str(len(all_nodes())))
`

const manifest = bookManifest()
const book = manifest.books.find((entry) => entry.slug === SLUG)!
const bookDist = path.join(DIST, 'books', SLUG)
const builtSite = existsSync(bookDist)

function distPage(...parts: string[]): string {
  return readFileSync(path.join(DIST, ...parts, 'index.html'), 'utf8')
}

function blockIds(candidate: BookManifest): string[] {
  return candidate.books.flatMap((entry) =>
    entry.nodes.flatMap((node) => node.blocks.map((block) => `${node.id}/${block.id}`)),
  )
}

function renderIn(challenges: string): BookManifest {
  const stdout = execFileSync(PYTHON, [path.join(challenges, 'tools', 'manifest.py')], {
    cwd: challenges,
    encoding: 'utf8',
    env: PY_ENV,
    maxBuffer: 256 * 1024 * 1024,
  })
  return JSON.parse(stdout) as BookManifest
}

/** A throwaway copy of the node pool, so a test may edit the book's identity. */
function copyChallenges(): { challenges: string; cleanup: () => void } {
  const scratch = mkdtempSync(path.join(tmpdir(), 'challenges-'))
  cpSync(path.join(ROOT, 'challenges'), path.join(scratch, 'challenges'), {
    recursive: true,
    filter: (source) => !['dist', 'workspace', '__pycache__'].includes(path.basename(source)),
  })
  return {
    challenges: path.join(scratch, 'challenges'),
    cleanup: () => rmSync(scratch, { recursive: true, force: true }),
  }
}

describe('the node pool', () => {
  it('passes the book validator before anything is published', SLOW, () => {
    const report = execFileSync(PYTHON, ['challenges/tools/validate.py'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: PY_ENV,
    })

    expect(report).toContain('node(s) valid')
  })
})

describe('one renderer', () => {
  it('embeds render.py output verbatim, byte for byte', SLOW, () => {
    const direct = python(RENDER_ONE, [SAMPLE, 'web', 'no'])
    const node = book.nodes.find((entry) => entry.id === SAMPLE)!

    expect(Buffer.from(node.html)).toEqual(Buffer.from(direct))
    expect(direct.length).toBeGreaterThan(0)
  })

  it.skipIf(!builtSite)('ships that same markup in the Astro build output', () => {
    const node = book.nodes.find((entry) => entry.id === SAMPLE)!
    const page = distPage('books', SLUG, SAMPLE)

    expect(page).toContain(node.html)
  })

  it.skipIf(!builtSite)('re-renders nothing: every node page carries the rendered node', () => {
    for (const node of book.nodes) {
      expect(distPage('books', SLUG, node.id)).toContain(node.html)
    }
  })

  it('leaves the print edition untouched by the web-only block wrappers', SLOW, () => {
    const print = python(RENDER_ONE, [SAMPLE, 'print', 'yes'])

    expect(print).not.toContain('class="block"')
    expect(print).not.toContain('data-block-kind')
    expect(python(RENDER_ONE, [SAMPLE, 'web', 'no'])).toContain('data-block-kind')
  })

  it('shows a listing on the web wherever the EPUB shows one', SLOW, () => {
    const listed = python(RENDER_ONE, ['sum-of-two-digits', 'web', 'no'])

    expect(listed).toContain('<h2>Your turn</h2>')
    expect(listed).not.toContain('class="desk"')
    expect(listed).not.toContain('<textarea')
  })

  it('has no second renderer anywhere in src/', () => {
    // Markup only `render.py` is allowed to emit. `src/publication/` is a
    // different pipeline over different documents (ADR 010 keeps both); these
    // are the book's own, and nothing in src/ may produce them.
    const emittedOnlyByRenderPy = [
      'problem-summary',
      'problem-name',
      'locked-solution',
      'support-unaided',
      'walk-controls',
      'desk-actions',
      'cell-run',
      'hint-title',
      'solution-title',
      ':::statement',
      ':::figure',
    ]
    const offenders: string[] = []

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(astro|ts|tsx|js|jsx|mjs|css)$/.test(entry)) continue
        const text = readFileSync(full, 'utf8')
        for (const marker of emittedOnlyByRenderPy) {
          if (text.includes(marker)) offenders.push(`${path.relative(ROOT, full)}: ${marker}`)
        }
      }
    }
    walk(path.join(ROOT, 'src'))

    expect(offenders).toEqual([])
  })
})

describe('stable anchors', () => {
  it('gives every block the same id on a second build of unchanged source', SLOW, () => {
    const first = renderBookManifest()
    const second = renderBookManifest()

    expect(blockIds(first).length).toBeGreaterThan(0)
    expect(blockIds(second)).toEqual(blockIds(first))
  })

  // The book teaches by working through pseudocode, hints and a worked
  // solution. A published page has no grader, so gating those on `solved`
  // there does not defer them, it deletes them.
  it('keeps every worked solution reachable on published pages', SLOW, () => {
    const gated: string[] = JSON.parse(python(GATED_IDS))
    expect(gated.length).toBeGreaterThan(0)

    for (const id of gated) {
      const published = python(RENDER_ONE, [id, 'web', 'no', 'reader'])
      expect(published, `${id} must not lock its solution on a published page`)
        .not.toContain('locked-solution')
      expect(published, `${id} must keep the solution behind a disclosure`)
        .toContain("<details class='solution'>")
    }
  })

  // A published page has no tiers to turn green, so a note promising that the
  // solution waits on them contradicts the disclosure holding it two lines
  // below. Print has no grader either.
  it('promises no grader on pages that have none', SLOW, () => {
    const gated: string[] = JSON.parse(python(GATED_IDS))
    const graderOnly = ['waits until you pass', 'until every tier is green']

    for (const id of gated) {
      const published = python(RENDER_ONE, [id, 'web', 'no', 'reader'])
      const printed = python(RENDER_ONE, [id, 'print', 'no'])
      for (const promise of graderOnly) {
        expect(published, `${id} must not promise a grader when published`)
          .not.toContain(promise)
        expect(printed, `${id} must not promise a grader in print`).not.toContain(promise)
      }
      expect(published, `${id} must say where its solution is`).toMatch(/is below|are below/)
    }

    const preview = python(RENDER_ONE, [gated[0], 'web', 'yes'])
    expect(preview, 'the runnable preview still describes its tiers')
      .toMatch(/waits until you pass|until every tier is green/)
  })

  it('still lets the tiers gate the solution in the runnable preview', SLOW, () => {
    const gated: string[] = JSON.parse(python(GATED_IDS))
    const preview = python(RENDER_ONE, [gated[0], 'web', 'yes'])
    expect(preview).toContain('locked-solution')
    expect(preview).not.toContain("<details class='solution'>")
  })

  // The id is positional, so inserting a block shifts every later ordinal of
  // that kind. Without a verifier a stored note would resolve to a real
  // element holding different content, which is worse than not resolving.
  it('gives every block a content digest', () => {
    for (const node of book.nodes) {
      for (const block of node.blocks) {
        expect(block.digest, `${node.id}/${block.id}`).toMatch(/^[0-9a-f]{12}$/)
      }
    }
  })

  it('changes the digest when an insertion shifts a block id onto new content', () => {
    const lines = python(DIGEST_DRIFT).trim().split('\n')
    const drifted = lines.filter((line) => line.endsWith('drift'))
    expect(drifted.length, 'an insertion must be visible as digest drift').toBeGreaterThan(0)
  })

  // The `data-walk` handler lives in challenges/tools/preview.py and is not
  // shipped by the Astro routes, so controls on a published page are dead.
  it('ships no figure controls it cannot drive', SLOW, () => {
    const withFigure: string[] = JSON.parse(python(FIGURE_IDS))
    expect(withFigure.length).toBeGreaterThan(0)

    for (const id of withFigure) {
      const published = python(RENDER_ONE, [id, 'web', 'no', 'reader'])
      expect(published, `${id} must not ship walk controls`).not.toContain('walk-controls')
      expect(published, `${id} must not ship walk handlers`).not.toContain('data-walk')
    }

    const preview = python(RENDER_ONE, [withFigure[0], 'web', 'yes'])
    expect(preview, 'the runnable preview keeps its controls').toContain('walk-controls')
  })

  // The missing thing is the `data-walk` controller, not JavaScript: a cost
  // chart is a plain SVG and needs nothing at all, so dropping it to the print
  // table on a static host would discard a drawing that works there.
  it('keeps the figures that need no controller when published', SLOW, () => {
    const withChart: string[] = JSON.parse(python(STATIC_CHART_IDS))
    expect(withChart.length).toBeGreaterThan(0)

    for (const id of withChart) {
      const published = python(RENDER_ONE, [id, 'web', 'no', 'reader'])
      expect(published, `${id} must keep its static chart`).toContain('<svg viewBox')
      expect(published, `${id} must keep its static chart`).toContain('class="cost"')
      expect(published, `${id} must keep the numbers under it`).toContain('figure-table')
    }
  })

  it('keeps block ids unique within a node', () => {
    for (const node of book.nodes) {
      const ids = node.blocks.map((block) => block.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it.skipIf(!builtSite)('puts those ids in the DOM of the built page', () => {
    const node = book.nodes.find((entry) => entry.id === SAMPLE)!
    const page = distPage('books', SLUG, node.id)

    expect(node.blocks.length).toBeGreaterThan(0)
    for (const block of node.blocks) {
      expect(page).toContain(`id="${block.id}"`)
    }
  })

  it('gives every node page a stable document URI', () => {
    for (const node of book.nodes) {
      expect(documentUri(node.path)).toBe(`https://ernie.sg/books/${SLUG}/${node.id}/`)
    }
  })

  it.skipIf(!builtSite)('carries that URI into the page', () => {
    const page = distPage('books', SLUG, SAMPLE)

    expect(page).toContain(`data-document-uri="https://ernie.sg/books/${SLUG}/${SAMPLE}/"`)
  })
})

describe('the route comes from the slug', () => {
  it('publishes the book, never the pool, as the URL segment', () => {
    expect(book.slug).toBe(SLUG)
    expect(book.path).toBe(`/books/${SLUG}/`)
    expect(manifest.collection).toBe('Challenges')
    for (const node of book.nodes) {
      expect(node.path).toBe(`/books/${SLUG}/${node.id}/`)
      expect(node.path).not.toContain('/challenges/')
    }
  })

  it('does not move a route when the title is edited', SLOW, () => {
    const { challenges, cleanup } = copyChallenges()
    try {
      const pathFile = path.join(challenges, 'paths', 'agent.toml')
      const original = readFileSync(pathFile, 'utf8')
      writeFileSync(
        pathFile,
        original.replace(
          'title = "Build a Coding Agent"',
          'title = "An Entirely Different Name"',
        ),
      )
      const renamed = renderIn(challenges)
      const renamedBook = renamed.books[0]

      expect(renamedBook.title).toBe('An Entirely Different Name')
      expect(renamedBook.path).toBe(book.path)
      expect(renamedBook.nodes.map((node) => node.path)).toEqual(
        book.nodes.map((node) => node.path),
      )
    } finally {
      cleanup()
    }
  })

  it('moves every route when the slug is edited, and only then', SLOW, () => {
    const { challenges, cleanup } = copyChallenges()
    try {
      const pathFile = path.join(challenges, 'paths', 'agent.toml')
      const original = readFileSync(pathFile, 'utf8')
      writeFileSync(
        pathFile,
        original.replace(`slug = "${SLUG}"`, 'slug = "some-other-book"'),
      )
      const moved = renderIn(challenges)

      expect(moved.books[0].path).toBe('/books/some-other-book/')
      expect(moved.books[0].nodes[0].path).toBe(
        `/books/some-other-book/${book.nodes[0].id}/`,
      )
    } finally {
      cleanup()
    }
  })

  it('refuses to publish a path that declares no slug', SLOW, () => {
    const { challenges, cleanup } = copyChallenges()
    try {
      const pathFile = path.join(challenges, 'paths', 'agent.toml')
      const original = readFileSync(pathFile, 'utf8')
      writeFileSync(pathFile, original.replace(`slug = "${SLUG}"\n`, ''))

      expect(() => renderIn(challenges)).toThrow()
    } finally {
      cleanup()
    }
  })
})

describe('every node reaches the web', () => {
  it('emits one route per node in the pool, counted by all_nodes()', SLOW, () => {
    const pool = Number(python(COUNT_POOL))

    expect(pool).toBe(46)
    expect(manifest.poolNodeCount).toBe(pool)
    expect(book.nodes.length).toBe(pool)
  })

  it.skipIf(!builtSite)('builds a page for each of them', () => {
    const emitted = readdirSync(bookDist).filter((entry) =>
      statSync(path.join(bookDist, entry)).isDirectory(),
    )

    expect(emitted.sort()).toEqual(book.nodes.map((node) => node.id).sort())
    expect(emitted.length).toBe(manifest.poolNodeCount)
    expect(existsSync(path.join(bookDist, 'index.html'))).toBe(true)
    expect(existsSync(path.join(DIST, 'books', 'index.html'))).toBe(true)
  })

  it.skipIf(!builtSite)('never publishes the pool as a URL', () => {
    expect(existsSync(path.join(DIST, 'challenges'))).toBe(false)
    expect(existsSync(path.join(DIST, 'books', 'challenges'))).toBe(false)
  })
})

describe('the topic map is this book\'s', () => {
  // The node pool is shared. A map built by scanning all of it would give every
  // path the same attachments, so a second path selecting a subset would count
  // topics it never teaches and link chapters it does not contain.
  it('attaches only nodes the book actually walks, in reading order', SLOW, () => {
    const map = JSON.parse(python(TOPIC_MAP)) as {
      topics: { id: string; nodes: { id: string }[] }[]
      book: string[]
      pool: string[]
    }
    const order = new Map(map.book.map((id, index) => [id, index]))

    expect(map.topics.length).toBeGreaterThan(0)
    for (const topic of map.topics) {
      const ids = topic.nodes.map((node) => node.id)
      for (const id of ids) {
        expect(order.has(id), `${topic.id} attaches ${id}, which the book does not walk`).toBe(
          true,
        )
      }
      const positions = ids.map((id) => order.get(id)!)
      expect(positions, `${topic.id} must list its nodes in reading order`).toEqual(
        [...positions].sort((a, b) => a - b),
      )
    }
  })

  it('still lists the topics with nothing written for them', SLOW, () => {
    const map = JSON.parse(python(TOPIC_MAP)) as { topics: { nodes: unknown[] }[] }
    const empty = map.topics.filter((topic) => topic.nodes.length === 0)

    expect(empty.length).toBeGreaterThan(0)
  })
})

describe('the reading shell belongs to the site', () => {
  const layout = readFileSync(path.join(ROOT, 'src', 'layouts', 'ReadingLayout.astro'), 'utf8')

  it('knows nothing about books', () => {
    // Everything after the component script: the markup and the styles, which
    // are what a second surface would have to reuse unchanged.
    const shell = (layout.split('---')[2] ?? layout).toLowerCase()

    for (const word of ['book', 'challenge', 'chapter', 'epub', 'paper', 'post']) {
      expect(shell).not.toContain(word)
    }
    expect(layout).not.toContain('@/lib/books')
    expect(layout).not.toContain('challenges/')
  })

  it.skipIf(!builtSite)(
    'gives non-book content the same three columns as a book page',
    () => {
      const columns = (html: string) =>
        [...html.matchAll(/data-reading-column="([a-z]+)"/g)].map((match) => match[1])

      const directory = distPage('books')
      const chapter = distPage('books', SLUG, SAMPLE)

      expect(columns(directory)).toEqual(['navigation', 'text', 'margin'])
      expect(columns(chapter)).toEqual(columns(directory))
    },
  )

  // A closed <details> hides its own content whatever `display` says, and the
  // wide breakpoint hides the summary that would reopen it, so a rail without
  // `open` in the markup is empty on every wide load.
  it('exposes the contents without waiting for a click', () => {
    const disclosure = layout.match(/<details[^>]*class="reading-contents"[^>]*>/)!

    expect(disclosure).not.toBeNull()
    expect(disclosure[0]).toContain('open')
  })

  it.skipIf(!builtSite)('shows every contents entry on a wide load', () => {
    const chapter = distPage('books', SLUG, SAMPLE)
    const rail = chapter.slice(chapter.indexOf('data-reading-column="navigation"'))

    expect(rail.slice(0, rail.indexOf('data-reading-column="text"'))).toMatch(
      /<details[^>]*\bopen\b/,
    )
  })

  it.skipIf(!builtSite)('reserves the margin as an empty landmark', () => {
    for (const page of [distPage('books'), distPage('books', SLUG, SAMPLE)]) {
      expect(page).toMatch(/<aside[^>]*data-margin-mount[^>]*>\s*<\/aside>/)
      expect(page).toContain('id="margin-root"')
    }
  })
})

describe('the print edition is where it was', () => {
  const BUILD_EPUB = `
import json
import sys
import zipfile
sys.path.insert(0, "challenges/tools")
import epub
built = epub.build()
with zipfile.ZipFile(built) as archive:
    documents = {
        name: archive.read(name).decode("utf-8")
        for name in archive.namelist()
        if name.endswith(".xhtml")
    }
sys.stdout.write(json.dumps({"name": built.name, "documents": documents}))
`

  type Epub = { name: string; documents: Record<string, string> }

  it('builds the same documents twice from unchanged source', SLOW, () => {
    const first = JSON.parse(python(BUILD_EPUB)) as Epub
    const second = JSON.parse(python(BUILD_EPUB)) as Epub

    expect(Object.keys(first.documents).length).toBe(book.nodes.length + 1)
    expect(second.documents).toEqual(first.documents)
    expect(first.name).toBe(second.name)
  })

  it('carries none of the web edition into the package', SLOW, () => {
    const built = JSON.parse(python(BUILD_EPUB)) as Epub
    const documents = Object.values(built.documents).join('')

    expect(documents).not.toContain('class="block"')
    expect(documents).not.toContain('data-block-kind')
    expect(documents).not.toContain('<textarea')
    expect(documents).toContain('<h2>Your turn</h2>')
  })
})

describe('the book stylesheet has one author', () => {
  it('confines render.py selectors to the rendered node', () => {
    const scoped = scopeContentCss(manifest.contentCss, '.book-content')

    expect(manifest.contentCss).toContain(':root {')
    expect(scoped).not.toMatch(/(^|\})\s*:root\s*\{/)
    expect(scoped).toContain('.book-content h1 {')
    expect(scoped).toContain('.book-content pre code {')
  })

  it('refuses to scope a stylesheet it would get wrong', () => {
    expect(() => scopeContentCss('@media (min-width:1px){a{color:red}}', '.x')).toThrow()
  })
})

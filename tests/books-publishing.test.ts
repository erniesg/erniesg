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
sys.stdout.write(render_node(node, sys.argv[2], runnable=sys.argv[3] == "yes"))
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

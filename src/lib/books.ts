/**
 * The books, as `books/tools/render.py` renders them.
 *
 * This module runs the Python renderer once per build and hands its HTML on
 * verbatim. It is deliberately the only bridge: nothing in `src/` parses a
 * node, emits block markup, or re-implements a figure. The moment a second
 * renderer exists the web and EPUB editions drift and the reader sees two
 * different books.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { SITE } from '../consts'

/**
 * `digest` verifies the anchor. `id` is positional, so inserting a block
 * shifts every later ordinal of that kind and a stored note would otherwise
 * resolve to a real element holding different content. Same id and same
 * digest is the same block; same id and a different digest is drift to
 * confirm, not to follow.
 */
export type BookBlock = { kind: string; id: string; digest: string }

export type BookOutlineEntry = { level: number; id: string; text: string }

export type BookNode = {
  id: string
  title: string
  kind: string
  support: string
  part: string
  partNumber: string
  number: string
  path: string
  html: string
  blocks: BookBlock[]
  outline: BookOutlineEntry[]
}

export type BookPart = { id: string; title: string; nodes: string[] }

export type BookTopicNode = { id: string; title: string; kind: string }

export type BookTopic = {
  id: string
  title: string
  part: number
  partName: string
  agent: string
  requires: string[]
  unlocks: string[]
  nodes: BookTopicNode[]
}

export type Book = {
  pathId: string
  slug: string
  id: string
  title: string
  subtitle: string
  edition: string
  author: string
  collection: string
  path: string
  frontMatter: string
  parts: BookPart[]
  nodes: BookNode[]
  topics: BookTopic[]
}

export type BookManifest = {
  schemaVersion: number
  generator: string
  collection: string
  poolNodeCount: number
  contentCss: string
  books: Book[]
}

const RENDERER_FROM_ROOT = path.join('books', 'tools', 'manifest.py')

/**
 * Where the node pool lives.
 *
 * Found by climbing from the working directory rather than from
 * `import.meta.url`: this module is bundled into the build output, so its own
 * location says nothing about where the book is.
 */
function repoRoot(): string {
  let directory = process.cwd()
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(directory, RENDERER_FROM_ROOT))) return directory
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`cannot find ${RENDERER_FROM_ROOT} from ${process.cwd()}`)
}

/** Render the whole collection afresh. Callers that just want the build's copy want `bookManifest()`. */
export function renderBookManifest(): BookManifest {
  const python = process.env.CHALLENGES_PYTHON ?? 'python3'
  const root = repoRoot()
  const stdout = execFileSync(python, [path.join(root, RENDERER_FROM_ROOT)], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    // The book is full of typographic punctuation; never let the build host's
    // locale decide how the renderer hands it over.
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  return JSON.parse(stdout) as BookManifest
}

let cached: BookManifest | null = null

/** The rendered collection, computed once per build. */
export function bookManifest(): BookManifest {
  if (!cached) cached = renderBookManifest()
  return cached
}

export function books(): Book[] {
  return bookManifest().books
}

export function bookBySlug(slug: string): Book | undefined {
  return books().find((book) => book.slug === slug)
}

/**
 * The anchor every annotation hangs off. Absolute, because a note may be
 * stored by a service that never sees this site's routing.
 */
export function documentUri(pathname: string): string {
  return new URL(pathname, SITE.SITEURL).toString()
}

/**
 * The book's own stylesheet, confined to one container.
 *
 * `render.py` writes plain element selectors because the EPUB has a document
 * to itself. The site does not, so every selector is prefixed rather than
 * rewritten — the stylesheet still has exactly one author.
 */
export function scopeContentCss(css: string, scope: string): string {
  if (css.includes('@')) {
    throw new Error(
      'the book stylesheet grew an at-rule; scoping it by selector prefix is no longer safe',
    )
  }
  return css.replace(
    /(^|\})([^{}]+)\{/g,
    (_match: string, close: string, selectors: string) =>
      `${close}${selectors
        .split(',')
        .map((selector) => selector.trim())
        .filter(Boolean)
        .map((selector) => (selector === ':root' ? scope : `${scope} ${selector}`))
        .join(', ')} {`,
  )
}

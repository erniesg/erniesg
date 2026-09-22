/**
 * The bridge between the book's one renderer and the site's build.
 *
 * `challenges/tools/render.py` is the only thing in this repository that emits
 * block markup for the book. Astro cannot call Python when a reader arrives, so
 * the build calls it once here and embeds what comes back verbatim. There is no
 * TypeScript copy of any block, and adding one would put the web and EPUB
 * editions on separate tracks.
 *
 * `npm run build:production` already requires `python3` on PATH for the
 * publication step, so this adds no new build dependency — only the 3.11 floor
 * `render.py` needs for `tomllib`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export type ChallengesRow = {
  id: string
  title: string
  number: string
  kind: string
  path: string
}

export type ChallengesEdge = {
  kind: string
  label: string
  colour: string
  id: string
  title: string
  path: string
}

export type ChallengesHeading = {
  id: string
  level: number
  text: string
}

export type ChallengesNode = {
  id: string
  title: string
  kind: string
  support: string
  number: string
  part: string
  partNumber: string
  path: string
  onPath: boolean
  previous: ChallengesRow | null
  next: ChallengesRow | null
  teaches: string[]
  edges: ChallengesEdge[]
  outline: ChallengesHeading[]
  blockIds: string[]
  html: string
}

export type ChallengesPart = {
  number: string
  title: string
  nodes: ChallengesRow[]
  planned: { id: string; title: string }[]
}

export type ChallengesTopic = {
  id: string
  title: string
  part: number
  partName: string
  agent: string
  requires: string[]
  unlocks: string[]
  nodes: ChallengesRow[]
}

export type ChallengesBook = {
  generator: string
  renderer: string
  base: string
  scope: string
  path: string
  book: {
    title: string
    subtitle: string
    edition: string
    author: string
    slug: string
  }
  counts: {
    pathNodes: number
    allNodes: number
    routes: number
    topics: number
  }
  css: string
  script: string
  contents: ChallengesPart[]
  topics: ChallengesTopic[]
  nodes: ChallengesNode[]
}

const RELATIVE_SCRIPT = path.join('challenges', 'tools', 'web_book.py')

/**
 * Where the renderer's manifest script lives.
 *
 * Found by walking up from the working directory rather than from
 * `import.meta.url`: this module is bundled into `dist/.prerender/` during a
 * build, and a path relative to the bundle points at nothing.
 */
function findChallengesBookScript(): string {
  let directory = process.cwd()
  for (;;) {
    const candidate = path.join(directory, RELATIVE_SCRIPT)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(
    `cannot find ${RELATIVE_SCRIPT} above ${process.cwd()}; the challenges book ` +
      'is rendered from the repository, so the build must run inside it',
  )
}

let script: string | null = null
let rendered: ChallengesBook | null = null

export function challengesBookScript(): string {
  script ??= findChallengesBookScript()
  return script
}

/** The book as the renderer sees it. Rendered once per build, then reused. */
export function loadChallengesBook(): ChallengesBook {
  if (rendered) return rendered
  rendered = renderChallengesBook()
  return rendered
}

/** A fresh render, bypassing the cache. Two calls must agree; tests check that. */
export function renderChallengesBook(): ChallengesBook {
  const where = challengesBookScript()
  let payload: string
  try {
    payload = execFileSync('python3', [where], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    })
  } catch (error) {
    throw new Error(
      `The challenges book is rendered at build time by ${where}, ` +
        `which needs python3 3.11+ on PATH: ${(error as Error).message}`,
    )
  }
  const book = JSON.parse(payload) as ChallengesBook
  if (book.nodes.length !== book.counts.allNodes) {
    throw new Error(
      `the book renders ${book.nodes.length} nodes but the pool holds ` +
        `${book.counts.allNodes}; every node in the pool needs a route`,
    )
  }
  return book
}

/** Where a node lives on the web, as an absolute, citable address. */
export function challengesDocumentUri(
  site: URL | undefined,
  nodePath: string,
): string {
  return new URL(nodePath, site ?? 'https://ernie.sg').href
}

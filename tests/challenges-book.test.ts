/**
 * The book on the web must be the same book.
 *
 * These tests hold the line the feature rests on: one renderer, stable anchors,
 * and a route set nobody maintains by hand. They call `render.py` directly and
 * compare it with what the site ships, so a second renderer cannot appear
 * without a red test.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  renderChallengesBook,
  type ChallengesBook,
} from '../src/lib/challenges-book'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CHALLENGES = path.join(ROOT, 'challenges')
const DIST = path.join(ROOT, 'dist', 'challenges')
const SAMPLE = 'ch12-hash-maps'

/** `render_node` itself, with nothing of the site's build in between. */
const RENDER_DIRECTLY = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(CHALLENGES, 'tools'))})
from render import load_book, render_node
target = sys.argv[1]
_, order = load_book()
node = next(n for n in order if n["id"] == sys.argv[2])
sys.stdout.write(render_node(node, target, interactive=target == "interactive-web"))
`

function renderDirectly(target: 'web' | 'print', nodeId: string): string {
  return execFileSync('python3', ['-c', RENDER_DIRECTLY, target, nodeId], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
}

/** How `all_nodes()` finds nodes: every top-level `.md` and every `challenge.md`. */
function nodeSourceFiles(): string[] {
  const found: string[] = []
  for (const entry of readdirSync(CHALLENGES).sort()) {
    const full = path.join(CHALLENGES, entry)
    if (entry.endsWith('.md') && statSync(full).isFile()) {
      found.push(full)
      continue
    }
    const challenge = path.join(full, 'challenge.md')
    if (statSync(full).isDirectory() && existsSync(challenge)) found.push(challenge)
  }
  return found.filter((file) => readFileSync(file, 'utf8').startsWith('+++'))
}

function builtPage(nodeId: string): string | null {
  const file = path.join(DIST, nodeId, 'index.html')
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

function blockIdsIn(html: string): string[] {
  return [...html.matchAll(/data-block-id="([^"]+)"/g)].map((match) => match[1])
}

let cached: ChallengesBook | null = null
function book(): ChallengesBook {
  cached ??= renderChallengesBook()
  return cached
}

describe('the challenges book on the web', () => {
  it('embeds render.py byte for byte, in the manifest and in the built page', () => {
    const direct = renderDirectly('web', SAMPLE)
    expect(direct.length).toBeGreaterThan(0)

    const node = book().nodes.find((candidate) => candidate.id === SAMPLE)
    expect(node?.html).toBe(direct)

    const built = builtPage(SAMPLE)
    if (built === null) {
      // `npm run build` runs before `npm run test` in CI and in the evidence
      // lanes, so this is normally exercised. Alone, the manifest check above
      // still pins the markup the route embeds.
      return
    }
    expect(built).toContain(direct)
  })

  it('names every block the same way on two independent renders', () => {
    const first = renderChallengesBook()
    const second = renderChallengesBook()

    expect(second.nodes.map((node) => node.id)).toEqual(
      first.nodes.map((node) => node.id),
    )
    for (const [index, node] of first.nodes.entries()) {
      expect(second.nodes[index].blockIds).toEqual(node.blockIds)
      expect(node.blockIds.length).toBeGreaterThan(0)
      expect(new Set(node.blockIds).size).toBe(node.blockIds.length)
      for (const id of node.blockIds) expect(id.startsWith(`${node.id}--`)).toBe(true)
    }

    const built = builtPage(SAMPLE)
    if (built === null) return
    const sample = first.nodes.find((node) => node.id === SAMPLE)
    expect(blockIdsIn(built)).toEqual(sample?.blockIds)
  })

  it('routes every node in the pool, counted from the node pool itself', () => {
    const rendered = book()
    const sources = nodeSourceFiles()

    expect(rendered.counts.allNodes).toBe(sources.length)
    expect(rendered.nodes).toHaveLength(sources.length)
    expect(rendered.counts.pathNodes).toBe(sources.length)
    expect(new Set(rendered.nodes.map((node) => node.id)).size).toBe(sources.length)
    for (const node of rendered.nodes) {
      expect(node.path).toBe(`/challenges/${node.id}/`)
    }

    if (!existsSync(DIST)) return
    const emitted = readdirSync(DIST).filter((entry) =>
      existsSync(path.join(DIST, entry, 'index.html')),
    )
    expect(emitted.sort()).toEqual(rendered.nodes.map((node) => node.id).sort())
    expect(existsSync(path.join(ROOT, 'dist', 'challenges', 'index.html'))).toBe(true)
  })

  it('leaves the print edition, and so the EPUB, exactly as it was', () => {
    // A challenge, because a challenge is where the two targets differ most:
    // it has a desk on the web and a listing on paper.
    const print = renderDirectly('print', 'most-common-basket')
    for (const webOnly of [
      'data-block-id',
      'class="block"',
      'cell-run',
      'class="desk"',
      'walk-controls',
      '<details',
    ]) {
      expect({ marker: webOnly, present: print.includes(webOnly) }).toEqual({
        marker: webOnly,
        present: false,
      })
    }
    expect(print.includes('<h2>Your turn</h2><pre><code>')).toBe(true)
    expect(
      print.includes('Run and grade this in the web edition, or from a terminal'),
    ).toBe(true)
  })

  it('confines the renderer stylesheet to the book, leaking nothing', () => {
    const css = book().css
    expect(css).toContain('.book-text h1')
    expect(css).not.toMatch(/(^|\n)h1\s*\{/)
    for (const rule of css.split('}')) {
      if (!rule.includes('{')) continue
      for (const selector of rule.split('{')[0].split(',')) {
        if (selector.trim()) expect(selector.trim().startsWith('.book-text')).toBe(true)
      }
    }
  })

  it('keeps the site free of a second renderer', () => {
    // Markup only `render.py` may emit. If one of these turns up under `src/`,
    // the web and print editions have started to drift. They are chosen to be
    // unique to the book: the publication pipeline has figures of its own.
    const rendererOnly = [
      'problem-summary',
      'locked-solution',
      'cell-run',
      'walk-state',
      'support-unaided',
      'figure-steps',
      ':::statement',
      ':::figure',
      'render_node',
      'split_blocks',
    ]
    const offenders: string[] = []
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(astro|ts|tsx|js|jsx|mjs|css)$/.test(entry)) continue
        const text = readFileSync(full, 'utf8')
        for (const marker of rendererOnly) {
          if (text.includes(marker)) offenders.push(`${full}: ${marker}`)
        }
      }
    }
    walk(path.join(ROOT, 'src'))
    expect(offenders).toEqual([])
  })
})

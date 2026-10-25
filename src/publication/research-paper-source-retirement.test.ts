import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import rawPaper from '../research/papers/semantic-responsive-typesetting.json'
import { buildEpub, renderPublicationXhtml } from '../research/epub'
import { researchPaperSchema } from '../research/schema'
import { getTargetProfile } from '../research/targets'
import { createDefaultPublicationAdapterRegistry } from './adapter-registry'

/**
 * EG-15 - the retirement of the forward `ResearchPaper` -> `PublicationGraph`
 * producer.
 *
 * The producer had four exports and no production caller: the reverse
 * direction was retired earlier, and the forward direction was reachable
 * only from tests. A second producer of the renderer plan is a second
 * candidate authority for the published text, so the forward direction is
 * retired rather than renamed, hidden or allowlisted.
 *
 * What this file proves, and what it deliberately does not do:
 *
 * - It proves the producer is gone: the module does not exist, and no
 *   production module of the repository declares one of its symbols. The
 *   scan skips test files, because a test is not a production caller; the
 *   module is deleted, so no test can call it either, and the compiler
 *   refuses any such import.
 * - It proves the legacy app-owned `ResearchPaper` compatibility surface
 *   survived the retirement. The renderer entry points live in
 *   `src/research/epub.ts` and are not part of the graph bridge; they are
 *   exercised here so the retirement of the bridge cannot be mistaken for
 *   the retirement of the legacy read-only path.
 * - It does not claim that the retired feature is still covered. The
 *   feature-only assertions of the retired module's own test file (the
 *   forward projection of a golden paper, its determinism, its unsupported
 *   subset errors) are retired with the feature. The content, identity and
 *   source-binding assertions that mattered are migrated onto the Struct
 *   projection in `source-adapter.test.ts` and
 *   `source-adapter.source-binding.test.ts`, and the double-adapt
 *   conformance in `tests/publication-struct-double-adapt.test.ts` already
 *   pins that the graph never authors text or a semantic id.
 */

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

/** The module that used to hold the forward producer. */
const retiredModulePath = join(
  repositoryRoot,
  'src/publication/research-paper-adapter.ts',
)

/** The exports the retired module carried. */
const RETIRED_PRODUCER_SYMBOLS = [
  'researchPaperToPublicationGraph',
  'adaptResearchPaper',
  'researchPaperSourceAdapter',
  'RESEARCH_PAPER_ADAPTER_ID',
] as const

/** The production roots of the repository. */
const PRODUCTION_ROOTS = ['src', 'tools', 'packages', 'scripts'] as const

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.astro',
])

/** Test files are not production callers. */
function isTestFile(file: string) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
}

function collectSourceFiles(directory: string): string[] {
  let entries: string[] = []
  try {
    entries = readdirSync(directory)
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries.sort()) {
    const path = join(directory, entry)
    let stats
    try {
      stats = statSync(path)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(path))
      continue
    }
    if (!stats.isFile()) continue
    const dot = entry.lastIndexOf('.')
    // An extensionless file is a script in this repository (the evidence
    // commands), so it is read as source too.
    if (dot >= 0 && !SOURCE_EXTENSIONS.has(entry.slice(dot))) continue
    files.push(path)
  }
  return files
}

describe('EG-15 the forward ResearchPaper to PublicationGraph producer', () => {
  it('has no producer module left', () => {
    expect(existsSync(retiredModulePath)).toBe(false)
  })

  it('declares no retired producer symbol in any production module', () => {
    const hits: string[] = []
    let scanned = 0
    for (const root of PRODUCTION_ROOTS) {
      for (const file of collectSourceFiles(join(repositoryRoot, root))) {
        if (isTestFile(file)) continue
        scanned += 1
        const source = readFileSync(file, 'utf8')
        for (const symbol of RETIRED_PRODUCER_SYMBOLS) {
          if (!source.includes(symbol)) continue
          hits.push(
            `${relative(repositoryRoot, file).split(/[\\/]/).join('/')} -> ${symbol}`,
          )
        }
      }
    }
    // The scan really walked the production sources. A scan that found no
    // file would be green without ever looking at one.
    expect(scanned).toBeGreaterThan(0)
    expect(hits).toEqual([])
  })

  it('registers no ResearchPaper source adapter', async () => {
    const registry = createDefaultPublicationAdapterRegistry()
    await expect(registry.resolve('research-paper', rawPaper)).rejects.toThrow(
      /Unknown publication source adapter: research-paper/,
    )
  })

  it('keeps the app-owned legacy ResearchPaper renderer compatibility surface', async () => {
    // The legacy read-only path is app-owned and lives outside the graph
    // bridge: `src/research/epub.ts` still renders a `ResearchPaper` and
    // still builds its EPUB. The retirement of the forward producer must not
    // take that surface with it.
    const paper = researchPaperSchema.parse(rawPaper)
    const xhtml = renderPublicationXhtml(paper)
    expect(xhtml).toContain(paper.title)
    expect(xhtml).toContain('<main')
    const epub = await buildEpub(paper, getTargetProfile('paperPro'))
    expect(epub.entries).toContain('EPUB/content.xhtml')
    expect(epub.entries).toContain('EPUB/package.opf')
  })
})

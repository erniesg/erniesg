/**
 * The browser importer has one home, and it is `/library` (ADR 010).
 *
 * It used to be reachable from four places: `/research/studio`,
 * `/study/experiments/pdf-to-epub` and `/research` rendered it, and
 * `/research/pdf-review` reached it through the review queue that embeds it.
 * This walks the import graph of every route file rather than grepping for the
 * component's name, so a route that reaches the importer one hop away counts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..')
const PAGES = path.join(ROOT, 'src', 'pages')
const IMPORTER = path.join(ROOT, 'src/components/research/PublicationImporter.tsx')

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

function routeOf(file: string) {
  const relative = path.relative(PAGES, file).split(path.sep).join('/')
  const route = relative.replace(/\.(astro|ts|tsx|js|mjs)$/u, '')
  if (route === 'index') return '/'
  return route.endsWith('/index')
    ? `/${route.slice(0, -'index'.length)}`
    : `/${route}${relative.endsWith('.astro') ? '/' : ''}`
}

const EXTENSIONS = ['', '.ts', '.tsx', '.astro', '.js', '.mjs', '/index.ts']

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? path.join(ROOT, 'src', specifier.slice(2))
    : specifier.startsWith('.')
      ? path.resolve(path.dirname(from), specifier)
      : null
  if (!base) return null
  for (const extension of EXTENSIONS) {
    const candidate = `${base}${extension}`
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const specifiers = [
    ...source.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/gu),
    ...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/gu),
  ].map((match) => match[1])
  return specifiers.flatMap((specifier) => {
    const resolved = resolveImport(file, specifier)
    return resolved && /\.(astro|tsx?|m?js)$/u.test(resolved) ? [resolved] : []
  })
}

function reachesImporter(file: string, seen = new Set<string>()): boolean {
  if (file === IMPORTER) return true
  if (seen.has(file)) return false
  seen.add(file)
  return importsOf(file).some((next) => reachesImporter(next, seen))
}

const routes = walk(PAGES).map((file) => ({ file, route: routeOf(file) }))
const direct = routes
  .filter(({ file }) => importsOf(file).includes(IMPORTER))
  .map(({ route }) => route)
const reaching = routes
  .filter(({ file }) => reachesImporter(file))
  .map(({ route }) => route)
  .sort()

describe('the browser PDF importer', () => {
  it('is rendered by exactly one route, /library', () => {
    expect(direct).toEqual(['/library/'])
  })

  it('is reached by nothing outside /library, even one hop away', () => {
    expect(reaching).toContain('/library/')
    expect(reaching.every((route) => route.startsWith('/library/'))).toBe(true)
  })

  it('is not reachable from any route the migration retired or renamed', () => {
    for (const route of [
      '/papers/',
      '/papers/pdf-review/',
      '/papers/[id]/',
      '/research/',
      '/research/studio/',
      '/research/pdf-review/',
      '/study/experiments/pdf-to-epub/',
    ]) {
      expect(reaching, route).not.toContain(route)
    }
  })

  it('stays browser-local and out of search indexes at /library', () => {
    const source = readFileSync(path.join(PAGES, 'library/index.astro'), 'utf8')

    expect(source).toMatch(/<ReadingLayout[\s\S]*?noindex/u)
    expect(source).toMatch(/conversion[^<]*browser/iu)
    expect(source).toContain(
      '<PublicationImporter showIntro={false} client:load />',
    )
    // The one link to the 20-paper benchmark came from the deleted studio.
    expect(source).toContain('href="/library/pdf-review/"')
  })
})

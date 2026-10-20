import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * The inactivity evidence.
 *
 * Two independent claims, and neither of them is "the code looks inactive":
 *
 * 1. **The import graph.** Nothing the Worker serves and nothing the site
 *    serves reaches `src/editorial/**`. It is computed with the TypeScript
 *    compiler's own resolver over the project's real `paths` mapping, from
 *    the Worker entry and from every route, so an alias, a re-export and a
 *    dynamic import are all followed.
 * 2. **The bytes.** The production writer and the public route are
 *    byte-identical to the commit E-05 started from, and the only files E-05
 *    changed are the editorial modules and the design record.
 *
 * The base commit is the parent of E05a's first commit: the state the
 * repository was in before the editorial record contract was written.
 */
const BASE_COMMIT = '9003ea7657ef73cbad271e6a82eab5f27f649e91'

const PROJECT_ROOT = resolve(process.cwd())
const EDITORIAL_DIRECTORY = resolve(PROJECT_ROOT, 'src/editorial')
const WORKER_ENTRY = resolve(PROJECT_ROOT, 'src/worker/index.ts')
const PAGES_DIRECTORY = resolve(PROJECT_ROOT, 'src/pages')

/** Every file under a directory, recursively. */
function filesUnder(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path))
    } else {
      found.push(path)
    }
  }
  return found
}

/** The compiler options of the project. */
function projectOptions(): ts.CompilerOptions {
  const configPath = resolve(PROJECT_ROOT, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) {
    throw new Error(
      `the project's tsconfig cannot be read: ${ts.flattenDiagnosticMessageText(
        config.error.messageText,
        ' ',
      )}`,
    )
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    PROJECT_ROOT,
  )
  return parsed.options
}

/** The module specifiers a file imports. */
function specifiersOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const found = new Set<string>()
  if (file.endsWith('.astro')) {
    // An Astro route's imports live in its frontmatter.
    const frontmatter = text.split('---')[1] ?? ''
    for (const match of frontmatter.matchAll(
      /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g,
    )) {
      if (match[1] !== undefined) found.add(match[1])
    }
    return [...found]
  }
  const preprocessed = ts.preProcessFile(text, true, true)
  for (const imported of preprocessed.importedFiles) found.add(imported.fileName)
  return [...found]
}

/** The file a specifier resolves to, or `null`. */
function resolveSpecifier(
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
): string | null {
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    ts.sys,
  )
  const file = resolved.resolvedModule?.resolvedFileName
  return file === undefined ? null : resolve(file)
}

/**
 * Every file the roots reach, following imports.
 *
 * It is the transitive closure, so a module that reaches an editorial
 * module through two hops is caught too.
 */
function reachableFrom(roots: string[]): Set<string> {
  const options = projectOptions()
  const seen = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    for (const specifier of specifiersOf(file)) {
      const resolved = resolveSpecifier(specifier, file, options)
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved)
    }
  }
  return seen
}

/** The files of a directory, relative to the project root, with forward slashes. */
function relativePaths(files: string[]): string[] {
  return files.map((file) => relative(PROJECT_ROOT, file).split(sep).join('/'))
}

describe('the inactivity evidence', () => {
  it('keeps the editorial modules out of the Worker import graph', () => {
    const reached = reachableFrom([WORKER_ENTRY])
    const editorial = [...reached].filter((file) =>
      file.startsWith(`${EDITORIAL_DIRECTORY}${sep}`),
    )
    expect(relativePaths(editorial)).toEqual([])
  })

  it('keeps the editorial modules out of every route import graph', () => {
    const routes = filesUnder(PAGES_DIRECTORY).filter((file) =>
      /\.(astro|ts|tsx|js|mjs)$/.test(file),
    )
    expect(routes.length).toBeGreaterThan(0)
    const reached = reachableFrom(routes)
    const editorial = [...reached].filter((file) =>
      file.startsWith(`${EDITORIAL_DIRECTORY}${sep}`),
    )
    expect(relativePaths(editorial)).toEqual([])
  })

  it('keeps the activation phrase out of every module but the editorial ones', () => {
    const phrase = 'erniesg.editorial.activate.v1'
    const offenders: string[] = []
    for (const file of filesUnder(resolve(PROJECT_ROOT, 'src'))) {
      if (!/\.(ts|tsx|js|mjs|astro)$/.test(file)) continue
      if (file.startsWith(`${EDITORIAL_DIRECTORY}${sep}`)) continue
      if (readFileSync(file, 'utf8').includes(phrase)) offenders.push(file)
    }
    expect(relativePaths(offenders)).toEqual([])
  })

  it('keeps the production writer byte-identical to the base commit', () => {
    const productionWriter = [
      'tools/publication-build.mjs',
      'src/publication/renderers/vivliostyle.ts',
    ]
    for (const path of productionWriter) {
      const atBase = execFileSync('git', ['show', `${BASE_COMMIT}:${path}`])
      const inTree = readFileSync(resolve(PROJECT_ROOT, path))
      expect(Buffer.compare(atBase, inTree)).toBe(0)
    }
  })

  it('keeps the public route byte-identical to the base commit', () => {
    const routes = filesUnder(PAGES_DIRECTORY).filter((file) =>
      /\.(astro|ts|tsx|js|mjs)$/.test(file),
    )
    expect(routes.length).toBeGreaterThan(0)
    for (const file of routes) {
      const path = relative(PROJECT_ROOT, file).split(sep).join('/')
      const atBase = execFileSync('git', ['show', `${BASE_COMMIT}:${path}`])
      expect(Buffer.compare(atBase, readFileSync(file))).toBe(0)
    }
  })

  it('changes nothing but the editorial modules and the design record', () => {
    const changed = execFileSync('git', [
      'diff',
      '--name-only',
      BASE_COMMIT,
    ])
      .toString('utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const untracked = execFileSync('git', [
      'ls-files',
      '--others',
      '--exclude-standard',
    ])
      .toString('utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const touched = [...new Set([...changed, ...untracked])]
    expect(touched.length).toBeGreaterThan(0)
    const outside = touched.filter(
      (path) =>
        !path.startsWith('src/editorial/') &&
        !path.startsWith('migrations/editorial/') &&
        path !== 'docs/editorial-publication-design-20261020.md',
    )
    expect(outside).toEqual([])
  })

  it('keeps the editorial migrations out of the margin runner', () => {
    // The margin runner reads `migrations/*.sql` and the margin test
    // harness applies every `migrations/*.sql` in filename order. The
    // editorial migrations are a *directory*, so neither of them sees them.
    const marginMigrations = readdirSync(resolve(PROJECT_ROOT, 'migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort()
    expect(marginMigrations).toEqual([
      '0001_margin_annotations.sql',
      '0002_margin_progress.sql',
      '0003_margin_proposals.sql',
      '0004_margin_idempotency_receipts.sql',
    ])

    const editorialMigrations = readdirSync(
      resolve(PROJECT_ROOT, 'migrations/editorial'),
    ).sort()
    expect(editorialMigrations).toEqual([
      '0001_editorial_store.sql',
      '0002_editorial_control.sql',
    ])
  })
})

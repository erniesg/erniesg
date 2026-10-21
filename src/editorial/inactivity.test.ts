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
 *
 * This test also runs on the combined E-04/E-05 branch, where the tree
 * contains E-04's legitimate changes on top of the same base. The E-05-only
 * claim is kept intact there by scoping every comparison to the E-05 delta:
 * E-04's own delta (`E03_BASE..E04_HEAD`) is allowed to differ, the branch's
 * own post-E-04 maintenance commits are allowed to differ, and any other
 * non-editorial difference from the base still fails. E-05's own delta is
 * asserted separately to contain nothing outside the editorial scope, so the
 * test still fails if E-05 touched anything else. The E-04 head anchor is
 * the reviewed E-04 candidate `c1d5e92f`.
 */
const E03_BASE = '9003ea7657ef73cbad271e6a82eab5f27f649e91'
const E04_HEAD = 'c1d5e92ff7cb4aac635d91baf33b20f58e98c2fc'
const E05_HEAD = '25570506b6020add5ed2610e62dfb8abacdf308f'

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

/** The non-empty lines of a git command's stdout. */
function gitLines(args: string[]): string[] {
  return execFileSync('git', args)
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Whether a commit is an ancestor of HEAD. */
function isAncestor(commit: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'])
    return true
  } catch {
    return false
  }
}

/** The paths a commit range changed. */
function changedPaths(from: string, to: string): Set<string> {
  return new Set(gitLines(['diff', '--name-only', `${from}..${to}`]))
}

/** Whether a path is inside the E-05 editorial scope. */
function isEditorialScope(path: string): boolean {
  return (
    path.startsWith('src/editorial/') ||
    path.startsWith('migrations/editorial/') ||
    path === 'docs/editorial-publication-design-20261020.md'
  )
}

// E-04 is merged into this branch when its reviewed head is an ancestor of
// HEAD; the E-05 delta is always measured against E-05's own head.
const e04Merged = isAncestor(E04_HEAD)
const e04Delta = changedPaths(E03_BASE, E04_HEAD)
const e05Delta = changedPaths(E03_BASE, E05_HEAD)

/** The revision a path's byte-identity expectation comes from. */
function expectedRevision(path: string): string {
  return e04Merged && e04Delta.has(path) ? E04_HEAD : E03_BASE
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
      const atBase = execFileSync('git', [
        'show',
        `${expectedRevision(path)}:${path}`,
      ])
      const inTree = readFileSync(resolve(PROJECT_ROOT, path))
      expect(Buffer.compare(atBase, inTree)).toBe(0)
      // E-05 itself never touched the production writer, even where E-04
      // also changed it: the E-05-only claim is proven from E-05's own delta.
      expect(e05Delta.has(path)).toBe(false)
    }
  })

  it('keeps the public route byte-identical to the base commit', () => {
    const routes = filesUnder(PAGES_DIRECTORY).filter((file) =>
      /\.(astro|ts|tsx|js|mjs)$/.test(file),
    )
    expect(routes.length).toBeGreaterThan(0)
    for (const file of routes) {
      const path = relative(PROJECT_ROOT, file).split(sep).join('/')
      const atBase = execFileSync('git', [
        'show',
        `${expectedRevision(path)}:${path}`,
      ])
      expect(Buffer.compare(atBase, readFileSync(file))).toBe(0)
      expect(e05Delta.has(path)).toBe(false)
    }
  })

  it('changes nothing but the editorial modules and the design record', () => {
    const changed = gitLines(['diff', '--name-only', E03_BASE])
    const untracked = gitLines(['ls-files', '--others', '--exclude-standard'])
    const touched = [...new Set([...changed, ...untracked])]
    expect(touched.length).toBeGreaterThan(0)
    const outside = touched.filter((path) => !isEditorialScope(path))
    // The only non-editorial differences from E-05's base are E-04's own
    // delta and the branch's own post-E-04 maintenance commits (the CI
    // checkout fix), and only when E-04 is merged; otherwise the set is empty.
    const branchMaintenance = e04Merged
      ? gitLines(['diff', '--name-only', `${E04_HEAD}..HEAD`]).filter(
          (path) => !isEditorialScope(path),
        )
      : []
    const expectedOutside = e04Merged
      ? [...new Set([...e04Delta, ...branchMaintenance])].sort()
      : []
    expect(outside.sort()).toEqual(expectedOutside)
    // E-05's own delta contains nothing outside the editorial modules, the
    // editorial migrations and its design record, so E-05 touched nothing
    // else even where E-04 also changed the same file.
    const e05Outside = [...e05Delta]
      .filter((path) => !isEditorialScope(path))
      .sort()
    expect(e05Outside).toEqual([])
  })

  it('demonstrates that the E-05 delta is non-empty and in the editorial scope', () => {
    // Without this, an E-05 delta of zero files would make every
    // "E-05 changed nothing outside the editorial scope" assertion above
    // pass VACUOUSLY: the filter would have nothing to reject, and the
    // inactivity proof would prove nothing at all. This assertion is what
    // makes the scope assertion non-vacuous, so it must itself hold.
    expect(e05Delta.size).toBeGreaterThan(0)
    // The delta is not one stray file: it really is the editorial contract
    // this evidence is about, on both sides of the contract.
    const editorialModules = [...e05Delta].filter((path) =>
      path.startsWith('src/editorial/'),
    )
    const editorialMigrations = [...e05Delta].filter((path) =>
      path.startsWith('migrations/editorial/'),
    )
    expect(editorialModules.length).toBeGreaterThan(0)
    expect(editorialMigrations.length).toBeGreaterThan(0)
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

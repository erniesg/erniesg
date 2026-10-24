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
 *    byte-identical to the commit the editorial contract was written on top
 *    of, and the only files the editorial lane changed are the editorial
 *    modules and the design record.
 *
 * ## The anchors
 *
 * The proof runs on a branch that carries **two** lanes, so it measures two
 * deltas and states where each of them starts and ends.
 *
 * - `E03_BASE` is the state before either lane: the merge base of the E-04
 *   and E-05 lanes. Every comparison starts here.
 * - `E04_HEAD` is the E-04 anchor. It is where the E-04 allowance comes
 *   from: the non-editorial differences from `E03_BASE` that E-04 owns are
 *   allowed to be there, and only those.
 * - `E05_LANE_HEAD` is the reviewed head of the E-05 lane itself
 *   (`feat/struct-e05-editorial-records-20261020`): the content the editorial
 *   contract was delivered as.
 * - `E05_CONTENT_HEAD` is the commit that integrated that content onto the
 *   E-04 base.
 * - `E05_HEAD` is the reviewed head of **this** delivery: the commit that
 *   carries the whole E-05 delta, the lane's content plus the acceptance
 *   work that follows it. It cannot be the tip of the branch, because this
 *   commit is the one that pins it and a commit cannot contain its own
 *   SHA.
 *
 * `PUBLIC_SITE_HEAD` pins the existing public site integrated after those
 * lanes. Route byte-identity uses that anchor; the E-05-only delta and writer
 * checks retain their original anchors.
 *
 * ## The E-04 allowance
 *
 * The proof does not assert that the branch changed nothing but the editorial
 * modules: the branch carries E-04's content too, and E-04's content is
 * real. What it asserts is that the non-editorial differences from the base
 * are **exactly** E-04's own delta plus this branch's own post-E-04
 * maintenance commits, and that **E-05's own delta contains nothing outside
 * the editorial scope**. The second assertion is the one that keeps E-05
 * honest, and it is measured from anchors that do not move when the E-04
 * anchor is advanced.
 *
 * ## PROVISIONAL: the E-04 anchor
 *
 * `E04_HEAD` below is the **E-04 integrated head**, not the commit E-04 will
 * land as. It is a real commit that carries E-04's content and that is an
 * ancestor of this branch, so the proof runs and is verifiable today.
 *
 * **It is PROVISIONAL and it must be advanced**: when PR #455 merges, the
 * E-04 squash commit that lands on `main` becomes the real anchor, and this
 * constant must be re-pinned to that SHA before the inactivity proof is
 * treated as final. Until that happens, the proof is evidence about the
 * integrated head, not about the shipped E-04.
 */
const E03_BASE = '9003ea7657ef73cbad271e6a82eab5f27f649e91'
const E04_HEAD = '0e6a8bd2ac1a22a580e96ed58346093cd423ccd8'
const E05_LANE_HEAD = '25570506b6020add5ed2610e62dfb8abacdf308f'
const E05_CONTENT_HEAD = '6040e9ebde12cf3b494d51feb8ac0def09902bdb'
const E05_HEAD = 'be195eddeb0abca11e127c67f812c6aaf3b267cc'
const PUBLIC_SITE_HEAD = '840540f2139e95cbe54b8270e191f3adb4f3cb38'

/**
 * The generated lockfile of the pnpm store, which `pnpm import` writes next
 * to `package-lock.json`.
 *
 * It is generated, it is never delivered, and it must never be committed. It
 * is named here so that the proof's handling of it is explicit rather than
 * accidental, and so that the assertion that it is not tracked is a real one.
 */
const GENERATED_PNPM_LOCK = 'pnpm-lock.yaml'

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
        config.error.message,
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

/** The raw bytes of a file at a commit. */
function fileAt(commit: string, path: string): Buffer {
  try {
    return execFileSync('git', ['show', `${commit}:${path}`])
  } catch {
    throw new Error(
      `the anchor ${commit} does not carry ${path}; the anchor must be advanced to a commit that does`,
    )
  }
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
  try {
    return new Set(gitLines(['diff', '--name-only', `${from}..${to}`]))
  } catch {
    throw new Error(
      `the range ${from}..${to} cannot be read; the anchors must be real commits in this repository`,
    )
  }
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
// HEAD; the E-05 delta is always measured from anchors that do not move when
// the E-04 anchor is advanced.
const e04Merged = isAncestor(E04_HEAD)
const e04Delta = changedPaths(E03_BASE, E04_HEAD)
const e05LaneDelta = changedPaths(E03_BASE, E05_LANE_HEAD)
const e05DeliveryDelta = changedPaths(E05_CONTENT_HEAD, E05_HEAD)
const e05Delta = new Set([...e05LaneDelta, ...e05DeliveryDelta])

/** The revision a path's byte-identity expectation comes from. */
function expectedRevision(path: string): string {
  return e04Merged && e04Delta.has(path) ? E04_HEAD : E03_BASE
}

/**
 * The one file outside the editorial scope that E-05's own delta changed.
 *
 * It is `.gitignore`, and the only change in it is the entry that ignores
 * the generated pnpm lockfile. It is not a widening of the editorial scope:
 * the assertion below proves that the file's own change is exactly that one
 * entry, so a second change in it would fail the proof.
 */
const E05_NON_EDITORIAL_EXCEPTIONS = ['.gitignore']

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

  it('keeps the production writer byte-identical to the commit it came from', () => {
    const productionWriter = [
      'tools/publication-build.mjs',
      'src/publication/renderers/vivliostyle.ts',
    ]
    for (const path of productionWriter) {
      const atBase = fileAt(expectedRevision(path), path)
      const inTree = readFileSync(resolve(PROJECT_ROOT, path))
      expect(Buffer.compare(atBase, inTree)).toBe(0)
      // E-05 itself never touched the production writer, even where E-04
      // also changed it: the E-05-only claim is proven from E-05's own delta.
      expect(e05Delta.has(path)).toBe(false)
    }
  })

  it('keeps the public routes byte-identical to the existing site baseline', () => {
    expect(isAncestor(PUBLIC_SITE_HEAD)).toBe(true)
    const routes = filesUnder(PAGES_DIRECTORY).filter((file) =>
      /\.(astro|ts|tsx|js|mjs)$/.test(file),
    )
    expect(routes.length).toBeGreaterThan(0)
    for (const file of routes) {
      const path = relative(PROJECT_ROOT, file).split(sep).join('/')
      const atBase = fileAt(PUBLIC_SITE_HEAD, path)
      expect(Buffer.compare(atBase, readFileSync(file))).toBe(0)
      expect(e05Delta.has(path)).toBe(false)
    }
  })

  it('changes nothing but the editorial modules, the design record and the E-04 allowance', () => {
    const changed = gitLines(['diff', '--name-only', E03_BASE])
    // The generated pnpm lockfile is not a difference the editorial contract
    // can own: it is written by `pnpm import` and it is never delivered. It
    // is excluded here explicitly, and the assertion below proves that it is
    // not tracked and that it is ignored.
    const untracked = gitLines([
      'ls-files',
      '--others',
      '--exclude-standard',
    ]).filter((path) => path !== GENERATED_PNPM_LOCK)
    const touched = [...new Set([...changed, ...untracked])]
    expect(touched.length).toBeGreaterThan(0)
    // The allowance above is computed from the **committed** range
    // `E04_HEAD..HEAD`, so a delivery that is only in the working tree is
    // observed here but not expected there. A non-editorial path that is
    // modified but not committed is refused outright, so that the proof
    // tolerates the delivery content only when it is committed on the branch
    // after the E-04 anchor.
    const uncommitted = gitLines(['diff', '--name-only', 'HEAD']).filter(
      (path) => !isEditorialScope(path),
    )
    expect(uncommitted).toEqual([])
    const outside = touched.filter((path) => !isEditorialScope(path))
    // The only non-editorial differences from the base are E-04's own delta
    // and the branch's own post-E-04 maintenance commits, and only when
    // E-04 is merged; otherwise the set is empty.
    const branchMaintenance = e04Merged
      ? gitLines(['diff', '--name-only', `${E04_HEAD}..HEAD`]).filter(
          (path) => !isEditorialScope(path),
        )
      : []
    const expectedOutside = e04Merged
      ? [
          ...new Set([
            ...[...e04Delta].filter((path) => !isEditorialScope(path)),
            ...branchMaintenance,
          ]),
        ].sort()
      : []
    expect(outside.sort()).toEqual(expectedOutside)
    // E-05's own delta contains nothing outside the editorial modules, the
    // editorial migrations and its design record, so E-05 touched nothing
    // else even where E-04 also changed the same file.
    const e05Outside = [...e05Delta]
      .filter((path) => !isEditorialScope(path))
      .sort()
    expect(e05Outside).toEqual(E05_NON_EDITORIAL_EXCEPTIONS)
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

  it('changed the ignored file only by ignoring the generated pnpm lockfile', () => {
    // The one non-editorial file E-05's own delta touched is `.gitignore`,
    // and the only semantic change in it is the entry that ignores the
    // generated pnpm lockfile. Nothing was removed, and nothing else was
    // added.
    const atBase = fileAt(E03_BASE, '.gitignore')
      .toString('utf8')
      .split('\n')
    const atHead = fileAt(E05_HEAD, '.gitignore')
      .toString('utf8')
      .split('\n')
    const significant = (lines: string[]) =>
      lines
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
    const removed = significant(atBase).filter(
      (line) => !significant(atHead).includes(line),
    )
    const added = significant(atHead).filter(
      (line) => !significant(atBase).includes(line),
    )
    expect(removed).toEqual([])
    expect(added).toEqual([GENERATED_PNPM_LOCK])
  })

  it('never tracks the generated pnpm lockfile, and ignores it', () => {
    // The lockfile is generated by `pnpm import` and is never delivered. If
    // it were ever committed, the repository would carry two lockfiles for
    // the same dependency tree, and the proof would have to account for a
    // file that is not part of the editorial contract.
    expect(gitLines(['ls-files', '--', GENERATED_PNPM_LOCK])).toEqual([])
    let ignored = false
    try {
      execFileSync('git', ['check-ignore', '-q', GENERATED_PNPM_LOCK])
      ignored = true
    } catch {
      ignored = false
    }
    expect(ignored).toBe(true)
  })

  it('keeps the editorial migrations out of the margin runner', () => {
    // The margin runner reads `migrations/*.sql` and the margin test
    // harness applies every `migrations/*.sql` in filename order. The
    // editorial migrations are a *directory*, so neither of them sees them.
    // The root runner also carries the existing public Struct demo migration.
    const marginMigrations = readdirSync(resolve(PROJECT_ROOT, 'migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort()
    expect(marginMigrations).toEqual([
      '0001_margin_annotations.sql',
      '0002_margin_progress.sql',
      '0003_margin_proposals.sql',
      '0004_margin_idempotency_receipts.sql',
      '0005_struct_demo.sql',
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

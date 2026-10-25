import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Independent inactivity claims: actual transitive Worker/route imports,
 * current source identity, and the original nonempty E05-only history.
 *
 * The historical anchors below never turn into current-tip allowances.
 * Current source is reconstructed from the validated public/demo base plus
 * the fixed verified Struct delta, six exact byte overrides and a static
 * five-file repair-source receipt. That receipt is source custody, NOT
 * semantic acceptance or independent approval of an author updating both
 * source and receipt. Functional/negative gates and exact-head review remain
 * mandatory. No old publisher ancestry or broad editorial exemption is used.
 */
const E03_BASE = '9003ea7657ef73cbad271e6a82eab5f27f649e91'
const E04_HEAD = '0e6a8bd2ac1a22a580e96ed58346093cd423ccd8'
const E05_LANE_HEAD = '25570506b6020add5ed2610e62dfb8abacdf308f'
const E05_CONTENT_HEAD = '6040e9ebde12cf3b494d51feb8ac0def09902bdb'
const E05_HEAD = 'be195eddeb0abca11e127c67f812c6aaf3b267cc'
const PUBLIC_SITE_HEAD = '840540f2139e95cbe54b8270e191f3adb4f3cb38'
const VALIDATED_BASE = 'e7080488dc481fc046c8b05921c855853c139a32'
const INTEGRATION_BASE = 'ddbec7e07bbcad8816c89df644ba2dcc076cbf8b'
const STRUCT_SOURCE = '974735c66a46ecc8a3f2d4128da1893438bc25bf'
const REPAIR_RECEIPT = 'tests/fixtures/struct-restack-repair-source.json'
const REPAIR_PATHS = [
  'src/annotations/annotation-bundle.test.ts',
  'src/annotations/annotation-bundle.ts',
  'src/editorial/inactivity.test.ts',
  'tests/zod4-compatibility.test.ts',
  'tests/zod4-main-compatibility.test.ts',
]
const STATUS_DOCS = [
  'docs/struct-migration-status.md',
  'docs/struct-publication-graph-authority-inventory.md',
  'docs/struct-research-paper-caller-inventory.md',
  'docs/superpowers/plans/2026-10-20-struct-full-cutover-sequence.md',
]
const STATUS_BANNER =
  '> Restack checkpoint (2026-10-25): this is unpublished candidate source ported from verified `974735c6` onto validated demo-only main base `e7080488`. Historical completion/evidence below is NOT a new main merge, live activation or acceptance of this restack. Main-side E02 records remain in the base history (`ec97271b`); dated E03/E04 records are retained. New exact-head validation/review is pending.\n\n'

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

// Missing history must fail, never masquerade as an empty delta or an
// ancestry exclusion. E04 remains historical evidence, not a HEAD allowance.
for (const anchor of [
  E03_BASE,
  E04_HEAD,
  E05_LANE_HEAD,
  E05_CONTENT_HEAD,
  E05_HEAD,
  PUBLIC_SITE_HEAD,
  VALIDATED_BASE,
  INTEGRATION_BASE,
  STRUCT_SOURCE,
]) {
  execFileSync('git', ['cat-file', '-e', `${anchor}^{commit}`])
}
const e05LaneDelta = changedPaths(E03_BASE, E05_LANE_HEAD)
const e05DeliveryDelta = changedPaths(E05_CONTENT_HEAD, E05_HEAD)
const e05Delta = new Set([...e05LaneDelta, ...e05DeliveryDelta])

type SourceEntry = { mode: string; blob: string }
type SourceTree = Map<string, SourceEntry>

function blobOf(bytes: Buffer | string): string {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  return createHash('sha1')
    .update(`blob ${data.length}\0`)
    .update(data)
    .digest('hex')
}

function treeAt(revision: string): SourceTree {
  const tree: SourceTree = new Map()
  const rows = execFileSync('git', ['ls-tree', '-rz', '--full-tree', revision])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  for (const row of rows) {
    const tab = row.indexOf('\t')
    const [mode, kind, blob] = row.slice(0, tab).split(' ')
    const path = row.slice(tab + 1)
    if (
      tab < 0 ||
      !path ||
      tree.has(path) ||
      kind !== 'blob' ||
      !['100644', '100755'].includes(mode!) ||
      !/^[a-f0-9]{40}$/.test(blob!)
    ) {
      throw new Error(`Unsupported source entry: ${row}`)
    }
    tree.set(path, { mode: mode!, blob: blob! })
  }
  return tree
}

function replaceOnce(text: string, before: string, after: string): string {
  if (text.split(before).length !== 2)
    throw new Error('Source override must match exactly once')
  return text.replace(before, after)
}

/** Expected bytes come only from immutable inputs, never candidate HEAD. */
function baselineTree(): SourceTree {
  const base = treeAt(VALIDATED_BASE)
  const source = treeAt(STRUCT_SOURCE)
  const expected = new Map(base)
  const delta = gitLines([
    'diff',
    '--no-renames',
    '--name-only',
    INTEGRATION_BASE,
    STRUCT_SOURCE,
  ])
  if (delta.length !== 173) throw new Error('Verified Struct delta changed')
  for (const path of delta) {
    const entry = source.get(path)
    if (entry) expected.set(path, entry)
    else expected.delete(path)
  }
  for (const path of STATUS_DOCS) {
    expected.set(path, {
      mode: '100644',
      blob: blobOf(
        Buffer.concat([
          Buffer.from(STATUS_BANNER),
          fileAt(STRUCT_SOURCE, path),
        ]),
      ),
    })
  }
  const oldSpec =
    'file:vendor/struct/erniesg-struct-0.0.0-90f76f1f80b037cc065169d07b13779c03420026.tgz'
  const newSpec =
    'file:vendor/struct/erniesg-struct-0.0.0-3d3a7c95b1c55a9ff4b527eee5acf36c168cd896.tgz'
  const oldIntegrity =
    'sha512-0WyBLp2PDZr4pOFYhfe6a1IbuZOuBemiR/alDgx73j8JYKZh7m8UthMsimjXp6wt3gUUiNumvXmykYeccnDUBQ=='
  const newIntegrity =
    'sha512-1wpcnARYQmVSsxiLRiSEtp5hd8h9WvxH22cSN/XwCrx0NWPxFif8mswYvF40PybKzi//e1sCPKuap4UiY+deaQ=='
  for (const path of ['package.json', 'package-lock.json']) {
    let bytes = replaceOnce(
      fileAt(VALIDATED_BASE, path).toString('utf8'),
      `"@erniesg/struct": "${oldSpec}"`,
      `"@erniesg/struct": "${newSpec}"`,
    )
    if (path === 'package-lock.json') {
      bytes = replaceOnce(
        bytes,
        `"resolved": "${oldSpec}",\n      "integrity": "${oldIntegrity}"`,
        `"resolved": "${newSpec}",\n      "integrity": "${newIntegrity}"`,
      )
    }
    expected.set(path, { mode: '100644', blob: blobOf(bytes) })
  }
  if (expected.size !== 1862)
    throw new Error('Incomplete immutable source composition')
  return expected
}

function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')
  ) {
    throw new Error('Invalid repair source receipt keys')
  }
  return value as Record<string, unknown>
}

/** Source identity only: actual diffs still require independent review. */
function repairEntries(text: string): SourceTree {
  const receipt = exactObject(JSON.parse(text), [
    'formatVersion',
    'validatedBase',
    'legacyIntegrationBase',
    'verifiedStructSource',
    'sourceChanges',
  ])
  if (
    receipt.formatVersion !== 1 ||
    receipt.validatedBase !== VALIDATED_BASE ||
    receipt.legacyIntegrationBase !== INTEGRATION_BASE ||
    receipt.verifiedStructSource !== STRUCT_SOURCE
  ) {
    throw new Error('Invalid repair source receipt origins')
  }
  const changes = exactObject(receipt.sourceChanges, REPAIR_PATHS)
  const entries: SourceTree = new Map()
  for (const path of REPAIR_PATHS) {
    const entry = exactObject(changes[path], ['mode', 'gitBlob'])
    if (
      entry.mode !== '100644' ||
      typeof entry.gitBlob !== 'string' ||
      !/^[a-f0-9]{40}$/.test(entry.gitBlob)
    ) {
      throw new Error('Invalid repair source entry')
    }
    entries.set(path, { mode: entry.mode, blob: entry.gitBlob })
  }
  const canonical = {
    formatVersion: 1,
    validatedBase: VALIDATED_BASE,
    legacyIntegrationBase: INTEGRATION_BASE,
    verifiedStructSource: STRUCT_SOURCE,
    sourceChanges: Object.fromEntries(
      [...entries].map(([path, entry]) => [
        path,
        { mode: entry.mode, gitBlob: entry.blob },
      ]),
    ),
  }
  if (text !== `${JSON.stringify(canonical, null, 2)}\n`)
    throw new Error('Noncanonical repair source receipt')
  return entries
}

function expectedCandidate(text: string): SourceTree {
  const expected = baselineTree()
  for (const [path, entry] of repairEntries(text)) {
    if (!expected.has(path))
      throw new Error('Repair path missing from immutable composition')
    expected.set(path, entry)
  }
  expected.set(REPAIR_RECEIPT, { mode: '100644', blob: blobOf(text) })
  return expected
}

function assertSourceTree(expected: SourceTree, actual: SourceTree): void {
  const paths = new Set([...expected.keys(), ...actual.keys()])
  const different = [...paths].filter((path) => {
    const a = expected.get(path)
    const b = actual.get(path)
    return !a || !b || a.mode !== b.mode || a.blob !== b.blob
  })
  if (different.length)
    throw new Error(`Source composition mismatch: ${different.join(', ')}`)
}

function workingTree(): SourceTree {
  const actual: SourceTree = new Map()
  for (const path of execFileSync('git', ['ls-files', '-z'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)) {
    const absolute = resolve(PROJECT_ROOT, path)
    const stat = lstatSync(absolute)
    if (!stat.isFile() || actual.has(path))
      throw new Error(`Unsupported working source: ${path}`)
    actual.set(path, {
      mode: stat.mode & 0o111 ? '100755' : '100644',
      blob: blobOf(readFileSync(absolute)),
    })
  }
  return actual
}

function assertNoUntracked(paths: string[]): void {
  if (paths.length)
    throw new Error(`Unexpected untracked source: ${paths.join(', ')}`)
}

function subset(tree: SourceTree, paths: string[]): SourceTree {
  const selected: SourceTree = new Map()
  for (const path of paths) {
    const entry = tree.get(path)
    if (entry) selected.set(path, entry)
  }
  return selected
}

const immutableBaseline = baselineTree()

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

  it('keeps both production writers byte-identical to verified Struct source', () => {
    for (const path of [
      'tools/publication-build.mjs',
      'src/publication/renderers/vivliostyle.ts',
    ]) {
      expect(
        Buffer.compare(
          fileAt(STRUCT_SOURCE, path),
          readFileSync(resolve(PROJECT_ROOT, path)),
        ),
      ).toBe(0)
      expect(e05Delta.has(path)).toBe(false)
    }
  })

  it('keeps the complete public route set and bytes on the validated demo base', () => {
    expect(isAncestor(VALIDATED_BASE)).toBe(true)
    expect(isAncestor(PUBLIC_SITE_HEAD)).toBe(false)
    const base = treeAt(VALIDATED_BASE)
    const paths = [...base.keys()]
      .filter((path) => path.startsWith('src/pages/'))
      .sort()
    expect(paths.length).toBeGreaterThan(0)
    expect(relativePaths(filesUnder(PAGES_DIRECTORY)).sort()).toEqual(paths)
    assertSourceTree(subset(base, paths), subset(workingTree(), paths))
    for (const path of paths) expect(e05Delta.has(path)).toBe(false)
  })

  it('checks the full source composition and fixed repair identities, not path allowances', () => {
    const receipt = readFileSync(resolve(PROJECT_ROOT, REPAIR_RECEIPT), 'utf8')
    const expected = expectedCandidate(receipt)
    expect(expected.size).toBe(1863)
    assertSourceTree(expected, treeAt('HEAD'))
    assertSourceTree(expected, workingTree())
    assertNoUntracked(gitLines(['ls-files', '--others', '--exclude-standard']))
    expect(
      gitLines(['diff', '--name-only', VALIDATED_BASE]).length,
    ).toBeGreaterThan(0)
    // The production edit may not alter the writer, rollback or serializer.
    const original = fileAt(
      STRUCT_SOURCE,
      'src/annotations/annotation-bundle.ts',
    ).toString('utf8')
    const current = readFileSync(
      resolve(PROJECT_ROOT, 'src/annotations/annotation-bundle.ts'),
      'utf8',
    )
    expect(
      current.startsWith(
        original.slice(
          0,
          original.indexOf('export const annotationBundleSchema'),
        ),
      ),
    ).toBe(true)
    const suffix = '\nfunction isLegacyAnchorSource'
    expect(current.slice(current.indexOf(suffix))).toBe(
      original.slice(original.indexOf(suffix)),
    )
  })

  it('retains the independent historical E05-only scope, not a current editorial exemption', () => {
    const e05Outside = [...e05Delta]
      .filter((path) => !isEditorialScope(path))
      .sort()
    expect(e05Outside).toEqual(E05_NON_EDITORIAL_EXCEPTIONS)
  })

  it('rejects modified, deleted, renamed and mode-changed source inside and outside named paths', () => {
    const expected = expectedCandidate(
      readFileSync(resolve(PROJECT_ROOT, REPAIR_RECEIPT), 'utf8'),
    )
    const paths = [
      '.agent/audit.json',
      'src/editorial/records.ts',
      'migrations/editorial/0001_editorial_store.sql',
      'migrations/editorial/0002_editorial_control.sql',
      'tools/publication-build.mjs',
      'src/publication/renderers/vivliostyle.ts',
      ...STATUS_DOCS,
      'package.json',
      'package-lock.json',
      ...REPAIR_PATHS,
      ...[...expected.keys()].filter((path) => path.startsWith('src/pages/')),
    ]
    for (const path of paths) {
      const entry = expected.get(path)!
      expect(entry).toBeDefined()
      for (const mutation of [
        'bytes',
        'delete',
        'rename',
        'executable',
        'symlink',
        'gitlink',
      ]) {
        const actual = new Map(expected)
        if (mutation === 'delete' || mutation === 'rename') {
          actual.delete(path)
          if (mutation === 'rename') actual.set(`${path}.renamed`, entry)
        } else {
          actual.set(path, {
            ...entry,
            ...(mutation === 'bytes'
              ? { blob: '0'.repeat(40) }
              : {
                  mode:
                    mutation === 'executable'
                      ? '100755'
                      : mutation === 'symlink'
                        ? '120000'
                        : '160000',
                }),
          })
        }
        expect(
          () => assertSourceTree(expected, actual),
          `${path}:${mutation}`,
        ).toThrow(/Source composition/)
      }
    }
    const added = new Map(expected)
    added.set('src/pages/__unauthorized.astro', {
      mode: '100644',
      blob: '0'.repeat(40),
    })
    expect(() => assertSourceTree(expected, added)).toThrow(
      /Source composition/,
    )
    expect(() => assertNoUntracked(['src/__unauthorized.ts'])).toThrow(
      /Unexpected untracked/,
    )
    assertSourceTree(expected, new Map(expected))
  })

  it('rejects any extra package script, Zod pin or other lock-node change', () => {
    const expected = expectedCandidate(
      readFileSync(resolve(PROJECT_ROOT, REPAIR_RECEIPT), 'utf8'),
    )
    for (const kind of ['script', 'zod', 'lock']) {
      const path = kind === 'lock' ? 'package-lock.json' : 'package.json'
      const parsed = JSON.parse(
        readFileSync(resolve(PROJECT_ROOT, path), 'utf8'),
      )
      if (kind === 'script')
        parsed.scripts['content:publish'] = 'unauthorized-command'
      else if (kind === 'zod') parsed.dependencies.zod = '4.6.5'
      else parsed.packages['node_modules/zod'].version = '4.6.5'
      const actual = new Map(expected)
      actual.set(path, {
        mode: '100644',
        blob: blobOf(`${JSON.stringify(parsed, null, 2)}\n`),
      })
      expect(() => assertSourceTree(expected, actual)).toThrow(
        /Source composition/,
      )
    }
  })

  it('fails closed on missing, malformed, expanded or noncanonical source receipts', () => {
    const text = readFileSync(resolve(PROJECT_ROOT, REPAIR_RECEIPT), 'utf8')
    const parsed = JSON.parse(text)
    expect(repairEntries(text).size).toBe(5)
    for (const invalid of ['', '{', `${text} `, JSON.stringify(parsed)]) {
      expect(() => repairEntries(invalid)).toThrow()
    }
    for (const mutation of [
      'origin',
      'extra-key',
      'extra-path',
      'missing-path',
      'mode',
      'blob',
      'entry-key',
    ]) {
      const candidate = JSON.parse(text)
      if (mutation === 'origin') candidate.validatedBase = STRUCT_SOURCE
      if (mutation === 'extra-key') candidate.approved = true
      if (mutation === 'extra-path')
        candidate.sourceChanges['src/editorial/records.ts'] =
          candidate.sourceChanges[REPAIR_PATHS[0]!]
      if (mutation === 'missing-path')
        delete candidate.sourceChanges[REPAIR_PATHS[0]!]
      if (mutation === 'mode')
        candidate.sourceChanges[REPAIR_PATHS[0]!].mode = '100755'
      if (mutation === 'blob')
        candidate.sourceChanges[REPAIR_PATHS[0]!].gitBlob = 'not-a-git-blob'
      if (mutation === 'entry-key')
        candidate.sourceChanges[REPAIR_PATHS[0]!].ignored = true
      expect(() =>
        repairEntries(`${JSON.stringify(candidate, null, 2)}\n`),
      ).toThrow()
    }
  })

  it('uses the real resolver to detect direct, re-exported, aliased and dynamic editorial reachability', () => {
    const directory = mkdtempSync(join(tmpdir(), 'editorial-import-negative-'))
    try {
      const editorial = resolve(EDITORIAL_DIRECTORY, 'records.ts')
      const bridge = join(directory, 'bridge.ts')
      writeFileSync(bridge, `export * from ${JSON.stringify(editorial)}\n`)
      const cases = [
        `import ${JSON.stringify(editorial)}`,
        `export * from './bridge'`,
        `import * as editorialAlias from ${JSON.stringify(editorial)}`,
        `const lazy = import('./bridge')`,
        `---\nimport * as editorialAlias from ${JSON.stringify(editorial)}\n---\n<p>invented fixture</p>`,
      ]
      for (const [index, body] of cases.entries()) {
        const root = join(
          directory,
          index === cases.length - 1 ? 'route.astro' : `root${index}.ts`,
        )
        writeFileSync(root, body)
        expect(
          [...reachableFrom([root])].some((file) =>
            file.startsWith(`${EDITORIAL_DIRECTORY}${sep}`),
          ),
        ).toBe(true)
      }
      const clean = join(directory, 'clean.ts')
      writeFileSync(clean, 'export const invented = true\n')
      expect(
        [...reachableFrom([clean])].some((file) =>
          file.startsWith(`${EDITORIAL_DIRECTORY}${sep}`),
        ),
      ).toBe(false)
      const phraseFile = join(directory, 'activation.ts')
      writeFileSync(
        phraseFile,
        'export const phrase = "erniesg.editorial.activate.v1"\n',
      )
      expect(
        filesUnder(directory).filter((file) =>
          readFileSync(file, 'utf8').includes('erniesg.editorial.activate.v1'),
        ),
      ).toEqual([phraseFile])
      const rootMigrations = readdirSync(resolve(PROJECT_ROOT, 'migrations'))
        .filter((name) => name.endsWith('.sql'))
        .sort()
      const contaminated = [
        ...rootMigrations,
        '0006_editorial_store.sql',
      ].sort()
      expect(() => expect(contaminated).toEqual(rootMigrations)).toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
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

import { existsSync, readFileSync, statSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { buildStructDocument as legacyBuild } from '../src/struct/from-reconstruction'
import { buildStructDocument as facadeBuild } from '../src/struct-adapters'
import { buildStructDocument as rootBuild } from '../src/struct'
import { diagnosticCategory as appDiagnosticCategory } from '../src/struct-adapters/recovery'
import { diagnosticCategory as packageDiagnosticCategory } from '@erniesg/struct/recovery'

const root = new URL('../src/', import.meta.url)
const portableRoot = new URL('struct/', root)
const adapterRoot = new URL('struct-adapters/', root)
const rootPath = fileURLToPath(root)

const projectRoot = new URL('../', import.meta.url)

const tsconfig = JSON.parse(
  readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'),
) as {
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }
}
const tsconfigBaseUrl = tsconfig.compilerOptions?.baseUrl ?? '.'
const tsconfigPaths = tsconfig.compilerOptions?.paths ?? {}

/**
 * Resolves a non-relative specifier through the real tsconfig path mapping
 * (`baseUrl` plus `paths`), so a production module that reaches a migrated
 * family through the `@/*` alias is detected instead of skipped.
 */
function resolveAliasSpecifier(specifier: string): string | null {
  for (const [pattern, targets] of Object.entries(tsconfigPaths)) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1)
      if (specifier.startsWith(prefix)) {
        const rest = specifier.slice(prefix.length)
        const targetPattern = targets[0] ?? ''
        const resolvedRelative = targetPattern.endsWith('/*')
          ? `${targetPattern.slice(0, -1)}${rest}`
          : targetPattern
        const base = new URL(
          `${tsconfigBaseUrl.replace(/\/$/, '') || '.'}/`,
          projectRoot,
        )
        return new URL(resolvedRelative.replace(/^\.\//, ''), base).pathname
      }
    } else if (specifier === pattern) {
      const target = targets[0]
      if (target) {
        const base = new URL(
          `${tsconfigBaseUrl.replace(/\/$/, '') || '.'}/`,
          projectRoot,
        )
        return new URL(target.replace(/^\.\//, ''), base).pathname
      }
    }
  }
  // Fall back to the alias forms actually used in this repository even if the
  // tsconfig mapping is absent, so the guard stays robust.
  if (specifier.startsWith('@/')) {
    return new URL(`./src/${specifier.slice(2)}`, projectRoot).pathname
  }
  if (specifier.startsWith('~/')) {
    return new URL(`./src/${specifier.slice(2)}`, projectRoot).pathname
  }
  if (specifier.startsWith('src/')) {
    return new URL(`./${specifier}`, projectRoot).pathname
  }
  return null
}

const permittedRecoveryImporter = new URL('struct/recovery.ts', root).pathname
const permittedAdapterRecoveryImporter = new URL(
  'struct-adapters/recovery.ts',
  root,
).pathname
const permittedRecoverySpecifiers = [
  '../struct-adapters/recovery',
  '../struct-adapters/recovery.ts',
]
const migratedFamilies = new Set(['types', 'ids', 'reading-order', 'codec'])

function importedPaths(source: string, file: URL): string[] {
  if (file.pathname.endsWith('.astro')) {
    const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? ''
    const scripts = [
      ...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),
    ].map((match) => match[1])
    source = [frontmatter, ...scripts].join('\n')
  }
  const ast = ts.createSourceFile(
    file.pathname,
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const paths: string[] = []
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      if (ts.isStringLiteral(node.moduleSpecifier))
        paths.push(node.moduleSpecifier.text)
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      if (ts.isStringLiteral(node.argument.literal))
        paths.push(node.argument.literal.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0]
      paths.push(
        argument && ts.isStringLiteralLike(argument)
          ? argument.text
          : '<nonliteral dynamic import>',
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return paths
}

function boundaryViolations(
  source: string,
  file: URL,
  publicPaths: Set<string>,
): string[] {
  const portable = file.pathname.startsWith(portableRoot.pathname)
  return importedPaths(source, file).filter((specifier) => {
    if (specifier === '<nonliteral dynamic import>')
      return portable || file.pathname.startsWith(adapterRoot.pathname)
    if (
      specifier === '@erniesg/struct' ||
      specifier.startsWith('@erniesg/struct/')
    ) {
      return !publicPaths.has(specifier)
    }
    if (specifier.startsWith('.')) {
      const target = new URL(specifier, file).pathname
      if (target.includes('/node_modules/')) return true
      if (!portable) return false
      // The legacy root barrel reaches the app adapter and is not a portable API.
      if (
        target.replace(/\/(?:index(?:\.(?:ts|js))?)?\/?$/, '/') ===
        portableRoot.pathname
      )
        return true
      if (
        file.pathname ===
          new URL('struct/from-reconstruction.ts', root).pathname &&
        specifier === '../struct-adapters/from-reconstruction'
      )
        return false
      if (
        file.pathname === new URL('struct/recovery.ts', root).pathname &&
        specifier === '../struct-adapters/recovery'
      )
        return false
      if (
        target === new URL('struct/from-reconstruction', root).pathname ||
        target === new URL('struct/from-reconstruction.ts', root).pathname ||
        target === new URL('struct/from-reconstruction.js', root).pathname
      ) {
        return (
          file.pathname !== new URL('struct/index.ts', root).pathname ||
          (specifier !== './from-reconstruction' &&
            specifier !== './from-reconstruction.js')
        )
      }
      return !target.startsWith(portableRoot.pathname)
    }
    return portable && /^(?:\/|src\/|@\/|~\/)/.test(specifier)
  })
}

async function publicPackagePaths(): Promise<Set<string>> {
  const manifest = JSON.parse(
    await readFile(
      new URL('../node_modules/@erniesg/struct/package.json', import.meta.url),
      'utf8',
    ),
  ) as {
    exports: Record<string, unknown>
  }
  return new Set(
    Object.keys(manifest.exports).map((path) =>
      path === '.' ? '@erniesg/struct' : `@erniesg/struct/${path.slice(2)}`,
    ),
  )
}

async function portableFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => portableFiles(new URL(`${entry.name}/`, directory))),
  )
  return [
    ...nested.flat(),
    ...entries
      .filter(
        (entry) =>
          entry.isFile() &&
          /\.(?:[cm]?[jt]sx?|astro)$/.test(entry.name) &&
          !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name),
      )
      .map((entry) => new URL(entry.name, directory)),
  ]
}

function isMigratedFamilyTarget(target: string): boolean {
  return /struct\/(types|ids|reading-order|codec)(?:\/(?:index)?)?$/.test(target)
}

function isStructBarrelTarget(target: string): boolean {
  const normalized = target.replace(/\/(?:index(?:\.(?:ts|js|tsx|astro))?)?$/, '')
  return (
    normalized === portableRoot.pathname.replace(/\/$/, '') ||
    normalized === new URL('struct', root).pathname
  )
}

function e03ViolationsForSource(
  source: string,
  file: URL,
  publicPaths: Set<string>,
): string[] {
  const violations: string[] = []
  for (const specifier of importedPaths(source, file)) {
    if (specifier === '@erniesg/struct' || specifier.startsWith('@erniesg/struct/')) {
      if (!publicPaths.has(specifier)) {
        violations.push(`${file.pathname}: private package import ${specifier}`)
      }
      continue
    }
    let target: string | null = null
    if (specifier.startsWith('.')) {
      target = new URL(specifier, file).pathname.replace(
        /\.(?:[cm]?[jt]s|astro)$/u,
        '',
      )
    } else {
      const resolved = resolveAliasSpecifier(specifier)
      if (resolved !== null) {
        target = resolved.replace(/\.(?:[cm]?[jt]s|astro)$/u, '')
      } else {
        continue
      }
    }
    if (target === null) continue

    // Skip permitted recovery paths.
    if (file.pathname === permittedRecoveryImporter) {
      const permitted = permittedRecoverySpecifiers.some((s) => {
        const t = new URL(s, file).pathname.replace(/\.(?:[cm]?[jt]s|astro)$/u, '')
        return (
          target === t ||
          target === new URL('struct-adapters/recovery', root).pathname ||
          target === new URL('struct-adapters/recovery.ts', root).pathname
        )
      })
      if (permitted) continue
    }

    if (isMigratedFamilyTarget(target)) {
      const match = target.match(
        /struct\/(types|ids|reading-order|codec)(?:\/(?:index)?)?$/,
      )
      if (match && migratedFamilies.has(match[1]!)) {
        violations.push(
          `${file.pathname}: migrated family import ${specifier} -> ${target}`,
        )
      }
    }
    if (isStructBarrelTarget(target)) {
      violations.push(
        `${file.pathname}: migrated family import ${specifier} -> ${target}`,
      )
    }
  }
  return violations
}

/**
 * The E-04 migrated families. They are the local compatibility copies of the
 * package renderers and of the emitted-id helpers; they stay on disk until
 * E-07, so no production module may reach them any more.
 */
const E04_FAMILY_IDS = new Set([
  'struct/xhtml',
  'struct/epub',
  'struct/emitted-ids',
])

const MODULE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.astro',
]

function isFile(pathname: string): boolean {
  if (!existsSync(pathname)) return false
  return statSync(pathname).isFile()
}

/**
 * The canonical id of a local module: its path relative to `src/`, without the
 * file extension and without a trailing `/index`, so `struct/codec/index.ts`
 * and `struct/codec` are one module and `struct/index.ts` is `struct`.
 */
function localModuleId(pathname: string): string | null {
  if (!pathname.startsWith(rootPath)) return null
  return pathname
    .slice(rootPath.length)
    .replace(/\.(?:[cm]?[jt]sx?|astro)$/u, '')
    .replace(/\/index$/u, '')
}

/**
 * Resolves a specifier to a local path under `src/`. Relative specifiers are
 * resolved against the importing file and the `@/` and `~/` aliases with the
 * `@/* -> src/*` mapping of `tsconfig.json`; every other specifier (a package
 * or a Node builtin) is not a local module.
 */
function resolveLocalPath(specifier: string, file: string): string | null {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return resolvePath(dirname(file), specifier)
  }
  if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
    return resolvePath(rootPath, specifier.slice(2))
  }
  return null
}

/** The file a local path denotes, following the `/index` form. */
function localModuleFile(pathname: string): string | null {
  if (isFile(pathname)) return pathname
  for (const extension of MODULE_EXTENSIONS) {
    const candidate = `${pathname}${extension}`
    if (isFile(candidate)) return candidate
  }
  for (const extension of MODULE_EXTENSIONS) {
    const candidate = `${pathname}/index${extension}`
    if (isFile(candidate)) return candidate
  }
  return null
}

/**
 * The specifiers a module imports and the specifiers it re-exports, with the
 * same AST resolution as `importedPaths`: `.astro` frontmatter and scripts,
 * import declarations, export declarations, `import type` nodes and dynamic
 * `import()` calls.
 */
function moduleSpecifiers(
  source: string,
  file: URL,
): { imported: string[]; reExported: string[] } {
  if (file.pathname.endsWith('.astro')) {
    const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? ''
    const scripts = [
      ...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),
    ].map((match) => match[1])
    source = [frontmatter, ...scripts].join('\n')
  }
  const ast = ts.createSourceFile(
    file.pathname,
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const imported: string[] = []
  const reExported: string[] = []
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        imported.push(node.moduleSpecifier.text)
        if (ts.isExportDeclaration(node))
          reExported.push(node.moduleSpecifier.text)
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      if (ts.isStringLiteral(node.argument.literal))
        imported.push(node.argument.literal.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0]
      imported.push(
        argument && ts.isStringLiteralLike(argument)
          ? argument.text
          : '<nonliteral dynamic import>',
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return { imported, reExported }
}

let exportGraph: Promise<Map<string, string[]>> | null = null

/**
 * The re-export graph of `src/`: for every local module, the local modules it
 * re-exports. The graph is built once per test process from the checked-in
 * sources, so a barrel that re-exports a migrated family is found no matter
 * which spelling the production module used to reach it.
 */
function localExportGraph(): Promise<Map<string, string[]>> {
  exportGraph ??= (async () => {
    const graph = new Map<string, string[]>()
    for (const file of await portableFiles(root)) {
      const source = await readFile(file, 'utf8')
      const edges: string[] = []
      for (const specifier of moduleSpecifiers(source, file).reExported) {
        const target = resolveLocalPath(specifier, fileURLToPath(file))
        if (target === null || !target.startsWith(rootPath)) continue
        const resolved = localModuleFile(target)
        if (resolved === null) continue
        edges.push(resolved)
      }
      graph.set(fileURLToPath(file), edges)
    }
    return graph
  })()
  return exportGraph
}

/**
 * The migrated families a local module reaches, directly or through the
 * re-exports of a barrel, an index or an alias module. The result is sorted so
 * that the violation list of the guard is stable.
 */
async function reachedE04Families(pathname: string): Promise<string[]> {
  const graph = await localExportGraph()
  const families = new Set<string>()
  const seen = new Set<string>()
  const stack = [pathname]
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (seen.has(current)) continue
    seen.add(current)
    const id = localModuleId(current)
    if (id !== null && E04_FAMILY_IDS.has(id)) families.add(id)
    for (const next of graph.get(current) ?? []) stack.push(next)
  }
  return [...families].sort()
}

/**
 * The E-04 violations of one module. A production module may not reach
 * `src/struct/xhtml`, `src/struct/epub` or `src/struct/emitted-ids`: not
 * directly, not through a barrel, not through an index, not through an alias
 * and not through a transitive re-export.
 */
async function e04FamilyViolations(
  source: string,
  file: URL,
  publicPaths: Set<string>,
): Promise<string[]> {
  const violations: string[] = []
  for (const specifier of moduleSpecifiers(source, file).imported) {
    if (
      specifier === '@erniesg/struct' ||
      specifier.startsWith('@erniesg/struct/')
    ) {
      if (!publicPaths.has(specifier))
        violations.push(`${file.pathname}: private package import ${specifier}`)
      continue
    }
    const target = resolveLocalPath(specifier, fileURLToPath(file))
    if (target === null) continue
    const id = localModuleId(target)
    if (id !== null && E04_FAMILY_IDS.has(id)) {
      violations.push(
        `${file.pathname}: migrated family import ${specifier} -> ${id}`,
      )
      continue
    }
    const resolved = localModuleFile(target)
    if (resolved === null) continue
    const families = await reachedE04Families(resolved)
    for (const family of families) {
      violations.push(
        `${file.pathname}: migrated family re-export import ${specifier} -> ${family}`,
      )
    }
  }
  return violations
}

describe('app-owned Struct adapter boundary', () => {
  it('keeps one implementation and identity through the legacy and root exports', async () => {
    const implementation = await readFile(
      new URL('struct-adapters/from-reconstruction.ts', root),
      'utf8',
    )
    const legacy = await readFile(
      new URL('struct/from-reconstruction.ts', root),
      'utf8',
    )
    expect(implementation).toContain('export function buildStructDocument(')
    expect(legacy.trim()).toBe(
      "export { buildStructDocument } from '../struct-adapters/from-reconstruction'",
    )
    expect(facadeBuild).toBe(legacyBuild)
    expect(rootBuild).toBe(facadeBuild)
  })

  it('keeps one app-owned recovery implementation and legacy forwarding', async () => {
    const implementation = await readFile(
      new URL('struct-adapters/recovery.ts', root),
      'utf8',
    )
    const legacy = await readFile(
      new URL('struct/recovery.ts', root),
      'utf8',
    )
    expect(implementation).toContain('export function recoverySummary(')
    expect(implementation).toContain(
      "} from '@erniesg/struct/document'",
    )
    expect(implementation).not.toContain("} from './types'")
    expect(legacy.trim()).toBe(
      `export {
  diagnosticCategory,
  diagnosticCopy,
  hasActionableRecovery,
  recoverySummary,
  toStructDiagnostic,
  type RecoveryDiagnosticInput,
} from '../struct-adapters/recovery'`,
    )
    const [adapterRecovery, legacyRecovery, rootRecovery] = await Promise.all([
      import('../src/struct-adapters/recovery'),
      import('../src/struct/recovery'),
      import('../src/struct'),
    ])
    for (const name of [
      'diagnosticCategory',
      'diagnosticCopy',
      'hasActionableRecovery',
      'recoverySummary',
      'toStructDiagnostic',
    ] as const) {
      expect(adapterRecovery[name]).toBe(legacyRecovery[name])
      expect(adapterRecovery[name]).toBe(rootRecovery[name])
    }
  })

  it('keeps app recovery consumers on the app-owned path', async () => {
    const legacyRecovery = new URL('struct/recovery', root).pathname
    const violations: string[] = []
    for (const file of await portableFiles(root)) {
      if (file.pathname.startsWith(portableRoot.pathname)) continue
      const source = await readFile(file, 'utf8')
      for (const specifier of importedPaths(source, file)) {
        if (!specifier.startsWith('.')) {
          if (
            specifier === '@/struct/recovery' ||
            specifier === '@/struct/recovery.ts'
          )
            violations.push(`${file.pathname}: ${specifier}`)
          continue
        }
        const target = new URL(specifier, file).pathname.replace(
          /\.(?:[cm]?[jt]s|astro)$/u,
          '',
        )
        if (target === legacyRecovery)
          violations.push(`${file.pathname}: ${specifier}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps all implementation modules within their allowed import boundaries', async () => {
    const publicPaths = await publicPackagePaths()
    const files = await portableFiles(root)
    expect(files.map((file) => file.pathname)).toContain(
      new URL('research/import-types.ts', root).pathname,
    )
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      expect(
        boundaryViolations(source, file, publicPaths),
        file.pathname,
      ).toEqual([])
    }
  })

  it('rejects app reconstruction and private package imports in synthetic modules', async () => {
    const publicPaths = await publicPackagePaths()
    const portable = new URL('struct/codec/probe.ts', root)
    const adapter = new URL('struct-adapters/nested/probe.ts', root)
    const legacy = new URL('struct/from-reconstruction.ts', root)
    const legacyRecovery = new URL('struct/recovery.ts', root)
    const index = new URL('struct/index.ts', root)
    const research = new URL('research/probe.ts', root)
    for (const [file, source, rejected] of [
      [
        research,
        "import { decode } from '@erniesg/struct/src/document'",
        '@erniesg/struct/src/document',
      ],
      [portable, "import { build } from '..'", '..'],
      [
        portable,
        "import type { Source } from '../../research/import-types'",
        '../../research/import-types',
      ],
      [portable, "import { build } from '../index'", '../index'],
      [portable, "import { build } from '../index.ts'", '../index.ts'],
      [portable, "export * from '../../research/pdf'", '../../research/pdf'],
      [
        portable,
        "const load = () => import('../../research/pdf')",
        '../../research/pdf',
      ],
      [
        portable,
        "type Source = import('../../research/import-types').Source",
        '../../research/import-types',
      ],
      [
        portable,
        "import { build } from '../../struct-adapters/from-reconstruction'",
        '../../struct-adapters/from-reconstruction',
      ],
      [
        portable,
        "import { diagnosticCopy } from '../../struct-adapters/recovery'",
        '../../struct-adapters/recovery',
      ],
      [
        portable,
        "import { build } from '../from-reconstruction'",
        '../from-reconstruction',
      ],
      [
        portable,
        "import { build } from '../from-reconstruction.js'",
        '../from-reconstruction.js',
      ],
      [
        portable,
        "import type { Doc } from '@erniesg/struct/codec'",
        '@erniesg/struct/codec',
      ],
      [
        adapter,
        "export * from '@erniesg/struct/internal'",
        '@erniesg/struct/internal',
      ],
      [
        adapter,
        "const load = () => import('@erniesg/struct/dist/index.js')",
        '@erniesg/struct/dist/index.js',
      ],
      [
        adapter,
        "import type { Doc } from '../../node_modules/@erniesg/struct/dist/index'",
        '../../node_modules/@erniesg/struct/dist/index',
      ],
      [legacy, "export * from '../research/pdf'", '../research/pdf'],
      [
        legacyRecovery,
        "export * from '../struct-adapters/from-reconstruction'",
        '../struct-adapters/from-reconstruction',
      ],
      [
        legacyRecovery,
        "export * from '../struct-adapters/recovery.js'",
        '../struct-adapters/recovery.js',
      ],
      [index, "export * from '../research/pdf'", '../research/pdf'],
    ] as const) {
      expect(boundaryViolations(source, file, publicPaths), source).toContain(
        rejected,
      )
    }
    expect(
      boundaryViolations(
        "import { parse } from './parsers'\nexport type { Doc } from '../types'\nimport('@erniesg/struct/document')",
        portable,
        publicPaths,
      ),
    ).toEqual([])
    expect(
      boundaryViolations(
        "import type { Source } from '../../research/import-types'",
        adapter,
        publicPaths,
      ),
    ).toEqual([])
    expect(
      boundaryViolations(
        "export { buildStructDocument } from '../struct-adapters/from-reconstruction'",
        legacy,
        publicPaths,
      ),
    ).toEqual([])
    expect(
      boundaryViolations(
        `export {
  diagnosticCategory,
  diagnosticCopy,
  hasActionableRecovery,
  recoverySummary,
  toStructDiagnostic,
  type RecoveryDiagnosticInput,
} from '../struct-adapters/recovery'`,
        legacyRecovery,
        publicPaths,
      ),
    ).toEqual([])
    expect(
      boundaryViolations(
        "export * from './from-reconstruction'",
        index,
        publicPaths,
      ),
    ).toEqual([])
    expect(
      boundaryViolations(
        "export * from './recovery'",
        index,
        publicPaths,
      ),
    ).toEqual([])
  })

  it('E-03: prohibits migrated-family imports (types/ids/reading-order/codec) and validates package paths', async () => {
    const publicPaths = await publicPackagePaths()
    const violations: string[] = []
    for (const file of await portableFiles(root)) {
      if (file.pathname.startsWith(portableRoot.pathname)) continue
      const source = await readFile(file, 'utf8')
      violations.push(...e03ViolationsForSource(source, file, publicPaths))
    }
    expect(violations).toEqual([])

    // Red-first proof: an aliased migrated-family import must be detected, while
    // an aliased recovery import (the permitted app-owned path) stays clean.
    const probeFile = new URL('struct-adapters/nested/probe.ts', root)
    expect(
      e03ViolationsForSource(
        "import { T } from '@/struct/types'",
        probeFile,
        publicPaths,
      ),
    ).not.toEqual([])
    expect(
      e03ViolationsForSource(
        "import { diagnosticCategory } from '@/struct/recovery'",
        probeFile,
        publicPaths,
      ),
    ).toEqual([])
    expect(
      e03ViolationsForSource(
        "import { X } from '@erniesg/struct/src/document'",
        probeFile,
        publicPaths,
      ),
    ).not.toEqual([])
  })

  it('E-03: app diagnostic categories match package recovery facts', async () => {
    const source = await readFile(
      new URL('struct-adapters/recovery.ts', root),
      'utf8',
    )
    const section = source.slice(
      source.indexOf('const DIAGNOSTIC_COPY'),
      source.indexOf('const FALLBACK_COPY'),
    )
    const appCodes = [
      ...new Set(
        [...section.matchAll(/^  ([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1]!),
      ),
    ]
    const unknownCode = 'E03_PARITY_UNKNOWN_CODE'
    const codes = [...appCodes, unknownCode]

    for (const code of codes) {
      expect(
        appDiagnosticCategory(code),
        `diagnostic category for ${code}`,
      ).toBe(packageDiagnosticCategory(code))
    }
  })

  it('E-04: prohibits migrated-family imports (xhtml/epub/emitted-ids) through every local path', async () => {
    const publicPaths = await publicPackagePaths()
    const violations: string[] = []
    for (const file of await portableFiles(root)) {
      // The local compatibility copies and their own tests stay legal until
      // E-07; every other production module is in scope.
      if (file.pathname.startsWith(portableRoot.pathname)) continue
      const source = await readFile(file, 'utf8')
      violations.push(...(await e04FamilyViolations(source, file, publicPaths)))
    }
    expect(violations).toEqual([])
  })

  it('E-04: rejects migrated-family imports in synthetic modules', async () => {
    const publicPaths = await publicPackagePaths()
    const probe = new URL('research/probe.ts', root)
    for (const { source, expected } of [
      {
        source: "import { renderPublicationXhtml } from '../struct/xhtml'",
        expected: [
          `${probe.pathname}: migrated family import ../struct/xhtml -> struct/xhtml`,
        ],
      },
      {
        source: "import { buildStructEpub } from '../struct/epub'",
        expected: [
          `${probe.pathname}: migrated family import ../struct/epub -> struct/epub`,
        ],
      },
      {
        source: "import { isPackagedAssetId } from '../struct/emitted-ids'",
        expected: [
          `${probe.pathname}: migrated family import ../struct/emitted-ids -> struct/emitted-ids`,
        ],
      },
      {
        source:
          "import { renderPublicationXhtml as localRenderer } from '../struct/xhtml'",
        expected: [
          `${probe.pathname}: migrated family import ../struct/xhtml -> struct/xhtml`,
        ],
      },
      {
        source: "import * as localTree from '../struct/xhtml'",
        expected: [
          `${probe.pathname}: migrated family import ../struct/xhtml -> struct/xhtml`,
        ],
      },
      {
        source: "export { buildStructEpub } from '../struct/epub'",
        expected: [
          `${probe.pathname}: migrated family import ../struct/epub -> struct/epub`,
        ],
      },
      {
        source: "import { buildStructEpub } from '../struct'",
        expected: [
          `${probe.pathname}: migrated family re-export import ../struct -> struct/epub`,
          `${probe.pathname}: migrated family re-export import ../struct -> struct/xhtml`,
        ],
      },
      {
        source: "import { buildStructEpub } from '../struct/index'",
        expected: [
          `${probe.pathname}: migrated family re-export import ../struct/index -> struct/epub`,
          `${probe.pathname}: migrated family re-export import ../struct/index -> struct/xhtml`,
        ],
      },
      {
        source: "import { renderPublicationXhtml } from '@/struct/xhtml'",
        expected: [
          `${probe.pathname}: migrated family import @/struct/xhtml -> struct/xhtml`,
        ],
      },
      {
        source: "import { buildStructEpub } from '@/struct'",
        expected: [
          `${probe.pathname}: migrated family re-export import @/struct -> struct/epub`,
          `${probe.pathname}: migrated family re-export import @/struct -> struct/xhtml`,
        ],
      },
    ]) {
      expect(
        await e04FamilyViolations(source, probe, publicPaths),
        source,
      ).toEqual(expected)
    }
    for (const source of [
      "import { buildStructEpub } from '@erniesg/struct/renderers/epub'",
      "import { renderPublicationXhtml } from '@erniesg/struct/renderers/xhtml'",
      "import { buildStructDocument } from '../struct-adapters/from-reconstruction'",
      "import { recoverySummary } from '../struct-adapters/recovery'",
      "import { buildEpub } from './epub'",
    ]) {
      expect(
        await e04FamilyViolations(source, probe, publicPaths),
        source,
      ).toEqual([])
    }
  })
})

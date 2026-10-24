// Preserve the renderer-family boundary independently of the expanded core guard.
// These helpers and negative vectors retain the E04 integration contract.
import { existsSync, statSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = new URL('../src/', import.meta.url)
const portableRoot = new URL('struct/', root)
const rootPath = fileURLToPath(root)


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
describe('package renderer import boundary', () => {


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

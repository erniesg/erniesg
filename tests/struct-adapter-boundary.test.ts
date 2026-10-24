import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { parse as parseAstroSource } from '@astrojs/compiler/sync'
import type {
  AttributeNode as AstroAttributeNode,
  Node as AstroNode,
} from '@astrojs/compiler/types'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { buildStructDocument as legacyBuild } from '../src/struct/from-reconstruction'
import { buildStructDocument as facadeBuild } from '../src/struct-adapters'
import { buildStructDocument as rootBuild } from '../src/struct'
import { diagnosticCategory as appDiagnosticCategory } from '../src/struct-adapters/recovery'
import { decodeStructDocument as appDecodeStructDocument } from '../src/struct/codec'
import { seal, validDocument } from '../src/struct/codec-test-fixtures'
import { diagnosticCategory as packageDiagnosticCategory } from '@erniesg/struct/recovery'
import {
  decodeStructDocument as packageDecodeStructDocument,
  type StructDocument,
} from '@erniesg/struct/document'
import {
  buildEpub as appBuildEpub,
  renderPublicationXhtml as appRenderPublicationXhtml,
} from '../src/research/epub'
import { renderPublicationXhtml } from '@erniesg/struct/renderers/xhtml'
import { buildStructEpub as packageBuildStructEpub } from '@erniesg/struct/renderers/epub'

/**
 * A glob matcher: it answers whether one path matches a pattern.
 */
type GlobMatcher = (input: string) => boolean

/**
 * The factory that builds a glob matcher for one pattern.
 */
type GlobMatcherFactory = (
  pattern: string,
  options?: {
    dot?: boolean
    nocase?: boolean
    noextglob?: boolean
    noglobstar?: boolean
    posix?: boolean
  },
) => GlobMatcher

/**
 * The glob matcher Vite itself uses for a glob import.
 *
 * Vite resolves an `import.meta.glob` pattern with picomatch: the bundler
 * depends on picomatch directly, and the globber Vite calls to enumerate the
 * files of a glob import (tinyglobby) matches the enumerated files with
 * picomatch as well. The guard therefore matches a pattern with the matcher
 * the bundler matches it with, instead of a hand-written conversion of its
 * own, so a pattern form the bundler resolves - a character class, a brace
 * alternation, a negated class - is a pattern form the guard resolves.
 *
 * The package is a transitive dependency of the repository: `vite` 8.1.6
 * depends on `picomatch` ^4.0.5 and `tinyglobby` 0.2.17 depends on
 * `picomatch` ^4.0.4, and the lockfile places picomatch 4.0.5 at the root of
 * `node_modules`. It ships no type declarations, so the matcher is required
 * through `createRequire` and typed here.
 */
const picomatch = createRequire(import.meta.url)(
  'picomatch',
) as GlobMatcherFactory

/**
 * The options Vite matches a glob pattern with.
 *
 * Vite calls the globber with `extglob: false` and matches case-sensitively
 * unless the glob asks for something else, and the globber matches with
 * POSIX brackets. The guard matches with the same options: an extended glob
 * (`@(a|b)`) is a literal name, `[!x]` and `[^x]` are negated classes, a
 * brace group lists alternatives and `*` does not reach a dot file.
 */
const viteGlobOptions = {
  dot: false,
  nocase: false,
  noextglob: true,
  noglobstar: false,
  posix: true,
}

const root = new URL('../src/', import.meta.url)
const portableRoot = new URL('struct/', root)
const adapterRoot = new URL('struct-adapters/', root)

const tsconfig = JSON.parse(
  readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'),
) as {
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }
}
const tsconfigBaseUrl = tsconfig.compilerOptions?.baseUrl ?? '.'
const tsconfigPaths = tsconfig.compilerOptions?.paths ?? {}

const projectRoot = new URL('../', import.meta.url)

/**
 * The project root as a path. Vite resolves a project-root glob pattern
 * against this directory, so the guard normalises such a pattern into its
 * project-root-relative form before it matches.
 */
const projectRootPath = projectRoot.pathname

/**
 * The directory the TypeScript path aliases are resolved against.
 */
const tsconfigBaseUrlDirectory = resolve(projectRootPath, tsconfigBaseUrl)

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
  // A project-root specifier resolves against the repository root, so
  // '/src/struct/types' names the same local migrated family as
  // '@/struct/types' and must not fall through the resolver.
  if (specifier.startsWith('/')) {
    return new URL(`.${specifier}`, projectRoot).pathname
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

/**
 * The sentinel a computed CommonJS require records. A computed require has
 * no literal specifier, so the guard cannot prove that it does not load a
 * migrated family; it fails closed in the same way a computed dynamic
 * import does.
 */
const NONLITERAL_REQUIRE = '<nonliteral require>'

/**
 * The sentinel a computed glob records. A computed glob has no literal
 * pattern, so the guard cannot prove that it does not load a migrated
 * family; it fails closed in the same way a computed dynamic import does.
 */
const NONLITERAL_GLOB = '<nonliteral glob>'

/**
 * The family a retained-tree wrapper reaches through a re-export that names
 * no literal target. A computed re-export cannot be resolved, so the guard
 * cannot prove that it does not reach a migrated family; it fails closed in
 * the same way a computed require does.
 */
const UNRESOLVED_REEXPORT = 'an unresolved re-export' as const

/** What the guard knows about a computed require. */
type ComputedRequire = {
  /** The string literals inside the argument. */
  fragments: string[]
  /** The static text of the argument. */
  staticText: string
}

/** What the guard knows about a computed glob. */
type ComputedGlob = {
  /** The string literals inside the argument. */
  fragments: string[]
  /** The static text of the argument. */
  staticText: string
  /** Whether the glob is case-sensitive. */
  caseSensitive?: boolean
}

/**
 * The `base` option of a glob call. Vite resolves a relative glob pattern
 * from the resolved base, so the guard has to know which directory the
 * pattern is resolved from.
 *
 * A call that names no base resolves its relative patterns from the
 * directory of the importing module, a call that names a literal base
 * resolves them from that base, and a call whose base is not a literal fails
 * closed, because the guard cannot prove which directory the pattern is
 * resolved from.
 */
type GlobBase =
  | { kind: 'none' }
  | { kind: 'literal'; base: string }
  | { kind: 'computed' }

/**
 * The local root of every migrated family. A nested module inside a family
 * (for example `src/struct/codec/parsers`) is part of that family, so the
 * prohibition covers the whole subtree and not only the family entry file.
 */
const migratedFamilyRoots = new Map(
  [...migratedFamilies].map((family) => [
    family,
    `${portableRoot.pathname}${family}`,
  ]),
)

/**
 * The app-owned recovery presentation module. The plan enumerates its
 * permitted importers, so a new production importer has to be added to that
 * list deliberately instead of appearing by accident.
 */
const appRecoveryModule = new URL('struct-adapters/recovery', root).pathname

/**
 * The compatibility forwarder the retained `src/struct` tree keeps for its
 * own legacy callers. It re-exports the app-owned recovery module, so a
 * module outside that tree reaches the recovery module through the legacy
 * facade when it imports the forwarder, whatever spelling it uses.
 */
const compatibilityRecoveryForwarder = new URL(
  'struct/recovery',
  root,
).pathname
const permittedRecoveryImporters = new Set([
  permittedRecoveryImporter,
  permittedAdapterRecoveryImporter,
  new URL('struct-adapters/from-reconstruction.ts', root).pathname,
  new URL('research/recovery-projection.ts', root).pathname,
  new URL('components/research/PublicationImporter.tsx', root).pathname,
])

function importedPaths(
  source: string,
  file: URL,
  computedDynamicImports?: string[][],
  computedRequires?: ComputedRequire[],
  computedGlobs?: ComputedGlob[],
  packageNamedImports?: Map<string, string[]>,
): string[] {
  const ast = ts.createSourceFile(
    file.pathname,
    scanSource(source, file),
    ts.ScriptTarget.Latest,
    true,
  )
  const paths: string[] = []
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text
        paths.push(specifier)
        // Collect named imports for package imports to validate symbols
        if (
          packageNamedImports &&
          (specifier === '@erniesg/struct' || specifier.startsWith('@erniesg/struct/'))
        ) {
          const names: string[] = []
          if (ts.isImportDeclaration(node)) {
            const importClause = node.importClause
            if (importClause?.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
              for (const element of importClause.namedBindings.elements) {
                names.push(element.propertyName?.text ?? element.name.text)
              }
            }
          }
          if (names.length > 0) {
            packageNamedImports.set(specifier, names)
          }
        }
      }
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
      if (argument && ts.isStringLiteralLike(argument)) {
        paths.push(argument.text)
      } else {
        paths.push('<nonliteral dynamic import>')
        computedDynamicImports?.push(stringLiteralsIn(argument))
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      // A CommonJS require is an import too.
      const argument = node.arguments[0]
      if (argument && ts.isStringLiteralLike(argument)) {
        paths.push(argument.text)
      } else {
        // A computed require has no literal specifier either, so the guard
        // cannot prove that it does not load a migrated family. It fails
        // closed in the same way a computed dynamic import does.
        paths.push(NONLITERAL_REQUIRE)
        computedRequires?.push({
          fragments: stringLiteralsIn(argument),
          staticText: staticTextIn(argument),
        })
      }
    } else if (
      ts.isCallExpression(node) &&
      isImportMetaGlobCall(node)
    ) {
      // A Vite glob import names a set of modules the bundler resolves, so it
      // is an import too.
      const argument = node.arguments[0]
      const patterns = globPatternsIn(argument)
      const options = node.arguments[1]
      const caseSensitive = globCaseSensitiveOption(options)
      const base = globBaseOption(options)
      if (patterns === null || base.kind === 'computed') {
        // A computed glob pattern has no literal target, so the guard cannot
        // prove that it does not load a migrated family. It fails closed in
        // the same way a computed dynamic import does. A computed `base`
        // option fails closed the same way, because the guard cannot prove
        // which directory the pattern is resolved from.
        paths.push(NONLITERAL_GLOB)
        computedGlobs?.push({
          fragments: [
            ...stringLiteralsIn(argument),
            ...stringLiteralsIn(options),
          ],
          staticText: staticTextIn(argument),
          caseSensitive,
        })
      } else {
        paths.push(...globFamilySpecifiers(patterns, file, base, caseSensitive))
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      // `import x = require('...')` is a TypeScript import too.
      const expression = node.moduleReference.expression
      if (ts.isStringLiteralLike(expression)) paths.push(expression.text)
    } else if (
      ts.isNewExpression(node) &&
      isWorkerConstructor(node.expression) &&
      (node.arguments?.length ?? 0) > 0
    ) {
      // `new Worker(new URL('./entry.ts', import.meta.url))` makes that file a
      // worker entry: Vite bundles it as a module of its own, so it is an
      // import the guard has to inspect.
      const entry = workerEntrySpecifier(node.arguments?.[0])
      if (entry !== null) paths.push(entry)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return paths
}

/**
 * The imports a module names: the specifiers it imports and the computed
 * imports it hides.
 */
type ParsedImports = {
  /** Every specifier the module names. */
  specifiers: string[]
  /** The string literals inside every computed dynamic import. */
  computedDynamicImports: string[][]
  /** What the guard knows about every computed require. */
  computedRequires: ComputedRequire[]
  /** What the guard knows about every computed glob. */
  computedGlobs: ComputedGlob[]
  /** Named imports for package imports (specifier -> imported names). */
  packageNamedImports: Map<string, string[]>
}

/**
 * The imports of a module.
 *
 * The named specifiers are the same whether the computed imports are
 * collected or not, so the collected form is the one the guard analyses and
 * the plain form reuses it.
 */
function parseImports(source: string, file: URL): ParsedImports {
  const computedDynamicImports: string[][] = []
  const computedRequires: ComputedRequire[] = []
  const computedGlobs: ComputedGlob[] = []
  const packageNamedImports = new Map<string, string[]>()
  const specifiers = importedPaths(
    source,
    file,
    computedDynamicImports,
    computedRequires,
    computedGlobs,
    packageNamedImports,
  )
  return { specifiers, computedDynamicImports, computedRequires, computedGlobs, packageNamedImports }
}

/**
 * Whether a call is a Vite glob import. `import.meta.glob` and its
 * deprecated alias `import.meta.globEager` both name a set of modules the
 * bundler resolves, so both are imports the guard has to inspect.
 */
function isImportMetaGlobCall(node: ts.CallExpression): boolean {
  const expression = node.expression
  if (!ts.isPropertyAccessExpression(expression)) return false
  const owner = expression.expression
  if (!ts.isMetaProperty(owner)) return false
  if (owner.keywordToken !== ts.SyntaxKind.ImportKeyword) return false
  return expression.name.text === 'glob' || expression.name.text === 'globEager'
}

/**
 * Whether a constructor starts a worker. Both the dedicated worker and the
 * shared worker take a worker entry the same way, so both are inspected.
 */
function isWorkerConstructor(expression: ts.Expression): boolean {
  if (!ts.isIdentifier(expression)) return false
  return expression.text === 'Worker' || expression.text === 'SharedWorker'
}

/**
 * The literal target of a worker entry, or null when the worker is not
 * started from a literal `new URL(..., import.meta.url)`. Vite treats that
 * file as the entry of a separate module and bundles it, so the literal is a
 * module specifier the guard has to inspect.
 */
function workerEntrySpecifier(
  argument: ts.Expression | undefined,
): string | null {
  if (!argument || !ts.isNewExpression(argument)) return null
  if (!ts.isIdentifier(argument.expression)) return null
  if (argument.expression.text !== 'URL') return null
  const target = argument.arguments?.[0]
  const base = argument.arguments?.[1]
  if (!target || !ts.isStringLiteralLike(target)) return null
  if (!base || !isImportMetaUrl(base)) return null
  // Vite's worker suffix is a query of the worker URL, so it is removed
  // before the target is resolved: the query names the worker mode, not a
  // different module.
  return normalizeModuleQuery(target.text)
}

/**
 * A module specifier without its query and hash suffix. A query names a
 * bundler mode (`?worker`, `?raw`, `?url`) and a hash names a position in a
 * file, so neither of them is part of the module a specifier names.
 */
function normalizeModuleQuery(specifier: string): string {
  const cut = specifier.search(/[?#]/)
  return cut === -1 ? specifier : specifier.slice(0, cut)
}

/**
 * Whether an expression is `import.meta.url`, the base a worker entry is
 * resolved against.
 */
function isImportMetaUrl(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false
  if (!ts.isMetaProperty(node.expression)) return false
  if (node.expression.keywordToken !== ts.SyntaxKind.ImportKeyword) {
    return false
  }
  return node.name.text === 'url'
}

/**
 * The literal patterns of a glob argument, or null when the argument is
 * computed. Vite accepts a single pattern or an array of them, and every
 * element of the array has to be a literal for the pattern to be known.
 */
function globPatternsIn(argument: ts.Node | undefined): string[] | null {
  if (!argument) return null
  if (ts.isStringLiteralLike(argument)) return [argument.text]
  if (ts.isArrayLiteralExpression(argument)) {
    const patterns: string[] = []
    for (const element of argument.elements) {
      if (!ts.isStringLiteralLike(element)) return null
      patterns.push(element.text)
    }
    return patterns
  }
  return null
}

/**
 * The `base` option of a glob call.
 *
 * Vite resolves a relative glob pattern from the resolved base, so the
 * guard reads the option instead of always resolving the pattern from the
 * directory of the importing module. A literal base names the directory the
 * pattern is resolved from; a base that is not a literal fails closed, in
 * the same way a computed pattern does, because the guard cannot prove which
 * directory the pattern is resolved from.
 */
function globBaseOption(options: ts.Node | undefined): GlobBase {
  if (!options) return { kind: 'none' }
  // An options argument that is not an object literal cannot be read, so the
  // guard cannot prove that it names no base.
  if (!ts.isObjectLiteralExpression(options)) return { kind: 'computed' }
  for (const property of options.properties) {
    // A spread carries properties the guard cannot read.
    if (ts.isSpreadAssignment(property)) return { kind: 'computed' }
    const name = property.name
    // A computed property name may name the base, so the guard cannot prove
    // that it does not.
    if (ts.isComputedPropertyName(name)) return { kind: 'computed' }
    const isBase =
      ts.isIdentifier(name)
        ? name.text === 'base'
        : ts.isStringLiteralLike(name) && name.text === 'base'
    if (!isBase) continue
    if (!ts.isPropertyAssignment(property)) return { kind: 'computed' }
    const initializer = property.initializer
    if (ts.isStringLiteralLike(initializer)) {
      return { kind: 'literal', base: initializer.text }
    }
    return { kind: 'computed' }
  }
  return { kind: 'none' }
}

/**
 * The `caseSensitive` option of a glob call.
 *
 * Vite supports `caseSensitive: false` in the options of `import.meta.glob`,
 * which makes the glob match case-insensitively. The guard must propagate
 * this option to the picomatch matcher.
 */
function globCaseSensitiveOption(options: ts.Node | undefined): boolean {
  if (!options) return false
  // An options argument that is not an object literal cannot be read, so the
  // guard cannot prove that it does not use case-insensitive matching.
  if (!ts.isObjectLiteralExpression(options)) return false
  for (const property of options.properties) {
    // A spread carries properties the guard cannot read.
    if (ts.isSpreadAssignment(property)) continue
    const name = property.name
    // A computed property name may name the option, so the guard cannot prove
    // that it does not.
    if (ts.isComputedPropertyName(name)) continue
    const isCaseSensitive =
      ts.isIdentifier(name)
        ? name.text === 'caseSensitive'
        : ts.isStringLiteralLike(name) && name.text === 'caseSensitive'
    if (!isCaseSensitive) continue
    if (!ts.isPropertyAssignment(property)) continue
    const initializer = property.initializer
    if (ts.isStringLiteralLike(initializer)) {
      return initializer.text === 'false'
    }
    // For a bare `caseSensitive` without a value (unlikely but handle gracefully),
    // treat as case-insensitive
    if (initializer === undefined) return true
    return false
  }
  return false // default: case-sensitive
}

/**
 * The directory a relative glob pattern is resolved from when the glob call
 * names a literal base.
 *
 * Vite resolves a base that starts with '/' against the project root, so
 * '/src' names the `src` directory of the project. A base that names an
 * absolute directory that the project does not hold is used as it is, and a
 * relative base is resolved against the directory of the importing module,
 * the way Vite resolves it.
 */
function globBaseDirectory(base: string, importerDirectory: string): string {
  if (!base.startsWith('/')) return resolve(importerDirectory, base)
  const fromProjectRoot = resolve(projectRootPath, `.${base}`)
  if (existsSync(fromProjectRoot)) return fromProjectRoot
  return base
}

/**
 * Every file of a migrated family: the family entry file and every module
 * nested in the family directory. A glob can name any of them, so all of
 * them are candidates.
 */
function migratedFamilyFiles(): string[] {
  const files: string[] = []
  for (const familyRoot of migratedFamilyRoots.values()) {
    for (const extension of [
      '.ts',
      '.tsx',
      '.mts',
      '.cts',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
    ]) {
      const entry = `${familyRoot}${extension}`
      if (!existsSync(entry)) continue
      files.push(entry)
      break
    }
    files.push(...filesUnder(familyRoot))
  }
  return files
}

/**
 * The entry file of the retained `src/struct` barrel.
 *
 * The barrel re-exports the migrated families, so a glob that reaches the
 * barrel reaches the local migrated authority as well. The barrel is
 * therefore a candidate of its own: a glob that names no family file but
 * names the barrel still loads the migrated families.
 */
function retainedBarrelFiles(): string[] {
  const files: string[] = []
  for (const extension of [
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
  ]) {
    const entry = `${portableRoot.pathname}index${extension}`
    if (!existsSync(entry)) continue
    files.push(entry)
    break
  }
  return files
}

/**
 * Every file under a directory, recursively. A directory that cannot be read
 * contributes nothing.
 */
function filesUnder(directory: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) files.push(...filesUnder(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

/**
 * The specifiers a set of glob patterns can load from a migrated family,
 * relative to the importing module. A pattern that names no migrated family
 * contributes nothing, and a negated pattern removes the modules it
 * excludes.
 *
 * The retained barrel is a candidate as well: it re-exports the migrated
 * families, so a pattern that names only the barrel still loads them.
 *
 * A glob that names a literal `base` resolves its relative patterns from
 * that base, the way Vite resolves them, so the pattern is matched from the
 * base directory instead of the directory of the importing module.
 */
function globFamilySpecifiers(
  patterns: string[],
  file: URL,
  base: GlobBase,
  caseSensitive: boolean,
): string[] {
  const included = patterns.filter((pattern) => !pattern.startsWith('!'))
  const excluded = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => pattern.slice(1))
  if (included.length === 0) return []
  const importerDirectory = dirname(file.pathname)
  // A relative pattern is resolved from the base the glob call names, and
  // from the directory of the importing module when it names none.
  const resolutionDirectory =
    base.kind === 'literal'
      ? globBaseDirectory(base.base, importerDirectory)
      : importerDirectory
  const includedPatterns = included.map((pattern) =>
    normalizeGlobPattern(pattern, resolutionDirectory),
  )
  const excludedPatterns = excluded.map((pattern) =>
    normalizeGlobPattern(pattern, resolutionDirectory),
  )
  const specifiers: string[] = []
  for (const familyFile of [
    ...migratedFamilyFiles(),
    ...retainedBarrelFiles(),
  ]) {
    // A pattern is matched in its project-root-relative form, because that
    // is the form a project-root or alias pattern resolves to.
    const modulePath = relative(projectRootPath, familyFile)
    if (!globMatchesAny(includedPatterns, modulePath, caseSensitive)) continue
    if (globMatchesAny(excludedPatterns, modulePath, caseSensitive)) continue
    // The reported specifier keeps the importer-relative spelling, so it
    // names the module the way the importing module reaches it.
    const importerPath = relative(importerDirectory, familyFile)
    specifiers.push(
      importerPath.startsWith('.') ? importerPath : `./${importerPath}`,
    )
  }
  return specifiers
}

/**
 * The project-root-relative form of a glob pattern.
 *
 * Vite resolves a glob pattern the way it resolves an import specifier: a
 * pattern that starts with `/` is relative to the project root, an alias
 * pattern is resolved through the alias, and every other pattern is relative
 * to the directory the pattern is resolved from - the base the glob call
 * names, or the directory of the importing module when it names none. The
 * guard normalises the pattern before it matches, so a project-root or alias
 * pattern reaches the family it names instead of matching nothing.
 */
function normalizeGlobPattern(
  pattern: string,
  resolutionDirectory: string,
): string {
  const aliased = aliasGlobTarget(pattern)
  if (aliased !== null) return aliased
  return relative(projectRootPath, resolve(resolutionDirectory, pattern))
}

/**
 * The project-root-relative target of an alias glob pattern, or null when the
 * pattern is not an alias pattern. A configured alias prefix and the alias
 * forms this repository uses are recognised, and the pattern keeps its glob
 * characters.
 */
function aliasGlobTarget(pattern: string): string | null {
  for (const [aliasPattern, targets] of Object.entries(tsconfigPaths)) {
    if (aliasPattern.endsWith('/*')) {
      const prefix = aliasPattern.slice(0, -1)
      if (!pattern.startsWith(prefix)) continue
      const rest = pattern.slice(prefix.length)
      const target = targets[0] ?? ''
      const resolved = target.endsWith('/*')
        ? `${target.slice(0, -1)}${rest}`
        : target
      return relative(
        projectRootPath,
        resolve(tsconfigBaseUrlDirectory, resolved),
      )
    }
    if (pattern === aliasPattern) {
      const target = targets[0]
      if (!target) continue
      return relative(projectRootPath, resolve(tsconfigBaseUrlDirectory, target))
    }
  }
  if (pattern.startsWith('@/')) {
    return relative(
      projectRootPath,
      resolve(projectRootPath, `src/${pattern.slice(2)}`),
    )
  }
  if (pattern.startsWith('~/')) {
    return relative(
      projectRootPath,
      resolve(projectRootPath, `src/${pattern.slice(2)}`),
    )
  }
  if (pattern.startsWith('src/')) {
    return relative(projectRootPath, resolve(projectRootPath, pattern))
  }
  if (pattern.startsWith('/')) {
    return relative(projectRootPath, resolve(projectRootPath, `.${pattern}`))
  }
  return null
}

/**
 * Whether a module path matches one of the glob patterns.
 *
 * The pattern is matched with picomatch, the matcher Vite matches a glob
 * import with, so every pattern form the bundler understands is understood
 * here: a character class (`types.[t]s`), a brace alternation
 * (`types.{ts,tsx}`) and a negated class (`types.[!x]s`) name the modules
 * they name in the bundler, and they name them here too.
 *
 * The pattern and the module path are both in the project-root-relative form
 * the pattern was normalised into, so a project-root pattern, an alias
 * pattern and an importer-relative pattern all match the module they name.
 */
function globMatchesAny(
  patterns: string[],
  modulePath: string,
  caseSensitive: boolean,
): boolean {
  const spellings = globPathSpellings(modulePath)
  return patterns.some((pattern) => {
    const options: {
      dot: boolean
      nocase: boolean
      noextglob: boolean
      noglobstar: boolean
      posix: boolean
    } = {
      dot: false,
      nocase: !caseSensitive,
      noextglob: true,
      noglobstar: false,
      posix: true,
    }
    const matches = picomatch(pattern, options)
    return spellings.some((spelling) => matches(spelling))
  })
}

/**
 * The spellings of a module path a Vite glob pattern can name. A module path
 * that leaves the directory of the importing module keeps its '../'
 * form, and a module path below that directory is named both bare and with
 * the './' prefix that Vite's own resolution uses. The './'-prefixed
 * spelling of a path that leaves the importer's directory would name a
 * different module, so it is not a candidate.
 */
function globPathSpellings(modulePath: string): string[] {
  return modulePath.startsWith('.')
    ? [modulePath]
    : [modulePath, `./${modulePath}`]
}

/**
 * The source the guard parses for a module. An Astro file contributes its
 * frontmatter, the bodies of its script elements, its processed local script
 * sources and the JavaScript of its template expressions, all of them taken
 * from the compiler AST. An MDX file contributes the ESM flow blocks MDX
 * allows at the top level of the document and the JavaScript of every
 * expression MDX evaluates, so a fenced code sample that merely shows an
 * import is not mistaken for a module specifier.
 *
 * An Astro file also contributes its processed local script sources: Astro
 * bundles a local `src` of a script element as a script entry, so that file
 * is an import the guard has to inspect.
 *
 * Astro executes the JavaScript in a template expression too, so an import
 * inside an expression reaches the module graph as well.
 */
function scanSource(source: string, file: URL): string {
  if (file.pathname.endsWith('.astro')) {
    const document = analyzeAstroSource(source)
    const scriptSources = document.scriptSources.map(
      (scriptSource) => `import ${JSON.stringify(scriptSource)}`,
    )
    return [
      document.frontmatter,
      ...document.scriptBodies,
      ...scriptSources,
      ...document.expressions,
    ].join('\n')
  }
  if (file.pathname.endsWith('.mdx')) {
    const esm = mdxEsmStatements(source)
    const expressions = mdxExpressions(source, file)
    return [esm, ...expressions].join(';\n')
  }
  return source
}

/**
 * The parts of an Astro component the guard scans.
 */
type AstroAnalysis = {
  /** The frontmatter of the component. */
  frontmatter: string
  /** The body of every script element of the component. */
  scriptBodies: string[]
  /** The local script sources the component processes. */
  scriptSources: string[]
  /** The JavaScript of every template expression. */
  expressions: string[]
}

/**
 * The parts of an Astro component the guard scans.
 *
 * Every part comes from the compiler AST, so only what Astro really executes
 * is scanned. A script element is a script element: its text child is the
 * JavaScript Astro runs. Astro hoists and executes a script element wherever
 * the element stands, so a script element inside a `<pre>` or a `<code>`
 * sample is hoisted out of the sample exactly like a top-level script and is
 * executed too: the compiler renders `<pre></pre>` and hoists the script, so
 * the guard scans that body as well. An HTML comment is a comment and a
 * frontmatter string is a string, so neither of them is a script element and
 * neither of them contributes a script body.
 *
 * The compiler is the authority on what a component contains. When it cannot
 * parse a real component, the guard fails closed instead of quietly leaving
 * the component unscanned.
 */
function analyzeAstroSource(source: string): AstroAnalysis {
  const { ast, diagnostics } = parseAstroSource(source, { position: true })
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 1)
  if (errors.length > 0) {
    throw new Error(
      `Astro component could not be parsed: ${errors
        .map((diagnostic) => diagnostic.text)
        .join('; ')}`,
    )
  }
  const analysis: AstroAnalysis = {
    frontmatter: '',
    scriptBodies: [],
    scriptSources: [],
    expressions: [],
  }
  const collectAttribute = (attribute: AstroAttributeNode): void => {
    if (
      attribute.kind === 'expression' ||
      attribute.kind === 'template-literal'
    ) {
      if (attribute.value.length > 0) analysis.expressions.push(attribute.value)
    } else if (attribute.kind === 'spread') {
      // The spread form keeps the expression in `name`.
      if (attribute.name.length > 0) analysis.expressions.push(attribute.name)
    }
  }
  const visit = (node: AstroNode): void => {
    if (node.type === 'frontmatter') {
      // The frontmatter is the module code of the component, so it is
      // scanned as TypeScript. It is not a script element.
      analysis.frontmatter = node.value
      return
    }
    if (node.type === 'expression') {
      // The compiler keeps each JavaScript fragment of the expression in a
      // text child; a nested element inside the expression is JavaScript
      // only through its own attributes and expressions.
      for (const child of node.children) {
        if (child.type === 'text' && child.value.length > 0) {
          analysis.expressions.push(child.value)
        }
      }
    }
    if ('attributes' in node) {
      for (const attribute of node.attributes) collectAttribute(attribute)
    }
    if (node.type === 'element' && node.name === 'script') {
      // The text child of a script element is the JavaScript the element
      // carries. The element is scanned wherever the compiler AST puts it:
      // Astro hoists and executes a script element inside a `<pre>` or a
      // `<code>` sample as well, so such a body is JavaScript the component
      // runs and not a sample of a script. A script element whose type is
      // not a JavaScript type is a data block, which nobody executes, so its
      // body is not JavaScript the component runs and is not scanned.
      if (isJavaScriptScript(node.attributes)) {
        for (const child of node.children) {
          if (child.type === 'text' && child.value.length > 0) {
            analysis.scriptBodies.push(child.value)
          }
        }
      }
      if (isProcessedScript(node.attributes)) {
        const scriptSource = scriptSourceOf(node.attributes)
        if (scriptSource !== null) analysis.scriptSources.push(scriptSource)
      }
    }
    if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }
  visit(ast)
  return analysis
}

/**
 * The plain value of an attribute, or null when the attribute carries no
 * plain value. An expression-valued attribute carries JavaScript, so it is
 * not a literal the guard can resolve.
 */
function plainAttributeValue(attribute: AstroAttributeNode): string | null {
  if (attribute.kind === 'quoted' || attribute.kind === 'empty') {
    return attribute.value
  }
  return null
}

/**
 * Whether a script element carries JavaScript that is executed.
 *
 * A script element without a `type` is a classic script, and a script whose
 * type is `module`, `text/javascript` or `application/javascript` is a
 * module or a classic script, so the browser executes the body in every one
 * of those cases. A script whose type is anything else - `text/plain`,
 * `application/json`, `text/x-component` - is a data block: the HTML
 * standard does not execute it, Astro does not bundle it and the body is
 * never run, so it is not a module the component loads.
 *
 * A `type` that is not a literal - `type={someType}` - cannot be read, so
 * the guard cannot prove that the body is not JavaScript and scans it.
 */
function isJavaScriptScript(attributes: AstroAttributeNode[]): boolean {
  const type = attributes.find((attribute) => attribute.name === 'type')
  if (!type) return true
  const value = plainAttributeValue(type)
  if (value === null) return true
  return ['module', 'text/javascript', 'application/javascript'].includes(
    value.toLowerCase(),
  )
}

/**
 * Whether Astro processes a script element. An inline script is not
 * processed, and a script whose type is not JavaScript is not executed as
 * JavaScript at all, so neither of them names a module Astro bundles.
 */
function isProcessedScript(attributes: AstroAttributeNode[]): boolean {
  if (attributes.some((attribute) => attribute.name === 'is:inline')) {
    return false
  }
  return isJavaScriptScript(attributes)
}

/**
 * The local script source of a script element, or null when the element names
 * no local module. Astro processes a relative `src` of a script element as a
 * script entry and bundles that file, so the source is a module specifier. A
 * `src` that names a public asset or an external URL is not processed, so it
 * contributes nothing.
 */
function scriptSourceOf(attributes: AstroAttributeNode[]): string | null {
  const src = attributes.find((attribute) => attribute.name === 'src')
  if (!src) return null
  const value = plainAttributeValue(src)
  if (value === null) return null
  if (!value.startsWith('./') && !value.startsWith('../')) return null
  return value
}

/** The net change in curly-brace depth of one line. */
function mdxBraceDelta(line: string): number {
  let delta = 0
  for (const character of line) {
    if (character === '{') delta += 1
    else if (character === '}') delta -= 1
  }
  return delta
}

/**
 * Whether a line can begin a top-level ESM statement. MDX allows `import` and
 * `export` statements at the top level of a document, wherever they appear,
 * so such a line starts a candidate ESM block.
 */
function mdxStartsEsmStatement(line: string): boolean {
  return /^(?:import|export)\b/.test(line)
}

/**
 * The opening or closing fence of a markdown code block. A closing fence
 * carries no info string, so it is recognised separately from an opening
 * one.
 */
function mdxFenceMarker(
  line: string,
): { marker: string; closing: boolean } | null {
  const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match) return null
  return { marker: match[1]!, closing: match[2]!.trim() === '' }
}

/**
 * Whether a candidate statement names a module. The candidate is parsed as
 * TypeScript, so markdown prose that happens to begin with `import` or
 * `export` is not mistaken for an ESM statement.
 */
function mdxStatementNamesAModule(statement: string): boolean {
  const file = ts.createSourceFile(
    'mdx-esm.ts',
    statement,
    ts.ScriptTarget.Latest,
    true,
  )
  return file.statements.some(
    (node) =>
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier),
  )
}

/**
 * Whether a candidate statement is a finished declaration.
 *
 * The TypeScript parser is the authority on that question: a candidate the
 * parser accepts as a complete declaration is finished, whatever its text
 * contains. A count of the brace characters does not decide it: a brace
 * inside a string or inside a comment is not a block, so a declaration that
 * carries one is finished all the same, and a candidate the parser has not
 * accepted yet can still be completed by more input.
 */
function mdxStatementIsComplete(statement: string): boolean {
  return (
    mdxStatementNamesAModule(statement) || mdxStatementIsDeclaration(statement)
  )
}

/**
 * The complaints the TypeScript parser has about a candidate statement. A
 * statement the parser accepts without a complaint is a finished
 * declaration.
 */
function mdxStatementDiagnostics(statement: string): readonly ts.Diagnostic[] {
  return (
    ts.transpileModule(statement, {
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.Latest,
        module: ts.ModuleKind.ESNext,
      },
    }).diagnostics ?? []
  )
}

/**
 * Whether a candidate statement is a declaration the parser accepts. A
 * declaration that names no module is a declaration all the same, so it is
 * preserved for the AST scan: a module-free declaration can still load a
 * module, as `export const x = require('./types')` does.
 *
 * Prose that happens to begin with `import` or `export` is not a
 * declaration, so it is not preserved.
 */
function mdxStatementIsDeclaration(statement: string): boolean {
  const file = ts.createSourceFile(
    'mdx-esm.ts',
    statement,
    ts.ScriptTarget.Latest,
    true,
  )
  if (file.statements.length === 0) return false
  return mdxStatementDiagnostics(statement).length === 0
}

/**
 * The ESM flow blocks of an MDX document.
 *
 * MDX recognises an import or export statement anywhere at the top level of
 * a document, not only in a leading prelude, so an import that follows
 * markdown content is a real module specifier and is collected here. A
 * fenced code sample and an indented code sample are markdown content
 * instead, so both are excluded: a code sample that shows an import must
 * never be collected as a module specifier.
 *
 * A statement is read until the parser recognises a complete declaration, so
 * a declaration that spans several lines is collected as one block. The
 * parser decides that a statement is finished, because a count of the brace
 * characters does not: a brace inside a string or inside a comment is not a
 * block, and a declaration that carries one is finished all the same. A
 * prose line that begins with `import` is dropped unless the TypeScript
 * parser reads it as an ESM statement.
 *
 * Every declaration the parser accepts is collected, not only the ones that
 * name a module: a declaration that names no module is still a declaration
 * of the document, and it can load a module of its own.
 */
function mdxEsmStatements(source: string): string {
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const kept: string[] = []
  let fence: string | null = null
  let depth = 0
  let block: string[] = []
  const flush = () => {
    const statement = block.join('\n')
    block = []
    depth = 0
    if (mdxStatementIsComplete(statement)) kept.push(statement)
  }
  for (const line of body.split('\n')) {
    if (depth > 0) {
      // The line continues the ESM statement that is already open.
      block.push(line)
      depth += mdxBraceDelta(line)
      if (mdxStatementIsComplete(block.join('\n'))) flush()
      continue
    }
    const fenceLine = mdxFenceMarker(line)
    if (fence !== null) {
      if (
        fenceLine &&
        fenceLine.closing &&
        fenceLine.marker[0] === fence[0] &&
        fenceLine.marker.length >= fence.length
      )
        fence = null
      continue
    }
    if (fenceLine) {
      // A code block ends an open statement: the statement never completed.
      if (block.length > 0) flush()
      fence = fenceLine.marker
      continue
    }
    // An indented code sample is markdown content, not a module specifier.
    if (/^(?: {4}|\t)/.test(line)) {
      if (block.length > 0) flush()
      continue
    }
    if (block.length > 0) {
      // The open statement is not a complete declaration yet, so this line
      // can still complete it.
      block.push(line)
      if (mdxStatementIsComplete(block.join('\n'))) flush()
      continue
    }
    const trimmed = line.trim()
    if (!mdxStartsEsmStatement(trimmed)) continue
    block = [line]
    depth = mdxBraceDelta(line)
    if (mdxStatementIsComplete(line)) flush()
  }
  if (block.length > 0) flush()
  return kept.join('\n')
}

/**
 * The MDX processor of the guard. The processor is the real MDX toolchain of
 * the repository, so the tree it produces is the tree MDX itself works on.
 */
const mdxProcessor = unified().use(remarkParse).use(remarkMdx)

/**
 * The shape of the MDX tree the guard walks. The guard reads the type and
 * the value of a node only, so the tree is described in those terms.
 */
type MdxNode = {
  /** The type of the node. */
  type: string
  /** The source of a node that carries one. */
  value?: string
  /** The children of a node that has them. */
  children?: MdxNode[]
  /** The JSX attributes of a node that has them. */
  attributes?: MdxAttribute[]
}

/**
 * The value of an MDX JSX attribute. A named attribute carries either its
 * plain text or an object that carries the JavaScript of an expression.
 */
type MdxAttributeValue = {
  /** The type of the value, when the value carries one. */
  type?: string
  /** The JavaScript of an expression-valued attribute. */
  value?: string
}

/**
 * The shape of an MDX JSX attribute the guard walks. The guard reads the type
 * and the value of an attribute only, so the attribute is described in those
 * terms.
 */
type MdxAttribute = {
  /** The type of the attribute node. */
  type: string
  /**
   * The value of the attribute: the JavaScript of a spread attribute, or the
   * plain text or the expression of a named attribute.
   */
  value?: string | MdxAttributeValue | null
}

/**
 * The JavaScript of every executable expression of an MDX document.
 *
 * MDX evaluates an expression such as `{import('../struct/ids')}` while it
 * renders the document, so the expression reaches the module graph and the
 * guard has to inspect it. MDX evaluates the expression of a JSX attribute
 * value as well, so `bar={import('../struct/ids')}` is collected too, and so
 * is the spread form `{...import('../struct/ids')}`. The processor is the real
 * MDX toolchain, so the expressions are the ones MDX evaluates: a fenced code
 * block, an indented code sample, inline code and an HTML comment are
 * markdown content, so an import that appears only in their text contributes
 * nothing.
 *
 * The ESM flow blocks of the document are not collected here. The line
 * scanner above reads them, and it recognises the declarations MDX allows
 * at the top level of a document while tolerating prose that merely begins
 * with `import` or `export`, which the MDX parser refuses outright.
 *
 * When the MDX parser refuses a document, the guard fails loudly for a
 * document of the repository: such a document is production content, and the
 * guard cannot prove that it holds no executable expression. A document that
 * is not a file of the repository is a probe of the guard itself, and the
 * line scanner still reads what it can there.
 */
function mdxExpressions(source: string, file: URL): string[] {
  let tree: MdxNode
  try {
    tree = mdxProcessor.parse(source) as unknown as MdxNode
  } catch (error) {
    if (isRepositoryDocument(file)) {
      throw new Error(
        `MDX document could not be parsed: ${file.pathname}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    return []
  }
  const expressions: string[] = []
  const collectAttribute = (attribute: MdxAttribute): void => {
    if (attribute.type === 'mdxJsxExpressionAttribute') {
      // The spread form keeps the expression in `value`. The spread marker
      // is not part of the expression, so it is removed before the
      // expression is scanned.
      if (typeof attribute.value === 'string') {
        const expression = attribute.value.replace(/^\.\.\./, '')
        if (expression.length > 0) expressions.push(expression)
      }
      return
    }
    if (attribute.type === 'mdxJsxAttribute') {
      // A named attribute carries either plain text or an expression. MDX
      // evaluates an expression-valued attribute, so its JavaScript is
      // collected; plain text is a string the component renders, so it is
      // not.
      const value = attribute.value
      if (
        value !== null &&
        typeof value === 'object' &&
        value.type === 'mdxJsxAttributeValueExpression' &&
        typeof value.value === 'string' &&
        value.value.length > 0
      ) {
        expressions.push(value.value)
      }
    }
  }
  const visit = (node: MdxNode): void => {
    if (
      node.type === 'mdxFlowExpression' ||
      node.type === 'mdxTextExpression'
    ) {
      if (node.value && node.value.length > 0) expressions.push(node.value)
    }
    // The attributes of a JSX element are not children of the element, so
    // they are visited here: an expression-valued attribute is JavaScript
    // MDX evaluates.
    for (const attribute of node.attributes ?? []) collectAttribute(attribute)
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  return expressions
}

/**
 * Whether a scanned document is a document of the repository. A document that
 * exists on disk is production content, so a parser that refuses it is a
 * failure the guard has to report. A document that does not exist is a probe
 * of the guard itself.
 */
function isRepositoryDocument(file: URL): boolean {
  return existsSync(file.pathname)
}

/** The string literals inside a node, used for a computed dynamic import. */
function stringLiteralsIn(node: ts.Node | undefined): string[] {
  if (!node) return []
  const found: string[] = []
  function visit(current: ts.Node): void {
    if (ts.isStringLiteralLike(current)) found.push(current.text)
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

/**
 * The static text of an expression: the part a reader sees before any
 * runtime value is substituted. A dynamic part is written as `${}`, so a
 * computed require can be told apart from one that only names a package
 * manifest.
 */
function staticTextIn(node: ts.Node | undefined): string {
  if (!node) return ''
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text
    for (const span of node.templateSpans) text += `\${}${span.literal.text}`
    return text
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return staticTextIn(node.left) + staticTextIn(node.right)
  }
  return '${}'
}

function boundaryViolations(
  source: string,
  file: URL,
  publicPaths: Set<string>,
  specifiers?: string[],
): string[] {
  const portable = file.pathname.startsWith(portableRoot.pathname)
  return (specifiers ?? importedPaths(source, file)).filter((specifier) => {
    if (specifier === '<nonliteral dynamic import>')
      return portable || file.pathname.startsWith(adapterRoot.pathname)
    if (specifier === NONLITERAL_REQUIRE)
      return portable || file.pathname.startsWith(adapterRoot.pathname)
    if (specifier === NONLITERAL_GLOB)
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
          /\.(?:[cm]?[jt]sx?|astro|mdx)$/.test(entry.name) &&
          !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name),
      )
      .map((entry) => new URL(entry.name, directory)),
  ]
}

/**
 * The analysis of one portable file of the repository: the file, its source
 * and the imports it names.
 */
type RepositoryFileAnalysis = {
  /** The file itself. */
  file: URL
  /** The source of the file. */
  source: string
  /** The imports the file names. */
  imports: ParsedImports
}

/**
 * The analysis of every portable file of the repository.
 *
 * The whole-repository guard cases need the same walk of the repository, the
 * same sources and the same parse of every file, so the analysis is built
 * once, lazily, and shared: the second case reuses the work of the first
 * instead of repeating it.
 */
let repositoryAnalysis: Promise<RepositoryFileAnalysis[]> | null = null

function repositoryAnalysisOnce(): Promise<RepositoryFileAnalysis[]> {
  repositoryAnalysis ??= (async () => {
    const files = await portableFiles(root)
    return Promise.all(
      files.map(async (file) => {
        const source = await readFile(file, 'utf8')
        return { file, source, imports: parseImports(source, file) }
      }),
    )
  })()
  return repositoryAnalysis
}

/**
 * The migrated family a resolved local path belongs to, or null. The family
 * root and every nested module under it are the same family, so
 * `src/struct/codec/parsers` is a `codec` import just like `src/struct/codec`.
 */
function migratedFamilyForTarget(target: string): string | null {
  // Strip file extension case-insensitively (the guard normalizes extensions),
  // then lowercase for case-insensitive comparison when the glob uses
  // caseSensitive: false.
  const stripped = target.replace(/\.([cm]?[jt]sx?|astro|mdx)$/i, '').toLowerCase()
  for (const [family, familyRoot] of migratedFamilyRoots) {
    const lowerFamilyRoot = familyRoot.toLowerCase()
    if (stripped === lowerFamilyRoot || stripped.startsWith(lowerFamilyRoot + "/"))
      return family
  }
  return null
}

function isMigratedFamilyTarget(target: string): boolean {
  return migratedFamilyForTarget(target) !== null
}

/**
 * Whether a path is inside the retained `src/struct` tree. The tree keeps
 * its own legacy callers, so a re-export inside it stays exempt; a module
 * outside it must not reach a migrated family through a retained-tree
 * wrapper.
 */
function isRetainedTreePath(path: string): boolean {
  return path.startsWith(portableRoot.pathname)
}

/**
 * A local module the guard resolved: the file that backs the path and the
 * source of that file.
 */
type LocalModule = {
  /** The file that backs the module. */
  path: string
  /** The source of the file. */
  source: string
}

/**
 * A local module a specifier names: the path of the module and the exact
 * file the specifier names, when it names one with an extension.
 *
 * The path carries no extension, so every spelling of the same module names
 * the same path. The exact file is the file a specifier names with an
 * explicit extension: `../struct/legacy.js` names the `legacy.js` wrapper,
 * not a `legacy.ts` wrapper of the same basename.
 */
type LocalTarget = {
  /** The path of the module, with the extension removed. */
  path: string
  /** The exact file the specifier names, or null when it names none. */
  exact: string | null
}

/**
 * The local module a target names, or null when no file backs the target.
 *
 * The path a specifier resolves to carries no extension, so the file names
 * the module can have are tried in turn. A specifier that names a file with
 * an explicit extension names that file, so the exact path is tried first.
 *
 * Every extension the scanner accepts is probed, so a retained wrapper
 * stored as a CommonJS TypeScript module (`.cts`) or as a CommonJS module
 * (`.cjs`) is found as well, together with the index variants of those
 * extensions.
 */
function readLocalModule(target: LocalTarget): LocalModule | null {
  const key = localTargetKey(target)
  const cached = localModuleCache.get(key)
  if (cached !== undefined) return cached
  let module: LocalModule | null = null
  for (const candidate of localModuleCandidates(target)) {
    if (!existsSync(candidate)) continue
    try {
      const text = readFileSync(candidate, 'utf8')
      module = {
        path: candidate,
        source:
          candidate.endsWith('.astro') || candidate.endsWith('.mdx')
            ? scanSource(text, new URL(`file://${candidate}`))
            : text,
      }
      break
    } catch {
      continue
    }
  }
  localModuleCache.set(key, module)
  return module
}

/**
 * The file names a local module path can have. The extension list is the one
 * the scanner accepts, and every extension also has an index variant.
 *
 * A specifier that names a file with an explicit extension names that file,
 * so the exact path is probed first: two wrappers that share a basename are
 * told apart by the extension the specifier uses. The extensionless
 * candidates follow, so a specifier that names no existing file is still
 * resolved the way it was before.
 */
function localModuleCandidates(target: LocalTarget): string[] {
  const candidates = [
    ...localModuleExtensions.map((extension) => `${target.path}${extension}`),
    ...localModuleExtensions.map(
      (extension) => `${target.path}/index${extension}`,
    ),
  ]
  if (target.exact === null) return candidates
  return [
    target.exact,
    ...candidates.filter((candidate) => candidate !== target.exact),
  ]
}

/**
 * The key a local module is cached under. The exact file is part of the key,
 * because the same path with a different exact file can name a different
 * module.
 */
function localTargetKey(target: LocalTarget): string {
  return target.exact === null ? target.path : `${target.path}\n${target.exact}`
}

/**
 * A local target without the trailing slashes a directory spelling carries.
 */
function normalizeLocalTarget(target: LocalTarget): LocalTarget {
  return {
    path: target.path.replace(/\/+$/, ''),
    exact: target.exact === null ? null : target.exact.replace(/\/+$/, ''),
  }
}

/**
 * The extensions a local module can have. The list is the one the scanner
 * accepts, so a module the scanner would read is a module the guard can
 * resolve.
 */
const localModuleExtensions = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.astro',
  '.mdx',
]

/**
 * Every local module the guard already resolved, so a module that is
 * reached by more than one import is read once.
 */
const localModuleCache = new Map<string, LocalModule | null>()

/**
 * Every module the guard already parsed for its re-exports, so a module that
 * is reached by more than one import is parsed once.
 *
 * The re-export specifiers of a module depend on the source of the module
 * alone, so the parse is a pure function of that source and the result can
 * be reused.
 */
const reexportSpecifierCache = new Map<string, ReexportSpecifiers>()

/**
 * The module specifiers a module re-exports. A retained-tree wrapper that
 * re-exports a migrated family is the way an external importer reaches the
 * local migrated authority, so the re-export targets are what the guard
 * follows.
 *
 * The ordinary two-step form counts as a re-export: a module that imports a
 * binding and then exports that binding re-exports the module the binding
 * came from, so the guard follows it as well. An export declaration that
 * aliases an imported binding counts as well, whether it aliases the binding
 * in a named export, in an exported variable or in a default export.
 *
 * An exported expression that uses an imported binding counts as well: an
 * exported arrow function, an exported function declaration, an exported
 * call, an exported object literal or an exported default expression that
 * references a binding the module imported reaches the module that binding
 * came from, so the guard follows it as well.
 *
 * The ordinary CommonJS form counts as a re-export too: a wrapper that
 * assigns a required module to `module.exports` re-exports that module, so
 * the guard follows it as well.
 *
 * The two lists are kept apart, because they answer different questions. A
 * re-export names a module the module hands out itself, and the recovery
 * chain follows it. A reach names a module an exported expression uses, and
 * the migrated-family chain follows it only when it is the authority of a
 * migrated family.
 */
function reexportSpecifiers(source: string): ReexportSpecifiers {
  const cached = reexportSpecifierCache.get(source)
  if (cached !== undefined) {
    return { reexports: [...cached.reexports], reaches: [...cached.reaches] }
  }
  const specifiers = computeReexportSpecifiers(source)
  reexportSpecifierCache.set(source, specifiers)
  return { reexports: [...specifiers.reexports], reaches: [...specifiers.reaches] }
}

/**
 * The modules a module names itself and the modules its exported expressions
 * use.
 */
type ReexportSpecifiers = {
  /** The modules the module re-exports. */
  reexports: string[]
  /** The modules the exported expressions of the module reach. */
  reaches: string[]
}

function computeReexportSpecifiers(source: string): ReexportSpecifiers {
  const file = ts.createSourceFile(
    'module.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const reexports: string[] = []
  const reaches: string[] = []
  const importedBindings = importedBindingModules(file)
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      continue
    }
    if (ts.isImportEqualsDeclaration(statement)) {
      // `export import Types = require('./types')` re-exports the required
      // module.
      if (!hasExportModifier(statement)) continue
      const required = importAliasModule(statement.moduleReference)
      if (required !== null) reexports.push(required)
      continue
    }
    if (ts.isExpressionStatement(statement)) {
      // A CommonJS re-export: `module.exports = require('./types')`.
      const required = commonJsReexportSpecifier(
        statement.expression,
        importedBindings,
      )
      if (required !== null) reexports.push(required)
      continue
    }
    if (ts.isVariableStatement(statement)) {
      // `export const id = structId` re-exports the module the imported
      // binding came from.
      if (!hasExportModifier(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer
        if (!initializer) continue
        if (ts.isIdentifier(initializer)) {
          const imported = importedBindings.get(initializer.text)
          if (imported !== undefined) reexports.push(imported)
          continue
        }
        // An exported expression that uses an imported binding reaches the
        // module the binding came from:
        // `export const legacyId = (value) => structId('legacy', value)`.
        reaches.push(
          ...exportedExpressionModules(
            initializer,
            importedBindings,
            declaration.name,
          ),
        )
      }
      continue
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      // `export type Foo = ImportedType` re-exports the module the imported
      // type binding came from, and any other reference to an imported type
      // binding in the alias reaches that module as well.
      if (!hasExportModifier(statement)) continue
      const typeNode = statement.type
      if (
        ts.isTypeReferenceNode(typeNode) &&
        ts.isIdentifier(typeNode.typeName)
      ) {
        const imported = importedBindings.get(typeNode.typeName.text)
        if (imported !== undefined) {
          reexports.push(imported)
          continue
        }
      }
      reaches.push(
        ...exportedTypeModules(typeNode, importedBindings, statement.name),
      )
      continue
    }
    if (ts.isInterfaceDeclaration(statement)) {
      // `export interface Foo extends ImportedType` (and any member that
      // names an imported type binding) reaches the module that binding came
      // from, so the guard follows it as well.
      if (!hasExportModifier(statement)) continue
      reaches.push(
        ...exportedTypeModules(statement, importedBindings, statement.name),
      )
      continue
    }
    if (ts.isFunctionDeclaration(statement)) {
      // `export function legacyId(value) { return structId('legacy', value) }`
      // reaches the module the imported binding came from as well.
      if (!hasExportModifier(statement)) continue
      const body = statement.body
      if (!body) continue
      reaches.push(
        ...exportedExpressionModules(body, importedBindings, statement.name),
      )
      continue
    }
    if (ts.isClassDeclaration(statement)) {
      // `export class Legacy extends Base` reaches the module the imported
      // binding came from as well.
      if (!hasExportModifier(statement)) continue
      for (const clause of statement.heritageClauses ?? []) {
        for (const heritage of clause.types) {
          const expression = heritage.expression
          if (!expression) continue
          reaches.push(
            ...exportedExpressionModules(
              expression,
              importedBindings,
              statement.name,
            ),
          )
        }
      }
      // A member of an exported class is part of what the class hands out,
      // so a member that uses an imported binding reaches the module the
      // binding came from as well.
      for (const member of statement.members) {
        reaches.push(
          ...classMemberModules(member, importedBindings, statement.name),
        )
      }
      continue
    }
    if (ts.isEnumDeclaration(statement)) {
      // `export enum Legacy { IdLength = structId('legacy', 'x').length }`
      // reaches the module the imported binding came from as well.
      if (!hasExportModifier(statement)) continue
      for (const member of statement.members) {
        if (member.initializer) {
          reaches.push(
            ...exportedExpressionModules(
              member.initializer,
              importedBindings,
              statement.name,
            ),
          )
        }
        // A computed member name is evaluated when the enum is defined, so
        // the expression of the name is walked like every other expression of
        // the enum.
        reaches.push(
          ...computedPropertyModules(
            member.name,
            importedBindings,
            statement.name,
          ),
        )
      }
      continue
    }
    if (ts.isExportAssignment(statement)) {
      const expression = statement.expression
      if (ts.isIdentifier(expression)) {
        // `export default structId` re-exports the module the imported binding
        // came from.
        const imported = importedBindings.get(expression.text)
        if (imported !== undefined) reexports.push(imported)
        continue
      }
      // `export = require('./types')` re-exports the required module.
      const required = requiredModuleOf(expression)
      if (required !== null) {
        reexports.push(required)
        continue
      }
      // `export default structId('legacy')` reaches the module the imported
      // binding came from.
      reaches.push(
        ...exportedExpressionModules(expression, importedBindings),
      )
      continue
    }
    if (!ts.isExportDeclaration(statement)) continue
    if (statement.moduleSpecifier) {
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        reexports.push(statement.moduleSpecifier.text)
      }
      continue
    }
    // `export { name }` re-exports a local binding, so the module that
    // binding was imported from is re-exported too.
    const exportClause = statement.exportClause
    if (!exportClause || !ts.isNamedExports(exportClause)) continue
    for (const element of exportClause.elements) {
      const local = element.propertyName?.text ?? element.name.text
      const imported = importedBindings.get(local)
      if (imported === undefined) continue
      reexports.push(imported)
    }
  }
  return { reexports, reaches }
}

/**
 * The modules an exported expression reaches through the bindings it
 * references. The walked node is not necessarily an expression: the body
 * of an exported function declaration is walked as well.
 *
 * An exported expression that references a binding the module imported
 * reaches the module that binding came from, so that module is a re-export
 * target. A binding the module defines itself reaches no other module.
 *
 * An exported expression that contains a dynamic import also reaches the
 * module that dynamic import loads, so that module is a re-export target
 * as well.
 */
function exportedExpressionModules(
  node: ts.Node,
  importedBindings: Map<string, string>,
  declared?: ts.BindingName,
): string[] {
  const modules: string[] = []
  for (const name of referencedBindingNames(node, declared)) {
    const imported = importedBindings.get(name)
    if (imported === undefined) continue
    modules.push(imported)
  }
  // Also find dynamic imports in the expression
  modules.push(...dynamicImportSpecifiers(node))
  return modules
}

/**
 * The module specifiers of any dynamic imports in a node.
 */
function dynamicImportSpecifiers(node: ts.Node): string[] {
  const specifiers: string[] = []
  function visit(current: ts.Node): void {
    if (
      ts.isCallExpression(current) &&
      current.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = current.arguments[0]
      if (argument && ts.isStringLiteralLike(argument)) {
        specifiers.push(argument.text)
      }
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return specifiers
}

/**
 * The names a node references. A property name names no binding, a member
 * name names no binding, and a type reference is erased at runtime, so
 * none of them is collected.
 */
function referencedBindingNames(
  node: ts.Node,
  declared?: ts.BindingName,
): Set<string> {
  const names = new Set<string>()
  const declaredNames = new Set<string>()
  if (declared && ts.isIdentifier(declared)) declaredNames.add(declared.text)
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current)) {
      if (!declaredNames.has(current.text)) names.add(current.text)
      return
    }
    if (ts.isTypeNode(current)) return
    if (ts.isPropertyAccessExpression(current)) {
      // `holder.structId` names a property, not a binding.
      visit(current.expression)
      return
    }
    if (ts.isPropertyAssignment(current)) {
      // `{ structId: 1 }` names a property key, not a binding.
      visit(current.initializer)
      return
    }
    const member = declaredMemberName(current)
    if (member !== null) {
      // The name a member declares names no binding, so it is not collected.
      current.forEachChild((child) => {
        if (child !== member) visit(child)
      })
      return
    }
    current.forEachChild(visit)
  }
  visit(node)
  return names
}

/**
 * The modules an exported type alias or interface reaches through the imported
 * type bindings it references. A type reference is not erased here: the
 * boundary guard follows imported type bindings as well as value bindings, so
 * an exported type that names one reaches the module it came from.
 */
function exportedTypeModules(
  node: ts.Node,
  importedBindings: Map<string, string>,
  declared?: ts.BindingName,
): string[] {
  const modules: string[] = []
  for (const name of referencedTypeBindingNames(node, declared)) {
    const imported = importedBindings.get(name)
    if (imported === undefined) continue
    modules.push(imported)
  }
  return modules
}

/**
 * The names a type node references, including the identifiers of type
 * references. A property name, a member name and a declared name name no
 * binding, so none of them is collected.
 */
function referencedTypeBindingNames(
  node: ts.Node,
  declared?: ts.BindingName,
): Set<string> {
  const names = new Set<string>()
  const declaredNames = new Set<string>()
  if (declared && ts.isIdentifier(declared)) declaredNames.add(declared.text)
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current)) {
      if (!declaredNames.has(current.text)) names.add(current.text)
      return
    }
    const member = declaredMemberName(current)
    if (member !== null) {
      current.forEachChild((child) => {
        if (child !== member) visit(child)
      })
      return
    }
    if (ts.isPropertyAccessExpression(current)) {
      visit(current.expression)
      return
    }
    if (ts.isPropertyAssignment(current)) {
      visit(current.initializer)
      return
    }
    current.forEachChild(visit)
  }
  visit(node)
  return names
}

/**
 * The name a declaration declares, or null when the node declares no name.
 * The name of a member is not a reference to a binding, so it is never
 * collected as one.
 */
function declaredMemberName(node: ts.Node): ts.Node | null {
  if (
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertySignature(node) ||
    ts.isEnumMember(node) ||
    ts.isBindingElement(node)
  ) {
    return node.name
  }
  return null
}

/**
 * The module every imported binding of a module came from, keyed by the
 * local name of the binding. A default import, a named import and a
 * namespace import all bind a local name.
 *
 * A require binds a local name as well, so the require-bound aliases are
 * collected here too: `const Types = require('./types')`,
 * `const { structId } = require('./ids')` and the TypeScript import alias
 * `import Types = require('./types')` all bind a local name to a required
 * module. A computed require names no literal module, so it fails closed in
 * the same way a computed dynamic import does.
 *
 * The bindings are collected before the re-exports are read, so an export
 * that aliases an imported binding is recognised whatever order the module
 * declares them in.
 */
function importedBindingModules(
  file: ts.SourceFile,
): Map<string, string> {
  const importedBindings = new Map<string, string>()
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier
      if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) continue
      const clause = statement.importClause
      if (!clause) continue
      if (clause.name) {
        importedBindings.set(clause.name.text, moduleSpecifier.text)
      }
      const namedBindings = clause.namedBindings
      if (!namedBindings) continue
      if (ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          importedBindings.set(element.name.text, moduleSpecifier.text)
        }
      } else {
        importedBindings.set(namedBindings.name.text, moduleSpecifier.text)
      }
      continue
    }
    // A TypeScript import alias binds a local name to a required module:
    // `import Types = require('./types')`.
    if (ts.isImportEqualsDeclaration(statement)) {
      const required = importAliasModule(statement.moduleReference)
      if (required === null) continue
      importedBindings.set(statement.name.text, required)
      continue
    }
    if (!ts.isVariableStatement(statement)) continue
    // A require-bound variable binds a local name to a required module as
    // well: `const Types = require('./types')`.
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer
      if (!initializer) continue
      const required = requiredModuleOf(initializer)
      if (required === null) continue
      for (const name of boundNames(declaration.name)) {
        importedBindings.set(name, required)
      }
    }
  }
  return importedBindings
}

/**
 * The names a binding name binds. A destructuring pattern binds every name
 * it names, so `const { structId } = require('./ids')` binds `structId`.
 */
function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  const names: string[] = []
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue
    names.push(...boundNames(element.name))
  }
  return names
}

/**
 * The module a TypeScript import alias names, the sentinel a computed alias
 * records, or null when the alias names no module.
 *
 * The alias names its module in the module reference itself:
 * `import Types = require('./types')` names `./types`. A computed alias names
 * no literal module, so the guard cannot prove that it does not load a
 * migrated family; it fails closed in the same way a computed require does.
 */
function importAliasModule(
  moduleReference: ts.ModuleReference,
): string | null {
  if (!ts.isExternalModuleReference(moduleReference)) return null
  const expression = moduleReference.expression
  if (ts.isStringLiteralLike(expression)) return expression.text
  return NONLITERAL_REQUIRE
}

/**
 * The modules an exported class member reaches through the bindings it
 * references. A member of an exported class is part of what the class hands
 * out, so a method body, a property initializer, a static block and a
 * computed property name are walked for the bindings they reference. A
 * binding the class defines itself reaches no other module.
 */
function classMemberModules(
  member: ts.ClassElement,
  importedBindings: Map<string, string>,
  declared?: ts.BindingName,
): string[] {
  const modules: string[] = []
  if (
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    if (member.body) {
      modules.push(
        ...exportedExpressionModules(member.body, importedBindings, declared),
      )
    }
    modules.push(
      ...computedPropertyModules(member.name, importedBindings, declared),
    )
    return modules
  }
  if (ts.isPropertyDeclaration(member)) {
    if (member.initializer) {
      modules.push(
        ...exportedExpressionModules(
          member.initializer,
          importedBindings,
          declared,
        ),
      )
    }
    modules.push(
      ...computedPropertyModules(member.name, importedBindings, declared),
    )
    return modules
  }
  if (ts.isClassStaticBlockDeclaration(member)) {
    modules.push(
      ...exportedExpressionModules(member.body, importedBindings, declared),
    )
  }
  return modules
}

/**
 * The modules a computed property name reaches. A computed name is
 * evaluated when the class is defined, so the expression of the name is
 * walked like every other expression of the class.
 */
function computedPropertyModules(
  name: ts.PropertyName | undefined,
  importedBindings: Map<string, string>,
  declared?: ts.BindingName,
): string[] {
  if (!name || !ts.isComputedPropertyName(name)) return []
  return exportedExpressionModules(name.expression, importedBindings, declared)
}

/**
 * The module a CommonJS re-export names, or null when the statement is not a
 * CommonJS re-export. The ordinary form `module.exports = require('./types')`
 * re-exports the required module, and so does `exports.types = require(...)`.
 *
 * A property of an export target is an export target, so the named-export
 * form `module.exports.api = require('./types')` re-exports the required
 * module as well.
 *
 * A re-export can read a member of the required module, so a property access
 * and an element access that is rooted at the required module name it too.
 *
 * The `Object.assign(module.exports, require(...))` form is also a CommonJS
 * re-export: it assigns the required module's exports to `module.exports`.
 */
function commonJsReexportSpecifier(
  expression: ts.Expression,
  importedBindings?: Map<string, string>,
): string | null {
  // Check for direct assignment: `module.exports = require(...)`
  if (ts.isBinaryExpression(expression)) {
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null
    if (!isCommonJsExportTarget(expression.left)) return null
    const required = requiredModuleOf(expression.right, importedBindings)
    if (required !== null) return required
    // A require-bound alias is an imported binding, so assigning it to
    // `module.exports` re-exports the module it came from:
    // `const Types = require('./types'); module.exports = Types`.
    if (ts.isIdentifier(expression.right) && importedBindings) {
      const imported = importedBindings.get(expression.right.text)
      if (imported !== undefined) return imported
    }
    return null
  }
  // Check for Object.assign(module.exports, require(...)) or
  // Object.assign(module.exports, require(...), ...) with multiple sources
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === 'Object' &&
    expression.expression.name.text === 'assign'
  ) {
    const args = expression.arguments
    if (args.length >= 2) {
      const target = args[0]
      // Follow ALL source modules, not just args[1]
      for (let i = 1; i < args.length; i += 1) {
        const source = args[i]
        if (isCommonJsExportTarget(target)) {
          const required = requiredModuleOf(source, importedBindings)
          if (required !== null) return required
          // A require-bound alias assigned via Object.assign
          if (ts.isIdentifier(source) && importedBindings) {
            const imported = importedBindings.get(source.text)
            if (imported !== undefined) return imported
          }
        }
      }
    }
    return null
  }
  return null
}

/**
 * The `require(...)` call a CommonJS re-export is rooted at. A re-export that
 * reads a member of the required module - `module.exports =
 * require('./ids').structId` - is rooted at the require call, so a property
 * access and an element access are unwrapped to find it.
 */
function commonJsRequireCall(
  expression: ts.Expression,
): ts.CallExpression | null {
  let current: ts.Expression = expression
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = current.expression
  }
  if (!ts.isCallExpression(current)) return null
  if (!ts.isIdentifier(current.expression)) return null
  if (current.expression.text !== 'require') return null
  return current
}

/**
 * Whether an assignment target names a CommonJS export. `module.exports` and
 * every property of `exports` name one.
 *
 * A property of an export target names an export target as well, so the
 * ordinary named-export form `module.exports.api = require('./types')` names
 * one: its owner is the `module.exports` property access, not the `module`
 * identifier. The element access and the nested property access are the same
 * spelling of the same rule: `module.exports['api']` and
 * `module.exports.api.types`.
 */
function isCommonJsExportTarget(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === 'exports'
  if (ts.isPropertyAccessExpression(expression)) {
    // `module.exports` is the export target of the module.
    if (isModuleExportsRoot(expression.expression, expression.name.text)) {
      return true
    }
    // A property of an export target is an export target.
    return isCommonJsExportTarget(expression.expression)
  }
  if (ts.isElementAccessExpression(expression)) {
    // `module['exports']` is the export target of the module.
    if (isModuleExportsRoot(expression.expression, elementAccessName(expression))) {
      return true
    }
    // An element of an export target is an export target.
    return isCommonJsExportTarget(expression.expression)
  }
  return false
}

/**
 * Whether an expression is the `module.exports` of a CommonJS module. The
 * property form is `module.exports` and the element form is
 * `module['exports']`; any other name of a property of `module` is not the
 * export target of the module.
 *
 * An element access whose argument is not a literal names no property the
 * guard can prove, so it fails closed: the guard cannot prove that it is not
 * the export target of the module.
 */
function isModuleExportsRoot(
  owner: ts.Expression,
  name: string | null,
): boolean {
  if (!ts.isIdentifier(owner) || owner.text !== 'module') return false
  if (name === null) return true
  return name === 'exports'
}

/**
 * The name an element access names, or null when the argument is not a
 * literal and names no property the guard can prove.
 */
function elementAccessName(
  expression: ts.ElementAccessExpression,
): string | null {
  const argument = expression.argumentExpression
  if (!ts.isStringLiteralLike(argument)) return null
  return argument.text
}

/**
 * Whether a declaration is exported. `export const id = ...` and
 * `export function legacyId() { ... }` are export declarations that alias or
 * use a binding.
 */
function hasExportModifier(statement: ts.HasModifiers): boolean {
  return (
    statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false
  )
}

/**
 * The module a `require(...)` call names, the sentinel a computed require
 * records, or null when the expression is not a require at all.
 *
 * A re-export and a binding can read a member of the required module, so a
 * property access and an element access that is rooted at the require call
 * name the required module as well: `require('./ids').structId` and
 * `require('./ids')['structId']` name `./ids`.
 *
 * A computed require has no literal specifier, so the guard cannot prove
 * that it does not load a migrated family. It fails closed in the same way a
 * computed dynamic import does.
 */
function requiredModuleOf(
  expression: ts.Expression,
  _importedBindings?: Map<string, string>,
): string | null {
  const call = commonJsRequireCall(expression)
  if (call === null) return null
  const argument = call.arguments[0]
  if (argument && ts.isStringLiteralLike(argument)) return argument.text
  return NONLITERAL_REQUIRE
}

/**
 * The migrated family a retained-tree wrapper reaches by re-export, or null
 * when it reaches none. The chain is followed transitively, so a wrapper
 * that re-exports another wrapper is traced as well.
 *
 * An exported expression that uses a binding of a migrated family's authority
 * reaches that family as well: the wrapper hands out a value the local
 * authority produced, so an importer outside the retained tree reaches the
 * local authority through the wrapper.
 */
function migratedFamilyInReexportChain(target: LocalTarget): string | null {
  const seen = new Set<string>()
  const pending: LocalTarget[] = [target]
  while (pending.length > 0) {
    const current = pending.shift()!
    const key = localTargetKey(current)
    if (seen.has(key)) continue
    seen.add(key)
    const module = readLocalModule(current)
    if (module === null) continue
    // The specifiers of a module are relative to the file that backs it, so
    // an index module resolves them against its own directory.
    const moduleUrl = new URL(module.path, 'file:///')
    const specifiers = reexportSpecifiers(module.source)
    for (const specifier of specifiers.reexports) {
      if (specifier === NONLITERAL_REQUIRE) {
        // A computed re-export names no literal target, so the guard cannot
        // prove that it does not reach a migrated family. It fails closed in
        // the same way a computed require does.
        return UNRESOLVED_REEXPORT
      }
      const resolved = resolveLocalTarget(specifier, moduleUrl)
      if (resolved === null) continue
      const normalized = normalizeLocalTarget(resolved)
      if (
        isMigratedFamilyTarget(normalized.path) ||
        isStructBarrelTarget(normalized.path)
      )
        return normalized.path
      if (isRetainedTreePath(normalized.path)) pending.push(normalized)
    }
    for (const specifier of specifiers.reaches) {
      if (specifier === NONLITERAL_REQUIRE) {
        // A computed require reaches no literal target, so the guard cannot
        // prove that it does not reach the authority of a migrated family. It
        // fails closed in the same way a computed re-export does.
        return UNRESOLVED_REEXPORT
      }
      const resolved = resolveLocalTarget(specifier, moduleUrl)
      if (resolved === null) continue
      const normalized = normalizeLocalTarget(resolved)
      // Only the authority of a migrated family is followed here: the entry
      // module of the family. A nested module of a family is an
      // implementation detail of that family, and the retained modules that
      // use one - the renderer branch the cutover plan switches to the
      // package in E-04 - are not an E-03 boundary escape.
      if (isMigratedFamilyAuthority(normalized.path)) return normalized.path
    }
  }
  return null
}

/**
 * Whether a resolved path is the authority of a migrated family: the entry
 * module of the family, the module the family's own name names.
 */
function isMigratedFamilyAuthority(target: string): boolean {
  for (const familyRoot of migratedFamilyRoots.values()) {
    if (target === familyRoot) return true
  }
  return false
}

function isStructBarrelTarget(target: string): boolean {
  const normalized = target.replace(/\/(?:index(?:\.(?:ts|js|tsx|astro))?)?$/, '')
  return (
    normalized === portableRoot.pathname.replace(/\/$/, '') ||
    normalized === new URL('struct', root).pathname
  )
}

/**
 * Resolve a module specifier to the local path it names, or null when the
 * specifier does not name a local module.
 *
 * The extension of the module is removed, so every spelling of the same
 * module resolves to the same path: an explicit `.mdx` suffix names the same
 * retained MDX wrapper as the suffix-free spelling of it.
 *
 * The exact file the specifier names is kept as well, so the resolution can
 * probe that file before the extensionless candidates: a specifier that names
 * a file with an explicit extension names that file.
 */
function resolveLocalTarget(specifier: string, file: URL): LocalTarget | null {
  if (
    specifier === '@erniesg/struct' ||
    specifier.startsWith('@erniesg/struct/')
  ) {
    return null
  }
  const resolved = resolveLocalSpecifier(specifier, file)
  if (resolved === null) return null
  return {
    path: resolved.replace(moduleExtensionPattern, ''),
    exact: moduleExtensionPattern.test(resolved) ? resolved : null,
  }
}

/**
 * The path a local module specifier names, with its extension still in place.
 */
function resolveLocalSpecifier(specifier: string, file: URL): string | null {
  if (specifier.startsWith('.')) {
    return new URL(specifier, file).pathname
  }
  return resolveAliasSpecifier(specifier)
}

/**
 * The extension a local module can carry. The list is the one the scanner
 * accepts, so a module the scanner would read is a module the guard can
 * resolve.
 */
const moduleExtensionPattern = /\.(?:[cm]?[jt]sx?|astro|mdx)$/u

/**
 * The app-owned recovery presentation module has an enumerated importer list.
 * Every other production importer is a violation, so a new consumer has to be
 * added to that list deliberately.
 */
function recoveryImporterViolationsForSpecifiers(
  specifiers: string[],
  file: URL,
): string[] {
  const violations: string[] = []
  for (const specifier of specifiers) {
    if (specifier === '<nonliteral dynamic import>') continue
    if (specifier === NONLITERAL_REQUIRE) continue
    if (specifier === NONLITERAL_GLOB) continue
    const target = resolveLocalTarget(specifier, file)
    if (target === null || target.path !== appRecoveryModule) continue
    if (permittedRecoveryImporters.has(file.pathname)) continue
    violations.push(
      `${file.pathname}: app recovery module import ${specifier} is not a permitted importer`,
    )
  }
  return violations
}

function recoveryImporterViolations(source: string, file: URL): string[] {
  return recoveryImporterViolationsForSpecifiers(
    importedPaths(source, file),
    file,
  )
}

/**
 * The recovery authority a module reaches by re-export, or null when it
 * reaches none.
 *
 * The chain is followed transitively and across the retained-tree boundary,
 * so a retained wrapper that re-exports the compatibility forwarder, and a
 * wrapper that re-exports the app-owned recovery module directly, are both
 * found. Only a path that leaves the imported module itself counts, so a
 * direct import of the app-owned recovery module keeps its own allowlist.
 *
 * Only the re-exports of a module are followed here, and not the modules
 * its exported expressions use: the allowlist of the app-owned recovery
 * module names the modules that import it, and a module that uses a
 * permitted importer does not import the recovery module itself.
 */
function recoveryAuthorityInReexportChain(
  target: LocalTarget,
):
  | 'compatibility forwarder'
  | 'app recovery module'
  | typeof UNRESOLVED_REEXPORT
  | null {
  const seen = new Set<string>()
  const pending: LocalTarget[] = []
  const module = readLocalModule(target)
  if (module === null) return null
  const moduleUrl = new URL(module.path, 'file:///')
  for (const specifier of reexportSpecifiers(module.source).reexports) {
    if (specifier === NONLITERAL_REQUIRE) {
      // A computed re-export names no literal target, so the guard cannot
      // prove that it does not reach the recovery authority. It fails closed
      // in the same way a computed require does.
      return UNRESOLVED_REEXPORT
    }
    const resolved = resolveLocalTarget(specifier, moduleUrl)
    if (resolved === null) continue
    pending.push(normalizeLocalTarget(resolved))
  }
  while (pending.length > 0) {
    const current = pending.shift()!
    const key = localTargetKey(current)
    if (seen.has(key)) continue
    seen.add(key)
    if (current.path === compatibilityRecoveryForwarder) {
      return 'compatibility forwarder'
    }
    if (current.path === appRecoveryModule) return 'app recovery module'
    const currentModule = readLocalModule(current)
    if (currentModule === null) continue
    const currentUrl = new URL(currentModule.path, 'file:///')
    for (const specifier of reexportSpecifiers(currentModule.source).reexports) {
      if (specifier === NONLITERAL_REQUIRE) return UNRESOLVED_REEXPORT
      const resolved = resolveLocalTarget(specifier, currentUrl)
      if (resolved === null) continue
      pending.push(normalizeLocalTarget(resolved))
    }
  }
  return null
}

/**
 * The compatibility forwarder is part of the recovery importer boundary: it
 * re-exports the app-owned recovery module, so a module outside the retained
 * `src/struct` tree reaches the recovery module through the legacy facade
 * when it imports the forwarder. The check works on the resolved target, so
 * every spelling of the forwarder is covered: the direct relative form, the
 * `@/` alias, the project-root form and a `.js` suffix form.
 *
 * A path that reaches the forwarder or the app-owned recovery module
 * transitively is a violation as well: a retained wrapper that re-exports
 * the forwarder is a way around the allowlist, so the chain is followed.
 */
function compatibilityForwarderViolationsForSpecifiers(
  specifiers: string[],
  file: URL,
): string[] {
  // The retained `src/struct` tree keeps its own compatibility forwarder.
  if (file.pathname.startsWith(portableRoot.pathname)) return []
  const violations: string[] = []
  for (const specifier of specifiers) {
    if (specifier === '<nonliteral dynamic import>') continue
    if (specifier === NONLITERAL_REQUIRE) continue
    if (specifier === NONLITERAL_GLOB) continue
    const target = resolveLocalTarget(specifier, file)
    if (target === null) continue
    if (target.path === compatibilityRecoveryForwarder) {
      violations.push(
        `${file.pathname}: compatibility recovery forwarder import ${specifier} is not allowed outside the retained struct tree`,
      )
      continue
    }
    const authority = recoveryAuthorityInReexportChain(target)
    if (authority === null) continue
    const reached =
      authority === UNRESOLVED_REEXPORT ? authority : `the ${authority}`
    violations.push(
      `${file.pathname}: recovery authority import ${specifier} -> ${target.path} reaches ${reached}`,
    )
  }
  return violations
}

function e03ViolationsForSource(
  source: string,
  file: URL,
  publicPaths: Set<string>,
  imports?: ParsedImports,
): string[] {
  const parsed = imports ?? parseImports(source, file)
  const violations: string[] = []
  const computedDynamicImports = parsed.computedDynamicImports
  const computedRequires = parsed.computedRequires
  const computedGlobs = parsed.computedGlobs
  const specifiers = parsed.specifiers
  let computedIndex = 0
  let computedRequireIndex = 0
  let computedGlobIndex = 0
  for (const specifier of specifiers) {
    if (specifier === '<nonliteral dynamic import>') {
      // A computed dynamic import has no literal specifier, so the guard
      // cannot prove that it does not load a migrated family. It fails closed.
      const fragments = computedDynamicImports[computedIndex++] ?? []
      const offending = fragments
        .map((fragment) => resolveLocalTarget(fragment, file))
        .filter((target): target is LocalTarget => target !== null)
        .map((target) => target.path.replace(/\/+$/, ''))
        .find((normalized) => {
          return (
            migratedFamilyForTarget(normalized) !== null ||
            isStructBarrelTarget(normalized)
          )
        })
      violations.push(
        `${file.pathname}: computed dynamic import ${offending ?? 'with an unresolved target'} is not allowed`,
      )
      continue
    }
    if (specifier === NONLITERAL_REQUIRE) {
      // A computed require is a computed import, so it fails closed in the
      // same way a computed dynamic import does.
      const computed = computedRequires[computedRequireIndex++]
      const offending = (computed?.fragments ?? [])
        .map((fragment) => resolveLocalTarget(fragment, file))
        .filter((target): target is LocalTarget => target !== null)
        .map((target) => target.path.replace(/\/+$/, ''))
        .find((normalized) => {
          return (
            migratedFamilyForTarget(normalized) !== null ||
            isStructBarrelTarget(normalized)
          )
        })
      if (offending) {
        violations.push(
          `${file.pathname}: computed require ${offending} is not allowed`,
        )
        continue
      }
      // A require that only names a package manifest cannot load a module
      // of a migrated family, so it is not a boundary escape.
      if (/\/package\.json$/.test(computed?.staticText ?? '')) continue
      violations.push(
        `${file.pathname}: computed require with an unresolved target is not allowed`,
      )
      continue
    }
    if (specifier === NONLITERAL_GLOB) {
      // A computed glob pattern has no literal target, so the guard cannot
      // prove that it does not load a migrated family. It fails closed in
      // the same way a computed dynamic import does.
      const computed = computedGlobs[computedGlobIndex++]
      const offending = (computed?.fragments ?? [])
        .map((fragment) => resolveLocalTarget(fragment, file))
        .filter((target): target is LocalTarget => target !== null)
        .map((target) => target.path.replace(/\/+$/, ''))
        .find((normalized) => {
          return (
            migratedFamilyForTarget(normalized) !== null ||
            isStructBarrelTarget(normalized)
          )
        })
      violations.push(
        `${file.pathname}: computed glob ${offending ?? 'with an unresolved target'} is not allowed`,
      )
      continue
    }
    if (specifier === '@erniesg/struct' || specifier.startsWith('@erniesg/struct/')) {
      if (!publicPaths.has(specifier)) {
        violations.push(`${file.pathname}: private package import ${specifier}`)
      } else if (specifier === '@erniesg/struct') {
        // The package root export is allowed in general, but codec consumers
        // MUST use @erniesg/struct/document. The deprecated migrateStructDocument
        // is also excluded from the root by the implementation record.
        // Check the named imports to enforce this.
        const namedImports = parsed.packageNamedImports.get('@erniesg/struct')
        if (namedImports) {
          const forbiddenRootImports = new Set([
            'decodeStructDocument',
            'migrateStructDocument',
          ])
          for (const name of namedImports) {
            if (forbiddenRootImports.has(name)) {
              violations.push(
                `${file.pathname}: ${name} must be imported from '@erniesg/struct/document', not the package root`,
              )
            }
          }
        }
      }
      continue
    }
    const resolved = resolveLocalTarget(specifier, file)
    if (resolved === null) continue
    const target = resolved.path

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
      const family = migratedFamilyForTarget(target)
      if (family && migratedFamilies.has(family)) {
        violations.push(
          `${file.pathname}: migrated family import ${specifier} -> ${target}`,
        )
      }
    }
    // A retained-tree wrapper that re-exports a migrated family is another
    // way into the local migrated authority, so an importer outside the
    // retained tree is a violation. The wrapper's own re-export stays
    // exempt, because it resides under `src/struct/**`.
    if (!isRetainedTreePath(file.pathname) && isRetainedTreePath(target)) {
      const reexported = migratedFamilyInReexportChain(resolved)
      if (reexported !== null) {
        violations.push(
          `${file.pathname}: retained-tree wrapper import ${specifier} -> ${target} re-exports ${reexported}`,
        )
      }
    }
    if (isStructBarrelTarget(target)) {
      violations.push(
        `${file.pathname}: migrated family import ${specifier} -> ${target}`,
      )
    }
  }
  violations.push(...recoveryImporterViolationsForSpecifiers(specifiers, file))
  violations.push(
    ...compatibilityForwarderViolationsForSpecifiers(specifiers, file),
  )
  return violations
}

/**
 * The local names the production recovery module binds from
 * `@erniesg/struct/recovery`. The E-03 guard asserts that the module really
 * imports the package runtime exports, so an app-local copy of either fact
 * cannot silently become the runtime authority again.
 */
function packageRecoveryImports(source: string): {
  diagnosticCategory?: string
  hasActionableRecovery?: string
} {
  const file = ts.createSourceFile(
    'recovery.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const bindings: {
    diagnosticCategory?: string
    hasActionableRecovery?: string
  } = {}
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const moduleSpecifier = statement.moduleSpecifier
    if (!ts.isStringLiteral(moduleSpecifier)) continue
    if (moduleSpecifier.text !== '@erniesg/struct/recovery') continue
    const namedBindings = statement.importClause?.namedBindings
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue
    for (const element of namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text
      if (imported !== 'diagnosticCategory' && imported !== 'hasActionableRecovery')
        continue
      bindings[imported] = element.name.text
    }
  }
  return bindings
}

/**
 * The body of a top-level function declaration, so the guard can inspect what
 * an app function actually decides instead of how it is spelled.
 */
function topLevelFunctionBody(source: string, name: string): string | null {
  const file = ts.createSourceFile(
    'recovery.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement)) continue
    if (statement.name?.text !== name) continue
    return statement.body ? statement.body.getText(file) : null
  }
  return null
}

/**
 * A document whose author-note identifiers collide only after the renderer's
 * stable identifier normalization: `1author-note-1` and `n-1author-note-1`
 * both normalize to `n-1author-note-1`. The document is otherwise valid, so
 * the package decoder accepts it and the package renderer refuses it.
 */
function collidingEmittedIdentifierDocument(): StructDocument {
  const document = validDocument() as unknown as {
    metadata: { authorNotes: Array<Record<string, unknown>> }
  }
  document.metadata.authorNotes = [
    { ...document.metadata.authorNotes[0], id: '1author-note-1' },
    {
      id: 'n-1author-note-1',
      author: 'Author',
      label: '1',
      target: 'block-1',
    },
  ]
  return seal(document) as unknown as StructDocument
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

  // The case walks the whole repository and analyses every portable file, so
  // it needs more than the default per-test timeout on a loaded runner.
  it('keeps app recovery consumers on the app-owned path', async () => {
    const violations: string[] = []
    for (const analysis of await repositoryAnalysisOnce()) {
      if (analysis.file.pathname.startsWith(portableRoot.pathname)) continue
      // The compatibility forwarder is resolved, not matched against a list
      // of spellings, so every alias of it is a violation here too.
      violations.push(
        ...compatibilityForwarderViolationsForSpecifiers(
          analysis.imports.specifiers,
          analysis.file,
        ),
      )
    }
    expect(violations).toEqual([])
  }, 120000)

  // The case walks the whole repository and analyses every portable file, so
  // it needs more than the default per-test timeout on a loaded runner.
  it('keeps all implementation modules within their allowed import boundaries', async () => {
    const publicPaths = await publicPackagePaths()
    const files = await repositoryAnalysisOnce()
    expect(files.map((analysis) => analysis.file.pathname)).toContain(
      new URL('research/import-types.ts', root).pathname,
    )
    for (const analysis of files) {
      expect(
        boundaryViolations(
          analysis.source,
          analysis.file,
          publicPaths,
          analysis.imports.specifiers,
        ),
        analysis.file.pathname,
      ).toEqual([])
    }
  }, 120000)

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

  // The case walks the whole repository and analyses every portable file, so
  // it needs more than the default per-test timeout on a loaded runner.
  it('E-03: prohibits migrated-family imports (types/ids/reading-order/codec) and validates package paths', async () => {
    const publicPaths = await publicPackagePaths()
    const violations: string[] = []
    for (const analysis of await repositoryAnalysisOnce()) {
      if (analysis.file.pathname.startsWith(portableRoot.pathname)) continue
      violations.push(
        ...e03ViolationsForSource(
          analysis.source,
          analysis.file,
          publicPaths,
          analysis.imports,
        ),
      )
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
    // '@/struct/recovery' is the compatibility forwarder of the retained
    // `src/struct` tree, not the app-owned recovery module, so it is
    // rejected outside that tree whatever alias names it.
    expect(
      e03ViolationsForSource(
        "import { diagnosticCategory } from '@/struct/recovery'",
        probeFile,
        publicPaths,
      ),
    ).not.toEqual([])
    // The app-owned recovery path itself stays clean for a permitted
    // importer, and the retained tree keeps its own forwarder.
    expect(
      e03ViolationsForSource(
        "import { diagnosticCategory } from '@/struct-adapters/recovery'",
        new URL('research/recovery-projection.ts', root),
        publicPaths,
      ),
    ).toEqual([])
    expect(
      e03ViolationsForSource(
        "export * from './recovery'",
        new URL('struct/probe.ts', root),
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
    // The configured alias forms all resolve to the same local migrated
    // family, and the `@/struct` barrel is a migrated-family target too.
    expect(
      e03ViolationsForSource(
        "import { T } from '~/struct/types'",
        probeFile,
        publicPaths,
      ),
    ).not.toEqual([])
    expect(
      e03ViolationsForSource(
        "import { T } from '@/struct'",
        probeFile,
        publicPaths,
      ),
    ).not.toEqual([])
  }, 120000)

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

  it('E-03: the production recovery module takes its category and actionable-recovery authority from the package', async () => {
    const source = await readFile(
      new URL('struct-adapters/recovery.ts', root),
      'utf8',
    )
    const imports = packageRecoveryImports(source)

    // The production recovery module must import the package runtime exports,
    // not keep a local copy of either source-neutral fact.
    expect(
      imports.diagnosticCategory,
      'diagnosticCategory imported from @erniesg/struct/recovery',
    ).toBeTruthy()
    expect(
      imports.hasActionableRecovery,
      'hasActionableRecovery imported from @erniesg/struct/recovery',
    ).toBeTruthy()

    // The app copy table carries no local category field, so no second
    // category table can exist in the app.
    const copyTable = source.slice(
      source.indexOf('const DIAGNOSTIC_COPY'),
      source.indexOf('const FALLBACK_COPY'),
    )
    expect(copyTable.length).toBeGreaterThan(0)
    expect(copyTable).not.toMatch(/category:/)

    // The app facade delegates: the category function calls the package
    // export and decides no category of its own.
    const categoryBody = topLevelFunctionBody(source, 'diagnosticCategory')
    expect(categoryBody).not.toBeNull()
    expect(categoryBody ?? '').toContain(`${imports.diagnosticCategory}(`)
    expect(categoryBody ?? '').not.toMatch(
      /['"](?:text|layout|visuals|tables|equations|links|notes|source)['"]/,
    )

    // The app facade delegates: the actionable-recovery predicate calls the
    // package export and reads no `userAction` truthiness of its own.
    const actionableBody = topLevelFunctionBody(
      source,
      'hasActionableRecovery',
    )
    expect(actionableBody).not.toBeNull()
    expect(actionableBody ?? '').toContain(
      `${imports.hasActionableRecovery}(`,
    )
    expect(actionableBody ?? '').not.toMatch(/userAction/)
  })

  it('E-03: rejects project-root, nested-family, computed and CommonJS migrated-family imports', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)

    // A project-root specifier resolves to the local migrated family; it must
    // not fall through the resolver.
    expect(
      e03ViolationsForSource(
        "import { T } from '/src/struct/types'",
        research,
        publicPaths,
      ),
    ).not.toEqual([])
    expect(
      e03ViolationsForSource(
        "import { parse } from '/src/struct/codec/parsers'",
        research,
        publicPaths,
      ),
    ).not.toEqual([])

    // A nested import inside the local codec family is a migrated-family import.
    expect(
      e03ViolationsForSource(
        "import { parse } from '../struct/codec/parsers'",
        research,
        publicPaths,
      ),
    ).not.toEqual([])
    expect(
      e03ViolationsForSource(
        "import { primitive } from '@/struct/codec/primitives'",
        research,
        publicPaths,
      ),
    ).not.toEqual([])

    // A computed dynamic import has no literal specifier, so the guard must
    // refuse it instead of skipping it.
    expect(
      e03ViolationsForSource(
        "const load = () => import('../struct/' + name)",
        research,
        publicPaths,
      ),
    ).not.toEqual([])

    // CommonJS requires are imports too.
    expect(
      e03ViolationsForSource(
        "const types = require('../struct/types')",
        research,
        publicPaths,
      ),
    ).not.toEqual([])
    expect(
      e03ViolationsForSource(
        "import types = require('../struct/types')",
        research,
        publicPaths,
      ),
    ).not.toEqual([])
  })

  it('E-03: inspects MDX modules under src for migrated-family imports', async () => {
    const publicPaths = await publicPackagePaths()
    const files = await portableFiles(root)
    expect(files.map((file) => file.pathname)).toContain(
      new URL('content/blog/mlops-for-museums/index.mdx', root).pathname,
    )
    const mdxProbe = new URL('research/probe.mdx', root)
    expect(
      e03ViolationsForSource(
        "import { T } from '@/struct/types'\n\n# Heading\n",
        mdxProbe,
        publicPaths,
      ),
    ).not.toEqual([])
  })

  it('E-03: collects every consecutive leading MDX import statement', async () => {
    const publicPaths = await publicPackagePaths()
    const mdxProbe = new URL('research/probe.mdx', root)

    // The leading ESM block of an MDX document is the whole run of
    // consecutive top-level ESM statements, so a migrated-family import that
    // follows a safe import in the same block is still collected.
    const cases: Array<[string, string]> = [
      [
        'adjacent statements',
        "import { A } from './a'\nimport { T } from '@/struct/types'\n\n# Heading\n",
      ],
      [
        'statements separated by a blank line',
        "import { A } from './a'\n\nimport { T } from '@/struct/types'\n\n# Heading\n",
      ],
      [
        'statements separated by a multi-line statement',
        "import { A } from './a'\nexport const meta = {\n  title: 'x',\n}\nimport { T } from '@/struct/types'\n",
      ],
    ]
    const missed: string[] = []
    for (const [label, source] of cases) {
      if (
        e03ViolationsForSource(source, mdxProbe, publicPaths).length === 0
      ) {
        missed.push(label)
      }
    }
    expect(missed).toEqual([])

    // The reduction stays lossless: the leading block still ends at the
    // first line that cannot begin a top-level ESM statement, so a fenced
    // code sample that shows an import is not collected as a module
    // specifier.
    const fenced = [
      "import { A } from './a'",
      '',
      '```js',
      "import { T } from '@/struct/types'",
      '```',
      '',
    ].join('\n')
    expect(importedPaths(fenced, mdxProbe)).toEqual(['./a'])
    expect(
      e03ViolationsForSource(fenced, mdxProbe, publicPaths),
    ).toEqual([])
    const fencedOnly = [
      '# Heading',
      '',
      '```js',
      "import { T } from '@/struct/types'",
      '```',
      '',
    ].join('\n')
    expect(importedPaths(fencedOnly, mdxProbe)).toEqual([])
  })

  it('E-03: rejects every spelling of the compatibility recovery forwarder', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)

    // The compatibility forwarder re-exports the app-owned recovery module,
    // so a module outside the retained `src/struct` tree must not reach the
    // recovery module through it. The check is on the resolved target, so
    // every spelling of the forwarder is rejected.
    const spellings = [
      '../struct/recovery',
      '@/struct/recovery',
      '/src/struct/recovery',
      '@/struct/recovery.js',
    ]
    const accepted: string[] = []
    for (const specifier of spellings) {
      const violations = e03ViolationsForSource(
        `import { diagnosticCopy } from '${specifier}'`,
        research,
        publicPaths,
      )
      if (violations.length === 0) accepted.push(specifier)
    }
    expect(accepted).toEqual([])
    for (const specifier of spellings) {
      expect(
        e03ViolationsForSource(
          `import { diagnosticCopy } from '${specifier}'`,
          research,
          publicPaths,
        ),
        specifier,
      ).not.toEqual([])
    }

    // The retained tree keeps its own forwarder.
    expect(
      e03ViolationsForSource(
        "export * from './recovery'",
        new URL('struct/probe.ts', root),
        publicPaths,
      ),
    ).toEqual([])
  })

  it('E-03: rejects a new production importer of the app-owned recovery module', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    expect(
      e03ViolationsForSource(
        "import { diagnosticCopy } from '../struct-adapters/recovery'",
        research,
        publicPaths,
      ),
    ).not.toEqual([])
    expect(
      e03ViolationsForSource(
        "import { diagnosticCopy } from '@/struct-adapters/recovery'",
        research,
        publicPaths,
      ),
    ).not.toEqual([])
  })

  it('E-03: enforces the app-owned recovery importer allowlist inside the retained tree', async () => {
    const violations: string[] = []
    for (const file of await portableFiles(root)) {
      if (!file.pathname.startsWith(portableRoot.pathname)) continue
      const source = await readFile(file, 'utf8')
      violations.push(...recoveryImporterViolations(source, file))
    }
    expect(violations).toEqual([])
  })

  it('E-03: pins the decoder and renderer validation split for colliding emitted identifiers', () => {
    const document = collidingEmittedIdentifierDocument()

    // The package document decoder accepts the document: the emitted
    // identifier constraint belongs to the renderer, not to the decoder.
    expect(() => packageDecodeStructDocument(document)).not.toThrow()

    // The package XHTML renderer refuses the same document.
    expect(() => renderPublicationXhtml(document)).toThrow(
      /emitted XHTML identifier/,
    )

    // The app's own decoder still fails closed on the same document.
    expect(() => appDecodeStructDocument(document)).toThrow(
      /DUPLICATE_IDENTIFIER/,
    )
  })
  it('E-03: the package EPUB renderer and the app render paths refuse colliding emitted identifiers', async () => {
    const document = collidingEmittedIdentifierDocument()

    // The package XHTML renderer refuses the colliding document.
    expect(() => renderPublicationXhtml(document)).toThrow(
      /emitted XHTML identifier/,
    )

    // The package EPUB renderer refuses the same document, so a regression
    // that lets a colliding emitted identifier through `buildStructEpub` is
    // caught here.
    await expect(packageBuildStructEpub(document)).rejects.toThrow(
      /emitted XHTML identifier/,
    )

    // The app's own render entry points refuse it as well, so a regression
    // that lets a colliding emitted identifier through the app's
    // `renderPublicationXhtml` or `buildEpub` is caught here.
    expect(() => appRenderPublicationXhtml(document)).toThrow(/duplicate id/)
    await expect(appBuildEpub(document)).rejects.toThrow(/duplicate id/)
  })

  it('E-03: collects MDX ESM flow blocks wherever they appear in the document', async () => {
    const publicPaths = await publicPackagePaths()
    const mdxProbe = new URL('research/probe.mdx', root)

    // MDX recognises an import statement anywhere at the top level of a
    // document, not only in a leading prelude, so an import that follows
    // markdown content is a real module specifier.
    const headingThenImport = [
      '# Heading',
      '',
      "import { T } from '@/struct/types'",
      '',
    ].join('\n')
    expect(importedPaths(headingThenImport, mdxProbe)).toEqual([
      '@/struct/types',
    ])
    expect(
      e03ViolationsForSource(headingThenImport, mdxProbe, publicPaths),
    ).not.toEqual([])

    // The reduction stays lossless: a fenced code sample and an indented
    // code sample are markdown content, so an import-looking line inside
    // either is not collected as a module specifier.
    const fencedAfterHeading = [
      '# Heading',
      '',
      '```js',
      "import { T } from '@/struct/types'",
      '```',
      '',
    ].join('\n')
    expect(importedPaths(fencedAfterHeading, mdxProbe)).toEqual([])
    expect(
      e03ViolationsForSource(fencedAfterHeading, mdxProbe, publicPaths),
    ).toEqual([])
    const indentedSample = [
      "    import { T } from '@/struct/types'",
      '',
    ].join('\n')
    expect(importedPaths(indentedSample, mdxProbe)).toEqual([])
    expect(
      e03ViolationsForSource(indentedSample, mdxProbe, publicPaths),
    ).toEqual([])
  })

  it('E-03: reads a multiline MDX import declaration until the parser recognises it', async () => {
    const publicPaths = await publicPackagePaths()
    const mdxProbe = new URL('research/probe.mdx', root)

    // A valid ESM declaration can put its `from` clause on a line of its
    // own, so the collection has to keep reading until the parser recognises
    // the whole declaration. The brace depth alone does not decide that the
    // statement is finished.
    const multiline = ['import T', "from '@/struct/types'", ''].join('\n')
    expect(importedPaths(multiline, mdxProbe)).toEqual(['@/struct/types'])
    expect(
      e03ViolationsForSource(multiline, mdxProbe, publicPaths),
    ).not.toEqual([])

    // A blank line does not end the declaration either.
    const multilineWithBlankLine = [
      'import T',
      '',
      "from '@/struct/types'",
      '',
    ].join('\n')
    expect(importedPaths(multilineWithBlankLine, mdxProbe)).toEqual([
      '@/struct/types',
    ])
    expect(
      e03ViolationsForSource(multilineWithBlankLine, mdxProbe, publicPaths),
    ).not.toEqual([])

    // A line that only looks like a continuation is not part of a
    // declaration, so it is never pulled into one.
    const proseAfterStatement = [
      'import T',
      '',
      'the previous section described the format',
      '',
    ].join('\n')
    expect(importedPaths(proseAfterStatement, mdxProbe)).toEqual([])
    expect(
      e03ViolationsForSource(proseAfterStatement, mdxProbe, publicPaths),
    ).toEqual([])

    // A prose line that begins with `import` is not a declaration either.
    const proseImport = [
      'import the good stuff',
      '',
      'more prose',
      '',
    ].join('\n')
    expect(importedPaths(proseImport, mdxProbe)).toEqual([])
    expect(
      e03ViolationsForSource(proseImport, mdxProbe, publicPaths),
    ).toEqual([])

    // A code sample that follows an unfinished statement stays markdown
    // content.
    const fencedAfterOpenStatement = [
      'import T',
      '```js',
      "import { T } from '@/struct/types'",
      '```',
      '',
    ].join('\n')
    expect(importedPaths(fencedAfterOpenStatement, mdxProbe)).toEqual([])
    expect(
      e03ViolationsForSource(fencedAfterOpenStatement, mdxProbe, publicPaths),
    ).toEqual([])

    // A single-line declaration is still collected exactly as before.
    const singleLine = ["import { T } from '@/struct/types'", ''].join('\n')
    expect(importedPaths(singleLine, mdxProbe)).toEqual(['@/struct/types'])
  })

  it('E-03: rejects a computed CommonJS require', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)

    // A computed require has no literal specifier, so the guard cannot
    // prove that it does not load a migrated family. It fails closed in the
    // same way a computed dynamic import does.
    expect(
      e03ViolationsForSource(
        "const types = require('../struct/' + family)",
        research,
        publicPaths,
      ),
    ).not.toEqual([])
    expect(
      e03ViolationsForSource(
        'const types = require(pathVariable)',
        research,
        publicPaths,
      ),
    ).not.toEqual([])

    // A string-literal require keeps its classification: it is a
    // migrated-family import.
    expect(
      e03ViolationsForSource(
        "const types = require('../struct/types')",
        research,
        publicPaths,
      ),
    ).not.toEqual([])

    // A require of an unrelated module is not a violation.
    expect(
      e03ViolationsForSource(
        "const safe = require('./safe')",
        research,
        publicPaths,
      ),
    ).toEqual([])
  })

  it('E-03: inspects Vite glob imports', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)

    // A literal glob that reaches a migrated family is a boundary escape:
    // the bundler resolves the pattern to the local module, so production
    // would run the local implementation.
    const literal = "const codecs = import.meta.glob('../struct/codec.ts', { eager: true })"
    expect(importedPaths(literal, research)).toContain('../struct/codec.ts')
    expect(
      e03ViolationsForSource(literal, research, publicPaths),
    ).not.toEqual([])

    // A glob over the subtree reaches the family as well.
    const subtree = "const all = import.meta.glob('../struct/**/*.ts', { eager: true })"
    expect(
      e03ViolationsForSource(subtree, research, publicPaths),
    ).not.toEqual([])

    // A glob over another family of the same tree is reported too.
    const types = "const all = import.meta.glob('../struct/types.ts')"
    expect(
      e03ViolationsForSource(types, research, publicPaths),
    ).not.toEqual([])

    // A glob over the whole tree in one array is reported as well.
    const patterns = "const all = import.meta.glob(['../struct/codec.ts', '../struct/ids.ts'])"
    expect(
      e03ViolationsForSource(patterns, research, publicPaths),
    ).not.toEqual([])

    // A computed glob pattern has no literal target, so the guard cannot
    // prove that it does not load a migrated family. It fails closed in the
    // same way a computed dynamic import does.
    const computed = 'const all = import.meta.glob(pattern, { eager: true })'
    const computedViolations = e03ViolationsForSource(
      computed,
      research,
      publicPaths,
    )
    expect(computedViolations).not.toEqual([])
    expect(computedViolations.join('\n')).toContain('computed glob')

    // A glob that provably names no migrated family is not a violation.
    const safe = "const pages = import.meta.glob('../content/**/*.md', { eager: true })"
    expect(importedPaths(safe, research)).toEqual([])
    expect(e03ViolationsForSource(safe, research, publicPaths)).toEqual([])

    // A glob that names no module of the tree is not a violation either.
    const elsewhere = "const pages = import.meta.glob('../pages/**/*.ts')"
    expect(e03ViolationsForSource(elsewhere, research, publicPaths)).toEqual([])
  })

  it('E-03: resolves a Vite glob pattern against the directory of the importing module', async () => {
    const publicPaths = await publicPackagePaths()
    const srcModule = new URL('probe.ts', root)
    const research = new URL('research/probe.ts', root)

    // Vite resolves a './'-relative pattern against the directory of the
    // importing module, so a module that sits above the migrated families
    // reaches them with the canonical './' spelling.
    const dotSlash = "const codecs = import.meta.glob('./struct/codec.ts', { eager: true })"
    expect(importedPaths(dotSlash, srcModule)).toContain('./struct/codec.ts')
    expect(
      e03ViolationsForSource(dotSlash, srcModule, publicPaths),
    ).not.toEqual([])

    // The './'-relative subtree spelling reaches the family as well.
    const subtree = "const all = import.meta.glob('./struct/**/*.ts', { eager: true })"
    expect(
      e03ViolationsForSource(subtree, srcModule, publicPaths),
    ).not.toEqual([])

    // An array of './'-relative patterns is reported too.
    const patterns = "const all = import.meta.glob(['./struct/codec.ts', './struct/ids.ts'])"
    expect(
      e03ViolationsForSource(patterns, srcModule, publicPaths),
    ).not.toEqual([])

    // A negated './'-relative pattern removes the module it excludes, and
    // only that module.
    const negated = "const all = import.meta.glob(['./struct/**', '!./struct/codec.ts'])"
    const negatedViolations = e03ViolationsForSource(
      negated,
      srcModule,
      publicPaths,
    )
    expect(negatedViolations).not.toEqual([])
    expect(negatedViolations.join('\n')).not.toContain('./struct/codec.ts ->')

    // A './'-relative pattern that provably names no migrated family is not
    // a violation.
    const safe = "const pages = import.meta.glob('./content/**/*.md', { eager: true })"
    expect(importedPaths(safe, srcModule)).toEqual([])
    expect(e03ViolationsForSource(safe, srcModule, publicPaths)).toEqual([])

    // The './'-relative pattern of a module in a subdirectory resolves
    // against that subdirectory, so it names a different module and does
    // not reach the family.
    const elsewhere = "const codecs = import.meta.glob('./struct/codec.ts')"
    expect(importedPaths(elsewhere, research)).toEqual([])
    expect(e03ViolationsForSource(elsewhere, research, publicPaths)).toEqual([])

    // The '../'-relative spelling keeps working.
    const parentRelative = "const codecs = import.meta.glob('../struct/codec.ts', { eager: true })"
    expect(importedPaths(parentRelative, research)).toContain(
      '../struct/codec.ts',
    )
    expect(
      e03ViolationsForSource(parentRelative, research, publicPaths),
    ).not.toEqual([])
  })

  it('E-03: catches an external import of a retained-tree wrapper that re-exports a migrated family', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const wrapper = new URL('struct/__e03_probe_legacy_types.ts', root)
    await writeFile(wrapper.pathname, "export * from './types'\n", 'utf8')
    try {
      // A retained-tree wrapper that re-exports a migrated family is a way
      // into the local migrated authority, so an importer outside the
      // retained tree is a violation.
      expect(
        e03ViolationsForSource(
          "import { T } from '../struct/__e03_probe_legacy_types'",
          research,
          publicPaths,
        ),
      ).not.toEqual([])

      // The retained tree's own internal re-export stays exempt.
      expect(
        e03ViolationsForSource(
          "export * from './__e03_probe_legacy_types'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(wrapper.pathname, { force: true })
    }
  })

  it('E-03: normalises a project-root or alias Vite glob pattern before matching', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)

    // Vite resolves a project-root glob pattern against the project root, so
    // a root-absolute pattern reaches the migrated family it names.
    const rootAbsolute =
      "const codecs = import.meta.glob('/src/struct/**/*.ts', { eager: true })"
    expect(importedPaths(rootAbsolute, research)).toContain('../struct/codec.ts')
    expect(
      e03ViolationsForSource(rootAbsolute, research, publicPaths),
    ).not.toEqual([])

    // An alias pattern resolves through the alias to the same family.
    const aliased =
      "const codecs = import.meta.glob('@/struct/**/*.ts', { eager: true })"
    expect(importedPaths(aliased, research)).toContain('../struct/codec.ts')
    expect(
      e03ViolationsForSource(aliased, research, publicPaths),
    ).not.toEqual([])

    // A project-root pattern that names no migrated family is not a
    // violation.
    const rootSafe =
      "const pages = import.meta.glob('/src/content/**/*.md', { eager: true })"
    expect(importedPaths(rootSafe, research)).toEqual([])
    expect(e03ViolationsForSource(rootSafe, research, publicPaths)).toEqual([])

    // An alias pattern that names no migrated family is not a violation
    // either.
    const aliasSafe =
      "const pages = import.meta.glob('@/content/**/*.md', { eager: true })"
    expect(importedPaths(aliasSafe, research)).toEqual([])
    expect(e03ViolationsForSource(aliasSafe, research, publicPaths)).toEqual([])
  })

  it('E-03: follows an imported binding that a retained wrapper re-exports', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const wrapper = new URL('struct/__e03_probe_legacy_ids.ts', root)
    await writeFile(
      wrapper.pathname,
      "import { structId } from './ids'\nexport { structId }\n",
      'utf8',
    )
    try {
      // The ordinary two-step form re-exports the module the binding was
      // imported from, so a retained wrapper that uses it reaches the local
      // migrated authority.
      expect(
        e03ViolationsForSource(
          "import { structId } from '../struct/__e03_probe_legacy_ids'",
          research,
          publicPaths,
        ),
      ).not.toEqual([])

      // The retained tree keeps its own wrapper.
      expect(
        e03ViolationsForSource(
          "export { structId } from './__e03_probe_legacy_ids'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(wrapper.pathname, { force: true })
    }
  })

  it('E-03: inspects a Vite worker entry module', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)

    // Vite bundles the file a worker entry names as a module of its own, so
    // the entry is an import the guard has to inspect.
    const worker =
      "const worker = new Worker(new URL('../struct/ids.ts', import.meta.url), { type: 'module' })"
    expect(importedPaths(worker, research)).toContain('../struct/ids.ts')
    expect(
      e03ViolationsForSource(worker, research, publicPaths),
    ).not.toEqual([])

    // A shared worker takes the same entry form.
    const shared =
      "const worker = new SharedWorker(new URL('../struct/codec.ts', import.meta.url), { type: 'module' })"
    expect(importedPaths(shared, research)).toContain('../struct/codec.ts')
    expect(
      e03ViolationsForSource(shared, research, publicPaths),
    ).not.toEqual([])

    // A worker entry that names no migrated family is not a violation.
    const safe =
      "const worker = new Worker(new URL('../content/worker.ts', import.meta.url), { type: 'module' })"
    expect(e03ViolationsForSource(safe, research, publicPaths)).toEqual([])
  })

  it('E-03: inspects a local Astro script source', async () => {
    const publicPaths = await publicPackagePaths()
    const astro = new URL('components/probe.astro', root)

    // Astro processes a local script source and bundles that file, so the
    // source is an import the guard has to inspect.
    const source = '<script src="../struct/codec.ts"></script>\n'
    expect(importedPaths(source, astro)).toContain('../struct/codec.ts')
    expect(
      e03ViolationsForSource(source, astro, publicPaths),
    ).not.toEqual([])

    // A script source that names no migrated family is not a violation.
    const safe = '<script src="../components/helper.ts"></script>\n'
    expect(e03ViolationsForSource(safe, astro, publicPaths)).toEqual([])

    // An `is:inline` script is not processed, and a public or external
    // source is not a local module, so neither is collected.
    for (const source of [
      '<script is:inline src="../struct/ids.ts"></script>\n',
      '<script src="/struct/ids.ts"></script>\n',
      '<script src="https://example.com/struct/ids.ts"></script>\n',
    ]) {
      expect(importedPaths(source, astro)).toEqual([])
      expect(e03ViolationsForSource(source, astro, publicPaths)).toEqual([])
    }
  })

  it('E-03: inspects Astro template expressions', async () => {
    const publicPaths = await publicPackagePaths()
    const astro = new URL('components/probe.astro', root)

    // Astro executes a template expression, so an import inside it reaches
    // the module graph. The frontmatter/script scan does not see it.
    const template =
      "<div>{(await import('../struct/ids')).structId('x')}</div>\n"
    expect(importedPaths(template, astro)).toContain('../struct/ids')
    expect(e03ViolationsForSource(template, astro, publicPaths)).toHaveLength(
      1,
    )

    // An expression-valued attribute and an expression nested inside another
    // expression are executed as well.
    const attribute =
      "<Comp value={(await import('../struct/ids')).structId} />\n"
    expect(importedPaths(attribute, astro)).toContain('../struct/ids')
    expect(e03ViolationsForSource(attribute, astro, publicPaths)).toHaveLength(
      1,
    )

    const nested =
      "<div>{ok ? <span>{(await import('../struct/ids')).structId}</span> : null}</div>\n"
    expect(importedPaths(nested, astro)).toContain('../struct/ids')
    expect(e03ViolationsForSource(nested, astro, publicPaths)).toHaveLength(1)

    // A template expression that names no migrated module is not a
    // violation.
    const safe = "<div>{helper('x')}</div>\n"
    expect(importedPaths(safe, astro)).toEqual([])
    expect(e03ViolationsForSource(safe, astro, publicPaths)).toEqual([])

    // Prose, fenced and indented code samples, `<pre><code>` text, an HTML
    // comment, `<style>` CSS and script source text are not expressions, so
    // an import that appears only in their text is not collected.
    const notCode = [
      '<p>Example: import x from "../struct/ids"</p>',
      '<p>```ts\nimport x from "../struct/ids"\n```</p>',
      '<p>\n    import x from "../struct/ids"\n</p>',
      '<pre><code>import x from "../struct/ids"</code></pre>',
      '<!-- import x from "../struct/ids" -->',
      '<style>.x { background: url("../struct/ids") }</style>',
      '<script>const note = "import x from \\"../struct/ids\\""</script>',
    ].join('\n')
    expect(importedPaths(notCode, astro)).toEqual([])
    expect(e03ViolationsForSource(notCode, astro, publicPaths)).toEqual([])

    // Astro's nested JSX text is rendered text, not JavaScript, so an import
    // that appears in it is not collected.
    const jsxText =
      "<div>{ok ? <span>import x from '../struct/ids'</span> : null}</div>\n"
    expect(importedPaths(jsxText, astro)).toEqual([])
    expect(e03ViolationsForSource(jsxText, astro, publicPaths)).toEqual([])
  })

  it('E-03: treats a transitive path to the recovery authority as a violation', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const forwarder = new URL('struct/__e03_probe_legacy_recovery.ts', root)
    const direct = new URL('struct/__e03_probe_legacy_app_recovery.ts', root)
    await writeFile(forwarder.pathname, "export * from './recovery'\n", 'utf8')
    await writeFile(
      direct.pathname,
      "export * from '../struct-adapters/recovery'\n",
      'utf8',
    )
    try {
      // A retained wrapper that re-exports the compatibility forwarder
      // reaches the recovery module through the legacy facade, so it is a
      // violation for a module outside the retained tree.
      expect(
        e03ViolationsForSource(
          "import { diagnosticCopy } from '../struct/__e03_probe_legacy_recovery'",
          research,
          publicPaths,
        ),
      ).not.toEqual([])

      // A wrapper that re-exports the app-owned recovery module directly
      // reaches it as well.
      expect(
        e03ViolationsForSource(
          "import { diagnosticCopy } from '../struct/__e03_probe_legacy_app_recovery'",
          research,
          publicPaths,
        ),
      ).not.toEqual([])

      // A permitted importer of the app-owned recovery module keeps its
      // direct import.
      expect(
        e03ViolationsForSource(
          "import { diagnosticCopy } from '../struct-adapters/recovery'",
          new URL('research/recovery-projection.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(forwarder.pathname, { force: true })
      await rm(direct.pathname, { force: true })
    }
  })

  it('E-03: resolves a retained wrapper stored as a CommonJS TypeScript module', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const wrapper = new URL('struct/__e03_probe_legacy_family.cts', root)
    const familyDirectory = new URL('struct/__e03_probe_cts_family/', root)
    await mkdir(familyDirectory, { recursive: true })
    await writeFile(
      wrapper.pathname,
      "export * from './__e03_probe_cts_family'\n",
      'utf8',
    )
    await writeFile(
      new URL('index.cts', familyDirectory).pathname,
      "export * from '../types'\n",
      'utf8',
    )
    try {
      // A wrapper stored as a `.cts` module is a retained wrapper as well,
      // so an external importer of it reaches the local migrated authority.
      expect(
        e03ViolationsForSource(
          "import { T } from '../struct/__e03_probe_legacy_family'",
          research,
          publicPaths,
        ),
      ).not.toEqual([])
    } finally {
      await rm(wrapper.pathname, { force: true })
      await rm(familyDirectory.pathname, { recursive: true, force: true })
    }
  })

  it('E-03: traces a CommonJS re-export from a retained wrapper', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const wrapper = new URL('struct/__e03_probe_legacy_cjs.cjs', root)
    const propertyWrapper = new URL(
      'struct/__e03_probe_legacy_cjs_property.cts',
      root,
    )
    await writeFile(
      wrapper.pathname,
      "module.exports = require('./types')\n",
      'utf8',
    )
    await writeFile(
      propertyWrapper.pathname,
      "exports.types = require('./ids')\n",
      'utf8',
    )
    try {
      // A CommonJS wrapper re-exports the module it requires, so an importer
      // outside the retained tree reaches the local migrated authority
      // through it.
      expect(
        e03ViolationsForSource(
          "import { T } from '../struct/__e03_probe_legacy_cjs'",
          research,
          publicPaths,
        ),
      ).not.toEqual([])

      // The property form of the same re-export is traced as well.
      expect(
        e03ViolationsForSource(
          "import { structId } from '../struct/__e03_probe_legacy_cjs_property'",
          research,
          publicPaths,
        ),
      ).not.toEqual([])

      // The retained tree keeps its own wrapper.
      expect(
        e03ViolationsForSource(
          "export * from './__e03_probe_legacy_cjs'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(wrapper.pathname, { force: true })
      await rm(propertyWrapper.pathname, { force: true })
    }
  })

  it('E-03: normalises an explicit MDX extension before the wrapper traversal', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const wrapper = new URL('struct/__e03_probe_legacy_wrapper.mdx', root)
    await writeFile(wrapper.pathname, "export { T } from './types'\n", 'utf8')
    try {
      // An explicit `.mdx` suffix names the same retained wrapper as the
      // suffix-free spelling of it, so the chain is followed in both
      // spellings.
      expect(
        e03ViolationsForSource(
          "import { T } from '../struct/__e03_probe_legacy_wrapper.mdx'",
          research,
          publicPaths,
        ),
      ).not.toEqual([])
      expect(
        e03ViolationsForSource(
          "import { T } from '../struct/__e03_probe_legacy_wrapper'",
          research,
          publicPaths,
        ),
      ).not.toEqual([])

      // The retained tree keeps its own wrapper.
      expect(
        e03ViolationsForSource(
          "export { T } from './__e03_probe_legacy_wrapper.mdx'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(wrapper.pathname, { force: true })
    }
  })

  it('E-03: treats the retained barrel as a Vite glob candidate', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)

    // The retained barrel re-exports the migrated families, so a glob that
    // reaches the barrel reaches the local migrated authority as well.
    const barrel =
      "const all = import.meta.glob('../struct/index.ts', { eager: true })"
    expect(importedPaths(barrel, research)).toContain('../struct/index.ts')
    expect(
      e03ViolationsForSource(barrel, research, publicPaths),
    ).not.toEqual([])

    // A glob over the retained tree reaches the barrel as well.
    const tree = "const all = import.meta.glob('../struct/*.ts', { eager: true })"
    expect(importedPaths(tree, research)).toContain('../struct/index.ts')
    expect(e03ViolationsForSource(tree, research, publicPaths)).not.toEqual([])

    // A glob that names no module of the retained tree is not a violation.
    const safe =
      "const pages = import.meta.glob('../content/**/*.md', { eager: true })"
    expect(importedPaths(safe, research)).toEqual([])
    expect(e03ViolationsForSource(safe, research, publicPaths)).toEqual([])
  })

  it('E-03: preserves a module-free MDX ESM block for the AST scan', async () => {
    const publicPaths = await publicPackagePaths()
    const mdxProbe = new URL('research/probe.mdx', root)

    // A declaration that names no module is a declaration of the document
    // all the same, so it is preserved for the AST scan.
    expect(mdxEsmStatements('export const x = 1\n')).toContain(
      'export const x = 1',
    )

    // A preserved declaration can load a module of its own, so the require
    // it holds is a module specifier the guard has to inspect.
    const required = "export const x = require('../struct/types')\n"
    expect(mdxEsmStatements(required)).toContain("require('../struct/types')")
    expect(
      e03ViolationsForSource(required, mdxProbe, publicPaths),
    ).not.toEqual([])

    // Prose that begins with `import` is not a declaration, so it is not
    // preserved.
    expect(mdxEsmStatements('import the good stuff\n')).toEqual('')

    // A fenced code sample and an indented code sample are markdown
    // content, so neither is collected as a module specifier.
    const fenced = [
      '```js',
      "export const x = require('../struct/types')",
      '```',
      '',
    ].join('\n')
    expect(mdxEsmStatements(fenced)).toEqual('')
    expect(importedPaths(fenced, mdxProbe)).toEqual([])
    const indented = [
      "    export const x = require('../struct/types')",
      '',
    ].join('\n')
    expect(mdxEsmStatements(indented)).toEqual('')
    expect(importedPaths(indented, mdxProbe)).toEqual([])
  })

  it('E-03: traces an exported alias of an imported binding', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const wrapper = new URL('struct/__e03_probe_legacy_alias.ts', root)
    const defaultWrapper = new URL(
      'struct/__e03_probe_legacy_default.ts',
      root,
    )
    await writeFile(
      wrapper.pathname,
      "import { structId } from './ids'\nexport const id = structId\n",
      'utf8',
    )
    await writeFile(
      defaultWrapper.pathname,
      "import { structId } from './ids'\nexport default structId\n",
      'utf8',
    )
    try {
      // An exported variable that aliases an imported binding re-exports the
      // module the binding came from, so the chain is followed.
      expect(
        e03ViolationsForSource(
          "import { id } from '../struct/__e03_probe_legacy_alias'",
          research,
          publicPaths,
        ),
      ).not.toEqual([])

      // A default export that aliases an imported binding does as well.
      expect(
        e03ViolationsForSource(
          "import id from '../struct/__e03_probe_legacy_default'",
          research,
          publicPaths,
        ),
      ).not.toEqual([])

      // The retained tree keeps its own wrapper.
      expect(
        e03ViolationsForSource(
          "export { id } from './__e03_probe_legacy_alias'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(wrapper.pathname, { force: true })
      await rm(defaultWrapper.pathname, { force: true })
    }
  })

  it('E-03: normalises a worker URL query suffix before resolving the target', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)

    // Vite's worker suffix is a query of the worker URL, so it is removed
    // before the target is resolved and the worker entry is reported.
    const worker =
      "const worker = new Worker(new URL('../struct/ids.ts?worker', import.meta.url), { type: 'module' })"
    expect(importedPaths(worker, research)).toContain('../struct/ids.ts')
    expect(e03ViolationsForSource(worker, research, publicPaths)).not.toEqual(
      [],
    )

    // The inline form of the same suffix is normalised as well.
    const inline =
      "const worker = new Worker(new URL('../struct/ids.ts?worker&inline', import.meta.url), { type: 'module' })"
    expect(importedPaths(inline, research)).toContain('../struct/ids.ts')
    expect(e03ViolationsForSource(inline, research, publicPaths)).not.toEqual(
      [],
    )

    // A worker entry that names no migrated family is not a violation.
    const safe =
      "const worker = new Worker(new URL('../content/worker.ts?worker', import.meta.url), { type: 'module' })"
    expect(e03ViolationsForSource(safe, research, publicPaths)).toEqual([])
  })

  it('E-03: inspects the executable expressions of an MDX document', async () => {
    const publicPaths = await publicPackagePaths()
    const mdxProbe = new URL('research/probe.mdx', root)

    // MDX evaluates an expression while it renders the document, so a
    // dynamic import inside an expression reaches the module graph even
    // though the document declares no ESM block at all.
    const flow = [
      "{import('../struct/ids').then(({ structId }) => structId('x'))}",
      '',
    ].join('\n')
    expect(importedPaths(flow, mdxProbe)).toContain('../struct/ids')
    expect(e03ViolationsForSource(flow, mdxProbe, publicPaths)).toHaveLength(1)

    // A text expression is evaluated as well.
    const text = [
      "The identifier is {import('../struct/ids')} today.",
      '',
    ].join('\n')
    expect(importedPaths(text, mdxProbe)).toContain('../struct/ids')
    expect(e03ViolationsForSource(text, mdxProbe, publicPaths)).toHaveLength(1)

    // An expression that names no migrated module is not a violation.
    const safe = ["{helper('x')}", ''].join('\n')
    expect(importedPaths(safe, mdxProbe)).toEqual([])
    expect(e03ViolationsForSource(safe, mdxProbe, publicPaths)).toEqual([])

    // Markdown content is not an expression: a fenced code block, an
    // indented code sample, inline code and an HTML comment that show an
    // import contribute nothing.
    const notCode = [
      '```js',
      "import x from '../struct/ids'",
      '```',
      '',
      "    import x from '../struct/ids'",
      '',
      'Inline `import x from "../struct/ids"` sample.',
      '',
      '<!-- import x from "../struct/ids" -->',
      '',
    ].join('\n')
    expect(importedPaths(notCode, mdxProbe)).toEqual([])
    expect(e03ViolationsForSource(notCode, mdxProbe, publicPaths)).toEqual([])
  })

  it('E-03: fails loudly when a real MDX document cannot be parsed', async () => {
    const publicPaths = await publicPackagePaths()
    const document = new URL('research/__e03_probe_unparseable.mdx', root)
    const source = ['import the good stuff', '', 'more prose', ''].join('\n')
    await writeFile(document.pathname, source, 'utf8')
    try {
      // A document the MDX parser refuses is a document the guard cannot
      // scan safely, so the guard fails loudly instead of skipping it.
      expect(() => importedPaths(source, document)).toThrow(
        /MDX document could not be parsed/,
      )
      expect(() =>
        e03ViolationsForSource(source, document, publicPaths),
      ).toThrow(/MDX document could not be parsed/)
    } finally {
      await rm(document.pathname, { force: true })
    }
  })

  it('E-03: inspects the MDX JSX attribute expressions of an MDX document', async () => {
    const publicPaths = await publicPackagePaths()
    const mdxProbe = new URL('research/probe.mdx', root)

    // MDX evaluates the expression of a JSX attribute value while it renders
    // the document, so a dynamic import in an attribute reaches the module
    // graph even though the document declares no ESM block at all.
    const attribute = ["<Foo bar={import('../struct/ids')} />", ''].join('\n')
    expect(importedPaths(attribute, mdxProbe)).toEqual(['../struct/ids'])
    expect(e03ViolationsForSource(attribute, mdxProbe, publicPaths)).toHaveLength(
      1,
    )

    // The spread form of an attribute is evaluated as well.
    const spread = ["<Foo {...import('../struct/ids')} />", ''].join('\n')
    expect(importedPaths(spread, mdxProbe)).toEqual(['../struct/ids'])
    expect(e03ViolationsForSource(spread, mdxProbe, publicPaths)).toHaveLength(1)

    // An attribute expression that names no migrated module is not a
    // violation.
    const safe = ["<Foo bar={helper('x')} />", ''].join('\n')
    expect(importedPaths(safe, mdxProbe)).toEqual([])
    expect(e03ViolationsForSource(safe, mdxProbe, publicPaths)).toEqual([])

    // A plain attribute value is a string the document renders, so an import
    // that appears only in its text is not collected.
    const plain = ["<Foo bar=\"import x from '../struct/ids'\" />", ''].join(
      '\n',
    )
    expect(importedPaths(plain, mdxProbe)).toEqual([])
    expect(e03ViolationsForSource(plain, mdxProbe, publicPaths)).toEqual([])

    // Markdown content is not an expression: a fenced code block, an indented
    // code sample, inline code and an HTML comment that show an import
    // contribute nothing, and the JSX text of an element is rendered text.
    const notCode = [
      '```js',
      "import x from '../struct/ids'",
      '```',
      '',
      "    import x from '../struct/ids'",
      '',
      'Inline `import x from "../struct/ids"` sample.',
      '',
      '<!-- import x from "../struct/ids" -->',
      '',
      "<Foo>import x from '../struct/ids'</Foo>",
      '',
    ].join('\n')
    expect(importedPaths(notCode, mdxProbe)).toEqual([])
    expect(e03ViolationsForSource(notCode, mdxProbe, publicPaths)).toEqual([])
  })

  it('E-03: traces a CommonJS export assignment from a retained wrapper', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const wrapper = new URL(
      'struct/__e03_probe_legacy_export_require.cts',
      root,
    )
    const computed = new URL(
      'struct/__e03_probe_legacy_export_computed.cts',
      root,
    )
    await writeFile(wrapper.pathname, "export = require('./types')\n", 'utf8')
    await writeFile(
      computed.pathname,
      'export = require(pathVariable)\n',
      'utf8',
    )
    try {
      // `export = require('./types')` re-exports the required module, so an
      // importer outside the retained tree reaches the local migrated
      // authority through the wrapper.
      expect(
        e03ViolationsForSource(
          "import { T } from '../struct/__e03_probe_legacy_export_require'",
          research,
          publicPaths,
        ),
      ).not.toEqual([])

      // A computed re-export names no literal target, so the guard cannot
      // prove that it does not reach a migrated family. It fails closed in
      // the same way a computed require does.
      expect(
        e03ViolationsForSource(
          "import { T } from '../struct/__e03_probe_legacy_export_computed'",
          research,
          publicPaths,
        ),
      ).not.toEqual([])

      // The retained tree keeps its own wrapper.
      expect(
        e03ViolationsForSource(
          "export * from './__e03_probe_legacy_export_require'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(wrapper.pathname, { force: true })
      await rm(computed.pathname, { force: true })
    }
  })

  it('E-03: reads the script bodies of an Astro component from its AST', async () => {
    const publicPaths = await publicPackagePaths()
    const astro = new URL('components/probe.astro', root)

    // A script element is a script element: Astro runs its body, so an
    // import in it reaches the module graph.
    const script = ["<script>import x from '../struct/ids'</script>", ''].join(
      '\n',
    )
    expect(importedPaths(script, astro)).toContain('../struct/ids')
    expect(e03ViolationsForSource(script, astro, publicPaths)).toHaveLength(1)

    // A script element inside a `<pre>` or a `<code>` sample is hoisted and
    // executed by Astro: the compiler takes it out of the sample and hoists
    // it exactly like a top-level script, so its body is JavaScript the
    // component runs and the guard scans it.
    for (const hoisted of [
      '<pre><script>import x from "../struct/ids"</script></pre>\n',
      '<code><script>import x from "../struct/ids"</script></code>\n',
    ]) {
      expect(importedPaths(hoisted, astro)).toEqual(['../struct/ids'])
      expect(e03ViolationsForSource(hoisted, astro, publicPaths)).toHaveLength(1)
    }

    // An HTML comment and an escaped `<pre>` sample are not script elements,
    // so Astro never runs them and the guard does not scan them. Each example
    // on its own contributes nothing.
    for (const sample of [
      '<!-- <script>import x from "../struct/ids"</script> -->\n',
      '<pre>&lt;script&gt;import x from "../struct/ids"&lt;/script&gt;</pre>\n',
    ]) {
      expect(importedPaths(sample, astro)).toEqual([])
      expect(e03ViolationsForSource(sample, astro, publicPaths)).toEqual([])
    }

    // The same holds when the examples share one component.
    const notScript = [
      '<!-- <script>import x from "../struct/ids"</script> -->',
      '<pre>&lt;script&gt;import x from "../struct/ids"&lt;/script&gt;</pre>',
      '',
    ].join('\n')
    expect(importedPaths(notScript, astro)).toEqual([])
    expect(e03ViolationsForSource(notScript, astro, publicPaths)).toEqual([])

    // A hoisted sample script shares the component with the comment: the
    // comment contributes nothing, the hoisted script is the one violation.
    const hoistedScript = [
      '<!-- <script>import x from "../struct/ids"</script> -->',
      '<pre><script>import x from "../struct/ids"</script></pre>',
      '',
    ].join('\n')
    expect(importedPaths(hoistedScript, astro)).toEqual(['../struct/ids'])
    expect(
      e03ViolationsForSource(hoistedScript, astro, publicPaths),
    ).toHaveLength(1)

    // A frontmatter string that shows a script is not a script element
    // either. The frontmatter itself is module code, so it is still scanned.
    const frontmatter = [
      '---',
      'const note = `<script>import x from "../struct/ids"</script>`',
      '---',
      '<div>Example</div>',
      '',
    ].join('\n')
    expect(importedPaths(frontmatter, astro)).toEqual([])
    expect(e03ViolationsForSource(frontmatter, astro, publicPaths)).toEqual([])

    // An inline script is not processed by Astro, but the browser runs it,
    // so its body is scanned as well.
    const inline = [
      "<script is:inline>import x from '../struct/ids'</script>",
      '',
    ].join('\n')
    expect(importedPaths(inline, astro)).toContain('../struct/ids')
    expect(e03ViolationsForSource(inline, astro, publicPaths)).toHaveLength(1)
  })

  it('E-03: traces an exported expression that uses an imported binding', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const arrow = new URL('struct/__e03_probe_legacy_arrow.ts', root)
    const declared = new URL('struct/__e03_probe_legacy_function.ts', root)
    const called = new URL('struct/__e03_probe_legacy_call.ts', root)
    const held = new URL('struct/__e03_probe_legacy_object.ts', root)
    const defaulted = new URL(
      'struct/__e03_probe_legacy_default_expression.ts',
      root,
    )
    const local = new URL('struct/__e03_probe_legacy_local.ts', root)
    await writeFile(
      arrow.pathname,
      "import { structId } from './ids'\nexport const legacyId = (value) => structId('legacy', value)\n",
      'utf8',
    )
    await writeFile(
      declared.pathname,
      "import { structId } from './ids'\nexport function legacyId(value) { return structId('legacy', value) }\n",
      'utf8',
    )
    await writeFile(
      called.pathname,
      "import { structId } from './ids'\nexport const legacyId = structId('legacy', 'seed')\n",
      'utf8',
    )
    await writeFile(
      held.pathname,
      "import { structId } from './ids'\nexport const legacy = { id: structId }\n",
      'utf8',
    )
    await writeFile(
      defaulted.pathname,
      "import { structId } from './ids'\nexport default structId('legacy', 'seed')\n",
      'utf8',
    )
    await writeFile(
      local.pathname,
      'const localId = (value) => value\nexport const legacyId = localId\n',
      'utf8',
    )
    try {
      // An exported arrow function that uses an imported binding reaches the
      // module the binding came from, so an importer outside the retained
      // tree reaches the local identity authority through the wrapper.
      expect(
        e03ViolationsForSource(
          "import { legacyId } from '../struct/__e03_probe_legacy_arrow'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // An exported function declaration that uses an imported binding does
      // as well.
      expect(
        e03ViolationsForSource(
          "import { legacyId } from '../struct/__e03_probe_legacy_function'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // An exported call that uses an imported binding does as well.
      expect(
        e03ViolationsForSource(
          "import { legacyId } from '../struct/__e03_probe_legacy_call'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // An exported object literal that holds an imported binding does as
      // well.
      expect(
        e03ViolationsForSource(
          "import { legacy } from '../struct/__e03_probe_legacy_object'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // An exported default expression that uses an imported binding does as
      // well.
      expect(
        e03ViolationsForSource(
          "import legacyId from '../struct/__e03_probe_legacy_default_expression'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // A binding the module defines itself reaches no other module, so it
      // is not a re-export target.
      expect(
        e03ViolationsForSource(
          "import { legacyId } from '../struct/__e03_probe_legacy_local'",
          research,
          publicPaths,
        ),
      ).toEqual([])

      // The retained tree keeps its own wrapper.
      expect(
        e03ViolationsForSource(
          "export { legacyId } from './__e03_probe_legacy_arrow'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(arrow.pathname, { force: true })
      await rm(declared.pathname, { force: true })
      await rm(called.pathname, { force: true })
      await rm(held.pathname, { force: true })
      await rm(defaulted.pathname, { force: true })
      await rm(local.pathname, { force: true })
    }
  })

  it('E-03: resolves a Vite glob pattern against a literal base option', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)

    // Vite resolves a relative glob pattern from the resolved base, so the
    // pattern reaches the migrated family the base names.
    const based =
      "const codecs = import.meta.glob('./struct/codec.ts', { eager: true, base: '/src' })"
    expect(importedPaths(based, research)).toContain('../struct/codec.ts')
    const basedViolations = e03ViolationsForSource(
      based,
      research,
      publicPaths,
    )
    expect(basedViolations).not.toEqual([])
    expect(basedViolations.join('\n')).toContain('migrated family import')
    // The family file is reported twice: once as the migrated family the glob
    // reaches, and once by the wrapper rule, which reports the same target
    // for every import of a retained-tree module.
    expect(basedViolations).toHaveLength(2)

    // A glob that reaches the identity family is reported once, because the
    // identity module re-exports no other family.
    const identity =
      "const ids = import.meta.glob('./struct/ids.ts', { eager: true, base: '/src' })"
    expect(importedPaths(identity, research)).toContain('../struct/ids.ts')
    expect(
      e03ViolationsForSource(identity, research, publicPaths),
    ).toHaveLength(1)

    // The same pattern without a base is still resolved against the
    // directory of the importing module, so it names no migrated family.
    const withoutBase =
      "const codecs = import.meta.glob('./struct/codec.ts', { eager: true })"
    expect(importedPaths(withoutBase, research)).toEqual([])
    expect(
      e03ViolationsForSource(withoutBase, research, publicPaths),
    ).toEqual([])

    // A project-root pattern is still normalised against the project root,
    // whatever base the call names.
    const rootAbsolute =
      "const codecs = import.meta.glob('/src/struct/codec.ts', { eager: true, base: '/src' })"
    expect(importedPaths(rootAbsolute, research)).toContain(
      '../struct/codec.ts',
    )
    expect(
      e03ViolationsForSource(rootAbsolute, research, publicPaths),
    ).not.toEqual([])

    // An alias pattern is still normalised through the alias, whatever base
    // the call names.
    const aliased =
      "const codecs = import.meta.glob('@/struct/codec.ts', { eager: true, base: '/src' })"
    expect(importedPaths(aliased, research)).toContain('../struct/codec.ts')
    expect(
      e03ViolationsForSource(aliased, research, publicPaths),
    ).not.toEqual([])

    // A base that names an absolute directory is used as it is, so the
    // pattern reaches the family it names.
    const absoluteBase = `const ids = import.meta.glob('./struct/ids.ts', { eager: true, base: '${new URL('src/', projectRoot).pathname}' })`
    expect(importedPaths(absoluteBase, research)).toContain(
      '../struct/ids.ts',
    )
    expect(
      e03ViolationsForSource(absoluteBase, research, publicPaths),
    ).toHaveLength(1)

    // A relative base is resolved against the directory of the importing
    // module, so the pattern reaches the family it names.
    const relativeBase =
      "const ids = import.meta.glob('./struct/ids.ts', { eager: true, base: '..' })"
    expect(importedPaths(relativeBase, research)).toContain(
      '../struct/ids.ts',
    )
    expect(
      e03ViolationsForSource(relativeBase, research, publicPaths),
    ).toHaveLength(1)

    // A base that names no migrated family is not a violation.
    const safeBase =
      "const pages = import.meta.glob('./pages/*.ts', { eager: true, base: '/src' })"
    expect(importedPaths(safeBase, research)).toEqual([])
    expect(e03ViolationsForSource(safeBase, research, publicPaths)).toEqual([])

    // A computed glob pattern still fails closed.
    const computed = 'const all = import.meta.glob(pattern, { eager: true })'
    const computedViolations = e03ViolationsForSource(
      computed,
      research,
      publicPaths,
    )
    expect(computedViolations).not.toEqual([])
    expect(computedViolations.join('\n')).toContain('computed glob')

    // A base that is not a literal fails closed as well, because the guard
    // cannot prove which directory the pattern is resolved from.
    const computedBase =
      'const all = import.meta.glob(\'./struct/codec.ts\', { eager: true, base: someBase })'
    const computedBaseViolations = e03ViolationsForSource(
      computedBase,
      research,
      publicPaths,
    )
    expect(computedBaseViolations).not.toEqual([])
    expect(computedBaseViolations.join('\n')).toContain('computed glob')
  })

  it('E-03: matches a Vite glob pattern with the glob matcher Vite uses', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)

    // A character class is a valid Vite glob: `types.[t]s` names `types.ts`,
    // and the bundler resolves the eager import to the retained local
    // implementation, so the guard has to resolve the pattern the way the
    // bundler resolves it.
    const characterClass =
      "const types = import.meta.glob('../struct/types.[t]s', { eager: true })"
    expect(importedPaths(characterClass, research)).toContain(
      '../struct/types.ts',
    )
    const characterClassViolations = e03ViolationsForSource(
      characterClass,
      research,
      publicPaths,
    )
    expect(characterClassViolations).toHaveLength(1)
    expect(characterClassViolations.join('\n')).toContain(
      'migrated family import',
    )

    // A brace alternation names the same module, and so does a negated
    // class.
    const brace =
      "const types = import.meta.glob('../struct/types.{ts,tsx}', { eager: true })"
    expect(importedPaths(brace, research)).toContain('../struct/types.ts')
    expect(e03ViolationsForSource(brace, research, publicPaths)).toHaveLength(1)

    const negatedClass =
      "const types = import.meta.glob('../struct/types.[!x]s', { eager: true })"
    expect(importedPaths(negatedClass, research)).toContain(
      '../struct/types.ts',
    )
    expect(
      e03ViolationsForSource(negatedClass, research, publicPaths),
    ).toHaveLength(1)

    // A character class that names another family reaches that family as
    // well.
    const codecClass =
      "const codecs = import.meta.glob('../struct/[ct]odec.ts', { eager: true })"
    expect(importedPaths(codecClass, research)).toContain('../struct/codec.ts')
    expect(
      e03ViolationsForSource(codecClass, research, publicPaths),
    ).toHaveLength(2)

    // The class is not one spelling only: a project-root pattern and an
    // alias pattern that carry it reach the family as well.
    const rootAbsolute =
      "const types = import.meta.glob('/src/struct/types.[t]s', { eager: true })"
    expect(importedPaths(rootAbsolute, research)).toContain(
      '../struct/types.ts',
    )
    expect(
      e03ViolationsForSource(rootAbsolute, research, publicPaths),
    ).toHaveLength(1)

    const aliased =
      "const types = import.meta.glob('@/struct/types.[t]s', { eager: true })"
    expect(importedPaths(aliased, research)).toContain('../struct/types.ts')
    expect(e03ViolationsForSource(aliased, research, publicPaths)).toHaveLength(
      1,
    )

    // A literal base still resolves the pattern from the base it names.
    const based =
      "const types = import.meta.glob('./struct/types.[t]s', { eager: true, base: '/src' })"
    expect(importedPaths(based, research)).toContain('../struct/types.ts')
    expect(e03ViolationsForSource(based, research, publicPaths)).toHaveLength(
      1,
    )

    // A negated class that excludes the family names no migrated family, so
    // it is not a violation.
    const excluding =
      "const types = import.meta.glob('../struct/types.[!t]s', { eager: true })"
    expect(importedPaths(excluding, research)).toEqual([])
    expect(e03ViolationsForSource(excluding, research, publicPaths)).toEqual([])

    // A pattern that names no migrated family is not a violation either.
    const safe =
      "const pages = import.meta.glob('../content/**/*.md', { eager: true })"
    expect(importedPaths(safe, research)).toEqual([])
    expect(e03ViolationsForSource(safe, research, publicPaths)).toEqual([])

    // A computed glob pattern still fails closed.
    const computed = 'const all = import.meta.glob(pattern, { eager: true })'
    const computedViolations = e03ViolationsForSource(
      computed,
      research,
      publicPaths,
    )
    expect(computedViolations).not.toEqual([])
    expect(computedViolations.join('\n')).toContain('computed glob')
  })

  it('E-03: does not scan the body of a non-JavaScript Astro script', async () => {
    const publicPaths = await publicPackagePaths()
    const astro = new URL('components/probe.astro', root)

    // A script element whose type is not a JavaScript type is a data block:
    // Astro never executes it, so an import in its body reaches no module
    // and is not a boundary escape.
    for (const type of [
      'text/plain',
      'application/json',
      'text/x-component',
      'application/ld+json',
    ]) {
      const data = `<script type="${type}">import x from '../struct/ids'</script>`
      expect(importedPaths(data, astro)).toEqual([])
      expect(e03ViolationsForSource(data, astro, publicPaths)).toEqual([])
    }

    // A module script is executed, so its body is scanned - and so is the
    // body of an inline script, which the browser runs.
    for (const script of [
      "<script>import x from '../struct/ids'</script>",
      '<script type="module">import x from "../struct/ids"</script>',
      '<script type="text/javascript">import x from "../struct/ids"</script>',
      '<script type="application/javascript">import x from "../struct/ids"</script>',
      "<script is:inline>import x from '../struct/ids'</script>",
    ]) {
      expect(importedPaths(script, astro)).toContain('../struct/ids')
      expect(e03ViolationsForSource(script, astro, publicPaths)).toHaveLength(1)
    }

    // A data block and a module script in one component: only the module
    // script is JavaScript the component runs.
    const mixed = [
      "<script type=\"text/plain\">import x from '../struct/ids'</script>",
      "<script type=\"module\">import y from '../struct/types'</script>",
      '',
    ].join('\n')
    expect(importedPaths(mixed, astro)).toEqual(['../struct/types'])
    expect(e03ViolationsForSource(mixed, astro, publicPaths)).toHaveLength(1)

    // A data block names no module Astro bundles either.
    const dataSource = [
      '<script type="application/json" src="../struct/ids.ts"></script>',
      '',
    ].join('\n')
    expect(importedPaths(dataSource, astro)).toEqual([])
    expect(e03ViolationsForSource(dataSource, astro, publicPaths)).toEqual([])

    // A type the guard cannot read is scanned, because the guard cannot
    // prove that the body is not JavaScript.
    const computedType = [
      "<script type={someType}>import x from '../struct/ids'</script>",
      '',
    ].join('\n')
    expect(importedPaths(computedType, astro)).toContain('../struct/ids')
    expect(e03ViolationsForSource(computedType, astro, publicPaths)).toHaveLength(
      1,
    )
  })

  it('E-03: ends an MDX statement with the parser, not with a brace count', async () => {
    const publicPaths = await publicPackagePaths()
    const mdxProbe = new URL('research/probe.mdx', root)

    // A declaration that carries an unmatched brace inside a string is a
    // finished declaration: the TypeScript parser accepts it as one. A count
    // of the brace characters does not know that, so the scanner used to keep
    // the declaration open, absorb the markdown that follows it and the
    // import after it, and drop the whole block at the end of the document -
    // which let the migrated-family import pass the guard.
    const withString = [
      "export const marker = '{'",
      '',
      'The marker is a brace.',
      '',
      "import { T } from '@/struct/types'",
      '',
    ].join('\n')
    expect(importedPaths(withString, mdxProbe)).toEqual(['@/struct/types'])
    expect(
      e03ViolationsForSource(withString, mdxProbe, publicPaths),
    ).not.toEqual([])

    // A declaration that carries an unmatched brace inside a comment is a
    // finished declaration as well.
    const withComment = [
      'export const marker = 1 // {',
      '',
      "import { T } from '@/struct/types'",
      '',
    ].join('\n')
    expect(importedPaths(withComment, mdxProbe)).toEqual(['@/struct/types'])
    expect(
      e03ViolationsForSource(withComment, mdxProbe, publicPaths),
    ).not.toEqual([])

    // The declarations the scanner collected before are still collected: a
    // module-free declaration, a declaration that names a module and a
    // declaration that spans several lines.
    expect(mdxEsmStatements('export const x = 1\n')).toContain(
      'export const x = 1',
    )
    expect(mdxEsmStatements("import { T } from '@/struct/types'\n")).toContain(
      "import { T } from '@/struct/types'",
    )
    const multiline = ['export const meta = {', "  title: 'x',", '}', ''].join(
      '\n',
    )
    expect(mdxEsmStatements(multiline)).toContain("title: 'x',")

    // A fenced code block, an indented code sample and prose are markdown
    // content, so none of them is collected.
    expect(
      mdxEsmStatements(
        ['```js', "import { T } from '@/struct/types'", '```', ''].join('\n'),
      ),
    ).toEqual('')
    expect(
      mdxEsmStatements(
        ["    import { T } from '@/struct/types'", ''].join('\n'),
      ),
    ).toEqual('')
    expect(mdxEsmStatements('import the good stuff\n')).toEqual('')
  })

  it('E-03: traces an exported class whose member uses an imported binding', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const method = new URL('struct/__e03_probe_legacy_class_method.ts', root)
    const field = new URL('struct/__e03_probe_legacy_class_field.ts', root)
    const staticBlock = new URL(
      'struct/__e03_probe_legacy_class_static.ts',
      root,
    )
    const computed = new URL(
      'struct/__e03_probe_legacy_class_computed.ts',
      root,
    )
    const local = new URL('struct/__e03_probe_legacy_class_local.ts', root)
    await writeFile(
      method.pathname,
      "import { structId } from './ids'\nexport class Legacy {\n  id(value: string) {\n    return structId('legacy', value)\n  }\n}\n",
      'utf8',
    )
    await writeFile(
      field.pathname,
      "import { structId } from './ids'\nexport class Legacy {\n  id = structId('legacy', 'seed')\n}\n",
      'utf8',
    )
    await writeFile(
      staticBlock.pathname,
      "import { structId } from './ids'\nexport class Legacy {\n  static {\n    Legacy.seed = structId('legacy', 'seed')\n  }\n}\n",
      'utf8',
    )
    await writeFile(
      computed.pathname,
      "import { structId } from './ids'\nconst key = 'id'\nexport class Legacy {\n  [key]() {\n    return structId('legacy', 'seed')\n  }\n}\n",
      'utf8',
    )
    await writeFile(
      local.pathname,
      "const localId = (value: string) => value\nexport class Legacy {\n  id(value: string) {\n    return localId(value)\n  }\n}\n",
      'utf8',
    )
    try {
      // A method of an exported class that uses an imported binding reaches
      // the module the binding came from, so an importer outside the
      // retained tree reaches the local identity authority through the
      // wrapper.
      expect(
        e03ViolationsForSource(
          "import { Legacy } from '../struct/__e03_probe_legacy_class_method'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // A field initializer of an exported class does as well.
      expect(
        e03ViolationsForSource(
          "import { Legacy } from '../struct/__e03_probe_legacy_class_field'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // A static block of an exported class does as well.
      expect(
        e03ViolationsForSource(
          "import { Legacy } from '../struct/__e03_probe_legacy_class_static'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // A computed member of an exported class does as well.
      expect(
        e03ViolationsForSource(
          "import { Legacy } from '../struct/__e03_probe_legacy_class_computed'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // A binding the module defines itself reaches no other module, so it
      // is not a re-export target.
      expect(
        e03ViolationsForSource(
          "import { Legacy } from '../struct/__e03_probe_legacy_class_local'",
          research,
          publicPaths,
        ),
      ).toEqual([])

      // The retained tree keeps its own wrapper.
      expect(
        e03ViolationsForSource(
          "export { Legacy } from './__e03_probe_legacy_class_method'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(method.pathname, { force: true })
      await rm(field.pathname, { force: true })
      await rm(staticBlock.pathname, { force: true })
      await rm(computed.pathname, { force: true })
      await rm(local.pathname, { force: true })
    }
  })

  it('E-03: traces a CommonJS re-export that reads a member of a required module', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const property = new URL(
      'struct/__e03_probe_legacy_cjs_member.cjs',
      root,
    )
    const element = new URL(
      'struct/__e03_probe_legacy_cjs_element.cjs',
      root,
    )
    await writeFile(
      property.pathname,
      "module.exports = require('./ids').structId\n",
      'utf8',
    )
    await writeFile(
      element.pathname,
      "module.exports = require('./ids')['structId']\n",
      'utf8',
    )
    try {
      // A CommonJS re-export that reads a member of the required module
      // re-exports that module, so an importer outside the retained tree
      // reaches the local migrated authority through the wrapper.
      expect(
        e03ViolationsForSource(
          "import { structId } from '../struct/__e03_probe_legacy_cjs_member'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // The element-access spelling of the same re-export is traced as
      // well.
      expect(
        e03ViolationsForSource(
          "import { structId } from '../struct/__e03_probe_legacy_cjs_element'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // The retained tree keeps its own wrapper.
      expect(
        e03ViolationsForSource(
          "export * from './__e03_probe_legacy_cjs_member'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(property.pathname, { force: true })
      await rm(element.pathname, { force: true })
    }
  })

  it('E-03: fails closed on a computed CommonJS re-export', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const computed = new URL(
      'struct/__e03_probe_legacy_cjs_computed.cjs',
      root,
    )
    const property = new URL(
      'struct/__e03_probe_legacy_cjs_computed_property.cjs',
      root,
    )
    await writeFile(
      computed.pathname,
      'module.exports = require(target)\n',
      'utf8',
    )
    await writeFile(
      property.pathname,
      'exports.value = require(target)\n',
      'utf8',
    )
    try {
      // A computed CommonJS re-export names no literal target, so the guard
      // cannot prove that it does not reach a migrated family. It fails
      // closed in the same way a computed require does. Two chains report
      // the same sentinel: the migrated-family chain and the recovery chain.
      const moduleForm = e03ViolationsForSource(
        "import { value } from '../struct/__e03_probe_legacy_cjs_computed'",
        research,
        publicPaths,
      )
      expect(moduleForm).toHaveLength(2)
      expect(moduleForm.join('\n')).toContain('unresolved re-export')

      // The property form of the same re-export fails closed as well.
      const propertyForm = e03ViolationsForSource(
        "import { value } from '../struct/__e03_probe_legacy_cjs_computed_property'",
        research,
        publicPaths,
      )
      expect(propertyForm).toHaveLength(2)
      expect(propertyForm.join('\n')).toContain('unresolved re-export')

      // The retained tree's own use of the same form is not reported.
      expect(
        e03ViolationsForSource(
          "import { value } from './__e03_probe_legacy_cjs_computed'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(computed.pathname, { force: true })
      await rm(property.pathname, { force: true })
    }
  })

  it('E-03: traces a CommonJS re-export that names a property of module.exports', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const moduleProperty = new URL(
      'struct/__e03_probe_legacy_cjs_module_property.cjs',
      root,
    )
    const moduleElement = new URL(
      'struct/__e03_probe_legacy_cjs_module_element.cjs',
      root,
    )
    const moduleNested = new URL(
      'struct/__e03_probe_legacy_cjs_module_nested.cjs',
      root,
    )
    const exportsProperty = new URL(
      'struct/__e03_probe_legacy_cjs_exports_property.cjs',
      root,
    )
    const moduleComputed = new URL(
      'struct/__e03_probe_legacy_cjs_module_computed.cjs',
      root,
    )
    await writeFile(
      moduleProperty.pathname,
      "module.exports.api = require('./types')\n",
      'utf8',
    )
    await writeFile(
      moduleElement.pathname,
      "module.exports['api'] = require('./types')\n",
      'utf8',
    )
    await writeFile(
      moduleNested.pathname,
      "module.exports.api.types = require('./types')\n",
      'utf8',
    )
    await writeFile(
      exportsProperty.pathname,
      "exports.api = require('./types')\n",
      'utf8',
    )
    await writeFile(
      moduleComputed.pathname,
      'module.exports.api = require(target)\n',
      'utf8',
    )
    try {
      // The ordinary named-export form of a CommonJS wrapper re-exports the
      // module it requires, so an importer outside the retained tree reaches
      // the local migrated authority through the wrapper.
      expect(
        e03ViolationsForSource(
          "import { api } from '../struct/__e03_probe_legacy_cjs_module_property'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // The element-access spelling of the same re-export is traced as well.
      expect(
        e03ViolationsForSource(
          "import { api } from '../struct/__e03_probe_legacy_cjs_module_element'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // The nested property access of the same re-export is traced as well.
      expect(
        e03ViolationsForSource(
          "import { api } from '../struct/__e03_probe_legacy_cjs_module_nested'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // The `exports` spelling of the same re-export is traced as well.
      expect(
        e03ViolationsForSource(
          "import { api } from '../struct/__e03_probe_legacy_cjs_exports_property'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // A computed require in the same position names no literal target, so
      // it fails closed with the same sentinel the direct-import path uses.
      // Two chains report the same sentinel: the migrated-family chain and
      // the recovery chain.
      const computedForm = e03ViolationsForSource(
        "import { api } from '../struct/__e03_probe_legacy_cjs_module_computed'",
        research,
        publicPaths,
      )
      expect(computedForm).toHaveLength(2)
      expect(computedForm.join('\n')).toContain('unresolved re-export')

      // The retained tree keeps its own wrapper.
      expect(
        e03ViolationsForSource(
          "export * from './__e03_probe_legacy_cjs_module_property'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(moduleProperty.pathname, { force: true })
      await rm(moduleElement.pathname, { force: true })
      await rm(moduleNested.pathname, { force: true })
      await rm(exportsProperty.pathname, { force: true })
      await rm(moduleComputed.pathname, { force: true })
    }
  })

  it('E-03: traces a require-bound alias that a retained wrapper re-exports', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const named = new URL('struct/__e03_probe_legacy_require_named.cts', root)
    const defaultExport = new URL(
      'struct/__e03_probe_legacy_require_default.cts',
      root,
    )
    const exportedVariable = new URL(
      'struct/__e03_probe_legacy_require_variable.cts',
      root,
    )
    const exportedArrow = new URL(
      'struct/__e03_probe_legacy_require_arrow.cts',
      root,
    )
    const destructured = new URL(
      'struct/__e03_probe_legacy_require_destructured.cts',
      root,
    )
    const member = new URL('struct/__e03_probe_legacy_require_member.cts', root)
    const importAlias = new URL(
      'struct/__e03_probe_legacy_require_import_alias.cts',
      root,
    )
    const exportAlias = new URL(
      'struct/__e03_probe_legacy_require_export_alias.cts',
      root,
    )
    const computed = new URL(
      'struct/__e03_probe_legacy_require_computed.cts',
      root,
    )
    await writeFile(
      named.pathname,
      "const Types = require('./types')\nexport { Types }\n",
      'utf8',
    )
    await writeFile(
      defaultExport.pathname,
      "const Types = require('./types')\nexport default Types\n",
      'utf8',
    )
    await writeFile(
      exportedVariable.pathname,
      "const Types = require('./types')\nexport const t = Types\n",
      'utf8',
    )
    await writeFile(
      exportedArrow.pathname,
      "const Types = require('./types')\nexport const t = () => Types\n",
      'utf8',
    )
    await writeFile(
      destructured.pathname,
      "const { structId } = require('./ids')\nexport { structId }\n",
      'utf8',
    )
    await writeFile(
      member.pathname,
      "const structId = require('./ids').structId\nexport { structId }\n",
      'utf8',
    )
    await writeFile(
      importAlias.pathname,
      "import Types = require('./types')\nexport { Types }\n",
      'utf8',
    )
    await writeFile(
      exportAlias.pathname,
      "export import Types = require('./types')\n",
      'utf8',
    )
    await writeFile(
      computed.pathname,
      "const Types = require(target)\nexport { Types }\n",
      'utf8',
    )
    try {
      // A binding a require binds is an imported binding, so a wrapper that
      // hands it out re-exports the module it came from, and an importer
      // outside the retained tree reaches the local migrated authority
      // through the wrapper.
      expect(
        e03ViolationsForSource(
          "import { Types } from '../struct/__e03_probe_legacy_require_named'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // The default-export spelling of the same re-export is traced as well.
      expect(
        e03ViolationsForSource(
          "import Types from '../struct/__e03_probe_legacy_require_default'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // The exported-variable spelling of the same re-export is traced as
      // well.
      expect(
        e03ViolationsForSource(
          "import { t } from '../struct/__e03_probe_legacy_require_variable'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // The exported-expression spelling of the same re-export is traced as
      // well.
      expect(
        e03ViolationsForSource(
          "import { t } from '../struct/__e03_probe_legacy_require_arrow'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // A destructuring pattern binds every name it names, so the
      // destructuring spelling of the same re-export is traced as well.
      expect(
        e03ViolationsForSource(
          "import { structId } from '../struct/__e03_probe_legacy_require_destructured'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // A binding that reads a member of the required module is bound to
      // that module as well, so the member spelling is traced as well.
      expect(
        e03ViolationsForSource(
          "import { structId } from '../struct/__e03_probe_legacy_require_member'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // The TypeScript import alias is a binding of a required module as
      // well, so the alias spelling is traced as well.
      expect(
        e03ViolationsForSource(
          "import { Types } from '../struct/__e03_probe_legacy_require_import_alias'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // The exported TypeScript import alias re-exports the required module
      // itself, so the exported-alias spelling is traced as well.
      expect(
        e03ViolationsForSource(
          "import { Types } from '../struct/__e03_probe_legacy_require_export_alias'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // A computed require in a variable initialiser names no literal
      // target, so it fails closed with the same sentinel the direct-import
      // path uses. Two chains report the same sentinel: the migrated-family
      // chain and the recovery chain.
      const computedForm = e03ViolationsForSource(
        "import { Types } from '../struct/__e03_probe_legacy_require_computed'",
        research,
        publicPaths,
      )
      expect(computedForm).toHaveLength(2)
      expect(computedForm.join('\n')).toContain('unresolved re-export')

      // The retained tree keeps its own wrapper.
      expect(
        e03ViolationsForSource(
          "export * from './__e03_probe_legacy_require_named'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(named.pathname, { force: true })
      await rm(defaultExport.pathname, { force: true })
      await rm(exportedVariable.pathname, { force: true })
      await rm(exportedArrow.pathname, { force: true })
      await rm(destructured.pathname, { force: true })
      await rm(member.pathname, { force: true })
      await rm(importAlias.pathname, { force: true })
      await rm(exportAlias.pathname, { force: true })
      await rm(computed.pathname, { force: true })
    }
  })

  it('E-03: traces an exported enum whose member uses an imported binding', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const member = new URL('struct/__e03_probe_legacy_enum_member.ts', root)
    const computed = new URL('struct/__e03_probe_legacy_enum_computed.ts', root)
    const call = new URL('struct/__e03_probe_legacy_enum_call.ts', root)
    const local = new URL('struct/__e03_probe_legacy_enum_local.ts', root)
    await writeFile(
      member.pathname,
      "import { structId } from './ids'\nexport enum Legacy {\n  IdLength = structId('legacy', 'x').length,\n}\n",
      'utf8',
    )
    await writeFile(
      computed.pathname,
      "import { structId } from './ids'\nconst key = 'legacy'\nexport enum Legacy {\n  [key] = structId('legacy', 'x'),\n}\n",
      'utf8',
    )
    await writeFile(
      call.pathname,
      "import * as ids from './ids'\nexport enum Legacy {\n  Seed = ids.structId('legacy', 'x'),\n}\n",
      'utf8',
    )
    await writeFile(
      local.pathname,
      "const legacyId = (value: string) => value\nexport enum Legacy {\n  Seed = legacyId('x'),\n}\n",
      'utf8',
    )
    try {
      // A member of an exported enum that uses an imported binding reaches
      // the module the binding came from, so an importer outside the retained
      // tree reaches the local identity authority through the wrapper.
      expect(
        e03ViolationsForSource(
          "import { Legacy } from '../struct/__e03_probe_legacy_enum_member'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // A computed member of an exported enum is walked as well.
      expect(
        e03ViolationsForSource(
          "import { Legacy } from '../struct/__e03_probe_legacy_enum_computed'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // A member that calls an imported function is walked as well.
      expect(
        e03ViolationsForSource(
          "import { Legacy } from '../struct/__e03_probe_legacy_enum_call'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // A binding the enum defines itself reaches no other module, so it
      // creates no target.
      expect(
        e03ViolationsForSource(
          "import { Legacy } from '../struct/__e03_probe_legacy_enum_local'",
          research,
          publicPaths,
        ),
      ).toEqual([])

      // The retained tree keeps its own wrapper.
      expect(
        e03ViolationsForSource(
          "export { Legacy } from './__e03_probe_legacy_enum_member'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(member.pathname, { force: true })
      await rm(computed.pathname, { force: true })
      await rm(call.pathname, { force: true })
      await rm(local.pathname, { force: true })
    }
  })

  it('E-03: probes an explicitly suffixed wrapper before the extensionless candidates', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const harmless = new URL('struct/__e03_probe_legacy_basename.ts', root)
    const reexporting = new URL('struct/__e03_probe_legacy_basename.js', root)
    const mdx = new URL('struct/__e03_probe_legacy_basename_mdx.mdx', root)
    await writeFile(harmless.pathname, 'export const marker = 1\n', 'utf8')
    await writeFile(reexporting.pathname, "export { T } from './types'\n", 'utf8')
    await writeFile(mdx.pathname, "export { T } from './types'\n", 'utf8')
    try {
      // Two retained wrappers share a basename, and the explicit `.js` path
      // names the JavaScript one, so the traversal follows that wrapper and
      // the importer outside the retained tree is reported.
      expect(
        e03ViolationsForSource(
          "import { T } from '../struct/__e03_probe_legacy_basename.js'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // The extensionless spelling resolves through the extensionless
      // candidates, so it keeps its behaviour: the first candidate is the
      // harmless TypeScript wrapper.
      expect(
        e03ViolationsForSource(
          "import { T } from '../struct/__e03_probe_legacy_basename'",
          research,
          publicPaths,
        ),
      ).toEqual([])

      // The explicit `.ts` path names the harmless TypeScript wrapper, so it
      // reports nothing.
      expect(
        e03ViolationsForSource(
          "import { marker } from '../struct/__e03_probe_legacy_basename.ts'",
          research,
          publicPaths,
        ),
      ).toEqual([])

      // The `.mdx` extension is still stripped consistently: the explicit
      // `.mdx` spelling names the same MDX wrapper as the suffix-free
      // spelling of it, and both report the retained wrapper.
      expect(
        e03ViolationsForSource(
          "import { T } from '../struct/__e03_probe_legacy_basename_mdx.mdx'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)
      expect(
        e03ViolationsForSource(
          "import { T } from '../struct/__e03_probe_legacy_basename_mdx'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // A wrapper that does not exist is still handled as before: the exact
      // path is probed, no file backs it, and the extensionless candidates
      // name no file either.
      expect(
        e03ViolationsForSource(
          "import { T } from '../struct/__e03_probe_legacy_absent.js'",
          research,
          publicPaths,
        ),
      ).toEqual([])

      // The retained tree keeps its own wrapper.
      expect(
        e03ViolationsForSource(
          "export { T } from './__e03_probe_legacy_basename.js'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(harmless.pathname, { force: true })
      await rm(reexporting.pathname, { force: true })
      await rm(mdx.pathname, { force: true })
    }
  })

  it('E-03: traces a CommonJS re-export that assigns a require-bound alias to module.exports', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const wrapper = new URL(
      'struct/__e03_probe_legacy_cjs_require_alias.cts',
      root,
    )
    await writeFile(
      wrapper.pathname,
      "const Types = require('./types')\nmodule.exports = Types\n",
      'utf8',
    )
    try {
      expect(
        e03ViolationsForSource(
          "import { Types } from '../struct/__e03_probe_legacy_cjs_require_alias'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      expect(
        e03ViolationsForSource(
          "export * from './__e03_probe_legacy_cjs_require_alias'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(wrapper.pathname, { force: true })
    }
  })

  it('E-03: traces an exported type alias or interface that references an imported type binding', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const aliasWrapper = new URL(
      'struct/__e03_probe_legacy_type_alias.ts',
      root,
    )
    const interfaceWrapper = new URL(
      'struct/__e03_probe_legacy_type_interface.ts',
      root,
    )
    await writeFile(
      aliasWrapper.pathname,
      "import { T } from './types'\nexport type Foo = T\n",
      'utf8',
    )
    await writeFile(
      interfaceWrapper.pathname,
      "import { T } from './types'\nexport interface Foo extends T {}\n",
      'utf8',
    )
    try {
      expect(
        e03ViolationsForSource(
          "import { Foo } from '../struct/__e03_probe_legacy_type_alias'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)
      expect(
        e03ViolationsForSource(
          "import { Foo } from '../struct/__e03_probe_legacy_type_interface'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      expect(
        e03ViolationsForSource(
          "export { Foo } from './__e03_probe_legacy_type_alias'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(aliasWrapper.pathname, { force: true })
      await rm(interfaceWrapper.pathname, { force: true })
    }
  })

  it('E-03: catches an explicit .jsx wrapper that re-exports a migrated family', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const jsxWrapper = new URL(
      'struct/__e03_probe_legacy_jsx.jsx',
      root,
    )
    await writeFile(
      jsxWrapper.pathname,
      "export { T } from './ids'\n",
      'utf8',
    )
    try {
      // An external import of the explicit .jsx wrapper that re-exports
      // a migrated family (ids) should be caught.
      expect(
        e03ViolationsForSource(
          "import { T } from '../struct/__e03_probe_legacy_jsx.jsx'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // The retained tree keeps its own wrapper - internal re-export is allowed.
      expect(
        e03ViolationsForSource(
          "export { T } from './__e03_probe_legacy_jsx.jsx'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(jsxWrapper.pathname, { force: true })
    }
  })

  it('E-03: catches an explicit .tsx wrapper that re-exports a migrated family', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const tsxWrapper = new URL(
      'struct/__e03_probe_legacy_tsx.tsx',
      root,
    )
    await writeFile(
      tsxWrapper.pathname,
      "export { T } from './types'\n",
      'utf8',
    )
    try {
      // An external import of the explicit .tsx wrapper that re-exports
      // a migrated family (types) should be caught.
      expect(
        e03ViolationsForSource(
          "import { T } from '../struct/__e03_probe_legacy_tsx.tsx'",
          research,
          publicPaths,
        ),
      ).toHaveLength(1)

      // The retained tree keeps its own wrapper - internal re-export is allowed.
      expect(
        e03ViolationsForSource(
          "export { T } from './__e03_probe_legacy_tsx.tsx'",
          new URL('struct/probe.ts', root),
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(tsxWrapper.pathname, { force: true })
    }
  })

  it('E-03: legal negative control - .jsx wrapper not re-exporting migrated family is allowed', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const jsxWrapper = new URL(
      'struct/__e03_probe_legacy_jsx_harmless.jsx',
      root,
    )
    await writeFile(
      jsxWrapper.pathname,
      "export const marker = 1\n",
      'utf8',
    )
    try {
      // A .jsx wrapper that does NOT re-export a migrated family should NOT
      // be flagged - this is the legal negative control.
      expect(
        e03ViolationsForSource(
          "import { marker } from '../struct/__e03_probe_legacy_jsx_harmless.jsx'",
          research,
          publicPaths,
        ),
      ).toEqual([])
    } finally {
      await rm(jsxWrapper.pathname, { force: true })
    }
  })

  // ==== Red tests for the four new bot findings ====

  it('O1b5: traces a dynamic import inside an exported wrapper expression', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const wrapper = new URL('struct/__e03_probe_o1b5_dynamic.ts', root)
    await writeFile(
      wrapper.pathname,
      "import { structId } from './ids'\nexport const load = () => import('./ids')\n",
      'utf8',
    )
    try {
      // A retained wrapper that exports a loader with a dynamic import
      // should be detected as reaching the migrated family
      expect(
        e03ViolationsForSource(
          "import { load } from '../struct/__e03_probe_o1b5_dynamic'",
          research,
          publicPaths,
        ),
      ).not.toEqual([])
    } finally {
      await rm(wrapper.pathname, { force: true })
    }
  })

  it('O1cB: recognizes Object.assign CommonJS re-exports', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)
    const wrapper = new URL('struct/__e03_probe_o1cb_object_assign.cjs', root)
    await writeFile(
      wrapper.pathname,
      "Object.assign(module.exports, require('./ids'))\n",
      'utf8',
    )
    try {
      // Object.assign(module.exports, require('./ids')) should be recognized
      // as a CommonJS re-export
      expect(
        e03ViolationsForSource(
          "import { structId } from '../struct/__e03_probe_o1cb_object_assign'",
          research,
          publicPaths,
        ),
      ).not.toEqual([])
    } finally {
      await rm(wrapper.pathname, { force: true })
    }
  })

  it('O1cF: rejects codec imports from the package root', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)

    // The E-03 mapping requires codec consumers to use @erniesg/struct/document
    // Importing decodeStructDocument from the package root should be rejected
    expect(
      e03ViolationsForSource(
        "import { decodeStructDocument } from '@erniesg/struct'",
        research,
        publicPaths,
      ),
    ).not.toEqual([])

    // The deprecated migrateStructDocument should also be rejected from root
    expect(
      e03ViolationsForSource(
        "import { migrateStructDocument } from '@erniesg/struct'",
        research,
        publicPaths,
      ),
    ).not.toEqual([])

    // But the proper subpath import should be allowed
    expect(
      e03ViolationsForSource(
        "import { decodeStructDocument } from '@erniesg/struct/document'",
        research,
        publicPaths,
      ),
    ).toEqual([])
  })

  it('O1cL: honors case-insensitive Vite glob matching', async () => {
    const publicPaths = await publicPackagePaths()
    const research = new URL('research/probe.ts', root)

    // Vite supports caseSensitive: false option for glob imports
    // The guard should propagate this option to the matcher
    const caseInsensitiveGlob =
      "const codecs = import.meta.glob('../STRUCT/IDS.TS', { eager: true, caseSensitive: false })"

    // With caseSensitive: false, the glob should match regardless of case,
    // detecting the migrated local ids module
    const paths = importedPaths(caseInsensitiveGlob, research)
    // The matched path should correspond to the actual lowercase file
    expect(paths).toContain('../struct/ids.ts')
    // The real e03ViolationsForSource should detect the migrated local ids module
    const violations = e03ViolationsForSource(
      "import { structId } from '../STRUCT/IDS.TS'",
      research,
      publicPaths,
    )
    expect(violations).not.toEqual([])
  })
})
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
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
}

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
      if (patterns === null) {
        // A computed glob pattern has no literal target, so the guard cannot
        // prove that it does not load a migrated family. It fails closed in
        // the same way a computed dynamic import does.
        paths.push(NONLITERAL_GLOB)
        computedGlobs?.push({
          fragments: stringLiteralsIn(argument),
          staticText: staticTextIn(argument),
        })
      } else {
        paths.push(...globFamilySpecifiers(patterns, file))
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
  const specifiers = importedPaths(
    source,
    file,
    computedDynamicImports,
    computedRequires,
    computedGlobs,
  )
  return { specifiers, computedDynamicImports, computedRequires, computedGlobs }
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
 */
function globFamilySpecifiers(patterns: string[], file: URL): string[] {
  const included = patterns.filter((pattern) => !pattern.startsWith('!'))
  const excluded = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => pattern.slice(1))
  if (included.length === 0) return []
  const importerDirectory = dirname(file.pathname)
  const includedPatterns = included.map((pattern) =>
    normalizeGlobPattern(pattern, importerDirectory),
  )
  const excludedPatterns = excluded.map((pattern) =>
    normalizeGlobPattern(pattern, importerDirectory),
  )
  const specifiers: string[] = []
  for (const familyFile of [
    ...migratedFamilyFiles(),
    ...retainedBarrelFiles(),
  ]) {
    // A pattern is matched in its project-root-relative form, because that
    // is the form a project-root or alias pattern resolves to.
    const modulePath = relative(projectRootPath, familyFile)
    if (!globMatchesAny(includedPatterns, modulePath)) continue
    if (globMatchesAny(excludedPatterns, modulePath)) continue
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
 * to the directory of the importing module. The guard normalises the pattern
 * before it matches, so a project-root or alias pattern reaches the family it
 * names instead of matching nothing.
 */
function normalizeGlobPattern(
  pattern: string,
  importerDirectory: string,
): string {
  const aliased = aliasGlobTarget(pattern)
  if (aliased !== null) return aliased
  return relative(projectRootPath, resolve(importerDirectory, pattern))
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
 * Whether a module path matches one of the glob patterns. A brace group
 * lists alternatives, so every expansion of a pattern is tried.
 *
 * The pattern and the module path are both in the project-root-relative form
 * the pattern was normalised into, so a project-root pattern, an alias
 * pattern and an importer-relative pattern all match the module they name.
 */
function globMatchesAny(patterns: string[], modulePath: string): boolean {
  const spellings = globPathSpellings(modulePath)
  return patterns.some((pattern) =>
    expandGlobBraces(pattern).some((expanded) =>
      spellings.some((spelling) => globToRegExp(expanded).test(spelling)),
    ),
  )
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
 * The expanded forms of a glob pattern. A brace group lists alternatives, so
 * `../struct/{types,ids}.ts` names two modules.
 */
function expandGlobBraces(pattern: string): string[] {
  const open = pattern.indexOf('{')
  if (open === -1) return [pattern]
  const close = pattern.indexOf('}', open)
  if (close === -1) return [pattern]
  const alternatives = pattern.slice(open + 1, close).split(',')
  if (alternatives.length < 2) return [pattern]
  const prefix = pattern.slice(0, open)
  const suffix = pattern.slice(close + 1)
  return alternatives.flatMap((alternative) =>
    expandGlobBraces(`${prefix}${alternative}${suffix}`),
  )
}

/**
 * A glob pattern as a regular expression. `*` matches inside one path
 * segment, `**` matches across segments and `?` matches a single character.
 */
function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          source += '(?:[^/]*/)*'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (character === '?') {
      source += '[^/]'
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/**
 * The source the guard parses for a module. An Astro file contributes its
 * frontmatter and its inline scripts; an MDX file contributes the ESM flow
 * blocks MDX allows at the top level of the document, so a fenced code
 * sample that merely shows an import is not mistaken for a module
 * specifier.
 *
 * An Astro file also contributes its processed local script sources: Astro
 * bundles a local `src` of a script element as a script entry, so that file
 * is an import the guard has to inspect.
 */
function scanSource(source: string, file: URL): string {
  if (file.pathname.endsWith('.astro')) {
    const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? ''
    const scripts = [
      ...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),
    ].map((match) => match[1])
    const scriptSources = astroScriptSources(source).map(
      (scriptSource) => `import ${JSON.stringify(scriptSource)}`,
    )
    return [frontmatter, ...scripts, ...scriptSources].join('\n')
  }
  if (file.pathname.endsWith('.mdx')) return mdxEsmStatements(source)
  return source
}

/**
 * The processed local script sources of an Astro component.
 *
 * Astro processes a relative `src` of a script element as a script entry and
 * bundles that file, so the source is a module specifier. A `src` that names
 * a public asset or an external URL is not processed, so it contributes
 * nothing. An inline script is not processed either, so its `src` is not a
 * module specifier.
 */
function astroScriptSources(source: string): string[] {
  const sources: string[] = []
  for (const match of source.matchAll(/<script\b([^>]*)>/g)) {
    const attributes = match[1] ?? ''
    if (/(?:^|\s)is:inline(?:\s|=|$)/.test(attributes)) continue
    const type = /\btype\s*=\s*("([^"]*)"|'([^']*)')/.exec(attributes)
    const typeValue = type?.[2] ?? type?.[3]
    if (
      typeValue !== undefined &&
      !['module', 'text/javascript', 'application/javascript'].includes(
        typeValue.toLowerCase(),
      )
    ) {
      continue
    }
    const src = /\bsrc\s*=\s*("([^"]*)"|'([^']*)')/.exec(attributes)
    const value = src?.[2] ?? src?.[3]
    if (value === undefined) continue
    if (!value.startsWith('./') && !value.startsWith('../')) continue
    sources.push(value)
  }
  return sources
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
 * Whether a candidate statement can still be completed by more input.
 *
 * The TypeScript parser is the authority on whether a candidate is a finished
 * declaration, so its complaints decide the question. A candidate whose
 * complaint is at its own end is a declaration that is not finished yet: a
 * valid `import T` without its `from` clause is exactly that. A candidate
 * that broke earlier is not a declaration at all, so a prose line that
 * begins with `import` is not read as one.
 */
function mdxStatementIsIncomplete(statement: string): boolean {
  if (mdxStatementNamesAModule(statement)) return false
  const file = ts.createSourceFile(
    'mdx-esm.ts',
    statement,
    ts.ScriptTarget.Latest,
    true,
  )
  const diagnostics = mdxStatementDiagnostics(statement)
  if (diagnostics.length === 0) return false
  // The parser consumed nothing, so the candidate is a bare keyword that
  // more input can still complete.
  if (file.statements.length === 0) return true
  const end = statement.trimEnd().length
  return diagnostics.every((diagnostic) => (diagnostic.start ?? 0) >= end)
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
 * brace depth alone does not decide that a statement is finished, because a
 * valid declaration without braces can put its `from` clause on a line of
 * its own. A prose line that begins with `import` is dropped unless the
 * TypeScript parser reads it as an ESM statement.
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
    if (
      mdxStatementNamesAModule(statement) ||
      mdxStatementIsDeclaration(statement)
    )
      kept.push(statement)
  }
  for (const line of body.split('\n')) {
    if (depth > 0) {
      // The line continues the ESM statement that is already open.
      block.push(line)
      depth += mdxBraceDelta(line)
      if (depth === 0 && !mdxStatementIsIncomplete(block.join('\n'))) flush()
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
      if (!mdxStatementIsIncomplete(block.join('\n'))) flush()
      continue
    }
    const trimmed = line.trim()
    if (!mdxStartsEsmStatement(trimmed)) continue
    block = [line]
    depth = mdxBraceDelta(line)
    if (depth === 0 && !mdxStatementIsIncomplete(line)) flush()
  }
  if (block.length > 0) flush()
  return kept.join('\n')
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
  for (const [family, familyRoot] of migratedFamilyRoots) {
    if (target === familyRoot || target.startsWith(`${familyRoot}/`))
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
 * The local module a path names, or null when no file backs the path. The
 * path a specifier resolves to carries no extension, so the file names the
 * module can have are tried in turn.
 *
 * Every extension the scanner accepts is probed, so a retained wrapper
 * stored as a CommonJS TypeScript module (`.cts`) or as a CommonJS module
 * (`.cjs`) is found as well, together with the index variants of those
 * extensions.
 */
function readLocalModule(target: string): LocalModule | null {
  const cached = localModuleCache.get(target)
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
  localModuleCache.set(target, module)
  return module
}

/**
 * The file names a local module path can have. The extension list is the one
 * the scanner accepts, and every extension also has an index variant.
 */
function localModuleCandidates(target: string): string[] {
  return [
    ...localModuleExtensions.map((extension) => `${target}${extension}`),
    ...localModuleExtensions.map(
      (extension) => `${target}/index${extension}`,
    ),
  ]
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
const reexportSpecifierCache = new Map<string, string[]>()

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
 * The ordinary CommonJS form counts as a re-export too: a wrapper that
 * assigns a required module to `module.exports` re-exports that module, so
 * the guard follows it as well.
 */
function reexportSpecifiers(source: string): string[] {
  const cached = reexportSpecifierCache.get(source)
  if (cached !== undefined) return [...cached]
  const specifiers = computeReexportSpecifiers(source)
  reexportSpecifierCache.set(source, specifiers)
  return [...specifiers]
}

function computeReexportSpecifiers(source: string): string[] {
  const file = ts.createSourceFile(
    'module.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const specifiers: string[] = []
  const importedBindings = importedBindingModules(file)
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      continue
    }
    if (ts.isExpressionStatement(statement)) {
      // A CommonJS re-export: `module.exports = require('./types')`.
      const required = commonJsReexportSpecifier(statement.expression)
      if (required !== null) specifiers.push(required)
      continue
    }
    if (ts.isVariableStatement(statement)) {
      // `export const id = structId` re-exports the module the imported
      // binding came from.
      if (!hasExportModifier(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer
        if (!initializer || !ts.isIdentifier(initializer)) continue
        const imported = importedBindings.get(initializer.text)
        if (imported === undefined) continue
        specifiers.push(imported)
      }
      continue
    }
    if (ts.isExportAssignment(statement)) {
      // `export default structId` re-exports the module the imported binding
      // came from.
      const expression = statement.expression
      if (!ts.isIdentifier(expression)) continue
      const imported = importedBindings.get(expression.text)
      if (imported === undefined) continue
      specifiers.push(imported)
      continue
    }
    if (!ts.isExportDeclaration(statement)) continue
    if (statement.moduleSpecifier) {
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text)
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
      specifiers.push(imported)
    }
  }
  return specifiers
}

/**
 * The module every imported binding of a module came from, keyed by the
 * local name of the binding. A default import, a named import and a
 * namespace import all bind a local name.
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
    if (!ts.isImportDeclaration(statement)) continue
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
  }
  return importedBindings
}

/**
 * The module a CommonJS re-export names, or null when the statement is not a
 * CommonJS re-export. The ordinary form `module.exports = require('./types')`
 * re-exports the required module, and so does `exports.types = require(...)`.
 */
function commonJsReexportSpecifier(expression: ts.Expression): string | null {
  if (!ts.isBinaryExpression(expression)) return null
  if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null
  if (!isCommonJsExportTarget(expression.left)) return null
  const required = expression.right
  if (!ts.isCallExpression(required)) return null
  if (!ts.isIdentifier(required.expression)) return null
  if (required.expression.text !== 'require') return null
  const argument = required.arguments[0]
  if (!argument || !ts.isStringLiteralLike(argument)) return null
  return argument.text
}

/**
 * Whether an assignment target names a CommonJS export. `module.exports` and
 * every property of `exports` name one.
 */
function isCommonJsExportTarget(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === 'exports'
  if (!ts.isPropertyAccessExpression(expression)) return false
  const owner = expression.expression
  if (!ts.isIdentifier(owner)) return false
  if (owner.text === 'exports') return true
  return owner.text === 'module' && expression.name.text === 'exports'
}

/**
 * Whether a variable statement is exported. `export const id = ...` is an
 * export declaration that aliases a binding.
 */
function hasExportModifier(statement: ts.VariableStatement): boolean {
  return (
    statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false
  )
}

/**
 * The migrated family a retained-tree wrapper reaches by re-export, or null
 * when it reaches none. The chain is followed transitively, so a wrapper
 * that re-exports another wrapper is traced as well.
 */
function migratedFamilyInReexportChain(target: string): string | null {
  const seen = new Set<string>()
  const pending = [target]
  while (pending.length > 0) {
    const current = pending.shift()!
    if (seen.has(current)) continue
    seen.add(current)
    const module = readLocalModule(current)
    if (module === null) continue
    // The specifiers of a module are relative to the file that backs it, so
    // an index module resolves them against its own directory.
    const moduleUrl = new URL(module.path, 'file:///')
    for (const specifier of reexportSpecifiers(module.source)) {
      const resolved = resolveLocalTarget(specifier, moduleUrl)
      if (resolved === null) continue
      const normalized = resolved.replace(/\/+$/, '')
      if (
        isMigratedFamilyTarget(normalized) ||
        isStructBarrelTarget(normalized)
      )
        return normalized
      if (isRetainedTreePath(normalized)) pending.push(normalized)
    }
  }
  return null
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
 */
function resolveLocalTarget(specifier: string, file: URL): string | null {
  if (
    specifier === '@erniesg/struct' ||
    specifier.startsWith('@erniesg/struct/')
  ) {
    return null
  }
  if (specifier.startsWith('.')) {
    return new URL(specifier, file).pathname.replace(
      /\.(?:[cm]?[jt]s|astro|mdx)$/u,
      '',
    )
  }
  const resolved = resolveAliasSpecifier(specifier)
  if (resolved === null) return null
  return resolved.replace(/\.(?:[cm]?[jt]s|astro|mdx)$/u, '')
}

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
    if (target === null || target !== appRecoveryModule) continue
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
 */
function recoveryAuthorityInReexportChain(
  target: string,
): 'compatibility forwarder' | 'app recovery module' | null {
  const seen = new Set<string>()
  const pending: string[] = []
  const module = readLocalModule(target)
  if (module === null) return null
  const moduleUrl = new URL(module.path, 'file:///')
  for (const specifier of reexportSpecifiers(module.source)) {
    const resolved = resolveLocalTarget(specifier, moduleUrl)
    if (resolved === null) continue
    pending.push(resolved.replace(/\/+$/, ''))
  }
  while (pending.length > 0) {
    const current = pending.shift()!
    if (seen.has(current)) continue
    seen.add(current)
    if (current === compatibilityRecoveryForwarder) {
      return 'compatibility forwarder'
    }
    if (current === appRecoveryModule) return 'app recovery module'
    const currentModule = readLocalModule(current)
    if (currentModule === null) continue
    const currentUrl = new URL(currentModule.path, 'file:///')
    for (const specifier of reexportSpecifiers(currentModule.source)) {
      const resolved = resolveLocalTarget(specifier, currentUrl)
      if (resolved === null) continue
      pending.push(resolved.replace(/\/+$/, ''))
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
    if (target === compatibilityRecoveryForwarder) {
      violations.push(
        `${file.pathname}: compatibility recovery forwarder import ${specifier} is not allowed outside the retained struct tree`,
      )
      continue
    }
    const authority = recoveryAuthorityInReexportChain(target)
    if (authority === null) continue
    violations.push(
      `${file.pathname}: recovery authority import ${specifier} -> ${target} reaches the ${authority}`,
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
        .filter((target): target is string => target !== null)
        .find((target) => {
          const normalized = target.replace(/\/+$/, '')
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
        .filter((target): target is string => target !== null)
        .find((target) => {
          const normalized = target.replace(/\/+$/, '')
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
        .filter((target): target is string => target !== null)
        .find((target) => {
          const normalized = target.replace(/\/+$/, '')
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
      }
      continue
    }
    const target = resolveLocalTarget(specifier, file)
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
      const reexported = migratedFamilyInReexportChain(target)
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
})
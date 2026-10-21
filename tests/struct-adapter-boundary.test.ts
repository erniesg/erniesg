import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { dirname, relative } from 'node:path'
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
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return paths
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
 */
function globFamilySpecifiers(patterns: string[], file: URL): string[] {
  const included = patterns.filter((pattern) => !pattern.startsWith('!'))
  const excluded = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => pattern.slice(1))
  if (included.length === 0) return []
  const importerDirectory = dirname(file.pathname)
  const specifiers: string[] = []
  for (const familyFile of migratedFamilyFiles()) {
    const modulePath = relative(importerDirectory, familyFile)
    if (!globMatchesAny(included, modulePath)) continue
    if (globMatchesAny(excluded, modulePath)) continue
    specifiers.push(
      modulePath.startsWith('.') ? modulePath : `./${modulePath}`,
    )
  }
  return specifiers
}

/**
 * Whether a module path matches one of the glob patterns. A brace group
 * lists alternatives, so every expansion of a pattern is tried.
 */
function globMatchesAny(patterns: string[], modulePath: string): boolean {
  return patterns.some((pattern) =>
    expandGlobBraces(pattern).some((expanded) =>
      globToRegExp(expanded).test(modulePath),
    ),
  )
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
 */
function scanSource(source: string, file: URL): string {
  if (file.pathname.endsWith('.astro')) {
    const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? ''
    const scripts = [
      ...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),
    ].map((match) => match[1])
    return [frontmatter, ...scripts].join('\n')
  }
  if (file.pathname.endsWith('.mdx')) return mdxEsmStatements(source)
  return source
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
  const diagnostics =
    ts.transpileModule(statement, {
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.Latest,
        module: ts.ModuleKind.ESNext,
      },
    }).diagnostics ?? []
  if (diagnostics.length === 0) return false
  // The parser consumed nothing, so the candidate is a bare keyword that
  // more input can still complete.
  if (file.statements.length === 0) return true
  const end = statement.trimEnd().length
  return diagnostics.every((diagnostic) => (diagnostic.start ?? 0) >= end)
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
    if (mdxStatementNamesAModule(statement)) kept.push(statement)
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
): string[] {
  const portable = file.pathname.startsWith(portableRoot.pathname)
  return importedPaths(source, file).filter((specifier) => {
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
 * The source of a local module, or null when no file backs the path. The
 * path a specifier resolves to carries no extension, so the file names the
 * module can have are tried in turn.
 */
function readLocalModuleSource(target: string): string | null {
  for (const candidate of [
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.mts`,
    `${target}.js`,
    `${target}.jsx`,
    `${target}.mjs`,
    `${target}/index.ts`,
    `${target}/index.tsx`,
  ]) {
    try {
      return readFileSync(candidate, 'utf8')
    } catch {
      continue
    }
  }
  return null
}

/**
 * The module specifiers a module re-exports. A retained-tree wrapper that
 * re-exports a migrated family is the way an external importer reaches the
 * local migrated authority, so the re-export targets are what the guard
 * follows.
 */
function reexportSpecifiers(source: string): string[] {
  const file = ts.createSourceFile(
    'module.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const specifiers: string[] = []
  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement)) continue
    if (!statement.moduleSpecifier) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    specifiers.push(statement.moduleSpecifier.text)
  }
  return specifiers
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
    const source = readLocalModuleSource(current)
    if (source === null) continue
    const moduleUrl = new URL(current, 'file:///')
    for (const specifier of reexportSpecifiers(source)) {
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
      /\.(?:[cm]?[jt]s|astro)$/u,
      '',
    )
  }
  const resolved = resolveAliasSpecifier(specifier)
  if (resolved === null) return null
  return resolved.replace(/\.(?:[cm]?[jt]s|astro)$/u, '')
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
 * The compatibility forwarder is part of the recovery importer boundary: it
 * re-exports the app-owned recovery module, so a module outside the retained
 * `src/struct` tree reaches the recovery module through the legacy facade
 * when it imports the forwarder. The check works on the resolved target, so
 * every spelling of the forwarder is covered: the direct relative form, the
 * `@/` alias, the project-root form and a `.js` suffix form.
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
    if (target === null || target !== compatibilityRecoveryForwarder) continue
    violations.push(
      `${file.pathname}: compatibility recovery forwarder import ${specifier} is not allowed outside the retained struct tree`,
    )
  }
  return violations
}

function e03ViolationsForSource(
  source: string,
  file: URL,
  publicPaths: Set<string>,
): string[] {
  const violations: string[] = []
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

  it('keeps app recovery consumers on the app-owned path', async () => {
    const violations: string[] = []
    for (const file of await portableFiles(root)) {
      if (file.pathname.startsWith(portableRoot.pathname)) continue
      const source = await readFile(file, 'utf8')
      // The compatibility forwarder is resolved, not matched against a list
      // of spellings, so every alias of it is a violation here too.
      violations.push(
        ...compatibilityForwarderViolationsForSpecifiers(
          importedPaths(source, file),
          file,
        ),
      )
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
})
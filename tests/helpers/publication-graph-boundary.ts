/**
 * The machinery of the EG-08 graph-absence guard.
 *
 * The guard is compiler-based, not textual: it builds a TypeScript program over
 * the repository's own sources, asks the type checker for the symbol behind
 * every identifier that names a graph symbol, and follows aliases with
 * `getAliasedSymbol`. That is what makes `export ... from` re-exports, barrel
 * `export *` and renamed imports resolve to the original declaration in
 * `src/publication/schema.ts`, so a module that reaches the graph through a
 * barrel is caught exactly like a module that imports it directly.
 *
 * The `.astro` files are not part of the TypeScript program, so they are
 * scanned with the textual frontmatter/script import extractor that the
 * existing boundary harness uses, and their import targets are resolved
 * through the checker as well.
 */
import { type Dirent, statSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

/** The repository root, derived from this file's own location. */
export const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

/** The module that owns the graph symbols. Every hit must resolve here. */
export const GRAPH_SCHEMA_MODULE = 'src/publication/schema.ts'

/**
 * The canonical graph type, declared in the schema module.
 *
 * The name alone is not the guard: a module that never writes
 * `PublicationGraph` can still hold the graph, by receiving a value whose
 * type carries it and reading the graph off that value. The guard therefore
 * resolves this type through the checker and compares type identity, so the
 * read is caught whatever the property is called.
 */
export const GRAPH_TYPE_NAME = 'PublicationGraph'

/**
 * The graph symbols the guard watches. A reference to any of them, from any
 * module, is a hit; the hit is only a violation when the referencing module is
 * not in the permitted set.
 */
export const GRAPH_SYMBOLS: readonly string[] = [
  'PublicationGraph',
  'publicationGraphSchema',
  'serializePublicationGraph',
  'PUBLICATION_GRAPH_VERSION',
  'PublicationNode',
  'PublicationInlineRun',
  'parsePublicationGraph',
]

/**
 * The permitted importers of graph symbols (contract §5.1). The graph survives
 * only as the in-memory renderer plan between the one projection and the
 * renderer, so exactly these modules may name it.
 *
 * `src/publication/publishing-facade.ts` is listed because the CLI is meant to
 * talk to the facade alone; the module is created by a later job of the lane,
 * so the guard never requires it to exist.
 */
export const PERMITTED_GRAPH_IMPORTERS: readonly string[] = [
  'src/publication/schema.ts',
  'src/publication/struct-adapter.ts',
  'src/publication/source-adapter.ts',
  'src/publication/renderers/vivliostyle.ts',
  'src/publication/adapter-conformance.ts',
  'src/publication/research-paper-adapter.ts',
  'src/publication/publishing-facade.ts',
]

/**
 * The named graph-free module classes (contract §5.2). Every member is
 * resolved to a concrete file list at run time, so a renamed or deleted file
 * cannot silently empty a class.
 */
export type GraphFreeClass = {
  name: string
  /** Explicit files and directories, relative to the repository root. */
  members: readonly string[]
}

export const GRAPH_FREE_MODULE_CLASSES: readonly GraphFreeClass[] = [
  {
    name: 'storage',
    members: [
      'src/worker/margin/d1.ts',
      'src/worker/margin/d1-repository.ts',
      'src/worker/margin/sqlite-database.ts',
      'src/worker/margin/repository.ts',
      'src/worker/margin/schema.sql',
    ],
  },
  {
    name: 'API',
    members: [
      'src/worker/index.ts',
      'src/worker/env.ts',
      'src/worker/principal.ts',
      'src/worker/gate.ts',
      'src/worker/margin/routes.ts',
      'src/worker/margin/queries.ts',
      'src/worker/margin/auth-routes.ts',
      'src/worker/margin/authorize.ts',
    ],
  },
  { name: 'route', members: ['src/pages'] },
  {
    name: 'writer',
    members: [
      'src/research/publication.worker.ts',
      'src/research/export-package.ts',
      'src/research/export-package-paths.ts',
      'src/research/export-pdf.ts',
      'src/research/publication-worker-client.ts',
      'src/research/publication-worker-protocol.ts',
    ],
  },
  {
    name: 'release',
    members: [
      'tools/deployment',
      'tools/publication-build.mjs',
      'tools/publication-check.mjs',
      'tools/publication-adapter-conformance.mjs',
    ],
  },
]

/** The release script that must not reach the graph either. */
export const RELEASE_SCRIPT = 'build:production'

export type ProgramAnalysis = {
  program: ts.Program
  checker: ts.TypeChecker
  /** Absolute source file name -> the graph symbols the file references. */
  references: Map<string, Set<string>>
  /** Every source file of the program, keyed by its resolved path. */
  sourceFiles: Map<string, ts.SourceFile>
  /**
   * The canonical graph type of the schema module, resolved through the
   * checker. It is the identity anchor of the value detection: a value whose
   * resolved type is this exact type object carries the publication graph.
   */
  graphType?: ts.Type
  /**
   * Absolute source file name -> the graph-bearing value accesses the file
   * performs. A property access, an element access, a destructuring pattern
   * or a parameter whose resolved type is the graph type.
   */
  accesses: Map<string, GraphValueAccess[]>
  /**
   * Absolute source file name -> the number of value accesses the guard
   * examined in that file. It is the vacuity counter: a file with a
   * non-zero count was walked by the value detection, whatever it found.
   */
  examined: Map<string, number>
}

/**
 * A value access that carries the publication graph.
 *
 * The access is proven by the checker, not by a text match: the resolved type
 * of the accessed value is the canonical `PublicationGraph` type object of
 * `src/publication/schema.ts`.
 */
export type GraphValueAccess = {
  /**
   * How the graph is reached: a property read, an element read, a
   * destructured binding, or a parameter that receives the graph.
   */
  kind: 'property' | 'element' | 'binding' | 'parameter'
  /** 1-based line of the access. */
  line: number
  /** 1-based column of the access. */
  column: number
  /** The source text of the access, for example `result.graph`. */
  text: string
  /** The graph symbol the access carries. */
  symbol: string
}

const SCHEMA_FILE = resolve(REPOSITORY_ROOT, GRAPH_SCHEMA_MODULE)

/** Normalize a path to a repository-relative, forward-slash path. */
export function repoRelative(file: string): string {
  return relative(REPOSITORY_ROOT, file).split(/[\\/]/).join('/')
}

/** Test files are outside the guard's scope, exactly as in the E-04 harness. */
export function isTestFile(file: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
}

function isInsideNodeModules(file: string): boolean {
  return file.split(/[\\/]/).includes('node_modules')
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
}

function parseRepositoryConfig(): ts.ParsedCommandLine {
  const configPath = resolve(REPOSITORY_ROOT, 'tsconfig.json')
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error)
    throw new Error(
      `Could not read ${configPath}: ${diagnosticText(configFile.error)}`,
    )
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    REPOSITORY_ROOT,
    undefined,
    configPath,
  )
  if (parsed.errors.length)
    throw new Error(
      `Could not parse ${configPath}: ${parsed.errors
        .map(diagnosticText)
        .join('; ')}`,
    )
  return parsed
}

function programOptions(): ts.CompilerOptions {
  const parsed = parseRepositoryConfig()
  return {
    ...parsed.options,
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
  }
}

/**
 * Build the TypeScript program over the repository's own sources and collect
 * every graph-symbol reference the checker can prove.
 */
export function analyzeProgram(
  rootNames: readonly string[],
  options: ts.CompilerOptions,
): ProgramAnalysis {
  const program = ts.createProgram([...rootNames], options)
  const checker = program.getTypeChecker()
  const graphType = graphTypeOf(program, checker)
  const references = new Map<string, Set<string>>()
  const sourceFiles = new Map<string, ts.SourceFile>()
  const accesses = new Map<string, GraphValueAccess[]>()
  const examined = new Map<string, number>()
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue
    if (isInsideNodeModules(sourceFile.fileName)) continue
    sourceFiles.set(resolve(sourceFile.fileName), sourceFile)
    const found = graphReferencesIn(sourceFile, checker, graphType)
    if (found.symbols.size) references.set(sourceFile.fileName, found.symbols)
    if (found.accesses.length) accesses.set(sourceFile.fileName, found.accesses)
    examined.set(sourceFile.fileName, found.examined)
  }
  return {
    program,
    checker,
    references,
    sourceFiles,
    graphType,
    accesses,
    examined,
  }
}

/** Build the program over the repository's own sources. */
export function analyzeRepository(): ProgramAnalysis {
  const parsed = parseRepositoryConfig()
  return analyzeProgram(parsed.fileNames, programOptions())
}

/** The references of an analysis, keyed by repository-relative path. */
export function repoReferences(
  analysis: ProgramAnalysis,
): Map<string, Set<string>> {
  const byRepoPath = new Map<string, Set<string>>()
  for (const [file, symbols] of analysis.references)
    byRepoPath.set(repoRelative(file), symbols)
  return byRepoPath
}

/**
 * The graph-bearing value accesses of an analysis, keyed by repository-relative
 * path.
 */
export function repoPropertyAccesses(
  analysis: ProgramAnalysis,
): Map<string, GraphValueAccess[]> {
  const byRepoPath = new Map<string, GraphValueAccess[]>()
  for (const [file, accesses] of analysis.accesses)
    byRepoPath.set(repoRelative(file), accesses)
  return byRepoPath
}

/**
 * The number of value accesses the guard examined in a repository-relative
 * file. A non-zero count proves that the value detection walked the file.
 */
export function repoExaminedAccesses(
  analysis: ProgramAnalysis,
): Map<string, number> {
  const byRepoPath = new Map<string, number>()
  for (const [file, count] of analysis.examined)
    byRepoPath.set(repoRelative(file), count)
  return byRepoPath
}

function isSchemaDeclaration(declaration: ts.Declaration): boolean {
  return (
    repoRelative(declaration.getSourceFile().fileName) === GRAPH_SCHEMA_MODULE
  )
}

/**
 * Resolve an identifier to the graph symbol it names, following aliases.
 *
 * The declaration must live in `src/publication/schema.ts` and carry a graph
 * symbol name, so a module that declares its own `PublicationNode` type is
 * not a hit.
 */
export function resolveGraphSymbol(
  checker: ts.TypeChecker,
  node: ts.Identifier,
): string | undefined {
  const symbol = checker.getSymbolAtLocation(node)
  if (!symbol) return undefined
  return graphSymbolOf(checker, symbol)
}

/**
 * The graph symbols a module exports, resolved through the checker so a
 * renamed or re-exported graph symbol is still the graph symbol.
 */
export function exportedGraphSymbols(
  checker: ts.TypeChecker,
  moduleSpecifier: ts.Expression,
): Set<string> {
  const found = new Set<string>()
  if (!ts.isStringLiteral(moduleSpecifier)) return found
  const moduleSymbol = checker.getSymbolAtLocation(moduleSpecifier)
  if (!moduleSymbol) return found
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const name = graphSymbolOf(checker, exported)
    if (name) found.add(name)
  }
  return found
}

/** The graph symbol a module symbol names, if it is one. */
function graphSymbolOf(
  checker: ts.TypeChecker,
  exported: ts.Symbol,
): string | undefined {
  let symbol = exported
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = checker.getAliasedSymbol(symbol)
    } catch {
      return undefined
    }
  }
  for (const declaration of symbol.declarations ?? []) {
    const name = (declaration as ts.NamedDeclaration).name
    if (!name || !ts.isIdentifier(name)) continue
    if (!GRAPH_SYMBOLS.includes(name.text)) continue
    if (!isSchemaDeclaration(declaration)) continue
    return name.text
  }
  return undefined
}

/**
 * The graph symbol a module imports or re-exports under `name`, resolved
 * through the module's exports so a barrel or a rename cannot hide it.
 */
function resolveImportedGraphSymbol(
  checker: ts.TypeChecker,
  moduleSpecifier: ts.Expression,
  name: string,
): string | undefined {
  if (!ts.isStringLiteral(moduleSpecifier)) return undefined
  const moduleSymbol = checker.getSymbolAtLocation(moduleSpecifier)
  if (!moduleSymbol) return undefined
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    if (exported.getName() !== name) continue
    const resolved = graphSymbolOf(checker, exported)
    if (resolved) return resolved
  }
  return undefined
}

/**
 * The module specifier of the import or export declaration a specifier
 * belongs to. The specifier's own parent is the named bindings, so the
 * declaration is found by walking up.
 */
function enclosingModuleSpecifier(node: ts.Node): ts.Expression | undefined {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current))
      return current.moduleSpecifier
    if (ts.isSourceFile(current)) return undefined
    current = current.parent
  }
  return undefined
}

/**
 * Every graph symbol a source file references, proven by the checker.
 *
 * The walk covers the identifiers themselves (a use, an import, a re-export),
 * the imported or re-exported name of a specifier (which catches a renamed
 * import, whose local name says nothing about the symbol) and the exports of
 * a namespace import.
 */
export function graphSymbolsIn(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  graphType?: ts.Type,
): Set<string> {
  return graphReferencesIn(sourceFile, checker, graphType).symbols
}

/**
 * The canonical graph type, resolved through the checker from the schema
 * module.
 *
 * The returned type object is the identity anchor of the value detection: a
 * value whose resolved type is this exact object carries the publication
 * graph, whatever the property that carries it is called. A module that
 * declares its own identically named type has a different type object, so it
 * is never a hit.
 */
export function graphTypeOf(
  program: ts.Program,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const schema = schemaSourceFile(program)
  if (!schema) return undefined
  for (const statement of schema.statements) {
    if (!ts.isTypeAliasDeclaration(statement)) continue
    if (statement.name.text !== GRAPH_TYPE_NAME) continue
    const symbol = checker.getSymbolAtLocation(statement.name)
    if (!symbol) continue
    return checker.getDeclaredTypeOfSymbol(symbol)
  }
  return undefined
}

/** The schema module's source file inside a program. */
function schemaSourceFile(program: ts.Program): ts.SourceFile | undefined {
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue
    if (repoRelative(sourceFile.fileName) === GRAPH_SCHEMA_MODULE)
      return sourceFile
  }
  return undefined
}

/**
 * Whether a resolved type is the canonical graph type.
 *
 * The comparison is by type identity, never by name and never by structure:
 * a local type that merely shares the name of the graph type is a different
 * type object and is not a hit. The alias fallback only fires for a type that
 * still carries its alias, and it resolves the alias to its declaration, so
 * the declaration must live in the schema module.
 */
function isGraphType(
  type: ts.Type | undefined,
  graphType: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  if (!type) return false
  if (type === graphType) return true
  const alias = type.aliasSymbol
  if (!alias) return false
  let symbol = alias
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = checker.getAliasedSymbol(symbol)
    } catch {
      return false
    }
  }
  for (const declaration of symbol.declarations ?? []) {
    const name = (declaration as ts.NamedDeclaration).name
    if (!name || !ts.isIdentifier(name)) continue
    if (name.text !== GRAPH_TYPE_NAME) continue
    if (!isSchemaDeclaration(declaration)) continue
    return true
  }
  return false
}

/**
 * The graph symbols a source file references and the graph-bearing values it
 * accesses, both proven by the checker.
 */
export type GraphReferences = {
  /** The graph symbols the file names. */
  symbols: Set<string>
  /** The graph-bearing value accesses the file performs. */
  accesses: GraphValueAccess[]
  /** The number of value accesses the guard examined in the file. */
  examined: number
}

/**
 * Every graph symbol a source file references and every graph-bearing value
 * it accesses, proven by the checker.
 *
 * The name-based walk covers the identifiers themselves (a use, an import, a
 * re-export), the imported or re-exported name of a specifier (which catches
 * a renamed import, whose local name says nothing about the symbol) and the
 * exports of a namespace import.
 *
 * The value walk covers the ways a module can hold the graph without ever
 * writing its name: a property read (`result.graph`), an element read
 * (`result['graph']`), a destructured binding (`const { graph } = result`)
 * and a parameter that receives the graph. Each of them is a hit only when
 * the checker resolves the accessed value to the canonical graph type.
 */
export function graphReferencesIn(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  graphType?: ts.Type,
): GraphReferences {
  const found = new Set<string>()
  const accesses: GraphValueAccess[] = []
  let examined = 0
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && GRAPH_SYMBOLS.includes(node.text)) {
      const resolved = resolveGraphSymbol(checker, node)
      if (resolved) found.add(resolved)
    }
    if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
      const moduleSpecifier = enclosingModuleSpecifier(node)
      if (moduleSpecifier) {
        const imported = node.propertyName?.text ?? node.name.text
        const resolved = resolveImportedGraphSymbol(
          checker,
          moduleSpecifier,
          imported,
        )
        if (resolved) found.add(resolved)
      }
    }
    if (ts.isNamespaceImport(node)) {
      // The namespace import's parent is the import clause; the module
      // specifier lives on the import declaration above it.
      const declaration = node.parent.parent
      if (
        ts.isImportDeclaration(declaration) &&
        ts.isStringLiteral(declaration.moduleSpecifier)
      ) {
        for (const name of exportedGraphSymbols(
          checker,
          declaration.moduleSpecifier,
        ))
          found.add(name)
      }
    }
    if (graphType) {
      if (
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node) ||
        ts.isBindingElement(node) ||
        ts.isParameter(node)
      )
        examined += 1
      const access = graphValueAccess(sourceFile, checker, node, graphType)
      if (access) {
        accesses.push(access)
        found.add(access.symbol)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { symbols: found, accesses, examined }
}

/**
 * The graph-bearing value access a node performs, when the checker can prove
 * one. The node is a property access, an element access, a destructured
 * binding or a parameter.
 */
function graphValueAccess(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  node: ts.Node,
  graphType: ts.Type,
): GraphValueAccess | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    const type = checker.getTypeAtLocation(node)
    if (!isGraphType(type, graphType, checker)) return undefined
    const symbol = checker.getSymbolAtLocation(node.name)
    const declared = symbol
      ? checker.getTypeOfSymbolAtLocation(symbol, node)
      : undefined
    if (!isGraphType(declared, graphType, checker)) return undefined
    return {
      kind: 'property',
      ...accessPosition(sourceFile, node),
      text: node.getText(sourceFile),
      symbol: GRAPH_TYPE_NAME,
    }
  }
  if (ts.isElementAccessExpression(node)) {
    const type = checker.getTypeAtLocation(node)
    if (!isGraphType(type, graphType, checker)) return undefined
    return {
      kind: 'element',
      ...accessPosition(sourceFile, node),
      text: node.getText(sourceFile),
      symbol: GRAPH_TYPE_NAME,
    }
  }
  if (ts.isBindingElement(node)) {
    const symbol = checker.getSymbolAtLocation(node.name)
    if (!symbol) return undefined
    const declared = checker.getTypeOfSymbolAtLocation(symbol, node)
    if (!isGraphType(declared, graphType, checker)) return undefined
    return {
      kind: 'binding',
      ...accessPosition(sourceFile, node),
      text: node.getText(sourceFile),
      symbol: GRAPH_TYPE_NAME,
    }
  }
  if (ts.isParameter(node)) {
    const symbol = checker.getSymbolAtLocation(node.name)
    if (!symbol) return undefined
    const declared = checker.getTypeOfSymbolAtLocation(symbol, node)
    if (!isGraphType(declared, graphType, checker)) return undefined
    return {
      kind: 'parameter',
      ...accessPosition(sourceFile, node),
      text: node.getText(sourceFile),
      symbol: GRAPH_TYPE_NAME,
    }
  }
  return undefined
}

/** The 1-based position of a node in its source file. */
function accessPosition(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  )
  return { line: line + 1, column: character + 1 }
}

/**
 * The textual import extractor of the existing boundary harness: for an
 * `.astro` file it reads the frontmatter and the inline scripts, and for every
 * file it parses the imports, re-exports, import types and dynamic imports.
 */
export function importedPaths(source: string, file: string): string[] {
  if (file.endsWith('.astro')) {
    const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? ''
    const scripts = [
      ...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),
    ].map((match) => match[1])
    source = [frontmatter, ...scripts].join('\n')
  }
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
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

const MODULE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.js',
  '.mjs',
  '.cjs',
  '.astro',
  '.json',
]

/** Resolve a module specifier that a source file uses to a real file. */
export function resolveModuleSpecifier(
  fromFile: string,
  specifier: string,
): string | undefined {
  let base: string | undefined
  if (specifier.startsWith('@/'))
    base = resolve(REPOSITORY_ROOT, 'src', specifier.slice(2))
  else if (specifier.startsWith('.'))
    base = resolve(dirname(fromFile), specifier)
  if (!base) return undefined
  const candidates = [
    base,
    ...MODULE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...MODULE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ]
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not a file; try the next candidate.
    }
  }
  return undefined
}

export type AstroViolation = {
  file: string
  specifier: string
  target: string
  symbols: string[]
}

export type AstroScanOptions = {
  /** The `.astro` files to scan. Defaults to every `.astro` file under `src/`. */
  files?: string[]
  /** The directory the reported file paths are relative to. */
  base?: string
}

/**
 * Scan `.astro` files for a graph-symbol import.
 *
 * The `.astro` files are not in the TypeScript program, so the import
 * specifiers are extracted textually and the imported module is resolved
 * through the checker: a module that exports a graph symbol is a violation,
 * whatever the import calls it.
 */
export async function astroGraphImportViolations(
  analysis: ProgramAnalysis,
  options: AstroScanOptions = {},
): Promise<AstroViolation[]> {
  const base = options.base ?? REPOSITORY_ROOT
  const files =
    options.files ??
    (await collectFiles(resolve(REPOSITORY_ROOT, 'src'), new Set(['.astro'])))
  const violations: AstroViolation[] = []
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const specifier of importedPaths(source, file)) {
      const target = resolveModuleSpecifier(file, specifier)
      if (!target) continue
      const symbols = moduleGraphSymbols(analysis, target)
      if (symbols.size) {
        violations.push({
          file: relative(base, file).split(/[\\/]/).join('/'),
          specifier,
          target: relative(base, target).split(/[\\/]/).join('/'),
          symbols: [...symbols].sort(),
        })
        continue
      }
      // A module the program does not contain (an `.astro` file's import
      // target, for instance) is read from its own export declarations.
      const textual = await textualModuleGraphSymbols(target)
      if (!textual.size) continue
      violations.push({
        file: relative(base, file).split(/[\\/]/).join('/'),
        specifier,
        target: relative(base, target).split(/[\\/]/).join('/'),
        symbols: [...textual].sort(),
      })
    }
  }
  return violations
}

/**
 * The graph symbols a module file exports, resolved through the checker when
 * the module is part of the program and textually otherwise.
 */
export function moduleGraphSymbols(
  analysis: ProgramAnalysis,
  file: string,
): Set<string> {
  const sourceFile = analysis.sourceFiles.get(resolve(file))
  if (!sourceFile) return new Set()
  const found = new Set<string>()
  const moduleSymbol = analysis.checker.getSymbolAtLocation(sourceFile)
  if (!moduleSymbol) return found
  for (const exported of analysis.checker.getExportsOfModule(moduleSymbol)) {
    const name = graphSymbolOf(analysis.checker, exported)
    if (name) found.add(name)
  }
  return found
}

/**
 * The graph symbols a module exports, read from the module's own export
 * declarations. This is the fallback for a module the program does not
 * contain, which is the case for a module that only an `.astro` file imports.
 */
export async function textualModuleGraphSymbols(
  file: string,
): Promise<Set<string>> {
  const found = new Set<string>()
  let source: string
  try {
    source = await readFile(file, 'utf8')
  } catch {
    return found
  }
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const isExported = (node: ts.Node) =>
    (node as ts.HasModifiers).modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) === true
  const visit = (node: ts.Node): void => {
    if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const specifier of node.exportClause.elements) {
        const name = specifier.propertyName?.text ?? specifier.name.text
        if (GRAPH_SYMBOLS.includes(name)) found.add(name)
      }
    }
    if (
      (ts.isVariableStatement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      isExported(node)
    ) {
      const name = (node as ts.NamedDeclaration).name
      if (name && ts.isIdentifier(name) && GRAPH_SYMBOLS.includes(name.text))
        found.add(name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return found
}

/** Recursively collect the files under a directory with the given extensions. */
export async function collectFiles(
  directory: string,
  extensions: ReadonlySet<string>,
): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path, extensions)))
      continue
    }
    if (!entry.isFile()) continue
    const extension = entry.name.slice(entry.name.lastIndexOf('.'))
    if (extensions.size && !extensions.has(extension)) continue
    files.push(path)
  }
  return files.sort()
}

export type ResolvedClass = {
  name: string
  members: string[]
  files: string[]
  missing: string[]
}

/** Resolve every named graph-free class to a concrete file list. */
export async function resolveGraphFreeClasses(): Promise<ResolvedClass[]> {
  const resolved: ResolvedClass[] = []
  for (const definition of GRAPH_FREE_MODULE_CLASSES) {
    const files: string[] = []
    const missing: string[] = []
    for (const member of definition.members) {
      const absolute = resolve(REPOSITORY_ROOT, member)
      if (!/\.[A-Za-z0-9]+$/.test(member)) {
        // A directory member: every file under it is in the class.
        const found = await collectFiles(absolute, new Set())
        if (!found.length) missing.push(member)
        files.push(...found)
        continue
      }
      try {
        if (!statSync(absolute).isFile()) {
          missing.push(member)
          continue
        }
      } catch {
        missing.push(member)
        continue
      }
      files.push(absolute)
    }
    resolved.push({
      name: definition.name,
      members: [...definition.members],
      files: files.map(repoRelative).sort(),
      missing,
    })
  }
  return resolved
}

/** The graph symbol names a plain text file mentions, if any. */
export function textGraphSymbols(source: string): string[] {
  return GRAPH_SYMBOLS.filter((symbol) =>
    new RegExp(`\\b${symbol}\\b`).test(source),
  )
}

export type ProbeResult = {
  root: string
  references: Map<string, Set<string>>
  /** One line per referencing probe file: `<file> -> <symbols>`. */
  violations: string[]
  /** The `.astro` probes that import a graph symbol. */
  astroViolations: AstroViolation[]
  /**
   * One line per graph-bearing value access the probes perform:
   * `<file>:<line>:<column> -> <symbol> (<access>)`.
   */
  propertyAccesses: string[]
}

/**
 * The violation line of a referencing module: the file, the graph symbols it
 * names and the graph-bearing values it reads.
 *
 * The access text is part of the line so that a violation names the read that
 * caused it and not only the module that performed it.
 */
export function violationLine(
  file: string,
  symbols: Iterable<string>,
  accesses: readonly GraphValueAccess[] = [],
): string {
  const named = [...symbols].sort().join(', ')
  const reads = accesses.map((access) => access.text)
  if (!reads.length) return `${file} -> ${named}`
  return `${file} -> ${named} (${reads.join(', ')})`
}

/**
 * Run the guard's analysis over synthetic probe modules.
 *
 * The probes live in a temporary directory outside the repository, so the
 * guard's own tree is never touched, and they are analysed by the same
 * checker-based analysis the repository itself is analysed by.
 */
export async function analyzeProbes(
  build: (root: string) => Record<string, string>,
): Promise<ProbeResult> {
  const root = await mkdtemp(join(tmpdir(), 'publication-graph-probe-'))
  try {
    const written: string[] = []
    for (const [name, source] of Object.entries(build(root))) {
      const path = join(root, name)
      await writeFile(path, source, 'utf8')
      written.push(path)
    }
    const analysis = analyzeProgram(written, programOptions())
    const violations: string[] = []
    const propertyAccesses: string[] = []
    for (const [file, symbols] of analysis.references) {
      // The definition module is the schema itself; it is the permitted
      // importer, not a probe.
      if (repoRelative(file) === GRAPH_SCHEMA_MODULE) continue
      const accesses = analysis.accesses.get(file) ?? []
      violations.push(
        violationLine(
          relative(root, file).split(/[\\/]/).join('/'),
          symbols,
          accesses,
        ),
      )
    }
    for (const [file, accesses] of analysis.accesses) {
      if (repoRelative(file) === GRAPH_SCHEMA_MODULE) continue
      for (const access of accesses) {
        propertyAccesses.push(
          `${relative(root, file).split(/[\\/]/).join('/')}:${access.line}:${access.column} -> ${access.symbol} (${access.text})`,
        )
      }
    }
    const astroFiles = written.filter((file) => file.endsWith('.astro'))
    const astroViolations = await astroGraphImportViolations(analysis, {
      files: astroFiles,
      base: root,
    })
    return {
      root,
      references: analysis.references,
      violations: violations.sort(),
      astroViolations,
      propertyAccesses: propertyAccesses.sort(),
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** The module specifier a probe uses to reach the graph schema module. */
export function probeSchemaSpecifier(root: string): string {
  const withoutExtension = SCHEMA_FILE.replace(/\.ts$/, '')
  return relative(root, withoutExtension).split(/[\\/]/).join('/')
}

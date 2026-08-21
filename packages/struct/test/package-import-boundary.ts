import { lstat, readFile, readdir } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import * as ts from 'typescript'

export type ImportBoundaryViolation = {
  code: string
  importer: string
  offset: number
  specifier?: string
  resolvedTarget?: string
  message: string
}

const reservedCapabilities = new Set([
  'createRequire',
  'getBuiltinModule',
  'global',
  'globalThis',
  'eval',
  'Function',
  'module',
  'process',
  'require',
])

const forbiddenResolutionOptions = new Set([
  'baseUrl',
  'paths',
  'rootDirs',
  'typeRoots',
])

const forbiddenDialectOptions = new Set(['importHelpers'])
const forbiddenModuleKinds = new Set([ts.ModuleKind.AMD, ts.ModuleKind.UMD])

export async function auditPackageImportBoundary(
  packageRoot: string,
): Promise<readonly ImportBoundaryViolation[]> {
  const packagePath = resolve(packageRoot)
  const sourceRoot = resolve(packagePath, 'src')
  const violations: ImportBoundaryViolation[] = []
  const sourceFiles = new Set<string>()

  await enumerateSources(sourceRoot, packagePath, sourceFiles, violations)

  const configPath = resolve(packagePath, 'tsconfig.json')
  const configRead = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configRead.error) {
    violations.push(
      violation(
        packagePath,
        packagePath,
        0,
        'invalid-tsconfig',
        flattenMessage(configRead.error.messageText),
      ),
    )
    return sortViolations(violations)
  }

  const config = configRead.config as {
    compilerOptions?: Record<string, unknown>
    references?: unknown
  }
  const rawCompilerOptions = config.compilerOptions ?? {}
  const parsed = ts.parseJsonConfigFileContent(
    configRead.config,
    ts.sys,
    packagePath,
    undefined,
    configPath,
  )
  for (const option of forbiddenResolutionOptions) {
    const parsedOption = parsedOptionValue(option, parsed.options)
    if (option in rawCompilerOptions || parsedOption !== undefined) {
      violations.push(
        violation(
          packagePath,
          configPath,
          0,
          'resolution-indirection-not-allowed',
          `compiler option ${option} is not permitted`,
        ),
      )
    }
  }
  for (const option of forbiddenDialectOptions) {
    const parsedOption = parsedOptionValue(option, parsed.options)
    if (option in rawCompilerOptions || parsedOption !== undefined) {
      violations.push(
        violation(
          packagePath,
          configPath,
          0,
          'compiler-option-not-allowed',
          `compiler option ${option} is not permitted by the package dialect`,
          undefined,
          option,
        ),
      )
    }
  }
  if (
    parsed.options.module !== undefined &&
    forbiddenModuleKinds.has(parsed.options.module)
  ) {
    violations.push(
      violation(
        packagePath,
        configPath,
        0,
        'compiler-option-not-allowed',
        'compiler option module is not permitted by the package dialect',
        undefined,
        'module',
      ),
    )
  }
  if ('extends' in config) {
    violations.push(
      violation(
        packagePath,
        configPath,
        0,
        'resolution-indirection-not-allowed',
        'tsconfig extends is not permitted',
      ),
    )
  }
  if (config.references !== undefined) {
    violations.push(
      violation(
        packagePath,
        configPath,
        0,
        'resolution-indirection-not-allowed',
        'project references are not permitted',
      ),
    )
  }

  if (parsed.errors.length > 0) {
    for (const diagnostic of parsed.errors) {
      violations.push(
        violation(
          packagePath,
          configPath,
          0,
          'invalid-tsconfig',
          flattenMessage(diagnostic.messageText),
        ),
      )
    }
  }

  const configuredRoot = parsed.options.rootDir
    ? resolve(parsed.options.rootDir)
    : undefined
  if (configuredRoot !== sourceRoot) {
    violations.push(
      violation(
        packagePath,
        configPath,
        0,
        'root-dir-not-source',
        'rootDir must resolve exactly to src',
        configuredRoot,
      ),
    )
  }
  const configuredFiles = new Set(
    parsed.fileNames.map((fileName) => resolve(fileName)),
  )
  if (!sameSet(configuredFiles, sourceFiles)) {
    violations.push(
      violation(
        packagePath,
        configPath,
        0,
        'configured-source-set-mismatch',
        'tsconfig root files must equal the canonical source set',
      ),
    )
  }

  const packageManifest = JSON.parse(
    await readFile(resolve(packagePath, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, unknown> }
  const dependencies = packageManifest.dependencies ?? {}
  const program = ts.createProgram({
    rootNames: [...sourceFiles],
    options: parsed.options,
  })
  const resolutionCache = ts.createModuleResolutionCache(
    packagePath,
    (fileName) =>
      ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
    parsed.options,
  )

  for (const sourceFile of program.getSourceFiles()) {
    const sourcePath = resolve(sourceFile.fileName)
    if (!sourceFiles.has(sourcePath)) {
      if (
        !program.isSourceFileFromExternalLibrary(sourceFile) &&
        !program.isSourceFileDefaultLibrary(sourceFile)
      ) {
        violations.push(
          violation(
            packagePath,
            sourcePath,
            0,
            'source-closure-outside-source',
            'compiler source closure leaves the package source set',
            sourcePath,
          ),
        )
      }
      continue
    }
    const source = await readFile(sourcePath, 'utf8')
    const syntax = ts.createSourceFile(
      sourcePath,
      source,
      parsed.options.target ?? ts.ScriptTarget.Latest,
      true,
    )
    const importer = displayPath(packagePath, sourcePath)
    const preprocessed = ts.preProcessFile(source, true, true)
    for (const reference of [
      ...preprocessed.referencedFiles,
      ...preprocessed.typeReferenceDirectives,
      ...preprocessed.libReferenceDirectives,
    ]) {
      violations.push(
        violation(
          packagePath,
          importer,
          reference.pos,
          'reference-directive-not-allowed',
          reference.fileName,
          undefined,
          reference.fileName,
        ),
      )
    }

    collectStaticEdges(
      syntax,
      importer,
      packagePath,
      sourceFiles,
      dependencies,
      parsed.options,
      resolutionCache,
      violations,
      collectDialectViolations(syntax, importer, packagePath, violations),
    )
  }

  return sortViolations(violations)
}

async function enumerateSources(
  sourceRoot: string,
  packageRoot: string,
  sourceFiles: Set<string>,
  violations: ImportBoundaryViolation[],
) {
  let rootStat
  try {
    rootStat = await lstat(sourceRoot)
  } catch {
    violations.push(
      violation(
        packageRoot,
        sourceRoot,
        0,
        'source-root-missing',
        'src is missing',
      ),
    )
    return
  }
  if (rootStat.isSymbolicLink()) {
    violations.push(
      violation(
        packageRoot,
        sourceRoot,
        0,
        'source-symlink-not-allowed',
        'source root may not be a symbolic link',
      ),
    )
    return
  }

  async function visit(directory: string) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (a, b) => compareLexical(a.name, b.name),
    )
    for (const entry of entries) {
      const child = resolve(directory, entry.name)
      const childStat = await lstat(child)
      if (childStat.isSymbolicLink()) {
        violations.push(
          violation(
            packageRoot,
            child,
            0,
            'source-symlink-not-allowed',
            'source files and directories may not be symbolic links',
          ),
        )
      } else if (childStat.isDirectory()) {
        await visit(child)
      } else if (childStat.isFile() && /\.(?:ts|tsx)$/iu.test(extname(child))) {
        sourceFiles.add(child)
      }
    }
  }
  await visit(sourceRoot)
}

function collectStaticEdges(
  sourceFile: ts.SourceFile,
  importer: string,
  packageRoot: string,
  sourceFiles: Set<string>,
  dependencies: Record<string, unknown>,
  options: ts.CompilerOptions,
  cache: ts.ModuleResolutionCache,
  violations: ImportBoundaryViolation[],
  skipJsxRuntime = false,
) {
  const check = (node: ts.Node, literal: ts.StringLiteralLike) => {
    checkModuleSpecifier(
      literal.text,
      literal.getStart(sourceFile),
      importer,
      packageRoot,
      sourceFiles,
      dependencies,
      options,
      cache,
      violations,
    )
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      check(node, node.moduleSpecifier)
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      check(node, node.moduleSpecifier)
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      check(node, node.argument.literal)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const runtime = skipJsxRuntime
    ? undefined
    : jsxRuntimeSpecifier(sourceFile, options)
  if (runtime) {
    checkModuleSpecifier(
      runtime.specifier,
      runtime.offset,
      importer,
      packageRoot,
      sourceFiles,
      dependencies,
      options,
      cache,
      violations,
    )
  }
}

function checkModuleSpecifier(
  specifier: string,
  offset: number,
  importer: string,
  packageRoot: string,
  sourceFiles: Set<string>,
  dependencies: Record<string, unknown>,
  options: ts.CompilerOptions,
  cache: ts.ModuleResolutionCache,
  violations: ImportBoundaryViolation[],
) {
  if (
    specifier.includes('%') ||
    specifier.includes('\\') ||
    specifier.includes('\0')
  ) {
    violations.push(
      violation(
        packageRoot,
        importer,
        offset,
        'unsafe-module-specifier',
        'module specifier contains an encoded or platform escape',
        undefined,
        specifier,
      ),
    )
    return
  }
  if (isAbsoluteModuleSpecifier(specifier)) {
    violations.push(
      violation(
        packageRoot,
        importer,
        offset,
        'unsafe-module-specifier',
        'absolute module specifiers are not part of the package dialect',
        undefined,
        specifier,
      ),
    )
    return
  }
  if (isLoaderSpecifier(specifier)) {
    violations.push(
      violation(
        packageRoot,
        importer,
        offset,
        'loader-module-not-allowed',
        'module loader and process modules are outside the package dialect',
        undefined,
        specifier,
      ),
    )
    return
  }
  if (specifier.startsWith('node:')) {
    violations.push(
      violation(
        packageRoot,
        importer,
        offset,
        'node-builtin-not-allowed',
        'Node builtin modules are not part of the package source dialect',
        undefined,
        specifier,
      ),
    )
    return
  }
  const relativeImport =
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  const packageName = barePackageName(specifier)
  if (
    !relativeImport &&
    packageName &&
    /(?:^|\/)(?:\.|\.\.)(?:\/|$)/u.test(specifier)
  ) {
    violations.push(
      violation(
        packageRoot,
        importer,
        offset,
        'unsafe-module-specifier',
        'dependency subpaths may not contain traversal segments',
        undefined,
        specifier,
      ),
    )
    return
  }
  if (
    !relativeImport &&
    packageName &&
    Object.prototype.hasOwnProperty.call(dependencies, packageName)
  ) {
    const declaration = dependencies[packageName]
    if (isNonPortableDependencyDeclaration(declaration)) {
      violations.push(
        violation(
          packageRoot,
          importer,
          offset,
          'non-portable-dependency',
          'runtime dependencies may not point into the repository',
          undefined,
          specifier,
        ),
      )
      return
    }
    const resolved = ts.resolveModuleName(
      specifier,
      resolve(packageRoot, importer),
      options,
      ts.sys,
      cache,
    ).resolvedModule
    if (!resolved || !resolved.isExternalLibraryImport) {
      violations.push(
        violation(
          packageRoot,
          importer,
          offset,
          'unresolved-module',
          'declared dependency does not resolve as an external library',
          resolved?.resolvedFileName,
          specifier,
        ),
      )
    }
    return
  }
  const resolved = ts.resolveModuleName(
    specifier,
    resolve(packageRoot, importer),
    options,
    ts.sys,
    cache,
  ).resolvedModule
  const resolvedTarget = resolved?.resolvedFileName
    ? resolve(resolved.resolvedFileName)
    : undefined
  if (!resolvedTarget) {
    violations.push(
      violation(
        packageRoot,
        importer,
        offset,
        'unresolved-module',
        'module specifier does not resolve',
        undefined,
        specifier,
      ),
    )
  } else if (relativeImport && !sourceFiles.has(resolvedTarget)) {
    violations.push(
      violation(
        packageRoot,
        importer,
        offset,
        'relative-outside-source',
        'relative module resolves outside the canonical source set',
        resolvedTarget,
        specifier,
      ),
    )
  } else if (!relativeImport) {
    violations.push(
      violation(
        packageRoot,
        importer,
        offset,
        'undeclared-runtime-dependency',
        'bare module is not an exact declared runtime dependency',
        resolvedTarget,
        specifier,
      ),
    )
  }
}

function isNonPortableDependencyDeclaration(declaration: unknown) {
  if (typeof declaration !== 'string') return true
  const trimmed = declaration.trim()
  if (trimmed.length === 0 || trimmed !== declaration) return true
  return (
    /^(?:file|link|workspace|git\+file):/iu.test(trimmed) ||
    /^~(?:[\\/]|$)/u.test(trimmed) ||
    /^[A-Za-z]:/u.test(trimmed) ||
    /^(?:\.\.?[\\/]|[\\/])/u.test(trimmed) ||
    trimmed.includes('\\') ||
    (!trimmed.includes(':') && /\.(?:tgz|tar\.gz|tar)$/iu.test(trimmed))
  )
}

function normalizePath(fileName: string) {
  return fileName.replaceAll('\\', '/')
}

function jsxRuntimeSpecifier(
  sourceFile: ts.SourceFile,
  options: ts.CompilerOptions,
) {
  if (
    options.jsx !== ts.JsxEmit.ReactJSX &&
    options.jsx !== ts.JsxEmit.ReactJSXDev
  ) {
    return undefined
  }
  const importSource = options.jsxImportSource ?? 'react'
  let offset: number | undefined
  const visit = (node: ts.Node) => {
    if (
      offset === undefined &&
      (ts.isJsxElement(node) ||
        ts.isJsxSelfClosingElement(node) ||
        ts.isJsxFragment(node))
    ) {
      offset = node.getStart(sourceFile)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return offset === undefined
    ? undefined
    : {
        offset,
        specifier: `${importSource}/${
          options.jsx === ts.JsxEmit.ReactJSXDev
            ? 'jsx-dev-runtime'
            : 'jsx-runtime'
        }`,
      }
}

function collectDialectViolations(
  sourceFile: ts.SourceFile,
  importer: string,
  packageRoot: string,
  violations: ImportBoundaryViolation[],
) {
  const hasUnsupportedJsxPragma = collectJsxPragmaViolations(
    sourceFile,
    importer,
    packageRoot,
    violations,
  )
  const visit = (node: ts.Node) => {
    if (ts.isImportEqualsDeclaration(node)) {
      violations.push(
        violation(
          packageRoot,
          importer,
          node.getStart(sourceFile),
          'import-equals-not-allowed',
          'ImportEquals is not part of the package source dialect',
        ),
      )
      return
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0]
      const specifier =
        argument && ts.isStringLiteral(argument) ? argument.text : undefined
      violations.push(
        violation(
          packageRoot,
          importer,
          node.getStart(sourceFile),
          'dynamic-import-not-allowed',
          'dynamic import is not part of the package source dialect',
          undefined,
          specifier,
        ),
      )
    }
    if (ts.isIdentifier(node) && reservedCapabilities.has(node.text)) {
      const code =
        node.text === 'eval' || node.text === 'Function'
          ? 'runtime-codegen-not-allowed'
          : 'reserved-capability-not-allowed'
      violations.push(
        violation(
          packageRoot,
          importer,
          node.getStart(sourceFile),
          code,
          `${node.text} is reserved by the package source dialect`,
          undefined,
          node.text,
        ),
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return hasUnsupportedJsxPragma
}

function collectJsxPragmaViolations(
  sourceFile: ts.SourceFile,
  importer: string,
  packageRoot: string,
  violations: ImportBoundaryViolation[],
) {
  let found = false
  for (const comment of ts.getLeadingCommentRanges(sourceFile.text, 0) ?? []) {
    if (comment.kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue
    const text = sourceFile.text.slice(comment.pos, comment.end)
    let lineStart = 0
    for (const line of text.split(/\r\n|[\r\n\u2028\u2029]/u)) {
      const at = line.indexOf('@')
      if (at >= 0) {
        const match = /^@(\S+)/u.exec(line.slice(at))
        if (match) {
          const name = match[1].toLowerCase()
          if (name === 'jsxruntime' || name === 'jsximportsource') {
            found = true
            const specifier =
              name === 'jsxruntime' ? '@jsxRuntime' : '@jsxImportSource'
            violations.push(
              violation(
                packageRoot,
                importer,
                comment.pos + lineStart + at,
                'jsx-pragma-not-allowed',
                `${specifier} is not part of the package source dialect`,
                undefined,
                specifier,
              ),
            )
          }
        }
      }
      lineStart += line.length
      if (lineStart < text.length) {
        lineStart += text.startsWith('\r\n', lineStart) ? 2 : 1
      }
    }
  }
  return found
}

function violation(
  packageRoot: string,
  importer: string,
  offset: number,
  code: string,
  message: string,
  resolvedTarget?: string,
  specifier?: string,
): ImportBoundaryViolation {
  const normalizedImporter = normalizePath(importer)
  return {
    code,
    importer: isAbsolutePath(normalizedImporter)
      ? displayPath(packageRoot, normalizedImporter)
      : normalizedImporter,
    offset,
    ...(specifier === undefined ? {} : { specifier }),
    ...(resolvedTarget === undefined
      ? {}
      : { resolvedTarget: normalizePath(resolvedTarget) }),
    message,
  }
}

function displayPath(packageRoot: string, fileName: string) {
  return (
    normalizePath(
      relative(normalizePath(packageRoot), normalizePath(fileName)),
    ) || normalizePath(fileName)
  )
}

function sortViolations(violations: ImportBoundaryViolation[]) {
  return violations.sort(
    (a, b) =>
      compareLexical(a.importer, b.importer) ||
      a.offset - b.offset ||
      compareLexical(a.code, b.code),
  )
}

function compareLexical(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function sameSet(left: Set<string>, right: Set<string>) {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  )
}

function parsedOptionValue(option: string, options: ts.CompilerOptions) {
  return (options as ts.CompilerOptions & Record<string, unknown>)[option]
}

function barePackageName(specifier: string) {
  if (specifier.startsWith('.') || isAbsoluteModuleSpecifier(specifier))
    return undefined
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function isAbsoluteModuleSpecifier(specifier: string) {
  const normalized = normalizePath(specifier)
  return (
    normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    /^[A-Za-z]:\//u.test(normalized)
  )
}

function isAbsolutePath(fileName: string) {
  return isAbsoluteModuleSpecifier(fileName)
}

function isLoaderSpecifier(specifier: string) {
  return (
    specifier === 'module' ||
    specifier === 'process' ||
    specifier === 'node:module' ||
    specifier === 'node:process'
  )
}

function flattenMessage(message: string | ts.DiagnosticMessageChain): string {
  return typeof message === 'string'
    ? message
    : ts.flattenDiagnosticMessageText(message, ' ')
}

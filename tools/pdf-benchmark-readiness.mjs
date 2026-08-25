#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { builtinModules, createRequire } from 'node:module'
import { dirname, extname, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import ts from 'typescript'
import {
  canonicalJson,
  validatePdfFidelityEvalSet,
} from './pdf-fidelity-eval.mjs'

export const PDF_BENCHMARK_READINESS_SCHEMA_VERSION = '1.0.0'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const LEGACY_SCHEMA_PATH = resolve(
  REPOSITORY_ROOT,
  'docs/schemas/pdf-benchmark-readiness-registry.schema.json',
)
const V2_SCHEMA_PATH = resolve(
  REPOSITORY_ROOT,
  'docs/schemas/pdf-benchmark-readiness-registry-v2.schema.json',
)
const DEFAULT_SCHEMA_PATH = resolve(
  REPOSITORY_ROOT,
  'docs/schemas/pdf-benchmark-readiness-registry-v3.schema.json',
)
const SCHEMA_BINDINGS = new Map([
  [
    '1.0.0',
    {
      path: LEGACY_SCHEMA_PATH,
      id: 'https://ernie.sg/schemas/pdf-benchmark-readiness-registry-1.0.0.json',
      fileSha256:
        '3dd77733e86da34b9810afeab607c1f325d4b70fa43c2c8116dd30d3cd5c4ff9',
    },
  ],
  [
    '2.0.0',
    {
      path: V2_SCHEMA_PATH,
      id: 'https://ernie.sg/schemas/pdf-benchmark-readiness-registry-2.0.0.json',
      fileSha256:
        'af358f8b3fce3cc1bbe90a38a11f31ac9904865bddd83e32d6c452e5c36ab4c7',
    },
  ],
  [
    '3.0.0',
    {
      path: DEFAULT_SCHEMA_PATH,
      id: 'https://ernie.sg/schemas/pdf-benchmark-readiness-registry-3.0.0.json',
      fileSha256:
        'fccf1727399b425f1f92a4ab339c96ecf759cd0ac673988cbf4db6ae5d514700',
    },
  ],
])
const PUBLIC_ERROR_CODE = /^(?:INVALID|MISSING|PDF)_[A-Z0-9_]+$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/
const SAFE_FAILURE_CLASS = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,11}$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_GOVERNANCE_JSON_BYTES = 16 * 1024 * 1024
const PROMOTION_PROTOCOL_IMPLEMENTED = false
const CANDIDATE_COMPONENT_KINDS = [
  'provider',
  'model',
  'adapter',
  'prompt',
  'config',
  'seed',
  'runtime',
]
const REQUIRED_METRICS = [
  'prose-transcript',
  'inline-semantics',
  'caption-completeness-and-ownership',
  'table-content-and-header-topology',
  'formula-content-and-layout',
  'bibliography-cardinality-and-content',
  'note-anchor-body-placement-and-content',
  'whole-document-reading-order',
  'profile-clipping-and-legibility',
  'abstention-risk-coverage',
  'review-gate-precision-recall',
  'package-integrity',
]
const BUILTIN_MODULES = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
)

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function invalid(code) {
  throw new Error(code)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  )
}

function unique(values) {
  return new Set(values).size === values.length
}

function sortedUnique(values) {
  return [...new Set(values)].sort()
}

function canonicalRepositoryPath(repositoryPath) {
  if (
    typeof repositoryPath !== 'string' ||
    repositoryPath.length === 0 ||
    repositoryPath.startsWith('/') ||
    repositoryPath.includes('\\') ||
    repositoryPath
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..') ||
    posix.normalize(repositoryPath) !== repositoryPath
  ) {
    invalid('INVALID_PDF_BENCHMARK_REPOSITORY_PATH')
  }
  return repositoryPath
}

function resolveRepositoryPath(
  repositoryPath,
  repositoryRoot = REPOSITORY_ROOT,
) {
  const canonical = canonicalRepositoryPath(repositoryPath)
  const absolute = resolve(repositoryRoot, canonical)
  if (
    absolute !== repositoryRoot &&
    !absolute.startsWith(`${repositoryRoot}${sep}`)
  ) {
    invalid('INVALID_PDF_BENCHMARK_REPOSITORY_PATH')
  }
  return absolute
}

async function readJsonArtifact(path, code) {
  try {
    const absolute = resolve(path)
    const details = await lstat(absolute)
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.size <= 0 ||
      details.size > MAX_GOVERNANCE_JSON_BYTES
    ) {
      invalid(code)
    }
    const bytes = await readFile(absolute)
    if (bytes.byteLength !== details.size) invalid(code)
    return {
      value: JSON.parse(bytes.toString('utf8')),
      bytes,
      fileSha256: sha256(bytes),
    }
  } catch {
    invalid(code)
  }
}

async function validateSchema(registry, schemaPath) {
  const binding = SCHEMA_BINDINGS.get(registry?.schemaVersion)
  const selectedPath = schemaPath ? resolve(schemaPath) : binding?.path
  if (!binding || selectedPath !== binding.path) {
    invalid('INVALID_PDF_BENCHMARK_REGISTRY_SCHEMA')
  }
  const schemaArtifact = await readJsonArtifact(
    selectedPath,
    'INVALID_PDF_BENCHMARK_REGISTRY_SCHEMA',
  )
  if (
    schemaArtifact.value.$id !== binding.id ||
    schemaArtifact.fileSha256 !== binding.fileSha256
  ) {
    invalid('INVALID_PDF_BENCHMARK_REGISTRY_SCHEMA')
  }
  const validate = new Ajv2020({ strict: false }).compile(schemaArtifact.value)
  if (!validate(registry)) {
    const detail = (validate.errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ')
    const failure = new Error('INVALID_PDF_BENCHMARK_REGISTRY')
    failure.cause = detail
    throw failure
  }
  return {
    id: schemaArtifact.value.$id,
    fileSha256: schemaArtifact.fileSha256,
  }
}

async function verifyRepositoryFileBinding(
  repositoryPath,
  expectedSha256,
  code = 'PDF_BENCHMARK_METRIC_BINDING_MISMATCH',
  repositoryRoot = REPOSITORY_ROOT,
) {
  try {
    const canonical = canonicalRepositoryPath(repositoryPath)
    const absolute = resolveRepositoryPath(canonical, repositoryRoot)
    const [details, repositoryRealPath, fileRealPath] = await Promise.all([
      lstat(absolute),
      realpath(repositoryRoot),
      realpath(absolute),
    ])
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      (fileRealPath !== repositoryRealPath &&
        !fileRealPath.startsWith(`${repositoryRealPath}${sep}`))
    ) {
      invalid(code)
    }
    const actualPath = relative(repositoryRealPath, fileRealPath)
      .split(sep)
      .join('/')
    if (actualPath !== canonical) invalid(code)
    const bytes = await readFile(fileRealPath)
    if (sha256(bytes) !== expectedSha256) {
      invalid(code)
    }
    return bytes
  } catch {
    invalid(code)
  }
}

function metricImplementationCompositeSha256(metric) {
  const packageBinding = metric.implementationPackageLock
    ? {
        kind: 'pdf-benchmark-metric-implementation-v3',
        entrypoint: metric.implementation,
        components: metric.implementationComponents
          .map((component) => ({
            path: component.path,
            fileSha256: component.fileSha256,
          }))
          .sort((left, right) => left.path.localeCompare(right.path)),
        packageLock: metric.implementationPackageLock,
        platforms: [...metric.implementationPlatforms].sort(),
        ...(metric.implementationPlatformTreeEvidence
          ? {
              platformTreeEvidence:
                metric.implementationPlatformTreeEvidence,
            }
          : {}),
        ...(metric.test && metric.testSha256
          ? { test: { path: metric.test, fileSha256: metric.testSha256 } }
          : {}),
        packages: metric.implementationPackages
          .map((package_) => ({
            path: package_.path,
            name: package_.name,
            version: package_.version,
            integrity: package_.integrity,
            treeSha256: package_.treeSha256,
            ...(package_.platforms
              ? { platforms: [...package_.platforms].sort() }
              : {}),
          }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      }
    : {
        kind: 'pdf-benchmark-metric-implementation-v1',
        entrypoint: metric.implementation,
        components: metric.implementationComponents
          .map((component) => ({
            path: component.path,
            fileSha256: component.fileSha256,
          }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      }
  return sha256(canonicalJson(packageBinding))
}

function executableModuleSpecifiers(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : /\.(?:cts|mts|ts)$/u.test(fileName)
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS,
  )
  const specifiers = []
  const createRequireIdentifiers = new Set()
  const requireIdentifiers = new Set(['require'])
  function collectRequireBindings(node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      ['node:module', 'module'].includes(node.moduleSpecifier.text) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements)
        if ((element.propertyName ?? element.name).text === 'createRequire')
          createRequireIdentifiers.add(element.name.text)
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      createRequireIdentifiers.has(node.initializer.expression.text)
    ) {
      requireIdentifiers.add(node.name.text)
    } else if (
      ts.isParameter(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isPropertyAccessExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      requireIdentifiers.has(node.initializer.expression.text) &&
      node.initializer.name.text === 'resolve'
    ) {
      requireIdentifiers.add(node.name.text)
    }
    ts.forEachChild(node, collectRequireBindings)
  }
  collectRequireBindings(sourceFile)
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      if (node.isTypeOnly || node.importClause?.isTypeOnly) return
      if (!ts.isStringLiteral(node.moduleSpecifier))
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      specifiers.push(node.arguments[0].text)
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      requireIdentifiers.has(node.expression.text)
    ) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      specifiers.push(node.arguments[0].text)
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      requireIdentifiers.has(node.expression.expression.text) &&
      node.expression.name.text === 'resolve'
    ) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

function viteSsrModuleSpecifiers(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.(?:cts|mts|ts)$/u.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  )
  const specifiers = []
  function isImportMeta(node) {
    return (
      ts.isMetaProperty(node) &&
      node.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.name.text === 'meta'
    )
  }
  function isSsrLoadModuleProperty(node) {
    return (
      ts.isPropertyAccessExpression(node) && node.name.text === 'ssrLoadModule'
    )
  }
  function isImportMetaGlobProperty(node) {
    return (
      ts.isPropertyAccessExpression(node) &&
      isImportMeta(node.expression) &&
      ['glob', 'globEager'].includes(node.name.text)
    )
  }
  function isImportMetaGlobElement(node) {
    return (
      ts.isElementAccessExpression(node) &&
      isImportMeta(node.expression) &&
      ts.isStringLiteral(node.argumentExpression) &&
      ['glob', 'globEager'].includes(node.argumentExpression.text)
    )
  }
  function bindingContainsSsrLoadModule(name) {
    return (
      ts.isObjectBindingPattern(name) &&
      name.elements.some((element) => {
        const propertyName = element.propertyName
        const propertyText = propertyName?.getText(sourceFile)
        return (
          element.name.getText(sourceFile) === 'ssrLoadModule' ||
          propertyText === 'ssrLoadModule' ||
          propertyText === "'ssrLoadModule'" ||
          propertyText === '"ssrLoadModule"' ||
          propertyText === "['ssrLoadModule']" ||
          propertyText === '["ssrLoadModule"]'
        )
      })
    )
  }
  function bindingContainsImportMetaGlob(name) {
    return (
      ts.isObjectBindingPattern(name) &&
      name.elements.some((element) => {
        const propertyName = element.propertyName ?? element.name
        return ['glob', 'globEager'].includes(propertyName.getText(sourceFile))
      })
    )
  }
  function isImportMetaGlobAccessor(node) {
    return isImportMetaGlobProperty(node) || isImportMetaGlobElement(node)
  }
  function visit(node) {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      bindingContainsSsrLoadModule(node.name)
    )
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      node.initializer &&
      ((isImportMeta(node.initializer) &&
        (!ts.isObjectBindingPattern(node.name) ||
          bindingContainsImportMetaGlob(node.name))) ||
        isImportMetaGlobAccessor(node.initializer))
    )
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (isImportMeta(node.right) || isImportMetaGlobAccessor(node.right))
    )
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    if (ts.isCallExpression(node) && isSsrLoadModuleProperty(node.expression)) {
      if (
        node.expression.questionDotToken ||
        node.questionDotToken ||
        node.arguments.length !== 1 ||
        !ts.isStringLiteral(node.arguments[0])
      )
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      specifiers.push(node.arguments[0].text)
    }
    if (ts.isCallExpression(node) && isImportMetaGlobAccessor(node.expression))
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    if (
      ts.isElementAccessExpression(node) &&
      (isImportMetaGlobElement(node) ||
        node.argumentExpression === undefined ||
        (ts.isStringLiteral(node.argumentExpression) &&
          node.argumentExpression.text === 'ssrLoadModule') ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'vite'))
    )
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    if (
      isSsrLoadModuleProperty(node) &&
      (!ts.isCallExpression(node.parent) || node.parent.expression !== node)
    )
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

function canonicalLocalModuleSpecifier(specifier) {
  const segments = specifier.split('/')
  if (
    !specifier.startsWith('./') ||
    specifier.includes('\\') ||
    segments[0] !== '.' ||
    segments
      .slice(1)
      .some((segment) => !segment || segment === '.' || segment === '..')
  )
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  return specifier
}

function executableSourcePath(path) {
  return /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u.test(path)
}

function splitExecutableModuleSpecifier(specifier) {
  if (specifier.includes('#')) invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  const query = specifier.indexOf('?')
  if (query < 0) return { path: specifier, raw: false }
  if (
    specifier.slice(query) !== '?raw' ||
    specifier.indexOf('?', query + 1) >= 0
  )
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  return { path: specifier.slice(0, query), raw: true }
}

function canonicalViteRootSpecifier(specifier) {
  const parsed = splitExecutableModuleSpecifier(specifier)
  const segments = parsed.path.split('/')
  if (
    parsed.raw ||
    !parsed.path.startsWith('/src/') ||
    segments[0] !== '' ||
    segments.some((segment, index) =>
      index === 0 ? false : !segment || segment === '.' || segment === '..',
    )
  )
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  return parsed.path.slice(1)
}

function canonicalViteRelativeSpecifier(specifier, importerPath) {
  const parsed = splitExecutableModuleSpecifier(specifier)
  if (
    parsed.path.includes('\\') ||
    (!parsed.path.startsWith('./') && !parsed.path.startsWith('../'))
  )
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  const resolved = posix.normalize(
    posix.join(posix.dirname(importerPath), parsed.path),
  )
  canonicalRepositoryPath(resolved)
  const relativeSpecifier = posix.relative(
    posix.dirname(importerPath),
    resolved,
  )
  const canonicalSpecifier = relativeSpecifier.startsWith('.')
    ? relativeSpecifier
    : `./${relativeSpecifier}`
  if (canonicalSpecifier !== parsed.path)
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  return { path: resolved, raw: parsed.raw }
}

async function resolveRepositoryModulePath(
  repositoryPath,
  { repositoryRoot, raw = false },
) {
  const canonical = canonicalRepositoryPath(repositoryPath)
  const candidates =
    raw || extname(canonical)
      ? [canonical]
      : [
          canonical,
          ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map(
            (extension) => `${canonical}${extension}`,
          ),
          ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map(
            (extension) => `${canonical}/index${extension}`,
          ),
        ]
  const matches = []
  for (const candidate of candidates) {
    try {
      matches.push(
        await canonicalRepositoryFile(
          candidate,
          repositoryRoot,
          'PDF_BENCHMARK_METRIC_BINDING_MISMATCH',
        ),
      )
    } catch (error) {
      const absolute = resolveRepositoryPath(candidate, repositoryRoot)
      try {
        await lstat(absolute)
      } catch (detailsError) {
        if (detailsError?.code === 'ENOENT' || detailsError?.code === 'ENOTDIR')
          continue
      }
      throw error
    }
  }
  if (matches.length !== 1) invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  return matches[0]
}

async function canonicalRepositoryFile(repositoryPath, repositoryRoot, code) {
  const canonical = canonicalRepositoryPath(repositoryPath)
  const absolute = resolveRepositoryPath(canonical, repositoryRoot)
  const [details, rootRealPath, fileRealPath] = await Promise.all([
    lstat(absolute),
    realpath(repositoryRoot),
    realpath(absolute),
  ])
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    (fileRealPath !== rootRealPath &&
      !fileRealPath.startsWith(`${rootRealPath}${sep}`))
  ) {
    invalid(code)
  }
  const actualPath = relative(rootRealPath, fileRealPath).split(sep).join('/')
  if (actualPath !== canonical) invalid(code)
  return {
    path: canonical,
    realPath: fileRealPath,
    bytes: await readFile(fileRealPath),
  }
}

export async function deriveLocalExecutableImportClosure(
  entrypoint,
  { repositoryRoot = REPOSITORY_ROOT, includeViteGraph = true } = {},
) {
  const pending = [
    { path: canonicalRepositoryPath(entrypoint), viteGraph: false },
  ]
  const byPath = new Map()
  const pathsByRealPath = new Map()
  while (pending.length > 0) {
    const current = pending.pop()
    if (byPath.has(current.path)) continue
    let artifact
    try {
      artifact = await canonicalRepositoryFile(
        current.path,
        repositoryRoot,
        'PDF_BENCHMARK_METRIC_BINDING_MISMATCH',
      )
    } catch {
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    }
    const priorPath = pathsByRealPath.get(artifact.realPath)
    if (priorPath && priorPath !== artifact.path)
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    pathsByRealPath.set(artifact.realPath, artifact.path)
    byPath.set(artifact.path, artifact)
    if (!executableSourcePath(artifact.path)) continue
    const moduleSpecifiers = executableModuleSpecifiers(
      artifact.bytes.toString('utf8'),
      artifact.path,
    )
    if (
      moduleSpecifiers.some(
        (specifier) => specifier.startsWith('/') || specifier.startsWith('#'),
      )
    )
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    for (const specifier of moduleSpecifiers.filter((candidate) =>
      candidate.startsWith('.'),
    )) {
      if (current.viteGraph) {
        const imported = canonicalViteRelativeSpecifier(
          specifier,
          artifact.path,
        )
        const dependency = await resolveRepositoryModulePath(imported.path, {
          repositoryRoot,
          raw: imported.raw,
        })
        pending.push({ path: dependency.path, viteGraph: true })
      } else {
        const parsed = splitExecutableModuleSpecifier(specifier)
        if (parsed.raw) invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
        canonicalLocalModuleSpecifier(parsed.path)
        const importedPath = posix.join(
          posix.dirname(artifact.path),
          parsed.path,
        )
        canonicalRepositoryPath(importedPath)
        pending.push({ path: importedPath, viteGraph: false })
      }
    }
    if (includeViteGraph)
      for (const specifier of viteSsrModuleSpecifiers(
        artifact.bytes.toString('utf8'),
        artifact.path,
      )) {
        const dependency = await resolveRepositoryModulePath(
          canonicalViteRootSpecifier(specifier),
          { repositoryRoot },
        )
        pending.push({ path: dependency.path, viteGraph: true })
      }
  }
  return [...byPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  )
}

function barePackageName(specifier) {
  if (
    typeof specifier !== 'string' ||
    !specifier ||
    specifier.startsWith('.') ||
    BUILTIN_MODULES.has(specifier)
  )
    return null
  if (specifier.startsWith('/') || specifier.startsWith('#'))
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  const segments = specifier.split('/')
  const name = specifier.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : segments[0]
  if (!name || (specifier.startsWith('@') && segments.length < 2))
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  return name
}

async function findResolvedPackageRoot(
  specifier,
  expectedName,
  importerRealPath,
  repositoryRoot,
) {
  let resolvedPath
  try {
    resolvedPath = createRequire(pathToFileURL(importerRealPath)).resolve(
      specifier,
    )
  } catch {
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  }
  const repositoryRealPath = await realpath(repositoryRoot)
  let current = dirname(resolvedPath)
  while (
    current !== repositoryRealPath &&
    current.startsWith(`${repositoryRealPath}${sep}`)
  ) {
    try {
      const packageJsonPath = resolve(current, 'package.json')
      const details = await lstat(packageJsonPath)
      if (details.isFile() && !details.isSymbolicLink()) {
        const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
        if (packageJson.name === expectedName) return current
      }
    } catch {
      // Continue toward the repository root until the owning package is found.
    }
    current = dirname(current)
  }
  invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
}

function lockedDependencyPath(packagePath, dependencyName, lockPackages) {
  let current = packagePath
  while (current) {
    const candidate = `${current}/node_modules/${dependencyName}`
    if (lockPackages[candidate]) return candidate
    const parentMarker = current.lastIndexOf('/node_modules/')
    if (parentMarker < 0) break
    current = current.slice(0, parentMarker)
  }
  const rootCandidate = `node_modules/${dependencyName}`
  return lockPackages[rootCandidate] ? rootCandidate : null
}

function packageNameFromPath(packagePath) {
  const segments = packagePath.split('/')
  const marker = segments.lastIndexOf('node_modules')
  const name = segments.slice(marker + 1)
  if (
    marker < 0 ||
    name.length === 0 ||
    (name[0].startsWith('@') ? name.length !== 2 : name.length !== 1)
  )
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  return name.join('/')
}

function packageBindingMetadata(packages) {
  return packages.map(({ path, name, version, integrity, platforms }) => ({
    path,
    name,
    version,
    integrity,
    ...(platforms ? { platforms: [...platforms].sort() } : {}),
  }))
}

async function nestedNodeModulePackagePaths(packageRoot, repositoryRealPath) {
  const nodeModules = resolve(packageRoot, 'node_modules')
  let entries
  try {
    const details = await lstat(nodeModules)
    if (!details.isDirectory() || details.isSymbolicLink())
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    entries = await readdir(nodeModules, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  }
  const paths = []
  for (const entry of entries.sort((left, right) =>
    Buffer.from(left.name).compare(Buffer.from(right.name)),
  )) {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    const directory = resolve(nodeModules, entry.name)
    if (entry.name.startsWith('@')) {
      const scoped = await readdir(directory, { withFileTypes: true })
      for (const packageEntry of scoped.sort((left, right) =>
        Buffer.from(left.name).compare(Buffer.from(right.name)),
      )) {
        if (!packageEntry.isDirectory() || packageEntry.isSymbolicLink())
          invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
        paths.push(
          canonicalRepositoryPath(
            relative(repositoryRealPath, resolve(directory, packageEntry.name))
              .split(sep)
              .join('/'),
          ),
        )
      }
    } else {
      paths.push(
        canonicalRepositoryPath(
          relative(repositoryRealPath, directory).split(sep).join('/'),
        ),
      )
    }
  }
  return paths
}

function conditionMatches(values, actual) {
  if (!Array.isArray(values) || values.length === 0) return true
  if (values.includes(`!${actual}`)) return false
  const positive = values.filter((value) => !value.startsWith('!'))
  return positive.length === 0 || positive.includes(actual)
}

export function executablePackagePlatform() {
  if (process.platform !== 'linux') return `${process.platform}-${process.arch}`
  const glibc = process.report?.getReport?.().header?.glibcVersionRuntime
  return `linux-${process.arch}-${glibc ? 'gnu' : 'musl'}`
}

function parsedExecutablePackagePlatform(platform) {
  const match =
    /^(darwin|freebsd|linux|win32)-([a-z0-9]+)(?:-(gnu|musl))?$/.exec(platform)
  if (!match || (match[1] === 'linux') !== Boolean(match[3]))
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  return {
    os: match[1],
    arch: match[2],
    libc: match[3] === 'gnu' ? 'glibc' : match[3],
  }
}

export function executablePackageSupportsPlatform(name, locked, platform) {
  const target = parsedExecutablePackagePlatform(platform)
  const declaresMusl = /(?:^|[-_])musl(?:$|[-_])/u.test(name)
  const declaresGnu = /(?:^|[-_])(?:gnu|gnueabihf)(?:$|[-_])/u.test(name)
  if (declaresMusl && declaresGnu)
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  const inferredLibc = declaresMusl ? 'musl' : declaresGnu ? 'glibc' : null
  return (
    conditionMatches(locked.os, target.os) &&
    conditionMatches(locked.cpu, target.arch) &&
    (target.os !== 'linux' ||
      (conditionMatches(locked.libc, target.libc) &&
        (inferredLibc === null || inferredLibc === target.libc)))
  )
}

function executablePackageHasPlatformRestriction(locked) {
  return (
    (Array.isArray(locked.os) && locked.os.length > 0) ||
    (Array.isArray(locked.cpu) && locked.cpu.length > 0) ||
    (Array.isArray(locked.libc) && locked.libc.length > 0)
  )
}

async function packageTreeSha256(packageRoot) {
  const records = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) =>
      Buffer.from(left.name).compare(Buffer.from(right.name)),
    )
    for (const entry of entries) {
      if (entry.name === 'node_modules' && entry.isDirectory()) continue
      const path = resolve(directory, entry.name)
      if (entry.isSymbolicLink())
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        const before = await lstat(path, { bigint: true })
        const bytes = await readFile(path)
        const after = await lstat(path, { bigint: true })
        if (
          !after.isFile() ||
          after.isSymbolicLink() ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          BigInt(bytes.byteLength) !== after.size
        )
          invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
        records.push({
          path: relative(packageRoot, path).split(sep).join('/'),
          byteLength: bytes.byteLength,
          fileSha256: sha256(bytes),
        })
      } else {
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      }
    }
  }
  await visit(packageRoot)
  records.sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  )
  return sha256(canonicalJson(records))
}

export async function deriveExecutablePackageClosure(
  entrypoint,
  {
    repositoryRoot = REPOSITORY_ROOT,
    packageLockPath = 'package-lock.json',
    platform = executablePackagePlatform(),
    verifyPackageTrees = true,
  } = {},
) {
  parsedExecutablePackagePlatform(platform)
  const closure = await deriveLocalExecutableImportClosure(entrypoint, {
    repositoryRoot,
  })
  const lockPath = canonicalRepositoryPath(packageLockPath)
  if (lockPath !== 'package-lock.json')
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  let lockBytes
  let lock
  try {
    lockBytes = await readFile(resolveRepositoryPath(lockPath, repositoryRoot))
    lock = JSON.parse(lockBytes.toString('utf8'))
  } catch {
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  }
  if (!isRecord(lock.packages)) invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')

  const directPackagePaths = new Set()
  for (const artifact of closure) {
    for (const specifier of executableModuleSpecifiers(
      artifact.bytes.toString('utf8'),
      artifact.path,
    )) {
      const parsed = splitExecutableModuleSpecifier(specifier)
      if (parsed.path.startsWith('.')) continue
      const name = barePackageName(parsed.path)
      if (!name) continue
      const packageRoot = await findResolvedPackageRoot(
        parsed.path,
        name,
        artifact.realPath,
        repositoryRoot,
      )
      const packagePath = relative(await realpath(repositoryRoot), packageRoot)
        .split(sep)
        .join('/')
      canonicalRepositoryPath(packagePath)
      if (!packagePath.startsWith('node_modules/'))
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      directPackagePaths.add(packagePath)
    }
  }

  const pending = [...directPackagePaths].map((path) => ({
    path,
    conditional: false,
  }))
  const packagePaths = new Set()
  const conditionalPackagePaths = new Set()
  while (pending.length > 0) {
    const { path: packagePath, conditional } = pending.pop()
    if (packagePaths.has(packagePath)) {
      if (!conditional) conditionalPackagePaths.delete(packagePath)
      continue
    }
    const locked = lock.packages[packagePath]
    if (!isRecord(locked)) invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    packagePaths.add(packagePath)
    if (conditional) conditionalPackagePaths.add(packagePath)
    for (const dependencyName of Object.keys(locked.dependencies ?? {}).sort()) {
      const dependencyPath = lockedDependencyPath(
        packagePath,
        dependencyName,
        lock.packages,
      )
      if (!dependencyPath) invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      pending.push({ path: dependencyPath, conditional: false })
    }
    for (const dependencyName of Object.keys(
      locked.optionalDependencies ?? {},
    ).sort()) {
      const dependencyPath = lockedDependencyPath(
        packagePath,
        dependencyName,
        lock.packages,
      )
      if (!dependencyPath) invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      const dependency = lock.packages[dependencyPath]
      if (
        executablePackageSupportsPlatform(dependencyName, dependency, platform)
      )
        pending.push({
          path: dependencyPath,
          conditional:
            conditional || executablePackageHasPlatformRestriction(dependency),
        })
    }
    for (const dependencyName of Object.keys(
      locked.peerDependencies ?? {},
    ).sort()) {
      if (locked.peerDependenciesMeta?.[dependencyName]?.optional === true)
        continue
      const dependencyPath = lockedDependencyPath(
        packagePath,
        dependencyName,
        lock.packages,
      )
      if (!dependencyPath) invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      pending.push({ path: dependencyPath, conditional: false })
    }
  }

  const packages = await Promise.all(
    [...packagePaths].sort().map(async (packagePath) => {
      const locked = lock.packages[packagePath]
      const name = packageNameFromPath(packagePath)
      if (
        !isRecord(locked) ||
        typeof locked.version !== 'string' ||
        typeof locked.integrity !== 'string' ||
        !locked.integrity.startsWith('sha512-')
      )
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      const binding = {
        path: packagePath,
        name,
        version: locked.version,
        integrity: locked.integrity,
        ...(conditionalPackagePaths.has(packagePath)
          ? { platforms: [platform] }
          : {}),
      }
      if (!verifyPackageTrees) return binding
      const packageRoot = resolveRepositoryPath(packagePath, repositoryRoot)
      const [details, packageRealPath, repositoryRealPath] = await Promise.all([
        lstat(packageRoot),
        realpath(packageRoot),
        realpath(repositoryRoot),
      ])
      if (
        !details.isDirectory() ||
        details.isSymbolicLink() ||
        relative(repositoryRealPath, packageRealPath).split(sep).join('/') !==
          packagePath
      )
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      const nestedPaths = await nestedNodeModulePackagePaths(
        packageRealPath,
        repositoryRealPath,
      )
      if (nestedPaths.some((path) => !packagePaths.has(path)))
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      const packageJson = JSON.parse(
        await readFile(resolve(packageRealPath, 'package.json'), 'utf8'),
      )
      if (
        packageJson.name !== name ||
        typeof packageJson.version !== 'string' ||
        packageJson.version !== locked.version ||
        typeof packageJson.name !== 'string'
      )
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      for (const nestedPath of nestedPaths) {
        const dependencyName = packageNameFromPath(nestedPath)
        const expectedPath = lockedDependencyPath(
          packagePath,
          dependencyName,
          lock.packages,
        )
        if (!expectedPath || !packagePaths.has(expectedPath))
          invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
        const resolvedRoot = await findResolvedPackageRoot(
          dependencyName,
          dependencyName,
          resolve(packageRealPath, 'package.json'),
          repositoryRoot,
        )
        const actualPath = canonicalRepositoryPath(
          relative(repositoryRealPath, resolvedRoot).split(sep).join('/'),
        )
        if (actualPath !== expectedPath || actualPath !== nestedPath)
          invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      }
      return {
        ...binding,
        treeSha256: await packageTreeSha256(packageRealPath),
      }
    }),
  )
  return {
    platform,
    packageLock: { path: lockPath, fileSha256: sha256(lockBytes) },
    packages,
  }
}

export async function verifyMetricImplementationBinding(
  metric,
  {
    repositoryRoot = REPOSITORY_ROOT,
    requireClosure = true,
    requirePackages = false,
    includeViteGraph = true,
  } = {},
) {
  if (!requireClosure) {
    await verifyRepositoryFileBinding(
      metric.implementation,
      metric.implementationSha256,
      'PDF_BENCHMARK_METRIC_BINDING_MISMATCH',
      repositoryRoot,
    )
    return
  }
  const components = metric.implementationComponents
  const componentPaths = components.map((component) => component.path)
  if (
    components.length === 0 ||
    !unique(componentPaths) ||
    !componentPaths.includes(metric.implementation)
  ) {
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  }
  const closure = await deriveLocalExecutableImportClosure(
    metric.implementation,
    { repositoryRoot, includeViteGraph },
  )
  const closurePaths = closure.map((artifact) => artifact.path)
  if ([...componentPaths].sort().join('\n') !== closurePaths.join('\n')) {
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  }
  await Promise.all(
    components.map((component) =>
      verifyRepositoryFileBinding(
        component.path,
        component.fileSha256,
        'PDF_BENCHMARK_METRIC_BINDING_MISMATCH',
        repositoryRoot,
      ),
    ),
  )
  if (
    (metric.test === undefined) !== (metric.testSha256 === undefined) ||
    (metric.test !== undefined &&
      (!SHA256.test(metric.testSha256) ||
        !(await verifyRepositoryFileBinding(
          metric.test,
          metric.testSha256,
          'PDF_BENCHMARK_METRIC_BINDING_MISMATCH',
          repositoryRoot,
        ))))
  )
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  if (requirePackages) {
    if (
      !metric.implementationPackageLock ||
      !Array.isArray(metric.implementationPackages) ||
      !Array.isArray(metric.implementationPlatforms) ||
      !unique(metric.implementationPlatforms) ||
      metric.implementationPlatforms.length === 0
    )
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    await verifyRepositoryFileBinding(
      metric.implementationPackageLock.path,
      metric.implementationPackageLock.fileSha256,
      'PDF_BENCHMARK_METRIC_BINDING_MISMATCH',
      repositoryRoot,
    )
    const hostPlatform = executablePackagePlatform()
    if (!metric.implementationPlatforms.includes(hostPlatform))
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    const expectedPackagesForPlatform = (platform) =>
      metric.implementationPackages
        .filter(
          (package_) =>
            !package_.platforms || package_.platforms.includes(platform),
        )
        .map((package_) =>
          package_.platforms
            ? { ...package_, platforms: [platform] }
            : package_,
        )
    let platformTreeEvidence = null
    if (metric.implementationPlatforms.length > 1) {
      const binding = metric.implementationPlatformTreeEvidence
      if (!binding) invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      let evidence
      try {
        evidence = JSON.parse(
          (
            await verifyRepositoryFileBinding(
              binding.path,
              binding.fileSha256,
              'PDF_BENCHMARK_METRIC_BINDING_MISMATCH',
              repositoryRoot,
            )
          ).toString('utf8'),
        )
      } catch {
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      }
      if (
        !exactKeys(evidence, [
          'schemaVersion',
          'kind',
          'packageLock',
          'platforms',
        ]) ||
        evidence.schemaVersion !== '1.0.0' ||
        evidence.kind !== 'pdf-benchmark-package-tree-evidence' ||
        canonicalJson(evidence.packageLock) !==
          canonicalJson(metric.implementationPackageLock) ||
        !Array.isArray(evidence.platforms) ||
        evidence.platforms.length !== metric.implementationPlatforms.length ||
        !evidence.platforms.every(isRecord) ||
        !unique(evidence.platforms.map(({ platform }) => platform))
      )
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      platformTreeEvidence = new Map()
      for (const item of evidence.platforms) {
        if (
          !exactKeys(item, ['platform', 'packages']) ||
          !metric.implementationPlatforms.includes(item.platform) ||
          !Array.isArray(item.packages) ||
          canonicalJson(item.packages) !==
            canonicalJson(
              expectedPackagesForPlatform(item.platform).map(
                ({ path, treeSha256 }) => ({ path, treeSha256 }),
              ),
            )
        )
          invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
        platformTreeEvidence.set(item.platform, item.packages)
      }
    }
    const verifyPackagesForPlatform = async (platform, verifyPackageTrees) => {
      parsedExecutablePackagePlatform(platform)
      const derivedPackages = await deriveExecutablePackageClosure(
        metric.implementation,
        {
          repositoryRoot,
          packageLockPath: metric.implementationPackageLock.path,
          platform,
          verifyPackageTrees,
        },
      )
      const expectedPackages = expectedPackagesForPlatform(platform)
      if (
        canonicalJson(derivedPackages.packageLock) !==
          canonicalJson(metric.implementationPackageLock) ||
        canonicalJson(
          verifyPackageTrees
            ? derivedPackages.packages
            : packageBindingMetadata(derivedPackages.packages),
        ) !==
          canonicalJson(
            verifyPackageTrees
              ? expectedPackages
              : packageBindingMetadata(expectedPackages),
          ) ||
        (!verifyPackageTrees &&
          !expectedPackages.every(({ treeSha256 }) => SHA256.test(treeSha256)))
      )
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      if (
        platformTreeEvidence &&
        !platformTreeEvidence.has(platform)
      )
        invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
      return derivedPackages
    }
    const packageSnapshot = await verifyPackagesForPlatform(hostPlatform, true)
    const foreignPlatforms = metric.implementationPlatforms.filter(
      (platform) => platform !== hostPlatform,
    )
    const foreignPackageSnapshots = await Promise.all(
      foreignPlatforms.map((platform) =>
        verifyPackagesForPlatform(platform, false),
      ),
    )
    const finalClosure = await deriveLocalExecutableImportClosure(
      metric.implementation,
      { repositoryRoot, includeViteGraph },
    )
    if (
      canonicalJson(
        closure.map(({ path, bytes }) => ({ path, fileSha256: sha256(bytes) })),
      ) !==
      canonicalJson(
        finalClosure.map(({ path, bytes }) => ({
          path,
          fileSha256: sha256(bytes),
        })),
      )
    )
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    const finalPackageSnapshot = await verifyPackagesForPlatform(
      hostPlatform,
      true,
    )
    const finalForeignPackageSnapshots = await Promise.all(
      foreignPlatforms.map((platform) =>
        verifyPackagesForPlatform(platform, false),
      ),
    )
    if (
      canonicalJson(packageSnapshot) !== canonicalJson(finalPackageSnapshot) ||
      canonicalJson(foreignPackageSnapshots) !==
        canonicalJson(finalForeignPackageSnapshots)
    )
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  }
  if (
    metricImplementationCompositeSha256(metric) !== metric.implementationSha256
  ) {
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  }
}

export async function verifyReconstructionEvaluatorImplementationBinding(
  contract,
  { repositoryRoot = REPOSITORY_ROOT } = {},
) {
  if (contract?.schemaVersion === '4.0.0') {
    const evaluator = contract.runtimeBinding
    if (!isRecord(evaluator) || evaluator.id !== 'profile-artifact-validity')
      invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
    await verifyMetricImplementationBinding(evaluator, {
      repositoryRoot,
      requireClosure: true,
      requirePackages: true,
    })
    return
  }
  const candidates = Array.isArray(contract?.objectiveEvaluators)
    ? contract.objectiveEvaluators.filter(
        (evaluator) => evaluator?.id === 'profile-artifact-validity',
      )
    : []
  if (candidates.length !== 1) invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  const evaluator = candidates[0]
  if (
    !Array.isArray(evaluator.implementation) ||
    evaluator.implementation.length !== 1
  )
    invalid('PDF_BENCHMARK_METRIC_BINDING_MISMATCH')
  await verifyMetricImplementationBinding(
    {
      implementation: evaluator.implementation[0],
      implementationSha256: evaluator.implementationSha256,
      implementationComponents: evaluator.implementationComponents,
      implementationPackageLock: evaluator.implementationPackageLock,
      implementationPlatforms: evaluator.implementationPlatforms,
      implementationPackages: evaluator.implementationPackages,
    },
    { repositoryRoot, requireClosure: true, requirePackages: true },
  )
}

async function readBoundJson(binding, code) {
  try {
    const bytes = await verifyRepositoryFileBinding(
      binding.path,
      binding.fileSha256,
    )
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    invalid(code)
  }
}

function finiteRate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null
}

function validJudgeCalibrationEvidence(
  value,
  metric,
  frozenCalibrationSplitIdentities,
) {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'kind',
      'metricId',
      'implementationSha256',
      'heldOutSplitIdentitySha256',
      'confusionMatrix',
    ]) ||
    value.schemaVersion !== '1.0.0' ||
    value.kind !== 'pdf-benchmark-judge-calibration-evidence' ||
    value.metricId !== metric.id ||
    value.implementationSha256 !== metric.implementationSha256 ||
    !SHA256.test(value.heldOutSplitIdentitySha256 ?? '') ||
    !frozenCalibrationSplitIdentities.has(value.heldOutSplitIdentitySha256) ||
    !exactKeys(value.confusionMatrix, [
      'truePositive',
      'falseNegative',
      'trueNegative',
      'falsePositive',
    ])
  ) {
    return null
  }
  const counts = value.confusionMatrix
  if (
    Object.values(counts).some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    )
  ) {
    return null
  }
  const truePositiveRate = finiteRate(
    counts.truePositive,
    counts.truePositive + counts.falseNegative,
  )
  const trueNegativeRate = finiteRate(
    counts.trueNegative,
    counts.trueNegative + counts.falsePositive,
  )
  return truePositiveRate === null || trueNegativeRate === null
    ? null
    : { truePositiveRate, trueNegativeRate }
}

function judgeCalibrationOutputIdentitySha256(metric, calibrationEvidence) {
  return sha256(
    canonicalJson({
      kind: 'pdf-benchmark-judge-calibration-output-v1',
      metricId: metric.id,
      implementationSha256: metric.implementationSha256,
      heldOutSplitIdentitySha256:
        calibrationEvidence.heldOutSplitIdentitySha256,
      confusionMatrix: calibrationEvidence.confusionMatrix,
    }),
  )
}

function validJudgeExecutionReceipt(
  value,
  metric,
  calibration,
  calibrationEvidence,
) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'kind',
      'metricId',
      'implementationSha256',
      'calibrationEvidenceFileSha256',
      'inputIdentitySha256',
      'outputIdentitySha256',
      'status',
    ]) &&
    value.schemaVersion === '1.0.0' &&
    value.kind === 'pdf-benchmark-judge-calibration-execution-receipt' &&
    value.metricId === metric.id &&
    value.implementationSha256 === metric.implementationSha256 &&
    value.calibrationEvidenceFileSha256 === calibration.evidence.fileSha256 &&
    value.inputIdentitySha256 ===
      calibrationEvidence.heldOutSplitIdentitySha256 &&
    value.outputIdentitySha256 ===
      judgeCalibrationOutputIdentitySha256(metric, calibrationEvidence) &&
    value.status === 'passed'
  )
}

async function validateMetricImplementations(registry) {
  const metricIds = registry.metricImplementations.map((metric) => metric.id)
  if (
    !unique(metricIds) ||
    REQUIRED_METRICS.some((id) => !metricIds.includes(id))
  ) {
    invalid('PDF_BENCHMARK_INCOMPLETE_METRIC_REGISTRY')
  }
  const frozenCalibrationSplitIdentities = new Set(
    registry.splits
      .filter(
        (split) =>
          split.status === 'frozen' &&
          ['public-calibration', 'development'].includes(split.role),
      )
      .map((split) => split.frozenIdentitySha256),
  )
  const verifiedMetricIds = []
  for (const metric of registry.metricImplementations) {
    if (metric.status !== 'available') continue
    await Promise.all([
      verifyMetricImplementationBinding(metric, {
        requireClosure: ['2.0.0', '3.0.0'].includes(registry.schemaVersion),
        requirePackages: registry.schemaVersion === '3.0.0',
        includeViteGraph: registry.schemaVersion === '3.0.0',
      }),
      verifyRepositoryFileBinding(metric.test, metric.testSha256),
    ])
    if (metric.kind === 'calibrated-judge') {
      const [calibrationEvidence, executionReceipt] = await Promise.all([
        readBoundJson(
          metric.calibration.evidence,
          'PDF_BENCHMARK_JUDGE_CALIBRATION_MISMATCH',
        ),
        readBoundJson(
          metric.calibration.executionReceipt,
          'PDF_BENCHMARK_JUDGE_CALIBRATION_MISMATCH',
        ),
      ])
      const rates = validJudgeCalibrationEvidence(
        calibrationEvidence,
        metric,
        frozenCalibrationSplitIdentities,
      )
      if (
        rates === null ||
        !validJudgeExecutionReceipt(
          executionReceipt,
          metric,
          metric.calibration,
          calibrationEvidence,
        ) ||
        rates.truePositiveRate <
          registry.protocol.minimumJudgeTruePositiveRate ||
        rates.trueNegativeRate <
          registry.protocol.minimumJudgeTrueNegativeRate ||
        calibrationEvidence.confusionMatrix.truePositive +
          calibrationEvidence.confusionMatrix.falseNegative <
          registry.protocol.minimumJudgePositiveExamples ||
        calibrationEvidence.confusionMatrix.trueNegative +
          calibrationEvidence.confusionMatrix.falsePositive <
          registry.protocol.minimumJudgeNegativeExamples
      ) {
        invalid('PDF_BENCHMARK_JUDGE_CALIBRATION_MISMATCH')
      }
    }
    verifiedMetricIds.push(metric.id)
  }
  return verifiedMetricIds
}

export function validateObservationBinding(
  observations,
  evalSet,
  source,
  validateObservations,
) {
  const evalSetIdentity = validatePdfFidelityEvalSet(evalSet)
  if (
    !validateObservations(observations) ||
    !exactKeys(observations, [
      'schemaVersion',
      'id',
      'privacy',
      'evalSet',
      'method',
      'observations',
    ]) ||
    !SAFE_ID.test(observations.id ?? '') ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(observations.privacy ?? '') ||
    !Array.isArray(observations.observations)
  ) {
    invalid('INVALID_PDF_BENCHMARK_OBSERVATIONS')
  }
  const expectedCandidateOutputConsulted =
    source.selectionStatus === 'complaint-driven-candidate-output-consulted'
  if (
    observations.method?.candidateOutputConsulted !==
      expectedCandidateOutputConsulted ||
    (source.labelVisibility === 'public' &&
      !observations.privacy.startsWith('public-')) ||
    (source.labelVisibility === 'private' &&
      !observations.privacy.startsWith('private-'))
  ) {
    invalid('PDF_BENCHMARK_OBSERVATION_POLICY_MISMATCH')
  }
  if (
    !isRecord(source.evalSet) ||
    !exactKeys(observations.evalSet, [
      'path',
      'fileSha256',
      'evalSetSha256',
      'documentIdentitySha256',
      'caseIdentitySha256',
    ]) ||
    observations.evalSet.path !== source.evalSet.path ||
    observations.evalSet.fileSha256 !== source.evalSet.fileSha256 ||
    observations.evalSet.evalSetSha256 !== evalSetIdentity.evalSetSha256 ||
    observations.evalSet.documentIdentitySha256 !==
      evalSetIdentity.documentIdentitySha256 ||
    observations.evalSet.caseIdentitySha256 !==
      evalSetIdentity.caseIdentitySha256
  ) {
    invalid('PDF_BENCHMARK_OBSERVATION_EVAL_SET_MISMATCH')
  }
  const cases = new Map(evalSet.cases.map((item) => [item.id, item]))
  const documents = new Map(evalSet.documents.map((item) => [item.id, item]))
  const observedIds = observations.observations.map((item) => item.caseId)
  if (
    observedIds.length !== cases.size ||
    !unique(observedIds) ||
    observedIds.some((caseId) => !cases.has(caseId))
  ) {
    invalid('PDF_BENCHMARK_OBSERVATION_CASE_MISMATCH')
  }

  for (const observation of observations.observations) {
    if (
      !exactKeys(observation, [
        'caseId',
        'firstFailureClass',
        'sourceArtifact',
        'evaluator',
      ]) ||
      !SAFE_FAILURE_CLASS.test(observation.firstFailureClass ?? '') ||
      /(?:[/\\:]|\.\.?|\s|(?:^|-)(?:users?|home|private|tmp|var|desktop|downloads)(?:-|$))/iu.test(
        observation.firstFailureClass,
      )
    ) {
      invalid('INVALID_PDF_BENCHMARK_FAILURE_CLASS')
    }
    const item = cases.get(observation.caseId)
    const document = documents.get(item.documentId)
    const sourceArtifact = observation.sourceArtifact
    if (
      !isRecord(sourceArtifact) ||
      sourceArtifact.documentId !== item.documentId ||
      sourceArtifact.sourcePdfSha256 !== document.sha256 ||
      typeof observation.firstFailureClass !== 'string'
    ) {
      invalid('PDF_BENCHMARK_OBSERVATION_SOURCE_MISMATCH')
    }
    const pages = Array.isArray(sourceArtifact.pages)
      ? sourceArtifact.pages
      : [sourceArtifact.page]
    if (
      pages.length === 0 ||
      pages.some(
        (page) =>
          !Number.isSafeInteger(page) || page < 1 || page > document.pageCount,
      )
    ) {
      invalid('PDF_BENCHMARK_OBSERVATION_PAGE_MISMATCH')
    }
  }

  if (
    source.labelVisibility === 'private' &&
    source.selectionStatus === 'complaint-driven-candidate-output-consulted'
  ) {
    invalid('PDF_BENCHMARK_PRIVATE_LABEL_SELECTION_LEAKAGE')
  }
}

async function loadSource(source) {
  const [evalSetBytes, observationsBytes, observationsSchemaBytes] =
    await Promise.all([
      verifyRepositoryFileBinding(
        source.evalSet.path,
        source.evalSet.fileSha256,
        'PDF_BENCHMARK_SOURCE_HASH_MISMATCH',
      ),
      verifyRepositoryFileBinding(
        source.observations.path,
        source.observations.fileSha256,
        'PDF_BENCHMARK_SOURCE_HASH_MISMATCH',
      ),
      verifyRepositoryFileBinding(
        source.observations.schema.path,
        source.observations.schema.fileSha256,
        'PDF_BENCHMARK_OBSERVATION_SCHEMA_MISMATCH',
      ),
    ])
  const evalSet = JSON.parse(evalSetBytes.toString('utf8'))
  const observations = JSON.parse(observationsBytes.toString('utf8'))
  const observationsSchema = JSON.parse(
    observationsSchemaBytes.toString('utf8'),
  )
  const validateObservations = new Ajv2020({ strict: false }).compile(
    observationsSchema,
  )
  const identity = validatePdfFidelityEvalSet(evalSet)
  validateObservationBinding(
    observations,
    evalSet,
    source,
    validateObservations,
  )
  return {
    source,
    evalSet,
    observations,
    identity,
  }
}

function validFileBindingShape(value) {
  return (
    exactKeys(value, ['path', 'fileSha256']) &&
    typeof value.path === 'string' &&
    SHA256.test(value.fileSha256 ?? '')
  )
}

function validTemplateFamilyReviewDecision(value, binding, reviewerId) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'kind',
      'documentId',
      'sourcePdfSha256',
      'templateFamilyId',
      'reviewerId',
      'method',
      'sourceOnly',
      'decision',
    ]) &&
    value.schemaVersion === '1.0.0' &&
    value.kind === 'pdf-template-family-assignment-review-evidence' &&
    value.documentId === binding.documentId &&
    value.sourcePdfSha256 === binding.sourcePdfSha256 &&
    value.templateFamilyId === binding.templateFamilyId &&
    value.reviewerId === reviewerId &&
    value.method === 'source-template-structure-review' &&
    value.sourceOnly === true &&
    value.decision === 'confirmed'
  )
}

async function validTemplateFamilyEvidence(value, binding) {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'kind',
      'documentId',
      'sourcePdfSha256',
      'templateFamilyId',
      'method',
      'reviewers',
    ]) ||
    value.schemaVersion !== '1.0.0' ||
    value.kind !== 'pdf-template-family-assignment-evidence' ||
    value.documentId !== binding.documentId ||
    value.sourcePdfSha256 !== binding.sourcePdfSha256 ||
    value.templateFamilyId !== binding.templateFamilyId ||
    value.method !== 'source-template-structure-review' ||
    !Array.isArray(value.reviewers) ||
    value.reviewers.length < 2 ||
    value.reviewers.some(
      (reviewer) =>
        !exactKeys(reviewer, [
          'reviewerId',
          'identityEvidence',
          'decisionEvidence',
        ]) ||
        !SAFE_ID.test(reviewer.reviewerId ?? '') ||
        !validFileBindingShape(reviewer.identityEvidence) ||
        !validFileBindingShape(reviewer.decisionEvidence),
    ) ||
    !unique(value.reviewers.map((reviewer) => reviewer.reviewerId)) ||
    !unique(
      value.reviewers.map((reviewer) => reviewer.identityEvidence.fileSha256),
    ) ||
    !unique(
      value.reviewers.map((reviewer) => reviewer.decisionEvidence.fileSha256),
    )
  ) {
    return null
  }
  const verifiedReviewers = await Promise.all(
    value.reviewers.map(async (reviewer) => {
      const [identity, decision] = await Promise.all([
        readBoundJson(
          reviewer.identityEvidence,
          'PDF_BENCHMARK_TEMPLATE_FAMILY_EVIDENCE_MISMATCH',
        ),
        readBoundJson(
          reviewer.decisionEvidence,
          'PDF_BENCHMARK_TEMPLATE_FAMILY_EVIDENCE_MISMATCH',
        ),
      ])
      if (
        !validReviewerIdentityEvidence(identity, reviewer.reviewerId) ||
        !validTemplateFamilyReviewDecision(
          decision,
          binding,
          reviewer.reviewerId,
        )
      ) {
        invalid('PDF_BENCHMARK_TEMPLATE_FAMILY_EVIDENCE_MISMATCH')
      }
      return {
        reviewerId: reviewer.reviewerId,
        identityEvidenceFileSha256: reviewer.identityEvidence.fileSha256,
        subjectIdentitySha256: identity.subjectIdentitySha256,
      }
    }),
  )
  return unique(
    verifiedReviewers.map((reviewer) => reviewer.subjectIdentitySha256),
  )
    ? verifiedReviewers
    : null
}

export function validateSourcePdfDocumentIdentities(documents) {
  const identityByDocument = new Map()
  const documentIdBySourceSha = new Map()
  for (const document of documents) {
    const identity = {
      sha256: document.sha256,
      byteLength: document.byteLength,
      pageCount: document.pageCount,
    }
    const priorIdentity = identityByDocument.get(document.id)
    const priorDocumentId = documentIdBySourceSha.get(document.sha256)
    if (
      (priorIdentity !== undefined &&
        canonicalJson(priorIdentity) !== canonicalJson(identity)) ||
      (priorDocumentId !== undefined && priorDocumentId !== document.id)
    ) {
      invalid(
        priorDocumentId !== undefined && priorDocumentId !== document.id
          ? 'PDF_BENCHMARK_SOURCE_PDF_ALIAS_COLLISION'
          : 'PDF_BENCHMARK_DOCUMENT_IDENTITY_COLLISION',
      )
    }
    identityByDocument.set(document.id, identity)
    documentIdBySourceSha.set(document.sha256, document.id)
  }
  return new Map(
    [...identityByDocument.entries()].map(([documentId, identity]) => [
      documentId,
      identity.sha256,
    ]),
  )
}

async function validateDocumentBindings(registry, loadedSources) {
  const sourcePoliciesByDocument = new Map()
  const sourceShaByDocument = validateSourcePdfDocumentIdentities(
    loadedSources.flatMap((loaded) => loaded.evalSet.documents),
  )
  for (const loaded of loadedSources) {
    for (const document of loaded.evalSet.documents) {
      const policies = sourcePoliciesByDocument.get(document.id) ?? []
      policies.push({
        sourceId: loaded.source.id,
        sourcePdfSha256: document.sha256,
        labelVisibility: loaded.source.labelVisibility,
        oracleLocalized: loaded.source.oracleLocalized,
        selectionStatus: loaded.source.selectionStatus,
      })
      sourcePoliciesByDocument.set(document.id, policies)
    }
  }

  const bindingsByDocument = new Map()
  const verifiedTemplateBindings = new Map()
  const templateIdentityByReviewerId = new Map()
  const templateReviewerIdBySubjectIdentity = new Map()
  for (const binding of registry.documentBindings) {
    if (
      bindingsByDocument.has(binding.documentId) ||
      sourceShaByDocument.get(binding.documentId) !== binding.sourcePdfSha256
    ) {
      invalid('PDF_BENCHMARK_DOCUMENT_BINDING_MISMATCH')
    }
    bindingsByDocument.set(binding.documentId, binding)
    if (binding.templateFamilyId === null) continue
    const evidence = await readBoundJson(
      binding.templateFamilyEvidence,
      'PDF_BENCHMARK_TEMPLATE_FAMILY_EVIDENCE_MISMATCH',
    )
    const verifiedReviewers = await validTemplateFamilyEvidence(
      evidence,
      binding,
    )
    if (verifiedReviewers === null) {
      invalid('PDF_BENCHMARK_TEMPLATE_FAMILY_EVIDENCE_MISMATCH')
    }
    for (const reviewer of verifiedReviewers) {
      const priorIdentity = templateIdentityByReviewerId.get(
        reviewer.reviewerId,
      )
      const priorReviewerId = templateReviewerIdBySubjectIdentity.get(
        reviewer.subjectIdentitySha256,
      )
      if (
        (priorIdentity !== undefined &&
          (priorIdentity.identityEvidenceFileSha256 !==
            reviewer.identityEvidenceFileSha256 ||
            priorIdentity.subjectIdentitySha256 !==
              reviewer.subjectIdentitySha256)) ||
        (priorReviewerId !== undefined &&
          priorReviewerId !== reviewer.reviewerId)
      ) {
        invalid('PDF_BENCHMARK_TEMPLATE_REVIEW_IDENTITY_INCONSISTENCY')
      }
      templateIdentityByReviewerId.set(reviewer.reviewerId, reviewer)
      templateReviewerIdBySubjectIdentity.set(
        reviewer.subjectIdentitySha256,
        reviewer.reviewerId,
      )
    }
    verifiedTemplateBindings.set(binding.documentId, {
      documentId: binding.documentId,
      sourcePdfSha256: binding.sourcePdfSha256,
      templateFamilyId: binding.templateFamilyId,
      templateFamilyEvidenceSha256: binding.templateFamilyEvidence.fileSha256,
    })
  }
  if (
    bindingsByDocument.size !== sourceShaByDocument.size ||
    [...sourceShaByDocument.keys()].some(
      (documentId) => !bindingsByDocument.has(documentId),
    )
  ) {
    invalid('PDF_BENCHMARK_DOCUMENT_BINDING_MISMATCH')
  }
  return {
    bindingsByDocument,
    sourcePoliciesByDocument,
    verifiedTemplateBindings,
  }
}

export function createPdfBenchmarkSplitIdentitySha256(
  split,
  verifiedDocumentBindings,
) {
  const bindings =
    verifiedDocumentBindings instanceof Map
      ? verifiedDocumentBindings
      : new Map(
          (verifiedDocumentBindings ?? []).map((binding) => [
            binding.documentId,
            binding,
          ]),
        )
  const documents = sortedUnique(split.documentIds).map((documentId) => {
    const binding = bindings.get(documentId)
    if (
      !binding ||
      !SHA256.test(binding.sourcePdfSha256 ?? '') ||
      !SAFE_ID.test(binding.templateFamilyId ?? '') ||
      !SHA256.test(binding.templateFamilyEvidenceSha256 ?? '')
    ) {
      invalid('PDF_BENCHMARK_INCOMPLETE_FROZEN_SPLIT_BINDING')
    }
    return {
      documentId,
      sourcePdfSha256: binding.sourcePdfSha256,
      templateFamilyId: binding.templateFamilyId,
      templateFamilyEvidenceSha256: binding.templateFamilyEvidenceSha256,
    }
  })
  return sha256(
    canonicalJson({
      kind: 'pdf-benchmark-split-identity-v1',
      id: split.id,
      role: split.role,
      labelVisibility: split.labelVisibility,
      documents,
    }),
  )
}

function validateSplits(registry, allDocumentIds, verifiedTemplateBindings) {
  const knownDocumentIds = new Set(allDocumentIds)
  const splitIds = registry.splits.map((split) => split.id)
  const roles = registry.splits.map((split) => split.role)
  if (!unique(splitIds) || !unique(roles)) {
    invalid('PDF_BENCHMARK_DUPLICATE_SPLIT')
  }
  const requiredRoles = [
    'public-calibration',
    'train',
    'development',
    'blind-test',
  ]
  if (requiredRoles.some((role) => !roles.includes(role))) {
    invalid('PDF_BENCHMARK_MISSING_SPLIT')
  }

  const assignedDocuments = new Map()
  const assignedFamilies = new Map()
  const splitIdentitySha256s = {}
  for (const split of registry.splits) {
    const verifiedBindings = split.documentIds.flatMap((documentId) => {
      const binding = verifiedTemplateBindings.get(documentId)
      return binding ? [binding] : []
    })
    const derivedFamilyIds = sortedUnique(
      verifiedBindings.map((binding) => binding.templateFamilyId),
    )
    if (
      canonicalJson(sortedUnique(split.templateFamilyIds)) !==
      canonicalJson(derivedFamilyIds)
    ) {
      invalid('PDF_BENCHMARK_TEMPLATE_FAMILY_MAPPING_MISMATCH')
    }
    if (
      split.status === 'frozen' &&
      (split.documentIds.length === 0 ||
        verifiedBindings.length !== split.documentIds.length ||
        split.frozenIdentitySha256 !==
          createPdfBenchmarkSplitIdentitySha256(
            split,
            verifiedTemplateBindings,
          ))
    ) {
      invalid('PDF_BENCHMARK_INVALID_FROZEN_SPLIT')
    }
    splitIdentitySha256s[split.role] =
      split.status === 'frozen' ? split.frozenIdentitySha256 : null
    if (split.status !== 'frozen' && split.frozenIdentitySha256 !== null) {
      invalid('PDF_BENCHMARK_UNFROZEN_SPLIT_HAS_IDENTITY')
    }
    for (const documentId of split.documentIds) {
      if (!knownDocumentIds.has(documentId)) {
        invalid('PDF_BENCHMARK_UNKNOWN_SPLIT_DOCUMENT')
      }
      if (assignedDocuments.has(documentId)) {
        invalid('PDF_BENCHMARK_DOCUMENT_SPLIT_LEAKAGE')
      }
      assignedDocuments.set(documentId, split.id)
    }
    for (const familyId of derivedFamilyIds) {
      if (assignedFamilies.has(familyId)) {
        invalid('PDF_BENCHMARK_TEMPLATE_FAMILY_SPLIT_LEAKAGE')
      }
      assignedFamilies.set(familyId, split.id)
    }
  }

  if (allDocumentIds.some((documentId) => !assignedDocuments.has(documentId))) {
    invalid('PDF_BENCHMARK_UNASSIGNED_DOCUMENT')
  }
  return {
    documentDisjoint: true,
    templateFamilyDisjoint: true,
    verifiedSourceTemplateBindingCount: verifiedTemplateBindings.size,
    splitIdentitySha256s,
  }
}

function validReviewerIdentityEvidence(value, reviewerId) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'kind',
      'reviewerId',
      'identityAuthority',
      'subjectIdentitySha256',
    ]) &&
    value.schemaVersion === '1.0.0' &&
    value.kind === 'pdf-benchmark-reviewer-identity-evidence' &&
    value.reviewerId === reviewerId &&
    value.identityAuthority === 'verified-benchmark-reviewer-roster' &&
    SHA256.test(value.subjectIdentitySha256 ?? '')
  )
}

function validReviewDecisionEvidence(
  value,
  {
    caseId,
    reviewerId,
    protocolVersion,
    kind = 'pdf-benchmark-initial-review-decision-evidence',
  },
) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'kind',
      'caseId',
      'reviewerId',
      'protocolVersion',
      'sourceOnly',
      'candidateOutputConsultedForLabel',
      'decisionSha256',
    ]) &&
    value.schemaVersion === '1.0.0' &&
    value.kind === kind &&
    value.caseId === caseId &&
    value.reviewerId === reviewerId &&
    value.protocolVersion === protocolVersion &&
    value.sourceOnly === true &&
    value.candidateOutputConsultedForLabel === false &&
    SHA256.test(value.decisionSha256 ?? '')
  )
}

async function validateReviewerEvidence(reviewer, bundle, kind) {
  const [identity, decision] = await Promise.all([
    readBoundJson(
      reviewer.identityEvidence,
      'PDF_BENCHMARK_REVIEW_EVIDENCE_MISMATCH',
    ),
    readBoundJson(
      reviewer.decisionEvidence,
      'PDF_BENCHMARK_REVIEW_EVIDENCE_MISMATCH',
    ),
  ])
  if (
    !validReviewerIdentityEvidence(identity, reviewer.reviewerId) ||
    !validReviewDecisionEvidence(decision, {
      caseId: bundle.caseId,
      reviewerId: reviewer.reviewerId,
      protocolVersion: bundle.protocolVersion,
      kind,
    })
  ) {
    invalid('PDF_BENCHMARK_REVIEW_EVIDENCE_MISMATCH')
  }
  return {
    subjectIdentitySha256: identity.subjectIdentitySha256,
    decisionSha256: decision.decisionSha256,
  }
}

async function validateReviewBundles(registry, allCaseIds) {
  const caseIds = registry.reviewBundles.map((bundle) => bundle.caseId)
  if (!unique(caseIds) || caseIds.some((caseId) => !allCaseIds.has(caseId))) {
    invalid('PDF_BENCHMARK_INVALID_REVIEW_BUNDLE_CASE')
  }
  const identityByReviewerId = new Map()
  const reviewerIdBySubjectIdentity = new Map()
  const bindReviewerIdentity = (
    reviewerId,
    identityEvidenceFileSha256,
    subjectIdentitySha256,
  ) => {
    const priorIdentity = identityByReviewerId.get(reviewerId)
    const priorReviewerId = reviewerIdBySubjectIdentity.get(
      subjectIdentitySha256,
    )
    if (
      (priorIdentity !== undefined &&
        (priorIdentity.identityEvidenceFileSha256 !==
          identityEvidenceFileSha256 ||
          priorIdentity.subjectIdentitySha256 !== subjectIdentitySha256)) ||
      (priorReviewerId !== undefined && priorReviewerId !== reviewerId)
    ) {
      invalid('PDF_BENCHMARK_REVIEW_IDENTITY_INCONSISTENCY')
    }
    identityByReviewerId.set(reviewerId, {
      identityEvidenceFileSha256,
      subjectIdentitySha256,
    })
    reviewerIdBySubjectIdentity.set(subjectIdentitySha256, reviewerId)
  }
  for (const bundle of registry.reviewBundles) {
    const reviewerIds = bundle.reviewers.map((reviewer) => reviewer.reviewerId)
    const identityEvidenceHashes = bundle.reviewers.map(
      (reviewer) => reviewer.identityEvidence.fileSha256,
    )
    const decisionEvidenceHashes = bundle.reviewers.map(
      (reviewer) => reviewer.decisionEvidence.fileSha256,
    )
    if (
      bundle.reviewers.length <
        registry.protocol.requiredIndependentReviewers ||
      !unique(reviewerIds) ||
      !unique(identityEvidenceHashes) ||
      !unique(decisionEvidenceHashes) ||
      (bundle.disagreement && bundle.adjudication === null) ||
      (!bundle.disagreement && bundle.adjudication !== null)
    ) {
      invalid('PDF_BENCHMARK_INVALID_REVIEW_BUNDLE')
    }
    const verifiedReviewers = await Promise.all(
      bundle.reviewers.map((reviewer) =>
        validateReviewerEvidence(
          reviewer,
          bundle,
          'pdf-benchmark-initial-review-decision-evidence',
        ),
      ),
    )
    bundle.reviewers.forEach((reviewer, index) => {
      bindReviewerIdentity(
        reviewer.reviewerId,
        reviewer.identityEvidence.fileSha256,
        verifiedReviewers[index].subjectIdentitySha256,
      )
    })
    if (
      !unique(
        verifiedReviewers.map((reviewer) => reviewer.subjectIdentitySha256),
      ) ||
      new Set(verifiedReviewers.map((reviewer) => reviewer.decisionSha256))
        .size >
        1 !==
        bundle.disagreement
    ) {
      invalid('PDF_BENCHMARK_INVALID_REVIEW_BUNDLE')
    }
    if (bundle.adjudication) {
      if (reviewerIds.includes(bundle.adjudication.adjudicatorId)) {
        invalid('PDF_BENCHMARK_INVALID_REVIEW_BUNDLE')
      }
      const verifiedAdjudicator = await validateReviewerEvidence(
        {
          reviewerId: bundle.adjudication.adjudicatorId,
          identityEvidence: bundle.adjudication.identityEvidence,
          decisionEvidence: bundle.adjudication.decisionEvidence,
        },
        bundle,
        'pdf-benchmark-adjudication-decision-evidence',
      )
      bindReviewerIdentity(
        bundle.adjudication.adjudicatorId,
        bundle.adjudication.identityEvidence.fileSha256,
        verifiedAdjudicator.subjectIdentitySha256,
      )
      if (
        verifiedReviewers.some(
          (reviewer) =>
            reviewer.subjectIdentitySha256 ===
            verifiedAdjudicator.subjectIdentitySha256,
        )
      ) {
        invalid('PDF_BENCHMARK_INVALID_REVIEW_BUNDLE')
      }
    }
  }
  return new Set(caseIds)
}

function observedFinalNoNewClassWindow(registry, classByCase, allCaseIds) {
  if (registry.discoveryOrder.status !== 'recorded') return 0
  const order = registry.discoveryOrder.caseIds
  if (
    order.length !== allCaseIds.size ||
    !unique(order) ||
    order.some((caseId) => !allCaseIds.has(caseId))
  ) {
    invalid('PDF_BENCHMARK_INVALID_DISCOVERY_ORDER')
  }
  const seen = new Set()
  let lastNovelIndex = -1
  for (let index = 0; index < order.length; index += 1) {
    const failureClass = classByCase.get(order[index])
    if (!seen.has(failureClass)) {
      seen.add(failureClass)
      lastNovelIndex = index
    }
  }
  return order.length - lastNovelIndex - 1
}

function criterion(id, passed, observed, required) {
  return { id, passed, observed, required }
}

function candidateComponentCommitmentSha256(components) {
  return sha256(
    canonicalJson({
      kind: 'pdf-benchmark-candidate-component-commitment-v1',
      components: [...components]
        .map((component) => ({
          kind: component.kind,
          id: component.id,
          version: component.version,
          artifactFileSha256: component.artifact.fileSha256,
        }))
        .sort((left, right) => left.kind.localeCompare(right.kind)),
    }),
  )
}

function validCandidateAuthorityEvidence(value) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'kind',
      'authorityId',
      'authorityRole',
      'authorizationScope',
      'subjectIdentitySha256',
    ]) &&
    value.schemaVersion === '1.0.0' &&
    value.kind === 'pdf-benchmark-custodian-authority-evidence' &&
    SAFE_ID.test(value.authorityId ?? '') &&
    value.authorityRole === 'independent-benchmark-custodian' &&
    value.authorizationScope ===
      'witness-candidate-freeze-before-private-label-reveal' &&
    SHA256.test(value.subjectIdentitySha256 ?? '')
  )
}

function validCandidateCommitmentReceipt(
  value,
  commitment,
  componentCommitmentSha256,
  authorityEvidence,
) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'kind',
      'candidateComponentCommitmentSha256',
      'blindSplitIdentitySha256',
      'labelStateAtCommitment',
      'authorityId',
      'authorityEvidenceFileSha256',
    ]) &&
    value.schemaVersion === '1.0.0' &&
    value.kind === 'pdf-benchmark-candidate-freeze-receipt' &&
    value.candidateComponentCommitmentSha256 === componentCommitmentSha256 &&
    value.blindSplitIdentitySha256 === commitment.blindSplitIdentitySha256 &&
    value.labelStateAtCommitment === 'private-labels-withheld' &&
    value.authorityId === authorityEvidence.authorityId &&
    value.authorityEvidenceFileSha256 ===
      commitment.authorityEvidence.fileSha256
  )
}

export async function validateCandidateCommitment(registry) {
  const commitment = registry.candidateCommitment
  if (commitment.status === 'not-built') {
    return { verified: false, componentCommitmentSha256: null }
  }
  const blind = registry.splits.find((split) => split.role === 'blind-test')
  const componentKinds = commitment.components.map(
    (component) => component.kind,
  )
  if (
    commitment.status !== 'frozen' ||
    commitment.committedBeforePrivateLabelReveal !== true ||
    blind.status !== 'frozen' ||
    commitment.blindSplitIdentitySha256 !== blind.frozenIdentitySha256 ||
    !unique(componentKinds) ||
    CANDIDATE_COMPONENT_KINDS.some((kind) => !componentKinds.includes(kind)) ||
    componentKinds.some((kind) => !CANDIDATE_COMPONENT_KINDS.includes(kind))
  ) {
    invalid('PDF_BENCHMARK_CANDIDATE_COMMITMENT_MISMATCH')
  }
  const verifiedCommitmentArtifacts = await Promise.all([
    ...commitment.components.map((component) =>
      verifyRepositoryFileBinding(
        component.artifact.path,
        component.artifact.fileSha256,
        'PDF_BENCHMARK_CANDIDATE_COMMITMENT_MISMATCH',
      ),
    ),
    readBoundJson(
      commitment.authorityEvidence,
      'PDF_BENCHMARK_CANDIDATE_COMMITMENT_MISMATCH',
    ),
  ])
  const authorityEvidence = verifiedCommitmentArtifacts.at(-1)
  if (!validCandidateAuthorityEvidence(authorityEvidence)) {
    invalid('PDF_BENCHMARK_CANDIDATE_COMMITMENT_MISMATCH')
  }
  const componentCommitmentSha256 = candidateComponentCommitmentSha256(
    commitment.components,
  )
  const receipt = await readBoundJson(
    commitment.commitmentReceipt,
    'PDF_BENCHMARK_CANDIDATE_COMMITMENT_MISMATCH',
  )
  if (
    !validCandidateCommitmentReceipt(
      receipt,
      commitment,
      componentCommitmentSha256,
      authorityEvidence,
    )
  ) {
    invalid('PDF_BENCHMARK_CANDIDATE_COMMITMENT_MISMATCH')
  }
  return { verified: true, componentCommitmentSha256 }
}

function validIsolationAttestorIdentity(value) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'kind',
      'attestorId',
      'identityAuthority',
      'subjectIdentitySha256',
    ]) &&
    value.schemaVersion === '1.0.0' &&
    value.kind === 'pdf-benchmark-isolation-attestor-identity-evidence' &&
    SAFE_ID.test(value.attestorId ?? '') &&
    value.identityAuthority ===
      'verified-independent-isolation-attestor-roster' &&
    SHA256.test(value.subjectIdentitySha256 ?? '')
  )
}

function validIsolationExecutionReceipt(
  value,
  track,
  blind,
  componentCommitmentSha256,
  identity,
  identityEvidenceFileSha256,
) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'kind',
      'trackId',
      'attestorId',
      'attestorIdentityEvidenceFileSha256',
      'blindSplitIdentitySha256',
      'candidateComponentCommitmentSha256',
      'networkIsolation',
      'filesystemIsolation',
      'runnerIdentitySha256',
      'executionIdentitySha256',
      'status',
    ]) &&
    value.schemaVersion === '1.0.0' &&
    value.kind === 'pdf-benchmark-independent-isolation-execution-receipt' &&
    value.trackId === 'end-to-end-blind' &&
    value.attestorId === identity.attestorId &&
    value.attestorIdentityEvidenceFileSha256 === identityEvidenceFileSha256 &&
    value.blindSplitIdentitySha256 === blind.frozenIdentitySha256 &&
    value.candidateComponentCommitmentSha256 === componentCommitmentSha256 &&
    value.networkIsolation === track.networkIsolation &&
    value.filesystemIsolation === track.filesystemIsolation &&
    value.networkIsolation === 'independently-enforced' &&
    value.filesystemIsolation === 'independently-enforced' &&
    SHA256.test(value.runnerIdentitySha256 ?? '') &&
    SHA256.test(value.executionIdentitySha256 ?? '') &&
    value.status === 'passed'
  )
}

export async function validateIndependentIsolationEvidence(
  registry,
  candidateCommitment,
) {
  const track = registry.tracks.endToEndBlind
  if (track.isolationEvidence === null) return false
  const blind = registry.splits.find((split) => split.role === 'blind-test')
  if (
    track.status !== 'frozen' ||
    track.promotionAuthority !== true ||
    blind?.status !== 'frozen' ||
    candidateCommitment.verified !== true ||
    !SHA256.test(candidateCommitment.componentCommitmentSha256 ?? '')
  ) {
    invalid('PDF_BENCHMARK_ISOLATION_EVIDENCE_MISMATCH')
  }
  const [identity, receipt] = await Promise.all([
    readBoundJson(
      track.isolationEvidence.attestorIdentity,
      'PDF_BENCHMARK_ISOLATION_EVIDENCE_MISMATCH',
    ),
    readBoundJson(
      track.isolationEvidence.executionReceipt,
      'PDF_BENCHMARK_ISOLATION_EVIDENCE_MISMATCH',
    ),
  ])
  if (
    !validIsolationAttestorIdentity(identity) ||
    !validIsolationExecutionReceipt(
      receipt,
      track,
      blind,
      candidateCommitment.componentCommitmentSha256,
      identity,
      track.isolationEvidence.attestorIdentity.fileSha256,
    )
  ) {
    invalid('PDF_BENCHMARK_ISOLATION_EVIDENCE_MISMATCH')
  }
  return true
}

function blindSourcePolicyVerified(blind, sourcePoliciesByDocument) {
  return (
    blind.documentIds.length > 0 &&
    blind.documentIds.every((documentId) => {
      const policies = sourcePoliciesByDocument.get(documentId) ?? []
      return (
        policies.length > 0 &&
        policies.every(
          (policy) =>
            policy.labelVisibility === 'private' &&
            policy.oracleLocalized === false &&
            policy.selectionStatus ===
              'source-only-candidate-output-not-consulted',
        )
      )
    })
  )
}

export function assessPdfBenchmarkReadiness(
  registry,
  inventory,
  {
    boundDocumentIds = [],
    verifiedMetricIds = [],
    validatedReviewCaseIds = [],
    verifiedSourceTemplateDocumentIds = [],
    blindSourcePolicyVerified: blindPolicyVerified = false,
    candidateCommitmentVerified = false,
    independentIsolationEvidenceVerified = false,
  } = {},
) {
  const blind = registry.splits.find((split) => split.role === 'blind-test')
  const trainAndDevelopment = ['train', 'development'].map((role) =>
    registry.splits.find((split) => split.role === role),
  )
  const metricById = new Map(
    registry.metricImplementations.map((metric) => [metric.id, metric]),
  )
  if (
    metricById.size !== registry.metricImplementations.length ||
    REQUIRED_METRICS.some((id) => !metricById.has(id))
  ) {
    invalid('PDF_BENCHMARK_INCOMPLETE_METRIC_REGISTRY')
  }
  const boundDocuments = new Set(boundDocumentIds)
  const verifiedMetrics = new Set(verifiedMetricIds)
  const availableMetrics = REQUIRED_METRICS.filter(
    (id) =>
      metricById.get(id).status === 'available' && verifiedMetrics.has(id),
  )
  const verifiedSourceTemplateDocuments = new Set(
    verifiedSourceTemplateDocumentIds,
  )
  const reviewedCaseIds = new Set(validatedReviewCaseIds)

  const criteria = [
    criterion(
      'trace-count',
      inventory.caseCount >= registry.protocol.targetTraceCount,
      inventory.caseCount,
      registry.protocol.targetTraceCount,
    ),
    criterion(
      'distinct-document-count',
      inventory.documentCount >= registry.protocol.minimumDistinctDocuments,
      inventory.documentCount,
      registry.protocol.minimumDistinctDocuments,
    ),
    criterion(
      'discovery-order-recorded',
      registry.discoveryOrder.status === 'recorded',
      registry.discoveryOrder.status,
      'recorded',
    ),
    criterion(
      'final-no-new-class-window',
      inventory.finalNoNewClassWindow >=
        registry.protocol.requiredFinalNoNewClassWindow,
      inventory.finalNoNewClassWindow,
      registry.protocol.requiredFinalNoNewClassWindow,
    ),
    criterion(
      'independent-review-coverage',
      reviewedCaseIds.size === inventory.caseCount,
      reviewedCaseIds.size,
      inventory.caseCount,
    ),
    criterion(
      'document-split-disjoint',
      inventory.documentDisjoint,
      inventory.documentDisjoint,
      true,
    ),
    criterion(
      'template-family-split-disjoint',
      inventory.templateFamilyDisjoint,
      inventory.templateFamilyDisjoint,
      true,
    ),
    criterion(
      'source-template-binding-coverage',
      verifiedSourceTemplateDocuments.size === inventory.documentCount &&
        boundDocumentIds.every((documentId) =>
          verifiedSourceTemplateDocuments.has(documentId),
        ),
      verifiedSourceTemplateDocuments.size,
      inventory.documentCount,
    ),
    criterion(
      'train-development-splits-frozen',
      trainAndDevelopment.every(
        (split) =>
          split.status === 'frozen' &&
          split.labelVisibility === 'private' &&
          split.documentIds.length > 0 &&
          split.documentIds.every((documentId) =>
            boundDocuments.has(documentId),
          ) &&
          split.documentIds.every((documentId) =>
            verifiedSourceTemplateDocuments.has(documentId),
          ) &&
          split.frozenIdentitySha256 ===
            inventory.splitIdentitySha256s?.[split.role],
      ),
      Object.fromEntries(
        trainAndDevelopment.map((split) => [
          split.role,
          {
            status: split.status,
            labelVisibility: split.labelVisibility,
            documentCount: split.documentIds.length,
          },
        ]),
      ),
      {
        train: {
          status: 'frozen',
          labelVisibility: 'private',
          minimumDocumentCount: 1,
        },
        development: {
          status: 'frozen',
          labelVisibility: 'private',
          minimumDocumentCount: 1,
        },
        allDocumentsSourceBound: true,
        allDocumentsTemplateFamilyBound: true,
      },
    ),
    criterion(
      'blind-split-frozen',
      blind.status === 'frozen' &&
        blind.labelVisibility === 'private' &&
        blind.documentIds.length >= registry.protocol.minimumBlindDocuments &&
        blind.documentIds.every((documentId) =>
          boundDocuments.has(documentId),
        ) &&
        blind.documentIds.every((documentId) =>
          verifiedSourceTemplateDocuments.has(documentId),
        ) &&
        blindPolicyVerified &&
        blind.frozenIdentitySha256 ===
          inventory.splitIdentitySha256s?.['blind-test'],
      {
        status: blind.status,
        labelVisibility: blind.labelVisibility,
        documentCount: blind.documentIds.length,
      },
      {
        status: 'frozen',
        labelVisibility: 'private',
        minimumDocumentCount: registry.protocol.minimumBlindDocuments,
        allDocumentsSourceBound: true,
        allDocumentsTemplateFamilyBound: true,
        allDocumentSourcesPrivateAndNonOracle: true,
      },
    ),
    criterion(
      'candidate-commitment-frozen-before-label-reveal',
      candidateCommitmentVerified,
      {
        status: registry.candidateCommitment.status,
        committedBeforePrivateLabelReveal:
          registry.candidateCommitment.committedBeforePrivateLabelReveal,
      },
      {
        status: 'frozen',
        committedBeforePrivateLabelReveal: true,
        components: CANDIDATE_COMPONENT_KINDS,
        receiptBoundToBlindSplit: true,
      },
    ),
    criterion(
      'target-free-end-to-end-track',
      registry.tracks.endToEndBlind.status === 'frozen' &&
        registry.tracks.endToEndBlind.labelVisibility === 'private' &&
        registry.tracks.endToEndBlind.oracleLocalized === false &&
        registry.tracks.endToEndBlind.promotionAuthority === true &&
        registry.tracks.endToEndBlind.networkIsolation ===
          'independently-enforced' &&
        registry.tracks.endToEndBlind.filesystemIsolation ===
          'independently-enforced' &&
        independentIsolationEvidenceVerified,
      {
        status: registry.tracks.endToEndBlind.status,
        labelVisibility: registry.tracks.endToEndBlind.labelVisibility,
        oracleLocalized: registry.tracks.endToEndBlind.oracleLocalized,
        promotionAuthority: registry.tracks.endToEndBlind.promotionAuthority,
        networkIsolation: registry.tracks.endToEndBlind.networkIsolation,
        filesystemIsolation: registry.tracks.endToEndBlind.filesystemIsolation,
        independentIsolationEvidenceVerified,
      },
      {
        status: 'frozen',
        labelVisibility: 'private',
        oracleLocalized: false,
        promotionAuthority: true,
        networkIsolation: 'independently-enforced',
        filesystemIsolation: 'independently-enforced',
      },
    ),
    criterion(
      'metric-coverage',
      availableMetrics.length === REQUIRED_METRICS.length,
      availableMetrics,
      REQUIRED_METRICS,
    ),
    criterion(
      'promotion-protocol-implementation',
      PROMOTION_PROTOCOL_IMPLEMENTED,
      'not-implemented-in-readiness-v1',
      'independently-reviewed-source-review-metric-policy-v2-or-later',
    ),
  ]

  return {
    criteria,
    gaps: criteria.filter((item) => !item.passed).map((item) => item.id),
    ready: criteria.every((item) => item.passed),
  }
}

export async function createPdfBenchmarkReadinessReceipt({
  registryPath,
  schemaPath = null,
}) {
  const absoluteRegistryPath = resolve(registryPath)
  const registryArtifact = await readJsonArtifact(
    absoluteRegistryPath,
    'PDF_BENCHMARK_READINESS_FAILED',
  )
  const registry = registryArtifact.value
  const schema = await validateSchema(registry, schemaPath)
  const verifiedMetricIds = await validateMetricImplementations(registry)

  const loadedSources = []
  for (const source of registry.sources) {
    loadedSources.push(await loadSource(source))
  }
  const documentEvidence = await validateDocumentBindings(
    registry,
    loadedSources,
  )
  const allCaseIds = new Set()
  const allDocumentIds = new Set()
  const classByCase = new Map()
  const failureClasses = new Set()
  const publicFailureClassCounts = new Map()
  let privateFailureObservationCount = 0
  const sourceInventory = []
  for (const loaded of loadedSources) {
    for (const document of loaded.evalSet.documents) {
      allDocumentIds.add(document.id)
    }
    for (const observation of loaded.observations.observations) {
      if (allCaseIds.has(observation.caseId)) {
        invalid('PDF_BENCHMARK_DUPLICATE_CASE_ACROSS_SOURCES')
      }
      allCaseIds.add(observation.caseId)
      classByCase.set(observation.caseId, observation.firstFailureClass)
      failureClasses.add(observation.firstFailureClass)
      if (loaded.source.labelVisibility === 'private') {
        privateFailureObservationCount += 1
      } else {
        publicFailureClassCounts.set(
          observation.firstFailureClass,
          (publicFailureClassCounts.get(observation.firstFailureClass) ?? 0) +
            1,
        )
      }
    }
    sourceInventory.push({
      id: loaded.source.id,
      evalSetId: loaded.identity.id,
      evalSetSha256: loaded.identity.evalSetSha256,
      caseCount: loaded.identity.caseCount,
      documentCount: loaded.identity.documentCount,
      labelVisibility: loaded.source.labelVisibility,
      oracleLocalized: loaded.source.oracleLocalized,
    })
  }
  const splitValidation = validateSplits(
    registry,
    [...allDocumentIds].sort(),
    documentEvidence.verifiedTemplateBindings,
  )
  const validatedReviewCaseIds = await validateReviewBundles(
    registry,
    allCaseIds,
  )
  const candidateCommitment = await validateCandidateCommitment(registry)
  const independentIsolationEvidenceVerified =
    await validateIndependentIsolationEvidence(registry, candidateCommitment)
  const blind = registry.splits.find((split) => split.role === 'blind-test')
  const verifiedBlindSourcePolicy = blindSourcePolicyVerified(
    blind,
    documentEvidence.sourcePoliciesByDocument,
  )
  const finalNoNewClassWindow = observedFinalNoNewClassWindow(
    registry,
    classByCase,
    allCaseIds,
  )
  const inventory = {
    caseCount: allCaseIds.size,
    documentCount: allDocumentIds.size,
    failureClassCount: failureClasses.size,
    failureClassCounts: {
      public: Object.fromEntries(
        [...publicFailureClassCounts.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      privateRedactedObservationCount: privateFailureObservationCount,
    },
    finalNoNewClassWindow,
    ...splitValidation,
  }
  const assessment = assessPdfBenchmarkReadiness(registry, inventory, {
    boundDocumentIds: [...allDocumentIds],
    verifiedMetricIds,
    validatedReviewCaseIds: [...validatedReviewCaseIds],
    verifiedSourceTemplateDocumentIds: [
      ...documentEvidence.verifiedTemplateBindings.keys(),
    ],
    blindSourcePolicyVerified: verifiedBlindSourcePolicy,
    candidateCommitmentVerified: candidateCommitment.verified,
    independentIsolationEvidenceVerified,
  })
  const unsigned = {
    schemaVersion: PDF_BENCHMARK_READINESS_SCHEMA_VERSION,
    privacy:
      'public-identities-hashes-readiness-aggregates-no-source-content-private-labels-or-local-paths',
    registry: {
      id: registry.id,
      fileSha256: registryArtifact.fileSha256,
      canonicalSha256: sha256(canonicalJson(registry)),
    },
    schema,
    inventory,
    sources: sourceInventory,
    candidateCommitment: {
      status: registry.candidateCommitment.status,
      committedBeforePrivateLabelReveal:
        registry.candidateCommitment.committedBeforePrivateLabelReveal,
      componentCommitmentSha256: candidateCommitment.componentCommitmentSha256,
    },
    criteria: assessment.criteria,
    gaps: assessment.gaps,
    ready: assessment.ready,
  }
  return {
    ...unsigned,
    receiptSha256: sha256(canonicalJson(unsigned)),
  }
}

function parseArgs(argv) {
  const options = {
    registryPath: null,
    schemaPath: null,
    outPath: null,
    requireReady: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--registry') {
      options.registryPath = argv[++index]
    } else if (argument === '--schema') {
      options.schemaPath = argv[++index]
    } else if (argument === '--out') {
      options.outPath = argv[++index]
    } else if (argument === '--require-ready') {
      options.requireReady = true
    } else {
      invalid('INVALID_PDF_BENCHMARK_READINESS_ARGUMENT')
    }
  }
  if (!options.registryPath) {
    invalid('MISSING_PDF_BENCHMARK_READINESS_REGISTRY')
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (
    options.requireReady &&
    options.schemaPath &&
    resolve(options.schemaPath) !== DEFAULT_SCHEMA_PATH
  ) {
    invalid('PDF_BENCHMARK_NONCANONICAL_PROMOTION_SCHEMA')
  }
  const receipt = await createPdfBenchmarkReadinessReceipt(options)
  const output = `${JSON.stringify(receipt, null, 2)}\n`
  if (options.outPath) {
    await mkdir(dirname(resolve(options.outPath)), { recursive: true })
    await writeFile(resolve(options.outPath), output)
  } else {
    process.stdout.write(output)
  }
  if (options.requireReady && !receipt.ready) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : ''
    const code = PUBLIC_ERROR_CODE.test(message)
      ? message
      : 'PDF_BENCHMARK_READINESS_FAILED'
    process.stderr.write(`${code}\n`)
    process.exitCode = 1
  })
}

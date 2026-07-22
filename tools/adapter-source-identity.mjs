import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const ADAPTER_SOURCE_IDENTITY_SCHEMA_VERSION = '1.0.0'

const SOURCE_EXTENSIONS = [
  '.mjs',
  '.js',
  '.cjs',
  '.mts',
  '.ts',
  '.cts',
  '.tsx',
  '.jsx',
  '.json',
]
const PARSED_SOURCE_EXTENSIONS = new Set(SOURCE_EXTENSIONS.slice(0, -1))

function invalid(code) {
  throw new Error(code)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function modulePath(entryDirectory, path) {
  return relative(entryDirectory, path).split(sep).join('/')
}

function stringLiteralText(node) {
  return ts.isStringLiteralLike(node) ? node.text : null
}

function sourceReferences(path, source) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  if (sourceFile.parseDiagnostics.length > 0) {
    invalid('INVALID_ADAPTER_SOURCE_MODULE')
  }
  const references = []
  const add = (specifier, rootRelative = false) => {
    if (typeof specifier !== 'string' || specifier.length === 0) return
    if (
      !rootRelative &&
      !specifier.startsWith('.') &&
      !specifier.startsWith('/') &&
      !specifier.startsWith('file:')
    ) {
      return
    }
    references.push({ specifier, rootRelative })
  }
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      add(stringLiteralText(node.moduleSpecifier))
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(stringLiteralText(node.moduleReference.expression))
    } else if (ts.isImportTypeNode(node)) {
      const argument = ts.isLiteralTypeNode(node.argument)
        ? stringLiteralText(node.argument.literal)
        : null
      add(argument)
    } else if (ts.isCallExpression(node)) {
      const literal =
        node.arguments.length === 1
          ? stringLiteralText(node.arguments[0])
          : null
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (literal === null) invalid('UNRESOLVED_ADAPTER_SOURCE_DEPENDENCY')
        add(literal)
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require'
      ) {
        if (literal === null) invalid('UNRESOLVED_ADAPTER_SOURCE_DEPENDENCY')
        add(literal)
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'ssrLoadModule'
      ) {
        if (literal === null) invalid('UNRESOLVED_ADAPTER_SOURCE_DEPENDENCY')
        add(literal, true)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return references
}

async function regularRealPath(path) {
  try {
    const details = await lstat(path)
    if (!details.isFile() || details.isSymbolicLink()) return null
    const canonicalPath = await realpath(path)
    const canonicalDetails = await lstat(canonicalPath)
    return canonicalDetails.isFile() && !canonicalDetails.isSymbolicLink()
      ? canonicalPath
      : null
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

async function nearestPackageRoot(entryPath) {
  let directory = dirname(entryPath)
  while (true) {
    if (await regularRealPath(join(directory, 'package.json'))) return directory
    const parent = dirname(directory)
    if (parent === directory) return dirname(entryPath)
    directory = parent
  }
}

async function resolveSourcePath(basePath) {
  const cleanPath = basePath.replace(/[?#].*$/u, '')
  const candidates = extname(cleanPath)
    ? [cleanPath]
    : [
        cleanPath,
        ...SOURCE_EXTENSIONS.map((extension) => `${cleanPath}${extension}`),
        ...SOURCE_EXTENSIONS.map((extension) =>
          join(cleanPath, `index${extension}`),
        ),
      ]
  for (const candidate of candidates) {
    const path = await regularRealPath(candidate)
    if (path) return path
  }
  invalid('ADAPTER_SOURCE_DEPENDENCY_NOT_FOUND')
}

async function resolveReference(reference, importer, packageRoot) {
  if (reference.specifier.startsWith('file:')) {
    return resolveSourcePath(fileURLToPath(reference.specifier))
  }
  if (reference.rootRelative) {
    return resolveSourcePath(
      resolve(packageRoot, reference.specifier.replace(/^\/+/, '')),
    )
  }
  return resolveSourcePath(
    reference.specifier.startsWith('/')
      ? reference.specifier
      : resolve(dirname(importer), reference.specifier),
  )
}

export async function createAdapterSourceIdentity(entryPath) {
  if (typeof entryPath !== 'string' || entryPath.length === 0) {
    invalid('INVALID_ADAPTER_SOURCE_ENTRY')
  }
  const entry = await resolveSourcePath(resolve(entryPath))
  const entryDirectory = dirname(entry)
  const packageRoot = await nearestPackageRoot(entry)
  const pending = [entry]
  const visited = new Set()
  const modules = []

  while (pending.length > 0) {
    const path = pending.shift()
    if (visited.has(path)) continue
    visited.add(path)
    const bytes = await readFile(path)
    modules.push({
      path: modulePath(entryDirectory, path),
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    })
    if (!PARSED_SOURCE_EXTENSIONS.has(extname(path))) continue
    const references = sourceReferences(path, bytes.toString('utf8'))
    for (const reference of references) {
      const dependency = await resolveReference(reference, path, packageRoot)
      if (!visited.has(dependency)) pending.push(dependency)
    }
  }

  modules.sort((left, right) => compareText(left.path, right.path))
  const manifest = {
    schemaVersion: ADAPTER_SOURCE_IDENTITY_SCHEMA_VERSION,
    entry: modulePath(entryDirectory, entry),
    modules,
  }
  return { ...manifest, sha256: sha256(canonicalJson(manifest)) }
}

export async function assertAdapterSourceIdentity(
  entryPath,
  expectedSha256,
  mismatchCode = 'ADAPTER_SOURCE_IDENTITY_MISMATCH',
) {
  if (
    !/^[a-f0-9]{64}$/u.test(expectedSha256 ?? '') ||
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(mismatchCode)
  ) {
    invalid('INVALID_ADAPTER_SOURCE_IDENTITY')
  }
  const identity = await createAdapterSourceIdentity(entryPath)
  if (identity.sha256 !== expectedSha256) invalid(mismatchCode)
  return identity
}

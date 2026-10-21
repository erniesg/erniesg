import { readFile, readdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
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
import { renderPublicationXhtml } from '@erniesg/struct/renderers/xhtml'

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
      if (argument && ts.isStringLiteralLike(argument))
        paths.push(argument.text)
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
 * The source the guard parses for a module. An Astro file contributes its
 * frontmatter and its inline scripts; an MDX file contributes the ESM block
 * MDX allows at the top level, so a fenced code sample that merely shows an
 * import is not mistaken for a module specifier.
 */
function scanSource(source: string, file: URL): string {
  if (file.pathname.endsWith('.astro')) {
    const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? ''
    const scripts = [
      ...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),
    ].map((match) => match[1])
    return [frontmatter, ...scripts].join('\n')
  }
  if (file.pathname.endsWith('.mdx')) return mdxLeadingEsm(source)
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

/** Whether a line ends an ESM statement that names a module. */
function mdxEndsWithModuleSpecifier(line: string): boolean {
  return (
    /from\s*['"][^'"]*['"]\s*;?$/.test(line) ||
    /^import\s*['"][^'"]*['"]\s*;?$/.test(line)
  )
}

/**
 * The leading ESM block of an MDX document. MDX allows import and export
 * statements only at the top level of the document, before any markdown
 * content, so only that block can carry a module specifier. Taking it keeps a
 * fenced code sample that shows an import out of the scan, and keeps markdown
 * prose from swallowing a real specifier inside an unterminated string.
 */
function mdxLeadingEsm(source: string): string {
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const kept: string[] = []
  let depth = 0
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (kept.length === 0) {
      if (trimmed === '') continue
      if (!/^(?:import|export)\b/.test(trimmed)) break
    } else if (depth === 0) {
      break
    }
    kept.push(line)
    depth += mdxBraceDelta(line)
    if (depth === 0 && mdxEndsWithModuleSpecifier(trimmed)) break
  }
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

function e03ViolationsForSource(
  source: string,
  file: URL,
  publicPaths: Set<string>,
): string[] {
  const violations: string[] = []
  const computedDynamicImports: string[][] = []
  const specifiers = importedPaths(source, file, computedDynamicImports)
  let computedIndex = 0
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
    if (isStructBarrelTarget(target)) {
      violations.push(
        `${file.pathname}: migrated family import ${specifier} -> ${target}`,
      )
    }
  }
  violations.push(...recoveryImporterViolationsForSpecifiers(specifiers, file))
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
})
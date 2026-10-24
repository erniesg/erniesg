import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import * as facade from '../src/publication/publishing-facade.ts'
import { publicationCheck } from '../tools/publication-check.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The graph symbols of `src/publication/schema.ts`.
 *
 * They are the symbols the publication graph is made of. No module outside
 * the permitted set may name one of them, and the CLI tools are outside that
 * set: the publication graph is the ephemeral renderer plan of the facade.
 */
const GRAPH_SYMBOLS = [
  'PublicationGraph',
  'publicationGraphSchema',
  'serializePublicationGraph',
  'PUBLICATION_GRAPH_VERSION',
  'PublicationNode',
  'PublicationInlineRun',
  'parsePublicationGraph',
]

const SCHEMA_FILE = resolve(repositoryRoot, 'src/publication/schema.ts')

const CLI_TOOLS = [
  'tools/publication-build.mjs',
  'tools/publication-check.mjs',
  'tools/publication-adapter-conformance.mjs',
]

/**
 * The graph symbols a module imports, resolved with the TypeScript checker.
 *
 * The resolution follows aliases, so a re-export through a barrel and a
 * renamed import are both caught: only the declaration's own file decides
 * whether a name is the publication graph.
 */
function importedGraphSymbols(files) {
  const program = ts.createProgram([...files], {
    allowJs: true,
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  })
  const checker = program.getTypeChecker()
  const isGraphSymbol = (exported) => {
    let symbol = exported
    if (symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = checker.getAliasedSymbol(symbol)
      } catch {
        return undefined
      }
    }
    for (const declaration of symbol.declarations ?? []) {
      const name = declaration.name
      if (!name || !ts.isIdentifier(name)) continue
      if (!GRAPH_SYMBOLS.includes(name.text)) continue
      if (resolve(declaration.getSourceFile().fileName) !== SCHEMA_FILE)
        continue
      return name.text
    }
    return undefined
  }
  const hits = []
  const visit = (node, file) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const moduleSymbol = checker.getSymbolAtLocation(node.moduleSpecifier)
      const exports = moduleSymbol
        ? checker.getExportsOfModule(moduleSymbol)
        : []
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text
          const exported = exports.find(
            (candidate) => candidate.getName() === imported,
          )
          const graph = exported ? isGraphSymbol(exported) : undefined
          if (graph)
            hits.push(
              `${file} -> ${graph} from ${node.moduleSpecifier.text}`,
            )
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        // A namespace import can reach every export of the module.
        for (const exported of exports) {
          const graph = isGraphSymbol(exported)
          if (graph)
            hits.push(
              `${file} -> ${graph} from ${node.moduleSpecifier.text}`,
            )
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, file))
  }
  for (const file of files) {
    const source = program.getSourceFile(file)
    if (!source) throw new Error(`The checker did not load ${file}`)
    visit(source, file)
  }
  return hits
}

function importedModuleSpecifiers(file) {
  const source = ts.createSourceFile(
    file,
    ts.sys.readFile(file) ?? '',
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  )
  const specifiers = []
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

describe('the publication CLI talks to the facade alone', () => {
  it('imports no graph symbol in any CLI tool', () => {
    // The check is compiler based: it resolves every imported name to its
    // declaration and only the declaration's file decides whether a name is
    // the publication graph. A barrel re-export or a renamed import is
    // therefore caught exactly like a direct import.
    const hits = importedGraphSymbols(
      CLI_TOOLS.map((tool) => resolve(repositoryRoot, tool)),
    )
    expect(hits).toEqual([])
  }, 300_000)

  it('imports the graph schema module in no CLI tool', () => {
    const hits = CLI_TOOLS.flatMap((tool) =>
      importedModuleSpecifiers(resolve(repositoryRoot, tool))
        .filter((specifier) =>
          specifier.includes('publication/schema'),
        )
        .map((specifier) => `${tool} -> ${specifier}`),
    )
    expect(hits).toEqual([])
  })

  it('imports the facade in the builder and in the checker', () => {
    for (const tool of CLI_TOOLS.slice(0, 2)) {
      expect(
        importedModuleSpecifiers(resolve(repositoryRoot, tool)),
      ).toContain('../src/publication/publishing-facade.ts')
    }
  })

  it('exports no graph symbol from the facade', () => {
    // The facade owns the projection, so it is allowed to name the graph
    // internally. It must not hand the graph to the CLI, so none of the graph
    // symbols may leave the module.
    expect(Object.keys(facade)).not.toContain('PublicationGraph')
    expect(Object.keys(facade)).not.toContain('publicationGraphSchema')
    expect(Object.keys(facade)).not.toContain('serializePublicationGraph')
    expect(Object.keys(facade)).not.toContain('PUBLICATION_GRAPH_VERSION')
    expect(Object.keys(facade)).not.toContain('PublicationNode')
    expect(Object.keys(facade)).not.toContain('PublicationInlineRun')
    expect(Object.keys(facade)).not.toContain('parsePublicationGraph')
  })

  it('flags a synthetic graph import, so the check is not a no-op', async () => {
    // Non-vacuity: a module that imports a graph symbol has to be caught, or
    // the check above would pass by forbidding nothing.
    const root = await mkdtemp(resolve(tmpdir(), 'publication-graph-probe-'))
    try {
      const probe = resolve(root, 'probe.mjs')
      await writeFile(
        probe,
        [
          `import { PublicationGraph } from '${SCHEMA_FILE}'`,
          'export const graph = undefined',
          '',
        ].join('\n'),
      )
      expect(importedGraphSymbols([probe])).toEqual([
        expect.stringContaining('PublicationGraph'),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)

  it('flags a renamed graph import, so the check does not rely on the local name', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-graph-rename-'))
    try {
      const probe = resolve(root, 'renamed.mjs')
      await writeFile(
        probe,
        [
          `import { PublicationGraph as Graph } from '${SCHEMA_FILE}'`,
          'export const graph = undefined',
          '',
        ].join('\n'),
      )
      expect(importedGraphSymbols([probe])).toEqual([
        expect.stringContaining('PublicationGraph'),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)

  it('publishes the contract facade API', () => {
    // The settled contract of the publishing facade: the source locator, the
    // plan, and the five functions of contract section 6.2.
    expect(typeof facade.buildPublicationPlan).toBe('function')
    expect(typeof facade.publicationPlanFromStructDocument).toBe('function')
    expect(typeof facade.canonicalSubsetSha256ForPlan).toBe('function')
    expect(typeof facade.serializeStructDocumentForPersistence).toBe('function')
    expect(typeof facade.renderPublicationPlan).toBe('function')
    expect(facade.buildPublicationPlan).toHaveLength(1)
    expect(facade.publicationPlanFromStructDocument).toHaveLength(2)
    expect(facade.canonicalSubsetSha256ForPlan).toHaveLength(1)
    expect(facade.serializeStructDocumentForPersistence).toHaveLength(1)
    expect(facade.renderPublicationPlan).toHaveLength(2)
  })
})

describe('the checker rejects a persisted publication graph', () => {
  it('fails when publication-graph.json is present in the checked output', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-graph-present-'))
    try {
      // The file is deliberately not a graph: the checker must reject its
      // presence, and it must never open it. A checker that read the file
      // would fail with a parse error instead.
      await writeFile(resolve(root, 'publication-graph.json'), 'not a graph\n')
      await expect(
        publicationCheck([
          '--input',
          root,
          '--matrix',
          'phone-webpub,eink-epub,a5-pdf,a4-pdf',
        ]),
      ).rejects.toThrow(/publication graph/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails on the stale artifact before it reads any other artifact', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-graph-first-'))
    try {
      await writeFile(
        resolve(root, 'publication-graph.json'),
        '{"version":"1.0.0","nodes":[]}\n',
      )
      // The output has no receipt, no Struct document and no artifacts at
      // all. The stale graph is still the first thing the checker rejects, so
      // the rejection is about the graph and not about a missing artifact.
      await expect(
        publicationCheck([
          '--input',
          root,
          '--matrix',
          'phone-webpub,eink-epub,a5-pdf,a4-pdf',
        ]),
      ).rejects.toThrow(/publication graph/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('names the rejected file in the failure', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'publication-graph-named-'))
    try {
      await writeFile(resolve(root, 'publication-graph.json'), '{}\n')
      const failure = await publicationCheck([
        '--input',
        root,
        '--matrix',
        'phone-webpub,eink-epub,a5-pdf,a4-pdf',
      ]).catch((error) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure.message).toContain('publication-graph.json')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

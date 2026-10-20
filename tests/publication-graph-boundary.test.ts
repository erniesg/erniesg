import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  analyzeProbes,
  analyzeRepository,
  astroGraphImportViolations,
  isTestFile,
  PERMITTED_GRAPH_IMPORTERS,
  probeSchemaSpecifier,
  RELEASE_SCRIPT,
  repoReferences,
  resolveGraphFreeClasses,
  textGraphSymbols,
  type ProgramAnalysis,
  type ResolvedClass,
} from './helpers/publication-graph-boundary'

/**
 * The guard builds a TypeScript program over the whole repository and asks
 * the checker about every identifier that names a graph symbol, so its tests
 * are slower than a unit test. The timeout is explicit, not a default.
 */
const ANALYSIS_TIMEOUT = 900_000

/**
 * EG-08 - the graph-absence guard.
 *
 * The `PublicationGraph` survives the convergence only as the in-memory
 * renderer plan between the one projection and the renderer. This guard proves,
 * with the TypeScript checker and not with a grep, that no other module of the
 * repository can name a graph symbol: the storage, API, route, writer and
 * release classes are graph-free, and the only modules that may name the graph
 * are the permitted ones of contract §5.1.
 */
describe('EG-08 publication graph boundary', () => {
  let analysis: ProgramAnalysis
  let violations: string[]
  let permittedImporters: string[]
  let classes: ResolvedClass[]

  beforeAll(async () => {
    analysis = analyzeRepository()
    violations = []
    permittedImporters = []
    for (const [path, symbols] of repoReferences(analysis)) {
      if (isTestFile(path)) continue
      if (PERMITTED_GRAPH_IMPORTERS.includes(path)) {
        permittedImporters.push(path)
        continue
      }
      violations.push(`${path} -> ${[...symbols].sort().join(', ')}`)
    }
    violations.sort()
    permittedImporters.sort()
    classes = await resolveGraphFreeClasses()
  }, ANALYSIS_TIMEOUT)

  it(
    'keeps every graph-symbol importer inside the permitted set',
    () => {
      // The violation list is the guard's whole point: a module that names a
      // graph symbol outside the permitted set is a violation, whether it
      // imports the symbol directly, through a barrel or under another name.
      expect(violations).toEqual([])
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'keeps the .astro files under src/ free of graph symbols',
    async () => {
      // The `.astro` files are not part of the TypeScript program, so they
      // are scanned with the textual frontmatter/script extractor and their
      // import targets are resolved through the checker.
      expect(await astroGraphImportViolations(analysis)).toEqual([])
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'keeps the storage, API, route, writer and release classes graph-free',
    async () => {
      const references = repoReferences(analysis)
      const astroViolations = await astroGraphImportViolations(analysis)
      const hits: string[] = []
      for (const resolved of classes) {
        for (const file of resolved.files) {
          const symbols = references.get(file)
          if (symbols?.size) {
            hits.push(
              `${resolved.name}: ${file} -> ${[...symbols].sort().join(', ')}`,
            )
            continue
          }
          const astroHit = astroViolations.find(
            (violation) => violation.file === file,
          )
          if (astroHit) {
            hits.push(
              `${resolved.name}: ${file} -> ${astroHit.symbols.join(', ')}`,
            )
            continue
          }
          if (file.endsWith('.sql')) {
            const text = await readFile(
              new URL(`../${file}`, import.meta.url),
              'utf8',
            )
            const textual = textGraphSymbols(text)
            if (textual.length)
              hits.push(`${resolved.name}: ${file} -> ${textual.join(', ')}`)
          }
        }
      }
      expect(hits).toEqual([])
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'keeps the production release script free of graph symbols',
    async () => {
      const manifest = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8'),
      ) as { scripts?: Record<string, string> }
      const script = manifest.scripts?.[RELEASE_SCRIPT]
      expect(script).toBeTypeOf('string')
      expect(textGraphSymbols(script ?? '')).toEqual([])
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'exercises the permitted set, so a typo in it cannot pass by forbidding nothing',
    () => {
      // The definition module and the one projection always name the graph, so
      // the permitted set is exercised by the tree itself.
      expect(permittedImporters.length).toBeGreaterThan(0)
      expect(permittedImporters).toContain('src/publication/schema.ts')
      expect(permittedImporters).toContain('src/publication/struct-adapter.ts')
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'resolves every forbidden class to live files',
    () => {
      for (const resolved of classes) {
        expect(resolved.missing, resolved.name).toEqual([])
        expect(resolved.files.length, resolved.name).toBeGreaterThan(0)
      }
      const union = new Set(classes.flatMap((resolved) => resolved.files))
      expect(union.size).toBeGreaterThan(0)
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'flags a synthetic barrel probe, so the guard is not a no-op',
    async () => {
      const probe = await analyzeProbes((root) => {
        const schema = probeSchemaSpecifier(root)
        return {
          // The barrel re-exports the graph symbol, the consumer imports it
          // through the barrel. Neither the local name nor the module path
          // gives the graph away.
          'barrel.ts': `export { PublicationGraph } from '${schema}'\n`,
          'consumer.ts': [
            `import type { PublicationGraph } from './barrel'`,
            `export const graph: PublicationGraph | undefined = undefined`,
            '',
          ].join('\n'),
        }
      })
      expect(probe.violations).toContain('barrel.ts -> PublicationGraph')
      expect(probe.violations).toContain('consumer.ts -> PublicationGraph')
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'flags a synthetic renamed-import probe, so the guard does not rely on the local name',
    async () => {
      const probe = await analyzeProbes((root) => {
        const schema = probeSchemaSpecifier(root)
        return {
          'renamed.ts': [
            `import type { PublicationGraph as Graph } from '${schema}'`,
            `export type { Graph }`,
            '',
          ].join('\n'),
        }
      })
      expect(probe.violations).toContain('renamed.ts -> PublicationGraph')
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'flags a synthetic .astro import probe, so the .astro scan is not a no-op',
    async () => {
      const probe = await analyzeProbes((root) => {
        const schema = probeSchemaSpecifier(root)
        return {
          'probe.astro': [
            '---',
            `import { PublicationGraph } from '${schema}'`,
            '---',
            '<p>probe</p>',
            '',
          ].join('\n'),
        }
      })
      expect(probe.astroViolations).toEqual([
        expect.objectContaining({ file: 'probe.astro' }),
      ])
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'does not flag a module that declares its own identically named type',
    async () => {
      // The guard is about the canonical declarations of the graph schema, not
      // about a name collision in an unrelated module.
      const probe = await analyzeProbes(() => ({
        'local.ts': [
          'export type PublicationNode = { id: string }',
          "export const node: PublicationNode = { id: 'local' }",
          '',
        ].join('\n'),
      }))
      expect(probe.violations).toEqual([])
    },
    ANALYSIS_TIMEOUT,
  )
})

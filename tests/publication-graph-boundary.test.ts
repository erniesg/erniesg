import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  analyzeProbes,
  analyzeRepository,
  astroGraphImportViolations,
  isTestFile,
  PERMITTED_GRAPH_IMPORTERS,
  probeSchemaSpecifier,
  RELEASE_SCRIPT,
  repoExaminedAccesses,
  repoPropertyAccesses,
  repoReferences,
  resolveGraphFreeClasses,
  REPOSITORY_ROOT,
  textGraphSymbols,
  violationLine,
  type GraphValueAccess,
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
 * The module specifier a probe uses to reach the source adapter.
 *
 * The path is relative to the probe's own directory, so the probe resolves
 * the repository's real module and the checker proves the types that module
 * carries. The source adapter is reached because its result type is named
 * after the source, not after the graph: it is the carrier a probe uses to
 * hold the graph without ever naming it.
 */
function probeSourceAdapterSpecifier(root: string): string {
  const module = resolve(REPOSITORY_ROOT, 'src/publication/source-adapter.ts')
  return relative(root, module.replace(/\.ts$/, '')).split(/[\\/]/).join('/')
}

/**
 * EG-08 - the graph-absence guard.
 *
 * The `PublicationGraph` survives the convergence only as the in-memory
 * renderer plan between the one projection and the renderer. This guard proves,
 * with the TypeScript checker and not with a grep, that no other module of the
 * repository can hold the graph: the storage, API, route, writer and release
 * classes are graph-free, and the only modules that may hold the graph are
 * the permitted ones of contract §5.1.
 *
 * The guard proves two things about a module that holds the graph. It names
 * no graph symbol, which the identifier walk proves. And it does not carry
 * the graph as a value, which the value walk proves: a property read, an
 * element read, a destructured binding and a parameter that receives the
 * graph are all resolved through the checker to the canonical `PublicationGraph`
 * type of `src/publication/schema.ts`. A module that receives a graph-bearing
 * value and reads the graph off it is caught, whatever the property is called
 * and whatever the carrier type is named.
 */
describe('EG-08 publication graph boundary', () => {
  let analysis: ProgramAnalysis
  let violations: string[]
  let permittedImporters: string[]
  let classes: ResolvedClass[]
  let accesses: Map<string, GraphValueAccess[]>
  let examined: Map<string, number>

  beforeAll(async () => {
    analysis = analyzeRepository()
    violations = []
    permittedImporters = []
    accesses = repoPropertyAccesses(analysis)
    examined = repoExaminedAccesses(analysis)
    for (const [path, symbols] of repoReferences(analysis)) {
      if (isTestFile(path)) continue
      if (PERMITTED_GRAPH_IMPORTERS.includes(path)) {
        permittedImporters.push(path)
        continue
      }
      violations.push(violationLine(path, symbols, accesses.get(path)))
    }
    violations.sort()
    permittedImporters.sort()
    classes = await resolveGraphFreeClasses()
  }, ANALYSIS_TIMEOUT)

  it(
    'keeps every graph-symbol importer inside the permitted set',
    () => {
      // The violation list is the guard's whole point: a module that holds a
      // graph symbol outside the permitted set is a violation, whether it
      // imports the symbol directly, through a barrel or under another name,
      // and whether it names the symbol or reads the graph off a value that
      // carries it.
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
              violationLine(
                `${resolved.name}: ${file}`,
                symbols,
                accesses.get(file),
              ),
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

  it(
    'flags a synthetic graph-bearing property access, so the guard sees the dataflow and not only the names',
    async () => {
      // The probe names no graph symbol at all. It receives a value whose
      // type carries the graph and reads the graph off that value, so the
      // name-based walk cannot see it. The value walk must: the checker
      // resolves `result.graph` to the canonical `PublicationGraph` type of
      // `src/publication/schema.ts`.
      const probe = await analyzeProbes((root) => {
        const sourceAdapter = probeSourceAdapterSpecifier(root)
        return {
          'probe.ts': [
            `import type { PublicationSourceResult } from '${sourceAdapter}'`,
            `export function readGraph(result: PublicationSourceResult) {`,
            `  return result.graph.nodes.length`,
            `}`,
            '',
          ].join('\n'),
        }
      })
      expect(
        probe.violations,
        'the probe reads result.graph, a graph-bearing property, while naming no graph symbol at all',
      ).toContain('probe.ts -> PublicationGraph (result.graph)')
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'does not flag a property access whose type is not the graph',
    async () => {
      // The same carrier, read through a member that is not the graph. The
      // guard resolves the type of the read, so this read is not a hit.
      const probe = await analyzeProbes((root) => {
        const sourceAdapter = probeSourceAdapterSpecifier(root)
        return {
          'probe.ts': [
            `import type { PublicationSourceResult } from '${sourceAdapter}'`,
            `export function readAssets(result: PublicationSourceResult) {`,
            `  return result.assetBundle`,
            `}`,
            '',
          ].join('\n'),
        }
      })
      expect(
        probe.violations.filter((line) => line.startsWith('probe.ts')),
      ).toEqual([])
      expect(
        probe.propertyAccesses.filter((line) => line.startsWith('probe.ts')),
      ).toEqual([])
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'does not flag a module that declares its own identically named graph type',
    async () => {
      // A local type that shares the name of the graph type is a different
      // type object, so neither the name walk nor the value walk may treat a
      // read of it as a read of the graph.
      const probe = await analyzeProbes(() => ({
        'probe.ts': [
          'export type PublicationGraph = { graph: { id: string } }',
          'export function readGraph(value: PublicationGraph) {',
          '  return value.graph',
          '}',
          '',
        ].join('\n'),
      }))
      expect(
        probe.violations.filter((line) => line.startsWith('probe.ts')),
      ).toEqual([])
      expect(
        probe.propertyAccesses.filter((line) => line.startsWith('probe.ts')),
      ).toEqual([])
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'flags a synthetic graph-bearing element access, so a dynamic read cannot hide',
    async () => {
      const probe = await analyzeProbes((root) => {
        const sourceAdapter = probeSourceAdapterSpecifier(root)
        return {
          'probe.ts': [
            `import type { PublicationSourceResult } from '${sourceAdapter}'`,
            `export function readGraph(result: PublicationSourceResult) {`,
            `  return result['graph']`,
            `}`,
            '',
          ].join('\n'),
        }
      })
      expect(probe.violations).toContain(
        "probe.ts -> PublicationGraph (result['graph'])",
      )
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'flags a synthetic graph-bearing destructured read, so a destructuring cannot hide',
    async () => {
      const probe = await analyzeProbes((root) => {
        const sourceAdapter = probeSourceAdapterSpecifier(root)
        return {
          'probe.ts': [
            `import type { PublicationSourceResult } from '${sourceAdapter}'`,
            `export function readGraph(result: PublicationSourceResult) {`,
            `  const { graph } = result`,
            `  return graph.nodes.length`,
            `}`,
            '',
          ].join('\n'),
        }
      })
      expect(probe.violations).toContain('probe.ts -> PublicationGraph (graph)')
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'flags a synthetic graph-bearing parameter, so a function that receives the graph is caught',
    async () => {
      // The parameter type is written as an indexed access, so the probe
      // names no graph symbol; only the checker can prove that the received
      // value is the graph.
      const probe = await analyzeProbes((root) => {
        const sourceAdapter = probeSourceAdapterSpecifier(root)
        return {
          'probe.ts': [
            `import type { PublicationSourceResult } from '${sourceAdapter}'`,
            `export function readGraph(value: PublicationSourceResult['graph']) {`,
            `  return value.nodes.length`,
            `}`,
            '',
          ].join('\n'),
        }
      })
      expect(probe.violations).toContain(
        "probe.ts -> PublicationGraph (value: PublicationSourceResult['graph'])",
      )
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'analyses the release class in the TypeScript program, so the release assertion is not vacuous',
    () => {
      // The release class names the release scripts and the deployment
      // tools. If the program does not contain them, the release assertion
      // would be green without ever looking at them.
      const release = classes.find((resolved) => resolved.name === 'release')
      expect(release, 'release class').toBeDefined()
      expect(release!.files.length, 'release class').toBeGreaterThan(0)
      const missing = release!.files.filter(
        (file) => !analysis.sourceFiles.has(resolve(REPOSITORY_ROOT, file)),
      )
      expect(missing, 'release class files outside the program').toEqual([])
      for (const required of [
        'tools/publication-build.mjs',
        'tools/publication-check.mjs',
        'tools/publication-adapter-conformance.mjs',
      ]) {
        expect(release!.files, required).toContain(required)
        expect(
          analysis.sourceFiles.has(resolve(REPOSITORY_ROOT, required)),
          required,
        ).toBe(true)
      }
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'examines the release and writer class files for graph-bearing values, so the stronger guard cannot be green while never being applied',
    () => {
      // The value detection has to reach the modules the plan names. Every
      // value access it examined is counted, so a class whose files were
      // never walked cannot pass.
      for (const name of ['release', 'writer']) {
        const resolved = classes.find((candidate) => candidate.name === name)
        expect(resolved, name).toBeDefined()
        const total = resolved!.files.reduce(
          (sum, file) => sum + (examined.get(file) ?? 0),
          0,
        )
        expect(total, `${name} class examined value accesses`).toBeGreaterThan(
          0,
        )
      }
      for (const file of [
        'tools/publication-build.mjs',
        'tools/publication-check.mjs',
        'src/research/publication.worker.ts',
      ]) {
        expect(examined.get(file) ?? 0, file).toBeGreaterThan(0)
      }
    },
    ANALYSIS_TIMEOUT,
  )

  it(
    'keeps the concrete writer functions from receiving or reading the graph',
    () => {
      // The writer functions must neither receive the graph nor read it off
      // a value. Every graph-bearing value access of a writer module is
      // listed, so a writer that grows one is named here.
      const writer = classes.find((resolved) => resolved.name === 'writer')
      expect(writer, 'writer class').toBeDefined()
      const held: string[] = []
      for (const file of writer!.files) {
        for (const access of accesses.get(file) ?? []) {
          held.push(`${file} -> ${access.kind}: ${access.text}`)
        }
      }
      expect(held).toEqual([])
    },
    ANALYSIS_TIMEOUT,
  )
})

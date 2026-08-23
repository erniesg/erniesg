import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import manifest from './parity-manifest.json'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const canonicalRoot = join(packageRoot, '..', '..', 'src', 'struct')

type Mapping = {
  packagePath: string
  canonicalPath: string | null
  rule: string
  canonicalSha256?: string
  packageSha256: string
}

// This is deliberately code-owned. The JSON file is an auditable inventory,
// not an authorization mechanism for adding an arbitrary transform.
const MAPPINGS: readonly Mapping[] = [
  {
    packagePath: 'codec/bytes.ts',
    canonicalPath: 'codec/bytes.ts',
    rule: 'esm-imports',
    canonicalSha256:
      'af31507b6cdd1c738d8aebb5d09bfe7382a18c2c68abae5f927e31685b09746f',
    packageSha256:
      '04549a3f84594453ec90c319ad3b013ac479a99a1861c70344bc5b0cdc80b805',
  },
  {
    packagePath: 'codec/index.ts',
    canonicalPath: 'codec/index.ts',
    rule: 'esm-imports',
    canonicalSha256:
      '3b6ad32b7a16b0250f6d370821d2e18bebb10aa7f65d5787d8ec2d28b2d3d1ac',
    packageSha256:
      'c6e4d730dc782a400a833f79a14f672944e23d0cffd1ac38243b2ae2995eacac',
  },
  {
    packagePath: 'codec/invariants.ts',
    canonicalPath: 'codec/invariants.ts',
    rule: 'model-free-invariants',
    canonicalSha256:
      'ebf1353be5c0012505e8ca41613396e53556d512720b962043c5232535e6b5d9',
    packageSha256:
      'e5f0e4aa5cb13afbf48529ae396a815aadfde8c4907a479763e16c5307ee7c0b',
  },
  {
    packagePath: 'codec/parsers.ts',
    canonicalPath: 'codec/parsers.ts',
    rule: 'model-free-parser',
    canonicalSha256:
      'd5e8dcfcd6b5631b018ecc50b86bd4caa4f1921d417d72647f939c7f376d4164',
    packageSha256:
      '9ba8a268d23c1125d9e7ba7fa63cd24bf23c784da8a8cb725684872d9703edf1',
  },
  {
    packagePath: 'codec/primitives.ts',
    canonicalPath: 'codec/primitives.ts',
    rule: 'safe-id-primitives',
    canonicalSha256:
      'e42bcb8ac2d2a3547eb24a8c1e3dc4203193814a9c58c7a060bdd89d69fc1407',
    packageSha256:
      'b276d35ddd215ce81e5cd06679342adea4e24ceb2175299c4abdfb565735a156',
  },
  {
    packagePath: 'codec/structure.ts',
    canonicalPath: 'codec/structure.ts',
    rule: 'esm-imports',
    canonicalSha256:
      'f621c90887c13bd56ed8961b4c5a880868eecd8fccb422215c482ba76060f743',
    packageSha256:
      '1241ab23eb0da2cd85f7e0ac198b442a4cc0246d75f67603d2980cbe4387fe3e',
  },
  {
    packagePath: 'core.ts',
    canonicalPath: 'codec.ts',
    rule: 'codec-facade',
    canonicalSha256:
      '6bc47d8f02d4471814e0cd830b02c1724cc7e56c4ce227bd5bed261f672aa399',
    packageSha256:
      'b0d32f782b40caa00e932f3b71f317bd353371a6e81f3400aab603b2180b339f',
  },
  {
    packagePath: 'epub.ts',
    canonicalPath: 'epub.ts',
    rule: 'model-free-epub',
    canonicalSha256:
      'd717e2a79def4a901f4110f6bbed2f11c07f08da45b7e3d55ff055164bf75cbb',
    packageSha256:
      '72dc0e76a6634b6e4fa0ed0d69880bb0a355e05fdef6bbf7b191d8f5d9923537',
  },
  {
    packagePath: 'ids.ts',
    canonicalPath: 'ids.ts',
    // The app facade owns SAFE_ID/credential filtering; package primitives
    // provide the equivalent package-local validator.
    rule: 'safe-id-facade',
    canonicalSha256:
      '4b203de70f351fd6eef8ffb3566e932549c8ccf333d2a0586940f9ca51795de8',
    packageSha256:
      '556f86b46550760719984d392266f551e1b3a73b8dc25854f59f5e925e684202',
  },
  {
    packagePath: 'index.ts',
    canonicalPath: 'index.ts',
    rule: 'root-facade',
    canonicalSha256:
      'b8d388b88f776b0ed58d596f88ee54aeb02ca3c8b25778a0697eae0de10524bf',
    packageSha256:
      'c16a9ebc3250fb4bb62c364e079cfc05ea3a77563df301954215695d5efb42fd',
  },
  {
    packagePath: 'reading-order.ts',
    canonicalPath: 'reading-order.ts',
    rule: 'esm-imports',
    canonicalSha256:
      '72f87055322257fb2c9491f3ec1d6ea1540bdfe3447923df140aa16bbfa488ba',
    packageSha256:
      '7c496f3d4bb72f2810e8f9a3ef8a3cc04d359d85158a8148d6ce03bad81cd1d9',
  },
  {
    packagePath: 'recovery.ts',
    canonicalPath: 'recovery.ts',
    rule: 'esm-imports',
    canonicalSha256:
      '6e7cc1c0603d358bb8cd026538743690ebb5db0932d40bfc89945ea62f9e1b1c',
    packageSha256:
      'ac2ab6b8f674008c09a69aad84766c922e767e500e82011c1042656bde754c79',
  },
  {
    packagePath: 'renderers/epub.ts',
    canonicalPath: 'epub.ts',
    rule: 'renderer-epub-facade',
    canonicalSha256:
      'd717e2a79def4a901f4110f6bbed2f11c07f08da45b7e3d55ff055164bf75cbb',
    packageSha256:
      '77dfd2ce81a50ef6e5bcee424b04add78b979fa5f626fd504b8f8abaff535452',
  },
  {
    packagePath: 'renderers/xhtml.ts',
    canonicalPath: 'xhtml.ts',
    rule: 'renderer-xhtml-facade-model-free',
    canonicalSha256:
      '3f1814a3c77c0c25b959e07602a1b294ab43c01b7422782f939da978781ada98',
    packageSha256:
      '6907f349531561be4247374af910145a132d0c240bde6e26a4a78d7f32b680d5',
  },
  {
    packagePath: 'schema.ts',
    canonicalPath: null,
    rule: 'package-only-schema',
    packageSha256:
      'f5de92bf20186bc180bdded5e9e6598f4ec342c74442183cb5ac0b37b368a4d0',
  },
  {
    packagePath: 'sha256.ts',
    canonicalPath: 'sha256.ts',
    rule: 'byte-identical',
    canonicalSha256:
      '7c240348df2f60ec53ee870346ab4d1ac2dfff16b8a32b1464b7b875c1c749f4',
    packageSha256:
      '7c240348df2f60ec53ee870346ab4d1ac2dfff16b8a32b1464b7b875c1c749f4',
  },
  {
    packagePath: 'types.ts',
    canonicalPath: 'types.ts',
    rule: 'model-free-types',
    canonicalSha256:
      'bc3650eee1b698a70394cae853bd7aca21681c6ad2ec876baf1a6c7c072e2516',
    packageSha256:
      '645e9853dd478d5b7d716ed94e844af41b8ee4b80de811337b3f6d5cc24de7e9',
  },
  {
    packagePath: 'xhtml.ts',
    canonicalPath: 'xhtml.ts',
    rule: 'model-free-xhtml',
    canonicalSha256:
      '3f1814a3c77c0c25b959e07602a1b294ab43c01b7422782f939da978781ada98',
    packageSha256:
      '4014eb7be096e01508287c33060a64fb2a5abb66040f00bb36ed8677ca4692a3',
  },
]

const EXCLUDED_CANONICAL: Readonly<Record<string, string>> = {
  'codec/model.ts':
    'PDF-coupled model receipt codec is forbidden from the package',
  'codec.test.ts':
    'canonical codec suite is app-coupled; package characterization suite is maintained locally',
  'epub-integrity.test.ts':
    'canonical EPUB suite is app-coupled; package characterization suite is maintained locally',
  'from-reconstruction.ts':
    'extractor adapter is explicitly outside package core',
  'model-consultation-receipt.ts':
    'provider/model receipt contract is explicitly outside package core',
  'consultation-receipt.ts':
    'generic app receipt binding remains an app compatibility surface; package core is source-neutral',
  'emitted-ids.ts':
    'app publication planning and target admission remain outside package core',
  'struct.test.ts':
    'canonical integration suite imports app/PDF providers; package characterization suites are maintained locally',
}

const MANIFEST_SHA256 =
  '32aa25f69802c4e7d71e86edaa14aa99678422166aca6b5c1212bde4f2b14e72'

async function sourceFiles(root: string, base = root): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name)
      if (entry.isDirectory()) return sourceFiles(path, base)
      return entry.name.endsWith('.ts') ? [relative(base, path)] : []
    }),
  )
  return nested.flat().sort()
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

function normalizeEsmImports(source: string) {
  return source.replace(
    /((?:from\s+|import\(\s*)['"])(\.\.?\/[^'"]+?)\.js(['"])/g,
    '$1$2$3',
  )
}

describe('STRUCT package/canonical parity', () => {
  it('uses a code-owned, hash-bound inventory for both source trees', async () => {
    const packageSources = await sourceFiles(join(packageRoot, 'src'))
    const canonicalSources = await sourceFiles(canonicalRoot)
    const expectedPackageSources = MAPPINGS.map(
      ({ packagePath }) => packagePath,
    ).sort()
    const expectedCanonicalSources = [
      ...MAPPINGS.flatMap(({ canonicalPath }) =>
        canonicalPath === null ? [] : [canonicalPath],
      ),
      ...Object.keys(EXCLUDED_CANONICAL),
    ]
      .filter((path, index, paths) => paths.indexOf(path) === index)
      .sort()
    expect(packageSources).toEqual(expectedPackageSources)
    expect(canonicalSources).toEqual(expectedCanonicalSources)

    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.entries).toEqual(
      Object.fromEntries(
        MAPPINGS.map(({ packagePath, rule }) => [packagePath, rule]),
      ),
    )
    expect(manifest.excludedCanonical).toEqual(EXCLUDED_CANONICAL)
    const manifestBytes = await readFile(
      join(packageRoot, 'test', 'parity-manifest.json'),
    )
    expect(sha256(manifestBytes)).toBe(MANIFEST_SHA256)

    for (const mapping of MAPPINGS) {
      const packageBytes = await readFile(
        join(packageRoot, 'src', mapping.packagePath),
      )
      expect(sha256(packageBytes)).toBe(mapping.packageSha256)
      if (mapping.canonicalPath === null) continue
      const canonicalBytes = await readFile(
        join(canonicalRoot, mapping.canonicalPath),
      )
      expect(sha256(canonicalBytes)).toBe(mapping.canonicalSha256)
      if (mapping.rule === 'byte-identical') {
        expect(packageBytes).toEqual(canonicalBytes)
      } else if (mapping.rule === 'esm-imports') {
        expect(normalizeEsmImports(packageBytes.toString('utf8'))).toBe(
          normalizeEsmImports(canonicalBytes.toString('utf8')),
        )
      }
      const packageSource = packageBytes.toString('utf8')
      if (
        [
          'model-free-invariants',
          'model-free-parser',
          'model-free-epub',
          'model-free-types',
          'safe-id-primitives',
        ].includes(mapping.rule)
      ) {
        expect(packageSource).not.toMatch(
          /model-consultation|modelConsultations|validateModelReceipt|ModelFallbackReceipt/iu,
        )
      }
      if (mapping.rule === 'model-free-epub') {
        expect(packageSource).toContain("from './sha256.js'")
        expect(packageSource).toContain("from './ids.js'")
        expect(packageSource).toContain("from './xhtml.js'")
      }
      if (mapping.rule === 'model-free-xhtml') {
        expect(packageSource).toContain('xhtmlId')
        expect(packageSource).not.toMatch(/model-consultation|PublicationGraph/iu)
      }
      if (mapping.rule === 'renderer-xhtml-facade-model-free') {
        expect(packageSource).toContain("from '../xhtml.js'")
      }
      if (mapping.rule === 'safe-id-facade') {
        expect(packageSource).toContain("from './sha256.js'")
        expect(packageSource).not.toMatch(/model-consultation|PublicationGraph/iu)
      }
    }

    const core = await readFile(join(packageRoot, 'src', 'core.ts'), 'utf8')
    expect(core).toContain("from './codec/index.js'")
    const root = await readFile(join(packageRoot, 'src', 'index.ts'), 'utf8')
    expect(root).toContain("export * from './core.js'")
    expect(root).not.toContain('model-consultation-receipt')
    const xhtmlRenderer = await readFile(
      join(packageRoot, 'src', 'renderers', 'xhtml.ts'),
      'utf8',
    )
    expect(xhtmlRenderer).toContain("from '../xhtml.js'")
    const epubRenderer = await readFile(
      join(packageRoot, 'src', 'renderers', 'epub.ts'),
      'utf8',
    )
    expect(epubRenderer).toContain("from '../epub.js'")
  })
})

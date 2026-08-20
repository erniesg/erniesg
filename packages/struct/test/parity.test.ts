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
      'af4ef7a26e4b02d179179d8c4d7ec12927fd8aacdd358955e5785a03bb976245',
    packageSha256:
      'a26d101cc25f5f34f295adbd67a78c8fb8e3f17d60546906df17ec42b4bbcfea',
  },
  {
    packagePath: 'codec/parsers.ts',
    canonicalPath: 'codec/parsers.ts',
    rule: 'model-free-parser',
    canonicalSha256:
      'a74555d7a139974babda0bf84c3587c77f7e791aaca7942b5a3a811e0f230c89',
    packageSha256:
      '9ba8a268d23c1125d9e7ba7fa63cd24bf23c784da8a8cb725684872d9703edf1',
  },
  {
    packagePath: 'codec/primitives.ts',
    canonicalPath: 'codec/primitives.ts',
    rule: 'safe-id-primitives',
    canonicalSha256:
      '136fc31c551768d0bfb998ff3db7ff0e0667911811686ae5efad9a376812ccd1',
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
      'be3b6f13b24a6a4e1c37bc75a819a1c8670fa82541a6d649403670d556b2ea0f',
    packageSha256:
      '72dc0e76a6634b6e4fa0ed0d69880bb0a355e05fdef6bbf7b191d8f5d9923537',
  },
  {
    packagePath: 'ids.ts',
    canonicalPath: 'ids.ts',
    rule: 'esm-imports',
    canonicalSha256:
      'fefc2d2408acd7fc9c28167dc505af0933d153d73a58d16f5c14dcaa9a11b2d2',
    packageSha256:
      '556f86b46550760719984d392266f551e1b3a73b8dc25854f59f5e925e684202',
  },
  {
    packagePath: 'index.ts',
    canonicalPath: 'index.ts',
    rule: 'root-facade',
    canonicalSha256:
      '94a8359eb2410c286981cca32515d29c228fa45fcb21b4fd9d0b5eea1920e69f',
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
      'be3b6f13b24a6a4e1c37bc75a819a1c8670fa82541a6d649403670d556b2ea0f',
    packageSha256:
      '77dfd2ce81a50ef6e5bcee424b04add78b979fa5f626fd504b8f8abaff535452',
  },
  {
    packagePath: 'renderers/xhtml.ts',
    canonicalPath: 'xhtml.ts',
    rule: 'renderer-xhtml-facade',
    canonicalSha256:
      '1e1dffc579e92107f5f7a10d05b2b9bbb861e0649de59f37f44af92407eae211',
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
      '01478f8f0277565d70bfdf9acdc07e97db796d03cb5b3db8d2aaeddbd1434df0',
    packageSha256:
      '645e9853dd478d5b7d716ed94e844af41b8ee4b80de811337b3f6d5cc24de7e9',
  },
  {
    packagePath: 'xhtml.ts',
    canonicalPath: 'xhtml.ts',
    rule: 'esm-imports',
    canonicalSha256:
      '1e1dffc579e92107f5f7a10d05b2b9bbb861e0649de59f37f44af92407eae211',
    packageSha256:
      'b952851e442e2c2e15011e1d3347e727aa80eb2759aa108b91ed21452f2ab1ed',
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
  'struct.test.ts':
    'canonical integration suite imports app/PDF providers; package characterization suites are maintained locally',
}

const MANIFEST_SHA256 =
  '1b40b3b943c6c5918d3bbcce84baa5274adf4b160d512349da0e47c1a2e6d63a'

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

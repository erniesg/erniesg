import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  EXCLUDED_CANONICAL,
  PARITY_ENTRIES,
  PARITY_MANIFEST_SHA256,
  PARITY_SCHEMA_VERSION,
} from './contracts/source-parity.js'
import manifest from './parity-manifest.json'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function normalizeParityPath(pathValue: string): string {
  return pathValue.replaceAll('\\', '/')
}

async function sourceFiles(root: string, base = root): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name)
      if (entry.isDirectory()) return sourceFiles(path, base)
      return entry.name.endsWith('.ts')
        ? [normalizeParityPath(relative(base, path))]
        : []
    }),
  )
  return nested.flat().sort()
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('STRUCT package source conformance', () => {
  it('uses a code-owned, hash-bound inventory for package sources', async () => {
    expect(normalizeParityPath(String.raw`codec\bytes.ts`)).toBe(
      'codec/bytes.ts',
    )
    const packageSources = await sourceFiles(join(packageRoot, 'src'))
    const expectedPackageSources = PARITY_ENTRIES.map(
      ({ packagePath }) => packagePath,
    ).sort()
    expect(packageSources).toEqual(expectedPackageSources)

    expect(manifest.schemaVersion).toBe(PARITY_SCHEMA_VERSION)
    expect(manifest.entries).toEqual(
      Object.fromEntries(
        PARITY_ENTRIES.map(({ packagePath, rule }) => [packagePath, rule]),
      ),
    )
    expect(manifest.excludedCanonical).toEqual(EXCLUDED_CANONICAL)
    const manifestBytes = await readFile(
      join(packageRoot, 'test', 'parity-manifest.json'),
    )
    expect(sha256(manifestBytes)).toBe(PARITY_MANIFEST_SHA256)

    for (const mapping of PARITY_ENTRIES) {
      const packageBytes = await readFile(
        join(packageRoot, 'src', mapping.packagePath),
      )
      expect(sha256(packageBytes)).toBe(mapping.packageSha256)
      const packageSource = packageBytes.toString('utf8')
      if (mapping.rule === 'generic-receipt') {
        expect(packageSource).not.toMatch(
          /MODEL_FALLBACK_(?:DECISION_CLASSES|EVIDENCE_CODES)|PDF_REGION|ModelConsultationClient|ModelDecisionRequest|ModelIdentity|PdfReconstruction|BookWorld/iu,
        )
      }
      if (mapping.rule === 'safe-id-primitives') {
        expect(packageSource).not.toMatch(
          /model-consultation|modelConsultations|validateModelReceipt|ModelFallbackReceipt/iu,
        )
      }
      if (mapping.rule === 'generic-model-epub') {
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

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import manifest from './parity-manifest.json'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const canonicalRoot = join(packageRoot, '..', '..', 'src', 'struct')

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

describe('STRUCT package/canonical parity', () => {
  it('accounts for every duplicated source file and pins intentional transforms', async () => {
    const packageSources = await sourceFiles(join(packageRoot, 'src'))
    const entries = Object.keys(manifest.entries)
    const accounted = [...entries, ...manifest.packageOnly].sort()
    expect(packageSources).toEqual(accounted)

    for (const [packagePath, entry] of Object.entries(manifest.entries)) {
      const canonicalPath = join(canonicalRoot, entry.canonical)
      const packageBytes = await readFile(join(packageRoot, 'src', packagePath))
      const canonicalBytes = await readFile(canonicalPath)
      expect(entry.reason.length).toBeGreaterThan(0)
      expect(sha256(canonicalBytes)).toBe(entry.canonicalSha256)
      expect(sha256(packageBytes)).toBe(entry.packageSha256)
      if (entry.mode === 'byte-identical')
        expect(packageBytes).toEqual(canonicalBytes)
    }
  })
})

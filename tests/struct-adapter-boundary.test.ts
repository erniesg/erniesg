import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { buildStructDocument as legacyBuild } from '../src/struct/from-reconstruction'
import { buildStructDocument as facadeBuild } from '../src/struct-adapters'
import { buildStructDocument as rootBuild } from '../src/struct'

const root = new URL('../src/', import.meta.url)
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
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts'),
      )
      .map((entry) => new URL(entry.name, directory)),
  ]
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

  it('uses public package paths only from the new facade', async () => {
    const files = await readdir(new URL('struct-adapters/', root))
    for (const file of files.filter((name) => name.endsWith('.ts'))) {
      const source = await readFile(
        new URL(`struct-adapters/${file}`, root),
        'utf8',
      )
      expect(source).not.toMatch(
        /(?:from\s*|import\s*\()\s*['"]@erniesg\/struct\/(?:src|dist|internal|private)(?:\/|['"])/,
      )
      expect(source).not.toMatch(
        /from\s*['"][^'"]*node_modules\/.*@erniesg\/struct/,
      )
    }
  })

  it('keeps portable implementation modules independent of app reconstruction', async () => {
    for (const file of await portableFiles(new URL('struct/', root))) {
      if (
        file.pathname.endsWith('/from-reconstruction.ts') ||
        file.pathname.endsWith('/struct/index.ts')
      )
        continue
      const source = await readFile(file, 'utf8')
      expect(source, file.pathname).not.toMatch(
        /(?:from\s*|import\s*\()\s*['"][^'"]*(?:struct-adapters|from-reconstruction)(?:\/[^'"]*)?['"]/,
      )
    }
  })
})

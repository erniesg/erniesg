import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function filesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const child = join(path, entry.name)
      return entry.isDirectory() ? filesUnder(child) : [child]
    }),
  )
  return nested.flat()
}

describe('STRUCT package artifact boundary', () => {
  it('publishes only built files and contains no private consumer contracts', async () => {
    const manifest = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { files?: string[]; exports?: Record<string, unknown> }
    expect(manifest.files).toEqual(['dist'])
    expect(Object.keys(manifest.exports ?? {})).toEqual([
      '.',
      './core',
      './schema',
      './ids',
      './recovery',
      './renderers/xhtml',
      './renderers/epub',
    ])

    const sourceFiles = await filesUnder(join(root, 'src'))
    const forbidden =
      /(?:reconstruction|publication|astro|pdf|provider|model|bookworld)/iu
    expect(sourceFiles.some((path) => forbidden.test(path))).toBe(false)
  })
})

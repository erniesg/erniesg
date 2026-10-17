import { describe, expect, it, vi } from 'vitest'
import { sha256 } from './content.mjs'

vi.mock('node:fs/promises', () => ({
  default: { readFile: vi.fn(async () => 'source'), writeFile: vi.fn() },
}))
vi.mock('./content.mjs', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readMdxFile: vi.fn(async (path) => ({
      raw: '---\nlang: zh\n---\n原文',
      frontmatter: path.endsWith('index.mdx') ? { lang: 'en' } : { lang: 'zh' },
    })),
  }
})
import { classifyFile } from './classify.mjs'
import fs from 'node:fs/promises'

describe('existing translation ownership classification', () => {
  it('preserves unknown content as human owned without inventing machine provenance', async () => {
    const manifest = { families: {} }
    const filePath = 'src/content/blog/x/zh.mdx'
    await classifyFile(filePath, { config: {}, manifest, apply: true })
    const record = manifest.families.x.targets.zh
    const written = fs.writeFile.mock.calls.at(-1)[1]
    expect(written).toContain('translationStatus: edited')
    expect(written).toContain('translationSource: human')
    expect(written).toContain('原文')
    expect(record.status).toBe('edited')
    expect(record.provider).toBe('human')
    expect(record.model).toBeNull()
    expect(record.targetSha256).toBe(sha256(written))
  })

  it('skips configured originals before reading or writing', async () => {
    const filePath = 'src/content/blog/x/zh.mdx'
    const result = await classifyFile(filePath, {
      config: { protectedHumanTranslations: [filePath] },
      manifest: {},
      apply: true,
    })
    expect(result.action).toBe('skipped-protected')
  })
})

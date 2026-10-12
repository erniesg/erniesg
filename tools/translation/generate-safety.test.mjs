import { describe, expect, it, vi } from 'vitest'

vi.mock('./content.mjs', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    loadConfig: vi.fn(async () => ({
      protectedHumanTranslations: ['src/content/blog/x/zh.mdx'],
    })),
    loadManifest: vi.fn(async () => ({})),
    readMdxFile: vi.fn(async () => ({
      raw: 'source',
      frontmatter: { lang: 'en' },
    })),
  }
})
vi.mock('./providers.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  createStructuredTranslation: vi.fn(),
}))

import { generateTranslation } from './generate.mjs'
import { createStructuredTranslation } from './providers.mjs'

describe('generation protection', () => {
  it('refuses protected targets before calling any translation provider', async () => {
    await expect(
      generateTranslation({
        sourcePath: 'src/content/blog/x/index.mdx',
        targetLocale: 'zh',
        write: true,
      }),
    ).rejects.toThrow('protected translation')
    expect(createStructuredTranslation).not.toHaveBeenCalled()
  })
})

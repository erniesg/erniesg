import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { addLocalizedSitemapRoutes } from './pages-sitemap.mjs'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localized-sitemap-'))
  const distDir = path.join(root, 'dist')
  await Promise.all([
    mkdir(path.join(distDir, 'research'), { recursive: true }),
    mkdir(path.join(distDir, 'private'), { recursive: true }),
    mkdir(path.join(distDir, '404'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(
      path.join(distDir, 'research', 'index.html'),
      '<html><head></head><body>Research</body></html>',
    ),
    writeFile(
      path.join(distDir, 'private', 'index.html'),
      '<html><head><meta name="robots" content="noindex, nofollow"></head><body>Private</body></html>',
    ),
    writeFile(
      path.join(distDir, '404', 'index.html'),
      '<html><head></head><body>Missing</body></html>',
    ),
    writeFile(
      path.join(distDir, 'sitemap-0.xml'),
      '<?xml version="1.0"?><urlset><url><loc>https://preview.example/</loc></url><url><loc>https://preview.example/blog/native/zh/</loc></url><url><loc>https://preview.example/research/zh/</loc></url></urlset>',
    ),
  ])
  return { root, distDir }
}

describe('localized sitemap routes', () => {
  it('adds indexable locale siblings while preserving native entries and derives the current origin', async () => {
    const { root, distDir } = await fixture()
    try {
      const catalog = {
        pages: {
          '/research/': { sourcePath: 'research/index.html' },
          '/private/': { sourcePath: 'private/index.html' },
          '/404/': { sourcePath: '404/index.html' },
        },
      }
      await addLocalizedSitemapRoutes({ distDir, catalog })
      const xml = await readFile(path.join(distDir, 'sitemap-0.xml'), 'utf8')
      expect(xml).toContain('https://preview.example/blog/native/zh/')
      expect(
        xml.match(/https:\/\/preview\.example\/research\/zh\//gu),
      ).toHaveLength(1)
      expect(xml).toContain('https://preview.example/research/ja/')
      expect(xml).toContain('https://preview.example/research/ko/')
      expect(xml).not.toContain('/private/zh/')
      expect(xml).not.toContain('/404/zh/')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is idempotent after it has added missing locale routes', async () => {
    const { root, distDir } = await fixture()
    try {
      const catalog = {
        pages: { '/research/': { sourcePath: 'research/index.html' } },
      }
      await addLocalizedSitemapRoutes({ distDir, catalog })
      const first = await readFile(path.join(distDir, 'sitemap-0.xml'), 'utf8')
      const result = await addLocalizedSitemapRoutes({ distDir, catalog })
      expect(result.added).toEqual([])
      await expect(
        readFile(path.join(distDir, 'sitemap-0.xml'), 'utf8'),
      ).resolves.toBe(first)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  pruneResearchArtifacts,
  researchReleaseEnabled,
} from './research-release-gate.mjs'

const roots = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('research release gate', () => {
  it('is default-off and requires an explicit true value', () => {
    expect(researchReleaseEnabled({})).toBe(false)
    expect(researchReleaseEnabled({ PUBLIC_RESEARCH_ENABLED: 'false' })).toBe(
      false,
    )
    expect(researchReleaseEnabled({ PUBLIC_RESEARCH_ENABLED: 'true' })).toBe(
      true,
    )
  })

  it('removes staged routes and sitemap entries from production artifacts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'research-release-'))
    roots.push(root)
    await mkdir(path.join(root, 'research'), { recursive: true })
    await writeFile(path.join(root, 'research', 'index.html'), 'staged')
    await writeFile(
      path.join(root, 'sitemap-0.xml'),
      '<urlset><url><loc>https://ernie.sg/research/</loc></url><url><loc>https://ernie.sg/blog/</loc></url></urlset>',
    )

    const report = await pruneResearchArtifacts(root, false)

    expect(report.removedResearch).toBe(true)
    await expect(
      readFile(path.join(root, 'research', 'index.html')),
    ).rejects.toThrow()
    expect(
      await readFile(path.join(root, 'sitemap-0.xml'), 'utf8'),
    ).not.toContain('/research')
  })

  it('preserves research artifacts for an explicit staging build', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'research-release-'))
    roots.push(root)
    await mkdir(path.join(root, 'research'), { recursive: true })
    await writeFile(path.join(root, 'research', 'index.html'), 'staged')

    const report = await pruneResearchArtifacts(root, true)

    expect(report.removedResearch).toBe(false)
    expect(
      await readFile(path.join(root, 'research', 'index.html'), 'utf8'),
    ).toBe('staged')
  })
})

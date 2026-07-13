import { access, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function researchReleaseEnabled(environment = process.env) {
  return environment.PUBLIC_RESEARCH_ENABLED === 'true'
}

export async function pruneResearchArtifacts(
  distDirectory,
  enabled = researchReleaseEnabled(),
) {
  if (enabled) return { removedResearch: false, updatedSitemaps: [] }

  const researchDirectory = path.join(distDirectory, 'research')
  let removedResearch = false
  try {
    await access(researchDirectory)
    await rm(researchDirectory, { recursive: true, force: true })
    removedResearch = true
  } catch {
    // A missing staged route is already a safe production state.
  }

  const updatedSitemaps = []
  const entries = await readdir(distDirectory).catch(() => [])
  for (const entry of entries.filter(
    (name) => name.startsWith('sitemap') && name.endsWith('.xml'),
  )) {
    const sitemapPath = path.join(distDirectory, entry)
    const original = await readFile(sitemapPath, 'utf8')
    const filtered = original.replace(
      /<url>\s*<loc>https?:\/\/[^<]+\/research(?:\/[^<]*)?<\/loc>[\s\S]*?<\/url>/g,
      '',
    )
    if (filtered !== original) {
      await writeFile(sitemapPath, filtered)
      updatedSitemaps.push(entry)
    }
  }

  return { removedResearch, updatedSitemaps }
}

async function main() {
  const distDirectory = path.resolve(process.cwd(), 'dist')
  const enabled = researchReleaseEnabled()
  const report = await pruneResearchArtifacts(distDirectory, enabled)
  const state = enabled ? 'staging-enabled' : 'production-gated'
  process.stdout.write(
    `[research-release] ${state}: ${JSON.stringify(report)}\n`,
  )
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main()
}

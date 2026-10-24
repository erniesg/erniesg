import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { localizedSitemapPaths } from './pages.mjs'

function escapeXml(value) {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[character],
  )
}

function sitemapLocations(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) => match[1])
}

function isNoIndex(html) {
  return (
    /<meta\b(?=[^>]*\b(?:name|property)\s*=\s*["']?(?:robots|googlebot)["']?)(?=[^>]*\bcontent\s*=\s*["'][^"']*\bnoindex\b[^"']*["'])[^>]*>/iu.test(
      html,
    ) ||
    /<meta\b(?=[^>]*\bcontent\s*=\s*["'][^"']*\bnoindex\b[^"']*["'])(?=[^>]*\b(?:name|property)\s*=\s*["']?(?:robots|googlebot)["']?)[^>]*>/iu.test(
      html,
    )
  )
}

function isNotFoundRoute(route) {
  return (
    route === '/404/' ||
    route.startsWith('/404/') ||
    /(?:^|\/)404(?:\/|$)/u.test(route)
  )
}

async function sitemapFileFor(distDir) {
  const files = (await fs.readdir(distDir))
    .filter((name) => /^sitemap-(?!index\.xml$).+\.xml$/u.test(name))
    .sort()
  if (files.length !== 1) {
    throw new Error(
      `Expected one generated sitemap in ${distDir}; found ${files.length}`,
    )
  }
  return path.join(distDir, files[0])
}

async function indexableRoutes(catalog, distDir) {
  const routes = []
  for (const [route, page] of Object.entries(catalog.pages ?? {})) {
    if (isNotFoundRoute(route)) continue
    const sourcePath = page.sourcePath
    if (!sourcePath) continue
    const html = await fs.readFile(path.join(distDir, sourcePath), 'utf8')
    if (!isNoIndex(html)) routes.push(route)
  }
  return routes
}

/**
 * Adds the generated translations to Astro's existing sitemap without replacing
 * its native post entries. The first absolute <loc> supplies the deployment
 * origin, so previews retain their own host rather than inheriting a constant.
 */
export async function addLocalizedSitemapRoutes({
  distDir = 'dist',
  catalog,
  catalogPath = '.translation/pages.json',
  sitemapPath,
} = {}) {
  const loadedCatalog =
    catalog ?? JSON.parse(await fs.readFile(catalogPath, 'utf8'))
  const outputPath = sitemapPath ?? (await sitemapFileFor(distDir))
  const xml = await fs.readFile(outputPath, 'utf8')
  const locations = sitemapLocations(xml)
  if (!locations.length)
    throw new Error(`Cannot derive an origin from ${outputPath}`)
  const origin = new URL(locations[0]).origin
  const routes = await indexableRoutes(loadedCatalog, distDir)
  const paths = localizedSitemapPaths({
    pages: Object.fromEntries(routes.map((route) => [route, {}])),
  })
  const existing = new Set(locations)
  const additions = paths
    .map((pathname) => new URL(pathname, origin).href)
    .filter((url) => !existing.has(url))
    .map((url) => `<url><loc>${escapeXml(url)}</loc></url>`)
  if (!additions.length) return { sitemapPath: outputPath, added: [] }
  if (!xml.includes('</urlset>'))
    throw new Error(`Invalid sitemap XML: ${outputPath}`)
  const next = xml.replace('</urlset>', `${additions.join('')}</urlset>`)
  const temporaryPath = `${outputPath}.tmp`
  await fs.writeFile(temporaryPath, next)
  await fs.rename(temporaryPath, outputPath)
  return { sitemapPath: outputPath, added: additions }
}

async function main() {
  const { values: args } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: { dist: { type: 'string' }, catalog: { type: 'string' } },
  })
  await addLocalizedSitemapRoutes({
    distDir: args.dist ?? 'dist',
    catalogPath: args.catalog ?? '.translation/pages.json',
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

/**
 * The redirects ADR 010 owes every URL it moved.
 *
 * `/research/*` became `/papers/*`, the two copies of the PDF-to-EPUB importer
 * (`/research/studio` and `/study/experiments/pdf-to-epub`) collapsed into
 * `/library`, and the benchmark review queue moved with the importer it
 * embeds, to `/library/pdf-review`. Nothing that used to answer may 404.
 *
 * The rules are the one source of truth. The table is never written by hand:
 * the build derives it from what Astro actually emitted under the new
 * prefixes, so a page or an asset added under `/papers` gets its `/research`
 * twin without anyone remembering to add it. The same rules answer the dev
 * server, write the static stubs, and write Cloudflare's `_redirects`.
 *
 * Plain JavaScript on purpose: `astro.config.ts`, the production release gate
 * (a bare `node` script), vitest and Playwright all import it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const REDIRECT_STATUS = 301
export const REDIRECTS_FILE = '_redirects'

/** Legacy routes that do not map by prefix. Keys carry no trailing slash. */
export const LEGACY_EXACT_REDIRECTS = Object.freeze({
  '/research/studio': '/library/',
  '/research/pdf-review': '/library/pdf-review/',
  '/study': '/library/',
  '/study/experiments': '/library/',
  '/study/experiments/pdf-to-epub': '/library/',
})

/** URL prefixes that no longer own any content, only redirects. */
export const LEGACY_PREFIXES = Object.freeze(['/research', '/study'])

function trimTrailingSlash(pathname) {
  return pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname
}

/**
 * @typedef {{ from: string, to: string, kind: 'page' | 'file' }} Redirect
 */

/**
 * A path whose last segment has an extension names a file, not a page.
 * @param {string} pathname
 * @returns {boolean}
 */
export function isFilePath(pathname) {
  const last = trimTrailingSlash(pathname).split('/').pop() ?? ''
  return /\.[a-z0-9]+$/iu.test(last)
}

/**
 * Where a legacy URL now lives, or `null` if the path was never legacy.
 * Pages resolve to their trailing-slash form, which is what the static host
 * serves without a second hop; files keep their exact name.
 * @param {string} pathname
 * @returns {string | null}
 */
export function legacyRedirectTarget(pathname) {
  const trimmed = trimTrailingSlash(pathname)
  if (Object.hasOwn(LEGACY_EXACT_REDIRECTS, trimmed)) {
    return LEGACY_EXACT_REDIRECTS[trimmed]
  }
  if (trimmed === '/research') return '/papers/'
  if (trimmed.startsWith('/research/')) {
    const rest = trimmed.slice('/research'.length)
    return isFilePath(trimmed) ? `/papers${rest}` : `/papers${rest}/`
  }
  // `/study` held one route. Anything else under it goes where that went.
  if (trimmed.startsWith('/study/')) return '/library/'
  return null
}

/**
 * Every legacy URL that must land on `target`, the inverse of the rules.
 * @param {string} target
 * @returns {string[]}
 */
export function legacySourcesFor(target) {
  const page = !isFilePath(target)
  const normalized = page ? `${trimTrailingSlash(target)}/` : target
  const sources = Object.entries(LEGACY_EXACT_REDIRECTS)
    .filter(([, to]) => to === normalized)
    .map(([from]) => from)
  const trimmed = trimTrailingSlash(normalized)
  if (trimmed === '/papers') sources.push('/research')
  else if (trimmed.startsWith('/papers/')) {
    sources.push(`/research${trimmed.slice('/papers'.length)}`)
  }
  return sources.sort()
}

/**
 * One redirect per legacy URL, for the set of new URLs a build produced.
 * `kind` is `page` for anything served as `index.html`, `file` otherwise.
 * @param {readonly string[]} targets
 * @returns {Redirect[]}
 */
export function redirectTable(targets) {
  /** @type {Map<string, Redirect>} */
  const table = new Map()
  for (const target of targets) {
    for (const from of legacySourcesFor(target)) {
      const to = legacyRedirectTarget(from)
      if (to === null) continue
      table.set(from, { from, to, kind: isFilePath(from) ? 'file' : 'page' })
    }
  }
  return [...table.values()].sort((a, b) => a.from.localeCompare(b.from))
}

/**
 * The new URLs a built site serves under the prefixes that inherited legacy
 * routes: every emitted page and every emitted file, assets included.
 * @param {string} outDir
 * @returns {Promise<string[]>}
 */
export async function builtTargets(outDir) {
  const targets = []
  for (const prefix of ['papers', 'library']) {
    const root = path.join(outDir, prefix)
    if (!existsSync(root)) continue
    for (const file of await walk(root)) {
      const relative = path.relative(outDir, file).split(path.sep).join('/')
      if (relative.endsWith('/index.html') || relative === 'index.html') {
        targets.push(`/${relative.slice(0, -'index.html'.length)}`)
      } else {
        targets.push(`/${relative}`)
      }
    }
  }
  return targets.sort()
}

async function walk(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(full)))
    else files.push(full)
  }
  return files
}

/**
 * @param {readonly Redirect[]} table
 * @returns {string}
 */
export function redirectsFileBody(table) {
  const lines = [
    '# Generated by tools/ia-redirects.mjs from the built /papers and /library',
    '# trees (ADR 010). Do not edit: rebuild instead.',
  ]
  for (const { from, to, kind } of table) {
    lines.push(`${from} ${to} ${REDIRECT_STATUS}`)
    if (kind === 'page') lines.push(`${from}/ ${to} ${REDIRECT_STATUS}`)
  }
  // A safety net behind the enumerated table, so a legacy URL nobody
  // enumerated still lands somewhere rather than 404ing. First match wins, so
  // every exact entry above it takes precedence.
  lines.push(`/research/* /papers/:splat ${REDIRECT_STATUS}`)
  lines.push(`/study/* /library/ ${REDIRECT_STATUS}`)
  return `${lines.join('\n')}\n`
}

/**
 * @param {string} body
 * @returns {{ from: string, to: string, status: number }[]}
 */
export function parseRedirectsFile(body) {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [from, to, status] = line.split(/\s+/u)
      return { from, to, status: Number(status) }
    })
}

/**
 * @param {string} to
 * @param {string} [site]
 * @returns {string}
 */
export function redirectStubHtml(to, site) {
  const canonical = site ? new URL(to, site).toString() : to
  return [
    '<!doctype html>',
    `<title>Redirecting to: ${to}</title>`,
    '<meta name="robots" content="noindex">',
    `<meta http-equiv="refresh" content="0;url=${to}">`,
    `<link rel="canonical" href="${canonical}">`,
    `<body><a href="${to}">Redirecting to ${to}</a></body>`,
    '',
  ].join('\n')
}

/**
 * Where a page redirect's static stub lives inside the output directory.
 * @param {string} outDir
 * @param {string} from
 * @returns {string}
 */
export function stubPath(outDir, from) {
  return path.join(outDir, ...from.split('/').filter(Boolean), 'index.html')
}

/**
 * Writes the redirect table into a finished build: `_redirects` for the
 * static host, which answers with a real 301, and an HTML stub at every
 * legacy page path for any host that does not read `_redirects`.
 * @param {string} outDir
 * @param {{ site?: string }} [options]
 * @returns {Promise<Redirect[]>}
 */
export async function writeBuildRedirects(outDir, { site } = {}) {
  const table = redirectTable(await builtTargets(outDir))
  for (const { from, to, kind } of table) {
    if (kind !== 'page') continue
    const file = stubPath(outDir, from)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, redirectStubHtml(to, site))
  }
  await writeFile(path.join(outDir, REDIRECTS_FILE), redirectsFileBody(table))
  return table
}

/**
 * The legacy URLs a checkout owes a redirect, read from the source tree
 * rather than from a build: the route files under `src/pages/papers` and
 * `src/pages/library`, with each dynamic segment expanded from `params`, and
 * every asset under `public/papers`.
 * @param {string} root
 * @param {Record<string, readonly string[]>} params
 * @returns {string[]}
 */
export function sourceRouteManifest(root, params) {
  const targets = []
  for (const prefix of ['papers', 'library']) {
    const pagesRoot = path.join(root, 'src', 'pages', prefix)
    if (!existsSync(pagesRoot)) continue
    for (const file of walkSync(pagesRoot)) {
      const relative = path
        .relative(path.join(root, 'src', 'pages'), file)
        .split(path.sep)
        .join('/')
      targets.push(...expandRoute(relative, params))
    }
  }
  const assetsRoot = path.join(root, 'public', 'papers')
  if (existsSync(assetsRoot)) {
    for (const file of walkSync(assetsRoot)) {
      const relative = path
        .relative(path.join(root, 'public'), file)
        .split(path.sep)
        .join('/')
      targets.push(`/${relative}`)
    }
  }
  return targets.sort()
}

/**
 * The ids of the papers in `src/research/papers/`, read straight off disk so
 * a caller that cannot load the paper modules can still expand `[id]`.
 * @param {string} root
 * @returns {string[]}
 */
export function paperIdsOnDisk(root) {
  const directory = path.join(root, 'src', 'research', 'papers')
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(path.join(directory, name), 'utf8')).id)
    .sort()
}

function walkSync(directory) {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name)
    return statSync(full).isDirectory() ? walkSync(full) : [full]
  })
}

/** `papers/[id]/manifest.json.ts` → `/papers/<each id>/manifest.json`. */
function expandRoute(relative, params) {
  let route
  if (relative.endsWith('.astro')) {
    route = relative.slice(0, -'.astro'.length)
    route = route === 'index' || route.endsWith('/index')
      ? route.slice(0, -'index'.length)
      : `${route}/`
  } else if (/\.(ts|js|mjs)$/u.test(relative)) {
    route = relative.replace(/\.(ts|js|mjs)$/u, '')
  } else {
    return []
  }
  let expanded = [`/${route}`]
  for (const [, name] of route.matchAll(/\[([^\]]+)\]/gu)) {
    const values = params[name]
    if (!values) throw new Error(`No values for route parameter [${name}]`)
    expanded = expanded.flatMap((candidate) =>
      values.map((value) => candidate.replace(`[${name}]`, value)),
    )
  }
  return expanded
}


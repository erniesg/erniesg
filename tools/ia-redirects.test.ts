import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { EXPORT_PACKAGE_PATHS } from '../src/research/export-package-paths'
import { papers } from '../src/research/papers'
import {
  legacyRedirectTarget,
  legacySourcesFor,
  paperIdsOnDisk,
  parseRedirectsFile,
  redirectTable,
  sourceRouteManifest,
  stubPath,
  writeBuildRedirects,
} from './ia-redirects.mjs'
import {
  applyReleaseGate,
  verifyPostGate,
  WITHHELD_IN_PRODUCTION,
} from './deployment/release-gate.mjs'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const PARAMS = {
  id: papers.map((paper) => paper.id),
  file: [...EXPORT_PACKAGE_PATHS],
}

/** The URLs this checkout serves under the prefixes that inherited /research. */
const manifest = sourceRouteManifest(ROOT, PARAMS)
const table = redirectTable(manifest)
const byFrom = new Map(table.map((entry) => [entry.from, entry.to]))

describe('the ADR 010 route moves', () => {
  it('leaves no content under the legacy prefixes', () => {
    for (const legacy of [
      'src/pages/research',
      'src/pages/study',
      'public/research',
    ]) {
      expect(existsSync(path.join(ROOT, legacy)), legacy).toBe(false)
    }
  })

  it('finds on disk exactly the papers the site builds', () => {
    expect(paperIdsOnDisk(ROOT)).toEqual([...PARAMS.id].sort())
  })

  it('reads the route manifest from pages and from public assets', () => {
    expect(manifest).toEqual(
      expect.arrayContaining([
        '/papers/',
        '/library/',
        '/library/pdf-review/',
        ...PARAMS.id.map((id) => `/papers/${id}/`),
        ...PARAMS.id.map((id) => `/papers/${id}/manifest.json`),
        ...PARAMS.id.map((id) => `/papers/${id}/source.json`),
        '/papers/if-letters-home-could-sing/if-letters-home-could-sing.pdf',
        '/papers/if-letters-home-could-sing/if-letters-home-could-sing.epub',
        '/papers/if-letters-home-could-sing/media/image1.png',
        '/papers/if-letters-home-could-sing/media/image2.jpg',
        '/papers/if-letters-home-could-sing/media/image3.jpg',
      ]),
    )
  })

  it('owes every served URL under /papers a /research twin', () => {
    for (const target of manifest.filter((url) => url.startsWith('/papers'))) {
      const legacy = `/research${target.slice('/papers'.length)}`.replace(
        /\/$/u,
        '',
      )
      expect(byFrom.get(legacy), legacy).toBe(target)
    }
  })

  it('redirects every export file of every paper', () => {
    for (const id of PARAMS.id) {
      for (const file of PARAMS.file) {
        expect(byFrom.get(`/research/${id}/exports/${file}`)).toBe(
          `/papers/${id}/exports/${file}`,
        )
      }
    }
  })

  it('collapses both importer routes and the review queue into /library', () => {
    expect(byFrom.get('/research/studio')).toBe('/library/')
    expect(byFrom.get('/study/experiments/pdf-to-epub')).toBe('/library/')
    expect(byFrom.get('/study')).toBe('/library/')
    expect(byFrom.get('/research/pdf-review')).toBe('/library/pdf-review/')
    expect(byFrom.get('/research')).toBe('/papers/')
  })

  it('points every redirect at a URL the checkout serves', () => {
    const served = new Set(manifest)
    for (const { from, to } of table) {
      expect(served.has(to), `${from} → ${to}`).toBe(true)
    }
  })

  it('answers the rules with and without a trailing slash', () => {
    expect(legacyRedirectTarget('/research/studio/')).toBe('/library/')
    expect(legacyRedirectTarget('/research/x/manifest.json')).toBe(
      '/papers/x/manifest.json',
    )
    expect(legacyRedirectTarget('/study/anything/else')).toBe('/library/')
    expect(legacyRedirectTarget('/papers/x/')).toBeNull()
    expect(legacyRedirectTarget('/researcher')).toBeNull()
    expect(legacySourcesFor('/library/')).toEqual([
      '/research/studio',
      '/study',
      '/study/experiments',
      '/study/experiments/pdf-to-epub',
    ])
  })
})

describe('the production release gate', () => {
  let outDir: string | undefined

  afterEach(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true })
    outDir = undefined
  })

  /** A built site shaped like `astro build` output, from the real manifest. */
  async function builtSite() {
    const dir = await mkdtemp(path.join(tmpdir(), 'ia-redirects-'))
    for (const url of manifest) {
      const file = url.endsWith('/')
        ? path.join(dir, ...url.split('/').filter(Boolean), 'index.html')
        : path.join(dir, ...url.split('/').filter(Boolean))
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, url)
    }
    await writeFile(path.join(dir, 'index.html'), '/')
    await writeBuildRedirects(dir, { site: 'https://ernie.sg' })
    return dir
  }

  it('writes a 301 and a stub for every legacy URL of the build', async () => {
    outDir = await builtSite()
    const entries = parseRedirectsFile(
      await readFile(path.join(outDir, '_redirects'), 'utf8'),
    )
    const froms = new Set(entries.map((entry) => entry.from))

    for (const { from, to, kind } of table) {
      expect(froms.has(from), from).toBe(true)
      if (kind === 'page') {
        expect(froms.has(`${from}/`), `${from}/`).toBe(true)
        const stub = await readFile(stubPath(outDir, from), 'utf8')
        expect(stub).toContain(`content="0;url=${to}"`)
        expect(stub).toContain('noindex')
      }
    }
    expect(entries.every((entry) => entry.status === 301)).toBe(true)
  })

  it('withholds the papers and keeps every redirect after the gate', async () => {
    outDir = await builtSite()

    expect(await applyReleaseGate(outDir)).toEqual([])

    for (const withheld of WITHHELD_IN_PRODUCTION) {
      expect(existsSync(path.join(outDir, withheld)), withheld).toBe(false)
    }
    expect(existsSync(path.join(outDir, 'library', 'index.html'))).toBe(true)
    for (const { from, kind } of table) {
      if (kind === 'page') {
        expect(existsSync(stubPath(outDir, from)), from).toBe(true)
      }
    }
  })

  it('refuses an artifact whose legacy stubs were deleted', async () => {
    outDir = await builtSite()
    // What the gate used to do: delete the whole legacy tree after Astro
    // emitted it, which kept every old URL alive only on the dev server.
    await rm(path.join(outDir, 'research'), { recursive: true, force: true })

    const problems = await applyReleaseGate(outDir)

    expect(problems).toContain('/research/studio lost its redirect stub')
    expect(problems).toContain('/research lost its redirect stub')
  })

  it('refuses an artifact with no redirect table', async () => {
    outDir = await builtSite()
    await rm(path.join(outDir, '_redirects'))

    expect(await verifyPostGate(outDir)).toEqual([
      '_redirects is missing from the built output',
    ])
  })
})

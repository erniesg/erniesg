import { existsSync } from 'node:fs'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  isFilePath,
  LEGACY_PREFIXES,
  legacyRedirectTarget,
  parseRedirectsFile,
  REDIRECT_STATUS,
  REDIRECTS_FILE,
  stubPath,
} from '../ia-redirects.mjs'

/**
 * What a production build withholds. Publishing research is the owner's call
 * (ADR 010), so the papers stay out of the production artifact exactly as
 * `/research` did, and so does the benchmark queue that moved to `/library`
 * with the importer it embeds. The importer at `/library` itself is not
 * withheld: `/study/experiments/pdf-to-epub` already shipped it.
 */
export const WITHHELD_IN_PRODUCTION = Object.freeze([
  'papers',
  'library/pdf-review',
])

/**
 * Removes the withheld trees and nothing else. The legacy `/research` and
 * `/study` trees now hold only redirect stubs, and `_redirects` holds the
 * 301s; deleting either would turn every old URL into a 404 in the deployed
 * artifact even though the dev server redirects it.
 */
export async function applyReleaseGate(outDir) {
  for (const withheld of WITHHELD_IN_PRODUCTION) {
    await rm(path.join(outDir, withheld), { recursive: true, force: true })
  }
  await dropRedirectsIntoWithheld(outDir)
  return verifyPostGate(outDir)
}

/**
 * True when `to` lands inside a tree this gate withholds.
 * @param {string} to
 */
function intoWithheld(to) {
  return WITHHELD_IN_PRODUCTION.some(
    (withheld) => to === `/${withheld}` || to.startsWith(`/${withheld}/`),
  )
}

/**
 * A redirect into a withheld tree would 301 a reader onto a 404 and name what
 * production withholds, so the gate drops it with its stub. That legacy URL
 * is then a plain 404, which is what it was before these trees moved.
 * @param {string} outDir
 */
async function dropRedirectsIntoWithheld(outDir) {
  const redirectsPath = path.join(outDir, REDIRECTS_FILE)
  if (!existsSync(redirectsPath)) return
  const kept = []
  for (const line of (await readFile(redirectsPath, 'utf8')).split('\n')) {
    const [entry] = parseRedirectsFile(line)
    if (!entry || !intoWithheld(entry.to)) {
      kept.push(line)
      continue
    }
    if (!entry.from.includes('*') && !isFilePath(entry.from)) {
      const stub = stubPath(outDir, entry.from)
      await rm(stub, { force: true })
      await removeEmptyParents(path.dirname(stub), outDir)
    }
  }
  await writeFile(redirectsPath, kept.join('\n'))
}

/**
 * @param {string} directory
 * @param {string} stopAt
 */
async function removeEmptyParents(directory, stopAt) {
  let current = directory
  while (current.startsWith(stopAt) && current !== stopAt) {
    if ((await readdir(current).catch(() => ['?'])).length > 0) return
    await rm(current, { recursive: true, force: true })
    current = path.dirname(current)
  }
}

/**
 * Whether the artifact serves `to`: a page target needs its `index.html`, a
 * file target the file itself.
 * @param {string} outDir
 * @param {string} to
 */
function serves(outDir, to) {
  const segments = to.split('/').filter(Boolean)
  return isFilePath(to)
    ? existsSync(path.join(outDir, ...segments))
    : existsSync(path.join(outDir, ...segments, 'index.html'))
}

/**
 * Checks the artifact that actually deploys, after the gate ran: every
 * redirect is still there, every legacy page still has its stub, no legacy
 * tree carries content, and nothing withheld survived.
 */
export async function verifyPostGate(outDir) {
  const problems = []
  const redirectsPath = path.join(outDir, REDIRECTS_FILE)
  if (!existsSync(redirectsPath)) {
    return [`${REDIRECTS_FILE} is missing from the built output`]
  }
  const entries = parseRedirectsFile(await readFile(redirectsPath, 'utf8'))
  for (const prefix of LEGACY_PREFIXES) {
    if (!entries.some(({ from }) => from.startsWith(prefix))) {
      problems.push(`${REDIRECTS_FILE} redirects nothing under ${prefix}`)
    }
  }
  for (const { from, to, status } of entries) {
    if (status !== REDIRECT_STATUS) {
      problems.push(`${from} redirects with ${status}, not ${REDIRECT_STATUS}`)
    }
    if (intoWithheld(to)) {
      problems.push(`${from} redirects into ${to}, which production withholds`)
    }
    if (from.includes('*')) continue
    if (!serves(outDir, to)) {
      problems.push(`${from} redirects to ${to}, which the artifact does not serve`)
    }
    const expected = legacyRedirectTarget(from)
    if (expected !== to) {
      problems.push(`${from} redirects to ${to}, expected ${expected}`)
    }
    if (!isFilePath(from) && !existsSync(stubPath(outDir, from))) {
      problems.push(`${from} lost its redirect stub`)
    }
  }
  for (const withheld of WITHHELD_IN_PRODUCTION) {
    if (existsSync(path.join(outDir, withheld))) {
      problems.push(`${withheld} was not withheld`)
    }
  }
  return problems
}

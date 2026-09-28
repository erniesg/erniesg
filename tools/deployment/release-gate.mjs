import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
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
  return verifyPostGate(outDir)
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
    if (from.includes('*')) continue
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

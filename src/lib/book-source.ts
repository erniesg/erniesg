/**
 * What a book page was built from (issue 059, criterion 9).
 *
 * An edit proposal is a patch against a named base commit of the node's
 * source file, so the page has to say which file and which commit its text
 * came from. The stamp is `git log -1 --format=%H -- <file>`, the last commit
 * that touched the file, and it is only issued when the working file is
 * byte-identical to `git show <commit>:<file>`: a stamp that does not describe
 * the text on the page would let a reader propose against text that never
 * existed.
 *
 * Three modes:
 *
 * - `strict` (a build): any doubt fails the build and names the fix — a
 *   shallow or partial clone, a git error, an uncommitted edit.
 * - `dev` (a dev server): an uncommitted edit stamps `dirty`, and edit mode on
 *   that page is off with the reason shown.
 * - `lenient` (a build nobody deploys): GitHub Actions checks out one commit,
 *   and a rucksack worker validates before its diff is committed, so both
 *   stamp `dirty` or `unavailable` instead of failing. Edit mode is off on
 *   every such page, and the service refuses a base commit that is not a full
 *   SHA whatever a client sends, so nothing can be proposed against it.
 *   `BOOK_SOURCE_STAMP=strict|lenient` overrides the choice either way.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const DIRTY_COMMIT = 'dirty'
export const UNAVAILABLE_COMMIT = 'unavailable'

export type StampMode = 'strict' | 'dev' | 'lenient'

export type SourceStamp = {
  sourcePath: string
  /** A full commit id, or `dirty` / `unavailable` when edit mode must be off. */
  sourceCommit: string
  /** The file's text at `sourceCommit`; `null` when there is no usable commit. */
  source: string | null
  /** Why edit mode is off on this page, for the reader; `null` when it is on. */
  reason: string | null
}

export class SourceStampError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceStampError'
  }
}

export function resolveStampMode(options: {
  dev: boolean
  env: Record<string, string | undefined>
}): StampMode {
  const forced = options.env.BOOK_SOURCE_STAMP
  if (forced === 'strict' || forced === 'lenient') return forced
  if (options.dev) return 'dev'
  if (options.env.GITHUB_ACTIONS === 'true' || options.env.RUCKSACK_WORKER_RUN_KEY) {
    return 'lenient'
  }
  return 'strict'
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** `null` when history is complete, otherwise the reason it is not. */
function incompleteHistory(root: string): string | null {
  if (git(root, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    return (
      'this checkout is a shallow clone, so the last commit to touch a book ' +
      'file cannot be known; run `git fetch --unshallow` (or check out with ' +
      'fetch-depth: 0) and build again'
    )
  }
  let promisors = ''
  try {
    promisors = git(root, ['config', '--get-regexp', '^remote\\..*\\.promisor$'])
  } catch (error) {
    // `git config --get-regexp` exits 1 when nothing matches: complete history.
    if ((error as { status?: number }).status !== 1) throw error
  }
  if (promisors.trim()) {
    return (
      'this checkout is a partial clone (a promisor remote), so history ' +
      'objects may be missing; clone without --filter and build again'
    )
  }
  return null
}

const historyChecked = new Map<string, string | null>()

/**
 * The stamp for one node's source file. `root` is the repository root and
 * `sourcePath` is repo-relative, as the manifest names it.
 */
export function stampSource(
  root: string,
  sourcePath: string,
  mode: StampMode,
): SourceStamp {
  const unusable = (sourceCommit: string, reason: string): SourceStamp => ({
    sourcePath,
    sourceCommit,
    source: null,
    reason,
  })

  let history: string | null
  try {
    if (!historyChecked.has(root)) historyChecked.set(root, incompleteHistory(root))
    history = historyChecked.get(root) ?? null
  } catch (error) {
    if (mode === 'strict') {
      throw new SourceStampError(`cannot read git history to stamp ${sourcePath}: ${String(error)}`)
    }
    return unusable(UNAVAILABLE_COMMIT, 'the build could not read git history')
  }
  if (history) {
    if (mode === 'strict') throw new SourceStampError(history)
    return unusable(UNAVAILABLE_COMMIT, history)
  }

  let commit: string
  let committed: string
  try {
    commit = git(root, ['log', '-1', '--format=%H', '--', sourcePath]).trim()
    if (!commit) {
      throw new SourceStampError(
        `no commit has touched ${sourcePath}; commit it before building`,
      )
    }
    committed = git(root, ['show', `${commit}:${sourcePath}`])
  } catch (error) {
    if (mode === 'strict') {
      throw error instanceof SourceStampError
        ? error
        : new SourceStampError(`cannot stamp ${sourcePath}: ${String(error)}`)
    }
    return unusable(DIRTY_COMMIT, `${sourcePath} is not committed yet`)
  }

  const working = readFileSync(path.join(root, sourcePath), 'utf8')
  if (working !== committed) {
    const reason = `${sourcePath} has uncommitted changes, so edit mode is off on this page`
    if (mode === 'strict') {
      throw new SourceStampError(
        `${sourcePath} differs from ${commit}; commit it (or build from a clean checkout) so the page matches the commit it names`,
      )
    }
    return unusable(DIRTY_COMMIT, reason)
  }
  return { sourcePath, sourceCommit: commit, source: committed, reason: null }
}

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DIRTY_COMMIT,
  SourceStampError,
  UNAVAILABLE_COMMIT,
  resolveStampMode,
  stampSource,
} from './book-source'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim()
}

let scratch: string
let origin: string
let chapterCommit: string

beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'book-source-'))
  origin = path.join(scratch, 'origin')
  mkdirSync(path.join(origin, 'books', 'chapters'), { recursive: true })
  git(origin, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(origin, 'books', 'chapters', 'ch01.md'), '+++\nid = "ch01"\n+++\n\nFirst.\n')
  writeFileSync(path.join(origin, 'books', 'chapters', 'ch02.md'), '+++\nid = "ch02"\n+++\n\nSecond.\n')
  git(origin, 'add', '.')
  git(origin, 'commit', '-q', '-m', 'both chapters')
  writeFileSync(path.join(origin, 'books', 'chapters', 'ch01.md'), '+++\nid = "ch01"\n+++\n\nFirst, revised.\n')
  git(origin, 'commit', '-q', '-am', 'revise ch01')
  chapterCommit = git(origin, 'rev-parse', 'HEAD')
  writeFileSync(path.join(origin, 'unrelated.txt'), 'later\n')
  git(origin, 'add', '.')
  git(origin, 'commit', '-q', '-m', 'an unrelated later commit')
  // Partial clones need the origin to allow filters.
  git(origin, 'config', 'uploadpack.allowFilter', 'true')
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('stampSource', () => {
  it('stamps the last commit that touched the file, not HEAD, with its exact text', () => {
    const stamp = stampSource(origin, 'books/chapters/ch01.md', 'strict')
    expect(stamp.sourceCommit).toBe(chapterCommit)
    expect(stamp.sourceCommit).not.toBe(git(origin, 'rev-parse', 'HEAD'))
    expect(stamp.sourceCommit).toBe(
      git(origin, 'log', '-1', '--format=%H', '--', 'books/chapters/ch01.md'),
    )
    expect(stamp.source).toBe('+++\nid = "ch01"\n+++\n\nFirst, revised.\n')
    expect(stamp.reason).toBeNull()
  })

  it('refuses a depth-1 clone in strict mode, naming the shallow clone and the fix', () => {
    const shallow = path.join(scratch, 'shallow')
    git(scratch, 'clone', '-q', '--depth', '1', `file://${origin}`, shallow)
    expect(() => stampSource(shallow, 'books/chapters/ch02.md', 'strict')).toThrow(
      SourceStampError,
    )
    expect(() => stampSource(shallow, 'books/chapters/ch02.md', 'strict')).toThrow(
      /shallow clone.*git fetch --unshallow/s,
    )
  })

  it('refuses a partial (blob:none) clone in strict mode', () => {
    const partial = path.join(scratch, 'partial')
    git(scratch, 'clone', '-q', '--filter=blob:none', `file://${origin}`, partial)
    expect(() => stampSource(partial, 'books/chapters/ch02.md', 'strict')).toThrow(
      /partial clone/,
    )
  })

  it('in lenient mode stamps an incomplete history as unavailable instead of failing', () => {
    const stamp = stampSource(path.join(scratch, 'shallow'), 'books/chapters/ch02.md', 'lenient')
    expect(stamp.sourceCommit).toBe(UNAVAILABLE_COMMIT)
    expect(stamp.source).toBeNull()
    expect(stamp.reason).toMatch(/shallow/)
  })

  it('fails a strict build on an uncommitted edit, naming the file; dev stamps it dirty', () => {
    const work = path.join(scratch, 'work')
    git(scratch, 'clone', '-q', `file://${origin}`, work)
    writeFileSync(path.join(work, 'books', 'chapters', 'ch02.md'), '+++\nid = "ch02"\n+++\n\nEdited.\n')
    expect(() => stampSource(work, 'books/chapters/ch02.md', 'strict')).toThrow(
      /books\/chapters\/ch02\.md/,
    )
    const dev = stampSource(work, 'books/chapters/ch02.md', 'dev')
    expect(dev.sourceCommit).toBe(DIRTY_COMMIT)
    expect(dev.source).toBeNull()
    expect(dev.reason).toMatch(/uncommitted/)
    // The untouched file in the same tree still stamps a real commit.
    expect(stampSource(work, 'books/chapters/ch01.md', 'dev').sourceCommit).toBe(chapterCommit)
  })

  it('treats a file git has never seen as an error, not an empty stamp', () => {
    const work = path.join(scratch, 'work')
    writeFileSync(path.join(work, 'books', 'chapters', 'ch03.md'), 'new\n')
    expect(() => stampSource(work, 'books/chapters/ch03.md', 'strict')).toThrow(
      /no commit has touched books\/chapters\/ch03\.md/,
    )
    expect(stampSource(work, 'books/chapters/ch03.md', 'dev').sourceCommit).toBe(DIRTY_COMMIT)
  })
})

describe('resolveStampMode', () => {
  it('is strict for a build unless it runs in CI or a rucksack worker, and dev for a dev server', () => {
    expect(resolveStampMode({ dev: false, env: {} })).toBe('strict')
    expect(resolveStampMode({ dev: true, env: {} })).toBe('dev')
    expect(resolveStampMode({ dev: false, env: { GITHUB_ACTIONS: 'true' } })).toBe('lenient')
    expect(resolveStampMode({ dev: false, env: { RUCKSACK_WORKER_RUN_KEY: 'x' } })).toBe('lenient')
    expect(
      resolveStampMode({ dev: false, env: { GITHUB_ACTIONS: 'true', BOOK_SOURCE_STAMP: 'strict' } }),
    ).toBe('strict')
    expect(resolveStampMode({ dev: false, env: { BOOK_SOURCE_STAMP: 'lenient' } })).toBe('lenient')
  })
})

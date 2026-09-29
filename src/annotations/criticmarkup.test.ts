import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createHarness, webAnnotation } from '../worker/margin/fixtures'
import { MAX_PROPOSAL_BODY_LENGTH } from '../worker/margin/web-annotation'
import {
  acceptAll,
  criticMarkupFor,
  formatHunks,
  isFullCommitId,
  parseHunks,
  ProposalFormatError,
  proposalState,
  proposeHunks,
  rejectAll,
  StaleProposalError,
  toUnifiedDiff,
  type Hunk,
} from './criticmarkup'
import {
  deleteBlock,
  EditSession,
  isEditable,
  joinParagraphs,
  parseMarkdown,
  replaceText,
  retypeBlock,
  serializeBlock,
  serializeMarkdown,
  type Inline,
  type ProseDoc,
} from './prose-schema'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const CH03 = 'books/chapters/ch03-lists.md'

function git(args: string[], cwd = ROOT): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** The node's source as its base commit holds it. */
function atBase(sourcePath: string): { commit: string; source: string } {
  const commit = git(['rev-parse', 'HEAD']).trim()
  return { commit, source: git(['show', `${commit}:${sourcePath}`]) }
}

/** `git apply` the diff to a checkout holding only the base file. */
function gitApply(sourcePath: string, base: string, diff: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'criticmarkup-'))
  try {
    git(['init', '-q'], dir)
    mkdirSync(path.join(dir, path.dirname(sourcePath)), { recursive: true })
    writeFileSync(path.join(dir, sourcePath), base)
    writeFileSync(path.join(dir, 'proposal.diff'), diff)
    git(['apply', '--check', 'proposal.diff'], dir)
    git(['apply', 'proposal.diff'], dir)
    return readFileSync(path.join(dir, sourcePath), 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Save the body as an `editing` annotation and read back what was stored. */
async function saveProposal(body: string): Promise<string> {
  const harness = createHarness()
  const response = await harness.request('POST', '/annotations', {
    body: webAnnotation({
      source: 'https://ernie.sg/books/dsa/ch03-lists',
      motivation: 'editing',
      body,
    }),
  })
  expect(response.status).toBe(201)
  const saved = (await response.json()) as { body: { value: string } }
  return saved.body.value
}

/**
 * The whole path: edit the parsed node, propose, save, read the proposal back,
 * convert it with `toUnifiedDiff`, and `git apply` it to the base commit.
 */
async function proposeAndApply(
  sourcePath: string,
  edit: (doc: ProseDoc) => ProseDoc,
) {
  const { commit, source } = atBase(sourcePath)
  expect(isFullCommitId(commit)).toBe(true)
  const edited = serializeMarkdown(edit(parseMarkdown(source)))
  const hunks = proposeHunks(source, edited)
  expect(hunks.length).toBeGreaterThan(0)
  const body = formatHunks(hunks)
  const stored = await saveProposal(body)
  expect(stored).toBe(body)
  const diff = toUnifiedDiff(parseHunks(stored), source, sourcePath)
  expect(gitApply(sourcePath, source, diff)).toBe(edited)
  return { source, edited, hunks, body }
}

function blockIndex(doc: ProseDoc, startsWith: string): number {
  const index = doc.blocks.findIndex(
    (block) => isEditable(block) && serializeBlock(block).startsWith(startsWith),
  )
  expect(index).toBeGreaterThan(-1)
  return index
}

function changes(markup: string): number {
  return markup.match(/\{(?:\+\+|--|~~)/g)?.length ?? 0
}

describe('the proposal body', () => {
  /** A small deterministic generator, so a failure names its seed. */
  function random(seed: number): () => number {
    let state = seed
    return () => {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const PIECES = [
    '',
    '\n',
    '\n\n',
    '@@ -1,2 +1,2 @@',
    'word',
    ' ',
    '"',
    '\\',
    '`{++not a change++}`',
    '`{--x--}`',
    '{~~a~>b~~}',
    '~>',
    'é',
    '🌊',
    '\t',
    '{',
    '}',
    ' ',
    '```',
    ':::',
    '+++',
  ]

  function randomHunks(next: () => number): Hunk[] {
    const hunks: Hunk[] = []
    let line = 1
    const count = 1 + Math.floor(next() * 5)
    for (let index = 0; index < count; index += 1) {
      const baseStartLine = line + Math.floor(next() * 10)
      const baseEndLine = baseStartLine + Math.floor(next() * 6)
      let criticMarkup = ''
      const pieces = Math.floor(next() * 14)
      for (let piece = 0; piece < pieces; piece += 1) {
        criticMarkup += PIECES[Math.floor(next() * PIECES.length)]
      }
      hunks.push({ baseStartLine, baseEndLine, criticMarkup })
      line = baseEndLine + 1
    }
    return hunks
  }

  it('parseHunks(formatHunks(h)) is h, over generated hunks', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const hunks = randomHunks(random(seed))
      expect(parseHunks(formatHunks(hunks)), `seed ${seed}`).toEqual(hunks)
    }
  })

  it.each([
    ['blank lines', 'one\n\n\n{++two++}\n\n'],
    ['a line that looks like a diff header', '@@ -1,3 +1,3 @@\n{--x--}'],
    ['delimiters inside a code span', 'use `{++` and `~>` and `--}` {~~a~>b~~}'],
    ['JSON-looking text', '"},{"baseStartLine":9'],
  ])('round-trips a hunk holding %s', (_name, criticMarkup) => {
    const hunks = [{ baseStartLine: 3, baseEndLine: 7, criticMarkup }]
    const body = formatHunks(hunks)
    expect(body.startsWith('{"v":1,"hunks":[{"baseStartLine":3,')).toBe(true)
    expect(parseHunks(body)).toEqual(hunks)
  })

  const hunk = (start: number, end: number) => ({
    baseStartLine: start,
    baseEndLine: end,
    criticMarkup: 'x',
  })

  it.each([
    ['not JSON', '{"v":1,'],
    ['an unknown key', JSON.stringify({ v: 1, hunks: [{ ...hunk(1, 2), extra: 1 }] })],
    ['an unknown top-level key', JSON.stringify({ v: 1, hunks: [hunk(1, 2)], base: 'x' })],
    ['overlapping hunks', JSON.stringify({ v: 1, hunks: [hunk(1, 5), hunk(5, 6)] })],
    ['out-of-order hunks', JSON.stringify({ v: 1, hunks: [hunk(10, 12), hunk(1, 2)] })],
    ['an inverted range', JSON.stringify({ v: 1, hunks: [hunk(4, 3)] })],
    ['line zero', JSON.stringify({ v: 1, hunks: [hunk(0, 3)] })],
    ['no hunks', JSON.stringify({ v: 1, hunks: [] })],
    ['another version', JSON.stringify({ v: 2, hunks: [hunk(1, 2)] })],
    ['keys out of order', JSON.stringify({ hunks: [hunk(1, 2)], v: 1 })],
    ['insignificant whitespace', JSON.stringify({ v: 1, hunks: [hunk(1, 2)] }, null, 1)],
  ])('refuses %s', (_name, body) => {
    expect(() => parseHunks(body)).toThrow(ProposalFormatError)
  })
})

describe('CriticMarkup', () => {
  it('rejects back to the base and accepts to the edit', () => {
    const before = 'The quick brown fox\njumps over the dog.\n'
    const after = 'The slow brown fox\njumps over the lazy dog!\n'
    const markup = criticMarkupFor(before, after)
    expect(markup).toBe(
      'The {~~quick~>slow~~} brown fox\njumps over the {++lazy ++}dog{~~.~>!~~}\n',
    )
    expect(rejectAll(markup)).toBe(before)
    expect(acceptAll(markup)).toBe(after)
  })

  it('a one-word edit is a patch touching only that word', async () => {
    const { hunks } = await proposeAndApply(CH03, (doc) =>
      replaceText(doc, blockIndex(doc, 'A food bank'), 'volunteer', 'helper'),
    )
    expect(hunks).toHaveLength(1)
    expect(changes(hunks[0].criticMarkup)).toBe(1)
    expect(hunks[0].criticMarkup).toContain('{~~volunteer~>helper~~}')
    // Line 14 changed; two lines of context either side.
    expect(hunks[0]).toMatchObject({ baseStartLine: 12, baseEndLine: 16 })
  })
})

describe('a saved proposal applies to its base commit with git apply', () => {
  it('deleting a whole paragraph', async () => {
    const { edited } = await proposeAndApply(CH03, (doc) =>
      deleteBlock(doc, blockIndex(doc, 'Nine things in a row')),
    )
    expect(edited).not.toContain('Nine things in a row')
  })

  it('joining two paragraphs', async () => {
    const { hunks } = await proposeAndApply(CH03, (doc) =>
      joinParagraphs(doc, blockIndex(doc, 'A food bank')),
    )
    expect(hunks).toHaveLength(1)
    expect(changes(hunks[0].criticMarkup)).toBe(1)
  })

  it('undo restores the base byte for byte, so there is nothing to propose', () => {
    const { source } = atBase(CH03)
    const session = new EditSession(parseMarkdown(source))
    session.apply((doc) => deleteBlock(doc, blockIndex(doc, 'Nine things')))
    session.apply((doc) => joinParagraphs(doc, blockIndex(doc, 'A food bank')))
    expect(proposeHunks(source, serializeMarkdown(session.doc)).length)
      .toBeGreaterThan(0)
    session.undo()
    session.undo()
    expect(serializeMarkdown(session.doc)).toBe(source)
    expect(proposeHunks(source, serializeMarkdown(session.doc))).toEqual([])
  })

  it('retyping the whole of the largest node, under the editing cap', async () => {
    const nodes = [
      ...readdirSync(path.join(ROOT, 'books/chapters'))
        .filter((name) => name.endsWith('.md'))
        .map((name) => `books/chapters/${name}`),
      ...readdirSync(path.join(ROOT, 'books/challenges')).map(
        (name) => `books/challenges/${name}/challenge.md`,
      ),
    ]
    const largest = nodes
      .map((node) => ({
        node,
        size: readFileSync(path.join(ROOT, node), 'utf8').length,
      }))
      .sort((a, b) => b.size - a.size)[0].node

    const plain = (inlines: Inline[]): string =>
      inlines
        .map((node) =>
          node.type === 'text' || node.type === 'code'
            ? node.text
            : plain(node.content),
        )
        .join('')

    const { body } = await proposeAndApply(largest, (doc) =>
      doc.blocks.reduce(
        (next, block, index) =>
          block.type === 'paragraph' || block.type === 'heading'
            ? retypeBlock(next, index, plain(block.content).toUpperCase())
            : next,
        doc,
      ),
    )
    expect(body.length).toBeLessThanOrEqual(MAX_PROPOSAL_BODY_LENGTH)
  })
})

describe('base commits and staleness', () => {
  it('refuses to convert a proposal whose lines have moved on', () => {
    const { source } = atBase(CH03)
    const doc = parseMarkdown(source)
    const hunks = proposeHunks(
      source,
      serializeMarkdown(
        replaceText(doc, blockIndex(doc, 'A food bank'), 'volunteer', 'helper'),
      ),
    )
    const moved = source.replace('A food bank keeps', 'A food pantry keeps')
    expect(() => toUnifiedDiff(hunks, moved, CH03)).toThrow(StaleProposalError)
  })

  it('marks a proposal against an older base as stale', () => {
    const base = 'a'.repeat(40)
    expect(proposalState(base, base)).toBe('current')
    expect(proposalState(base, 'b'.repeat(40))).toBe('stale')
  })

  it.each<[string, string, boolean]>([
    ['a SHA-1', 'a'.repeat(40), true],
    ['a SHA-256', '0'.repeat(64), true],
    ['dirty', 'dirty', false],
    ['an abbreviated SHA', 'abc1234', false],
    ['upper case', 'A'.repeat(40), false],
  ])('%s (%s) is a full commit id: expected %s', (_name, value, expected) => {
    expect(isFullCommitId(value)).toBe(expected)
  })
})

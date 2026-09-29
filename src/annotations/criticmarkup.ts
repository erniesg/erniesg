import { z } from 'zod'

/**
 * Proposals as CriticMarkup hunks against a named base commit (issue 059).
 *
 * CriticMarkup is the only stored form: it survives being read by a human in
 * the rail, which is where review happens. A proposal is an ordered list of
 * non-overlapping hunks, each the changed lines of the base file plus
 * `CONTEXT_LINES` unchanged lines either side, marked up with `{--deleted--}`,
 * `{++added++}` and `{~~old~>new~~}`, with 1-based inclusive line numbers
 * against the base commit.
 *
 * On the wire the proposal is still one `TextualBody` string: canonical JSON,
 * `{"v":1,"hunks":[{"baseStartLine":N,"baseEndLine":N,"criticMarkup":"..."}]}`.
 * JSON escaping makes each hunk self-delimiting, so a hunk may hold blank
 * lines, `@@` lines or anything else without a framing to collide with.
 *
 * `toUnifiedDiff` is the one converter from hunks to something `git apply`
 * takes. Issue 060's adapter uses it too, so what is tested here is what gets
 * applied.
 */

export const CONTEXT_LINES = 2

export type Hunk = {
  baseStartLine: number
  baseEndLine: number
  criticMarkup: string
}

export class ProposalFormatError extends Error {
  override name = 'ProposalFormatError'
}

/** The base no longer matches what a hunk says it replaces. */
export class StaleProposalError extends Error {
  override name = 'StaleProposalError'
}

/* -------------------------------------------------------------------------- */
/* Wire encoding                                                              */
/* -------------------------------------------------------------------------- */

const hunkSchema = z
  .object({
    baseStartLine: z.number().int().min(1),
    baseEndLine: z.number().int().min(1),
    criticMarkup: z.string(),
  })
  .strict()
  .refine((hunk) => hunk.baseEndLine >= hunk.baseStartLine, {
    message: 'baseEndLine is before baseStartLine',
  })

const proposalBodySchema = z
  .object({ v: z.literal(1), hunks: z.array(hunkSchema).min(1) })
  .strict()
  .superRefine((body, context) => {
    for (let index = 1; index < body.hunks.length; index += 1) {
      if (body.hunks[index].baseStartLine <= body.hunks[index - 1].baseEndLine) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['hunks', index],
          message: 'hunks overlap or are out of order',
        })
      }
    }
  })

/** The canonical body string: fixed key order, no insignificant whitespace. */
export function formatHunks(hunks: readonly Hunk[]): string {
  return JSON.stringify({
    v: 1,
    hunks: hunks.map((hunk) => ({
      baseStartLine: hunk.baseStartLine,
      baseEndLine: hunk.baseEndLine,
      criticMarkup: hunk.criticMarkup,
    })),
  })
}

/**
 * Read a proposal body. Refuses anything that is not JSON, has an unknown key,
 * has overlapping or out-of-order hunks, or is not in the canonical spelling
 * `formatHunks` writes.
 */
export function parseHunks(body: string): Hunk[] {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    throw new ProposalFormatError('a proposal body is JSON')
  }
  const parsed = proposalBodySchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ProposalFormatError(
      `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`,
    )
  }
  const hunks = parsed.data.hunks.map((hunk) => ({
    baseStartLine: hunk.baseStartLine,
    baseEndLine: hunk.baseEndLine,
    criticMarkup: hunk.criticMarkup,
  }))
  if (formatHunks(hunks) !== body) {
    throw new ProposalFormatError('a proposal body is canonical JSON')
  }
  return hunks
}

/* -------------------------------------------------------------------------- */
/* CriticMarkup                                                               */
/* -------------------------------------------------------------------------- */

type Segment =
  | { kind: 'equal'; text: string }
  | { kind: 'delete'; text: string }
  | { kind: 'insert'; text: string }
  | { kind: 'substitute'; old: string; new: string }

const OPENING = /\{(\+\+|--|~~)/g

export function parseCriticMarkup(markup: string): Segment[] {
  const segments: Segment[] = []
  let at = 0
  OPENING.lastIndex = 0
  for (;;) {
    OPENING.lastIndex = at
    const open = OPENING.exec(markup)
    if (!open) break
    if (open.index > at) {
      segments.push({ kind: 'equal', text: markup.slice(at, open.index) })
    }
    const kind = open[1]
    const closing = `${kind}}`
    const close = markup.indexOf(closing, open.index + 3)
    if (close < 0) {
      throw new ProposalFormatError(`an unclosed {${kind} in a hunk`)
    }
    const inner = markup.slice(open.index + 3, close)
    if (kind === '++') segments.push({ kind: 'insert', text: inner })
    else if (kind === '--') segments.push({ kind: 'delete', text: inner })
    else {
      const separator = inner.indexOf('~>')
      if (separator < 0) {
        throw new ProposalFormatError('a substitution without ~>')
      }
      segments.push({
        kind: 'substitute',
        old: inner.slice(0, separator),
        new: inner.slice(separator + 2),
      })
    }
    at = close + 3
  }
  if (at < markup.length) segments.push({ kind: 'equal', text: markup.slice(at) })
  return segments
}

/** The text with every change rejected: what the hunk says the base holds. */
export function rejectAll(markup: string): string {
  return parseCriticMarkup(markup)
    .map((segment) =>
      segment.kind === 'equal' || segment.kind === 'delete'
        ? segment.text
        : segment.kind === 'substitute'
          ? segment.old
          : '',
    )
    .join('')
}

/** The text with every change accepted: what the hunk proposes. */
export function acceptAll(markup: string): string {
  return parseCriticMarkup(markup)
    .map((segment) =>
      segment.kind === 'equal' || segment.kind === 'insert'
        ? segment.text
        : segment.kind === 'substitute'
          ? segment.new
          : '',
    )
    .join('')
}

/* -------------------------------------------------------------------------- */
/* Diffing                                                                    */
/* -------------------------------------------------------------------------- */

type Op = { op: 'equal' | 'delete' | 'insert'; value: string }

/** Past this many cells a changed stretch is one replacement, not an LCS. */
const MAX_LCS_CELLS = 4_000_000

function lcsOps(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length
  const m = b.length
  const deleted = a.map((value): Op => ({ op: 'delete', value }))
  const inserted = b.map((value): Op => ({ op: 'insert', value }))
  if (n === 0 || m === 0 || n * m > MAX_LCS_CELLS) {
    return [...deleted, ...inserted]
  }
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'equal', value: a[i] })
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ op: 'delete', value: a[i] })
      i += 1
    } else {
      ops.push({ op: 'insert', value: b[j] })
      j += 1
    }
  }
  return [...ops, ...deleted.slice(i), ...inserted.slice(j)]
}

function diffSequences(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1
  }
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const equal = (value: string): Op => ({ op: 'equal', value })
  return [
    ...a.slice(0, start).map(equal),
    ...lcsOps(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map(equal),
  ]
}

/** Lines with their terminators; the last may have none. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function tokenize(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? []
}

function markChange(deleted: string, inserted: string): string {
  if (deleted && inserted) return `{~~${deleted}~>${inserted}~~}`
  if (deleted) return `{--${deleted}--}`
  return inserted ? `{++${inserted}++}` : ''
}

/** Word-level CriticMarkup turning `before` into `after`. */
export function criticMarkupFor(before: string, after: string): string {
  let markup = ''
  let deleted = ''
  let inserted = ''
  for (const { op, value } of diffSequences(tokenize(before), tokenize(after))) {
    if (op === 'equal') {
      markup += markChange(deleted, inserted) + value
      deleted = ''
      inserted = ''
    } else if (op === 'delete') deleted += value
    else inserted += value
  }
  markup += markChange(deleted, inserted)

  const readsBack = (candidate: string) => {
    try {
      return rejectAll(candidate) === before && acceptAll(candidate) === after
    } catch {
      return false
    }
  }
  if (readsBack(markup)) return markup
  // Unchanged text that itself looks like CriticMarkup can make the word-level
  // form ambiguous. One substitution over the region may still read back.
  const whole = markChange(before, after)
  if (readsBack(whole)) return whole
  throw new ProposalFormatError(
    'this change cannot be written as unambiguous CriticMarkup',
  )
}

/**
 * The proposal that turns `baseSource` into `editedSource`: one hunk per
 * changed stretch, with `CONTEXT_LINES` of context, merged where contexts meet.
 */
export function proposeHunks(baseSource: string, editedSource: string): Hunk[] {
  const a = splitLines(baseSource)
  const b = splitLines(editedSource)

  type Run = { aStart: number; aEnd: number; bStart: number; bEnd: number }
  const runs: Run[] = []
  let current: Run | null = null
  let ai = 0
  let bi = 0
  for (const { op } of diffSequences(a, b)) {
    if (op === 'equal') {
      if (current) runs.push(current)
      current = null
      ai += 1
      bi += 1
      continue
    }
    if (!current) current = { aStart: ai, aEnd: ai, bStart: bi, bEnd: bi }
    if (op === 'delete') {
      ai += 1
      current.aEnd = ai
    } else {
      bi += 1
      current.bEnd = bi
    }
  }
  if (current) runs.push(current)
  if (runs.length > 0 && a.length === 0) {
    throw new ProposalFormatError('a proposal needs a non-empty base file')
  }

  // Regions of the base (and the matching edited lines), context included.
  type Region = { aFrom: number; aTo: number; bFrom: number; bTo: number }
  const regions: Region[] = []
  for (const run of runs) {
    const aFrom = Math.max(0, run.aStart - CONTEXT_LINES)
    const aTo = Math.min(a.length, run.aEnd + CONTEXT_LINES)
    const region = {
      aFrom,
      aTo,
      bFrom: run.bStart - (run.aStart - aFrom),
      bTo: run.bEnd + (aTo - run.aEnd),
    }
    const last = regions[regions.length - 1]
    if (last && region.aFrom <= last.aTo) {
      last.aTo = region.aTo
      last.bTo = region.bTo
    } else {
      regions.push(region)
    }
  }

  return regions.map((region) => ({
    baseStartLine: region.aFrom + 1,
    baseEndLine: region.aTo,
    criticMarkup: criticMarkupFor(
      a.slice(region.aFrom, region.aTo).join(''),
      b.slice(region.bFrom, region.bTo).join(''),
    ),
  }))
}

/* -------------------------------------------------------------------------- */
/* Hunks -> unified diff                                                      */
/* -------------------------------------------------------------------------- */

function diffLine(prefix: string, line: string): string {
  return line.endsWith('\n')
    ? `${prefix}${line}`
    : `${prefix}${line}\n\\ No newline at end of file\n`
}

/**
 * The unified diff a reviewer's `git apply` takes, for hunks against
 * `baseSource` (the file at the proposal's base commit). Refuses, rather than
 * guesses, when a hunk's rejected text is not what the base holds there.
 */
export function toUnifiedDiff(
  hunks: readonly Hunk[],
  baseSource: string,
  sourcePath: string,
): string {
  const base = splitLines(baseSource)
  let out =
    `diff --git a/${sourcePath} b/${sourcePath}\n` +
    `--- a/${sourcePath}\n` +
    `+++ b/${sourcePath}\n`
  let delta = 0
  let previousEnd = 0
  for (const hunk of hunks) {
    if (
      hunk.baseStartLine <= previousEnd ||
      hunk.baseEndLine < hunk.baseStartLine ||
      hunk.baseEndLine > base.length
    ) {
      throw new StaleProposalError(
        `lines ${hunk.baseStartLine}-${hunk.baseEndLine} are not in order in the base`,
      )
    }
    previousEnd = hunk.baseEndLine

    const oldLines = base.slice(hunk.baseStartLine - 1, hunk.baseEndLine)
    if (rejectAll(hunk.criticMarkup) !== oldLines.join('')) {
      throw new StaleProposalError(
        `lines ${hunk.baseStartLine}-${hunk.baseEndLine} of ${sourcePath} have changed since the proposal`,
      )
    }
    const proposed = acceptAll(hunk.criticMarkup)
    if (hunk.baseEndLine < base.length && proposed && !proposed.endsWith('\n')) {
      throw new ProposalFormatError('a hunk before the end of the file ends mid-line')
    }
    const newLines = splitLines(proposed)

    const newStart =
      hunk.baseStartLine + delta - (newLines.length === 0 ? 1 : 0)
    out += `@@ -${hunk.baseStartLine},${oldLines.length} +${newStart},${newLines.length} @@\n`
    for (const { op, value } of diffSequences(oldLines, newLines)) {
      out += diffLine(op === 'equal' ? ' ' : op === 'delete' ? '-' : '+', value)
    }
    delta += newLines.length - oldLines.length
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Base commits                                                               */
/* -------------------------------------------------------------------------- */

/** A full commit id: SHA-1 or SHA-256, lower-case. Never `dirty` or a prefix. */
export function isFullCommitId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
}

/**
 * A proposal against a base the source has moved on from is stale: shown as
 * such, never applied blindly.
 */
export function proposalState(
  baseCommit: string,
  sourceCommit: string,
): 'current' | 'stale' {
  return baseCommit === sourceCommit ? 'current' : 'stale'
}

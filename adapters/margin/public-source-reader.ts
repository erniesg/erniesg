/** Immutable Git object observation, not an adoption decision or write authority. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { publicCorrelationSchema } from '../../src/worker/margin/adapter'

const repository = 'erniesg/erniesg' as const
const base = `https://api.github.com/repos/${repository}/git`
const prefix = 'coordinator/margin-proposal-'
const oid = z
  .string()
  .length(40)
  .regex(/^[0-9a-f]{40}$/)
const text = (value: string) => Buffer.from(value, 'utf8')
const same = (actual: string, expected: string) => {
  if (actual !== expected) throw new SourceReadError('object_mismatch')
}
export type SourceReason =
  | 'object_mismatch'
  | 'tree_incomplete'
  | 'unsupported_topology'
  | 'bounds'
  | 'ref_changed'
export class SourceReadError extends Error {
  constructor(readonly reason: SourceReason) {
    super(reason)
  }
}
export type PublicSourceInput = { branch: string; sourcePath: string }
export type PublicTreeEntry = {
  path: string
  mode: '040000' | '100644' | '100755' | '120000' | '160000'
  type: 'tree' | 'blob' | 'commit'
  oid: string
}
export type PublicTree = { sha: string; entries: PublicTreeEntry[] }
type SelectedSource =
  | {
      status: 'regular'
      mode: '100644' | '100755'
      oid: string
      bytes: number
      sha256: string
    }
  | { status: 'absent' }
  | {
      status: 'unsupported_type'
      mode: PublicTreeEntry['mode']
      type: PublicTreeEntry['type']
      oid: string
    }
export type PublicSourceObservation = {
  provenance: 'github-api-observed'
  repository: typeof repository
  branch: string
  head: string
  parent: string
  commitMessage: string
  headTree: PublicTree
  parentTree: PublicTree
  source: SelectedSource
  refWitness: 'same-head-at-two-reads'
}
export type PublicSourceReadResult =
  | { status: 'ready'; observation: PublicSourceObservation }
  | {
      status: 'refused' | 'not_evaluated'
      reason:
        | SourceReason
        | 'config'
        | 'input'
        | 'closed'
        | 'busy'
        | 'timeout'
        | 'aborted'
        | 'transport'
        | 'response'
        | 'body'
        | 'provider_refused'
        | 'not_found_or_hidden'
        | 'response_status'
      httpStatus?: number
    }

/** Capture own primitive data before any await; accessors are not an input protocol. */
export function capturePublicSourceInput(input: unknown): PublicSourceInput {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('input')
  const keys = Reflect.ownKeys(input)
  if (
    keys.length !== 2 ||
    !keys.includes('branch') ||
    !keys.includes('sourcePath')
  )
    throw Error('input')
  const branch = Object.getOwnPropertyDescriptor(input, 'branch')?.value
  const sourcePath = Object.getOwnPropertyDescriptor(input, 'sourcePath')?.value
  if (
    typeof branch !== 'string' ||
    typeof sourcePath !== 'string' ||
    branch.length !== prefix.length + 64 ||
    !branch.startsWith(prefix)
  )
    throw Error('input')
  publicCorrelationSchema.parse({
    version: 1,
    value: branch.slice(prefix.length),
  })
  if (
    sourcePath.length > 512 ||
    Buffer.byteLength(sourcePath, 'utf8') > 512 ||
    !/^(?:books\/chapters\/[a-z0-9]+(?:-[a-z0-9]+)*\.md|books\/challenges\/[a-z0-9]+(?:-[a-z0-9]+)*\/challenge\.md)$/.test(
      sourcePath,
    )
  )
    throw Error('input')
  return { branch, sourcePath }
}

const refSchema = z.object({
  ref: z.string(),
  object: z.object({ type: z.literal('commit'), sha: oid }),
})
const commitSchema = z.object({
  sha: oid,
  tree: z.object({ sha: oid }),
  parents: z.array(z.object({ sha: oid })),
  message: z.string(),
})
const rowSchema = z.object({
  path: z.string(),
  mode: z.enum(['040000', '100644', '100755', '120000', '160000']),
  type: z.enum(['tree', 'blob', 'commit']),
  sha: oid,
})
const treeSchema = z.object({
  sha: oid,
  truncated: z.boolean(),
  tree: z.array(z.unknown()),
})
const blobSchema = z.object({
  sha: oid,
  size: z
    .number()
    .int()
    .min(0)
    .max(2 * 1024 * 1024),
  encoding: z.literal('base64'),
  content: z.string(),
})

function verifiedTree(
  raw: unknown,
  expected: string,
  check: () => void,
): PublicTree {
  const wire = treeSchema.parse(raw)
  same(wire.sha, expected)
  if (wire.truncated) throw new SourceReadError('tree_incomplete')
  if (wire.tree.length > 10_000) throw new SourceReadError('bounds')
  const entries: PublicTreeEntry[] = [],
    byPath = new Map<string, PublicTreeEntry>()
  const children = new Map<string, PublicTreeEntry[]>([['', []]])
  for (const value of wire.tree) {
    check()
    const row = rowSchema.parse(value),
      bytes = text(row.path),
      segments = row.path.split('/')
    if (bytes.length > 1024 || segments.length > 64)
      throw new SourceReadError('bounds')
    if (
      !row.path ||
      bytes.toString('utf8') !== row.path ||
      /[\u0000-\u001f\u007f-\u009f\\]/.test(row.path) ||
      segments.some((s) => !s || s === '.' || s === '..') ||
      byPath.has(row.path)
    )
      throw Error('tree path')
    const type =
      row.mode === '040000' ? 'tree' : row.mode === '160000' ? 'commit' : 'blob'
    if (row.type !== type) throw Error('tree mode')
    const entry: PublicTreeEntry = {
      path: row.path,
      mode: row.mode,
      type: row.type,
      oid: row.sha,
    }
    byPath.set(row.path, entry)
    entries.push(entry)
    if (type === 'tree') children.set(row.path, [])
  }
  for (const entry of entries) {
    check()
    const parent = entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/')))
    const list = children.get(parent)
    if (!list) throw Error('tree ancestor')
    list.push(entry)
  }
  const directories = [...children.keys()].sort(
    (a, b) => (b ? b.split('/').length : 0) - (a ? a.split('/').length : 0),
  )
  for (const directory of directories) {
    check()
    const rows = children
      .get(directory)!
      .map((entry) => {
        const name = entry.path.slice(directory ? directory.length + 1 : 0)
        return {
          entry,
          name,
          key: text(name + (entry.type === 'tree' ? '/' : '')),
        }
      })
      .sort((a, b) => Buffer.compare(a.key, b.key))
    const encoded = rows.map(({ entry, name }) => {
      check()
      return Buffer.concat([
        text(`${entry.mode === '040000' ? '40000' : entry.mode} ${name}\0`),
        Buffer.from(entry.oid, 'hex'),
      ])
    })
    const size = encoded.reduce((sum, bytes) => sum + bytes.length, 0)
    const hash = createHash('sha1').update(`tree ${size}\0`)
    for (const bytes of encoded) {
      check()
      hash.update(bytes)
    }
    same(hash.digest('hex'), directory ? byPath.get(directory)!.oid : expected)
  }
  check()
  return { sha: expected, entries }
}

function verifiedBlob(
  raw: unknown,
  selected: PublicTreeEntry,
  check: () => void,
): SelectedSource {
  const blob = blobSchema.parse(raw)
  same(blob.sha, selected.oid)
  // Only GitHub's LF/CRLF line wrapping may be removed, never spaces or bare CR.
  const base64 = blob.content.replace(/\r?\n/g, '')
  if (
    base64.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(base64) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
  )
    throw Error('base64')
  if (
    (base64.length / 4) * 3 -
      (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0) >
    2 * 1024 * 1024
  )
    throw new SourceReadError('bounds')
  check()
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length > 2 * 1024 * 1024) throw new SourceReadError('bounds')
  if (bytes.length !== blob.size || bytes.toString('base64') !== base64)
    throw new SourceReadError('object_mismatch')
  same(
    createHash('sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex'),
    selected.oid,
  )
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  check()
  return {
    status: 'regular',
    mode: selected.mode as '100644' | '100755',
    oid: selected.oid,
    bytes: bytes.length,
    sha256,
  }
}

/** Internal sequence supplied only the reader's private bounded GET/parser/lifetime. */
export async function observePublicSource(
  input: PublicSourceInput,
  get: <T>(url: string, decode: (bytes: Uint8Array) => T) => Promise<T>,
  json: (bytes: Uint8Array) => unknown,
  check: () => void,
): Promise<PublicSourceReadResult> {
  const refURL = `${base}/ref/heads/${encodeURIComponent(input.branch)}`
  const reference = (bytes: Uint8Array) => {
    const ref = refSchema.parse(json(bytes))
    same(ref.ref, `refs/heads/${input.branch}`)
    return ref.object.sha
  }
  const head = await get(refURL, reference)
  const commit = await get(`${base}/commits/${head}`, (bytes) =>
    commitSchema.parse(json(bytes)),
  )
  same(commit.sha, head)
  if (commit.parents.length !== 1)
    throw new SourceReadError('unsupported_topology')
  if (text(commit.message).length > 32 * 1024)
    throw new SourceReadError('bounds')
  const parent = commit.parents[0].sha
  const prior = await get(`${base}/commits/${parent}`, (bytes) =>
    commitSchema.parse(json(bytes)),
  )
  same(prior.sha, parent)
  if (text(prior.message).length > 32 * 1024)
    throw new SourceReadError('bounds')
  const headTree = await get(
    `${base}/trees/${commit.tree.sha}?recursive=1`,
    (bytes) => verifiedTree(json(bytes), commit.tree.sha, check),
  )
  const parentTree = await get(
    `${base}/trees/${prior.tree.sha}?recursive=1`,
    (bytes) => verifiedTree(json(bytes), prior.tree.sha, check),
  )
  const selected = headTree.entries.find(
    (entry) => entry.path === input.sourcePath,
  )
  let source: SelectedSource
  if (!selected) source = { status: 'absent' }
  else if (selected.mode === '100644' || selected.mode === '100755')
    source = await get(`${base}/blobs/${selected.oid}`, (bytes) =>
      verifiedBlob(json(bytes), selected, check),
    )
  else
    source = {
      status: 'unsupported_type',
      mode: selected.mode,
      type: selected.type,
      oid: selected.oid,
    }
  if ((await get(refURL, reference)) !== head)
    throw new SourceReadError('ref_changed')
  check()
  const result: PublicSourceReadResult = {
    status: 'ready',
    observation: {
      provenance: 'github-api-observed',
      repository,
      branch: input.branch,
      head,
      parent,
      commitMessage: commit.message,
      headTree,
      parentTree,
      source,
      refWitness: 'same-head-at-two-reads',
    },
  }
  if (text(JSON.stringify(result)).length > 8 * 1024 * 1024)
    throw new SourceReadError('bounds')
  check()
  return result
}

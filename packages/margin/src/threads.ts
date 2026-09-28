/**
 * Threaded comments: a reply is a `commenting` annotation whose
 * `margin:parentId` names another one, which is how the W3C model says to
 * express it. The service returns a document's replies in the same list as its
 * annotations — one request, one query — and this module assembles the tree in
 * memory.
 *
 * Nothing here filters by visibility. The service never sends a reply the
 * reader may not see, and a thread that hid a delivered row in the browser
 * would only be pretending to be private.
 */
import type { SemanticTextAnchor } from './anchor.js'
import {
  recordFromWebAnnotation,
  serverIdFromIri,
  type MarginVisibility,
} from './records.js'

export type ThreadReply = {
  /** The service's id for this reply. */
  serverId: string
  /** The service's id for what it answers: a note, or another reply. */
  parentId: string
  body: string
  /** Deleted after someone answered it: kept, without its text. */
  deleted: boolean
  visibility: MarginVisibility
  mine: boolean
  /** The author's display name. The service never sends an address. */
  creatorName: string
  created: string
  modified: string
  /** The passage it hangs from, which a reply to it hangs from too. */
  target: SemanticTextAnchor
}

/** Deeper replies render at this indent, not further right. */
export const MAX_THREAD_INDENT = 3

export const DELETED_REPLY_TEXT = 'This reply was deleted.'

/** Shown when the service did not name an author. */
export const UNNAMED_PARTICIPANT = 'A reader'

/** The fragment that addresses a reply, e.g. `#margin-reply-<id>`. */
export const REPLY_FRAGMENT_PREFIX = 'margin-reply-'

export function replyFragment(serverId: string): string {
  return `${REPLY_FRAGMENT_PREFIX}${serverId}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * One reply from the service, or `null` when the annotation is not a reply —
 * or is not a note, which is the only thing a thread holds.
 */
export function replyFromWebAnnotation(
  wire: unknown,
  viewer: string | null,
): ThreadReply | null {
  const annotation = asRecord(wire)
  const parent = annotation?.['margin:parentId']
  if (!annotation || typeof parent !== 'string' || !parent) return null
  if (annotation.motivation !== 'commenting') return null
  // The rail's own mapping, minus the parent: one parser for selectors.
  const record = recordFromWebAnnotation(
    { ...annotation, 'margin:parentId': undefined },
    viewer,
  )
  if (!record || record.annotation.kind !== 'note' || !record.serverId)
    return null
  const deleted = record.deleted === true
  return {
    serverId: record.serverId,
    parentId: serverIdFromIri(parent),
    body: deleted ? DELETED_REPLY_TEXT : record.annotation.body,
    deleted,
    visibility: record.visibility,
    mine: record.mine,
    creatorName: record.creatorName ?? UNNAMED_PARTICIPANT,
    created: typeof annotation.created === 'string' ? annotation.created : '',
    modified:
      typeof annotation.modified === 'string' ? annotation.modified : '',
    target: record.annotation.target,
  }
}

export type ThreadEntry = {
  reply: ThreadReply
  /** 1 for a direct reply to the note, 2 for a reply to that, and so on. */
  depth: number
  /** `depth`, capped at `MAX_THREAD_INDENT`: how far it is drawn in. */
  indent: number
  /** What it answers, when that is another reply. */
  inReplyTo: ThreadReply | null
}

/** Creation time, ties broken by id: the same order the service lists in. */
export function compareReplies(a: ThreadReply, b: ThreadReply): number {
  if (a.created !== b.created) return a.created < b.created ? -1 : 1
  return a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : 0
}

/**
 * The replies grouped by what they answer, built once, sorted once. The rail
 * draws every root from one index: flattening root by root over the whole list
 * rebuilt and sorted the child map per root, quadratic in a busy document.
 */
export function indexThreads(replies: readonly ThreadReply[]): {
  flatten(rootId: string): ThreadEntry[]
} {
  const children = new Map<string, ThreadReply[]>()
  for (const reply of replies) {
    const siblings = children.get(reply.parentId)
    if (siblings) siblings.push(reply)
    else children.set(reply.parentId, [reply])
  }
  for (const siblings of children.values()) siblings.sort(compareReplies)
  return { flatten: (rootId) => walk(rootId, children) }
}

/**
 * The replies under one note, depth first, each level in creation order.
 *
 * Depth is not limited — a reply to a reply to a reply is stored and shown —
 * but `indent` stops at `MAX_THREAD_INDENT`, so a long exchange reads as a
 * column rather than walking off the side of the rail. A reply drawn at the
 * cap carries `inReplyTo`, so it still says who it answers.
 */
export function flattenThread(
  rootId: string,
  replies: readonly ThreadReply[],
): ThreadEntry[] {
  return indexThreads(replies).flatten(rootId)
}

function walk(
  rootId: string,
  children: ReadonlyMap<string, readonly ThreadReply[]>,
): ThreadEntry[] {
  // An explicit stack, not recursion: depth is unlimited and a writer can make
  // a chain deeper than the call stack. Children are pushed in reverse so they
  // pop in creation order, which keeps the walk depth first.
  const entries: ThreadEntry[] = []
  const seen = new Set<string>([rootId])
  const stack: { reply: ThreadReply; parent: ThreadReply | null; depth: number }[] =
    (children.get(rootId) ?? [])
      .map((reply) => ({ reply, parent: null, depth: 1 }))
      .reverse()
  while (stack.length > 0) {
    const { reply, parent, depth } = stack.pop()!
    // A cycle cannot be stored, but a malformed response must not hang a tab.
    if (seen.has(reply.serverId)) continue
    seen.add(reply.serverId)
    entries.push({
      reply,
      depth,
      indent: Math.min(depth, MAX_THREAD_INDENT),
      inReplyTo: parent,
    })
    const next = children.get(reply.serverId) ?? []
    for (let index = next.length - 1; index >= 0; index -= 1) {
      stack.push({ reply: next[index], parent: reply, depth: depth + 1 })
    }
  }
  return entries
}

/** Whether anything, anywhere in `replies`, answers `serverId`. */
export function hasReplies(
  serverId: string,
  replies: readonly ThreadReply[],
): boolean {
  return replies.some((reply) => reply.parentId === serverId)
}

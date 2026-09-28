import { describe, expect, it } from 'vitest'
import {
  DELETED_REPLY_TEXT,
  flattenThread,
  hasReplies,
  MAX_THREAD_INDENT,
  replyFromWebAnnotation,
  UNNAMED_PARTICIPANT,
  type ThreadReply,
} from './threads.js'

const SOURCE = 'https://example.test/books/a/ch1'
const ME = 'urn:reader:me'

function wire(overrides: Record<string, unknown> = {}) {
  return {
    id: 'urn:margin:annotation:r1',
    type: 'Annotation',
    motivation: 'commenting',
    body: { type: 'TextualBody', value: 'a reply', format: 'text/plain' },
    target: {
      source: SOURCE,
      selector: [
        { type: 'TextQuoteSelector', exact: 'hash map' },
        { type: 'TextPositionSelector', start: 2, end: 10 },
        { type: 'margin:StructSelector', 'margin:nodeId': 'p-1' },
      ],
    },
    creator: ME,
    created: '2026-09-28T00:00:01.000Z',
    modified: '2026-09-28T00:00:01.000Z',
    'margin:visibility': 'public',
    'margin:parentId': 'root',
    'margin:creatorName': 'Reader ABCDE',
    ...overrides,
  }
}

function reply(
  serverId: string,
  parentId: string,
  created: string,
): ThreadReply {
  return {
    serverId,
    parentId,
    body: serverId,
    deleted: false,
    visibility: 'public',
    mine: false,
    creatorName: 'Reader ABCDE',
    created,
    modified: created,
    target: {
      nodeId: 'p-1',
      positionUnit: 'codepoint',
      position: { start: 2, end: 10 },
      quote: { exact: 'hash map', prefix: '', suffix: '' },
    },
  }
}

describe('replyFromWebAnnotation', () => {
  it('reads a reply with its parent, author name and passage', () => {
    const parsed = replyFromWebAnnotation(
      wire({ 'margin:parentId': 'urn:margin:annotation:root' }),
      ME,
    )
    expect(parsed).toMatchObject({
      serverId: 'r1',
      parentId: 'root',
      body: 'a reply',
      deleted: false,
      mine: true,
      creatorName: 'Reader ABCDE',
      visibility: 'public',
    })
    expect(parsed?.target.nodeId).toBe('p-1')
  })

  it('reads a tombstone without a body', () => {
    const parsed = replyFromWebAnnotation(
      wire({ body: undefined, 'margin:deleted': true }),
      null,
    )
    expect(parsed).toMatchObject({
      deleted: true,
      body: DELETED_REPLY_TEXT,
      mine: false,
    })
  })

  it('names nobody by anything but the display name it was sent', () => {
    expect(
      replyFromWebAnnotation(wire({ 'margin:creatorName': undefined }), ME)
        ?.creatorName,
    ).toBe(UNNAMED_PARTICIPANT)
  })

  it('skips top-level annotations and anything that is not a note', () => {
    expect(
      replyFromWebAnnotation(wire({ 'margin:parentId': undefined }), ME),
    ).toBeNull()
    expect(
      replyFromWebAnnotation(
        wire({ motivation: 'highlighting', body: undefined }),
        ME,
      ),
    ).toBeNull()
  })
})

describe('flattenThread', () => {
  it('orders depth first, each level by creation time then id', () => {
    const replies = [
      reply('b', 'root', '2026-09-28T00:00:02.000Z'),
      reply('a2', 'a', '2026-09-28T00:00:05.000Z'),
      reply('a', 'root', '2026-09-28T00:00:01.000Z'),
      reply('a1', 'a', '2026-09-28T00:00:03.000Z'),
      reply('a1x', 'a1', '2026-09-28T00:00:04.000Z'),
      // Same instant as `b`: the id breaks the tie.
      reply('c', 'root', '2026-09-28T00:00:02.000Z'),
      reply('elsewhere', 'other-root', '2026-09-28T00:00:01.000Z'),
    ]
    const entries = flattenThread('root', replies)
    expect(
      entries.map((entry) => [entry.reply.serverId, entry.depth]),
    ).toEqual([
      ['a', 1],
      ['a1', 2],
      ['a1x', 3],
      ['a2', 2],
      ['b', 1],
      ['c', 1],
    ])
    // Stable whatever order the replies arrived in.
    expect(
      flattenThread('root', [...replies].reverse()).map(
        (entry) => entry.reply.serverId,
      ),
    ).toEqual(entries.map((entry) => entry.reply.serverId))
  })

  it('does not limit depth but caps the indent', () => {
    const replies: ThreadReply[] = []
    let parent = 'root'
    for (let depth = 1; depth <= 8; depth += 1) {
      const id = `d${depth}`
      replies.push(reply(id, parent, `2026-09-28T00:00:0${depth}.000Z`))
      parent = id
    }
    const entries = flattenThread('root', replies)
    expect(entries.map((entry) => entry.depth)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(entries.map((entry) => entry.indent)).toEqual([
      1,
      2,
      3,
      ...new Array(5).fill(MAX_THREAD_INDENT),
    ])
    expect(entries[0].inReplyTo).toBeNull()
    expect(entries[7].inReplyTo?.serverId).toBe('d7')
  })

  it('walks a chain deeper than the call stack without recursing', () => {
    // An allowlisted writer can build any depth through ordinary requests; a
    // recursive walk would throw RangeError and take the whole rail down.
    const depth = 50_000
    const replies: ThreadReply[] = []
    let parent = 'root'
    for (let level = 1; level <= depth; level += 1) {
      const id = `n${level}`
      replies.push(reply(id, parent, '2026-09-28T00:00:01.000Z'))
      parent = id
    }
    const entries = flattenThread('root', replies)
    expect(entries).toHaveLength(depth)
    expect(entries[depth - 1].depth).toBe(depth)
    expect(entries[depth - 1].indent).toBe(MAX_THREAD_INDENT)
    expect(entries[depth - 1].inReplyTo?.serverId).toBe(`n${depth - 1}`)
  })

  it('survives a cycle in a malformed response', () => {
    const entries = flattenThread('root', [
      reply('x', 'root', '2026-09-28T00:00:01.000Z'),
      reply('y', 'x', '2026-09-28T00:00:02.000Z'),
      { ...reply('x', 'y', '2026-09-28T00:00:03.000Z') },
    ])
    expect(entries.map((entry) => entry.reply.serverId)).toEqual(['x', 'y'])
  })

  it('knows whether anything answers a note', () => {
    const replies = [reply('x', 'root', '2026-09-28T00:00:01.000Z')]
    expect(hasReplies('root', replies)).toBe(true)
    expect(hasReplies('x', replies)).toBe(false)
  })
})

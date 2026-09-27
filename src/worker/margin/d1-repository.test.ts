import { describe, expect, it } from 'vitest'
import { D1MarginRepository } from './d1-repository'
import { SqliteD1Database } from './sqlite-database'

const scope = { site: 'https://ernie.sg', document: '/emoji' }

describe('D1 annotation coordinate units', () => {
  it('round-trips a W3C code-point anchor through the repository', async () => {
    const repository = new D1MarginRepository(SqliteD1Database.inMemory())
    await repository.insertAnnotation({
      id: 'emoji-anchor',
      ...scope,
      creator: 'ada',
      visibility: 'public',
      parentId: null,
      structId: null,
      color: null,
      annotation: {
        id: 'emoji-anchor',
        kind: 'note',
        geometryCache: [],
        body: 'A note',
        target: {
          nodeId: 'p-1',
          positionUnit: 'codepoint',
          position: { start: 4, end: 5 },
          quote: { exact: 'x', prefix: '🌊 x ', suffix: '' },
        },
      },
      created: '2026-09-23T00:00:00.000Z',
      modified: '2026-09-23T00:00:00.000Z',
    })
    const [stored] = await repository.listAnnotations(scope, null)
    expect(stored.annotation.target.positionUnit).toBe('codepoint')
    expect(stored.annotation.target.position).toEqual({ start: 4, end: 5 })
  })

  it('round-trips a note’s role colour, and keeps an untagged note uncoloured', async () => {
    const repository = new D1MarginRepository(SqliteD1Database.inMemory())
    const note = (id: string, color: string | null) => ({
      id,
      ...scope,
      creator: 'ada',
      visibility: 'public' as const,
      parentId: null,
      structId: null,
      color,
      annotation: {
        id,
        kind: 'note' as const,
        geometryCache: [],
        body: 'why this order?',
        target: {
          nodeId: 'p-1',
          positionUnit: 'codepoint' as const,
          position: { start: 0, end: 1 },
          quote: { exact: 'x', prefix: '', suffix: '' },
        },
      },
      created: '2026-09-28T00:00:00.000Z',
      modified: '2026-09-28T00:00:00.000Z',
    })
    await repository.insertAnnotation(note('tagged', 'question'))
    await repository.insertAnnotation(note('plain', null))
    const stored = await repository.listAnnotations(scope, null)
    const byId = Object.fromEntries(stored.map((row) => [row.id, row]))
    expect(byId.tagged.color).toBe('question')
    expect(byId.tagged.annotation).toMatchObject({ kind: 'note', body: 'why this order?' })
    expect(byId.tagged.annotation).toMatchObject({ appearance: { color: 'question' } })
    expect(byId.plain.color).toBeNull()
    expect(byId.plain.annotation).not.toHaveProperty('appearance')
  })
})

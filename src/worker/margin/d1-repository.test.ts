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
})

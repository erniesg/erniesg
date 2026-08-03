import { describe, expect, it } from 'vitest'
import fixture from '../../tests/fixtures/publication/four-profile-publication.json'
import { publicationGraphSchema } from './schema'
import { enumerateLayoutCandidates, type PlannerPolicy, type PlanningContext } from './planner'
import { createRendererProbe } from './renderer-probe'
import { validateProduction } from './production-validation'

const graph = publicationGraphSchema.parse(fixture.graph)
const policy = fixture.policy as PlannerPolicy
const context = fixture.profiles['a4-pdf'] as PlanningContext
const plan = enumerateLayoutCandidates({ graph, context, policy })[0]

describe('geometric and production validation', () => {
  it('passes only a complete measured probe', () => {
    const result = validateProduction({
      graph,
      context,
      plan,
      probe: createRendererProbe(plan, { pageCount: 2 }),
    })
    expect(result.passed).toBe(true)
    expect(result.checked.overflow).toBe(true)
  })

  it.each([
    ['overflow', { overflow: true }, 'UNEXPECTED_OVERFLOW'],
    ['clipping', { clipping: true }, 'UNEXPECTED_CLIPPING'],
    ['glyphs', { glyphCoverage: { requested: ['λ'], shaped: [], missing: ['λ'], unsupported: [] } }, 'UNSUPPORTED_GLYPH_SHAPING'],
    ['table fallback', { fallbacks: [{ nodeId: 'conventional-table', kind: 'table', usable: false }] }, 'UNUSABLE_TABLE_FALLBACK'],
  ])('rejects measured %s hard failures', (_label, measurement, code) => {
    const result = validateProduction({
      graph,
      context,
      plan,
      probe: createRendererProbe(plan, measurement as any),
    })
    expect(result.passed).toBe(false)
    expect(result.hardViolations.map((violation) => violation.code)).toContain(code)
  })
})


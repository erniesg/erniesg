import { describe, expect, it } from 'vitest'
import fixture from '../../tests/fixtures/publication/four-profile-publication.json'
import undersized from '../../tests/fixtures/publication/undersized-profile.json'
import { publicationGraphSchema } from './schema'
import { enumerateLayoutCandidates, type PlannerPolicy, type PlanningContext } from './planner'
import { runStaticPreflight } from './static-preflight'

const graph = publicationGraphSchema.parse(fixture.graph)
const policy = fixture.policy as PlannerPolicy

describe('static semantic preflight', () => {
  it('rejects undersized geometry before any renderer is invoked', () => {
    const context = undersized.profile as PlanningContext
    const plan = enumerateLayoutCandidates({ graph, context, policy })[0]
    const result = runStaticPreflight({ graph, context, policy, plan })
    expect(result.passed).toBe(false)
    expect(result.hardViolations.map((violation) => violation.code)).toContain(
      'KNOWN_LEGIBILITY_FLOOR',
    )
  })

  it('fails closed when a required interactive static alternative is absent', () => {
    const withoutAlternative = structuredClone(graph)
    const media = withoutAlternative.nodes.find((node) => node.id === 'interactive-media')
    if (media?.type === 'media') media.variants = []
    const context = fixture.profiles['a4-pdf'] as PlanningContext
    const plan = enumerateLayoutCandidates({ graph: withoutAlternative, context, policy })[0]
    const result = runStaticPreflight({
      graph: withoutAlternative,
      context,
      policy,
      plan,
    })
    expect(result.passed).toBe(false)
    expect(result.hardViolations.map((violation) => violation.code)).toContain(
      'MISSING_REQUIRED_STATIC_ALTERNATIVE',
    )
  })

  it('does not accept a changed canonical reading order', () => {
    const context = fixture.profiles['a4-pdf'] as PlanningContext
    const plan = enumerateLayoutCandidates({ graph, context, policy })[0]
    const changed = {
      ...plan,
      fragments: [...plan.fragments].reverse(),
    }
    const result = runStaticPreflight({ graph, context, policy, plan: changed as typeof plan })
    expect(result.hardViolations.map((violation) => violation.code)).toContain(
      'READING_ORDER_CHANGED',
    )
  })
})


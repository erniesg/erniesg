import { describe, expect, it } from 'vitest'
import fixture from '../../tests/fixtures/publication/four-profile-publication.json'
import undersized from '../../tests/fixtures/publication/undersized-profile.json'
import { publicationGraphSchema } from './schema'
import {
  LAYOUT_MODES,
  enumerateLayoutCandidates,
  planPublication,
  type PlannerPolicy,
  type PlanningContext,
} from './planner'
import { probeVivliostyleLayout } from './vivliostyle-renderer'

const graph = publicationGraphSchema.parse(fixture.graph)
const policy = fixture.policy as PlannerPolicy
const context = fixture.profiles['a4-pdf'] as PlanningContext

describe('deterministic layout planner', () => {
  it('enumerates the bounded authored modes in stable order and covers each node once', () => {
    const candidates = enumerateLayoutCandidates({ graph, context, policy })
    expect(candidates.map((candidate) => candidate.mode)).toEqual([...LAYOUT_MODES])
    for (const candidate of candidates) {
      expect(candidate.fragments.map((fragment) => fragment.nodeId)).toEqual(
        graph.nodes.map((node) => node.id),
      )
      expect(candidate.sourceAnchors.map((anchor) => anchor.nodeId)).toEqual(
        graph.nodes.map((node) => node.id),
      )
      expect(candidate.reasons.length).toBeGreaterThan(0)
      expect(candidate.softTradeoffs.map((tradeoff) => tradeoff.code)).toEqual([
        'DENSITY',
        'HIERARCHY',
        'FIGURE_PROMINENCE',
        'WHITESPACE',
        'POLICY_PREFERENCE',
      ])
    }
  })

  it('never marks a measured artifact eligible without a passing renderer probe', () => {
    const unmeasured = planPublication({ graph, context, policy })
    expect(unmeasured.eligible).toBe(true)
    expect(unmeasured.artifactEligible).toBe(false)
    expect(unmeasured.requiresRendererProbe).toBe(true)

    const measured = planPublication({
      graph,
      context,
      policy,
      options: { renderer: (plan) => probeVivliostyleLayout(plan) },
    })
    expect(measured.artifactEligible).toBe(true)
    expect(measured.selectedPlan).not.toBeNull()
  })

  it('returns actionable alternatives when the profile is too small', () => {
    const result = planPublication({
      graph,
      policy,
      context: undersized.profile as PlanningContext,
    })
    expect(result.noEligiblePlan).toBe(true)
    expect(result.selectedPlan).toBeNull()
    expect(result.alternatives[0].code).toBe('RELAX_SMALLEST_GEOMETRIC_CONSTRAINT')
  })
})

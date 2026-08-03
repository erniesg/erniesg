import { describe, expect, it } from 'vitest'
import fixture from '../../tests/fixtures/publication/four-profile-publication.json'
import { publicationGraphSchema } from './schema'
import { enumerateLayoutCandidates, type PlannerPolicy, type PlanningContext } from './planner'
import {
  layoutPlanToSemanticHtml,
  probeVivliostyleLayout,
  renderLayoutPlan,
} from './vivliostyle-renderer'

const graph = publicationGraphSchema.parse(fixture.graph)
const policy = fixture.policy as PlannerPolicy
const context = fixture.profiles['a4-pdf'] as PlanningContext
const plan = enumerateLayoutCandidates({ graph, context, policy })[0]

describe('Vivliostyle plan adapter', () => {
  it('consumes a LayoutPlan and keeps output anchors renderer-local', () => {
    const html = layoutPlanToSemanticHtml(graph, plan)
    expect(html).toContain(`data-plan="${plan.id}"`)
    expect(html).toContain(`data-canonical-id="${graph.nodes[0].id}"`)
    expect(html).toContain(`id="${plan.outputAnchors[0].id}"`)
    expect(html).not.toContain('page-x')
  })

  it('returns a versioned probe with measured output anchors', () => {
    const result = renderLayoutPlan(graph, plan, { pageCount: 2 })
    expect(result.probe.version).toBe('1.0.0')
    expect(result.probe.rendererId).toBe('vivliostyle')
    expect(result.probe.pageCount).toBe(2)
    expect(probeVivliostyleLayout(plan).outputAnchors.length).toBe(plan.fragments.length)
  })
})


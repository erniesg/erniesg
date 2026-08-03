import { describe, expect, it } from 'vitest'
import fixture from '../../tests/fixtures/publication/four-profile-publication.json'
import { publicationGraphSchema } from './schema'
import { enumerateLayoutCandidates, type PlannerPolicy, type PlanningContext } from './planner'
import {
  createRendererProbe,
  rendererProbeSchema,
  serializeRendererProbe,
} from './renderer-probe'

const graph = publicationGraphSchema.parse(fixture.graph)
const policy = fixture.policy as PlannerPolicy
const context = fixture.profiles['a4-pdf'] as PlanningContext
const plan = enumerateLayoutCandidates({ graph, context, policy })[0]

describe('renderer probes', () => {
  it('records bounded renderer facts separately from the graph', () => {
    const probe = createRendererProbe(plan, {
      rendererId: 'vivliostyle',
      rendererVersion: '1.0.0',
      pageCount: 3,
      shapedGlyphCoverage: { requested: ['A'], shaped: ['A'], missing: [], unsupported: [] },
      output: { artifactSha256: 'a'.repeat(64), byteLength: 42 },
    })
    expect(rendererProbeSchema.parse(JSON.parse(serializeRendererProbe(probe)))).toEqual(probe)
    expect(probe.pageCount).toBe(3)
    expect(probe).not.toHaveProperty('nodes')
  })

  it('preserves measured failures for production validation', () => {
    const probe = createRendererProbe(plan, {
      overflow: [{ code: 'overflow', nodeId: 'intro' }],
      clipping: [{ code: 'clip', nodeId: 'full-figure' }],
      glyphCoverage: { requested: ['x'], shaped: [], missing: ['x'], unsupported: [] },
    })
    expect(probe.overflow).toEqual([{ code: 'overflow', nodeId: 'intro' }])
    expect(probe.clipping).toEqual([{ code: 'clip', nodeId: 'full-figure' }])
    expect(probe.shapedGlyphCoverage.missing).toEqual(['x'])
  })
})


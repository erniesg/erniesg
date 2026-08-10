import { describe, expect, it } from 'vitest'
import { papers } from '../research/papers'
import { researchPaperToPublicationGraph } from './research-paper-adapter'
import type { PublicationNode } from './schema'
import { UnsupportedPublicationVersionError } from './schema'
import {
  DEFAULT_TRANSFORMATION_POLICY,
  evaluateTransformation,
  findTransformationRule,
  findUnknownTransformationIds,
  parseTransformationPolicy,
  transformationPolicySchema,
  TRANSFORMATION_IDS,
  TRANSFORMATION_POLICY_VERSION,
} from './transformation-policy'

const MEANING_CHANGING = [
  'omit-node',
  'summarize-node',
  'reorder-reading-sequence',
  'crop-figure-to-detail',
] as const

function sampleNode(overrides: Partial<PublicationNode> = {}): PublicationNode {
  const { graph } = researchPaperToPublicationGraph(papers[1])
  const node = graph.nodes.find((candidate) => candidate.type === 'paragraph')
  if (!node) throw new Error('The golden paper must contain a paragraph node')
  return { ...node, ...overrides } as PublicationNode
}

describe('transformation policy', () => {
  it('declares a rule for every known transformation', () => {
    expect(DEFAULT_TRANSFORMATION_POLICY.version).toBe(
      TRANSFORMATION_POLICY_VERSION,
    )
    expect(DEFAULT_TRANSFORMATION_POLICY.rules.map((rule) => rule.id)).toEqual([
      ...TRANSFORMATION_IDS,
    ])
    for (const rule of DEFAULT_TRANSFORMATION_POLICY.rules) {
      expect(rule.representationChange.length).toBeGreaterThan(0)
      expect(rule.constraints.hard.length + rule.constraints.soft.length).toBeGreaterThan(
        0,
      )
    }
  })

  it('classifies omission, summarisation, reordering, and crops as meaning changing', () => {
    for (const id of MEANING_CHANGING) {
      const rule = findTransformationRule(DEFAULT_TRANSFORMATION_POLICY, id)
      expect(rule?.preservationClass).toBe('meaning-changing')
      expect(rule?.legality).toBe('requires-reviewed-variant')
    }
  })

  it('refuses meaning-changing transformations without an explicit reviewed variant', () => {
    for (const id of MEANING_CHANGING) {
      expect(
        evaluateTransformation(
          DEFAULT_TRANSFORMATION_POLICY,
          id,
          sampleNode({ permittedTransformations: [id] }),
        ),
      ).toMatchObject({ status: 'rejected', reason: 'no-reviewed-variant' })

      expect(
        evaluateTransformation(
          DEFAULT_TRANSFORMATION_POLICY,
          id,
          sampleNode({
            permittedTransformations: [id],
            reviewedVariants: [
              {
                id: `reviewed-${id}`,
                transformationId: id,
                reviewedBy: 'Chen Enjiao (Ernie)',
                rationale: 'Reviewed for the compact e-ink edition.',
              },
            ],
          }),
        ),
      ).toMatchObject({
        status: 'permitted',
        reason: 'permitted-by-reviewed-variant',
        preservationClass: 'meaning-changing',
      })
    }
  })

  it('refuses transformations the node does not permit', () => {
    expect(
      evaluateTransformation(
        DEFAULT_TRANSFORMATION_POLICY,
        'repaginate',
        sampleNode(),
      ),
    ).toMatchObject({ status: 'rejected', reason: 'not-permitted-by-node' })

    expect(
      evaluateTransformation(
        DEFAULT_TRANSFORMATION_POLICY,
        'repaginate',
        sampleNode({ permittedTransformations: ['repaginate'] }),
      ),
    ).toMatchObject({ status: 'permitted', reason: 'permitted-by-policy' })

    expect(
      evaluateTransformation(
        DEFAULT_TRANSFORMATION_POLICY,
        'invent-a-layout',
        sampleNode({ permittedTransformations: ['invent-a-layout'] }),
      ),
    ).toMatchObject({ status: 'rejected', reason: 'unknown-transformation' })
  })

  it('requires a reviewed authored alternative before substituting a variant', () => {
    expect(
      evaluateTransformation(
        DEFAULT_TRANSFORMATION_POLICY,
        'substitute-compact-variant',
        sampleNode({ permittedTransformations: ['substitute-compact-variant'] }),
      ),
    ).toMatchObject({
      status: 'rejected',
      reason: 'missing-authored-alternative',
    })

    expect(
      evaluateTransformation(
        DEFAULT_TRANSFORMATION_POLICY,
        'substitute-compact-variant',
        sampleNode({
          permittedTransformations: ['substitute-compact-variant'],
          authoredVariants: { compact: { reviewed: false, text: 'Short form.' } },
        }),
      ),
    ).toMatchObject({
      status: 'rejected',
      reason: 'unreviewed-authored-alternative',
    })

    expect(
      evaluateTransformation(
        DEFAULT_TRANSFORMATION_POLICY,
        'substitute-monochrome-variant',
        sampleNode({
          permittedTransformations: ['substitute-monochrome-variant'],
          authoredVariants: {
            monochrome: { reviewed: true, reviewedBy: 'Ernie', text: 'Mono.' },
          },
        }),
      ),
    ).toMatchObject({
      status: 'permitted',
      reason: 'permitted-by-authored-variant',
    })
  })

  it('rejects unknown versions and internally inconsistent rules', () => {
    expect(() =>
      parseTransformationPolicy({ ...DEFAULT_TRANSFORMATION_POLICY, version: '2.0.0' }),
    ).toThrow(UnsupportedPublicationVersionError)
    expect(parseTransformationPolicy(DEFAULT_TRANSFORMATION_POLICY)).toEqual(
      DEFAULT_TRANSFORMATION_POLICY,
    )

    expect(() =>
      transformationPolicySchema.parse({
        ...DEFAULT_TRANSFORMATION_POLICY,
        rules: [
          {
            id: 'omit-node',
            label: 'Omit a node',
            representationChange: 'Remove content.',
            preservationClass: 'meaning-changing',
            legality: 'always-legal',
            requiredAuthoredAlternative: null,
            constraints: { hard: [], soft: [] },
          },
        ],
      }),
    ).toThrow(/explicit reviewed variant/)

    expect(() =>
      transformationPolicySchema.parse({
        ...DEFAULT_TRANSFORMATION_POLICY,
        rules: [
          DEFAULT_TRANSFORMATION_POLICY.rules[0],
          DEFAULT_TRANSFORMATION_POLICY.rules[0],
        ],
      }),
    ).toThrow(/Duplicate transformation rule id/)
  })

  it('finds transformation ids a graph names but the policy does not know', () => {
    const { graph } = researchPaperToPublicationGraph(papers[1])
    expect(findUnknownTransformationIds(graph)).toEqual([])

    const drifted = {
      ...graph,
      nodes: [
        { ...graph.nodes[0], permittedTransformations: ['invent-a-layout'] },
        ...graph.nodes.slice(1),
      ],
    }
    expect(findUnknownTransformationIds(drifted)).toEqual([
      `${graph.nodes[0].id}:invent-a-layout`,
    ])
  })
})

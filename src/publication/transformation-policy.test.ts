import { describe, expect, it } from 'vitest'
import { transformationPolicySchema } from './transformation-policy'

const base = {
  version: '1.0.0',
  id: 'accessible-reflow',
  transformations: [
    {
      id: 'reflow-text',
      from: 'text',
      to: 'text',
      operation: 'reflow',
      preservationClass: 'identity',
      requiredAuthoredAlternative: 'none',
    },
  ],
  constraints: [
    {
      id: 'preserve-reading-order',
      strength: 'hard',
      subject: 'reading-order',
      operator: 'preserve',
      value: true,
      rationale: 'Reading order carries meaning.',
    },
  ],
}

describe('TransformationPolicy', () => {
  it('declares legal representation changes and hard/soft constraints', () => {
    expect(transformationPolicySchema.parse(base)).toEqual(base)
  })

  it.each([
    'omit',
    'summarize',
    'reorder-reading-order',
    'crop-meaning-changing',
  ])('rejects unreviewed %s', (operation) => {
    const value: any = structuredClone(base)
    value.transformations[0].operation = operation
    expect(transformationPolicySchema.safeParse(value).success).toBe(false)
    value.transformations[0] = {
      ...value.transformations[0],
      preservationClass: 'reviewed-meaning-change',
      requiredAuthoredAlternative: 'compact',
      reviewedVariantId: 'reviewed-compact',
    }
    expect(transformationPolicySchema.safeParse(value).success).toBe(true)
  })
})

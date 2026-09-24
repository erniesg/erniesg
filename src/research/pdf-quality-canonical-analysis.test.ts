import { describe, expect, it } from 'vitest'
import { canonicalVisualOrderViolationRelationshipIds } from './pdf-quality'
import { canonicalVisualOrderViolationRelationshipIds as canonicalAnalysisValidator } from './pdf-quality-canonical-analysis'

describe('pdf-quality canonical-analysis compatibility exports', () => {
  it('preserves the visual-order validator function binding', () => {
    expect(canonicalVisualOrderViolationRelationshipIds).toBe(
      canonicalAnalysisValidator,
    )
  })
})

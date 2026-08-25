import { expect, it } from 'vitest'
import type { NodeSourceEvidence, NormalizedSourceBox } from './import-types'
import { captionProvenanceEnvelope } from './pdf-canonical-node-composition'

it('retains connected source-text equation glyph bounds beyond its caption region', () => {
  const placeholder: NormalizedSourceBox = {
    page: 1,
    x: 0.3,
    y: 0.28,
    width: 0.24,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
  }
  const evidence: NodeSourceEvidence = {
    confidence: 1,
    pages: [1],
    regionIds: ['equation-region'],
    boxes: [
      { ...placeholder, width: 0.2 },
      {
        ...placeholder,
        x: 0.505,
        y: 0.294,
        width: 0.02,
        height: 0.0076,
      },
    ],
    links: [],
  }

  expect(
    captionProvenanceEnvelope(evidence, 'equation-region', placeholder, {
      allowExactRegionOverflow: true,
    }),
  ).toMatchObject({
    x: 0.3,
    y: 0.28,
    width: 0.225,
    height: 0.0216,
  })
})

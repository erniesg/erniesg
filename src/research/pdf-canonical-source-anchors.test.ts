import { describe, expect, it } from 'vitest'
import {
  exactCanonicalRangeForSource,
  type PdfCanonicalSourceBlock,
} from './pdf-canonical-source-anchors'

describe('canonical PDF source anchors', () => {
  it('maps an exact source subrange through a segmented canonical block', () => {
    const block: PdfCanonicalSourceBlock = {
      region: { id: 'parent-region' },
      text: 'Alpha Beta',
      sourceSegments: [
        {
          region: { id: 'source-region' },
          sourceStart: 10,
          canonicalStart: 6,
          text: 'Beta',
        },
      ],
    }

    expect(
      exactCanonicalRangeForSource(block, 'source-region', 10, 14),
    ).toEqual({ start: 6, end: 10 })
  })
})

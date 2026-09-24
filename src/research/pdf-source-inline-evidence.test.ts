import { describe, expect, it } from 'vitest'
import { literalAbsoluteHyperlinks } from './pdf-source-inline-evidence'

describe('PDF source inline evidence', () => {
  it('trims unmatched URL closers and trailing punctuation', () => {
    expect(
      literalAbsoluteHyperlinks('See https://example.test/path).'),
    ).toEqual([
      {
        start: 4,
        end: 29,
        url: 'https://example.test/path',
      },
    ])
  })
})

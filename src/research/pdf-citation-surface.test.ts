import { describe, expect, it } from 'vitest'
import { parsePdfCitationSurface } from './pdf-citation-surface'

describe('PDF citation surface parsing', () => {
  it('preserves ordered list identities and exact per-label ranges', () => {
    expect(parsePdfCitationSurface('[62, 63, 48]')).toEqual({
      identities: ['62', '63', '48'],
      links: [
        { start: 1, end: 3, identityIndex: 0 },
        { start: 5, end: 7, identityIndex: 1 },
        { start: 9, end: 11, identityIndex: 2 },
      ],
    })
  })

  it('does not fabricate a visible link for an intermediate range target', () => {
    expect(parsePdfCitationSurface('[1–3]')).toEqual({
      identities: ['1', '2', '3'],
      links: [
        { start: 1, end: 2, identityIndex: 0 },
        { start: 3, end: 4, identityIndex: 2 },
      ],
    })
  })

  it.each(['[1, 1]', '[1, missing]', '[3–1]', '[1, 2] trailing'])(
    'fails malformed or ambiguous citation surface %s closed',
    (value) => {
      expect(parsePdfCitationSurface(value)).toBeNull()
    },
  )
})

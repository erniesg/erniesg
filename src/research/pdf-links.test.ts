import { describe, expect, it } from 'vitest'
import {
  normalizedPdfExternalLinkTarget,
  safePdfExternalLinkTarget,
} from './pdf-links'

describe('PDF external links', () => {
  it('keeps real DOI links and suppresses incomplete or placeholder DOI links', () => {
    expect(
      safePdfExternalLinkTarget('https://doi.org/10.1145/3626772.3657676'),
    ).toBe(true)
    expect(
      normalizedPdfExternalLinkTarget(
        'https://doi.org/10.1145/3626772.3657676',
      ),
    ).toBe('https://doi.org/10.1145/3626772.3657676')

    expect(safePdfExternalLinkTarget('https://doi.org/10.1145/')).toBe(false)
    expect(
      safePdfExternalLinkTarget('https://doi.org/10.1145/nnnnnnn.nnnnnnn'),
    ).toBe(false)
  })
})

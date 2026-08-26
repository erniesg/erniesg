import { describe, expect, it } from 'vitest'
import { resolvedPackageHref } from './epub-inspection-helpers'

describe('EPUB inspection helpers', () => {
  it('resolves relative package references without allowing root escape', () => {
    expect(
      resolvedPackageHref('chapters/content.xhtml', '../images/figure.png'),
    ).toBe('images/figure.png')
    expect(
      resolvedPackageHref('chapters/content.xhtml', '../../outside.xhtml'),
    ).toBeNull()
  })
})

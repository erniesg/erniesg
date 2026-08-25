import { describe, expect, it } from 'vitest'
import type { PublicationAsset } from './import-types'
import { isSolidFillVectorFragment } from './epub-readable-fallback'

function vectorAsset(svg: string): PublicationAsset {
  return {
    id: 'vector-fragment',
    href: 'assets/vector-fragment.svg',
    mediaType: 'image/svg+xml',
    kind: 'vector',
    rendition: 'source-preserved',
    bytes: new TextEncoder().encode(svg),
    width: 100,
    height: 50,
    resolutionDpi: null,
    sourceObjectIds: ['object-1'],
    sourceBoxes: [
      {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.5,
        height: 0.2,
        rotation: 0,
        method: 'pdf-object',
      },
    ],
    sha256: 'a'.repeat(64),
  }
}

describe('readable EPUB visual filtering', () => {
  it('recognizes a full-view-box black fill fragment as non-semantic artwork', () => {
    expect(
      isSolidFillVectorFragment(
        vectorAsset(
          '<svg viewBox="0 0 100 50"><path fill="#000" stroke="none" d="M0 0 L100 0 L100 50 L0 50 Z"/></svg>',
        ),
      ),
    ).toBe(true)

    expect(
      isSolidFillVectorFragment(
        vectorAsset(
          '<svg viewBox="0 0 100 50"><path fill="#c00" stroke="none" d="M0 0 L100 0 L100 50 L0 50 Z"/></svg>',
        ),
      ),
    ).toBe(false)
  })
})

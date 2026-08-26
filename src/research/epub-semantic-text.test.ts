import { describe, expect, it } from 'vitest'
import { renderTextWithNoteReferences } from './epub-semantic-text'

describe('EPUB semantic text rendering', () => {
  it('renders a canonical single-target citation without duplicating its visible label', () => {
    expect(
      renderTextWithNoteReferences(
        'See [1].',
        undefined,
        [
          {
            start: 4,
            end: 7,
            relationshipId: 'citation-1',
            semanticRole: 'citation',
            targetIds: ['reference-1'],
          },
        ],
        new Map([
          ['reference-1', { kind: 'citation' as const, identifier: '1' }],
        ]),
      ),
    ).toBe(
      'See <a id="citation-1" href="#reference-1" epub:type="biblioref" role="doc-biblioref" data-semantic-role="citation" data-relationship-id="citation-1" data-target-ids="reference-1">[1]</a>.',
    )
  })
})

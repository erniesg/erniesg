import { expect, it } from 'vitest'
import type { PdfVisualRelationship } from './import-types'
import { canonicalVisualSourceTranscript } from './pdf-visual-source-mapping'

it('prefers a matched table source transcript over a trimmed exact fallback', () => {
  const relationship: Pick<
    PdfVisualRelationship,
    'kind' | 'status' | 'sourceText'
  > = {
    kind: 'table',
    status: 'matched',
    sourceText: 'Table source transcript',
  }

  expect(
    canonicalVisualSourceTranscript(relationship, 'Exact fallback transcript'),
  ).toBe('Table source transcript')
})

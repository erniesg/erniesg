import { describe, expect, it } from 'vitest'
import rawPaper from '../research/papers/semantic-responsive-typesetting.json'
import { researchPaperSchema } from '../research/schema'
import { adaptResearchPaper } from './research-paper-adapter'
import {
  adapterProvenanceSchema,
  validatePublicationSourceResult,
} from './source-adapter'

describe('PublicationSourceAdapter', () => {
  it('returns the versioned graph, asset, diagnostics and provenance boundary', () => {
    const result = adaptResearchPaper(researchPaperSchema.parse(rawPaper))
    expect(validatePublicationSourceResult(result)).toEqual(result)
    expect(result).toMatchObject({
      graph: { version: '1.0.0' },
      assetBundle: { descriptor: { version: '1.0.0' } },
      diagnostics: [],
      provenance: { adapterVersion: '1.0.0', sourceType: 'research-paper' },
    })
  })

  it.each([
    '/tmp/manuscript.docx',
    'file:///tmp/input.pdf',
    'source?token=abc',
  ])('rejects unsafe source id %s', (sourceId) => {
    expect(
      adapterProvenanceSchema.safeParse({
        adapterId: 'docx',
        adapterVersion: '1.0.0',
        sourceType: 'docx',
        sourceId,
      }).success,
    ).toBe(false)
  })
})

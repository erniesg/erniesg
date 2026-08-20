import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildStructEpub } from '../src/epub'
import { renderPublicationXhtml } from '../src/xhtml'
import type { StructDocument } from '../src/types'
import {
  characterizationDocument,
  resealDocument,
} from './characterization-fixtures'

function numericReferenceDocument() {
  const document = characterizationDocument('0.2.0')
  const source = document.blocks[0]!
  const evidence = source.evidence
  source.id = 'source'
  source.text = 'See 1'
  source.inline = [
    {
      start: 4,
      end: 5,
      relationshipId: 'numeric-reference',
      semanticRole: 'citation',
    },
  ]
  document.blocks = [
    source,
    {
      ...source,
      id: '1block',
      text: 'Numeric target',
      inline: [],
      evidence,
    },
    {
      ...source,
      id: 'n-1block',
      text: 'Collision candidate',
      inline: [],
      evidence,
    },
  ]
  document.relationships = [
    {
      id: 'numeric-reference',
      kind: 'citation',
      from: source.id,
      to: ['1block'],
      label: '1',
      status: 'matched',
      confidence: 1,
      evidence: { confidence: 1, pages: [], boxes: [], sourceIds: [] },
    },
  ]
  return document as StructDocument
}

describe('STRUCT XHTML ID mapping', () => {
  it('maps numeric-leading matched references without colliding with canonical IDs', () => {
    const xhtml = renderPublicationXhtml(numericReferenceDocument())
    expect(xhtml).toContain('id="_1block" data-struct-id="_1block"')
    expect(xhtml).toContain('id="n-1block" data-struct-id="n-1block"')
    expect(xhtml).toContain('href="#_1block"')
    expect(xhtml).not.toContain('id="1block"')
    expect(xhtml).not.toContain('href="#1block"')
  })

  it('keeps EPUB navigation references aligned with numeric-leading heading IDs', async () => {
    const document = characterizationDocument('0.2.0')
    const heading = document.blocks[0]!
    heading.id = '1heading'
    heading.kind = 'heading'
    heading.attributes = { level: 2 }
    document.pages[0]!.blocks = ['1heading']
    document.pages[0]!.columns[0]!.blockIds = ['1heading']
    resealDocument(document)

    const epub = await buildStructEpub(document)
    const files = unzipSync(epub.bytes)
    expect(strFromU8(files['EPUB/content.xhtml']!)).toContain('id="_1heading"')
    expect(strFromU8(files['EPUB/nav.xhtml']!)).toContain(
      'content.xhtml#_1heading',
    )
  })
})

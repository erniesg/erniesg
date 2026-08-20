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

function derivedIdentityDocument(
  blocks: StructDocument['blocks'],
): StructDocument {
  const document = characterizationDocument('0.2.0')
  document.blocks = blocks
  document.pages[0]!.blocks = blocks.map((block) => block.id)
  document.pages[0]!.columns[0]!.blockIds = blocks.map((block) => block.id)
  document.receipt.blockCount = blocks.length
  document.receipt.textCharacterCount = blocks.reduce(
    (count, block) => count + block.text.length,
    0,
  )
  document.receipt.conservation.sourceNodeCount = blocks.length
  document.receipt.conservation.accountedSourceNodeCount = blocks.length
  document.receipt.conservation.sourceTextCharacterCount =
    document.receipt.textCharacterCount
  document.receipt.conservation.structBlockCount = blocks.length
  document.receipt.conservation.structTextCharacterCount =
    document.receipt.textCharacterCount
  return resealDocument(document)
}

function idsIn(xhtml: string) {
  return [...xhtml.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]!)
}

function baseBlock(document: StructDocument, id: string, text: string) {
  return { ...document.blocks[0]!, id, text, inline: [] }
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

  it('keeps a table cell distinct from a canonical block with a concatenating ID', async () => {
    const document = characterizationDocument('0.2.0')
    const evidence = document.blocks[0]!.evidence
    const value = derivedIdentityDocument([
      { ...baseBlock(document, 'a-b', 'One'), evidence },
      {
        ...baseBlock(document, 'a', 'Cell'),
        kind: 'table',
        evidence,
        table: {
          rows: 1,
          columns: 1,
          semantic: 'verified',
          cells: [
            {
              id: 'b',
              text: 'Cell',
              row: 0,
              column: 0,
              rowSpan: 1,
              columnSpan: 1,
              headerScope: null,
              inline: [],
              evidence,
            },
          ],
        },
      },
    ])
    const xhtml = renderPublicationXhtml(value)
    const ids = idsIn(xhtml)
    expect(new Set(ids).size).toBe(ids.length)
    await expect(buildStructEpub(value)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
    })
  })

  it('keeps ambiguous table ID tuples distinct', async () => {
    const document = characterizationDocument('0.2.0')
    const evidence = document.blocks[0]!.evidence
    const table = (id: string, cellId: string) => ({
      ...baseBlock(document, id, 'Cell'),
      kind: 'table' as const,
      evidence,
      table: {
        rows: 1,
        columns: 1,
        semantic: 'verified' as const,
        cells: [
          {
            id: cellId,
            text: 'Cell',
            row: 0,
            column: 0,
            rowSpan: 1,
            columnSpan: 1,
            headerScope: null,
            inline: [],
            evidence,
          },
        ],
      },
    })
    const value = derivedIdentityDocument([
      table('a-b', 'c'),
      table('a', 'b-c'),
    ])
    const xhtml = renderPublicationXhtml(value)
    const ids = idsIn(xhtml)
    expect(new Set(ids).size).toBe(ids.length)
    await expect(buildStructEpub(value)).resolves.toMatchObject({
      mediaType: 'application/epub+zip',
    })
  })

  it('preserves unique source-observation anchors as literal evidence IDs', async () => {
    const document = characterizationDocument('0.2.0')
    document.blocks[0]!.sourceObservationAnchorIds = ['source-anchor']
    expect(renderPublicationXhtml(document)).toContain(
      'id="source-anchor" class="visually-hidden source-observation-anchor"',
    )
  })

  it('rejects colliding source-observation anchors instead of emitting duplicate XHTML IDs', async () => {
    const document = characterizationDocument('0.2.0')
    const evidence = document.blocks[0]!.evidence
    const value = derivedIdentityDocument([
      {
        ...baseBlock(document, 'anchor-block', 'One'),
        evidence,
        sourceObservationAnchorIds: ['anchor-block'],
      },
      {
        ...baseBlock(document, 'second-block', 'Two'),
        evidence,
        sourceObservationAnchorIds: ['shared-anchor'],
      },
      {
        ...baseBlock(document, 'third-block', 'Three'),
        evidence,
        sourceObservationAnchorIds: ['shared-anchor'],
      },
    ])
    expect(() => renderPublicationXhtml(value)).toThrow(
      'DUPLICATE_XHTML_SOURCE_ANCHOR',
    )
    await expect(buildStructEpub(value)).rejects.toThrow(
      'DUPLICATE_XHTML_SOURCE_ANCHOR',
    )
  })
})

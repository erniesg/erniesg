import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { decodeStructDocument as packageDecode } from '@erniesg/struct/document'
import { buildStructDocument } from '../src/struct-adapters'
import { encodeStructDocument } from '../src/struct/codec'
import type { DocumentReconstruction } from '../src/research/import-types'
import type { StructBlock, StructDocument } from '@erniesg/struct/document'

/**
 * The reconstruction ingress has to declare the figure -> caption
 * relationship, because the package renderer resolves an attached caption
 * only through a matched `caption` relationship and never by comparing
 * caption text.
 *
 * The fixture is the frozen DOCX reconstruction the parity suite already
 * uses: it carries one figure with a caption block and one table with a
 * caption block, and the figure node declares both captions in
 * `node.relationships.caption`.
 */
const FIXTURE = new URL(
  './fixtures/struct-adapter-parity/reconstructions/structured-docx.json',
  import.meta.url,
)

type FrozenBytes = { $bytes: string }

function decodeReconstruction(text: string): DocumentReconstruction {
  return JSON.parse(text, (_key, value) => {
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as FrozenBytes).$bytes === 'string'
    ) {
      return new Uint8Array(
        Buffer.from((value as FrozenBytes).$bytes, 'base64'),
      )
    }
    return value
  }) as DocumentReconstruction
}

async function structuredDocx(): Promise<DocumentReconstruction> {
  return decodeReconstruction(await readFile(FIXTURE, 'utf8'))
}

/** The block a research node became, addressed by the node's own id. */
function blockForNode(
  document: StructDocument,
  nodeId: string,
): StructBlock {
  const block = document.blocks.find(
    (candidate) => candidate.evidence.sourceIds[0] === nodeId,
  )
  if (!block) throw new Error(`no block carries research node ${nodeId}`)
  return block
}

function figureNode(
  reconstruction: DocumentReconstruction,
  nodeId: string,
): Extract<DocumentReconstruction['paper']['nodes'][number], { type: 'figure' }> {
  const node = reconstruction.paper.nodes.find(
    (candidate) => candidate.id === nodeId,
  )
  if (!node || node.type !== 'figure')
    throw new Error(`fixture figure ${nodeId} is missing`)
  return node
}

const captionRelationships = (document: StructDocument) =>
  document.relationships.filter((relationship) => relationship.kind === 'caption')

describe('reconstruction figure caption relationship', () => {
  it('declares exactly one matched caption relationship for a figure that has a caption', async () => {
    const document = buildStructDocument(await structuredDocx())

    const figure = blockForNode(document, 'fig-docx-0007')
    const caption = blockForNode(document, 'cap-docx-0007')
    expect(figure.kind).toBe('figure')
    expect(caption.kind).toBe('caption')

    const declared = captionRelationships(document).filter(
      (relationship) => relationship.from === figure.id,
    )
    expect(declared).toHaveLength(1)
    expect(declared[0]).toMatchObject({
      kind: 'caption',
      from: figure.id,
      to: [caption.id],
      status: 'matched',
      confidence: 1,
    })
    expect(declared[0]!.id).toMatch(/^struct-relationship-[0-9a-f]{24}$/)
  })

  it('declares the caption relationship for every figure that carries a caption', async () => {
    const document = buildStructDocument(await structuredDocx())

    // The fixture declares two figure captions: the image figure and the
    // semantic table.
    expect(captionRelationships(document)).toHaveLength(2)
    const table = blockForNode(document, 'table-docx-0010')
    const tableCaption = blockForNode(document, 'cap-table-docx-0010')
    expect(table.kind).toBe('table')
    const declared = captionRelationships(document).filter(
      (relationship) => relationship.from === table.id,
    )
    expect(declared).toHaveLength(1)
    expect(declared[0]).toMatchObject({
      kind: 'caption',
      to: [tableCaption.id],
      status: 'matched',
      confidence: 1,
    })
  })

  it('declares a stable, deterministic caption relationship id', async () => {
    const first = buildStructDocument(await structuredDocx())
    const second = buildStructDocument(await structuredDocx())

    expect(captionRelationships(second).map(({ id }) => id)).toEqual(
      captionRelationships(first).map(({ id }) => id),
    )
  })

  it('declares no caption relationship when the caption is not a block of the document', async () => {
    const reconstruction = await structuredDocx()
    figureNode(reconstruction, 'fig-docx-0007').relationships.caption =
      'cap-docx-0007-missing'

    const document = buildStructDocument(reconstruction)

    const figure = blockForNode(document, 'fig-docx-0007')
    expect(
      captionRelationships(document).filter(
        (relationship) => relationship.from === figure.id,
      ),
    ).toHaveLength(0)
    // No relationship may point at the caption that the document lacks.
    expect(
      document.relationships.flatMap((relationship) => relationship.to),
    ).not.toContain('cap-docx-0007-missing')
    // The other figure keeps its own caption.
    expect(captionRelationships(document)).toHaveLength(1)
  })

  it('declares no caption relationship for a figure that declares no caption', async () => {
    const reconstruction = await structuredDocx()
    const figure = figureNode(reconstruction, 'table-docx-0010')
    const { caption: _caption, ...withoutCaption } = figure.relationships
    figure.relationships = withoutCaption as typeof figure.relationships

    const document = buildStructDocument(reconstruction)

    const table = blockForNode(document, 'table-docx-0010')
    expect(
      captionRelationships(document).filter(
        (relationship) => relationship.from === table.id,
      ),
    ).toHaveLength(0)
    expect(captionRelationships(document)).toHaveLength(1)
  })

  it('keeps the caption relationship through the app encode and the pinned package decode', async () => {
    const document = buildStructDocument(await structuredDocx())

    const encoded = encodeStructDocument(document)
    const decoded = packageDecode(encoded)

    const declared = captionRelationships(document)
    const decodedDeclared = decoded.relationships.filter(
      (relationship) => relationship.kind === 'caption',
    )
    expect(decodedDeclared).toHaveLength(declared.length)
    expect(decodedDeclared.map(({ id }) => id).sort()).toEqual(
      declared.map(({ id }) => id).sort(),
    )
    const figure = blockForNode(document, 'fig-docx-0007')
    const caption = blockForNode(document, 'cap-docx-0007')
    const decodedRelationship = decodedDeclared.find(
      (relationship) => relationship.from === figure.id,
    )
    expect(decodedRelationship).toMatchObject({
      kind: 'caption',
      from: figure.id,
      to: [caption.id],
      status: 'matched',
      confidence: 1,
    })
  })

  it('leaves every block and every other relationship unchanged', async () => {
    const withCaptions = buildStructDocument(await structuredDocx())

    const withoutCaptionDeclarations = await structuredDocx()
    for (const node of withoutCaptionDeclarations.paper.nodes) {
      if (node.type !== 'figure') continue
      const { caption: _caption, ...withoutCaption } = node.relationships
      node.relationships = withoutCaption as typeof node.relationships
    }
    const withoutCaptions = buildStructDocument(withoutCaptionDeclarations)

    expect(withoutCaptions.blocks).toEqual(withCaptions.blocks)
    expect(withoutCaptions.relationships).toEqual(
      withCaptions.relationships.filter(
        (relationship) => relationship.kind !== 'caption',
      ),
    )
    expect(withCaptions.relationships.length).toBe(
      withoutCaptions.relationships.length + 2,
    )
    // The receipt still accounts for every relationship the document carries.
    expect(
      withCaptions.receipt.conservation.accountedSourceRelationshipCount,
    ).toBe(withCaptions.relationships.length)
    expect(withCaptions.receipt.conservation.sourceRelationshipCount).toBe(
      withCaptions.relationships.length,
    )
  })
})

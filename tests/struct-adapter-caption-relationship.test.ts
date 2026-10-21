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
 *
 * The package renderer (Struct `e99a92a`) refuses a publication whose
 * attached caption's text DIFFERS from the host block's own trimmed text
 * (`RenderedPublicationPlanError`, code `CONFLICTING_CAPTION`), and the
 * package documents the rule for the app: a matched caption relationship is
 * declared only when the host's own caption text is empty or equal to the
 * caption's text. The rule is checked here against the document the app
 * builds, and the canonical document carries the caption text once, on the
 * caption block that owns it.
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
function blockForNode(document: StructDocument, nodeId: string): StructBlock {
  const block = document.blocks.find(
    (candidate) => candidate.evidence.sourceIds[0] === nodeId,
  )
  if (!block) throw new Error(`no block carries research node ${nodeId}`)
  return block
}

function figureNode(
  reconstruction: DocumentReconstruction,
  nodeId: string,
): Extract<
  DocumentReconstruction['paper']['nodes'][number],
  { type: 'figure' }
> {
  const node = reconstruction.paper.nodes.find(
    (candidate) => candidate.id === nodeId,
  )
  if (!node || node.type !== 'figure')
    throw new Error(`fixture figure ${nodeId} is missing`)
  return node
}

const captionRelationships = (document: StructDocument) =>
  document.relationships.filter(
    (relationship) => relationship.kind === 'caption',
  )

/**
 * The package's own rule, applied to the document the app builds.
 *
 * `Struct` `e99a92a` (`src/renderers/xhtml-plan.ts`) compares the host
 * block's own trimmed text with the attached caption's trimmed text and
 * refuses the publication with `CONFLICTING_CAPTION` when the host's text is
 * non-empty and differs. A host that carries no caption text of its own is
 * not an inconsistency.
 */
function packageCaptionConflicts(
  document: StructDocument,
): Array<{ host: string; caption: string }> {
  const blocks = new Map(document.blocks.map((block) => [block.id, block]))
  const conflicts: Array<{ host: string; caption: string }> = []
  for (const relationship of captionRelationships(document)) {
    if (relationship.status !== 'matched') continue
    const host = blocks.get(relationship.from)
    const caption = blocks.get(relationship.to[0]!)
    if (!host || !caption) continue
    const hostText = host.text.trim()
    const captionText = caption.text.trim()
    if (hostText !== '' && hostText !== captionText)
      conflicts.push({ host: host.id, caption: caption.id })
  }
  return conflicts
}

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

  it('leaves every other block and every other relationship unchanged', async () => {
    const withCaptions = buildStructDocument(await structuredDocx())

    const withoutCaptionDeclarations = await structuredDocx()
    for (const node of withoutCaptionDeclarations.paper.nodes) {
      if (node.type !== 'figure') continue
      const { caption: _caption, ...withoutCaption } = node.relationships
      node.relationships = withoutCaption as typeof node.relationships
    }
    const withoutCaptions = buildStructDocument(withoutCaptionDeclarations)

    // The blocks that are not a caption host are untouched by the rule.
    const hostIds = new Set(
      withCaptions.relationships
        .filter((relationship) => relationship.kind === 'caption')
        .map((relationship) => relationship.from),
    )
    expect(hostIds.size).toBe(2)
    expect(
      withoutCaptions.blocks.filter((block) => !hostIds.has(block.id)),
    ).toEqual(withCaptions.blocks.filter((block) => !hostIds.has(block.id)))
    // The relationships that are not a caption declaration are untouched.
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

  it('keeps the host identity and the caption endpoint of the caption relationship', async () => {
    const document = buildStructDocument(await structuredDocx())

    const figure = blockForNode(document, 'fig-docx-0007')
    const caption = blockForNode(document, 'cap-docx-0007')
    const declared = captionRelationships(document).filter(
      (relationship) => relationship.from === figure.id,
    )
    expect(declared).toHaveLength(1)
    expect(declared[0]!.to).toEqual([caption.id])
    expect(declared[0]!.kind).toBe('caption')
    expect(declared[0]!.status).toBe('matched')
    // The caption block's own text is the authoritative caption text.
    expect(caption.text).toBe('Figure 1. A source-preserved synthetic image.')
  })
})

describe('the host text of a captioned figure', () => {
  it('satisfies the package rule: the host own text is empty or equal to the caption text', async () => {
    const document = buildStructDocument(await structuredDocx())

    for (const relationship of captionRelationships(document)) {
      const host = document.blocks.find(
        (block) => block.id === relationship.from,
      )!
      const caption = document.blocks.find(
        (block) => block.id === relationship.to[0]!,
      )!
      const hostText = host.text.trim()
      expect(hostText === '' || hostText === caption.text.trim()).toBe(true)
    }
    // The package's own conflict check finds nothing to refuse.
    expect(packageCaptionConflicts(document)).toEqual([])
  })

  it('carries the caption text once, in the caption block', async () => {
    const document = buildStructDocument(await structuredDocx())

    const caption = blockForNode(document, 'cap-docx-0007')
    const figure = blockForNode(document, 'fig-docx-0007')

    // The caption text is the text of exactly one block: the caption block.
    const carriers = document.blocks.filter(
      (block) => block.text.trim() === caption.text.trim(),
    )
    expect(carriers.map(({ id }) => id)).toEqual([caption.id])
    // The host block carries no copy of the caption text as its own text.
    expect(figure.text).toBe('')
    expect(figure.text).not.toContain(caption.text)
    // The host keeps its own label: the package publishes the label as the
    // host's alt text, so the figure keeps its own alt text.
    expect(figure.label).toBe('Figure 1. A source-preserved synthetic image.')
  })

  it('keeps the table caption text once, in the table caption block', async () => {
    const document = buildStructDocument(await structuredDocx())

    const table = blockForNode(document, 'table-docx-0010')
    const caption = blockForNode(document, 'cap-table-docx-0010')
    const carriers = document.blocks.filter(
      (block) => block.text.trim() === caption.text.trim(),
    )
    expect(carriers.map(({ id }) => id)).toEqual([caption.id])
    expect(table.text).toBe('')
  })

  it('keeps a genuinely different own description as the host own label, not as caption text', async () => {
    const reconstruction = await structuredDocx()
    const figure = figureNode(reconstruction, 'fig-docx-0007')
    // The source carries a real figure description of its own.
    figure.sourceText = 'A photograph of the apparatus standing on the bench.'

    const document = buildStructDocument(reconstruction)

    const host = blockForNode(document, 'fig-docx-0007')
    const caption = blockForNode(document, 'cap-docx-0007')
    // The description is not the caption text, so it is not carried as the
    // host's own text: the host's own text is the caption's business.
    expect(host.text).toBe('')
    // The description is the host's own label, the field the package
    // publishes as the host's alt text, so nothing is lost.
    expect(host.label).toBe(
      'A photograph of the apparatus standing on the bench.',
    )
    // The caption text is still carried once, by the caption block.
    expect(caption.text).toBe('Figure 1. A source-preserved synthetic image.')
    expect(
      document.blocks
        .filter((block) => block.text.trim() === caption.text.trim())
        .map(({ id }) => id),
    ).toEqual([caption.id])
    // The document the package renders is not one it would refuse.
    expect(packageCaptionConflicts(document)).toEqual([])
    expect(() => packageDecode(encodeStructDocument(document))).not.toThrow()
  })

  it('keeps the receipt counts equal to the text the document carries', async () => {
    const document = buildStructDocument(await structuredDocx())

    const blockText = document.blocks.reduce(
      (count, block) => count + block.text.length,
      0,
    )
    expect(document.receipt.textCharacterCount).toBe(blockText)
    expect(document.receipt.conservation.sourceTextCharacterCount).toBe(
      blockText,
    )
    expect(document.receipt.conservation.structTextCharacterCount).toBe(
      blockText,
    )
    // The pinned package validates the same receipt binding.
    expect(() => packageDecode(encodeStructDocument(document))).not.toThrow()
  })
})

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { buildStructDocument } from '../src/struct-adapters'
import { decodeReconstruction } from './fixtures/struct-adapter-parity/observe'
import { encodeStructDocument } from '../src/struct/codec'
import { decodeStructDocument as packageDecode } from '@erniesg/struct/document'

async function loadBase() {
  const text = await readFile(
    new URL(
      './fixtures/struct-adapter-parity/reconstructions/ordinary-pdf.json',
      import.meta.url,
    ),
    'utf8',
  )
  return decodeReconstruction(text) as any
}

describe('mapped PDF hyperlink annotation accounting', () => {
  it('counts a mapped hyperlink annotation exactly once', async () => {
    const recon = await loadBase()
    const node = recon.paper.nodes[0]
    const prov = recon.provenance[node.id]

    const annotationId = 'ann-mapped-1'
    node.inlineRuns = [
      {
        start: 0,
        end: node.text.length,
        href: 'https://example.com/mapped',
        annotationId,
      },
    ]
    prov.links = [
      {
        id: annotationId,
        page: 1,
        status: 'external',
        url: 'https://example.com/mapped',
        box: prov.boxes[0],
      },
    ]

    const document = buildStructDocument(recon)
    const conservation = document.receipt.conservation

    expect(conservation.accountedSourceRelationshipCount).toBe(
      document.relationships.length,
    )
    expect(conservation.sourceRelationshipCount).toBe(
      document.relationships.length,
    )
    expect(() => encodeStructDocument(document)).not.toThrow()
    expect(() => packageDecode(encodeStructDocument(document))).not.toThrow()
  })

  it('still counts an unmapped provenance annotation link exactly once', async () => {
    const recon = await loadBase()
    const node = recon.paper.nodes[0]
    const prov = recon.provenance[node.id]

    const annotationId = 'ann-unmapped-1'
    prov.links = [
      {
        id: annotationId,
        page: 1,
        status: 'external',
        url: 'https://example.com/unmapped',
        box: prov.boxes[0],
      },
    ]

    const document = buildStructDocument(recon)
    const conservation = document.receipt.conservation

    expect(conservation.accountedSourceRelationshipCount).toBe(
      document.relationships.length,
    )
    expect(conservation.sourceRelationshipCount).toBe(
      document.relationships.length,
    )
    expect(() => encodeStructDocument(document)).not.toThrow()
    expect(
      document.relationships.some((relationship) =>
        relationship.evidence.sourceIds.includes(annotationId),
      ),
    ).toBe(true)
  })
})
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { buildStructDocument } from '../src/struct-adapters'
import { decodeReconstruction } from './fixtures/struct-adapter-parity/observe'
import { encodeStructDocument } from '../src/struct/codec'
import {
  decodeStructDocument as packageDecode,
  encodeStructDocument as packageEncode,
} from '@erniesg/struct/document'

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

/**
 * A PDF annotation that the source already renders inline: the provenance link
 * and the inline run carry the same annotation id.
 */
function mapInlineAnnotation(
  recon: any,
  annotationId: string,
  href: string,
  semanticRole?: 'citation' | 'cross-reference' | 'note-reference',
) {
  const node = recon.paper.nodes[0]
  const prov = recon.provenance[node.id]
  node.inlineRuns = [
    {
      start: 0,
      end: node.text.length,
      href,
      annotationId,
      ...(semanticRole ? { semanticRole } : {}),
    },
  ]
  prov.links = [
    {
      id: annotationId,
      page: 1,
      status: 'external',
      url: href,
      box: prov.boxes[0],
    },
  ]
  return { node, prov }
}

describe('mapped PDF hyperlink annotation accounting', () => {
  it('counts a mapped hyperlink annotation exactly once', async () => {
    const recon = await loadBase()
    const annotationId = 'ann-mapped-1'
    mapInlineAnnotation(recon, annotationId, 'https://example.com/mapped')

    const document = buildStructDocument(recon)
    const conservation = document.receipt.conservation

    // The mapped annotation is emitted as ONE relationship: the inline one.
    const carrying = document.relationships.filter((relationship) =>
      relationship.evidence.sourceIds.includes(annotationId),
    )
    expect(carrying).toHaveLength(1)
    expect(carrying[0]!.kind).toBe('hyperlink')

    // The SOURCE annotation count stays raw: the annotation still exists in
    // `provenance[node.id].links`, so it is not removed from the count.
    expect(conservation.sourceAnnotationCount).toBe(1)
    // The ACCOUNTED annotation count excludes it: it was accounted as an
    // inline relationship, not as an annotation relationship.
    expect(conservation.accountedSourceAnnotationCount).toBe(0)

    // The source relationship total counts DISTINCT source relationships: the
    // mapped annotation is ONE source relationship (the provenance link and the
    // inline run are two representations of it), so the source has 3
    // relationships - 2 reading-order relationships plus the hyperlink.
    expect(conservation.sourceRelationshipCount).toBe(3)
    // ... and the accounted relationship count is what the document emitted.
    expect(conservation.accountedSourceRelationshipCount).toBe(
      document.relationships.length,
    )
    expect(conservation.accountedSourceRelationshipCount).toBe(3)
    // The source total and the emitted total agree: nothing was dropped.
    expect(conservation.sourceRelationshipCount).toBe(
      document.relationships.length,
    )
    expect(conservation.sourceRelationshipCount).toBe(
      conservation.accountedSourceRelationshipCount,
    )
    // The gap is the number of DROPPED source relationships, so a correctly
    // emitted mapped annotation leaves no gap at all.
    expect(conservation.sourceRelationshipCount).toBe(
      conservation.accountedSourceRelationshipCount,
    )

    // The package invariant holds with these numbers.
    expect(conservation.accountedSourceAnnotationCount).toBeLessThanOrEqual(
      conservation.sourceAnnotationCount,
    )
    expect(conservation.accountedSourceRelationshipCount).toBeLessThanOrEqual(
      conservation.sourceRelationshipCount,
    )
    expect(conservation.accountedSourceRelationshipCount).toBe(
      document.relationships.length,
    )

    // The codec accepts the mapped-hyperlink document.
    expect(() => encodeStructDocument(document)).not.toThrow()
    expect(() => packageDecode(packageEncode(document))).not.toThrow()
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
    // An unmapped annotation is both raw and accounted: it is emitted as an
    // annotation relationship of its own.
    expect(conservation.sourceAnnotationCount).toBe(1)
    expect(conservation.accountedSourceAnnotationCount).toBe(1)
    expect(() => encodeStructDocument(document)).not.toThrow()
    expect(
      document.relationships.some((relationship) =>
        relationship.evidence.sourceIds.includes(annotationId),
      ),
    ).toBe(true)
  })

  it('reports a dropped annotation instead of absorbing it', async () => {
    const recon = await loadBase()
    const annotationId = 'ann-dropped-1'
    // The annotation is mapped to an inline run the adapter does not publish
    // (a citation-role run), so no relationship carries it: the annotation is
    // dropped, and the conservation must say so.
    mapInlineAnnotation(
      recon,
      annotationId,
      'https://example.com/dropped',
      'citation',
    )

    const document = buildStructDocument(recon)
    const conservation = document.receipt.conservation

    expect(
      document.relationships.some((relationship) =>
        relationship.evidence.sourceIds.includes(annotationId),
      ),
    ).toBe(false)

    // The source still has the annotation: the raw count keeps it.
    expect(conservation.sourceAnnotationCount).toBe(1)
    expect(conservation.accountedSourceAnnotationCount).toBe(0)
    // The dropped annotation leaves a visible gap between the raw source
    // relationship total and the relationships the document emitted. The
    // source still has 3 relationships - the mapped annotation was a source
    // relationship even though its inline run was skipped for emission - and
    // the document emitted 2, so exactly ONE source relationship was dropped.
    expect(conservation.sourceRelationshipCount).toBe(3)
    expect(conservation.accountedSourceRelationshipCount).toBe(
      document.relationships.length,
    )
    expect(conservation.accountedSourceRelationshipCount).toBe(2)
    expect(conservation.sourceRelationshipCount).toBeGreaterThan(
      conservation.accountedSourceRelationshipCount,
    )
    expect(
      conservation.sourceRelationshipCount -
        conservation.accountedSourceRelationshipCount,
    ).toBe(1)

    // The package still accepts the document: the accounted counts describe
    // what was emitted, so they never exceed the source counts.
    expect(() => encodeStructDocument(document)).not.toThrow()
    expect(() => packageDecode(packageEncode(document))).not.toThrow()
  })

  it('reports equal raw and accounted counts for a plain document', async () => {
    const recon = await loadBase()

    const document = buildStructDocument(recon)
    const conservation = document.receipt.conservation

    expect(conservation.sourceAnnotationCount).toBe(0)
    expect(conservation.accountedSourceAnnotationCount).toBe(0)
    expect(conservation.sourceRelationshipCount).toBe(
      document.relationships.length,
    )
    expect(conservation.accountedSourceRelationshipCount).toBe(
      document.relationships.length,
    )
    expect(() => encodeStructDocument(document)).not.toThrow()
    expect(() => packageDecode(packageEncode(document))).not.toThrow()
  })

  it('keeps the gap discriminating between a mapped and a dropped annotation', async () => {
    // The plain source: 2 relationships.
    const plain = buildStructDocument(await loadBase())
    const plainConservation = plain.receipt.conservation

    // The mapped source: the annotation produced a relationship, so the source
    // gained exactly ONE distinct relationship and the document emitted it.
    const mappedRecon = await loadBase()
    mapInlineAnnotation(
      mappedRecon,
      'ann-mapped-gap',
      'https://example.com/mapped-gap',
    )
    const mapped = buildStructDocument(mappedRecon)
    const mappedConservation = mapped.receipt.conservation

    // The dropped source: the annotation is the SAME source relationship, but
    // its inline run is skipped for emission, so the document dropped it.
    const droppedRecon = await loadBase()
    mapInlineAnnotation(
      droppedRecon,
      'ann-dropped-gap',
      'https://example.com/dropped-gap',
      'citation',
    )
    const dropped = buildStructDocument(droppedRecon)
    const droppedConservation = dropped.receipt.conservation

    // Both annotated sources have the SAME source total: one more distinct
    // source relationship than the plain source.
    expect(mappedConservation.sourceRelationshipCount).toBe(
      plainConservation.sourceRelationshipCount + 1,
    )
    expect(droppedConservation.sourceRelationshipCount).toBe(
      plainConservation.sourceRelationshipCount + 1,
    )
    expect(mappedConservation.sourceRelationshipCount).toBe(
      droppedConservation.sourceRelationshipCount,
    )

    // But only the dropped source has a gap: the gap is the number of source
    // relationships the document did not emit.
    expect(
      mappedConservation.sourceRelationshipCount -
        mappedConservation.accountedSourceRelationshipCount,
    ).toBe(0)
    expect(
      droppedConservation.sourceRelationshipCount -
        droppedConservation.accountedSourceRelationshipCount,
    ).toBe(1)

    // The gap is the ONLY difference between the two accounted totals.
    expect(mappedConservation.accountedSourceRelationshipCount).toBe(
      droppedConservation.accountedSourceRelationshipCount + 1,
    )
    expect(mappedConservation.accountedSourceRelationshipCount).toBe(
      mapped.relationships.length,
    )
    expect(droppedConservation.accountedSourceRelationshipCount).toBe(
      dropped.relationships.length,
    )
  })
})

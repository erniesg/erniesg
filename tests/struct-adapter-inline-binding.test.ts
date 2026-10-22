import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { buildStructDocument } from '../src/struct-adapters'
import { decodeReconstruction } from './fixtures/struct-adapter-parity/observe'
import { adaptStructDocument } from '../src/publication/struct-adapter'
import { structId } from '../src/struct/ids'

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
 * and the inline run carry the same annotation id. The run can also carry a
 * source-supplied relationship id, which the adapter must reconcile with the
 * relationship it emits.
 */
function mapInlineAnnotation(
  recon: any,
  annotationId: string,
  href: string,
  options: {
    relationshipId?: string
    semanticRole?: 'citation' | 'cross-reference' | 'note-reference'
  } = {},
) {
  const node = recon.paper.nodes[0]
  const prov = recon.provenance[node.id]
  node.inlineRuns = [
    {
      start: 0,
      end: node.text.length,
      href,
      annotationId,
      ...(options.relationshipId
        ? { relationshipId: options.relationshipId }
        : {}),
      ...(options.semanticRole ? { semanticRole: options.semanticRole } : {}),
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

const inlineRunsOf = (document: any, annotationId: string) =>
  document.blocks
    .flatMap((block: any) => block.inline)
    .filter((inline: any) => inline.annotationId === annotationId)

const ownerOf = (document: any, inline: any) =>
  document.blocks.find((block: any) => block.inline.includes(inline))

describe('inline hyperlink relationship binding', () => {
  it('binds an emitted hyperlink to a run that supplied no relationship id', async () => {
    const recon = await loadBase()
    const annotationId = 'ann-mapped-1'
    const href = 'https://example.com/mapped'
    mapInlineAnnotation(recon, annotationId, href)

    const document = buildStructDocument(recon)
    const runs = inlineRunsOf(document, annotationId)
    expect(runs).toHaveLength(1)
    const run = runs[0]!

    // The adapter emits a hyperlink relationship for this run, so the run
    // must be bound to it: the relationship exists and the run points at it.
    const hyperlink = document.relationships.find(
      (relationship: any) => relationship.kind === 'hyperlink',
    )
    expect(hyperlink).toBeDefined()
    expect(run.relationshipId).toBe(hyperlink!.id)

    // The generated id derivation is unchanged: the binding uses exactly the
    // id the adapter derives for this block, index and href.
    const owner = ownerOf(document, run)!
    expect(run.relationshipId).toBe(
      structId('relationship', `hyperlink:${owner.id}:0:${href}`),
    )
  })

  it('stops reporting a bound hyperlink as an unprojected relationship', async () => {
    const recon = await loadBase()
    const annotationId = 'ann-mapped-1'
    mapInlineAnnotation(recon, annotationId, 'https://example.com/mapped')

    const document = buildStructDocument(recon)
    const result = adaptStructDocument(document)
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code)

    // The relationship appears inline, so it is not an unprojected one and
    // the misleading "was not projected as a link" warning must be gone.
    expect(
      result.diagnostics.filter((diagnostic) =>
        diagnostic.message.includes('was not projected as a link'),
      ),
    ).toEqual([])
    expect(codes).not.toContain('source-preserved-hyperlink')
    // The binding is not dangling either: the run's id resolves.
    expect(codes).not.toContain('unresolved-relationship')
  })

  it('keeps a source-supplied relationship id consistent with the emitted relationship', async () => {
    const recon = await loadBase()
    const annotationId = 'ann-mapped-1'
    const href = 'https://example.com/supplied'
    mapInlineAnnotation(recon, annotationId, href, {
      relationshipId: 'source-supplied-rel',
    })

    const document = buildStructDocument(recon)
    const runs = inlineRunsOf(document, annotationId)
    expect(runs).toHaveLength(1)
    const run = runs[0]!

    const hyperlink = document.relationships.find(
      (relationship: any) => relationship.kind === 'hyperlink',
    )
    expect(hyperlink).toBeDefined()
    // The run and the emitted relationship agree on ONE id.
    expect(run.relationshipId).toBe(hyperlink!.id)
    // The source-supplied id is not carried into the document: the emitted
    // relationship owns the id, so the two can never silently disagree.
    expect(run.relationshipId).not.toBe('source-supplied-rel')
    expect(
      document.relationships.some(
        (relationship: any) => relationship.id === 'source-supplied-rel',
      ),
    ).toBe(false)

    const result = adaptStructDocument(document)
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code)
    expect(codes).not.toContain('unresolved-relationship')
    expect(codes).not.toContain('source-preserved-hyperlink')
  })

  it('leaves a skipped role run unbound and unemitted', async () => {
    const recon = await loadBase()
    const annotationId = 'ann-dropped-1'
    mapInlineAnnotation(recon, annotationId, 'https://example.com/dropped', {
      semanticRole: 'citation',
    })

    const document = buildStructDocument(recon)
    const runs = inlineRunsOf(document, annotationId)
    expect(runs).toHaveLength(1)
    // The role run is skipped for emission, so nothing is bound to it.
    expect(runs[0]!.relationshipId).toBeUndefined()
    expect(
      document.relationships.filter(
        (relationship: any) => relationship.kind === 'hyperlink',
      ),
    ).toHaveLength(0)
  })

  it('leaves a run with neither href nor targetIds unbound', async () => {
    const recon = await loadBase()
    const node = recon.paper.nodes[0]
    node.inlineRuns = [{ start: 0, end: node.text.length }]

    const document = buildStructDocument(recon)
    const run = document.blocks
      .flatMap((block: any) => block.inline)
      .find((inline: any) => inline.start === 0 && inline.end === node.text.length)
    expect(run).toBeDefined()
    expect(run!.relationshipId).toBeUndefined()
    expect(
      document.relationships.filter(
        (relationship: any) => relationship.kind === 'hyperlink',
      ),
    ).toHaveLength(0)
  })

  it('keeps the mapped-annotation conservation accounting exactly as it was', async () => {
    const recon = await loadBase()
    const annotationId = 'ann-mapped-1'
    mapInlineAnnotation(recon, annotationId, 'https://example.com/mapped')

    const document = buildStructDocument(recon)
    const conservation = document.receipt.conservation

    // The emitted-annotation set is unchanged: exactly one relationship
    // carries the mapped annotation, and it is the inline hyperlink.
    const carrying = document.relationships.filter((relationship: any) =>
      relationship.evidence.sourceIds.includes(annotationId),
    )
    expect(carrying).toHaveLength(1)
    expect(carrying[0]!.kind).toBe('hyperlink')
    expect(
      document.relationships.flatMap((relationship: any) =>
        relationship.evidence.sourceIds.filter((id: string) =>
          id.startsWith('ann-'),
        ),
      ),
    ).toEqual([annotationId])

    // The source and accounted counts are exactly as measured at the base.
    expect(conservation.sourceAnnotationCount).toBe(1)
    expect(conservation.accountedSourceAnnotationCount).toBe(0)
    expect(conservation.sourceRelationshipCount).toBe(3)
    expect(conservation.accountedSourceRelationshipCount).toBe(3)
    expect(conservation.accountedSourceRelationshipCount).toBe(
      document.relationships.length,
    )
    expect(conservation.sourceRelationshipCount).toBe(
      conservation.accountedSourceRelationshipCount,
    )
  })
})

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { strFromU8 } from 'fflate'
import { beforeAll, describe, expect, it } from 'vitest'
import { fixtureFile } from '../../tests/fixtures/pdf-fixtures'
import fixtureManifest from '../../tests/fixtures/pdf/manifest.json'
import { buildEpub, buildReadableEpub, inspectEpub } from './epub'
import type { PdfReconstruction } from './import-types'
import { reconstructPdf } from './pdf'

const FIXTURE = 'table-citation-crop.pdf'
const TABLE_LINES = [
  'Metric name | Baseline | Calibrated | Evidence',
  'Readability score | 71 | 82 | [1]',
  'Diagram fidelity | 68 | 91 | [2]',
  'Equation fidelity | 70 | 93 | [1-2]',
  'Table continuity | 73 | 95 | Verified',
  'Aggregate result | 71 | 90 | Stable',
] as const
const TABLE_TRANSCRIPT = TABLE_LINES.join(' ')

describe('raw PDF source-backed table citation regression', () => {
  let sourceBytes: Uint8Array
  let reconstruction: PdfReconstruction
  let repeated: PdfReconstruction

  beforeAll(async () => {
    ;[sourceBytes, reconstruction, repeated] = await Promise.all([
      readFile(new URL(`../../tests/fixtures/pdf/${FIXTURE}`, import.meta.url)),
      reconstructPdf(await fixtureFile(FIXTURE)),
      reconstructPdf(await fixtureFile(FIXTURE)),
    ])
  }, 30_000)

  it('is a frozen repository-owned source fixture', () => {
    const manifestEntry = fixtureManifest.fixtures.find(
      (entry) => entry.file === FIXTURE,
    )

    expect(fixtureManifest.license).toBe('CC0-1.0')
    expect(createHash('sha256').update(sourceBytes).digest('hex')).toBe(
      manifestEntry && 'sha256' in manifestEntry
        ? manifestEntry.sha256
        : undefined,
    )
    expect(repeated.visualRelationships).toEqual(
      reconstruction.visualRelationships,
    )
    expect(repeated.citationRelationships).toEqual(
      reconstruction.citationRelationships,
    )
    expect(repeated.paper.nodes).toEqual(reconstruction.paper.nodes)
  })

  it('assigns exact table citation spans to one canonical crop owner', () => {
    const relationship = reconstruction.visualRelationships.find(
      (candidate) => candidate.kind === 'table',
    )
    const table = reconstruction.paper.nodes.find(
      (node) => node.type === 'figure' && node.objectType === 'table',
    )
    const tableSourceText =
      table?.type === 'figure' ? table.sourceText : undefined
    const asset = reconstruction.assets.find((candidate) =>
      relationship?.assetIds.includes(candidate.id),
    )
    const citations = reconstruction.citationRelationships.filter(
      (citation) => citation.sourceBoxes[0]?.page === 1,
    )

    expect(relationship).toMatchObject({
      kind: 'table',
      status: 'matched',
      canonicalNodeId: table?.id,
      sourceText: TABLE_TRANSCRIPT,
      sourceLineIds: expect.arrayContaining(
        TABLE_LINES.map(() => expect.stringMatching(/-line-/)),
      ),
      evidence: expect.arrayContaining([
        'caption-bounded-scope',
        'contiguous-single-anchor-slab',
        'non-semantic-source-scope',
        'source-page-crop',
      ]),
    })
    expect(relationship?.sourceLineIds).toHaveLength(TABLE_LINES.length)
    expect(asset).toMatchObject({
      kind: 'table',
      rendition: 'source-page-crop',
      sourceObjectIds: [expect.stringMatching(/^table-scope-source:/)],
    })
    expect(table).toMatchObject({
      type: 'figure',
      objectType: 'table',
      sourceText: TABLE_TRANSCRIPT,
      inlineRuns: expect.arrayContaining([
        expect.objectContaining({ semanticRole: 'citation' }),
      ]),
    })
    expect(table && 'table' in table ? table.table : undefined).toBeUndefined()
    expect(citations).toHaveLength(3)
    expect(
      citations.map((citation) => ({
        labels: citation.labels,
        status: citation.status,
        targets: citation.targetNodeIds.length,
        nodeId: citation.canonicalAnchor?.nodeId,
        text:
          tableSourceText && citation.canonicalAnchor
            ? tableSourceText.slice(
                citation.canonicalAnchor.start,
                citation.canonicalAnchor.end,
              )
            : undefined,
      })),
    ).toEqual([
      {
        labels: ['1'],
        status: 'matched',
        targets: 1,
        nodeId: table?.id,
        text: '[1]',
      },
      {
        labels: ['2'],
        status: 'matched',
        targets: 1,
        nodeId: table?.id,
        text: '[2]',
      },
      {
        labels: ['1', '2'],
        status: 'matched',
        targets: 2,
        nodeId: table?.id,
        text: '[1-2]',
      },
    ])
    expect(
      reconstruction.diagnostics.filter((diagnostic) =>
        [
          'UNMAPPED_CITATION_ANCHOR',
          'UNRESOLVED_CITATION_REFERENCE',
          'UNRESOLVED_VISUAL_OBJECT',
        ].includes(diagnostic.code),
      ),
    ).toEqual([])
    expect(reconstruction.completeness).toMatchObject({
      inlineSpanCoverage: 1,
      expectedSemanticTableCount: 1,
      resolvedSemanticTableCount: 0,
      semanticTableCoverage: 0,
      unresolvedObjects: { citations: 0, tables: 0 },
    })
    expect(reconstruction.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNRESOLVED_FRONT_MATTER',
      ]),
    })
    expect(reconstruction.readiness.blockingDiagnosticCodes).not.toContain(
      'UNRESOLVED_SEMANTIC_OBJECTS',
    )
  })

  it('blocks publication export while preserving the complete source crop in the readable fallback', async () => {
    const table = reconstruction.paper.nodes.find(
      (node) => node.type === 'figure' && node.objectType === 'table',
    )
    const prose = reconstruction.paper.nodes.flatMap((node) =>
      'text' in node ? [node.text] : [],
    )

    for (const line of TABLE_LINES) {
      expect(prose.some((text) => text.includes(line))).toBe(false)
    }
    expect(
      reconstruction.paper.nodes.filter(
        (node) =>
          node.type === 'figure' && node.sourceText === TABLE_TRANSCRIPT,
      ),
    ).toHaveLength(1)

    await expect(
      buildEpub(reconstruction.paper, reconstruction),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_RECONSTRUCTION' })
    const epub = await buildReadableEpub(reconstruction.paper, reconstruction)
    const inspected = inspectEpub(epub.bytes)
    const xhtml = strFromU8(inspected.files['EPUB/content.xhtml'])
    const bibliorefs = [...xhtml.matchAll(/<a\b[^>]*epub:type="biblioref"/gu)]

    expect(xhtml).toContain(
      'class="visually-hidden visual-source-transcript"',
    )
    expect(xhtml).toContain('Aggregate result | 71 | 90 | Stable')
    expect(xhtml).not.toMatch(/<p\b[^>]*>[^<]*Readability score/gu)
    expect(xhtml).not.toContain('<table')
    expect(bibliorefs).toHaveLength(4)
    expect(xhtml).toContain(`data-canonical-id="${table?.id}"`)
  })
})

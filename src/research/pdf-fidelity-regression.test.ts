import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { strFromU8 } from 'fflate'
import { beforeAll, describe, expect, it } from 'vitest'
import contract from '../../tests/fixtures/pdf/pdf-to-epub-fidelity.contract.json'
import fixtureManifest from '../../tests/fixtures/pdf/manifest.json'
import {
  buildEpub,
  buildReadableEpub,
  inspectEpub,
  projectReadableFallbackReconstruction,
  type EpubExport,
} from './epub'
import type { PdfReconstruction } from './import-types'
import { reconstructPdf } from './pdf'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import { getTargetProfile } from './targets'

const fixtureUrl = new URL(
  '../../tests/fixtures/pdf/pdf-to-epub-fidelity.pdf',
  import.meta.url,
)
const contractUrl = new URL(
  '../../tests/fixtures/pdf/pdf-to-epub-fidelity.contract.json',
  import.meta.url,
)

type ContractInline = (typeof contract.inlineSemantics)[number]
type ExtendedInlineRun = {
  start: number
  end: number
  bold?: boolean
  italic?: boolean
  href?: string
  verticalAlign?: 'superscript' | 'subscript'
  relationshipId?: string
}

function normalized(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function textOf(node: PdfReconstruction['paper']['nodes'][number]) {
  return 'text' in node ? normalized(node.text) : ''
}

function countExact(values: readonly string[], expected: string) {
  return values.filter((value) => value === expected).length
}

function occurrences(value: string, expected: string) {
  let count = 0
  let cursor = 0
  while ((cursor = value.indexOf(expected, cursor)) !== -1) {
    count += 1
    cursor += expected.length
  }
  return count
}

function inlineRunFor(
  reconstruction: PdfReconstruction,
  expected: ContractInline,
) {
  const node = reconstruction.paper.nodes.find(
    (candidate) =>
      'text' in candidate &&
      normalized(candidate.text).includes(expected.container),
  )
  if (!node || !('text' in node)) return undefined
  const start = node.text.indexOf(expected.text)
  if (start < 0) return undefined
  const runs =
    'inlineRuns' in node
      ? ((node.inlineRuns ?? []) as ExtendedInlineRun[])
      : ([] as ExtendedInlineRun[])
  return runs.find(
    (run) => run.start <= start && run.end >= start + expected.text.length,
  )
}

function assetMetadata(reconstruction: PdfReconstruction) {
  return reconstruction.assets.map(({ bytes: _bytes, ...asset }) => asset)
}

describe('integrated PDF-to-EPUB fidelity fixture', () => {
  let sourceBytes: Uint8Array
  let contractBytes: Uint8Array
  let reconstruction: PdfReconstruction
  let repeated: PdfReconstruction
  let exports: Record<string, [EpubExport, EpubExport]>

  beforeAll(async () => {
    ;[sourceBytes, contractBytes] = await Promise.all(
      [fixtureUrl, contractUrl].map(
        async (url) => new Uint8Array(await readFile(url)),
      ),
    )
    const file = () =>
      new File([sourceBytes as BlobPart], contract.fixture, {
        type: 'application/pdf',
        lastModified: Date.UTC(2026, 6, 20),
      })
    ;[reconstruction, repeated] = await Promise.all([
      reconstructPdf(file()),
      reconstructPdf(file()),
    ])
    exports = Object.fromEntries(
      await Promise.all(
        contract.profiles.map(async ({ id }) => {
          const profile = getTargetProfile(
            id as 'mobile' | 'paperProMove' | 'paperPro',
          )
          return [
            id,
            await Promise.all([
              buildEpub(reconstruction.paper, reconstruction, profile),
              buildEpub(reconstruction.paper, reconstruction, profile),
            ]),
          ] as const
        }),
      ),
    )
  }, 60_000)

  it('is a frozen, redistributable source with deterministic reconstruction evidence', () => {
    const manifestEntry = fixtureManifest.fixtures.find(
      (entry) => entry.file === contract.fixture,
    )
    expect(fixtureManifest.license).toBe(contract.license)
    expect(manifestEntry).toMatchObject({ sha256: contract.sourceSha256 })
    expect(
      manifestEntry && 'contractSha256' in manifestEntry
        ? manifestEntry.contractSha256
        : undefined,
    ).toBe(createHash('sha256').update(contractBytes).digest('hex'))
    expect(createHash('sha256').update(sourceBytes).digest('hex')).toBe(
      contract.sourceSha256,
    )
    expect(reconstruction.source.sha256).toBe(contract.sourceSha256)
    expect(reconstruction.source.fileName).toBe(contract.fixture)
    expect(reconstruction.paper).toEqual(repeated.paper)
    expect(reconstruction.readingOrder).toEqual(repeated.readingOrder)
    expect(reconstruction.noteRelationships).toEqual(repeated.noteRelationships)
    expect(reconstruction.visualRelationships).toEqual(
      repeated.visualRelationships,
    )
    expect(assetMetadata(reconstruction)).toEqual(assetMetadata(repeated))

    const eligibleTransitions = reconstruction.regions.reduce(
      (total, region) => total + Math.max(0, region.lines.length - 1),
      0,
    )
    expect(reconstruction.lineBoundaryDecisions).toHaveLength(
      eligibleTransitions,
    )
    expect(reconstruction.lineBoundaryDecisions.length).toBeGreaterThan(0)
    expect(reconstruction.unresolvedCorruptingJoinCount).toBe(0)
    expect(reconstruction.completeness.unresolvedCorruptingJoinCount).toBe(
      reconstruction.unresolvedCorruptingJoinCount,
    )
    expect(
      reconstruction.completeness.structurallyConsumedLineBoundaryCount,
    ).toBe(reconstruction.structurallyConsumedLineBoundaryCount)
    expect(
      reconstruction.lineBoundaryDecisions.filter((decision) =>
        ['unresolved', 'structural-boundary'].includes(decision.outcome),
      ),
    ).toHaveLength(
      reconstruction.unresolvedCorruptingJoinCount +
        reconstruction.structurallyConsumedLineBoundaryCount,
    )
    expect(reconstruction.lineBoundaryDecisions).toEqual(
      repeated.lineBoundaryDecisions,
    )
    const regions = new Map(
      reconstruction.regions.map((region) => [region.id, region]),
    )
    for (const decision of reconstruction.lineBoundaryDecisions) {
      const region = regions.get(decision.regionId)
      expect(region).toBeDefined()
      const lineIds = region?.lines.map((line) => line.id) ?? []
      const from = lineIds.indexOf(decision.fromLineId)
      expect(from).toBeGreaterThanOrEqual(0)
      expect(lineIds[from + 1]).toBe(decision.toLineId)
    }
  })

  it('keeps one full title and every canonical prose span exactly once in source order', () => {
    const nodeTexts = reconstruction.paper.nodes.map(textOf)
    expect(reconstruction.paper.title).toBe(contract.title)
    expect(reconstruction.paper.authors).toEqual(contract.authors)
    expect(countExact(nodeTexts, contract.title)).toBe(0)
    expect(
      reconstruction.paper.nodes.filter(
        (node) => textOf(node) === contract.title && node.type === 'heading',
      ),
    ).toHaveLength(0)

    let previousIndex = -1
    for (const span of contract.canonicalSpans) {
      const indexes = reconstruction.paper.nodes.flatMap((node, index) =>
        node.type === span.kind && textOf(node) === span.text ? [index] : [],
      )
      expect(indexes, `canonical span: ${span.text}`).toHaveLength(1)
      expect(indexes[0], `source order: ${span.text}`).toBeGreaterThan(
        previousIndex,
      )
      previousIndex = indexes[0]
    }

    const allProse = nodeTexts.join('\n')
    expect(allProse).not.toContain('discre-tionary')
    expect(allProse).toContain('state-of-the-art')
    expect(
      reconstruction.paper.nodes.filter(
        (node) => node.type === 'paragraph' && /^[A-Za-z]$/.test(textOf(node)),
      ),
    ).toEqual([])
  })

  it('preserves section hierarchy, typed nested lists, references, and a linked note', () => {
    for (const expected of contract.headings) {
      expect(
        reconstruction.paper.nodes.filter(
          (node) =>
            node.type === 'heading' &&
            textOf(node) === expected.text &&
            node.level === expected.level,
        ),
        `heading ${expected.level}: ${expected.text}`,
      ).toHaveLength(1)
    }

    for (const expected of contract.listItems) {
      expect(
        reconstruction.paper.nodes.filter(
          (node) =>
            node.type === 'paragraph' &&
            textOf(node) === expected.text &&
            node.list?.level === expected.level &&
            node.list.ordered === expected.ordered &&
            node.list.numberingId === expected.numberingId,
        ),
        `list item ${expected.level}: ${expected.text}`,
      ).toHaveLength(1)
    }

    for (const reference of contract.references) {
      expect(
        reconstruction.paper.nodes.filter(
          (node) =>
            node.type === 'paragraph' &&
            textOf(node) === reference &&
            node.list?.level === 1 &&
            node.list.ordered,
        ),
        `bibliography entry: ${reference}`,
      ).toHaveLength(1)
    }

    const note = reconstruction.paper.nodes.find(
      (node) => node.type === 'footnote' && node.label === contract.note.label,
    )
    expect(note).toMatchObject({
      type: 'footnote',
      kind: 'footnote',
      text: contract.note.text,
      relationships: { backlinks: [expect.any(String)] },
    })
    const referenceIds = reconstruction.paper.nodes.flatMap((node) =>
      'noteReferences' in node
        ? (node.noteReferences ?? []).map((reference) => reference.id)
        : [],
    )
    expect(
      note?.type === 'footnote' ? note.relationships.backlinks : [],
    ).toEqual(expect.arrayContaining(referenceIds))
  })

  it('maps every supported inline style, link, super/subscript, and note marker', () => {
    for (const expected of contract.inlineSemantics) {
      const run = inlineRunFor(reconstruction, expected)
      expect(run, `${expected.container}: ${expected.text}`).toBeDefined()
      if ('bold' in expected) expect(run?.bold).toBe(expected.bold)
      if ('italic' in expected) expect(run?.italic).toBe(expected.italic)
      if ('href' in expected) expect(run?.href).toBe(expected.href)
      if ('verticalAlign' in expected)
        expect(run?.verticalAlign).toBe(expected.verticalAlign)
      if ('relationship' in expected)
        expect(run?.relationshipId).toEqual(expect.any(String))
    }
    expect(reconstruction.completeness).toMatchObject({
      expectedInlineSpanCount: contract.inlineSpanLedger.expected,
      mappedInlineSpanCount: contract.inlineSpanLedger.mapped,
      inlineSpanCoverage: contract.inlineSpanLedger.coverage,
    })
  })

  it('anchors a complete diagram caption, semantic table, and bounded equation in canonical order', () => {
    const canonicalIndexes: number[] = []
    for (const expected of contract.visuals) {
      const relationship = reconstruction.visualRelationships.find(
        (candidate) =>
          candidate.kind === expected.kind &&
          candidate.label === expected.label,
      )
      expect(relationship, expected.label).toMatchObject({
        status: 'matched',
        canonicalNodeId: expect.any(String),
        captionNodeId: expect.any(String),
        sourceObjectIds: expect.arrayContaining([expect.any(String)]),
        assetIds: expect.arrayContaining([expect.any(String)]),
        sourceBoxes: expect.arrayContaining([expect.any(Object)]),
      })
      const caption = reconstruction.paper.nodes.find(
        (node) => node.id === relationship?.captionNodeId,
      )
      expect(caption).toMatchObject({
        type: 'caption',
        text: expected.caption,
      })
      const canonicalIndex = reconstruction.paper.nodes.findIndex(
        (node) => node.id === relationship?.canonicalNodeId,
      )
      const captionIndex = reconstruction.paper.nodes.findIndex(
        (node) => node.id === relationship?.captionNodeId,
      )
      expect(canonicalIndex).toBeGreaterThan(-1)
      expect(captionIndex).toBe(canonicalIndex + 1)
      canonicalIndexes.push(canonicalIndex)

      for (const box of relationship?.sourceBoxes ?? []) {
        expect(box.width).toBeGreaterThan(0)
        expect(box.height).toBeGreaterThan(0)
        expect(box.width).toBeLessThan(0.95)
        expect(box.height).toBeLessThan(0.95)
      }
      for (const assetId of relationship?.assetIds ?? []) {
        const asset = reconstruction.assets.find(
          (candidate) => candidate.id === assetId,
        )
        expect(asset).toMatchObject({
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          width: expect.any(Number),
          height: expect.any(Number),
          sourceBoxes: expect.arrayContaining([expect.any(Object)]),
        })
        expect(asset?.bytes.byteLength).toBeGreaterThan(0)
        expect(asset?.width).toBeGreaterThan(0)
        expect(asset?.height).toBeGreaterThan(0)
        if ('asset' in expected) expect(asset).toMatchObject(expected.asset)
      }

      if ('evidence' in expected && expected.evidence) {
        expect(relationship?.evidence).toEqual(
          expect.arrayContaining(expected.evidence),
        )
      }

      if (expected.kind === 'table' && 'rows' in expected && expected.rows) {
        const expectedRows = expected.rows
        const node = reconstruction.paper.nodes.find(
          (candidate) => candidate.id === relationship?.canonicalNodeId,
        )
        expect(
          node?.type === 'figure'
            ? node.table?.rows.map((row) =>
                row.cells.map((cell) => normalized(cell.text)),
              )
            : undefined,
        ).toEqual(expectedRows)
        if ('headerEvidence' in expected) {
          const headerText = new Set(expectedRows[0])
          const sourceRuns = reconstruction.regions
            .filter((region) =>
              relationship?.sourceRegionIds.includes(region.id),
            )
            .flatMap((region) => region.lines)
            .flatMap((line) => line.runs)
            .filter((run) => headerText.has(normalized(run.text)))
          expect(sourceRuns).toHaveLength(expectedRows[0].length)
          expect(
            sourceRuns.every(
              (run) =>
                run.bold === true ||
                /(?:bold|black|demi|semibold)/i.test(run.fontName),
            ),
          ).toBe(true)
        }
      }
      if (expected.kind === 'equation' && 'sourceText' in expected) {
        expect(normalized(relationship?.sourceText ?? '')).toBe(
          expected.sourceText,
        )
      }
    }
    expect(canonicalIndexes).toEqual(
      [...canonicalIndexes].sort((a, b) => a - b),
    )
    expect(
      reconstruction.paper.nodes.some((node) => textOf(node) === '(1)'),
    ).toBe(false)
    expect(
      new Set(reconstruction.paper.nodes.map((node) => node.id)).size,
    ).toBe(reconstruction.paper.nodes.length)
  })

  it('retains the exact validated semantic table through readable projection and every EPUB profile', async () => {
    const tableRelationship = reconstruction.visualRelationships.find(
      (relationship) =>
        relationship.kind === 'table' &&
        relationship.label === 'Table 1',
    )
    expect(tableRelationship).toBeDefined()
    const tableAsset = reconstruction.assets.find(
      (asset) => asset.id === tableRelationship?.assetIds[0],
    )
    expect(tableAsset).toMatchObject({
      kind: 'table',
      rendition: 'semantic-table',
      mediaType: 'application/xhtml+xml',
    })
    const validated = validatedPdfVisualRelationships({
      paper: reconstruction.paper,
      provenance: reconstruction.provenance,
      relationships: reconstruction.visualRelationships,
      assets: reconstruction.assets,
      regions: reconstruction.regions,
    })
    expect(validated.map((relationship) => relationship.id)).toContain(
      tableRelationship?.id,
    )
    expect(reconstruction.completeness).toMatchObject({
      expectedSemanticTableCount: 1,
      resolvedSemanticTableCount: 1,
      semanticTableCoverage: 1,
    })

    const readable = projectReadableFallbackReconstruction(reconstruction)
    expect(
      readable.visualRelationships.map((relationship) => relationship.id),
    ).toContain(tableRelationship?.id)
    expect(readable.assets.map((asset) => asset.id)).toContain(tableAsset?.id)

    for (const [profileId, [publication]] of Object.entries(exports)) {
      const profile = getTargetProfile(
        profileId as 'mobile' | 'paperProMove' | 'paperPro',
      )
      const readable = await buildReadableEpub(
        reconstruction.paper,
        reconstruction,
        profile,
      )
      for (const [exportMode, epub] of [
        ['publication', publication],
        ['readable-fallback', readable],
      ] as const) {
        const { files, manifest } = inspectEpub(epub.bytes, profile)
        const content = strFromU8(files['EPUB/content.xhtml'])
        const marker = `data-canonical-id="${tableRelationship?.canonicalNodeId}"`
        const start = content.indexOf(marker)
        const end = content.indexOf('</figure>', start)
        const tableFragment = content.slice(start, end)
        expect(start).toBeGreaterThanOrEqual(0)
        expect(end).toBeGreaterThan(start)
        expect(tableFragment).toContain('class="semantic-table-wrapper"')
        expect(tableFragment).toContain('<table ')
        expect(tableFragment).toContain('<th ')
        expect(tableFragment).toContain('<td ')
        expect(tableFragment).not.toContain('class="omitted-visual"')
        expect(manifest.exportMode).toBe(exportMode)
        expect(manifest.sourceCompleteness).toMatchObject({
          expectedSemanticTableCount: 1,
          resolvedSemanticTableCount: 1,
          semanticTableCoverage: 1,
        })
        expect(manifest.visualRelationships).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: tableRelationship?.id }),
          ]),
        )
        expect(manifest.assets).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sourceAssetId: tableAsset?.id,
              rendition: 'semantic-table',
              mediaType: 'application/xhtml+xml',
            }),
          ]),
        )
      }
    }
  })

  it('revalidates the exact canonical paper at export time instead of trusting stale-ready evidence', async () => {
    const changedPaper = structuredClone(reconstruction.paper)
    const paragraph = changedPaper.nodes.find(
      (node) =>
        node.type === 'paragraph' && node.text.includes('state-of-the-art'),
    )
    expect(paragraph).toBeDefined()
    if (!paragraph || paragraph.type !== 'paragraph') return
    paragraph.text = paragraph.text.replace('state-of-the-art', 'stateoftheart')

    await expect(
      buildEpub(changedPaper, reconstruction, getTargetProfile('paperPro')),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_RECONSTRUCTION' })
  })

  it('exports byte-identical Mobile, Move, and Pro artifacts from one canonical graph', () => {
    const baselineManifests: unknown[] = []
    for (const expected of contract.profiles) {
      const profile = getTargetProfile(
        expected.id as 'mobile' | 'paperProMove' | 'paperPro',
      )
      expect(profile).toMatchObject({
        id: expected.id,
        version: expected.version,
        dimensions: {
          width: expected.width,
          height: expected.height,
          unit: expected.unit,
        },
        pixelsPerInch: expected.pixelsPerInch,
        preview: { widthCssPx: expected.previewWidthCssPx },
        margins: expected.margins,
      })

      const [first, second] = exports[expected.id]
      expect(first.bytes).toEqual(second.bytes)
      expect(first.sha256).toBe(second.sha256)
      const { files, manifest } = inspectEpub(first.bytes, profile)
      const content = strFromU8(files['EPUB/content.xhtml'])
      const contentBody = content.match(/<body\b[^>]*>([\s\S]*)<\/body>/u)?.[1] ?? ''
      expect(manifest).toMatchObject({
        profile: { id: expected.id, version: expected.version },
        canonicalNodeIds: reconstruction.paper.nodes.map((node) => node.id),
      })
      expect(occurrences(contentBody, contract.title)).toBe(1)
      expect(content).not.toMatch(/figure-placeholder|placeholder only/i)
      expect(content).toContain('<strong>bold</strong>')
      expect(content).toContain('<em>italic</em>')
      expect(content).toContain('<strong><em>combined</em></strong>')
      expect(content).toContain(
        '<a href="https://example.com/fidelity-evidence"><em>safe link</em></a>',
      )
      expect(content).toContain('<sub>2</sub>')
      expect(content).toMatch(
        /<a\b[^>]*epub:type="noteref"[^>]*><sup>1<\/sup><\/a>/,
      )
      for (const node of reconstruction.paper.nodes) {
        expect(
          occurrences(content, `data-canonical-id="${node.id}"`),
          node.id,
        ).toBe(1)
      }
      baselineManifests.push(manifest)
    }

    const graph = (manifest: unknown) => {
      const value = manifest as {
        canonicalContentSha256: string
        canonicalNodeIds: string[]
        visualRelationships: Array<{
          kind: string
          canonicalNodeId: string
          captionNodeId: string
        }>
      }
      return {
        canonicalContentSha256: value.canonicalContentSha256,
        canonicalNodeIds: value.canonicalNodeIds,
        visualRelationships: value.visualRelationships.map(
          ({ kind, canonicalNodeId, captionNodeId }) => ({
            kind,
            canonicalNodeId,
            captionNodeId,
          }),
        ),
      }
    }
    expect(baselineManifests.map(graph)).toEqual([
      graph(baselineManifests[0]),
      graph(baselineManifests[0]),
      graph(baselineManifests[0]),
    ])
  })
})

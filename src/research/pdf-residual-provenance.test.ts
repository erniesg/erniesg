import { describe, expect, it, vi } from 'vitest'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'

vi.mock('./pdf-visuals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pdf-visuals')>()
  return {
    ...actual,
    reconstructPdfVisuals: vi.fn(
      async (input: Parameters<typeof actual.reconstructPdfVisuals>[0]) => {
        const consumedLineIds = new Set(
          input.regions.flatMap((region) =>
            region.lines
              .filter((line) => line.text === 'Consumed table row')
              .map((line) => line.id),
          ),
        )
        return {
          assets: [],
          relationships: [],
          canonicalTablesByAssetId: new Map(),
          consumedRegionIds: new Set<string>(),
          consumedLineIds,
          partialRegionLineSelections: input.regions.flatMap((region) => {
            const consumed = region.lines
              .filter((line) => consumedLineIds.has(line.id))
              .map((line) => line.id)
            return consumed.length > 0
              ? [
                  {
                    regionId: region.id,
                    consumedLineIds: consumed,
                    retainedLineIds: region.lines
                      .filter((line) => !consumedLineIds.has(line.id))
                      .map((line) => line.id),
                  },
                ]
              : []
          }),
          diagnostics: [],
        }
      },
    ),
  }
})

import { reconstructPageAnalyses } from './pdf-layout'

function sourceRun(text: string, y: number, fontSize = 10): PdfSourceRun {
  return {
    page: 1,
    text,
    x: 0.1,
    y,
    width: 0.7,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
    fontName: fontSize > 12 ? 'Heading' : 'Body',
    fontSize,
    confidence: 1,
  }
}

describe('partial PDF-region provenance', () => {
  it('limits each noncontiguous residual fragment to its retained source lines', async () => {
    const runs = [
      sourceRun('Alpha prose.', 0.2),
      sourceRun('Consumed table row', 0.225),
      sourceRun('Omega prose.', 0.25),
    ]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs.reduce((total, run) => total + run.text.length, 0),
      imageCount: 0,
      runs,
    }

    const result = await reconstructPageAnalyses({
      pages: [page],
      sourceHash: 'f'.repeat(64),
      fileName: 'partial-region.pdf',
      byteLength: 1024,
    })
    const alpha = result.paper.nodes.find(
      (node) => 'text' in node && node.text === 'Alpha prose.',
    )
    const omega = result.paper.nodes.find(
      (node) => 'text' in node && node.text === 'Omega prose.',
    )

    expect(alpha).toBeDefined()
    expect(omega).toBeDefined()
    expect(result.provenance[alpha!.id].boxes.map((box) => box.y)).toEqual([
      0.2,
    ])
    expect(result.provenance[omega!.id].boxes.map((box) => box.y)).toEqual([
      0.25,
    ])
  })

  it('does not classify sibling fragments through their shared source-region id', async () => {
    const runs = [
      sourceRun('1 Introduction', 0.2),
      sourceRun('Consumed table row', 0.225),
      sourceRun('ordinary continuation', 0.25),
      sourceRun('2 Methods', 0.5, 16),
    ]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs.reduce((total, run) => total + run.text.length, 0),
      imageCount: 0,
      runs,
    }

    const result = await reconstructPageAnalyses({
      pages: [page],
      sourceHash: 'e'.repeat(64),
      fileName: 'partial-region-heading.pdf',
      byteLength: 1024,
    })
    const continuation = result.paper.nodes.find(
      (node) => 'text' in node && node.text === 'ordinary continuation',
    )

    expect(continuation).toMatchObject({ type: 'paragraph' })
  })

  it('targets the bibliography fragment that owns the entry marker', async () => {
    const runs = [
      sourceRun('Citation study', 0.05, 18),
      sourceRun('Prior work [1] and later work [1] support this claim.', 0.15),
      sourceRun('References', 0.35, 16),
      sourceRun('[1] Exact source reference.', 0.42),
      sourceRun('Consumed table row', 0.445),
      sourceRun('trailing bibliography prose', 0.47),
    ]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs.reduce((total, run) => total + run.text.length, 0),
      imageCount: 0,
      runs,
    }

    const result = await reconstructPageAnalyses({
      pages: [page],
      sourceHash: 'd'.repeat(64),
      fileName: 'partial-bibliography-region.pdf',
      byteLength: 1024,
    })
    const target = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' && node.text === 'Exact source reference.',
    )
    const citation = result.citationRelationships.find(
      (relationship) => relationship.label === '1',
    )

    expect(target).toBeDefined()
    expect(target).toMatchObject({
      list: { numberingId: 'references', markerText: '[1]' },
    })
    expect(citation).toMatchObject({
      status: 'matched',
      targetNodeIds: [target!.id],
    })
  })

  it('keeps citation anchors exact on both sides of a dehyphenated residual split', async () => {
    const runs = [
      sourceRun('Residual citation study', 0.03, 18),
      sourceRun('The term hyphenated is established.', 0.09),
      sourceRun('Prior hyphen-', 0.15),
      sourceRun('ated work [1]', 0.175),
      sourceRun('Consumed table row', 0.2),
      sourceRun('Later work [1]', 0.225),
      sourceRun('References', 0.4, 16),
      sourceRun('[1] Exact source reference.', 0.48),
    ]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs.reduce((total, run) => total + run.text.length, 0),
      imageCount: 0,
      runs,
    }

    const result = await reconstructPageAnalyses({
      pages: [page],
      sourceHash: 'c'.repeat(64),
      fileName: 'partial-citation-region.pdf',
      byteLength: 1024,
    })
    const prior = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' && node.text === 'Prior hyphenated work [1]',
    )
    const later = result.paper.nodes.find(
      (node) => node.type === 'paragraph' && node.text === 'Later work [1]',
    )
    const citationNodeIds = result.citationRelationships.map(
      (relationship) => relationship.canonicalAnchor?.nodeId,
    )

    expect(result.lineBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: 'removed-discretionary-hyphen',
        }),
      ]),
    )
    expect(prior).toBeDefined()
    expect(later).toBeDefined()
    expect(citationNodeIds).toEqual(
      expect.arrayContaining([prior!.id, later!.id]),
    )
    expect(
      [prior, later].every(
        (node) =>
          node?.type === 'paragraph' &&
          node.inlineRuns?.some((run) => run.semanticRole === 'citation'),
      ),
    ).toBe(true)
  })
})

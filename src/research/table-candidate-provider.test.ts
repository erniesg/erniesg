import { describe, expect, it, vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageRegion,
  PdfSourceRun,
} from './import-types'
import { sha256HexSync } from './sha256-sync'
import { isStrictSemanticTable } from './semantic-table'
import { canonicalTableFromLines } from './visual-assets'
import {
  createDoclingTableCandidateProvider,
  createTableCandidateBenchmarkReport,
  runTableCandidateProvider,
  tableCandidateCacheKey,
  verifyTableCandidate,
  type TableCandidateProposal,
} from './table-candidate-provider'

const crop: NormalizedSourceBox = {
  page: 1,
  x: 0.1,
  y: 0.2,
  width: 0.8,
  height: 0.4,
  rotation: 0,
  method: 'pdf-text',
}

function run(text: string, x: number, y: number, bold = false): PdfSourceRun {
  return {
    page: 1,
    x,
    y,
    width: 0.12,
    height: 0.03,
    rotation: 0,
    method: 'pdf-text',
    text,
    fontName: 'Fixture Serif',
    fontSize: 10,
    confidence: 1,
    bold,
  }
}

const sourceRegions: PdfPageRegion[] = [
  {
    id: 'table-region',
    page: 1,
    kind: 'body',
    column: 'single',
    text: 'Metric Value Revenue 5,557.0',
    confidence: 1,
    box: crop,
    nativeObjectIds: [],
    includedInReadingOrder: true,
    lines: [
      {
        id: 'header-line',
        text: 'Metric Value',
        fontSize: 10,
        box: { ...crop, x: 0.14, y: 0.24, width: 0.65, height: 0.03 },
        runs: [run('Metric', 0.14, 0.24, true), run('Value', 0.58, 0.24, true)],
      },
      {
        id: 'body-line',
        text: 'Revenue 5,557.0',
        fontSize: 10,
        box: { ...crop, x: 0.14, y: 0.43, width: 0.65, height: 0.03 },
        runs: [run('Revenue', 0.14, 0.43), run('5,557.0', 0.58, 0.43)],
      },
    ],
  },
]

function proposal(lastCell = '5 , 557 . 0'): TableCandidateProposal {
  return {
    columnCount: 2,
    headerRowCount: 1,
    rows: [
      {
        cells: [
          {
            text: 'Metric',
            columnIndex: 0,
            box: { x: 0, y: 0, width: 0.5, height: 0.5 },
          },
          {
            text: 'Value',
            columnIndex: 1,
            box: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
          },
        ],
      },
      {
        cells: [
          {
            text: 'Revenue',
            columnIndex: 0,
            box: { x: 0, y: 0.5, width: 0.5, height: 0.5 },
          },
          {
            text: lastCell,
            columnIndex: 1,
            box: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
          },
        ],
      },
    ],
  }
}

describe('table candidate provider verification', () => {
  it('substitutes exact source text and records source-only grid evidence', () => {
    const grid = verifyTableCandidate({
      proposal: proposal(),
      sourceRegions,
      sourceCropBox: crop,
    })
    expect(grid?.lines[1].cells[1].run.text).toBe('5,557.0')
    expect(grid?.lines[1].cells[1].run.text).not.toBe('5 , 557 . 0')
    expect(grid?.evidence).toContain('provider-text-discarded')
    expect(grid?.sourceLineIds).toEqual(['body-line', 'header-line'])
    const table = canonicalTableFromLines(grid!.lines, {
      detectedGrid: grid!,
      sourceRegions,
      links: [],
    })
    expect(table?.rows[1].cells[1]).toMatchObject({
      text: '5,557.0',
      sourceRuns: [{ text: '5,557.0' }],
    })
  })

  it('rejects the whole grid when one non-empty cell is unmatched', () => {
    expect(
      verifyTableCandidate({
        proposal: proposal('5,558.0'),
        sourceRegions,
        sourceCropBox: crop,
      }),
    ).toBeNull()
  })

  it('preserves a verified empty continuation stub without inventing text', () => {
    const continuationRun = run('5,558.0', 0.58, 0.53)
    const continuationRegions: PdfPageRegion[] = [
      {
        ...sourceRegions[0],
        text: `${sourceRegions[0].text} 5,558.0`,
        lines: [
          ...sourceRegions[0].lines,
          {
            id: 'continuation-line',
            text: '5,558.0',
            fontSize: 10,
            box: { ...crop, x: 0.58, y: 0.53, width: 0.12, height: 0.03 },
            runs: [continuationRun],
          },
        ],
      },
    ]
    const candidate: TableCandidateProposal = {
      ...proposal('5,557.0'),
      rows: [
        proposal('5,557.0').rows[0],
        {
          cells: proposal('5,557.0').rows[1].cells.map((cell) => ({
            ...cell,
            box: cell.box ? { ...cell.box, height: 0.25 } : undefined,
          })),
        },
        {
          cells: [
            {
              text: '',
              columnIndex: 0,
              box: { x: 0, y: 0.75, width: 0.5, height: 0.25 },
            },
            {
              text: '5,558.0',
              columnIndex: 1,
              box: { x: 0.5, y: 0.75, width: 0.5, height: 0.25 },
            },
          ],
        },
      ],
    }
    const grid = verifyTableCandidate({
      proposal: candidate,
      sourceRegions: continuationRegions,
      sourceCropBox: crop,
    })
    const table = canonicalTableFromLines(grid!.lines, {
      detectedGrid: grid!,
      sourceRegions: continuationRegions,
      links: [],
    })
    expect(table?.rows[2].cells[0]).toMatchObject({
      text: '',
      sourceRuns: [],
    })
    expect(table?.rows[2].cells[1].text).toBe('5,558.0')
    expect(isStrictSemanticTable(table)).toBe(true)
    expect(
      isStrictSemanticTable({
        rows: [
          {
            cells: [
              { text: 'A', headerScope: 'column', columnSpan: 1, rowSpan: 1 },
              { text: 'B', headerScope: 'column', columnSpan: 1, rowSpan: 1 },
            ],
          },
          {
            cells: [
              { text: '', headerScope: null, columnSpan: 1, rowSpan: 1 },
              { text: '1', headerScope: null, columnSpan: 1, rowSpan: 1 },
            ],
          },
        ],
      }),
    ).toBe(false)
  })

  it('distinguishes no proposal, failed verification, and unavailable provider', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const image = {
      bytes,
      mediaType: 'image/png' as const,
      sha256: sha256HexSync(bytes),
      sourceCropBox: crop,
    }
    const provider = createDoclingTableCandidateProvider({
      version: '2.48.0',
      modelDigest: 'a'.repeat(64),
      configuration: { mode: 'accurate', threads: 1 },
      infer: vi.fn(async () => null),
    })
    const none = await runTableCandidateProvider({
      provider,
      image,
      sourceRegions,
    })
    expect(none.receipt.diagnostic).toBe('table-candidate-no-proposal')

    provider.propose = vi.fn(async () => proposal('invented'))
    const failed = await runTableCandidateProvider({
      provider,
      image,
      sourceRegions,
    })
    expect(failed.receipt.diagnostic).toBe(
      'table-candidate-proposal-failed-verification',
    )

    vi.mocked(provider.propose).mockClear()
    const remote = { ...provider, locality: 'remote' as const }
    const unavailable = await runTableCandidateProvider({
      provider: remote,
      image,
      sourceRegions,
    })
    expect(unavailable.receipt.diagnostic).toBe(
      'table-candidate-provider-unavailable',
    )
    expect(remote.propose).not.toHaveBeenCalled()
  })

  it('binds deterministic cache entries and receipts to full provider identity', async () => {
    const bytes = new Uint8Array([4, 5, 6])
    const image = {
      bytes,
      mediaType: 'image/png' as const,
      sha256: sha256HexSync(bytes),
      sourceCropBox: crop,
    }
    const infer = vi.fn(async () => proposal())
    const provider = createDoclingTableCandidateProvider({
      version: '2.48.0',
      modelDigest: 'b'.repeat(64),
      configuration: { threads: 1 },
      infer,
    })
    const cache = new Map()
    const first = await runTableCandidateProvider({
      provider,
      image,
      sourceRegions,
      cache,
    })
    const second = await runTableCandidateProvider({
      provider,
      image,
      sourceRegions,
      cache,
    })
    expect(infer).toHaveBeenCalledTimes(1)
    expect(second.receipt).toEqual(first.receipt)
    expect(second.verified?.grid).toEqual(first.verified?.grid)

    const changed = {
      ...provider.identity,
      configurationHash: 'c'.repeat(64),
    }
    expect(tableCandidateCacheKey(changed, image.sha256)).not.toBe(
      first.receipt.cacheKey,
    )
  })

  it('passes cancellation to provider inference', async () => {
    const bytes = new Uint8Array([7, 8, 9])
    const image = {
      bytes,
      mediaType: 'image/png' as const,
      sha256: sha256HexSync(bytes),
      sourceCropBox: crop,
    }
    const signal = new AbortController().signal
    const infer = vi.fn(async () => proposal())
    const provider = createDoclingTableCandidateProvider({
      version: '2.48.0',
      modelDigest: 'd'.repeat(64),
      configuration: { threads: 1 },
      infer,
    })
    await runTableCandidateProvider({ provider, image, sourceRegions, signal })
    expect(infer).toHaveBeenCalledWith(expect.objectContaining({ signal }))
  })

  it('reports all three paths against one corpus denominator', () => {
    const first = createTableCandidateBenchmarkReport({
      corpusId: 'table-corpus-v1',
      deterministic: { semantic: 2, raster: 5, unresolved: 3 },
      provider: { semantic: 10, raster: 0, unresolved: 0 },
      verifiedProvider: { semantic: 8, raster: 2, unresolved: 0 },
    })
    const repeated = createTableCandidateBenchmarkReport({
      corpusId: 'table-corpus-v1',
      deterministic: { semantic: 2, raster: 5, unresolved: 3 },
      provider: { semantic: 10, raster: 0, unresolved: 0 },
      verifiedProvider: { semantic: 8, raster: 2, unresolved: 0 },
    })
    expect(repeated).toEqual(first)
  })
})

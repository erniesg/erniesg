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

const adapterIdentity = {
  id: 'docling-tableformer-adapter',
  version: '1.0.0',
  sha256: 'f'.repeat(64),
}

const runtimeIdentity = {
  id: 'docling-python',
  version: '2.48.0',
  sha256: 'e'.repeat(64),
}

describe('table candidate provider verification', () => {
  it('keeps exact run ownership through grouped headers and row/column spans', () => {
    const values = [
      ['Model', 'Scores', '', ''],
      ['', 'Mean', 'Std', 'Count'],
      ['Alpha', '0.1', '0.2', '3'],
      ['Beta', '0.3', '0.4', '4'],
    ]
    const groupedRegions: PdfPageRegion[] = [
      {
        ...sourceRegions[0],
        id: 'grouped-region',
        text: values.flat().filter(Boolean).join(' '),
        lines: values.map((texts, rowIndex) => ({
          id: `grouped-line-${rowIndex + 1}`,
          text: texts.filter(Boolean).join(' '),
          fontSize: 10,
          box: { ...crop, x: 0.12, y: 0.22 + rowIndex * 0.07, width: 0.7 },
          runs: texts.flatMap((text, columnIndex) =>
            text
              ? [run(text, 0.12 + columnIndex * 0.2, 0.22 + rowIndex * 0.07)]
              : [],
          ),
        })),
      },
    ]
    const ref = (rowIndex: number, runIndex: number) => ({
      regionId: 'grouped-region',
      lineId: `grouped-line-${rowIndex + 1}`,
      runIndex,
    })
    const candidate: TableCandidateProposal = {
      columnCount: 4,
      headerRowCount: 2,
      rows: [
        {
          cells: [
            { text: 'Model', columnIndex: 0, rowSpan: 2, sourceRunRefs: [ref(0, 0)] },
            { text: 'Scores', columnIndex: 1, columnSpan: 3, sourceRunRefs: [ref(0, 1)] },
          ],
        },
        {
          cells: [
            { text: 'Mean', columnIndex: 1, sourceRunRefs: [ref(1, 0)] },
            { text: 'Std', columnIndex: 2, sourceRunRefs: [ref(1, 1)] },
            { text: 'Count', columnIndex: 3, sourceRunRefs: [ref(1, 2)] },
          ],
        },
        {
          cells: [
            { text: 'Alpha', columnIndex: 0, sourceRunRefs: [ref(2, 0)] },
            { text: '0.1', columnIndex: 1, sourceRunRefs: [ref(2, 1)] },
            { text: '0.2', columnIndex: 2, sourceRunRefs: [ref(2, 2)] },
            { text: '3', columnIndex: 3, sourceRunRefs: [ref(2, 3)] },
          ],
        },
        {
          cells: [
            { text: 'Beta', columnIndex: 0, sourceRunRefs: [ref(3, 0)] },
            { text: '0.3', columnIndex: 1, sourceRunRefs: [ref(3, 1)] },
            { text: '0.4', columnIndex: 2, sourceRunRefs: [ref(3, 2)] },
            { text: '4', columnIndex: 3, sourceRunRefs: [ref(3, 3)] },
          ],
        },
      ],
    }

    const grid = verifyTableCandidate({
      proposal: candidate,
      sourceRegions: groupedRegions,
      sourceCropBox: crop,
    })

    expect(grid).not.toBeNull()
    expect(grid!.lines[0].cells[0]).toMatchObject({
      columnIndex: 0,
      rowSpan: 2,
      sourceRunRefs: [ref(0, 0)],
    })
    expect(grid!.lines[1].cells[1].sourceRunRefs).toEqual([ref(1, 1)])
    const table = canonicalTableFromLines(grid!.lines, {
      detectedGrid: grid!,
      sourceRegions: groupedRegions,
      links: [],
    })
    expect(table?.rows[2].cells[3].sourceRuns).toEqual([
      expect.objectContaining({
        regionId: 'grouped-region',
        lineId: 'grouped-line-3',
        runIndex: 3,
        text: '3',
      }),
    ])
  })

  it('rejects duplicate or moved source-run references before promotion', () => {
    const refs = [
      { regionId: 'table-region', lineId: 'header-line', runIndex: 0 },
      { regionId: 'table-region', lineId: 'header-line', runIndex: 1 },
      { regionId: 'table-region', lineId: 'body-line', runIndex: 0 },
      { regionId: 'table-region', lineId: 'body-line', runIndex: 1 },
    ]
    const withRefs = (lastText: string) => ({
      ...proposal(lastText),
      rows: proposal(lastText).rows.map((row, rowIndex) => ({
        cells: row.cells.map((cell, cellIndex) => ({
          ...cell,
          sourceRunRefs: [refs[rowIndex * 2 + cellIndex]],
        })),
      })),
    })
    const duplicate = withRefs('5,557.0')
    duplicate.rows[1].cells[1].sourceRunRefs = [refs[2]]
    expect(
      verifyTableCandidate({
        proposal: duplicate,
        sourceRegions,
        sourceCropBox: crop,
      }),
    ).toBeNull()

    const moved = withRefs('Revenue')
    moved.rows[1].cells[1].text = 'Revenue'
    moved.rows[1].cells[1].sourceRunRefs = [refs[2]]
    expect(
      verifyTableCandidate({
        proposal: moved,
        sourceRegions,
        sourceCropBox: crop,
      }),
    ).toBeNull()
  })

  it('rejects an empty-cell column swap even when its box has no source ink', () => {
    const candidate = proposal('5,557.0')
    candidate.rows[1].cells = [
      {
        text: '',
        columnIndex: 1,
        box: { x: 0, y: 0.5, width: 0.5, height: 0.5 },
      },
      {
        text: '5,557.0',
        columnIndex: 0,
        box: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
      },
    ]
    expect(
      verifyTableCandidate({
        proposal: candidate,
        sourceRegions,
        sourceCropBox: crop,
      }),
    ).toBeNull()
  })

  it('rejects an empty-cell column swap when grouped headers provide no column centers', () => {
    const groupedSourceRegions: PdfPageRegion[] = [
      {
        ...sourceRegions[0],
        text: 'Metric Value Revenue',
        lines: [
          {
            id: 'grouped-header-line',
            text: 'Metric Value',
            fontSize: 10,
            box: { ...crop, x: 0.14, y: 0.24, width: 0.65, height: 0.03 },
            runs: [
              run('Metric', 0.14, 0.24, true),
              run('Value', 0.58, 0.24, true),
            ],
          },
          {
            id: 'grouped-body-line',
            text: 'Revenue',
            fontSize: 10,
            box: { ...crop, x: 0.14, y: 0.43, width: 0.12, height: 0.03 },
            runs: [run('Revenue', 0.14, 0.43)],
          },
        ],
      },
    ]
    const candidate: TableCandidateProposal = {
      columnCount: 2,
      headerRowCount: 1,
      rows: [
        {
          cells: [
            {
              text: 'Metric Value',
              columnIndex: 0,
              columnSpan: 2,
              box: { x: 0, y: 0, width: 1, height: 0.5 },
            },
          ],
        },
        {
          cells: [
            {
              text: '',
              columnIndex: 0,
              box: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
            },
            {
              text: 'Revenue',
              columnIndex: 1,
              box: { x: 0, y: 0.5, width: 0.5, height: 0.5 },
            },
          ],
        },
      ],
    }

    expect(
      verifyTableCandidate({
        proposal: candidate,
        sourceRegions: groupedSourceRegions,
        sourceCropBox: crop,
      }),
    ).toBeNull()
  })

  it('rejects an empty cell outside its established header band', () => {
    const bandSourceRegions: PdfPageRegion[] = [
      {
        ...sourceRegions[0],
        text: 'Metric Value 5,557.0',
        lines: [
          sourceRegions[0].lines[0],
          {
            ...sourceRegions[0].lines[1],
            text: '5,557.0',
            runs: [sourceRegions[0].lines[1].runs[1]],
          },
        ],
      },
    ]
    const candidate: TableCandidateProposal = {
      ...proposal('5,557.0'),
      rows: [
        proposal('5,557.0').rows[0],
        {
          cells: [
            {
              text: '',
              columnIndex: 0,
              box: { x: 0.45, y: 0.5, width: 0.1, height: 0.5 },
            },
            {
              text: '5,557.0',
              columnIndex: 1,
              box: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
            },
          ],
        },
      ],
    }

    expect(
      verifyTableCandidate({
        proposal: candidate,
        sourceRegions: bandSourceRegions,
        sourceCropBox: crop,
      }),
    ).toBeNull()
  })

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

  it('rejects provider proposals with more than two header rows', () => {
    const rows = [
      ['Metric', 'Value'],
      ['Units', 'Amount'],
      ['Reported', 'Current'],
      ['Revenue', '5,557.0'],
    ]
    const candidate: TableCandidateProposal = {
      columnCount: 2,
      headerRowCount: 3,
      rows: rows.map((texts, rowIndex) => ({
        cells: texts.map((text, columnIndex) => ({
          text,
          columnIndex,
          box: {
            x: columnIndex * 0.5,
            y: rowIndex * 0.25,
            width: 0.5,
            height: 0.25,
          },
        })),
      })),
    }
    const candidateRegions: PdfPageRegion[] = [
      {
        ...sourceRegions[0],
        text: rows.flat().join(' '),
        lines: rows.map((texts, rowIndex) => ({
          id: `candidate-row-${rowIndex + 1}`,
          text: texts.join(' '),
          fontSize: 10,
          box: { ...crop, x: 0.14, y: 0.22 + rowIndex * 0.1, width: 0.65 },
          runs: [
            run(texts[0], 0.14, 0.22 + rowIndex * 0.1, rowIndex < 3),
            run(texts[1], 0.58, 0.22 + rowIndex * 0.1, rowIndex < 3),
          ],
        })),
      },
    ]

    expect(
      verifyTableCandidate({
        proposal: candidate,
        sourceRegions: candidateRegions,
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
      adapter: adapterIdentity,
      runtime: runtimeIdentity,
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
    expect(unavailable.remoteUsed).toBe(false)
    expect(remote.propose).not.toHaveBeenCalled()

    const remoteFailure = {
      ...provider,
      locality: 'remote' as const,
      propose: vi.fn(async () => {
        throw new Error('remote transport failed')
      }),
    }
    const failedRemote = await runTableCandidateProvider({
      provider: remoteFailure,
      image,
      sourceRegions,
      allowRemote: true,
    })
    expect(failedRemote.remoteUsed).toBe(true)
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
      adapter: adapterIdentity,
      runtime: runtimeIdentity,
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
    expect(first.receipt.provider).toMatchObject({
      adapter: adapterIdentity,
      runtime: runtimeIdentity,
    })

    const changed = {
      ...provider.identity,
      configurationHash: 'c'.repeat(64),
    }
    expect(tableCandidateCacheKey(changed, image.sha256)).not.toBe(
      first.receipt.cacheKey,
    )
  })

  it('rejects a provider whose adapter or runtime identity is not pinned', async () => {
    const bytes = new Uint8Array([13, 14, 15])
    const image = {
      bytes,
      mediaType: 'image/png' as const,
      sha256: sha256HexSync(bytes),
      sourceCropBox: crop,
    }
    const provider = {
      identity: {
        id: 'docling-tableformer',
        version: '2.48.0',
        modelDigest: 'a'.repeat(64),
        configurationHash: 'b'.repeat(64),
      },
      locality: 'local' as const,
      propose: vi.fn(async () => proposal()),
    } as unknown as Parameters<typeof runTableCandidateProvider>[0]['provider']
    await expect(
      runTableCandidateProvider({ provider, image, sourceRegions }),
    ).rejects.toThrow(/identity must be fully pinned/u)
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
      adapter: adapterIdentity,
      runtime: runtimeIdentity,
      infer,
    })
    await runTableCandidateProvider({ provider, image, sourceRegions, signal })
    expect(infer).toHaveBeenCalledWith(expect.objectContaining({ signal }))
  })

  it('returns promptly when an adapter ignores cancellation', async () => {
    const bytes = new Uint8Array([10, 11, 12])
    const image = {
      bytes,
      mediaType: 'image/png' as const,
      sha256: sha256HexSync(bytes),
      sourceCropBox: crop,
    }
    const controller = new AbortController()
    const infer = vi.fn(
      () =>
        new Promise<TableCandidateProposal | null>(() => {
          // Simulate an adapter that does not observe AbortSignal.
        }),
    )
    const provider = createDoclingTableCandidateProvider({
      version: '2.48.0',
      modelDigest: 'e'.repeat(64),
      configuration: { threads: 1 },
      adapter: adapterIdentity,
      runtime: runtimeIdentity,
      infer,
    })

    const resultPromise = runTableCandidateProvider({
      provider,
      image,
      sourceRegions,
      signal: controller.signal,
    })
    controller.abort()

    await expect(resultPromise).resolves.toMatchObject({
      verified: null,
      receipt: { diagnostic: 'table-candidate-provider-unavailable' },
    })
  })

  it('returns promptly when provider availability ignores cancellation', async () => {
    const bytes = new Uint8Array([16, 17, 18])
    const image = {
      bytes,
      mediaType: 'image/png' as const,
      sha256: sha256HexSync(bytes),
      sourceCropBox: crop,
    }
    const controller = new AbortController()
    const provider = createDoclingTableCandidateProvider({
      version: '2.48.0',
      modelDigest: '7'.repeat(64),
      configuration: { threads: 1 },
      adapter: adapterIdentity,
      runtime: runtimeIdentity,
      infer: vi.fn(async () => proposal()),
    })
    provider.available = () =>
      new Promise<boolean>(() => {
        // Simulate a runtime probe that does not observe AbortSignal.
      })

    const resultPromise = runTableCandidateProvider({
      provider,
      image,
      sourceRegions,
      signal: controller.signal,
    })
    controller.abort()

    await expect(resultPromise).resolves.toMatchObject({
      verified: null,
      receipt: { diagnostic: 'table-candidate-provider-unavailable' },
    })
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

  it('snapshots path counts before hashing a benchmark report', () => {
    const deterministic = { semantic: 2, raster: 5, unresolved: 3 }
    const provider = { semantic: 10, raster: 0, unresolved: 0 }
    const verifiedProvider = { semantic: 8, raster: 2, unresolved: 0 }
    const report = createTableCandidateBenchmarkReport({
      corpusId: 'table-corpus-v1',
      deterministic,
      provider,
      verifiedProvider,
    })
    const digest = report.sha256
    deterministic.semantic = 99
    provider.unresolved = 99
    verifiedProvider.raster = 99
    expect(report.paths).toEqual({
      deterministic: { semantic: 2, raster: 5, unresolved: 3 },
      provider: { semantic: 10, raster: 0, unresolved: 0 },
      verifiedProvider: { semantic: 8, raster: 2, unresolved: 0 },
    })
    expect(report.sha256).toBe(digest)
  })
})

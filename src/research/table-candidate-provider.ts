import type {
  NormalizedSourceBox,
  PdfPageRegion,
  PdfSourceRun,
} from './import-types'
import type { PdfDetectedTableGrid } from './pdf-table-detection'
import { sha256HexSync } from './sha256-sync'

export const TABLE_CANDIDATE_RECEIPT_SCHEMA_VERSION = '1.0.0' as const

export type TableCandidateProviderIdentity = {
  id: string
  version: string
  modelDigest: string
  configurationHash: string
}

export type TableCandidateCell = {
  text: string
  columnIndex: number
  columnSpan?: number
  rowSpan?: number
  /** Coordinates normalized to the bounded table image, not the source page. */
  box?: { x: number; y: number; width: number; height: number }
}

export type TableCandidateProposal = {
  rows: Array<{ cells: TableCandidateCell[] }>
  columnCount: number
  headerRowCount: number
}

export type TableCandidateImage = {
  bytes: Uint8Array
  mediaType: 'image/png' | 'image/jpeg'
  sha256: string
  sourceCropBox: NormalizedSourceBox
}

export type TableCandidateProvider = {
  identity: TableCandidateProviderIdentity
  locality: 'local' | 'remote'
  available?: () => boolean | Promise<boolean>
  propose: (input: {
    image: Uint8Array
    mediaType: TableCandidateImage['mediaType']
    imageSha256: string
    signal?: AbortSignal
  }) => Promise<TableCandidateProposal | null>
}

export type TableCandidateDiagnostic =
  | 'table-candidate-no-proposal'
  | 'table-candidate-proposal-failed-verification'
  | 'table-candidate-provider-unavailable'
  | 'table-candidate-verified'

export type TableCandidateReceipt = {
  schemaVersion: typeof TABLE_CANDIDATE_RECEIPT_SCHEMA_VERSION
  provider: TableCandidateProviderIdentity & { locality: 'local' | 'remote' }
  sourceImageSha256: string
  cacheKey: string
  candidateSha256: string | null
  verifiedGridSha256: string | null
  diagnostic: TableCandidateDiagnostic
}

export type VerifiedTableCandidate = {
  grid: PdfDetectedTableGrid
  receipt: TableCandidateReceipt
}

export class TableCandidateProviderUnavailableError extends Error {
  constructor() {
    super('The configured table candidate provider is unavailable.')
    this.name = 'TableCandidateProviderUnavailableError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  )
}

function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value))
}

function pinnedIdentity(identity: TableCandidateProviderIdentity) {
  return (
    /^[a-z0-9][a-z0-9._-]{0,79}$/u.test(identity.id) &&
    identity.version.length > 0 &&
    identity.version.length <= 120 &&
    /^[a-f0-9]{64}$/u.test(identity.modelDigest) &&
    /^[a-f0-9]{64}$/u.test(identity.configurationHash)
  )
}

export function tableCandidateConfigurationHash(configuration: unknown) {
  return sha256HexSync(stableJson(configuration))
}

export function tableCandidateCacheKey(
  identity: TableCandidateProviderIdentity,
  sourceImageSha256: string,
) {
  return sha256HexSync(
    stableJson({
      identity,
      sourceImageSha256,
      schemaVersion: TABLE_CANDIDATE_RECEIPT_SCHEMA_VERSION,
    }),
  )
}

/**
 * Concrete local Docling/TableFormer adapter. The inference function is
 * injected by the trusted-VM caller so this browser-safe package never gains a
 * Python/runtime dependency and never passes a path or extracted source text.
 */
export function createDoclingTableCandidateProvider({
  version,
  modelDigest,
  configuration,
  infer,
}: {
  version: string
  modelDigest: string
  configuration: unknown
  infer: TableCandidateProvider['propose']
}): TableCandidateProvider {
  return {
    identity: {
      id: 'docling-tableformer',
      version,
      modelDigest,
      configurationHash: tableCandidateConfigurationHash(configuration),
    },
    locality: 'local',
    propose: infer,
  }
}

function normalizedCandidateText(value: string) {
  return value
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .replace(/\s+([,.;:%)\]}])/gu, '$1')
    .replace(/([,.;:%])\s+/gu, '$1')
    .replace(/([(\[{])\s+/gu, '$1')
    .trim()
}

function validUnitBox(value: unknown): value is TableCandidateCell['box'] {
  return (
    isRecord(value) &&
    ['x', 'y', 'width', 'height'].every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
    ) &&
    Number(value.x) >= 0 &&
    Number(value.y) >= 0 &&
    Number(value.width) > 0 &&
    Number(value.height) > 0 &&
    Number(value.x) + Number(value.width) <= 1.000001 &&
    Number(value.y) + Number(value.height) <= 1.000001
  )
}

function pageBox(
  box: NonNullable<TableCandidateCell['box']>,
  crop: NormalizedSourceBox,
): NormalizedSourceBox {
  return {
    ...crop,
    x: crop.x + box.x * crop.width,
    y: crop.y + box.y * crop.height,
    width: box.width * crop.width,
    height: box.height * crop.height,
  }
}

function runCenterInside(run: PdfSourceRun, box: NormalizedSourceBox) {
  const centerX = run.x + run.width / 2
  const centerY = run.y + run.height / 2
  return (
    run.page === box.page &&
    centerX >= box.x - 0.000001 &&
    centerX <= box.x + box.width + 0.000001 &&
    centerY >= box.y - 0.000001 &&
    centerY <= box.y + box.height + 0.000001
  )
}

type OwnedRun = {
  key: string
  region: PdfPageRegion
  line: PdfPageRegion['lines'][number]
  run: PdfSourceRun
  runIndex: number
}

function orderedScopeRuns(regions: readonly PdfPageRegion[]) {
  return regions
    .flatMap<OwnedRun>((region) =>
      region.lines.flatMap((line) =>
        line.runs.flatMap((run, runIndex) =>
          run.text.trim()
            ? [
                {
                  key: `${region.id}\u0000${line.id}\u0000${runIndex}`,
                  region,
                  line,
                  run,
                  runIndex,
                },
              ]
            : [],
        ),
      ),
    )
    .sort(
      (left, right) =>
        left.run.page - right.run.page ||
        left.run.y - right.run.y ||
        left.run.x - right.run.x ||
        left.region.id.localeCompare(right.region.id) ||
        left.line.id.localeCompare(right.line.id) ||
        left.runIndex - right.runIndex,
    )
}

function sourceSequenceText(sources: readonly OwnedRun[]) {
  let text = ''
  for (const [index, source] of sources.entries()) {
    if (index > 0) {
      const previous = sources[index - 1]
      const differentLine = previous.line.id !== source.line.id
      const gap = source.run.x - (previous.run.x + previous.run.width)
      const threshold = Math.max(
        0.0005,
        Math.min(previous.run.height, source.run.height) * 0.18,
      )
      if (differentLine || gap > threshold) text += ' '
    }
    text += source.run.text
  }
  return text
}

function sourceUnionBox(sources: readonly OwnedRun[]) {
  const first = sources[0].run
  const left = Math.min(...sources.map(({ run }) => run.x))
  const top = Math.min(...sources.map(({ run }) => run.y))
  const right = Math.max(...sources.map(({ run }) => run.x + run.width))
  const bottom = Math.max(...sources.map(({ run }) => run.y + run.height))
  return {
    page: first.page,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    rotation: first.rotation,
    method: first.method,
  } satisfies NormalizedSourceBox
}

function validProposalShape(
  proposal: unknown,
): proposal is TableCandidateProposal {
  if (!isRecord(proposal) || !Array.isArray(proposal.rows)) {
    return false
  }
  const columnCount = Number(proposal.columnCount)
  const headerRowCount = Number(proposal.headerRowCount)
  if (
    !Number.isInteger(columnCount) ||
    columnCount < 2 ||
    columnCount > 24 ||
    !Number.isInteger(headerRowCount) ||
    headerRowCount < 1 ||
    headerRowCount >= proposal.rows.length ||
    proposal.rows.length < 2
  ) {
    return false
  }
  const occupied = Array.from({ length: proposal.rows.length }, () =>
    Array.from({ length: columnCount }, () => false),
  )
  for (const [rowIndex, row] of proposal.rows.entries()) {
    if (!isRecord(row) || !Array.isArray(row.cells) || row.cells.length === 0) {
      return false
    }
    for (const cell of row.cells) {
      if (!isRecord(cell)) return false
      const columnIndex = Number(cell.columnIndex)
      const columnSpan = Number(cell.columnSpan ?? 1)
      const rowSpan = Number(cell.rowSpan ?? 1)
      if (
        typeof cell.text !== 'string' ||
        !Number.isInteger(columnIndex) ||
        !Number.isInteger(columnSpan) ||
        !Number.isInteger(rowSpan) ||
        columnIndex < 0 ||
        columnSpan < 1 ||
        rowSpan < 1 ||
        columnIndex + columnSpan > columnCount ||
        rowIndex + rowSpan > proposal.rows.length ||
        (cell.box !== undefined && !validUnitBox(cell.box))
      ) {
        return false
      }
      for (let row = rowIndex; row < rowIndex + rowSpan; row += 1) {
        for (
          let column = columnIndex;
          column < columnIndex + columnSpan;
          column += 1
        ) {
          if (occupied[row][column]) return false
          occupied[row][column] = true
        }
      }
    }
  }
  return occupied.every((row) => row.every(Boolean))
}

function uniqueTextMatch(
  text: string,
  available: readonly OwnedRun[],
): OwnedRun[] | null {
  const matches: OwnedRun[][] = []
  for (let start = 0; start < available.length; start += 1) {
    for (let end = start + 1; end <= available.length; end += 1) {
      const sequence = available.slice(start, end)
      if (
        normalizedCandidateText(sourceSequenceText(sequence)) ===
        normalizedCandidateText(text)
      ) {
        matches.push(sequence)
      }
    }
  }
  return matches.length === 1 ? matches[0] : null
}

/**
 * Turns provider geometry into a detected grid only after complete cell-level
 * verification. Provider strings are used solely for comparison: every
 * emitted run carries the exact source-run string and geometry.
 */
export function verifyTableCandidate({
  proposal,
  sourceRegions,
  sourceCropBox,
}: {
  proposal: TableCandidateProposal
  sourceRegions: readonly PdfPageRegion[]
  sourceCropBox: NormalizedSourceBox
}): PdfDetectedTableGrid | null {
  if (!validProposalShape(proposal)) return null
  const allRuns = orderedScopeRuns(sourceRegions)
  if (allRuns.length === 0) return null
  const claimed = new Set<string>()
  const lines: PdfDetectedTableGrid['lines'] = []

  for (const [rowIndex, proposedRow] of proposal.rows.entries()) {
    const verifiedCells: Array<{
      run: PdfSourceRun
      columnIndex: number
      columnSpan: number
      rowSpan: number
      sourceBox: NormalizedSourceBox
      sourceLineIds: string[]
      sourceRegionIds: string[]
    }> = []
    for (const cell of [...proposedRow.cells].sort(
      (left, right) => left.columnIndex - right.columnIndex,
    )) {
      const absoluteBox = cell.box ? pageBox(cell.box, sourceCropBox) : null
      const available = allRuns.filter((source) => !claimed.has(source.key))
      const spatial = absoluteBox
        ? available.filter(({ run }) => runCenterInside(run, absoluteBox))
        : []
      let sources: OwnedRun[] | null
      if (normalizedCandidateText(cell.text) === '') {
        if (spatial.length > 0) return null
        sources = []
      } else if (absoluteBox) {
        sources =
          spatial.length > 0 &&
          normalizedCandidateText(sourceSequenceText(spatial)) ===
            normalizedCandidateText(cell.text)
            ? spatial
            : null
      } else {
        sources = uniqueTextMatch(cell.text, available)
      }
      if (!sources) return null
      sources.forEach((source) => claimed.add(source.key))
      const sourceBox =
        sources.length > 0 ? sourceUnionBox(sources) : absoluteBox!
      if (!sourceBox) return null
      const first = sources[0]?.run
      const text = sourceSequenceText(sources)
      verifiedCells.push({
        run: {
          ...(first ?? {
            page: sourceBox.page,
            fontName: 'source-empty-cell',
            fontSize: 0,
            confidence: 1,
            bold: false,
            italic: false,
          }),
          ...sourceBox,
          text,
        },
        columnIndex: cell.columnIndex,
        columnSpan: cell.columnSpan ?? 1,
        rowSpan: cell.rowSpan ?? 1,
        sourceBox,
        sourceLineIds: [...new Set(sources.map((source) => source.line.id))],
        sourceRegionIds: [
          ...new Set(sources.map((source) => source.region.id)),
        ],
      })
    }
    const rowSources = verifiedCells.flatMap((cell) => cell.sourceBox)
    const left = Math.min(...rowSources.map((box) => box.x))
    const top = Math.min(...rowSources.map((box) => box.y))
    const right = Math.max(...rowSources.map((box) => box.x + box.width))
    const bottom = Math.max(...rowSources.map((box) => box.y + box.height))
    const sourceLineIds = [
      ...new Set(verifiedCells.flatMap((cell) => cell.sourceLineIds)),
    ].sort()
    const sourceRegionIds = [
      ...new Set(verifiedCells.flatMap((cell) => cell.sourceRegionIds)),
    ].sort()
    const rowRuns = verifiedCells.map((cell) => cell.run)
    lines.push({
      id: `provider-table-row-${String(rowIndex + 1).padStart(3, '0')}`,
      text: rowRuns.map((run) => run.text).join(' '),
      fontSize: Math.max(0, ...rowRuns.map((run) => run.fontSize)),
      box: {
        ...sourceCropBox,
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      },
      runs: rowRuns,
      sourceLineIds,
      sourceRegionIds,
      sourceRegionKinds: [
        ...new Set(
          sourceRegions
            .filter((region) => sourceRegionIds.includes(region.id))
            .map((region) => region.kind),
        ),
      ].sort(),
      sourceCellBoxes: verifiedCells.map((cell) => cell.sourceBox),
      cells: verifiedCells.map((cell) => ({
        run: cell.run,
        columnIndex: cell.columnIndex,
        columnSpan: cell.columnSpan,
        rowSpan: cell.rowSpan,
      })),
    })
  }

  if (claimed.size !== allRuns.length) return null
  const sourceLineIds = [
    ...new Set(lines.flatMap((line) => line.sourceLineIds)),
  ].sort()
  return {
    sourceRegions: [...sourceRegions].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    sourceLineIds,
    lines,
    columnCount: proposal.columnCount,
    headerRowCount: proposal.headerRowCount,
    evidence: [
      'bounded-table-scope',
      'table-candidate-provider',
      'table-candidate-cell-source-verified',
      'provider-text-discarded',
    ],
  }
}

export async function runTableCandidateProvider({
  provider,
  image,
  sourceRegions,
  allowRemote = false,
  signal,
  cache,
}: {
  provider: TableCandidateProvider
  image: TableCandidateImage
  sourceRegions: readonly PdfPageRegion[]
  allowRemote?: boolean
  signal?: AbortSignal
  cache?: Map<string, TableCandidateProposal | null>
}): Promise<{
  verified: VerifiedTableCandidate | null
  receipt: TableCandidateReceipt
}> {
  if (!pinnedIdentity(provider.identity)) {
    throw new Error('Table candidate provider identity must be fully pinned.')
  }
  if (!/^[a-f0-9]{64}$/u.test(image.sha256)) {
    throw new Error('Table candidate source image must have a pinned digest.')
  }
  if (sha256HexSync(image.bytes) !== image.sha256) {
    throw new Error(
      'Table candidate source image digest does not match its bytes.',
    )
  }
  const cacheKey = tableCandidateCacheKey(provider.identity, image.sha256)
  const baseReceipt = {
    schemaVersion: TABLE_CANDIDATE_RECEIPT_SCHEMA_VERSION,
    provider: { ...provider.identity, locality: provider.locality },
    sourceImageSha256: image.sha256,
    cacheKey,
  } as const
  const unavailable = (): TableCandidateReceipt => ({
    ...baseReceipt,
    candidateSha256: null,
    verifiedGridSha256: null,
    diagnostic: 'table-candidate-provider-unavailable',
  })
  if (provider.locality === 'remote' && !allowRemote) {
    return { verified: null, receipt: unavailable() }
  }
  try {
    if (provider.available && !(await provider.available())) {
      return { verified: null, receipt: unavailable() }
    }
    let proposal = cache?.get(cacheKey)
    if (proposal === undefined) {
      proposal = await provider.propose({
        image: image.bytes.slice(),
        mediaType: image.mediaType,
        imageSha256: image.sha256,
        signal,
      })
      cache?.set(cacheKey, proposal)
    }
    if (!proposal) {
      const receipt: TableCandidateReceipt = {
        ...baseReceipt,
        candidateSha256: null,
        verifiedGridSha256: null,
        diagnostic: 'table-candidate-no-proposal',
      }
      return { verified: null, receipt }
    }
    const candidateSha256 = sha256HexSync(stableJson(proposal))
    const grid = verifyTableCandidate({
      proposal,
      sourceRegions,
      sourceCropBox: image.sourceCropBox,
    })
    if (!grid) {
      const receipt: TableCandidateReceipt = {
        ...baseReceipt,
        candidateSha256,
        verifiedGridSha256: null,
        diagnostic: 'table-candidate-proposal-failed-verification',
      }
      return { verified: null, receipt }
    }
    const receipt: TableCandidateReceipt = {
      ...baseReceipt,
      candidateSha256,
      verifiedGridSha256: sha256HexSync(stableJson(grid)),
      diagnostic: 'table-candidate-verified',
    }
    return { verified: { grid, receipt }, receipt }
  } catch (error) {
    if (
      error instanceof TableCandidateProviderUnavailableError ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      return { verified: null, receipt: unavailable() }
    }
    // Provider failures are availability failures. Do not serialize arbitrary
    // provider messages, which can contain paths or remote response content.
    return { verified: null, receipt: unavailable() }
  }
}

export type TableCandidatePathCounts = {
  semantic: number
  raster: number
  unresolved: number
}

export function createTableCandidateBenchmarkReport({
  corpusId,
  deterministic,
  provider,
  verifiedProvider,
}: {
  corpusId: string
  deterministic: TableCandidatePathCounts
  provider: TableCandidatePathCounts
  verifiedProvider: TableCandidatePathCounts
}) {
  const paths = { deterministic, provider, verifiedProvider }
  const totals = Object.values(paths).map(
    (counts) => counts.semantic + counts.raster + counts.unresolved,
  )
  if (
    !corpusId ||
    Object.values(paths).some((counts) =>
      Object.values(counts).some(
        (count) => !Number.isSafeInteger(count) || count < 0,
      ),
    ) ||
    totals.some((total) => total !== totals[0])
  ) {
    throw new Error('Three-way table benchmarks require one shared corpus.')
  }
  const report = {
    schemaVersion: '1.0.0' as const,
    corpusId,
    paths,
  }
  return { ...report, sha256: sha256HexSync(stableJson(report)) }
}

import type {
  NormalizedSourceBox,
  PdfPageRegion,
  PdfPreformattedSource,
  PdfPreformattedSourceLine,
  PdfRegionColumn,
} from './import-types'
import { mergePdfRunText } from './pdf-lines'

export type PreformattedLineOwner = {
  region: PdfPageRegion
  line: PdfPageRegion['lines'][number]
  /**
   * Canonical source order is computed from the complete page geometry before
   * a listing is narrowed to its owning lines. Keeping that ordinal on the
   * owner means every later materializer (segments, provenance, and recovered
   * text) reuses the same total order instead of applying a context-free sort.
   */
  canonicalOrder?: number
}

export type BoundedPreformattedSegment = {
  page: number
  sourceLines: PreformattedLineOwner[]
  sourceBox: NormalizedSourceBox
  sourceObjectIds: string[]
  sourceObjectBoxes: NormalizedSourceBox[]
}

export type BoundedPreformattedBlock = {
  caption: PdfPageRegion
  label: string
  semanticKind: 'algorithm' | 'code'
  sourceLines: PreformattedLineOwner[]
  segments: BoundedPreformattedSegment[]
  preformatted: PdfPreformattedSource
  evidence: string[]
  captionFallbackLineId: string | null
}

export const MONOSPACED_SOURCE_FONT =
  /(?:courier|inconsolata|nimbusmon|mono|typewriter|cmtt|lmtt|sftt)/iu

export function normalizedLineageBox(
  source: NormalizedSourceBox,
): NormalizedSourceBox {
  return {
    page: source.page,
    x: source.x,
    y: source.y,
    width: source.width,
    height: source.height,
    rotation: source.rotation,
    method: source.method,
  }
}

export function sourceLineOrder(
  left: PreformattedLineOwner,
  right: PreformattedLineOwner,
) {
  // Every production owner is canonicalized before it reaches a materializer.
  // Keep an uncanonicalized owner deterministic too, and make the mixed case
  // transitive by placing it after the page-wide rank instead of switching
  // between two incomparable relations.
  const leftRank = left.canonicalOrder ?? Number.MAX_SAFE_INTEGER
  const rightRank = right.canonicalOrder ?? Number.MAX_SAFE_INTEGER
  if (leftRank !== rightRank) {
    return leftRank - rightRank
  }
  // Owners created by a narrowly-scoped detector may not have the page-wide
  // ordinal. Their fallback still needs to be a strict total order. In
  // particular, never compare left/right by one rule and single/span by a
  // different rule: that relation is non-transitive when the lanes mix.
  const columnRank = (column: PdfRegionColumn) =>
    column === 'left' ? 0 : column === 'right' ? 1 : column === 'span' ? 2 : 3
  return (
    left.line.box.page - right.line.box.page ||
    columnRank(left.region.column) - columnRank(right.region.column) ||
    left.line.box.y - right.line.box.y ||
    left.line.box.x - right.line.box.x ||
    left.region.id.localeCompare(right.region.id) ||
    left.line.id.localeCompare(right.line.id)
  )
}

export function sourceRegionOrder(left: PdfPageRegion, right: PdfPageRegion) {
  const columnRank = (column: PdfRegionColumn) =>
    column === 'left' ? 0 : column === 'right' ? 1 : column === 'span' ? 2 : 3
  return (
    left.box.y - right.box.y ||
    columnRank(left.column) - columnRank(right.column) ||
    left.box.x - right.box.x ||
    left.id.localeCompare(right.id)
  )
}

/**
 * Build the same page-spanning bands used by the canonical reading-order
 * resolver. A span is emitted after the left/right (or single) regions above
 * it and before the regions below it. The resulting ordinal is a strict total
 * order even when a page mixes left, right, single, and span regions.
 */
export function canonicalSourceLineOwners(
  regions: PdfPageRegion[],
  includeBlankLines = false,
) {
  const eligibleRegions = regions.filter(
    (region) =>
      region.lines.length > 0 &&
      !['header', 'footer', 'page-number'].includes(region.kind),
  )
  const orderedOwners: PreformattedLineOwner[] = []
  const pages = [...new Set(eligibleRegions.map((region) => region.page))].sort(
    (left, right) => left - right,
  )
  for (const page of pages) {
    const pageRegions = eligibleRegions.filter((region) => region.page === page)
    const emitted = new Set<string>()
    const appendRegions = (pageSlice: PdfPageRegion[]) => {
      const columns: PdfRegionColumn[] = ['left', 'right', 'single']
      for (const column of columns) {
        pageSlice
          .filter((region) => region.column === column)
          .sort(sourceRegionOrder)
          .forEach((region) => {
            const lines = [...region.lines]
              .filter((line) => includeBlankLines || line.text.trim())
              .sort(
                (left, right) =>
                  left.box.y - right.box.y ||
                  left.box.x - right.box.x ||
                  left.id.localeCompare(right.id),
              )
            for (const line of lines) {
              orderedOwners.push({ region, line })
            }
            emitted.add(region.id)
          })
      }
      // A page without a detected column split can still contain a source
      // region tagged as span. Keep it deterministic after the ordinary flow.
      pageSlice
        .filter((region) => region.column === 'span')
        .sort(sourceRegionOrder)
        .forEach((region) => {
          const lines = [...region.lines]
            .filter((line) => includeBlankLines || line.text.trim())
            .sort(
              (left, right) =>
                left.box.y - right.box.y ||
                left.box.x - right.box.x ||
                left.id.localeCompare(right.id),
            )
          for (const line of lines) orderedOwners.push({ region, line })
          emitted.add(region.id)
        })
      // A malformed or future column value must not disappear from the order.
      pageSlice
        .filter((region) => !emitted.has(region.id))
        .sort((left, right) => {
          const rank = (column: PdfRegionColumn) =>
            column === 'left'
              ? 0
              : column === 'right'
                ? 1
                : column === 'span'
                  ? 2
                  : 3
          return (
            rank(left.column) - rank(right.column) ||
            sourceRegionOrder(left, right)
          )
        })
        .forEach((region) => {
          for (const line of [...region.lines]
            .filter((line) => includeBlankLines || line.text.trim())
            .sort(
              (left, right) =>
                left.box.y - right.box.y ||
                left.box.x - right.box.x ||
                left.id.localeCompare(right.id),
            )) {
            orderedOwners.push({ region, line })
          }
        })
    }

    const spans = pageRegions
      .filter((region) => region.column === 'span')
      .sort(sourceRegionOrder)
    for (const span of spans) {
      const band = pageRegions.filter(
        (region) =>
          region.column !== 'span' &&
          !emitted.has(region.id) &&
          region.box.y < span.box.y,
      )
      appendRegions(band)
      const spanLines = [...span.lines]
        .filter((line) => includeBlankLines || line.text.trim())
        .sort(
          (left, right) =>
            left.box.y - right.box.y ||
            left.box.x - right.box.x ||
            left.id.localeCompare(right.id),
        )
      for (const line of spanLines) orderedOwners.push({ region: span, line })
      emitted.add(span.id)
    }
    appendRegions(pageRegions.filter((region) => !emitted.has(region.id)))
  }
  return orderedOwners.map((owner, index) => ({
    ...owner,
    canonicalOrder: index,
  }))
}

export function canonicalizeSourceLineOwners(
  regions: PdfPageRegion[],
  owners: PreformattedLineOwner[],
) {
  const orderByLineId = new Map(
    canonicalSourceLineOwners(regions, true).map((owner) => [
      owner.line.id,
      owner.canonicalOrder!,
    ]),
  )
  return owners.map((owner) => ({
    ...owner,
    canonicalOrder: orderByLineId.get(owner.line.id),
  }))
}

export function orderedSourceLines(regions: PdfPageRegion[]) {
  return canonicalSourceLineOwners(regions)
}

export function substantiveSourceRuns(line: PdfPageRegion['lines'][number]) {
  return line.runs.filter((run) => run.text.length > 0)
}

export function monospacedSourceLine(line: PdfPageRegion['lines'][number]) {
  const runs = substantiveSourceRuns(line)
  return (
    runs.length > 0 &&
    runs.every((run) => MONOSPACED_SOURCE_FONT.test(run.fontName))
  )
}

function exactSingleRunSourceLine(line: PdfPageRegion['lines'][number]) {
  const runs = substantiveSourceRuns(line)
  return (
    runs.length === 1 &&
    runs[0].text === line.text &&
    !line.text.includes('\uFFFD')
  )
}

function exactOrderedMultiRunSourceLine(line: PdfPageRegion['lines'][number]) {
  const runs = substantiveSourceRuns(line)
  if (
    runs.length < 2 ||
    line.text.includes('\uFFFD') ||
    runs.some(
      (run) =>
        !run.text.trim() ||
        run.text.includes('\uFFFD') ||
        !Number.isSafeInteger(run.sourceSequenceIndex) ||
        run.sourceSequenceIndex! < 0 ||
        !Number.isSafeInteger(run.page) ||
        run.page < 1 ||
        !Number.isFinite(run.x) ||
        !Number.isFinite(run.y) ||
        !Number.isFinite(run.width) ||
        !Number.isFinite(run.height) ||
        run.width <= 0 ||
        run.height <= 0 ||
        run.page !== line.box.page ||
        run.rotation !== line.box.rotation,
    )
  ) {
    return false
  }
  const containmentTolerance = Math.max(0.00002, line.box.height * 0.05)
  const lineRight = line.box.x + line.box.width
  const lineBottom = line.box.y + line.box.height
  if (
    runs.some(
      (run) =>
        run.x < line.box.x - containmentTolerance ||
        run.y < line.box.y - containmentTolerance ||
        run.x + run.width > lineRight + containmentTolerance ||
        run.y + run.height > lineBottom + containmentTolerance,
    )
  ) {
    return false
  }
  const first = runs[0]
  for (let index = 1; index < runs.length; index += 1) {
    const previous = runs[index - 1]
    const run = runs[index]
    const baselineTolerance = Math.max(
      0.00002,
      Math.min(first.height, run.height) * 0.05,
    )
    const overlapTolerance = Math.max(
      0.00002,
      Math.min(previous.height, run.height) * 0.025,
    )
    const horizontalGap = run.x - (previous.x + previous.width)
    if (
      run.sourceSequenceIndex! <= previous.sourceSequenceIndex! ||
      run.x < previous.x ||
      Math.abs(run.y - first.y) > baselineTolerance ||
      horizontalGap < -overlapTolerance ||
      horizontalGap > Math.max(0.03, line.box.height * 3)
    ) {
      return false
    }
  }
  return mergePdfRunText(runs) === line.text
}

type ExactPreformattedLineProof =
  'exact-single-run-line-text' | 'exact-ordered-multi-run-line-text'

export function exactPreformattedLineProof(
  line: PdfPageRegion['lines'][number],
): ExactPreformattedLineProof | null {
  if (exactSingleRunSourceLine(line)) return 'exact-single-run-line-text'
  if (exactOrderedMultiRunSourceLine(line)) {
    return 'exact-ordered-multi-run-line-text'
  }
  return null
}

export function sourceLineRecord(
  { region, line }: PreformattedLineOwner,
  indentColumns = 0,
): PdfPreformattedSourceLine {
  return {
    text: line.text.replace(/\s+$/u, ''),
    indentColumns,
    sourceRegionId: region.id,
    sourceLineId: line.id,
    sourceBox: normalizedLineageBox(line.box),
    sourceRunBoxes: substantiveSourceRuns(line).map((run) =>
      normalizedLineageBox(run),
    ),
  }
}

export function hasLiteralLeadingWhitespace(value: string) {
  return /^[\t ]/u.test(value)
}

export function attachedPreformattedLabel(value: string) {
  return /^(?:Algorithm|Listing)\s+(?:\d+(?:\.\d+)*[A-Za-z]?|[IVXLCDM]+)(?=$|[\s:.)–—-])/iu.test(
    value.trim(),
  )
}

export function contiguousPreformattedFlow(
  previous: PreformattedLineOwner,
  next: PreformattedLineOwner,
) {
  const sameLane =
    previous.region.column === next.region.column ||
    (['single', 'span'].includes(previous.region.column) &&
      ['single', 'span'].includes(next.region.column))
  if (previous.line.box.page === next.line.box.page && sameLane) {
    const gap =
      next.line.box.y - (previous.line.box.y + previous.line.box.height)
    return gap >= -0.006 && gap <= Math.max(0.03, previous.line.box.height * 2)
  }
  const columnBreak =
    previous.line.box.page === next.line.box.page &&
    previous.region.column === 'left' &&
    next.region.column === 'right'
  const crossPageColumnBreak =
    next.line.box.page === previous.line.box.page + 1 &&
    previous.region.column === 'right' &&
    next.region.column === 'left'
  const pageBreak =
    (next.line.box.page === previous.line.box.page + 1 && sameLane) ||
    crossPageColumnBreak
  return (
    (columnBreak || pageBreak) &&
    previous.line.box.y >= 0.55 &&
    next.line.box.y <= 0.25
  )
}

export function sourceIndentationListingEvidence(
  lines: PreformattedLineOwner[],
) {
  if (lines.length < 4) return false
  const ordered = [...lines].sort(sourceLineOrder)
  const levels: number[] = []
  for (const { line } of ordered) {
    const tolerance = Math.max(0.003, line.box.height * 0.35)
    if (!levels.some((level) => Math.abs(level - line.box.x) <= tolerance)) {
      levels.push(line.box.x)
    }
  }
  levels.sort((left, right) => left - right)
  if (levels.length < 3) return false

  const rightEdges = ordered.map(({ line }) => line.box.x + line.box.width)
  const raggedRange = Math.max(...rightEdges) - Math.min(...rightEdges)
  const orderedHeights = ordered
    .map(({ line }) => line.box.height)
    .sort((left, right) => left - right)
  const medianHeight = orderedHeights[Math.floor(orderedHeights.length / 2)]
  return raggedRange >= Math.max(0.025, medianHeight * 1.5)
}

export type UnresolvedPreformattedDetection = {
  page: number
  regionIds: string[]
  sourceBoxes: NormalizedSourceBox[]
}

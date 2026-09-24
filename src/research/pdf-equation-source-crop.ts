import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
  PdfTextOperationFilterPlan,
} from './import-types'
import { equationRenderOnlySourceRunIdentity } from './equation-render-only-ownership'
import { PDFJS_DISPLAY_OPERATOR_ADAPTER } from './pdf-text-paint'

const EQUATION_EXCLUDED_TEXT_MASK_PIXELS = 2
const EQUATION_EXCLUDED_TEXT_MAX_RENDER_SCALE = 3
const MAX_EQUATION_EXCLUDED_SOURCE_BOXES = 32
const MAX_EQUATION_OWNED_SOURCE_BOXES = 256
const MAX_EQUATION_TEXT_LEDGER_SPANS = 256

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function horizontalBoxOverlap(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  return Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
}

function verticalBoxOverlap(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  return Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  )
}

function materiallyOverlappingSourceBoxes(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  const horizontalOverlap = horizontalBoxOverlap(left, right)
  const verticalOverlap = verticalBoxOverlap(left, right)
  return (
    horizontalOverlap >= Math.min(left.width, right.width) * 0.5 &&
    verticalOverlap >= Math.min(left.height, right.height) * 0.35
  )
}

export function sourceBoxesIntersect(
  left: NormalizedSourceBox,
  right: NormalizedSourceBox,
) {
  return (
    left.page === right.page &&
    left.rotation === right.rotation &&
    horizontalBoxOverlap(left, right) > 0 &&
    verticalBoxOverlap(left, right) > 0
  )
}

function textPaintInventoryRunIdentity(
  run: PdfPageRegion['lines'][number]['runs'][number],
) {
  return JSON.stringify({
    page: run.page,
    sourceSequenceIndex: run.sourceSequenceIndex ?? null,
    text: run.text,
    sourceSemanticAdmission: run.sourceSemanticAdmission ?? null,
    // Flow analysis and DISPLAY inventory derive their boxes independently.
    // Bind ownership to the exact source item and complete paint provenance;
    // the DISPLAY inventory's own box remains authoritative for crop masking.
    sourceTextPaint: run.sourceTextPaint
      ? {
          algorithm: run.sourceTextPaint.algorithm,
          textLedgerSha256: run.sourceTextPaint.textLedgerSha256,
          normalizedTextStart: run.sourceTextPaint.normalizedTextStart,
          normalizedTextEnd: run.sourceTextPaint.normalizedTextEnd,
          operatorLedgerSha256: run.sourceTextPaint.operatorLedgerSha256,
          operationIndexes: [...run.sourceTextPaint.operationIndexes],
          filterableOperationIndexes: [
            ...run.sourceTextPaint.filterableOperationIndexes,
          ],
        }
      : null,
  })
}

export function sourceTextPaintInventoryForPage(
  page: PdfPageAnalysis,
  regions: readonly PdfPageRegion[],
) {
  return (
    page.renderVisibleTextRuns ??
    regions.flatMap((region) =>
      region.page === page.page
        ? region.lines.flatMap((line) => line.runs)
        : [],
    )
  )
}

function ownedEquationTextPaintInventoryKeys(
  sourceLineIds: ReadonlySet<string>,
  regions: readonly PdfPageRegion[],
) {
  return new Set(
    regions.flatMap((region) =>
      region.lines.flatMap((line) =>
        sourceLineIds.has(line.id)
          ? line.runs.map(textPaintInventoryRunIdentity)
          : [],
      ),
    ),
  )
}

function unownedEquationSourceTextBoxes(
  sourceLineIds: ReadonlySet<string>,
  regions: readonly PdfPageRegion[],
  page: number,
  renderVisibleTextRuns: readonly PdfSourceRun[],
  renderOnlyOwnedRunKeys: ReadonlySet<string> = new Set(),
) {
  const ownedRunKeys = ownedEquationTextPaintInventoryKeys(
    sourceLineIds,
    regions,
  )
  const inventoryBoxes = renderVisibleTextRuns.flatMap((run) =>
    run.page === page &&
    run.text.trim().length > 0 &&
    !renderOnlyOwnedRunKeys.has(equationRenderOnlySourceRunIdentity(run)) &&
    !ownedRunKeys.has(textPaintInventoryRunIdentity(run))
      ? [
          {
            page: run.page,
            x: run.x,
            y: run.y,
            width: run.width,
            height: run.height,
            rotation: run.rotation,
            method: run.method,
          },
        ]
      : [],
  )
  const runlessLineBoxes = regions.flatMap((region) =>
    region.page !== page
      ? []
      : region.lines.flatMap((line) =>
          !sourceLineIds.has(line.id) &&
          line.text.trim().length > 0 &&
          line.runs.length === 0
            ? [{ ...line.box }]
            : [],
        ),
  )
  return [...inventoryBoxes, ...runlessLineBoxes]
}

export function sourceTextOperationFilterPlanForEquationCrop(
  sourceCropBox: NormalizedSourceBox,
  sourceLineIds: ReadonlySet<string>,
  regions: readonly PdfPageRegion[],
  renderVisibleTextRuns: readonly PdfSourceRun[],
  renderOnlyOwnedRunKeys: ReadonlySet<string> = new Set(),
): PdfTextOperationFilterPlan | null {
  if (
    regions.some(
      (region) =>
        region.page === sourceCropBox.page &&
        region.lines.some(
          (line) =>
            !sourceLineIds.has(line.id) &&
            line.text.trim().length > 0 &&
            line.runs.length === 0 &&
            sourceBoxesIntersect(sourceCropBox, line.box),
        ),
    )
  ) {
    return null
  }
  const sourceOwnedRuns = regions.flatMap((region) =>
    region.page !== sourceCropBox.page
      ? []
      : region.lines.flatMap((line) =>
          !sourceLineIds.has(line.id)
            ? []
            : line.runs.filter(
                (run) =>
                  run.text.trim() && sourceBoxesIntersect(sourceCropBox, run),
              ),
        ),
  )
  const inventoryByIdentity = new Map(
    renderVisibleTextRuns.map((run) => [
      textPaintInventoryRunIdentity(run),
      run,
    ]),
  )
  const ownedRuns = sourceOwnedRuns.flatMap((run) => {
    const inventoryRun = inventoryByIdentity.get(
      textPaintInventoryRunIdentity(run),
    )
    return inventoryRun ? [inventoryRun] : []
  })
  const ownedRunKeys = new Set(ownedRuns.map(textPaintInventoryRunIdentity))
  const excludedRuns = renderVisibleTextRuns.filter(
    (run) =>
      run.page === sourceCropBox.page &&
      run.text.trim().length > 0 &&
      sourceBoxesIntersect(sourceCropBox, run) &&
      !renderOnlyOwnedRunKeys.has(equationRenderOnlySourceRunIdentity(run)) &&
      !ownedRunKeys.has(textPaintInventoryRunIdentity(run)),
  )
  if (
    sourceOwnedRuns.length === 0 ||
    sourceOwnedRuns.length > MAX_EQUATION_TEXT_LEDGER_SPANS ||
    ownedRuns.length !== sourceOwnedRuns.length ||
    excludedRuns.length === 0 ||
    excludedRuns.length > MAX_EQUATION_TEXT_LEDGER_SPANS ||
    [...ownedRuns, ...excludedRuns].some((run) => !run.sourceTextPaint)
  ) {
    return null
  }
  const provedExcludedRuns = excludedRuns
  const textLedgerIds = new Set(
    [...ownedRuns, ...provedExcludedRuns].map(
      (run) => run.sourceTextPaint!.textLedgerSha256,
    ),
  )
  const spanForRun = (run: (typeof ownedRuns)[number]) => ({
    start: run.sourceTextPaint!.normalizedTextStart,
    end: run.sourceTextPaint!.normalizedTextEnd,
  })
  const spanOrder = (
    left: ReturnType<typeof spanForRun>,
    right: ReturnType<typeof spanForRun>,
  ) => left.start - right.start || left.end - right.end
  const ownedTextLedgerSpans = ownedRuns.map(spanForRun).sort(spanOrder)
  const excludedTextLedgerSpans = provedExcludedRuns
    .map(spanForRun)
    .sort(spanOrder)
  if (
    textLedgerIds.size !== 1 ||
    [...ownedTextLedgerSpans, ...excludedTextLedgerSpans].some(
      ({ start, end }) =>
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start,
    ) ||
    excludedTextLedgerSpans.some((excluded) =>
      ownedTextLedgerSpans.some(
        (owned) =>
          Math.min(excluded.end, owned.end) >
          Math.max(excluded.start, owned.start),
      ),
    )
  ) {
    return null
  }
  const sourceBoxForRun = (
    run: (typeof ownedRuns)[number],
  ): NormalizedSourceBox => ({
    page: run.page,
    x: run.x,
    y: run.y,
    width: run.width,
    height: run.height,
    rotation: run.rotation,
    method: run.method,
  })
  const ownedSourceBoxes = ownedRuns.map(sourceBoxForRun)
  const excludedSourceBoxes = provedExcludedRuns.map(sourceBoxForRun)
  const distinctSourceBoxCount = (boxes: readonly NormalizedSourceBox[]) =>
    new Set(
      boxes.map((box) =>
        [
          box.page,
          box.x,
          box.y,
          box.width,
          box.height,
          box.rotation,
          box.method,
        ].join('\u001f'),
      ),
    ).size
  if (
    distinctSourceBoxCount(ownedSourceBoxes) >
      MAX_EQUATION_OWNED_SOURCE_BOXES ||
    distinctSourceBoxCount(excludedSourceBoxes) >
      MAX_EQUATION_EXCLUDED_SOURCE_BOXES
  ) {
    return null
  }
  return {
    algorithm: 'pdfjs-display-text-operation-filter-v2',
    expansionPixels: 0,
    displayOperatorAdapter: PDFJS_DISPLAY_OPERATOR_ADAPTER,
    renderIntent: 'display',
    annotationMode: 'enable',
    sourceTextLedgerSha256: [...textLedgerIds][0],
    ownedTextLedgerSpans,
    excludedTextLedgerSpans,
    ownedSourceBoxes,
    excludedSourceBoxes,
  }
}

export function hasOverlappingUnownedEquationText(
  ownedSourceBoxes: readonly NormalizedSourceBox[],
  sourceLineIds: ReadonlySet<string>,
  regions: PdfPageRegion[],
  renderVisibleTextRuns: readonly PdfSourceRun[],
  renderOnlyOwnedRunKeys: ReadonlySet<string> = new Set(),
) {
  if (ownedSourceBoxes.length === 0) return false
  const sourcePage = ownedSourceBoxes[0].page
  return unownedEquationSourceTextBoxes(
    sourceLineIds,
    regions,
    sourcePage,
    renderVisibleTextRuns,
    renderOnlyOwnedRunKeys,
  ).some((unowned) =>
    ownedSourceBoxes.some((owned) =>
      materiallyOverlappingSourceBoxes(owned, unowned),
    ),
  )
}

export function unownedSourceTextBoxesInEquationCrop(
  sourceCropBox: NormalizedSourceBox,
  sourceLineIds: ReadonlySet<string>,
  regions: PdfPageRegion[],
  renderVisibleTextRuns: readonly PdfSourceRun[],
  renderOnlyOwnedRunKeys: ReadonlySet<string> = new Set(),
) {
  return unownedEquationSourceTextBoxes(
    sourceLineIds,
    regions,
    sourceCropBox.page,
    renderVisibleTextRuns,
    renderOnlyOwnedRunKeys,
  ).filter((unowned) => sourceBoxesIntersect(sourceCropBox, unowned))
}

export function excludedEquationSourceBoxesForCrop(
  sourceCropBox: NormalizedSourceBox,
  ownedSourceBoxes: readonly NormalizedSourceBox[],
  sourceLineIds: ReadonlySet<string>,
  regions: readonly PdfPageRegion[],
  pageWidth: number,
  pageHeight: number,
) {
  if (ownedSourceBoxes.length === 0) return []
  const ownedUnion = {
    page: sourceCropBox.page,
    x: Math.min(...ownedSourceBoxes.map((box) => box.x)),
    y: Math.min(...ownedSourceBoxes.map((box) => box.y)),
    width:
      Math.max(...ownedSourceBoxes.map((box) => box.x + box.width)) -
      Math.min(...ownedSourceBoxes.map((box) => box.x)),
    height:
      Math.max(...ownedSourceBoxes.map((box) => box.y + box.height)) -
      Math.min(...ownedSourceBoxes.map((box) => box.y)),
    rotation: sourceCropBox.rotation,
    method: 'pdf-text' as const,
  }
  const inlineFormulaBaseIds = new Set(
    [...sourceLineIds].flatMap((lineId) => {
      const match = /^(.*-inline-stacked-\d+)-formula$/u.exec(lineId)
      return match ? [match[1]] : []
    }),
  )
  const sourceRegionIds = new Set(
    regions
      .filter((region) =>
        region.lines.some((line) => sourceLineIds.has(line.id)),
      )
      .map((region) => region.id),
  )
  const sourceColumns = new Set(
    regions
      .filter((region) =>
        region.lines.some((line) => sourceLineIds.has(line.id)),
      )
      .map((region) => region.column),
  )
  const tolerance = 0.00001
  const maximumHorizontalGap =
    EQUATION_EXCLUDED_TEXT_MASK_PIXELS /
      (Math.max(1, pageWidth) * EQUATION_EXCLUDED_TEXT_MAX_RENDER_SCALE) +
    tolerance
  const maximumVerticalGap =
    EQUATION_EXCLUDED_TEXT_MASK_PIXELS /
      (Math.max(1, pageHeight) * EQUATION_EXCLUDED_TEXT_MAX_RENDER_SCALE) +
    tolerance
  const trustedLine = (
    region: PdfPageRegion,
    line: PdfPageRegion['lines'][number],
  ) => {
    if (region.kind !== 'body' && region.kind !== 'spanning') return false
    const inlineSibling = /^(.*-inline-stacked-\d+)-(before|after)$/u.exec(
      line.id,
    )
    if (inlineSibling && inlineFormulaBaseIds.has(inlineSibling[1])) {
      return true
    }
    if (sourceRegionIds.has(region.id)) return true
    const lexicalWords = line.text.match(/\p{L}{2,}/gu) ?? []
    return (
      lexicalWords.length >= 2 &&
      (region.column === 'span' ||
        sourceColumns.has('span') ||
        sourceColumns.has(region.column))
    )
  }
  const directionFor = (box: NormalizedSourceBox) => {
    const aboveGap = ownedUnion.y - (box.y + box.height)
    if (aboveGap >= -tolerance && aboveGap <= maximumVerticalGap) {
      return 'top'
    }
    const belowGap = box.y - (ownedUnion.y + ownedUnion.height)
    if (belowGap >= -tolerance && belowGap <= maximumVerticalGap) {
      return 'bottom'
    }
    return null
  }
  const explicitInlineDirectionFor = (box: NormalizedSourceBox) => {
    const leftGap = ownedUnion.x - (box.x + box.width)
    if (leftGap >= -tolerance && leftGap <= maximumHorizontalGap) {
      return 'left'
    }
    const rightGap = box.x - (ownedUnion.x + ownedUnion.width)
    if (rightGap >= -tolerance && rightGap <= maximumHorizontalGap) {
      return 'right'
    }
    return null
  }
  const nearCropEdge = (
    box: NormalizedSourceBox,
    direction: 'top' | 'bottom' | 'left' | 'right',
  ) => {
    if (direction === 'top') {
      return box.y + box.height >= sourceCropBox.y - maximumVerticalGap
    }
    if (direction === 'bottom') {
      return (
        box.y <= sourceCropBox.y + sourceCropBox.height + maximumVerticalGap
      )
    }
    if (direction === 'left') {
      return box.x + box.width >= sourceCropBox.x - maximumHorizontalGap
    }
    return box.x <= sourceCropBox.x + sourceCropBox.width + maximumHorizontalGap
  }
  const excluded = regions.flatMap((region) =>
    region.page !== sourceCropBox.page
      ? []
      : region.lines.flatMap((line) => {
          if (sourceLineIds.has(line.id) || !trustedLine(region, line)) {
            return []
          }
          const inlineSibling =
            /^(.*-inline-stacked-\d+)-(before|after)$/u.exec(line.id)
          return line.runs.flatMap((run) => {
            if (!run.text.trim()) return []
            const box: NormalizedSourceBox = {
              page: run.page,
              x: run.x,
              y: run.y,
              width: run.width,
              height: run.height,
              rotation: run.rotation,
              method: run.method,
            }
            const direction =
              directionFor(box) ??
              (inlineSibling && inlineFormulaBaseIds.has(inlineSibling[1])
                ? explicitInlineDirectionFor(box)
                : null)
            if (
              !direction ||
              !nearCropEdge(box, direction) ||
              ((direction === 'top' || direction === 'bottom') &&
                horizontalBoxOverlap(sourceCropBox, box) <= 0) ||
              ((direction === 'left' || direction === 'right') &&
                verticalBoxOverlap(sourceCropBox, box) <= 0)
            ) {
              return []
            }
            return [box]
          })
        }),
  )
  const canonical = [
    ...new Map(
      excluded.map(
        (box) =>
          [
            [
              box.page,
              rounded(box.x),
              rounded(box.y),
              rounded(box.width),
              rounded(box.height),
              box.rotation,
              box.method,
            ].join('\u001f'),
            {
              ...box,
              x: rounded(box.x),
              y: rounded(box.y),
              width: rounded(box.width),
              height: rounded(box.height),
            },
          ] as const,
      ),
    ).values(),
  ].sort(
    (left, right) =>
      [
        left.page - right.page,
        left.y - right.y,
        left.x - right.x,
        left.height - right.height,
        left.width - right.width,
        left.rotation - right.rotation,
        left.method.localeCompare(right.method),
      ].find((difference) => difference !== 0) ?? 0,
  )
  return canonical.length <= MAX_EQUATION_EXCLUDED_SOURCE_BOXES ? canonical : []
}

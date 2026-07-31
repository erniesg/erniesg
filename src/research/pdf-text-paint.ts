import { sha256HexSync } from './sha256-sync'
import type { PdfTextPaintRunProvenance } from './import-types'

type PdfOperatorList = {
  fnArray: readonly number[]
  argsArray: readonly unknown[]
}

export const PDFJS_DISPLAY_OPERATOR_ADAPTER =
  'pdfjs-5.4.624-display-intent-v1' as const
export const PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION = '5.4.624'
export const PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD = '384c6208b'
export const MAX_PDF_TEXT_OPERATION_FILTER_INDEX_COUNT = 4_096
export const PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS = {
  setGState: 9,
  save: 10,
  restore: 11,
  transform: 12,
  beginText: 31,
  endText: 32,
  setCharSpacing: 33,
  setWordSpacing: 34,
  setHScale: 35,
  setLeading: 36,
  setFont: 37,
  setTextRenderingMode: 38,
  setTextRise: 39,
  moveText: 40,
  setLeadingMoveText: 41,
  setTextMatrix: 42,
  nextLine: 43,
  showText: 44,
  showSpacedText: 45,
  nextLineShowText: 46,
  nextLineSetSpacingShowText: 47,
} as const
const PDFJS_TEXT_PAINT_OPERATION_IDS = new Set<number>([
  PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.showText,
  PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.showSpacedText,
  PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.nextLineShowText,
  PDFJS_DISPLAY_OPERATOR_ADAPTER_OPS.nextLineSetSpacingShowText,
])

export function isBoundedPdfTextOperationFilterIndexes(
  values: readonly number[],
  operatorListLength?: number,
) {
  return (
    values.length > 0 &&
    values.length <= MAX_PDF_TEXT_OPERATION_FILTER_INDEX_COUNT &&
    values.every(
      (value) =>
        Number.isSafeInteger(value) &&
        value >= 0 &&
        (operatorListLength === undefined || value < operatorListLength),
    ) &&
    new Set(values).size === values.length
  )
}

function canonicalGlyphText(args: unknown) {
  if (!Array.isArray(args) || args.length !== 1 || !Array.isArray(args[0])) {
    return null
  }
  let text = ''
  for (const glyph of args[0]) {
    if (typeof glyph === 'number') continue
    if (
      !glyph ||
      typeof glyph !== 'object' ||
      typeof (glyph as { unicode?: unknown }).unicode !== 'string'
    ) {
      return null
    }
    text += (glyph as { unicode: string }).unicode
  }
  return text
}

export function normalizedPdfTextLedgerText(value: string) {
  return value.normalize('NFKC').replace(/\s+/gu, '')
}

export function pdfTextLedgerSha256(value: string) {
  return sha256HexSync(
    JSON.stringify({
      algorithm: 'pdf-normalized-text-ledger-v1',
      text: value,
    }),
  )
}

function canonicalObjectKeyOrder(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function stablePdfjsTextStateString(value: string) {
  return value.replace(/^g_d\d+(?=_)/u, 'g_d*')
}

function exactString(value: string) {
  return value
}

function canonicalPrimitive(
  value: unknown,
  stableString: (candidate: string) => string = exactString,
): unknown {
  if (value === null || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') return stableString(value)
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? Object.is(value, -0)
        ? 0
        : value
      : String(value)
  }
  if (Array.isArray(value)) {
    return value.map((candidate) => canonicalPrimitive(candidate, stableString))
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    )
    return {
      type: value.constructor.name,
      byteLength: value.byteLength,
      sha256: sha256HexSync(bytes),
    }
  }
  if (value instanceof ArrayBuffer) {
    return {
      type: 'ArrayBuffer',
      byteLength: value.byteLength,
      sha256: sha256HexSync(new Uint8Array(value)),
    }
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, candidate]) => typeof candidate !== 'function')
        .sort(([left], [right]) => canonicalObjectKeyOrder(left, right))
        .map(([key, candidate]) => [
          key,
          canonicalPrimitive(candidate, stableString),
        ]),
    )
  }
  return String(value)
}

function pdfOperationIdentity(
  operatorList: PdfOperatorList,
  index: number,
): string | null {
  try {
    return JSON.stringify({
      operation: operatorList.fnArray[index],
      args: canonicalPrimitive(operatorList.argsArray[index]),
    })
  } catch {
    return null
  }
}

export function createPdfDisplayOperationsFilterAttestation({
  operatorList,
  excludedOperationIndexes,
}: {
  operatorList: PdfOperatorList
  excludedOperationIndexes: readonly number[]
}) {
  if (
    operatorList.fnArray.length === 0 ||
    operatorList.fnArray.length !== operatorList.argsArray.length
  ) {
    return null
  }
  const expectedOperationIdentities = operatorList.fnArray.map(
    (_operation, index) => pdfOperationIdentity(operatorList, index),
  )
  if (expectedOperationIdentities.some((identity) => identity === null)) {
    return null
  }
  const exactOperationStreamSha256 = sha256HexSync(
    JSON.stringify(expectedOperationIdentities),
  )
  const excluded = new Set(excludedOperationIndexes)
  let previousIndex: number | null = null
  let valid = true
  const visited = new Uint8Array(operatorList.fnArray.length)
  return {
    exactOperationStreamSha256,
    operationsFilter(index: number) {
      const identity =
        Number.isInteger(index) &&
        index >= 0 &&
        index < operatorList.fnArray.length
          ? pdfOperationIdentity(operatorList, index)
          : null
      if (
        identity === null ||
        identity !== expectedOperationIdentities[index] ||
        (previousIndex === null
          ? index !== 0
          : index !== previousIndex && index !== previousIndex + 1)
      ) {
        valid = false
        return false
      }
      previousIndex = index
      visited[index] = 1
      return !excluded.has(index)
    },
    hasCompleteExactCoverage() {
      return (
        valid &&
        previousIndex === operatorList.fnArray.length - 1 &&
        visited.every((value) => value === 1)
      )
    },
  }
}

function overlappingIndexes(
  start: number,
  end: number,
  spans: readonly { index: number; start: number; end: number }[],
) {
  return spans
    .filter((span) => Math.min(end, span.end) > Math.max(start, span.start))
    .map((span) => span.index)
}

type TextLedgerSpan = { start: number; end: number }

function canonicalTextLedgerSpans(spans: readonly TextLedgerSpan[]) {
  if (
    spans.length === 0 ||
    spans.some(
      ({ start, end }) =>
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start,
    )
  ) {
    return null
  }
  const sorted = spans
    .map(({ start, end }) => ({ start, end }))
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: TextLedgerSpan[] = []
  for (const span of sorted) {
    const previous = merged.at(-1)
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end)
    } else {
      merged.push(span)
    }
  }
  return merged
}

function spanContainedByUnion(
  span: TextLedgerSpan,
  union: readonly TextLedgerSpan[],
) {
  return union.some(
    (candidate) => span.start >= candidate.start && span.end <= candidate.end,
  )
}

function unionsOverlap(
  left: readonly TextLedgerSpan[],
  right: readonly TextLedgerSpan[],
) {
  return left.some((leftSpan) =>
    right.some(
      (rightSpan) =>
        Math.min(leftSpan.end, rightSpan.end) >
        Math.max(leftSpan.start, rightSpan.start),
    ),
  )
}

function displayTextOperationSpans({
  operatorList,
  showTextOperation,
  textPaintOperations,
}: {
  operatorList: PdfOperatorList
  showTextOperation: number
  textPaintOperations: ReadonlySet<number>
}) {
  if (
    operatorList.fnArray.length !== operatorList.argsArray.length ||
    !textPaintOperations.has(showTextOperation) ||
    operatorList.fnArray.some(
      (operation) =>
        textPaintOperations.has(operation) && operation !== showTextOperation,
    )
  ) {
    return null
  }
  let cursor = 0
  const spans: (TextLedgerSpan & {
    index: number
    text: string
    normalizationErasedPaint: boolean
  })[] = []
  for (const [index, operation] of operatorList.fnArray.entries()) {
    if (operation !== showTextOperation) continue
    const text = canonicalGlyphText(operatorList.argsArray[index])
    if (text === null) return null
    if (/\s/u.test(text)) return null
    const normalized = normalizedPdfTextLedgerText(text)
    const start = cursor
    cursor += normalized.length
    if (normalized.length > 0) {
      spans.push({
        index,
        start,
        end: cursor,
        text: normalized,
        normalizationErasedPaint: false,
      })
    }
  }
  return spans
}

export function provePdfDisplayTextOperationFilter({
  operatorList,
  sourceTextLedgerSha256,
  ownedTextLedgerSpans,
  excludedTextLedgerSpans,
  showTextOperation,
  textPaintOperations,
  textStateOperations,
  setTextRenderingModeOperation,
  textPositionResetOperations,
  beginTextOperation,
  endTextOperation,
  saveOperation,
  restoreOperation,
}: {
  operatorList: PdfOperatorList
  sourceTextLedgerSha256: string
  ownedTextLedgerSpans: readonly TextLedgerSpan[]
  excludedTextLedgerSpans: readonly TextLedgerSpan[]
  showTextOperation: number
  textPaintOperations: ReadonlySet<number>
  textStateOperations: ReadonlySet<number>
  setTextRenderingModeOperation: number
  textPositionResetOperations: ReadonlySet<number>
  beginTextOperation: number
  endTextOperation: number
  saveOperation: number
  restoreOperation: number
}) {
  const ownedUnion = canonicalTextLedgerSpans(ownedTextLedgerSpans)
  const excludedUnion = canonicalTextLedgerSpans(excludedTextLedgerSpans)
  if (
    !ownedUnion ||
    !excludedUnion ||
    unionsOverlap(ownedUnion, excludedUnion)
  ) {
    return null
  }
  const operationSpans = displayTextOperationSpans({
    operatorList,
    showTextOperation,
    textPaintOperations,
  })
  if (!operationSpans) return null
  const displayTextLedgerSha256 = pdfTextLedgerSha256(
    operationSpans.map(({ text }) => text).join(''),
  )
  if (displayTextLedgerSha256 !== sourceTextLedgerSha256) return null

  const indexesForUnion = (union: readonly TextLedgerSpan[]) => {
    const overlapping = operationSpans.filter((operationSpan) =>
      union.some(
        (span) =>
          Math.min(operationSpan.end, span.end) >
          Math.max(operationSpan.start, span.start),
      ),
    )
    if (
      overlapping.length === 0 ||
      overlapping.some(
        (operationSpan) => operationSpan.normalizationErasedPaint,
      ) ||
      overlapping.some(
        (operationSpan) => !spanContainedByUnion(operationSpan, union),
      ) ||
      union.some(
        (span) =>
          !overlapping.some(
            (operationSpan) =>
              Math.min(operationSpan.end, span.end) >
              Math.max(operationSpan.start, span.start),
          ),
      )
    ) {
      return null
    }
    return [...new Set(overlapping.map(({ index }) => index))].sort(
      (left, right) => left - right,
    )
  }
  const ownedOperationIndexes = indexesForUnion(ownedUnion)
  const excludedOperationIndexes = indexesForUnion(excludedUnion)
  const ownedOperationIndexSet = new Set(ownedOperationIndexes ?? [])
  const ownedOnlyExcludedOperationIndexes = operatorList.fnArray.flatMap(
    (operation, index) =>
      operation === showTextOperation && !ownedOperationIndexSet.has(index)
        ? [index]
        : [],
  )
  if (
    !ownedOperationIndexes ||
    !excludedOperationIndexes ||
    !isBoundedPdfTextOperationFilterIndexes(
      ownedOperationIndexes,
      operatorList.fnArray.length,
    ) ||
    !isBoundedPdfTextOperationFilterIndexes(
      excludedOperationIndexes,
      operatorList.fnArray.length,
    ) ||
    !isBoundedPdfTextOperationFilterIndexes(
      ownedOnlyExcludedOperationIndexes,
      operatorList.fnArray.length,
    ) ||
    excludedOperationIndexes.some((index) =>
      ownedOperationIndexes.includes(index),
    ) ||
    !safePdfTextOperationFilter({
      operatorList,
      excludedOperationIndexes,
      showTextOperation,
      setTextRenderingModeOperation,
      textPositionResetOperations,
      beginTextOperation,
      endTextOperation,
      saveOperation,
      restoreOperation,
    }) ||
    !safePdfTextOperationFilter({
      operatorList,
      excludedOperationIndexes: ownedOnlyExcludedOperationIndexes,
      showTextOperation,
      setTextRenderingModeOperation,
      textPositionResetOperations,
      beginTextOperation,
      endTextOperation,
      saveOperation,
      restoreOperation,
    })
  ) {
    return null
  }
  const operatorLedgerSha256 = pdfTextPaintOperatorLedgerSha256({
    operatorList,
    textStateOperations,
  })
  return operatorLedgerSha256
    ? {
        displayTextLedgerSha256,
        operatorLedgerSha256,
        ownedOperationIndexes,
        excludedOperationIndexes,
        ownedOnlyExcludedOperationIndexes,
      }
    : null
}

type PdfjsDisplayIntentState = {
  displayReadyCapability?: {
    promise?: Promise<unknown>
    resolve?: (value: unknown) => void
    reject?: (reason: unknown) => void
  }
  opListReadCapability?: unknown
  operatorList?: {
    fnArray?: unknown
    argsArray?: unknown
    lastChunk?: unknown
    separateAnnots?: unknown
  }
  renderTasks?: unknown
  streamReader?: unknown
}

export function capturePinnedPdfjsDisplayOperatorList({
  page,
  pdfjsVersion,
  pdfjsBuild,
}: {
  page: { _intentStates?: unknown }
  pdfjsVersion: string
  pdfjsBuild: string
}): PdfOperatorList | null {
  if (
    pdfjsVersion !== PDFJS_DISPLAY_OPERATOR_ADAPTER_VERSION ||
    pdfjsBuild !== PDFJS_DISPLAY_OPERATOR_ADAPTER_BUILD ||
    !(page._intentStates instanceof Map)
  ) {
    return null
  }
  const candidates = [...page._intentStates.entries()].filter(
    (entry): entry is [string, PdfjsDisplayIntentState] => {
      const [cacheKey, candidate] = entry
      if (!candidate || typeof candidate !== 'object') return false
      const state = candidate as PdfjsDisplayIntentState
      const capability = state.displayReadyCapability
      const operatorList = state.operatorList
      return Boolean(
        typeof cacheKey === 'string' &&
        cacheKey.split('_', 1)[0] === '2' &&
        Object.getPrototypeOf(state) === null &&
        Object.keys(state).sort().join(',') ===
          'displayReadyCapability,operatorList,renderTasks,streamReader' &&
        capability &&
        typeof capability === 'object' &&
        Object.keys(capability).sort().join(',') === 'promise,reject,resolve' &&
        capability.promise instanceof Promise &&
        typeof capability.resolve === 'function' &&
        typeof capability.reject === 'function' &&
        operatorList &&
        Object.keys(operatorList).sort().join(',') ===
          'argsArray,fnArray,lastChunk,separateAnnots' &&
        Array.isArray(operatorList.fnArray) &&
        Array.isArray(operatorList.argsArray) &&
        operatorList.fnArray.length === operatorList.argsArray.length &&
        operatorList.fnArray.length > 0 &&
        operatorList.fnArray.every(
          (operation) =>
            Number.isInteger(operation) && operation >= 1 && operation <= 94,
        ) &&
        operatorList.lastChunk === true &&
        (operatorList.separateAnnots === null ||
          (operatorList.separateAnnots !== null &&
            typeof operatorList.separateAnnots === 'object' &&
            Object.keys(operatorList.separateAnnots).sort().join(',') ===
              'canvas,form' &&
            typeof (operatorList.separateAnnots as { canvas?: unknown })
              .canvas === 'boolean' &&
            typeof (operatorList.separateAnnots as { form?: unknown }).form ===
              'boolean')) &&
        state.renderTasks instanceof Set &&
        state.renderTasks.size === 0 &&
        state.streamReader === null,
      )
    },
  )
  if (candidates.length !== 1) return null
  const operatorList = candidates[0][1].operatorList!
  return {
    fnArray: operatorList.fnArray as number[],
    argsArray: operatorList.argsArray as unknown[],
  }
}

export function pdfTextPaintOperatorLedgerSha256({
  operatorList,
  textStateOperations,
}: {
  operatorList: PdfOperatorList
  textStateOperations: ReadonlySet<number>
}) {
  if (operatorList.fnArray.length !== operatorList.argsArray.length) return null
  return sha256HexSync(
    JSON.stringify({
      algorithm: 'pdfjs-text-paint-operator-ledger-v2',
      fnArray: operatorList.fnArray,
      textState: operatorList.fnArray.flatMap((operation, index) =>
        textStateOperations.has(operation)
          ? [
              {
                index,
                operation,
                args: canonicalPrimitive(
                  operatorList.argsArray[index],
                  PDFJS_TEXT_PAINT_OPERATION_IDS.has(operation)
                    ? exactString
                    : stablePdfjsTextStateString,
                ),
              },
            ]
          : [],
      ),
    }),
  )
}

export function safePdfTextOperationFilter({
  operatorList,
  excludedOperationIndexes,
  showTextOperation,
  setTextRenderingModeOperation,
  textPositionResetOperations,
  beginTextOperation,
  endTextOperation,
  saveOperation,
  restoreOperation,
}: {
  operatorList: PdfOperatorList
  excludedOperationIndexes: readonly number[]
  showTextOperation: number
  setTextRenderingModeOperation: number
  textPositionResetOperations: ReadonlySet<number>
  beginTextOperation: number
  endTextOperation: number
  saveOperation: number
  restoreOperation: number
}) {
  const excluded = new Set(excludedOperationIndexes)
  if (
    excluded.size === 0 ||
    excluded.size !== excludedOperationIndexes.length ||
    [...excluded].some(
      (index) =>
        !Number.isInteger(index) ||
        index < 0 ||
        operatorList.fnArray[index] !== showTextOperation,
    )
  ) {
    return false
  }
  let textRenderingMode = 0
  let insideTextObject = false
  const savedTextRenderingModes: number[] = []
  for (const [index, operation] of operatorList.fnArray.entries()) {
    if (operation === beginTextOperation) {
      if (insideTextObject) return false
      insideTextObject = true
    } else if (operation === endTextOperation) {
      if (!insideTextObject) return false
      insideTextObject = false
    } else if (operation === showTextOperation && !insideTextObject) {
      return false
    }
    if (operation === saveOperation) {
      savedTextRenderingModes.push(textRenderingMode)
    } else if (operation === restoreOperation) {
      const restored = savedTextRenderingModes.pop()
      if (restored === undefined) return false
      textRenderingMode = restored
    }
    if (operation === setTextRenderingModeOperation) {
      const args = operatorList.argsArray[index]
      if (
        !Array.isArray(args) ||
        args.length !== 1 ||
        !Number.isInteger(args[0])
      ) {
        return false
      }
      textRenderingMode = Number(args[0])
    }
    if (excluded.has(index) && (textRenderingMode & 4) !== 0) return false
  }
  if (insideTextObject || savedTextRenderingModes.length > 0) return false
  for (const excludedIndex of excluded) {
    let resetBeforeNextRetainedPaint = false
    let endedTextObject = false
    for (
      let index = excludedIndex + 1;
      index < operatorList.fnArray.length;
      index += 1
    ) {
      const operation = operatorList.fnArray[index]
      if (operation === endTextOperation) {
        endedTextObject = true
        resetBeforeNextRetainedPaint = false
      } else if (operation === beginTextOperation && endedTextObject) {
        resetBeforeNextRetainedPaint = true
        endedTextObject = false
      } else if (textPositionResetOperations.has(operation)) {
        resetBeforeNextRetainedPaint = true
      }
      if (operation !== showTextOperation) continue
      if (excluded.has(index)) continue
      if (!resetBeforeNextRetainedPaint) return false
      break
    }
  }
  return true
}

export function provePdfTextPaintRunProvenance({
  textContentItems,
  operatorList,
  showTextOperation,
  textPaintOperations,
  textStateOperations,
}: {
  textContentItems: readonly unknown[]
  operatorList: PdfOperatorList
  showTextOperation: number
  textPaintOperations: ReadonlySet<number>
  textStateOperations: ReadonlySet<number>
}) {
  if (
    operatorList.fnArray.length !== operatorList.argsArray.length ||
    !textPaintOperations.has(showTextOperation)
  ) {
    return new Map<number, PdfTextPaintRunProvenance>()
  }
  const unsupportedPaint = operatorList.fnArray.some(
    (operation) =>
      textPaintOperations.has(operation) && operation !== showTextOperation,
  )
  if (unsupportedPaint) return new Map<number, PdfTextPaintRunProvenance>()

  let itemCursor = 0
  const itemSpans = textContentItems.flatMap((item, sourceItemIndex) => {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof (item as { str?: unknown }).str !== 'string'
    ) {
      return []
    }
    const text = (item as { str: string }).str
    const normalized = normalizedPdfTextLedgerText(text)
    const start = itemCursor
    itemCursor += normalized.length
    return normalized.length > 0
      ? [{ sourceItemIndex, start, end: itemCursor }]
      : []
  })
  let operationCursor = 0
  const operationSpans: {
    index: number
    start: number
    end: number
    text: string
  }[] = []
  for (const [index, operation] of operatorList.fnArray.entries()) {
    if (operation !== showTextOperation) continue
    const text = canonicalGlyphText(operatorList.argsArray[index])
    if (text === null) return new Map<number, PdfTextPaintRunProvenance>()
    const normalized = normalizedPdfTextLedgerText(text)
    const start = operationCursor
    operationCursor += normalized.length
    if (normalized.length > 0) {
      operationSpans.push({ index, start, end: operationCursor, text })
    }
  }
  const itemLedger = itemSpans
    .map(({ sourceItemIndex }) =>
      normalizedPdfTextLedgerText(
        (textContentItems[sourceItemIndex] as { str: string }).str,
      ),
    )
    .join('')
  const operationLedger = operationSpans
    .map(({ text }) => normalizedPdfTextLedgerText(text))
    .join('')
  if (itemLedger.length === 0 || itemLedger !== operationLedger) {
    return new Map<number, PdfTextPaintRunProvenance>()
  }
  const textLedgerSha256 = pdfTextLedgerSha256(itemLedger)

  const operatorLedgerSha256 = pdfTextPaintOperatorLedgerSha256({
    operatorList,
    textStateOperations,
  })!
  return new Map(
    itemSpans.map(({ sourceItemIndex, start, end }) => {
      const operationIndexes = overlappingIndexes(start, end, operationSpans)
      const filterableOperationIndexes = operationSpans
        .filter((span) => span.start >= start && span.end <= end)
        .map((span) => span.index)
      return [
        sourceItemIndex,
        {
          algorithm: 'pdfjs-text-paint-run-v1',
          textLedgerSha256,
          normalizedTextStart: start,
          normalizedTextEnd: end,
          operatorLedgerSha256,
          operationIndexes,
          filterableOperationIndexes,
        } satisfies PdfTextPaintRunProvenance,
      ] as const
    }),
  )
}

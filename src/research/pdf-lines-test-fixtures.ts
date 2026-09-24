import type { PdfTextLine } from './pdf-lines'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'

export function line(text: string): PdfTextLine {
  return {
    page: 1,
    text,
    x: 0.1,
    y: 0.2,
    width: 0.7,
    height: 0.02,
    fontSize: 10,
    runs: [],
    column: 'single',
  }
}

export function wrappedLines(before: string, after: string) {
  return [
    { ...line(before), y: 0.2 },
    { ...line(after), y: 0.222 },
  ]
}

export const SOURCE_OWNERSHIP_TEXT_LEDGER = 'a'.repeat(64)
export const SOURCE_OWNERSHIP_OPERATOR_LEDGER = 'b'.repeat(64)

export function sourceOwnershipRun({
  text,
  x,
  y,
  width,
  height = 0.0142,
  fontSize = 12,
  fontName = 'Synthetic-CMR12',
  sourceSequenceIndex,
  paint = true,
  page = 1,
  method = 'pdf-text',
  operatorLedgerSha256 = SOURCE_OWNERSHIP_OPERATOR_LEDGER,
}: {
  text: string
  x: number
  y: number
  width: number
  height?: number
  fontSize?: number
  fontName?: string
  sourceSequenceIndex: number
  paint?: boolean
  page?: number
  method?: PdfSourceRun['method']
  operatorLedgerSha256?: string
}): PdfSourceRun {
  return {
    page,
    text,
    x,
    y,
    width,
    height,
    fontSize,
    fontName,
    rotation: 0,
    method,
    confidence: 1,
    sourceSequenceIndex,
    ...(paint
      ? {
          sourceTextPaint: {
            algorithm: 'pdfjs-text-paint-run-v1',
            textLedgerSha256: SOURCE_OWNERSHIP_TEXT_LEDGER,
            normalizedTextStart: sourceSequenceIndex,
            normalizedTextEnd: sourceSequenceIndex + text.length,
            operatorLedgerSha256,
            operationIndexes: [sourceSequenceIndex],
            filterableOperationIndexes: [sourceSequenceIndex],
          } as const,
        }
      : {}),
  }
}

export function sourceOwnershipPage(runs: PdfSourceRun[]): PdfPageAnalysis {
  return {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, run) => total + run.text.length, 0),
    imageCount: 0,
    objects: [],
    runs,
  }
}

export function singleSourceOwnershipCluster() {
  return [
    sourceOwnershipRun({
      text: 'Let',
      x: 0.1,
      y: 0.2,
      width: 0.03,
      sourceSequenceIndex: 0,
    }),
    sourceOwnershipRun({
      text: 'νij,t describes the time-varying co-jump measure on R2',
      x: 0.135,
      y: 0.2,
      width: 0.745,
      fontName: 'Synthetic-CMMI12',
      sourceSequenceIndex: 1,
    }),
    sourceOwnershipRun({
      text: 'Writing Δ',
      x: 0.1,
      y: 0.217,
      width: 0.25,
      sourceSequenceIndex: 2,
    }),
    sourceOwnershipRun({
      text: 'S',
      x: 0.35,
      y: 0.217,
      width: 0.012,
      fontName: 'Synthetic-CMMI12',
      sourceSequenceIndex: 3,
    }),
    sourceOwnershipRun({
      text: '(',
      x: 0.362,
      y: 0.2055,
      width: 0.009,
      fontName: 'Synthetic-CMEX10',
      sourceSequenceIndex: 4,
    }),
    sourceOwnershipRun({
      text: 'x',
      x: 0.371,
      y: 0.217,
      width: 0.011,
      fontName: 'Synthetic-CMMI12',
      sourceSequenceIndex: 5,
    }),
    sourceOwnershipRun({
      text: '+z',
      x: 0.384,
      y: 0.217,
      width: 0.027,
      fontName: 'Synthetic-CMMI12',
      sourceSequenceIndex: 6,
    }),
    sourceOwnershipRun({
      text: ') and a short-maturity expansion follows.',
      x: 0.414,
      y: 0.217,
      width: 0.36,
      sourceSequenceIndex: 7,
    }),
  ]
}

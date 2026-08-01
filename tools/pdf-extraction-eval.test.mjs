import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  EXTRACTION_LAYOUTS,
  EXTRACTION_STRATA,
  comparePdfExtractionProviders,
  createAbstainingPdfExtractionCandidate,
  validatePdfExtractionEvalSet,
  validatePdfExtractionEvalSetFiles,
} from './pdf-extraction-eval.mjs'

const evalPath = 'benchmarks/pdf/extraction-eval-strata-v1.json'

async function readEvalSet() {
  return JSON.parse(await readFile(evalPath, 'utf8'))
}

describe('source-reviewed PDF extraction strata benchmark', () => {
  it('validates the reviewed table/structure slice and both layout lanes', async () => {
    const evalSet = await readEvalSet()
    const identity = await validatePdfExtractionEvalSetFiles(evalSet)

    expect(identity).toMatchObject({
      valid: true,
      documentCount: 4,
      caseCount: 19,
      stratumCount: 8,
      layoutCounts: { 'one-column': 2, 'two-column': 2 },
    })
    expect(EXTRACTION_LAYOUTS).toEqual(['one-column', 'two-column'])
    expect(EXTRACTION_STRATA).toEqual([
      'table-structure',
      'heading-structure',
      'display-equation',
      'figure-diagram',
      'prose-continuity',
      'boilerplate-exclusion',
      'footnote-resolution',
      'column-layout',
    ])
    expect(
      evalSet.cases
        .filter(({ stratum }) => stratum === 'table-structure')
        .every(({ source }) =>
          source.groundTruth.tables.every(
            (table) =>
              table.rows * table.columns === table.cells.length &&
              table.cells.every((cell) => typeof cell.text === 'string'),
          ),
        ),
    ).toBe(true)
    expect(
      evalSet.cases.some(
        ({ stratum, source }) =>
          stratum === 'heading-structure' &&
          source.groundTruth.headings.some(({ language }) => language === 'zh'),
      ),
    ).toBe(true)
  })

  it('rejects parser output being relabeled as source ground truth', async () => {
    const evalSet = await readEvalSet()
    evalSet.cases[0].source.groundTruth.review.parserOutputConsulted = true
    expect(() => validatePdfExtractionEvalSet(evalSet)).toThrow(
      'INVALID_PDF_EXTRACTION_EVAL_SET',
    )
  })

  it('reports deterministic and every configured candidate by stratum and layout', async () => {
    const evalSet = await readEvalSet()
    const providers = [
      createAbstainingPdfExtractionCandidate(evalSet, {
        id: 'deterministic-path',
        kind: 'deterministic',
        version: 'fixture-baseline-v1',
      }),
      createAbstainingPdfExtractionCandidate(evalSet, {
        id: 'candidate-a',
        kind: 'candidate',
        version: 'candidate-a-v1',
      }),
      createAbstainingPdfExtractionCandidate(evalSet, {
        id: 'candidate-b',
        kind: 'candidate',
        version: 'candidate-b-v1',
      }),
    ]
    const report = comparePdfExtractionProviders(evalSet, providers)

    expect(report.privacy).toBe(
      'identities-hashes-counts-diagnostic-codes-only',
    )
    expect(report.providers).toHaveLength(3)
    expect(report.rows).toHaveLength(3 * 8 * 2)
    expect(report.rows.every((row) => row.score === 0.25)).toBe(true)
    expect(new Set(report.rows.map(({ stratum }) => stratum))).toEqual(
      new Set(EXTRACTION_STRATA),
    )
    expect(new Set(report.rows.map(({ layout }) => layout))).toEqual(
      new Set(EXTRACTION_LAYOUTS),
    )
  })

  it('scores abstention above guarded degenerate answers', async () => {
    const evalSet = await readEvalSet()
    const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
      id: 'candidate-a',
      kind: 'candidate',
      version: 'candidate-a-v1',
    })
    const tableCase = candidate.cases.find((item) =>
      item.caseId.endsWith('.table-structure'),
    )
    tableCase.status = 'scored'
    tableCase.prediction = {
      tables: [
        { pageWide: true, rows: 1, columns: 1, headerScope: 'none', cells: [] },
      ],
    }
    tableCase.diagnostics = []
    const report = comparePdfExtractionProviders(evalSet, [candidate])
    const tableRow = report.rows.find(
      (row) => row.stratum === 'table-structure' && row.layout === 'one-column',
    )
    const abstainedRows = report.rows.filter(
      (row) => row.stratum !== 'table-structure',
    )
    expect(tableRow).toMatchObject({ degenerateCaseCount: 1, score: 0 })
    expect(abstainedRows.every((row) => row.score === 0.25)).toBe(true)
  })

  it('refuses regex-only prose continuity evidence', async () => {
    const evalSet = await readEvalSet()
    const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
      id: 'candidate-a',
      kind: 'candidate',
      version: 'candidate-a-v1',
    })
    const proseCase = candidate.cases.find((item) =>
      item.caseId.endsWith('.prose-continuity'),
    )
    proseCase.status = 'scored'
    proseCase.prediction = { regexBrokenJoinCount: 204 }
    proseCase.diagnostics = []
    expect(() => comparePdfExtractionProviders(evalSet, [candidate])).toThrow(
      'PDF_EXTRACTION_REGEX_PROXY_NOT_AUTHORITATIVE',
    )
  })
})

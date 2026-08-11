import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import {
  EXTRACTION_LAYOUTS,
  EXTRACTION_STRATA,
  comparePdfExtractionProviders,
  createAbstainingPdfExtractionCandidate,
  loadProviderManifest,
  sha256,
  validatePdfExtractionEvalSet,
  validatePdfExtractionEvalSetFiles,
} from './pdf-extraction-eval.mjs'

const evalPath = 'benchmarks/pdf/extraction-eval-strata-v1.json'

async function readEvalSet() {
  return JSON.parse(await readFile(evalPath, 'utf8'))
}

async function attachVerifiedReviews(
  evalSet,
  directory,
  {
    legacy = false,
    reviewerA = 'fixture-reviewer-a',
    reviewerB = 'fixture-reviewer-b',
    reviewerHashA = 'a'.repeat(64),
    reviewerHashB = 'b'.repeat(64),
  } = {},
) {
  const reviewerReferences = legacy
    ? [reviewerA, reviewerB]
    : [reviewerHashA, reviewerHashB]
  const rosterPath = join(directory, 'roster.json')
  const decisionPath = join(directory, 'decisions.json')
  const reviews = [
    ...evalSet.documents.map((item) => item.groundTruthReview),
    ...evalSet.strata.map((item) => item.groundTruth),
    ...evalSet.cases.map((item) => item.source.groundTruth.review),
  ]
  for (const review of reviews) {
    review.reviewStatus = 'two-reviewer-agreed'
    review.reviewers = reviewerReferences
    review.reviewEvidence = {
      rosterPath,
      rosterSha256: '0'.repeat(64),
      decisionPath,
      decisionSha256: '0'.repeat(64),
    }
  }
  const roster = {
    schemaVersion: legacy ? '1.0.0' : '1.1.0',
    kind: 'pdf-extraction-reviewer-roster',
    evalSetId: evalSet.id,
    reviewers: legacy
      ? [
          { reviewerId: reviewerA, identityEvidenceSha256: reviewerHashA },
          { reviewerId: reviewerB, identityEvidenceSha256: reviewerHashB },
        ]
      : { [reviewerHashA]: reviewerA, [reviewerHashB]: reviewerB },
  }
  const identity = validatePdfExtractionEvalSet(evalSet)
  const documentById = new Map(evalSet.documents.map((item) => [item.id, item]))
  const decisionArtifact = {
    schemaVersion: legacy ? '1.0.0' : '1.1.0',
    kind: 'pdf-extraction-source-only-decisions',
    evalSetId: evalSet.id,
    evalSetSha256: identity.evalSetSha256,
    sourceOnly: true,
    candidateOutputConsultedForLabel: false,
    decisions: evalSet.cases.map((item) => ({
      caseId: item.id,
      sourceSha256: documentById.get(item.documentId).sha256,
      reviewers: reviewerReferences,
      decision: 'agreed',
      decisionSha256: 'd'.repeat(64),
    })),
  }
  const rosterBytes = Buffer.from(`${JSON.stringify(roster)}\n`)
  const decisionBytes = Buffer.from(`${JSON.stringify(decisionArtifact)}\n`)
  await writeFile(rosterPath, rosterBytes)
  await writeFile(decisionPath, decisionBytes)
  for (const review of reviews) {
    review.reviewEvidence = {
      rosterPath,
      rosterSha256: sha256(rosterBytes),
      decisionPath,
      decisionSha256: sha256(decisionBytes),
    }
  }
  await validatePdfExtractionEvalSetFiles(evalSet)
}

async function verifyEvalSet(evalSet) {
  const directory = await mkdtemp('.tmp-pdf-extraction-verified-')
  try {
    await attachVerifiedReviews(evalSet, directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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
    expect(report.status).toBe('reported-only')
    expect(report.providers).toHaveLength(3)
    expect(report.providers.every((provider) => provider.score === null)).toBe(
      true,
    )
    expect(report.rows).toHaveLength(3 * 8 * 2)
    expect(report.rows.every((row) => row.score === 0.25)).toBe(true)
    expect(new Set(report.rows.map(({ stratum }) => stratum))).toEqual(
      new Set(EXTRACTION_STRATA),
    )
    expect(new Set(report.rows.map(({ layout }) => layout))).toEqual(
      new Set(EXTRACTION_LAYOUTS),
    )
  })

  it('keeps directly scored output reported-only until every review is verified', async () => {
    const evalSet = await readEvalSet()
    const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
      id: 'candidate-a',
      kind: 'candidate',
      version: 'candidate-a-v1',
    })
    const tableCase = candidate.cases.find((item) =>
      item.caseId.endsWith('.table-structure'),
    )
    const expectedTable = evalSet.cases.find((item) =>
      item.id.endsWith('.table-structure'),
    ).source.groundTruth.tables[0]
    tableCase.status = 'scored'
    tableCase.prediction = { tables: [{ ...expectedTable }] }
    tableCase.diagnostics = []

    const report = comparePdfExtractionProviders(evalSet, [candidate])

    expect(report).toMatchObject({
      status: 'reported-only',
      diagnosticCodes: ['PDF_EXTRACTION_REVIEW_INCOMPLETE'],
    })
    expect(report.providers[0].score).toBeNull()
    expect(report.summary.scoredProviderCount).toBe(0)
    expect(
      report.rows.find(
        (row) =>
          row.stratum === 'table-structure' && row.layout === 'one-column',
      ),
    ).toMatchObject({ score: null, scoredCaseCount: 0 })
  })

  it('redacts degenerate scored attempts until every review is verified', async () => {
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
    tableCase.prediction = { tables: [] }
    tableCase.diagnostics = []

    const report = comparePdfExtractionProviders(evalSet, [candidate])
    const row = report.rows.find(
      (item) =>
        item.stratum === 'table-structure' && item.layout === 'one-column',
    )
    expect(report).toMatchObject({
      status: 'reported-only',
      diagnosticCodes: ['PDF_EXTRACTION_REVIEW_INCOMPLETE'],
    })
    expect(report.providers[0]).toMatchObject({
      score: null,
      diagnosticCodes: [],
    })
    expect(row).toMatchObject({
      score: null,
      scoredCaseCount: 0,
      abstainedCaseCount: 0,
      degenerateCaseCount: 0,
      diagnostics: [],
    })
  })

  it('scores abstention above guarded degenerate answers', async () => {
    const evalSet = await readEvalSet()
    await verifyEvalSet(evalSet)
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

  it('does not give metadata-only table or object predictions a perfect score', async () => {
    const evalSet = await readEvalSet()
    await verifyEvalSet(evalSet)
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
        {
          rows: 3,
          columns: 2,
          headerScope: 'row',
          cells: [
            { row: 0, column: 0, rowSpan: 1, columnSpan: 1, text: 'Profile' },
            { row: 0, column: 1, rowSpan: 1, columnSpan: 1, text: 'Nodes' },
            { row: 1, column: 0, rowSpan: 1, columnSpan: 1, text: 'Mobile' },
            { row: 1, column: 1, rowSpan: 1, columnSpan: 1, text: '12' },
            { row: 2, column: 0, rowSpan: 1, columnSpan: 1, text: 'E-ink' },
            { row: 2, column: 1, rowSpan: 1, columnSpan: 1, text: '12' },
          ],
        },
      ],
    }
    const objectCase = candidate.cases.find((item) =>
      item.caseId.endsWith('.figure-diagram'),
    )
    objectCase.status = 'scored'
    objectCase.prediction = {
      objects: [
        {
          kind: 'figure-or-diagram',
          sourcePage: 2,
          captionRelationship: 'caption-of',
          bounded: true,
        },
      ],
    }
    tableCase.diagnostics = []
    objectCase.diagnostics = []

    const report = comparePdfExtractionProviders(evalSet, [candidate])
    expect(
      report.rows.find(
        (row) =>
          row.stratum === 'table-structure' && row.layout === 'one-column',
      ),
    ).toMatchObject({ score: 0, degenerateCaseCount: 1 })
    expect(
      report.rows.find(
        (row) =>
          row.stratum === 'figure-diagram' && row.layout === 'one-column',
      ),
    ).toMatchObject({ score: 0, degenerateCaseCount: 1 })
  })

  it('accepts a prediction only when its source geometry and lineage match', async () => {
    const evalSet = await readEvalSet()
    await verifyEvalSet(evalSet)
    const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
      id: 'candidate-a',
      kind: 'candidate',
      version: 'candidate-a-v1',
    })
    const tableCase = candidate.cases.find((item) =>
      item.caseId.endsWith('.table-structure'),
    )
    const expectedTable = evalSet.cases.find((item) =>
      item.id.endsWith('.table-structure'),
    ).source.groundTruth.tables[0]
    tableCase.status = 'scored'
    tableCase.prediction = {
      tables: [{ ...expectedTable }],
    }
    tableCase.diagnostics = []
    const report = comparePdfExtractionProviders(evalSet, [candidate])
    expect(
      report.rows.find(
        (row) =>
          row.stratum === 'table-structure' && row.layout === 'one-column',
      ),
    ).toMatchObject({ score: 1, scoredCaseCount: 1, degenerateCaseCount: 0 })
  })

  it('requires a canonical eval-set hash in every candidate envelope', async () => {
    const evalSet = await readEvalSet()
    const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
      id: 'candidate-a',
      kind: 'candidate',
      version: 'candidate-a-v1',
    })
    const identity = validatePdfExtractionEvalSet(evalSet)
    expect(candidate.evalSetSha256).toBe(identity.evalSetSha256)

    delete candidate.evalSetSha256
    expect(() => comparePdfExtractionProviders(evalSet, [candidate])).toThrow(
      'INVALID_PDF_EXTRACTION_CANDIDATE',
    )
  })

  it('rejects two-reviewer labels without roster-bound source-only evidence', async () => {
    const evalSet = await readEvalSet()
    evalSet.documents[0].groundTruthReview.reviewStatus = 'two-reviewer-agreed'
    evalSet.documents[0].groundTruthReview.reviewers = [
      'a'.repeat(64),
      'b'.repeat(64),
    ]
    evalSet.documents[0].groundTruthReview.reviewEvidence = null
    expect(() => validatePdfExtractionEvalSet(evalSet)).toThrow(
      'INVALID_PDF_EXTRACTION_EVAL_SET',
    )
  })

  it('keeps the diagnostic furniture label tied to a real running-head and page-number case', async () => {
    const evalSet = await readEvalSet()
    const furnitureCase = evalSet.cases.find(
      (item) => item.id === 'diagnostic-overlays.boilerplate-exclusion',
    )
    expect(furnitureCase.source.groundTruth.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'running-head' }),
        expect.objectContaining({ kind: 'page-number' }),
      ]),
    )
  })

  it('scores boilerplate exclusion against reviewed furniture identities', async () => {
    const evalSet = await readEvalSet()
    await verifyEvalSet(evalSet)
    const furnitureCase = evalSet.cases.find(
      (item) => item.id === 'diagnostic-overlays.boilerplate-exclusion',
    )
    const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
      id: 'candidate-a',
      kind: 'candidate',
      version: 'candidate-a-v1',
    })
    const output = candidate.cases.find(
      (item) => item.caseId === furnitureCase.id,
    )
    output.status = 'scored'
    output.prediction = {
      contamination: {
        runningHeadContaminationCount: 0,
        pageNumberContaminationCount: 0,
        excludedCount: furnitureCase.source.groundTruth.excluded.length,
      },
    }
    output.diagnostics = []

    let report = comparePdfExtractionProviders(evalSet, [candidate])
    expect(
      report.rows.find(
        (row) =>
          row.stratum === 'boilerplate-exclusion' &&
          row.layout === furnitureCase.layout,
      ),
    ).toMatchObject({ degenerateCaseCount: 1 })

    output.prediction.excluded = furnitureCase.source.groundTruth.excluded.map(
      (item) => ({ ...item }),
    )
    report = comparePdfExtractionProviders(evalSet, [candidate])
    expect(
      report.rows.find(
        (row) =>
          row.stratum === 'boilerplate-exclusion' &&
          row.layout === furnitureCase.layout,
      ),
    ).toMatchObject({ degenerateCaseCount: 0, scoredCaseCount: 1 })

    output.prediction.excluded = [
      { ...furnitureCase.source.groundTruth.excluded[0] },
    ]
    const missed = furnitureCase.source.groundTruth.excluded.slice(1)
    output.prediction.contamination = {
      runningHeadContaminationCount: missed.filter(
        (item) => item.kind === 'running-head',
      ).length,
      pageNumberContaminationCount: missed.filter(
        (item) => item.kind === 'page-number',
      ).length,
      excludedCount: 1,
    }
    report = comparePdfExtractionProviders(evalSet, [candidate])
    expect(
      report.rows.find(
        (row) =>
          row.stratum === 'boilerplate-exclusion' &&
          row.layout === furnitureCase.layout,
      ),
    ).toMatchObject({
      score: 0.125,
      degenerateCaseCount: 1,
      scoredCaseCount: 0,
      diagnostics: [
        'CANDIDATE_ABSTAINED',
        'RUNNING_HEAD_OR_PAGE_NUMBER_LEFT_IN_BODY_FLOW',
      ],
    })
  })

  it('scores valid many-to-one footnote references instead of treating them as degenerate', async () => {
    const evalSet = await readEvalSet()
    const footnoteCase = evalSet.cases.find((item) =>
      item.id.endsWith('.footnote-resolution'),
    )
    footnoteCase.source.groundTruth.references.push({
      id: 'note-reference-2',
      sourcePage: footnoteCase.source.sourcePage,
      marker: '1',
      bodyId: 'footnote-1',
    })
    await verifyEvalSet(evalSet)
    const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
      id: 'candidate-a',
      kind: 'candidate',
      version: 'candidate-a-v1',
    })
    const output = candidate.cases.find(
      (item) => item.caseId === footnoteCase.id,
    )
    output.status = 'scored'
    output.prediction = {
      relationships: [
        {
          referenceId: 'note-reference-1',
          bodyId: 'footnote-1',
          marker: '1',
        },
        {
          referenceId: 'note-reference-2',
          bodyId: 'footnote-1',
          marker: '1',
        },
      ],
    }
    output.diagnostics = []
    const report = comparePdfExtractionProviders(evalSet, [candidate])
    expect(
      report.rows.find(
        (row) =>
          row.stratum === 'footnote-resolution' &&
          row.layout === footnoteCase.layout,
      ),
    ).toMatchObject({ score: 1, degenerateCaseCount: 0, scoredCaseCount: 1 })
  })

  it('scores a correct partial many-to-one footnote result across multiple bodies', async () => {
    const evalSet = await readEvalSet()
    const footnoteCase = evalSet.cases.find((item) =>
      item.id.endsWith('.footnote-resolution'),
    )
    footnoteCase.source.groundTruth.references.push(
      {
        id: 'note-reference-2',
        sourcePage: footnoteCase.source.sourcePage,
        marker: '1',
        bodyId: 'footnote-1',
      },
      {
        id: 'note-reference-3',
        sourcePage: footnoteCase.source.sourcePage,
        marker: '2',
        bodyId: 'footnote-2',
      },
    )
    footnoteCase.source.groundTruth.bodies.push({
      id: 'footnote-2',
      sourcePage: footnoteCase.source.sourcePage,
      marker: '2',
    })
    await verifyEvalSet(evalSet)
    const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
      id: 'candidate-a',
      kind: 'candidate',
      version: 'candidate-a-v1',
    })
    const output = candidate.cases.find(
      (item) => item.caseId === footnoteCase.id,
    )
    output.status = 'scored'
    output.prediction = {
      relationships: [
        {
          referenceId: 'note-reference-1',
          bodyId: 'footnote-1',
          marker: '1',
        },
        {
          referenceId: 'note-reference-2',
          bodyId: 'footnote-1',
          marker: '1',
        },
      ],
    }
    output.diagnostics = []

    const report = comparePdfExtractionProviders(evalSet, [candidate])
    expect(
      report.rows.find(
        (row) =>
          row.stratum === 'footnote-resolution' &&
          row.layout === footnoteCase.layout,
      ),
    ).toMatchObject({ degenerateCaseCount: 0, scoredCaseCount: 1 })
  })

  it('keeps unknown collapsed footnote relationships degenerate', async () => {
    const evalSet = await readEvalSet()
    const footnoteCase = evalSet.cases.find((item) =>
      item.id.endsWith('.footnote-resolution'),
    )
    footnoteCase.source.groundTruth.bodies.push({
      id: 'footnote-2',
      sourcePage: footnoteCase.source.sourcePage,
      marker: '2',
    })
    footnoteCase.source.groundTruth.references.push({
      id: 'note-reference-2',
      sourcePage: footnoteCase.source.sourcePage,
      marker: '2',
      bodyId: 'footnote-2',
    })
    await verifyEvalSet(evalSet)
    const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
      id: 'candidate-a',
      kind: 'candidate',
      version: 'candidate-a-v1',
    })
    const output = candidate.cases.find(
      (item) => item.caseId === footnoteCase.id,
    )
    output.status = 'scored'
    output.prediction = {
      relationships: [
        {
          referenceId: 'unknown-reference-1',
          bodyId: 'footnote-1',
          marker: '1',
        },
        {
          referenceId: 'unknown-reference-2',
          bodyId: 'footnote-1',
          marker: '1',
        },
      ],
    }
    output.diagnostics = []

    const report = comparePdfExtractionProviders(evalSet, [candidate])
    expect(
      report.rows.find(
        (row) =>
          row.stratum === 'footnote-resolution' &&
          row.layout === footnoteCase.layout,
      ),
    ).toMatchObject({ degenerateCaseCount: 1, scoredCaseCount: 0 })
  })

  it('keeps a mixed correct and dangling footnote result degenerate', async () => {
    const evalSet = await readEvalSet()
    await verifyEvalSet(evalSet)
    const footnoteCase = evalSet.cases.find((item) =>
      item.id.endsWith('.footnote-resolution'),
    )
    const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
      id: 'candidate-a',
      kind: 'candidate',
      version: 'candidate-a-v1',
    })
    const output = candidate.cases.find(
      (item) => item.caseId === footnoteCase.id,
    )
    const expected = footnoteCase.source.groundTruth.references[0]
    output.status = 'scored'
    output.prediction = {
      relationships: [
        {
          referenceId: expected.id,
          bodyId: expected.bodyId,
          marker: expected.marker,
        },
        {
          referenceId: 'unknown-reference',
          bodyId: 'unknown-body',
          marker: 'x',
        },
      ],
    }
    output.diagnostics = []

    const report = comparePdfExtractionProviders(evalSet, [candidate])
    expect(
      report.rows.find(
        (row) =>
          row.stratum === 'footnote-resolution' &&
          row.layout === footnoteCase.layout,
      ),
    ).toMatchObject({
      degenerateCaseCount: 1,
      scoredCaseCount: 0,
      diagnostics: expect.arrayContaining([
        'DEGENERATE_DANGLING_FOOTNOTE_RELATIONSHIP',
      ]),
    })
  })

  it('includes abstained rows in sparse provider aggregates', async () => {
    const evalSet = await readEvalSet()
    const directory = await mkdtemp('.tmp-pdf-extraction-aggregate-')
    try {
      await attachVerifiedReviews(evalSet, directory)
      const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
        id: 'candidate-a',
        kind: 'candidate',
        version: 'candidate-a-v1',
      })
      const tableCase = candidate.cases.find((item) =>
        item.caseId.endsWith('.table-structure'),
      )
      const expectedTable = evalSet.cases.find((item) =>
        item.id.endsWith('.table-structure'),
      ).source.groundTruth.tables[0]
      tableCase.status = 'scored'
      tableCase.prediction = { tables: [{ ...expectedTable }] }
      tableCase.diagnostics = []

      const report = comparePdfExtractionProviders(evalSet, [candidate])
      const provider = report.providers[0]
      const expectedAggregate = Number(
        (
          report.rows.reduce((sum, row) => sum + row.score, 0) /
          report.rows.length
        ).toFixed(5),
      )
      expect(provider.score).toBe(expectedAggregate)
      expect(provider.score).toBeLessThan(1)
      expect(provider.score).toBeGreaterThan(0.25)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('matches bounded objects by source binding rather than array order', async () => {
    const evalSet = await readEvalSet()
    await verifyEvalSet(evalSet)
    const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
      id: 'candidate-a',
      kind: 'candidate',
      version: 'candidate-a-v1',
    })
    const objectCase = evalSet.cases.find(
      (item) => item.id === 'structured-scientific.figure-diagram',
    )
    const output = candidate.cases.find((item) => item.caseId === objectCase.id)
    output.status = 'scored'
    output.prediction = {
      objects: [...objectCase.source.groundTruth.objects].reverse(),
    }
    output.diagnostics = []

    const report = comparePdfExtractionProviders(evalSet, [candidate])
    expect(
      report.rows.find(
        (row) =>
          row.stratum === 'figure-diagram' && row.layout === 'two-column',
      ),
    ).toMatchObject({ score: 1, scoredCaseCount: 1, degenerateCaseCount: 0 })
  })

  it('fails closed on extra or invalid table cells', async () => {
    const evalSet = await readEvalSet()
    await verifyEvalSet(evalSet)
    const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
      id: 'candidate-a',
      kind: 'candidate',
      version: 'candidate-a-v1',
    })
    const tableCase = candidate.cases.find((item) =>
      item.caseId.endsWith('.table-structure'),
    )
    const expectedTable = evalSet.cases.find((item) =>
      item.id.endsWith('.table-structure'),
    ).source.groundTruth.tables[0]
    tableCase.status = 'scored'
    tableCase.prediction = {
      tables: [
        {
          ...expectedTable,
          cells: [
            ...expectedTable.cells,
            { row: 999, column: 999, rowSpan: 1, columnSpan: 1, text: 'noise' },
          ],
        },
      ],
    }
    tableCase.diagnostics = []

    const report = comparePdfExtractionProviders(evalSet, [candidate])
    expect(
      report.rows.find(
        (row) =>
          row.stratum === 'table-structure' && row.layout === 'one-column',
      ),
    ).toMatchObject({ score: 0, scoredCaseCount: 0, degenerateCaseCount: 1 })
  })

  it('keeps eval-set identity stable when review evidence files change', async () => {
    const evalSet = await readEvalSet()
    const reviews = [
      ...evalSet.documents.map((item) => item.groundTruthReview),
      ...evalSet.strata.map((item) => item.groundTruth),
      ...evalSet.cases.map((item) => item.source.groundTruth.review),
    ]
    for (const review of reviews) {
      review.reviewStatus = 'two-reviewer-agreed'
      review.reviewers = ['a'.repeat(64), 'b'.repeat(64)]
      review.reviewEvidence = {
        rosterPath: 'docs/reviews/roster.json',
        rosterSha256: 'a'.repeat(64),
        decisionPath: 'docs/reviews/decisions.json',
        decisionSha256: 'b'.repeat(64),
      }
    }
    const changed = JSON.parse(JSON.stringify(evalSet))
    for (const review of [
      ...changed.documents.map((item) => item.groundTruthReview),
      ...changed.strata.map((item) => item.groundTruth),
      ...changed.cases.map((item) => item.source.groundTruth.review),
    ]) {
      review.reviewEvidence.decisionSha256 = 'c'.repeat(64)
    }

    expect(validatePdfExtractionEvalSet(evalSet).evalSetSha256).toBe(
      validatePdfExtractionEvalSet(changed).evalSetSha256,
    )
  })

  it('binds verified review evidence to the exact evaluated identity', async () => {
    const evalSet = await readEvalSet()
    const directory = await mkdtemp('.tmp-pdf-extraction-review-identity-')
    try {
      await attachVerifiedReviews(evalSet, directory)
      evalSet.cases.find((item) =>
        item.id.endsWith('.table-structure'),
      ).source.groundTruth.tables[0].cells[0].text = 'mutated-after-review'
      const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
        id: 'candidate-a',
        kind: 'candidate',
        version: 'candidate-a-v1',
      })

      expect(() => comparePdfExtractionProviders(evalSet, [candidate])).toThrow(
        'PDF_EXTRACTION_REVIEW_EVIDENCE_NOT_VERIFIED',
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('invalidates verified review evidence when its hashes change', async () => {
    const evalSet = await readEvalSet()
    const directory = await mkdtemp('.tmp-pdf-extraction-review-snapshot-')
    try {
      await attachVerifiedReviews(evalSet, directory)
      for (const review of [
        ...evalSet.documents.map((item) => item.groundTruthReview),
        ...evalSet.strata.map((item) => item.groundTruth),
        ...evalSet.cases.map((item) => item.source.groundTruth.review),
      ]) {
        review.reviewEvidence.decisionSha256 = 'e'.repeat(64)
      }
      const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
        id: 'candidate-a',
        kind: 'candidate',
        version: 'candidate-a-v1',
      })
      const tableCase = candidate.cases.find((item) =>
        item.caseId.endsWith('.table-structure'),
      )
      const expectedTable = evalSet.cases.find((item) =>
        item.id.endsWith('.table-structure'),
      ).source.groundTruth.tables[0]
      tableCase.status = 'scored'
      tableCase.prediction = { tables: [{ ...expectedTable }] }
      tableCase.diagnostics = []

      expect(() => comparePdfExtractionProviders(evalSet, [candidate])).toThrow(
        'PDF_EXTRACTION_REVIEW_EVIDENCE_NOT_VERIFIED',
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('binds each case reviewer list to its corresponding decision', async () => {
    const evalSet = await readEvalSet()
    const directory = await mkdtemp('.tmp-pdf-extraction-review-')
    const rosterPath = join(directory, 'roster.json')
    const decisionPath = join(directory, 'decisions.json')
    const reviewerA = 'a'.repeat(64)
    const reviewerB = 'b'.repeat(64)
    const reviewerC = 'c'.repeat(64)
    try {
      const reviews = [
        ...evalSet.documents.map((item) => item.groundTruthReview),
        ...evalSet.strata.map((item) => item.groundTruth),
        ...evalSet.cases.map((item) => item.source.groundTruth.review),
      ]
      for (const review of reviews) {
        review.reviewStatus = 'two-reviewer-agreed'
        review.reviewers = [reviewerA, reviewerB]
        review.reviewEvidence = {
          rosterPath,
          rosterSha256: '0'.repeat(64),
          decisionPath,
          decisionSha256: '0'.repeat(64),
        }
      }
      evalSet.cases.forEach((item, index) => {
        item.source.groundTruth.review.reviewers =
          index % 2 === 0 ? [reviewerA, reviewerB] : [reviewerB, reviewerC]
      })

      const roster = {
        schemaVersion: '1.1.0',
        kind: 'pdf-extraction-reviewer-roster',
        evalSetId: evalSet.id,
        reviewers: {
          [reviewerA]: 'fixture-reviewer-a',
          [reviewerB]: 'fixture-reviewer-b',
          [reviewerC]: 'fixture-reviewer-c',
        },
      }
      const identity = validatePdfExtractionEvalSet(evalSet)
      const documentById = new Map(
        evalSet.documents.map((item) => [item.id, item]),
      )
      const decisions = evalSet.cases.map((item) => ({
        caseId: item.id,
        sourceSha256: documentById.get(item.documentId).sha256,
        reviewers: [...item.source.groundTruth.review.reviewers],
        decision: 'agreed',
        decisionSha256: 'd'.repeat(64),
      }))
      const decisionArtifact = {
        schemaVersion: '1.1.0',
        kind: 'pdf-extraction-source-only-decisions',
        evalSetId: evalSet.id,
        evalSetSha256: identity.evalSetSha256,
        sourceOnly: true,
        candidateOutputConsultedForLabel: false,
        decisions,
      }
      const rosterBytes = Buffer.from(`${JSON.stringify(roster)}\n`)
      const decisionBytes = Buffer.from(`${JSON.stringify(decisionArtifact)}\n`)
      await writeFile(rosterPath, rosterBytes)
      await writeFile(decisionPath, decisionBytes)
      const evidence = {
        rosterPath,
        rosterSha256: sha256(rosterBytes),
        decisionPath,
        decisionSha256: sha256(decisionBytes),
      }
      for (const review of reviews) review.reviewEvidence = evidence

      await expect(
        validatePdfExtractionEvalSetFiles(evalSet),
      ).resolves.toMatchObject({ evalSetSha256: identity.evalSetSha256 })

      delete roster.reviewers[reviewerC]
      const missingIdentityRosterBytes = Buffer.from(
        `${JSON.stringify(roster)}\n`,
      )
      await writeFile(rosterPath, missingIdentityRosterBytes)
      for (const review of reviews) {
        review.reviewEvidence.rosterSha256 = sha256(missingIdentityRosterBytes)
      }
      await expect(validatePdfExtractionEvalSetFiles(evalSet)).rejects.toThrow(
        'PDF_EXTRACTION_REVIEW_DECISION_MISMATCH',
      )

      roster.reviewers[reviewerC] = 'fixture-reviewer-c'
      await writeFile(rosterPath, rosterBytes)
      for (const review of reviews) {
        review.reviewEvidence.rosterSha256 = sha256(rosterBytes)
      }

      evalSet.cases[0].source.groundTruth.review.reviewers = [
        ...evalSet.cases[1].source.groundTruth.review.reviewers,
      ]
      await expect(validatePdfExtractionEvalSetFiles(evalSet)).rejects.toThrow(
        'PDF_EXTRACTION_REVIEW_DECISION_MISMATCH',
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('continues to validate completed v1.0 review evidence', async () => {
    const evalSet = await readEvalSet()
    const directory = await mkdtemp('.tmp-pdf-extraction-review-v1-')
    try {
      await expect(
        attachVerifiedReviews(evalSet, directory, { legacy: true }),
      ).resolves.toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps hash-shaped v1.0 reviewer IDs alias-bound', async () => {
    const evalSet = await readEvalSet()
    const directory = await mkdtemp('.tmp-pdf-extraction-review-v1-alias-')
    try {
      await expect(
        attachVerifiedReviews(evalSet, directory, {
          legacy: true,
          reviewerA: 'b'.repeat(64),
        }),
      ).resolves.toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('preserves schema-valid duplicate v1.0 identity evidence hashes', async () => {
    const evalSet = await readEvalSet()
    const directory = await mkdtemp('.tmp-pdf-extraction-review-v1-duplicate-')
    try {
      await expect(
        attachVerifiedReviews(evalSet, directory, {
          legacy: true,
          reviewerHashB: 'a'.repeat(64),
        }),
      ).resolves.toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('requires the manifest hash to match exact file-mode prediction bytes', async () => {
    const evalSet = await readEvalSet()
    const directory = await mkdtemp('.tmp-pdf-extraction-provider-')
    const predictionsPath = join(directory, 'predictions.json')
    try {
      for (const review of [
        ...evalSet.documents.map((item) => item.groundTruthReview),
        ...evalSet.strata.map((item) => item.groundTruth),
        ...evalSet.cases.map((item) => item.source.groundTruth.review),
      ]) {
        review.reviewStatus = 'two-reviewer-agreed'
        review.reviewers = ['a'.repeat(64), 'b'.repeat(64)]
        review.reviewEvidence = {
          rosterPath: 'docs/reviews/roster.json',
          rosterSha256: 'a'.repeat(64),
          decisionPath: 'docs/reviews/decisions.json',
          decisionSha256: 'b'.repeat(64),
        }
      }
      const identity = validatePdfExtractionEvalSet(evalSet)
      const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
        id: 'candidate-file',
        kind: 'deterministic',
        version: 'candidate-file-v1',
      })
      const predictionBytes = Buffer.from(`${JSON.stringify(candidate)}\n`)
      await writeFile(predictionsPath, predictionBytes)
      const manifest = JSON.parse(
        await readFile(
          'benchmarks/pdf/extraction-eval-providers-v1.json',
          'utf8',
        ),
      )
      manifest.evalSet.evalSetSha256 = identity.evalSetSha256
      manifest.evaluationStatus = 'comparison-ready'
      manifest.providers = [
        {
          id: candidate.provider.id,
          kind: candidate.provider.kind,
          version: candidate.provider.version,
          mode: 'file',
          sourceIdentitySha256: null,
          predictionsPath,
          predictionsSha256: sha256(predictionBytes),
        },
      ]
      await expect(
        loadProviderManifest(manifest, identity, evalSet),
      ).resolves.toHaveLength(1)

      await writeFile(predictionsPath, `${predictionBytes} `)
      await expect(
        loadProviderManifest(manifest, identity, evalSet),
      ).rejects.toThrow('PDF_EXTRACTION_PROVIDER_PREDICTIONS_HASH_MISMATCH')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('publishes the runtime abstention constraint in the candidate schema', async () => {
    const evalSet = await readEvalSet()
    const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
      id: 'candidate-a',
      kind: 'candidate',
      version: 'candidate-a-v1',
    })
    const schema = JSON.parse(
      await readFile(
        'docs/schemas/pdf-extraction-eval-candidate.schema.json',
        'utf8',
      ),
    )
    const validate = new Ajv2020({ strict: false }).compile(schema)
    expect(validate(candidate)).toBe(true)

    candidate.cases[0].prediction = {}
    expect(validate(candidate)).toBe(false)

    candidate.cases[0].status = 'scored'
    candidate.cases[0].prediction = null
    expect(validate(candidate)).toBe(true)
  })

  it('publishes the runtime diagnostic-code constraint in the candidate schema', async () => {
    const evalSet = await readEvalSet()
    const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
      id: 'candidate-a',
      kind: 'candidate',
      version: 'candidate-a-v1',
    })
    const schema = JSON.parse(
      await readFile(
        'docs/schemas/pdf-extraction-eval-candidate.schema.json',
        'utf8',
      ),
    )
    const validate = new Ajv2020({ strict: false }).compile(schema)
    expect(validate(candidate)).toBe(true)

    candidate.cases[0].diagnostics = ['warning']
    expect(validate(candidate)).toBe(false)
    candidate.cases[0].diagnostics = ['UPPERCASE_DIAGNOSTIC_1']
    expect(validate(candidate)).toBe(true)
  })

  it('publishes distinct reviewer identity evidence in the review schema', async () => {
    const schema = JSON.parse(
      await readFile(
        'docs/schemas/pdf-extraction-eval-review.schema.json',
        'utf8',
      ),
    )
    const validate = new Ajv2020({ strict: false }).compile(schema)
    const roster = {
      schemaVersion: '1.1.0',
      kind: 'pdf-extraction-reviewer-roster',
      evalSetId: 'fixture-eval',
      reviewers: { ['a'.repeat(64)]: 'reviewer-a' },
    }

    expect(validate(roster)).toBe(false)
    roster.reviewers['b'.repeat(64)] = 'reviewer-b'
    expect(validate(roster)).toBe(true)
  })

  it('publishes the accepted legacy v1.0 review contract', async () => {
    const schema = JSON.parse(
      await readFile(
        'docs/schemas/pdf-extraction-eval-review-1.0.0.schema.json',
        'utf8',
      ),
    )
    const validate = new Ajv2020({ strict: false }).compile(schema)
    const roster = {
      schemaVersion: '1.0.0',
      kind: 'pdf-extraction-reviewer-roster',
      evalSetId: 'fixture-eval',
      reviewers: [
        {
          reviewerId: 'reviewer-a',
          identityEvidenceSha256: 'a'.repeat(64),
        },
        {
          reviewerId: 'reviewer-b',
          identityEvidenceSha256: 'b'.repeat(64),
        },
      ],
    }
    expect(validate(roster)).toBe(true)

    expect(
      validate({
        schemaVersion: '1.0.0',
        kind: 'pdf-extraction-source-only-decisions',
        evalSetId: 'fixture-eval',
        evalSetSha256: 'c'.repeat(64),
        sourceOnly: true,
        candidateOutputConsultedForLabel: false,
        decisions: [
          {
            caseId: 'fixture-case',
            sourceSha256: 'd'.repeat(64),
            reviewers: ['reviewer-a', 'reviewer-b'],
            decision: 'agreed',
            decisionSha256: 'e'.repeat(64),
          },
        ],
      }),
    ).toBe(true)
  })

  it('rejects v1.1 reviewer aliases that collide with identity hash keys', async () => {
    const schema = JSON.parse(
      await readFile(
        'docs/schemas/pdf-extraction-eval-review.schema.json',
        'utf8',
      ),
    )
    const validate = new Ajv2020({ strict: false }).compile(schema)
    const reviewerHashA = 'a'.repeat(64)
    const reviewerHashB = 'b'.repeat(64)
    const roster = {
      schemaVersion: '1.1.0',
      kind: 'pdf-extraction-reviewer-roster',
      evalSetId: 'fixture-eval',
      reviewers: {
        [reviewerHashA]: reviewerHashB,
        [reviewerHashB]: 'reviewer-b',
      },
    }
    expect(validate(roster)).toBe(false)

    const evalSet = await readEvalSet()
    const directory = await mkdtemp('.tmp-pdf-extraction-hash-alias-')
    try {
      await expect(
        attachVerifiedReviews(evalSet, directory, {
          reviewerA: reviewerHashB,
        }),
      ).rejects.toThrow('PDF_EXTRACTION_REVIEW_ROSTER_MISMATCH')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('publishes authoritative hash-only v1.1 decision references', async () => {
    const schema = JSON.parse(
      await readFile(
        'docs/schemas/pdf-extraction-eval-review.schema.json',
        'utf8',
      ),
    )
    const validate = new Ajv2020({ strict: false }).compile(schema)
    const decision = {
      schemaVersion: '1.1.0',
      kind: 'pdf-extraction-source-only-decisions',
      evalSetId: 'fixture-eval',
      evalSetSha256: 'c'.repeat(64),
      sourceOnly: true,
      candidateOutputConsultedForLabel: false,
      decisions: [
        {
          caseId: 'fixture-case',
          sourceSha256: 'd'.repeat(64),
          reviewers: ['shared-alias', 'reviewer-b'],
          decision: 'agreed',
          decisionSha256: 'e'.repeat(64),
        },
      ],
    }
    expect(validate(decision)).toBe(false)
    decision.decisions[0].reviewers = ['a'.repeat(64), 'b'.repeat(64)]
    expect(validate(decision)).toBe(true)
  })

  it('publishes authoritative v1.1 and legacy-compatible eval references', async () => {
    const reviewSchema = JSON.parse(
      await readFile(
        'docs/schemas/pdf-extraction-eval-review.schema.json',
        'utf8',
      ),
    )
    const evalSchema = JSON.parse(
      await readFile(
        'docs/schemas/pdf-extraction-eval-strata.schema.json',
        'utf8',
      ),
    )
    const ajv = new Ajv2020({ strict: false })
    const validateReview = ajv.compile(reviewSchema)
    const validateEvalSet = ajv.compile(evalSchema)
    const reviewerHashes = ['a'.repeat(64), 'b'.repeat(64)]
    const aliases = ['reviewer-a', 'reviewer-b']
    const decision = {
      schemaVersion: '1.1.0',
      kind: 'pdf-extraction-source-only-decisions',
      evalSetId: 'fixture-eval',
      evalSetSha256: 'c'.repeat(64),
      sourceOnly: true,
      candidateOutputConsultedForLabel: false,
      decisions: [
        {
          caseId: 'fixture-case',
          sourceSha256: 'd'.repeat(64),
          reviewers: aliases,
          decision: 'agreed',
          decisionSha256: 'e'.repeat(64),
        },
      ],
    }
    expect(validateReview(decision)).toBe(false)
    decision.decisions[0].reviewers = reviewerHashes
    expect(validateReview(decision)).toBe(true)

    const evalSet = await readEvalSet()
    const review = evalSet.documents[0].groundTruthReview
    review.reviewStatus = 'two-reviewer-agreed'
    review.reviewers = aliases
    review.reviewEvidence = {
      rosterPath: 'docs/reviews/roster.json',
      rosterSha256: 'f'.repeat(64),
      decisionPath: 'docs/reviews/decisions.json',
      decisionSha256: '0'.repeat(64),
    }
    expect(validateEvalSet(evalSet)).toBe(true)
    review.reviewers = reviewerHashes
    expect(validateEvalSet(evalSet)).toBe(true)
  })

  it('preserves v1 left-top-width-height boxes and rejects invalid extents', async () => {
    const evalSet = await readEvalSet()
    const tableCase = evalSet.cases.find((item) =>
      item.id.endsWith('.table-structure'),
    )
    const schema = JSON.parse(
      await readFile(
        'docs/schemas/pdf-extraction-eval-strata.schema.json',
        'utf8',
      ),
    )
    const validate = new Ajv2020({ strict: false }).compile(schema)

    expect(schema.$id).toBe(
      'https://ernie.sg/schemas/pdf-extraction-eval-strata-1.0.0.json',
    )
    expect(schema.$defs.box.$comment).toContain('left, top, width, and height')

    tableCase.source.groundTruth.tables[0].box = [0.8, 0, 0.3, 0.5]
    expect(validate(evalSet)).toBe(true)
    expect(() => validatePdfExtractionEvalSet(evalSet)).toThrow(
      'INVALID_PDF_EXTRACTION_EVAL_SET',
    )

    tableCase.source.groundTruth.tables[0].box = [0.8, 0, 0, 0.5]
    expect(validate(evalSet)).toBe(false)
    expect(() => validatePdfExtractionEvalSet(evalSet)).toThrow(
      'INVALID_PDF_EXTRACTION_EVAL_SET',
    )

    tableCase.source.groundTruth.tables[0].box = [0.8, 0, 0.2, 0.5]
    expect(validate(evalSet)).toBe(true)
    expect(() => validatePdfExtractionEvalSet(evalSet)).not.toThrow()
    await verifyEvalSet(evalSet)
    const candidate = createAbstainingPdfExtractionCandidate(evalSet, {
      id: 'candidate-a',
      kind: 'candidate',
      version: 'candidate-a-v1',
    })
    const output = candidate.cases.find((item) => item.caseId === tableCase.id)
    output.status = 'scored'
    output.prediction = {
      tables: [{ ...tableCase.source.groundTruth.tables[0] }],
    }
    output.diagnostics = []
    const report = comparePdfExtractionProviders(evalSet, [candidate])
    expect(
      report.rows.find(
        (row) =>
          row.stratum === 'table-structure' && row.layout === tableCase.layout,
      ),
    ).toMatchObject({
      score: 1,
      scoredCaseCount: 1,
      degenerateCaseCount: 0,
      diagnostics: [],
    })
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

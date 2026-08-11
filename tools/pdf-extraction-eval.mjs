#!/usr/bin/env node

/**
 * Source-reviewed extraction benchmark.
 *
 * This evaluator deliberately lives beside (rather than inside) the frozen
 * fidelity benchmark.  The fidelity benchmark measures bounded page cases;
 * this contract measures the reader-visible extraction strata that a parser
 * can otherwise hide behind aggregate text coverage.
 */

import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PDF_EXTRACTION_EVAL_SCHEMA_VERSION = '1.0.0'
export const PDF_EXTRACTION_EVAL_REVIEW_SCHEMA_VERSION = '1.1.0'
export const PDF_EXTRACTION_EVAL_REPORT_SCHEMA_VERSION = '1.0.0'
export const PDF_EXTRACTION_EVAL_PRIVACY =
  'repository-fixture-identities-source-reviewed-no-private-inputs'
export const PDF_EXTRACTION_EVAL_REPORT_PRIVACY =
  'identities-hashes-counts-diagnostic-codes-only'

export const PDF_EXTRACTION_EVAL_SCHEMA_PATH =
  'docs/schemas/pdf-extraction-eval-strata.schema.json'
export const PDF_EXTRACTION_EVAL_SET_PATH =
  'benchmarks/pdf/extraction-eval-strata-v1.json'
export const PDF_EXTRACTION_EVAL_PROVIDER_PATH =
  'benchmarks/pdf/extraction-eval-providers-v1.json'

export const EXTRACTION_LAYOUTS = Object.freeze(['one-column', 'two-column'])
export const EXTRACTION_STRATA = Object.freeze([
  'table-structure',
  'heading-structure',
  'display-equation',
  'figure-diagram',
  'prose-continuity',
  'boilerplate-exclusion',
  'footnote-resolution',
  'column-layout',
])
export const EXTRACTION_PROVIDER_KINDS = Object.freeze([
  'deterministic',
  'candidate',
])

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/
const SHA256 = /^[a-f0-9]{64}$/
const SAFE_DIAGNOSTIC = /^[A-Z][A-Z0-9_]{2,63}$/
const MAX_JSON_BYTES = 32 * 1024 * 1024
const ABSTENTION_SCORE = 0.25
const DEGENERATE_SCORE = 0
const REVIEW_STATUSES = Object.freeze([
  'review-required',
  'two-reviewer-agreed',
])
const REVIEW_EVIDENCE_VALIDATED = Symbol('pdfExtractionReviewEvidenceValidated')

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  )
}

function uniqueBy(values, selector) {
  return new Set(values.map(selector)).size === values.length
}

function invalid(code = 'INVALID_PDF_EXTRACTION_EVAL') {
  throw new Error(code)
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export { canonicalJson }

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalHash(value) {
  return sha256(canonicalJson(value))
}

function reviewIdentityProjection(review) {
  if (!isRecord(review)) return review
  const { reviewEvidence: _reviewEvidence, ...identity } = review
  return identity
}

function evalSetIdentityProjection(value) {
  return {
    ...value,
    documents: value.documents.map((document) => ({
      ...document,
      groundTruthReview: reviewIdentityProjection(document.groundTruthReview),
    })),
    strata: value.strata.map((stratum) => ({
      ...stratum,
      groundTruth: reviewIdentityProjection(stratum.groundTruth),
    })),
    cases: value.cases.map((item) => ({
      ...item,
      source: {
        ...item.source,
        groundTruth: {
          ...item.source.groundTruth,
          review: reviewIdentityProjection(item.source.groundTruth.review),
        },
      },
    })),
  }
}

function rounded(value) {
  return Math.round(value * 100000) / 100000
}

function average(values, fallback = 0) {
  return values.length
    ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length)
    : fallback
}

function f1(truePositive, expected, predicted) {
  const precision = predicted > 0 ? truePositive / predicted : 0
  const recall = expected > 0 ? truePositive / expected : 0
  return precision + recall === 0
    ? 0
    : rounded((2 * precision * recall) / (precision + recall))
}

function orderedMatchCount(expected, predicted) {
  const rows = expected.length + 1
  const columns = predicted.length + 1
  const matrix = Array.from({ length: rows }, () => new Uint32Array(columns))
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      matrix[row][column] =
        expected[row - 1] === predicted[column - 1]
          ? matrix[row - 1][column - 1] + 1
          : Math.max(matrix[row - 1][column], matrix[row][column - 1])
    }
  }
  return matrix[rows - 1][columns - 1]
}

function safeDiagnostic(code) {
  return SAFE_DIAGNOSTIC.test(code) ? code : 'INVALID_DIAGNOSTIC_CODE'
}

function pathIsRepositoryRelative(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').includes('..') &&
    SAFE_PATH.test(value)
  )
}

function isNormalizedBox(value) {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item)) &&
    value.every((item) => item >= 0 && item <= 1)
  )
}

function normalizedBoxArea(value) {
  if (!isNormalizedBox(value) || value[2] <= value[0] || value[3] <= value[1]) {
    return 0
  }
  return (value[2] - value[0]) * (value[3] - value[1])
}

function validateSourceBinding(value, code) {
  if (
    !isRecord(value) ||
    !isNormalizedBox(value.box) ||
    !Array.isArray(value.sourceRegionIds) ||
    value.sourceRegionIds.length === 0 ||
    !uniqueBy(value.sourceRegionIds, (id) => id) ||
    !value.sourceRegionIds.every((id) => SAFE_ID.test(id ?? '')) ||
    !Array.isArray(value.sourceLineIds) ||
    value.sourceLineIds.length === 0 ||
    !uniqueBy(value.sourceLineIds, (id) => id) ||
    !value.sourceLineIds.every((id) => SAFE_ID.test(id ?? ''))
  ) {
    invalid(code)
  }
}

function expectedStratum(value) {
  return (
    isRecord(value) &&
    exactKeys(value, [
      'id',
      'task',
      'description',
      'groundTruth',
      'metric',
      'degenerateAnswerGuard',
    ]) &&
    SAFE_ID.test(value.id ?? '') &&
    EXTRACTION_STRATA.includes(value.id) &&
    typeof value.task === 'string' &&
    value.description.length > 0 &&
    isRecord(value.groundTruth) &&
    isRecord(value.metric) &&
    isRecord(value.degenerateAnswerGuard)
  )
}

function validateGroundTruthReview(value, code) {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'kind',
      'derivedFrom',
      'reviewStatus',
      'reviewers',
      'parserOutputConsulted',
      'reviewEvidence',
    ]) ||
    value.kind !== 'source-reviewed' ||
    value.derivedFrom !== 'source-document' ||
    !REVIEW_STATUSES.includes(value.reviewStatus) ||
    !Array.isArray(value.reviewers) ||
    !uniqueBy(value.reviewers, (reviewer) => reviewer) ||
    !value.reviewers.every((reviewer) => SAFE_ID.test(reviewer)) ||
    value.parserOutputConsulted !== false
  ) {
    invalid(code)
  }
  if (value.reviewStatus === 'review-required') {
    if (value.reviewers.length !== 0 || value.reviewEvidence !== null) {
      invalid(code)
    }
    return
  }
  if (
    value.reviewers.length < 2 ||
    !isRecord(value.reviewEvidence) ||
    !exactKeys(value.reviewEvidence, [
      'rosterPath',
      'rosterSha256',
      'decisionPath',
      'decisionSha256',
    ]) ||
    !pathIsRepositoryRelative(value.reviewEvidence.rosterPath) ||
    !SHA256.test(value.reviewEvidence.rosterSha256 ?? '') ||
    !pathIsRepositoryRelative(value.reviewEvidence.decisionPath) ||
    !SHA256.test(value.reviewEvidence.decisionSha256 ?? '')
  ) {
    invalid(code)
  }
}

function validateMetric(value, guardId, code) {
  if (
    !exactKeys(value, [
      'id',
      'name',
      'unit',
      'formula',
      'scoreRange',
      'abstentionScore',
      'degenerateScore',
      'degenerateAnswerGuardId',
      'authoritativeEvidence',
    ]) ||
    !SAFE_ID.test(value.id ?? '') ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    typeof value.unit !== 'string' ||
    typeof value.formula !== 'string' ||
    !Array.isArray(value.scoreRange) ||
    value.scoreRange.length !== 2 ||
    value.scoreRange[0] !== 0 ||
    value.scoreRange[1] !== 1 ||
    value.abstentionScore !== ABSTENTION_SCORE ||
    value.degenerateScore !== DEGENERATE_SCORE ||
    value.degenerateAnswerGuardId !== guardId ||
    typeof value.authoritativeEvidence !== 'string' ||
    value.authoritativeEvidence.length === 0
  ) {
    invalid(code)
  }
}

function validateGuard(value, stratumId, code) {
  if (
    !exactKeys(value, [
      'id',
      'rejects',
      'detection',
      'score',
      'abstentionScore',
      'failClosed',
    ]) ||
    !SAFE_ID.test(value.id ?? '') ||
    !Array.isArray(value.rejects) ||
    value.rejects.length === 0 ||
    !value.rejects.every(
      (item) => typeof item === 'string' && item.length > 0,
    ) ||
    typeof value.detection !== 'string' ||
    value.detection.length === 0 ||
    value.score !== 0 ||
    value.abstentionScore !== ABSTENTION_SCORE ||
    value.failClosed !== true ||
    value.id !== `${stratumId}-degenerate-answer-guard`
  ) {
    invalid(code)
  }
}

function validateDocument(value, code) {
  if (
    !exactKeys(value, [
      'id',
      'fixturePath',
      'sha256',
      'byteLength',
      'pageCount',
      'layout',
      'groundTruthReview',
    ]) ||
    !SAFE_ID.test(value.id ?? '') ||
    !pathIsRepositoryRelative(value.fixturePath) ||
    !SHA256.test(value.sha256 ?? '') ||
    !nonNegativeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    !Number.isSafeInteger(value.pageCount) ||
    value.pageCount <= 0 ||
    !EXTRACTION_LAYOUTS.includes(value.layout)
  ) {
    invalid(code)
  }
  validateGroundTruthReview(value.groundTruthReview, code)
}

function validateTableGroundTruth(value, code) {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['tables', 'review']) ||
    !Array.isArray(value.tables) ||
    value.tables.length === 0
  ) {
    invalid(code)
  }
  if (!uniqueBy(value.tables, (table) => table.id)) invalid(code)
  validateGroundTruthReview(value.review, code)
  for (const table of value.tables) {
    if (
      !exactKeys(table, [
        'id',
        'sourcePage',
        'rows',
        'columns',
        'headerScope',
        'box',
        'sourceRegionIds',
        'sourceLineIds',
        'cells',
      ]) ||
      !SAFE_ID.test(table.id ?? '') ||
      !Number.isSafeInteger(table.sourcePage) ||
      table.sourcePage < 1 ||
      !Number.isSafeInteger(table.rows) ||
      table.rows < 1 ||
      !Number.isSafeInteger(table.columns) ||
      table.columns < 1 ||
      !['row', 'column', 'row-and-column', 'none'].includes(
        table.headerScope,
      ) ||
      !Array.isArray(table.cells) ||
      table.cells.length !== table.rows * table.columns
    ) {
      invalid(code)
    }
    validateSourceBinding(table, code)
    for (const cell of table.cells) {
      if (
        !exactKeys(cell, ['row', 'column', 'rowSpan', 'columnSpan', 'text']) ||
        !Number.isSafeInteger(cell.row) ||
        cell.row < 0 ||
        cell.row >= table.rows ||
        !Number.isSafeInteger(cell.column) ||
        cell.column < 0 ||
        cell.column >= table.columns ||
        cell.rowSpan !== 1 ||
        cell.columnSpan !== 1 ||
        typeof cell.text !== 'string' ||
        cell.text.trim().length === 0
      ) {
        invalid(code)
      }
    }
    if (!uniqueBy(table.cells, (cell) => `${cell.row}:${cell.column}`)) {
      invalid(code)
    }
  }
}

function validateHeadingGroundTruth(value, code) {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['headings', 'review']) ||
    !Array.isArray(value.headings) ||
    value.headings.length === 0
  ) {
    invalid(code)
  }
  if (!uniqueBy(value.headings, (heading) => heading.id)) invalid(code)
  validateGroundTruthReview(value.review, code)
  for (const heading of value.headings) {
    if (
      !exactKeys(heading, ['id', 'text', 'level', 'numbered', 'language']) ||
      !SAFE_ID.test(heading.id ?? '') ||
      typeof heading.text !== 'string' ||
      heading.text.trim().length === 0 ||
      !Number.isSafeInteger(heading.level) ||
      heading.level < 1 ||
      heading.level > 6 ||
      typeof heading.numbered !== 'boolean' ||
      typeof heading.language !== 'string' ||
      heading.language.length < 2
    ) {
      invalid(code)
    }
  }
}

function validateObjectGroundTruth(value, code, kind) {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['objects', 'review']) ||
    !Array.isArray(value.objects) ||
    value.objects.length === 0
  ) {
    invalid(code)
  }
  if (!uniqueBy(value.objects, (object) => object.id)) invalid(code)
  validateGroundTruthReview(value.review, code)
  for (const object of value.objects) {
    if (
      !exactKeys(object, [
        'id',
        'sourcePage',
        'kind',
        'bounded',
        'captionRelationship',
        'box',
        'sourceRegionIds',
        'sourceLineIds',
      ]) ||
      !SAFE_ID.test(object.id ?? '') ||
      !Number.isSafeInteger(object.sourcePage) ||
      object.sourcePage < 1 ||
      object.kind !== kind ||
      object.bounded !== true ||
      typeof object.captionRelationship !== 'string' ||
      object.captionRelationship.length === 0
    ) {
      invalid(code)
    }
    validateSourceBinding(object, code)
  }
}

function validateProseGroundTruth(value, code) {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['paragraphs', 'authoritativeCounters', 'review']) ||
    !Array.isArray(value.paragraphs) ||
    value.paragraphs.length === 0 ||
    !exactKeys(value.authoritativeCounters, [
      'lineBoundaryCount',
      'decidedLineBoundaryCount',
      'unresolvedCorruptingJoinCount',
    ]) ||
    !Object.values(value.authoritativeCounters).every(nonNegativeInteger)
  ) {
    invalid(code)
  }
  if (
    value.authoritativeCounters.decidedLineBoundaryCount >
      value.authoritativeCounters.lineBoundaryCount ||
    value.authoritativeCounters.unresolvedCorruptingJoinCount >
      value.authoritativeCounters.decidedLineBoundaryCount ||
    !uniqueBy(value.paragraphs, (paragraph) => paragraph.id)
  ) {
    invalid(code)
  }
  validateGroundTruthReview(value.review, code)
  for (const paragraph of value.paragraphs) {
    if (
      !exactKeys(paragraph, ['id', 'sourcePage', 'continuity']) ||
      !SAFE_ID.test(paragraph.id ?? '') ||
      !Number.isSafeInteger(paragraph.sourcePage) ||
      paragraph.sourcePage < 1 ||
      paragraph.continuity !== 'source-proven-continuous'
    ) {
      invalid(code)
    }
  }
}

function validateBoilerplateGroundTruth(value, code) {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['excluded', 'bodyLineCount', 'review']) ||
    !Array.isArray(value.excluded) ||
    !Number.isSafeInteger(value.bodyLineCount) ||
    value.bodyLineCount <= 0
  ) {
    invalid(code)
  }
  if (!uniqueBy(value.excluded, (item) => item.id)) invalid(code)
  validateGroundTruthReview(value.review, code)
  for (const item of value.excluded) {
    if (
      !exactKeys(item, ['id', 'sourcePage', 'kind']) ||
      !SAFE_ID.test(item.id ?? '') ||
      !Number.isSafeInteger(item.sourcePage) ||
      item.sourcePage < 1 ||
      !['running-head', 'page-number'].includes(item.kind)
    ) {
      invalid(code)
    }
  }
}

function validateFootnoteGroundTruth(value, code) {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['references', 'bodies', 'review']) ||
    !Array.isArray(value.references) ||
    !Array.isArray(value.bodies) ||
    value.references.length === 0 ||
    value.bodies.length === 0
  ) {
    invalid(code)
  }
  validateGroundTruthReview(value.review, code)
  const bodyIds = new Set()
  for (const body of value.bodies) {
    if (
      !exactKeys(body, ['id', 'sourcePage', 'marker']) ||
      !SAFE_ID.test(body.id ?? '') ||
      !Number.isSafeInteger(body.sourcePage) ||
      body.sourcePage < 1 ||
      typeof body.marker !== 'string' ||
      body.marker.length === 0
    ) {
      invalid(code)
    }
    bodyIds.add(body.id)
  }
  if (bodyIds.size !== value.bodies.length) invalid(code)
  if (!uniqueBy(value.references, (reference) => reference.id)) {
    invalid(code)
  }
  for (const reference of value.references) {
    if (
      !exactKeys(reference, ['id', 'sourcePage', 'marker', 'bodyId']) ||
      !SAFE_ID.test(reference.id ?? '') ||
      !Number.isSafeInteger(reference.sourcePage) ||
      reference.sourcePage < 1 ||
      typeof reference.marker !== 'string' ||
      !bodyIds.has(reference.bodyId)
    ) {
      invalid(code)
    }
  }
}

function validateColumnGroundTruth(value, code) {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['columnCount', 'columns', 'readingOrder', 'review']) ||
    !Number.isSafeInteger(value.columnCount) ||
    value.columnCount < 1 ||
    !Array.isArray(value.columns) ||
    value.columns.length !== value.columnCount ||
    !Array.isArray(value.readingOrder) ||
    value.readingOrder.length < 2
  ) {
    invalid(code)
  }
  validateGroundTruthReview(value.review, code)
  for (const column of value.columns) {
    if (
      !exactKeys(column, ['id', 'index']) ||
      !SAFE_ID.test(column.id ?? '') ||
      !Number.isSafeInteger(column.index) ||
      column.index < 0 ||
      column.index >= value.columnCount
    ) {
      invalid(code)
    }
  }
  if (
    !uniqueBy(value.columns, (column) => column.index) ||
    !uniqueBy(value.columns, (column) => column.id) ||
    !uniqueBy(value.readingOrder, (id) => id) ||
    !value.readingOrder.every((id) => SAFE_ID.test(id))
  ) {
    invalid(code)
  }
}

function validateCaseGroundTruth(value, stratum, code) {
  if (!isRecord(value) || !exactKeys(value, ['sourcePage', 'groundTruth'])) {
    invalid(code)
  }
  if (!Number.isSafeInteger(value.sourcePage) || value.sourcePage < 1) {
    invalid(code)
  }
  const groundTruth = value.groundTruth
  if (stratum === 'table-structure') {
    validateTableGroundTruth(groundTruth, code)
  } else if (stratum === 'heading-structure') {
    validateHeadingGroundTruth(groundTruth, code)
  } else if (stratum === 'display-equation') {
    validateObjectGroundTruth(groundTruth, code, 'display-equation')
  } else if (stratum === 'figure-diagram') {
    validateObjectGroundTruth(groundTruth, code, 'figure-or-diagram')
  } else if (stratum === 'prose-continuity') {
    validateProseGroundTruth(groundTruth, code)
  } else if (stratum === 'boilerplate-exclusion') {
    validateBoilerplateGroundTruth(groundTruth, code)
  } else if (stratum === 'footnote-resolution') {
    validateFootnoteGroundTruth(groundTruth, code)
  } else if (stratum === 'column-layout') {
    validateColumnGroundTruth(groundTruth, code)
  } else {
    invalid(code)
  }
}

function validateGroundTruthSourcePages(value, pageCount, code) {
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    if (!isRecord(current)) continue
    for (const [key, child] of Object.entries(current)) {
      if (
        key === 'sourcePage' &&
        (!Number.isSafeInteger(child) || child < 1 || child > pageCount)
      ) {
        invalid(code)
      }
      if (isRecord(child) || Array.isArray(child)) pending.push(child)
    }
  }
}

function validateStratum(value, code) {
  if (!expectedStratum(value)) invalid(code)
  validateGroundTruthReview(value.groundTruth, code)
  validateGuard(value.degenerateAnswerGuard, value.id, code)
  validateMetric(value.metric, value.degenerateAnswerGuard.id, code)
}

function validateProtocol(value, code) {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'command',
      'reportPrivacy',
      'sourceLabelPolicy',
      'regexProxyPolicy',
      'abstentionPolicy',
      'corpusBalance',
    ]) ||
    value.command !== 'npm run pdf:benchmark:extraction' ||
    value.reportPrivacy !== PDF_EXTRACTION_EVAL_REPORT_PRIVACY ||
    value.sourceLabelPolicy !==
      'source-review-required-parser-output-never-a-label' ||
    value.regexProxyPolicy !==
      'authoritative-pipeline-counters-only-regex-never-gates' ||
    !isRecord(value.abstentionPolicy) ||
    !exactKeys(value.abstentionPolicy, [
      'score',
      'beatsDegenerateAnswer',
      'status',
    ]) ||
    value.abstentionPolicy.score !== ABSTENTION_SCORE ||
    value.abstentionPolicy.beatsDegenerateAnswer !== true ||
    value.abstentionPolicy.status !== 'reported-not-correct' ||
    !isRecord(value.corpusBalance) ||
    !exactKeys(value.corpusBalance, [
      'layouts',
      'minimumDocumentsPerLayout',
      'reportByLayout',
    ]) ||
    canonicalJson(value.corpusBalance.layouts) !==
      canonicalJson(EXTRACTION_LAYOUTS) ||
    !Number.isSafeInteger(value.corpusBalance.minimumDocumentsPerLayout) ||
    value.corpusBalance.minimumDocumentsPerLayout < 1 ||
    value.corpusBalance.reportByLayout !== true
  ) {
    invalid(code)
  }
}

/**
 * Validate the source-reviewed strata artifact without consulting any parser
 * output.  The returned identity is suitable for binding provider reports.
 */
export function validatePdfExtractionEvalSet(value) {
  try {
    if (
      !isRecord(value) ||
      !exactKeys(value, [
        'schemaVersion',
        'id',
        'privacy',
        'protocol',
        'documents',
        'strata',
        'cases',
      ]) ||
      value.schemaVersion !== PDF_EXTRACTION_EVAL_SCHEMA_VERSION ||
      !SAFE_ID.test(value.id ?? '') ||
      value.privacy !== PDF_EXTRACTION_EVAL_PRIVACY ||
      !Array.isArray(value.documents) ||
      !Array.isArray(value.strata) ||
      !Array.isArray(value.cases) ||
      value.documents.length < 2 ||
      value.strata.length !== EXTRACTION_STRATA.length ||
      value.cases.length === 0 ||
      !uniqueBy(value.documents, ({ id }) => id) ||
      !uniqueBy(value.strata, ({ id }) => id) ||
      !uniqueBy(value.cases, ({ id }) => id)
    ) {
      invalid('INVALID_PDF_EXTRACTION_EVAL_SET')
    }
    validateProtocol(value.protocol, 'INVALID_PDF_EXTRACTION_EVAL_SET')
    for (const document of value.documents) {
      validateDocument(document, 'INVALID_PDF_EXTRACTION_EVAL_SET')
    }
    for (const stratum of value.strata) {
      validateStratum(stratum, 'INVALID_PDF_EXTRACTION_EVAL_SET')
    }
    const documents = new Map(value.documents.map((item) => [item.id, item]))
    const strata = new Map(value.strata.map((item) => [item.id, item]))
    for (const item of value.cases) {
      if (
        !isRecord(item) ||
        !exactKeys(item, ['id', 'documentId', 'stratum', 'layout', 'source']) ||
        !SAFE_ID.test(item.id ?? '') ||
        !documents.has(item.documentId) ||
        !strata.has(item.stratum) ||
        item.layout !== documents.get(item.documentId).layout ||
        !EXTRACTION_LAYOUTS.includes(item.layout) ||
        item.source?.sourcePage > documents.get(item.documentId).pageCount
      ) {
        invalid('INVALID_PDF_EXTRACTION_EVAL_SET')
      }
      validateCaseGroundTruth(
        item.source,
        item.stratum,
        'INVALID_PDF_EXTRACTION_EVAL_SET',
      )
      validateGroundTruthSourcePages(
        item.source,
        documents.get(item.documentId).pageCount,
        'INVALID_PDF_EXTRACTION_EVAL_SET',
      )
    }
    const usedStrata = new Set(value.cases.map(({ stratum }) => stratum))
    if (EXTRACTION_STRATA.some((id) => !usedStrata.has(id))) {
      invalid('PDF_EXTRACTION_EVAL_MISSING_STRATUM')
    }
    for (const stratumId of EXTRACTION_STRATA) {
      for (const layout of EXTRACTION_LAYOUTS) {
        if (
          !value.cases.some(
            (item) => item.stratum === stratumId && item.layout === layout,
          )
        ) {
          invalid('PDF_EXTRACTION_EVAL_LAYOUT_IMBALANCED')
        }
      }
    }
    const layoutCounts = Object.fromEntries(
      EXTRACTION_LAYOUTS.map((layout) => [
        layout,
        value.documents.filter((document) => document.layout === layout).length,
      ]),
    )
    if (
      Object.values(layoutCounts).some(
        (count) =>
          count < value.protocol.corpusBalance.minimumDocumentsPerLayout,
      )
    ) {
      invalid('PDF_EXTRACTION_EVAL_LAYOUT_IMBALANCED')
    }
    const hasNonEnglishHeading = value.cases.some(
      (item) =>
        item.stratum === 'heading-structure' &&
        item.source.groundTruth.headings.some(
          (heading) => !/^en(?:[-_]|$)/i.test(heading.language),
        ),
    )
    if (!hasNonEnglishHeading) {
      invalid('PDF_EXTRACTION_EVAL_MISSING_NON_ENGLISH_HEADING')
    }
    const identityProjection = evalSetIdentityProjection(value)
    return {
      valid: true,
      id: value.id,
      schemaVersion: value.schemaVersion,
      evalSetSha256: canonicalHash(identityProjection),
      documentIdentitySha256: canonicalHash(
        value.documents.map(({ id, sha256: sourceSha256, layout }) => ({
          id,
          sourceSha256,
          layout,
        })),
      ),
      caseIdentitySha256: canonicalHash(identityProjection.cases),
      documentCount: value.documents.length,
      caseCount: value.cases.length,
      stratumCount: value.strata.length,
      layoutCounts,
    }
  } catch (error) {
    if (
      error instanceof Error &&
      /^PDF_EXTRACTION|^INVALID_PDF_EXTRACTION/.test(error.message)
    ) {
      throw error
    }
    invalid('INVALID_PDF_EXTRACTION_EVAL_SET')
  }
}

async function readRepositoryJson(repositoryPath, code) {
  if (!pathIsRepositoryRelative(repositoryPath)) invalid(code)
  const root = await realpath(REPOSITORY_ROOT)
  const absolute = resolve(root, repositoryPath)
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) invalid(code)
  try {
    const details = await lstat(absolute)
    const canonical = await realpath(absolute)
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      (canonical !== root && !canonical.startsWith(`${root}${sep}`)) ||
      details.size <= 0 ||
      details.size > MAX_JSON_BYTES
    ) {
      invalid(code)
    }
    const bytes = await readFile(canonical)
    if (bytes.byteLength !== details.size) invalid(code)
    return { value: JSON.parse(bytes.toString('utf8')), bytes }
  } catch {
    invalid(code)
  }
}

async function validateReviewEvidenceFiles(value, identity) {
  const reviewValues = reviewValuesForEvalSet(value)
  const agreed = reviewValues.filter(
    (review) => review.reviewStatus === 'two-reviewer-agreed',
  )
  if (agreed.length === 0) return
  if (
    reviewValues.some((review) => review.reviewStatus === 'review-required')
  ) {
    invalid('PDF_EXTRACTION_REVIEW_INCOMPLETE')
  }
  const evidence = agreed[0].reviewEvidence
  if (
    agreed.some(
      (review) =>
        canonicalJson(review.reviewEvidence) !== canonicalJson(evidence),
    )
  ) {
    invalid('PDF_EXTRACTION_REVIEW_EVIDENCE_BINDING_MISMATCH')
  }
  const rosterArtifact = await readRepositoryJson(
    evidence.rosterPath,
    'PDF_EXTRACTION_REVIEW_ROSTER_FILE',
  )
  if (
    sha256(rosterArtifact.bytes) !== evidence.rosterSha256 ||
    !exactKeys(rosterArtifact.value, [
      'schemaVersion',
      'kind',
      'evalSetId',
      'reviewers',
    ]) ||
    rosterArtifact.value.schemaVersion !==
      PDF_EXTRACTION_EVAL_REVIEW_SCHEMA_VERSION ||
    rosterArtifact.value.kind !== 'pdf-extraction-reviewer-roster' ||
    rosterArtifact.value.evalSetId !== identity.id ||
    !isRecord(rosterArtifact.value.reviewers) ||
    Object.keys(rosterArtifact.value.reviewers).length < 2
  ) {
    invalid('PDF_EXTRACTION_REVIEW_ROSTER_MISMATCH')
  }
  for (const [identityEvidenceSha256, reviewerId] of Object.entries(
    rosterArtifact.value.reviewers,
  )) {
    if (
      !SHA256.test(identityEvidenceSha256) ||
      typeof reviewerId !== 'string' ||
      !SAFE_ID.test(reviewerId ?? '')
    ) {
      invalid('PDF_EXTRACTION_REVIEW_ROSTER_MISMATCH')
    }
  }
  const rosterIds = new Set(Object.keys(rosterArtifact.value.reviewers))
  const decisionArtifact = await readRepositoryJson(
    evidence.decisionPath,
    'PDF_EXTRACTION_REVIEW_DECISION_FILE',
  )
  if (
    sha256(decisionArtifact.bytes) !== evidence.decisionSha256 ||
    !exactKeys(decisionArtifact.value, [
      'schemaVersion',
      'kind',
      'evalSetId',
      'evalSetSha256',
      'sourceOnly',
      'candidateOutputConsultedForLabel',
      'decisions',
    ]) ||
    decisionArtifact.value.schemaVersion !==
      PDF_EXTRACTION_EVAL_REVIEW_SCHEMA_VERSION ||
    decisionArtifact.value.kind !== 'pdf-extraction-source-only-decisions' ||
    decisionArtifact.value.evalSetId !== identity.id ||
    decisionArtifact.value.evalSetSha256 !== identity.evalSetSha256 ||
    decisionArtifact.value.sourceOnly !== true ||
    decisionArtifact.value.candidateOutputConsultedForLabel !== false ||
    !Array.isArray(decisionArtifact.value.decisions) ||
    !uniqueBy(decisionArtifact.value.decisions, (decision) => decision.caseId)
  ) {
    invalid('PDF_EXTRACTION_REVIEW_DECISION_MISMATCH')
  }
  const documentById = new Map(value.documents.map((item) => [item.id, item]))
  const caseIds = new Set(value.cases.map((item) => item.id))
  for (const decision of decisionArtifact.value.decisions) {
    if (
      !exactKeys(decision, [
        'caseId',
        'sourceSha256',
        'reviewers',
        'decision',
        'decisionSha256',
      ]) ||
      !caseIds.has(decision.caseId) ||
      !SHA256.test(decision.sourceSha256 ?? '') ||
      decision.sourceSha256 !==
        documentById.get(
          value.cases.find((item) => item.id === decision.caseId).documentId,
        ).sha256 ||
      !Array.isArray(decision.reviewers) ||
      decision.reviewers.length < 2 ||
      !uniqueBy(decision.reviewers, (reviewer) => reviewer) ||
      !decision.reviewers.every((reviewer) => rosterIds.has(reviewer)) ||
      decision.decision !== 'agreed' ||
      !SHA256.test(decision.decisionSha256 ?? '')
    ) {
      invalid('PDF_EXTRACTION_REVIEW_DECISION_MISMATCH')
    }
  }
  const agreedCaseIds = new Set(
    decisionArtifact.value.decisions.map((decision) => decision.caseId),
  )
  if ([...caseIds].some((caseId) => !agreedCaseIds.has(caseId))) {
    invalid('PDF_EXTRACTION_REVIEW_DECISION_MISMATCH')
  }
  const decisionByCaseId = new Map(
    decisionArtifact.value.decisions.map((decision) => [
      decision.caseId,
      decision,
    ]),
  )
  for (const review of agreed) {
    if (review.reviewers.some((reviewer) => !rosterIds.has(reviewer))) {
      invalid('PDF_EXTRACTION_REVIEW_ROSTER_MISMATCH')
    }
  }
  for (const item of value.cases) {
    const decision = decisionByCaseId.get(item.id)
    const caseReview = item.source.groundTruth.review
    if (
      !decision ||
      canonicalJson([...caseReview.reviewers].sort()) !==
        canonicalJson([...decision.reviewers].sort())
    ) {
      invalid('PDF_EXTRACTION_REVIEW_DECISION_MISMATCH')
    }
  }
  Object.defineProperty(value, REVIEW_EVIDENCE_VALIDATED, {
    value: identity.evalSetSha256,
    enumerable: false,
    configurable: true,
  })
}

function reviewValuesForEvalSet(value) {
  return [
    ...value.documents.map((item) => item.groundTruthReview),
    ...value.strata.map((item) => item.groundTruth),
    ...value.cases.map((item) => item.source.groundTruth.review),
  ]
}

export async function validatePdfExtractionEvalSetFiles(value) {
  const identity = validatePdfExtractionEvalSet(value)
  await validateReviewEvidenceFiles(value, identity)
  for (const document of value.documents) {
    if (!pathIsRepositoryRelative(document.fixturePath)) {
      invalid('INVALID_PDF_EXTRACTION_FIXTURE_PATH')
    }
    try {
      const absolute = resolve(REPOSITORY_ROOT, document.fixturePath)
      const details = await lstat(absolute)
      const canonical = await realpath(absolute)
      if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        (canonical !== REPOSITORY_ROOT &&
          !canonical.startsWith(`${REPOSITORY_ROOT}${sep}`))
      ) {
        invalid('INVALID_PDF_EXTRACTION_FIXTURE')
      }
      const bytes = await readFile(canonical)
      if (
        bytes.byteLength !== document.byteLength ||
        sha256(bytes) !== document.sha256
      ) {
        invalid('PDF_EXTRACTION_FIXTURE_IDENTITY_MISMATCH')
      }
    } catch {
      invalid('INVALID_PDF_EXTRACTION_FIXTURE')
    }
  }
  return identity
}

function validateCandidateProvider(value, evalIdentity, code) {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'evalSetId',
      'evalSetSha256',
      'provider',
      'cases',
    ]) ||
    value.schemaVersion !== PDF_EXTRACTION_EVAL_SCHEMA_VERSION ||
    value.evalSetId !== evalIdentity.id ||
    value.evalSetSha256 !== evalIdentity.evalSetSha256 ||
    !isRecord(value.provider) ||
    !exactKeys(value.provider, [
      'id',
      'kind',
      'version',
      'sourceIdentitySha256',
    ]) ||
    !SAFE_ID.test(value.provider.id ?? '') ||
    !EXTRACTION_PROVIDER_KINDS.includes(value.provider.kind) ||
    !SAFE_ID.test(value.provider.version ?? '') ||
    (value.provider.sourceIdentitySha256 !== null &&
      !SHA256.test(value.provider.sourceIdentitySha256 ?? '')) ||
    !Array.isArray(value.cases) ||
    !uniqueBy(value.cases, ({ caseId }) => caseId)
  ) {
    invalid(code)
  }
  for (const item of value.cases) {
    if (
      !exactKeys(item, ['caseId', 'status', 'prediction', 'diagnostics']) ||
      !SAFE_ID.test(item.caseId ?? '') ||
      !['scored', 'abstain'].includes(item.status) ||
      (item.status === 'abstain' && item.prediction !== null) ||
      !Array.isArray(item.diagnostics) ||
      !item.diagnostics.every((diagnostic) => SAFE_DIAGNOSTIC.test(diagnostic))
    ) {
      invalid(code)
    }
  }
  return value
}

export function validatePdfExtractionCandidate(value, evalSetOrIdentity) {
  const identity = evalSetOrIdentity?.evalSetSha256
    ? evalSetOrIdentity
    : validatePdfExtractionEvalSet(evalSetOrIdentity)
  return validateCandidateProvider(
    value,
    identity,
    'INVALID_PDF_EXTRACTION_CANDIDATE',
  )
}

function indexCases(evalSet) {
  return new Map(evalSet.cases.map((item) => [item.id, item]))
}

function stratumById(evalSet) {
  return new Map(evalSet.strata.map((item) => [item.id, item]))
}

function diagnosticResult(score, status, diagnostics, extra = {}) {
  return {
    score: rounded(Math.max(0, Math.min(1, score))),
    status,
    diagnostics: [...new Set(diagnostics.map(safeDiagnostic))].sort(),
    ...extra,
  }
}

function abstainedResult(code = 'CANDIDATE_ABSTAINED') {
  return diagnosticResult(ABSTENTION_SCORE, 'abstained', [code])
}

function degenerateResult(code = 'DEGENERATE_EMPTY_OUTPUT') {
  return diagnosticResult(DEGENERATE_SCORE, 'degenerate', [code])
}

function predictionArray(prediction, key) {
  return Array.isArray(prediction?.[key]) ? prediction[key] : null
}

function sourceBindingMatches(expected, candidate) {
  return (
    hasValidSourceBinding(candidate) &&
    normalizedBoxArea(expected.box) > 0 &&
    normalizedBoxArea(candidate.box) > 0 &&
    canonicalJson(candidate.box) === canonicalJson(expected.box) &&
    canonicalJson(candidate.sourceRegionIds) ===
      canonicalJson(expected.sourceRegionIds) &&
    canonicalJson(candidate.sourceLineIds) ===
      canonicalJson(expected.sourceLineIds)
  )
}

function hasValidSourceBinding(value) {
  return (
    isRecord(value) &&
    isNormalizedBox(value.box) &&
    normalizedBoxArea(value.box) > 0 &&
    Array.isArray(value.sourceRegionIds) &&
    value.sourceRegionIds.length > 0 &&
    uniqueBy(value.sourceRegionIds, (id) => id) &&
    value.sourceRegionIds.every((id) => SAFE_ID.test(id ?? '')) &&
    Array.isArray(value.sourceLineIds) &&
    value.sourceLineIds.length > 0 &&
    uniqueBy(value.sourceLineIds, (id) => id) &&
    value.sourceLineIds.every((id) => SAFE_ID.test(id ?? ''))
  )
}

function missingSourceBinding(predictions) {
  return predictions.some((prediction) => !hasValidSourceBinding(prediction))
}

function hasValidPredictedTableCells(table) {
  if (
    !isRecord(table) ||
    !Number.isSafeInteger(table.rows) ||
    table.rows < 1 ||
    !Number.isSafeInteger(table.columns) ||
    table.columns < 1 ||
    !Array.isArray(table.cells) ||
    table.cells.length === 0
  ) {
    return false
  }
  const coordinates = new Set()
  return table.cells.every(
    (cell) =>
      exactKeys(cell, ['row', 'column', 'rowSpan', 'columnSpan', 'text']) &&
      Number.isSafeInteger(cell.row) &&
      cell.row >= 0 &&
      cell.row < table.rows &&
      Number.isSafeInteger(cell.column) &&
      cell.column >= 0 &&
      cell.column < table.columns &&
      cell.rowSpan === 1 &&
      cell.columnSpan === 1 &&
      typeof cell.text === 'string' &&
      cell.text.trim().length > 0 &&
      !coordinates.has(`${cell.row}:${cell.column}`) &&
      coordinates.add(`${cell.row}:${cell.column}`),
  )
}

function tableScore(expected, prediction) {
  const expectedTables = expected.tables
  const predictedTables = predictionArray(prediction, 'tables')
  if (!predictedTables) return degenerateResult()
  if (predictedTables.length === 0) return degenerateResult()
  if (missingSourceBinding(predictedTables)) {
    return degenerateResult('MISSING_TABLE_GEOMETRY_OR_LINEAGE')
  }
  if (
    predictedTables.some(
      (table) =>
        table?.pageWide === true || normalizedBoxArea(table?.box) > 0.8,
    )
  ) {
    return degenerateResult('DEGENERATE_PAGE_WIDE_GRID')
  }
  if (predictedTables.some((table) => !hasValidPredictedTableCells(table))) {
    return degenerateResult('INVALID_TABLE_CELLS')
  }
  const matchedPredictions = new Set()
  const tableScores = expectedTables.map((table) => {
    const candidateIndex = predictedTables.findIndex(
      (candidate, index) =>
        !matchedPredictions.has(index) &&
        candidate.rows === table.rows &&
        candidate.columns === table.columns &&
        candidate.headerScope === table.headerScope &&
        candidate.sourcePage === table.sourcePage &&
        sourceBindingMatches(table, candidate),
    )
    if (candidateIndex < 0) return 0
    matchedPredictions.add(candidateIndex)
    const candidate = predictedTables[candidateIndex]
    const cells = new Map(
      candidate.cells.map((cell) => [`${cell.row}:${cell.column}`, cell]),
    )
    const matchedCells = table.cells.filter((cell) => {
      const predictedCell = cells.get(`${cell.row}:${cell.column}`)
      return (
        predictedCell?.text === cell.text &&
        predictedCell.rowSpan === cell.rowSpan &&
        predictedCell.columnSpan === cell.columnSpan
      )
    }).length
    return f1(matchedCells, table.cells.length, candidate.cells.length)
  })
  const topologyScore = average(tableScores)
  const extraPenalty =
    predictedTables.length > expectedTables.length
      ? expectedTables.length / predictedTables.length
      : 1
  return diagnosticResult(topologyScore * extraPenalty, 'scored', [], {
    expected: expectedTables.length,
    predicted: predictedTables.length,
  })
}

function headingScore(expected, prediction) {
  const headings = predictionArray(prediction, 'headings')
  if (!headings) return degenerateResult()
  if (headings.length === 0) return degenerateResult()
  if (!headings.every(isRecord)) {
    return degenerateResult('INVALID_HEADING_OUTPUT')
  }
  if (
    prediction.everyLineIsHeading === true ||
    headings.length > expected.headings.length * 2
  ) {
    return degenerateResult('DEGENERATE_EVERY_LINE_HEADING')
  }
  const expectedKeys = expected.headings.map(
    (heading) => `${heading.text}\0${heading.level}`,
  )
  const predictedKeys = headings.map(
    (heading) => `${heading.text}\0${heading.level}`,
  )
  const matched = orderedMatchCount(expectedKeys, predictedKeys)
  return diagnosticResult(
    f1(matched, expected.headings.length, headings.length),
    'scored',
    [],
    { expected: expected.headings.length, predicted: headings.length },
  )
}

function objectScore(expected, prediction, key, degenerateCode) {
  const objects = predictionArray(prediction, key)
  if (!objects) return degenerateResult()
  if (objects.length === 0) return degenerateResult()
  if (missingSourceBinding(objects)) {
    return degenerateResult('MISSING_OBJECT_GEOMETRY_OR_LINEAGE')
  }
  if (
    objects.some(
      (object) =>
        object?.pageWide === true || normalizedBoxArea(object?.box) > 0.9,
    )
  ) {
    return degenerateResult(degenerateCode)
  }
  const expectedObjects = expected.objects
  const matchedObjects = new Set()
  const matched = expectedObjects.reduce((count, item) => {
    const candidateIndex = objects.findIndex(
      (candidate, index) =>
        !matchedObjects.has(index) &&
        candidate.kind === item.kind &&
        candidate.sourcePage === item.sourcePage &&
        candidate.captionRelationship === item.captionRelationship &&
        candidate.bounded === true &&
        sourceBindingMatches(item, candidate),
    )
    if (candidateIndex < 0) return count
    matchedObjects.add(candidateIndex)
    return count + 1
  }, 0)
  return diagnosticResult(
    f1(matched, expectedObjects.length, objects.length),
    'scored',
    [],
    { expected: expectedObjects.length, predicted: objects.length },
  )
}

function proseScore(expected, prediction) {
  if (!isRecord(prediction)) return degenerateResult()
  if (Object.hasOwn(prediction, 'regexBrokenJoinCount')) {
    invalid('PDF_EXTRACTION_REGEX_PROXY_NOT_AUTHORITATIVE')
  }
  const counters = prediction.authoritativeCounters
  if (
    !isRecord(counters) ||
    !exactKeys(counters, [
      'lineBoundaryCount',
      'decidedLineBoundaryCount',
      'unresolvedCorruptingJoinCount',
    ]) ||
    !Object.values(counters).every(nonNegativeInteger)
  ) {
    return degenerateResult('MISSING_AUTHORITATIVE_PROSE_COUNTERS')
  }
  const expectedCount = Math.max(
    1,
    expected.authoritativeCounters.lineBoundaryCount,
  )
  if (
    counters.lineBoundaryCount !==
      expected.authoritativeCounters.lineBoundaryCount ||
    counters.decidedLineBoundaryCount !== counters.lineBoundaryCount ||
    counters.decidedLineBoundaryCount > counters.lineBoundaryCount ||
    counters.unresolvedCorruptingJoinCount > counters.decidedLineBoundaryCount
  ) {
    return degenerateResult('INVALID_PROSE_COUNTERS')
  }
  const score = Math.max(
    0,
    1 - counters.unresolvedCorruptingJoinCount / expectedCount,
  )
  return diagnosticResult(score, 'scored', [], {
    unresolvedCorruptingJoinCount: counters.unresolvedCorruptingJoinCount,
  })
}

function boilerplateScore(expected, prediction) {
  if (!isRecord(prediction)) return degenerateResult()
  const counters = prediction.contamination
  const excluded = predictionArray(prediction, 'excluded')
  if (
    !isRecord(counters) ||
    !exactKeys(counters, [
      'runningHeadContaminationCount',
      'pageNumberContaminationCount',
      'excludedCount',
    ]) ||
    !Object.values(counters).every(nonNegativeInteger)
  ) {
    return degenerateResult('MISSING_BOILERPLATE_COUNTERS')
  }
  if (
    !excluded ||
    excluded.some(
      (item) =>
        !isRecord(item) ||
        !exactKeys(item, ['id', 'sourcePage', 'kind']) ||
        !SAFE_ID.test(item.id ?? '') ||
        !Number.isSafeInteger(item.sourcePage) ||
        item.sourcePage < 1 ||
        !['running-head', 'page-number'].includes(item.kind),
    ) ||
    !uniqueBy(
      excluded,
      (item) => `${item.id}\0${item.sourcePage}\0${item.kind}`,
    )
  ) {
    return degenerateResult('MISSING_BOILERPLATE_IDENTITIES')
  }
  if (
    excluded.length > expected.bodyLineCount ||
    excluded.length > expected.bodyLineCount * 0.75
  ) {
    return degenerateResult('DEGENERATE_EXCLUDING_EVERY_LINE')
  }
  const identity = (item) => `${item.id}\0${item.sourcePage}\0${item.kind}`
  const expectedKeys = new Set(expected.excluded.map(identity))
  const predictedKeys = new Set(excluded.map(identity))
  const missed = expected.excluded.filter(
    (item) => !predictedKeys.has(identity(item)),
  )
  if (
    counters.excludedCount !== excluded.length ||
    counters.runningHeadContaminationCount !==
      missed.filter((item) => item.kind === 'running-head').length ||
    counters.pageNumberContaminationCount !==
      missed.filter((item) => item.kind === 'page-number').length
  ) {
    return degenerateResult('INVALID_BOILERPLATE_COUNTERS')
  }
  const matched = excluded.filter((item) =>
    expectedKeys.has(identity(item)),
  ).length
  const score =
    expected.excluded.length === 0 && excluded.length === 0
      ? 1
      : f1(matched, expected.excluded.length, excluded.length)
  const diagnostics =
    matched === expected.excluded.length && matched === excluded.length
      ? []
      : ['INCOMPLETE_BOILERPLATE_EXCLUSION']
  return diagnosticResult(score, 'scored', diagnostics, {
    expectedExcluded: expected.excluded.length,
    predictedExcluded: excluded.length,
  })
}

function relationshipScore(expected, prediction) {
  const relationships = predictionArray(prediction, 'relationships')
  if (!relationships) return degenerateResult()
  if (relationships.length === 0) return degenerateResult()
  const relationshipKeys = relationships.map(
    (relationship) =>
      `${relationship?.referenceId}\0${relationship?.bodyId}\0${relationship?.marker}`,
  )
  if (!uniqueBy(relationshipKeys, (key) => key)) {
    return degenerateResult('DEGENERATE_DUPLICATE_FOOTNOTE_RELATIONSHIP')
  }
  if (
    new Set(expected.references.map((reference) => reference.bodyId)).size >
      1 &&
    relationships.length > 1 &&
    new Set(relationships.map((item) => item?.bodyId)).size === 1 &&
    relationships.some((item) => {
      const expectedReference = expected.references.find(
        (reference) => reference.id === item?.referenceId,
      )
      return (
        !expectedReference ||
        expectedReference.bodyId !== item?.bodyId ||
        expectedReference.marker !== item?.marker
      )
    })
  ) {
    return degenerateResult('DEGENERATE_SINGLE_FOOTNOTE_OWNER')
  }
  const expectedKeys = new Set(
    expected.references.map(
      (reference) =>
        `${reference.id}\0${reference.bodyId}\0${reference.marker}`,
    ),
  )
  const matched = relationships.filter((relationship) =>
    expectedKeys.has(
      `${relationship?.referenceId}\0${relationship?.bodyId}\0${relationship?.marker}`,
    ),
  ).length
  return diagnosticResult(
    f1(matched, expected.references.length, relationships.length),
    'scored',
    [],
    { expected: expected.references.length, predicted: relationships.length },
  )
}

function columnScore(expected, prediction) {
  if (!isRecord(prediction)) return degenerateResult()
  if (!Array.isArray(prediction.order) || prediction.order.length === 0) {
    return degenerateResult()
  }
  if (prediction.pageWideSingleColumn === true) {
    return degenerateResult('DEGENERATE_PAGE_WIDE_SINGLE_COLUMN')
  }
  const expectedOrder = expected.readingOrder
  const order = prediction.order
  if (expected.columnCount > 1 && prediction.columnCount === 1) {
    return degenerateResult('DEGENERATE_PAGE_WIDE_SINGLE_COLUMN')
  }
  if (
    !Number.isSafeInteger(prediction.columnCount) ||
    prediction.columnCount < 1 ||
    !order.every((id) => expectedOrder.includes(id)) ||
    !uniqueBy(order, (id) => id)
  ) {
    return degenerateResult('INVALID_COLUMN_ORDER')
  }
  const pairs = []
  for (let index = 0; index < expectedOrder.length; index += 1) {
    for (let next = index + 1; next < expectedOrder.length; next += 1) {
      pairs.push([expectedOrder[index], expectedOrder[next]])
    }
  }
  const indexes = new Map(order.map((id, index) => [id, index]))
  const matched = pairs.filter(
    ([left, right]) =>
      indexes.has(left) &&
      indexes.has(right) &&
      indexes.get(left) < indexes.get(right),
  ).length
  const pairScore = pairs.length === 0 ? 0 : matched / pairs.length
  const countScore = prediction.columnCount === expected.columnCount ? 1 : 0
  return diagnosticResult(average([pairScore, countScore]), 'scored', [], {
    expected: expected.columnCount,
    predicted: prediction.columnCount ?? null,
  })
}

function scoreCase(item, stratum, output) {
  if (!output || output.status === 'abstain') return abstainedResult()
  const prediction = output.prediction
  const expected = item.source.groundTruth
  if (stratum.id === 'table-structure') return tableScore(expected, prediction)
  if (stratum.id === 'heading-structure')
    return headingScore(expected, prediction)
  if (stratum.id === 'display-equation') {
    return objectScore(
      expected,
      prediction,
      'objects',
      'DEGENERATE_PAGE_WIDE_EQUATION',
    )
  }
  if (stratum.id === 'figure-diagram') {
    return objectScore(
      expected,
      prediction,
      'objects',
      'DEGENERATE_PAGE_WIDE_FIGURE',
    )
  }
  if (stratum.id === 'prose-continuity') return proseScore(expected, prediction)
  if (stratum.id === 'boilerplate-exclusion') {
    return boilerplateScore(expected, prediction)
  }
  if (stratum.id === 'footnote-resolution') {
    return relationshipScore(expected, prediction)
  }
  if (stratum.id === 'column-layout') return columnScore(expected, prediction)
  invalid('INVALID_PDF_EXTRACTION_STRATUM')
}

function noGroundTruthOutput(evalSet, identity, provider) {
  return {
    schemaVersion: PDF_EXTRACTION_EVAL_SCHEMA_VERSION,
    evalSetId: evalSet.id,
    evalSetSha256: identity.evalSetSha256,
    provider: {
      id: provider.id,
      kind: provider.kind,
      version: provider.version,
      sourceIdentitySha256: provider.sourceIdentitySha256 ?? null,
    },
    cases: [],
  }
}

export function createAbstainingPdfExtractionCandidate(evalSet, provider) {
  const identity = validatePdfExtractionEvalSet(evalSet)
  if (
    !isRecord(provider) ||
    !SAFE_ID.test(provider.id ?? '') ||
    !EXTRACTION_PROVIDER_KINDS.includes(provider.kind) ||
    !SAFE_ID.test(provider.version ?? '')
  ) {
    invalid('INVALID_PDF_EXTRACTION_PROVIDER')
  }
  const candidate = noGroundTruthOutput(evalSet, identity, provider)
  candidate.cases = evalSet.cases.map((item) => ({
    caseId: item.id,
    status: 'abstain',
    prediction: null,
    diagnostics: ['CANDIDATE_ABSTAINED'],
  }))
  validateCandidateProvider(
    candidate,
    identity,
    'INVALID_PDF_EXTRACTION_CANDIDATE',
  )
  return candidate
}

/**
 * Compare every provider against the same source-reviewed corpus.  Rows are
 * emitted for every provider × stratum × layout combination, including empty
 * combinations, so a layout disappearing cannot be hidden by an aggregate.
 */
export function comparePdfExtractionProviders(evalSet, providers) {
  const identity = validatePdfExtractionEvalSet(evalSet)
  const reviewValues = reviewValuesForEvalSet(evalSet)
  if (
    reviewValues.some(
      (review) => review.reviewStatus === 'two-reviewer-agreed',
    ) &&
    evalSet[REVIEW_EVIDENCE_VALIDATED] !== identity.evalSetSha256
  ) {
    invalid('PDF_EXTRACTION_REVIEW_EVIDENCE_NOT_VERIFIED')
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    invalid('PDF_EXTRACTION_NO_PROVIDERS')
  }
  if (!uniqueBy(providers, (candidate) => candidate?.provider?.id)) {
    invalid('PDF_EXTRACTION_DUPLICATE_PROVIDER')
  }
  const caseMap = indexCases(evalSet)
  const strata = stratumById(evalSet)
  const rows = []
  const providerSummaries = []
  for (const candidate of providers) {
    validateCandidateProvider(
      candidate,
      identity,
      'INVALID_PDF_EXTRACTION_CANDIDATE',
    )
    const outputMap = new Map(
      candidate.cases.map((item) => [item.caseId, item]),
    )
    if ([...outputMap.keys()].some((caseId) => !caseMap.has(caseId))) {
      invalid('PDF_EXTRACTION_PROVIDER_UNKNOWN_CASE')
    }
    const providerRows = []
    for (const stratumId of EXTRACTION_STRATA) {
      for (const layout of EXTRACTION_LAYOUTS) {
        const matchingCases = evalSet.cases.filter(
          (item) => item.stratum === stratumId && item.layout === layout,
        )
        const scores = []
        const diagnostics = []
        for (const item of matchingCases) {
          const output = outputMap.get(item.id)
          let result
          if (!output) {
            result = abstainedResult('MISSING_PROVIDER_CASE')
          } else {
            result = scoreCase(item, strata.get(stratumId), output)
          }
          scores.push(result)
          diagnostics.push(...result.diagnostics)
        }
        const row = {
          providerId: candidate.provider.id,
          providerKind: candidate.provider.kind,
          providerVersion: candidate.provider.version,
          stratum: stratumId,
          layout,
          caseCount: matchingCases.length,
          scoredCaseCount: scores.filter((item) => item.status === 'scored')
            .length,
          abstainedCaseCount: scores.filter(
            (item) => item.status === 'abstained',
          ).length,
          degenerateCaseCount: scores.filter(
            (item) => item.status === 'degenerate',
          ).length,
          score: scores.length
            ? average(scores.map((item) => item.score))
            : null,
          diagnostics: [...new Set(diagnostics)].sort(),
        }
        rows.push(row)
        providerRows.push(row)
      }
    }
    const hasScoredOutput = providerRows.some((row) => row.scoredCaseCount > 0)
    providerSummaries.push({
      providerId: candidate.provider.id,
      providerKind: candidate.provider.kind,
      providerVersion: candidate.provider.version,
      caseCount: candidate.cases.length,
      score: hasScoredOutput
        ? average(providerRows.map((row) => row.score))
        : null,
      diagnosticCodes: [
        ...new Set(providerRows.flatMap((row) => row.diagnostics)),
      ].sort(),
    })
  }
  const hasScoredOutput = providerSummaries.some(
    (provider) => provider.score !== null,
  )
  const reviewsComplete =
    reviewValues.every(
      (review) => review.reviewStatus === 'two-reviewer-agreed',
    ) && evalSet[REVIEW_EVIDENCE_VALIDATED] === identity.evalSetSha256
  const reviewBlocksComparison = hasScoredOutput && !reviewsComplete
  if (reviewBlocksComparison) {
    for (const provider of providerSummaries) provider.score = null
    for (const row of rows) {
      row.scoredCaseCount = 0
      row.abstainedCaseCount = 0
      row.degenerateCaseCount = 0
      row.score = null
    }
  }
  const reportWithoutHash = {
    schemaVersion: PDF_EXTRACTION_EVAL_REPORT_SCHEMA_VERSION,
    privacy: PDF_EXTRACTION_EVAL_REPORT_PRIVACY,
    status: hasScoredOutput && reviewsComplete ? 'comparison' : 'reported-only',
    diagnosticCodes: reviewBlocksComparison
      ? ['PDF_EXTRACTION_REVIEW_INCOMPLETE']
      : hasScoredOutput
        ? []
        : ['NO_SCORED_PROVIDER_OUTPUT'],
    evalSet: {
      id: identity.id,
      schemaVersion: identity.schemaVersion,
      evalSetSha256: identity.evalSetSha256,
      documentIdentitySha256: identity.documentIdentitySha256,
      caseIdentitySha256: identity.caseIdentitySha256,
      documentCount: identity.documentCount,
      caseCount: identity.caseCount,
      stratumCount: identity.stratumCount,
      layoutCounts: identity.layoutCounts,
    },
    providers: providerSummaries,
    rows,
    summary: {
      providerCount: providerSummaries.length,
      rowCount: rows.length,
      scoredProviderCount: providerSummaries.filter(
        (provider) => provider.score !== null,
      ).length,
      strata: [...EXTRACTION_STRATA],
      layouts: [...EXTRACTION_LAYOUTS],
      reportByLayout: true,
    },
  }
  return {
    ...reportWithoutHash,
    reportSha256: canonicalHash(reportWithoutHash),
  }
}

function parseArgs(argv) {
  const options = {
    evalSet: PDF_EXTRACTION_EVAL_SET_PATH,
    providers: PDF_EXTRACTION_EVAL_PROVIDER_PATH,
    out: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === 'run') continue
    if (arg === '--eval-set' || arg === '--providers' || arg === '--out') {
      const value = argv[++index]
      if (!value) invalid('INVALID_PDF_EXTRACTION_CLI_ARGUMENTS')
      if (arg === '--eval-set') options.evalSet = value
      else if (arg === '--providers') options.providers = value
      else options.out = value
      continue
    }
    if (arg.startsWith('--eval-set=')) options.evalSet = arg.slice(11)
    else if (arg.startsWith('--providers=')) options.providers = arg.slice(12)
    else if (arg.startsWith('--out=')) options.out = arg.slice(6)
    else invalid('INVALID_PDF_EXTRACTION_CLI_ARGUMENTS')
  }
  return options
}

export async function loadProviderManifest(value, evalIdentity, evalSet) {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'id',
      'evalSet',
      'evaluationStatus',
      'providers',
    ]) ||
    value.schemaVersion !== PDF_EXTRACTION_EVAL_SCHEMA_VERSION ||
    !SAFE_ID.test(value.id ?? '') ||
    !isRecord(value.evalSet) ||
    !exactKeys(value.evalSet, ['path', 'fileSha256', 'evalSetSha256']) ||
    !pathIsRepositoryRelative(value.evalSet.path) ||
    !SHA256.test(value.evalSet.fileSha256 ?? '') ||
    value.evalSet.evalSetSha256 !== evalIdentity.evalSetSha256 ||
    !['reported-only', 'comparison-ready'].includes(value.evaluationStatus) ||
    !Array.isArray(value.providers) ||
    value.providers.length === 0 ||
    !uniqueBy(value.providers, ({ id }) => id)
  ) {
    invalid('INVALID_PDF_EXTRACTION_PROVIDER_MANIFEST')
  }
  const expectedEvaluationStatus = value.providers.some(
    (provider) => provider.mode === 'file',
  )
    ? 'comparison-ready'
    : 'reported-only'
  if (value.evaluationStatus !== expectedEvaluationStatus) {
    invalid('PDF_EXTRACTION_PROVIDER_STATUS_MISMATCH')
  }
  if (
    expectedEvaluationStatus === 'comparison-ready' &&
    reviewValuesForEvalSet(evalSet).some(
      (review) => review.reviewStatus === 'review-required',
    )
  ) {
    invalid('PDF_EXTRACTION_REVIEW_REQUIRED')
  }
  if (!value.providers.some((provider) => provider.kind === 'deterministic')) {
    invalid('PDF_EXTRACTION_NO_DETERMINISTIC_PROVIDER')
  }
  const providers = []
  for (const item of value.providers) {
    if (
      !exactKeys(item, [
        'id',
        'kind',
        'version',
        'mode',
        'sourceIdentitySha256',
        'predictionsPath',
        'predictionsSha256',
      ]) ||
      !SAFE_ID.test(item.id ?? '') ||
      !EXTRACTION_PROVIDER_KINDS.includes(item.kind) ||
      !SAFE_ID.test(item.version ?? '') ||
      !['abstain', 'file'].includes(item.mode) ||
      (item.sourceIdentitySha256 !== null &&
        !SHA256.test(item.sourceIdentitySha256 ?? '')) ||
      (item.mode === 'abstain' && item.predictionsPath !== null) ||
      (item.mode === 'abstain' && item.predictionsSha256 !== null) ||
      (item.mode === 'file' &&
        (!pathIsRepositoryRelative(item.predictionsPath) ||
          !SHA256.test(item.predictionsSha256 ?? '')))
    ) {
      invalid('INVALID_PDF_EXTRACTION_PROVIDER_MANIFEST')
    }
    if (item.mode === 'abstain') {
      providers.push(createAbstainingPdfExtractionCandidate(evalSet, item))
    } else {
      const artifact = await readRepositoryJson(
        item.predictionsPath,
        'INVALID_PDF_EXTRACTION_PROVIDER_OUTPUT',
      )
      if (sha256(artifact.bytes) !== item.predictionsSha256) {
        invalid('PDF_EXTRACTION_PROVIDER_PREDICTIONS_HASH_MISMATCH')
      }
      const candidate = artifact.value
      validateCandidateProvider(
        candidate,
        evalIdentity,
        'INVALID_PDF_EXTRACTION_CANDIDATE',
      )
      if (candidate.provider.id !== item.id) {
        invalid('PDF_EXTRACTION_PROVIDER_ID_MISMATCH')
      }
      if (
        candidate.provider.kind !== item.kind ||
        candidate.provider.version !== item.version ||
        candidate.provider.sourceIdentitySha256 !== item.sourceIdentitySha256
      ) {
        invalid('PDF_EXTRACTION_PROVIDER_BINDING_MISMATCH')
      }
      providers.push(candidate)
    }
  }
  return providers
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const evalArtifact = await readRepositoryJson(
    options.evalSet,
    'INVALID_PDF_EXTRACTION_EVAL_SET_FILE',
  )
  const evalSet = evalArtifact.value
  const identity = await validatePdfExtractionEvalSetFiles(evalSet)
  const providerArtifact = await readRepositoryJson(
    options.providers,
    'INVALID_PDF_EXTRACTION_PROVIDER_MANIFEST_FILE',
  )
  if (
    providerArtifact.value.evalSet.path !== options.evalSet ||
    sha256(evalArtifact.bytes) !== providerArtifact.value.evalSet.fileSha256
  ) {
    invalid('PDF_EXTRACTION_PROVIDER_EVAL_SET_BINDING_MISMATCH')
  }
  const providers = await loadProviderManifest(
    providerArtifact.value,
    identity,
    evalSet,
  )
  const report = comparePdfExtractionProviders(evalSet, providers)
  if (options.out) {
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exitCode = 1
  })
}

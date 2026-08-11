import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { validateAssociationGroundTruth } from './pdf-association-fixture-audit-lib.mjs'

const groundTruthPath = resolve(
  'tests/fixtures/pdf/note-citation-associations.json',
)
const groundTruth = JSON.parse(readFileSync(groundTruthPath, 'utf8'))

test('the association ground truth binds exact fixture, baseline, associations, and checkpoints', () => {
  const validated = validateAssociationGroundTruth(groundTruth)
  const fixtureBytes = readFileSync(resolve(validated.fixture))

  assert.equal(
    createHash('sha256').update(fixtureBytes).digest('hex'),
    validated.fixtureSha256,
  )
  assert.equal(validated.associations.length, 8)
  assert.equal(validated.checkpoints.length, 5)
  assert.deepEqual(
    validated.checkpoints.map((checkpoint) => checkpoint.id),
    [
      'associations-page-1-marker-to-body',
      'associations-page-2-citation-to-entry',
      'associations-page-2-caption-citation',
      'associations-page-2-table-cell-note',
      'associations-page-2-dangling-link-verifier',
    ],
  )
  assert.throws(
    () =>
      validateAssociationGroundTruth({
        ...validated,
        baselineCounters: undefined,
      }),
    /baseline counters/u,
  )
})

test('the executable audit emits five passing checkpoints and exact before/after counters', () => {
  const audit = spawnSync(
    process.execPath,
    ['tools/pdf-association-fixture-audit.mjs'],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, NO_COLOR: '1' },
    },
  )

  assert.equal(audit.status, 0, audit.stderr || audit.stdout)
  const result = JSON.parse(audit.stdout)
  assert.equal(result.status, 'passed')
  assert.equal(result.fixtureSha256, groundTruth.fixtureSha256)
  assert.equal(result.baselineRef, groundTruth.baselineRef)
  assert.deepEqual(result.before, groundTruth.baselineCounters)
  assert.equal(result.checkpoints.length, 5)
  assert.ok(
    result.checkpoints.every((checkpoint) => checkpoint.status === 'passed'),
  )
  assert.deepEqual(result.after, {
    expectedAssociations: 8,
    matchedAssociations: 7,
    ambiguousAssociations: 1,
    unresolvedAssociations: 0,
    falseLinkCount: 0,
    resolvedAssociationRate: 0.875,
    verifiedAssociationRate: 1,
  })
})

test('agent evidence requires the audit and embeds the exact receipt', () => {
  const evidence = spawnSync(
    'scripts/agent-evidence',
    ['--only', 'association-audit'],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, NO_COLOR: '1' },
    },
  )

  assert.equal(evidence.status, 0, evidence.stderr || evidence.stdout)
  const manifestMatch = evidence.stdout.match(
    /\[agent-evidence\] passed: (.+\/manifest\.json)\s*$/u,
  )
  assert.ok(manifestMatch, evidence.stdout)
  const manifest = JSON.parse(readFileSync(resolve(manifestMatch[1]), 'utf8'))
  assert.deepEqual(manifest.lanes_run, ['association-audit'])
  assert.equal(manifest.lanes[0].required, true)
  assert.equal(manifest.lanes[0].status, 'passed')
  assert.equal(manifest.association_audit.status, 'passed')
  assert.equal(manifest.association_audit.checkpoints.length, 5)
  assert.deepEqual(
    manifest.association_audit.before,
    groundTruth.baselineCounters,
  )
  assert.deepEqual(manifest.association_audit.after, {
    expectedAssociations: 8,
    matchedAssociations: 7,
    ambiguousAssociations: 1,
    unresolvedAssociations: 0,
    falseLinkCount: 0,
    resolvedAssociationRate: 0.875,
    verifiedAssociationRate: 1,
  })
})

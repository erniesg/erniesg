import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { dirname, resolve } from 'node:path'
import {
  auditAssociationReconstruction,
  validateAssociationGroundTruth,
} from './pdf-association-fixture-audit-lib.mjs'

const require = createRequire(import.meta.url)
const { validAssociationAudit } = require('./association-audit-receipt.cjs')

const groundTruthPath = resolve(
  'tests/fixtures/pdf/note-citation-associations.json',
)
const groundTruth = JSON.parse(readFileSync(groundTruthPath, 'utf8'))
const fixtureManifest = JSON.parse(
  readFileSync(resolve('tests/fixtures/pdf/manifest.json'), 'utf8'),
)

test('the association ground truth binds exact fixture, baseline, associations, and checkpoints', () => {
  const validated = validateAssociationGroundTruth(groundTruth)
  const fixtureBytes = readFileSync(resolve(validated.fixture))

  assert.equal(
    createHash('sha256').update(fixtureBytes).digest('hex'),
    validated.fixtureSha256,
  )
  assert.equal(validated.associations.length, 10)
  assert.deepEqual(
    validated.associations.map(({ id }) => id),
    [
      'numeric-footnote',
      'symbol-footnote',
      'arabic-indic-footnote',
      'nested-label-6-footnote',
      'numeric-citation-range',
      'author-year-citation',
      'cross-page-endnote',
      'caption-citation',
      'table-cell-note',
      'ambiguous-duplicate-note',
    ],
  )
  assert.equal(
    fixtureManifest.fixtures.find(
      ({ file }) => file === 'note-citation-associations.pdf',
    )?.sha256,
    validated.fixtureSha256,
  )
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
  assert.throws(
    () =>
      validateAssociationGroundTruth({
        ...validated,
        associations: validated.associations.map((association, index) =>
          index === 0
            ? { ...association, anchorNodeId: undefined }
            : association,
        ),
      }),
    /ground truth entry/u,
  )
})

test('the association audit rejects a same-class owner and a stale anchor span', () => {
  const expected = groundTruth.associations[0]
  const ownerText = 'A numeric claim carries footnote marker 1.'
  const regionId = 'page-001-region-004'
  const reconstruction = {
    regions: [
      {
        id: regionId,
        page: 1,
        text: ownerText,
      },
    ],
    paper: {
      nodes: [
        {
          id: expected.anchorNodeId,
          type: 'paragraph',
          text: ownerText,
        },
        {
          id: 'wrong-paragraph-of-the-same-owner-class',
          type: 'paragraph',
          text: ownerText,
        },
        {
          id: 'numeric-note-target',
          type: 'footnote',
          kind: 'footnote',
          label: '1',
          text: 'Numeric footnote body contains nested marker [6].',
        },
      ],
    },
    provenance: {
      [expected.anchorNodeId]: { regionIds: [regionId] },
      'wrong-paragraph-of-the-same-owner-class': { regionIds: [regionId] },
    },
    noteRelationships: [
      {
        id: 'numeric-note-relationship',
        label: '1',
        referenceRegionId: regionId,
        referenceStart: expected.anchorStart,
        referenceEnd: expected.anchorEnd,
        targetNoteId: 'numeric-note-target',
        status: 'matched',
        canonicalAnchor: {
          kind: 'node',
          nodeId: expected.anchorNodeId,
          start: expected.anchorStart,
          end: expected.anchorEnd,
        },
        candidates: [],
        sourceBoxes: [],
      },
    ],
    citationRelationships: [],
    diagnostics: [],
  }
  const expectedOnly = {
    ...groundTruth,
    associations: [expected],
  }
  const audit = (candidate) =>
    auditAssociationReconstruction(candidate, expectedOnly).associations[0]

  assert.deepEqual(audit(reconstruction), {
    id: expected.id,
    kind: 'note',
    expectedStatus: 'matched',
    observedStatus: 'matched',
    outcome: 'matched',
    reason: 'verified-target-and-owner',
  })

  const wrongOwner = structuredClone(reconstruction)
  wrongOwner.noteRelationships[0].canonicalAnchor.nodeId =
    'wrong-paragraph-of-the-same-owner-class'
  assert.equal(audit(wrongOwner).outcome, 'false-link')
  assert.equal(audit(wrongOwner).reason, 'incorrect-source-owner')

  const wrongSpan = structuredClone(reconstruction)
  wrongSpan.noteRelationships[0].canonicalAnchor.start -= 1
  wrongSpan.noteRelationships[0].canonicalAnchor.end -= 1
  assert.equal(audit(wrongSpan).outcome, 'false-link')
  assert.equal(audit(wrongSpan).reason, 'incorrect-source-owner')
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
    expectedAssociations: 10,
    matchedAssociations: 9,
    ambiguousAssociations: 1,
    unresolvedAssociations: 0,
    falseLinkCount: 0,
    resolvedAssociationRate: 0.9,
    verifiedAssociationRate: 1,
  })
  assert.deepEqual(result.completeness, {
    expectedAssociationCount: 10,
    resolvedAssociationCount: 9,
    associationCoverage: 0.9,
    expectedRelationshipCount: 12,
    resolvedRelationshipCount: 11,
    relationshipCoverage: 0.91667,
    unresolvedObjects: {
      assets: 0,
      captions: 0,
      tables: 0,
      equations: 0,
      citations: 0,
      footnoteReferences: 1,
      footnotes: 3,
    },
  })
  assert.equal(result.readiness.ready, false)
  assert.equal(result.readiness.status, 'review-required')
})

test('the evidence receipt validator rejects nested and conservation tampering', () => {
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
  const receipt = JSON.parse(audit.stdout)
  assert.equal(validAssociationAudit(receipt), true)

  const mutate = (callback) => {
    const candidate = structuredClone(receipt)
    callback(candidate)
    assert.equal(validAssociationAudit(candidate), false)
  }
  mutate((candidate) => {
    candidate.extra = true
  })
  mutate((candidate) => {
    candidate.after.extra = 0
  })
  mutate((candidate) => {
    candidate.checkpoints[1].checkpointId =
      candidate.checkpoints[0].checkpointId
  })
  mutate((candidate) => {
    candidate.checkpoints.pop()
  })
  mutate((candidate) => {
    candidate.associations[1].id = candidate.associations[0].id
  })
  mutate((candidate) => {
    candidate.fixtureSha256 = '0'.repeat(64)
  })
  mutate((candidate) => {
    candidate.after.matchedAssociations = 8
  })
  mutate((candidate) => {
    candidate.status = 'failed'
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
  const manifestPath = resolve(manifestMatch[1])
  const evidenceDirectory = dirname(manifestPath)
  const evidenceRoot = resolve('.agent/evidence')
  const removable = dirname(evidenceDirectory) === evidenceRoot
  try {
    assert.equal(removable, true, 'nested evidence escaped its exact root')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
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
      expectedAssociations: 10,
      matchedAssociations: 9,
      ambiguousAssociations: 1,
      unresolvedAssociations: 0,
      falseLinkCount: 0,
      resolvedAssociationRate: 0.9,
      verifiedAssociationRate: 1,
    })
    assert.equal(
      manifest.association_audit.completeness.associationCoverage,
      0.9,
    )
    assert.equal(manifest.association_audit.readiness.ready, false)
  } finally {
    if (removable) rmSync(evidenceDirectory, { recursive: true, force: true })
  }
})

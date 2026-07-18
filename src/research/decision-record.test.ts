import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  applyHumanDecisionFile,
  createHumanDecisionFile,
  MAX_HUMAN_DECISION_FILE_BYTES,
  parseHumanDecisionFile,
  readingOrderCandidates,
  serializeHumanDecisionFile,
  upsertHumanDecision,
} from './decision-record'
import { buildEpub, inspectEpub } from './epub'
import type {
  PdfPageAnalysis,
  PdfSourceRun,
  ReconstructionDiagnostic,
} from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { reconstructPdf } from './pdf'
import { fixtureFile } from '../../tests/fixtures/pdf-fixtures'

function run(
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
): PdfSourceRun {
  return {
    page: 1,
    text,
    x,
    y,
    width,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
    fontName: 'Body',
    fontSize,
    confidence: 1,
  }
}

function ambiguousReconstruction() {
  const runs = [
    run('Left candidate one.', 0.08, 0.2, 0.32),
    run('Right candidate one.', 0.55, 0.2, 0.32),
    run('Indented left candidate.', 0.18, 0.7, 0.22),
    run('Right candidate two.', 0.55, 0.7, 0.32),
  ]
  const page: PdfPageAnalysis = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: 0,
    runs,
  }
  return reconstructPageAnalyses({
    pages: [page],
    sourceHash: 'a'.repeat(64),
    fileName: 'ambiguous.pdf',
    byteLength: 2048,
  })
}

function targeted(
  diagnostic: ReconstructionDiagnostic,
): asserts diagnostic is ReconstructionDiagnostic & {
  target: NonNullable<ReconstructionDiagnostic['target']>
} {
  expect(diagnostic.target).toBeDefined()
}

describe('human adjudication decision records', () => {
  it.each([
    ['reclassify-citation', 'citation'],
    ['reclassify-plain-text', 'plain-text'],
  ] as const)(
    'supports exact marker %s decisions',
    async (resolution, status) => {
      const claim = run(
        'A bibliography marker is deliberately written as note reference 3.',
        0.1,
        0.2,
        0.72,
      )
      const page: PdfPageAnalysis = {
        page: 1,
        kind: 'born-digital',
        width: 612,
        height: 792,
        rotation: 0,
        textCharacters: claim.text.length,
        imageCount: 0,
        runs: [claim],
      }
      const base = await reconstructPageAnalyses({
        pages: [page],
        sourceHash: 'c'.repeat(64),
        fileName: 'citation.pdf',
        byteLength: 1024,
      })
      const diagnostic = base.diagnostics.find(
        (item) => item.code === 'UNRESOLVED_NOTE_REFERENCE',
      )!
      targeted(diagnostic)
      const file = upsertHumanDecision(
        createHumanDecisionFile(base.source.sha256),
        {
          diagnosticCode: diagnostic.code,
          target: diagnostic.target,
          resolution: { type: resolution },
        },
      )

      const result = applyHumanDecisionFile(base, file)
      expect(result.noteRelationships[0].status).toBe(status)
      expect(result.readiness.ready).toBe(true)
      expect(result.humanAdjudications.applied).toHaveLength(1)
    },
  )

  it('adjudicates note matches and reading order and replays headlessly', async () => {
    const source = await fixtureFile('adjudication-required.pdf')
    const base = await reconstructPdf(source)
    expect(
      base.diagnostics.filter((item) => item.code === 'AMBIGUOUS_NOTE_MATCH'),
    ).toHaveLength(2)
    expect(base.diagnostics.map((item) => item.code)).toContain(
      'AMBIGUOUS_READING_ORDER',
    )
    const readingDiagnostic = base.diagnostics.find(
      (item) => item.code === 'AMBIGUOUS_READING_ORDER',
    )!
    targeted(readingDiagnostic)

    let file = createHumanDecisionFile(base.source.sha256)
    for (const [index, relationship] of base.noteRelationships.entries()) {
      const diagnostic = base.diagnostics.find(
        (item) => item.target?.markerId === relationship.id,
      )!
      targeted(diagnostic)
      const candidate = relationship.candidates[index]
      file = upsertHumanDecision(file, {
        diagnosticCode: diagnostic.code,
        target: diagnostic.target,
        resolution: {
          type: 'accept-note-match',
          targetNoteId: candidate.targetNoteId,
          targetRegionId: candidate.targetRegionId,
        },
      })
    }
    file = upsertHumanDecision(file, {
      diagnosticCode: readingDiagnostic.code,
      target: readingDiagnostic.target,
      resolution: {
        type: 'accept-reading-order',
        regionIds: readingOrderCandidates(base, readingDiagnostic)[0],
      },
    })

    const result = applyHumanDecisionFile(base, file)
    expect(result.readiness.ready).toBe(true)
    expect(result.noteRelationships.map((item) => item.status)).toEqual([
      'matched',
      'matched',
    ])
    expect(result.humanAdjudications.countsByDiagnosticCode).toEqual({
      AMBIGUOUS_NOTE_MATCH: 2,
      AMBIGUOUS_READING_ORDER: 1,
    })

    const directEpub = await buildEpub(result.paper, result)
    const replayed = await reconstructPdf(
      await fixtureFile('adjudication-required.pdf'),
      undefined,
      { decisionFile: file },
    )
    const replayedEpub = await buildEpub(replayed.paper, replayed)
    expect(replayedEpub.bytes).toEqual(directEpub.bytes)
  })

  it('preserves visual completeness when a sidecar is applied', async () => {
    const base = await reconstructPdf(
      await fixtureFile('structured-scientific.pdf'),
    )
    const result = applyHumanDecisionFile(
      base,
      createHumanDecisionFile(base.source.sha256),
    )

    expect(result.completeness).toEqual(base.completeness)
    expect(result.readiness).toEqual(base.readiness)
    expect(result.visualRelationships).toEqual(base.visualRelationships)
    expect(result.assets).toEqual(base.assets)
  })

  it('replays an exact reading-order choice before the completeness gate', async () => {
    const base = await ambiguousReconstruction()
    const diagnostic = base.diagnostics.find(
      (item) => item.code === 'AMBIGUOUS_READING_ORDER',
    )!
    targeted(diagnostic)
    const candidates = readingOrderCandidates(base, diagnostic)
    expect(candidates).toHaveLength(2)

    const file = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      {
        diagnosticCode: diagnostic.code,
        target: diagnostic.target,
        resolution: {
          type: 'accept-reading-order',
          regionIds: candidates[0],
        },
      },
    )
    const result = applyHumanDecisionFile(base, file)

    expect(result.readiness.ready).toBe(true)
    expect(result.readiness.policy).toEqual(base.readiness.policy)
    expect(result.humanAdjudications).toMatchObject({
      applied: [expect.objectContaining({ diagnosticCode: diagnostic.code })],
      stale: [],
      countsByDiagnosticCode: { AMBIGUOUS_READING_ORDER: 1 },
    })
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AMBIGUOUS_READING_ORDER' }),
      ]),
    )

    const epub = await buildEpub(result.paper, result)
    const manifest = JSON.parse(
      strFromU8(inspectEpub(epub.bytes).files['EPUB/export.json']),
    )
    expect(manifest.humanAdjudications).toEqual({
      schemaVersion: '1.0.0',
      appliedCount: 1,
      staleCount: 0,
      countsByDiagnosticCode: { AMBIGUOUS_READING_ORDER: 1 },
      applied: [expect.objectContaining({ diagnosticCode: diagnostic.code })],
    })
  })

  it('contains identifiers and choices but no reconstructed document text', async () => {
    const base = await ambiguousReconstruction()
    const diagnostic = base.diagnostics.find(
      (item) => item.code === 'AMBIGUOUS_READING_ORDER',
    )!
    targeted(diagnostic)
    const file = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      {
        diagnosticCode: diagnostic.code,
        target: diagnostic.target,
        resolution: {
          type: 'accept-reading-order',
          regionIds: readingOrderCandidates(base, diagnostic)[0],
        },
      },
    )
    const json = serializeHumanDecisionFile(file)

    expect(json).not.toContain('Left candidate one')
    expect(json).not.toContain('Right candidate one')
    expect(json).not.toContain('sourceBoxes')
  })

  it('reports identifier drift and document mismatches as stale', async () => {
    const base = await ambiguousReconstruction()
    const diagnostic = base.diagnostics.find(
      (item) => item.code === 'AMBIGUOUS_READING_ORDER',
    )!
    targeted(diagnostic)
    const candidates = readingOrderCandidates(base, diagnostic)
    const drifted = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      {
        diagnosticCode: diagnostic.code,
        target: {
          ...diagnostic.target,
          regionIds: [...diagnostic.target.regionIds, 'missing-region'],
        },
        resolution: {
          type: 'accept-reading-order',
          regionIds: candidates[0],
        },
      },
    )
    const stale = applyHumanDecisionFile(base, drifted)
    expect(stale.humanAdjudications.stale[0].reason).toBe(
      'diagnostic-target-missing',
    )
    expect(stale.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'STALE_HUMAN_DECISION' }),
      ]),
    )

    const mismatched = applyHumanDecisionFile(base, {
      ...drifted,
      documentSha256: 'b'.repeat(64),
    })
    expect(mismatched.humanAdjudications.stale[0].reason).toBe(
      'document-sha256-mismatch',
    )
  })

  it('rejects oversized sidecars before parsing JSON', () => {
    expect(() =>
      parseHumanDecisionFile(' '.repeat(MAX_HUMAN_DECISION_FILE_BYTES + 1)),
    ).toThrow(/exceeds/i)
  })
})

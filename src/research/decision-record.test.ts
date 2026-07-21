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
import { buildEpub } from './epub'
import type {
  HumanAdjudicationRecord,
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

async function unresolvedLineJoinReconstruction() {
  const runs = [
    run('This source contains a scenar-', 0.1, 0.2, 0.42),
    run('io that remains continuous prose.', 0.1, 0.225, 0.48),
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
    sourceHash: '1'.repeat(64),
    fileName: 'unresolved-line-join.pdf',
    byteLength: 2048,
  })
}

function lineJoinDecision(
  base: Awaited<ReturnType<typeof unresolvedLineJoinReconstruction>>,
  outcome:
    | 'remove-wrap-hyphen'
    | 'preserve-authored-hyphen'
    | 'leave-unresolved',
) {
  const transition = base.lineBoundaryDecisions.find(
    (candidate) => candidate.outcome === 'unresolved',
  )!
  return {
    diagnosticCode: 'UNRESOLVED_CORRUPTING_JOIN',
    target: {
      regionIds: [transition.regionId],
      markerId: transition.id,
    },
    resolution: {
      type: 'resolve-line-join',
      transition: {
        id: transition.id,
        regionId: transition.regionId,
        fromLineId: transition.fromLineId,
        toLineId: transition.toLineId,
      },
      outcome,
      confidence: 1,
      evidence: ['bounded-source-context', 'owner-local-adjudication'],
    },
  } as unknown as HumanAdjudicationRecord
}

function targeted(
  diagnostic: ReconstructionDiagnostic,
): asserts diagnostic is ReconstructionDiagnostic & {
  target: NonNullable<ReconstructionDiagnostic['target']>
} {
  expect(diagnostic.target).toBeDefined()
}

describe('human adjudication decision records', () => {
  it('emits v1.1 line-join decisions without serializing source text', async () => {
    const base = await unresolvedLineJoinReconstruction()
    const file = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      lineJoinDecision(base, 'remove-wrap-hyphen'),
    )
    const json = serializeHumanDecisionFile(file)
    const parsed = JSON.parse(json)

    expect(parsed).toMatchObject({
      schemaVersion: '1.1.0',
      documentSha256: base.source.sha256,
      decisions: [
        {
          diagnosticCode: 'UNRESOLVED_CORRUPTING_JOIN',
          resolution: {
            type: 'resolve-line-join',
            outcome: 'remove-wrap-hyphen',
            confidence: 1,
            evidence: ['bounded-source-context', 'owner-local-adjudication'],
          },
        },
      ],
    })
    expect(json).not.toContain('This source contains')
    expect(json).not.toContain('continuous prose')
  })

  it('continues to parse and replay v1.0 decision files', async () => {
    const base = await ambiguousReconstruction()
    const diagnostic = base.diagnostics.find(
      (item) => item.code === 'AMBIGUOUS_READING_ORDER',
    )!
    targeted(diagnostic)
    const legacy = {
      schemaVersion: '1.0.0',
      documentSha256: base.source.sha256,
      decisions: [
        {
          diagnosticCode: diagnostic.code,
          target: diagnostic.target,
          resolution: {
            type: 'accept-reading-order',
            regionIds: readingOrderCandidates(base, diagnostic)[0],
          },
        },
      ],
    }

    const parsed = parseHumanDecisionFile(JSON.stringify(legacy))
    expect(parsed.schemaVersion).toBe('1.0.0')
    expect(
      applyHumanDecisionFile(base, parsed).humanAdjudications,
    ).toMatchObject({
      schemaVersion: '1.0.0',
      countsByDiagnosticCode: { AMBIGUOUS_READING_ORDER: 1 },
    })
  })

  it.each([
    {
      choice: 'remove-wrap-hyphen' as const,
      expectedText:
        'This source contains a scenario that remains continuous prose.',
      expectedOutcome: 'removed-discretionary-hyphen',
    },
    {
      choice: 'preserve-authored-hyphen' as const,
      expectedText:
        'This source contains a scenar-io that remains continuous prose.',
      expectedOutcome: 'preserved-lexical-hyphen',
    },
  ])(
    'replays $choice deterministically before reassessing readiness',
    async ({ choice, expectedText, expectedOutcome }) => {
      const base = await unresolvedLineJoinReconstruction()
      const file = upsertHumanDecision(
        createHumanDecisionFile(base.source.sha256),
        lineJoinDecision(base, choice),
      )

      const first = applyHumanDecisionFile(base, file)
      const second = applyHumanDecisionFile(base, file)

      expect(first).toEqual(second)
      expect(first.regions[0].text).toBe(expectedText)
      expect(first.paper.nodes[0]).toMatchObject({ text: expectedText })
      expect(first.lineBoundaryDecisions[0]).toMatchObject({
        outcome: expectedOutcome,
        evidence: expect.arrayContaining([
          'bounded-source-context',
          'owner-local-adjudication',
        ]),
      })
      expect(first.unresolvedCorruptingJoinCount).toBe(0)
      expect(first.completeness.unresolvedCorruptingJoinCount).toBe(0)
      expect(first.readiness.blockingDiagnosticCodes).not.toContain(
        'UNRESOLVED_CORRUPTING_JOIN',
      )
    },
  )

  it('records leave-unresolved without silently clearing its gate', async () => {
    const base = await unresolvedLineJoinReconstruction()
    const file = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      lineJoinDecision(base, 'leave-unresolved'),
    )
    const result = applyHumanDecisionFile(base, file)

    expect(result.regions[0].text).toBe(base.regions[0].text)
    expect(result.lineBoundaryDecisions[0]).toMatchObject({
      outcome: 'unresolved',
      evidence: expect.arrayContaining(['owner-local-adjudication']),
    })
    expect(result.unresolvedCorruptingJoinCount).toBe(1)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_CORRUPTING_JOIN',
    )
    expect(result.humanAdjudications.applied).toHaveLength(1)
  })

  it('removes the transition-selected occurrence when a boundary word repeats', async () => {
    const runs = [
      run('First dupli-', 0.1, 0.2, 0.2),
      run('cate token and second dupli-', 0.1, 0.225, 0.42),
      run('cate token.', 0.1, 0.25, 0.2),
    ]
    const base = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: runs.reduce(
            (total, item) => total + item.text.length,
            0,
          ),
          imageCount: 0,
          runs,
        },
      ],
      sourceHash: '2'.repeat(64),
      fileName: 'duplicate-boundary-word.pdf',
      byteLength: 2048,
    })
    const transitions = base.lineBoundaryDecisions.filter(
      (candidate) => candidate.outcome === 'unresolved',
    )
    expect(transitions).toHaveLength(2)
    const transition = transitions[1]
    const file = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      {
        diagnosticCode: 'UNRESOLVED_CORRUPTING_JOIN',
        target: {
          regionIds: [transition.regionId],
          markerId: transition.id,
        },
        resolution: {
          type: 'resolve-line-join',
          transition: {
            id: transition.id,
            regionId: transition.regionId,
            fromLineId: transition.fromLineId,
            toLineId: transition.toLineId,
          },
          outcome: 'remove-wrap-hyphen',
          confidence: 1,
          evidence: ['bounded-source-context', 'owner-local-adjudication'],
        },
      },
    )

    const result = applyHumanDecisionFile(base, file)

    expect(result.regions[0].text).toBe(
      'First dupli-cate token and second duplicate token.',
    )
    expect(result.humanAdjudications).toMatchObject({
      applied: [
        expect.objectContaining({
          target: expect.objectContaining({ markerId: transition.id }),
        }),
      ],
      stale: [],
    })
    expect(result.unresolvedCorruptingJoinCount).toBe(1)
  })

  it('fails closed when a saved line-transition identity drifts', async () => {
    const base = await unresolvedLineJoinReconstruction()
    const decision = lineJoinDecision(base, 'remove-wrap-hyphen')
    if (decision.resolution.type !== 'resolve-line-join') {
      throw new Error('Expected a line-join decision')
    }
    decision.resolution.transition.toLineId = 'page-001-line-missing'
    const file = upsertHumanDecision(
      createHumanDecisionFile(base.source.sha256),
      decision,
    )
    const result = applyHumanDecisionFile(base, file)

    expect(result.regions[0].text).toBe(base.regions[0].text)
    expect(result.unresolvedCorruptingJoinCount).toBe(1)
    expect(result.humanAdjudications.stale).toEqual([
      expect.objectContaining({ reason: 'resolution-no-longer-legal' }),
    ])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'STALE_HUMAN_DECISION' }),
      ]),
    )
  })

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
      expect(result.readiness.ready).toBe(false)
      expect(result.readiness.blockingDiagnosticCodes).toContain(
        'UNPROVENANCED_RENDERED_UNIT',
      )
      if (resolution === 'reclassify-citation') {
        expect(result.citationRelationships).toEqual([
          expect.objectContaining({
            id: result.noteRelationships[0].id,
            status: 'unresolved',
          }),
        ])
        expect(
          result.paper.nodes.flatMap((node) =>
            'inlineRuns' in node ? (node.inlineRuns ?? []) : [],
          ),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ semanticRole: 'citation' }),
          ]),
        )
      }
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
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNPROVENANCED_RENDERED_UNIT',
      ]),
    })
    expect(result.noteRelationships.map((item) => item.status)).toEqual([
      'matched',
      'matched',
    ])
    expect(result.humanAdjudications.countsByDiagnosticCode).toEqual({
      AMBIGUOUS_NOTE_MATCH: 2,
      AMBIGUOUS_READING_ORDER: 1,
    })

    await expect(buildEpub(result.paper, result)).rejects.toThrow(
      /UNPROVENANCED_RENDERED_UNIT/u,
    )
    const replayed = await reconstructPdf(
      await fixtureFile('adjudication-required.pdf'),
      undefined,
      { decisionFile: file },
    )
    expect(replayed.paper).toEqual(result.paper)
    expect(replayed.readiness).toEqual(result.readiness)
    await expect(buildEpub(replayed.paper, replayed)).rejects.toThrow(
      /UNPROVENANCED_RENDERED_UNIT/u,
    )
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

    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNPROVENANCED_RENDERED_UNIT',
      ]),
    })
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

    await expect(buildEpub(result.paper, result)).rejects.toThrow(
      /UNPROVENANCED_RENDERED_UNIT/u,
    )
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

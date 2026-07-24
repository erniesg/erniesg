import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  composePrivateDecisionSet,
  parsePrivateDecisionComposeArguments,
  PDF_PRIVATE_DECISION_COMPOSE_SCHEMA_VERSION,
} from './pdf-private-decision-compose.mjs'

const sourceSha256 = 'a'.repeat(64)
const decisionsSha256 = 'b'.repeat(64)
const transcriptSha256 = 'c'.repeat(64)

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

describe('private decision composer', () => {
  it('accepts private paths only through distinct environment variables', () => {
    const parsed = parsePrivateDecisionComposeArguments(
      [
        '--input-env',
        'SRT_PRIVATE_PDF',
        '--decisions-env',
        'SRT_PRIVATE_DECISIONS',
        '--transcript-env',
        'SRT_PRIVATE_TRANSCRIPT',
        '--output-env',
        'SRT_PRIVATE_OUTPUT',
        '--paper-id',
        'paper-v1',
        '--relationship-id',
        'visual-equation-1',
        '--expected-size',
        '123',
        '--expected-sha256',
        sourceSha256,
        '--expected-decisions-sha256',
        decisionsSha256,
        '--expected-transcript-sha256',
        transcriptSha256,
      ],
      {
        SRT_PRIVATE_PDF: '/private/source.pdf',
        SRT_PRIVATE_DECISIONS: '/private/base.decisions.json',
        SRT_PRIVATE_TRANSCRIPT: '/private/equation.txt',
        SRT_PRIVATE_OUTPUT: '/private/combined.decisions.json',
      },
    )

    expect(parsed).toMatchObject({
      paperId: 'paper-v1',
      relationshipId: 'visual-equation-1',
      expectedSize: 123,
      expectedSha256: sourceSha256,
      expectedDecisionsSha256: decisionsSha256,
      expectedTranscriptSha256: transcriptSha256,
    })
    expect(() =>
      parsePrivateDecisionComposeArguments(
        [
          '--input-env',
          'SRT_PRIVATE_PDF',
          '--decisions-env',
          'SRT_PRIVATE_PDF',
          '--transcript-env',
          'SRT_PRIVATE_TRANSCRIPT',
          '--output-env',
          'SRT_PRIVATE_OUTPUT',
          '--paper-id',
          'paper-v1',
          '--relationship-id',
          'visual-equation-1',
          '--expected-size',
          '123',
          '--expected-sha256',
          sourceSha256,
          '--expected-decisions-sha256',
          decisionsSha256,
          '--expected-transcript-sha256',
          transcriptSha256,
        ],
        {
          SRT_PRIVATE_PDF: '/private/source.pdf',
          SRT_PRIVATE_TRANSCRIPT: '/private/equation.txt',
          SRT_PRIVATE_OUTPUT: '/private/combined.decisions.json',
        },
      ),
    ).toThrow('INVALID_USAGE')
  })

  it('creates one digest over the complete set without exposing transcript text', () => {
    const privateTranscript = String.raw`PRIVATE \operatorname{fixture}(x)`
    const baseDecisionFile = {
      schemaVersion: '1.1.0',
      documentSha256: sourceSha256,
      decisions: [
        {
          diagnosticCode: 'UNRESOLVED_CORRUPTING_JOIN',
          target: { regionIds: ['region-1'], markerId: 'transition-1' },
          resolution: { type: 'resolve-line-join' },
        },
        {
          diagnosticCode: 'UNRESOLVED_CORRUPTING_JOIN',
          target: { regionIds: ['region-2'], markerId: 'transition-2' },
          resolution: { type: 'resolve-line-join' },
        },
      ],
    }
    const modules = {
      createEquationTranscriptDecision(
        _reconstruction,
        relationshipId,
        transcript,
      ) {
        return {
          diagnosticCode: 'UNRESOLVED_EQUATION_TRANSCRIPT',
          target: {
            regionIds: ['equation-region-1'],
            markerId: relationshipId,
          },
          resolution: {
            type: 'accept-equation-transcript',
            relationshipId,
            transcript,
          },
        }
      },
      upsertHumanDecision(file, decision) {
        return {
          ...file,
          schemaVersion: '1.2.0',
          decisions: [...file.decisions, decision],
        }
      },
      applyHumanDecisionFile(_reconstruction, file) {
        return {
          humanAdjudications: {
            applied: [...file.decisions],
            stale: [],
          },
        }
      },
      serializeHumanDecisionFile(file) {
        return `${JSON.stringify(file, null, 2)}\n`
      },
      humanDecisionFileSha256(file) {
        return sha256(`${JSON.stringify(file, null, 2)}\n`)
      },
    }

    const result = composePrivateDecisionSet({
      reconstruction: {},
      decisionFile: baseDecisionFile,
      relationshipId: 'visual-equation-1',
      transcript: privateTranscript,
      modules,
    })

    expect(
      JSON.parse(result.serialized).decisions.at(-1).resolution.transcript,
    ).toBe(privateTranscript)
    expect(result.receipt).toEqual({
      schemaVersion: PDF_PRIVATE_DECISION_COMPOSE_SCHEMA_VERSION,
      privacy:
        'environment-paths-owner-only-transcript-redacted-one-decision-set-digest',
      passed: true,
      documentSha256: sourceSha256,
      inputDecisionCount: 2,
      outputDecisionCount: 3,
      resolutionCounts: {
        'accept-equation-transcript': 1,
        'resolve-line-join': 2,
      },
      decisionSetSha256: sha256(result.serialized),
    })
    expect(JSON.stringify(result.receipt)).not.toContain(privateTranscript)
    expect(result.receipt.decisionSetSha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('fails closed when the base set already contains a decision for the requested equation', () => {
    expect(() =>
      composePrivateDecisionSet({
        reconstruction: {},
        relationshipId: 'visual-equation-1',
        transcript: 'private',
        decisionFile: {
          schemaVersion: '1.2.0',
          documentSha256: sourceSha256,
          decisions: [
            {
              diagnosticCode: 'UNRESOLVED_EQUATION_TRANSCRIPT',
              target: {
                regionIds: ['equation-region-1'],
                markerId: 'visual-equation-1',
              },
              resolution: {
                type: 'accept-equation-transcript',
                relationshipId: 'visual-equation-1',
              },
            },
          ],
        },
        modules: {},
      }),
    ).toThrow('EQUATION_DECISION_ALREADY_PRESENT')
  })

  it('adds a decision when the base set contains a different equation', () => {
    const baseDecisionFile = {
      schemaVersion: '1.2.0',
      documentSha256: sourceSha256,
      decisions: [
        {
          diagnosticCode: 'UNRESOLVED_EQUATION_TRANSCRIPT',
          target: {
            regionIds: ['equation-region-1'],
            markerId: 'visual-equation-1',
          },
          resolution: {
            type: 'accept-equation-transcript',
            relationshipId: 'visual-equation-1',
            transcript: 'first',
          },
        },
      ],
    }
    const modules = {
      createEquationTranscriptDecision(
        _reconstruction,
        relationshipId,
        transcript,
      ) {
        return {
          diagnosticCode: 'UNRESOLVED_EQUATION_TRANSCRIPT',
          target: {
            regionIds: ['equation-region-2'],
            markerId: relationshipId,
          },
          resolution: {
            type: 'accept-equation-transcript',
            relationshipId,
            transcript,
          },
        }
      },
      upsertHumanDecision(file, decision) {
        return {
          ...file,
          decisions: [...file.decisions, decision],
        }
      },
      applyHumanDecisionFile(_reconstruction, file) {
        return {
          humanAdjudications: {
            applied: [...file.decisions],
            stale: [],
          },
        }
      },
      serializeHumanDecisionFile(file) {
        return `${JSON.stringify(file, null, 2)}\n`
      },
      humanDecisionFileSha256(file) {
        return sha256(`${JSON.stringify(file, null, 2)}\n`)
      },
    }

    const result = composePrivateDecisionSet({
      reconstruction: {},
      decisionFile: baseDecisionFile,
      relationshipId: 'visual-equation-2',
      transcript: 'second',
      modules,
    })

    expect(result.decisionFile.decisions).toHaveLength(2)
    expect(
      result.decisionFile.decisions.map(
        (decision) => decision.resolution.relationshipId,
      ),
    ).toEqual(['visual-equation-1', 'visual-equation-2'])
    expect(result.receipt).toMatchObject({
      inputDecisionCount: 1,
      outputDecisionCount: 2,
      resolutionCounts: { 'accept-equation-transcript': 2 },
    })
  })
})

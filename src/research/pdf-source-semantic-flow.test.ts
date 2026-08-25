import { describe, expect, it } from 'vitest'
import type { PdfPageRegion, PdfSourceRun } from './import-types'
import {
  canonicalPdfSourceSemanticFlowEvidence,
  pdfBodySourceOrderExtremaByPage,
  pdfSourceColumnFlowJoinOutcome,
  pdfSourceSemanticFlowBoundaryDecisionId,
  pdfSourceSemanticFlowRunSha256,
} from './pdf-source-semantic-flow'

function run(
  page: number,
  text: string,
  sourceSequenceIndex: number,
): PdfSourceRun {
  return {
    page,
    text,
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.02,
    rotation: 0,
    method: 'pdf-text',
    fontName: 'Body',
    fontSize: 10,
    confidence: 1,
    sourceSequenceIndex,
  }
}

describe('PDF source semantic flow adapter', () => {
  it('derives stable source-order extrema while excluding accounted regions', () => {
    const region = (id: string, page: number, runs: PdfSourceRun[]) =>
      ({
        id,
        page,
        furniture: undefined,
        lines: [
          {
            id: `${id}-line`,
            text: runs.map((item) => item.text).join(''),
            fontSize: 10,
            box: runs[0],
            runs,
          },
        ],
      }) as Pick<PdfPageRegion, 'id' | 'page' | 'lines' | 'furniture'>

    expect(
      pdfBodySourceOrderExtremaByPage(
        [
          region('body', 1, [run(1, 'first', 8), run(1, 'last', 2)]),
          region('visual', 1, [run(1, 'ignore', 1)]),
          region('second-page', 2, [run(2, 'only', 4)]),
        ],
        new Set(['visual']),
      ),
    ).toEqual(
      new Map([
        [1, { first: 2, last: 8 }],
        [2, { first: 4, last: 4 }],
      ]),
    )
  })

  it('keeps semantic-flow evidence and decision IDs canonical', () => {
    const source = run(1, 'continuation', 11)
    const decision = {
      page: 1,
      rotation: 0,
      method: 'pdf-text' as const,
      topology: 'same-page-column' as const,
      outcome: 'space' as const,
      from: {
        regionId: 'region-1',
        lineId: 'line-1',
        runIndex: 0,
        sourceSequenceIndex: 10,
        sourceRunSha256: pdfSourceSemanticFlowRunSha256(run(1, 'before', 10)),
        sourceFragmentId: 'line-1:whole',
      },
      to: {
        regionId: 'region-2',
        lineId: 'line-2',
        runIndex: 0,
        sourceSequenceIndex: 11,
        sourceRunSha256: pdfSourceSemanticFlowRunSha256(source),
        sourceFragmentId: 'line-2:whole',
      },
      evidence: ['b', 'a', 'b'],
    }

    expect(canonicalPdfSourceSemanticFlowEvidence(decision.evidence)).toEqual([
      'a',
      'b',
    ])
    expect(pdfSourceSemanticFlowBoundaryDecisionId(decision)).toBe(
      pdfSourceSemanticFlowBoundaryDecisionId({
        ...decision,
        evidence: ['a', 'b'],
      }),
    )
  })

  it('uses source whitespace before language heuristics when joining columns', () => {
    expect(
      pdfSourceColumnFlowJoinOutcome('zh', '模型', {
        ...run(1, '模型', 4),
        sourceWhitespaceBefore: 'pdf-text-item',
        sourceWhitespacePredecessorIndex: 3,
      }),
    ).toEqual({ outcome: 'space', separator: ' ' })
  })
})

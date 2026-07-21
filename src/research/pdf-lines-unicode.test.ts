import { describe, expect, it } from 'vitest'
import type { PdfLineBoundaryDecision } from './import-types'
import { joinPdfLineTexts, type PdfTextLine } from './pdf-lines'

function line(id: string, text: string): PdfTextLine {
  return {
    id,
    page: 1,
    text,
    x: 0.1,
    y: id === 'line-1' ? 0.2 : 0.22,
    width: 0.7,
    height: 0.018,
    fontSize: 10,
    runs: [],
    column: 'single',
  }
}

describe('Unicode delimiter line joins', () => {
  for (const [opening, closing] of [
    ['“', '”'],
    ['‘', '’'],
    ['«', '»'],
  ] as const) {
    it(`joins ${opening}${closing} boundaries without inserting spaces and records evidence`, () => {
      const openingDecisions: PdfLineBoundaryDecision[] = []
      const closingDecisions: PdfLineBoundaryDecision[] = []

      expect(
        joinPdfLineTexts(
          [line('line-1', `He said ${opening}`), line('line-2', 'quoted')],
          {
            regionId: 'region-opening',
            decisions: openingDecisions,
          },
        ),
      ).toBe(`He said ${opening}quoted`)
      expect(
        joinPdfLineTexts(
          [line('line-1', 'quoted'), line('line-2', `${closing} next`)],
          {
            regionId: 'region-closing',
            decisions: closingDecisions,
          },
        ),
      ).toBe(`quoted${closing} next`)
      expect(openingDecisions[0]).toMatchObject({
        outcome: 'no-space',
        evidence: ['opening-delimiter-continuation'],
      })
      expect(closingDecisions[0]).toMatchObject({
        outcome: 'no-space',
        evidence: ['closing-delimiter-continuation'],
      })
    })
  }
})

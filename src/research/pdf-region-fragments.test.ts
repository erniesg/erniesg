import { describe, expect, it } from 'vitest'
import type { PdfPageRegion } from './import-types'
import { residualPdfRegionFragmentsAfterLineConsumption } from './pdf-region-fragments'

describe('PDF residual region fragments', () => {
  it('splits retained lines without creating a source boundary', () => {
    const lines = ['Alpha', 'Table row', 'Omega'].map((text, index) => ({
      id: `line-${index + 1}`,
      text,
      fontSize: 10,
      box: {
        page: 1,
        x: 0.1,
        y: 0.2 + index * 0.02,
        width: 0.7,
        height: 0.018,
        rotation: 0,
        method: 'pdf-text' as const,
      },
      runs: [],
    }))
    const region = {
      id: 'interleaved-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: 'Alpha Table row Omega',
      confidence: 1,
      box: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.7,
        height: 0.058,
        rotation: 0,
        method: 'pdf-text' as const,
      },
      lines,
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion

    const fragments = residualPdfRegionFragmentsAfterLineConsumption(
      region,
      new Set(['line-2']),
      lines.slice(1).map((line, index) => ({
        id: `boundary-${index + 1}`,
        page: 1,
        regionId: region.id,
        fromLineId: lines[index].id,
        toLineId: line.id,
        outcome: 'space' as const,
        evidence: ['ordinary-wrap'],
      })),
    )

    expect(
      fragments.map(({ region: fragment, sourceStart, sourceEnd }) => ({
        text: fragment.text,
        sourceStart,
        sourceEnd,
      })),
    ).toEqual([
      { text: 'Alpha', sourceStart: 0, sourceEnd: 5 },
      { text: 'Omega', sourceStart: 16, sourceEnd: 21 },
    ])
  })

  it('retains the five-decimal source-box contract for a consumed region', () => {
    const lines = ['Alpha', 'Table'].map((text, index) => ({
      id: `precision-line-${index + 1}`,
      text,
      fontSize: 10,
      box: {
        page: 1,
        x: index === 0 ? 0.1234567 : 0.1,
        y: index === 0 ? 0.2345678 : 0.26,
        width: index === 0 ? 0.3456789 : 0.2,
        height: index === 0 ? 0.0123456 : 0.012,
        rotation: 0,
        method: 'pdf-text' as const,
      },
      runs: [],
    }))
    const region = {
      id: 'precision-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: 'Alpha Table',
      confidence: 1,
      box: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.7,
        height: 0.08,
        rotation: 0,
        method: 'pdf-text' as const,
      },
      lines,
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies PdfPageRegion

    const [fragment] = residualPdfRegionFragmentsAfterLineConsumption(
      region,
      new Set(['precision-line-2']),
      [
        {
          id: 'precision-boundary',
          page: 1,
          regionId: region.id,
          fromLineId: 'precision-line-1',
          toLineId: 'precision-line-2',
          outcome: 'space',
          evidence: ['ordinary-wrap'],
        },
      ],
    )

    expect(fragment.region.box).toMatchObject({
      x: 0.12346,
      y: 0.23457,
      width: 0.34568,
      height: 0.01235,
    })
  })
})

import { describe, expect, it } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageRegion,
  PdfRegionLine,
  PdfSourceRun,
} from './import-types'
import { resolvePdfTableScope } from './pdf-table-scope'

function box(
  x: number,
  y: number,
  width: number,
  height: number,
  method: NormalizedSourceBox['method'] = 'pdf-text',
): NormalizedSourceBox {
  return { page: 1, x, y, width, height, rotation: 0, method }
}

function textRegion(
  id: string,
  sourceBox: NormalizedSourceBox,
  lines: PdfRegionLine[],
  kind: PdfPageRegion['kind'] = 'body',
): PdfPageRegion {
  return {
    id,
    page: sourceBox.page,
    kind,
    column: 'single',
    text: lines.map((item) => item.text).join(' '),
    confidence: 0.98,
    box: sourceBox,
    lines,
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

function caption(
  id = 'caption-table-1',
  y = 0.38,
  text = 'Table 1. Exact benchmark results.',
): PdfPageRegion {
  return {
    id,
    page: 1,
    kind: 'caption',
    column: 'single',
    text,
    confidence: 0.99,
    box: box(0.12, y, 0.68, 0.02),
    lines: [],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}
describe('PDF table span-caption family', () => {
  describe('geometry-local ownership for span-classified captions', () => {
    const laneWitness = (
      id: string,
      column: 'left' | 'right',
      x: number,
      width: number,
      y = 0.03,
    ): PdfPageRegion => {
      const sourceLine = {
        id: `${id}-line`,
        text: `${column} lane witness`,
        fontSize: 10,
        box: box(x, y, width, 0.014),
        runs: [
          {
            ...box(x, y, width, 0.014),
            text: `${column} lane witness`,
            fontName: 'BodySerif',
            fontSize: 10,
            confidence: 0.99,
          },
        ],
      } satisfies PdfRegionLine
      return {
        ...textRegion(id, sourceLine.box, [sourceLine], 'header'),
        column,
      }
    }

    const tabularLine = (
      id: string,
      y: number,
      anchors: number[],
    ): PdfRegionLine => {
      const runs = anchors.map<PdfSourceRun>((x, index) => ({
        ...box(x, y, index === 0 ? 0.085 : 0.035, 0.012),
        text: index === 0 ? `${id}-model` : `${index}.${id.at(-1)}`,
        fontName: 'CompactTableSerif',
        fontSize: 8,
        confidence: 0.99,
      }))
      return {
        id,
        text: runs.map((run) => run.text).join(' '),
        fontSize: 8,
        box: box(
          anchors[0],
          y,
          anchors.at(-1)! + runs.at(-1)!.width - anchors[0],
          0.012,
        ),
        runs,
      }
    }

    const proseLine = (id: string, y: number): PdfRegionLine => {
      const sourceBox = box(0.09, y, 0.382, 0.012)
      return {
        id,
        text: `Unrelated prose in the opposite lane ${id}.`,
        fontSize: 8,
        box: sourceBox,
        runs: [
          {
            ...sourceBox,
            text: `Unrelated prose in the opposite lane ${id}.`,
            fontName: 'CompactTableSerif',
            fontSize: 8,
            confidence: 0.99,
          },
        ],
      }
    }

    it.each(['span', 'single'] as const)(
      'keeps opposite-lane prose out when a local caption is classified as %s',
      (captionColumn) => {
        const tableLines = Array.from({ length: 7 }, (_, index) =>
          tabularLine(
            `right-table-row-${index + 1}`,
            0.15 + index * 0.036,
            [0.512, 0.64, 0.72, 0.81],
          ),
        )
        const oppositeLines = Array.from({ length: 7 }, (_, index) =>
          proseLine(`left-prose-${index + 1}`, 0.168 + index * 0.036),
        )
        const compositeRegion = {
          ...textRegion(
            'interleaved-two-column-parent',
            box(0.09, 0.15, 0.755, 0.24),
            tableLines.flatMap((line, index) => [line, oppositeLines[index]]),
          ),
          column: 'span' as const,
        }
        const tableCaption = {
          ...caption(
            `local-${captionColumn}-caption`,
            0.11,
            'Table 1. Right-column benchmark results.',
          ),
          column: captionColumn,
          box: box(0.505, 0.11, 0.38, 0.02),
        }
        const witnesses = [
          laneWitness('left-lane-witness', 'left', 0.09, 0.382),
          laneWitness('left-lane-witness-2', 'left', 0.09, 0.382, 0.05),
          laneWitness('left-lane-witness-3', 'left', 0.09, 0.382, 0.07),
          laneWitness('right-lane-witness', 'right', 0.512, 0.373),
          laneWitness('right-lane-witness-2', 'right', 0.512, 0.373, 0.05),
          laneWitness('right-lane-witness-3', 'right', 0.512, 0.373, 0.07),
          // The source classifier is independent but not infallible. These
          // exact line boxes emulate a first table column classified as left
          // and a short right-owned overlay inside the left measure. Extrema
          // overlap, while the central source-line corridor remains exact.
          laneWitness('left-label-outlier', 'left', 0.512, 0.085, 0.085),
          laneWitness('right-label-outlier', 'right', 0.4, 0.05, 0.085),
        ]
        const resolve = (pageRegions: PdfPageRegion[]) =>
          resolvePdfTableScope({
            caption: tableCaption,
            pageRegions,
            nativeObjects: [],
          })
        const forward = resolve([
          tableCaption,
          ...witnesses.slice(0, 4),
          compositeRegion,
          ...witnesses.slice(4),
        ])
        const reverse = resolve([
          ...witnesses.slice(4).reverse(),
          compositeRegion,
          ...witnesses.slice(0, 4).reverse(),
          tableCaption,
        ])
        const expectedLineIds = tableLines.map((line) => line.id)

        expect(forward).toMatchObject({
          status: 'matched',
          scope: {
            proof: 'text-tabular-line-band',
            sourceRegionIds: [compositeRegion.id],
            sourceLineIds: expectedLineIds,
          },
        })
        expect(forward.scope?.sourceLineIds).not.toEqual(
          expect.arrayContaining(oppositeLines.map((line) => line.id)),
        )
        expect(forward.scope?.cropBox.x).toBeGreaterThanOrEqual(0.5)
        expect(
          forward.scope!.cropBox.x + forward.scope!.cropBox.width,
        ).toBeLessThanOrEqual(0.89)
        expect(reverse.scope).toEqual(forward.scope)
      },
    )

    it('keeps opposite-lane prose out of a spanning parent when the caption has an explicit page column', () => {
      const tableLines = Array.from({ length: 7 }, (_, index) =>
        tabularLine(
          `left-table-row-${index + 1}`,
          0.15 + index * 0.03,
          [0.116, 0.262, 0.326, 0.399],
        ),
      )
      const oppositeLines = Array.from({ length: 7 }, (_, index) => {
        const sourceBox = box(0.502, 0.1515 + index * 0.03, 0.385, 0.012)
        return {
          id: `right-prose-row-${index + 1}`,
          text: `Unrelated prose in the right page column ${index + 1}.`,
          fontSize: 8,
          box: sourceBox,
          runs: [
            {
              ...sourceBox,
              text: `Unrelated prose in the right page column ${index + 1}.`,
              fontName: 'CompactTableSerif',
              fontSize: 8,
              confidence: 0.99,
            },
          ],
        } satisfies PdfRegionLine
      })
      const compositeRegion = {
        ...textRegion(
          'explicit-left-caption-spanning-parent',
          box(0.116, 0.15, 0.771, 0.196),
          tableLines.flatMap((line, index) => [line, oppositeLines[index]]),
          'spanning',
        ),
        column: 'span' as const,
      }
      const tableCaption = {
        ...caption(
          'explicit-left-table-caption',
          0.11,
          'Table 6. Left-column source results.',
        ),
        column: 'left' as const,
        box: box(0.09, 0.11, 0.383, 0.02),
      }

      const result = resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [tableCaption, compositeRegion],
        nativeObjects: [],
      })

      expect(result).toMatchObject({
        status: 'matched',
        scope: {
          sourceRegionIds: [compositeRegion.id],
          sourceLineIds: tableLines.map((sourceLine) => sourceLine.id),
        },
      })
      expect(result.scope?.sourceLineIds).not.toEqual(
        expect.arrayContaining(
          oppositeLines.map((sourceLine) => sourceLine.id),
        ),
      )
      expect(
        result.scope!.cropBox.x + result.scope!.cropBox.width,
      ).toBeLessThan(0.48)
    })

    it('ignores a non-reading-order page number when inferring the real Table 1 lane', () => {
      const page5Box = (
        x: number,
        y: number,
        width: number,
        height = 0.01258,
      ): NormalizedSourceBox => ({
        ...box(x, y, width, height),
        page: 5,
      })
      const sourceRegion = (
        regionId: string,
        lineId: string,
        text: string,
        column: 'left' | 'right',
        x: number,
        y: number,
        width: number,
        kind: PdfPageRegion['kind'] = 'body',
        includedInReadingOrder = true,
      ) => {
        const sourceBox = page5Box(x, y, width)
        const sourceLine = {
          id: lineId,
          text,
          fontSize: 8.9664,
          box: sourceBox,
          runs: [
            {
              ...sourceBox,
              text,
              fontName: 'NXWQTR+STIXGeneral-Regular',
              fontSize: 8.9664,
              confidence: 1,
            },
          ],
        } satisfies PdfRegionLine
        return {
          ...textRegion(regionId, sourceBox, [sourceLine], kind),
          column,
          includedInReadingOrder,
        } satisfies PdfPageRegion
      }
      const actualCaption = {
        ...caption(
          'page-005-region-011',
          0.45381,
          'Table 1. s1-32B is an open and sample-efficient reasoning model.',
        ),
        page: 5,
        column: 'span' as const,
        box: page5Box(0.50153, 0.45381, 0.38573, 0.08679),
      }
      const oppositeProse = [
        sourceRegion(
          'page-005-region-015-prose-1',
          'page-005-line-0039',
          'Other models We benchmark s1-32B against: OpenAI o1 series',
          'left',
          0.09059,
          0.56777,
          0.38235,
        ),
        sourceRegion(
          'page-005-region-015-prose-2',
          'page-005-line-0040',
          'which are closed-source models that popularized the idea of',
          'left',
          0.09059,
          0.58287,
          0.38235,
        ),
        sourceRegion(
          'page-005-region-015-prose-3',
          'page-005-line-0042',
          'test-time scaling; DeepSeek r1 series are open-weight models',
          'left',
          0.09059,
          0.59796,
          0.38358,
        ),
      ]
      const tableCells = [
        sourceRegion(
          'page-005-region-015-model',
          'page-005-line-0035',
          'Model',
          'left',
          0.51212,
          0.55452,
          0.0425,
        ),
        sourceRegion(
          'page-005-region-014',
          'page-005-line-0034',
          '# ex.',
          'right',
          0.63009,
          0.55439,
          0.0313,
        ),
        sourceRegion(
          'page-005-region-012',
          'page-005-line-0032',
          'AIME MATH',
          'right',
          0.69096,
          0.54684,
          0.10817,
        ),
        sourceRegion(
          'page-005-region-013',
          'page-005-line-0033',
          'GPQA',
          'right',
          0.8268,
          0.54684,
          0.04433,
        ),
        ...[
          ['o1-preview', 0.60476, 'N.A.', '44.6', '85.5', '73.3'],
          ['o1-mini', 0.61985, 'N.A.', '70.0', '90.0', '60.0'],
          ['o1', 0.63495, 'N.A.', '74.4', '94.8', '77.3'],
        ].flatMap(([model, y, examples, aime, math, gpqa], rowIndex) => [
          sourceRegion(
            `actual-model-${rowIndex + 1}`,
            `actual-model-line-${rowIndex + 1}`,
            String(model),
            'left',
            0.51212,
            Number(y),
            rowIndex === 0 ? 0.07348 : rowIndex === 1 ? 0.05155 : 0.01628,
          ),
          sourceRegion(
            `actual-examples-${rowIndex + 1}`,
            `actual-examples-line-${rowIndex + 1}`,
            String(examples),
            'right',
            0.64007,
            Number(y),
            0.03135,
          ),
          sourceRegion(
            `actual-aime-${rowIndex + 1}`,
            `actual-aime-line-${rowIndex + 1}`,
            String(aime),
            'right',
            0.70406,
            Number(y),
            0.02849,
          ),
          sourceRegion(
            `actual-math-${rowIndex + 1}`,
            `actual-math-line-${rowIndex + 1}`,
            String(math),
            'right',
            0.77064,
            Number(y),
            0.02849,
          ),
          sourceRegion(
            `actual-gpqa-${rowIndex + 1}`,
            `actual-gpqa-line-${rowIndex + 1}`,
            String(gpqa),
            'right',
            0.85077,
            Number(y),
            0.02849,
          ),
        ]),
      ]
      const pageNumber = sourceRegion(
        'page-005-region-078',
        'page-005-line-0126',
        '5',
        'left',
        0.48358,
        0.92172,
        0.00814,
        'page-number',
        false,
      )
      const lowerFirstColumn = sourceRegion(
        'page-005-region-056-model',
        'page-005-line-0092',
        'r1-distill',
        'left',
        0.51212,
        0.76834,
        0.05595,
      )
      const lowerOppositeProse = sourceRegion(
        'page-005-region-056-prose',
        'page-005-line-0097',
        'evaluation challenging. We circumvent this by manually',
        'left',
        0.09059,
        0.77784,
        0.38292,
      )
      const lowerRightLines = [
        sourceRegion(
          'page-005-region-059-score',
          'page-005-line-0096',
          '62.1',
          'right',
          0.85077,
          0.76834,
          0.02849,
        ).lines[0],
        sourceRegion(
          'page-005-region-059-group',
          'page-005-line-0098',
          'Open Weights and Open Data',
          'right',
          0.59159,
          0.78975,
          0.20819,
        ).lines[0],
        sourceRegion(
          'page-005-region-059-examples',
          'page-005-line-0102',
          '17K',
          'right',
          0.64339,
          0.81116,
          0.02803,
        ).lines[0],
      ]
      const lowerRightComposite = {
        ...textRegion(
          'page-005-region-059',
          page5Box(0.59159, 0.76834, 0.28767, 0.0554),
          lowerRightLines,
        ),
        column: 'right' as const,
      }
      const lowerNumericCells = [
        sourceRegion(
          'page-005-region-055',
          'page-005-line-0093',
          '800K',
          'right',
          0.63525,
          0.76834,
          0.03617,
        ),
        sourceRegion(
          'page-005-region-057',
          'page-005-line-0094',
          '72.6',
          'right',
          0.70406,
          0.76834,
          0.02849,
        ),
        sourceRegion(
          'page-005-region-058',
          'page-005-line-0095',
          '94.3',
          'right',
          0.77064,
          0.76834,
          0.02849,
        ),
      ]
      const resolve = (marginRegion: PdfPageRegion) =>
        resolvePdfTableScope({
          caption: actualCaption,
          pageRegions: [
            actualCaption,
            ...oppositeProse,
            ...tableCells,
            lowerFirstColumn,
            lowerOppositeProse,
            lowerRightComposite,
            ...lowerNumericCells,
            marginRegion,
          ],
          nativeObjects: [],
        })
      const scoped = resolve(pageNumber)

      expect(scoped).toMatchObject({
        status: 'matched',
      })
      expect(scoped.scope?.sourceLineIds).not.toEqual(
        expect.arrayContaining(
          oppositeProse
            .flatMap((region) =>
              region.lines.map((sourceLine) => sourceLine.id),
            )
            .concat(
              lowerOppositeProse.lines.map((sourceLine) => sourceLine.id),
            ),
        ),
      )
      expect(scoped.scope?.cropBox.x).toBeGreaterThanOrEqual(0.5)
      expect(
        scoped.scope!.cropBox.x + scoped.scope!.cropBox.width,
      ).toBeLessThanOrEqual(0.89)
    })

    it('falls back from the real Table 1 internal column gap to its page gutter', () => {
      const page5Box = (
        x: number,
        y: number,
        width: number,
        height: number,
      ): NormalizedSourceBox => ({
        page: 5,
        x,
        y,
        width,
        height,
        rotation: 0,
        method: 'pdf-text',
      })
      type ActualLine = [
        id: string,
        text: string,
        x: number,
        y: number,
        width: number,
        bold?: boolean,
      ]
      const actualRegion = (
        id: string,
        column: 'left' | 'right',
        regionBox: [x: number, y: number, width: number, height: number],
        lines: ActualLine[],
      ): PdfPageRegion => {
        const sourceLines = lines.map<PdfRegionLine>(
          ([lineId, text, x, y, width, bold = false]) => {
            const sourceBox = page5Box(x, y, width, 0.01258)
            return {
              id: lineId,
              text,
              fontSize: 9.9626,
              box: sourceBox,
              runs: [
                {
                  ...sourceBox,
                  text,
                  fontName: bold
                    ? 'KTBBOM+STIXGeneral-Bold'
                    : 'NXWQTR+STIXGeneral-Regular',
                  fontSize: 9.9626,
                  confidence: 1,
                },
              ],
            }
          },
        )
        const sourceBox = page5Box(...regionBox)
        return {
          ...textRegion(id, sourceBox, sourceLines),
          column,
        }
      }
      const actualCaption = {
        ...caption(
          'page-005-region-011',
          0.45381,
          'Table 1. s1-32B is an open and sample-efficient reasoning model.',
        ),
        page: 5,
        column: 'span' as const,
        box: page5Box(0.50153, 0.45381, 0.38573, 0.08679),
      }
      const actualRegions = [
        actualRegion(
          'page-005-region-015-prose-1',
          'left',
          [0.09059, 0.56777, 0.38235, 0.01258],
          [
            [
              'page-005-line-0039',
              'Other models We benchmark s1-32B against: OpenAI o1 series',
              0.09059,
              0.56777,
              0.38235,
            ],
          ],
        ),
        actualRegion(
          'page-005-region-015-prose-2',
          'left',
          [0.09059, 0.58287, 0.38235, 0.01258],
          [
            [
              'page-005-line-0040',
              'which are closed-source models that popularized the idea of',
              0.09059,
              0.58287,
              0.38235,
            ],
          ],
        ),
        actualRegion(
          'page-005-region-015-prose-3',
          'left',
          [0.09059, 0.59796, 0.38358, 0.01258],
          [
            [
              'page-005-line-0042',
              'test-time scaling; DeepSeek r1 series are open-weight models',
              0.09059,
              0.59796,
              0.38358,
            ],
          ],
        ),
        actualRegion(
          'page-005-region-018',
          'right',
          [0.64007, 0.56194, 0.23919, 0.0554],
          [
            ['page-005-line-0038', 'Diamond', 0.81867, 0.56194, 0.06059],
            ['page-005-line-0041', 'API only', 0.66485, 0.58335, 0.06168, true],
            ['page-005-line-0044', 'N.A.', 0.64007, 0.60476, 0.03135],
          ],
        ),
        actualRegion(
          'page-005-region-027',
          'right',
          [0.64007, 0.61985, 0.23919, 0.02768],
          [
            ['page-005-line-0053', '60.0', 0.85077, 0.61985, 0.02849],
            ['page-005-line-0056', 'N.A.', 0.64007, 0.63495, 0.03135],
          ],
        ),
        actualRegion(
          'page-005-region-025',
          'right',
          [0.70406, 0.61985, 0.02849, 0.01258],
          [['page-005-line-0051', '70.0', 0.70406, 0.61985, 0.02849]],
        ),
        actualRegion(
          'page-005-region-026',
          'right',
          [0.77064, 0.61985, 0.02849, 0.01258],
          [['page-005-line-0052', '90.0', 0.77064, 0.61985, 0.02849]],
        ),
        actualRegion(
          'page-005-region-030',
          'right',
          [0.70406, 0.63495, 0.02849, 0.01258],
          [['page-005-line-0057', '74.4', 0.70406, 0.63495, 0.02849, true]],
        ),
        actualRegion(
          'page-005-region-031',
          'right',
          [0.77064, 0.63495, 0.02849, 0.01258],
          [['page-005-line-0058', '94.8', 0.77064, 0.63495, 0.02849, true]],
        ),
        actualRegion(
          'page-005-region-035',
          'right',
          [0.70406, 0.65759, 0.02849, 0.01258],
          [['page-005-line-0063', '60.0', 0.70406, 0.65759, 0.02849]],
        ),
        actualRegion(
          'page-005-region-036',
          'right',
          [0.76778, 0.65759, 0.03135, 0.01258],
          [['page-005-line-0064', 'N.A.', 0.76778, 0.65759, 0.03135]],
        ),
        actualRegion(
          'page-005-region-037',
          'right',
          [0.8479, 0.65759, 0.03135, 0.01258],
          [['page-005-line-0065', 'N.A.', 0.8479, 0.65759, 0.03135]],
        ),
        actualRegion(
          'page-005-region-039',
          'left',
          [0.51212, 0.66514, 0.08229, 0.01258],
          [['page-005-line-0067', 'Flash Think.', 0.51212, 0.66514, 0.08229]],
        ),
        actualRegion(
          'page-005-region-041',
          'right',
          [0.64662, 0.68655, 0.09814, 0.01258],
          [
            [
              'page-005-line-0069',
              'Open Weights',
              0.64662,
              0.68655,
              0.09814,
              true,
            ],
          ],
        ),
        actualRegion(
          'page-005-region-046',
          'right',
          [0.64007, 0.71551, 0.23919, 0.03522],
          [
            ['page-005-line-0076', '49.0', 0.85077, 0.71551, 0.02849],
            ['page-005-line-0081', 'N.A.', 0.64007, 0.73815, 0.03135],
          ],
        ),
        actualRegion(
          'page-005-region-044',
          'right',
          [0.70406, 0.71551, 0.02849, 0.01258],
          [['page-005-line-0074', '26.7', 0.70406, 0.71551, 0.02849]],
        ),
        actualRegion(
          'page-005-region-045',
          'right',
          [0.77064, 0.71551, 0.02849, 0.01258],
          [['page-005-line-0075', '84.0', 0.77064, 0.71551, 0.02849]],
        ),
        actualRegion(
          'page-005-region-048',
          'left',
          [0.09059, 0.73815, 0.48935, 0.02334],
          [
            ['page-005-line-0080', 'QwQ-32B', 0.51212, 0.73815, 0.06782],
            [
              'page-005-line-0085',
              'scores, we use the Gemini API to benchmark it ourselves.',
              0.09059,
              0.74891,
              0.3852,
            ],
          ],
        ),
        actualRegion(
          'page-005-region-059',
          'right',
          [0.59159, 0.76834, 0.28767, 0.0554],
          [
            ['page-005-line-0096', '62.1', 0.85077, 0.76834, 0.02849],
            [
              'page-005-line-0098',
              'Open Weights and Open Data',
              0.59159,
              0.78975,
              0.20819,
              true,
            ],
            ['page-005-line-0102', '17K', 0.64339, 0.81116, 0.02803],
          ],
        ),
        actualRegion(
          'page-005-region-057',
          'right',
          [0.70406, 0.76834, 0.02849, 0.01258],
          [['page-005-line-0094', '72.6', 0.70406, 0.76834, 0.02849]],
        ),
        actualRegion(
          'page-005-region-058',
          'right',
          [0.77064, 0.76834, 0.02849, 0.01258],
          [['page-005-line-0095', '94.3', 0.77064, 0.76834, 0.02849]],
        ),
      ]

      const scoped = resolvePdfTableScope({
        caption: actualCaption,
        pageRegions: [actualCaption, ...actualRegions],
        nativeObjects: [],
      })

      expect(scoped).toMatchObject({
        status: 'matched',
      })
      expect(scoped.scope?.sourceLineIds).not.toContain('page-005-line-0085')
      expect(scoped.scope?.cropBox.x).toBeGreaterThanOrEqual(0.5)
      expect(
        scoped.scope!.cropBox.x + scoped.scope!.cropBox.width,
      ).toBeLessThanOrEqual(0.89)
    })

    it('does not partition a truly spanning caption at the inferred page gutter', () => {
      const leftLines = Array.from({ length: 4 }, (_, index) =>
        tabularLine(
          `spanning-left-row-${index + 1}`,
          0.16 + index * 0.03,
          [0.1, 0.21, 0.32],
        ),
      )
      const rightLines = Array.from({ length: 4 }, (_, index) =>
        tabularLine(
          `spanning-right-row-${index + 1}`,
          0.16 + index * 0.03,
          [0.56, 0.67, 0.78],
        ),
      )
      const fullWidthTable = {
        ...textRegion(
          'full-width-two-lane-table',
          box(0.1, 0.16, 0.715, 0.102),
          leftLines.flatMap((line, index) => [line, rightLines[index]]),
        ),
        column: 'span' as const,
      }
      const tableCaption = {
        ...caption(
          'full-width-span-caption',
          0.12,
          'Table 2. Full-width benchmark results.',
        ),
        column: 'span' as const,
        box: box(0.08, 0.12, 0.82, 0.02),
      }
      const result = resolvePdfTableScope({
        caption: tableCaption,
        pageRegions: [
          tableCaption,
          laneWitness('full-width-left-witness', 'left', 0.09, 0.382),
          fullWidthTable,
          laneWitness('full-width-right-witness', 'right', 0.512, 0.373),
        ],
        nativeObjects: [],
      })

      expect(result).toMatchObject({
        status: 'matched',
        scope: {
          sourceRegionIds: [fullWidthTable.id],
          sourceLineIds: leftLines.flatMap((line, index) => [
            line.id,
            rightLines[index].id,
          ]),
        },
      })
      expect(result.scope?.cropBox.x).toBeLessThan(0.2)
      expect(
        result.scope!.cropBox.x + result.scope!.cropBox.width,
      ).toBeGreaterThan(0.75)
    })

    it('does not infer a local lane on a genuinely single-column prose page', () => {
      const proseLines = Array.from({ length: 7 }, (_, index) => {
        const sourceBox = box(0.12, 0.16 + index * 0.02, 0.68, 0.014)
        return {
          id: `single-column-prose-${index + 1}`,
          text: `Ordinary narrative prose continues in one column on line ${index + 1}.`,
          fontSize: 10,
          box: sourceBox,
          runs: [
            {
              ...sourceBox,
              text: `Ordinary narrative prose continues in one column on line ${index + 1}.`,
              fontName: 'BodySerif',
              fontSize: 10,
              confidence: 0.99,
            },
          ],
        } satisfies PdfRegionLine
      })
      const prose = textRegion(
        'genuine-single-column-prose',
        box(0.12, 0.16, 0.68, 0.134),
        proseLines,
      )
      const tableCaption = {
        ...caption(
          'genuine-single-column-caption',
          0.12,
          'Table 3. A caption without a proved source table.',
        ),
        column: 'single' as const,
      }

      expect(
        resolvePdfTableScope({
          caption: tableCaption,
          pageRegions: [tableCaption, prose],
          nativeObjects: [],
        }),
      ).toMatchObject({
        status: 'unresolved',
        scope: null,
        candidates: [],
      })
    })
  })
})

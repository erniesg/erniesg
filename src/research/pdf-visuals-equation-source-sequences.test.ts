import { describe, expect, it, vi } from 'vitest'
import type {
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceRun,
  PdfVisualAsset,
} from './import-types'
import { reconstructPdfVisuals, type PdfFigureRasterizer } from './pdf-visuals'
import { createSourcePageCropAsset } from './visual-assets'

function box(x: number, y: number, width = 0.2, height = 0.1, page = 1) {
  return {
    page,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-object',
  } satisfies NormalizedSourceBox
}

function equationRegion(
  id: string,
  text: string,
  sourceBox: NormalizedSourceBox,
): PdfPageRegion {
  const textBox = { ...sourceBox, method: 'pdf-text' as const }
  return {
    id,
    page: 1,
    kind: 'equation',
    column: 'single',
    text,
    confidence: 0.93,
    box: textBox,
    lines: [
      {
        id: `${id}-line`,
        text,
        fontSize: 12,
        box: textBox,
        runs: [
          {
            ...textBox,
            text,
            fontName: 'EquationFont',
            fontSize: 12,
            confidence: 0.98,
          },
        ],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  } satisfies PdfPageRegion
}

function textRegion(
  id: string,
  text: string,
  sourceBox: NormalizedSourceBox,
  kind: PdfPageRegion['kind'] = 'body',
): PdfPageRegion {
  const textBox = { ...sourceBox, method: 'pdf-text' as const }
  return {
    id,
    page: textBox.page,
    kind,
    column: 'single',
    text,
    confidence: 0.99,
    box: textBox,
    lines: [
      {
        id: `${id}-line`,
        text,
        fontSize: 9,
        box: textBox,
        runs: [
          {
            ...textBox,
            text,
            fontName: 'DiagramSans',
            fontSize: 9,
            confidence: 0.99,
          },
        ],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: !['side', 'chart-label'].includes(kind),
  } satisfies PdfPageRegion
}

function page(
  objects: PdfPageAnalysis['objects'],
  pageNumber = objects?.[0]?.page ?? 1,
  assets: PdfVisualAsset[] = [],
): PdfPageAnalysis {
  return {
    page: pageNumber,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: 20,
    imageCount: objects?.length ?? 0,
    objects,
    assets,
    runs: [],
  }
}

describe('PDF visual association graph', () => {
  it.each(['body', 'equation'] as const)(
    'groups a six-row stacked-radical display into one atomic source-cropped equation when its denominator row is classified as %s',
    async (denominatorKind) => {
      // Mirrors arXiv:2501.19393v2 page 29: T = ⁴√(R⊙u/3σ) = … ≈ 50000 K is
      // painted as six interleaved text rows (an unmatched `√√ (` opener
      // column, a detached outer radical, the numerator, the T = ⁴√ row, the
      // result row, and the 3σ denominator). The whole band must resolve as
      // ONE atomic display-equation component with a source-crop rendition —
      // never as garbled reading-order prose.
      const italic = 'Synthetic-STIXMath-Italic'
      const regular = 'Synthetic-STIXMath-Regular'
      const extension = 'Synthetic-STIXMathExtensions-Regular'
      const serif = 'Synthetic-STIXGeneral-Regular'
      const run = (
        text: string,
        x: number,
        y: number,
        width: number,
        height: number,
        fontName: string,
        fontSize: number,
        sourceSequenceIndex: number,
        sourceWhitespacePredecessorIndex?: number,
      ): PdfSourceRun => {
        const base = {
          page: 1,
          x,
          y,
          width,
          height,
          rotation: 0,
          method: 'pdf-text' as const,
          text,
          fontName,
          fontSize,
          confidence: 1,
          sourceSequenceIndex,
        }
        return sourceWhitespacePredecessorIndex === undefined
          ? base
          : {
              ...base,
              sourceWhitespaceBefore: 'pdf-text-item',
              sourceWhitespacePredecessorIndex,
            }
      }
      const bandRegion = (
        id: string,
        kind: PdfPageRegion['kind'],
        text: string,
        runs: PdfSourceRun[],
      ): PdfPageRegion => {
        const x = Math.min(...runs.map((item) => item.x))
        const y = Math.min(...runs.map((item) => item.y))
        const lineBox = {
          page: 1,
          x,
          y,
          width: Math.max(...runs.map((item) => item.x + item.width)) - x,
          height: Math.max(...runs.map((item) => item.y + item.height)) - y,
          rotation: 0,
          method: 'pdf-text' as const,
        }
        return {
          id,
          page: 1,
          kind,
          column: 'single',
          text,
          confidence: 0.9,
          box: lineBox,
          lines: [
            { id: `${id}-line`, text, fontSize: 9.9626, box: lineBox, runs },
          ],
          nativeObjectIds: [],
          includedInReadingOrder: true,
        }
      }
      const precedingDisplay = bandRegion(
        'stacked-radical-preceding-display',
        'equation',
        '𝑃 = 𝜎𝐴𝑇 4 = 4𝜋𝜎𝑅2⊙𝑇 4',
        [
          run('𝑃', 0.40743, 0.35674, 0.00967, 0.01258, italic, 9.9626, 70),
          run('=', 0.42406, 0.35674, 0.01115, 0.01258, regular, 9.9626, 72, 70),
          run(
            '𝜎𝐴𝑇',
            0.43974,
            0.35674,
            0.03018,
            0.01258,
            italic,
            9.9626,
            74,
            72,
          ),
          run('4', 0.47252, 0.35485, 0.0061, 0.00943, regular, 7.472, 76, 74),
          run(
            '= 4',
            0.48396,
            0.35674,
            0.02382,
            0.01258,
            regular,
            9.9626,
            78,
            76,
          ),
          run('𝜋𝜎𝑅', 0.50777, 0.35674, 0.0315, 0.01258, italic, 9.9626, 79),
          run('2', 0.53927, 0.35485, 0.0061, 0.00943, regular, 7.472, 80),
          run('⊙', 0.53927, 0.36429, 0.0093, 0.00943, italic, 7.472, 82),
          run('𝑇', 0.54939, 0.35674, 0.00895, 0.01258, italic, 9.9626, 83),
          run('4', 0.56095, 0.35485, 0.0061, 0.00943, regular, 7.472, 85, 83),
        ],
      )
      const leadProse = bandRegion(
        'stacked-radical-lead-prose',
        'body',
        'Solving for 𝑇, we get',
        [
          run(
            'Solving for',
            0.09059,
            0.37938,
            0.07285,
            0.01258,
            serif,
            9.9626,
            87,
          ),
          run('𝑇', 0.16751, 0.37938, 0.00895, 0.01258, italic, 9.9626, 89, 87),
          run(
            ', we get',
            0.17906,
            0.37938,
            0.0504,
            0.01258,
            serif,
            9.9626,
            91,
            89,
          ),
        ],
      )
      const opener = bandRegion(
        'stacked-radical-opener-column',
        'equation',
        '√√ (',
        [
          run('√', 0.39188, 0.39739, 0.01927, 0.01258, extension, 9.9626, 112),
          run('√', 0.39188, 0.40404, 0.01927, 0.01258, extension, 9.9626, 113),
          run('(', 0.41311, 0.40247, 0.00762, 0.01258, extension, 9.9626, 116),
        ],
      )
      const outerRadical = bandRegion(
        'stacked-radical-outer-radical',
        'equation',
        '√',
        [run('√', 0.31924, 0.40232, 0.0183, 0.01258, extension, 9.9626, 99)],
      )
      const numeratorRow = bandRegion(
        'stacked-radical-numerator-row',
        'equation',
        '𝑅 𝑢 √ 6.96 × 108) (1506)',
        [
          run('𝑅', 0.33949, 0.41329, 0.01205, 0.01258, italic, 9.9626, 101, 99),
          run('𝑢', 0.36165, 0.41329, 0.00772, 0.01258, italic, 9.9626, 103),
          run('√', 0.39188, 0.41069, 0.01927, 0.01258, extension, 9.9626, 114),
          run('6', 0.42072, 0.41253, 0.00814, 0.01258, regular, 9.9626, 117),
          run('.', 0.42886, 0.41253, 0.00407, 0.01258, italic, 9.9626, 118),
          run(
            '96 × 10',
            0.43293,
            0.41253,
            0.0502,
            0.01258,
            regular,
            9.9626,
            119,
          ),
          run('8', 0.48314, 0.41221, 0.0061, 0.00943, regular, 7.472, 120),
          run(')', 0.49006, 0.40247, 0.00762, 0.01258, extension, 9.9626, 121),
          run(
            '(1506)',
            0.50039,
            0.41253,
            0.0434,
            0.01258,
            regular,
            9.9626,
            123,
            121,
          ),
        ],
      )
      const equalsRow = bandRegion(
        'stacked-radical-equals-row',
        'equation',
        '𝑇 = 4 ⊙ = √4',
        [
          run('𝑇', 0.28712, 0.42317, 0.00895, 0.01258, italic, 9.9626, 93),
          run('=', 0.3032, 0.42317, 0.01115, 0.01258, regular, 9.9626, 95, 93),
          run('4', 0.3234, 0.42026, 0.00488, 0.00755, regular, 5.9776, 97, 95),
          run('⊙', 0.35153, 0.41958, 0.0093, 0.00943, italic, 7.472, 102),
          run(
            '=',
            0.37584,
            0.42317,
            0.01115,
            0.01258,
            regular,
            9.9626,
            108,
            106,
          ),
          run('√', 0.39188, 0.41798, 0.01927, 0.01258, extension, 9.9626, 115),
          run(
            '4',
            0.39604,
            0.42209,
            0.00488,
            0.00755,
            regular,
            5.9776,
            110,
            108,
          ),
        ],
      )
      const resultRow = bandRegion(
        'stacked-radical-result-row',
        'equation',
        '3 (5.67 × 10−8) = 49823 ≈ 50000 K.',
        [
          run('3', 0.42655, 0.43382, 0.00814, 0.01258, regular, 9.9626, 124),
          run(
            '(',
            0.43741,
            0.42377,
            0.00762,
            0.01258,
            extension,
            9.9626,
            126,
            124,
          ),
          run('5', 0.44502, 0.43382, 0.00814, 0.01258, regular, 9.9626, 127),
          run('.', 0.45317, 0.43382, 0.00407, 0.01258, italic, 9.9626, 128),
          run(
            '67 × 10',
            0.45723,
            0.43382,
            0.0502,
            0.01258,
            regular,
            9.9626,
            129,
          ),
          run('−8', 0.50744, 0.43351, 0.01447, 0.00943, regular, 7.472, 130),
          run(')', 0.52273, 0.42377, 0.00762, 0.01258, extension, 9.9626, 131),
          run(
            '= 49823 ≈ 50000 K',
            0.55027,
            0.42317,
            0.13308,
            0.01258,
            regular,
            9.9626,
            133,
            131,
          ),
          run('.', 0.6841, 0.42317, 0.00407, 0.01258, italic, 9.9626, 134),
        ],
      )
      const denominatorRow = bandRegion(
        'stacked-radical-denominator-row',
        denominatorKind,
        '3𝜎',
        [
          run('3', 0.34558, 0.43198, 0.00814, 0.01258, regular, 9.9626, 105),
          run('𝜎', 0.35372, 0.43198, 0.00874, 0.01258, italic, 9.9626, 106),
        ],
      )
      const bandRegions = [
        opener,
        outerRadical,
        numeratorRow,
        equalsRow,
        resultRow,
        denominatorRow,
      ]
      const bandLineIds = bandRegions.map((region) => region.lines[0].id)
      const bandRegionIds = bandRegions.map((region) => region.id)
      const allRegions = [precedingDisplay, leadProse, ...bandRegions]
      const whitespaceRun = (
        x: number,
        width: number,
        y: number,
        fontName: string,
        fontSize: number,
        sourceSequenceIndex: number,
        height = 0.01258,
      ): PdfSourceRun =>
        run(' ', x, y, width, height, fontName, fontSize, sourceSequenceIndex)
      const sourcePage = page([])
      sourcePage.renderVisibleTextRuns = [
        ...allRegions.flatMap((region) =>
          region.lines.flatMap((line) =>
            line.runs.map((item) => ({ ...item })),
          ),
        ),
        whitespaceRun(0.4171, 0.00696, 0.35674, italic, 9.9626, 71),
        whitespaceRun(0.43521, 0.00452, 0.35674, regular, 9.9626, 73),
        whitespaceRun(0.46992, 0.00261, 0.35674, italic, 9.9626, 75),
        whitespaceRun(0.47863, 0.00533, 0.35485, regular, 7.472, 77, 0.00943),
        whitespaceRun(0.55834, 0.0026, 0.35674, italic, 9.9626, 84),
        whitespaceRun(0.16344, 0.00407, 0.37938, serif, 9.9626, 88),
        whitespaceRun(0.17646, 0.0026, 0.37938, italic, 9.9626, 90),
        whitespaceRun(0.29608, 0.00713, 0.42317, italic, 9.9626, 94),
        whitespaceRun(0.31435, 0.00904, 0.42317, regular, 9.9626, 96),
        whitespaceRun(0.33753, 0.00195, 0.40232, extension, 9.9626, 100),
        whitespaceRun(0.36246, 0.01338, 0.43198, italic, 9.9626, 107),
        whitespaceRun(0.38699, 0.00904, 0.42317, regular, 9.9626, 109),
        whitespaceRun(0.49768, 0.00271, 0.40247, extension, 9.9626, 122),
        whitespaceRun(0.43469, 0.00271, 0.43382, regular, 9.9626, 125),
        whitespaceRun(0.53035, 0.01992, 0.42377, extension, 9.9626, 132),
      ]
      const rasterizeFigure = vi.fn(
        async (input: Parameters<PdfFigureRasterizer>[0]) =>
          createSourcePageCropAsset({
            kind: 'equation',
            cropBox: input.sourceBox,
            sourceObjectIds: input.sourceObjectIds,
            sourceBoxes: input.sourceBoxes,
            width: 96,
            height: 20,
            pixels: new Uint8Array(96 * 20 * 4).fill(72),
          }),
      )

      const result = await reconstructPdfVisuals({
        pages: [sourcePage],
        regions: allRegions,
        rasterizeFigure,
      })

      const bandRelationships = result.relationships.filter((relationship) =>
        relationship.candidates.some((candidate) =>
          candidate.sourceRegionIds.some((regionId) =>
            bandRegionIds.includes(regionId),
          ),
        ),
      )
      // The six rows must be proved as ONE atomic display-equation component…
      expect(bandRelationships).toHaveLength(1)
      const bandRelationship = bandRelationships[0]!
      expect(bandRelationship).toMatchObject({
        kind: 'equation',
        status: 'matched',
      })
      expect([...(bandRelationship.sourceLineIds ?? [])].sort()).toEqual(
        [...bandLineIds].sort(),
      )
      expect(bandRelationship.evidence).toEqual(
        expect.arrayContaining([
          'source-proved-atomic-equation-component',
          'source-page-crop',
        ]),
      )
      // …with a source-crop rendition…
      expect(bandRelationship.assetIds).toHaveLength(1)
      // …and no band row may leak back into reading-order prose.
      for (const region of bandRegions) {
        if (region.id === bandRelationship.captionRegionId) continue
        expect(
          result.consumedRegionIds.has(region.id) ||
            result.consumedLineIds.has(region.lines[0].id),
        ).toBe(true)
      }
      // The preceding display and the prose cue stay outside the component.
      expect(bandRelationship.sourceRegionIds).not.toContain(
        precedingDisplay.id,
      )
      expect(bandRelationship.sourceRegionIds).not.toContain(leadProse.id)
      expect(result.consumedRegionIds.has(leadProse.id)).toBe(false)
      expect(
        result.relationships.find((relationship) =>
          relationship.candidates.some((candidate) =>
            candidate.sourceRegionIds.includes(precedingDisplay.id),
          ),
        )?.sourceRegionIds,
      ).toEqual([precedingDisplay.id])
    },
  )

  it('does not partially attach a source-sequence owner cluster whose aggregate envelope is out of bounds', async () => {
    const source = equationRegion(
      'owner-cluster-envelope-source',
      's = 1',
      box(0.4, 0.2, 0.2, 0.02),
    )
    const candidate = equationRegion(
      'owner-cluster-envelope-candidate',
      'a = b',
      box(0, 0.201, 0.3, 0.018),
    )
    const owner = equationRegion(
      'owner-cluster-envelope-owner',
      'c = d',
      box(0.7, 0.201, 0.3, 0.018),
    )
    candidate.lines[0].runs[0].sourceSequenceIndex = 10
    owner.lines[0].runs[0].sourceSequenceIndex = 12
    owner.lines[0].runs[0].sourceWhitespaceBefore = 'pdf-text-item'
    owner.lines[0].runs[0].sourceWhitespacePredecessorIndex = 10
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 64,
          height: 16,
          pixels: new Uint8Array(64 * 16 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [source, candidate, owner],
      rasterizeFigure,
    })

    expect(
      result.relationships.find(
        (relationship) => relationship.captionRegionId === source.id,
      )?.sourceRegionIds,
    ).toEqual([source.id])
    expect(result.consumedRegionIds.has(candidate.id)).toBe(false)
  })

  it('keeps a legitimate multi-line display joined when body text is outside its corridor', async () => {
    const first = equationRegion(
      'aligned-equation-with-side-body-first',
      'a + b = c',
      box(0.09, 0.2, 0.3, 0.025),
    )
    const second = equationRegion(
      'aligned-equation-with-side-body-second',
      'd + e = f',
      box(0.09, 0.235, 0.3, 0.025),
    )
    const sideBody = textRegion(
      'body-outside-equation-corridor',
      'Hence:',
      box(0.75, 0.225, 0.08, 0.018),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 80,
          height: 20,
          pixels: new Uint8Array(80 * 20 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [first, sideBody, second],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      sourceRegionIds: [first.id, second.id],
    })
    expect(result.relationships[0].sourceRegionIds).not.toContain(sideBody.id)
  })

  it('attaches a detached math-extension run only to its source-proved host line', async () => {
    const host = equationRegion(
      'source-proved-detached-host',
      '(1-t)/(2 cos θ) + √3t/(2 sin θ) = 1',
      box(0.09, 0.22, 0.3, 0.025),
    )
    host.lines[0].id = 'page-001-inline-stacked-0042-formula'
    const detached = textRegion(
      'source-proved-detached-root',
      '√',
      box(0.15, 0.205, 0.012, 0.009),
      'equation',
    )
    detached.lines[0].id = `page-001-source-line-0041-detached-math-001-host-${encodeURIComponent(host.lines[0].id)}`
    detached.lines[0].runs[0].fontName = 'Synthetic-CMEX10'
    detached.lines[0].runs[0].fontSize = 7
    const cue = textRegion(
      'source-proved-detached-cue',
      'Hence:',
      box(0.09, 0.18, 0.06, 0.014),
    )
    const rasterizeFigure = vi.fn(
      async (input: Parameters<PdfFigureRasterizer>[0]) =>
        createSourcePageCropAsset({
          kind: 'equation',
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 80,
          height: 20,
          pixels: new Uint8Array(80 * 20 * 4).fill(72),
        }),
    )

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [cue, detached, host],
      rasterizeFigure,
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      status: 'matched',
      captionRegionId: host.id,
    })
    expect(new Set(result.relationships[0].sourceRegionIds)).toEqual(
      new Set([host.id, detached.id]),
    )
    expect(new Set(result.relationships[0].sourceLineIds)).toEqual(
      new Set([host.lines[0].id, detached.lines[0].id]),
    )
    expect(result.relationships[0].sourceRegionIds).not.toContain(cue.id)
  })

  it('allows a display region whose detached math-extension host is internal to the same region', async () => {
    const display = equationRegion(
      'self-contained-detached-display',
      '√ x = y',
      box(0.09, 0.22, 0.3, 0.035),
    )
    const hostLine = display.lines[0]
    hostLine.id = 'page-001-source-line-0042'
    hostLine.text = 'x = y'
    hostLine.box = {
      ...hostLine.box,
      x: 0.11,
      y: 0.235,
      width: 0.12,
      height: 0.015,
    }
    hostLine.runs[0] = {
      ...hostLine.runs[0],
      ...hostLine.box,
      text: 'x = y',
      fontName: 'Synthetic-STIXMath-Regular',
    }
    const detachedLine = {
      id: `page-001-source-line-0041-detached-math-001-host-${encodeURIComponent(hostLine.id)}`,
      text: '√',
      fontSize: 8,
      box: {
        ...hostLine.box,
        x: 0.095,
        y: 0.22,
        width: 0.012,
        height: 0.01,
      },
      runs: [
        {
          ...hostLine.runs[0],
          x: 0.095,
          y: 0.22,
          width: 0.012,
          height: 0.01,
          text: '√',
          fontName: 'Synthetic-STIXMathExtensions-Regular',
          fontSize: 8,
        },
      ],
    }
    display.lines = [detachedLine, hostLine]

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [display],
    })

    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0]).toMatchObject({
      kind: 'equation',
      captionRegionId: display.id,
      sourceRegionIds: [display.id],
      sourceLineIds: [detachedLine.id, hostLine.id],
    })
  })

  it('does not seed a display when its detached math-extension host is external', async () => {
    const display = equationRegion(
      'external-detached-display',
      '√ x = y',
      box(0.09, 0.22, 0.3, 0.035),
    )
    const hostLine = display.lines[0]
    hostLine.id = 'page-001-source-line-0042'
    hostLine.text = 'x = y'
    hostLine.runs[0].text = 'x = y'
    hostLine.runs[0].fontName = 'Synthetic-STIXMath-Regular'
    const detachedLine = {
      id: `page-001-source-line-0041-detached-math-001-host-${encodeURIComponent('page-001-source-line-9999')}`,
      text: '√',
      fontSize: 8,
      box: {
        ...hostLine.box,
        x: 0.095,
        y: 0.22,
        width: 0.012,
        height: 0.01,
      },
      runs: [
        {
          ...hostLine.runs[0],
          x: 0.095,
          y: 0.22,
          width: 0.012,
          height: 0.01,
          text: '√',
          fontName: 'Synthetic-STIXMathExtensions-Regular',
          fontSize: 8,
        },
      ],
    }
    display.lines = [detachedLine, hostLine]

    const result = await reconstructPdfVisuals({
      pages: [page([])],
      regions: [display],
    })

    expect(result.relationships).toHaveLength(0)
  })
})

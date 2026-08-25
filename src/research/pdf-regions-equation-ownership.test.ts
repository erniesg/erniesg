import { describe, expect, it, vi } from 'vitest'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { reconstructPageRegions } from './pdf-regions'
import type { PdfFigureRasterizer } from './pdf-visuals'
import { createSourcePageCropAsset } from './visual-assets'

function run(
  page: number,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
  height = 0.018,
): PdfSourceRun {
  return {
    page,
    text,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-text',
    fontName: fontSize > 12 ? 'Heading' : 'Body',
    fontSize,
    confidence: 1,
  }
}

function page(
  number: number,
  runs: PdfSourceRun[],
  objects: NonNullable<PdfPageAnalysis['objects']> = [],
): PdfPageAnalysis {
  return {
    page: number,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: objects.length,
    objects,
    runs,
  }
}

function withExplicitEnglishLanguage(page: PdfPageAnalysis): PdfPageAnalysis {
  return {
    ...page,
    ocr: {
      engine: 'test-language-authority',
      engineVersion: '1',
      model: 'test-en',
      modelVersion: '1',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: '1'.repeat(64),
      rasterSha256: '2'.repeat(64),
      confidence: 1,
      words: [],
      lines: [],
    },
  }
}

describe('deterministic scholarly page regions', () => {
  it('conserves a uniquely hosted detached math-extension run outside its prose cue', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      fontSize = 10,
      height = 0.0126,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
    })
    const cue = sourceRun(
      'Multiply by 2:',
      0.1,
      0.35,
      0.1,
      'Synthetic-STIXGeneral-Regular',
    )
    const detachedRoot = sourceRun(
      '√',
      0.15,
      0.3584,
      0.011,
      'Synthetic-STIXMathExtensions-Regular',
      7.5,
      0.0094,
    )
    const hostNumerator = sourceRun(
      '1',
      0.1,
      0.3675,
      0.008,
      'Synthetic-STIXMath-Regular',
      7,
      0.008,
    )
    const hostDenominator = sourceRun(
      '2',
      0.1,
      0.3795,
      0.008,
      'Synthetic-STIXMath-Regular',
      7,
      0.008,
    )
    const hostBaseline = sourceRun(
      '+ x = 1',
      0.115,
      0.372,
      0.12,
      'Synthetic-STIXMath-Regular',
    )
    const secondCue = sourceRun(
      'Plugging in values:',
      0.1,
      0.5,
      0.13,
      'Synthetic-STIXGeneral-Regular',
    )
    const secondDetachedRoot = sourceRun(
      '√',
      0.15,
      0.5084,
      0.011,
      'Synthetic-STIXMathExtensions-Regular',
      7.5,
      0.0094,
    )
    const secondHostNumerator = sourceRun(
      '3',
      0.1,
      0.5175,
      0.008,
      'Synthetic-STIXMath-Regular',
      7,
      0.008,
    )
    const secondHostDenominator = sourceRun(
      '4',
      0.1,
      0.5295,
      0.008,
      'Synthetic-STIXMath-Regular',
      7,
      0.008,
    )
    const secondHostBaseline = sourceRun(
      '+ y = 2',
      0.115,
      0.522,
      0.12,
      'Synthetic-STIXMath-Regular',
    )
    const sourcePage = page(1, [
      run(1, 'Ordinary prose establishes the body font.', 0.1, 0.18, 0.5),
      run(1, 'A second ordinary prose line remains intact.', 0.1, 0.21, 0.5),
      cue,
      detachedRoot,
      hostNumerator,
      hostDenominator,
      hostBaseline,
      secondCue,
      secondDetachedRoot,
      secondHostNumerator,
      secondHostDenominator,
      secondHostBaseline,
    ])

    const result = reconstructPageRegions([sourcePage])
    const replay = reconstructPageRegions([sourcePage])
    const shuffled = reconstructPageRegions([
      { ...sourcePage, runs: [...sourcePage.runs].reverse() },
    ])
    const cueRegion = result.regions.find((region) =>
      region.text.includes('Multiply by 2:'),
    )
    const detachedLines = result.regions
      .flatMap((region) => region.lines)
      .filter((line) => /-detached-math-\d+-host-/u.test(line.id))
    const detachedLine = detachedLines[0]
    const sourceRunKey = (candidate: PdfSourceRun) =>
      [
        candidate.text,
        candidate.x,
        candidate.y,
        candidate.width,
        candidate.height,
        candidate.fontName,
        candidate.fontSize,
      ].join('\u001f')
    const expectedRunLedger = [
      cue,
      detachedRoot,
      hostNumerator,
      hostDenominator,
      hostBaseline,
      secondCue,
      secondDetachedRoot,
      secondHostNumerator,
      secondHostDenominator,
      secondHostBaseline,
    ]
      .map(sourceRunKey)
      .sort()
    const actualRunLedger = result.regions
      .flatMap((region) => region.lines)
      .flatMap((line) => line.runs)
      .filter((candidate) =>
        [
          cue,
          detachedRoot,
          hostNumerator,
          hostDenominator,
          hostBaseline,
          secondCue,
          secondDetachedRoot,
          secondHostNumerator,
          secondHostDenominator,
          secondHostBaseline,
        ]
          .map(sourceRunKey)
          .includes(sourceRunKey(candidate)),
      )
      .map(sourceRunKey)
      .sort()

    expect(cueRegion).toMatchObject({
      kind: 'body',
      text: 'Multiply by 2:',
    })
    expect(cueRegion?.text).not.toContain('√')
    expect(detachedLines).toHaveLength(2)
    expect(new Set(detachedLines.map((line) => line.id)).size).toBe(2)
    expect(detachedLines.every((line) => !line.id.includes('undefined'))).toBe(
      true,
    )
    expect(detachedLine).toMatchObject({ text: '√' })
    expect(
      result.regions.find((region) =>
        region.lines.some((line) => line.id === detachedLine?.id),
      ),
    ).toMatchObject({ kind: 'equation' })
    expect(actualRunLedger).toEqual(expectedRunLedger)
    expect(new Set(actualRunLedger).size).toBe(expectedRunLedger.length)
    expect(result.regions.map((region) => region.id)).toEqual(
      replay.regions.map((region) => region.id),
    )
    expect(
      result.regions.map(({ id, kind, text }) => ({ id, kind, text })),
    ).toEqual(
      shuffled.regions.map(({ id, kind, text }) => ({ id, kind, text })),
    )
    expect(result.readingOrder.order.indexOf(cueRegion!.id)).toBeLessThan(
      result.readingOrder.order.indexOf(
        result.regions.find((region) =>
          region.lines.some((line) => line.id === detachedLine?.id),
        )!.id,
      ),
    )
  })

  it('links an extension-only radical to its exact next-sequence radicand on a different source line', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      sourceSequenceIndex: number,
      fontSize = 7.47,
      height = 0.009434,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
      sourceSequenceIndex,
    })
    const root = sourceRun(
      '√',
      0.2,
      0.3,
      0.01133,
      'Synthetic-STIXMathExtensions-Regular',
      100,
    )
    const radicand = sourceRun(
      '3',
      0.2113308,
      0.3091086,
      0.0061,
      'Synthetic-STIXMath-Regular',
      101,
    )
    const hostProse = sourceRun(
      'is the exact radicand on its prose-dominant source line.',
      0.225,
      0.3091086,
      0.55,
      'Synthetic-STIXGeneral-Regular',
      102,
      10,
      0.0126,
    )
    const sourcePage = page(1, [
      run(1, 'Ordinary prose establishes the body font.', 0.1, 0.18, 0.5),
      run(1, 'A second ordinary prose line remains intact.', 0.1, 0.21, 0.5),
      root,
      radicand,
      hostProse,
    ])

    const result = reconstructPageRegions([sourcePage])
    const replay = reconstructPageRegions([
      { ...sourcePage, runs: [...sourcePage.runs].reverse() },
    ])
    const allLines = result.regions.flatMap((region) => region.lines)
    const hostLine = allLines.find((line) =>
      line.runs.some((candidate) => candidate.sourceSequenceIndex === 101),
    )
    const detachedRootLine = allLines.find((line) =>
      line.runs.some((candidate) => candidate.sourceSequenceIndex === 100),
    )

    expect(hostLine?.text).toContain('exact radicand')
    expect(detachedRootLine).toMatchObject({ text: '√' })
    expect(detachedRootLine?.id).toMatch(
      new RegExp(
        `^page-001-source-line-\\d+-detached-math-001-host-${encodeURIComponent(
          hostLine!.id,
        )}$`,
        'u',
      ),
    )
    expect(detachedRootLine?.id).not.toContain('host-ambiguous')
    expect(
      allLines
        .flatMap((line) => line.runs)
        .filter((candidate) => candidate.sourceSequenceIndex === 100),
    ).toHaveLength(1)
    expect(
      result.regions.find((region) =>
        region.lines.some((line) => line.id === detachedRootLine?.id),
      ),
    ).toMatchObject({ kind: 'equation' })
    expect(
      replay.regions
        .flatMap((region) => region.lines)
        .find((line) =>
          line.runs.some((candidate) => candidate.sourceSequenceIndex === 100),
        )?.id,
    ).toBe(detachedRootLine?.id)
  })

  it('links an exact next-sequence radical even when its prose-line font size and baseline are not detached', () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      sourceSequenceIndex: number,
      fontSize = 10,
      height = 0.0126,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
      sourceSequenceIndex,
    })
    const cue = sourceRun(
      'Therefore:',
      0.1,
      0.35,
      0.09,
      'Synthetic-STIXGeneral-Regular',
      200,
    )
    const root = sourceRun(
      '√',
      0.19,
      0.35,
      0.011,
      'Synthetic-STIXMathExtensions-Regular',
      201,
    )
    const radicand = sourceRun(
      '3',
      0.2010008,
      0.3622,
      0.006,
      'Synthetic-STIXMath-Regular',
      202,
      10,
      0.0126,
    )
    const hostProse = sourceRun(
      'continues on the proved host line.',
      0.215,
      0.3622,
      0.36,
      'Synthetic-STIXGeneral-Regular',
      203,
    )
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Ordinary prose establishes the body font.', 0.1, 0.18, 0.5),
        run(1, 'A second ordinary prose line remains intact.', 0.1, 0.21, 0.5),
        cue,
        root,
        radicand,
        hostProse,
      ]),
    ])
    const allLines = result.regions.flatMap((region) => region.lines)
    const cueLine = allLines.find((line) =>
      line.runs.some((candidate) => candidate.sourceSequenceIndex === 200),
    )
    const hostLine = allLines.find((line) =>
      line.runs.some((candidate) => candidate.sourceSequenceIndex === 202),
    )
    const rootLine = allLines.find((line) =>
      line.runs.some((candidate) => candidate.sourceSequenceIndex === 201),
    )

    expect(cueLine).toMatchObject({ text: 'Therefore:' })
    expect(cueLine?.runs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceSequenceIndex: 201 }),
      ]),
    )
    expect(rootLine).toMatchObject({ text: '√' })
    expect(rootLine?.id).toContain(`-host-${encodeURIComponent(hostLine!.id)}`)
  })

  it.each([
    {
      name: 'nonconsecutive source sequence',
      candidateSequenceIndex: 12,
      candidateX: 0.2113308,
      candidateY: 0.3091086,
      candidateFont: 'Synthetic-STIXMath-Regular',
      duplicate: false,
    },
    {
      name: 'material horizontal gap',
      candidateSequenceIndex: 11,
      candidateX: 0.21333,
      candidateY: 0.3091086,
      candidateFont: 'Synthetic-STIXMath-Regular',
      duplicate: false,
    },
    {
      name: 'prose-font neighbor',
      candidateSequenceIndex: 11,
      candidateX: 0.2113308,
      candidateY: 0.3091086,
      candidateFont: 'Synthetic-STIXGeneral-Regular',
      duplicate: false,
    },
    {
      name: 'duplicate next-sequence candidates',
      candidateSequenceIndex: 11,
      candidateX: 0.2113308,
      candidateY: 0.3091086,
      candidateFont: 'Synthetic-STIXMath-Regular',
      duplicate: true,
    },
    {
      name: 'same-line ordinary radical',
      candidateSequenceIndex: 11,
      candidateX: 0.2113308,
      candidateY: 0.3,
      candidateFont: 'Synthetic-STIXMath-Regular',
      duplicate: false,
    },
  ])(
    'does not link an extension-only radical for a $name',
    ({
      candidateSequenceIndex,
      candidateX,
      candidateY,
      candidateFont,
      duplicate,
    }) => {
      const sourceRun = (
        text: string,
        x: number,
        y: number,
        width: number,
        fontName: string,
        sourceSequenceIndex: number,
      ) => ({
        ...run(1, text, x, y, width, 7.47, 0.009434),
        fontName,
        sourceSequenceIndex,
      })
      const root = sourceRun(
        '√',
        0.2,
        0.3,
        0.01133,
        'Synthetic-STIXMathExtensions-Regular',
        10,
      )
      const candidate = sourceRun(
        '3',
        candidateX,
        candidateY,
        0.0061,
        candidateFont,
        candidateSequenceIndex,
      )
      const candidates = duplicate
        ? [
            candidate,
            sourceRun(
              '5',
              candidateX,
              candidateY,
              0.0061,
              candidateFont,
              candidateSequenceIndex,
            ),
          ]
        : [candidate]
      const result = reconstructPageRegions([
        page(1, [
          run(1, 'Ordinary prose establishes the body font.', 0.1, 0.18, 0.5),
          run(
            1,
            'A second ordinary prose line remains intact.',
            0.1,
            0.21,
            0.5,
          ),
          root,
          ...candidates,
        ]),
      ])
      const rootLine = result.regions
        .flatMap((region) => region.lines)
        .find((line) =>
          line.runs.some(
            (runCandidate) => runCandidate.sourceSequenceIndex === 10,
          ),
        )

      expect(rootLine).toBeDefined()
      expect(rootLine!.id).not.toMatch(/-detached-math-\d+-host-(?!ambiguous)/u)
      expect(
        result.regions
          .flatMap((region) => region.lines)
          .flatMap((line) => line.runs)
          .filter((runCandidate) => runCandidate.sourceSequenceIndex === 10),
      ).toHaveLength(1)
    },
  )

  it('does not guess ownership for an equal-distance detached math-extension run', async () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      fontSize = 10,
      height = 0.012,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
    })
    const sourcePage = page(1, [
      run(1, 'Ordinary prose establishes the body font.', 0.1, 0.18, 0.5),
      run(1, 'A second ordinary prose line remains intact.', 0.1, 0.21, 0.5),
      sourceRun('1', 0.1, 0.368, 0.008, 'Synthetic-STIXMath-Regular', 7, 0.008),
      sourceRun('2', 0.1, 0.38, 0.008, 'Synthetic-STIXMath-Regular', 7, 0.008),
      sourceRun('+ a = c', 0.115, 0.374, 0.12, 'Synthetic-STIXMath-Regular'),
      sourceRun('Hence:', 0.1, 0.392, 0.06, 'Synthetic-STIXGeneral-Regular'),
      sourceRun(
        '√',
        0.13,
        0.4,
        0.01,
        'Synthetic-STIXMathExtensions-Regular',
        7.5,
        0.008,
      ),
      sourceRun('3', 0.1, 0.42, 0.008, 'Synthetic-STIXMath-Regular', 7, 0.008),
      sourceRun('4', 0.1, 0.432, 0.008, 'Synthetic-STIXMath-Regular', 7, 0.008),
      sourceRun('+ d = f', 0.115, 0.426, 0.12, 'Synthetic-STIXMath-Regular'),
    ])

    const result = reconstructPageRegions([sourcePage])
    const cueRegion = result.regions.find((region) =>
      region.text.includes('Hence:'),
    )

    expect(cueRegion).toMatchObject({ kind: 'body' })
    expect(cueRegion?.text).toBe('Hence:')
    const ambiguousRootRegion = result.regions.find((region) =>
      region.lines.some((line) =>
        /-detached-math-\d+-host-ambiguous$/u.test(line.id),
      ),
    )
    expect(ambiguousRootRegion).toMatchObject({
      kind: 'equation',
      text: '√',
    })
    expect(
      result.regions
        .flatMap((region) => region.lines)
        .flatMap((line) => line.runs)
        .filter((candidate) => candidate.text === '√'),
    ).toHaveLength(1)

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
    const reconstructed = await reconstructPageAnalyses({
      pages: [sourcePage],
      sourceHash: '8'.repeat(64),
      fileName: 'ambiguous-detached-host.pdf',
      byteLength: 2048,
      rasterizeFigure,
    })
    const ambiguousRelationship = reconstructed.visualRelationships.find(
      (relationship) =>
        relationship.kind === 'equation' &&
        (relationship.sourceLineIds ?? []).some((lineId) =>
          /-detached-math-\d+-host-ambiguous$/u.test(lineId),
        ),
    )
    expect(ambiguousRelationship).toMatchObject({
      status: 'unresolved',
    })
    expect(ambiguousRelationship?.evidence).toContain(
      'unresolved-detached-math-host',
    )
    expect(ambiguousRelationship?.assetIds).toEqual([])
  })

  it('keeps a hyphenated prose word intact around an interleaved summation crop', async () => {
    const sourceRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      fontSize = 10,
      height = 0.014,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
    })
    const sourcePage = page(1, [
      run(1, 'Left column establishes its first line.', 0.1, 0.2, 0.36),
      run(1, 'Right column establishes its first line.', 0.52, 0.2, 0.36),
      run(1, 'Left column establishes its second line.', 0.1, 0.24, 0.36),
      run(1, 'Right column establishes its second line.', 0.52, 0.24, 0.36),
      run(1, 'Left column establishes its third line.', 0.1, 0.28, 0.36),
      run(1, 'Right column establishes its third line.', 0.52, 0.28, 0.36),
      run(
        1,
        'An earlier baseline is optimal for another option.',
        0.52,
        0.32,
        0.36,
      ),
      sourceRun(
        'A method selects the option that opti-',
        0.502,
        0.5687,
        0.385,
        'Subset+NimbusRomNo9L-Regu',
        9.9626,
        0.01258,
      ),
      sourceRun('a', 0.6094, 0.59071, 0.00706, 'Subset+CMMI7', 6.9738, 0.00881),
      sourceRun(
        'l',
        0.60985,
        0.58303,
        0.00412,
        'Subset+CMMI7',
        6.9738,
        0.00881,
      ),
      sourceRun(
        'LD',
        0.58484,
        0.58383,
        0.02456,
        'Subset+CMMI10',
        9.9626,
        0.01258,
      ),
      sourceRun(
        '∑',
        0.55995,
        0.57439,
        0.01718,
        'Subset+CMEX10',
        9.9626,
        0.01258,
      ),
      sourceRun(
        'mizes',
        0.50235,
        0.58383,
        0.03798,
        'Subset+NimbusRomNo9L-Regu',
        9.9626,
        0.01258,
      ),
      sourceRun(
        'L',
        0.54635,
        0.59194,
        0.00893,
        'Subset+CMMI7',
        6.9738,
        0.00881,
      ),
      sourceRun('1', 0.54758, 0.58265, 0.00649, 'Subset+CMR7', 6.9738, 0.00881),
      sourceRun(
        'l',
        0.57714,
        0.59137,
        0.00412,
        'Subset+CMMI7',
        6.9738,
        0.00881,
      ),
      sourceRun(
        'as the objective.',
        0.6213,
        0.5838,
        0.14,
        'Subset+NimbusRomNo9L-Regu',
        9.9626,
        0.01258,
      ),
      run(1, 'Following prose remains readable.', 0.502, 0.61, 0.28),
    ])
    const regional = reconstructPageRegions([sourcePage])
    const formula = regional.regions.find(
      (region) =>
        region.kind === 'equation' &&
        region.lines.some((line) =>
          line.runs.some((source) => source.text === '∑'),
        ),
    )
    const formulaRunTexts =
      formula?.lines.flatMap((line) =>
        line.runs.map((source) => source.text),
      ) ?? []

    expect(formulaRunTexts).toEqual(
      expect.arrayContaining(['L', '1', '∑', 'l', 'LD', 'l', 'a']),
    )
    expect(formulaRunTexts).not.toEqual(
      expect.arrayContaining(['mizes', 'as the objective.']),
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
    const reconstructed = await reconstructPageAnalyses({
      pages: [withExplicitEnglishLanguage(sourcePage)],
      sourceHash: '7'.repeat(64),
      fileName: 'regions.pdf',
      byteLength: 4096,
      rasterizeFigure,
    })
    expect(rasterizeFigure).not.toHaveBeenCalled()
    expect(reconstructed.visualRelationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'equation',
          status: 'unresolved',
          evidence: expect.arrayContaining([
            'overlapping-unowned-source-text',
            'source-rendition-unavailable',
          ]),
        }),
      ]),
    )
    const targetParagraphIndex = reconstructed.paper.nodes.findIndex(
      (node) =>
        node.type === 'paragraph' &&
        node.text.includes('A method selects the option'),
    )
    const formulaNodeIndex = reconstructed.paper.nodes.findIndex(
      (node) =>
        'text' in node &&
        typeof node.text === 'string' &&
        node.text.includes('∑'),
    )
    const targetParagraph = reconstructed.paper.nodes[targetParagraphIndex]
    const canonicalTextSequence = reconstructed.paper.nodes
      .flatMap((node) =>
        'text' in node && typeof node.text === 'string' ? [node.text] : [],
      )
      .join('\n')

    expect(targetParagraph).toMatchObject({
      type: 'paragraph',
      text: expect.stringContaining('option that opti-mizes'),
    })
    expect(
      'text' in targetParagraph && typeof targetParagraph.text === 'string'
        ? targetParagraph.text
        : '',
    ).not.toContain('opti- mizes')
    expect(reconstructed.lineBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: 'unresolved',
          evidence: expect.arrayContaining([
            'source-proven-wrapped-line-boundary',
            'joined-form-valid:pinned-lexicon',
            'split-point-valid:pinned-hyphenation-pattern',
          ]),
        }),
      ]),
    )
    expect(formulaNodeIndex).toBeGreaterThan(targetParagraphIndex)
    expect(canonicalTextSequence).toContain('∑')
    expect(
      reconstructed.provenance[reconstructed.paper.nodes[formulaNodeIndex].id]
        ?.boxes.length,
    ).toBeGreaterThan(0)
    expect(canonicalTextSequence.indexOf('opti-mizes')).toBeLessThan(
      canonicalTextSequence.indexOf('∑'),
    )
    expect(canonicalTextSequence.indexOf('∑')).toBeLessThan(
      canonicalTextSequence.indexOf('as the objective.'),
    )
  })
})

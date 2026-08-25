import { describe, expect, it } from 'vitest'

import type {
  PdfCanonicalHyphenBoundaryDecision,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSourceSemanticFlowBoundaryDecision,
  PdfSourceRun,
} from './import-types'
import {
  mergeProseContinuations,
  reconstructPageAnalyses,
  sourceProvenRunFragmentToSpanBoundary,
} from './pdf-layout'
import { pdfBodySourceOrderExtremaByPage } from './pdf-regions'

function run(
  page: number,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
): PdfSourceRun {
  return {
    page,
    text,
    x,
    y,
    width,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
    fontName: fontSize > 12 ? 'Heading' : 'Body',
    fontSize,
    confidence: 1,
  }
}

function sourceFlowRegion({
  id,
  column,
  text,
  x,
  y,
  sourceSequenceIndex,
  whitespaceBefore,
}: {
  id: string
  column: 'left' | 'right'
  text: string
  x: number
  y: number
  sourceSequenceIndex: number
  whitespaceBefore?: number
}): PdfPageRegion {
  const sourceRun: PdfSourceRun =
    whitespaceBefore === undefined
      ? {
          ...run(1, text, x, y, 0.385),
          sourceSequenceIndex,
        }
      : {
          ...run(1, text, x, y, 0.385),
          sourceSequenceIndex,
          sourceWhitespaceBefore: 'pdf-text-item',
          sourceWhitespacePredecessorIndex: whitespaceBefore,
        }
  return {
    id,
    page: 1,
    kind: 'body',
    column,
    text,
    confidence: 1,
    box: { ...sourceRun },
    lines: [
      {
        id: `${id}-line`,
        text,
        fontSize: sourceRun.fontSize,
        box: { ...sourceRun },
        runs: [sourceRun],
        sourceFragmentLineage: {
          algorithm: 'source-run-fragment-v1',
          sourceLineId: `${id}-source-line`,
          fragment: 'whole',
          sourceSequenceIndexes: [sourceSequenceIndex],
        },
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

function page(
  number: number,
  runs: PdfSourceRun[],
  kind: PdfPageAnalysis['kind'] = 'born-digital',
): PdfPageAnalysis {
  return {
    page: number,
    kind,
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: kind === 'born-digital' ? 0 : 1,
    runs,
  }
}

function ocrPage(
  text: string,
  languages: string[],
  languageMode: 'explicit' | 'automatic-fallback' = 'explicit',
) {
  const sourceRun = {
    ...run(1, text, 0.1, 0.2, 0.75),
    method: 'ocr' as const,
  }
  const result = page(1, [sourceRun], 'ocr-complete')
  result.ocr = {
    engine: 'test-local-ocr',
    engineVersion: '1.0.0',
    model: 'test-language-model',
    modelVersion: '1.0.0',
    languages,
    languageMode,
    sourceSha256: 'a'.repeat(64),
    rasterSha256: 'b'.repeat(64),
    confidence: 1,
    words: [],
    lines: [
      {
        id: 'ocr-line-1',
        text,
        confidence: 1,
        box: sourceRun,
      },
    ],
  }
  return result
}

describe('PDF semantic reconstruction', () => {
  it('proves a run-backed cross-gutter right fragment continuing into the next span', () => {
    const rightRun = {
      ...run(1, 'the right fragment continues', 0.54, 0.4, 0.34),
      sourceSequenceIndex: 70,
    }
    const spanRun = {
      ...run(1, 'on the next spanning source line.', 0.1, 0.43, 0.8),
      sourceSequenceIndex: 71,
      sourceWhitespaceBefore: 'pdf-text-item' as const,
      sourceWhitespacePredecessorIndex: 70,
    }
    const region = (
      id: string,
      column: PdfPageRegion['column'],
      sourceRun: PdfSourceRun,
      lineage: NonNullable<
        PdfPageRegion['lines'][number]['sourceFragmentLineage']
      >,
    ): PdfPageRegion => ({
      id,
      page: 1,
      kind: column === 'span' ? 'spanning' : 'body',
      column,
      text: sourceRun.text,
      confidence: 1,
      box: { ...sourceRun },
      lines: [
        {
          id: `${id}-line`,
          text: sourceRun.text,
          fontSize: sourceRun.fontSize,
          box: { ...sourceRun },
          runs: [{ ...sourceRun }],
          sourceFragmentLineage: lineage,
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })
    const right = region('cross-gutter-right-region', 'right', rightRun, {
      algorithm: 'source-run-fragment-v1',
      sourceLineId: 'cross-gutter-source-line',
      fragment: 'cross-gutter-right',
      sourceSequenceIndexes: [70],
    })
    const span = region('cross-gutter-span-region', 'span', spanRun, {
      algorithm: 'source-run-fragment-v1',
      sourceLineId: 'next-span-source-line',
      fragment: 'whole',
      sourceSequenceIndexes: [71],
    })

    expect(sourceProvenRunFragmentToSpanBoundary(right, span)).toBe(true)
  })

  it('joins a source-adjacent sentence across the bottom-to-top column boundary', async () => {
    const makeRegion = (
      id: string,
      column: 'left' | 'right',
      text: string,
      x: number,
      y: number,
      sourceSequenceIndex: number,
      whitespaceBefore?: number,
    ): PdfPageRegion => {
      const sourceRun: PdfSourceRun =
        whitespaceBefore === undefined
          ? {
              ...run(1, text, x, y, 0.385),
              sourceSequenceIndex,
            }
          : {
              ...run(1, text, x, y, 0.385),
              sourceSequenceIndex,
              sourceWhitespaceBefore: 'pdf-text-item',
              sourceWhitespacePredecessorIndex: whitespaceBefore,
            }
      return {
        id,
        page: 1,
        kind: 'body',
        column,
        text,
        confidence: 1,
        box: { ...sourceRun },
        lines: [
          {
            id: `${id}-line`,
            text,
            fontSize: sourceRun.fontSize,
            box: { ...sourceRun },
            runs: [sourceRun],
            sourceFragmentLineage: {
              algorithm: 'source-run-fragment-v1',
              sourceLineId: `${id}-source-line`,
              fragment: 'whole',
              sourceSequenceIndexes: [sourceSequenceIndex],
            },
          },
        ],
        nativeObjectIds: [],
        includedInReadingOrder: true,
      }
    }
    const target = makeRegion(
      'column-flow-target',
      'left',
      'The sentence continues toward the',
      0.09,
      0.82,
      100,
    )
    const continuation = makeRegion(
      'column-flow-continuation',
      'right',
      'next column boundary with source proof.',
      0.515,
      0.1,
      101,
      100,
    )
    const blocks = [target, continuation].map((region) => ({
      type: 'paragraph' as const,
      region,
      text: region.text,
      confidence: 1,
    }))
    const sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[] =
      []

    await mergeProseContinuations(blocks, {
      sourceSemanticFlowBoundaryDecisions,
    })

    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe(
      'The sentence continues toward the next column boundary with source proof.',
    )
    expect(sourceSemanticFlowBoundaryDecisions).toHaveLength(1)
    expect(sourceSemanticFlowBoundaryDecisions[0]).toMatchObject({
      topology: 'same-page-column',
      outcome: 'space',
      evidence: expect.arrayContaining([
        'exact-source-sequence-adjacency',
        'same-page-column-flow',
      ]),
    })
    expect(sourceSemanticFlowBoundaryDecisions[0].evidence).toContain(
      'same-page-column-geometry',
    )
    expect(sourceSemanticFlowBoundaryDecisions[0].evidence).not.toContain(
      'font-baseline-compatible',
    )
  })

  it('joins an uncased-script sentence across the bottom-to-top column boundary', async () => {
    const makeRegion = (
      id: string,
      column: 'left' | 'right',
      text: string,
      x: number,
      y: number,
      sourceSequenceIndex: number,
      whitespaceBefore?: number,
    ): PdfPageRegion => {
      const sourceRun: PdfSourceRun =
        whitespaceBefore === undefined
          ? {
              ...run(1, text, x, y, 0.385),
              sourceSequenceIndex,
            }
          : {
              ...run(1, text, x, y, 0.385),
              sourceSequenceIndex,
              sourceWhitespaceBefore: 'pdf-text-item',
              sourceWhitespacePredecessorIndex: whitespaceBefore,
            }
      return {
        id,
        page: 1,
        kind: 'body',
        column,
        text,
        confidence: 1,
        box: { ...sourceRun },
        lines: [
          {
            id: `${id}-line`,
            text,
            fontSize: sourceRun.fontSize,
            box: { ...sourceRun },
            runs: [sourceRun],
            sourceFragmentLineage: {
              algorithm: 'source-run-fragment-v1',
              sourceLineId: `${id}-source-line`,
              fragment: 'whole',
              sourceSequenceIndexes: [sourceSequenceIndex],
            },
          },
        ],
        nativeObjectIds: [],
        includedInReadingOrder: true,
      }
    }
    const target = makeRegion(
      'uncased-column-flow-target',
      'left',
      'البيانات تستمر نحو',
      0.09,
      0.82,
      200,
    )
    const continuation = makeRegion(
      'uncased-column-flow-continuation',
      'right',
      'العلمية في العمود التالي',
      0.515,
      0.1,
      201,
      200,
    )
    const blocks = [target, continuation].map((region) => ({
      type: 'paragraph' as const,
      region,
      text: region.text,
      confidence: 1,
    }))
    const sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[] =
      []

    await mergeProseContinuations(blocks, {
      sourceSemanticFlowBoundaryDecisions,
    })

    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('البيانات تستمر نحو العلمية في العمود التالي')
    expect(sourceSemanticFlowBoundaryDecisions).toHaveLength(1)
  })

  it.each(['。', '！', '？', '؟', '۔'])(
    'does not join uncased text after the Unicode sentence terminator %s',
    async (terminator) => {
      const target = sourceFlowRegion({
        id: `unicode-terminal-target-${terminator}`,
        column: 'left',
        text: `研究結果${terminator}`,
        x: 0.09,
        y: 0.82,
        sourceSequenceIndex: 300,
      })
      const continuation = sourceFlowRegion({
        id: `unicode-terminal-continuation-${terminator}`,
        column: 'right',
        text: '次の段落が始まる',
        x: 0.515,
        y: 0.1,
        sourceSequenceIndex: 301,
        whitespaceBefore: 300,
      })
      const blocks = [target, continuation].map((region) => ({
        type: 'paragraph' as const,
        region,
        text: region.text,
        confidence: 1,
      }))

      await mergeProseContinuations(blocks, {
        sourceSemanticFlowBoundaryDecisions: [],
      })

      expect(blocks).toHaveLength(2)
    },
  )

  it('joins a Chinese column continuation without inventing a source space', async () => {
    const target = sourceFlowRegion({
      id: 'cjk-column-flow-target',
      column: 'left',
      text: '研究结果继续',
      x: 0.09,
      y: 0.82,
      sourceSequenceIndex: 500,
    })
    const continuation = sourceFlowRegion({
      id: 'cjk-column-flow-continuation',
      column: 'right',
      text: '在下一栏完成',
      x: 0.515,
      y: 0.1,
      sourceSequenceIndex: 501,
    })
    const blocks = [target, continuation].map((region) => ({
      type: 'paragraph' as const,
      region,
      text: region.text,
      confidence: 1,
    }))
    const sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[] =
      []

    await mergeProseContinuations(blocks, {
      language: 'zh',
      sourceSemanticFlowBoundaryDecisions,
    })

    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('研究结果继续在下一栏完成')
    expect(sourceSemanticFlowBoundaryDecisions).toHaveLength(1)
    expect(sourceSemanticFlowBoundaryDecisions[0]).toMatchObject({
      topology: 'same-page-column',
      outcome: 'no-space',
      evidence: expect.arrayContaining([
        'exact-source-sequence-adjacency',
        'same-page-column-flow',
      ]),
    })
  })

  describe('cross-page prose continuity', () => {
    const onPage = (region: PdfPageRegion, page: number): PdfPageRegion => ({
      ...region,
      page,
      box: { ...region.box, page },
      lines: region.lines.map((line) => ({
        ...line,
        box: { ...line.box, page },
        runs: line.runs.map((sourceRun) => ({ ...sourceRun, page })),
      })),
    })
    const pageBreakPair = (label: string, tailSequence = 40) => ({
      target: onPage(
        sourceFlowRegion({
          id: `${label}-target`,
          column: 'right',
          text: 'The measured drift therefore continues toward the',
          x: 0.515,
          y: 0.82,
          sourceSequenceIndex: tailSequence,
        }),
        1,
      ),
      continuation: onPage(
        sourceFlowRegion({
          id: `${label}-continuation`,
          column: 'left',
          text: 'stationary regime described in the next section.',
          x: 0.09,
          y: 0.1,
          sourceSequenceIndex: 1,
        }),
        2,
      ),
    })
    const runningHead = (label: string) =>
      onPage(
        sourceFlowRegion({
          id: `${label}-running-head`,
          column: 'left',
          text: 'Continuous prose reconstruction',
          x: 0.09,
          y: 0.03,
          sourceSequenceIndex: 0,
        }),
        2,
      )
    const asFurniture = (region: PdfPageRegion): PdfPageRegion => ({
      ...region,
      column: 'span',
      furniture: {
        classification: 'repeated-text',
        band: 'top',
        pages: [1, 2],
        boxes: [{ ...region.box }],
        evidence: ['repeated-normalized-text'],
      },
    })
    const joinAcrossPageBreak = async (
      target: PdfPageRegion,
      continuation: PdfPageRegion,
      sourceRegions: PdfPageRegion[],
      options: {
        hardHyphenLexicon?: ReadonlySet<string>
        unhyphenatedLexicon?: ReadonlySet<string>
      } = {},
    ) => {
      const blocks = [target, continuation].map((region) => ({
        type: 'paragraph' as const,
        region,
        text: region.text,
        confidence: 1,
      }))
      const sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[] =
        []
      await mergeProseContinuations(blocks, {
        ...options,
        sourceSemanticFlowBoundaryDecisions,
        bodySourceOrderExtremaByPage:
          pdfBodySourceOrderExtremaByPage(sourceRegions),
      })
      return { blocks, sourceSemanticFlowBoundaryDecisions }
    }

    it('records a proven page-break join in the semantic-flow ledger', async () => {
      const { target, continuation } = pageBreakPair('proven-page-break')
      const { blocks, sourceSemanticFlowBoundaryDecisions } =
        await joinAcrossPageBreak(target, continuation, [target, continuation])

      expect(blocks).toHaveLength(1)
      expect(blocks[0].text).toBe(
        'The measured drift therefore continues toward the stationary regime described in the next section.',
      )
      expect(sourceSemanticFlowBoundaryDecisions).toHaveLength(1)
      expect(sourceSemanticFlowBoundaryDecisions[0]).toMatchObject({
        page: 1,
        topology: 'cross-page-column',
        outcome: 'space',
        evidence: [
          'cross-page-column-geometry',
          'explicit-fragment-lineage',
          'non-prose-excluded-page-boundary',
          'page-head-source-order-extremum',
          'page-tail-source-order-extremum',
        ],
      })
    })

    it('keeps an intervening running head out of the joined paragraph', async () => {
      // Issue 042 classifies the running head as furniture, so it is not body
      // source order. The sentence therefore stays adjacent across the page
      // break and the head never enters the paragraph.
      const { target, continuation } = pageBreakPair('furniture-page-break')
      const head = runningHead('furniture-page-break')
      const { blocks, sourceSemanticFlowBoundaryDecisions } =
        await joinAcrossPageBreak(target, continuation, [
          target,
          asFurniture(head),
          continuation,
        ])

      expect(blocks).toHaveLength(1)
      expect(blocks[0].text).not.toContain('Continuous prose reconstruction')
      expect(sourceSemanticFlowBoundaryDecisions).toHaveLength(1)
      expect(sourceSemanticFlowBoundaryDecisions[0].topology).toBe(
        'cross-page-column',
      )
    })

    it('refuses to prove a page-break join across unaccounted source text', async () => {
      // The same page-two text, this time with no furniture evidence, is body
      // source order the sentence would have to jump over. With no validated
      // boundary record, the weaker unmarked-continuation heuristic must not
      // mutate the paragraph topology.
      const { target, continuation } = pageBreakPair('unaccounted-page-break')
      const head = runningHead('unaccounted-page-break')
      const { blocks, sourceSemanticFlowBoundaryDecisions } =
        await joinAcrossPageBreak(target, continuation, [
          target,
          head,
          continuation,
        ])

      expect(blocks).toHaveLength(2)
      expect(blocks.map((block) => block.text)).toEqual([
        target.text,
        continuation.text,
      ])
      expect(sourceSemanticFlowBoundaryDecisions).toHaveLength(0)
    })

    it('records a source-proven citation-year page break in the semantic-flow ledger', async () => {
      const target = onPage(
        sourceFlowRegion({
          id: 'citation-page-break-target',
          column: 'right',
          text: 'Prior evidence from Okafor et al.,',
          x: 0.515,
          y: 0.82,
          sourceSequenceIndex: 40,
        }),
        1,
      )
      const continuation = onPage(
        sourceFlowRegion({
          id: 'citation-page-break-continuation',
          column: 'left',
          text: '2022) supports the source-backed result.',
          x: 0.09,
          y: 0.1,
          sourceSequenceIndex: 0,
        }),
        2,
      )
      const { blocks, sourceSemanticFlowBoundaryDecisions } =
        await joinAcrossPageBreak(target, continuation, [target, continuation])

      expect(blocks).toHaveLength(1)
      expect(sourceSemanticFlowBoundaryDecisions).toEqual([
        expect.objectContaining({
          topology: 'cross-page-column',
          outcome: 'space',
          from: expect.objectContaining({ regionId: target.id }),
          to: expect.objectContaining({ regionId: continuation.id }),
        }),
      ])
    })

    it('records a source-proven hard hyphen page break in the semantic-flow ledger', async () => {
      const target = onPage(
        sourceFlowRegion({
          id: 'hard-hyphen-page-break-target',
          column: 'right',
          text: 'The source uses long-',
          x: 0.515,
          y: 0.82,
          sourceSequenceIndex: 40,
        }),
        1,
      )
      const continuation = onPage(
        sourceFlowRegion({
          id: 'hard-hyphen-page-break-continuation',
          column: 'left',
          text: 'form examples throughout the evaluation.',
          x: 0.09,
          y: 0.1,
          sourceSequenceIndex: 0,
        }),
        2,
      )
      const { blocks, sourceSemanticFlowBoundaryDecisions } =
        await joinAcrossPageBreak(
          target,
          continuation,
          [target, continuation],
          {
            hardHyphenLexicon: new Set(['long-form']),
          },
        )

      expect(blocks).toHaveLength(1)
      expect(blocks[0].text).toBe(
        'The source uses long-form examples throughout the evaluation.',
      )
      expect(sourceSemanticFlowBoundaryDecisions).toEqual([
        expect.objectContaining({
          topology: 'cross-page-column',
          outcome: 'hard-hyphen-retain',
          from: expect.objectContaining({ regionId: target.id }),
          to: expect.objectContaining({ regionId: continuation.id }),
        }),
      ])
    })

    it.each([
      {
        name: 'citation year',
        targetText: 'Prior evidence from Okafor et al.,',
        continuationText: '2022) supports the source-backed result.',
        options: {},
      },
      {
        name: 'hard hyphen',
        targetText: 'The source uses long-',
        continuationText: 'form examples throughout the evaluation.',
        options: { hardHyphenLexicon: new Set(['long-form']) },
      },
    ])(
      'refuses a $name page break across unaccounted body source',
      async ({ targetText, continuationText, options }) => {
        const target = onPage(
          sourceFlowRegion({
            id: 'specialized-unaccounted-target',
            column: 'right',
            text: targetText,
            x: 0.515,
            y: 0.82,
            sourceSequenceIndex: 40,
          }),
          1,
        )
        const unaccounted = onPage(
          sourceFlowRegion({
            id: 'specialized-unaccounted-source',
            column: 'left',
            text: 'Separate body source appears first on this page.',
            x: 0.09,
            y: 0.04,
            sourceSequenceIndex: 0,
          }),
          2,
        )
        const continuation = onPage(
          sourceFlowRegion({
            id: 'specialized-unaccounted-continuation',
            column: 'left',
            text: continuationText,
            x: 0.09,
            y: 0.1,
            sourceSequenceIndex: 1,
          }),
          2,
        )
        const { blocks, sourceSemanticFlowBoundaryDecisions } =
          await joinAcrossPageBreak(
            target,
            continuation,
            [target, unaccounted, continuation],
            options,
          )

        expect(blocks).toHaveLength(2)
        expect(sourceSemanticFlowBoundaryDecisions).toEqual([])
      },
    )

    it('refuses to prove a page-break join from a mid-page tail', async () => {
      const { target, continuation } = pageBreakPair('mid-page-tail')
      const midPageTail: PdfPageRegion = {
        ...target,
        box: { ...target.box, y: 0.2 },
        lines: target.lines.map((line) => ({
          ...line,
          box: { ...line.box, y: 0.2 },
          runs: line.runs.map((sourceRun) => ({ ...sourceRun, y: 0.2 })),
        })),
      }
      const { blocks, sourceSemanticFlowBoundaryDecisions } =
        await joinAcrossPageBreak(midPageTail, continuation, [
          midPageTail,
          continuation,
        ])

      expect(blocks).toHaveLength(2)
      expect(blocks.map((block) => block.text)).toEqual([
        midPageTail.text,
        continuation.text,
      ])
      expect(sourceSemanticFlowBoundaryDecisions).toHaveLength(0)
    })
  })

  it('refuses an unproven cross-page uncased continuation', async () => {
    // The cross-page path reaches the uncased admission with no source proof
    // at all: the same-page guard binds only on the same page, and the hyphen
    // guard is unconditionally true with no trailing hyphen, so a cross-page
    // pair with no float, no citation year and no hyphen satisfies all of them
    // vacuously. `\p{Lo}` would then match unconditionally, because every Han
    // block begins with one. The admission is therefore conditioned on
    // source-proven same-page column flow actually holding, and this pins it.
    const onPage = (region: PdfPageRegion, page: number): PdfPageRegion => ({
      ...region,
      page,
      box: { ...region.box, page },
      lines: region.lines.map((line) => ({
        ...line,
        box: { ...line.box, page },
        runs: line.runs.map((sourceRun) => ({ ...sourceRun, page })),
      })),
    })
    const target = onPage(
      sourceFlowRegion({
        id: 'unproven-cross-page-cjk-target',
        column: 'left',
        text: '研究结果继续',
        x: 0.09,
        y: 0.82,
        sourceSequenceIndex: 700,
      }),
      1,
    )
    const continuation = onPage(
      sourceFlowRegion({
        id: 'unproven-cross-page-cjk-continuation',
        column: 'left',
        text: '在下一页完成',
        x: 0.09,
        y: 0.1,
        sourceSequenceIndex: 701,
      }),
      2,
    )
    const blocks = [target, continuation].map((region) => ({
      type: 'paragraph' as const,
      region,
      text: region.text,
      confidence: 1,
    }))

    await mergeProseContinuations(blocks, { language: 'zh' })

    expect(blocks).toHaveLength(2)
    expect(blocks[0].text).toBe('研究结果继续')
    expect(blocks[1].text).toBe('在下一页完成')
  })

  it('refuses an uncased column continuation when source-sequence adjacency is absent', async () => {
    // `\p{Lo}` is admitted only where source-proven column flow corroborates it.
    // A lowercase leading letter is strong evidence in a cased script; an
    // uncased leading character is not evidence at all on its own, because
    // every Han block begins with one. This pins the corroboration: same
    // fixture as the joining case, with the source-sequence adjacency broken.
    const target = sourceFlowRegion({
      id: 'unproven-cjk-column-flow-target',
      column: 'left',
      text: '研究结果继续',
      x: 0.09,
      y: 0.82,
      sourceSequenceIndex: 600,
    })
    const continuation = sourceFlowRegion({
      id: 'unproven-cjk-column-flow-continuation',
      column: 'right',
      text: '在下一栏完成',
      x: 0.515,
      y: 0.1,
      sourceSequenceIndex: 640,
    })
    const blocks = [target, continuation].map((region) => ({
      type: 'paragraph' as const,
      region,
      text: region.text,
      confidence: 1,
    }))
    const sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[] =
      []

    await mergeProseContinuations(blocks, {
      language: 'zh',
      sourceSemanticFlowBoundaryDecisions,
    })

    expect(blocks).toHaveLength(2)
    expect(blocks[0].text).toBe('研究结果继续')
    expect(blocks[1].text).toBe('在下一栏完成')
  })

  it('joins a numeric Chinese column continuation without inventing a source space', async () => {
    const target = sourceFlowRegion({
      id: 'numeric-cjk-column-flow-target',
      column: 'left',
      text: '研究结果见',
      x: 0.09,
      y: 0.82,
      sourceSequenceIndex: 510,
    })
    const continuation = sourceFlowRegion({
      id: 'numeric-cjk-column-flow-continuation',
      column: 'right',
      text: '2024年的结果',
      x: 0.515,
      y: 0.1,
      sourceSequenceIndex: 511,
    })
    const blocks = [target, continuation].map((region) => ({
      type: 'paragraph' as const,
      region,
      text: region.text,
      confidence: 1,
    }))
    const sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[] =
      []

    await mergeProseContinuations(blocks, {
      language: 'zh',
      sourceSemanticFlowBoundaryDecisions,
    })

    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('研究结果见2024年的结果')
    expect(sourceSemanticFlowBoundaryDecisions[0]).toMatchObject({
      topology: 'same-page-column',
      outcome: 'no-space',
    })
  })

  it('uses the minimum source-sequence continuation run for column spacing', async () => {
    const target = sourceFlowRegion({
      id: 'out-of-order-column-flow-target',
      column: 'left',
      text: '研究结果见',
      x: 0.09,
      y: 0.82,
      sourceSequenceIndex: 520,
    })
    const firstGeometricRun = {
      ...run(1, '2024', 0.515, 0.1, 0.08),
      sourceSequenceIndex: 522,
      sourceWhitespaceBefore: 'pdf-text-item' as const,
      sourceWhitespacePredecessorIndex: 520,
    }
    const secondGeometricRun = {
      ...run(1, '年的结果', 0.595, 0.1, 0.12),
      sourceSequenceIndex: 521,
    }
    const continuation: PdfPageRegion = {
      ...sourceFlowRegion({
        id: 'out-of-order-column-flow-continuation',
        column: 'right',
        text: '2024年的结果',
        x: 0.515,
        y: 0.1,
        sourceSequenceIndex: 521,
      }),
      lines: [
        {
          id: 'out-of-order-column-flow-continuation-line',
          text: '2024年的结果',
          fontSize: 10,
          box: { ...secondGeometricRun, x: 0.515, width: 0.2 },
          runs: [firstGeometricRun, secondGeometricRun],
          sourceFragmentLineage: {
            algorithm: 'source-run-fragment-v1',
            sourceLineId: 'out-of-order-column-flow-source-line',
            fragment: 'whole',
            sourceSequenceIndexes: [522, 521],
          },
        },
      ],
    }
    const blocks = [target, continuation].map((region) => ({
      type: 'paragraph' as const,
      region,
      text: region.text,
      confidence: 1,
    }))
    const sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[] =
      []

    await mergeProseContinuations(blocks, {
      language: 'zh',
      sourceSemanticFlowBoundaryDecisions,
    })

    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('研究结果见2024年的结果')
    expect(sourceSemanticFlowBoundaryDecisions[0]).toMatchObject({
      to: { sourceSequenceIndex: 521 },
      outcome: 'no-space',
    })
  })

  it('respects proven RTL column order before joining uncased prose', async () => {
    const target = sourceFlowRegion({
      id: 'rtl-column-flow-target',
      column: 'right',
      text: 'البيانات تستمر نحو',
      x: 0.515,
      y: 0.82,
      sourceSequenceIndex: 400,
    })
    const continuation = sourceFlowRegion({
      id: 'rtl-column-flow-continuation',
      column: 'left',
      text: 'العلمية في العمود التالي',
      x: 0.09,
      y: 0.1,
      sourceSequenceIndex: 401,
      whitespaceBefore: 400,
    })
    const blocks = [target, continuation].map((region) => ({
      type: 'paragraph' as const,
      region,
      text: region.text,
      confidence: 1,
    }))
    const sourceSemanticFlowBoundaryDecisions: PdfSourceSemanticFlowBoundaryDecision[] =
      []

    await mergeProseContinuations(blocks, {
      language: 'ar',
      baseDirection: 'rtl',
      sourceSemanticFlowBoundaryDecisions,
    })

    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('البيانات تستمر نحو العلمية في العمود التالي')
    expect(sourceSemanticFlowBoundaryDecisions).toHaveLength(1)
    expect(sourceSemanticFlowBoundaryDecisions[0]).toMatchObject({
      topology: 'same-page-column',
      evidence: expect.arrayContaining([
        'same-page-column-flow',
        'same-page-column-geometry',
      ]),
    })
  })

  it('does not treat an unrelated right-column block as lineage for a following span', () => {
    const rightRun = {
      ...run(1, 'An unrelated right-column paragraph.', 0.54, 0.4, 0.34),
      sourceSequenceIndex: 80,
    }
    const spanRun = {
      ...run(1, 'A separate spanning paragraph.', 0.1, 0.43, 0.8),
      sourceSequenceIndex: 81,
    }
    const makeRegion = (
      id: string,
      column: PdfPageRegion['column'],
      sourceRun: PdfSourceRun,
    ): PdfPageRegion => ({
      id,
      page: 1,
      kind: column === 'span' ? 'spanning' : 'body',
      column,
      text: sourceRun.text,
      confidence: 1,
      box: { ...sourceRun },
      lines: [
        {
          id: `${id}-line`,
          text: sourceRun.text,
          fontSize: sourceRun.fontSize,
          box: { ...sourceRun },
          runs: [{ ...sourceRun }],
          sourceFragmentLineage: {
            algorithm: 'source-run-fragment-v1',
            sourceLineId: `${id}-line`,
            fragment: 'whole',
            sourceSequenceIndexes: [sourceRun.sourceSequenceIndex!],
          },
        },
      ],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })

    expect(
      sourceProvenRunFragmentToSpanBoundary(
        makeRegion('unrelated-right-region', 'right', rightRun),
        makeRegion('unrelated-span-region', 'span', spanRun),
      ),
    ).toBe(false)
  })

  it.each([
    {
      name: 'whole-line sequence adjacency',
      targetFragment: 'whole' as const,
      targetSourceLineId: 'legal-heading-source-line',
    },
    {
      name: 'one-sided inline-stacked lineage',
      targetFragment: 'inline-stacked-after' as const,
      targetSourceLineId: 'formula-source-line',
    },
    {
      name: 'one-sided cross-gutter lineage',
      targetFragment: 'cross-gutter-right' as const,
      targetSourceLineId: 'cross-gutter-source-line',
    },
  ])(
    'does not rejoin intentional paragraphs from $name alone',
    async ({ targetFragment, targetSourceLineId }) => {
      const makeRegion = (
        id: string,
        text: string,
        y: number,
        sourceSequenceIndex: number,
        fragment: 'whole' | 'inline-stacked-after' | 'cross-gutter-right',
        sourceLineId: string,
      ): PdfPageRegion => {
        const sourceRun: PdfSourceRun = {
          ...run(1, text, 0.1, y, 0.7),
          height: 0.018,
          sourceSequenceIndex,
        }
        return {
          id,
          page: 1,
          kind: 'body',
          column: 'single',
          text,
          confidence: 1,
          box: { ...sourceRun },
          lines: [
            {
              id: `${id}-line`,
              text,
              fontSize: sourceRun.fontSize,
              box: { ...sourceRun },
              runs: [{ ...sourceRun }],
              sourceFragmentLineage: {
                algorithm: 'source-run-fragment-v1',
                sourceLineId,
                fragment,
                sourceSequenceIndexes: [sourceSequenceIndex],
              },
            },
          ],
          nativeObjectIds: [],
          includedInReadingOrder: true,
        }
      }
      const regions = [
        makeRegion(
          'legal-heading-region',
          'copyright 2026',
          0.2,
          0,
          targetFragment,
          targetSourceLineId,
        ),
        makeRegion(
          'legal-body-region',
          'this paragraph starts a distinct legal notice.',
          0.244,
          1,
          'whole',
          'independent-legal-body-source-line',
        ),
      ]
      const blocks = regions.map((region) => ({
        type: 'paragraph' as const,
        region,
        text: region.text,
        confidence: 1,
      }))
      const semanticFlowDecisions: PdfSourceSemanticFlowBoundaryDecision[] = []

      await mergeProseContinuations(blocks, {
        sourceSemanticFlowBoundaryDecisions: semanticFlowDecisions,
      })

      expect(blocks).toHaveLength(2)
      expect(semanticFlowDecisions).toEqual([])
    },
  )

  it.each([
    {
      name: 'dominant baseline under a stacked envelope',
      targetText: 'The news arrives simulta-',
      continuationText: 'neous with both events.',
      expectedText: 'The news arrives simultaneous with both events.',
      targetColumn: 'span' as const,
      continuationColumn: 'span' as const,
      targetX: 0.12,
      continuationX: 0.12,
      targetLineBox: {
        x: 0.12,
        y: 0.7,
        width: 0.76,
        height: 0.02,
      },
      continuationLineBox: {
        x: 0.12,
        y: 0.713,
        width: 0.76,
        height: 0.03,
      },
      targetRunBox: {
        x: 0.12,
        y: 0.703,
        width: 0.76,
        height: 0.014,
      },
      continuationRunBox: {
        x: 0.12,
        y: 0.72,
        width: 0.76,
        height: 0.014,
      },
      targetFragment: 'whole' as const,
      continuationFragment: 'inline-stacked-after' as const,
    },
    {
      name: 'cross-gutter right fragment into a span',
      targetText: 'Residuals should be serially uncorre-',
      continuationText: 'lated under the null.',
      expectedText: 'Residuals should be serially uncorrelated under the null.',
      targetColumn: 'right' as const,
      continuationColumn: 'span' as const,
      targetX: 0.52,
      continuationX: 0.12,
      targetLineBox: {
        x: 0.52,
        y: 0.5,
        width: 0.36,
        height: 0.014,
      },
      continuationLineBox: {
        x: 0.12,
        y: 0.517,
        width: 0.76,
        height: 0.014,
      },
      targetRunBox: {
        x: 0.52,
        y: 0.5,
        width: 0.36,
        height: 0.014,
      },
      continuationRunBox: {
        x: 0.12,
        y: 0.517,
        width: 0.76,
        height: 0.014,
      },
      targetFragment: 'cross-gutter-right' as const,
      continuationFragment: 'whole' as const,
    },
  ])(
    'joins a source-proved discretionary hyphen across a $name',
    async ({
      targetText,
      continuationText,
      expectedText,
      targetColumn,
      continuationColumn,
      targetLineBox,
      continuationLineBox,
      targetRunBox,
      continuationRunBox,
      targetFragment,
      continuationFragment,
    }) => {
      const semanticFlowDecisions: PdfSourceSemanticFlowBoundaryDecision[] = []
      const canonicalHyphenDecisions: PdfCanonicalHyphenBoundaryDecision[] = []
      const makeRegion = ({
        id,
        text,
        column,
        lineBox,
        runBox,
        sequence,
        fragment,
      }: {
        id: string
        text: string
        column: PdfPageRegion['column']
        lineBox: { x: number; y: number; width: number; height: number }
        runBox: { x: number; y: number; width: number; height: number }
        sequence: number
        fragment:
          | 'whole'
          | 'inline-stacked-formula'
          | 'inline-stacked-after'
          | 'cross-gutter-right'
          | 'cross-gutter-left'
      }): PdfPageRegion => {
        const sourceRunBase = {
          ...run(1, text, runBox.x, runBox.y, runBox.width),
          ...runBox,
          sourceSequenceIndex: sequence,
        }
        const sourceRun: PdfSourceRun =
          sequence === 901
            ? {
                ...sourceRunBase,
                sourceWhitespaceBefore: 'pdf-text-item',
                sourceWhitespacePredecessorIndex: 900,
              }
            : sourceRunBase
        return {
          id,
          page: 1,
          kind: column === 'span' ? 'spanning' : 'body',
          column,
          text,
          confidence: 1,
          box: {
            ...sourceRun,
            ...lineBox,
          },
          lines: [
            {
              id: `${id}-line`,
              text,
              fontSize: sourceRun.fontSize,
              box: {
                ...sourceRun,
                ...lineBox,
              },
              runs: [sourceRun],
              sourceFragmentLineage: {
                algorithm: 'source-run-fragment-v1',
                sourceLineId: fragment.startsWith('inline-stacked-')
                  ? 'semantic-hyphen-stacked-source-line'
                  : `${id}-source-line`,
                fragment,
                sourceSequenceIndexes: [sequence],
              },
            },
          ],
          nativeObjectIds: [],
          includedInReadingOrder: true,
        }
      }
      const target = makeRegion({
        id: 'semantic-hyphen-target',
        text: targetText,
        column: targetColumn,
        lineBox: targetLineBox,
        runBox: targetRunBox,
        sequence: 900,
        fragment: targetFragment,
      })
      const continuation = makeRegion({
        id: 'semantic-hyphen-continuation',
        text: continuationText,
        column: continuationColumn,
        lineBox: continuationLineBox,
        runBox: continuationRunBox,
        sequence: 901,
        fragment: continuationFragment,
      })
      const blocks = [target, continuation].map((region) => ({
        type: 'paragraph' as const,
        region,
        text: region.text,
        confidence: 1,
      }))

      await mergeProseContinuations(blocks, {
        language: 'en',
        canonicalHyphenBoundaryDecisions: canonicalHyphenDecisions,
        sourceSemanticFlowBoundaryDecisions: semanticFlowDecisions,
      })

      expect(blocks).toHaveLength(1)
      expect(blocks[0].text).toBe(expectedText)
      expect(canonicalHyphenDecisions).toEqual([])
      expect(semanticFlowDecisions).toHaveLength(1)
      expect(semanticFlowDecisions[0]).toMatchObject({
        outcome: 'discretionary-hyphen-delete',
        from: {
          sourceSequenceIndex: 900,
          sourceFragmentId: `${
            targetFragment.startsWith('inline-stacked-')
              ? 'semantic-hyphen-stacked-source-line'
              : 'semantic-hyphen-target-source-line'
          }:${targetFragment}`,
        },
        to: {
          sourceSequenceIndex: 901,
          sourceFragmentId: `${
            continuationFragment.startsWith('inline-stacked-')
              ? 'semantic-hyphen-stacked-source-line'
              : 'semantic-hyphen-continuation-source-line'
          }:${continuationFragment}`,
        },
      })
    },
  )

  it('proves English publication language from sufficiently long born-digital source text', async () => {
    const sentence =
      'In this paper, we show that the model is stable and that our method can be used for the analysis of data with a source-backed result.'
    const text = Array.from({ length: 30 }, () => sentence).join(' ')
    const result = await reconstructPageAnalyses({
      pages: [page(1, [run(1, text, 0.1, 0.2, 0.75)])],
      sourceHash: '0'.repeat(64),
      fileName: 'born-digital-english.pdf',
      byteLength: 2048,
    })

    expect(result.paper).toMatchObject({
      language: 'en',
      baseDirection: 'ltr',
      metadataLineage: {
        language: {
          status: 'proven',
          source: 'pdf-text-language-inference',
          evidence: [expect.stringMatching(/^pdf-text-language:en:/u)],
        },
        baseDirection: {
          status: 'proven',
          source: 'publication-language',
          evidence: ['language:en'],
        },
      },
    })
  })

  it('normalizes one explicit OCR language into canonical publication language and direction lineage', async () => {
    const result = await reconstructPageAnalyses({
      pages: [ocrPage('بحث محلي موثوق', ['ara'])],
      sourceHash: '1'.repeat(64),
      fileName: 'arabic.pdf',
      byteLength: 2048,
    })

    expect(result.paper).toMatchObject({
      language: 'ar',
      baseDirection: 'rtl',
      metadataLineage: {
        language: {
          status: 'proven',
          source: 'pdf-ocr-explicit',
          evidence: ['ocr-language:ara->ar'],
        },
        baseDirection: {
          status: 'proven',
          source: 'publication-language',
          evidence: ['language:ar'],
        },
      },
    })
  })

  it('scopes a short born-digital document with an explicit publication language', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(
            1,
            'Short source text remains below automatic inference thresholds.',
            0.1,
            0.2,
            0.75,
          ),
        ]),
      ],
      sourceHash: '1'.repeat(64),
      fileName: 'explicit-language.pdf',
      byteLength: 2048,
      metadata: { language: 'en-US' },
    })

    expect(result.paper).toMatchObject({
      language: 'en-US',
      baseDirection: 'ltr',
      metadataLineage: {
        language: {
          status: 'proven',
          source: 'publication-language',
          evidence: ['publication-language:en-US->en-US'],
        },
      },
    })
  })

  it('treats compatible explicit publication and OCR language tags as one scope', async () => {
    const result = await reconstructPageAnalyses({
      pages: [ocrPage('Short English source text.', ['eng'])],
      sourceHash: '1'.repeat(64),
      fileName: 'compatible-language-authorities.pdf',
      byteLength: 2048,
      metadata: { language: 'en-US' },
    })

    expect(result.paper).toMatchObject({
      language: 'en-US',
      metadataLineage: {
        language: {
          status: 'proven',
          source: 'publication-language',
          evidence: [
            'publication-language:en-US->en-US',
            'ocr-language:eng->en',
          ],
        },
      },
    })
  })

  it.each([
    {
      label: 'automatic fallback',
      page: ocrPage(
        'Recovered fallback text is not language authority.',
        ['eng'],
        'automatic-fallback',
      ),
      languageEvidence: 'automatic-ocr-language-is-not-publication-authority',
    },
    {
      label: 'mixed explicit candidates',
      page: ocrPage('本地 research', ['eng', 'chi_sim']),
      languageEvidence:
        'mixed-or-conflicting-ocr-language-candidates:en,zh-Hans',
    },
    {
      label: 'invalid explicit candidate',
      page: ocrPage('Unclassified text', ['osd']),
      languageEvidence: 'invalid-ocr-language-candidate:osd',
    },
  ])(
    'fails language and direction closed for $label',
    async ({ page, languageEvidence }) => {
      const result = await reconstructPageAnalyses({
        pages: [page],
        sourceHash: '2'.repeat(64),
        fileName: 'unknown-language.pdf',
        byteLength: 2048,
      })

      expect(result.paper).toMatchObject({
        language: 'und',
        baseDirection: 'unknown',
        metadataLineage: {
          language: {
            status: 'unresolved',
            evidence: [languageEvidence],
          },
          baseDirection: { status: 'unresolved' },
        },
      })
    },
  )
})

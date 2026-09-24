import { existsSync } from 'node:fs'
import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildReadableEpub, inspectEpub } from './epub'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { captionFontFamily, reconstructPageRegions } from './pdf-regions'

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

async function reconstruct(pages: PdfPageAnalysis[], hash = '7') {
  return reconstructPageAnalyses({
    pages,
    sourceHash: hash.repeat(64),
    fileName: 'regions.pdf',
    byteLength: 4096,
  })
}

describe('deterministic scholarly page regions', () => {
  it('owns caption font normalization behind the compatibility export', async () => {
    const moduleUrl = new URL('./pdf-region-captions.ts', import.meta.url)
    expect(existsSync(moduleUrl)).toBe(true)

    const extracted = await import(moduleUrl.href)
    expect(extracted.captionFontFamily('NimbusRomNo9L-Medi')).toBe(
      'nimbusromno9l',
    )
    expect(captionFontFamily).toBe(extracted.captionFontFamily)
  })

  it('reconstructs complete wrapped captions without swallowing following prose', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 1. A complete synthetic caption whose first',
          0.54,
          0.2,
          0.36,
          9,
        ),
        run(1, 'line wraps into this concluding line.', 0.54, 0.222, 0.25, 9),
        run(
          1,
          'Following body prose remains independent.',
          0.56,
          0.27,
          0.34,
          10,
        ),
        run(
          1,
          'Its continuation remains in the prose flow.',
          0.54,
          0.292,
          0.36,
          10,
        ),
      ]),
    ])

    const captions = result.regions.filter(
      (region) => region.kind === 'caption',
    )
    expect(captions).toHaveLength(1)
    expect(captions[0]).toMatchObject({
      column: 'single',
      text: 'Figure 1. A complete synthetic caption whose first line wraps into this concluding line.',
    })
    expect(captions[0].lines).toHaveLength(2)
    expect(
      result.paper.nodes.find((node) => node.type === 'caption'),
    ).toMatchObject({ text: captions[0].text })
    expect(
      result.paper.nodes.find(
        (node) =>
          node.type === 'paragraph' && node.text.includes('Following body'),
      ),
    ).toMatchObject({
      text: 'Following body prose remains independent. Its continuation remains in the prose flow.',
    })
  })

  it('keeps a bottom-edge caption continuation misclassified as footer when it completes a split word', async () => {
    const result = await reconstruct([
      withExplicitEnglishLanguage(
        page(1, [
          run(
            1,
            'Predicted probabilities establish the body size.',
            0.12,
            0.2,
            0.37,
            11,
          ),
          run(
            1,
            'STRUCTURED-DETECT appears elsewhere in the source.',
            0.12,
            0.22,
            0.37,
            11,
          ),
          run(
            1,
            'Table 5: ROC-AUC score of predicted contradiction probabili-',
            0.514,
            0.88648,
            0.37,
            9,
            0.01065,
          ),
          run(
            1,
            'ties for different methods on our evaluation set. STRUCTURED-',
            0.514,
            0.89831,
            0.369,
            9,
            0.01065,
          ),
          run(
            1,
            'DETECT outperforms our two entailment-based baselines.',
            0.515,
            0.91014,
            0.347,
            9,
            0.01065,
          ),
        ]),
      ),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([
      expect.objectContaining({
        text: 'Table 5: ROC-AUC score of predicted contradiction probabilities for different methods on our evaluation set. STRUCTURED-DETECT outperforms our two entailment-based baselines.',
        lines: expect.arrayContaining([
          expect.objectContaining({
            text: 'DETECT outperforms our two entailment-based baselines.',
          }),
        ]),
      }),
    ])
    expect(
      result.regions.some(
        (region) =>
          region.kind === 'footer' &&
          region.text.includes('DETECT outperforms'),
      ),
    ).toBe(false)
  })

  it('keeps a quoted inline formula on the final line of a caption', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure I: The model tried to simplify the goal but failed.',
          0.176,
          0.2,
          0.65,
          9,
          0.012,
        ),
        run(
          1,
          'Then it rewrote the goal from “a + b + c',
          0.176,
          0.214,
          0.648,
          9,
          0.012,
        ),
        run(
          1,
          '= a + c + b” to “b + a + c = a + c + b”.',
          0.176,
          0.228,
          0.32,
          9,
          0.012,
        ),
        run(1, 'Following body prose remains separate.', 0.176, 0.27, 0.4, 9),
      ]),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([
      expect.objectContaining({
        text: 'Figure I: The model tried to simplify the goal but failed. Then it rewrote the goal from “a + b + c = a + c + b” to “b + a + c = a + c + b”.',
        lines: expect.arrayContaining([
          expect.objectContaining({
            text: '= a + c + b” to “b + a + c = a + c + b”.',
          }),
        ]),
      }),
    ])
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          node.text === 'Following body prose remains separate.',
      ),
    ).toBe(true)
  })

  it('ignores a tall inline symbol when comparing caption continuation type size', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 5. If an optimal representation exists, larger hypothesis spaces are more likely to',
          0.09,
          0.2,
          0.795,
          9,
          0.0113,
        ),
        run(
          1,
          'cover it. LEFT: Two small models find different solutions (marked by outlined',
          0.091,
          0.214,
          0.69,
          9,
          0.0113,
        ),
        run(1, '☆', 0.783, 0.211, 0.016, 11.25, 0.0142),
        run(1, '). RIGHT: As', 0.799, 0.214, 0.086, 9, 0.0113),
        run(
          1,
          'the models become larger, they converge to the same solution (marked by filled ⋆).',
          0.091,
          0.228,
          0.63,
          9,
          0.0119,
        ),
        run(1, 'Following prose remains separate.', 0.09, 0.27, 0.39),
      ]),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([
      expect.objectContaining({
        text: 'Figure 5. If an optimal representation exists, larger hypothesis spaces are more likely to cover it. LEFT: Two small models find different solutions (marked by outlined ☆). RIGHT: As the models become larger, they converge to the same solution (marked by filled ⋆).',
        lines: expect.arrayContaining([
          expect.objectContaining({
            text: 'cover it. LEFT: Two small models find different solutions (marked by outlined ☆). RIGHT: As',
          }),
        ]),
      }),
    ])
  })

  it('requires the dominant caption font family instead of an incidental shared run', async () => {
    const seed = {
      ...run(1, 'Figure 6. A', 0.09, 0.2, 0.22, 9, 0.011),
      fontName: 'CaptionSerif-BoldMT',
    }
    const seedShared = {
      ...run(1, 'zz', 0.32, 0.2, 0.02, 9, 0.011),
      fontName: 'SharedSymbol',
    }
    const candidate = {
      ...run(1, 'continued', 0.09, 0.214, 0.2, 9, 0.011),
      fontName: 'BodySans-Regular',
    }
    const candidateShared = {
      ...run(1, 'zz', 0.3, 0.214, 0.02, 9, 0.011),
      fontName: 'SharedSymbol',
    }
    const result = await reconstruct([
      page(1, [seed, seedShared, candidate, candidateShared]),
    ])
    const caption = result.regions.find((region) => region.kind === 'caption')
    expect(caption).toBeDefined()
    expect(caption?.text).toContain('Figure 6.')
    expect(caption?.text).not.toContain('continued')
    expect(
      result.paper.nodes.some(
        (node) => node.type === 'paragraph' && node.text.includes('continued'),
      ),
    ).toBe(true)
  })

  it('normalizes PostScript MT suffixes when matching caption font families', async () => {
    const seed = {
      ...run(
        1,
        'Figure 7. A caption continues across lines',
        0.09,
        0.2,
        0.7,
        9,
        0.011,
      ),
      fontName: 'Arial-BoldMT',
    }
    const candidate = {
      ...run(1, 'with the same family.', 0.09, 0.214, 0.3, 9, 0.011),
      fontName: 'ArialMT',
    }
    const result = await reconstruct([page(1, [seed, candidate])])
    expect(
      result.regions.find((region) => region.kind === 'caption')?.text,
    ).toContain('with the same family.')
  })

  it('normalizes PostScript PS markers independently of style suffixes', async () => {
    const seed = {
      ...run(
        1,
        'Figure 8. A caption continues across lines',
        0.09,
        0.2,
        0.7,
        9,
        0.011,
      ),
      fontName: 'TimesNewRomanPS-BoldMT',
    }
    const candidate = {
      ...run(1, 'with the same family.', 0.09, 0.214, 0.3, 9, 0.011),
      fontName: 'TimesNewRomanPSMT',
    }
    const result = await reconstruct([page(1, [seed, candidate])])
    expect(
      result.regions.find((region) => region.kind === 'caption')?.text,
    ).toContain('with the same family.')
  })

  it('preserves opaque PDF.js font IDs and recognizes abbreviated style suffixes', () => {
    expect(captionFontFamily('g_d0_f1')).toBe('gd0f1')
    expect(captionFontFamily('g_d0_f1')).not.toBe(captionFontFamily('g_d0_f2'))
    expect(captionFontFamily('HelveticaNeueLTStd-Bd')).toBe(
      captionFontFamily('HelveticaNeueLTStd-Regular'),
    )
    expect(captionFontFamily('MinionPro-It')).toBe(
      captionFontFamily('MinionPro-Regular'),
    )
    expect(captionFontFamily('NimbusRomNo9L-Medi')).toBe(
      captionFontFamily('NimbusRomNo9L-Regu'),
    )
    expect(captionFontFamily('NimbusRomNo9L-ReguItal')).toBe(
      captionFontFamily('NimbusRomNo9L-Ital'),
    )
  })

  it('keeps caption continuations together when opposite-column prose interleaves by y', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 19. A left-column caption begins with a long first',
          0.09,
          0.68,
          0.383,
          9,
          0.011,
        ),
        run(
          1,
          'Right-column prose is geometrically interleaved.',
          0.502,
          0.691,
          0.382,
          10,
          0.012,
        ),
        run(
          1,
          'line and continues at the same left-column indent before',
          0.091,
          0.696,
          0.382,
          9,
          0.011,
        ),
        run(
          1,
          'More right-column prose follows independently.',
          0.502,
          0.706,
          0.382,
          10,
          0.012,
        ),
        run(1, 'ending with a short final line.', 0.091, 0.712, 0.19, 9, 0.011),
      ]),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([
      expect.objectContaining({
        text: 'Figure 19. A left-column caption begins with a long first line and continues at the same left-column indent before ending with a short final line.',
        lines: expect.arrayContaining([
          expect.objectContaining({
            text: 'ending with a short final line.',
          }),
        ]),
      }),
    ])
    expect(
      result.paper.nodes.filter((node) => node.type === 'caption'),
    ).toHaveLength(1)
    expect(
      result.paper.nodes
        .filter((node) => node.type === 'paragraph')
        .map((node) => node.text)
        .join(' '),
    ).toContain('Right-column prose is geometrically interleaved.')
  })

  it('keeps interleaved side-by-side figure captions as separate regions', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 30. Left result begins here',
          0.09,
          0.28,
          0.383,
          9,
          0.009,
        ),
        run(
          1,
          'Figure 32. Right result begins here',
          0.502,
          0.291,
          0.383,
          9,
          0.009,
        ),
        run(1, 'and finishes in its own column.', 0.09, 0.294, 0.24, 9, 0.009),
        run(1, 'and continues on the right', 0.502, 0.305, 0.28, 9, 0.009),
        run(1, 'before ending there.', 0.502, 0.319, 0.2, 9, 0.009),
      ]),
    ])

    const captions = result.regions
      .filter((region) => region.kind === 'caption')
      .map((region) => region.text)
    expect(captions).toHaveLength(2)
    expect(captions[0]).toMatch(/^Figure 30\./)
    expect(captions[0]).toContain('finishes in its own column')
    expect(captions[1]).toMatch(/^Figure 32\./)
    expect(captions[1]).toContain('continues on the right')
    expect(captions[1]).toContain('ending there')
  })

  it('classifies same-baseline gutter-partitioned table captions as separate regions', async () => {
    const layoutRuns = [
      run(1, 'Left column establishes the layout.', 0.09, 0.1, 0.37),
      run(1, 'Right column establishes the layout.', 0.54, 0.1, 0.37),
      run(1, 'Left column remains independent.', 0.09, 0.14, 0.37),
      run(1, 'Right column remains independent.', 0.54, 0.14, 0.37),
      run(1, 'Left column has a third row.', 0.09, 0.18, 0.37),
      run(1, 'Right column has a third row.', 0.54, 0.18, 0.37),
    ]
    const captionRuns = [
      run(1, 'Table', 0.09, 0.4, 0.04, 9, 0.009),
      run(1, '2.', 0.135, 0.4, 0.018, 9, 0.009),
      run(1, 'Left benchmark results.', 0.158, 0.4, 0.395, 9, 0.009),
      run(1, 'Table', 0.562, 0.4, 0.04, 9, 0.009),
      run(1, '3.', 0.607, 0.4, 0.018, 9, 0.009),
      run(1, 'Right ablation results.', 0.63, 0.4, 0.251, 9, 0.009),
      run(1, 'Left caption continuation.', 0.09, 0.4113, 0.463, 9, 0.009),
      run(1, 'Right caption continuation.', 0.562, 0.4113, 0.319, 9, 0.009),
    ]
    const result = await reconstruct([page(1, [...layoutRuns, ...captionRuns])])

    const captions = result.regions.filter(
      (region) => region.kind === 'caption',
    )
    expect(
      captions.map(({ text, column, sourceCaptionLane }) => ({
        text,
        column,
        sourceCaptionLane,
      })),
    ).toEqual([
      {
        text: 'Table 2. Left benchmark results. Left caption continuation.',
        column: 'span',
        sourceCaptionLane: {
          boundary: expect.closeTo(0.5575, 4),
          side: 'left',
        },
      },
      {
        text: 'Table 3. Right ablation results. Right caption continuation.',
        column: 'right',
        sourceCaptionLane: {
          boundary: expect.closeTo(0.5575, 4),
          side: 'right',
        },
      },
    ])
    expect(captions[0].box.x + captions[0].box.width).toBeLessThan(
      captions[1].box.x,
    )
    expect(captions[0].text).not.toContain('Right caption')
    expect(captions[1].text).not.toContain('Left caption')
    const sourceRunKey = (sourceRun: PdfSourceRun) =>
      [
        sourceRun.text,
        sourceRun.x,
        sourceRun.y,
        sourceRun.width,
        sourceRun.height,
      ].join('|')
    const captionOutputRuns = captions.flatMap((caption) =>
      caption.lines.flatMap((line) => line.runs),
    )
    for (const sourceRun of captionRuns) {
      expect(
        captionOutputRuns.filter(
          (candidate) => sourceRunKey(candidate) === sourceRunKey(sourceRun),
        ),
      ).toHaveLength(1)
    }
    const leftLineIds = new Set(captions[0].lines.map((line) => line.id))
    expect(captions[1].lines.some((line) => leftLineIds.has(line.id))).toBe(
      false,
    )
    for (const caption of captions) {
      const [seed, ...continuations] = caption.lines
      expect(continuations).not.toHaveLength(0)
      expect(
        continuations.every(
          (line) => line.captionContinuationSeedId === seed.id,
        ),
      ).toBe(true)
    }
    expect(
      result.visualRelationships
        .filter((relationship) => relationship.kind === 'table')
        .map(({ label, captionRegionId }) => ({ label, captionRegionId })),
    ).toEqual([
      {
        label: 'Table 2',
        captionRegionId: expect.stringMatching(/region/u),
      },
      {
        label: 'Table 3',
        captionRegionId: expect.stringMatching(/region/u),
      },
    ])
  })

  it('fails closed when two source partitions claim the same local-caption continuation band', () => {
    const result = reconstructPageRegions([
      page(1, [
        run(1, 'Left column layout row one.', 0.09, 0.1, 0.37),
        run(1, 'Right column layout row one.', 0.54, 0.1, 0.37),
        run(1, 'Left column layout row two.', 0.09, 0.14, 0.37),
        run(1, 'Right column layout row two.', 0.54, 0.14, 0.37),
        run(1, 'Left column layout row three.', 0.09, 0.18, 0.37),
        run(1, 'Right column layout row three.', 0.54, 0.18, 0.37),
        run(1, 'Table 2. Left benchmark results', 0.09, 0.4, 0.463, 9, 0.009),
        run(1, 'Table 3. Right ablation results', 0.562, 0.4, 0.319, 9, 0.009),
        run(1, 'Left continuation candidate.', 0.09, 0.4113, 0.453, 9, 0.009),
        run(1, 'ambiguous', 0.547, 0.4113, 0.008, 9, 0.009),
        run(1, 'Right continuation candidate.', 0.562, 0.4113, 0.319, 9, 0.009),
      ]),
    ])

    const captions = result.regions.filter(
      (region) => region.kind === 'caption',
    )
    expect(captions.map((caption) => caption.text)).toEqual([
      'Table 2. Left benchmark results',
      'Table 3. Right ablation results',
    ])
    expect(
      captions.some((caption) => /continuation candidate/iu.test(caption.text)),
    ).toBe(false)
    expect(
      result.regions
        .filter((region) => region.kind !== 'caption')
        .map((region) => region.text)
        .join(' '),
    ).toContain('continuation candidate')
  })

  it('keeps interleaved multi-panel label continuations with their source panel', () => {
    const result = reconstructPageRegions([
      page(
        1,
        [
          run(
            1,
            '(a) SEQCODER-1.5B accuracy as a function of',
            0.176,
            0.277,
            0.291,
            9,
            0.011,
          ),
          run(
            1,
            '(b) SEQCODER-1.5B accuracy as a function of',
            0.532,
            0.277,
            0.291,
            9,
            0.011,
          ),
          run(1, 'gold program lengths.', 0.176, 0.29, 0.129, 9, 0.011),
          run(1, 'input sequence lengths.', 0.532, 0.29, 0.137, 9, 0.011),
          run(
            1,
            'Figure 11: Accuracy as a function of program and input sequence lengths.',
            0.182,
            0.315,
            0.635,
            9,
            0.013,
          ),
        ],
        [
          {
            id: 'panel-a',
            page: 1,
            kind: 'image',
            box: {
              page: 1,
              x: 0.176,
              y: 0.103,
              width: 0.291,
              height: 0.169,
              rotation: 0,
              method: 'pdf-object',
            },
            confidence: 1,
            assetId: null,
          },
          {
            id: 'panel-b',
            page: 1,
            kind: 'image',
            box: {
              page: 1,
              x: 0.532,
              y: 0.103,
              width: 0.291,
              height: 0.169,
              rotation: 0,
              method: 'pdf-object',
            },
            confidence: 1,
            assetId: null,
          },
        ],
      ),
    ])

    expect(
      result.regions
        .filter((region) => /^\([ab]\)/u.test(region.text))
        .map((region) => region.text),
    ).toEqual([
      '(a) SEQCODER-1.5B accuracy as a function of gold program lengths.',
      '(b) SEQCODER-1.5B accuracy as a function of input sequence lengths.',
    ])
  })

  it('keeps prose with inline equations in the complete caption', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 16. We plot the magnitude of each Fourier feature.',
          0.09,
          0.2,
          0.39,
          9,
        ),
        run(
          1,
          'The period T = 2 component is omitted from the plotted basis.',
          0.09,
          0.222,
          0.39,
          9,
        ),
        run(
          1,
          'Its output is measured on a different scale.',
          0.09,
          0.244,
          0.32,
          9,
        ),
        run(1, 'Following body prose.', 0.09, 0.29, 0.39, 10),
      ]),
    ])

    const caption = result.regions.find((region) => region.kind === 'caption')
    expect(caption?.text).toBe(
      'Figure 16. We plot the magnitude of each Fourier feature. The period T = 2 component is omitted from the plotted basis. Its output is measured on a different scale.',
    )
    expect(caption?.lines).toHaveLength(3)
    expect(
      result.paper.nodes.find(
        (node) =>
          node.type === 'paragraph' && node.text === 'Following body prose.',
      ),
    ).toBeDefined()
  })

  it('keeps split caption prose and source-backed stacked formula obligations', async () => {
    const mathRun = (
      text: string,
      x: number,
      y: number,
      width: number,
      fontSize: number,
      height: number,
      fontName: string,
    ) => ({
      ...run(1, text, x, y, width, fontSize, height),
      fontName,
    })
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 8. An inline formula is preserved by',
          0.5,
          0.2,
          0.385,
          9,
          0.01132,
        ),
        run(
          1,
          'helix(x). We use evidence to show that',
          0.5,
          0.214,
          0.305,
          9,
          0.01132,
        ),
        mathRun('l', 0.8197, 0.213, 0.004, 6, 0.00755, 'Synthetic+CMMI6'),
        mathRun('=', 0.8197, 0.2208, 0.009, 6, 0.00755, 'Synthetic+CMR6'),
        mathRun('h', 0.811, 0.214, 0.0087, 9, 0.01132, 'Synthetic+CMMI9'),
        run(1, 'for', 0.835, 0.214, 0.02, 9, 0.01132),
        run(
          1,
          'the model in every evaluated layer.',
          0.5,
          0.228,
          0.24,
          9,
          0.01132,
        ),
      ]),
    ])

    const caption = result.paper.nodes.find((node) => node.type === 'caption')
    expect(caption?.text).toContain(
      'Figure 8. An inline formula is preserved by helix(x). We use evidence to show that',
    )
    expect(caption?.text).toContain('for the model in every evaluated layer.')
    expect(caption?.text).not.toContain('hl=')
    const formulaNodes = result.paper.nodes.filter(
      (node) =>
        node.type === 'paragraph' &&
        /^(?:l=h|hl=)(?:\s+for)?$/u.test(node.text),
    )
    expect(formulaNodes).toEqual([
      expect.objectContaining({
        type: 'paragraph',
        text: 'hl=',
        inlineRuns: expect.arrayContaining([
          expect.objectContaining({ verticalAlign: 'superscript' }),
          expect.objectContaining({ verticalAlign: 'subscript' }),
        ]),
      }),
    ])
    expect(result.provenance[formulaNodes[0].id]?.boxes.length).toBeGreaterThan(
      0,
    )
    const captionRegion = result.regions.find(
      (region) => region.kind === 'caption',
    )
    expect(
      captionRegion?.lines.flatMap((line) =>
        line.runs.map((sourceRun) => sourceRun.text),
      ),
    ).toEqual(expect.arrayContaining(['for']))
    expect(
      captionRegion?.lines.flatMap((line) =>
        line.runs.map((sourceRun) => sourceRun.text),
      ),
    ).not.toEqual(expect.arrayContaining(['h', 'l', '=']))

    expect(
      result.visualRelationships.find(
        (relationship) =>
          relationship.kind === 'equation' &&
          relationship.evidence.includes('source-text-transcript-unresolved'),
      ),
    ).toMatchObject({
      status: 'unresolved',
      sourceText: '',
      altTextSource: 'caption',
    })
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNRESOLVED_VISUAL_OBJECT',
      ]),
    })
    expect(result.completeness.expectedInlineSpanCount).toBeGreaterThan(0)

    const epub = await buildReadableEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    expect(content).toContain('<em>h</em><sup><em>l</em></sup><sub>=</sub>')
    expect(content).not.toContain('>Display equation p001-001<')
    expect(content).not.toContain('orphan-caption omitted-visual')
  })

  it('keeps a short sentence-like inline equation continuation in its caption', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 39. We analyze each selected neuron’s maximally',
          0.09,
          0.28,
          0.79,
          9,
          0.011,
        ),
        run(1, 'activating a + b example.', 0.091, 0.294, 0.15, 9, 0.011),
        run(1, 'Following prose remains separate.', 0.09, 0.35, 0.36, 9),
      ]),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([
      expect.objectContaining({
        text: 'Figure 39. We analyze each selected neuron’s maximally activating a + b example.',
        lines: expect.arrayContaining([
          expect.objectContaining({ text: 'activating a + b example.' }),
        ]),
      }),
    ])
  })

  it('keeps enumerated subfigure prose in one complete caption', async () => {
    const result = await reconstruct([
      page(1, [
        run(
          1,
          'Figure 1. Comparison of three strategies. (a) Fixed planning.',
          0.54,
          0.2,
          0.36,
          9,
        ),
        run(
          1,
          '(b) Interactive planning. The proposed method appears in (c).',
          0.54,
          0.222,
          0.36,
          9,
        ),
        run(
          1,
          'Following body prose remains independent.',
          0.54,
          0.27,
          0.34,
          10,
        ),
      ]),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([
      expect.objectContaining({
        text: 'Figure 1. Comparison of three strategies. (a) Fixed planning. (b) Interactive planning. The proposed method appears in (c).',
        lines: expect.arrayContaining([
          expect.objectContaining({
            text: '(b) Interactive planning. The proposed method appears in (c).',
          }),
        ]),
      }),
    ])
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          node.text === 'Following body prose remains independent.',
      ),
    ).toBe(true)
  })

  it('keeps an inline abbreviated figure reference in continuous body prose', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'The comparison is continued in', 0.12, 0.2, 0.34, 10, 0.018),
        run(
          1,
          'Fig. 8. Specifically, the discussion follows the same protocol',
          0.12,
          0.218,
          0.52,
          10,
          0.018,
        ),
        run(
          1,
          'and remains part of the surrounding paragraph.',
          0.12,
          0.236,
          0.4,
          10,
          0.018,
        ),
      ]),
    ])

    expect(
      result.regions.filter((region) => region.kind === 'caption'),
    ).toEqual([])
    expect(
      result.paper.nodes
        .filter((node) => node.type === 'paragraph')
        .map((node) => node.text),
    ).toEqual([
      'The comparison is continued in Fig. 8. Specifically, the discussion follows the same protocol and remains part of the surrounding paragraph.',
    ])
  })

  it('stops after a short terminal caption even when prose follows at normal leading', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Figure 2. A short caption.', 0.1, 0.2, 0.2, 9),
        run(
          1,
          'Following prose begins without an extra vertical gap.',
          0.1,
          0.222,
          0.38,
          9,
        ),
        run(
          1,
          'Its second line remains ordinary body text.',
          0.1,
          0.244,
          0.34,
          9,
        ),
      ]),
    ])

    expect(
      result.regions.find((region) => region.kind === 'caption'),
    ).toMatchObject({
      text: 'Figure 2. A short caption.',
      lines: [expect.objectContaining({ text: 'Figure 2. A short caption.' })],
    })
    expect(
      result.paper.nodes.find(
        (node) =>
          node.type === 'paragraph' && node.text.startsWith('Following prose'),
      ),
    ).toMatchObject({
      text: 'Following prose begins without an extra vertical gap. Its second line remains ordinary body text.',
    })
  })

  it('keeps a multi-line page-spanning table caption in one caption region', async () => {
    const result = await reconstruct([
      page(1, [
        run(1, 'Left column establishes a stable layout.', 0.08, 0.1, 0.34),
        run(1, 'Left column continues in source order.', 0.08, 0.13, 0.34),
        run(1, 'Right column establishes a stable layout.', 0.58, 0.1, 0.34),
        run(1, 'Right column continues in source order.', 0.58, 0.13, 0.34),
        run(
          1,
          'Table 1. Comparison across all evaluated systems and',
          0.08,
          0.4,
          0.84,
          9,
        ),
        run(
          1,
          'the dimensions included by each benchmark.',
          0.08,
          0.422,
          0.64,
          9,
        ),
        run(1, 'Subsequent prose starts after the caption.', 0.08, 0.48, 0.34),
        run(1, 'A second prose line follows normally.', 0.08, 0.502, 0.34),
      ]),
    ])

    const caption = result.regions.find((region) => region.kind === 'caption')
    expect(caption).toMatchObject({
      column: 'span',
      text: 'Table 1. Comparison across all evaluated systems and the dimensions included by each benchmark.',
    })
    expect(caption?.lines).toHaveLength(2)
    expect(
      result.paper.nodes.filter((node) => node.type === 'caption'),
    ).toEqual([expect.objectContaining({ text: caption?.text })])
    expect(
      result.paper.nodes.some(
        (node) =>
          node.type === 'paragraph' &&
          node.text.includes('Subsequent prose starts after the caption.'),
      ),
    ).toBe(true)
  })
})

import { expect, it } from 'vitest'
import { renderPublicationXhtml } from './epub'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { normalizePdfFontText } from './pdf-font-text'
import {
  reconstructPageAnalyses,
  sourceRunBoundaryNormalizationAliasText,
} from './pdf-layout'

function sourceRun({
  text,
  x,
  y,
  width,
  fontName = 'Synthetic-CMR12',
  fontSize = 12,
  height = 0.014,
}: {
  text: string
  x: number
  y: number
  width: number
  fontName?: string
  fontSize?: number
  height?: number
}): PdfSourceRun {
  return {
    page: 1,
    text,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-text',
    fontName,
    fontSize,
    confidence: 1,
  }
}

function page(runs: PdfSourceRun[]): PdfPageAnalysis {
  return {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, run) => total + run.text.length, 0),
    imageCount: 0,
    runs,
  }
}

it('decodes AMS blackboard uppercase source glyphs without changing ordinary fonts', () => {
  expect(normalizePdfFontText('Q R', 'ABCDEF+MSBM10')).toBe('ℚ ℝ')
  expect(normalizePdfFontText('Q R', 'ABCDEF+CMR12')).toBe('Q R')
  expect(normalizePdfFontText('Q R', 'ABCDEF+CMSY10')).toBe('Q R')
})

it('rejects unproved source-run normalization aliases', () => {
  const left = {
    ...sourceRun({
      text: 'described by Itˆ',
      x: 0.2,
      y: 0.4,
      width: 0.14,
    }),
    sourceSequenceIndex: 8,
  }
  const right = {
    ...sourceRun({
      text: 'o',
      x: 0.338,
      y: 0.4,
      width: 0.01,
    }),
    sourceSequenceIndex: 9,
  }

  expect(sourceRunBoundaryNormalizationAliasText(left, right)).toBe(
    'described by Itô',
  )
  expect(
    sourceRunBoundaryNormalizationAliasText(
      { ...left, text: 'ordinary prose' },
      right,
    ),
  ).toBeNull()
  expect(
    sourceRunBoundaryNormalizationAliasText(left, {
      ...right,
      sourceWhitespaceBefore: 'pdf-text-item',
      sourceWhitespacePredecessorIndex: left.sourceSequenceIndex,
    }),
  ).toBeNull()
  expect(
    sourceRunBoundaryNormalizationAliasText(
      { ...left, sourceSequenceIndex: 10 },
      right,
    ),
  ).toBeNull()
  expect(
    sourceRunBoundaryNormalizationAliasText(left, {
      ...right,
      fontName: 'Synthetic-OtherRoman',
    }),
  ).toBeNull()
  expect(
    sourceRunBoundaryNormalizationAliasText(left, {
      ...right,
      italic: true,
    }),
  ).toBeNull()
  expect(
    sourceRunBoundaryNormalizationAliasText(left, {
      ...right,
      page: 2,
    }),
  ).toBeNull()
})

it('preserves delimiter-wrapped subscript atoms before split accented prose', async () => {
  const baselineY = 0.4
  const scriptY = 0.407
  const math = (text: string, x: number, width: number) =>
    sourceRun({
      text,
      x,
      y: baselineY,
      width,
      fontName: 'ABCDEF+CMMI12',
    })
  const subscript = (text: string, x: number, width: number) =>
    sourceRun({
      text,
      x,
      y: scriptY,
      width,
      fontName: 'ABCDEF+CMMI8',
      fontSize: 8,
      height: 0.009,
    })
  const runs = [
    sourceRun({
      text: 'Paragraph math source proof',
      x: 0.2,
      y: 0.08,
      width: 0.42,
      fontName: 'Synthetic-Bold',
      fontSize: 18,
      height: 0.022,
    }),
    sourceRun({
      text: 'Test Author',
      x: 0.4,
      y: 0.16,
      width: 0.18,
    }),
    sourceRun({
      text: 'Abstract',
      x: 0.1,
      y: 0.24,
      width: 0.12,
      fontName: 'Synthetic-Bold',
      fontSize: 14,
      height: 0.018,
    }),
    sourceRun({
      text: 'Ordinary prose establishes the document body typography.',
      x: 0.1,
      y: 0.3,
      width: 0.72,
    }),
    sourceRun({
      text: 'Because',
      x: 0.1,
      y: baselineY,
      width: 0.075,
    }),
    math('p', 0.181, 0.012),
    subscript('t', 0.193, 0.007),
    sourceRun({
      text: '= F(',
      x: 0.207,
      y: baselineY,
      width: 0.04,
    }),
    math('x', 0.248, 0.012),
    subscript('t', 0.26, 0.007),
    sourceRun({
      text: ') and ',
      x: 0.269,
      y: baselineY,
      width: 0.05,
    }),
    sourceRun({
      text: '{',
      x: 0.319,
      y: baselineY,
      width: 0.01,
      fontName: 'ABCDEF+CMSY10',
    }),
    math('p', 0.329, 0.012),
    subscript('t', 0.341, 0.007),
    sourceRun({
      text: '}',
      x: 0.348,
      y: baselineY,
      width: 0.01,
      fontName: 'ABCDEF+CMSY10',
    }),
    sourceRun({
      text: 'remain in a process described by Itˆ',
      x: 0.364,
      y: baselineY,
      width: 0.29,
    }),
    sourceRun({
      text: 'o',
      x: 0.65,
      y: baselineY,
      width: 0.01,
    }),
  ]

  const result = await reconstructPageAnalyses({
    pages: [page(runs)],
    sourceHash: 'a'.repeat(64),
    fileName: 'paragraph-math-source.pdf',
    byteLength: 2048,
  })
  const paragraph = result.paper.nodes.find(
    (node) => 'text' in node && node.text.includes('{pt}'),
  )
  if (!paragraph || !('text' in paragraph)) {
    throw new Error('missing delimiter-wrapped paragraph math')
  }

  const content = renderPublicationXhtml(result.paper, {
    reconstruction: result,
  })

  expect(paragraph.text).toContain('{pt}')
  expect(content).toContain(
    '{<em>p</em><sub><em>t</em></sub>} remain in a process described by Itô',
  )
})

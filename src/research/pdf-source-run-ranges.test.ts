import { expect, it } from 'vitest'
import type { PdfSourceRun } from './import-types'
import {
  retainUniqueMonotoneSourceRunAssignment,
  sourceRunBoundaryNormalizationAliasText,
} from './pdf-source-run-ranges'

function sourceRun({
  text,
  x,
  width,
}: {
  text: string
  x: number
  width: number
}): PdfSourceRun {
  return {
    page: 1,
    text,
    x,
    y: 0.4,
    width,
    height: 0.014,
    rotation: 0,
    method: 'pdf-text',
    fontName: 'Synthetic-CMR12',
    fontSize: 12,
    confidence: 1,
  }
}

it('keeps a unique source-run assignment and normalizes an adjacent accent alias', () => {
  const accent = {
    ...sourceRun({ text: 'Itˆ', x: 0.2, width: 0.03 }),
    sourceSequenceIndex: 8,
  }
  const letter = {
    ...sourceRun({ text: 'o', x: 0.228, width: 0.01 }),
    sourceSequenceIndex: 9,
  }
  const candidates = [
    {
      run: sourceRun({ text: 'x', x: 0.1, width: 0.01 }),
      text: 'x',
      occurrences: [
        { start: 0, end: 1 },
        { start: 2, end: 3 },
      ],
    },
    {
      run: sourceRun({ text: 'y', x: 0.12, width: 0.01 }),
      text: 'y',
      occurrences: [{ start: 4, end: 5 }],
    },
  ]

  expect(sourceRunBoundaryNormalizationAliasText(accent, letter)).toBe('Itô')
  expect(retainUniqueMonotoneSourceRunAssignment(candidates)).toBe(false)
  expect(candidates.map((candidate) => candidate.occurrences)).toEqual([[], []])
})

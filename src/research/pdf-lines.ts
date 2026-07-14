import type { PdfPageAnalysis, PdfSourceRun } from './import-types'

export type PdfTextLine = {
  page: number
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
  runs: PdfSourceRun[]
  column: 'left' | 'right' | 'span'
}

function mergeRunText(runs: PdfSourceRun[]) {
  let text = ''
  let previous: PdfSourceRun | undefined
  for (const run of runs) {
    const word = run.text.trim()
    if (!word) continue
    const gap = previous
      ? run.x - (previous.x + previous.width)
      : Number.POSITIVE_INFINITY
    const needsSpace =
      text.length > 0 &&
      !/^[,.;:!?%)}\]]/.test(word) &&
      !/[({[]$/.test(text) &&
      gap > Math.max(0.0015, run.height * 0.08)
    text += `${needsSpace ? ' ' : ''}${word}`
    previous = run
  }
  return text.replace(/\s+/g, ' ').trim()
}

export function groupRunsIntoLines(page: PdfPageAnalysis): PdfTextLine[] {
  const lines: PdfTextLine[] = []
  const runs = page.runs
    .filter((run) => run.text.trim())
    .sort((left, right) => left.y - right.y || left.x - right.x)

  for (const run of runs) {
    const center = run.y + run.height / 2
    const matching = lines.find((line) => {
      const lineCenter = line.y + line.height / 2
      const horizontalGap = Math.max(
        line.x - (run.x + run.width),
        run.x - (line.x + line.width),
        0,
      )
      return (
        Math.abs(center - lineCenter) <= Math.max(0.004, run.height * 0.45) &&
        horizontalGap <= Math.max(0.025, run.height * 2)
      )
    })
    if (matching) {
      const right = Math.max(matching.x + matching.width, run.x + run.width)
      matching.runs.push(run)
      matching.x = Math.min(matching.x, run.x)
      matching.y = Math.min(matching.y, run.y)
      matching.width = right - matching.x
      matching.height = Math.max(matching.height, run.height)
      matching.fontSize = Math.max(matching.fontSize, run.fontSize)
      continue
    }
    lines.push({
      page: page.page,
      text: '',
      x: run.x,
      y: run.y,
      width: run.width,
      height: run.height,
      fontSize: run.fontSize,
      runs: [run],
      column: 'span',
    })
  }

  for (const line of lines) {
    line.runs.sort((left, right) => left.x - right.x)
    line.text = mergeRunText(line.runs)
  }
  return lines.filter((line) => line.text)
}

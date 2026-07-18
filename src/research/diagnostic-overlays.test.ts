import { describe, expect, it } from 'vitest'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import {
  buildDiagnosticOverlayDocument,
  renderDiagnosticEvidenceHtml,
  renderDiagnosticOverlaySvg,
} from './diagnostic-overlays'
import { reconstructPageAnalyses } from './pdf-layout'

function run(
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
): PdfSourceRun {
  return {
    page: 1,
    text,
    x,
    y,
    width,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
    fontName: 'Fixture',
    fontSize,
    confidence: 1,
  }
}

function reconstruct(runs: PdfSourceRun[]) {
  const page: PdfPageAnalysis = {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: 0,
    runs,
  }
  return reconstructPageAnalyses({
    pages: [page],
    sourceHash: 'a'.repeat(64),
    fileName: 'diagnostic-fixture.pdf',
    byteLength: 4096,
  })
}

describe('PDF diagnostic overlays', () => {
  it('links a note marker to every candidate with scores and evidence', () => {
    const result = reconstruct([
      run('Left one.', 0.08, 0.2, 0.32),
      run('Left two.', 0.08, 0.24, 0.32),
      run('Left three.', 0.08, 0.28, 0.32),
      run('Right one.', 0.56, 0.2, 0.32),
      run('Right two.', 0.56, 0.24, 0.32),
      run('Right three.', 0.56, 0.28, 0.32),
      run('A spanning claim has note reference 1.', 0.1, 0.42, 0.8),
      run('1. Left candidate.', 0.08, 0.82, 0.32, 7),
      run('1. Right candidate.', 0.56, 0.82, 0.32, 7),
    ])
    const model = buildDiagnosticOverlayDocument(result)
    const diagnostic = model.diagnostics.find(
      (item) => item.diagnostic.code === 'AMBIGUOUS_NOTE_MATCH',
    )

    expect(diagnostic).toMatchObject({
      category: 'note-relationship',
      pages: [1],
      noteRelationship: {
        status: 'ambiguous',
        candidates: [
          { score: 0.85, evidence: expect.arrayContaining(['label-exact']) },
          { score: 0.85, evidence: expect.arrayContaining(['label-exact']) },
        ],
      },
    })
    expect(diagnostic?.sourceBoxes).toHaveLength(3)
    const svg = renderDiagnosticOverlaySvg(model.pages[0], diagnostic?.id)
    expect(svg).toContain('0.85 · label-exact')
    expect(svg.match(/<line /g)).toHaveLength(2)
  })

  it('draws both numbered region sequences and emits byte-stable HTML', () => {
    const result = reconstruct([
      run('Left one.', 0.08, 0.2, 0.32),
      run('Right one.', 0.55, 0.2, 0.32),
      run('Indented left two.', 0.18, 0.7, 0.22),
      run('Right two.', 0.55, 0.7, 0.32),
    ])
    const model = buildDiagnosticOverlayDocument(result)
    const diagnostic = model.diagnostics.find(
      (item) => item.diagnostic.code === 'AMBIGUOUS_READING_ORDER',
    )

    expect(diagnostic?.readingOrderCandidates).toEqual([
      expect.objectContaining({
        id: 'left-then-right',
        label: expect.stringContaining('Candidate A'),
      }),
      expect.objectContaining({
        id: 'right-then-left',
        label: expect.stringContaining('Candidate B'),
      }),
    ])
    const svg = renderDiagnosticOverlaySvg(model.pages[0], diagnostic?.id)
    expect(svg.match(/<polyline /g)).toHaveLength(2)
    expect(svg).toContain('>1</text>')

    const first = renderDiagnosticEvidenceHtml(result)
    const second = renderDiagnosticEvidenceHtml(result)
    expect(first).toBe(second)
    expect(first).toContain('Candidate A · left column then right column')
    expect(first).toContain('Candidate B · right column then left column')
    expect(first).toContain('Accessible diagnostic list')
  })
})

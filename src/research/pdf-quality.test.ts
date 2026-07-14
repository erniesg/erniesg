import { describe, expect, it } from 'vitest'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import type { ResearchPaper } from './schema'
import { assessPdfCompleteness, detectPdfSemanticSignals } from './pdf-quality'

function run(text: string, x: number, y: number): PdfSourceRun {
  return {
    page: 1,
    text,
    x,
    y,
    width: 0.06,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
    fontName: 'Body',
    fontSize: 10,
    confidence: 1,
  }
}

describe('PDF semantic signal detection', () => {
  it('joins visually aligned runs in source order before matching signals', () => {
    const runs = [
      run('1. Split caption text', 0.165, 0.2015),
      run('Figure', 0.1, 0.2),
    ]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
      imageCount: 1,
      runs,
    }

    expect(detectPdfSemanticSignals([page])).toMatchObject({ captions: 1 })
  })

  it('does not count duplicate links to one caption as separate relationships', () => {
    const runs = [run('Figure 1. Shared caption', 0.1, 0.2)]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs[0].text.length,
      imageCount: 2,
      runs,
    }
    const paper: ResearchPaper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [
        {
          id: 'caption-1',
          type: 'caption',
          text: 'Figure 1. Shared caption',
          source: 'test',
        },
        {
          id: 'figure-1',
          type: 'figure',
          title: 'First image',
          relationships: { caption: 'caption-1' },
          source: 'test',
        },
        {
          id: 'figure-2',
          type: 'figure',
          title: 'Second image',
          relationships: { caption: 'caption-1' },
          source: 'test',
        },
      ],
    }

    expect(
      assessPdfCompleteness({ pages: [page], paper, diagnostics: [] })
        .completeness,
    ).toMatchObject({
      expectedRelationshipCount: 1,
      resolvedRelationshipCount: 1,
      relationshipCoverage: 1,
    })
  })

  it('does not count figure placeholders as exported source-image payloads', () => {
    const runs = [run('Figure 1. Source image', 0.1, 0.2)]
    const page: PdfPageAnalysis = {
      page: 1,
      kind: 'born-digital',
      width: 612,
      height: 792,
      rotation: 0,
      textCharacters: runs[0].text.length,
      imageCount: 1,
      runs,
    }
    const paper: ResearchPaper = {
      id: 'paper',
      version: '1.0.0',
      status: 'working',
      title: 'Paper',
      subtitle: 'Test',
      authors: ['Test'],
      updated: '2026-07-14',
      abstract: 'Test',
      nodes: [
        {
          id: 'caption-1',
          type: 'caption',
          text: 'Figure 1. Source image',
          source: 'test',
        },
        {
          id: 'figure-1',
          type: 'figure',
          title: 'Placeholder only',
          relationships: { caption: 'caption-1' },
          source: 'test',
        },
      ],
    }

    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
    })

    expect(result.completeness).toMatchObject({
      sourceAssetCount: 1,
      exportedAssetCount: 0,
      assetCoverage: 0,
    })
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'INCOMPLETE_ASSET_COVERAGE',
    )
  })
})

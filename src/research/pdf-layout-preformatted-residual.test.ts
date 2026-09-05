import { describe, expect, it } from 'vitest'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { validateLineBoundaryLedger } from './pdf-quality-line-boundary-analysis'

function run(
  text: string,
  y: number,
  width: number,
  fontName: string,
): PdfSourceRun {
  return {
    page: 1,
    text,
    x: 0.1,
    y,
    width,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
    fontName,
    fontSize: 10,
    confidence: 1,
  }
}

function listingInsideProsePage(): PdfPageAnalysis {
  const runs = [
    run(
      'The following session was captured verbatim from the tool:',
      0.2,
      0.6,
      'NimbusRomNo9L-Regu',
    ),
    run('$ tool --version', 0.222, 0.3, 'NimbusMonoPS-Regular'),
    run('tool 4.2.0', 0.244, 0.2, 'NimbusMonoPS-Regular'),
    run('$ exit', 0.266, 0.1, 'NimbusMonoPS-Regular'),
    run(
      'The transcript above shows the version negotiation in full.',
      0.288,
      0.6,
      'NimbusRomNo9L-Regu',
    ),
  ]
  return {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: 0,
    runs,
  }
}

describe('preformatted listings inside prose regions', () => {
  it('keeps the line-boundary ledger complete when a listing consumes part of a prose region', async () => {
    const result = await reconstructPageAnalyses({
      pages: [listingInsideProsePage()],
      sourceHash: '2'.repeat(64),
      fileName: 'listing-inside-prose.pdf',
      byteLength: 2048,
    })

    const listing = result.visualRelationships.find(
      (relationship) => relationship.preformatted,
    )
    expect(listing?.sourceLineIds?.length ?? 0).toBeGreaterThan(1)

    // Every adjacent source-line transition in every region must keep its
    // decision: the region-text replay that carves retained prose out of a
    // partially consumed region depends on the complete ledger, and the
    // completeness gate independently requires it.
    const ledger = validateLineBoundaryLedger(
      result.regions,
      result.lineBoundaryDecisions,
      result.unresolvedCorruptingJoinCount,
      result.structurallyConsumedLineBoundaryCount,
    )
    expect(ledger.decided).toBe(ledger.expected)
    expect(ledger.valid).toBe(true)
    expect(
      result.diagnostics.map((diagnostic) => diagnostic.code),
    ).not.toContain('INVALID_LINE_BOUNDARY_LEDGER')
  })
})

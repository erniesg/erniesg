import { describe, expect, it } from 'vitest'
import {
  belowThresholdReadingOrderFixture,
  scholarlyReadingOrderFixtures,
} from '../../tests/fixtures/reading-order-fixtures'
import { reconstructPageAnalyses } from './pdf-layout'

function reconstruct(
  pages: Parameters<typeof reconstructPageAnalyses>[0]['pages'],
) {
  return reconstructPageAnalyses({
    pages,
    sourceHash: 'a'.repeat(64),
    fileName: 'synthetic-reading-order.pdf',
    byteLength: 4096,
  })
}

function nodeText(result: Awaited<ReturnType<typeof reconstruct>>) {
  return result.paper.nodes
    .filter((node) => 'text' in node)
    .map((node) => ('text' in node ? node.text : ''))
}

describe('evidence-scored scholarly reading-order resolution', () => {
  for (const fixture of scholarlyReadingOrderFixtures) {
    it(`resolves ${fixture.name} and records every decision`, async () => {
      const result = await reconstruct(fixture.pages)

      expect(nodeText(result)).toEqual(fixture.expectedNodeText)
      if (fixture.expectedListMarkers) {
        expect(
          result.paper.nodes.flatMap((node) =>
            node.type === 'paragraph' && node.list?.markerText
              ? [node.list.markerText]
              : [],
          ),
        ).toEqual(fixture.expectedListMarkers)
      }
      expect(result.diagnostics).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'AMBIGUOUS_READING_ORDER' }),
        ]),
      )
      expect(result.completeness.readingOrderDiagnostics).toBe(0)

      const resolution = result.readingOrder.resolutions.find(
        (candidate) =>
          candidate.ambiguityClass === fixture.ambiguityClass &&
          candidate.status === 'resolved',
      )
      expect(resolution).toMatchObject({
        policyVersion: '1.0.0',
        ambiguityClass: fixture.ambiguityClass,
        status: 'resolved',
        threshold: 0.85,
      })
      expect(resolution!.confidence).toBeGreaterThanOrEqual(
        resolution!.threshold,
      )
      expect(resolution!.evidence.map((item) => item.code)).toEqual(
        expect.arrayContaining(fixture.expectedEvidence),
      )

      const diagnostics = result.diagnostics.filter(
        (diagnostic) =>
          diagnostic.code === 'RESOLVED_READING_ORDER' &&
          diagnostic.readingOrderResolution?.ambiguityClass ===
            fixture.ambiguityClass,
      )
      expect(diagnostics).toHaveLength(resolution!.regionIds.length)
      expect(
        diagnostics.map(
          (diagnostic) => diagnostic.readingOrderResolution?.regionId,
        ),
      ).toEqual(expect.arrayContaining(resolution!.regionIds))
      expect(
        diagnostics.every(
          (diagnostic) =>
            diagnostic.readingOrderResolution?.confidence ===
              resolution!.confidence &&
            diagnostic.readingOrderResolution.evidence.length > 0,
        ),
      ).toBe(true)
    })
  }

  it('retains both candidates and blocks export below the confidence threshold', async () => {
    const result = await reconstruct([belowThresholdReadingOrderFixture])

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AMBIGUOUS_READING_ORDER',
          severity: 'error',
          readingOrderResolution: expect.objectContaining({
            status: 'ambiguous',
            threshold: 0.85,
          }),
        }),
      ]),
    )
    expect(
      result.readingOrder.edges.filter((edge) => edge.status === 'candidate'),
    ).toHaveLength(2)
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
  })
})

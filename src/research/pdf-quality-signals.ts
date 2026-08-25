import type {
  PdfLineBoundaryDecision,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfSemanticSignals,
} from './import-types'
import { classifyPdfNoteMarkers } from './pdf-note-classifier'
import { groupRunsIntoLines } from './pdf-lines'
import { reconstructPageRegions } from './pdf-regions'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'
import { isProbableDisplayEquation } from './pdf-visuals'

function scholarlyCaptionKind(value: string) {
  return (
    parsePdfScholarlyVisualLabel(value, { context: 'caption' })?.kind ?? null
  )
}

export function detectPdfSemanticSignals(
  pages: PdfPageAnalysis[],
  suppliedRegions?: PdfPageRegion[],
  suppliedLineBoundaryDecisions?: readonly PdfLineBoundaryDecision[],
): PdfSemanticSignals {
  const reconstructed = suppliedRegions ? null : reconstructPageRegions(pages)
  const regions = suppliedRegions ?? reconstructed!.regions
  const lineBoundaryDecisions =
    suppliedLineBoundaryDecisions ?? reconstructed?.lineBoundaryDecisions ?? []
  const markerResult = classifyPdfNoteMarkers(
    regions,
    undefined,
    lineBoundaryDecisions,
  )
  const captionFigures = regions.filter(
    (region) =>
      region.kind === 'caption' &&
      scholarlyCaptionKind(region.text) === 'figure',
  ).length
  const signals: PdfSemanticSignals = {
    // Once region reconstruction is available, a figure obligation requires
    // the same caption-region proof as tables. Counting raw PDF lines here
    // double-counts a split caption (or incidental "Figure:" text) and makes
    // an otherwise complete visual graph fail closed.
    captions: suppliedRegions ? captionFigures : 0,
    tables: regions.filter(
      (region) =>
        region.kind === 'caption' &&
        scholarlyCaptionKind(region.text) === 'table',
    ).length,
    equations: 0,
    citations: markerResult.classifications.filter(
      (classification) => classification.disposition === 'citation',
    ).length,
    footnoteReferences: markerResult.classifications.filter(
      (classification) => classification.disposition === 'note-reference',
    ).length,
    footnotes: markerResult.noteBodyRegionIds.length,
  }
  for (const page of pages) {
    for (const line of groupRunsIntoLines(page)) {
      if (!suppliedRegions && scholarlyCaptionKind(line.text) === 'figure') {
        signals.captions += 1
      }
      if (/(?:^|\b)(?:equation|eq\.?)\s*\(?\d+\)?/i.test(line.text)) {
        signals.equations += 1
      }
    }
  }
  signals.equations = Math.max(
    signals.equations,
    regions.filter(isProbableDisplayEquation).length,
  )
  return signals
}

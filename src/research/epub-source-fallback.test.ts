import { describe, expect, it } from 'vitest'
import { buildReadableEpub, inspectEpub } from './epub'
import { reconstructPageAnalyses } from './pdf-layout'
import type {
  PdfSourceRun,
  PdfVisualAsset,
  PdfVisualRelationship,
} from './import-types'
import { strFromU8 } from 'fflate'
import { sha256HexSync } from './sha256-sync'
import { recoveryDiagnosticInputs } from './recovery-projection'
import {
  hasActionableRecovery,
  recoverySummary,
} from '../struct/recovery'

describe('readable EPUB source-preserved visual fallback', () => {
  it('keeps an unresolved figure with a safe asset set instead of hiding it', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Body text remains readable around the source visual.',
      x: 0.1,
      y: 0.1,
      width: 0.6,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    }
    const sourceBox = {
      page: 1,
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.3,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const reconstruction = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: run.text.length,
          imageCount: 1,
          objects: [],
          runs: [run],
        },
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'source-preserved-visual.pdf',
      byteLength: 1024,
    })
    const figure = {
      id: 'source-figure',
      type: 'figure' as const,
      title: 'Figure 1. Source-preserved diagram.',
      sourceText: 'Figure 1. Source-preserved diagram.',
      relationships: { caption: 'source-caption', assets: ['source-visual'] },
      source: 'pdf:test#page=1',
    }
    const caption = {
      id: 'source-caption',
      type: 'caption' as const,
      text: 'Figure 1. Source-preserved diagram.',
      source: 'pdf:test#page=1',
    }
    const asset = {
      id: 'source-visual',
      href: 'assets/source-visual.svg',
      mediaType: 'image/svg+xml' as const,
      kind: 'vector' as const,
      rendition: 'source-preserved' as const,
      bytes: new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      ),
      width: 40,
      height: 20,
      resolutionDpi: null,
      sourceObjectIds: ['source-object'],
      sourceBoxes: [sourceBox],
      sha256: sha256HexSync(
        new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      ),
    } satisfies PdfVisualAsset
    const relationship = {
      id: 'source-visual-relationship',
      kind: 'figure' as const,
      label: 'Figure 1',
      captionRegionId: 'source-caption-region',
      sourceRegionIds: ['source-figure-region'],
      sourceObjectIds: ['source-object'],
      assetIds: [asset.id],
      status: 'unresolved' as const,
      confidence: 0.2,
      evidence: ['source-visual-retained-for-review'],
      candidates: [],
      sourceBoxes: [sourceBox],
      sourceText: figure.sourceText,
      altText: figure.title,
      altTextSource: 'caption' as const,
      canonicalNodeId: figure.id,
      captionNodeId: caption.id,
    } satisfies PdfVisualRelationship
    const result = {
      ...reconstruction,
      paper: {
        ...reconstruction.paper,
        nodes: [...reconstruction.paper.nodes, figure, caption],
      },
      assets: [asset],
      visualRelationships: [relationship],
      provenance: {
        ...reconstruction.provenance,
        [figure.id]: {
          confidence: 1,
          pages: [1],
          regionIds: ['source-figure-region'],
          boxes: [sourceBox],
          links: [],
        },
        [caption.id]: {
          confidence: 1,
          pages: [1],
          regionIds: ['source-caption-region'],
          boxes: [sourceBox],
          links: [],
        },
      },
      readiness: {
        ...reconstruction.readiness,
        ready: false,
        status: 'review-required' as const,
        blockingDiagnosticCodes: ['UNRESOLVED_VISUAL_OBJECT' as const],
      },
      diagnostics: [
        ...reconstruction.diagnostics,
        {
          code: 'UNRESOLVED_VISUAL_OBJECT' as const,
          severity: 'error' as const,
          message: 'The visual match is unresolved.',
          relationshipId: relationship.id,
          target: { regionIds: relationship.sourceRegionIds, markerId: null },
        },
      ],
    }

    const epub = await buildReadableEpub(result.paper, result)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    expect(content).toContain('src="assets/source-visual.svg"')
    expect(content).toContain('Figure 1. Source-preserved diagram.')
    expect(content).not.toContain('figure-placeholder')

    const recovery = recoverySummary({
      ready: result.readiness.ready,
      blockingCodes: result.readiness.blockingDiagnosticCodes,
      diagnostics: recoveryDiagnosticInputs(result),
      textCoverage: result.completeness.textCoverage,
      assetCoverage: result.completeness.assetCoverage,
      relationshipCoverage: result.completeness.relationshipCoverage,
    })
    expect(hasActionableRecovery(recovery)).toBe(false)
    expect(recovery.issues).toEqual([])
  })
})

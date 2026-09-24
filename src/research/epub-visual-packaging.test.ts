import { strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildEpub, buildReadableEpub, inspectEpub } from './epub'
import type { PdfReconstruction, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { assessPdfCompleteness } from './pdf-quality'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import { getTargetProfile } from './targets'
import { createSourcePageCropAsset } from './visual-assets'

describe('EPUB 3 export', () => {
  it('packages unresolved visual metadata without exposing OCR in readable content', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Readable prose before an unresolved source diagram.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
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
      sourceHash: '4'.repeat(64),
      fileName: 'unresolved-diagram-fallback.pdf',
      byteLength: 1024,
    })
    const captionNode = {
      id: 'unresolved-diagram-caption',
      type: 'caption' as const,
      text: 'Figure 1. A source diagram awaiting visual review.',
      source: 'synthetic-unresolved-diagram',
    }
    const captionBox = {
      page: 1,
      x: 0.15,
      y: 0.6,
      width: 0.7,
      height: 0.03,
      rotation: 0,
      method: 'pdf-text' as const,
    }
    const relationship = {
      id: 'unresolved-diagram-relationship',
      kind: 'figure' as const,
      label: 'Figure 1',
      captionRegionId: 'unresolved-diagram-caption-region',
      sourceRegionIds: [],
      sourceObjectIds: [],
      assetIds: [],
      status: 'unresolved' as const,
      confidence: 1,
      evidence: ['unresolved-visual-text-owned'],
      candidates: [],
      sourceBoxes: [captionBox],
      sourceText: 'Step 1: embed inputs. Step 2: create the output.',
      altText: captionNode.text,
      altTextSource: 'caption' as const,
      canonicalNodeId: null,
      captionNodeId: captionNode.id,
    }
    const withUnresolvedDiagram = {
      ...reconstruction,
      paper: {
        ...reconstruction.paper,
        nodes: [...reconstruction.paper.nodes, captionNode],
      },
      provenance: {
        ...reconstruction.provenance,
        [captionNode.id]: {
          confidence: 1,
          pages: [1],
          regionIds: [relationship.captionRegionId],
          boxes: [captionBox],
          links: [],
        },
      },
      visualRelationships: [relationship],
    } satisfies PdfReconstruction

    const fallback = await buildReadableEpub(
      withUnresolvedDiagram.paper,
      withUnresolvedDiagram,
    )
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain(
      `id="${captionNode.id}" data-canonical-id="${captionNode.id}" hidden="hidden"`,
    )
    expect(content).not.toContain('omitted-visual')
    expect(content).not.toContain(captionNode.text)
    expect(content).not.toContain('Recovered text')
    expect(content).not.toContain(relationship.sourceText)
    expect(content).not.toContain('<img')
    expect(manifest.canonicalNodeIds).toContain(captionNode.id)
    expect(manifest.visualRelationships).toEqual([
      expect.objectContaining({
        id: relationship.id,
        status: 'unresolved',
        assetIds: [],
      }),
    ])
  })

  it('omits rejected prose-overlap pixels while preserving hidden canonical targets', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Canonical prose owns this source region.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
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
      sourceHash: '9'.repeat(64),
      fileName: 'prose-overlap.pdf',
      byteLength: 1024,
    })
    const proseNode = reconstruction.paper.nodes.find(
      (node) => 'text' in node && node.text === run.text,
    )!
    const proseRegionId = reconstruction.provenance[proseNode.id].regionIds[0]
    const visualBox = {
      page: 1,
      x: 0.15,
      y: 0.35,
      width: 0.7,
      height: 0.25,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const captionBox = {
      page: 1,
      x: 0.15,
      y: 0.62,
      width: 0.7,
      height: 0.03,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const crop = await createSourcePageCropAsset({
      kind: 'raster',
      cropBox: visualBox,
      sourceObjectIds: ['false-visual-source'],
      sourceBoxes: [visualBox],
      width: 20,
      height: 10,
      pixels: new Uint8Array(20 * 10 * 4).fill(96),
    })
    const figureNode = {
      id: 'false-visual-node',
      type: 'figure' as const,
      objectType: 'figure' as const,
      title: 'False visual duplicate',
      relationships: {
        caption: 'false-visual-caption',
        assets: [crop.id],
      },
      source: 'synthetic-prose-overlap',
    }
    const captionNode = {
      id: 'false-visual-caption',
      type: 'caption' as const,
      text: 'Figure 1. False visual duplicate.',
      source: 'synthetic-prose-overlap',
    }
    const relationship = {
      id: 'false-visual-relationship',
      kind: 'figure' as const,
      label: 'Figure 1',
      captionRegionId: 'false-caption-region',
      sourceRegionIds: [proseRegionId],
      sourceObjectIds: ['false-visual-source'],
      assetIds: [crop.id],
      status: 'matched' as const,
      confidence: 1,
      evidence: ['synthetic-prose-overlap'],
      candidates: [],
      sourceBoxes: [visualBox, captionBox],
      sourceText: '',
      altText: captionNode.text,
      altTextSource: 'caption' as const,
      canonicalNodeId: figureNode.id,
      captionNodeId: captionNode.id,
    }
    const falseMatch = {
      ...reconstruction,
      paper: {
        ...reconstruction.paper,
        nodes: [...reconstruction.paper.nodes, figureNode, captionNode],
      },
      provenance: {
        ...reconstruction.provenance,
        [figureNode.id]: {
          confidence: 1,
          pages: [1],
          regionIds: [proseRegionId],
          boxes: relationship.sourceBoxes,
          links: [],
        },
        [captionNode.id]: {
          confidence: 1,
          pages: [1],
          regionIds: [relationship.captionRegionId],
          boxes: [captionBox],
          links: [],
        },
      },
      assets: [crop],
      visualRelationships: [relationship],
    } satisfies PdfReconstruction

    expect(
      validatedPdfVisualRelationships({
        paper: falseMatch.paper,
        provenance: falseMatch.provenance,
        relationships: falseMatch.visualRelationships,
        assets: falseMatch.assets,
      }),
    ).toEqual([])

    const falselyReady = {
      ...falseMatch,
      readiness: {
        ...falseMatch.readiness,
        status: 'ready',
        ready: true,
        blockingDiagnosticCodes: [],
      },
    } satisfies PdfReconstruction
    await expect(buildEpub(falselyReady.paper, falselyReady)).rejects.toThrow(
      /visual relationship false-visual-relationship/u,
    )

    const fallback = await buildReadableEpub(falseMatch.paper, falseMatch)
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(
      content.match(/Canonical prose owns this source region\./g),
    ).toHaveLength(1)
    expect(content).toContain('false-visual-node')
    expect(content).toContain('false-visual-caption')
    expect(content).toContain('hidden="hidden"')
    expect(content).not.toContain('False visual duplicate')
    expect(content).not.toContain('omitted-visual')
    expect(content).not.toContain('<img')
    expect(manifest.visualRelationships).toEqual([])
    expect(manifest.assets).toEqual([])
    expect(manifest.canonicalNodeIds).toEqual(
      falseMatch.paper.nodes.map((node) => node.id),
    )
    expect(manifest.excludedCanonicalNodeIds).toEqual([])
  })

  it('omits an unvalidated fragment bundle while retaining hidden canonical targets', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Readable fallback body.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
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
          imageCount: 17,
          objects: [],
          runs: [run],
        },
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'fragmented-fallback.pdf',
      byteLength: 1024,
    })
    const sourceBox = {
      page: 1,
      x: 0.1,
      y: 0.3,
      width: 0.8,
      height: 0.4,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const assetIds = Array.from({ length: 17 }, (_, index) => `asset-${index}`)
    const crowded = {
      ...reconstruction,
      paper: {
        ...reconstruction.paper,
        nodes: [
          ...reconstruction.paper.nodes,
          {
            id: 'figure-node',
            type: 'figure' as const,
            title: 'Fragmented source visual',
            relationships: {
              caption: 'figure-caption',
              assets: assetIds,
            },
            source: 'test',
          },
          {
            id: 'figure-caption',
            type: 'caption' as const,
            text: 'Figure 1. Fragmented source visual.',
            source: 'test',
          },
        ],
      },
      assets: assetIds.map((id) => ({
        id,
        href: `assets/${id}.svg`,
        mediaType: 'image/svg+xml' as const,
        kind: 'vector' as const,
        rendition: 'source-preserved' as const,
        sha256: 'c'.repeat(64),
        bytes: new TextEncoder().encode(
          '<svg xmlns="http://www.w3.org/2000/svg"/>',
        ),
        width: 10,
        height: 10,
        resolutionDpi: null,
        sourceObjectIds: [id],
        sourceBoxes: [sourceBox],
      })),
      visualRelationships: [
        {
          id: 'visual-relationship',
          kind: 'figure' as const,
          label: 'Figure 1',
          captionRegionId: 'caption-region',
          sourceRegionIds: ['figure-region'],
          sourceObjectIds: assetIds,
          assetIds,
          status: 'matched' as const,
          confidence: 1,
          evidence: ['test'],
          candidates: [],
          sourceBoxes: [sourceBox],
          sourceText: '',
          altText: 'Fragmented source visual',
          altTextSource: 'caption' as const,
          canonicalNodeId: 'figure-node',
          captionNodeId: 'figure-caption',
        },
      ],
    } satisfies PdfReconstruction

    const fallback = await buildReadableEpub(crowded.paper, crowded)
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).not.toContain('<img')
    expect(content).not.toContain('figure-placeholder')
    expect(content).not.toContain('omitted-visual')
    expect(content).toContain('figure-node')
    expect(content).toContain('figure-caption')
    expect(content).not.toContain('Figure 1. Fragmented source visual.')
    expect(content).toContain('hidden="hidden"')
    expect(manifest.assets).toEqual([])
    expect(manifest.visualRelationships).toEqual([])
    expect(manifest.canonicalNodeIds).toEqual(
      crowded.paper.nodes.map((node) => node.id),
    )
    expect(manifest.excludedCanonicalNodeIds).toEqual([])
  })

  it('does not partially package an unvalidated visual asset bundle', async () => {
    const run: PdfSourceRun = {
      page: 1,
      text: 'Readable fallback body.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
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
          imageCount: 2,
          objects: [],
          runs: [run],
        },
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'solid-fill-fragment.pdf',
      byteLength: 1024,
    })
    const sourceBox = {
      page: 1,
      x: 0.2,
      y: 0.3,
      width: 0.6,
      height: 0.3,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const raster = await createSourcePageCropAsset({
      kind: 'raster',
      cropBox: sourceBox,
      sourceObjectIds: ['image-p001-001'],
      sourceBoxes: [sourceBox],
      width: 2,
      height: 2,
      pixels: new Uint8Array(2 * 2 * 4).fill(96),
    })
    const rasterId = raster.id
    const solidId = 'asset-solid-fill'
    const withVisual = {
      ...reconstruction,
      paper: {
        ...reconstruction.paper,
        nodes: [
          ...reconstruction.paper.nodes,
          {
            id: 'figure-node',
            type: 'figure' as const,
            title: 'Bounded source figure',
            relationships: {
              caption: 'figure-caption',
              assets: [rasterId, solidId],
            },
            source: 'test',
          },
          {
            id: 'figure-caption',
            type: 'caption' as const,
            text: 'Figure 1. Bounded source figure.',
            source: 'test',
          },
        ],
      },
      assets: [
        raster,
        {
          id: solidId,
          href: `assets/${solidId}.svg`,
          mediaType: 'image/svg+xml' as const,
          kind: 'vector' as const,
          rendition: 'source-preserved' as const,
          sha256: 'f'.repeat(64),
          bytes: new TextEncoder().encode(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300"><path d="M 0 0 L 600 0 L 600 300 L 0 300 Z" fill="#000" stroke="none" /></svg>',
          ),
          width: 600,
          height: 300,
          resolutionDpi: null,
          sourceObjectIds: ['vector-p001-001'],
          sourceBoxes: [sourceBox],
        },
      ],
      visualRelationships: [
        {
          id: 'visual-relationship',
          kind: 'figure' as const,
          label: 'Figure 1',
          captionRegionId: 'caption-region',
          sourceRegionIds: ['figure-region'],
          sourceObjectIds: ['image-p001-001', 'vector-p001-001'],
          assetIds: [rasterId, solidId],
          status: 'matched' as const,
          confidence: 1,
          evidence: ['test'],
          candidates: [],
          sourceBoxes: [sourceBox],
          sourceText: '',
          altText: 'Bounded source figure',
          altTextSource: 'caption' as const,
          canonicalNodeId: 'figure-node',
          captionNodeId: 'figure-caption',
        },
      ],
    } satisfies PdfReconstruction

    const fallback = await buildReadableEpub(withVisual.paper, withVisual)
    const { files, manifest } = inspectEpub(fallback.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).not.toContain('<img')
    expect(content).not.toContain(rasterId)
    expect(content).not.toContain(solidId)
    expect(content).not.toContain('omitted-visual')
    expect(content).not.toContain('Figure 1. Bounded source figure.')
    expect(content).toContain('hidden="hidden"')
    expect(manifest.assets).toEqual([])
    expect(manifest.visualRelationships).toEqual([])
    expect(manifest.canonicalNodeIds).toEqual(
      withVisual.paper.nodes.map((node) => node.id),
    )
    expect(manifest.excludedCanonicalNodeIds).toEqual([])
  })

  it('packages and renders a bounded source-page crop with its provenance', async () => {
    const titleRun: PdfSourceRun = {
      page: 1,
      text: 'Source page crop',
      x: 0.2,
      y: 0.08,
      width: 0.6,
      height: 0.035,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Heading',
      fontSize: 18,
      confidence: 1,
    }
    const bodyRun: PdfSourceRun = {
      page: 1,
      text: 'Readable source-crop body.',
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Body',
      fontSize: 10,
      confidence: 1,
    }
    const captionRun: PdfSourceRun = {
      page: 1,
      text: 'Figure 1. Bounded source-page crop.',
      x: 0.15,
      y: 0.68,
      width: 0.7,
      height: 0.02,
      rotation: 0,
      method: 'pdf-text',
      fontName: 'Caption',
      fontSize: 9,
      confidence: 1,
    }
    const sourceRuns = [titleRun, bodyRun, captionRun]
    const reconstruction = await reconstructPageAnalyses({
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: sourceRuns.reduce(
            (total, sourceRun) => total + sourceRun.text.length,
            0,
          ),
          imageCount: 0,
          objects: [],
          runs: sourceRuns,
        },
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'source-page-crop.pdf',
      byteLength: 1024,
    })
    const sourceBox = {
      page: 1,
      x: 0.15,
      y: 0.35,
      width: 0.7,
      height: 0.3,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const crop = await createSourcePageCropAsset({
      kind: 'raster',
      cropBox: sourceBox,
      sourceObjectIds: ['figure-source-region'],
      sourceBoxes: [sourceBox],
      width: 20,
      height: 10,
      pixels: new Uint8Array(20 * 10 * 4).fill(64),
    })
    const captionNode = reconstruction.paper.nodes.find(
      (node) => node.type === 'caption' && node.text === captionRun.text,
    )!
    const captionRegion = reconstruction.regions.find(
      (region) => region.kind === 'caption' && region.text === captionRun.text,
    )!
    const captionEvidence = reconstruction.provenance[captionNode.id]
    const figureNode = {
      id: 'source-crop-figure',
      type: 'figure' as const,
      objectType: 'figure' as const,
      title: 'Bounded source-page crop',
      relationships: {
        caption: captionNode.id,
        assets: [crop.id],
      },
      source: 'test',
    }
    const relationshipBoxes = [sourceBox, ...captionEvidence.boxes]
    const cropCandidate = {
      ...reconstruction,
      paper: {
        ...reconstruction.paper,
        nodes: reconstruction.paper.nodes.flatMap((node) =>
          node.id === captionNode.id ? [figureNode, node] : [node],
        ),
      },
      provenance: {
        ...reconstruction.provenance,
        [figureNode.id]: {
          confidence: 1,
          pages: [1],
          regionIds: [captionRegion.id],
          boxes: relationshipBoxes,
          links: [],
        },
      },
      assets: [crop],
      visualRelationships: [
        {
          id: 'source-crop-relationship',
          kind: 'figure' as const,
          label: 'Figure 1',
          captionRegionId: captionRegion.id,
          sourceRegionIds: [captionRegion.id],
          sourceObjectIds: ['figure-source-region'],
          assetIds: [crop.id],
          status: 'matched' as const,
          confidence: 1,
          evidence: ['source-page-crop'],
          candidates: [],
          sourceBoxes: relationshipBoxes,
          sourceText: '',
          altText: captionRun.text,
          altTextSource: 'caption' as const,
          canonicalNodeId: figureNode.id,
          captionNodeId: captionNode.id,
        },
      ],
    } satisfies PdfReconstruction
    const cropAssessment = assessPdfCompleteness({
      pages: cropCandidate.pages,
      paper: cropCandidate.paper,
      diagnostics: cropCandidate.diagnostics.filter(
        (diagnostic) => diagnostic.severity !== 'error',
      ),
      readingOrder: cropCandidate.readingOrder,
      regions: cropCandidate.regions,
      visualRelationships: cropCandidate.visualRelationships,
      assets: cropCandidate.assets,
      citationRelationships: cropCandidate.citationRelationships,
      provenance: cropCandidate.provenance,
      lineBoundaryDecisions: cropCandidate.lineBoundaryDecisions,
      unresolvedCorruptingJoinCount:
        cropCandidate.unresolvedCorruptingJoinCount,
      structurallyConsumedLineBoundaryCount:
        cropCandidate.structurallyConsumedLineBoundaryCount,
      inlineSpanLedger: {
        expected: cropCandidate.completeness.expectedInlineSpanCount,
        mapped: cropCandidate.completeness.mappedInlineSpanCount,
      },
      policy: cropCandidate.readiness.policy,
    })
    const withCrop = {
      ...cropCandidate,
      semanticSignals: cropAssessment.semanticSignals,
      completeness: cropAssessment.completeness,
      diagnostics: cropAssessment.diagnostics,
      readiness: cropAssessment.readiness,
    } satisfies PdfReconstruction

    const epub = await buildReadableEpub(
      withCrop.paper,
      withCrop,
      getTargetProfile('paperPro'),
    )
    const { files, manifest } = inspectEpub(
      epub.bytes,
      getTargetProfile('paperPro'),
    )
    const content = strFromU8(files['EPUB/content.xhtml'])
    const packaged = (
      manifest.assets as Array<Record<string, unknown>> | undefined
    )?.find((asset) => asset.sourceAssetId === crop.id)

    expect(content).toContain(`<img src="${crop.href}"`)
    expect(files[`EPUB/${crop.href}`]).toEqual(crop.bytes)
    expect(packaged).toMatchObject({
      rendition: 'source-page-crop',
      sourceCropBox: sourceBox,
      sourceAssetId: crop.id,
    })
  })
})

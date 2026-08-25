import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  NodeSourceEvidence,
  PdfPageAnalysis,
  PdfPageRegion,
  PdfVisualAsset,
  PdfVisualRelationship,
} from './import-types'
import type { ResearchPaper } from './schema'
import { assessPdfCompleteness } from './pdf-quality'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import {
  createSourcePageCropAsset,
} from './visual-assets'
import {
  run,
  sourceBackedEquationFixture,
} from './pdf-quality.test-helpers'

describe('PDF semantic signal detection', () => {
  it('requires OCR evidence for a mixed raster page with only sparse embedded text', () => {
    const fixture = sourceBackedEquationFixture()
    const result = assessPdfCompleteness({
      pages: [
        {
          ...fixture.page,
          kind: 'mixed',
          imageCount: fixture.page.imageCount + 1,
          ocr: undefined,
        },
      ],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness.ocrRequiredPages).toEqual([1])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'OCR_REQUIRED',
          severity: 'error',
          page: 1,
        }),
      ]),
    )
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
      blockingDiagnosticCodes: expect.arrayContaining(['OCR_REQUIRED']),
    })
  })

  it('requires substantive internally valid OCR evidence for mixed and OCR-complete pages', () => {
    const fixture = sourceBackedEquationFixture()
    const evidence = {
      engine: 'local-engine',
      engineVersion: '1.0.0',
      model: 'local-model',
      modelVersion: '1.0.0',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: 'a'.repeat(64),
      rasterSha256: 'b'.repeat(64),
      confidence: 1,
      words: [],
      lines: [],
    } satisfies NonNullable<PdfPageAnalysis['ocr']>
    const invalidPages: PdfPageAnalysis[] = [
      {
        ...fixture.page,
        kind: 'mixed',
        imageCount: fixture.page.imageCount + 1,
        ocr: evidence,
      },
      {
        ...fixture.page,
        kind: 'ocr-complete',
        imageCount: fixture.page.imageCount + 1,
        ocr: undefined,
      },
      {
        ...fixture.page,
        kind: 'mixed',
        imageCount: fixture.page.imageCount + 1,
        ocr: { ...evidence, sourceSha256: 'not-a-sha256' },
      },
      {
        ...fixture.page,
        kind: 'mixed',
        imageCount: fixture.page.imageCount + 1,
        ocr: { ...evidence, sourceSha256: 'c'.repeat(64) },
      },
    ]

    for (const page of invalidPages) {
      const result = assessPdfCompleteness({
        pages: [page],
        paper: fixture.paper,
        diagnostics: [],
        regions: fixture.regions,
        readingOrder: fixture.readingOrder,
        provenance: fixture.provenance,
        visualRelationships: [fixture.relationship],
        assets: [fixture.asset],
        sourceSha256: 'a'.repeat(64),
      })

      expect(result.completeness.ocrRequiredPages).toEqual([1])
      expect(result.readiness.blockingDiagnosticCodes).toContain('OCR_REQUIRED')
    }
  })

  it('accepts page-bound recovered OCR content with matching source identity', () => {
    const fixture = sourceBackedEquationFixture()
    const acceptedRun = {
      ...run('Recovered', 0.2, 0.5, 10, 0.2),
      method: 'ocr' as const,
      fontName: 'OCR',
    }
    const ocr = {
      engine: 'local-engine',
      engineVersion: '1.0.0',
      model: 'local-model',
      modelVersion: '1.0.0',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: 'a'.repeat(64),
      rasterSha256: 'b'.repeat(64),
      confidence: 1,
      words: [
        {
          text: acceptedRun.text,
          confidence: 1,
          lineId: 'ocr-line-1',
          box: { ...acceptedRun },
          mergeStatus: 'accepted',
        },
      ],
      lines: [
        {
          id: 'ocr-line-1',
          text: acceptedRun.text,
          confidence: 1,
          box: { ...acceptedRun },
        },
      ],
    } satisfies NonNullable<PdfPageAnalysis['ocr']>
    const result = assessPdfCompleteness({
      pages: [
        {
          ...fixture.page,
          kind: 'mixed',
          imageCount: fixture.page.imageCount + 1,
          runs: [...fixture.page.runs, acceptedRun],
          ocr,
        },
      ],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
      sourceSha256: 'a'.repeat(64),
    })

    expect(result.completeness.ocrRequiredPages).toEqual([])
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'OCR_REQUIRED',
    )
  })

  it('accepts source-matched duplicate-only OCR confirmation for an embedded-only sparse page', () => {
    const fixture = sourceBackedEquationFixture()
    const embeddedRun = fixture.page.runs[0]
    const duplicateBox = {
      page: embeddedRun.page,
      x: embeddedRun.x,
      y: embeddedRun.y,
      width: embeddedRun.width,
      height: embeddedRun.height,
      rotation: embeddedRun.rotation,
      method: 'ocr' as const,
    }
    const result = assessPdfCompleteness({
      pages: [
        {
          ...fixture.page,
          kind: 'ocr-complete',
          imageCount: 0,
          objects: [],
          textCharacters: embeddedRun.text.replace(/\s/gu, '').length,
          runs: [embeddedRun],
          ocr: {
            engine: 'local-engine',
            engineVersion: '1.0.0',
            model: 'local-model',
            modelVersion: '1.0.0',
            languages: ['eng'],
            languageMode: 'explicit',
            sourceSha256: 'a'.repeat(64),
            rasterSha256: 'b'.repeat(64),
            confidence: 0.99,
            words: [
              {
                text: embeddedRun.text,
                confidence: 0.99,
                lineId: 'ocr-line-1',
                box: duplicateBox,
                mergeStatus: 'duplicate',
              },
            ],
            lines: [],
          },
        },
      ],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
      sourceSha256: 'a'.repeat(64),
    })

    expect(result.completeness.ocrRequiredPages).toEqual([])
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'OCR_REQUIRED',
    )
  })

  it('rejects duplicate-only OCR evidence that is not embedded-only and source-matched', () => {
    const fixture = sourceBackedEquationFixture()
    const embeddedRun = fixture.page.runs[0]
    const duplicateEvidence = {
      engine: 'local-engine',
      engineVersion: '1.0.0',
      model: 'local-model',
      modelVersion: '1.0.0',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: 'a'.repeat(64),
      rasterSha256: 'b'.repeat(64),
      confidence: 0.99,
      words: [
        {
          text: embeddedRun.text,
          confidence: 0.99,
          lineId: 'ocr-line-1',
          box: {
            page: embeddedRun.page,
            x: embeddedRun.x,
            y: embeddedRun.y,
            width: embeddedRun.width,
            height: embeddedRun.height,
            rotation: embeddedRun.rotation,
            method: 'ocr' as const,
          },
          mergeStatus: 'duplicate' as const,
        },
      ],
      lines: [],
    } satisfies NonNullable<PdfPageAnalysis['ocr']>
    const basePage = {
      ...fixture.page,
      kind: 'ocr-complete',
      imageCount: 0,
      objects: [],
      textCharacters: embeddedRun.text.replace(/\s/gu, '').length,
      runs: [embeddedRun],
      ocr: duplicateEvidence,
    } satisfies PdfPageAnalysis
    const invalidPages: PdfPageAnalysis[] = [
      {
        ...basePage,
        imageCount: 1,
        objects: fixture.page.objects,
      },
      {
        ...basePage,
        ocr: {
          ...duplicateEvidence,
          words: [
            {
              ...duplicateEvidence.words[0],
              text: 'Fabricated text',
            },
          ],
        },
      },
      {
        ...basePage,
        ocr: {
          ...duplicateEvidence,
          words: [
            {
              ...duplicateEvidence.words[0],
              box: {
                ...duplicateEvidence.words[0].box,
                x: 0.75,
              },
            },
          ],
        },
      },
      {
        ...basePage,
        ocr: {
          ...duplicateEvidence,
          sourceSha256: 'c'.repeat(64),
        },
      },
    ]

    for (const page of invalidPages) {
      const result = assessPdfCompleteness({
        pages: [page],
        paper: fixture.paper,
        diagnostics: [],
        regions: fixture.regions,
        readingOrder: fixture.readingOrder,
        provenance: fixture.provenance,
        visualRelationships: [fixture.relationship],
        assets: [fixture.asset],
        sourceSha256: 'a'.repeat(64),
      })

      expect(result.completeness.ocrRequiredPages).toEqual([1])
      expect(result.readiness.blockingDiagnosticCodes).toContain('OCR_REQUIRED')
    }
  })

  it('requires accepted OCR words to be page-bound and present in recovered runs', () => {
    const fixture = sourceBackedEquationFixture()
    const acceptedBox = {
      page: 1,
      x: 0.2,
      y: 0.5,
      width: 0.2,
      height: 0.02,
      rotation: 0,
      method: 'ocr' as const,
    }
    const evidence = {
      engine: 'local-engine',
      engineVersion: '1.0.0',
      model: 'local-model',
      modelVersion: '1.0.0',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: 'a'.repeat(64),
      rasterSha256: 'b'.repeat(64),
      confidence: 1,
      words: [
        {
          text: 'Recovered',
          confidence: 1,
          lineId: 'ocr-line-1',
          box: acceptedBox,
          mergeStatus: 'accepted',
        },
      ],
      lines: [
        {
          id: 'ocr-line-1',
          text: 'Recovered',
          confidence: 1,
          box: acceptedBox,
        },
      ],
    } satisfies NonNullable<PdfPageAnalysis['ocr']>
    const missingRecoveredRun = {
      ...fixture.page,
      kind: 'mixed',
      imageCount: fixture.page.imageCount + 1,
      ocr: evidence,
    } satisfies PdfPageAnalysis
    const outOfBounds = {
      ...fixture.page,
      kind: 'mixed',
      imageCount: fixture.page.imageCount + 1,
      runs: [
        ...fixture.page.runs,
        {
          ...fixture.page.runs[0],
          text: 'Recovered',
          method: 'ocr',
          x: 1.1,
          y: 0.5,
          width: 0.2,
          height: 0.02,
        },
      ],
      ocr: {
        ...evidence,
        words: [
          {
            ...evidence.words[0],
            box: { ...acceptedBox, x: 1.1 },
          },
        ],
        lines: [
          {
            ...evidence.lines[0],
            box: { ...acceptedBox, x: 1.1 },
          },
        ],
      },
    } satisfies PdfPageAnalysis

    for (const page of [missingRecoveredRun, outOfBounds]) {
      const result = assessPdfCompleteness({
        pages: [page],
        paper: fixture.paper,
        diagnostics: [],
        regions: fixture.regions,
        readingOrder: fixture.readingOrder,
        provenance: fixture.provenance,
        visualRelationships: [fixture.relationship],
        assets: [fixture.asset],
      })

      expect(result.completeness.ocrRequiredPages).toEqual([1])
      expect(result.readiness.blockingDiagnosticCodes).toContain('OCR_REQUIRED')
    }
  })

  it('does not require OCR when every mixed-page object is a validated semantic visual', () => {
    const fixture = sourceBackedEquationFixture()
    const result = assessPdfCompleteness({
      pages: [{ ...fixture.page, kind: 'mixed', ocr: undefined }],
      paper: fixture.paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: fixture.provenance,
      visualRelationships: [fixture.relationship],
      assets: [fixture.asset],
    })

    expect(result.completeness.ocrRequiredPages).toEqual([])
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'OCR_REQUIRED',
    )
  })

  it('counts hundreds of native primitives in one claimed visual as one semantic obligation', async () => {
    const fixture = sourceBackedEquationFixture()
    const sourceObjectIds = Array.from(
      { length: 400 },
      (_, index) => `figure-fragment-${index + 1}`,
    )
    const sourceBoxes = sourceObjectIds.map((_, index) => ({
      page: 1,
      x: 0.2 + (index % 20) * 0.012,
      y: 0.3 + Math.floor(index / 20) * 0.005,
      width: 0.012,
      height: 0.005,
      rotation: 0,
      method: 'pdf-object' as const,
    }))
    const cropBox = {
      page: 1,
      x: 0.19,
      y: 0.29,
      width: 0.26,
      height: 0.12,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const pixels = new Uint8Array(8 * 8 * 4).fill(255)
    for (const pixel of [9, 18, 27, 36]) {
      pixels.fill(0, pixel * 4, pixel * 4 + 3)
      pixels[pixel * 4 + 3] = 255
    }
    const asset = await createSourcePageCropAsset({
      kind: 'raster',
      cropBox,
      sourceObjectIds,
      sourceBoxes,
      width: 8,
      height: 8,
      pixels,
    })
    const captionNode = fixture.paper.nodes.find(
      (node) => node.type === 'caption',
    )!
    const paper = {
      ...fixture.paper,
      nodes: [
        {
          id: 'figure-1',
          type: 'figure',
          objectType: 'figure',
          title: 'Figure 1',
          relationships: { caption: captionNode.id, assets: [asset.id] },
          source: 'test',
        },
        captionNode,
      ],
    } satisfies ResearchPaper
    const relationship = {
      ...fixture.relationship,
      kind: 'figure',
      label: 'Figure 1',
      sourceRegionIds: ['figure-region'],
      sourceObjectIds,
      assetIds: [asset.id],
      sourceBoxes: [fixture.relationship.sourceBoxes[0], ...sourceBoxes],
      sourceText: '',
      canonicalNodeId: 'figure-1',
    } satisfies PdfVisualRelationship
    const page = {
      ...fixture.page,
      imageCount: 0,
      objects: sourceObjectIds.map((id, index) => ({
        id,
        page: 1,
        kind: 'vector' as const,
        box: sourceBoxes[index],
        confidence: 1,
        assetId: asset.id,
      })),
    } satisfies PdfPageAnalysis
    const result = assessPdfCompleteness({
      pages: [page],
      paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: {
        ...fixture.provenance,
        'figure-1': {
          confidence: 1,
          pages: [1],
          regionIds: ['figure-region'],
          boxes: relationship.sourceBoxes,
          links: [],
        },
      },
      visualRelationships: [relationship],
      assets: [asset],
    })

    expect(result.completeness).toMatchObject({
      sourceAssetCount: 1,
      exportedAssetCount: 1,
      assetCoverage: 1,
    })
  })

  it('counts multi-asset relationship components separately from unique validated assets', () => {
    const fixture = sourceBackedEquationFixture()
    const secondBytes = new TextEncoder().encode('SECOND-SOURCE-FRAGMENT')
    const secondSha256 = createHash('sha256').update(secondBytes).digest('hex')
    const secondAssetId = `asset-${secondSha256.slice(0, 24)}`
    const secondBox = {
      page: 1,
      x: 0.39,
      y: 0.3,
      width: 0.12,
      height: 0.018,
      rotation: 0,
      method: 'pdf-object' as const,
    }
    const secondAsset = {
      ...fixture.asset,
      id: secondAssetId,
      href: `assets/${secondAssetId}.png`,
      sha256: secondSha256,
      bytes: secondBytes,
      sourceObjectIds: ['equation-object-2'],
      sourceBoxes: [secondBox],
    } satisfies PdfVisualAsset
    const relationship = {
      ...fixture.relationship,
      kind: 'figure',
      sourceObjectIds: ['equation-object', 'equation-object-2'],
      assetIds: [fixture.asset.id, secondAsset.id],
      sourceBoxes: [
        fixture.relationship.sourceBoxes[0],
        fixture.asset.sourceBoxes[0],
        secondBox,
      ],
      sourceText: '',
    } satisfies PdfVisualRelationship
    const paper = {
      ...fixture.paper,
      nodes: fixture.paper.nodes.map((node) =>
        node.type === 'figure'
          ? {
              ...node,
              objectType: 'figure' as const,
              relationships: {
                ...node.relationships,
                assets: [fixture.asset.id, secondAsset.id],
              },
            }
          : node,
      ),
    } satisfies ResearchPaper
    const result = assessPdfCompleteness({
      pages: [
        {
          ...fixture.page,
          objects: [
            ...fixture.page.objects!,
            {
              id: 'equation-object-2',
              page: 1,
              kind: 'image',
              box: secondBox,
              confidence: 1,
              assetId: secondAsset.id,
            },
          ],
        },
      ],
      paper,
      diagnostics: [],
      regions: fixture.regions,
      readingOrder: fixture.readingOrder,
      provenance: {
        ...fixture.provenance,
        'equation-1': {
          ...fixture.provenance['equation-1'],
          boxes: relationship.sourceBoxes,
        },
      },
      visualRelationships: [relationship],
      assets: [fixture.asset, secondAsset],
    })

    expect(result.completeness).toMatchObject({
      sourceAssetCount: 2,
      exportedAssetCount: 2,
      assetCoverage: 1,
    })
  })

  it('counts a shared content-addressed asset once for each validated relationship component', () => {
    const fixture = sourceBackedEquationFixture()
    const firstCaptionRegion = fixture.regions[0]
    const secondCaptionRun = run(
      'Figure 2. Reused source glyph.',
      0.2,
      0.4,
      10,
      0.4,
    )
    const secondCaptionRegion = {
      ...firstCaptionRegion,
      id: 'caption-region-2',
      text: secondCaptionRun.text,
      box: { ...secondCaptionRun },
      lines: [
        {
          ...firstCaptionRegion.lines[0],
          id: 'caption-region-2-line',
          text: secondCaptionRun.text,
          box: { ...secondCaptionRun },
          runs: [{ ...secondCaptionRun }],
        },
      ],
    } satisfies PdfPageRegion
    const firstRelationship = {
      ...fixture.relationship,
      kind: 'figure',
      label: 'Figure 1',
      sourceRegionIds: [],
      sourceLineIds: [],
      canonicalNodeId: 'figure-1',
    } satisfies PdfVisualRelationship
    const secondRelationship = {
      ...firstRelationship,
      id: 'relationship-2',
      label: 'Figure 2',
      captionRegionId: secondCaptionRegion.id,
      sourceBoxes: [
        { ...secondCaptionRegion.box },
        { ...fixture.asset.sourceBoxes[0] },
      ],
      canonicalNodeId: 'figure-2',
      captionNodeId: 'caption-2',
    } satisfies PdfVisualRelationship
    const paper = {
      ...fixture.paper,
      nodes: [
        {
          id: 'figure-1',
          type: 'figure',
          objectType: 'figure',
          title: 'Figure 1',
          relationships: {
            caption: 'caption-1',
            assets: [fixture.asset.id],
          },
          source: 'test',
        },
        fixture.paper.nodes.find((node) => node.id === 'caption-1')!,
        {
          id: 'figure-2',
          type: 'figure',
          objectType: 'figure',
          title: 'Figure 2',
          relationships: {
            caption: 'caption-2',
            assets: [fixture.asset.id],
          },
          source: 'test',
        },
        {
          id: 'caption-2',
          type: 'caption',
          text: secondCaptionRun.text,
          source: 'test',
        },
      ],
    } satisfies ResearchPaper
    const provenance = {
      'figure-1': {
        confidence: 1,
        pages: [1],
        regionIds: [],
        boxes: firstRelationship.sourceBoxes.map((box) => ({ ...box })),
        links: [],
      },
      'caption-1': fixture.provenance['caption-1'],
      'figure-2': {
        confidence: 1,
        pages: [1],
        regionIds: [],
        boxes: secondRelationship.sourceBoxes.map((box) => ({ ...box })),
        links: [],
      },
      'caption-2': {
        confidence: 1,
        pages: [1],
        regionIds: [secondCaptionRegion.id],
        boxes: [{ ...secondCaptionRegion.box }],
        links: [],
      },
    } satisfies Record<string, NodeSourceEvidence>
    const relationships = [firstRelationship, secondRelationship]

    expect(
      validatedPdfVisualRelationships({
        paper,
        provenance,
        relationships,
        assets: [fixture.asset],
        regions: [firstCaptionRegion, secondCaptionRegion],
      }),
    ).toHaveLength(2)

    const result = assessPdfCompleteness({
      pages: [
        {
          ...fixture.page,
          textCharacters:
            firstCaptionRegion.text.length + secondCaptionRegion.text.length,
          runs: [
            ...firstCaptionRegion.lines[0].runs,
            ...secondCaptionRegion.lines[0].runs,
          ],
        },
      ],
      paper,
      diagnostics: [],
      regions: [firstCaptionRegion, secondCaptionRegion],
      provenance,
      visualRelationships: relationships,
      assets: [fixture.asset],
      canonicalHyphenBoundaryDecisions: [],
      canonicalHyphenBoundaryDecisionCount: 0,
    })

    expect(result.completeness).toMatchObject({
      sourceAssetCount: 2,
      exportedAssetCount: 2,
      assetCoverage: 1,
    })
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'INCOMPLETE_ASSET_COVERAGE',
    )
  })
})

import { describe, expect, it } from 'vitest'

import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import { assessPdfCompleteness } from './pdf-quality'

function run(
  page: number,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
): PdfSourceRun {
  return {
    page,
    text,
    x,
    y,
    width,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
    fontName: fontSize > 12 ? 'Heading' : 'Body',
    fontSize,
    confidence: 1,
  }
}

function page(
  number: number,
  runs: PdfSourceRun[],
  kind: PdfPageAnalysis['kind'] = 'born-digital',
): PdfPageAnalysis {
  return {
    page: number,
    kind,
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: kind === 'born-digital' ? 0 : 1,
    runs,
  }
}

function withExplicitEnglishLanguage(page: PdfPageAnalysis): PdfPageAnalysis {
  return {
    ...page,
    ocr: {
      engine: 'test-language-authority',
      engineVersion: '1',
      model: 'test-en',
      modelVersion: '1',
      languages: ['eng'],
      languageMode: 'explicit',
      sourceSha256: '1'.repeat(64),
      rasterSha256: '2'.repeat(64),
      confidence: 1,
      words: [],
      lines: [],
    },
  }
}

describe('PDF semantic reconstruction', () => {
  it('preserves an immediate cross-page bibliography continuation', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Paper', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Introductory prose.', 0.1, 0.26, 0.72),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.12, 0.3, 16),
          run(2, '[1] An unfinished reference entry', 0.1, 0.84, 0.72),
        ]),
        page(3, [
          run(3, 'continued details complete the reference.', 0.1, 0.12, 0.72),
        ]),
      ],
      sourceHash: '8'.repeat(64),
      fileName: 'contiguous-reference-continuation.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(references).toHaveLength(1)
    expect(references[0]).toMatchObject({
      text: 'An unfinished reference entry continued details complete the reference.',
      list: {
        numberingId: 'references',
        markerText: '[1]',
        ordinal: 1,
        continuedFromPreviousPage: true,
      },
    })
    expect(result.provenance[references[0].id].regionIds).toHaveLength(2)
  })

  it('recovers hanging-indent bibliography entries with exact source-line provenance', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
          run(
            1,
            'Prior work (Ahn et al., 2024; Biderman et al., 2023) establishes the baseline.',
            0.1,
            0.24,
            0.72,
          ),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, 'Ahn, J., Verma, R., and Yin,', 0.1, 0.2, 0.55),
          run(
            2,
            'W. Large language models for reasoning, 2024.',
            0.12,
            0.22,
            0.6,
          ),
          run(2, 'Biderman, S., and Example, A.', 0.1, 0.25, 0.55),
          run(2, 'Pythia at scale, 2023.', 0.12, 0.27, 0.5),
        ]),
      ],
      sourceHash: 'a'.repeat(64),
      fileName: 'hanging-indent-references.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(references.map((node) => node.text)).toEqual([
      'Ahn, J., Verma, R., and Yin, W. Large language models for reasoning, 2024.',
      'Biderman, S., and Example, A. Pythia at scale, 2023.',
    ])
    expect(
      references.every((node) => node.list?.markerText === undefined),
    ).toBe(true)
    expect(
      references.every(
        (node) =>
          node.list?.ordered === false && node.list.ordinal === undefined,
      ),
    ).toBe(true)
    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['ahn:2024'],
        status: 'matched',
        targetNodeIds: [references[0].id],
      }),
      expect.objectContaining({
        labels: ['biderman:2023'],
        status: 'matched',
        targetNodeIds: [references[1].id],
      }),
    ])
    expect(
      references.map((node) =>
        result.provenance[node.id].boxes.map((box) => box.x),
      ),
    ).toEqual([
      [0.1, 0.12],
      [0.1, 0.12],
    ])
  })

  it('retains exact citation boxes across a whitespace-only wrapped source gap', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Wrapped Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
          run(1, 'Prior work (Ahn et al.,', 0.1, 0.24, 0.31),
          run(1, '2024) establishes the baseline.', 0.43, 0.24, 0.4),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, 'Ahn, J., Verma, R., and Yin,', 0.1, 0.2, 0.55),
          run(
            2,
            'W. Large language models for reasoning, 2024.',
            0.12,
            0.22,
            0.6,
          ),
          run(2, 'Biderman, S., and Example, A.', 0.1, 0.25, 0.55),
          run(2, 'Pythia at scale, 2023.', 0.12, 0.27, 0.5),
        ]),
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'whitespace-wrapped-citation.pdf',
      byteLength: 4096,
    })
    const relationship = result.citationRelationships.find(
      ({ label }) => label === 'ahn:2024',
    )

    expect(relationship).toMatchObject({
      status: 'matched',
      targets: [
        expect.objectContaining({
          label: 'ahn:2024',
          sourceBoxes: [
            expect.objectContaining({
              page: 1,
              x: expect.closeTo(0.262, 3),
              y: 0.24,
              method: 'pdf-text',
            }),
            expect.objectContaining({
              page: 1,
              x: 0.43,
              y: 0.24,
              method: 'pdf-text',
            }),
          ],
        }),
      ],
    })
  })

  it('resolves a replayed Lam-ple citation against a Lample entry recovered from mid-region', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        withExplicitEnglishLanguage(
          page(1, [
            run(
              1,
              'Recovered bibliography citation topology',
              0.1,
              0.08,
              0.72,
              22,
            ),
            run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
            run(1, 'Prior work (Lam-', 0.1, 0.24, 0.72),
            run(
              1,
              'ple et al., 2018) establishes the baseline.',
              0.1,
              0.262,
              0.72,
            ),
          ]),
        ),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, 'Prior, A. Earlier reference entry.', 0.1, 0.2, 0.65),
          run(2, 'The prior-entry tail ends here, 2017.', 0.12, 0.222, 0.63),
          run(
            2,
            'Lample, G., Ott, M., Conneau, A., Denoyer, L., and Ranzato, M.',
            0.1,
            0.244,
            0.72,
          ),
          run(
            2,
            'Phrase-based neural unsupervised machine translation, 2018.',
            0.12,
            0.266,
            0.68,
          ),
        ]),
      ],
      sourceHash: '6'.repeat(64),
      fileName: 'mid-region-lample-reference.pdf',
      byteLength: 4096,
    })
    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    const lampleTarget = references.find((node) =>
      node.text.startsWith('Lample, G.'),
    )
    const relationship = result.citationRelationships.find(
      ({ label }) => label === 'lam-ple:2018',
    )
    const classification = result.diagnostics
      .flatMap((diagnostic) =>
        diagnostic.noteMarkerClassification
          ? [diagnostic.noteMarkerClassification]
          : [],
      )
      .find(
        (candidate) =>
          candidate.taxonomy === 'author-year-bibliography-citation' &&
          candidate.label === 'lam-ple:2018',
      )
    const sourceRegion = classification
      ? result.regions.find(({ id }) => id === classification.referenceRegionId)
      : undefined
    const anchorOwner = relationship?.canonicalAnchor
      ? result.paper.nodes.find(
          ({ id }) => id === relationship.canonicalAnchor?.nodeId,
        )
      : undefined

    expect(references.map(({ text }) => text)).toEqual([
      'Prior, A. Earlier reference entry. The prior-entry tail ends here, 2017.',
      'Lample, G., Ott, M., Conneau, A., Denoyer, L., and Ranzato, M. Phrase-based neural unsupervised machine translation, 2018.',
    ])
    expect(lampleTarget).toBeDefined()
    expect(relationship).toMatchObject({
      labels: ['lam-ple:2018'],
      status: 'matched',
      targetNodeIds: [lampleTarget?.id],
      evidence: expect.arrayContaining([
        'author-year-key-normalized-from-unresolved-line-boundary-hyphen',
        'bibliography-author-year-key-unique',
      ]),
      canonicalAnchor: {
        nodeId: expect.any(String),
        start: expect.any(Number),
        end: expect.any(Number),
      },
    })
    expect(classification).toMatchObject({
      label: 'lam-ple:2018',
      start: 'Prior work ('.length,
      end: 'Prior work ('.length + 'Lam-ple et al., 2018'.length,
      evidence: expect.not.arrayContaining([
        'author-year-key-normalized-from-unresolved-line-boundary-hyphen',
      ]),
    })
    expect(
      sourceRegion && classification
        ? sourceRegion.text.slice(classification.start, classification.end)
        : null,
    ).toBe('Lam-ple et al., 2018')
    expect(
      anchorOwner && 'text' in anchorOwner && relationship?.canonicalAnchor
        ? anchorOwner.text.slice(
            relationship.canonicalAnchor.start,
            relationship.canonicalAnchor.end,
          )
        : null,
    ).toBe('Lam-ple et al., 2018')
    expect(
      result.lineBoundaryDecisions.filter(
        (decision) =>
          decision.outcome === 'unresolved' &&
          decision.regionId === classification?.referenceRegionId,
      ),
    ).toHaveLength(1)

    if (!relationship?.canonicalAnchor || !lampleTarget) {
      throw new Error('missing matched Lam-ple citation fixture')
    }
    const wrongTarget = references.find((node) => node.id !== lampleTarget.id)
    const tamperedPaper = structuredClone(result.paper)
    const tamperedRelationships = structuredClone(result.citationRelationships)
    const tamperedRelationship = tamperedRelationships.find(
      ({ id }) => id === relationship.id,
    )
    const tamperedAnchorOwner = tamperedPaper.nodes.find(
      ({ id }) => id === relationship.canonicalAnchor?.nodeId,
    )
    const tamperedInlineRun =
      tamperedAnchorOwner && 'inlineRuns' in tamperedAnchorOwner
        ? tamperedAnchorOwner.inlineRuns?.find(
            ({ relationshipId }) => relationshipId === relationship.id,
          )
        : undefined
    if (
      !wrongTarget ||
      !tamperedRelationship?.targets?.[0] ||
      !tamperedInlineRun
    ) {
      throw new Error('missing adversarial author-year target fixture')
    }
    tamperedRelationship.targetNodeIds = [wrongTarget.id]
    tamperedRelationship.targets[0].targetNodeId = wrongTarget.id
    tamperedInlineRun.targetIds = [wrongTarget.id]

    const tamperedCompleteness = assessPdfCompleteness({
      pages: result.pages,
      paper: tamperedPaper,
      diagnostics: [],
      regions: result.regions,
      readingOrder: result.readingOrder,
      provenance: result.provenance,
      visualRelationships: result.visualRelationships,
      assets: result.assets,
      citationRelationships: tamperedRelationships,
      noteRelationships: result.noteRelationships,
      lineBoundaryDecisions: result.lineBoundaryDecisions,
      inlineSpanLedger: {
        expected: result.completeness.expectedInlineSpanCount,
        mapped: result.completeness.mappedInlineSpanCount,
      },
    })
    expect(tamperedCompleteness.completeness.unresolvedObjects.citations).toBe(
      1,
    )
  })

  it('keeps missing, duplicate, and preserved Lam-ple alternates unresolved', async () => {
    const reconstructVariant = (
      variant: 'missing' | 'duplicate' | 'preserved',
      hashCharacter: string,
    ) =>
      reconstructPageAnalyses({
        pages: [
          withExplicitEnglishLanguage(
            page(1, [
              run(
                1,
                'Fail-closed citation alternate topology',
                0.1,
                0.08,
                0.72,
                22,
              ),
              run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
              ...(variant === 'preserved'
                ? [
                    run(
                      1,
                      'The Lam-ple benchmark retains its authored compound.',
                      0.1,
                      0.2,
                      0.72,
                    ),
                  ]
                : []),
              run(1, 'Prior work (Lam-', 0.1, 0.24, 0.72),
              run(
                1,
                'ple et al., 2018) establishes the baseline.',
                0.1,
                0.262,
                0.72,
              ),
            ]),
          ),
          page(2, [
            run(2, 'References', 0.1, 0.1, 0.3, 16),
            run(2, 'Prior, A. Earlier reference entry.', 0.1, 0.2, 0.65),
            run(2, 'The prior-entry tail ends here, 2017.', 0.12, 0.222, 0.63),
            ...(variant === 'missing'
              ? []
              : [
                  run(
                    2,
                    'Lample, G. Canonical reference entry, 2018.',
                    0.1,
                    0.244,
                    0.7,
                  ),
                  ...(variant === 'duplicate'
                    ? [
                        run(
                          2,
                          'Lample, M. Competing canonical entry, 2018.',
                          0.1,
                          0.288,
                          0.7,
                        ),
                      ]
                    : []),
                ]),
          ]),
        ],
        sourceHash: hashCharacter.repeat(64),
        fileName: `${variant}-lample-alternate.pdf`,
        byteLength: 4096,
      })

    for (const [variant, hashCharacter] of [
      ['missing', '7'],
      ['duplicate', '8'],
      ['preserved', '9'],
    ] as const) {
      const result = await reconstructVariant(variant, hashCharacter)
      const relationship = result.citationRelationships.find(
        ({ label }) => label === 'lam-ple:2018',
      )
      expect(relationship).toMatchObject({
        labels: ['lam-ple:2018'],
        status: 'unresolved',
        targetNodeIds: [],
        evidence: expect.not.arrayContaining([
          'author-year-key-normalized-from-unresolved-line-boundary-hyphen',
        ]),
      })
      if (variant === 'preserved') {
        expect(result.lineBoundaryDecisions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              outcome: 'preserved-lexical-hyphen',
              evidence: expect.arrayContaining([
                'hard-hyphen-form-valid:same-document',
              ]),
            }),
          ]),
        )
      }
    }
  })

  it('keeps one markerless bibliography entry when justified fragments share source baselines', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
          run(
            1,
            'The study establishes a source-backed baseline.',
            0.1,
            0.24,
            0.7,
          ),
        ]),
        page(
          2,
          [
            run(1, 'References', 0.08, 0.1, 0.2, 16),
            run(1, 'Alpha, A. A left-column reference', 0.08, 0.2, 0.35),
            run(1, 'continues with details in 2019.', 0.1, 0.22, 0.33),
            run(1, 'Beta, B. A second left reference', 0.08, 0.28, 0.35),
            run(1, 'continues with details in 2020.', 0.1, 0.3, 0.33),
            run(1, 'Gamma, C. A third left reference', 0.08, 0.36, 0.35),
            run(1, 'continues with details in 2021.', 0.1, 0.38, 0.33),
            run(1, 'nostalgebraist.', 0.52, 0.2, 0.095),
            run(1, 'interpreting', 0.69, 0.2, 0.078),
            run(1, 'GPT:', 0.8, 0.2, 0.036),
            run(1, 'the', 0.865, 0.2, 0.02),
            run(1, 'logit', 0.54, 0.22, 0.03),
            run(1, 'lens', 0.585, 0.22, 0.027),
            run(1, '—', 0.645, 0.22, 0.017),
            run(1, 'LessWrong', 0.695, 0.22, 0.077),
            run(1, '—', 0.807, 0.22, 0.017),
            run(1, 'less-wrong.com.', 0.54, 0.24, 0.12),
            run(1, 'https://example.test/logit-lens, 2020.', 0.54, 0.26, 0.33),
            run(1, 'Olah, C. An independent right reference', 0.52, 0.32, 0.36),
            run(1, 'continues with details in 2021.', 0.54, 0.34, 0.33),
            run(1, 'Pi, D. A second right reference', 0.52, 0.4, 0.36),
            run(1, 'continues with details in 2022.', 0.54, 0.42, 0.33),
            run(1, 'Rho, E. A third right reference', 0.52, 0.48, 0.36),
            run(1, 'continues with details in 2023.', 0.54, 0.5, 0.33),
          ].map((sourceRun) => ({ ...sourceRun, page: 2 })),
        ),
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'fragmented-justified-bibliography.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(references.map((node) => node.text)).toEqual([
      'Alpha, A. A left-column reference continues with details in 2019.',
      'Beta, B. A second left reference continues with details in 2020.',
      'Gamma, C. A third left reference continues with details in 2021.',
      'nostalgebraist. interpreting GPT: the logit lens — LessWrong — less-wrong.com. https://example.test/logit-lens, 2020.',
      'Olah, C. An independent right reference continues with details in 2021.',
      'Pi, D. A second right reference continues with details in 2022.',
      'Rho, E. A third right reference continues with details in 2023.',
    ])
    expect(
      result.provenance[references[3].id].regionIds.length,
    ).toBeGreaterThan(1)
    expect(
      references.every(
        (node) =>
          node.list?.ordered === false &&
          node.list.markerText === undefined &&
          node.list.ordinal === undefined,
      ),
    ).toBe(true)
  })

  it('uses a stable hanging-indent profile to preserve cross-page bibliography cardinality', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
          run(1, 'Prior work motivates the study.', 0.1, 0.24, 0.72),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, 'Earlier, A. A complete reference title', 0.1, 0.2, 0.55),
          run(2, 'appeared in the venue in 2023.', 0.12, 0.22, 0.55),
          run(2, 'Alpha, B. A reference that continues', 0.1, 0.82, 0.55),
          run(2, 'with publication details on the next', 0.12, 0.84, 0.55),
        ]),
        page(3, [
          run(3, 'page and completes in 2024.', 0.12, 0.1, 0.55),
          run(3, 'The venue is Journal of Examples.', 0.12, 0.12, 0.55),
          run(3, 'Beta, C. An independent reference, 2025.', 0.1, 0.15, 0.6),
        ]),
      ],
      sourceHash: 'f'.repeat(64),
      fileName: 'cross-page-hanging-indent-cardinality.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(references.map((node) => node.text)).toEqual([
      'Earlier, A. A complete reference title appeared in the venue in 2023.',
      'Alpha, B. A reference that continues with publication details on the next page and completes in 2024. The venue is Journal of Examples.',
      'Beta, C. An independent reference, 2025.',
    ])
    expect(references[1].list?.continuedFromPreviousPage).toBe(true)
    expect(result.provenance[references[1].id].pages).toEqual([2, 3])
  })

  it('does not mistake the final digit of a wrapped year for bibliography item zero', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'References', 0.1, 0.14, 0.3, 16),
          run(1, 'Liu, X. Example reference published in', 0.1, 0.2, 0.6),
          run(1, 'Proceedings of Examples, 202', 0.12, 0.22, 0.55),
          run(1, '0. doi: 10.1000/example.', 0.12, 0.29, 0.5),
          run(1, 'Beta, C. Independent reference, 2025.', 0.1, 0.35, 0.6),
          run(1, 'Journal of Examples.', 0.12, 0.37, 0.5),
        ]),
      ],
      sourceHash: '0'.repeat(64),
      fileName: 'wrapped-year-zero-marker.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(references.map((node) => node.text)).toEqual([
      'Liu, X. Example reference published in Proceedings of Examples, 2020. doi: 10.1000/example.',
      'Beta, C. Independent reference, 2025. Journal of Examples.',
    ])
    expect(
      references.some(
        (node) =>
          node.list?.ordered === true || node.list?.ordinal !== undefined,
      ),
    ).toBe(false)
  })

  it('does not mistake a wrapped page-range endpoint for a numbered bibliography item', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'References', 0.1, 0.14, 0.3, 16),
          run(1, 'Singh, S. Conference proceedings, pp. 36–', 0.1, 0.2, 0.64),
          run(1, '49. IEEE Computer Society, 2024.', 0.12, 0.27, 0.55),
          run(1, 'Beta, C. Independent reference, 2025.', 0.1, 0.33, 0.6),
          run(1, 'Journal of Examples.', 0.12, 0.35, 0.5),
        ]),
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'wrapped-page-range-marker.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(references.map((node) => node.text)).toEqual([
      'Singh, S. Conference proceedings, pp. 36–49. IEEE Computer Society, 2024.',
      'Beta, C. Independent reference, 2025. Journal of Examples.',
    ])
    expect(
      references.some(
        (node) =>
          node.list?.ordered === true || node.list?.ordinal !== undefined,
      ),
    ).toBe(false)
  })

  it('merges a hanging-indent bibliography continuation whose first extracted line is a right-edge fragment', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'References', 0.1, 0.14, 0.3, 16),
          run(1, 'Lee, C., Cheng, H., and Ostendorf, M.', 0.1, 0.2, 0.6),
          run(
            1,
            '2021. Dialogue state tracking with a language model.',
            0.12,
            0.23,
            0.5,
          ),
          run(1, 'arXiv', 0.68, 0.23, 0.04),
          run(1, 'preprint arXiv:2109.07506.', 0.12, 0.26, 0.3),
          run(1, 'Next, A. 2022. Independent reference.', 0.1, 0.31, 0.6),
          run(1, 'Journal of Examples.', 0.12, 0.34, 0.3),
        ]),
      ],
      sourceHash: '6'.repeat(64),
      fileName: 'right-edge-reference-fragment.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'paragraph' && node.list?.numberingId === 'references'
          ? [node.text]
          : [],
      ),
    ).toEqual([
      'Lee, C., Cheng, H., and Ostendorf, M. 2021. Dialogue state tracking with a language model. arXiv preprint arXiv:2109.07506.',
      'Next, A. 2022. Independent reference. Journal of Examples.',
    ])
  })

  it('merges a punctuation-led bibliography fragment into its preceding entry', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'References', 0.1, 0.14, 0.3, 16),
          run(1, 'Earlier, A. A complete reference title', 0.1, 0.2, 0.6),
          run(1, 'appeared in the venue in 2023.', 0.12, 0.22, 0.55),
          run(
            1,
            'Cobbe, K., Kosaraju, V., and Schulman, J. Training Verifiers to Solve Math Word Problems.',
            0.1,
            0.91,
            0.72,
          ),
        ]),
        page(2, [
          run(
            2,
            ', November 2021. doi: 10.48550/arXiv.2110.14168.',
            0.1,
            0.08,
            0.62,
          ),
          run(2, 'Later, B. An independent reference', 0.1, 0.13, 0.6),
          run(2, 'appeared in the venue in 2024.', 0.12, 0.15, 0.55),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'punctuation-led-reference-fragment.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'paragraph' && node.list?.numberingId === 'references'
          ? [node.text]
          : [],
      ),
    ).toEqual([
      'Earlier, A. A complete reference title appeared in the venue in 2023.',
      'Cobbe, K., Kosaraju, V., and Schulman, J. Training Verifiers to Solve Math Word Problems., November 2021. doi: 10.48550/arXiv.2110.14168.',
      'Later, B. An independent reference appeared in the venue in 2024.',
    ])
  })

  it('resolves an author-year citation to an adjacent cross-page bibliography continuation', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
          run(
            1,
            'Prior work (Betley et al., 2025) establishes the baseline.',
            0.1,
            0.24,
            0.72,
          ),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(
            2,
            'Jan Betley, Daniel Tan, Niels Warncke, Anna Sztyber-Betley, and Owain Evans.',
            0.1,
            0.86,
            0.72,
          ),
        ]),
        page(3, [
          run(
            3,
            'Emergent misalignment: Narrow finetuning can produce broadly misaligned LLMs, 2025.',
            0.12,
            0.1,
            0.7,
          ),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'cross-page-split-reference.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(references.map((node) => node.text)).toEqual([
      'Jan Betley, Daniel Tan, Niels Warncke, Anna Sztyber-Betley, and Owain Evans.',
      'Emergent misalignment: Narrow finetuning can produce broadly misaligned LLMs, 2025.',
    ])
    expect(references[1].list?.continuedFromPreviousPage).toBe(true)
    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['betley:2025'],
        status: 'matched',
        targetNodeIds: [references[0].id],
      }),
    ])
    expect(result.provenance[references[0].id].pages).toEqual([2])
    expect(result.provenance[references[1].id].pages).toEqual([3])
  })

  it('does not join adjacent cross-page bibliography blocks without hanging-indent evidence', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
          run(
            1,
            'Prior work (Betley et al., 2025) establishes the baseline.',
            0.1,
            0.24,
            0.72,
          ),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(
            2,
            'Jan Betley, Daniel Tan, Niels Warncke, Anna Sztyber-Betley, and Owain Evans.',
            0.1,
            0.86,
            0.72,
          ),
        ]),
        page(3, [
          run(
            3,
            'Emergent misalignment: Narrow finetuning can produce broadly misaligned LLMs, 2025.',
            0.1,
            0.1,
            0.7,
          ),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'ambiguous-cross-page-references.pdf',
      byteLength: 4096,
    })

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['betley:2025'],
        status: 'unresolved',
        targetNodeIds: [],
        evidence: expect.arrayContaining([
          'bibliography-author-year-target-missing',
        ]),
      }),
    ])
  })

  it('fails closed instead of merging unmarked bibliography regions without an indentation profile', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Paper', 0.1, 0.08, 0.7, 22),
          run(1, 'References', 0.1, 0.16, 0.3, 16),
          run(1, 'Alpha reference fragment.', 0.1, 0.26, 0.6),
          run(1, 'Beta independent fragment.', 0.1, 0.36, 0.6),
        ]),
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'ambiguous-reference-indentation.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'paragraph' && node.list?.numberingId === 'references'
          ? [node.text]
          : [],
      ),
    ).toEqual(['Alpha reference fragment.', 'Beta independent fragment.'])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'LOW_CONFIDENCE_BLOCK',
          severity: 'warning',
          message: expect.stringContaining('bibliography item cardinality'),
        }),
      ]),
    )
  })

  it('does not merge a bibliography continuation across intervening canonical content', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Paper', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Introductory prose.', 0.1, 0.26, 0.72),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.12, 0.3, 16),
          run(2, '[1] An unfinished reference entry', 0.1, 0.84, 0.72),
        ]),
        page(3, [
          run(3, '2 Methods', 0.1, 0.12, 0.4, 16),
          run(
            3,
            'lowercase independent bibliography material.',
            0.1,
            0.24,
            0.72,
          ),
        ]),
      ],
      sourceHash: '9'.repeat(64),
      fileName: 'intervening-reference-content.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(references.map((node) => node.text)).toEqual([
      'An unfinished reference entry',
      'lowercase independent bibliography material.',
    ])
    expect(result.paper.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'heading',
          text: '2 Methods',
        }),
      ]),
    )
  })
})

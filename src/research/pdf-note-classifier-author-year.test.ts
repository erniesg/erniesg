import { describe, expect, it } from 'vitest'
import {
  decisiveNoteMarkerFixtures,
  type NoteMarkerFixture,
} from '../../tests/fixtures/note-marker-fixtures'
import type {
  PdfLineBoundaryDecision,
  PdfPageRegion,
  PdfSourceRun,
} from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'
import {
  classifyPdfNoteMarkers,
  pdfAlternateAuthorYearKeyFromBoundary,
} from './pdf-note-classifier'

function reconstruct(
  fixture: NoteMarkerFixture,
  hashCharacter: string,
  language?: string,
) {
  return reconstructPageAnalyses({
    pages: fixture.pages,
    sourceHash: hashCharacter.repeat(64),
    fileName: `${fixture.name.replace(/[^a-z0-9]+/gi, '-')}.pdf`,
    byteLength: 4096,
    metadata: language ? { language } : {},
  })
}

function noteRun(
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
  height = 0.018,
): PdfSourceRun {
  return {
    page: 1,
    text,
    x,
    y,
    width,
    height,
    rotation: 0,
    method: 'pdf-text',
    fontName: fontSize > 12 ? 'Heading' : 'Body',
    fontSize,
    confidence: 1,
  }
}

function authorYearRegion(
  id: string,
  page: number,
  texts: string[],
  y: number,
): PdfPageRegion {
  const lines = texts.map((text, index) => {
    const source = {
      ...noteRun(text, 0.1, y + index * 0.022, 0.72),
      page,
    }
    return {
      id: `${id}-line-${index + 1}`,
      text,
      fontSize: source.fontSize,
      box: { ...source },
      runs: [source],
    }
  })
  return {
    id,
    page,
    kind: 'body',
    column: 'single',
    text: texts.join(''),
    confidence: 1,
    box: {
      page,
      x: 0.1,
      y,
      width: 0.72,
      height: Math.max(0.018, texts.length * 0.022),
      rotation: 0,
      method: 'pdf-text',
    },
    lines,
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

function authorYearBoundaryDecision(
  region: PdfPageRegion,
  outcome: PdfLineBoundaryDecision['outcome'],
): PdfLineBoundaryDecision {
  return {
    id: `${region.id}-boundary`,
    page: region.page,
    regionId: region.id,
    fromLineId: region.lines[0].id,
    toLineId: region.lines[1].id,
    outcome,
    evidence: ['test-line-boundary'],
  }
}

describe('author-year citation resolution', () => {
  it('preserves an ordinary lexical surname hyphen in an author-year key', () => {
    const citation = authorYearRegion(
      'lexical-citation',
      1,
      ['Prior work (Smith-Jones et al., 2020) establishes the baseline.'],
      0.28,
    )
    const heading = authorYearRegion(
      'lexical-references',
      2,
      ['References'],
      0.12,
    )
    const bibliography = authorYearRegion(
      'lexical-bibliography',
      2,
      ['Smith-Jones, A. (2020). Reference entry.'],
      0.24,
    )

    expect(
      classifyPdfNoteMarkers(
        [citation, heading, bibliography],
        [citation.id, heading.id, bibliography.id],
      ).classifications.find(
        ({ taxonomy }) => taxonomy === 'author-year-bibliography-citation',
      ),
    ).toMatchObject({
      label: 'smith-jones:2020',
      evidence: expect.not.arrayContaining([
        'author-year-key-normalized-from-unresolved-line-boundary-hyphen',
      ]),
    })
  })

  it('resolves a boundary-normalized author key without changing its exact canonical anchor', async () => {
    const fixture: NoteMarkerFixture = {
      name: 'unresolved line-boundary author-year comparison key',
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: 84,
          imageCount: 0,
          runs: [
            { ...noteRun('Citation study', 0.1, 0.08, 0.72, 18), page: 1 },
            { ...noteRun('Abstract', 0.1, 0.18, 0.25, 16), page: 1 },
            { ...noteRun('Prior work (Hoff-', 0.1, 0.28, 0.72), page: 1 },
            {
              ...noteRun(
                'mann et al., 2020) establishes the baseline.',
                0.1,
                0.302,
                0.72,
              ),
              page: 1,
            },
          ],
        },
        {
          page: 2,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: 52,
          imageCount: 0,
          runs: [
            { ...noteRun('References', 0.1, 0.12, 0.3, 18), page: 2 },
            {
              ...noteRun(
                'Hoffmann, A. (2020). Reference entry.',
                0.1,
                0.24,
                0.72,
              ),
              page: 2,
            },
          ],
        },
      ],
      expectedTaxonomies: ['author-year-bibliography-citation'],
    }

    const result = await reconstruct(fixture, 'h', 'en-US')
    const [relationship] = result.citationRelationships
    const anchor = relationship.canonicalAnchor
    const owner = anchor
      ? result.paper.nodes.find((node) => node.id === anchor.nodeId)
      : undefined

    expect(relationship).toMatchObject({
      labels: ['hoff-mann:2020'],
      status: 'matched',
      targetNodeIds: [expect.stringMatching(/^p-/)],
      evidence: expect.arrayContaining([
        'author-year-key-normalized-from-unresolved-line-boundary-hyphen',
      ]),
    })
    expect(owner && 'text' in owner && anchor).toBeTruthy()
    if (!owner || !('text' in owner) || !anchor) return
    expect(owner.text.slice(anchor.start, anchor.end)).toBe(
      'Hoff-mann et al., 2020',
    )
    expect(owner.text).toContain('Hoff-mann et al., 2020')
    expect(result.lineBoundaryDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: 'unresolved',
          fromLineId: expect.any(String),
          toLineId: expect.any(String),
        }),
      ]),
    )
  })

  it('maps bounded author-year citations to unique canonical reference entries', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'author-year citations with unique reference entries'
    fixture.pages[0].runs[2].text =
      'Prior work (Ahn et al., 2024; Satpute et al., 2024) establishes the baseline.'
    fixture.pages[0].runs[3].text =
      'Nanda et al. (2023a) confirms it; an unbounded 2024 mention and standalone (2024) label are plain prose.'
    fixture.pages[1].runs[1].text =
      'Ahn, J., Example, A. (2024). First reference entry.'
    fixture.pages[1].runs[2].text =
      'Satpute, A., Example, B. 2024. Second reference entry.'
    fixture.pages[1].runs.push({
      ...fixture.pages[1].runs[2],
      text: 'Nanda, N., Example, C. (2023a). Third reference entry.',
      y: 0.36,
    })

    const result = await reconstruct(fixture, 'f')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        taxonomy: 'author-year-bibliography-citation',
        labels: ['ahn:2024'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
      expect.objectContaining({
        taxonomy: 'author-year-bibliography-citation',
        labels: ['satpute:2024'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
      expect.objectContaining({
        taxonomy: 'author-year-bibliography-citation',
        labels: ['nanda:2023a'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
    ])

    const expectedMarkers = [
      'Ahn et al., 2024',
      'Satpute et al., 2024',
      'Nanda et al. (2023a)',
    ]
    for (const [
      index,
      relationship,
    ] of result.citationRelationships.entries()) {
      const anchor = relationship.canonicalAnchor
      const owner = anchor
        ? result.paper.nodes.find((node) => node.id === anchor.nodeId)
        : undefined
      expect(anchor).not.toBeNull()
      expect(owner && 'text' in owner && anchor).toBeTruthy()
      if (!owner || !('text' in owner) || !anchor) continue
      expect(owner.text.slice(anchor.start, anchor.end)).toBe(
        expectedMarkers[index],
      )
      const citationRun =
        'inlineRuns' in owner
          ? owner.inlineRuns?.find(
              (run) => run.relationshipId === relationship.id,
            )
          : undefined
      expect(citationRun).toMatchObject({
        start: anchor.start,
        end: anchor.end,
        semanticRole: 'citation',
        targetIds: relationship.targetNodeIds,
      })
      expect(result.provenance[owner.id]?.regionIds).toContain(
        relationship.referenceRegionId,
      )
    }
  })

  it('maps common single and two-author forms only for unique exact bibliography keys', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'bibliography-backed single and two-author citations'
    fixture.pages[0].runs[2].text =
      'Prior work (Smith, 2020; Brown & Lee, 2021; Clark and Evans, 2022; Missing, 2020; Jones & Reader, 2019) establishes the baseline.'
    fixture.pages[0].runs[3].text =
      'Smith (2020), Brown & Lee (2021), and Clark and Evans (2022) confirm it; Missing (2020) and Jones & Reader (2019) remain ordinary prose.'
    fixture.pages[1].runs[1].text = 'Smith, A. (2020). First reference entry.'
    fixture.pages[1].runs[2].text =
      'Brown, B., and Lee, C. 2021. Second reference entry.'
    fixture.pages[1].runs.push(
      {
        ...fixture.pages[1].runs[2],
        text: 'Clark, C., and Evans, D. (2022). Third reference entry.',
        y: 0.36,
      },
      {
        ...fixture.pages[1].runs[2],
        text: 'Jones, J., and Reader, R. (2019). First ambiguous entry.',
        y: 0.42,
      },
      {
        ...fixture.pages[1].runs[2],
        text: 'Jones, K., and Reader, R. (2019). Second ambiguous entry.',
        y: 0.48,
      },
    )

    const result = await reconstruct(fixture, 'c')

    expect(
      result.citationRelationships.map(
        ({ labels, status, targetNodeIds, canonicalAnchor }) => ({
          labels,
          status,
          targetNodeIds,
          canonicalAnchor,
        }),
      ),
    ).toEqual(
      [
        'smith:2020',
        'brown:2021',
        'clark:2022',
        'smith:2020',
        'brown:2021',
        'clark:2022',
      ].map((label) => ({
        labels: [label],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
        canonicalAnchor: {
          nodeId: expect.stringMatching(/^p-/),
          start: expect.any(Number),
          end: expect.any(Number),
        },
      })),
    )
    expect(
      result.citationRelationships.flatMap((relationship) =>
        relationship.labels.filter((label) =>
          /^(?:missing|jones):/u.test(label),
        ),
      ),
    ).toEqual([])
  })

  it('maps given-name-first bibliography entries to author-year citations', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'given-name-first author-year bibliography entries'
    fixture.pages[0].runs[2].text =
      'Prior work (Askell et al., 2021; Bai et al., 2022) establishes the baseline.'
    fixture.pages[0].runs[3].text = 'The result remains reproducible.'
    fixture.pages[1].runs[1].text =
      'Amanda Askell, Yuntao Bai, Anna Chen, and Jared Kaplan. A general language assistant as a laboratory for alignment, 2021.'
    fixture.pages[1].runs[2].text =
      'Yuntao Bai, Andy Jones, Kamal Ndousse, and Amanda Askell. Training a helpful and harmless assistant, 2022.'

    const result = await reconstruct(fixture, 'g')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['askell:2021'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
      expect.objectContaining({
        labels: ['bai:2022'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
    ])
  })

  it('does not mistake bibliography pagination for competing publication years', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'author-year bibliography entry with year-shaped pages'
    fixture.pages[0].runs[2].text =
      'Prior work (Brown et al., 2020) establishes the baseline.'
    fixture.pages[0].runs[3].text = 'The result remains reproducible.'
    fixture.pages[1].runs[1].text =
      'Tom Brown, Benjamin Mann, Nick Ryder, and Melanie Subbiah. 2020. Language models are few-shot learners. Advances in neural information processing systems, 33:1877–1901.'
    fixture.pages[1].runs.splice(2)

    const result = await reconstruct(fixture, 'y')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['brown:2020'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
    ])
  })

  it('links resolvable members of a mixed author-year cluster without hiding unresolved members', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'partially resolvable author-year citation cluster'
    fixture.pages[0].runs[2].text =
      'Prior work (Askell et al., 2021; Unknown et al., 2025) establishes the baseline.'
    fixture.pages[0].runs[3].text = 'The result remains reproducible.'
    fixture.pages[1].runs[1].text =
      'Amanda Askell, Yuntao Bai, Anna Chen, and Jared Kaplan. A general language assistant as a laboratory for alignment, 2021.'
    fixture.pages[1].runs.splice(2)

    const result = await reconstruct(fixture, 'p')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['askell:2021'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
      expect.objectContaining({
        labels: ['unknown:2025'],
        status: 'unresolved',
        targetNodeIds: [],
        evidence: expect.arrayContaining([
          'bibliography-author-year-target-missing',
        ]),
      }),
    ])
    const owner = result.paper.nodes.find(
      (node) =>
        'text' in node &&
        node.text.includes('Askell et al., 2021; Unknown et al., 2025'),
    )
    expect(owner && 'text' in owner).toBe(true)
    if (!owner || !('text' in owner)) return
    const citationRuns =
      'inlineRuns' in owner
        ? (owner.inlineRuns ?? []).filter(
            (run) => run.semanticRole === 'citation',
          )
        : []
    expect(
      citationRuns.map((run) => ({
        text: owner.text.slice(run.start, run.end),
        targets: run.targetIds ?? [],
      })),
    ).toEqual([
      {
        text: 'Askell et al., 2021',
        targets: [expect.stringMatching(/^p-/)],
      },
      { text: 'Unknown et al., 2025', targets: [] },
    ])
    for (const relationship of result.citationRelationships) {
      expect(relationship.canonicalAnchor).not.toBeNull()
      expect(
        result.provenance[relationship.canonicalAnchor!.nodeId].regionIds,
      ).toContain(relationship.referenceRegionId)
    }
  })

  it('uses the publication year before a URL instead of an arXiv identifier year', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'publication year before arxiv identifier'
    fixture.pages[0].runs[2].text =
      'Hendrycks et al. (2021a) establishes the baseline.'
    fixture.pages[0].runs[3].text = 'The result remains reproducible.'
    fixture.pages[1].runs[1].text =
      'Dan Hendrycks, Collin Burns, Steven Basart, and Jacob Steinhardt. Measuring massive multitask language understanding, 2021a. URL https://arxiv.org/abs/2009.03300.'
    fixture.pages[1].runs.splice(2)

    const result = await reconstruct(fixture, 'y')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['hendrycks:2021a'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
    ])
  })

  it('uses the publication year before a bare arXiv identifier', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'publication year before bare arxiv identifier'
    fixture.pages[0].runs[2].text =
      'Brahman et al. (2020) establishes the baseline.'
    fixture.pages[0].runs[3].text = 'The result remains reproducible.'
    fixture.pages[1].runs[1].text =
      'Faeze Brahman, Alexandru Petrusca, and Snigdha Chaturvedi. 2020. Cue me in: Content-inducing approaches to interactive story generation. arXiv preprint arXiv:2010.09935.'
    fixture.pages[1].runs.splice(2)

    const result = await reconstruct(fixture, 'x')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['brahman:2020'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
    ])
  })

  it('uses a suffixed publication year when a venue repeats its base year', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'suffixed publication years before repeated venue years'
    fixture.pages[0].runs[2].text =
      'Wang et al. (2023a) establishes the baseline.'
    fixture.pages[0].runs[3].text = 'Wang et al. (2023b) confirms the result.'
    fixture.pages[1].runs[1].text =
      'Yichen Wang, Kevin Yang, Xiaoming Liu, and Dan Klein. 2023a. Improving pacing in long-form story planning. In Findings of the Association for Computational Linguistics: EMNLP 2023.'
    fixture.pages[1].runs[2].text =
      'Yichen Wang, Kevin Yang, Xiaoming Liu, and Dan Klein. 2023b. A follow-up analysis. In Findings of the Association for Computational Linguistics: EMNLP 2023.'

    const result = await reconstruct(fixture, 'v')

    expect(
      result.citationRelationships.map(({ labels, status, targetNodeIds }) => ({
        labels,
        status,
        targetNodeIds,
      })),
    ).toEqual([
      {
        labels: ['wang:2023a'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      },
      {
        labels: ['wang:2023b'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      },
    ])
  })

  it('fails closed when multiple publication-year candidates precede the external identifier', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'ambiguous publication year candidates'
    fixture.pages[0].runs[2].text =
      'Example et al. (2021) establishes the baseline.'
    fixture.pages[0].runs[3].text = 'The result remains reproducible.'
    fixture.pages[1].runs[1].text =
      'Amanda Example, Ben Reader, and Cam Writer. A 2020 benchmark revised in 2021. URL https://example.test/paper.'
    fixture.pages[1].runs.splice(2)

    const result = await reconstruct(fixture, 'u')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['example:2021'],
        status: 'unresolved',
        targetNodeIds: [],
        evidence: expect.arrayContaining([
          'bibliography-author-year-target-missing',
        ]),
      }),
    ])
  })

  it('maps a long reference when its unique publication year follows the first 240 characters', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'long author-year reference entry'
    fixture.pages[0].runs[2].text =
      'Prior work (Biderman et al., 2023) establishes the baseline.'
    fixture.pages[0].runs[3].text = 'The result remains reproducible.'
    fixture.pages[1].runs[1].text = `Biderman, S., Example, A., and Reader, B. ${'Detailed model analysis and evaluation '.repeat(8)}PMLR, 2023. URL https://example.test/2023/paper.`
    fixture.pages[1].runs.splice(2)

    const result = await reconstruct(fixture, 'b')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['biderman:2023'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
    ])
  })

  it('leaves missing author-year keys unresolved and duplicate keys ambiguous', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'ambiguous and missing author-year targets'
    fixture.pages[0].runs[2].text =
      'Prior work (Ahn et al., 2024) establishes the baseline.'
    fixture.pages[0].runs[3].text =
      'Unknown et al. (2025) reports a different result.'
    fixture.pages[1].runs[1].text =
      'Ahn, J., Example, A. (2024). First reference entry.'
    fixture.pages[1].runs[2].text =
      'Ahn, K., Example, B. (2024). Second reference entry.'

    const result = await reconstruct(fixture, 'a')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['ahn:2024'],
        status: 'ambiguous',
        targetNodeIds: [],
        candidateNodeIds: [
          expect.stringMatching(/^p-/),
          expect.stringMatching(/^p-/),
        ],
        evidence: expect.arrayContaining([
          'bibliography-author-year-target-ambiguous',
        ]),
      }),
      expect.objectContaining({
        labels: ['unknown:2025'],
        status: 'unresolved',
        targetNodeIds: [],
        evidence: expect.arrayContaining([
          'bibliography-author-year-target-missing',
        ]),
      }),
    ])
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_CITATION_REFERENCE',
    )
    const unresolvedRuns = result.paper.nodes.flatMap((node) =>
      'inlineRuns' in node
        ? (node.inlineRuns ?? []).filter(
            (run) => run.semanticRole === 'citation',
          )
        : [],
    )
    expect(unresolvedRuns).toHaveLength(2)
    expect(unresolvedRuns.every((run) => run.targetIds === undefined)).toBe(
      true,
    )
  })
})

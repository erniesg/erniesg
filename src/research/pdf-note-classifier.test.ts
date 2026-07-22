import { describe, expect, it } from 'vitest'
import {
  ambiguousNoteMarkerFixture,
  decisiveNoteMarkerFixtures,
  orphanedNoteFixture,
  type NoteMarkerFixture,
} from '../../tests/fixtures/note-marker-fixtures'
import type { PdfPageRegion, ReconstructionDiagnostic } from './import-types'
import {
  PDF_NOTE_RELATIONSHIP_THRESHOLD,
  reconstructPageAnalyses,
} from './pdf-layout'
import {
  classifyPdfNoteMarkers,
  PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD,
} from './pdf-note-classifier'
import { assessPdfCompleteness } from './pdf-quality'

const BLOCKING_NOTE_CODES = new Set<ReconstructionDiagnostic['code']>([
  'UNRESOLVED_NOTE_REFERENCE',
  'AMBIGUOUS_NOTE_MATCH',
  'UNREFERENCED_NOTE',
])

function reconstruct(fixture: NoteMarkerFixture, hashCharacter: string) {
  return reconstructPageAnalyses({
    pages: fixture.pages,
    sourceHash: hashCharacter.repeat(64),
    fileName: `${fixture.name.replace(/[^a-z0-9]+/gi, '-')}.pdf`,
    byteLength: 4096,
  })
}

function markerDiagnostics(result: Awaited<ReturnType<typeof reconstruct>>) {
  return result.diagnostics.filter(
    (diagnostic) => diagnostic.code === 'CLASSIFIED_NOTE_MARKER',
  )
}

describe('scholarly note-marker taxonomy', () => {
  it('does not promote mathematical intervals or numeric lists to citations', () => {
    const region = (id: string, text: string): PdfPageRegion => ({
      id,
      page: 1,
      kind: 'body',
      column: 'single',
      text,
      confidence: 1,
      box: {
        page: 1,
        x: 0.1,
        y: id === 'references' ? 0.8 : 0.2,
        width: 0.7,
        height: 0.03,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })

    const classifications = classifyPdfNoteMarkers([
      region('citations', 'Prior work [1] and later work [2] support this.'),
      region(
        'math',
        'For a, b ∈ [0,99], evaluate periods T = [2,5,10,100], numbers [0,361], tokenizes [0,557], and Helix: [2,5,10,100]. Hidden states h⁰³⁶⁰ and h⁰⁹⁹ yield R² = 0.788.',
      ),
      region('references', 'References'),
    ]).classifications

    expect(
      classifications.map(({ label, taxonomy, disposition }) => ({
        label,
        taxonomy,
        disposition,
      })),
    ).toEqual([
      {
        label: '1',
        taxonomy: 'bracketed-bibliography-citation',
        disposition: 'citation',
      },
      {
        label: '2',
        taxonomy: 'bracketed-bibliography-citation',
        disposition: 'citation',
      },
    ])
  })

  it('ends a bibliography before a font-backed lettered appendix heading', () => {
    const region = (
      id: string,
      page: number,
      text: string,
      fontSize: number,
      lines = 1,
    ): PdfPageRegion => {
      const y = id === 'reference-entry' ? 0.2 : 0.1
      return {
        id,
        page,
        kind: 'body',
        column: 'single',
        text,
        confidence: 1,
        box: {
          page,
          x: 0.1,
          y,
          width: 0.7,
          height: 0.02 * lines,
          rotation: 0,
          method: 'pdf-text',
        },
        lines: Array.from({ length: lines }, (_, index) => ({
          id: `${id}-line-${index + 1}`,
          text,
          fontSize,
          box: {
            page,
            x: 0.1,
            y: y + index * 0.02,
            width: 0.7,
            height: 0.02,
            rotation: 0,
            method: 'pdf-text',
          },
          runs: [],
        })),
        nativeObjectIds: [],
        includedInReadingOrder: true,
      }
    }

    const result = classifyPdfNoteMarkers([
      region('references', 1, 'References', 16),
      region(
        'reference-entry',
        1,
        'A. Localizing model behavior with path patching, 2023.',
        10,
        4,
      ),
      region('appendix-heading', 2, 'A. Performance of all models', 12),
      region('appendix-body', 2, 'Appendix prose remains ordinary body.', 10),
    ])

    expect(result.bibliographyRegionIds).toEqual(['reference-entry'])
  })

  it('uses canonical column reading order to scope references that start above the left-column heading', () => {
    const region = (
      id: string,
      text: string,
      column: PdfPageRegion['column'],
      x: number,
      y: number,
    ): PdfPageRegion => ({
      id,
      page: 9,
      kind: 'body',
      column,
      text,
      confidence: 1,
      box: {
        page: 9,
        x,
        y,
        width: 0.38,
        height: 0.02,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })
    const regions = [
      region('right-entry', 'Fiotto-Kaufman, J. 2024.', 'right', 0.52, 0.08),
      region('references', 'References', 'left', 0.1, 0.22),
      region('left-entry', 'Ahn, J. 2024.', 'left', 0.1, 0.25),
    ]

    const result = classifyPdfNoteMarkers(regions, [
      'references',
      'left-entry',
      'right-entry',
    ])

    expect(result.bibliographyRegionIds).toEqual(['left-entry', 'right-entry'])
  })

  it('keeps an unpaired symbolic superscript out of the bibliography citation graph', () => {
    const region = (
      id: string,
      page: number,
      kind: PdfPageRegion['kind'],
      text: string,
    ): PdfPageRegion => ({
      id,
      page,
      kind,
      column: 'single',
      text,
      confidence: 1,
      box: {
        page,
        x: 0.1,
        y: 0.2,
        width: 0.7,
        height: 0.03,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [],
      nativeObjectIds: [],
      includedInReadingOrder: true,
    })
    const classifications = classifyPdfNoteMarkers([
      region('body', 1, 'body', 'Prior work¹ and follow-up² annotate Table*.'),
      region('references', 2, 'body', 'References'),
    ]).classifications

    expect(
      classifications.map(({ label, taxonomy, disposition }) => ({
        label,
        taxonomy,
        disposition,
      })),
    ).toEqual([
      {
        label: '1',
        taxonomy: 'superscript-bibliography-citation',
        disposition: 'citation',
      },
      {
        label: '2',
        taxonomy: 'superscript-bibliography-citation',
        disposition: 'citation',
      },
      {
        label: '*',
        taxonomy: 'symbolic-annotation-marker',
        disposition: 'plain-text',
      },
    ])
  })

  for (const [index, fixture] of decisiveNoteMarkerFixtures.entries()) {
    it(`classifies ${fixture.name} with recorded deciding evidence`, async () => {
      const result = await reconstruct(fixture, String(index + 1))
      const diagnostics = markerDiagnostics(result)

      expect(
        diagnostics.map(
          (diagnostic) => diagnostic.noteMarkerClassification?.taxonomy,
        ),
      ).toEqual(fixture.expectedTaxonomies)
      expect(diagnostics).toHaveLength(fixture.expectedTaxonomies.length)
      expect(
        diagnostics.every(
          (diagnostic) =>
            diagnostic.severity === 'info' &&
            diagnostic.noteMarkerClassification !== undefined &&
            diagnostic.noteMarkerClassification.evidence.length > 0 &&
            diagnostic.noteMarkerClassification.threshold ===
              PDF_NOTE_MARKER_CLASSIFICATION_THRESHOLD,
        ),
      ).toBe(true)
      expect(
        result.diagnostics.filter((diagnostic) =>
          BLOCKING_NOTE_CODES.has(diagnostic.code),
        ),
      ).toEqual([])
    })
  }

  it('keeps citations and scholarly cross-references in prose without treating them as notes', async () => {
    for (const [index, fixture] of decisiveNoteMarkerFixtures
      .slice(0, 4)
      .entries()) {
      const result = await reconstruct(fixture, String(index + 1))
      expect(result.noteRelationships).toEqual([])
      expect(result.semanticSignals).toMatchObject({
        footnoteReferences: 0,
        footnotes: 0,
      })
    }
  })

  it('assigns repeated superscript glyphs to distinct geometry-ordered text ranges', async () => {
    const fixture: NoteMarkerFixture = {
      name: 'authors sharing an affiliation marker',
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: 63,
          imageCount: 0,
          runs: [
            {
              page: 1,
              text: 'Shared affiliation study',
              x: 0.1,
              y: 0.08,
              width: 0.72,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Heading',
              fontSize: 18,
              confidence: 1,
            },
            {
              page: 1,
              text: 'Ada Example',
              x: 0.1,
              y: 0.18,
              width: 0.18,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 11,
              confidence: 1,
            },
            {
              page: 1,
              text: '1',
              x: 0.2805,
              y: 0.176,
              width: 0.008,
              height: 0.009,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 6,
              confidence: 1,
            },
            {
              page: 1,
              text: ', Ben Reader',
              x: 0.29,
              y: 0.18,
              width: 0.2,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 11,
              confidence: 1,
            },
            {
              page: 1,
              text: '1',
              x: 0.4905,
              y: 0.176,
              width: 0.008,
              height: 0.009,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 6,
              confidence: 1,
            },
            {
              page: 1,
              text: 'Example University',
              x: 0.1,
              y: 0.25,
              width: 0.4,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 9,
              confidence: 1,
            },
            {
              page: 1,
              text: 'Abstract',
              x: 0.1,
              y: 0.36,
              width: 0.25,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Heading',
              fontSize: 16,
              confidence: 1,
            },
          ],
        },
      ],
      expectedTaxonomies: [
        'author-affiliation-superscript',
        'author-affiliation-superscript',
      ],
    }

    const result = await reconstruct(fixture, 'd')
    const classifications = markerDiagnostics(result).map(
      (diagnostic) => diagnostic.noteMarkerClassification!,
    )

    expect(classifications).toHaveLength(2)
    expect(classifications.map(({ taxonomy }) => taxonomy)).toEqual(
      fixture.expectedTaxonomies,
    )
    expect(classifications.map(({ start, end }) => [start, end])).toEqual([
      [11, 12],
      [24, 25],
    ])
  })

  it('keeps a reduced numeric-symbol affiliation cluster as one exact source range', async () => {
    const fixture: NoteMarkerFixture = {
      name: 'corresponding author affiliation cluster',
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: 74,
          imageCount: 0,
          runs: [
            {
              page: 1,
              text: 'Affiliation cluster study',
              x: 0.1,
              y: 0.08,
              width: 0.72,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Heading',
              fontSize: 18,
              confidence: 1,
            },
            {
              page: 1,
              text: 'Ada Example',
              x: 0.1,
              y: 0.18,
              width: 0.18,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 11,
              confidence: 1,
            },
            {
              page: 1,
              text: '1*',
              x: 0.2805,
              y: 0.176,
              width: 0.014,
              height: 0.009,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 6,
              confidence: 1,
            },
            {
              page: 1,
              text: ', Ben Reader',
              x: 0.296,
              y: 0.18,
              width: 0.2,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 11,
              confidence: 1,
            },
            {
              page: 1,
              text: '2',
              x: 0.497,
              y: 0.176,
              width: 0.008,
              height: 0.009,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 6,
              confidence: 1,
            },
            {
              page: 1,
              text: 'Example University',
              x: 0.1,
              y: 0.25,
              width: 0.4,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 9,
              confidence: 1,
            },
            {
              page: 1,
              text: 'Abstract',
              x: 0.1,
              y: 0.36,
              width: 0.25,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Heading',
              fontSize: 16,
              confidence: 1,
            },
          ],
        },
      ],
      expectedTaxonomies: [
        'author-affiliation-superscript',
        'author-affiliation-superscript',
      ],
    }

    const result = await reconstruct(fixture, 'e')
    const classifications = markerDiagnostics(result).map(
      (diagnostic) => diagnostic.noteMarkerClassification!,
    )

    expect(classifications).toHaveLength(2)
    expect(classifications.map(({ taxonomy }) => taxonomy)).toEqual(
      fixture.expectedTaxonomies,
    )
    expect(classifications[0]).toMatchObject({
      start: 11,
      end: 13,
      evidence: expect.arrayContaining(['rendered-superscript-geometry']),
    })
    expect(classifications[1]).toMatchObject({
      start: 25,
      end: 26,
      evidence: expect.arrayContaining(['rendered-superscript-geometry']),
    })
  })

  it('materializes citation spans and bibliography targets as canonical relationships', async () => {
    const result = await reconstruct(decisiveNoteMarkerFixtures[0], '6')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        label: '1',
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
        canonicalAnchor: {
          nodeId: expect.stringMatching(/^p-/),
          start: expect.any(Number),
          end: expect.any(Number),
        },
      }),
      expect.objectContaining({
        label: '2',
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
        canonicalAnchor: {
          nodeId: expect.stringMatching(/^p-/),
          start: expect.any(Number),
          end: expect.any(Number),
        },
      }),
    ])
    const citationRuns = result.paper.nodes.flatMap((node) =>
      'inlineRuns' in node
        ? (node.inlineRuns ?? []).filter(
            (run) => run.semanticRole === 'citation',
          )
        : [],
    )
    expect(citationRuns).toHaveLength(2)
    expect(citationRuns.every((run) => run.targetIds?.length === 1)).toBe(true)
    expect(result.semanticSignals.citations).toBe(2)
    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 2,
      mappedInlineSpanCount: 2,
      inlineSpanCoverage: 1,
      expectedRelationshipCount: 2,
      resolvedRelationshipCount: 2,
      relationshipCoverage: 1,
    })
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
        labels: ['ahn:2024', 'satpute:2024'],
        status: 'matched',
        targetNodeIds: [
          expect.stringMatching(/^p-/),
          expect.stringMatching(/^p-/),
        ],
      }),
      expect.objectContaining({
        taxonomy: 'author-year-bibliography-citation',
        labels: ['nanda:2023a'],
        status: 'matched',
        targetNodeIds: [expect.stringMatching(/^p-/)],
      }),
    ])

    const expectedMarkers = [
      '(Ahn et al., 2024; Satpute et al., 2024)',
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

  it('leaves missing and duplicate author-year keys unresolved instead of guessing', async () => {
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
        status: 'unresolved',
        targetNodeIds: [],
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

  it('targets a bracketed bibliography entry retained in a reference footnote region', async () => {
    const fixture: NoteMarkerFixture = {
      name: 'body-region bracketed bibliography entry',
      pages: [
        {
          page: 1,
          kind: 'born-digital',
          width: 612,
          height: 792,
          rotation: 0,
          textCharacters: 97,
          imageCount: 0,
          runs: [
            {
              page: 1,
              text: 'Citation study',
              x: 0.1,
              y: 0.08,
              width: 0.5,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Heading',
              fontSize: 18,
              confidence: 1,
            },
            {
              page: 1,
              text: 'Prior work [1] and later work [1] support the claim.',
              x: 0.1,
              y: 0.18,
              width: 0.7,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 11,
              confidence: 1,
            },
            {
              page: 1,
              text: 'References',
              x: 0.1,
              y: 0.42,
              width: 0.3,
              height: 0.018,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Heading',
              fontSize: 16,
              confidence: 1,
            },
            {
              page: 1,
              text: '[1] Reference-footnote entry.',
              x: 0.1,
              y: 0.9,
              width: 0.72,
              height: 0.012,
              rotation: 0,
              method: 'pdf-text',
              fontName: 'Body',
              fontSize: 8,
              confidence: 1,
            },
          ],
        },
      ],
      expectedTaxonomies: [
        'bracketed-bibliography-citation',
        'bibliography-entry',
      ],
    }

    const result = await reconstruct(fixture, 'g')
    const bibliography = result.paper.nodes.find(
      (node) =>
        node.type === 'paragraph' && node.list?.numberingId === 'references',
    )
    const citation = result.citationRelationships[0]

    expect(bibliography).toMatchObject({
      list: { markerText: '[1]', ordinal: 1, numberingId: 'references' },
    })
    expect(citation).toMatchObject({
      label: '1',
      status: 'matched',
      targetNodeIds: [bibliography!.id],
    })
  })

  it('gives distinct source-anchored IDs to citation labels that share a lossy slug', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.name = 'symbol citations with colliding marker slugs'
    fixture.pages[0].runs[2].text =
      'Prior work [*] establishes the matched baseline.'
    fixture.pages[0].runs[3].text =
      'Subsequent evidence [†] remains intentionally unresolved.'
    fixture.pages[1].runs = [
      fixture.pages[1].runs[0],
      {
        ...fixture.pages[1].runs[1],
        text: '*. Symbol bibliography entry.',
      },
    ]

    const first = await reconstruct(fixture, '1')
    const repeat = await reconstruct(fixture, '2')
    const citationClassifications = markerDiagnostics(first)
      .map((diagnostic) => diagnostic.noteMarkerClassification!)
      .filter((classification) => classification.disposition === 'citation')

    expect(citationClassifications.map(({ label }) => label)).toEqual([
      '*',
      '†',
    ])
    expect(
      citationClassifications.map(({ start, end }) => [start, end]),
    ).toEqual([
      [11, 14],
      [20, 23],
    ])
    expect(citationClassifications[0].sourceBox).not.toEqual(
      citationClassifications[1].sourceBox,
    )
    expect(new Set(citationClassifications.map(({ id }) => id))).toHaveLength(
      citationClassifications.length,
    )
    for (const classification of citationClassifications) {
      expect(classification.id).toContain(
        `-${classification.referenceRegionId}-s${String(classification.start).padStart(6, '0')}-e${String(classification.end).padStart(6, '0')}-001`,
      )
    }
    expect(
      markerDiagnostics(first).map(
        (diagnostic) => diagnostic.noteMarkerClassification!.id,
      ),
    ).toEqual(
      markerDiagnostics(repeat).map(
        (diagnostic) => diagnostic.noteMarkerClassification!.id,
      ),
    )
    expect(first.citationRelationships.map(({ status }) => status)).toEqual([
      'matched',
      'unresolved',
    ])
    expect(
      new Set(first.citationRelationships.map(({ id }) => id)),
    ).toHaveLength(first.citationRelationships.length)
    expect(first.citationRelationships.map(({ id }) => id)).toEqual(
      citationClassifications.map(({ id }) => id),
    )
  })

  it('does not resolve a citation from a same-ID run on a different canonical node', async () => {
    const result = await reconstruct(decisiveNoteMarkerFixtures[0], 'e')
    const reassess = (
      paper: typeof result.paper,
      provenance = result.provenance,
      citationRelationships = result.citationRelationships,
    ) =>
      assessPdfCompleteness({
        pages: result.pages,
        paper,
        diagnostics: [],
        regions: result.regions,
        readingOrder: result.readingOrder,
        provenance,
        visualRelationships: result.visualRelationships,
        assets: result.assets,
        citationRelationships,
        inlineSpanLedger: {
          expected: result.completeness.expectedInlineSpanCount,
          mapped: result.completeness.mappedInlineSpanCount,
        },
      })
    const expectOneUnresolvedCitation = (
      reassessed: ReturnType<typeof reassess>,
    ) => {
      expect(reassessed.completeness.unresolvedObjects.citations).toBe(1)
      expect(reassessed.completeness.resolvedRelationshipCount).toBe(1)
    }
    const paper = structuredClone(result.paper)
    const relationship = result.citationRelationships[0]
    const owner = paper.nodes.find(
      (node) =>
        'inlineRuns' in node &&
        node.inlineRuns?.some((run) => run.relationshipId === relationship.id),
    )!
    const misplacedRun =
      'inlineRuns' in owner
        ? owner.inlineRuns!.find(
            (run) => run.relationshipId === relationship.id,
          )!
        : undefined
    if ('inlineRuns' in owner) {
      owner.inlineRuns = owner.inlineRuns?.filter(
        (run) => run.relationshipId !== relationship.id,
      )
    }
    const wrongOwner = paper.nodes.find(
      (node) =>
        node.id !== owner.id &&
        (node.type === 'heading' || node.type === 'paragraph'),
    )!
    if (wrongOwner.type !== 'heading' && wrongOwner.type !== 'paragraph') {
      throw new Error('INLINE_CAPABLE_NODE_REQUIRED')
    }
    wrongOwner.inlineRuns = [...(wrongOwner.inlineRuns ?? []), misplacedRun!]
    expectOneUnresolvedCitation(reassess(paper))

    const wrongRangePaper = structuredClone(result.paper)
    const anchoredNode = wrongRangePaper.nodes.find(
      (node) => node.id === relationship.canonicalAnchor?.nodeId,
    )!
    if (anchoredNode.type !== 'heading' && anchoredNode.type !== 'paragraph') {
      throw new Error('INLINE_CAPABLE_NODE_REQUIRED')
    }
    const wrongRangeRun = anchoredNode.inlineRuns!.find(
      (run) => run.relationshipId === relationship.id,
    )!
    wrongRangeRun.start += 1
    expectOneUnresolvedCitation(reassess(wrongRangePaper))

    const wrongTargetPaper = structuredClone(result.paper)
    const wrongTargetNode = wrongTargetPaper.nodes.find(
      (node) => node.id === relationship.canonicalAnchor?.nodeId,
    )!
    if (
      wrongTargetNode.type !== 'heading' &&
      wrongTargetNode.type !== 'paragraph'
    ) {
      throw new Error('INLINE_CAPABLE_NODE_REQUIRED')
    }
    wrongTargetNode.inlineRuns!.find(
      (run) => run.relationshipId === relationship.id,
    )!.targetIds = []
    expectOneUnresolvedCitation(reassess(wrongTargetPaper))

    const wrongProvenance = structuredClone(result.provenance)
    wrongProvenance[relationship.canonicalAnchor!.nodeId].regionIds =
      wrongProvenance[relationship.canonicalAnchor!.nodeId].regionIds.filter(
        (regionId) => regionId !== relationship.referenceRegionId,
      )
    expectOneUnresolvedCitation(reassess(result.paper, wrongProvenance))

    const wrongBibliographyPaper = structuredClone(result.paper)
    const wrongBibliographyRelationships = structuredClone(
      result.citationRelationships,
    )
    const ordinaryParagraph = wrongBibliographyPaper.nodes.find(
      (node) =>
        node.type === 'paragraph' && node.list?.numberingId !== 'references',
    )!
    const wrongBibliographyRelationship = wrongBibliographyRelationships.find(
      (candidate) => candidate.id === relationship.id,
    )!
    wrongBibliographyRelationship.targetNodeIds = [ordinaryParagraph.id]
    const citationOwner = wrongBibliographyPaper.nodes.find(
      (node) => node.id === relationship.canonicalAnchor?.nodeId,
    )!
    if (
      citationOwner.type !== 'heading' &&
      citationOwner.type !== 'paragraph' &&
      citationOwner.type !== 'quote'
    ) {
      throw new Error('INLINE_CAPABLE_NODE_REQUIRED')
    }
    citationOwner.inlineRuns!.find(
      (run) => run.relationshipId === relationship.id,
    )!.targetIds = [ordinaryParagraph.id]
    expectOneUnresolvedCitation(
      reassess(
        wrongBibliographyPaper,
        result.provenance,
        wrongBibliographyRelationships,
      ),
    )
  })

  it('blocks a target-matched citation without an inline-capable canonical anchor', async () => {
    const fixture: NoteMarkerFixture = {
      name: 'front-matter citation without canonical prose anchor',
      pages: [
        {
          ...decisiveNoteMarkerFixtures[0].pages[0],
          runs: [
            decisiveNoteMarkerFixtures[0].pages[0].runs[0],
            {
              ...decisiveNoteMarkerFixtures[0].pages[0].runs[2],
              text: 'Example University [1,2]',
              y: 0.16,
            },
            {
              ...decisiveNoteMarkerFixtures[0].pages[0].runs[1],
              y: 0.24,
            },
          ],
        },
        {
          ...decisiveNoteMarkerFixtures[0].pages[1],
          runs: decisiveNoteMarkerFixtures[0].pages[1].runs,
        },
      ],
      expectedTaxonomies: [
        'bracketed-bibliography-citation',
        'bibliography-entry',
        'bibliography-entry',
      ],
    }
    const result = await reconstruct(fixture, 'f')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        status: 'matched',
        canonicalAnchor: null,
      }),
    ])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNMAPPED_CITATION_ANCHOR',
          severity: 'error',
          relationshipId: result.citationRelationships[0].id,
        }),
      ]),
    )
    expect(result.completeness).toMatchObject({
      expectedInlineSpanCount: 1,
      mappedInlineSpanCount: 0,
      inlineSpanCoverage: 0,
      resolvedRelationshipCount: 0,
    })
  })

  it('expands a bounded numeric citation range to every bibliography target', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.pages[0].runs[2].text =
      'Prior work [1–3] establishes the complete baseline.'
    fixture.pages[0].runs[3].text = 'Later work confirms the result.'
    fixture.pages[1].runs.push({
      ...fixture.pages[1].runs[2],
      text: '[3] Third reference entry.',
      y: 0.36,
    })

    const result = await reconstruct(fixture, 'b')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        label: '1,2,3',
        labels: ['1', '2', '3'],
        status: 'matched',
        targetNodeIds: [
          expect.stringMatching(/^p-/),
          expect.stringMatching(/^p-/),
          expect.stringMatching(/^p-/),
        ],
      }),
    ])
    const citationRun = result.paper.nodes
      .flatMap((node) => ('inlineRuns' in node ? (node.inlineRuns ?? []) : []))
      .find((run) => run.semanticRole === 'citation')
    expect(citationRun?.targetIds).toHaveLength(3)
  })

  it('keeps a numeric citation range blocked when its middle target is missing', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.pages[0].runs[2].text =
      'Prior work [1-3] establishes the incomplete baseline.'
    fixture.pages[0].runs[3].text = 'Later work confirms the result.'
    fixture.pages[1].runs[2].text = '[3] Third reference entry.'

    const result = await reconstruct(fixture, 'c')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['1', '2', '3'],
        status: 'unresolved',
        targetNodeIds: [
          expect.stringMatching(/^p-/),
          expect.stringMatching(/^p-/),
        ],
      }),
    ])
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_CITATION_REFERENCE',
    )
  })

  it('fails closed when citation labels have no bibliography target', async () => {
    const fixture = structuredClone(decisiveNoteMarkerFixtures[0])
    fixture.pages[1].runs[1].text = '[3] Third reference entry.'
    fixture.pages[1].runs[2].text = '[4] Fourth reference entry.'

    const result = await reconstruct(fixture, '5')

    expect(result.citationRelationships).toEqual([
      expect.objectContaining({ label: '1', status: 'unresolved' }),
      expect.objectContaining({ label: '2', status: 'unresolved' }),
    ])
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_CITATION_REFERENCE',
    )
  })

  it('preserves bibliography entries in node order instead of emitting orphaned notes', async () => {
    const fixture = decisiveNoteMarkerFixtures[1]
    const result = await reconstruct(fixture, '7')

    expect(result.paper.nodes.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'paragraph',
      'paragraph',
    ])
    expect(
      result.paper.nodes.map((node) => ('text' in node ? node.text : '')),
    ).toEqual([
      'Abstract',
      'Prior evidence¹,² supports the claim.',
      'References',
      'First citation.',
      'Second citation.',
    ])
    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'paragraph' && node.list?.numberingId === 'references'
          ? [node.list.ordinal]
          : [],
      ),
    ).toEqual([1, 2])
    expect(result.paper.nodes.some((node) => node.type === 'footnote')).toBe(
      false,
    )
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNREFERENCED_NOTE' }),
      ]),
    )
  })

  it('accepts true note relationships only at the documented threshold and retains node order', async () => {
    for (const [fixtureIndex, fixture] of decisiveNoteMarkerFixtures
      .slice(4)
      .entries()) {
      const result = await reconstruct(fixture, String(fixtureIndex + 8))
      expect(result.noteRelationships).toEqual([
        expect.objectContaining({
          status: 'matched',
          threshold: PDF_NOTE_RELATIONSHIP_THRESHOLD,
          evidence: expect.arrayContaining(['label-exact']),
        }),
      ])
      expect(result.noteRelationships[0].confidence).toBeGreaterThanOrEqual(
        result.noteRelationships[0].threshold,
      )
      const note = result.paper.nodes.find((node) => node.type === 'footnote')
      expect(note).toBeDefined()
      expect(result.paper.nodes.indexOf(note!)).toBeGreaterThan(0)
      expect(note?.relationships.backlinks).toEqual([
        result.noteRelationships[0].id,
      ])
    }
  })

  it('keeps genuinely ambiguous matches blocked below the uniqueness margin', async () => {
    const result = await reconstruct(ambiguousNoteMarkerFixture, 'a')

    expect(markerDiagnostics(result)).toEqual([
      expect.objectContaining({
        noteMarkerClassification: expect.objectContaining({
          taxonomy: 'footnote-reference',
        }),
      }),
    ])
    expect(result.noteRelationships).toEqual([
      expect.objectContaining({
        status: 'ambiguous',
        targetNoteId: null,
        threshold: PDF_NOTE_RELATIONSHIP_THRESHOLD,
      }),
    ])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AMBIGUOUS_NOTE_MATCH',
          severity: 'error',
        }),
      ]),
    )
  })

  it('still blocks genuinely orphaned note bodies', async () => {
    const result = await reconstruct(orphanedNoteFixture, 'b')

    expect(markerDiagnostics(result)).toEqual([])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNREFERENCED_NOTE',
          severity: 'error',
        }),
      ]),
    )
  })
})

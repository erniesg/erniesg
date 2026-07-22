import { describe, expect, it } from 'vitest'
import type {
  NodeSourceEvidence,
  NormalizedSourceBox,
  PdfPageAnalysis,
  PdfSourceRun,
} from './import-types'
import {
  captionProvenanceEnvelope,
  reconstructPageAnalyses,
  residualPdfRegionAfterLineConsumption,
  residualPdfRegionFragmentsAfterLineConsumption,
  synthesizeRecoveredBibliographyClassifications,
} from './pdf-layout'
import { assessPdfCompleteness } from './pdf-quality'
import { internalReferenceIntegrityIssues } from './publication-integrity'
import { validatedPdfVisualRelationships } from './pdf-visual-validation'
import { createSourcePageCropAsset } from './visual-assets'

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

describe('PDF semantic reconstruction', () => {
  it('replays retained prose boundaries after consuming an exact table line suffix', () => {
    const proseRuns = [
      run(1, 'This method is deter-', 0.1, 0.2, 0.65),
      run(1, 'ministic.', 0.1, 0.225, 0.2),
    ]
    const tableRuns = [
      run(1, 'Metric Baseline Proposed', 0.1, 0.5, 0.7),
      run(1, 'Accuracy 71.2 84.6', 0.1, 0.53, 0.7),
      run(1, 'Recall 68.4 82.1', 0.1, 0.56, 0.7),
    ]
    const lines = [...proseRuns, ...tableRuns].map((sourceRun, index) => ({
      id: `mixed-line-${index + 1}`,
      text: sourceRun.text,
      fontSize: sourceRun.fontSize,
      box: { ...sourceRun },
      runs: [{ ...sourceRun }],
    }))
    const region = {
      id: 'mixed-prose-table-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: 'This method is deterministic. Metric Baseline Proposed Accuracy 71.2 84.6 Recall 68.4 82.1',
      confidence: 1,
      box: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.7,
        height: 0.378,
        rotation: 0,
        method: 'pdf-text',
      },
      lines,
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies import('./import-types').PdfPageRegion
    const decisions = lines.slice(1).map((line, index) => ({
      id: `mixed-boundary-${index + 1}`,
      page: 1,
      regionId: region.id,
      fromLineId: lines[index].id,
      toLineId: line.id,
      outcome:
        index === 0
          ? ('removed-discretionary-hyphen' as const)
          : ('space' as const),
      evidence: index === 0 ? ['same-document-unhyphenated-word'] : [],
    }))

    const residual = residualPdfRegionAfterLineConsumption(
      region,
      new Set(tableRuns.map((_, index) => `mixed-line-${index + 3}`)),
      decisions,
    )

    expect(residual).toMatchObject({
      id: region.id,
      text: 'This method is deterministic.',
      box: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.65,
        height: 0.043,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [{ id: 'mixed-line-1' }, { id: 'mixed-line-2' }],
    })
  })

  it('splits noncontiguous residual lines without inventing a source boundary', () => {
    const lines = ['Alpha', 'Table row', 'Omega'].map((text, index) => ({
      id: `interleaved-line-${index + 1}`,
      text,
      fontSize: 10,
      box: {
        page: 1,
        x: 0.1,
        y: 0.2 + index * 0.02,
        width: 0.7,
        height: 0.018,
        rotation: 0,
        method: 'pdf-text' as const,
      },
      runs: [],
    }))
    const region = {
      id: 'interleaved-prose-table-region',
      page: 1,
      kind: 'body',
      column: 'single',
      text: 'Alpha Table row Omega',
      confidence: 1,
      box: {
        page: 1,
        x: 0.1,
        y: 0.2,
        width: 0.7,
        height: 0.058,
        rotation: 0,
        method: 'pdf-text',
      },
      lines,
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies import('./import-types').PdfPageRegion
    const decisions = lines.slice(1).map((line, index) => ({
      id: `interleaved-boundary-${index + 1}`,
      page: 1,
      regionId: region.id,
      fromLineId: lines[index].id,
      toLineId: line.id,
      outcome: 'space' as const,
      evidence: ['ordinary-wrap'],
    }))

    const fragments = residualPdfRegionFragmentsAfterLineConsumption(
      region,
      new Set(['interleaved-line-2']),
      decisions,
    )

    expect(
      fragments.map(({ region: fragment, sourceStart, sourceEnd }) => ({
        text: fragment.text,
        lineIds: fragment.lines.map((line) => line.id),
        sourceStart,
        sourceEnd,
      })),
    ).toEqual([
      {
        text: 'Alpha',
        lineIds: ['interleaved-line-1'],
        sourceStart: 0,
        sourceEnd: 5,
      },
      {
        text: 'Omega',
        lineIds: ['interleaved-line-3'],
        sourceStart: 16,
        sourceEnd: 21,
      },
    ])
  })

  it('separates title-page metadata and abstract from continuous body nodes', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Semantic Paper', 0.1, 0.08, 0.7, 22),
          run(1, 'Ada Example; Ben Reader', 0.1, 0.15, 0.6, 11),
          run(
            1,
            'Department of Evidence, Example University',
            0.1,
            0.2,
            0.7,
            9,
          ),
          run(1, 'Abstract', 0.1, 0.3, 0.25, 16),
          run(
            1,
            'This abstract belongs in document metadata.',
            0.1,
            0.36,
            0.72,
          ),
          run(1, '1 Introduction', 0.1, 0.5, 0.35, 10),
          run(1, 'Continuous body prose starts here.', 0.1, 0.56, 0.72),
        ]),
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'semantic-front-matter.pdf',
      byteLength: 4096,
    })

    expect(result.paper).toMatchObject({
      title: 'A Semantic Paper',
      authors: ['Ada Example', 'Ben Reader'],
      affiliations: ['Department of Evidence, Example University'],
      abstract: 'This abstract belongs in document metadata.',
    })
    expect(
      result.paper.nodes.map((node) => ('text' in node ? node.text : '')),
    ).toEqual([
      'Abstract',
      'This abstract belongs in document metadata.',
      '1 Introduction',
      'Continuous body prose starts here.',
    ])
    expect(result.paper.nodes[2]).toMatchObject({
      type: 'heading',
      level: 1,
    })
    expect(result.completeness.textCoverage).toBe(1)
  })

  it('separates adjacent section headings before semantic classification', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '1 Introduction', 0.1, 0.22, 0.35, 10),
          run(
            1,
            'Continuous body prose starts immediately below.',
            0.1,
            0.239,
            0.72,
          ),
        ]),
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'adjacent-heading.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.map((node) =>
        'text' in node ? { type: node.type, text: node.text } : null,
      ),
    ).toEqual([
      { type: 'heading', text: '1 Introduction' },
      {
        type: 'paragraph',
        text: 'Continuous body prose starts immediately below.',
      },
    ])
  })

  it('recognizes same-size medium-face hierarchical section headings', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Previous body paragraph ends here.', 0.1, 0.1, 0.72, 10),
          {
            ...run(1, '3.2 Draft Module', 0.52, 0.2, 0.25, 10),
            fontName: 'NimbusRomNo9L-Medi',
          },
          run(1, 'Following body prose.', 0.52, 0.25, 0.35, 10),
        ]),
      ],
      sourceHash: '9'.repeat(64),
      fileName: 'medium-face-heading.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.find(
        (node) => node.type === 'heading' && node.text === '3.2 Draft Module',
      ),
    ).toMatchObject({ type: 'heading', level: 2 })
  })

  it('recognizes adjacent author names separated by affiliation markers', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Marker-aware authors', 0.1, 0.08, 0.72, 18),
          run(1, 'Ada Example2 Ben Reader1', 0.1, 0.15, 0.6, 11),
          run(1, '1 Example University', 0.1, 0.21, 0.7, 9),
          run(1, 'Abstract', 0.1, 0.3, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.36, 0.72),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'marker-aware-authors.pdf',
      byteLength: 4096,
    })

    expect(result.paper.authors).toEqual(['Ada Example', 'Ben Reader'])
  })

  it('owns exact title-page note markers through canonical author references', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Source-backed author notes', 0.1, 0.08, 0.72, 18),
          run(1, 'Subhash Kantamneni', 0.24, 0.15, 0.2, 11),
          {
            ...run(1, '1', 0.441, 0.146, 0.008, 6),
            height: 0.009,
          },
          run(1, 'Max Tegmark', 0.46, 0.15, 0.13, 11),
          {
            ...run(1, '1', 0.591, 0.146, 0.008, 6),
            height: 0.009,
          },
          run(1, 'Abstract', 0.1, 0.28, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.34, 0.72),
          run(
            1,
            '1 Massachusetts Institute of Technology. Correspondence to: Subhash Kantamneni <subhashk@mit.edu>.',
            0.1,
            0.86,
            0.72,
            7,
          ),
        ]),
      ],
      sourceHash: '1'.repeat(64),
      fileName: 'numeric-author-note.pdf',
      byteLength: 4096,
    })

    const note = result.paper.nodes.find((node) => node.type === 'footnote')
    expect(note).toBeDefined()
    expect(result.paper.authorNotes).toEqual([
      {
        id: expect.any(String),
        author: 'Subhash Kantamneni',
        label: '1',
        target: note!.id,
      },
      {
        id: expect.any(String),
        author: 'Max Tegmark',
        label: '1',
        target: note!.id,
      },
    ])
    expect(note).toMatchObject({
      relationships: {
        backlinks: result.paper.authorNotes!.map((reference) => reference.id),
      },
    })
    expect(internalReferenceIntegrityIssues(result.paper)).toEqual([])
  })

  it('leaves a title-page note unowned when intervening prose makes author ownership ambiguous', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Ambiguous author note', 0.1, 0.08, 0.72, 18),
          run(1, 'Ada Example and corresponding author', 0.2, 0.15, 0.38, 11),
          {
            ...run(1, '1', 0.581, 0.146, 0.008, 6),
            height: 0.009,
          },
          run(1, 'Abstract', 0.1, 0.28, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.34, 0.72),
          run(
            1,
            '1 A source-backed note whose author owner is not explicit.',
            0.1,
            0.86,
            0.72,
            7,
          ),
        ]),
      ],
      sourceHash: '2'.repeat(64),
      fileName: 'ambiguous-author-note.pdf',
      byteLength: 4096,
    })

    const note = result.paper.nodes.find((node) => node.type === 'footnote')
    expect(result.paper.authorNotes).toBeUndefined()
    expect(note).toMatchObject({ relationships: { backlinks: [] } })
    expect(internalReferenceIntegrityIssues(result.paper)).toEqual([])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNREFERENCED_NOTE' }),
      ]),
    )
  })

  it('keeps space-separated affiliation markers out of the publication title', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper Title', 0.22, 0.08, 0.56, 18),
          run(1, 'Ada Example 1 Ben Reader 1', 0.34, 0.15, 0.32, 11),
          run(1, '1 Example University', 0.1, 0.21, 0.7, 9),
          run(1, 'Abstract', 0.1, 0.3, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.36, 0.72),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'spaced-affiliation-markers.pdf',
      byteLength: 4096,
    })

    expect(result.paper.title).toBe('A Source-Backed Paper Title')
    expect(result.paper.authors).toEqual(['Ada Example', 'Ben Reader'])
  })

  it('splits a dense author line with repeated space-separated markers', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Multi-Institution Paper', 0.2, 0.08, 0.6, 18),
          run(
            1,
            'Qianyue Wang 1 2* Jinwu Hu 1 2* Zhengping Li 1 Yufeng Wang 1 3 Daiyuan Li 1 Yu Hu 4 Mingkui Tan 1 †',
            0.16,
            0.15,
            0.68,
            11,
          ),
          run(
            1,
            '1 Example University, 2 Example Laboratory',
            0.2,
            0.21,
            0.6,
            9,
          ),
          run(1, 'Abstract', 0.1, 0.3, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.36, 0.72),
        ]),
      ],
      sourceHash: '7'.repeat(64),
      fileName: 'dense-author-markers.pdf',
      byteLength: 4096,
    })

    expect(result.paper.authors).toEqual([
      'Qianyue Wang',
      'Jinwu Hu',
      'Zhengping Li',
      'Yufeng Wang',
      'Daiyuan Li',
      'Yu Hu',
      'Mingkui Tan',
    ])
  })

  it('does not append a company affiliation to the title', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper Title', 0.22, 0.08, 0.56, 18),
          run(1, 'Ada Example1, Ben Reader2', 0.3, 0.15, 0.4, 11),
          run(1, '1 Example University', 0.33, 0.2, 0.34, 9),
          run(1, '2 LightSpeed Studios, Example Company', 0.28, 0.23, 0.44, 9),
          run(1, 'Abstract', 0.1, 0.3, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.36, 0.72),
        ]),
      ],
      sourceHash: '8'.repeat(64),
      fileName: 'company-affiliation.pdf',
      byteLength: 4096,
    })

    expect(result.paper.title).toBe('A Source-Backed Paper Title')
    expect(result.paper.authors).toEqual(['Ada Example', 'Ben Reader'])
    expect(result.paper.affiliations).toEqual(
      expect.arrayContaining([expect.stringContaining('LightSpeed Studios')]),
    )
  })

  it('collects right-side authors above an abstract despite column-major order', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Four-Author Paper', 0.16, 0.08, 0.68, 18),
          run(1, 'Kevin Yang1 Yuandong Tian2', 0.16, 0.15, 0.31, 11),
          run(1, 'Nanyun Peng3 Dan Klein1', 0.54, 0.15, 0.3, 11),
          run(1, '1UC Berkeley, 2Meta AI, 3UCLA', 0.16, 0.19, 0.31, 9),
          run(1, 'Research Group', 0.54, 0.19, 0.3, 9),
          run(1, 'Abstract', 0.16, 0.27, 0.31, 16),
          run(1, 'Visual summary', 0.54, 0.27, 0.3, 9),
          run(1, 'The abstract remains canonical prose.', 0.16, 0.33, 0.31),
          run(1, 'Diagram evidence', 0.54, 0.33, 0.3, 9),
        ]),
      ],
      sourceHash: 'a'.repeat(64),
      fileName: 'column-major-authors.pdf',
      byteLength: 4096,
    })

    expect(result.paper.authors).toEqual([
      'Kevin Yang',
      'Yuandong Tian',
      'Nanyun Peng',
      'Dan Klein',
    ])
  })

  it('proves shared author markers from stripped source while retaining a raw affiliation marker', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Shared affiliation study', 0.1, 0.08, 0.72, 18),
          run(1, 'Ada Example', 0.1, 0.18, 0.18, 11),
          run(1, '1', 0.2805, 0.176, 0.008, 6),
          run(1, ', Ben Reader', 0.29, 0.18, 0.2, 11),
          run(1, '1', 0.4905, 0.176, 0.008, 6),
          run(1, '1', 0.1, 0.246, 0.008, 6),
          run(1, 'Example University', 0.112, 0.25, 0.4, 9),
          run(1, 'Abstract', 0.1, 0.36, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.42, 0.7),
        ]),
      ],
      sourceHash: '5'.repeat(64),
      fileName: 'shared-affiliation-markers.pdf',
      byteLength: 4096,
    })

    expect(result.paper).toMatchObject({
      authors: ['Ada Example', 'Ben Reader'],
      affiliations: ['1 Example University'],
    })
    expect(result.completeness.unprovenancedRenderedUnitCount).toBe(0)
    expect(result.completeness.textCoverage).toBeGreaterThanOrEqual(0.98)

    const invented = assessPdfCompleteness({
      pages: result.pages,
      paper: {
        ...result.paper,
        affiliations: [
          ...(result.paper.affiliations ?? []),
          'Invented Metadata Institute',
        ],
      },
      diagnostics: [],
      regions: result.regions,
      readingOrder: result.readingOrder,
      provenance: result.provenance,
      visualRelationships: result.visualRelationships,
      assets: result.assets,
      citationRelationships: result.citationRelationships,
    })
    expect(invented.completeness.unprovenancedRenderedUnitCount).toBe(1)
    expect(invented.completeness.textCoverage).toBeLessThan(
      result.completeness.textCoverage,
    )
  })

  it('recognizes a long inline abstract before affiliation keyword matching', async () => {
    const abstract =
      'This long inline abstract describes a scholarly workflow in continuous prose, cites a University-hosted corpus, and records a public https://example.org/project resource without turning the abstract into institutional metadata.'
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Inline Abstract Study', 0.1, 0.08, 0.7, 22),
          run(1, 'Ada Example; Ben Reader', 0.1, 0.15, 0.6, 11),
          run(
            1,
            'Department of Evidence, Example University',
            0.1,
            0.21,
            0.7,
            9,
          ),
          run(1, `Abstract ${abstract}`, 0.1, 0.29, 0.8),
          run(1, '1 Introduction', 0.1, 0.56, 0.35, 10),
          run(1, 'Continuous body prose starts here.', 0.1, 0.62, 0.72),
        ]),
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'inline-abstract-boundary.pdf',
      byteLength: 4096,
    })

    expect(result.paper).toMatchObject({
      title: 'Inline Abstract Study',
      authors: ['Ada Example', 'Ben Reader'],
      affiliations: ['Department of Evidence, Example University'],
      abstract,
    })
    expect(result.paper.affiliations).not.toContain(
      expect.stringContaining('example.org'),
    )
  })

  it('combines ordered multiline title-role blocks into one metadata title', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Semantic Framework for', 0.1, 0.07, 0.72, 22),
          run(1, 'faithful scholarly reading', 0.1, 0.13, 0.72, 17),
          run(1, 'Ada Example; Ben Reader', 0.1, 0.2, 0.6, 11),
          run(1, 'Example University', 0.1, 0.25, 0.5, 9),
          run(1, 'Abstract', 0.1, 0.34, 0.25, 16),
          run(1, 'The abstract remains canonical prose.', 0.1, 0.4, 0.7),
        ]),
      ],
      sourceHash: '5'.repeat(64),
      fileName: 'multiline-title.pdf',
      byteLength: 4096,
    })

    expect(result.paper.title).toBe(
      'A Semantic Framework for faithful scholarly reading',
    )
    expect(
      result.paper.nodes.filter(
        (node) =>
          'text' in node &&
          /Semantic Framework|faithful scholarly reading/.test(node.text),
      ),
    ).toEqual([])
  })

  it('uses repeated first-line indentation as paragraph-boundary evidence', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'First paragraph begins', 0.14, 0.2, 0.58),
          run(1, 'and continues on its next line.', 0.1, 0.222, 0.68),
          run(1, 'Second paragraph begins', 0.14, 0.244, 0.58),
          run(1, 'and continues independently.', 0.1, 0.266, 0.68),
        ]),
      ],
      sourceHash: '6'.repeat(64),
      fileName: 'indented-paragraphs.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.map((node) => ('text' in node ? node.text : '')),
    ).toEqual([
      'First paragraph begins and continues on its next line.',
      'Second paragraph begins and continues independently.',
    ])
  })

  it('recognizes sequenced standalone numbered headings without English vocabulary', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '1 Überblick', 0.1, 0.18, 0.3),
          run(1, 'Erster Abschnittstext.', 0.1, 0.24, 0.7),
          run(1, '2 Methode', 0.1, 0.34, 0.3),
          run(1, 'Zweiter Abschnittstext.', 0.1, 0.4, 0.7),
        ]),
      ],
      sourceHash: '7'.repeat(64),
      fileName: 'numbered-headings.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes
        .filter((node) => node.type === 'heading')
        .map((node) => node.text),
    ).toEqual(['1 Überblick', '2 Methode'])
  })

  it('keeps sequenced decimal steps as list items when typography does not mark headings', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '3. MLPs 14-18 fit the b token', 0.1, 0.18, 0.55),
          run(
            1,
            'and retain the ordinary step explanation.',
            0.12,
            0.205,
            0.68,
          ),
          run(1, '4. MLPs 19-27 fit the a token', 0.1, 0.34, 0.55),
          run(
            1,
            'and retain the next ordinary step explanation.',
            0.12,
            0.365,
            0.7,
          ),
        ]),
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'numbered-list-steps.pdf',
      byteLength: 4096,
    })

    const steps = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' &&
      node.list?.numberingId.startsWith('pdf-list-')
        ? [node]
        : [],
    )
    expect(
      steps.map((node) => ({ text: node.text, ordinal: node.list?.ordinal })),
    ).toEqual([
      {
        text: 'MLPs 14-18 fit the b token and retain the ordinary step explanation.',
        ordinal: 3,
      },
      {
        text: 'MLPs 19-27 fit the a token and retain the next ordinary step explanation.',
        ordinal: 4,
      },
    ])
    expect(new Set(steps.map((node) => node.list!.numberingId)).size).toBe(1)
    expect(
      result.paper.nodes.filter((node) => node.type === 'heading'),
    ).toEqual([])
  })

  it('separates source-styled section lines from merged prose while retaining the complete heading text', async () => {
    const mainHeading = run(
      2,
      '5. LLMs Use the Clock Algorithm to Compute Addition',
      0.1,
      0.12,
      0.72,
      12,
    )
    mainHeading.fontName = 'NimbusRomNo9L-Medi'
    const subsection = run(
      2,
      '5.2. Investigating Attention Heads',
      0.1,
      0.22,
      0.5,
    )
    subsection.fontName = 'NimbusRomNo9L-Medi'
    const nextSubsection = run(2, '5.3. Looking at MLPs', 0.1, 0.38, 0.4)
    nextSubsection.fontName = 'NimbusRomNo9L-Medi'
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Paper', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
          run(1, 'Introductory context.', 0.1, 0.24, 0.7),
        ]),
        page(2, [
          mainHeading,
          subsection,
          run(
            2,
            'In GPT-J, every attention layer is the sum of its heads.',
            0.1,
            0.243,
            0.7,
          ),
          nextSubsection,
          run(
            2,
            'GPT-J predominantly relies on the last token MLPs.',
            0.1,
            0.403,
            0.7,
          ),
          run(2, '5.4.1. MODELING NEURON PREACTIVATIONS', 0.1, 0.54, 0.58),
          run(
            2,
            'The first nested subsection remains ordinary prose.',
            0.1,
            0.563,
            0.7,
          ),
          run(2, '5.4.2. UNDERSTANDING MLP INPUTS', 0.1, 0.68, 0.56),
          run(
            2,
            'The second nested subsection remains ordinary prose.',
            0.1,
            0.703,
            0.7,
          ),
        ]),
      ],
      sourceHash: '6'.repeat(64),
      fileName: 'styled-section-prefixes.pdf',
      byteLength: 4096,
    })

    const headings = result.paper.nodes.flatMap((node) =>
      node.type === 'heading' && node.text !== 'Abstract' ? [node] : [],
    )
    expect(headings.map((node) => node.text)).toEqual([
      '5. LLMs Use the Clock Algorithm to Compute Addition',
      '5.2. Investigating Attention Heads',
      '5.3. Looking at MLPs',
      '5.4.1. MODELING NEURON PREACTIVATIONS',
      '5.4.2. UNDERSTANDING MLP INPUTS',
    ])
    expect(
      result.paper.nodes.filter(
        (node) => node.type === 'paragraph' && node.list,
      ),
    ).toEqual([])
    expect(
      headings.map((node) => result.provenance[node.id].boxes.length),
    ).toEqual([1, 1, 1, 1, 1])
  })

  it('keeps lowercase equation-shaped prose out of the heading hierarchy', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(
            1,
            'Ordinary context establishes the experiment.',
            0.1,
            0.16,
            0.7,
          ),
          run(1, 'More ordinary context fixes the body size.', 0.1, 0.2, 0.7),
          run(
            1,
            'results hold when fitting the b token = stable',
            0.1,
            0.3,
            0.7,
            12,
          ),
          run(1, 'The explanation then continues as prose.', 0.1, 0.4, 0.7),
        ]),
      ],
      sourceHash: '5'.repeat(64),
      fileName: 'lowercase-equation-prose.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.find(
        (node) =>
          'text' in node &&
          node.text === 'results hold when fitting the b token = stable',
      ),
    ).toMatchObject({ type: 'paragraph' })
  })

  it('requires section syntax or boundary evidence instead of font size alone', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Title', 0.1, 0.02, 0.5, 22),
          run(1, 'Abstract', 0.1, 0.08, 0.25, 16),
          run(1, 'Short abstract.', 0.1, 0.14, 0.72),
          run(1, '1 Introduction', 0.1, 0.22, 0.35, 10),
          run(1, 'A large-font callout remains prose.', 0.1, 0.3, 0.72, 18),
          run(1, '2 Related Work', 0.1, 0.38, 0.35, 10),
          run(1, 'Section prose.', 0.1, 0.46, 0.72),
          run(1, 'Additional section prose.', 0.1, 0.54, 0.72),
          run(1, 'Final section prose.', 0.1, 0.62, 0.72),
        ]),
      ],
      sourceHash: '2'.repeat(64),
      fileName: 'heading-evidence.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.find(
        (node) =>
          'text' in node && node.text === 'A large-font callout remains prose.',
      ),
    ).toMatchObject({ type: 'paragraph' })
    expect(
      result.paper.nodes.find(
        (node) => 'text' in node && node.text === '2 Related Work',
      ),
    ).toMatchObject({ type: 'heading' })
  })

  it('preserves ordered-list ordinals and cross-page continuation evidence', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '3. Third item', 0.1, 0.2, 0.4),
          run(1, '4. Fourth item', 0.1, 0.3, 0.4),
          run(1, '1', 0.48, 0.95, 0.02, 8),
        ]),
        page(2, [
          run(2, '5. Fifth item', 0.1, 0.12, 0.4),
          run(2, '2', 0.48, 0.95, 0.02, 8),
        ]),
      ],
      sourceHash: '3'.repeat(64),
      fileName: 'continued-list.pdf',
      byteLength: 4096,
    })

    const lists = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list ? [node.list] : [],
    )
    expect(lists).toEqual([
      expect.objectContaining({
        numberingId: expect.stringMatching(/^pdf-list-p001-/),
        markerStyle: 'decimal',
        ordinal: 3,
      }),
      expect.objectContaining({
        numberingId: expect.stringMatching(/^pdf-list-p001-/),
        markerStyle: 'decimal',
        ordinal: 4,
      }),
      expect.objectContaining({
        numberingId: expect.stringMatching(/^pdf-list-p001-/),
        markerStyle: 'decimal',
        ordinal: 5,
        continuedFromPreviousPage: true,
      }),
    ])
    expect(new Set(lists.map((list) => list.numberingId)).size).toBe(1)
  })

  it('does not interpret a two-column list transition as deep nesting', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '1. Left item one', 0.08, 0.2, 0.34),
          run(1, '1. Right item one', 0.56, 0.2, 0.34),
          run(1, '2. Left item two', 0.08, 0.26, 0.34),
          run(1, '2. Right item two', 0.56, 0.26, 0.34),
          run(1, '3. Left item three', 0.08, 0.32, 0.34),
          run(1, '3. Right item three', 0.56, 0.32, 0.34),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'two-column-lists.pdf',
      byteLength: 4096,
    })

    const lists = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list ? [node.list] : [],
    )
    expect(lists).toHaveLength(6)
    expect(lists.map((list) => list.level)).toEqual([1, 1, 1, 1, 1, 1])
    expect(new Set(lists.map((list) => list.numberingId)).size).toBe(2)
  })

  it('preserves bracketed, parenthesized, and suffixed list markers with gaps', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '1) First item', 0.1, 0.2, 0.4),
          run(1, '(a) Nested alpha item', 0.14, 0.26, 0.4),
          run(1, '(1) Nested numeric item', 0.14, 0.32, 0.4),
          run(1, '3) Third item after a gap', 0.1, 0.38, 0.4),
        ]),
        page(2, [run(2, '4) Fourth item continues.', 0.1, 0.12, 0.5)]),
        page(3, [
          run(3, 'References', 0.1, 0.12, 0.3, 16),
          run(3, '[1] Bracketed reference.', 0.1, 0.22, 0.6),
        ]),
      ],
      sourceHash: '4'.repeat(64),
      fileName: 'marker-fidelity.pdf',
      byteLength: 4096,
    })

    const listNodes = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list ? [node] : [],
    )
    expect(
      listNodes.map((node) => ({ text: node.text, list: node.list })),
    ).toEqual([
      expect.objectContaining({
        text: 'First item',
        list: expect.objectContaining({
          markerText: '1)',
          markerStyle: 'decimal',
          ordinal: 1,
        }),
      }),
      expect.objectContaining({
        text: 'Nested alpha item',
        list: expect.objectContaining({
          markerText: '(a)',
          markerStyle: 'lower-alpha',
          ordinal: 1,
        }),
      }),
      expect.objectContaining({
        text: 'Nested numeric item',
        list: expect.objectContaining({
          markerText: '(1)',
          markerStyle: 'decimal',
          ordinal: 1,
        }),
      }),
      expect.objectContaining({
        text: 'Third item after a gap',
        list: expect.objectContaining({
          markerText: '3)',
          markerStyle: 'decimal',
          ordinal: 3,
        }),
      }),
      expect.objectContaining({
        text: 'Fourth item continues.',
        list: expect.objectContaining({
          markerText: '4)',
          markerStyle: 'decimal',
          ordinal: 4,
          continuedFromPreviousPage: true,
        }),
      }),
      expect.objectContaining({
        text: 'Bracketed reference.',
        list: expect.objectContaining({
          markerText: '[1]',
          markerStyle: 'decimal',
          ordinal: 1,
          numberingId: 'references',
        }),
      }),
    ])
    const proseListIds = listNodes
      .filter((node) => node.list?.numberingId !== 'references')
      .map((node) => node.list!.numberingId)
    expect(new Set(proseListIds).size).toBe(1)
  })

  it('synthesizes an exact later marker classification when one bibliography region is split', () => {
    const firstText = '[1] First source-backed reference.'
    const secondText = '[2] Second source-backed reference.'
    const sourceText = `${firstText} ${secondText}`
    const firstRun = run(2, firstText, 0.1, 0.2, 0.72)
    const secondRun = run(2, secondText, 0.1, 0.222, 0.72)
    const sourceRegion = {
      id: 'merged-bibliography-region',
      page: 2,
      kind: 'endnote',
      column: 'single',
      text: sourceText,
      confidence: 1,
      box: {
        page: 2,
        x: 0.1,
        y: 0.2,
        width: 0.72,
        height: 0.04,
        rotation: 0,
        method: 'pdf-text',
      },
      lines: [firstRun, secondRun].map((sourceRun, index) => ({
        id: `merged-reference-line-${index + 1}`,
        text: sourceRun.text,
        fontSize: sourceRun.fontSize,
        box: { ...sourceRun },
        runs: [{ ...sourceRun }],
      })),
      nativeObjectIds: [],
      includedInReadingOrder: true,
    } satisfies import('./import-types').PdfPageRegion
    const secondSourceStart = firstText.length + 1
    const evidenceRegion = {
      ...sourceRegion,
      text: secondText,
      box: { ...secondRun },
      lines: [sourceRegion.lines[1]],
    }
    const classifications = synthesizeRecoveredBibliographyClassifications(
      [
        {
          id: 'existing-reference-1',
          label: '1',
          referenceRegionId: sourceRegion.id,
          start: 0,
          end: 3,
          taxonomy: 'bibliography-entry',
          disposition: 'plain-text',
          confidence: 0.99,
          threshold: 0.85,
          accepted: true,
          evidence: ['source-backed-bibliography-marker'],
          sourceBox: { ...firstRun },
        },
      ],
      [
        {
          region: evidenceRegion,
          list: {
            numberingId: 'references',
            ordinal: 2,
            markerText: '[2]',
          },
          sourceSegments: [
            {
              region: sourceRegion,
              evidenceRegion,
              sourceStart: secondSourceStart + 4,
              canonicalStart: 0,
              text: 'Second source-backed reference.',
            },
          ],
        },
      ],
    )

    expect(classifications).toHaveLength(2)
    expect(classifications[1]).toMatchObject({
      label: '2',
      referenceRegionId: sourceRegion.id,
      start: secondSourceStart,
      end: secondSourceStart + 3,
      taxonomy: 'bibliography-entry',
      accepted: true,
      sourceBox: secondRun,
    })
    expect(
      sourceRegion.text.slice(classifications[1].start, classifications[1].end),
    ).toBe('[2]')
  })

  it('maps citations to every numbered bibliography entry', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Citation Study', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.16, 0.3, 16),
          run(
            1,
            'Prior work [1, 2] establishes the baseline.',
            0.1,
            0.24,
            0.72,
          ),
        ]),
        page(2, [
          run(2, 'References', 0.1, 0.1, 0.3, 16),
          run(2, '[1] First source-backed reference.', 0.1, 0.82, 0.72, 7),
          run(2, '[2] Second source-backed reference.', 0.1, 0.838, 0.72, 7),
        ]),
      ],
      sourceHash: '6'.repeat(64),
      fileName: 'merged-numbered-references.pdf',
      byteLength: 4096,
    })

    const references = result.paper.nodes.flatMap((node) =>
      node.type === 'paragraph' && node.list?.numberingId === 'references'
        ? [node]
        : [],
    )
    expect(references).toHaveLength(2)
    expect(references.map((node) => node.list?.ordinal)).toEqual([1, 2])

    const bibliographyClassifications = result.diagnostics.flatMap(
      (diagnostic) =>
        diagnostic.noteMarkerClassification?.taxonomy === 'bibliography-entry'
          ? [diagnostic.noteMarkerClassification]
          : [],
    )
    expect(
      bibliographyClassifications.map((classification) => ({
        label: classification.label,
        sourceText: result.regions
          .find((region) => region.id === classification.referenceRegionId)!
          .text.slice(classification.start, classification.end),
      })),
    ).toEqual([
      { label: '1', sourceText: '[1]' },
      { label: '2', sourceText: '[2]' },
    ])
    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['1', '2'],
        status: 'matched',
        targetNodeIds: [references[0].id, references[1].id],
      }),
    ])
    expect(result.provenance[references[0].id].regionIds).not.toEqual(
      result.provenance[references[1].id].regionIds,
    )
    expect(result.provenance[references[0].id].boxes).not.toEqual(
      result.provenance[references[1].id].boxes,
    )
  })

  it('does not turn a parenthesized citation year into a numbered list', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Zhou et al.', 0.1, 0.3, 0.7),
          run(
            1,
            '(2024) analyze a fine-tuned model and report results.',
            0.1,
            0.34,
            0.7,
          ),
        ]),
      ],
      sourceHash: 'f'.repeat(64),
      fileName: 'citation-year.pdf',
      byteLength: 4096,
    })

    expect(
      result.paper.nodes.filter(
        (node) => node.type === 'paragraph' && node.list,
      ),
    ).toEqual([])
    expect(
      result.paper.nodes
        .filter((node) => node.type === 'paragraph')
        .map((node) => node.text)
        .join(' '),
    ).toContain('(2024) analyze a fine-tuned model')
  })

  it('retains a typographic section heading phrased as a question', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'A Source-Backed Paper', 0.1, 0.08, 0.7, 22),
          run(1, 'Abstract', 0.1, 0.18, 0.3, 16),
          run(1, 'Introductory prose line one', 0.1, 0.24, 0.7),
          run(1, 'continues on line two', 0.1, 0.27, 0.7),
          run(1, 'and continues on line three', 0.1, 0.3, 0.7),
          run(1, 'before ending on line four.', 0.1, 0.33, 0.7),
          run(1, 'E. Why Use This Algorithm at All?', 0.1, 0.4, 0.5, 16),
          run(1, 'The appendix answer remains prose.', 0.1, 0.48, 0.7),
        ]),
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'question-heading.pdf',
      byteLength: 4096,
    })

    expect(result.paper.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'heading',
          text: 'E. Why Use This Algorithm at All?',
        }),
      ]),
    )
  })

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
    expect(result.citationRelationships).toEqual([
      expect.objectContaining({
        labels: ['ahn:2024', 'biderman:2023'],
        status: 'matched',
        targetNodeIds: [references[0].id, references[1].id],
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

  it('removes repeated margins and retains normalized source-box provenance', async () => {
    const pages = [
      page(1, [
        run(1, 'Journal 2026', 0.1, 0.02, 0.2, 8),
        run(1, 'A Semantic Paper', 0.1, 0.15, 0.7, 22),
        run(1, 'This is the first reconstructed paragraph.', 0.1, 0.24, 0.72),
      ]),
      page(2, [
        run(2, 'Journal 2026', 0.1, 0.02, 0.2, 8),
        run(2, 'Methods', 0.1, 0.16, 0.25, 17),
        run(2, 'The second page remains in reading order.', 0.1, 0.24, 0.7),
      ]),
    ]
    const result = await reconstructPageAnalyses({
      pages,
      sourceHash: 'a'.repeat(64),
      fileName: 'paper.pdf',
      byteLength: 2048,
      metadata: { author: 'Ada Example', modified: '2026-07-13' },
    })

    expect(result.paper.title).toBe('A Semantic Paper')
    expect(result.paper.authors).toEqual(['Ada Example'])
    expect(
      result.paper.nodes.map((node) => 'text' in node && node.text),
    ).not.toContain('Journal 2026')
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'REPEATED_MARGIN_TEXT' }),
      ]),
    )
    const first = result.paper.nodes[0]
    expect(result.provenance[first.id]).toMatchObject({
      confidence: 0.9,
      pages: [1],
    })
    expect(result.provenance[first.id].boxes[0]).toMatchObject({
      page: 1,
      method: 'pdf-text',
      x: 0.1,
      y: 0.15,
    })
  })

  it('retains embedded links alongside reconstructed node provenance', async () => {
    const linked = page(1, [
      run(1, 'Linked embedded text remains source evidence.', 0.1, 0.2, 0.7),
    ])
    linked.links = [
      {
        url: 'https://example.test/evidence',
        box: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.3,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [linked],
      sourceHash: 'e'.repeat(64),
      fileName: 'linked.pdf',
      byteLength: 2048,
    })

    expect(Object.values(result.provenance)[0].links).toEqual(linked.links)
  })

  it('does not project a link annotation onto matching geometry on another page', async () => {
    const first = page(1, [
      run(1, 'Linked text on the annotated page.', 0.1, 0.2, 0.7),
    ])
    first.links = [
      {
        url: 'https://example.test/page-one',
        box: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.3,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]
    const second = page(2, [
      run(2, 'Plain text at matching coordinates.', 0.1, 0.2, 0.7),
    ])

    const result = await reconstructPageAnalyses({
      pages: [first, second],
      sourceHash: 'd'.repeat(64),
      fileName: 'page-scoped-link.pdf',
      byteLength: 2048,
    })
    const linked = result.paper.nodes.find(
      (node) => 'text' in node && node.text.includes('Linked text'),
    )
    const plain = result.paper.nodes.find(
      (node) => 'text' in node && node.text.includes('Plain text'),
    )

    expect(
      linked && 'inlineRuns' in linked
        ? linked.inlineRuns?.some(
            (inline) => inline.href === 'https://example.test/page-one',
          )
        : false,
    ).toBe(true)
    expect(
      plain && 'inlineRuns' in plain
        ? plain.inlineRuns?.some((inline) => inline.href)
        : false,
    ).toBe(false)
  })

  it('orders detected columns left before right without storing target geometry', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Left one.', 0.08, 0.2, 0.32),
          run(1, 'Left two.', 0.08, 0.24, 0.32),
          run(1, 'Left three.', 0.08, 0.28, 0.32),
          run(1, 'Right one.', 0.55, 0.2, 0.32),
          run(1, 'Right two.', 0.55, 0.24, 0.32),
          run(1, 'Right three.', 0.55, 0.28, 0.32),
        ]),
      ],
      sourceHash: 'b'.repeat(64),
      fileName: 'columns.pdf',
      byteLength: 4096,
    })
    const text = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .join(' ')
    expect(text.indexOf('Left one')).toBeLessThan(text.indexOf('Right one'))
    expect(result.paper).not.toHaveProperty('geometry')
    expect(result.paper).not.toHaveProperty('pages')
  })

  it('preserves narrow-gutter columns instead of interleaving their rows', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Left one.', 0.08, 0.2, 0.43),
          run(1, 'Right one.', 0.53, 0.2, 0.39),
          run(1, 'Left two.', 0.08, 0.24, 0.43),
          run(1, 'Right two.', 0.53, 0.24, 0.39),
          run(1, 'Left three.', 0.08, 0.28, 0.43),
          run(1, 'Right three.', 0.53, 0.28, 0.39),
        ]),
      ],
      sourceHash: '1'.repeat(64),
      fileName: 'narrow-gutter-columns.pdf',
      byteLength: 2048,
    })

    const text = result.paper.nodes
      .map((node) => ('text' in node ? node.text : ''))
      .join(' ')
    expect(text.indexOf('Left three')).toBeLessThan(text.indexOf('Right one'))
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNPROVENANCED_RENDERED_UNIT',
      ]),
    })
  })

  it('fails closed when a short two-column page cannot be ordered safely', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Left one.', 0.08, 0.2, 0.32),
          run(1, 'Right one.', 0.55, 0.2, 0.32),
          run(1, 'Indented left two.', 0.18, 0.7, 0.22),
          run(1, 'Right two.', 0.55, 0.7, 0.32),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'short-columns.pdf',
      byteLength: 2048,
    })

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AMBIGUOUS_READING_ORDER',
          severity: 'error',
        }),
      ]),
    )
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
  })

  it('uses visual line grouping to detect split, out-of-order captions', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, '1. A split caption', 0.2, 0.398, 0.32, 8),
          run(1, 'Figure', 0.1, 0.4, 0.08, 8),
        ]),
      ],
      sourceHash: 'e'.repeat(64),
      fileName: 'split-caption.pdf',
      byteLength: 2048,
    })

    expect(result.semanticSignals.captions).toBe(1)
    expect(result.completeness.unresolvedObjects.captions).toBe(1)
    expect(result.readiness.ready).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INCOMPLETE_RELATIONSHIP_COVERAGE',
          severity: 'error',
        }),
      ]),
    )
  })

  it('reconciles a multi-run caption envelope with strict visual provenance', async () => {
    const figureBox: NormalizedSourceBox = {
      page: 1,
      x: 0.25,
      y: 0.14,
      width: 0.3,
      height: 0.2,
      rotation: 0,
      method: 'pdf-object',
    }
    const sourcePage = page(1, [
      run(
        1,
        'Figure 1. A multi-run',
        0.20004503944386193,
        0.4,
        0.20003758366009416,
        8,
      ),
      run(
        1,
        'caption envelope.',
        0.42003177397559277,
        0.4,
        0.2000623840055811,
        8,
      ),
    ])
    sourcePage.imageCount = 1
    sourcePage.objects = [
      {
        id: 'image-p001-001',
        page: 1,
        kind: 'image',
        box: figureBox,
        confidence: 0.99,
        assetId: null,
        role: 'semantic',
      },
    ]
    const result = await reconstructPageAnalyses({
      pages: [sourcePage],
      sourceHash: 'a'.repeat(64),
      fileName: 'multi-run-caption.pdf',
      byteLength: 4096,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 8,
          height: 8,
          pixels: new Uint8Array(8 * 8 * 4).fill(96),
        }),
    })

    const relationship = result.visualRelationships.find(
      (candidate) => candidate.status === 'matched',
    )!
    const captionEvidence = result.provenance[relationship.captionNodeId!]
    const visualEvidence = result.provenance[relationship.canonicalNodeId!]
    expect(captionEvidence.boxes).toHaveLength(2)
    expect(relationship.sourceBoxes[0]).toMatchObject({
      page: 1,
      x: 0.20005,
      y: 0.4,
      width: 0.42004,
      height: 0.018,
      rotation: 0,
      method: 'pdf-text',
    })
    expect(visualEvidence.boxes).toEqual(relationship.sourceBoxes)
    expect(
      validatedPdfVisualRelationships({
        paper: result.paper,
        provenance: result.provenance,
        relationships: result.visualRelationships,
        assets: result.assets,
      }),
    ).toEqual([relationship])
  })

  it('orders canonical figure-caption pairs by the verified visual column flow', async () => {
    const figureBoxes: NormalizedSourceBox[] = [
      {
        page: 1,
        x: 0.09,
        y: 0.09,
        width: 0.38,
        height: 0.15,
        rotation: 0,
        method: 'pdf-object',
      },
      {
        page: 1,
        x: 0.09,
        y: 0.32,
        width: 0.38,
        height: 0.14,
        rotation: 0,
        method: 'pdf-object',
      },
      {
        page: 1,
        x: 0.09,
        y: 0.58,
        width: 0.38,
        height: 0.23,
        rotation: 0,
        method: 'pdf-object',
      },
      {
        page: 1,
        x: 0.502,
        y: 0.27,
        width: 0.38,
        height: 0.36,
        rotation: 0,
        method: 'pdf-object',
      },
    ]
    const sourcePage = page(1, [
      run(1, 'Figure 15. First left-column figure.', 0.09, 0.255, 0.38, 8),
      run(1, 'Figure 16. Second left-column figure.', 0.09, 0.47, 0.38, 8),
      run(1, 'Figure 17. Third left-column figure.', 0.09, 0.827, 0.38, 8),
      run(1, 'Figure 18. Right-column figure.', 0.502, 0.652, 0.38, 8),
    ])
    sourcePage.imageCount = figureBoxes.length
    sourcePage.objects = figureBoxes.map((box, index) => ({
      id: `image-visual-column-${index + 1}`,
      page: 1,
      kind: 'image',
      box,
      confidence: 0.98,
      assetId: null,
      role: 'semantic',
    }))

    const result = await reconstructPageAnalyses({
      pages: [sourcePage],
      sourceHash: 'f'.repeat(64),
      fileName: 'visual-column-order.pdf',
      byteLength: 4096,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 8,
          height: 8,
          pixels: new Uint8Array(8 * 8 * 4).fill(96),
        }),
    })
    const labelByNodeId = new Map(
      result.visualRelationships.map((relationship) => [
        relationship.canonicalNodeId,
        relationship.label,
      ]),
    )

    expect(result.visualRelationships.map(({ label }) => label)).toEqual([
      'Figure 15',
      'Figure 16',
      'Figure 17',
      'Figure 18',
    ])
    expect(
      result.paper.nodes.flatMap((node) =>
        node.type === 'figure' ? [labelByNodeId.get(node.id)] : [],
      ),
    ).toEqual(['Figure 15', 'Figure 16', 'Figure 17', 'Figure 18'])
  })

  it('retains source-text equation lineage when the equation is its own caption', async () => {
    const equationRun = run(1, 'E = m c 2', 0.3, 0.28, 0.24, 12)
    const result = await reconstructPageAnalyses({
      pages: [page(1, [equationRun])],
      sourceHash: 'b'.repeat(64),
      fileName: 'source-text-equation.pdf',
      byteLength: 2048,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 8,
          height: 4,
          pixels: new Uint8Array(8 * 4 * 4).fill(96),
        }),
    })

    const relationship = result.visualRelationships.find(
      (candidate) => candidate.kind === 'equation',
    )!
    const asset = result.assets.find(
      (candidate) => candidate.id === relationship.assetIds[0],
    )!

    expect(relationship).toMatchObject({
      status: 'matched',
      altTextSource: 'source-text',
      captionRegionId: relationship.sourceRegionIds[0],
      sourceObjectIds: [expect.stringMatching(/^equation-source-/)],
      canonicalNodeId: expect.any(String),
      captionNodeId: expect.any(String),
    })
    expect(relationship.sourceBoxes).toHaveLength(2)
    expect(relationship.sourceBoxes[0]).toEqual(relationship.sourceBoxes[1])
    expect(relationship.sourceBoxes[1]).toEqual(asset.sourceBoxes[0])
    expect(result.provenance[relationship.canonicalNodeId!].boxes).toEqual(
      relationship.sourceBoxes,
    )
    expect(
      validatedPdfVisualRelationships({
        paper: result.paper,
        provenance: result.provenance,
        relationships: result.visualRelationships,
        assets: result.assets,
      }),
    ).toEqual([relationship])
  })

  it('uses a source equation label without publishing an unsafe glyph transcript', async () => {
    const opening = run(1, '\u0012', 0.81, 0.09, 0.012, 10)
    opening.fontName = 'Synthetic-CMEX10'
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Ordinary prose establishes the body font.', 0.1, 0.3, 0.36),
          run(1, 'Another ordinary prose line.', 0.1, 0.33, 0.3),
          opening,
          run(1, 'N(a,b) = c + d', 0.5, 0.115, 0.35, 12),
          run(1, 'd(a,b) = e', 0.52, 0.135, 0.3, 12),
          run(1, '(3)', 0.87, 0.155, 0.02, 10),
        ]),
      ],
      sourceHash: 'd'.repeat(64),
      fileName: 'unsafe-source-equation.pdf',
      byteLength: 2048,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 16,
          height: 6,
          pixels: new Uint8Array(16 * 6 * 4).fill(96),
        }),
    })

    const relationship = result.visualRelationships.find(
      (candidate) => candidate.kind === 'equation',
    )!
    expect(relationship).toMatchObject({
      status: 'matched',
      label: 'Equation 3',
      sourceText: '',
      altText: 'Equation 3',
      altTextSource: 'caption',
      canonicalNodeId: expect.any(String),
      captionNodeId: expect.any(String),
      evidence: expect.arrayContaining(['source-text-transcript-unresolved']),
    })
    expect(
      result.paper.nodes.find((node) => node.id === relationship.captionNodeId),
    ).toMatchObject({ type: 'caption', text: 'Equation 3' })
    expect(
      result.paper.nodes.some(
        (node) =>
          'text' in node &&
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(node.text),
      ),
    ).toBe(false)
  })

  it('assigns source-anchored unique canonical ids to repeated equation labels', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'E = m c 2 (1)', 0.28, 0.24, 0.3, 12),
          run(1, 'F = m a (1)', 0.28, 0.62, 0.3, 12),
        ]),
      ],
      sourceHash: 'c'.repeat(64),
      fileName: 'repeated-equation-labels.pdf',
      byteLength: 2048,
      rasterizeFigure: async (input) =>
        createSourcePageCropAsset({
          kind: input.kind === 'figure' ? 'raster' : input.kind,
          cropBox: input.sourceBox,
          sourceObjectIds: input.sourceObjectIds,
          sourceBoxes: input.sourceBoxes,
          width: 8,
          height: 4,
          pixels: new Uint8Array(8 * 4 * 4).fill(96),
        }),
    })

    const relationships = result.visualRelationships.filter(
      (candidate) =>
        candidate.kind === 'equation' && candidate.status === 'matched',
    )
    const canonicalNodeIds = relationships.map(
      (relationship) => relationship.canonicalNodeId!,
    )

    expect(relationships).toHaveLength(2)
    expect(new Set(canonicalNodeIds).size).toBe(2)
    expect(canonicalNodeIds).toEqual([
      expect.stringContaining('equation-source-p001-001'),
      expect.stringContaining('equation-source-p001-002'),
    ])
    for (const relationship of relationships) {
      expect(
        result.paper.nodes.filter(
          (candidate) => candidate.id === relationship.canonicalNodeId,
        ),
      ).toHaveLength(1)
      expect(result.provenance[relationship.canonicalNodeId!].boxes).toEqual(
        relationship.sourceBoxes,
      )
    }
    expect(
      validatedPdfVisualRelationships({
        paper: result.paper,
        provenance: result.provenance,
        relationships: result.visualRelationships,
        assets: result.assets,
      }),
    ).toEqual(relationships)
  })

  it('rejects malformed or disjoint caption provenance envelopes', () => {
    const placeholder: NormalizedSourceBox = {
      page: 1,
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.52,
      rotation: 0,
      method: 'pdf-text',
    }
    const box = (
      overrides: Partial<NormalizedSourceBox> = {},
    ): NormalizedSourceBox => ({
      page: 1,
      x: 0.12,
      y: 0.22,
      width: 0.24,
      height: 0.018,
      rotation: 0,
      method: 'pdf-text',
      ...overrides,
    })
    const evidence = (boxes: NormalizedSourceBox[], pages = [1]) => ({
      confidence: 1,
      pages,
      regionIds: ['caption-region'],
      boxes,
      links: [],
    })

    expect(
      captionProvenanceEnvelope(undefined, 'caption-region', placeholder),
    ).toBeNull()
    expect(
      captionProvenanceEnvelope(
        evidence([box(), box({ page: 2 })], [1, 2]),
        'caption-region',
        placeholder,
      ),
    ).toBeNull()
    expect(
      captionProvenanceEnvelope(
        evidence([box(), box({ x: 0.38, method: 'ocr' })]),
        'caption-region',
        placeholder,
      ),
    ).toBeNull()
    expect(
      captionProvenanceEnvelope(
        evidence([box(), box({ x: 0.38, rotation: 90 })]),
        'caption-region',
        placeholder,
      ),
    ).toBeNull()
    expect(
      captionProvenanceEnvelope(
        evidence([box(), box({ x: 0.75, y: 0.68, width: 0.1, height: 0.02 })]),
        'caption-region',
        placeholder,
      ),
    ).toBeNull()
  })

  it('allows a connected source-text equation envelope to expose exact script glyph bounds', () => {
    const placeholder: NormalizedSourceBox = {
      page: 1,
      x: 0.3,
      y: 0.28,
      width: 0.24,
      height: 0.018,
      rotation: 0,
      method: 'pdf-text',
    }
    const evidence: NodeSourceEvidence = {
      confidence: 1,
      pages: [1],
      regionIds: ['equation-region'],
      boxes: [
        { ...placeholder, width: 0.2 },
        {
          ...placeholder,
          x: 0.505,
          y: 0.294,
          width: 0.02,
          height: 0.0076,
        },
      ],
      links: [],
    }

    expect(
      captionProvenanceEnvelope(evidence, 'equation-region', placeholder),
    ).toBeNull()
    expect(
      captionProvenanceEnvelope(evidence, 'equation-region', placeholder, {
        allowExactRegionOverflow: true,
      }),
    ).toMatchObject({
      x: 0.3,
      y: 0.28,
      width: 0.225,
      height: 0.0216,
    })
  })

  it('does not treat vertically separate metadata and body as columns', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'Metadata A', 0.7, 0.1, 0.2),
          run(1, 'Metadata B', 0.7, 0.14, 0.2),
          run(1, 'Body line one.', 0.1, 0.3, 0.2),
          run(1, 'Body line two.', 0.1, 0.34, 0.2),
        ]),
      ],
      sourceHash: 'f'.repeat(64),
      fileName: 'metadata-and-body.pdf',
      byteLength: 2048,
    })

    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AMBIGUOUS_READING_ORDER' }),
      ]),
    )
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNPROVENANCED_RENDERED_UNIT',
      ]),
    })
  })

  it('counts supplementary Unicode text by code point', async () => {
    const math = '𝑥'.repeat(30)
    const result = await reconstructPageAnalyses({
      pages: [page(1, [run(1, math, 0.1, 0.2, 0.5)])],
      sourceHash: '0'.repeat(64),
      fileName: 'unicode-math.pdf',
      byteLength: 2048,
    })

    expect(result.completeness).toMatchObject({
      sourceTextCharacters: 30,
      matchedTextCharacters: 30,
      unprovenancedRenderedUnitCount: 2,
    })
    expect(result.completeness.outputTextCharacters).toBeGreaterThan(30)
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNPROVENANCED_RENDERED_UNIT',
      ]),
    })
  })

  it('blocks publication when a line-boundary join remains unresolved', async () => {
    const result = await reconstructPageAnalyses({
      pages: [
        page(1, [
          run(1, 'short-', 0.1, 0.2, 0.18),
          run(1, 'continuation', 0.1, 0.225, 0.24),
        ]),
      ],
      sourceHash: '1'.repeat(64),
      fileName: 'unresolved-line-join.pdf',
      byteLength: 2048,
    })

    expect(result.unresolvedCorruptingJoinCount).toBe(1)
    expect(result.structurallyConsumedLineBoundaryCount).toBe(0)
    expect(result.completeness).toMatchObject({
      lineBoundaryCount: 1,
      decidedLineBoundaryCount: 1,
      unresolvedCorruptingJoinCount: 1,
      structurallyConsumedLineBoundaryCount: 0,
    })
    expect(
      result.lineBoundaryDecisions.filter((decision) =>
        ['unresolved', 'structural-boundary'].includes(decision.outcome),
      ),
    ).toHaveLength(
      result.unresolvedCorruptingJoinCount +
        result.structurallyConsumedLineBoundaryCount,
    )
    expect(result.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNRESOLVED_CORRUPTING_JOIN',
        'UNPROVENANCED_RENDERED_UNIT',
      ]),
    })
  })

  it('emits stable OCR gates instead of silently exporting partial text', async () => {
    const pages = [page(1, [], 'ocr-required')]
    const input = {
      pages,
      sourceHash: 'c'.repeat(64),
      fileName: 'scan.pdf',
      byteLength: 8192,
    }
    const first = await reconstructPageAnalyses(input)
    const second = await reconstructPageAnalyses(input)

    expect(first).toEqual(second)
    expect(first.paper.nodes).toEqual([])
    expect(first.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OCR_REQUIRED', severity: 'error' }),
        expect.objectContaining({ code: 'NO_RECONSTRUCTABLE_TEXT' }),
      ]),
    )
    expect(first.completeness.ocrRequiredPages).toEqual([1])
    expect(first.readiness).toMatchObject({
      ready: false,
      status: 'review-required',
    })
  })

  it('clears the OCR gate for accepted scan text without counting the scan surface as a figure', async () => {
    const ocrRun: PdfSourceRun = {
      ...run(
        1,
        'Recovered locally from a scanned source page with enough text.',
        0.1,
        0.2,
        0.72,
      ),
      method: 'ocr',
      confidence: 0.96,
    }
    const scanned: PdfPageAnalysis = {
      ...page(1, [ocrRun], 'ocr-complete'),
      objects: [
        {
          id: 'image-p001-001',
          page: 1,
          kind: 'image',
          assetId: null,
          role: 'scan-source',
          confidence: 0.98,
          box: {
            page: 1,
            x: 0.05,
            y: 0.05,
            width: 0.9,
            height: 0.9,
            rotation: 0,
            method: 'pdf-object',
          },
        },
      ],
      ocr: {
        engine: 'tesseract.js',
        engineVersion: '6.0.1',
        model: 'tessdata_best_int',
        modelVersion: '4.0.0',
        languages: ['eng'],
        languageMode: 'automatic-fallback',
        sourceSha256: 'a'.repeat(64),
        rasterSha256: 'b'.repeat(64),
        confidence: 0.96,
        words: [],
        lines: [],
      },
    }

    const result = await reconstructPageAnalyses({
      pages: [scanned],
      sourceHash: 'a'.repeat(64),
      fileName: 'scan.pdf',
      byteLength: 8192,
    })

    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OCR_REQUIRED' }),
      ]),
    )
    expect(result.completeness).toMatchObject({
      sourceAssetCount: 0,
      ocrRequiredPages: [],
    })
    expect(result.regions.some((region) => region.kind === 'figure')).toBe(
      false,
    )
    expect(result.readiness).toMatchObject({
      ready: false,
      blockingDiagnosticCodes: expect.arrayContaining([
        'UNPROVENANCED_RENDERED_UNIT',
      ]),
    })
  })

  it('blocks low-confidence OCR and uncertain spread boundaries for review', async () => {
    const ocrRun: PdfSourceRun = {
      ...run(1, 'Uncertain recovered scan text.', 0.1, 0.2, 0.35),
      method: 'ocr',
      confidence: 0.61,
    }
    const scanned: PdfPageAnalysis = {
      ...page(1, [ocrRun], 'ocr-complete'),
      width: 1224,
      ocr: {
        engine: 'tesseract.js',
        engineVersion: '6.0.1',
        model: 'tessdata_best_int',
        modelVersion: '4.0.0',
        languages: ['eng'],
        languageMode: 'explicit',
        sourceSha256: 'a'.repeat(64),
        rasterSha256: 'b'.repeat(64),
        confidence: 0.61,
        words: [],
        lines: [],
      },
      spread: {
        status: 'uncertain',
        boundary: 0.5,
        confidence: 0.55,
        logicalRegions: [],
      },
    }

    const result = await reconstructPageAnalyses({
      pages: [scanned],
      sourceHash: 'a'.repeat(64),
      fileName: 'spread.pdf',
      byteLength: 8192,
    })

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'LOW_CONFIDENCE_OCR',
          severity: 'error',
        }),
        expect.objectContaining({
          code: 'UNCERTAIN_SPREAD_BOUNDARY',
          severity: 'error',
        }),
      ]),
    )
    expect(result.readiness.ready).toBe(false)
  })

  it('maps only explicit academic italic font-name conventions', async () => {
    const syntheticRuns = [
      {
        text: 'A conventional math-italic family remains emphasized.',
        y: 0.2,
        fontName: 'ABCDEF+CMMI12',
      },
      {
        text: 'A second math-italic convention remains emphasized.',
        y: 0.24,
        fontName: 'ABCDEF+MTMI',
      },
      {
        text: 'A PostScript italic suffix remains emphasized.',
        y: 0.28,
        fontName: 'ABCDEF+ScholarlySerif-ReguItal',
      },
      {
        text: 'A merely similar family name remains plain.',
        y: 0.32,
        fontName: 'ABCDEF+SyntheticObliqueness',
      },
    ].map(({ text, y, fontName }) => ({
      ...run(1, text, 0.1, y, 0.75),
      fontName,
    }))
    const result = await reconstructPageAnalyses({
      pages: [page(1, syntheticRuns)],
      sourceHash: 'f'.repeat(64),
      fileName: 'synthetic-inline-fonts.pdf',
      byteLength: 2048,
    })
    const textNodes = result.paper.nodes.filter(
      (node) => 'text' in node && 'inlineRuns' in node,
    )
    const styleFor = (expected: string) => {
      const node = textNodes.find(
        (candidate) => 'text' in candidate && candidate.text.includes(expected),
      )
      if (!node || !('text' in node) || !('inlineRuns' in node))
        return undefined
      const start = node.text.indexOf(expected)
      return node.inlineRuns?.find(
        (candidate) =>
          candidate.start <= start && candidate.end >= start + expected.length,
      )
    }

    expect(styleFor(syntheticRuns[0].text)?.italic).toBe(true)
    expect(styleFor(syntheticRuns[1].text)?.italic).toBe(true)
    expect(styleFor(syntheticRuns[2].text)?.italic).toBe(true)
    expect(styleFor(syntheticRuns[3].text)?.italic).not.toBe(true)
  })

  it('retains raised caption glyphs as canonical caption inline semantics', async () => {
    const captionRuns = [
      {
        ...run(1, 'Figure 1. Score R', 0.1, 0.65, 0.25, 9),
        fontName: 'Caption',
      },
      {
        ...run(1, '2', 0.351, 0.646, 0.012, 6),
        height: 0.009,
        fontName: 'Caption',
      },
      {
        ...run(1, ' remains stable.', 0.372, 0.65, 0.16, 9),
        fontName: 'Caption',
      },
    ]
    const result = await reconstructPageAnalyses({
      pages: [page(1, captionRuns)],
      sourceHash: '7'.repeat(64),
      fileName: 'synthetic-caption-inline.pdf',
      byteLength: 2048,
    })
    const caption = result.paper.nodes.find(
      (node) => node.type === 'caption' && node.text.includes('Score'),
    )

    expect(caption?.type).toBe('caption')
    if (caption?.type !== 'caption') throw new Error('missing caption')
    expect(caption.text).toBe('Figure 1. Score R2 remains stable.')
    const superscriptStart = caption.text.indexOf('2')
    expect(caption.inlineRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          start: superscriptStart,
          end: superscriptStart + 1,
          verticalAlign: 'superscript',
        }),
      ]),
    )
  })

  it('maps a safe literal absolute URL when no PDF link annotation exists', async () => {
    const url = 'https://example.test/archive?q=one&lang=en'
    const literal = run(
      1,
      `Source evidence at ${url}, remains linked without an annotation.`,
      0.1,
      0.2,
      0.78,
    )
    const unsafe = run(
      1,
      'A javascript:alert(1) literal and /relative/path remain plain text.',
      0.1,
      0.24,
      0.78,
    )
    const result = await reconstructPageAnalyses({
      pages: [page(1, [literal, unsafe])],
      sourceHash: '1'.repeat(64),
      fileName: 'synthetic-literal-links.pdf',
      byteLength: 2048,
    })
    const node = result.paper.nodes.find(
      (candidate) => 'text' in candidate && candidate.text.includes(url),
    )

    expect(node && 'inlineRuns' in node ? node.inlineRuns : undefined).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          start: node && 'text' in node ? node.text.indexOf(url) : -1,
          end:
            node && 'text' in node ? node.text.indexOf(url) + url.length : -1,
          href: url,
        }),
      ]),
    )
    expect(
      result.paper.nodes.flatMap((candidate) =>
        'inlineRuns' in candidate
          ? (candidate.inlineRuns ?? []).flatMap((inline) =>
              inline.href ? [inline.href] : [],
            )
          : [],
      ),
    ).toEqual([url])
  })

  it('keeps text but rejects a malformed embedded URL instead of exporting it', async () => {
    const linked = page(1, [
      run(1, 'Malformed link text remains readable.', 0.1, 0.2, 0.7),
    ])
    linked.links = [
      {
        url: String.raw`https://example.test/archive\n\nor`,
        box: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.7,
          height: 0.018,
          rotation: 0,
          method: 'pdf-link',
        },
      },
    ]

    const result = await reconstructPageAnalyses({
      pages: [linked],
      sourceHash: '2'.repeat(64),
      fileName: 'synthetic-malformed-link.pdf',
      byteLength: 2048,
    })
    const textNode = result.paper.nodes.find(
      (candidate) =>
        'text' in candidate && candidate.text.includes('Malformed link text'),
    )

    expect(textNode && 'text' in textNode ? textNode.text : '').toContain(
      'Malformed link text remains readable.',
    )
    expect(
      textNode && 'inlineRuns' in textNode
        ? (textNode.inlineRuns ?? []).flatMap((run) =>
            run.href ? [run.href] : [],
          )
        : [],
    ).toEqual([])
  })
})

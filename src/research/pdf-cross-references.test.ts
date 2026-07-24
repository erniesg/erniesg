import { describe, expect, it } from 'vitest'
import type {
  PdfPageRegion,
  PdfScholarlyCrossReferenceKind,
} from './import-types'
import {
  resolvePdfScholarlyCrossReferences,
  type PdfCanonicalCrossReferenceTarget,
} from './pdf-cross-references'

function region(text: string): PdfPageRegion {
  const box = {
    page: 3,
    x: 0.1,
    y: 0.2,
    width: 0.8,
    height: 0.02,
    rotation: 0,
    method: 'pdf-text' as const,
  }
  return {
    id: 'source-region',
    page: 3,
    kind: 'body',
    column: 'single',
    text,
    confidence: 1,
    box,
    lines: [
      {
        id: 'source-line',
        text,
        fontSize: 10,
        box,
        runs: [
          {
            ...box,
            text,
            fontName: 'Body',
            fontSize: 10,
            confidence: 1,
          },
        ],
      },
    ],
    nativeObjectIds: [],
    includedInReadingOrder: true,
  }
}

function target(
  kind: PdfScholarlyCrossReferenceKind,
  label: string,
  nodeId = label.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-'),
): PdfCanonicalCrossReferenceTarget {
  return {
    kind,
    label,
    nodeId,
    evidence: ['proved-canonical-label'],
  }
}

describe('PDF scholarly cross references', () => {
  it('resolves exact singular, plural, appendix, section, and equation spans', () => {
    const text =
      'Figures 4 and 5 compare Table 2 with Section 6.1, Appendix A and J.7.1, Equation (3), Eq. 4, and Section J.7.1.'
    const canonicalTargets = [
      target('figure', 'Figure 4'),
      target('figure', 'Figure 5'),
      target('table', 'Table 2'),
      target('section', 'Section 6.1'),
      target('appendix', 'Appendix A'),
      target('appendix', 'Appendix J.7.1'),
      target('equation', 'Equation 3'),
      target('equation', 'Equation 4'),
      target('section', 'Section J.7.1'),
    ]

    const relationships = resolvePdfScholarlyCrossReferences({
      regions: [region(text)],
      canonicalTargets,
    })

    expect(relationships.map((relationship) => relationship.text)).toEqual([
      'Figures 4 and 5',
      'Table 2',
      'Section 6.1',
      'Appendix A and J.7.1',
      'Equation (3)',
      'Eq. 4',
      'Section J.7.1',
    ])
    expect(relationships.map((relationship) => relationship.status)).toEqual(
      Array(7).fill('matched'),
    )
    expect(relationships[0].targetNodeIds).toHaveLength(2)
    expect(relationships[3].targetNodeIds).toHaveLength(2)
    for (const relationship of relationships) {
      expect(
        text.slice(relationship.referenceStart, relationship.referenceEnd),
      ).toBe(relationship.text)
      for (const component of relationship.targets) {
        expect(
          text.slice(component.referenceStart, component.referenceEnd),
        ).toBe(component.label.split(' ').at(-1))
        expect(component.evidence).toContain('proved-canonical-label')
      }
    }
  })

  it('resolves compact comma and bounded semicolon scholarly reference lists', () => {
    const text = 'Figs. 1,2;3 compare Eqs. (1),(2);(3).'
    const relationships = resolvePdfScholarlyCrossReferences({
      regions: [region(text)],
      canonicalTargets: [
        target('figure', 'Figure 1'),
        target('figure', 'Figure 2'),
        target('figure', 'Figure 3'),
        target('equation', 'Equation 1'),
        target('equation', 'Equation 2'),
        target('equation', 'Equation 3'),
      ],
    })

    expect(
      relationships.map(({ text: value, labels, status }) => ({
        text: value,
        labels,
        status,
      })),
    ).toEqual([
      {
        text: 'Figs. 1,2;3',
        labels: ['Figure 1', 'Figure 2', 'Figure 3'],
        status: 'matched',
      },
      {
        text: 'Eqs. (1),(2);(3)',
        labels: ['Equation 1', 'Equation 2', 'Equation 3'],
        status: 'matched',
      },
    ])
  })

  it('fails closed for missing and duplicate canonical labels', () => {
    const text = 'Figure 4 differs from Table 9 and Appendix A.'
    const relationships = resolvePdfScholarlyCrossReferences({
      regions: [region(text)],
      canonicalTargets: [
        target('figure', 'Figure 4', 'figure-4-first'),
        target('figure', 'Figure 4', 'figure-4-second'),
        target('appendix', 'Appendix A', 'appendix-a'),
      ],
    })

    expect(
      relationships.map(({ text: value, status, targetNodeIds, targets }) => ({
        text: value,
        status,
        targetNodeIds,
        candidateNodeIds: targets[0].candidateNodeIds,
      })),
    ).toEqual([
      {
        text: 'Figure 4',
        status: 'ambiguous',
        targetNodeIds: [],
        candidateNodeIds: ['figure-4-first', 'figure-4-second'],
      },
      {
        text: 'Table 9',
        status: 'unresolved',
        targetNodeIds: [],
        candidateNodeIds: [],
      },
      {
        text: 'Appendix A',
        status: 'matched',
        targetNodeIds: ['appendix-a'],
        candidateNodeIds: ['appendix-a'],
      },
    ])
  })

  it('does not promote years, citations, or ordinary scholarly nouns', () => {
    const relationships = resolvePdfScholarlyCrossReferences({
      regions: [
        region(
          'In 2024 [1], the figure shows a table of results in this section. Equation solving is discussed, and the appendix contains details.',
        ),
      ],
      canonicalTargets: [],
    })

    expect(relationships).toEqual([])
  })

  it('keeps enclosing prose punctuation outside the linked source span', () => {
    const text = '(Figure 4) follows (Section 6). Equation (3) is bounded.'
    const relationships = resolvePdfScholarlyCrossReferences({
      regions: [region(text)],
      canonicalTargets: [
        target('figure', 'Figure 4'),
        target('section', 'Section 6'),
        target('equation', 'Equation 3'),
      ],
    })

    expect(relationships.map((relationship) => relationship.text)).toEqual([
      'Figure 4',
      'Section 6',
      'Equation (3)',
    ])
  })

  it('expands explicit numeric ranges instead of silently matching only the first label', () => {
    const text = 'Figures 1–3 are compared with Tables 4-5.'
    const relationships = resolvePdfScholarlyCrossReferences({
      regions: [region(text)],
      canonicalTargets: [
        target('figure', 'Figure 1'),
        target('figure', 'Figure 2'),
        target('figure', 'Figure 3'),
        target('table', 'Table 4'),
        target('table', 'Table 5'),
      ],
    })

    expect(
      relationships.map(({ text: value, labels, status }) => ({
        text: value,
        labels,
        status,
      })),
    ).toEqual([
      {
        text: 'Figures 1–3',
        labels: ['Figure 1', 'Figure 2', 'Figure 3'],
        status: 'matched',
      },
      {
        text: 'Tables 4-5',
        labels: ['Table 4', 'Table 5'],
        status: 'matched',
      },
    ])
  })

  it('expands a compact range enclosed by one pair of parentheses', () => {
    const [relationship] = resolvePdfScholarlyCrossReferences({
      regions: [
        region(
          'The model described in Eqs. (4.17-4.19) establishes the objective.',
        ),
      ],
      canonicalTargets: [
        target('equation', 'Equation 4.17'),
        target('equation', 'Equation 4.18'),
        target('equation', 'Equation 4.19'),
      ],
    })

    expect(relationship).toMatchObject({
      text: 'Eqs. (4.17-4.19)',
      labels: ['Equation 4.17', 'Equation 4.18', 'Equation 4.19'],
      status: 'matched',
    })
  })

  it('fails a compact parenthesized range closed when an implied target is absent', () => {
    const [relationship] = resolvePdfScholarlyCrossReferences({
      regions: [region('Eqs. (4.17–4.19) establish the objective.')],
      canonicalTargets: [
        target('equation', 'Equation 4.17'),
        target('equation', 'Equation 4.19'),
      ],
    })

    expect(relationship).toMatchObject({
      text: 'Eqs. (4.17–4.19)',
      labels: ['Equation 4.17', 'Equation 4.18', 'Equation 4.19'],
      status: 'unresolved',
      targetNodeIds: [],
    })
  })

  it('fails the whole range closed when any implied target is absent', () => {
    const [relationship] = resolvePdfScholarlyCrossReferences({
      regions: [region('Figures 1–3 summarize the result.')],
      canonicalTargets: [
        target('figure', 'Figure 1'),
        target('figure', 'Figure 3'),
      ],
    })

    expect(relationship).toMatchObject({
      text: 'Figures 1–3',
      labels: ['Figure 1', 'Figure 2', 'Figure 3'],
      status: 'unresolved',
      targetNodeIds: [],
    })
  })

  it('resolves roman-numbered visual labels', () => {
    const relationships = resolvePdfScholarlyCrossReferences({
      regions: [region('Figure IV and Table IX contain the ablation.')],
      canonicalTargets: [
        target('figure', 'Figure IV'),
        target('table', 'Table IX'),
      ],
    })

    expect(
      relationships.map(({ text: value, status }) => ({
        text: value,
        status,
      })),
    ).toEqual([
      { text: 'Figure IV', status: 'matched' },
      { text: 'Table IX', status: 'matched' },
    ])
  })

  it('resolves supplementary and compound visual labels', () => {
    const relationships = resolvePdfScholarlyCrossReferences({
      regions: [
        region(
          'Figure A.1 compares Table B-2 with Equation (S2.3) in the supplement.',
        ),
      ],
      canonicalTargets: [
        target('figure', 'Figure A.1'),
        target('table', 'Table B-2'),
        target('equation', 'Equation S2.3'),
      ],
    })

    expect(
      relationships.map(({ text: value, status }) => ({
        text: value,
        status,
      })),
    ).toEqual([
      { text: 'Figure A.1', status: 'matched' },
      { text: 'Table B-2', status: 'matched' },
      { text: 'Equation (S2.3)', status: 'matched' },
    ])
  })

  it('expands a bounded supplementary visual range', () => {
    const [relationship] = resolvePdfScholarlyCrossReferences({
      regions: [region('Figures S1–S3 summarize the supplementary result.')],
      canonicalTargets: [
        target('figure', 'Figure S1'),
        target('figure', 'Figure S2'),
        target('figure', 'Figure S3'),
      ],
    })

    expect(relationship).toMatchObject({
      text: 'Figures S1–S3',
      labels: ['Figure S1', 'Figure S2', 'Figure S3'],
      status: 'matched',
    })
  })

  it('retains line-scoped source geometry when surrounding text was dehyphenated', () => {
    const sourceRegion = region('We use Figure 2 in reconstructed results.')
    sourceRegion.lines[0].text = 'We use Figure 2 in recon-'
    sourceRegion.lines[0].box = {
      ...sourceRegion.lines[0].box,
      width: 0.42,
    }
    const [relationship] = resolvePdfScholarlyCrossReferences({
      regions: [sourceRegion],
      canonicalTargets: [target('figure', 'Figure 2')],
    })

    expect(relationship.sourceBoxes).toEqual([
      expect.objectContaining({ width: 0.42 }),
    ])
  })

  it('falls back from an explicit figure-panel suffix to one exact parent figure', () => {
    const [relationship] = resolvePdfScholarlyCrossReferences({
      regions: [region('Figure 12b isolates the second panel.')],
      canonicalTargets: [target('figure', 'Figure 12', 'figure-12')],
    })

    expect(relationship).toMatchObject({
      text: 'Figure 12b',
      labels: ['Figure 12b'],
      status: 'matched',
      targetNodeIds: ['figure-12'],
      targets: [
        expect.objectContaining({
          label: 'Figure 12b',
          status: 'matched',
          targetNodeId: 'figure-12',
          evidence: expect.arrayContaining([
            'explicit-panel-suffix',
            'canonical-parent-figure-fallback',
            'canonical-parent-label-unique',
          ]),
        }),
      ],
    })
  })

  it('prefers an exact subfigure target over its parent figure', () => {
    const [relationship] = resolvePdfScholarlyCrossReferences({
      regions: [region('Figure 12c isolates the third panel.')],
      canonicalTargets: [
        target('figure', 'Figure 12', 'figure-12'),
        target('figure', 'Figure 12c', 'figure-12c'),
      ],
    })

    expect(relationship).toMatchObject({
      status: 'matched',
      targetNodeIds: ['figure-12c'],
      targets: [
        expect.objectContaining({
          candidateNodeIds: ['figure-12c'],
          targetNodeId: 'figure-12c',
          evidence: expect.arrayContaining(['canonical-label-unique']),
        }),
      ],
    })
    expect(relationship.targets[0].evidence).not.toContain(
      'canonical-parent-figure-fallback',
    )
  })

  it('does not infer a panel parent from duplicate parents or non-figure labels', () => {
    const relationships = resolvePdfScholarlyCrossReferences({
      regions: [region('Figure 7a differs from Table 7a and Equation 7a.')],
      canonicalTargets: [
        target('figure', 'Figure 7', 'figure-7-first'),
        target('figure', 'Figure 7', 'figure-7-second'),
        target('table', 'Table 7', 'table-7'),
        target('equation', 'Equation 7', 'equation-7'),
      ],
    })

    expect(
      relationships.map(({ status, targetNodeIds, targets }) => ({
        status,
        targetNodeIds,
        candidateNodeIds: targets[0].candidateNodeIds,
      })),
    ).toEqual([
      { status: 'unresolved', targetNodeIds: [], candidateNodeIds: [] },
      { status: 'unresolved', targetNodeIds: [], candidateNodeIds: [] },
      { status: 'unresolved', targetNodeIds: [], candidateNodeIds: [] },
    ])
  })
})

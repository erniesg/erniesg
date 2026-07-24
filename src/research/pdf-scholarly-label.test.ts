import { describe, expect, it } from 'vitest'
import {
  expandPdfScholarlyVisualIdentifierRange,
  parsePdfScholarlyVisualLabel,
} from './pdf-scholarly-label'

describe('PDF scholarly visual labels', () => {
  it.each([
    ['Figure 12. Numeric caption.', 'figure', '12', 'Figure 12'],
    ['Fig. IV: Roman caption.', 'figure', 'IV', 'Figure IV'],
    ['Table II. Roman table.', 'table', 'II', 'Table II'],
    ['Table A1. Appendix table.', 'table', 'A1', 'Table A1'],
    ['Table A.1: Dotted appendix table.', 'table', 'A.1', 'Table A.1'],
    [
      'Equation S2.3 — Supplementary equation.',
      'equation',
      'S2.3',
      'Equation S2.3',
    ],
    ['Figure B-2. Hyphenated appendix figure.', 'figure', 'B-2', 'Figure B-2'],
  ] as const)(
    'parses the bounded caption label in %j',
    (text, kind, identifier, label) => {
      expect(
        parsePdfScholarlyVisualLabel(text, { context: 'caption' }),
      ).toMatchObject({
        status: 'parsed',
        kind,
        identifier,
        label,
        plural: false,
      })
    },
  )

  it('keeps an explicit caption obligation when its identifier is unparseable', () => {
    expect(
      parsePdfScholarlyVisualLabel('Figure: Source geometry remains visible.', {
        context: 'caption',
      }),
    ).toMatchObject({
      status: 'unparseable',
      kind: 'figure',
      identifier: null,
      label: 'Figure ?',
    })
    expect(
      parsePdfScholarlyVisualLabel(
        'Table S1.2.3.4.5. Identifier exceeds the segment cap.',
        { context: 'caption' },
      ),
    ).toMatchObject({
      status: 'unparseable',
      kind: 'table',
      identifier: 'S1.2.3.4.5',
    })
  })

  it('does not turn ordinary prefix prose into a caption label', () => {
    expect(
      parsePdfScholarlyVisualLabel('Figure shows the primary result.', {
        context: 'caption',
      }),
    ).toBeNull()
    expect(
      parsePdfScholarlyVisualLabel('Table results remain stable.', {
        context: 'caption',
      }),
    ).toBeNull()
    for (const value of [
      'Table ii',
      'Table mix',
      'Table MCMC',
      'Table IVX',
      'Table civil',
    ]) {
      expect(
        parsePdfScholarlyVisualLabel(value, { context: 'reference' }),
      ).toBeNull()
    }
  })

  it('resolves the ASCII-hyphen ambiguity by context', () => {
    expect(
      parsePdfScholarlyVisualLabel('Figure B-2', { context: 'reference' }),
    ).toMatchObject({
      status: 'parsed',
      identifier: 'B-2',
      plural: false,
    })
    expect(
      parsePdfScholarlyVisualLabel('Figures S1-S3', {
        context: 'reference',
      }),
    ).toMatchObject({
      status: 'parsed',
      identifier: 'S1',
      plural: true,
    })
  })

  it('expands only same-stem bounded supplementary ranges', () => {
    expect(expandPdfScholarlyVisualIdentifierRange('S1', 'S3')).toEqual([
      'S1',
      'S2',
      'S3',
    ])
    expect(expandPdfScholarlyVisualIdentifierRange('A.1', 'A.3')).toEqual([
      'A.1',
      'A.2',
      'A.3',
    ])
    expect(expandPdfScholarlyVisualIdentifierRange('S1', 'A3')).toBeNull()
    expect(expandPdfScholarlyVisualIdentifierRange('S1', 'S40')).toBeNull()
  })
})

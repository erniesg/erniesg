import { describe, expect, it } from 'vitest'
import { canonicalHeadingCrossReferenceTargets } from './epub-cross-reference-evidence'
import type { ResearchPaper } from './schema'

describe('EPUB cross-reference evidence', () => {
  it('derives canonical section and appendix targets from publication headings', () => {
    const paper = {
      nodes: [
        {
          id: 'section-2-1',
          type: 'heading',
          level: 2,
          text: '2.1 Methods',
          source: 'authored',
        },
        {
          id: 'appendix-j',
          type: 'heading',
          level: 1,
          text: 'Appendix J Supplementary methods',
          source: 'authored',
        },
        {
          id: 'appendix-j-7',
          type: 'heading',
          level: 2,
          text: 'J.7 Extended results',
          source: 'authored',
        },
      ],
    } as ResearchPaper

    expect(canonicalHeadingCrossReferenceTargets(paper)).toEqual([
      {
        kind: 'section',
        label: 'Section 2.1',
        nodeId: 'section-2-1',
        evidence: ['canonical-heading-label', 'source-heading-typography'],
      },
      {
        kind: 'appendix',
        label: 'Appendix J',
        nodeId: 'appendix-j',
        evidence: ['canonical-heading-label', 'source-heading-typography'],
      },
      {
        kind: 'appendix',
        label: 'Appendix J.7',
        nodeId: 'appendix-j-7',
        evidence: ['canonical-heading-label', 'source-heading-typography'],
      },
      {
        kind: 'section',
        label: 'Section J.7',
        nodeId: 'appendix-j-7',
        evidence: [
          'canonical-appendix-subheading-label',
          'source-heading-typography',
        ],
      },
    ])
  })
})

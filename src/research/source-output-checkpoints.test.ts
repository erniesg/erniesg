import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import { readFileSync } from 'node:fs'
import associationCheckpoints from '../../tests/fixtures/pdf/note-citation-associations.json'
import {
  evaluateSourceOutputCheckpoint,
  parseSourceOutputCheckpointSet,
  validateSourceOutputCheckpointSet,
} from './source-output-checkpoints'

const base = {
  id: 'figure-on-page-2',
  document: 'fixture.pdf',
  page: 2,
  profile: 'paperPro' as const,
  property: 'figure-present' as const,
  criterion: 'The source figure is present in the generated rendition.',
  source: { feature: 'visual' as const },
  output: { feature: 'figure' as const },
}

describe('source/output checkpoints', () => {
  it('loads the note and citation association checkpoint set', () => {
    const parsed = parseSourceOutputCheckpointSet({
      schemaVersion: associationCheckpoints.schemaVersion,
      checkpoints: associationCheckpoints.checkpoints,
    })
    expect(parsed.checkpoints.map((checkpoint) => checkpoint.property)).toEqual(
      [
        'marker-to-body',
        'citation-to-entry',
        'in-float-marker',
        'in-float-marker',
        'dangling-link-verifier',
      ],
    )
    expect(
      parsed.checkpoints.every(
        (checkpoint) =>
          checkpoint.document === 'note-citation-associations.pdf',
      ),
    ).toBe(true)
  })

  it('keeps the published JSON schema aligned with association checkpoints', () => {
    const schema = JSON.parse(
      readFileSync(
        'docs/schemas/source-output-checkpoints.schema.json',
        'utf8',
      ),
    )
    const validate = new Ajv2020({ strict: false }).compile(schema)

    expect(
      validate({
        schemaVersion: associationCheckpoints.schemaVersion,
        checkpoints: associationCheckpoints.checkpoints,
      }),
      JSON.stringify(validate.errors),
    ).toBe(true)
  })

  it('requires named checkpoints and rejects duplicate ids', () => {
    const invalid = validateSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [base, base],
    })
    expect(invalid).toEqual([expect.objectContaining({ code: 'duplicate-id' })])
    expect(() =>
      parseSourceOutputCheckpointSet({
        schemaVersion: '1.0.0',
        checkpoints: [{ ...base, id: '' }],
      }),
    ).toThrow(/invalid-checkpoint/)
  })

  it('binds the property to the structure a reviewer must inspect', () => {
    expect(
      validateSourceOutputCheckpointSet({
        schemaVersion: '1.0.0',
        checkpoints: [
          {
            ...base,
            property: 'code-block-structure',
            source: { feature: 'structure' },
          },
        ],
      }),
    ).toEqual([expect.objectContaining({ code: 'property-feature-mismatch' })])
  })

  it('binds structural claims to structural source evidence', () => {
    expect(
      validateSourceOutputCheckpointSet({
        schemaVersion: '1.0.0',
        checkpoints: [
          {
            ...base,
            property: 'code-block-structure',
            output: { feature: 'code' },
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({ code: 'property-source-feature-mismatch' }),
    ])
  })

  it('fails when a pair has no source visual or output structure', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [base],
    }).checkpoints[0]
    const result = evaluateSourceOutputCheckpoint(checkpoint, {
      source: { page: 2, text: 'Figure 1', hasVisual: false },
      rendition: {
        profile: 'paperPro',
        width: 540,
        html: '<p>Figure 1</p>',
      },
    })
    expect(result).toMatchObject({
      checkpointId: 'figure-on-page-2',
      status: 'failed',
    })
  })

  it('fails when the rendition is captured at a width other than the profile', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [base],
    }).checkpoints[0]
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source: { page: 2, text: 'Figure 1', hasVisual: true },
        rendition: {
          profile: 'paperPro',
          width: 390,
          html: '<figure><figcaption>Figure 1</figcaption></figure>',
        },
      }),
    ).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('width'),
    })
  })

  it('passes only when the named reviewer-visible property holds', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [base],
    }).checkpoints[0]
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source: { page: 2, text: 'Figure 1', hasVisual: true },
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<figure><img alt="Figure 1" /><figcaption>Figure 1</figcaption></figure>',
        },
      }),
    ).toEqual({ checkpointId: 'figure-on-page-2', status: 'passed' })
  })

  it('checks optional output text instead of accepting any matching tag', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [
        {
          ...base,
          output: { feature: 'figure', text: 'Expected figure' },
        },
      ],
    }).checkpoints[0]
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source: { page: 2, text: 'Figure 1', hasVisual: true },
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<figure><img alt="Other figure" /><figcaption>Other figure</figcaption></figure>',
        },
      }),
    ).toMatchObject({ status: 'failed' })
  })

  it('rejects a caption that absorbs following prose', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [
        {
          ...base,
          id: 'caption-boundary',
          property: 'caption-boundary',
          output: { feature: 'caption', text: 'Figure 1. Source flowchart' },
        },
      ],
    }).checkpoints[0]
    const observation = {
      source: { page: 2, text: 'Figure 1', hasVisual: true },
      rendition: {
        profile: 'paperPro' as const,
        width: 540,
        html: '<figure><img /><figcaption>Figure 1. Source flowchart. The next paragraph was swallowed.</figcaption></figure>',
      },
    }
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, observation),
    ).toMatchObject({
      checkpointId: 'caption-boundary',
      status: 'failed',
    })
  })

  it('rejects a caption that survives without its figure', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [
        {
          ...base,
          id: 'caption-without-figure',
          property: 'caption-boundary',
          output: { feature: 'caption', text: 'Figure 1. Source flowchart' },
        },
      ],
    }).checkpoints[0]
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source: { page: 2, text: 'Figure 1', hasVisual: true },
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<figure><figcaption>Figure 1. Source flowchart</figcaption></figure>',
        },
      }),
    ).toMatchObject({
      checkpointId: 'caption-without-figure',
      status: 'failed',
    })
  })

  it('rejects prose split across separate paragraph blocks', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [
        {
          ...base,
          id: 'prose-continuity',
          property: 'prose-continuity',
          source: { feature: 'text' },
          output: {
            feature: 'prose',
            text: 'The result sentence continues across a column break.',
            semanticFlow: {
              topology: 'same-page-column',
              fromPage: 2,
              outcome: 'space',
            },
          },
        },
      ],
    }).checkpoints[0]
    const observation = {
      source: {
        page: 2,
        text: 'The result sentence continues across a column break.',
        hasVisual: false,
      },
      rendition: {
        profile: 'paperPro' as const,
        width: 540,
        html: '<p>The result sentence continues</p><p>across a column break.</p>',
      },
    }
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, observation),
    ).toMatchObject({
      checkpointId: 'prose-continuity',
      status: 'failed',
    })
  })

  it('rejects a page-break sentence left split across two paragraphs', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [
        {
          ...base,
          id: 'page-break-continuity',
          property: 'prose-continuity',
          source: { feature: 'text', text: 'continues at the top' },
          output: {
            feature: 'prose',
            text: 'runs off the bottom of this page and continues at the top of the next one',
            semanticFlow: {
              topology: 'cross-page-column',
              fromPage: 1,
              outcome: 'space',
            },
          },
        },
      ],
    }).checkpoints[0]
    const source = {
      page: 2,
      text: 'continues at the top of the next one',
      hasVisual: false,
    }
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<p>runs off the bottom of this page and</p><p>continues at the top of the next one</p>',
        },
      }),
    ).toMatchObject({ checkpointId: 'page-break-continuity', status: 'failed' })
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<p>runs off the bottom of this page and continues at the top of the next one without losing its clause.</p>',
        },
      }),
    ).toMatchObject({
      checkpointId: 'page-break-continuity',
      status: 'failed',
      reason: expect.stringContaining('semantic-flow boundary ledger'),
    })
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<p>runs off the bottom of this page and continues at the top of the next one without losing its clause.</p>',
          semanticFlowBoundaryLedgerValid: true,
          semanticFlowBoundaryDecisions: [
            {
              page: 1,
              topology: 'cross-page-column',
              outcome: 'space',
            },
          ],
        },
      }),
    ).toMatchObject({ checkpointId: 'page-break-continuity', status: 'passed' })
  })

  it('rejects a rendition that still carries the printed line-end hyphen', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [
        {
          ...base,
          id: 'hyphen-resolution',
          property: 'hyphen-resolution',
          source: { feature: 'text', text: 'photo-' },
          output: {
            feature: 'prose',
            text: 'photograph is attested elsewhere as photograph.',
          },
        },
      ],
    }).checkpoints[0]
    const source = {
      page: 2,
      text: 'The high-resolution photo- graph is attested elsewhere as photograph.',
      hasVisual: false,
    }
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<p>photo- graph is attested elsewhere as photograph. photograph is attested elsewhere as photograph.</p>',
        },
      }),
    ).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('hyphen fragment'),
    })
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<p>The high-resolution photograph is attested elsewhere as photograph.</p>',
        },
      }),
    ).toMatchObject({ checkpointId: 'hyphen-resolution', status: 'passed' })
  })

  it('rejects markup-shaped source text promoted to structure', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [
        {
          ...base,
          id: 'markup-non-promotion',
          property: 'markup-non-promotion',
          source: { feature: 'text', text: '## Not a heading' },
          output: {
            feature: 'prose',
            text: '## Not a heading and **not bold** and {placeholder} stay literal.',
          },
        },
      ],
    }).checkpoints[0]
    const source = {
      page: 2,
      text: '## Not a heading and **not bold** and {placeholder} stay literal.',
      hasVisual: false,
    }
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<p>## Not a heading and **not bold** and {placeholder} stay literal.</p><h2>## Not a heading and **not bold** and {placeholder} stay literal.</h2>',
        },
      }),
    ).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('<h2>'),
    })
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<p>## Not a heading and **not bold** and {placeholder} stay literal.</p>',
        },
      }),
    ).toMatchObject({ checkpointId: 'markup-non-promotion', status: 'passed' })
  })

  it('rejects pseudocode flattened into running prose', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [
        {
          ...base,
          id: 'code-block-structure',
          property: 'code-block-structure',
          source: { feature: 'structure', text: 'Pseudocode' },
          output: { feature: 'code' },
        },
      ],
    }).checkpoints[0]
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source: { page: 2, text: 'Pseudocode', hasVisual: false },
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<p>for each source line: compare source and rendition</p>',
        },
      }),
    ).toMatchObject({ checkpointId: 'code-block-structure', status: 'failed' })
  })

  it('fails closed when the furniture contamination counter is absent or nonzero', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [
        {
          ...base,
          id: 'furniture-exclusion',
          property: 'furniture-exclusion',
          source: {
            feature: 'structure',
            furnitureContaminationCount: 0,
          },
          output: {
            feature: 'prose',
            text: 'Canonical body remains readable.',
          },
        },
      ],
    }).checkpoints[0]
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source: {
          page: 2,
          text: 'Canonical body remains readable.',
          hasVisual: false,
        },
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<p>Canonical body remains readable.</p>',
        },
      }),
    ).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('counter'),
    })
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source: {
          page: 2,
          text: 'Canonical body remains readable.',
          hasVisual: false,
          furnitureContaminationCount: 1,
        },
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<p>Canonical body remains readable.</p>',
        },
      }),
    ).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('expected 0'),
    })
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source: {
          page: 2,
          text: 'Canonical body remains readable.',
          hasVisual: false,
          furnitureContaminationCount: 0,
        },
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<p>Canonical body remains readable.</p>',
        },
      }),
    ).toEqual({ checkpointId: 'furniture-exclusion', status: 'passed' })
  })

  it('requires typed expectations for relationship checkpoints', () => {
    expect(
      validateSourceOutputCheckpointSet({
        schemaVersion: '1.0.0',
        checkpoints: [
          {
            ...base,
            property: 'marker-to-body',
            source: { feature: 'structure' },
            output: { feature: 'relationship' },
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({ code: 'missing-relationship-expectation' }),
    ])
    expect(
      validateSourceOutputCheckpointSet({
        schemaVersion: '1.0.0',
        checkpoints: [
          {
            ...base,
            property: 'citation-to-entry',
            source: { feature: 'structure' },
            output: {
              feature: 'relationship',
              relationship: {
                kind: 'note',
                markerText: '[2]',
                targetText: 'Caption association evidence.',
              },
            },
          },
        ],
      }),
    ).toEqual([expect.objectContaining({ code: 'relationship-kind-mismatch' })])
    expect(
      validateSourceOutputCheckpointSet({
        schemaVersion: '1.0.0',
        checkpoints: [
          {
            ...base,
            property: 'in-float-marker',
            source: { feature: 'structure' },
            output: {
              feature: 'relationship',
              relationship: {
                kind: 'citation',
                markerText: '[2]',
                targetText: 'Caption association evidence.',
              },
            },
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({ code: 'missing-relationship-container' }),
    ])
  })

  it('passes marker-to-body only with a unique semantic target and backlink', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [
        {
          ...base,
          id: 'marker-to-body',
          property: 'marker-to-body',
          source: {
            feature: 'structure',
            text: 'A numeric claim carries footnote marker',
          },
          output: {
            feature: 'relationship',
            relationship: {
              kind: 'note',
              markerText: '1',
              targetText: 'Numeric footnote body.',
            },
          },
        },
      ],
    }).checkpoints[0]
    const source = {
      page: 2,
      text: 'A numeric claim carries footnote marker 1.',
      hasVisual: false,
    }
    const validHtml =
      '<p>A numeric claim <a id="noteref-1" href="#note-1" epub:type="noteref" role="doc-noteref"><sup>1</sup></a></p>' +
      '<aside id="note-1" epub:type="footnote" role="doc-footnote">Numeric footnote body. <a href="#noteref-1" class="note-backlink">↩</a></aside>'
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: validHtml,
        },
      }),
    ).toEqual({ checkpointId: 'marker-to-body', status: 'passed' })
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<p>A numeric claim <a id="noteref-1" href="notes.xhtml#note-1" epub:type="noteref" role="doc-noteref"><sup>1</sup></a></p>',
          packagedDocuments: {
            'notes.xhtml':
              '<aside id="note-1" epub:type="footnote" role="doc-footnote">Numeric footnote body. <a href="content.xhtml#noteref-1" class="note-backlink">↩</a></aside>',
          },
        },
      }),
    ).toEqual({ checkpointId: 'marker-to-body', status: 'passed' })
    const repeatedMarkerHtml =
      '<p>An earlier claim <a id="noteref-other-1" href="#note-other-1" epub:type="noteref" role="doc-noteref"><sup>1</sup></a></p>' +
      '<aside id="note-other-1" epub:type="footnote" role="doc-footnote">A different note body. <a href="#noteref-other-1" class="note-backlink">↩</a></aside>' +
      validHtml
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: repeatedMarkerHtml,
        },
      }),
    ).toEqual({ checkpointId: 'marker-to-body', status: 'passed' })
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: validHtml.replace(
            '<a href="#noteref-1" class="note-backlink">↩</a>',
            '',
          ),
        },
      }),
    ).toMatchObject({
      checkpointId: 'marker-to-body',
      status: 'failed',
      reason: expect.stringContaining('backlink'),
    })
  })

  it('passes citation-to-entry only when the visible citation targets the named entry', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [
        {
          ...base,
          id: 'citation-to-entry',
          property: 'citation-to-entry',
          source: {
            feature: 'structure',
            text: 'Example et al. (2024)',
          },
          output: {
            feature: 'relationship',
            relationship: {
              kind: 'citation',
              markerText: 'Example et al. (2024)',
              targetText: 'Repository-owned author-year evidence.',
            },
          },
        },
      ],
    }).checkpoints[0]
    const source = {
      page: 2,
      text: 'Example et al. (2024) confirms the author-year claim.',
      hasVisual: false,
    }
    const citation =
      '<p><a id="citation-2024" href="#reference-2024" epub:type="biblioref" role="doc-biblioref">Example et al. (2024)</a></p>'
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html:
            citation +
            '<ol data-numbering-id="references"><li id="reference-2024">Example, A. (2024). Repository-owned author-year evidence.</li></ol>',
        },
      }),
    ).toEqual({ checkpointId: 'citation-to-entry', status: 'passed' })
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: citation.replace(
            '#reference-2024',
            'references.xhtml#reference-2024',
          ),
          packagedDocuments: {
            'references.xhtml':
              '<ol data-numbering-id="references"><li id="reference-2024">Example, A. (2024). Repository-owned author-year evidence.</li></ol>',
          },
        },
      }),
    ).toEqual({ checkpointId: 'citation-to-entry', status: 'passed' })
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html:
            citation +
            '<ol data-numbering-id="references"><li id="reference-2024">A different but valid bibliography entry.</li></ol>',
        },
      }),
    ).toMatchObject({
      checkpointId: 'citation-to-entry',
      status: 'failed',
      reason: expect.stringContaining('expected body text'),
    })
  })

  it('passes in-float-marker only when the verified link is inside the named float container', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [
        {
          ...base,
          id: 'in-float-marker',
          property: 'in-float-marker',
          source: {
            feature: 'structure',
            text: 'Caption citation [2]',
          },
          output: {
            feature: 'relationship',
            relationship: {
              kind: 'citation',
              markerText: '[2]',
              targetText: 'Caption association evidence.',
              container: 'caption',
            },
          },
        },
      ],
    }).checkpoints[0]
    const source = {
      page: 2,
      text: 'Figure 1. Caption citation [2] remains associated.',
      hasVisual: true,
    }
    const link =
      '<a id="caption-citation" href="#reference-2" epub:type="biblioref" role="doc-biblioref">[2]</a>'
    const target =
      '<ol data-numbering-id="references"><li id="reference-2">B. Fixture. Caption association evidence.</li></ol>'
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: `<figure><img /><figcaption>Caption citation ${link}</figcaption></figure>${target}`,
        },
      }),
    ).toEqual({ checkpointId: 'in-float-marker', status: 'passed' })
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: `<p>Caption citation ${link}</p>${target}`,
        },
      }),
    ).toMatchObject({
      checkpointId: 'in-float-marker',
      status: 'failed',
      reason: expect.stringContaining('caption container'),
    })
  })

  it('supports verified note markers inside table cells', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [
        {
          ...base,
          id: 'in-table-cell-marker',
          property: 'in-float-marker',
          source: {
            feature: 'structure',
            text: 'A note marker inside a table cell',
          },
          output: {
            feature: 'relationship',
            relationship: {
              kind: 'note',
              markerText: '4',
              targetText: 'Table cell note body.',
              container: 'table-cell',
            },
          },
        },
      ],
    }).checkpoints[0]
    const source = {
      page: 2,
      text: 'A note marker inside a table cell remains associated.',
      hasVisual: false,
    }
    const marker =
      '<a id="cell-noteref-4" href="#note-4" epub:type="noteref" role="doc-noteref"><sup>4</sup></a>'
    const note =
      '<aside id="note-4" epub:type="footnote" role="doc-footnote">Table cell note body. <a href="#cell-noteref-4" class="note-backlink">↩</a></aside>'
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: `<table><tr><td>Note ${marker}</td></tr></table>${note}`,
        },
      }),
    ).toEqual({ checkpointId: 'in-table-cell-marker', status: 'passed' })
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: `<p>Note ${marker}</p>${note}`,
        },
      }),
    ).toMatchObject({
      checkpointId: 'in-table-cell-marker',
      status: 'failed',
      reason: expect.stringContaining('table-cell container'),
    })
  })

  it('passes the dangling-link verifier only when every internal href has one target', () => {
    const checkpoint = parseSourceOutputCheckpointSet({
      schemaVersion: '1.0.0',
      checkpoints: [
        {
          ...base,
          id: 'dangling-link-verifier',
          property: 'dangling-link-verifier',
          source: {
            feature: 'structure',
            text: 'Prior evidence',
          },
          output: { feature: 'internal-links' },
        },
      ],
    }).checkpoints[0]
    const source = {
      page: 2,
      text: 'Prior evidence remains linked.',
      hasVisual: false,
    }
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<p id="claim"><a href="#entry">Prior evidence</a></p><p id="entry"><a href="#claim">Entry and backlink</a></p>',
        },
      }),
    ).toEqual({ checkpointId: 'dangling-link-verifier', status: 'passed' })
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<p><a href="#missing-entry">Prior evidence</a></p>',
        },
      }),
    ).toMatchObject({
      checkpointId: 'dangling-link-verifier',
      status: 'failed',
      reason: expect.stringContaining('has no target'),
    })
    expect(
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: {
          profile: 'paperPro',
          width: 540,
          html: '<p><a href="#entry">Prior evidence</a></p><p id="entry">First</p><p id="entry">Duplicate</p>',
        },
      }),
    ).toMatchObject({
      checkpointId: 'dangling-link-verifier',
      status: 'failed',
      reason: expect.stringContaining('exactly one'),
    })
    const evaluateRelative = (
      html: string,
      packagedDocuments?: Readonly<Record<string, string>>,
    ) =>
      evaluateSourceOutputCheckpoint(checkpoint, {
        source,
        rendition: { profile: 'paperPro', width: 540, html, packagedDocuments },
      })
    expect(
      evaluateRelative(
        '<p id="claim"><a href="content.xhtml#entry">Prior evidence</a></p><p id="entry"><a href="content.xhtml#claim">Entry and backlink</a></p>',
      ),
    ).toEqual({ checkpointId: 'dangling-link-verifier', status: 'passed' })
    expect(
      evaluateRelative(
        '<p><a href="supplement.xhtml#entry">Prior evidence</a></p>',
        {
          'supplement.xhtml': '<section id="entry">Supplement</section>',
        },
      ),
    ).toEqual({ checkpointId: 'dangling-link-verifier', status: 'passed' })
    expect(
      evaluateRelative(
        '<p><a href="supplement.xhtml#missing">Prior evidence</a></p>',
        {
          'supplement.xhtml': '<section id="entry">Supplement</section>',
        },
      ),
    ).toMatchObject({
      checkpointId: 'dangling-link-verifier',
      status: 'failed',
      reason: expect.stringContaining('has no target'),
    })
    expect(
      evaluateRelative(
        '<p id="claim"><a href="chapters/supplement.xhtml#entry">Prior evidence</a></p>',
        {
          'chapters/supplement.xhtml':
            '<section id="entry">Supplement <a href="../content.xhtml#claim">Return to claim</a></section>',
        },
      ),
    ).toEqual({ checkpointId: 'dangling-link-verifier', status: 'passed' })
    expect(
      evaluateRelative(
        '<p><a href="chapters/supplement.xhtml#entry">Prior evidence</a></p>',
        {
          'chapters/supplement.xhtml':
            '<section id="entry">Supplement <a href="#missing">Missing detail</a></section>',
        },
      ),
    ).toMatchObject({
      checkpointId: 'dangling-link-verifier',
      status: 'failed',
      reason: expect.stringContaining('has no target'),
    })
    for (const href of ['supplement.xhtml#missing', 'missing.xhtml']) {
      expect(
        evaluateRelative(
          `<p id="claim"><a href="#entry">Prior evidence</a><a href="${href}">Missing supplement</a></p><p id="entry">Entry</p>`,
        ),
      ).toMatchObject({
        checkpointId: 'dangling-link-verifier',
        status: 'failed',
        reason: expect.stringContaining('packaged document'),
      })
    }
    for (const [href, packagedDocument] of [
      ['supplement.xhtml/', 'supplement.xhtml'],
      ['chapters//supplement.xhtml', 'chapters/supplement.xhtml'],
    ]) {
      expect(
        evaluateRelative(`<p><a href="${href}">Broken alias</a></p>`, {
          [packagedDocument]: '<section>Different path</section>',
        }),
      ).toMatchObject({
        checkpointId: 'dangling-link-verifier',
        status: 'failed',
        reason: expect.stringContaining(`packaged document ${href}`),
      })
    }
  })
})

import { describe, expect, it } from 'vitest'
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
})

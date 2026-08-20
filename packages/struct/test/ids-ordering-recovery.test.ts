import { describe, expect, it } from 'vitest'
import { structDigest, structId } from '../src/ids'
import {
  orderBlocksByLayout,
  pageLayoutsFromBlocks,
} from '../src/reading-order'
import {
  diagnosticCategory,
  hasActionableRecovery,
  recoverySummary,
  toStructDiagnostic,
} from '../src/recovery'
import { characterizationDocument } from './characterization-fixtures'

describe('STRUCT package IDs, ordering, and recovery contract', () => {
  it('keeps IDs and canonical digests deterministic', () => {
    expect(structId('block', 'same value')).toBe(
      'struct-block-f5af871622ebeeba8dd1cea0',
    )
    expect(structDigest({ b: 2, a: 1 })).toBe(structDigest({ a: 1, b: 2 }))
    expect(structDigest({ a: 1 })).not.toBe(structDigest({ a: 2 }))
  })

  it('orders blocks by page, column, and geometry without interleaving columns', () => {
    const fixture = characterizationDocument('0.2.0')
    const blocks = [
      {
        ...fixture.blocks[0]!,
        id: 'right-lower',
        order: 2,
        column: 'right' as const,
        evidence: {
          ...fixture.blocks[0]!.evidence,
          boxes: [{ page: 1, x: 0, y: 20, width: 1, height: 1, rotation: 0 }],
        },
      },
      {
        ...fixture.blocks[0]!,
        id: 'left-upper',
        order: 1,
        column: 'left' as const,
        evidence: {
          ...fixture.blocks[0]!.evidence,
          boxes: [{ page: 1, x: 0, y: 40, width: 1, height: 1, rotation: 0 }],
        },
      },
      {
        ...fixture.blocks[0]!,
        id: 'span-middle',
        order: 0,
        column: 'span' as const,
        evidence: {
          ...fixture.blocks[0]!.evidence,
          boxes: [{ page: 1, x: 0, y: 1, width: 1, height: 1, rotation: 0 }],
        },
      },
    ]

    expect(orderBlocksByLayout(blocks).map((block) => block.id)).toEqual([
      'span-middle',
      'left-upper',
      'right-lower',
    ])
    expect(
      pageLayoutsFromBlocks(
        [{ page: 1, width: 600, height: 800, rotation: 0 }],
        blocks,
      )[0],
    ).toMatchObject({
      blocks: ['span-middle', 'left-upper', 'right-lower'],
      columns: [
        { side: 'span', blockIds: ['span-middle'] },
        { side: 'left', blockIds: ['left-upper'] },
        { side: 'right', blockIds: ['right-lower'] },
      ],
    })
  })

  it('maps diagnostics to safe recovery copy and actionable summaries', () => {
    expect(diagnosticCategory('OCR_REQUIRED')).toBe('text')
    const diagnostic = toStructDiagnostic({
      code: 'AMBIGUOUS_READING_ORDER',
      severity: 'warning',
      message: 'source message is not copied into public recovery text',
      page: 2,
    })
    expect(diagnostic).toMatchObject({
      category: 'layout',
      pages: [2],
    })
    expect(diagnostic.message).not.toContain('source message')

    const recovery = recoverySummary({
      ready: false,
      diagnostics: [
        {
          code: 'AMBIGUOUS_READING_ORDER',
          severity: 'warning',
          message: 'uncertain',
          pages: [2],
        },
      ],
    })
    expect(recovery.status).toBe('review-required')
    expect(hasActionableRecovery(recovery)).toBe(true)
    expect(recovery.userAction).toContain('page 2')
  })
})

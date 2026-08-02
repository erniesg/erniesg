import { describe, expect, it } from 'vitest'
import { recoveryDiagnosticInputs } from './recovery-projection'

describe('reader recovery projection evidence', () => {
  it('marks an unresolved visual automatic only when its relationship packages an asset', () => {
    const diagnostic = {
      code: 'UNRESOLVED_VISUAL_OBJECT' as const,
      severity: 'error' as const,
      message: 'visual unresolved',
      page: 2,
      relationshipId: 'figure-1',
    }

    expect(
      recoveryDiagnosticInputs({
        diagnostics: [diagnostic],
        visualRelationships: [
          {
            id: 'figure-1',
            assetIds: ['asset-1'],
            canonicalNodeId: 'figure-node-1',
          },
        ],
        assets: [{ id: 'asset-1', bytes: new Uint8Array([1]) }],
      })[0].automaticRecovery,
    ).toBe(true)

    expect(
      recoveryDiagnosticInputs({
        diagnostics: [diagnostic],
        visualRelationships: [{ id: 'figure-1', assetIds: [] }],
        assets: [],
      })[0].automaticRecovery,
    ).toBe(false)
  })

  it('requires canonical render ownership and keeps every affected page', () => {
    const [diagnostic] = recoveryDiagnosticInputs({
      diagnostics: [
        {
          code: 'UNRESOLVED_VISUAL_OBJECT',
          severity: 'error',
          message: 'candidate asset was not rendered',
          relationshipId: 'figure-1',
          sourceBoxes: [{ page: 5 }, { page: 3 }, { page: 5 }],
        },
      ],
      visualRelationships: [
        { id: 'figure-1', assetIds: ['asset-1'], canonicalNodeId: null },
      ],
      assets: [{ id: 'asset-1', bytes: new Uint8Array([1]) }],
    })

    expect(diagnostic.automaticRecovery).toBe(false)
    expect(diagnostic.pages).toEqual([3, 5])
  })

  it('keeps proven visible unresolved links automatic but fails closed for unknown codes', () => {
    expect(
      recoveryDiagnosticInputs({
        diagnostics: [
          {
            code: 'UNRESOLVED_HYPERLINK',
            severity: 'error',
            message: 'visible text retained',
          },
          {
            code: 'FUTURE_BLOCKER',
            severity: 'error',
            message: 'unknown',
          },
        ],
      }).map((diagnostic) => diagnostic.automaticRecovery),
    ).toEqual([true, false])
  })
})

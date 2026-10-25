import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { StructRecovery } from '@erniesg/struct/document'
import { hasActionableRecovery as packageHasActionableRecovery } from '@erniesg/struct/recovery'
import {
  hasActionableRecovery,
  recoverySummary,
} from '../src/struct-adapters/recovery'

/**
 * `@erniesg/struct/recovery` owns the actionable-recovery predicate. The app
 * keeps a facade so its callers do not change, but the facade must not carry a
 * second rule that could silently outrank the package at runtime.
 */

const KNOWN_CODE = 'OCR_REQUIRED'
const UNKNOWN_CODE = 'APP_TEST_UNKNOWN_RECOVERY_CODE'

function minimalRecovery(
  overrides: Partial<StructRecovery> = {},
): StructRecovery {
  return {
    status: 'review-required',
    title: 'Recovery status: review required',
    summary: '1 unresolved recovery issue.',
    issues: [],
    ...overrides,
  }
}

type RecoveryCase = {
  label: string
  recovery: StructRecovery | undefined
  expected: boolean
}

const RECOVERY_CASES: RecoveryCase[] = [
  {
    label: 'no recovery at all',
    recovery: undefined,
    expected: false,
  },
  {
    label: 'a null recovery',
    recovery: null as unknown as StructRecovery,
    expected: false,
  },
  {
    label: 'a recovery without a user action',
    recovery: minimalRecovery(),
    expected: false,
  },
  {
    label: 'a recovery with an empty user action',
    recovery: minimalRecovery({ userAction: '' }),
    expected: false,
  },
  {
    label: 'a recovery with a whitespace-only user action',
    recovery: minimalRecovery({ userAction: '   ' }),
    expected: true,
  },
  {
    label: 'a recovery with a user action',
    recovery: minimalRecovery({
      userAction: 'Open the preview and check page 5.',
    }),
    expected: true,
  },
  {
    label: 'a ready recovery that still carries a user action',
    recovery: minimalRecovery({
      status: 'ready',
      userAction: 'Open the preview and check page 5.',
    }),
    expected: true,
  },
  {
    label: 'a ready recovery without a user action',
    recovery: minimalRecovery({ status: 'ready' }),
    expected: false,
  },
]

const adapterSource = readFileSync(
  new URL('../src/struct-adapters/recovery.ts', import.meta.url),
  'utf8',
)

describe('Struct actionable recovery authority', () => {
  it('returns the package result for representative recoveries', () => {
    for (const testCase of RECOVERY_CASES) {
      expect(
        hasActionableRecovery(testCase.recovery),
        `app predicate for ${testCase.label}`,
      ).toBe(testCase.expected)
      expect(
        packageHasActionableRecovery(testCase.recovery),
        `package predicate for ${testCase.label}`,
      ).toBe(testCase.expected)
      expect(
        hasActionableRecovery(testCase.recovery),
        `app predicate for ${testCase.label} against the package`,
      ).toBe(packageHasActionableRecovery(testCase.recovery))
    }
  })

  it('returns the package result for known and unknown recovery codes', () => {
    for (const code of [KNOWN_CODE, UNKNOWN_CODE]) {
      const summary = recoverySummary({
        ready: false,
        blockingCodes: [code],
        textCoverage: 1,
        assetCoverage: 1,
        relationshipCoverage: 1,
        diagnostics: [
          { code, severity: 'error', message: 'internal message', page: 5 },
        ],
      })
      expect(summary.userAction).toBeTruthy()
      expect(hasActionableRecovery(summary), `app predicate for ${code}`).toBe(
        packageHasActionableRecovery(summary),
      )
      expect(hasActionableRecovery(summary), `app predicate for ${code}`).toBe(
        true,
      )
    }

    const readySummary = recoverySummary({
      ready: true,
      textCoverage: 1,
      assetCoverage: 1,
      relationshipCoverage: 1,
      diagnostics: [],
    })
    expect(readySummary.userAction).toBeUndefined()
    expect(hasActionableRecovery(readySummary)).toBe(
      packageHasActionableRecovery(readySummary),
    )
    expect(hasActionableRecovery(readySummary)).toBe(false)
  })

  it('takes a changed package predicate at runtime instead of an app rule', async () => {
    vi.resetModules()
    vi.doMock('@erniesg/struct/recovery', async () => {
      const real = await vi.importActual<
        typeof import('@erniesg/struct/recovery')
      >('@erniesg/struct/recovery')
      return {
        ...real,
        // Presence instead of truthiness: the empty user action becomes
        // actionable, so an app-local truthiness rule cannot match this.
        hasActionableRecovery: (
          recovery: { userAction?: string } | undefined,
        ) => recovery?.userAction !== undefined,
      }
    })
    try {
      const mutated = await import('../src/struct-adapters/recovery')

      expect(
        mutated.hasActionableRecovery(minimalRecovery({ userAction: '' })),
      ).toBe(true)
      expect(
        mutated.hasActionableRecovery(
          minimalRecovery({ userAction: 'Open the preview and check page 5.' }),
        ),
      ).toBe(true)
      expect(mutated.hasActionableRecovery(undefined)).toBe(false)
      expect(mutated.hasActionableRecovery(minimalRecovery())).toBe(false)
    } finally {
      vi.doUnmock('@erniesg/struct/recovery')
      vi.resetModules()
    }
  })

  it('follows a package predicate that keys off the recovery status', async () => {
    vi.resetModules()
    vi.doMock('@erniesg/struct/recovery', async () => {
      const real = await vi.importActual<
        typeof import('@erniesg/struct/recovery')
      >('@erniesg/struct/recovery')
      return {
        ...real,
        hasActionableRecovery: (recovery: { status?: string } | undefined) =>
          recovery?.status === 'review-required',
      }
    })
    try {
      const mutated = await import('../src/struct-adapters/recovery')

      expect(
        mutated.hasActionableRecovery(
          minimalRecovery({ status: 'ready', userAction: 'Read this.' }),
        ),
      ).toBe(false)
      expect(
        mutated.hasActionableRecovery(
          minimalRecovery({
            status: 'review-required',
            userAction: 'Open the preview and check page 5.',
          }),
        ),
      ).toBe(true)
    } finally {
      vi.doUnmock('@erniesg/struct/recovery')
      vi.resetModules()
    }
  })

  it('keeps no actionable-recovery rule in the app adapter', () => {
    const start = adapterSource.indexOf(
      'export function hasActionableRecovery(',
    )
    expect(start).toBeGreaterThan(-1)
    const body = adapterSource.slice(start)
    expect(body).toContain('packageHasActionableRecovery(recovery)')
    expect(body).not.toMatch(/Boolean\(/)
    expect(adapterSource).toContain("from '@erniesg/struct/recovery'")
  })
})

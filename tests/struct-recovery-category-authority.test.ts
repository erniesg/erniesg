import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  diagnosticCategory as packageDiagnosticCategory,
  recoveryFact as packageRecoveryFact,
} from '@erniesg/struct/recovery'
import {
  diagnosticCategory,
  diagnosticCopy,
  hasActionableRecovery,
  recoverySummary,
  toStructDiagnostic,
} from '../src/struct-adapters/recovery'

/**
 * The package owns the recovery category table. The app keeps only the
 * explanatory copy, so these tests pin that the runtime category follows
 * `@erniesg/struct/recovery` while the rendered copy stays app-owned.
 */

const KNOWN_CODES = [
  'OCR_REQUIRED',
  'UNRESOLVED_VISUAL_OBJECT',
  'INCOMPLETE_SEMANTIC_TABLE_COVERAGE',
  'UNRESOLVED_HYPERLINK',
  'MISSING_SOURCE_REGION',
] as const

const UNKNOWN_CODES = [
  'APP_TEST_UNKNOWN_RECOVERY_CODE_A',
  'APP_TEST_UNKNOWN_RECOVERY_CODE_B',
] as const

/**
 * The categories the app rendered before the package became authoritative.
 * A package-side change must be a deliberate edit here, never a silent
 * rendering change.
 */
const RENDERED_CATEGORY_BASELINE: Record<(typeof KNOWN_CODES)[number], string> =
  {
    OCR_REQUIRED: 'text',
    UNRESOLVED_VISUAL_OBJECT: 'visuals',
    INCOMPLETE_SEMANTIC_TABLE_COVERAGE: 'tables',
    UNRESOLVED_HYPERLINK: 'links',
    MISSING_SOURCE_REGION: 'source',
  }

const adapterSource = readFileSync(
  new URL('../src/struct-adapters/recovery.ts', import.meta.url),
  'utf8',
)

describe('Struct recovery category authority', () => {
  it('reads the runtime category of known codes from the package', () => {
    for (const code of KNOWN_CODES) {
      const expected = packageDiagnosticCategory(code)
      expect(expected, `package category for ${code}`).toBe(
        RENDERED_CATEGORY_BASELINE[code],
      )
      expect(diagnosticCategory(code), `app category for ${code}`).toBe(
        expected,
      )
      expect(
        diagnosticCopy(code).category,
        `app copy category for ${code}`,
      ).toBe(expected)
      const diagnostic = toStructDiagnostic({
        code,
        severity: 'warning',
        message: 'internal message',
      })
      expect(diagnostic.category, `diagnostic category for ${code}`).toBe(
        expected,
      )
    }
  })

  it('keeps the app-owned title, message and action copy', () => {
    const copy = diagnosticCopy('UNRESOLVED_VISUAL_OBJECT')
    expect(copy.title).toBe(
      'A figure or diagram is missing from the readable export',
    )
    expect(copy.message).toBe(
      'No packaged source visual could be proven for this figure or diagram.',
    )
    expect(copy.action).toContain('Open the marked page')

    const diagnostic = toStructDiagnostic({
      code: 'UNRESOLVED_VISUAL_OBJECT',
      severity: 'error',
      message: 'internal message',
    })
    expect(diagnostic.title).toBe(copy.title)
    expect(diagnostic.message).toBe(copy.message)
    expect(diagnostic.action).toBe(copy.action)

    // The package derives its own generic title; the app must not fall back
    // to it, because the app copy is the only rendered recovery language.
    expect(packageRecoveryFact('UNRESOLVED_VISUAL_OBJECT', 'x').title).toBe(
      'Unresolved visual object',
    )
    expect(copy.title).not.toBe(
      packageRecoveryFact('UNRESOLVED_VISUAL_OBJECT', 'x').title,
    )
  })

  it('fails closed on the package default for unknown codes', () => {
    for (const code of UNKNOWN_CODES) {
      const expected = packageDiagnosticCategory(code)
      expect(diagnosticCategory(code), `app category for ${code}`).toBe(
        expected,
      )
      expect(
        diagnosticCopy(code).category,
        `app copy category for ${code}`,
      ).toBe(expected)
      const diagnostic = toStructDiagnostic({
        code,
        severity: 'error',
        message: 'internal message',
      })
      expect(diagnostic.category, `diagnostic category for ${code}`).toBe(
        expected,
      )
      expect(diagnostic.title).toBe(
        'The importer could not verify part of this file',
      )
    }

    const summary = recoverySummary({
      ready: false,
      blockingCodes: [UNKNOWN_CODES[0]],
      textCoverage: 1,
      assetCoverage: 1,
      relationshipCoverage: 1,
      diagnostics: [
        {
          code: UNKNOWN_CODES[0],
          severity: 'error',
          message: 'internal message',
          page: 5,
        },
      ],
    })
    expect(summary.issues).toEqual([
      expect.objectContaining({
        category: packageDiagnosticCategory(UNKNOWN_CODES[0]),
        pages: [5],
      }),
    ])
    expect(summary.userAction).toContain('page 5')
    expect(hasActionableRecovery(summary)).toBe(true)
  })

  it('reports the package default category when no diagnostic was emitted', () => {
    const summary = recoverySummary({
      ready: false,
      textCoverage: 0,
      assetCoverage: 0,
      relationshipCoverage: 0,
      diagnostics: [],
    })
    expect(summary.issues).toEqual([
      expect.objectContaining({
        category: packageDiagnosticCategory(UNKNOWN_CODES[1]),
        title: 'The importer could not verify part of this file',
      }),
    ])
    expect(hasActionableRecovery(summary)).toBe(true)
  })

  it('keeps no category authority in the app copy table', () => {
    const table = adapterSource.slice(
      adapterSource.indexOf('const DIAGNOSTIC_COPY'),
      adapterSource.indexOf('const FALLBACK_COPY'),
    )
    expect(table.length).toBeGreaterThan(0)
    expect(table).not.toMatch(/category:/)
    expect(adapterSource).toContain("from '@erniesg/struct/recovery'")
  })

  it('takes a changed package category at runtime instead of an app table', async () => {
    vi.resetModules()
    vi.doMock('@erniesg/struct/recovery', async () => {
      const real = await vi.importActual<
        typeof import('@erniesg/struct/recovery')
      >('@erniesg/struct/recovery')
      return {
        ...real,
        diagnosticCategory: (code: string) =>
          code === 'OCR_REQUIRED' ? 'tables' : real.diagnosticCategory(code),
      }
    })
    try {
      const mutated = await import('../src/struct-adapters/recovery')
      const real = await vi.importActual<
        typeof import('@erniesg/struct/recovery')
      >('@erniesg/struct/recovery')

      expect(mutated.diagnosticCategory('OCR_REQUIRED')).toBe('tables')
      expect(mutated.diagnosticCopy('OCR_REQUIRED').category).toBe('tables')
      expect(
        mutated.toStructDiagnostic({
          code: 'OCR_REQUIRED',
          severity: 'warning',
          message: 'internal message',
        }).category,
      ).toBe('tables')

      // The app copy is unaffected by the package category change.
      expect(mutated.diagnosticCopy('OCR_REQUIRED').title).toBe(
        'Some pages needed OCR',
      )
      // An unknown code still lands on the package default.
      expect(mutated.diagnosticCategory(UNKNOWN_CODES[0])).toBe(
        real.diagnosticCategory(UNKNOWN_CODES[0]),
      )
    } finally {
      vi.doUnmock('@erniesg/struct/recovery')
      vi.resetModules()
    }
  })
})

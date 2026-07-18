import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { safeAuditDiagnostic } from './pdf-corpus-audit-safety.mjs'

describe('local PDF corpus audit', () => {
  it('redacts document text from successful diagnostic messages', () => {
    const privateMarker = 'private reconstructed paragraph'

    expect(
      safeAuditDiagnostic({
        code: 'LOW_CONFIDENCE_BLOCK',
        severity: 'warning',
        page: 3,
        message: `p-001-${privateMarker} needs reading-order review.`,
      }),
    ).toEqual({
      code: 'LOW_CONFIDENCE_BLOCK',
      severity: 'warning',
      page: 3,
      message: 'A reconstructed block requires reading-order review.',
    })
    expect(
      JSON.stringify(
        safeAuditDiagnostic({
          code: 'FUTURE_DIAGNOSTIC',
          severity: 'warning',
          message: privateMarker,
        }),
      ),
    ).not.toContain(privateMarker)
  })

  it('reports only stable document identifiers and quality results', () => {
    const result = spawnSync(
      process.execPath,
      [
        'tools/pdf-corpus-audit.mjs',
        '--report-only',
        'tests/fixtures/pdf/born-digital.pdf',
        'tests/fixtures/pdf/structured-scientific.pdf',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    )

    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({
      schemaVersion: '1.0.0',
      privacy: 'basenames-hashes-metrics-diagnostics-only',
      summary: { documents: 2, ready: 1, reviewRequired: 1, failed: 0 },
    })
    expect(report.documents.map((document) => document.basename)).toEqual([
      'born-digital.pdf',
      'structured-scientific.pdf',
    ])
    expect(report.documents.every((document) => document.sha256)).toBe(true)
    expect(result.stdout).not.toContain(resolve('.'))
    expect(result.stdout).not.toContain(
      'Synthetic semantic completeness fixture',
    )
  })

  it('redacts parser failures and supplies PDF.js standard-font assets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-corpus-private-'))
    const path = join(directory, 'private-corrupt.pdf')
    const privateMarker = 'private parser payload must never enter the report'
    try {
      await writeFile(path, `%PDF-1.7\n${privateMarker}\n`)
      const result = spawnSync(
        process.execPath,
        ['tools/pdf-corpus-audit.mjs', '--report-only', path],
        { encoding: 'utf8', timeout: 120_000 },
      )

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        summary: { documents: 1, ready: 0, reviewRequired: 0, failed: 1 },
        documents: [
          {
            basename: 'private-corrupt.pdf',
            sha256: null,
            code: 'PDF_PARSE_FAILED',
            message:
              'The PDF parser could not open the document; local path and document details were suppressed.',
          },
        ],
      })
      expect(result.stdout).not.toContain(directory)
      expect(result.stdout).not.toContain(privateMarker)
      expect(result.stderr).not.toContain('standardFontDataUrl')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('writes opt-in private overlays outside the repository without widening the report', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-corpus-overlays-'))
    try {
      const result = spawnSync(
        process.execPath,
        [
          'tools/pdf-corpus-audit.mjs',
          '--report-only',
          '--overlay-output',
          directory,
          'tests/fixtures/pdf/diagnostic-overlays.pdf',
        ],
        { encoding: 'utf8', timeout: 120_000 },
      )

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        privacy: 'basenames-hashes-metrics-diagnostics-only',
        summary: { documents: 1, reviewRequired: 1 },
      })
      const artifacts = await readdir(directory)
      expect(artifacts).toEqual([
        expect.stringMatching(
          /^diagnostic-overlays-[a-f0-9]{16}\.diagnostics\.html$/,
        ),
      ])
      const html = await readFile(join(directory, artifacts[0]), 'utf8')
      expect(html).toContain('pdf-diagnostic-overlay__svg')
      expect(html).toContain('Candidate A · left column then right column')
      expect(result.stdout).not.toContain(directory)
      expect(result.stdout).not.toContain(
        'This deliberately wide source region',
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses corpus overlay output anywhere inside the repository', () => {
    const result = spawnSync(
      process.execPath,
      [
        'tools/pdf-corpus-audit.mjs',
        '--report-only',
        '--overlay-output',
        '.agent/evidence/private-corpus',
        'tests/fixtures/pdf/born-digital.pdf',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    )

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('outside the repository')
    expect(result.stderr).not.toContain(resolve('.'))
  })
})

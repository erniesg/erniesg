#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { createServer } from 'vite'

const args = process.argv.slice(2)
const reportOnly = args.includes('--report-only')
const inputs = args.filter((argument) => argument !== '--report-only')

async function pdfPaths(paths) {
  const found = []
  async function visit(path) {
    const details = await stat(path)
    if (details.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true })
      for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        if (entry.isSymbolicLink()) continue
        await visit(resolve(path, entry.name))
      }
      return
    }
    if (details.isFile() && extname(path).toLocaleLowerCase() === '.pdf') {
      found.push(path)
    }
  }
  for (const path of paths) await visit(resolve(path))
  return [...new Set(found)]
}

function safeError(error) {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : 'AUDIT_FAILED'
  const message =
    error instanceof Error && code !== 'AUDIT_FAILED'
      ? error.message
      : 'The PDF could not be audited; local path details were suppressed.'
  return { code, message }
}

async function main() {
  if (inputs.length === 0) {
    process.stderr.write(
      'Usage: npm run pdf:corpus-audit -- [--report-only] <pdf-or-directory> [...]\n',
    )
    process.exitCode = 2
    return
  }

  const vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  try {
    const [
      { reconstructPdf },
      { DEFAULT_PDF_COMPLETENESS_POLICY },
      { MAX_LOCAL_PDF_BYTES },
    ] = await Promise.all([
      vite.ssrLoadModule('/src/research/pdf.ts'),
      vite.ssrLoadModule('/src/research/pdf-quality.ts'),
      vite.ssrLoadModule('/src/research/import-types.ts'),
    ])
    const documents = []
    for (const path of await pdfPaths(inputs)) {
      const stableBasename = basename(path)
      try {
        const details = await stat(path)
        if (details.size > MAX_LOCAL_PDF_BYTES) {
          documents.push({
            basename: stableBasename,
            sha256: null,
            code: 'OVERSIZED_PDF',
            message: `PDF resource limit exceeded: received ${details.size} bytes; the bounded local limit is ${MAX_LOCAL_PDF_BYTES} bytes. No document bytes were read.`,
          })
          continue
        }
        const bytes = await readFile(path)
        const result = await reconstructPdf(
          new File([bytes], stableBasename, {
            type: 'application/pdf',
            lastModified: 0,
          }),
        )
        documents.push({
          basename: stableBasename,
          sha256: result.source.sha256,
          byteLength: result.source.byteLength,
          pageCount: result.source.pageCount,
          completeness: result.completeness,
          readiness: result.readiness,
          diagnostics: result.diagnostics.map(
            ({ code, severity, page, message }) => ({
              code,
              severity,
              ...(page === undefined ? {} : { page }),
              message,
            }),
          ),
        })
      } catch (error) {
        documents.push({
          basename: stableBasename,
          sha256: null,
          ...safeError(error),
        })
      }
    }
    documents.sort(
      (left, right) =>
        left.basename.localeCompare(right.basename) ||
        String(left.sha256).localeCompare(String(right.sha256)),
    )
    const summary = {
      documents: documents.length,
      ready: documents.filter((document) => document.readiness?.ready).length,
      reviewRequired: documents.filter(
        (document) => document.readiness && !document.readiness.ready,
      ).length,
      failed: documents.filter((document) => !document.readiness).length,
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: '1.0.0',
          reportSchema: 'docs/schemas/pdf-corpus-audit.schema.json',
          privacy: 'basenames-hashes-metrics-diagnostics-only',
          policy: DEFAULT_PDF_COMPLETENESS_POLICY,
          summary,
          documents,
        },
        null,
        2,
      )}\n`,
    )
    if (!reportOnly && (summary.reviewRequired > 0 || summary.failed > 0)) {
      process.exitCode = 1
    }
  } finally {
    await vite.close()
  }
}

main().catch(() => {
  process.stderr.write(
    'PDF corpus audit failed without publishing local path details.\n',
  )
  process.exitCode = 2
})

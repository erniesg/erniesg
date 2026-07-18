import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { createServer } from 'vite'
import { safeAuditDiagnostic } from './pdf-corpus-audit-safety.mjs'

export const PDF_CORPUS_REPORT_SCHEMA_VERSION = '1.1.0'

const SAFE_FAILURE_MESSAGES = Object.freeze({
  INVALID_PDF: 'The file is not a valid PDF.',
  ENCRYPTED_PDF: 'The PDF is password-protected and was not opened.',
  OVERSIZED_PDF: 'The PDF exceeds the bounded local resource limit.',
  OCR_REQUIRED: 'The PDF requires local OCR before it can be audited.',
  EMPTY_PDF: 'The PDF contains no pages.',
  PDF_PARSE_FAILED:
    'The PDF parser could not open the document; local path and document details were suppressed.',
  IMPORT_CANCELLED: 'The local PDF audit was cancelled.',
  INCOMPLETE_RECONSTRUCTION:
    'The PDF reconstruction did not pass the completeness gate.',
  AUDIT_FAILED:
    'The PDF could not be audited; local path and document details were suppressed.',
})

export async function pdfPaths(paths) {
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
  const candidate =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : 'AUDIT_FAILED'
  const code = Object.hasOwn(SAFE_FAILURE_MESSAGES, candidate)
    ? candidate
    : 'AUDIT_FAILED'
  return { code, message: SAFE_FAILURE_MESSAGES[code] }
}

export async function createPdfPipeline() {
  const vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  const standardFontDataUrl = new URL(
    '../node_modules/pdfjs-dist/standard_fonts/',
    import.meta.url,
  ).href
  const [pdf, quality, importTypes] = await Promise.all([
    vite.ssrLoadModule('/src/research/pdf.ts'),
    vite.ssrLoadModule('/src/research/pdf-quality.ts'),
    vite.ssrLoadModule('/src/research/import-types.ts'),
  ])
  let exportModules

  return {
    reconstructPdf: pdf.reconstructPdf,
    policy: quality.DEFAULT_PDF_COMPLETENESS_POLICY,
    maximumBytes: importTypes.MAX_LOCAL_PDF_BYTES,
    standardFontDataUrl,
    async loadExportModules() {
      exportModules ??= Promise.all([
        vite.ssrLoadModule('/src/research/epub.ts'),
        vite.ssrLoadModule('/src/research/targets.ts'),
      ]).then(([epub, targets]) => ({
        buildEpub: epub.buildEpub,
        inspectEpub: epub.inspectEpub,
        getTargetProfile: targets.getTargetProfile,
        targetProfileIds: targets.TARGET_PROFILE_IDS,
      }))
      return exportModules
    },
    async close() {
      await vite.close()
    },
  }
}

export async function auditPdfPath(path, pipeline) {
  const stableBasename = basename(path)
  try {
    const details = await stat(path)
    if (details.size > pipeline.maximumBytes) {
      return {
        document: {
          basename: stableBasename,
          sha256: null,
          code: 'OVERSIZED_PDF',
          message: SAFE_FAILURE_MESSAGES.OVERSIZED_PDF,
        },
      }
    }
    const bytes = await readFile(path)
    const reconstruction = await pipeline.reconstructPdf(
      new File([bytes], stableBasename, {
        type: 'application/pdf',
        lastModified: 0,
      }),
      undefined,
      { standardFontDataUrl: pipeline.standardFontDataUrl },
    )
    return {
      reconstruction,
      document: {
        basename: stableBasename,
        sha256: reconstruction.source.sha256,
        byteLength: reconstruction.source.byteLength,
        pageCount: reconstruction.source.pageCount,
        completeness: reconstruction.completeness,
        readiness: reconstruction.readiness,
        diagnostics: reconstruction.diagnostics.map(safeAuditDiagnostic),
      },
    }
  } catch (error) {
    return {
      document: {
        basename: stableBasename,
        sha256: null,
        ...safeError(error),
      },
    }
  }
}

export async function auditPdfInputs(inputs, pipeline) {
  const records = []
  for (const path of await pdfPaths(inputs)) {
    records.push({ path, ...(await auditPdfPath(path, pipeline)) })
  }
  records.sort(
    (left, right) =>
      left.document.basename.localeCompare(right.document.basename) ||
      String(left.document.sha256).localeCompare(String(right.document.sha256)),
  )
  return records
}

function roundedRate(numerator, denominator) {
  if (denominator === 0) return 0
  return Math.round((numerator / denominator) * 100_000) / 100_000
}

function failureReasons(documents) {
  const buckets = new Map()
  for (const document of documents) {
    const codes = document.readiness
      ? document.readiness.ready
        ? []
        : document.readiness.blockingDiagnosticCodes
      : [document.code]
    for (const code of new Set(codes)) {
      buckets.set(code, (buckets.get(code) ?? 0) + 1)
    }
  }
  return Object.fromEntries(
    [...buckets].sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function createCorpusReport(documents, policy) {
  const summary = {
    documents: documents.length,
    ready: documents.filter((document) => document.readiness?.ready).length,
    reviewRequired: documents.filter(
      (document) => document.readiness && !document.readiness.ready,
    ).length,
    failed: documents.filter((document) => !document.readiness).length,
  }
  return {
    schemaVersion: PDF_CORPUS_REPORT_SCHEMA_VERSION,
    reportSchema: 'docs/schemas/pdf-corpus-audit.schema.json',
    privacy: 'basenames-hashes-metrics-diagnostics-only',
    policy,
    summary: {
      ...summary,
      passRate: roundedRate(summary.ready, summary.documents),
      failureReasons: failureReasons(documents),
    },
    documents,
  }
}

export function serializeCorpusReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}

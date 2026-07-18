#!/usr/bin/env node
import {
  auditPdfInputs,
  createCorpusReport,
  createPdfPipeline,
  serializeCorpusReport,
} from './pdf-corpus-audit-lib.mjs'

const args = process.argv.slice(2)
const reportOnly = args.includes('--report-only')
const inputs = args.filter((argument) => argument !== '--report-only')
async function main() {
  if (inputs.length === 0) {
    process.stderr.write(
      'Usage: npm run pdf:corpus-audit -- [--report-only] <pdf-or-directory> [...]\n',
    )
    process.exitCode = 2
    return
  }

  const pipeline = await createPdfPipeline()
  try {
    const records = await auditPdfInputs(inputs, pipeline)
    const report = createCorpusReport(
      records.map((record) => record.document),
      pipeline.policy,
    )
    process.stdout.write(serializeCorpusReport(report))
    if (
      !reportOnly &&
      (report.summary.reviewRequired > 0 || report.summary.failed > 0)
    ) {
      process.exitCode = 1
    }
  } finally {
    await pipeline.close()
  }
}

main().catch(() => {
  process.stderr.write(
    'PDF corpus audit failed without publishing local path details.\n',
  )
  process.exitCode = 2
})

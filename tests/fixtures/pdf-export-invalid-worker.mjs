import { basename } from 'node:path'

process.once('message', (job) => {
  process.send(
    {
      type: 'pdf-export-document-result-v1',
      document: {
        basename: basename(job.path),
        sha256: null,
        code: 'PDF_PARSE_FAILED',
        message: 'This arbitrary worker message must never be published.',
      },
      unexpectedPrivateValue: job.path,
    },
    () => process.disconnect(),
  )
})

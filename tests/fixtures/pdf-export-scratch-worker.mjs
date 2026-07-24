import { spawn } from 'node:child_process'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPdfPipeline } from '../../tools/pdf-corpus-audit-lib.mjs'
import { installPdfExportWorkerDisconnectGuard } from '../../tools/pdf-export.mjs'

installPdfExportWorkerDisconnectGuard()

process.once('message', async (job) => {
  const pipeline = await createPdfPipeline({
    temporaryRoot: job.stagingDirectory,
  })
  const cacheName = (await readdir(job.stagingDirectory)).find((name) =>
    name.startsWith('srt-pdf-vite-'),
  )
  const grandchild = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1_000)'],
    { stdio: 'ignore' },
  )
  await writeFile(
    job.observationPath,
    JSON.stringify({
      stagingDirectory: job.stagingDirectory,
      cacheDirectory: join(job.stagingDirectory, cacheName),
      workerPid: process.pid,
      grandchildPid: grandchild.pid,
    }),
  )
  void pipeline
  setInterval(() => {}, 1_000)
})

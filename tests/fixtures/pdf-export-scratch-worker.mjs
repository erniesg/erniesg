import { spawn } from 'node:child_process'
import { mkdtemp, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPdfPipeline } from '../../tools/pdf-corpus-audit-lib.mjs'
import { installPdfExportWorkerDisconnectGuard } from '../../tools/pdf-export.mjs'

installPdfExportWorkerDisconnectGuard()

process.once('message', async (job) => {
  const cacheDirectory = await mkdtemp(
    join(job.stagingDirectory, 'srt-pdf-vite-'),
  )
  const grandchild = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1_000)'],
    { stdio: 'ignore' },
  )
  const pendingObservationPath = `${job.observationPath}.${process.pid}.tmp`
  await writeFile(
    pendingObservationPath,
    JSON.stringify({
      stagingDirectory: job.stagingDirectory,
      cacheDirectory,
      workerPid: process.pid,
      grandchildPid: grandchild.pid,
    }),
  )
  await rename(pendingObservationPath, job.observationPath)

  // The timeout regression holds startup here after scratch readiness. This
  // models a cold Vite/module load without using a machine-speed delay.
  if (job.delayPipelineStart) await new Promise(() => {})

  const pipeline = await createPdfPipeline({
    temporaryRoot: job.stagingDirectory,
  })
  void pipeline
  setInterval(() => {}, 1_000)
})

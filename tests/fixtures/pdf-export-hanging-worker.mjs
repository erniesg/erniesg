import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

process.once('message', async (job) => {
  const grandchild = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1_000)'],
    { stdio: 'ignore' },
  )
  await mkdir(job.stagingDirectory, { recursive: true })
  await writeFile(
    job.observationPath,
    JSON.stringify({
      argv: process.argv,
      workerPid: process.pid,
      grandchildPid: grandchild.pid,
      receivedPath: job.path,
    }),
  )
  await writeFile(join(job.stagingDirectory, 'partial.epub'), 'partial')
  setInterval(() => {}, 1_000)
})

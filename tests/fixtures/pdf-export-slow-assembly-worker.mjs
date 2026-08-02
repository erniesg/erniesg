import { readFile } from 'node:fs/promises'

async function send(message) {
  await new Promise((resolve, reject) => {
    process.send(message, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function waitForGate(path, expected) {
  for (;;) {
    try {
      if (Number(await readFile(path, 'utf8')) >= expected) return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
}

process.once('message', (job) => {
  void (async () => {
    for (let completed = 0; completed <= 3; completed += 1) {
      await send({
        type: 'pdf-export-document-heartbeat-v1',
        stage: 'epub-assembly',
        checkpoint: 'epub-profile',
        completed,
        total: 3,
        elapsedMs: completed * 900,
        rssBytes: 4096,
        heapUsedBytes: 2048,
        userCpuMicros: completed * 100,
        systemCpuMicros: completed * 10,
      })
      await waitForGate(job.acknowledgmentPath, completed + 1)
    }
    await send({
      type: 'pdf-export-document-result-v1',
      document: { fixture: 'slow-assembly' },
    })
    process.disconnect()
  })()
})

process.once('message', () => {
  const send = (message) =>
    new Promise((resolve, reject) => {
      process.send(message, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })

  void (async () => {
    await send({
      type: 'pdf-export-document-heartbeat-v1',
      stage: 'extracting',
      checkpoint: 'page-extraction',
      completed: 1,
      total: 2,
      elapsedMs: 10,
      rssBytes: 1024,
      heapUsedBytes: 512,
      userCpuMicros: 100,
      systemCpuMicros: 10,
    })
    await send({
      type: 'pdf-export-document-heartbeat-v1',
      stage: 'validating',
      checkpoint: 'quality-complete',
      completed: 2,
      total: 2,
      elapsedMs: 20,
      rssBytes: 2048,
      heapUsedBytes: 768,
      userCpuMicros: 200,
      systemCpuMicros: 20,
    })
    await send({
      type: 'pdf-export-document-result-v1',
      document: { fixture: 'bounded-worker' },
    })
    process.disconnect()
  })()
})

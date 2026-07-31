process.once('message', () => {
  process.send({
    type: 'pdf-export-document-heartbeat-v1',
    stage: 'semantic-promotion',
    checkpoint: 'figure-grouping',
    completed: 2,
    total: 4,
    elapsedMs: 25,
    rssBytes: 4096,
    heapUsedBytes: 2048,
    userCpuMicros: 300,
    systemCpuMicros: 30,
  })
  setInterval(() => {}, 1_000)
})

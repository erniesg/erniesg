import pdfWorkerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'

let browserPdfRuntimePromise: Promise<typeof import('pdfjs-dist')> | undefined

export async function loadBrowserPdfRuntime() {
  browserPdfRuntimePromise ??= import('pdfjs-dist')
  try {
    return await browserPdfRuntimePromise
  } catch (error) {
    browserPdfRuntimePromise = undefined
    throw error
  }
}

export async function createBrowserPdfRuntime() {
  const pdfjs = await loadBrowserPdfRuntime()
  const workerUrl = URL.createObjectURL(
    new Blob([pdfWorkerSource], { type: 'application/javascript' }),
  )
  let port: Worker | undefined
  let worker: InstanceType<typeof pdfjs.PDFWorker> | undefined
  try {
    port = new Worker(workerUrl, { type: 'module' })
    const PdfWorker = pdfjs.PDFWorker as unknown as new (options: {
      port: Worker
    }) => InstanceType<typeof pdfjs.PDFWorker>
    worker = new PdfWorker({ port })
  } catch (error) {
    port?.terminate()
    URL.revokeObjectURL(workerUrl)
    throw error
  }
  let destroyed = false
  return {
    pdfjs,
    worker,
    async destroy() {
      if (destroyed) return
      destroyed = true
      try {
        worker.destroy()
      } finally {
        port.terminate()
        URL.revokeObjectURL(workerUrl)
      }
    },
  }
}

export async function warmBrowserPdfRuntime() {
  await loadBrowserPdfRuntime()
}

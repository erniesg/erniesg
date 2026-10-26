import { createBrowserPdfRuntime } from '../research/pdf-browser-runtime'

type PdfDocument = Awaited<
  ReturnType<(typeof import('pdfjs-dist'))['getDocument']>['promise']
>
type PdfLoadingTask = ReturnType<(typeof import('pdfjs-dist'))['getDocument']>
type PdfRuntime = Awaited<ReturnType<typeof createBrowserPdfRuntime>>
type PdfRenderTask = { cancel: () => void; promise: Promise<unknown> }

export type StructOriginalViewer = {
  setSource(url: string | undefined, title: string): void
  destroy(): void
}

/**
 * Renders the source PDF with PDF.js instead of relying on a browser's native
 * PDF plugin, which is unavailable in some embedded and headless browsers.
 */
export function createStructOriginalViewer(
  container: HTMLElement,
): StructOriginalViewer {
  let destroyed = false
  let sourceGeneration = 0
  let renderGeneration = 0
  let currentUrl: string | undefined
  let pageNumber = 1
  let pageCount = 0
  let loadingTask: PdfLoadingTask | undefined
  let pdfDocument: PdfDocument | undefined
  let runtime: PdfRuntime | undefined
  let renderTask: PdfRenderTask | undefined

  container.replaceChildren()
  container.classList.add('struct-original-pdf-viewer')

  const controls = document.createElement('div')
  controls.className = 'struct-original-pdf-controls'
  controls.style.alignItems = 'center'
  controls.style.borderBottom = '1px solid currentColor'
  controls.style.display = 'flex'
  controls.style.flexWrap = 'wrap'
  controls.style.gap = '0.75rem'
  controls.style.padding = '0.75rem'

  const previous = document.createElement('button')
  previous.type = 'button'
  previous.textContent = 'Previous page'
  previous.setAttribute('aria-label', 'Previous PDF page')
  previous.style.border = '1px solid currentColor'
  previous.style.borderRadius = '0.25rem'
  previous.style.padding = '0.375rem 0.625rem'

  const next = document.createElement('button')
  next.type = 'button'
  next.textContent = 'Next page'
  next.setAttribute('aria-label', 'Next PDF page')
  next.style.border = '1px solid currentColor'
  next.style.borderRadius = '0.25rem'
  next.style.padding = '0.375rem 0.625rem'

  const status = document.createElement('span')
  status.className = 'struct-original-pdf-status'
  status.setAttribute('aria-live', 'polite')

  controls.append(previous, status, next)

  const stage = document.createElement('div')
  stage.className = 'struct-original-pdf-stage'
  stage.setAttribute('role', 'region')
  stage.style.height = 'min(600px, 80vh)'
  stage.style.maxWidth = '100%'
  stage.style.overflow = 'auto'
  stage.style.position = 'relative'

  const canvas = document.createElement('canvas')
  canvas.className = 'struct-original-pdf-canvas'
  canvas.style.display = 'block'
  canvas.style.margin = '0 auto'

  const message = document.createElement('p')
  message.className = 'struct-original-pdf-message'
  message.setAttribute('aria-live', 'polite')

  stage.append(canvas, message)
  container.append(controls, stage)

  const setMessage = (value: string) => {
    message.textContent = value
    message.hidden = value.length === 0
  }

  const updateControls = () => {
    previous.disabled = !pdfDocument || pageNumber <= 1
    next.disabled = !pdfDocument || pageNumber >= pageCount
    previous.style.opacity = previous.disabled ? '0.5' : ''
    next.style.opacity = next.disabled ? '0.5' : ''
    status.textContent = pdfDocument ? `Page ${pageNumber} of ${pageCount}` : ''
  }

  const cancelRender = () => {
    renderGeneration += 1
    renderTask?.cancel()
    renderTask = undefined
  }

  const disposeDocument = () => {
    cancelRender()
    const task = loadingTask
    loadingTask = undefined
    void task?.destroy()
    const documentToDestroy = pdfDocument
    pdfDocument = undefined
    void documentToDestroy?.destroy()
    const runtimeToDestroy = runtime
    runtime = undefined
    void runtimeToDestroy?.destroy()
  }

  const renderPage = () => {
    const documentToRender = pdfDocument
    if (!documentToRender || destroyed) return
    const currentSource = sourceGeneration
    const currentRender = ++renderGeneration
    const previousTask = renderTask
    previousTask?.cancel()
    renderTask = undefined
    setMessage(`Drawing page ${pageNumber}…`)

    void (async () => {
      try {
        await previousTask?.promise.catch(() => undefined)
        if (
          destroyed ||
          currentSource !== sourceGeneration ||
          currentRender !== renderGeneration
        )
          return
        const sourcePage = await documentToRender.getPage(pageNumber)
        if (
          destroyed ||
          currentSource !== sourceGeneration ||
          currentRender !== renderGeneration
        )
          return
        const baseViewport = sourcePage.getViewport({ scale: 1 })
        const availableWidth = stage.clientWidth
        const cssScale =
          availableWidth > 0
            ? Math.min(1, availableWidth / baseViewport.width)
            : 1
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
        const viewport = sourcePage.getViewport({
          scale: cssScale * pixelRatio,
        })
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        canvas.style.width = `${Math.ceil(baseViewport.width * cssScale)}px`
        canvas.style.height = `${Math.ceil(baseViewport.height * cssScale)}px`
        canvas.setAttribute(
          'aria-label',
          `Original PDF page ${pageNumber} of ${pageCount}`,
        )
        const task = sourcePage.render({ canvas, viewport })
        renderTask = task
        await task.promise
        if (
          !destroyed &&
          currentSource === sourceGeneration &&
          currentRender === renderGeneration
        ) {
          renderTask = undefined
          setMessage('')
          updateControls()
        }
      } catch (error) {
        if (
          destroyed ||
          currentSource !== sourceGeneration ||
          currentRender !== renderGeneration ||
          (error instanceof Error &&
            error.name === 'RenderingCancelledException')
        )
          return
        setMessage(
          error instanceof Error
            ? `Original PDF could not be drawn: ${error.message}`
            : 'Original PDF could not be drawn.',
        )
      }
    })()
  }

  const resizeObserver = new ResizeObserver(() => renderPage())
  resizeObserver.observe(stage)

  previous.addEventListener('click', () => {
    if (!pdfDocument || pageNumber <= 1) return
    pageNumber -= 1
    updateControls()
    renderPage()
  })
  next.addEventListener('click', () => {
    if (!pdfDocument || pageNumber >= pageCount) return
    pageNumber += 1
    updateControls()
    renderPage()
  })

  updateControls()

  return {
    setSource(url, title) {
      if (destroyed) return
      stage.setAttribute('aria-label', `${title} original PDF`)
      if (url && url === currentUrl) return
      sourceGeneration += 1
      disposeDocument()
      currentUrl = url
      pageNumber = 1
      pageCount = 0
      canvas.removeAttribute('aria-label')
      canvas.width = 0
      canvas.height = 0
      canvas.style.width = ''
      canvas.style.height = ''
      updateControls()

      if (!url) {
        setMessage(
          'Original PDF unavailable. Use the Open PDF link to view the source.',
        )
        return
      }

      const currentSource = sourceGeneration
      setMessage('Opening original PDF…')
      void (async () => {
        let createdRuntime: PdfRuntime | undefined
        let createdTask: PdfLoadingTask | undefined
        let loadedDocument: PdfDocument | undefined
        try {
          createdRuntime = await createBrowserPdfRuntime()
          if (destroyed || currentSource !== sourceGeneration) {
            await createdRuntime.destroy()
            return
          }
          runtime = createdRuntime
          createdTask = createdRuntime.pdfjs.getDocument({
            url,
            isEvalSupported: false,
            useSystemFonts: true,
            worker: createdRuntime.worker,
          })
          loadingTask = createdTask
          loadedDocument = await createdTask.promise
          if (destroyed || currentSource !== sourceGeneration) {
            await loadedDocument.destroy()
            await createdRuntime.destroy()
            return
          }
          loadingTask = undefined
          pdfDocument = loadedDocument
          pageCount = loadedDocument.numPages
          updateControls()
          renderPage()
        } catch (error) {
          if (destroyed || currentSource !== sourceGeneration) return
          loadingTask = undefined
          if (runtime === createdRuntime) runtime = undefined
          await createdRuntime?.destroy()
          setMessage(
            error instanceof Error
              ? `Original PDF unavailable: ${error.message}`
              : 'Original PDF unavailable. Use the Open PDF link to view the source.',
          )
        }
      })()
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      sourceGeneration += 1
      resizeObserver.disconnect()
      disposeDocument()
      container.replaceChildren()
    },
  }
}

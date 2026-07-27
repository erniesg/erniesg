import { useEffect, useRef, useState } from 'react'

export function clampPdfPage(page: number, pageCount: number) {
  if (!Number.isFinite(page) || pageCount < 1) return 1
  return Math.min(pageCount, Math.max(1, Math.trunc(page)))
}

export default function SourcePdfPageViewer({
  sourceUrl,
  title,
}: {
  sourceUrl: string
  title: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [document, setDocument] = useState<Awaited<
    ReturnType<(typeof import('pdfjs-dist'))['getDocument']>['promise']
  > | null>(null)
  const [page, setPage] = useState(1)
  const [stageWidth, setStageWidth] = useState(0)
  const [status, setStatus] = useState('Opening source PDF…')
  const [error, setError] = useState('')

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const updateWidth = () => setStageWidth(stage.clientWidth)
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let active = true
    let loadingTask:
      ReturnType<(typeof import('pdfjs-dist'))['getDocument']> | undefined
    setDocument(null)
    setPage(1)
    setError('')
    setStatus('Opening source PDF…')
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        const { default: pdfWorkerUrl } =
          await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
        loadingTask = pdfjs.getDocument({
          url: sourceUrl,
          isEvalSupported: false,
          useSystemFonts: true,
        })
        const loadedDocument = await loadingTask.promise
        if (!active) {
          await loadedDocument.destroy()
          return
        }
        setDocument(loadedDocument)
      } catch (caught) {
        if (!active) return
        setError(
          caught instanceof Error
            ? caught.message
            : 'The source PDF could not be opened.',
        )
      }
    })()
    return () => {
      active = false
      void loadingTask?.destroy()
    }
  }, [sourceUrl])

  useEffect(() => {
    if (!document || !canvasRef.current || stageWidth < 1) return
    let active = true
    let renderTask:
      { cancel: () => void; promise: Promise<unknown> } | undefined
    setStatus(`Drawing page ${page}…`)
    void (async () => {
      try {
        const sourcePage = await document.getPage(page)
        if (!active || !canvasRef.current) return
        const baseViewport = sourcePage.getViewport({ scale: 1 })
        const availableWidth = Math.max(240, stageWidth - 32)
        const cssScale = availableWidth / baseViewport.width
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
        const viewport = sourcePage.getViewport({
          scale: cssScale * pixelRatio,
        })
        const canvas = canvasRef.current
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        canvas.style.width = `${Math.ceil(viewport.width / pixelRatio)}px`
        canvas.style.height = `${Math.ceil(viewport.height / pixelRatio)}px`
        renderTask = sourcePage.render({ canvas, viewport })
        await renderTask.promise
        if (active) setStatus(`Page ${page} of ${document.numPages}`)
      } catch (caught) {
        if (
          active &&
          (!(caught instanceof Error) ||
            caught.name !== 'RenderingCancelledException')
        ) {
          setError(
            caught instanceof Error
              ? caught.message
              : 'The source page could not be drawn.',
          )
        }
      }
    })()
    return () => {
      active = false
      renderTask?.cancel()
    }
  }, [document, page, stageWidth])

  const pageCount = document?.numPages ?? 0
  const move = (offset: number) =>
    setPage((current) => clampPdfPage(current + offset, pageCount))

  return (
    <div
      className="pdf-source-page-viewer"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          event.stopPropagation()
          move(event.key === 'ArrowLeft' ? -1 : 1)
        }
      }}
    >
      <div className="pdf-source-page-toolbar">
        <button
          type="button"
          disabled={!document || page <= 1}
          onClick={() => move(-1)}
        >
          ← Previous page
        </button>
        <strong aria-live="polite">
          {document ? `${page} / ${pageCount}` : '— / —'}
        </strong>
        <button
          type="button"
          disabled={!document || page >= pageCount}
          onClick={() => move(1)}
        >
          Next page →
        </button>
      </div>
      <div
        ref={stageRef}
        className="pdf-source-page-stage"
        role="region"
        aria-label="Single PDF page"
        tabIndex={0}
      >
        <canvas
          ref={canvasRef}
          aria-label={document ? `Source PDF page ${page}` : undefined}
        />
        {!document && !error && <p aria-live="polite">{status}</p>}
        {error && (
          <p role="alert">
            Source preview unavailable: {error}{' '}
            <a href={sourceUrl} target="_blank" rel="noreferrer">
              Open the PDF directly
            </a>
            .
          </p>
        )}
      </div>
      {document && (
        <small className="pdf-source-page-status" aria-live="polite">
          {status} · use the page buttons or focus the page and press ←/→
        </small>
      )}
    </div>
  )
}

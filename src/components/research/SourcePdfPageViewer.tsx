import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createBrowserPdfRuntime } from '../../research/pdf-browser-runtime'
import PageNavigation from './PageNavigation'
import PageZoomControls from './PageZoomControls'
import {
  fittedReviewScale,
  steppedReviewZoom,
  type ReviewZoomMode,
} from './review-zoom'

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
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [pageSize, setPageSize] = useState({ width: 1, height: 1 })
  const [zoomMode, setZoomMode] = useState<ReviewZoomMode>('fit-page')
  const [zoomPercent, setZoomPercent] = useState(100)
  const [status, setStatus] = useState('Opening source PDF…')
  const [error, setError] = useState('')

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const updateSize = () =>
      setStageSize({ width: stage.clientWidth, height: stage.clientHeight })
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let active = true
    let loadingTask:
      ReturnType<(typeof import('pdfjs-dist'))['getDocument']> | undefined
    let pdfRuntime:
      Awaited<ReturnType<typeof createBrowserPdfRuntime>> | undefined
    setDocument(null)
    setPage(1)
    setError('')
    setStatus('Opening source PDF…')
    void (async () => {
      try {
        pdfRuntime = await createBrowserPdfRuntime()
        if (!active) {
          await pdfRuntime.destroy()
          return
        }
        const { pdfjs, worker } = pdfRuntime
        loadingTask = pdfjs.getDocument({
          url: sourceUrl,
          isEvalSupported: false,
          useSystemFonts: true,
          worker,
        })
        const loadedDocument = await loadingTask.promise
        if (!active) {
          await loadedDocument.destroy()
          await pdfRuntime.destroy()
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
      void pdfRuntime?.destroy()
    }
  }, [sourceUrl])

  useEffect(() => {
    if (!document || !canvasRef.current || stageSize.width < 1) return
    let active = true
    let renderTask:
      { cancel: () => void; promise: Promise<unknown> } | undefined
    setStatus(`Drawing page ${page}…`)
    void (async () => {
      try {
        const sourcePage = await document.getPage(page)
        if (!active || !canvasRef.current) return
        const baseViewport = sourcePage.getViewport({ scale: 1 })
        setPageSize({
          width: baseViewport.width,
          height: baseViewport.height,
        })
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
        const viewport = sourcePage.getViewport({
          scale: pixelRatio,
        })
        const canvas = canvasRef.current
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        canvas.style.width = `${baseViewport.width}px`
        canvas.style.height = `${baseViewport.height}px`
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
  }, [document, page, stageSize.width])

  const pageCount = document?.numPages ?? 0
  const move = (offset: number) =>
    setPage((current) => clampPdfPage(current + offset, pageCount))
  const zoomScale = fittedReviewScale({
    mode: zoomMode,
    customPercent: zoomPercent,
    contentWidth: pageSize.width,
    contentHeight: pageSize.height,
    stageWidth: stageSize.width,
    stageHeight: stageSize.height,
  })

  return (
    <div
      className="pdf-source-page-viewer"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          event.stopPropagation()
          move(event.key === 'ArrowLeft' ? -1 : 1)
        } else if (
          event.key === '+' ||
          event.key === '=' ||
          event.key === '-'
        ) {
          event.preventDefault()
          setZoomMode('custom')
          setZoomPercent(
            steppedReviewZoom(
              zoomMode === 'custom' ? zoomPercent : zoomScale * 100,
              event.key === '-' ? -1 : 1,
            ),
          )
        } else if (event.key === '0') {
          event.preventDefault()
          setZoomMode('fit-page')
        }
      }}
    >
      <div className="pdf-source-page-toolbar">
        <PageNavigation
          page={document ? page : 1}
          pageCount={document ? pageCount : 1}
          label="PDF"
          onPageChange={(next) => setPage(clampPdfPage(next, pageCount))}
        />
        <PageZoomControls
          mode={zoomMode}
          percent={zoomPercent}
          actualScale={zoomScale}
          onChange={(mode, percent) => {
            setZoomMode(mode)
            setZoomPercent(percent)
          }}
        />
      </div>
      <div
        ref={stageRef}
        className="pdf-source-page-stage"
        role="region"
        aria-label="Single PDF page"
        data-zoom-mode={zoomMode}
        tabIndex={0}
        onWheel={(event) => {
          if (!event.ctrlKey) return
          event.preventDefault()
          setZoomMode('custom')
          setZoomPercent(
            steppedReviewZoom(
              zoomMode === 'custom' ? zoomPercent : zoomScale * 100,
              event.deltaY > 0 ? -1 : 1,
            ),
          )
        }}
      >
        <div
          className="pdf-source-page-shell"
          style={
            {
              width: `${pageSize.width * zoomScale}px`,
              height: `${pageSize.height * zoomScale}px`,
              '--pdf-review-scale': zoomScale,
              '--pdf-page-width': `${pageSize.width}px`,
              '--pdf-page-height': `${pageSize.height}px`,
            } as CSSProperties
          }
        >
          <canvas
            ref={canvasRef}
            aria-label={document ? `Source PDF page ${page}` : undefined}
          />
        </div>
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

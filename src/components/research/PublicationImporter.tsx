import { useRef, useState, type DragEvent } from 'react'
import { buildEpub, type EpubExport } from '@/research/epub'
import type {
  PdfImportProgress,
  PdfReconstruction,
} from '@/research/import-types'
import { PdfImportError } from '@/research/import-types'
import EpubDownloadLink from './EpubDownloadLink'
import ResearchStudio from './ResearchStudio'

type StudioState =
  | { status: 'idle' }
  | { status: 'processing'; fileName: string; progress: PdfImportProgress }
  | {
      status: 'ready' | 'needs-ocr'
      result: PdfReconstruction
      epub?: EpubExport
    }
  | { status: 'error'; code: string; message: string }

const initialProgress: PdfImportProgress = {
  phase: 'opening',
  completed: 0,
  total: 1,
  message: 'Opening locally…',
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export default function PublicationImporter() {
  const [state, setState] = useState<StudioState>({ status: 'idle' })
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const processFile = async (file?: File) => {
    if (!file) return
    setState({
      status: 'processing',
      fileName: file.name,
      progress: initialProgress,
    })
    try {
      const { reconstructPdf } = await import('@/research/pdf')
      const result = await reconstructPdf(file, (progress) => {
        setState({ status: 'processing', fileName: file.name, progress })
      })
      const needsOcr = result.diagnostics.some(
        (diagnostic) => diagnostic.code === 'OCR_REQUIRED',
      )
      if (needsOcr || result.paper.nodes.length === 0) {
        setState({ status: 'needs-ocr', result })
        return
      }
      setState({ status: 'ready', result })
      const epub = await buildEpub(result.paper, result)
      setState({ status: 'ready', result, epub })
    } catch (error) {
      setState({
        status: 'error',
        code: error instanceof PdfImportError ? error.code : 'UNEXPECTED_ERROR',
        message:
          error instanceof Error
            ? error.message
            : 'The local conversion failed unexpectedly.',
      })
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    void processFile(event.dataTransfer.files[0])
  }

  const reset = () => {
    if (input.current) input.current.value = ''
    setState({ status: 'idle' })
  }

  const progressPercent =
    state.status === 'processing'
      ? Math.round(
          (state.progress.completed / Math.max(state.progress.total, 1)) * 100,
        )
      : 0

  return (
    <section className="publication-importer" aria-labelledby="studio-heading">
      <div className="publication-importer-intro">
        <div>
          <p className="srt-kicker">Local publication studio</p>
          <h2 id="studio-heading">
            Drop a paper. Get a reflowable publication.
          </h2>
        </div>
        <p>
          The PDF stays in this browser. Embedded text and source boxes become a
          semantic reading flow; a real EPUB is packaged only after
          reconstruction succeeds.
        </p>
      </div>

      {state.status === 'idle' && (
        <div
          className={`publication-dropzone${dragging ? 'is-dragging' : ''}`}
          onDragEnter={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input
            ref={input}
            id="publication-pdf"
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => void processFile(event.target.files?.[0])}
          />
          <label htmlFor="publication-pdf">
            <span aria-hidden="true">PDF → EPUB</span>
            <strong>Choose a PDF or drop it here</strong>
            <small>Born-digital PDF · up to 50 MB · no upload</small>
          </label>
        </div>
      )}

      {state.status === 'processing' && (
        <div
          className="publication-progress"
          aria-live="polite"
          aria-busy="true"
        >
          <div>
            <span>{state.fileName}</span>
            <strong>{state.progress.message}</strong>
          </div>
          <progress max={100} value={progressPercent}>
            {progressPercent}%
          </progress>
        </div>
      )}

      {state.status === 'error' && (
        <div className="publication-failure" role="alert">
          <span>{state.code.replaceAll('_', ' ')}</span>
          <h3>That paper could not be reconstructed.</h3>
          <p>{state.message}</p>
          <button onClick={reset}>Try another PDF</button>
        </div>
      )}

      {(state.status === 'ready' || state.status === 'needs-ocr') && (
        <>
          <div className="publication-result-bar">
            <div>
              <span className="srt-kicker">
                {state.status === 'ready'
                  ? 'Reconstruction ready'
                  : 'Review required'}
              </span>
              <strong>{state.result.source.fileName}</strong>
              <small>
                {state.result.source.pageCount} pages ·{' '}
                {formatBytes(state.result.source.byteLength)} · local only
              </small>
            </div>
            <div className="publication-actions">
              {state.status === 'ready' && state.epub ? (
                <EpubDownloadLink epub={state.epub} />
              ) : state.status === 'ready' ? (
                <span aria-live="polite">Validating EPUB…</span>
              ) : null}
              <button
                onClick={() => window.print()}
                disabled={state.status !== 'ready'}
              >
                Print / PDF
              </button>
              <button className="secondary" onClick={reset}>
                New paper
              </button>
            </div>
          </div>

          {state.status === 'needs-ocr' && (
            <div className="publication-ocr-gate" role="alert">
              <span>OCR required</span>
              <h3>Some pages are images, not trustworthy embedded text.</h3>
              <p>
                This build preserves the page diagnosis and refuses a partial
                EPUB. Local OCR is the next adapter; the document has not left
                your browser.
              </p>
            </div>
          )}

          <details
            className="publication-diagnostics"
            open={state.status === 'needs-ocr'}
          >
            <summary>
              Reconstruction evidence · {state.result.diagnostics.length}{' '}
              diagnostics
            </summary>
            <div className="publication-diagnostic-grid">
              <div>
                <h3>Pages</h3>
                <ol>
                  {state.result.pages.map((page) => (
                    <li key={page.page}>
                      <span>p. {page.page}</span>
                      <strong>{page.kind}</strong>
                      <small>
                        {page.textCharacters} chars · {page.imageCount} images
                      </small>
                    </li>
                  ))}
                </ol>
              </div>
              <div>
                <h3>Source-box provenance</h3>
                <ol>
                  {state.result.paper.nodes.slice(0, 12).map((node) => {
                    const evidence = state.result.provenance[node.id]
                    return (
                      <li key={node.id}>
                        <span>{node.id}</span>
                        <strong>
                          {Math.round((evidence?.confidence ?? 0) * 100)}%
                        </strong>
                        <small>
                          pages {evidence?.pages.join(', ') || '—'} ·{' '}
                          {evidence?.boxes.length ?? 0} boxes
                        </small>
                      </li>
                    )
                  })}
                </ol>
              </div>
            </div>
            {state.result.diagnostics.length > 0 && (
              <ul className="publication-diagnostic-list">
                {state.result.diagnostics.map((diagnostic, index) => (
                  <li
                    key={`${diagnostic.code}-${diagnostic.page ?? 0}-${index}`}
                  >
                    <strong>{diagnostic.code}</strong> {diagnostic.message}
                  </li>
                ))}
              </ul>
            )}
          </details>

          {state.result.paper.nodes.length > 0 && (
            <div
              className={
                state.status === 'ready' ? '' : 'publication-preview-blocked'
              }
            >
              <ResearchStudio paper={state.result.paper} />
            </div>
          )}
        </>
      )}
    </section>
  )
}

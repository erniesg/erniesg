import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react'
import { buildEpub, type EpubExport } from '@/research/epub'
import type {
  PdfImportProgress,
  PdfReconstruction,
} from '@/research/import-types'
import { PdfImportError } from '@/research/import-types'
import { downloadLinkedPdf } from '@/research/pdf-url'
import EpubDownloadLink from './EpubDownloadLink'
import ResearchStudio from './ResearchStudio'

type StudioState =
  | { status: 'idle' }
  | { status: 'processing'; fileName: string; progress: PdfImportProgress }
  | {
      status: 'ready' | 'review-required'
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

export default function PublicationImporter({
  showIntro = true,
}: {
  showIntro?: boolean
}) {
  const [state, setState] = useState<StudioState>({ status: 'idle' })
  const [dragging, setDragging] = useState(false)
  const [paperUrl, setPaperUrl] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const activeImport = useRef<AbortController>()

  useEffect(
    () => () => {
      activeImport.current?.abort()
    },
    [],
  )

  const showError = (error: unknown) => {
    setState({
      status: 'error',
      code: error instanceof PdfImportError ? error.code : 'UNEXPECTED_ERROR',
      message:
        error instanceof Error
          ? error.message
          : 'The local conversion failed unexpectedly.',
    })
  }

  const nextImport = () => {
    activeImport.current?.abort()
    const controller = new AbortController()
    activeImport.current = controller
    return controller
  }

  const processFile = async (file?: File, controller = nextImport()) => {
    if (!file) return
    const isCurrent = () =>
      activeImport.current === controller && !controller.signal.aborted
    setState({
      status: 'processing',
      fileName: file.name,
      progress: initialProgress,
    })
    try {
      const { reconstructPdf } = await import('@/research/pdf')
      const result = await reconstructPdf(
        file,
        (progress) => {
          if (isCurrent()) {
            setState({ status: 'processing', fileName: file.name, progress })
          }
        },
        { signal: controller.signal },
      )
      if (!isCurrent()) return
      if (!result.readiness.ready) {
        setState({ status: 'review-required', result })
        return
      }
      setState({ status: 'ready', result })
      const epub = await buildEpub(result.paper, result)
      if (!isCurrent()) return
      setState({ status: 'ready', result, epub })
    } catch (error) {
      if (activeImport.current !== controller) return
      if (
        error instanceof PdfImportError &&
        error.code === 'IMPORT_CANCELLED'
      ) {
        return
      }
      showError(error)
    }
  }

  const processUrl = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const controller = nextImport()
    setState({
      status: 'processing',
      fileName: paperUrl,
      progress: { ...initialProgress, message: 'Downloading the linked PDF…' },
    })
    try {
      await processFile(
        await downloadLinkedPdf(paperUrl, fetch, undefined, controller.signal),
        controller,
      )
    } catch (error) {
      if (activeImport.current !== controller) return
      if (
        error instanceof PdfImportError &&
        error.code === 'IMPORT_CANCELLED'
      ) {
        return
      }
      showError(error)
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    void processFile(event.dataTransfer.files[0])
  }

  const reset = () => {
    activeImport.current?.abort()
    activeImport.current = undefined
    if (input.current) input.current.value = ''
    setPaperUrl('')
    setState({ status: 'idle' })
  }

  const progressPercent =
    state.status === 'processing'
      ? Math.round(
          (state.progress.completed / Math.max(state.progress.total, 1)) * 100,
        )
      : 0

  return (
    <section
      className="publication-importer"
      aria-label={showIntro ? undefined : 'PDF to EPUB converter'}
      aria-labelledby={showIntro ? 'studio-heading' : undefined}
    >
      {showIntro && (
        <div className="publication-importer-intro">
          <h2 id="studio-heading">Make an EPUB from a PDF</h2>
          <p>
            Upload a paper or paste a direct PDF link. The conversion runs in
            your browser.
          </p>
        </div>
      )}

      {state.status === 'idle' && (
        <div className="publication-intake">
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
              <strong>Choose a PDF</strong>
              <span>or drop it here</span>
              <small>Up to 50 MB. Your file stays on this device.</small>
            </label>
          </div>

          <form className="publication-url" onSubmit={processUrl}>
            <label htmlFor="publication-url">
              <strong>Or paste a PDF link</strong>
              <span>Use a direct download link.</span>
            </label>
            <div className="publication-url__field">
              <input
                id="publication-url"
                type="url"
                inputMode="url"
                required
                value={paperUrl}
                placeholder="https://…/paper.pdf"
                onChange={(event) => setPaperUrl(event.target.value)}
              />
              <button type="submit">Create EPUB</button>
            </div>
            <small>
              If the link is blocked, download the PDF and upload it instead.
            </small>
          </form>
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
          <h3>I couldn't turn that PDF into an EPUB.</h3>
          <p>{state.message}</p>
          <button onClick={reset}>Choose another PDF</button>
        </div>
      )}

      {(state.status === 'ready' || state.status === 'review-required') && (
        <>
          <div className="publication-result-bar">
            <div>
              <span className="srt-kicker">
                {state.status === 'ready' ? 'EPUB ready' : 'Review required'}
              </span>
              <strong>{state.result.source.fileName}</strong>
              <small>
                {state.result.source.pageCount} pages ·{' '}
                {formatBytes(state.result.source.byteLength)} · processed
                locally
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

          {state.status === 'review-required' && (
            <div className="publication-ocr-gate" role="alert">
              <span>Completeness gate</span>
              <h3>This reconstruction is incomplete.</h3>
              <p>
                This version won't make a partial EPUB while source text,
                images, relationships, reading order, or OCR requirements are
                unresolved. Your file has not left this device.
              </p>
            </div>
          )}

          <details
            className="publication-diagnostics"
            open={state.status === 'review-required'}
          >
            <summary>
              Conversion details · {state.result.diagnostics.length}{' '}
              {state.result.diagnostics.length === 1 ? 'note' : 'notes'}
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
                <h3>Completeness</h3>
                <ol>
                  <li>
                    <span>Text coverage</span>
                    <strong>
                      {Math.round(state.result.completeness.textCoverage * 100)}
                      %
                    </strong>
                    <small>
                      {state.result.completeness.matchedTextCharacters} of{' '}
                      {state.result.completeness.sourceTextCharacters}{' '}
                      normalized source characters
                    </small>
                  </li>
                  <li>
                    <span>Asset coverage</span>
                    <strong>
                      {Math.round(
                        state.result.completeness.assetCoverage * 100,
                      )}
                      %
                    </strong>
                    <small>
                      {state.result.completeness.exportedAssetCount} of{' '}
                      {state.result.completeness.sourceAssetCount} source image
                      objects
                    </small>
                  </li>
                  <li>
                    <span>Relationship coverage</span>
                    <strong>
                      {Math.round(
                        state.result.completeness.relationshipCoverage * 100,
                      )}
                      %
                    </strong>
                    <small>
                      {state.result.completeness.resolvedRelationshipCount} of{' '}
                      {state.result.completeness.expectedRelationshipCount}{' '}
                      detected relationships
                    </small>
                  </li>
                  <li>
                    <span>Unresolved objects</span>
                    <strong>
                      {state.result.completeness.unresolvedObjectCount}
                    </strong>
                    <small>
                      OCR pages{' '}
                      {state.result.completeness.ocrRequiredPages.join(', ') ||
                        'none'}
                    </small>
                  </li>
                </ol>
              </div>
              <div>
                <h3>Recovered text</h3>
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

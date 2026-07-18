import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from 'react'
import {
  applyHumanDecisionFile,
  createHumanDecisionFile,
  parseHumanDecisionFile,
  readingOrderCandidates,
  serializeHumanDecisionFile,
  upsertHumanDecision,
  type HumanDecisionFile,
} from '@/research/decision-record'
import { buildEpub, type EpubExport } from '@/research/epub'
import type {
  HumanAdjudicationRecord,
  PdfImportProgress,
  PdfReconstruction,
  ReconstructionDiagnostic,
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
      baseResult: PdfReconstruction
      result: PdfReconstruction
      decisionFile: HumanDecisionFile
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

function AdjudicationControls({
  result,
  diagnostic,
  onDecision,
}: {
  result: PdfReconstruction
  diagnostic: ReconstructionDiagnostic
  onDecision: (decision: HumanAdjudicationRecord) => void
}) {
  if (!diagnostic.target) return null
  const decide = (resolution: HumanAdjudicationRecord['resolution']) =>
    onDecision({
      diagnosticCode: diagnostic.code,
      target: diagnostic.target!,
      resolution,
    })

  if (
    diagnostic.code === 'AMBIGUOUS_NOTE_MATCH' ||
    diagnostic.code === 'UNRESOLVED_NOTE_REFERENCE'
  ) {
    const relationship = result.noteRelationships.find(
      (candidate) => candidate.id === diagnostic.target?.markerId,
    )
    if (!relationship) return null
    return (
      <div className="publication-adjudication-options">
        {relationship.candidates.map((candidate) => {
          const region = result.regions.find(
            (item) => item.id === candidate.targetRegionId,
          )
          return (
            <button
              key={candidate.targetNoteId}
              type="button"
              aria-label={`Use note ${candidate.targetNoteId} for ${relationship.id}`}
              onClick={() =>
                decide({
                  type: 'accept-note-match',
                  targetNoteId: candidate.targetNoteId,
                  targetRegionId: candidate.targetRegionId,
                })
              }
            >
              Use note {candidate.targetNoteId}
              <small>{region?.text || candidate.targetRegionId}</small>
            </button>
          )
        })}
        <button
          type="button"
          onClick={() => decide({ type: 'reclassify-citation' })}
        >
          Treat marker as citation
        </button>
        <button
          type="button"
          onClick={() => decide({ type: 'reclassify-plain-text' })}
        >
          Treat marker as plain text
        </button>
      </div>
    )
  }

  if (diagnostic.code === 'AMBIGUOUS_READING_ORDER') {
    return (
      <div className="publication-adjudication-options">
        {readingOrderCandidates(result, diagnostic).map((candidate, index) => (
          <button
            key={candidate.join(':')}
            type="button"
            aria-label={`Accept reading order ${index + 1}`}
            onClick={() =>
              decide({
                type: 'accept-reading-order',
                regionIds: candidate,
              })
            }
          >
            Accept order {index + 1}
            <small>
              {candidate
                .map(
                  (regionId) =>
                    result.regions.find((region) => region.id === regionId)
                      ?.text || regionId,
                )
                .join(' → ')}
            </small>
          </button>
        ))}
      </div>
    )
  }

  if (diagnostic.severity !== 'error') {
    return (
      <div className="publication-adjudication-options">
        <button type="button" onClick={() => decide({ type: 'dismiss' })}>
          Dismiss this diagnostic
        </button>
      </div>
    )
  }
  return null
}

export default function PublicationImporter({
  showIntro = true,
}: {
  showIntro?: boolean
}) {
  const [state, setState] = useState<StudioState>({ status: 'idle' })
  const [dragging, setDragging] = useState(false)
  const [paperUrl, setPaperUrl] = useState('')
  const [pendingDecisionFile, setPendingDecisionFile] =
    useState<HumanDecisionFile>()
  const [decisionError, setDecisionError] = useState<string>()
  const input = useRef<HTMLInputElement>(null)
  const decisionInput = useRef<HTMLInputElement>(null)
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

  const finishReconstruction = async (
    baseResult: PdfReconstruction,
    decisionFile: HumanDecisionFile,
    controller: AbortController,
  ) => {
    const isCurrent = () =>
      activeImport.current === controller && !controller.signal.aborted
    const result = applyHumanDecisionFile(baseResult, decisionFile)
    if (!isCurrent()) return
    if (!result.readiness.ready) {
      setState({
        status: 'review-required',
        baseResult,
        result,
        decisionFile,
      })
      return
    }
    setState({ status: 'ready', baseResult, result, decisionFile })
    const epub = await buildEpub(result.paper, result)
    if (!isCurrent()) return
    setState({ status: 'ready', baseResult, result, decisionFile, epub })
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
      const baseResult = await reconstructPdf(
        file,
        (progress) => {
          if (isCurrent()) {
            setState({ status: 'processing', fileName: file.name, progress })
          }
        },
        { signal: controller.signal },
      )
      if (!isCurrent()) return
      const decisionFile =
        pendingDecisionFile ?? createHumanDecisionFile(baseResult.source.sha256)
      setPendingDecisionFile(decisionFile)
      await finishReconstruction(baseResult, decisionFile, controller)
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
    if (decisionInput.current) decisionInput.current.value = ''
    setPaperUrl('')
    setPendingDecisionFile(undefined)
    setDecisionError(undefined)
    setState({ status: 'idle' })
  }

  const applyDecision = async (decision: HumanAdjudicationRecord) => {
    if (state.status !== 'ready' && state.status !== 'review-required') return
    const decisionFile = upsertHumanDecision(state.decisionFile, decision)
    setPendingDecisionFile(decisionFile)
    setDecisionError(undefined)
    const controller = nextImport()
    try {
      await finishReconstruction(state.baseResult, decisionFile, controller)
    } catch (error) {
      if (activeImport.current === controller) showError(error)
    }
  }

  const importDecisionFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0]
    if (!selected) return
    try {
      const decisionFile = parseHumanDecisionFile(await selected.text())
      setPendingDecisionFile(decisionFile)
      setDecisionError(undefined)
      if (state.status === 'ready' || state.status === 'review-required') {
        const controller = nextImport()
        await finishReconstruction(state.baseResult, decisionFile, controller)
      }
    } catch (error) {
      setDecisionError(
        error instanceof Error
          ? `Decision file rejected: ${error.message}`
          : 'Decision file rejected.',
      )
    }
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

      <div className="publication-decision-file">
        <label htmlFor="publication-decisions">
          <strong>Adjudication decisions</strong>
          <span>Import local decision JSON to replay saved review.</span>
        </label>
        <input
          ref={decisionInput}
          id="publication-decisions"
          type="file"
          accept="application/json,.json"
          onChange={(event) => void importDecisionFile(event)}
        />
        {pendingDecisionFile && (
          <small>
            Loaded for {pendingDecisionFile.documentSha256.slice(0, 12)}… ·{' '}
            {pendingDecisionFile.decisions.length} decisions
          </small>
        )}
        {decisionError && <p role="alert">{decisionError}</p>}
      </div>

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
              {state.result.humanAdjudications.applied.length > 0 && (
                <small>
                  Human adjudications:{' '}
                  {Object.entries(
                    state.result.humanAdjudications.countsByDiagnosticCode,
                  )
                    .map(([code, count]) => `${code} ${count}`)
                    .join(', ')}
                </small>
              )}
            </div>
            <div className="publication-actions">
              <a
                href={`data:application/json;charset=utf-8,${encodeURIComponent(
                  serializeHumanDecisionFile(state.decisionFile),
                )}`}
                download={`${state.result.source.sha256}.decisions.json`}
              >
                Export decisions JSON
              </a>
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
                    <div>
                      <strong>{diagnostic.code}</strong> {diagnostic.message}
                    </div>
                    <AdjudicationControls
                      result={state.result}
                      diagnostic={diagnostic}
                      onDecision={(decision) => void applyDecision(decision)}
                    />
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
              <ResearchStudio
                key={`${state.result.paper.id}:${state.result.paper.version}`}
                paper={state.result.paper}
              />
            </div>
          )}
        </>
      )}
    </section>
  )
}

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from 'react'
import {
  applyHumanDecisionFile,
  createHumanDecisionFile,
  MAX_HUMAN_DECISION_FILE_BYTES,
  parseHumanDecisionFile,
  readingOrderCandidates,
  serializeHumanDecisionFile,
  upsertHumanDecision,
  type HumanDecisionFile,
} from '../../research/decision-record'
import {
  buildEpub,
  buildReadableEpub,
  type EpubExport,
} from '../../research/epub'
import {
  buildDiagnosticOverlayDocument,
  DIAGNOSTIC_OVERLAY_PALETTE,
  renderDiagnosticOverlaySvg,
  type DiagnosticOverlayItem,
} from '../../research/diagnostic-overlays'
import type {
  DocumentImportProgress,
  DocumentReconstruction,
  HumanAdjudicationRecord,
  PdfReconstruction,
  ReconstructionDiagnostic,
} from '../../research/import-types'
import { DocxImportError, PdfImportError } from '../../research/import-types'
import {
  buildPdfLineJoinReviewContext,
  type PdfLineJoinReviewContext,
} from '../../research/pdf-lines'
import { downloadLinkedPdf } from '../../research/pdf-url'
import { getTargetProfile } from '../../research/targets'
import EpubDownloadLink from './EpubDownloadLink'
import EpubRenditionPreview, {
  epubPreviewArtifactKey,
  selectCurrentProfileEpub,
  type PreviewProfileId,
} from './EpubRenditionPreview'
import './PublicationImporter.css'

type StudioState =
  | { status: 'idle' }
  | {
      status: 'processing'
      fileName: string
      progress: DocumentImportProgress
    }
  | {
      status: 'ready' | 'review-required'
      result: DocumentReconstruction
      sourceFile: File
      baseResult?: PdfReconstruction
      decisionFile?: HumanDecisionFile
      epubs?: EpubExport[]
    }
  | { status: 'error'; code: string; message: string }

const initialProgress: DocumentImportProgress = {
  phase: 'opening',
  completed: 0,
  total: 1,
  message: 'Opening locally…',
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function epubDownloadLabel(epub: EpubExport) {
  const target =
    epub.profile?.id === 'paperPro'
      ? 'Paper Pro EPUB'
      : epub.profile?.id === 'paperProMove'
        ? 'Paper Pro Move EPUB'
        : epub.profile?.id === 'mobile'
          ? 'Mobile EPUB'
          : 'EPUB'
  return epub.mode === 'readable-fallback'
    ? `Download readable ${target} (review recommended)`
    : `Download ${target}`
}

export function isSelectedEpubPreviewReady(
  epub: EpubExport,
  readyArtifactKey?: string,
) {
  return readyArtifactKey === epubPreviewArtifactKey(epub)
}

function PdfPageRaster({ file, page }: { file: File; page: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let active = true
    let loadingTask:
      | ReturnType<(typeof import('pdfjs-dist'))['getDocument']>
      | undefined
    let renderTask:
      | { cancel: () => void; promise: Promise<unknown> }
      | undefined
    setStatus('loading')
    void (async () => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (!active) return
        const pdfjs = await import('pdfjs-dist')
        const { default: pdfWorkerUrl } = await import(
          'pdfjs-dist/build/pdf.worker.min.mjs?url'
        )
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
        loadingTask = pdfjs.getDocument({
          data: bytes,
          isEvalSupported: false,
          useSystemFonts: true,
        })
        const document = await loadingTask.promise
        if (!active) return
        const sourcePage = await document.getPage(page)
        if (!active || !canvas.current) return
        const viewport = sourcePage.getViewport({ scale: 1.8 })
        canvas.current.width = Math.ceil(viewport.width)
        canvas.current.height = Math.ceil(viewport.height)
        renderTask = sourcePage.render({
          canvas: canvas.current,
          viewport,
        })
        await renderTask.promise
        if (active) setStatus('ready')
      } catch (error) {
        if (
          active &&
          (!(error instanceof Error) ||
            error.name !== 'RenderingCancelledException')
        ) {
          setStatus('error')
        }
      }
    })()
    return () => {
      active = false
      renderTask?.cancel()
      void loadingTask?.destroy()
    }
  }, [file, page])

  return (
    <>
      <canvas ref={canvas} aria-label={`Rendered PDF page ${page}`} />
      {status !== 'ready' && (
        <span className="pdf-diagnostic-raster-status" aria-live="polite">
          {status === 'error'
            ? 'The source page raster could not be drawn.'
            : 'Drawing the source page…'}
        </span>
      )}
    </>
  )
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
  const target = diagnostic.target
  if (!target?.regionIds.length || diagnostic.code === 'STALE_HUMAN_DECISION') {
    return null
  }
  const decide = (resolution: HumanAdjudicationRecord['resolution']) =>
    onDecision({
      diagnosticCode: diagnostic.code,
      target,
      resolution,
    })

  if (
    diagnostic.code === 'AMBIGUOUS_NOTE_MATCH' ||
    diagnostic.code === 'UNRESOLVED_NOTE_REFERENCE'
  ) {
    const relationship = result.noteRelationships.find(
      (candidate) => candidate.id === target.markerId,
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

type LineJoinChoice = Extract<
  HumanAdjudicationRecord['resolution'],
  { type: 'resolve-line-join' }
>['outcome']

export function LineJoinAdjudicationCard({
  context,
  selectedOutcome,
  onDecision,
}: {
  context: PdfLineJoinReviewContext
  selectedOutcome?: LineJoinChoice
  onDecision: (outcome: LineJoinChoice) => void
}) {
  const choices: Array<{ outcome: LineJoinChoice; label: string }> = [
    { outcome: 'remove-wrap-hyphen', label: 'Remove wrap hyphen' },
    {
      outcome: 'preserve-authored-hyphen',
      label: 'Preserve authored hyphen',
    },
    { outcome: 'leave-unresolved', label: 'Leave unresolved' },
  ]
  return (
    <section
      className="pdf-diagnostic-selection"
      aria-label={`Line transition ${context.identity.transitionId}`}
    >
      <h4>Line-join review · page {context.page}</h4>
      <p>
        Compare the two adjacent source lines. The displayed text is bounded,
        remains on this device, and is not written to the decision JSON.
      </p>
      <ol>
        <li>
          <strong>{context.identity.fromLineId}</strong>
          <span>{context.from.text}</span>
        </li>
        <li>
          <strong>{context.identity.toLineId}</strong>
          <span>{context.to.text}</span>
        </li>
      </ol>
      <div className="publication-adjudication-options">
        {choices.map((choice) => (
          <button
            key={choice.outcome}
            type="button"
            aria-pressed={selectedOutcome === choice.outcome ? true : undefined}
            onClick={() => onDecision(choice.outcome)}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </section>
  )
}

function LineJoinAdjudicationReview({
  baseResult,
  result,
  onDecision,
}: {
  baseResult: PdfReconstruction
  result: PdfReconstruction
  onDecision: (decision: HumanAdjudicationRecord) => void
}) {
  const contexts = baseResult.lineBoundaryDecisions.flatMap((transition) => {
    if (transition.outcome !== 'unresolved') return []
    const region = baseResult.regions.find(
      (candidate) => candidate.id === transition.regionId,
    )
    const context = region
      ? buildPdfLineJoinReviewContext(region, transition)
      : null
    return context ? [{ context, transition }] : []
  })
  if (contexts.length === 0) return null

  return (
    <section
      className="pdf-diagnostic-inspector"
      aria-labelledby="pdf-line-join-review-heading"
    >
      <div className="pdf-diagnostic-inspector__heading">
        <div>
          <span>Owner-local adjudication</span>
          <h3 id="pdf-line-join-review-heading">Line-join review</h3>
          <p>
            {contexts.length} source line transition
            {contexts.length === 1 ? '' : 's'} need an explicit choice. Nothing
            is selected automatically.
          </p>
        </div>
      </div>
      <ol className="publication-diagnostic-list">
        {contexts.map(({ context, transition }) => {
          const applied = result.humanAdjudications.applied.find(
            (decision) =>
              decision.resolution.type === 'resolve-line-join' &&
              decision.resolution.transition.id === transition.id,
          )
          const selectedOutcome =
            applied?.resolution.type === 'resolve-line-join'
              ? applied.resolution.outcome
              : undefined
          return (
            <li key={transition.id}>
              <LineJoinAdjudicationCard
                context={context}
                selectedOutcome={selectedOutcome}
                onDecision={(outcome) =>
                  onDecision({
                    diagnosticCode: 'UNRESOLVED_CORRUPTING_JOIN',
                    target: {
                      regionIds: [transition.regionId],
                      markerId: transition.id,
                    },
                    resolution: {
                      type: 'resolve-line-join',
                      transition: {
                        id: transition.id,
                        regionId: transition.regionId,
                        fromLineId: transition.fromLineId,
                        toLineId: transition.toLineId,
                      },
                      outcome,
                      confidence: 1,
                      evidence: [
                        'bounded-source-context',
                        'owner-local-adjudication',
                      ],
                    },
                  })
                }
              />
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function DiagnosticDetails({
  item,
  result,
  onDecision,
}: {
  item: DiagnosticOverlayItem
  result: PdfReconstruction
  onDecision: (decision: HumanAdjudicationRecord) => void
}) {
  return (
    <div className="pdf-diagnostic-selection" aria-live="polite">
      <p>{item.diagnostic.message}</p>
      {item.noteRelationship && (
        <div>
          <h4>
            Reference {item.noteRelationship.label} · candidate note bodies
          </h4>
          {item.noteRelationship.candidates.length > 0 ? (
            <ol>
              {item.noteRelationship.candidates.map((candidate) => (
                <li key={candidate.targetRegionId}>
                  <strong>
                    {candidate.targetRegionId} · {candidate.score.toFixed(2)}
                  </strong>
                  <span>{candidate.evidence.join(' · ')}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p>No candidate note body matched this marker.</p>
          )}
        </div>
      )}
      {item.readingOrderCandidates && (
        <div>
          <h4>Competing reading orders</h4>
          <ol>
            {item.readingOrderCandidates.map((candidate) => (
              <li key={candidate.id}>
                <strong>{candidate.label}</strong>
                <span>{candidate.regionIds.join(' → ')}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <AdjudicationControls
        result={result}
        diagnostic={item.diagnostic}
        onDecision={onDecision}
      />
    </div>
  )
}

function PdfDiagnosticReview({
  result,
  sourceFile,
  showVisual,
  onDecision,
}: {
  result: PdfReconstruction
  sourceFile: File
  showVisual: boolean
  onDecision: (decision: HumanAdjudicationRecord) => void
}) {
  const model = useMemo(() => buildDiagnosticOverlayDocument(result), [result])
  const first =
    model.diagnostics.find((item) => item.diagnostic.severity === 'error') ??
    model.diagnostics[0]
  const [selectedId, setSelectedId] = useState(first?.id)
  const [pageNumber, setPageNumber] = useState(first?.pages[0] ?? 1)
  const selected =
    model.diagnostics.find((item) => item.id === selectedId) ?? first
  const page =
    model.pages.find((candidate) => candidate.page === pageNumber) ??
    model.pages[0]

  const selectDiagnostic = (item: DiagnosticOverlayItem) => {
    setSelectedId(item.id)
    setPageNumber(item.pages[0] ?? 1)
  }

  return (
    <>
      {showVisual && selected && page && (
        <section
          className="pdf-diagnostic-inspector"
          aria-labelledby="pdf-diagnostic-inspector-heading"
        >
          <div className="pdf-diagnostic-inspector__heading">
            <div>
              <span>Local visual review</span>
              <h3 id="pdf-diagnostic-inspector-heading">
                Diagnostic page inspector
              </h3>
              <p>
                Select a diagnostic below to isolate its source geometry. The
                PDF raster and overlays stay on this device.
              </p>
            </div>
            <div className="pdf-diagnostic-page-tabs" aria-label="PDF pages">
              {model.pages.map((candidate) => (
                <button
                  key={candidate.page}
                  type="button"
                  aria-pressed={candidate.page === page.page}
                  onClick={() => setPageNumber(candidate.page)}
                >
                  p. {candidate.page}
                </button>
              ))}
            </div>
          </div>
          <div className="pdf-diagnostic-inspector__layout">
            <div
              className="pdf-diagnostic-page"
              style={{ aspectRatio: `${page.width} / ${page.height}` }}
            >
              <PdfPageRaster file={sourceFile} page={page.page} />
              <div
                className="pdf-diagnostic-overlay"
                aria-hidden="true"
                dangerouslySetInnerHTML={{
                  __html: renderDiagnosticOverlaySvg(page, selected.id),
                }}
              />
            </div>
            <div>
              <ul className="pdf-diagnostic-legend" aria-label="Overlay colors">
                {Object.entries(DIAGNOSTIC_OVERLAY_PALETTE).map(
                  ([category, palette]) => (
                    <li key={category}>
                      <i style={{ backgroundColor: palette.color }} />
                      {palette.label}
                    </li>
                  ),
                )}
              </ul>
              <DiagnosticDetails
                item={selected}
                result={result}
                onDecision={onDecision}
              />
            </div>
          </div>
        </section>
      )}

      <ul className="publication-diagnostic-list">
        {model.diagnostics.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              aria-pressed={showVisual && item.id === selected?.id}
              onClick={() => selectDiagnostic(item)}
            >
              <strong>{item.diagnostic.code}</strong>
              <span>{item.diagnostic.message}</span>
              {item.pages.length > 0 && (
                <small>page {item.pages.join(', ')}</small>
              )}
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

function importErrorCode(error: unknown) {
  return error instanceof PdfImportError || error instanceof DocxImportError
    ? error.code
    : 'UNEXPECTED_ERROR'
}

function importWasCancelled(error: unknown) {
  return (
    (error instanceof PdfImportError || error instanceof DocxImportError) &&
    error.code === 'IMPORT_CANCELLED'
  )
}

function importerVersion(source: DocumentReconstruction['source']) {
  return source.format === 'docx' ? source.importerVersion : ''
}

function isPdfReconstruction(
  result: DocumentReconstruction,
): result is PdfReconstruction {
  return result.source.format !== 'docx'
}

export default function PublicationImporter({
  showIntro = true,
}: {
  showIntro?: boolean
}) {
  const [state, setState] = useState<StudioState>({ status: 'idle' })
  const [isHydrated, setIsHydrated] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [paperUrl, setPaperUrl] = useState('')
  const [ocrLanguage, setOcrLanguage] = useState<'auto' | 'eng'>('auto')
  const [selectedProfileId, setSelectedProfileId] =
    useState<PreviewProfileId>('mobile')
  const [previewReadyArtifactKey, setPreviewReadyArtifactKey] =
    useState<string>()
  const [pendingDecisionFile, setPendingDecisionFile] =
    useState<HumanDecisionFile>()
  const [decisionError, setDecisionError] = useState<string>()
  const input = useRef<HTMLInputElement>(null)
  const decisionInput = useRef<HTMLInputElement>(null)
  const activeImport = useRef<AbortController>()

  useEffect(() => {
    setIsHydrated(true)
    return () => {
      activeImport.current?.abort()
    }
  }, [])

  const showError = (error: unknown) => {
    setState({
      status: 'error',
      code: importErrorCode(error),
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

  const finishReconstruction = async ({
    result,
    sourceFile,
    controller,
    baseResult,
    decisionFile,
  }: {
    result: DocumentReconstruction
    sourceFile: File
    controller: AbortController
    baseResult?: PdfReconstruction
    decisionFile?: HumanDecisionFile
  }) => {
    const isCurrent = () =>
      activeImport.current === controller && !controller.signal.aborted
    if (!isCurrent()) return
    const completed = {
      result,
      sourceFile,
      ...(baseResult ? { baseResult } : {}),
      ...(decisionFile ? { decisionFile } : {}),
    }
    if (!result.readiness.ready) {
      setState({ status: 'review-required', ...completed })
      if (isPdfReconstruction(result)) {
        try {
          const epubs = await Promise.all([
            buildReadableEpub(result.paper, result, getTargetProfile('mobile')),
            buildReadableEpub(
              result.paper,
              result,
              getTargetProfile('paperPro'),
            ),
            buildReadableEpub(
              result.paper,
              result,
              getTargetProfile('paperProMove'),
            ),
          ])
          if (isCurrent()) {
            setState({ status: 'review-required', ...completed, epubs })
          }
        } catch {
          // Missing-page text still requires OCR before a readable fallback.
        }
      }
      return
    }
    setState({ status: 'ready', ...completed })
    const epubs = await Promise.all([
      buildEpub(result.paper, result, getTargetProfile('mobile')),
      buildEpub(result.paper, result, getTargetProfile('paperPro')),
      buildEpub(result.paper, result, getTargetProfile('paperProMove')),
    ])
    if (!isCurrent()) return
    setState({ status: 'ready', ...completed, epubs })
  }

  const processFile = async (file?: File, controller = nextImport()) => {
    if (!file) return
    const isCurrent = () =>
      activeImport.current === controller && !controller.signal.aborted
    setSelectedProfileId('mobile')
    setPreviewReadyArtifactKey(undefined)
    setState({
      status: 'processing',
      fileName: file.name,
      progress: initialProgress,
    })
    try {
      const onProgress = (progress: DocumentImportProgress) => {
        if (isCurrent()) {
          setState({ status: 'processing', fileName: file.name, progress })
        }
      }
      const isDocx =
        file.name.toLowerCase().endsWith('.docx') ||
        file.type ===
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      let result: DocumentReconstruction
      let baseResult: PdfReconstruction | undefined
      let decisionFile: HumanDecisionFile | undefined
      if (isDocx) {
        result = await (
          await import('../../research/docx-import')
        ).reconstructDocx(file, onProgress, { signal: controller.signal })
      } else {
        baseResult = await (
          await import('../../research/pdf')
        ).reconstructPdf(file, onProgress, {
          signal: controller.signal,
          ocr: {
            languages: ['eng'],
            languageMode:
              ocrLanguage === 'auto' ? 'automatic-fallback' : 'explicit',
            async createSession(options) {
              const { createBrowserOcrSession } = await import(
                '../../research/pdf-ocr-browser'
              )
              return createBrowserOcrSession(options)
            },
          },
        })
        decisionFile =
          pendingDecisionFile ??
          createHumanDecisionFile(baseResult.source.sha256)
        setPendingDecisionFile(decisionFile)
        result = applyHumanDecisionFile(baseResult, decisionFile)
      }
      if (!isCurrent()) return
      await finishReconstruction({
        result,
        sourceFile: file,
        controller,
        baseResult,
        decisionFile,
      })
    } catch (error) {
      if (activeImport.current !== controller) return
      if (importWasCancelled(error)) return
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
      if (importWasCancelled(error)) return
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
    setSelectedProfileId('mobile')
    setPreviewReadyArtifactKey(undefined)
    setState({ status: 'idle' })
  }

  const applyDecision = async (decision: HumanAdjudicationRecord) => {
    if (
      (state.status !== 'ready' && state.status !== 'review-required') ||
      !state.baseResult ||
      !state.decisionFile
    ) {
      return
    }
    const decisionFile = upsertHumanDecision(state.decisionFile, decision)
    setPendingDecisionFile(decisionFile)
    setDecisionError(undefined)
    const controller = nextImport()
    try {
      await finishReconstruction({
        result: applyHumanDecisionFile(state.baseResult, decisionFile),
        sourceFile: state.sourceFile,
        controller,
        baseResult: state.baseResult,
        decisionFile,
      })
    } catch (error) {
      if (activeImport.current === controller) showError(error)
    }
  }

  const importDecisionFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0]
    if (!selected) return
    try {
      if (selected.size > MAX_HUMAN_DECISION_FILE_BYTES) {
        throw new Error(
          `Decision file exceeds the ${MAX_HUMAN_DECISION_FILE_BYTES}-byte local limit.`,
        )
      }
      const decisionFile = parseHumanDecisionFile(await selected.text())
      setPendingDecisionFile(decisionFile)
      setDecisionError(undefined)
      if (
        (state.status === 'ready' || state.status === 'review-required') &&
        state.baseResult
      ) {
        const controller = nextImport()
        await finishReconstruction({
          result: applyHumanDecisionFile(state.baseResult, decisionFile),
          sourceFile: state.sourceFile,
          controller,
          baseResult: state.baseResult,
          decisionFile,
        })
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
  const selectedEpub =
    (state.status === 'ready' || state.status === 'review-required') &&
    state.epubs
      ? selectCurrentProfileEpub(state.epubs, selectedProfileId)
      : undefined
  const selectedEpubPreviewReady = selectedEpub
    ? isSelectedEpubPreviewReady(selectedEpub, previewReadyArtifactKey)
    : false

  return (
    <section
      className="publication-importer"
      aria-label={showIntro ? undefined : 'PDF or DOCX to EPUB converter'}
      aria-labelledby={showIntro ? 'studio-heading' : undefined}
    >
      {showIntro && (
        <div className="publication-importer-intro">
          <h2 id="studio-heading">Make an EPUB from a PDF or DOCX</h2>
          <p>
            Upload a paper or paste a direct PDF link. PDF reconstruction and
            structured DOCX import run in your browser.
          </p>
        </div>
      )}

      <div className="publication-decision-file">
        <label htmlFor="publication-decisions">
          <strong>Adjudication decisions</strong>
          <span>Import local decision JSON to replay saved PDF review.</span>
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
        <>
          <div className="publication-ocr-options">
            <label htmlFor="publication-ocr-language">OCR language</label>
            <select
              id="publication-ocr-language"
              disabled={!isHydrated}
              value={ocrLanguage}
              onChange={(event) =>
                setOcrLanguage(event.target.value === 'eng' ? 'eng' : 'auto')
              }
            >
              <option value="auto">Auto (English fallback)</option>
              <option value="eng">English</option>
            </select>
            <small>
              OCR runs offline. Auto uses the bundled English fallback; other
              languages require an integrity-pinned local language pack.
            </small>
          </div>
          <div className="publication-intake">
            <div
              className={`publication-dropzone ${dragging ? 'is-dragging' : ''}`}
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
                disabled={!isHydrated}
                accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.pdf,.docx"
                onChange={(event) => void processFile(event.target.files?.[0])}
              />
              <label htmlFor="publication-pdf">
                <strong>Choose a PDF or DOCX</strong>
                <span>or drop it here</span>
                <small>Up to 75 MB. Your file stays on this device.</small>
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
                  disabled={!isHydrated}
                  inputMode="url"
                  required
                  value={paperUrl}
                  placeholder="https://…/paper.pdf"
                  onChange={(event) => setPaperUrl(event.target.value)}
                />
                <button type="submit" disabled={!isHydrated}>
                  Create EPUB
                </button>
              </div>
              <small>
                If the link is blocked, download the PDF and upload it instead.
              </small>
            </form>
          </div>
        </>
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
          <h3>I couldn't turn that paper into an EPUB.</h3>
          <p>{state.message}</p>
          <button onClick={reset}>Choose another paper</button>
        </div>
      )}

      {(state.status === 'ready' || state.status === 'review-required') && (
        <>
          <div className="publication-result-bar">
            <div>
              <span className="srt-kicker">
                {state.status === 'ready'
                  ? state.epubs
                    ? 'EPUB ready'
                    : 'Validating EPUB'
                  : 'Review required'}
              </span>
              <strong>{state.result.source.fileName}</strong>
              <small>
                {state.result.source.format === 'docx'
                  ? `${state.result.source.packageParts.length} package parts`
                  : `${state.result.source.pageCount} pages`}{' '}
                · {formatBytes(state.result.source.byteLength)} · processed
                locally
              </small>
              {isPdfReconstruction(state.result) &&
                state.result.humanAdjudications.applied.length > 0 && (
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
              {state.decisionFile && (
                <a
                  href={`data:application/json;charset=utf-8,${encodeURIComponent(
                    serializeHumanDecisionFile(state.decisionFile),
                  )}`}
                  download={`${state.result.source.sha256}.decisions.json`}
                >
                  Export decisions JSON
                </a>
              )}
              {selectedEpub && selectedEpubPreviewReady ? (
                <EpubDownloadLink key={selectedEpub.sha256} epub={selectedEpub}>
                  {epubDownloadLabel(selectedEpub)}
                </EpubDownloadLink>
              ) : selectedEpub ? (
                <span aria-live="polite">Preparing selected EPUB preview…</span>
              ) : state.status === 'ready' ? (
                <span aria-live="polite">Validating EPUB…</span>
              ) : null}
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
                Publication-grade export remains blocked while source images,
                relationships, or reading order need review. When every page has
                recoverable text, the readable EPUB downloads preserve the
                current text flow and matched visuals without claiming those
                unresolved details are final. Your file has not left this
                device.
              </p>
              <ul
                className="publication-blocking-issues"
                aria-label="Blocking issue groups"
              >
                {state.result.readiness.blockingDiagnosticCodes.map((code) => {
                  const count = state.result.diagnostics.filter(
                    (diagnostic) => diagnostic.code === code,
                  ).length
                  return (
                    <li key={code}>
                      <strong>{code.replaceAll('_', ' ')}</strong>
                      <span>{count || 1}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {state.epubs?.[0] && (
            <EpubRenditionPreview
              epubs={state.epubs}
              selectedProfileId={selectedProfileId}
              onSelectedProfileChange={setSelectedProfileId}
              onPreviewReadyChange={setPreviewReadyArtifactKey}
            />
          )}

          <details className="publication-diagnostics">
            <summary>
              Conversion details · {state.result.diagnostics.length}{' '}
              {state.result.diagnostics.length === 1 ? 'note' : 'notes'}
            </summary>
            <div className="publication-diagnostic-grid">
              <div>
                <h3>
                  {state.result.source.format === 'docx' ? 'Package' : 'Pages'}
                </h3>
                <ol>
                  {state.result.source.format === 'docx'
                    ? state.result.source.packageParts
                        .slice(0, 12)
                        .map((part) => (
                          <li key={part}>
                            <span>{part}</span>
                            <strong>OOXML</strong>
                            <small>
                              importer {importerVersion(state.result.source)}
                            </small>
                          </li>
                        ))
                    : state.result.pages.map((page) => (
                        <li key={page.page}>
                          <span>p. {page.page}</span>
                          <strong>{page.kind}</strong>
                          <small>
                            {page.textCharacters} chars · {page.imageCount}{' '}
                            images
                            {page.ocr
                              ? ` · ${page.ocr.engine} ${page.ocr.engineVersion} · ${page.ocr.model} ${page.ocr.modelVersion} · ${page.ocr.languages.join('+')} · ${Math.round(page.ocr.confidence * 100)}% OCR`
                              : ''}
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
                      {state.result.completeness.sourceAssetCount} source visual
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
            {isPdfReconstruction(state.result) && (
              <LineJoinAdjudicationReview
                baseResult={state.baseResult ?? state.result}
                result={state.result}
                onDecision={(decision) => void applyDecision(decision)}
              />
            )}
            {state.result.diagnostics.length > 0 &&
              (isPdfReconstruction(state.result) ? (
                <PdfDiagnosticReview
                  key={state.result.source.sha256}
                  result={state.result}
                  sourceFile={state.sourceFile}
                  showVisual={state.status === 'review-required'}
                  onDecision={(decision) => void applyDecision(decision)}
                />
              ) : (
                <ul className="publication-diagnostic-list">
                  {state.result.diagnostics.map((diagnostic, index) => (
                    <li
                      key={`${diagnostic.code}-${diagnostic.page ?? 0}-${index}`}
                    >
                      <strong>{diagnostic.code}</strong> {diagnostic.message}
                    </li>
                  ))}
                </ul>
              ))}
          </details>
        </>
      )}
    </section>
  )
}

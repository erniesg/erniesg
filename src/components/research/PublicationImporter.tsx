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
  createEquationTranscriptDecision,
  createHumanDecisionFile,
  createVisualMatchDecision,
  equationTranscriptDecisionBinding,
  humanDecisionFileSha256,
  MAX_EQUATION_TRANSCRIPT_LENGTH,
  MAX_HUMAN_DECISION_FILE_BYTES,
  parseHumanDecisionFile,
  readingOrderCandidates,
  serializeHumanDecisionFile,
  upsertHumanDecision,
  type HumanDecisionFile,
} from '../../research/decision-record'
import type { EpubExport } from '../../research/epub'
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
import {
  getTargetProfile,
  resolveTargetProfile,
  type TargetOrientation,
} from '../../research/targets'
import { diagnosticCopy, recoverySummary } from '../../struct/recovery'
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

type ActiveProfileBuild = {
  controller: AbortController
  profileId: PreviewProfileId
  orientation: TargetOrientation
}

type ProfileBuildIssue = {
  controller: AbortController
  profileId: PreviewProfileId
  orientation: TargetOrientation
  message: string
}

type ProfileBuildIssues = Partial<Record<PreviewProfileId, ProfileBuildIssue>>

export type PublicationReviewSnapshot = {
  source: {
    fileName: string
    sha256: string
    byteLength: number
    pageCount: number
  }
  readiness: {
    status: 'ready' | 'review-required'
    blockingDiagnosticCodes: string[]
  }
  completeness: {
    textCoverage: number
    assetCoverage: number
    relationshipCoverage: number
    unresolvedObjectCount: number
    ocrRequiredPages: number[]
    readingOrderDiagnostics: number
  }
  diagnostics: Array<{
    code: string
    severity: ReconstructionDiagnostic['severity']
    page?: number
  }>
  epub?: {
    sha256: string
    mode: EpubExport['mode']
    profileId: PreviewProfileId
    profileVersion: string
  }
}

const initialProgress: DocumentImportProgress = {
  phase: 'opening',
  completed: 0,
  total: 1,
  message: 'Opening locally…',
}

export function importProgressIsIndeterminate(
  progress: DocumentImportProgress,
) {
  return (
    progress.total <= 0 ||
    [
      'segmenting',
      'reading-order',
      'semantic-promotion',
      'asset-packaging',
      'reconstructing',
      'assembling',
      'paginating',
      'validating',
    ].includes(progress.phase)
  )
}

export function formatImportElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return minutes > 0
    ? `${minutes}m ${remainingSeconds.toString().padStart(2, '0')}s elapsed`
    : `${remainingSeconds}s elapsed`
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
    ? `Download ${target} review artifact (not publication-ready)`
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
      ReturnType<(typeof import('pdfjs-dist'))['getDocument']> | undefined
    let renderTask:
      { cancel: () => void; promise: Promise<unknown> } | undefined
    setStatus('loading')
    void (async () => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (!active) return
        const pdfjs = await import('pdfjs-dist')
        const { default: pdfWorkerUrl } =
          await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
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

  if (diagnostic.code === 'UNRESOLVED_EQUATION_TRANSCRIPT') {
    const relationship = result.visualRelationships.find(
      (candidate) =>
        candidate.id === target.markerId &&
        candidate.id === diagnostic.relationshipId,
    )
    const binding = relationship
      ? equationTranscriptDecisionBinding(result, relationship.id)
      : null
    if (!relationship || !binding) return null
    return (
      <EquationTranscriptAdjudicationCard
        relationshipId={relationship.id}
        label={relationship.label}
        onDecision={(transcript) =>
          onDecision(
            createEquationTranscriptDecision(
              result,
              relationship.id,
              transcript,
            ),
          )
        }
      />
    )
  }

  if (
    diagnostic.code === 'AMBIGUOUS_VISUAL_MATCH' ||
    diagnostic.code === 'UNRESOLVED_VISUAL_OBJECT'
  ) {
    const relationship = result.visualRelationships.find(
      (candidate) => candidate.id === target.markerId,
    )
    if (!relationship) return null
    const caption = result.regions.find(
      (region) => region.id === relationship.captionRegionId,
    )
    return (
      <div className="publication-visual-adjudication">
        <h4>{relationship.label} · bounded visual candidates</h4>
        <p>{caption?.text || relationship.altText}</p>
        <small>
          Caption box:{' '}
          {relationship.sourceBoxes[0]
            ? sourceBoxLabel(relationship.sourceBoxes[0])
            : 'unavailable'}
        </small>
        <ol>
          {relationship.candidates.map((candidate) => {
            const candidateId =
              candidate.id ??
              `missing-candidate-id:${candidate.sourceObjectIds.join(':')}`
            const assets = candidate.assetIds.flatMap((assetId) => {
              const asset = result.assets.find((item) => item.id === assetId)
              return asset ? [asset] : []
            })
            const complete =
              assets.length === candidate.assetIds.length &&
              assets.length > 0 &&
              assets.every((asset) => asset.bytes.byteLength > 0)
            return (
              <li key={candidateId}>
                <strong>
                  Score {candidate.score.toFixed(3)} · {candidateId}
                </strong>
                <span>
                  Regions: {candidate.sourceRegionIds.join(', ') || 'none'} ·
                  Objects: {candidate.sourceObjectIds.join(', ') || 'none'}
                </span>
                <span>
                  Bounds:{' '}
                  {candidate.sourceBoxes.map(sourceBoxLabel).join(' · ') ||
                    'none'}
                </span>
                <span>{candidate.evidence.join(' · ')}</span>
                <div className="publication-visual-asset-previews">
                  {assets.map((asset) => (
                    <figure key={asset.id}>
                      <img
                        src={visualAssetDataUrl(asset.mediaType, asset.bytes)}
                        alt={`${relationship.label} candidate asset ${asset.id}`}
                      />
                      <figcaption>{asset.id}</figcaption>
                    </figure>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={!complete || !candidate.id}
                  onClick={() =>
                    onDecision(
                      createVisualMatchDecision(
                        result,
                        relationship.id,
                        candidateId,
                        diagnostic.code === 'AMBIGUOUS_VISUAL_MATCH'
                          ? 'accept-visual-match'
                          : 'accept-visual-fallback',
                      ),
                    )
                  }
                >
                  Use this complete local asset
                </button>
                {candidate.sourceObjectIds.length > 0 && (
                  <div aria-label={`Decoration choices for ${candidateId}`}>
                    {(
                      [
                        'page-furniture',
                        'separator-rule',
                        'decorative-ornament',
                        'background',
                      ] as const
                    ).map((reason) => (
                      <button
                        key={reason}
                        type="button"
                        onClick={() =>
                          decide({
                            type: 'classify-visual-decoration',
                            relationshipId: relationship.id,
                            sourceObjectIds: [...candidate.sourceObjectIds],
                            reason,
                          })
                        }
                      >
                        Mark named objects as {reason}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      </div>
    )
  }

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

function sourceBoxLabel(box: {
  page: number
  x: number
  y: number
  width: number
  height: number
}) {
  return `p${box.page} x${box.x.toFixed(3)} y${box.y.toFixed(3)} ${box.width.toFixed(3)}×${box.height.toFixed(3)}`
}

function visualAssetDataUrl(mediaType: string, bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return `data:${mediaType};base64,${btoa(binary)}`
}

export function EquationTranscriptAdjudicationCard({
  relationshipId,
  label,
  onDecision,
}: {
  relationshipId: string
  label: string
  onDecision: (transcript: string) => void
}) {
  const [transcript, setTranscript] = useState('')
  const fieldId = `equation-transcript-${relationshipId.replaceAll(
    /[^A-Za-z0-9_-]/gu,
    '-',
  )}`
  const descriptionId = `${fieldId}-description`

  return (
    <form
      className="pdf-diagnostic-selection equation-transcript-adjudication"
      aria-label={`Equation transcript review for ${label}`}
      onSubmit={(event) => {
        event.preventDefault()
        if (transcript.trim().length > 0) onDecision(transcript)
      }}
    >
      <h4>{label} · equation transcript review</h4>
      <p id={descriptionId}>
        Transcribe the highlighted, exact source crop as LaTeX. The text stays
        on this device and is stored only in the local decisions JSON and EPUB.
        It is never inferred or selected automatically.
      </p>
      <label htmlFor={fieldId}>LaTeX transcript</label>
      <textarea
        id={fieldId}
        aria-describedby={descriptionId}
        autoCapitalize="off"
        autoComplete="off"
        maxLength={MAX_EQUATION_TRANSCRIPT_LENGTH}
        rows={5}
        spellCheck={false}
        value={transcript}
        onChange={(event) => setTranscript(event.target.value)}
      />
      <small>
        {transcript.length}/{MAX_EQUATION_TRANSCRIPT_LENGTH} characters · bound
        to this relationship, source crop, and source lineage
      </small>
      <button type="submit" disabled={transcript.trim().length === 0}>
        Accept exact LaTeX transcript
      </button>
    </form>
  )
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
  const contexts = lineJoinAdjudicationItems(baseResult)
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

export function lineJoinAdjudicationItems(
  result: Pick<PdfReconstruction, 'lineBoundaryDecisions' | 'regions'>,
) {
  return result.lineBoundaryDecisions.flatMap((transition) => {
    if (
      transition.outcome !== 'unresolved' &&
      transition.outcome !== 'ambiguous'
    ) {
      return []
    }
    const region = result.regions.find(
      (candidate) => candidate.id === transition.regionId,
    )
    const context = region
      ? buildPdfLineJoinReviewContext(region, transition)
      : null
    return context ? [{ context, transition }] : []
  })
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
              <strong>{diagnosticCopy(item.diagnostic.code).title}</strong>
              <span>
                {
                  diagnosticCopy(item.diagnostic.code, item.diagnostic.message)
                    .message
                }
              </span>
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

const STALE_MODULE_RELOAD_KEY = 'srt:stale-module-reload-signature'
const STALE_MODULE_MESSAGE =
  'The converter changed while this tab was open. Reload the studio once, then choose the same paper again.'

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : ''
}

function isStaleApplicationModuleError(error: unknown) {
  const message = errorMessage(error)
  return /(?:failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|outdated optimize dep)/iu.test(
    message,
  )
}

function staleApplicationModuleSignature(error: unknown) {
  if (!isStaleApplicationModuleError(error)) return undefined
  const message = errorMessage(error)
    .trim()
    .replaceAll(/\s+/gu, ' ')
    .toLocaleLowerCase()
  return message || undefined
}

export function shouldReloadStaleApplicationModule(
  error: unknown,
  previousReloadSignature?: string,
) {
  const signature = staleApplicationModuleSignature(error)
  const previous = previousReloadSignature
    ?.trim()
    .replaceAll(/\s+/gu, ' ')
    .toLocaleLowerCase()
  return Boolean(signature && signature !== previous)
}

export function importErrorCode(error: unknown) {
  if (isStaleApplicationModuleError(error)) return 'STALE_APPLICATION_MODULE'
  return error instanceof PdfImportError || error instanceof DocxImportError
    ? error.code
    : 'UNEXPECTED_ERROR'
}

export function importErrorMessage(error: unknown) {
  if (isStaleApplicationModuleError(error)) return STALE_MODULE_MESSAGE
  return error instanceof Error
    ? error.message
    : 'The local conversion failed unexpectedly.'
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
  initialPaperUrl,
  onReviewSnapshot,
  reviewMode = false,
}: {
  showIntro?: boolean
  initialPaperUrl?: string
  onReviewSnapshot?: (snapshot: PublicationReviewSnapshot) => void
  reviewMode?: boolean
}) {
  const [state, setState] = useState<StudioState>({ status: 'idle' })
  const [isHydrated, setIsHydrated] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [paperUrl, setPaperUrl] = useState('')
  const [ocrLanguage, setOcrLanguage] = useState<'auto' | 'eng'>('auto')
  const [selectedProfileId, setSelectedProfileId] =
    useState<PreviewProfileId>('mobile')
  const [selectedOrientation, setSelectedOrientation] =
    useState<TargetOrientation>('portrait')
  const [previewReadyArtifactKey, setPreviewReadyArtifactKey] =
    useState<string>()
  const [profileBuilds, setProfileBuilds] = useState<ActiveProfileBuild[]>([])
  const [profileBuildIssues, setProfileBuildIssues] =
    useState<ProfileBuildIssues>({})
  const [profileBuildMessage, setProfileBuildMessage] = useState('')
  const [profileBuildStageHistory, setProfileBuildStageHistory] = useState<
    string[]
  >([])
  const [pendingDecisionFile, setPendingDecisionFile] =
    useState<HumanDecisionFile>()
  const [decisionError, setDecisionError] = useState<string>()
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const decisionInput = useRef<HTMLInputElement>(null)
  const activeImport = useRef<AbortController>()
  const autoImportedUrl = useRef<string>()
  const activeProfileBuilds = useRef(new Set<ActiveProfileBuild>())
  const activeProfileBuildIssues = useRef<ProfileBuildIssues>({})
  const processingStartedAt = useRef(0)

  const reloadForStaleApplicationModule = (error: unknown) => {
    if (typeof window === 'undefined') return false
    const signature = staleApplicationModuleSignature(error)
    if (!signature) return false
    let previousReloadSignature: string | undefined
    try {
      previousReloadSignature =
        window.sessionStorage.getItem(STALE_MODULE_RELOAD_KEY) ?? undefined
    } catch {
      previousReloadSignature = undefined
    }
    if (!shouldReloadStaleApplicationModule(error, previousReloadSignature)) {
      return false
    }
    try {
      window.sessionStorage.setItem(STALE_MODULE_RELOAD_KEY, signature)
    } catch {
      // A blocked session store must not prevent the one safe recovery reload.
    }
    window.location.reload()
    return true
  }

  useEffect(() => {
    setIsHydrated(true)
    return () => {
      activeImport.current?.abort()
      activeProfileBuilds.current.clear()
      activeProfileBuildIssues.current = {}
    }
  }, [])

  const showError = (error: unknown) => {
    setState({
      status: 'error',
      code: importErrorCode(error),
      message: importErrorMessage(error),
    })
  }

  const nextImport = () => {
    activeImport.current?.abort()
    for (const build of activeProfileBuilds.current) {
      activeProfileBuilds.current.delete(build)
    }
    setProfileBuilds([])
    setProfileBuildMessage('')
    setProfileBuildStageHistory([])
    activeProfileBuildIssues.current = {}
    setProfileBuildIssues({})
    const controller = new AbortController()
    activeImport.current = controller
    return controller
  }

  useEffect(() => {
    if (state.status !== 'processing') {
      setElapsedSeconds(0)
      return
    }
    const updateElapsed = () =>
      setElapsedSeconds(
        Math.max(
          0,
          Math.floor((Date.now() - processingStartedAt.current) / 1000),
        ),
      )
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 1000)
    return () => window.clearInterval(timer)
  }, [state.status])

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
    setState({
      status: result.readiness.ready ? 'ready' : 'review-required',
      ...completed,
    })
  }

  const processFile = async (file?: File, controller = nextImport()) => {
    if (!file) return
    const isCurrent = () =>
      activeImport.current === controller && !controller.signal.aborted
    setSelectedProfileId('mobile')
    setSelectedOrientation('portrait')
    setPreviewReadyArtifactKey(undefined)
    setProfileBuildIssues({})
    if (processingStartedAt.current === 0)
      processingStartedAt.current = Date.now()
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
          await import('../../research/publication-worker-client')
        ).reconstructPdfInWorker(file, onProgress, {
          signal: controller.signal,
          ocrLanguage,
        })
        decisionFile =
          pendingDecisionFile ??
          createHumanDecisionFile(baseResult.source.sha256)
        setPendingDecisionFile(decisionFile)
        result = applyHumanDecisionFile(baseResult, decisionFile, {
          emptyFilePolicy: 'reuse-fresh-assessment',
        })
      }
      if (!isCurrent()) return
      await finishReconstruction({
        result,
        sourceFile: file,
        controller,
        baseResult,
        decisionFile,
      })
      processingStartedAt.current = 0
    } catch (error) {
      if (activeImport.current !== controller) return
      if (importWasCancelled(error)) return
      if (reloadForStaleApplicationModule(error)) return
      showError(error)
      processingStartedAt.current = 0
    }
  }

  const processPaperUrl = async (url: string) => {
    const controller = nextImport()
    processingStartedAt.current = Date.now()
    setState({
      status: 'processing',
      fileName: url,
      progress: { ...initialProgress, message: 'Downloading the linked PDF…' },
    })
    try {
      await processFile(
        await downloadLinkedPdf(url, fetch, undefined, controller.signal),
        controller,
      )
    } catch (error) {
      if (activeImport.current !== controller) return
      if (importWasCancelled(error)) return
      if (reloadForStaleApplicationModule(error)) return
      showError(error)
      processingStartedAt.current = 0
    }
  }

  const processUrl = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await processPaperUrl(paperUrl)
  }

  useEffect(() => {
    if (
      !isHydrated ||
      !initialPaperUrl ||
      autoImportedUrl.current === initialPaperUrl
    ) {
      return
    }
    autoImportedUrl.current = initialPaperUrl
    setPaperUrl(initialPaperUrl)
    void processPaperUrl(initialPaperUrl)
  }, [initialPaperUrl, isHydrated])

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    void processFile(event.dataTransfer.files[0])
  }

  const reset = () => {
    activeImport.current?.abort()
    activeImport.current = undefined
    processingStartedAt.current = 0
    if (input.current) input.current.value = ''
    if (decisionInput.current) decisionInput.current.value = ''
    setPaperUrl('')
    setPendingDecisionFile(undefined)
    setDecisionError(undefined)
    setSelectedProfileId('mobile')
    setSelectedOrientation('portrait')
    setPreviewReadyArtifactKey(undefined)
    setProfileBuilds([])
    activeProfileBuildIssues.current = {}
    setProfileBuildIssues({})
    setState({ status: 'idle' })
  }

  const cancelImport = () => {
    activeImport.current?.abort()
    activeImport.current = undefined
    processingStartedAt.current = 0
    setState({
      status: 'error',
      code: 'IMPORT_CANCELLED',
      message: 'No output was saved. You can retry this paper when ready.',
    })
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

  useEffect(() => {
    if (state.status !== 'ready' && state.status !== 'review-required') return
    const controller = activeImport.current
    if (
      !controller ||
      controller.signal.aborted ||
      activeProfileBuilds.current.size > 0
    ) {
      return
    }
    if (
      state.epubs &&
      selectCurrentProfileEpub(
        state.epubs,
        selectedProfileId,
        selectedOrientation,
      )
    ) {
      return
    }
    if (
      (activeProfileBuildIssues.current[selectedProfileId]?.controller ===
        controller &&
        activeProfileBuildIssues.current[selectedProfileId]?.orientation ===
          selectedOrientation) ||
      (profileBuildIssues[selectedProfileId]?.controller === controller &&
        profileBuildIssues[selectedProfileId]?.orientation ===
          selectedOrientation)
    ) {
      return
    }
    if (!state.result.readiness.ready && !isPdfReconstruction(state.result)) {
      return
    }

    const result = state.result
    const profileId = selectedProfileId
    const orientation = selectedOrientation
    const isCurrent = () =>
      activeImport.current === controller && !controller.signal.aborted
    const activeBuild: ActiveProfileBuild = {
      controller,
      profileId,
      orientation,
    }
    activeProfileBuilds.current.add(activeBuild)
    setProfileBuilds((current) => [...current, activeBuild])
    setProfileBuildStageHistory([])
    setProfileBuildIssues((current) => {
      if (!current[profileId]) return current
      const next = { ...current }
      delete next[profileId]
      return next
    })
    void Promise.resolve().then(async () => {
      try {
        const profile = resolveTargetProfile(profileId, orientation)
        const epub =
          result.readiness.ready || isPdfReconstruction(result)
            ? await (
                await import('../../research/publication-worker-client')
              ).buildEpubInWorker(
                result,
                profile,
                result.readiness.ready ? 'publication' : 'readable-fallback',
                {
                  signal: controller.signal,
                  onProgress: (progress) => {
                    if (!isCurrent()) return
                    setProfileBuildMessage(progress.message)
                    setProfileBuildStageHistory((current) =>
                      current.at(-1) === progress.message
                        ? current
                        : [...current, progress.message],
                    )
                  },
                },
              )
            : undefined
        if (!epub) return
        if (!isCurrent()) return
        setState((current) => {
          if (
            (current.status !== 'ready' &&
              current.status !== 'review-required') ||
            current.result !== result
          ) {
            return current
          }
          const epubs = current.epubs ?? []
          if (selectCurrentProfileEpub(epubs, profileId, orientation))
            return current
          return { ...current, epubs: [...epubs, epub] }
        })
      } catch (error) {
        if (!isCurrent()) return
        const issue = {
          controller,
          profileId,
          orientation,
          message:
            error instanceof Error
              ? error.message
              : result.readiness.ready
                ? 'The local EPUB build failed unexpectedly.'
                : 'The readable EPUB is unavailable until review is complete.',
        }
        activeProfileBuildIssues.current[profileId] = issue
        setProfileBuildIssues((current) => ({
          ...current,
          [profileId]: issue,
        }))
      } finally {
        if (activeProfileBuilds.current.delete(activeBuild)) {
          setProfileBuilds((current) =>
            current.filter((build) => build !== activeBuild),
          )
        }
        if (isCurrent()) setProfileBuildMessage('')
      }
    })
  }, [
    profileBuildIssues,
    profileBuilds,
    selectedOrientation,
    selectedProfileId,
    state,
  ])

  const progressPercent =
    state.status === 'processing'
      ? Math.round(
          (state.progress.completed / Math.max(state.progress.total, 1)) * 100,
        )
      : 0
  const progressIsIndeterminate =
    state.status === 'processing' &&
    importProgressIsIndeterminate(state.progress)
  const selectedEpub =
    (state.status === 'ready' || state.status === 'review-required') &&
    state.epubs
      ? selectCurrentProfileEpub(
          state.epubs,
          selectedProfileId,
          selectedOrientation,
        )
      : undefined
  const selectedEpubPreviewReady = selectedEpub
    ? isSelectedEpubPreviewReady(selectedEpub, previewReadyArtifactKey)
    : false
  const buildingProfileId = profileBuilds.find(
    (build) =>
      build.controller === activeImport.current &&
      build.profileId === selectedProfileId &&
      build.orientation === selectedOrientation,
  )?.profileId
  const selectedIssue = profileBuildIssues[selectedProfileId]
  const selectedProfileBuildIssue =
    selectedIssue?.controller === activeImport.current &&
    selectedIssue?.orientation === selectedOrientation
      ? selectedIssue
      : undefined
  const retrySelectedProfileBuild = () => {
    const issue = activeProfileBuildIssues.current[selectedProfileId]
    if (
      !issue ||
      issue.controller !== activeImport.current ||
      issue.orientation !== selectedOrientation
    )
      return
    delete activeProfileBuildIssues.current[selectedProfileId]
    setProfileBuildIssues((current) => {
      const next = { ...current }
      delete next[selectedProfileId]
      return next
    })
  }

  const reviewSnapshot = useMemo<PublicationReviewSnapshot | undefined>(() => {
    if (state.status !== 'ready' && state.status !== 'review-required') {
      return undefined
    }
    return {
      source: {
        fileName: state.result.source.fileName,
        sha256: state.result.source.sha256,
        byteLength: state.result.source.byteLength,
        pageCount:
          state.result.source.format === 'docx'
            ? 0
            : state.result.source.pageCount,
      },
      readiness: {
        status: state.status,
        blockingDiagnosticCodes: [
          ...state.result.readiness.blockingDiagnosticCodes,
        ],
      },
      completeness: {
        textCoverage: state.result.completeness.textCoverage,
        assetCoverage: state.result.completeness.assetCoverage,
        relationshipCoverage: state.result.completeness.relationshipCoverage,
        unresolvedObjectCount: state.result.completeness.unresolvedObjectCount,
        ocrRequiredPages: [...state.result.completeness.ocrRequiredPages],
        readingOrderDiagnostics:
          state.result.completeness.readingOrderDiagnostics,
      },
      diagnostics: state.result.diagnostics.map(({ code, severity, page }) => ({
        code,
        severity,
        ...(page === undefined ? {} : { page }),
      })),
      ...(selectedEpub?.profile
        ? {
            epub: {
              sha256: selectedEpub.sha256,
              mode: selectedEpub.mode,
              profileId: selectedEpub.profile.id as PreviewProfileId,
              profileVersion: selectedEpub.profile.version,
            },
          }
        : {}),
    }
  }, [selectedEpub, state])

  const userRecovery = useMemo(() => {
    if (state.status !== 'ready' && state.status !== 'review-required') {
      return undefined
    }
    return recoverySummary({
      ready: state.result.readiness.ready,
      diagnostics: state.result.diagnostics,
      blockingCodes: state.result.readiness.blockingDiagnosticCodes,
      textCoverage: state.result.completeness.textCoverage,
      assetCoverage: state.result.completeness.assetCoverage,
      relationshipCoverage: state.result.completeness.relationshipCoverage,
      unresolvedObjectCount: state.result.completeness.unresolvedObjectCount,
    })
  }, [state])

  useEffect(() => {
    if (reviewSnapshot) onReviewSnapshot?.(reviewSnapshot)
  }, [onReviewSnapshot, reviewSnapshot])

  return (
    <section
      className={[
        'publication-importer',
        reviewMode ? 'publication-importer--review' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-conversion-status={state.status}
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

      {reviewMode && (
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
              {pendingDecisionFile.decisions.length} decisions · approval
              SHA-256{' '}
              <code>{humanDecisionFileSha256(pendingDecisionFile)}</code>
            </small>
          )}
          {decisionError && <p role="alert">{decisionError}</p>}
        </div>
      )}

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
                <small>Up to 50 MiB. Your file stays on this device.</small>
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
            <small>
              {progressIsIndeterminate
                ? 'This stage has no reliable percentage.'
                : `${progressPercent}% complete`}
              {' · '}
              {formatImportElapsed(elapsedSeconds)}
            </small>
          </div>
          {progressIsIndeterminate ? (
            <progress aria-label={state.progress.message} />
          ) : (
            <progress max={100} value={progressPercent}>
              {progressPercent}%
            </progress>
          )}
          <button type="button" onClick={cancelImport}>
            Cancel conversion
          </button>
        </div>
      )}

      {state.status === 'error' && (
        <div className="publication-failure" role="alert">
          <span>{state.code.replaceAll('_', ' ')}</span>
          <h3>
            {state.code === 'IMPORT_CANCELLED'
              ? 'Conversion stopped.'
              : "I couldn't turn that paper into an EPUB."}
          </h3>
          <p>{state.message}</p>
          {reviewMode && initialPaperUrl ? (
            <button onClick={() => void processPaperUrl(initialPaperUrl)}>
              Retry conversion
            </button>
          ) : (
            <button onClick={reset}>Choose another paper</button>
          )}
        </div>
      )}

      {(state.status === 'ready' || state.status === 'review-required') && (
        <>
          {!reviewMode && (
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
              </div>
              <div className="publication-actions">
                {reviewMode && state.decisionFile && (
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
                  <EpubDownloadLink
                    key={selectedEpub.sha256}
                    epub={selectedEpub}
                  >
                    {epubDownloadLabel(selectedEpub)}
                  </EpubDownloadLink>
                ) : selectedEpub ? (
                  <span aria-live="polite">
                    Preparing selected EPUB preview…
                  </span>
                ) : buildingProfileId === selectedProfileId ? (
                  <span aria-live="polite">
                    {profileBuildMessage ||
                      `Building ${getTargetProfile(selectedProfileId).label} EPUB locally…`}
                  </span>
                ) : selectedProfileBuildIssue ? (
                  <>
                    <span role="alert">
                      {selectedProfileBuildIssue.message}
                    </span>
                    <button
                      className="secondary"
                      type="button"
                      onClick={retrySelectedProfileBuild}
                    >
                      Retry {getTargetProfile(selectedProfileId).label} EPUB
                    </button>
                  </>
                ) : state.status === 'ready' ? (
                  <span aria-live="polite">Validating EPUB…</span>
                ) : null}
                <button className="secondary" onClick={reset}>
                  New paper
                </button>
              </div>
            </div>
          )}

          {profileBuildStageHistory.length > 0 && (
            <output
              className="publication-build-stage-history sr-only"
              aria-label="Completed EPUB build stages"
            >
              EPUB build stages: {profileBuildStageHistory.join(' · ')}
            </output>
          )}

          {!reviewMode && state.status === 'review-required' && (
            <div className="publication-ocr-gate" role="alert">
              <span>Review summary</span>
              <h3>
                {userRecovery?.title ??
                  'Your readable EPUB is ready for review.'}
              </h3>
              <p>{userRecovery?.summary}</p>
              {userRecovery && userRecovery.issues.length > 0 && (
                <ul
                  className="publication-blocking-issues"
                  aria-label="Review items"
                >
                  {userRecovery.issues.map((issue) => (
                    <li key={issue.category}>
                      <strong>{issue.title}</strong>
                      <span>{issue.count}</span>
                      {issue.action && <small>{issue.action}</small>}
                    </li>
                  ))}
                </ul>
              )}
              {userRecovery?.userAction && (
                <p>
                  <strong>What to do:</strong> {userRecovery.userAction}
                </p>
              )}
            </div>
          )}

          {state.epubs?.[0] && (
            <EpubRenditionPreview
              epubs={state.epubs}
              selectedProfileId={selectedProfileId}
              selectedOrientation={selectedOrientation}
              buildingProfileId={buildingProfileId}
              onSelectedProfileChange={(profileId) => {
                if (profileId === selectedProfileId) return
                setPreviewReadyArtifactKey(undefined)
                setSelectedProfileId(profileId)
                if (
                  !getTargetProfile(profileId).orientation.supported.includes(
                    selectedOrientation,
                  )
                ) {
                  setSelectedOrientation('portrait')
                }
              }}
              onSelectedOrientationChange={(orientation) => {
                if (orientation === selectedOrientation) return
                setPreviewReadyArtifactKey(undefined)
                setSelectedOrientation(orientation)
              }}
              onPreviewReadyChange={setPreviewReadyArtifactKey}
              reviewMode={reviewMode}
            />
          )}

          {!reviewMode && (
            <details className="publication-diagnostics">
              <summary>
                Conversion details · {state.result.diagnostics.length}{' '}
                {state.result.diagnostics.length === 1 ? 'note' : 'notes'}
              </summary>
              <div className="publication-diagnostic-grid">
                <div>
                  <h3>
                    {state.result.source.format === 'docx'
                      ? 'Package'
                      : 'Pages'}
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
                        {Math.round(
                          state.result.completeness.textCoverage * 100,
                        )}
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
                        {state.result.completeness.sourceAssetCount} source
                        visual objects
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
                        {state.result.completeness.ocrRequiredPages.join(
                          ', ',
                        ) || 'none'}
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
                        <strong>{diagnosticCopy(diagnostic.code).title}</strong>{' '}
                        {
                          diagnosticCopy(diagnostic.code, diagnostic.message)
                            .message
                        }
                        {diagnosticCopy(diagnostic.code).action && (
                          <small>
                            {' '}
                            {diagnosticCopy(diagnostic.code).action}
                          </small>
                        )}
                      </li>
                    ))}
                  </ul>
                ))}
            </details>
          )}
        </>
      )}
    </section>
  )
}

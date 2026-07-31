import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  submitPdfReviewFeedback,
  type PdfReviewFeedbackEvent,
} from '../../lib/pdf-review-feedback'
import PublicationImporter, {
  type PublicationReviewSnapshot,
} from './PublicationImporter'
import SourcePdfPageViewer from './SourcePdfPageViewer'
import './PdfEpubReviewQueue.css'

export type PdfReviewSample = {
  id: string
  setId: string
  corpusGroup?: 'frozen' | 'seeded-random'
  sha256: string
  byteLength: number
  sourceUrl: string
  reviewTier?: 'standard' | 'stress'
  pageCountHint?: number
}

export type PdfReviewVerdict = 'pass' | 'fail' | 'defer'
export type PdfReviewSeverity = 'minor' | 'major' | 'critical'

export const PDF_REVIEW_CRITERIA = [
  {
    id: 'content-flow',
    label: 'Compare the text',
    question:
      'Read the same passage in both panes. Does the EPUB contain the same words in the same order?',
    pass: 'The wording and order match.',
    fail: 'Text is missing, repeated, moved, or broken—for example, “histori- cal” instead of “historical”.',
  },
  {
    id: 'front-matter',
    label: 'Compare the title page',
    question:
      'Compare the title, every author, affiliation numbers, abstract, and keywords.',
    pass: 'Every item is present and attached to the correct person.',
    fail: 'Anything is missing, merged, duplicated, or assigned to the wrong person.',
  },
  {
    id: 'code-structure',
    label: 'Compare code',
    question:
      'Find each code or pseudocode block in the PDF and EPUB. Are its lines, indentation, and symbols preserved?',
    pass: 'The code structure matches, or the paper has no code.',
    fail: 'Code became prose, lost line breaks or indentation, or contains damaged identifiers.',
  },
  {
    id: 'visual-completeness',
    label: 'Compare visuals',
    question: 'Find every figure, table, diagram, and equation in both panes.',
    pass: 'Every visual is present, readable, and has the correct caption.',
    fail: 'A visual is missing, unreadable, duplicated, cropped, or paired with the wrong caption.',
  },
  {
    id: 'reference-navigation',
    label: 'Test links',
    question:
      'Click at least one citation such as [1] and one figure, table, or section link when available.',
    pass: 'Each click visibly jumps to the matching target.',
    fail: 'Nothing happens, the wrong target opens, or the target cannot be identified.',
  },
  {
    id: 'typography-readability',
    label: 'Change reader settings',
    question:
      'Try another device, orientation, font size, and font family. Does all content remain inside the page?',
    pass: 'Text remains readable without clipping or horizontal scrolling.',
    fail: 'Content clips, overflows, becomes unusably large or small, or needs horizontal scrolling.',
  },
  {
    id: 'unexpected',
    label: 'Anything else',
    question:
      'Did you see another visible difference that the earlier checks did not cover?',
    pass: 'No other difference was found.',
    fail: 'Another difference exists; record where it appears and what should have appeared instead.',
  },
] as const

export type PdfReviewCriterionId = (typeof PDF_REVIEW_CRITERIA)[number]['id']

export type PdfCriterionReview = {
  verdict?: PdfReviewVerdict
  severity?: PdfReviewSeverity
  location: string
  notes: string
  updatedAt?: string
}

export type PdfReviewAnnotation = {
  criteria: Partial<Record<PdfReviewCriterionId, PdfCriterionReview>>
  snapshot?: PublicationReviewSnapshot
}

export type PdfReviewStore = {
  schemaVersion: 2
  corpusId: string
  reviewer: string
  annotations: Record<string, PdfReviewAnnotation>
}

type UndoEntry = {
  sampleId: string
  previous?: PdfReviewAnnotation
}

export const PDF_REVIEW_SCHEMA_VERSION = 2

export function reviewSampleGroupLabel(sample: PdfReviewSample) {
  return sample.corpusGroup === 'seeded-random'
    ? 'Random discovery set'
    : 'Regression set'
}

export function reviewWorkloadLabel(sample: PdfReviewSample) {
  return sample.reviewTier === 'stress'
    ? 'Large-document performance test'
    : 'Standard'
}

export function automatedReviewLabel(annotation?: PdfReviewAnnotation) {
  if (!annotation?.snapshot) return 'Not run'
  return annotation.snapshot.readiness.status === 'review-required' &&
    annotation.snapshot.readiness.blockingDiagnosticCodes.length > 0
    ? 'Blocked'
    : 'Passed'
}

export function humanReviewLabel(annotation?: PdfReviewAnnotation) {
  const reviews = PDF_REVIEW_CRITERIA.map(({ id }) => annotation?.criteria[id])
  if (reviews.some((review) => review?.verdict === 'fail')) return 'Failed'
  if (reviews.some((review) => review?.verdict === 'defer')) return 'Deferred'
  const completed = reviews.filter(criterionReviewComplete).length
  if (completed === PDF_REVIEW_CRITERIA.length) return 'Passed'
  return completed === 0
    ? 'Not started'
    : `${completed} of ${PDF_REVIEW_CRITERIA.length} checks completed`
}

export function randomReviewSampleIndex({
  samples,
  group,
  currentIndex,
  randomValue,
}: {
  samples: PdfReviewSample[]
  group: 'mixed' | 'seeded-random'
  currentIndex: number
  randomValue: number
}) {
  const eligible = samples
    .map((sample, index) => ({ sample, index }))
    .filter(
      ({ sample }) =>
        sample.reviewTier !== 'stress' &&
        (group === 'mixed' || sample.corpusGroup === 'seeded-random'),
    )
  const alternatives = eligible.filter(({ index }) => index !== currentIndex)
  const candidates = alternatives.length > 0 ? alternatives : eligible
  if (candidates.length === 0) return currentIndex
  const normalized = Number.isFinite(randomValue)
    ? Math.min(1 - Number.EPSILON, Math.max(0, randomValue))
    : 0
  return candidates[Math.floor(normalized * candidates.length)].index
}

const blockingDiagnosticLabels: Record<string, string> = {
  CANONICAL_FLOW_ORDER_VIOLATION: 'reading order',
  UNRESOLVED_CORRUPTING_JOIN: 'damaged text joins',
  UNREFERENCED_VISUAL_ASSET: 'unlinked figures or diagrams',
  UNRESOLVED_VISUAL_OBJECT: 'unresolved figures or diagrams',
  UNRESOLVED_SEMANTIC_OBJECTS: 'missing or unresolved visual content',
  INCOMPLETE_SEMANTIC_TABLE_COVERAGE: 'tables rendered only as images',
  UNRESOLVED_EQUATION_TRANSCRIPT: 'unresolved equations',
  UNRESOLVED_SCHOLARLY_CROSS_REFERENCE: 'broken citations or cross-references',
}

export function humanizeBlockingDiagnostics(codes: string[]) {
  return [...new Set(codes)].map(
    (code) =>
      blockingDiagnosticLabels[code] ??
      code.replaceAll('_', ' ').toLocaleLowerCase(),
  )
}

export function pdfReviewStorageKey(corpusId: string) {
  return `srt:pdf-epub-review:${corpusId}:v${PDF_REVIEW_SCHEMA_VERSION}`
}

function emptyStore(corpusId: string): PdfReviewStore {
  return {
    schemaVersion: PDF_REVIEW_SCHEMA_VERSION,
    corpusId,
    reviewer: '',
    annotations: {},
  }
}

function emptyCriterionReview(): PdfCriterionReview {
  return { location: '', notes: '' }
}

function validVerdict(value: unknown): value is PdfReviewVerdict {
  return value === 'pass' || value === 'fail' || value === 'defer'
}

function validSeverity(value: unknown): value is PdfReviewSeverity {
  return value === 'minor' || value === 'major' || value === 'critical'
}

function validCriterionId(value: string): value is PdfReviewCriterionId {
  return PDF_REVIEW_CRITERIA.some(({ id }) => id === value)
}

function parseCriterionReview(value: unknown): PdfCriterionReview | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<PdfCriterionReview>
  if (
    typeof candidate.location !== 'string' ||
    candidate.location.length > 500 ||
    typeof candidate.notes !== 'string' ||
    candidate.notes.length > 20_000 ||
    (candidate.verdict !== undefined && !validVerdict(candidate.verdict)) ||
    (candidate.severity !== undefined && !validSeverity(candidate.severity)) ||
    (candidate.updatedAt !== undefined &&
      (typeof candidate.updatedAt !== 'string' ||
        candidate.updatedAt.length > 100))
  ) {
    return null
  }
  return {
    location: candidate.location,
    notes: candidate.notes,
    ...(candidate.verdict ? { verdict: candidate.verdict } : {}),
    ...(candidate.severity ? { severity: candidate.severity } : {}),
    ...(candidate.updatedAt ? { updatedAt: candidate.updatedAt } : {}),
  }
}

export function parsePdfReviewStore(
  value: string | null,
  corpusId: string,
): PdfReviewStore {
  if (!value || value.length > 2_000_000) return emptyStore(corpusId)
  try {
    const parsed = JSON.parse(value) as Partial<PdfReviewStore>
    if (
      parsed.schemaVersion !== PDF_REVIEW_SCHEMA_VERSION ||
      parsed.corpusId !== corpusId ||
      typeof parsed.reviewer !== 'string' ||
      parsed.reviewer.length > 200 ||
      !parsed.annotations ||
      typeof parsed.annotations !== 'object' ||
      Array.isArray(parsed.annotations)
    ) {
      return emptyStore(corpusId)
    }
    const annotations = Object.fromEntries(
      Object.entries(parsed.annotations).flatMap(([sampleId, annotation]) => {
        if (
          !annotation ||
          typeof annotation !== 'object' ||
          Array.isArray(annotation)
        ) {
          return []
        }
        const candidate = annotation as Partial<PdfReviewAnnotation>
        if (
          !candidate.criteria ||
          typeof candidate.criteria !== 'object' ||
          Array.isArray(candidate.criteria)
        ) {
          return []
        }
        const criteria = Object.fromEntries(
          Object.entries(candidate.criteria).flatMap(
            ([criterionId, review]) => {
              const parsedReview = parseCriterionReview(review)
              return validCriterionId(criterionId) && parsedReview
                ? [[criterionId, parsedReview]]
                : []
            },
          ),
        ) as PdfReviewAnnotation['criteria']
        return [
          [
            sampleId,
            {
              criteria,
              ...(candidate.snapshot ? { snapshot: candidate.snapshot } : {}),
            },
          ],
        ]
      }),
    )
    return {
      schemaVersion: PDF_REVIEW_SCHEMA_VERSION,
      corpusId,
      reviewer: parsed.reviewer,
      annotations,
    }
  } catch {
    return emptyStore(corpusId)
  }
}

export function criterionReviewComplete(review?: PdfCriterionReview) {
  if (!review?.verdict) return false
  if (review.verdict === 'pass') return true
  if (!review.notes.trim()) return false
  return review.verdict === 'defer'
    ? true
    : Boolean(review.severity && review.location.trim())
}

export function paperHumanReviewComplete(annotation?: PdfReviewAnnotation) {
  return PDF_REVIEW_CRITERIA.every(({ id }) =>
    criterionReviewComplete(annotation?.criteria[id]),
  )
}

function paperDisposition(annotation?: PdfReviewAnnotation) {
  const reviews = PDF_REVIEW_CRITERIA.map(({ id }) => annotation?.criteria[id])
  const machineBlocked =
    annotation?.snapshot?.readiness.status === 'review-required' &&
    annotation.snapshot.readiness.blockingDiagnosticCodes.length > 0
  if (machineBlocked) return 'machine-fail' as const
  if (reviews.some((review) => review?.verdict === 'fail'))
    return 'human-fail' as const
  if (reviews.some((review) => review?.verdict === 'defer'))
    return 'defer' as const
  if (reviews.every(criterionReviewComplete)) return 'pass' as const
  return 'incomplete' as const
}

export function buildPdfReviewReceipt({
  store,
  samples,
  generatedAt,
}: {
  store: PdfReviewStore
  samples: PdfReviewSample[]
  generatedAt: string
}) {
  const items = samples.map((sample) => {
    const annotation = store.annotations[sample.id]
    const sourceIdentityVerified =
      annotation?.snapshot?.source.sha256 === sample.sha256 &&
      annotation.snapshot.source.byteLength === sample.byteLength
    const criteria = Object.fromEntries(
      PDF_REVIEW_CRITERIA.map(({ id }) => [
        id,
        annotation?.criteria[id] ?? null,
      ]),
    )
    return {
      sample: {
        id: sample.id,
        setId: sample.setId,
        sampleSet: reviewSampleGroupLabel(sample),
        workload: reviewWorkloadLabel(sample),
        sourceUrl: sample.sourceUrl,
        expectedSha256: sample.sha256,
        expectedByteLength: sample.byteLength,
      },
      disposition: paperDisposition(annotation),
      status: {
        automatedConversionCheck: automatedReviewLabel(annotation),
        humanReview: humanReviewLabel(annotation),
      },
      humanReview: { criteria },
      machineReview: annotation?.snapshot
        ? {
            readiness: annotation.snapshot.readiness,
            completeness: annotation.snapshot.completeness,
            diagnostics: annotation.snapshot.diagnostics,
          }
        : null,
      observation: annotation?.snapshot ?? null,
      sourceIdentityVerified,
      outputIdentityRecorded: Boolean(annotation?.snapshot?.epub),
    }
  })
  const allCriteriaComplete = items.every((item) =>
    PDF_REVIEW_CRITERIA.every(({ id }) =>
      criterionReviewComplete(
        (item.humanReview.criteria[id] as PdfCriterionReview | null) ??
          undefined,
      ),
    ),
  )
  return {
    schemaVersion: PDF_REVIEW_SCHEMA_VERSION,
    kind: 'pdf-epub-human-review',
    authority: 'portable-hash-bound-receipt',
    telemetryRole: 'optional-non-authoritative-mirror',
    corpusId: store.corpusId,
    generatedAt,
    reviewer: store.reviewer || null,
    criteriaVersion: 1,
    criteria: PDF_REVIEW_CRITERIA,
    status:
      store.reviewer &&
      allCriteriaComplete &&
      items.every(
        ({ sourceIdentityVerified, outputIdentityRecorded }) =>
          sourceIdentityVerified && outputIdentityRecorded,
      )
        ? 'complete'
        : 'draft',
    summary: {
      total: samples.length,
      complete: items.filter((item) =>
        PDF_REVIEW_CRITERIA.every(({ id }) =>
          criterionReviewComplete(
            (item.humanReview.criteria[id] as PdfCriterionReview | null) ??
              undefined,
          ),
        ),
      ).length,
      pass: items.filter(({ disposition }) => disposition === 'pass').length,
      machineFail: items.filter(
        ({ status }) => status.automatedConversionCheck === 'Blocked',
      ).length,
      humanFail: items.filter(({ status }) => status.humanReview === 'Failed')
        .length,
      defer: items.filter(({ status }) => status.humanReview === 'Deferred')
        .length,
      incomplete: items.filter(({ status }) =>
        /^(?:Not started|\d+ of \d+ checks completed)$/u.test(
          status.humanReview,
        ),
      ).length,
      sourceIdentityVerified: items.filter(
        ({ sourceIdentityVerified }) => sourceIdentityVerified,
      ).length,
      outputIdentityRecorded: items.filter(
        ({ outputIdentityRecorded }) => outputIdentityRecorded,
      ).length,
      criterionFailures: Object.fromEntries(
        PDF_REVIEW_CRITERIA.map(({ id }) => [
          id,
          items.filter(
            (item) =>
              (item.humanReview.criteria[id] as PdfCriterionReview | null)
                ?.verdict === 'fail',
          ).length,
        ]),
      ),
    },
    items,
  }
}

function buildFeedbackEvent({
  corpusId,
  reviewer,
  sample,
  criterionId,
  review,
  snapshot,
}: {
  corpusId: string
  reviewer: string
  sample: PdfReviewSample
  criterionId: PdfReviewCriterionId
  review: PdfCriterionReview
  snapshot: PublicationReviewSnapshot
}): PdfReviewFeedbackEvent | null {
  if (!review.verdict || !snapshot.epub || !review.updatedAt) return null
  const identityVerified =
    snapshot.source.sha256 === sample.sha256 &&
    snapshot.source.byteLength === sample.byteLength
  return {
    schemaVersion: 1,
    eventId: [
      corpusId,
      sample.id,
      snapshot.epub.sha256,
      criterionId,
      review.updatedAt,
    ].join(':'),
    eventType: 'pdf-epub-criterion-reviewed',
    occurredAt: review.updatedAt,
    corpusId,
    sampleId: sample.id,
    setId: sample.setId,
    reviewer: reviewer.trim() || null,
    criterionId,
    verdict: review.verdict,
    severity: review.severity ?? null,
    location: review.location.trim(),
    notes: review.notes.trim(),
    source: {
      expectedSha256: sample.sha256,
      observedSha256: snapshot.source.sha256,
      identityVerified,
    },
    epub: snapshot.epub,
    machine: {
      readiness: snapshot.readiness.status,
      blockingDiagnosticCodes: snapshot.readiness.blockingDiagnosticCodes,
      diagnosticCodes: snapshot.diagnostics.map(({ code }) => code),
    },
  }
}

export default function PdfEpubReviewQueue({
  corpusId,
  samples,
}: {
  corpusId: string
  samples: PdfReviewSample[]
}) {
  const [index, setIndex] = useState(0)
  const [criterionIndex, setCriterionIndex] = useState(0)
  const [store, setStore] = useState(() => emptyStore(corpusId))
  const [loaded, setLoaded] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [sinkMessage, setSinkMessage] = useState('')
  const [activeStressSampleId, setActiveStressSampleId] = useState<string>()
  const undoStack = useRef<UndoEntry[]>([])
  const sample = samples[index]
  const criterion = PDF_REVIEW_CRITERIA[criterionIndex]
  const annotation = sample
    ? (store.annotations[sample.id] ?? { criteria: {} })
    : { criteria: {} }
  const review = annotation.criteria[criterion.id] ?? emptyCriterionReview()
  const sinkUrl = import.meta.env.PUBLIC_PDF_REVIEW_SINK_URL?.trim() ?? ''

  useEffect(() => {
    setStore(
      parsePdfReviewStore(
        window.localStorage.getItem(pdfReviewStorageKey(corpusId)),
        corpusId,
      ),
    )
    setLoaded(true)
  }, [corpusId])

  useEffect(() => {
    if (!loaded) return
    window.localStorage.setItem(
      pdfReviewStorageKey(corpusId),
      JSON.stringify(store),
    )
    setSaveMessage('Saved in this browser')
  }, [corpusId, loaded, store])

  useEffect(() => {
    if (
      !loaded ||
      !sinkUrl ||
      !sample ||
      !annotation.snapshot ||
      !review.verdict
    ) {
      return
    }
    const event = buildFeedbackEvent({
      corpusId,
      reviewer: store.reviewer,
      sample,
      criterionId: criterion.id,
      review,
      snapshot: annotation.snapshot,
    })
    if (!event) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void submitPdfReviewFeedback(event, sinkUrl, (input, init) =>
        fetch(input, { ...init, signal: controller.signal }),
      )
        .then(() => setSinkMessage('Feedback sink received this criterion'))
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          setSinkMessage(
            error instanceof Error
              ? `Local copy saved; feedback mirror failed: ${error.message}`
              : 'Local copy saved; feedback mirror failed.',
          )
        })
    }, 700)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [
    annotation.snapshot,
    corpusId,
    criterion.id,
    loaded,
    review,
    sample,
    sinkUrl,
    store.reviewer,
  ])

  const updateAnnotation = useCallback(
    (
      sampleId: string,
      update: (current: PdfReviewAnnotation) => PdfReviewAnnotation,
      recordUndo = false,
    ) => {
      setStore((current) => {
        const previous = current.annotations[sampleId]
        if (recordUndo) {
          undoStack.current.push({
            sampleId,
            ...(previous ? { previous: structuredClone(previous) } : {}),
          })
        }
        return {
          ...current,
          annotations: {
            ...current.annotations,
            [sampleId]: update(previous ?? { criteria: {} }),
          },
        }
      })
    },
    [],
  )

  const updateCriterion = useCallback(
    (
      update: (current: PdfCriterionReview) => PdfCriterionReview,
      recordUndo = false,
    ) => {
      if (!sample) return
      updateAnnotation(
        sample.id,
        (current) => ({
          ...current,
          criteria: {
            ...current.criteria,
            [criterion.id]: update(
              current.criteria[criterion.id] ?? emptyCriterionReview(),
            ),
          },
        }),
        recordUndo,
      )
    },
    [criterion.id, sample, updateAnnotation],
  )

  const setVerdict = useCallback(
    (verdict: PdfReviewVerdict) => {
      if (!annotation.snapshot?.epub) return
      updateCriterion((current) => {
        const { severity: _severity, ...withoutSeverity } = current
        return {
          ...(verdict === 'fail' ? current : withoutSeverity),
          verdict,
          updatedAt: new Date().toISOString(),
        }
      }, true)
    },
    [annotation.snapshot?.epub, updateCriterion],
  )

  const recordReviewSnapshot = useCallback(
    (snapshot: PublicationReviewSnapshot) => {
      if (!sample) return
      updateAnnotation(sample.id, (current) => ({ ...current, snapshot }))
    },
    [sample, updateAnnotation],
  )

  const undo = useCallback(() => {
    const entry = undoStack.current.pop()
    if (!entry) return
    setStore((current) => {
      const annotations = { ...current.annotations }
      if (entry.previous) annotations[entry.sampleId] = entry.previous
      else delete annotations[entry.sampleId]
      return { ...current, annotations }
    })
  }, [])

  const exportReceipt = useCallback(() => {
    const receipt = buildPdfReviewReceipt({
      store,
      samples,
      generatedAt: new Date().toISOString(),
    })
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(receipt, null, 2)}\n`], {
        type: 'application/json',
      }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `${corpusId}.review.json`
    link.hidden = true
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    setSaveMessage(
      receipt.status === 'complete'
        ? 'Complete hash-bound receipt exported'
        : 'Draft exported; criteria, reviewer, or artifact identities are incomplete',
    )
  }, [corpusId, samples, store])

  const selectRandomPaper = useCallback(
    (group: 'mixed' | 'seeded-random') => {
      const randomBytes = new Uint32Array(1)
      window.crypto.getRandomValues(randomBytes)
      const nextIndex = randomReviewSampleIndex({
        samples,
        group,
        currentIndex: index,
        randomValue: randomBytes[0] / 2 ** 32,
      })
      setIndex(nextIndex)
      setCriterionIndex(0)
      setActiveStressSampleId(undefined)
    },
    [index, samples],
  )

  const moveCriterion = useCallback(
    (offset: number) => {
      const next = criterionIndex + offset
      if (next < 0 && index > 0) {
        setIndex(index - 1)
        setCriterionIndex(PDF_REVIEW_CRITERIA.length - 1)
      } else if (
        next >= PDF_REVIEW_CRITERIA.length &&
        index < samples.length - 1
      ) {
        setIndex(index + 1)
        setCriterionIndex(0)
      } else {
        setCriterionIndex(
          Math.min(PDF_REVIEW_CRITERIA.length - 1, Math.max(0, next)),
        )
      }
    },
    [criterionIndex, index, samples.length],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLButtonElement
      ) {
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        exportReceipt()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        moveCriterion(1)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        moveCriterion(-1)
      } else if (event.key === '1') {
        event.preventDefault()
        setVerdict('pass')
      } else if (event.key === '2') {
        event.preventDefault()
        setVerdict('fail')
      } else if (event.key.toLowerCase() === 'd') {
        event.preventDefault()
        setVerdict('defer')
      } else if (event.key.toLowerCase() === 'u') {
        event.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [exportReceipt, moveCriterion, setVerdict, undo])

  const counts = useMemo(() => {
    const dispositions = samples.map(({ id }) =>
      paperDisposition(store.annotations[id]),
    )
    return {
      reviewed: samples.filter(({ id }) =>
        paperHumanReviewComplete(store.annotations[id]),
      ).length,
      needsFixes: dispositions.filter((value) => value.includes('fail')).length,
    }
  }, [samples, store.annotations])

  if (!sample) return <p role="alert">The review corpus is empty.</p>

  const sourceMatches =
    annotation.snapshot?.source.sha256 === sample.sha256 &&
    annotation.snapshot.source.byteLength === sample.byteLength
  const machineBlocked =
    annotation.snapshot?.readiness.status === 'review-required' &&
    annotation.snapshot.readiness.blockingDiagnosticCodes.length > 0
  const blockingDiagnosticNames = humanizeBlockingDiagnostics(
    annotation.snapshot?.readiness.blockingDiagnosticCodes ?? [],
  )

  return (
    <section className="pdf-review-queue" aria-label="PDF to EPUB review queue">
      <header className="pdf-review-toolbar">
        <div>
          <span className="pdf-review-kicker">Evidence-grounded review</span>
          <h2>
            Paper {index + 1}/{samples.length} · {sample.id}
          </h2>
          <dl className="pdf-review-progress-summary">
            <div>
              <dt>Papers fully reviewed</dt>
              <dd>
                {counts.reviewed} of {samples.length}
              </dd>
            </div>
            <div>
              <dt>Papers needing fixes</dt>
              <dd>{counts.needsFixes}</dd>
            </div>
            <div>
              <dt>Current check</dt>
              <dd>
                {criterionIndex + 1} of {PDF_REVIEW_CRITERIA.length}
              </dd>
            </div>
          </dl>
        </div>
        <div className="pdf-review-toolbar__controls">
          <label>
            Reviewer
            <input
              value={store.reviewer}
              maxLength={200}
              placeholder="Stable reviewer ID"
              onChange={(event) =>
                setStore((current) => ({
                  ...current,
                  reviewer: event.target.value,
                }))
              }
            />
          </label>
          <label>
            Paper
            <span
              id="pdf-review-selector-model"
              className="pdf-review-selector-model"
            >
              Each paper shows sample set, automated conversion check, and human
              review separately.
            </span>
            <select
              aria-describedby="pdf-review-selector-model"
              value={index}
              onChange={(event) => {
                setIndex(Number(event.target.value))
                setCriterionIndex(0)
                setActiveStressSampleId(undefined)
              }}
            >
              {samples.map((candidate, candidateIndex) => (
                <option key={candidate.id} value={candidateIndex}>
                  {candidateIndex + 1}. {candidate.id}
                  {' · '}
                  {reviewSampleGroupLabel(candidate)}
                  {' · Automated: '}
                  {automatedReviewLabel(store.annotations[candidate.id])}
                  {' · Human: '}
                  {humanReviewLabel(store.annotations[candidate.id])}
                </option>
              ))}
            </select>
          </label>
          <div
            className="pdf-review-random-actions"
            aria-label="Random paper selection"
          >
            <button type="button" onClick={() => selectRandomPaper('mixed')}>
              Random mixed paper
            </button>
            <button
              type="button"
              onClick={() => selectRandomPaper('seeded-random')}
            >
              Random seeded paper
            </button>
          </div>
          <button type="button" onClick={exportReceipt}>
            Export receipt
          </button>
          <small aria-live="polite">
            {saveMessage}
            {sinkUrl
              ? ` · ${sinkMessage || 'feedback mirror configured'}`
              : ' · local receipt only'}
          </small>
        </div>
      </header>

      <div className="pdf-review-identity">
        <dl className="pdf-review-status-fields">
          <div>
            <dt>Sample set</dt>
            <dd>{reviewSampleGroupLabel(sample)}</dd>
          </div>
          <div>
            <dt>Workload</dt>
            <dd>{reviewWorkloadLabel(sample)}</dd>
          </div>
          <div>
            <dt>Automated conversion check</dt>
            <dd>{automatedReviewLabel(annotation)}</dd>
          </div>
          <div>
            <dt>Human review</dt>
            <dd>{humanReviewLabel(annotation)}</dd>
          </div>
        </dl>
        <span>{sample.setId}</span>
        <code>{sample.sha256}</code>
        <a href={sample.sourceUrl} target="_blank" rel="noreferrer">
          Open source PDF
        </a>
        {annotation.snapshot && (
          <strong className={sourceMatches ? 'is-verified' : 'is-mismatch'}>
            {sourceMatches ? 'Source verified' : 'Source mismatch'}
          </strong>
        )}
        {machineBlocked && (
          <div className="pdf-review-machine-status" role="status">
            <strong>Automated conversion checks found EPUB defects</strong>
            <span>
              This status comes from source-to-EPUB reconstruction checks, not
              from your review labels. You can still inspect and label the
              output, but it is not publication-ready. Found:{' '}
              {blockingDiagnosticNames.join(', ')}.
            </span>
          </div>
        )}
      </div>

      <div className="pdf-review-workspace">
        <div className="pdf-review-comparison">
          <section aria-labelledby="pdf-review-source-heading">
            <div className="pdf-review-panel-heading">
              <span>Input</span>
              <h3 id="pdf-review-source-heading">Source PDF</h3>
            </div>
            <SourcePdfPageViewer
              key={sample.id}
              title={`Source PDF ${sample.id}`}
              sourceUrl={sample.sourceUrl}
            />
          </section>
          <section aria-labelledby="pdf-review-output-heading">
            <div className="pdf-review-panel-heading">
              <span>Output</span>
              <h3 id="pdf-review-output-heading">Mobile EPUB</h3>
            </div>
            {sample.reviewTier === 'stress' &&
            activeStressSampleId !== sample.id ? (
              <div className="pdf-review-stress">
                <span>Large-paper stress test</span>
                <h4>
                  {sample.pageCountHint
                    ? `${sample.pageCountHint} pages`
                    : 'Large document'}
                </h4>
                <p>
                  This paper is excluded from normal review timing. Converting
                  it locally will take much longer than the standard samples.
                </p>
                <div>
                  <button
                    type="button"
                    onClick={() => setActiveStressSampleId(sample.id)}
                  >
                    Start stress conversion
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIndex((current) =>
                        Math.min(samples.length - 1, current + 1),
                      )
                      setCriterionIndex(0)
                    }}
                  >
                    Review next paper
                  </button>
                </div>
              </div>
            ) : (
              <PublicationImporter
                key={sample.id}
                showIntro={false}
                reviewMode
                initialPaperUrl={sample.sourceUrl}
                onReviewSnapshot={recordReviewSnapshot}
              />
            )}
          </section>
        </div>
      </div>
    </section>
  )
}

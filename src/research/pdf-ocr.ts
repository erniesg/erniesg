import type {
  NormalizedSourceBox,
  PdfOcrLineEvidence,
  PdfOcrWordEvidence,
  PdfPageAnalysis,
  PdfPhysicalSpread,
  PdfSourceRun,
  ReconstructionDiagnostic,
} from './import-types'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'

export type PdfPageContentClass =
  | 'textless'
  | 'sparse-text'
  | 'mixed'
  | 'image-only'
  | 'scholarly-visual'
  | 'born-digital'

export type PdfPageClassification = {
  contentClass: PdfPageContentClass
  needsOcr: boolean
  evidence: {
    textCharacters: number
    runCount: number
    textArea: number
    imageCount: number
    imageCoverage: number
  }
}

export type PdfOcrPixelBox = {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type PdfOcrRecognition = {
  engine: string
  engineVersion: string
  model: string
  modelVersion: string
  languages: string[]
  languageMode: 'explicit' | 'automatic-fallback'
  raster: {
    width: number
    height: number
    sha256: string
  }
  words: Array<{
    text: string
    confidence: number
    bbox: PdfOcrPixelBox
    lineId: string
  }>
  lines: Array<{
    id: string
    text: string
    confidence: number
    bbox: PdfOcrPixelBox
  }>
}

export type PdfOcrRaster = {
  bytes: Uint8Array
  mediaType: 'image/png'
  width: number
  height: number
  sha256: string
}

export type PdfOcrRasterPage = {
  page: number
  width: number
  height: number
  rotation: number
  signal?: AbortSignal
  render: () => Promise<PdfOcrRaster>
}

export type PdfOcrRequest = {
  page: number
  rotation: number
  sourceSha256: string
  raster: PdfOcrRaster
  signal?: AbortSignal
}

export type PdfOcrSession = {
  recognize(request: PdfOcrRequest): Promise<PdfOcrRecognition>
  terminate(): Promise<void>
}

export type PdfOcrOptions = {
  languages: string[]
  languageMode: 'explicit' | 'automatic-fallback'
  createSession(options: {
    languages: string[]
    languageMode: PdfOcrOptions['languageMode']
    signal?: AbortSignal
    onProgress?: (progress: number, message: string) => void
  }): Promise<PdfOcrSession>
  rasterize?: (page: PdfOcrRasterPage) => Promise<PdfOcrRaster>
}

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function coveredArea(boxes: Array<{ width: number; height: number }>) {
  return rounded(
    Math.min(
      boxes.reduce(
        (total, box) =>
          total + Math.max(0, box.width) * Math.max(0, box.height),
        0,
      ),
      1,
    ),
  )
}

type PdfPageLine = {
  text: string
  x: number
  y: number
  width: number
  height: number
}

function sourceTextLines(runs: PdfSourceRun[]): PdfPageLine[] {
  const ordered = [...runs].sort(
    (left, right) => left.y - right.y || left.x - right.x,
  )
  const lines: PdfSourceRun[][] = []
  for (const run of ordered) {
    const center = run.y + run.height / 2
    const line = lines.find((candidate) => {
      const candidateCenter =
        candidate.reduce((total, item) => total + item.y + item.height / 2, 0) /
        candidate.length
      const tolerance = Math.max(
        run.height,
        ...candidate.map((item) => item.height),
      )
      return Math.abs(center - candidateCenter) <= tolerance * 0.65
    })
    if (line) line.push(run)
    else lines.push([run])
  }
  return lines.map((line) => {
    const horizontal = [...line].sort((left, right) => left.x - right.x)
    const x = Math.min(...horizontal.map((run) => run.x))
    const y = Math.min(...horizontal.map((run) => run.y))
    const right = Math.max(...horizontal.map((run) => run.x + run.width))
    const bottom = Math.max(...horizontal.map((run) => run.y + run.height))
    return {
      text: horizontal
        .map((run) => run.text.trim())
        .filter(Boolean)
        .join(' '),
      x,
      y,
      width: right - x,
      height: bottom - y,
    }
  })
}

function horizontalOverlap(
  left: Pick<PdfPageLine, 'x' | 'width'>,
  right: Pick<PdfPageLine, 'x' | 'width'>,
) {
  return Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
}

function verticalOverlap(
  top: Pick<PdfPageLine, 'y' | 'height'>,
  bottom: Pick<PdfPageLine, 'y' | 'height'>,
) {
  return Math.max(
    0,
    Math.min(top.y + top.height, bottom.y + bottom.height) -
      Math.max(top.y, bottom.y),
  )
}

function boundedInsetImage(
  box: Pick<PdfPageLine, 'x' | 'y' | 'width' | 'height'>,
) {
  const area = box.width * box.height
  return (
    area >= 0.02 &&
    area <= 0.6 &&
    box.width >= 0.2 &&
    box.height >= 0.08 &&
    box.x >= 0.025 &&
    box.y >= 0.025 &&
    box.x + box.width <= 0.975 &&
    box.y + box.height <= 0.975
  )
}

function adjacentToCaption(
  image: Pick<PdfPageLine, 'x' | 'y' | 'width' | 'height'>,
  caption: PdfPageLine,
) {
  const imageBottom = image.y + image.height
  const captionRight = caption.x + caption.width
  const imageRight = image.x + image.width
  const aboveCaption =
    imageBottom <= caption.y + 0.01 &&
    caption.y - imageBottom <= 0.08 &&
    horizontalOverlap(image, caption) >=
      Math.min(image.width, caption.width) * 0.25
  const besideCaption =
    (imageRight <= caption.x || captionRight <= image.x) &&
    Math.max(caption.x - imageRight, image.x - captionRight) <= 0.05 &&
    verticalOverlap(image, caption) >=
      Math.min(image.height, caption.height) * 0.25
  return aboveCaption || besideCaption
}

function hasBoundedScholarlyVisual(
  page: PdfPageAnalysis,
  runs: PdfSourceRun[],
) {
  const captions = sourceTextLines(runs).filter((line) => {
    const label = parsePdfScholarlyVisualLabel(line.text, {
      context: 'caption',
    })
    return label?.kind === 'figure' || label?.kind === 'table'
  })
  if (captions.length === 0) return false
  return (page.objects ?? []).some(
    (object) =>
      object.kind === 'image' &&
      boundedInsetImage(object.box) &&
      captions.some((caption) => adjacentToCaption(object.box, caption)),
  )
}

export function classifyPdfPage(page: PdfPageAnalysis): PdfPageClassification {
  const runs = page.runs.filter((candidate) => candidate.text.trim())
  const textCharacters = runs.reduce(
    (total, candidate) =>
      total + [...candidate.text.replace(/\s/gu, '')].length,
    0,
  )
  const textArea = coveredArea(runs)
  const imageCoverage = coveredArea(
    (page.objects ?? []).map((object) => object.box),
  )
  const hasText = textCharacters > 0
  const sparseText =
    hasText && (textCharacters < 48 || runs.length < 2 || textArea < 0.015)
  const scholarlyVisual =
    sparseText && imageCoverage >= 0.1 && hasBoundedScholarlyVisual(page, runs)
  const contentClass: PdfPageContentClass = !hasText
    ? imageCoverage >= 0.1
      ? 'image-only'
      : 'textless'
    : scholarlyVisual
      ? 'scholarly-visual'
      : sparseText && imageCoverage >= 0.1
        ? 'mixed'
        : sparseText
          ? 'sparse-text'
          : 'born-digital'

  return {
    contentClass,
    needsOcr:
      contentClass !== 'born-digital' && contentClass !== 'scholarly-visual',
    evidence: {
      textCharacters,
      runCount: runs.length,
      textArea,
      imageCount: page.imageCount,
      imageCoverage,
    },
  }
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}

function normalizedBox(
  page: PdfPageAnalysis,
  box: PdfOcrPixelBox,
  raster: PdfOcrRecognition['raster'],
): NormalizedSourceBox {
  const x = clamp(box.x0 / raster.width)
  const y = clamp(box.y0 / raster.height)
  return {
    page: page.page,
    x: rounded(x),
    y: rounded(y),
    width: rounded(Math.max(clamp(box.x1 / raster.width) - x, 0)),
    height: rounded(Math.max(clamp(box.y1 / raster.height) - y, 0)),
    rotation: page.rotation,
    method: 'ocr',
  }
}

function boxArea(box: Pick<NormalizedSourceBox, 'width' | 'height'>) {
  return Math.max(0, box.width) * Math.max(0, box.height)
}

function containsCenter(
  container: Pick<NormalizedSourceBox, 'x' | 'y' | 'width' | 'height'>,
  candidate: Pick<NormalizedSourceBox, 'x' | 'y' | 'width' | 'height'>,
) {
  const x = candidate.x + candidate.width / 2
  const y = candidate.y + candidate.height / 2
  return (
    x >= container.x &&
    x <= container.x + container.width &&
    y >= container.y &&
    y <= container.y + container.height
  )
}

function provenScanSurfaceId(
  page: PdfPageAnalysis,
  acceptedRuns: PdfSourceRun[],
  acceptedLineIds: Set<string>,
) {
  if (
    page.kind !== 'ocr-required' ||
    acceptedRuns.length < 6 ||
    acceptedLineIds.size < 2 ||
    acceptedRuns.reduce(
      (total, run) => total + [...run.text.replace(/\s/gu, '')].length,
      0,
    ) < 40
  ) {
    return null
  }
  const left = Math.min(...acceptedRuns.map((run) => run.x))
  const right = Math.max(...acceptedRuns.map((run) => run.x + run.width))
  const top = Math.min(...acceptedRuns.map((run) => run.y))
  const bottom = Math.max(...acceptedRuns.map((run) => run.y + run.height))
  if (right - left < 0.25 || bottom - top < 0.08) return null

  return (
    [...(page.objects ?? [])]
      .filter(
        (object) =>
          boxArea(object.box) >= 0.65 &&
          acceptedRuns.every((run) => containsCenter(object.box, run)),
      )
      .sort(
        (leftObject, rightObject) =>
          boxArea(rightObject.box) - boxArea(leftObject.box),
      )[0]?.id ?? null
  )
}

function overlapRatio(
  left: Pick<NormalizedSourceBox, 'x' | 'y' | 'width' | 'height'>,
  right: Pick<NormalizedSourceBox, 'x' | 'y' | 'width' | 'height'>,
) {
  const intersectionWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  )
  const intersectionHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  )
  const smallerArea = Math.min(boxArea(left), boxArea(right))
  return smallerArea > 0
    ? (intersectionWidth * intersectionHeight) / smallerArea
    : 0
}

function comparableText(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function comparableTokens(value: string) {
  return (
    value
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).map(comparableText)
}

function matchesEmbeddedText(embedded: string, ocrWord: string) {
  const word = comparableText(ocrWord)
  return (
    word.length > 0 &&
    (comparableText(embedded) === word ||
      comparableTokens(embedded).includes(word))
  )
}

function ocrRun(
  page: PdfPageAnalysis,
  word: PdfOcrRecognition['words'][number],
  box: NormalizedSourceBox,
): PdfSourceRun {
  return {
    ...box,
    text: word.text.trim(),
    fontName: 'ocr',
    fontSize: rounded(box.height * page.height),
    confidence: clamp(word.confidence),
  }
}

function mean(values: number[]) {
  return values.length > 0
    ? rounded(values.reduce((total, value) => total + value, 0) / values.length)
    : 0
}

export function mergeOcrPage(
  page: PdfPageAnalysis,
  recognition: PdfOcrRecognition,
  { sourceSha256 }: { sourceSha256: string },
): { page: PdfPageAnalysis; diagnostics: ReconstructionDiagnostic[] } {
  const embeddedRuns = page.runs.filter((run) => run.method === 'pdf-text')
  const acceptedRuns: PdfSourceRun[] = []
  const acceptedLineIds = new Set<string>()
  const words: PdfOcrWordEvidence[] = []
  const diagnostics: ReconstructionDiagnostic[] = []
  let hasConflict = false

  for (const word of recognition.words) {
    if (!word.text.trim()) continue
    const box = normalizedBox(page, word.bbox, recognition.raster)
    const run = ocrRun(page, word, box)
    const overlapping = embeddedRuns.filter(
      (candidate) => overlapRatio(candidate, box) >= 0.55,
    )
    const mergeStatus: PdfOcrWordEvidence['mergeStatus'] =
      overlapping.length > 0
        ? overlapping.some((candidate) =>
            matchesEmbeddedText(candidate.text, word.text),
          )
          ? 'duplicate'
          : 'conflict'
        : 'accepted'
    words.push({
      text: word.text.trim(),
      confidence: clamp(word.confidence),
      lineId: word.lineId,
      box,
      mergeStatus,
    })
    if (mergeStatus === 'accepted') {
      acceptedRuns.push(run)
      acceptedLineIds.add(word.lineId)
    }
    if (mergeStatus === 'conflict') hasConflict = true
  }

  if (hasConflict) {
    diagnostics.push({
      code: 'MIXED_OCR_CONFLICT',
      severity: 'error',
      page: page.page,
      message: `Page ${page.page} retains conflicting embedded and OCR text at overlapping source boxes for review.`,
    })
  }

  const confidence = mean(words.map((word) => word.confidence))
  if (words.length > 0 && confidence < 0.75) {
    diagnostics.push({
      code: 'LOW_CONFIDENCE_OCR',
      severity: 'error',
      page: page.page,
      message: `Page ${page.page} OCR confidence ${confidence.toFixed(3)} is below the review threshold 0.750.`,
    })
  }

  const confirmsEmbeddedOnlyPage =
    page.kind === 'ocr-required' &&
    page.imageCount === 0 &&
    (page.objects?.length ?? 0) === 0 &&
    embeddedRuns.length > 0 &&
    words.length > 0 &&
    words.every((word) => word.mergeStatus === 'duplicate') &&
    confidence >= 0.75

  const lines: PdfOcrLineEvidence[] = recognition.lines.map((line) => ({
    id: line.id,
    text: line.text,
    confidence: clamp(line.confidence),
    box: normalizedBox(page, line.bbox, recognition.raster),
  }))
  const runs = [...embeddedRuns, ...acceptedRuns].sort(
    (left, right) => left.y - right.y || left.x - right.x,
  )
  const textCharacters = runs.reduce(
    (total, run) => total + [...run.text.replace(/\s/gu, '')].length,
    0,
  )
  const scanSurfaceId = provenScanSurfaceId(page, acceptedRuns, acceptedLineIds)
  const objects = page.objects?.map((object) =>
    object.id === scanSurfaceId
      ? {
          ...object,
          role: 'scan-source' as const,
          rolePolicy: 'ocr-scan-surface-v1' as const,
        }
      : {
          ...object,
          role: object.role ?? ('semantic' as const),
        },
  )
  const merged: PdfPageAnalysis = {
    ...page,
    kind:
      page.kind === 'ocr-required' &&
      (acceptedRuns.length > 0 || confirmsEmbeddedOnlyPage)
        ? 'ocr-complete'
        : page.kind,
    textCharacters,
    objects,
    runs,
    ocr: {
      engine: recognition.engine,
      engineVersion: recognition.engineVersion,
      model: recognition.model,
      modelVersion: recognition.modelVersion,
      languages: [...recognition.languages],
      languageMode: recognition.languageMode,
      sourceSha256,
      rasterSha256: recognition.raster.sha256,
      confidence,
      words,
      lines,
    },
  }

  return { page: merged, diagnostics }
}

function logicalRegion(
  page: PdfPageAnalysis,
  side: 'left' | 'right',
  boundary: number,
): PdfPhysicalSpread['logicalRegions'][number] {
  return {
    id: `physical-p${String(page.page).padStart(3, '0')}-${side}`,
    physicalPage: page.page,
    side,
    box: {
      page: page.page,
      x: side === 'left' ? 0 : boundary,
      y: 0,
      width: side === 'left' ? boundary : 1 - boundary,
      height: 1,
      rotation: page.rotation,
      method: 'ocr',
    },
  }
}

export function detectPhysicalSpread(page: PdfPageAnalysis): PdfPhysicalSpread {
  const imageCoverage = coveredArea(
    (page.objects ?? []).map((object) => object.box),
  )
  if (
    page.kind === 'born-digital' ||
    page.width / Math.max(page.height, 1) < 1.35 ||
    imageCoverage < 0.4
  ) {
    return {
      status: 'single',
      boundary: null,
      confidence: 1,
      logicalRegions: [],
    }
  }

  const boxes = page.ocr?.words.map((word) => word.box) ?? []
  const crossesCenter = boxes.some(
    (box) => box.x < 0.5 && box.x + box.width > 0.5,
  )
  const left = boxes.filter((box) => box.x + box.width <= 0.5)
  const right = boxes.filter((box) => box.x >= 0.5)
  const leftEdge = Math.max(...left.map((box) => box.x + box.width), 0)
  const rightEdge = Math.min(...right.map((box) => box.x), 1)
  const gutter = rightEdge - leftEdge
  const split =
    left.length >= 2 && right.length >= 2 && !crossesCenter && gutter >= 0.02
  const boundary = split ? rounded((leftEdge + rightEdge) / 2) : 0.5
  return {
    status: split ? 'split' : 'uncertain',
    boundary,
    confidence: split ? 0.9 : 0.55,
    logicalRegions: split
      ? [
          logicalRegion(page, 'left', boundary),
          logicalRegion(page, 'right', boundary),
        ]
      : [],
  }
}

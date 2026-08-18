import type {
  NormalizedSourceBox,
  PdfEmbeddedLink,
  PdfReconstruction,
} from './import-types'
import { sha256HexSync } from './sha256-sync'
import {
  PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
  type PdfEvidenceArtifact,
  type PdfEvidenceBox,
  type PdfEvidenceBundle,
  type PdfEvidenceCandidate,
  type PdfEvidenceDisagreement,
  type PdfEvidenceJsonValue,
  type PdfEvidenceObligation,
  type PdfEvidenceObservationCategory,
  type PdfEvidenceProviderIdentity,
  type PdfEvidenceSource,
} from './source-evidence-graph'

export const PDFJS_EVIDENCE_PROVIDER: PdfEvidenceProviderIdentity = {
  id: 'pdfjs-5.4.624',
  kind: 'pdfjs',
  name: 'pdfjs-dist',
  version: '5.4.624',
}

export type PdfFullPageRenderEvidence = {
  page: number
  mediaType: 'image/png' | 'image/jpeg'
  sha256: string
  byteLength: number
  width: number
  height: number
  /** Optional owner-local bytes. They are verified but never copied to graph JSON. */
  bytes?: Uint8Array
}

export type PdfDeterministicEvidenceOptions = {
  pageRenders: readonly PdfFullPageRenderEvidence[]
  provider?: PdfEvidenceProviderIdentity
  /** Scanned and hybrid pages fail closed unless local OCR evidence is present. */
  requireLocalOcr?: boolean
}

export type PdfDeterministicEvidence = {
  bundles: PdfEvidenceBundle[]
  obligations: PdfEvidenceObligation[]
  disagreements: PdfEvidenceDisagreement[]
}

const SHA256 = /^[a-f0-9]{64}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(code: string): never {
  throw new Error(code)
}

function pad(value: number) {
  return String(value).padStart(6, '0')
}

function evidenceBox(box: NormalizedSourceBox): PdfEvidenceBox {
  return {
    page: box.page,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    rotation: box.rotation,
    method: box.method,
  }
}

function clonePayload<T>(value: T): T {
  return structuredClone(value)
}

function evidenceJson(
  value: unknown,
): import('./source-evidence-graph').PdfEvidenceJsonValue {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) invalid('INVALID_PDF_EVIDENCE_JSON')
  return JSON.parse(
    encoded,
  ) as import('./source-evidence-graph').PdfEvidenceJsonValue
}

function linkBox(link: PdfEmbeddedLink) {
  return 'box' in link && link.box ? evidenceBox(link.box) : undefined
}

function requirePageRender(
  renderByPage: ReadonlyMap<number, PdfFullPageRenderEvidence>,
  page: number,
) {
  const render = renderByPage.get(page)
  if (
    !render ||
    !SHA256.test(render.sha256) ||
    !Number.isSafeInteger(render.byteLength) ||
    render.byteLength <= 0 ||
    !Number.isFinite(render.width) ||
    render.width <= 0 ||
    !Number.isFinite(render.height) ||
    render.height <= 0 ||
    (render.bytes !== undefined &&
      (render.bytes.byteLength !== render.byteLength ||
        sha256HexSync(render.bytes) !== render.sha256))
  ) {
    invalid('INVALID_PDF_FULL_PAGE_RENDER_EVIDENCE')
  }
  return render
}

function sourceIdentity(reconstruction: PdfReconstruction) {
  return {
    documentId: reconstruction.paper.id,
    sha256: reconstruction.source.sha256,
    byteLength: reconstruction.source.byteLength,
    pageCount: reconstruction.source.pageCount,
  }
}

function relationshipPage(value: { sourceBoxes?: NormalizedSourceBox[] }) {
  return value.sourceBoxes?.[0]?.page
}

function relationshipObservationCategories(
  kind: string,
): PdfEvidenceObservationCategory[] {
  switch (kind) {
    case 'table-relationship':
      return [
        'object-counts',
        'table-cells',
        'table-spans',
        'table-headers',
        'captions',
        'asset-bytes',
        'clipping',
        'overflow',
      ]
    case 'figure-relationship':
      return [
        'object-counts',
        'figures',
        'captions',
        'asset-bytes',
        'clipping',
        'overflow',
      ]
    case 'equation-relationship':
      return [
        'object-counts',
        'formulas',
        'captions',
        'asset-bytes',
        'clipping',
        'overflow',
      ]
    case 'note-relationship':
      return ['notes', 'links', 'dangling-targets']
    case 'citation-relationship':
      return ['citations', 'links', 'dangling-targets']
    case 'cross-reference-relationship':
      return ['links', 'dangling-targets']
    default:
      throw new TypeError(`UNCLASSIFIED_RELATIONSHIP_OBSERVATION:${kind}`)
  }
}

/**
 * Preserve the already-extracted PDF.js/native arm without treating its
 * resolved semantic graph as exclusive truth. Full-page renders are explicit
 * inputs so callers cannot silently omit born-digital pages.
 */
export function pdfEvidenceBundlesFromReconstruction(
  reconstruction: PdfReconstruction,
  options: PdfDeterministicEvidenceOptions,
): PdfDeterministicEvidence {
  if (
    !SHA256.test(reconstruction.source.sha256) ||
    !Number.isSafeInteger(reconstruction.source.pageCount) ||
    reconstruction.source.pageCount < 1 ||
    reconstruction.pages.length !== reconstruction.source.pageCount
  ) {
    invalid('INVALID_PDF_RECONSTRUCTION_SOURCE_IDENTITY')
  }
  const provider = clonePayload(options.provider ?? PDFJS_EVIDENCE_PROVIDER)
  if (provider.kind !== 'pdfjs') invalid('INVALID_PDFJS_PROVIDER_IDENTITY')
  const renderByPage = new Map(
    options.pageRenders.map((render) => [render.page, render]),
  )
  if (
    renderByPage.size !== reconstruction.source.pageCount ||
    options.pageRenders.length !== reconstruction.source.pageCount
  ) {
    invalid('MISSING_PDF_FULL_PAGE_RENDER_EVIDENCE')
  }

  const artifacts: PdfEvidenceArtifact[] = []
  const sources: PdfEvidenceSource[] = []
  const candidates: PdfEvidenceCandidate[] = []
  const obligations: PdfEvidenceObligation[] = []
  const disagreements: PdfEvidenceDisagreement[] = []
  const assetArtifactIds = new Map<string, string>()

  for (const [index, asset] of reconstruction.assets.entries()) {
    if (
      asset.bytes.byteLength <= 0 ||
      !SHA256.test(asset.sha256) ||
      sha256HexSync(asset.bytes) !== asset.sha256
    ) {
      invalid('PDF_ASSET_IDENTITY_MISMATCH')
    }
    const artifactId = `pdfjs-artifact-asset-${pad(index + 1)}`
    assetArtifactIds.set(asset.id, artifactId)
    artifacts.push({
      id: artifactId,
      providerId: provider.id,
      kind: asset.rendition,
      mediaType: asset.mediaType,
      sha256: asset.sha256,
      byteLength: asset.bytes.byteLength,
      ...(asset.sourceCropBox
        ? {
            page: asset.sourceCropBox.page,
            box: evidenceBox(asset.sourceCropBox),
          }
        : {}),
    })
  }

  for (const page of [...reconstruction.pages].sort(
    (left, right) => left.page - right.page,
  )) {
    if (page.page < 1 || page.page > reconstruction.source.pageCount) {
      invalid('INVALID_PDF_PAGE_EVIDENCE')
    }
    const pageKey = `p${pad(page.page)}`
    const pageSourceId = `pdfjs-source-page-${pageKey}`
    const pageBox: PdfEvidenceBox = {
      page: page.page,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      rotation: page.rotation,
      method: 'pdf-object',
    }
    sources.push({
      id: pageSourceId,
      providerId: provider.id,
      kind: 'page-geometry',
      page: page.page,
      box: pageBox,
      payload: {
        width: page.width,
        height: page.height,
        rotation: page.rotation,
        pageKind: page.kind,
      },
    })

    const render = requirePageRender(renderByPage, page.page)
    const renderArtifactId = `pdfjs-artifact-page-render-${pageKey}`
    artifacts.push({
      id: renderArtifactId,
      providerId: provider.id,
      kind: 'full-page-render',
      mediaType: render.mediaType,
      sha256: render.sha256,
      byteLength: render.byteLength,
      page: page.page,
      box: pageBox,
      sourceIds: [pageSourceId],
    })
    const renderCandidateId = `pdfjs-candidate-page-render-${pageKey}`
    candidates.push({
      id: renderCandidateId,
      providerId: provider.id,
      kind: 'full-page-render',
      page: page.page,
      boxes: [pageBox],
      sourceIds: [pageSourceId],
      artifactIds: [renderArtifactId],
      payload: { semantic: false, completePageRaster: true },
    })
    const fontSourceIds = new Map<string, string>()
    for (const [runIndex, run] of page.runs.entries()) {
      const runKey = `${pageKey}-r${pad(runIndex + 1)}`
      const runSourceId = `pdfjs-source-run-${runKey}`
      const runCandidateId = `pdfjs-candidate-run-${runKey}`
      const box = evidenceBox(run)
      let fontSourceId = fontSourceIds.get(run.fontName)
      if (!fontSourceId) {
        fontSourceId = `pdfjs-source-font-${pageKey}-f${pad(fontSourceIds.size + 1)}`
        fontSourceIds.set(run.fontName, fontSourceId)
        sources.push({
          id: fontSourceId,
          providerId: provider.id,
          kind: 'font',
          page: page.page,
          payload: { name: run.fontName },
        })
      }
      sources.push({
        id: runSourceId,
        providerId: provider.id,
        kind: 'text-glyph-run',
        page: page.page,
        box,
        parentSourceIds: [pageSourceId, fontSourceId],
        payload: {
          text: run.text,
          fontName: run.fontName,
          fontSize: run.fontSize,
          confidence: run.confidence,
          bold: run.bold ?? false,
          italic: run.italic ?? false,
          sourceSequenceIndex: run.sourceSequenceIndex ?? null,
          sourceWhitespaceBefore: run.sourceWhitespaceBefore ?? null,
          sourceTextPaint: run.sourceTextPaint ?? null,
          sourceSemanticAdmission: run.sourceSemanticAdmission ?? null,
        },
      })
      candidates.push({
        id: runCandidateId,
        providerId: provider.id,
        kind: 'text-glyph-run',
        page: page.page,
        boxes: [box],
        sourceIds: [runSourceId, fontSourceId],
        payload: {
          text: run.text,
          fontName: run.fontName,
          fontSize: run.fontSize,
          confidence: run.confidence,
          sourceSequenceIndex: run.sourceSequenceIndex ?? runIndex,
        },
      })
      obligations.push({
        id: `obligation-text-${runKey}`,
        kind: 'source-text',
        page: page.page,
        sourceIds: [runSourceId],
        artifactIds: [],
        candidateIds: [runCandidateId],
        observationCategories: [
          'text-exactness',
          'reading-order',
          'clipping',
          'overflow',
        ],
        required: true,
        semantic: true,
      })
    }

    for (const [objectIndex, object] of (page.objects ?? []).entries()) {
      const objectKey = `${pageKey}-o${pad(objectIndex + 1)}`
      const objectSourceId = `pdfjs-source-object-${objectKey}`
      const objectCandidateId = `pdfjs-candidate-object-${objectKey}`
      const artifactIds = object.assetId
        ? [assetArtifactIds.get(object.assetId)].filter(
            (id): id is string => id !== undefined,
          )
        : []
      sources.push({
        id: objectSourceId,
        providerId: provider.id,
        kind: `${object.kind}-object`,
        page: page.page,
        box: evidenceBox(object.box),
        artifactIds,
        parentSourceIds: [pageSourceId],
        payload: {
          objectId: object.id,
          confidence: object.confidence,
          role: object.role ?? null,
          rolePolicy: object.rolePolicy ?? null,
        },
      })
      candidates.push({
        id: objectCandidateId,
        providerId: provider.id,
        kind: `${object.kind}-object`,
        page: page.page,
        boxes: [evidenceBox(object.box)],
        sourceIds: [objectSourceId],
        artifactIds,
        payload: { objectId: object.id, assetId: object.assetId },
      })
      obligations.push({
        id: `obligation-object-${objectKey}`,
        kind: 'source-object',
        page: page.page,
        sourceIds: [objectSourceId],
        artifactIds,
        candidateIds: [objectCandidateId],
        observationCategories: [
          'object-counts',
          ...(object.kind === 'image'
            ? (['figures'] as const)
            : (['diagrams'] as const)),
          ...(artifactIds.length > 0 ? (['asset-bytes'] as const) : []),
          'clipping',
          'overflow',
        ],
        required: object.role !== 'scan-source',
        semantic: object.role !== 'scan-source',
      })
    }

    for (const [linkIndex, link] of (page.links ?? []).entries()) {
      const linkKey = `${pageKey}-a${pad(linkIndex + 1)}`
      const linkSourceId = `pdfjs-source-annotation-${linkKey}`
      const linkCandidateId = `pdfjs-candidate-annotation-${linkKey}`
      const box = linkBox(link)
      const payload = evidenceJson(link)
      sources.push({
        id: linkSourceId,
        providerId: provider.id,
        kind: 'annotation-link-destination',
        page: page.page,
        ...(box ? { box } : {}),
        parentSourceIds: [pageSourceId],
        payload,
      })
      candidates.push({
        id: linkCandidateId,
        providerId: provider.id,
        kind: 'annotation-link-destination',
        page: page.page,
        ...(box ? { boxes: [box] } : {}),
        sourceIds: [linkSourceId],
        payload,
      })
      obligations.push({
        id: `obligation-annotation-${linkKey}`,
        kind: 'annotation-destination',
        page: page.page,
        sourceIds: [linkSourceId],
        artifactIds: [],
        candidateIds: [linkCandidateId],
        observationCategories: [
          'links',
          'clipping',
          'overflow',
          'dangling-targets',
        ],
        required: true,
        semantic: true,
      })
    }

    const requiresOcr = ['mixed', 'ocr-required', 'ocr-complete'].includes(
      page.kind,
    )
    if (requiresOcr) {
      obligations.push({
        id: `obligation-source-preserved-${pageKey}`,
        kind: 'source-preserved-page',
        page: page.page,
        sourceIds: [pageSourceId],
        artifactIds: [renderArtifactId],
        candidateIds: [renderCandidateId],
        observationCategories: [
          'object-counts',
          'asset-bytes',
          'clipping',
          'overflow',
        ],
        required: true,
        semantic: true,
      })
    }
    if ((options.requireLocalOcr ?? true) && requiresOcr && !page.ocr) {
      invalid('PDF_LOCAL_OCR_EVIDENCE_REQUIRED')
    }
  }

  for (const [regionIndex, region] of reconstruction.regions.entries()) {
    const regionSourceId = `pdfjs-source-region-${pad(regionIndex + 1)}`
    const regionCandidateId = `pdfjs-candidate-region-${pad(regionIndex + 1)}`
    sources.push({
      id: regionSourceId,
      providerId: provider.id,
      kind: 'layout-region',
      page: region.page,
      box: evidenceBox(region.box),
      payload: evidenceJson(region),
    })
    candidates.push({
      id: regionCandidateId,
      providerId: provider.id,
      kind: 'layout-region',
      page: region.page,
      boxes: [evidenceBox(region.box)],
      sourceIds: [regionSourceId],
      payload: {
        regionId: region.id,
        type: region.kind,
        column: region.column,
        text: region.text,
        includedInReadingOrder: region.includedInReadingOrder,
      },
    })
    obligations.push({
      id: `obligation-region-${pad(regionIndex + 1)}`,
      kind: 'layout-region',
      page: region.page,
      sourceIds: [regionSourceId],
      artifactIds: [],
      candidateIds: [regionCandidateId],
      observationCategories: [
        'reading-order',
        ...(region.kind === 'figure' ? (['figures'] as const) : []),
        ...(region.kind === 'caption' ? (['captions'] as const) : []),
        ...(region.kind === 'equation' ? (['formulas'] as const) : []),
        ...(region.kind === 'footnote' || region.kind === 'endnote'
          ? (['notes'] as const)
          : []),
        'clipping',
        'overflow',
      ],
      required: !['header', 'footer', 'page-number'].includes(region.kind),
      semantic: !['header', 'footer', 'page-number'].includes(region.kind),
    })
  }

  for (const [edgeIndex, edge] of reconstruction.readingOrder.edges.entries()) {
    const key = pad(edgeIndex + 1)
    const sourceId = `pdfjs-source-reading-order-${key}`
    const candidateId = `pdfjs-candidate-reading-order-${key}`
    sources.push({
      id: sourceId,
      providerId: provider.id,
      kind: 'reading-order-edge',
      page: edge.sourceBoxes[0]?.page,
      box: edge.sourceBoxes[0] ? evidenceBox(edge.sourceBoxes[0]) : undefined,
      payload: clonePayload(edge),
    })
    candidates.push({
      id: candidateId,
      providerId: provider.id,
      kind: 'reading-order-edge',
      page: edge.sourceBoxes[0]?.page,
      boxes: edge.sourceBoxes.map(evidenceBox),
      sourceIds: [sourceId],
      payload: clonePayload(edge),
    })
    obligations.push({
      id: `obligation-reading-order-${key}`,
      kind: 'reading-order',
      page: edge.sourceBoxes[0]?.page,
      sourceIds: [sourceId],
      artifactIds: [],
      candidateIds: [candidateId],
      observationCategories: ['reading-order', 'clipping', 'overflow'],
      required: true,
      semantic: true,
    })
  }

  const relationshipPayload = (
    kind: string,
    value: PdfEvidenceJsonValue,
  ): PdfEvidenceJsonValue => {
    if (kind !== 'table-relationship' || !isRecord(value)) {
      return evidenceJson(value)
    }
    const canonicalNodeId = value.canonicalNodeId
    const tableNode = reconstruction.paper.nodes.find(
      (node) =>
        node.id === canonicalNodeId &&
        node.type === 'figure' &&
        node.objectType === 'table' &&
        node.table !== undefined,
    )
    return tableNode?.type === 'figure' && tableNode.table
      ? {
          ...(evidenceJson(value) as Record<string, PdfEvidenceJsonValue>),
          semanticTable: evidenceJson(tableNode.table),
        }
      : evidenceJson(value)
  }
  const relationships = [
    ...reconstruction.noteRelationships.map((value) => ({
      kind: 'note-relationship',
      value,
      alternatives: value.candidates,
    })),
    ...reconstruction.citationRelationships.map((value) => ({
      kind: 'citation-relationship',
      value,
      alternatives: value.candidateNodeIds ?? [],
    })),
    ...reconstruction.crossReferenceRelationships.map((value) => ({
      kind: 'cross-reference-relationship',
      value,
      alternatives: value.targets.flatMap(
        (target) => target.candidateNodeIds ?? [],
      ),
    })),
    ...reconstruction.visualRelationships.map((value) => ({
      kind: `${value.kind}-relationship`,
      value,
      alternatives: value.candidates,
    })),
  ]
  for (const [index, relationship] of relationships.entries()) {
    const key = pad(index + 1)
    const sourceId = `pdfjs-source-relationship-${key}`
    const selectedId = `pdfjs-candidate-relationship-${key}-selected`
    const page = relationshipPage(relationship.value)
    sources.push({
      id: sourceId,
      providerId: provider.id,
      kind: relationship.kind,
      page,
      box: relationship.value.sourceBoxes[0]
        ? evidenceBox(relationship.value.sourceBoxes[0])
        : undefined,
      payload: relationshipPayload(
        relationship.kind,
        relationship.value as unknown as PdfEvidenceJsonValue,
      ),
    })
    const relationshipCandidateIds = [selectedId]
    candidates.push({
      id: selectedId,
      providerId: provider.id,
      kind: relationship.kind,
      page,
      boxes: relationship.value.sourceBoxes.map(evidenceBox),
      sourceIds: [sourceId],
      payload: relationshipPayload(
        relationship.kind,
        relationship.value as unknown as PdfEvidenceJsonValue,
      ),
    })
    for (const [
      alternativeIndex,
      alternative,
    ] of relationship.alternatives.entries()) {
      const candidateId = `pdfjs-candidate-relationship-${key}-alternative-${pad(alternativeIndex + 1)}`
      relationshipCandidateIds.push(candidateId)
      candidates.push({
        id: candidateId,
        providerId: provider.id,
        kind: relationship.kind,
        page,
        boxes: relationship.value.sourceBoxes.map(evidenceBox),
        sourceIds: [sourceId],
        payload: clonePayload(alternative),
      })
    }
    const obligationId = `obligation-relationship-${key}`
    obligations.push({
      id: obligationId,
      kind: relationship.kind,
      page,
      sourceIds: [sourceId],
      artifactIds: [],
      candidateIds: relationshipCandidateIds,
      observationCategories: relationshipObservationCategories(
        relationship.kind,
      ),
      required: true,
      semantic: true,
    })
    if (relationshipCandidateIds.length > 1) {
      disagreements.push({
        id: `disagreement-relationship-${key}`,
        kind: relationship.kind,
        obligationIds: [obligationId],
        candidateIds: relationshipCandidateIds,
        providerIds: [provider.id],
        reason:
          'deterministic alternatives are retained until grounded reconciliation',
      })
    }
  }

  const deterministicBundle: PdfEvidenceBundle = {
    schemaVersion: PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
    id: 'pdfjs-deterministic-evidence',
    armId: 'deterministic',
    source: sourceIdentity(reconstruction),
    provider,
    pages: reconstruction.pages.map(({ page, width, height, rotation }) => ({
      page,
      width,
      height,
      rotation,
    })),
    artifacts,
    sources,
    candidates,
  }

  const ocrBundles = ocrEvidenceBundles(reconstruction, deterministicBundle)
  return {
    bundles: [deterministicBundle, ...ocrBundles.bundles],
    obligations: [...obligations, ...ocrBundles.obligations],
    disagreements: [...disagreements, ...ocrBundles.disagreements],
  }
}

function ocrEvidenceBundles(
  reconstruction: PdfReconstruction,
  deterministicBundle: PdfEvidenceBundle,
) {
  const grouped = new Map<
    string,
    {
      provider: PdfEvidenceProviderIdentity
      pages: PdfEvidenceBundle['pages']
      sources: PdfEvidenceSource[]
      candidates: PdfEvidenceCandidate[]
      obligations: PdfEvidenceObligation[]
      disagreements: PdfEvidenceDisagreement[]
    }
  >()
  for (const page of reconstruction.pages) {
    if (!page.ocr) continue
    const identityKey = [
      page.ocr.engine,
      page.ocr.engineVersion,
      page.ocr.model,
      page.ocr.modelVersion,
      [...page.ocr.languages].sort().join(','),
    ].join('\0')
    let group = grouped.get(identityKey)
    if (!group) {
      const identityDigest = sha256HexSync(identityKey).slice(0, 16)
      group = {
        provider: {
          id: `ocr-${identityDigest}`,
          kind: 'ocr',
          name: page.ocr.engine,
          version: page.ocr.engineVersion,
          model: {
            id: page.ocr.model,
            revision: page.ocr.modelVersion,
          },
        },
        pages: reconstruction.pages.map(
          ({ page: sourcePage, width, height, rotation }) => ({
            page: sourcePage,
            width,
            height,
            rotation,
          }),
        ),
        sources: [],
        candidates: [],
        obligations: [],
        disagreements: [],
      }
      grouped.set(identityKey, group)
    }
    const pageKey = `p${pad(page.page)}`
    for (const [wordIndex, word] of page.ocr.words.entries()) {
      const key = `${pageKey}-w${pad(wordIndex + 1)}`
      const sourceId = `${group.provider.id}-source-word-${key}`
      const candidateId = `${group.provider.id}-candidate-word-${key}`
      group.sources.push({
        id: sourceId,
        providerId: group.provider.id,
        kind: 'ocr-word',
        page: page.page,
        box: evidenceBox(word.box),
        payload: clonePayload(word),
      })
      group.candidates.push({
        id: candidateId,
        providerId: group.provider.id,
        kind: 'ocr-word',
        page: page.page,
        boxes: [evidenceBox(word.box)],
        sourceIds: [sourceId],
        payload: clonePayload(word),
      })
      const obligationId = `${group.provider.id}-obligation-word-${key}`
      group.obligations.push({
        id: obligationId,
        kind: 'ocr-text',
        page: page.page,
        sourceIds: [sourceId],
        artifactIds: [],
        candidateIds: [candidateId],
        observationCategories: [
          'text-exactness',
          'reading-order',
          'clipping',
          'overflow',
        ],
        required: true,
        semantic: true,
      })
      if (word.mergeStatus === 'conflict') {
        const sourcePageFallback = deterministicBundle.candidates.find(
          (candidate) =>
            candidate.kind === 'full-page-render' &&
            candidate.page === page.page,
        )
        if (!sourcePageFallback) invalid('PDF_SOURCE_PAGE_FALLBACK_REQUIRED')
        group.disagreements.push({
          id: `${group.provider.id}-disagreement-word-${key}`,
          kind: 'ocr-conflict',
          obligationIds: [obligationId],
          candidateIds: [candidateId, sourcePageFallback.id],
          providerIds: [group.provider.id, deterministicBundle.provider.id],
          reason:
            'OCR conflicts with embedded deterministic text; retain the complete deterministic source page as the bounded alternative',
        })
      }
    }
    for (const [lineIndex, line] of page.ocr.lines.entries()) {
      const key = `${pageKey}-l${pad(lineIndex + 1)}`
      const sourceId = `${group.provider.id}-source-line-${key}`
      const candidateId = `${group.provider.id}-candidate-line-${key}`
      group.sources.push({
        id: sourceId,
        providerId: group.provider.id,
        kind: 'ocr-line',
        page: page.page,
        box: evidenceBox(line.box),
        payload: clonePayload(line),
      })
      group.candidates.push({
        id: candidateId,
        providerId: group.provider.id,
        kind: 'ocr-line',
        page: page.page,
        boxes: [evidenceBox(line.box)],
        sourceIds: [sourceId],
        payload: clonePayload(line),
      })
      if (page.ocr.words.length === 0) {
        group.obligations.push({
          id: `${group.provider.id}-obligation-line-${key}`,
          kind: 'ocr-text',
          page: page.page,
          sourceIds: [sourceId],
          artifactIds: [],
          candidateIds: [candidateId],
          observationCategories: [
            'text-exactness',
            'reading-order',
            'clipping',
            'overflow',
          ],
          required: true,
          semantic: true,
        })
      }
    }
  }

  const result = {
    bundles: [] as PdfEvidenceBundle[],
    obligations: [] as PdfEvidenceObligation[],
    disagreements: [] as PdfEvidenceDisagreement[],
  }
  for (const [index, group] of [...grouped.values()].entries()) {
    result.bundles.push({
      schemaVersion: PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
      id: `ocr-evidence-${pad(index + 1)}`,
      armId: group.provider.id,
      source: sourceIdentity(reconstruction),
      provider: group.provider,
      pages: group.pages,
      artifacts: [],
      sources: group.sources,
      candidates: group.candidates,
    })
    result.obligations.push(...group.obligations)
    result.disagreements.push(...group.disagreements)
  }
  return result
}

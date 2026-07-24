import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { createServer } from 'vite'
import { safeAuditDiagnostic } from './pdf-corpus-audit-safety.mjs'

export const PDF_CORPUS_REPORT_SCHEMA_VERSION = '1.5.0'
export const PDF_STRUCTURAL_RECEIPT_SCHEMA_VERSION = '1.3.0'

const MAX_DIAGNOSTIC_SAMPLES = 64
const MAX_DIAGNOSTIC_SAMPLES_PER_CODE = 3

const SAFE_FAILURE_MESSAGES = Object.freeze({
  INVALID_PDF: 'The file is not a valid PDF.',
  ENCRYPTED_PDF: 'The PDF is password-protected and was not opened.',
  OVERSIZED_PDF: 'The PDF exceeds the bounded local resource limit.',
  OCR_REQUIRED: 'The PDF requires local OCR before it can be audited.',
  EMPTY_PDF: 'The PDF contains no pages.',
  PDF_PARSE_FAILED:
    'The PDF parser could not open the document; local path and document details were suppressed.',
  IMPORT_CANCELLED: 'The local PDF audit was cancelled.',
  INCOMPLETE_RECONSTRUCTION:
    'The PDF reconstruction did not pass the completeness gate.',
  AUDIT_FAILED:
    'The PDF could not be audited; local path and document details were suppressed.',
})

export async function pdfPaths(paths) {
  const found = []

  async function visit(path) {
    const details = await stat(path)
    if (details.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true })
      for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        if (entry.isSymbolicLink()) continue
        await visit(resolve(path, entry.name))
      }
      return
    }
    if (details.isFile() && extname(path).toLocaleLowerCase() === '.pdf') {
      found.push(path)
    }
  }

  for (const path of paths) await visit(resolve(path))
  return [...new Set(found)]
}

function safeError(error) {
  const candidate =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : 'AUDIT_FAILED'
  const code = Object.hasOwn(SAFE_FAILURE_MESSAGES, candidate)
    ? candidate
    : 'AUDIT_FAILED'
  return { code, message: SAFE_FAILURE_MESSAGES[code] }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function canonicalJsonHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function countsBy(values, keyFor) {
  const counts = new Map()
  for (const value of values) {
    const key = keyFor(value)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function summarizeAuditDiagnostics(diagnostics) {
  const safeDiagnostics = diagnostics.map(safeAuditDiagnostic)
  const diagnosticCounts = countsBy(safeDiagnostics, ({ code }) => code)
  const sorted = [...safeDiagnostics].sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      left.severity.localeCompare(right.severity) ||
      (left.page ?? Number.MAX_SAFE_INTEGER) -
        (right.page ?? Number.MAX_SAFE_INTEGER) ||
      left.message.localeCompare(right.message),
  )
  const samples = []
  const samplesPerCode = new Map()
  const sampleKeys = new Set()

  for (const diagnostic of sorted) {
    if (samples.length >= MAX_DIAGNOSTIC_SAMPLES) break
    const codeSamples = samplesPerCode.get(diagnostic.code) ?? 0
    if (codeSamples >= MAX_DIAGNOSTIC_SAMPLES_PER_CODE) continue
    const sampleKey = canonicalJson(diagnostic)
    if (sampleKeys.has(sampleKey)) continue
    sampleKeys.add(sampleKey)
    samplesPerCode.set(diagnostic.code, codeSamples + 1)
    samples.push(diagnostic)
  }

  return {
    diagnosticCounts,
    diagnosticSampleLimit: {
      total: MAX_DIAGNOSTIC_SAMPLES,
      perCode: MAX_DIAGNOSTIC_SAMPLES_PER_CODE,
    },
    diagnosticSamplesTruncated: Math.max(
      0,
      safeDiagnostics.length - samples.length,
    ),
    diagnostics: samples,
  }
}

function normalizedAssetManifest(assets) {
  return assets.map((asset) => ({
    id: asset.id,
    kind: asset.kind,
    mediaType: asset.mediaType,
    rendition: asset.rendition,
    sha256: asset.sha256,
    width: asset.width ?? null,
    height: asset.height ?? null,
    sourceBoxes: asset.sourceBoxes ?? [],
    ...(asset.sourceCropBox ? { sourceCropBox: asset.sourceCropBox } : {}),
  }))
}

function normalizedVisualCandidate(candidate) {
  return {
    sourceRegionIds: candidate.sourceRegionIds ?? [],
    sourceObjectIds: candidate.sourceObjectIds ?? [],
    assetIds: candidate.assetIds ?? [],
    score: candidate.score ?? null,
    evidence: candidate.evidence ?? [],
    sourceBoxes: candidate.sourceBoxes ?? [],
  }
}

function selectedVisualCandidateSha256(relationship) {
  const selected = relationship.candidates?.[0]
  return relationship.status === 'matched' && selected
    ? canonicalJsonHash(normalizedVisualCandidate(selected))
    : null
}

function selectedVisualCropSha256(relationship, assetsById) {
  if (relationship.status !== 'matched') return null
  const crops = (relationship.assetIds ?? []).flatMap((assetId) => {
    const sourceCropBox = assetsById.get(assetId)?.sourceCropBox
    return sourceCropBox
      ? [
          {
            assetId: opaqueStructuralId('asset', assetId),
            sourceCropBox,
          },
        ]
      : []
  })
  return crops.length > 0 ? canonicalJsonHash(crops) : null
}

function preformattedSourceSha256(relationship) {
  const source = relationship.preformatted
  if (!source) return null
  return canonicalJsonHash({
    status: source.status,
    evidence: source.evidence ?? [],
    lines: (source.lines ?? []).map((line) => ({
      textSha256: opaqueStructuralId('preformatted-line-text', line.text),
      sourceRegionId: opaqueStructuralId('region', line.sourceRegionId),
      sourceLineId: opaqueStructuralId('line', line.sourceLineId),
      sourceBox: line.sourceBox,
      sourceRunBoxes: line.sourceRunBoxes ?? [],
    })),
  })
}

function normalizedVisualRelationships(relationships, assets) {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]))
  return relationships.map((relationship) => ({
    id: relationship.id,
    kind: relationship.kind,
    semanticKind: relationship.semanticKind ?? null,
    status: relationship.status,
    canonicalNodeId: relationship.canonicalNodeId ?? null,
    captionNodeId: relationship.captionNodeId ?? null,
    captionRegionId: relationship.captionRegionId ?? null,
    sourceRegionIds: relationship.sourceRegionIds ?? [],
    sourceObjectIds: relationship.sourceObjectIds ?? [],
    sourceLineIds: relationship.sourceLineIds ?? [],
    assetIds: relationship.assetIds ?? [],
    sourceBoxes: relationship.sourceBoxes ?? [],
    altTextSource: relationship.altTextSource ?? null,
    preformattedSourceSha256: preformattedSourceSha256(relationship),
    selectedCandidateSha256: selectedVisualCandidateSha256(relationship),
    selectedCropSha256: selectedVisualCropSha256(relationship, assetsById),
  }))
}

function normalizedNoteCanonicalAnchor(anchor) {
  if (anchor?.kind === 'node') {
    return {
      kind: 'node',
      nodeId: opaqueStructuralId('node', anchor.nodeId),
      start: anchor.start,
      end: anchor.end,
    }
  }
  if (anchor?.kind === 'author') {
    return {
      kind: 'author',
      authorSha256: opaqueStructuralId('author', anchor.author),
    }
  }
  return null
}

function normalizedNoteRelationships(relationships) {
  return relationships.map((relationship) => ({
    id: relationship.id,
    status: relationship.status,
    referenceRegionId: relationship.referenceRegionId,
    targetNoteId: relationship.targetNoteId ?? null,
    label: relationship.label,
    canonicalAnchor: normalizedNoteCanonicalAnchor(
      relationship.canonicalAnchor,
    ),
    sourceBoxes: relationship.sourceBoxes ?? [],
  }))
}

function opaqueStructuralId(kind, value) {
  return createHash('sha256')
    .update(`${kind}\0${String(value ?? '')}`)
    .digest('hex')
}

function normalizedCitationRelationships(relationships) {
  return relationships.map((relationship) => ({
    id: opaqueStructuralId('citation-relationship', relationship.id),
    status: relationship.status,
    taxonomy: relationship.taxonomy,
    referenceRegionId: opaqueStructuralId(
      'region',
      relationship.referenceRegionId,
    ),
    referenceStart: relationship.referenceStart,
    referenceEnd: relationship.referenceEnd,
    labels: (relationship.labels ?? []).map((label) =>
      opaqueStructuralId('citation-label', label),
    ),
    targetNodeIds: (relationship.targetNodeIds ?? []).map((nodeId) =>
      opaqueStructuralId('node', nodeId),
    ),
    canonicalAnchor: relationship.canonicalAnchor
      ? {
          ...relationship.canonicalAnchor,
          nodeId: opaqueStructuralId(
            'node',
            relationship.canonicalAnchor.nodeId,
          ),
        }
      : null,
    sourceBoxes: (relationship.sourceBoxes ?? []).map((box) => ({ ...box })),
  }))
}

function normalizedCrossReferenceTarget(target) {
  return {
    kind: target.kind,
    labelSha256: opaqueStructuralId(
      'scholarly-cross-reference-label',
      target.label,
    ),
    referenceStart: target.referenceStart,
    referenceEnd: target.referenceEnd,
    status: target.status,
    candidateNodeIds: (target.candidateNodeIds ?? []).map((nodeId) =>
      opaqueStructuralId('node', nodeId),
    ),
    targetNodeId: target.targetNodeId
      ? opaqueStructuralId('node', target.targetNodeId)
      : null,
    evidenceSha256s: [...new Set(target.evidence ?? [])].map((evidence) =>
      opaqueStructuralId('scholarly-cross-reference-evidence', evidence),
    ),
  }
}

function normalizedCrossReferenceRelationships(relationships) {
  return relationships.map((relationship) => ({
    id: opaqueStructuralId(
      'scholarly-cross-reference-relationship',
      relationship.id,
    ),
    kind: relationship.kind,
    status: relationship.status,
    textSha256: opaqueStructuralId(
      'scholarly-cross-reference-text',
      relationship.text,
    ),
    referenceRegionId: opaqueStructuralId(
      'region',
      relationship.referenceRegionId,
    ),
    referenceStart: relationship.referenceStart,
    referenceEnd: relationship.referenceEnd,
    labels: (relationship.labels ?? []).map((label) =>
      opaqueStructuralId('scholarly-cross-reference-label', label),
    ),
    targets: (relationship.targets ?? []).map(normalizedCrossReferenceTarget),
    targetNodeIds: (relationship.targetNodeIds ?? []).map((nodeId) =>
      opaqueStructuralId('node', nodeId),
    ),
    canonicalAnchor: relationship.canonicalAnchor
      ? {
          ...relationship.canonicalAnchor,
          nodeId: opaqueStructuralId(
            'node',
            relationship.canonicalAnchor.nodeId,
          ),
        }
      : null,
    confidence: relationship.confidence,
    evidenceSha256s: [...new Set(relationship.evidence ?? [])].map((evidence) =>
      opaqueStructuralId('scholarly-cross-reference-evidence', evidence),
    ),
    sourceBoxes: (relationship.sourceBoxes ?? []).map((box) => ({ ...box })),
  }))
}

function normalizedNodeProvenance(nodes, provenance) {
  return nodes.map((node) => {
    const evidence = provenance?.[node.id]
    const provenanceSha256 = evidence
      ? canonicalJsonHash({
          confidence: evidence.confidence ?? null,
          pages: evidence.pages ?? [],
          regionIds: (evidence.regionIds ?? []).map((regionId) =>
            opaqueStructuralId('region', regionId),
          ),
          boxes: evidence.boxes ?? [],
          links: (evidence.links ?? []).map((link) =>
            canonicalJsonHash({ kind: 'node-source-link', link }),
          ),
          part:
            evidence.part === undefined
              ? null
              : opaqueStructuralId('provenance-part', evidence.part),
          relationshipIds: (evidence.relationshipIds ?? []).map(
            (relationshipId) =>
              opaqueStructuralId('relationship', relationshipId),
          ),
        })
      : null
    return {
      nodeId: opaqueStructuralId('node', node.id),
      provenanceSha256,
    }
  })
}

function lineTransitionLedger(reconstruction) {
  for (const key of [
    'lineBoundaryDecisions',
    'lineTransitions',
    'transitionDecisions',
    'lineJoinDecisions',
  ]) {
    if (Array.isArray(reconstruction[key])) {
      return { available: true, decisions: reconstruction[key] }
    }
  }
  return { available: false, decisions: [] }
}

const LINE_TRANSITION_OUTCOMES = new Set([
  'space',
  'no-space',
  'preserved-lexical-hyphen',
  'removed-discretionary-hyphen',
  'structural-boundary',
  'unresolved',
  'unresolved-corrupting-join',
])

function lineTransitionOutcome(decision) {
  const outcome = String(
    decision.outcome ?? decision.decision ?? decision.kind ?? '',
  )
  if (!LINE_TRANSITION_OUTCOMES.has(outcome)) {
    throw new Error('Line transition decision outcome is invalid.')
  }
  return outcome
}

function lineTransitionCounts(reconstruction, ledger) {
  if (!ledger.available) {
    return {
      unresolvedCorruptingJoinCount: null,
      structurallyConsumedLineBoundaryCount: null,
    }
  }
  let unresolvedCorruptingJoinCount = 0
  let structurallyConsumedLineBoundaryCount = 0
  for (const decision of ledger.decisions) {
    const outcome = lineTransitionOutcome(decision)
    if (outcome === 'structural-boundary') {
      structurallyConsumedLineBoundaryCount += 1
    } else if (
      outcome === 'unresolved' ||
      outcome === 'unresolved-corrupting-join'
    ) {
      unresolvedCorruptingJoinCount += 1
    }
  }
  const reportedUnresolved = reconstruction.unresolvedCorruptingJoinCount
  const reportedStructurallyConsumed =
    reconstruction.structurallyConsumedLineBoundaryCount
  if (
    (reportedUnresolved !== undefined &&
      (!Number.isInteger(reportedUnresolved) ||
        reportedUnresolved < 0 ||
        reportedUnresolved !== unresolvedCorruptingJoinCount)) ||
    (reportedStructurallyConsumed !== undefined &&
      (!Number.isInteger(reportedStructurallyConsumed) ||
        reportedStructurallyConsumed < 0 ||
        reportedStructurallyConsumed !==
          structurallyConsumedLineBoundaryCount)) ||
    unresolvedCorruptingJoinCount + structurallyConsumedLineBoundaryCount >
      ledger.decisions.length
  ) {
    throw new Error('Line transition counts do not match the decision ledger.')
  }
  return {
    unresolvedCorruptingJoinCount,
    structurallyConsumedLineBoundaryCount,
  }
}

export function createPdfStructuralReceipt(reconstruction) {
  const nodes = reconstruction.paper?.nodes ?? []
  const sourceAssets = reconstruction.assets ?? []
  const visualRelationships = normalizedVisualRelationships(
    reconstruction.visualRelationships ?? [],
    sourceAssets,
  )
  const noteRelationships = normalizedNoteRelationships(
    reconstruction.noteRelationships ?? [],
  )
  const citationRelationships = normalizedCitationRelationships(
    reconstruction.citationRelationships ?? [],
  )
  const crossReferenceRelationships = normalizedCrossReferenceRelationships(
    reconstruction.crossReferenceRelationships ?? [],
  )
  const assets = normalizedAssetManifest(sourceAssets)
  const nodeProvenance = normalizedNodeProvenance(
    nodes,
    reconstruction.provenance,
  )
  const transitionLedger = lineTransitionLedger(reconstruction)
  const transitions = transitionLedger.decisions
  const transitionCounts = lineTransitionCounts(
    reconstruction,
    transitionLedger,
  )
  return {
    schemaVersion: PDF_STRUCTURAL_RECEIPT_SCHEMA_VERSION,
    canonicalNodeCount: nodes.length,
    canonicalNodeSequenceSha256: canonicalJsonHash(
      nodes.map((node) => node.id),
    ),
    canonicalNodeTypeSequenceSha256: canonicalJsonHash(
      nodes.map((node) => node.type),
    ),
    canonicalContentSha256: canonicalJsonHash(
      reconstruction.paper ?? { nodes },
    ),
    canonicalNodeProvenanceSha256: canonicalJsonHash(nodeProvenance),
    readingOrderGraphSha256: canonicalJsonHash(
      reconstruction.readingOrder ?? null,
    ),
    nodeCounts: countsBy(nodes, (node) => node.type),
    visualRelationshipCount: visualRelationships.length,
    visualRelationshipCounts: countsBy(
      visualRelationships,
      (relationship) => `${relationship.kind}:${relationship.status}`,
    ),
    visualRelationshipGraphSha256: canonicalJsonHash(visualRelationships),
    noteRelationshipCount: noteRelationships.length,
    noteRelationshipCounts: countsBy(
      noteRelationships,
      (relationship) => relationship.status,
    ),
    noteRelationshipGraphSha256: canonicalJsonHash(noteRelationships),
    citationRelationshipCount: citationRelationships.length,
    citationRelationshipCounts: countsBy(
      citationRelationships,
      (relationship) => relationship.status,
    ),
    citationRelationshipGraph: citationRelationships,
    citationRelationshipGraphSha256: canonicalJsonHash(citationRelationships),
    crossReferenceRelationshipCount: crossReferenceRelationships.length,
    crossReferenceRelationshipCounts: countsBy(
      crossReferenceRelationships,
      (relationship) => `${relationship.kind}:${relationship.status}`,
    ),
    crossReferenceRelationshipGraph: crossReferenceRelationships,
    crossReferenceRelationshipGraphSha256: canonicalJsonHash(
      crossReferenceRelationships,
    ),
    assetCount: assets.length,
    assetCounts: countsBy(assets, (asset) => asset.kind),
    assetManifestSha256: canonicalJsonHash(assets),
    lineTransitionLedgerAvailable: transitionLedger.available,
    lineTransitionCount: transitions.length,
    lineTransitionLedgerSha256: transitionLedger.available
      ? canonicalJsonHash(transitions)
      : null,
    ...transitionCounts,
  }
}

export async function createPdfPipeline() {
  const cacheDir = await mkdtemp(join(tmpdir(), 'srt-pdf-vite-'))
  const vite = await createServer({
    appType: 'custom',
    cacheDir,
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  const standardFontDataUrl = new URL(
    '../node_modules/pdfjs-dist/standard_fonts/',
    import.meta.url,
  ).href
  const [pdf, quality, importTypes] = await Promise.all([
    vite.ssrLoadModule('/src/research/pdf.ts'),
    vite.ssrLoadModule('/src/research/pdf-quality.ts'),
    vite.ssrLoadModule('/src/research/import-types.ts'),
  ])
  let exportModules
  let diagnosticModules
  let decisionModules

  return {
    reconstructPdf: pdf.reconstructPdf,
    policy: quality.DEFAULT_PDF_COMPLETENESS_POLICY,
    maximumBytes: importTypes.MAX_LOCAL_PDF_BYTES,
    standardFontDataUrl,
    async loadExportModules() {
      exportModules ??= Promise.all([
        vite.ssrLoadModule('/src/research/epub.ts'),
        vite.ssrLoadModule('/src/research/targets.ts'),
      ]).then(([epub, targets]) => ({
        buildEpub: epub.buildEpub,
        buildReadableEpub: epub.buildReadableEpub,
        projectReadableFallbackReconstruction:
          epub.projectReadableFallbackReconstruction,
        inspectEpub: epub.inspectEpub,
        getTargetProfile: targets.getTargetProfile,
        targetProfileIds: targets.TARGET_PROFILE_IDS,
      }))
      return exportModules
    },
    async loadDiagnosticModules() {
      diagnosticModules ??= vite
        .ssrLoadModule('/src/research/diagnostic-overlays.ts')
        .then((overlays) => ({
          renderDiagnosticEvidenceHtml: overlays.renderDiagnosticEvidenceHtml,
        }))
      return diagnosticModules
    },
    async loadDecisionModules() {
      decisionModules ??= vite
        .ssrLoadModule('/src/research/decision-record.ts')
        .then((decisions) => ({
          applyHumanDecisionFile: decisions.applyHumanDecisionFile,
          parseHumanDecisionFile: decisions.parseHumanDecisionFile,
          maximumBytes: decisions.MAX_HUMAN_DECISION_FILE_BYTES,
        }))
      return decisionModules
    },
    async close() {
      try {
        await vite.close()
      } finally {
        await rm(cacheDir, { recursive: true, force: true })
      }
    },
  }
}

export async function auditPdfPath(
  path,
  pipeline,
  { expectedSource = null } = {},
) {
  const stableBasename = basename(path)
  try {
    if (
      expectedSource &&
      basename(stableBasename, extname(stableBasename)) !== expectedSource.id
    ) {
      throw new Error('PDF_CORPUS_CONTRACT_MISMATCH')
    }
    const details = await stat(path)
    if (expectedSource && details.size !== expectedSource.byteLength) {
      throw new Error('PDF_CORPUS_CONTRACT_MISMATCH')
    }
    if (details.size > pipeline.maximumBytes) {
      return {
        document: {
          basename: stableBasename,
          sha256: null,
          code: 'OVERSIZED_PDF',
          message: SAFE_FAILURE_MESSAGES.OVERSIZED_PDF,
        },
      }
    }
    const bytes = await readFile(path)
    if (
      expectedSource &&
      (bytes.byteLength !== expectedSource.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !==
          expectedSource.sha256)
    ) {
      throw new Error('PDF_CORPUS_CONTRACT_MISMATCH')
    }
    const reconstruction = await pipeline.reconstructPdf(
      new File([bytes], stableBasename, {
        type: 'application/pdf',
        lastModified: 0,
      }),
      undefined,
      { standardFontDataUrl: pipeline.standardFontDataUrl },
    )
    return {
      reconstruction,
      document: {
        basename: stableBasename,
        sha256: reconstruction.source.sha256,
        byteLength: reconstruction.source.byteLength,
        pageCount: reconstruction.source.pageCount,
        completeness: reconstruction.completeness,
        readiness: reconstruction.readiness,
        structure: createPdfStructuralReceipt(reconstruction),
        ...summarizeAuditDiagnostics(reconstruction.diagnostics),
      },
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'PDF_CORPUS_CONTRACT_MISMATCH'
    ) {
      throw error
    }
    return {
      document: {
        basename: stableBasename,
        sha256: null,
        ...safeError(error),
      },
    }
  }
}

export async function auditPdfInputs(
  inputs,
  pipeline,
  { corpusContract = null } = {},
) {
  const records = []
  const expectedById = new Map(
    (corpusContract?.documents ?? []).map((document) => [
      document.id,
      document,
    ]),
  )
  for (const path of await pdfPaths(inputs)) {
    const id = basename(path, extname(path))
    const expectedSource = expectedById.get(id) ?? null
    if (corpusContract && !expectedSource) {
      throw new Error('PDF_CORPUS_CONTRACT_MISMATCH')
    }
    records.push({
      path,
      ...(await auditPdfPath(path, pipeline, {
        expectedSource,
      })),
    })
  }
  if (corpusContract && records.length !== corpusContract.documents.length) {
    throw new Error('PDF_CORPUS_CONTRACT_MISMATCH')
  }
  records.sort(
    (left, right) =>
      left.document.basename.localeCompare(right.document.basename) ||
      String(left.document.sha256).localeCompare(String(right.document.sha256)),
  )
  return records
}

export function canonicalPassRate(numerator, denominator) {
  if (denominator === 0) return 0
  return Math.round((numerator / denominator) * 100_000) / 100_000
}

function failureReasons(documents) {
  const buckets = new Map()
  for (const document of documents) {
    const codes = document.readiness
      ? document.readiness.ready
        ? []
        : document.readiness.blockingDiagnosticCodes
      : [document.code]
    for (const code of new Set(codes)) {
      buckets.set(code, (buckets.get(code) ?? 0) + 1)
    }
  }
  return Object.fromEntries(
    [...buckets].sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function createCorpusReport(
  documents,
  policy,
  { corpusContract = null } = {},
) {
  const summary = {
    documents: documents.length,
    ready: documents.filter((document) => document.readiness?.ready).length,
    reviewRequired: documents.filter(
      (document) => document.readiness && !document.readiness.ready,
    ).length,
    failed: documents.filter((document) => !document.readiness).length,
  }
  return {
    schemaVersion: PDF_CORPUS_REPORT_SCHEMA_VERSION,
    reportSchema: 'docs/schemas/pdf-corpus-audit.schema.json',
    privacy: 'basenames-hashes-metrics-diagnostics-only',
    policy,
    ...(corpusContract ? { corpusContract } : {}),
    summary: {
      ...summary,
      passRate: canonicalPassRate(summary.ready, summary.documents),
      failureReasons: failureReasons(documents),
    },
    documents,
  }
}

export function serializeCorpusReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}

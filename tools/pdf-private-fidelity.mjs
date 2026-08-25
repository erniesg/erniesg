#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseHtml } from 'parse5'
import {
  requiredPrivateEpubCheckValidator,
  validatePrivateEpubWithEpubCheck,
} from './pdf-private-fidelity-epubcheck.mjs'
import {
  canonicalJsonHash,
  createPdfPipeline,
  createPdfStructuralReceipt,
  PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE_SHA256S,
  PDF_HYPHEN_LEXICAL_MODEL_RECEIPT,
  PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE_RECEIPT,
  PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE_SHA256S,
  PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE_SHA256S,
  PDF_STRUCTURAL_RECEIPT_SCHEMA_VERSION,
  validPdfCitationRelationshipTargetState,
} from './pdf-corpus-audit-lib.mjs'

export const PDF_PRIVATE_FIDELITY_SCHEMA_VERSION = '1.9.0'
const PDF_PRIVATE_FIDELITY_PRIVACY =
  'public-id-hash-aggregate-counters-artifact-hashes-only'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_BASELINE_RECEIPT_BYTES = 16 * 1024 * 1024
const ARTIFACT_MODES = ['publication', 'readable-fallback']
const INLINE_SEMANTIC_LEDGER_SCHEMA_VERSION = '1.0.0'
const PRIVATE_FAILURE_CODES = new Set([
  'ARTIFACT_HASH_MISMATCH',
  'EPUBCHECK_FAILED',
  'EPUBCHECK_REQUIRED',
  'EPUBCHECK_RESULT_INVALID',
  'EPUB_CONTENT_MISSING',
  'EPUB_INLINE_SEMANTIC_LEDGER_INVALID',
  'INVALID_PRIVATE_FIDELITY_BASELINE',
  'INVALID_USAGE',
  'OUTPUT_DIRECTORY_NOT_OWNER_ONLY',
  'OUTPUT_MUST_BE_NEW_EXTERNAL_DIRECTORY',
  'PRIVATE_DECISION_SET_IDENTITY_MISMATCH',
  'PRIVATE_DECISION_SET_INVALID',
  'PRIVATE_DECISION_SET_STALE',
  'SOURCE_IDENTITY_MISMATCH',
  'UNKNOWN_PROFILE',
  'UNSAFE_PRIVATE_RECEIPT_IDENTIFIER',
])
let privateFailureStage = 'entry'

function usage() {
  return 'Usage: npm --silent run pdf:private-fidelity -- --input-env <ENV_NAME> --paper-id <public-id> --expected-size <bytes> --expected-sha256 <sha256> --profiles <id,...> --repeat <count> --out <new-external-directory> [--decisions-env <ENV_NAME> --expected-decisions-sha256 <sha256>] [--baseline <external-sanitized-receipt> --expected-baseline-sha256 <accepted-receipt-sha256>] [--require-epubcheck] [--safe-error-diagnostic]\n'
}

function valueAfter(arguments_, index) {
  const value = arguments_[index + 1]
  if (!value || value.startsWith('--')) throw new Error('INVALID_USAGE')
  return value
}

export function parsePrivateFidelityArguments(
  arguments_,
  environment = process.env,
) {
  const values = {}
  let safeErrorDiagnostic = false
  let requireEpubCheck = false
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--safe-error-diagnostic') {
      if (safeErrorDiagnostic) throw new Error('INVALID_USAGE')
      safeErrorDiagnostic = true
      continue
    }
    if (argument === '--require-epubcheck') {
      if (requireEpubCheck) throw new Error('INVALID_USAGE')
      requireEpubCheck = true
      continue
    }
    if (!argument.startsWith('--')) throw new Error('INVALID_USAGE')
    const equals = argument.indexOf('=')
    const key = argument.slice(2, equals < 0 ? undefined : equals)
    const value =
      equals < 0 ? valueAfter(arguments_, index) : argument.slice(equals + 1)
    if (equals < 0) index += 1
    if (!value || Object.hasOwn(values, key)) throw new Error('INVALID_USAGE')
    values[key] = value
  }

  const optional = [
    'baseline',
    'expected-baseline-sha256',
    'expected-decisions-sha256',
  ]
  const inputKeys = ['input-env', 'decisions-env']
  const required = [
    'paper-id',
    'expected-size',
    'expected-sha256',
    'profiles',
    'repeat',
    'out',
  ]
  if (
    Object.keys(values).some(
      (key) =>
        !inputKeys.includes(key) &&
        !required.includes(key) &&
        !optional.includes(key),
    ) ||
    required.some((key) => !values[key]) ||
    !values['input-env'] ||
    Boolean(values.baseline) !== Boolean(values['expected-baseline-sha256']) ||
    Boolean(values['decisions-env']) !==
      Boolean(values['expected-decisions-sha256'])
  ) {
    throw new Error('INVALID_USAGE')
  }

  const inputEnvironmentName = values['input-env']
  if (
    inputEnvironmentName &&
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(inputEnvironmentName)
  ) {
    throw new Error('INVALID_USAGE')
  }
  const input = environment[inputEnvironmentName]
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('INVALID_USAGE')
  }
  const decisionsEnvironmentName = values['decisions-env']
  if (
    decisionsEnvironmentName !== undefined &&
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(decisionsEnvironmentName)
  ) {
    throw new Error('INVALID_USAGE')
  }
  const decisions = decisionsEnvironmentName
    ? environment[decisionsEnvironmentName]
    : undefined
  if (
    decisionsEnvironmentName &&
    (typeof decisions !== 'string' || decisions.length === 0)
  ) {
    throw new Error('INVALID_USAGE')
  }

  const expectedSize = Number(values['expected-size'])
  const repeat = Number(values.repeat)
  const expectedSha256 = values['expected-sha256'].toLowerCase()
  const expectedBaselineSha256 =
    values['expected-baseline-sha256']?.toLowerCase()
  const expectedDecisionsSha256 =
    values['expected-decisions-sha256']?.toLowerCase()
  const requestedProfiles = values.profiles.split(',')
  const profiles = [...new Set(requestedProfiles)]
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize <= 0 ||
    !Number.isSafeInteger(repeat) ||
    repeat < 2 ||
    !/^[0-9a-f]{64}$/.test(expectedSha256) ||
    (expectedBaselineSha256 !== undefined &&
      !SHA256_PATTERN.test(expectedBaselineSha256)) ||
    (expectedDecisionsSha256 !== undefined &&
      !SHA256_PATTERN.test(expectedDecisionsSha256)) ||
    profiles.length === 0 ||
    requestedProfiles.some((profile) => profile.length === 0) ||
    profiles.length !== requestedProfiles.length ||
    !/^[A-Za-z0-9._-]+$/.test(values['paper-id'])
  ) {
    throw new Error('INVALID_USAGE')
  }

  return {
    input: resolve(input),
    outputDirectory: resolve(values.out),
    paperId: values['paper-id'],
    expectedSize,
    expectedSha256,
    profiles,
    repeat,
    baseline: values.baseline ? resolve(values.baseline) : null,
    expectedBaselineSha256: expectedBaselineSha256 ?? null,
    decisions: decisions ? resolve(decisions) : null,
    expectedDecisionsSha256: expectedDecisionsSha256 ?? null,
    requireEpubCheck,
    safeErrorDiagnostic,
  }
}

export function safePrivateFailureDiagnostic(
  error,
  stage = privateFailureStage,
) {
  const candidateClass =
    error && typeof error === 'object' && 'name' in error
      ? String(error.name)
      : 'Error'
  const systemCode =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : null
  const safeValue = (value, fallback) =>
    SAFE_IDENTIFIER_PATTERN.test(value) ? value : fallback
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : ''
  const candidateCode =
    systemCode ??
    (PRIVATE_FAILURE_CODES.has(message) ? message : 'UNCLASSIFIED')
  return {
    errorClass: safeValue(candidateClass, 'Error'),
    errorCode: safeValue(candidateCode, 'UNCLASSIFIED'),
    messageSha256: sha256(message),
    stage: safeValue(stage, 'unclassified-stage'),
  }
}

export function applyPrivateDecisionSet(
  reconstruction,
  decisionFile,
  applyHumanDecisionFile,
) {
  const adjudicated = applyHumanDecisionFile(reconstruction, decisionFile)
  if (
    adjudicated.humanAdjudications.stale.length > 0 ||
    adjudicated.humanAdjudications.applied.length !==
      decisionFile.decisions.length
  ) {
    throw new Error('PRIVATE_DECISION_SET_STALE')
  }
  return adjudicated
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function exactCoverage(resolved, expected) {
  return expected === 0
    ? 1
    : Math.round((resolved / expected) * 100_000) / 100_000
}

function safeCounterKey(value) {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error('UNSAFE_PRIVATE_RECEIPT_IDENTIFIER')
  }
  return value
}

function diagnosticCounts(diagnostics) {
  const counts = new Map()
  for (const diagnostic of diagnostics) {
    const key = safeCounterKey(`${diagnostic.severity}:${diagnostic.code}`)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  )
}

function nodeCounts(nodes) {
  const counts = new Map()
  for (const node of nodes) {
    const key = safeCounterKey(node.type)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  )
}

function relationshipCounts(relationships) {
  const counts = new Map()
  for (const relationship of relationships) {
    const key = safeCounterKey(`${relationship.kind}:${relationship.status}`)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  )
}

function stableArtifactId(value) {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9_.:-]/g, '-')
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `n-${cleaned}`
}

function normalizedExternalHref(value) {
  if (typeof value !== 'string') return null
  if (/[\u0000-\u0020\u007f\\]/u.test(value)) return null
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return null
    return parsed.href.replace(
      /[<>"{}|^`]/gu,
      (character) =>
        `%${character.codePointAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
    )
  } catch {
    return null
  }
}

function externalHref(value) {
  return normalizedExternalHref(value) !== null
}

function normalizedSemanticRanges(ranges) {
  const sorted = ranges
    .filter(
      (range) =>
        range.start >= 0 &&
        range.start < range.end &&
        typeof range.kind === 'string' &&
        range.kind.length > 0,
    )
    .sort(
      (left, right) =>
        left.nodeSha256.localeCompare(right.nodeSha256) ||
        left.kind.localeCompare(right.kind) ||
        left.start - right.start ||
        left.end - right.end,
    )
  const normalized = []
  for (const range of sorted) {
    const previous = normalized.at(-1)
    if (
      previous &&
      previous.nodeSha256 === range.nodeSha256 &&
      previous.kind === range.kind &&
      range.start <= previous.end
    ) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      normalized.push({ ...range })
    }
  }
  return normalized
}

function normalizedSemanticRelationships(relationships) {
  const sorted = relationships
    .filter(
      (relationship) =>
        relationship.start >= 0 &&
        relationship.start < relationship.end &&
        typeof relationship.kind === 'string' &&
        relationship.kind.length > 0 &&
        SHA256_PATTERN.test(relationship.relationshipSha256) &&
        relationship.targetSha256s.every((target) =>
          SHA256_PATTERN.test(target),
        ),
    )
    .sort((left, right) => {
      const leftTargets = left.targetSha256s.join(':')
      const rightTargets = right.targetSha256s.join(':')
      return (
        left.nodeSha256.localeCompare(right.nodeSha256) ||
        left.kind.localeCompare(right.kind) ||
        left.relationshipSha256.localeCompare(right.relationshipSha256) ||
        leftTargets.localeCompare(rightTargets) ||
        left.start - right.start ||
        left.end - right.end
      )
    })
  const normalized = []
  for (const relationship of sorted) {
    const previous = normalized.at(-1)
    if (
      previous &&
      previous.nodeSha256 === relationship.nodeSha256 &&
      previous.kind === relationship.kind &&
      previous.relationshipSha256 === relationship.relationshipSha256 &&
      canonicalJsonHash(previous.targetSha256s) ===
        canonicalJsonHash(relationship.targetSha256s) &&
      relationship.start <= previous.end
    ) {
      previous.end = Math.max(previous.end, relationship.end)
    } else {
      normalized.push({
        ...relationship,
        targetSha256s: [...relationship.targetSha256s],
      })
    }
  }
  return normalized
}

function inlineSemanticLedgerEvidence(ranges, relationships) {
  const semanticRanges = normalizedSemanticRanges(ranges)
  const semanticRelationships = normalizedSemanticRelationships(relationships)
  const nodeSha256s = new Set([
    ...semanticRanges.map((range) => range.nodeSha256),
    ...semanticRelationships.map((relationship) => relationship.nodeSha256),
  ])
  return {
    schemaVersion: INLINE_SEMANTIC_LEDGER_SCHEMA_VERSION,
    nodeCount: nodeSha256s.size,
    semanticRangeCount: semanticRanges.length,
    relationshipCount: semanticRelationships.length,
    relationshipTargetCount: semanticRelationships.reduce(
      (total, relationship) => total + relationship.targetSha256s.length,
      0,
    ),
    semanticRangeLedgerSha256: canonicalJsonHash(semanticRanges),
    relationshipTargetLedgerSha256: canonicalJsonHash(semanticRelationships),
  }
}

function semanticNodeSha256(nodeId) {
  return opaqueTopologyId('canonical-node', nodeId)
}

function semanticRelationship({
  nodeSha256,
  start,
  end,
  kind,
  relationshipId,
  targetIds,
}) {
  return {
    nodeSha256,
    start,
    end,
    kind,
    relationshipSha256: opaqueTopologyId(
      'semantic-relationship',
      stableArtifactId(relationshipId),
    ),
    targetSha256s: [...new Set(targetIds.map(stableArtifactId))].map((target) =>
      opaqueTopologyId('semantic-target', target),
    ),
  }
}

function canonicalInlineSemanticLedger(nodes) {
  const ranges = []
  const relationships = []
  for (const node of nodes) {
    if (typeof node.id !== 'string' || typeof node.text !== 'string') continue
    const nodeSha256 = semanticNodeSha256(node.id)
    for (const run of node.inlineRuns ?? []) {
      if (
        !Number.isSafeInteger(run.start) ||
        !Number.isSafeInteger(run.end) ||
        run.start < 0 ||
        run.start >= run.end ||
        run.end > node.text.length
      ) {
        continue
      }
      const addRange = (kind) =>
        ranges.push({ nodeSha256, start: run.start, end: run.end, kind })
      if (run.bold === true) addRange('bold')
      if (run.italic === true) addRange('italic')
      if (run.verticalAlign === 'superscript') addRange('superscript')
      if (run.verticalAlign === 'subscript') addRange('subscript')
      if (externalHref(run.href)) {
        const href = normalizedExternalHref(run.href)
        if (!href) continue
        addRange('external-link')
        relationships.push(
          semanticRelationship({
            nodeSha256,
            start: run.start,
            end: run.end,
            kind: 'external-link',
            relationshipId: href,
            targetIds: [href],
          }),
        )
      }
      if (
        typeof run.semanticRole === 'string' &&
        run.semanticRole.length > 0 &&
        typeof run.relationshipId === 'string' &&
        run.relationshipId.length > 0
      ) {
        addRange(run.semanticRole)
        relationships.push(
          semanticRelationship({
            nodeSha256,
            start: run.start,
            end: run.end,
            kind: run.semanticRole,
            relationshipId: run.relationshipId,
            targetIds: Array.isArray(run.targetIds)
              ? run.targetIds.filter(
                  (target) => typeof target === 'string' && target.length > 0,
                )
              : [],
          }),
        )
      }
    }
  }
  return inlineSemanticLedgerEvidence(ranges, relationships)
}

function attributeValue(node, name) {
  return node?.attrs?.find((attribute) => attribute.name === name)?.value
}

function renderedInlineSemanticLedger(inspection) {
  const bytes = inspection.files?.['EPUB/content.xhtml']
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('EPUB_CONTENT_MISSING')
  }
  const content = new TextDecoder().decode(bytes)
  const canonicalNodeIds = Array.isArray(inspection.manifest?.canonicalNodeIds)
    ? inspection.manifest.canonicalNodeIds.filter(
        (id) => typeof id === 'string' && id.length > 0,
      )
    : []
  const sourceIdByArtifactId = new Map()
  for (const nodeId of canonicalNodeIds) {
    const artifactId = stableArtifactId(nodeId)
    if (sourceIdByArtifactId.has(artifactId)) {
      throw new Error('EPUB_INLINE_SEMANTIC_LEDGER_INVALID')
    }
    sourceIdByArtifactId.set(artifactId, nodeId)
  }
  const document = parseHtml(content)
  const canonicalElements = []
  const collectCanonicalElements = (node) => {
    const artifactId = attributeValue(node, 'data-canonical-id')
    if (artifactId) canonicalElements.push(node)
    for (const child of node.childNodes ?? []) collectCanonicalElements(child)
  }
  collectCanonicalElements(document)
  if (
    canonicalElements.length !== canonicalNodeIds.length ||
    canonicalElements.some(
      (node, index) =>
        attributeValue(node, 'data-canonical-id') !==
        stableArtifactId(canonicalNodeIds[index]),
    )
  ) {
    throw new Error('EPUB_INLINE_SEMANTIC_LEDGER_INVALID')
  }

  const ranges = []
  const relationships = []
  for (const canonicalElement of canonicalElements) {
    const artifactNodeId = attributeValue(canonicalElement, 'data-canonical-id')
    const nodeId = sourceIdByArtifactId.get(artifactNodeId)
    if (!nodeId) throw new Error('EPUB_INLINE_SEMANTIC_LEDGER_INVALID')
    const nodeSha256 = semanticNodeSha256(nodeId)
    let cursor = 0
    const walk = (node, root) => {
      if (node.nodeName === '#text') {
        cursor += String(node.value ?? '').length
        return
      }
      if (node !== root && attributeValue(node, 'data-canonical-id')) return
      if (
        String(attributeValue(node, 'class') ?? '')
          .split(/\s+/u)
          .includes('preserved-list-marker') ||
        attributeValue(node, 'aria-hidden') === 'true' ||
        attributeValue(node, 'data-semantic-ledger-ignore') === 'true'
      ) {
        return
      }
      const start = cursor
      for (const child of node.childNodes ?? []) walk(child, root)
      const end = cursor
      if (start >= end || typeof node.tagName !== 'string') return
      const kindByTag = {
        strong: 'bold',
        em: 'italic',
        sup: 'superscript',
        sub: 'subscript',
      }
      const formattingKind = kindByTag[node.tagName]
      if (formattingKind) {
        ranges.push({ nodeSha256, start, end, kind: formattingKind })
      }
      const href = attributeValue(node, 'href')
      const epubType = String(attributeValue(node, 'epub:type') ?? '')
        .split(/\s+/u)
        .filter(Boolean)
      const relationshipId = attributeValue(node, 'data-relationship-id')
      const declaredRole = attributeValue(node, 'data-semantic-role')
      const semanticRole =
        declaredRole ||
        (relationshipId && epubType.includes('biblioref') ? 'citation' : null)
      if (externalHref(href) && !epubType.includes('noteref')) {
        ranges.push({ nodeSha256, start, end, kind: 'external-link' })
        relationships.push(
          semanticRelationship({
            nodeSha256,
            start,
            end,
            kind: 'external-link',
            relationshipId: href,
            targetIds: [href],
          }),
        )
      }
      if (semanticRole && relationshipId) {
        const declaredTargets = String(
          attributeValue(node, 'data-target-ids') ?? '',
        )
          .split(/\s+/u)
          .filter(Boolean)
        const targetIds =
          declaredTargets.length > 0
            ? declaredTargets
            : semanticRole === 'citation' && href?.startsWith('#')
              ? [href.slice(1)]
              : []
        ranges.push({ nodeSha256, start, end, kind: semanticRole })
        relationships.push(
          semanticRelationship({
            nodeSha256,
            start,
            end,
            kind: semanticRole,
            relationshipId,
            targetIds,
          }),
        )
      }
    }
    walk(canonicalElement, canonicalElement)
  }
  return inlineSemanticLedgerEvidence(ranges, relationships)
}

function sortedStrings(values) {
  return values.map((value) => String(value ?? '')).sort()
}

function normalizedSelectedVisualCandidate(candidate) {
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
    ? canonicalJsonHash(normalizedSelectedVisualCandidate(selected))
    : null
}

function selectedVisualCropSha256(
  relationship,
  sourceAssetIdFor,
  sourceCropBoxFor,
) {
  if (relationship.status !== 'matched') return null
  const crops = (relationship.assetIds ?? []).flatMap((assetId) => {
    const sourceCropBox = sourceCropBoxFor(assetId)
    return sourceCropBox
      ? [
          {
            assetId: opaqueTopologyId('asset', sourceAssetIdFor(assetId)),
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
      textSha256: opaqueTopologyId('preformatted-line-text', line.text),
      sourceRegionId: opaqueTopologyId('region', line.sourceRegionId),
      sourceLineId: opaqueTopologyId('line', line.sourceLineId),
      sourceBox: line.sourceBox,
      sourceRunBoxes: line.sourceRunBoxes ?? [],
    })),
  })
}

function equationTranscriptSourceSha256(relationship) {
  return relationship.kind === 'equation' &&
    typeof relationship.sourceText === 'string' &&
    relationship.sourceText.length > 0
    ? opaqueTopologyId('equation-transcript-text', relationship.sourceText)
    : null
}

function equationTranscriptAdjudicationSha256(relationship) {
  return relationship.kind === 'equation' &&
    relationship.equationTranscriptAdjudication
    ? canonicalJsonHash(relationship.equationTranscriptAdjudication)
    : null
}

function equationGeometryTranscriptSha256(relationship) {
  return relationship.kind === 'equation' &&
    relationship.equationGeometryTranscript
    ? canonicalJsonHash(relationship.equationGeometryTranscript)
    : null
}

function normalizedRelationshipParity(
  relationships,
  sourceAssetIdFor,
  sourceCropBoxFor,
) {
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
    assetIds: (relationship.assetIds ?? []).map(sourceAssetIdFor),
    sourceBoxes: relationship.sourceBoxes ?? [],
    altTextSource: relationship.altTextSource ?? null,
    preformattedSourceSha256: preformattedSourceSha256(relationship),
    ...(relationship.kind === 'equation' &&
    ((typeof relationship.sourceText === 'string' &&
      relationship.sourceText.length > 0) ||
      relationship.equationTranscriptAdjudication ||
      relationship.equationGeometryTranscript)
      ? {
          equationTranscriptSourceSha256:
            equationTranscriptSourceSha256(relationship),
          equationTranscriptAdjudicationSha256:
            equationTranscriptAdjudicationSha256(relationship),
          equationGeometryTranscriptSha256:
            equationGeometryTranscriptSha256(relationship),
        }
      : {}),
    selectedCandidateSha256: selectedVisualCandidateSha256(relationship),
    selectedCropSha256: selectedVisualCropSha256(
      relationship,
      sourceAssetIdFor,
      sourceCropBoxFor,
    ),
  }))
}

function artifactParityFromReconstruction(
  reconstruction,
  inlineSemanticLedger,
  mode,
  projectionOverride,
) {
  if (mode === 'readable-fallback' && !projectionOverride) {
    throw new Error('READABLE_FALLBACK_PROJECTION_REQUIRED')
  }
  const projection = projectionOverride ?? reconstruction
  const nodes = projection.paper?.nodes ?? []
  const relationships = projection.visualRelationships ?? []
  const assets = projection.assets ?? []
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]))
  return {
    canonicalNodeCount: nodes.length,
    canonicalNodeSequenceSha256: canonicalJsonHash(
      nodes.map((node) => node.id),
    ),
    canonicalContentSha256: sha256(JSON.stringify(projection.paper)),
    relationshipCount: relationships.length,
    relationshipGraphSha256: canonicalJsonHash(
      normalizedRelationshipParity(
        relationships,
        (assetId) => assetId,
        (assetId) => assetsById.get(assetId)?.sourceCropBox ?? null,
      ),
    ),
    assetCount: assets.length,
    assetManifestSha256: canonicalJsonHash(
      sortedStrings(assets.map((asset) => asset.id)),
    ),
    inlineSemanticLedger,
  }
}

function artifactParityByMode(
  reconstruction,
  inlineSemanticLedger,
  artifactProjections,
) {
  return Object.fromEntries(
    ARTIFACT_MODES.map((mode) => [
      mode,
      artifactParityFromReconstruction(
        reconstruction,
        artifactProjections?.[mode]
          ? canonicalInlineSemanticLedger(
              artifactProjections[mode].paper?.nodes ?? [],
            )
          : inlineSemanticLedger,
        mode,
        artifactProjections?.[mode],
      ),
    ]),
  )
}

function artifactParityFromManifest(manifest, inlineSemanticLedger) {
  const assets = Array.isArray(manifest.assets) ? manifest.assets : []
  const sourceAssetIds = new Map(
    assets.map((asset) => [
      String(asset?.id ?? ''),
      String(asset?.sourceAssetId ?? ''),
    ]),
  )
  const relationships = Array.isArray(manifest.visualRelationships)
    ? manifest.visualRelationships
    : []
  const canonicalNodeIds = Array.isArray(manifest.canonicalNodeIds)
    ? manifest.canonicalNodeIds
    : []
  return {
    canonicalNodeCount: canonicalNodeIds.length,
    canonicalNodeSequenceSha256: canonicalJsonHash(canonicalNodeIds),
    canonicalContentSha256: manifest.canonicalContentSha256 ?? null,
    relationshipCount: relationships.length,
    relationshipGraphSha256: canonicalJsonHash(
      normalizedRelationshipParity(
        relationships,
        (assetId) => sourceAssetIds.get(String(assetId ?? '')) ?? '',
        (assetId) =>
          assets.find((asset) => asset?.id === assetId)?.sourceCropBox ?? null,
      ),
    ),
    assetCount: assets.length,
    assetManifestSha256: canonicalJsonHash(
      sortedStrings(assets.map((asset) => asset?.sourceAssetId)),
    ),
    inlineSemanticLedger,
  }
}

function opaqueTopologyId(kind, value) {
  return sha256(`${kind}\0${String(value ?? '')}`)
}

function sanitizedCitationRelationshipGraph(relationships) {
  return relationships.map((relationship) => ({
    id: opaqueTopologyId('citation-relationship', relationship.id),
    status: relationship.status,
    taxonomy: relationship.taxonomy,
    referenceRegionId: opaqueTopologyId(
      'region',
      relationship.referenceRegionId,
    ),
    referenceStart: relationship.referenceStart,
    referenceEnd: relationship.referenceEnd,
    labels: relationship.labels.map((label) =>
      opaqueTopologyId('citation-label', label),
    ),
    targetNodeIds: relationship.targetNodeIds.map((nodeId) =>
      opaqueTopologyId('node', nodeId),
    ),
    candidateNodeIds: relationship.candidateNodeIds.map((nodeId) =>
      opaqueTopologyId('node', nodeId),
    ),
    canonicalAnchor: relationship.canonicalAnchor
      ? {
          nodeId: opaqueTopologyId('node', relationship.canonicalAnchor.nodeId),
          start: relationship.canonicalAnchor.start,
          end: relationship.canonicalAnchor.end,
        }
      : null,
    evidenceSha256s: relationship.evidenceSha256s.map((evidenceSha256) =>
      opaqueTopologyId('citation-evidence-digest', evidenceSha256),
    ),
    sourceBoxes: relationship.sourceBoxes.map((box) =>
      canonicalJsonHash({ kind: 'citation-source-box', box }),
    ),
  }))
}

function sanitizedCrossReferenceTarget(target) {
  return {
    kind: target.kind,
    labelSha256: opaqueTopologyId(
      'scholarly-cross-reference-label-digest',
      target.labelSha256,
    ),
    referenceStart: target.referenceStart,
    referenceEnd: target.referenceEnd,
    status: target.status,
    candidateNodeIds: target.candidateNodeIds.map((nodeId) =>
      opaqueTopologyId('node', nodeId),
    ),
    targetNodeId: target.targetNodeId
      ? opaqueTopologyId('node', target.targetNodeId)
      : null,
    evidenceSha256s: target.evidenceSha256s.map((evidenceSha256) =>
      opaqueTopologyId(
        'scholarly-cross-reference-evidence-digest',
        evidenceSha256,
      ),
    ),
  }
}

function sanitizedCrossReferenceRelationshipGraph(relationships) {
  return relationships.map((relationship) => ({
    id: opaqueTopologyId(
      'scholarly-cross-reference-relationship-digest',
      relationship.id,
    ),
    kind: relationship.kind,
    status: relationship.status,
    textSha256: opaqueTopologyId(
      'scholarly-cross-reference-text-digest',
      relationship.textSha256,
    ),
    referenceRegionId: opaqueTopologyId(
      'region',
      relationship.referenceRegionId,
    ),
    referenceStart: relationship.referenceStart,
    referenceEnd: relationship.referenceEnd,
    labels: relationship.labels.map((labelSha256) =>
      opaqueTopologyId('scholarly-cross-reference-label-digest', labelSha256),
    ),
    targets: relationship.targets.map(sanitizedCrossReferenceTarget),
    targetNodeIds: relationship.targetNodeIds.map((nodeId) =>
      opaqueTopologyId('node', nodeId),
    ),
    canonicalAnchor: relationship.canonicalAnchor
      ? {
          nodeId: opaqueTopologyId('node', relationship.canonicalAnchor.nodeId),
          start: relationship.canonicalAnchor.start,
          end: relationship.canonicalAnchor.end,
        }
      : null,
    confidence: relationship.confidence,
    evidenceSha256s: relationship.evidenceSha256s.map((evidenceSha256) =>
      opaqueTopologyId(
        'scholarly-cross-reference-evidence-digest',
        evidenceSha256,
      ),
    ),
    sourceBoxes: relationship.sourceBoxes.map((box) =>
      canonicalJsonHash({ kind: 'cross-reference-source-box', box }),
    ),
  }))
}

function createLineTransitionEvidence(reconstruction, structure) {
  const regions = (reconstruction.regions ?? []).map((region) => ({
    page: region.page,
    regionSha256: opaqueTopologyId('region', region.id),
    lineSha256s: (region.lines ?? []).map((line) =>
      opaqueTopologyId('line', line.id),
    ),
  }))
  const decisions = (reconstruction.lineBoundaryDecisions ?? []).map(
    (decision) => ({
      page: decision.page,
      regionSha256: opaqueTopologyId('region', decision.regionId),
      fromLineSha256: opaqueTopologyId('line', decision.fromLineId),
      toLineSha256: opaqueTopologyId('line', decision.toLineId),
      outcome: decision.outcome,
    }),
  )
  const sanitizedLedgerSha256 = structure.lineTransitionLedgerAvailable
    ? canonicalJsonHash(decisions)
    : null
  return {
    schemaVersion: '1.0.0',
    sourceLedgerSha256: structure.lineTransitionLedgerSha256,
    sanitizedLedgerSha256,
    ledgerBindingSha256: structure.lineTransitionLedgerAvailable
      ? canonicalJsonHash({
          sourceLedgerSha256: structure.lineTransitionLedgerSha256,
          sanitizedLedgerSha256,
        })
      : null,
    expectedTransitionCount: regions.reduce(
      (total, region) => total + Math.max(0, region.lineSha256s.length - 1),
      0,
    ),
    regions,
    decisions,
  }
}

function createPrivateStructuralEvidence(reconstruction, artifactParity) {
  const structure = createPdfStructuralReceipt(reconstruction)
  const citationRelationshipGraph = sanitizedCitationRelationshipGraph(
    structure.citationRelationshipGraph,
  )
  const crossReferenceRelationshipGraph =
    sanitizedCrossReferenceRelationshipGraph(
      structure.crossReferenceRelationshipGraph,
    )
  return {
    ...structure,
    citationRelationshipGraph,
    citationRelationshipGraphSha256: canonicalJsonHash(
      citationRelationshipGraph,
    ),
    crossReferenceRelationshipGraph,
    crossReferenceRelationshipGraphSha256: canonicalJsonHash(
      crossReferenceRelationshipGraph,
    ),
    artifactCanonicalContentSha256:
      artifactParity.publication.canonicalContentSha256,
    artifactSourceAssetIdSetSha256:
      artifactParity.publication.assetManifestSha256,
    artifactProjectionSha256s: Object.fromEntries(
      ARTIFACT_MODES.map((mode) => [
        mode,
        canonicalJsonHash(artifactParity[mode]),
      ]),
    ),
  }
}

function normalizedPrivateEpubCheck(value) {
  if (
    value?.status === 'passed' &&
    SHA256_PATTERN.test(value.javaSha256 ?? '') &&
    SHA256_PATTERN.test(value.jreReleaseSha256 ?? '') &&
    SHA256_PATTERN.test(value.jreTreeSha256 ?? '') &&
    Object.keys(value).length === 4
  ) {
    return {
      status: 'passed',
      javaSha256: value.javaSha256,
      jreReleaseSha256: value.jreReleaseSha256,
      jreTreeSha256: value.jreTreeSha256,
    }
  }
  if (
    value?.status === 'skipped' &&
    value.reason === 'not-required' &&
    Object.keys(value).length === 2
  ) {
    return { status: 'skipped', reason: 'not-required' }
  }
  throw new Error('EPUBCHECK_RESULT_INVALID')
}

function validPrivateEpubCheck(value, allowLegacyEpubCheck = false) {
  if (
    allowLegacyEpubCheck &&
    value?.status === 'passed' &&
    Object.keys(value).length === 1
  )
    return true
  try {
    return (
      canonicalJsonHash(normalizedPrivateEpubCheck(value)) ===
      canonicalJsonHash(value)
    )
  } catch {
    return false
  }
}

export function createPrivateArtifactEvidence(
  epub,
  inspection,
  epubCheck = { status: 'skipped', reason: 'not-required' },
) {
  const manifest = inspection.manifest ?? {}
  const artifactSha256 = sha256(epub.bytes)
  if (artifactSha256 !== epub.sha256) {
    throw new Error('ARTIFACT_HASH_MISMATCH')
  }
  const inlineSemanticLedger = renderedInlineSemanticLedger(inspection)
  const evidence = {
    target: epub.profile?.id ?? null,
    profileVersion: epub.profile?.version ?? null,
    mode: epub.mode,
    byteLength: epub.bytes.byteLength,
    sha256: artifactSha256,
    ...artifactParityFromManifest(manifest, inlineSemanticLedger),
    structuralValidation: 'passed',
    epubCheck: normalizedPrivateEpubCheck(epubCheck),
  }
  return { ...evidence, receiptSha256: canonicalJsonHash(evidence) }
}

export function createPrivateReconstructionEvidence(
  reconstruction,
  artifactProjections,
) {
  const inlineSemanticLedger = canonicalInlineSemanticLedger(
    reconstruction.paper.nodes,
  )
  const artifactParity = artifactParityByMode(
    reconstruction,
    inlineSemanticLedger,
    artifactProjections,
  )
  const structure = createPrivateStructuralEvidence(
    reconstruction,
    artifactParity,
  )
  const blockingDiagnosticCodes = [
    ...reconstruction.readiness.blockingDiagnosticCodes,
  ].sort()
  const errorDiagnosticCodes = [
    ...new Set(
      reconstruction.diagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => diagnostic.code),
    ),
  ].sort()
  blockingDiagnosticCodes.forEach(safeCounterKey)
  errorDiagnosticCodes.forEach(safeCounterKey)
  return {
    pageCount: reconstruction.source.pageCount,
    completeness: reconstruction.completeness,
    readiness: {
      ready: reconstruction.readiness.ready === true,
      status: reconstruction.readiness.status,
      policy: { ...reconstruction.readiness.policy },
      blockingDiagnosticCodes,
      errorDiagnosticCodes,
    },
    nodeCounts: nodeCounts(reconstruction.paper.nodes),
    inlineSemanticLedger,
    relationshipCounts: relationshipCounts(reconstruction.visualRelationships),
    diagnosticCounts: diagnosticCounts(reconstruction.diagnostics),
    artifactParity,
    lineTransitionEvidence: createLineTransitionEvidence(
      reconstruction,
      structure,
    ),
    structure,
  }
}

export function createPrivateFidelityRunReceipt({
  ordinal,
  reconstruction,
  artifacts,
  artifactProjections,
}) {
  const reconstructionEvidence = createPrivateReconstructionEvidence(
    reconstruction,
    artifactProjections,
  )
  return {
    ordinal,
    reconstructionReceiptSha256: canonicalJsonHash(
      deterministicReconstructionProjection(reconstructionEvidence),
    ),
    reconstruction: reconstructionEvidence,
    artifacts,
  }
}

function normalizedBaselineComparison(baselineComparison) {
  if (
    baselineComparison?.status === 'passed' &&
    baselineComparison.passed === true &&
    /^[a-f0-9]{64}$/.test(baselineComparison.receiptSha256 ?? '')
  ) {
    return {
      status: 'passed',
      passed: true,
      receiptSha256: baselineComparison.receiptSha256,
    }
  }
  if (baselineComparison?.status === 'failed') {
    return { status: 'failed', passed: false }
  }
  return { status: 'not-configured', passed: false }
}

function validTransitionGate(run) {
  const structure = run.reconstruction.structure
  return validLineTransitionEvidence(
    run.reconstruction.lineTransitionEvidence,
    structure,
    true,
    run.reconstruction.completeness,
    run.reconstruction.pageCount,
  )
}

function artifactMatchesReconstruction(artifact, reconstruction) {
  const parity = reconstruction.artifactParity[artifact.mode]
  if (!parity) return false
  return (
    artifact.canonicalNodeCount === parity.canonicalNodeCount &&
    artifact.canonicalNodeSequenceSha256 ===
      parity.canonicalNodeSequenceSha256 &&
    artifact.canonicalContentSha256 === parity.canonicalContentSha256 &&
    artifact.relationshipCount === parity.relationshipCount &&
    artifact.relationshipGraphSha256 === parity.relationshipGraphSha256 &&
    artifact.assetCount === parity.assetCount &&
    artifact.assetManifestSha256 === parity.assetManifestSha256 &&
    canonicalJsonHash(artifact.inlineSemanticLedger) ===
      canonicalJsonHash(parity.inlineSemanticLedger)
  )
}

function artifactParityMatchesStructuralEvidence(reconstruction) {
  const parityByMode = reconstruction.artifactParity
  const parity = parityByMode.publication
  const structure = reconstruction.structure
  const total = (counts) =>
    Object.values(counts).reduce((sum, count) => sum + count, 0)
  return (
    ARTIFACT_MODES.every(
      (mode) =>
        canonicalJsonHash(parityByMode[mode]) ===
        structure.artifactProjectionSha256s[mode],
    ) &&
    parity.canonicalNodeCount === structure.canonicalNodeCount &&
    parity.canonicalNodeCount === total(reconstruction.nodeCounts) &&
    parity.canonicalNodeSequenceSha256 ===
      structure.canonicalNodeSequenceSha256 &&
    parity.canonicalContentSha256 ===
      structure.artifactCanonicalContentSha256 &&
    parity.relationshipCount === structure.visualRelationshipCount &&
    parity.relationshipCount === total(reconstruction.relationshipCounts) &&
    parity.relationshipGraphSha256 ===
      structure.visualRelationshipGraphSha256 &&
    parity.assetCount === structure.assetCount &&
    parity.assetManifestSha256 === structure.artifactSourceAssetIdSetSha256 &&
    ARTIFACT_MODES.every(
      (mode) =>
        canonicalJsonHash(parityByMode[mode].inlineSemanticLedger) ===
        canonicalJsonHash(reconstruction.inlineSemanticLedger),
    )
  )
}

export function createPrivateFidelityReceipt({
  paperId,
  sourceSha256,
  byteLength,
  decisionSetSha256 = null,
  runs,
  repeat,
  profiles,
  epubCheckRequired = false,
  baselineComparison,
  allowLegacyEpubCheck = false,
}) {
  const expectedOrdinals = Array.from(
    { length: repeat },
    (_, index) => index + 1,
  )
  const runOrdinals = runs.map((run) => run.ordinal)
  const runSetValid =
    runs.length === repeat &&
    runOrdinals.every((ordinal, index) => ordinal === expectedOrdinals[index])
  const reconstructionDeterministic =
    runSetValid &&
    new Set(runs.map((run) => run.reconstructionReceiptSha256)).size === 1 &&
    runs.every(
      (run) =>
        run.reconstructionReceiptSha256 ===
        canonicalJsonHash(
          deterministicReconstructionProjection(run.reconstruction),
        ),
    )
  const allReady =
    runSetValid &&
    runs.every(
      (run) =>
        validReadiness(
          run.reconstruction.readiness,
          run.reconstruction.completeness,
          run.reconstruction.diagnosticCounts,
        ) && run.reconstruction.readiness.ready === true,
    )
  const lineTransitionGatePassed =
    runSetValid && runs.every(validTransitionGate)
  const profileResults = profiles.map((profile) => {
    const artifacts = runs.flatMap((run) =>
      run.artifacts.filter((artifact) => artifact.target === profile),
    )
    const complete =
      runSetValid &&
      artifacts.length === repeat &&
      runs.every(
        (run) =>
          run.artifacts.filter((artifact) => artifact.target === profile)
            .length === 1,
      )
    const structurallyValid =
      complete &&
      runs.every(
        (run) =>
          artifactParityMatchesStructuralEvidence(run.reconstruction) &&
          run.artifacts
            .filter((artifact) => artifact.target === profile)
            .every(
              (artifact) =>
                validArtifactEvidence(artifact, allowLegacyEpubCheck) &&
                artifact.mode ===
                  (run.reconstruction.readiness.ready
                    ? 'publication'
                    : 'readable-fallback') &&
                artifactMatchesReconstruction(artifact, run.reconstruction),
            ),
      )
    const deterministic =
      complete &&
      new Set(artifacts.map((artifact) => artifact.receiptSha256)).size === 1
    return { profile, complete, structurallyValid, deterministic }
  })
  const artifactsDeterministic = profileResults.every(
    (profile) => profile.deterministic,
  )
  const artifactsStructurallyValid = profileResults.every(
    (profile) => profile.structurallyValid,
  )
  const noUnexpectedArtifacts = runs.every(
    (run) =>
      run.artifacts.length === profiles.length &&
      run.artifacts.every((artifact) => profiles.includes(artifact.target)),
  )
  const epubCheckPassedCount = runs.reduce(
    (total, run) =>
      total +
      run.artifacts.filter(
        (artifact) => artifact.epubCheck?.status === 'passed',
      ).length,
    0,
  )
  const allEpubCheckPassed =
    runSetValid &&
    noUnexpectedArtifacts &&
    epubCheckPassedCount === repeat * profiles.length
  const localValidationPassed =
    reconstructionDeterministic &&
    artifactsDeterministic &&
    artifactsStructurallyValid &&
    noUnexpectedArtifacts &&
    allReady &&
    lineTransitionGatePassed &&
    (!epubCheckRequired || allEpubCheckPassed)
  const normalizedBaseline = normalizedBaselineComparison(baselineComparison)
  return {
    schemaVersion: PDF_PRIVATE_FIDELITY_SCHEMA_VERSION,
    privacy: PDF_PRIVATE_FIDELITY_PRIVACY,
    source: { paperId, sha256: sourceSha256, byteLength },
    decisionSetSha256,
    execution: {
      repeat,
      profiles,
      runSetValid,
      reconstructionDeterministic,
      artifactsDeterministic,
      noUnexpectedArtifacts,
      allReady,
      lineTransitionGatePassed,
      epubCheckRequired,
      epubCheckPassedCount,
      allEpubCheckPassed,
      localValidationPassed,
      profileResults,
    },
    baselineComparison: normalizedBaseline,
    runs,
    passed: localValidationPassed && normalizedBaseline.passed,
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isUnitInterval(value) {
  return isFiniteNumber(value) && value >= 0 && value <= 1
}

function isNullableString(value) {
  return value === null || typeof value === 'string'
}

function validCountMap(value) {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, count]) =>
        SAFE_IDENTIFIER_PATTERN.test(key) && isNonNegativeInteger(count),
    )
  )
}

function validInlineSemanticLedger(value) {
  return (
    hasExactKeys(value, [
      'schemaVersion',
      'nodeCount',
      'semanticRangeCount',
      'relationshipCount',
      'relationshipTargetCount',
      'semanticRangeLedgerSha256',
      'relationshipTargetLedgerSha256',
    ]) &&
    value.schemaVersion === INLINE_SEMANTIC_LEDGER_SCHEMA_VERSION &&
    [
      'nodeCount',
      'semanticRangeCount',
      'relationshipCount',
      'relationshipTargetCount',
    ].every((key) => isNonNegativeInteger(value[key])) &&
    ['semanticRangeLedgerSha256', 'relationshipTargetLedgerSha256'].every(
      (key) => SHA256_PATTERN.test(value[key]),
    )
  )
}

function validArtifactParityProjection(value) {
  return (
    hasExactKeys(value, [
      'canonicalNodeCount',
      'canonicalNodeSequenceSha256',
      'canonicalContentSha256',
      'relationshipCount',
      'relationshipGraphSha256',
      'assetCount',
      'assetManifestSha256',
      'inlineSemanticLedger',
    ]) &&
    ['canonicalNodeCount', 'relationshipCount', 'assetCount'].every((key) =>
      isNonNegativeInteger(value[key]),
    ) &&
    [
      'canonicalNodeSequenceSha256',
      'canonicalContentSha256',
      'relationshipGraphSha256',
      'assetManifestSha256',
    ].every((key) => SHA256_PATTERN.test(value[key])) &&
    validInlineSemanticLedger(value.inlineSemanticLedger)
  )
}

function validArtifactParity(value) {
  return (
    hasExactKeys(value, ARTIFACT_MODES) &&
    ARTIFACT_MODES.every((mode) => validArtifactParityProjection(value[mode]))
  )
}

function validLineTransitionEvidence(
  value,
  structure,
  requireComplete,
  completeness,
  pageCount,
) {
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'sourceLedgerSha256',
      'sanitizedLedgerSha256',
      'ledgerBindingSha256',
      'expectedTransitionCount',
      'regions',
      'decisions',
    ]) ||
    value.schemaVersion !== '1.0.0' ||
    !isNonNegativeInteger(value.expectedTransitionCount) ||
    !Array.isArray(value.regions) ||
    !Array.isArray(value.decisions) ||
    value.sourceLedgerSha256 !== structure.lineTransitionLedgerSha256
  ) {
    return false
  }

  const regionHashes = new Set()
  const lineHashes = new Set()
  const expectedTransitions = new Set()
  let calculatedExpectedCount = 0
  for (const region of value.regions) {
    if (
      !hasExactKeys(region, ['page', 'regionSha256', 'lineSha256s']) ||
      !Number.isSafeInteger(region.page) ||
      region.page < 1 ||
      (pageCount !== undefined && region.page > pageCount) ||
      !SHA256_PATTERN.test(region.regionSha256) ||
      !Array.isArray(region.lineSha256s) ||
      region.lineSha256s.some((line) => !SHA256_PATTERN.test(line)) ||
      regionHashes.has(region.regionSha256)
    ) {
      return false
    }
    regionHashes.add(region.regionSha256)
    for (const line of region.lineSha256s) {
      if (lineHashes.has(line)) return false
      lineHashes.add(line)
    }
    calculatedExpectedCount += Math.max(0, region.lineSha256s.length - 1)
    for (let index = 1; index < region.lineSha256s.length; index += 1) {
      expectedTransitions.add(
        canonicalJsonHash({
          page: region.page,
          regionSha256: region.regionSha256,
          fromLineSha256: region.lineSha256s[index - 1],
          toLineSha256: region.lineSha256s[index],
        }),
      )
    }
  }
  if (
    calculatedExpectedCount !== value.expectedTransitionCount ||
    expectedTransitions.size !== calculatedExpectedCount
  ) {
    return false
  }

  const actualTransitions = new Set()
  let unresolvedCount = 0
  let structurallyConsumedCount = 0
  for (const decision of value.decisions) {
    if (
      !hasExactKeys(decision, [
        'page',
        'regionSha256',
        'fromLineSha256',
        'toLineSha256',
        'outcome',
      ]) ||
      !Number.isSafeInteger(decision.page) ||
      decision.page < 1 ||
      (pageCount !== undefined && decision.page > pageCount) ||
      !SHA256_PATTERN.test(decision.regionSha256) ||
      !SHA256_PATTERN.test(decision.fromLineSha256) ||
      !SHA256_PATTERN.test(decision.toLineSha256) ||
      ![
        'space',
        'no-space',
        'preserved-lexical-hyphen',
        'removed-discretionary-hyphen',
        'ambiguous',
        'structural-boundary',
        'unresolved',
      ].includes(decision.outcome)
    ) {
      return false
    }
    const transition = canonicalJsonHash({
      page: decision.page,
      regionSha256: decision.regionSha256,
      fromLineSha256: decision.fromLineSha256,
      toLineSha256: decision.toLineSha256,
    })
    if (actualTransitions.has(transition)) return false
    actualTransitions.add(transition)
    if (decision.outcome === 'unresolved' || decision.outcome === 'ambiguous') {
      unresolvedCount += 1
    }
    if (decision.outcome === 'structural-boundary') {
      structurallyConsumedCount += 1
    }
  }

  const ledgerShapeMatches = structure.lineTransitionLedgerAvailable
    ? SHA256_PATTERN.test(value.sourceLedgerSha256) &&
      SHA256_PATTERN.test(value.sanitizedLedgerSha256) &&
      SHA256_PATTERN.test(value.ledgerBindingSha256) &&
      value.sanitizedLedgerSha256 === canonicalJsonHash(value.decisions) &&
      value.ledgerBindingSha256 ===
        canonicalJsonHash({
          sourceLedgerSha256: value.sourceLedgerSha256,
          sanitizedLedgerSha256: value.sanitizedLedgerSha256,
        }) &&
      value.decisions.length === structure.lineTransitionCount &&
      unresolvedCount === structure.unresolvedCorruptingJoinCount &&
      structurallyConsumedCount ===
        structure.structurallyConsumedLineBoundaryCount
    : value.sourceLedgerSha256 === null &&
      value.sanitizedLedgerSha256 === null &&
      value.ledgerBindingSha256 === null &&
      value.decisions.length === 0 &&
      structure.lineTransitionCount === 0 &&
      structure.unresolvedCorruptingJoinCount === null &&
      structure.structurallyConsumedLineBoundaryCount === null
  const completenessMatches =
    completeness === undefined ||
    (value.expectedTransitionCount === completeness.lineBoundaryCount &&
      value.decisions.length === completeness.decidedLineBoundaryCount &&
      unresolvedCount === completeness.unresolvedCorruptingJoinCount &&
      structurallyConsumedCount ===
        completeness.structurallyConsumedLineBoundaryCount)
  if (!ledgerShapeMatches || !completenessMatches) return false
  if (!requireComplete) return true
  return (
    structure.lineTransitionLedgerAvailable === true &&
    value.expectedTransitionCount > 0 &&
    value.decisions.length === value.expectedTransitionCount &&
    unresolvedCount === 0 &&
    [...actualTransitions].every((transition) =>
      expectedTransitions.has(transition),
    )
  )
}

function validReadingOrderEvaluation(value) {
  return (
    hasExactKeys(value, [
      'schemaVersion',
      'algorithm',
      'mode',
      'regionCount',
      'acceptedEdgeCount',
      'unresolvedEdgeCount',
      'cycleRate',
      'orderAccuracy',
      'provider',
      'modelVersion',
      'latencyMs',
      'costUsd',
      'reviewRequired',
    ]) &&
    typeof value.schemaVersion === 'string' &&
    value.schemaVersion.length > 0 &&
    typeof value.algorithm === 'string' &&
    value.algorithm.length > 0 &&
    typeof value.mode === 'string' &&
    value.mode.length > 0 &&
    ['regionCount', 'acceptedEdgeCount', 'unresolvedEdgeCount'].every((key) =>
      isNonNegativeInteger(value[key]),
    ) &&
    isUnitInterval(value.cycleRate) &&
    (value.orderAccuracy === null || isUnitInterval(value.orderAccuracy)) &&
    isNullableString(value.provider) &&
    isNullableString(value.modelVersion) &&
    isFiniteNumber(value.latencyMs) &&
    value.latencyMs >= 0 &&
    isFiniteNumber(value.costUsd) &&
    value.costUsd >= 0 &&
    typeof value.reviewRequired === 'boolean'
  )
}

function validCompleteness(value) {
  if (!isRecord(value)) return false
  const semanticTableKeys = [
    'expectedSemanticTableCount',
    'resolvedSemanticTableCount',
    'semanticTableCoverage',
  ]
  const hasSemanticTableMetrics = semanticTableKeys.some((key) =>
    Object.hasOwn(value, key),
  )
  if (
    !hasExactKeys(value, [
      'sourceTextCharacters',
      'outputTextCharacters',
      'matchedTextCharacters',
      'textCoverage',
      'duplicateCanonicalSpanCount',
      'missingSourceRegionCount',
      'unprovenancedRenderedUnitCount',
      'expectedInlineSpanCount',
      'mappedInlineSpanCount',
      'inlineSpanCoverage',
      'expectedHyperlinkCount',
      'mappedHyperlinkCount',
      'hyperlinkCoverage',
      'lineBoundaryCount',
      'decidedLineBoundaryCount',
      'unresolvedCorruptingJoinCount',
      'structurallyConsumedLineBoundaryCount',
      'sourceAssetCount',
      'exportedAssetCount',
      'assetCoverage',
      'expectedRelationshipCount',
      'resolvedRelationshipCount',
      'relationshipCoverage',
      ...(hasSemanticTableMetrics ? semanticTableKeys : []),
      'unresolvedObjectCount',
      'unresolvedObjects',
      'ocrRequiredPages',
      'readingOrderDiagnostics',
      'readingOrderEvaluation',
    ]) ||
    [
      'sourceTextCharacters',
      'outputTextCharacters',
      'matchedTextCharacters',
      'duplicateCanonicalSpanCount',
      'missingSourceRegionCount',
      'unprovenancedRenderedUnitCount',
      'expectedInlineSpanCount',
      'mappedInlineSpanCount',
      'expectedHyperlinkCount',
      'mappedHyperlinkCount',
      'lineBoundaryCount',
      'decidedLineBoundaryCount',
      'unresolvedCorruptingJoinCount',
      'structurallyConsumedLineBoundaryCount',
      'sourceAssetCount',
      'exportedAssetCount',
      'expectedRelationshipCount',
      'resolvedRelationshipCount',
      ...(hasSemanticTableMetrics
        ? ['expectedSemanticTableCount', 'resolvedSemanticTableCount']
        : []),
      'unresolvedObjectCount',
      'readingOrderDiagnostics',
    ].some((key) => !isNonNegativeInteger(value[key])) ||
    [
      'textCoverage',
      'inlineSpanCoverage',
      'hyperlinkCoverage',
      'assetCoverage',
      'relationshipCoverage',
      ...(hasSemanticTableMetrics ? ['semanticTableCoverage'] : []),
    ].some((key) => !isUnitInterval(value[key])) ||
    value.matchedTextCharacters > value.sourceTextCharacters ||
    value.matchedTextCharacters > value.outputTextCharacters ||
    value.textCoverage !==
      Math.min(
        exactCoverage(value.matchedTextCharacters, value.sourceTextCharacters),
        exactCoverage(value.matchedTextCharacters, value.outputTextCharacters),
      ) ||
    value.decidedLineBoundaryCount > value.lineBoundaryCount ||
    value.unresolvedCorruptingJoinCount +
      value.structurallyConsumedLineBoundaryCount >
      value.decidedLineBoundaryCount ||
    value.mappedInlineSpanCount > value.expectedInlineSpanCount ||
    value.inlineSpanCoverage !==
      exactCoverage(
        value.mappedInlineSpanCount,
        value.expectedInlineSpanCount,
      ) ||
    value.mappedHyperlinkCount > value.expectedHyperlinkCount ||
    value.hyperlinkCoverage !==
      exactCoverage(value.mappedHyperlinkCount, value.expectedHyperlinkCount) ||
    value.exportedAssetCount > value.sourceAssetCount ||
    value.assetCoverage !==
      exactCoverage(value.exportedAssetCount, value.sourceAssetCount) ||
    value.resolvedRelationshipCount > value.expectedRelationshipCount ||
    value.relationshipCoverage !==
      exactCoverage(
        value.resolvedRelationshipCount,
        value.expectedRelationshipCount,
      ) ||
    (hasSemanticTableMetrics &&
      (value.resolvedSemanticTableCount > value.expectedSemanticTableCount ||
        value.semanticTableCoverage !==
          exactCoverage(
            value.resolvedSemanticTableCount,
            value.expectedSemanticTableCount,
          ))) ||
    !hasExactKeys(value.unresolvedObjects, [
      'assets',
      'captions',
      'tables',
      'equations',
      'citations',
      'footnoteReferences',
      'footnotes',
    ]) ||
    Object.values(value.unresolvedObjects).some(
      (count) => !isNonNegativeInteger(count),
    ) ||
    !Array.isArray(value.ocrRequiredPages) ||
    value.ocrRequiredPages.some(
      (page) => !Number.isSafeInteger(page) || page < 1,
    ) ||
    !validReadingOrderEvaluation(value.readingOrderEvaluation)
  ) {
    return false
  }
  return (
    Object.values(value.unresolvedObjects).reduce(
      (total, count) => total + count,
      0,
    ) === value.unresolvedObjectCount
  )
}

function validCompletenessPolicy(value) {
  return (
    hasExactKeys(value, [
      'minimumTextCoverage',
      'minimumAssetCoverage',
      'minimumRelationshipCoverage',
      'maximumUnresolvedObjects',
      'maximumOcrRequiredPages',
      'maximumReadingOrderDiagnostics',
    ]) &&
    [
      'minimumTextCoverage',
      'minimumAssetCoverage',
      'minimumRelationshipCoverage',
    ].every((key) => isUnitInterval(value[key])) &&
    [
      'maximumUnresolvedObjects',
      'maximumOcrRequiredPages',
      'maximumReadingOrderDiagnostics',
    ].every((key) => isNonNegativeInteger(value[key]))
  )
}

function completenessBlocksReadiness(completeness, policy) {
  return (
    completeness.textCoverage < policy.minimumTextCoverage ||
    completeness.assetCoverage < policy.minimumAssetCoverage ||
    completeness.relationshipCoverage < policy.minimumRelationshipCoverage ||
    completeness.unresolvedObjectCount > policy.maximumUnresolvedObjects ||
    completeness.ocrRequiredPages.length > policy.maximumOcrRequiredPages ||
    completeness.readingOrderDiagnostics >
      policy.maximumReadingOrderDiagnostics ||
    completeness.readingOrderEvaluation.reviewRequired ||
    completeness.duplicateCanonicalSpanCount > 0 ||
    completeness.missingSourceRegionCount > 0 ||
    completeness.unprovenancedRenderedUnitCount > 0 ||
    completeness.inlineSpanCoverage < 1 ||
    completeness.hyperlinkCoverage < 1 ||
    completeness.decidedLineBoundaryCount < completeness.lineBoundaryCount ||
    completeness.unresolvedCorruptingJoinCount > 0
  )
}

function validReadiness(value, completeness, diagnosticCounts) {
  const validCodeList = (codes) =>
    Array.isArray(codes) &&
    codes.every(
      (code) => typeof code === 'string' && SAFE_IDENTIFIER_PATTERN.test(code),
    ) &&
    new Set(codes).size === codes.length
  if (
    !hasExactKeys(value, [
      'ready',
      'status',
      'policy',
      'blockingDiagnosticCodes',
      'errorDiagnosticCodes',
    ]) ||
    typeof value.ready !== 'boolean' ||
    !['ready', 'review-required'].includes(value.status) ||
    !validCompletenessPolicy(value.policy) ||
    !validCodeList(value.blockingDiagnosticCodes) ||
    !validCodeList(value.errorDiagnosticCodes)
  ) {
    return false
  }
  const blockingCodes = new Set(value.blockingDiagnosticCodes)
  const errorCodes = new Set(value.errorDiagnosticCodes)
  const diagnosticsAgree =
    [...errorCodes].every(
      (code) =>
        blockingCodes.has(code) &&
        isNonNegativeInteger(diagnosticCounts[`error:${code}`]) &&
        diagnosticCounts[`error:${code}`] > 0,
    ) &&
    [...blockingCodes].every((code) =>
      ['error', 'warning', 'info'].some(
        (severity) =>
          isNonNegativeInteger(diagnosticCounts[`${severity}:${code}`]) &&
          diagnosticCounts[`${severity}:${code}`] > 0,
      ),
    )
  const derivedReady =
    diagnosticsAgree &&
    blockingCodes.size === 0 &&
    errorCodes.size === 0 &&
    !completenessBlocksReadiness(completeness, value.policy)
  return (
    diagnosticsAgree &&
    value.ready === derivedReady &&
    value.status === (derivedReady ? 'ready' : 'review-required')
  )
}

function validPrivateHashArray(value, nonempty = false) {
  return (
    Array.isArray(value) &&
    (!nonempty || value.length > 0) &&
    value.every((item) => SHA256_PATTERN.test(item)) &&
    new Set(value).size === value.length
  )
}

function validPrivateCitationGraph(value, legacy = false) {
  const keys = [
    'id',
    'status',
    'taxonomy',
    'referenceRegionId',
    'referenceStart',
    'referenceEnd',
    'labels',
    'targetNodeIds',
    ...(legacy ? [] : ['candidateNodeIds']),
    'canonicalAnchor',
    ...(legacy ? [] : ['evidenceSha256s']),
    'sourceBoxes',
  ]
  return (
    Array.isArray(value) &&
    value.every(
      (relationship) =>
        hasExactKeys(relationship, keys) &&
        SHA256_PATTERN.test(relationship.id) &&
        (legacy
          ? ['matched', 'unresolved']
          : ['matched', 'ambiguous', 'unresolved']
        ).includes(relationship.status) &&
        [
          'bracketed-bibliography-citation',
          'author-year-bibliography-citation',
          'superscript-citation-cluster',
          'superscript-bibliography-citation',
          'human-reclassified-citation',
        ].includes(relationship.taxonomy) &&
        SHA256_PATTERN.test(relationship.referenceRegionId) &&
        isNonNegativeInteger(relationship.referenceStart) &&
        Number.isSafeInteger(relationship.referenceEnd) &&
        relationship.referenceEnd > relationship.referenceStart &&
        validPrivateHashArray(relationship.labels, true) &&
        validPrivateHashArray(relationship.targetNodeIds) &&
        (legacy ||
          (validPrivateHashArray(relationship.candidateNodeIds) &&
            validPrivateHashArray(relationship.evidenceSha256s, true) &&
            validPdfCitationRelationshipTargetState(relationship))) &&
        (relationship.canonicalAnchor === null ||
          (hasExactKeys(relationship.canonicalAnchor, [
            'nodeId',
            'start',
            'end',
          ]) &&
            SHA256_PATTERN.test(relationship.canonicalAnchor.nodeId) &&
            isNonNegativeInteger(relationship.canonicalAnchor.start) &&
            Number.isSafeInteger(relationship.canonicalAnchor.end) &&
            relationship.canonicalAnchor.end >
              relationship.canonicalAnchor.start)) &&
        validPrivateHashArray(relationship.sourceBoxes, true),
    ) &&
    new Set(value.map((relationship) => relationship.id)).size === value.length
  )
}

function privateCitationStatusCounts(graph) {
  const counts = {}
  for (const relationship of graph) {
    counts[relationship.status] = (counts[relationship.status] ?? 0) + 1
  }
  return counts
}

const PRIVATE_CROSS_REFERENCE_KINDS = [
  'figure',
  'table',
  'section',
  'appendix',
  'equation',
]
const PRIVATE_CROSS_REFERENCE_STATUSES = ['matched', 'ambiguous', 'unresolved']

function validPrivateCrossReferenceTarget(target) {
  if (
    !hasExactKeys(target, [
      'kind',
      'labelSha256',
      'referenceStart',
      'referenceEnd',
      'status',
      'candidateNodeIds',
      'targetNodeId',
      'evidenceSha256s',
    ]) ||
    !PRIVATE_CROSS_REFERENCE_KINDS.includes(target.kind) ||
    !SHA256_PATTERN.test(target.labelSha256) ||
    !isNonNegativeInteger(target.referenceStart) ||
    !Number.isSafeInteger(target.referenceEnd) ||
    target.referenceEnd <= target.referenceStart ||
    !PRIVATE_CROSS_REFERENCE_STATUSES.includes(target.status) ||
    !validPrivateHashArray(target.candidateNodeIds) ||
    !validPrivateHashArray(target.evidenceSha256s, true)
  ) {
    return false
  }
  if (target.status === 'matched') {
    return (
      target.candidateNodeIds.length === 1 &&
      target.targetNodeId === target.candidateNodeIds[0]
    )
  }
  return (
    target.targetNodeId === null &&
    (target.status === 'ambiguous'
      ? target.candidateNodeIds.length > 1
      : target.candidateNodeIds.length === 0)
  )
}

function validPrivateCrossReferenceRelationship(relationship) {
  if (
    !hasExactKeys(relationship, [
      'id',
      'kind',
      'status',
      'textSha256',
      'referenceRegionId',
      'referenceStart',
      'referenceEnd',
      'labels',
      'targets',
      'targetNodeIds',
      'canonicalAnchor',
      'confidence',
      'evidenceSha256s',
      'sourceBoxes',
    ]) ||
    !SHA256_PATTERN.test(relationship.id) ||
    !PRIVATE_CROSS_REFERENCE_KINDS.includes(relationship.kind) ||
    !PRIVATE_CROSS_REFERENCE_STATUSES.includes(relationship.status) ||
    !SHA256_PATTERN.test(relationship.textSha256) ||
    !SHA256_PATTERN.test(relationship.referenceRegionId) ||
    !isNonNegativeInteger(relationship.referenceStart) ||
    !Number.isSafeInteger(relationship.referenceEnd) ||
    relationship.referenceEnd <= relationship.referenceStart ||
    !validPrivateHashArray(relationship.labels, true) ||
    !Array.isArray(relationship.targets) ||
    relationship.targets.length === 0 ||
    relationship.targets.length !== relationship.labels.length ||
    !relationship.targets.every(validPrivateCrossReferenceTarget) ||
    relationship.targets.some(
      (target, index) =>
        target.kind !== relationship.kind ||
        target.labelSha256 !== relationship.labels[index] ||
        target.referenceStart < relationship.referenceStart ||
        target.referenceEnd > relationship.referenceEnd ||
        (index > 0 &&
          target.referenceStart < relationship.targets[index - 1].referenceEnd),
    ) ||
    !validPrivateHashArray(relationship.targetNodeIds) ||
    (relationship.canonicalAnchor !== null &&
      (!hasExactKeys(relationship.canonicalAnchor, [
        'nodeId',
        'start',
        'end',
      ]) ||
        !SHA256_PATTERN.test(relationship.canonicalAnchor.nodeId) ||
        !isNonNegativeInteger(relationship.canonicalAnchor.start) ||
        !Number.isSafeInteger(relationship.canonicalAnchor.end) ||
        relationship.canonicalAnchor.end <=
          relationship.canonicalAnchor.start)) ||
    typeof relationship.confidence !== 'number' ||
    !Number.isFinite(relationship.confidence) ||
    relationship.confidence < 0 ||
    relationship.confidence > 1 ||
    !validPrivateHashArray(relationship.evidenceSha256s, true) ||
    !validPrivateHashArray(relationship.sourceBoxes, true)
  ) {
    return false
  }
  const derivedStatus = relationship.targets.some(
    (target) => target.status === 'ambiguous',
  )
    ? 'ambiguous'
    : relationship.targets.some((target) => target.status === 'unresolved')
      ? 'unresolved'
      : 'matched'
  const derivedTargetNodeIds =
    derivedStatus === 'matched'
      ? relationship.targets.map((target) => target.targetNodeId)
      : []
  return (
    relationship.status === derivedStatus &&
    canonicalJsonHash(relationship.targetNodeIds) ===
      canonicalJsonHash(derivedTargetNodeIds)
  )
}

function validPrivateCrossReferenceGraph(value) {
  return (
    Array.isArray(value) &&
    value.every(validPrivateCrossReferenceRelationship) &&
    new Set(value.map((relationship) => relationship.id)).size === value.length
  )
}

function privateCrossReferenceStatusCounts(graph) {
  const counts = {}
  for (const relationship of graph) {
    const key = `${relationship.kind}:${relationship.status}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function validCanonicalHyphenDeletionSourceBox(value) {
  return (
    hasExactKeys(value, [
      'page',
      'x',
      'y',
      'width',
      'height',
      'rotation',
      'method',
    ]) &&
    Number.isSafeInteger(value.page) &&
    value.page >= 1 &&
    ['x', 'y', 'width', 'height', 'rotation'].every((field) =>
      isFiniteNumber(value[field]),
    ) &&
    value.width >= 0 &&
    value.height >= 0 &&
    ['pdf-text', 'pdf-object', 'pdf-link', 'ocr'].includes(value.method)
  )
}

function validLegacyCanonicalHyphenDeletionRecord(record) {
  const evidenceSha256s = record?.proof?.evidenceSha256s
  return (
    hasExactKeys(record, [
      'id',
      'context',
      'outcome',
      'fromRegionId',
      'fromLineId',
      'toRegionId',
      'toLineId',
      'geometry',
      'proof',
    ]) &&
    [
      record.id,
      record.fromRegionId,
      record.fromLineId,
      record.toRegionId,
      record.toLineId,
    ].every((value) => SHA256_PATTERN.test(String(value ?? ''))) &&
    ['bibliography-continuation', 'canonical-flow-continuation'].includes(
      record.context,
    ) &&
    record.outcome === 'removed-discretionary-hyphen' &&
    hasExactKeys(record.geometry, ['from', 'to']) &&
    validCanonicalHyphenDeletionSourceBox(record.geometry.from) &&
    validCanonicalHyphenDeletionSourceBox(record.geometry.to) &&
    hasExactKeys(record.proof, [
      'sourceBoundaryProven',
      'pinnedWordSha256',
      'pinnedJoinedFormValid',
      'pinnedSplit',
      'splitPointValid',
      'exactSameDocumentJoinedFormSha256',
      'sameDocumentJoinedFormValid',
      'hardHyphenFormSha256',
      'hardHyphenCounterproof',
      'model',
      'evidenceSha256s',
    ]) &&
    record.proof.sourceBoundaryProven === true &&
    SHA256_PATTERN.test(String(record.proof.pinnedWordSha256 ?? '')) &&
    record.proof.pinnedJoinedFormValid === true &&
    hasExactKeys(record.proof.pinnedSplit, [
      'leftSha256',
      'rightSha256',
      'index',
    ]) &&
    SHA256_PATTERN.test(String(record.proof.pinnedSplit.leftSha256 ?? '')) &&
    SHA256_PATTERN.test(String(record.proof.pinnedSplit.rightSha256 ?? '')) &&
    Number.isSafeInteger(record.proof.pinnedSplit.index) &&
    record.proof.pinnedSplit.index > 0 &&
    record.proof.splitPointValid === true &&
    SHA256_PATTERN.test(
      String(record.proof.exactSameDocumentJoinedFormSha256 ?? ''),
    ) &&
    record.proof.exactSameDocumentJoinedFormSha256 ===
      record.proof.pinnedWordSha256 &&
    record.proof.sameDocumentJoinedFormValid === true &&
    SHA256_PATTERN.test(String(record.proof.hardHyphenFormSha256 ?? '')) &&
    record.proof.hardHyphenFormSha256 !== record.proof.pinnedWordSha256 &&
    record.proof.hardHyphenCounterproof === null &&
    hasExactKeys(record.proof.model, [
      'id',
      'language',
      'dictionarySha256',
      'affixSha256',
      'hyphenationSha256',
    ]) &&
    canonicalJsonHash(record.proof.model) ===
      canonicalJsonHash(PDF_HYPHEN_LEXICAL_MODEL_RECEIPT) &&
    validPrivateHashArray(evidenceSha256s, true) &&
    evidenceSha256s.every(
      (value, index) =>
        index === 0 || evidenceSha256s[index - 1].localeCompare(value) < 0,
    ) &&
    PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE_SHA256S.every((evidenceSha256) =>
      evidenceSha256s.includes(evidenceSha256),
    ) &&
    PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE_SHA256S.every(
      (evidenceSha256) => !evidenceSha256s.includes(evidenceSha256),
    )
  )
}

function validCanonicalHyphenDeletionRecord(record) {
  const evidenceSha256s = record?.proof?.evidenceSha256s
  if (
    !hasExactKeys(record, [
      'id',
      'context',
      'outcome',
      'fromRegionId',
      'fromLineId',
      'toRegionId',
      'toLineId',
      'geometry',
      'proof',
    ]) ||
    [
      record.id,
      record.fromRegionId,
      record.fromLineId,
      record.toRegionId,
      record.toLineId,
    ].some((value) => !SHA256_PATTERN.test(String(value ?? ''))) ||
    !['bibliography-continuation', 'canonical-flow-continuation'].includes(
      record.context,
    ) ||
    record.outcome !== 'removed-discretionary-hyphen' ||
    !hasExactKeys(record.geometry, ['from', 'to']) ||
    !validCanonicalHyphenDeletionSourceBox(record.geometry.from) ||
    !validCanonicalHyphenDeletionSourceBox(record.geometry.to) ||
    record.proof?.sourceBoundaryProven !== true ||
    !hasExactKeys(record.proof?.pinnedSplit, [
      'leftSha256',
      'rightSha256',
      'index',
    ]) ||
    !SHA256_PATTERN.test(String(record.proof.pinnedSplit.leftSha256 ?? '')) ||
    !SHA256_PATTERN.test(String(record.proof.pinnedSplit.rightSha256 ?? '')) ||
    !Number.isSafeInteger(record.proof.pinnedSplit.index) ||
    record.proof.pinnedSplit.index < 1 ||
    record.proof.splitPointValid !== true ||
    !SHA256_PATTERN.test(String(record.proof.hardHyphenFormSha256 ?? '')) ||
    record.proof.hardHyphenCounterproof !== null ||
    !hasExactKeys(record.proof.model, [
      'id',
      'language',
      'dictionarySha256',
      'affixSha256',
      'hyphenationSha256',
    ]) ||
    canonicalJsonHash(record.proof.model) !==
      canonicalJsonHash(PDF_HYPHEN_LEXICAL_MODEL_RECEIPT) ||
    !validPrivateHashArray(evidenceSha256s, true) ||
    evidenceSha256s.some(
      (value, index) =>
        index > 0 && evidenceSha256s[index - 1].localeCompare(value) >= 0,
    ) ||
    PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE_SHA256S.some((evidenceSha256) =>
      evidenceSha256s.includes(evidenceSha256),
    )
  ) {
    return false
  }
  if (record.proof.tier === 'exact-same-document') {
    return (
      hasExactKeys(record.proof, [
        'tier',
        'sourceBoundaryProven',
        'pinnedWordSha256',
        'pinnedJoinedFormValid',
        'pinnedSplit',
        'splitPointValid',
        'exactSameDocumentJoinedFormSha256',
        'sameDocumentJoinedFormValid',
        'hardHyphenFormSha256',
        'hardHyphenCounterproof',
        'model',
        'evidenceSha256s',
      ]) &&
      SHA256_PATTERN.test(String(record.proof.pinnedWordSha256 ?? '')) &&
      record.proof.pinnedJoinedFormValid === true &&
      SHA256_PATTERN.test(
        String(record.proof.exactSameDocumentJoinedFormSha256 ?? ''),
      ) &&
      record.proof.exactSameDocumentJoinedFormSha256 ===
        record.proof.pinnedWordSha256 &&
      record.proof.sameDocumentJoinedFormValid === true &&
      record.proof.hardHyphenFormSha256 !== record.proof.pinnedWordSha256 &&
      PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE_SHA256S.every((evidenceSha256) =>
        evidenceSha256s.includes(evidenceSha256),
      )
    )
  }
  if (record.proof.tier !== 'same-document-derived-affix') return false
  return (
    hasExactKeys(record.proof, [
      'tier',
      'sourceBoundaryProven',
      'derivedWordSha256',
      'productivePrefix',
      'baseWordSha256',
      'derivationBindingSha256',
      'pinnedBaseWordValid',
      'pinnedSplit',
      'splitPointValid',
      'exactSameDocumentBaseWordSha256',
      'sameDocumentBaseWordValid',
      'hardHyphenFormSha256',
      'hardHyphenCounterproof',
      'model',
      'evidenceSha256s',
    ]) &&
    SHA256_PATTERN.test(String(record.proof.derivedWordSha256 ?? '')) &&
    hasExactKeys(record.proof.productivePrefix, [
      'kind',
      'value',
      'affixClass',
      'flag',
      'crossProduct',
      'affixSha256',
    ]) &&
    canonicalJsonHash(record.proof.productivePrefix) ===
      canonicalJsonHash(PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE_RECEIPT) &&
    SHA256_PATTERN.test(String(record.proof.baseWordSha256 ?? '')) &&
    SHA256_PATTERN.test(String(record.proof.derivationBindingSha256 ?? '')) &&
    record.proof.derivationBindingSha256 ===
      canonicalJsonHash({
        derivedWordSha256: record.proof.derivedWordSha256,
        productivePrefix: record.proof.productivePrefix,
        baseWordSha256: record.proof.baseWordSha256,
      }) &&
    record.proof.pinnedBaseWordValid === true &&
    SHA256_PATTERN.test(
      String(record.proof.exactSameDocumentBaseWordSha256 ?? ''),
    ) &&
    record.proof.exactSameDocumentBaseWordSha256 ===
      record.proof.baseWordSha256 &&
    record.proof.sameDocumentBaseWordValid === true &&
    record.proof.derivedWordSha256 !== record.proof.baseWordSha256 &&
    record.proof.hardHyphenFormSha256 !== record.proof.derivedWordSha256 &&
    record.proof.pinnedSplit.index >
      PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE_RECEIPT.value.length &&
    PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE_SHA256S.every(
      (evidenceSha256) => evidenceSha256s.includes(evidenceSha256),
    )
  )
}

function canonicalHyphenDeletionContextCounts(records) {
  const counts = {}
  for (const record of records) {
    counts[record.context] = (counts[record.context] ?? 0) + 1
  }
  return counts
}

function validCanonicalHyphenDeletionLedger(structure, legacy = false) {
  const records = structure.canonicalHyphenDeletionLedger
  return (
    structure.canonicalHyphenDeletionLedgerAvailable === true &&
    isNonNegativeInteger(structure.canonicalHyphenDeletionCount) &&
    Array.isArray(records) &&
    records.length === structure.canonicalHyphenDeletionCount &&
    records.every(
      legacy
        ? validLegacyCanonicalHyphenDeletionRecord
        : validCanonicalHyphenDeletionRecord,
    ) &&
    records.every(
      (record, index) =>
        index === 0 || records[index - 1].id.localeCompare(record.id) < 0,
    ) &&
    new Set(records.map((record) => record.id)).size === records.length &&
    new Set(
      records.map((record) =>
        [
          record.fromRegionId,
          record.fromLineId,
          record.toRegionId,
          record.toLineId,
        ].join('\0'),
      ),
    ).size === records.length &&
    validCountMap(structure.canonicalHyphenDeletionContextCounts) &&
    canonicalJsonHash(structure.canonicalHyphenDeletionContextCounts) ===
      canonicalJsonHash(canonicalHyphenDeletionContextCounts(records)) &&
    SHA256_PATTERN.test(
      String(structure.canonicalHyphenDeletionLedgerSha256 ?? ''),
    ) &&
    structure.canonicalHyphenDeletionLedgerSha256 === canonicalJsonHash(records)
  )
}

function validStructure(value, allowHistoricalV14 = false) {
  const current = value?.schemaVersion === PDF_STRUCTURAL_RECEIPT_SCHEMA_VERSION
  const legacyV16 = allowHistoricalV14 && value?.schemaVersion === '1.6.0'
  const legacyV15 = allowHistoricalV14 && value?.schemaVersion === '1.5.0'
  const historical = allowHistoricalV14 && value?.schemaVersion === '1.4.0'
  const canonicalHyphenDeletionFields = [
    'canonicalHyphenDeletionLedgerAvailable',
    'canonicalHyphenDeletionCount',
    'canonicalHyphenDeletionContextCounts',
    'canonicalHyphenDeletionLedger',
    'canonicalHyphenDeletionLedgerSha256',
  ]
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'canonicalNodeCount',
      'canonicalNodeSequenceSha256',
      'canonicalNodeTypeSequenceSha256',
      'canonicalContentSha256',
      'canonicalNodeProvenanceSha256',
      'readingOrderGraphSha256',
      'nodeCounts',
      'visualRelationshipCount',
      'visualRelationshipCounts',
      'visualRelationshipGraphSha256',
      'noteRelationshipCount',
      'noteRelationshipCounts',
      'noteRelationshipGraphSha256',
      'citationRelationshipCount',
      'citationRelationshipCounts',
      'citationRelationshipGraph',
      'citationRelationshipGraphSha256',
      'crossReferenceRelationshipCount',
      'crossReferenceRelationshipCounts',
      'crossReferenceRelationshipGraph',
      'crossReferenceRelationshipGraphSha256',
      'assetCount',
      'assetCounts',
      'assetManifestSha256',
      'artifactCanonicalContentSha256',
      'artifactSourceAssetIdSetSha256',
      'artifactProjectionSha256s',
      'lineTransitionLedgerAvailable',
      'lineTransitionCount',
      'lineTransitionLedgerSha256',
      'unresolvedCorruptingJoinCount',
      'structurallyConsumedLineBoundaryCount',
      ...(current || legacyV16 || legacyV15
        ? canonicalHyphenDeletionFields
        : []),
    ]) ||
    (!current && !legacyV16 && !legacyV15 && !historical) ||
    [
      'canonicalNodeCount',
      'visualRelationshipCount',
      'noteRelationshipCount',
      'citationRelationshipCount',
      'crossReferenceRelationshipCount',
      'assetCount',
      'lineTransitionCount',
    ].some((key) => !isNonNegativeInteger(value[key])) ||
    [
      'canonicalNodeSequenceSha256',
      'canonicalNodeTypeSequenceSha256',
      'canonicalContentSha256',
      'canonicalNodeProvenanceSha256',
      'readingOrderGraphSha256',
      'visualRelationshipGraphSha256',
      'noteRelationshipGraphSha256',
      'citationRelationshipGraphSha256',
      'crossReferenceRelationshipGraphSha256',
      'assetManifestSha256',
      'artifactCanonicalContentSha256',
      'artifactSourceAssetIdSetSha256',
    ].some((key) => !SHA256_PATTERN.test(value[key])) ||
    !hasExactKeys(value.artifactProjectionSha256s, ARTIFACT_MODES) ||
    ARTIFACT_MODES.some(
      (mode) => !SHA256_PATTERN.test(value.artifactProjectionSha256s[mode]),
    ) ||
    [
      'nodeCounts',
      'visualRelationshipCounts',
      'noteRelationshipCounts',
      'citationRelationshipCounts',
      'crossReferenceRelationshipCounts',
      'assetCounts',
    ].some((key) => !validCountMap(value[key])) ||
    !validPrivateCitationGraph(value.citationRelationshipGraph, !current) ||
    value.citationRelationshipGraph.length !==
      value.citationRelationshipCount ||
    canonicalJsonHash(value.citationRelationshipGraph) !==
      value.citationRelationshipGraphSha256 ||
    canonicalJsonHash(value.citationRelationshipCounts) !==
      canonicalJsonHash(
        privateCitationStatusCounts(value.citationRelationshipGraph),
      ) ||
    !validPrivateCrossReferenceGraph(value.crossReferenceRelationshipGraph) ||
    value.crossReferenceRelationshipGraph.length !==
      value.crossReferenceRelationshipCount ||
    canonicalJsonHash(value.crossReferenceRelationshipGraph) !==
      value.crossReferenceRelationshipGraphSha256 ||
    canonicalJsonHash(value.crossReferenceRelationshipCounts) !==
      canonicalJsonHash(
        privateCrossReferenceStatusCounts(
          value.crossReferenceRelationshipGraph,
        ),
      ) ||
    typeof value.lineTransitionLedgerAvailable !== 'boolean' ||
    (current && !validCanonicalHyphenDeletionLedger(value)) ||
    (legacyV16 && !validCanonicalHyphenDeletionLedger(value)) ||
    (legacyV15 && !validCanonicalHyphenDeletionLedger(value, true))
  ) {
    return false
  }
  return value.lineTransitionLedgerAvailable
    ? SHA256_PATTERN.test(value.lineTransitionLedgerSha256) &&
        isNonNegativeInteger(value.unresolvedCorruptingJoinCount) &&
        isNonNegativeInteger(value.structurallyConsumedLineBoundaryCount) &&
        value.unresolvedCorruptingJoinCount +
          value.structurallyConsumedLineBoundaryCount <=
          value.lineTransitionCount
    : value.lineTransitionCount === 0 &&
        value.lineTransitionLedgerSha256 === null &&
        value.unresolvedCorruptingJoinCount === null &&
        value.structurallyConsumedLineBoundaryCount === null
}

function validReconstructionEvidence(value, allowHistoricalV14 = false) {
  return (
    hasExactKeys(value, [
      'pageCount',
      'completeness',
      'readiness',
      'nodeCounts',
      'inlineSemanticLedger',
      'relationshipCounts',
      'diagnosticCounts',
      'artifactParity',
      'lineTransitionEvidence',
      'structure',
    ]) &&
    Number.isSafeInteger(value.pageCount) &&
    value.pageCount > 0 &&
    validCompleteness(value.completeness) &&
    validReadiness(
      value.readiness,
      value.completeness,
      value.diagnosticCounts,
    ) &&
    validCountMap(value.nodeCounts) &&
    validInlineSemanticLedger(value.inlineSemanticLedger) &&
    validCountMap(value.relationshipCounts) &&
    validCountMap(value.diagnosticCounts) &&
    validStructure(value.structure, allowHistoricalV14) &&
    validArtifactParity(value.artifactParity) &&
    artifactParityMatchesStructuralEvidence(value) &&
    validLineTransitionEvidence(
      value.lineTransitionEvidence,
      value.structure,
      false,
      value.completeness,
      value.pageCount,
    )
  )
}

function validArtifactEvidence(value, allowLegacyEpubCheck = false) {
  if (
    !hasExactKeys(value, [
      'target',
      'profileVersion',
      'mode',
      'byteLength',
      'sha256',
      'canonicalNodeCount',
      'canonicalNodeSequenceSha256',
      'canonicalContentSha256',
      'relationshipCount',
      'relationshipGraphSha256',
      'assetCount',
      'assetManifestSha256',
      'inlineSemanticLedger',
      'structuralValidation',
      'epubCheck',
      'receiptSha256',
    ]) ||
    typeof value.target !== 'string' ||
    value.target.length === 0 ||
    typeof value.profileVersion !== 'string' ||
    value.profileVersion.length === 0 ||
    typeof value.mode !== 'string' ||
    value.mode.length === 0 ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    !Number.isSafeInteger(value.canonicalNodeCount) ||
    value.canonicalNodeCount <= 0 ||
    !Number.isSafeInteger(value.relationshipCount) ||
    value.relationshipCount < 0 ||
    !Number.isSafeInteger(value.assetCount) ||
    value.assetCount < 0 ||
    ![
      'sha256',
      'canonicalNodeSequenceSha256',
      'canonicalContentSha256',
      'relationshipGraphSha256',
      'assetManifestSha256',
      'receiptSha256',
    ].every((key) => SHA256_PATTERN.test(value[key])) ||
    !validInlineSemanticLedger(value.inlineSemanticLedger) ||
    value.structuralValidation !== 'passed' ||
    !validPrivateEpubCheck(value.epubCheck, allowLegacyEpubCheck) ||
    !ARTIFACT_MODES.includes(value.mode)
  ) {
    return false
  }
  const evidence = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'receiptSha256'),
  )
  return value.receiptSha256 === canonicalJsonHash(evidence)
}

function validRunReceipt(
  value,
  allowHistoricalV14 = false,
  allowLegacyEpubCheck = false,
) {
  return (
    hasExactKeys(value, [
      'ordinal',
      'reconstructionReceiptSha256',
      'reconstruction',
      'artifacts',
    ]) &&
    Number.isSafeInteger(value.ordinal) &&
    value.ordinal > 0 &&
    SHA256_PATTERN.test(value.reconstructionReceiptSha256) &&
    validReconstructionEvidence(value.reconstruction, allowHistoricalV14) &&
    value.reconstructionReceiptSha256 ===
      canonicalJsonHash(
        deterministicReconstructionProjection(value.reconstruction),
      ) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every((artifact) =>
      validArtifactEvidence(artifact, allowLegacyEpubCheck),
    )
  )
}

function validBaselineComparison(value) {
  if (!isRecord(value)) return false
  if (value.status === 'passed') {
    return (
      hasExactKeys(value, ['status', 'passed', 'receiptSha256']) &&
      value.passed === true &&
      SHA256_PATTERN.test(value.receiptSha256)
    )
  }
  return (
    ['failed', 'not-configured'].includes(value.status) &&
    hasExactKeys(value, ['status', 'passed']) &&
    value.passed === false
  )
}

function invalidPrivateFidelityBaseline() {
  throw new Error('INVALID_PRIVATE_FIDELITY_BASELINE')
}

function validatePrivateFidelityReceipt(receipt, requireAcceptedBaseline) {
  try {
    const legacySchema =
      requireAcceptedBaseline && receipt?.schemaVersion === '1.8.0'
    if (
      !hasExactKeys(receipt, [
        'schemaVersion',
        'privacy',
        'source',
        'decisionSetSha256',
        'execution',
        'baselineComparison',
        'runs',
        'passed',
      ]) ||
      (receipt.schemaVersion !== PDF_PRIVATE_FIDELITY_SCHEMA_VERSION &&
        !legacySchema) ||
      receipt.privacy !== PDF_PRIVATE_FIDELITY_PRIVACY ||
      !hasExactKeys(receipt.source, ['paperId', 'sha256', 'byteLength']) ||
      !/^[A-Za-z0-9._-]+$/.test(receipt.source.paperId) ||
      !SHA256_PATTERN.test(receipt.source.sha256) ||
      !Number.isSafeInteger(receipt.source.byteLength) ||
      receipt.source.byteLength <= 0 ||
      !(
        receipt.decisionSetSha256 === null ||
        SHA256_PATTERN.test(receipt.decisionSetSha256)
      ) ||
      !hasExactKeys(receipt.execution, [
        'repeat',
        'profiles',
        'runSetValid',
        'reconstructionDeterministic',
        'artifactsDeterministic',
        'noUnexpectedArtifacts',
        'allReady',
        'lineTransitionGatePassed',
        'epubCheckRequired',
        'epubCheckPassedCount',
        'allEpubCheckPassed',
        'localValidationPassed',
        'profileResults',
      ]) ||
      !Number.isSafeInteger(receipt.execution.repeat) ||
      receipt.execution.repeat < 2 ||
      !Array.isArray(receipt.execution.profiles) ||
      receipt.execution.profiles.length === 0 ||
      receipt.execution.profiles.some(
        (profile) =>
          typeof profile !== 'string' || !/^[A-Za-z0-9._-]+$/.test(profile),
      ) ||
      new Set(receipt.execution.profiles).size !==
        receipt.execution.profiles.length ||
      [
        'runSetValid',
        'reconstructionDeterministic',
        'artifactsDeterministic',
        'noUnexpectedArtifacts',
        'allReady',
        'lineTransitionGatePassed',
        'epubCheckRequired',
        'allEpubCheckPassed',
        'localValidationPassed',
      ].some((key) => typeof receipt.execution[key] !== 'boolean') ||
      !isNonNegativeInteger(receipt.execution.epubCheckPassedCount) ||
      !Array.isArray(receipt.execution.profileResults) ||
      receipt.execution.profileResults.some(
        (result) =>
          !hasExactKeys(result, [
            'profile',
            'complete',
            'structurallyValid',
            'deterministic',
          ]) ||
          typeof result.profile !== 'string' ||
          ['complete', 'structurallyValid', 'deterministic'].some(
            (key) => typeof result[key] !== 'boolean',
          ),
      ) ||
      !validBaselineComparison(receipt.baselineComparison) ||
      !Array.isArray(receipt.runs) ||
      receipt.runs.some(
        (run) =>
          !validRunReceipt(run, requireAcceptedBaseline, legacySchema),
      ) ||
      typeof receipt.passed !== 'boolean'
    ) {
      invalidPrivateFidelityBaseline()
    }

    const rebuilt = createPrivateFidelityReceipt({
      paperId: receipt.source.paperId,
      sourceSha256: receipt.source.sha256,
      byteLength: receipt.source.byteLength,
      decisionSetSha256: receipt.decisionSetSha256,
      runs: receipt.runs,
      repeat: receipt.execution.repeat,
      profiles: receipt.execution.profiles,
      epubCheckRequired: receipt.execution.epubCheckRequired,
      baselineComparison: receipt.baselineComparison,
      allowLegacyEpubCheck: legacySchema,
    })
    if (
      canonicalJsonHash(receipt.execution) !==
        canonicalJsonHash(rebuilt.execution) ||
      canonicalJsonHash(receipt.baselineComparison) !==
        canonicalJsonHash(rebuilt.baselineComparison) ||
      receipt.passed !== rebuilt.passed ||
      (requireAcceptedBaseline && !receipt.execution.localValidationPassed)
    ) {
      invalidPrivateFidelityBaseline()
    }
  } catch {
    invalidPrivateFidelityBaseline()
  }
}

function sanitizedReadingOrderEvaluation(value) {
  return {
    schemaVersion: value.schemaVersion,
    algorithm: value.algorithm,
    mode: value.mode,
    regionCount: value.regionCount,
    acceptedEdgeCount: value.acceptedEdgeCount,
    unresolvedEdgeCount: value.unresolvedEdgeCount,
    cycleRate: value.cycleRate,
    orderAccuracy: value.orderAccuracy,
    provider: value.provider,
    modelVersion: value.modelVersion,
    reviewRequired: value.reviewRequired,
  }
}

function deterministicReconstructionProjection(value) {
  return {
    ...value,
    completeness: {
      ...value.completeness,
      readingOrderEvaluation: sanitizedReadingOrderEvaluation(
        value.completeness.readingOrderEvaluation,
      ),
    },
  }
}

function invariantRunProjection(run, migrateLegacyEpubCheck = false) {
  const reconstruction = run.reconstruction
  return {
    reconstruction: {
      pageCount: reconstruction.pageCount,
      nodeCounts: reconstruction.nodeCounts,
      inlineSemanticLedger: reconstruction.inlineSemanticLedger,
      relationshipCounts: reconstruction.relationshipCounts,
      artifactParity: reconstruction.artifactParity,
      lineTransitionEvidence: reconstruction.lineTransitionEvidence,
      structure: reconstruction.structure,
    },
    artifacts: [...run.artifacts]
      .map((artifact) => {
        if (!migrateLegacyEpubCheck || artifact.epubCheck?.status !== 'passed')
          return artifact
        const { receiptSha256: _receiptSha256, ...evidence } = artifact
        const normalized = { ...evidence, epubCheck: { status: 'passed' } }
        return {
          ...normalized,
          receiptSha256: canonicalJsonHash(normalized),
        }
      })
      .sort((left, right) => left.target.localeCompare(right.target)),
  }
}

function noCountRegression(baseline, candidate) {
  return Object.entries(candidate).every(
    ([key, count]) => count <= (baseline[key] ?? 0),
  )
}

function noReadingOrderRegression(baseline, candidate) {
  const baselineAccuracy = baseline.orderAccuracy
  const candidateAccuracy = candidate.orderAccuracy
  return (
    canonicalJsonHash({
      schemaVersion: baseline.schemaVersion,
      algorithm: baseline.algorithm,
      mode: baseline.mode,
      regionCount: baseline.regionCount,
      provider: baseline.provider,
      modelVersion: baseline.modelVersion,
    }) ===
      canonicalJsonHash({
        schemaVersion: candidate.schemaVersion,
        algorithm: candidate.algorithm,
        mode: candidate.mode,
        regionCount: candidate.regionCount,
        provider: candidate.provider,
        modelVersion: candidate.modelVersion,
      }) &&
    candidate.acceptedEdgeCount >= baseline.acceptedEdgeCount &&
    candidate.unresolvedEdgeCount <= baseline.unresolvedEdgeCount &&
    candidate.cycleRate <= baseline.cycleRate &&
    !(!baseline.reviewRequired && candidate.reviewRequired) &&
    (baselineAccuracy === null
      ? candidateAccuracy === null || isUnitInterval(candidateAccuracy)
      : candidateAccuracy !== null && candidateAccuracy >= baselineAccuracy)
  )
}

function noCompletenessRegression(baseline, candidate) {
  const baselineHasSemanticTableMetrics = Object.hasOwn(
    baseline,
    'semanticTableCoverage',
  )
  const candidateHasSemanticTableMetrics = Object.hasOwn(
    candidate,
    'semanticTableCoverage',
  )
  const exactCounts = [
    'sourceTextCharacters',
    'sourceAssetCount',
    'expectedRelationshipCount',
    'lineBoundaryCount',
    'structurallyConsumedLineBoundaryCount',
    'expectedInlineSpanCount',
    'expectedHyperlinkCount',
  ]
  const higherIsBetter = [
    'outputTextCharacters',
    'matchedTextCharacters',
    'textCoverage',
    'exportedAssetCount',
    'assetCoverage',
    'resolvedRelationshipCount',
    'relationshipCoverage',
    'decidedLineBoundaryCount',
    'mappedInlineSpanCount',
    'inlineSpanCoverage',
    'mappedHyperlinkCount',
    'hyperlinkCoverage',
  ]
  const lowerIsBetter = [
    'duplicateCanonicalSpanCount',
    'missingSourceRegionCount',
    'unprovenancedRenderedUnitCount',
    'unresolvedCorruptingJoinCount',
    'unresolvedObjectCount',
    'readingOrderDiagnostics',
  ]
  return (
    exactCounts.every((key) => candidate[key] === baseline[key]) &&
    higherIsBetter.every((key) => candidate[key] >= baseline[key]) &&
    lowerIsBetter.every((key) => candidate[key] <= baseline[key]) &&
    (!baselineHasSemanticTableMetrics ||
      (candidateHasSemanticTableMetrics &&
        candidate.expectedSemanticTableCount ===
          baseline.expectedSemanticTableCount &&
        candidate.resolvedSemanticTableCount >=
          baseline.resolvedSemanticTableCount &&
        candidate.semanticTableCoverage >= baseline.semanticTableCoverage)) &&
    noCountRegression(
      baseline.unresolvedObjects,
      candidate.unresolvedObjects,
    ) &&
    candidate.ocrRequiredPages.every((page) =>
      baseline.ocrRequiredPages.includes(page),
    ) &&
    noReadingOrderRegression(
      sanitizedReadingOrderEvaluation(baseline.readingOrderEvaluation),
      sanitizedReadingOrderEvaluation(candidate.readingOrderEvaluation),
    )
  )
}

function noReadinessRegression(baseline, candidate) {
  return (
    canonicalJsonHash(candidate.policy) ===
      canonicalJsonHash(baseline.policy) &&
    (!baseline.ready || candidate.ready) &&
    !(baseline.status === 'ready' && candidate.status !== 'ready') &&
    candidate.blockingDiagnosticCodes.every((code) =>
      baseline.blockingDiagnosticCodes.includes(code),
    ) &&
    candidate.errorDiagnosticCodes.every((code) =>
      baseline.errorDiagnosticCodes.includes(code),
    )
  )
}

export function comparePrivateFidelityReceipts(
  baseline,
  candidate,
  expectedBaselineSha256,
) {
  validatePrivateFidelityReceipt(baseline, true)
  if (
    !SHA256_PATTERN.test(String(expectedBaselineSha256 ?? '')) ||
    canonicalJsonHash(baseline) !== expectedBaselineSha256
  ) {
    invalidPrivateFidelityBaseline()
  }
  validatePrivateFidelityReceipt(candidate, false)

  const identityMatches =
    canonicalJsonHash(baseline.source) ===
      canonicalJsonHash(candidate.source) &&
    baseline.decisionSetSha256 === candidate.decisionSetSha256 &&
    baseline.execution.repeat === candidate.execution.repeat &&
    canonicalJsonHash(baseline.execution.profiles) ===
      canonicalJsonHash(candidate.execution.profiles) &&
    baseline.execution.epubCheckRequired ===
      candidate.execution.epubCheckRequired
  const migrateLegacyEpubCheck = baseline.schemaVersion === '1.8.0'
  const invariantRunsMatch =
    canonicalJsonHash(
      baseline.runs.map((run) =>
        invariantRunProjection(run, migrateLegacyEpubCheck),
      ),
    ) ===
    canonicalJsonHash(
      candidate.runs.map((run) =>
        invariantRunProjection(run, migrateLegacyEpubCheck),
      ),
    )
  const runRegressed = baseline.runs.some((baselineRun, index) => {
    const candidateRun = candidate.runs[index]
    return (
      !candidateRun ||
      !noCompletenessRegression(
        baselineRun.reconstruction.completeness,
        candidateRun.reconstruction.completeness,
      ) ||
      !noReadinessRegression(
        baselineRun.reconstruction.readiness,
        candidateRun.reconstruction.readiness,
      ) ||
      !noCountRegression(
        baselineRun.reconstruction.diagnosticCounts,
        candidateRun.reconstruction.diagnosticCounts,
      )
    )
  })
  if (
    !identityMatches ||
    !candidate.execution.localValidationPassed ||
    !invariantRunsMatch ||
    runRegressed
  ) {
    return { status: 'failed', passed: false }
  }
  return {
    status: 'passed',
    passed: true,
    receiptSha256: canonicalJsonHash(baseline),
  }
}

async function loadPrivateFidelityBaseline(path, expectedBaselineSha256) {
  try {
    if (typeof path !== 'string' || path.length === 0) {
      invalidPrivateFidelityBaseline()
    }
    const requested = resolve(path)
    const requestedDetails = await lstat(requested)
    if (!requestedDetails.isFile() || requestedDetails.isSymbolicLink()) {
      invalidPrivateFidelityBaseline()
    }
    const resolvedPath = await realpath(requested)
    const repository = await realpath(
      fileURLToPath(new URL('../', import.meta.url)),
    )
    if (inside(repository, resolvedPath)) invalidPrivateFidelityBaseline()
    const details = await stat(resolvedPath)
    if (
      !details.isFile() ||
      details.size <= 0 ||
      details.size > MAX_BASELINE_RECEIPT_BYTES
    ) {
      invalidPrivateFidelityBaseline()
    }
    const baseline = JSON.parse(await readFile(resolvedPath, 'utf8'))
    validatePrivateFidelityReceipt(baseline, true)
    if (
      !SHA256_PATTERN.test(String(expectedBaselineSha256 ?? '')) ||
      canonicalJsonHash(baseline) !== expectedBaselineSha256
    ) {
      invalidPrivateFidelityBaseline()
    }
    return baseline
  } catch {
    invalidPrivateFidelityBaseline()
  }
}

export async function comparePrivateFidelityBaseline(
  path,
  candidate,
  expectedBaselineSha256,
) {
  const baseline = await loadPrivateFidelityBaseline(
    path,
    expectedBaselineSha256,
  )
  return comparePrivateFidelityReceipts(
    baseline,
    candidate,
    expectedBaselineSha256,
  )
}

function inside(parent, candidate) {
  const fromParent = relative(parent, candidate)
  return (
    fromParent === '' ||
    (!isAbsolute(fromParent) &&
      fromParent !== '..' &&
      !fromParent.startsWith(`..${sep}`))
  )
}

async function resolvedHomeDirectory() {
  try {
    return await realpath(homedir())
  } catch {
    return resolve(homedir())
  }
}

export async function prepareOwnerOnlyDirectory(path) {
  const requested = resolve(path)
  const repository = await realpath(
    fileURLToPath(new URL('../', import.meta.url)),
  )
  const home = await resolvedHomeDirectory()
  const root = parse(requested).root
  if (requested === root || requested === home || requested === repository) {
    throw new Error('OUTPUT_MUST_BE_NEW_EXTERNAL_DIRECTORY')
  }
  try {
    await lstat(requested)
    throw new Error('OUTPUT_MUST_BE_NEW_EXTERNAL_DIRECTORY')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const parent = await realpath(dirname(requested))
  const target = resolve(parent, basename(requested))
  if (
    target === parse(target).root ||
    target === home ||
    inside(repository, target)
  ) {
    throw new Error('OUTPUT_MUST_BE_NEW_EXTERNAL_DIRECTORY')
  }
  await mkdir(target, { mode: 0o700 })
  const details = await stat(target)
  if (!details.isDirectory() || (details.mode & 0o077) !== 0) {
    throw new Error('OUTPUT_DIRECTORY_NOT_OWNER_ONLY')
  }
  return target
}

export async function writeExclusive(path, value) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(value)
  } finally {
    await handle.close()
  }
}

async function loadPinnedPrivateDecisionSet(parsed, pipeline) {
  if (!parsed.decisions) return null
  const modules = await pipeline.loadDecisionModules()
  const details = await stat(parsed.decisions)
  if (
    !details.isFile() ||
    details.size <= 0 ||
    details.size > modules.maximumBytes
  ) {
    throw new Error('PRIVATE_DECISION_SET_INVALID')
  }
  const bytes = await readFile(parsed.decisions)
  if (sha256(bytes) !== parsed.expectedDecisionsSha256) {
    throw new Error('PRIVATE_DECISION_SET_IDENTITY_MISMATCH')
  }
  return {
    decisionFile: modules.parseHumanDecisionFile(bytes.toString('utf8')),
    applyHumanDecisionFile: modules.applyHumanDecisionFile,
  }
}

async function main() {
  let parsed
  privateFailureStage = 'argument-parse'
  try {
    parsed = parsePrivateFidelityArguments(process.argv.slice(2))
  } catch {
    process.stderr.write(usage())
    process.exitCode = 2
    return
  }

  privateFailureStage = 'baseline-load'
  const baseline = parsed.baseline
    ? await loadPrivateFidelityBaseline(
        parsed.baseline,
        parsed.expectedBaselineSha256,
      )
    : null

  privateFailureStage = 'source-stat'
  const details = await stat(parsed.input)
  if (!details.isFile() || details.size !== parsed.expectedSize) {
    throw new Error('SOURCE_IDENTITY_MISMATCH')
  }
  privateFailureStage = 'source-read'
  const bytes = await readFile(parsed.input)
  const sourceSha256 = sha256(bytes)
  if (sourceSha256 !== parsed.expectedSha256) {
    throw new Error('SOURCE_IDENTITY_MISMATCH')
  }

  privateFailureStage = 'pipeline-create'
  const pipeline = await createPdfPipeline()
  try {
    privateFailureStage = 'export-modules-load'
    const modules = await pipeline.loadExportModules()
    privateFailureStage = 'decision-set-load'
    const decisionSet = await loadPinnedPrivateDecisionSet(parsed, pipeline)
    if (
      parsed.profiles.some(
        (profile) => !modules.targetProfileIds.includes(profile),
      )
    ) {
      throw new Error('UNKNOWN_PROFILE')
    }

    privateFailureStage = 'epubcheck-resolve'
    const epubCheckValidator = parsed.requireEpubCheck
      ? await requiredPrivateEpubCheckValidator()
      : null

    privateFailureStage = 'output-prepare'
    parsed.outputDirectory = await prepareOwnerOnlyDirectory(
      parsed.outputDirectory,
    )
    const runs = []
    const pendingArtifactWrites = []
    for (let ordinal = 1; ordinal <= parsed.repeat; ordinal += 1) {
      privateFailureStage = 'reconstruction'
      const reconstructed = await pipeline.reconstructPdf(
        new File([bytes], `${parsed.paperId}.pdf`, {
          type: 'application/pdf',
          lastModified: 0,
        }),
        undefined,
        { standardFontDataUrl: pipeline.standardFontDataUrl },
      )
      privateFailureStage = 'decision-apply'
      const reconstruction = decisionSet
        ? applyPrivateDecisionSet(
            reconstructed,
            decisionSet.decisionFile,
            decisionSet.applyHumanDecisionFile,
          )
        : reconstructed
      privateFailureStage = 'artifact-projection'
      const artifactProjections = {
        'readable-fallback':
          modules.projectReadableFallbackReconstruction(reconstruction),
      }
      const artifacts = []
      for (const profileId of parsed.profiles) {
        privateFailureStage = 'artifact-build'
        const profile = modules.getTargetProfile(profileId)
        const epub = reconstruction.readiness.ready
          ? await modules.buildEpub(
              reconstruction.paper,
              reconstruction,
              profile,
            )
          : await modules.buildReadableEpub(
              reconstruction.paper,
              reconstruction,
              profile,
            )
        privateFailureStage = 'artifact-inspect'
        const inspection = modules.inspectEpub(epub.bytes, profile, {
          canonicalPaper: reconstruction.readiness.ready
            ? reconstruction.paper
            : artifactProjections['readable-fallback'].paper,
          sourceCanonicalPaper: reconstruction.paper,
          sourcePdfSha256: reconstruction.source.sha256,
        })
        privateFailureStage = 'epubcheck-validate'
        const epubCheck = epubCheckValidator
          ? await validatePrivateEpubWithEpubCheck(
              epub.bytes,
              epubCheckValidator,
            )
          : { status: 'skipped', reason: 'not-required' }
        privateFailureStage = 'artifact-receipt'
        artifacts.push(
          createPrivateArtifactEvidence(epub, inspection, epubCheck),
        )
        pendingArtifactWrites.push({
          fileName: `run-${ordinal}-${profileId}.epub`,
          bytes: epub.bytes,
        })
      }
      privateFailureStage = 'run-receipt'
      runs.push(
        createPrivateFidelityRunReceipt({
          ordinal,
          reconstruction,
          artifacts,
          artifactProjections,
        }),
      )
    }

    privateFailureStage = 'final-receipt'
    const receiptInput = {
      paperId: parsed.paperId,
      sourceSha256,
      byteLength: bytes.byteLength,
      decisionSetSha256: parsed.expectedDecisionsSha256,
      runs,
      repeat: parsed.repeat,
      profiles: parsed.profiles,
      epubCheckRequired: parsed.requireEpubCheck,
    }
    const localReceipt = createPrivateFidelityReceipt(receiptInput)
    const receipt = baseline
      ? createPrivateFidelityReceipt({
          ...receiptInput,
          baselineComparison: comparePrivateFidelityReceipts(
            baseline,
            localReceipt,
            parsed.expectedBaselineSha256,
          ),
        })
      : localReceipt
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`
    privateFailureStage = 'artifact-publish'
    for (const artifact of pendingArtifactWrites) {
      await writeExclusive(
        resolve(parsed.outputDirectory, artifact.fileName),
        artifact.bytes,
      )
    }
    privateFailureStage = 'receipt-write'
    await writeExclusive(
      resolve(parsed.outputDirectory, 'private-fidelity-receipt.json'),
      serialized,
    )
    privateFailureStage = 'receipt-publish'
    process.stdout.write(serialized)
    if (!receipt.passed) process.exitCode = 1
  } finally {
    try {
      await pipeline.close()
    } catch (error) {
      privateFailureStage = 'pipeline-close'
      throw error
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    if (process.argv.includes('--safe-error-diagnostic')) {
      process.stderr.write(
        `${JSON.stringify(safePrivateFailureDiagnostic(error))}\n`,
      )
    }
    process.stderr.write(
      'Private PDF fidelity validation failed without exposing local paths or source content.\n',
    )
    process.exitCode = 2
  })
}

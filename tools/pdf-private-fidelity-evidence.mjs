import { createHash } from 'node:crypto'
import { parse as parseHtml } from 'parse5'
import { canonicalJsonHash } from './pdf-corpus-audit-lib.mjs'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const INLINE_SEMANTIC_LEDGER_SCHEMA_VERSION = '1.0.0'

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function opaqueTopologyId(kind, value) {
  return sha256(`${kind}\0${String(value ?? '')}`)
}

export function exactCoverage(resolved, expected) {
  return expected === 0
    ? 1
    : Math.round((resolved / expected) * 100_000) / 100_000
}

export function safeCounterKey(value) {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error('UNSAFE_PRIVATE_RECEIPT_IDENTIFIER')
  }
  return value
}

export function diagnosticCounts(diagnostics) {
  const counts = new Map()
  for (const diagnostic of diagnostics) {
    const key = safeCounterKey(`${diagnostic.severity}:${diagnostic.code}`)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function nodeCounts(nodes) {
  const counts = new Map()
  for (const node of nodes) {
    const key = safeCounterKey(node.type)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function relationshipCounts(relationships) {
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

export function canonicalInlineSemanticLedger(nodes) {
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

export function renderedInlineSemanticLedger(inspection) {
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

export function sortedStrings(values) {
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

export function normalizedRelationshipParity(
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

export const createInlineSemanticLedger = canonicalInlineSemanticLedger

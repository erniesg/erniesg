import { z } from 'zod'
import type {
  HumanAdjudicationRecord,
  PdfReconstruction,
  ReconstructionDiagnostic,
} from './import-types'
import { assessPdfCompleteness } from './pdf-quality'
import {
  buildPdfLineJoinReviewContext,
  replayPdfRegionLineText,
} from './pdf-lines'

export const HUMAN_DECISION_SCHEMA_VERSION = '1.1.0' as const
const LEGACY_HUMAN_DECISION_SCHEMA_VERSION = '1.0.0' as const
export const MAX_HUMAN_DECISION_FILE_BYTES = 1024 * 1024
const MAX_HUMAN_DECISIONS = 1000
const MAX_TARGET_REGION_IDS = 10_000
const stableIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_.:-]+$/)

const diagnosticCodeSchema = z.enum([
  'OCR_REQUIRED',
  'MIXED_PAGE',
  'REPEATED_MARGIN_TEXT',
  'LOW_CONFIDENCE_BLOCK',
  'RESOLVED_READING_ORDER',
  'AMBIGUOUS_READING_ORDER',
  'READING_ORDER_CYCLE',
  'AMBIGUOUS_NOTE_MATCH',
  'UNRESOLVED_NOTE_REFERENCE',
  'UNREFERENCED_NOTE',
  'UNRESOLVED_CORRUPTING_JOIN',
  'NO_RECONSTRUCTABLE_TEXT',
  'INCOMPLETE_TEXT_COVERAGE',
  'INCOMPLETE_ASSET_COVERAGE',
  'INCOMPLETE_RELATIONSHIP_COVERAGE',
  'UNRESOLVED_SEMANTIC_OBJECTS',
  'STALE_HUMAN_DECISION',
])

const targetSchema = z
  .object({
    regionIds: z.array(stableIdSchema).min(1).max(MAX_TARGET_REGION_IDS),
    markerId: stableIdSchema.nullable(),
  })
  .strict()
  .refine(
    (target) => new Set(target.regionIds).size === target.regionIds.length,
    {
      message: 'Diagnostic target region identifiers must be unique.',
      path: ['regionIds'],
    },
  )

const resolutionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('accept-note-match'),
      targetNoteId: stableIdSchema,
      targetRegionId: stableIdSchema,
    })
    .strict(),
  z.object({ type: z.literal('reclassify-citation') }).strict(),
  z.object({ type: z.literal('reclassify-plain-text') }).strict(),
  z
    .object({
      type: z.literal('accept-reading-order'),
      regionIds: z.array(stableIdSchema).min(1).max(MAX_TARGET_REGION_IDS),
    })
    .strict(),
  z
    .object({
      type: z.literal('resolve-line-join'),
      transition: z
        .object({
          id: stableIdSchema,
          regionId: stableIdSchema,
          fromLineId: stableIdSchema,
          toLineId: stableIdSchema,
        })
        .strict(),
      outcome: z.enum([
        'remove-wrap-hyphen',
        'preserve-authored-hyphen',
        'leave-unresolved',
      ]),
      confidence: z.literal(1),
      evidence: z.tuple([
        z.literal('bounded-source-context'),
        z.literal('owner-local-adjudication'),
      ]),
    })
    .strict(),
  z.object({ type: z.literal('dismiss') }).strict(),
])

export const humanAdjudicationRecordSchema = z
  .object({
    diagnosticCode: diagnosticCodeSchema,
    target: targetSchema,
    resolution: resolutionSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.resolution.type === 'resolve-line-join') {
      const transition = decision.resolution.transition
      if (decision.diagnosticCode !== 'UNRESOLVED_CORRUPTING_JOIN') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['diagnosticCode'],
          message:
            'Line-join resolutions apply only to unresolved corrupting joins.',
        })
      }
      if (
        decision.target.markerId !== transition.id ||
        decision.target.regionIds.length !== 1 ||
        decision.target.regionIds[0] !== transition.regionId
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['target'],
          message:
            'Line-join targets must exactly match the transition and region identity.',
        })
      }
    } else if (decision.diagnosticCode === 'UNRESOLVED_CORRUPTING_JOIN') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resolution'],
        message:
          'Unresolved line joins require an explicit line-join resolution.',
      })
    }
  })

export const humanDecisionFileSchema = z
  .object({
    schemaVersion: z.union([
      z.literal(LEGACY_HUMAN_DECISION_SCHEMA_VERSION),
      z.literal(HUMAN_DECISION_SCHEMA_VERSION),
    ]),
    documentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    decisions: z.array(humanAdjudicationRecordSchema).max(MAX_HUMAN_DECISIONS),
  })
  .strict()
  .superRefine((file, context) => {
    const seen = new Set<string>()
    for (const [index, decision] of file.decisions.entries()) {
      const key = decisionKey(decision)
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['decisions', index],
          message:
            'A decision file may contain only one resolution per diagnostic target.',
        })
      }
      seen.add(key)
      if (
        file.schemaVersion === LEGACY_HUMAN_DECISION_SCHEMA_VERSION &&
        decision.resolution.type === 'resolve-line-join'
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['decisions', index, 'resolution'],
          message: 'Line-join resolutions require decision schema v1.1.0.',
        })
      }
    }
  })

export type HumanDecisionFile = z.infer<typeof humanDecisionFileSchema>

const QUALITY_DIAGNOSTIC_CODES = new Set<ReconstructionDiagnostic['code']>([
  'DUPLICATE_CANONICAL_SPAN',
  'MISSING_SOURCE_REGION',
  'UNPROVENANCED_RENDERED_UNIT',
  'INCOMPLETE_INLINE_STYLE_COVERAGE',
  'INVALID_LINE_BOUNDARY_LEDGER',
  'UNRESOLVED_CORRUPTING_JOIN',
  'EPUB_TEXT_SANITIZATION_LOSS',
  'DANGLING_EPUB_INTERNAL_REFERENCE',
  'INCOMPLETE_TEXT_COVERAGE',
  'INCOMPLETE_ASSET_COVERAGE',
  'INCOMPLETE_RELATIONSHIP_COVERAGE',
  'UNRESOLVED_SEMANTIC_OBJECTS',
])

function normalizedTarget(target: HumanAdjudicationRecord['target']) {
  return {
    regionIds: [...new Set(target.regionIds)].sort(),
    markerId: target.markerId,
  }
}

function normalizedRecord(
  decision: HumanAdjudicationRecord,
): HumanAdjudicationRecord {
  const resolution = (() => {
    if (decision.resolution.type === 'accept-reading-order') {
      return {
        ...decision.resolution,
        regionIds: [...decision.resolution.regionIds],
      }
    }
    if (decision.resolution.type === 'resolve-line-join') {
      return {
        ...decision.resolution,
        transition: { ...decision.resolution.transition },
        evidence: [...decision.resolution.evidence],
      }
    }
    return { ...decision.resolution }
  })()
  return {
    diagnosticCode: decision.diagnosticCode,
    target: normalizedTarget(decision.target),
    resolution,
  }
}

function decisionKey(decision: HumanAdjudicationRecord) {
  const target = normalizedTarget(decision.target)
  return `${decision.diagnosticCode}\u0000${target.markerId ?? ''}\u0000${target.regionIds.join('\u0000')}`
}

function sameValues(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function sameTarget(
  left: HumanAdjudicationRecord['target'],
  right: HumanAdjudicationRecord['target'],
) {
  const normalizedLeft = normalizedTarget(left)
  const normalizedRight = normalizedTarget(right)
  return (
    normalizedLeft.markerId === normalizedRight.markerId &&
    sameValues(normalizedLeft.regionIds, normalizedRight.regionIds)
  )
}

export function parseHumanDecisionFile(input: string | unknown) {
  if (
    typeof input === 'string' &&
    new TextEncoder().encode(input).byteLength > MAX_HUMAN_DECISION_FILE_BYTES
  ) {
    throw new Error(
      `Decision file exceeds the ${MAX_HUMAN_DECISION_FILE_BYTES}-byte local limit.`,
    )
  }
  return humanDecisionFileSchema.parse(
    typeof input === 'string' ? JSON.parse(input) : input,
  )
}

export function createHumanDecisionFile(documentSha256: string) {
  return humanDecisionFileSchema.parse({
    schemaVersion: HUMAN_DECISION_SCHEMA_VERSION,
    documentSha256,
    decisions: [],
  })
}

export function upsertHumanDecision(
  file: HumanDecisionFile,
  decision: HumanAdjudicationRecord,
) {
  const normalized = normalizedRecord(decision)
  return humanDecisionFileSchema.parse({
    ...file,
    schemaVersion:
      normalized.resolution.type === 'resolve-line-join'
        ? HUMAN_DECISION_SCHEMA_VERSION
        : file.schemaVersion,
    decisions: [
      ...file.decisions.filter(
        (candidate) => decisionKey(candidate) !== decisionKey(normalized),
      ),
      normalized,
    ].sort((left, right) =>
      decisionKey(left).localeCompare(decisionKey(right)),
    ),
  })
}

export function serializeHumanDecisionFile(file: HumanDecisionFile) {
  return `${JSON.stringify(humanDecisionFileSchema.parse(file), null, 2)}\n`
}

export function readingOrderCandidates(
  reconstruction: PdfReconstruction,
  diagnostic: ReconstructionDiagnostic,
) {
  if (
    diagnostic.code !== 'AMBIGUOUS_READING_ORDER' ||
    !diagnostic.target?.regionIds.length
  ) {
    return []
  }
  const targetIds = new Set(diagnostic.target.regionIds)
  const base = reconstruction.readingOrder.order.filter((id) =>
    targetIds.has(id),
  )
  if (base.length !== targetIds.size) return []
  const regions = new Map(
    reconstruction.regions
      .filter((region) => targetIds.has(region.id))
      .map((region) => [region.id, region]),
  )
  const swappable = (id: string) => {
    const region = regions.get(id)
    return (
      region &&
      region.kind !== 'footnote' &&
      region.kind !== 'endnote' &&
      (region.column === 'left' || region.column === 'right')
    )
  }
  const alternate: string[] = []
  let segment: string[] = []
  const flushSegment = () => {
    alternate.push(
      ...segment.filter((id) => regions.get(id)?.column === 'right'),
      ...segment.filter((id) => regions.get(id)?.column === 'left'),
    )
    segment = []
  }
  for (const regionId of base) {
    if (swappable(regionId)) {
      segment.push(regionId)
    } else {
      flushSegment()
      alternate.push(regionId)
    }
  }
  flushSegment()
  return sameValues(base, alternate) ? [base] : [base, alternate]
}

function diagnosticForDecision(
  reconstruction: PdfReconstruction,
  decision: HumanAdjudicationRecord,
) {
  return reconstruction.diagnostics.find(
    (diagnostic) =>
      diagnostic.code === decision.diagnosticCode &&
      diagnostic.target &&
      sameTarget(diagnostic.target, decision.target),
  )
}

function updateNoteRelationship(
  reconstruction: PdfReconstruction,
  decision: HumanAdjudicationRecord,
) {
  if (
    decision.diagnosticCode !== 'AMBIGUOUS_NOTE_MATCH' &&
    decision.diagnosticCode !== 'UNRESOLVED_NOTE_REFERENCE'
  ) {
    return false
  }
  const markerId = decision.target.markerId
  const relationship = reconstruction.noteRelationships.find(
    (candidate) => candidate.id === markerId,
  )
  if (
    !relationship ||
    !decision.target.regionIds.includes(relationship.referenceRegionId)
  ) {
    return false
  }

  let targetNoteId: string | null = null
  let citationTargetIds: string[] | undefined
  if (decision.resolution.type === 'accept-note-match') {
    const resolution = decision.resolution
    const candidate = relationship.candidates.find(
      (item) =>
        item.targetNoteId === resolution.targetNoteId &&
        item.targetRegionId === resolution.targetRegionId &&
        decision.target.regionIds.includes(item.targetRegionId),
    )
    if (!candidate) return false
    targetNoteId = candidate.targetNoteId
    relationship.targetNoteId = candidate.targetNoteId
    relationship.status = 'matched'
    relationship.confidence = candidate.score
    relationship.evidence = [...candidate.evidence, 'human-adjudication']
    relationship.sourceBoxes = [...candidate.sourceBoxes]
  } else if (decision.resolution.type === 'reclassify-citation') {
    relationship.targetNoteId = null
    relationship.status = 'citation'
    relationship.evidence = [...relationship.evidence, 'human-adjudication']
    const labels = relationship.label.split(',').filter(Boolean)
    const bibliographyTargets = new Map<string, string>()
    for (const node of reconstruction.paper.nodes) {
      if (
        node.type !== 'paragraph' ||
        node.list?.numberingId !== 'references'
      ) {
        continue
      }
      const label =
        node.list.ordinal?.toString() ??
        node.text.trim().match(/^\[?([0-9]+)\]?[.)]?\s+/)?.[1]
      if (label && !bibliographyTargets.has(label)) {
        bibliographyTargets.set(label, node.id)
      }
    }
    citationTargetIds = labels.flatMap((label) => {
      const target = bibliographyTargets.get(label)
      return target ? [target] : []
    })
    const replacesCitation = reconstruction.citationRelationships.some(
      (candidate) => candidate.id === relationship.id,
    )
    const citation = {
      id: relationship.id,
      label: relationship.label,
      labels,
      referenceRegionId: relationship.referenceRegionId,
      referenceStart: relationship.referenceStart,
      referenceEnd: relationship.referenceEnd,
      taxonomy: 'human-reclassified-citation' as const,
      targetNodeIds: [...new Set(citationTargetIds)],
      status:
        citationTargetIds.length === labels.length
          ? ('matched' as const)
          : ('unresolved' as const),
      canonicalAnchor: null,
      confidence: relationship.confidence,
      evidence: [...relationship.evidence],
      sourceBoxes: relationship.sourceBoxes.map((box) => ({ ...box })),
    }
    reconstruction.citationRelationships = [
      ...reconstruction.citationRelationships.filter(
        (candidate) => candidate.id !== citation.id,
      ),
      citation,
    ].sort((left, right) => left.id.localeCompare(right.id))
    if (!replacesCitation) {
      reconstruction.completeness.expectedInlineSpanCount += 1
      reconstruction.completeness.inlineSpanCoverage =
        reconstruction.completeness.mappedInlineSpanCount /
        reconstruction.completeness.expectedInlineSpanCount
    }
    if (citation.status === 'unresolved') {
      reconstruction.diagnostics.push({
        code: 'UNRESOLVED_CITATION_REFERENCE',
        severity: 'error',
        page: citation.sourceBoxes[0]?.page,
        message: `Citation marker ${citation.id} has no complete bibliography-label target.`,
        sourceBoxes: citation.sourceBoxes,
        relationshipId: citation.id,
        target: {
          regionIds: [citation.referenceRegionId],
          markerId: citation.id,
        },
      })
    } else {
      reconstruction.diagnostics.push({
        code: 'UNMAPPED_CITATION_ANCHOR',
        severity: 'error',
        page: citation.sourceBoxes[0]?.page,
        message: `Citation marker ${citation.id} has bibliography targets but no exact canonical inline anchor.`,
        sourceBoxes: citation.sourceBoxes,
        relationshipId: citation.id,
        target: {
          regionIds: [citation.referenceRegionId],
          markerId: citation.id,
        },
      })
    }
  } else if (decision.resolution.type === 'reclassify-plain-text') {
    relationship.targetNoteId = null
    relationship.status = 'plain-text'
    relationship.evidence = [...relationship.evidence, 'human-adjudication']
  } else {
    return false
  }

  const referenceNode = reconstruction.paper.nodes.find((node) =>
    reconstruction.provenance[node.id]?.regionIds.includes(
      relationship.referenceRegionId,
    ),
  )
  for (const node of reconstruction.paper.nodes) {
    if ('noteReferences' in node && node.noteReferences) {
      node.noteReferences = node.noteReferences.filter(
        (reference) => reference.id !== relationship.id,
      )
      if (node.noteReferences.length === 0) delete node.noteReferences
    }
    if (node.type === 'footnote') {
      node.relationships.backlinks = node.relationships.backlinks.filter(
        (backlink) => backlink !== relationship.id,
      )
    }
  }
  if (
    decision.resolution.type === 'reclassify-citation' &&
    referenceNode &&
    (referenceNode.type === 'heading' ||
      referenceNode.type === 'paragraph' ||
      referenceNode.type === 'quote')
  ) {
    const semanticRun = {
      start: relationship.referenceStart,
      end: relationship.referenceEnd,
      relationshipId: relationship.id,
      semanticRole: 'citation' as const,
      ...(citationTargetIds?.length ? { targetIds: citationTargetIds } : {}),
    }
    const existing = referenceNode.inlineRuns?.find(
      (run) => run.start === semanticRun.start && run.end === semanticRun.end,
    )
    if (existing) Object.assign(existing, semanticRun)
    else {
      referenceNode.inlineRuns = [
        ...(referenceNode.inlineRuns ?? []),
        semanticRun,
      ].sort((left, right) => left.start - right.start || left.end - right.end)
    }
  }
  if (
    targetNoteId &&
    referenceNode &&
    (referenceNode.type === 'heading' ||
      referenceNode.type === 'paragraph' ||
      referenceNode.type === 'quote')
  ) {
    referenceNode.noteReferences = [
      ...(referenceNode.noteReferences ?? []),
      {
        id: relationship.id,
        label: relationship.label,
        target: targetNoteId,
        start: relationship.referenceStart,
        end: relationship.referenceEnd,
        confidence: relationship.confidence,
      },
    ].sort(
      (left, right) =>
        left.start - right.start || left.id.localeCompare(right.id),
    )
    const target = reconstruction.paper.nodes.find(
      (node) => node.id === targetNoteId && node.type === 'footnote',
    )
    if (target?.type === 'footnote') {
      target.relationships.backlinks = [
        ...new Set([...target.relationships.backlinks, relationship.id]),
      ].sort()
    }
  }
  return true
}

function updateReadingOrder(
  reconstruction: PdfReconstruction,
  diagnostic: ReconstructionDiagnostic,
  decision: HumanAdjudicationRecord,
) {
  if (
    decision.diagnosticCode !== 'AMBIGUOUS_READING_ORDER' ||
    decision.resolution.type !== 'accept-reading-order'
  ) {
    return false
  }
  const candidates = readingOrderCandidates(reconstruction, diagnostic)
  const chosen = decision.resolution.regionIds
  if (!candidates.some((candidate) => sameValues(candidate, chosen)))
    return false

  const targetIds = new Set(decision.target.regionIds)
  const nextOrder: string[] = []
  let inserted = false
  for (const regionId of reconstruction.readingOrder.order) {
    if (!targetIds.has(regionId)) {
      nextOrder.push(regionId)
    } else if (!inserted) {
      nextOrder.push(...chosen)
      inserted = true
    }
  }
  const selectedPairs = new Set(
    chosen.slice(0, -1).map((id, index) => `${id}\u0000${chosen[index + 1]}`),
  )
  reconstruction.readingOrder.edges = reconstruction.readingOrder.edges
    .filter((edge) => {
      if (
        edge.status !== 'candidate' ||
        !targetIds.has(edge.from) ||
        !targetIds.has(edge.to)
      ) {
        return true
      }
      return selectedPairs.has(`${edge.from}\u0000${edge.to}`)
    })
    .map((edge) =>
      edge.status === 'candidate' &&
      targetIds.has(edge.from) &&
      targetIds.has(edge.to)
        ? { ...edge, status: 'accepted' as const }
        : edge,
    )
  reconstruction.readingOrder.order = nextOrder
  const unresolvedEdgeCount = reconstruction.readingOrder.edges.filter(
    (edge) => edge.status === 'candidate',
  ).length
  reconstruction.readingOrder.evaluation = {
    ...reconstruction.readingOrder.evaluation,
    acceptedEdgeCount:
      reconstruction.readingOrder.edges.length - unresolvedEdgeCount,
    unresolvedEdgeCount,
    reviewRequired:
      !reconstruction.readingOrder.acyclic || unresolvedEdgeCount > 0,
  }

  const positions = new Map(nextOrder.map((id, index) => [id, index]))
  reconstruction.paper.nodes = reconstruction.paper.nodes
    .map((node, index) => ({ node, index }))
    .sort((left, right) => {
      const leftRegion = reconstruction.provenance[left.node.id]?.regionIds[0]
      const rightRegion = reconstruction.provenance[right.node.id]?.regionIds[0]
      return (
        (positions.get(leftRegion) ?? Number.MAX_SAFE_INTEGER) -
          (positions.get(rightRegion) ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index
      )
    })
    .map(({ node }) => node)
  return true
}

function occurrenceIndexes(value: string, query: string) {
  if (!query) return []
  const indexes: number[] = []
  let cursor = 0
  while (cursor <= value.length - query.length) {
    const index = value.indexOf(query, cursor)
    if (index < 0) break
    indexes.push(index)
    cursor = index + Math.max(query.length, 1)
  }
  return indexes
}

function shiftedRange(start: number, end: number, removedIndex: number) {
  return {
    start: start > removedIndex ? start - 1 : start,
    end: end > removedIndex ? end - 1 : end,
  }
}

type CanonicalNode = PdfReconstruction['paper']['nodes'][number]
type CanonicalTextNode = CanonicalNode & { text: string }

function hasCanonicalText(node: CanonicalNode): node is CanonicalTextNode {
  return 'text' in node
}

function updateNodeRanges(
  node: PdfReconstruction['paper']['nodes'][number],
  removedIndex: number,
) {
  if ('inlineRuns' in node && node.inlineRuns) {
    node.inlineRuns = node.inlineRuns.map((run) => ({
      ...run,
      ...shiftedRange(run.start, run.end, removedIndex),
    }))
  }
  if ('noteReferences' in node && node.noteReferences) {
    node.noteReferences = node.noteReferences.map((reference) => ({
      ...reference,
      ...shiftedRange(reference.start, reference.end, removedIndex),
    }))
  }
}

function removeLineJoinHyphen(
  reconstruction: PdfReconstruction,
  regionId: string,
  fromLineId: string,
  toLineId: string,
) {
  const region = reconstruction.regions.find(
    (candidate) => candidate.id === regionId,
  )
  if (!region) return false
  const fromIndex = region.lines.findIndex((line) => line.id === fromLineId)
  if (fromIndex < 0 || region.lines[fromIndex + 1]?.id !== toLineId) {
    return false
  }
  const fromText = region.lines[fromIndex].text.trim()
  const toText = region.lines[fromIndex + 1].text.trim()
  const left = fromText.match(/([\p{L}\p{N}]+)([-‐‑])$/u)
  const right = toText.match(/^([\p{L}\p{N}]+)/u)
  if (!left || !right) return false
  const sourceBoundary = `${left[1]}${left[2]}${right[1]}`
  const resolvedBoundary = `${left[1]}${right[1]}`
  const transition = reconstruction.lineBoundaryDecisions.find(
    (candidate) =>
      candidate.regionId === regionId &&
      candidate.fromLineId === fromLineId &&
      candidate.toLineId === toLineId,
  )
  if (!transition) return false
  const currentRegionText = replayPdfRegionLineText(
    region,
    reconstruction.lineBoundaryDecisions,
  )
  const resolvedRegionText = replayPdfRegionLineText(
    region,
    reconstruction.lineBoundaryDecisions.map((candidate) =>
      candidate.id === transition.id
        ? {
            ...candidate,
            outcome: 'removed-discretionary-hyphen' as const,
          }
        : candidate,
    ),
  )
  if (
    currentRegionText !== region.text ||
    !resolvedRegionText ||
    resolvedRegionText.length !== region.text.length - 1
  ) {
    return false
  }
  const sourceHyphenIndexes: number[] = []
  for (let index = 0; index < region.text.length; index += 1) {
    if (
      /[-‐‑]/u.test(region.text[index]) &&
      `${region.text.slice(0, index)}${region.text.slice(index + 1)}` ===
        resolvedRegionText
    ) {
      sourceHyphenIndexes.push(index)
    }
  }
  if (sourceHyphenIndexes.length !== 1) return false
  const sourceHyphenIndex = sourceHyphenIndexes[0]

  const candidateNodes = reconstruction.paper.nodes
    .filter(hasCanonicalText)
    .filter((node) =>
      reconstruction.provenance[node.id]?.regionIds.includes(regionId),
    )
  let canonicalMatches = candidateNodes.flatMap((node) =>
    occurrenceIndexes(node.text, region.text).map((index) => ({
      node,
      index: index + sourceHyphenIndex,
    })),
  )
  if (canonicalMatches.length !== 1) {
    canonicalMatches = candidateNodes.flatMap((node) =>
      occurrenceIndexes(node.text, sourceBoundary).map((index) => ({
        node,
        index: index + left[1].length,
      })),
    )
  }
  if (canonicalMatches.length !== 1) return false
  const canonicalMatch = canonicalMatches[0]

  const originalRegionText = region.text
  region.text = resolvedRegionText
  canonicalMatch.node.text = `${canonicalMatch.node.text.slice(0, canonicalMatch.index)}${canonicalMatch.node.text.slice(canonicalMatch.index + 1)}`
  updateNodeRanges(canonicalMatch.node, canonicalMatch.index)

  for (const relationship of reconstruction.noteRelationships) {
    if (relationship.referenceRegionId !== regionId) continue
    const range = shiftedRange(
      relationship.referenceStart,
      relationship.referenceEnd,
      sourceHyphenIndex,
    )
    relationship.referenceStart = range.start
    relationship.referenceEnd = range.end
  }
  for (const relationship of reconstruction.citationRelationships) {
    if (relationship.referenceRegionId === regionId) {
      const range = shiftedRange(
        relationship.referenceStart,
        relationship.referenceEnd,
        sourceHyphenIndex,
      )
      relationship.referenceStart = range.start
      relationship.referenceEnd = range.end
    }
    if (relationship.canonicalAnchor?.nodeId === canonicalMatch.node.id) {
      const range = shiftedRange(
        relationship.canonicalAnchor.start,
        relationship.canonicalAnchor.end,
        canonicalMatch.index,
      )
      relationship.canonicalAnchor.start = range.start
      relationship.canonicalAnchor.end = range.end
    }
  }
  for (const diagnostic of reconstruction.diagnostics) {
    const classification = diagnostic.noteMarkerClassification
    if (classification?.referenceRegionId !== regionId) continue
    const range = shiftedRange(
      classification.start,
      classification.end,
      sourceHyphenIndex,
    )
    classification.start = range.start
    classification.end = range.end
  }
  for (const key of ['title', 'subtitle', 'abstract'] as const) {
    const value = reconstruction.paper[key]
    if (occurrenceIndexes(value, originalRegionText).length === 1) {
      reconstruction.paper[key] = value.replace(
        originalRegionText,
        resolvedRegionText,
      )
    } else if (occurrenceIndexes(value, sourceBoundary).length === 1) {
      reconstruction.paper[key] = value.replace(
        sourceBoundary,
        resolvedBoundary,
      )
    }
  }
  return true
}

function updateLineJoin(
  reconstruction: PdfReconstruction,
  decision: HumanAdjudicationRecord,
) {
  if (
    decision.diagnosticCode !== 'UNRESOLVED_CORRUPTING_JOIN' ||
    decision.resolution.type !== 'resolve-line-join'
  ) {
    return false
  }
  const resolution = decision.resolution
  const transition = reconstruction.lineBoundaryDecisions.find(
    (candidate) => candidate.id === resolution.transition.id,
  )
  if (
    !transition ||
    transition.outcome !== 'unresolved' ||
    transition.regionId !== resolution.transition.regionId ||
    transition.fromLineId !== resolution.transition.fromLineId ||
    transition.toLineId !== resolution.transition.toLineId ||
    decision.target.markerId !== transition.id ||
    !sameValues(decision.target.regionIds, [transition.regionId])
  ) {
    return false
  }
  const region = reconstruction.regions.find(
    (candidate) => candidate.id === transition.regionId,
  )
  if (!region || !buildPdfLineJoinReviewContext(region, transition)) {
    return false
  }
  if (
    resolution.outcome === 'remove-wrap-hyphen' &&
    !removeLineJoinHyphen(
      reconstruction,
      transition.regionId,
      transition.fromLineId,
      transition.toLineId,
    )
  ) {
    return false
  }

  transition.outcome =
    resolution.outcome === 'remove-wrap-hyphen'
      ? 'removed-discretionary-hyphen'
      : resolution.outcome === 'preserve-authored-hyphen'
        ? 'preserved-lexical-hyphen'
        : 'unresolved'
  transition.evidence = [
    ...new Set([...transition.evidence, ...resolution.evidence]),
  ]
  reconstruction.unresolvedCorruptingJoinCount =
    reconstruction.lineBoundaryDecisions.filter(
      (candidate) => candidate.outcome === 'unresolved',
    ).length
  reconstruction.structurallyConsumedLineBoundaryCount =
    reconstruction.lineBoundaryDecisions.filter(
      (candidate) => candidate.outcome === 'structural-boundary',
    ).length
  return true
}

function legalDismissal(diagnostic: ReconstructionDiagnostic) {
  return diagnostic.severity !== 'error'
}

export function applyHumanDecisionFile(
  reconstruction: PdfReconstruction,
  input: HumanDecisionFile,
) {
  const file = humanDecisionFileSchema.parse(input)
  const result = structuredClone(reconstruction)
  result.diagnostics = result.diagnostics.filter(
    (diagnostic) =>
      !QUALITY_DIAGNOSTIC_CODES.has(diagnostic.code) &&
      diagnostic.code !== 'STALE_HUMAN_DECISION',
  )
  const applied: HumanAdjudicationRecord[] = []
  const stale: PdfReconstruction['humanAdjudications']['stale'] = []

  for (const rawDecision of file.decisions) {
    const decision = normalizedRecord(rawDecision)
    if (file.documentSha256 !== result.source.sha256) {
      stale.push({ ...decision, reason: 'document-sha256-mismatch' })
      continue
    }
    if (decision.resolution.type === 'resolve-line-join') {
      if (!updateLineJoin(result, decision)) {
        stale.push({ ...decision, reason: 'resolution-no-longer-legal' })
        continue
      }
      applied.push(decision)
      continue
    }
    const diagnostic = diagnosticForDecision(result, decision)
    if (!diagnostic) {
      stale.push({ ...decision, reason: 'diagnostic-target-missing' })
      continue
    }

    const appliedLegally =
      updateNoteRelationship(result, decision) ||
      updateReadingOrder(result, diagnostic, decision) ||
      (decision.resolution.type === 'dismiss' && legalDismissal(diagnostic))
    if (!appliedLegally) {
      stale.push({ ...decision, reason: 'resolution-no-longer-legal' })
      continue
    }
    result.diagnostics = result.diagnostics.filter(
      (candidate) => candidate !== diagnostic,
    )
    applied.push(decision)
  }

  const assessment = assessPdfCompleteness({
    pages: result.pages,
    paper: result.paper,
    diagnostics: result.diagnostics,
    readingOrder: result.readingOrder,
    regions: result.regions,
    visualRelationships: result.visualRelationships,
    assets: result.assets,
    citationRelationships: result.citationRelationships,
    provenance: result.provenance,
    lineBoundaryDecisions: result.lineBoundaryDecisions,
    unresolvedCorruptingJoinCount: result.unresolvedCorruptingJoinCount,
    structurallyConsumedLineBoundaryCount:
      result.structurallyConsumedLineBoundaryCount,
    inlineSpanLedger: {
      expected: result.completeness.expectedInlineSpanCount,
      mapped: result.completeness.mappedInlineSpanCount,
    },
    policy: result.readiness.policy,
    reclassifiedNoteReferenceCount: result.noteRelationships.filter(
      (relationship) =>
        relationship.status === 'citation' ||
        relationship.status === 'plain-text',
    ).length,
    reclassifiedCitationCount: result.noteRelationships.filter(
      (relationship) => relationship.status === 'citation',
    ).length,
  })
  result.semanticSignals = assessment.semanticSignals
  result.completeness = assessment.completeness
  result.diagnostics = [
    ...assessment.diagnostics,
    ...stale.map<ReconstructionDiagnostic>((decision) => ({
      code: 'STALE_HUMAN_DECISION',
      severity: 'warning',
      message: `A saved ${decision.diagnosticCode} decision is stale (${decision.reason}).`,
      target: { ...decision.target, regionIds: [...decision.target.regionIds] },
    })),
  ]
  result.readiness = assessment.readiness
  const countsByDiagnosticCode = applied.reduce<Record<string, number>>(
    (counts, decision) => {
      counts[decision.diagnosticCode] =
        (counts[decision.diagnosticCode] ?? 0) + 1
      return counts
    },
    {},
  )
  result.humanAdjudications = {
    schemaVersion: file.schemaVersion,
    documentSha256: result.source.sha256,
    applied,
    stale,
    countsByDiagnosticCode,
  }
  return result
}

import { z } from 'zod'
import type {
  HumanAdjudicationRecord,
  PdfReconstruction,
  ReconstructionDiagnostic,
} from './import-types'
import { assessPdfCompleteness } from './pdf-quality'

export const HUMAN_DECISION_SCHEMA_VERSION = '1.0.0' as const
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
  z.object({ type: z.literal('dismiss') }).strict(),
])

export const humanAdjudicationRecordSchema = z
  .object({
    diagnosticCode: diagnosticCodeSchema,
    target: targetSchema,
    resolution: resolutionSchema,
  })
  .strict()

export const humanDecisionFileSchema = z
  .object({
    schemaVersion: z.literal(HUMAN_DECISION_SCHEMA_VERSION),
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
    }
  })

export type HumanDecisionFile = z.infer<typeof humanDecisionFileSchema>

const QUALITY_DIAGNOSTIC_CODES = new Set<ReconstructionDiagnostic['code']>([
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
  return {
    diagnosticCode: decision.diagnosticCode,
    target: normalizedTarget(decision.target),
    resolution:
      decision.resolution.type === 'accept-reading-order'
        ? {
            ...decision.resolution,
            regionIds: [...decision.resolution.regionIds],
          }
        : { ...decision.resolution },
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
    policy: result.readiness.policy,
    reclassifiedNoteReferenceCount: result.noteRelationships.filter(
      (relationship) =>
        relationship.status === 'citation' ||
        relationship.status === 'plain-text',
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
    schemaVersion: HUMAN_DECISION_SCHEMA_VERSION,
    documentSha256: result.source.sha256,
    applied,
    stale,
    countsByDiagnosticCode,
  }
  return result
}

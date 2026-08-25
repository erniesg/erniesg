import type {
  PdfNoteMarkerClassification,
  PdfNoteRelationship,
  PdfPageRegion,
  ReconstructionDiagnostic,
} from './import-types'
import { normalizedNoteLabel } from './pdf-regions'

type PdfNoteMatchingBlock = {
  type: 'heading' | 'paragraph' | 'caption' | 'footnote'
  region: PdfPageRegion
  noteKind?: 'footnote' | 'endnote'
  noteLabel?: string
  nodeId?: string
}

type PdfNoteReferenceDraft = {
  id: string
  label: string
  region: PdfPageRegion
  start: number
  end: number
  classification: PdfNoteMarkerClassification
  canonicalAnchor:
    | { kind: 'node'; nodeId: string; start: number; end: number }
    | { kind: 'author'; author: string }
    | null
}

export const PDF_NOTE_RELATIONSHIP_THRESHOLD = 0.7

function rounded(value: number) {
  return Math.round(value * 100_000) / 100_000
}

function scoreNoteCandidate(
  reference: PdfNoteReferenceDraft,
  note: PdfNoteMatchingBlock,
  sequenceEvidence: readonly string[],
) {
  let score = 0.55
  const evidence = ['label-exact', ...sequenceEvidence]
  if (sequenceEvidence.length > 0) score += 0.08
  if (
    reference.classification.evidence.includes('rendered-superscript-geometry')
  ) {
    evidence.push('typography-raised-marker')
  } else if (
    reference.classification.evidence.some((item) =>
      ['superscript-syntax', 'superscript-cluster-syntax'].includes(item),
    )
  ) {
    evidence.push('typography-superscript-glyph')
  } else if (
    reference.classification.evidence.includes('explicit-note-language')
  ) {
    evidence.push('typography-explicit-note-marker')
  }
  if (reference.region.page === note.region.page) {
    score += 0.25
    evidence.push('same-page-scope')
    if (reference.region.column === note.region.column) {
      score += 0.1
      evidence.push('same-column-geometry')
    } else if (note.region.column === 'span') {
      score += 0.06
      evidence.push('page-wide-note-region')
    }
    if (note.region.box.y >= reference.region.box.y) {
      score += 0.05
      evidence.push('note-follows-reference')
    }
  } else if (
    note.noteKind === 'endnote' &&
    note.region.page >= reference.region.page
  ) {
    const distance = note.region.page - reference.region.page
    score += Math.max(0.12, 0.2 - distance * 0.025)
    evidence.push('later-endnote-section-scope')
  }
  return { score: rounded(Math.min(score, 1)), evidence }
}

export function matchPdfNotes(
  blocks: PdfNoteMatchingBlock[],
  references: PdfNoteReferenceDraft[],
  diagnostics: ReconstructionDiagnostic[],
) {
  const notes = blocks.filter((block) => block.type === 'footnote')
  const sourceOrder = <Value extends { region: PdfPageRegion }>(
    left: Value,
    right: Value,
  ) =>
    left.region.page - right.region.page ||
    left.region.box.y - right.region.box.y ||
    left.region.box.x - right.region.box.x
  const orderedReferences = [...references].sort(
    (left, right) => sourceOrder(left, right) || left.start - right.start,
  )
  const orderedNotes = [...notes].sort(sourceOrder)
  const numericOrdinal = (label: string | undefined) => {
    const normalized = normalizedNoteLabel(label ?? '')
    return /^\d+$/u.test(normalized) ? Number(normalized) : null
  }
  const sequenceEvidence = (
    reference: PdfNoteReferenceDraft,
    note: PdfNoteMatchingBlock,
  ) => {
    const ordinal = numericOrdinal(reference.label)
    if (ordinal === null || ordinal !== numericOrdinal(note.noteLabel))
      return []
    const currentLabelCount = orderedNotes.filter(
      (candidate) => numericOrdinal(candidate.noteLabel) === ordinal,
    ).length
    const referenceIndex = orderedReferences.indexOf(reference)
    const noteIndex = orderedNotes.indexOf(note)
    const previousReference = orderedReferences
      .slice(0, referenceIndex)
      .reverse()
      .find((candidate) => numericOrdinal(candidate.label) !== null)
    const previousNote = orderedNotes
      .slice(0, noteIndex)
      .reverse()
      .find((candidate) => numericOrdinal(candidate.noteLabel) !== null)
    const nextReference = orderedReferences
      .slice(referenceIndex + 1)
      .find((candidate) => numericOrdinal(candidate.label) !== null)
    const nextNote = orderedNotes
      .slice(noteIndex + 1)
      .find((candidate) => numericOrdinal(candidate.noteLabel) !== null)
    if (
      numericOrdinal(previousReference?.label) === ordinal - 1 &&
      numericOrdinal(previousNote?.noteLabel) === ordinal - 1
    ) {
      return ['numbering-sequence-previous-adjacency']
    }
    if (
      numericOrdinal(nextReference?.label) === ordinal + 1 &&
      numericOrdinal(nextNote?.noteLabel) === ordinal + 1
    ) {
      return ['numbering-sequence-next-adjacency']
    }
    return ordinal === 1 &&
      currentLabelCount === 1 &&
      !previousReference &&
      !previousNote
      ? ['numbering-sequence-start']
      : []
  }
  const relationships: PdfNoteRelationship[] = references.map((reference) => {
    const candidates = notes
      .filter(
        (note) =>
          normalizedNoteLabel(note.noteLabel ?? '') ===
          normalizedNoteLabel(reference.label),
      )
      .map((note) => {
        const scored = scoreNoteCandidate(
          reference,
          note,
          sequenceEvidence(reference, note),
        )
        return {
          targetNoteId: note.nodeId!,
          targetRegionId: note.region.id,
          score: scored.score,
          evidence: scored.evidence,
          sourceBoxes: [reference.classification.sourceBox, note.region.box],
        }
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.targetNoteId.localeCompare(right.targetNoteId),
      )
    const best = candidates[0]
    const ambiguous =
      Boolean(best) &&
      Boolean(candidates[1]) &&
      best.score - candidates[1].score < 0.04
    const canonicalAnchorMissing = reference.canonicalAnchor === null
    const matched =
      Boolean(best) &&
      best.score >= PDF_NOTE_RELATIONSHIP_THRESHOLD &&
      !ambiguous &&
      !canonicalAnchorMissing
    if (ambiguous) {
      diagnostics.push({
        code: 'AMBIGUOUS_NOTE_MATCH',
        severity: 'error',
        page: reference.region.page,
        message: `Note reference ${reference.id} retains ${candidates.length} similarly scored targets for review.`,
        relationshipId: reference.id,
        sourceBoxes: [
          reference.region.box,
          ...candidates.map((candidate) => candidate.sourceBoxes[1]),
        ],
        target: {
          regionIds: [
            reference.region.id,
            ...candidates.map((candidate) => candidate.targetRegionId),
          ],
          markerId: reference.id,
        },
      })
    } else if (!matched) {
      diagnostics.push({
        code: 'UNRESOLVED_NOTE_REFERENCE',
        severity: 'error',
        page: reference.region.page,
        message:
          canonicalAnchorMissing && best
            ? `Note reference ${reference.id} has a label-matched target but no exact canonical source anchor.`
            : `Note reference ${reference.id} has no deterministic target at or above the ${PDF_NOTE_RELATIONSHIP_THRESHOLD.toFixed(2)} confidence threshold.`,
        relationshipId: reference.id,
        sourceBoxes: [
          reference.region.box,
          ...candidates.map((candidate) => candidate.sourceBoxes[1]),
        ],
        target: {
          regionIds: [reference.region.id],
          markerId: reference.id,
        },
      })
    }
    return {
      id: reference.id,
      label: reference.label,
      referenceRegionId: reference.region.id,
      referenceStart: reference.start,
      referenceEnd: reference.end,
      targetNoteId: matched ? best.targetNoteId : null,
      status: ambiguous ? 'ambiguous' : matched ? 'matched' : 'unresolved',
      canonicalAnchor: reference.canonicalAnchor,
      confidence: best?.score ?? 0,
      threshold: PDF_NOTE_RELATIONSHIP_THRESHOLD,
      evidence: [
        ...(best?.evidence ?? ['no-label-match']),
        ...(canonicalAnchorMissing ? ['canonical-anchor-missing'] : []),
      ],
      candidates,
      sourceBoxes: matched ? best.sourceBoxes : [reference.region.box],
    }
  })

  const noteNodeIds = new Set(notes.flatMap((note) => note.nodeId ?? []))
  const matchedNoteEdges = relationships.flatMap((relationship) => {
    const anchor = relationship.canonicalAnchor
    return relationship.status === 'matched' &&
      relationship.targetNoteId !== null &&
      anchor?.kind === 'node' &&
      noteNodeIds.has(anchor.nodeId)
      ? [
          {
            relationship,
            ownerNoteId: anchor.nodeId,
            targetNoteId: relationship.targetNoteId,
          },
        ]
      : []
  })
  const noteTargetsByOwner = new Map<string, Set<string>>()
  for (const edge of matchedNoteEdges) {
    const targets = noteTargetsByOwner.get(edge.ownerNoteId) ?? new Set()
    targets.add(edge.targetNoteId)
    noteTargetsByOwner.set(edge.ownerNoteId, targets)
  }
  const reachesNote = (
    current: string,
    target: string,
    visited: Set<string>,
  ): boolean => {
    if (current === target) return true
    if (visited.has(current)) return false
    visited.add(current)
    return [...(noteTargetsByOwner.get(current) ?? [])].some((next) =>
      reachesNote(next, target, visited),
    )
  }
  for (const edge of matchedNoteEdges) {
    if (!reachesNote(edge.targetNoteId, edge.ownerNoteId, new Set<string>())) {
      continue
    }
    edge.relationship.status = 'unresolved'
    edge.relationship.targetNoteId = null
    edge.relationship.evidence = [
      ...edge.relationship.evidence,
      'cyclic-note-reference-rejected',
    ]
    diagnostics.push({
      code: 'UNRESOLVED_NOTE_REFERENCE',
      severity: 'error',
      page: edge.relationship.sourceBoxes[0]?.page,
      message: `Note reference ${edge.relationship.id} would create a cyclic note relationship and remains unresolved.`,
      relationshipId: edge.relationship.id,
      sourceBoxes: edge.relationship.sourceBoxes,
      target: {
        regionIds: [edge.relationship.referenceRegionId],
        markerId: edge.relationship.id,
      },
    })
  }

  const referencedNotes = new Set(
    relationships.flatMap((relationship) =>
      relationship.status === 'matched'
        ? [relationship.targetNoteId]
        : relationship.status === 'ambiguous'
          ? relationship.candidates.map((candidate) => candidate.targetNoteId)
          : [],
    ),
  )
  for (const note of notes) {
    if (
      referencedNotes.has(note.nodeId!) ||
      (note.noteLabel === 'Correspondence' &&
        /^Correspondence\s+to\s*:/iu.test(note.region.text))
    ) {
      continue
    }
    diagnostics.push({
      code: 'UNREFERENCED_NOTE',
      severity: 'error',
      page: note.region.page,
      message: `Note ${note.nodeId} remains explicit because no unique reference resolved to it.`,
      sourceBoxes: [note.region.box],
      target: {
        regionIds: [note.region.id],
        markerId: note.nodeId ?? null,
      },
    })
  }
  return relationships
}

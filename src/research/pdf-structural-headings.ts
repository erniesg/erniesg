import type {
  PdfCitationRelationship,
  PdfPageRegion,
  PdfVisualRelationship,
} from './import-types'
import type { PdfCanonicalCrossReferenceTarget } from './pdf-cross-references'
import type { PdfCanonicalInternalLinkTarget } from './pdf-links'
import { parsePdfScholarlyVisualLabel } from './pdf-scholarly-label'

type PdfStructuralBlock = {
  type: 'heading' | 'paragraph' | 'caption' | 'footnote'
  region: Pick<PdfPageRegion, 'box' | 'lines'>
  text: string
  confidence: number
  headingLevel?: 1 | 2 | 3
  list?: {
    numberingId: string
    markerText?: string
    ordinal?: number
  }
  noteKind?: 'footnote' | 'endnote'
  noteLabel?: string
  sourceSegments?: Array<{
    region: Pick<PdfPageRegion, 'box'>
  }>
  nodeId?: string
}

function blockSourceSegments(block: PdfStructuralBlock) {
  return block.sourceSegments ?? [{ region: block.region }]
}

// A section ordinal is a numeral, not a word. Papers number sections with
// arabic digits, upper or lower roman numerals, or letters, and the numeral
// system carries no evidence about whether a line is a heading. Matching only
// single characters silently accepts `I.` and `X.` while rejecting `II.`
// through `IX.`, which drops most sections of a roman-numbered paper.
const SECTION_ORDINAL_SOURCE =
  '(?:\\d+|[IVXLCDM]+|[ivxlcdm]+|[A-Za-z])(?:\\.\\d+){0,3}'

export function headingLevel(
  text: string,
  largestFont: number,
  bodySize: number,
) {
  // Depth comes from the ordinal's dotted segments, whatever numeral system
  // the paper uses. Reading depth from arabic and single-letter ordinals only
  // put every multi-character roman section one level below its siblings.
  const ordinal = text
    .trim()
    .match(new RegExp(`^(${SECTION_ORDINAL_SOURCE})\\.?\\s+\\S`, 'u'))
  if (ordinal) {
    return Math.min(3, ordinal[1].split('.').length) as 1 | 2 | 3
  }
  if (
    /^(?:abstract|introduction|methods?|results?|discussion|conclusion|references|acknowledg(?:e)?ments?|ethics statement|impact statement|broader impacts?|limitations?|endnotes?|notes?)\b/i.test(
      text,
    )
  ) {
    return 1 as const
  }
  return largestFont >= bodySize * 1.45 ? (1 as const) : (2 as const)
}

function numberedHeadingOrdinal(text: string) {
  const match = text.trim().match(/^(\d+(?:\.\d+){0,3})[.)]?\s+\p{Lu}/u)
  return match?.[1].split('.').map(Number) ?? null
}

export function structuralOrdinalHeadingText(text: string) {
  return /^(?:\d+(?:\.\d+){0,3}|[A-Z](?:\.\d+)*)[.)]?\s+\p{Lu}/u.test(
    text.trim(),
  )
}

export function promoteAdjacentNumberedParentChildHeadings(
  blocks: PdfStructuralBlock[],
  bodySize: number,
) {
  for (let index = 0; index < blocks.length - 1; index += 1) {
    const parent = blocks[index]
    const child = blocks[index + 1]
    if (
      !['heading', 'paragraph'].includes(parent.type) ||
      !['heading', 'paragraph'].includes(child.type) ||
      (parent.type !== 'heading' && child.type !== 'heading') ||
      parent.region.lines.length > 2 ||
      child.region.lines.length > 2 ||
      parent.text.trim().length > 180 ||
      child.text.trim().length > 180 ||
      /[.!?](?:["'’”)\]]*)$/u.test(parent.text.trim()) ||
      /[.!?](?:["'’”)\]]*)$/u.test(child.text.trim())
    ) {
      continue
    }
    const parentOrdinal = numberedHeadingOrdinal(parent.text)
    const childOrdinal = numberedHeadingOrdinal(child.text)
    if (
      !parentOrdinal ||
      !childOrdinal ||
      childOrdinal.length !== parentOrdinal.length + 1 ||
      !parentOrdinal.every(
        (part, partIndex) => childOrdinal[partIndex] === part,
      )
    ) {
      continue
    }
    for (const block of [parent, child]) {
      const largestFont = Math.max(
        ...block.region.lines.map((line) => line.fontSize),
        bodySize,
      )
      block.type = 'heading'
      block.headingLevel = headingLevel(block.text, largestFont, bodySize)
      block.confidence = Math.min(block.confidence, 0.9)
    }
  }
}

function canonicalBlockTargetSourceBoxes(
  block: PdfStructuralBlock | undefined,
) {
  if (!block) return []
  return [
    ...new Map(
      blockSourceSegments(block).map((segment) => {
        const box = segment.region.box
        return [
          [
            box.page,
            box.x,
            box.y,
            box.width,
            box.height,
            box.rotation,
            box.method,
          ].join(':'),
          { ...box },
        ] as const
      }),
    ).values(),
  ]
}

export function canonicalHeadingCrossReferenceTargets(
  blocks: readonly PdfStructuralBlock[],
): PdfCanonicalCrossReferenceTarget[] {
  const plainLetteredHeadings = blocks.flatMap((block) => {
    if (block.type !== 'heading') return []
    const match = block.text.trim().match(/^([A-Z])\s+\p{Lu}/u)
    return match ? [{ block, ordinal: match[1].charCodeAt(0) }] : []
  })
  const sequencedPlainLetteredHeadings = new Set<PdfStructuralBlock>()
  for (let index = 0; index < plainLetteredHeadings.length - 1; index += 1) {
    const current = plainLetteredHeadings[index]
    const next = plainLetteredHeadings[index + 1]
    if (next.ordinal === current.ordinal + 1) {
      sequencedPlainLetteredHeadings.add(current.block)
      sequencedPlainLetteredHeadings.add(next.block)
    }
  }
  const nestedLetteredParentLabels = new Set(
    blocks.flatMap((block) => {
      if (block.type !== 'heading') return []
      const match = block.text.trim().match(/^([A-Z])\.\d+(?:\.\d+)*\.?\s+\S/u)
      return match ? [match[1]] : []
    }),
  )
  return blocks.flatMap((block) => {
    if (block.type !== 'heading' || !block.nodeId) return []
    const text = block.text.trim()
    const explicitAppendix = text.match(/^appendix\s+([A-Z](?:\.\d+)*)\b/iu)
    const lettered = text.match(/^([A-Z](?:\.\d+)*)\.\s+\S/u)
    const nestedLettered = text.match(/^([A-Z](?:\.\d+)+)\s+\S/u)
    const plainLetteredMatch = text.match(/^([A-Z])\s+\p{Lu}/u)
    const plainLettered =
      plainLetteredMatch &&
      (sequencedPlainLetteredHeadings.has(block) ||
        nestedLetteredParentLabels.has(plainLetteredMatch[1]))
        ? plainLetteredMatch
        : null
    const numbered = text.match(/^(\d+(?:\.\d+)*)\.?\s+\S/u)
    const identifier =
      explicitAppendix?.[1] ??
      lettered?.[1] ??
      nestedLettered?.[1] ??
      plainLettered?.[1]
    const targets: PdfCanonicalCrossReferenceTarget[] = []
    if (numbered?.[1]) {
      targets.push({
        kind: 'section',
        label: `Section ${numbered[1]}`,
        nodeId: block.nodeId,
        evidence: ['canonical-heading-label', 'source-heading-typography'],
        sourceBoxes: canonicalBlockTargetSourceBoxes(block),
      })
    }
    if (identifier) {
      targets.push({
        kind: 'appendix',
        label: `Appendix ${identifier}`,
        nodeId: block.nodeId,
        evidence: ['canonical-heading-label', 'source-heading-typography'],
        sourceBoxes: canonicalBlockTargetSourceBoxes(block),
      })
      if (identifier.includes('.')) {
        targets.push({
          kind: 'section',
          label: `Section ${identifier}`,
          nodeId: block.nodeId,
          evidence: [
            'canonical-appendix-subheading-label',
            'source-heading-typography',
          ],
          sourceBoxes: canonicalBlockTargetSourceBoxes(block),
        })
      }
    }
    return targets
  })
}

export function canonicalVisualCrossReferenceTargets(
  relationships: readonly PdfVisualRelationship[],
): PdfCanonicalCrossReferenceTarget[] {
  return relationships.flatMap((relationship) => {
    const parsedLabel = parsePdfScholarlyVisualLabel(relationship.label, {
      context: 'reference',
    })
    const unresolvedBoundedTableCaption =
      relationship.status === 'unresolved' &&
      relationship.kind === 'table' &&
      relationship.canonicalNodeId === null &&
      Boolean(relationship.captionNodeId) &&
      relationship.assetIds.length === 0 &&
      relationship.sourceRegionIds.length > 0 &&
      (relationship.sourceLineIds?.length ?? 0) > 0 &&
      relationship.evidence.includes('partial-parent-line-selection') &&
      relationship.evidence.includes('unresolved-bounded-table-text-owned')
    const targetNodeId =
      relationship.status === 'matched'
        ? relationship.canonicalNodeId
        : unresolvedBoundedTableCaption
          ? relationship.captionNodeId
          : null
    if (
      !targetNodeId ||
      parsedLabel?.status !== 'parsed' ||
      parsedLabel.plural ||
      parsedLabel.kind !== relationship.kind ||
      relationship.label.slice(parsedLabel.consumedEnd).trim().length > 0
    ) {
      return []
    }
    return [
      {
        kind: relationship.kind,
        label: relationship.label,
        nodeId: targetNodeId,
        evidence: unresolvedBoundedTableCaption
          ? [
              'unresolved-bounded-table-caption-relationship',
              'source-proved-visual-label',
            ]
          : [
              'matched-canonical-visual-relationship',
              'source-proved-visual-label',
            ],
        sourceBoxes: (unresolvedBoundedTableCaption
          ? relationship.sourceBoxes.slice(0, 1)
          : relationship.sourceBoxes
        ).map((box) => ({ ...box })),
      },
    ]
  })
}

export function canonicalCitationInternalLinkTargets(
  relationships: readonly PdfCitationRelationship[],
  blocks: readonly PdfStructuralBlock[],
): PdfCanonicalInternalLinkTarget[] {
  const blocksByNodeId = new Map(
    blocks.flatMap((block) =>
      block.nodeId ? [[block.nodeId, block] as const] : [],
    ),
  )
  return relationships.flatMap((relationship) => {
    if (
      relationship.status !== 'matched' ||
      relationship.labels.length !== relationship.targetNodeIds.length
    ) {
      return []
    }
    return relationship.labels.map((label, index) => ({
      kind: 'reference' as const,
      label: `Reference ${label}`,
      nodeId: relationship.targetNodeIds[index],
      sourceBoxes: canonicalBlockTargetSourceBoxes(
        blocksByNodeId.get(relationship.targetNodeIds[index]),
      ),
    }))
  })
}

export function canonicalBibliographyInternalLinkTargets(
  blocks: readonly PdfStructuralBlock[],
): PdfCanonicalInternalLinkTarget[] {
  return blocks.flatMap((block) => {
    if (block.list?.numberingId !== 'references' || !block.nodeId) return []
    const label =
      block.list.markerText ??
      (block.list.ordinal === undefined
        ? block.nodeId
        : `${block.list.ordinal}`)
    return [
      {
        kind: 'reference',
        label: `Reference ${label}`,
        nodeId: block.nodeId,
        sourceBoxes: canonicalBlockTargetSourceBoxes(block),
      },
    ]
  })
}

export function canonicalNoteInternalLinkTargets(
  blocks: readonly PdfStructuralBlock[],
): PdfCanonicalInternalLinkTarget[] {
  return blocks.flatMap((block) => {
    if (block.type !== 'footnote' || !block.nodeId) return []
    return [
      {
        kind: 'note',
        label: `${block.noteKind === 'endnote' ? 'Endnote' : 'Footnote'} ${block.noteLabel ?? block.nodeId}`,
        nodeId: block.nodeId,
        sourceBoxes: canonicalBlockTargetSourceBoxes(block),
      },
    ]
  })
}

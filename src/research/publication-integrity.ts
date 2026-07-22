import type { ResearchNode, ResearchPaper } from './schema'

export type CanonicalTextIntegrityIssue = {
  code: 'EPUB_TEXT_SANITIZATION_LOSS'
  nodeId: string
  field: string
  sourceCharacterCount: number
  sanitizedCharacterCount: number
  forbiddenXmlCharacterCount: number
  replacementGlyphCount: number
}

export type InternalReferenceIntegrityIssue = {
  code: 'DANGLING_EPUB_INTERNAL_REFERENCE'
  sourceId: string
  targetId: string
  relationship:
    'figure-caption' | 'note-reference' | 'note-backlink' | 'citation-target'
}

function isXml10Character(codePoint: number) {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  )
}

export function sanitizeXmlText(value: string) {
  return [...value]
    .filter((character) => isXml10Character(character.codePointAt(0)!))
    .join('')
}

function canonicalTextFields(node: ResearchNode) {
  const fields: Array<{ field: string; value: string }> = []
  if ('text' in node) fields.push({ field: 'text', value: node.text })
  if (node.type === 'figure') {
    fields.push({ field: 'title', value: node.title })
    if (node.sourceText) {
      fields.push({ field: 'sourceText', value: node.sourceText })
    }
    for (const [rowIndex, row] of (node.table?.rows ?? []).entries()) {
      for (const [cellIndex, cell] of row.cells.entries()) {
        fields.push({
          field: `table.rows[${rowIndex}].cells[${cellIndex}].text`,
          value: cell.text,
        })
      }
    }
  }
  if (node.type === 'paragraph' && node.list?.markerText) {
    fields.push({ field: 'list.markerText', value: node.list.markerText })
  }
  if (node.type === 'footnote') {
    fields.push({ field: 'label', value: node.label })
    if (node.markerText) {
      fields.push({ field: 'markerText', value: node.markerText })
    }
  }
  return fields
}

export function canonicalTextIntegrityIssues(
  paper: ResearchPaper,
): CanonicalTextIntegrityIssue[] {
  return paper.nodes.flatMap((node) =>
    canonicalTextFields(node).flatMap(({ field, value }) => {
      const characters = [...value]
      const sanitized = sanitizeXmlText(value)
      const forbiddenXmlCharacterCount = characters.filter(
        (character) => !isXml10Character(character.codePointAt(0)!),
      ).length
      const replacementGlyphCount = characters.filter(
        (character) => character === '\ufffd',
      ).length
      if (forbiddenXmlCharacterCount === 0 && replacementGlyphCount === 0) {
        return []
      }
      return [
        {
          code: 'EPUB_TEXT_SANITIZATION_LOSS' as const,
          nodeId: node.id,
          field,
          sourceCharacterCount: characters.length,
          sanitizedCharacterCount: [...sanitized].length,
          forbiddenXmlCharacterCount,
          replacementGlyphCount,
        },
      ]
    }),
  )
}

function validNoteReferenceRange(
  text: string,
  reference: { start: number; end: number },
) {
  return (
    reference.start >= 0 &&
    reference.start < reference.end &&
    reference.end <= text.length
  )
}

export function renderableAuthorNoteReferences(paper: ResearchPaper) {
  return (paper.authorNotes ?? []).filter((reference) =>
    paper.authors.includes(reference.author),
  )
}

export function internalReferenceIntegrityIssues(
  paper: ResearchPaper,
): InternalReferenceIntegrityIssue[] {
  const issues: InternalReferenceIntegrityIssue[] = []
  const nodesById = new Map(paper.nodes.map((node) => [node.id, node]))
  const renderedNoteReferences = [
    ...renderableAuthorNoteReferences(paper).map((reference) => ({
      id: reference.id,
      target: reference.target,
    })),
    ...paper.nodes.flatMap((node) =>
      'noteReferences' in node
        ? (node.noteReferences ?? [])
            .filter((reference) =>
              validNoteReferenceRange(node.text, reference),
            )
            .map((reference) => ({
              id: reference.id,
              target: reference.target,
            }))
        : [],
    ),
  ]
  const noteTargetsByReferenceId = new Map(
    renderedNoteReferences.map((reference) => [reference.id, reference.target]),
  )

  for (const node of paper.nodes) {
    if (node.type === 'figure') {
      if (nodesById.get(node.relationships.caption)?.type !== 'caption') {
        issues.push({
          code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
          sourceId: node.id,
          targetId: node.relationships.caption,
          relationship: 'figure-caption',
        })
      }
    }
    if ('inlineRuns' in node) {
      const inlineText =
        node.type === 'figure' ? (node.sourceText ?? '') : node.text
      for (const run of node.inlineRuns ?? []) {
        if (
          run.semanticRole !== 'citation' ||
          !run.targetIds?.length ||
          run.start < 0 ||
          run.start >= run.end ||
          run.end > inlineText.length
        ) {
          continue
        }
        for (const targetId of run.targetIds) {
          if (!nodesById.has(targetId)) {
            issues.push({
              code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
              sourceId: run.relationshipId ?? node.id,
              targetId,
              relationship: 'citation-target',
            })
          }
        }
      }
    }
    if (node.type !== 'footnote') continue
    for (const backlink of node.relationships.backlinks) {
      if (noteTargetsByReferenceId.get(backlink) !== node.id) {
        issues.push({
          code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
          sourceId: node.id,
          targetId: backlink,
          relationship: 'note-backlink',
        })
      }
    }
  }

  for (const reference of renderedNoteReferences) {
    const target = nodesById.get(reference.target)
    if (
      target?.type !== 'footnote' ||
      !target.relationships.backlinks.includes(reference.id)
    ) {
      issues.push({
        code: 'DANGLING_EPUB_INTERNAL_REFERENCE',
        sourceId: reference.id,
        targetId: reference.target,
        relationship: 'note-reference',
      })
    }
  }

  return issues
}

export function assertPublicationIntegrity(paper: ResearchPaper) {
  const textIssues = canonicalTextIntegrityIssues(paper)
  if (textIssues.length > 0) {
    const first = textIssues[0]
    throw new Error(
      `EPUB_TEXT_SANITIZATION_LOSS: ${textIssues.length} canonical text field${textIssues.length === 1 ? '' : 's'} contain forbidden XML code points or Unicode replacement glyphs; first affected field is ${first.nodeId}.${first.field}.`,
    )
  }
  const referenceIssues = internalReferenceIntegrityIssues(paper)
  if (referenceIssues.length > 0) {
    const first = referenceIssues[0]
    throw new Error(
      `DANGLING_EPUB_INTERNAL_REFERENCE: ${referenceIssues.length} canonical dangling internal reference${referenceIssues.length === 1 ? '' : 's'} cannot resolve; first affected relationship is ${first.relationship} from ${first.sourceId} to ${first.targetId}.`,
    )
  }
}

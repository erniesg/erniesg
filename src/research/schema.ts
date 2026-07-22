import { z } from 'zod'

const canonicalId = z.string().min(1)

const canonicalNodeBase = z
  .object({
    id: canonicalId,
    source: z.string().min(1),
  })
  .strict()

const noteReference = z
  .object({
    id: canonicalId,
    label: z.string().min(1),
    target: canonicalId,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    confidence: z.number().min(0).max(1),
  })
  .strict()

const inlineRun = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    href: z.string().min(1).optional(),
    verticalAlign: z.enum(['superscript', 'subscript']).optional(),
    relationshipId: canonicalId.optional(),
    semanticRole: z
      .enum([
        'citation',
        'cross-reference',
        'affiliation-marker',
        'bibliography-entry',
      ])
      .optional(),
    targetIds: z.array(canonicalId).optional(),
  })
  .strict()

const listContext = z
  .object({
    level: z.number().int().min(1).max(9),
    ordered: z.boolean(),
    numberingId: canonicalId,
    markerStyle: z
      .enum([
        'decimal',
        'lower-roman',
        'upper-roman',
        'lower-alpha',
        'upper-alpha',
        'disc',
      ])
      .optional(),
    ordinal: z.number().int().positive().optional(),
    markerText: z.string().min(1).optional(),
    continuedFromPreviousPage: z.boolean().optional(),
  })
  .strict()

const headingNode = canonicalNodeBase
  .extend({
    type: z.literal('heading'),
    level: z.number().int().min(1).max(3),
    text: z.string().min(1),
    noteReferences: z.array(noteReference).optional(),
    inlineRuns: z.array(inlineRun).optional(),
  })
  .strict()

const paragraphNode = canonicalNodeBase
  .extend({
    type: z.literal('paragraph'),
    text: z.string().min(1),
    noteReferences: z.array(noteReference).optional(),
    inlineRuns: z.array(inlineRun).optional(),
    list: listContext.optional(),
  })
  .strict()

const quoteNode = canonicalNodeBase
  .extend({
    type: z.literal('quote'),
    text: z.string().min(1),
    noteReferences: z.array(noteReference).optional(),
    inlineRuns: z.array(inlineRun).optional(),
  })
  .strict()

const captionNode = canonicalNodeBase
  .extend({
    type: z.literal('caption'),
    text: z.string().min(1),
  })
  .strict()

const figureNode = canonicalNodeBase
  .extend({
    type: z.literal('figure'),
    title: z.string().min(1),
    objectType: z.enum(['figure', 'table', 'equation']).optional(),
    sourceText: z.string().min(1).optional(),
    inlineRuns: z.array(inlineRun).optional(),
    table: z
      .object({
        rows: z
          .array(
            z
              .object({
                cells: z
                  .array(
                    z
                      .object({
                        text: z.string(),
                        headerScope: z.enum(['column', 'row']).nullable(),
                        columnSpan: z.number().int().positive(),
                        rowSpan: z.number().int().positive(),
                      })
                      .strict(),
                  )
                  .min(1),
              })
              .strict(),
          )
          .min(1),
      })
      .strict()
      .optional(),
    relationships: z
      .object({
        caption: canonicalId,
        assets: z.array(canonicalId).min(1).optional(),
      })
      .strict(),
  })
  .strict()

const footnoteNode = canonicalNodeBase
  .extend({
    type: z.literal('footnote'),
    kind: z.enum(['footnote', 'endnote']),
    label: z.string().min(1),
    markerText: z.string().min(1).optional(),
    text: z.string().min(1),
    relationships: z
      .object({
        backlinks: z.array(canonicalId),
      })
      .strict(),
  })
  .strict()

const researchPaperBaseSchema = z
  .object({
    id: canonicalId,
    version: z.string().min(1),
    status: z.enum(['working', 'review', 'published']),
    title: z.string().min(1),
    subtitle: z.string().min(1),
    authors: z.array(z.string().min(1)).min(1),
    authorNotes: z
      .array(
        z
          .object({
            id: canonicalId,
            author: z.string().min(1),
            label: z.string().min(1),
            target: canonicalId,
          })
          .strict(),
      )
      .optional(),
    affiliations: z.array(z.string().min(1)).optional(),
    updated: z.string().date(),
    abstract: z.string().min(1),
    nodes: z
      .array(
        z.discriminatedUnion('type', [
          headingNode,
          paragraphNode,
          quoteNode,
          captionNode,
          figureNode,
          footnoteNode,
        ]),
      )
      .min(1),
  })
  .strict()

export const researchPaperSchema = researchPaperBaseSchema.superRefine(
  (paper, context) => {
    const seen = new Set<string>()
    for (const [index, node] of paper.nodes.entries()) {
      if (seen.has(node.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'id'],
          message: `Duplicate canonical node id: ${node.id}`,
        })
      }
      seen.add(node.id)
    }

    const nodeIds = new Set(paper.nodes.map((node) => node.id))
    const noteReferenceIds = new Set<string>()
    const noteReferenceTargets = new Map<string, string>()
    for (const [index, reference] of (paper.authorNotes ?? []).entries()) {
      if (noteReferenceIds.has(reference.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['authorNotes', index, 'id'],
          message: `Duplicate note reference id: ${reference.id}`,
        })
      }
      noteReferenceIds.add(reference.id)
      noteReferenceTargets.set(reference.id, reference.target)
      if (!paper.authors.includes(reference.author)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['authorNotes', index, 'author'],
          message: `Author note names an unknown author: ${reference.author}`,
        })
      }
      const target = paper.nodes.find(
        (candidate) => candidate.id === reference.target,
      )
      if (!target || target.type !== 'footnote') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['authorNotes', index, 'target'],
          message: `Dangling author-note relationship: ${reference.target}`,
        })
      }
    }
    for (const [index, node] of paper.nodes.entries()) {
      if (node.type === 'figure' && !nodeIds.has(node.relationships.caption)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'relationships', 'caption'],
          message: `Dangling caption relationship: ${node.relationships.caption}`,
        })
      }
      if ('noteReferences' in node && node.noteReferences) {
        for (const [
          referenceIndex,
          reference,
        ] of node.noteReferences.entries()) {
          if (noteReferenceIds.has(reference.id)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['nodes', index, 'noteReferences', referenceIndex, 'id'],
              message: `Duplicate note reference id: ${reference.id}`,
            })
          }
          noteReferenceIds.add(reference.id)
          noteReferenceTargets.set(reference.id, reference.target)
          const target = paper.nodes.find(
            (candidate) => candidate.id === reference.target,
          )
          if (!target || target.type !== 'footnote') {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [
                'nodes',
                index,
                'noteReferences',
                referenceIndex,
                'target',
              ],
              message: `Dangling note relationship: ${reference.target}`,
            })
          }
          if (
            reference.end > node.text.length ||
            reference.start >= reference.end
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['nodes', index, 'noteReferences', referenceIndex],
              message: `Invalid note reference text range: ${reference.start}-${reference.end}`,
            })
          }
        }
      }
      if ('inlineRuns' in node && node.inlineRuns) {
        const inlineText =
          node.type === 'figure'
            ? (node.sourceText ?? '')
            : 'text' in node
              ? node.text
              : ''
        for (const [runIndex, run] of node.inlineRuns.entries()) {
          if (run.end > inlineText.length || run.start >= run.end) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['nodes', index, 'inlineRuns', runIndex],
              message: `Invalid inline run text range: ${run.start}-${run.end}`,
            })
          }
        }
      }
      if (node.type === 'figure' && node.objectType !== 'table' && node.table) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'table'],
          message: 'Structured table data must accompany only table figures',
        })
      }
      if (
        node.type === 'figure' &&
        node.inlineRuns?.length &&
        !node.sourceText
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'sourceText'],
          message: 'Figure inline runs require an exact source-text transcript',
        })
      }
      if (node.type === 'figure' && node.table) {
        const occupied = node.table.rows.map(() => [] as boolean[])
        let invalidSpanTopology = false
        for (const [rowIndex, row] of node.table.rows.entries()) {
          let columnIndex = 0
          for (const cell of row.cells) {
            while (occupied[rowIndex][columnIndex]) columnIndex += 1
            for (
              let targetRow = rowIndex;
              targetRow < rowIndex + cell.rowSpan;
              targetRow += 1
            ) {
              if (targetRow >= occupied.length) {
                invalidSpanTopology = true
                continue
              }
              for (
                let targetColumn = columnIndex;
                targetColumn < columnIndex + cell.columnSpan;
                targetColumn += 1
              ) {
                if (occupied[targetRow][targetColumn]) {
                  invalidSpanTopology = true
                }
                occupied[targetRow][targetColumn] = true
              }
            }
            columnIndex += cell.columnSpan
          }
        }
        const columnCount = Math.max(0, ...occupied.map((row) => row.length))
        if (
          occupied.some(
            (row) =>
              row.length !== columnCount ||
              Array.from(
                { length: columnCount },
                (_, column) => row[column],
              ).some((filled) => !filled),
          )
        ) {
          invalidSpanTopology = true
        }
        if (invalidSpanTopology) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'table', 'rows'],
            message:
              'Structured table cells must form a complete rectangular span grid',
          })
        }

        const headerRowCount = node.table.rows.findIndex(
          (row) => !row.cells.every((cell) => cell.headerScope === 'column'),
        )
        const boundary =
          headerRowCount === -1 ? node.table.rows.length : headerRowCount
        for (let rowIndex = 0; rowIndex < boundary; rowIndex += 1) {
          for (const [cellIndex, cell] of node.table.rows[
            rowIndex
          ].cells.entries()) {
            if (rowIndex + cell.rowSpan > boundary) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: [
                  'nodes',
                  index,
                  'table',
                  'rows',
                  rowIndex,
                  'cells',
                  cellIndex,
                  'rowSpan',
                ],
                message:
                  'Table cell rowspan must not cross the header/body row-group boundary',
              })
            }
          }
        }
      }
    }
    for (const [index, node] of paper.nodes.entries()) {
      if (node.type !== 'footnote') continue
      for (const [
        backlinkIndex,
        backlink,
      ] of node.relationships.backlinks.entries()) {
        if (!noteReferenceIds.has(backlink)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'relationships', 'backlinks', backlinkIndex],
            message: `Dangling footnote backlink: ${backlink}`,
          })
        } else if (noteReferenceTargets.get(backlink) !== node.id) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nodes', index, 'relationships', 'backlinks', backlinkIndex],
            message: `Footnote backlink ${backlink} targets a different note`,
          })
        }
      }
    }
    for (const [referenceId, targetId] of noteReferenceTargets) {
      const target = paper.nodes.find(
        (candidate) =>
          candidate.id === targetId && candidate.type === 'footnote',
      )
      if (
        target?.type === 'footnote' &&
        !target.relationships.backlinks.includes(referenceId)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Note relationship ${referenceId} is missing its backlink`,
        })
      }
    }
  },
)

export type ResearchPaper = z.infer<typeof researchPaperSchema>
export type ResearchNode = ResearchPaper['nodes'][number]

import { z } from 'zod'
import type { PdfSourceSemanticFlowBoundaryDecision } from './import-types'
import {
  getTargetProfile,
  TARGET_PROFILE_IDS,
  type TargetProfileId,
} from './targets'

/**
 * A checkpoint is the smallest reviewable claim made by source/output
 * evidence.  Keeping the claim in data (rather than inferring it from the
 * images) means a generated pair cannot pass merely because two files exist.
 */
export const SOURCE_OUTPUT_CHECKPOINT_SCHEMA_VERSION = '1.0.0' as const

export const SOURCE_OUTPUT_CHECKPOINT_PROPERTIES = [
  'figure-present',
  'caption-boundary',
  'prose-continuity',
  'hyphen-resolution',
  'markup-non-promotion',
  'heading-level',
  'table-structure',
  'code-block-structure',
  'furniture-exclusion',
  'marker-to-body',
  'citation-to-entry',
  'in-float-marker',
  'dangling-link-verifier',
] as const

export type SourceOutputCheckpointProperty =
  (typeof SOURCE_OUTPUT_CHECKPOINT_PROPERTIES)[number]

export const SOURCE_OUTPUT_FEATURES = ['visual', 'text', 'structure'] as const

export type SourceOutputFeature = (typeof SOURCE_OUTPUT_FEATURES)[number]

export const SOURCE_OUTPUT_RENDITION_FEATURES = [
  'figure',
  'caption',
  'prose',
  'heading',
  'table',
  'code',
  'relationship',
  'internal-links',
] as const

export type SourceOutputRenditionFeature =
  (typeof SOURCE_OUTPUT_RENDITION_FEATURES)[number]

const sourceExpectationSchema = z
  .object({
    feature: z.enum(SOURCE_OUTPUT_FEATURES),
    text: z.string().min(1).optional(),
    furnitureContaminationCount: z.number().int().min(0).optional(),
  })
  .strict()

const semanticFlowExpectationSchema = z
  .object({
    topology: z.enum(['same-page-column', 'cross-page-column']),
    fromPage: z.number().int().positive(),
    outcome: z.enum(['space', 'no-space']),
  })
  .strict()

const relationshipExpectationSchema = z
  .object({
    kind: z.enum(['note', 'citation']),
    markerText: z.string().min(1),
    targetText: z.string().min(1),
    container: z.enum(['caption', 'table-cell']).optional(),
  })
  .strict()

const renditionExpectationSchema = z
  .object({
    feature: z.enum(SOURCE_OUTPUT_RENDITION_FEATURES),
    text: z.string().min(1).optional(),
    level: z.number().int().min(1).max(6).optional(),
    semanticFlow: semanticFlowExpectationSchema.optional(),
    relationship: relationshipExpectationSchema.optional(),
  })
  .strict()

export const sourceOutputCheckpointSchema = z
  .object({
    id: z.string().min(1),
    document: z.string().min(1),
    page: z.number().int().positive(),
    profile: z.enum(TARGET_PROFILE_IDS),
    property: z.enum(SOURCE_OUTPUT_CHECKPOINT_PROPERTIES),
    criterion: z.string().min(1),
    source: sourceExpectationSchema,
    output: renditionExpectationSchema,
  })
  .strict()

export type SourceOutputCheckpoint = z.infer<
  typeof sourceOutputCheckpointSchema
>

export const sourceOutputCheckpointSetSchema = z
  .object({
    schemaVersion: z.literal(SOURCE_OUTPUT_CHECKPOINT_SCHEMA_VERSION),
    checkpoints: z.array(sourceOutputCheckpointSchema).min(1),
  })
  .strict()

export type SourceOutputCheckpointSet = z.infer<
  typeof sourceOutputCheckpointSetSchema
>

export type CheckpointValidationIssue = {
  checkpointId: string
  code:
    | 'invalid-checkpoint'
    | 'duplicate-id'
    | 'property-feature-mismatch'
    | 'property-source-feature-mismatch'
    | 'missing-semantic-flow-expectation'
    | 'missing-relationship-expectation'
    | 'relationship-kind-mismatch'
    | 'missing-relationship-container'
  message: string
}

export class SourceOutputCheckpointValidationError extends Error {
  constructor(public readonly issues: CheckpointValidationIssue[]) {
    super(issues.map((issue) => `${issue.code}: ${issue.message}`).join('\n'))
    this.name = 'SourceOutputCheckpointValidationError'
  }
}

function expectedRenditionFeature(
  property: SourceOutputCheckpointProperty,
): SourceOutputRenditionFeature {
  switch (property) {
    case 'figure-present':
      return 'figure'
    case 'caption-boundary':
      return 'caption'
    case 'prose-continuity':
    case 'hyphen-resolution':
    case 'markup-non-promotion':
      return 'prose'
    case 'heading-level':
      return 'heading'
    case 'table-structure':
      return 'table'
    case 'code-block-structure':
      return 'code'
    case 'furniture-exclusion':
      return 'prose'
    case 'marker-to-body':
    case 'citation-to-entry':
    case 'in-float-marker':
      return 'relationship'
    case 'dangling-link-verifier':
      return 'internal-links'
  }
}

function expectedSourceFeature(
  property: SourceOutputCheckpointProperty,
): SourceOutputFeature {
  switch (property) {
    case 'figure-present':
    case 'caption-boundary':
      return 'visual'
    case 'prose-continuity':
    case 'hyphen-resolution':
    case 'markup-non-promotion':
      return 'text'
    case 'heading-level':
    case 'table-structure':
    case 'code-block-structure':
      return 'structure'
    case 'furniture-exclusion':
      return 'structure'
    case 'marker-to-body':
    case 'citation-to-entry':
    case 'in-float-marker':
    case 'dangling-link-verifier':
      return 'structure'
  }
}

/** Validate the cross-field rules that a plain JSON schema cannot express. */
export function validateSourceOutputCheckpointSet(
  input: unknown,
): CheckpointValidationIssue[] {
  let parsed: SourceOutputCheckpointSet
  try {
    parsed = sourceOutputCheckpointSetSchema.parse(input)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return [
        {
          checkpointId: 'checkpoint-set',
          code: 'invalid-checkpoint',
          message: error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
        },
      ]
    }
    return [
      {
        checkpointId: 'checkpoint-set',
        code: 'invalid-checkpoint',
        message: 'Checkpoint set could not be validated.',
      },
    ]
  }

  const issues: CheckpointValidationIssue[] = []
  const ids = new Set<string>()
  for (const checkpoint of parsed.checkpoints) {
    if (ids.has(checkpoint.id)) {
      issues.push({
        checkpointId: checkpoint.id,
        code: 'duplicate-id',
        message: `Checkpoint id ${checkpoint.id} is not unique.`,
      })
    }
    ids.add(checkpoint.id)

    const expected = expectedRenditionFeature(checkpoint.property)
    if (checkpoint.output.feature !== expected) {
      issues.push({
        checkpointId: checkpoint.id,
        code: 'property-feature-mismatch',
        message: `${checkpoint.property} must inspect rendition feature ${expected}.`,
      })
    }

    const expectedSource = expectedSourceFeature(checkpoint.property)
    if (checkpoint.source.feature !== expectedSource) {
      issues.push({
        checkpointId: checkpoint.id,
        code: 'property-source-feature-mismatch',
        message: `${checkpoint.property} must inspect source feature ${expectedSource}.`,
      })
    }

    if (
      checkpoint.property === 'prose-continuity' &&
      checkpoint.output.semanticFlow === undefined
    ) {
      issues.push({
        checkpointId: checkpoint.id,
        code: 'missing-semantic-flow-expectation',
        message:
          'prose-continuity must name the source-proven semantic-flow boundary it expects.',
      })
    }

    if (
      ['marker-to-body', 'citation-to-entry', 'in-float-marker'].includes(
        checkpoint.property,
      ) &&
      checkpoint.output.relationship === undefined
    ) {
      issues.push({
        checkpointId: checkpoint.id,
        code: 'missing-relationship-expectation',
        message: `${checkpoint.property} must name its marker, relationship kind, and target text.`,
      })
    }
    if (
      checkpoint.property === 'marker-to-body' &&
      checkpoint.output.relationship !== undefined &&
      checkpoint.output.relationship.kind !== 'note'
    ) {
      issues.push({
        checkpointId: checkpoint.id,
        code: 'relationship-kind-mismatch',
        message: 'marker-to-body must inspect a note relationship.',
      })
    }
    if (
      checkpoint.property === 'citation-to-entry' &&
      checkpoint.output.relationship !== undefined &&
      checkpoint.output.relationship.kind !== 'citation'
    ) {
      issues.push({
        checkpointId: checkpoint.id,
        code: 'relationship-kind-mismatch',
        message: 'citation-to-entry must inspect a citation relationship.',
      })
    }
    if (
      checkpoint.property === 'in-float-marker' &&
      checkpoint.output.relationship !== undefined &&
      checkpoint.output.relationship.container === undefined
    ) {
      issues.push({
        checkpointId: checkpoint.id,
        code: 'missing-relationship-container',
        message:
          'in-float-marker must name either a caption or table-cell container.',
      })
    }
  }
  return issues
}

export function parseSourceOutputCheckpointSet(
  input: unknown,
): SourceOutputCheckpointSet {
  const issues = validateSourceOutputCheckpointSet(input)
  if (issues.length > 0) {
    throw new SourceOutputCheckpointValidationError(issues)
  }
  return sourceOutputCheckpointSetSchema.parse(input)
}

export function assertSourceOutputCheckpoint(
  input: unknown,
): SourceOutputCheckpoint {
  const set = parseSourceOutputCheckpointSet({
    schemaVersion: SOURCE_OUTPUT_CHECKPOINT_SCHEMA_VERSION,
    checkpoints: [input],
  })
  return set.checkpoints[0]
}

export function sortSourceOutputCheckpoints(
  checkpoints: readonly SourceOutputCheckpoint[],
) {
  return [...checkpoints].sort(
    (left, right) =>
      left.document.localeCompare(right.document) ||
      left.page - right.page ||
      left.profile.localeCompare(right.profile) ||
      left.id.localeCompare(right.id),
  )
}

export type SourceCheckpointObservation = {
  page: number
  text: string
  hasVisual: boolean
  furnitureContaminationCount?: number
}

export type RenditionCheckpointObservation = {
  profile: TargetProfileId
  width: number
  html: string
  semanticFlowBoundaryLedgerValid?: boolean
  semanticFlowBoundaryDecisions?: readonly Pick<
    PdfSourceSemanticFlowBoundaryDecision,
    'page' | 'topology' | 'outcome'
  >[]
}

export type SourceOutputCheckpointObservation = {
  source: SourceCheckpointObservation
  rendition: RenditionCheckpointObservation
}

export type SourceOutputCheckpointResult = {
  checkpointId: string
  status: 'passed' | 'failed'
  reason?: string
}

function normalizedText(value: string) {
  return value
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => {
      const values: Record<string, string> = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
      }
      return values[entity] ?? entity
    })
    .replace(/\s+/g, ' ')
    .trim()
}

function tagContents(html: string, tag: string) {
  const contents: string[] = []
  const matcher = new RegExp(
    '<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>',
    'gi',
  )
  for (const match of html.matchAll(matcher)) {
    contents.push(match[1] ?? '')
  }
  return contents
}

function decodedHtmlAttribute(value: string) {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos);/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal !== undefined) {
        const codePoint = Number(decimal)
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity
      }
      if (hexadecimal !== undefined) {
        const codePoint = Number.parseInt(hexadecimal, 16)
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity
      }
      const values: Record<string, string> = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
      }
      return values[entity.toLowerCase()] ?? entity
    },
  )
}

function htmlAttribute(attributes: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = attributes.match(
    new RegExp(
      `(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
      'i',
    ),
  )
  const value = match?.[1] ?? match?.[2]
  return value === undefined ? undefined : decodedHtmlAttribute(value)
}

type HtmlOpeningElement = {
  tag: string
  attributes: string
  start: number
  end: number
  id?: string
  href?: string
}

type HtmlAnchor = HtmlOpeningElement & {
  tag: 'a'
  innerHtml: string
  fullHtml: string
}

function htmlWithoutExecutableText(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
}

function htmlOpeningElements(html: string) {
  const structuralHtml = htmlWithoutExecutableText(html)
  const matcher = /<([a-z][\w:-]*)\b([^>]*)>/gi
  const elements: HtmlOpeningElement[] = []
  for (const match of structuralHtml.matchAll(matcher)) {
    const attributes = match[2] ?? ''
    elements.push({
      tag: (match[1] ?? '').toLowerCase(),
      attributes,
      start: match.index,
      end: match.index + match[0].length,
      ...(htmlAttribute(attributes, 'id') !== undefined
        ? { id: htmlAttribute(attributes, 'id') }
        : {}),
      ...(htmlAttribute(attributes, 'href') !== undefined
        ? { href: htmlAttribute(attributes, 'href') }
        : {}),
    })
  }
  return { html: structuralHtml, elements }
}

function htmlAnchors(html: string): HtmlAnchor[] {
  const structuralHtml = htmlWithoutExecutableText(html)
  const matcher = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  return [...structuralHtml.matchAll(matcher)].map((match) => {
    const attributes = match[1] ?? ''
    return {
      tag: 'a',
      attributes,
      start: match.index,
      end: match.index + match[0].length,
      innerHtml: match[2] ?? '',
      fullHtml: match[0],
      ...(htmlAttribute(attributes, 'id') !== undefined
        ? { id: htmlAttribute(attributes, 'id') }
        : {}),
      ...(htmlAttribute(attributes, 'href') !== undefined
        ? { href: htmlAttribute(attributes, 'href') }
        : {}),
    }
  })
}

function internalTargetId(href: string | undefined) {
  if (!href?.startsWith('#')) return null
  try {
    return decodeURIComponent(href.slice(1))
  } catch {
    return ''
  }
}

function elementInnerHtml(html: string, element: HtmlOpeningElement) {
  if (/\/\s*>$/u.test(html.slice(element.start, element.end))) return ''
  const closing = new RegExp(`<\\/${element.tag}\\s*>`, 'gi')
  closing.lastIndex = element.end
  const match = closing.exec(html)
  return match ? html.slice(element.end, match.index) : ''
}

function internalLinkIntegrityFailure(html: string) {
  const { html: structuralHtml, elements } = htmlOpeningElements(html)
  const ids = new Map<string, HtmlOpeningElement[]>()
  for (const element of elements) {
    if (element.id === undefined) continue
    const owners = ids.get(element.id) ?? []
    owners.push(element)
    ids.set(element.id, owners)
  }
  const links = elements.flatMap((element) => {
    const targetId = internalTargetId(element.href)
    return targetId === null ? [] : [{ element, targetId }]
  })
  if (links.length === 0) {
    return {
      reason: 'The rendition contains no internal href to verify.',
      structuralHtml,
      elements,
      ids,
      links,
    }
  }
  for (const link of links) {
    if (!link.targetId) {
      return {
        reason: 'The rendition contains an empty or invalid internal href.',
        structuralHtml,
        elements,
        ids,
        links,
      }
    }
    const targets = ids.get(link.targetId) ?? []
    if (targets.length !== 1) {
      return {
        reason:
          targets.length === 0
            ? `Internal href #${link.targetId} has no target.`
            : `Internal href #${link.targetId} has ${targets.length} targets; exactly one is required.`,
        structuralHtml,
        elements,
        ids,
        links,
      }
    }
  }
  return { reason: null, structuralHtml, elements, ids, links }
}

function hasToken(value: string | undefined, token: string) {
  return value?.split(/\s+/u).includes(token) ?? false
}

function relationshipIntegrityFailure(
  checkpoint: SourceOutputCheckpoint,
  html: string,
) {
  const expected = checkpoint.output.relationship
  if (!expected) return 'The checkpoint has no relationship expectation.'
  const graph = internalLinkIntegrityFailure(html)
  if (graph.reason) return graph.reason
  const anchors = htmlAnchors(graph.structuralHtml)
  const candidates = anchors.filter((anchor) => {
    const type = htmlAttribute(anchor.attributes, 'epub:type')
    const role = htmlAttribute(anchor.attributes, 'role')
    const semanticType = expected.kind === 'note' ? 'noteref' : 'biblioref'
    const semanticRole =
      expected.kind === 'note' ? 'doc-noteref' : 'doc-biblioref'
    return (
      hasToken(type, semanticType) &&
      hasToken(role, semanticRole) &&
      normalizedText(anchor.innerHtml) === normalizedText(expected.markerText)
    )
  })
  if (candidates.length !== 1) {
    return `Expected exactly one ${expected.kind} link for marker ${expected.markerText}; found ${candidates.length}.`
  }
  const anchor = candidates[0]
  const targetId = internalTargetId(anchor.href)
  if (!targetId) return `Marker ${expected.markerText} has no internal target.`
  const target = graph.ids.get(targetId)?.[0]
  if (!target) return `Marker ${expected.markerText} has no unique target.`
  const targetHtml = elementInnerHtml(graph.structuralHtml, target)
  if (
    !normalizedText(targetHtml).includes(normalizedText(expected.targetText))
  ) {
    return `Marker ${expected.markerText} does not target the expected body text.`
  }
  if (expected.kind === 'note') {
    const targetType = htmlAttribute(target.attributes, 'epub:type')
    const targetRole = htmlAttribute(target.attributes, 'role')
    if (
      target.tag !== 'aside' ||
      !hasToken(targetType, 'footnote') ||
      !['doc-footnote', 'doc-endnote'].some((role) =>
        hasToken(targetRole, role),
      )
    ) {
      return `Marker ${expected.markerText} does not target a semantic note body.`
    }
    if (!anchor.id || graph.ids.get(anchor.id)?.length !== 1) {
      return `Note marker ${expected.markerText} has no unique backlink target id.`
    }
    const backlink = htmlAnchors(targetHtml).find(
      (candidate) =>
        internalTargetId(candidate.href) === anchor.id &&
        hasToken(htmlAttribute(candidate.attributes, 'class'), 'note-backlink'),
    )
    if (!backlink) {
      return `Note body for marker ${expected.markerText} has no verified backlink.`
    }
  } else {
    const targetOpening = graph.structuralHtml.slice(target.start, target.end)
    const bibliographyOwners = graph.elements.filter(
      (element) =>
        ['ol', 'ul'].includes(element.tag) &&
        htmlAttribute(element.attributes, 'data-numbering-id') ===
          'references' &&
        elementInnerHtml(graph.structuralHtml, element).includes(targetOpening),
    )
    if (bibliographyOwners.length !== 1) {
      return `Citation marker ${expected.markerText} does not target one bibliography entry.`
    }
  }
  if (expected.container) {
    const containerTags =
      expected.container === 'caption' ? ['figcaption'] : ['td', 'th']
    const insideExpectedContainer = containerTags.some((tag) =>
      tagContents(graph.structuralHtml, tag).some((content) =>
        content.includes(anchor.fullHtml),
      ),
    )
    if (!insideExpectedContainer) {
      return `Marker ${expected.markerText} is not inside the expected ${expected.container} container.`
    }
  }
  return null
}

function hasHeading(html: string, level?: number) {
  if (level === undefined) return /<h[1-6](?:\s|>)/i.test(html)
  return new RegExp(`<h${level}(?:\\s|>)`, 'i').test(html)
}

function headingContents(html: string, level?: number) {
  const matcher =
    level === undefined
      ? /<h[1-6](?:\s[^>]*)?>([\s\S]*?)<\/h[1-6]>/gi
      : new RegExp(`<h${level}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/h${level}>`, 'gi')
  return [...html.matchAll(matcher)].map((match) => match[1] ?? '')
}

function hasStructuredTable(html: string) {
  return (
    /<table(?:\s|>)/i.test(html) &&
    /<tr(?:\s|>)/i.test(html) &&
    /<(?:th|td)(?:\s|>)/i.test(html)
  )
}

function hasStructuredCode(html: string) {
  return /<pre(?:\s|>)[\s\S]*?<code(?:\s|>)/i.test(html)
}

function hasFigure(checkpoint: SourceOutputCheckpoint, html: string) {
  const figures = tagContents(html, 'figure').filter((figure) =>
    /<(?:img|svg|canvas)(?:\s|>)/i.test(figure),
  )
  if (figures.length === 0) return false
  if (!checkpoint.output.text) return true
  const expected = normalizedText(checkpoint.output.text)
  return figures.some((figure) => normalizedText(figure).includes(expected))
}

function hasHeadingContent(checkpoint: SourceOutputCheckpoint, html: string) {
  if (!hasHeading(html, checkpoint.output.level)) return false
  if (!checkpoint.output.text) return true
  const expected = normalizedText(checkpoint.output.text)
  return headingContents(html, checkpoint.output.level).some((heading) =>
    normalizedText(heading).includes(expected),
  )
}

function hasTableContent(checkpoint: SourceOutputCheckpoint, html: string) {
  if (!hasStructuredTable(html)) return false
  if (!checkpoint.output.text) return true
  const expected = normalizedText(checkpoint.output.text)
  return tagContents(html, 'table').some((table) =>
    normalizedText(table).includes(expected),
  )
}

function hasCodeContent(checkpoint: SourceOutputCheckpoint, html: string) {
  if (!hasStructuredCode(html)) return false
  if (!checkpoint.output.text) return true
  const expected = normalizedText(checkpoint.output.text)
  return tagContents(html, 'code').some((code) =>
    normalizedText(code).includes(expected),
  )
}

function hasCaption(checkpoint: SourceOutputCheckpoint, html: string) {
  const figure = tagContents(html, 'figure').find(
    (content) =>
      /<(?:img|svg|canvas)(?:\s|>)/i.test(content) &&
      /<figcaption(?:\s|>)[\s\S]*?<\/figcaption>/i.test(content),
  )
  if (!figure) return false
  if (!checkpoint.output.text) return true
  const caption = tagContents(figure, 'figcaption')[0]
  return (
    caption !== undefined &&
    normalizedText(caption) === normalizedText(checkpoint.output.text)
  )
}

function hasProse(checkpoint: SourceOutputCheckpoint, html: string) {
  const paragraphs = tagContents(html, 'p')
  if (!checkpoint.output.text) return paragraphs.length > 0
  const expected = normalizedText(checkpoint.output.text)
  return paragraphs.some((paragraph) =>
    normalizedText(paragraph).includes(expected),
  )
}

const MARKUP_PROMOTION_TAGS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'b',
  'em',
  'i',
  'li',
] as const

/**
 * Text that merely looks like markup must reach the reader as the characters
 * the source printed. Finding the named text inside a heading, an emphasis run,
 * or a list item proves the opposite: the rendition promoted it to structure
 * the source never carried.
 */
function promotedMarkupStructure(
  checkpoint: SourceOutputCheckpoint,
  html: string,
) {
  const expected = normalizedText(checkpoint.output.text ?? '')
  if (!expected) return null
  return (
    MARKUP_PROMOTION_TAGS.find((tag) =>
      tagContents(html, tag).some((content) =>
        normalizedText(content).includes(expected),
      ),
    ) ?? null
  )
}

/**
 * A discretionary line-end hyphen is resolved only when the split form no
 * longer reaches the reader. The printed fragment is the source expectation, so
 * its survival anywhere in the rendition is the failure the checkpoint names.
 */
function unresolvedHyphenFragment(
  checkpoint: SourceOutputCheckpoint,
  html: string,
) {
  const fragment = normalizedText(checkpoint.source.text ?? '')
  return Boolean(fragment && normalizedText(html).includes(fragment))
}

function outputFeaturePresent(
  checkpoint: SourceOutputCheckpoint,
  html: string,
) {
  switch (checkpoint.output.feature) {
    case 'figure':
      return hasFigure(checkpoint, html)
    case 'caption':
      return hasCaption(checkpoint, html)
    case 'prose':
      return hasProse(checkpoint, html)
    case 'heading':
      return hasHeadingContent(checkpoint, html)
    case 'table':
      return hasTableContent(checkpoint, html)
    case 'code':
      return hasCodeContent(checkpoint, html)
    case 'relationship':
      return htmlAnchors(html).some(
        (anchor) => internalTargetId(anchor.href) !== null,
      )
    case 'internal-links':
      return internalLinkIntegrityFailure(html).links.length > 0
  }
}

/**
 * Evaluate a named claim against observations made by the paired renderer.
 * Missing observations, profile mismatches, and absent structure all fail
 * closed.
 */
export function evaluateSourceOutputCheckpoint(
  checkpoint: SourceOutputCheckpoint,
  observation: SourceOutputCheckpointObservation,
): SourceOutputCheckpointResult {
  if (observation.source.page !== checkpoint.page) {
    return {
      checkpointId: checkpoint.id,
      status: 'failed',
      reason: `Source observation is page ${observation.source.page}, expected page ${checkpoint.page}.`,
    }
  }
  if (observation.rendition.profile !== checkpoint.profile) {
    return {
      checkpointId: checkpoint.id,
      status: 'failed',
      reason: `Rendition uses ${observation.rendition.profile}, expected ${checkpoint.profile}.`,
    }
  }
  const expectedWidth = getTargetProfile(checkpoint.profile).preview.widthCssPx
  if (observation.rendition.width !== expectedWidth) {
    return {
      checkpointId: checkpoint.id,
      status: 'failed',
      reason: `Rendition width is ${observation.rendition.width}, expected ${expectedWidth} for ${checkpoint.profile}.`,
    }
  }
  if (!observation.source.text.trim()) {
    return {
      checkpointId: checkpoint.id,
      status: 'failed',
      reason: 'The source page has no readable evidence.',
    }
  }
  if (checkpoint.property === 'furniture-exclusion') {
    const expected = checkpoint.source.furnitureContaminationCount ?? 0
    if (observation.source.furnitureContaminationCount !== expected) {
      return {
        checkpointId: checkpoint.id,
        status: 'failed',
        reason:
          observation.source.furnitureContaminationCount === undefined
            ? 'The reconstruction did not provide a furniture contamination counter.'
            : `Furniture contamination count is ${observation.source.furnitureContaminationCount}, expected ${expected}.`,
      }
    }
  }
  if (checkpoint.source.feature === 'visual' && !observation.source.hasVisual) {
    return {
      checkpointId: checkpoint.id,
      status: 'failed',
      reason: 'The named source page has no rendered visual object.',
    }
  }
  if (!observation.rendition.html.trim()) {
    return {
      checkpointId: checkpoint.id,
      status: 'failed',
      reason: 'The generated rendition is empty.',
    }
  }
  if (!outputFeaturePresent(checkpoint, observation.rendition.html)) {
    return {
      checkpointId: checkpoint.id,
      status: 'failed',
      reason: `Rendition does not satisfy the ${checkpoint.property} criterion.`,
    }
  }
  if (
    checkpoint.source.text &&
    !normalizedText(observation.source.text).includes(
      normalizedText(checkpoint.source.text),
    )
  ) {
    return {
      checkpointId: checkpoint.id,
      status: 'failed',
      reason: 'The source page does not contain the named source text.',
    }
  }
  if (
    ['marker-to-body', 'citation-to-entry', 'in-float-marker'].includes(
      checkpoint.property,
    )
  ) {
    const failure = relationshipIntegrityFailure(
      checkpoint,
      observation.rendition.html,
    )
    if (failure) {
      return {
        checkpointId: checkpoint.id,
        status: 'failed',
        reason: failure,
      }
    }
  }
  if (checkpoint.property === 'dangling-link-verifier') {
    const failure = internalLinkIntegrityFailure(
      observation.rendition.html,
    ).reason
    if (failure) {
      return {
        checkpointId: checkpoint.id,
        status: 'failed',
        reason: failure,
      }
    }
  }
  if (checkpoint.output.semanticFlow) {
    if (observation.rendition.semanticFlowBoundaryLedgerValid !== true) {
      return {
        checkpointId: checkpoint.id,
        status: 'failed',
        reason:
          'The reconstruction did not provide a valid semantic-flow boundary ledger.',
      }
    }
    const expected = checkpoint.output.semanticFlow
    const matchingDecision =
      observation.rendition.semanticFlowBoundaryDecisions?.some(
        (decision) =>
          decision.page === expected.fromPage &&
          decision.topology === expected.topology &&
          decision.outcome === expected.outcome,
      ) ?? false
    if (!matchingDecision) {
      return {
        checkpointId: checkpoint.id,
        status: 'failed',
        reason: `The semantic-flow boundary ledger does not contain ${expected.topology} ${expected.outcome} proof from page ${expected.fromPage}.`,
      }
    }
  }
  if (checkpoint.property === 'markup-non-promotion') {
    const promoted = promotedMarkupStructure(
      checkpoint,
      observation.rendition.html,
    )
    if (promoted) {
      return {
        checkpointId: checkpoint.id,
        status: 'failed',
        reason: `Markup-shaped source text was promoted to <${promoted}> without source evidence.`,
      }
    }
  }
  if (
    checkpoint.property === 'hyphen-resolution' &&
    unresolvedHyphenFragment(checkpoint, observation.rendition.html)
  ) {
    return {
      checkpointId: checkpoint.id,
      status: 'failed',
      reason:
        'The rendition still carries the printed line-end hyphen fragment.',
    }
  }
  return { checkpointId: checkpoint.id, status: 'passed' }
}

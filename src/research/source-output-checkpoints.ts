import { z } from 'zod'
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
  'heading-level',
  'table-structure',
  'code-block-structure',
  'furniture-exclusion',
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

const renditionExpectationSchema = z
  .object({
    feature: z.enum(SOURCE_OUTPUT_RENDITION_FEATURES),
    text: z.string().min(1).optional(),
    level: z.number().int().min(1).max(6).optional(),
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
      return 'prose'
    case 'heading-level':
      return 'heading'
    case 'table-structure':
      return 'table'
    case 'code-block-structure':
      return 'code'
    case 'furniture-exclusion':
      return 'prose'
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
      return 'text'
    case 'heading-level':
    case 'table-structure':
    case 'code-block-structure':
      return 'structure'
    case 'furniture-exclusion':
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
  return { checkpointId: checkpoint.id, status: 'passed' }
}

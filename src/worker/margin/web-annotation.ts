import { z } from 'zod'
import {
  textAnnotationSchema,
  type TextAnnotation,
} from '../../annotations/annotations'
import { isFullCommitId, parseHunks } from '../../annotations/criticmarkup'

/**
 * The wire format is a W3C Web Annotation. The internal model is the existing
 * `SemanticTextAnchor` / `TextAnnotation` from `src/annotations/annotations.ts`,
 * reused unchanged. This module is the documented bidirectional mapping
 * between the two, and it is the only place that knows both shapes.
 *
 * What maps onto what:
 *
 * | Web Annotation                         | internal / stored                  |
 * |----------------------------------------|------------------------------------|
 * | `motivation: highlighting`             | `kind: 'highlight'`                |
 * | `motivation: commenting`               | `kind: 'note'`                     |
 * | `motivation: editing`                  | `kind: 'proposal'`                 |
 * | `target.source`                        | `(site, document)` tenancy key     |
 * | `TextQuoteSelector`                    | `anchor.quote`                     |
 * | `TextPositionSelector`                 | `anchor.position`                  |
 * | `margin:StructSelector`                | `anchor.nodeId` + `struct_id`      |
 * | `body` / `TextualBody.value`           | `note.body` / `proposal.body`      |
 * | `margin:color`                         | highlight or note role colour      |
 * | `margin:visibility`                    | `visibility`                       |
 * | `margin:parentId`                      | `parent_id` (a reply)              |
 * | — (never serialized)                   | `geometryCache`                    |
 *
 * Everything margin adds beyond the standard is a namespaced extension
 * property under `margin:`, as the issue's clarification protocol requires.
 *
 * Round-trip guarantees, asserted in `web-annotation.test.ts`:
 *
 * - Canonical wire -> record -> wire is identity for every motivation.
 * - A plain Web Annotation from an unrelated tool keeps its motivation, its
 *   selectors and its body. It is normalised in three documented ways: a
 *   single-element `target` array becomes the object form, a plain-string
 *   `body` becomes a `TextualBody`, and empty `prefix`/`suffix` are omitted.
 * - An annotation with no `margin:StructSelector` anchors to the document as
 *   a whole via `DOCUMENT_SCOPE_NODE_ID`, and the selector stays absent on the
 *   way back out. Text offsets are then document-wide, which is exactly what
 *   such an annotation already meant.
 */

export const WEB_ANNOTATION_CONTEXT = 'http://www.w3.org/ns/anno.jsonld'
export const MARGIN_NAMESPACE = 'https://margin.ernie.sg/ns#'
export const MARGIN_CONTEXT = [
  WEB_ANNOTATION_CONTEXT,
  { margin: MARGIN_NAMESPACE },
] as const

export const STRUCT_SELECTOR_TYPE = 'margin:StructSelector'
export const ANNOTATION_IRI_PREFIX = 'urn:margin:annotation:'

/** The only body format the store can hold, on the way in and on the way out. */
export const BODY_FORMAT = 'text/plain'

/** The only `type` the store can hold, likewise. */
export const ANNOTATION_TYPE = 'Annotation'

/**
 * The longest `target.source` the store accepts, checked on the canonical form.
 *
 * Checking the value as sent is not enough: `url.pathname` percent-encodes raw
 * non-ASCII characters, so a source of 200 emoji arrives at 417 UTF-16 units and
 * is reconstructed at 2,417 — accepted, stored, and then handed back in a shape
 * the schema would refuse.
 */
export const MAX_SOURCE_LENGTH = 2_048

/**
 * The node id used when a Web Annotation carries no structural selector. The
 * internal anchor requires a `nodeId`, so annotations anchored to the document
 * as a whole get this sentinel and the mapping stays reversible.
 */
export const DOCUMENT_SCOPE_NODE_ID = '@document'

/** A highlight with no `margin:color` still needs one internally. */
export const DEFAULT_HIGHLIGHT_COLOR = 'yellow'

export const MAX_BODY_LENGTH = 8_000

/**
 * What a deleted note's body becomes when other people have replied to it.
 *
 * Issue 058 chose tombstoning over cascade: a conversation that loses its root
 * is still worth reading, and a cascade would let one owner delete other
 * people's replies. The row stays, so the thread keeps its shape, and the body
 * is replaced by this value, which no client may send (`reserved_body`). It is
 * a stored value rather than a column so threads need no migration; on the
 * wire it becomes `margin:deleted: true` and no body at all.
 */
export const TOMBSTONE_BODY = '⁠margin:deleted⁠'

export function isTombstoneBody(body: string | null | undefined): boolean {
  return body === TOMBSTONE_BODY
}

/**
 * The cap for an `editing` body, which carries CriticMarkup hunks against a
 * whole source file (issue 059). A full retype of the largest node is about
 * twice its 16,138 bytes, so the note cap would refuse an ordinary proposal.
 * Highlights and notes keep `MAX_BODY_LENGTH`.
 */
export const MAX_PROPOSAL_BODY_LENGTH = 64_000

/** The issue `params.code` a body over its cap carries; the route answers 413. */
export const BODY_TOO_LARGE = 'body_too_large'

export const MOTIVATIONS = ['highlighting', 'commenting', 'editing'] as const
export type Motivation = (typeof MOTIVATIONS)[number]

/** Counted in characters of the `body` string, never truncated. */
export function maxBodyLength(motivation: Motivation): number {
  return motivation === 'editing' ? MAX_PROPOSAL_BODY_LENGTH : MAX_BODY_LENGTH
}

export const VISIBILITIES = ['private', 'public'] as const
export type MarginVisibility = (typeof VISIBILITIES)[number]

const MOTIVATION_BY_KIND = {
  highlight: 'highlighting',
  note: 'commenting',
  proposal: 'editing',
} as const satisfies Record<TextAnnotation['kind'], Motivation>

const KIND_BY_MOTIVATION = {
  highlighting: 'highlight',
  commenting: 'note',
  editing: 'proposal',
} as const satisfies Record<Motivation, TextAnnotation['kind']>

export function motivationForKind(kind: TextAnnotation['kind']): Motivation {
  return MOTIVATION_BY_KIND[kind]
}

export function kindForMotivation(
  motivation: Motivation,
): TextAnnotation['kind'] {
  return KIND_BY_MOTIVATION[motivation]
}

/* -------------------------------------------------------------------------- */
/* Wire schema                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A quote is a handful of words, not a document.
 *
 * These three go into D1 and into every collection response, and they were the
 * only strings on the wire with no maximum — so one client could store rows
 * large enough to make a list response exceed what a Worker can hold. The
 * bounds are generous for a quotation and nowhere near a page.
 */
export const MAX_QUOTE_LENGTH = 2_000
export const MAX_CONTEXT_LENGTH = 500

const textQuoteSelectorSchema = z
  .object({
    type: z.literal('TextQuoteSelector'),
    exact: z.string().min(1).max(MAX_QUOTE_LENGTH),
    prefix: z.string().max(MAX_CONTEXT_LENGTH).optional(),
    suffix: z.string().max(MAX_CONTEXT_LENGTH).optional(),
  })
  .strict()

const textPositionSelectorSchema = z
  .object({
    type: z.literal('TextPositionSelector'),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict()

const structSelectorSchema = z
  .object({
    type: z.literal(STRUCT_SELECTOR_TYPE),
    // `@document` is this service's own sentinel for "no structural selector",
    // so a client may not send it as a node id: the round trip reads it back as
    // the absence of the selector and would quietly turn a structurally
    // anchored annotation into a document-wide one. Reserved, not accepted and
    // then lost.
    'margin:nodeId': z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value !== DOCUMENT_SCOPE_NODE_ID, {
        message: `margin:nodeId is reserved when it is \`${DOCUMENT_SCOPE_NODE_ID}\``,
      }),
    'margin:structId': z.string().min(1).max(256).optional(),
  })
  .strict()

const selectorSchema = z.discriminatedUnion('type', [
  textQuoteSelectorSchema,
  textPositionSelectorSchema,
  structSelectorSchema,
])

const targetSchema = z
  .object({
    source: z.string().min(1).max(MAX_SOURCE_LENGTH),
    selector: z.union([selectorSchema, z.array(selectorSchema).min(1).max(8)]),
  })
  .strict()

/**
 * A body is plain text, and the schema says so rather than pretending
 * otherwise.
 *
 * The store keeps `value` and nothing else about a body, so accepting
 * `format: 'text/markdown'` or a `language` and then reconstructing the
 * annotation as `text/plain` with no language would corrupt it silently — the
 * client would read its own annotation back changed. Refusing the value it
 * cannot keep is the honest half of a lossless round trip; widening it later
 * means columns for these, not a looser schema.
 */
const textualBodySchema = z
  .object({
    type: z.literal('TextualBody'),
    value: z.string().min(1),
    format: z.literal(BODY_FORMAT).optional(),
  })
  .strict()

// The length cap depends on the motivation, so it is checked once the whole
// annotation has parsed; see `maxBodyLength`.
const bodySchema = z.union([z.string().min(1), textualBodySchema])

/**
 * Unknown top-level properties are dropped rather than rejected: an annotation
 * from an unrelated tool routinely carries vocabulary margin does not model,
 * and refusing it would defeat the point of choosing the standard. Unknown
 * *selectors* and unknown *motivations* are rejected, because those change
 * what the annotation points at and what it means.
 */
export const webAnnotationSchema = z.object({
  '@context': z.unknown().optional(),
  id: z.string().min(1).max(2_048).optional(),
  /**
   * `Annotation`, or a list containing it and nothing else.
   *
   * The record does not store `type` and `recordToWebAnnotation` always emits
   * `Annotation`, so anything else was accepted at 201 and read back with
   * different JSON-LD semantics. Refusing what cannot be preserved is the same
   * rule the body format and the node-id sentinel follow.
   */
  type: z
    .union([
      z.literal(ANNOTATION_TYPE),
      z.array(z.literal(ANNOTATION_TYPE)).min(1),
    ])
    .optional(),
  motivation: z.enum(MOTIVATIONS),
  body: bodySchema.optional(),
  target: z.union([targetSchema, z.array(targetSchema).length(1)]),
  creator: z.unknown().optional(),
  created: z.string().optional(),
  modified: z.string().optional(),
  'margin:visibility': z.enum(VISIBILITIES).optional(),
  'margin:parentId': z.string().min(1).max(256).optional(),
  'margin:color': z.string().min(1).max(64).optional(),
  /** Output only: set on a tombstone. Ignored on the way in. */
  'margin:deleted': z.boolean().optional(),
  /**
   * An edit proposal's base commit: the full id of the commit its hunks were
   * made against, as the page's `source-commit` stamp names it (issue 059).
   * Required on an `editing` annotation, refused on anything else.
   */
  'margin:baseCommit': z.string().min(1).max(128).optional(),
  /** The repo-relative source file an edit proposal patches. */
  'margin:sourcePath': z.string().min(1).max(512).optional(),
  /** Output only: bumped on every revision, which a review approval binds to. */
  'margin:revision': z.number().int().optional(),
  /** Output only: when the author withdrew the proposal from review. */
  'margin:withdrawnAt': z.string().optional(),
}).superRefine((wire, context) => {
  const value = typeof wire.body === 'string' ? wire.body : wire.body?.value
  const cap = maxBodyLength(wire.motivation)
  if (value !== undefined && value.length > cap) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['body'],
      message: `a body motivated by ${wire.motivation} is at most ${cap} characters`,
      params: { code: BODY_TOO_LARGE },
    })
  }
})

export type WebAnnotation = z.infer<typeof webAnnotationSchema>

/* -------------------------------------------------------------------------- */
/* Stored record                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One stored annotation. `annotation` is the internal model verbatim; every
 * other field is what margin adds on top of it.
 */
export type MarginAnnotationRecord = {
  id: string
  site: string
  document: string
  creator: string
  visibility: MarginVisibility
  parentId: string | null
  structId: string | null
  /** Present only when the wire form carried `margin:color`. */
  color: string | null
  annotation: TextAnnotation
  created: string
  modified: string
  /** An `editing` annotation's proposal fields (issue 059); absent otherwise. */
  proposal?: ProposalFields
}

export type ProposalFields = {
  /** Full id of the commit the hunks were made against. */
  baseCommit: string
  /** Repo-relative source file the proposal patches. */
  sourcePath: string
  /** 1 on creation, bumped by every revision of the body or base. */
  revision: number
  /** When the author withdrew it from review; `null` while it is pending. */
  withdrawnAt: string | null
}

/**
 * A repo-relative path: no leading slash, no `.` or `..` segment, no
 * backslash, no empty segment. The adapter in 060 joins it to a checkout, so a
 * path that could leave the checkout is refused here rather than there.
 */
export function isRepoRelativePath(value: string): boolean {
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/* -------------------------------------------------------------------------- */
/* target.source <-> (site, document)                                         */
/* -------------------------------------------------------------------------- */

/**
 * `site` is the origin and `document` is everything after it. Concatenating
 * them rebuilds the source exactly for any http(s) URI, so tenancy is a
 * property of the annotation target rather than a constant in the code.
 */
export function splitSource(
  source: string,
): { site: string; document: string } | null {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  // Credentials in a target would be dropped by `origin`, and a URI that means
  // something different once stored is worse than one that is refused.
  if (url.username || url.password) return null
  // href retains empty delimiters and Unicode-host punycode.
  if (url.href.length > MAX_SOURCE_LENGTH) return null
  // The canonical spelling, not the one that was sent. `https://ernie.sg:443/x`,
  // an upper-case host and a path with dot segments are all valid targets that
  // the parser rewrites, and rejecting them because the rewrite differs from
  // the input turned ordinary external annotations away. Tenancy wants one
  // spelling per document anyway: two spellings would be two tenants.
  // URL.search/hash omit a present-but-empty delimiter. href does not, so use
  // the canonical serialized suffix to preserve both /document? and /document#.
  const document = url.href.slice(url.origin.length)
  return { site: url.origin, document }
}

export function joinSource(site: string, document: string): string {
  return `${site}${document}`
}

export function annotationIri(id: string): string {
  return `${ANNOTATION_IRI_PREFIX}${id}`
}

/**
 * The stored key for whatever a client calls an annotation.
 *
 * A created annotation comes back with `id: urn:margin:annotation:<uuid>`, so
 * that is the identifier a client has in hand when it writes a reply. Looking
 * `margin:parentId` up verbatim against the bare `<uuid>` key made the obvious
 * thing fail with `unknown_parent`; accept either spelling of the same
 * annotation.
 */
export function annotationIdFromIri(value: string): string {
  return value.startsWith(ANNOTATION_IRI_PREFIX)
    ? value.slice(ANNOTATION_IRI_PREFIX.length)
    : value
}

/* -------------------------------------------------------------------------- */
/* wire -> record                                                             */
/* -------------------------------------------------------------------------- */

export type MappingFailure = { code: string; message: string }

export type MappingResult<T> =
  { ok: true; value: T } | { ok: false; error: MappingFailure }

function fail<T>(code: string, message: string): MappingResult<T> {
  return { ok: false, error: { code, message } }
}

/** Fields the server owns. A caller never sets these, even if it sends them. */
export type AssignedAnnotationFields = {
  id: string
  creator: string
  visibility: MarginVisibility
  created: string
  modified: string
}

type Selector = z.infer<typeof selectorSchema>
type QuoteSelector = Extract<Selector, { type: 'TextQuoteSelector' }>
type PositionSelector = Extract<Selector, { type: 'TextPositionSelector' }>
type StructSelector = Extract<Selector, { type: typeof STRUCT_SELECTOR_TYPE }>

function selectorList(target: z.infer<typeof targetSchema>): Selector[] {
  return Array.isArray(target.selector) ? target.selector : [target.selector]
}

export function webAnnotationToRecord(
  wire: WebAnnotation,
  assigned: AssignedAnnotationFields,
): MappingResult<MarginAnnotationRecord> {
  const target = Array.isArray(wire.target) ? wire.target[0] : wire.target
  const scope = splitSource(target.source)
  if (!scope) {
    return fail(
      'invalid_target_source',
      'target.source must be an absolute http(s) URI',
    )
  }

  const selectors = selectorList(target)
  const quote = selectors.find(
    (entry): entry is QuoteSelector => entry.type === 'TextQuoteSelector',
  )
  const position = selectors.find(
    (entry): entry is PositionSelector => entry.type === 'TextPositionSelector',
  )
  const struct = selectors.find(
    (entry): entry is StructSelector => entry.type === STRUCT_SELECTOR_TYPE,
  )
  if (selectors.length !== new Set(selectors.map((s) => s.type)).size) {
    return fail(
      'duplicate_selector',
      'target.selector must not repeat a selector type',
    )
  }
  if (!quote || !position) {
    return fail(
      'missing_selector',
      'target.selector must include both a TextQuoteSelector and a TextPositionSelector',
    )
  }

  const kind = kindForMotivation(wire.motivation)
  const bodyValue =
    typeof wire.body === 'string' ? wire.body : (wire.body?.value ?? null)

  if (kind === 'highlight' && bodyValue !== null) {
    return fail(
      'unexpected_body',
      'an annotation motivated by highlighting carries no body',
    )
  }
  if (isTombstoneBody(bodyValue)) {
    return fail('reserved_body', 'that body value is reserved for deleted notes')
  }
  if (kind !== 'highlight' && bodyValue === null) {
    return fail(
      'missing_body',
      `an annotation motivated by ${wire.motivation} requires a body`,
    )
  }

  let proposal: ProposalFields | undefined
  if (kind === 'proposal') {
    const baseCommit = wire['margin:baseCommit']
    if (baseCommit === undefined || !isFullCommitId(baseCommit)) {
      return fail(
        'invalid_base_commit',
        'an edit proposal needs margin:baseCommit, the full id of the commit it was made against',
      )
    }
    const sourcePath = wire['margin:sourcePath']
    if (sourcePath === undefined || !isRepoRelativePath(sourcePath)) {
      return fail(
        'invalid_source_path',
        'an edit proposal needs margin:sourcePath, the repo-relative file it patches',
      )
    }
    try {
      parseHunks(bodyValue ?? '')
    } catch (error) {
      return fail(
        'invalid_proposal',
        `an edit proposal's body must be its hunks: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    proposal = { baseCommit, sourcePath, revision: 1, withdrawnAt: null }
  } else if (
    wire['margin:baseCommit'] !== undefined ||
    wire['margin:sourcePath'] !== undefined
  ) {
    return fail(
      'unexpected_base_commit',
      'only an annotation motivated by editing names a base commit or source path',
    )
  }

  const candidate = {
    id: assigned.id,
    kind,
    target: {
      nodeId: struct?.['margin:nodeId'] ?? DOCUMENT_SCOPE_NODE_ID,
      positionUnit: 'codepoint' as const,
      position: { start: position.start, end: position.end },
      quote: {
        exact: quote.exact,
        prefix: quote.prefix ?? '',
        suffix: quote.suffix ?? '',
      },
    },
    geometryCache: [],
    ...(kind === 'highlight'
      ? {
          appearance: {
            color: wire['margin:color'] ?? DEFAULT_HIGHLIGHT_COLOR,
          },
        }
      : {
          body: bodyValue,
          // A note's role lives on the annotation too, not only the row.
          ...(kind === 'note' && wire['margin:color']
            ? { appearance: { color: wire['margin:color'] } }
            : {}),
        }),
  }

  const parsed = textAnnotationSchema.safeParse(candidate)
  if (!parsed.success) {
    return fail(
      'malformed_selector',
      parsed.error.issues[0]?.message ??
        'the selectors do not describe a range',
    )
  }

  return {
    ok: true,
    value: {
      id: assigned.id,
      site: scope.site,
      document: scope.document,
      creator: assigned.creator,
      visibility: assigned.visibility,
      parentId: wire['margin:parentId']
        ? annotationIdFromIri(wire['margin:parentId'])
        : null,
      structId: struct?.['margin:structId'] ?? null,
      color: kind === 'proposal' ? null : (wire['margin:color'] ?? null),
      annotation: parsed.data,
      created: assigned.created,
      modified: assigned.modified,
      ...(proposal ? { proposal } : {}),
    },
  }
}

/* -------------------------------------------------------------------------- */
/* record -> wire                                                             */
/* -------------------------------------------------------------------------- */

export function recordToWebAnnotation(
  record: MarginAnnotationRecord,
): WebAnnotation {
  const { annotation } = record
  const anchor = annotation.target
  const tombstone =
    annotation.kind === 'note' && isTombstoneBody(annotation.body)
  const selector: z.infer<typeof selectorSchema>[] = [
    {
      type: 'TextQuoteSelector',
      exact: anchor.quote.exact,
      ...(anchor.quote.prefix ? { prefix: anchor.quote.prefix } : {}),
      ...(anchor.quote.suffix ? { suffix: anchor.quote.suffix } : {}),
    },
    {
      type: 'TextPositionSelector',
      start: anchor.position.start,
      end: anchor.position.end,
    },
  ]
  const scoped = anchor.nodeId !== DOCUMENT_SCOPE_NODE_ID
  if (scoped || record.structId) {
    selector.push({
      type: STRUCT_SELECTOR_TYPE,
      'margin:nodeId': anchor.nodeId,
      ...(record.structId ? { 'margin:structId': record.structId } : {}),
    })
  }

  return {
    '@context': MARGIN_CONTEXT,
    id: annotationIri(record.id),
    type: ANNOTATION_TYPE,
    motivation: motivationForKind(annotation.kind),
    ...(annotation.kind === 'highlight' || tombstone
      ? {}
      : {
          body: {
            type: 'TextualBody' as const,
            value: annotation.body,
            format: BODY_FORMAT,
          },
        }),
    target: {
      source: joinSource(record.site, record.document),
      selector,
    },
    creator: record.creator,
    created: record.created,
    modified: record.modified,
    'margin:visibility': record.visibility,
    ...(record.parentId ? { 'margin:parentId': record.parentId } : {}),
    ...(record.color && !tombstone ? { 'margin:color': record.color } : {}),
    ...(tombstone ? { 'margin:deleted': true as const } : {}),
    ...(record.proposal
      ? {
          'margin:baseCommit': record.proposal.baseCommit,
          'margin:sourcePath': record.proposal.sourcePath,
          'margin:revision': record.proposal.revision,
          ...(record.proposal.withdrawnAt
            ? { 'margin:withdrawnAt': record.proposal.withdrawnAt }
            : {}),
        }
      : {}),
  }
}

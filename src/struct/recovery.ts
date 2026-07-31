import type {
  StructDiagnostic,
  StructDiagnosticSeverity,
  StructRecovery,
} from './types'

type DiagnosticCopy = Pick<
  StructDiagnostic,
  'category' | 'title' | 'message'
> & { action?: string }

/**
 * Internal diagnostics stay machine-readable, but users need to know what
 * survived, what was preserved as source material, and whether they need to
 * do anything. Keep this table deliberately source-agnostic.
 */
const DIAGNOSTIC_COPY: Record<string, DiagnosticCopy> = {
  OCR_REQUIRED: {
    category: 'text',
    title: 'Some pages needed OCR',
    message: 'Text was recovered from page images instead of embedded text.',
  },
  LOW_CONFIDENCE_OCR: {
    category: 'text',
    title: 'Some scanned text may need a quick check',
    message:
      'The readable export keeps the scanned page content while OCR confidence is lower than usual.',
    action:
      'Compare the marked page with the source only if a word looks wrong.',
  },
  AMBIGUOUS_READING_ORDER: {
    category: 'layout',
    title: 'A multi-column reading order was uncertain',
    message:
      'The export keeps the source order and preserves the affected page region so no text is silently discarded.',
    action:
      'Check the affected page in the preview if paragraph order matters.',
  },
  READING_ORDER_CYCLE: {
    category: 'layout',
    title: 'A page layout could not be fully ordered',
    message:
      'The source layout is preserved for the affected region instead of inventing a paragraph order.',
    action:
      'Use the preview to confirm the page reads in the intended direction.',
  },
  UNRESOLVED_VISUAL_OBJECT: {
    category: 'visuals',
    title: 'A figure or diagram was kept as source artwork',
    message:
      'The source visual and its caption remain in the readable export even though it was not safely converted to a semantic object.',
  },
  UNREFERENCED_VISUAL_ASSET: {
    category: 'visuals',
    title: 'A source visual had no reliable anchor',
    message:
      'The original visual is included in a source-preserved section so it is not lost.',
  },
  AMBIGUOUS_VISUAL_MATCH: {
    category: 'visuals',
    title: 'A visual had more than one possible match',
    message:
      'The export keeps the source visual and caption rather than attaching it to the wrong paragraph.',
  },
  INCOMPLETE_ASSET_COVERAGE: {
    category: 'visuals',
    title: 'Some source artwork could not be packaged',
    message:
      'The importer preserved the source page region where an individual asset could not be extracted.',
    action:
      'If the preview still shows a blank region, keep the original PDF alongside the EPUB.',
  },
  INCOMPLETE_SEMANTIC_TABLE_COVERAGE: {
    category: 'tables',
    title: 'A table stayed source-preserved',
    message:
      'The original table is included as artwork or a bounded text fallback instead of being flattened into unrelated headings.',
  },
  BOUNDED_TABLE_FALLBACK: {
    category: 'tables',
    title: 'A table uses a safe fallback',
    message:
      'The table stays together with its caption and source evidence because its rows or columns were not unambiguous.',
  },
  UNRESOLVED_EQUATION_TRANSCRIPT: {
    category: 'equations',
    title: 'An equation remains as source artwork',
    message:
      'The original equation image is retained; no unverified transcription is substituted.',
  },
  UNRESOLVED_HYPERLINK: {
    category: 'links',
    title: 'Some links could not be matched',
    message:
      'Links with verified destinations remain clickable; uncertain links are kept as visible source text.',
  },
  INCOMPLETE_RELATIONSHIP_COVERAGE: {
    category: 'links',
    title: 'Some document connections stayed source-preserved',
    message:
      'Captions, notes, citations, or cross-references without a verified destination remain visible without being linked to the wrong target.',
  },
  AMBIGUOUS_NOTE_MATCH: {
    category: 'notes',
    title: 'A note had more than one possible reference',
    message:
      'The note and its marker remain readable without inventing a link between them.',
  },
  UNRESOLVED_NOTE_REFERENCE: {
    category: 'notes',
    title: 'A note marker could not be matched safely',
    message:
      'The marker and note text remain visible; only verified note destinations become links.',
  },
  UNREFERENCED_NOTE: {
    category: 'notes',
    title: 'A note had no reliable marker',
    message:
      'The note remains in the export instead of being discarded or attached to unrelated text.',
  },
  DANGLING_NOTE_REFERENCE: {
    category: 'notes',
    title: 'A note link had no verified destination',
    message: 'The note marker remains visible as text without a broken link.',
  },
  UNRESOLVED_CITATION_REFERENCE: {
    category: 'links',
    title: 'A citation could not be matched safely',
    message:
      'The citation text remains in place instead of linking to the wrong reference.',
  },
  UNRESOLVED_SCHOLARLY_CROSS_REFERENCE: {
    category: 'links',
    title: 'A figure, table, or section reference was uncertain',
    message:
      'The reference text is preserved; only verified destinations become links.',
  },
  UNMAPPED_CITATION_ANCHOR: {
    category: 'links',
    title: 'A citation anchor was not mapped',
    message:
      'The citation remains readable as text and is not pointed at an unrelated bibliography entry.',
  },
  MISSING_SOURCE_REGION: {
    category: 'source',
    title: 'A source region was unavailable',
    message:
      'The exporter records the gap and keeps the nearest recoverable source content.',
    action:
      'Retain the original file if this page is important to the publication.',
  },
  MISSING_IMAGE_PART: {
    category: 'visuals',
    title: 'An embedded image could not be opened',
    message:
      'The export keeps its caption and source position so the missing artwork is explicit.',
    action: 'Check the affected image in the preview before publishing.',
  },
  MISSING_IMAGE_CAPTION: {
    category: 'visuals',
    title: 'An image had no reliable caption',
    message:
      'The image remains in its source position without an invented description.',
  },
  NO_RECONSTRUCTABLE_TEXT: {
    category: 'text',
    title: 'Text could not be recovered from a page',
    message:
      'The source page must be preserved or rescanned because a readable text layer was not available.',
    action: 'Check the marked page or provide a clearer source file.',
  },
  ISOLATED_PROSE_GLYPH: {
    category: 'text',
    title: 'A character could not be joined to surrounding prose',
    message:
      'The character remains source-preserved rather than being inserted into the wrong word.',
  },
  INCOMPLETE_TEXT_COVERAGE: {
    category: 'text',
    title: 'Some source text was not recoverable',
    message:
      'The readable export is available for review, but it should not be treated as a final publication.',
    action: 'Check the affected pages against the source before publishing.',
  },
  UNRESOLVED_CORRUPTING_JOIN: {
    category: 'text',
    title: 'A line break could not be joined safely',
    message:
      'The original line break is retained rather than merging two words incorrectly.',
  },
  UNRESOLVED_SEMANTIC_OBJECTS: {
    category: 'source',
    title: 'Some structure remains source-preserved',
    message:
      'Uncertain objects stay attached to their source region instead of being guessed.',
  },
  UNRESOLVED_FRONT_MATTER: {
    category: 'layout',
    title: 'Front matter stayed in its source layout',
    message:
      'The affected title, author, or publication details remain together without being guessed into the wrong fields.',
  },
  INCOMPLETE_INLINE_STYLE_COVERAGE: {
    category: 'text',
    title: 'Some inline formatting stayed source-preserved',
    message:
      'Text remains readable while uncertain emphasis, superscripts, or subscripts are kept with their source evidence.',
  },
  DANGLING_EPUB_INTERNAL_REFERENCE: {
    category: 'links',
    title: 'An internal link had no verified destination',
    message:
      'The reference remains visible as text without a broken EPUB link.',
  },
  UNRESOLVED_ALGORITHM_BLOCK: {
    category: 'source',
    title: 'An algorithm stayed in its source layout',
    message:
      'The complete bounded algorithm region is preserved instead of being flattened into unrelated paragraphs.',
  },
  UNRESOLVED_ALGORITHM_TRANSCRIPT: {
    category: 'source',
    title: 'An algorithm transcript was uncertain',
    message:
      'The source algorithm remains available without an unverified text transcription.',
  },
  UNRESOLVED_PREFORMATTED_BLOCK: {
    category: 'source',
    title: 'A preformatted block stayed in its source layout',
    message:
      'Spacing and line structure are preserved instead of being promoted to headings or ordinary prose.',
  },
  UNRESOLVED_PREFORMATTED_TRANSCRIPT: {
    category: 'source',
    title: 'A preformatted transcript was uncertain',
    message:
      'The bounded source block remains available without an invented structure.',
  },
}

const FALLBACK_COPY: DiagnosticCopy = {
  category: 'source',
  title: 'A source detail needs review',
  message:
    'The readable export preserves the recoverable source content and avoids making an unsupported structural guess.',
}

export function diagnosticCopy(
  code: string,
  _originalMessage?: string,
): DiagnosticCopy {
  return DIAGNOSTIC_COPY[code] ?? FALLBACK_COPY
}

export function diagnosticCategory(code: string): StructDiagnostic['category'] {
  return diagnosticCopy(code).category
}

export function toStructDiagnostic(input: {
  id?: string
  code: string
  severity: StructDiagnosticSeverity
  message: string
  page?: number
  sourceIds?: string[]
}) {
  const copy = diagnosticCopy(input.code, input.message)
  return {
    id: input.id ?? `${input.code}-${input.page ?? 'document'}`,
    severity: input.severity,
    category: copy.category,
    title: copy.title,
    message: copy.message,
    ...(copy.action ? { action: copy.action } : {}),
    pages: input.page === undefined ? [] : [input.page],
    sourceIds: input.sourceIds ?? [],
  } satisfies StructDiagnostic
}

type RecoveryInput = {
  ready: boolean
  diagnostics: ReadonlyArray<{
    code: string
    severity: StructDiagnosticSeverity
    message: string
    page?: number
  }>
  blockingCodes?: readonly string[]
  textCoverage?: number
  assetCoverage?: number
  relationshipCoverage?: number
  unresolvedObjectCount?: number
}

export function recoverySummary(input: RecoveryInput): StructRecovery {
  const blocking = new Set(input.blockingCodes ?? [])
  const relevant = input.diagnostics.filter(
    (diagnostic) =>
      diagnostic.severity !== 'info' &&
      (blocking.size === 0 || blocking.has(diagnostic.code)),
  )
  const categoryTitles: Record<StructDiagnostic['category'], string> = {
    text: 'Some text needs a source check',
    layout: 'Some page order or layout needs a quick check',
    visuals: 'Some figures or diagrams stayed source-preserved',
    tables: 'Some tables stayed source-preserved',
    equations: 'Some equations stayed source-preserved',
    links: 'Some links or references could not be verified',
    notes: 'Some footnotes or endnotes could not be linked safely',
    source: 'Some structured content stayed in its source layout',
  }
  const groups = new Map<
    StructDiagnostic['category'],
    { title: string; count: number; action?: string }
  >()
  for (const diagnostic of relevant) {
    const copy = diagnosticCopy(diagnostic.code, diagnostic.message)
    const previous = groups.get(copy.category)
    groups.set(copy.category, {
      title: categoryTitles[copy.category],
      count: (previous?.count ?? 0) + 1,
      ...(previous?.action || copy.action
        ? { action: previous?.action ?? copy.action }
        : {}),
    })
  }
  const issues = [...groups.entries()].map(([category, group]) => ({
    category,
    title: group.title,
    count: group.count,
    ...(group.action ? { action: group.action } : {}),
  }))
  if (input.ready) {
    return {
      status: 'ready',
      title: 'Your EPUB is ready to read.',
      summary:
        'Text, links, notes, and source visuals passed the reconstruction checks. The file stays on this device.',
      issues,
    }
  }
  const fallbackAvailable =
    (input.textCoverage ?? 0) > 0 &&
    (input.assetCoverage ?? 0) >= 0 &&
    (input.relationshipCoverage ?? 0) >= 0
  return {
    status: 'review-required',
    title: fallbackAvailable
      ? 'Your readable EPUB is ready for review.'
      : 'This file needs a source check before it can be exported.',
    summary: fallbackAvailable
      ? 'We kept recoverable text and source-preserved visuals wherever a safe semantic reconstruction was not possible. Nothing was uploaded.'
      : 'The importer could not recover enough source content to make a trustworthy EPUB. Nothing was uploaded.',
    issues,
    userAction: issues.some((issue) => issue.action)
      ? 'Open the preview and compare the listed pages with the original before publishing.'
      : undefined,
  }
}

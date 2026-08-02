const SAFE_DIAGNOSTIC_MESSAGES = Object.freeze({
  OCR_REQUIRED: 'A page requires local OCR.',
  MIXED_PAGE: 'A page mixes sparse text with image content.',
  REPEATED_MARGIN_TEXT:
    'Repeated header or footer patterns were removed from reading order.',
  FURNITURE_REVIEW_REQUIRED:
    'A single-occurrence margin run requires bounded source review.',
  FURNITURE_CONTAMINATION:
    'Accounted page furniture entered canonical reading flow.',
  LOW_CONFIDENCE_BLOCK: 'A reconstructed block requires reading-order review.',
  RESOLVED_READING_ORDER:
    'A reading-order region was resolved from deterministic geometry.',
  SOURCE_ORDER_FLOAT_FALLBACK:
    'An optional float move was skipped to preserve source-proved order.',
  AMBIGUOUS_READING_ORDER:
    'The document contains an ambiguous reading-order region.',
  CANONICAL_FLOW_ORDER_VIOLATION:
    'Canonical content crosses, reverses, or changes source-proved flow.',
  CANONICAL_VISUAL_ORDER_VIOLATION:
    'Matched visual-caption pairs reverse their source-proved order.',
  NO_RECONSTRUCTABLE_TEXT: 'No reconstructable embedded text was found.',
  INCOMPLETE_TEXT_COVERAGE:
    'Recovered text is below the configured completeness threshold.',
  INCOMPLETE_ASSET_COVERAGE:
    'Reconstructed assets are below the configured completeness threshold.',
  INCOMPLETE_RELATIONSHIP_COVERAGE:
    'Resolved relationships are below the configured completeness threshold.',
  INCOMPLETE_SEMANTIC_TABLE_COVERAGE:
    'Detected tables remain image-only instead of semantic row-and-column structures.',
  UNRESOLVED_SEMANTIC_OBJECTS: 'Detected semantic objects remain unresolved.',
})

const REDACTED_DIAGNOSTIC_MESSAGE =
  'The audit produced a diagnostic whose document details were suppressed.'

export function safeAuditDiagnostic({ code, severity, page }) {
  return {
    code,
    severity,
    ...(page === undefined ? {} : { page }),
    message: Object.hasOwn(SAFE_DIAGNOSTIC_MESSAGES, code)
      ? SAFE_DIAGNOSTIC_MESSAGES[code]
      : REDACTED_DIAGNOSTIC_MESSAGE,
  }
}

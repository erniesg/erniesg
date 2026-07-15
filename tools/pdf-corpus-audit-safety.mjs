const SAFE_DIAGNOSTIC_MESSAGES = Object.freeze({
  OCR_REQUIRED: 'A page requires local OCR.',
  MIXED_PAGE: 'A page mixes sparse text with image content.',
  REPEATED_MARGIN_TEXT:
    'Repeated header or footer patterns were removed from reading order.',
  LOW_CONFIDENCE_BLOCK: 'A reconstructed block requires reading-order review.',
  AMBIGUOUS_READING_ORDER:
    'The document contains an ambiguous reading-order region.',
  NO_RECONSTRUCTABLE_TEXT: 'No reconstructable embedded text was found.',
  INCOMPLETE_TEXT_COVERAGE:
    'Recovered text is below the configured completeness threshold.',
  INCOMPLETE_ASSET_COVERAGE:
    'Reconstructed assets are below the configured completeness threshold.',
  INCOMPLETE_RELATIONSHIP_COVERAGE:
    'Resolved relationships are below the configured completeness threshold.',
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

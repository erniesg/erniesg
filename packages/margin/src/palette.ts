/**
 * Highlight colours as roles, not hues.
 *
 * What an annotation stores is the role — `key`, `question` — and never a CSS
 * value. The painter looks the role up in a palette at paint time, so a dark
 * theme, a print stylesheet or an EPUB renderer restyles every existing
 * highlight by supplying a different palette, without a second set of
 * annotations and without rewriting a single row.
 *
 * Roles are also what the reader is choosing between. "Yellow" says nothing
 * about why a passage was marked; "question" does, and it survives a theme
 * where the swatch is not yellow at all.
 */

export const HIGHLIGHT_ROLES = ['key', 'question', 'idea', 'revisit'] as const
export type HighlightRole = (typeof HIGHLIGHT_ROLES)[number]

export const DEFAULT_HIGHLIGHT_ROLE: HighlightRole = 'key'

export const HIGHLIGHT_ROLE_LABELS: Record<HighlightRole, string> = {
  key: 'Key point',
  question: 'Question',
  idea: 'Idea',
  revisit: 'Revisit',
}

/**
 * Annotations written before roles existed stored a hue. They keep painting —
 * and keep their meaning in the rail — by reading as the role that hue stood
 * for. Nothing rewrites them.
 */
const LEGACY_HUES: Record<string, HighlightRole> = {
  default: 'key',
  amber: 'key',
  yellow: 'key',
  blue: 'question',
  green: 'idea',
  pink: 'revisit',
}

/** The role a stored colour value means, or the default for anything unknown. */
export function highlightRole(
  stored: string | null | undefined,
): HighlightRole {
  if (stored && (HIGHLIGHT_ROLES as readonly string[]).includes(stored)) {
    return stored as HighlightRole
  }
  return (stored && LEGACY_HUES[stored]) || DEFAULT_HIGHLIGHT_ROLE
}

/** The light-theme values. A host passes its own palette for anything else. */
export const ROLE_PALETTE: Record<HighlightRole, string> = {
  key: 'rgba(250, 204, 21, 0.38)',
  question: 'rgba(56, 189, 248, 0.34)',
  idea: 'rgba(74, 222, 128, 0.34)',
  revisit: 'rgba(244, 114, 182, 0.34)',
}

/** Notes paint too, so a reader can see — and click — what a note is about. */
export const NOTE_PAINT_KEY = 'note'
export const NOTE_PAINT = 'rgba(148, 163, 184, 0.30)'

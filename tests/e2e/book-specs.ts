/**
 * The specs that run against the book's own preview (`books/tools/preview.py`),
 * not against Astro. One list, read by both Playwright configs: the book config
 * runs exactly these, and the root config ignores exactly these. Adding a book
 * spec means adding it here and nowhere else.
 */
export const BOOK_SPECS = [
  'editor-keys.spec.ts',
  'exercise-worker.spec.ts',
  'hint-ladder.spec.ts',
  'inline-exercise.spec.ts',
  'rerun-clears-results.spec.ts',
  'run-cell.spec.ts',
]

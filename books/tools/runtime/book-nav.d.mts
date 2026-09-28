/** Types for `book-nav.mjs`, which stays plain JavaScript so the preview can inline it as-is. */

export type Shortcut = 'prev' | 'next' | 'section-next' | 'section-prev' | 'help'

export const SHORTCUTS: ReadonlyArray<readonly [string, string]>
export function shortcutFor(event: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  defaultPrevented?: boolean
  isComposing?: boolean
}): Shortcut | null
export function isTypingContext(event: Event, doc: Document): boolean
export function statusText(options: {
  kind: string
  section: number
  sections: number
  practice: number
  total: number
  solved: number
}): string
export function sectionIndex(tops: number[], line: number, atEnd?: boolean): number
export function nextHeading(
  tops: number[],
  line: number,
  direction: number,
  pinned?: number,
): number
export function trackChapterProgress(doc?: Document): () => void
export function installBookKeys(doc?: Document): void

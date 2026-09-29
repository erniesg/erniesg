/** Types for `progress.mjs`, which stays plain JavaScript so the preview can serve it as-is. */

export type Draft = { code: string; updatedAt: string }

export type Progress = {
  version: 1
  book: string
  solved: string[]
  solvedAt: Record<string, string>
  drafts: Record<string, Draft>
}

export type Tally = { solved: number; total: number }

export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const PROGRESS_VERSION: 1
export const MAX_DRAFT_LENGTH: number
export function isItemId(value: unknown): value is string
export function emptyProgress(book: string): Progress
export function normalize(raw: unknown, book: string): Progress
export function merge(a: unknown, b: unknown): Progress
export function acknowledge(mine: Progress, stored: Progress): Progress
export function compareDrafts(a: Draft, b: Draft): number
export function markSolved(progress: Progress, id: string, now: string): Progress
export function setDraft(progress: Progress, id: string, code: string, now: string): Progress
export function isSolved(progress: Progress, id: string): boolean
export function counts(
  progress: Progress,
  ids: { exercises?: string[]; challenges?: string[] },
): { exercises: Tally; challenges: Tally }
export function sameProgress(a: unknown, b: unknown): boolean
export function storageKey(book: string): string
export function browserStore(
  book: string,
  storage: StorageLike | null | undefined,
): { load(): Progress; save(progress: Progress): boolean }

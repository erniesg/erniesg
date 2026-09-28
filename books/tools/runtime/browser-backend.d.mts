/** Types for `browser-backend.mjs`. */
import type { BookBackend } from './interactive.mjs'

export type BookGradingData = {
  module: string
  tiers: { tier: string; timeout: number; source: string }[]
}

export function browserBackend(options: {
  sources: Record<string, string>
  grading: (node: string) => BookGradingData | null
}): BookBackend

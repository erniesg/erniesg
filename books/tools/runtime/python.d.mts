/** Types for `python.mjs`. */
export const RUN_BUDGET_MS: number
export const TIMED_OUT: string
export function pythonLoaded(): boolean
export function runPython(
  job: string | { source: string; files?: Record<string, string>; budgetMs?: number },
): Promise<{ out: string; error: string; value: string | null; timedOut: boolean }>

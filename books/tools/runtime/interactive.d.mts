/** Types for `interactive.mjs`. */
export type BookBackend = {
  exec(request: { source: string; earlier: { index: number; source: string }[] }): Promise<{ output: string; ok: boolean }>
  grade(request: { node: string; source: string }): Promise<unknown>
  sample(request: { node: string; source: string }): Promise<unknown>
}

export function wireInteractive(root: ParentNode, backend: BookBackend): void

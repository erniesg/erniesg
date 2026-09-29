/** Types for `book-progress.mjs`. */
import type { Progress } from './progress.mjs'

export type ProgressBackend = {
  load(): Promise<unknown>
  save(progress: Progress): Promise<unknown | null>
  describe?(): string
}

export function startProgress(options: {
  root?: ParentNode
  book: string
  backend: ProgressBackend
  now?: () => string
}): Promise<{ current(): Progress; flush(): void; stop(): void }>

// The anchor and annotation model moved to `src/annotations/` so books, papers
// and the library can share it without importing through `research`. This file
// stays as a compatibility re-export for callers that still address the old
// path — `tools/srt/demo-evaluation.mjs` loads it by path. New code should
// import from `@/annotations/annotations` directly.
export * from '../annotations/annotations'

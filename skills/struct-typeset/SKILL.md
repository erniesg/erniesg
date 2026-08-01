---
name: struct-typeset
description: Reconstruct and typeset source-backed PDF, DOCX, HTML, or scanned documents while preserving figures, diagrams, captions, tables, equations, footnotes, citations, hyperlinks, and multi-column reading order. Use when converting documents to EPUB or accessible HTML, diagnosing missing or flattened document structure, designing extraction adapters, or validating faithful visual fallbacks and provenance.
---

# Struct Typeset

Build outputs from a canonical, source-backed document graph. Prefer verified semantics; preserve the bounded source region whenever structure is ambiguous.

## Workflow

1. Inspect the source adapter and existing fixtures before changing extraction logic.
2. Extract text runs, glyph geometry, page objects, embedded assets, annotations, and links without assigning semantics prematurely.
3. Convert the extraction result with `src/struct/from-reconstruction.ts`. Keep extractor IDs only in evidence; expose stable STRUCT IDs in graph relationships.
4. Verify reading order, captions, notes, citations, tables, equations, and hyperlinks against source geometry and annotations.
5. Promote an object to semantic structure only when its evidence is sufficient. Otherwise retain a bounded source asset or page-region fallback with its caption and provenance.
6. Render from the STRUCT graph with `src/struct/xhtml.ts` or assemble an EPUB with `src/struct/epub.ts`. The compatibility exports in `src/research/epub.ts` accept `StructDocument`; extractor-private data is not needed on this path. Never drop an unresolved source obligation, invent a link destination, flatten a table into headings, or treat Markdown-like source text as markup without source evidence.
7. Present recovery through `src/struct/recovery.ts`. Keep machine codes in logs or review tooling; show users plain-language outcomes and actions.
8. Validate with diverse fixtures and inspect the produced EPUB or HTML, not only intermediate JSON.

## Model consultation boundary

Use deterministic extraction and validation first. When a bounded layout decision remains ambiguous, open a separate Codex task with `gpt-5.6-luna` and `max` reasoning. Supply only the deterministic candidates and their STRUCT provenance. Reject any response that invents text, bytes, bounds, or destinations. Persist the proposal separately from the autonomous VM implementation receipt, then convert every accepted decision class into a fixture and deterministic rule.

## Autonomous development loop

- Resume the newest clean checkpoint for the issue before creating a branch or
  rerunning discovery. Record the branch, commit, failing fixture, and next
  command in the issue receipt.
- Declare each worker as `parser-core` or `evidence-eval` and name its write
  scope. Never run two parser-core workers or two workers that can edit the same
  files. A second evidence/eval worker is allowed only when the queue proves
  disjoint paths plus disk and memory headroom; otherwise use one worker.
- Work red → green → refactor with the narrowest affected fixtures. Commit each
  independently passing slice. Run the full suite, build, corpus, and visual
  comparison only at integration checkpoints instead of after every small edit.
- Preserve dependency caches between checkpointed runs, but treat them as
  reproducible. Never reclaim a live worktree, handoff, receipt, referenced
  evidence artifact, or source file to make space.
- Autonomous VM implementation uses `gpt-5.6-sol` with `high` reasoning. Keep
  the optional Luna layout consultation separate as described above.

## Required invariants

- Preserve every recoverable source text span exactly once in the reading flow or a declared source fallback.
- Give every block, asset, and relationship stable IDs plus source pages, boxes, confidence, and source IDs.
- Point graph relationships only to graph nodes/assets or explicit external destinations.
- Keep verified hyperlinks clickable and uncertain references visible without a false destination.
- Represent verified tables with cells, spans, header scope, and inline links; keep ambiguous tables as one bounded visual object.
- Retain equations and diagrams as source artwork unless a transcription is independently verified.
- Keep footnote/endnote markers and bodies even when their association is unresolved.
- Hash receipts from canonical metadata and asset digests, not duplicate embedded bytes.
- Reconcile source and STRUCT node, region, asset, relationship, diagnostic, and text-character counts in `receipt.conservation`; pin representative `generatedSha256` receipts in fixtures.
- Treat a readable fallback as recoverable output, not publication-ready output.

## Validation

Run the narrowest relevant fixtures first, then the repository gates:

```bash
npx vitest run src/struct/struct.test.ts src/research/epub-source-fallback.test.ts
npm run test
npm run build
scripts/agent-evidence
```

Add fixtures that vary independently across born-digital/scanned input, one/two columns, raster/vector visuals, semantic/ambiguous tables, equations, notes, and internal/external links. Do not tune a rule to a paper title, author, fixed page, or expected caption string.

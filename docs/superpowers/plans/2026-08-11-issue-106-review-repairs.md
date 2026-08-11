# Issue 106 Independent Review Repair Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Repair PR #169's four P1 findings without weakening the source-to-output integrity contract, while leaving every focused-green slice durably pushed on `codex/issue-106-rucksack`.

**Architecture:** Keep semantic ownership decisions at reconstruction time, where page geometry and canonical segment boundaries are available, then make export and evidence gates independently recompute enough source truth to detect stale relationships. Extend the existing deterministic association fixture into executable ground truth and embed its checkpoint/counter result in the exact-head evidence manifest.

**Tech Stack:** TypeScript, Vitest, PDF.js, Node.js ESM audit tools, GitHub exact-head evidence.

---

### Task 1: Prefer body source owners and reject stale EPUB relationships

**Files:**
- Modify: `src/research/pdf-note-classifier.test.ts`
- Modify: `src/research/pdf-layout.ts`
- Modify: `src/research/epub.test.ts`
- Modify: `src/research/epub.ts`
- Modify if required by the failing export assertion: `src/publication/publication-integrity.ts`

- [ ] Add a regression test whose body and caption/footnote both contain `Figure 1`, asserting the canonical relationship source is the body occurrence and the self-label does not create or replace it.
- [ ] Run the targeted classifier test and confirm the new assertion fails for the reviewed behavior.
- [ ] Make the smallest ownership-ranking change at canonical-anchor resolution so eligible body source spans beat definition/self-label spans without hiding real ambiguity between peer body spans.
- [ ] Add an EPUB regression test that mutates/removes the reconstructed source owner while retaining a stale relationship and expects export integrity to fail closed.
- [ ] Run the targeted EPUB test and confirm it fails before the export revalidation change.
- [ ] Recompute the detectable source relationships during export/integrity validation and reject stale or unowned relationships; do not trust serialized relationship objects alone.
- [ ] Run `npm exec -- vitest run src/research/pdf-note-classifier.test.ts src/research/epub.test.ts src/struct/epub-integrity.test.ts --maxWorkers=1` and confirm green.
- [ ] Run diff/secret checks, commit the focused checkpoint, and push with a lease pinned to the exact previous PR head.

### Task 2: Keep Unicode folios as furniture while recognizing real Unicode notes

**Files:**
- Modify: `src/research/pdf-note-classifier.test.ts`
- Modify: `src/research/pdf-regions.ts`
- Modify if the failing ownership test proves classification is downstream: `src/research/pdf-note-classifier.ts`

- [ ] Add paired regressions for Arabic-Indic and Devanagari numerals: repeated margin folios remain `page-number` furniture, while a geometrically raised source marker with a matching compact note definition remains a note relationship.
- [ ] Run the targeted tests and confirm the folio case fails while the genuine-note case describes the preserved behavior.
- [ ] Add context/geometry-aware note-stratum eligibility for Unicode decimal labels, preserving the existing ASCII and genuine Unicode note paths.
- [ ] Run `npm exec -- vitest run src/research/pdf-note-classifier.test.ts src/research/pdf-regions.test.ts --maxWorkers=1` and confirm green.
- [ ] Run diff/secret checks, commit the focused checkpoint, and push with a lease pinned to the exact previous PR head.

### Task 3: Enforce canonical segment ownership during nested marker scans

**Files:**
- Modify: `src/research/pdf-note-classifier.test.ts`
- Modify: `src/research/pdf-note-classifier.ts`

- [ ] Add a regression around compound/nested affiliation definitions that expects the four canonical affiliations and no two duplicate nested-marker relationships.
- [ ] Run the targeted test and confirm the current scanner returns six relationships.
- [ ] Restrict nested candidate discovery to the owning canonical segment and exclude sibling-definition labels already owned by adjacent segments.
- [ ] Run `npm exec -- vitest run src/research/pdf-note-classifier.test.ts --maxWorkers=1` and confirm green.
- [ ] Run diff/secret checks, commit the focused checkpoint, and push with a lease pinned to the exact previous PR head.

### Task 4: Make the issue-106 association audit executable and required

**Files:**
- Modify: `tests/fixtures/pdf/note-citation-associations.json`
- Create: `tools/pdf-association-fixture-audit.mjs`
- Create: `tools/pdf-association-fixture-audit.test.mjs`
- Modify: `tools/pdf-association-fixture-audit-lib.mjs`
- Modify: `scripts/agent-evidence`
- Modify: `src/research/source-output-checkpoints.test.ts`

- [ ] Record the fixture path, exact SHA-256, baseline Git ref, explicit expected note/citation associations, and baseline counters in the ground-truth JSON while retaining the five named checkpoints.
- [ ] Add failing CLI/library tests that require fixture-hash validation, five executable checkpoint results, and exact `before`/`after` counters.
- [ ] Implement the deterministic audit CLI: reconstruct the fixture, compare associations, evaluate all five source-output checkpoints, and emit one exact JSON result.
- [ ] Wire the audit as a required `scripts/agent-evidence` lane and embed its full five-checkpoint plus before/after result in the final exact-head manifest.
- [ ] Run `node --test tools/pdf-association-fixture-audit.test.mjs` and `node tools/pdf-association-fixture-audit.mjs` and confirm green.
- [ ] Run the focused eight-file Vitest suite and confirm all tests pass.
- [ ] Run `npm run build`, `npm test`, and `scripts/agent-evidence` from the clean exact head; inspect the resulting manifest for the required association-audit lane, five checkpoints, before/after counters, clean tree, and exact commit.
- [ ] Run final diff/secret checks, commit the focused checkpoint, push with a lease pinned to the exact previous PR head, and verify GitHub PR-head convergence.

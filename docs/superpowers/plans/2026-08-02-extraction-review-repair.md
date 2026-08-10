# Extraction Review Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair all confirmed post-merge review defects in the structured extraction verifier and bake-off runner while preserving the privacy-safe, fail-closed contract.

**Architecture:** Keep source ownership and deterministic assets in `structured-extraction.ts`; extend only the model-facing context and verified node contract needed for page evidence and note/citation relationships. Keep bake-off validation, scoring, receipt integrity, contamination handling, and adapter isolation in `extraction-bakeoff.ts`. Update focused tests and the two published JSON schemas with no changes to deployment or evidence tooling.

**Tech Stack:** TypeScript, Zod, Vitest, JSON Schema, SHA-256 stable JSON receipts.

## Global Constraints

- Held-out labels and private source text/bytes never enter candidate payloads or committed receipts.
- Tables require semantic cells; figures require deterministic assets and source-backed captions; all emitted text remains source-run materialized.
- Held-out scoring is once per corpus/candidate/document identity, with a caller-owned store available across process runs.
- Adapter failures are isolated to failed document rows; contamination disqualifies the arm for the remaining held-out documents.
- `scripts/agent-evidence` remains byte-identical and all changes stay uncommitted on the provider branch.

### Task 1: Add verifier regressions and context contract fields

**Files:**

- Modify: `src/research/structured-extraction.test.ts`
- Modify: `src/research/extraction-bakeoff.test.ts`
- Modify: `src/research/structured-extraction.ts`

- [x] Write failing tests for split-array membership, case-label references, code whitespace, semantic tables/figures, heading-level scoring, report hash tampering, persisted score-once state, scoped disagreements, adapter isolation, contamination stop, page renditions, non-figure alt text, source order, and reciprocal note/citation links.
- [x] Run the focused Vitest files and confirm the new assertions fail for the expected missing behavior.
- [x] Add the minimal page-rendition/context, relationship, and verifier validation fields needed by those tests.
- [x] Re-run the focused files until all new and existing assertions pass.

### Task 2: Harden bake-off validation and execution boundaries

**Files:**

- Modify: `src/research/extraction-bakeoff.ts`

- [x] Bind development and held-out documents to their containing arrays and validate case labels against source runs, assets, boilerplate, and heading levels.
- [x] Include heading levels in scores, derive page denominators from context page evidence, scope disagreements to the active stratum/case, and verify report hashes before decisions.
- [x] Reserve score-once keys through the caller-owned store, isolate adapter/metrics failures, and stop contaminated arms before later held-out documents.
- [x] Run focused extraction tests and the synthetic bake-off CLI self-test.

### Task 3: Synchronize schemas and triage documentation

**Files:**

- Modify: `docs/schemas/structured-extraction-output.schema.json`
- Modify: `docs/schemas/extraction-bakeoff-report.schema.json`
- Modify: `docs/research/semantic-responsive-typesetting/extraction-architecture-bakeoff.md`

- [x] Add the relationship and heading-score fields to the schemas without exposing source text/bytes.
- [x] Record confirmed status and bounded repair coverage for all 17 findings in the existing architecture note.
- [ ] Validate focused tests, full `npm test`, `npm run build`, `scripts/agent-evidence`, and the post-change VM verification command. (Focused tests/build/evidence build and VM verification passed; the required full test lane timed out with unrelated PDF corpus/OCR failures.)

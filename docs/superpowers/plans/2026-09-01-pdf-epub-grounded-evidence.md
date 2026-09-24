# PDF-to-EPUB Grounded Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make staged PDF conversion and promotion evidence fail closed when grounded Codex, a private blind test, or native-reader proof is absent.

**Architecture:** Preserve the static browser-local conversion boundary and the separate owner-local Node/Codex boundary. Correct the browser export policy and copy, then extend existing benchmark generators and readiness validation rather than inventing alternate promotion paths.

**Tech Stack:** React, TypeScript, Vitest, Node.js CLIs, JSON benchmark receipts.

**Spec:** `docs/issues/051-close-grounded-codex-and-holdout-gap.md`

## Global Constraints

- Never upload a selected PDF or source-derived crop from the static staging route.
- Never treat a synthetic provider identity or browser renderer as promotion evidence.
- Keep current benchmark and native-reader gaps fail-closed.
- Use test-first RED/GREEN evidence for every behavior change.

---

### Task 1: Fail-closed browser export policy

**Files:** `src/components/research/PublicationImporter.tsx`, `src/components/research/PublicationImporter.test.tsx`

- [ ] Add focused regressions asserting PDF mode is never `publication`, DOCX remains unchanged, and browser copy says Codex is not consulted.
- [ ] Run the focused Vitest and confirm RED.
- [ ] Implement the minimal mode selection and copy change.
- [ ] Re-run the focused Vitest and confirm GREEN.

### Task 2: Mark synthetic bakeoff authority

**Files:** `tools/pdf-extraction-bakeoff.mjs`, its test, and `benchmarks/pdf/extraction-bakeoff-report-v1.json`

- [ ] Add tests rejecting promotion-eligible or real-provider claims on the synthetic corpus.
- [ ] Run the focused Vitest and confirm RED.
- [ ] Add and validate the authority object without changing scores.
- [ ] Re-run the generator and tests; confirm deterministic GREEN output.

### Task 3: Require native-reader exact-artifact evidence

**Files:** `tools/pdf-benchmark-readiness.mjs`, its test, `benchmarks/pdf/benchmark-readiness-registry-v1.json`, and `docs/research/semantic-responsive-typesetting/fidelity-eval-set.md`

- [ ] Add negative tests for unavailable readers and Chromium/WebKit substitution, plus a shape-valid positive fixture.
- [ ] Run the focused Vitest and confirm RED.
- [ ] Extend registry parsing and readiness reasons with native-reader evidence.
- [ ] Record current readers as `unavailable-blocker`, document the distinction, and confirm GREEN while readiness stays false.

### Task 4: Integrated verification and review

- [ ] Run the three focused commands from the spec.
- [ ] Run `npm test`, `npm run build`, `scripts/agent-evidence`, and `git diff --check`.
- [ ] Obtain fresh independent exact-head review; fix every actionable finding and re-review changed scope.
- [ ] Push the issue branch, create a PR linked to #290, wait for required checks, and merge only if repository policy authorizes the exact head.

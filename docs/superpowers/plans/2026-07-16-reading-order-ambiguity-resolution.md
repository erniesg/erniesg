# Reading-order ambiguity resolution implementation plan

> **For agentic workers:** Execute inline with the test-driven-development and verification-before-completion workflows. Git metadata is read-only on the trusted VM, so leave all changes uncommitted for Rucksack to publish.

**Goal:** Resolve scholarly PDF region order only when at least 0.85 confidence is supported by independent geometric evidence, while retaining candidate edges and blocking diagnostics below that threshold.

**Architecture:** Keep `pdf-regions.ts` as the deterministic geometry boundary. Enrich its page layout result with a versioned resolution record, carry the record into accepted cross-column edges and reconstruction diagnostics, and leave the completeness gate unchanged so unresolved candidates still block export.

**Tech stack:** TypeScript, Vitest, PDF.js-derived normalized geometry.

## Global constraints

- Resolution policy version is `1.0.0`; minimum confidence is `0.85`.
- Deciding signals are column-gutter stability, font compatibility, indentation continuity, caption proximity, block adjacency, spanning boundaries, and separated footnote bands.
- Footnotes, captions, side material, and uncertain column flow must never be silently folded into body prose.
- Corpus evidence contains basenames, SHA-256 hashes, and ambiguity counts only.
- `scripts/agent-evidence` must remain byte-identical to `main`.

---

### Task 1: Synthetic ambiguity taxonomy

**Files:**

- Create: `tests/fixtures/reading-order-fixtures.ts`
- Create: `src/research/pdf-reading-order-resolver.test.ts`

**Interfaces:**

- Produce `scholarlyReadingOrderFixtures`, whose cases contain `name`, `ambiguityClass`, `pages`, `expectedNodeText`, and `expectedEvidence`.
- Consume `reconstructPageAnalyses()` and assert exact node text order, zero blocking `AMBIGUOUS_READING_ORDER` diagnostics for resolved cases, structured resolution evidence, and a blocking diagnostic for deliberately inconsistent geometry.

- [ ] Write fixtures for two-column body with a spanning float, single-column body with margin notes, mixed single/two-column pages, dense references, and a footnote band.
- [ ] Run `npm test -- src/research/pdf-reading-order-resolver.test.ts` and verify the five resolved cases fail because resolution diagnostics/evidence do not exist and sparse two-column cases remain ambiguous.

### Task 2: Evidence-scored deterministic resolver

**Files:**

- Modify: `src/research/import-types.ts`
- Modify: `src/research/pdf-regions.ts`
- Modify: `src/research/pdf-layout.ts`
- Modify: `tools/pdf-corpus-audit-safety.mjs`
- Modify: `src/research/pdf-layout.test.ts`

**Interfaces:**

- Add `PdfReadingOrderResolution` with `policyVersion`, `ambiguityClass`, `status`, `confidence`, `threshold`, `evidence`, and `regionIds`.
- Add `RESOLVED_READING_ORDER` informational diagnostics with one `regionId` and the deciding resolution record.
- Preserve `AMBIGUOUS_READING_ORDER` as an error whenever the score is below `0.85`.

- [ ] Preclassify geometrically subordinate margin notes before testing a column hypothesis.
- [ ] Score sparse column hypotheses from independent gutter, font, indentation, adjacency, caption, spanning, and note-band evidence.
- [ ] Accept only hypotheses at or above `0.85`; otherwise retain both candidate column edges.
- [ ] Attach the accepted evidence and confidence to cross-column edges and one informational diagnostic per resolved included region.
- [ ] Run `npm test -- src/research/pdf-reading-order-resolver.test.ts src/research/pdf-regions.test.ts src/research/pdf-layout.test.ts` and verify all focused tests pass.

### Task 3: Taxonomy and privacy-preserving evidence

**Files:**

- Create: `docs/research/semantic-responsive-typesetting/reading-order-ambiguity-taxonomy.md`

**Interfaces:**

- Document the five named layout classes, policy `1.0.0`, threshold `0.85`, deciding signals, fail-closed behavior, and intentional regression-fixture order change.
- Record before/after rows using only basename, SHA-256, and `AMBIGUOUS_READING_ORDER` count.

- [ ] Run `npm run --silent pdf:corpus-audit -- --report-only tests/fixtures/pdf public/research/if-letters-home-could-sing/if-letters-home-could-sing.pdf` and extract privacy-safe counts.
- [ ] Add the before/after table without paths, bytes, prose, titles, authors, or provenance.

### Task 4: Required validation

**Files:**

- Verify only; do not modify `scripts/agent-evidence`.

- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `npm run test:e2e -- tests/e2e/publication-importer.spec.ts`.
- [ ] Run `scripts/agent-evidence --all`.
- [ ] Run `git diff --check` and compare the evidence script hash with `main`.

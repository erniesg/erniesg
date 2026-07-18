# PDF Visual Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract source-backed scholarly visual objects and package them as complete EPUB assets with inspectable caption relationships.

**Architecture:** Extend the existing PDF reconstruction graph with content-addressed visual assets and deterministic association records. Reuse the current completeness gate and EPUB builder so unresolved candidates fail closed and matched objects render actual assets.

**Tech Stack:** TypeScript, PDF.js operator lists, Vitest, fflate, Astro, Playwright

## Global Constraints

- Preserve or render only bounded source regions; never substitute a full-paper screenshot.
- Do not infer LaTeX, diagram labels, or alt text beyond source text/caption evidence.
- Leave changes uncommitted because Rucksack owns publication on this provider branch.
- Do not modify `scripts/agent-evidence`.

---

### Task 1: Deterministic visual asset primitives

**Files:**

- Create: `src/research/visual-assets.ts`
- Create: `src/research/visual-assets.test.ts`
- Modify: `src/research/import-types.ts`

**Interfaces:**

- Produces: `createPngAsset`, `createSvgAsset`, `createSemanticTableAsset`, and content-addressed `PdfVisualAsset` records.

- [ ] Write failing tests proving decoded RGB pixels produce a stable PNG and source text produces escaped SVG/XHTML payloads.
- [ ] Run `npm test -- src/research/visual-assets.test.ts` and confirm failures are caused by missing APIs.
- [ ] Implement the minimal encoders, SHA-256 identities, source metadata, and validated table structure.
- [ ] Re-run the targeted test and confirm it passes.

### Task 2: Source object extraction and synthetic fixtures

**Files:**

- Modify: `src/research/pdf.ts`
- Modify: `tests/fixtures/pdf/generate-fixtures.mjs`
- Regenerate: `tests/fixtures/pdf/structured-scientific.pdf`
- Modify: `src/research/pdf.test.ts`

**Interfaces:**

- Consumes: visual-asset primitives from Task 1.
- Produces: raster/vector `PdfNativeObject` records with normalized source boxes and stable asset IDs.

- [ ] Change the structured-fixture test first to require two raster panels, a bounded vector object, and packaged asset payloads.
- [ ] Run the targeted PDF test and verify the new assertions fail against the current extractor.
- [ ] Extend operator-list traversal for decodable images and simple visible vector paths; update and regenerate the redistributable fixture.
- [ ] Re-run the targeted test and retain only source-safe extraction behavior.

### Task 3: Caption association and completeness

**Files:**

- Modify: `src/research/pdf-regions.ts`
- Modify: `src/research/pdf-layout.ts`
- Modify: `src/research/pdf-quality.ts`
- Modify: `src/research/schema.ts`
- Modify: `src/research/pdf-layout.test.ts`
- Modify: `src/research/pdf-quality.test.ts`

**Interfaces:**

- Produces: canonical visual nodes, `PdfVisualRelationship[]`, table/equation fallbacks, and source-object-aware completeness metrics.

- [ ] Add failing tests for unique figure/caption matching, multi-panel grouping, semantic-table validation, equation SVG fallback, and competing candidates.
- [ ] Run the targeted layout and quality tests and confirm the expected relationship/readiness failures.
- [ ] Implement deterministic candidate scoring and canonical relationships, preserving unresolved candidates for review.
- [ ] Update completeness counts to use selected source objects and actual payloads, then re-run targeted tests.

### Task 4: EPUB asset packaging

**Files:**

- Modify: `src/research/epub.ts`
- Modify: `src/research/epub.test.ts`
- Modify: `src/research/pdf.test.ts`

**Interfaces:**

- Consumes: ready `PdfReconstruction.assets` and matched canonical visual relationships.
- Produces: OPF asset items, real XHTML references, export-manifest provenance, and dangling-reference validation.

- [ ] Add failing EPUB assertions for packaged asset entries, OPF items, semantic table/figure/equation markup, stable hashes, and absence of placeholders.
- [ ] Run the targeted EPUB/PDF tests and verify they fail on current placeholder output.
- [ ] Implement asset-aware XHTML, OPF, archive assembly, and archive reference checks.
- [ ] Re-run targeted tests and confirm incomplete reconstructions remain blocked.

### Task 5: End-to-end and repository evidence

**Files:**

- Modify: `tests/e2e/publication-importer.spec.ts`

**Interfaces:**

- Verifies the browser-local PDF-to-EPUB path as a complete user-visible workflow.

- [ ] Change the scientific fixture scenario to require `EPUB ready`, a download, real asset coverage, and no completeness error.
- [ ] Run `npm run test:e2e -- tests/e2e/publication-importer.spec.ts` and fix only defects exposed by the accepted design.
- [ ] Run `npm test`, `npm run build`, `git diff --check`, and the available secret scan.
- [ ] Run `scripts/agent-evidence --all`, inspect its manifest, verify `scripts/agent-evidence` is unchanged, and leave all implementation changes uncommitted.

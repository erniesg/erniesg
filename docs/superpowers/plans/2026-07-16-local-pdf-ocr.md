# Local PDF OCR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This Rucksack provider branch has read-only Git metadata, so commit steps are intentionally omitted.

**Goal:** Add an offline, bbox-preserving OCR path for scanned, mixed, rotated, multilingual, and physical two-page PDF scans while keeping uncertain reconstruction review-blocking.

**Architecture:** Keep PDF.js responsible for local PDF parsing and bounded page rasterization. Add a focused OCR domain module for evidence-based page classification, OCR/embedded-text merging, spread detection, provenance, and review diagnostics; load a pinned Tesseract.js worker and its English model from same-origin build assets only when a page needs OCR. Preserve the existing no-OCR API behavior as a fail-closed configuration.

**Tech Stack:** TypeScript, PDF.js 5.4.624, Tesseract.js 6.0.1, Astro/Vite, Vitest, Playwright.

## Global Constraints

- OCR receives at most a bounded 3.2-megapixel raster per page and processes one page at a time.
- OCR document bytes, text, paths, and model requests never leave the browser origin and never enter telemetry.
- OCR engine, engine version, model version, language mode, language codes, source PDF SHA-256, page rotation, raster SHA-256, word boxes, line boxes, and confidence remain inspectable evidence.
- Automatic language selection falls back explicitly to English (`eng`) and never translates content; unsupported explicit languages fail closed.
- OCR confidence below 0.75, uncertain spread boundaries, and mixed-page text conflicts block export.
- The existing `scripts/agent-evidence` file must remain byte-identical and unmodified.

---

### Task 1: OCR evidence contract, classification, merging, and spread detection

**Files:**

- Create: `src/research/pdf-ocr.ts`
- Create: `src/research/pdf-ocr.test.ts`
- Modify: `src/research/import-types.ts`
- Modify: `src/research/pdf-quality.ts`
- Modify: `src/research/pdf-layout.ts`

**Interfaces:**

- Produces `classifyPdfPage(page)`, `mergeOcrPage(page, result)`, and `detectPhysicalSpread(page)`.
- Produces `PdfOcrSession`, `PdfOcrOptions`, `PdfOcrPageEvidence`, `PdfPageClassification`, and `PdfPhysicalSpread` types consumed by PDF ingestion.

- [x] Write table-driven failing tests that distinguish `textless`, `sparse-text`, `mixed`, `image-only`, and `born-digital` from text-run count, normalized text area, image coverage, and page geometry rather than one character threshold.
- [x] Write failing tests that normalize OCR word and line pixel boxes, retain embedded runs on overlap, remove exact OCR duplicates, report conflicting overlap, and retain both embedded-link evidence and non-overlapping OCR text.
- [x] Write failing tests for confident wide-page splitting, uncertain center boundaries, low-confidence review, explicit languages, and the documented automatic `eng` fallback.
- [x] Add the minimum types and pure implementation to pass those tests. Mark OCR-consumed scan surfaces separately from semantic image objects so a successful scan is not rejected as a missing figure.
- [x] Update completeness and reconstruction diagnostics so unresolved OCR, low confidence, uncertain spreads, and mixed conflicts block, while accepted OCR clears the prior `OCR_REQUIRED` page gate.
- [x] Run `npx vitest run src/research/pdf-ocr.test.ts src/research/pdf-quality.test.ts src/research/pdf-layout.test.ts` and require all tests to pass.

### Task 2: PDF.js integration, bounded rasterization, cancellation, and links

**Files:**

- Modify: `src/research/pdf.ts`
- Modify: `src/research/pdf.test.ts`

**Interfaces:**

- Consumes `PdfOcrOptions.createSession`, whose session recognizes one `PdfOcrRaster` at a time and exposes `terminate()`.
- Produces the existing `reconstructPdf(file, onProgress, options)` result with optional OCR evidence and unchanged no-OCR behavior.

- [x] Add failing integration tests with a deterministic fake OCR session proving a textless page proceeds through OCR, a mixed page merges without duplicate embedded text or lost links, a rotated page retains rotation, and no OCR configuration still fails closed.
- [x] Add failing cancellation tests proving abort terminates the OCR session, destroys the PDF.js document, and releases each page/raster before rejecting with `IMPORT_CANCELLED`.
- [x] Extract link annotations without following them, rasterize only OCR candidates to PNG at no more than 3.2 megapixels, hash each raster, run one page at a time, emit OCR progress, and terminate the session in `finally`.
- [x] Keep the OCR session lazy: do not create it unless classification finds an OCR candidate.
- [x] Run `npx vitest run src/research/pdf.test.ts src/research/pdf-ocr.test.ts` and require all tests to pass.

### Task 3: Same-origin Tesseract worker and language selection UI

**Files:**

- Create: `src/research/pdf-ocr-browser.ts`
- Create: `src/research/pdf-ocr-browser.test.ts`
- Modify: `src/components/research/PublicationImporter.tsx`
- Modify: `astro.config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Produces `createBrowserOcrSession({ languages, languageMode, onProgress })` implementing `PdfOcrSession`.
- The importer passes `languageMode: 'automatic-fallback'` with `['eng']` or explicit `['eng']` and imports the browser engine only after OCR is required.

- [x] Add failing unit tests that reject unsupported languages before worker creation, verify engine/model version metadata, and verify every configured worker/core/model URL is same-origin.
- [x] Pin `tesseract.js@6.0.1` and `@tesseract.js-data/eng@1.0.0`; expose only the LSTM SIMD/non-SIMD cores, worker script, and `eng.traineddata.gz` as stable same-origin OCR assets.
- [x] Convert Tesseract word/line output to the repository OCR contract, pass `blocks: true`, keep confidence unchanged except for `[0,1]` normalization, and make termination idempotent.
- [x] Add an Auto (English fallback) / English selector and concise offline-language copy to the importer; keep export disabled when review diagnostics remain.
- [x] Run `npx vitest run src/research/pdf-ocr-browser.test.ts src/research/pdf.test.ts` and `npm run build` and require both to pass.

### Task 4: Synthetic fixtures, privacy, and browser workflow

**Files:**

- Modify: `tests/fixtures/pdf/generate-fixtures.mjs`
- Modify: `tests/fixtures/pdf/manifest.json`
- Modify: `tests/fixtures/pdf/README.md`
- Create: `tests/fixtures/pdf/rotated-scan.pdf`
- Create: `tests/fixtures/pdf/multilingual-scan.pdf`
- Modify: `tests/fixtures/pdf/scanned-page.pdf`
- Modify: `tests/fixtures/pdf/mixed-page.pdf`
- Modify: `tests/fixtures/pdf/two-page-scan.pdf`
- Modify: `tests/e2e/publication-importer.spec.ts`
- Create: `docs/adr/008-local-bbox-ocr.md`

**Interfaces:**

- Fixtures remain deterministic, repository-owned, CC0 synthetic documents.
- Browser tests exercise the same importer options used by operators.

- [x] Upgrade the generated scan fixtures to contain deterministic raster text; make the spread one wide physical PDF page with left/right logical content and add rotated and multilingual cases.
- [x] Add integration coverage for scan OCR, rotation, multilingual preservation through a deterministic explicit-language session, physical-page provenance, cancellation cleanup, and no-OCR failure.
- [x] Add an E2E test that rejects every non-origin request while a scanned fixture reaches an OCR result or explicit review state with engine provenance and without `OCR_REQUIRED`.
- [x] Document pinned versions, Apache/MIT licensing, lazy asset sizes, the 3.2-megapixel limit, the explicit `eng` fallback, how future integrity-pinned local language packs are added, and why low-confidence/conflicting output blocks export.
- [ ] Run `npm run test:e2e -- tests/e2e/publication-importer.spec.ts` and require all importer tests to pass.

  Provider note: attempted directly and through `scripts/agent-evidence --all`; Astro reported ready on `127.0.0.1:1234`, but Playwright timed out after 120 seconds waiting for the loopback web server before executing tests.

### Task 5: Full repository validation and handoff

**Files:**

- Verify only; do not modify `scripts/agent-evidence`.

- [x] Run `npm test` and require exit 0.
- [x] Run `npm run build` and require exit 0.
- [ ] Run `npm run test:e2e -- tests/e2e/publication-importer.spec.ts` and require exit 0.
- [x] Run `infra/vm/verify.sh`; record container/service caveats without changing infrastructure.
- [x] Run `scripts/agent-evidence --all` and require required lanes to pass, or report exact environment blockers from its exit taxonomy.
- [x] Run `git diff --check`, `git status --short`, and `sha256sum scripts/agent-evidence`; confirm the evidence script hash remains `657013f8ed0bc22d8c7c8c9d56fa7f1a715f3246a7f68ecb9cb8105a9ea8e164`.
- [x] Leave all provider-branch changes uncommitted and summarize code, tests, evidence manifest, and any VM-only caveats.

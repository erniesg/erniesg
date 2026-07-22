# Headless PDF-to-EPUB CLI and corpus acceptance benchmark

depends-on: 015,016

## Provider

vm-codex

## Goal

Provide one local command that turns a PDF file into device-profile EPUB artifacts on disk, plus a corpus benchmark that reports pass-rate and bucketed failure reasons, so progress toward "any scholarly PDF becomes a device-ready EPUB" is measurable and reproducible outside the browser studio.

## Acceptance tests

- `npm run pdf:export -- <pdf-or-directory> --target paperPro --target paperProMove --out <dir>` runs the same import, completeness-gate, composition, and EPUB modules the studio uses (shared code, no forked logic) and writes the `.epub` files, per-document export manifests, and SHA-256 checksums.
- In strict publication mode, a gate-failing document produces a non-zero exit
  with its corpus-audit readiness report and writes no EPUB. The explicit
  `--readable-fallback` review mode may instead write a provenance-projected
  EPUB and exit non-zero after labelling it `review-required`; it includes only
  relationships and assets that pass the same strict validator, records every
  excluded source relationship/object in its manifest, and rejects dangling
  canonical targets. A review artifact is never reported as publication-ready
  or silently promoted to the strict result.
- The corpus benchmark aggregates a machine-readable report over a local directory of PDFs: ready/review-required/failed counts, pass-rate, and failure reasons bucketed by gate code, following the privacy rules of `docs/schemas/pdf-corpus-audit.schema.json`. It retains exact per-code counts and deterministic redacted samples bounded to three per code and 64 per document with an explicit truncation count; it emits no document text or paths.
- All born-digital test fixtures export valid EPUBs for both device targets, verified by `inspectEpub` and the structural invariants; scanned fixtures fail closed with `OCR_REQUIRED` when the OCR configuration is absent.
- If a local Java runtime is present, exported EPUBs pass EPUBCheck; otherwise EPUBCheck is recorded as skipped in the report and the documented structural checks stand in. No runtime, validator, or document may be fetched from the network. The comparator validates baseline-matched and candidate-only documents: an added failed or review-required document fails promotion, and an added ready document must carry every artifact target checked by the baseline corpus, so a newly added failure or missing EPUB cannot be ignored.
- Repeated runs over the same inputs are byte-identical, including the benchmark report apart from documented fields. Strict repeatability compares artifact bytes and recomputed structural receipts for canonical node order/content, inline/list semantics, citation/note/visual relationships, assets, and the exact line-transition ledger; matching aggregate counters alone is insufficient.
- Cross-parser or cross-model comparisons use frozen corpus identity plus human-approved bounded decisions and directional non-regression rather than byte identity. A candidate run may not appoint its own output as an accepted baseline; private comparisons require the full sanitized baseline-receipt SHA-256 to be recorded independently and supplied separately from the baseline file.
- Evidence includes a demo transcript: one fixture PDF converted to `publication-paperpro.epub` and `publication-papermove.epub` with file sizes and checksums.

## Validation command

```bash
npm test
npm run build
npm run test:e2e -- tests/e2e/publication-importer.spec.ts
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None. The CLI must run fully offline; document bytes, text, and local paths must not be uploaded or logged.

## Artifact outputs

Headless export CLI, corpus benchmark reporter, fixture EPUB evidence with checksums, EPUBCheck integration or documented skip, and reproducibility notes.

## Stop conditions

Stop before duplicating studio pipeline logic into the CLI, committing corpus documents or generated EPUBs from private PDFs, adding hosted validation services, or downloading validators/runtimes at execution time.

## Human clarification protocol

If bundling or invoking EPUBCheck raises a licensing, size, or runtime-availability trade-off, present the smallest viable options with measured costs.

## Recommended response

Reuse `tools/pdf-corpus-audit.mjs`'s Vite SSR loading pattern so the CLI and the studio import identical modules, and make the benchmark report the single source of truth for corpus progress.

## Trade-offs

A CLI wrapping browser-oriented modules through Vite SSR is slower than a native pipeline but guarantees the studio and headless paths cannot drift.

## Free-form response

The owner's acceptance corpus is a local folder of arXiv PDFs; the benchmark exists so each pipeline improvement reports a concrete pass-rate delta instead of anecdotes.

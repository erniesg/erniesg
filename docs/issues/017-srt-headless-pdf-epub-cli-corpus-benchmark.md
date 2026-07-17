# Headless PDF-to-EPUB CLI and corpus acceptance benchmark

depends-on: 015,016

## Provider

vm-codex

## Goal

Provide one local command that turns a PDF file into device-profile EPUB artifacts on disk, plus a corpus benchmark that reports pass-rate and bucketed failure reasons, so progress toward "any scholarly PDF becomes a device-ready EPUB" is measurable and reproducible outside the browser studio.

## Acceptance tests

- `npm run pdf:export -- <pdf-or-directory> --target paperPro --target paperProMove --out <dir>` runs the same import, completeness-gate, composition, and EPUB modules the studio uses (shared code, no forked logic) and writes the `.epub` files, per-document export manifests, and SHA-256 checksums.
- A gate-failing document produces a non-zero exit with the corpus-audit readiness report for that document; no partial EPUB is written.
- The corpus benchmark aggregates a machine-readable report over a local directory of PDFs: ready/review-required/failed counts, pass-rate, and failure reasons bucketed by gate code, following the privacy rules of `docs/schemas/pdf-corpus-audit.schema.json` (basenames, hashes, and metrics only; no document text or paths).
- All born-digital test fixtures export valid EPUBs for both device targets, verified by `inspectEpub` and the structural invariants; scanned fixtures fail closed with `OCR_REQUIRED` when the OCR configuration is absent.
- If a local Java runtime is present, exported EPUBs pass EPUBCheck; otherwise EPUBCheck is recorded as skipped in the report and the documented structural checks stand in. No runtime, validator, or document may be fetched from the network.
- Repeated runs over the same inputs are byte-identical, including the benchmark report apart from documented fields.
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

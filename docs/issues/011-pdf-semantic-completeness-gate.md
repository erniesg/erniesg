# Fail closed on incomplete PDF reconstruction and add a corpus quality gate

## Provider

vm-codex

## Goal

Replace the current text-present equals EPUB-ready decision with a measurable semantic-completeness gate and a repeatable local corpus audit. A PDF must not be reported as successfully reconstructed when figures, captions, footnotes, reading order, or substantial text were silently lost.

## Acceptance tests

- Add repo-owned synthetic PDF fixtures covering two columns, a spanning block, a figure/caption pair, a table, an equation fallback, footnote references and notes, a scanned page, a mixed page, a two-page scan, and an oversized input.
- Do not copy or commit private, downloaded, subscription, or ambiguously licensed PDFs. A local corpus command may read operator-supplied files but records only stable basenames, hashes, metrics, and diagnostics.
- Measure ordered, provenance-scoped source/output text coverage; duplicate canonical spans; exact decided/unresolved source-line transitions; source/exported asset coverage; citation/note/visual relationship coverage; unresolved object counts; OCR-required pages; and reading-order diagnostics. An unordered document-wide character multiset cannot satisfy text conservation.
- The line ledger contains exactly one unique decision for every adjacent source-line transition inside each region and validates page/region membership plus unresolved totals. Missing, duplicate, extra, cross-region, or unresolved corrupting entries block readiness.
- A detected citation counts as resolved only when its source-backed inline run targets canonical bibliography-entry node IDs. Reclassification preserves the obligation; unmatched targets remain blocking.
- `EPUB ready` is emitted only when all error-severity diagnostics are cleared and configured completeness thresholds pass.
- Image-bearing or caption-bearing inputs with zero reconstructed objects fail closed instead of silently exporting text-only output. Missing diagram components, orphan captions, and nonsemantic/nonuniform tables without a real bounded page crop remain review-required; a text-derived or synthetic table image cannot be reported as an exact crop.
- The resource limit reports a specific bounded diagnostic and cleans up work after cancellation or rejection.
- The current fellowship PDF and generated born-digital fixture remain covered as non-private local evidence.

## Validation command

```bash
npm test
npm run build
npm run test:e2e -- tests/e2e/publication-importer.spec.ts
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None. Local corpus paths and document bytes must not enter logs, committed fixtures, issue comments, or evidence bundles.

## Artifact outputs

Completeness metrics, fail-closed readiness policy, synthetic fixtures, corpus-audit command/report schema, focused browser tests, and an ADR defining success versus review-required output.

## Stop conditions

Stop before committing third-party PDFs, uploading local documents, relaxing a completeness failure to a warning, or choosing quality thresholds without recording their evidence and false-positive trade-offs.

## Human clarification protocol

If a redistributable fixture cannot represent an observed failure, describe the minimal synthetic reproduction and ask only whether a specifically identified public document may be pinned as evidence.

## Recommended response

Build the quality gate before adding more extraction features so every later issue can turn a measured failure into a passing regression rather than expanding false success.

## Trade-offs

Failing closed reduces the number of immediately downloadable EPUBs, but prevents corrupted scholarly output from being presented as complete.

## Free-form response

Observed local audit baseline: 71 PDFs and 2,098 pages; 59 image-bearing exports lost every image, 68 caption-signal documents produced zero semantic captions, and median text-character coverage was approximately 84 percent.

# Resolve ambiguous reading-order regions on real scholarly PDFs

depends-on: 012

## Goal

Reduce blocking `AMBIGUOUS_READING_ORDER` diagnostics on born-digital scholarly PDFs by resolving region order where geometric evidence is decisive, while keeping genuinely ambiguous regions fail-closed. Real arXiv papers currently produce 6–37 blocking ambiguities per document, which keeps the completeness gate closed even when text recovery exceeds 99%.

## Provider

vm-codex

## Acceptance tests

- Classify the current ambiguity causes into named classes using synthetic fixtures that reproduce common scholarly layouts: two-column body with spanning floats, single-column with margin notes, mixed single/two-column pages, dense reference sections, and footnote bands.
- Resolve classes where geometric evidence is decisive — column gutters, font metrics, indentation continuity, caption proximity, and block adjacency — and record the deciding evidence and confidence in the diagnostics for every resolved region.
- Regions below the documented confidence threshold remain blocking diagnostics; no region order is ever guessed silently.
- For each resolved class, a synthetic fixture that previously emitted `AMBIGUOUS_READING_ORDER` now composes with zero blocking reading-order diagnostics, and the resulting node order is asserted node-by-node in tests.
- Existing fixtures show no reading-order regressions; any intentional order change is listed with its evidence.
- A privacy-preserving before/after ambiguity count from `npm run pdf:corpus-audit` on locally supplied PDFs is included in evidence (basenames, hashes, and counts only).

## Validation command

```bash
npm test
npm run build
npm run test:e2e -- tests/e2e/publication-importer.spec.ts
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None. All analysis runs locally; document bytes and prose must not enter reports or telemetry.

## Artifact outputs

Region-order resolver with evidence-recording diagnostics, ambiguity taxonomy document, synthetic regression fixtures, and before/after corpus metrics.

## Stop conditions

Stop before accepting uncertain order silently, reordering footnotes or captions into body prose, deleting content to avoid ambiguity, or tuning thresholds against private corpus documents committed to the repository.

## Human clarification protocol

If a layout class cannot be resolved without a policy choice (for example reading floats before or after the interrupting column), present the candidate orders with rendered evidence and request a decision.

## Recommended response

Prefer explainable geometric rules with recorded evidence over statistical ordering; every resolution must be inspectable in the diagnostics.

## Trade-offs

Aggressive resolution raises corpus pass-rate but risks wrong reading order, which is worse than a blocked export; the confidence threshold trades coverage for correctness and must stay documented and versioned.

## Free-form response

This is the primary blocker for real-paper pass-rate after asset extraction lands: sampled arXiv papers fail on reading-order ambiguity more than on any other text-side gate.

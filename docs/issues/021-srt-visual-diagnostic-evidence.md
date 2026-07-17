# Visual diagnostic evidence for imports, corpus audits, and PRs

depends-on: 013

## Provider

vm-codex

## Goal

Make every blocking diagnostic humanly inspectable: render page rasters with the diagnostic's source boxes overlaid — note reference markers linked to their candidate note bodies with scores and evidence, ambiguous reading-order regions with the competing orders drawn — in the browser studio, and emit the same renders as static evidence artifacts so every SRT pull request carries before/after visual proof of what its change did instead of a sealed-bundle hash and a text log.

## Acceptance tests

- The studio importer shows a per-page inspector for a blocked document: the rendered page with color-coded boxes per diagnostic category, and selecting a diagnostic in the existing list highlights its source boxes; selecting a note-relationship diagnostic draws the reference marker, every candidate note body, and each candidate's score and evidence strings from the existing relationship data in `src/research/import-types.ts`.
- Ambiguous reading-order pages render both candidate orders as numbered region sequences so a human can see exactly which two orders the geometry could not separate.
- A local command renders the same overlays headlessly for the committed synthetic fixtures under `tests/fixtures/pdf/` and writes deterministic PNG or self-contained HTML artifacts into the `.agent/evidence` output alongside the existing lanes in `scripts/agent-evidence`; repeated runs are byte-identical apart from documented fields.
- The corpus audit gains an opt-in overlay output for locally supplied PDFs that writes renders only to a local directory the caller names, never into the repository, and the machine-readable report still contains basenames, hashes, and counts only.
- Evidence for any SRT rule change includes before/after overlay renders of at least one fixture the change affects, and the evidence README names which fixture, rule, and diagnostic each image demonstrates so a reviewer can trace what produced what.
- New files to add: an overlay renderer module and test under `src/research/`, a headless evidence tool under `tools/`, and studio inspector wiring in `src/components/research/PublicationImporter.tsx`; the diagnostic text list remains for accessibility.

## Validation command

```bash
npm test
npm run build
npm run test:e2e -- tests/e2e/publication-importer.spec.ts
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None. Rendering runs locally; private document rasters and text must never be committed, uploaded, or logged.

## Artifact outputs

Studio diagnostic inspector with box overlays, headless fixture-overlay evidence tool wired into the evidence lanes, opt-in local corpus overlay output, and documented before/after evidence conventions for SRT PRs.

## Stop conditions

Stop before committing rasters of non-fixture documents, adding a hosted rendering service, replacing the accessible diagnostic list with canvas-only output, or letting overlay rendering block or slow the import path itself.

## Human clarification protocol

If rendering fidelity forces a trade-off (canvas raster size versus repository weight for committed evidence), present measured sizes for the smallest viable options.

## Recommended response

Reuse the pdfjs page rendering the importer already performs and the normalized source boxes every diagnostic already carries; this issue is presentation and evidence plumbing, not new analysis.

## Trade-offs

Committed image evidence grows the repository and can go stale against rule changes; keeping committed renders fixture-only and regenerating them in the evidence lane bounds the weight while private-corpus renders stay local-only.

## Free-form response

The owner reviews rucksack PRs whose bodies currently contain only a sealed-bundle identifier, and the corpus audit emits thousands of note diagnostics no human can adjudicate from text alone; visual evidence is the precondition for the human feedback loop and for trusting any auto-resolved diagnostic later.

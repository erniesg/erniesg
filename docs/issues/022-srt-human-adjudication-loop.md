# Human adjudication loop for blocked imports

depends-on: 021

## Provider

vm-codex

## Goal

Let a human resolve what the deterministic gate correctly refuses to guess: from the visual inspector, accept a note-match candidate, reclassify a marker as a citation, choose a reading-order candidate, or dismiss a diagnostic — each decision persisted as a local, replayable decision record that re-applies deterministically on re-import, clears the specific blocker it addresses, and appears in export provenance, so a paper with a handful of genuine ambiguities becomes exportable through minutes of review instead of staying blocked forever.

## Acceptance tests

- Each blocking diagnostic rendered by the issue-021 inspector offers its legal resolutions: note relationships accept one candidate or reclassification to citation or plain text; ambiguous reading-order pages accept one of the rendered candidate orders; every decision captures the diagnostic code, the stable region and marker identifiers, and the chosen resolution.
- Decisions persist as a sidecar decision file keyed by the document's SHA-256 and schema version, exportable and importable as JSON from the studio; no document text or rasters enter the decision file.
- Re-importing the same bytes with the decision file applies every decision deterministically before the completeness gate runs: resolved diagnostics no longer block, unresolved ones still do, and a decision whose target identifiers no longer match (after a rule change) is reported as stale instead of silently dropped or misapplied.
- Applied decisions appear in reconstruction provenance and the export manifest as human adjudications with counts per diagnostic code, so an EPUB produced with human decisions is distinguishable from one that passed the gate unaided.
- A decision can never widen scope: it resolves exactly the identified diagnostic, cannot alter thresholds, and cannot suppress a diagnostic category globally.
- E2e coverage: a fixture blocked by an ambiguous note match and an ambiguous reading order is adjudicated in the studio, exports its EPUB, and the decision file replays headlessly to the same EPUB bytes. New files to add: a decision-record module and tests under `src/research/`, and studio adjudication wiring in `src/components/research/PublicationImporter.tsx`.

## Validation command

```bash
npm test
npm run build
npm run test:e2e -- tests/e2e/publication-importer.spec.ts
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None. Decisions and documents stay local; decision files contain identifiers, codes, and choices only.

## Artifact outputs

Decision record schema and applier, studio adjudication controls, stale-decision diagnostics, provenance and manifest integration, and replay determinism evidence.

## Stop conditions

Stop before letting decisions modify gate thresholds or apply across documents, auto-generating decisions from any model in this issue, storing document content in decision files, or accepting decisions without stable-identifier verification.

## Human clarification protocol

If stable identifiers cannot survive a planned rule change (region ids shifting under the issue-016 resolver), propose the smallest identifier scheme that stays stable across re-imports of identical bytes and report its collision behavior.

## Recommended response

Model the decision file on the same evidence-and-provenance contract the pipeline already uses; the applier should run as a pre-gate pass that rewrites relationship or order state exactly as if the analyzer had resolved it, leaving every downstream invariant untouched.

## Trade-offs

Per-document human decisions do not generalize — the same ambiguity in the next paper needs its own click; that is intentional, since generalization belongs in rule improvements like issue 018, and the decision corpus itself becomes the evidence for which rules to improve next. A model-assisted proposer that pre-fills suggested resolutions for human confirmation is a deliberate follow-on, not part of this issue; the evaluation schema already reserves provider, model-version, and cost fields for it.

## Free-form response

The corpus audit produces diagnostics at a volume no human can review as text, but per real document the genuine ambiguities after issues 016 and 018 land should number in the tens; this loop is what turns fail-closed from a dead end into a review workflow, and the decision records double as ground truth for evaluating future auto-resolution.

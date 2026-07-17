# Resolve note-reference relationships on real scholarly PDFs at corpus scale

depends-on: 012,016

## Provider

vm-codex

## Goal

Eliminate the dominant completeness-gate blockers on real papers — `UNRESOLVED_NOTE_REFERENCE`, `AMBIGUOUS_NOTE_MATCH`, and `UNREFERENCED_NOTE`, which together produce roughly 9,900 blocking errors across a 72-document corpus audit (about 96 unresolved references per document) — by first classifying what the note detector currently treats as note references on real scholarly pages, then reclassifying or resolving the classes where evidence is decisive while keeping genuine ambiguity fail-closed.

## Acceptance tests

- Build synthetic fixtures reproducing the marker patterns real papers contain: bracketed numeric citations in running prose, superscript citation clusters, author-affiliation superscripts on title pages, equation and section number references, per-page footnote bands, and end-of-document endnote or reference sections; classify every current note-reference detection on these fixtures into a named taxonomy recorded in the diagnostics.
- Markers that are bibliography citations rather than note references (evidence: a detected reference-list section, bracket syntax, citation-marker density, absence of any footnote band) are reclassified as citation semantics or plain text with recorded deciding evidence, and stop emitting note diagnostics entirely.
- True footnote references resolve to their note bodies across the common scholarly layouts (same-page footnote band, endnote section) with the existing confidence scoring; matcher improvements record their evidence per relationship, and no relationship is ever accepted silently below the documented threshold.
- `UNREFERENCED_NOTE` no longer fires for note bodies whose reference was reclassified as a citation, and still fires for genuinely orphaned notes.
- Fixtures that previously emitted `UNRESOLVED_NOTE_REFERENCE` or `AMBIGUOUS_NOTE_MATCH` now compose with zero blocking note diagnostics, with node-by-node order and relationship assertions in tests; genuinely ambiguous fixtures remain blocked.
- Existing note fixtures from the issue-012 work show no regressions; any intentional relationship change is listed with its evidence.
- A privacy-preserving before/after count of note diagnostics from `npm run pdf:corpus-audit` on locally supplied PDFs is included in evidence (basenames, hashes, and counts only).

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

Marker taxonomy with evidence-recording classifier, citation-versus-note reclassification in `src/research/pdf-layout.ts` and `src/research/pdf-quality.ts`, synthetic regression fixtures, and before/after corpus metrics.

## Stop conditions

Stop before accepting uncertain note matches silently, deleting detected markers to reduce counts, weakening the completeness thresholds, or tuning against private corpus documents committed to the repository.

## Human clarification protocol

If citation semantics need a policy decision (for example whether reclassified citations should become structured citation nodes now or plain text with provenance until a citation model exists), present the smallest candidate options with their observable differences.

## Recommended response

Treat this as detector precision before matcher recall: most of the corpus errors are citation markers mis-scoped as note references, so reclassification with recorded evidence should remove the bulk of the blockers without loosening any matching threshold.

## Trade-offs

Aggressive reclassification raises pass-rate but risks silently downgrading a real footnote reference to plain text, losing its relationship; the classifier must therefore record evidence per marker and leave low-confidence markers blocking, trading some coverage for inspectable correctness.

## Free-form response

The corpus audit shows note diagnostics outnumber reading-order ambiguities by more than an order of magnitude (6,882 unresolved references and 2,184 ambiguous matches versus 215 reading-order errors), so this issue, not reading order, decides whether real arXiv papers ever pass the gate.

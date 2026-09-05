# Define reader-facing PDF-to-EPUB success criteria and score every diverse corpus run against them

depends-on: 037,042,043,044

## Provider

vm-codex

## Goal

Make "PDF to EPUB works" a measurable statement. The pipeline already emits
more than sixty diagnostic codes and a fail-closed publication gate, but the
only number anyone reads is the binary `ready` count, which has been zero on
every corpus run since July. Nothing reports how close each paper is on the
things a reader notices: whether the prose reads continuously, whether every
figure arrived with its caption, whether footnotes and links resolve, whether
running heads and journal names stayed out of the text. This spec names those
criteria, binds each to existing diagnostic and completeness counters, and
requires a per-criterion, per-stratum scorecard on a corpus that is diverse by
construction, so a regression on one criterion or one layout family is visible
in one table.

## Observed failure

- On 2026-09-04 the default branch crashed on 61 of 94 corpus PDFs with
  `Cannot replay source line boundaries for partial PDF region …`, and the
  corpus audit reported each as a generic `AUDIT_FAILED` with the cause
  suppressed. The regression landed on 2026-08-01 (listing lines were removed
  from the line-boundary ledger) and stayed invisible for five weeks because
  CI runs fixture tests only; real papers are audited owner-locally and no
  run had been made since.
- The frozen and seeded-random corpus lanes contain arXiv LaTeX papers only.
  No publisher PDF with running heads, no OJS/Word-processor PDF, and no
  scanned chapter is in any lane, so the furniture and OCR criteria have never
  been exercised on the inputs that produce them.
- `review-required` hides every gradient. Two papers that differ by one
  unresolved hyperlink versus forty scrambled paragraphs get the same label.

## Success criteria

Each criterion names what a reader notices, the existing evidence that decides
it, when it applies, and the degenerate-answer guard. A document passes a
criterion only when every listed blocker is absent; the criterion is
not applicable when the source carries no such objects, so silence never
scores a pass.

1. **Reconstruction completes.** No crash, parse failure, timeout, or stall.
   A crashed document fails every other criterion; it is never dropped from a
   denominator.
2. **Text is continuous and flows naturally.** Text coverage at least 0.98,
   zero missing source regions, zero unresolved corrupting joins, zero
   reading-order diagnostics, complete line-boundary and semantic-flow
   ledgers, no isolated glyphs, no low-confidence blocks, no sanitization
   loss. Guard: coverage alone never passes; the order, join, and ledger
   counters must all be clean.
3. **Every figure and diagram is extracted and owns its caption.** Asset
   coverage 1, zero unresolved visual objects, zero unreferenced assets, zero
   ambiguous visual matches, zero unresolved captions. Applies when the
   source has at least one asset.
4. **Footnotes and endnotes are extracted and linked both ways.** Zero
   unresolved or ambiguous note references, zero unreferenced notes, zero
   dangling note links. Applies when note markers were classified or note
   objects exist.
5. **Formatting and structure are kept.** Inline-style coverage 1, semantic
   table coverage 1 where tables exist, zero unresolved equations,
   preformatted blocks, algorithm blocks, or front matter. Guard: a bounded
   crop of a table or formula is loss-preserving fallback, not structure.
6. **Hyperlinks, citations, and cross-references resolve.** Hyperlink
   coverage 1, relationship coverage 1, zero unresolved or unmapped citation
   and cross-reference anchors, zero dangling internal EPUB links. Applies
   when the source carries link annotations or scholarly relationships.
7. **Page furniture stays out of the flow.** Zero furniture contamination and
   zero furniture review obligations, and the pipeline must have accounted
   for at least one excluded run on any document longer than two pages.
   Guard: a pipeline that never classifies furniture cannot pass by silence.
8. **Scanned pages are recovered.** Zero OCR-required pages remain. Applies to
   scanned inputs and to any document that reported OCR obligations.
9. **Publication gate.** The existing fail-closed `ready` verdict, reported
   last and never instead of the eight criteria above.

## Corpus diversity

The scorecard is only meaningful on a corpus that is diverse by construction.
The run must report, per stratum and with every document in every
denominator:

- layout: one-column and two-column, each with at least ten documents;
- source family: LaTeX/arXiv, publisher-typeset (Springer, Elsevier, IEEE
  and similar, which carry running heads and journal names), word-processor
  exports (OJS, Word, Google Docs), and scanned or print-captured pages, each
  with at least three documents;
- content: at least five documents each with tables, display equations,
  code or algorithm listings, footnotes, and more than ten figures.

Strata labels come from a manifest keyed by basename, derived from the source
PDF (producer string, layout gap share, text density), never from pipeline
output. Source PDFs stay owner-local; the manifest and scorecard carry
basenames, hashes, counts, and diagnostic codes only.

## Extraction path under evaluation

Two paths produce reports in the same document shape and are scored by the
same tool:

- the deterministic reconstruction in `src/research` (corpus audit), and
- the Docling-based extraction adapter in `tools/docling-struct`, which emits
  a StructDocument and renders only through `@erniesg/struct` (ADR-0001:
  the app extracts, struct renders). Its evaluator derives expectations
  from the source PDF (caption labels, link annotations, repeated margin
  lines), never from its own output.

Whichever path scores higher per criterion on the diverse corpus is the
one to keep investing in; the scorecard is the arbiter, not the
architecture.

## Acceptance tests

- `node tools/pdf-success-scorecard.mjs <corpus-audit.json>... --strata <manifest> --markdown`
  prints one table with the nine criteria as rows (applicable, passed, pass
  rate, top blockers) and one table per stratum key, from the existing
  corpus-audit report schema, with no new pipeline run.
- A crashed or empty report counts as a failure of every criterion; a
  document with no figures, notes, links, or styles is `n/a` on those
  criteria rather than a pass; a twenty-page document with no accounted
  furniture fails criterion 7. Unit tests cover each guard.
- The trusted VM runs the corpus audit plus scorecard on the owner-local
  diverse corpus after every merge to `main` that touches `src/research/**`,
  `src/struct/**`, or `tools/pdf-*`, and posts the criterion table (counts
  only) to the PR or issue. A drop in any criterion's pass rate, or any
  crash, blocks the guarded auto-merge.
- The listing-in-prose regression that hid for five weeks is covered by a
  unit test (`src/research/pdf-layout-preformatted-residual.test.ts`) and by
  the crash row of the scorecard.

## Definition of done

Per-criterion pass rates on the diverse corpus, every document in every
denominator:

- criterion 1 at 100%;
- criteria 2, 7 at or above 95% of applicable documents;
- criteria 3, 4, 6 at or above 90% of applicable documents;
- criterion 5 at or above 80% of applicable documents;
- criterion 8 at or above 80% of scanned documents;
- criterion 9 at or above 50%, rising to the 20/20 held-out claim in #202
  only after the eight reader criteria hold.

Until then the scorecard is the progress report and the corpus audit's binary
gate remains the release gate.

## Validation command

```bash
npx vitest run tools/pdf-success-scorecard.test.mjs src/research/pdf-layout-preformatted-residual.test.ts
npm run pdf:corpus-audit -- --report-only <owner-local corpus dir> > corpus-audit.json
node tools/pdf-success-scorecard.mjs corpus-audit.json --strata <manifest> --markdown
npm test
npm run build
```

## Allowed secrets

None. Source PDFs, rendered pages, and any text remain owner-local.

## Artifact outputs

`tools/pdf-success-scorecard.mjs` with tests; a strata manifest schema; a
scorecard JSON and Markdown table per corpus run; a VM recipe that runs the
audit and scorecard after merges and posts counts.

## Stop conditions

Stop before letting a criterion pass by omission, before deriving strata from
pipeline output, before dropping a crashed document from a denominator, and
before treating any per-criterion pass rate as a substitute for the
fail-closed publication gate.

## Human clarification protocol

If a criterion cannot be bound to an existing counter without a new pipeline
signal, ship it as reported-only with the missing signal named, rather than
approximating it with a text regex.

## Recommended response

Bind the criteria to the counters that already exist and run them on a
corpus that includes publisher, word-processor, and scanned inputs, because
the current lanes never exercise the furniture or OCR criteria at all.

## Trade-offs

Criterion applicability rules are conservative and will mark some documents
`n/a` that a human would score; that under-counts progress rather than
over-claiming it, which is the right direction for a gate.

## Free-form response

The binary gate hid a 65% crash rate for five weeks. A nine-row table that
runs after every merge would have shown it the same day.

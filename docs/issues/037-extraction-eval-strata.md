# Populate the extraction eval with the strata a reader actually notices

depends-on: 017,034,035,036

## Provider

vm-codex

## Goal

Make the benchmark measure the things that decide whether an EPUB is readable. `benchmark-readiness-registry-v1.json` specifies a serious protocol — 100 traces, 25 documents, 10 blind, two reviewers, judge TPR/TNR ≥ 0.8 — but the eval set behind it holds two documents and three cases, and its strata are figure reading order and inline fragments. There is no table stratum, no structure stratum, and no layout stratum, so the parsers have never been compared on the dimensions that fail in practice.

## Observed gap

Every quality claim about tables, headings, equations, or prose continuity in this repository currently rests on ad-hoc owner-local probes. Two such probes produced badly misleading numbers before being cross-checked:

- Scoring a candidate on "rectangular grid + cells present in page text" rated a whitespace-grid extractor 23/27, until a rendered page showed the grids were page-wide and had fused a table with two charts.
- A `\w+-\w+` regex reported 204 broken hyphenated words on a paper where the pipeline's own `unresolvedCorruptingJoinCount` was 14; the regex was counting `state-of-the-art`.

A stratum is therefore only admissible with a defined ground truth and a metric that cannot be satisfied by a degenerate answer.

## Acceptance tests

- Strata cover, at minimum: table structure, section/heading structure, display equations, figure and diagram extraction, prose continuity, running-head and page-number exclusion, footnote resolution, and column layout. Every stratum names its ground truth and its degenerate-answer guard.
- The corpus is layout-balanced: one-column and two-column documents are both represented and reported separately, since the dominant failures differ between them.
- Ground truth for table structure is recorded per table as rows, columns, header scope, and cell text, derived from the source document and reviewed — not from any parser's output. A parser's own output may never become its own label.
- Structure ground truth records the expected heading sequence and level per document, including unnumbered and non-English headings, so recall is measurable without a word list.
- Metrics are stated so a degenerate answer scores zero: emitting a page-wide grid, emitting every line as a heading, or emitting no objects at all must each score worse than abstaining.
- Prose-continuity metrics use the pipeline's own authoritative counters where they exist rather than text regexes, and any regex proxy is validated against a counter or a rendered page before it may gate anything.
- The comparator reports the deterministic path and every configured candidate provider on the same corpus, per stratum and per layout, so a change in either direction is visible in one table.
- A scored table or object prediction carries source-page geometry and source
  region/line lineage; metadata-only output is a guarded zero rather than a
  perfect match. Candidate envelopes bind the canonical eval-set hash.
- Review labels are admissible only with a roster-bound identity artifact and a
  source-only decision artifact. Until those artifacts and at least one real
  provider output exist, the command emits a `reported-only` report and does
  not claim a comparison.
- Running the benchmark is a single documented command, and its report is privacy-safe: identities, hashes, counts, and diagnostic codes only.

## TDD sequence

1. **Red:** add the stratum definitions and their schema; preserve failures for missing ground truth and missing layout balance.
2. **Green:** populate table and structure ground truth for a first reviewed slice, and implement the degenerate-answer guards.
3. **Red then green:** wire the comparator to report per stratum and per layout across providers.
4. **Refactor:** fold the ad-hoc probes into the harness so no quality claim depends on a throwaway script.

## Exact-head definition of done

- Table and structure strata exist with reviewed ground truth and both layouts represented.
- Every metric has a documented degenerate-answer guard.
- The three-way comparison runs from one command and emits a privacy-safe report.
- From a clean checkout of the immutable PR head, `scripts/agent-evidence --all` records `commit` equal to that head, `dirty: false`, and `result: passed`.

## Validation command

```bash
npx vitest run tools/pdf-corpus-audit.test.mjs tools/pdf-benchmark-compare.test.mjs tools/pdf-fidelity-eval.test.mjs
npm test
npm run build
```

## Allowed secrets

None. Source documents and rendered evidence remain owner-local.

## Artifact outputs

Populated table, structure, equation, figure, prose-continuity, boilerplate, and layout strata with reviewed ground truth and degenerate-answer guards.

## Stop conditions

Stop before letting a parser's own output become its own label, admitting a stratum without ground truth, or gating on a regex proxy that was never validated.

## Human clarification protocol

If reviewed ground truth is unavailable for a stratum, confirm whether it ships as reported-only rather than gating.

## Recommended response

Define each metric so a degenerate answer scores worse than abstaining, because two ad-hoc proxies already produced badly misleading numbers in this repository.

## Trade-offs

Reviewed ground truth is slow to produce, but unlabelled strata cannot distinguish a real improvement from a parser that got louder.

## Free-form response

Every quality claim about tables, headings, equations, and prose currently rests on throwaway scripts, so no regression in any of them would be caught.

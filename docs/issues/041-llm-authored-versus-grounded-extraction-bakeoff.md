# Decide the extraction architecture: LLM-authored structure versus LLM grounded in deterministic context

depends-on: 036,037,038

## Provider

vm-codex

## Goal

Settle, with measurement rather than judgement, which of two architectures should own extraction. The current geometric extractor is 25,797 lines across five files with 98 named thresholds, 268 inline magic-number comparisons, and 392 regex literals, validated against 15 synthetic fixtures and zero real papers in any automated lane. It has no held-out signal, so every fix is fitted to the one paper that motivated it. Two candidate replacements exist and must be compared on the same corpus under the same rules.

**Arm A — LLM-authored structured output.** The model receives the page rendition and the extracted source text runs and emits the whole structured document directly.

**Arm B — LLM grounded in deterministic context.** The model receives the same source plus the deterministic layer's proven artifacts (region lanes, proved table scopes, line-boundary ledger, note and citation relationships, source-run provenance) and proposes structure only where those artifacts leave a decision open. The deterministic layer verifies every emitted span against source runs.

The deterministic layer is retained as verifier in both arms. Neither arm may emit text that does not trace to a source run.

## Scope of the structured output

Both arms must produce, for any incoming paper and without a language or template allowlist:

- **Sectioning** — title, authors, affiliations, abstract, and the full heading hierarchy with levels, for numbered (any numeral system), unnumbered, and non-English headings.
- **Prose** — continuous paragraphs in reading order, joined correctly across column and page breaks, with discretionary line-end hyphens resolved or explicitly left unresolved.
- **Boilerplate discarded** — running heads, journal titles, repeated page titles, page numbers, and watermark furniture excluded from body flow while remaining accounted for.
- **Code and listings** — preformatted structure with line breaks and indentation preserved.
- **Tables** — semantic structure with header scope and per-cell provenance.
- **Diagrams and figures** — extracted as separate bounded assets, each associated with its caption and referenced from the flow; alt text is derived from the caption and source-backed, never invented from the image.
- **Equations** — display and inline, as source semantics where provable and a bounded source-backed asset otherwise, preserving visible labels and order.
- **Footnotes and endnotes** — typed bodies with markers resolved to them and backlinks, including markers that fall inside floats.
- **References** — typed bibliography entries with citations anchored to them.

## Acceptance tests

- Both arms run over the same held-out corpus split under issue 037's strata and issue 038's checkpoints, on one-column and two-column layouts, with per-stratum and per-layout results reported side by side against the current geometric path as baseline.
- Thresholds, prompts, and any tuning are fitted only on the development split. The held-out split is scored once per candidate version and never used for tuning; a candidate that has seen the held-out split is disqualified and its identity recorded.
- No emitted text may originate with the model. Every span, cell, heading, caption, and note body is matched to source text runs before emission; a span that cannot be matched is dropped to a fail-closed fallback and counted. Alt text is caption-derived and never generated from image content.
- Diagrams are extracted as separate assets by the deterministic layer in both arms. The model may associate and order them; it may not author their bounds or their bytes.
- Both arms are byte-stable: the same source, model identity, and prompt produce identical structured output, and model identity, version, digest, and prompt hash are recorded in the receipt.
- Boilerplate exclusion is measured, not assumed: running-head and page-number contamination in body flow is reported per document for both arms.
- Cost and latency per page are reported for both arms, since a per-page model call has a materially different operating profile from a per-document one.
- The comparison names a winner per stratum, not only in aggregate, and records where the two arms disagree so the losing arm's failures are inspectable.
- A written decision records which architecture owns extraction, what the geometric path's remaining role is, and what evidence would reverse the decision.

## TDD sequence

1. **Red:** define the structured-output contract shared by both arms and the disqualification rule for held-out contamination; preserve failures for an unverified span and for model-authored alt text.
2. **Green:** implement the shared verifier and the arm-agnostic runner over the issue 037 corpus.
3. **Red then green:** implement each arm behind the same interface and produce the side-by-side report.
4. **Refactor:** retire whichever extraction path loses, in a separate change, only after the decision is recorded.

## Exact-head definition of done

- Both arms and the geometric baseline are scored on the same held-out split, per stratum and per layout, with cost and latency.
- No arm emits a span that does not trace to a source run.
- The decision and its reversal criteria are recorded in the repository.
- From a clean checkout of the immutable PR head, `scripts/agent-evidence --all` records `commit` equal to that head, `dirty: false`, and `result: passed`.

## Validation command

```bash
npx vitest run src/research/semantic-table.test.ts src/research/epub.test.ts
npm test
npm run build
```

## Allowed secrets

A model credential is required and is explicit owner opt-in. It never enters the repository, logs, receipts, issues, or PR comments. Source papers and rendered pages stay owner-local; if an arm sends page content to a remote model, that arm runs only under explicit opt-in and the receipt records that it did.

## Artifact outputs

A shared structured-output contract and verifier, an arm-agnostic runner over the held-out corpus, both candidate arms behind one interface, and a per-stratum per-layout comparison report with cost and latency and a recorded decision.

## Stop conditions

Stop before tuning on the held-out split, letting model-authored text reach the document, generating alt text from image content, allowing a model to author asset bounds or bytes, or retiring the geometric path before the decision is recorded.

## Human clarification protocol

If the two arms win different strata, present the per-stratum table and ask whether to run a hybrid — grounded for objects with proven deterministic artifacts, authored for the rest — rather than choosing one arm globally.

## Recommended response

Build the shared verifier and runner first so both arms are measured under identical rules; the verifier is required regardless of which arm wins and is the only thing that makes any model output safe here.

## Trade-offs

Arm A is simpler and likely stronger on template variety but sends more content to a model, costs more per page, and has a wider blast radius when it is wrong. Arm B constrains the model with artifacts that are already proved and keeps the failure surface narrow, but inherits the deterministic layer's blind spots wherever its artifacts are absent.

## Free-form response

The geometric extractor has no held-out evaluation, so it cannot distinguish a fix that generalises from one fitted to the single paper that motivated it, and its observed failures — keyword allowlists for headings, single-character ordinals, a table promoter gated on one evidence code — are all that pattern. This issue exists to replace judgement about which approach is better with a measurement that either architecture could lose.

# Add a model table candidate provider behind deterministic cell verification

depends-on: 013,020,033,034

## Provider

vm-codex

## Goal

Let a table-structure model propose grids while the deterministic layer keeps final authority. The hand-written geometric detectors promote roughly one table in ten on real papers; a table-structure model recovers nearly all of them. The project's own benchmark registry already describes candidate providers, blind tracks, and judges — the candidate side was never built, so no model has ever been compared against the geometric path.

## Measured baseline

On a paper with ten real table captions: the deterministic pipeline shipped **2 semantic, 5 raster, 3 unresolved**. Docling (TableFormer) returned **10 tables in 200s on CPU**. The one verified against a rendered page — a four-column booktabs table with row-group stubs beside two donut charts — came back structurally correct, preserving the empty continuation stubs, with every cell string present in the page's own extracted text.

A rule-based alternative was also measured and rejected: pdfplumber's line strategy finds nothing on booktabs tables (no vertical rules), and its text strategy emits page-wide whitespace grids — on one page it fused the table with two neighbouring charts' labels into a 63×6 grid. Structure counts alone would have scored it well, which is why cell-level verification is mandatory rather than optional.

Docling is not uniformly correct either: dense percentile tables come back with damaged cell text (`5 , 557 . 0`). The model is a candidate generator, never an authority.

## Acceptance tests

- The provider runs behind the existing adapter boundary and is explicit opt-in, matching the issue-020 remote/local engine pattern. With no provider configured the pipeline behaves exactly as it does today, and the default offline path is unchanged.
- A proposed grid is accepted only when every non-empty cell's text is matched to source text runs inside the table's proved scope, with recorded per-cell provenance. A single unmatched cell rejects the whole table; there is no partial promotion.
- A rejected proposal falls back to the existing bounded source-page crop, not to omission, and records a named diagnostic distinguishing "no proposal" from "proposal failed verification" and from "provider unavailable".
- Model output never becomes text. Verified cells carry the source-run text, not the provider's string, so a provider that reformats or mangles a number cannot change the document.
- Provider identity is pinned and recorded: id, version, model digest, and configuration hash appear in the receipt, and a changed identity invalidates cached candidates.
- The provider never receives anything beyond the bytes it needs, and no source text, path, or page image leaves the machine unless a remote provider is explicitly enabled by the owner.
- Repeated runs with the same provider identity and source produce byte-identical grids, receipts, and asset hashes.
- The benchmark compares the deterministic path, the provider path, and the verified provider path on the same corpus, reporting semantic/raster/unresolved counts for each, so a regression in either direction is visible.

## TDD sequence

1. **Red:** add fixtures for a verifying proposal, a proposal with one unmatched cell, a mangled-text proposal, and an unavailable provider. Preserve failures.
2. **Green:** implement the candidate interface and the cell verifier. Verification lives in the deterministic layer and is provider-agnostic.
3. **Red then green:** wire one concrete provider behind opt-in configuration and prove the three-way benchmark.
4. **Refactor:** share the verified-grid materializer with the existing semantic path only after byte-stability holds.

## Exact-head definition of done

- With the provider enabled, semantic table coverage on the corpus rises materially and no table regresses from semantic to raster.
- With the provider disabled, every existing result is byte-identical to today.
- No verified cell contains provider-authored text.
- From a clean checkout of the immutable PR head, `scripts/agent-evidence --all` records `commit` equal to that head, `dirty: false`, and `result: passed`.

## Validation command

```bash
npx vitest run src/research/semantic-table.test.ts src/research/pdf-table-detection.test.ts src/research/pdf-table-fallback.test.ts src/research/epub.test.ts
npx vitest run tools/pdf-fidelity-mineru-adapter.test.mjs
npm test
npm run build
```

## Allowed secrets

None by default. A remote provider requires explicit owner opt-in and its credential never enters the repository, logs, or receipts.

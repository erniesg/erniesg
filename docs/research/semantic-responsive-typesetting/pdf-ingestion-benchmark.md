# Deterministic PDF-to-EPUB benchmark

The benchmark separates three questions that must not be collapsed into one score:

1. Did the pipeline remain deterministic and produce structurally valid EPUBs?
2. Did measurable coverage, reading-order, and unresolved-object metrics regress?
3. Did semantic accuracy improve against human-approved ground truth?

The first two are automatic. The third requires frozen annotations; an existing parser output is not ground truth.

## Run identity and receipt invariants

A benchmark version fixes the ordered source SHA-256 set, parser/model identifier, dependency and toolchain versions, reconstruction/decision schema versions, completeness policy, profile id/version, renderer, comparator policy, and annotation-schema version. When a human-decision sidecar is replayed, its full-file SHA-256 is part of the run identity too. Changing any of these creates a new candidate identity; changing the source set or order creates a new corpus version.

Receipts are derived from evidence rather than trusted as user-supplied hash strings. Corpus and comparison envelopes remain schema `1.4.0`; private-fidelity receipts use schema `1.5.0`, whose exact envelope adds the required nullable `decisionSetSha256` input-identity field. At emission and validation time the harness binds canonical node order/content and semantic type counts; front-matter, inline, and list semantics; citation, note, and visual relationship graphs; source-asset manifests; the exact line-transition ledger; and `structurallyConsumedLineBoundaryCount`. Artifact receipts bind the same graph and source asset IDs to profile id/version, mode, EPUB bytes, and structural validation. Counts, derived hashes, and sanitized evidence must agree. Coordinated edits to copied hash fields, a changed line decision with a stale ledger hash, a missing citation anchor, or a structurally invalid candidate fail closed.

Each matched citation relationship has one exact source-backed canonical anchor `{ nodeId, start, end }`. The anchored canonical node must carry a citation inline run with the same relationship ID, range, and ordered target IDs; every target must be a canonical bibliography entry, and the anchor node's provenance must include the reference source region. The sanitized graph hashes relationship status/taxonomy, reference range, hashed labels and targets, canonical anchor, and source boxes. Citation and visual canonical IDs are globally unique and source-anchored rather than derived only from display labels, so repeated equation numbers, symbolic citation labels, and lossy slug collisions remain distinct.

Text conservation is measured in ordered provenance groups, not as one bag of characters. Canonical prose is matched to the source regions that produced it; accepted scientific-object regions are matched locally to their relationship payload. This prevents reordered prose, duplicated title/body spans, and visually similar table or diagram labels elsewhere in the paper from receiving false credit.

## Benchmark layers

### Repository-owned synthetic fixtures

`tests/fixtures/pdf/manifest.json` lists CC0 fixtures for columns, spans, figures, tables, equations, notes, OCR, rotation, and ambiguity. Focused Vitest cases assert exact classifications, reading order, relationships, provenance, fallback behavior, and EPUB invariants. Every confirmed corpus failure should be reduced to one of these synthetic fixtures when possible.

Synthetic fixtures are the fast merge gate. They contain no private paper content and run in CI.

### Frozen private-corpus snapshot

Run the same named or seed-selected corpus slice before and after a parser or model change:

```bash
npm run pdf:export -- ./private-sample \
  --target paperPro \
  --readable-fallback \
  --out /tmp/srt-baseline

npm run pdf:benchmark:compare -- \
  /tmp/srt-baseline/corpus-audit.json \
  /tmp/srt-candidate/corpus-audit.json \
  --out /tmp/srt-comparison.json
```

The comparison keys documents by source SHA-256 and emits only basenames, hashes, metrics, blocking-code deltas, and artifact invariants. It fails when a document disappears, readiness falls from ready to review-required, structural validation fails, a previously exported target disappears, or a configured metric regresses. Candidate-only documents are validated too: adding a document whose reconstruction, profile artifact, or EPUBCheck result fails cannot be hidden merely because no baseline row exists. Headless export supplies `--failonwarnings` to either the native `epubcheck` command or the locally installed JAR, so a warning is an external-validation failure rather than a pass. Validator unavailability remains an explicit allowlisted skip, never an EPUBCheck pass.

The first frozen exploratory slice uses seed label `random-10-2026-07-20-v1` and the ordered public identifiers `2503.18265v1`, `2501.09223v1`, `2404.19482v1`, `2405.07987v5`, `2501.19393v2`, `2412.13575v1`, `2103.02228v1`, `2307.12950v3`, `2507.21509v3`, and `2501.07531v1`. Reuse that exact ordered set for before/after comparisons; choosing ten new papers is a new corpus version, not another run of the same benchmark.

Corpus JSON uses exact per-code diagnostic counts plus deterministic redacted samples bounded to three per code and 64 per document, with an explicit truncation count. This keeps fragment-heavy scientific PDFs actionable without turning repeated vector debris into megabytes of near-identical receipt rows. Owner-only visual evidence may remain detailed outside the repository.

Small intentional metric tradeoffs must be explicit:

```bash
npm run pdf:benchmark:compare -- baseline.json candidate.json \
  --tolerance textCoverage=0.001
```

Use `--require-identical-artifacts --require-identical-structure` when rerunning the same engine and dependency set. The structural gate fingerprints canonical node order/content; semantic and front-matter type counts; inline/list identity; citation, visual, and note relationships; assets; and the line-transition ledger, so identical aggregate coverage cannot hide a changed document graph. Do not use either strict flag when comparing different models because a legitimate semantic improvement changes the EPUB and structural receipts; such changes require fixture/gold assertions plus human review before freezing a new accepted baseline.

Strict structure requires an available, internally consistent line-transition ledger in both reports and requires its receipt to repeat exactly. The ledger enumerates exactly one unique decision for every adjacent source-line transition inside a source region, validates page/region membership, and recomputes its sanitized hash from the decisions. A `structural-boundary` decision is valid only when the transition's whole region belongs to one strictly validated visual relationship and no rendered text node; forged/stale, rejected, mixed-ownership, or prose-owned classifications revert to unresolved. Corpus/comparison schema `1.4.0` records the exact structural count separately, rejects count mismatches, and treats that count as directionally neutral while strict structure catches any changed decision. It does not require zero unresolved joins for a general review corpus: zero unresolved corrupting joins is a separate publication-fidelity acceptance rule.

The opt-in private-fidelity runner performs a fresh reconstruction for every repeat and hashes only sanitized reconstruction and artifact receipts. Optional owner adjudication enters only through the paired `--decisions-env <ENV_NAME>` and `--expected-decisions-sha256 <digest>` arguments. The environment variable resolves the owner-local sidecar without exposing its path on the command line; the full-file digest is verified before parsing, and the same pinned decisions are applied after every fresh reconstruction. Private-fidelity schema `1.5.0` writes that verified digest to `decisionSetSha256`, or writes `null` when no sidecar is configured; no path or raw decision payload enters the receipt. Missing argument partners, malformed or identity-mismatched files, stale targets or resolutions, any applied-count mismatch, a missing/malformed receipt field, or a baseline/candidate decision-identity mismatch fails closed. Because `decisionSetSha256` is a new required exact-key field, a private receipt from schema `1.4.0` is not a compatible accepted baseline and must be reviewed and frozen again. The receipt's `localValidationPassed` field covers readiness, zero unresolved corrupting joins, reconstruction repeatability, and profile-artifact repeatability. After independent review, record the full canonical SHA-256 of that accepted sanitized receipt outside the repository. Pass both `--baseline "$SRT_ACCEPTED_PRIVATE_FIDELITY_RECEIPT"` and `--expected-baseline-sha256 "$SRT_ACCEPTED_PRIVATE_FIDELITY_RECEIPT_SHA256"` to compare against it. The comparator requires the supplied digest to match the entire baseline receipt before it evaluates source, decision-set, profile, and repeat identity; exact graph and artifact invariants; and directional completeness/readiness/diagnostic non-regression. It excludes timing, cost, local paths, and run ordinals from candidate regression comparisons, but not from the acceptance digest binding. Without both baseline arguments, `baselineComparison.status` remains `not-configured`, top-level `passed` remains false, and the command exits nonzero even when local repeatability passes. Never derive the expected digest from the candidate or the baseline file during the comparison invocation; doing so would erase the independent acceptance boundary.

This snapshot is a regression detector, not an accuracy oracle. It can preserve an old mistake if used without gold annotations.

### Named `2408.10903v5` acceptance

Issue 032 pins the public identity by source size and SHA-256 but reads the operator-staged path only through `SRT_PRIVATE_PDF_2408_10903V5`. When owner decisions are needed, their path is read only through `SRT_PRIVATE_DECISIONS_2408_10903V5` and their exact bytes are independently bound by `--expected-decisions-sha256`; omitting both decision arguments runs the raw parser, while supplying only one is invalid. Every repeat reconstructs from source again, replays the same validated decision set when configured, and builds Mobile, Paper Pro Move (`954 × 1696 @ 264 PPI`), and Paper Pro (`1620 × 2160 @ 229 PPI`) artifacts. The browser then verifies that the actual checked EPUB rendition can be previewed at each scaled registry viewport and downloaded only by explicit action; these viewport receipts do not claim firmware-exact pagination.

The named run has two distinct verdicts:

- `localValidationPassed` proves this candidate is ready under the configured gates and repeats deterministically.
- top-level `passed` additionally requires a separately human-reviewed sanitized baseline staged outside the repository and a passing baseline comparison.

Without that external accepted baseline and its independently recorded canonical receipt digest, `baselineComparison.status` is `not-configured`, top-level `passed` is false, and the runner exits nonzero. As of 2026-07-21 the latest owner-only named run remains `review-required`; it is not an accepted baseline and issue 032 remains open.

Current privacy-safe evidence is deliberately split by authority:

- The repository-owned synthetic strict A/B reports have identical SHA-256 `0579f5f9cf5dc8d3891f645c23946ed0a6a5b157dee410c15e330face4f5e4fd` and are `1/1 ready`, with ordered text `0.99057`, inline `14/14`, assets `3/3`, relationships `4/4`, and zero unresolved obligations. All six profile artifacts are byte-identical across repeats and pass internal validation plus EPUBCheck 5.3.0; strict comparison SHA-256 is `c7d99a2fc96b77eaf95b0fdc43bac4486512dc1d9e9c9a5a5f27a5bbcb562849`.
- The latest owner-only named repeat replays decision set SHA-256 `e0be07308acadfb44138e1fb372d505768b89aadc67eb127ed844f241d2767c5` and reports ordered text `0.99996`, inline `705/714`, validated visuals `12/51`, relationships `33/86`, zero unresolved corrupting joins, and 4 strictly visual structural boundaries. Both reconstruction receipts are `6c87ba7f44da80cadd65ac2f466a3fa7b897d4b34c7679eacfb2c11280cd9d5f`; all six exact artifacts repeat byte-for-byte and pass internal validation plus EPUBCheck 5.3.0. It remains `review-required` on incomplete/ambiguous visuals and tables plus 9 citations whose only owner is a non-semantic table visual; there is no external accepted baseline.
- The final conservative-visual frozen-ten A/B run covers 10 papers, 495 pages, and `19,758,997` bytes. It records `0 ready / 10 review-required / 0 failed`, mean text `0.998058`, weighted inline `51,638/51,709` (`0.99862693`), assets `726/1,146` (`0.63350785`), relationships `1,043/1,673` (`0.62343096`), `1,125` unresolved obligations, and `292` unresolved plus `7` structural line boundaries. Both export-corpus reports hash to `bf88a61602a0299ef76af141c241e66451796e08bcb181d4eef567be5f849ce3`; both sorted 30-artifact indexes hash to `3ea2dc48d1899e6dd192259b1a70371c5a7d1cf1825dabc39787bb6bf4dfc140`. Each run produced all 30 profile EPUBs: 60/60 passed internal structural validation and EPUBCheck 5.3.0, and the strict artifact-and-structure comparator passed with SHA-256 `b3f247bfd52c88da3e5b60e4ef48889d3a0f86b187d3706d5fb40efe8b91b85d`. All ten papers remain `review-required`; deterministic valid export is not publication readiness.

### Human gold annotations

Begin with 10-30 representative outputs. Review only bounded decisions, not an entire EPUB as a single pass/fail object. For each adjudicated page, record:

- source basename and SHA-256;
- page number;
- region kind and normalized bounding box;
- expected reading-order sequence of annotation IDs;
- expected front-matter role, heading/list identity, and list marker style/ordinal/level/continuation where applicable;
- expected inline emphasis/link/note/citation spans and canonical citation targets;
- exact source-backed canonical citation anchors and globally unique relationship IDs, including colliding-display-label cases;
- expected outcome for every adjudicated adjacent line transition;
- caption-to-figure/table/equation relationships;
- note-reference-to-note relationships;
- whether a visual is one valid bounded composition, intentionally omitted, or unresolved;
- whether a table has validated semantic cells, a real bounded page crop, or must remain unresolved because neither is available;
- reviewer and annotation-schema version, without source text.

Keep annotations outside the repository when corpus licensing or privacy requires it. A local benchmark runner may load them by explicit path. Commit only repository-owned synthetic reductions.

Score model/parser candidates at the task level:

| Task                  | Primary metric                                             | Promotion constraint                                                                                                                     |
| --------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Region classification | macro F1 by region kind after IoU matching                 | no critical-kind recall regression                                                                                                       |
| Reading order         | pairwise order accuracy and cycle rate                     | zero accepted cycles                                                                                                                     |
| Visual association    | relationship precision/recall                              | no hallucinated relationship may become publication-ready                                                                                |
| Notes and citations   | typed target relationship precision/recall                 | ambiguous or missing targets remain fail-closed                                                                                          |
| Text                  | ordered, provenance-scoped character recall                | repeated margins and scientific-object labels are not counted as body prose                                                              |
| Structure             | front-matter/heading/list/reference exact decisions        | marker identity, nesting, continuation, and canonical order do not regress                                                               |
| Tables/equations      | semantic-structure or source-backed fallback accuracy      | no synthetic table is reported as an exact crop; unavailable crops stay blocked                                                          |
| EPUB                  | canonical-node order, packaged provenance, EPUB validation | no duplicate canonical/asset identities, asset hrefs, XHTML IDs, dangling fragments/assets, external execution, or missing spine content |
| Runtime               | parse/export/render latency and peak memory                | measured separately from accuracy                                                                                                        |

## Recursive improvement loop

1. Run the frozen sample and inspect the worst metric buckets plus rendered PDF/EPUB pairs.
2. Adjudicate the smallest set of ambiguous pages needed to identify the failure class.
3. Reduce each generalizable failure to a synthetic fixture and first make the test fail.
4. Implement the parser/model change without weakening readiness policy.
5. Run synthetic tests, same-identity repeatability, the frozen snapshot comparison, and gold task metrics. Validate baseline-matched and candidate-only documents.
6. Promote only when artifact invariants pass, all publication gates remain fail-closed, and accuracy gains exceed declared regressions.
7. Have a human review the bounded changed decisions before freezing a new accepted sanitized baseline; never let the candidate appoint its own output as ground truth.
8. Version the benchmark, model identifier, dependencies, thresholds, source-set identity, and annotation schema with the result.

This makes the first 10-30 outputs a calibration seed. Later work reuses their frozen decisions and focuses human review only on new ambiguity classes.

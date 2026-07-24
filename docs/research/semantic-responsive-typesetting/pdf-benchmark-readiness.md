# Scholarly PDF benchmark readiness

The PDF reconstruction harness has two deliberately separate tracks:

1. **Localized public diagnostics** answer narrow questions such as “is this
   region a heading?” or “does this caption own that figure?” They may expose a
   task, stratum, target identity, page, or box. They are useful for regression
   testing and model calibration, but they are not blind end-to-end evidence.
2. **End-to-end blind evaluation** gives a candidate only a document identity
   and hash-pinned PDF bytes. Gold labels, strata, target identities, target
   pages, boxes, and reviewer annotations remain private. The provider, model,
   adapter, prompt/configuration, seed, and runtime identities must be frozen
   before private labels are revealed.

`benchmarks/pdf/benchmark-readiness-registry-v1.json` records the current state
and `tools/pdf-benchmark-readiness.mjs` checks it. The checker binds the public
eval-set, observation schema, and first-failure observation bytes. Observation
objects must pass their bound schema, identify the exact eval-set bytes and
canonical document/case identities, and satisfy an additional path-safe
failure-class contract. Every bound file must be a regular, non-symlink file
inside the repository. The checker rejects document identity collisions, split
leakage, unverified template-family declarations, and split documents not bound
by a source.

Every frozen split identity covers each document id, exact source-PDF SHA-256,
verified template-family id, and SHA-256 of the source-only assignment
evidence. A blind document is acceptable only when every source containing it
is private, non-oracle-localized, and selected without consulting candidate
output. Private first-failure labels are used only inside the gate; its public
receipt replaces their names with one aggregate redacted count.

Before labels are revealed, a frozen candidate must bind seven regular,
non-symlink repository artifacts—provider, model, adapter, prompt,
configuration, seed, and runtime—and a custodian receipt tied to the exact
frozen blind-split identity. The receipt must name a roster-bound independent
custodian whose authority artifact explicitly covers witnessing a candidate
freeze while private labels remain withheld. A status field or unverified
digest alone is insufficient.

The target-free acquisition protocol is implemented by
`tools/pdf-target-free-candidate-run.mjs`. Each adapter request names one
owner-local PDF path plus the document id, byte length, and SHA-256 declared by
a source-only manifest. It rejects oracle metadata in that manifest/request,
symlinks, path escapes, and changed bytes. Each invocation gets a minimal
constructed environment and a private scratch directory as its cwd, home, and
temporary directory; the owner's `HOME`, `TMPDIR`, and full `PATH` are not
inherited. The host platform may still add its standard process-launch
metadata. The adapter's complete source identity is re-derived immediately
before and after each document invocation; replacement or self-modification
fails the run before that invocation's output is retained.

Those process-hygiene measures are not a filesystem sandbox. The adapter can
still access host paths allowed to the owner, including the requested PDF, and
the offline environment flags do not enforce network denial. The receipt
therefore records filesystem isolation as not sandboxed, network isolation as
cooperative and unenforced, and independent isolation attestation as absent.
A future independently isolated lane must supply and verify an external
sandbox/network attestation, represented by a roster-bound external attestor
identity and a passing execution receipt cross-bound to the frozen candidate
commitment and blind-split identity. The readiness checker validates those
bindings, but this runner and its receipt do not create them.

Candidate output stays owner-local in an explicit, previously nonexistent
directory selected through an environment variable. The runner creates that
directory with mode `0700` and retains one exact adapter payload per manifest
document as `raw-output-000001.json`, `raw-output-000002.json`, and so on, with
mode `0600`. It will neither reuse the directory nor overwrite an existing
receipt. A failed attempt can leave a private partial directory; inspect it
locally and choose a new directory before retrying. The public receipt and
stdout contain identities and hashes of the retained bytes, never payload
content, source content, filenames, or local paths. The `validate` command
replays every retained byte length and SHA-256 before accepting the receipt.
This makes the blind lane runnable, but it is not frozen and has no promotion
authority until its private split and reviewer protocol satisfy the readiness
gate. Frozen status and promotion authority also require independently
enforced network and filesystem isolation.

Human review evidence is artifact-bound. Each initial reviewer has a distinct
reviewer id, roster-backed identity-evidence artifact, and source-only
decision-evidence artifact tied to the case and protocol. Disagreement requires
a third adjudicator identity with separate bound artifacts. A list of decision
hashes alone does not satisfy review coverage. A reviewer id must resolve to the
same roster identity artifact and subject identity across the complete bundle
set. Template-family assignment evidence similarly binds at least two distinct
roster identities and their source-only decisions to the exact document,
source-PDF hash, and assigned family.

Code metrics bind their implementation and test. A metric declared as a
`calibrated-judge` additionally binds held-out confusion-matrix evidence and a
passing execution receipt tied to the exact implementation and calibration
bytes. The held-out identity must be a frozen public-calibration or development
split; the execution input must be that split identity, and its output identity
is derived from the exact confusion matrix. Both TPR and TNR must meet the
registry thresholds on at least 50 positive and 50 negative held-out examples.

Run the current audit with:

```bash
node tools/pdf-benchmark-readiness.mjs \
  --registry benchmarks/pdf/benchmark-readiness-registry-v1.json \
  --out /tmp/pdf-benchmark-readiness.json
```

`--require-ready` is fail-closed in readiness schema/tool v1. It exits nonzero
while any ordinary criterion remains unmet and also on the permanent
`promotion-protocol-implementation` gap described below.

Run a target-free candidate after the owner has staged the manifest PDFs in a
private directory:

```bash
SRT_PDF_TARGET_FREE_INPUT_ROOT=/private/candidate-inputs \
SRT_PDF_TARGET_FREE_ADAPTER=/private/model-adapter \
SRT_PDF_TARGET_FREE_RAW_OUTPUTS=/private/example-target-free-raw \
  npm run pdf:eval:target-free -- run \
  --manifest /private/blind-manifest.json \
  --input-root-env SRT_PDF_TARGET_FREE_INPUT_ROOT \
  --adapter-env SRT_PDF_TARGET_FREE_ADAPTER \
  --raw-output-dir-env SRT_PDF_TARGET_FREE_RAW_OUTPUTS \
  --candidate-id example \
  --candidate-version 1 \
  --out /private/example-target-free-receipt.json
```

Replay the retained payloads before private scoring:

```bash
SRT_PDF_TARGET_FREE_ADAPTER=/private/model-adapter \
SRT_PDF_TARGET_FREE_RAW_OUTPUTS=/private/example-target-free-raw \
  npm run pdf:eval:target-free -- validate \
  --manifest /private/blind-manifest.json \
  --adapter-env SRT_PDF_TARGET_FREE_ADAPTER \
  --raw-output-dir-env SRT_PDF_TARGET_FREE_RAW_OUTPUTS \
  --receipt /private/example-target-free-receipt.json
```

Use `npm run pdf:eval:comparator -- build ...` with
`benchmarks/pdf/fidelity-comparator-contract-v2.json`, the exact prompt/config/
seed artifact files, and any optional provider/model/network/latency/cost
claim/evidence files to bind performance, runtime, predictions, and accuracy
evidence for an exact public calibration run. A declared digest without
matching bytes is rejected, but arbitrary caller bytes remain explicitly
`caller-bound-unverified-artifact`; they are not authentication or independent
measurement. Self-asserted latency, cost, or execution claims remain explicitly
labeled. That sidecar always remains `promotionEligible: false`.

## Current measured state

The current public calibration contains 32 bounded traces from four papers and
13 observed first-failure classes. Discovery order was not recorded, none of
the legacy cases has the new two-reviewer/adjudication bundle, and there is no
verified document-to-template-family evidence, candidate freeze, or private
document-disjoint blind split. The formerly asserted public split identity is
therefore `draft`; it cannot be frozen under the stronger binding contract. The
registry reports `ready: false`.

Readiness v1 is deliberately an inventory and gap reporter, not a promotion
authority. Its `promotion-protocol-implementation` criterion is hard-coded
false. A future version must not remove that lock until it also binds canonical
private reviewer decisions and adjudicated outcomes, enforces per-case blind
selection provenance, verifies source-PDF acquisition bytes, requires
exact-head metric execution receipts (and per-example judge outputs), and pins
the approved schema/policy identity. This prevents structurally plausible
registry JSON from becoming a release credential.

This is intentional. A perfect score on the exposed 32 cases means that a
candidate did not regress on those probes. It does not mean that the candidate
solves scholarly reconstruction or that it can be compared fairly on a public
leaderboard.

## Conditions for a defensible comparison

The readiness gate requires all of the following:

- at least 100 bounded, source-backed traces across at least 25 documents;
- a recorded discovery sequence whose final 20 traces introduce no new
  first-failure class;
- two independent source-only initial labels for every case, with distinct
  reviewer identities and bound evidence artifacts, explicit
  uncertainty/abstention, disagreement state, and separate third-party
  adjudication evidence when reviewers disagree;
- per-case selection provenance, including whether candidate output motivated
  selection;
- train, development, and blind-test splits separated by both document and
  independently reviewed template family; frozen identities bind source bytes
  and exact assignment evidence;
- at least ten frozen private blind-test documents;
- a pre-reveal candidate commitment binding provider, model, adapter, prompt,
  configuration, seed, runtime, custodian evidence, and the frozen blind-split
  identity;
- a target-free end-to-end candidate interface with independently enforced
  network and filesystem isolation and explicit promotion authority;
- objective coverage for prose, inline semantics, captions, tables, formulas,
  references, notes, whole-document order, official profile clipping and
  legibility, abstention/risk coverage, review-gate precision/recall, and EPUB
  package integrity; each available metric must bind an existing implementation
  and test by repository path and content hash, while calibrated judges also
  require held-out TPR/TNR evidence and a bound passing execution receipt.

These values are minimum engineering gates, not a statistical power claim.
Results should still report document-clustered intervals and the full
per-document distribution.

Even satisfying the listed inventory gates cannot make readiness v1 pass.
Promotion requires the separately reviewed protocol implementation work above
and therefore a new schema/tool version with an integrated positive fixture and
mutation tests for every authority boundary.

## Model boundary

OCR, layout, formula, table, and LLM systems may propose normalized regions,
transcripts, relationships, or typed graph patches. Each proposal must cite
the source page, box, line/object lineage, runtime/checkpoint identity, and
confidence. Deterministic validators remain responsible for source
conservation, cardinality, crop completeness, reading-order acyclicity,
package identity, profile rendering, EPUB validation, and the review gate.

A model must not write the accepted EPUB directly. Unsupported or conflicting
proposals remain explicit review obligations.

## Comparing future models

Every run should produce:

- the existing deterministic accuracy receipt;
- the comparator sidecar generated from the exact same eval-set, normalized
  predictions, and accuracy receipt;
- exact provider, model, adapter, prompt/configuration, seed, runtime, and
  checkpoint identities;
- independently enforced network-isolation status;
- per-document latency samples, declared warmups/repeats, peak memory when
  available, and cost basis;
- raw-output hashes retained privately when payloads cannot be published.

Public localized diagnostics and private end-to-end results must be reported
as separate tracks. The performance sidecar never grants promotion authority.

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

### Reader-visible extraction strata

The additive extraction benchmark is kept separate from the frozen fidelity
cases in [`benchmarks/pdf/extraction-eval-strata-v1.json`](../../../benchmarks/pdf/extraction-eval-strata-v1.json).
It uses repository-owned source fixtures, with two independent source reviews
per label, and records table cells (including row/column topology and header
scope) and heading sequences (including unnumbered and non-English headings).
The corpus has two one-column and two two-column documents. No parser output is
consulted when labels are made.

Every stratum declares its scoring formula and a fail-closed degenerate-answer
guard. An explicit abstention is reported at `0.25`; an empty answer, a
page-wide grid, an every-line heading flood, a caption without a bounded visual,
or another guarded answer scores `0`. Prose continuity is gated only by the
pipeline's authoritative line-boundary counters; a regex proxy cannot enter
the score.

Run the deterministic path and every configured candidate provider in one
privacy-safe comparison (the default provider manifest is intentionally
reported-only until a candidate is independently frozen):

```bash
npm run pdf:benchmark:extraction -- \
  --eval-set benchmarks/pdf/extraction-eval-strata-v1.json \
  --providers benchmarks/pdf/extraction-eval-providers-v1.json \
  --out /tmp/pdf-extraction-eval-report.json
```

The report contains only provider identities, artifact hashes, counts, scores
grouped by stratum and layout, and bounded diagnostic codes. Source text,
local paths, and rendered evidence remain outside the report.

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
New acquisitions hash every adapter-controlled format, tool, model, and version
identifier before placing it in the public receipt; literal values remain only
inside the private retained payload. This prevents a malicious adapter from
smuggling normalized source prose or a path basename through an otherwise
schema-valid identifier.
Runs without an explicitly configured local executable and model/cache home
keep emitting the frozen v1.1 receipt contract. Supplying both configured
runtime inputs emits v1.2 instead; that schema requires the path-free runner
executable identity and the explicit statement that the model/cache directory
was path-validated while its contents remain unattested. Validation selects the
exact schema named by the receipt and does not permit relabeling between them.
Supplying `--candidate-executable-env` during validation or bridge construction
re-observes the executable bytes and version output and requires an exact match
with v1.2. Without that optional input, replay proves receipt cross-field and
retained-byte integrity only; it does not independently re-observe the runner.
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
SRT_PDF_CANDIDATE_EXECUTABLE=/private/bin/candidate \
SRT_PDF_CANDIDATE_MODEL_CACHE_HOME=/private/model-cache \
  npm run pdf:eval:target-free -- run \
  --manifest /private/blind-manifest.json \
  --input-root-env SRT_PDF_TARGET_FREE_INPUT_ROOT \
  --adapter-env SRT_PDF_TARGET_FREE_ADAPTER \
  --raw-output-dir-env SRT_PDF_TARGET_FREE_RAW_OUTPUTS \
  --candidate-id example \
  --candidate-version 1 \
  --candidate-executable-env SRT_PDF_CANDIDATE_EXECUTABLE \
  --candidate-model-cache-home-env SRT_PDF_CANDIDATE_MODEL_CACHE_HOME \
  --out /private/example-target-free-receipt.json
```

The adapter receives those two resolved paths only in its minimal child
environment. It must echo the executable SHA-256 and the observed numeric
version/version-output SHA-256 in `runtimeIdentity.tool`; the runner rejects a
mismatch. Model-cache contents remain explicitly unattested.

Replay the retained payloads before private scoring:

```bash
SRT_PDF_TARGET_FREE_ADAPTER=/private/model-adapter \
SRT_PDF_TARGET_FREE_RAW_OUTPUTS=/private/example-target-free-raw \
SRT_PDF_CANDIDATE_EXECUTABLE=/private/bin/candidate \
  npm run pdf:eval:target-free -- validate \
  --manifest /private/blind-manifest.json \
  --adapter-env SRT_PDF_TARGET_FREE_ADAPTER \
  --raw-output-dir-env SRT_PDF_TARGET_FREE_RAW_OUTPUTS \
  --candidate-executable-env SRT_PDF_CANDIDATE_EXECUTABLE \
  --receipt /private/example-target-free-receipt.json
```

### Target-free observation bridge

`tools/pdf-target-free-predictions.mjs` turns retained, target-free document
observations into the existing model-neutral fidelity-predictions contract.
The acquisition adapter must declare `format: "pdf-document-observations"` and
`formatVersion: "1.0.0"`, with its `output` conforming to
`docs/schemas/pdf-target-free-document-observations.schema.json` and the
cross-field joins named in that schema's root `$comment`. The runtime validator
enforces those joins: object IDs are unique, reading order contains every
object exactly once, pages stay within the evaluated source, and relationships
are unique, non-reflexive, and reference known objects.

That document graph contains only normalized objects, a complete object
reading order, and typed object-to-object relationships:

```json
{
  "schemaVersion": "1.0.0",
  "objects": [
    {
      "id": "candidate-object-1",
      "page": 1,
      "kind": "table",
      "label": "semantic-table",
      "box": [0.1, 0.2, 0.6, 0.2]
    }
  ],
  "readingOrder": ["candidate-object-1"],
  "relationships": []
}
```

`kind` is the page-detection class; `label` is the candidate's semantic
classification. The adapter decides both before receiving any eval case,
target, page, box, stratum, or gold answer. Any candidate can emit this graph;
the bridge contains no MinerU-, Docling-, PaddleOCR-, GROBID-, or
deterministic-parser-specific parsing.

The bundled MinerU module exports
`mineruContentToTargetFreeObservations(...)` as a candidate-specific conversion
helper. It strips native text, formulas, paths, and table HTML after deriving
objects and order. It deliberately emits no ownership relationships today:
MinerU content lists can embed caption text inside an image record without an
independently grounded caption object or box. The bridge therefore scores such
caption-ownership cases as missing instead of inventing geometry.

After acquisition, the bridge validates the sanitized receipt and every
retained byte hash, requires exact source identity for each eval document, and
then applies one fixed geometry-only binding policy. Detection returns every
candidate object on the case page. Other boxed targets are matched one-to-one
by overlap without consulting target kinds or expected answers. The binding
score is `0.7 × target coverage + 0.2 × IoU + 0.1 × object coverage`. A match
must beat its next candidate by at least `0.05`, and an object may bind at most
one target; ties, near-ties, and collisions are omitted. Classification uses
the matched object's `label`, reading order uses the candidate's complete
order, and relationships use only candidate-declared graph edges. Boxless
targets, missing observations, ambiguous collisions, and dangling graph
references fail closed instead of being inferred.

Build canonical predictions from a retained run:

```bash
SRT_PDF_TARGET_FREE_RAW_OUTPUTS=/private/example-target-free-raw \
SRT_PDF_CANDIDATE_EXECUTABLE=/private/bin/candidate \
  npm run pdf:eval:target-free-predictions -- build \
  --eval-manifest benchmarks/pdf/fidelity-eval-v1.json \
  --target-free-manifest /private/blind-manifest.json \
  --receipt /private/example-target-free-receipt.json \
  --raw-output-dir-env SRT_PDF_TARGET_FREE_RAW_OUTPUTS \
  --candidate-executable-env SRT_PDF_CANDIDATE_EXECUTABLE \
  --out /private/example-target-free-predictions.json
```

Then use the unchanged scorer:

```bash
npm --silent run pdf:eval -- \
  --manifest benchmarks/pdf/fidelity-eval-v1.json \
  --predictions /private/example-target-free-predictions.json \
  --out /private/example-target-free-eval-receipt.json
```

The prediction `adapterSha256` is a canonical combination of the acquisition
adapter source identity and the bridge's own transitive source identity, so a
change to either rotates the normalized candidate identity. Keep the
acquisition receipt and retained outputs with the predictions: the common
predictions schema does not embed their raw-output hashes.

This closes the mechanical raw-output-to-scorer gap, not the benchmark
governance gaps. The bridge runs after candidate output is frozen, but the
current public manifests expose labels and the current acquisition receipt has
no independent runtime, checkpoint, filesystem, or network attestation. Its
results remain development calibration and are never promotion authority.

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

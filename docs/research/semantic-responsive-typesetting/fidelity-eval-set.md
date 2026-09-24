# Scholarly PDF fidelity eval set

The corpus audit and strict comparator answer whether output is deterministic,
structurally valid, and directionally non-regressing. They are not accuracy
oracles. `benchmarks/pdf/fidelity-eval-v1.json` adds a separate, versioned layer
of bounded source-to-output decisions for comparing the current deterministic
pipeline with future layout, OCR, formula, or multimodal models.

The failure-driven calibration seed contains 29 cases on four public arXiv paper identities:
`2408.10903v5`, `2412.13575v1`, `2210.06774v3`, and `2502.00873v1`. It covers
15 observed strata: front-matter roles, note ownership, visual boundaries,
caption boundaries and ownership, grouped display math, equation-number
ownership, figure-content ownership, column order, heading roles, table
boundaries and structure, reference scope, document invariants, and
semantic-type confusion. It contains public identifiers, byte lengths,
SHA-256 identities, page numbers, normalized geometry, safe labels, and
relationships. It contains no PDF bytes, source prose, formulas, local paths,
model output text, or generated EPUBs.

## Versioned governance, provenance, and splits

`benchmarks/pdf/reconstruction-eval-contract-v1.json` is the machine-readable
governance envelope for the current benchmark family. Its schema is
`docs/schemas/pdf-reconstruction-eval-contract.schema.json`. The envelope
binds:

- the raw-file and canonical SHA-256 identities of
  `corpus-contract-v1.json`;
- the raw-file, document-set, case-set, and canonical SHA-256 identities of
  `fidelity-eval-v1.json`;
- all 29 source-reviewed first-failure annotations in
  `fidelity-eval-observations-v1.json`;
- the implemented objective binary evaluators and their implementation entry
  points; and
- explicit data-governance, split, judge-validation, and saturation status.

The available lanes have different jobs and must not be pooled into one vanity
score:

| Lane                      | Role                                         | Size                       | Labels exposed?        |
| ------------------------- | -------------------------------------------- | -------------------------- | ---------------------- |
| Public calibration        | Failure-driven parser/model development      | 4 papers, 29 bounded cases | Yes                    |
| Frozen regression         | Whole-paper integrity and non-regression     | 10 executions              | No bounded gold labels |
| Seeded-random discovery   | Whole-paper robustness and failure discovery | 10 executions              | No bounded gold labels |
| Independent blind holdout | Candidate-independent final measurement      | Not built                  | N/A                    |
| Judge train/dev/test      | Future subjective-judge calibration          | Not built                  | N/A                    |

The two ten-paper lanes in the frozen v1 governance are 20 executions over
**18 distinct paper identities**, not 20 unique papers: `2405.07987v5` and
`2507.21509v3` appear in both. The overlap is frozen in the governance contract
instead of being hidden by the aggregate run count.

The additive `corpus-contract-v2.json` and
`reconstruction-eval-contract-v3.json` preserve those historical bytes while
adding a seeded-random lane selected only after frozen-set IDs are excluded.
That lane is set-disjoint, so the current whole-paper robustness run covers 20
distinct identities. It remains development discovery/regression evidence,
not a blind holdout or promotion authority.

This is a calibration seed, not a saturated benchmark or publication
acceptance claim. Expand it by reviewing representative outputs until roughly
100 bounded traces have been labeled and the final 20 reveal no new failure
class. Keep random cases alongside complaint-driven, outlier, and
failure-stratified samples. New or materially changed annotations create a new
eval-set version; never rewrite a frozen result to make a candidate pass.

The latest whole-paper error-analysis round read the complete
`2502.00873v1` source and EPUB rather than sampling only the originally
reported pages. Its first-failure annotations exposed four strata not fully
represented by v1: contiguous section-subtree order across columns,
bibliography entry cardinality across column/page boundaries, source-backed
float resumption and section containment, and two-dimensional inline formula
layout. These belong in a new eval-set version after their source-only boxes
and relationships receive independent review; they must not be backfilled
into the frozen v1 manifest. Until that expansion and a final no-new-class
window, a passing v1 score remains calibration evidence only.

The July failure-driven expansion adds source-verified decisions for the P0
classes observed during whole-paper review:

- `2408.10903v5` page 3: Table 1 must include its header row and expose
  semantic table structure.
- `2502.00873v1` page 14: Figures 15-18 and all four complete captions form
  page-complete detection gold. Within that set, Figure 16 must remain isolated
  from neighboring columns and own its complete caption.
- `2412.13575v1` page 6: Equation 4 owns its equation number, while the
  following block remains prose rather than an ordered-list item.
- `2502.00873v1` pages 5, 12, and 13: a numbered task is an ordered-list item,
  appendix headings and prose end reference scope, and a decimal chart tick is
  chart content rather than a footnote.
- `2502.00873v1` page 1: internal diagram text belongs to Figure 1 and must not
  be injected into body prose.
- `2502.00873v1` pages 5 and 12: the large numbered Section 5 title remains a
  heading, the numbered algorithm steps remain list items, and a lowercase
  continuation near an equation remains prose.
- `2502.00873v1` page 7: Equation 3 includes the complete source-backed display
  envelope rather than leaving detached operator glyphs in prose.
- `2502.00873v1` pages 14 and 15: the four figure groups follow logical
  left-column-before-right-column reading order, and Figure 19 owns its full
  three-line caption.

These are bounded annotations, not end-to-end paper grades. The source PDFs
were hash-verified, the named pages were rendered for visual review, and each
box was normalized from source-page coordinates. New target and object IDs are
deliberately opaque. Reviewer-readable case IDs name only public paper, page,
and failure class; the local runner replaces them before an adapter executes.
The complete 29-case source-only audit also checked every detection page for
same-label completeness. It corrected the Section 3.2 heading box on
`2210.06774v3` page 3 from unrelated continuation prose to the source heading's
normalized glyph bounds; no candidate prediction was consulted when making
that correction.

## Additive v2 cases

The frozen v1 files remain byte-identical. The complaint-driven whole-output
audit is captured separately in `benchmarks/pdf/fidelity-eval-v2.json`, whose
schema is `docs/schemas/pdf-fidelity-eval-set-v2.schema.json`. V2 explicitly
binds the v1 raw-file and canonical identities and adds three critical
calibration cases:

- a six-anchor `2502.00873v1` figure-order case spanning source pages 16–20,
  bounded to Figures 21, 22, 23, 24, 29, and 30; this subset is sufficient to
  detect the observed cross-page inversions without claiming all 42 figures
  were independently annotated;
- the `2502.00873v1` page-5 inline-stacked fragment that must not become a
  standalone display equation; and
- the `2412.13575v1` page-3 superscript whose source glyphs form one contiguous
  token rather than a token with an invented internal space.

Every v2 target has its own one-based `sourcePage` plus normalized source box.
That is the only annotation-schema change needed for a reading-order case to
span pages. Gold-stripped adapter request `1.2.0` preserves those page numbers
and boxes while replacing semantic kinds and IDs; v1 continues to use request
`1.1.0`. All-pairs scoring is unchanged, so moving even one bounded figure
anchor across another produces a failing critical case.

The additive observation file is
`benchmarks/pdf/fidelity-eval-observations-v2.json`. Unlike the source-only v1
review, these three cases were selected after inspecting candidate output.
Their labels were then checked against the hash-pinned source pages. The
observation metadata says so explicitly: this is complaint-driven public
calibration, not a blind holdout. V1 plus v2 now contain 32 labelled bounded
cases across 18 strata, still far below the approximate 100-case saturation
target, with no final 20-case no-new-class window.

`benchmarks/pdf/reconstruction-eval-contract-v2.json` binds those additive
artifacts and their schemas while extending the exact v1 governance contract.
It also records a deliberate gap: profile-level wide-visual legibility is not
yet a labelled model-neutral case. A defensible binary evaluator needs an exact
official profile/version and viewport, a rendered-artifact SHA-256,
`scrollWidth`/`clientWidth`, a minimum cell inline size, and a clipping/overflow
assertion. The current prediction envelope binds none of those rendition
measurements, so assigning a passing label now would invent evidence.

## Common candidate contract

Every parser or model adapter emits
`docs/schemas/pdf-fidelity-predictions.schema.json`. Each case returns one of
four objective task shapes:

- `classification`: `{ "labels": [{ "targetId", "label" }] }`
- `detection`: `{ "objects": [{ "id", "label", "box" }] }`
- `reading-order`: `{ "order": ["target-id", "..."] }`
- `relationship`: `{ "relationships": [{ "type", "sourceId", "targetId" }] }`

The seed's objective label vocabulary includes `heading`, `prose`, `footnote`,
`ordered-list-item`, `chart-axis-tick`, `numeric-range`, `semantic-table`, and
`not-duplicated`. Detection labels are `figure`, `table`, `caption`, and
`equation`. Typed ownership edges include `note-body-of`, `caption-of`,
`equation-number-of`, and `figure-internal-text-of`. Adapters may emit other
observed classes, but the label-scoped scorer evaluates only the frozen class
for a detection case.

Detection uses deterministic, label-scoped greedy IoU matching at the seed's
strict `0.8` threshold: unrelated object classes on the same page are ignored,
while omitted material, excessive bounds, duplicate candidates, and extra
objects of the evaluated class are penalized. Classification
uses exact target-label decisions. Reading order scores all expected pairs and
penalizes omissions. Relationships use exact typed edge precision, recall, and
F1. Missing cases fail closed. The receipt reports per-case, per-task, and
per-stratum scores; all critical cases must pass under the seed policy.

A detection case must therefore annotate every object of its evaluated label
on that page. The page-14 figure and caption cases include all four source
objects of each label. The adapter still receives no detection targets or
boxes, so a target-independent full-page detector is neither filtered toward a
single gold object nor penalized for returning other correct same-label
objects.

The candidate envelope records safe `id`, `version`, `format`,
`formatVersion`, and `adapterSha256` fields. For local execution,
`adapterSha256` is the SHA-256 of a canonical source manifest containing the
adapter entry point and every statically imported, literal dynamic-imported,
and local Vite-loaded transitive module. For every traversed local module,
identity schema `1.1.0` binds its nearest `package.json`, then walks from that
package root to the nearest ancestor lock root and binds that root's
`package.json` plus every adjacent supported package-manager lockfile:
`bun.lock`, `bun.lockb`, `npm-shrinkwrap.json`, `package-lock.json`,
`pnpm-lock.yaml`, and `yarn.lock`. This covers nested workspace roots and local
imports that cross into sibling packages. Canonical relative names are deduped
and ordered by package root, with `package.json` followed by the fixed lockfile
order above. Supported metadata must be a regular non-symlink file; a symlink
or other non-file fails closed with `INVALID_ADAPTER_PACKAGE_METADATA`.

The identity does not resolve or read `node_modules`; even an explicit local
source reference into that directory fails with
`ADAPTER_SOURCE_NODE_MODULES_NOT_ALLOWED`. A change to an applicable lockfile
therefore rotates the digest without hashing an installed dependency tree. For
example, a MinerU wrapper can declare `format: "mineru-content-list"` and
`formatVersion: "3.1-content-list-v1"` while converting native
`page_footnote`, `equation`, `image`, and `table` objects into the common task
shapes. Unknown native fields and raw `text`, `table_body`, image paths, and
formula strings stay owner-local and never enter predictions or receipts. The
harness does not depend on MinerU and accepts the same bounded contract from
the deterministic parser, Docling, PaddleOCR-VL, GROBID-assisted pipelines, or
future models.

The bundled deterministic adapter reports `formatVersion: "1.1.0"`; the
bundled MinerU adapter reports
`formatVersion: "content-list-v1-v2-adapter-1.1.0"`. Those output-format
versions are distinct from adapter source-identity schema `1.1.0`;
`adapterSha256` supplies the source, package-manifest, and lockfile binding.
Because the source-identity schema version and canonical `packageFiles` payload
are themselves digest inputs, moving from schema `1.0.0` to `1.1.0` rotates
every adapter digest even when source bytes are unchanged. Regenerate and
review any stored baselines, predictions, and receipts; pre-`1.1.0`
`adapterSha256` values are not reusable.

Score an already normalized candidate:

```bash
npm --silent run pdf:eval -- \
  --manifest benchmarks/pdf/fidelity-eval-v1.json \
  --predictions /private/evals/mineru-predictions.json \
  --out /private/evals/mineru-receipt.json
```

## Development calibration versus promotion evidence

The evaluator has two explicit modes, distinguished by `execution.lane`:

- `score` produces an `external-predictions` receipt for public development
  calibration. Its `passed` value means only that the imported predictions met
  the frozen scoring thresholds. `promotionEligible` is always `false`, even
  when the score passes and the imported candidate reports a runtime identity.
- `local` produces a `local-mac` calibration receipt after the runner verifies
  every hash-pinned input and records the canonical adapter source/package
  SHA-256.
  Tool and model hashes in the current adapter protocol are still supplied by
  that adapter, so the receipt records
  `runtimeIdentityAuthority: "adapter-self-reported"`. The runner cannot yet
  independently prove which executable and checkpoint produced the output.
  Consequently every current local receipt has `promotionEligible: false` and
  `passed: false`, even when all accuracy cases score perfectly.

Receipt schema `1.2.0` makes that authority boundary explicit, requires
`promotionEligible: false`, and binds both values into the receipt hash.
Imported predictions and verified-input local runs remain useful calibration
evidence, but comparison is evaluation-only and cannot pass promotion today.
Pre-`1.2.0` receipts are rejected with
`PDF_FIDELITY_PROMOTION_RECEIPT_V1_2_REQUIRED`; regenerate or re-score the
predictions instead of treating an adapter-attested receipt as release
evidence. Promotion must stay closed until a trusted runner independently
verifies the executable, model artifact, and isolated execution environment.

These controls harden provenance for repeatable development decisions. They do
not make the public v1 manifest a blinded benchmark: documents, case identities,
and annotations are available for repeated calibration and may influence
implementation. A future blinded holdout must keep its sampled documents and
labels private through candidate freeze, execute independently of the candidate
owner, and disclose results only after scoring. No such holdout is implemented
by this repository today.

## Native-reader promotion evidence

Browser rendering is supplementary and never substitutes for native-reader
promotion evidence. The readiness registry requires one hash-bound
`pdf-benchmark-native-reader-execution-receipt` for the same exact EPUB
artifact from each of Apple Books, an independent desktop EPUB reader, and the
target e-ink reader or device. The registry first binds immutable export
evidence: its own file hash, a retained repository EPUB artifact hash, and an
repository-bound export receipt whose canonical identity is checked. Each
reader has a separately hash-bound reader/device identity record and execution
receipt; that receipt references the identity, export-evidence, and export-
receipt file hashes plus the verified receipt identity and exact EPUB digest.
Chromium and WebKit are not accepted reader types for these fields. A `.epub`
suffix is insufficient: the retained bytes must be a ZIP EPUB with stored first
`mimetype`, `META-INF/container.xml`, and an existing OPF rootfile.

The export evidence also binds a successful repository-hash-bound EPUBCheck
execution receipt for that exact digest. Its exact fields include checker
identity and version, deterministic input/output identities, and passed status;
missing, forged, mismatched, or failed receipt evidence blocks promotion.
The checker identity/version must equal the repository-bound
`src/publication/toolchain-manifest.json` EPUBCheck package/JAR pin, and its
output identity is the canonical hash of a separate bound execution transcript
recording the `epubcheck` command, exact artifact digest, exit code, status, and
stdout/stderr digests.

These repository-bound artifacts are structurally validated evidence only.
They do not prove that a named native reader or EPUBCheck actually executed;
until a separate trusted attestation verifier is implemented, readiness records
`trustedAttestationVerified: false`, reports no promotion-authoritative reader
verification, and remains blocked even for a complete structurally valid bundle.

Until that external evidence exists, each registry entry remains
`unavailable-blocker` with no receipt. That state is intentional and keeps
promotion closed rather than turning browser fixture coverage into a false
native-reader claim.

Compare an imported or local baseline with a local candidate on the exact same
frozen source and case identity:

```bash
npm --silent run pdf:eval:compare -- \
  --manifest benchmarks/pdf/fidelity-eval-v1.json \
  --baseline /private/evals/deterministic-calibration-receipt.json \
  --baseline-predictions /private/evals/deterministic-predictions.json \
  --candidate /private/evals/mineru-fidelity-v1/eval-receipt.json \
  --candidate-predictions /private/evals/mineru-fidelity-v1/predictions.json \
  --out /private/evals/deterministic-vs-mineru.json
```

The comparison reports every case delta, but its promotion result remains false
under receipt `1.2.0`. Runtime and cost belong in a separate benchmark; they are
deliberately excluded from the deterministic accuracy receipt.

### Aggregate public-calibration suite

`tools/pdf-fidelity-suite.mjs` joins the frozen v1 and additive v2 manifests,
their observation companions, and both governance contracts without changing
the frozen inputs. It validates the supplied baseline and candidate receipts
against their exact normalized predictions, then emits one canonically hashed
receipt with all 32 cases. Every case carries its source-reviewed
`failureMode`, candidate `passed` result, baseline/candidate score, and delta;
failure-mode aggregates report pass/fail counts and regressions.
The strict output contract is
`docs/schemas/pdf-fidelity-suite-receipt.schema.json`.

```bash
npm --silent run pdf:eval:suite -- \
  --baseline-v1-receipt /private/evals/baseline-v1/eval-receipt.json \
  --baseline-v1-predictions /private/evals/baseline-v1/predictions.json \
  --baseline-v2-receipt /private/evals/baseline-v2/eval-receipt.json \
  --baseline-v2-predictions /private/evals/baseline-v2/predictions.json \
  --candidate-v1-receipt /private/evals/candidate-v1/eval-receipt.json \
  --candidate-v1-predictions /private/evals/candidate-v1/predictions.json \
  --candidate-v2-receipt /private/evals/candidate-v2/eval-receipt.json \
  --candidate-v2-predictions /private/evals/candidate-v2/predictions.json \
  --out /private/evals/baseline-vs-candidate-suite.json
```

`accuracyPassed` applies each eval manifest's objective scoring policy without
conflating it with release authority. `nonRegressionPassed` requires every
bounded candidate score to be at least its baseline score.
`promotionEligible` is always `false`. The suite is public development
calibration: its labels are exposed, v2 was complaint-driven, and the receipt
explicitly records `blindHoldout: false`.

For future parser/model comparisons, the original schema-1 sidecar and frozen
v1/v2 governance contracts remain byte-for-byte available. New runs use the
additive governance artifact
`benchmarks/pdf/fidelity-comparator-contract-v2.json` and strict schema
`docs/schemas/pdf-fidelity-comparator-run-receipt-v2.schema.json`. The new
contract binds both unchanged evaluation contracts instead of rewriting their
published hashes. It requires path-safe provider/model identities, explicit
identity authority, adapter ID/version/source hash, and prompt/config/seed
SHA-256 digests. The runner receives the exact prompt, config, and seed
artifacts and verifies their bytes against those digests. Runtime tool/model
identity is copied from the validated predictions rather than accepted from the
run specification. The adapter source digest is still supplied by those
predictions, so it is explicitly labeled `predictions-self-reported`.

Provider, model, and network claims are either visibly
`run-spec-self-asserted` or
`caller-bound-unverified-artifact`. In the latter case the runner proves only
that the exact caller-supplied bytes match the declared digest; it does not
authenticate the bytes or infer that they prove the claim. Network status can
therefore be only `none`, `cooperative-offline-flags`, or
`caller-claimed-isolated-unverified`—never independently verified. Latency and
cost use the same authority labels. Their aggregates are derived from the
run-spec samples, but any bound evidence artifact remains unparsed and the
reported measurements remain caller assertions. The sidecar also binds input
identity, repeat/warmup counts, latency scope plus sample
count/p50/p95/mean/total, USD cost with an explicit attribution basis and
nullable token counts, and the deterministic accuracy-receipt SHA-256.

The performance sidecar is intentionally never promotion-authoritative.
Latency and cost are empirical and may vary while objective accuracy remains
identical; they must not be folded into a semantic-fidelity score or used to
rewrite a frozen label. Missing provenance digests, provider/model identity,
runtime identity, required prompt/config/seed bytes, latency, or cost makes the
schema-2 sidecar invalid. A hash without its corresponding caller-supplied
artifact is rejected. Establishing authenticated provider/model identity,
independently enforced isolation, or independently measured latency/cost would
require a separate signed verifier protocol and a future schema version.

## Local-Mac-first runner

The local runner keeps model execution and document bytes on the owner's Mac.
Put the exact hash-pinned PDFs in an external owner-local directory using their
public filenames. Point environment variables at that directory and at a
trusted executable adapter:

```bash
export SRT_PDF_EVAL_ROOT=/private/papers/fidelity-v1
export SRT_PDF_EVAL_ADAPTER=/private/adapters/mineru-content-list-wrapper

npm --silent run pdf:eval:local -- \
  --manifest benchmarks/pdf/fidelity-eval-v1.json \
  --input-root-env SRT_PDF_EVAL_ROOT \
  --adapter-env SRT_PDF_EVAL_ADAPTER \
  --candidate-id mineru \
  --candidate-version 3.1.14-MinerU2.5-Pro-2604-1.2B \
  --out /private/evals/mineru-fidelity-v1
```

Paths are supplied through environment-variable names rather than command-line
values. Before invoking the adapter, the runner verifies every file's byte
length and SHA-256. It invokes the adapter as an executable without a shell,
discards stdout/stderr, passes a minimal environment, and requests cached-model
offline modes with `SRT_PDF_EVAL_OFFLINE=1`, `HF_HUB_OFFLINE=1`, and
`TRANSFORMERS_OFFLINE=1`. The ephemeral request contains local paths but no
gold answers and is deleted after the run. The new external output directory is
owner-only and contains only normalized `predictions.json` and
`eval-receipt.json`.

The `local-mac` lane is deliberately fail-closed and currently never
promotion-eligible. The command still writes normalized predictions and the
sanitized receipt, then exits nonzero because `passed` is false. The offline
request flags remain cooperative controls and do not substitute for an
independently isolated runtime. `--allow-non-darwin` exists only for test and
adapter-development calibration; it never creates promotion evidence.

The adapter receives:

```text
adapter --request /owner-only/ephemeral/request.json \
        --output /owner-only/ephemeral/predictions.json
```

The 1.1 request includes verified local document paths, source hashes, page
counts, and gold-stripped public regression cases. It removes `expected` and
`critical`, replaces case
and target IDs with deterministic opaque IDs, replaces non-detection target
kinds with `candidate`, and sends detection cases with no targets or boxes.
The runner restores the public manifest IDs only after the adapter exits. The adapter must bind its
output to the request's eval-set SHA-256, candidate identity, and its own
supplied digest. The runner rejects an identity mismatch, unexpected prediction
shape, missing input, symlink, in-repository private input, existing output
directory, request-mapping mismatch, or adapter failure.

The offline environment variables are a cooperative local-runtime boundary,
not an operating-system network sandbox. Use a trusted adapter or run it inside
an independently network-isolated local container when that boundary matters.

This is a public, gold-stripped calibration regression, not a blind or held-out
evaluation. The manifest is public, its opaque IDs are deterministic, and
non-detection cases still include normalized target geometry so an adapter can
bind its observations to the requested objects. The current runner does not
provide held-out container isolation, and the bundled adapters' geometry-based
target matching is not a fully target-independent end-to-end evaluation. A
separate private held-out set and independently network-isolated execution are
still required for claims beyond regression calibration.

### Bundled deterministic baseline adapter

`tools/pdf-deterministic-eval-adapter.mjs` runs the current in-repository PDF
reconstruction pipeline against the same gold-stripped public request used for external
models. It first builds target-independent page observations: parser-backed
semantic regions, complete matched visual objects, note/caption edges, reading
order, numeric-range spans, and document invariants. Detection emits every
observed object on the requested page because the request withholds detection
targets completely. Other tasks bind opaque candidates by geometry only after
the observations exist.

```bash
export SRT_PDF_EVAL_ROOT=/private/papers/fidelity-v1
export SRT_PDF_EVAL_ADAPTER="$PWD/tools/pdf-deterministic-eval-adapter.mjs"

npm --silent run pdf:eval:local -- \
  --manifest benchmarks/pdf/fidelity-eval-v1.json \
  --input-root-env SRT_PDF_EVAL_ROOT \
  --adapter-env SRT_PDF_EVAL_ADAPTER \
  --candidate-id srt-deterministic \
  --candidate-version <exact-git-revision> \
  --out /private/evals/srt-deterministic-fidelity-v1
```

The adapter verifies the reconstruction source digest, byte length, and page
count against the runner's already hash-pinned documents. Visual objects,
reading order, and ownership edges are emitted only from relationships accepted
by the same full provenance validator used by readable EPUB projection.
A table is called `semantic-table` only when that validator accepts its exact
source-run ownership, canonical cell structure, XHTML asset integrity, and
node/relationship linkage. This prevents an in-memory rectangular table from
scoring as semantic when export would omit it. Candidate labels and detection
boxes still come from reconstruction evidence rather than target descriptors.

This bundled adapter is deterministic and correctly reports
`runtimeIdentity.status: "not-applicable"`; it therefore cannot produce passing
promotion evidence in the `local-mac` lane. Its normalized `predictions.json`
remains useful as a baseline. Re-score that file with `pdf:eval` when a
score-passing `external-predictions` calibration receipt is useful, while
retaining the local receipt as evidence that the private inputs were verified.

### Bundled MinerU adapter

`tools/pdf-fidelity-mineru-adapter.mjs` is the first-party local adapter for
MinerU `content_list.json` plus `content_list_v2.json`. It is executable, so the
local runner can use it directly:

```bash
export SRT_PDF_EVAL_ROOT=/private/papers/fidelity-v1
export SRT_PDF_EVAL_ADAPTER="$PWD/tools/pdf-fidelity-mineru-adapter.mjs"
export SRT_MINERU_MODEL_ID=MinerU2.5-Pro-2604-1.2B
export SRT_MINERU_MODEL_SHA256=<sha256-of-the-exact-local-checkpoint>

npm --silent run pdf:eval:local -- \
  --manifest benchmarks/pdf/fidelity-eval-v1.json \
  --input-root-env SRT_PDF_EVAL_ROOT \
  --adapter-env SRT_PDF_EVAL_ADAPTER \
  --candidate-id mineru \
  --candidate-version 3.1.14-MinerU2.5-Pro-2604-1.2B \
  --out /private/evals/mineru-fidelity-v1
```

The runner supplies the gold-stripped public 1.1 request and all three offline flags. For
each uncached source page, the adapter invokes `mineru` from `PATH` with
`vlm-auto-engine`, formula, table, and image analysis enabled. Its default
owner-local cache is
`~/Library/Caches/ernie-sg/mineru-content-list/mineru-content-list-cache-v3/<identity-sha256>/<source-sha256>/p<page>/`.
The identity digest covers the declared candidate, the resolved `mineru`
executable's actual byte digest and observed `--version` output, the explicit
model/checkpoint ID and digest, canonical transitive adapter-source digest and
format version, backend, and the formula/table/image-analysis configuration.
Every page directory also contains an exact `cache-identity.json` metadata
record using cache schema `1.1.0` and binding that identity to the source
digest and one-based page. MinerU's
page-local `page_idx: 0` therefore cannot silently migrate across papers,
pages, model versions, adapters, backends, or parser configurations. Old
unversioned and `cache-v2` entries are intentionally not reused.

For adapter development, the same executable accepts one request on stdin and
an explicit external cache:

```bash
env SRT_PDF_EVAL_OFFLINE=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  npm --silent run pdf:eval:mineru-adapter -- \
  --output /private/evals/gold-stripped-predictions.json \
  --cache-root /private/cache/mineru < /private/evals/gold-stripped-request.json
```

Raw prose, formulas, table HTML, captions, image paths, and document paths are
used only inside the local process. The normalized response contains opaque
case/target bindings, adapter-owned object IDs, native normalized bounding
boxes, and bounded labels/edges. It rejects any request containing an
`expected` key and verifies that the runner's adapter digest matches its own
independently recomputed canonical source/package manifest before emitting
predictions.

The adapter deliberately omits tasks that MinerU does not ground in the
content-list schemas, including document-wide duplication invariants and
boxless numeric-span classification. Multi-panel figures merge only when
adjacent native image regions share strong horizontal overlap and native
subpanel/global-caption evidence. Display equations merge only for adjacent,
aligned native equation regions with a native equation tag. A table is called
`semantic-table` only when MinerU supplies multi-row, multi-cell HTML. These
rules fail closed rather than inventing content. Offline environment flags are
still cooperative controls, not an OS network sandbox.

If either model identity variable is absent, the adapter records the runtime as
`unattested`. If both are present, the runtime identity is still explicitly
adapter-self-reported. Neither state can pass promotion. The checkpoint digest
is an operator assertion that the adapter binds and reports, but the current
runner cannot independently prove that MinerU loaded those exact weights. The
executable digest is observed by the adapter from the binary it invokes, not by
an external verifier.

## Receipt and review policy

`docs/schemas/pdf-fidelity-eval-receipt.schema.json` receipts exclude hostnames,
timestamps, latency, source text, formula text, paths, and raw model payloads.
They bind the eval-set, document-set, case-set, predictions, candidate version,
canonical adapter source/package manifest, execution lane, and bounded scores
by SHA-256. Same inputs and normalized predictions therefore produce the same
receipt.

Receipt validation requires the frozen eval manifest and the exact normalized
predictions artifact. It rescores those predictions, rederives immutable case
metadata, every task/stratum aggregate and rate, and the top-level policy
result; comparison validation rederives the entire comparison from two
manifest-and-prediction-validated receipts. The SHA-256 fields are
deterministic evidence identities, not signatures or proof against an attacker
who controls every input artifact.

A green seed receipt means only that the candidate matches these frozen bounded
decisions. Promotion still requires the existing structural/EPUB gates,
side-by-side human review of changed critical cases, and a larger annotated set
with held-out coverage. A model's own output may never become ground truth
without independent review.

## License and privacy boundary

Public arXiv identifiers do not imply a repository-wide redistribution
license. The benchmark therefore makes no license assertion for the paper
PDFs, commits no paper bytes, and requires the operator to obtain and use every
paper under its source terms. Hash-pinned paper inputs stay owner-local.
Repository-owned generated fixtures are separately identified as CC0 in
`tests/fixtures/pdf/manifest.json`.

Private inputs and comparison runs must keep PDF bytes, source prose, formulas,
screenshots, local paths, and raw model payloads out of committed manifests and
sanitized receipts. Provider/model/version, aggregate latency, and cost are
allowed only in the comparator sidecar because they describe the execution
identity without reproducing paper content.

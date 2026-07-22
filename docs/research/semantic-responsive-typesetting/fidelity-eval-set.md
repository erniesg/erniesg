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

This is a calibration seed, not a saturated benchmark or publication
acceptance claim. Expand it by reviewing representative outputs until roughly
100 bounded traces have been labeled and the final 20 reveal no new failure
class. Keep random cases alongside complaint-driven, outlier, and
failure-stratified samples. New or materially changed annotations create a new
eval-set version; never rewrite a frozen result to make a candidate pass.

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
and local Vite-loaded transitive module. A dependency-only change therefore
rotates the identity even when the executable entry point is unchanged. For
example, a MinerU wrapper can
declare `format: "mineru-content-list"` and
`formatVersion: "3.1-content-list-v1"` while converting native
`page_footnote`, `equation`, `image`, and `table` objects into the common task
shapes. Unknown native fields and raw `text`, `table_body`, image paths, and
formula strings stay owner-local and never enter predictions or receipts. The
harness does not depend on MinerU and accepts the same bounded contract from
the deterministic parser, Docling, PaddleOCR-VL, GROBID-assisted pipelines, or
future models.

The bundled deterministic adapter reports `formatVersion: "1.1.0"`; the
bundled MinerU adapter reports
`formatVersion: "content-list-v1-v2-adapter-1.1.0"`. These 1.1 identities are
the first versions that bind the complete local transitive source manifest.

Score an already normalized candidate:

```bash
npm --silent run pdf:eval -- \
  --manifest benchmarks/pdf/fidelity-eval-v1.json \
  --predictions /private/evals/mineru-predictions.json \
  --out /private/evals/mineru-receipt.json
```

Compare two receipts on the exact same frozen source and case identity:

```bash
npm --silent run pdf:eval:compare -- \
  --manifest benchmarks/pdf/fidelity-eval-v1.json \
  --baseline /private/evals/deterministic-receipt.json \
  --baseline-predictions /private/evals/deterministic-predictions.json \
  --candidate /private/evals/mineru-receipt.json \
  --candidate-predictions /private/evals/mineru-predictions.json \
  --out /private/evals/deterministic-vs-mineru.json
```

The comparison reports every case delta and fails promotion when the candidate
does not pass the eval policy or regresses a critical case. Runtime and cost
belong in a separate benchmark; they are deliberately excluded from the
deterministic accuracy receipt.

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
count against the runner's already hash-pinned documents. Unresolved visual
relationships emit no object or caption edge, and a table is called
`semantic-table` only when the canonical reconstruction contains actual table
structure. This makes the receipt an honest baseline for parser failure modes,
with candidate labels and detection boxes coming from reconstruction evidence
rather than being copied from target descriptors.

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
independently recomputed canonical transitive source manifest before emitting
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
`unattested` and the receipt cannot pass promotion even when every bounded case
scores perfectly. The checkpoint digest is an explicit operator attestation:
the adapter binds and reports it but cannot independently prove that MinerU
loaded those exact weights. The executable digest is observed from the exact
resolved binary that the adapter invokes.

## Receipt and review policy

`docs/schemas/pdf-fidelity-eval-receipt.schema.json` receipts exclude hostnames,
timestamps, latency, source text, formula text, paths, and raw model payloads.
They bind the eval-set, document-set, case-set, predictions, candidate version,
canonical transitive adapter-source manifest, execution lane, and bounded
scores by SHA-256. Same inputs and normalized predictions therefore produce
the same receipt.

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

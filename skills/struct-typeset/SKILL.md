---
name: struct-typeset
description: Reconstruct and typeset source-backed PDF, DOCX, HTML, or scanned documents while preserving figures, diagrams, captions, tables, equations, footnotes, citations, hyperlinks, and multi-column reading order. Use when converting documents to EPUB or accessible HTML, diagnosing missing or flattened document structure, designing extraction adapters, or validating faithful visual fallbacks and provenance.
---

# Struct Typeset

Build outputs from a canonical, source-backed document graph. Prefer verified semantics; preserve the bounded source region whenever structure is ambiguous.

## Workflow

1. Inspect the source adapter and existing fixtures before changing extraction logic.
2. Extract text runs, glyph geometry, page objects, embedded assets, annotations, and links without assigning semantics prematurely.
3. Convert the extraction result with `src/struct/from-reconstruction.ts`. Keep extractor IDs only in evidence; expose stable STRUCT IDs in graph relationships.
4. Verify reading order, captions, notes, citations, tables, equations, and hyperlinks against source geometry and annotations.
5. Promote an object to semantic structure only when its evidence is sufficient. Otherwise retain a bounded source asset or page-region fallback with its caption and provenance.
6. Render from the STRUCT graph with `src/struct/xhtml.ts` or assemble an EPUB with `src/struct/epub.ts`. The compatibility exports in `src/research/epub.ts` accept `StructDocument`; extractor-private data is not needed on this path. Never drop an unresolved source obligation, invent a link destination, flatten a table into headings, or treat Markdown-like source text as markup without source evidence.
7. Present recovery through `src/struct/recovery.ts`. Keep machine codes in logs or review tooling; show users plain-language outcomes and actions.
8. Validate with diverse fixtures and inspect the produced EPUB or HTML, not only intermediate JSON.

## Model consultation boundary

Use deterministic extraction and validation first. When a bounded layout decision remains ambiguous, open a separate Codex task with `gpt-5.6-luna` and `max` reasoning. Supply only the deterministic candidates and their STRUCT provenance. Reject any response that invents text, bytes, bounds, or destinations. Persist the proposal separately from the autonomous VM implementation receipt, then convert every accepted decision class into a fixture and deterministic rule.

### Grounded PDF production binding

For ordinary incoming PDFs, freeze all enabled arms before extraction and build
one versioned `SourceEvidenceGraph`; do not promote any arm's Markdown or
resolved document tree directly to STRUCT.

- The deterministic arm is mandatory. Preserve PDF.js text/glyph runs and
  boxes, fonts, page rotation and geometry, raster/vector objects and their
  identities, annotations, destinations and links, full-page renders, and
  configured local OCR for scanned or hybrid regions on every page.
- The MinerU arm is mandatory and owner-local. Bind `mineru[vlm]==3.4.4`
  (wheel SHA-256
  `d4d678539782a7683d998e2914a52d96b5720676ce65658b29666b1f4d9dfd13`)
  with formulas/tables/image analysis enabled and model
  `opendatalab/MinerU2.5-Pro-2605-1.2B` at revision
  `bff20d4ae2bf202df9f45284b4d43681555a97ed`. The Apache-2.0 model's
  `model.safetensors` is 2,312,126,640 bytes with SHA-256
  `abf8681ca63b8dec7b67de257af47b821f179442f72998d0696ae2ed9232a5f0`.
  Record the Qwen2VL architecture and verify every identity before use. Prefer
  the owner-laptop MLX binding (`mlx-vlm==0.3.12`, `mlx==0.31.1`); use the
  trusted ARM64 VM only after an official CPU-only wheel, version, and digest
  have passed the same bounded preflight. No VM CPU binding is currently
  accepted merely because its package metadata names Torch. These are distinct
  execution identities over the same evidence schema. Never install the
  `pipeline`, `core`, or `all` extras for this binding.
- Preflight architecture, memory, free disk, package/model license, exact
  download sizes and digests, and a bounded cache outside the repository.
  Stop instead of downloading when the runtime, model, or generated-output
  bound would consume the reserved headroom. Do not substitute another model,
  revision, license, or remote provider.
- Retain MinerU Markdown, content-list v1/v2, middle/layout/model JSON, OCR,
  tables, formulas, figures/images, reading order, and page geometry as
  separate hashed candidates. Markdown is inspectable evidence, never the
  canonical representation. Preserve cross-arm and intra-arm disagreements.

Run the authenticated owner-local producer from a Node 22+ checkout only after
the pinned environment and model already exist:

```bash
PRIVATE_RUN_ROOT="$(mktemp -d /private/tmp/erniesg-mineru-runs.XXXXXX)"
chmod 700 "$PRIVATE_RUN_ROOT"
node --experimental-strip-types src/research/mineru-owner-local-runner.ts \
  --pdf /absolute/input.pdf \
  --run-root "$PRIVATE_RUN_ROOT" \
  --mineru /absolute/pinned-venv/bin/mineru \
  --python /absolute/pinned-venv/bin/python3.12 \
  --config /absolute/mineru.json \
  --model-root /absolute/pinned-model \
  --max-output-bytes 1073741824
```

The command creates a new 0700 run directory, forces offline resolution, opens
and hashes the source, installed package RECORD contents, runtime, backend,
model/config/cache, and normalized artifacts, and prints only hash receipts.
It is eligible as an authenticated producer only when it also completes the
sealed-execution gate: the measured runtime, model, source, and config are
copied/reflinked into that private run, sandboxed read-only, executed only from
the sealed paths, and remeasured afterward. The receipt retains the preflight
MinerU-config digest and complete runtime-tree inventory. The sealed runtime
must match that inventory, and an exact read-only copy of the preflight config
is retained alongside the separately hash-bound path-rebased execution config.
Private HOME, TMPDIR, raw output, and the actual allocated bytes of the sealed
runtime, model, source, and configs count against the owner-local 8 GiB ceiling,
including when reflink support falls back to an ordinary copy. A discovery
manifest from an older unsealed run is not this receipt. Model sealing keeps
its exact logical source-size cap separate from filesystem allocation: the
ordinary-copy allocation limit is the remaining global capacity after the
original cache, sealed runtime/source/configs, and reserved raw-output and
private HOME/TMP envelopes.
Keep the manifest and artifacts owner-local; pass the manifest to the
production assembler, which independently requires the deterministic arm and
authenticates the MinerU arm before building the graph. A caller-authored
manifest or declared provider identity is not sufficient.

This command runs only the MinerU provider arm. Scanned and hybrid inputs still
require configured owner-local OCR in the deterministic reconstruction
(`page.ocr`); `assembleProductionSourceEvidence` fails closed when that arm is
missing. This skill does not claim an OCR engine is installed or configured.

Reconciliation uses the local Codex app-server over an absolute owner-only Unix
socket (preferred) or a numeric/`localhost` loopback WebSocket only. The
executable Unix transport is `createOwnerLocalUnixSocketTransport` in
`src/research/local-codex-reconciliation.ts`; it requires a stable socket owned
by the current user with no group/other permissions, performs and authenticates
the app-server WebSocket upgrade over that Unix socket, and has no TCP fallback.
Start the measured local binary in a separate owner-local process:

```bash
PRIVATE_CODEX_SOCKET_DIR="$(mktemp -d /private/tmp/erniesg-codex.XXXXXX)"
chmod 700 "$PRIVATE_CODEX_SOCKET_DIR"
/absolute/measured/codex app-server \
  --listen "unix://$PRIVATE_CODEX_SOCKET_DIR/app-server.sock" \
  -c analytics.enabled=false
```

After the socket appears, set it to mode 0600 and bind its inode/device,
executable hash, initialized server identity, exact model ID/version and
reasoning effort in the reconciliation receipt. Use the existing ChatGPT login,
never an API key or hosted file-upload API. Isolate each document and attempt in
a fresh ephemeral thread; bind the request and response to the source, graph,
candidate-set, server, model, prompt, and tool hashes; enforce timeout,
interrupt, and idempotent replay; and keep logs limited to redacted identities,
hashes, counts, and terminal status. The model may select or relate frozen graph
candidates for reading order, semantic type, joins, captions/assets, tables,
formulas, notes/citations/links, and boilerplate. It may not supply new text,
asset bytes, bounds, destinations, labels, or scientific claims.
Send only opaque document/attempt hashes and a size-bounded trace for the
current candidate set: source-backed snippets, normalized boxes, relationship
and disagreement context, artifact hashes, a failed prior comparator receipt,
and matched source-PDF/rendered-EPUB crops with exact provenance. Both crop
classes are required. Never send the whole graph, a PDF, raw filesystem paths,
an unbounded page raster, or unrelated provider output. Exact resolver payload
bytes remain behind the owner-local boundary. The response may contain
candidate IDs or abstentions only.

Only the source-grounded verifier may materialize a reconciled candidate for
STRUCT. It must rebuild every accepted token and field from at least one frozen
source signal, check assets and bounds against source pixels/objects, and close
every source obligation exactly once. A source-backed figure may remain a
complete visual asset. A table/formula image preserves loss but leaves its
semantic obligation blocking. A full-page raster never counts as reconstructed
semantic text. It may close only an explicit source-preserved-page obligation
when the verifier matches the exact complete-page deterministic render and
bounded fallback asset. An ungrounded disagreement is a failed candidate, not
a successful review artifact.

The graph binds an exact normalized deterministic-context receipt covering the
PDF source identity, page geometry, source text/payloads and bounds, artifacts,
and candidates. IDs alone are never ownership evidence. When deterministic and
MinerU sources converge on one STRUCT owner, compare canonical unique owner
sets while retaining separate per-provider crosswalk hashes. Image-only links
must carry exact deterministic asset and native source-object IDs; rectangle
overlap is only a supporting check and cannot select between equal-overlap
assets.

### Closed evaluator loop

After each verified candidate, hand the immutable evidence-graph hash and typed
reader API to the evidence evaluator. Do not define or mutate its attempt trace,
comparator result, judge schema, refinement state machine, or browser evidence
inside this skill's parser-core lane. Continue from the evaluator's exact
hash-bound result: append a new reconciliation receipt and graph continuation;
never delete, rewrite, or launder earlier provider, candidate, decision, or
failure provenance.

The handoff must commit canonical expected-observation payload bytes, hashes,
and counts for all 19 evaluator categories, plus the source-obligation receipt.
The evaluator must reopen those bytes through the frozen source-evidence
verifier; naked counts or hashes are not evidence.

Forward tests use fresh Codex threads with no inherited conversation for each
new document/attempt. The existing born-digital, scanned-page, three-column,
and link fixture MinerU manifests are provider-discovery receipts only. They
must not be reported as a product pilot. A durable four-document development
evaluation requires retained source bytes or a legal owner-local reopen
reference, graph bytes, all 19 expected-observation payloads, the local Codex
receipt, grounded materialization receipt, actual EPUB bytes plus EPUBCheck,
renderer observations, and the final comparator/trace receipt for every item.
Exercise born-digital two-column, scanned/hybrid, figure-heavy, and
table/formula-heavy inputs plus malformed negative handling.
Require deterministic/MinerU/Codex identities, all-arm graph hashes, exact
obligation closure, and the evaluator handoff on every non-negative case; no
manifest, basename, title, hash, fixed-page, or seed may change production
behavior.

Do not call that packet verified merely because its files parse. The v2 packet
is valid only when it replays authentic #203 prior/final traces and invokes the
frozen owner-local Codex, #200 grounded-materialization, render-observation,
and EPUBCheck verifier authorities. Their exact identity/config/executable
digests must be pinned in the packet policy before evaluation; every authority
must return its exact identity- and request-bound receipt. Until #200 supplies
and passes that
authority, report parser/provider progress only.

For every pilot, retain the source hash, producer receipt hash, graph hash,
provider host/backend identity, all 19 expected-observation payload receipts,
and the conservation result. Born-digital or scan inference success is only a
provider receipt; it is not reconstruction success until every source run,
required asset, typed link/destination, relationship, and selected obligation
is materialized exactly once or remains an explicit bounded source fallback.

## Autonomous development loop

- Resume the newest clean checkpoint for the issue before creating a branch or
  rerunning discovery. Record the branch, commit, failing fixture, and next
  command in the issue receipt.
- Declare each worker as `parser-core` or `evidence-eval` and name its write
  scope. Never run two parser-core workers or two workers that can edit the same
  files. A second evidence/eval worker is allowed only when the queue proves
  disjoint paths plus disk and memory headroom; otherwise use one worker.
- Work red → green → refactor with the narrowest affected fixtures. Commit each
  independently passing slice. Run the full suite, build, corpus, and visual
  comparison only at integration checkpoints instead of after every small edit.
- Preserve dependency caches between checkpointed runs, but treat them as
  reproducible. Never reclaim a live worktree, handoff, receipt, referenced
  evidence artifact, or source file to make space.
- Autonomous VM implementation uses `gpt-5.6-sol` with `high` reasoning. Keep
  the optional Luna layout consultation separate as described above.

## Required invariants

- Preserve every recoverable source text span exactly once in the reading flow or a declared source fallback.
- Give every block, asset, and relationship stable IDs plus source pages, boxes, confidence, and source IDs.
- Point graph relationships only to graph nodes/assets or explicit external destinations.
- Keep verified hyperlinks clickable and uncertain references visible without a false destination.
- Represent verified tables with cells, spans, header scope, and inline links; keep ambiguous tables as one bounded visual object.
- Retain equations and diagrams as source artwork unless a transcription is independently verified.
- Keep footnote/endnote markers and bodies even when their association is unresolved.
- Hash receipts from canonical metadata and asset digests, not duplicate embedded bytes.
- Reconcile source and STRUCT node, region, asset, relationship, diagnostic, and text-character counts in `receipt.conservation`; pin representative `generatedSha256` receipts in fixtures.
- Treat a readable fallback as recoverable output, not publication-ready output.

## Validation

Run the narrowest relevant fixtures first, then the repository gates:

```bash
npx vitest run src/research/mineru-owner-local-runner.test.ts src/research/source-evidence-assembler.test.ts
npx vitest run src/research/source-evidence-contract.test.ts src/research/local-codex-reconciliation.test.ts
npx vitest run src/research/structured-extraction.test.ts src/research/source-grounded-struct.test.ts
npx vitest run src/research/reconstruction-development-evaluation.test.ts
npx vitest run src/struct/struct.test.ts src/research/epub-source-fallback.test.ts
npx tsc --noEmit
npm run test
npm run build
scripts/agent-evidence
```

Add fixtures that vary independently across born-digital/scanned input, one/two columns, raster/vector visuals, semantic/ambiguous tables, equations, notes, and internal/external links. Do not tune a rule to a paper title, author, fixed page, or expected caption string.

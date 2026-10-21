# E-04 Implementation Record — 2026-10-20

Owner: `erniesg/erniesg` (E-04 IMPLEMENTATION owner for the `erniesg/struct` app cutover)
Branch: `feat/struct-e04-candidate-20261020`
Base: `9003ea7657ef73cbad271e6a82eab5f27f649e91` (the app E-03 candidate head, PR #454)
Precondition: E-03 passed (`9003ea76` exists with commits and is pushed).

This record is the E-04 dated record. It states what was changed, what was measured, and
what is still PENDING. It does not claim a cutover, an activation, or a merge.

---

## 0. Status of this record — corrected 2026-10-21

**The gate table in §6 was a provisional claim, and it was wrong.** An independent
acceptance audit of the integrated candidate at head `7370b71a18ffee4574e11938e72f8d783513b1e8`
measured six of the gates this record called "met" and contradicted them. This section
supersedes the earlier §6 statuses; the historical measurements and the historical prose
are kept below, because they are the record of what the E-04 candidate measured, but they
are **not** gate satisfaction.

| rule | statement |
| --- | --- |
| what counts as MET | a gate is MET only when the proof was produced by an independent run **on the integrated head that carries the change**, and that run is recorded. A lane report, a pilot report, or this record's own prose is not proof. |
| what happened | the earlier §6 marked EG-05, EG-06, EG-08, EG-10, EG-11 and EG-13 "met" on the strength of implementation and of lane-local runs. The audit's measurements contradict five of the six, and the sixth (EG-13) was never demonstrated at all. |
| what this update does | §6 now carries the audit's verdict per gate with its basis, and every gate that depends on a not-yet-integrated unit is marked PENDING. The six named gates (EG-05, EG-06, EG-08, EG-10, EG-11, EG-13) are **not** met. |
| what is NOT claimed here | no receipt repair, no renderer repair and no release-path repair is claimed as done. The units below are reviewed; their results are not yet in `main` / PR #455, and the gates that depend on them stay PENDING until they are integrated and re-measured. |

### 0.1 The two independently reviewed units this record's base carries

| unit | commit | independent review | status |
| --- | --- | --- | --- |
| the graph **property-access** detection in the boundary guard | `be3556aa10668b41c7374af6d206aa6cd8c872e4` ("test(publication): detect graph-bearing property access in the boundary guard") | PASS, no P0/P1/P2 findings, four P3 observations (`S/app-e04-graph-property-guard-review-report.md`) | **independently reviewed; NOT yet in `main` / PR #455** |
| the E-03/E-04 boundary-guard merge-conflict resolution | `a0a4dcc73e017c5d2208cc50c5ff3dde65c87ab1` ("merge(E-04/E-03): resolve the boundary-guard conflict preserving both guard contracts") | PASS, zero actionable defects (`S/app-e04-guard-integration-review-report.md`) | **independently reviewed; NOT yet in `main` / PR #455** |

Both units are in this record's base (`9675feea0a63a8ed4109aed2e540adae9d46c922`, which
combines them and carries no E-05 content). A review verdict on a unit is not the same
thing as the unit being integrated and re-measured on the integrated head, so every gate
that depends on them stays PENDING here.

### 0.2 Where this update was made

| field | value |
| --- | --- |
| branch | `test/struct-e04-both-mode-parity-20261021` |
| base | `9675feea0a63a8ed4109aed2e540adae9d46c922` (the initial base of this lane: the guard merge `a0a4dcc7` plus the independently reviewed property guard, no E-05 content) |
| governing plan | `docs/superpowers/plans/2026-10-20-struct-full-cutover-sequence.md` at commit `51c6656f` |
| this update's scope | §0, §1.2 (the proof-artifact reference), §6 (the gate table), and the new §6.1 (both-mode parity) and §6.2 (the re-pointed assertion) |
| source changes | none. This update changed no production source, no renderer, no binding, no helper, no schema, no manifest, no lock and no CI file. |

---

## 1. The two halves of E-04

E-04 has two obligations: cut the app's StructDocument render path over to the pinned
public package renderers, and converge the `PublicationGraph` so it can no longer be a
competing semantic authority. Both are done in this candidate.

> **Status (added 2026-10-21).** "Done in this candidate" describes the **candidate's own
> work**, not the gates. The gates these two obligations feed (EG-01 … EG-15) are in §6,
> and the corrected §6 does not mark EG-05, EG-06, EG-08, EG-10, EG-11 or EG-13 as met.
> Read §0 before reading any "done", "met" or "retired" in this record.

### 1.1 The renderer import cut

Exactly three import specifiers changed, in two production files:

| file | before | after |
| --- | --- | --- |
| `src/research/epub.ts` | `buildStructEpub` from `../struct/epub` | `@erniesg/struct/renderers/epub` |
| `src/research/epub.ts` | `renderPublicationXhtml as renderStructPublicationXhtml`, `type StructXhtmlOptions` from `../struct/xhtml` | `@erniesg/struct/renderers/xhtml` |
| `src/research/reconstruction-materialization.ts` | `buildStructEpub` from `../struct/epub` | `@erniesg/struct/renderers/epub` |

Nothing else in the app-owned `ResearchPaper` surface moved: the
`renderPublicationXhtml(paper, ...)` and `buildEpub(paper, ...)` overloads, the export
profiles, the readable fallback, `assertPublicationIntegrity`, the resource limits, the
worker/export facade and the public API surface are byte-for-byte unchanged. No renderer
semantics were reimplemented in the app, no public API was widened, and no package-private
path is imported.

The local compatibility copies `src/struct/{xhtml,epub,emitted-ids}.ts` are **physically
unchanged** (`git diff --stat` shows no change to them). The only file under `src/struct/`
that changes is `src/struct/struct.test.ts`, and it changes only its stale reference
assertion, which now compares the app's renderer entry points with the pinned package
renderers instead of the local copies. The copies themselves are stale compatibility
copies that E-07 deletes. That one re-pointed assertion is recorded in full in **§6.2**
(audit finding A-13), including the fact that the local copies keep their direct coverage
and that no frozen golden was rewritten.

### 1.2 The PublicationGraph authority convergence

ADR-0001 requires the competing graph to be retired or narrowed to an ephemeral,
mechanically derived renderer plan from one pinned approved Struct revision, owning no
independent text, no semantic IDs, no persistence, no receipt, no writer, no release path
and no annotation authority. A renamed full competing schema is not acceptable.

The proof that the graph owned ALL of those is in the E-04 proof record: a compiler-checker
(not grep) importer inventory, the live production build and check executed end to end, and
the five mandatory pilot paths. The verdict was **NARROW**, and the graph was narrowed:

> **Proof-artifact reference (corrected 2026-10-21).** The proof record is **not checked
> into this repository**. It is a VM-retained artifact of the E-04 graph-convergence lane:
>
> | field | value |
> | --- | --- |
> | path | `/home/ubuntu/.local/state/struct-migration/20261020-continuation/app-e04-graph-proof-report.md` |
> | sha256 | `7d3f9794ed509d5dbbec39a56d8dd1db061040739d166e0e4dc75222cb28524e` |
> | lane | `app-e04-graph-proof`, branch `feat/struct-e04-graph-convergence-20261020`, base `9003ea7657ef73cbad271e6a82eab5f27f649e91` |
> | its own verdict | `NARROW`, with one recorded output diff, plus a coordinator ruling (`app-e04-graph-ruling.md`) |
>
> It is a **trusted VM-retained artifact, not a checked-in file and not blanket evidence**:
> it is a pilot report produced on a lane branch that is not this branch's base, it was
> produced against a different tree, and it is not reachable from the repository. The
> earlier text of this section cited the file as if it were a repository artifact; that
> citation was wrong and is corrected here. Nothing in this record is *established* by
> citing it — the gates in §6 stand or fall on the integrated proof named there.

| authority class | before | after |
| --- | --- | --- |
| text | the Astro and Payload adapters minted it; the graph carried `text`/`code`/`source` | the graph text is copied from `StructBlock.text`; the app-owned MDX ingress (`src/struct-adapters/from-markdown.ts`) produces the one approved Struct revision |
| semantic ids | the adapters minted `paragraph-1`, `list-3`, `derived-<prefix>-<20 hex>` | the graph node id is the Struct block id, verbatim |
| persistence | `publication-graph.json` was written on every render and re-read by the checker | **nobody writes it, nobody reads it**, and `publication:check` FAILS if it is present in the input directory |
| receipt | `graphSha256` was the only source identity in both receipt shapes | a discriminated `sourceBinding` is the source identity; `graphSha256`/`assetBundleSha256` remain as diagnostic back-compat fields |
| writer / release | the CLI imported graph symbols; `build:production` ran the graph pipeline | the CLI writer and checker consume the app-owned publishing facade (`src/publication/publishing-facade.ts`) and import no graph symbol |
| annotation authority | `createAnnotationBundle` resolved anchors from graph node ids/text and persisted `graphId` | the bundle is v1.2.0 with a required `sourceId` and a **forbidden** `graphId`; anchors resolve from Struct block ids and text; the legacy 1.0.0/1.1.0 bundles resolve through a READ-ONLY map |
| reverse writer | `publicationGraphToResearchPaper` synthesised `ResearchPaper` nodes/text/ids from the graph | **retired**; the round-trip assertion that pinned it was REPLACED, not deleted |

The persisted semantic artifacts are now the canonical Struct document, the Struct bundle
descriptor and the Struct-bound receipt.

---

## 2. The recorded divergences (deliberate, measured, not silent)

The app's local renderer copies had **diverged** from the pinned package renderers. The
E-04 cut adopts the package's output, because the package is the approved authority
(ADR-0001: Struct owns deterministic XHTML/reflowable EPUB generation). The divergence is
recorded here, and the new parity test pins BOTH sides so it can never change unnoticed.

Measured on the repository's own fixtures, loaded with the repository's own
`$bytes` → `Uint8Array` decode and converted with the app-owned ingress
`buildStructDocument`:

| fixture | local copy | pinned package | equal |
| --- | --- | --- | --- |
| `structured-manuscript-docx` XHTML | `cf4eef0eb1edbddca464b1bcd7d1daac59a1b0715cc8e69c64c9a20270f2cd95` (4147 characters = 4177 UTF-8 bytes) | `a74427183599f3dc213465c5adac4451994603dbe4057962aefc5b2f0c198b28` (4166 characters = 4196 UTF-8 bytes) | **no** |
| `structured-manuscript-docx` EPUB | `f859d1ad1fadc8c897cc3a294a09845fdae5d5360fede37d2a40c16a81386c72` | `ee11cb70bf0300a69f1ec4621c8d6d53cfc4f18dc9791a504f08f24b9afcf3c9` | **no** |
| `adapter-parity/ordinary-pdf` XHTML | `4d9bc0a62fb7d4ce8aefbd1811ab5ea7246f33f64cd8721582ab93e1532f14f2` | `4d9bc0a62fb7d4ce8aefbd1811ab5ea7246f33f64cd8721582ab93e1532f14f2` | yes |
| `adapter-parity/ordinary-pdf` EPUB | `1d3c048035a2228a552e9d45d3258c3e75b3dccbe8d141e7b3e0b0e85c26a335` | `1d3c048035a2228a552e9d45d3258c3e75b3dccbe8d141e7b3e0b0e85c26a335` | yes |
| `adapter-parity/source-preserved-pdf` XHTML | `eba808794a97517df241e6dff1d289bd19c2584a84b5dabcf58b61896f87c444` (4529 characters = 4529 UTF-8 bytes) | `0106902dab681da128171ab2937f4ac9a6bfbd8c2418e135a0de25b6c48411be` (4520 characters = 4520 UTF-8 bytes) | **no** |
| `adapter-parity/source-preserved-pdf` EPUB | `STRUCT_EPUB_RECOVERY_REVIEW_REQUIRED` | `STRUCT_EPUB_RECOVERY_REVIEW_REQUIRED` | identical refusal |

The divergence classes, all measured:

1. **List rendering.** The package groups consecutive list-item blocks into `<ul>`/`<ol>`
   with `<li>` children; the local copy has no list branch and renders each list item as a
   `<p>`. The package is the semantically correct rendering.
2. **Furniture separators.** The package drops furniture blocks before joining; the local
   copy keeps the join separator and so emits three whitespace-only lines. No element,
   attribute or text differs.
3. **Default renderer styles.** The package's `DEFAULT_STYLES` carry two extra rules
   (`figure.equation { text-align: center; }` and `ol, ul { margin: 0 0 1rem 1.5rem; padding: 0; }`).
4. **Ingress validation.** The package validates the document at ingress (schema version,
   receipt digest, reference resolution, duplicate identifiers, conservation counts); the
   local XHTML renderer validates nothing. The recorded failure matrix is in the lane
   evidence: the package refuses `invalid-version`, `invalid-receipt-digest` and
   `missing-target` where the local copy accepted them, and both refuse the same unsafe
   href and the same duplicate id, and both enforce the same archive byte ceiling.

### 2.1 The published-output changes of the Astro re-target

The real production entry `moving-to-cloudflare-with-astro` is published through the
Astro adapter, so the re-target is visible in the published artifacts. Measured by the
lane against the base commit's output:

- the **text is identical** (the tag-stripped text of `phone-webpub/index.html` before and
  after is the same);
- the **element ids change** from the authored slugs and sequence ids (`paragraph-38`,
  `hero-figure`, …) to the Struct block ids (`struct-block-…`) — 51 ids before and after,
  all Struct-derived. This is required by the target state: the graph may not author
  semantic ids;
- the **published asset file name** follows the Struct asset id instead of
  `asset-<hash16>`;
- **one inline-code span** loses its `<code>` styling. The pinned `StructInline` has no
  code flag (nor a strikethrough or a hard-break flag), and the app's own Struct renderer
  already rendered only bold/italic/superscript/subscript, so the narrowing converges the
  publication pipeline onto the app's existing Struct publication semantics. The loss is
  **not silent**: the conversion emits a `lossy-inline-style` warning diagnostic naming
  the block that lost the style, and a test asserts that diagnostic.

  **SUPERSEDED on 2026-10-21 by §2.3.** The user never approved that formatting loss, and
  it blocked PR #455 readiness. The pinned package now carries an optional inline-code
  flag, so the span keeps its `<code>` element again and the `lossy-inline-style`
  diagnostic is gone. §2.3 records the new pin, the new Struct head, and what did and
  did not change. The measurement below is kept as the E-04 candidate's own record.

  The pinned production entry has **no footnote**: neither the base commit's nor this
  head's published `phone-webpub/index.html` contains a `ref-` id, a `<sup>` or a
  `doc-noteref`. The re-target's footnote-reference change is a **code-level** change, not
  a measured change of that entry: a footnote reference's anchor id is now the Struct
  relationship id instead of `ref-<identifier>` (the renderer emits the link's
  `relationshipId` as the element id, and the projection now mints a Struct relationship
  id). It is pinned by `src/publication/renderers/vivliostyle.test.ts`, which follows the
  graph's own relationship id, and it is visible in the synthetic publication fixture.

  The corpus statistic, measured with the repository's own remark pipeline
  (`remark-parse` + `remark-mdx` + `remark-gfm` + `remark-math`) over the 112 MDX files in
  `src/content/blog/**`: **0 strikethrough spans, 0 hard breaks and 373 inline-code
  spans** in the corpus, of which **exactly 1 is in the pinned production entry** - the
  one that is published. (The earlier E-04 proof scan reported 57 inline
  code spans and 5 hard breaks; that scan was a RAW-TEXT grep over the 31 English
  `index.mdx` files that counted matching LINES with a regular expression, not AST nodes
  with the repository's remark pipeline, and it ran over a different file set. The two
  numbers are therefore not comparable. Only the pinned-entry number is load-bearing for
  the E-04 outcome, and it is 1 under both scans. The corpus-wide numbers here are the
  ones the independent final review measured.)

### 2.2 The frozen golden was NOT regenerated

`tests/fixtures/struct-adapter-parity/expected.json` is unchanged. The repository's
frozen parity test (`tests/struct-adapter-parity.test.ts`) keeps measuring the local
copies through `tests/fixtures/struct-adapter-parity/observe.ts` and stays green.

**E-07 note:** when the local copies are deleted at E-07, `observe.ts` must migrate to the
package renderers, and the frozen `xhtmlSha256`/`epubSha256` values will then change.

### 2.3 The inline-code fidelity follow-up (2026-10-21)

The E-04 candidate reduced every MDX inline-code span to plain text. The user never
approved that formatting loss, and it blocked PR #455 readiness. The loss was real: the
pre-E-04 app published `<code>main</code>` and the E-04 candidate published plain `main`.

**Measured, before any design.** The corpus was scanned with the repository's own remark
pipeline (`remark-parse` + `remark-mdx` + `remark-gfm` + `remark-math`) over
`src/content/blog/**`: **373 inline-code spans in 41 files**, of which **1** is in the
pinned production entry. The real publication output was built at the pre-E-04 base
`9003ea7657ef73cbad271e6a82eab5f27f649e91` and at the E-04 candidate
`c1d5e92ff7cb4aac635d91baf33b20f58e98c2fc` for the pinned production entry, and the
published `phone-webpub/index.html` bytes differ exactly at that span:

| side | published bytes around the span |
| --- | --- |
| base `9003ea76` | `...the site automatically redeploys when I push to <code>main</code>.</p>` |
| E-04 candidate `c1d5e92f` | `...the site automatically redeploys when I push to main.</p>` |

The E-04 candidate also emitted one `lossy-inline-style` warning diagnostic per inline-code
span, and its Struct document carried **no** inline run at that span.

**The upstream contract change (narrow).** `StructInline` gained one optional boolean
field, `code?: boolean`, in the pinned package at Struct head
`119d0411edb525dc7cce2f0f80a5c2ab37f5d040` (base `72a64ebbecde6718cbfcf59b17085bd794926cf9`):

- the strict codec parses it as a boolean, refuses it on a zero-width run exactly like the
  other formatting flags, still refuses every undeclared inline field, and carries it
  through encode/decode;
- the package XHTML renderer emits `<code>…</code>` inside the existing `styled()` pass,
  applied first so the element is the innermost wrapper of the formatting it is combined
  with (`<strong><code>…</code></strong>`); the EPUB renderer builds its content document
  from the same XHTML path, so it renders the element too;
- it is **additive and optional**: a document that omits the flag decodes and renders
  exactly as before, so document schema `0.2.0` is unchanged and **needs no version bump**.
  No runtime export, export path or `API_MANIFEST.json` entry changed. No strikethrough and
  no hard-break field was added; those two constructs are still reported as genuinely
  unrepresentable by the pinned document.

**The app change.** `src/struct-adapters/from-markdown.ts` maps MDX `inlineCode` to
`append(node.value ?? '', { ...style, code: true })` and no longer emits the
`lossy-inline-style` diagnostic for inline code; the strikethrough and hard-break paths
are unchanged and still report their loss. `src/publication/struct-adapter.ts` maps the
Struct flag onto the publication schema's **existing** `inlineCode` field, so the app's
own renderer emits `<code>`. There is no second renderer, no post-hoc HTML rewriting and
no semantic workaround.

**The new pin and artifact.** The app is repinned to the new Struct head:

| field | value |
| --- | --- |
| Struct head | `119d0411edb525dc7cce2f0f80a5c2ab37f5d040` |
| Struct base for this delta | `72a64ebbecde6718cbfcf59b17085bd794926cf9` |
| artifact | `erniesg-struct-0.0.0-119d0411edb525dc7cce2f0f80a5c2ab37f5d040.tgz` |
| sha256 | `bb86a4bc192c2485f1029dee32964e5488e9277345dfb5a222d17fa3cfce6296` |
| integrity | `sha512-qHxaJ5MKq8XaxI8zbWSKcMs7Lft64rogSeVzyZoh8KuvqXcCswQH8Ri0/6dUWxgmn52PW3ieX8nL4isdYZWBUQ==` |
| packed files / uncompressed bytes | 33 / 349,559 |
| toolchain | node 22.22.3, npm 10.9.8, pnpm 12.8.1 |

Two independent `npm ci` + `npm run test:package` + `npm pack --json` builds from the
clean committed head produced **byte-identical** tarballs (same sha256 and same sha512).

**What did NOT change.** The reviewed Struct 39 artifact
`42fee58e9b1e1888c53e929ad6367a2c128d1607140225387836ee5da53df8f1` and the reviewed head
`72a64ebbecde6718cbfcf59b17085bd794926cf9` are untouched; the old tarball file is still in
`vendor/struct/` and is simply no longer the pinned one. The corpus statistic (373 spans),
the published text bytes, the element-id change to `struct-block-…`, the Struct-derived
asset file name and the "no footnote in the pinned entry" measurement are unchanged. No
golden, expected output, profile or snapshot was regenerated. The app's local `src/struct/**`
compatibility copies are unchanged, and the `ResearchPaper` overloads are unchanged.

**The measured five-span comparison** is checked in at
`tests/fixtures/struct-inline-code/case-comparison-20261021.json` and re-measured by
`tests/struct-inline-code-fidelity.test.ts`. For all five real spans the **paragraph text
bytes are identical** across the base, the E-04 candidate and this branch; the E-04
candidate carried no inline-code run and one `lossy-inline-style` diagnostic per span; this
branch carries the same inline runs the base carried and no loss diagnostic.

---

## 3. The app defect the cut exposed, and the fix

The pinned package validates the document at ingress. That exposed a latent app defect:
the app's grounded materialization emitted a receipt whose `textCharacterCount` did not
match the block text — a violation of the Struct receipt invariant that the app's OWN
local codec already enforced (`src/struct/codec/invariants.ts`) but that the app's
permissive local renderer had hidden.

Measured on the failing fixture:

| | `receipt.textCharacterCount` | `conservation.sourceTextCharacterCount` | `conservation.structTextCharacterCount` | sum of `block.text.length` |
| --- | --- | --- | --- | --- |
| before | 28 | 28 | 29 | 29 |
| after | 29 | 29 | 29 | 29 |

The fix binds the receipt's text count to the published block text and keeps the
conservation record coherent. No invariant was relaxed, no counter was zeroed or deleted,
and the local codec's invariant file is unchanged. The package validator now accepts every
app materialization path, and that is proved by a test that runs the package's own
validator over them.

A second, smaller finding came out of the same cut: the app-owned evidence tool
`tools/srt-source-output-evidence.mjs` built a `0.1.0` document **with** a document
binding, which the pinned package refuses (`STRUCT_CODEC_MIGRATION: 0.1.0 documents cannot
contain document bindings or model consultations`). The tool now takes the schema version
from the package itself and keeps the binding consistent with it. The evidence output is
byte-identical to the output the same tool produced before the cut
(`checkpoint-manifest.json` sha256 `2069d3d1164ec91ee0850882902cda4796248f84d3b31f71c96a91ea251818d0`,
`README.md` sha256 `b94b59ddb03e2348ee7a984639e4f7d5d0af1f59b7e9aea2452a789ed3934dcb`, all
18 `pairs/*.png` identical, the same 9 checkpoints, the same properties, criteria and
statuses).

---

## 4. The one removal, and why

The Payload-Lexical publication path was **retired** (the contract's option P-2, signed
off by the coordinator after the E-04 proof established the facts). The measured facts:
there is no `payload` dependency in `package.json`, no `src/payload/**` site, and no
production caller — the only Payload inputs in the repository are the checked-in fixtures
under `tests/fixtures/payload/**`.

What that removes, stated plainly:

- the CLI's `--adapter payload` option (and `--input` / `--mapping`): the CLI now refuses
  every spelling of the retired adapter with the documented retirement reason;
- the Astro-vs-Payload **cross-adapter equivalence proof** in
  `tools/publication-adapter-conformance.mjs`. The tool says so in its own output rather
  than hiding the coverage loss.

Re-adding a Payload publication path requires a Struct-semantics conversion first. This is
a follow-up candidate, not a permanent statement.

---

## 5. The measured evidence on the integrated candidate

Every number in this section was measured on a committed and clean worktree at the literal
run head `f538884c` of `feat/struct-e04-candidate-20261020` (base `9003ea76`).
`f538884c..c3c48d21` is documentation-only — it changes this record and the status row and
nothing else — so the code that produced these numbers is byte-identical to the candidate
head `c3c48d21`; the acceptance (the PR request and the coordinator's result) names the
exact final head.

> **Scope of these numbers (added 2026-10-21).** Every number in this section is the
> **E-04 candidate's own measurement at its own head**. They were **not** re-run at this
> record's base (`9675feea`), they were not re-run at the audited head (`7370b71a`), and
> they are **not** gate satisfaction for EG-10, EG-12 or anything else: §6's corrected
> table says which proof each gate still needs. In particular, the published receipt
> quoted below is the receipt the candidate produced; the audit found that the release
> path never compares that receipt's package identity against
> `vendor/struct/provenance.json`, so the receipt is a measurement, not the EG-10 proof.

- **The real production build**: `npm run build:astro` (181 pages, exit 0) and then, at
  the same head, `npm run publication:build -- --adapter astro --entry moving-to-cloudflare-with-astro --output .agent/evidence/publication` (exit 0, 4 artifacts) and the matching
  publication check below. The output directory contains `struct-document.json`,
  `struct-bundle.json`, `publication-receipt.json`, `asset-bundle.json`,
  `astro-route-parity.json`, `publication.css`, `layout-assets/`, `phone-webpub/`,
  `eink.epub`, `a5-pdf.html`, `a5-pdf.pdf`, `a4-pdf.html`, `a4-pdf.pdf` and the three
  fonts. **`publication-graph.json` is absent.**
- **The real production check**: `npm run publication:check -- --input .agent/evidence/publication --matrix phone-webpub,eink-epub,a5-pdf,a4-pdf`
  (exit 0) — "Publication matrix passed structural, accessibility, EPUBCheck, and PDF
  checks".
- **The published receipt's Struct binding** (measured from the build above):
  ```json
  {
    "kind": "struct-cutover",
    "documentSha256": "d3d859dee197cd53d01a7f479539fb0b27679c0ec1e0664200c7980c230b9463",
    "bundleSha256": "ad38204ea518eb5e8d35deebb8b4bb92c888d3d6a3616b168cb79af0a52f9d81",
    "semanticReceiptSha256": "35fb6071c7075940f3ad243db39c610c8a070b710b32477b172d42a78ac61c51",
    "packageSourceCommit": "90f76f1f80b037cc065169d07b13779c03420026",
    "packageArtifact": "erniesg-struct-0.0.0-90f76f1f80b037cc065169d07b13779c03420026.tgz",
    "packageArtifactSha256": "42fee58e9b1e1888c53e929ad6367a2c128d1607140225387836ee5da53df8f1",
    "packageIntegrity": "sha512-0WyBLp2PDZr4pOFYhfe6a1IbuZOuBemiR/alDgx73j8JYKZh7m8UthMsimjXp6wt3gUUiNumvXmykYeccnDUBQ==",
    "packageVersion": "0.0.0"
  }
  ```
  Every digest is computed from the bytes that invocation produced; the pin comes from the
  ONE provenance source (`vendor/struct/provenance.json`), cross-checked against the
  tarball digest, the sha512 integrity, `package.json`, `package-lock.json` and the
  installed manifest, and the function throws on any mismatch. The legacy
  `legacy-research-paper` variant carries exactly one key and cannot hold a placeholder.

  **This block is the E-04 candidate's measurement at its own head.** The 2026-10-21
  inline-code follow-up (§2.3) repins the app, so the pin this receipt carried is the
  previous one; the current pin is named in §2.3.
- **The EG-08 graph-absence guard** (`tests/publication-graph-boundary.test.ts`,
  compiler-checker based, alias-resolving, `.astro` aware, with the four mandatory
  non-vacuity proofs) is GREEN on the integrated candidate, and the EG-09 double-adapt
  conformance is GREEN: `Test Files 2 passed (2); Tests 17 passed (17)`.
- **The E-04 family guard entry** (`tests/struct-adapter-boundary.test.ts`) is RED before
  the cut and GREEN after: in a scratch copy with the renderer import switch reverted, the
  new entry reports the three reverted imports; on the candidate head the guard file passes
  8/8 (the 6 pre-existing assertions plus the 2 new E-04 blocks).
- **`npx astro check`**: 0 errors, 0 warnings (286 hints, the repository's own pre-existing
  hints).
- **The repository's own app suite** on the committed head
  `npx vitest run --exclude 'tests/e2e/**' --exclude 'tools/agent-evidence-budget.test.mjs' --maxWorkers=1`:
  **331 files (329 passed, 2 skipped); 5067 tests (5059 passed, 8 skipped); exit 0 - no
  failures.** The suite was run on a committed, clean worktree and the tree was not edited
  while it ran.

---

## 6. The E-04 future-gate table (corrected 2026-10-21)

**The statuses below are corrected.** The earlier version of this table marked every gate
"met" except EG-14, on the strength of implementation and of lane-local runs. The
independent acceptance audit at `7370b71a` measured the gates against the integrated tree
and contradicted six of them (findings A-10, A-12 and the gate matrix in
`S/app-e04-acceptance-audit-report.md` §4). The table now carries the audit's verdict and
its basis. **A lane report saying PASS is not gate satisfaction.**

`SATISFIED` in this table means: an independent run on an integrated head demonstrated the
gate and that run is recorded. `PARTIAL` means: part of the gate is demonstrated and the
rest is not. `NOT SATISFIED` means: the gate was measured and the measurement contradicts
it. `PENDING` means: the gate needs a proof that has not been produced on an integrated
head.

| # | Gate | Status (corrected 2026-10-21) | Basis |
| --- | --- | --- | --- |
| EG-01 | the graph is an ephemeral renderer plan from one pinned approved Struct revision | **PARTIAL** | the Astro adapter produces the one approved Struct revision through the app-owned MDX ingress and the Payload publication path was retired; but at the audited head the non-Struct forward producer was still exported and allowlisted (audit A-04). A separate lane is retiring that producer in flight; its result is not claimed here. |
| EG-02 | the graph owns no independent text | **PARTIAL** | the Struct projection copies `StructBlock.text` and `tests/publication-struct-double-adapt.test.ts` asserts the graph never authors text or a semantic id; but the research-paper bridge still minted graph text from a paper at the audited head (audit §4). |
| EG-03 | the graph owns no independent semantic ids | **PARTIAL** | the projection's node ids are the Struct block id and the published element ids are Struct-derived; but the bridge's own test still asserted graph ids == paper ids at the audited head (audit §4). |
| EG-04 | the graph owns no persistence | **SATISFIED** (at the audited head) | the renderer persists only the Struct artifacts and the checker rejects a present `publication-graph.json`; proven by `tests/publication-cli-facade.test.mjs` and `src/publication/renderers/vivliostyle.persistence.test.ts`, both green in the audit's run. |
| EG-05 | the graph owns no receipt | **NOT SATISFIED** | the receipt's source identity is the discriminated `sourceBinding`, but the graph's own `canonicalSubsetSha256` is still produced and compared at admission, and `receipt.source.graphSha256` is still required (audit A-06/A-10). "graphSha256 is diagnostic only" was a provisional claim, not a measurement. |
| EG-06 | the graph owns no writer and no release path | **PENDING** | neither CLI tool imported a graph symbol, but at the audited head the release path still ran the graph pipeline and the published EPUB/XHTML/HTML were graph-authored (audit A-03), and the guard could not see graph-bearing values (audit A-05). The independently reviewed property-access unit `be3556aa` closes the *detection* gap; it is not yet in `main` / PR #455, and the release path has not been re-measured on an integrated head without the graph. |
| EG-07 | no reverse graph→ResearchPaper writer | **SATISFIED** (at the audited head) | `publicationGraphToResearchPaper` was removed and the module's own test asserts both that the export is absent and that the module source no longer contains the symbol (green in the audit's run). |
| EG-08 | the red-first static absence assertion | **PENDING** | the compiler-based guard `tests/publication-graph-boundary.test.ts` with its non-vacuity probes was green at the audited head, but it resolved **symbol names only** there (audit A-05) and the forward bridge was allowlisted (audit A-04). This record's base carries the independently reviewed property-access unit `be3556aa` and the reviewed guard merge `a0a4dcc7`; both are **not yet in `main` / PR #455**, and the red-first run has not been repeated on the integrated head. |
| EG-09 | byte-identical double adapt; the graph is never persisted | **SATISFIED** (at the audited head) | `tests/publication-struct-double-adapt.test.ts` (7 tests, green in the audit's run): identical graph bytes, identical encoded document bytes, identical binding, identical persisted serialization, and "never lets the graph author text or a semantic id". |
| EG-10 | the receipts carry the Struct digests and the exact package pin | **NOT SATISFIED** | the binding *shape* exists, but at the audited head the semantic receipt was optional and never compared, there was no receipt-bound `struct-bundle.bin`, and no comparison of the receipt's package-identity fields against `vendor/struct/provenance.json` happened at admission (audit A-01, A-02, A-06). Re-checked at this record's base: `readStructPackagePin` is referenced only from tests, never from the release path, and `tools/publication-check.mjs` reads `struct-bundle.json`, not a receipt-bound `struct-bundle.bin`. The published receipt quoted in §5 is the receipt the E-04 candidate produced; it is **not** the EG-10 proof. |
| EG-11 | `ResearchPaper` stays a read-only compatibility model with a caller inventory | **PARTIAL** | the app-owned `ResearchPaper` overloads are unchanged and the inventory exists, but the checked-in inventory still described the pre-E-04 tree at the audited head and no test asserts the inventory is accurate (audit A-11). The inventory is another lane's file and is not updated here. |
| EG-12 | EPUBCheck / Ace / human accessibility stay app-owned | **SATISFIED** (at the audited head) | the checker runs EPUBCheck and asserts the accessibility metadata, the app builds that metadata, and the package renderer provably emits none of it, so app ownership is load-bearing (audit §4). |
| EG-13 | the legacy overloads keep both-mode parity | **NOT SATISFIED** | the earlier "met" was a provisional claim: the legacy-mode tests proved byte-stability and *distinctness* of the two modes and never agreement on the same content (audit A-12). §6.1 now records the first same-content comparison that was actually run, and it measures **three real divergences**, so the gate is still not satisfied. |
| EG-14 | the E-07 deletion gates | **PENDING (E-07)** | the local `src/struct/**` copies stay; this record adds the E-07 notes |
| EG-15 | no non-Struct graph producer remains | **NOT SATISFIED** at the audited head | the forward producer was still exported and allowlisted (audit A-04). A separate lane is retiring it in flight; that result is **not** claimed here, and EG-08's guard must stay red until it is gone. |

### 6.1 EG-13, measured: the same publication through both `research/epub.ts` overloads

**What was added.** `src/research/struct-renderer-import-parity.test.ts` gained a block that
publishes **one** publication through the legacy `ResearchPaper` overload and through the
public `StructDocument` overload of `src/research/epub.ts`, and compares the two
publications. The comparator is a test-side view (`tests/fixtures/struct-both-mode-parity/view.ts`)
that reads the rendered XHTML and reports, per publication: the canonical text of every
content unit in reading order, the inline marks that carry that text, the published asset
set with its alt text, the external links with their meaning, the internal references
**resolved to their target**, and the nesting of the lists.

**What is compared, and what is not.** Compared: canonical text and reading order, the
inline marks, the asset set and its alt text, the link meaning, and the reference
correspondence. NOT compared: whole-archive bytes, CSS, class names, and the two document
envelopes (the legacy mode renders the research-paper metadata block, the Struct mode
renders the document metadata block). The legacy ids (`fn-docx-1`) and the Struct ids
(`struct-block-…`) are **presentational aliases** of the same anchor, so the reference
correspondence is asserted on the *resolved target*, never on the id string. The app's own
`data-semantic-ledger-ignore="true"` marker on the note-marker label is honoured, because
the app itself declares that label outside the semantic ledger.

**The three pilot cases and exactly what they cover.**

| case | content | how the two sides are produced | what agrees | what does not |
| --- | --- | --- | --- | --- |
| `text-heading-inline-code` | one heading, one paragraph with a bold mark, an inline-code mark and an external hyperlink | the Struct side is the app-owned MDX ingress (`src/struct-adapters/from-markdown.ts`, the ingress the production Astro path uses); the legacy side is the legacy `ResearchPaper` model, validated by the app-owned `researchPaperSchema` | the canonical text and the reading order are identical; the title and the authors are identical; the external link is identical in href and in text | the inline marks differ by exactly the `code` element: the pinned `StructInline` has an optional `code` flag, the legacy `ResearchPaper` inline-run model has **no field for it**, so the legacy overload cannot publish `<code>` at all |
| `asset-link` | the frozen structured-manuscript DOCX | **one** reconstruction, published through both overloads: the legacy side is the importer's own `ResearchPaper` with the importer's own reconstruction, the Struct side is the app-owned adapter's `StructDocument` for the same reconstruction. Neither side is authored by the test. | the published asset set is identical (`assets/asset-img-b0007-rId4-431ced6916a2.png`) and so is its alt text; the external link is identical in href and in text | the full unit sequence diverges — see divergences 1 and 2 below |
| `table-reference` | the same frozen structured-manuscript DOCX | as above | the semantic table's cell text in reading order is identical (`Language`, `Greeting`, `English`, `Hello`, `中文`, `你好`); the footnote and endnote references resolve to targets whose text is identical | the full unit sequence diverges — see divergences 1 and 2 below |

**The three measured divergences (the gate is NOT satisfied).**

1. **The Struct overload publishes the figure caption twice.** The legacy overload
   publishes the caption once, inside the figure's `<figcaption>`. The Struct overload
   publishes it once as the figure's `<figcaption>` and once more as the separate
   `caption` block the adapter emits for the same caption node. This is a real content
   duplication, not a presentational difference.
2. **The Struct overload flattens the list structure.** The legacy overload publishes an
   ordered list with a nested bullet list (`ol` → `ul` → `li`). The Struct overload
   publishes both items as siblings of one unordered list: the app-owned adapter emits
   `listLevel`/`listOrdered`, while the pinned renderer groups list items by
   `attributes.listId` and reads `attributes.ordered`. The nesting and the ordering are
   lost between the adapter and the renderer.
3. **The legacy overload cannot publish an inline-code mark.** See the first case above.
   The cause is a capability gap of the legacy compatibility *model*, not of a renderer.

**The comparator is not vacuous.** Three mutations are measured in the test: a text
difference between the paired views, a link difference, and an asset difference (the alt
text of the reconstruction's visual relationship). Each mutation makes the comparison that
passes on the clean fixture report a difference, with the exact differing record. The
mutations are applied to the private fixture (`tests/fixtures/struct-both-mode-parity/`)
and to the in-memory reconstruction, and they are undone by construction: the unmutated
comparison is asserted to be clean in the same file.

**What these three cases do NOT prove.** Three cases are a pilot, not a proof over every
accepted input. They cover a heading, a paragraph, a bold mark, an inline-code mark, an
external hyperlink, one image asset with its alt text, one semantic table and one
footnote/endnote reference pair. They do **not** cover: quote blocks, code blocks,
equations, list items in the legacy mode, footnote-heavy publications, multi-asset
figures, publications with more than one table, right-to-left text, the readable-fallback
mode, or the EPUB archive side of either overload. The gate stays **NOT SATISFIED** until
those are covered and until the three measured divergences are fixed and re-measured.

**The remaining broader gates are unchanged by this measurement.** §6's other rows are not
affected by EG-13, and this measurement does not move EG-05, EG-06, EG-08, EG-10 or EG-11.

### 6.2 The one re-pointed assertion (audit finding A-13)

One pre-existing assertion was **re-pointed, not removed**. In `src/struct/struct.test.ts`
the app's renderer entry points used to be compared with the **local** compatibility copies
(`expect(renderPublicXhtml(graph)).toBe(renderPublicationXhtml(graph))` and
`expect((await buildPublicEpub(graph)).sha256).toBe((await buildStructEpub(graph)).sha256)`)
and are now compared with the **pinned package** renderers. This is a recorded, intentional
consequence of the renderer import cut: the package is the approved authority for the
StructDocument render path, so the app adopts the package's output.

- The local copies keep their **direct** coverage in the same file; the audit recorded
  twelve separate local-copy assertions still exercising them.
- **No frozen golden was regenerated or rewritten.** The audit verified
  `git diff 9003ea76 c1d5e92f -- tests/fixtures/` is empty and that
  `tests/fixtures/struct-adapter-parity/expected.json` is byte-identical at the base and at
  the audited head. The same holds at this record's base: the only fixture change in this
  lane is the NEW `tests/fixtures/struct-both-mode-parity/` directory; no existing fixture
  was touched.
- The local copies are deleted only at E-07, and §2.2's E-07 note still applies.

---

## 7. Not done / not in scope

- No merge, no deploy, no writer/route/publication activation, no database migration, no
  npm publication, no E-07 deletion.
- The pinned Struct package IS changed, but only by the narrow inline-code follow-up
  recorded in §2.3: Struct head `119d0411edb525dc7cce2f0f80a5c2ab37f5d040` adds one
  optional boolean field to `StructInline`. The reviewed Struct 39 artifact
  `42fee58e9b1e1888c53e929ad6367a2c128d1607140225387836ee5da53df8f1` and the reviewed head
  `72a64ebbecde6718cbfcf59b17085bd794926cf9` are untouched: the old artifact file is still
  in `vendor/struct/` and was neither rewritten nor reused, and the app's pin now names
  the new artifact.
- No golden, fixture, expected value, profile or snapshot was regenerated or edited. The
  one fixture this change adds is a NEW measured record
  (`tests/fixtures/struct-inline-code/case-comparison-20261021.json`); no existing fixture
  was rewritten. `package.json`, `package-lock.json` and the locally excluded
  `pnpm-lock.yaml` were changed only for the repin, and `vendor/struct/provenance.json`
  and `vendor/struct/README.md` were changed only to name the new artifact truthfully.
- The Struct repository's own host-harness census sampling race is a SEPARATE follow-up
  branch (`test/bundle-resolver-host-census-wait-20261020`); it does not change the
  reviewed Struct head or the app's pin.
- E-05 (durable editorial publication behind an inactive gate), E-06 (activation) and
  E-07 (deletion) are separate steps and are not part of this record.
- **No receipt repair, no renderer repair and no release-path repair is claimed as done**
  (added 2026-10-21). The receipt-binding rules, the package-pin comparison at admission,
  and the release path's independence from the graph are exactly what the audit found
  unmet (A-01, A-02, A-03, A-06). The two independently reviewed units this record's base
  carries (`be3556aa`, `a0a4dcc7`) are reviewed but **not yet in `main` / PR #455**, and no
  integrated re-measurement of them is claimed here.
- **This record's 2026-10-21 update changed no production source, no renderer, no
  binding, no helper, no schema, no manifest, no lock, no CI file and no vendor file.**
  Its changes are: this document, the both-mode parity block in
  `src/research/struct-renderer-import-parity.test.ts`, and the NEW
  `tests/fixtures/struct-both-mode-parity/` directory. No existing fixture was rewritten,
  and no golden, expected value, profile or snapshot was regenerated.

## 8. The independent review of this candidate, and the disposition of its findings

An independent review of the integrated candidate (a fresh context, read-only, no
implementer's conclusions) returned FINDINGS. The disposition, recorded here so the
acceptance names what was fixed and what was deliberately kept:

> **Status of this section (added 2026-10-21).** This is the **implementer's own**
> disposition of that review. It is not a gate proof and it is not the acceptance audit.
> The independent acceptance audit of the integrated candidate at `7370b71a` is a separate
> run, and its findings (A-01 … A-13) are recorded in §0 and §6 above.

| Finding | Severity | Disposition |
| --- | --- | --- |
| the candidate head did not typecheck: the renderer's test read `inlineRuns` off the `PublicationNode` union without narrowing, so `astro check` reported one error and `npm run build:astro` (which is `astro check && astro build`) could not complete | HIGH | **FIXED**: the union is narrowed before the optional property is read, exactly as the rest of the codebase does. `astro check` reports 0 errors again and the production build completes. |
| the record's build evidence was stale because the typecheck failed at the head it described | MEDIUM | **FIXED**: the build, the check and the typecheck were re-run on the corrected head and the numbers in §5 are that run. |
| the contract receipt schema and the renderer receipt type keep `sourceBinding` optional | LOW | **RECORDED DEVIATION, deliberate**: the source result's binding is optional because the facade owns the package pin and computes the binding for the published path (the `struct` adapter legitimately produces a result without one). The published receipt is nevertheless enforced at runtime: `tools/publication-check.mjs` calls `assertPublicationPlanSourceBinding`, which refuses a receipt with no binding, a binding that is not the `struct-cutover` variant, and a binding whose `documentSha256` is not the checked plan's document digest. The closed receipt contract also refuses a receipt without a binding (the N8 negative acceptance). Making the TYPE required would have forced the source adapter to own the pin, which the contract assigns to the facade. |
| the corpus statistic mixed scopes | LOW | **CORRECTED** in §2.1: the corpus-wide numbers are the ones the review measured, and the pinned-entry number (1) is stated separately. |
| "git diff --stat shows no change under `src/struct/`" | NOTE | **CORRECTED** in §1.1: the compatibility copies are unchanged; `src/struct/struct.test.ts` changes only its stale reference assertion. |
| the inventory did not yet carry the compiler-proven importer set at the reviewed head | NOTE | **FIXED** in a later commit (`af71a30f`): the inventory now carries the measured post-E-04 importer set, and the acceptance names the head that carries it. |
| the branch tip moved during the review | NOTE | **ACCEPTED**: this record names the branch and the base; the acceptance (the PR request and the coordinator's result) names the exact head SHA. |
| the bundle parity rule now excludes test files from the production scan | NOTE | **ACCEPTED as a deliberate reading**: the rule is about PRODUCTION readers. The scan still asserts that no production module reads bundle wire bytes and that no production module uses the value verifier, and it names the single permitted production importer. |
| the byte counts in the divergence table are character lengths | NOTE | **CORRECTED** in §2: the counts are labelled as characters, with the UTF-8 byte counts. |

## 9. The known environment sensitivities (stated plainly)

The app suite on this VM has pre-existing, load-sensitive failures that are not E-04
regressions: the PDF corpus-audit and the ICU locale-enumeration cases time out at their
default per-test budget under load, and the `grounded-struct-materializer` cases run
close to vitest's 300 s per-test limit. The E-04 reviewer re-ran the same files on a
scratch copy of the base commit and they fail there too. No assertion was weakened,
skipped or deleted to hide them, and the E-04 changes that touched the two
environment-sensitive expectations are recorded in §3 and §2.

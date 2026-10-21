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

**This section was refreshed a second time on 2026-10-21, against the E-04
integrated head, because the branch that carries the audited head's outstanding
units has since shipped them. See §0.3 and §6.**

| rule | statement |
| --- | --- |
| what counts as MET | a gate is MET only when the proof was produced by an independent run **on the integrated head that carries the change**, and that run is recorded. A lane report, a pilot report, or this record's own prose is not proof. |
| what happened | the earlier §6 marked EG-05, EG-06, EG-08, EG-10, EG-11 and EG-13 "met" on the strength of implementation and of lane-local runs. The audit's measurements contradict five of the six, and the sixth (EG-13) was never demonstrated at all. |
| what this update does | §6 now carries the audit's verdict per gate with its basis, and every gate that depends on a not-yet-integrated unit is marked PENDING. **At the audited head `7370b71a`** the six named gates (EG-05, EG-06, EG-08, EG-10, EG-11, EG-13) are **not** met. |
| what is NOT claimed here | **at the audited head `7370b71a`**: no receipt repair, no renderer repair and no release-path repair is claimed as done. The units below are reviewed; their results are not yet in `main` / PR #455, and the gates that depend on them stay PENDING until they are integrated and re-measured. **At the integrated head those repairs ARE in the branch** — see §0.3 and §6. |

### 0.1 The two independently reviewed units this record's base carries

| unit | commit | independent review | status |
| --- | --- | --- | --- |
| the graph **property-access** detection in the boundary guard | `be3556aa10668b41c7374af6d206aa6cd8c872e4` ("test(publication): detect graph-bearing property access in the boundary guard") | PASS, no P0/P1/P2 findings, four P3 observations (`S/app-e04-graph-property-guard-review-report.md`) | **independently reviewed; NOT yet in `main` / PR #455** |
| the E-03/E-04 boundary-guard merge-conflict resolution | `a0a4dcc73e017c5d2208cc50c5ff3dde65c87ab1` ("merge(E-04/E-03): resolve the boundary-guard conflict preserving both guard contracts") | PASS, zero actionable defects (`S/app-e04-guard-integration-review-report.md`) | **independently reviewed; NOT yet in `main` / PR #455** |

Both units are in this record's base (`9675feea0a63a8ed4109aed2e540adae9d46c922`, which
combines them and carries no E-05 content). A review verdict on a unit is not the same
thing as the unit being integrated and re-measured on the integrated head, so every gate
that depends on them stays PENDING here.

> **Correction 2026-10-21 — the `be3556aa` attribution.** This section attributed the
> property-access detection to `be3556aa10668b41c7374af6d206aa6cd8c872e4`. At the
> integrated head **that SHA is not an ancestor of it**: `git merge-base --is-ancestor
> be3556aa HEAD` exits `1`. The **same change is in this record's base** under
> `9675feea`: `git log -S graphTypeOf -- tests/helpers/publication-graph-boundary.ts`
> names `9675feea0a63a8ed4109aed2e540adae9d46c922` ("test(publication): detect
> graph-bearing property access in the boundary guard") as the commit that introduced
> it. The merge-conflict resolution `a0a4dcc7` **is** an ancestor of the integrated head
> (`git merge-base --is-ancestor a0a4dcc7 HEAD` exits `0`). The truth is therefore:
> **the property-access detection is in the base, under `9675feea`; `be3556aa` is a
> reviewed unit of the same change that was folded into the base, and the integrated
> head carries the change through the base.** §6's EG-06 and EG-08 rows are corrected
> to say so.

### 0.2 Where this update was made

| field | value |
| --- | --- |
| branch | `test/struct-e04-both-mode-parity-20261021` |
| base | `9675feea0a63a8ed4109aed2e540adae9d46c922` (the initial base of this lane: the guard merge `a0a4dcc7` plus the independently reviewed property guard, no E-05 content) |
| governing plan | `docs/superpowers/plans/2026-10-20-struct-full-cutover-sequence.md` at commit `51c6656f` |
| this update's scope | §0, §1.2 (the proof-artifact reference), §6 (the gate table), and the new §6.1 (both-mode parity) and §6.2 (the re-pointed assertion) |
| source changes | none. This update changed no production source, no renderer, no binding, no helper, no schema, no manifest, no lock and no CI file. |

### 0.3 The second update: the refresh against the integrated head (2026-10-21)

**Why this update was made.** The independent final review of the E-04 integrated
head (`S/app-e04-integrated-final-review-result.json`, verdict `PASS_WITH_FINDINGS`)
returned two actionable findings against the **documentation**: the checked-in
`ResearchPaper` caller inventory no longer matched the tree, and this record's §6
gate table (with the migration-status E-04 row) still described the acceptance-audit
head. This section records what this second update changed and what it did not.

| field | value |
| --- | --- |
| branch | `docs/struct-e04-record-refresh-20261021` |
| base | `ead376c1541b67cc252ba77247185a36113ace36` (the E-04 integrated head of `feat/struct-e04-integrated-20261021`) |
| scope | §0.1 (the `be3556aa` attribution), §0.3 (this section), §2.4 (the note that annotates the EG-13 row), §5 (the scope note on the candidate's own measurements), §6 (the gate table, refreshed against the integrated head), §6.1 (the "what these cases do NOT prove" list), §7 (the not-done list), and the three documents this update owns |
| source changes | **none.** This update changed no production source, no renderer, no binding, no helper, no schema, no manifest, no lock, no CI file, no fixture, no golden and no vendor artifact. It is a documentation-only refresh. |
| what it does NOT claim | it does not claim that E-04 is accepted, that CI passed, that the branch was merged, that a gate that the evidence does not support is met, or that the independent review's findings are closed by anything other than this documentation refresh. |

**The three documents this update owns** are `docs/struct-research-paper-caller-inventory.md`,
`docs/struct-migration-status/e-04-dated-record-20261020.md` (this file) and
`docs/struct-migration-status.md`.

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
| `structured-manuscript-docx` XHTML | `cf4eef0eb1edbddca464b1bcd7d1daac59a1b0715cc8e69c64c9a20270f2cd95` (4147 characters = 4177 UTF-8 bytes) | `c4408a26f78577f7da86206ab7ff56ec0d18f883dd03f2d4cb7ff41e447dcc94` (4264 characters = 4294 UTF-8 bytes) | **no** |
| `structured-manuscript-docx` EPUB | `05d10b8eb8fae0273217fa7d6c4b24310724536b468c2188536bd70c49953ff8` | `dabd7d18488eb11313bb8cfd6970a9c702160bd91426f73288ca8182736963ac` | **no** |
| `adapter-parity/ordinary-pdf` XHTML | `4d9bc0a62fb7d4ce8aefbd1811ab5ea7246f33f64cd8721582ab93e1532f14f2` | `4d9bc0a62fb7d4ce8aefbd1811ab5ea7246f33f64cd8721582ab93e1532f14f2` | yes |
| `adapter-parity/ordinary-pdf` EPUB | `1d3c048035a2228a552e9d45d3258c3e75b3dccbe8d141e7b3e0b0e85c26a335` | `1d3c048035a2228a552e9d45d3258c3e75b3dccbe8d141e7b3e0b0e85c26a335` | yes |
| `adapter-parity/source-preserved-pdf` XHTML | `eba808794a97517df241e6dff1d289bd19c2584a84b5dabcf58b61896f87c444` (4529 characters = 4529 UTF-8 bytes) | `ea1838aa372cfb6c80b274c6163532861c759bcb69c88e16011768214854a8eb` (4552 characters = 4552 UTF-8 bytes) | **no** |
| `adapter-parity/source-preserved-pdf` EPUB | `STRUCT_EPUB_RECOVERY_REVIEW_REQUIRED` | `STRUCT_EPUB_RECOVERY_REVIEW_REQUIRED` | identical refusal |

> **RE-MEASURED 2026-10-21 at the pinned Struct artifact
> `3d3a7c95b1c55a9ff4b527eee5acf36c168cd896`** (see §2.4). The table above
> was measured at the previous pin `119d0411` and is re-frozen here. The
> PACKAGE column moved for the two diverging XHTML fixtures and for the
> structured-manuscript EPUB: the pinned renderer now publishes the DECLARED
> list contract and publishes an ATTACHED caption exactly once, inside the
> host's `<figcaption>`. The LOCAL column moved only for the EPUB, because the
> EPUB's `package.opf` and `struct.json` embed the receipt digest; the LOCAL
> XHTML bytes did not move at all.

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

### 2.2 The frozen golden was NOT regenerated — CORRECTED 2026-10-21

> **CORRECTED.** The sentence below was true when this record was written. It
> is **no longer true**: the app's pinned Struct artifact moved to
> `3d3a7c95b1c55a9ff4b527eee5acf36c168cd896` and the app's ingress changed the
> canonical document, so the frozen golden was **re-frozen against the new
> measured reality** in §2.4 — it was re-measured, not regenerated by hand,
> and every value that moved is listed there with the reason it moved. The
> `ordinary-pdf` case and the LOCAL copy's `xhtmlSha256` values did **not**
> move and were not edited.

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

> **SUPERSEDED on 2026-10-21 by §2.4.** The table below is the inline-code
> follow-up's own record and it was the pin at the time. The app's CURRENT
> pin is `3d3a7c95b1c55a9ff4b527eee5acf36c168cd896`; see §2.4.

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

## 2.4 The nested-lists-and-captions follow-up and the re-frozen baselines (2026-10-21)

The app is repinned again, to the Struct head that publishes the declared
list contract and the attached-caption rule, and the frozen baselines and the
both-mode parity evidence are re-frozen against the NEW measured reality.

**The current pin.**

| field | value |
| --- | --- |
| Struct head | `3d3a7c95b1c55a9ff4b527eee5acf36c168cd896` |
| Struct base for this delta | `119d0411edb525dc7cce2f0f80a5c2ab37f5d040` (the §2.3 pin) |
| artifact | `erniesg-struct-0.0.0-3d3a7c95b1c55a9ff4b527eee5acf36c168cd896.tgz` |
| sha256 | `836f6d3ead7a5ce1dc59f2799c80dfbe5c52931836a5b4f2749ab5b1920a55f9` |
| integrity | `sha512-1wpcnARYQmVSsxiLRiSEtp5hd8h9WvxH22cSN/XwCrx0NWPxFif8mswYvF40PybKzi//e1sCPKuap4UiY+deaQ==` |
| packed files / uncompressed bytes | 33 / 368,119 |
| toolchain | node 22.22.3, npm 10.9.8, pnpm 12.8.1 |

The previous reviewed artifact file
(`erniesg-struct-0.0.0-119d0411edb525dc7cce2f0f80a5c2ab37f5d040.tgz`, sha256
`bb86a4bc192c2485f1029dee32964e5488e9277345dfb5a222d17fa3cfce6296`) is still
in `vendor/struct/` and is unchanged: it was neither rewritten nor reused, it
is simply no longer the pinned one.

**What the new pin and the new app ingress changed in the published output.**
The app's own ingress now declares the caption attachment the research graph
states, and the caption text is carried ONCE, in the caption block. The
pinned renderer resolves an attached caption only through that declared
relationship and publishes it exactly once, inside the host's `<figcaption>`.
The pinned renderer also publishes the DECLARED list contract, so the ordered
container and the nested bullet list survive the cut.

**What was re-frozen, and what did NOT move.** The frozen baselines are
re-frozen against the measured reality, and only the values that genuinely
moved were edited:

| baseline | moved? | why |
| --- | --- | --- |
| `tests/fixtures/struct-adapter-parity/expected.json`, `structured-docx` | **yes** | the document gained the two caption relationships (`sourceRelationshipCount` 5 → 7), the host blocks no longer carry a second copy of the caption text (`sourceTextCharacterCount` 492 → 416), and the document, receipt, EPUB and bundle digests all follow |
| `tests/fixtures/struct-adapter-parity/expected.json`, `source-preserved-pdf` | **yes** | the same reason, one caption relationship (`26` → `27`, `1276` → `1263`) |
| `tests/fixtures/struct-adapter-parity/expected.json`, `ordinary-pdf` | **no** | the fixture carries no caption and no list; every measured value is byte-identical and the file was not edited there |
| `tests/fixtures/struct-adapter-parity/expected.json`, `bundle.*` | **yes**, for the two cases above | the bundle is the encoded document, so it moves with the document |
| `src/struct/struct.test.ts`, the structured-DOCX receipt pin | **yes** | the receipt digest is the digest of the changed document |
| `src/research/struct-renderer-import-parity.test.ts`, the package XHTML digests | **yes** | the pinned package renderer now publishes the nested list and the attached caption once, so its XHTML bytes moved for the two diverging fixtures |
| `src/research/struct-renderer-import-parity.test.ts`, the local XHTML digests | **no** | the local compatibility copy is unchanged and its bytes did not move: it resolves the figure's caption from the caption block, so the host's own copy of the caption text dropping out left the local bytes identical |
| `src/research/struct-renderer-import-parity.test.ts`, the EPUB digests | **yes** | the EPUB's `package.opf` and `struct.json` embed the receipt digest |
| `src/research/struct-renderer-import-parity.test.ts`, the profiled EPUB digests | **yes** | the same reason |
| `tests/fixtures/struct-adapter-parity/expected.json`, `xhtmlSha256` (the LOCAL copy) | **no** | see the local XHTML row above |

**The re-measured both-mode parity (EG-13).** The comparison was re-measured
on the integrated head, not copied from the earlier record. The two
divergences the earlier record measured are GONE: the two overloads now
publish the figure caption once each, inside the host's `<figcaption>`, and
they publish the same ordered and nested list structure. The re-measurement
and the scoped common domain are in §6.1.

**What this record does NOT claim.** This update does not claim that EG-13 is
satisfied, that E-04 is accepted, that CI passed, or that the PR was merged.
§6's gate table still carries every gate that is not met.

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
> quoted below is the receipt the candidate produced; **at the audited head
> `7370b71a`** the release path never compared that receipt's package identity against
> `vendor/struct/provenance.json`, so at that head the receipt was a measurement and not
> the EG-10 proof. **That is a fact about the audited head, not about the integrated
> head**: at the integrated head the release path does compare it, and §6's EG-10 row
> carries the evidence. The receipt quoted below is still the **candidate's** receipt,
> from the candidate's own pin; it is not the proof.

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

## 6. The E-04 future-gate table (corrected 2026-10-21; refreshed against the integrated head 2026-10-21)

**The statuses below were corrected twice, and each correction is scoped to the head it
was measured at.** The earlier version of this table marked every gate "met" except
EG-14, on the strength of implementation and of lane-local runs. The independent
acceptance audit at `7370b71a` measured the gates against the integrated tree and
contradicted six of them (findings A-10, A-12 and the gate matrix in
`S/app-e04-acceptance-audit-report.md` §4). §6 then carried that audit's verdict and its
basis. **On 2026-10-21 §6 was refreshed again against the E-04 integrated head**, because
the branch that carries the audited head's outstanding units has since shipped them, and
because several of the audited head's statements are false at the integrated head.
**A lane report saying PASS is not gate satisfaction.**

`SATISFIED` in this table means: an independent run on an integrated head demonstrated the
gate and that run is recorded. `PARTIAL` means: part of the gate is demonstrated and the
rest is not. `NOT SATISFIED` means: the gate was measured and the measurement contradicts
it. `PENDING` means: the gate needs a proof that has not been produced on an integrated
head.

### 6.0 Which head each status is measured at, and which commits carry the obligations

| head | what it is | what it carries |
| --- | --- | --- |
| `7370b71a` | the acceptance-audit head | the audit's measurements; every statement of the form "the audit found …" below belongs to that head |
| `feat/struct-e04-integrated-20261021` | the integrated branch this record ships on | the source units named below |

**The integrated branch's own tip SHA is deliberately not named here.** It goes stale the
moment the branch is merged onto `main`. The obligations are named by the **source-unit
commits** that carry them, because those SHAs are stable:

| obligation | source-unit commit(s) |
| --- | --- |
| the forward `ResearchPaper` → `PublicationGraph` producer is retired | `a2a2ee1d` |
| the receipt/admission lane | `90e3edd7` |
| the renderer lane | `03dd4b9c` |
| the both-mode parity evidence | `87cdb116` |
| the caption lane | `5fca6c79`, `6d4783c1`, `28c9433a` |
| the list-container expectation fix | `0401bc2f` |
| the baseline re-freeze | `3b48976b` (the last **content** commit of the integrated branch) |
| the vendor artifact repin | `993c0d3a` |

**The pinned Struct artifact every row below is measured against** is the source commit
`3d3a7c95b1c55a9ff4b527eee5acf36c168cd896`, the artifact
`erniesg-struct-0.0.0-3d3a7c95b1c55a9ff4b527eee5acf36c168cd896.tgz`, sha256
`836f6d3ead7a5ce1dc59f2799c80dfbe5c52931836a5b4f2749ab5b1920a55f9`
(`vendor/struct/provenance.json`).

> **Updated 2026-10-21 (§2.4).** One row moved after the re-freeze: **EG-13**
> is re-measured on the integrated head and is now **PARTIAL** (the two
> overloads agree over the common supported semantic domain; the remaining
> inline-code difference is a scoped model boundary, and the corpus is still
> a pilot). Every other row keeps the acceptance audit's verdict **at the
> audited head `7370b71a`**: **EG-05, EG-06, EG-08, EG-10 and EG-11 are not
> met**, and EG-01, EG-02, EG-03 and EG-15 are partial or not satisfied.
> **EG-13 is PARTIAL, which is not "met"**: a partially demonstrated gate is
> not a satisfied gate, and the pilot corpus is not complete. The re-freeze
> changed no production source and no gate other than EG-13's row.
>
> **Updated again 2026-10-21 (§6).** The gate table was refreshed against the
> **integrated head**, because the branch that carries the audited head's
> outstanding units has since shipped them. At the integrated head the
> statuses differ from the audited head's, and §6 names the source-unit
> commits that carry each obligation. The audited head's statements are kept
> in §6 and attributed to that head, so both remain readable.

| # | Gate | Status (refreshed 2026-10-21, at the integrated head) | Basis |
| --- | --- | --- | --- |
| EG-01 | the graph is an ephemeral renderer plan from one pinned approved Struct revision | **SATISFIED** | the non-Struct forward producer is gone: `a2a2ee1d` deleted `src/publication/research-paper-adapter.ts` (237 lines) and its test, and `src/publication/research-paper-source-retirement.test.ts:110-141` asserts that the module does not exist, that **no production module** of `src`, `tools`, `packages` or `scripts` declares `researchPaperToPublicationGraph`, `adaptResearchPaper`, `researchPaperSourceAdapter` or `RESEARCH_PAPER_ADAPTER_ID`, and that the default registry refuses a `research-paper` adapter. The default registry registers `astroPublicationAdapter` and `structPublicationAdapter` only (`src/publication/adapter-registry.ts:54-58`), and the Astro adapter produces the one approved Struct revision through the app-owned MDX ingress (`src/publication/adapters/astro.ts:32-33`). **At the audited head `7370b71a` this row was PARTIAL**, because the forward producer was still exported and allowlisted (audit A-04). |
| EG-02 | the graph owns no independent text | **SATISFIED** | the only projection left is `src/publication/struct-adapter.ts`, and it copies `StructBlock.text` into the graph (`:779`, `:797`, `:803`, `:819`, `:918`, `:1102`, `:1280`); `tests/publication-struct-double-adapt.test.ts:155-156` asserts that the graph never authors text. The producer that minted graph text from a paper is retired (`a2a2ee1d`). **At the audited head `7370b71a` this row was PARTIAL**, because the research-paper bridge still minted graph text from a paper (audit §4). |
| EG-03 | the graph owns no independent semantic ids | **SATISFIED** | the projection's node id is the Struct block id, verbatim (`src/publication/struct-adapter.ts:696`), and the published element ids are Struct-derived; the bridge's own "graph ids == paper ids" assertion went with the retired module (`a2a2ee1d`). **At the audited head `7370b71a` this row was PARTIAL** (audit §4). |
| EG-04 | the graph owns no persistence | **SATISFIED** | the renderer persists only the Struct artifacts, and `publication:check` refuses a present `publication-graph.json` (`tools/publication-check.mjs:1043-1055`, called at `:1219`); proven by `tests/publication-cli-facade.test.mjs` and `src/publication/renderers/vivliostyle.persistence.test.ts`, green in the audit's run. |
| EG-05 | the graph owns no receipt | **SATISFIED** | the receipt's source identity is the discriminated `sourceBinding`, and the struct-cutover variant makes `semanticReceiptSha256` **mandatory** (`src/publication/source-binding.ts:38-50`). The graph, asset and canonical-subset digests are produced only as back-compat diagnostics (`src/publication/publishing-facade.ts:444`, `src/publication/source-adapter.ts:232`), and admission neither compares nor requires them: a present diagnostic only has to be a well-formed digest (`tools/publication-check.mjs:1258-1272`), and the checker no longer imports `canonicalSubsetSha256ForPlan`. **At the audited head `7370b71a` this row was NOT SATISFIED**: `canonicalSubsetSha256` was still compared at admission and `receipt.source.graphSha256` was still required (audit A-06/A-10). |
| EG-06 | the graph owns no writer and no release path | **SATISFIED** | no CLI tool **imports** a graph symbol: the only occurrence of a graph symbol's name in `tools/**` is the checker's own function name `assertNoPersistedPublicationGraph` (`tools/publication-check.mjs:1043`, called at `:1219`); the release path imports only the graph-free facade helpers and the pinned Struct decoders (`tools/publication-check.mjs:1-41`), and the published XHTML/HTML/EPUB come from the pinned package renderers (the renderer lane, `03dd4b9c`). The guard now sees a graph-bearing **value**, not only a graph-bearing name, because the property-access detection is **in this record's base** under `9675feea` (see §0.1) — **not** `be3556aa`, which is not an ancestor of the integrated head. **At the audited head `7370b71a` this row was PENDING**: the release path still ran the graph pipeline and the published EPUB/XHTML/HTML were graph-authored (audit A-03), and the guard could not see graph-bearing values (audit A-05). |
| EG-07 | no reverse graph→ResearchPaper writer | **SATISFIED** | the reverse writer was retired by `5c6027ef` and the whole module by `a2a2ee1d`; the symbol `publicationGraphToResearchPaper` now appears in **no source file** of the repository — a repository-wide search for it matches only `docs/**`. **At the audited head `7370b71a` this row was SATISFIED** because the module's own test then asserted that the export was absent; that assertion went with the retired module, and the module's own absence is asserted instead (`src/publication/research-paper-source-retirement.test.ts:110-112`). |
| EG-08 | the red-first static absence assertion | **SATISFIED** | the compiler-checker guard `tests/publication-graph-boundary.test.ts`, with its machinery in `tests/helpers/publication-graph-boundary.ts`, resolves a graph-bearing **value** through the type checker — property, element, binding and parameter reads whose declared or inferred type carries the graph — not only by symbol name, and it carries its own non-vacuity probes. The forward bridge's allowlist entry was removed from `PERMITTED_GRAPH_IMPORTERS` by `a2a2ee1d`, so the guard covers that module too; the permitted set is now six modules (`tests/helpers/publication-graph-boundary.ts:69-76`). The property-access detection itself is **in this record's base** under `9675feea`, not `be3556aa` (see §0.1). **At the audited head `7370b71a` this row was PENDING**: the guard resolved symbol names only there (audit A-05) and the forward bridge was allowlisted (audit A-04). |
| EG-09 | byte-identical double adapt; the graph is never persisted | **SATISFIED** | `tests/publication-struct-double-adapt.test.ts` (7 tests, green in the audit's run and re-verified by the independent review of the integrated head, `S/app-e04-integrated-final-review-result.json` A-13): identical graph bytes, identical encoded document bytes, identical binding, identical persisted serialization, and "never lets the graph author text or a semantic id". |
| EG-10 | the receipts carry the Struct digests and the exact package pin | **SATISFIED** | the struct-cutover binding carries the semantic receipt digest as a **mandatory** field and all five package-identity fields (`src/publication/source-binding.ts:38-50`); the release check compares all five against the trusted pin (`tools/publication-check.mjs:1143-1158`, `readStructPackagePin()` → `vendor/struct/provenance.json`) and reads the **receipt-bound `struct-bundle.bin`** with a bounded read and decodes it through the pinned package decoder under the digest the receipt claims (`tools/publication-check.mjs:1066-1111`, `:1182-1210`). The pin is the source commit `3d3a7c95b1c55a9ff4b527eee5acf36c168cd896`, the artifact `erniesg-struct-0.0.0-3d3a7c95b1c55a9ff4b527eee5acf36c168cd896.tgz`, sha256 `836f6d3ead7a5ce1dc59f2799c80dfbe5c52931836a5b4f2749ab5b1920a55f9`. **CORRECTION 2026-10-21:** the audited head's basis — "Re-checked at this record's base: `readStructPackagePin` is referenced only from tests, never from the release path, and `tools/publication-check.mjs` reads `struct-bundle.json`, not a receipt-bound `struct-bundle.bin`" — was true at `7370b71a` and at the base `9675feea`, and is **false at the integrated head**. The published receipt quoted in §5 is still the **candidate's** receipt, from the candidate's own pin; it is not the EG-10 proof. |
| EG-11 | `ResearchPaper` stays a read-only compatibility model with a caller inventory | **SATISFIED** (the inventory half is refreshed by the companion documentation unit) | the app-owned `ResearchPaper` overloads are unchanged (`src/research/epub.ts:1422-1447`, `:2094-2118`), and the retirement test proves that the legacy read-only surface survived the bridge's retirement (`src/publication/research-paper-source-retirement.test.ts:143-155`). The checked-in inventory `docs/struct-research-paper-caller-inventory.md` was **stale** at this head: it still described the producer that `a2a2ee1d` deleted, and its §3b still named two files that do not import `src/research/epub.ts` at all. It is refreshed by the companion documentation unit `docs/struct-e04-record-refresh-20261021` (base `ead376c1…`), which re-measures every row against this head and re-marks the retired producer as `RETIRED`. **Not proved here:** no test asserts that the inventory is accurate; the grep-bounded limitation recorded in the inventory's own §7 stands. **At the audited head `7370b71a` this row was PARTIAL** (audit A-11). |
| EG-12 | EPUBCheck / Ace / human accessibility stay app-owned | **SATISFIED** | the checker runs EPUBCheck and asserts the accessibility metadata, the app builds that metadata, and the pinned package renderer provably emits none of it, so app ownership is load-bearing (`tools/publication-check.mjs`; `src/publication/renderers/vivliostyle.ts`). |
| EG-13 | the legacy overloads keep both-mode parity | **PARTIAL** | the earlier "met" was a provisional claim: the legacy-mode tests proved byte-stability and *distinctness* of the two modes and never agreement on the same content (audit A-12). **Re-measured 2026-10-21** on the integrated head at the pinned Struct artifact `3d3a7c95b1c55a9ff4b527eee5acf36c168cd896` (the both-mode evidence lane, `87cdb116`): the two overloads now AGREE over the common supported semantic domain — the frozen manuscript compares clean over the whole comparison, with no exclusion at all (`src/research/struct-renderer-import-parity.test.ts:1161-1183`) — and the only difference the comparison still reports is the inline-code mark, which is a scoped model boundary of the deprecated legacy model. The independent review of the integrated head reproduced that measurement from its own probe (`S/app-e04-integrated-final-review-result.json`, A-12). **The gate is still not recorded as satisfied**, and a reproduced measurement does not change that: the corpus is a pilot that does not cover quote blocks, code blocks, equations, footnote-heavy publications, multi-asset figures, right-to-left text, the readable fallback or the EPUB archive side. See §6.1. |
| EG-14 | the E-07 deletion gates | **PENDING (E-07)** | the local `src/struct/**` copies stay; this record adds the E-07 notes |
| EG-15 | no non-Struct graph producer remains | **SATISFIED** | the forward producer is deleted (`a2a2ee1d`), the allowlist entry for it was removed from the guard's permitted importers with it (`tests/helpers/publication-graph-boundary.ts:69-76`), the default registry registers no `research-paper` adapter (`src/publication/adapter-registry.ts:54-58`), and the retirement test asserts the module's absence and the absence of its four symbols from every production module (`src/publication/research-paper-source-retirement.test.ts:109-134`). **CORRECTION 2026-10-21:** the audited head's basis — "the forward producer was still exported and allowlisted", "that result is **not** claimed here", and "EG-08's guard must stay red until it is gone" — was true at `7370b71a` and is **false at the integrated head**: the producer is gone, the allowlist entry is gone, and EG-08's guard is satisfied at this head. |

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
| `asset-link` | the frozen structured-manuscript DOCX | **one** reconstruction, published through both overloads: the legacy side is the importer's own `ResearchPaper` with the importer's own reconstruction, the Struct side is the app-owned adapter's `StructDocument` for the same reconstruction. Neither side is authored by the test. | the published asset set is identical (`assets/asset-img-b0007-rId4-431ced6916a2.png`) and so is its alt text; the external link is identical in href and in text; **re-measured 2026-10-21: the full unit sequence now AGREES** | nothing inside the common domain — the re-measured comparison is clean |
| `table-reference` | the same frozen structured-manuscript DOCX | as above | the semantic table's cell text in reading order is identical (`Language`, `Greeting`, `English`, `Hello`, `中文`, `你好`); the footnote and endnote references resolve to targets whose text is identical; **re-measured 2026-10-21: the full unit sequence now AGREES** | nothing inside the common domain — the re-measured comparison is clean |

**The re-measured divergences (2026-10-21, on the integrated head).**

The comparison was **re-measured**, not copied: the two overloads were
published again at the pinned Struct artifact
`3d3a7c95b1c55a9ff4b527eee5acf36c168cd896` (§2.4) and the comparison was
recorded from that run. The record is corrected, not deleted:

1. **The Struct overload published the figure caption twice.** — **RESOLVED
   in the new measured state.** The legacy overload publishes the figure
   caption once, inside the figure's `<figcaption>`, and the table caption
   once, inside the table figure's `<figcaption>`. The Struct overload now
   publishes exactly the same two captions, in the same two `<figcaption>`
   elements: the caption is attached to its host through the document's
   declared caption relationship and is published exactly once, and the
   caption block is not published again as a paragraph (there is no
   `class="caption"` element in the Struct output at all).
2. **The Struct overload flattened the list structure.** — **RESOLVED in the
   new measured state.** The legacy overload publishes an ordered list
   (`ol`) with a nested bullet list (`ul`) inside the parent item, at depths
   1 and 2. The Struct overload now publishes the same container, the same
   nesting and the same depths.
3. **The legacy overload cannot publish an inline-code mark.** — **REMAINS,
   and it is a SCOPED MODEL BOUNDARY, not a silent mismatch.** The pinned
   `StructInline` carries an optional `code` flag, so the Struct overload
   publishes `<code>main</code>`. The deprecated legacy `ResearchPaper`
   inline-run model has **no field** for an inline-code mark, so the legacy
   overload degrades the mark to plain text inside the same text run. The
   deprecated legacy types are **not** widened to force a false equality.
   The common supported semantic domain therefore **excludes the inline-code
   mark**; the exclusion is a property of the legacy model, and the
   difference is reported with its exact record and classified with a reason.

**The common supported semantic domain (what the comparison now REQUIRES).**

The comparison is scoped to the semantic domain both models can express, and
over that domain the two overloads must AGREE: the same content, the same
block identities and ordering, the same text, the same asset bindings, the
same caption placement and the same nested list structure. The frozen
structured-manuscript DOCX, which carries a heading, paragraphs, a bold and
an italic mark, an external hyperlink, a figure with its alt text, a
semantic table, a figure caption, a table caption, an ordered list with a
nested bullet list, and a footnote/endnote reference pair, now compares
**clean over the WHOLE comparison with no exclusion at all**:
`unitDifferences`, `markupDifferences`, `assetDifferences`,
`externalLinkDifferences` and `internalTargetDifferences` are all empty, and
the two modes publish the same number of units, the same unit kinds, the same
unit signatures and the same text at every position.

The pilot case (`text-heading-inline-code`) is the one case that carries an
inline-code mark, so it is compared over the common domain (the inline-code
mark excluded). Over that domain the two overloads agree on everything, and
the FULL comparison reports exactly ONE difference, which is the classified
inline-code model boundary above. Every difference the comparison still
reports is classified with a reason; a difference inside the common domain
is a defect and the ledger of common-domain differences is empty.

**The comparator is not vacuous.** Three mutations are measured in the test: a text
difference between the paired views, a link difference, and an asset difference (the alt
text of the reconstruction's visual relationship). Each mutation makes the comparison that
passes on the clean fixture report a difference, with the exact differing record. The
mutations are applied to the private fixture (`tests/fixtures/struct-both-mode-parity/`)
and to the in-memory reconstruction, and they are undone by construction: the unmutated
comparison is asserted to be clean in the same file.

**What these cases do NOT prove.** The cases are a pilot, not a proof over every
accepted input. They cover a heading, a paragraph, a bold mark, an inline-code
mark, an external hyperlink, one image asset with its alt text, one semantic
table, an ordered list with a nested list, a figure caption, a table caption
and one footnote/endnote reference pair. They do **not** cover: quote blocks,
code blocks, equations, footnote-heavy publications, multi-asset figures,
publications with more than one table, right-to-left text, the
readable-fallback mode, or the EPUB archive side of either overload. The two
divergences that this section used to record are fixed and re-measured, and the
third (the inline-code mark) is a scoped model boundary that is now excluded
from the common domain and classified. The gate stays **PARTIAL** until the
uncovered constructs are covered.

> **Correction 2026-10-21 (a wording defect the independent review recorded).**
> This list used to say the pilot does **not** cover *"list items in the legacy
> mode"*. That contradicted this section's own measurement: the legacy overload
> publishes an ordered list with a nested bullet list, at depths 1 and 2, and
> the two overloads publish the same structure
> (`src/research/struct-renderer-import-parity.test.ts:1255-1284`). The clause is
> removed because it is false; the measured list coverage is stated above
> instead. The independent review of the integrated head reproduced the same
> list items on both sides (`S/app-e04-integrated-final-review-result.json`,
> A-12).
>
> **The re-measurement has now been independently reviewed on the integrated
> head** — the independent final review reproduced it from its own probe
> (A-12) — so that condition is discharged. **The gate is still PARTIAL**, for
> the reason that has not changed: the corpus is a pilot and the uncovered
> constructs above are still uncovered.

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
  the audited head. The same held at this record's base: the only fixture change in this
  lane is the NEW `tests/fixtures/struct-both-mode-parity/` directory; no existing fixture
  was touched. **Superseded 2026-10-21 by §2.4:** the golden was later
  re-frozen against the new pinned artifact, by measurement.
- The local copies are deleted only at E-07, and §2.2's E-07 note still applies.

---

## 7. Not done / not in scope

- No merge, no deploy, no writer/route/publication activation, no database migration, no
  npm publication, no E-07 deletion.
- The pinned Struct package IS changed, but only by the two narrow follow-ups
  recorded in §2.3 and §2.4: Struct head `119d0411edb525dc7cce2f0f80a5c2ab37f5d040`
  adds one optional boolean field to `StructInline` (the inline-code
  follow-up), and Struct head `3d3a7c95b1c55a9ff4b527eee5acf36c168cd896`
  publishes the declared list contract and the attached-caption rule (the
  nested-lists-and-captions follow-up). **The app's current pin is
  `3d3a7c95b1c55a9ff4b527eee5acf36c168cd896`.** The reviewed Struct 39
  artifact `42fee58e9b1e1888c53e929ad6367a2c128d1607140225387836ee5da53df8f1`
  and the reviewed head `72a64ebbecde6718cbfcf59b17085bd794926cf9` are
  untouched: the old artifact file is still in `vendor/struct/` and was
  neither rewritten nor reused, and the app's pin now names the new artifact.
- **No golden, fixture, expected value, profile or snapshot was regenerated
  or edited** — **CORRECTED 2026-10-21: the frozen golden WAS re-frozen**
  (§2.4). The re-freeze re-measured
  `tests/fixtures/struct-adapter-parity/expected.json` against the new pinned
  artifact and the new app ingress and edited exactly the values that moved;
  the values that did not move were not touched. The one fixture the
  inline-code follow-up added is still a NEW measured record
  (`tests/fixtures/struct-inline-code/case-comparison-20261021.json`).
  `package.json`, `package-lock.json` and the locally excluded
  `pnpm-lock.yaml` were changed only for the repin, and
  `vendor/struct/provenance.json` and `vendor/struct/README.md` were changed
  only to name the new artifact truthfully.
- The Struct repository's own host-harness census sampling race is a SEPARATE follow-up
  branch (`test/bundle-resolver-host-census-wait-20261020`); it does not change the
  reviewed Struct head or the app's pin.
- E-05 (durable editorial publication behind an inactive gate), E-06 (activation) and
  E-07 (deletion) are separate steps and are not part of this record.
- **No receipt repair, no renderer repair and no release-path repair is claimed as done**
  (added 2026-10-21) — **CORRECTED 2026-10-21, and scoped to the audited head
  `7370b71a`.** At that head the receipt-binding rules, the package-pin comparison at
  admission, and the release path's independence from the graph were exactly what the
  audit found unmet (A-01, A-02, A-03, A-06). **At the integrated head those repairs ARE in
  the branch** — the receipt/admission lane (`90e3edd7`) and the renderer lane
  (`03dd4b9c`) — and §6's EG-05, EG-06 and EG-10 rows carry the evidence for that.
  What is still **not** claimed here: the branch is **not** in `main` / PR #455, no
  merge, deploy, activation or publication has happened, the gates are statuses in a
  dated record and not an acceptance, and the independent review of the integrated head
  is a *review*, not an acceptance.
- **This record's first 2026-10-21 update changed no production source, no renderer, no
  binding, no helper, no schema, no manifest, no lock, no CI file and no vendor file.**
  Its changes are: this document, the both-mode parity block in
  `src/research/struct-renderer-import-parity.test.ts`, and the NEW
  `tests/fixtures/struct-both-mode-parity/` directory. No existing fixture was rewritten,
  and no golden, expected value, profile or snapshot was regenerated. **The second
  2026-10-21 update (this one, §0.3) is documentation-only too**: it changed this
  document, `docs/struct-research-paper-caller-inventory.md` and
  `docs/struct-migration-status.md`, and nothing else.

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

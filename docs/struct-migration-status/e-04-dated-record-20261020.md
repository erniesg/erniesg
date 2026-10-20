# E-04 Implementation Record — 2026-10-20

Owner: `erniesg/erniesg` (E-04 IMPLEMENTATION owner for the `erniesg/struct` app cutover)
Branch: `feat/struct-e04-candidate-20261020`
Base: `9003ea7657ef73cbad271e6a82eab5f27f649e91` (the app E-03 candidate head, PR #454)
Precondition: E-03 passed (`9003ea76` exists with commits and is pushed).

This record is the E-04 dated record. It states what was changed, what was measured, and
what is still PENDING. It does not claim a cutover, an activation, or a merge.

---

## 1. The two halves of E-04

E-04 has two obligations: cut the app's StructDocument render path over to the pinned
public package renderers, and converge the `PublicationGraph` so it can no longer be a
competing semantic authority. Both are done in this candidate.

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

The local compatibility copies `src/struct/{xhtml,epub,emitted-ids}.ts` and the rest of
`src/struct/**` are **physically unchanged**; `git diff --stat` shows no change under
`src/struct/`. They are stale compatibility copies that E-07 deletes.

### 1.2 The PublicationGraph authority convergence

ADR-0001 requires the competing graph to be retired or narrowed to an ephemeral,
mechanically derived renderer plan from one pinned approved Struct revision, owning no
independent text, no semantic IDs, no persistence, no receipt, no writer, no release path
and no annotation authority. A renamed full competing schema is not acceptable.

The proof that the graph owned ALL of those is in the E-04 proof record
(`app-e04-graph-proof-report.md`): a compiler-checker (not grep) importer inventory, the
live production build and check executed end to end, and the five mandatory pilot paths.
The verdict was **NARROW**, and the graph was narrowed:

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
| `structured-manuscript-docx` XHTML | `cf4eef0eb1edbddca464b1bcd7d1daac59a1b0715cc8e69c64c9a20270f2cd95` (4147 bytes) | `a74427183599f3dc213465c5adac4451994603dbe4057962aefc5b2f0c198b28` (4166 bytes) | **no** |
| `structured-manuscript-docx` EPUB | `f859d1ad1fadc8c897cc3a294a09845fdae5d5360fede37d2a40c16a81386c72` | `ee11cb70bf0300a69f1ec4621c8d6d53cfc4f18dc9791a504f08f24b9afcf3c9` | **no** |
| `adapter-parity/ordinary-pdf` XHTML | `4d9bc0a62fb7d4ce8aefbd1811ab5ea7246f33f64cd8721582ab93e1532f14f2` | `4d9bc0a62fb7d4ce8aefbd1811ab5ea7246f33f64cd8721582ab93e1532f14f2` | yes |
| `adapter-parity/ordinary-pdf` EPUB | `1d3c048035a2228a552e9d45d3258c3e75b3dccbe8d141e7b3e0b0e85c26a335` | `1d3c048035a2228a552e9d45d3258c3e75b3dccbe8d141e7b3e0b0e85c26a335` | yes |
| `adapter-parity/source-preserved-pdf` XHTML | `eba808794a97517df241e6dff1d289bd19c2584a84b5dabcf58b61896f87c444` (4529) | `0106902dab681da128171ab2937f4ac9a6bfbd8c2418e135a0de25b6c48411be` (4520) | **no** |
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
- the **footnote reference anchor id** is the Struct relationship id instead of
  `ref-<identifier>`;
- **one inline-code span** loses its `<code>` styling. The pinned `StructInline` has no
  code flag (nor a strikethrough or a hard-break flag), and the app's own Struct renderer
  already rendered only bold/italic/superscript/subscript, so the narrowing converges the
  publication pipeline onto the app's existing Struct publication semantics. The loss is
  **not silent**: the conversion emits a `lossy-inline-style` warning diagnostic naming
  the block that lost the style, and a test asserts that diagnostic. The corpus scan
  measured 0 strikethrough spans, 5 hard breaks (0 in the pinned entry) and exactly one
  inline-code span.

### 2.2 The frozen golden was NOT regenerated

`tests/fixtures/struct-adapter-parity/expected.json` is unchanged. The repository's
frozen parity test (`tests/struct-adapter-parity.test.ts`) keeps measuring the local
copies through `tests/fixtures/struct-adapter-parity/observe.ts` and stays green.

**E-07 note:** when the local copies are deleted at E-07, `observe.ts` must migrate to the
package renderers, and the frozen `xhtmlSha256`/`epubSha256` values will then change.

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

- **The real production build**: `npm run build:astro` (181 pages, exit 0), then
  `npm run publication:build -- --adapter astro --entry moving-to-cloudflare-with-astro --output .agent/evidence/publication`
  (exit 0, 4 artifacts). The output directory contains `struct-document.json`,
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
- **The EG-08 graph-absence guard** (`tests/publication-graph-boundary.test.ts`,
  compiler-checker based, alias-resolving, `.astro` aware, with the four mandatory
  non-vacuity proofs) is GREEN on the integrated candidate, and the EG-09 double-adapt
  conformance is GREEN: `Test Files 2 passed (2); Tests 17 passed (17)`.
- **The E-04 family guard entry** (`tests/struct-adapter-boundary.test.ts`) is RED before
  the cut and GREEN after: in a scratch copy with the renderer import switch reverted, the
  new entry reports the three reverted imports; on the candidate head the guard file passes
  8/8 (the 6 pre-existing assertions plus the 2 new E-04 blocks).
- **`npx astro check`**: 0 errors.

---

## 6. The E-04 future-gate table (the coordinator's own status)

| # | Gate | Status at this head | Evidence |
| --- | --- | --- | --- |
| EG-01 | the graph is an ephemeral renderer plan from one pinned approved Struct revision | **met** | the Astro adapter produces the one approved Struct revision through the app-owned MDX ingress; the Payload publication path was retired; the CLI selects only the Astro source |
| EG-02 | the graph owns no independent text | **met** | the graph text is copied from `StructBlock.text`; the parity test and the EG-09 conformance assert it |
| EG-03 | the graph owns no independent semantic ids | **met** | the graph node id is the Struct block id; the published element ids are Struct-derived (51 before and after) |
| EG-04 | the graph owns no persistence | **met** | `publication-graph.json` is written by nobody, read by nobody, and its presence makes `publication:check` fail |
| EG-05 | the graph owns no receipt | **met** | the receipt's source identity is the discriminated `sourceBinding`; `graphSha256` is diagnostic only |
| EG-06 | the graph owns no writer and no release path | **met** | neither CLI tool imports a graph symbol; the EG-08 guard proves it with the type checker |
| EG-07 | no reverse graph→ResearchPaper writer | **met** | the export is deleted and a red-first assertion proves the module exports no reverse writer; the forward bridge stays read-only and unregistered |
| EG-08 | the red-first static absence assertion | **met** | `tests/publication-graph-boundary.test.ts`, with the red run listing the offending files and the four non-vacuity proofs |
| EG-09 | byte-identical double adapt; the graph is never persisted | **met** | `tests/publication-struct-double-adapt.test.ts`; the three "never persisted" mechanisms (static, render-output, check-side) |
| EG-10 | the receipts carry the Struct digests and the exact package pin | **met** | the published receipt above; the closed allowlist was widened deliberately with the N1..N9 negative acceptance |
| EG-11 | `ResearchPaper` stays a read-only compatibility model with a caller inventory | **met** | the app-owned overloads are unchanged; the inventory is `docs/struct-research-paper-caller-inventory.md` |
| EG-12 | EPUBCheck / Ace / human accessibility stay app-owned | **met** | the production check still runs EPUBCheck, the accessibility pass and the PDF checks (exit 0) |
| EG-13 | the legacy overloads keep both-mode parity | **met** | the new parity test covers the legacy `ResearchPaper` mode and the Struct mode, with the recorded failure and limit matrix |
| EG-14 | the E-07 deletion gates | **PENDING (E-07)** | the local `src/struct/**` copies stay; this record adds the E-07 notes |

---

## 7. Not done / not in scope

- No merge, no deploy, no writer/route/publication activation, no database migration, no
  npm publication, no E-07 deletion.
- The pinned Struct package is NOT changed: the reviewed candidate head
  `72a64ebbecde6718cbfcf59b17085bd794926cf9` and the artifact
  `42fee58e9b1e1888c53e929ad6367a2c128d1607140225387836ee5da53df8f1` are untouched.
- No golden, fixture, expected value, profile, snapshot, lockfile, `package.json` or
  `vendor/**` file was regenerated or edited.
- The Struct repository's own host-harness census sampling race is a SEPARATE follow-up
  branch (`test/bundle-resolver-host-census-wait-20261020`); it does not change the
  reviewed Struct head or the app's pin.
- E-05 (durable editorial publication behind an inactive gate), E-06 (activation) and
  E-07 (deletion) are separate steps and are not part of this record.

## 8. The known environment sensitivities (stated plainly)

The app suite on this VM has pre-existing, load-sensitive failures that are not E-04
regressions: the PDF corpus-audit and the ICU locale-enumeration cases time out at their
default per-test budget under load, and the `grounded-struct-materializer` cases run
close to vitest's 300 s per-test limit. The E-04 reviewer re-ran the same files on a
scratch copy of the base commit and they fail there too. No assertion was weakened,
skipped or deleted to hide them, and the E-04 changes that touched the two
environment-sensitive expectations are recorded in §3 and §2.

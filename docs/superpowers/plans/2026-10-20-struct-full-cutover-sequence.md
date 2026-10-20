# Ernie.SG Struct full-cutover sequence (E-02 -> E-03 -> E-04)

**Status:** PLANNING ONLY. This document does not cut over, activate, publish, or
delete anything. It does not replace the governing ADR or issue plan; it maps
the concrete remaining implementation seams inferable from the current
contract so later implementation can proceed issue-by-issue after the upstream
Struct contract settles.

## Authority and baselines

- Governing ADR: `docs/superpowers/specs/2026-08-27-cross-repository-domain-ownership-and-package-boundaries.md`
  (ADR-0001, "Domain ownership and package boundaries for Struct, Ernie.SG,
  Rucksack, and Aether").
- Governing issue plan: `docs/superpowers/plans/2026-08-27-cross-repository-architecture-issue-plan.md`
  (E-02 #282, E-03 #283, E-04 #284, E-05 #285, E-06 #286, E-07 #287).
- Execution map: `docs/struct-migration-status.md` (this branch).
- Ernie.SG base head for this plan: `84747cb49a36fea0eb4db0322dbd092430daf754`
  on `docs/struct-cutover-sequence-20261020` (PR #451 "keep recovery
  presentation app-owned"). PR #451 is the reviewed app adapter/recovery seam.
- Ernie.SG reviewed default: `453fb256` (PR #447, app-owned reconstruction
  adapter and frozen parity).
- Pinned app artifact: source `10116f4726da89ebabc823cb25706f2de5386f40`,
  `vendor/struct/erniesg-struct-0.0.0-10116f4726da89ebabc823cb25706f2de5386f40.tgz`,
  SHA-256 `e18d743de5e2c8431b64a830974bd1180299f21cc8ab8cf70a9b184c36ab1374`
  (`vendor/struct/provenance.json`). Public export map at that pin:
  `.`, `./document`, `./identity`, `./ordering`, `./receipt`, `./recovery`,
  `./renderers/xhtml`, `./renderers/epub`. There is no `./bundle` yet
  (`vendor/struct/erniesg-struct-0.0.0-10116f4726da89ebabc823cb25706f2de5386f40.tgz::package/API_MANIFEST.json`
  lists `./bundle` under `unavailablePaths`).
- Struct upstream status at planning time: S-03 (#6) and S-04 (#7) remain open.
  Embedded-only public bundle surface is Struct PR #33; it explicitly excludes
  the external executor, value verifier, and the full resolver conformance
  harness. Default packed-consumer proof establishes existing document subpaths,
  not complete bundle acceptance. Embedded-only is the consumer/MVP scope
  default only; it does not waive the upstream S-03/S-04 full resolver,
  value-verifier, or conformance-harness contract, which remains authoritative.
- Checked-in authority inventories for E-04 (merged from
  `58c9097c7191c182416ee8329fee518b0355a791`; each links back to this plan):
  - [`docs/struct-research-paper-caller-inventory.md`](../../struct-research-paper-caller-inventory.md)
    — the E-04 call-site inventory for `ResearchPaper`
    (`src/research/schema.ts`), the legacy renderer/export overloads
    (`src/research/epub.ts`), and the bidirectional graph bridge
    (`src/publication/research-paper-adapter.ts`).
  - [`docs/struct-publication-graph-authority-inventory.md`](../../struct-publication-graph-authority-inventory.md)
    — the E-04 authority inventory for `PublicationGraph`
    (`src/publication/schema.ts`): definitions, importers, serialization,
    persistence, writers, routes, receipts, the reverse semantic-id/text
    minting seam, and the graph-anchored annotation surface.

  Both documents are **evidence inventories, not decisions and not gate
  satisfaction**. Every "no importer was found" statement in them is
  **grep-bounded, not compiler-proven**: they were produced with `ripgrep`
  only, `node_modules/` was absent, and the repository AST harness
  (`tests/struct-adapter-boundary.test.ts`) could not be executed. Neither
  document contains a runtime, golden, receipt, or activation result. Where
  this plan relies on them, it says so and keeps the same limitation.

This plan assumes the ADR and issue plan acceptance criteria are not weakened.
Anything not inferable from the current contract is left as an explicit decision
with a default recommendation and an admission gate.

## Why E-02/E-03/E-04 are still open

- E-02 requires adapter -> package decode -> **bundle verification** plus frozen
  cross-repository parity. The exact-pinned package has no `./bundle` export, so
  there is no package-owned bundle to verify against.
- E-03 switch of types/codecs/IDs/ordering/recovery facts must not precede a
  passing E-02.
- E-04 depends on E-03 and must decide the `PublicationGraph` / `ResearchPaper`
  canonical-writer question, which cannot be settled until the package renderer
  and bundle boundary are pinned.
- PR #450 (inline-hyperlink conservation) is a separate owner and is still open;
  E-02 structured-DOCX conservation parity depends on it. Do not duplicate the
  fix or regenerate its golden.

## Upstream admission gates (must all pass before the matching step)

| Gate | Evidence required | Blocks | Status |
| --- | --- | --- | --- |
| G-S04 | Exact integrated Struct head, release decision packet, tarball digest, export/API manifest including a complete `./bundle` whose installed runtime + declaration exports and `API_MANIFEST.json` `runtimeExports` agree and directly export `createStructBundle` (handle creation from a document plus supplied asset bytes), `verifyStructBundle`, `decodeStructBundle`, and `encodeStructBundle`; clean-consumer install; full bundle negative matrix; three-run XHTML/EPUB goldens. No app-side bundle pin exists today. | E-02 bundle + E-02 pin bump | OPEN |
| G-PR450 | Inline-hyperlink accounting landed with its own reviewed golden | E-02 structured-DOCX conservation parity | OPEN |
| G-E-WF | Generated publisher workflow registered with drift gate (#281) | E-02 and publication-state work | CLOSED |
| G-EACT | Immutable, authenticated, target-specific explicit-user authorization bound to writer/public-route activation | E-06 only | NOT ELIGIBLE YET |
| G-ARTIFACT | One reviewed commit updates tarball + provenance + `package.json` + `package-lock.json` together, with artifact/parity/boundary tests green | every pin bump | must hold |

No implementation in this plan may run `npm publish`, activate a writer or
public route, deploy, or claim a cutover. Package publication stays outside this
tree.

## Artifact pin / lock / vendor / provenance atomicity

Any E-02/E-03/E-04 pin bump is a single atomic reviewed change over these four
files:

- `vendor/struct/<artifact>.tgz` (new bytes)
- `vendor/struct/provenance.json` (`sourceCommit`, `artifact`, `sha256`,
  `integrity`, `sourceLockfileSha256`)
- `package.json` `dependencies["@erniesg/struct"]`
- `package-lock.json` — **both** entries, `packages[""]` **and**
  `packages["node_modules/@erniesg/struct"]`

plus, when the export map changes, the two named test files
`tests/struct-package-artifact.test.ts` (public export map) and
`tests/struct-package-parity.test.ts` (parity) in the same commit. "Exactly
these files" never excludes those reviewed test updates; no other files are
part of the pin bump.

Both lockfiles stay in step: the committed `package-lock.json` is updated in
the same commit, and the generated `pnpm-lock.yaml` is regenerated from it by
`pnpm import` (rule 3) but is **not** committed.

Rules:

1. Verify tarball SHA-256 and integrity before writing provenance.
2. Update all four together (plus the two named tests when applicable); never
   leave a partially bumped pin. Revert the whole commit on unexpected failures
   in `tests/struct-package-artifact.test.ts`,
   `tests/struct-package-parity.test.ts`, or
   `tests/struct-adapter-boundary.test.ts`, except the reviewed expected
   closure-list change for `./bundle` described in rule 4, which must not
   trigger a revert by construction.
3. Use the shared pnpm store. Do not commit generated `pnpm-lock.yaml`
   (see `docs/struct-migration-status.md`). After any bump that changes
   `package.json`/`package-lock.json`, re-run `pnpm import` from the updated
   `package-lock.json` to regenerate `pnpm-lock.yaml` before the frozen install.
   For an Ernie.SG VM worktree use the documented physical-directory setup:
   `pnpm import` then
   `CI=true pnpm install --node-linker=hoisted --frozen-lockfile --ignore-scripts`,
   then `node tools/publication-install-browser.mjs`.
4. If the S-04 export map adds `./bundle`, in the same reviewed commit (a)
   update the exact expected export list in
   `tests/struct-package-artifact.test.ts`, and (b) remove `'bundle'` from the
   `it.each(['core', 'schema', 'ids', 'bundle'])` closed-path list in
   `tests/struct-package-parity.test.ts` and add a positive `./bundle`
   availability assertion there, while `'core'`/`'schema'`/`'ids'` stay closed.
   Do not silently widen the public surface for any other path, and do not add
   raw `sha256` helpers to the package API.
5. Consume the S-04 artifact through the reproducible local artifact mechanism
   (`file:vendor/...`) when no registry publication is authorized.

## E-02 — App-owned adapter and frozen cross-repository parity

Owner: `erniesg/erniesg`. Preconditions: G-S04 and G-PR450.

### Existing seams (do not recreate)

- Adapter: `src/struct-adapters/from-reconstruction.ts` (implementation),
  `src/struct-adapters/index.ts` (facade), `src/struct/from-reconstruction.ts`
  (compatibility forwarder), `src/struct-adapters/recovery.ts` (app recovery
  presentation).
- Boundary guard: `tests/struct-adapter-boundary.test.ts`.
- Frozen parity: `tests/fixtures/struct-adapter-parity/{cases,observe,freeze}.ts`
  and `tests/fixtures/struct-adapter-parity/expected.json`, exercised by
  `tests/struct-adapter-parity.test.ts` and the explicit skipped
  `tests/struct-adapter-parity.freeze.test.ts`.
- Public API parity: `tests/struct-package-parity.test.ts`.
- Artifact pin: `tests/struct-package-artifact.test.ts`.

### Work

1. Bump the artifact atomically (see atomicity rules) to the S-04 head.
2. Extend `tests/fixtures/struct-adapter-parity/observe.ts` to also:
   - create a handle with the public handle-creating entry point required by
     G-S04, `createStructBundle(document, suppliedAssetBytes)` (document plus
     supplied asset bytes; E-02 is not started until this symbol exists in the
     installed runtime, its `.d.ts`, and `API_MANIFEST.json` `runtimeExports`),
   - encode it (`encodeStructBundle(handle)`),
   - decode it through the bytes-only API (`decodeStructBundle(rawBytes,
     { expectedBundleSha256 })`),
   - record the verified `documentSha256` / `bundleSha256` and asset digest
     conservation.
   If, contrary to G-S04, no public handle-creating symbol is present in the
   installed artifact, do not construct a handle in the app and do not substitute
   a fixture-only path to evade create acceptance; stop and resolve the upstream
   bundle surface with Struct first. A package-produced handle/fixture may be
   used only for read-only decode/encode parity, never as E-02 acceptance
   evidence. There is no app-side bundle pin today.
   Add a new `tests/struct-adapter-bundle-parity.test.ts`. Do not regenerate the
   existing `expected.json` values; add a new reviewed `bundle` block only.
3. Add a bytes-only ingress helper surface for Ernie.SG wire data. At the
   current contract there is no production struct-jar/wire reader; if that
   remains true, record the absence in the test and keep the adapter in-memory.
   Any future ingress MUST call `decodeStructBundle(rawBytes, ...)` and MUST NOT
   use the value verifier for wire data.
4. If external assets are ever used, the resolver executor must pass the S-03
   conformance harness. This plan's default is **embedded-only assets** for
   E-02: no network/filesystem resolver is implemented or activated, and no
   external executor conformance claim is made.
5. Prove documentation checks and the focused suites pass at the exact head.

### E-02 decisions inferable from the current contract

- Ingress is bytes-only; the value verifier is forbidden for wire data.
- Embedded asset payloads are acceptable for the first MVP; external resolver
  execution is deferred and out of scope until a future consumer needs it.
  This embedded-only default is consumer/MVP scope only and does not waive
  upstream S-03/S-04 resolver, value-verifier, or conformance acceptance.
- No writer or route changes occur in E-02.
- Structured-DOCX conservation depends on PR #450's landed golden; E-02 rebases
  onto it rather than re-freezing its expected file.

### E-02 remaining gaps

- No package `./bundle` at the current pin, and no app-side bundle pin exists;
  bundle acceptance is gated by G-S04 only.
- S-04 full negative matrix and three-run goldens not yet at a final integrated
  head.
- PR #450 not landed; the base structured-DOCX `localEncode` is a known
  conservation failure owned by that PR.

## E-03 — Cut core / codecs / IDs / ordering / recovery facts

Owner: `erniesg/erniesg`. Precondition: E-02 passes.

### Strategy

Keep local portable modules physically unchanged (they remain the
compatibility-only copies and keep their own tests green), and change only
production imports to the public package subpaths. This preserves the app's
existing behavior and serialized bytes while the package becomes production
authority. Do not convert codecs/IDs/ordering into forwarding shims in E-03
(only recovery presentation was relocated in PR #451, because S-02 moved those
facts).

### Production import mapping

| Local family | Public package path | Production consumers to switch |
| --- | --- | --- |
| `src/struct/types.ts` | `@erniesg/struct/document` | `src/struct-adapters/from-reconstruction.ts`, `src/publication/struct-adapter.ts`, `src/research/reconstruction-materialization.ts`, `src/research/grounded-struct-materializer.ts`, `src/research/grounded-epub-comparison.ts`, `src/research/reconstruction-attempt-trace.ts` |
| `src/struct/codec*` / `src/struct/codec.ts` | `@erniesg/struct/document` (`decodeStructDocument`, `encodeStructDocument`, `decodeCompatibleStructDocument`, `StructCodecError`) | no current production caller outside `src/struct`; adopt the package decoder at any new production decode boundary |
| `src/struct/ids.ts` | `@erniesg/struct/identity` (`structDigest`, `structId`) | `src/struct-adapters/from-reconstruction.ts`, `src/research/grounded-struct-materializer.ts`, `src/research/grounded-struct-repair-applicator.ts` |
| `src/struct/reading-order.ts` | `@erniesg/struct/ordering` | `src/struct-adapters/from-reconstruction.ts` |

Not migrated (stay app-owned; do not widen the package API for them):

- `src/struct/sha256.ts` and `src/research/sha256-sync.ts` — raw SHA-256 helpers
  are deliberately not public package subpaths. `src/research/reconstruction-refinement.ts`
  and `src/research/reconstruction-attempt-trace.ts` keep their app-owned digest.
- `src/struct/model-consultation-receipt.ts` and
  `src/research/model-consultation-binding.ts` — app model-consultation
  extension (also excluded by E-07). Only `src/struct/consultation-receipt.ts`
  maps to `@erniesg/struct/receipt`.
- `legacyStructDigest` (local `src/struct/ids.ts`) is not a package export.
  Keep it app/test-owned; do not add it to the package to make a replacement
  mechanical.
- `src/struct/recovery.ts` stays a compatibility forwarder to
  `src/struct-adapters/recovery.ts` (PR #451).

### Recovery copy ownership decision

- Package `@erniesg/struct/document` owns the `StructRecovery`,
  `StructDiagnostic`, and `StructDiagnosticSeverity` shapes. Package
  `@erniesg/struct/recovery` owns source-neutral facts:
  `diagnosticCategory`, `recoveryFact`, `recoverySummary`,
  `toStructDiagnostic`, `hasActionableRecovery`, and
  `RecoveryDiagnosticInput` (per the pinned `API_MANIFEST.json`
  `./recovery` runtimeExports). (F9)
- App `src/struct-adapters/recovery.ts` owns presentation: `diagnosticCopy`
  titles/messages/actions, the enriched `recoverySummary` titles/summaries, and
  `userAction`. It is an app-owned presentation adapter, not a migrated family
  and not a portable duplicate.
- App-owned `src/struct-adapters/recovery` permitted importers (presentation or
  type-only; update this list deliberately if a new consumer is added):
  - `src/struct/recovery.ts` (compatibility forwarder) re-exports the app
    presentation symbols;
  - `src/struct/index.ts` via `./recovery` (barrel re-export);
  - `src/research/recovery-projection.ts` (type-only
    `RecoveryDiagnosticInput`);
  - `src/components/research/PublicationImporter.tsx`
    (`diagnosticCopy`, `hasActionableRecovery`, `recoverySummary`).
  `hasActionableRecovery` is the package fact re-exported through the app
  adapter; consuming it via the app adapter is allowed because the app adapter
  wraps package authority in app-owned presentation. (F7)
- Do NOT replace the app copy with the package `recoveryFact` title derivation.
  Upstream derives titles internally via `titleFromCode`, which is not a public
  export and must not be imported (package-private path); cite only the
  observable difference of the public `recoveryFact` result. Do not replace
  with the package default summary strings. That would change explanatory
  wording, serialized document bytes, and receipt hashes. (F9)
- E-03 work: have the app adapter derive/verify each code's category from the
  package fact source, and add a parity test asserting that every app
  `DIAGNOSTIC_COPY` category equals `diagnosticCategory(code)`. Keep app
  titles/messages/actions as the only rendered copy.

### Semantic-vs-renderer validation mismatch decision

The current app decoder (`src/struct/codec/invariants.ts`, via
`src/struct/emitted-ids.ts`) enforces XHTML emitted-identifier uniqueness at
document ingress. S-02 moved emitted-ID policy to the XHTML renderer, and the
package document decoder does not enforce it. Switching decode authority
therefore changes accepted/rejected inputs for that class.

Decision: accept the S-02 ownership change (document ingress owns semantics;
renderer owns renderer constraints).

- Write an explicit accepted/rejected input matrix before the switch.
- Required regression test: a document with an emitted-ID collision is accepted
  by the package document decoder and rejected by the package XHTML/EPUB
  renderer; the app render path still fails closed.
- Positive document parity alone is not rejection parity. Do not port the
  renderer constraint back into the app decoder.
- Keep local `src/struct/codec.test.ts` and `src/struct/codec-input-containment.test.ts`
  green against the unchanged local copy; map the decoder-authority assertions
  to the package at E-07.

### Static rules and high-fan-in enumeration

Add to `tests/struct-adapter-boundary.test.ts` (red first):

- Scope: every non-test module under `src/` (the guard's existing walk;
  `*.test.*`/`*.spec.*` excluded). Intra-`src/struct/` compatibility imports
  are permitted only where explicitly listed below; `src/struct/index.ts`
  re-exports are not a hidden intra-core path.
- Resolve imports semantically, not by raw specifier text. Production modules
  under `src/` must not resolve to local `src/struct` migrated-family
  definitions or their re-exports for families `types`, `ids`, `reading-order`,
  and `codec` in E-03 (and `xhtml`, `epub`, `emitted-ids` in E-04), including
  barrel/index forms (`src/struct/index`, `src/struct/index.ts`,
  `src/struct/codec/index.ts`), configured aliases (`@/struct`, `~/struct`,
  `#struct`, or equivalent), and transitive re-exports from
  `src/struct-adapters/*` and `src/struct/from-reconstruction.ts`. Public
  package specifiers `@erniesg/struct` and `@erniesg/struct/<subpath>` are
  allowed only when the subpath is in the installed export map: the public root
  and public subpaths are valid; local barrels are closed.
- Migrated-family set by step:
  - E-03: `types`, `ids`, `reading-order`, `codec`.
  - E-04: `xhtml`, `epub`, `emitted-ids`.
  A family is not considered migrated unless its prohibition is in the guard;
  no family may migrate without a corresponding guard entry. (F6)
- E-04 adds a separate guard entry in the same test file for
  `src/struct/xhtml`, `src/struct/epub`, and `src/struct/emitted-ids`,
  covering local barrels/index/aliases/re-exports and transitive re-exports,
  with the same scope and semantic resolution. (F6)
- Recovery allowlist: `src/struct-adapters/recovery` is app-owned presentation,
  not a migrated family, so it is not prohibited as a family; its permitted
  importers are enumerated in the recovery ownership decision. The only
  `src/struct/*` compatibility forwarder allowlist remains
  `src/struct/recovery.ts` importing `../struct-adapters/recovery` (plus
  barrel/index/alias spellings) for recovery presentation only. (F6/F7)
- Every `@erniesg/struct/...` specifier must be in the installed package export
  map (already enforced).
- No import of package-private paths.
- Retained local implementations are compatibility copies, not new authority;
  E-07 deletes them after parity. No new production semantics may be added to
  them. (F6)

High-fan-in consumers to enumerate and test: the table above plus the evidence
tools that load source modules directly —
`tools/srt-source-output-evidence.mjs` (`/src/struct/ids.ts`),
`tools/pdf-epub-package-scan.mjs`, `tools/pdf-corpus-audit-lib.mjs`,
`tools/pdf-association-fixture-audit.mjs`, `tools/model-consultation-evidence.ts`
(all load `/src/research/epub.ts`). These keep working because the local modules
remain until E-07; record the eventual E-07 migration of the `/src/struct/ids.ts`
load.

### E-03 compatibility decode naming

Current production does not call `migrateStructDocument`. Where compatibility
decode is needed, call the package `decodeCompatibleStructDocument` (the
deprecated package `migrateStructDocument` alias is removed after 2026-11-30).
Do not rename the local compatibility symbol in E-03; map it at E-07.

## E-04 — Cut XHTML/EPUB and converge publication semantics

Owner: `erniesg/erniesg`. Precondition: E-03 passes.

### Renderer switch mapping

| Local | Public package path | Production consumers to switch |
| --- | --- | --- |
| `src/struct/xhtml.ts` / `src/struct/emitted-ids.ts` | `@erniesg/struct/renderers/xhtml` (`renderPublicationXhtml`) | `src/research/epub.ts` |
| `src/struct/epub.ts` | `@erniesg/struct/renderers/epub` (`buildStructEpub`, `assertStructEpubArchiveByteLength`) | `src/research/epub.ts`, `src/research/reconstruction-materialization.ts` |

`src/research/epub.ts` keeps all app-owned behavior: `ResearchPaper`
rendering, export profiles, readable fallback, `assertPublicationIntegrity`,
resource limits, and the worker/export surface
(`src/research/publication.worker.ts`, `src/research/export-package.ts`,
`src/components/research/*`). Only the StructDocument render branches switch to
the package.

Local `src/struct/{xhtml,epub,emitted-ids}.ts` remain compatibility-only until
E-07; their tests stay green.

### Publication semantics decision

ADR-0001 requires `PublicationGraph` (`src/publication/*`) to be retired or
narrowed to an ephemeral, mechanically derived renderer plan from one pinned
approved Struct revision, owning no independent text, semantic IDs,
persistence, receipt, writer, or release path.

Default recommendation: **narrow**, with a proof obligation. Narrowing is valid
only if the graph is a one-way Struct-derived renderer plan with no
annotation, persistence, or canonical authority; otherwise retire the
competing graph. (F4)

#### Current inventoried state (grep-bounded, not compiler-proven)

The target-state bullets that follow this subsection are **not** the current
state. The current state is recorded in
[`docs/struct-research-paper-caller-inventory.md`](../../struct-research-paper-caller-inventory.md)
and
[`docs/struct-publication-graph-authority-inventory.md`](../../struct-publication-graph-authority-inventory.md);
it is summarised here so this plan does not overstate what those inventories
actually prove. All of it is **grep-bounded evidence, not compiler-proven
absence** (`ripgrep` only; `node_modules/` absent; the repository AST harness
`tests/struct-adapter-boundary.test.ts` could not be executed).

- **The graph build is production-alive.** `npm run build:production` runs
  `publication:build --adapter astro --entry moving-to-cloudflare-with-astro`
  and then `publication:check` on the graph pipeline.
  `tools/publication-build.mjs` imports `serializePublicationGraph` (`:29`) and
  writes `publication-graph.json`, `asset-bundle.json`,
  `publication-receipt.json`, and `astro-route-parity.json` (`:990-996`); the
  Vivliostyle renderer also persists the graph into the render output directory
  (`src/publication/renderers/vivliostyle.ts:1107-1111`), and
  `tools/publication-check.mjs` re-parses and re-hashes it (`:1144`, `:1162`).
  The graph is therefore live, wired production code, and "owns no
  persistence" is **not** the current state.
- **Writer/release modules import graph symbols today.** The claim "storage /
  API / route / writer / release modules import none today" is **not correct
  as written** (see the importer list below). The two CLI writer/release tools
  do import `publicationGraphSchema` / `serializePublicationGraph`. Only the
  storage, API, and route classes are graph-free today, and even that is
  grep-bounded.
- **The `struct` adapter is registered but not CLI-selectable.**
  `createDefaultPublicationAdapterRegistry()` registers `astro`,
  `payload-lexical`, and `struct` (`src/publication/adapter-registry.ts:55-60`),
  but the CLI `--adapter` allowlist accepts only `astro` / `payload-lexical`
  (`tools/publication-build.mjs:54-67`), so the Struct→graph projection has no
  CLI entry point today and the two non-Struct adapters are the only graph
  producers the release path can select. The ResearchPaper adapter
  (`researchPaperSourceAdapter`) is neither registered nor selectable.
- **The reverse direction and the graph-anchored annotation surface are
  test-only today.** `publicationGraphToResearchPaper`
  (`src/publication/research-paper-adapter.ts:198-296`) has exactly one
  caller, the round-trip assertion at
  `src/publication/research-paper-adapter.test.ts:17`; the bridge module
  `src/publication/research-paper-adapter.ts` has exactly two importers, both
  tests; and `createAnnotationBundle` (`src/annotations/annotation-bundle.ts:65`)
  has only test callers (`src/annotations/annotation-bundle.test.ts`,
  `src/annotations/move-parity.test.ts`). That lowers the migration cost of the
  narrow decision; it does not make the reverse writer conformant while it
  exists, and it does not decide the durable anchor model.
- **No route or worker endpoint consumes a graph.** `src/pages/**` and
  `src/worker/**` are graph-free today (grep-bounded).
- **Receipts carry no Struct binding yet.** Neither `PublicationReceipt`
  (`src/publication/renderers/vivliostyle.ts:109-117`) nor
  `PublicationContractReceipt` (`src/publication/source-adapter.ts:25-65`)
  contains a Struct package pin, artifact digest, `document` digest, or
  `receipt` digest. `graphSha256` is the **primary and only** source identity
  today and `canonicalSubsetSha256` is *required* by
  `publicationOutputReceiptContract` (`src/publication/adapter-conformance.ts:485-494`).
  "Graph digests are diagnostic only" is the **target**; demotion requires
  **adding** the Struct binding first, and the closed allowlist in
  `publicationOutputReceiptContract` (`:447-494`) rejects unknown receipt and
  source keys, so it must be widened deliberately.

Target state (what E-04 must produce; none of it is true today):

- Keep `src/publication/struct-adapter.ts` as a deterministic
  `StructDocument -> PublicationGraph` projection used only for print/Vivliostyle
  rendering (`src/publication/renderers/vivliostyle.ts`).
- Add a conformance test that adapting one pinned StructDocument twice yields a
  byte-identical graph and that the graph is never persisted or treated as
  canonical text authority. The conformance test must also cover the reverse
  direction: `publicationGraphToResearchPaper` must not introduce or alter
  `ResearchPaper` text or semantic ids (or must be removed). (F4)
- Permitted `PublicationGraph` importers (explicit **target** rule; all others,
  especially storage/API/route/writer/release modules, are prohibited): (F3)
  - definition module: `src/publication/schema.ts` (defines `PublicationGraph`,
    `publicationGraphSchema`, `serializePublicationGraph`,
    `PUBLICATION_GRAPH_VERSION`, `PublicationNode`, etc.);
  - projection modules: `src/publication/struct-adapter.ts`,
    `src/publication/source-adapter.ts`;
  - renderer: `src/publication/renderers/vivliostyle.ts`;
  - conformance helper: `src/publication/adapter-conformance.ts`;
  - bridge: `src/publication/research-paper-adapter.ts` (subject to the
    reverse-direction decision below);
  - read-only annotation consumer: `src/annotations/annotation-bundle.ts`
    (uses graph node ids/text for anchor resolution and emits `graphId`).
  This list is the **target** permitted set after the narrow decision, not the
  current importer set. The current importer set is wider and is recorded in
  `docs/struct-publication-graph-authority-inventory.md` §3: besides the
  modules above, `src/publication/adapters/astro.ts` and
  `src/publication/adapters/payload-lexical.ts` import graph symbols and are
  the two adapters the release path can actually select, and the
  writer/release tools `tools/publication-build.mjs` and
  `tools/publication-check.mjs` import `serializePublicationGraph` /
  `publicationGraphSchema` today. Storage, API, and route modules (for example
  `src/worker/margin/queries.ts` and the `src/pages/**` routes) import no graph
  symbols today; that half of the claim is grep-bounded, not compiler-proven.
  Narrowing must therefore retire or redirect the two non-Struct adapters and
  the CLI writer path, not only the schema. Any new importer requires an
  explicit plan update. (F3)
- Red/green baseline: the red-first assertion must fail before migration on any
  importer outside the permitted set, and pass after the migration/removal; name
  the concrete modules constituting storage/API/route/writer/release classes so
  the rule is mechanical. (F3)
- `src/publication/research-paper-adapter.ts` is bidirectional:
  `researchPaperToPublicationGraph` and `publicationGraphToResearchPaper` (the
  latter synthesises a `ResearchPaper` — nodes, text, ids — from the graph).
  Narrowing is invalid if the reverse direction remains, because the graph then
  authors `ResearchPaper` text and semantic ids. E-04 must either retire the
  reverse direction (or make it strictly one-way with proof that the graph
  cannot author text/ids) or, if reverse synthesis proves load-bearing, retire
  the competing graph instead of renaming or hiding it in an allowlist. No
  allowlist exception may author semantic text or ids. (F4)
  The reverse converter is **not** removed as an early or parallel cleanup: it
  is retired only inside this E-04 narrow-vs-retire decision, in the same
  reviewed change as the round-trip assertion that pins it
  (`src/publication/research-paper-adapter.test.ts:17`).
- `src/annotations/annotation-bundle.ts` anchor resolution depends on graph
  node ids/text and persists `graphId`. If that dependency remains, the graph
  is canonical authority for annotations and the narrow option is invalid;
  either migrate annotation anchor authority to Struct document nodes (retiring
  graph authority) or retire the competing graph. Do not add the annotation
  module to an allowlist to evade this. (F4)
  Today the anchor dependency is exercised only from tests
  (`src/annotations/annotation-bundle.test.ts`,
  `src/annotations/move-parity.test.ts`); that reduces the migration cost but
  does not decide the durable anchor model, which stays open. (F4)
- **No early deletion.** E-04 does not delete the duplicate local portable core
  modules (`src/struct/**`) and does not delete the graph reverse semantic
  writer outside the narrow-vs-retire decision above. Duplicate core deletion
  stays at E-07, behind E-06 plus the family parity/deletion gates
  (extraction-point hashes, package-test mapping, zero production imports to
  removed modules, package-only app tests, and a retained-compatibility
  register with owner, caller inventory, warning/horizon, and removal issue).
  (F6)
- Add a red-first static assertion/test that `PublicationGraph`,
  `publicationGraphSchema`, `serializePublicationGraph`, and any graph
  persistence/import/export helper are absent from storage, API, route, writer,
  and release modules; only the permitted importer set above may import them.
  (F3)
- Bind publication receipts to the Struct `document`/`receipt` digests and the
  exact package pin; do not treat an independent graph digest as the semantic
  authority. Receipts must include the canonical Struct digests and exact
  package pin/version; graph-only digests are diagnostic only. (F8)
  **Current state, not the target:** no receipt carries any Struct binding
  today, `graphSha256` is the primary and only source identity in both receipt
  shapes, and the closed `publicationOutputReceiptContract` allowlist
  (`src/publication/adapter-conformance.ts:447-494`) rejects unknown receipt
  and source keys. The Struct binding must be added and the allowlist widened
  deliberately, in that order, before any graph digest can be demoted to
  diagnostic. (F8)
  Receipts and source binding: (F8)
  - Types/modules: `PublicationReceipt` in
    `src/publication/renderers/vivliostyle.ts` (built ~1189-1201, persisted to
    `publication-receipt.json`) and `PublicationContractReceipt` in
    `src/publication/source-adapter.ts` (`publicationContractReceiptSchema`
    ~25, `createPublicationContractReceipt` ~148), plus their builders/schemas.
  - Keep `graphSha256`/`assetBundleSha256` as diagnostic back-compat fields;
    do not remove them.
  - Add a discriminated `sourceBinding` (or equivalently minimal field) to both
    receipts:
    - legacy variant `{ kind: 'legacy-research-paper' }` with no Struct
      binding, so legacy read-only render still works and no Struct binding is
      fabricated for `ResearchPaper` diagnostics;
    - struct variant `{ kind: 'struct-cutover', documentSha256,
      bundleSha256? (when wire bytes are available), semanticReceiptSha256?
      (canonical Struct receipt digest), packageSourceCommit, packageArtifact,
      packageArtifactSha256, packageIntegrity, packageVersion }`.
  - Struct cutover/release admission requires the struct variant; the legacy
    variant is render-only and is not admission evidence.
  - Canonical pin metadata authority is `vendor/struct/provenance.json`
    (`sourceCommit`, `artifact`, `sha256`, `integrity`, `packageVersion`),
    cross-checked against `package.json`, `package-lock.json`, and the tarball
    by `tests/struct-package-artifact.test.ts`. Do not create a second
    hand-maintained Struct pin in `src/publication/toolchain-manifest.json`;
    if a manifest entry is added later it must be generated/validated from
    provenance by the same test, not a second authority. (F8)
  - Exact package identity fields map to provenance: `sourceCommit` ->
    `sourceCommit`, artifact -> `artifact`, artifact sha256 -> `sha256`,
    integrity -> `integrity`, version -> `packageVersion`. (F8)
- If any of text, semantic IDs, persistence, receipt, writer, or release path
  proves load-bearing, retire the competing graph instead of renaming it.
- `ResearchPaper` is defined in `src/research/schema.ts` and is directly
  imported by many production modules; it is not behind any facade.
  `src/publication/research-paper-adapter.ts` is a bidirectional
  `ResearchPaper ⇄ PublicationGraph` adapter, not a read-only compatibility
  facade. The actual read-only renderer compatibility entry is
  `src/research/epub.ts`: its `renderPublicationXhtml(ResearchPaper, ...)`
  overloads and `buildEpub(ResearchPaper, ...)` overloads (plus export
  profiles and readable fallback) remain the legacy ResearchPaper renderer
  compatibility surface. Preserve those legacy callers separately; do not invent
  a nonexistent facade. (F5)
- E-04 exit evidence must include two checked-in inventories (created by
  separate inventory lanes; this plan requires their existence and scope, not
  their generation here): (F5)
  - [`docs/struct-research-paper-caller-inventory.md`](../../struct-research-paper-caller-inventory.md):
    (a) direct `ResearchPaper` type/value importers, (b) direct legacy renderer
    callers of the `renderPublicationXhtml`/`buildEpub` `ResearchPaper`
    overloads, (c) graph bridge callers of `research-paper-adapter.ts` exports,
    (d) tests.
  - [`docs/struct-publication-graph-authority-inventory.md`](../../struct-publication-graph-authority-inventory.md):
    the PublicationGraph importer inventory (definition, projection, renderer,
    conformance, bridge, annotation consumer) and the
    storage/API/route/writer/release absence proof. (F3/F4)
  **Status at this head:** both documents now exist and are linked
  reciprocally with this plan (they were merged from
  `58c9097c7191c182416ee8329fee518b0355a791`). They are **evidence
  inventories, not decisions and not gate satisfaction**, they are
  **grep-bounded, not compiler-proven**, and they contain no runtime, golden,
  receipt, or activation result. Two E-04 obligations they explicitly do
  **not** satisfy remain open: the *both-mode parity* half of the
  `research/epub.ts` deletion gate from ADR-0001 was not run, and the
  red-first static assertion against storage/API/route/writer/release modules
  does not exist in the repository. The second inventory's §9 gate table is
  the source of the pending-gate list below.

### E-04 future gates (every row PENDING)

Every row is **PENDING**: none of these gates is implemented, tested, or
satisfied at this head. The "observed today" column is grep-bounded evidence
from the two inventories, not a compiler-proven statement, and no row asserts
runtime, golden, or activation evidence.

| # | Gate | Concrete artifact | Observed today | Status |
| --- | --- | --- | --- | --- |
| EG-01 | Graph narrowed to an ephemeral renderer plan from one pinned approved Struct revision | `src/publication/adapter-registry.ts:55-60`, `tools/publication-build.mjs:54-67`, `src/publication/adapters/astro.ts`, `src/publication/adapters/payload-lexical.ts` | three adapters produce graphs; the CLI can select only `astro` / `payload-lexical` | PENDING |
| EG-02 | Graph owns no independent text | `src/publication/schema.ts:172-315`, `src/publication/research-paper-adapter.ts:198-296` | the graph has its own text fields and metadata envelope | PENDING |
| EG-03 | Graph owns no independent semantic IDs | `src/publication/schema.ts:7-11` | the graph has its own id grammar, disjoint from `src/research/schema.ts:3` | PENDING |
| EG-04 | Graph owns no persistence | `src/publication/renderers/vivliostyle.ts:1107-1111`; reader at `tools/publication-check.mjs:1145` | the graph is written to the render output directory | PENDING |
| EG-05 | Graph owns no receipt | `src/publication/renderers/vivliostyle.ts:109-117`; `src/publication/source-adapter.ts:25-65`; allowlist at `src/publication/adapter-conformance.ts:447-494` | both receipts bind the graph digest as the source identity | PENDING |
| EG-06 | Graph owns no writer and no release path | `tools/publication-build.mjs`; `package.json` `build:production` | the release build runs the graph pipeline | PENDING |
| EG-07 | No reverse graph→ResearchPaper writer | `src/publication/research-paper-adapter.ts:198-296`; `src/publication/research-paper-adapter.test.ts:17` | the reverse converter exists; its only caller is the round-trip test | PENDING |
| EG-08 | Red-first static assertion: graph symbols absent from storage/API/route/writer/release modules | extend the AST harness at `tests/struct-adapter-boundary.test.ts:12-55` to the `src/publication/**` and route/worker/writer roots | the harness covers only `src/struct/**` and `src/struct-adapters/**`; no such assertion exists for `src/publication/**` | PENDING |
| EG-09 | Byte-identical double-adapt conformance for one pinned `StructDocument`; the graph is never persisted or treated as canonical text | `src/publication/struct-adapter.ts:188`; `src/publication/struct-adapter.test.ts` | not found | PENDING |
| EG-10 | Receipts carry the canonical Struct digests and the exact package pin; graph digests demoted to diagnostic | `src/publication/renderers/vivliostyle.ts:109-117`; `src/publication/source-adapter.ts:25-65`; `src/publication/adapter-conformance.ts:447-494`; `tools/publication-check.mjs:1162` | no Struct binding exists, and the closed allowlist would reject one | PENDING |
| EG-11 | `ResearchPaper` stays a read-only compatibility model with a checked-in caller inventory | `docs/struct-research-paper-caller-inventory.md` | the inventory exists (grep-bounded); read-only enforcement and both-mode parity are not done | PENDING |
| EG-12 | EPUBCheck / Ace / human accessibility stay app-owned | `src/publication/renderers/vivliostyle.ts:724`; `src/research/publication-integrity.ts` | app-owned today | PENDING |
| EG-13 | Legacy `research/epub.ts` overloads keep both-mode parity until the last `ResearchPaper` consumer migrates | `src/research/epub.ts:133-141`, `:1422-1447`, `:2094-2118` | the call-site inventory exists; parity is **not** demonstrated | PENDING |
| EG-14 | E-07 deletion gates: zero production imports to removed portable modules, package-only app tests, retained-compatibility register | `src/struct/**`, `src/struct-adapters/**` | not done; duplicate core deletion stays at E-07 | PENDING |

EPUBCheck, Ace, and human accessibility approval remain app-owned release
evidence, not package unit tests.

### E-04 frozen output parity

- Dual-render first: for every frozen adapter case, compare local
  `renderPublicationXhtml`/`buildStructEpub` against the package renderers and
  assert byte/content-hash equality before switching imports.
- Do not regenerate app goldens to make the switch pass. Any intentional
  diff requires separate review and is not part of E-04's mechanical switch.
- Keep failure parity (invalid version, invalid receipt, missing/unrenderable
  target) in the matrix.

## E-05 / E-06 / E-07 gates this plan feeds

- E-05 implements durable editorial publication behind an inactive gate; the
  app owns the design record, schemas, authenticated transitions, and inactive
  writer/route adapter. It must not redesign the package.
- E-06 requires an accepted `erniesg.writer-route-activation.v1` receipt from
  the coordinator's E-ACT gate. E-06 cannot self-satisfy it.
- E-07 deletes the local portable modules and duplicate generic tests only after
  E-06 plus family parity/deletion gates, with extraction-point hashes, a
  package-test mapping, zero production imports to removed modules, and
  package-only app tests. Retained compatibility files need an owner, caller
  inventory, warning/horizon, and removal issue.

### Staged dual-read / switch / contract and rollback

Every stage is red-first and independently revertible:

1. Dual-read (E-02/E-03): reproduce local output with the package on frozen
   fixtures; no production import change yet.
2. Dual-render (E-04): reproduce local XHTML/EPUB with the package renderers.
3. Switch (E-03/E-04): change production imports only; local modules stay
   unchanged.
4. Contract (E-07): delete local duplicates after zero-import + parity proof.
5. Rollback: revert the pin commit and/or the import-switch commit to restore the
   previous exact head and local compatibility paths. No durable data or route
   mutation is involved before E-06. Unsafe package downgrade is rejected.

## Required evidence per stage

| Stage | Must show |
| --- | --- |
| E-02 | Atomic pin; adapter -> package decode -> bundle verify conservation on PDF/DOCX fixtures; bytes-only ingress; frozen parity unchanged except reviewed additions; no writer change |
| E-03 | Static import guard red-then-green; package/local dual-read equality; accepted/rejected matrix; recovery copy parity; high-fan-in consumers enumerated and tested |
| E-04 | Dual-render output/failure parity; PublicationGraph ownership proof or retirement (enumerated importer set, reverse-direction proof, annotation authority decision; static absence from storage/API/route/writer/release modules; receipts bound to Struct digests/package pin via `vendor/struct/provenance.json`); E-04 static import guard red-then-green for `xhtml`/`epub`/`emitted-ids`; EPUBCheck/Ace/human accessibility still app-owned; checked-in authority inventories at `docs/struct-research-paper-caller-inventory.md` and `docs/struct-publication-graph-authority-inventory.md` (present at this head; grep-bounded, not compiler-proven, and not gate satisfaction by themselves); every row of the E-04 future-gate table still PENDING until the corresponding evidence exists |
| E-05 | Design record; authenticated state machine; inactive route cannot expose unapproved/superseded artifact; concurrency + rollback/forward recovery rehearsal; writer still inactive |
| E-06 | Accepted E-ACT receipt matching exact head/pins/targets; single writer; post-activation health/observation/read-after-write |
| E-07 | Extraction-point hashes; package-test mapping; zero production imports to removed modules; package-only app tests; retained-compatibility register |

## Open decisions requiring human/coordinator input when reached

1. S-04 bundle shape the app will consume (embedded-only vs external resolver).
   Default: embedded-only for consumer/MVP scope only; this default does not
   waive the upstream S-03/S-04 resolver, value-verifier, or conformance
   harness, which remains authoritative.
2. Whether `./bundle` ships in the same S-04 artifact as the eventual consumer
   pin.
3. PublicationGraph narrow-vs-retire outcome, after the ownership proof runs.
4. E-ACT authorizing inputs (separate, immutable authorization) before E-06.
5. Bundle handle-creation surface: G-S04 must provide `createStructBundle` (and
   `verifyStructBundle`) in the installed runtime + declarations +
   `API_MANIFEST.json`, alongside `decodeStructBundle`/`encodeStructBundle`; the
   upstream manifest/module-surface discrepancy on current branches is a
   prerequisite the coordinator resolves with Struct before E-02. There is no
   app-side bundle pin today. (F1)

## Plan validation

- This plan changes documentation only; it runs no dependency install, build, or
  test. `git diff --check` and path/reference verification are its validation.
- Runtime parity/boundary tests require the pinned artifact install
  (`node_modules/@erniesg/struct`), which is intentionally not performed for a
  planning-only change.
- This head also integrates the two checked-in authority inventories (merged
  from `58c9097c7191c182416ee8329fee518b0355a791`). That integration is a
  documentation merge plus link and correction edits only: no source, test,
  golden, fixture, receipt, or runtime behaviour changed, and no build, test,
  render, hash, or activation was executed. Every "no importer was found"
  statement inherited from those inventories remains **grep-bounded, not
  compiler-proven**, and is recorded as such wherever this plan relies on it.
- Nothing in this plan or in the two inventories claims a runtime result, a
  golden comparison, a receipt, a cutover, a writer or route activation, or a
  satisfied gate. The E-04 future-gate table above is the explicit list of what
  is still pending.

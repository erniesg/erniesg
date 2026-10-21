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

### Review-finding anchors

Gate-level obligations - the E-04 future-gate table, the upstream-admission
table and the per-stage evidence table in this plan, and the inventory's §9
table - carry an `(Fn)` anchor that names the review finding the obligation
closes, so such an obligation can always be traced back to the finding it
answers. Obligations that answer no review finding - the E-05/E-06
activation-gate evidence rows and the G-PR450 / G-E-WF / G-EACT admission
rows, for example - carry no anchor. A prose obligation that states a review
finding directly carries the same marker. The anchor register below lists every
anchor used in this plan:

| Anchor | Review finding the anchored obligation closes |
| --- | --- |
| (F1) | The upstream bundle handle-creation surface: `createStructBundle` (and `verifyStructBundle`) must be real runtime exports of the installed artifact, its declarations, and `API_MANIFEST.json` `runtimeExports`, alongside `decodeStructBundle`/`encodeStructBundle`. The app must not build a handle itself or substitute a fixture-only path. |
| (F2) | The `./bundle` parity-closure update in the pin-bump atomicity rules: the `tests/struct-package-parity.test.ts` closed-path list must be updated deliberately in the same reviewed commit. |
| (F3) | The `PublicationGraph` permitted-importer set and the red-first static assertion that graph symbols **and** graph-bearing values/property access are absent from storage/API/route/writer/release modules. |
| (F4) | `PublicationGraph` authority: the narrow-vs-retire decision and the graph's ownership surface - no independent text, no independent semantic IDs, no persistence, no receipt, no writer or release path - the reverse graph->`ResearchPaper` writer, the forward `ResearchPaper` -> graph producer, and the graph-anchored annotation surface. |
| (F5) | The `ResearchPaper` compatibility surface and the two checked-in caller inventories. |
| (F6) | The static import guard: scope, the migrated-family set per step, semantic resolution of barrels, aliases, and re-exports, and the E-07 deletion-time zero-production-import assertion. |
| (F7) | The app-owned recovery presentation allowlist (presentation, not a migrated family). |
| (F8) | Receipt/source binding to the canonical Struct digests and the exact package pin, with `vendor/struct/provenance.json` as the only pin authority. |
| (F9) | Recovery subpath attribution (shapes vs facts) and the package-private `titleFromCode`, which must not be imported. |
| (F10) | The pin-bump atomic file set and the `pnpm import` sequencing after a lockfile change. |
| (F11) | The production publication path as a graph-owned EPUB/XHTML writer: `src/publication/renderers/vivliostyle.ts` builds `eink.epub` and its XHTML from the `PublicationGraph`, so the production path must use the package XHTML/EPUB renderer or be narrowed to print-only, with EG-12 (EPUBCheck / Ace / human accessibility stay app-owned) unchanged. |
| (F12) | The production renderer parity obligation covers the **shipped** artifacts, not only the `eink.epub` archive: the shipped WebPub content document `phone-webpub/index.html` and every resource it declares or references - the stylesheet binding, the asset bindings, the stylesheet's own font references, and the declared resource manifests (`phone-webpub/publication.json`, `EPUB/package.opf`). The frozen production case set covers the Astro case **and** the Payload case the production CLI can select. The Payload case is produced through the app-owned Payload-to-pinned-Struct ingress, and that ingress must be specified, tested against the pinned artifact, and landed **before** the Payload case is an E-04 exit gate; the Payload parity obligation itself is not narrowed, deferred, or dropped. |
| (F13) | The production Astro path reaches the pinned Struct revision **before** any direct graph producer is retired: a concrete, tested Astro-to-pinned-Struct conversion, the production CLI `--adapter astro` mapping, the registry/locator flow that carries it, and a red-first guard that the Astro path no longer constructs a `PublicationGraph`. The Astro provenance must survive the projection: the ingress must carry the outer Astro provenance through `adaptStructDocument` or explicitly restamp **both** the result provenance and every per-node provenance before validation, so the route-parity policy in `tools/publication-check.mjs:61-94` sees a consistent `(adapterId, sourceType)` pair and the planned production build passes admission. |
| (F14) | The production recovery wrapper obtains the diagnostic **category** from the package recovery runtime export (`diagnosticCategory` from `@erniesg/struct/recovery`) while keeping the app UX overlay (titles, messages, actions, the enriched summary, `userAction`). A parity-only duplicate category table is not acceptance: the app must not keep a second category authority. The same rule applies to the **actionable-recovery fact**: the app's `hasActionableRecovery` becomes a **delegation** to the package runtime export `hasActionableRecovery` from `@erniesg/struct/recovery` - the same treatment `diagnosticCategory` already gets - while the app keeps its facade and its presentation copy. The boolean authority is a source-neutral recovery fact, not presentation, so calling it presentation does not make it app-owned: a future package correction could diverge while the app silently retained the old result, and that is the failure this anchor exists to prevent. |
| (F15) | The Struct bundle must be **carried**, not reconstructed: the canonical `StructDocument` and the verified bundle handle (or the exact encoded bundle bytes) must travel from the ingress through the adapter result and its validation, through the registry, to the renderer, so that the `struct-bundle.bin` in the render output is exactly the receipt-bound bytes the release checker decodes. The closed `PublicationSourceResult` shape (`src/publication/source-adapter.ts:129-134`) and `validatePublicationSourceResult` (`src/publication/source-adapter.ts:177`) drop them today, so `EG-10` is not implementable as written until that contract is extended. |
| (F16) | The Payload path must carry or restamp the **per-node** provenance to the Payload identity before validation, exactly as the Astro path must, because the release admission check requires every node's `provenance.adapterId` (`tools/publication-check.mjs:274-280`), `provenance.sourceId` (`:281-288`) and `provenance.sourceRevision` (`:289-294`) to equal the receipt's source identity. Restamping only the result provenance is not sufficient. The **per-node** fields to restamp are exactly `adapterId`, `sourceId` and `sourceRevision`, because the strict node provenance schema (`src/publication/schema.ts:114-122`) accepts only `adapterId` (`:116`), `sourceId` (`:117`), `sourceRevision` (`:118`), `evidence` (`:119`) and `idOrigin` (`:120`) - there is **no** node-level `sourceType`, so `sourceType` stays on the **result** provenance only. |
| (F17) | The multi-locale linked-edition contract of the exported `adaptPayloadLexicalEditions` (`src/publication/adapters/payload-lexical.ts:1701-1726`) must have a stated disposition in the Payload ingress: either a per-locale Struct projection/linking design with a localized parity case, or the explicit retirement of that exported API with its callers named. The redirect must not silently drop the contract. |
| (F18) | The real scope and validation evidence of this branch: the three documentation files **plus** the `package.json` vite 8.1.6 override and the regenerated `package-lock.json`. A validation record that describes the branch as documentation-only, or that says the lockfile was unchanged, or that justifies skipping dependency-install validation, is false and must be corrected. |
| (F19) | The rendered assets must be bound to the **decoded Struct bundle**: admission must compare the decoded bundle's asset identities, digests and byte lengths with the publication asset descriptor the renderer consumed (`asset-bundle.json`) and with the assets actually shipped in the output, so that a valid Struct bundle cannot be paired with different image bytes. The bundle and document digests alone are not enough: the renderer consumes a separate `PublicationSourceResult.assetBundle`, so a projection bug can pair a valid Struct bundle with different image bytes, still produce internally correct bundle and asset-bundle receipt hashes, and still pass the planned checker while shipping assets that are not from the pinned Struct revision. |

An anchor is a traceability marker, not a substitute for the obligation: the
anchored text must keep stating the obligation in full, and adding or moving an
anchor must never weaken it.

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
| G-S04 | Exact integrated Struct head, release decision packet, tarball digest, export/API manifest including a complete `./bundle` whose installed runtime + declaration exports and `API_MANIFEST.json` `runtimeExports` agree and directly export `createStructBundle` (handle creation from a document plus supplied asset bytes), `verifyStructBundle`, `decodeStructBundle`, and `encodeStructBundle`; clean-consumer install; full bundle negative matrix; three-run XHTML/EPUB goldens. No app-side bundle pin exists today. (F1) | E-02 bundle + E-02 pin bump | OPEN |
| G-PR450 | Inline-hyperlink accounting landed with its own reviewed golden | E-02 structured-DOCX conservation parity | OPEN |
| G-E-WF | Generated publisher workflow registered with drift gate (#281) | E-02 and publication-state work | CLOSED |
| G-EACT | Immutable, authenticated, target-specific explicit-user authorization bound to writer/public-route activation | E-06 only | NOT ELIGIBLE YET |
| G-ARTIFACT | One reviewed commit updates tarball + provenance + `package.json` + `package-lock.json` together, with artifact/parity/boundary tests green (F10) | every pin bump | must hold |

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
part of the pin bump. (F10)

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
   trigger a revert by construction. (F2)
3. Use the shared pnpm store. Do not commit generated `pnpm-lock.yaml`
   (see `docs/struct-migration-status.md`). After any bump that changes
   `package.json`/`package-lock.json`, re-run `pnpm import` from the updated
   `package-lock.json` to regenerate `pnpm-lock.yaml` before the frozen install. (F10)
   For an Ernie.SG VM worktree use the documented physical-directory setup:
   `pnpm import` then
   `CI=true pnpm install --node-linker=hoisted --frozen-lockfile --ignore-scripts`,
   then `node tools/publication-install-browser.mjs`.
   **Then remove the generated lockfile before any dirty-check or evidence
   run.** The repository does not track `pnpm-lock.yaml` and `.gitignore` has
   no entry for it, while `publicationRepositoryForCurrentCheckout`
   (`tools/publication-build.mjs:874-899`) runs
   `git status --short --untracked-files=all` and marks any untracked file as
   dirty; `publicationCheck` then rejects the checkout through
   `assertPublicationReceiptRepositoryBinding`
   (`tools/publication-check.mjs:116-144`, called at `:1189-1193`). So, after
   the frozen install and
   before `publication:build`, `publication:check`, or any evidence run:
   `rm -f pnpm-lock.yaml` (and any other untracked file the setup generated,
   such as `pnpm-workspace.yaml` if present), then confirm
   `git status --short --untracked-files=all` is empty. A local
   `.git/info/exclude` entry is not repository policy and must not be relied
   on; a committed ignore would be a separate reviewed change and is not
   assumed here.
4. If the S-04 export map adds `./bundle`, in the same reviewed commit (a)
   update the exact expected export list in
   `tests/struct-package-artifact.test.ts`, and (b) remove `'bundle'` from the
   `it.each(['core', 'schema', 'ids', 'bundle'])` closed-path list in
   `tests/struct-package-parity.test.ts` and add a positive `./bundle`
   availability assertion there, while `'core'`/`'schema'`/`'ids'` stay closed.
   Do not silently widen the public surface for any other path, and do not add
   raw `sha256` helpers to the package API. (F2)
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
   evidence. (F1) There is no app-side bundle pin today.
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
| `src/struct/types.ts` | `@erniesg/struct/document` | `src/struct-adapters/from-reconstruction.ts`, `src/publication/struct-adapter.ts`, `src/research/reconstruction-materialization.ts`, `src/research/grounded-struct-materializer.ts`, `src/research/grounded-epub-comparison.ts`, `src/research/reconstruction-attempt-trace.ts`, `src/research/epub.ts` |
| `src/struct/codec*` / `src/struct/codec.ts` | `@erniesg/struct/document` (`decodeStructDocument`, `encodeStructDocument`, `decodeCompatibleStructDocument`, `StructCodecError`) | no current production caller outside `src/struct`; adopt the package decoder at any new production decode boundary |
| `src/struct/ids.ts` | `@erniesg/struct/identity` (`structDigest`, `structId`) | `src/struct-adapters/from-reconstruction.ts`, `src/research/grounded-struct-materializer.ts`, `src/research/grounded-struct-repair-applicator.ts` |
| `src/struct/reading-order.ts` | `@erniesg/struct/ordering` | `src/struct-adapters/from-reconstruction.ts` |

`src/research/epub.ts:7` (`import type { StructDocument } from
'../struct/types'`) is a **production** consumer of the `types` family, so it
is listed in the `types` row above. Its `StructDocument` type import switches
to `@erniesg/struct/document` in **E-03**, and the E-03 static guard covers
it like every other non-test `src/` module. That switch is **separate from**
the E-04 renderer-branch switch in the same file (`src/struct/xhtml` ->
`@erniesg/struct/renderers/xhtml`, `src/struct/epub` ->
`@erniesg/struct/renderers/epub`), which stays in E-04. There is **no**
deferred or named exception for this file in the E-03 guard: the E-03 guard
cannot go green while this importer is omitted.

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
  `diagnosticCategory`, `recoveryFact`, `toStructDiagnostic`, and its **own
  generic `recoverySummary`**, plus `hasActionableRecovery` — those five are
  the runtime values pinned in `API_MANIFEST.json` under the `./recovery`
  runtimeExports. The `RecoveryDiagnosticInput` type is a **type export** of
  `@erniesg/struct/recovery`, not a runtime export. (F9)
- App `src/struct-adapters/recovery.ts` owns presentation: `diagnosticCopy`
  titles/messages/actions, the **enriched** `recoverySummary` titles/summaries,
  and `userAction`. It is an app-owned presentation adapter, not a migrated family
  and not a portable duplicate. The actionable-recovery **predicate** is not
  presentation: it is a source-neutral recovery fact, and it is delegated to
  the package (see the delegation bullet below).
- **The two same-named `recoverySummary` functions are different functions, and
  so are the two `hasActionableRecovery` functions.** At this head
  `src/struct-adapters/recovery.ts` imports **types only** from
  `@erniesg/struct/document` (`:1-5`); it imports no `./recovery` runtime
  function from the package. The app implements `diagnosticCategory` (`:285`),
  `toStructDiagnostic` (`:289`), `recoverySummary` (`:320`), and
  `hasActionableRecovery` (`:424`) **locally**. The app `recoverySummary`
  emits enriched titles/summaries, a per-issue `action`, and `userAction`; the
  package `recoverySummary` emits generic titles/summaries and no
  `userAction`. The app `hasActionableRecovery` is a **local
  compatibility/presentation implementation, not a re-export** of the package
  fact of the same name. That is the current state of the code, and E-03
  changes it for the actionable-recovery predicate: the app function becomes
  a **delegation** to the package export (see the delegation bullet below),
  so the app no longer decides the boolean itself.
- E-03 changes **two** of those four: the app `diagnosticCategory`
  becomes a **delegation** to the package `diagnosticCategory` runtime
  export, so the category stops being an app-owned fact and the app copy
  table stops carrying a second category; and the app `hasActionableRecovery`
  becomes a **delegation** to the package `hasActionableRecovery` runtime
  export, for the same reason - the actionable-recovery predicate is a
  source-neutral recovery fact, and the pinned package already exports it
  (`vendor/struct/erniesg-struct-0.0.0-10116f4726da89ebabc823cb25706f2de5386f40.tgz::package/API_MANIFEST.json`
  `runtimeExports['./recovery']` lists `diagnosticCategory`,
  `hasActionableRecovery`, `recoveryFact`, `recoverySummary` and
  `toStructDiagnostic`). The app `toStructDiagnostic` and `recoverySummary`
  stay local and stay app-owned, because they carry the app's own
  source-specific copy. (F14)
- App-owned `src/struct-adapters/recovery` permitted importers (presentation or
  type-only; update this list deliberately if a new consumer is added):
  - `src/struct/recovery.ts` (compatibility forwarder) re-exports the app
    presentation symbols;
  - `src/struct/index.ts` via `./recovery` (barrel re-export);
  - `src/research/recovery-projection.ts` (type-only
    `RecoveryDiagnosticInput`);
  - `src/struct-adapters/from-reconstruction.ts` — the app-owned
    reconstruction adapter that E-02/E-03 retain. It imports
    `recoverySummary, toStructDiagnostic` from `./recovery` (`:18`) and uses
    `toStructDiagnostic` at `:1115` (reconstruction diagnostics) and
    `recoverySummary` at `:1140` (readiness/coverage summary). Those are its
    only two uses; they are presentation/recovery projection, not new
    authority;
  - `src/components/research/PublicationImporter.tsx`
    (`diagnosticCopy`, `hasActionableRecovery`, `recoverySummary`; the import
    block is at `:59-63` and the two production call sites are at `:1782` and
    `:1858`).
    At this head the app `hasActionableRecovery` is **locally implemented**
    (`src/struct-adapters/recovery.ts:424-428`), not re-exported from the
    package, and it is currently behaviorally aligned with the package fact of
    the same name (both test whether `userAction` is present). E-03 keeps the
    app facade and the app presentation copy, but the facade stops being the
    authority: the app `hasActionableRecovery` becomes a **delegation** to
    the package runtime export (see the delegation bullet below), so
    `PublicationImporter` no longer consumes an app-owned copy of a
    source-neutral fact. (F7/F14)
- Do NOT replace the app copy with the package `recoveryFact` title derivation.
  Upstream derives titles internally via `titleFromCode`, which is not a public
  export and must not be imported (package-private path); cite only the
  observable difference of the public `recoveryFact` result. Do not replace
  with the package default summary strings. That would change explanatory
  wording, serialized document bytes, and receipt hashes. (F9)
- E-03 work (production category authority): the **production** recovery
  wrapper must obtain the category from the package recovery runtime export,
  not from an app-owned copy. `src/struct-adapters/recovery.ts` must import
  `diagnosticCategory` from `@erniesg/struct/recovery` - a runtime export of
  the pinned artifact
  (`vendor/struct/erniesg-struct-0.0.0-10116f4726da89ebabc823cb25706f2de5386f40.tgz::package/API_MANIFEST.json`
  `runtimeExports['./recovery']`) - and use it as the single category
  authority. The app `DIAGNOSTIC_COPY` entries (`:26-267`) and the app
  `FALLBACK_COPY` (`:269-276`) stop carrying their own `category` field, so
  no second category table remains in the app, and
  `diagnosticCopy(code).category` returns the package category for every code,
  including an unknown code (the package default `source`). The app
  `diagnosticCategory` (`:285`) becomes a **delegation** to that package
  export - not a re-export of the package module, and not a local table.
  (F14)
- E-03 work (production actionable-recovery authority): the **production**
  recovery wrapper must obtain the actionable-recovery fact from the package
  recovery runtime export, not from an app-local copy.
  `src/struct-adapters/recovery.ts` must import `hasActionableRecovery` from
  `@erniesg/struct/recovery` - a runtime export of the pinned artifact
  (`vendor/struct/erniesg-struct-0.0.0-10116f4726da89ebabc823cb25706f2de5386f40.tgz::package/API_MANIFEST.json`
  `runtimeExports['./recovery']`; implemented at
  `package/dist/recovery.js:102-104` and exported at `:107`, declared at
  `package/dist/recovery.d.ts:41-43` and exported at `:45`) - and the app
  `hasActionableRecovery` (`:424-428`) becomes a **delegation** to that
  package export, exactly as the app `diagnosticCategory` (`:285`) becomes a
  delegation to the package `diagnosticCategory`. The app keeps its facade
  and the app's presentation copy; only the boolean **authority** moves. The
  boolean is a source-neutral recovery fact, not presentation: the package
  contract says the package owns source-neutral diagnostics/recovery
  (`vendor/struct/erniesg-struct-0.0.0-10116f4726da89ebabc823cb25706f2de5386f40.tgz::package/CONTRACT.md:11-12`)
  and that recovery utilities emit facts, categories and machine-readable
  status only while applications own source-specific and workflow-specific
  user copy (`:19-20`). The E-03 acceptance is "production call paths use
  only public package exports for the migrated families"
  (`docs/superpowers/plans/2026-08-27-cross-repository-architecture-issue-plan.md:340`),
  and the actionable-recovery predicate is one of those migrated facts.
  Calling the boolean "presentation" does not make the authority
  presentation-specific: without the delegation a future package correction
  could diverge while the app silently retained the old result. This is an
  **obligation**, not a claim of implementation: at this head the app module
  imports **types only** from the package (`:1-5`) and no `./recovery`
  runtime function, so the delegation is **not** in place. (F14)
- E-03 work (app UX overlay, preserved): the delegations change the
  **authorities**, not the copy. The app keeps its presentation:
  `diagnosticCopy` (`:278-283`) still returns the app title/message/action,
  `toStructDiagnostic` (`:289-308`) still returns the app
  title/message/action, the app `recoverySummary` (`:320-422`) still returns
  the enriched titles/summaries, the per-issue `action`, and `userAction`,
  and the app keeps its `hasActionableRecovery` **facade** (`:424-428`) with
  its signature and its presentation copy - but the facade now **delegates**
  to the package runtime export instead of deciding the boolean itself. Do
  **not** replace the app copy with the package `recoveryFact` title
  derivation (`titleFromCode` is not a public export and must not be
  imported) and do **not** replace it with the package default summary
  strings: doing so would change rendered copy and serialized
  document/receipt bytes, which the rules above forbid. (F9/F14)
- E-03 work (guard, red first): `tests/struct-adapter-boundary.test.ts` must
  gain an assertion that the production recovery module imports
  `diagnosticCategory` from `@erniesg/struct/recovery` and that the app copy
  table carries no local category field. Without that assertion the guard
  would stay green while two category authorities existed, which is the
  failure this gate exists to prevent. The same guard must gain an assertion
  that the production recovery module imports `hasActionableRecovery` from
  `@erniesg/struct/recovery` and that the app module no longer decides the
  boolean itself; without it the guard would stay green while an app-local
  actionable-recovery authority existed, which is the same failure mode for
  the same reason. The existing assertions in that file (the app module
  still contains `"} from '@erniesg/struct/document'"`, and
  `src/struct/recovery.ts` still re-exports the same five app symbols -
  the re-export literal at `:179-186` and the symbol-identity assertions at
  `:193-201`) stay green, because a delegation keeps the app facade and the
  app's exported symbol. (F14)
- E-03 work (parity test, necessary but not sufficient): a parity test
  asserting that every app code's category equals the package
  `diagnosticCategory(code)`, and that the app fallback category matches the
  package default category, remains required. It is **not** the acceptance
  criterion for this gate: a parity test alone leaves the app table as the
  runtime authority, so it can pass while the production wrapper still uses a
  local category. The runtime delegation in the first bullet is what
  discharges the gate. The same applies to the actionable-recovery predicate:
  a parity test asserting that the app facade agrees with the package
  `hasActionableRecovery` is required as well, and it is likewise **not** the
  acceptance criterion - the runtime delegation is what discharges the gate.
  (F9/F14)
- **Status at this head:** the E-03 candidate `ae4638ce`
  (`feat/struct-e03-core-codecs-ids-order-20261020`) implements the
  parity-test form only. It leaves `src/struct-adapters/recovery.ts`
  unchanged - still a types-only import from `@erniesg/struct/document` at
  `:1-5`, still a local `diagnosticCategory` at `:285`, still a local
  `hasActionableRecovery` at `:424-428` that imports no `./recovery` runtime
  function - and adds the guard case "E-03: app diagnostic categories match
  package recovery facts", which compares the app table against the package
  export. That candidate therefore does **not** discharge the
  production-delegation obligation above, for the category or for the
  actionable-recovery predicate. (F14)

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

- Scope: every non-test module under `src/` **except** the retained
  `src/struct/**` compatibility tree (`*.test.*`/`*.spec.*` excluded). The
  migrated-family prohibition applies to consumers **outside** `src/struct/**`.
  The retained tree keeps intra-family imports by construction
  (`src/struct/codec/parsers.ts:22` -> `../types`,
  `src/struct/codec/primitives.ts:1` -> `../ids`,
  `src/struct/codec/invariants.ts:6-8`, and the `src/struct/index.ts:15`
  barrel re-export), so applying the prohibition inside it would make the guard
  permanently red and contradict the strategy of leaving `src/struct/**`
  physically unchanged until E-07. The retained tree is boundary-checked
  separately by the existing walk in `tests/struct-adapter-boundary.test.ts`
  (`portableFiles`/`boundaryViolations`, `:12-124`), which must stay green;
  do not treat its internal family imports as consumer violations. (F6)
- Resolve imports semantically, not by raw specifier text. Production modules
  under `src/` **outside `src/struct/**`** must not resolve to local
  `src/struct` migrated-family definitions or their re-exports for families
  `types`, `ids`, `reading-order`,
  and `codec` in E-03 (and `xhtml`, `epub`, `emitted-ids` in E-04), including
  barrel/index forms (`src/struct/index`, `src/struct/index.ts`,
  `src/struct/codec/index.ts`), configured aliases (`@/struct`, `~/struct`,
  `#struct`, or equivalent), and transitive re-exports from
  `src/struct-adapters/*` and `src/struct/from-reconstruction.ts`. Public
  package specifiers `@erniesg/struct` and `@erniesg/struct/<subpath>` are
  allowed only when the subpath is in the installed export map: the public root
  and public subpaths are valid; local barrels are closed. (F6)
- Migrated-family set by step:
  - E-03: `types`, `ids`, `reading-order`, `codec`.
  - E-04: `xhtml`, `epub`, `emitted-ids`.
  A family is not considered migrated unless its prohibition is in the guard;
  no family may migrate without a corresponding guard entry. (F6)
- E-04 adds a separate guard entry in the same test file for
  `src/struct/xhtml`, `src/struct/epub`, and `src/struct/emitted-ids`,
  covering local barrels/index/aliases/re-exports and transitive re-exports,
  with the same scope (outside `src/struct/**`; the retained-tree walk is
  unchanged) and semantic resolution. (F6)
- Recovery allowlist: `src/struct-adapters/recovery` is app-owned presentation,
  not a migrated family, so it is not prohibited as a family; its permitted
  importers are enumerated in the recovery ownership decision. The only
  `src/struct/*` compatibility forwarder allowlist remains
  `src/struct/recovery.ts` importing `../struct-adapters/recovery` (plus
  barrel/index/alias spellings) for recovery presentation only. (F6/F7)
- Every `@erniesg/struct/...` specifier must be in the installed package export
  map (already enforced). (F6)
- No import of package-private paths. (F9)
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
| `src/publication/renderers/vivliostyle.ts` (`publicationGraphToHtml` at `:508`, `createPublicationEpub` at `:793-904`, `vivliostyleRenderer.render` at `:1083-1207`, which writes `eink.epub` and `publication-graph.json` and drives `createWebPub`) | `@erniesg/struct/renderers/xhtml` (`renderPublicationXhtml`) and `@erniesg/struct/renderers/epub` (`buildStructEpub`, `assertStructEpubArchiveByteLength`) | production publication pipeline: `tools/publication-build.mjs` (`vivliostyleRenderer.render` called at `:1077-1080`) and `npm run build:production` (`--adapter astro --entry moving-to-cloudflare-with-astro`) |

The production publication path above is **not** covered by switching only
`src/research/epub.ts` and `src/research/reconstruction-materialization.ts`:
`vivliostyleRenderer.render` calls `createPublicationEpub`, which builds
`eink.epub` and its XHTML directly from `PublicationGraph`
(`src/publication/renderers/vivliostyle.ts:793-904,1122-1124`). E-04 must
therefore require that this path either (a) uses the package XHTML/EPUB
renderer for its EPUB and XHTML output, or (b) is narrowed to print-only
(PDF) use with EPUB and WebPub generation removed from
`vivliostyleRenderer.render`/`createPublicationEpub`/`createWebPub`. EG-12
remains unchanged: EPUBCheck, Ace, and human accessibility acceptance stay
app-owned and are not moved into the package or dropped. The PDF-only
`publicationGraphToHtml` calls used for `a5-pdf`/`a4-pdf` rendering may remain
graph-derived only insofar as the graph itself is narrowed to an ephemeral
Struct-derived renderer plan (EG-01..EG-09). (F11)

`src/research/epub.ts` keeps all app-owned behavior: `ResearchPaper`
rendering, export profiles, readable fallback, `assertPublicationIntegrity`,
resource limits, and the worker/export surface
(`src/research/publication.worker.ts`, `src/research/export-package.ts`,
`src/components/research/*`). Only the StructDocument render branches switch to
the package.

Local `src/struct/{xhtml,epub,emitted-ids}.ts` remain compatibility-only until
E-07; their tests stay green.

### The Struct bundle must survive the adapter result (new, blocking) (F15)

`EG-10` requires a receipt-bound `struct-bundle.bin` **in the render output
directory** whose bytes the release checker decodes. That obligation is **not
implementable through the source-result contract as it stands**, and the gap is
in the contract, not in the renderer:

- `PublicationSourceResult` is a **closed four-field type**: `graph`,
  `assetBundle`, `diagnostics`, `provenance`
  (`src/publication/source-adapter.ts:129-134`).
- `validatePublicationSourceResult` (`src/publication/source-adapter.ts:177`)
  **reconstructs** that closed shape and returns only those four fields
  (`:207-215`), so anything an adapter put beside them is dropped before the
  result leaves the registry.
- `PublicationAdapterRegistry.resolve` returns exactly that validated value
  (`src/publication/adapter-registry.ts:30-38`), and `PublicationBundle` is an
  alias of it (`src/publication/adapter-registry.ts:10`).
- The renderer is the only component that writes into the output directory
  (`src/publication/renderers/vivliostyle.ts:1081-1207`; the artifacts it
  writes are at `:1107-1116`), and it reads only `bundle.graph` and
  `bundle.assetBundle.descriptor` - which is why the assets it ships are
  not bound to the bundle, as the next subsection requires.

So the exact encoded bundle produced from the Astro-derived `StructDocument`
is discarded before the only component that can write into the output
directory runs, and `EG-10` cannot produce the receipt-bound bytes the
checker decodes. E-04 work, therefore (app-owned; no new package API is
implied by this clause):

1. **The source result must carry the Struct revision.** `PublicationSourceResult`
   gains the fields that carry the canonical `StructDocument` and the verified
   bundle handle (or the exact encoded bundle bytes). The registry must pass
   them through unchanged, and `validatePublicationSourceResult` must
   **preserve** them instead of reconstructing a shape that drops them. The
   carry must cover the **Payload** path as well as the Astro path: both
   ingresses end in the same projection.
2. **The renderer must write the bytes it was given.** The `struct-bundle.bin`
   written into the render output directory must be the exact byte sequence
   the receipt's bundle digest was computed from - not a re-encoding of a
   descriptor and not a re-serialization of the document - so that the
   checker's decode is a decode of the same bytes the receipt names.
3. **The receipt must bind those bytes and the checker must verify them.** The
   receipt's bundle digest must be the digest of the written file, and
   `publication-check` must decode the written file and compare the decoded
   document's digest and semantic receipt digest with the receipt's, exactly as
   `EG-10` requires. A bundle that was not carried through the contract is a
   failed build, not a missing optional field.
4. **Guard (red first).** The E-04 static guard must assert that the source
   result, its validation and the registry all carry the Struct bundle fields,
   so the renderer can never again be asked to write bytes the contract
   dropped.

**Measured observation (a lane implementation, not a plan statement).** The
isolated E-04 receipt-admission lane already carries the Struct document
alongside the adapter result in its own implementation, and its release
checker already reads a `struct-bundle.bin`. At that lane's head
(`90e3edd7bbf4773efc8c1278ca08215f799f8563`): its `PublicationSourceResult`
adds `structDocument?: StructDocument` and
`sourceBinding?: PublicationSourceBinding`
(`worktrees/app-e04-receipt-admission:src/publication/source-adapter.ts:141-163`);
its `validatePublicationSourceResult` preserves both
(`worktrees/app-e04-receipt-admission:src/publication/source-adapter.ts:257-301`);
its facade hands `structDocument` and `sourceBinding` to the renderer
(`worktrees/app-e04-receipt-admission:src/publication/publishing-facade.ts:470-483`);
it produces the exact encoded bundle bytes through `structBundleWire`
(`worktrees/app-e04-receipt-admission:src/publication/struct-source-binding.ts:150-178`),
whose `bytes` field is the `struct-bundle.bin` payload;
and its checker reads `struct-bundle.bin` and decodes it through the pinned
package (`worktrees/app-e04-receipt-admission:tools/publication-check.mjs:977-978`,
`:1099-1104`). **That is a lane implementation in a separate worktree, not
this plan's content and not a satisfied gate**: none of it is merged here, the
`EG-10` row stays PENDING, and the obligation above is what this plan
requires.

### The rendered assets must be bound to the decoded Struct bundle (new, blocking) (F19)

`EG-10` requires the release checker to decode the receipt-bound
`struct-bundle.bin` and to compare the decoded document's digest and its
semantic receipt digest with the receipt's. That compares **digests of the
document**; it does not compare the **bytes of the assets the renderer
shipped**, and the renderer never reads the bundle at all: it reads
`bundle.graph` and `bundle.assetBundle.descriptor`
(`src/publication/renderers/vivliostyle.ts:553`, `:810`). The two byte
streams are independent today, and nothing binds them.

Current state at this head (grep-bounded, but line-exact):

- The asset bundle is a **separate** object from the graph and from the
  Struct bundle: `PublicationSourceResult` carries `assetBundle` as one of
  its four fields (`src/publication/source-adapter.ts:129-134`, the field at
  `:131`), and `validatePublicationSourceResult` (`:177`) re-parses the
  descriptor (`:181-183`), checks that every asset id a node references
  exists in it (`:189-206`), and rebuilds the bundle through
  `createAssetBundle` (`:209`).
- The descriptor's per-asset identity is `id`, `sha256`, `byteLength`,
  `mediaType` and `fileName` (`assetDescriptorSchema`,
  `src/publication/asset-bundle.ts:14-54`; the descriptor itself at
  `:56-61`), and the app's own asset resolver verifies the resolved bytes
  against that descriptor (`:124-134`).
- The renderer writes the asset bytes from that descriptor:
  `writeAssets` (`src/publication/renderers/vivliostyle.ts:546-567`) resolves
  and writes one file per descriptor entry (`:553-566`), the EPUB path writes
  the same entries again (`:805-826`), and the descriptor itself is persisted
  as `asset-bundle.json` (`:1112-1115`).
- The release checker reads that persisted descriptor
  (`tools/publication-check.mjs:1152-1154`), derives the shipped asset paths
  from it (`:1155-1160`), and compares **its** digest with the receipt's
  `assetBundleSha256` (`:1165-1169`). Every comparison it makes is a
  comparison *within* the app-side asset world; none of them involves the
  Struct bundle.
- The Struct-side asset entries are different objects: the pinned package's
  `StructDocument.assets` is a `StructAsset[]` whose entries carry `id`,
  `sha256` and the asset `bytes`
  (`vendor/struct/erniesg-struct-0.0.0-10116f4726da89ebabc823cb25706f2de5386f40.tgz::package/dist/types-J59yEqPh.d.ts:135-147`,
  the array at `:251`; the app's mirror of the same shape is
  `src/struct/types.ts:165-177`, `:310`), and the Struct bundle's own asset
  descriptor is built **from** those entries
  (`worktrees/app-e04-receipt-admission:src/publication/struct-source-binding.ts:91-113`:
  the `document.assets` map at `:95`, the asset `sha256` at `:107` and the
  `byteLength` at `:109`).

**Consequence, stated as a fact about the current code and not as an
implementation claim:** a projection bug that pairs a valid Struct bundle with
different image bytes produces two internally consistent receipts - the
bundle digest of the bundle and the `assetBundleSha256` of the descriptor -
and passes every digest comparison the planned checker performs, while
shipping assets that are not from the pinned Struct revision. Digest
equality is not asset equality.

E-04 work, therefore (app-owned; no new package API is implied by this
clause):

1. **Admission must compare the decoded bundle's assets with the publication
   asset descriptor.** The checker must decode the receipt-bound
   `struct-bundle.bin` (the decoder `EG-10` requires), take the decoded
   document's `assets` entries, and compare - per asset id - the
   **identity** (`id`), the **digest** (`sha256`) and the **byte length**
   against the publication asset descriptor the renderer consumed
   (`asset-bundle.json`). The two sets must match exactly: no descriptor
   entry may be missing from the bundle, and no bundle entry may be missing
   from the descriptor.
2. **Admission must compare them with the assets actually shipped.** The
   bytes of the shipped files under the output's `assets/` directory must
   hash and measure to the same values, so that the comparison covers what
   the reader receives and not only what two descriptors claim.
3. **No existing asset check is weakened.** The graph/asset/canonical-subset
   digest asserts, the `assetBundleSha256` assert
   (`tools/publication-check.mjs:1165-1169`), the node-to-asset reference
   check in `validatePublicationSourceResult`
   (`src/publication/source-adapter.ts:189-206`), the content-address
   verification in the app's asset resolver
   (`src/publication/asset-bundle.ts:124-134`) and the shipped-artifact
   parity checks of `EG-16` all stay as they are; this clause adds a
   comparison, it does not replace one.
4. **Guard (red first).** The E-04 static guard must assert that the release
   checker compares the decoded bundle's asset identities, digests and byte
   lengths with the publication asset descriptor and with the shipped asset
   files, and must be red before that comparison exists. Without that
   assertion the guard would stay green while a valid Struct bundle could
   still be paired with different image bytes, which is the failure this gate
   exists to prevent.

**Measured observation (a lane implementation, not a plan statement).** The
isolated E-04 receipt-admission lane decodes the receipt-bound bundle and
verifies the document and semantic-receipt digests, but it does **not**
compare the decoded bundle's assets with the publication asset descriptor or
with the shipped asset files: its
`assertPublicationStructAdmission`
(`worktrees/app-e04-receipt-admission:tools/publication-check.mjs:1093-1123`)
rehydrates the verified asset bytes into the decoded document
(`:1033-1044`, the asset rehydration at `:1035-1041`), asserts the document
digest (`:1112-1115`) and the semantic receipt digest (`:1116-1120`), and
stops there. The bytes to compare are therefore available at that lane's
head; the comparison is simply not made. **That is a lane implementation in
a separate worktree, not this plan's content and not a satisfied gate**: the
`EG-10` row stays PENDING, and the obligation above is what this plan
requires.

### Production source path: Astro to the pinned Struct revision

The production CLI resolves exactly one registered source adapter per build,
and the registry has no chaining facility, so the Astro-to-Struct path has to
be composed **inside** the registered `astro` adapter rather than by adding a
second CLI-visible adapter.

Current state at this head (grep-bounded, but line-exact):

- The release build selects the Astro adapter: `npm run build:production`
  (`package.json`) runs `publication:build --adapter astro --entry
  moving-to-cloudflare-with-astro`. `parsePublicationBuildArgs`
  (`tools/publication-build.mjs:31-69`) accepts only `astro` and
  `payload-lexical` (`--adapter payload` is mapped to `payload-lexical` at
  `:54`; any other id is rejected at `:66`), and the `astro` branch requires
  `--entry` (`:55-59`).
- `createDefaultPublicationAdapterRegistry()`
  (`src/publication/adapter-registry.ts:55-60`) registers
  `astroPublicationAdapter` (id `astro`), `payloadLexicalSourceAdapter`, and
  `structPublicationAdapter` (id `struct-document`,
  `src/publication/struct-adapter.ts:24`, `:1313-1318`).
- `PublicationAdapterRegistry.resolve(adapterId, locator)`
  (`src/publication/adapter-registry.ts:30-38`) looks up one adapter, calls
  its `adapt(locator)`, and validates the result with
  `validatePublicationSourceResult` (`src/publication/source-adapter.ts:177`).
  There is no adapter-to-adapter delegation, and `register` rejects a
  duplicate id (`:23-28`), so one CLI id can only ever reach one adapter.
- The CLI builds the Astro locator as `{ entryId: options.entry }`
  (`tools/publication-build.mjs:1054-1066`) and resolves it at `:1067`. The
  Astro adapter's locator type is `AstroSourceLocator = { entryId: string;
  contentRoot?: string }` (`src/publication/adapters/astro.ts:25-28`).
- The Astro adapter is a **direct graph producer** today: it parses the graph
  itself with `publicationGraphSchema.parse({...})`
  (`src/publication/adapters/astro.ts:567`). The Payload adapter does the
  same (`src/publication/adapters/payload-lexical.ts:1646`, and re-parses at
  `:1726`), and the `ResearchPaper` bridge does it twice
  (`src/publication/research-paper-adapter.ts:172`, `:201`).
- The Struct projection already exists and is exported:
  `adaptStructDocument(document)` (`src/publication/struct-adapter.ts:188`),
  also re-exported as `structDocumentToPublicationSourceResult` (`:1320`).
- The pinned package's public document surface is `decodeStructDocument`,
  `encodeStructDocument`, `decodeCompatibleStructDocument`
  (`vendor/struct/erniesg-struct-0.0.0-10116f4726da89ebabc823cb25706f2de5386f40.tgz::package/API_MANIFEST.json`
  `runtimeExports['./document']`), and the pin authority is
  `vendor/struct/provenance.json`.

E-04 work, in this order (F13):

1. **Astro-to-pinned-Struct ingress (new, app-owned).** E-04 adds one
   app-owned conversion from an Astro MDX entry to a `StructDocument`. It does
   not exist at this head. It must reuse the single MDX walk the app already
   has - `gray-matter`, `remark-parse`, `remark-mdx`, `remark-gfm`,
   `remark-math`, and `unified` are already imported at
   `src/publication/adapters/astro.ts:1-11` - and must not introduce a second
   MDX parser or a second front-matter reader. It must report every construct
   it cannot express as an adapter diagnostic instead of dropping it
   silently; the current behaviour is to fail closed with
   `Unsupported MDX node ...` (`src/publication/adapters/astro.ts:84-92`), and
   that fail-closed behaviour must survive the switch.
2. **Pinned-Struct proof, not assertion.** The ingress output must be
   accepted by the **pinned** artifact: the produced document must round-trip
   through the pinned `decodeStructDocument`, and the document digest must be
   bound to `vendor/struct/provenance.json`. The ingress test must assert
   both against the pinned install, so that "pinned" is proven rather than
   asserted.
3. **Re-point the registered `astro` adapter.**
   `src/publication/adapters/astro.ts` must stop constructing a graph (`:567`)
   and must compose ingress -> `adaptStructDocument`
   (`src/publication/struct-adapter.ts:188`) ->
   `validatePublicationSourceResult` (`src/publication/source-adapter.ts:177`).
   The adapter keeps `id: 'astro'` and
   `version: PUBLICATION_SOURCE_ADAPTER_VERSION`
   (`src/publication/adapters/astro.ts:606-611`), so the CLI mapping, the
   registry entry, and the locator flow are unchanged by construction.
   The composition must **carry the canonical `StructDocument` and the verified
   bundle handle (or the exact encoded bundle bytes) through every one of
   those steps** - the adapter result, its validation, the registry and the
   renderer - exactly as the bundle-carry subsection above requires (F15).
   Composing ingress -> projection -> validation and then dropping the
   document before the renderer satisfies neither `EG-10` nor this step.
4. **Provenance must survive the projection (new, blocking).** The release
   admission check reads the source identity out of the **receipt**, and the
   receipt copies that identity verbatim from the bundle's provenance
   (`tools/publication-build.mjs:452`, `:454`), while the receipt's
   route-parity policy is bound from the **requested** adapter id, not from
   the bundle (`:1081-1086`: the `astro` branch binds
   `'astro-canonical-route'`). The projection stamps its own identity:
   `adaptStructDocument` sets the result provenance's `adapterId` to
   `STRUCT_PUBLICATION_ADAPTER_ID` (`'struct-document'`,
   `src/publication/struct-adapter.ts:24`, `:1290`) and every node's
   provenance to the same id (`:660`), and it derives `sourceType` from
   `sourceType(document)` (`:175-181`), which returns `'pdf'` for a `'pdf'`
   source, `'docx'` for a `'docx'` source, and `'research-paper'` for every
   other format - including the `'html'` format an Astro MDX entry produces
   (`StructSourceFormat`, `src/struct/types.ts:17`). The composed result
   would therefore carry `('struct-document', 'research-paper')` while the CLI
   binds `'astro-canonical-route'`, and
   `publicationReceiptRequiresCanonicalRouteParity`
   (`tools/publication-check.mjs:61-94`) rejects that receipt: it derives
   `isAstro` from `adapterId === 'astro'` (`:72`), requires `isAstro` to agree
   with `sourceType === 'astro'` (`:73-74`), and accepts only the
   `'not-applicable'` policy for a non-Astro receipt (`:92-94`), so it throws
   `Non-Astro publication receipt has no recognized route-parity policy`.
   `npm run build:production` runs `publication:check` on that receipt
   (`package.json` `build:production`), so the planned production build would
   fail admission.
   The ingress must therefore resolve the provenance **before** validation, in
   one of exactly two ways:
   - **carry the outer Astro provenance through the projection**, so the
     composed result reports `adapterId: 'astro'` and `sourceType: 'astro'`;
     or
   - **restamp both**, i.e. explicitly set the result provenance's
     `adapterId`/`sourceType` **and** every per-node provenance's `adapterId`
     to the Astro identity, before `validatePublicationSourceResult`
     (`src/publication/source-adapter.ts:177`) runs.
   Restamping only the result provenance is not sufficient: the per-node
   provenance would still name `struct-document`, so one build would carry two
   different adapter identities. Whichever way is chosen, the route-parity
   policy in `tools/publication-check.mjs:61-94` must see a **consistent
   `(adapterId, sourceType)` pair**, and the E-04 evidence must carry a named
   assertion that the released receipt's source identity is Astro and that the
   receipt passes `publicationReceiptRequiresCanonicalRouteParity`. This
   obligation requires no new package API, no new registry facility, and no
   new exported function: the decision is app-owned and lives inside
   `src/publication/adapters/astro.ts`.
5. **The production CLI mapping is part of the change.** `--adapter astro`
   must keep resolving to the registered `astro` adapter, and that adapter
   must be the pinned-Struct path, so `npm run build:production` runs the
   pinned Struct revision with no CLI change. No second, direct graph path
   may remain reachable from the CLI, and the `--adapter` allowlist
   (`tools/publication-build.mjs:54-67`) must keep rejecting ids it cannot
   serve.
6. **Guard (red first).** The E-04 static guard must assert that
   `src/publication/adapters/astro.ts` no longer constructs a
   `PublicationGraph` (no `publicationGraphSchema.parse`, no
   `serializePublicationGraph`, no graph construction) and must positively
   assert that it imports `adaptStructDocument` from `../struct-adapter`. The
   guard must be red before step 3 and green after it.
7. **Ordering.** Steps 1-6 land **before** the direct graph producer is
   retired (EG-01, EG-15, and the `payload-lexical` redirect). Retiring the
   direct producer first would leave the production CLI with no graph source
   at all.

The existing frozen Astro case already exercises this path end to end: the
conformance harness builds the Astro entry from
`tests/fixtures/publication/astro/payload-equivalent.mdx` with
`public/favicon-16x16.png` copied in as `fixture-image.png`, and calls
`adaptAstroBlogEntry` (`tools/publication-adapter-conformance.mjs:59-79`). The
ingress test must reuse that fixture and compare the projected semantics
against the Payload case with `comparePublicationSemanticSubset`
(`src/publication/adapter-conformance.ts:376`), so the ingress cannot change
the rendered content unnoticed.

### Production source path: Payload to the pinned Struct revision

The Payload case is a **selectable production case**: the CLI `--adapter`
allowlist accepts `astro` and `payload-lexical` (`--adapter payload` is
mapped to `payload-lexical` at `tools/publication-build.mjs:54`; any other id
is rejected at `:66`), and the `payload-lexical` branch accepts `--input
<json>` (`:60-64`). EG-01 must therefore redirect the Payload graph production
onto the Struct projection **without** removing the adapter, because the
frozen Payload CLI case (EG-16) needs a production producer.

That redirect is **not implementable as written at this head**, because the
`payload-lexical` adapter is a **direct graph producer**: it builds the
`PublicationGraph` itself with `publicationGraphSchema.parse({...})`
(`src/publication/adapters/payload-lexical.ts:1646`, inside `buildResult`,
which starts at `:1579`) and re-parses the graph for the edition variants
(`:1726`, inside `adaptPayloadLexicalEditions`, which starts at `:1701`). It
imports no `StructDocument` and never calls `adaptStructDocument`
(`src/publication/struct-adapter.ts:188`): the only callers of
`adaptStructDocument` at this head are the `struct` registry entry
(`:1313-1318`) and `src/publication/struct-adapter.test.ts`. Redirecting
`payload-lexical` to `adaptStructDocument` therefore has **no `StructDocument`
to supply**; a Payload-to-Struct conversion must be written first, exactly as
the Astro ingress above must be written first. This is a gap in the plan, not
a statement that the Payload adapter is wrong today: at this head the Payload
adapter stamps its own source identity (`adapterId: 'payload-lexical'`,
`sourceType: 'payload'`, `src/publication/adapters/payload-lexical.ts:1662-1664`).

E-04 work, in this order (F12):

1. **Payload-to-pinned-Struct ingress (new, app-owned).** E-04 adds one
   app-owned conversion from a Payload Lexical export document to a
   `StructDocument`. It does not exist at this head. It must reuse the
   app-owned Payload mapping policy (`parseMapping`, exposed as
   `parsePayloadMappingPolicy`, `src/publication/adapters/payload-lexical.ts:139`,
   `:1745`) and the checked-in mapping fixture
   (`tests/fixtures/payload/mapping.json`), so that the conversion reads the
   same mapped values the current adapter reads; it must not introduce a
   second Payload mapping policy. It must report every construct it cannot
   express as an adapter diagnostic instead of dropping it silently.
2. **Pinned-Struct proof, not assertion.** As with the Astro ingress, the
   produced document must round-trip through the pinned `decodeStructDocument`,
   and the document digest must be bound to `vendor/struct/provenance.json`.
   The ingress test must assert both against the pinned install, so that
   "pinned" is proven rather than asserted.
3. **Re-point the registered `payload-lexical` adapter.**
   `src/publication/adapters/payload-lexical.ts` must stop constructing a
   graph (`:1646`, `:1726`) and must compose ingress -> `adaptStructDocument`
   (`src/publication/struct-adapter.ts:188`) ->
   `validatePublicationSourceResult` (`src/publication/source-adapter.ts:177`).
   The adapter keeps `id: PAYLOAD_LEXICAL_ADAPTER_ID` (`'payload-lexical'`,
   `src/publication/adapters/payload-lexical.ts:9`, `:1732-1736`) and
   `version: PUBLICATION_SOURCE_ADAPTER_VERSION`, so the CLI mapping, the
   registry entry, and the locator flow are unchanged by construction.
   The composition must carry the canonical `StructDocument` and the verified
   bundle handle (or the exact encoded bundle bytes) through the adapter
   result, its validation, the registry and the renderer, exactly as the
   bundle-carry subsection above requires (F15).
4. **Provenance on the result.** The composed Payload result must keep the
   Payload source identity (`adapterId: 'payload-lexical'`,
   `sourceType: 'payload'`) on its provenance, for the same reason as the
   Astro step above: the receipt copies the bundle's provenance verbatim
   (`tools/publication-build.mjs:452`, `:454`). The Payload branch of the CLI
   binds the `'not-applicable'` route-parity policy (`:1084-1086`), which
   `publicationReceiptRequiresCanonicalRouteParity` accepts for a non-Astro
   receipt (`tools/publication-check.mjs:92-94`), so the Payload case does not
   fail admission on provenance - but the receipt must still name the
   production case it came from.
5. **Per-node provenance (new, blocking).** Keeping the Payload identity on
   the *result* provenance is **not sufficient**, and the Payload path must
   satisfy the same obligation as the Astro path. Two facts decide this:
   - The Struct projection stamps its own identity on **every node**:
     `adaptStructDocument` sets each node's `provenance.adapterId` to
     `STRUCT_PUBLICATION_ADAPTER_ID` (`'struct-document'`,
     `src/publication/struct-adapter.ts:24`) at
     `src/publication/struct-adapter.ts:660`, and each node's
     `provenance.sourceId` is the Struct document's own source id
     (`sourceIdFor`, `src/publication/struct-adapter.ts:133-143`, used at
     `src/publication/struct-adapter.ts:192`).
   - The release admission check requires **per-node** agreement, not just a
     matching result provenance: `assertPublicationReceiptSourceBinding`
     (`tools/publication-check.mjs:265`) asserts that every node's
     `provenance.adapterId` equals the receipt's source adapter
     (`:274-280`, clause at `:277`), that every node's `provenance.sourceId`
     equals the receipt's source id (`:281-288`, clause at `:285`), and that
     every node's `provenance.sourceRevision` equals the receipt's source
     revision (`:289-294`, clause at `:291`); it is called from
     `publicationCheck` at `tools/publication-check.mjs:1178`.
   - The **node** provenance schema is strict and narrow:
     `provenanceSchema` (`src/publication/schema.ts:114-122`) accepts exactly
     `adapterId` (`:116`), `sourceId` (`:117`), `sourceRevision` (`:118`),
     `evidence` (`:119`) and `idOrigin` (`:120`), and closes with `.strict()`
     (`:122`). There is **no** `sourceType` on a node. The result provenance
     is the only carrier of the source type, and it is the place the
     receipt's source type is compared
     (`tools/publication-check.mjs:267-273`).

   A production `--adapter payload` build whose nodes still say
   `'struct-document'` is therefore **rejected at admission** even though its
   route-parity policy is valid. The Payload ingress must consequently
   **carry the outer Payload provenance through the projection, or restamp
   both the result provenance and every per-node provenance** to the Payload
   identity (`'payload-lexical'` / `'payload'`), before
   `validatePublicationSourceResult` (`src/publication/source-adapter.ts:177`)
   runs. The fields to restamp are exactly the ones the node schema accepts
   **and** the ones the admission check compares: the per-node `adapterId`,
   `sourceId` and `sourceRevision`; `sourceType` stays on the **result**
   provenance only. Restamping only the result provenance leaves one build
   carrying two adapter identities and still fails the node check, and
   writing `sourceType` onto a node is a build failure in its own right:
   `validatePublicationSourceResult` reparses every node through the strict
   `provenanceSchema`, so an extra `sourceType` key on a node is rejected
   before the build can reach admission. The E-04 evidence must carry a
   named assertion that a `payload-lexical` receipt passes
   `assertPublicationReceiptSourceBinding`. (F16)
6. **Multi-locale editions: a stated disposition (new, blocking).** The
   exported `adaptPayloadLexicalEditions`
   (`src/publication/adapters/payload-lexical.ts:1701-1726`) builds **every
   declared locale** as a separate linked edition and links the locale
   variants by assigning `edition.equivalentNodeId` for matching
   source-stable nodes (`:1722`; the graph's node-edition schema still
   provides the field, `src/publication/schema.ts:166`, and the conformance
   comparator still reads it, `src/publication/adapter-conformance.ts:276-277`).
   Its existing assertions are in
   `src/publication/adapters/payload-lexical.test.ts:2829-2830`.
   `adaptStructDocument` never emits `equivalentNodeId`: it is single-locale
   by construction (`localeFor`, `src/publication/struct-adapter.ts:55`, used
   at `:229`) and stamps `edition: { editionId }` only
   (`src/publication/struct-adapter.ts:668`). The redirect therefore leaves
   the multi-locale contract with **no specified replacement**, and the plan
   must state one explicitly:
   - **either** the ingress specifies a **per-locale Struct projection and
     linking design**: one `StructDocument` per declared locale, each
     projected through `adaptStructDocument`, with the locale variants linked
     across the per-locale projections by source-stable node id into
     `edition.equivalentNodeId`, and a **localized parity case** in the
     frozen production case set that proves the linkage; **or**
   - **or** the plan **explicitly retires** the exported
     `adaptPayloadLexicalEditions` API, names its callers, and states that
     the multi-locale linked-edition capability leaves the app surface at that
     point. The only callers of the exported API at this head are in
     `src/publication/adapters/payload-lexical.test.ts` - the import at `:5`
     and the calls at `:2241`, `:2790`, `:2829`, `:2832`, `:2844`, `:2879`,
     `:2885` and `:2968` - and the production Payload path does not use it
     (`payloadLexicalSourceAdapter.adapt` calls the single-locale
     `adaptPayloadLexical`, `src/publication/adapters/payload-lexical.ts:1732-1736`,
     which adapts one locale at `:1673-1698`).

   Whichever disposition is chosen, it must be recorded in this plan **and** in
   the `EG-18`/`G-18` gate row, and the redirect must not silently drop the
   multi-locale contract. (F17)
7. **Ordering against the Payload parity obligation.** The Payload
   case-parity obligation (EG-16, mirrored as G-16) is **unchanged and not
   narrowed**: the frozen production case set still contains the Payload case
   the production CLI can select, and it must still pass the shipped-artifact
   comparison. What this section adds is the missing **prerequisite**: the
   specified and tested Payload-to-pinned-Struct ingress must land **before**
   the Payload case is an E-04 exit gate, and before the `payload-lexical`
   redirect (EG-01) is performed. Without it the redirect is unimplementable
   and the Payload case has no Struct-derived producer to compare.
8. **Guard (red first).** The E-04 static guard must assert that
   `src/publication/adapters/payload-lexical.ts` no longer constructs a
   `PublicationGraph` (no `publicationGraphSchema.parse`, no
   `serializePublicationGraph`, no graph construction) and must positively
   assert that it imports `adaptStructDocument` from `../struct-adapter`. The
   guard must be red before step 3 and green after it.

The frozen Payload case already exists: `tests/fixtures/payload/equivalent-publication.json`
with `tests/fixtures/payload/mapping.json` - the pair the conformance harness
already renders side by side against the Astro case
(`tools/publication-adapter-conformance.mjs:80-90`). The ingress test must
reuse that pair and compare the projected semantics with
`comparePublicationSemanticSubset`
(`src/publication/adapter-conformance.ts:376`), so the ingress cannot change
the rendered content unnoticed.

The same current-state facts are recorded as observed evidence in
[`docs/struct-publication-graph-authority-inventory.md`](../../struct-publication-graph-authority-inventory.md)
§8e - the per-node provenance stamp of the Struct projection, the strict node
provenance schema, the release admission check's per-node source-binding
requirement for `adapterId`, `sourceId` **and** `sourceRevision`, the
multi-locale linked-edition contract of the exported
`adaptPayloadLexicalEditions`, the closed source-result shape that cannot
carry the Struct bundle, and the missing binding between the decoded Struct
bundle's assets and the shipped assets - and the corresponding pending
obligations are G-01, G-10, G-16, G-17 and G-18 in that document's §9 gate
table.

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
  `tools/publication-build.mjs` imports `serializePublicationGraph` (`:29`),
  orchestrates the renderer (`vivliostyleRenderer.render` at `:1077-1080`),
  **directly writes only `astro-route-parity.json`** (`:990-1019`), and
  re-stamps the renderer-produced receipt in place (`:1022-1043`). The
  `publication-graph.json`, `asset-bundle.json`, and `publication-receipt.json`
  files are written by the Vivliostyle renderer itself
  (`src/publication/renderers/vivliostyle.ts:1107-1116`, `:1201-1205`), and
  `tools/publication-check.mjs` re-parses and re-hashes the graph
  (`:1144`, `:1162`). The graph is therefore live, wired production code, and
  "owns no persistence" is **not** the current state.
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
  (`tools/publication-build.mjs:54-67`; any other adapter is rejected at
  `tools/publication-build.mjs:65-67`), so the Struct→graph projection has no
  CLI entry point today and the two non-Struct adapters are the only graph
  producers the release path can select. The ResearchPaper adapter
  (`researchPaperSourceAdapter`) is neither registered nor selectable, but it
  is still an exported and callable producer
  (`src/publication/research-paper-adapter.ts:317`), so the release path is
  not the only way a non-Struct graph can be minted.
- **The reverse direction and the graph-anchored annotation surface are
  test-only today.** `publicationGraphToResearchPaper`
  (`src/publication/research-paper-adapter.ts:198-296`) has exactly one
  caller, the round-trip assertion at
  `src/publication/research-paper-adapter.test.ts:17`; the bridge module
  `src/publication/research-paper-adapter.ts` has **four test importers and no
  production importer** (`src/publication/research-paper-adapter.test.ts:8`,
  `src/publication/source-adapter.test.ts:8`,
  `src/annotations/move-parity.test.ts:2`,
  `src/annotations/annotation-bundle.test.ts:11`); and `createAnnotationBundle`
  (`src/annotations/annotation-bundle.ts:65`)
  has only test callers (`src/annotations/annotation-bundle.test.ts`,
  `src/annotations/move-parity.test.ts`). The forward direction
  (`researchPaperToPublicationGraph`) is test-only for the same reason: it is
  exported and callable, but it has no production caller today. That lowers the
  migration cost of the narrow decision; it does not make the reverse writer
  conformant while it exists, it does not make the forward producer
  Struct-derived, and it does not decide the durable anchor model.
- **No route or worker endpoint consumes a graph.** `src/pages/**` and
  `src/worker/**` are graph-free today (grep-bounded).
- **Receipts carry no Struct binding yet.** Neither `PublicationReceipt`
  (`src/publication/renderers/vivliostyle.ts:109-117`) nor
  `PublicationContractReceipt` (`src/publication/source-adapter.ts:25-65`)
  contains a Struct package pin, artifact digest, `document` digest, or
  `receipt` digest. `graphSha256` is the **primary and only** source identity
  today and `canonicalSubsetSha256` is *required* by
  `publicationOutputReceiptContract` (`src/publication/adapter-conformance.ts:485-494`),
  which is used only by the adapter-conformance comparison
  (`tools/publication-adapter-conformance.mjs:131`), not by the release check.
  "Graph digests are diagnostic only" is the **target**; demotion requires
  **adding** the Struct binding first and then wiring it into the release
  admission path (`tools/publication-check.mjs`), because that path validates
  selected fields and never calls the conformance allowlist. The allowlist in
  `publicationOutputReceiptContract` (`:447-494`) rejects unknown receipt and
  source keys in the conformance tool, so it must also be widened deliberately.

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
  - conformance helper: `src/publication/adapter-conformance.ts`.

  `src/publication/research-paper-adapter.ts` is **not** a permitted target
  importer either. The reverse-direction decision below already covers
  `publicationGraphToResearchPaper`; the same module also creates graphs in
  the **forward** direction — `researchPaperToPublicationGraph` (`:81`) and
  `adaptResearchPaper` (`:298`, which calls it at `:304`), exported as the
  `researchPaperSourceAdapter` registration (`:317`). While that producer
  exists, the graph has a second producer that is not derived from one pinned
  Struct revision, which contradicts the invariant this list exists to
  enforce and lets the red-first assertion go green while a second producer
  remains. The forward bridge must therefore be **retired or migrated onto
  the Struct projection** as part of the narrow-vs-retire decision (see the
  bridge decision below), not merely excluded from this list while it stays a
  live producer. (F3/F4)

  `src/annotations/annotation-bundle.ts` is **not** a permitted target importer.
  It currently imports `PublicationGraph` (`:13`), resolves every anchor against
  graph node ids (`:76`, `:96-101`), quote-matches against graph node text
  (`:112-127`), and persists `graphId` as the document identity (`:24`, `:135`).
  If that dependency remains, the graph is canonical annotation authority and
  the narrow option is invalid. It must migrate its anchor/node-id authority to
  Struct document nodes (retiring graph authority) or the competing graph must
  be retired, before E-04 can exit; until then the red-first assertion above
  must stay red on it. Do not add the annotation module to an allowlist to make
  the rule pass. (F4)

  This list is the **target** permitted set after the narrow decision, not the
  current importer set. The current importer set is wider and is recorded in
  `docs/struct-publication-graph-authority-inventory.md` §3: besides the
  modules above, `src/publication/adapters/astro.ts` and
  `src/publication/adapters/payload-lexical.ts` import graph symbols and are
  the two adapters the release path can actually select,
  `src/publication/research-paper-adapter.ts` imports graph symbols and still
  exports a forward `ResearchPaper` -> `PublicationGraph` producer,
  `src/annotations/annotation-bundle.ts` imports graph symbols for anchor
  resolution, and the
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
  the rule is mechanical. `src/annotations/annotation-bundle.ts` is expected to
  keep the guard red until its anchor-authority migration lands; that red is the
  intended signal, not a reason to allowlist it.
  `src/publication/research-paper-adapter.ts` is expected to keep the guard red
  until its forward producer is retired or migrated onto the Struct projection;
  that red is the intended signal too, not a reason to allowlist the bridge.
  (F3/F4)
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
- **The forward direction is a second graph producer and is in scope too.**
  `researchPaperToPublicationGraph` (`src/publication/research-paper-adapter.ts:81`,
  ends `:196`) builds a `PublicationGraph` directly from a `ResearchPaper`
  (`:84` parses the paper), `adaptResearchPaper` (`:298`) calls it at `:304`,
  and `researchPaperSourceAdapter` (`:317`) is the exported registration of
  that projection. The reverse-direction decision above does not cover them.
  A graph minted from a `ResearchPaper` is not mechanically derived from one
  pinned Struct revision, so the narrow invariant does not hold and the
  red-first assertion can pass while a second producer remains. (F3/F4)
  The narrow decision must therefore **retire the forward bridge or migrate it
  onto the Struct projection** (`src/publication/struct-adapter.ts:188`
  `adaptStructDocument`, `:1313` `structPublicationAdapter`). Whichever branch
  the decision takes for the reverse direction, no module may build a
  `PublicationGraph` from a `ResearchPaper`. The forward bridge is **not**
  removed as an early or parallel cleanup either: it changes in the same
  reviewed change as the reverse-direction decision, and the test callers that
  build a graph from a paper
  (`src/publication/research-paper-adapter.test.ts:16`,
  `src/publication/source-adapter.test.ts:54`,
  `src/annotations/move-parity.test.ts:77`,
  `src/annotations/annotation-bundle.test.ts:15`) move to the Struct
  projection in that same change. The red-first assertion must stay red on
  `src/publication/research-paper-adapter.ts` until that lands; that red is
  the intended signal, not a reason to allowlist the bridge. (F3/F4)
- `src/annotations/annotation-bundle.ts` anchor resolution depends on graph
  node ids/text and persists `graphId`. It is therefore **not** in the target
  permitted importer list above. If that dependency remains, the graph
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
  The assertion must also reject graph-bearing **values and property access**
  across those boundaries — not only named imports — including reads of
  `bundle.graph`, `PublicationSourceResult.graph`, and any value that carries a
  `PublicationGraph`, and it must assert that the concrete writer functions in
  `tools/publication-build.mjs` and `tools/publication-check.mjs` no longer
  receive or read a graph. A guard that only prohibits imports of named graph
  symbols is insufficient, because `tools/publication-build.mjs` obtains a
  `PublicationSourceResult` from `registry.resolve()` and reads `bundle.graph`
  throughout route-parity and receipt generation. (F3)
- Bind publication receipts to the Struct `document`/`receipt` digests and the
  exact package pin; do not treat an independent graph digest as the semantic
  authority. Receipts must include the canonical Struct digests and exact
  package pin/version; graph-only digests are diagnostic only. (F8)
  **Current state, not the target:** no receipt carries any Struct binding
  today and `graphSha256` is the primary and only source identity in both
  receipt shapes. The only "closed allowlist" is
  `publicationOutputReceiptContract` (`src/publication/adapter-conformance.ts:444-526`),
  and **the release check does not call it**: `publicationCheck`
  (`tools/publication-check.mjs:1138-1200`) parses the receipt and validates
  selected fields directly. Widening that allowlist alone therefore makes
  nothing in the release path require a Struct binding. The Struct binding must
  be added, the admission requirement must be wired into `publicationCheck`
  (`assertPublicationReceiptSourceBinding`, `tools/publication-check.mjs:265-295`,
  called at `:1178`, or a new assertion invoked from `publicationCheck`), and
  the conformance allowlist widened deliberately for the adapter-conformance
  tool — in that order, before any graph digest can be demoted to diagnostic.
  (F8)
  Real runtime admission today, for reference: `assertPublicationReceiptPolicyVersions`
  (`tools/publication-check.mjs:238-249`, called `:1149`), the graph/asset/
  canonical-subset digest asserts (`:1161-1177`), the source binding (`:1178`),
  the provenance check (`:1179-1183`), `assertPublicationReceiptMappingVersion`
  (`:251-263`, called `:1184`), the repository binding (`:1185-1193`), the
  runtime binding (`:196-236`, called `:1194-1197`), and the four-artifact
  matrix check (`:1198-1201`). None of those inspects unknown keys or requires a
  Struct variant today.
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
      semanticReceiptSha256, packageSourceCommit, packageArtifact,
      packageArtifactSha256, packageIntegrity, packageVersion,
      bundleSha256? (only when wire bytes are available) }`.
      `semanticReceiptSha256` is **mandatory** for this variant. It is the
      canonical Struct receipt digest of the decoded document,
      `structReceiptDigest(document)`, a runtime export of
      `@erniesg/struct/receipt` at the current pin
      (`vendor/struct/...tgz::package/API_MANIFEST.json`
      `runtimeExports['./receipt']`; used as `packageReceiptDigest` in
      `tests/struct-package-parity.test.ts:18-21`). It is computable without
      the original wire bytes, so absence is a failure, not a reason to omit
      it. `bundleSha256` stays optional because it does need the wire bytes;
      at struct-variant **admission** the wire bytes are required (see the
      bundle-artifact requirement below), so it is required there.
  - Struct cutover/release admission requires the struct variant; the legacy
    variant is render-only and is not admission evidence. Admission must also
    decode the pinned Struct document from the bundle and assert BOTH of:
      `sourceBinding.documentSha256 === <document digest recomputed from
      decodedDocument>` (the document digest verified by `decodeStructBundle`,
      or recomputed from `decodedDocument` when the bundle carries no separate
      digest), and
      `sourceBinding.semanticReceiptSha256 === structReceiptDigest(decodedDocument)`.
    A `struct-cutover` receipt whose `sourceBinding.documentSha256` is missing,
    stale, or does not equal the document digest recomputed from
    `decodedDocument` is **rejected**; there is no "digest unavailable" or
    "digest unverified" downgrade for this variant, and the same no-downgrade
    rule applies to `semanticReceiptSha256`. Wire both checks into
    `tools/publication-check.mjs` (see above), not only into the conformance
    tool.
  - **The decode input does not exist yet, so a receipt-bound Struct bundle
    artifact is a required change.** `publication-check` receives only the
    render output directory (`--input <dir>`; `parsePublicationCheckArgs`,
    `tools/publication-check.mjs:35-59`), and the renderer writes
    `publication-graph.json`, `asset-bundle.json`, `publication-receipt.json`
    and the rendered outputs
    (`src/publication/renderers/vivliostyle.ts:1107-1116`, `:1201-1205`) but
    **no encoded Struct bundle and no pinned Struct document**. Once the graph
    reader is removed (EG-04; reader at `tools/publication-check.mjs:1145`),
    the checker has no bytes left to decode. E-04 must therefore add a
    **receipt-bound Struct bundle artifact** to the render output directory:
    the encoded bundle bytes written by the Struct adapter/renderer path as
    `struct-bundle.bin`, with `sourceBinding.bundleSha256` set to the SHA-256
    of exactly those bytes. `publicationCheck` must read that artifact from
    the output directory, decode it with
    `decodeStructBundle(bytes, { expectedBundleSha256:
    receipt.sourceBinding.bundleSha256 })`, and compute
    `structReceiptDigest(decodedDocument)` from the decoded document before
    comparing it to `sourceBinding.semanticReceiptSha256`. The artifact is
    required input for the struct variant, not an optional extra: a
    `struct-cutover` receipt whose bundle artifact is missing, unreadable, or
    whose digest does not match the receipt is **rejected**. The existing "no
    digest-unavailable downgrade" rule for this variant is unchanged, and
    `bundleSha256` stays optional in the variant shape only for the cases
    that have no wire bytes — at struct-variant admission it is required,
    because the bundle artifact is. (F8)
  - Canonical pin metadata authority is `vendor/struct/provenance.json`
    (`sourceCommit`, `artifact`, `sha256`, `integrity`, `packageVersion`),
    cross-checked against `package.json`, `package-lock.json`, and the tarball
    by `tests/struct-package-artifact.test.ts`. The release check must
    cross-check the **receipt's** package-identity fields against the same
    provenance file (see below); the artifact test does not do that. Do not
    create a second hand-maintained Struct pin in
    `src/publication/toolchain-manifest.json`; if a manifest entry is added
    later it must be generated/validated from provenance by the same test, not
    a second authority. (F8)
  - Exact package identity fields map to provenance, and `publication-check`
    must compare **every one** of them directly against
    `vendor/struct/provenance.json`:
    `sourceBinding.packageSourceCommit` -> `provenance.sourceCommit`,
    `sourceBinding.packageArtifact` -> `provenance.artifact`,
    `sourceBinding.packageArtifactSha256` -> `provenance.sha256`,
    `sourceBinding.packageIntegrity` -> `provenance.integrity`,
    `sourceBinding.packageVersion` -> `provenance.packageVersion`.
    `tests/struct-package-artifact.test.ts` cross-checks only the repository's
    provenance file against `package.json`, `package-lock.json`, and the
    tarball (`:45-77`); it never inspects a publication receipt. So a
    `struct-cutover` receipt with a correct `semanticReceiptSha256` but an
    arbitrary or stale `packageSourceCommit`, `packageArtifact`,
    `packageArtifactSha256`, `packageIntegrity`, or `packageVersion` would
    otherwise satisfy the release check while claiming an exact package pin
    it does not have. A mismatch on any of the five fields is a
    **rejection**, not a warning, and there is no "pin unavailable" downgrade
    for the struct variant. (F8)
- If any of text, semantic IDs, persistence, receipt, writer, or release path
  proves load-bearing, retire the competing graph instead of renaming it. (F4)
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
  the source of the pending-gate list below. **Drift rule:** this table and the
  inventory's §9 table (G-01..G-18) are the same obligation set; any row
  added, removed, or reworded in one must be applied identically to the other
  in the same change (the same change reaches the other table in the same
  commit), and a row present in only one of the two is a defect. The `EG-`/`G-`
  prefix is the only naming difference. Each table states a row in its own
  wording and names its own artifact list, so gate text and artifact lists are
  not required to be byte-identical between the two tables; what must match row
  for row is the `(Fn)` anchor marker set and the pending status (both documents
  record every row as pending). At this head the two tables are one-to-one and
  in the same order (18 rows each), their `(Fn)` anchor marker sets match on all
  18 pairs, and every row is pending (the `(F19)` asset-binding marker appears
  on the EG-10/G-10 pair in both tables); the two tables still word the same
  obligations differently and name different artifact lists for most rows,
  which is a pre-existing divergence this plan does not claim to have
  resolved.

### E-04 future gates (every row PENDING)

Every row is **PENDING**: none of these gates is implemented, tested, or
satisfied at this head. The "observed today" column is grep-bounded evidence
from the two inventories, not a compiler-proven statement, and no row asserts
runtime, golden, or activation evidence.

| # | Gate | Concrete artifact | Observed today | Status |
| --- | --- | --- | --- | --- |
| EG-01 | Graph narrowed to an ephemeral renderer plan from one pinned approved Struct revision (F4); redirecting the two selectable adapters onto the Struct projection requires the app-owned Astro-to-pinned-Struct ingress **and** the app-owned Payload-to-pinned-Struct ingress to exist, be tested against the pinned artifact, and land **before** the redirects they enable | `src/publication/adapter-registry.ts:55-60`, `tools/publication-build.mjs:54-67`, `src/publication/adapters/astro.ts`, `src/publication/adapters/payload-lexical.ts`, `src/publication/adapters/payload-lexical.ts:1646`, `:1726` | three adapters produce graphs; the CLI can select only `astro` / `payload-lexical` | PENDING |
| EG-02 | Graph owns no independent text (F4) | `src/publication/schema.ts:172-315`, `src/publication/research-paper-adapter.ts:198-296` | the graph has its own text fields and metadata envelope | PENDING |
| EG-03 | Graph owns no independent semantic IDs (F4) | `src/publication/schema.ts:7-11` | the graph has its own id grammar, **distinct and stricter** than `src/research/schema.ts:3`; the namespaces are **not** disjoint, because the bridge may copy the same id string verbatim (`src/publication/research-paper-adapter.ts:207`, `:216`, `:224`, `:232`, `:242`, `:253`) and the round-trip test asserts graph ids equal the source paper ids (`src/publication/research-paper-adapter.test.ts:18-20`) | PENDING |
| EG-04 | Graph owns no persistence (F4) | `src/publication/renderers/vivliostyle.ts:1107-1111`; reader at `tools/publication-check.mjs:1145` | the graph is written to the render output directory | PENDING |
| EG-05 | Graph owns no receipt (F4/F8) | `src/publication/renderers/vivliostyle.ts:109-117`; `src/publication/source-adapter.ts:25-65`; release validation at `tools/publication-check.mjs:1149-1197`; conformance allowlist at `src/publication/adapter-conformance.ts:447-494` | both receipts bind the graph digest as the source identity; the release check never calls the conformance allowlist | PENDING |
| EG-06 | Graph owns no writer and no release path (F3/F4) | `tools/publication-build.mjs`; `package.json` `build:production` | the release build runs the graph pipeline | PENDING |
| EG-07 | No reverse graph→ResearchPaper writer (F4) | `src/publication/research-paper-adapter.ts:198-296`; `src/publication/research-paper-adapter.test.ts:17` | the reverse converter exists; its only caller is the round-trip test | PENDING |
| EG-08 | Red-first static assertion: graph symbols and graph-bearing values/property access absent from storage/API/route/writer/release modules (F3) | extend the AST harness at `tests/struct-adapter-boundary.test.ts:12-55` to the `src/publication/**` and route/worker/writer roots, resolving imports AND property/dataflow access (including `bundle.graph` and `PublicationSourceResult.graph`) | the harness covers only `src/struct/**` and `src/struct-adapters/**`; no such assertion exists for `src/publication/**`; `tools/publication-build.mjs` imports `serializePublicationGraph` (`:29`), obtains a `PublicationSourceResult` from `registry.resolve()` (`:1067`), and reads the graph through property access — `bundle.graph` at `:463` (source-receipt `graphSha256`) and `const { graph } = bundle` at `:904` (route parity) — so that writer/release module is red on the named-import clause **and** on the property-access clause | PENDING |
| EG-09 | Byte-identical double-adapt conformance for one pinned `StructDocument`; the graph is never persisted or treated as canonical text (F4) | `src/publication/struct-adapter.ts:188`; `src/publication/struct-adapter.test.ts` | not found | PENDING |
| EG-10 | Receipts carry the canonical Struct digests and the exact package pin, with `documentSha256` mandatory and compared to the document digest recomputed from `decodedDocument` (as verified by `decodeStructBundle`), `semanticReceiptSha256` mandatory and compared to `structReceiptDigest(decodedDocument)` decoded from the receipt-bound Struct bundle artifact (`struct-bundle.bin`) written into the render output directory, and every receipt package-identity field compared against `vendor/struct/provenance.json`; graph digests demoted to diagnostic (F8). **The Struct bundle must be carried, not reconstructed:** the canonical `StructDocument` and the verified bundle handle (or the exact encoded bundle bytes) must travel from the ingress through the adapter result, through `validatePublicationSourceResult`, through the registry and into the renderer, so that the `struct-bundle.bin` in the render output is exactly the receipt-bound bytes the checker decodes; the renderer must write the bytes it was given and the receipt's bundle digest must be the digest of the written file (F15). **The rendered assets must be bound to the decoded bundle:** the release checker must compare the decoded Struct bundle's asset identities, digests and byte lengths with the publication asset descriptor the renderer consumed (`asset-bundle.json`) and with the assets actually shipped in the output, so that a valid Struct bundle cannot be paired with different image bytes; this adds a comparison and weakens no existing asset check (F19) | `src/publication/renderers/vivliostyle.ts:109-117`, `:1081-1207`, `:1107-1116`, `:546-567` (`writeAssets`), `:805-826` (EPUB assets), `:1112-1115` (`asset-bundle.json`); `src/publication/source-adapter.ts:25-65`, `:129-134` (closed `PublicationSourceResult`), `:177-216` (`validatePublicationSourceResult`); `src/publication/asset-bundle.ts:14-54` (asset descriptor), `:56-61` (bundle descriptor), `:124-134` (content-address verification); `src/publication/adapter-registry.ts:10` (`PublicationBundle`), `:30-38` (`resolve`); `src/publication/adapter-conformance.ts:447-494`; `tools/publication-check.mjs:35-59`, `:1145`, `:1162`, `:1152-1160` (persisted asset descriptor and shipped asset paths), `:1165-1169` (`assetBundleSha256` assert), `:1178`; `tests/struct-package-parity.test.ts:18-21`; `tests/struct-package-artifact.test.ts:45-77`; `vendor/struct/provenance.json` | no Struct binding exists; the renderer writes no Struct bundle artifact, `publicationCheck` receives only the output directory and does not require the variant, the conformance allowlist would reject the extra keys, and nothing compares a receipt's package identity against provenance; and the source result cannot carry the bundle at all today - `PublicationSourceResult` is a closed four-field type (`src/publication/source-adapter.ts:129-134`), `validatePublicationSourceResult` returns only those four fields (`:207-215`), and the registry passes exactly that value on (`src/publication/adapter-registry.ts:30-38`), so the encoded bundle is discarded before the renderer runs; and the release checker reads and digests only the app-side asset descriptor (`tools/publication-check.mjs:1152-1169`), so nothing compares the Struct bundle's assets with the publication asset descriptor or with the shipped asset files | PENDING |
| EG-11 | `ResearchPaper` stays a read-only compatibility model with a checked-in caller inventory (F5) | `docs/struct-research-paper-caller-inventory.md` | the inventory exists (grep-bounded); read-only enforcement and both-mode parity are not done | PENDING |
| EG-12 | EPUBCheck / Ace / human accessibility stay app-owned (F11) | `src/publication/renderers/vivliostyle.ts:724`; `src/research/publication-integrity.ts` | app-owned today | PENDING |
| EG-13 | Legacy `research/epub.ts` overloads keep both-mode parity until the last `ResearchPaper` consumer migrates (F5) | `src/research/epub.ts:133-141`, `:1422-1447`, `:2094-2118` | the call-site inventory exists; parity is **not** demonstrated | PENDING |
| EG-14 | E-07 deletion gates: zero production imports to removed portable modules, package-only app tests, retained-compatibility register (F6) | `src/struct/**`, `src/struct-adapters/**` | not done; duplicate core deletion stays at E-07 | PENDING |
| EG-15 | No non-Struct graph producer remains: the forward bridge is retired or migrated onto the Struct projection (F3/F4) | `src/publication/research-paper-adapter.ts:81`, `:298`, `:304`, `:317`; `src/publication/struct-adapter.ts:188`, `:1313` | the forward bridge still exports a `ResearchPaper` -> `PublicationGraph` producer; it has only test callers today, but the module is exported and callable, so a second producer would remain after the reverse direction is retired | PENDING |
| EG-16 | Production renderer parity covers every **shipped artifact** of the production output, not only the `eink.epub` archive: the shipped WebPub content document `phone-webpub/index.html`, the resources it declares and references (the stylesheet, the assets, and the stylesheet's own font references), and the declared resource manifests (`phone-webpub/publication.json`, `EPUB/package.opf`); the frozen production case set covers the Astro case **and** the Payload case the production CLI can select; the Payload case is produced through the app-owned Payload-to-pinned-Struct ingress, which must be specified, tested against the pinned artifact, and landed **before** the Payload case is an E-04 exit gate - the Payload parity obligation itself is unchanged, not narrowed and not deferred (F12) | `src/publication/renderers/vivliostyle.ts:508`, `:610-662`, `:617-618`, `:634-638`, `:639-660`, `:793-904`; `tools/publication-build.mjs:54-67`; `tools/publication-adapter-conformance.mjs:59-91`; `tests/fixtures/publication/astro/payload-equivalent.mdx`; `tests/fixtures/payload/equivalent-publication.json`; `tests/fixtures/payload/mapping.json`; `src/publication/adapters/payload-lexical.ts:139`, `:1646`, `:1726` | no production comparison is implemented for any shipped artifact; the previous scope was `EPUB/content.xhtml` only; the frozen production inputs exist, but there is no frozen production-case fixture set and no `eink.epub` golden in the repository | PENDING |
| EG-17 | The production Astro path reaches the pinned Struct revision **before** any direct graph producer is retired: a concrete, tested Astro-to-pinned-Struct conversion, the production CLI `--adapter astro` mapping, the registry/locator flow that carries it, and a red-first guard that the Astro path no longer constructs a `PublicationGraph`; the Astro provenance must survive the projection - the ingress must carry the outer Astro provenance through `adaptStructDocument` or explicitly restamp **both** the result provenance and every per-node provenance before validation, so the route-parity policy in `tools/publication-check.mjs:61-94` sees a consistent `(adapterId, sourceType)` pair and the planned production build passes admission (F13) | `src/publication/adapters/astro.ts:25-28`, `:84-92`, `:567`, `:606-611`; `src/publication/struct-adapter.ts:188` (`adaptStructDocument`), `:24` (`STRUCT_PUBLICATION_ADAPTER_ID`), `:175-181` (`sourceType`), `:660` (per-node provenance), `:1288-1296` (result provenance), `:1313-1318` (`structPublicationAdapter`); `src/publication/adapter-registry.ts:30-38`, `:55-60`; `tools/publication-build.mjs:31-69`, `:54`, `:66`, `:452-469`, `:1054-1067`, `:1081-1086`; `tools/publication-check.mjs:61-94`, `:1151`; `tests/struct-adapter-boundary.test.ts`; `vendor/struct/provenance.json` | the Astro adapter builds the graph directly (`publicationGraphSchema.parse` at `src/publication/adapters/astro.ts:567`); no Astro-to-Struct ingress exists; the CLI maps `--adapter astro` to that direct producer, and the registry resolves exactly one adapter per id; and the Struct projection stamps its own identity (`adapterId: 'struct-document'` at `src/publication/struct-adapter.ts:1290`, per node at `:660`; `sourceType: 'research-paper'` for a non-PDF/DOCX source at `:175-181`, `:1292`), while the Astro branch of the CLI binds the `'astro-canonical-route'` route-parity policy (`tools/publication-build.mjs:1081-1086`) - so a composed receipt would be rejected by `tools/publication-check.mjs:92-94` | PENDING |
| EG-18 | The production Payload path reaches the pinned Struct revision **before** any direct graph producer is retired: a concrete, tested Payload-to-pinned-Struct conversion, the production CLI `--adapter payload` mapping, the registry/locator flow that carries it, and a red-first guard that the Payload path no longer constructs a `PublicationGraph`; **the Payload provenance must survive the projection** - the ingress must carry the outer Payload provenance through `adaptStructDocument` or explicitly restamp **both** the result provenance and every per-node provenance to the Payload identity before validation - the per-node fields being exactly `adapterId`, `sourceId` and `sourceRevision`, while `sourceType` stays on the **result** provenance only, because the strict node provenance schema (`src/publication/schema.ts:114-122`) accepts no `sourceType` and the release admission check compares every node's `provenance.adapterId` (`tools/publication-check.mjs:274-280`), `provenance.sourceId` (`:281-288`) and `provenance.sourceRevision` (`:289-294`) against the receipt's source identity - so a `payload-lexical` build whose nodes still say `'struct-document'` is rejected at admission even though its route-parity policy is valid (F16); and **the multi-locale linked-edition contract must have a stated disposition** - either a per-locale Struct projection/linking design with a localized parity case, or the explicit retirement of the exported `adaptPayloadLexicalEditions` API with its callers named (`src/publication/adapters/payload-lexical.ts:1701-1726`, `src/publication/adapters/payload-lexical.test.ts:2829-2830`), so the redirect does not silently drop that contract (F17) | `src/publication/adapters/payload-lexical.ts:9` (`PAYLOAD_LEXICAL_ADAPTER_ID`), `:139` (mapping policy), `:818-838` (`commonNode` per-node provenance), `:1646` (direct graph construction), `:1662-1668` (result provenance), `:1673-1698` (single-locale `adaptPayloadLexical`), `:1701-1726` (`adaptPayloadLexicalEditions`, `equivalentNodeId` at `:1722`), `:1732-1736` (adapter registration); `src/publication/struct-adapter.ts:188` (`adaptStructDocument`), `:24` (`STRUCT_PUBLICATION_ADAPTER_ID`), `:55` (`localeFor`), `:133-143` (`sourceIdFor`), `:192` (per-result source id), `:229`, `:660` (per-node provenance), `:668` (`edition: { editionId }`), `:1288-1296` (result provenance); `src/publication/adapter-registry.ts:30-38`, `:55-60`; `tools/publication-build.mjs:31-69`, `:54`, `:66`, `:452-469`, `:1054-1067`, `:1084-1086`; `tools/publication-check.mjs:61-94`, `:265-294`, `:1178`; `src/publication/schema.ts:114-122` (strict node provenance schema), `:166` (`edition.equivalentNodeId`); `src/publication/adapter-conformance.ts:276-277`; `src/publication/adapters/payload-lexical.test.ts:5`, `:2829-2830`; `tests/struct-adapter-boundary.test.ts` | the Payload adapter builds the graph directly (`publicationGraphSchema.parse` at `src/publication/adapters/payload-lexical.ts:1646`, edition re-parse at `:1726`); no Payload-to-Struct ingress exists; the CLI maps `--adapter payload` to that direct producer (`tools/publication-build.mjs:54`); and the Struct projection stamps its own identity on every node (`adapterId: 'struct-document'` at `src/publication/struct-adapter.ts:660`, result at `:1290`), while `adaptStructDocument` is single-locale and never emits `edition.equivalentNodeId` (`src/publication/struct-adapter.ts:55`, `:668`) - so a redirected Payload build would fail the per-node admission check, and the exported multi-locale edition API has no specified replacement | PENDING |

EPUBCheck, Ace, and human accessibility approval remain app-owned release
evidence, not package unit tests.

### E-04 frozen output parity

- Dual-render first: for every frozen adapter case, compare local
  `renderPublicationXhtml`/`buildStructEpub` against the package renderers and
  assert byte/content-hash equality before switching imports.
- Dual-render the production path too: for every production case the
  **production CLI can select** - that is every id in the CLI `--adapter`
  allowlist, `astro` and `payload-lexical` (`--adapter payload` mapped to
  `payload-lexical` at `tools/publication-build.mjs:54`; any adapter outside
  that allowlist is rejected at `:66`) - each of which must be added to the
  checked-in frozen production fixture set before it counts as a covered case.
  The wired release build selects only the Astro case (`npm run
  build:production` runs `publication:build --adapter astro --entry
  moving-to-cloudflare-with-astro`), but the wired script is **not** the case
  set: the CLI can select the Payload case as well, that branch accepts
  `--input <json>` (`:60-64`), and it reaches the same
  `vivliostyleRenderer.render` (`:1077-1080`), so the Payload case is a
  production case for parity purposes and must be in the frozen set. The CLI
  has no entry-id allowlist: on the `astro` branch `--entry` is only required
  to be present (`tools/publication-build.mjs:55-59`), so the frozen set
  pins the entry ids it covers rather than inheriting them from the release
  script. The frozen inputs for both cases already exist:
  `tests/fixtures/publication/astro/payload-equivalent.mdx` with
  `public/favicon-16x16.png` copied in as `fixture-image.png` for the Astro
  case, and `tests/fixtures/payload/equivalent-publication.json` with
  `tests/fixtures/payload/mapping.json` for the Payload case - the same pair
  the conformance harness already renders side by side
  (`tools/publication-adapter-conformance.mjs:59-91`).
  Compare the Vivliostyle local renderers `publicationGraphToHtml`
  (`src/publication/renderers/vivliostyle.ts:508`) and `createPublicationEpub`
  (`:793-904`, reached from `vivliostyleRenderer.render` at `:1083-1207`) against
  the package XHTML/EPUB renderers, and assert
  **content equality of the rendered publication content** for the same pinned
  source revision - the same document text in the same reading order, the same
  referenced asset set, and the same id/target mapping (every id emitted by one
  render resolves to the same node or asset in the other) - for **every
  shipped content document of the production output**, not for the EPUB alone:
  - the XHTML that `createPublicationEpub` writes as `EPUB/content.xhtml`
    (built through `publicationGraphToHtml` at `:848`, written at `:855`); and
  - the WebPub content document `phone-webpub/index.html` (built through the
    same `publicationGraphToHtml` call at `:636`, written at `:634-638`),
    which is a separate shipped artifact with its own stylesheet, its own
    asset directory, and its own resource manifest.

  The comparison must also cover the **declared and referenced resources** of
  each shipped artifact, not only the content document:
  - the stylesheet reference the document head emits
    (`<link rel="stylesheet" href="...">`, `:541`);
  - the asset references the document body emits (`<img src>`, `<audio src>`,
    `<video src>`, `<a href>`; `:407-453`);
  - the stylesheet's own font references
    (`src/styles/publication/publication.css:1-15`);
  against the files those references resolve to and the resources those
  artifacts declare (`phone-webpub/publication.json` `readingOrder` and
  `resources`, `:639-660`; the `EPUB/package.opf` manifest items, `:891`).
  A comparison that covers only `EPUB/content.xhtml` leaves the shipped
  WebPub artifact uncompared, and the WebPub is the artifact a phone reader
  receives.
  That comparison is on content identity, not on raw
  strings: the app mints app-owned ids and hrefs
  (table-cell ids as `<node-id>-cell-<cell-id>`,
  `src/publication/struct-adapter.ts:895`; asset hrefs as `assets/<id><ext>`,
  `src/publication/renderers/vivliostyle.ts:815`) while the package emits the
  Struct block/cell ids and the Struct asset hrefs, so the test compares text,
  order, asset set, and node/cell identity through the pinned Struct revision
  instead of literal id or href strings. Do **not** assert byte or content-hash
  equality of the whole `eink.epub` archive: the app-owned packaging
  (`EPUB/fonts/*`, `EPUB/publication.css`, the `EPUB/nav.xhtml` labels and
  landmarks, and the `EPUB/package.opf` accessibility metadata) stays app-owned
  under EG-12 and is excluded from the comparison, exactly as
  `tools/publication-check.mjs:1217-1226` checks the archive today (the
  `schema:accessMode` + `<spine>` assertion, then the `epub:type="toc"` +
  `epub:type="landmarks"` assertion; the archive content check follows at
  `:1227-1232`) - a package-built archive fails those assertions, which is why
  the two archives are required to differ. The comparison runs against a
  checked-in frozen production fixture set that E-04 must create: there is no
  frozen production-case fixture set and no `eink.epub` golden in the repository
  today (`tests/fixtures/publication/astro/` holds only `fixture-image.svg`,
  `payload-equivalent.mdx`, `synthetic-publication.mdx`, and
  `unsupported-component.mdx`). The production path is a separate implementation
  from `src/research/epub.ts`, so the `renderPublicationXhtml`/`buildStructEpub`
  comparison above does not discharge it. When EG-01 redirects the
  `payload-lexical` graph production onto the Struct projection, the same
  frozen Payload case must still pass this comparison, so the redirect cannot
  change the shipped content. The Payload case is therefore not an E-04 exit
  gate until the app-owned Payload-to-pinned-Struct ingress exists and is
  tested (the `payload-lexical` adapter constructs the `PublicationGraph`
  directly today - `src/publication/adapters/payload-lexical.ts:1646`,
  `:1726` - so there is no `StructDocument` to project until that ingress
  lands). The obligation itself is unchanged and not narrowed: the Payload
  case stays in the frozen production case set and must still pass this
  comparison. (F11/F12)
- The repackaging path must preserve a valid stylesheet resource contract, and
  the E-04 evidence must assert it by name. The package renderer emits
  `<link rel="stylesheet" type="text/css" href="styles.css" />` whenever its
  `embedStyles` option is not set (`src/struct/xhtml.ts:322`), while the
  retained app-owned EPUB packaging writes `EPUB/publication.css`
  (`src/publication/renderers/vivliostyle.ts:838`) and declares it in the OPF
  manifest as `href="publication.css"`
  (`src/publication/renderers/vivliostyle.ts:891`), and the app-owned XHTML
  writer references that same name (`stylesheet = 'publication.css'`,
  `src/publication/renderers/vivliostyle.ts:512`). Dropping the package XHTML
  into that packaging unchanged would therefore ship an archive whose XHTML
  references `styles.css` while the archive contains and declares only
  `publication.css` - a missing stylesheet - and the content-equality
  comparison above would still pass, because the stylesheet is app-owned and
  excluded from that comparison. The E-04 repackaging must therefore either
  (a) render the package XHTML with its styles **embedded** (the package
  renderer's `embedStyles` option), or (b) ship the stylesheet in the archive
  under the exact name the rendered XHTML references (`styles.css`) and declare
  it in `EPUB/package.opf` next to the existing manifest items. The E-04
  evidence set must then contain a named assertion - the *stylesheet binding*
  assertion - that every stylesheet reference in the shipped XHTML resolves to
  a file that is present in the archive **and** declared in the OPF manifest.
  The same named assertion must cover the **WebPub** artifact, which is a
  separate shipped artifact with its own bindings and its own resource
  manifest, and which a phone reader receives:
  - the WebPub content document's stylesheet reference (`publication.css`)
    must resolve to a file present in `phone-webpub/` (written at `:618`)
    **and** listed in `phone-webpub/publication.json` `resources` (`:648-654`);
  - every asset the document references (`assets/<id><ext>`, written at
    `:617`) must resolve to a file present in `phone-webpub/assets/` **and**
    listed in that same `resources` array;
  - the stylesheet's own `@font-face` references must resolve to the font
    files the WebPub ships (`Geist-Regular.ttf`, `Geist-Bold.ttf`,
    `GeistMono-Regular.ttf`, copied at `:619-633`) and that `resources` array
    declares.
  The EPUB side of the same assertion keeps its existing shape: the EPUB
  stylesheet's font references are rewritten to `fonts/Geist-*.ttf`
  (`:840-845`) and must resolve to the `EPUB/fonts/*` files that the OPF
  manifest declares (`:891`).
  This is a resource-binding assertion only: the app-owned stylesheet
  (`EPUB/publication.css`), the app-owned fonts, the app-owned OPF metadata, and
  the app-owned nav labels stay app-owned and excluded from the content
  comparison, EG-12 (EPUBCheck, Ace, and human accessibility acceptance) is
  unchanged, and no whole-archive byte-identity promise is added. (F11/F12)
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
  inventory, warning/horizon, and removal issue. (F6)

### Staged dual-read / switch / contract and rollback

Every stage is red-first and independently revertible:

1. Dual-read (E-02/E-03): reproduce local output with the package on frozen
   fixtures; no production import change yet.
2. Dual-render (E-04): reproduce local XHTML/EPUB with the package renderers.
3. Switch (E-03/E-04): change production imports only; local modules stay
   unchanged.
4. Contract (E-07): delete local duplicates after zero-import + parity proof. (F6)
5. Rollback: revert the pin commit and/or the import-switch commit to restore the
   previous exact head and local compatibility paths. No durable data or route
   mutation is involved before E-06. Unsafe package downgrade is rejected.

## Required evidence per stage

| Stage | Must show |
| --- | --- |
| E-02 | Atomic pin (F10); adapter -> package decode -> bundle verify conservation on PDF/DOCX fixtures (F1); bytes-only ingress; frozen parity unchanged except reviewed additions; no writer change |
| E-03 | Static import guard red-then-green (F6); package/local dual-read equality; accepted/rejected matrix; recovery copy parity (F9) **and the production recovery wrapper obtaining the diagnostic category and the actionable-recovery predicate from the package recovery runtime exports (`diagnosticCategory` and `hasActionableRecovery` from `@erniesg/struct/recovery`), with the app UX overlay and the app facade preserved** (F14); high-fan-in consumers enumerated and tested |
| E-04 | Dual-render output/failure parity (F11 for the production path, F5 for the legacy `ResearchPaper` renderer overloads), including the named stylesheet-binding assertion for the production path (every stylesheet reference in the shipped XHTML resolves to a file that is present in the archive and declared in the OPF manifest, after the package XHTML is rendered with embedded styles or the stylesheet is shipped under the exact referenced name and declared in `EPUB/package.opf`); the same named binding assertion on the shipped WebPub artifact (the `phone-webpub/index.html` stylesheet and asset references resolve to files present in `phone-webpub/` and declared in `phone-webpub/publication.json` `resources`, and the stylesheet's own font references resolve to the shipped font files); the production comparison covers **every shipped content document** (`EPUB/content.xhtml` and `phone-webpub/index.html`), not the EPUB alone, over a frozen production case set that contains the Astro case and the Payload case the production CLI can select (F12); the production Astro ingress to the pinned Struct revision, the production CLI `--adapter astro` mapping, the registry/locator flow that carries it, and the red-first guard that the Astro path no longer constructs a `PublicationGraph`, all landed **before** the direct graph producer is retired (F13); the Astro provenance carried through the projection or explicitly restamped on **both** the result provenance and every per-node provenance before validation, so the route-parity policy in `tools/publication-check.mjs:61-94` sees a consistent `(adapterId, sourceType)` pair and the planned production build passes admission (F13); the Struct bundle carried from the ingress through the adapter result, its validation, the registry and into the renderer, so that the `struct-bundle.bin` in the render output is the exact receipt-bound bytes the checker decodes (F15); the decoded Struct bundle's asset identities, digests and byte lengths compared by the release checker with the publication asset descriptor the renderer consumed (`asset-bundle.json`) and with the assets actually shipped in the output, so that a valid Struct bundle cannot be paired with different image bytes, with no existing asset check weakened (F19); the app-owned Payload-to-pinned-Struct ingress specified, tested against the pinned artifact, and landed **before** the Payload case in the frozen production case set is an E-04 exit gate and before the `payload-lexical` redirect (EG-01) is performed, with the Payload parity obligation itself unchanged (F12); the Payload provenance carried through the projection or explicitly restamped on **both** the result provenance and every per-node provenance before validation - the per-node fields being exactly `adapterId`, `sourceId` and `sourceRevision`, with `sourceType` staying on the result provenance only, because the strict node provenance schema (`src/publication/schema.ts:114-122`) accepts no `sourceType` - so the node-provenance clauses of `tools/publication-check.mjs:274-280`, `:281-288` and `:289-294` bind every node to the receipt's source adapter, source id and source revision and a production `--adapter payload` build is admitted rather than rejected (F16); a stated disposition for the multi-locale linked-edition contract of the exported `adaptPayloadLexicalEditions` - a per-locale Struct projection/linking design with a localized parity case, or the explicit retirement of that exported API with its callers named (F17); PublicationGraph ownership proof or retirement (F4) (enumerated importer set (F3), reverse-direction proof (F4), forward-producer retirement/migration proof (F3/F4), annotation authority decision (F4); static absence from storage/API/route/writer/release modules (F3); receipts bound to Struct digests/package pin via `vendor/struct/provenance.json`, with the mandatory `documentSha256` compared to the document digest recomputed from `decodedDocument` (as verified by `decodeStructBundle`) **and** the mandatory `semanticReceiptSha256` compared to `structReceiptDigest(decodedDocument)` decoded from the receipt-bound `struct-bundle.bin` artifact, and every receipt package-identity field compared against `vendor/struct/provenance.json`, by `tools/publication-check.mjs` (F8); E-04 static import guard red-then-green for `xhtml`/`epub`/`emitted-ids` (F6); EPUBCheck/Ace/human accessibility still app-owned (F11); checked-in authority inventories at `docs/struct-research-paper-caller-inventory.md` and `docs/struct-publication-graph-authority-inventory.md` (F5) (present at this head; grep-bounded, not compiler-proven, and not gate satisfaction by themselves); every row of the E-04 future-gate table still PENDING until the corresponding evidence exists |
| E-05 | Design record; authenticated state machine; inactive route cannot expose unapproved/superseded artifact; concurrency + rollback/forward recovery rehearsal; writer still inactive |
| E-06 | Accepted E-ACT receipt matching exact head/pins/targets; single writer; post-activation health/observation/read-after-write |
| E-07 | Extraction-point hashes; package-test mapping; zero production imports to removed modules (F6); package-only app tests; retained-compatibility register |

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

- **Scope of this branch (corrected - it is not documentation-only).** Against
  its base `6952ae4874b8f5e2617785e4d98375df2b8ec8ec` (the head of `main`
  that PR #452 targets) this branch changes **five** files:
  - the three documentation files this plan belongs to -
    `docs/superpowers/plans/2026-10-20-struct-full-cutover-sequence.md`,
    `docs/struct-publication-graph-authority-inventory.md` and
    `docs/struct-research-paper-caller-inventory.md`;
  - `package.json` - **one added line**, the `overrides` entry
    `"vite": "8.1.6"` (commit
    `eaee813218e46ed93937f7682547022b4e77d4ac`, "fix(deps): override vite to
    the patched 8.1.6 for the runtime audit gate"); and
  - `package-lock.json` - **regenerated for that override**, 31 insertions and
    187 deletions against that commit's own parent `77c793fa`.

  The lockfile **was** changed by this branch; "the lockfile was unchanged" is
  false. The dependency change is **unrelated to this plan's normative
  content** - it is a scoped security override that every later branch needs,
  because the runtime npm-audit gate is evaluated per branch - but it is part
  of this branch, and its validation evidence is recorded below. For the
  dependency pair, `git diff e1844d2f HEAD -- package.json package-lock.json`
  is empty: those two files are byte-identical between the CI-verified head
  `e1844d2f` and this head, and `git log 6952ae48..HEAD -- package.json
  package-lock.json` names `eaee8132` and nothing else.
- **Recorded validation evidence for the dependency change.** The npm-audit
  gate, the install and the lockfile checks below were executed by the
  dependency lane that produced the equivalent override commit
  `6b9d26730b45bd3fa60833556d027d7991a1718e` on base `9d10da27`; that commit
  adds the identical `overrides` line and resolves a single hoisted
  `vite@8.1.6`, and its only lock differences against `eaee8132` are
  pre-existing base differences (the `@erniesg/struct` tarball pin and the dev
  flag on `saxes`/`xmlchars`), not `vite`. The dry-run and CI evidence was
  additionally executed against **this branch's own heads**.
  - **npm audit gate.** The node policy evaluator extracted verbatim from
    `.github/workflows/ci.yml:269-344` and run against the worktree: **before**
    the override, exit 1 with `npm audit (runtime, level high): 1 blocking, 1
    allowed` - blocking `GHSA-587h-7wmj-h5pm` (vite, high); **after**, exit 0
    with `npm audit (runtime, level high): 0 blocking, 1 allowed`. The only
    remaining runtime advisory is the pre-existing `GHSA-ch52-4w7c-c8xp`
    (http-cache-semantics, high), which `.agent/audit.json` already allows
    until 2026-11-02, plus the moderate `GHSA-r4xh-jqrq-34v2` (smol-toml),
    which is below the high gate level. `vite` is absent from the runtime
    audit and from the full all-scopes audit (25 advisories, down from 26). The
    "before" state reproduces the reported Rucksack CI run `39540068334`
    failure exactly.
  - **Install.** `npm ci --ignore-scripts` exit 0 (added 1415 packages,
    audited 1416); `npm ls vite --all` exit 0 with every `vite` resolving to
    `8.1.6` (overridden or deduped) and no invalid, missing or `UNMET` entry
    for `vite`; `npm ls --all` exit 0 with the whole tree valid.
  - **Lockfile consistency.** `npm ci --dry-run --ignore-scripts --no-audit
    --no-fund` exit 0 under **Node v24.22.0 / npm 11.4.2** on linux arm64
    against this branch's own head
    `51c6656f9e0cab725672d09efaf22a8c6b9af1b5` (recorded in
    `npm24-lock51-repro-result.json`). The P1 "lockfile out of sync" finding
    raised against `package.json` was reproduced and is a **false positive**:
    the same dry run exits 0 under npm 10.9.8 (the repository's own CI Node
    22 toolchain) and under npm 11.4.2, the lockfile does contain
    `@emnapi/runtime` and `@napi-rs/wasm-runtime`, and the reported lines are
    peer-dependency warnings, not a sync failure.
  - **pnpm.** `pnpm import` exit 0 (pnpm v12.8.1) regenerates the
    `pnpm-lock.yaml` from the new npm lock. That file is excluded by the
    repository's local `.git/info/exclude`, is not tracked, and was not
    committed; it must never be committed, because a tracked `pnpm-lock.yaml`
    would make the CI gate branch skip the npm audit.
  - **Targeted suites on the committed tree.** `npx vitest run src/publication
    src/struct-adapters tests/struct-inline-code-fidelity.test.ts
    tests/struct-package-artifact.test.ts --maxWorkers=1` exit 0 (20 files,
    245 tests); `npx astro check` exit 0 (816 files, 0 errors, 0 warnings);
    `npx astro build` exit 0 (181 pages); `npm run publication:build --
    --adapter astro --entry moving-to-cloudflare-with-astro` exit 0 on the
    committed tree; `npm run publication:check -- --input <output> --matrix
    phone-webpub,eink-epub,a5-pdf,a4-pdf` exit 0 on the committed tree.
  - **CI.** The recorded Rucksack CI run `39552130561`, together with
    `evidence`, `secret-scan` and `GitGuardian Security Checks`, was
    **SUCCESS** at head `e1844d2f6d993e582c037479f09daeef50bddc8d`, an
    ancestor of this head that already carries this exact dependency change.
    **This record does not claim a green CI run at this head**: CI must be
    re-verified at the new head before the PR can be merged.
  - **Not run.** The full repository suite `npm test` and the Playwright e2e
    suites were not run; the targeted publication and fidelity suites above
    were run instead.
- **The normative content of this head is documentation-only.** This head
  tightens the normative gates and nothing else: the production renderer
  parity scope (F12), the production Astro path to the pinned Struct revision
  (F13), the production recovery wrapper's category **and actionable-recovery**
  authority (F14), the Struct bundle carry from ingress to renderer (F15), the
  Payload per-node provenance (F16), the multi-locale linked-edition
  disposition (F17), the binding of the rendered assets to the decoded Struct
  bundle (F19), and the validation scope of this branch itself (F18). Every
  one of them is **planned work that is not implemented at this head**: there
  is no Astro-to-Struct ingress module, the Astro adapter still builds the
  graph directly, there is no Payload-to-Struct ingress module, the Payload
  adapter still builds the graph directly, the source result still cannot
  carry the Struct bundle, the app recovery wrapper still imports types only
  from the package, still carries its own category table and still decides the
  actionable-recovery boolean locally, and there is no frozen
  production-case fixture set. `EG-10`, `EG-16`, `EG-17` and `EG-18` carry the
  bundle-carry (including the asset binding), renderer-parity, Astro-ingress
  and Payload-ingress obligations and are **PENDING**, exactly like every other
  row of the E-04 future-gate table; the `F14` recovery obligation is carried
  in the E-03 section above and is likewise unimplemented. **No source, test,
  fixture, golden, receipt, or CI file was changed by this head**, and neither
  `package.json` nor `package-lock.json` was changed by this head - they were
  changed earlier on this branch by `eaee8132`, and that change is recorded
  above.
- The runtime parity/boundary tests that this plan's stages require are still
  **not** executed by this branch: the pinned artifact install
  (`node_modules/@erniesg/struct`) exists only in the dependency lane's
  checkout, where it was made by the `npm ci` above, and the E-02/E-03/E-04
  runtime evidence (adapter -> package decode -> bundle verification, the
  frozen cross-repository parity, the static boundary harness) is not produced
  by this head and is not claimed by it.
- This head also integrates the two checked-in authority inventories (merged
  from `58c9097c7191c182416ee8329fee518b0355a791`). That integration is a
  documentation merge plus link and correction edits only: no source, test,
  golden, fixture, receipt, or runtime behaviour changed, and no build, test,
  render, hash, or activation was executed **for that integration**. Every
  "no importer was found" statement inherited from those inventories remains
  **grep-bounded, not compiler-proven**, and is recorded as such wherever this
  plan relies on it.
- Nothing in this plan or in the two inventories claims a runtime result, a
  golden comparison, a receipt, a cutover, a writer or route activation, or a
  satisfied gate. The E-04 future-gate table above is the explicit list of what
  is still pending. (F18)

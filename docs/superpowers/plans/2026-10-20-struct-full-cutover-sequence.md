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
| G-S04 | Exact integrated Struct head, release decision packet, tarball digest, export/API manifest including a complete `./bundle`, clean-consumer install, full bundle negative matrix, three-run XHTML/EPUB goldens | E-02 bundle + E-02 pin bump | OPEN |
| G-PR450 | Inline-hyperlink accounting landed with its own reviewed golden | E-02 structured-DOCX conservation parity | OPEN |
| G-E-WF | Generated publisher workflow registered with drift gate (#281) | E-02 and publication-state work | CLOSED |
| G-EACT | Immutable, authenticated, target-specific explicit-user authorization bound to writer/public-route activation | E-06 only | NOT ELIGIBLE YET |
| G-ARTIFACT | One reviewed commit updates tarball + provenance + `package.json` + `package-lock.json` together, with artifact/parity/boundary tests green | every pin bump | must hold |

No implementation in this plan may run `npm publish`, activate a writer or
public route, deploy, or claim a cutover. Package publication stays outside this
tree.

## Artifact pin / lock / vendor / provenance atomicity

Any E-02/E-03/E-04 pin bump is a single atomic reviewed change over exactly
these files:

- `vendor/struct/<artifact>.tgz` (new bytes)
- `vendor/struct/provenance.json` (`sourceCommit`, `artifact`, `sha256`,
  `integrity`, `sourceLockfileSha256`)
- `package.json` `dependencies["@erniesg/struct"]`
- `package-lock.json` `packages[""]` and `packages["node_modules/@erniesg/struct"]`

Rules:

1. Verify tarball SHA-256 and integrity before writing provenance.
2. Update all four together; never leave a partially bumped pin. If any of
   `tests/struct-package-artifact.test.ts`, `tests/struct-package-parity.test.ts`,
   or `tests/struct-adapter-boundary.test.ts` fails, revert the whole commit.
3. Use the shared pnpm store. Do not commit generated `pnpm-lock.yaml`
   (see `docs/struct-migration-status.md`). For an Ernie.SG VM worktree use the
   documented physical-directory setup:
   `pnpm import` then
   `CI=true pnpm install --node-linker=hoisted --frozen-lockfile --ignore-scripts`,
   then `node tools/publication-install-browser.mjs`.
4. If the S-04 export map adds `./bundle`, update the exact expected export list
   in `tests/struct-package-artifact.test.ts` deliberately in the same reviewed
   commit. Do not silently widen the public surface for any other path, and do
   not add raw `sha256` helpers to the package API.
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
   - build a bundle from the verified runtime document plus its supplied asset
     bytes (`createStructBundle`),
   - encode it (`encodeStructBundle`),
   - decode it through the bytes-only API (`decodeStructBundle(rawBytes,
     { expectedBundleSha256 })`),
   - record the verified `documentSha256` / `bundleSha256` and asset digest
     conservation.
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

- No package `./bundle` at the current pin.
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

- Package `@erniesg/struct/recovery` owns source-neutral facts:
  `diagnosticCategory`, `recoveryFact`, the `StructRecovery`/`StructDiagnostic`
  shapes.
- App `src/struct-adapters/recovery.ts` owns presentation: `diagnosticCopy`
  titles/messages/actions, the enriched `recoverySummary` titles/summaries, and
  `userAction`.
- Do NOT replace the app copy with the package `recoveryFact` title derivation
  (`titleFromCode` produces different strings) or with the package default
  summary strings. That would change explanatory wording, serialized document
  bytes, and receipt hashes.
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

- Resolve imports semantically, not by raw specifier text. Production files
  outside `src/struct/` must not resolve to `src/struct` or its migrated-family
  re-exports (`types`, `ids`, `reading-order`), including barrel/index forms
  (`src/struct/index`, `src/struct/index.ts`), configured aliases
  (`@/struct`, `~/struct`, `#struct`, or equivalent), and the package barrel
  (`@erniesg/struct`). This also closes transitive re-exports from
  `src/struct-adapters/*` and `src/struct/from-reconstruction.ts` for those
  migrated families.
- The only explicit recovery allowlist is
  `src/struct/recovery.ts` importing `../struct-adapters/recovery` (plus its
  barrel/index/alias spellings) for recovery presentation only; every other
  production import resolving to a migrated family is rejected.
- Every `@erniesg/struct/...` specifier must be in the installed package export
  map (already enforced).
- No import of package-private paths.

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

Default recommendation: **narrow**, with a proof obligation.

- Keep `src/publication/struct-adapter.ts` as a deterministic
  `StructDocument -> PublicationGraph` projection used only for print/Vivliostyle
  rendering (`src/publication/renderers/vivliostyle.ts`).
- Add a conformance test that adapting one pinned StructDocument twice yields a
  byte-identical graph and that the graph is never persisted or treated as
  canonical text authority.
- Add a red-first static assertion/test that `PublicationGraph`,
  `publicationGraphSchema`, `serializePublicationGraph`, and any graph
  persistence/import/export helper are absent from storage, API, route, writer,
  and release modules; only renderer/projection modules may import them.
- Bind any publication receipt to the Struct `document`/`receipt` digests and
  the exact package pin; do not treat an independent graph digest as the
  semantic authority. Receipts must include the canonical Struct digests and
  exact package pin/version; graph-only digests are diagnostic only.
- If any of text, semantic IDs, persistence, receipt, writer, or release path
  proves load-bearing, retire the competing graph instead of renaming it.
- `ResearchPaper` stays a read-only compatibility model behind the existing
  facade `src/publication/research-paper-adapter.ts`; it is not removed in
  E-04. E-04 exit evidence must include a checked-in caller/test inventory for
  that facade (all callers and tests of `ResearchPaper` and adapter exports).

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
| E-04 | Dual-render output/failure parity; PublicationGraph ownership proof or retirement (including static absence from storage/API/route modules and receipts bound to Struct digests/package pin); EPUBCheck/Ace/human accessibility still app-owned; ResearchPaper facade `src/publication/research-paper-adapter.ts` inventoried with checked-in caller/test inventory |
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

## Plan validation

- This plan changes documentation only; it runs no dependency install, build, or
  test. `git diff --check` and path/reference verification are its validation.
- Runtime parity/boundary tests require the pinned artifact install
  (`node_modules/@erniesg/struct`), which is intentionally not performed for a
  planning-only change.

# E-03 Implementation Record — 2026-10-20

Owner: `erniesg/erniesg` (E-03 IMPLEMENTATION owner for `erniesg/struct` app cutover)
Branch: `feat/struct-e03-core-codecs-ids-order-20261020`
Worktree: `/home/ubuntu/.local/state/struct-migration/20261020-continuation/worktrees/app-e03-candidate`
Precondition: E-02 passed (`feat/struct-e03-core-codecs-ids-order-20261020` exists with commits).

## What was done
- Switched production imports exactly as the E-03 mapping table requires:
  - `types` family → `@erniesg/struct/document`
  - `ids` family → `@erniesg/struct/identity`
  - `reading-order` family → `@erniesg/struct/ordering`
  - `codec` family: adopted package `decodeCompatibleStructDocument` naming (no deprecated `migrateStructDocument` used in production)
- Production consumers switched (all non-test modules under `src/`):
  `src/publication/struct-adapter.ts`, `src/struct-adapters/from-reconstruction.ts`,
  `src/research/epub.ts`, `src/research/reconstruction-materialization.ts`,
  `src/research/reconstruction-attempt-trace.ts`, `src/research/grounded-epub-comparison.ts`,
  `src/research/grounded-struct-materializer.ts`, `src/research/grounded-struct-repair-applicator.ts`.
- The local portable MODULE implementations (`src/struct/types.ts`, `src/struct/ids.ts`, `src/struct/codec*`,
  `src/struct/reading-order.ts`) are kept physically unchanged; their tests remain green.
  `src/struct-adapters/recovery.ts` is NOT one of them and is NOT kept physically unchanged: at the guard state
  described in this section it is changed by 78 lines (`git diff --stat 5f8c76ab HEAD -- src/struct-adapters/recovery.ts`
  -> 34 insertions, 44 deletions; the same measurement holds at `64209924`). Exactly what changed in it is recorded
  under "Runtime recovery delegations and guard hardening" below.
  `src/struct-adapters/from-reconstruction.ts` is a CONSUMER of those families, not one of them: its imports were
  re-pointed at the package subpaths in this step, and its module body is otherwise unchanged.
- `src/research/epub.ts` `import type { StructDocument }` switched in E-03; renderer-branch switch (`../struct/xhtml` / `../struct/epub` → package renderers) stays in E-04 and was NOT done.
- `src/struct/recovery.ts` stays a compatibility forwarder to `src/struct-adapters/recovery.ts`; the app's enriched `recoverySummary` was NOT replaced by the package generic copy.
- `src/struct/codec*` local modules kept; no new production semantics added to retained copies.
- `src/struct/sha256.ts`, `src/research/sha256-sync.ts`, `legacyStructDigest`, model-consultation modules, and `src/struct/recovery.ts` were not migrated (per "Not migrated" list).

## Runtime recovery delegations and guard hardening (guard state at `7907acff`)

This section records the E-03 scope that the restack added on top of the dated candidate measurement recorded below.
It describes the guard state at the commit that introduced these cases, `7907acff` ("test(struct): close the E-03 guard
MDX, CommonJS, wrapper and render gaps"), which is the state of `tests/struct-adapter-boundary.test.ts` in the reviewed
tree. This record does not name a branch tip as the reviewed head, because the record's own commit moves it; the guard
commits included in the reviewed tree are the five listed under "Boundary-guard hardening" below, and each of them is an
ancestor of the branch that carries this record.

- **Category delegation** - source unit `554ce8e2` ("fix(struct): make the package recovery category authoritative at
  runtime"), replayed onto this branch as `0aef7178`. `src/struct-adapters/recovery.ts` imports the package runtime
  export (`:6-9`, `diagnosticCategory as packageDiagnosticCategory`), drops the local `category` column from all 37
  `DIAGNOSTIC_COPY` entries (`:37-241`) and from `FALLBACK_COPY` (`:243-249`) - both are now typed
  `AppDiagnosticCopy = Omit<DiagnosticCopy, 'category'>` (`:21`) - and turns the app facade into a delegation:
  `diagnosticCopy` derives the category from the package (`:261-267`), `diagnosticCategory` is
  `return packageDiagnosticCategory(code)` (`:269-271`), and the unknown-code default `UNKNOWN_CODE_CATEGORY` is read
  from the package (`:257-259`). The app keeps its titles, messages and actions; the package is the single runtime
  category authority.
- **Actionable-recovery delegation** - source unit `d192642d` ("fix(struct): delegate the actionable-recovery predicate
  to the package export"), replayed onto this branch as `4213ff4f`. The same file imports
  `hasActionableRecovery as packageHasActionableRecovery` (`:6-9`) and `hasActionableRecovery` is now
  `return packageHasActionableRecovery(recovery)` (`:414-418`); the old local `Boolean(recovery?.userAction)` rule is
  gone. The exported signature and the type guard `recovery is StructRecovery & { userAction: string }` are
  unchanged, so no app caller changes.
- **Boundary-guard hardening** - commits `a99a0f86` ("test(struct): add the E-03 guard red-first cases"),
  `36916381` ("test(struct): close the E-03 boundary guard gaps"), `5974df05` ("test(struct): guard the E-03 recovery
  authorities in the boundary test"), `e9009551` ("test(struct): close the E-03 guard alias and MDX gaps") and
  `7907acff` ("test(struct): close the E-03 guard MDX, CommonJS, wrapper and render gaps"). These five are the guard
  commits included in the reviewed tree. `tests/struct-adapter-boundary.test.ts` grows from 5 cases (386 lines) at the
  base, to 8 cases (689 lines) at `64e6774b`, to 13 cases (1053 lines) at `64209924`, to 15 cases (1215 lines) at
  `e9009551`, to 19 cases (1607 lines) at `7907acff`. The fourteen reviewed gaps are closed: aliased local imports
  resolved before skipping; package recovery-fact parity; project-root imports rejected; recovery-importer allowlist
  enforced; decoder/renderer validation split covered; MDX modules in the scan; nested local codec-family imports
  rejected; the dependency-override implementation record; computed dynamic imports rejected; CommonJS imports
  inspected; MDX ESM flow blocks collected wherever they appear in the document; computed CommonJS requires rejected;
  retained-tree wrapper re-exports traced; the package EPUB renderer and the app's own render paths exercised. The two
  (F14) assertions are in the file the plan names: the case
  "E-03: the production recovery module takes its category and actionable-recovery authority from the package"
  (`tests/struct-adapter-boundary.test.ts:1192-1239`) asserts both package runtime imports, the absence of any
  `category:` field in the app copy table, and that the app facade delegates instead of deciding either fact. The two
  new focused files `tests/struct-recovery-category-authority.test.ts` and `tests/struct-recovery-actionable-authority.test.ts`
  pin the behaviour.
- **Case inventory at `7907acff`** - the 19 cases of `tests/struct-adapter-boundary.test.ts`, in file order:
  "keeps one implementation and identity through the legacy and root exports"; "keeps one app-owned recovery
  implementation and legacy forwarding"; "keeps app recovery consumers on the app-owned path"; "keeps all implementation
  modules within their allowed import boundaries"; "rejects app reconstruction and private package imports in synthetic
  modules"; "E-03: prohibits migrated-family imports (types/ids/reading-order/codec) and validates package paths";
  "E-03: app diagnostic categories match package recovery facts"; "E-03: the production recovery module takes its
  category and actionable-recovery authority from the package"; "E-03: rejects project-root, nested-family, computed and
  CommonJS migrated-family imports"; "E-03: inspects MDX modules under src for migrated-family imports"; "E-03:
  collects every consecutive leading MDX import statement"; "E-03: rejects every spelling of the compatibility recovery
  forwarder"; "E-03: rejects a new production importer of the app-owned recovery module"; "E-03: enforces the app-owned
  recovery importer allowlist inside the retained tree"; "E-03: pins the decoder and renderer validation split for
  colliding emitted identifiers"; "E-03: the package EPUB renderer and the app render paths refuse colliding emitted
  identifiers"; "E-03: collects MDX ESM flow blocks wherever they appear in the document"; "E-03: rejects a computed
  CommonJS require"; "E-03: catches an external import of a retained-tree wrapper that re-exports a migrated family".
  The last four are the cases added at `7907acff`.
- **Plan status update** - `docs/superpowers/plans/2026-10-20-struct-full-cutover-sequence.md` carries one hunk, confined
  to the E-03 "Status at this head" bullet (`:479-518`): it records that the two source units above discharge the (F14)
  production-delegation clause, and that the E-03 stage row above it is unchanged and still PENDING as a stage gate.
- **Gate state - the E-03 stage gate is still PENDING and is not claimed here.** The plan's E-03 stage row
  (`docs/superpowers/plans/2026-10-20-struct-full-cutover-sequence.md:1892`) is unchanged: the package/local dual-read
  equality, the accepted/rejected input matrix, and the high-fan-in consumer enumeration and test are not produced by
  these commits and have not been accepted. The two delegations discharge the (F14) production-delegation clause only.
- **Measurement frames** - the app-suite numbers (318 files, 4986 tests) and the `astro check` result (0 errors, 279
  hints) recorded in "Not done / not in scope" below, and the red→green guard pair in "Static guard" above, are the
  dated CANDIDATE-frame measurements (the E-03 step and the candidate `ae4638ce`); they are not re-claimed for the guard
  state described in this section, and the whole app suite was not re-run at that guard state. The independent review of
  the earlier head ran the focused suites (`tests/struct-adapter-boundary.test.ts`,
  `tests/struct-recovery-category-authority.test.ts`, `tests/struct-recovery-actionable-authority.test.ts`,
  `src/struct/struct.test.ts`, `tests/struct-adapter-parity.test.ts`, `tests/struct-package-parity.test.ts`,
  `tests/struct-adapter-mapped-annotation.test.ts`, `tests/struct-adapter-inline-links.test.ts`,
  `tests/struct-adapter-inline-binding.test.ts`): 9 files, 87 tests, 0 failures, exit 0. That review is not re-claimed
  for the guard state described in this section. No CI result is claimed.
- **Guard measurements at `7907acff`** - `npx vitest run tests/struct-adapter-boundary.test.ts --maxWorkers=1
  --testTimeout=30000` reports 1 file, 19 tests, 19 passed, exit 0; `npx vitest run
  tests/struct-recovery-category-authority.test.ts tests/struct-recovery-actionable-authority.test.ts --maxWorkers=1
  --testTimeout=30000` reports 2 files, 11 tests, 11 passed, exit 0. No other suite was run and no CI result is
  claimed.

## Static guard (red → green)
- Added E-03 entry to `tests/struct-adapter-boundary.test.ts`.
- Red run recorded against a temporarily reverted import (`src/research/grounded-struct-materializer.ts` restored to `../struct/ids` and `../struct/types`): guard reported 2 violations (`migrated family import ../struct/ids` and `../struct/types`).
- Green run confirmed after restoring switched imports.
- The boundary guard was hardened on top of that red→green pair: the fourteen reviewed gaps, the two (F14) assertions
  and the cases added at `64209924`, `e9009551` and `7907acff` are recorded under "Runtime recovery delegations and
  guard hardening" above.
- The hardening at `7907acff` has its own red→green pair, measured against `e9009551`: the three new guard cases (MDX
  ESM flow blocks wherever they appear in the document, a computed CommonJS require, and an external import of a
  retained-tree wrapper that re-exports a migrated family) FAIL against the `e9009551` implementation (1 file, 19
  tests, 3 failed, 16 passed, exit 1) and PASS at `7907acff` (1 file, 19 tests, 19 passed, exit 0). The renderer case
  is red-first against a deliberate mutation of `src/struct/xhtml.ts` that drops the emitted-identifier assertion: the
  `e9009551` guard passes under that mutation (1 file, 15 tests, 15 passed, exit 0) and the `7907acff` guard fails (1
  file, 19 tests, 1 failed, 18 passed, exit 1). The mutation was reverted and is not part of the reviewed tree.

## Evidence tools (E-07 note)
- Evidence tools (`tools/srt-source-output-evidence.mjs`, `tools/pdf-epub-package-scan.mjs`, `tools/pdf-corpus-audit-lib.mjs`, `tools/pdf-association-fixture-audit.mjs`, `tools/model-consultation-evidence.ts`) keep working because local modules remain.
- The `/src/struct/ids.ts` load used by `tools/srt-source-output-evidence.mjs` will be migrated at E-07, not in E-03.

## Not done / not in scope
- No E-04/E-05/E-06/E-07 work performed.
- No renderer or publication-semantics cutover.
- No golden regenerated; no artifact repinned.
- No `npm publish`, no deploy, no writer/route change, no PR created, no push, no merge **by the E-03 implementation
  step**. The branch itself is carried by the coordinator's PR #454; this record does not name a PR tip, because the
  record's own commit moves it. Nothing in this record is merged, released or deployed.
- `astro check` passes (0 errors, 279 hints pre-existing).
- The repository's own app suite (`npx vitest run --exclude 'tests/e2e/**' --exclude 'tools/agent-evidence-budget.test.mjs' --maxWorkers=1`):
  318 files (316 passed, 2 skipped), 4986 tests (4969 passed, 17 skipped), exit 0 - no failures. The independent
  review of this candidate measured the same numbers at the same commit.
- **Known load sensitivity, stated plainly:** a SECOND recorded run of that identical command at this candidate
  reported one failing FILE - `src/research/grounded-struct-materializer.test.ts` - with
  `Error: Test timed out in 300000ms` on its `continues one #199 task through a rejected sibling to terminal
  promotion` case. That is a per-test timeout, not an assertion failure: the case exercises the materializer of
  `src/research/grounded-struct-materializer.ts`, one of the eight files re-pointed at the package subpaths in this
  step, and it runs close to vitest's 300 s per-test limit. The same file passes at the E-02 parent head and in the
  independent review's run, and the implementation of `structId`/`structDigest` in the package
  (`@erniesg/struct/identity`) is the same algorithm as the app's local `src/struct/ids.ts`, so the switch adds no
  new work per identifier. The failure was observed while several suites ran concurrently on one machine; it is
  recorded here rather than hidden, and no assertion was weakened to hide it.
- A bare `npx vitest run --maxWorkers=1` (which also collects the Playwright e2e specs, which the repository's script excludes) reports the e2e spec files as collection failures plus the `publication:build` symlink case, whose own setup fails when the gitignored `.agent/evidence/` directory does not exist yet in a fresh worktree. That invocation is not the repository's suite command and is recorded here only so the difference is not mistaken for a regression.
- `git status --porcelain` clean. **The change is not documentation-only and not limited to the import switches.**
  At the archived pre-restack E-03 candidate head `ae4638ce` (archived at
  `origin/archive/struct-e03-core-codecs-ids-order-20261020-pre-restack`; it was the tip of
  `feat/struct-e03-core-codecs-ids-order-20261020` at the time, and the candidate's parent before the E-03 content
  is `3f671e2b`) the branch carries **12 changed files, not 10**: the 8 production import
  switches, the guard extension, this dated record, **and the dependency-override pair** -
  `package.json` (+1 line: the root `overrides` entry `"vite": "8.1.6"`, at `package.json:177`) and
  `package-lock.json` (218 lines changed: 31 insertions, 187 deletions), both from commit `ae4638ce`
  "fix(deps): override vite to the patched 8.1.6 for the runtime audit gate". The lock was regenerated with
  `RUCKSACK_NPM_SHIM=passthrough npm install --package-lock-only --ignore-scripts` under npm 10.9.8.
  0 vendor / golden / expected changes. The PR branch `feat/struct-e03-core-codecs-ids-order-20261020` does **not**
  contain `ae4638ce` as an ancestor: that override content is already byte-identical
  on `main` (`5f8c76ab`; `package.json` blob `e39978fa68be8c703cf99fd1804aa05fe90da9f6` and `package-lock.json` blob
  `f16d1dc1f78403c1a5b39f7ac3a35907d9c3ef8a` are the same blobs in both), so
  `git diff 5f8c76ab HEAD -- package.json package-lock.json` is empty in the guard state described in this section
  (the same measurement holds at `64209924`) while the override itself is present
  in the tree. The dependency override is therefore part of the E-03 change's real scope in both frames.
  At the guard state described in this section the branch carries **14 changed paths** against `main` (`5f8c76ab`): the 8
  production import switches, `src/struct-adapters/recovery.ts`, the plan's E-03 status paragraph, this dated record,
  the boundary guard, and the two new focused authority test files - no manifest, lockfile, vendor, golden or expected
  file is among them. The guard commits and this record touch only the boundary guard and this dated record, both of
  which are already among those 14 paths, so the count is unchanged. The restack branch
  `feat/struct-e03-core-codecs-ids-order-20261021` is at `64e6774b`, an ancestor of the guard state described in this
  section.

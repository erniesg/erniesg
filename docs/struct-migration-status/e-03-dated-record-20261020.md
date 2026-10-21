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
  `src/struct/reading-order.ts`, `src/struct-adapters/recovery.ts`) are kept physically unchanged; their tests remain green.
  `src/struct-adapters/from-reconstruction.ts` is a CONSUMER of those families, not one of them: its imports were
  re-pointed at the package subpaths in this step, and its module body is otherwise unchanged.
- `src/research/epub.ts` `import type { StructDocument }` switched in E-03; renderer-branch switch (`../struct/xhtml` / `../struct/epub` → package renderers) stays in E-04 and was NOT done.
- `src/struct/recovery.ts` stays a compatibility forwarder to `src/struct-adapters/recovery.ts`; the app's enriched `recoverySummary` was NOT replaced by the package generic copy.
- `src/struct/codec*` local modules kept; no new production semantics added to retained copies.
- `src/struct/sha256.ts`, `src/research/sha256-sync.ts`, `legacyStructDigest`, model-consultation modules, and `src/struct/recovery.ts` were not migrated (per "Not migrated" list).

## Static guard (red → green)
- Added E-03 entry to `tests/struct-adapter-boundary.test.ts`.
- Red run recorded against a temporarily reverted import (`src/research/grounded-struct-materializer.ts` restored to `../struct/ids` and `../struct/types`): guard reported 2 violations (`migrated family import ../struct/ids` and `../struct/types`).
- Green run confirmed after restoring switched imports.

## Evidence tools (E-07 note)
- Evidence tools (`tools/srt-source-output-evidence.mjs`, `tools/pdf-epub-package-scan.mjs`, `tools/pdf-corpus-audit-lib.mjs`, `tools/pdf-association-fixture-audit.mjs`, `tools/model-consultation-evidence.ts`) keep working because local modules remain.
- The `/src/struct/ids.ts` load used by `tools/srt-source-output-evidence.mjs` will be migrated at E-07, not in E-03.

## Not done / not in scope
- No E-04/E-05/E-06/E-07 work performed.
- No renderer or publication-semantics cutover.
- No golden regenerated; no artifact repinned.
- No `npm publish`, no deploy, no writer/route change, no PR created, no push, no merge.
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
  At the reviewed E-03 candidate head `ae4638ce` (`feat/struct-e03-core-codecs-ids-order-20261020`, whose parent
  before the E-03 content is `3f671e2b`) the branch carries **12 changed files, not 10**: the 8 production import
  switches, the guard extension, this dated record, **and the dependency-override pair** -
  `package.json` (+1 line: the root `overrides` entry `"vite": "8.1.6"`, at `package.json:177`) and
  `package-lock.json` (218 lines changed: 31 insertions, 187 deletions), both from commit `ae4638ce`
  "fix(deps): override vite to the patched 8.1.6 for the runtime audit gate". The lock was regenerated with
  `RUCKSACK_NPM_SHIM=passthrough npm install --package-lock-only --ignore-scripts` under npm 10.9.8.
  0 vendor / golden / expected changes. The restacked branch `feat/struct-e03-core-codecs-ids-order-20261021`
  (head `64e6774b`) does **not** contain `ae4638ce` as an ancestor: that override content is already byte-identical
  on `main` (`5f8c76ab`; `package.json` blob `e39978fa68be8c703cf99fd1804aa05fe90da9f6` and `package-lock.json` blob
  `f16d1dc1f78403c1a5b39f7ac3a35907d9c3ef8a` are the same blobs in both), so
  `git diff 5f8c76ab 64e6774b -- package.json package-lock.json` is empty there while the override itself is present
  in the tree. The dependency override is therefore part of the E-03 change's real scope in both frames.

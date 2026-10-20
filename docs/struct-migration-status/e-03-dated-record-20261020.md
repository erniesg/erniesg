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
- Local portable modules (`src/struct/*`, `src/struct-adapters/*`) kept physically unchanged; their tests remain green.
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
- The repository's own app suite (`npx vitest run --exclude 'tests/e2e/**' --exclude 'tools/agent-evidence-budget.test.mjs' --maxWorkers=1`): 318 files (316 passed, 2 skipped), 4986 tests (4969 passed, 17 skipped), exit 0 - no failures.
- A bare `npx vitest run --maxWorkers=1` (which also collects the Playwright e2e specs, which the repository's script excludes) reports the e2e spec files as collection failures plus the `publication:build` symlink case, whose own setup fails when the gitignored `.agent/evidence/` directory does not exist yet in a fresh worktree. That invocation is not the repository's suite command and is recorded here only so the difference is not mistaken for a regression.
- `git status --porcelain` clean (only 10 changed files: 8 production import switches + 1 guard extension + 1 dated record; 0 vendor / golden / expected / lockfile changes).

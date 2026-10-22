# Site/Struct Stack Reconciliation Implementation Plan

**Date:** 2026-10-22
**Worktree:** app-pr440-stack-reconciliation
**Branch:** fix/site-struct-stack-reconciliation-20261022
**PR440 head (immutable):** 840540f2139e95cbe54b8270e191f3adb4f3cb38
**Actual main target:** 5f8c76ab56bb66730802d5bcd7ec5568e51585af (PR453)
**Merge base:** 74d483a04716af9dc46e2d3c390ecd242dcaff4c

## Accepted Oct 12 contract (supersedes September main / Papers naming)

- Site sections: Blog, Books, Research, Library, Projects. Experiments live under Projects.
- Production uses Blog + Research for now; Books/Library/Projects trees withheld from production until populated; `/library` 404 expected (not broken public demo).
- Canonical research routes preserved: `/research/`, `/research/representing-taste/`, `/research/struct/`, `/research/struct/demo/`.
- `/papers` permanently redirects (matching research) with no reverse prefix loop. Annotation document URI `/papers/<id>/` unchanged to avoid orphaned notes.
- Utility nav (About, Tags, latest implemented) preserved; docs state primary content vs utility accurately.
- Multilingual page/nav/samples/actual Struct preview preserved.
- Existing private upload bounds/quotas/expiry preserved.
- No new public visibility/access/deploy/D1 apply/secrets/new resources/autotranslation publisher activation.

## Actual file ownership (PR440 integration seams)

Owner: this WT. Seams:
- site/routes/demo/translation/gateway/docs: `src/pages/**`, `src/components/**`, `src/lib/**`, `src/research/**`, `src/worker/**` (struct demo), `astro.config.ts`, `src/consts.ts`, `src/lib/i18n.ts`, `src/lib/page-locales.*`, `src/lib/papers-listing.*`, `src/lib/struct-demo-*`, `tools/ia-redirects.*`, `tools/translation/*`, `docs/...`, `public/research/**`, `migrations/0005_struct_demo.sql`, `wrangler*.jsonc`.
- manifest lock ONLY if integration requires (`package.json`, `package-lock.json`, `tools/translation/runner-package*.json`).

NOT owned (do not edit/revert): other workers' review/demo/security/E03 guard seams. E04/E05 source must not be smuggled in.

## Dependency graph

- PR440 (840540f) base 74d483a + 23 commits.
- Main (5f8c76ab) = base 74d483a + 8 commits: governance workflows (#445), personal profile docs (#441), sharp/source-map-js audit fix (#437), trusted producer self-contained (#448), app-owned reconstruction adapter + frozen parity (#447), cutover sequence/authority inventories (#452), recovery presentation app-owned (#451), S-04 bundle repin + bundle parity (#453).
- PR454/455/456 will be merged later by coordinator (actual squash). Work against 5f8c76ab now; record dependency. Do NOT merge e41 candidate source SHA as main.

## Required checks (focused, not full expensive suite)

- scoped route/i18n/redirect/release-gate/struct demo client/worker tests
- source boundary/recovery import guards on integrated head
- locked dependencies/build production and staging as needed
- npm ci --ignore-scripts with RUCKSACK_NPM_SHIM=passthrough
- npm runtime audit (no ignore exceptions / threshold weakening / forced audit fix)
- keep new vendor pin from E02 (sharp/source-map-js security fixes)
- preserve multilingual + private upload bounds/quotas/expiry
- no generated translation rewrite outside necessary merge resolution

## Merge strategy

1. Merge origin/main (5f8c76ab) into branch preserving 840 parent/history.
2. Resolve conflicts: keep main's new package pin/bundle/recovery contracts; retain PR440 public website features/source assets/server boundaries.
3. Commit coherent merge + targeted fixes.
4. Never force push or edit original branch directly.

## Future integration notes

- E04 integrated (0e6a8bd2) and E05 (6b8c061e) readonly: inspect shared seams; final integration must preserve routes and demo code; dynamic tool loads/guards may need follow-up by E04 owner after 440 merge.
- Translation publisher transaction cleanup security finding: separate fresh security auditor owns readonly 840 findings; do not claim resolved until actual code checked.

## Outputs

- Report: /home/ubuntu/.local/state/struct-migration/20261020-continuation/app-pr440-stack-reconciliation-report.md
- Result: /home/ubuntu/.local/state/struct-migration/20261020-continuation/app-pr440-stack-reconciliation-result.json
- Scratch: /tmp/opencode/app-pr440-stack-reconciliation

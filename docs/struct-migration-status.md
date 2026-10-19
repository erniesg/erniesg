# Struct migration status — 2026-10-20

This is the current execution map, not a release or cutover record. The approved
[ownership ADR](superpowers/specs/2026-08-27-cross-repository-domain-ownership-and-package-boundaries.md)
and [issue plan](superpowers/plans/2026-08-27-cross-repository-architecture-issue-plan.md)
remain authoritative.

## Reviewed bases and preservation

- Ernie.SG default: `453fb256` (PR #447, app-owned reconstruction adapter and frozen parity).
- Struct default: `fae461e9` (MathML validation); its canonical checkout has unrelated
  PDF-service work and must not be reset to this default.
- App artifact: source `10116f4726da89ebabc823cb25706f2de5386f40`,
  SHA-256 `e18d743de5e2c8431b64a830974bd1180299f21cc8ab8cf70a9b184c36ab1374`.
  The exact pin in `vendor/struct/provenance.json` remains unchanged.
- Execution host: `erniesg-ai-vm`; laptop is a control interface. October 17
  preservation was verified by
  `/home/ubuntu/.local/state/erniesg-offload/20261017/SYNC-VERIFIED.json`.
  Recovery checkouts and archived refs are preservation sources, not merge inputs.
  The recovered Docling feature has unique unmerged commits; do not merge its
  mixed dirty snapshot or treat PDF feature branches as the landed package contract.
- Worktrees: `/home/ubuntu/code/erniesg/erniesg-migration-20261020` and
  `/home/ubuntu/code/erniesg/struct-migration-20261020`.

## Dependency order

| Work | Current evidence / remaining gate |
| --- | --- |
| E-01 #280, E-WF #281 | Closed; architecture and generated-workflow groundwork landed. |
| S-03 Struct #6 | Open. Private bundle/resolver work is in PRs #23/#24; public embedded-only surface is PR #33. PR #33 explicitly excludes the external executor, value verifier and full conformance harness. |
| S-04 Struct #7 | Open. Default packed-consumer proof establishes existing document subpaths, not complete Bundle acceptance. Re-run the full public negative matrix and deterministic goldens at the final integrated package head. |
| E-02 #282 | PR #447 landed adapter relocation and frozen source parity. PR #450 separately owns inline-hyperlink conservation. Bundle-through-adapter verification and complete S-04 proof remain open. |
| E-03 #283 | Not cut over. Recovery ownership preparation is behavior-preserving; it does not satisfy this issue. Switch types/codecs/identity/ordering/recovery facts only after E-02 passes. |
| E-04 #284 | Depends on E-03. Preserve ResearchPaper compatibility; converge PublicationGraph semantics deliberately. |
| E-05/#285, E-06/#286 | Durable publication design/activation remain separate; this work activates no writer or route. |
| E-07 #287 | Remove duplicates only after E-06, zero-import checks, parity and rollback proof. |

The older extraction/migration umbrella issues (#124, #206, #208, #256) are not
parallel invitations to redo landed work. Route concrete changes through the
ordered architecture issues above and record which acceptance criteria each
change actually proves.

## Cutover hazards found in review

- Replacing app recovery wholesale with package recovery changes explanatory
  wording, actions, serialized document bytes and receipt hashes. Preserve the
  app presentation seam and migrate source-neutral facts separately.
- The app codec currently enforces some renderer identifier constraints at
  document ingress; the package deliberately assigns renderer constraints to
  XHTML. Write an explicit accepted/rejected-input matrix before switching
  decoder authority. Positive document parity alone does not prove rejection
  parity.
- The frozen structured-DOCX failure on this base is already owned by PR #450,
  including the inline-link accounting and relationship-ID rebinding. Do not
  duplicate that fix or regenerate its golden in an unrelated branch.
- Raw SHA-256 helpers are not public package subpaths. Trace/reconstruction
  utilities may remain app-owned; do not import private package files or widen
  the public API just to make an import replacement mechanical.

## Offload contract

OpenCode on the VM is `/home/ubuntu/.opencode/bin/opencode`. The inspected model
is `opencode/deepseek-v4.1-flash-free`. Use explicit absolute worktree paths in
every task; a shell tool may start outside the process working directory.

Each worker receives one owned seam, immutable base, allowed files, exclusions,
commands, report path and no external-mutation authority. Initial app/package
audits are read-only. Implementation lanes own app recovery presentation and
the package byte-copy regression test separately. The coordinator alone pushes,
creates PRs and updates issues. Fresh sessions review immutable committed heads
and cannot initiate nested review. Raw model transcripts remain VM-local:
`/home/ubuntu/.local/state/struct-migration/20261020/`.

Use `pnpm import && pnpm install --frozen-lockfile --ignore-scripts` for a new
VM worktree, with the shared store. Do not commit generated pnpm lockfiles as
part of this migration preparation. Do not invoke a global formatter or change
the package artifact while refactoring an application import seam.

## Validation and rollback

Before implementation, the app package/artifact/adapter baseline passed 19 tests;
the explicit golden-regeneration test was skipped by design. Existing frozen
expected artifacts must not be regenerated to make a refactor pass.

Default Struct's 1 MiB copy regression test exceeded its five-second timeout both
in a full and serial suite. Direct `parseBytes` took 0.853 ms; a targeted test with
a diagnostic timeout took 4.67 s. Investigate assertion overhead without raising
the normal timeout, reducing the fixture, or weakening the enumeration guards.

Recovery ownership preparation passed 62 focused tests (one explicit fixture
regeneration test remained skipped). The moved implementation was compared to
the base and differs only in its type-import source. Struct's assertion fix
passed 325 tests, typecheck, source-boundary and clean packed-consumer checks;
independent exact-head review found no actionable defects at
`befe11c626dd142f896b7526cd16955c25c6e161`
([Struct PR #34](https://github.com/erniesg/struct/pull/34)).

Final integrated app validation and independent review are recorded in its PR.
A focused evidence manifest does not imply a full application build/test pass.
Keep all failed or blocked lanes explicit.

Before writer activation, rollback retains the current app writer, exact artifact
and local compatibility paths. Do not remove source fixtures or downgrade
durable records. No registry publication, deployment, merge-policy bypass,
external resolver activation or public visibility change is part of this task.

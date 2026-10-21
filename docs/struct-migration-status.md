# Struct migration status — 2026-10-20

This is the current execution map, not a release or cutover record. The approved
[ownership ADR](superpowers/specs/2026-08-27-cross-repository-domain-ownership-and-package-boundaries.md)
and [issue plan](superpowers/plans/2026-08-27-cross-repository-architecture-issue-plan.md)
remain authoritative.

## Reviewed bases and preservation

- Ernie.SG default: `453fb256` (PR #447, app-owned reconstruction adapter and frozen parity).
- Struct default: `fae461e9` (MathML validation); its canonical checkout has unrelated
  PDF-service work and must not be reset to this default.
- App artifact: source `3d3a7c95b1c55a9ff4b527eee5acf36c168cd896`,
  SHA-256 `836f6d3ead7a5ce1dc59f2799c80dfbe5c52931836a5b4f2749ab5b1920a55f9`
  (33 packed files, 368,119 uncompressed bytes). The exact pin in
  `vendor/struct/provenance.json` was updated to it by the atomic repin
  of the 2026-10-21 nested-lists-and-captions follow-up (Struct base for
  this delta: `119d0411edb525dc7cce2f0f80a5c2ab37f5d040`, the previous
  pin, which added the optional inline-code flag). The previous artifact
  (source `119d0411edb525dc7cce2f0f80a5c2ab37f5d040`, SHA-256
  `bb86a4bc192c2485f1029dee32964e5488e9277345dfb5a222d17fa3cfce6296`)
  is unchanged and still in `vendor/struct/`; it is no longer the pinned
  one. The artifact before it (source
  `90f76f1f80b037cc065169d07b13779c03420026`, SHA-256
  `42fee58e9b1e1888c53e929ad6367a2c128d1607140225387836ee5da53df8f1`)
  is unchanged and still in `vendor/struct/` too.
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
| E-02 #282 | PR #447 landed adapter relocation and frozen source parity. PR #450 separately owns inline-hyperlink conservation. The app is pinned to the reviewed S-04 artifact and the app-side bundle parity (create -> encode -> bytes-only decode with the asset digests conserved) is in place; the upstream S-04 release packet is measured at one immutable head. This is a candidate, not a landed cutover: no merge, no publication, no deploy and no route or writer activation has happened, and E-03/E-04/E-05/E-06/E-07 remain separate steps. |
| E-03 #283 | Source candidate on `feat/struct-e03-core-codecs-ids-order-20261020` (PR #454, head `9003ea76`): the types/codecs/identity/ordering/recovery facts are switched to the pinned package subpaths with a red-first semantic AST guard. Not merged; E-04 is stacked on it. |
| E-04 #284 | Source candidate on `feat/struct-e04-integrated-20261021` (base `9675feea`, the E-04 acceptance-repair base; the E-03 candidate head `9003ea76` is its ancestor). The portable renderer import cut is done (the app's StructDocument render branches use the pinned package renderers) and the PublicationGraph authority is converged: the graph is an ephemeral, Struct-derived renderer plan with no persistence, no receipt identity, no writer, no release path, no reverse writer and no annotation authority, proven by a compiler-checker guard that resolves a graph-bearing **value**, not only a graph-bearing name. **The non-Struct forward producer is retired**: `src/publication/research-paper-adapter.ts` and its test were deleted by `a2a2ee1d`, and the guard's allowlist entry for it was removed with it, so no non-Struct graph producer remains. `ResearchPaper` compatibility is preserved and the local compatibility copies `src/struct/{xhtml,epub,emitted-ids}.ts` are unchanged until E-07 (only `src/struct/struct.test.ts`, its stale reference assertion, changes). The recorded output changes (the package renderer's list rendering and furniture handling) are in [`docs/struct-migration-status/e-04-dated-record-20261020.md`](struct-migration-status/e-04-dated-record-20261020.md). The one inline-code span in the pinned production entry that the E-04 candidate reduced to plain text is **fixed**: the pinned Struct package carries an optional `code` flag on `StructInline`, the app ingress keeps the span and the publication projection maps it onto the existing `inlineCode` field, so the published output carries `<code>main</code>` again. The app is now pinned to Struct head `3d3a7c95b1c55a9ff4b527eee5acf36c168cd896` (the nested-lists-and-captions follow-up, repinned by `993c0d3a`): the pinned renderer publishes the declared list contract and publishes an attached caption exactly once, inside the host's `<figcaption>`. The frozen baselines and the both-mode parity evidence were **re-frozen and re-measured** against that pin (§2.4 of the same record; the re-freeze is `3b48976b`): the two overloads now agree over the common supported semantic domain, and the only difference the comparison still reports is the inline-code mark, which is a scoped model boundary of the deprecated legacy model. EG-13 is recorded as **PARTIAL**, not met: the corpus is a pilot and the uncovered constructs are still uncovered. The release path now verifies the mandatory semantic receipt digest and all five package-identity fields against the trusted pin, and decodes the receipt-bound `struct-bundle.bin` (the receipt/admission lane `90e3edd7`); the published documents come from the pinned package renderers (the renderer lane `03dd4b9c`). §6 of the dated record carries the refreshed gate statuses at this head. This is a candidate, not a landed cutover: no merge, no deploy, no writer or route activation, and the Payload-Lexical publication path was retired with its coverage loss recorded. The independent review of the integrated head returned two actionable documentation findings; both are addressed by the companion documentation unit `docs/struct-e04-record-refresh-20261021`, which refreshes the checked-in `ResearchPaper` caller inventory and §6 of the dated record. A gate status in that record is a dated measurement, not an acceptance. |
| E-05 #285 | Durable editorial publication: the design record and the record/state-machine contract are implemented on `feat/struct-e05-editorial-records-20261020` behind an INACTIVE gate; the production writer and the public route are unchanged. The authenticated producer record, the trust contract and the inactive writer/route adapter follow as separate jobs. |
| E-06/#286 | Activation remains separate and unauthorized: it needs an accepted E-ACT receipt, and this work activates no writer or route. |
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

For an Ernie.SG VM worktree, keep the shared pnpm store while using physical
package directories required by PDF provenance:

```sh
pnpm import
CI=true pnpm install --node-linker=hoisted --frozen-lockfile --ignore-scripts
node tools/publication-install-browser.mjs
```

The isolated linker (including `--shamefully-hoist`) leaves a symlink at
`node_modules/pdfjs-dist`; `packageContentsIdentity` deliberately rejects that
root. The hoisted linker uses real package directories without weakening the
provenance guard. Use `npm run` or direct `node_modules/.bin` commands after
setup: pnpm's automatic dependency verification can reset an explicitly chosen
layout when invoked without matching configuration. The browser setup restores
the repository's pinned publication cache after the script-free install.

Do not commit generated pnpm lockfiles as part of this preparation. Do not
invoke a global formatter or change the package artifact while refactoring an
application import seam.

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

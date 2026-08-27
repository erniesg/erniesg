# Cross-repository architecture review evidence

This record makes the reviewed architecture context reproducible for the sole external-mutation coordinator. It does not authorize a package publication, deployment, merge, visibility change, or bypass of a target-specific action gate.

## Exact repository evidence

| Repository | Exact remote default used for final delivery |
|---|---|
| `erniesg/rucksack` | `2513b7a76ad50e9751101454054bf1120cb1983e` |
| `erniesg/erniesg` | `c7a706ecbac1a527cad11a3246e602bd56636d6f` |
| `erniesg/struct` | `6ecb78d1753b847ec7295bf45f43237225663728` |
| `erniesg/aether` | `f8643bee4819afa465be3e32fdd63788566987e6` |

The relevant executable source/test gate is zero files over 3,000 physical LOC in the three original repositories: Rucksack 0/579, Ernie.SG 0/604, and Struct 0/30. Rucksack advanced from the architecture-assessment baseline `9284e95430bb1556d8614427ca05e553d9930dc9` to `2513b7a7`; that ancestor range was independently audited as one narrow Evidence Lab OCR-ambiguity hold affecting four browser/test files, with no architecture-boundary impact.

## Reviewed product-contract inputs

| Product | Local reviewed head | Use |
|---|---|---|
| Struct | `444317b64b72dbce6c0c0409716fb6a20e810b4d` | Source-neutral semantic contract and deterministic XHTML/EPUB boundary |
| Ernie.SG | `a45128c13839b7d5093ef7ba5e30790903007ed8` | Owner-first reconstruction, editorial, publication, and public-delivery framing |
| Aether | `860e60fd3791a8220b694bc53cc5a2e442cabfd2` | Optional downstream composition contract; manual reconciliation required |

These heads are evidence inputs, not remote branches to push or commits to merge wholesale.

## Artifact history

| Artifact | Initial reviewed SHA-256 at `d277971` | First PR repair SHA-256 at `d657be7` | Current review-repair SHA-256 |
|---|---|---|---|
| `docs/superpowers/specs/2026-08-27-cross-repository-domain-ownership-and-package-boundaries.md` | `7778a727fdd9fa4652bfdb71cd571e3402b6c42ff7a8e07824b477b6a5497f78` | `a6fa64dde853d58f3f2291a2c232b9d45cb1e1d53b4ef205f85551b46a21282d` | `6e5e0e29bb8ef916714b638af5e8134dcb31424beb9386a07c73d1f6ffd71a74` |
| `docs/superpowers/plans/2026-08-27-cross-repository-architecture-issue-plan.md` | `667db6ac6063751fef3cc6f6c2addc6eee132025ba433278bd43075e1f64410f` | `ece2d576ac20c382791cd88ab551faf4466e87a78e95d0e759bd94011adb335a` | `4a2502b2e288d23e22d421ead5f85d0b5050d7a7612612bb23bbfae1da9760d3` |
| `docs/superpowers/plans/2026-08-27-cross-repository-architecture-issue-map.json` | `3c4245ac24443b9e138959afecbcb8c41d0dc3b2dab775d997605d82421f7e53` | `19a8146d02b2c0c17906d17f32b62c4ff5fc614a3943af9e87c6c6ccc3f406c2` | `771f9295bf9a506ce7d2b375610179a279d0abd40807367a93744bcba6252411` |

The initial ADR and issue plan were byte-for-byte copies of the final pre-PR reviewed local artifacts. Independent fresh-context architecture, security, dependency-order, and exact-head evidence passes repaired every actionable P0–P2 finding through `d277971`. Commit `d657be7` recorded the first PR review repair. The current hashes add the supervisor-enforced one-shot resolver state machine, the full issue-plus-decision-gate order, the mandatory coordinator reconciliation for already-created Struct #5, and corrected GFM evidence tables; they require another fresh exact-head review before push/merge.

## Issue-creation contract

The machine-readable map is `docs/superpowers/plans/2026-08-27-cross-repository-architecture-issue-map.json`. It contains the durable identities of all 25 coordinator-created GitHub issues and three coordinator-owned non-issue decision gates. The mandatory phase-0 documentation landing order is Struct `S-01`, then Ernie.SG `E-01`, then manually reconciled Aether `A-01`; Struct/Ernie.SG/Aether runtime work remains blocked until that spine lands.

The user's explicit `go` authorized the sole coordinator to persist the reviewed context, push the reviewed documentation commits, and create/link the mapped GitHub issues after rechecking exact remote bases. The coordinator completed that planning mutation on 2026-08-27: Struct #4–#7, Ernie.SG #280–#287, Aether #182–#183, and Rucksack #674–#684. It did not authorize this task to mutate remotes and did not authorize implementation, package publication, deployment, merge, printer contact, E-ACT, A-REQ, or A-ACT.

## Local branch and validation

- Repository: `erniesg/erniesg`
- Branch: `codex/cross-repo-architecture-adr`
- Exact base: `c7a706ecbac1a527cad11a3246e602bd56636d6f`
- Lane: portable documentation
- Remote mutations performed by this task: none

Exact-base setup evidence:

- `npm ci`: exit 0; 1,384 packages audited; 0 vulnerabilities.
- Baseline `npm run test`: 3,922 passed, 6 skipped, 1 failed. The sole failure is the known environment limitation that EPUBCheck cannot locate a Java runtime in `tools/publication-adapter-conformance.test.mjs`; no architecture files had been added when this baseline was run.

Architecture-package evidence:

- Initial architecture commit: `a381e0a2d9cdcceb3aa869cee13b230bf2639637`, whose parent is the exact Ernie.SG default above.
- Initial JSON parsing and map checks at `d277971`: passed; 25 unique issue keys and three unique decision-gate keys.
- PR #279 repair map checks: JSON parses; all 25 issues have unique durable GitHub identities; the full 28-node order contains all 25 issues plus E-ACT, A-REQ, and A-ACT and respects every dependency; E-ACT has a structured fail-closed admission condition before E-06. The original GitHub creation order is retained only as completed history. A live read-only GitHub check found zero title, URL, or recorded-open-state mismatches across all 25 issues. Struct #5 remains execution-blocked until the coordinator replaces its d277-only body using the exact promoted-repair template in the plan.
- GFM rendering validation: the installed GFM parser and Markdown-to-HTML pipeline rendered exactly three tables with uniform row widths of 2, 3, and 4 columns respectively.
- `git diff --check`: passed.
- Promoted-document hash verification: passed at the exact hashes recorded above.
- Commit-time secret scan: passed.
- Repository evidence manifest: `.agent/evidence/20260827T031310363Z/manifest.json`, produced against the clean initial architecture commit.
- Required association-audit and model-consultation lanes: passed.
- Required build lane: failed after the Astro build completed 132 pages successfully, when `publication:check` could not run EPUBCheck because this host has no Java runtime.
- Required test lane: 3,922 passed, 6 skipped, and the same one Java-dependent publication-adapter test failed as on the untouched base.

The repository evidence command therefore returned its honest `failed` classification rather than masking the host limitation. The documentation-only diff introduces no executable path and reproduces the exact-base test result. Independent exact-commit review covered `d277971422476ff7683392c1254267ceb63c6fe4`; the first PR review repair landed locally at `d657be7dab522df35e773754bb117ee670bdcf38`. Fresh exact-head review of `d657be7` then identified reusable-start/revocation, decision-gate ordering, already-created #5 drift, and two GFM delimiter findings. This follow-up repairs all five while retaining the prior cleanup, authorization-history, and phase-zero intentions. The coordinator must obtain another fresh exact-head review and revalidate remote defaults/open work before pushing or merging this follow-up or performing the recorded #5 reconciliation.

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

## Exact promoted artifacts

| Artifact | SHA-256 |
|---|---|
| `docs/superpowers/specs/2026-08-27-cross-repository-domain-ownership-and-package-boundaries.md` | `7778a727fdd9fa4652bfdb71cd571e3402b6c42ff7a8e07824b477b6a5497f78` |
| `docs/superpowers/plans/2026-08-27-cross-repository-architecture-issue-plan.md` | `667db6ac6063751fef3cc6f6c2addc6eee132025ba433278bd43075e1f64410f` |

The promoted ADR and issue plan are byte-for-byte copies of the final reviewed local artifacts. Independent fresh-context architecture, security, dependency-order, and exact-head evidence passes repaired every actionable P0–P2 finding. The final contract pass found no actionable P0–P2 defect, and the final evidence-only head update received a separate clean review at the exact hashes above.

## Issue-creation contract

The machine-readable map is `docs/superpowers/plans/2026-08-27-cross-repository-architecture-issue-map.json`. It contains 25 proposed GitHub issues and three coordinator-owned non-issue decision gates. The mandatory documentation landing order is Struct `S-01`, then Ernie.SG `E-01`, then manually reconciled Aether `A-01`.

The user's explicit `go` authorizes the sole coordinator to persist the reviewed context, push the reviewed documentation commits, and create/link the mapped GitHub issues after rechecking exact remote bases. It does not authorize this task to mutate remotes, and it does not authorize implementation, package publication, deployment, merge, printer contact, or runtime activation beyond the map's later gates.

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
- JSON parsing and map checks: passed; 25 unique issue keys, three unique decision-gate keys, and all 25 issue keys occur once in a dependency-respecting creation order.
- `git diff --check`: passed.
- Promoted-document hash verification: passed at the exact hashes recorded above.
- Commit-time secret scan: passed.
- Repository evidence manifest: `.agent/evidence/20260827T031310363Z/manifest.json`, produced against the clean initial architecture commit.
- Required association-audit and model-consultation lanes: passed.
- Required build lane: failed after the Astro build completed 132 pages successfully, when `publication:check` could not run EPUBCheck because this host has no Java runtime.
- Required test lane: 3,922 passed, 6 skipped, and the same one Java-dependent publication-adapter test failed as on the untouched base.

The repository evidence command therefore returned its honest `failed` classification rather than masking the host limitation. The documentation-only diff introduces no executable path and reproduces the exact-base test result. An independent exact-commit review must cover the immutable branch head and accompany coordinator handoff. The coordinator must revalidate remote defaults and open work before push or issue creation.

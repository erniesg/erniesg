# Struct package parity implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prepare the exact Struct dependency and frozen core parity evidence needed for the issue #282 → #283 consumer cutover.

**Architecture:** Build a private, immutable artifact from the standalone Struct repository and pin its bytes in Ernie.sg. Compare public package APIs against the existing application implementation before switching production imports. Keep source adapters, recovery presentation, current writers and renderers in Ernie.sg during this preparation.

**Tech Stack:** TypeScript, Vitest, npm pack, SHA-256/SHA-512 lockfile integrity.

**Spec:** `docs/superpowers/specs/2026-08-27-cross-repository-domain-ownership-and-package-boundaries.md`; E-02/E-03 in `docs/superpowers/plans/2026-08-27-cross-repository-architecture-issue-plan.md`.

## Global constraints

- Application base: `0e37f441d158aae8ae7ed5c7a172004d786aff11`.
- Struct base: `f662957a19ba7f63d5c7256f6b343243e9ced8b4`; the packed public-export regression must be fixed and independently reviewed before final artifact generation.
- Consume only declared `@erniesg/struct` exports. No sibling repository/source-path dependency.
- Legacy `0.1.0` and current `0.2.0` remain readable; no writer activation or schema transformation.
- No publication, deployment, visibility change, source deletion or production cutover in this preparation PR.
- Issue #282 remains incomplete until the Struct Bundle and complete source-fixture verification gates pass. This PR must not close #282 or #283.

## Review focus

- Packed exports drift from the API manifest: exact clean-consumer check must fail.
- Artifact bytes change without a new provenance pin: digest and lockfile checks must fail.
- Legacy locale-dependent digests lose compatibility: frozen legacy document must decode unchanged.
- Recoverable document data or receipt counts change: canonical wire and digest parity must fail.
- Unsupported versions or tampered receipts become accepted: both decoders must reject.

### Task 1: Repair the Struct packed boundary (Struct #7)

**Files:** Struct `src/renderers/xhtml.ts`, private MathML helper/tests as necessary.
**Interface:** Preserve the sole public XHTML runtime export `renderPublicationXhtml` and existing rendering behavior.

- [x] Reproduce `npm run test:package` failing on undeclared `safeMathMl`.
- [x] Keep the helper private without weakening MathML validation coverage.
- [x] Run unit/type/source-boundary and clean packed-consumer checks.
- [x] Commit and obtain independent exact-head review; open a PR referencing Struct #7.

### Task 2: Freeze the core compatibility pilot

**Files:** `tests/struct-package-parity.test.ts`, `tests/fixtures/struct-package-parity/**`.
**Interface:** Public document, identity, ordering and receipt package subpaths; existing local implementations supply the frozen baseline.

- [x] Pilot 3–5 legacy/current/recoverable fixtures; inspect mismatches before expansion.
- [x] Freeze baseline JSON and expected canonical/identity/receipt results.
- [x] Test strict decode/encode, supported-version reads, stable IDs/order and invalid receipt/version rejection through public exports.
- [x] Report all parity gaps without changing expected semantics to hide failures.

### Task 3: Pin and verify the artifact

**Files:** `vendor/struct/**`, `package.json`, `package-lock.json`, `tests/struct-package-artifact.test.ts`, migration evidence documentation.
**Interface:** Exact `file:` artifact dependency, standalone repository commit and tarball SHA-256, npm lockfile SHA-512.

- [x] Generate the artifact from the reviewed producer commit and record provenance/build commands.
- [x] Pin the artifact and lockfile; verify a clean install needs no sibling checkout.
- [x] Test byte integrity, version/export contract, provenance and frozen parity.
- [ ] Commit the integrated head; run `scripts/agent-evidence` on the clean tree.
- [ ] Obtain fresh independent exact-head review; open an issue-linked preparation PR with remaining gates explicit.

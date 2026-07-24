# PDF Eval Promotion Hardening Implementation Plan

> **Security amendment:** Review proved that adapter-supplied executable and
> checkpoint hashes are self-attestation, not independent verification. This
> final plan supersedes the earlier proposal that allowed an `attested` adapter
> response to promote.

**Goal:** Keep the public PDF fidelity evaluation useful for deterministic
calibration without allowing imported or adapter-self-reported evidence to be
mistaken for release promotion proof.

**Architecture:** Preserve the frozen `benchmarks/pdf/fidelity-eval-v1.json`
and predictions contract. Receipt `1.2.0` records the authority for runtime
identity claims, keeps `promotionEligible` reserved false, and lets comparison
report score deltas without passing promotion. A future trusted runner requires
a new versioned contract.

## Constraints

- Do not modify the frozen v1 gold manifest.
- Keep source PDFs and raw model outputs owner-local.
- Verify input hashes and transitive adapter source before execution.
- Treat offline environment variables as cooperative controls, not an OS
  network sandbox.
- Reject pre-1.2 receipts from promotion comparison.
- Do not add a positive promotion path until the executable, checkpoint, and
  isolated execution environment are independently verified outside the
  adapter process.

## Completed tasks

- [x] Separate `external-predictions` calibration from local execution.
- [x] Add `promotionEligible` to hashed receipts and comparison policy.
- [x] Add `execution.runtimeIdentityAuthority` with only
  `not-applicable` and `adapter-self-reported` accepted today.
- [x] Make `promotionEligible` a schema-level constant `false` in receipt
  `1.2.0`.
- [x] Keep local output useful by writing normalized predictions and a
  sanitized receipt before returning a nonzero non-promotion status.
- [x] Reject fabricated `runner-verified`, missing provenance, unknown lanes,
  and pre-1.2 promotion receipts in tests.
- [x] Document that the public v1 suite is calibration, not a blinded holdout.

## Verification

```bash
npx vitest run tools/pdf-fidelity-eval.test.mjs
npx prettier --check \
  tools/pdf-fidelity-eval.mjs \
  tools/pdf-fidelity-eval.test.mjs \
  docs/schemas/pdf-fidelity-eval-receipt.schema.json \
  docs/research/semantic-responsive-typesetting/fidelity-eval-set.md \
  docs/superpowers/specs/2026-07-23-pdf-eval-promotion-hardening-design.md \
  docs/superpowers/plans/2026-07-23-pdf-eval-promotion-hardening.md
git diff --check
```

Expected: evaluator tests pass, formatting is clean, and no current receipt or
comparison reports promotion success.

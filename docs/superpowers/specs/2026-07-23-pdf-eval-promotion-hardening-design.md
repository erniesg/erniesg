# PDF eval promotion hardening

## Scope

Harden the existing PDF fidelity receipt policy without changing the frozen
`benchmarks/pdf/fidelity-eval-v1.json` gold manifest. The change is limited to
the evaluator, its receipt schema and tests, and the evaluator documentation.

## Lane semantics

The existing `execution.lane` is the explicit mode boundary:

- `external-predictions` is an imported-predictions, public calibration mode.
  Its top-level `passed` value remains the result of the scoring policy, but it
  is never promotion evidence.
- The exact `local-mac` lane verifies private input hashes and adapter source,
  but the current adapter protocol self-reports the tool/model runtime. It is
  therefore calibration-only. Unknown lane names and non-Darwin development
  runs fail closed and cannot become promotion-eligible.

## Receipt and comparison contract

Add a required top-level `promotionEligible` boolean and an explicit
`execution.runtimeIdentityAuthority`, and bump the receipt schema version to
`1.2.0`. The accepted authorities are `not-applicable` and
`adapter-self-reported`; `promotionEligible` is reserved `false`. The receipt
validator recomputes both `promotionEligible` and `passed` and rejects older
promotion contracts.

An imported receipt may still have `passed: true` for development calibration.
Local runs write their score receipt and predictions but have `passed: false`.
Comparison still reports deltas, while promotion remains closed until an
external trusted runner can independently verify the executable, checkpoint,
and execution environment.

## Tests and documentation

Tests establish that imported perfect predictions remain scoreable, that local
adapter assertions remain non-promotable, that a fabricated
`runner-verified` authority is rejected, and that no current candidate can pass
a promotion comparison. Local-run fixtures may emit tool/model identities, but
the receipt labels their authority as adapter-self-reported.

The evaluator guide will label the public manifest and imported lane as
development calibration only, state the local promotion requirements, and
reserve blinded claims for a future private holdout with isolated execution.

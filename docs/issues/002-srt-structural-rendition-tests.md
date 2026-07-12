# SRT structural rendition tests and manifest contract

depends-on: 001

## Provider

vm-codex

## Goal

Make rendition correctness machine-verifiable across every target before pagination and annotations are implemented.

## Acceptance tests

- Define and validate a versioned layout-manifest schema.
- Every mandatory canonical node appears exactly once or as explicitly recorded fragments.
- IDs, content hashes, figure-caption links, and provenance survive every rendition.
- Manifest entries record target, chosen variant, geometry or flow position, and diagnostics.
- Tests fail on silent omission, duplication, relationship loss, and unexplained fallback.

## Validation command

```bash
npm test
npm run build
```

## Allowed secrets

None.

## Artifact outputs

Manifest schema, structural assertions, fixtures, and tests.

## Stop conditions

Stop if the manifest would require target geometry in canonical source data.

## Human clarification protocol

Request a decision only when two manifest representations cannot be made backward-compatible.

## Recommended response

Use JSON with stable field ordering in snapshots and explicit diagnostic codes.

## Trade-offs

More manifest detail improves explainability but increases snapshot churn; version the contract and test invariants more strongly than formatting.

## Free-form response

The manifest is evidence, not the document source of truth.

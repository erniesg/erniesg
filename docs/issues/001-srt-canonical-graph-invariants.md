# SRT canonical graph invariants and golden fixture

## Provider

vm-codex

## Goal

Freeze the minimum Semantic Responsive Typesetting graph contract and turn the existing paper JSON into a trustworthy golden fixture before adding layout complexity.

## Acceptance tests

- Every node ID is unique and stable.
- Every relationship target exists; the current figure-caption relationship is represented without a dangling `cap-pipeline` reference.
- A deterministic content hash excludes target geometry.
- Schema validation rejects duplicate IDs, dangling relationships, invalid heading levels, and target coordinates in canonical content.
- Add an ADR describing the canonical graph and explicit non-goals.

## Validation command

```bash
npm test
npm run build
```

## Allowed secrets

None.

## Artifact outputs

Validated golden article fixture, focused tests, and canonical-schema ADR.

## Stop conditions

Stop for human review before a schema-breaking choice that changes the PRD's JATS-inspired graph direction or requires selecting a differently licensed source article.

## Human clarification protocol

Open a GitHub decision comment with the competing schema choices and recommend the smallest backward-compatible option.

## Recommended response

Keep the existing synthetic article for the first invariant tests and record real JATS ingestion as later work.

## Trade-offs

A narrow schema delays broad document support but makes every later rendition mechanically comparable.

## Free-form response

Do not add PDF ingestion, arbitrary equations, collaboration, or generative layout in this issue.

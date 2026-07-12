# SRT target overrides and export package

depends-on: 006

## Provider

vm-codex

## Goal

Add isolated target-specific overrides and produce inspectable print and reflowable export artifacts without mutating canonical content.

## Acceptance tests

- One print-only override changes only the A4 rendition.
- Override provenance and layout-version impact are recorded.
- Export package includes paginated PDF, reflowable HTML/EPUB-oriented output, source graph, and layout manifests.
- Export verification confirms stable IDs, complete content, relationships, and annotation targets.
- Rebuilding the same input and configuration is deterministic within documented limits.

## Validation command

```bash
npm test
npm run build
scripts/agent-evidence --all
```

## Allowed secrets

None.

## Artifact outputs

Override contract, export commands, PDF/reflowable artifacts, manifests, and checksums.

## Stop conditions

Stop before adding InDesign/Illustrator round-trip or a production CMS.

## Human clarification protocol

Ask for approval if an export dependency introduces licensing, hosted-service, or non-reproducible requirements.

## Recommended response

Prefer local deterministic export tooling and document known fidelity gaps.

## Trade-offs

HTML-first exports maximize reuse; exact print fidelity may require a constrained paged-media dependency.

## Free-form response

Generated exports belong in evidence storage unless explicitly selected as fixtures.

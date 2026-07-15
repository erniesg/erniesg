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

## Implemented export contract

Run `npm run srt:export` to build inspectable packages under
`.agent/evidence/srt-export/research/<paper-id>/exports/`. Each package contains:

- `print.pdf`: a deterministic A4 PDF whose page tree follows the print layout manifest;
- `reflowable.html` and `publication.epub`: the reflowable fidelity references;
- `source.json`, `layout-manifest.json`, and `annotations.json`: canonical content,
  rendition decisions, override provenance, and semantic annotation selectors;
- `export-manifest.json` and `checksums.sha256`: configuration, documented
  determinism limits, per-file metadata, and SHA-256 checksums.

The default export applies exactly one `print` override to `fig-pipeline`. Its
source/reason, version, target, canonical node selector, patch, target-local
digest, and resulting layout version are recorded. The mobile and both e-ink
renditions retain their baseline manifests byte-for-byte.

Package construction fails closed unless source IDs/content, graph
relationships, annotation targets, PDF page count, EPUB/HTML IDs, file metadata,
and checksums verify. Rebuilds are byte-identical when canonical content,
annotations, overrides, policies, dependency versions, and compatible runtime
encoding remain fixed. EPUB timestamps and PDF dates come from fixed/canonical
inputs rather than the wall clock.

The PDF intentionally uses the repository's deterministic estimated pagination
and built-in font metrics; it is inspectable but does not promise browser-exact
font shaping. HTML and EPUB remain the reference outputs for complete reflowable
text. Generated files stay in ignored evidence/build storage, not source control.

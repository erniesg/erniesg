# Extract figures, captions, tables, and equations into real EPUB assets

depends-on: 012

## Provider

vm-codex

## Goal

Extract or render scholarly visual objects, associate captions and notes with evidence, and package usable figure, table, and equation renditions instead of placeholders or flattened prose.

## Acceptance tests

- Locate raster images, vector drawing regions, charts, diagrams, table regions, and display equations with source bounding boxes and stable asset hashes.
- Preserve an embedded raster/vector asset when safe; otherwise render only the bounded region at a documented resolution rather than rasterizing the full paper.
- Match Figure/Fig./Table/Equation captions using label sequence, region/column scope, distance, typography, cross-references, and confidence.
- Emit canonical figure/caption relationships; unresolved and competing candidates fail the completeness gate rather than being guessed.
- Reconstruct a table as semantic HTML only when row/column structure passes validation; otherwise use a sharp image fallback with caption and source provenance.
- Preserve MathML when available; otherwise use an SVG/image fallback without inventing LaTeX or labels.
- Package every selected asset in the EPUB manifest and verify there are no dangling references, placeholders, or silently discarded source objects.
- Alt text uses source text/caption evidence; optional generated descriptions must be marked and may not replace source labels.
- Synthetic and redistributable fixtures prove figure/caption, multi-panel, table, vector diagram, and equation fallbacks.

## Validation command

```bash
npm test
npm run build
npm run test:e2e -- tests/e2e/publication-importer.spec.ts
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None. No hosted vision or OCR service is required for the deterministic baseline.

## Artifact outputs

Visual-region extractor, asset store/manifest, caption association graph, table/math fallbacks, EPUB packaging, fixtures, and structural/visual evidence.

## Stop conditions

Stop before hallucinating alt text or diagram labels, committing unlicensed source assets, silently substituting a low-resolution page screenshot, or accepting an orphaned caption/asset.

## Human clarification protocol

For an ambiguous object boundary or caption match, report the candidate boxes, confidence features, and smallest explicit review interaction.

## Recommended response

Prefer source-preserving extraction, use bounded rendering as the reversible fallback, and make every association inspectable in the canonical graph.

## Trade-offs

Semantic tables and vector preservation improve accessibility but are fragile; a declared high-resolution visual fallback is safer than confidently emitting the wrong structure.

## Free-form response

The local corpus contained papers with hundreds of image operations; every current EPUB packaged zero image assets.

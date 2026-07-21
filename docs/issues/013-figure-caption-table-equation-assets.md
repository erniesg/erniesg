# Extract figures, captions, tables, and equations into real EPUB assets

depends-on: 012

## Provider

vm-codex

## Goal

Extract or render scholarly visual objects, associate captions and notes with evidence, and package usable figure, table, and equation renditions instead of placeholders or flattened prose.

## Acceptance tests

- Locate raster images, vector drawing regions, charts, diagrams, table regions, and display equations with source bounding boxes and stable asset hashes.
- Preserve an embedded raster/vector asset when safe. A multi-fragment diagram may be composed only from one validated connected bounded component set, with every source object represented in a self-contained asset. The PDF.js canvas-factory path may render only the bounded source region at a documented resolution in browser or headless Node; blank, near/full-page, counterfeit, or incomplete-lineage crops remain unresolved.
- Match Figure/Fig./Table/Equation captions using label sequence, region/column scope, distance, typography, cross-references, and confidence.
- Emit canonical figure/caption relationships with complete caption provenance and meaningful canonical placement; unresolved, incomplete, and competing candidates fail the completeness gate rather than being guessed.
- Reconstruct a table as semantic HTML only when aligned multi-row/multi-column structure passes validation. A nonsemantic or nonuniform table uses a sharp bounded image fallback only when a real page-raster/crop capability returns the complete source region with caption and provenance. Without that capability it remains review-required; a text-derived SVG or synthetic grid is not an exact crop.
- Preserve MathML when available; otherwise use a real source-backed bounded SVG/image fallback without inventing LaTeX, variables, or labels. Missing or ambiguous equation payloads remain review-required.
- Package every selected asset in the EPUB manifest and verify there are no dangling references, placeholders, or silently discarded source objects.
- Alt text uses source text/caption evidence; optional generated descriptions must be marked and may not replace source labels.
- Synthetic and redistributable fixtures prove figure/caption, multi-panel, table, vector diagram, and equation fallbacks.

## Validation command

```bash
npm test
npx vitest run src/research/pdf-page-crop.test.ts src/research/pdf-visuals.test.ts src/research/pdf-table-fallback.test.ts src/research/epub.test.ts
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

Semantic tables and vector preservation improve accessibility but are fragile. A declared high-resolution visual fallback is safer than confidently emitting the wrong structure only when the fallback is an actual complete source crop; holding publication for review is safer when no raster/crop capability exists.

## Free-form response

The original local corpus evidence contained papers with hundreds of image operations while EPUBs packaged zero image assets. The implemented source-preserving and bounded-crop paths close that mechanical gap without treating weak object detection as publication-ready.

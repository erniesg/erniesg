# PDF Visual Assets Design

## Scope

Issue 25 extends the existing local PDF reconstruction and fail-closed EPUB export. The implementation must locate source visual objects, preserve safe raster/vector payloads or create a bounded sharp fallback, associate captions without guessing, and package every selected rendition with provenance. No hosted OCR or vision service is introduced.

## Architecture

The canonical `ResearchPaper` remains the reflowable reading graph. Imported figure-like nodes gain a source-backed object kind and asset relationships while `PdfReconstruction` carries the binary asset store plus an inspectable visual-association graph. This keeps binary rendition data out of the canonical content hash while preserving stable canonical node IDs and figure/caption relationships.

PDF operator extraction records raster and vector source boxes. Decodable raster pixels become deterministic PNG assets; simple bounded vector paths remain SVG. Table and equation regions are derived from source text geometry. Tables become semantic XHTML only when every row has the same aligned column structure; otherwise tables and equations use source-text SVG fallbacks. No LaTeX, diagram label, or generated description is inferred.

Caption matching scores label sequence, page and column scope, bounded distance, caption typography, and source cross-references. A unique candidate above threshold is accepted. Ties, missing candidates, unrenderable objects, and orphan captions remain explicit and block readiness.

## EPUB packaging

Matched visual nodes render packaged PNG/SVG assets or validated semantic tables instead of placeholders. The OPF manifest and export manifest enumerate each unique asset, while repeated or multi-panel uses may reference the same content-addressed asset more than once. Export validation rejects dangling XHTML references, missing OPF items, placeholder markup, and selected source objects without payloads.

Alt text is copied from matched source caption/equation evidence and marked with its evidence source in the visual graph. Generated descriptions are outside this slice.

## Testing

Unit tests cover deterministic PNG/SVG generation, table validation/fallback, stable hashes, unique and ambiguous caption matches, completeness metrics, and EPUB integrity. The redistributable synthetic PDF fixture covers multi-panel raster content, a simple vector diagram, a validated table, and an equation fallback. The publication-importer end-to-end test verifies that the fixture reaches readiness and downloads an EPUB containing real assets and no placeholders.

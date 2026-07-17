# Reconstruct scholarly page regions, reading order, and footnotes

depends-on: 011

## Provider

vm-codex

## Goal

Build a page-region and reading-order reconstruction layer that distinguishes body columns, spanning blocks, headers, footers, side material, captions, and footnote regions, then preserves footnote reference relationships in the canonical graph and EPUB.

## Acceptance tests

- Detect one-column, two-column, and spanning regions without paper-specific coordinates.
- Order body content by region/column so lines from opposite columns are never interleaved by global vertical position.
- Separate repeated headers, footers, page numbers, chart labels, and bottom footnote regions from body paragraphs.
- Detect superscript or inline footnote references and match them to numbered/symbolic footnotes or endnotes using label, page/section scope, geometry, and confidence.
- Emit stable note IDs, `epub:type="noteref"`, `epub:type="footnote"`, and backlinks; unresolved or ambiguous matches remain explicit diagnostics.
- Preserve source-page bounding boxes and confidence for every reconstructed region and relationship.
- Synthetic regressions cover footnotes under each column, a page-wide footnote region, a spanning figure between columns, and multi-page endnotes.
- Reading-order evaluation is machine-readable and participates in the completeness gate from spec 011.

## Validation command

```bash
npm test
npm run build
npm run test:e2e -- tests/e2e/publication-importer.spec.ts
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None.

## Artifact outputs

Page-region model, reading-order graph, footnote/endnote nodes and relationships, EPUB note rendering, diagnostics, synthetic fixtures, and evaluation evidence.

## Stop conditions

Stop before silently attaching an ambiguous note, hard-coding coordinates from a sampled paper, or treating visual chart labels as prose merely to increase text coverage.

## Human clarification protocol

When two reading orders or note targets remain equally plausible, retain both candidates with evidence and request a bounded review-policy decision.

## Recommended response

Use deterministic geometry and typography features first, preserve candidate evidence, and allow learned classification only behind a versioned confidence contract.

## Trade-offs

A region graph is more work than line sorting, but it is required for coherent two-column reading and reliable downstream figure, table, and note association.

## Free-form response

Observed failures included interleaved math-paper columns, footnotes merged into body paragraphs, and chart labels inserted into surrounding prose.

## Reading-order architecture constraint

- Build a deterministic component graph before any semantic model call: glyph/word spans, native PDF objects, page IDs, bounding boxes, typography, region class, and stable source anchors.
- Infer reading order as a directed acyclic graph of candidate edges using page segmentation, column membership, spanning-block boundaries, geometry, typography, continuation cues, caption proximity, and reference labels. Record confidence and the evidence for every edge.
- High-confidence deterministic constraints must remain reproducible without a network or model provider. Never send an entire private PDF or raw page image to a hosted model by default.
- An optional learned/LLM resolver may receive only a bounded, redacted component subgraph and nearby text for low-confidence classification or edge ranking. Its response must validate against a versioned schema, cite input component IDs, preserve alternatives, and cannot silently override deterministic constraints.
- Corpus evaluation must report deterministic-only and optional-resolver results separately, including cycle rate, order accuracy, unresolved edges, provider/model version, latency, and cost.
- If no candidate order clears the configured threshold, export is review-required rather than guessed.

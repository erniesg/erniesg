# ADR 006: SRT Finite-Height Pagination and Fragmentation

## Status

Accepted for the structured-input pagination proof of concept.

## Context

ADR 003 declared finite target dimensions but deliberately left their content in one growing browser-flow preview. That made width responsive while target height remained descriptive. The next dependency-ready slice needs page boundaries, paragraph fragmentation, keep rules, and inspectable failure evidence without adding coordinates to canonical content or adopting a paged-media dependency whose decisions are opaque to the manifest.

## Decision

`src/research/pagination.ts` owns a deterministic semantic pagination policy. Target width determines available measure and estimated line ranges; target height independently determines finite region capacity. The target registry remains the source of physical and preview dimensions.

The policy is deliberately narrow:

| Node      | Fragmentation           | Keep rule                                       |
| --------- | ----------------------- | ----------------------------------------------- |
| Heading   | Atomic                  | With the start of the following object          |
| Paragraph | Estimated line boundary | At least two estimated lines at each split edge |
| Quote     | Atomic                  | None                                            |
| Figure    | Atomic                  | With its related caption                        |
| Caption   | Atomic                  | With its related figure                         |

A4 has two independently accounted column regions. Its declared full-span figure uses a dedicated page in this POC so the figure and caption remain atomic and the placement is mechanically explainable. Other finite targets use one region per page. Continuous mobile retains browser flow and has no final page count.

The engine produces one-based page and zero-based region assignments, ordered fragment IDs, canonical source ranges for paragraph fragments, placement decisions, violations, and any atomic scaling fallback with a reason. It never mutates the canonical graph. The React studio renders the same plan as explicit fixed-height sheets and lets the browser perform final glyph and line rendering. Playwright then treats browser geometry as the diagnostic adapter: it rejects content outside a sheet, overlap, horizontal overflow, text loss, malformed fragment sequences, and captions separated from their figures.

Layout manifest version `1.2.0` embeds the pagination policy summary and node policy. A finite placement must name a valid page; flow placements also name region and page/column span. Fragment records carry explicit previous/next lineage. Each baseline records a deterministic layout signature for the complete fragment prefix through a named semantic anchor's region without claiming that the baseline is stable. A recomposition compares that anchored prefix with its reference, reports the common fragment count and stable/unstable status, and keeps final page count as a separate metric.

An atomic object taller than an empty region may use the named `scale-atomic-object` fallback. The manifest records its scale and reason. A required scale below `0.75` additionally records `atomic-object-too-tall` as an error. The golden fixture has no pagination violations or fallbacks.

## Consequences

The golden article now produces fixed-height A4 and e-ink pages with a shared manifest and visual plan. Pagination changes are reviewable as policy or measurement changes rather than fixture coordinates. Conservative text estimation can leave unused space and is not a claim of production typographic optimization; browser geometry evidence remains required because line boxes depend on the actual font engine.

The explicit page plan makes renderer decisions available without adopting a hidden paged-media state model. A later adapter may replace the estimator with browser range measurement or a dedicated paged-media engine if it preserves this diagnostic contract.

## Non-goals

This decision does not add arbitrary PDF reconstruction, complex tables or equations, floats, footnotes, running headers, production-quality page balancing, annotations, target overrides, exports, or visual-baseline approval.

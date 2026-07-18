# SRT engineering benchmark report

Generated 2026-07-18T15:42:38.584Z from the machine-readable [results](./results.json).

## Result

One trusted structured fixture (11 nodes, 1 relationship, 2 annotations) was evaluated across four target profiles. This is a POC engineering sample, not a corpus or user study.

| Target | Structure | Relationships | Clipped | Overlaps | Annotations | Anchors | Fallbacks | Cold ms | Warm median / p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mobile | 100.0% (11/11) | 100.0% (1/1) | 0 | 0 | 100.0% (2/2) | 100.0% (2/2) | 0 | 4.318 | 0.554 / 1.138 |
| paperProMove | 100.0% (11/11) | 100.0% (1/1) | 0 | 0 | 100.0% (2/2) | 100.0% (2/2) | 1 | 2.137 | 0.650 / 1.034 |
| paperPro | 100.0% (11/11) | 100.0% (1/1) | 0 | 0 | 100.0% (2/2) | 100.0% (2/2) | 0 | 0.595 | 0.539 / 0.894 |
| print | 100.0% (11/11) | 100.0% (1/1) | 0 | 0 | 100.0% (2/2) | 100.0% (2/2) | 0 | 0.861 | 0.605 / 0.905 |

Browser geometry used Chromium 149.0.7827.55 at 1440 × 1200 CSS px and 1× device scale. Clipping used a 0.5 CSS px tolerance; horizontal overflow used 1 CSS px. Zero counts mean the inspected golden rendition had no detected failure, not that the renderer is universally safe.

## Representation comparison

| Representation | Availability | What was compared | Boundary |
| --- | --- | --- | --- |
| Fixed PDF | Available, limited | Deterministic 3-page export (4268 bytes; SHA-256 `2f27c80397c0c8e159df26beba861f272aac9ee294b140ff45ee5c9ce477be42`) | Generated from the same semantic fixture; not an independent ingestion baseline |
| Geometric reflow | Unavailable | No score reported | The repository has no same-content geometric-reflow implementation or validated output |
| Semantic rendition | Available, measured | Structure, relationships, browser geometry, annotations, anchors, fallbacks, and composition time across four targets | One trusted fixture only |

The unavailable geometric baseline is deliberately left blank; this report does not manufacture proxy results.

## Runtime and timing protocol

- Host: darwin 24.6.0, arm64, Apple M2 Max, 12 logical CPUs, 65536 MiB memory.
- Runtime: Node v24.14.1; V8 13.6.233.17-node.44.
- Cold: The first manifest composition for a target after evaluator module initialization; module loading and browser startup are excluded.
- Warm: Median and p95 of repeated manifest compositions in the same process after one unmeasured warm-up composition.
- Browser: Chromium DOM rectangles plus rendered annotation and anchor state measured from the built Astro page after document fonts are ready, using the recorded CSS-pixel tolerances.

The low-millisecond composition figures are microbenchmarks and should be read as reference-machine diagnostics, not user-visible end-to-end latency.

## Research qualification

To our knowledge, the integrated POC remains an apparent gap identified by a targeted scoping review; this is not a systematic-review or publication novelty claim. Publication-facing language must remain qualified as **“to our knowledge”** until the listed database search, screening, and citation-chaining work is complete.

See [limitations](./limitations.md), [ADR index](./adr-index.md), [evidence manifest](./evidence-manifest.json), and [reproducibility instructions](./README.md).

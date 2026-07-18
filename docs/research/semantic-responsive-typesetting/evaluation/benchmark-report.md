# SRT engineering benchmark report

Generated 2026-07-18T11:57:49.777Z from the machine-readable [results](./results.json).

## Result

One trusted structured fixture (11 nodes, 1 relationship, 2 annotations) was evaluated across four target profiles. This is a POC engineering sample, not a corpus or user study.

| Target | Structure | Relationships | Clipped | Overlaps | Annotations | Anchors | Fallbacks | Cold ms | Warm median / p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mobile | 100.0% (11/11) | 100.0% (1/1) | 0 | 0 | 100.0% (2/2) | 100.0% (2/2) | 0 | 11.619 | 1.874 / 4.053 |
| paperProMove | 100.0% (11/11) | 100.0% (1/1) | 0 | 0 | 100.0% (2/2) | 100.0% (2/2) | 1 | 5.208 | 2.336 / 3.279 |
| paperPro | 100.0% (11/11) | 100.0% (1/1) | 0 | 0 | 100.0% (2/2) | 100.0% (2/2) | 0 | 1.814 | 1.735 / 2.902 |
| print | 100.0% (11/11) | 100.0% (1/1) | 0 | 0 | 100.0% (2/2) | 100.0% (2/2) | 0 | 2.504 | 2.079 / 3.093 |

Browser geometry used Chromium 149.0.7827.0 at 1440 × 1200 CSS px and 1× device scale. Clipping used a 0.5 CSS px tolerance; horizontal overflow used 1 CSS px. Zero counts mean the inspected golden rendition had no detected failure, not that the renderer is universally safe.

## Representation comparison

| Representation | Availability | What was compared | Boundary |
| --- | --- | --- | --- |
| Fixed PDF | Available, limited | Deterministic 3-page export (4268 bytes; SHA-256 `2f27c80397c0c8e159df26beba861f272aac9ee294b140ff45ee5c9ce477be42`) | Generated from the same semantic fixture; not an independent ingestion baseline |
| Geometric reflow | Unavailable | No score reported | The repository has no same-content geometric-reflow implementation or validated output |
| Semantic rendition | Available, measured | Structure, relationships, browser geometry, annotations, anchors, fallbacks, and composition time across four targets | One trusted fixture only |

The unavailable geometric baseline is deliberately left blank; this report does not manufacture proxy results.

## Runtime and timing protocol

- Host: linux 6.17.0-1011-oracle, arm64, Neoverse-N1, 4 logical CPUs, 23975 MiB memory.
- Runtime: Node v22.22.3; V8 12.4.254.21-node.56.
- Cold: The first manifest composition for a target after evaluator module initialization; module loading and browser startup are excluded.
- Warm: Median and p95 of repeated manifest compositions in the same process after one unmeasured warm-up composition.
- Browser: Chromium DOM rectangles measured from the built Astro page after document fonts are ready, using the recorded CSS-pixel tolerances.

The low-millisecond composition figures are microbenchmarks and should be read as reference-machine diagnostics, not user-visible end-to-end latency.

## Research qualification

To our knowledge, the integrated POC remains an apparent gap identified by a targeted scoping review; this is not a systematic-review or publication novelty claim. Publication-facing language must remain qualified as **“to our knowledge”** until the listed database search, screening, and citation-chaining work is complete.

See [limitations](./limitations.md), [ADR index](./adr-index.md), [evidence manifest](./evidence-manifest.json), and [reproducibility instructions](./README.md).

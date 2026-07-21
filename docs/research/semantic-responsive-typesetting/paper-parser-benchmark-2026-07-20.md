# Local scholarly parser benchmark (2026-07-20)

This note records the parser decision for the private 72-PDF acceptance corpus. It contains only public tool facts and basename/hash/metric evidence. No corpus text or corpus file is stored in the repository.

Last strict-gate update: 2026-07-21 (`pdf-corpus-audit` schema `1.4.0`).

## Decision

Keep PDF.js object/text extraction as the browser baseline, add paper-aware deterministic caption/table/figure grouping, and keep heavyweight document parsers as optional headless adapters. The browser must not depend on a model download or remote service, and unavailable adapters must never change a fail-closed result into a ready result.

## Candidate constraints

| Parser         | Local result                                                                                                                                                          | Resource/capability evidence                                                                                                                                                                       | Decision                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| MinerU 3.1.14  | Installed CLI; CPU `pipeline` on pages 1-9 failed during model acquisition after 30.45 s. Peak RSS was 1,084,227,584 bytes; no parse or accuracy result was produced. | Official local pipeline guidance requires at least 16 GB RAM, recommends 32 GB, and 20 GB disk.                                                                                                    | Optional headless benchmark only; not a browser/runtime dependency.                                 |
| Docling        | Not installed, so no local accuracy result.                                                                                                                           | Standard PDF pipeline is CPU-capable and supports layout/table models. Official Apple M3 Max measurements report about 1.27-1.34 pages/s and about 6.2 GB memory without OCR on a 225-page sample. | Best future CPU adapter candidate when model artifacts can be provisioned explicitly.               |
| GROBID         | No local service or CLI available.                                                                                                                                    | Official Docker guidance recommends 4 GB RAM for full-text structuring. It is strongest for scholarly TEI/citations, but does not replace bounded visual payload extraction.                       | Potential structure/citation adapter; insufficient alone for EPUB visual assets.                    |
| PP-StructureV3 | Not installed, so no local accuracy result.                                                                                                                           | Official basic-pipeline results report 1.77 s/page, 5,278 MB average RAM, and 6,822 MB peak RAM; it detects layout, figures, captions, tables, formulas, references, headers, and footers.         | Useful server-side comparator, but too heavy for the local browser and marginal on a small free VM. |

Primary references:

- <https://opendatalab.github.io/MinerU/quick_start/>
- <https://docling-project.github.io/docling/usage/gpu/>
- <https://docling-project.github.io/docling/usage/advanced_options/>
- <https://grobid.readthedocs.io/en/latest/Grobid-docker/>
- <https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PP-StructureV3.html>
- <https://paddlepaddle.github.io/PaddleOCR/v3.0.1/en/version3.x/algorithm/PP-StructureV3/PP-StructureV3.html>

## Strict-gate quality result (2026-07-21, schema 1.4.0)

The current strict gate counts semantic visual obligations rather than raw PDF paint operations. One caption-associated figure, table, or equation is one obligation even when its exact rendition contains many raster/XObject/vector fragments; every fragment must still have complete lineage in the accepted asset. Connected unassociated fragments form one unresolved visual component, disconnected components remain separate obligations, and confidently identified page furniture is excluded. Unreferenced and unresolved visuals remain blocking diagnostics, so this corrects the measurement unit without weakening readiness.

Visual provenance is also exclusive. A visual relationship is rejected when any of its source regions is already owned by unrelated canonical prose. This prevents the same source text from being credited once as prose and again as visual text.

Schema `1.4.0` adds two fail-closed contracts. First, `structural-boundary` may replace an unresolved source-line transition only when its whole source region is owned by exactly one strictly validated visual relationship and no rendered text node; `structurallyConsumedLineBoundaryCount` must agree with the exact ledger and is reported separately from unresolved prose joins. Second, every matched citation carries a source-backed canonical anchor `{ nodeId, start, end }`, the same exact inline citation range and ordered targets, and bibliography-entry targets. Sanitized receipts bind the full citation graph—including hashed labels/targets, anchor, reference range, and source boxes—plus the exact line ledger. Missing, stale, malformed, duplicate, or count-inconsistent evidence fails closed.

The latest repository-owned synthetic strict A/B export reports have identical SHA-256 `0579f5f9cf5dc8d3891f645c23946ed0a6a5b157dee410c15e330face4f5e4fd` and are `ready`: ordered text coverage `0.99057`, inline mapping `14/14`, validated visual assets `3/3`, relationships `4/4`, and zero unresolved obligations. All three profile artifacts were identical between independent A/B exports and all six passed EPUBCheck 5.3.0.

The checked target set is Mobile plus the official portrait device profiles: Paper Pro Move `954 × 1696 @ 264 PPI` and Paper Pro `1620 × 2160 @ 229 PPI`. Preview frames derive relative physical scale from those registry values; they do not claim firmware-identical pagination or reader typography.

The latest owner-only, hash-verified `2408.10903v5` repeat is also deterministic, but remains `review-required`:

| Ordered text |    Inline | Validated visuals | Relationships | Duplicate spans | Missing regions | Unprovenanced units | Unresolved joins | Structural boundaries |
| -----------: | --------: | ----------------: | ------------: | --------------: | --------------: | ------------------: | ---------------: | --------------------: |
|    `0.99996` | `705/714` |           `12/51` |       `33/86` |             `0` |             `0` |                 `0` |              `0` |                   `4` |

The four structural transitions belong to strictly validated visual-only regions and are not claimed lexical resolutions. A hash-pinned owner sidecar replayed all 44 bounded prose decisions with zero stale targets. Remaining incomplete/ambiguous tables and visuals plus 9 citations inside non-semantic table visuals keep the paper blocked, and no independently human-accepted sanitized baseline has been provisioned. Both reconstruction receipts and all three profile artifacts repeat exactly; all six artifacts pass internal validation and EPUBCheck 5.3.0. This evidence proves local repeatability and external EPUB validity, not publication or VM acceptance.

The final conservative-visual frozen-ten same-toolchain A/B run covers 10 papers, 495 pages, and `19,758,997` source bytes. It reports `0 ready / 10 review-required / 0 failed`, mean text coverage `0.998058`, weighted inline coverage `51,638/51,709` (`0.99862693`), validated assets `726/1,146` (`0.63350785`), resolved relationships `1,043/1,673` (`0.62343096`), `1,125` unresolved obligations, and `292` unresolved plus `7` structural line boundaries. Coverage is intentionally more conservative because figure candidates that overlap reading-order prose no longer count as validated crops unless complete native-only payloads exist.

The A/B export-corpus report SHA-256 is `bf88a61602a0299ef76af141c241e66451796e08bcb181d4eef567be5f849ce3`, and the A/B sorted 30-artifact index SHA-256 is `3ea2dc48d1899e6dd192259b1a70371c5a7d1cf1825dabc39787bb6bf4dfc140`. Each run produced 30 EPUBs. All 60/60 artifacts passed internal structural validation and EPUBCheck 5.3.0 with warnings treated as failures. The strict artifact-and-structure comparator passed with zero regressions and comparison SHA-256 `b3f247bfd52c88da3e5b60e4ef48889d3a0f86b187d3706d5fb40efe8b91b85d`.

The post-fix run demonstrates that the former canonical visual/XHTML and citation-ID collisions no longer block export. Canonical citation and visual IDs must nevertheless remain globally unique and derived from source identity/position, while EPUB validation continues to reject duplicate canonical/asset IDs, duplicate asset hrefs, duplicate XHTML `id` values, and dangling fragments. All ten papers remain truthfully `review-required`; deterministic export is not publication readiness.

## Historical pre-strict representative result (superseded)

The following report-only sample predates the schema-1.3 strict provenance and semantic-visual accounting above. It is retained as a historical comparator and must not be cited as the current `2408.10903v5` result.

The report-only audit sampled four documents spanning 17-51 pages and 0.23-9.27 MB. All completed without parser failure and correctly remained `review-required`; no publication-grade gate was weakened.

| Basename                                      | SHA-256                                                            | Pages |    Text |  Assets | Relationships | Unresolved | Reading-order diagnostics |
| --------------------------------------------- | ------------------------------------------------------------------ | ----: | ------: | ------: | ------------: | ---------: | ------------------------: |
| `2310.08796v1.pdf`                            | `62d9cbd8891dfd84e0b81093b8b09a32ecb451245b1600b5d3717f247d106e8f` |    17 | 0.97776 | 0.70588 |       0.29412 |         17 |                         0 |
| `Institutions, Technology and Prosperity.pdf` | `af13e80577efe1b879fc6b31e3eb9aa6ae7ad525a406091dc3764111110f1297` |    51 | 0.98597 | 1.00000 |       0.38776 |         30 |                         5 |
| `2209.03430v2.pdf`                            | `865e6bb3045753841b4a32d10d3e00fdeeaa502a82ccde04e5e5b141b9834636` |    36 | 0.96168 | 1.00000 |       0.33333 |         14 |                         2 |
| `2408.10903v5.pdf`                            | `f5c8f963c4d17409b6ab163e0be914db139f9bc83cca0274a88863098e865a80` |    35 | 0.93710 | 0.98884 |       0.54545 |         35 |                         0 |

For `2408.10903v5.pdf`, that historical targeted probe matched Figure 1, Figure 4, and Tables 3/4/5 exactly once. Table 16 was not synthesized from its prose cross-reference. Table assets were accepted only after repeated row/column anchors validated; adjacent prose remained outside the table provenance box.

The historical blockers included residual visual relationships, note references in other layouts, and text coverage below the 0.98 gate. The current named-paper result is the strict-gate section above; neither result justifies a claim that arbitrary scholarly PDFs are publication-ready.

## Historical full corpus audit

The same report-only path completed for all 72 PDFs without a parser failure or a false `ready` result. All 72 correctly remained `review-required`. The most common fail-closed reasons were unresolved semantic objects (70), incomplete relationship coverage (69), unreferenced visual assets (65), incomplete asset coverage (58), unresolved visual objects (49), incomplete text coverage (46), and unresolved note references (38). One document required OCR and one had no reconstructable text under the current local parser. These aggregates are acceptance evidence, not a publication-readiness claim.

# Reading-order ambiguity taxonomy

## Resolution policy

Policy `1.0.0` extends the existing `deterministic-geometry-v1` graph. A sparse
column hypothesis resolves only at confidence `0.85` or higher. It must have a
stable central gutter repeated across at least two vertical bands and at least
two of these independent signals:

- compatible left/right font metrics;
- continuous indentation and line-width geometry;
- adjacent vertical blocks within each proposed column.

The score starts at `0.45`. A stable gutter adds `0.20`; compatible font
metrics, indentation continuity, and block adjacency add `0.10` each. A
gutter-crossing caption adds `0.03`; a spanning body boundary and a separated
footnote band add `0.02` each. Three or more repeated aligned bands retain the
previous deterministic acceptance rule. Two-band layouts must satisfy the
versioned score and independent-evidence requirement.

An accepted sparse layout records its class, confidence, threshold, normalized
geometric evidence, and affected region IDs in the reading-order graph. The
reconstruction also emits one informational `RESOLVED_READING_ORDER` diagnostic
per affected region. These diagnostics do not relax completeness. A lower score
retains both cross-column candidates, emits a blocking
`AMBIGUOUS_READING_ORDER` diagnostic with the score and evidence, and keeps
export review-required.

## Named classes

| Class                             | Ambiguity cause                                                                                                 | Decisive evidence                                                                                                          | Fail-closed boundary                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `two-column-with-spanning-float`  | A short column band is interrupted by a page-spanning caption or float.                                         | Stable gutter, compatible fonts, column indentation, adjacent blocks, and a gutter-crossing caption.                       | The float does not select before/after policy on its own; weak column geometry remains ambiguous.                                        |
| `single-column-with-margin-notes` | Aligned narrow side notes resemble a second body column.                                                        | Subordinate side-note font metrics, stable main-body indentation, narrow width, lateral offset, and row alignment.         | Side material remains excluded from canonical body order; equal-font or discontinuous main flow is not resolved as a margin-note layout. |
| `mixed-single-two-column`         | A document changes between single- and two-column pages or contains a wide boundary around a short column band. | Stable page-local gutter plus compatible fonts, indentation, and adjacent blocks; wide regions remain explicit boundaries. | No order is borrowed from another page when page-local evidence is below threshold.                                                      |
| `dense-reference-section`         | Short, tightly set citations provide only a small number of aligned rows.                                       | Repeated gutter, matching small-font metrics, hanging/column indentation continuity, and vertical adjacency.               | Reference labels do not override inconsistent geometry.                                                                                  |
| `footnote-band`                   | Bottom notes align with columns and can be mistaken for continued body flow.                                    | Body-column evidence plus a separated smaller-font lower note band.                                                        | Notes always follow body flow and never contribute evidence for interleaving into body columns.                                          |

A sixth implementation class, `fragmented-inline-cluster`, covers multiple
same-row fragments that do not form two vertically adjacent blocks. It resolves
to ordinary top-to-bottom single flow at confidence `0.92`; it never establishes
a column order.

## Synthetic regression coverage

`tests/fixtures/reading-order-fixtures.ts` contains one fixture for each named
class. Before policy `1.0.0`, all five emitted a blocking
`AMBIGUOUS_READING_ORDER` diagnostic because they contained only two aligned
column bands. They now assert the canonical node sequence node-by-node, zero
blocking reading-order diagnostics, and the exact evidence codes carried by the
resolution. A separate fixture with discontinuous indentation and a normalized
vertical gap of `0.482` remains below threshold with both candidates retained.

The former short-column regression intentionally changes: two perfectly
aligned, font-compatible, adjacent column bands now resolve with the recorded
gutter, font, indentation, and adjacency evidence. Its fail-closed counterpart
now uses inconsistent indentation and non-adjacent blocks so the reason for
blocking is inspectable rather than being a raw line-count cutoff.

## Privacy-preserving local corpus evidence

Command:

```bash
npm run pdf:corpus-audit -- --report-only tests/fixtures/pdf public/research/if-letters-home-could-sing/if-letters-home-could-sing.pdf
```

Only stable basenames, SHA-256 hashes, and `AMBIGUOUS_READING_ORDER` counts are
recorded below. No document text, title, author, path, bytes, or provenance is
included.

| Basename                         | SHA-256                                                            | Before | After |
| -------------------------------- | ------------------------------------------------------------------ | -----: | ----: |
| `born-digital.pdf`               | `f1e2af07c15668c5a71734354d38ee57b07381b242d97ce04c0a2c71414cbf31` |      0 |     0 |
| `if-letters-home-could-sing.pdf` | `ddf25768bcc2ec8866037c553102071ee8fbb73db168f975852f69482c1eb042` |      1 |     1 |
| `mixed-page.pdf`                 | `478fde62332d767b1826ed1fe49b0bf01e3ddbd70edcaba292574145626d83c4` |      0 |     0 |
| `scanned-page.pdf`               | `0341313284cfd07ea06bac1502c2559bed4031193d6e11610f368b5196560962` |      0 |     0 |
| `structured-scientific.pdf`      | `13133f8a0ab1f7d98aa913b534c2b7c1fe2d3ef60b2226a13a8601bbff1d0ffe` |      0 |     0 |
| `two-page-scan.pdf`              | `81e0ab5636d9eb58f8a8d8e32310b4f8a05f1846f38d5ff05dfdd39c950f8945` |      0 |     0 |

The one locally available non-synthetic document does not provide enough
independent evidence to clear its existing ambiguity, so policy `1.0.0` leaves
it blocking. No private scholarly corpus was present in this checkout; broader
coverage must be measured by rerunning the same local-only command where those
operator-supplied PDFs are available.

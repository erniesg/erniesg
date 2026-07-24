# Scholarly PDF reconstruction failure taxonomy

This taxonomy comes from whole-paper review of the named acceptance paper,
complaint-driven papers, and the sealed ten-paper robustness corpus. It records
the first source-backed failure in each trace rather than downstream rendering
symptoms. The corpus gate remains an integrity and non-regression check; it is
not an accuracy oracle.

The machine-readable provenance companion is
`benchmarks/pdf/fidelity-eval-observations-v1.json`, validated by
`docs/schemas/pdf-fidelity-eval-observations.schema.json`. It maps every one of
the 29 bounded public calibration cases to:

- the first source-backed pipeline decision that can explain that bounded
  failure;
- the exact source-PDF SHA-256 and one-based source page;
- the frozen eval-case identity; and
- one deterministic binary evaluator: exact classification, complete
  label-scoped detection at the frozen IoU threshold, all-pairs reading order,
  or exact typed relationships.

Candidate output was not used to create those labels. The labels are
source-verified public calibration annotations, not an independently blinded
holdout. Raw paper bytes, prose, formulas, screenshots, local paths, and model
payloads are absent from the companion.

## Observed failure classes

| Class                               | First failure                                                                                                                | Typical downstream symptom                                                                                                                             | Required control                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reading topology                    | Columns, gutters, continuations, or parent/child sections are ordered or joined incorrectly.                                 | A subsection precedes its parent, prose jumps across columns, or appendix parents disappear while children remain.                                     | Deterministic geometry graph, monotonic hierarchy checks, and unresolved edges when geometry is not decisive.                                                                                                        |
| Column/section subtree weave        | Page-level region ordering is accepted before every region is assigned to its authored section subtree.                      | A left-column section, a right-column section, and their lists alternate even though each source column is internally continuous.                      | Partition the page into proved column lanes, bind regions to section intervals, then require every subtree to remain contiguous; a receipt that reports zero order diagnostics while subtrees interleave is invalid. |
| Semantic type confusion             | A source region is assigned the wrong role.                                                                                  | Prose becomes an equation; a list or table row becomes a heading; a chart tick, code literal, citation, or math subscript becomes a note.              | Font/run evidence plus region ownership and competing-role precedence. Never decide from a short token alone.                                                                                                        |
| Formula-layout flattening           | Two-dimensional fraction, script, radical, or operator geometry is serialized in extraction-array order.                     | Numerators and denominators interleave into text such as nested `helix(helix(...))`, or a summation moves ahead of the sentence fragment it completes. | Emit MathML only from proved operator/script containment and ordered baselines. Otherwise preserve one complete bounded source crop, withhold the corrupt transcript, and keep formula semantics review-required.    |
| Lexical and operator loss           | A conservation metric discards punctuation, operators, case, or token boundaries before comparison.                          | `−0.5 ≤ p` becomes `0.5 p`, or two words merge, while character coverage still reports 100%.                                                           | A second meaning-preserving text channel that retains signs, operators, case, and boundaries; allow only explicitly ledgered transformations.                                                                        |
| Boundary incompleteness             | A crop or semantic region omits source material belonging to the object.                                                     | A diagram loses its top line, a caption stops early, or an equation omits its denominator.                                                             | Line- and run-backed enclosure tests, crop margins constrained by neighbouring objects, and explicit incomplete-object diagnostics.                                                                                  |
| Boundary contamination              | A crop or semantic region includes neighbouring material.                                                                    | Page furniture, prose, a second equation, or another panel appears inside one object.                                                                  | Repeated-margin exclusion, unique source-line ownership, and fail-closed overlap checks.                                                                                                                             |
| Ownership and cardinality           | The right objects are detected but attached or grouped incorrectly.                                                          | A caption is duplicated, a footnote crosses a section, or Equations 8 and 9 merge into one relationship.                                               | Typed one-to-one/one-to-many relationship rules, canonical anchors, and expected-versus-resolved cardinality checks.                                                                                                 |
| Label-contract drift                | Detection, matching, serialization, or integrity validation use different scholarly-label grammars.                          | `Table S2` disappears from the obligation count, or a source-proved `Appendix E` link is created and then rejected as dangling.                        | One shared bounded label parser used by detection, matching, cross-references, serialization, and the completeness/integrity ledgers; geometry remains an independent obligation.                                    |
| Residual-flow discontinuity         | Two retained fragments are joined after an intervening source span was consumed by another semantic object.                  | A bibliography entry, paragraph, or formula jumps across a table/equation line that is no longer visible in prose.                                     | Source-offset continuity checks on every residual join; a gap larger than the proved separator is a semantic boundary, even when both fragments share one original region ID.                                        |
| Float resumption and containment    | A float is excised or reinserted from geometry without source-backed before/after anchors and a containing section interval. | A sentence remains split around a table, or a complete appendix figure appears under the following appendix heading.                                   | Record typed float ownership, exact resumption anchors, reference/caption evidence, and enclosing-section bounds; fail closed when candidate placements cross a section boundary.                                    |
| Table-transcript leakage            | Lines owned by a validated or unresolved table remain eligible for ordinary prose reconstruction.                            | Headers and numeric cells become dozens of paragraphs and contaminate the sentence before or after the table.                                          | Maintain one line-ownership ledger across table detection, crop/semantic validation, residual prose, and export; an unresolved table stays visible as an obligation without leaking its cell stream into prose.      |
| Block-boundary erosion              | Region grouping crosses an authored paragraph gap, indent, inline subhead, or page/column boundary without a join decision.  | Several authored paragraphs become one multi-thousand-character paragraph, hiding local order errors and destroying navigation.                        | A paragraph-boundary ledger backed by source gaps, first-line indents, font transitions, and page/column continuity; every crossed boundary needs an explicit decision.                                              |
| Preformatted and algorithm loss     | Code, pseudocode, JSON, or another aligned block is treated as ordinary prose.                                               | Indentation disappears, numbered algorithm lines reorder, and escaped newlines become visible literals or spaces.                                      | A whitespace-preserving canonical block with ordered source-line lineage; otherwise retain a complete bounded crop/transcript and block semantic completion.                                                         |
| Paratext and navigation loss        | Contents, legal notices, publication status, warnings, or author addresses have no typed ownership.                          | An appendix contents page becomes dozens of body paragraphs, isolated page numbers enter prose, or copyright text merges with the byline.              | Typed paratext nodes and destination relationships; navigation material must not enter ordinary body flow and every isolated page-number token needs a structural owner.                                             |
| Linked-token discontinuity          | Soft line wrapping is resolved before adjacent fragments of one link are recomposed.                                         | A URL contains a visible inserted space, or one destination becomes several adjacent anchors.                                                          | Coalesce contiguous same-target annotations by source geometry and require visible URL text to round-trip to its normalized destination without invented whitespace.                                                 |
| Nested-list topology loss           | List identity resets when a continuation block, formula, or code fragment occurs inside an item.                             | Sequential ordinals split into separate lists or the continuation escapes into body prose.                                                             | Stable numbering identity across compatible indentation plus explicit child-block ownership inside the list item.                                                                                                    |
| Affiliation marker-set compression  | Several visible author/affiliation markers are collapsed into one note obligation.                                           | Only marker 1 links, while affiliations 2 and 3 and correspondence fuse into the first note.                                                           | One obligation per distinct visible marker, exact target/backlink sets, and a separately typed correspondence block.                                                                                                 |
| Bibliography item-boundary collapse | Hanging indents, author starts, column transitions, or page-edge continuations are ignored.                                  | One reference node spans pages and contains many entries, or a single entry is split into unrelated paragraphs.                                        | Entry-cardinality and continuation ledgers using source offsets, indentation, author/year starts, columns, and page-edge continuity.                                                                                 |
| Table data and header truth         | A rectangular table is accepted without proving each cell against source lines or its header relationships.                  | Values transpose, signs disappear, inline math flattens, or assistive technology receives the wrong headers.                                           | Per-cell line/box lineage, ordered transcript hashes, cell-local inline semantics, and explicit header associations; otherwise preserve a bounded crop and require review.                                           |
| Source extraction                   | Glyphs or layout primitives cannot be recovered reliably from the PDF.                                                       | Missing characters, isolated operators, corrupt font mappings, or an OCR-required page.                                                                | Embedded-text extraction first, then an integrity-pinned offline OCR/formula/layout adapter with its output treated as a proposal.                                                                                   |
| Front-matter and metadata authority | Document properties, XMP, visible byline, and filesystem timestamps are conflated.                                           | A creator string replaces the visible authors, or a file modification date is asserted as publication date.                                            | Typed candidates with source lineage and corroboration; visible source wins, conflicts and unproven dates remain unresolved.                                                                                         |
| Link-obligation loss                | Unsupported, internal, malformed, or overlapping PDF annotations disappear before they enter a closed ledger.                | Visible linked text becomes plain prose while inline coverage still passes.                                                                            | Stable annotation identities and a one-to-one external/internal link obligation ledger; every unmapped annotation blocks.                                                                                            |
| Language and direction loss         | Source language and writing direction are absent from the canonical graph.                                                   | Multilingual or RTL text is packaged as English/LTR despite recovered language evidence.                                                               | BCP 47 language and base-direction candidates with provenance, propagated to XHTML, navigation, OPF, and spine metadata; use `und` when unknown.                                                                     |
| Conservation blind spot             | An aggregate metric passes despite structural corruption.                                                                    | Character coverage approaches 100% while paragraphs are reordered or object semantics are wrong.                                                       | Separate sequence, provenance, type, relationship, crop, and cardinality receipts. Text coverage is necessary, never sufficient.                                                                                     |
| Rendition mismatch                  | The canonical graph is correct but a profile preview or download diverges.                                                   | Overflow, clipped media, stale profile state, or a downloaded artifact that differs from the visible preview.                                          | Official versioned profile geometry, a shared rendition artifact, preview/download receipt binding, internal validation, and EPUBCheck.                                                                              |
| Receipt identity failure            | The EPUB payload is valid but its receipt fields are not recomputed or bound to package metadata.                            | A tampered identifier or canonical/source hash is accepted by inspection.                                                                              | Strict receipt schema, recomputed canonical hashes, OPF identifier/title binding, and optional expected source-PDF identity.                                                                                         |
| Authority failure                   | An unverified model or candidate output is treated as truth.                                                                 | Invented prose, guessed ownership, a stale decision replay, or a candidate appointing its own baseline.                                                | Hash-pinned inputs, typed source-cited patches, stale-target rejection, independent owner approval, and exact-head evidence.                                                                                         |

## Model boundary

Born-digital PDFs usually fail first at topology, role, boundary, ownership, or
cardinality rather than OCR. A stronger layout or formula model can help, but it
must emit versioned observations or proposed graph patches with page, box,
source-line, and confidence evidence. A local LLM may adjudicate ambiguous joins
or relationships only through the same bounded decision schema.

The model must not write the EPUB directly. The deterministic pipeline remains
responsible for source conservation, canonical identity, relationship
cardinality, asset packaging, profile rendering, EPUB integrity, and the
completeness gate. Unsupported proposals stay visible as review obligations.

## Routing

1. Fix reproducible parser and renderer defects with generated regressions.
2. Use code-based checks for objective sequence, enclosure, provenance,
   cardinality, ZIP/XML, and profile invariants.
3. Calibrate offline layout, table, OCR, and formula adapters on source-only
   bounded cases. Their output remains non-authoritative until validated.
4. Use a bounded LLM proposal for cases whose source evidence is present but
   geometry alone cannot choose an authored interpretation.
5. Require human approval for remaining ambiguous semantics and for a new
   accepted baseline. Never infer approval from candidate repeatability.

## Review saturation

Sample random, complaint-driven, outlier, and failure-stratified traces. Expand
the versioned eval set until roughly 100 bounded traces have been labelled and
the final 20 reveal no new failure class. A materially changed parser, model,
prompt, or profile restarts that audit. Until saturation and independent
acceptance, a deterministic and EPUB-valid readable fallback is not a
publication-grade reconstruction.

The current state is explicitly **not saturated**: frozen v1 contains 29
bounded traces, and additive v2 contributes three complaint-driven,
source-verified traces, for 32 labelled traces in total. The v2 case-selection
process consulted candidate output and is therefore public calibration rather
than an independent blind holdout. The frozen-ten and seeded-random-ten lanes
account for 20 robustness
executions but only 18 distinct paper identities because `2405.07987v5` and
`2507.21509v3` occur in both. Those whole-paper executions provide discovery
and non-regression evidence; they do not count as 20 independently labelled
holdout traces and do not establish the required final no-new-class window.
The exact base and additive identities and this status are bound in
`benchmarks/pdf/reconstruction-eval-contract-v1.json` and
`benchmarks/pdf/reconstruction-eval-contract-v2.json`.

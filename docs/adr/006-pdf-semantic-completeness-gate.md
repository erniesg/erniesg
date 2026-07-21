# ADR 006: PDF semantic completeness and corpus quality gate

- Status: Accepted
- Date: 2026-07-14
- Last amended: 2026-07-21

## Context

The local PDF adapter reconstructed embedded text and treated any non-empty,
non-OCR result as EPUB-ready. That decision could silently omit images,
captions, tables, equations, footnotes, relationships, or substantial text.
Source coordinates remain provenance; they are not canonical layout.

The adapter is intentionally narrow. This decision adds measurable failure
criteria instead of broadening it into arbitrary PDF reconstruction.

## Decision

Every reconstruction records source/output text coverage, duplicate canonical
spans, an exact source-line transition ledger, source/exported image coverage,
detected/resolved relationship coverage, unresolved semantic object counts,
OCR-required pages, and reading-order diagnostics. `EPUB ready` and EPUB export
require all error diagnostics to be clear and this versioned policy to pass:

| Measure                                  | Initial threshold |
| ---------------------------------------- | ----------------: |
| Ordered, provenance-scoped text recovery |      at least 98% |
| Duplicate canonical spans                |                 0 |
| Adjacent source-line transitions decided |              100% |
| Unresolved corrupting joins              |                 0 |
| Source image objects exported            |              100% |
| Detected relationships resolved          |              100% |
| Unresolved semantic objects              |                 0 |
| OCR-required pages                       |                 0 |
| Blocking reading-order diagnostics       |                 0 |

Text coverage is not a document-wide bag-of-characters score. Canonical nodes
are mapped back to ordered source regions through provenance, and normalized
Unicode letters and numbers are matched in order within each region. Accepted
scientific-object regions are compared as their own source-backed relationship
group, so a figure label or table cell cannot be credited to similar prose
elsewhere in the paper. Reordered text loses coverage, and a canonical span
that occurs more often than its source-backed occurrence count is a blocking
duplicate.

The line ledger contains exactly one deterministic decision for every adjacent
line transition inside every source region. Transition and decision identifiers
must be unique, page/region membership must agree, and the independently
reported unresolved count must equal the decisions whose outcome is
`unresolved`. Missing, duplicate, extra, cross-region, or structurally invalid
entries produce `INVALID_LINE_BOUNDARY_LEDGER`; any unresolved transition
produces `UNRESOLVED_CORRUPTING_JOIN`. The accepted outcomes are `space`,
`no-space`, `preserved-lexical-hyphen`, and
`removed-discretionary-hyphen`.

Zero expected assets or relationships is defined as full coverage, but detected
captions, tables, equations, citations, footnote references, and notes
contribute unresolved objects until represented in the canonical graph. A
citation clears the relationship gate only when its source-backed inline run
targets one or more canonical bibliography-entry node IDs. Image-bearing or
caption-bearing input with no reconstructed objects therefore fails closed.

Reading-order evidence uses the versioned `deterministic-geometry-v1` region
graph. Regions retain normalized source boxes and confidence; every accepted or
candidate edge retains its geometry evidence and score. The audit reports cycle
rate, unresolved edges, and optional ground-truth order accuracy separately from
any future resolver. Candidate edges or cycles participate in the existing
blocking reading-order threshold.

The 98% text threshold is an initial conservative allowance for normalization
and intentionally removed repeated margins. It may falsely hold documents with
large boilerplate headers, while a looser threshold risks hiding lost scholarly
text. Asset and relationship thresholds remain 100% because the current export
cannot label a knowingly missing scientific object as complete. Threshold
changes require a new evidence-backed ADR.

Front matter is classified explicitly as title, author, affiliation, abstract
heading, or abstract body. Title/author/affiliation content is promoted once to
paper metadata instead of being reinserted as body prose; the source-backed
abstract heading and body remain in canonical order. Ordered lists retain marker
style, ordinal, numbering identity, nesting level, and cross-page continuation.
Inline runs may compose overlapping source-backed semantics such as emphasis
plus citation/link rather than discarding all but one style.

Scientific objects clear the gate only with complete source object/region IDs,
bounded source geometry, packaged non-empty assets, canonical placement, and
their accepted caption relationship. A multi-fragment diagram may be composed
only from one validated bounded component graph; missing or invalid components
remain blocking. Tables become semantic HTML only after multi-row/multi-column
structure validates. A nonsemantic or nonuniform table may use a non-blocking
image fallback only when a real page-raster/crop capability returns the complete
bounded source region. The PDF.js canvas-factory implementation provides this
path in browser and headless Node runtimes, and rejects blank, counterfeit,
near/full-page, or lineage-mismatched crops. If a defensible bounded candidate
or valid crop is unavailable, the object remains review-required; a text-derived
SVG or synthetic grid is not an “exact crop.” Equations similarly use
recoverable source semantics or a real source-backed bounded asset and may not
invent MathML, LaTeX, labels, or variables.

Footnotes and endnotes clear the gate only when deterministic label, page or
section scope, column geometry, and ordering evidence produce a unique
canonical note target. Ambiguous candidates remain diagnostics. A passing gate
means only that the configured checks passed; it is not a claim of perfect
reconstruction.

## Local corpus audit and privacy

Run:

```bash
npm run pdf:corpus-audit -- /operator/supplied/file-or-directory
```

The command exits nonzero if any document needs review. `--report-only` emits the
same JSON without using incompleteness as the process exit status. Reports use
schema `1.4.0`, validated by `docs/schemas/pdf-corpus-audit.schema.json`, and
contain only stable basenames, SHA-256 hashes, byte/page counts, completeness
metrics, readiness, deterministic structural hashes derived from the canonical
evidence, exact per-code diagnostic counts, and redacted samples bounded to
three per code and 64 per document. They contain no input paths, document bytes,
extracted prose, titles, authors, or provenance boxes.

Same-toolchain repeatability compares byte hashes plus recomputed canonical-node,
relationship, asset-manifest, and line-ledger receipts. Cross-version or
cross-model promotion compares those receipts directionally and requires frozen
synthetic/gold decisions; copying a candidate's hash strings into a baseline is
not evidence. A named private run does not pass without a separately reviewed,
owner-staged sanitized baseline outside the repository.

Repository tests use deterministic CC0 synthetic PDFs plus the already-published
fellowship PDF. The 50 MB oversized fixture is virtual so the exact boundary is
covered without committing an inert large file. Rejection happens before local
bytes are read; cancellation destroys active PDF.js work and releases streamed
response bodies.

## Consequences

Fewer PDFs are immediately downloadable, but known incomplete reconstructions
are visible and inspectable. Future extraction work can turn each measured
failure into a regression without relaxing the readiness policy.

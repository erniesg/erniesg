# ADR 006: PDF semantic completeness and corpus quality gate

- Status: Accepted
- Date: 2026-07-14

## Context

The local PDF adapter reconstructed embedded text and treated any non-empty,
non-OCR result as EPUB-ready. That decision could silently omit images,
captions, tables, equations, footnotes, relationships, or substantial text.
Source coordinates remain provenance; they are not canonical layout.

The adapter is intentionally narrow. This decision adds measurable failure
criteria instead of broadening it into arbitrary PDF reconstruction.

## Decision

Every reconstruction records source/output text coverage, source/exported image
coverage, detected/resolved relationship coverage, unresolved semantic object
counts, OCR-required pages, and reading-order diagnostics. `EPUB ready` and EPUB
export require all error diagnostics to be clear and this versioned policy to
pass:

| Measure                            | Initial threshold |
| ---------------------------------- | ----------------: |
| Normalized source text recovered   |      at least 98% |
| Source image objects exported      |              100% |
| Detected relationships resolved    |              100% |
| Unresolved semantic objects        |                 0 |
| OCR-required pages                 |                 0 |
| Blocking reading-order diagnostics |                 0 |

Text coverage compares normalized Unicode letters and numbers as a multiset.
Reading order is assessed separately. Zero expected assets or relationships is
defined as full coverage, but detected captions, tables, equations, footnote
references, and notes contribute unresolved objects until represented in the
canonical graph. Image-bearing or caption-bearing input with no reconstructed
objects therefore fails closed.

The 98% text threshold is an initial conservative allowance for normalization
and intentionally removed repeated margins. It may falsely hold documents with
large boilerplate headers, while a looser threshold risks hiding lost scholarly
text. Asset and relationship thresholds remain 100% because the current export
cannot label a knowingly missing scientific object as complete. Threshold
changes require a new evidence-backed ADR.

Complex tables, equations, and footnotes remain review-required rather than
being guessed into prose. A passing gate means only that the configured checks
passed; it is not a claim of perfect reconstruction.

## Local corpus audit and privacy

Run:

```bash
npm run pdf:corpus-audit -- /operator/supplied/file-or-directory
```

The command exits nonzero if any document needs review. `--report-only` emits the
same JSON without using incompleteness as the process exit status. Reports use
schema `1.0.0`, validated by `docs/schemas/pdf-corpus-audit.schema.json`, and
contain only stable basenames, SHA-256 hashes, byte/page counts, completeness
metrics, readiness, and diagnostics. They contain no input paths, document
bytes, extracted prose, titles, authors, or provenance boxes.

Repository tests use deterministic CC0 synthetic PDFs plus the already-published
fellowship PDF. The 50 MB oversized fixture is virtual so the exact boundary is
covered without committing an inert large file. Rejection happens before local
bytes are read; cancellation destroys active PDF.js work and releases streamed
response bodies.

## Consequences

Fewer PDFs are immediately downloadable, but known incomplete reconstructions
are visible and inspectable. Future extraction work can turn each measured
failure into a regression without relaxing the readiness policy.

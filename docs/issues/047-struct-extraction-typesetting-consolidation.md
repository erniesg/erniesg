# Consolidate source-agnostic STRUCT extraction and typesetting

depends-on: 034,036,038,039,040,041,042,043,044,045,046

## Provider

vm-codex

## Goal

Deliver one reusable PDF/DOCX extraction-to-typesetting pipeline for unseen
papers. Every source adapter emits the canonical STRUCT graph; every EPUB or
HTML renderer consumes only that graph. The implementation must be general,
deterministic by default, and safe when evidence is insufficient.

## Required behavior

- Reconstruct continuous prose across lines, columns, pages, and spreads while
  excluding repeated page furniture with an auditable source ledger.
- Extract figures, diagrams, raster/vector assets, captions, tables, equations,
  footnotes/endnotes, citations, hyperlinks, cross-references, code, and
  algorithms. Preserve every obligation exactly once.
- Prefer semantic table reconstruction only when cell boundaries, spans,
  headers, links, and complete source lineage are proven. Otherwise keep one
  bounded source-preserved image/text fallback with caption and provenance.
- Represent equations as one verified MathML/text object or one bounded source
  crop. Never emit equation glyph fragments into ordinary prose.
- Resolve notes, citations, links, and cross-references against verified graph
  targets. Keep visible source text when a target cannot be proven.
- Use deterministic extraction and validators first. A Codex/model layout pass
  may choose only among deterministic candidates supplied in a bounded STRUCT
  context; it cannot author text, bytes, bounds, or destinations. Persist the
  proposal and distill successful classes into a fixture and deterministic rule.
- Compare the rendered output with the source before requesting human help.
  User-facing recovery contains only actionable pages and exact next steps;
  safe fallbacks and internal diagnostic counts never become user tasks.

## Validation matrix

BookWorld is the current benchmark. Add held-out born-digital, scanned,
single-column, two-column, raster/vector, table, equation, note, citation, and
hyperlink fixtures. Each run must include deterministic rerun hashes, STRUCT
conservation receipts, EPUB spine smoke, and source-versus-render screenshots.

## Definition of done

- TDD coverage for every required obligation and a held-out run with no
  paper-title/page-specific rule.
- No missing visual/table/equation obligations; ambiguous regions have one
  bounded source fallback.
- Continuous prose and relationship ledgers reconcile to source counts.
- Recovery UI has no raw all-caps/internal diagnostic wall.
- Small commits link this spec and its relevant sub-issue. Deploy only after
  the evidence gate is green.

## Human clarification protocol

Do not ask a human until deterministic extraction, candidate-constrained model
layout (when explicitly enabled), source comparison, and the local fallback
have all run. If a question remains, name the exact page, source region, and
single action required.

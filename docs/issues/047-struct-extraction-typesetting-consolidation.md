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

Fresh evidence supersedes saved screenshots or metrics. The 2026-08-01 clean
BookWorld rerun produced 0/8 semantic tables; the saved 1/8 report is stale.
Treat issue 036's provider work as an interface slice until a concrete adapter,
fallback-candidate path, and real BookWorld-plus-held-out benchmark prove that
coverage rose.

## Execution partition

- Serialize parser-core issues 042 → 040 → 043 → 044 so page furniture,
  figures/captions, continuous prose, and notes/citations do not concurrently
  edit the same layout/visual files.
- Table candidate work (036) owns table detection/canonicalization until its
  branch lands. The next table slice is cell-scoped source lineage for shifted
  wrapped continuations and shared source lines; do not patch the same files in
  another worker.
- Source-versus-render evidence (038) and corpus strata (037) may run beside one
  parser worker only when their declared write paths are disjoint.
- The umbrella issue (047) integrates completed child receipts; it is not an
  extra parser worker.

## Acceptance tests

- A source-agnostic fixture in each required document stratum round-trips
  source → STRUCT → EPUB without dropped text, assets, relationships, or
  source-preserved fallback regions.
- The BookWorld benchmark and at least one held-out paper exercise the same
  extraction path without a paper-title or page-number rule; their receipts
  reconcile source obligations to rendered obligations.
- A candidate-constrained model proposal is rejected when it invents text,
  bytes, bounds, or destinations, and accepted proposals are persisted as
  provenance plus a deterministic fixture/rule.
- Source-versus-render evidence runs before recovery UI generation and the UI
  contains only actionable page/region groups; safe fallbacks do not become
  user tasks.

## Validation command

```bash
npx vitest run src/struct/struct.test.ts src/research/pdf-visuals.test.ts src/research/pdf-table-detection.test.ts
npm test
npm run build:astro
scripts/agent-evidence
```

## Allowed secrets

None for deterministic extraction, tests, local rendering, or source
comparison. An explicitly enabled model consultation may use the trusted VM's
provider login, but credentials and source payloads never enter the repository,
logs, fixtures, or issue comments.

## Artifact outputs

The STRUCT graph and conservation receipt, deterministic extraction/evidence
manifest, source-versus-EPUB screenshots, local readable fallback, held-out
metrics, and a plain-language recovery summary containing only exact actions.

## Stop conditions

Stop before inventing text or assets, dropping a source visual, claiming an
unverified relationship, forcing an ambiguous table/equation into prose,
asking a human without source comparison, or declaring a pass when a required
receipt, screenshot, or held-out metric is missing.

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

## Recommended response

Build one conservation-first graph boundary and make each parser issue land a
reusable fixture plus rule. Keep source-preserved fallbacks automatic so the
user never has to repair content that the importer can safely retain.

## Trade-offs

Bounded source fallbacks preserve fidelity while semantic proof is incomplete,
but they defer some reflow quality. Deterministic proof costs more engineering
than paper-specific heuristics, yet it is the only path that can generalize to
unseen layouts and produce trustworthy recovery decisions.

## Free-form response

The finished system should turn a new paper into a structured, readable EPUB
without asking the reader to understand extraction internals; any remaining
human action is a final, page-specific editorial decision backed by source
evidence.

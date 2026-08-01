# Current Task

- Issue/PR: #113 — Consolidate source-agnostic STRUCT extraction and typesetting
- Branch: codex/issue-113-struct-typeset
- Lane: trusted-vm (portable changes are prepared locally; VM queue is the overnight executor)
- Objective: Generalize PDF/DOCX extraction and rendering for unseen papers. Deterministically recover continuous prose, page furniture, figures/diagrams/captions, tables, equations, notes, citations, links, and preformatted blocks into STRUCT; prefer proven semantic tables and preserve every ambiguous bounded source region; render only from STRUCT; compare every rendition with its source before exposing human work.
- Last checkpoint: Table lineage, equation source-preservation, and actionable recovery are covered by deterministic tests. Full local evidence passed (build plus 2,460 tests, one skipped) and the Astro build passed. Commit `b19f282` adds the repository-owned 30-minute VM drain timeout and five-minute stop override; the handoff artifact is `/Users/erniesg/.codex/handoffs/erniesg-20260801-155439.md`. BookWorld remains the benchmark plus held-out corpus.
- Next action: Capture source-versus-EPUB visual evidence and rerun the held-out corpus, then let the VM drain #113 and its dependencies (#88, #91–#95, #104–#108, #70) with one bounded worker per pass. #88 and #92 are currently running on the VM; #113 is queued; #107 is blocked on publication-bundle sealing and must not be duplicated. Any model/layout consultation must be candidate-constrained, provenance-recorded, and distilled into deterministic tests. The VM timer is enabled with the 30-minute bounded-pass timeout.
- Human decision needed: no (only ask after automatic source comparison identifies a specific page and exact action).

# Current Task

- Issue/PR: #113 — Consolidate source-agnostic STRUCT extraction and typesetting
- Branch: codex/issue-113-struct-typeset
- Lane: trusted-vm (portable changes are prepared locally; VM queue is the overnight executor)
- Objective: Generalize PDF/DOCX extraction and rendering for unseen papers. Deterministically recover continuous prose, page furniture, figures/diagrams/captions, tables, equations, notes, citations, links, and preformatted blocks into STRUCT; prefer proven semantic tables and preserve every ambiguous bounded source region; render only from STRUCT; compare every rendition with its source before exposing human work.
- Last checkpoint: Table source-lineage promotion fix committed as 27d4e95 in the prior worktree. Recovery UI now suppresses safe fallback diagnostics and groups actionable pages. Equation fallback regression is covered and source-preserved crops are being completed. BookWorld remains the benchmark plus held-out corpus.
- Next action: Run the focused and full evidence gates, capture source-versus-EPUB visual evidence, then let the VM drain #113 and its dependencies (#88, #91–#95, #104–#108, #70) with one bounded worker per pass. Any model/layout consultation must be candidate-constrained, provenance-recorded, and distilled into deterministic tests. The VM drain service must allow up to 30 minutes for a bounded pass so systemd does not kill a healthy worker at 90 seconds.
- Human decision needed: no (only ask after automatic source comparison identifies a specific page and exact action).

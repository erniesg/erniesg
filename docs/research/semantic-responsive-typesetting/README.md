# Semantic Responsive Typesetting — complete handoff

This bundle contains the product/implementation brief and its companion research evidence pack.

## Start here

1. Read [`PRD/semantic_responsive_typesetting_PRD_handoff.md`](./PRD/semantic_responsive_typesetting_PRD_handoff.md) for the current product thesis, implementation acceptance gates, architecture, requirements, milestones, and fresh-agent kickoff. The adjacent `.docx` is the original handoff snapshot and may lag this active Markdown contract.
2. Read `research/semantic_responsive_typesetting_literature_review.docx` before making novelty claims or choosing the technical approach.
3. Import `research/semantic_responsive_typesetting_references.bib` into the project bibliography.

## Important research qualification

The literature review is a targeted scoping review completed on 12 July 2026, not a completed PRISMA/systematic review. It establishes strong prior-art guardrails and an apparent integrated gap. Before publication, reproduce the searches in bibliographic databases, screen results systematically, and perform backward/forward citation chaining.

## Product/research distinction

The scholarly-paper/e-ink workflow is the proof-of-concept domain. The broader product thesis is Semantic Responsive Typesetting: structured components retain semantic identity and relationships while target-specific geometry, flow, and pagination are computed as renditions.

## Engineering evaluation

The reproducible POC benchmark, machine-readable results, limitations log, ADR index, evidence inventory, and demo instructions are in [`evaluation/`](./evaluation/README.md).

The current PDF-ingestion release contract is layered: component behavior is owned by issues 012, 013, 018, and 023-026; issue 032 is the integrated privacy-safe `2408.10903v5` upload, semantic reflow, multi-profile preview, and optional EPUB-download regression gate. Deterministic benchmark policy and private-corpus handling are defined in [`pdf-ingestion-benchmark.md`](./pdf-ingestion-benchmark.md).

Authoritative e-ink device geometry comes from the target registry: Paper Pro Move is `954 × 1696` device pixels and Paper Pro is `1620 × 2160` device pixels. Browser previews may scale those viewports, but must retain their aspect ratio, profile/version receipt, semantic reading order, and honest distinction between publisher-controlled output and reader-controlled EPUB behavior.

# Semantic Responsive Typesetting

## Product Requirements Document + Agent Handoff

**Proof of concept:** scholarly document recomposition across print, e-ink, and digital surfaces  
**Version:** 0.2
**Status:** Active implementation and PDF-ingestion fidelity hardening
**Prepared:** 12 July 2026

> **Core proposition:** One semantic document. Multiple computed renditions. Persistent identity, relationships, reading position, and annotations.

---

## 0. Agent handoff — read this first

### Mission

Build and harden the end-to-end proof of concept that demonstrates **semantic responsive typesetting**. PDF ingestion is now a shipped local adapter, but it remains lossy and fail-closed rather than a universal converter.

The POC should take one canonical scholarly document and compose it into four materially different surfaces while preserving semantic identity, figure-caption relationships, reading position, and text annotations. The system should make layout decisions visible and permit target-specific overrides without mutating source content.

### Defaults

| Decision             | Default                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Name                 | Semantic Responsive Typesetting (SRT)                                                                                    |
| Canonical model      | Custom validated JSON graph inspired by JATS; not PDF, EPUB, or TeX                                                      |
| First input          | Structured article fixture, preferably JATS-derived or manually normalized                                               |
| Rendering approach   | HTML/CSS plus a paged-media engine and a thin policy layer                                                               |
| Targets              | A4 print, large 4:3 e-ink, small tall e-ink, continuous mobile                                                           |
| Annotations          | Text highlight and anchored note in P0; freehand ink is a stretch goal                                                   |
| PDF ingestion        | Local lossy adapter with deterministic fixtures, private-corpus regression gates, provenance, and explicit review states |
| Designer editability | Target-specific rule overrides in P1; design-tool round-trip is out of MVP                                               |
| Automation           | Deterministic, explainable rules first; no generative layout dependency                                                  |

### Immediate deliverable

- Runnable repository with one command to launch the studio.
- One golden scholarly article rendered from the same source into four target profiles.
- Stable semantic IDs in every rendition and a generated layout manifest.
- Target switching that preserves the semantic reading anchor.
- A text highlight that remains attached after reflow.
- Screenshot and structural tests.
- ADRs for schema, pagination, and annotation anchoring.

> A clean demonstration of one paper across four targets is more valuable than partial support for arbitrary PDFs, scans, equations, collaboration, and design-tool round-tripping.

### Current PDF-ingestion acceptance authority

Issues 012, 013, 018, and 023-026 own the region/order/note, visual-object, inline-structure, truthful-preview, adjudication, and target-profile contracts. Issue 032 is the integrated privacy-safe `2408.10903v5` regression gate. A component issue is not complete if its isolated fixture passes while that integrated upload-to-preview-to-EPUB gate still reproduces title fragments, broken prose, missing scientific objects, or stale/mismatched previews.

---

## 1. Executive summary

Semantic Responsive Typesetting is a document composition model in which the canonical document is a persistent semantic graph, while pages, columns, coordinates, and line breaks are computed renditions for a particular surface. Components may move, resize, change variants, or fragment, but their identities and relationships remain stable.

The scholarly-paper case is the benchmark domain, not the product boundary. It combines long-form prose, finite-page composition, figures, captions, citations, equations, tables, cross-references, and annotation-intensive reading. It also exposes the weakness of fixed PDFs on differently shaped e-ink displays.

**Primary hypothesis:** A canonical semantic graph plus target constraints, layout policies, and non-destructive overrides can generate coherent renditions across heterogeneous widths and finite heights while preserving identity, relationships, reader position, and annotations.

## 2. Context and problem

Current workflows often flatten incoming structured data into a fixed PDF too early, then require downstream movement in Illustrator or InDesign and a separate rebuild for digital output.

```text
incoming data
  → manual coordinate calculations
  → fixed-size PDF
  → downstream movement and repair
  → separate digital rendition

structured content + relationships + layout policy
  → composition for a target profile
  → print, e-ink, web, and inspectable/editable renditions
  → designers edit only exceptions
```

**Problem statement:** Publishers lack a simple, inspectable workflow in which structured text and visual components can be recomposed across different page dimensions while retaining semantic identity, editorial relationships, annotation anchors, and target-specific designer control.

## 3. Vision and principles

```text
canonical semantic document
+ target profile
+ composition policy
+ target-specific overrides
→ computed rendition
```

Principles:

1. The page is a rendition.
2. Identity survives movement.
3. Movement is governed by constraints.
4. Width and finite height are first-class.
5. Relationships outrank visual proximity.
6. Current-region stability matters more than immediate global page count.
7. No silent content loss.
8. Designers edit exceptions, not source semantics.
9. Fidelity may be hybrid for complex scientific objects.

## 4. Terminology

- **Semantic node:** stable object such as paragraph, heading, figure, caption, equation, table, or reference.
- **Canonical graph:** presentation-independent source of truth.
- **Layout capability:** what a node may do: split, float, span, scale, change variant, or fall back.
- **Target profile:** dimensions, typography, columns, interaction, and output constraints.
- **Composition policy:** global layout and fragmentation rules.
- **Rendition:** one computed arrangement for a target.
- **Override:** target-specific non-destructive exception.
- **Provenance map:** rendered element to canonical source and optional original-PDF coordinates.
- **Semantic reading anchor:** node/text position independent of page number.
- **Layout version:** cache key for document + target + typography + policy + overrides.

## 5. Users and jobs

Primary users are publishing automation engineers, designers/art directors, active readers, content operations teams, and document/HCI researchers.

Core jobs:

- Recompute layout from retained intent when content or target dimensions change.
- Preserve figure/caption/reference identity while objects move.
- Preserve reader position and annotations across devices and typography changes.
- Expose layout failures and fallbacks.
- Record designer overrides without contaminating other targets.

## 6. Scope

### P0

- One canonical paper plus 3–5 regression fixtures.
- Canonical JSON and optionally one JATS/HTML importer.
- Title, authors, abstract, headings, paragraphs, lists, figures, captions, citations, references, simple tables, and atomic display equations.
- A4 print, large 4:3 e-ink, small tall e-ink, continuous mobile.
- Width-and-height responsive composition.
- Text highlight and anchored note.
- Reading-position preservation.
- Studio, manifest, diagnostics, and HTML/PDF/EPUB-oriented outputs.

### Non-goals

- Perfect arbitrary PDF or scan reconstruction.
- Production CMS or collaboration.
- Full Illustrator/InDesign round-trip.
- Perfect freehand ink deformation.
- AI-generated layout or silent summarization.

## 7. Golden-path demo

1. Load a structured paper and show semantic outline/provenance.
2. Render it in the large e-ink profile.
3. Switch to the small tall profile; text and figures recompose, caption relationships and reading position persist.
4. Resize width/height/font.
5. Highlight a sentence and attach a note.
6. Reflow again; annotations remain attached.
7. Inspect a rendered object’s ID, source, constraints, variant, page, and fallback.
8. Apply one print-only override.
9. Export paginated PDF, reflowable HTML/EPUB, and the manifest.

## 8. Functional requirements

- **FR-01:** Validated canonical graph with stable IDs and provenance.
- **FR-02:** Structured normalization path.
- **FR-03:** Composition using width, finite height, typography, columns, keep rules, and fragmentation.
- **FR-04:** Runtime target profiles.
- **FR-05:** Target-aware component variants.
- **FR-06:** Semantic reading anchor.
- **FR-07:** Text-range annotation anchoring.
- **FR-08:** Layout-versioned geometry cache.
- **FR-09:** Provenance mapping.
- **FR-10:** Explicit atomic visual fallbacks.
- **FR-11:** Target-specific overrides.
- **FR-12:** Current-region-first progressive composition.
- **FR-13:** HTML, paginated, PDF, EPUB-oriented, and manifest outputs.
- **FR-14:** Inspection studio.
- **FR-15:** Structural and visual regression harness.
- **FR-16:** Source-backed inline semantics for bold, italic, superscript, subscript, safe links, citations, and footnote references, with preview/EPUB parity and measured supported/mapped coverage.
- **FR-17:** Evidence-based scholarly structure recovery for title/authors/abstract, numbered and unnumbered section headings, nested lists, references, bibliography, captions, notes, tables, and display equations.
- **FR-18:** Truthful upload preview of the checked selected-profile artifact before an optional matching-profile download; a fresh upload invalidates every prior reconstruction, object URL, receipt, preview, and download.
- **FR-19:** Authoritative Paper Pro Move `954 × 1696` and Paper Pro `1620 × 2160` device-pixel profiles, with browser scaling derived from the registry and reader-controlled EPUB behavior stated explicitly.
- **FR-20:** Deterministic PDF-to-EPUB regression benchmarking using generated redistributable fixtures plus hash-bound private inputs whose bytes, prose, paths, screenshots, and traces never enter Git or GitHub.

### 8.1 PDF ingestion and rendition acceptance gates

These gates measure semantic recovery. They do not require an EPUB reader to reproduce the source PDF's coordinates.

- **Continuous prose:** every source line boundary has a recorded decision. Supported decisions cover spaces, no-space joins, preserved lexical hyphens, removed discretionary line-wrap hyphens, and unresolved evidence. Readiness requires zero unresolved corrupting joins, isolated alphabetic prose glyphs, overlapping duplicate spans, and cross-column/cross-region joins.
- **No reconstruction debris:** small-cap/all-cap styling, font size, boldness, or whitespace alone cannot create a heading. A heading requires compatible geometry plus section syntax/boundary evidence. Title, author, affiliation, list-marker, equation-label, and page-furniture fragments cannot become detached prose nodes.
- **Inline meaning and hierarchy:** every deterministically supported bold, italic, bold-italic, superscript, subscript, link, citation, and note-marker span maps once with valid Unicode offsets. Relative hierarchy remains ordered as title > section heading > body, while captions, affiliations, and notes remain subordinate; absolute PDF font sizes and families are not copied as semantics.
- **Document structure:** numbered/unnumbered sections, nested lists, references, and bibliography entries retain typed nodes and canonical order. List markers do not become paragraphs, bibliography entries do not merge across columns, and table rows or equation glyphs claimed by an object region do not leak into body prose.
- **Notes and citations:** supported footnote markers map to typed note bodies and backlinks. Citations retain their marker semantics and relationships. Ambiguous citation-versus-note or marker-to-body evidence remains review-required.
- **Scientific objects:** each accepted diagram, figure, table, and display equation has stable source object/region ids, normalized bounds, provenance, a canonical position, and a complete anchored caption when one exists. Tables use validated semantic structure or a bounded sharp rendition; equations use source semantics when available or a bounded SVG/raster fallback. No invented cells, labels, LaTeX, or MathML are allowed.
- **Semantic reflow:** Mobile, Paper Pro Move, and Paper Pro follow canonical reading order and do not mimic source PDF columns, source line breaks, or coordinate-shaped whitespace. Figures/captions/floats are placed by semantic relationships and target policy rather than raw page coordinates.
- **Preview and download:** choosing a new upload reprocesses its bytes even when filename metadata matches the prior upload. The user can inspect Mobile, Paper Pro Move, and Paper Pro checked previews before downloading; switching previews has no download side effect, and every optional action returns only the artifact whose profile id/version and hash match the visible receipt.
- **Deterministic evidence:** generated fixtures gate CI. Named/private papers are keyed by basename/public id and SHA-256 and may emit only aggregate metrics, normalized boxes, diagnostic codes, versions, hashes, timings, and verdicts. Source bytes/text, absolute paths, screenshots, browser traces, and unpacked artifacts remain owner-only outside the repository.

## 9. Non-functional requirements

Deterministic, fidelity-preserving, inspectable, modular, offline-capable, accessible, testable, and observable. Provisional POC targets are no more than one second median to first stable viewport and five seconds for full composition of a roughly twenty-page article on a documented reference machine; measure and revise after establishing a baseline.

## 10. Canonical data model

Use a validated JSON graph inspired by JATS. TeX, HTML, EPUB, and PDF are inputs or outputs.

```json
{
  "id": "fig-3",
  "type": "figure",
  "content": { "asset": "assets/fig-3.svg" },
  "relationships": {
    "caption": "cap-3",
    "referencedBy": ["p-17", "p-24"]
  },
  "layout": {
    "mayFloat": true,
    "maySplit": false,
    "allowedSpans": [1, 2],
    "variants": ["inline", "full-width", "dedicated-view"]
  },
  "source": {
    "kind": "jats",
    "locator": "/article/body/sec[2]/fig[1]"
  }
}
```

Highlights should store node ID, text offsets, exact quote, prefix/suffix context, appearance, and a layout-versioned geometry cache.

## 11. Composition model

```text
1. Normalize source
2. Resolve target and overrides
3. Select component variants
4. Build semantic flow and priority region
5. Measure text and atomic objects
6. Place, fragment, and paginate
7. Record decisions and violations
8. Resolve annotation geometry
9. Emit rendition, manifest, and cache entry
```

The layout key hashes document version, target profile, typography, policy version, and overrides. Canonical content and annotations do not mutate when the key changes.

## 12. Studio UX

- **Left:** semantic outline, relationships, annotations, provenance.
- **Center:** live rendition, page boundaries, current anchor, annotation overlays.
- **Right:** target profile, dimensions, type, margins, columns, figure policy, overrides.
- **Bottom:** timing, page-count status, variants, fallbacks, overflow, and constraints.

## 13. Recommended architecture

Use a TypeScript monorepo with a renderer-neutral graph and manifest.

```text
apps/studio
packages/schema
packages/import-jats
packages/composer
packages/render-html
packages/render-paged
packages/annotations
packages/export-epub
packages/export-pdf
packages/provenance
packages/benchmarks
fixtures/golden
docs/adrs
```

Use semantic HTML/CSS for continuous view, a paged-media engine behind an adapter, named deterministic policies, browser measurement for the POC, and manifest/screenshot regression tests.

## 14. Research plan

Central question: Can a semantic, constraint-based document model generate coherent paginated renditions across heterogeneous widths and heights while preserving content identity, relationships, reader state, and annotations?

Evaluate system correctness, layout quality, performance, and later a user study comparing original PDF, optimized fixed layout, and semantic reflow across large and small e-ink classes.

## 15. Success criteria

- One canonical source renders four targets.
- Stable semantic IDs and content hashes in every rendition.
- All mandatory nodes and figure-caption/citation-reference links preserved.
- No clipping, overlap, or silent content loss in the golden set.
- Materially different compositions across target classes.
- Same semantic sentence remains visible after target switch.
- Highlights re-resolve to the exact text.
- Diagnostics explain moves and fallbacks.
- Target overrides are isolated.
- PDF plus reflowable output and manifest are generated.
- Repository, tests, and demo are reproducible.

## 16. Risks

Main risks are scope collapsing into PDF parsing, paged-renderer limitations, complex tables/equations, design-tool editability, freehand annotation complexity, aesthetic quality, progressive pagination jumps, and overclaiming novelty. Mitigate with structured input first, adapters, hybrid fallbacks, text annotations first, a small design system, semantic anchors, and a verified literature review.

## 17. Milestones

- **M0:** Skeleton, fixtures, ADRs, tests.
- **M1:** Semantic continuous rendering across profiles.
- **M2:** Responsive pagination and manifests.
- **M3:** Reading anchors, annotations, provenance.
- **M4:** Overrides and exports.
- **M5:** Evaluation package and demo.

## 18. First sprint

1. Create repository and ADRs.
2. Select or synthesize one legally usable scholarly fixture.
3. Define the minimum canonical schema.
4. Validate fixture without target coordinates.
5. Render semantic HTML with stable IDs.
6. Implement four target profiles.
7. Emit a preliminary layout manifest.
8. Add structural and screenshot tests.
9. Record failures rather than hiding them with special-case coordinates.

**Exit artifact:** one source paper visibly recomposes across four profiles with stable IDs, no clipped content, and a machine-readable manifest.

## 19. Open decisions — recommended defaults

- Canonical source is a semantic graph, not TeX.
- Start from structured source, not PDF.
- EPUB is an output, not source of truth.
- Reuse browser/paged-media machinery; own schema, policies, manifest, anchors, and overrides.
- Deterministic rules before AI.
- Permit provisional page count during current-region-first reflow.
- Use hybrid fallbacks for complex scientific content.
- Model freehand attachment policies now; implement highlights first.

## 20. Research seeds

Verify primary sources before publication claims: Adaptive Grid-Based Document Layout; Adaptive Document Layout; Conversion of PDF Books in ePub Format; Reflowing and Annotating Scientific Papers on eBook Readers; Robust Annotation Positioning; Moving Markup; Reflowing Digital Ink Annotations; GROBID; S2ORC; PubLayNet; DocLayNet; VILA; SciA11y; Nougat; Docling; MinerU; JATS; EPUB; Web Annotation; EPUB Annotations; DocDancer; FlexDoc; e-ink and active-reading studies.

## 21. Fresh-agent kickoff prompt

> You are the implementation and research agent for the Semantic Responsive Typesetting proof of concept. Read this PRD as the source of truth. Build a narrow end-to-end system proving that one canonical semantic scholarly document can be recomposed across A4 print, a large 4:3 e-ink profile, a small tall e-ink profile, and continuous mobile while preserving stable node identity, relationships, reading position, and text annotations. Use the defaults unless a true blocker arises. Start with structured input and a validated JSON graph. Do not begin with arbitrary PDF reconstruction, full freehand ink, AI layout generation, a production CMS, or design-tool round-trip. Your first milestone is a runnable studio that renders one golden article into four visibly different profiles from the same source, embeds stable semantic IDs, and emits a layout manifest with chosen variants and geometry. Add tests and ADRs as you go. Make rules deterministic and inspectable; record failures rather than hiding them with one-off coordinates. After the core path is stable, add finite-height pagination, semantic reading anchors, text highlights, target-specific overrides, exports, progressive composition, and optional original-PDF provenance in that order. Deliver the repository, README, demo script, golden fixtures, tests, ADRs, benchmark results, limitations log, and a short research-method outline. The page is a rendition, not the document.

## 22. Definition of done

The repository runs locally; one canonical article and a small golden set are included; four materially different profiles are generated; pagination responds to width and finite height; semantic identity and relationships are preserved; reading position and highlights survive reflow; one override is isolated; the studio explains layout decisions; PDF and reflowable outputs plus a manifest are produced; tests cover the golden path; and limitations are documented without overstating novelty.

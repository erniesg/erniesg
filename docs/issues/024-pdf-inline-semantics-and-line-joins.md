# Preserve PDF inline semantics and line joins

depends-on: 012,017,023

## Provider

vm-codex

## Goal

Preserve recoverable inline emphasis, hyperlinks, and word boundaries when reconstructing born-digital PDFs, with explicit evidence for every line-join and dehyphenation decision, so text coverage can no longer report success while typographic meaning or words are silently corrupted.

## Acceptance tests

- `src/research/pdf-layout.ts` maps source-backed italic, bold, bold-italic, superscript, and subscript spans into canonical `inlineRuns` only when `PdfSourceRun` font, baseline, and geometry metadata supplies deterministic evidence; ambiguous styling remains plain text with a named diagnostic instead of a guess.
- Embedded PDF link boxes map to safe `http`, `https`, or `mailto` inline link runs when their text intersection is unambiguous; unsafe schemes and unresolved overlaps are rejected. Internal PDF destinations remain explicit unsupported provenance with `UNRESOLVED_HYPERLINK` until a destination-to-canonical-node schema exists.
- Citation markers preserve their source-backed superscript/bracket form and relationship identity without being confused with footnotes. A resolved citation has one exact source-backed canonical anchor `{ nodeId, start, end }`, an inline citation run with the same relationship ID/range/ordered targets, and one or more canonical bibliography-entry node targets; an unmatched target, a target outside the bibliography, a stale anchor, or an unresolved citation/note distinction remains diagnostic rather than being flattened, deleted through reclassification, or guessed. Citation and relationship IDs are globally unique and derived from source identity/position, so two labels that collapse to the same display slug cannot collide. Footnote markers link to typed note bodies and backlinks when issue-012/018 evidence resolves them.
- Accepted inline ranges preserve Unicode offsets and render equivalent semantic tags in the studio and EPUB. Different source-backed roles may overlap and compose, such as italic plus citation or bold plus safe link; identical duplicate ranges coalesce. For every supported style/link/reference denominator, completeness records mapped counts and requires 1.0 coverage before readiness.
- Relative font hierarchy is preserved as a semantic relationship rather than copied absolute PDF point sizes: title > section heading > body, subordinate affiliation/caption/note text remains subordinate, and emphasis never promotes a body run into a heading. Synthetic assertions compare ordered hierarchy classes and bounded ratios, not a specific source font family.
- Line reconstruction records exactly one decision for every adjacent source-line transition inside each source region: space, no-space join, preserved lexical hyphen, removed discretionary line-end hyphen, `structural-boundary`, or unresolved join. `structural-boundary` is allowed only when the transition's whole region is owned by exactly one strictly validated visual relationship and by no rendered text node; a stale/forged decision, mixed ownership, rejected visual, or prose-owned region is reclassified as unresolved. Decision and transition IDs are unique, page/region membership and unresolved/structurally-consumed totals agree, and missing, duplicate, extra, or cross-region ledger entries block readiness. Re-importing identical bytes produces identical decisions and canonical text.
- Any optional lexical or model-assisted line-join adjudicator runs locally and has a versioned contract that binds its locale, provider/model version, and immutable lexicon or model digest into the decision receipt. For each exact source-region and source-line transition it returns only `remove`, `preserve`, or `abstain`, plus bounded evidence; `abstain`, an unavailable provider, a digest mismatch, or evidence below the calibrated threshold remains an unresolved publication blocker. Repeated runs with the same source bytes and adjudicator identity produce byte-identical decisions and sanitized receipts.
- Synthetic fixtures prove that `well-being` and authored dash punctuation survive while a discretionary line-wrap such as `effec-` + `tive` becomes `effective`; a genuine wrapped word is joined only with sufficient lexical and geometric evidence, ligatures and Unicode normalization do not shift inline ranges, and two columns or a heading/body boundary never merge into one paragraph.
- Redistributable gold-label fixtures calibrate remove-versus-preserve accuracy before a lexical or model version may reduce corpus blockers. They include ordinary discretionary breaks, one-off authored compounds, scientific/proper terms, and context-sensitive minimal pairs where concatenated and hyphenated forms are both plausible. Calibration reports per-class precision, recall, abstention rate, provider/digest identity, and deterministic receipt equality; corpus pass-rate alone can never appoint a new adjudicator or widen its threshold.
- Reconstruction emits no paragraph or heading whose normalized text is one isolated alphabetic glyph created from a split line, author initial, equation label, small-cap run, or page boundary. A legitimate one-glyph source object must remain a typed non-prose node or explicit unresolved diagnostic, never promoted into body flow.
- Small-cap or all-cap styling alone cannot create a heading, repeat the document title, or split one phrase into a large fragment plus detached glyphs. Inline runs with the same source span coalesce once, and accepted canonical spans have no overlapping duplicate character coverage.
- Heading classification requires compatible geometry and syntax: a bounded standalone line with heading-level typography plus section numbering, recognized section-title syntax, or a stable short-line boundary. Font size, boldness, capitalization, or vertical whitespace alone is insufficient, and title/author/abstract boundaries may not be inferred from repeated words.
- Text inside a source region already claimed by a validated table, bounded table fallback, figure, diagram, or display equation is excluded from ordinary prose nodes. Synthetic tests prove table rows and equation glyph runs do not leak into adjacent paragraphs while captions and cross-references remain in reading order.
- Front matter retains explicit title, author, affiliation, abstract-heading, and abstract-body roles; title/author/affiliation values are promoted once to metadata while the source-backed abstract remains in canonical order. Numbered and unnumbered section headings, nested and cross-page lists, reference entries, and the bibliography heading remain typed structures with stable canonical order. List marker text/style, ordinal, numbering identity, nesting level, and continuation survive; markers do not become isolated paragraphs, bibliography entries do not merge across columns, and a `References`-like word is a heading only when geometry plus section-boundary syntax agrees.
- The completeness report records `supportedStyledCharacterCount`, `mappedStyledCharacterCount`, per-style supported/mapped span counts, `supportedExternalLinkSpanCount`, `mappedExternalLinkSpanCount`, supported/mapped citation and note-marker counts, `lineBoundaryCount`, `decidedLineBoundaryCount`, `structurallyConsumedLineBoundaryCount`, `isolatedProseGlyphCount`, `duplicateCanonicalSpanCount`, and `unresolvedCorruptingJoinCount`. Readiness requires 1.0 coverage for every supported-evidence denominator, zero isolated prose glyphs, duplicate spans, unsafe/unresolved supported links, and unresolved corrupting joins; validated structural boundaries are counted separately and never presented as lexical dehyphenation success. Ambiguous unsupported evidence is diagnosed separately and cannot inflate a denominator.
- Corpus/private/comparison envelopes use schema `1.4.0`. Their structural receipt binds the exact citation graph—including hashed labels, ordered bibliography targets, canonical anchor, reference range, and source boxes—and the exact line ledger plus `structurallyConsumedLineBoundaryCount`. A missing, malformed, stale, or count-inconsistent receipt fails closed. Structural-boundary count is comparison-neutral by itself; the strict structure hash detects a changed decision, while directional unresolved-join metrics measure improvement or regression.
- `ResearchStudio` and `buildEpub` render the same accepted ranges, and structural tests compare their semantic tags and link targets for the fixture.
- The local corpus audit reports counts and rates only; it does not emit private text, font names that contain local paths, or source snippets. New files to add: `src/research/pdf-lines.test.ts` and `tests/fixtures/pdf/text-semantics.pdf`; the PDF is generated by the existing `tests/fixtures/pdf/generate-fixtures.mjs` and recorded in `tests/fixtures/pdf/manifest.json`.

## TDD sequence

1. **Red:** add `src/research/pdf-lines.test.ts`, extend `src/research/pdf-layout.test.ts` and the synthetic fixture generator for bold/italic fonts, safe/unsafe links, every join kind, lexical-versus-discretionary hyphens, ligatures, Unicode normalization, isolated glyphs, small-cap duplication, geometry-plus-syntax headings, table/equation prose exclusion, and forbidden cross-column/heading joins; run `npx vitest run src/research/pdf-lines.test.ts src/research/pdf-layout.test.ts src/research/epub.test.ts` and preserve the expected failures.
2. **Green:** preserve source-run offsets and add only the deterministic style/link and line-boundary decision model needed for those cases; ambiguous evidence must stay plain or unresolved.
3. **Red then green:** add completeness and preview-versus-EPUB parity assertions, expose the exact counters, and block readiness on corrupting joins or unresolved supported evidence.
4. **Refactor:** centralize offset normalization and run coalescing only after fixture behavior passes, then run the named corpus smoke check and full validation without changing canonical text or accepted decision bytes.

## Exact-head definition of done

- Generated fixtures, decision records, canonical graph, preview tags, EPUB tags, and coverage counters satisfy every acceptance assertion at the exact PR head with no guessed style or text mutation.
- Focused reconstruction/parity tests, the named corpus smoke check, and the full validation command exit 0; exact-head evidence contains no skipped or quarantined failure.
- Repeated import/export is deterministic, and logs/reports contain only bounded metrics and provenance—not source snippets, private text, local paths, or secrets.
- From a clean checkout of the immutable PR head, the canonical evidence manifest records `commit` equal to that head, `dirty: false`, `result: passed`, and every required lane; a post-lane clean-worktree check proves validation did not modify tracked or generated source files.
- Reconstruction and export receipts bind source bytes, decision-schema/profile versions, toolchain versions, and artifact hashes to that exact head.

## Validation command

```bash
npx vitest run src/research/pdf-lines.test.ts src/research/pdf-layout.test.ts src/research/epub.test.ts
npm test
npm run build
npm run test:e2e -- tests/e2e/publication-importer.spec.ts
npm run pdf:corpus-audit -- --report-only tests/fixtures/pdf/text-semantics.pdf
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None. PDF analysis remains local and deterministic.

## Artifact outputs

PDF inline-run reconstruction, line-join decision records, new completeness evidence and diagnostics, synthetic fixtures, corpus metrics, and preview/EPUB parity tests.

## Stop conditions

Stop before inferring emphasis from wording, running a remote lexical service, silently changing source punctuation, inventing MathML or LaTeX from an equation image, or weakening the existing completeness gate. Preserve the source-backed SVG/image equation fallback when semantic math is unavailable.

## Human clarification protocol

If font metadata or a line boundary is ambiguous, show the bounded source runs, competing joins, and downstream text difference required for a one-document decision instead of adding a global heuristic.

## Recommended response

Treat text joining and inline formatting as provenance-bearing reconstruction decisions, then measure unresolved semantic loss separately from raw character coverage.

## Trade-offs

Conservative evidence thresholds will leave some PDFs blocked or visually plain, but a missing emphasis diagnostic is safer than confidently changing words, links, or mathematical meaning.

The final sanitized 2026-07-21 conservative-visual frozen-ten A/B export audits (identical report SHA-256 `bf88a61602a0299ef76af141c241e66451796e08bcb181d4eef567be5f849ce3`) recorded 292 unresolved joins and 7 strictly visual `structural-boundary` transitions across 10 papers and 495 pages. The strict artifact-and-structure comparator passed, and all 60 artifacts passed internal validation plus EPUBCheck 5.3.0. The named raw-parser measurement remains 44 unresolved joins plus 4 strictly visual transitions; the latest hash-pinned owner replay applies all 44 bounded decisions with zero stale targets and therefore reports zero unresolved corrupting joins. The raw 44 remain evidence that geometry alone cannot decide authored versus discretionary hyphens; the four structural transitions are neither prose nor claimed lexical resolutions. Line-join punctuation is excluded by normalized text conservation, so unresolved joins do not by themselves explain text-coverage loss; that metric requires an independent provenance/output-duplication diagnosis.

### Named-paper aggregate join diagnosis

The hash-verified, privacy-safe aggregate audit of `2408.10903v5` found 32 unresolved boundaries in bibliography entries and 12 in prose. All 44 are parseable visible ASCII-hyphen boundaries whose continuation begins lowercase; all retain the same font and font size across the boundary and terminate near the region edge. None is an explicit soft hyphen. More importantly, neither the exact unhyphenated candidate nor the exact hard-hyphen candidate occurs anywhere else in the source document for any of the 44. Geometry therefore supplies no discriminating semantic evidence: an authored compound and a discretionary wrap have the same observed shape.

An advisory, unversioned host dictionary recognizes only the unhyphenated candidate for 19 boundaries—16 bibliography and 3 prose—and recognizes neither form for the remaining 25. This is diagnostic only. It is not reproducible product evidence, has no coverage for many names and scientific terms, and cannot distinguish a missing authored compound from a discretionary break. No named boundary may be auto-resolved from that dictionary result.

The current deterministic rules already cover the source-backed cases that can clear without interpretation: explicit soft hyphens, an exact same-document unhyphenated occurrence, an exact same-document hard-hyphen occurrence, numeric ranges, and constrained acronym-to-title-case compounds. None applies to the 44. Consequently there is no new near-certain general rule to implement from already-preserved evidence, and the correct current outcome is `abstain`/`unresolved`.

The next admissible slice is a local bounded adjudicator plus calibrated optional model:

1. Add a line-transition decision record bound to document SHA-256, region ID, transition ID, both source-line IDs, decision-schema version, and either `remove`, `preserve`, or `abstain`. The owner-only UI may show the two local lines and surrounding sentence, but serialized receipts contain no text or path. Replays apply only to the same still-unresolved transition; changed or stale evidence fails closed.
2. Provide three keyboard-accessible local choices—remove the discretionary hyphen, preserve the authored hyphen, or leave unresolved—and immediately recompute canonical text, completeness, preview, EPUB, and structural hashes. Do not provide a geometry-, suffix-, dictionary-, or bibliography-wide bulk action.
3. Generate redistributable gold fixtures for ordinary discretionary breaks, one-off authored compounds, scientific/proper terms, and context-sensitive minimal pairs where identical fragments require opposite decisions. Include out-of-vocabulary and bibliography cases, split labels into frozen calibration and untouched test sets, and report per-class precision, recall, abstention, and deterministic receipt equality.
4. An optional local model may reduce blockers only when its immutable weights, tokenizer, runtime, prompt, locale, and threshold digests are bound into the receipt; identical inputs must produce byte-identical decisions. Promote each `remove` and `preserve` threshold separately only after the untouched per-class holdout demonstrates at least 99.5% precision at 95% confidence with zero critical semantic flips. A small 10–30-case review is useful for discovering fixture classes, but cannot establish that confidence; roughly 600 error-free independent labels are needed for a one-sided 0.5% error bound. Provider unavailability, identity mismatch, low confidence, or disagreement remains `abstain`.

## Free-form response

DOCX already carries inline runs through schema, preview, and EPUB. PDF reconstruction currently emits only plain node text, and no dehyphenation model appears in the source, so the shared downstream support does not make the PDF path semantically complete. Issue 032 binds these local decisions to the privacy-safe `2408.10903v5` end-to-end regression run.

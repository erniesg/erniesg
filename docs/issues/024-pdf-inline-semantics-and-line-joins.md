# Preserve PDF inline semantics and line joins

depends-on: 012,017,023

## Provider

vm-codex

## Goal

Preserve recoverable inline emphasis, hyperlinks, and word boundaries when reconstructing born-digital PDFs, with explicit evidence for every line-join and dehyphenation decision, so text coverage can no longer report success while typographic meaning or words are silently corrupted.

## Acceptance tests

- `src/research/pdf-layout.ts` maps source-backed italic, bold, bold-italic, superscript, and subscript spans into canonical `inlineRuns` only when `PdfSourceRun` font, baseline, and geometry metadata supplies deterministic evidence; ambiguous styling remains plain text with a named diagnostic instead of a guess.
- Embedded PDF link boxes map to safe `http`, `https`, or `mailto` inline link runs when their text intersection is unambiguous; unsafe schemes and unresolved overlaps are rejected. Internal PDF destinations remain explicit unsupported provenance with `UNRESOLVED_HYPERLINK` until a destination-to-canonical-node schema exists.
- Citation markers preserve their source-backed superscript/bracket form and relationship identity without being confused with footnotes. Footnote markers link to typed note bodies and backlinks when issue-012/018 evidence resolves them; an unresolved citation/note distinction remains diagnostic rather than being flattened or guessed.
- Accepted inline ranges are non-overlapping after nesting normalization, preserve Unicode offsets, and render equivalent semantic tags in the studio and EPUB. For every supported style/link/reference denominator, completeness records mapped counts and requires 1.0 coverage before readiness.
- Relative font hierarchy is preserved as a semantic relationship rather than copied absolute PDF point sizes: title > section heading > body, subordinate affiliation/caption/note text remains subordinate, and emphasis never promotes a body run into a heading. Synthetic assertions compare ordered hierarchy classes and bounded ratios, not a specific source font family.
- Line reconstruction records whether each boundary is a space, no-space join, preserved lexical hyphen, removed discretionary line-end hyphen, or unresolved join. Re-importing identical bytes produces identical decisions and canonical text.
- Synthetic fixtures prove that `well-being` and authored dash punctuation survive while a discretionary line-wrap such as `effec-` + `tive` becomes `effective`; a genuine wrapped word is joined only with sufficient lexical and geometric evidence, ligatures and Unicode normalization do not shift inline ranges, and two columns or a heading/body boundary never merge into one paragraph.
- Reconstruction emits no paragraph or heading whose normalized text is one isolated alphabetic glyph created from a split line, author initial, equation label, small-cap run, or page boundary. A legitimate one-glyph source object must remain a typed non-prose node or explicit unresolved diagnostic, never promoted into body flow.
- Small-cap or all-cap styling alone cannot create a heading, repeat the document title, or split one phrase into a large fragment plus detached glyphs. Inline runs with the same source span coalesce once, and accepted canonical spans have no overlapping duplicate character coverage.
- Heading classification requires compatible geometry and syntax: a bounded standalone line with heading-level typography plus section numbering, recognized section-title syntax, or a stable short-line boundary. Font size, boldness, capitalization, or vertical whitespace alone is insufficient, and title/author/abstract boundaries may not be inferred from repeated words.
- Text inside a source region already claimed by a validated table, bounded table fallback, figure, diagram, or display equation is excluded from ordinary prose nodes. Synthetic tests prove table rows and equation glyph runs do not leak into adjacent paragraphs while captions and cross-references remain in reading order.
- Numbered and unnumbered section headings, nested lists, reference entries, and the bibliography heading remain typed structures with stable canonical order. List markers do not become isolated paragraphs, bibliography entries do not merge across columns, and a `References`-like word is a heading only when geometry plus section-boundary syntax agrees.
- The completeness report records `supportedStyledCharacterCount`, `mappedStyledCharacterCount`, per-style supported/mapped span counts, `supportedExternalLinkSpanCount`, `mappedExternalLinkSpanCount`, supported/mapped citation and note-marker counts, `lineBoundaryCount`, `decidedLineBoundaryCount`, `isolatedProseGlyphCount`, `duplicateCanonicalSpanCount`, and `unresolvedCorruptingJoinCount`. Readiness requires 1.0 coverage for every supported-evidence denominator, zero isolated prose glyphs, duplicate spans, unsafe/unresolved supported links, and unresolved corrupting joins; ambiguous unsupported evidence is diagnosed separately and cannot inflate a denominator.
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

## Free-form response

DOCX already carries inline runs through schema, preview, and EPUB. PDF reconstruction currently emits only plain node text, and no dehyphenation model appears in the source, so the shared downstream support does not make the PDF path semantically complete. Issue 032 binds these local decisions to the privacy-safe `2408.10903v5` end-to-end regression run.

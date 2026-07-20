# Make the imported preview match export semantics

depends-on: 013,015,019

## Provider

vm-codex

## Goal

Make the browser studio a truthful pre-export view of an imported PDF or DOCX: render the reconstruction's actual visual assets, semantic tables, inline formatting, links, and note references; do not inject demo annotations into uploaded documents; and do not report an EPUB as ready before its artifacts finish validating.

## Acceptance tests

- `src/components/research/PublicationImporter.tsx` passes the complete `DocumentReconstruction` into `ResearchStudio`; an import preview is no longer rendered from `paper` alone.
- A ready `structured-scientific.pdf` preview renders its matched PNG/SVG or semantic-table content and contains no generic semantic-pipeline placeholder for a source-backed visual.
- Repeated relationship asset ids remain repeated visual occurrences in canonical order; content-addressed asset reuse does not collapse panels.
- A ready `structured-manuscript.docx` preview renders its known bold, italic, hyperlink, and note-reference ranges plus correctly typed footnote/endnote bodies and return links with semantic HTML matching the EPUB rendition.
- A ready scholarly-PDF preview renders source-backed bold, italic, bold-italic, superscript, subscript, safe links, citation markers, footnote references/backlinks, numbered section hierarchy, nested lists, references, and bibliography structure with semantic HTML equivalent to the selected EPUB. Relative title/heading/body/caption/note hierarchy remains meaningful without copying absolute PDF point sizes.
- Figures, diagrams, semantic tables, bounded table fallbacks, display equations, and their complete captions render at the canonical relationship position. Captions retain their full accepted source span, asset/object provenance, and figure/table/equation anchor; they do not float to the top of unrelated prose or disappear while their label remains.
- Continuous Mobile and e-ink EPUB previews follow canonical semantic reading order and never imitate the source PDF's multi-column coordinates. Columns are reconstruction evidence only; reflow emits one coherent reading stream unless a target policy explicitly and truthfully selects a supported semantic multi-column rendition.
- Imported documents open in a continuous `mobile` source-review profile, carry no synthetic highlight or note, and do not auto-scroll to a fabricated reading anchor. Finite profile controls remain unavailable until asset-aware pagination and authoritative profile export land; the authored research demo continues to receive its explicit demo annotations and full preview matrix.
- Preview object URLs are local-only, are revoked when the reconstruction changes or the component unmounts, and never serialize document bytes into logs, manifests, or source markup.
- The available Mobile profile button exposes its selected state with `aria-pressed`, and copy distinguishes the continuous source review from separately validated downloads; the drag-active class resolves to both `publication-dropzone` and `is-dragging`; and the result bar displays `Validating EPUB` until every promised EPUB artifact is built.
- The misleading `Print / PDF` action is absent while the only truthful imported preview is continuous Mobile; issue 026 may restore a print action only when an authoritative paged artifact and matching profile are selected.
- Generated XHTML table assets render from the semantic table already in the graph. XHTML without a valid canonical table receives an explicit unresolved state; the studio has no `<object>`, iframe, or HTML-injection preview path.
- A table region claimed by a semantic table or bounded table fallback is excluded from ordinary paragraph reconstruction. Browser assertions prove row/cell strings do not reappear before or after the rendered table as leaked prose.
- The imported preview rejects canonical prose nodes created only from extraction debris: no paragraph or heading may consist solely of an isolated alphabetic glyph, and a repeated small-cap title fragment may not appear as a second heading or detached body fragment. Legitimate source-backed atomic math remains represented by its equation node rather than a prose exception.
- Selecting a new file always starts a fresh reconstruction and EPUB build, even when the new upload has the same basename, size, or modification time as the previous upload. Tests upload two different byte sequences under one filename and prove the old source hash, object URLs, preview DOM, status, receipts, and download URLs are invalidated before the new result appears.
- The studio previews the checked EPUB rendition for the selected profile, not a separately interpreted paper approximation. It renders that preview before offering an optional matching-profile download, and previewing or switching profiles never initiates a download.
- New test file `src/components/research/ResearchStudio.test.tsx` passes hostile XHTML containing a script and remote pixel and proves neither bytes nor an executable/embedded element enter server-rendered preview markup.
- Browser coverage in `tests/e2e/publication-importer.spec.ts` proves the mobile default, absence of injected annotations, rich inline/reference/note preview, complete anchored captions, real diagram/table/equation preview, canonical one-stream reading order, active drag state, selected-profile semantics, and no premature `EPUB ready` label.

## TDD sequence

1. **Red:** add the hostile-XHTML and semantic-preview cases to `src/components/research/ResearchStudio.test.tsx`, add the import journeys to `tests/e2e/publication-importer.spec.ts`, run `npx vitest run src/components/research/ResearchStudio.test.tsx src/components/research/PublicationImporter.test.tsx`, and preserve the expected failures before implementation.
2. **Green:** wire the complete reconstruction into `ResearchStudio` and implement only the semantic inline/visual rendering, explicit unresolved fallback, local object-URL lifecycle, and import-specific defaults needed to turn those tests green.
3. **Red then green:** add drag-class, accessible selected/focus-state, fresh-same-name upload invalidation, Mobile-only, no-`Print / PDF`, table-prose deduplication, isolated-glyph rejection, and readiness-timing assertions; fix the smallest copy/class/control defects without changing import heuristics or export gates.
4. **Refactor:** extract shared segmentation and safe preview/object-URL helpers only after focused tests pass, then run the full validation command to prove the authored demo and importer behavior remain unchanged.

## Exact-head definition of done

- Every acceptance assertion is automated and passes at the exact PR head; no skipped test, relaxed locator, snapshot rewrite, placeholder visual, or asset-occurrence deduplication hides a failure.
- The focused unit/browser commands and the full validation command below exit 0, and the exact-head evidence manifest records passing build, unit, and browser lanes.
- No active imported HTML path, remote subresource, document byte, local path, secret, or generated evidence artifact enters committed source or issue output.
- From a clean checkout of the immutable PR head, the canonical evidence manifest records `commit` equal to that head, `dirty: false`, `result: passed`, and every required lane; a post-lane clean-worktree check proves validation did not modify tracked or generated source files.
- Preview/export receipts bind the canonical source hash, target profile, toolchain versions, and artifact hashes to that exact head.

## Validation command

```bash
npx vitest run src/components/research/ResearchStudio.test.tsx src/components/research/PublicationImporter.test.tsx
npm test
npm run build
npm run test:e2e -- tests/e2e/publication-importer.spec.ts tests/e2e/srt-visual.spec.ts
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None. Imported bytes and preview object URLs remain inside the local browser session.

## Artifact outputs

Truthful imported-source rendering in `ResearchStudio`, explicit import defaults, object-URL lifecycle cleanup, active-XHTML rejection, accessibility and status-copy fixes, focused unit coverage, and browser regression evidence.

## Stop conditions

Stop before executing imported XHTML as unsandboxed script, displaying a source asset that is not linked by a matched relationship, changing the canonical graph to fit the UI, or claiming that the finite preview is pixel-identical to a reflowable EPUB reader.

## Human clarification protocol

If an imported asset type cannot be rendered safely in the studio, report the media type, current EPUB behavior, and smallest safe preview fallback rather than substituting decorative content.

## Recommended response

Feed the reconstruction evidence already used by `buildEpub` into the existing semantic preview and preserve the static research demo as a separate, explicitly annotated use case.

## Trade-offs

Blob-backed source assets make the preview honest without duplicating bytes in the graph, but finite pagination still uses estimated geometry; cap finite-preview media conservatively and track asset-aware layout as a separate planner concern.

## Free-form response

The exporter already packages source-backed visuals and DOCX inline runs, while the studio currently shows a generic diagram and plain text. That mismatch makes the visible review surface less trustworthy than the downloaded artifact. Issue 032 is the integrated `2408.10903v5` upload-to-preview-to-EPUB regression gate for this contract.

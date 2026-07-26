# Require source-page versus rendered-output evidence at named checkpoints on every SRT pull request

depends-on: 015,021,037

## Provider

vm-codex

## Goal

Make every SRT pull request carry the comparison a reader would make: the source PDF page beside the rendition the reader actually gets, at a named device profile, for named checkpoints the change is claimed to affect. Issue 021 already renders diagnostic overlays on fixtures, but an overlay only shows what the pipeline believes. It cannot show that a figure never arrived, that a caption swallowed the next paragraph, or that a code block lost its structure, because the pipeline does not know those things went wrong.

## Observed gap

A manual source-versus-output comparison on two papers surfaced four reader-visible defects that every existing counter reported as healthy — `textCoverage` was 0.999 on both documents:

- A full-page flowchart is absent from the output while its caption survives. That document declares seven figures and renders none.
- A figure caption absorbed the following column's first sentence, and the body paragraph that sentence belonged to now ends mid-sentence.
- A sentence spanning a column break was split into two paragraph blocks.
- A pseudocode block was flattened into running prose: every character present, zero structure.

None of these appear in any audit metric, diagnostic code, or overlay. They are only visible when the rendered output is put beside the page it came from.

## Acceptance tests

- A single documented command renders, for a named document and page set: the source page raster, and the generated rendition for a named target profile at that profile's width, as deterministic image artifacts.
- Checkpoints are declared, not incidental. A checkpoint names the document, the page, the profile, and the property under test — figure present, caption boundary, prose continuity across a column break, heading level, table structure, code-block structure — so a reviewer knows what to look at and what "correct" means.
- The renderer drives the same export path a reader receives. It never renders a parallel approximation, a studio preview, or raw canonical text.
- Artifacts are emitted into the evidence output alongside the existing lanes and are byte-stable across repeated runs for a fixed source, profile, and toolchain.
- Every SRT pull request that changes reconstruction, layout, visual, or export behaviour carries the checkpoint set its change is claimed to affect, before and after, and the evidence README names which checkpoint each image pair demonstrates and what a reviewer should conclude from it.
- A checkpoint whose property regresses fails the evidence lane. Passing requires the reviewer-visible property to hold, not merely that an image was produced.
- Public fixtures are committed; owner-local papers render only to a caller-named local directory and never into the repository, and no page raster, prose, or local path enters Git, issues, or PR comments.

## TDD sequence

1. **Red:** add the checkpoint schema and a fixture checkpoint set; preserve failures for a missing renderer and an unnamed checkpoint.
2. **Green:** implement the paired renderer over the real export path and wire it into the evidence lanes.
3. **Red then green:** add regression checkpoints for the four observed defects so each fails today and passes when its own issue lands.
4. **Refactor:** fold the manual comparison scripts into the harness so no reviewer has to reproduce them by hand.

## Exact-head definition of done

- The four observed defects each have a named checkpoint that fails on current `main`.
- The evidence lane fails when a checkpoint property regresses.
- From a clean checkout of the immutable PR head, `scripts/agent-evidence --all` records `commit` equal to that head, `dirty: false`, and `result: passed`.

## Validation command

```bash
npx vitest run src/research/diagnostic-overlays.test.ts src/research/epub.test.ts
npm test
npm run build
scripts/agent-evidence --all
```

## Allowed secrets

None. Owner-local papers and their rasters stay outside the repository.

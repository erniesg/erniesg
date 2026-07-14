# ADR 007: SRT Semantic Reading Anchors and Text Annotations

## Status

Accepted for the structured-input annotation proof of concept.

## Context

Finite-height pagination gives every rendition page and fragment geometry, but those values change when the target, available width, typography, or pagination changes. Page numbers and rectangles therefore cannot safely preserve a reader's position or an annotation target. The SRT PRD requires semantic reading anchors, text highlights, anchored notes, and a layout-versioned geometry cache. Its companion literature review recommends Web Annotation-like text selectors and treats freehand attachment as a separate ambiguity problem.

## Decision

`src/research/annotations.ts` owns reader-state selectors and deterministic resolution.

A semantic text anchor stores:

- canonical node ID;
- start and end character offsets;
- exact quote; and
- prefix and suffix context.

It never stores a page number or canonical rectangle. Highlights add appearance; notes add a text body. Both use the same target selector. Rectangles are measured from the rendered text and cached under a layout version containing document version, target, width, height, typography scale, composition policy version, and pagination policy version.

Resolution first accepts the stored offsets only when the exact quote and both contexts still agree. If offsets drift, one quote with matching context resolves. A globally unique exact quote may resolve even if adjacent context changed. Multiple remaining matches produce an `ambiguous` result with every candidate and its context evidence. A missing node, unsupported node, or missing quote produces an `unresolved` result. Neither state attaches to text.

The studio demonstrates one highlight and one anchored note on the same sentence. Target switches and width or font controls recompose the document, scroll the semantic sentence back into view, resolve both annotations again, and replace their browser rectangles for the new layout version. Annotation state does not mutate the canonical paper or layout manifest.

Freehand strokes have a modeled `deferred` policy requiring explicit user choice. This slice does not infer whether a stroke belongs to text, a margin, an object, or a page.

## Consequences

Reading position and text annotations survive changes that invalidate page geometry. Resolution failures are inspectable instead of becoming plausible-looking misattachments. Cached rectangles can drive overlays without becoming annotation source truth, and multiple layout caches can coexist for comparison.

This POC uses JavaScript string offsets, which are UTF-16 code-unit positions, and exact local context. Content normalization, cross-version text migration, grapheme-aware authoring, persistent storage, collaboration, and user-created selection controls remain later work.

## Non-goals

This decision does not implement freehand ink deformation, paragraph-relative margin notes, arbitrary multi-node ranges, automatic choice among ambiguous candidates, translation mapping, collaboration, or a production annotation interchange format.

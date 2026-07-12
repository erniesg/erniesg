# SRT semantic reading anchors and text annotations

depends-on: 005

## Provider

vm-codex

## Goal

Preserve reading position, text highlights, and anchored notes when target geometry, typography, or pagination changes.

## Acceptance tests

- Reading anchors use semantic node ID plus text position/context rather than page number.
- Highlights store exact quote, offsets, prefix/suffix context, and a layout-versioned geometry cache.
- Switching among all four targets keeps the same semantic sentence visible.
- Highlights and notes re-resolve after width, font, and target changes.
- Ambiguous or failed resolution is surfaced; it is never silently attached to the wrong text.

## Validation command

```bash
npm test
npm run build
scripts/agent-evidence --e2e
```

## Allowed secrets

None.

## Artifact outputs

Anchor model, annotation resolver, interaction tests, screenshots, and annotation ADR.

## Stop conditions

Stop before implementing freehand ink deformation or silently choosing among ambiguous quote matches.

## Human clarification protocol

Report the ambiguous selector evidence and recommend either explicit user choice or an unresolved annotation state.

## Recommended response

Implement text highlights and notes only; model freehand attachment policy without building it.

## Trade-offs

Context selectors survive edits better than raw offsets but require explicit ambiguity handling.

## Free-form response

Geometry is a cache, never the annotation source of truth.

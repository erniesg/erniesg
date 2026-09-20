# @erniesg/margin: the client package, text selection and durable anchoring

depends-on: 053

## Provider

claude

## Goal

The browser half of `margin`, as a standalone package at `packages/margin/`
that imports nothing from the book and is publishable to npm as
`@erniesg/margin`. This issue builds the hardest and most reusable part: given
a reader's selection, produce an anchor that still finds the same words after
the page is rewritten.

Anchoring is the make-or-break piece. The book is actively being written —
Parts III-IX are 22 topics still to come — so highlights will face changed
source constantly. An anchor that is a character offset will orphan on the
first edit above it.

## Observed failure

- Nothing exists. `packages/` is not in the repo.
- The margin column added in 053 is an empty landmark with a mount point and
  no behaviour.

## Success criteria

1. `packages/margin/` builds and tests independently, with zero imports from
   `challenges/`, `src/content/` or anything book-specific. A test asserts the
   built bundle contains no book identifiers. It ships as a web component plus
   a plain JS API; the optional React wrapper is a separate entry point.
2. Selection capture works by **keyboard as well as mouse**: a reader
   extending a selection with shift+arrow keys, or selecting with a screen
   reader active, gets the same anchor as a mouse drag. Keyboard selection is
   a first-class path, not a fallback.
3. An anchor carries selectors in priority order:
   - `StructSelector` — the stable block ID from 053, when the document has
     one. Struct owns stable IDs and renders both XHTML and EPUB from the same
     document, so an anchor made on the web edition can resolve in the EPUB.
   - `TextQuoteSelector` — exact quote plus prefix and suffix context.
   - `TextPositionSelector` — character offsets, last resort only.
4. Re-anchoring on load tries the selectors in that order and reports which one
   resolved. When none resolves, the annotation is **orphaned, not silently
   dropped**: it stays in the rail, marked, with its quote readable.
5. Re-anchoring survives realistic edits. Tests cover: text inserted above the
   anchor, the containing paragraph reworded, the anchor's own words unchanged
   but moved to a different block, an identical quote appearing twice in the
   document, and the anchored text deleted outright (which must orphan).
6. Highlight painting handles a selection spanning multiple block elements and
   overlapping highlights, without mutating the book's semantic markup in a
   way that changes what `render.py` produced.
7. The package talks to the service only through the `/api/margin/v1/` surface
   from 054, via an injectable transport so it can be pointed at another host.
   No endpoint is hardcoded.
8. No framework dependency, no CSS framework, and no global style leakage into
   the host page.

## Acceptance tests

- Keyboard-only selection produces an anchor identical to the mouse selection
  of the same range.
- Each of the five edit scenarios in criterion 5 resolves or orphans as
  specified, asserted against real book HTML from `render.py`.
- A duplicate quote resolves to the correct occurrence using prefix/suffix.
- A multi-block selection paints correctly and round-trips to the same anchor.
- The bundle contains no book-specific identifier.
- The transport can be swapped for a stub with no source change.

## Definition of done

`packages/margin/` builds, tests pass including all anchoring scenarios,
the package is publishable (`npm pack` produces a valid tarball), and
selection plus highlight painting work on a real built book page.

## Validation command

```bash
npm --workspace packages/margin test
npm --workspace packages/margin run build
npm test
npm run build
npx playwright test tests/e2e/margin-anchoring.spec.ts
```

## Allowed secrets

None. This code runs in the reader's browser and can hold nothing secret.

## Artifact outputs

`packages/margin/` with its build, its tests and a README documenting the
anchor format; the selection capture; the selector resolution chain; highlight
painting; the injectable transport.

## Stop conditions

Stop before importing anything book-specific into the package, before making
`TextPositionSelector` the primary anchor, before silently discarding an
annotation that fails to re-anchor, and before hardcoding an API origin.

## Human clarification protocol

If a selection shape cannot be anchored durably at all — a selection entirely
inside a generated figure, say — mark that region non-annotatable in the UI
rather than storing an anchor that will orphan on the next build.

## Recommended response

Implement `TextQuoteSelector` resolution with a diff-match-patch style fuzzy
search over the block's text, bounded to the block the `StructSelector` names
when one is present. That combination is what makes re-anchoring survive
rewording without scanning the whole document and hitting false positives.

## Trade-offs

Carrying three selectors per annotation costs storage and makes the payload
verbose. It is the difference between highlights that survive the book being
finished and highlights that do not.

## Free-form response

This is the piece another site would adopt first, and the piece that is
painful to change once annotations exist in a database. It is specified before
any UI for that reason.

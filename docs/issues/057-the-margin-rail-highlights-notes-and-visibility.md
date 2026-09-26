# The margin rail: highlights, colours, notes, and the visibility default

depends-on: 053,054,056

## Provider

claude

## Goal

The third column becomes usable. A reader selects text and gets a small popup
offering a colour or a note; saved items appear in the rail beside the book,
searchable; each carries a public/private state that starts from the reader's
global default and can be changed at any time afterwards.

## Observed failure

- 053 reserved an empty margin column in `ReadingLayout`. 056 can anchor a
  selection but has nowhere to put the result. 054 can store an annotation but
  nothing creates one.
- `ResearchStudio.tsx` (1149 lines) already renders selection, highlights and
  notes, but only for research papers, only in memory, and only for one
  reader. Its interaction patterns are the reference for this rail; its
  single-user, unpersisted scope is what this issue replaces.

## Success criteria

1. Selecting text raises a popup near the selection offering: a colour swatch
   row that saves a `highlighting` annotation, and a note field that saves a
   `commenting` annotation targeting it. These are the W3C motivations 054
   stores, mapped onto the existing internal `kind` values.
   Dismissing the popup saves nothing.
2. The popup is reachable by keyboard: it opens on keyboard selection, is
   fully tab-navigable, traps focus while open, closes on Escape, and returns
   focus to the reader's position in the text.
3. The rail lists this document's annotations in document order, each showing
   its quote and body, with a search box filtering as you type. Clicking one
   scrolls to and flashes its highlight; clicking a highlight focuses its rail
   entry.
4. Every annotation shows and can toggle its visibility. Toggling is immediate,
   reversible, and never rewrites any other annotation.
5. **Global default, individually overridable.** A settings control sets the
   reader's default visibility for new annotations. Changing the default
   affects only annotations created afterwards. A test asserts existing
   annotations are untouched by a default change.
6. Orphaned annotations from 056 appear in the rail in a distinct state with
   their quote readable, and can still be read, edited and deleted. They are
   never hidden and never silently deleted.
7. The rail's presence never shifts the text column, and it collapses below
   1280px into a toggle that opens it as an overlay.
8. Colour is stored as a semantic value, not a hex string baked into markup,
   so a future theme can restyle every existing highlight.

## Acceptance tests

- Keyboard-only: select, open popup, choose a colour, save, find it in the
  rail, toggle its visibility, delete it — without a mouse at any point.
- Creating an annotation with the default set to private stores it private;
  flipping the default to public afterwards leaves it private.
- A private annotation is absent from the API response for a second user, not
  merely hidden in their DOM.
- An orphaned annotation renders in the rail with its quote and remains
  deletable.
- Overlapping highlights of different colours both render and remain
  individually selectable.
- Axe reports no violations on a page with fifty annotations; the rail is
  announced as a landmark and the popup as a dialog.

## Definition of done

All acceptance tests pass; the rail works on a real book page with the service
from 054 behind it; keyboard and screen-reader paths are complete, not partial.

## Validation command

```bash
npm run test:margin
npm test
npm run build
SRT_E2E_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
npx playwright test tests/e2e/margin-rail.spec.ts
```

## Concurrency

This repository runs multiple issue workers on one host. Any command in this
spec that binds a port must choose it per run, never a fixed default, and any
temporary path must be unique per worker. A spec that hardcodes `8787`, `4321`
or a fixed preview port is a spec that cannot be run in parallel with another.
Playwright is the trap worth naming: `playwright.config.ts` reads
`SRT_E2E_PORT` and otherwise binds every run to `1234`, so set that
variable per run rather than inventing a new name for it. Ask the kernel
for a free port rather than sampling a range: with up to 16 workers,
`$RANDOM % 200` collides often enough to fail a correct run.

## Allowed secrets

None.

## Artifact outputs

The selection popup; the rail with search; the visibility control and its
settings surface; colour tokens; accessibility tests.

## Stop conditions

Stop before filtering private annotations in the browser rather than at the
API, before letting a default change rewrite existing rows, before hiding
orphans, and before shipping a mouse-only interaction path.

## Human clarification protocol

If the popup cannot be positioned near a selection that spans a page break or
a scroll boundary, anchor it to the rail entry instead and say so.

## Recommended response

Read `ResearchStudio.tsx` before writing the rail. It has solved selection
handling, highlight painting and note editing for this codebase already; reuse
its approach and, where the code is genuinely general, its code. Build the
colour swatches as semantic tokens named by role rather than by hue, so a dark
theme does not need a second set of annotations.

Once the rail works, `ResearchStudio` should be migrated onto it rather than
left as a second annotation UI. That migration belongs in the IA issue (061),
not here.

## Trade-offs

Semantic colour tokens mean the reader picks from a fixed palette rather than
an arbitrary colour. That is the right constraint for a book that also renders
to EPUB and print, where an arbitrary hex value may be unrenderable.

## Free-form response

The public/private toggle is the feature most likely to be misunderstood as
cosmetic. The client shows the control; 054's query enforces it. Both halves
have to be present or the feature is a lie.

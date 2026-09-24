# A runnable cell must read as one terminal, not three stacked cards

## Provider

claude

## Goal

Make the runnable cell look like a single surface — code, the action that runs
it, and its output — instead of a dark block, a white bar, and another dark
block that happen to sit near each other.

## Observed failure

The cell markup in `render.py:_runnable` emits three siblings:

```html
<div class="cell-run">
  <textarea class="editor small" spellcheck="false">…</textarea>
  <div class="desk-actions"><button class="exec">Run …</button>
    <span class="status"></span></div>
  <pre class="output"></pre>
</div>
```

The first child is an editable **textarea**, not a `<pre>`. And `.desk-actions`
sets `background:#fff` **explicitly** (`preview.py:159-160`) alongside
`border:1px solid var(--line); border-top:0`. The white band is a declaration,
not an inherited page colour, so a fix aimed at inheritance will not move it.

The intent was already there and half-applied:
`.cell-run .output:not(:empty) { margin-top:0; border-radius:0 0 8px 8px; }`
joins the output to whatever is above it — but what is above it is the white
bar.

**Second defect.** The runnable-cell chrome
(`.cell-run`, `.desk-actions`, `.exec`, `.output`) is styled **only** in
`preview.py`'s `STYLE`. `render.py`'s `CONTENT_CSS` — the stylesheet the web
edition ships — has rules for `.cells`/`.cell`/`.cell-label`/`.cell-note`
(figure cells, a different thing entirely) and nothing for the runnable cell.
So a page rendered through `render.py` alone styles no runnable cell. Not a
blocker for 053 — that issue puts runnable cells out of scope and carries no
`depends-on: 063` — but it is why the chrome belongs in `CONTENT_CSS`.

## Success criteria

1. A runnable cell is one visual surface: a single dark container with one
   border radius on the wrapper and none on the children, code at the top, the
   action row in the same dark family separated by a hairline divider rather
   than a filled light band, and output below it.
2. The action row's button remains clearly a button and keeps its `⌘↵` hint
   and its focus ring. **Both the button and `.status` meet WCAG AA.**
   `.status` carries `running...` and error text at `#666`, roughly 3.15:1
   against `#15161a` — under the 4.5:1 threshold — so it is restyled with the
   row, not left behind.
3. Before output exists, the cell ends cleanly after the action row — no empty
   dark panel. `.output:empty { display:none }` already does this; it must
   keep working with the new chrome.
4. **The chrome moves to `render.py`'s `CONTENT_CSS`** so the published web
   edition and the local preview are styled by the same rules. `preview.py`
   keeps only what is genuinely preview-only.
5. Print and EPUB **render** unchanged. Byte identity is not achievable:
   `render.py` defines `PRINT_CSS = CONTENT_CSS + …` and `epub.py:106` writes
   that string to `OEBPS/style.css`, so adding rules to `CONTENT_CSS` changes
   the EPUB stylesheet bytes by construction. Assert rendered equivalence and
   EPUBCheck cleanliness instead.
6. The focus affordance `.editor:focus + .desk-actions { border-color:var(--accent) }`
   survives in whatever form the new chrome takes.

## Acceptance tests

- A visual test at desktop and 375px asserts the cell renders as one
  contiguous surface: no background-colour change between the code block and
  the action row other than the divider.
- A test asserts `CONTENT_CSS` contains the runnable-cell rules and that a
  page rendered through `render.py` alone (no `preview.py`) styles them.
- Contrast of button text against its new background is asserted at AA.
- Keyboard focus survives the restyle. The test focuses the editor and the
  Run button in turn and asserts the computed focus affordance on the new
  dark surface: the button keeps a visible focus ring, and the
  `.editor:focus + .desk-actions` border still appears. No current test
  focuses either element, so the CSS move can silently drop both and still
  pass the visual and contrast checks.
- A cell with no output renders no empty output panel.

## Definition of done

The cell reads as one terminal in both the preview and a `render.py`-only
page, the rules live in `CONTENT_CSS`, and the print edition **renders**
identically. Its bytes will differ — `PRINT_CSS = CONTENT_CSS + …` and
`epub.py:106` writes that into `OEBPS/style.css` — so assert rendered
equivalence and a clean EPUBCheck, not byte stability.

## Validation command

```bash
python3 books/tools/validate.py
npx playwright test tests/e2e/runnable-cell.spec.ts
npm test
```

## Allowed secrets

None.

## Artifact outputs

Runnable-cell chrome in `CONTENT_CSS`; `preview.py` reduced to preview-only
rules; visual and contrast tests.

## Stop conditions

**Scope every new rule under `.cell-run`.** `_desk` — the four-tier grader —
emits the same `.editor`, `.desk-actions`, `.status` and `.output` names, so an
unqualified change silently restyles the grader's toolbar and these tests
would not catch it.

Stop before changing markup structure more than the styling needs; `_runnable`
emits what the executor expects. Stop before touching `.desk` presentation.

## Human clarification protocol

If a dark action row makes the primary button hard to read at any theme, keep
the row dark and restyle the button rather than reverting the row to light.
The band is the defect.

## Recommended response

Move the background to `.cell-run`, strip backgrounds and radii from its
children, and replace `.desk-actions`' `background:#fff` and full border with a
`border-top` hairline — **scoped as `.cell-run .desk-actions`**. A handful of
declarations, and that is the whole fix.

## Trade-offs

A dark action row is less conventional than a light toolbar and gives the Run
button less contrast to work with. It is the right trade here because the cell
is a terminal, and a terminal is one surface.

## Free-form response

The owner's words were that the white bar makes "both parts feel disjoint",
which is exactly what it does: it is the only thing between the code and its
result, and it looks like a page.

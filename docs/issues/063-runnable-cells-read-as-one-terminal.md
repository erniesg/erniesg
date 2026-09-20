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
  <pre><code>…</code></pre>          <!-- dark: pre { background:#15161a } -->
  <div class="desk-actions">…</div>  <!-- light: page background + 1px border -->
  <pre class="output"></pre>         <!-- dark -->
</div>
```

`preview.py` styles `.desk-actions` with `border:1px solid var(--line)` and no
background, so it inherits the page's light background. The result is a white
band cutting between the code and its output, and the two dark blocks read as
unrelated cards rather than one terminal.

The intent was already there and half-applied:
`.cell-run .output:not(:empty) { margin-top:0; border-radius:0 0 8px 8px; }`
joins the output to whatever is above it — but what is above it is the white
bar.

**Second defect, which blocks 053.** The runnable-cell chrome
(`.cell-run`, `.desk-actions`, `.exec`, `.output`) is styled **only** in
`preview.py`'s `STYLE`. `render.py`'s `CONTENT_CSS` — the stylesheet the web
edition ships — has rules for `.cells`/`.cell`/`.cell-label`/`.cell-note`
(figure cells, a different thing entirely) and nothing for the runnable cell.
So when 053 publishes the book through `render.py`, every runnable cell
renders unstyled. The fix belongs in `CONTENT_CSS`, not in `preview.py`.

## Success criteria

1. A runnable cell is one visual surface: a single dark container with one
   border radius on the wrapper and none on the children, code at the top, the
   action row in the same dark family separated by a hairline divider rather
   than a filled light band, and output below it.
2. The action row's button remains clearly a button and keeps its `⌘↵` hint
   and its focus ring. Making the row dark must not make the button ambiguous
   or drop its contrast below WCAG AA.
3. Before output exists, the cell ends cleanly after the action row — no empty
   dark panel. `.output:empty { display:none }` already does this; it must
   keep working with the new chrome.
4. **The chrome moves to `render.py`'s `CONTENT_CSS`** so the published web
   edition and the local preview are styled by the same rules. `preview.py`
   keeps only what is genuinely preview-only.
5. Print is unaffected: the print target has no Run button and its `pre`
   styling stays light.
6. The focus affordance `.editor:focus + .desk-actions { border-color:var(--accent) }`
   survives in whatever form the new chrome takes.

## Acceptance tests

- A visual test at desktop and 375px asserts the cell renders as one
  contiguous surface: no background-colour change between the code block and
  the action row other than the divider.
- A test asserts `CONTENT_CSS` contains the runnable-cell rules and that a
  page rendered through `render.py` alone (no `preview.py`) styles them.
- Contrast of button text against its new background is asserted at AA.
- A cell with no output renders no empty output panel.

## Definition of done

The cell reads as one terminal in both the preview and a `render.py`-only
page, the rules live in `CONTENT_CSS`, and the print edition is byte-identical
to before.

## Validation command

```bash
python3 challenges/tools/validate.py
npx playwright test tests/e2e/runnable-cell.spec.ts
npm test
```

## Allowed secrets

None.

## Artifact outputs

Runnable-cell chrome in `CONTENT_CSS`; `preview.py` reduced to preview-only
rules; visual and contrast tests.

## Stop conditions

Stop before changing the cell's markup structure more than the styling needs —
`_runnable` emits what the executor script expects, and rearranging siblings
will break it. Stop before restyling any other `pre` on the page.

## Human clarification protocol

If a dark action row makes the primary button hard to read at any theme, keep
the row dark and restyle the button rather than reverting the row to light.
The band is the defect.

## Recommended response

Move the background to `.cell-run` itself, strip backgrounds and radii from
its children, and give `.desk-actions` a `border-top` hairline instead of a
full border. That is a handful of declarations and it is the whole fix.

## Trade-offs

A dark action row is less conventional than a light toolbar and gives the Run
button less contrast to work with. It is the right trade here because the cell
is a terminal, and a terminal is one surface.

## Free-form response

The owner's words were that the white bar makes "both parts feel disjoint",
which is exactly what it does: it is the only thing between the code and its
result, and it looks like a page.

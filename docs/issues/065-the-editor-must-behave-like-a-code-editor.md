# The editor must behave like a code editor

## Provider

claude

## Goal

Make the challenge editor usable for writing Python. Today it is a bare
`<textarea>`, so the two keys a Python programmer presses most — Tab and
Enter — do the wrong thing.

## Observed failure

`render.py` emits `<textarea class="editor" spellcheck="false">`. The only
key handling is `preview.py:518`:

```js
editor.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey && !event.shiftKey)) return;
  …
});
```

Everything that is not Enter-with-a-modifier returns immediately, so:

- **Tab moves focus out of the editor.** It is never intercepted, so the
  browser's default focus traversal applies. There is no way to indent.
- **Enter gives column zero.** A textarea's default newline carries no
  indentation, so after `def solve(values):` the caret lands at the margin —
  in the one language where that is a syntax error rather than a style choice.
- **Shift+Enter runs the code and jumps to the next editor.** In every other
  editor on earth Shift+Enter is "newline". A reader reaching for a new line
  loses their place instead.

There is also no indent preservation on Enter, no dedent after `return`/`pass`,
no bracket or quote completion, and no block indent/dedent for a selection.

**Second defect, same workspace.** All 30 `starter.py` files carry this in
their docstring:

```
python3 challenges/tools/grade.py max-pairwise-product
```

That instruction is correct for a reader working from a terminal and wrong
for a reader looking at a Run button and a `⌘↵` hint. `render.py` targets
web and print from one source and should adapt this line the same way it
adapts everything else, rather than showing web readers a command for a
checkout they may not have.

## Success criteria

1. **Tab indents**, Shift+Tab dedents, and both work on a multi-line
   selection. Tab must still be escapable for keyboard users: a single
   Escape, then Tab, moves focus out. Document that affordance visibly.
2. **Enter preserves the current indentation**, and adds one level after a
   line ending in `:`. Backspace at the start of an indented line removes one
   level rather than one space.
3. **Shift+Enter inserts a newline.** Run-and-advance moves to a binding that
   does not collide with a universal expectation; `⌘↵`/`Ctrl+↵` already runs
   and can carry the advance with a modifier.
4. Indentation is spaces, four of them, matching the book's own source.
5. The `grade.py` line renders only in the print/CLI target. The web target
   shows the equivalent affordance it actually has — the Run button and its
   shortcut — from the same source through the existing target switch.
6. No editor library. This is a textarea with key handlers; pulling in a
   full code editor for four keys would cost more than the book's entire
   current JavaScript.

## Acceptance tests

- Tab inserts four spaces; Shift+Tab removes them; both applied across a
  three-line selection indent every line.
- Escape then Tab leaves the editor, so the page stays keyboard-navigable.
- Enter after `def f():` lands the caret four spaces in; Enter after an
  indented line keeps that indent.
- Shift+Enter inserts a newline and runs nothing.
- `⌘↵` still runs.
- A challenge rendered for web contains no `grade.py` command; the same
  challenge rendered for print does.
- Undo (`⌘Z`) after an auto-indent restores the previous state in one step,
  not four.

## Definition of done

A reader can type a complete multi-line Python solution using only Tab and
Enter, the keyboard-escape path is intact, and no `grade.py` instruction
appears in the web edition.

## Validation command

```bash
python3 challenges/tools/validate.py
npx playwright test tests/e2e/editor-keys.spec.ts
npm test
```

## Allowed secrets

None.

## Artifact outputs

Key handling for Tab, Shift+Tab, Enter, Backspace and Shift+Enter; the
rebound run shortcut; the target-aware `grade.py` line; keyboard tests
including the escape path.

## Stop conditions

Stop before adding a code-editor dependency. Stop before trapping Tab with no
escape route — that breaks keyboard navigation for the whole page and is a
worse bug than the one being fixed. Stop before changing the starter files
themselves; the difference is a rendering-target concern.

## Human clarification protocol

If auto-indent and native undo cannot both work in a plain textarea, keep
undo correct and make auto-indent simpler. A reader can fix indentation;
they cannot fix a broken undo.

## Recommended response

Implement with `document.execCommand('insertText')` where available, since it
preserves the native undo stack that manual `value` assignment destroys, with
a `setRangeText` fallback. The undo behaviour is the part most likely to be
got wrong and least likely to be noticed in review.

## Trade-offs

Hand-rolled editing behaviour in a textarea will never match a real editor.
It does not need to: the book asks for a few lines of Python at a time, and
the alternative is a dependency larger than everything the book currently
ships.

## Free-form response

The owner hit both of these within minutes of opening a challenge — "how come
enter does not indent properly" and "i cant seem to be able to use tab inside
the editor". The first thing a reader does in a coding book is type code.

# The hint ladder must show what it costs and what was already read

## Provider

claude

## Goal

Make the support ladder legible at a glance: how much help this challenge
carries, how much of it the reader has spent, and what they already read —
without five identical grey boxes and a sentence describing what is visibly
below it.

## Observed failure

`render.py` emits one `<details>` per hint plus one for the solution, all
styled by the same rule (`render.py:544`):

```css
.hint, .solution { border:1px solid var(--line); border-radius:6px; … }
```

So the reader sees five interchangeable boxes: "Hint 1", "Hint 2", "Hint 3",
"Hint 4", "Worked solution — try a failing test first". Nothing conveys:

- that the ladder is **graded** — hint 1 nudges, hint 4 nearly tells you
- how many the reader has already opened, or which
- that the solution is a different kind of thing from a hint, despite being
  styled identically
- any way to re-read what was already opened without hunting and re-expanding

**The support note is redundant.** For a `guided` challenge, `render.py:393`
prints "Hints if you want them, and a worked solution behind them." directly
above the hints and the worked solution. It describes the affordances the
reader is already looking at. The same is true of the `worked` note. Only
`contract` and `unaided` say something the page does not otherwise show — that
the solution is withheld until the tiers are green — and that belongs on the
locked solution itself, where `locked-solution` already says it.

## Success criteria

1. Hints render as one ladder, not five sibling boxes: a single control
   showing consumption — "2 of 4 hints" — that expands into the ladder.
2. **Spending a hint is visibly a choice with a cost.** Unopened rungs read as
   available; opened ones read as spent and stay open to re-read. The count
   never decreases.
3. Consumption persists for the session, so a reader returning to a challenge
   sees what they already spent rather than a fresh ladder.
4. The worked solution is visually a different kind of thing from a hint —
   it ends the ladder rather than continuing it.
5. **The redundant support note goes.** `worked` and `guided` print nothing;
   the ladder itself carries the information. `contract` and `unaided` keep
   only the part the page does not otherwise show, and `unaided` continues to
   render no hints at all as it does today.
6. Print is unchanged in substance: hints remain sections in document order,
   because a printed page has no disclosure and no consumption.
7. Hint consumption is reader-local. It does not enter the `x/46 · y/30`
   counters and does not gate anything.

## Acceptance tests

- A `guided` challenge renders one ladder control reading "0 of 4 hints" and
  no support paragraph.
- Opening two hints updates the control to "2 of 4"; both stay readable; the
  count does not fall when they are collapsed.
- Reloading the page preserves the count and which rungs were opened.
- **Consumption is per challenge, not per origin.** After opening two rungs
  on one `guided` challenge, a different `guided` challenge with a
  different hint count opens at "0 of N" with every rung collapsed, and
  returning to the first still reads "2 of 4". A single origin-wide
  session-storage record passes the reload test above and fails this one.
- An `unaided` challenge renders no hints and no ladder, and its locked
  solution still explains the unlock condition.
- The print target renders every hint as a section, in order, with no
  disclosure and no counter.
- A `contract` challenge's note says only what the page does not already
  show.

## Definition of done

One ladder replaces five boxes, consumption is visible and persistent, the
redundant notes are gone, and print is unchanged.

## Validation command

```bash
python3 challenges/tools/validate.py
npx playwright test tests/e2e/hint-ladder.spec.ts
npm test
```

## Allowed secrets

None.

## Artifact outputs

The ladder markup and styling in `CONTENT_CSS`; consumption state and its
persistence; removal of the redundant `SUPPORT_NOTES` output; tests for web
and print targets.

## Stop conditions

Stop before gating hints behind anything — the ladder shows a cost, it does
not charge one. Stop before making consumption a score, a streak, or
something that follows the reader between challenges. Stop before changing
what the print target emits.

## Human clarification protocol

If persisting consumption needs storage beyond the reader's own browser, do
not add it. Session-local is the whole requirement; an account-backed hint
history is a different feature with different consequences.

## Recommended response

Make the ladder a single `<details>` whose `<summary>` carries the count, with
the rungs inside it. That keeps the whole thing keyboard-accessible and
print-degradable for free, and it is much less markup than five `<details>`.

## Trade-offs

Collapsing five controls into one adds a click to reach hint 1. That is the
point: the ladder should read as a resource with a cost, not as five buttons
of equal weight sitting between the reader and the answer.

## Free-form response

The owner's words were that the current display "feels like you need some kind
of icon nicely integrated that shows consumption", and separately that the
`guided` note "is redundant". Both are the same observation: the page is
describing its own controls instead of designing them.

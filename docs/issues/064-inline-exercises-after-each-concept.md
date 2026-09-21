# Give the reader something to write before the chapter ends

depends-on: 063

## Provider

claude

## Goal

Add a checkable inline exercise after a concept is introduced, so the loop is
read → try → get told → continue, inside the chapter, rather than read the
whole chapter and then leave the page.

## Observed failure

Measured across the fourteen chapters on 2026-09-21:

- **139 runnable cells.** Every one is finished, worked code the reader presses
  Run on to watch output appear.
- **Zero** of those cells contain a blank, a `TODO`, a `...` or a `pass`. There
  is nowhere in any chapter where the reader writes a line.
- Every chapter ends with a `## Your turn` section whose body is a pointer:
  "Two challenges. The first walks you through it. The second gives you hints
  but no walkthrough." The actual work lives in separate challenge nodes,
  reached through `assessed-by` edges.

So the invitation exists and the affordance does not. A reader can finish a
chapter having typed nothing, and the first time they write code is on a
full challenge with four grading tiers — a large step from a page of worked
examples.

The `:::` block vocabulary confirms the gap: chapters use only `:::figure`.
`statement`, `io`, `constraints` and `sample` all belong to challenge nodes.
There is no block for "try this one line."

## Success criteria

1. A new block kind — `:::exercise` — usable inside a chapter. It carries a
   prompt, a starter with a blank the reader fills, and a check. It is
   deliberately much smaller than a challenge node: one idea, a few lines, no
   tiers.
2. **The check runs in the reader's browser, not on a server.** The existing
   runnable-cell path is not reusable here: `preview.py:767` serves
   `/api/exec`, which runs submitted Python in a subprocess **as the preview
   server's own user**, on localhost only. A temporary working directory and a
   timeout are not a sandbox — that code can read host files, reach the
   network and spawn processes. Publishing it would be arbitrary remote code
   execution, and 053 targets a static Cloudflare build with no such endpoint
   at all.

   So exercises execute client-side (Pyodide or equivalent) or against a
   genuinely isolated service. Never `/api/exec`. It reports pass or fail
   against expected output; it does **not** reuse the four-tier grader, since a
   chapter exercise failing a perf tier teaches the wrong lesson.
3. **A wrong answer teaches.** On failure the reader sees what their code
   produced next to what was expected. A bare "incorrect" is not acceptable.
4. The answer is available but not adjacent — behind the same disclosure the
   chapters already use for hints, so revealing it is a decision.
5. **Print degrades honestly.** `render.py` is the only renderer and the print
   target cannot execute anything, so an exercise prints as the prompt, the
   starter listing, and the answer as a following section — the same treatment
   hints already get in print.
6. Exercises are optional per chapter and carry no progress obligation. The
   `x/46 · y/30 solved` counters stay bound to nodes and challenges; inline
   exercises do not enter them.
7. At least two chapters are converted as proof, chosen where the step to the
   challenge is largest.

## Acceptance tests

- A chapter containing `:::exercise` renders with a fillable starter in the
  web target and a prompt-plus-answer section in the print target, from one
  `render_node` call per target.
- A correct answer reports success; a wrong one shows produced output beside
  expected output.
- Revealing the answer requires an interaction and does not run anything.
- The EPUB still passes EPUBCheck with exercises present.
- `validate.py` accepts a chapter with exercises and rejects a malformed one
  (missing prompt, missing check, or a check that cannot pass).
- Node and challenge counters are unchanged by adding exercises.

## Definition of done

Two chapters carry working inline exercises in web and print, EPUBCheck is
clean, and the validator covers the new block.

## Validation command

```bash
python3 challenges/tools/validate.py
PORT=$((8700 + RANDOM % 200)); python3 challenges/tools/preview.py --port $PORT --no-open &
PREVIEW_PORT=$PORT npx playwright test tests/e2e/inline-exercise.spec.ts
npm test
```

Ports are chosen per run, not fixed, so concurrent workers on one host do not
collide.

## Allowed secrets

None.

## Artifact outputs

The `:::exercise` block in `render.py` for both targets; its checker; the
validator rule; two converted chapters; tests.

## Stop conditions

**Stop before executing reader-submitted code anywhere but a real sandbox.**
`/api/exec` is a localhost development convenience and must never back a
published exercise.

Stop before routing exercises through the four-tier grader. Stop before making
an exercise block anything a reader must complete to proceed. Stop before
adding a second renderer for the interactive part — if the web needs markup
print does not, it goes behind the existing target switch in `render.py`.

## Human clarification protocol

If a concept genuinely cannot be exercised in a few lines, do not invent a
contrived exercise for it. Leave that chapter alone and say which ones were
skipped and why. A chapter with no exercise is better than a chapter with a
fake one.

## Recommended response

Model `:::exercise` on the existing `:::figure` attribute style so authors
learn no new syntax, and implement its check as an expected-output comparison
first. Assertions can come later if expected-output proves too blunt; starting
with assertions would slow every exercise down for a benefit most do not need.

## Trade-offs

Inline exercises make chapters longer and add a second thing that can fail in
the reader's browser. The alternative is the measured status quo: 139 worked
examples, zero lines written, and a cliff at the first challenge.

## Free-form response

The owner's reference was freeCodeCamp — concept, then immediately something
to type. The book already has the harder half built: a sandboxed runner, a
renderer that targets web and print from one source, and a support ladder.
What is missing is the small step between watching and being assessed.

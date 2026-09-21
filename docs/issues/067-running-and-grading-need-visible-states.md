# Running and grading need visible states, not a word that changes

depends-on: 063

## Provider

claude

## Goal

Give running code and grading tiers real feedback — something happening while
it runs, something legible when it passes, something that points at the
problem when it fails.

## Observed failure

All feedback today is one text node being reassigned (`preview.py:472-485`):

```js
button.disabled = true;
status.textContent = 'running...';
output.textContent = '';
…
status.textContent = '';
```

So a run is: the button greys, the word `running...` appears, then everything
is replaced at once. There is no motion while work is happening, no moment of
success, and a failure looks exactly like a pass except the text differs. For
grading, `.tiers` is repopulated wholesale — four tiers resolve as one silent
swap, with no sense that they run in sequence and that the first failure is
the interesting one.

This matters more here than on a normal page: the reader has just written
code and is waiting to find out if they were right. That wait is the moment
the book either teaches or loses them.

## Success criteria

1. A run in flight is visibly in flight, from the moment the button is pressed
   — not a disabled button and a static word.
2. **A pass and a failure are distinguishable before reading any text**, by
   more than colour alone. Colour carries it for readers who see it; shape,
   icon, or position carries it for those who do not.
3. Tiers resolve **in sequence as they complete**, so the reader sees public →
   edge → stress → perf progress and can tell which one broke. A tier that
   never ran is distinct from one that failed.
4. On failure, the first failing tier is what the reader's eye lands on, and
   the output scrolls to the relevant part rather than to the top.
5. All four tiers green is a distinct moment, proportionate to the work —
   noticeable, brief, and not repeated on every subsequent run of an
   already-solved challenge.
6. **`prefers-reduced-motion` is honoured**: every state remains fully
   distinguishable with all motion removed. The states are the feature; the
   animation is the delivery.
7. No animation library. CSS transitions and a small amount of state.

## Acceptance tests

- A run that takes longer than a moment shows in-flight feedback for its
  duration.
- Pass and fail states differ by something other than colour. The test
  asserts the cue itself — a distinct icon, glyph, or geometry present in
  one state and absent in the other — rather than diffing a greyscale
  screenshot, which two colours of differing luminance already pass.
- Tiers appear one at a time as they resolve; a failing second tier leaves
  tiers three and four visibly not-run rather than failed.
- With `prefers-reduced-motion: reduce`, every state is still identifiable and
  nothing animates.
- The success moment fires once on first completion and not on re-runs of an
  already-green challenge, **including after a reload**. The test solves a
  challenge, reloads, and solves it again; the celebration does not
  return. An in-memory flag satisfies the re-run case and fails this one,
  so first-completion state is durable per challenge — `/api/grade`
  already writes `solved` to progress but does not tell the client whether
  this run was the one that added it, and that answer is what the client
  needs.
- A runnable cell whose code raises presents as a failure, not a pass.
  `/api/exec` in `challenges/tools/preview.py` currently answers `200`
  with `{"output": ...}` only and drops `done.returncode`, so the state
  machine cannot tell a traceback from a program that printed one. This
  issue adds a structured outcome to that response and covers a failing
  cell.
- Output and tier regions are announced to assistive technology when they
  change.

## Definition of done

Running, passing and failing are each identifiable at a glance without
reading, tiers resolve in sequence, and reduced-motion loses nothing but
motion.

## Validation command

```bash
python3 challenges/tools/validate.py
npx playwright test tests/e2e/run-feedback.spec.ts
npm test
```

## Allowed secrets

None.

## Artifact outputs

Run and tier state machine; the states in `CONTENT_CSS`; reduced-motion
handling; greyscale and sequencing tests.

## Stop conditions

Stop before celebrating a failure — the success moment fires for all tiers
green and nothing else. Stop before animation that delays feedback; motion
accompanies a result, it never gates it. Stop before adding a dependency.

## Human clarification protocol

If tier-by-tier sequencing requires the grader to stream rather than return
once, say so and ship the sequenced presentation of a single response first.
Streaming is a larger change and should be its own issue.

## Recommended response

Build the state machine first and make every state distinguishable with no
animation at all. Then add motion as an enhancement. Doing it the other way
produces states that are only legible while moving, which fails the
reduced-motion requirement by construction.

## Trade-offs

A success moment risks becoming irritating on a book someone works through
for weeks. Firing once per challenge, on first completion only, is the
compromise.

## Free-form response

The book already runs real code against four tiers of real tests. The reader
currently learns the outcome from a word changing. Everything expensive is
built; what is missing is the half-second that tells them what happened.

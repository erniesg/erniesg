+++
id = "longest-streak"
kind = "challenge"
title = "The streak that ran off the end"
module = "streak"
figure = "stepping-a-loop"
support = "guided"
difficulty = 3

requires = ["ch09-stepping"]
teaches = ["stepping-through-code"]
tags = ["part-1", "debugging", "loops"]

[limits]
time_seconds = 5
memory_mb = 512

[tiers.public]
xp = 10
timeout = 30

[tiers.edge]
xp = 15
timeout = 30

[tiers.stress]
xp = 20
timeout = 60

[tiers.perf]
xp = 5
timeout = 10
+++

:::statement
Someone learning a language ticks off each day they practised. Over 60 days
they want one number: the longest run of days in a row with a tick.

The starter already has an answer written. It is wrong, and the tests show
how. Find out why rather than starting again.

Run it first and read what fails. Then add a `print` inside the loop that shows
the day, the run so far, and the best run so far.
:::

:::io
input: `days`, a list of `True` and `False` — one entry per day, in order
output: the length of the longest unbroken run of `True`, as a whole number
:::

:::constraints
- `0 <= len(days) <= 200,000`.
- Every entry is `True` or `False`.
- An empty list, and a list with no `True` in it, both give `0`.
:::

:::sample
| days | Output | Why |
|---|---|---|
| `[True, True, False, True]` | `2` | the run of two beats the run of one |
| `[True, True, True]` | `3` | every day |
| `[False, True, False, True, True, True, False]` | `3` | the later run wins |
| `[False, False]` | `0` | never started |
| `[]` | `0` | nothing to count |
:::

:::figure{id="stepping-a-loop"}
Print the run so far on every pass, and the wrong line shows up.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Start with a sample the starter gets *right*: `[True, True, False, True]`
gives 2. Now `[True, True, True]` gives 0. Both start with a run of `True`.
What comes after the run in the first list but not in the second?
:::

:::hint{level=2}
Put this inside the loop and run the two samples again:

```python
print("ran", ran, "current", current, "best", best)
```

On `[True, True, True]`, `best` never changes. Find the line that changes it
and check when that line runs.
:::

:::hint{level=3}
`best` is only updated when a `False` arrives. A run that reaches the end of
the list never meets one. Either compare inside the `if ran:` branch, or
compare once more after the loop finishes. Both work.
:::

:::solution
```python
def longest_streak(days):
    best = 0
    current = 0
    for ran in days:
        if ran:
            current += 1
            if current > best:
                best = current
        else:
            current = 0
    return best
```

**What the bug was.** The starter only compared `current` with `best` when a
`False` came along: "the run just ended, so see if it was the best". That
works for every run except the last. A list that ends on `True` has no `False`
after its last run, so that run is never compared. `[True, True, True]`
returned 0 while `current` was 3.

**Why a print finds it faster than reading.** Reading the code shows you what
you meant it to do. Printing `current` and `best` on every pass shows what it
did: `current` goes 1, 2, 3 while `best` stays 0. That gap between the two
values is the bug.

**The fix with no special case at the end.** Comparing inside the `if ran:`
branch updates `best` as soon as `current` changes. Nothing needs to happen
after the loop. The other fix, one more comparison after the loop, also works.
But it puts the comparison in two places, and the next edit has to keep both.

**Why the perf tier is here.** A slow way to solve this is to try every span
of days and check whether it is all `True`. That is correct, but on 200,000
days it would still be running tomorrow. One pass with one counter is
enough.
:::

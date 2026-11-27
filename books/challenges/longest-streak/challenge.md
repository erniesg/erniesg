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

The starter already has an answer written. It is wrong, and the tests will
tell you how. Your job is to find out why, not to rewrite it from nothing.

Run it first and read what fails. Then make it talk: a `print` inside the loop
showing the day, the run so far, and the best run seen. Compare the printed
values with the expected result.
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
Print the current run and best run on every pass to see where they differ.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Start with the sample the starter gets *right*: `[True, True, False, True]`
gives 2. Now `[True, True, True]` gives 0. Both are all-`True` at some point,
so what does the first one do that the second never does?
:::

:::hint{level=2}
Put this inside the loop and run the two samples again:

```python
print("ran", ran, "current", current, "best", best)
```

On `[True, True, True]` the value of `best` never changes. Find the line that
would have changed it and ask when that line runs.
:::

:::hint{level=3}
`best` is only updated when a `False` arrives. A run that reaches the end of
the list never meets one. Either compare inside the `if ran:` branch, or
compare once more after the loop finishes — both work, and one of them is
shorter.
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

**The original missed the last run.** It compared `current` with `best` only
when a `False` arrived. A list ending in `True` has no final `False`, so its
last run was never compared. `[True, True, True]` returned 0 while `current`
reached 3.

**Use a print to inspect the values.** Printing `current` and `best` on every
pass shows `current` climbing 1, 2, 3 while `best` stays 0.

**Update `best` inside the loop.** Comparing inside `if ran:` updates `best`
whenever `current` changes. Comparing once more after the loop also works.

**Use one pass through the list.** Trying every span of days is too slow for
200,000 entries. This solution keeps one running count and one best count.
:::

+++
id = "recent-readings"
kind = "challenge"
title = "The last few readings"
module = "recent"
figure = "two-names-one-list"
support = "worked"
difficulty = 0

requires = ["ch03-lists"]
teaches = ["lists"]
tags = ["part-1", "lists", "slicing"]

[limits]
time_seconds = 5
memory_mb = 512

[tiers.public]
xp = 5
timeout = 30

[tiers.edge]
xp = 5
timeout = 30

[tiers.stress]
xp = 10
timeout = 60

[tiers.perf]
xp = 5
timeout = 5
+++

:::statement
A village water pump logs a reading every hour and keeps all of them — tens of
thousands by now, oldest first. The caretaker has a small screen that shows
the last few.

Given the whole log and how many readings fit on the screen, hand back those
last few, still oldest first.

Two rules from the caretaker. The log must come back exactly as you got it,
and what you hand over has to be a list of its own — she goes on logging while
the screen is up.
:::

:::io
input: `readings`, a list of whole numbers, oldest first; `n`, how many fit on the screen
output: a new list holding the last `n` readings, oldest first
:::

:::constraints
- `0 <= len(readings) <= 200,000`
- `0 <= n <= 1,000`
- If the log holds fewer than `n` readings, hand back all of them.
- `readings` must be unchanged afterwards, and the list you return must not be
  `readings` itself.
:::

:::sample
| readings | n | Output | Why |
|---|---|---|---|
| `[3, 8, 2, 9, 4]` | `2` | `[9, 4]` | the last two, in the order they were taken |
| `[3, 8, 2]` | `7` | `[3, 8, 2]` | a screen bigger than the log |
| `[3, 8, 2]` | `0` | `[]` | an empty screen — and this is the awkward one |
| `[]` | `5` | `[]` | nothing logged yet |
:::

:::figure{id="two-names-one-list"}
A slice is a second list. Handing back the log itself would be one list with
two owners.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
A slice of a list is already a new list, so "leave the log alone" costs you
nothing as long as you slice rather than edit.
:::

:::hint{level=2}
Negative positions count from the end: `readings[-2:]` is the last two. Slices
do not complain about running off the start, so a screen bigger than the log
looks after itself.
:::

:::hint{level=3}
Work out what your code does when `n` is 0, before you run it. `-0` is `0`.
:::

:::solution
```python
def recent(readings, n):
    if n == 0:
        return []
    return readings[-n:]
```

**The slice does most of it.** `readings[-n:]` means "start `n` places from
the end, go to the end". With `n` at 2 and a log of five, that starts at
position 3 and gives `[9, 4]`.

**The screen bigger than the log is already handled.** `[3, 8, 2]` with `n` at
7 asks to start seven places from the end of a three-item list. Rather than
erroring, Python clips the start to the beginning and gives you all three.
This is why no `if` is needed for that case — and worth checking rather than
assuming, because the same generosity is not on offer when you index a single
position: `readings[-7]` on a three-item list is an `IndexError`.

**Now the one that catches everyone.** `-0` and `0` are the same number, so
`readings[-0:]` is `readings[0:]`, which is the whole log. An empty screen
would show every reading ever taken. Nothing in Python will warn you: the
slice is legal, it just answers a different question. So `n == 0` is settled
on its own rung, before any slicing happens, exactly like the divide-by-zero
guard in Chapter 1.

**Why a slice and not the list itself.** Returning `readings` when `n` is
larger than the log would pass every test that only checks the contents — and
then the caretaker's next reading appears on a screen that was supposed to be
a snapshot, because both names point at one list. The edge tier asks `is not`
directly. The habit worth taking away: hand out a slice, keep the original.

**What it costs.** Copying `n` readings, whatever the log's length. That is
why the perf tier, which calls this thousands of times against a log of
200,000, does not notice it — while a solution that copies the whole log each
time to get at its tail runs for seconds.
:::

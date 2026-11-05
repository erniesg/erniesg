+++
id = "how-many-you-beat"
kind = "challenge"
title = "How many riders you beat"
module = "standings"
figure = "counting-the-field"
support = "unaided"
difficulty = 4

requires = ["ch13-sorting"]
teaches = ["sorting"]
tags = ["part-2", "sorting", "counting-sort"]

[limits]
time_seconds = 5
memory_mb = 512

[tiers.public]
xp = 10
timeout = 30

[tiers.edge]
xp = 20
timeout = 30

[tiers.stress]
xp = 25
timeout = 60

[tiers.perf]
xp = 30
timeout = 20
+++

:::statement
The same hill climb, run as an open challenge all season. Anybody can ride it
at any time, and the box at the top records the time. The board now
holds 200,000 ascents.

At the end of the season the club emails everyone a card with one line: *you
were faster than N of this season's ascents.* Every rider gets one, so you
need N for every entry on the board.

Equal times beat nobody. If four people all climbed it in exactly 6:32, none of
them beat another, and all four cards show the same number.

Return the counts in the same order as the ascents you were given. That is the
order the envelopes are printed in.
:::

:::io
input: `times`, a list of whole numbers of hundredths of a second
output: a list of the same length, where position `i` holds how many entries have a time strictly smaller than `times[i]`
:::

:::constraints
- The board holds 0 to 200,000 ascents.
- Each time is a whole number between 0 and 1,000,000.
- Times repeat freely.
- Strictly smaller. An equal time does not count as beaten.
- The output is the same length as the input and in the same order.
- The board you were handed must come back unchanged.
- Answering the question separately for each rider is too slow to pass.
:::

:::sample
| times | Output | Why |
|---|---|---|
| `[300, 100, 200]` | `[2, 0, 1]` | the 300 was beaten by both others |
| `[500, 500, 500]` | `[0, 0, 0]` | three identical climbs, nobody beaten |
| `[1000, 400, 400, 700]` | `[3, 0, 0, 2]` | the two 400s do not beat each other |
| `[]` | `[]` | nobody rode it |
:::

:::figure{id="counting-the-field"}
Times are whole numbers with a known maximum, so each time can be a position in a list.
:::

:::run{starter="starter.py"}
:::

:::solution
```python
def riders_you_beat(times):
    if not times:
        return []
    chalk = [0] * (max(times) + 1)
    for value in times:
        chalk[value] += 1

    faster = 0
    for value in range(len(chalk)):
        here = chalk[value]
        chalk[value] = faster       # everybody strictly below this time
        faster += here

    return [chalk[value] for value in times]
```

**Count the cost first.** Asking "how many are below this one?" for each
rider reads the whole board once per rider: 200,000 × 200,000 = 40
billion comparisons. The ten-million rule says 4,000 seconds. Measured, it is
around twelve minutes. The tier allows three seconds, so the per-rider scan
cannot pass.

**The idea.** Chalk a patch of grass for every time from 0 up to the slowest on
the board, and count how many ascents landed on each. Then walk along the chalk
from fastest to slowest, keeping a running total of everybody you have passed.
When you reach a patch, the running total is the number of ascents strictly
faster than it, so write that total over the count. After this walk, each
rider's answer is one lookup: read the patch at their time.

That is three passes, none inside another: over the board, along the chalk,
and over the board again, so n + k + n steps. With n = 200,000 and k at most
1,000,001, it measures at under three hundredths of a second.

**Why the total is written down *before* the patch's riders are added.** If
you add first, every rider counts themselves and everyone who tied with them.
That breaks the "strictly smaller" rule. Swap those two lines and
`[500, 500, 500]` returns `[3, 3, 3]`.

**Another answer that also passes.** Sorting works too:

```python
def riders_you_beat(times):
    first_at = {}
    for position, value in enumerate(sorted(times)):
        if value not in first_at:
            first_at[value] = position
    return [first_at[value] for value in times]
```

Once the times are in order, the number of entries strictly faster than a
given time is the position where that time *first* appears. `if value not in
first_at` keeps the first position and ignores the rest of a tie. That is the
same "strictly smaller" rule, written another way.

This costs n log n rather than n + k. It measures at about four hundredths of
a second, against two and a half hundredths for the counting version. The gap
is small because the sort runs in C, while the counting loops run in Python.
Which is better depends on k. At times up to a million,
counting is ahead. If times could run to a billion, the counting version would
chalk a billion patches of grass, while the sort would take no longer.

**The empty board.** `max([])` raises `ValueError`, so the counting version
needs one line at the top for the empty case. The `sorted` version never calls
`max`, so it needs no special case. That is a fair reason to prefer it.
:::

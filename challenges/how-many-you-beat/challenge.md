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
whenever they like and the box at the top records the time. The board now holds
200,000 ascents.

The club emails everyone a card at the end of the season, and on the card is
one line: *you were faster than N of this season's ascents.* Every rider gets
one, so the number has to be worked out for every entry on the board.

Equal times beat nobody. If four people all climbed it in exactly 6:32, none of
them was faster than another, and all four cards say the same number.

Return the counts in the same order as the ascents you were given, because
that is the order the envelopes are printed in.
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
Times are whole numbers with a ceiling, which means a time can be a place.
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

**Count it before anything else.** Asking "how many are below this one?" for
each rider means reading the whole board for each rider: 200,000 × 200,000 =
40 billion comparisons. The ten-million rule says 4,000 seconds; measured, it
is around eleven minutes. The tier gives three seconds. So the per-rider scan
is out before you have typed it.

**The idea.** Chalk a patch of grass for every time from 0 up to the slowest on
the board, and count how many ascents landed on each. Then walk along the chalk
from fastest to slowest keeping a running total of everybody you have passed.
When you reach a patch, that running total *is* the number of ascents strictly
faster than it — so overwrite the count with it. After that walk, the answer
for any rider is one lookup: go to their time and read what is written there.

Three passes, none of them inside another: one over the board, one along the
chalk, one over the board again. That is n + k + n, and with n = 200,000 and
k at most 1,000,001 it measures at about five hundredths of a second.

**Why the running total has to be added *after* it is written down.** At each
patch you store `faster` first and only then add the riders standing on that
patch. Add first and every rider counts themselves and everyone who tied with
them, which is exactly the "strictly" the statement keeps insisting on. Swap
those two lines and `[500, 500, 500]` answers `[3, 3, 3]`.

**The other answer, and it also passes.** Sorting works too:

```python
def riders_you_beat(times):
    first_at = {}
    for position, value in enumerate(sorted(times)):
        if value not in first_at:
            first_at[value] = position
    return [first_at[value] for value in times]
```

Once the times are in order, the number of entries strictly faster than a given
time is simply the position where that time *first* appears. `if value not in
first_at` keeps the first one and ignores the rest of a tie, which is the same
"strictly" rule wearing different clothes.

This costs n log n rather than n + k, and it measures at about the same five
hundredths of a second, because its sort happens in C and the counting version
loops in Python. Both are right. Which one is better depends entirely on k: at
times up to a million, counting wins on paper and draws on the clock. If times
could run to a billion, the counting version would try to chalk a billion
patches of grass and the sort would not care at all.

**The empty board.** `max([])` raises `ValueError`, so the empty case needs one
line at the top — or a `sorted` version, which never needs `max` and handles it
without being asked. That is a fair reason to prefer it.
:::

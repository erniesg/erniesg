+++
id = "closest-finish"
kind = "challenge"
title = "The closest two ascents on the board"
module = "timing"
figure = "four-shapes"
support = "contract"
difficulty = 3

requires = ["ch13-sorting"]
teaches = ["sorting"]
tags = ["part-2", "sorting", "sort-then-scan"]

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
xp = 25
timeout = 15
+++

:::statement
A cycling club has timed the same hill climb for twenty years. A box at the
bottom starts your clock, a box at the top stops it, and the board now holds
200,000 ascents.

A salesman is selling the club new timing boxes. The salesman's question:
across the whole board, what is the smallest gap between any two ascents? If
two ascents were four hundredths of a second apart, boxes that only measure tenths have
been ranking those riders wrongly for years.

Each ascent on the board is a rider's number and their time in hundredths of a
second. Return the smallest difference between any two of the times. With
fewer than two ascents there is no gap, so return -1.
:::

:::io
input: `ascents`, a list of `(rider, hundredths)` pairs in no particular order
output: the smallest difference between any two of the times, or -1 for fewer than two ascents
:::

:::constraints
- The board holds 0 to 200,000 ascents.
- `rider` is a whole number between 1 and 1,000,000. The same rider may appear
  many times.
- `hundredths` is a whole number between 0 and 3,000,000.
- Two ascents may share a time. Their gap is 0, and 0 is a valid answer.
- The board you were given must come back unchanged.
- Comparing every ascent with every other is too slow to pass.
:::

:::sample
| ascents | Output | Why |
|---|---|---|
| `[(7, 100), (2, 900), (5, 400)]` | `300` | 100 and 400 |
| `[(9, 40), (4, 55), (1, 42)]` | `2` | 40 and 42 — note the rider numbers say otherwise |
| `[(1, 500), (2, 500)]` | `0` | a dead heat |
| `[(3, 1200)]` | `-1` | one ascent, nothing to compare it with |
| `[]` | `-1` | an empty board |
:::

:::figure{id="four-shapes"}
Comparing every pair of ascents at 200,000 is the bottom row. Sorting first is
the row above it.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Count it before you write it. Every ascent against every other is
200,000 × 200,000 ÷ 2 = 20 billion subtractions. The ten-million rule puts
that at 2,000 seconds, and the perf tier gives you three. So the every-pair
answer is out. The only other method you have met that is faster is a sort.
:::

:::hint{level=2}
Sorting costs about 3.4 million steps. Here is why it is worth it. Once the
times are in order, no other time can sit between the two closest ones. So
they end up **next to each other**, and you only have to look at neighbours.
:::

:::hint{level=3}
Put the times in order. Walk the sorted list once, subtracting each value from
the one after it, and keep the smallest difference. That is one sort and one
pass, with no loop inside a loop.
:::

:::hint{level=4}
`sorted(ascents)` sorts by the wrong thing. The items are pairs, and Python
compares two pairs by their first item, the rider number. It only looks at the time when
two rider numbers are equal. The second sample catches this. Sort the times
themselves, or pass `key=` to say which part to sort by.
:::

:::solution
```python
def closest_ascent(ascents):
    if len(ascents) < 2:
        return -1
    times = sorted(hundredths for _, hundredths in ascents)
    return min(later - earlier for earlier, later in zip(times, times[1:]))
```

**Why neighbours are enough.** Take the two closest times on the whole board.
Put every time in order. Could another time land between those two? If it did,
it would be closer to each of them than they are to each other, and they would
not have been the closest pair. So nothing can be between them: in the sorted
list they are side by side. Checking 199,999 neighbouring pairs answers a
question that looked like it needed 20 billion.

Sorting did not find the answer. It made a slow question cheap, which is
worth its n log n cost.

**Counting it.** Sorting 200,000 numbers is about 3.4 million comparison-steps
and measures at three hundredths of a second, all of it inside C. The walk
afterwards is 200,000 subtractions. The total is under a twentieth of a
second. The every-pair version is also correct, but takes about twenty
minutes.

**The rider numbers.** `sorted(ascents)` runs without error but puts the pairs
in rider-number order. The gaps between neighbours in that order mean nothing,
and the second public sample fails on it.

Two ways to sort by time instead:

```python
times = sorted(hundredths for _, hundredths in ascents)      # take the times
times = [h for _, h in sorted(ascents, key=lambda a: a[1])]  # or name the part
```

The first is shorter and says what it means. The second keeps the riders, so
use it if someone asks *which two riders*.

**Ties need no special case.** Two identical times give `later - earlier` of
0, the smallest gap there can be, and `min` picks it up.

**The empty board.** `len(ascents) < 2` covers both `[]` and a single ascent.
Without it, `min` is given an empty sequence for both, and it raises
`ValueError`. That error is accurate, but it comes from the wrong place.
:::

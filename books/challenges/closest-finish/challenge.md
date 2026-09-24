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

The club is being sold new timing boxes and wants to know whether it needs
them. The question the salesman asked: across the whole board, what is the
smallest gap between any two ascents? If two ascents have ever been four
hundredths of a second apart, gear that can only separate a tenth has been
rounding somebody off the podium for years.

Each ascent on the board is a rider's number and their time in hundredths of a
second. Return the smallest difference between any two of the times. With
fewer than two ascents there is no gap to report, so return -1.
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
- Two ascents may share a time. Their gap is 0, and 0 is a legal answer.
- The board you were handed must come back unchanged.
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
Every pair of ascents at 200,000 is the bottom row. Sorting first is the row
above it.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Count it before you write it. Every ascent against every other is
200,000 × 200,000 ÷ 2 = 20 billion subtractions, which the ten-million rule
calls 2,000 seconds. The perf tier gives you three. So the every-pair answer is
out, and the only other shape in your hands that beats it is a sort.
:::

:::hint{level=2}
Here is the fact that makes sorting worth its 3.4 million steps. If two times
are the closest pair on the board, then once the times are in order there is
nothing that can sit between them. Which means they end up **next to each
other**, and you only ever have to look at neighbours.
:::

:::hint{level=3}
So: put the times in order, then walk the sorted list once, subtracting each
value from the one after it, and keep the smallest difference you see. One
sort, one pass, and no loop inside a loop anywhere.
:::

:::hint{level=4}
`sorted(ascents)` is the trap. These are pairs, and comparing two pairs starts
at the first item — the rider number — and only looks at the time when two
rider numbers are equal. The second sample is on the page to catch exactly
that. Sort the times themselves, or pass `key=` and say which part you mean.
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

This is the shape to remember from this chapter. Sorting did not find the
answer. It made a stupid question cheap, and it is worth its n log n whenever
it does that.

**Counting it.** Sorting 200,000 numbers is about 3.4 million comparison-steps
and measures at three hundredths of a second, all of it inside C. The walk
afterwards is 200,000 subtractions. Total: under a twentieth of a second,
against twenty minutes for the every-pair version — which is correct, and is
still running.

**The rider numbers are the trap, and they are deliberate.** `sorted(ascents)`
compiles perfectly and returns a list in rider-number order. It then reports
the smallest gap between *consecutive rider numbers' times*, which is a real
number about a meaningless thing. The second public sample fails on it and the
first one does not, which is why there are five samples rather than three.

Two honest ways out:

```python
times = sorted(hundredths for _, hundredths in ascents)      # take the times
times = [h for _, h in sorted(ascents, key=lambda a: a[1])]  # or name the part
```

The first is shorter and says what it means. The second is what you want the
moment somebody asks *which two riders*.

**Ties are not a special case.** Two identical times give `later - earlier` of
0, which is the smallest gap there can be, and `min` picks it up without being
told. Code that tests for duplicates first is code that will get the empty
board wrong instead.

**And the empty board.** `len(ascents) < 2` covers both `[]` and a single
ascent. Skip it and `min` is handed an empty sequence and raises
`ValueError: min() arg is an empty sequence` — a good error, in the wrong
place.
:::

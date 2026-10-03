+++
id = "cut-them-all-the-same"
kind = "challenge"
title = "The longest lead they can cut"
module = "cable"
figure = "halving-the-log"
support = "unaided"
difficulty = 4

requires = ["ch14-binary-search"]
teaches = ["binary-search"]
tags = ["part-2", "binary-search", "search-the-answer"]

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
timeout = 15
+++

:::statement
A cable yard buys back the ends. Whatever is left on the drum when a job
finishes comes back, gets measured to the millimetre and goes on the pile. A
year of that is 200,000 pieces, none longer than 20 metres, in whatever order
they arrived.

An order comes in for 150,000 leads. The customer does not care how long they
are, as long as every one is the same length. They pay by the millimetre, so
the longer the yard can cut them, the more it earns.

Each lead has to come out of one piece. You cannot join two ends together, and
a part-lead is worth nothing: a 9,000 mm piece cut into 4,000 mm leads gives
two leads and 1,000 mm of scrap.

How long can the leads be?
:::

:::io
input: `pieces`, a list of whole numbers — the length of each piece in millimetres, in no particular order; and `wanted`, how many identical leads the order needs
output: the largest whole number `length` such that the pieces yield at least `wanted` leads of exactly that length, or `0` if the order cannot be filled at all
:::

:::constraints
- The pile holds 0 to 200,000 pieces.
- Each piece is a whole number of millimetres between 1 and 20,000.
- `wanted` is a whole number between 1 and 1,000,000.
- The pile is not sorted, and sorting it will not help.
- Lead lengths are whole millimetres.
:::

:::sample
| pieces | wanted | Output | Why |
|---|---|---|---|
| `[900, 2000, 1400]` | `4` | `900` | 1 + 2 + 1 = 4 leads of 900 mm; at 901 mm only 3 |
| `[900, 2000, 1400]` | `10` | `400` | 2 + 5 + 3 = 10 leads; at 401 mm only 9 |
| `[900, 1400]` | `3000` | `0` | 2,300 mm in total cannot make 3,000 leads |
| `[]` | `1` | `0` | nothing on the pile |
:::

:::figure{id="halving-the-log"}
The same halving, but what is being halved is not a list. It is every lead
length from 1 mm to the longest piece. The question asked at each step is one
you have to write.
:::

:::run{starter="starter.py"}
:::

:::solution
```python
def longest_lead(pieces, wanted):
    if not pieces:
        return 0

    def leads_at(length):
        return sum(piece // length for piece in pieces)

    low, high, best = 1, max(pieces), 0
    while low <= high:
        mid = (low + high) // 2
        if leads_at(mid) >= wanted:
            best = mid           # this length fills the order; try a longer one
            low = mid + 1
        else:
            high = mid - 1       # too long, and anything longer is worse
    return best
```

**What is being searched.** Sorting the pile tells you nothing about lead
lengths. What you search is the range of possible answers: every whole length
from 1 mm up to the longest piece. Nothing longer than that can yield even one
lead, so `max(pieces)` is the top of the range.

**The question you had to write.** For a given length, how many leads come
off the pile? `piece // length` for each piece, added up. Floor division
counts whole leads and drops the remainder, because a part-lead is worth
nothing. With `/` instead, a pile of 900 mm ends would report half a lead
each.

**Which way the answers run.** Here is the column for the first sample:

| length | leads | fills an order of 4? |
|---|---|---|
| 200 | 21 | yes |
| 900 | 4 | yes |
| 1000 | 3 | no |
| 2000 | 1 | no |

The yeses come first. In the chapter's reading plan they were on the right.
Here they must be on the left, because longer leads can only give you fewer of
them. So a yes means "try longer", which moves `low` up. A no means "too
long", which brings `high` down. If you swap those two, the loop still runs and still returns a number,
but the wrong one. On the first sample it returns 0. When the first length it
tries does fill the order, it returns 1 mm.

**Why `best`.** A length that fills the order may not be the longest that
does, so record it before looking for a better one. When the window closes,
`best` holds the longest length that answered yes. Starting it at 0 also
covers the impossible case. If even 1 mm cannot fill the order, nothing is
ever recorded and 0 is returned.

**The count.** There are 20,000 candidate lengths, so the halving asks the
question fifteen times at most. Each ask is one pass over 200,000 pieces, so
the whole thing is about 3 million steps. Measured, it takes under a tenth of
a second.

You could instead try every length, 1 mm at a time, and stop at the answer. In
the perf tier the answer is 8,325. That is 8,325 passes over 200,000 pieces:
1.7 billion steps, and it measures at around forty seconds. It gives the right
answer, but it is 600 times slower, and the tier allows three seconds.

**Dividing the total does not work.** `sum(pieces) // wanted` divides the
total length by the number of leads, and ignores scrap. On the first sample it
says 4,300 // 4 = 1,075 mm. At 1,075 mm those three pieces yield
0 + 1 + 1 = 2 leads, not 4. Each piece is cut separately, so you cannot
average across them.

**The empty pile.** `max([])` raises `ValueError`, so the guard at the top is
needed. Nothing on the pile means no leads at any length, and the order cannot
be filled.
:::

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
are, as long as every single one is the same length, and pays by the
millimetre — so the longer the yard can cut them, the better the invoice.

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
- The pile is not sorted, and sorting it will not help you here.
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
The same narrowing, but what is being halved is not a list. It is every lead
length from 1 mm to the longest piece — and the question asked at each step is
one you have to write.
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

**There is nothing to search.** The pile is unsorted, and sorting it tells you
nothing about lead lengths. What you are searching is the range of possible
answers: every whole length from 1 mm up to the longest piece on the pile.
Nothing longer than that can yield even one lead, so `max(pieces)` is the top
of the range.

**The question you had to write.** For a given length, how many leads come
off the pile? `piece // length` for each piece, added up. Floor division is
the whole problem statement in one operator: it counts whole leads and throws
the remainder away, which is exactly what "a part-lead is worth nothing"
means. Use `/` instead and a pile of 900 mm ends will cheerfully report half a
lead each.

**Which way the answers run.** Write the column out for the first sample:

| length | leads | fills an order of 4? |
|---|---|---|
| 200 | 21 | yes |
| 900 | 4 | yes |
| 1000 | 3 | no |
| 2000 | 1 | no |

Yes, yes, no, no — the opposite way round from the reading plan in the
chapter, where the yeses were on the right. It has to be this way: making the
leads longer can only ever give you fewer of them. So a yes means "try
longer", which moves `low` up, and a no means "too long", which brings `high`
down. Get those two swapped and the loop still runs, still finishes, and still
returns a number — it just returns the shortest length that works, which is
1 mm, and a 1 mm lead is not an invoice.

**Why `best`.** A length that fills the order is not necessarily the longest
one that does, so write it down before going looking for a better one. When
the window closes, `best` holds the longest length that ever answered yes.
Starting it at 0 also answers the impossible case for free: if even 1 mm
cannot fill the order, nothing was ever written down and 0 comes back.

**The count.** There are 20,000 candidate lengths, so the halving asks the
question fifteen times at most. Each ask is one pass over 200,000 pieces, so
the whole thing is about 3 million steps — measured, under a tenth of a
second.

Try every length instead, 1 mm at a time, and you stop at the answer — which
in the perf tier is 8,325. That is 8,325 passes over 200,000 pieces: 1.7
billion steps, and it measures at around forty seconds. The naive version is
not wrong. It is 600 times slower than the one above, and the tier gives it
three seconds.

**The answer that looks obvious and is not.** `sum(pieces) // wanted` — the
total length divided by the number of leads — ignores scrap. On the first
sample it says 4,300 // 4 = 1,075 mm, and at 1,075 mm those three pieces
yield 0 + 1 + 1 = 2 leads, not 4. You cannot average across pieces that get
cut separately, and no amount of arithmetic will replace asking the question
properly.

**The empty pile.** `max([])` raises `ValueError`, so the guard at the top is
not decoration. Nothing on the pile means no leads at any length, and the
order cannot be filled.
:::

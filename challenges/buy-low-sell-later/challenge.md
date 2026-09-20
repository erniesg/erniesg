+++
id = "buy-low-sell-later"
kind = "challenge"
title = "The most you could have made"
module = "resale"
figure = "four-shapes"
support = "contract"
difficulty = 3

requires = ["ch11-counting-work"]
teaches = ["cost"]
tags = ["part-1", "cost", "one-pass"]

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
A price watcher checks a second-hand marketplace every minute and writes down
the cheapest price anyone is asking for one model of phone. Four months of
that is 200,000 readings, oldest first.

Buy at one reading, sell at a later one. What is the biggest gain you could
have made?

If the price never rises after any reading — or there is nothing to work with —
the answer is 0. You cannot sell before you buy.
:::

:::io
input: `prices`, a list of whole numbers in time order, oldest first
output: the largest `prices[later] - prices[earlier]` where `earlier` comes before `later`, or 0 if that is never positive
:::

:::constraints
- The list holds 0 to 200,000 readings.
- Each price is a whole number between 0 and 1,000,000.
- The buy must come strictly before the sell.
:::

:::sample
| Input | Output | Why |
|---|---|---|
| `[7, 1, 5, 3, 6, 4]` | `5` | buy at 1, sell at 6 |
| `[9, 8, 7]` | `0` | it only ever falls |
| `[3, 3, 3]` | `0` | flat, so nothing to gain |
| `[]` | `0` | nothing to work with |
:::

:::figure{id="four-shapes"}
Every pair of readings at 200,000 is the bottom row of this table. One pass is
the row two above it.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Do the arithmetic before you write anything. Checking every earlier reading
against every later one is 200,000 × 200,000 ÷ 2, which is 20 billion steps.
At ten million steps a second that is 2,000 seconds. Suppose the rule is three
times too gloomy and it is really ten minutes: the perf tier gives you three
seconds. The answer has to be a single pass — one loop, with no loop inside
it.
:::

:::hint{level=2}
Walk the readings once, oldest to newest. At each reading, ask: if I sold
right now, what is the most I could have made? That question has exactly one
answer, and it depends on one thing you have already seen.
:::

:::hint{level=3}
The thing to remember as you go is the cheapest price so far. Today's best
possible gain is today's price minus that. Keep the largest gain you have
seen, and update the cheapest price afterwards — or you will let yourself buy
and sell in the same minute.
:::

:::hint{level=4}
`max(prices) - min(prices)` is the answer that everybody writes first and it is
wrong. Try it on `[9, 1]`: the largest price is 9, the smallest is 1, and it
reports a gain of 8 on a phone that only got cheaper. The sell has to come
after the buy, and `max` and `min` know nothing about order.
:::

:::solution
```python
def best_gain(prices):
    best = 0
    cheapest_so_far = None
    for price in prices:
        if cheapest_so_far is None:
            cheapest_so_far = price
            continue
        if price - cheapest_so_far > best:
            best = price - cheapest_so_far
        if price < cheapest_so_far:
            cheapest_so_far = price
    return best
```

**The idea.** For any reading you might sell at, the best partner is the
cheapest reading anywhere before it. You do not have to search for it: walk
forwards and it is already in your hand. That turns 20 billion comparisons into
200,000, which is the whole lesson of this chapter in one function.

**Why the order of those last two `if`s matters.** Score the sale first, then
update the cheapest. Do it the other way round and a new low price becomes
"the cheapest so far" and is then sold at itself, which is a gain of 0 — no
harm on this problem, but on the next variant it is the bug where you buy and
sell in the same minute. Get into the habit of asking which readings a step is
allowed to see.

**Counting it.** One pass, two comparisons and at most two assignments per
reading. At 200,000 readings that is well under a million steps, and it
measures at a few thousandths of a second. The every-pair version is right
too, and it does not finish.

**What the tiers are checking.** Edge holds `[9, 1]` and a list where the
highest price comes before the lowest, because `max - min` passes the public
samples. Stress races you against the every-pair version on lists of five
numbers, where slow is free and being right is the only thing that counts.
Perf runs one list of 200,000, where the every-pair version is stopped by the
clock rather than by being wrong.
:::

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

If the price never rises after any reading, or there are no readings, the
answer is 0. You cannot sell before you buy.
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
Comparing every pair of readings at 200,000 is the bottom row of this table.
One pass is two rows above it.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Do the arithmetic before you write anything. Checking every earlier reading
against every later one is 200,000 × 200,000 ÷ 2, which is 20 billion steps.
At ten million steps a second that is 2,000 seconds. Even if the rule is three
times too pessimistic, that is about ten minutes, and the perf tier gives you three
seconds. So the answer has to be a single pass: one loop, with no loop inside
it.
:::

:::hint{level=2}
Walk the readings once, oldest first. At each reading, ask: if I sold now,
what is the most I could have made? The answer depends on one thing
you have already seen.
:::

:::hint{level=3}
Keep track of the cheapest price so far. Today's best possible gain is today's
price minus that. Keep the largest gain you have seen. Update the cheapest
price after working out the gain, not before.
:::

:::hint{level=4}
`max(prices) - min(prices)` does not work. Try it on `[9, 1]`: the largest
price is 9 and the smallest is 1, so it reports a gain of 8 on a phone that
only got cheaper. The sell has to come after the buy, and `max` and `min`
ignore order.
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

**The idea.** For any reading you might sell at, the best reading to have
bought at is the cheapest one before it. Walk forwards, remembering the
cheapest so far, and you never have to search for it. That
turns 20 billion comparisons into 200,000.

**The order of the last two `if`s.** Score the sale first, then update the
cheapest. The other way round, a new low price is sold at itself, for a gain
of 0. That does no harm here, but on a variant of this problem it would let you
buy and sell in the same minute.

**Counting it.** One pass does two comparisons and at most two assignments
per reading. At 200,000 readings that is well under a million steps, and it
measures at a few thousandths of a second. The every-pair version is also
correct, but it does not finish in time.

**What the tiers check.** `max - min` passes the public samples. So the edge
tier holds `[9, 1]` and a list where the highest price comes before the
lowest. Stress checks your answer against the every-pair version on small
lists. Perf runs one list of 200,000, where the
every-pair version runs out of time.
:::

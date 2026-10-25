+++
id = "pool-ticket-price"
kind = "challenge"
title = "The price on the door"
module = "ticket"
figure = "one-door-opens"
support = "worked"
difficulty = 0

requires = ["ch02-conditionals"]
teaches = ["conditionals"]
tags = ["part-1", "conditionals", "boundaries"]

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
A swimming pool charges by age. The prices are pinned by the door:

- under 5: free
- 5 to 17: 350 cents
- 18 to 64: 620 cents
- 65 and over: 400 cents

Given an age, return the price in cents.

The ages to check are the ones where one price stops and the next starts, such
as 5 and 65.
:::

:::io
input: `age`, a whole number of years
output: the price in cents, a whole number
:::

:::constraints
- `0 <= age <= 120`
- The answer is always one of `0`, `350`, `620`, `400`.
:::

:::sample
| age | Output | Why |
|---|---|---|
| `4` | `0` | still under 5 |
| `5` | `350` | the first paying age |
| `17` | `350` | the last child price |
| `18` | `620` | full price starts the day you turn 18 |
| `64` | `620` | one year short |
| `65` | `400` | the cheaper price begins |
:::

:::figure{id="one-door-opens"}
Four bands, checked in order. The first rung that fits gives the answer.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Four prices, so four rungs. Handle one band per rung.
:::

:::hint{level=2}
Take the bands in one direction, youngest first or oldest first, and each rung
needs only one test. If you start at the top with `age >= 65`, then at the next
rung you already know the age is under 65.
:::

:::hint{level=3}
Check what your code returns for exactly 5, exactly 18 and exactly 65. A band
that starts *at* 65 needs `>=`, not `>`.
:::

:::solution
```python
def ticket_price(age):
    if age >= 65:
        return 400
    elif age >= 18:
        return 620
    elif age >= 5:
        return 350
    else:
        return 0
```

**Walk it through with 64.** The first test asks `64 >= 65`, which is false,
so Python moves down. The second asks `64 >= 18`, which is true, so it returns
620 and the two rungs below are never checked. This is why the rung for 5 to
17 doesn't test for under 18. It is only reached when `age >= 18` was false.

**Walk it through with 4.** Every test fails, and `else` catches it. Without
that `else`, the function would reach the end and return `None`. That looks
like a free swim until something tries to add it to the till total.

**The boundaries.** `>=` includes the number itself. At exactly 65, the first
rung is true and the price is 400. With `>` instead, a person pays 620 on
their sixty-fifth birthday, and nothing crashes. That is why 4/5, 17/18 and
64/65 are in the sample table and in the edge tier. Mistakes show up at the
edges of a band, not in the middle.

**Why not four separate ifs.** Write it as four `if` statements that each set
a `price` variable, and age 70 passes the 65 rung, then the 18 rung, then the
5 rung. The last one to run wins, so a 70-year-old is charged 350. The
`elif` ladder is what makes "the first band that fits" work.

**Why the order and the operator go together.** Oldest first needs `>=`.
Youngest first needs `<`: `if age < 5: return 0`, then
`elif age < 18: return 350`, and so on. Both are right. If you mix them, with
one rung counting up and the next counting down, a band can end up covered
twice or not at all.
:::

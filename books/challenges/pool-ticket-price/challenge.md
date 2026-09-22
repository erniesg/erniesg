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
A swimming pool charges by age, and the list is pinned by the door:

- under 5: free
- 5 to 17: 350 cents
- 18 to 64: 620 cents
- 65 and over: 400 cents

Given somebody's age, give the price in cents.

The person on the desk types the age in. The two ages that will be typed
wrong are 5 and 65, because that is where one price stops and the next one
starts.
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
Four bands, asked in order. The first rung that fits gives the answer.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Four prices, so four rungs. Deal with one band per rung and let the ladder
handle the rest.
:::

:::hint{level=2}
Take the bands in one direction — youngest first or oldest first — and each
rung only needs one test. If you start at the top with `age >= 65`, then by
the time you reach the next rung you already know the age is under 65.
:::

:::hint{level=3}
Check what your code says for exactly 5, exactly 18 and exactly 65. A band
that starts *at* 65 wants `>=`, not `>`.
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
so nothing happens and Python moves down. The second asks `64 >= 18`: true,
so it returns 620 and the two rungs below are never looked at. That skipping
is the point — the rung for 5 to 17 says nothing about being under 18,
because it is only ever reached when `age >= 18` has already come back false.

**Walk it through with 4.** Every test fails, and `else` catches it. Without
that `else` the function would run off the end and hand back `None`, which
looks like a free swim until something tries to add it to the till total.

**The boundaries.** `>=` includes the number on the sign. At 65 exactly, the
first rung is true and the price is 400. Write `>` instead and a person's
sixty-fifth birthday costs them 620, which is the kind of bug that arrives as
a complaint rather than a crash. That is why 4/5, 17/18 and 64/65 are in the
sample table and in the edge tier: the middle of a band is never where the
mistake is.

**Why not four separate ifs.** Rewrite it as four `if` statements each
setting a `price` variable, and age 70 passes the 65 rung, then the 18 rung,
then the 5 rung. The last one to run wins, so a pensioner is charged 350. The
ladder is not a style choice here; it is what makes "the first band that fits"
mean anything.

**Why the order and the operator go together.** Oldest first needs `>=`.
Youngest first needs `<`, and reads `if age < 5: return 0`, then
`elif age < 18: return 350`, and so on. Both are right. Mixing them — one
rung counting up while its neighbour counts down — is how a band ends up
either covered twice or not at all.
:::

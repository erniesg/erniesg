+++
id = "safe-divide"
kind = "challenge"
title = "Splitting the bill"
module = "split"
figure = "three-kinds"
support = "guided"
difficulty = 1

requires = ["ch01-values"]
teaches = ["values-and-variables"]
tags = ["part-1", "types", "integer-division"]

[limits]
time_seconds = 5
memory_mb = 512

[tiers.public]
xp = 10
timeout = 30

[tiers.edge]
xp = 15
timeout = 30

[tiers.stress]
xp = 20
timeout = 60

[tiers.perf]
xp = 5
timeout = 5
+++

:::statement
A bill comes to some number of cents and a group wants to split it evenly.
Nobody can pay a fraction of a cent, so each person pays a whole number of
cents and whatever is left over is handled by one person.

Return two numbers: what each person pays, and how many cents are left over.

If nobody is there to pay, there is nothing to work out. Return `(0, 0)`.
:::

:::io
input: `cents`, a whole number, and `people`, a whole number
output: a pair — cents each, and cents left over
:::

:::constraints
- `0 <= cents <= 1,000,000`
- `0 <= people <= 1,000`
- With `people` at 0, return `(0, 0)` rather than failing.
:::

:::sample
| cents | people | Output | Why |
|---|---|---|---|
| `100` | `4` | `(25, 0)` | splits evenly |
| `101` | `4` | `(25, 1)` | one cent cannot be split |
| `3` | `5` | `(0, 3)` | nobody gets a whole cent |
| `50` | `0` | `(0, 0)` | nobody to pay |
:::

:::figure{id="three-kinds"}
`/` gives a float, `//` gives the whole part, `%` gives what is left.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Ordinary division gives you `25.25`, which nobody can pay. You want the whole
part and the remainder as two separate numbers.
:::

:::hint{level=2}
`//` gives the whole part of a division and `%` gives the remainder.
`101 // 4` is `25`, and `101 % 4` is `1`.
:::

:::hint{level=3}
Dividing by zero raises `ZeroDivisionError`, so the no-people case has to be
answered before you divide, not after.
:::

:::solution
```python
def split_bill(cents, people):
    if people == 0:
        return (0, 0)
    return (cents // people, cents % people)
```

**Why two operators.** `cents / people` returns a float — `101 / 4` is `25.25`
— and a float cannot say "twenty-five each and one left in the tin". `//` and
`%` answer the two halves of the real question: how many whole cents fit each
person, and what is stranded.

**Why the guard comes first.** Python raises `ZeroDivisionError` the moment you
divide by zero, so no amount of tidying afterwards helps. The edge tier checks
this directly, because "what if there is nobody" is exactly the case a sample
never shows.

**Where the remainder goes.** This function only reports the leftover; it does
not decide who pays it. Keeping that decision out of the arithmetic is what
lets the same function serve a till, a rota and a scoreboard.
:::

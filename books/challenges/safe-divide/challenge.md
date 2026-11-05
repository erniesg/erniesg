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
A group wants to split a bill evenly. The bill is a whole number of cents.
Nobody can pay a fraction of a cent, so each person pays a whole number of
cents. One person covers whatever is left over.

Return two numbers: what each person pays, and how many cents are left over.

If nobody is there to pay, return `(0, 0)`.
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
`101 / 4` gives `25.25`, which nobody can pay. You want the whole part and
the remainder as two separate numbers.
:::

:::hint{level=2}
`//` gives the whole part of a division and `%` gives the remainder.
`101 // 4` is `25`, and `101 % 4` is `1`.
:::

:::hint{level=3}
Dividing by zero raises `ZeroDivisionError`, so check for no people before
you divide.
:::

:::solution
```python
def split_bill(cents, people):
    if people == 0:
        return (0, 0)
    return (cents // people, cents % people)
```

**Why two operators.** `cents / people` returns a float: `101 / 4` is `25.25`.
A float can't say "25 cents each and one cent left over". `//` gives the whole
cents each person pays, and `%` gives the cents left over.

**Why the guard comes first.** Python raises `ZeroDivisionError` as soon as
you divide by zero, so the check has to run before the division. The edge tier
tests it with 0 and 999 cents.

**Where the remainder goes.** This function only reports the leftover. It
does not decide who pays it. Because that decision is left to the caller, the
same function can serve a till, a rota and a scoreboard.
:::

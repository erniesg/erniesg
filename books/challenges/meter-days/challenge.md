+++
id = "meter-days"
kind = "challenge"
title = "How long the credit lasts"
module = "meter"
figure = "running-balance"
support = "contract"
difficulty = 2

requires = ["ch04-loops"]
teaches = ["loops"]
tags = ["part-1", "loops", "while", "counting-the-work"]

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
xp = 15
timeout = 5
+++

:::statement
A prepaid electricity meter holds a number of units of credit and works
through a fixed repeating pattern: `usage[0]` units on the first day,
`usage[1]` on the second, and so on. When the pattern runs out it starts again
from the beginning.

A day is **covered** if, once that day's units have come off, the credit is
still zero or more.

Return how many days in a row are covered, counting from the first day.

If the credit never runs out, return `-1`. That happens exactly when the
pattern uses nothing at all.
:::

:::io
input: `credit`, a whole number of units, and `usage`, a list of whole numbers
output: the number of covered days, or `-1` if the credit never runs out
:::

:::constraints
- `0 <= credit <= 1,000,000,000`
- `usage` holds between 1 and 1,000 numbers.
- `0 <= usage[i] <= 1,000,000`
- A day that uses 0 units is still a day, and it is covered.
- The answer can be a billion. Five seconds is the whole budget, so the answer
  has to come from arithmetic, not from living through every day.
:::

:::sample
| credit | usage | Output | Why |
|---|---|---|---|
| `10` | `[3, 4]` | `3` | 3, 4 and 3 again comes to exactly 10; the next day needs 4 more |
| `0` | `[5]` | `0` | the very first day is already too expensive |
| `6` | `[2, 0, 0]` | `9` | nine days cost 6 in total; day ten needs another 2 |
| `4` | `[0, 0]` | `-1` | a pattern that uses nothing never runs out |
:::

:::figure{id="running-balance"}
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Count the work before you write it. A loop that takes one day at a time is
easy to get right, and with a billion units of credit and one unit a day it
runs a billion times. The perf tier is built around exactly that input.
:::

:::hint{level=2}
One full trip through the pattern always costs `sum(usage)` units and always
covers `len(usage)` days, no matter where in the credit it happens. So the
first question is not "what happens on day one" — it is "how many whole trips
does this credit buy".
:::

:::hint{level=3}
Call the cost of one trip `cycle`. Then `credit // cycle` is the number of
whole trips and `credit % cycle` is what is left once they are paid for. The
leftover is smaller than a whole trip, so walking the pattern once from the
start is enough to finish the count — stop at the first day the leftover
cannot pay for.
:::

:::hint{level=4}
`cycle` can be 0, and `credit // 0` raises `ZeroDivisionError`. Answer that
case before you divide, not after. A pattern costing nothing covers every day
there will ever be, which is what the `-1` is for.
:::

:::solution
```python
def days_of_credit(credit, usage):
    cycle = sum(usage)
    if cycle == 0:
        return -1
    days = (credit // cycle) * len(usage)
    left = credit % cycle
    for amount in usage:
        if amount > left:
            break
        left = left - amount
        days = days + 1
    return days
```

**Skip the trips, walk the remainder.** Every trip through the pattern costs
the same, so you never have to live through one. `credit // cycle` counts the
trips the credit pays for outright, and each of those covers `len(usage)` days.
What is left over, `credit % cycle`, is by definition less than one trip — so
the loop that follows runs at most `len(usage)` times, which the constraints
cap at 1,000. That is the whole difference between a billion steps and a
thousand.

**Why the leftover loop starts from the beginning.** After a whole number of
trips the meter is back at `usage[0]`, exactly where it started. There is no
offset to work out.

**Use `break` when the leftover cannot pay.** `days` already holds the answer
for all full trips. The leftover is less than one full trip, so the loop can
only add part of one cycle.

**Handle a zero-cost pattern first.** When `cycle` is 0, the credit never runs
out and the answer is `-1`. This check must come before `credit // cycle`,
which raises `ZeroDivisionError` for zero.

**The stress tier uses a day-by-day reference.** It compares this arithmetic
against a direct simulation on small credits and patterns.
:::

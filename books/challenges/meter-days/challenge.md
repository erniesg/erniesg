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
A prepaid electricity meter holds some units of credit and uses them in a
fixed, repeating pattern: `usage[0]` units on the first day, `usage[1]` on the
second, and so on. When the pattern runs out, it starts again from the
beginning.

A day is **covered** if the credit is still zero or more after that day's
units come off.

Return how many days in a row are covered, counting from the first day.

If the credit never runs out, return `-1`. That happens only when the pattern
uses nothing at all.
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
- The answer can be a billion, and the time limit is five seconds. The answer
  has to come from arithmetic, not from stepping through every day.
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
Count the steps before you write the loop. A loop that takes one day at a time
is easy to get right. With a billion units of credit and one unit a day, it
runs a billion times. The perf tier uses exactly that input.
:::

:::hint{level=2}
One full trip through the pattern always costs `sum(usage)` units and covers
`len(usage)` days. So start by asking how many whole trips the credit pays
for.
:::

:::hint{level=3}
Call the cost of one trip `cycle`. Then `credit // cycle` is the number of
whole trips, and `credit % cycle` is what is left after paying for them. The
leftover is less than one trip, so one walk through the pattern from the start
finishes the count. Stop at the first day the leftover cannot pay for.
:::

:::hint{level=4}
`cycle` can be 0, and `credit // 0` raises `ZeroDivisionError`. Check for that
case before you divide. A pattern that costs nothing covers every day, and
that is what the `-1` is for.
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
the same, so you don't need to step through any of them. `credit // cycle`
counts the whole trips the credit pays for, and each covers `len(usage)` days.
The leftover, `credit % cycle`, is less than one trip. So the loop after it
runs at most `len(usage)` times, and the constraints cap that at 1,000. That
is a thousand steps instead of a billion.

**Why the leftover loop starts from the beginning.** After a whole number of
trips the meter is back at `usage[0]`, where it started. There is no offset to
work out.

**`break`, not `return`.** The first day the leftover cannot pay for ends the
count, and `days` already includes the trips. Returning in one place is
clearer than returning from two. It also handles a leftover that covers the
*whole* pattern: the loop just finishes. That can't happen here, because the
leftover is always less than a full trip. But code that relies on a fact two
lines away breaks when that line changes.

**A zero pattern needs its own answer.** With `cycle` at 0, no number of days
uses up the credit. There is nothing for the arithmetic to compute and nothing
for a loop to count down. It has to be handled before the division, because
`credit // 0` raises an error. This is the `while` rule from the chapter
again: if nothing in the loop moves its condition towards false, put an `if`
in front of it instead of a loop.

**What the day-by-day version is good for.** It is simple enough to be clearly
right, which makes it a good referee. The stress tier uses it that way: small
credits and small patterns, with your arithmetic checked against a meter that
steps through one day at a time.
:::

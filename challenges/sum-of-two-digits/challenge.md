+++
id = "sum-of-two-digits"
kind = "challenge"
title = "Sum of two digits"
module = "digits"
figure = "reading-a-deal"
difficulty = 0

requires = ["ch00-the-loop"]
tags = ["part-0", "warm-up"]

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
Add two single-digit numbers and return the result.

There is no algorithm to find here. This one is about reading the problem text
exactly, because everything later in the book assumes you can.
:::

:::io
**In:** two whole numbers, `a` and `b`.
**Out:** their sum, as a number.
:::

:::constraints
- `0 <= a <= 9`
- `0 <= b <= 9`
:::

:::sample
| Input | Output |
|---|---|
| `9, 7` | `16` |
| `0, 0` | `0` |
| `9, 9` | `18` |
:::

:::figure{id="reading-a-deal"}
What each line of a problem statement promises you.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Return the sum itself, not text describing it. `16`, never `"The answer is 16"`.
:::

:::solution
```python
def sum_of_two_digits(a, b):
    return a + b
```

The whole lesson is above the code. The statement fixes what arrives (two
numbers, each 0 to 9) and what must leave (one number). Nothing has to guard
against huge values or text input, because the constraints rule them out — and
nothing may decorate the answer, because the output line says a number.
:::

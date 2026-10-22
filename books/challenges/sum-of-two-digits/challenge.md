+++
id = "sum-of-two-digits"
kind = "challenge"
title = "Sum of two digits"
module = "digits"
support = "worked"
difficulty = 0

requires = ["ch00-the-loop"]
teaches = ["the-loop"]
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

There is no algorithm to find here. This one is about reading the problem
text exactly, which every later challenge relies on.
:::

:::io
input: two whole numbers, `a` and `b`
output: their sum, as a number
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

The lesson is in the text above the code. The statement says what comes in
(two numbers, each 0 to 9) and what goes out (one number). The constraints
rule out huge values and text, so the code needs no checks for them. The
output line says a number, so the answer has no added words.
:::

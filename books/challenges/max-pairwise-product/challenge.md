+++
id = "max-pairwise-product"
kind = "challenge"
title = "Biggest product of two"
module = "pairwise"
figure = "two-biggest"
support = "guided"
difficulty = 1

requires = ["ch00-the-loop"]
teaches = ["cost", "testing-debugging"]
instance-of = ["scan-keeping-best-k"]
powers = ["agent-ranking"]
tags = ["part-0", "warm-up", "repeats-trap"]

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
xp = 25
timeout = 120

[tiers.perf]
xp = 30
timeout = 5
+++

:::statement
You get a list of whole numbers, none of them negative. Multiply two of them
to get the biggest result you can.

The two numbers must be at different positions in the list. They may be
equal: two fives at different positions count as two numbers.
:::

:::io
input: `numbers`, a list of whole numbers
output: the largest value of `numbers[i] * numbers[j]` where `i` and `j` are different positions
:::

:::constraints
- The list holds at least 2 numbers and at most 200,000.
- Every number is between 0 and 200,000.
:::

:::sample
| Input | Output | Why |
|---|---|---|
| `[1, 2, 3]` | `6` | The two biggest are 3 and 2 |
| `[0, 0, 7]` | `0` | Only one number above zero, so something must pair with a zero |
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
You do not have to look at every pair. If no number is negative, which two
numbers must give the biggest product?
:::

:::hint{level=2}
Walk the list once, keeping the biggest value so far and the second biggest
so far. When a new value beats the biggest, the old biggest becomes the second
biggest.
:::

:::hint{level=3}
Try `[2, 2]` and `[5, 5, 1]`. If your plan is "find the biggest, remove it,
find the biggest again", remove one copy, not every value equal to it. The
stress tier tests for this.
:::

:::hint{level=4}
```
first = second = -1
for value in numbers:
    if value > first:
        second = first
        first = value
    elif value > second:
        second = value
return first * second
```
:::

:::solution
```python
def max_pairwise_product(numbers):
    first = second = -1
    for value in numbers:
        if value > first:
            first, second = value, first
        elif value > second:
            second = value
    return first * second
```

**Why it is right.** No number is negative, so a product grows when either
factor grows. That makes the two biggest values the best pair. After a full
pass, `first` and `second` hold those two. Each value does one of three
things. It beats `first`, and the old `first` moves down to `second`. It beats
only `second` and replaces it. Or it beats neither, so it is not in the top
two.

Both start at `-1` rather than `0`. With `0`, a list like `[0, 0]` never
enters either branch, so you would multiply two starting values that are not
in the list. Here that still returns 0, but only by chance. In a version
of this problem that allows negative numbers, it would give wrong answers.

**What it costs.** One pass and two variables: 200,000 steps at the largest
allowed size, well inside the limit. Checking every pair instead would be 40
billion multiplications, roughly an hour of Python.

**A wrong answer the samples miss.** `max(numbers)` followed by "remove
everything equal to that value" fails when the biggest value appears twice.
Neither sample repeats a value, so neither catches it. The edge tier catches
it with `[5, 5, 1]`, and the stress tier within its first few random lists.
That is why the tiers exist: code can pass the examples and still be wrong.
:::

:::figure{id="two-biggest"}
:::

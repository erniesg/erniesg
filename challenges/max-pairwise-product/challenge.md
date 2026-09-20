+++
id = "max-pairwise-product"
kind = "challenge"
title = "Biggest product of two"
module = "pairwise"
figure = "two-biggest"
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
together and get the biggest result you can.

The two numbers must sit in different spots in the list. They are allowed to be
equal — two fives in different places are two different numbers as far as this
problem is concerned.
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

:::figure{id="two-biggest"}
One pass over the list, keeping the best two values seen so far.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
You do not have to look at every pair. If no number is negative, which two
numbers must give the biggest product?
:::

:::hint{level=2}
Walk the list once, remembering two things: the biggest value so far, and the
second biggest so far. When a new value beats the biggest, the old biggest
becomes the second biggest.
:::

:::hint{level=3}
Watch `[2, 2]` and `[5, 5, 1]`. If your plan is "find the biggest, remove it,
find the biggest again", make sure you remove one copy and not every value
equal to it. The stress tier is built to catch exactly this.
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
factor grows. The two biggest values are therefore the best pair available.
After a full pass, `first` and `second` hold exactly those two: every value
either beats the champion and pushes it down into second place, or beats only
the runner-up, or beats neither and cannot belong in the top two.

Starting at `-1` rather than `0` matters. With `0`, a list like `[0, 0]` never
enters either branch, and you would multiply two starting values that match no
real element. It returns 0 anyway here, by luck — and that luck runs out the
moment a variant of this problem allows negative numbers.

**What it costs.** One pass and two variables: 200,000 steps at the largest
allowed size, far inside the limit. Checking every pair instead would be 40
billion multiplications, roughly an hour of Python.

**The trap, plainly.** `max(numbers)` followed by "remove everything equal to
that value" is the most common wrong answer, and the samples above will not
catch it — neither one repeats a value. The edge tier does, with `[2, 2]`, and
so does the stress tier within a handful of random lists. That gap between what
an example shows you and what is actually true is the reason the tiers exist.
:::

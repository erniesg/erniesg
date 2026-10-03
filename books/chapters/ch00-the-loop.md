+++
id = "ch00-the-loop"
kind = "concept"
title = "How to solve one of these"
part = "part-0"

teaches = ["problem-statements", "stress-testing", "cost-arithmetic"]
assessed-by = ["sum-of-two-digits", "max-pairwise-product"]
powers = ["agent-test-loop"]
+++

# How to solve one of these

Every challenge in this book takes five steps.

1. **Read the problem.** What goes in? What comes out? How big can it get?
2. **Plan.** Pick your method before you type.
3. **Write it.**
4. **Try to break it.**
5. **Send it in**, read what the grader says, go again.

Step 4 tells you whether your code works in general or only on the example.
Two easy problems show how.

## A warm-up

> **Sum of two digits.** Add two single-digit numbers.
> In: two numbers, `a` and `b`, on one line. Out: their sum.
> Rules: each number is between 0 and 9. Example: `9 7` gives `16`.

This one is about the problem text. The text is a deal: it says exactly what
your code is given and exactly what it must give back.

Both numbers are on **one** line, so read one line and split it. The answer is
the number alone: `16`, not "The answer is 16". Each number is a single digit,
so the input is small.

:::exercise{id="ch00-read-the-deal"}
The two numbers are already here. Print their sum and nothing else.

```python
a = 9
b = 7
# your code here
```

```output
16
```

```answer
a = 9
b = 7
print(a + b)
```
:::

## Now one with a trap

> **Biggest product of two.** You get a bunch of whole numbers, none of them
> negative. Multiply two of them together and get the biggest result you can.
> The two must sit in different spots in the list, though they may be equal.
> Rules: at least 2 numbers, at most 200,000 of them. No number is above
> 200,000. Example: `[1, 2, 3]` gives `6`.

A first idea is to try every pair and keep the best.

```python run
def biggest_product(numbers):
    best = 0
    for i in range(len(numbers)):          # pick one position
        for j in range(len(numbers)):      # pair it with every position
            if i != j:                     # but not with itself
                best = max(best, numbers[i] * numbers[j])
    return best


print(biggest_product([1, 2, 3]))
```

This gives right answers, but it is too slow. You can tell before you run it.

**Count the work first.** Every number is paired with every number. With 10
numbers that is 10 × 10 = 100 pairs. The rules allow 200,000 numbers, and
200,000 × 200,000 is 40 billion pairs.

Python does about 10 million simple steps a second. 40,000,000,000 ÷
10,000,000 = 4,000 seconds, which is over an hour. You get five seconds.

So: multiply the sizes, divide by ten million, and look at the answer. It takes
ten seconds, before you write any code.

**Think again.** None of the numbers are negative, so the biggest product comes
from the two biggest numbers. Find those instead of checking every pair:

```python run
def biggest_product(numbers):
    biggest = max(numbers)                                  # the largest value
    rest = [value for value in numbers if value != biggest] # everything else
    return biggest * max(rest)                              # times the next largest


print(biggest_product([1, 2, 3]))   # 6, as promised
print(biggest_product([5, 5, 1]))   # now try this one
```

This makes two passes through the list, and the example gives 6.

:::exercise{id="ch00-count-the-work"}
A problem allows up to 100,000 numbers. Print how many seconds the every-pair
method would take, at ten million steps a second.

```python
n = 100_000
steps_per_second = 10_000_000
pairs = ...  # how many pairs does every-pair check?
print(pairs // steps_per_second)
```

```output
1000
```

```answer
n = 100_000
steps_per_second = 10_000_000
pairs = n * n
print(pairs // steps_per_second)
```
:::

## Break it

Try it on `[2, 2]`.

`max` finds 2. The middle line keeps everything that is *not* 2, so both
values are dropped. `rest` is empty, and `max` of an empty list is an error.
The program crashes.

Try `[5, 5, 1]`. Both fives are dropped, `rest` is `[1]`, and the result is 5.
The right answer is 25: the two fives are in different spots, and the problem
allows that.

The code drops every copy of the biggest value when it should drop only one.
The two only differ when a value appears twice. The example had no repeats, so
it could not show the bug.

Bugs like this sit on inputs you didn't think of. That is why testing only the
inputs you can think of is not enough.

## Let the computer find the bug

You now have two versions. The every-pair one is slow but clearly right. The
new one is fast but may be wrong. Run both on random lists until they disagree.

```python run
import random

def every_pair(numbers):           # slow, obviously right
    best = 0
    for i in range(len(numbers)):
        for j in range(len(numbers)):
            if i != j:
                best = max(best, numbers[i] * numbers[j])
    return best

while True:
    how_many = random.randint(2, 4)
    numbers = [random.randint(0, 3) for _ in range(how_many)]
    if biggest_product(numbers) != every_pair(numbers):
        print("they disagree on", numbers)
        break
```

**The lists are tiny**: two to four numbers, each between 0 and 3. A failing
example that small can be read at a glance. Small numbers also make repeats
common, and repeats are where this code breaks.

**The slow version is the judge.** You don't have a fast correct answer to test
against; that is what you are trying to write. The slow one is enough, because
the lists are short.

I ran this. It stopped after eleven tries, on `[0, 1, 3, 3]`. My version said 3
and the slow one said 9, because both threes were dropped.

To fix it, walk the list once and keep the two best values as you go:

```python run
def biggest_product(numbers):
    first = second = -1
    for value in numbers:
        if value > first:              # new champion; old champion moves down
            first, second = value, first
        elif value > second:           # not the best, but better than second
            second = value
    return first * second


print(biggest_product([2, 2]), biggest_product([5, 5, 1]))
```

Run the random comparison again and it finds no difference.

## The four tiers

The grader runs these checks for you, in this order, and stops at the first
failure.

**Public**: the examples from the problem. A failure here usually means the
problem was misread.
**Edge**: awkward cases, such as only two numbers, every number the same, or
the largest number allowed.
**Stress**: your code against a slow, simple version on hundreds of small
random lists. When it fails, it shows you the list, like `[0, 1, 3, 3]`.
**Perf**: one list near the size limit. The every-pair version fails here even
though its answers are right.

Speed is checked last because it only matters once the answers are right.

## What the agent does with this

After the agent you build changes code, it has to check its own work. It
can't ask you every time.

It runs the same loop: the existing tests, then awkward cases, then the old
code against the new one on inputs where nothing should have changed, then a
check that nothing got slower.

## Your turn

Two challenges. The first checks that you can read a problem statement. The
second is the one above: write it, try to break it, then fix it. The stress tier
will also try to break it.

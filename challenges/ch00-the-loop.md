+++
id = "ch00-the-loop"
kind = "concept"
title = "How to solve one of these"
part = "part-0"
figure = "four-tiers"

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

Nearly everyone skips step 4. It is the step that decides whether your code
really works or only worked on the example. Two easy problems will show you
why.

## A warm-up

> **Sum of two digits.** Add two single-digit numbers.
> In: two numbers, `a` and `b`, on one line. Out: their sum.
> Rules: each number is between 0 and 9. Example: `9 7` gives `16`.

There is no clever idea here. This one is about the problem text itself, which
is a deal: it tells you exactly what your code will be handed, and exactly what
it must hand back.

Read the deal again. Both numbers sit on **one** line, so read one line and
split it. The answer is a number on its own — not "The answer is 16", just
`16`. Each number has a single digit, so nothing huge is coming.

Most wrong answers are not bad ideas. They are unread problems.

## Now one with a trap

> **Biggest product of two.** You get a bunch of whole numbers, none of them
> negative. Multiply two of them together and get the biggest result you can.
> The two must sit in different spots in the list, though they may be equal.
> Rules: at least 2 numbers, at most 200,000 of them. No number is above
> 200,000. Example: `[1, 2, 3]` gives `6`.

The first idea most people have: try every pair and keep the best.

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

This gives right answers. It is still useless, and you can tell before you run
it.

**Count the work first.** Every number gets paired with every number. With 10
numbers that is 10 × 10 = 100 pairs. Fine. But the rules allow 200,000 numbers,
and 200,000 × 200,000 is 40 billion pairs.

How long is 40 billion multiplications? Python does about 10 million simple
steps each second. Divide: 40,000,000,000 ÷ 10,000,000 = 4,000 seconds. That is
over an hour. You get five seconds.

Here is the habit worth keeping: multiply the sizes, divide by ten million,
look at the answer. It takes ten seconds and it saves you from writing an hour
of code you would have thrown away.

**So think again.** None of the numbers are negative. Multiply two big numbers
and you get a big result, so the answer has to be the two biggest numbers in
the list. Find those instead of checking every pair:

```python run
def biggest_product(numbers):
    biggest = max(numbers)                                  # the largest value
    rest = [value for value in numbers if value != biggest] # everything else
    return biggest * max(rest)                              # times the next largest


print(biggest_product([1, 2, 3]))   # 6, as promised
print(biggest_product([5, 5, 1]))   # now try this one
```

Two quick sweeps through the list. The example gives 6. Looks finished.

## Break it

Try it on `[2, 2]`.

`max` finds 2. The middle line then keeps everything that is *not* 2 — which
throws away both of them. Now `rest` is empty, and asking for the biggest value
in an empty list is an error. Your program crashes.

Try `[5, 5, 1]`. Same trouble, but quieter. Both fives get thrown out, `rest`
is `[1]`, and you get 5. The right answer is 25, because the two fives sit in
different spots and the problem said that was allowed.

Throwing away *the biggest value* and throwing away *one copy of it* are
different things. They only come apart when a value appears twice — and the
example had no repeats, so the example said nothing about it.

That is the lesson. Your bugs hide on the inputs you never pictured, which is
exactly why picturing inputs is a bad way to test.

## Let the computer find the bug

You have two versions now. The every-pair one is slow but obviously right. The
new one is fast and suspicious. So race them on random lists until they
disagree.

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

Two things here are deliberate.

**The lists are tiny** — two to four numbers, each between 0 and 3. A failing
example you can read at a glance is worth far more than a huge one. Small
numbers also mean repeats show up almost immediately, and repeats are exactly
where your code breaks.

**The slow version is the judge.** You don't need a fast correct answer to test
against; that's the thing you're trying to write. You need an obvious one, and
slow doesn't matter when the list has four numbers in it.

I ran this. It stopped after eleven tries, on `[0, 1, 3, 3]`. My version said 3.
The slow one said 9. Two threes — one of them deleted along with the other. One
second of computer time, and it handed me the smallest example that proves I
was wrong.

Now fix it. Walk the list once and remember the best two values as you go:

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

`[2, 2]` gives 4. `[5, 5, 1]` gives 25. Start the race again and it stays
quiet.

:::figure{id="four-tiers"}
The four tiers, and what each one is looking for.
:::

## The four tiers

The grader runs that same idea for you, in this order, stopping at the first
failure.

**Public** — the examples from the problem. Red here means you misread the
deal.
**Edge** — the awkward cases: only two numbers, every number the same, the
largest number allowed.
**Stress** — your code against the obvious slow one, on hundreds of small
random lists. When it fails, it shows you the list, like `[0, 1, 3, 3]`.
**Perf** — one list near the size limit. The every-pair version dies here
however correct it is.

The order matters. Hearing that your code is too slow helps nobody while it is
still wrong on `[2, 2]`.

## What the agent does with this

The agent you build has to check its own work after it changes code. It can't
ask you every time.

So it runs this same loop: the tests that already exist, then the awkward
cases, then the old code against the new one on inputs where nothing should
have changed, then a check that it hasn't quietly made something slow.

You're teaching it a habit. Hard to teach one you don't have.

## Your turn

Two challenges. The first checks you can read a deal. The second is the one
above — write it, break it yourself, then fix it. The stress tier will try
either way. Better that it finds nothing.

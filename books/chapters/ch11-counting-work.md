+++
id = "ch11-counting-work"
kind = "concept"
title = "Counting work"
figure = "four-shapes"

teaches = ["cost"]
requires = ["ch10-idioms"]
assessed-by = ["buy-low-sell-later", "seen-more-than-once"]
powers = ["agent-cost-budget"]
+++

A town library has 40,000 books on its shelves and 200,000 borrowing records
from last year. A librarian wants one list: the books nobody borrowed, so she
knows what to move to the sale table.

The first version takes each book and looks through the records for it. That
is 40,000 books against 200,000 records: 8,000,000,000 comparisons. Python does
roughly ten million simple steps a second, so that is 800 seconds, about
thirteen minutes.

The second version reads the records once and puts each borrowed title into a
set, then checks each book against the set. That is 200,000 steps, then 40,000
more. 240,000 in total, about a fiftieth of a second.

Both run on the same laptop and answer the same question. You can work out the
difference before running either one, with a little arithmetic.

## Count the steps before you run anything

Here is the first version at a small size, with a step counter:

```python run
records = ["dune", "emma", "emma", "hamlet"]
books = ["dune", "emma", "hamlet", "ivanhoe", "kidnapped"]

steps = 0
never_borrowed = []
for book in books:
    found = False
    for record in records:
        steps += 1
        if record == book:
            found = True
            break
    if not found:
        never_borrowed.append(book)

print(never_borrowed, "found in", steps, "steps")
```

Four records and five books take 15 steps rather than the full 20, because the
search for a borrowed book stops when it finds it. `ivanhoe` and `kidnapped`
were never borrowed, so each scans every record. The books you are looking for
are the ones that cost the most.

The second version, counted the same way:

```python run
steps = 0
borrowed = set()
for record in records:
    steps += 1
    borrowed.add(record)

never_borrowed = []
for book in books:
    steps += 1
    if book not in borrowed:
        never_borrowed.append(book)

print(never_borrowed, "found in", steps, "steps")
```

Same answer, 9 steps instead of 15. At this size the difference doesn't
matter.

To see the real size, multiply instead of running it. The first version is
books × records in the worst case. The second is records + books:

```python run
books, records = 40_000, 200_000
print("every book against every record:", books * records)
print("one pass, then look up:         ", records + books)
print("times more work:                ", books * records // (records + books))
```

The first version does about 33,000 times the work. Finding that out took one
multiplication and one addition.

:::exercise{id="ch11-price-it-first"}
50,000 books against 50,000 records. Print the rough seconds for the
every-pair version, then for the one-pass-and-a-set version.

```python
books, records = 50_000, 50_000
steps_per_second = 10_000_000
# your code here
```

```output
250
0.01
```

```answer
books, records = 50_000, 50_000
steps_per_second = 10_000_000
print(books * records // steps_per_second)
print((books + records) / steps_per_second)
```
:::

## The rule: multiply the bounds, divide by ten million

1. Find the loops. Write down how many times each one runs at the largest size
   the problem allows.
2. Multiply them together.
3. Divide by ten million. That is roughly your seconds.

The ten million comes from measuring:

```python run
import time

numbers = list(range(2_000_000))

started = time.perf_counter()
total = 0
for value in range(2_000_000):
    total += value
bare = time.perf_counter() - started

started = time.perf_counter()
biggest = 0
for position in range(2_000_000):
    value = numbers[position] * 3
    if value > biggest:
        biggest = value
real = time.perf_counter() - started

print(f"2 million bare additions: {bare:.2f}s")
print(f"2 million steps of real work: {real:.2f}s")
print(f"real work: {2_000_000 / real / 1_000_000:.0f} million steps a second")
```

On the machine this chapter was written on, the bare additions ran at 15 to 20
million a second. The second loop looks up a list item, multiplies and
compares, like a real loop body, and it ran at almost exactly ten million.
Yours will print different numbers.

Ten million is the only number to remember. It can be out by a factor of two or
three either way: a loop that does almost nothing runs faster, and one that
builds text or calls functions runs slower. So it can't tell 0.3 seconds from
0.8.

It does tell a fraction of a second from half an hour. That is the decision
you are making, and a factor of three doesn't change it.

## Four shapes, and what each feels like

Almost everything you write in this book has one of four shapes.

**Constant.** The work does not depend on how much data there is. Examples:
looking one thing up in a dictionary, or reading the first item of a list. One
step, whether there are 10 things or 200,000.

**One pass — n.** Look at each thing once. Adding up a list, finding the
largest value, dropping everything into a set.

**Sorting-shaped — n log n.** Each item is looked at about as many times as you
can halve n before you reach 1. Count the halvings:

```python run
def halvings(n):
    count = 0
    while n > 1:
        n = n // 2
        count += 1
    return count


for n in (10, 1_000, 200_000):
    print(f"n = {n:>7}   halvings: {halvings(n):>2}   "
          f"steps: {n * halvings(n):>12,}")
```

Seventeen passes over 200,000 things is about three and a half million steps.
That is what `sorted` costs, and it is much closer to one pass than to every
pair.

**Every pair — n squared.** Two loops, the inner one running the full length
for each turn of the outer one. "Compare everything with everything" is how a
person would do it with index cards, so it is often the first version people
write.

:::figure{id="four-shapes"}
:::

In the bottom row, 40 billion steps is about 4,000 seconds, over an hour. The
row above it, for the same 200,000 things, is a third of a second. The
difference is one loop inside another.

:::exercise{id="ch11-any-repeats"}
Write `has_repeat` in one pass. Keep what you have seen in a set, and answer
as soon as a value appears a second time.

```python
def has_repeat(values):
    # your code here
    ...


print(has_repeat([3, 1, 4, 1, 5]))
print(has_repeat([2, 7, 1, 8]))
print(has_repeat([]))
```

```output
True
False
False
```

```answer
def has_repeat(values):
    seen = set()
    for value in values:
        if value in seen:
            return True
        seen.add(value)
    return False


print(has_repeat([3, 1, 4, 1, 5]))
print(has_repeat([2, 7, 1, 8]))
print(has_repeat([]))
```
:::

## The difference only shows up when n grows

Here is the same question, "is this value in here?", asked of a list and of a
set at three sizes:

```python run
import time

LOOKUPS = 2_000


def seconds_for(container, value):
    started = time.perf_counter()
    for _ in range(LOOKUPS):
        value in container
    return time.perf_counter() - started


for n in (10, 1_000, 20_000):
    values = list(range(n))
    as_set = set(values)
    list_time = seconds_for(values, -1)
    set_time = seconds_for(as_set, -1)
    print(f"n = {n:>6}   list {list_time:.4f}s   set {set_time:.4f}s")
```

At ten items the list is fine. Two thousand lookups take a tiny fraction of a
second either way, and the list is what you already had.

The list column grows with n: twenty times the data takes about twenty times as
long, because a list is searched by walking it. The set column stays near zero,
because a set lookup does not depend on how much is in it. At 20,000 items the
same 2,000 questions take a noticeable fraction of a second with the list and
almost nothing with the set.

So "always use the faster one" is not the rule. A shape describes what happens
as n grows. Below a few hundred items the shapes cost about the same, so pick
whichever code reads better. Above a few thousand, the shape decides the time.

The question to ask is "how big does n get?" The answer is in the problem's
constraints, so read the constraint line first.

:::exercise{id="ch11-pair-to-target"}
Is there a pair at two different positions that adds up to `target`? Checking
every pair is n squared. One pass is enough: for each value, check whether its
partner has already appeared.

```python
def pair_adds_to(values, target):
    # your code here
    ...


print(pair_adds_to([8, 3, 5, 11], 16))
print(pair_adds_to([4, 6], 8))
print(pair_adds_to([4, 4], 8))
```

```output
True
False
True
```

```answer
def pair_adds_to(values, target):
    seen = set()
    for value in values:
        if target - value in seen:
            return True
        seen.add(value)
    return False


print(pair_adds_to([8, 3, 5, 11], 16))
print(pair_adds_to([4, 6], 8))
print(pair_adds_to([4, 4], 8))
```
:::

## The clock is a worse witness than the count

Time the same work five times and you get five answers:

```python run
import time


def work():
    started = time.perf_counter()
    total = 0
    for value in range(2_000_000):
        total += value * 2
    return time.perf_counter() - started


runs = [work() for _ in range(5)]
print("   ".join(f"{seconds:.3f}s" for seconds in runs))
print(f"fastest to slowest: {(max(runs) - min(runs)) / min(runs) * 100:.0f}% apart")
```

On a quiet machine the runs are a few percent apart. With other programs
running, or on a slower laptop, the same loop can take two or three times as
long. A time you measure depends on the machine and what else it is doing, so
it doesn't carry over to anyone else's.

The step count does not change. `40,000 × 200,000` is 8 billion on any
machine. So count first, and use the clock to confirm the count. If a
measurement surprises you, the count missed something. Usually it is a line
that walks a whole list without looking like a loop, such as
`value in some_list` or `some_list.remove(value)`.

## What this buys the agent

The agent searches a repository for you. Suppose it holds 200,000 lines of
code and you ask forty questions in a session.

Reading every line for every question is 8 million line comparisons per
session, and every answer waits for its scan. Reading every line for every
*symbol* it wants to check multiplies into the billions, and a question takes
forty seconds instead of one.

Instead, build an index once: a dictionary from every name to the lines that
mention it. Then each question is a lookup. Building it costs 200,000 steps
once. After that, a question's cost no longer depends on the size of the
repository.

The agent can't make that choice for itself. Whoever writes it has to do the
arithmetic.

## Your turn

Two challenges. Each has an obvious answer with a loop inside a loop. That
answer is correct, but it can't finish at the size the problem allows, and the
perf tier will fail it. Do the multiplication before you write anything.

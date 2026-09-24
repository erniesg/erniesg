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

The first version written takes each book and looks through the records for
it. That is 40,000 books against 200,000 records: 8,000,000,000 comparisons.
Python gets through something like ten million simple steps a second, so that
is 800 seconds. Thirteen minutes of a spinning cursor, for a question about a
sale table.

The second version reads the records once and drops each borrowed title into a
set, then checks each book against the set. That is 200,000 steps, then 40,000
more. 240,000 in total — a fiftieth of a second.

Same laptop, same library, same question. The gap was decided before either
version ran, by an arithmetic that fits on the back of a receipt.

## Count the steps before you run anything

Here is the first version, small enough to watch, with a counter wired in:

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

Four records, five books, and the counter says 15 rather than the full 20,
because the borrowed books stop early. Notice which books do not stop early:
`ivanhoe` and `kidnapped` scan every record before giving up. The books you are
asking about are exactly the ones that cost full price.

Now the second version, counted the same way:

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

Same answer, 9 steps instead of 15. At this size the difference is nothing —
you would not walk across the room for it.

Do not run it at the real size. Multiply instead. The first version is books ×
records in the worst case; the second is records + books:

```python run
books, records = 40_000, 200_000
print("every book against every record:", books * records)
print("one pass, then look up:         ", records + books)
print("times more work:                ", books * records // (records + books))
```

33,000 times the work, for an answer a set gets to in a fiftieth of a second.
That number came out of two multiplications and cost nothing to find.

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

That is the whole habit.

1. Find the loops. Write down how many times each one runs at the largest size
   the problem allows.
2. Multiply them together.
3. Divide by ten million. That is roughly your seconds.

Where does ten million come from? Measure it:

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

On the machine this chapter was written on, the bare additions run at 15 to 20
million a second, and the second loop — which looks up a list item, multiplies
and compares, the way a real loop body does — lands almost exactly on ten
million. Yours will print different numbers.

Ten million is the only number you need to memorise. It can be out by a
factor of two or three in either direction — a loop that does almost nothing
runs faster, and one that builds text or calls functions runs slower. It will
never tell you whether something takes 0.3 seconds or 0.8.

What it does tell you, reliably, is whether you are looking at a fraction of a
second or at half an hour. That is the decision you are actually making, and
being out by a factor of three does not change the answer to it.

## Four shapes, and what each feels like

Almost everything you write in this book will have one of four shapes.

**Constant.** The work does not depend on how much data there is. Looking one
thing up in a dictionary. Reading the first item of a list. One step, whether
there are 10 things or 200,000.

**One pass — n.** Look at each thing once. Adding up a list, finding the
largest value, dropping everything into a set.

**Sorting-shaped — n log n.** Each item gets looked at about as many times as
you can halve n before you reach 1. Count the halvings:

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

Seventeen passes over 200,000 things — call it three and a half million steps.
That is what `sorted` costs you, and it is much closer to one pass than to
every pair.

**Every pair — n squared.** Two loops, the inner one running the full length
for each turn of the outer one. This is the shape that kills you, and it is
also the shape you reach for first, because "compare everything with
everything" is how a person would do it with index cards.

:::figure{id="four-shapes"}
:::

Read the bottom row of that table again. 40 billion steps is about 4,000
seconds: over an hour. The row above it, for the same 200,000 things, is a
third of a second. Nobody in this story wrote slow code — one of them wrote a
loop inside a loop.

:::exercise{id="ch11-any-repeats"}
Write `has_repeat` in one pass: remember what you have seen in a set, and
answer as soon as something comes round twice.

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

Here is the same question asked of a list and of a set, at three sizes. Both
answer "is this value in here?"

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

At ten items the list is fine. Two thousand lookups take about a
ten-thousandth of a second, choosing between the two is a waste of your
afternoon, and the list has the advantage of being what you already had.

Then watch the list column. Twenty times the data, twenty times the wait: it
tracks n exactly, because a list is searched by walking it. The set column
never leaves 0.0000. Looking something up in a set does not depend on how much
is in it, so at 20,000 items the same 2,000 questions cost a quarter of a
second one way and nothing at all the other.

This is worth saying plainly, because "always use the faster one" is bad
advice. A shape is a promise about what happens as n grows. Below a few
hundred items, the shapes are indistinguishable and you should pick whichever
code reads better. Above a few thousand, the shape is the only thing that
matters and no amount of tidy code will save the wrong one.

Which means the question is never "is this fast?" It is "how big does n get?"
— and that is written in the problem's constraints, which is why the constraint
line is the line to read first.

:::exercise{id="ch11-pair-to-target"}
Is there a pair at two different positions that adds up to `target`? Every
pair is n squared. One pass does it: for each value, ask whether its partner
has already gone past.

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

A percent or two apart on a quiet machine — close enough to trust. Now open
something else, or run it on a cheaper laptop, and the same loop takes two or
three times as long. The number you measure is a fact about your afternoon as
much as about your code, and it is not a number you can quote to anyone else.

The step count does not move. `40,000 × 200,000` is 8 billion on a fast
machine and 8 billion on a slow one. So count first, and use the clock only to
confirm what you already worked out. A measurement that surprises you means
your count was wrong — usually because of a line you did not think of as a
loop, like `value in some_list` or `some_list.remove(value)`, each of which
quietly walks the whole list.

## What this buys the agent

The agent searches a repository for you. Suppose it holds 200,000 lines of
code and you ask forty questions in a session.

Read every line for every question and that is 8 million line comparisons per
session — survivable, but it makes every single answer wait. Read every line
for every *symbol* it wants to check and the inner loop multiplies out into
the billions: now your question takes forty seconds instead of one.

Build an index once — every name, in a dictionary, pointing at the lines that
mention it — and each question costs a lookup. The one-off cost is 200,000
steps. The per-question cost stops depending on the size of the repository
altogether.

That is this chapter, and it is the difference between a tool you keep open and
a tool you close. The agent cannot make that choice for itself unless the
person who wrote it did the arithmetic first.

## Your turn

Two challenges. Both have an obvious answer with a loop inside a loop, and in
both cases that answer is correct and cannot finish at the size the problem
allows. Do the multiplication before you write anything: the perf tier is not
going to be talked round.

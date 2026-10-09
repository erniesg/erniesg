+++
id = "ch13-sorting"
kind = "concept"
title = "Sorting and order"
figure = "counting-the-field"

teaches = ["sorting"]
requires = ["ch12-hash-maps"]
assessed-by = ["closest-finish", "how-many-you-beat"]
powers = ["agent-snippet-ranking"]
+++

A hill climb finishes at ten past three and the prizes go out at four. Nine
hundred riders crossed the line, and the timing box wrote each one down the
moment their transponder passed, so the file is already in finishing order.

The prizes are not. There are six age categories with three places in each,
so eighteen names to read out. One of them belongs to a woman at the back of the
marquee who came thirty-fourth overall and thinks she won her category.

Getting those eighteen names out of the file is a sort, and it takes a
thousandth of a second. A wrong sort takes just as long and gives eighteen
names that look just as right. This chapter is mostly about getting it right.

Chapter 10 showed `sorted` with a `key`, and said not to rearrange a list you
were handed. This chapter covers the rest.

## `sorted` builds, `.sort()` rearranges

```python run
times = [2412, 2199, 2405, 2199]

board = sorted(times)
print("sorted() hands back:", board)
print("and leaves this alone:", times)

nothing = times.sort()
print(".sort() hands back:  ", nothing)
print("and leaves this changed:", times)
```

`.sort()` sorts the list in place and returns `None`. So `times =
times.sort()` replaces your data with `None`. The error only appears later,
when something tries to loop over `None`.

`.sort()` exists because it needs no second list. Sorting 200,000 riders with
`sorted` briefly holds two copies of them; `.sort()` holds one. That rarely
matters. The rest of the time, use `sorted`, which returns a new list.

## The key is worked out once per rider

`sorted(things, key=f)` calls `f` once on each item and orders the items by
what it returns:

```python run
riders = [("ivy", "over60", 2412), ("hal", "open", 2199), ("mia", "over60", 2405)]
print(sorted(riders, key=lambda rider: rider[2]))
```

Sorting a thousand items takes something like ten thousand comparisons. The
key function still runs only once per item:

```python run
import random

calls = 0


def time_of(rider):
    global calls
    calls += 1
    return rider[2]


field = [(f"rider{n}", "open", random.randint(0, 5000)) for n in range(1000)]
calls = 0
sorted(field, key=time_of)
print(len(field), "riders,", calls, "calls to the key function")
```

Python works out every key first, then sorts by those keys without calling
your function again. So a slow key, such as pulling a date out of text or
asking the filesystem for a file's size, costs n calls, not n log n. That
leaves room to write the key you actually mean, even if it is slow.

## Tuples are compared left to right

```python run
finishes = [(7, 100), (2, 900), (5, 400)]     # (bib number, hundredths)
print(sorted(finishes))
print(sorted(finishes, key=lambda finish: finish[1]))
```

The first line is in bib order. The times were never looked at, because
Python compares two tuples by their first items and only moves to the next item
on a tie. Without a `key`, a list of pairs is ordered by the first part of each
pair.

The same rule is useful on purpose. A key that returns a tuple means "order by
this, and settle ties with that". Chapter 10 used it that way.

## Stability: the order you had survives

Sort the field by time:

```python run
entries = [
    ("ada", "over60", 2431),
    ("sam", "open", 2199),
    ("mia", "over60", 2205),
    ("hal", "open", 2344),
    ("ivy", "over60", 2205),
]

by_time = sorted(entries, key=lambda entry: entry[2])
for entry in by_time:
    print(entry)
```

Now sort *that* by category:

```python run
by_category = sorted(by_time, key=lambda entry: entry[1])
for entry in by_category:
    print(entry)
```

The second sort only looked at the category and compared no times. Yet inside
each category the riders are still fastest first.

That is **stability**: when two items have equal keys, Python's sort leaves
them in the order it found them. The first sort put the riders in time order.
The second moved whole blocks into category order, and inside each block the
time order stayed.

So you can sort by three or four things without writing a comparison function.
**Sort by the least important thing first and the most important thing last.**
In the other order, the time sort would come last and undo the grouping by
category.

Stability also settles ties. Mia and Ivy both climbed in 2205. Mia is ahead of
Ivy in both outputs because she was ahead in the file, and no sort had a reason
to swap them.

`reverse=True` keeps ties in order too:

```python run
print([e[0] for e in sorted(entries, key=lambda entry: entry[2], reverse=True)])
print([e[0] for e in sorted(entries, key=lambda entry: entry[2])[::-1]])
```

Both lines are slowest first, but they disagree about Mia and Ivy.
`reverse=True` flips the ordering and keeps ties as they were. Reversing the
finished list flips everything, ties included. When the tie order means
something, as it does at a race, use `reverse=True`.

:::exercise{id="ch13-two-sorts"}
Two sorts, least important first: order by time, then by category. Print the
names — each category fastest first.

```python
entries = [
    ("ada", "over60", 2431),
    ("sam", "open", 2199),
    ("mia", "over60", 2205),
    ("hal", "open", 2344),
]
# your code here
```

```output
['sam', 'hal', 'mia', 'ada']
```

```answer
entries = [
    ("ada", "over60", 2431),
    ("sam", "open", 2199),
    ("mia", "over60", 2205),
    ("hal", "open", 2344),
]
by_time = sorted(entries, key=lambda entry: entry[2])
board = sorted(by_time, key=lambda entry: entry[1])
print([entry[0] for entry in board])
```
:::

## What sorting costs, and when it pays for itself

Sorting is the n log n row from Chapter 11. Scanning is the row above it.
Here is the gap between them:

```python run
import random
import time

readings = [random.randint(0, 10**9) for _ in range(500_000)]

started = time.perf_counter()
min(readings)
scan = time.perf_counter() - started

started = time.perf_counter()
sorted(readings)
order = time.perf_counter() - started

print(f"one pass for the smallest:   {scan:.4f}s")
print(f"putting them all in order:   {order:.4f}s")
print(f"sorting cost {order / scan:.0f} times as much")
```

One pass over half a million readings is 500,000 steps. A sort is about
nineteen passes' worth, because you can halve 500,000 nineteen times before you
reach 1. The clock gives something close to that.

**One question about the data: scan.** The smallest, the largest, the total,
how many are above a threshold. Sorting to find a minimum costs about nineteen
times what one pass costs.

**Many questions about the same data: sort once.** The ten smallest. The
median. Everything between two values. Which values repeat. Each of those is a
cheap walk over a sorted list, and the sort is paid for once no matter how many
of them you ask.

One question looks like it needs every pair, but does not:

```python run
readings = [48, 5, 62, 51, 9]
in_order = sorted(readings)
gaps = [later - earlier for earlier, later in zip(in_order, in_order[1:])]
print(in_order)
print(gaps, "→ the closest two differ by", min(gaps))
```

*What is the smallest difference between any two of these?* Checking every pair
at 200,000 readings is 20 billion comparisons: the bottom row, forty minutes.
But once the list is in order, the closest two numbers must sit next to each
other, so you only have to look at neighbours. That is one sort and one pass,
about four million steps.

:::exercise{id="ch13-distinct-by-sorting"}
Count the distinct values without a set: sort, then walk the neighbours and
count each place where the value changes. An empty list has 0.

```python
def distinct(values):
    # your code here
    ...


print(distinct([2, 1, 1, 2, 3, 1]))
print(distinct([7]))
print(distinct([]))
```

```output
3
1
0
```

```answer
def distinct(values):
    if not values:
        return 0
    in_order = sorted(values)
    count = 1
    for earlier, later in zip(in_order, in_order[1:]):
        if later != earlier:
            count += 1
    return count


print(distinct([2, 1, 1, 2, 3, 1]))
print(distinct([7]))
print(distinct([]))
```
:::

## When a number can just be a place

Picture the riders standing on the grass at the finish, each holding a card
with their lap count on it, a whole number between 0 and 120. Put them in order.

You could pair them off and compare cards until the line came right. Or you
could chalk the numbers 0 to 120 across the grass, one patch each, and tell
everybody to stand on their own number. Read the field from left to right and
it is sorted. No two riders were ever compared.

:::figure{id="counting-the-field"}
:::

```python run
laps = [3, 1, 3, 0, 2]

chalk = [0] * 4
for value in laps:
    chalk[value] += 1              # the number is the place

in_order = []
for value, how_many in enumerate(chalk):
    in_order.extend([value] * how_many)

print("chalk marks:", chalk)
print("the field, in order:", in_order)
```

This is **counting sort**, and it compares nothing. It costs one pass over
the riders to make the chalk marks, plus one pass along the chalk to read them
back: n + k, where k is how many different numbers are possible. There is no
log n, because the log comes from halving, and halving comes from
comparing.

```python run
import random
import time

laps = [random.randint(0, 120) for _ in range(500_000)]

started = time.perf_counter()
sorted(laps)
by_comparing = time.perf_counter() - started

started = time.perf_counter()
chalk = [0] * 121
for value in laps:
    chalk[value] += 1
in_order = []
for value, how_many in enumerate(chalk):
    in_order.extend([value] * how_many)
by_counting = time.perf_counter() - started

print(f"sorted():      {by_comparing:.3f}s")
print(f"counting sort: {by_counting:.3f}s")
print("same answer:", in_order == sorted(laps))
```

`sorted()` runs entirely inside C. The counting sort is a plain Python loop,
the slowest kind of code in this book, and it still takes about the same time,
here a little less. Your two numbers will differ. They are close because
counting sort skips the comparing, which is the work `sorted` cannot avoid.

The cost is k. Chalking 121 patches to sort half a million riders is nothing.
If lap counts ran to a billion, you would chalk a billion patches to sort the
same 500,000 riders, and k would far outweigh n. Counting sort suits keys that
are small whole numbers packed close together: times in hundredths of a second,
ages, scores out of 100, line numbers in one file, the bytes in a file. It does
not work for names, for prices with no ceiling, or for anything you can only
compare rather than count.

This is the trade from last chapter, seen from the other side. A hash map turns
a key into a place with a rule that scrambles. Counting sort uses the key
itself as the place, so the order survives. A hash map loses that order.

:::exercise{id="ch13-product-of-three"}
Find the largest product of three values. Sort once. Then only two
candidates can win: the three biggest, or the two most negative times the
biggest.

```python
def best_three(values):
    # your code here
    ...


print(best_three([-3, 1, 2, -2, 5, 6]))
print(best_three([-10, -10, 1, 3, 2]))
print(best_three([1, 2, 3]))
```

```output
60
300
6
```

```answer
def best_three(values):
    v = sorted(values)
    return max(v[-1] * v[-2] * v[-3], v[0] * v[1] * v[-1])


print(best_three([-3, 1, 2, -2, 5, 6]))
print(best_three([-10, -10, 1, 3, 2]))
print(best_three([1, 2, 3]))
```
:::

## What this buys the agent

The agent finds twenty candidate snippets for a question and can afford to send
four. It has to rank them.

The obvious key is a relevance score, but scores tie often: three snippets
that each match two search terms score the same. Whatever breaks the tie
decides what the model reads.

Stability breaks ties for free. Sort the candidates by how far they are from
the file the user is looking at, then sort by score. Snippets with equal scores
come out in distance order, because the first sort's order is kept. There is no
comparison function and no four-item tuple key, and each rule is its own line.

Then the budget: pack snippets until the token limit runs out. That needs the
candidates in order once, not a scan of the whole list for each slot. That is
the difference between one sort and a loop inside a loop.

## Your turn

Two challenges. The first looks like it needs every pair of finishers
compared, and its perf tier is too large for that. The second has no hints, and
its worked solution is for reading after your own passes.

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

The prizes are not. Six age categories, three places in each: eighteen names to
read out. One of them is a woman standing at the back of the marquee who came
thirty-fourth overall and thinks she won her category.

Getting those eighteen names out of the file is a sort, and it takes a
thousandth of a second. Getting them *wrong* also takes a thousandth of a
second, and produces eighteen names that look exactly as convincing. This
chapter is mostly about the difference.

Chapter 10 showed you `sorted` with a `key` and told you not to rearrange a
list you were handed. Everything here is the part that was left out.

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

`.sort()` returns `None`. So `times = times.sort()` throws your data away and
replaces it with nothing, and the error you get is three functions later, when
something tries to loop over `None`. It is a one-character mistake with a
ten-minute debug attached.

`.sort()` exists because it needs no second list. Sorting 200,000 riders with
`sorted` briefly holds two copies of them; `.sort()` holds one. That matters
about twice a year. The rest of the time, use `sorted` and hand back a new
list.

## The key is worked out once per rider

`sorted(things, key=f)` calls `f` on each item, once, and orders by what comes
back:

```python run
riders = [("ivy", "over60", 2412), ("hal", "open", 2199), ("mia", "over60", 2405)]
print(sorted(riders, key=lambda rider: rider[2]))
```

Once is worth knowing about. Sorting a thousand items takes something like ten
thousand comparisons, but the key function does not run ten thousand times:

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

Python works out every key first, sorts those, and never touches your function
again. So an expensive key — pulling a date out of text, asking the filesystem
how big a file is — costs you n, not n log n. Write the slow key you actually
mean rather than a fast one that is nearly right.

## Tuples are compared left to right

This is the most common wrong results board in the world:

```python run
finishes = [(7, 100), (2, 900), (5, 400)]     # (bib number, hundredths)
print(sorted(finishes))
print(sorted(finishes, key=lambda finish: finish[1]))
```

The first line is in bib order. The times were never looked at, because
comparing two tuples starts at the first item and only moves on when that item
ties. Sort a list of pairs without saying which part you mean and the part you
did not think about decides everything.

Turn it round and the same rule is a tool: hand back a tuple as your key and
you have said "order by this, and settle ties with that". Chapter 10 used it
for exactly that.

## Stability: the order you had survives

Now the thing this chapter exists for. Sort the field by time:

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

Now sort *that* by category, and look at what happens to the times:

```python run
by_category = sorted(by_time, key=lambda entry: entry[1])
for entry in by_category:
    print(entry)
```

The second sort only ever looked at the category. It compared no times at all.
Yet inside each category the riders are still fastest first.

That is **stability**: when two items have equal keys, Python's sort leaves
them in the order it found them. The first sort put the riders in time order,
the second shuffled whole blocks into category order, and everything the first
sort decided survived untouched inside those blocks.

Which gives you a way to sort by three or four things without writing a
comparison function: **sort by the least important thing first, the most
important thing last.** Backwards is the classic bug, and it produces a board
that looks sorted and is not.

Stability also settles ties you did not think about. Mia and Ivy both climbed
in 2205. Mia is ahead of Ivy in both outputs because Mia was ahead of Ivy in
the file, and no sort has any reason to swap them.

`reverse=True` respects that too, which surprises people:

```python run
print([e[0] for e in sorted(entries, key=lambda entry: entry[2], reverse=True)])
print([e[0] for e in sorted(entries, key=lambda entry: entry[2])[::-1]])
```

Both lines are slowest-first. They disagree about Mia and Ivy. `reverse=True`
flips the ordering and keeps ties as they were; reversing the finished list
afterwards flips the ties as well, because it flips everything. When the tie
order carries meaning — and at a race it does — `reverse=True` is the one you
want.

## What sorting costs, and when it pays for itself

Sorting is the n log n row from Chapter 11. Scanning is the row above it. The
gap is smaller than people expect and bigger than nothing:

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

Half a million readings: one pass is 500,000 steps, and a sort is about
nineteen passes' worth, because you can halve 500,000 nineteen times before you
reach 1. The clock above says something close to that. So the rule is blunt and
it holds.

**One question about the data: scan.** The smallest, the largest, the total,
how many are above a threshold. Sorting to find a minimum is paying nineteen
times over for an answer one pass already had.

**Many questions about the same data: sort once.** The ten smallest. The
median. Everything between two values. Which values repeat. Each of those is a
cheap walk over a sorted list, and the sort is paid for once no matter how many
of them you ask.

And one question in particular, which looks like it needs every pair and does
not:

```python run
readings = [48, 5, 62, 51, 9]
in_order = sorted(readings)
gaps = [later - earlier for earlier, later in zip(in_order, in_order[1:])]
print(in_order)
print(gaps, "→ the closest two differ by", min(gaps))
```

*What is the smallest difference between any two of these?* Checking every pair
at 200,000 readings is 20 billion comparisons: the bottom row, forty minutes.
But two numbers that are close together must end up next to each other once the
list is in order, so you only have to look at neighbours. One sort, one pass,
about four million steps. Sorting did not answer the question. It made the
question cheap.

## When a number can just be a place

Back to the field at the finish. Forget the timing file and picture the riders
themselves, standing on the grass, each holding a card with their lap count on
it — a whole number between 0 and 120. Put them in order.

You could pair them off and compare cards until the line came right. Or you
could take the chalk, write 0 to 120 across the grass in a line, one patch each, and
tell everybody to go and stand on their own number. Read the field from left to
right and it is sorted. No rider was ever held up against another rider.

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

This is **counting sort**, and it does not compare anything. The cost is one
pass over the riders to make the chalk marks, plus one pass along the chalk to
read them back: n + k, where k is how many different numbers are possible. Not
n log n. There is no log, because there is no halving, because there is no
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

Look at what those two numbers are. On the left, half a million values sorted
entirely inside C. On the right, a Python loop — the slowest thing in this
book — finishing in the same breath, and on this machine a little ahead. It is
not a faster race. It is not a race. Comparing is the work `sorted` cannot
avoid, and counting sort never starts it. Your two numbers will differ from
these; the interesting thing is that they are anywhere near each other at all.

The catch is k. Chalking 121 patches to sort half a million riders is nothing.
If lap counts ran to a billion you would be chalking a billion patches to sort
the same 500,000 riders, and k would swamp n completely. Counting sort is for
keys that are whole numbers, small, and packed reasonably close together: times
in hundredths of a second, ages, scores out of 100, line numbers in one file,
the bytes in a file. It is no use at all for names, for prices with no ceiling,
or for anything you can only compare rather than count.

Which is the same trade you saw last chapter, from the other side. A hash map
turns a key into a place by a rule that scrambles. Counting sort turns a key
into a place by the key *being* the place — so the order survives, and that is
exactly what a hash map throws away.

## What this buys the agent

The agent finds twenty candidate snippets for a question and can afford to send
four. It has to rank them.

The obvious key is a relevance score, and the awkward part is that scores tie
constantly — three snippets all match two of your search terms and score
identically. What breaks the tie decides what the model gets to read.

Stability hands that over for nothing. Sort the candidates by how far they sit
from the file the user is looking at, then sort by score. Ties in score come
out in distance order, because the earlier sort is still in there. No
comparison function, no tuple key with four items in it, and every rule stays
in its own readable line.

Then the budget: pack snippets until the token limit runs out. That needs them
in order once, not a scan of the whole candidate list for each slot — which is
the difference between one sort and a loop inside a loop, and by now you can do
that arithmetic yourself.

## Your turn

Two challenges. The first looks like it needs every pair of finishers compared
with every other, and the perf tier is sized so that it cannot be. The second
is yours alone — no hints, and a worked solution to read only once your own is
green.

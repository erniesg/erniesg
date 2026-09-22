+++
id = "ch06-dicts-sets"
kind = "concept"
title = "Dictionaries and sets"
figure = "lookup-vs-scan"

teaches = ["dicts-and-sets"]
requires = ["ch05-functions"]
assessed-by = ["tally-visits", "missing-items"]
powers = ["agent-symbol-index"]
+++

A veterinary surgery keeps 1,240 record cards in one long box, filed in the
order people first came in. At 8:40am a man arrives with a dog that has stopped
eating. The nurse needs his card.

Flipping through the box touches about 620 cards before his turns up: four
minutes, with three people waiting behind him. Move the same 1,240 cards into
pigeonholes labelled by surname and the nurse reaches once.

No card was thrown away and nobody worked faster. The cards were arranged so
that a name points straight at a place. In Python that arrangement is a
dictionary.

## A dict maps a name to a value

A list numbers its slots 0, 1, 2. A dict labels them with whatever you like —
here, the pigeonholes, with each surname pointing at the shelf its card sits
on:

```python run
shelf = {"ada": 12, "grace": 9, "alan": 7}
print(shelf["grace"])
```

Square brackets read a value out, and the thing inside them is the **key**.
Assigning to a key that is not there yet adds it. Assigning to one that is
there replaces what it held:

```python run
shelf["katherine"] = 15     # a family who just registered
shelf["ada"] = 13           # same pigeonhole, card moved down one
print(shelf)
print(len(shelf), "people on file")
```

A dict keeps things in the order you added them, which is convenient and almost
never the point. You reach for a dict when you want to ask by name.

## When the key is not there

This is the first thing that bites:

```python
print(shelf["bob"])
```

That stops the program with `KeyError: 'bob'`, which says exactly what
happened: no pigeonhole carries that label. Sometimes a crash is what you want.
More often you want a sensible stand-in and the next line to run, which is what
`get` is for:

```python run
print(shelf.get("bob"))        # None — and no crash
print(shelf.get("bob", 0))     # 0 — the stand-in you chose
print(shelf.get("grace", 0))   # 9 — the real value; the stand-in is ignored
```

`get` never raises. Choose the default that makes the following line work: `0`
if you are about to add to it, `""` if you are about to print it.

:::exercise{id="ch06-price-or-zero"}
Print the price of `tea`, which is not on the list, as 0 — then the price of
`rice`. No crash allowed.

```python
prices = {"rice": 3, "oil": 7}
# your code here
```

```output
0
3
```

```answer
prices = {"rice": 3, "oil": 7}
print(prices.get("tea", 0))
print(prices.get("rice", 0))
```
:::

## Counting is what dicts are best at

Here is the pattern you will write for the rest of your life. One pass, one
dict, the name as the key and the count so far as the value:

```python run
visits = ["ada", "grace", "ada", "alan", "ada"]
counts = {}
for name in visits:
    counts[name] = counts.get(name, 0) + 1
print(counts)
```

Read the middle line from the inside out. `counts.get(name, 0)` is the count so
far, or `0` the first time this name appears. Add one. Put it back under the
same key. The first sighting and the fiftieth run the same line, which is why
nobody needs an `if` here.

:::exercise{id="ch06-count-the-basket"}
Count how many of each fruit went through the till, in one pass, with the
line you just learned.

```python
items = ["apple", "pear", "apple", "fig", "apple", "pear"]
counts = {}
for item in items:
    # your code here
    ...
print(counts)
```

```output
{'apple': 3, 'pear': 2, 'fig': 1}
```

```answer
items = ["apple", "pear", "apple", "fig", "apple", "pear"]
counts = {}
for item in items:
    counts[item] = counts.get(item, 0) + 1
print(counts)
```
:::

## Walking a dict

Looping over a dict hands you its keys:

```python run
for name in counts:
    print(name, "came", counts[name], "time(s)")
```

`.values()` gives the values on their own, and `.items()` gives both at once,
which is usually the one you want:

```python run
print(sum(counts.values()), "visits in total")
for name, count in counts.items():
    if count > 1:
        print(name, "came back")
```

`in` on a dict asks about keys, never values:

```python run
print("ada" in counts)    # True — there is a pigeonhole labelled ada
print(3 in counts)        # False — 3 is a count, not a label
```

:::exercise{id="ch06-most-common"}
Walk `counts.items()` and print the fruit that sold most, and how many. Keep
the best so far, the way Chapter 4 did.

```python
counts = {"apple": 3, "pear": 2, "fig": 1}
best_item = None
best_count = 0
# your code here
print(best_item, best_count)
```

```output
apple 3
```

```answer
counts = {"apple": 3, "pear": 2, "fig": 1}
best_item = None
best_count = 0
for item, count in counts.items():
    if count > best_count:
        best_item = item
        best_count = count
print(best_item, best_count)
```
:::

## Sets: membership without a value

Sometimes there is nothing to store. You only need to know whether you have
seen a thing before. That is a set: keys, no values.

```python run
seen = set()
unique = []
for name in visits:
    if name not in seen:      # first time we have met this one?
        seen.add(name)
        unique.append(name)
print(unique)
print(len(visits), "visits from", len(seen), "people")
```

Two jobs, and you will want both of them weekly: **have I already got this
one?** and **give me each one once**. When the order does not matter, `set(visits)` collapses the repeats
in a single step:

```python run
print(sorted(set(visits)))
```

Watch the punctuation. `{}` on its own is an empty *dict*; an empty set is
`set()`. Sets have no order worth relying on either, so sort them before you
print.

:::exercise{id="ch06-first-to-return"}
*Have I seen this one before?* is a set question. Print the first visitor
who comes in for a second time.

```python
visits = ["mia", "sam", "ada", "sam", "mia"]
seen = set()
for name in visits:
    # your code here
    ...
```

```output
sam
```

```answer
visits = ["mia", "sam", "ada", "sam", "mia"]
seen = set()
for name in visits:
    if name in seen:
        print(name)
        break
    seen.add(name)
```
:::

## Keys have to be hashable

A dict turns a key into a place to look. For that to work, the key has to be a
value that cannot change behind its back. Text, numbers and tuples qualify.
Lists do not:

```python run
seats = {}
seats[("ada", "grace")] = "front bench"    # a tuple is fixed, so it can be a key
print(seats[("ada", "grace")])
```

Swap that tuple for a list, which can be edited after you make it, and Python
refuses:

```python
seats[["ada", "grace"]] = "back bench"
```

`TypeError: unhashable type: 'list'`. "Unhashable" is the real reason, and it
gets a chapter of its own in Part II. The working rule until then: if you can
change it after making it, it cannot be a key. `tuple(names)` turns a list into
something that can.

## Why one reach beats a flip-through

Finding a name in a list of 1,000 means reading names until you hit it, and all
1,000 of them if it is last:

```python run
names = ["user" + str(n) for n in range(1000)]
looked_at = 0
for name in names:
    looked_at += 1
    if name == "user999":
        break
print(looked_at, "names looked at")
print("user999" in set(names), "— and the set went straight there")
```

Make the list ten times longer and the first number becomes 10,000. The second
stays one reach. That gap is the whole reason dicts and sets turn up in every
program anyone writes.

Be honest about the cost, though: `set(names)` walks the list once to build
itself, so a single lookup buys you nothing. It pays from the second question
onwards, and real programs ask thousands.

:::figure{id="lookup-vs-scan"}
:::

How a dict finds the place without reading every key is hashing. Take the flat
line on trust until Part II shows you the trick.

:::exercise{id="ch06-smallest-missing"}
Return the smallest **positive** whole number that is not in the list. Say it
mechanically first: the smallest `x` where `x > 0` and `x` is not in the
numbers. Then: *does x exist?* — so put them in a set, and count up from 1.

```python
def smallest_missing(numbers):
    # your code here
    ...


print(smallest_missing([1, 3, 6, 4, 1, 2]))
print(smallest_missing([1, 2, 3]))
print(smallest_missing([-1, -3]))
print(smallest_missing([1, 4, 0, -1]))
print(smallest_missing([0, 99, 100]))
```

```output
5
4
1
2
1
```

```answer
def smallest_missing(numbers):
    seen = set(numbers)
    candidate = 1
    while candidate in seen:
        candidate += 1
    return candidate


print(smallest_missing([1, 3, 6, 4, 1, 2]))
print(smallest_missing([1, 2, 3]))
print(smallest_missing([-1, -3]))
print(smallest_missing([1, 4, 0, -1]))
print(smallest_missing([0, 99, 100]))
```
:::

## What this buys the agent

The agent indexes a repository once: every function and class name, with the
file and line where it is defined. A medium project has 60,000 of those. When
the model asks *where is `load_solution` defined*, the answer comes out of a
dict in one reach instead of 4,000 files being read again.

A set does the other half of the job. Walking a repository, the agent puts each
directory it has visited into a set. A symbolic link pointing back at a parent
folder then costs it one check, rather than an infinite loop.

## Your turn

Two challenges. The first counts things and talks you through it. The second
keeps its hints but locks the worked solution until all four tiers are green,
and its perf tier has no patience for a list where a set belongs.

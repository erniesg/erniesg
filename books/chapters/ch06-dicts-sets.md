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

Flipping through the box means reading about 620 cards before his turns up.
That takes four minutes, with three people waiting. If the same cards sit in
pigeonholes labelled by surname, she reaches once.

Nobody worked faster. The cards were arranged so that a name points straight
at a place. In Python that arrangement is a dictionary.

## A dict maps a name to a value

A list numbers its slots 0, 1, 2. A dict labels them with whatever you like.
Here each surname points at the shelf its card sits on:

```python run
shelf = {"ada": 12, "grace": 9, "alan": 7}
print(shelf["grace"])
```

Square brackets read a value out. The thing inside them is the **key**.
Assigning to a new key adds it. Assigning to an existing key replaces its
value:

```python run
shelf["katherine"] = 15     # a family who just registered
shelf["ada"] = 13           # same pigeonhole, card moved down one
print(shelf)
print(len(shelf), "people on file")
```

A dict keeps keys in the order you added them, but you use one to look
things up by name.

## When the key is not there

```python
print(shelf["bob"])
```

That stops the program with `KeyError: 'bob'`: no pigeonhole has that label.
Often you want a stand-in value instead, so the next line can run. That is
what `get` is for:

```python run
print(shelf.get("bob"))        # None — and no crash
print(shelf.get("bob", 0))     # 0 — the stand-in you chose
print(shelf.get("grace", 0))   # 9 — the real value; the stand-in is ignored
```

`get` never raises an error. Pick the default that suits the next line: `0`
if you will add to it, `""` if you will print it.

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

To count things, make one pass with one dict. The name is the key and the
count so far is the value:

```python run
visits = ["ada", "grace", "ada", "alan", "ada"]
counts = {}
for name in visits:
    counts[name] = counts.get(name, 0) + 1
print(counts)
```

Read the middle line from the inside out. `counts.get(name, 0)` is the count so
far, or `0` the first time this name appears. Add one, and store it back under
the same key. The first sighting and the fiftieth run the same line, so no `if`
is needed.

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

`.values()` gives just the values. `.items()` gives each key with its value:

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

Sometimes you only need to know whether you have seen a thing before. A set
holds keys with no values.

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

A set does two jobs: **have I already got this one?** and **give me each one
once**. When the order does not matter, `set(visits)` drops the repeats in one
step:

```python run
print(sorted(set(visits)))
```

`{}` on its own is an empty *dict*. An empty set is `set()`. A set's order
can't be relied on, so sort it before you print it.

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

A dict turns a key into a place to look. For that to work, the key must be a
value that cannot change. Text, numbers and tuples can be keys. Lists cannot:

```python run
seats = {}
seats[("ada", "grace")] = "front bench"    # a tuple is fixed, so it can be a key
print(seats[("ada", "grace")])
```

A list can be edited after you make it, so Python refuses it as a key:

```python
seats[["ada", "grace"]] = "back bench"
```

That raises `TypeError: unhashable type: 'list'`. Hashing gets its own chapter
in Part II. Until then: if you can change a value after making it, it cannot be
a key. `tuple(names)` turns a list into something that can.

## Why one reach beats a flip-through

To find a name in a list of 1,000, you read names until you hit it. If it is
last, you read all 1,000:

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

Make the list ten times longer and the first number becomes 10,000. The set
lookup is still one reach.

Building the set walks the list once, so a single lookup saves nothing. It
pays off from the second lookup on.

:::figure{id="lookup-vs-scan"}
:::

A dict finds the place without reading every key by hashing. Part II shows
how it works.

:::exercise{id="ch06-smallest-missing"}
Return the smallest **positive** whole number that is not in the list. That
is, the smallest `x` where `x > 0` and `x` is not in the numbers. For each `x`
you ask *is it in the list?*, so put the numbers in a set and count up from 1.

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
the model asks *where is `load_solution` defined*, the answer comes from a dict
in one reach, without reading 4,000 files again.

A set does the other half. Walking a repository, the agent puts each directory
it has visited into a set. A symbolic link pointing back at a parent folder then
costs one check, not an infinite loop.

## Your turn

Two challenges. The first counts things and walks you through it. The second
has hints; try to finish before reading the worked solution. Its perf tier fails a solution that searches a
list where a set belongs.

+++
id = "most-common-basket"
kind = "challenge"
title = "The basket people buy"
module = "baskets"
figure = "key-to-slot"
support = "guided"
difficulty = 2

requires = ["ch12-hash-maps"]
teaches = ["hash-maps"]
tags = ["part-2", "hash-maps", "hashable-keys"]

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
xp = 20
timeout = 60

[tiers.perf]
xp = 20
timeout = 15
+++

:::statement
A corner shop's tills keep every basket that goes through them: the items, in
the order they were scanned. A busy week is 200,000 baskets.

The owner has one metre of shelf by the door and wants to know what to put on
it. Which exact basket goes through the tills most often?

Two baskets count as the same only if they hold the same items scanned in the
same order. If two baskets tie, return the one that went through first.
:::

:::io
input: `baskets`, a list of baskets, each a list of item names in scanning order
output: the most frequent basket, as a list of item names
:::

:::constraints
- The log holds 0 to 200,000 baskets.
- Each basket holds 0 to 8 items.
- Each item name is 1 to 20 lower-case letters.
- A tie goes to whichever basket appeared first in the log.
- An empty log has no most frequent basket, so the answer is `[]`.
- The baskets passed in must not be changed.
- At 200,000 baskets, counting each basket by searching the log for it is too
  slow to pass.
:::

:::sample
| baskets | Output | Why |
|---|---|---|
| `[["milk"], ["bread"], ["milk"]]` | `["milk"]` | milk went through twice |
| `[["milk", "eggs"], ["eggs", "milk"]]` | `["milk", "eggs"]` | different order, so two different baskets — the tie goes to the first |
| `[["tea"]]` | `["tea"]` | one basket, so it wins |
| `[]` | `[]` | nothing was scanned |
:::

:::figure{id="key-to-slot"}
A basket is a list, and a list cannot be used as a dict key. Turn it into a
tuple first.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Make one pass over the log and count as you go, as with counting names in
Chapter 6. The new question is what to use as the key.
:::

:::hint{level=2}
`counts[basket] = ...` raises `TypeError: unhashable type: 'list'`. A list can
be changed after you store it, so Python does not allow it as a key.
`tuple(basket)` holds the same items and cannot be changed. It hashes, and it
is equal to another tuple with the same items in the same order.
:::

:::hint{level=3}
The answer has to be a list, not a tuple, so convert it back at the end:
`list(winner)`.
:::

:::hint{level=4}
`max(counts, key=counts.get)` gives the key with the biggest count. On a tie
it keeps the first key it reaches. A dict gives its keys in the order they
were added, which is the order the baskets first appeared.
:::

:::solution
```python
def most_common_basket(baskets):
    counts = {}
    for basket in baskets:
        frozen = tuple(basket)
        counts[frozen] = counts.get(frozen, 0) + 1
    if not counts:
        return []
    return list(max(counts, key=counts.get))
```

**Why the key has to be a tuple.** A dict finds a key's slot by hashing it,
and the hash must not change or the entry is lost. A list can be appended to
after you store it, and its hash would change with it, so Python refuses list
keys. `tuple(basket)` copies the items into something that cannot be changed.

The tuple is also a copy. If the caller changes their basket afterwards, your
count does not change. You counted what went through the till, not what the
list holds now.

**Why the tie rule needs no code.** `max` walks the dict's keys in the order
they were first added and keeps the first one with the highest count. So a tie
goes to the basket that appeared earliest. An explicit tie-break would be
three lines that do nothing.

**The version that is too slow.** This is a natural first draft:

```python
def most_common_basket(baskets):          # do not do this
    best, best_count = [], -1
    for basket in baskets:
        count = baskets.count(basket)
        if count > best_count:
            best, best_count = basket, count
    return list(best)
```

It is correct, but `baskets.count(basket)` walks the whole log for every
basket in it. 200,000 × 200,000 is 40 billion basket comparisons, each of up
to eight item names. Measured, it takes about fifteen minutes; the perf tier
allows three seconds. The dict version reads each basket once: 200,000 steps,
under three hundredths of a second.

**Where the time went.** Counting by searching asks "is this basket equal to
that one" 40 billion times. Counting by hashing turns
each basket into a number once, and the number says where to look. That is
Chapter 12 applied to one line of code.
:::

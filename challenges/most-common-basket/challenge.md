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
it. So: which exact basket goes through the tills most often?

Two baskets count as the same only if they hold the same items scanned in the
same order. If two baskets tie, answer with the one that went through first.
:::

:::io
input: `baskets`, a list of baskets, each a list of item names in scanning order
output: the most frequent basket, as a list of item names
:::

:::constraints
- The log holds 0 to 200,000 baskets.
- Each basket holds 0 to 8 items.
- Each item name is 1 to 20 lower-case letters.
- Ties go to whichever of them appeared first in the log.
- An empty log has no most-frequent basket, so the answer is `[]`.
- The baskets you were handed must come back unchanged.
- At 200,000 baskets, counting one basket by searching the log for it is too
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
A basket is a list, and a list cannot be turned into a slot. Freeze it first.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
One pass over the log, counting as you go, exactly like counting names in
Chapter 6. The only new problem is what to count *by*.
:::

:::hint{level=2}
`counts[basket] = ...` raises `TypeError: unhashable type: 'list'`. A basket is
a list, and a list can be edited after you file it, so Python will not let it
be a key. `tuple(basket)` is the same items frozen: it hashes, and it compares
equal to another tuple holding the same items in the same order.
:::

:::hint{level=3}
The answer has to be a list, not a tuple, so convert back on the way out:
`list(winner)`.
:::

:::hint{level=4}
`max(counts, key=counts.get)` gives the key with the biggest count. Ties go to
whichever the loop reaches first, and a dict is walked in the order keys were
added — which is the order the baskets first appeared. That is the tie rule the
statement asked for, for free.
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

**Why the tuple is not optional.** A dict finds a slot by hashing the key, and
hashing has to give the same number every time or the entry is lost. A list can
be appended to after you file it, so its contents — and any number worked out
from them — can change behind the dict's back. Python refuses rather than let
you build that bug. `tuple(basket)` copies the items into something that can
never be edited, so the number stays put.

Note that this also copies. If the caller changes their basket afterwards, your
count is unaffected, which is exactly right: you counted what went through the
till, not what the list holds now.

**Why the tie rule needs no code.** A dict remembers the order keys were first
inserted. `max` walks the keys in that order and keeps the first one that
reaches the highest count, so a tie is settled by which basket appeared
earliest. Writing an explicit tie-break here is three lines that do nothing.

**The version that fails the clock.** This is the natural first draft:

```python
def most_common_basket(baskets):          # do not do this
    best, best_count = [], -1
    for basket in baskets:
        count = baskets.count(basket)
        if count > best_count:
            best, best_count = basket, count
    return list(best)
```

It is correct, and `baskets.count(basket)` walks the whole log once for every
basket in it. 200,000 × 200,000 is 40 billion basket comparisons, and each
comparison compares up to eight item names. Measured, it takes over five
minutes; the perf tier allows three seconds. The dict version reads each basket
once — 200,000 steps, about two hundredths of a second.

**Where the time actually went.** Both versions do the same *comparisons*; the
difference is how many. Counting by searching asks "is this basket equal to
that one" 40 billion times. Counting by hashing turns each basket into a number
once and lets the number say where to look. That is the whole of Chapter 12
applied to one line of code.
:::

+++
id = "remove-every-copy"
kind = "challenge"
title = "Clearing the shelf"
module = "shelf"
figure = "two-names-one-list"
support = "guided"
difficulty = 1

requires = ["ch03-lists"]
teaches = ["lists"]
tags = ["part-1", "lists", "mutation-trap", "aliasing"]

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
xp = 5
timeout = 5
+++

:::statement
Back to the food bank shelf. One product has been recalled, and every tin of
it has to come off.

Given `items`, the shelf as a list of labels, and `unwanted`, the recalled
label, return a new list holding everything else in its original order.

The shelf you were given must be unchanged. The list you return must be a new
list, even when nothing was removed.
:::

:::io
input: `items`, a list of labels; `unwanted`, one label
output: a new list, in the original order, with every copy of `unwanted` gone
:::

:::constraints
- `0 <= len(items) <= 200,000`
- Labels are short pieces of text. `unwanted` may not appear on the shelf at all.
- `items` must be unchanged afterwards.
- The returned list must not be `items` itself.
:::

:::sample
| items | unwanted | Output | Why |
|---|---|---|---|
| `["beans", "rice", "beans"]` | `"beans"` | `["rice"]` | every copy, not just the first |
| `["beans", "beans", "rice"]` | `"beans"` | `["rice"]` | two side by side — the awkward one |
| `["rice", "soup"]` | `"beans"` | `["rice", "soup"]` | nothing recalled, still a new list |
| `["beans", "beans"]` | `"beans"` | `[]` | the whole shelf goes |
| `[]` | `"beans"` | `[]` | nothing there to start with |
:::

:::figure{id="two-names-one-list"}
The list you were given is the caller's list. If you edit it, you edit theirs.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Removing items from a list while you loop over it moves each later item down
one place. The loop then skips the item that moved into the emptied place. Two
recalled tins side by side show it.
:::

:::hint{level=2}
Don't edit a list at all. Start with an empty list, loop over `items` once,
and append each label that is not `unwanted`. That keeps the order and leaves
the original unchanged.
:::

:::hint{level=3}
`items.remove(unwanted)` deletes one copy and raises `ValueError` when there
are none left. Calling it until it raises edits the caller's shelf, and each
removal moves every item after it. The perf tier runs 200,000 items with half
of them recalled.
:::

:::solution
```python
def without(items, unwanted):
    kept = []
    for item in items:
        if item != unwanted:
            kept.append(item)
    return kept
```

**Reading and writing are kept apart.** The loop only reads `items`, and every
change goes into `kept`, a list this function made. Nothing moves under the
loop, so nothing is skipped, and the caller's shelf is never touched.

**The order comes for free.** Items are appended in the order they were met,
so the ones kept stay in their old order. Code that removes items one at a
time has to work to keep that true.

**Why not `remove` in a loop.** It has two problems. First, it edits the
caller's list, which the statement forbids and the edge tier checks. Second,
each `remove` moves every item after the gap down one place. With 100,000
recalled tins on a 200,000-item shelf, that is billions of moves, and the perf
tier stops it. One pass with one append per kept item does the job.

**The nothing-removed case.** When nothing is recalled, `kept` is a new list
with the same labels. Returning `items` itself would pass an `==` check but be
wrong. The shelf and the answer would be one list, so changing either would
change both.
:::

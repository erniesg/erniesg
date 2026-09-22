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
it has to come off — however many there are, wherever they sit.

Given `items`, the shelf as a list of labels, and `unwanted`, the label that
has been recalled, hand back a new list holding everything else in the order
it was already in.

The shelf you were given must be exactly as you found it when you finish, and
the list you hand back must be a different list — even when nothing was
recalled off it.
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
Edit the list you were handed and you have edited the caller's list. There is
only one.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Removing items from a list while you walk that same list slides the rest
along, and the walk skips whatever moved into the place you just emptied. Two
recalled tins side by side is where it shows.
:::

:::hint{level=2}
Do not edit a shelf at all. Start with an empty list, walk `items` once, and
append the labels that are not `unwanted`. Both rules — order kept, original
untouched — come out of that for free.
:::

:::hint{level=3}
`items.remove(unwanted)` deletes one copy and raises `ValueError` when there
are none left, so "repeat it until it complains" rewrites the caller's shelf —
and every single removal shuffles the whole tail of the list along. The perf
tier runs 200,000 items with half of them recalled.
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
change lands in `kept`, a list this function made. Nothing slides underneath
the walk, so nothing gets skipped, and the caller's shelf is untouched without
having to be protected.

**Order is free.** Items are appended in the order they were met, so whatever
survives keeps its old sequence. Anything built by repeated removal has to
work to keep that true.

**Why not `remove` in a loop.** Two problems, and they are different ones.
It edits the caller's list, which the statement forbids and the edge tier
checks. And every `remove` has to slide everything behind the hole down one
place, so 100,000 recalled tins on a 200,000-item shelf move billions of
labels between them — the perf tier stops it. One pass and one append per
survivor is the whole job.

**The empty-but-new case.** When nothing is recalled, `kept` is a brand new
list that happens to hold the same labels. Returning `items` itself would look
identical to `==` and be wrong: the shelf and the answer would be one list,
and the next thing to touch either would change both.
:::

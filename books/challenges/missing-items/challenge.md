+++
id = "missing-items"
kind = "challenge"
title = "What still has to be bought"
module = "stock"
figure = "lookup-vs-scan"
support = "contract"
difficulty = 3

requires = ["ch06-dicts-sets"]
teaches = ["dicts-and-sets"]
tags = ["part-1", "sets", "membership", "order"]

[limits]
time_seconds = 5
memory_mb = 512

[tiers.public]
xp = 10
timeout = 30

[tiers.edge]
xp = 20
timeout = 30

[tiers.stress]
xp = 25
timeout = 60

[tiers.perf]
xp = 10
timeout = 20
+++

:::statement
A repair café opens on Saturday mornings: people bring broken bicycles and
volunteers fix them. Before the session the mechanics read out every part the
day's bikes need — inner tubes twice, because two bikes came in with flats —
and one volunteer cycles to the shop with the list.

Given what was asked for and what is already in the parts bin, return the
shopping list: every requested part that is not in the bin, in the order it was
first asked for, each part appearing once.
:::

:::io
input: `requested`, a list of part names in the order they were called out, and
`stocked`, a list of the part names already in the bin
output: a list of the parts to buy, in first-asked order, no repeats
:::

:::constraints
- `requested` holds 0 to 200,000 names; `stocked` holds 0 to 200,000 names.
- Each name is 1 to 20 lowercase letters.
- Both lists may repeat a name. The bin is in no order at all.
- The answer is a list, and its order is the order parts were first requested.
- At those sizes, searching the bin list for every request is too slow to pass.
:::

:::sample
| requested | stocked | Output | Why |
|---|---|---|---|
| `["tube", "cable", "tube", "pads"]` | `["pads", "tube"]` | `["cable"]` | only the cable is missing |
| `["tube", "cable", "cable"]` | `[]` | `["tube", "cable"]` | cable asked twice, bought once |
| `["tube"]` | `["tube", "tube"]` | `[]` | the bin holds two of them |
| `[]` | `["tube"]` | `[]` | nothing was asked for |
:::

:::figure{id="lookup-vs-scan"}
Every request is one membership question. Ask a set, not a list.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
`name in stocked` gives the right answer, but on a list it reads the names one
at a time. 200,000 requests against 200,000 parts in the bin is 40 billion
comparisons. Turn the bin into a `set` once, before the loop, and ask that
instead.
:::

:::hint{level=2}
The shopping list may not repeat a name, so you also have to remember what you
have already written down. A second set does that. Writing `if name not in
answer` looks like the same thing, but it searches the list you are building —
the trap from hint 1, one line further down.
:::

:::hint{level=3}
The order is the order of `requested`, so walk `requested` once and append as
you go. Do not sort, and do not build the answer out of a set: a set keeps no
order you can rely on.
:::

:::solution
```python
def missing_items(requested, stocked):
    in_bin = set(stocked)
    listed = set()
    answer = []
    for name in requested:
        if name not in in_bin and name not in listed:
            listed.add(name)
            answer.append(name)
    return answer
```

**Three containers, three jobs.** `in_bin` answers "do we already have this?".
`listed` answers "have I written it down?". `answer` is the only one that keeps
the order, because it is the only one the caller sees.

**The arithmetic.** Building `in_bin` reads the bin list once: 200,000
steps. The loop reads the request list once and asks two sets per name: another
200,000 or so. Around 400,000 steps in total. The version with `name in
stocked` on the plain list does 40 billion, which is the difference between
instant and going home.

**Why not a set for the answer.** `set(requested) - set(stocked)` is one line
and gives the right *names*, in an order nobody controls — it may come out
differently on another machine. The statement asks for shopping-list order, and
a list is what keeps it.

**The case the sample nearly hides.** A missing name asked for twice must
appear once. That is what `listed` is for, and it is the one the edge tier
checks hardest.
:::

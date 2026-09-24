+++
id = "tally-visits"
kind = "challenge"
title = "Who came back"
module = "tally"
figure = "lookup-vs-scan"
support = "guided"
difficulty = 2

requires = ["ch06-dicts-sets"]
teaches = ["dicts-and-sets"]
tags = ["part-1", "dicts", "counting"]

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
xp = 10
timeout = 20
+++

:::statement
The front desk writes down a name every time someone walks in, in order, all
day. At closing time the surgery wants to know how many times each person came.

Given the day's log as a list of names, return a dict: every name that appears,
pointing at how many times it appears. A name nobody wrote down is simply not
in the dict.
:::

:::io
input: `names`, a list of text names in the order they arrived
output: a dict from each name to how many times it appears
:::

:::constraints
- The log holds 0 to 200,000 names.
- Each name is 1 to 20 lowercase letters.
- Names repeat freely, and an empty log gives an empty dict, `{}`.
- The whole log has to be counted inside the time limit, so re-reading the list
  once per name is too slow to pass.
:::

:::sample
| names | Output | Why |
|---|---|---|
| `["ada", "grace", "ada"]` | `{"ada": 2, "grace": 1}` | ada twice, grace once |
| `["alan"]` | `{"alan": 1}` | one name, one visit |
| `["ada", "ada", "ada"]` | `{"ada": 3}` | same person all day |
| `[]` | `{}` | nobody came in |
:::

:::figure{id="lookup-vs-scan"}
Counting by name is a lookup for every name in the log. Do it in a dict, not by
searching the list again.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
One pass over the log. Keep a dict as you go: the key is a name, the value is
how many times you have seen it so far.
:::

:::hint{level=2}
The first time a name turns up there is nothing to add to, and
`counts[name] + 1` raises `KeyError`. `counts.get(name, 0)` answers `0`
instead.
:::

:::hint{level=3}
The body of the loop is one line:
`counts[name] = counts.get(name, 0) + 1`.
:::

:::solution
```python
def tally_visits(names):
    counts = {}
    for name in names:
        counts[name] = counts.get(name, 0) + 1
    return counts
```

**Why `get` and not an `if`.** `counts.get(name, 0)` is "the count so far, or
zero if this is the first time". Writing it with `if name in counts:` works and
takes three lines to say the same thing. Either way, the point is that the
first visit and the thirtieth run the same code.

**Why the empty log needs no special case.** The loop body never runs, `counts`
is still `{}`, and that is the answer the statement asked for. A test for
emptiness here would only be a place for a bug to live.

**Why the obvious other version fails.** This is the tempting one:

```python
def tally_visits(names):
    return {name: names.count(name) for name in names}   # do not do this
```

It gives correct answers. It also searches the whole list once per name in the
list. At the stated limit that is 200,000 × 200,000 = 40 billion comparisons,
which is hours, and the perf tier stops it in seconds. The dict version reads
each name once: 200,000 steps.

**Order does not matter.** Two dicts are equal when they hold the same keys
with the same values, whatever order they were built in, so the tests do not
care which name you met first.
:::

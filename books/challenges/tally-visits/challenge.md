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
The front desk writes down a name, in order, each time someone walks in. At
closing time the surgery wants to know how many times each person came.

Given the day's log as a list of names, return a dict from each name in the log
to how many times it appears. Names not in the log are not in the dict.
:::

:::io
input: `names`, a list of text names in the order they arrived
output: a dict from each name to how many times it appears
:::

:::constraints
- The log holds 0 to 200,000 names.
- Each name is 1 to 20 lowercase letters.
- Names can repeat. An empty log gives an empty dict, `{}`.
- Searching the list again for each name is too slow to pass.
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
Counting needs one lookup per name in the log. Look up in a dict, not by
searching the list again.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Make one pass over the log, keeping a dict: each key is a name, and its value
is how many times you have seen it so far.
:::

:::hint{level=2}
The first time a name turns up, `counts[name] + 1` raises `KeyError`.
`counts.get(name, 0)` returns `0` instead.
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

**Why `get` and not an `if`.** `counts.get(name, 0)` means "the count so far,
or zero the first time". `if name in counts:` also works, but takes three
lines. Either way, the first visit and the thirtieth run the same code.

**Why the empty log needs no special case.** The loop body never runs, so
`counts` stays `{}`, which is the right answer.

**Why the shorter version fails.**

```python
def tally_visits(names):
    return {name: names.count(name) for name in names}   # do not do this
```

It gives correct answers, but `names.count(name)` searches the whole list once
for every name. At the stated limit that is 200,000 × 200,000 = 40 billion
comparisons. That takes minutes, and the perf tier allows 2 seconds. The dict
version reads each name once: 200,000 steps.

**Order does not matter.** Two dicts are equal when they hold the same keys
and values, in any order. So the tests do not care which name came first.
:::

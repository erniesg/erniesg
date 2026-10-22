+++
id = "shortfall-log"
kind = "challenge"
title = "Nights that fell short"
module = "shortfall"
figure = "what-comes-back"
support = "contract"
difficulty = 2

requires = ["ch05-functions"]
teaches = ["functions"]
tags = ["part-1", "functions", "mutable-default"]

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
xp = 15
timeout = 5
+++

:::statement
A kitchen records how many meals it served each night. It wants a log of the
nights that fell short of its target, so it can see whether the shortfalls are
drifting or clustered.

Write `log_shortfalls(served, target=180, log=None)`.

- `served` is the meals served, one whole number per night, in order.
- `target` is what the kitchen aims for. It defaults to 180.
- `log` is a list to add to. When the caller gives no list, start a new empty
  one.

For every night that served fewer than `target` meals, add the pair
`(night, target - served[night])` to the log, where `night` is the position in
`served`, counting from 0. A night that hit the target exactly did not fall
short.

Return the log. When the caller passed one in, return *that* list with the
new entries added, not a copy of it.
:::

:::io
input: `served`, a list of whole numbers; `target`, a whole number defaulting to 180; `log`, a list or nothing
output: the log: a list of `(night, shortfall)` pairs, oldest first
:::

:::constraints
- `served` holds between 0 and 100,000 numbers.
- `0 <= served[i] <= 1,000,000`
- `1 <= target <= 1,000,000`
- Two calls that pass no `log` must not be able to see each other's entries.
- When a `log` is passed, the list returned must be that same list object.
:::

:::sample
| served | target | log | Output |
|---|---|---|---|
| `[200, 150, 180, 90]` | not given | not given | `[(1, 30), (3, 90)]` |
| `[]` | not given | not given | `[]` |
| `[5]` | `10` | not given | `[(0, 5)]` |
| `[5]` | `10` | `[(9, 1)]` | `[(9, 1), (0, 5)]` |
:::

:::figure{id="what-comes-back"}
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
One pass over `served`, and you need the position as well as the value.
`enumerate` gives you both.
:::

:::hint{level=2}
`def log_shortfalls(served, target=180, log=[])` looks like a way to say "an
empty log by default". But that list is made once, when the `def` line runs.
Every call that leaves `log` out then shares the same list. The edge tier
calls the function twice with no log.
:::

:::hint{level=3}
Put `None` in the default and build the list inside, under `if log is None:`.
That gives each call its own new list. Use `is None`, not `== None` or
`if not log:`. A caller may pass an empty list and want it back.
:::

:::hint{level=4}
`log = log + [entry]` builds a new list every night, so the caller's own list
is not the one returned. `log.append(entry)` changes the list in place.
:::

:::solution
```python
def log_shortfalls(served, target=180, log=None):
    if log is None:
        log = []
    for night, meals in enumerate(served):
        if meals < target:
            log.append((night, target - meals))
    return log
```

**The default is settled once.** Python runs the `def` line once, when the
module loads. Whatever object it builds for a default is used by every call
after that. For `target=180` that is harmless, because a number can't be
changed. For `log=[]`, every call that leaves out the log appends to the same
list. That list keeps growing for as long as the program runs, and mixes one
kitchen's nights with another's. Nothing crashes, but the numbers get
more wrong the longer the program runs.

**`None` is the standard stand-in.** It holds no data and you can't append to
it. So a mistake shows up at once as an `AttributeError`, not as a slow leak.
One `if` at the top replaces it with a new list for each call.

**`is None` rather than truth.** `if not log:` looks tidier but is wrong. An
empty list is falsy, so a caller who passed `[]` to fill would get a different
list back and never see their entries. `is None` asks *was I given nothing*,
not *is what I was given empty*.

**Append, do not rebuild.** `log = log + [entry]` makes a new list holding
everything so far plus one. Doing that for every short night makes the work
grow with the square of the nights: at 100,000 nights, roughly five billion
entries copied. It also points `log` at a new list, so the caller's list stays
unchanged and a different list is returned. `append` fixes both. The edge
tier checks that the caller's list comes back, so it catches this before the
perf tier does.

**Why the position comes from `enumerate`.** `served.index(meals)` finds the
*first* night with that many meals, so two nights with the same count would
both be logged at the earlier position. The position comes from where you are
in the loop, not from the value. `enumerate` keeps track of it.

**It does one thing.** The function records and returns. It does not print,
and it does not decide what a bad night means. So the same function works for
a single week or a whole year's rolling log. The caller passes the log along,
and the function doesn't need to know which case it is in.
:::

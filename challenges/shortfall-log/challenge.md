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
A kitchen writes down, night after night, how many meals it actually served.
It wants a log of the nights that fell short of what it aimed for, so it can
see whether the shortfalls are drifting or clustered.

Write `log_shortfalls(served, target=180, log=None)`.

- `served` is the meals served, one whole number per night, in order.
- `target` is what the kitchen aims for. It defaults to 180.
- `log` is a list to add to. When the caller gives no list, start a new empty
  one.

For every night that served fewer than `target` meals, add the pair
`(night, target - served[night])` to the log, where `night` is the position in
`served`, counting from 0. A night that hit the target exactly did not fall
short.

Return the log. When the caller passed one in, hand back *that* list — theirs,
added to, not a copy of it.
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
- When a `log` is passed, the list handed back must be that same list object.
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
`enumerate` hands you both.
:::

:::hint{level=2}
`def log_shortfalls(served, target=180, log=[])` looks like the obvious way to
say "an empty log by default". It is the bug this challenge is built around.
That list is made once, when the `def` line runs, so every call that leaves
`log` out shares the same one — and the edge tier calls the function twice
with no log.
:::

:::hint{level=3}
Put `None` in the default and build the list inside, under `if log is None:`.
That gives a fresh list per call, which is what "no log given" is supposed to
mean. Use `is None`, not `== None` or `if not log:` — a caller may legitimately
hand you an empty list they want back.
:::

:::hint{level=4}
`log = log + [entry]` builds a new list every night. It breaks the promise to
return the caller's own list, and over 100,000 nights it copies billions of
entries. `log.append(entry)` changes the list where it stands and copies
nothing.
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
module loads, and whatever object it builds for a default is *the* default from
then on. For `target=180` that is harmless: 180 is a number and nothing can
change it. For `log=[]` it means every call that omits a log appends to the
same list — a log that quietly grows for as long as the program runs, mixing
one kitchen's nights with another's. Nothing crashes. The numbers are just
wrong, and they get more wrong the longer the program stays up.

**`None` is the standard stand-in.** It carries no data and nothing can be
appended to it, so a mistake shows up as an `AttributeError` immediately rather
than as a slow leak. One `if` at the top turns it into a fresh list per call.

**`is None` rather than truth.** `if not log:` looks tidier and is wrong: an
empty list is falsy, so a caller who handed you `[]` to fill would get a
different list back and never see their entries. `is None` asks the question
you actually meant — *was I given nothing* — rather than *is what I was given
empty*.

**Append, do not rebuild.** `log = log + [entry]` makes a new list holding
everything so far plus one. Do that for every short night and the work grows
with the square of the nights: at 100,000 nights, roughly five billion entries
copied. It also re-points `log` at something new, so the caller's list is
returned unchanged and the promise in the statement is broken. `append` fixes
both at once, which is why the edge tier catches it before the perf tier gets
the chance.

**Why the position comes from `enumerate`.** `served.index(meals)` would find
the *first* night with that many meals, so two equally bad nights would both be
logged against the earlier one. The position is a fact about where you are in
the walk, not a fact about the value, and `enumerate` is how you keep hold of
it.

**One thing, so it composes.** The function records and returns; it does not
print, and it does not decide what a bad night means. That is why the same
function serves a single week and a whole year's rolling log — the caller
passes the log along, and the function never needs to know which it is in.
:::

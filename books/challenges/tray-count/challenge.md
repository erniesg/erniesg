+++
id = "tray-count"
kind = "challenge"
title = "How many trays to order"
module = "trays"
figure = "what-comes-back"
support = "guided"
difficulty = 1

requires = ["ch05-functions"]
teaches = ["functions"]
tags = ["part-1", "functions", "defaults"]

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
A kitchen serves portions out of trays. A tray holds a fixed number of
portions and has to be ordered whole, so 310 portions out of trays of 12 means
26 trays. Order 25 and 300 people are fed while ten are turned away.

Return two numbers: how many trays to order, and how many portions go spare in
the last tray.

Trays hold 12 portions unless the caller says otherwise, so `per_tray` has a
default of 12 and most calls will pass only the portions.
:::

:::io
input: `portions`, a whole number, and `per_tray`, a whole number with a default of 12
output: a pair — trays to order, and spare portions
:::

:::constraints
- `0 <= portions <= 1,000,000`
- `1 <= per_tray <= 1,000`
- Nothing to serve means no trays and nothing spare.
- The function must work when it is called with one argument.
:::

:::sample
| portions | per_tray | Output | Why |
|---|---|---|---|
| `180` | not given | `(15, 0)` | 15 trays of 12 is exactly 180 |
| `310` | not given | `(26, 2)` | 26 trays hold 312, so 2 go spare |
| `0` | not given | `(0, 0)` | nothing to serve |
| `25` | `10` | `(3, 5)` | 3 trays hold 30 |
| `1` | `10` | `(1, 9)` | one portion still needs a whole tray |
:::

:::figure{id="what-comes-back"}
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Work out the trays first. The spare falls straight out of it: the trays bring
`trays * per_tray` portions and `portions` of them leave.
:::

:::hint{level=2}
`310 / 12` is `25.83`, and nobody can order 0.83 of a tray. `//` rounds down,
which is the wrong direction here. You want to round up.
:::

:::hint{level=3}
`(portions + per_tray - 1) // per_tray` rounds up without a single `if`:
adding one less than a full tray pushes any remainder over the line, and adds
nothing when the division was already exact. Check it against `portions = 0`
before you trust it.
:::

:::solution
```python
def trays_needed(portions, per_tray=12):
    trays = (portions + per_tray - 1) // per_tray
    return (trays, trays * per_tray - portions)
```

**Rounding up with floor division.** `//` always rounds down, so you nudge the
numerator first. Adding `per_tray - 1` is exactly enough to push any leftover —
one portion or eleven — up to the next whole tray, and never enough to invent
a tray when the division came out even. 310 + 11 is 321, and 321 // 12 is 26.
180 + 11 is 191, and 191 // 12 is still 15.

**Zero needs no special case.** `(0 + 11) // 12` is 0, and the spare is
`0 * 12 - 0`. An `if portions == 0` here is a sign the rounding is being done
by hand somewhere.

**Why the spare is derived, not counted.** The two numbers are not independent:
once you know the trays, the spare is fixed. Working both out separately is two
chances to be wrong and two places to change if a tray size ever moves.

**Why `per_tray` has a default and `portions` does not.** Arguments with
defaults come last, and only the argument that is usually the same should have
one. Every call knows its own portions; most calls do not care about tray size.
That is the whole test for whether something deserves a default.

**Counting up is correct and far too slow.** Adding `per_tray` to a running
total until it reaches `portions` gives the right answer and reads clearly. At
the size limit — a million portions in trays of one — it is a million times
round the loop for a single call, and the perf tier makes 50,000 calls. The
arithmetic does the same job in one step, whatever the numbers are.
:::

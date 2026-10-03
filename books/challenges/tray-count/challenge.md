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
portions and has to be ordered whole. For 310 portions in trays of 12 you need
26 trays. Order 25 and only 300 people are fed.

Return two numbers: how many trays to order, and how many portions go spare in
the last tray.

Most trays hold 12, so `per_tray` has a default of 12. Most calls pass only
the portions.
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
Work out the trays first. The spare follows from it: the trays hold
`trays * per_tray` portions, and `portions` of them are used.
:::

:::hint{level=2}
`310 / 12` is `25.83`, and you can't order 0.83 of a tray. `//` rounds down,
but here you need to round up.
:::

:::hint{level=3}
`(portions + per_tray - 1) // per_tray` rounds up without an `if`. Adding one
less than a full tray pushes any leftover into the next tray. When the
division is exact, it adds nothing. Check it with `portions = 0`.
:::

:::solution
```python
def trays_needed(portions, per_tray=12):
    trays = (portions + per_tray - 1) // per_tray
    return (trays, trays * per_tray - portions)
```

**Rounding up with floor division.** `//` always rounds down, so you add to the
number being divided first. Adding `per_tray - 1` pushes any leftover, from one
portion to eleven, into the next tray. It never adds a tray when the division
is exact. 310 + 11 is 321, and 321 // 12 is 26. 180 + 11 is 191, and 191 // 12
is still 15.

**Zero needs no special case.** `(0 + 11) // 12` is 0, and the spare is
`0 * 12 - 0`, also 0.

**The spare comes from the trays.** Once you know the trays, the spare is
fixed. Working the two out separately gives two places to make a mistake, and
two places to change if the tray size changes.

**Why `per_tray` has a default and `portions` does not.** A parameter with a
default goes after the ones without. Only a value that is usually the same
should get a default. Every call has its own portions, but most calls use
trays of 12.

**Counting up is correct but slow.** You could add `per_tray` to a running
total until it reaches `portions`. At the size limit, a million portions in
trays of one, that loop runs a million times for one call, and the perf tier
makes 50,000 calls. The arithmetic takes one step whatever the numbers are.
:::

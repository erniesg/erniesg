+++
id = "tidy-the-register"
kind = "challenge"
title = "Tidying the sign-up sheet"
module = "register"
figure = "six-idioms"
support = "contract"
difficulty = 2

requires = ["ch10-idioms"]
teaches = ["python-idioms"]
tags = ["part-1", "idioms", "no-mutation"]

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
timeout = 10
+++

:::statement
A sign-up sheet is typed in by hand, so the entries arrive untidy: stray
spaces around some names, and a few lines where somebody hit return and wrote
nothing.

Return a **new** list with the same names in the same order, each trimmed of
the spaces around it, and with the blank entries dropped. An entry that is
nothing but spaces counts as blank.

The list you were handed must come back exactly as it arrived. Other parts of
the club's program are still holding it.
:::

:::io
input: `names`, a list of text entries
output: a new list of text: the trimmed, non-blank entries, in their original order
:::

:::constraints
- The list holds 0 to 200,000 entries.
- Each entry is at most 50 characters.
- Spaces inside a name stay: `"mary jane"` is one name, unchanged.
- After your function returns, `names` must hold exactly what it held before.
:::

:::sample
| Input | Output | Why |
|---|---|---|
| `["  mia ", "sam"]` | `["mia", "sam"]` | spaces around a name go, order stays |
| `["ada", "   ", "hal "]` | `["ada", "hal"]` | the spaces-only entry is blank |
| `["   "]` | `[]` | nothing left to keep |
| `[]` | `[]` | nothing to do |
:::

:::figure{id="six-idioms"}
Building a new list is the first habit in this list, and the only one here
that is about correctness rather than reading.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
`"  mia ".strip()` gives `"mia"`. Now ask what `"   ".strip()` gives, and
whether `if` treats that result as true or false.
:::

:::hint{level=2}
Two things must not appear in your answer: `names.remove(...)` and
`names[i] = ...`. Both change the caller's list. Start an empty list of your
own and `append` to it, or write a comprehension — a comprehension always
builds a new list, so it cannot get this wrong.
:::

:::hint{level=3}
Deleting from a list while you walk it skips entries. If `names` is
`["", "", "ada"]` and you remove the first blank, everything shifts left, the
loop moves on, and the second blank is never looked at. This is why the
stress tier feeds you runs of consecutive blanks.
:::

:::hint{level=4}
A comprehension can call `strip` twice — once to decide, once to keep:

```
[<the trimmed name> for name in names if <the trimmed name>]
```

Two strips per entry is still one pass over the list, which is fine at
200,000 entries.
:::

:::solution
```python
def tidy_names(names):
    return [name.strip() for name in names if name.strip()]
```

**Why this cannot touch the caller's list.** A comprehension reads `names` and
builds somewhere else. There is no assignment into `names` and no method call
on it, so the list the club is holding comes back byte for byte as it went in.
That is the whole contract, and it falls out of the shape of the code rather
than being something you have to remember.

**Why `if name.strip()` and not `if name != ""`.** An entry of three spaces is
not equal to `""`, so the second test keeps it, and you end up with a name made
of nothing. Trim first, then ask whether anything survived. Empty text is
false, so `if name.strip()` reads as "if there is anything left".

**The version that looks right and is not:**

```python
def tidy_names(names):
    for position in range(len(names)):
        names[position] = names[position].strip()   # tidying in place
    for name in names:                              # walking the list
        if not name:
            names.remove(name)                      # ...while deleting from it
    return names
```

This passes the public tier. It has two bugs anyway.

It changes the caller's list, which is the thing you were told not to do — the
edge tier catches that on its first check. And removing during a walk shifts
everything left, so on `["", "", "ada"]` it removes the first blank, the loop
moves on to position 1, and the blank that slid into position 0 is never
looked at again. The stress tier finds that within a handful of random sheets
and prints the sheet it found it on.

**The plain loop, for comparison:**

```python
def tidy_names(names):
    tidy = []
    for name in names:
        trimmed = name.strip()
        if trimmed:
            tidy.append(trimmed)
    return tidy
```

Identical behaviour, identical cost, five lines instead of one. Neither is
wrong. The comprehension wins when the rule fits on a line you can read aloud,
and this one does: keep the trimmed name, for each name, if anything is left.
:::

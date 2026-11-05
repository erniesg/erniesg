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
A sign-up sheet is typed in by hand. Some names have stray spaces around them,
and some lines are blank.

Return a **new** list with the same names in the same order. Trim the spaces
around each name and drop blank entries. An entry of only spaces is blank.

The list you were given must not change. Other parts of the club's program
still use it.
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
Building a new list is the first habit in the figure. It is the only one that
is about correctness. The others are about readability.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
`"  mia ".strip()` gives `"mia"`. What does `"   ".strip()` give? Does `if`
treat that result as true or false?
:::

:::hint{level=2}
`names.remove(...)` and `names[i] = ...` both change the caller's list. Instead,
`append` to an empty list of your own, or write a comprehension, which always
builds a new list.
:::

:::hint{level=3}
Deleting from a list while you loop over it skips entries. Say `names` is
`["", "", "ada"]` and you remove the first blank. Everything shifts left, the
loop moves on, and the second blank is never looked at. That is why the stress
tier tests runs of blanks.
:::

:::hint{level=4}
A comprehension can call `strip` twice, once to decide and once to keep:

```
[<the trimmed name> for name in names if <the trimmed name>]
```

That is still one pass over the list, which is fine at 200,000 entries.
:::

:::solution
```python
def tidy_names(names):
    return [name.strip() for name in names if name.strip()]
```

**Why this cannot change the caller's list.** A comprehension reads `names`
and builds a new list. Nothing is assigned into `names` and no method is called
on it, so the club's list stays as it was.

**Why `if name.strip()` and not `if name != ""`.** An entry of three spaces is
not equal to `""`, so the second test keeps it as a name. Trim first, then
check. Empty text is false, so `if name.strip()` means "if there is anything
left".

**A version that looks right but is not:**

```python
def tidy_names(names):
    for position in range(len(names)):
        names[position] = names[position].strip()   # tidying in place
    for name in names:                              # walking the list
        if not name:
            names.remove(name)                      # ...while deleting from it
    return names
```

This passes the public tier, but it has two bugs.

First, it changes the caller's list, which the edge tier checks. Second, on
`["", "", "ada"]` it removes the first blank and the loop moves on to position
1. The blank that moved into position 0 is never looked at, so the result is
`["", "ada"]`. The stress tier finds this and prints the sheet that failed.

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

It behaves the same and costs the same, in five lines instead of one. A
comprehension is the better choice when the rule fits on one line you can read
aloud. This one does: keep the trimmed name, for each name, if anything is
left.
:::

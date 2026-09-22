+++
id = "seen-more-than-once"
kind = "challenge"
title = "Who came back"
module = "barrier"
figure = "four-shapes"
support = "unaided"
difficulty = 3

requires = ["ch11-counting-work"]
teaches = ["cost"]
tags = ["part-1", "cost", "counting"]

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
xp = 30
timeout = 15
+++

:::statement
A car park barrier photographs every number plate that drives in. A month of
that is up to 200,000 reads, in the order the cars arrived.

The council is deciding whether to sell monthly passes, so it wants one
number: how many **different** vehicles came in more than once.

A plate read five times counts once, not five times, and not four. A plate
read exactly once does not count at all.
:::

:::io
input: `plates`, a list of text, one entry per read, in arrival order
output: how many distinct plates appear two or more times
:::

:::constraints
- The list holds 0 to 200,000 reads.
- Each plate is 1 to 8 characters of upper-case letters and digits.
- The same plate may appear any number of times.
:::

:::sample
| Input | Output | Why |
|---|---|---|
| `["AB1", "CD2", "AB1"]` | `1` | only `AB1` came back |
| `["AB1", "AB1", "AB1"]` | `1` | one vehicle, three visits |
| `["AB1", "CD2", "EF3"]` | `0` | nobody came back |
| `["AB1", "CD2", "AB1", "CD2"]` | `2` | both did |
:::

:::figure{id="four-shapes"}
Counting a plate by searching the list for it puts you on the bottom row.
Counting every plate in one pass puts you on the second.
:::

:::run{starter="starter.py"}
:::

:::solution
```python
def count_repeat_visitors(plates):
    seen = {}
    for plate in plates:
        seen[plate] = seen.get(plate, 0) + 1
    return sum(1 for count in seen.values() if count > 1)
```

**The count that decides it.** The obvious answer asks, for each plate, how
many times that plate appears in the list — and asking that question means
walking the list. 200,000 plates, each searching 200,000 reads, is 40 billion
comparisons. The ten-million rule calls that 4,000 seconds.

Timed, it comes out nearer 500, because `plates.count(...)` does its walking
inside Python's own machinery rather than in a loop you wrote, which is
several times quicker per step. The rule was out by a factor of eight and it
did not matter in the slightest: 500 seconds is eight minutes, and the tier
gives you three seconds. That is what the rule is for. It is wrong about the
number and right about the decision.

One pass instead. Each plate is looked at once and dropped into a dictionary
that remembers how many times it has turned up. 200,000 steps, then a walk
over the distinct plates to count the ones above 1. Two hundredths of a
second, and the arithmetic said so before anything ran.

**Why a dictionary and not a list of seen plates.** `if plate in seen_list` is
a loop wearing a disguise: it walks the list until it finds a match. Put
200,000 plates in a list and check each new one against it and you are back to
the 40 billion. `plate in seen` for a dictionary — or a set — does not depend
on how much is already in there. Choosing between a list and a dict is not
housekeeping; here it is the whole difference between two hundredths of a
second and eight minutes.

**Two ways to write the same one pass.** If counting feels heavier than you
need, two sets do the job with no arithmetic at all:

```python
def count_repeat_visitors(plates):
    seen = set()
    came_back = set()
    for plate in plates:
        if plate in seen:
            came_back.add(plate)
        seen.add(plate)
    return len(came_back)
```

Same shape, same cost, and the answer is a size rather than a sum. Both pass.
The first one leaves you holding the counts, which is the version to keep if
anybody is ever going to ask a second question about the same data — and
somebody always does.

**The off-by-one that the samples hide.** `["AB1", "AB1", "AB1"]` is one
vehicle, and an answer that counts extra reads rather than extra vehicles says
2. Both of the versions above count each plate once, because sets and
dictionary keys cannot hold the same plate twice. That is not a lucky
accident; it is the property you picked the structure for.
:::

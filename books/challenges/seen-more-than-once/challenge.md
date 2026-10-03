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
A car park barrier photographs every number plate that drives in. A month
gives up to 200,000 reads, in the order the cars arrived.

The council is deciding whether to sell monthly passes. It wants one number:
how many **different** vehicles came in more than once.

A plate read five times counts once, not five or four times. A plate read
only once does not count.
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
Searching the list for each plate puts you on the bottom row.
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
many times it appears in the list. Answering that means walking the list.
200,000 plates, each searching 200,000 reads, is 40 billion comparisons. The
ten-million rule puts that at 4,000 seconds.

Timed, it comes out nearer 500 seconds. `plates.count(...)` walks the list
inside Python's own machinery, not in a loop you wrote, and that is several
times faster per step. So the rule was out by a factor of eight. That did not
change the decision: 500 seconds is eight minutes, and the tier gives you three
seconds. The rule got the number wrong and the decision right,
which is what it is for.

The alternative is one pass. Each plate is looked at once and added to a
dictionary that counts how many times it has turned up. That is 200,000 steps,
then a walk over the distinct plates to count the ones above 1. It takes about
two hundredths of a second, and the arithmetic predicted that before anything
ran.

**Why a dictionary and not a list of seen plates.** `if plate in seen_list` is
also a loop: it walks the list until it finds a match. If you keep 200,000
plates in a list and check each new one against it, you are back to 40 billion
comparisons. `plate in seen` on a dictionary or a set takes the same time
however much is already in it. Here, that choice is the difference between two
hundredths of a second and eight minutes.

**Two ways to write the same one pass.** Two sets do the job without any
counting:

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

Same shape and same cost, but the answer is a size rather than a sum. Both
pass. The first one keeps the counts, so use it if someone may later ask
another question about the same data.

**Counting vehicles, not reads.** `["AB1", "AB1", "AB1"]` is one vehicle. An
answer that counts extra reads instead of extra vehicles says 2. Both versions
above count each plate once, because a set or a dictionary can't hold the same
key twice. That is why these structures fit the job.
:::

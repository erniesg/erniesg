+++
id = "next-train-home"
kind = "challenge"
title = "The next train home"
module = "timetable"
figure = "halving-the-log"
support = "contract"
difficulty = 3

requires = ["ch14-binary-search"]
teaches = ["binary-search"]
tags = ["part-2", "binary-search", "insertion-point"]

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
xp = 25
timeout = 15
+++

:::statement
A station's screens answer one question, over and over: the next train leaves
when? The timetable behind them holds every departure for the year ahead —
400,000 of them — as whole numbers, in time order, earliest first. Two trains
can leave in the same minute, so the same number can appear twice.

Somebody arrives on the platform at minute `arrival`. Give the time of the
first train at or after that minute.

A train leaving in exactly that minute counts: she can still get on it. If
every train has gone, say so with `-1`.
:::

:::io
input: `departures`, a list of whole numbers in time order, oldest first, possibly with repeats; and `arrival`, a whole number
output: the first value in `departures` that is greater than or equal to `arrival`, or `-1` if there is none
:::

:::constraints
- The list holds 0 to 400,000 departures.
- The list is already sorted, smallest first. You do not have to sort it.
- Each departure is a whole number between 0 and 525,600.
- `arrival` is a whole number between 0 and 525,600.
- The screens ask this 20,000 times a minute, so one call has to be cheap.
:::

:::sample
| departures | arrival | Output | Why |
|---|---|---|---|
| `[612, 645, 700, 733]` | `645` | `645` | a train leaves in that very minute |
| `[612, 645, 700, 733]` | `650` | `700` | nothing at 650, so the one after |
| `[612, 645, 700, 733]` | `800` | `-1` | the last one has gone |
| `[700, 700, 700]` | `699` | `700` | three trains in one minute; still 700 |
| `[]` | `500` | `-1` | no trains at all |
:::

:::figure{id="halving-the-log"}
The same narrowing, on a timetable rather than a log: one look in the middle
throws away every departure that cannot be the answer.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Do the arithmetic first. Walking the list until you find a departure big enough
costs, on average, half the list: 200,000 steps. Twenty thousand screens asking
that is 4 billion steps. The ten-million rule calls that 400 seconds; timed, it
comes out nearer 40, because the loop body here is about as small as a loop
body gets. The rule was out by a factor of ten and it did not matter: the perf
tier gives you three seconds. The list is already in time order — a fact you
have not used yet.
:::

:::hint{level=2}
Look at the departure in the middle of the timetable. If it leaves before
`arrival`, then so does everything before it, and you never have to look at any
of them again. If it leaves at or after `arrival`, it might be the answer — but
so might something earlier, so keep the earlier half and drop the rest.

Repeat on whatever is left. Twenty-odd looks and there is one minute standing.
:::

:::hint{level=3}
Hold two numbers, `low` and `high`: the first and last positions you have not
ruled out. Start them at `0` and `len(departures) - 1`, and loop while
`low <= high`.

Each turn, `mid = (low + high) // 2`. If `departures[mid] < arrival` the answer
is to the right, so `low = mid + 1`. Otherwise it is at `mid` or to the left,
so `high = mid - 1`. Move the bound past `mid` and not onto it, or the window
stops shrinking and the loop runs until you kill it.
:::

:::hint{level=4}
Do not try to return from inside the loop. Let it run to the end, and then
`low` is the position the answer belongs in — which is also the position of the
first departure at or after `arrival`.

Two ways that position bites. On an empty timetable the loop never runs and
`low` is 0. When every train has gone, `low` comes back as
`len(departures)`, which is one past the end. Both mean the same thing, and
both need the same guard before you index into the list.
:::

:::solution
```python
def next_departure(departures, arrival):
    low, high = 0, len(departures) - 1
    while low <= high:
        mid = (low + high) // 2
        if departures[mid] < arrival:
            low = mid + 1
        else:
            high = mid - 1
    if low == len(departures):
        return -1
    return departures[low]
```

**Why there is no `== arrival` test.** The question is not "is there a train at
this exact minute?" — almost always there is not. It is "where would this
minute slot into the timetable?", and the answer to that is `low` when the loop
ends. Checking for an exact match as you go would let the loop stop early on a
lucky hit, which sounds like a saving and costs you the general answer.

**The comparison is `<`, and that is the whole of the tie handling.**
`departures[mid] < arrival` sends you right only when the train has definitely
gone. A train leaving in exactly the arrival minute fails that test, so `high`
comes down and the search keeps it in play. Write `<=` there instead and you
skip past the very train she could have caught — and on `[700, 700, 700]` with
`arrival = 700` you would walk off the end and return `-1` for a train standing
at the platform.

**The guard.** When every departure is before `arrival`, `low` finishes at
`len(departures)`. That is not a position in the list; indexing with it raises
`IndexError`, and using `departures[-1]` "to be safe" quietly returns the last
train of the day, which has already left. The empty timetable lands in the same
place: `high` starts at `-1`, the loop body never runs, `low` is still 0, and 0
is also `len([])`. One check covers both.

**The count.** `low` and `high` start 400,000 apart, and the gap halves every
turn: 400,000, 200,000, 100,000 and so on down to 1. That is 19 looks, whatever
the arrival minute. Twenty thousand screens cost 380,000 steps between them:
three hundredths of a second, measured, against forty seconds for the walk.

**In real code, use `bisect`.** The standard library has this loop, written
once and correctly:

```python
import bisect


def next_departure(departures, arrival):
    where = bisect.bisect_left(departures, arrival)
    if where == len(departures):
        return -1
    return departures[where]
```

`bisect_left` is the same insertion point, and note that the guard does not go
away — no library can decide for you what "there is no next train" should look
like. Write the loop by hand once, because the next challenge searches
something that is not a list, and then let `bisect` do it forever after.
:::

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
A station's screens answer one question over and over: when does the next
train leave? The timetable behind them holds every departure for the year
ahead, 400,000 of them, as whole numbers in time order, earliest first. Two
trains can leave in the same minute, so the same number can appear twice.

Somebody arrives on the platform at minute `arrival`. Return the time of the
first train at or after that minute.

A train leaving in exactly that minute counts, because she can still get on
it. If every train has gone, return `-1`.
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
- The screens ask this 20,000 times a minute, so one call has to be fast.
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
The same halving as in the chapter, on a timetable instead of a log. One look
at the middle rules out every departure that cannot be the answer.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Count the steps first. Walking the list until you reach a late enough
departure takes half the list on average: 200,000 steps. Twenty thousand
screens asking that is 4 billion steps. The ten-million rule puts that at 400
seconds. Timed, it is nearer 40, because this loop body is very small. Either
way, the perf tier allows three seconds. You have not yet used the fact that
the list is in time order.
:::

:::hint{level=2}
Look at the departure in the middle of the timetable. If it leaves before
`arrival`, so does everything before it, and you can ignore all of them. If it
leaves at or after `arrival`, it might be the answer. Something earlier might
be too, so keep the earlier half and drop the rest.

Repeat on what is left. After about twenty looks, one departure is left.
:::

:::hint{level=3}
Keep two numbers, `low` and `high`: the first and last positions you have not
ruled out. Start them at `0` and `len(departures) - 1`, and loop while
`low <= high`.

Each turn, `mid = (low + high) // 2`. If `departures[mid] < arrival`, the
answer is to the right, so `low = mid + 1`. Otherwise it is at `mid` or to the
left, so `high = mid - 1`. Move the bound past `mid`, not onto it. Otherwise
the window stops shrinking and the loop never ends.
:::

:::hint{level=4}
Don't return from inside the loop. Let it finish. Then `low` is the position
where `arrival` would go, which is also the position of the first departure at
or after `arrival`.

That position needs care in two cases. On an empty timetable the loop never
runs and `low` is 0. When every train has gone, `low` is `len(departures)`,
one past the end. Both mean there is no next train, and one check before you
index into the list handles both.
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

**Why there is no `== arrival` test.** The question is "where would this
minute go in the timetable?", not "is there a train at this exact minute?".
The answer is `low` when the loop ends. Stopping early on an exact match would
only help when there is one, and usually there isn't.

**The `<` comparison handles ties.** `departures[mid] < arrival` sends the
search right only when that train has already gone. A train leaving in exactly
the arrival minute fails the test, so `high` comes down and that train stays
in the search. With `<=` instead, the search skips the train she could have
caught. On `[700, 700, 700]` with `arrival = 700` it runs off the end and
returns `-1`, though a train leaves that minute.

**The check after the loop.** When every departure is before `arrival`, `low`
ends at `len(departures)`. That is not a position in the list, and indexing
with it raises `IndexError`. Using `departures[-1]` instead returns the last
train of the day, which has already left. The empty timetable ends the same
way: `high` starts at `-1`, the loop body never runs, `low` stays 0, and 0 is
also `len([])`. One check covers both.

**The count.** `low` and `high` start 400,000 apart, and the gap halves each
turn: 400,000, 200,000, 100,000 and so on down to 1. That is 19 looks, whatever
the arrival minute. Twenty thousand screens cost 380,000 steps in total. That
measures at three hundredths of a second, against forty seconds for the walk.

**In real code, use `bisect`.** The standard library already has this loop:

```python
import bisect


def next_departure(departures, arrival):
    where = bisect.bisect_left(departures, arrival)
    if where == len(departures):
        return -1
    return departures[where]
```

`bisect_left` returns the same position as `low`. You still write the "no
next train" check, because the library cannot know what to return then. Write the loop by hand once, because the next
challenge searches something that is not a list. After that, use `bisect`.
:::

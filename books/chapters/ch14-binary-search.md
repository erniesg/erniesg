+++
id = "ch14-binary-search"
kind = "concept"
title = "Binary search"
figure = "halving-the-log"

teaches = ["binary-search"]
requires = ["ch13-sorting"]
assessed-by = ["next-train-home", "cut-them-all-the-same"]
powers = ["agent-context-budget"]
+++

At 03:14 last night a payment site stopped taking cards. By nine this morning
the engineer on call has to say what happened in the minute before it went
down. The evidence is one file: 2,400,000 lines, one per request, written in
the order the requests arrived.

She does not start at the top. She opens the file halfway. The line there is
stamped 11:59:59 — hours too late, so everything below it is later still, and
half the file stops mattering. Halfway down what is left reads 05:59:59: still
too late, drop that half too. The third look lands on 02:59:59, which is too
early, so this time the half *above* goes.

Twenty-two looks later she is on the line she wanted.

```python run
LINES = 2_400_000


def time_on(line):
    """This log covers one day evenly, so line 0 is stamped 00:00:00."""
    seconds = line * 86_400 // LINES
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


looks = 0
low, high = 0, LINES - 1
while low <= high:
    mid = (low + high) // 2
    looks += 1
    if time_on(mid) < "03:14:00":
        low = mid + 1
    else:
        high = mid - 1

print("lines in the file: ", f"{LINES:,}")
print("lines she read:    ", looks)
print("first line at 03:14:", f"{low:,}", time_on(low))
```

Twenty-two instead of 2,400,000. For a person with a file open, that is the
difference between a morning and a minute. For a program it is smaller than it
looks — one scan of 2.4 million lines is about a quarter of a second — right up
until the same question gets asked for each of 20,000 alerts, and a quarter of
a second becomes ninety minutes.

(Those timestamps are compared with `<` as text. That only works because every
field is padded to the same width: `"03:14:00" < "11:59:59"` character by
character is also true of the clock. Drop the leading zero and it stops being
true.)

## Sorted is not a detail, it is the whole trick

Here is the search on its own, over a list rather than a file:

```python run
def position_of(values, wanted):
    low, high = 0, len(values) - 1
    while low <= high:
        mid = (low + high) // 2
        if values[mid] == wanted:
            return mid
        if values[mid] < wanted:
            low = mid + 1
        else:
            high = mid - 1
    return -1


departures = [612, 645, 700, 733, 801, 845]
print(position_of(departures, 733))   # 3
print(position_of(departures, 650))   # -1, no train at 06:50
```

Every step throws away half the list on the strength of one comparison. That
is only allowed because the list is in order: if `values[mid]` is smaller than
what you want, then *everything to the left of it* is smaller too, and you know
that without looking.

Take the order away and the reasoning is simply false:

```python run
shuffled = [733, 612, 845, 700, 801, 645]
print("801 is in the list:", 801 in shuffled)
print("halving finds it at:", position_of(shuffled, 801))
```

It reports -1 for a value sitting at index 2. Nothing raised, nothing warned.
This is the failure mode to fear: a binary search on unsorted data does not
crash, it lies, and it lies quietly. If you are not certain the input is
sorted, sort it first — and remember from the last chapter what that costs, so
you sort once and search many times, not the other way round.

## Three names, and only one of them is interesting

`low` and `high` are the ends of the part you have not ruled out. `mid` is the
middle of them. Every turn of the loop does the same three things:

1. Look at `mid`.
2. Decide which half cannot contain the answer.
3. Move `low` or `high` past `mid` so that half is gone.

The whole of binary search is step 3. Move the wrong bound and you get the
wrong answer; move it by the wrong amount and you get no answer at all.

:::figure{id="halving-the-log"}
:::

Watch the last row of that figure. Six looks take 2,400,000 lines down to
37,499, and the halving does not slow down as the numbers get big: doubling the
file adds exactly one look. A hundred million lines would cost 27.

## The off-by-one that never finishes

Here is the loop again with one character changed — `low = mid` instead of
`low = mid + 1` — and a counter to stop it, because otherwise it runs until you
kill it:

```python run
values = [1, 3, 5, 7, 9]
low, high = 0, len(values) - 1
steps = 0

while low <= high and steps < 6:
    steps += 1
    mid = (low + high) // 2
    if values[mid] < 4:
        low = mid          # should be mid + 1
    else:
        high = mid - 1
    print(f"step {steps}: mid={mid} -> low={low} high={high}")

print("stopped by the counter, not by the loop" if steps == 6 else "finished")
```

Read the repeated line. `low=0`, `high=1`, so `mid` is 0; `values[0]` is 1,
which is less than 4, so `low` becomes 0. It already was 0. Nothing shrank, so
the next turn is identical, and so is the one after that.

That is the rule underneath the rule: **every turn must make the window
strictly smaller.** `mid` has been looked at and judged, so `mid` itself must
end up outside the window — `low = mid + 1` or `high = mid - 1`. A hanging
program is almost always this. If you ever find yourself staring at a loop that
will not end, print `low`, `high` and `mid` each turn, as above, and the
unchanging pair will tell you which line to fix.

## When it is not there, you still want to know where

`-1` is rarely the answer anyone wants. The engineer does not care whether a
line is stamped exactly 03:14:00; she wants the first line at or after it. Your
timetable does not have a train at 06:50; you want the next one.

The loop already worked that out. When it ends, `low` is sitting exactly where
the missing value would have gone:

```python run
def insertion_point(values, wanted):
    low, high = 0, len(values) - 1
    while low <= high:
        mid = (low + high) // 2
        if values[mid] < wanted:
            low = mid + 1
        else:
            high = mid - 1
    return low


for wanted in (600, 650, 733, 900):
    where = insertion_point(departures, wanted)
    after = departures[where] if where < len(departures) else "nothing later"
    print(f"arrive {wanted}: slots in at {where}, next train {after}")
```

Three things to notice. There is no `== wanted` test any more, so this version
never stops early — it runs the window all the way down, every time, and in
exchange it answers a more useful question. Asking for 733, which *is* in the list, gives
you the position of 733 itself, because "the first value at or after 733" is
733. And when the answer runs off the end, `low` comes back equal to
`len(values)`, which is not a valid index: that check is yours to write, and
forgetting it is an `IndexError` waiting for the last train of the night.

:::exercise{id="ch14-last-train-before"}
The mirror image of the insertion point: return the position of the **last**
departure at or before `wanted`, or -1 if there is none. Halve; don't scan.

```python
departures = [612, 645, 700, 733, 801, 845]


def last_at_or_before(values, wanted):
    # your code here
    ...


print(last_at_or_before(departures, 650))
print(last_at_or_before(departures, 600))
print(last_at_or_before(departures, 733))
print(last_at_or_before(departures, 900))
```

```output
1
-1
3
5
```

```answer
departures = [612, 645, 700, 733, 801, 845]


def last_at_or_before(values, wanted):
    low, high = 0, len(values) - 1
    while low <= high:
        mid = (low + high) // 2
        if values[mid] <= wanted:
            low = mid + 1
        else:
            high = mid - 1
    return high


print(last_at_or_before(departures, 650))
print(last_at_or_before(departures, 600))
print(last_at_or_before(departures, 733))
print(last_at_or_before(departures, 900))
```
:::

## The standard library already has it

Writing that loop by hand, once, is worth it — you are about to need the shape
for something that is not a list. For an actual list, use `bisect`:

```python run
import bisect

print(bisect.bisect_left(departures, 650))    # where 650 would go
print(bisect.bisect_left(departures, 733))    # first slot holding 733
print(bisect.bisect_right(departures, 733))   # first slot after 733

running = [612, 700, 801]
bisect.insort(running, 733)
print(running)                                # inserted in order
```

`bisect_left` and `bisect_right` differ only when the value is already there:
left gives you the first copy, right gives you the slot just past the last.
With no copies they agree, and both are the insertion point. `insort` finds the
place and inserts in one call, which keeps a list sorted as it grows without
re-sorting it.

Two things `bisect` cannot do for you. It searches a list, so a search over
something you cannot build a list of is yours to write. And it compares whole
items, so if your list holds rows and you want to search by one field, pass
`key=` — or hold a separate sorted list of just that field.

:::exercise{id="ch14-count-in-window"}
With `bisect`, count the trains leaving from 700 to 830, both ends
included.

```python
import bisect

departures = [612, 645, 700, 733, 801, 845]
# your code here
```

```output
3
```

```answer
import bisect

departures = [612, 645, 700, 733, 801, 845]
print(bisect.bisect_right(departures, 830) - bisect.bisect_left(departures, 700))
```
:::

## Binary search on the answer

Now the part that is worth the chapter.

Someone has an exam in 14 days and a textbook of 42 chapters and 1,363 pages.
She reads in order, and she is not willing to stop in the middle of a chapter,
so a day is some whole number of consecutive chapters. She wants to know the
smallest daily page count she can hold herself to and still finish in time. Too
low and she runs out of days; too high and she is reading more than she needs
to every night for a fortnight.

There is no list to search here. The answer is a number between 52 — the
longest single chapter, which has to fit in some day — and 1,363, reading the
lot in one sitting. That is 1,312 candidates.

Start with the question she can actually answer: given a cap, how many days
does it take?

```python run
pages = [20, 47, 29, 31, 30, 32, 18, 42, 33, 43, 39, 39, 21, 30,
         28, 34, 36, 30, 37, 47, 23, 24, 49, 31, 24, 14, 18, 21,
         52, 35, 15, 19, 31, 27, 38, 39, 51, 42, 52, 20, 21, 51]


def days_needed(cap):
    days, today = 1, 0
    for chapter in pages:
        if today + chapter > cap:      # does not fit, so start tomorrow
            days += 1
            today = 0
        today += chapter
    return days


for cap in (60, 80, 100, 110, 115, 120, 140):
    days = days_needed(cap)
    print(f"cap {cap:>4} pages: {days:>2} days  "
          f"{'fits' if days <= 14 else 'too slow'}")
```

Look at that last column: **too slow, too slow, too slow, too slow, fits, fits,
fits.** It never goes back. It cannot: giving yourself more pages a day can
never make you need more days. That property has a name worth knowing —
monotonic — and it is the thing that makes the next move legal.

Because once the column turns, you know every cap above it also fits. Which
means you are looking for the boundary between the two blocks. Which means you
can halve.

```python run
low, high = max(pages), sum(pages)
best = high
probes = 0

while low <= high:
    mid = (low + high) // 2
    probes += 1
    if days_needed(mid) <= 14:
        best = mid             # this cap works; try a stingier one
        high = mid - 1
    else:
        low = mid + 1          # not enough; be more generous

print("smallest cap that finishes in 14 days:", best)
print("caps she could have tried:", sum(pages) - max(pages) + 1)
print("caps she actually tried:  ", probes)
```

It is the same loop. `low`, `high`, `mid`, and one bound moves past `mid` every
turn. Two things changed. There is no list, so `mid` is a candidate *answer*
rather than a position. And the test against `values[mid]` has been replaced by
a question of your own — `days_needed(mid) <= 14` — which is where all the
thinking now lives. Write that question wrong and the halving will find the
boundary of the wrong thing, perfectly efficiently.

The `best` variable is there because a working cap is not necessarily the
smallest one: you write it down before you go looking for a better one. When
the window closes, `best` holds the smallest cap that ever answered yes.

`low` starts at `max(pages)` and not at 1, and that is not an optimisation. Cap
a day at 30 pages when one chapter is 52 and `days_needed` will still hand back
a number — it puts the chapter in a day by itself and blows the cap — so the
test would answer "yes, that fits" about a cap that is impossible to keep. A
check that lies below some point puts the boundary in the wrong place. Start
the range where the question still means something.

The yeses can also come first. Ask instead for the *latest* minute she can
leave the house and still be sitting the exam at nine, and the column reads
yes, yes, yes, no, no: setting off early always works, setting off late never
does. Same loop, same `best`; the only difference is that a yes moves `low` up
rather than `high` down. When you meet one of these, write the column out for
four or five candidates before you write any code. Which way round it runs
decides which bound moves, and getting that backwards is the one bug the shape
is prone to.

So: you can binary search anything where you can ask a yes-or-no question about
a candidate answer, and the yeses are all on one side. It costs a handful of
calls to that question instead of a trawl through every candidate — here, ten
calls in place of 1,312.

:::exercise{id="ch14-smallest-square"}
Search the answer: the smallest whole number `x` with `x * x >= n`. Write
the yes-or-no column out for a few candidates first, then halve.

```python
def smallest_root(n):
    # your code here
    ...


print(smallest_root(1_000_000))
print(smallest_root(10))
print(smallest_root(1))
```

```output
1000
4
1
```

```answer
def smallest_root(n):
    low, high = 1, n
    best = n
    while low <= high:
        mid = (low + high) // 2
        if mid * mid >= n:
            best = mid
            high = mid - 1
        else:
            low = mid + 1
    return best


print(smallest_root(1_000_000))
print(smallest_root(10))
print(smallest_root(1))
```
:::

## What this buys the agent

The agent has just searched the repository and is holding 380 snippets, best
first. The model it is about to call has room for 100,000 tokens of them. How
many does it send?

It cannot add up 380 snippet sizes and stop when the total goes over, because
that is not what it is sending. The snippets get rendered into one prompt, with
file headers, separators and a template wrapped round them, and the only honest
count is the count of the thing that actually goes on the wire. So each check
means building the whole prompt and running a tokeniser over it. Doing that 380
times, once per candidate, is the kind of delay a person notices between typing
and an answer.

But "do the top k snippets fit in 100,000 tokens?" is monotonic: if the top 40
fit, the top 39 certainly do. Yes, yes, yes, no, no. So the agent halves the
range 0 to 380 and finds the largest k that fits in nine builds instead of 380.

That is binary search on the answer, doing the thing it is for: the budget is
fixed by somebody else, the cost of checking is high, and the only real
decision is where the line falls. Every agent that has to fit as much as
possible into a fixed context window ends up writing this loop.

## Your turn

Two challenges. The first is a search over a sorted list where the value you
are given is usually not in it, so the insertion point is the answer and the
off-by-one is the whole difficulty. The second hands you no list at all. You
will have to decide what the candidate answers are, write the yes-or-no
question yourself, and check which way round the yeses run before you touch the
loop.
